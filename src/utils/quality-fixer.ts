/**
 * 闸三 · 施工单自动修复执行器
 * ---------------------------------------------------------------------------
 * 普通问题使用“段落坐标补丁”：模型只返回命中段落的替换内容，平台校验段号、
 * 原文锚点和重叠范围后再写回，因此没有被点名的正文不会被模型顺手重写。
 * 只有篇幅过短/过长属于全局问题，允许走一次整章补写或压缩。
 *
 * 本模块只管「问题清单 → 新正文」，不落库、不加锁。修复后的重审、版本写回与
 * 是否继续下一章由 local-workflow-writer 负责。
 */
import type { WorkflowQualityIssue } from '@/types/workflow'
import { buildChapterFixMessages } from '@/config/workflow-prompts'
import { requestLocalChatCompletionStreaming } from '@/utils/local-ai-client'
import { parseAiJson } from '@/utils/ai-json'
import { countWords } from '@/utils/word-count'
import {
  dropDuplicateLines,
  sanitizeChapterText,
  stripChapterArtifacts,
  stripParagraphLabel,
} from '@/utils/chapter-sanitize'

const FIXABLE_GRADES = ['P0', 'P1', 'P2']
// 短稿需要补足完整事件，允许整章重写；长稿只需删冗余，走段落补丁可避免整章
// 重写后模型仍稳定产出相同长度。
const GLOBAL_REWRITE_CODES = new Set(['word_count_low'])

export const requiresGlobalChapterRewrite = (issue: WorkflowQualityIssue): boolean =>
  GLOBAL_REWRITE_CODES.has(issue.code)

export const buildWordCompressionInstruction = (
  currentWords: number,
  maximumWords: number,
): string => {
  const excess = Math.max(1, currentWords - maximumWords)
  return [
    `当前平台计数 ${currentWords} 字，上限 ${maximumWords} 字，超出 ${excess} 字。`,
    `只选择 2–12 个确有复述或冗余的段落做补丁，合计删减约 ${excess + 100}–${excess + 250} 字。`,
    '不得逐段重写全文，不得返回 12 个以上补丁，不得改变事件、因果、人物状态和章末钩子。',
    '必须返回 patches JSON；没有必要改的段落不要返回。',
  ].join('\n')
}

/** 按模型上一轮的实际字数偏差，反推下一轮应提示的目标中心。 */
export const calibrateWordRewriteTarget = (params: {
  targetWords: number
  maximumWords: number
  desiredCenter: number
  actualWords: number
  lastRequestedCenter?: number
}) => {
  const { targetWords, maximumWords, desiredCenter, actualWords } = params
  if (!targetWords) return 0
  const ratioCalibrated = Number(params.lastRequestedCenter || 0) > 0 && actualWords > 0
    ? Math.round(Number(params.lastRequestedCenter) * desiredCenter / actualWords)
    : 0
  const firstPassCorrection = actualWords < targetWords
    ? Math.max(300, (targetWords - actualWords) * 3)
    : Math.min(-300, Math.round((maximumWords - actualWords) * 0.8))
  return Math.max(
    Math.round(targetWords * 0.6),
    Math.min(maximumWords + 700, ratioCalibrated || desiredCenter + firstPassCorrection),
  )
}
const MIN_LENGTH_RATIO = 0.7
const MAX_LENGTH_RATIO = 1.5
const MAX_ORDERS = 30
const MAX_PATCHED_PARAGRAPHS = 24

const asText = (value: unknown) => String(value ?? '').trim()
const paragraphNumberOf = (value: unknown) => {
  const match = String(value ?? '').match(/\d+/)
  return match ? Number(match[0]) : Number.NaN
}
// stripParagraphLabel 已抽到 @/utils/chapter-sanitize 作单一真源。
// 原先这里写的是 `^\[?P\d+\]?` ——只剥字符串开头、且只剥一个。
// 模型若在一个 replacement 里回写好几个段号、或把段号写在行中，就会漏网，
// 这正是第一卷里 5 处 [P88]/[P18] 混进正文的成因。
const paragraphsOf = (text: string) => String(text || '').split(/\n+/).map(line => line.trim()).filter(Boolean)
const clip = (value: string, max = 120) => (value.length > max ? `${value.slice(0, max)}…` : value)

