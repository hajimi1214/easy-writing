/**
 * 闸二 · 事实账本轨（本地 · 零 AI 调用）+ 全书进度注入
 * ---------------------------------------------------------------------------
 * 要解决的问题：长篇写到第 100 章时，引擎只喂「上一章结尾 600 字」，
 * 第 1–98 章发生过什么完全不在上下文里 —— 于是内容脱节、章节对不上、
 * 配角突然出场、伏笔重复埋。这不是模型不行，是素材没给够。
 *
 * 本模块做两件事，都不花一分钱 AI 调用：
 *
 *  1) 生成前：buildLedgerMaterials() 把「全书已写章节一览 + 近期章纲 + 人物出场表」
 *     拼成提示词素材。模型终于能看到前面每一章写了什么，而不是只看得到上一章尾巴。
 *
 *  2) 生成后：writeChapterLedger() 把本章的「出场人物 / 字数 / 章末」快照写回
 *     该章自己的 planMeta.workflowLedger（复用现有 JSON 字段，不动数据库表结构）。
 *     下一章生成时读缓存即可，每章正文只在写完后扫一次，开销收敛为常数。
 *
 * 账本是「增量 + 可自愈」的：读取端只读缓存，不会为了补账去补扫上百章正文；
 * 真正的写入发生在每章落库之后那一次。缺账本的章节会被如实跳过并在提示里标注。
 */
import { getLocalLibraryStorage } from '@/storage/local-library'
import type { LocalChapter } from '@/storage/local-library-types'
import entities from '@/config/quality-rules/03-entities.json'
import { countWords } from '@/utils/word-count'
import { describeArtifactLedger, resolveVolumeOfChapter, scanArtifactQuantities } from '@/utils/quality-rules'

/** 账本存在章节自己的 planMeta 里，键名固定 */
const LEDGER_KEY = 'workflowLedger'
/** 章末留存长度：用于让下一章接得住语气与场景 */
const LEDGER_TAIL_CHARS = 160
/** 近期章纲注入条数：再往前的章只给「章号 + 标题」，避免素材过长 */
const RECENT_SUMMARY_COUNT = 12

const roster = (entities as unknown as {
  characters: Array<{ name: string; aliases?: string[]; isCollective?: boolean }>
}).characters || []

/** 名册里全部名字 + 化名，用于扫描本章谁出场了 */
const rosterNames = roster
  .flatMap(character => [character.name, ...(character.aliases || [])])
  .filter(Boolean)

const asText = (value: unknown) => String(value ?? '').trim()

/** 一章的事实快照 */
export interface ChapterLedger {
  chapterNo: number
  title: string
  wordCount: number
  /** 本章出场的人物（按名册 + 化名扫描，包含"被提到"的情况） */
  characters: string[]
  /** 章末节选：下一章开头要接得住 */
  tail: string
  /**
   * 本章「可数物件」的**明确新增**数（键=04-artifacts.json 的 key）。
   * 只在正文带取得动词、且非指代时计数 —— 裸列举与「那五枚」都不算，宁可少记。
   * 用途：① 累加成「截至上一章共 N 枚」在生成前注入；② 与本章累计声明比对。
   */
  artifacts?: Record<string, number>
  /**
   * 本章**明确声明的累计数**（「共十一枚」里的 11）。
   * 作用是给账本播种：中途接管一本已写好的书时，历史增量无从追溯，
   * 但「某章说共 N 枚」本身就是权威基准 —— 取声明峰值当基线，账本才不会从 0 起算。
   */
  artifactClaims?: Record<string, number>
  updatedAt: string
}

/** 扫一章正文，得出事实快照（纯字符串匹配，确定性，零 AI） */
export const scanChapterLedger = (chapter: LocalChapter, text: string): ChapterLedger => {
  const body = String(text || '')
  const chapterNo = Number(chapter.sortNo || 0)
  const increments: Record<string, number> = {}
  const claims: Record<string, number> = {}
  for (const [key, scan] of Object.entries(scanArtifactQuantities(body, chapterNo))) {
    if (scan.increment > 0) increments[key] = scan.increment
    if (scan.claim !== null) claims[key] = scan.claim
  }
  return {
    chapterNo,
    title: chapter.title,
    wordCount: countWords(body),
    characters: rosterNames.filter(name => body.includes(name)),
    tail: asText(body.slice(-LEDGER_TAIL_CHARS)),
    artifacts: Object.keys(increments).length ? increments : undefined,
    artifactClaims: Object.keys(claims).length ? claims : undefined,
    updatedAt: new Date().toISOString(),
  }
}

/**
 * 累加成「截至某一章之前」各可数物件的总数 —— 闸一数量平衡校验的前账。
 * 纯读缓存（各章自己 planMeta 里的账本），不为了补账去回扫正文。
 */
export const buildArtifactTotals = (
  orderedChapters: LocalChapter[],
  currentChapterNo: number,
): Record<string, number> => {
  const sums: Record<string, number> = {}
  const claims: Record<string, number> = {}
  const currentNo = Number(currentChapterNo || 0)
  for (const chapter of orderedChapters) {
    const no = Number(chapter.sortNo || 0)
    if (!no || (currentNo > 0 && no >= currentNo)) continue
    const ledger = readChapterLedger(chapter)
    if (!ledger) continue
    for (const [key, value] of Object.entries(ledger.artifacts || {})) {
      sums[key] = (sums[key] || 0) + Number(value || 0)
    }
    for (const [key, value] of Object.entries(ledger.artifactClaims || {})) {
      claims[key] = Math.max(claims[key] || 0, Number(value || 0))
    }
  }
  // 取「增量累计」与「声明峰值」的较大者：前者是逐章推算，后者是正文自报，
  // 中途接管一本书时靠后者播种，账本不会从 0 起算。
  const totals: Record<string, number> = {}
  for (const key of new Set([...Object.keys(sums), ...Object.keys(claims)])) {
    totals[key] = Math.max(sums[key] || 0, claims[key] || 0)
  }
  return totals
}

