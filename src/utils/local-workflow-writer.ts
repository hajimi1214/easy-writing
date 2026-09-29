import type { JsonRecord } from '@/types/json'
import type { WorkflowQualityIssue, WorkflowQualityNotice, WorkflowTask } from '@/types/workflow'
import {
  buildChapterBeatsMessages,
  buildChapterContentMessages,
  buildChapterPlanMessages,
} from '@/config/workflow-prompts'
import { getLocalLibraryStorage } from '@/storage/local-library'
import { LOCAL_USER_ID, createLocalEntityId } from '@/storage/local-library-utils'
import type { LocalChapter, LocalLibraryVolume } from '@/storage/local-library-types'
import {
  readLocalWorkflowTask,
  readLocalWorkflowRun,
  writeLocalWorkflowRun,
  writeLocalWorkflowTask,
  type LocalWorkflowRun,
} from '@/storage/local-workflow'
import { getWritingStorage } from '@/storage'
import { getLocalAiModelSecret, getLocalAiPreference } from '@/storage/local-ai-models'
import { useAiModelStore } from '@/stores/ai-model'
import { mergeCriticReport, runChapterCritic, scopeCriticReportToParagraphs } from '@/utils/ai-critic'
import { parseAiJson } from '@/utils/ai-json'
import { sanitizeChapterText } from '@/utils/chapter-sanitize'
import { buildLedgerMaterials, writeChapterLedger } from '@/utils/fact-ledger'
import {
  NO_MODEL_MESSAGE,
  requestLocalChatCompletion,
  streamLocalChatCompletion,
} from '@/utils/local-ai-client'
import { runLocalChapterQualityCheck } from '@/utils/local-quality-check'
import {
  buildLocalWorkflowEvent,
  emitLocalWorkflowEvent,
  registerLiveLocalTask,
  unregisterLiveLocalTask,
} from '@/utils/local-workflow-runtime'
import { parseChapterWordRange, parseVolumeRelay, resolveRunOutlineUi, resolveRunSettingUi } from '@/utils/local-workflow-book'
import { buildFixOrderText, runChapterFixRewrite, selectFixableIssues } from '@/utils/quality-fixer'
import { describeChapterConstraints } from '@/utils/quality-rules'
import { resolveGateThirdMode } from '@/utils/self-check-mode'
import { buildRevealedSettingBrief } from '@/utils/setting-reveal'
import { countWords } from '@/utils/word-count'
import { promptTemperature } from '@/storage/local-prompts'
import { recordAiChapterLanding } from '@/storage/local-write-stats'

/**
 * 逐章自动生文引擎：一次任务写一卷。
 *
 * 循环骨架：取本卷下一章 →（无细纲先扩细纲）→ 流式写正文 → 落库 → 规则质检
 * → 有硬伤停机等确认，没有就下一章；本卷章纲写完但目标章数没到，就再批量规划一批。
 * 暂停/取消随时打旗，流式中直接掐请求；断点（半章正文）存任务 checkpoint，
 * 恢复时带着已写部分续写。事件走本地总线，页面的 SSE 消费逻辑原样工作。
 */

const TOKEN_EVENT_INTERVAL_MS = 300
const CHECKPOINT_PERSIST_INTERVAL_MS = 2000
const PLAN_BATCH_SIZE = 10
const PREV_CHAPTER_TAIL_CHARS = 1600
const DEFAULT_CHAPTER_WORDS = 3000
const WORD_COMPLETION_MAX_PASSES = 3
const WORD_HIGH_ALLOWANCE = 500
/** 同一施工单连续未收敛到这个次数时，升级为带问题清单的整章重构；不是停机上限。 */
const SAME_BLOCKING_ESCALATION_ATTEMPTS = 6
const GLOBAL_QUALITY_REPAIR_CODES = new Set(['word_count_low', 'word_count_high'])

/**
 * 篇幅修复会整章重排段落，旧施工单和旧段号都已经失效。
 * 这时必须重新做一次正常初审，不能把“压到多少字”继续塞给语义模型验收：
 * 字数由平台确定性计数，模型拿到这类施工单会误报“正文没有标注最终字数”。
 */
export const shouldRerunFullCriticAfterRepair = (issues: WorkflowQualityIssue[]): boolean =>
  issues.some(issue => GLOBAL_QUALITY_REPAIR_CODES.has(issue.code))

const asText = (value: unknown) => String(value ?? '').trim()

/** 同一批阻断问题是否被模型换了说法，不看文案，只看稳定的代码与段落坐标。 */
export const blockingIssueFingerprint = (notice: WorkflowQualityNotice | null | undefined) =>
  (notice?.issues || [])
    .filter(issue => issue.blocking)
    .map(issue => {
      // AI 问题编号取决于返回数组顺序，同一问题下一轮可能从 -3 变成 -1；编号不能参与指纹。
      const stableCode = issue.source === 'critic' ? issue.code.replace(/-\d+$/, '') : issue.code
      const location = [...(issue.paragraphs || [])].sort((a, b) => a - b).join(',')
        || String(issue.quotes?.[0] || '').slice(0, 24)
      return `${issue.source}:${stableCode}:${location}`
    })
    .sort()
    .join('|')

/**
 * 审查模型暂不可用或没有给出可定位施工单时，问题不在正文；重写正文只会浪费写作模型并制造新问题。
 * 这类状态应保留当前成稿，交给守护器稍后重新调用审查模型。
 */
export const criticNeedsRetryWithoutRewrite = (notice: WorkflowQualityNotice | null | undefined) => {
  const blocking = (notice?.issues || []).filter(issue => issue.blocking)
  if (!blocking.length || selectFixableIssues(blocking).length) return false
  return blocking.every(issue =>
    issue.source === 'critic'
    && (
      issue.code === 'CRITIC-UNAVAILABLE'
      || issue.code === 'CRITIC-SCORES-MISSING'
      || String(issue.fix || '').startsWith('未给出施工单')
    )
  )
}

/**
 * 断点正文已达到目标字数时，它是“待质检成稿”而不是“半章”。刷新后直接进入篇幅校正/质检，
 * 不能再把整章当 partialText 续写一次，否则每次重开页面都会在文末追加一轮正文。
 */
export const shouldContinueChapterDraft = (partialText: string, targetWords: number) =>
  !String(partialText || '').trim() || countWords(partialText) < Math.max(1, Number(targetWords || 0))

interface WriterFlags {
  pauseRequested: boolean
  cancelRequested: boolean
  restartChapterRequested: boolean
  abort: AbortController | null
}

/** 每个活任务一份控制旗；registry 里的句柄只是对它的两个开关 */
const writerFlags = new Map<number, WriterFlags>()
const writerCommandCleanup = new Map<number, () => void>()


const plainTextRows = (value: string) =>
  String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\u00a0/g, ' ')
    .split('\n')
    .map(line => line.replace(/^[ \t\u3000]+|[ \t\u3000]+$/g, ''))
    .filter(line => line.trim())

/** 说话提示语：判定「这句是台词出口」用的动词/神态。 */
const SPEAK_LEAD = '(?:笑了笑|笑|说|道|问|答|喊|开口|低声|小声|应声|接话|反问|回话)'

/** 「说话提示 + 引号对白」，如 `他摇头道：「不必了。」` */
const QUOTED_SPEECH = new RegExp(
  `([^。！？\\n]{0,24}${SPEAK_LEAD}[^。！？\\n]{0,8})[：:]\\s*[「『“]([^「」『』“”]*)[」』”]`,
  'g',
)

/** 没带引号、却仍用冒号把台词引出来：`他说：不必了。` */
const COLON_SPEECH = new RegExp(`(${SPEAK_LEAD}[^：\\n]{0,2})[：:]([^：\\n]{1,40}?)(?=[。！？\\n]|$)`, 'g')

/** 「他摇头道。」不成话，收尾那个说话动词要去掉，变成「他摇头。」 */
const trimSpeakTail = (lead: string) =>
  lead.replace(/(?:说|道|问|答|喊|应|回|开口|低声|小声|应声|接话)$/, '')

/**
 * 正文不使用对话引号。
 *
 * ⚠️ 这里不能只是「把引号删掉」——那会制造新的硬阻断：模型按常识写成
 * `他摇头道：「不必了。」`，删掉引号后正好变成 `他摇头道：不必了。`，
 * 恰好命中 `dialogue_colon_format`（说话动词 + 冒号），于是**每一句对白都被自己的
 * 清洗步骤改写成一处 P1 阻断**：整章永远过不了，自检修复写得再勤也写不干净。
 *
 * 所以这里是**定点改写**而不是删字符：只认「说话提示 + 台词」这一处错位，
 * 就地拆成「人物动作句。」＋「对白独立成段。」，别的一字不动。
 */