/** 从施工单自由文本中补捞「第1–6段 / P7-P9」坐标。 */
const paragraphRangesFromText = (value: unknown): number[] => {
  const result = new Set<number>()
  const pattern = /(?:第\s*)?(?:P\s*)?(\d+)\s*(?:[-–—至到]\s*(?:P\s*)?(\d+))?\s*段/gi
  let match: RegExpExecArray | null
  while ((match = pattern.exec(String(value || '')))) {
    const start = Number(match[1])
    const end = Number(match[2] || match[1])
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end - start > 24) continue
    for (let no = start; no <= end; no += 1) result.add(no)
  }
  return [...result]
}

export interface FixOrderLine {
  index: number
  source: '规则' | 'AI评审'
  grade: string
  dimension: string
  message: string
  action: string
  anchor?: string
  /** 命中段落号（1 为起点，与正文 [P数字] 对齐）：施工单带上它，模型才不用猜位置。 */
  paragraphs?: number[]
}

export const selectFixableIssues = (issues: WorkflowQualityIssue[]): WorkflowQualityIssue[] =>
  (issues || []).filter(issue => {
    const grade = issue.grade || 'P2'
    if (!FIXABLE_GRADES.includes(grade)) return false
    const fix = asText(issue.fix)
    return Boolean(fix && !fix.startsWith('未给出施工单'))
  })

export const buildFixOrderLines = (issues: WorkflowQualityIssue[]): FixOrderLine[] =>
  selectFixableIssues(issues)
    .slice(0, MAX_ORDERS)
    .map((issue, index) => ({
      index: index + 1,
      source: issue.source === 'critic' ? 'AI评审' : '规则',
      grade: issue.grade || 'P2',
      dimension: issue.dimension,
      message: asText(issue.message),
      action: asText(issue.fix),
      anchor: issue.quotes?.length ? asText(issue.quotes[0]) : undefined,
      paragraphs: (issue.paragraphs || []).filter(no => Number.isInteger(no) && Number(no) > 0),
    }))

export const buildFixOrderText = (issues: WorkflowQualityIssue[]): string =>
  buildFixOrderLines(issues)
    .map(line => {
      const head = `${line.index}. [${line.source}·${line.grade}·${line.dimension}] ${line.message}`
      const where = line.paragraphs?.length
        ? `\n   命中段落：${line.paragraphs.map(no => `P${no}`).join('、')}（以正文 [P数字] 为准，只改这些段）`
        : ''
      const anchor = line.anchor ? `\n   命中原句：${line.anchor}` : ''
      return `${head}${where}${anchor}\n   执行：${line.action}`
    })
    .join('\n')

export interface FixDiff {
  beforeWords: number
  afterWords: number
  wordDelta: number
  addedParagraphs: number
  removedParagraphs: number
  keptParagraphs: number
  changedSamples: string[]
}

export const summarizeFixDiff = (before: string, after: string): FixDiff => {
  const beforeParas = paragraphsOf(before)
  const afterParas = paragraphsOf(after)
  const afterSet = new Set(afterParas)
  const beforeSet = new Set(beforeParas)
  const removed = beforeParas.filter(paragraph => !afterSet.has(paragraph))
  const added = afterParas.filter(paragraph => !beforeSet.has(paragraph))
  const beforeWords = countWords(before)
  const afterWords = countWords(after)
  return {
    beforeWords,
    afterWords,
    wordDelta: afterWords - beforeWords,
    addedParagraphs: added.length,
    removedParagraphs: removed.length,
    keptParagraphs: beforeParas.length - removed.length,
    changedSamples: removed.slice(0, 5).map(paragraph => (paragraph.length > 30 ? `${paragraph.slice(0, 30)}…` : paragraph)),
  }
}

export interface ParagraphPatch {
  startParagraph: number
  endParagraph: number
  anchor: string
  replacement: string
}

/**
 * 模型可能在合法补丁旁边顺手返回未授权段落。越界项单独丢弃，不能让它拖累同批
 * 已正确定位的补丁；若过滤后为空，调用方才要求模型重试。
 */