/** 读章节已缓存的账本；没写过返回 null */
export const readChapterLedger = (chapter: LocalChapter): ChapterLedger | null => {
  const raw = (chapter.planMeta || {})[LEDGER_KEY] as ChapterLedger | undefined
  if (!raw || typeof raw !== 'object') return null
  if (!Array.isArray(raw.characters)) return null
  return raw
}

/**
 * 章节落库之后调用：扫一遍正文，把事实快照写回该章 planMeta。
 * 写失败只吞掉不抛 —— 账本是增益项，不能因为它把整卷生成搞停。
 */
export const writeChapterLedger = async (chapterId: number, text: string): Promise<ChapterLedger | null> => {
  try {
    const storage = getLocalLibraryStorage()
    const chapter = await storage.getLocalChapterById(chapterId)
    if (!chapter) return null
    const body = String(text || '').trim()
    if (!body) return null
    const ledger = scanChapterLedger(chapter, body)
    await storage.updateLocalChapter({
      id: chapter.id,
      // updateLocalChapter 是整体替换 planMeta，必须先展开旧的，否则会抹掉细纲（expandedOutline）
      planMeta: { ...(chapter.planMeta || {}), [LEDGER_KEY]: ledger },
    })
    return ledger
  } catch {
    return null
  }
}

/** 拼「全书进度」：已写完的章一行一章，跨卷时插卷头，让模型知道自己在全书的哪个位置 */
const describeProgress = (written: LocalChapter[]) => {
  const lines: string[] = []
  let lastVolumeKey = ''
  for (const chapter of written) {
    const chapterNo = Number(chapter.sortNo || 0)
    const volume = resolveVolumeOfChapter(chapterNo)
    if (volume && volume.key !== lastVolumeKey) {
      lastVolumeKey = volume.key
      lines.push(`— 卷《${volume.name}》第${volume.from}–${volume.to}章 —`)
    }
    lines.push(`第${chapterNo}章《${chapter.title}》`)
  }
  return lines.join('\n')
}

/** 拼「人物出场表」：谁出过场、最近一次在第几章；没出过场的点名警告 */
const describeCast = (written: LocalChapter[]) => {
  const lastSeen = new Map<string, number>()
  for (const chapter of written) {
    const ledger = readChapterLedger(chapter)
    if (!ledger) continue
    for (const name of ledger.characters) lastSeen.set(name, Number(chapter.sortNo || 0))
  }
  if (!lastSeen.size) return ''
  const seen = roster
    .filter(character => lastSeen.has(character.name))
    .map(character => `${character.name}（最近第${lastSeen.get(character.name)}章）`)
  const unseen = roster
    .filter(character => !lastSeen.has(character.name) && !character.isCollective)
    .map(character => character.name)
  return [
    seen.length ? `已出场：${seen.join('、')}` : '',
    unseen.length ? `尚未出场：${unseen.join('、')}（不得凭空登场或被提前点名）` : '',
    '注：出场表依据各章落库时留下的事实快照，未扫到快照的章节不计入。',
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * 生成前的账本素材。有已写章节才产出；第一章返回空对象，不污染提示词。
 */
export const buildLedgerMaterials = async (params: {
  orderedChapters: LocalChapter[]
  currentChapterNo: number
}): Promise<Record<string, string>> => {
  const currentNo = Number(params.currentChapterNo || 0)
  const written = params.orderedChapters.filter(chapter => {
    const no = Number(chapter.sortNo || 0)
    return no > 0 && (currentNo <= 0 || no < currentNo)
  })
  if (!written.length) return {}

  const materials: Record<string, string> = {
    '全书进度（已写完的章节，按序）': describeProgress(written),
  }

  const recentLines = written
    .slice(-RECENT_SUMMARY_COUNT)
    .map(chapter => `第${chapter.sortNo}章《${chapter.title}》：${asText(chapter.summary)}`)
    .filter(line => !line.endsWith('：'))
  if (recentLines.length) {
    materials['近期章纲（最近 12 章，承接用）'] = recentLines.join('\n')
  }

  const cast = describeCast(written)
  if (cast) materials['人物出场表（未列出的人物不得突然出场）'] = cast

  // 可数物件账本：把「截至上一章共 N 枚」写进提示词。数字错是算术错、不是理解错，
  // 与其指望模型自己数对，不如直接把账本摊在它面前（生成前注入 ＞ 生成后检测）。
  const artifactLedger = describeArtifactLedger(buildArtifactTotals(written, currentNo))
  if (artifactLedger) materials['可数物件账本（写数量时必须对上）'] = artifactLedger

  return materials
}

/** 供质检面板做「账本覆盖率」提示：已写章节里有多少章留了事实快照 */
export const summarizeLedgerCoverage = (orderedChapters: LocalChapter[]) => {
  let written = 0
  let covered = 0
  for (const chapter of orderedChapters) {
    if (!Number(chapter.sortNo || 0)) continue
    written += 1
    if (readChapterLedger(chapter)) covered += 1
  }
  return { written, covered, missing: Math.max(0, written - covered) }
}