export const normalizeGeneratedChapterText = (value: string) => {
  let text = String(value || '')
  const splitLead = (rawLead: string, speech: string) => {
    const lead = String(rawLead).trim()
    const head = trimSpeakTail(lead) || lead
    const line = String(speech).trim()
    const tail = /[。！？…]$/.test(line) ? line : `${line}。`
    return `${head}。\n${tail}`
  }
  // ① 说话提示 + 引号对白 → 动作句。\n对白独立成段
  text = text.replace(QUOTED_SPEECH, (_match, rawLead: string, speech: string) => splitLead(rawLead, speech))
  // ② 没带引号、但用冒号把台词引出来 → 同样拆开
  text = text.replace(COLON_SPEECH, (_match, rawLead: string, speech: string) => splitLead(rawLead, speech))
  // ③ 剩下的成对引号只留内容
  text = text.replace(/[「『“]([^「」『』“”]*)[」』”]/g, '$1')
  // ④ 保险：清掉任何残留的单一引号符号
  text = text.replace(/[「」『』“”]/g, '')
  // ⑤ 模型精修协议与审查评分绝不是正文。
  // 走 @/utils/chapter-sanitize 的单一真源：段号全局剥离（不止行首、不止一个），
  // 评分分母不限 100。生成侧、修复侧、导出侧、批量清洗共用同一份，避免改一处漏两处。
  return sanitizeChapterText(text)
}

/** 与编辑器 plainTextToTiptapJson 同构：每行一段 */
const plainTextToDocJson = (value: string) => {
  const rows = plainTextRows(value)
  return {
    type: 'doc',
    content: (rows.length ? rows : ['']).map(line =>
      line ? { type: 'paragraph', content: [{ type: 'text', text: line }] } : { type: 'paragraph' }
    ),
  }
}

/** 生成正文落进本地正文库（与编辑器草稿同键同形），并同步目录字数 */
export const saveGeneratedChapterContent = async (params: {
  bookId: string
  chapterId: number
  title: string
  text: string
  contentVersion: number
}) => {
  const normalizedText = normalizeGeneratedChapterText(params.text)
  const contentJson = plainTextToDocJson(normalizedText)
  await getWritingStorage().saveChapterLocal({
    userId: LOCAL_USER_ID,
    bookId: params.bookId,
    chapterId: params.chapterId,
    title: params.title,
    textContent: plainTextRows(normalizedText).join('\n'),
    contentJson,
    localVersion: 0,
    remoteVersion: params.contentVersion,
    baseRemoteVersion: params.contentVersion,
    baseTitle: params.title,
    baseTextContent: plainTextRows(normalizedText).join('\n'),
    baseContentJson: contentJson,
    dirty: true,
    conflict: false,
    localOnly: true,
    workflowPreview: false,
    updatedAt: Date.now(),
  })
  const wordCount = countWords(normalizedText)
  await getLocalLibraryStorage().updateLocalChapterContentMeta({
    bookId: params.bookId,
    chapterId: params.chapterId,
    title: params.title,
    wordCount,
  })
  // 码字账本：整章 AI 落稿按基线差记 AI，并抬基线防编辑器落盘双记
  recordAiChapterLanding(params.bookId, params.chapterId, wordCount)
}

export const readChapterText = async (bookId: string, chapterId: number) => {
  const draft = await getWritingStorage().getChapterByIdentity(LOCAL_USER_ID, bookId, chapterId)
  return { text: draft?.textContent || '', contentVersion: Number(draft?.remoteVersion || 0), contentJson: draft?.contentJson ?? null, title: draft?.title || '' }
}

export const resolveWorkflowModelCode = async (run: LocalWorkflowRun) => {
  // 活动任务不能永久钉死在建书时选中的模型上。作者在「模型管理」切换写作模型后，
  // 下一次重试/下一章必须立刻采用新选择（尤其用于旧 Key 欠费后的无损换模）。
  // 直接读 localStorage 偏好而不是只读 Pinia，保证另一个同源页签改动也能生效。
  const preferred = asText(getLocalAiPreference('workflow_book'))
  const preferredModel = preferred ? getLocalAiModelSecret(preferred) : null
  if (preferredModel?.scene === 'text' && preferredModel.status !== 0) return preferred
  const explicit = asText(run.modelCode || run.config?.modelCode)
  if (explicit) return explicit
  const code = await useAiModelStore().ensureWorkflowModel()
  if (!code) throw new Error(NO_MODEL_MESSAGE)
  return code
}

/**
 * 审核模型（闸三 AI 评审）与写作模型分开选。
 *
 * 实测同一批模型里这两件事的最优解不是同一个：直答型模型文笔够用，
 * 却连「铜钱共十一枚」这种算术硬伤一条都挑不出；思考型模型挑得准，写起来又慢又贵。
 * 未单独配置时回落写作模型，保持升级前的行为不变。
 */
export const resolveReviewModelCode = async (run: LocalWorkflowRun) => {
  // 审核槽位也允许热切换，避免正文已经换到廉价模型，审查仍继续调用旧的昂贵/欠费模型。
  const latestPreferred = asText(getLocalAiPreference('workflow_review'))
  const preferredModel = latestPreferred ? getLocalAiModelSecret(latestPreferred) : null
  if (preferredModel?.scene === 'text' && preferredModel.status !== 0) return latestPreferred
  const explicit = asText(run.config?.reviewModelCode)
  if (explicit) return explicit
  const preferred = await useAiModelStore().ensureReviewModel()
  if (preferred) return preferred
  return resolveWorkflowModelCode(run)
}

/** 10 章一个呼吸周期：短章 → 推进 → 长章 → 收束。叠一点抖动，免得周期感太明显。 */
const CHAPTER_LENGTH_RHYTHM = [0.12, 0.42, 0.78, 0.28, 0.62, 0.96, 0.22, 0.52, 0.85, 0.35]

/**
 * 单章字数目标。
 *
 * 配置了区间时逐章在区间内取值，让章长跟着情节呼吸；只配了单值就和以前一样。
 * 取值必须确定性（同一 run + 同一章号永远得同一个数），否则断点续写、重跑、
 * 质检复核会各自算出不同的目标，互相打架。
 */
const resolveChapterTargetWords = (run: LocalWorkflowRun, chapterNo = 0) => {
  const range = parseChapterWordRange(run.config?.chapterTargetWords)
  const base = range.min || DEFAULT_CHAPTER_WORDS
  const span = Math.max(0, range.max - base)
  if (!span) return base

  // FNV-1a 哈希：把 runId + 章号搅成一个 [0,1) 的定值
  const seed = `${Number(run.id) || 0}:${chapterNo}`
  let hash = 2166136261
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  const jitter = ((hash >>> 0) % 1000) / 1000
  const rhythm = CHAPTER_LENGTH_RHYTHM[Math.abs(chapterNo) % CHAPTER_LENGTH_RHYTHM.length]
  const ratio = rhythm * 0.75 + jitter * 0.25
  // 取整到 50，提示词里给模型一个干净的数
  return Math.round((base + span * ratio) / 50) * 50
}

// ---------------------------------------------------------------------------
// 提示词素材组装
// ---------------------------------------------------------------------------

const describeRunConfig = (run: LocalWorkflowRun) => {
  const config = (run.config || {}) as JsonRecord
  const lines = [
    ['平台', config.platform],
    ['题材', config.genre],
    ['标签', Array.isArray(config.tags) ? config.tags.join('、') : ''],
    ['叙事人称', config.storyPerspective],
    ['目标读者', config.audience],
    ['核心卖点', config.sellingPoint],
    ['叙事风格', config.narrativeStyle],
    ['文风', config.writingStyle],
    ['核心设定', config.coreSetting],
    ['故事主线', config.storyLine],
  ]
  return lines
    .filter(([, value]) => asText(value))
    .map(([label, value]) => `${label}：${value}`)
    .join('\n')
}

/**
 * 设定素材按章过滤之后再注入。
 *
 * 这里以前是「原样喂」：seed 是作者视角的完整设定稿，含大量卷次剧透
 * （「（第七卷才反转点破）」「真相：流白当年留下的守门人」…），
 * 于是闸一在生成后拦「死生门」，提示词却自己先把「死生门」递到了模型嘴边。
 * 现在改由 `@/utils/setting-reveal` 统一处理：条目级 revealAtChapter 闸门 +
 * 片段级作者批注消毒；该模块是纯函数，测试能直接拿真实 seed 断言。
 */
const describeSettingBrief = (run: LocalWorkflowRun, chapterNo: number) =>
  buildRevealedSettingBrief(resolveRunSettingUi(run), chapterNo)