export const filterPatchesToAllowedScope = (
  patches: ParagraphPatch[],
  allowedParagraphs: Iterable<number>,
): ParagraphPatch[] => {
  const allowed = new Set(allowedParagraphs)
  if (!allowed.size) return patches
  return patches.filter(patch => {
    if (!Number.isInteger(patch.startParagraph) || !Number.isInteger(patch.endParagraph)) return false
    if (patch.startParagraph < 1 || patch.endParagraph < patch.startParagraph) return false
    for (let no = patch.startParagraph; no <= patch.endParagraph; no += 1) {
      if (!allowed.has(no)) return false
    }
    return true
  })
}

export interface PatchApplyResult {
  ok: boolean
  text: string
  changedParagraphs: number
  error?: string
}

interface LocatedParagraph {
  text: string
  start: number
  end: number
}

/** 保留换行与所有未命中字符的精确位置，避免 split/join 顺手改掉全文排版。 */
const locateParagraphs = (text: string): LocatedParagraph[] => {
  const result: LocatedParagraph[] = []
  const pattern = /[^\r\n]+/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text))) {
    if (!match[0].trim()) continue
    result.push({ text: match[0], start: match.index, end: match.index + match[0].length })
  }
  return result
}

/**
 * 把施工单坐标、命中原句所在段合成平台可信修复区，并纳入前后各一段用于衔接。
 * 模型可以决定怎么改，不能决定去哪里改。
 */
export const deriveRepairScopeParagraphs = (
  source: string,
  issues: WorkflowQualityIssue[],
): number[] => {
  const paragraphs = locateParagraphs(source)
  const exact = new Set<number>()
  for (const issue of issues || []) {
    const issueHits = new Set<number>()
    for (const no of issue.paragraphs || []) {
      if (Number.isInteger(no) && no >= 1 && no <= paragraphs.length) issueHits.add(no)
    }
    for (const no of paragraphRangesFromText(issue.fix)) {
      if (no <= paragraphs.length) issueHits.add(no)
    }
    for (const quote of issue.quotes || []) {
      const needle = asText(quote).replace(/…$/, '')
      if (!needle) continue
      paragraphs.forEach((paragraph, index) => {
        if (paragraph.text.includes(needle) || needle.includes(paragraph.text.trim())) issueHits.add(index + 1)
      })
    }
    // 「第7段至全章 / 从命中句到文末」是合法的尾部删除施工单，不能被当成
    // 模型擅自扩大范围。起点仍必须来自审查段号或正文中的逐字 quote。
    if (/(?:至|到)(?:全章|文末|章末)|直到(?:全章|文末|章末)/.test(asText(issue.fix)) && issueHits.size) {
      const start = Math.min(...issueHits)
      for (let no = start; no <= paragraphs.length; no += 1) issueHits.add(no)
    }
    issueHits.forEach(no => exact.add(no))
  }
  const scoped = new Set<number>()
  for (const no of exact) {
    for (const candidate of [no - 1, no, no + 1]) {
      if (candidate >= 1 && candidate <= paragraphs.length) scoped.add(candidate)
    }
  }
  return [...scoped].sort((a, b) => a - b)
}

/** 任一坐标越界、范围重叠或锚点对不上都会整批拒绝。 */
export const applyParagraphPatches = (
  source: string,
  patches: ParagraphPatch[],
  maxPatchedParagraphs = MAX_PATCHED_PARAGRAPHS,
): PatchApplyResult => {
  const paragraphs = locateParagraphs(source)
  if (!patches.length) return { ok: false, text: source, changedParagraphs: 0, error: '模型未返回任何段落补丁' }

  const normalized = patches
    .map(patch => ({
      startParagraph: paragraphNumberOf(patch.startParagraph),
      endParagraph: paragraphNumberOf(patch.endParagraph),
      // 模型偶尔会把展示用的 [P7] 一并复制；它不是正文，机械剥离不改变定位语义。
      anchor: stripParagraphLabel(patch.anchor).replace(/…$/, ''),
      replacement: stripParagraphLabel(patch.replacement),
    }))
    .sort((a, b) => a.startParagraph - b.startParagraph)

  let previousEnd = 0
  let changedParagraphs = 0
  for (const patch of normalized) {
    const { startParagraph: start, endParagraph: end, anchor, replacement } = patch
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > paragraphs.length) {
      return { ok: false, text: source, changedParagraphs: 0, error: `段落坐标越界：P${start}–P${end}（正文共 ${paragraphs.length} 段）` }
    }
    if (start <= previousEnd) {
      return { ok: false, text: source, changedParagraphs: 0, error: `段落补丁重叠：P${start}–P${end}` }
    }
    if (!anchor) {
      return { ok: false, text: source, changedParagraphs: 0, error: `P${start}–P${end} 缺少原文锚点` }
    }
    const original = source.slice(paragraphs[start - 1].start, paragraphs[end - 1].end)
    if (!original.includes(anchor)) {
      return { ok: false, text: source, changedParagraphs: 0, error: `P${start}–P${end} 原文锚点不匹配，拒绝错位写回` }
    }
    if (replacement === original.trim()) {
      return { ok: false, text: source, changedParagraphs: 0, error: `P${start}–P${end} 没有发生实际修改` }
    }
    changedParagraphs += end - start + 1
    previousEnd = end
  }

  if (changedParagraphs > maxPatchedParagraphs) {
    return { ok: false, text: source, changedParagraphs: 0, error: `本次请求修改 ${changedParagraphs} 段，超过精修上限 ${maxPatchedParagraphs} 段` }
  }

  let text = source
  for (const patch of [...normalized].reverse()) {
    const start = paragraphs[patch.startParagraph - 1].start
    const end = paragraphs[patch.endParagraph - 1].end
    text = `${text.slice(0, start)}${patch.replacement}${text.slice(end)}`
  }
  return { ok: true, text, changedParagraphs }
}

export interface FixRewriteResult {
  ok: boolean
  text: string
  orderCount: number
  diff?: FixDiff
  error?: string
}

const cleanModelText = (value: unknown) => String(value || '')
  .replace(/<think>[\s\S]*?<\/think>/gi, '')
  .replace(/^```(?:\w+)?\s*/i, '')
  .replace(/\s*```$/, '')
  .trim()

const assertLengthRatio = (before: string, after: string) => {
  const beforeWords = countWords(before)
  const afterWords = countWords(after)
  const ratio = beforeWords ? afterWords / beforeWords : 1
  return ratio < MIN_LENGTH_RATIO || ratio > MAX_LENGTH_RATIO
    ? `修复后字数 ${afterWords}，与修复前 ${beforeWords} 相差过大（${Math.round(ratio * 100)}%），已拒绝应用`
    : ''
}

/**
 * 补丁写回后的自检。
 *
 * 模型在这一步最容易犯两种错，处置方式不同：
 *   1. 把展示用的 [Pn] 段号、自作主张的评分行带进正文 —— 纯格式噪声，机械剥掉即可；
 *   2. 把相邻段落的开头或结尾又抄一遍（正文里就会出现「沈照月一愣。」下一行又以
 *      「沈照月一愣。」开头）—— 这是改写出错。机械删掉会让替换后的段落缺头少尾，
 *      所以整批拒绝，把原因回传让模型重来。
 *
 * 「新引入」才拒绝：原文本来就有的重复行是存量问题，顺手清掉即可，
 * 不能让这一轮修复背锅（否则会连续 3 次全部拒绝，最后整批报废）。
 */
/** 改稿器的检测门槛：这里拒绝的代价只是让模型重试，所以比导出侧的 12 字查得更严。 */
const PATCH_DUP_DETECT_MIN_LEN = 6

const guardPatchedText = (source: string, patched: string): string => {
  const cleaned = stripChapterArtifacts(patched)
  const sourceCleaned = stripChapterArtifacts(source)
  const sourceHasDup = dropDuplicateLines(sourceCleaned, PATCH_DUP_DETECT_MIN_LEN) !== sourceCleaned
  const cleanedHasDup = dropDuplicateLines(cleaned, PATCH_DUP_DETECT_MIN_LEN) !== cleaned
  if (cleanedHasDup && !sourceHasDup) {
    throw new Error(
      '补丁引入了与相邻段落重复的行，很可能是把上一段的开头或结尾又写了一遍。' +
        'replacement 只输出目标范围本身的文本，不要复制相邻段落的内容。',
    )
  }
  return dropDuplicateLines(cleaned)
}
const summarizeMaterials = (materials: Record<string, string>) => {
  let used = 0
  return Object.entries(materials || {}).map(([name, value]) => {
    const remaining = Math.max(0, 12_000 - used)
    if (!remaining) return ''
    const part = String(value || '').slice(0, Math.min(remaining, 2_500))
    used += part.length
    return part ? `【${name}】\n${part}` : ''
  }).filter(Boolean).join('\n\n')
}