const describeOutlineBrief = (run: LocalWorkflowRun) => {
  const outline = resolveRunOutlineUi(run)
  return [
    asText(outline.intro) ? `简介：${asText(outline.intro)}` : '',
    asText(outline.storyHook) ? `核心钩子：${asText(outline.storyHook)}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

const describeVolumeStages = (volume: LocalLibraryVolume) => {
  const stages = Array.isArray(volume.planMeta?.stages) ? volume.planMeta!.stages : []
  return stages
    .map((stage: JsonRecord) =>
      `阶段「${asText(stage?.title)}」：目标 ${asText(stage?.goal)}；从 ${asText(stage?.startState)} 到 ${asText(stage?.endState)}${Array.isArray(stage?.mustHappen) && stage.mustHappen.length ? `；必须发生：${stage.mustHappen.map(asText).join('、')}` : ''}`
    )
    .join('\n')
}

const readBeats = (chapter: LocalChapter) => {
  const expanded = chapter.planMeta?.expandedOutline as Record<string, unknown> | null | undefined
  if (!expanded || typeof expanded !== 'object' || !Array.isArray(expanded.beats)) return null
  const beats: string[] = expanded.beats.map(asText).filter(Boolean)
  if (!beats.length) return null
  return { beats, endHook: asText(expanded.endHook) }
}

/** 正文提示词素材（常规生成 / 断点续写 / 按要求重写共用） */
const buildChapterMaterials = async (params: {
  run: LocalWorkflowRun
  volume: LocalLibraryVolume
  chapter: LocalChapter
  previousChapter: LocalChapter | null
  nextChapterSummary: string
  /** 全书按序排好的章：闸二事实账本据此生成"全书进度 / 近期章纲 / 人物出场表" */
  orderedChapters: LocalChapter[]
}): Promise<Record<string, string>> => {
  const { run, volume, chapter, previousChapter } = params
  const brief = describeSettingBrief(run, Number(chapter.sortNo || 0))
  let previousTail = ''
  if (previousChapter) {
    const { text } = await readChapterText(chapter.bookId, previousChapter.id)
    previousTail = text ? `《${previousChapter.title}》结尾：\n${text.slice(-PREV_CHAPTER_TAIL_CHARS)}` : ''
  }
  const beats = readBeats(chapter)
  const writingRules = asText(run.config?.writingRules)
  // 闸二·事实账本：把"前面每一章写过什么"补进上下文。原先只喂上一章结尾 600 字，
  // 写到第 100 章时第 1–98 章等于不存在——脱节/章节对不上/配角突然出场都由此而来。
  const ledgerMaterials = await buildLedgerMaterials({
    orderedChapters: params.orderedChapters,
    currentChapterNo: Number(chapter.sortNo || 0),
  })
  return {
    '写作参数': describeRunConfig(run),
    '写作规则（必须遵守，优先级最高）': writingRules,
    // 闸一·生成前注入：把本卷区间、本章仍生效的剧透红线、篇幅与开篇要求直接写进素材。
    // 原先素材只喂「作品大纲 = 简介 + 核心钩子」，模型并不知道哪句话现在还不能说破，
    // 于是"提前抖底牌"只能靠模型自觉——这是越界/剧透反复发生的直接原因。
    // 同一份规则数据在生成后还会再跑一遍体检（见 local-quality-check.ts）。
    '本章红线与禁忌（违反即整章作废，优先级最高）': describeChapterConstraints(chapter.sortNo),
    '作品大纲': describeOutlineBrief(run),
    '主要人物': brief.characters,
    '力量体系': brief.power,
    '故事线': brief.storylines,
    '本卷规划': [`卷《${volume.title}》：${asText(volume.summary)}`, describeVolumeStages(volume)].filter(Boolean).join('\n'),
    ...ledgerMaterials,
    '前情': previousTail,
    '本章交付合同（必须完整发生且只能写这些核心事件）': `第${chapter.sortNo}章《${chapter.title}》：${asText(chapter.summary)}`,
    '本章章纲': `第${chapter.sortNo}章《${chapter.title}》：${asText(chapter.summary)}`,
    '本章细纲': beats ? [...beats.beats.map((beat, i) => `${i + 1}. ${beat}`), beats.endHook ? `章末钩子：${beats.endHook}` : ''].filter(Boolean).join('\n') : '',
    '下一章边界（只用于判断越界，任何事件都严禁写进本章）': params.nextChapterSummary,
  }
}

// ---------------------------------------------------------------------------
// 卷内工作清单
// ---------------------------------------------------------------------------

export interface VolumeWorkState {
  volume: LocalLibraryVolume
  /** 全书按序排好的章（跨卷，供前情/衔接查找） */
  orderedChapters: LocalChapter[]
  pendingInVolume: LocalChapter[]
  writtenInVolume: number
  targetCount: number
}

const volumeTargetCount = (volume: LocalLibraryVolume) => {
  const meta = volume.planMeta || {}
  const fixed = Number(meta.chapterCount || 0)
  const rangeMax = Number(meta.chapterRange?.max || 0)
  const materialized = volume.children.length
  return Math.max(fixed || rangeMax || materialized, materialized)
}

/** 找当前该写的卷：第一个还有未写章或未到目标章数的卷；全写完返回 null */
const resolveVolumeWork = async (bookId: string): Promise<VolumeWorkState | null> => {
  const tree = await getLocalLibraryStorage().getLocalBookTree(bookId)
  const orderedChapters = tree.flatMap(volume => volume.children)
  for (const volume of tree) {
    const pending = volume.children.filter(chapter => chapter.workflowStatus === 'incomplete' || chapter.workflowStatus === 'review_required')
    const written = volume.children.length - pending.length
    const target = volumeTargetCount(volume)
    if (pending.length || volume.children.length < target) {
      return { volume, orderedChapters, pendingInVolume: pending, writtenInVolume: written, targetCount: target }
    }
  }
  return null
}

/** 卷间自动接力的次数上限。本书大纲最多八卷，留一倍余量；超了就按老规矩收工，防止异常数据下空转。 */
const VOLUME_RELAY_MAX = 16

/** 后面各卷还欠多少章（done 事件的 remainingChapters 口径） */
const countRemainingAfter = async (bookId: string, currentVolumeId: number) => {
  const tree = await getLocalLibraryStorage().getLocalBookTree(bookId)
  let remaining = 0
  let passed = false
  for (const volume of tree) {
    if (!passed) {
      if (Number(volume.id) === Number(currentVolumeId)) passed = true
      continue
    }
    const pending = volume.children.filter(chapter => chapter.workflowStatus === 'incomplete').length
    remaining += Math.max(volumeTargetCount(volume) - (volume.children.length - pending), pending)
  }
  return remaining
}

// ---------------------------------------------------------------------------
// 章纲批量规划与细纲展开
// ---------------------------------------------------------------------------

const planNextChapterBatch = async (
  run: LocalWorkflowRun,
  work: VolumeWorkState,
  modelCode: string,
  signal: AbortSignal
) => {
  const storage = getLocalLibraryStorage()
  const { volume, orderedChapters } = work
  const existing = volume.children
  const globalStart = orderedChapters.length ? Number(orderedChapters[orderedChapters.length - 1].sortNo) + 1 : 1
  const count = Math.min(PLAN_BATCH_SIZE, Math.max(1, work.targetCount - existing.length))
  const recentOutlines = orderedChapters
    .slice(-6)
    .map(chapter => `第${chapter.sortNo}章《${chapter.title}》：${asText(chapter.summary)}`)
    .join('\n')
  const isFinalStretch = existing.length + count >= work.targetCount
  const data = await requestLocalChatCompletion({
    scene: 'workflow_chapter_plan',
    sceneLabel: '建书·章纲规划',
    modelCode,
    signal,
    maxTokens: 4000,
    messages: buildChapterPlanMessages({
      materials: {
        '写作参数': describeRunConfig(run),
        '作品大纲': describeOutlineBrief(run),
        // 用本批「起始章」的约束：禁令只随章号递增而失效，起始章的禁令集合是本批的超集，
        // 按它规划整批不会漏。规划阶段就卡住红线，才不会把剧透写进章纲污染后面所有章。
        '红线与禁忌（本批各章均须遵守）': describeChapterConstraints(globalStart),
        '本卷规划': [`卷《${volume.title}》：${asText(volume.summary)}`, describeVolumeStages(volume)].filter(Boolean).join('\n'),
        '已有章纲（最近几章）': recentOutlines,
      },
      count,
      startChapterNo: globalStart,
      isFinalStretch,
    }),
  })
  const parsed = parseAiJson(data, ['chapters'])
  const plans = Array.isArray(parsed?.chapters) ? parsed.chapters : []
  const cleaned = plans
    .map((plan: JsonRecord) => ({ title: asText(plan?.title), summary: asText(plan?.summary) }))
    .filter((plan: { title: string }) => plan.title)
    .slice(0, count)
  if (!cleaned.length) throw new Error('章纲规划结果为空，请重试')

  const planOffset = Array.isArray(volume.planMeta?.chapters) ? volume.planMeta!.chapters.length : 0
  const createdChapters: LocalChapter[] = []
  for (const [index, plan] of cleaned.entries()) {
    const created = await storage.createLocalChapter({
      bookId: volume.bookId,
      volumeId: volume.id,
      title: plan.title,
      summary: plan.summary,
      sortNo: globalStart + index,
      planMeta: {
        workflowPlanIndex: planOffset + index + 1,
        outlineSource: 'volume_ai',
        source: { title: plan.title, summary: plan.summary },
      },
      workflowStatus: 'incomplete',
    })
    createdChapters.push(created)
  }
  await storage.updateLocalVolume({
    id: volume.id,
    planMeta: {
      ...(volume.planMeta || {}),
      chapters: [...(Array.isArray(volume.planMeta?.chapters) ? volume.planMeta!.chapters : []), ...cleaned],
    },
  })
  return createdChapters
}

const ensureChapterBeats = async (
  run: LocalWorkflowRun,
  volume: LocalLibraryVolume,
  chapter: LocalChapter,
  modelCode: string,
  signal: AbortSignal
) => {
  if (readBeats(chapter) || String(chapter.planMeta?.outlineSource || '') === 'user') return chapter
  const data = await requestLocalChatCompletion({
    scene: 'workflow_chapter_beats',
    sceneLabel: '建书·细纲',
    modelCode,
    signal,
    maxTokens: 1500,
    messages: buildChapterBeatsMessages({
      materials: {
        '写作参数': describeRunConfig(run),
        '本卷规划': [`卷《${volume.title}》：${asText(volume.summary)}`, describeVolumeStages(volume)].filter(Boolean).join('\n'),
        '本章章纲': `第${chapter.sortNo}章《${chapter.title}》：${asText(chapter.summary)}`,
        '本章红线与禁忌（细纲不得提前说破）': describeChapterConstraints(chapter.sortNo),
      },
    }),
  })
  const parsed = parseAiJson(data, ['beats'])
  const beats = Array.isArray(parsed?.beats) ? parsed.beats.map(asText).filter(Boolean) : []
  if (!beats.length) return chapter
  const updated = await getLocalLibraryStorage().updateLocalChapter({
    id: chapter.id,
    planMeta: {
      ...(chapter.planMeta || {}),
      expandedOutline: { beats: beats.slice(0, 10), endHook: asText(parsed?.endHook) },
      outlineSource: 'phase_a',
    },
  })
  return updated || chapter
}

// ---------------------------------------------------------------------------
// 单章流式生成（返回全文；暂停/取消通过旗与 signal 生效）
// ---------------------------------------------------------------------------

export interface ChapterStreamCallbacks {
  onSnapshot: (fullText: string) => void
}

const streamChapterContent = async (params: {
  modelCode: string
  materials: Record<string, string>
  targetWords: number
  partialText?: string
  rewriteInstruction?: string
  signal: AbortSignal
  onSnapshot: (fullText: string) => void
}): Promise<string> => {
  const base = String(params.partialText || '')
  const messages = buildChapterContentMessages({
    materials: params.materials,
    targetWords: params.targetWords,
    partialText: params.partialText,
    rewriteInstruction: params.rewriteInstruction,
  })
  const configuredModel = getLocalAiModelSecret(params.modelCode)
  const isGlmFlash = /^glm-5\.3-flash$/i.test(String(configuredModel?.modelCode || ''))
  const runStream = async (
    modelCode: string,
    maxTokens?: number,
    maxReasoningChars?: number,
    maxReasoningMs?: number
  ) => {
    let streamed = ''
    let streamError = ''
    await streamLocalChatCompletion(
      {
        modelCode,
        scene: 'workflow_content',
        sceneLabel: '建书·正文',
        temperature: promptTemperature('workflow-writer', 'contentSystem'),
        // 能关闭思考的正文模型直接关闭；必须思考的模型由请求层按上游报错自动开启。
        enableThinking: false,
        maxTokens,
        maxReasoningChars,
        maxReasoningMs,
        messages,
        signal: params.signal,
      },
      {
        onDelta: text => {
          streamed += text
          params.onSnapshot(normalizeGeneratedChapterText(base ? `${base}\n${streamed}` : streamed))
        },
        onDone: () => undefined,
        onError: message => {
          streamError = message
        },
      }
    )
    return { streamed, streamError }
  }

  // GLM Flash 被上游强制开启思考。正文一次需要约 4k–7k token，再给推理留余量；
  // maxTokens 只是上限，不会固定消耗。若它仍把 32k 全耗在思考中，当前分段没有任何
  // 可见正文，便只把这一分段无缝交给审核模型关闭思考重写，既不重跑整章也不暴露错误。
  let result = await runStream(
    params.modelCode,
    isGlmFlash ? 32_768 : undefined,
    isGlmFlash ? 8_000 : undefined,
    isGlmFlash ? 45_000 : undefined
  )
  if (/模型(?:思考耗尽输出上限|只返回了思考过程|思考超出正文预算)/.test(result.streamError)) {
    const fallbackModelCode = getLocalAiPreference('workflow_review')
    if (fallbackModelCode && fallbackModelCode !== params.modelCode) {
      result = await runStream(fallbackModelCode, 16_000)
    }
  }
  if (result.streamError) throw new Error(result.streamError)
  return normalizeGeneratedChapterText(base ? `${base}\n${result.streamed}` : result.streamed)
}

/**
 * 模型偶尔会提前收尾。这里让同一模型从结尾继续补写，仍不足就交给后面的
 * 硬质检阻断；任何情况下都不会拿未达标正文推进到下一章。
 */
const fitChapterToWordRange = async (params: {
  modelCode: string
  materials: Record<string, string>
  targetWords: number
  text: string
  signal: AbortSignal
  onSnapshot: (fullText: string) => void
}): Promise<string> => {
  let text = normalizeGeneratedChapterText(params.text)
  const maximumWords = params.targetWords + WORD_HIGH_ALLOWANCE
  const compressionAim = params.targetWords + 200
  for (let pass = 1; pass <= WORD_COMPLETION_MAX_PASSES; pass += 1) {
    const words = countWords(text)
    if (words >= params.targetWords && words <= maximumWords) break
    if (words < params.targetWords) {
      text = await streamChapterContent({
        modelCode: params.modelCode,
        materials: {
          ...params.materials,
          '字数补足硬要求（最高优先级）': `当前正文 ${words} 字，合格区间 ${params.targetWords}–${maximumWords} 字，还差 ${params.targetWords - words} 字。必须承接现有结尾推进本章合同内的有效剧情；不得复述、总结、提前写下一章或提前收尾。`,
        },
        targetWords: params.targetWords,
        partialText: text,
        signal: params.signal,
        onSnapshot: params.onSnapshot,
      })
      continue
    }
    text = await streamChapterContent({
      modelCode: params.modelCode,
      materials: {
        ...params.materials,
        '待压缩原稿（保留事实，不得照搬冗余）': text,
        '篇幅压缩硬要求（最高优先级）': `原稿 ${words} 字，压缩目标为 ${params.targetWords}–${compressionAim} 字，绝不能超过交付上限 ${maximumWords} 字。保留本章交付合同、因果、人物状态与章末钩子；删除复述、解释、同义反应和提前写入下一章的内容。`,
      },
      targetWords: params.targetWords,
      rewriteInstruction: `整章压缩到 ${params.targetWords}–${compressionAim} 字，绝不能超过 ${maximumWords} 字。只输出完整正文，不得新增事件，不得提前写下一章。`,
      signal: params.signal,
      onSnapshot: params.onSnapshot,
    })
  }
  return normalizeGeneratedChapterText(text)
}

// ---------------------------------------------------------------------------
// 闸三 AI 评审 + 施工单自动修复
// ---------------------------------------------------------------------------

/** 修复前的手工快照：不走 5 分钟节流，必须有这一版可回退 */
const snapshotChapterVersion = async (params: {
  bookId: string
  chapterId: number
  title: string
  text: string
}) => {
  const storage = getWritingStorage()
  await storage.saveChapterVersion({
    userId: LOCAL_USER_ID,
    bookId: params.bookId,
    chapterId: params.chapterId,
    source: 'local',
    title: params.title,
    textContent: plainTextRows(params.text).join('\n'),
    contentJson: plainTextToDocJson(params.text),
    remoteVersion: 0,
    remark: '自动修复前快照',
    createdAt: Date.now(),
  })
  const settings = await storage.getLocalWritingSettings()
  await storage.pruneChapterVersions(
    LOCAL_USER_ID,
    params.bookId,
    params.chapterId,
    Number(settings.backupRetention || 20)
  )
}

/** 把"这一章被自动改过"记进章节 planMeta，供人工追溯 */
const stampChapterFixLog = async (chapterId: number, log: JsonRecord) => {
  try {
    const storage = getLocalLibraryStorage()
    const fresh = await storage.getLocalChapterById(chapterId)
    if (!fresh) return
    await storage.updateLocalChapter({
      id: chapterId,
      // 同 updateLocalChapter 的一贯注意点：planMeta 是整体替换，必须先展开旧的
      planMeta: { ...(fresh.planMeta || {}), qualityFix: log },
    })
  } catch {
    // 追溯信息写失败不影响正文
  }
}

const withCriticNote = (notice: WorkflowQualityNotice, note: string): WorkflowQualityNotice => ({
  ...notice,
  critic: {
    status: notice.critic?.status || 'partial',
    scores: notice.critic?.scores,
    error: [note, notice.critic?.error].filter(Boolean).join('\n'),
  },
})

/**
 * fix 档只有用户明确选择 dry 时才试跑；普通自动生成直接应用修复。
 */
export const shouldPreviewFix = (params: {
  config: JsonRecord | null | undefined
  orderedChapters: LocalChapter[]
}): boolean =>
  (params.config || {}).autoFix === 'dry'

/**
 * 闸三 + 自动修复，在规则质检之后调用。跑成什么样由 run.config.selfCheckMode 决定
 * （见 utils/self-check-mode.ts）：off 不发调用 / review 只评审 / fix 评审后改稿。
 *
 * fix 档的流程：AI 评审出问题清单 → 挑出带施工单的问题 → 一次性定向改写 →
 * 存快照 → 落库 → 重跑规则轨 → 对施工单命中段做封闭验收。两处刻意的保守设计：① 改写后字数漂移过大直接放弃；
 * ② 任何一步失败都退回原状并在通知里说明——
 * 自动化不能以"悄悄改坏"为代价。
 */
const runCriticAndAutoFix = async (params: {
  run: LocalWorkflowRun
  bookId: string
  chapter: LocalChapter
  materials: Record<string, string>
  text: string
  notice: WorkflowQualityNotice
  modelCode: string
  targetWords: number
  contentVersion: number
  orderedChapters: LocalChapter[]
  previousText?: string
  /** 上轮封闭验收剩下的问题；有可执行施工单时直接复修，禁止重新全章立项。 */
  existingNotice?: WorkflowQualityNotice
  repairAttempt?: number
}): Promise<{ notice: WorkflowQualityNotice; text: string }> => {
  const config = (params.run.config || {}) as JsonRecord
  const mode = resolveGateThirdMode(config)
  if (mode === 'off') return { notice: params.notice, text: params.text }

  const chapterNo = Number(params.chapter.sortNo || 0)
  // 审核独立走审核模型；内容类精准修复也交给它，只有篇幅等全局机械修复走便宜写作模型。
  const reviewModelCode = await resolveReviewModelCode(params.run)
  const existingFixable = selectFixableIssues(params.existingNotice?.issues || [])
  let notice: WorkflowQualityNotice
  if (params.existingNotice && existingFixable.length) {
    // 封闭验收已经给出了下一张施工单，直接修它；重新全章审稿会不断另立新问题。
    notice = params.existingNotice
  } else {
    const report = await runChapterCritic({
      modelCode: reviewModelCode,
      chapterNo,
      chapterTitle: params.chapter.title,
      chapterText: params.text,
      materials: params.materials,
    })
    notice = mergeCriticReport(params.notice, report)
  }

  // 档二「只评审不改稿」：评审意见原样交给作者，不生成施工单、也不发改写调用。
  // 加档位之前这一档会照发一次改写调用再把结果丢掉——每章白烧一次写作模型额度。
  if (mode !== 'fix') return { notice, text: params.text }

  const allFixableIssues = selectFixableIssues(notice.issues)
  const globalIssues = allFixableIssues.filter(issue => GLOBAL_QUALITY_REPAIR_CODES.has(issue.code))
  // 篇幅修复会改变整章段落坐标，不能和旧坐标的局部施工单同批执行。先只修篇幅，
  // 复审后再拿新正文上的准确段号修内容问题。
  const fixableIssues = (globalIssues.length ? globalIssues : allFixableIssues).slice(0, 30)
  if (!fixableIssues.length) return { notice, text: params.text }
  const repairModelCode = globalIssues.length ? params.modelCode : reviewModelCode

  // 只有显式 dry 档才试跑；正常 fix 档直接自动修复，不再停下来等作者确认。
  const dryRun = shouldPreviewFix({ config, orderedChapters: params.orderedChapters })
  const fix = await runChapterFixRewrite({
    modelCode: repairModelCode,
    materials: params.materials,
    chapterText: params.text,
    issues: fixableIssues,
    repairAttempt: params.repairAttempt,
  })
  if (!fix.ok || !fix.diff) {
    return { notice: withCriticNote(notice, `自动修复未执行：${fix.error || '原因未知'}`), text: params.text }
  }

  const diffNote = `按施工单改 ${fix.orderCount} 项：保留段落 ${fix.diff.keptParagraphs} 个、改写 ${fix.diff.removedParagraphs} 个，字数 ${fix.diff.beforeWords}→${fix.diff.afterWords}`
  if (dryRun) {
    const samples = fix.diff.changedSamples.map(sample => `「${sample}」`).join('、')
    return {
      notice: withCriticNote(
        notice,
        `【试跑模式，未改动正文】${diffNote}${samples ? `\n动过的地方：${samples}` : ''}`
      ),
      text: params.text,
    }
  }

  try {
    await snapshotChapterVersion({
      bookId: params.bookId,
      chapterId: params.chapter.id,
      title: params.chapter.title,
      text: params.text,
    })
    const nextVersion = params.contentVersion + 1
    const fixedText = normalizeGeneratedChapterText(fix.text)
    await saveGeneratedChapterContent({
      bookId: params.bookId,
      chapterId: params.chapter.id,
      title: params.chapter.title,
      text: fixedText,
      contentVersion: nextVersion,
    })
    await writeChapterLedger(params.chapter.id, fixedText)
    await stampChapterFixLog(params.chapter.id, {
      at: new Date().toISOString(),
      applied: true,
      orders: fix.orderCount,
      beforeWords: fix.diff.beforeWords,
      afterWords: fix.diff.afterWords,
    })

    // 修复后全章重跑确定性规则；AI 只做本轮施工单的封闭验收。
    // 这样字数、禁用符号等硬伤不会漏掉，同时杜绝模型每轮换一批主观问题造成死循环。
    const recheck = runLocalChapterQualityCheck({
      chapterId: params.chapter.id,
      chapterNo,
      chapterTitle: params.chapter.title,
      text: fixedText,
      targetWords: params.targetWords,
      contentVersion: nextVersion,
      modelCode: params.modelCode,
      orderedChapters: params.orderedChapters,
      previousText: params.previousText,
    })
    // 字数是确定性规则。若篇幅修复后仍未落入硬区间，直接把新计数交回下一轮
    // 篇幅修复，不浪费一次 AI 内容审查，也不让审查顺手另立新问题。
    if (recheck.issues.some(issue => issue.blocking && GLOBAL_QUALITY_REPAIR_CODES.has(issue.code))) {
      return {
        notice: withCriticNote(recheck, diffNote),
        text: fixedText,
      }
    }
    const paragraphCount = String(fixedText || '').split(/\n+/).filter(line => line.trim()).length
    const isGlobalRewrite = shouldRerunFullCriticAfterRepair(fixableIssues)
    const targeted = new Set<number>()
    if (isGlobalRewrite) {
      for (let no = 1; no <= paragraphCount; no += 1) targeted.add(no)
    } else {
      for (const issue of fixableIssues) {
        for (const no of issue.paragraphs || []) {
          // 相邻段也纳入验收，用来发现局部改写造成的衔接硬伤。
          for (const candidate of [no - 1, no, no + 1]) {
            if (candidate >= 1 && candidate <= paragraphCount) targeted.add(candidate)
          }
        }
      }
    }
    const verificationParagraphs = [...targeted].sort((a, b) => a - b)
    // 全局篇幅改写后，平台已经用确定性规则确认字数合格；语义模型只需要在新正文上
    // 重新初审内容。局部修复则仍然做封闭验收，禁止借机另立无关问题。
    const rawVerificationReport = await runChapterCritic({
      modelCode: reviewModelCode,
      chapterNo,
      chapterTitle: params.chapter.title,
      chapterText: fixedText,
      materials: params.materials,
      reviewFocus: isGlobalRewrite
        ? undefined
        : {
            paragraphs: verificationParagraphs,
            checklist: buildFixOrderText(fixableIssues),
          },
    })
    const verificationReport = isGlobalRewrite
      ? rawVerificationReport
      : scopeCriticReportToParagraphs(rawVerificationReport, verificationParagraphs)
    const verifiedNotice = mergeCriticReport(recheck, verificationReport)
    return {
      notice: {
        ...verifiedNotice,
        critic: {
          status: verifiedNotice.critic?.status || 'unavailable',
          scores: verifiedNotice.critic?.scores,
          error: [diffNote, verifiedNotice.critic?.error].filter(Boolean).join('\n'),
        },
      },
      text: fixedText,
    }
  } catch (error) {
    return {
      notice: withCriticNote(
        notice,
        `自动修复写入失败，正文已保持原样：${String((error as Error)?.message || error)}`
      ),
      text: params.text,
    }
  }
}

// ---------------------------------------------------------------------------
// 任务快照与断点
// ---------------------------------------------------------------------------

const TERMINAL_TASK_STATUSES = new Set(['succeeded', 'failed', 'canceled', 'interrupted', 'paused', 'review_required'])
const DUPLICATE_TAB_FALSE_CANCEL = '同一本书已有生成器在其他页签运行，本页签重复任务已停止'

const persistTask = async (task: WorkflowTask) => {
  // emitSnapshot 的节流断点是不等待的异步写。模型或自检刚结束时，它可能比 halt 的终态
  // 更晚到达；若不拦，旧 running 快照会把 failed/succeeded 覆盖掉，留下永远不能继续的假任务。
  if (['queued', 'running'].includes(String(task.status))) {
    const current = await readLocalWorkflowTask(Number(task.id))
    const isLegacyDuplicateTabRace = current?.status === 'canceled'
      && String(current.errorMessage || '').includes(DUPLICATE_TAB_FALSE_CANCEL)
    if (current && TERMINAL_TASK_STATUSES.has(String(current.status)) && !isLegacyDuplicateTabRace) return
  }
  await writeLocalWorkflowTask(task)
}

const buildCheckpoint = (chapterId: number, contentText: string, seq: number) => ({
  id: createLocalEntityId(),
  chapterId,
  contentText,
  payload: { seq },
})

/** 任务进入终态时同步 run 的活跃指针（canceled/succeeded 摘掉，其余保留可恢复） */
const settleRunActiveTask = async (runId: number, taskId: number, status: string) => {
  const run = await readLocalWorkflowRun(runId)
  if (!run) return
  if (['canceled', 'succeeded'].includes(status) && Number(run.activeTaskId || 0) === Number(taskId)) {
    run.activeTaskId = null
    if (status === 'succeeded') run.status = 'completed'
    if (status === 'canceled') run.status = 'canceled'
    await writeLocalWorkflowRun(run)
  }
}

// ---------------------------------------------------------------------------
// 单章重写腿（写作台重写面板发起；独立于整书循环）
// ---------------------------------------------------------------------------

/**
 * 后台执行单章重写：按要求整章重生成 → 写入章节 → 规则质检 → 停在待确认。
 * 正文只在生成完整后落库，中途取消/失败原稿不动。
 */
export const launchLocalChapterRewrite = (task: WorkflowTask, options: { instruction: string }) => {
  const flags: WriterFlags = { pauseRequested: false, cancelRequested: false, restartChapterRequested: false, abort: null }
  writerFlags.set(Number(task.id), flags)
  registerLiveLocalTask({
    taskId: Number(task.id),
    runId: Number(task.runId),
    kind: 'rewrite',
    requestCancel: () => {
      flags.cancelRequested = true
      flags.abort?.abort()
    },
  })
  void (async () => {
    const runId = Number(task.runId)
    const taskId = Number(task.id)
    const chapterId = Number(task.currentChapterId || 0)
    let current: WorkflowTask = { ...task, status: 'running' }
    await persistTask(current)
    try {
      const run = await readLocalWorkflowRun(runId)
      if (!run || !run.bookId) throw new Error('工作流或书籍不存在')
      const bookId = String(run.bookId)
      const modelCode = await resolveWorkflowModelCode(run)
      const tree = await getLocalLibraryStorage().getLocalBookTree(bookId)
      const volume = tree.find(item => item.children.some(chapter => chapter.id === chapterId))
      const chapter = volume?.children.find(item => item.id === chapterId)
      if (!volume || !chapter) throw new Error('章节不存在或已删除')
      const targetWords = resolveChapterTargetWords(run, Number(chapter.sortNo || 0))
      const orderedChapters = tree.flatMap(item => item.children)
      const orderIndex = orderedChapters.findIndex(item => item.id === chapterId)
      const previousChapter = orderIndex > 0 ? orderedChapters[orderIndex - 1] : null
      const nextChapter = orderIndex >= 0 ? orderedChapters[orderIndex + 1] || null : null
      const original = await readChapterText(bookId, chapterId)
      const previousText = previousChapter ? (await readChapterText(bookId, previousChapter.id)).text : ''

      flags.abort = new AbortController()
      const materials = await buildChapterMaterials({
        run,
        volume,
        chapter,
        previousChapter,
        nextChapterSummary: nextChapter ? `第${nextChapter.sortNo}章《${nextChapter.title}》：${asText(nextChapter.summary)}` : '',
        orderedChapters,
      })
      if (original.text.trim()) {
        materials['原稿（重写参考，不要照抄）'] = original.text.slice(0, 4000)
      }
      let lastProgressAt = 0
      let fullText = await streamChapterContent({
        modelCode,
        materials,
        targetWords,
        rewriteInstruction: options.instruction,
        signal: flags.abort.signal,
        onSnapshot: text => {
          const now = Date.now()
          if (now - lastProgressAt < 1000) return
          lastProgressAt = now
          current = {
            ...current,
            progress: Math.min(95, Math.round((countWords(text) / Math.max(targetWords, 1)) * 100)),
          }
          void persistTask(current)
        },
      })
      fullText = await fitChapterToWordRange({
        modelCode,
        materials,
        targetWords,
        text: fullText,
        signal: flags.abort.signal,
        onSnapshot: text => {
          current = {
            ...current,
            progress: Math.min(99, Math.round((countWords(text) / Math.max(targetWords, 1)) * 100)),
          }
          void persistTask(current)
        },
      })
      flags.abort = null
      if (flags.cancelRequested) {
        current = { ...current, status: 'canceled', requestedAction: null, canCancel: false }
        await persistTask(current)
        return
      }
      if (!fullText.trim()) throw new Error('生成结果为空，请重试')

      const contentVersion = original.contentVersion + 1
      await saveGeneratedChapterContent({ bookId, chapterId, title: chapter.title, text: fullText, contentVersion })
      await getLocalLibraryStorage().updateLocalChapter({ id: chapterId, workflowStatus: 'review_required' })
      // 闸二：落库后立刻扫一遍本章，把出场人物/章末写回账本，供下一章注入（失败不影响主流程）
      await writeChapterLedger(chapterId, fullText)
      const baseNotice = runLocalChapterQualityCheck({
        chapterId,
        chapterNo: Number(chapter.sortNo || 0),
        chapterTitle: chapter.title,
        text: fullText,
        targetWords,
        contentVersion,
        modelCode,
        orderedChapters,
        previousText,
      })
      // 单章重写同样过闸三：重写往往就是"因为有问题才重写"，正是最该复核的时候
      const selfCheck = await runCriticAndAutoFix({
        run,
        bookId,
        chapter,
        materials,
        text: fullText,
        notice: baseNotice,
        modelCode,
        targetWords,
        contentVersion,
        orderedChapters,
        previousText,
      })
      const notice = selfCheck.notice
      current = {
        ...current,
        status: 'review_required',
        progress: 100,
        generatedWords: countWords(selfCheck.text),
        canReview: true,
        canCancel: true,
        payload: { ...(current.payload || {}), qualityReview: { ...notice, requiresAction: true } },
      }
      await persistTask(current)
    } catch (error) {
      if (flags.cancelRequested) {
        current = { ...current, status: 'canceled', requestedAction: null, canCancel: false }
      } else {
        current = {
          ...current,
          status: 'failed',
          errorMessage: error instanceof Error ? error.message : '重写失败，请重试',
          canCancel: false,
        }
      }
      await persistTask(current).catch(() => undefined)
    } finally {
      writerFlags.delete(taskId)
      unregisterLiveLocalTask(taskId)
    }
  })()
}

// ---------------------------------------------------------------------------
// 主循环
// ---------------------------------------------------------------------------

const taskFlagHandle = (task: WorkflowTask): WriterFlags => {
  const flags: WriterFlags = { pauseRequested: false, cancelRequested: false, restartChapterRequested: false, abort: null }
  if (typeof window !== 'undefined') {
    const commandKey = `ew-book-writer-command:${Number(task.id)}`
    const onStorage = (event: StorageEvent) => {
      if (event.key !== commandKey || event.newValue !== 'restart_current_chapter') return
      flags.restartChapterRequested = true
      flags.abort?.abort()
      localStorage.removeItem(commandKey)
    }
    window.addEventListener('storage', onStorage)
    writerCommandCleanup.set(Number(task.id), () => window.removeEventListener('storage', onStorage))
  }
  writerFlags.set(Number(task.id), flags)
  registerLiveLocalTask({
    taskId: Number(task.id),
    runId: Number(task.runId),
    kind: 'book',
    requestPause: () => {
      flags.pauseRequested = true
      flags.abort?.abort()
    },
    requestCancel: () => {
      flags.cancelRequested = true
      flags.abort?.abort()
    },
  })
  return flags
}

const releaseTask = (taskId: number) => {
  writerCommandCleanup.get(Number(taskId))?.()
  writerCommandCleanup.delete(Number(taskId))
  writerFlags.delete(Number(taskId))
  unregisterLiveLocalTask(taskId)
}

/**
 * 启动（或从确认/恢复处重启）逐章生成循环。调用方负责先把任务置为
 * queued/running 并落库；本函数在后台运行至任务出循环（终态或停机等确认）。
 */
export const launchLocalBookWriter = (task: WorkflowTask) => {
  const execute = async () => {
    const flags = taskFlagHandle(task)
    await runWriterLoop(task, flags)
    .catch(async error => {
      // 循环内部已兜错；这里只兜"兜错逻辑本身炸了"的极端情况
      console.error('逐章生成循环异常退出:', error)
      const failed: WorkflowTask = {
        ...task,
        status: 'failed',
        errorMessage: error instanceof Error ? error.message : '生成失败，请重试',
        canPause: false,
        canResume: true,
        canCancel: true,
      }
      await persistTask(failed).catch(() => undefined)
      emitLocalWorkflowEvent(buildLocalWorkflowEvent('error', Number(task.runId), Number(task.id), { message: failed.errorMessage }))
    })
    .finally(() => releaseTask(Number(task.id)))
  }

  void (async () => {
    const run = await readLocalWorkflowRun(Number(task.runId)).catch(() => null)
    // 锁必须按书籍而不是工作流 run：同一本书残留两个 run 时，按 run 加锁会同时写正文。
    const lockIdentity = run?.bookId ? `book:${String(run.bookId)}` : `run:${Number(task.runId)}`
    const lockName = `easy-writing:book-writer:${lockIdentity}`
    if (typeof navigator !== 'undefined' && navigator.locks) {
      await navigator.locks.request(lockName, { ifAvailable: true }, async lock => {
        if (lock) {
          await execute()
          return
        }
        // 另一个页签已经持有同一本书的写作锁。这里绝不能把共享任务改成 canceled：
        // 败选页签覆盖主写作页签，正是“后台仍在生成、界面却显示停了”的根因。
        // 只清理本页签的占位句柄，任务状态由真正持锁的写作器继续维护。
        releaseTask(Number(task.id))
      })
      return
    }
    await execute()
  })().catch(error => console.error('获取书籍写作锁失败:', error))
}

const runWriterLoop = async (initial: WorkflowTask, flags: WriterFlags) => {
  let task: WorkflowTask = { ...initial }
  const runId = Number(task.runId)
  const taskId = Number(task.id)
  const emit = (type: Parameters<typeof buildLocalWorkflowEvent>[0], payload?: JsonRecord) =>
    emitLocalWorkflowEvent(buildLocalWorkflowEvent(type, runId, taskId, payload))

  const run = await readLocalWorkflowRun(runId)
  if (!run || !run.bookId) throw new Error('工作流或书籍不存在')
  const bookId = String(run.bookId)
  let targetWords = resolveChapterTargetWords(run)

  const halt = async (status: string, extra: Partial<WorkflowTask> = {}) => {
    task = {
      ...task,
      ...extra,
      status,
      requestedAction: null,
      canPause: false,
      canResume: ['paused', 'interrupted', 'failed'].includes(status),
      canCancel: ['paused', 'interrupted', 'failed', 'review_required'].includes(status),
    }
    await persistTask(task)
    await settleRunActiveTask(runId, taskId, status)
  }

  const consumeChapterRestart = async () => {
    if (!flags.restartChapterRequested) return false
    flags.restartChapterRequested = false
    flags.abort = null
    task = {
      ...task,
      checkpoint: null,
      generatedWords: 0,
      requestedAction: null,
      errorMessage: null,
    }
    await persistTask(task)
    emit('stage', { message: '已丢弃当前损坏断点，正在从本章开头重新生成' })
    return true
  }

  while (true) {
    // 每章开写前重读 run：运行时创作设定（含写作规则、换模型）下一章生效
    const freshRun = await readLocalWorkflowRun(runId)
    if (freshRun) Object.assign(run, freshRun)

    if (await consumeChapterRestart()) continue

    if (flags.cancelRequested) {
      await halt('canceled')
      emit('progress', {})
      return
    }
    if (flags.pauseRequested) {
      await halt('paused')
      emit('paused', {})
      return
    }

    const work = await resolveVolumeWork(bookId)
    if (!work) {
      task = { ...task, progress: 100 }
      await halt('succeeded')
      emit('done', { remainingChapters: 0 })
      return
    }

    let modelCode: string
    try {
      modelCode = await resolveWorkflowModelCode(run)
    } catch (error) {
      await halt('failed', { errorMessage: error instanceof Error ? error.message : NO_MODEL_MESSAGE })
      emit('error', { message: task.errorMessage })
      return
    }

    // 本卷材料写完但没到目标章数：先批量规划一批章纲
    if (!work.pendingInVolume.length) {
      if (work.volume.children.length >= work.targetCount) {
        // 本卷齐了。默认仍然是「一次任务只写一卷」收工；
        // 只有作者显式开了卷间自动接力，才不收工、直接进下一卷。
        const remaining = await countRemainingAfter(bookId, work.volume.id)
        const relayUsed = Number((task.payload as JsonRecord | undefined)?.volumeRelayCount || 0)
        if (remaining > 0 && parseVolumeRelay(run.config?.volumeRelay) && relayUsed < VOLUME_RELAY_MAX) {
          task = {
            ...task,
            payload: { ...(task.payload || {}), volumeRelayCount: relayUsed + 1 },
            progress: 0,
          }
          await persistTask(task)
          emit('stage', {
            message: `《${work.volume.title}》已完成，自动接力下一卷（后面还有 ${remaining} 章）`,
            catalogUpdated: true,
          })
          continue
        }
        task = { ...task, progress: 100, finishedChapters: Number(task.finishedChapters || 0) }
        await halt('succeeded')
        emit('done', { remainingChapters: remaining })
        return
      }
      try {
        flags.abort = new AbortController()
        emit('stage', { message: `正在规划《${work.volume.title}》接下来的章纲` })
        const created = await planNextChapterBatch(run, work, modelCode, flags.abort.signal)
        task = { ...task, totalChapters: Number(task.totalChapters || 0) + created.length }
        await persistTask(task)
        emit('stage', { message: `已规划 ${created.length} 章章纲`, catalogUpdated: true })
        continue
      } catch (error) {
        if (flags.pauseRequested || flags.cancelRequested) continue
        await halt('failed', { errorMessage: error instanceof Error ? error.message : '章纲规划失败' })
        emit('error', { message: task.errorMessage })
        return
      } finally {
        flags.abort = null
      }
    }

    // 兼容旧任务留下的“待确认”章：清掉人工确认态，交给当前自动自检/重生成流程。
    let chapter = work.pendingInVolume[0]
    if (chapter.workflowStatus === 'review_required') {
      const updated = await getLocalLibraryStorage().updateLocalChapter({
        id: chapter.id,
        workflowStatus: 'incomplete',
      })
      if (updated) chapter = updated
      task = {
        ...task,
        canReview: false,
        payload: { ...(task.payload || {}), qualityReview: null, rewriteDirective: null },
      }
      await persistTask(task)
    }

    const orderIndex = work.orderedChapters.findIndex(item => item.id === chapter.id)
    const previousChapter = orderIndex > 0 ? work.orderedChapters[orderIndex - 1] : null
    const nextChapter = orderIndex >= 0 ? work.orderedChapters[orderIndex + 1] || null : null
    // 逐章重算字数目标：区间配置下每一章的目标不同，断点续写与质检复核都用同一个值
    targetWords = resolveChapterTargetWords(run, Number(chapter.sortNo || 0))
    const previousText = previousChapter ? (await readChapterText(bookId, previousChapter.id)).text : ''

    // 质检确认发起的"重写本章"：带用户意见整章重生成，不吃旧断点
    const directive = (task.payload as JsonRecord | undefined)?.rewriteDirective as
      | { chapterId: number; instruction?: string; baseText?: string }
      | null
      | undefined
    const isRewrite = Boolean(directive && Number(directive.chapterId) === chapter.id)

    // 断点续写：checkpoint 停在本章时带上已写部分
    const checkpoint = (task.checkpoint || {}) as JsonRecord
    const partialText =
      !isRewrite && Number(checkpoint.chapterId || 0) === chapter.id
        ? String(checkpoint.contentText || '')
        : ''

    try {
      flags.abort = new AbortController()
      emit('stage', { message: `正在准备第${chapter.sortNo}章《${chapter.title}》` })
      chapter = await ensureChapterBeats(run, work.volume, chapter, modelCode, flags.abort.signal)
      // 导出验收必须知道本章实际字数目标；把逐章目标随章保存，避免区间配置的章节
      // 被导出器误按默认 3000 字判断。planMeta 整体替换，因此必须保留细纲与事实账本。
      const targetTagged = await getLocalLibraryStorage().updateLocalChapter({
        id: chapter.id,
        planMeta: { ...(chapter.planMeta || {}), workflowTargetWords: targetWords },
      })
      if (targetTagged) chapter = targetTagged
    } catch (error) {
      flags.abort = null
      if (await consumeChapterRestart()) continue
      if (!flags.pauseRequested && !flags.cancelRequested) {
        await halt('failed', { errorMessage: error instanceof Error ? error.message : '细纲生成失败' })
        emit('error', { message: task.errorMessage })
        return
      }
      continue
    }
    if (flags.pauseRequested || flags.cancelRequested) {
      flags.abort = null
      continue
    }

    task = {
      ...task,
      status: 'running',
      currentChapterId: chapter.id,
      currentChapterTitle: chapter.title,
      chapterNo: Number(chapter.sortNo || 0),
      generatedWords: countWords(partialText),
      canPause: true,
      canResume: false,
      canCancel: true,
    }
    await persistTask(task)
    emit('stage', { message: `开始写第${chapter.sortNo}章《${chapter.title}》`, catalogUpdated: true })

    let lastTokenAt = 0
    let lastCheckpointAt = 0
    let checkpointSeq = Number(checkpoint?.payload?.seq || 0)
    let latestText = partialText
    const baseTotalWords = Number(task.totalGeneratedWords || 0) - countWords(partialText)

    const emitSnapshot = (fullText: string, force = false) => {
      latestText = fullText
      const now = Date.now()
      if (!force && now - lastTokenAt < TOKEN_EVENT_INTERVAL_MS) return
      lastTokenAt = now
      const words = countWords(fullText)
      emit('token', {
        chapterId: chapter.id,
        chapterTitle: chapter.title,
        chapterNo: Number(chapter.sortNo || 0),
        snapshot: fullText,
        wordCount: words,
        totalGeneratedWords: Math.max(0, baseTotalWords) + words,
        progress: task.progress,
      })
      if (now - lastCheckpointAt >= CHECKPOINT_PERSIST_INTERVAL_MS) {
        lastCheckpointAt = now
        checkpointSeq += 1
        task = {
          ...task,
          generatedWords: words,
          totalGeneratedWords: Math.max(0, baseTotalWords) + words,
          checkpoint: buildCheckpoint(chapter.id, fullText, checkpointSeq),
          checkpointId: Number(task.checkpointId || 0) || createLocalEntityId(),
        }
        void persistTask(task)
      }
    }

    let fullText = ''
    // materials 提到 try 外：闸三评审与施工单修复要用同一份素材，而它们在 try 之后才跑
    let materials: Record<string, string> = {}
    try {
      flags.abort = new AbortController()
      materials = await buildChapterMaterials({
        run,
        volume: work.volume,
        chapter,
        previousChapter,
        nextChapterSummary: nextChapter ? `第${nextChapter.sortNo}章《${nextChapter.title}》：${asText(nextChapter.summary)}` : '',
        orderedChapters: work.orderedChapters,
      })
      if (isRewrite && asText(directive?.baseText)) {
        materials['原稿（重写参考，不要照抄）'] = asText(directive?.baseText).slice(0, 4000)
      }
      fullText = shouldContinueChapterDraft(partialText, targetWords)
        ? await streamChapterContent({
            modelCode,
            materials,
            targetWords,
            partialText,
            rewriteInstruction: isRewrite ? asText(directive?.instruction) : '',
            signal: flags.abort.signal,
            onSnapshot: emitSnapshot,
          })
        : normalizeGeneratedChapterText(partialText)
      fullText = await fitChapterToWordRange({
        modelCode,
        materials,
        targetWords,
        text: fullText,
        signal: flags.abort.signal,
        onSnapshot: emitSnapshot,
      })
    } catch (error) {
      flags.abort = null
      if (await consumeChapterRestart()) continue
      // 掐流导致的失败按暂停/取消处理；真失败落断点，正文保进章节
      if (!flags.pauseRequested && !flags.cancelRequested) {
        if (latestText.trim()) {
          await saveGeneratedChapterContent({ bookId, chapterId: chapter.id, title: chapter.title, text: latestText, contentVersion: (await readChapterText(bookId, chapter.id)).contentVersion + 1 })
        }
        await halt('failed', {
          errorMessage: error instanceof Error ? error.message : '正文生成失败',
          checkpoint: buildCheckpoint(chapter.id, latestText, checkpointSeq + 1),
        })
        emit('error', { message: task.errorMessage })
        return
      }
      continue
    }
    flags.abort = null

    // 暂停/取消在流式中生效：把已写部分如实保住再停
    if (await consumeChapterRestart()) continue
    if (flags.pauseRequested || flags.cancelRequested) {
      if (latestText.trim()) {
        await saveGeneratedChapterContent({ bookId, chapterId: chapter.id, title: chapter.title, text: latestText, contentVersion: (await readChapterText(bookId, chapter.id)).contentVersion + 1 })
      }
      task = { ...task, checkpoint: buildCheckpoint(chapter.id, latestText, checkpointSeq + 1) }
      continue
    }

    if (!fullText.trim()) {
      await halt('failed', { errorMessage: '生成结果为空，请重试' })
      emit('error', { message: task.errorMessage })
      return
    }

    // 落库 → 规则轨 → AI 评审/自动修复。修复后仍有硬伤时只对剩余问题继续定点修复，
    // 不再整章重生成：整章重写会破坏已经修好的段落，并让审查每轮发现一批新问题。
    // 初审只做一次；后续把封闭验收留下的施工单继续交给修复器，直到真正通过。
    // 仅当完全相同的一组阻断项累计八次仍存在时熔断，问题在变化就不限制总轮数。
    let finalText = normalizeGeneratedChapterText(fullText)
    let notice: WorkflowQualityNotice | null = null
    let pendingRepairNotice: WorkflowQualityNotice | undefined
    const blockingAttempts = new Map<string, number>()
    while (true) {
      const contentVersion = (await readChapterText(bookId, chapter.id)).contentVersion + 1
      await saveGeneratedChapterContent({
        bookId,
        chapterId: chapter.id,
        title: chapter.title,
        text: finalText,
        contentVersion,
      })
      // 闸二：落库后立刻扫本章，把出场人物/章末写回账本，供下一章注入。
      await writeChapterLedger(chapter.id, finalText)
      emitSnapshot(finalText, true)
      const baseNotice = runLocalChapterQualityCheck({
        chapterId: chapter.id,
        chapterNo: Number(chapter.sortNo || 0),
        chapterTitle: chapter.title,
        text: finalText,
        targetWords,
        contentVersion,
        modelCode,
        orderedChapters: work.orderedChapters,
        previousText,
      })
      const selfCheck = await runCriticAndAutoFix({
        run,
        bookId,
        chapter,
        materials,
        text: finalText,
        notice: baseNotice,
        modelCode,
        targetWords,
        contentVersion,
        orderedChapters: work.orderedChapters,
        previousText,
        existingNotice: pendingRepairNotice,
        repairAttempt: pendingRepairNotice
          ? (blockingAttempts.get(blockingIssueFingerprint(pendingRepairNotice)) || 0) + 1
          : 1,
      })
      notice = selfCheck.notice
      const checkedText = normalizeGeneratedChapterText(selfCheck.text)
      if (checkedText !== finalText) emitSnapshot(checkedText, true)
      finalText = checkedText
      if (!notice.requiresAction) break

      const currentBlockingFingerprint = blockingIssueFingerprint(notice)
      const sameIssueAttempts = (blockingAttempts.get(currentBlockingFingerprint) || 0) + 1
      blockingAttempts.set(currentBlockingFingerprint, sameIssueAttempts)
      const blockingSummary = notice.issues
        .filter(issue => issue.blocking)
        .map(issue => `- ${issue.dimension || issue.code}：${issue.message}${issue.fix ? `；修正要求：${issue.fix}` : ''}`)
        .join('\n')

      if (sameIssueAttempts >= 3 && criticNeedsRetryWithoutRewrite(notice)) {
        const savedCheckpoint = buildCheckpoint(chapter.id, finalText, checkpointSeq + 1)
        task = {
          ...task,
          checkpoint: savedCheckpoint,
          generatedWords: countWords(finalText),
        }
        await halt('failed', {
          errorMessage: `第${chapter.sortNo}章 AI审查暂不可用或未给出精准施工单，自检尚未通过；平台守护器将保留当前正文并自动重试审查`,
          checkpoint: savedCheckpoint,
        })
        emit('error', { message: task.errorMessage })
        return
      }

      if (sameIssueAttempts >= SAME_BLOCKING_ESCALATION_ATTEMPTS) {
        emit('stage', {
          message: `第${chapter.sortNo}章同组问题局部精修 ${sameIssueAttempts} 次仍未收敛，模型正按原章纲重构本章后重新全检`,
        })
        flags.abort = new AbortController()
        try {
          finalText = await streamChapterContent({
            modelCode,
            materials: {
              ...materials,
              '待重构原稿（只保留事实与剧情合同，不得照抄问题表达）': finalText,
              '未通过验收的问题清单（重构后必须逐项消失）': blockingSummary,
            },
            targetWords,
            rewriteInstruction: [
              '这是自检不收敛后的整章重构。严格保留本章章纲、已发生事实、人物状态和章末钩子，禁止新增或提前写下一章事件。',
              `必须彻底消除以下问题：\n${blockingSummary}`,
              `只输出完整正文，字数必须达到 ${targetWords}–${targetWords + WORD_HIGH_ALLOWANCE} 字。`,
            ].join('\n'),
            signal: flags.abort.signal,
            onSnapshot: emitSnapshot,
          })
          finalText = await fitChapterToWordRange({
            modelCode,
            materials,
            targetWords,
            text: finalText,
            signal: flags.abort.signal,
            onSnapshot: emitSnapshot,
          })
        } finally {
          flags.abort = null
        }
        // 新稿坐标已经全部变化，必须重新全章立项；旧施工单和旧次数同时作废。
        blockingAttempts.clear()
        pendingRepairNotice = undefined
        continue
      }

      pendingRepairNotice = notice
      emit('stage', {
        message: `第${chapter.sortNo}章仍有 ${notice.issues.filter(issue => issue.blocking).length} 项阻断，模型继续定点复修（同组问题第 ${sameIssueAttempts + 1} 次）`,
      })
      // 下一轮直接拿当前正文重新审查并只修施工单命中的段落。blockingSummary 记入
      // 任务事件便于排查，但不再把它喂给整章生成器。
      if (import.meta.env.DEV && typeof localStorage !== 'undefined') {
        localStorage.setItem('ew-last-targeted-repair', blockingSummary || currentBlockingFingerprint)
      }
    }

    if (!notice) {
      await halt('failed', { errorMessage: '自检结果为空，已阻止进入下一章' })
      emit('error', { message: task.errorMessage })
      return
    }
    const words = countWords(finalText)
    const finished = Number(task.finishedChapters || 0)
    const total = Math.max(Number(task.totalChapters || 0), finished + work.pendingInVolume.length)

    if (notice.requiresAction) {
      await getLocalLibraryStorage().updateLocalChapter({ id: chapter.id, workflowStatus: 'incomplete' })
      task = {
        ...task,
        totalChapters: total,
        totalGeneratedWords: Math.max(0, baseTotalWords) + words,
        generatedWords: words,
        checkpoint: null,
        canReview: false,
        payload: { ...(task.payload || {}), qualityReview: null, qualitySuggestions: notice, rewriteDirective: null },
      }
      await halt('failed', { errorMessage: `第${chapter.sortNo}章自检尚未通过，平台守护器将从当前章自动接续修复` })
      emit('error', { message: task.errorMessage })
      return
    }

    await getLocalLibraryStorage().updateLocalChapter({ id: chapter.id, workflowStatus: null })
    const finishedNow = finished + 1
    task = {
      ...task,
      finishedChapters: finishedNow,
      totalChapters: total,
      totalGeneratedWords: Math.max(0, baseTotalWords) + words,
      generatedWords: words,
      progress: Math.min(99, Math.round((finishedNow / Math.max(total, 1)) * 100)),
      checkpoint: null,
      payload: { ...(task.payload || {}), qualitySuggestions: notice.issues.length ? notice : null, qualityReview: null, rewriteDirective: null },
    }
    await persistTask(task)
    emit('scene-done', { sceneNo: 1, progress: task.progress })
    emit('stage', { message: `第${chapter.sortNo}章《${chapter.title}》完成（${words} 字）`, catalogUpdated: true })
    emit('progress', {})
  }
}