const runGlobalRewrite = async (params: {
  modelCode: string
  materials: Record<string, string>
  chapterText: string
  issues: WorkflowQualityIssue[]
  signal?: AbortSignal
}) => {
  const wordIssue = params.issues.find(issue => GLOBAL_REWRITE_CODES.has(issue.code))
  const targetWords = Number(wordIssue?.metrics?.targetWords || 0)
  const maximumWords = Number(wordIssue?.metrics?.maximumWords || (targetWords ? targetWords + 500 : 0))
  // 不瞄着上限写：中文模型普遍会超出自报字数，预留 200–300 字缓冲才能稳定落进硬区间。
  const desiredMin = targetWords ? targetWords + 50 : 0
  const desiredMax = targetWords ? Math.min(maximumWords, targetWords + 200) : 0
  const desiredCenter = Math.round((desiredMin + desiredMax) / 2)
  let source = params.chapterText
  let lastWords = countWords(source)
  let lastRequestedCenter = 0

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    // 用模型上一轮“提示目标 → 实际产出”的比例反推下一次提示目标。只按固定差值修正时，
    // 模型若稳定少写 10%，会每轮都停在 2940 一类相同长度，外层只能无效重试。
    const requestedCenter = calibrateWordRewriteTarget({
      targetWords,
      maximumWords,
      desiredCenter,
      actualWords: lastWords,
      lastRequestedCenter,
    })
    const requestedMin = requestedCenter ? Math.max(1, requestedCenter - 80) : desiredMin
    const requestedMax = requestedCenter ? requestedCenter + 80 : desiredMax
    const strictTarget = targetWords
      ? [
          `平台实际计数为 ${lastWords} 字；合格硬区间是 ${targetWords}–${maximumWords} 字。`,
          `为抵消模型字数估算偏差，本次提示目标是 ${requestedMin}–${requestedMax} 字；最终仍由平台重新计数，必须落入 ${targetWords}–${maximumWords} 字。`,
          '只保留原稿已有事件、因果、人物状态和章末钩子；不得新增下一章事件。',
          attempt > 1 ? `这是第 ${attempt} 次篇幅校正，上次仍未落入硬区间，必须明显调整篇幅。` : '',
        ].filter(Boolean).join('\n')
      : ''
    const messages = buildChapterFixMessages({
      materials: { ...params.materials, '平台篇幅硬校正（最高优先级）': strictTarget },
      chapterText: source,
      order: buildFixOrderText(params.issues),
    })
    messages[0].content = [
      messages[0].content,
      '【篇幅施工单例外】系统里的“与原文长度接近、上下浮动一成”不适用于篇幅修复；必须服从平台篇幅硬校正，可以大幅压缩或补写，但不得改变已有剧情事实。',
    ].join('\n')
    const raw = await requestLocalChatCompletionStreaming({
      modelCode: params.modelCode,
      scene: 'workflow_fix',
      sceneLabel: '自检·篇幅修复',
      temperature: 0.1,
      maxTokens: 32_000,
      signal: params.signal,
      messages,
    })
    const text = sanitizeChapterText(cleanModelText(raw))
    if (!text) throw new Error('篇幅修复结果为空')
    const ratioError = assertLengthRatio(params.chapterText, text)
    if (ratioError) throw new Error(ratioError)
    const words = countWords(text)
    if (!targetWords || (words >= targetWords && words <= maximumWords)) return text
    source = text
    lastWords = words
    lastRequestedCenter = requestedCenter
  }
  throw new Error(`篇幅修复连续 3 次仍未达标：当前 ${lastWords} 字，要求 ${targetWords}–${maximumWords} 字`)
}

const runPrecisePatchRewrite = async (params: {
  modelCode: string
  materials: Record<string, string>
  chapterText: string
  issues: WorkflowQualityIssue[]
  signal?: AbortSignal
  repairAttempt?: number
}) => {
  const paragraphs = locateParagraphs(params.chapterText)
  const numberedText = paragraphs.map((paragraph, index) => `[P${index + 1}] ${paragraph.text}`).join('\n')
  const wordHighIssue = params.issues.find(issue => issue.code === 'word_count_high')
  const currentWords = countWords(params.chapterText)
  const maximumWords = Number(wordHighIssue?.metrics?.maximumWords || 0)
  const compressionInstruction = wordHighIssue && maximumWords
    ? buildWordCompressionInstruction(currentWords, maximumWords)
    : ''
  let lastError = ''
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const raw = await requestLocalChatCompletionStreaming({
      modelCode: params.modelCode,
      scene: 'workflow_fix',
      sceneLabel: '自检·段落精准修复',
      temperature: 0.2,
      maxTokens: 12_000,
      signal: params.signal,
      messages: [
        {
          role: 'system',
          content: [
            '你是小说正文的段落级修复器。只处理施工单命中的最小连续段落，严禁重写整章。',
            '只输出一个合法 JSON 对象，不要解释、Markdown 或思考过程。',
            '格式：{"patches":[{"startParagraph":7,"endParagraph":7,"anchor":"目标范围内逐字存在的原文连续片段","replacement":"替换后的完整段落"}]}',
            '段号以正文中的 [P数字] 为准；多条问题命中同一段时合并成一个补丁；补丁不得重叠。',
            '施工单给了「命中段落」时，补丁范围必须落在这些段内，不得凭印象另找位置。',
            'anchor 必须逐字复制目标范围内的原文，用于平台防错位校验。replacement 必须给出目标范围修改后的完整文本。',
            '删除目标范围时 replacement 传空串；需要增写时，把保留的原段和新增内容一起放进 replacement。',
            'replacement 只输出目标范围本身的文本，严禁复制相邻段落的开头或结尾——那会让正文里出现两句一模一样的话，平台会整批拒绝。',
            '不要把展示用的 [P数字] 段号写进 replacement，也不要输出任何评分、打分之类的话。',
            '没有列入 patches 的段落将由平台逐字保留。不要在任何字段中返回整章。',
            compressionInstruction
              ? '篇幅压缩施工单只能返回 2–12 个最值得删减的段落补丁；禁止把正文每一段都重写一遍。'
              : '',
            '正文禁止使用中西式对话引号与“人物名：对白”格式。',
          ].filter(Boolean).join('\n'),
        },
        {
          role: 'user',
          content: [
            summarizeMaterials(params.materials),
            compressionInstruction ? `【平台精确压缩目标】\n${compressionInstruction}` : '',
            `【必须逐条落实的施工单】\n${buildFixOrderText(params.issues)}`,
            Number(params.repairAttempt || 1) > 1
              ? `【复修要求】这是同一批问题第 ${params.repairAttempt} 次验收未通过。不要只替换个别词语；在允许的段落范围内重写问题句及其因果衔接，确保施工单描述的现象彻底消失。`
              : '',
            lastError ? `【上次补丁被平台拒绝】\n${lastError}\n请只修正补丁协议，重新核对段号与逐字锚点。` : '',
            `【带稳定段号的当前正文】\n${numberedText}`,
          ].filter(Boolean).join('\n\n'),
        },
      ],
    })

    try {
      const parsed = parseAiJson(raw, ['patches']) as { patches?: unknown[] }
      if (!Array.isArray(parsed?.patches)) throw new Error('模型未按协议返回 patches 数组')
      const patches = parsed.patches.map(item => {
        const value = (item || {}) as Record<string, unknown>
        return {
          startParagraph: paragraphNumberOf(value.startParagraph),
          endParagraph: paragraphNumberOf(value.endParagraph),
          anchor: asText(value.anchor),
          replacement: String(value.replacement ?? ''),
        }
      })
      const allowedParagraphs = new Set(deriveRepairScopeParagraphs(params.chapterText, params.issues))
      const scopedPatches = filterPatchesToAllowedScope(patches, allowedParagraphs)
      if (allowedParagraphs.size && !scopedPatches.length) {
        throw new Error('模型只返回了施工单范围外的补丁，已全部丢弃')
      }
      const anchoredPatches = scopedPatches.map(patch => {
        const span = Number.isInteger(patch.startParagraph) && Number.isInteger(patch.endParagraph)
          ? Array.from({ length: patch.endParagraph - patch.startParagraph + 1 }, (_, index) => patch.startParagraph + index)
          : []
        // 坐标已由平台约束时，锚点直接取该范围的真实原文（包括原始空行）。模型手抄
        // 标点或换行的误差不再决定修复成败。
        if (span.length && paragraphs[patch.startParagraph - 1] && paragraphs[patch.endParagraph - 1]) {
          return {
            ...patch,
            anchor: params.chapterText.slice(
              paragraphs[patch.startParagraph - 1].start,
              paragraphs[patch.endParagraph - 1].end,
            ),
          }
        }
        return patch
      })
      // 模型偶尔把已经合格的段落原样返回。空补丁不该拖垮同批真正需要的修复。
      const effectivePatches = anchoredPatches.filter(patch => {
        if (!paragraphs[patch.startParagraph - 1] || !paragraphs[patch.endParagraph - 1]) return true
        const original = params.chapterText.slice(
          paragraphs[patch.startParagraph - 1].start,
          paragraphs[patch.endParagraph - 1].end,
        )
        return stripParagraphLabel(patch.replacement) !== original.trim()
      })
      const patchLimit = Math.min(80, Math.max(
        MAX_PATCHED_PARAGRAPHS,
        allowedParagraphs.size,
        params.issues.length * 3,
      ))
      const applied = applyParagraphPatches(params.chapterText, effectivePatches, patchLimit)
      if (!applied.ok) throw new Error(applied.error || '段落补丁校验失败')
      const guarded = guardPatchedText(params.chapterText, applied.text)
      const ratioError = assertLengthRatio(params.chapterText, guarded)
      if (ratioError) throw new Error(ratioError)
      return guarded
    } catch (error) {
      lastError = clip(String((error as Error)?.message || error), 240)
      if (import.meta.env.DEV && typeof localStorage !== 'undefined') {
        localStorage.setItem('ew-last-patch-validation-error', `${attempt}:${lastError}`)
      }
    }
  }
  throw new Error(`段落补丁连续 3 次未通过平台校验：${lastError || '未知错误'}`)
}

/**
 * 篇幅与坐标精修必须分轮执行：全局改写后旧段号已经失效，继续套旧坐标必然错修。
 * 调用方会在篇幅修复后重新审查，再把新正文上的坐标交回来。
 */
export const runChapterFixRewrite = async (params: {
  modelCode: string
  materials: Record<string, string>
  chapterText: string
  issues: WorkflowQualityIssue[]
  signal?: AbortSignal
  repairAttempt?: number
}): Promise<FixRewriteResult> => {
  const originalText = String(params.chapterText || '')
  const selected = selectFixableIssues(params.issues).slice(0, MAX_ORDERS)
  const orderCount = selected.length
  if (!orderCount) return { ok: false, text: originalText, orderCount: 0, error: '没有可执行的施工单' }
  if (!originalText.trim()) return { ok: false, text: originalText, orderCount, error: '本章正文为空' }

  const globalIssues = selected.filter(requiresGlobalChapterRewrite)
  const preciseIssues = selected.filter(issue => !requiresGlobalChapterRewrite(issue))
  try {
    const executedIssues = globalIssues.length ? globalIssues : preciseIssues
    const text = globalIssues.length
      ? await runGlobalRewrite({ ...params, chapterText: originalText, issues: globalIssues })
      : await runPrecisePatchRewrite({ ...params, chapterText: originalText, issues: preciseIssues })
    return { ok: true, text, orderCount: executedIssues.length, diff: summarizeFixDiff(originalText, text) }
  } catch (error) {
    return { ok: false, text: originalText, orderCount, error: `修复调用失败：${clip(String((error as Error)?.message || error))}` }
  }
}
