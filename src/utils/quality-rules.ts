/**
 * 闸一 · 本地规则轨（平台内嵌版）
 * ---------------------------------------------------------------------------
 * 设计要点：同一份规则库一物两用——
 *   1) 生成前：describeChapterConstraints() 把「本章禁忌」写进提示词 —— 预防；
 *   2) 生成后：lintChapterWithRules() 扫正文出问题清单 —— 检测。
 * 只用词表 / 正则 / 统计，零 AI 调用，确定性结果。
 *
 * 规则数据在 src/config/quality-rules/*.json，与独立校验器（自检/lint.mjs）共用同一份，
 * 保证「平台里跑的」和「命令行跑的」判定一致。
 *
 * 校准记录见各 JSON 的 calibration 字段：规则全部经 239 个真实章节语料校准过，
 * 误报过高的规则已被停用而非保留（对话占比规则即因此默认关闭）。
 */
import type { WorkflowQualityIssue } from '@/types/workflow'
import { countWords } from '@/utils/word-count'

import spoilerBan from '@/config/quality-rules/00-spoiler-ban.json'
import styleBan from '@/config/quality-rules/01-style-ban.json'
import pacing from '@/config/quality-rules/02-pacing.json'
import entities from '@/config/quality-rules/03-entities.json'
import artifactsRule from '@/config/quality-rules/04-artifacts.json'

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------
export type QualityGrade = 'P0' | 'P1' | 'P2'

interface BanException {
  chapter: number
  maxOccurrences: number
  note?: string
}

interface SpoilerBanItem {
  id: string
  label: string
  severity: QualityGrade
  dimension?: string
  terms?: string[]
  patterns?: string[]
  bannedUntilChapter: number
  exceptions?: BanException[]
  rule: string
  note?: string
}

interface StylePattern {
  id: string
  regex: string
  severity: QualityGrade
  label: string
  dimension?: string
  multiline?: boolean
  /** 命中多少处才算问题。默认 1；语料实测有零星真人命中的规则要抬高（如译文句式 = 2） */
  minHits?: number
  note?: string
  calibrated?: string
}

/** 密度类指标：单次出现完全正常，密集才可疑。阈值按本书自身语料分位数定（见 JSON 的 calibrated） */
interface DensityMetric {
  id: string
  term: string
  label: string
  severity: QualityGrade
  dimension?: string
  maxPer1000: number
  note?: string
  calibrated?: string
}

const spoiler = spoilerBan as unknown as {
  version: number
  volumeRanges: Record<string, { name: string; from: number; to: number }>
  bans: SpoilerBanItem[]
}
const style = styleBan as unknown as {
  thresholds: { fillerAdverbPer1000: number; connectorPer1000: number }
  templatePhrases: Array<{ term: string; severity: QualityGrade; note?: string }>
  contextPhrases: Array<{ term: string; severity: QualityGrade; needsContext?: boolean; note?: string }>
  fillerAdverbs: string[]
  connectors: string[]
  patterns: StylePattern[]
  densityMetrics: DensityMetric[]
  behavioralPatterns: string[]
}
const pacingRule = pacing as unknown as {
  wordCount: { target: { min: number; max: number }; blockBelowRatio: number; noticeAboveRatio: number }
  paragraph: { maxChars: number; severity: QualityGrade }
  uniformity: { minParagraphs: number; minStdDevChars: number; minStdevToMeanRatio: number; severity: QualityGrade }
  opening: { hookWithinChars: number; severity: QualityGrade }
  dialogueRatio: { min: number; enabledByDefault?: boolean; severity: QualityGrade }
}
const entityRule = entities as unknown as {
  characters: Array<{ name: string; aliases?: string[]; isCollective?: boolean }>
  totalChapters: number
}

/** 可数物件清单（04-artifacts.json）：闸二的数字账本靠它落地 */
interface ArtifactRule {
  key: string
  label: string
  terms: string[]
  unit: string
  /** 可选：该物件还会用到的其它量词。不给就只认 unit */
  units?: string[]
  severity?: QualityGrade
  fromChapter?: number
  note?: string
}
const artifactCfg = artifactsRule as unknown as {
  version: number
  quantityUnits: string[]
  incrementVerbs: string[]
  totalMarkers: string[]
  tolerance: number
  artifacts: ArtifactRule[]
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
const countCJK = (text: string) => (text.match(/[\u4e00-\u9fff]/g) || []).length

const paragraphsOf = (text: string) => text.split(/\n+/).map(s => s.trim()).filter(Boolean)

const clip = (value: string, max = 50) => {
  const t = String(value || '').trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}

const countOccurrences = (text: string, needle: string) => {
  if (!needle) return 0
  return text.split(needle).length - 1
}

const occurrenceEvidence = (text: string, needle: string) => {
  const index = text.indexOf(needle)
  if (index === -1) return ''
  return clip(text.slice(Math.max(0, index - 12), index + needle.length + 26), 60)
}

const densityPer1000 = (count: number, chars: number) => (chars ? (count / chars) * 1000 : 0)

const toIssue = (params: {
  code: string
  dimension: string
  grade: QualityGrade
  message: string
  blocking: boolean
  quotes?: string[]
  fix?: string
  paragraphs?: number[]
  metrics?: Record<string, number>
}): WorkflowQualityIssue => ({
  source: 'rule',
  code: params.code,
  dimension: params.dimension,
  grade: params.grade,
  severity: params.grade === 'P2' ? 'low' : 'high',
  blocking: params.blocking,
  message: params.message,
  quotes: params.quotes?.length ? params.quotes.slice(0, 3) : undefined,
  fix: params.fix,
  paragraphs: params.paragraphs,
  metrics: params.metrics,
})

// ---------------------------------------------------------------------------
// 一、生成前：本章约束说明书（注入提示词，预防而非检测）
// ---------------------------------------------------------------------------

/** 本章所属卷 */
export const resolveVolumeOfChapter = (chapterNo: number) => {
  for (const key of Object.keys(spoiler.volumeRanges)) {
    const range = spoiler.volumeRanges[key]
    if (chapterNo >= range.from && chapterNo <= range.to) return { key, ...range }
  }
  return null
}

/**
 * 本章仍然生效的剧透禁令。用于两处：
 *  - 生成前注入提示词（告诉模型本卷不许说破什么）
 *  - 生成后核对是否越界
 */
export const getActiveBans = (chapterNo: number) =>
  spoiler.bans.filter(ban => chapterNo > 0 && chapterNo <= ban.bannedUntilChapter)

/**
 * 文风红线文本块。直接从 01-style-ban.json 渲染，规则一改这里自动跟着变——
 * 检测用的词表和注入用的禁令永远是同一份，不会出现"判它不合格却没告诉它"。
 */
const describeStyleConstraints = () => {
  const terms = style.templatePhrases.map(item => item.term)
  const densities = (style.densityMetrics || [])
    .map(metric => `${metric.term} 不超过 ${metric.maxPer1000}/千字`)
    .join('、')
  return [
    '【文风硬红线（违反降级处理）】',
    `· 禁用模板短语：${terms.join('、')}`,
    `· 慎用万能副词与承接词（每千字超过 8 个即算堆砌）：${[...style.fillerAdverbs, ...style.connectors].join('、')}`,
    `· 禁用句式：${style.patterns.map(item => item.label).join('；')}`,
    `· 符号密度上限（按本书自身语料的 p95 定，比这密就不像这本书了）：${densities}`,
    '· 全书只统一一种引号，不要双引号与「」混用；不要用分割线符号。',
    '【不要写成"标准答案式"文本 —— 这是 AI 味最根本的来源，比用词更致命】',
    ...(style.behavioralPatterns || []).map(item => `· 规避：${item}`),
    '· 反过来：允许说"不知道"、允许话说一半打住、允许推翻自己、允许留一个不回答的问题。人的文字有犹豫和留白。',
  ].join('\n')
}

/** 拼成本章的「禁忌与约束」文本块，直接塞进提示词素材 */
export const describeChapterConstraints = (chapterNo: number): string => {
  if (!Number.isFinite(chapterNo) || chapterNo <= 0) return ''
  const volume = resolveVolumeOfChapter(chapterNo)
  const activeBans = getActiveBans(chapterNo)
  const lines: string[] = []

  if (volume) {
    lines.push(`【本卷】第${volume.from}–${volume.to}章《${volume.name}》`)
  }
  if (activeBans.length) {
    lines.push('【本章绝对禁止说破（违反即整章作废，属最高红线）】')
    for (const ban of activeBans) {
      const exception = (ban.exceptions || []).find(item => item.chapter === chapterNo)
      // 字面禁语直接列出来给模型看，概念类只描述不列（列了反而诱导它去写）
      const terms = (ban.terms || []).filter(Boolean)
      const head = exception
        ? `· ${ban.label}：本章属放宽章，最多出现 ${exception.maxOccurrences} 次（${exception.note || ''}）`
        : `· ${ban.label}：${terms.length ? `不得出现「${terms.join('」「')}」；` : ''}${ban.rule}`
      lines.push(head)
    }
    lines.push('以上约束优先于剧情需要：宁可留白、留给后卷，也不得提前说破。')
  }

  lines.push(describeStyleConstraints())

  const chars = pacing.wordCount.target
  lines.push(`【篇幅】本章目标 ${chars.min}–${chars.max} 字`)
  lines.push(`【开篇】前 ${pacing.opening.hookWithinChars} 字内必须出现人物动作或异常，禁止景物/设定开场超过两段`)
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// 二、生成后：逐章规则体检
// ---------------------------------------------------------------------------

const checkSpoilerBans = (text: string, chapterNo: number): WorkflowQualityIssue[] => {
  const issues: WorkflowQualityIssue[] = []
  if (!Number.isFinite(chapterNo) || chapterNo <= 0) return issues

  for (const ban of getActiveBans(chapterNo)) {
    const hits: Array<{ term: string; count: number; sample: string }> = []

    for (const term of ban.terms || []) {
      const count = countOccurrences(text, term)
      if (count > 0) hits.push({ term, count, sample: occurrenceEvidence(text, term) })
    }
    for (const pattern of ban.patterns || []) {
      try {
        const found = text.match(new RegExp(pattern, 'g'))
        if (found?.length) hits.push({ term: pattern, count: found.length, sample: clip(found[0], 60) })
      } catch {
        // 规则里写了非法正则时跳过，不让一条坏规则拖垮整章质检
      }
    }
    if (!hits.length) continue

    const total = hits.reduce((sum, hit) => sum + hit.count, 0)
    const exception = (ban.exceptions || []).find(item => item.chapter === chapterNo)

    if (exception) {
      if (total <= exception.maxOccurrences) continue
      issues.push(toIssue({
        code: ban.id,
        dimension: ban.dimension || '设定红线',
        grade: ban.severity,
        blocking: true,
        message: `本章属「${ban.label}」放宽章（允许 ${exception.maxOccurrences} 次），实命中 ${total} 次，超出限制`,
        quotes: hits.map(hit => hit.sample).filter(Boolean),
        fix: `删减至 ${exception.maxOccurrences} 次以内`,
        metrics: { hits: total },
      }))
      continue
    }

    issues.push(toIssue({
      code: ban.id,
      dimension: ban.dimension || '设定红线',
      grade: ban.severity,
      blocking: ban.severity === 'P0',
      message: `剧透红线越界：「${ban.label}」在本章（第${chapterNo}章）不得出现，禁至第${ban.bannedUntilChapter}章。${ban.rule}`,
      quotes: hits.map(hit => hit.sample).filter(Boolean),
      fix: '改写为不点破机制的异常感描写，或删去该句',
      metrics: { hits: total },
    }))
  }
  return issues
}

const checkStyle = (text: string): WorkflowQualityIssue[] => {
  const issues: WorkflowQualityIssue[] = []
  const chars = countCJK(text)

  // 模板短语：命中即报（黑名单点名「一出现就出戏」）
  const templateHits = style.templatePhrases
    .map(item => ({ ...item, count: countOccurrences(text, item.term) }))
    .filter(item => item.count > 0)

  for (const grade of ['P0', 'P1', 'P2'] as QualityGrade[]) {
    const group = templateHits.filter(item => item.severity === grade)
    if (!group.length) continue
    issues.push(toIssue({
      code: `STYLE-TEMPLATE-${grade}`,
      dimension: 'AI味',
      grade,
      blocking: grade === 'P0',
      message: `命中 AI 味模板短语 ${group.length} 种：${group.map(item => `${item.term}×${item.count}`).join('、')}`,
      quotes: group.map(item => occurrenceEvidence(text, item.term)).filter(Boolean),
      fix: '黑名单点名「一出现就出戏」。改成具体动作与结果，或直接删',
      metrics: { kinds: group.length, total: group.reduce((sum, item) => sum + item.count, 0) },
    }))
  }

  // 万能副词 / 承接词：密度阈值（单次出现完全正常，密集才可疑）
  const densityIssue = (words: string[], threshold: number, code: string, label: string) => {
    const hits = words
      .map(word => ({ term: word, count: countOccurrences(text, word) }))
      .filter(item => item.count > 0)
    const total = hits.reduce((sum, item) => sum + item.count, 0)
    const density = densityPer1000(total, chars)
    if (density <= threshold) return null
    return toIssue({
      code,
      dimension: 'AI味',
      grade: 'P2',
      blocking: false,
      message: `${label}密度 ${density.toFixed(1)}/千字，超出阈值 ${threshold}（共 ${total} 次 / ${chars} 字）`,
      quotes: hits.sort((a, b) => b.count - a.count).slice(0, 3).map(item => `${item.term}×${item.count}`),
      fix: '删掉三分之一的程度副词；把「微微/缓缓」换成具体动作，或干脆不写',
      metrics: { density: Number(density.toFixed(1)), threshold, total, chars },
    })
  }
  const adverbIssue = densityIssue(style.fillerAdverbs, style.thresholds.fillerAdverbPer1000, 'STYLE-ADVERB-DENSITY', '万能程度副词')
  if (adverbIssue) issues.push(adverbIssue)
  const connectorIssue = densityIssue(style.connectors, style.thresholds.connectorPer1000, 'STYLE-CONNECTOR-DENSITY', '承接/转折连接词')
  if (connectorIssue) issues.push(connectorIssue)

  // 句式正则
  for (const pattern of style.patterns) {
    let found: RegExpMatchArray | null = null
    try {
      found = text.match(new RegExp(pattern.regex, pattern.multiline ? 'gm' : 'g'))
    } catch {
      continue
    }
    // minHits：语料实测真人也会零星命中的规则（如译文句式 9/108 章各 1 处）必须够量才算问题，
    // 否则一条本该零误报的规则会被正常行文反复触发
    const minHits = pattern.minHits && pattern.minHits > 1 ? pattern.minHits : 1
    if (!found?.length || found.length < minHits) continue
    issues.push(toIssue({
      code: pattern.id,
      dimension: pattern.dimension || 'AI味',
      grade: pattern.severity,
      blocking: pattern.severity === 'P0',
      message: `${pattern.label}：命中 ${found.length} 处${minHits > 1 ? `（阈值 ≥${minHits}）` : ''}`,
      quotes: found.map(item => clip(item, 50)),
      fix: '改写句式，避免与黑名单句型同构',
      metrics: { hits: found.length, minHits },
    }))
  }

  // 引号混用（全书只允许一种）
  const doubleQuote = (text.match(/[“”]/g) || []).length
  const cornerQuote = (text.match(/[「」]/g) || []).length
  if (doubleQuote > 0 && cornerQuote > 0) {
    issues.push(toIssue({
      code: 'STYLE-QUOTE-MIX',
      dimension: '排版',
      grade: 'P2',
      blocking: false,
      message: `引号混用：双引号 ${doubleQuote} 处 / 书名号 ${cornerQuote} 处。全书只允许一种`,
      fix: '统一为一套引号',
      metrics: { doubleQuote, cornerQuote },
    }))
  }

  return issues
}

const checkPacing = (text: string, targetWords?: number): WorkflowQualityIssue[] => {
  const issues: WorkflowQualityIssue[] = []
  const paragraphs = paragraphsOf(text)
  const chars = countCJK(text)
  const { min, max } = pacingRule.wordCount.target
  const targetMin = targetWords && targetWords > 0 ? Math.round(targetWords * 0.85) : min
  const targetMax = targetWords && targetWords > 0 ? Math.round(targetWords * 1.2) : max

  // 多章合订文件做单章字数判定必然误报，跳过
  const isMerged = (text.match(/第\d+章/g) || []).length > 1

  if (!isMerged && chars < Math.round(min * pacingRule.wordCount.blockBelowRatio)) {
    issues.push(toIssue({
      code: 'word_count_low',
      dimension: '篇幅',
      grade: 'P0',
      blocking: true,
      message: `本章 ${chars} 字（中文字计），低于目标下限 ${targetMin} 的 ${Math.round(pacingRule.wordCount.blockBelowRatio * 100)}%，疑似生成中断或提前收尾`,
      fix: '重写本章补足剧情，或人工补写后接受',
      metrics: { chars, targetMin },
    }))
  } else if (!isMerged && chars > Math.round(targetMax * pacingRule.wordCount.noticeAboveRatio)) {
    issues.push(toIssue({
      code: 'word_count_high',
      dimension: '篇幅',
      grade: 'P2',
      blocking: false,
      message: `本章 ${chars} 字，超出目标上限 ${targetMax} 较多，节奏可能偏拖`,
      fix: '检查是否有注水段落',
      metrics: { chars, targetMax },
    }))
  }

  // 超长段
  const overlong = paragraphs
    .map((paragraph, index) => ({ index, length: paragraph.length, head: clip(paragraph, 30) }))
    .filter(item => item.length > pacingRule.paragraph.maxChars)
  if (overlong.length) {
    issues.push(toIssue({
      code: 'paragraph_too_long',
      dimension: '排版',
      grade: pacingRule.paragraph.severity,
      blocking: false,
      message: `发现 ${overlong.length} 个超长段（>${pacingRule.paragraph.maxChars} 字），最长 ${Math.max(...overlong.map(item => item.length))} 字`,
      quotes: overlong.map(item => `第${item.index + 1}段：${item.head}`),
      paragraphs: overlong.slice(0, 20).map(item => item.index + 1),
      fix: '拆段，一节动作一段',
      metrics: { count: overlong.length },
    }))
  }

  // 段落长度过于均匀（AI 会把长短句波峰波谷熨平）
  if (paragraphs.length >= pacingRule.uniformity.minParagraphs) {
    const lengths = paragraphs.map(paragraph => paragraph.length)
    const mean = lengths.reduce((sum, value) => sum + value, 0) / lengths.length
    const variance = lengths.reduce((sum, value) => sum + (value - mean) ** 2, 0) / lengths.length
    const stdDev = Math.sqrt(variance)
    const ratio = mean ? stdDev / mean : 0
    if (stdDev < pacingRule.uniformity.minStdDevChars || ratio < pacingRule.uniformity.minStdevToMeanRatio) {
      issues.push(toIssue({
        code: 'paragraph_uniformity',
        dimension: 'AI味',
        grade: pacingRule.uniformity.severity,
        blocking: false,
        message: `段落长度过于均匀：${paragraphs.length} 段，均值 ${mean.toFixed(0)} 字，标准差仅 ${stdDev.toFixed(1)}（波动率 ${(ratio * 100).toFixed(0)}%）`,
        fix: '刻意打乱节奏：插一句极短句，或让某段只写一个动作',
        metrics: { paragraphs: paragraphs.length, mean: Number(mean.toFixed(1)), stdDev: Number(stdDev.toFixed(1)), ratio: Number(ratio.toFixed(2)) },
      }))
    }
  }

  // 开篇钩子
  const head = text.slice(0, pacingRule.opening.hookWithinChars)
  const names = entityRule.characters.flatMap(character => [character.name, ...(character.aliases || [])])
  const hasName = names.some(name => name && head.includes(name))
  const hasDialogue = /[“”「」]/.test(head)
  if (!hasName && !hasDialogue) {
    issues.push(toIssue({
      code: 'opening_no_hook',
      dimension: '节奏',
      grade: pacingRule.opening.severity,
      blocking: false,
      message: `开篇 ${pacingRule.opening.hookWithinChars} 字内既无人物出场也无对话，疑似景物/设定开场`,
      quotes: [clip(head, 50)],
      fix: '把人物动作或异常提到前 300 字内',
      metrics: { hookChars: pacingRule.opening.hookWithinChars },
    }))
  }

  // 对话占比（默认停用：绝对阈值经语料校准证明无法适配不同作者）
  if (pacingRule.dialogueRatio.enabledByDefault !== false) {
    const dialogueCount = (text.match(/[“”]/g) || []).length / 2
    const ratio = chars ? dialogueCount / chars : 0
    if (chars > 500 && ratio < pacingRule.dialogueRatio.min) {
      issues.push(toIssue({
        code: 'dialogue_ratio_low',
        dimension: 'AI味',
        grade: pacingRule.dialogueRatio.severity,
        blocking: false,
        message: `对话句数仅 ${Math.round(dialogueCount)}，占比 ${(ratio * 100).toFixed(1)}%，疑似通篇叙述`,
        fix: '把部分信息改成对话给出',
        metrics: { dialogueCount: Math.round(dialogueCount), ratio: Number(ratio.toFixed(4)) },
      }))
    }
  }

  return issues
}

/**
 * 密度类指标（冒号 / 破折号 / 顿号）。
 *
 * 阈值一律来自**本书自身语料的 p95**，语义是「比自己平时写得密得多」，
 * 不是「比人类密」——这两种判定的阈值可以差好几倍。破折号就是活证据：
 * v6 引用的对照研究说 DeepSeek 破折号 5.16 次/千字、是人类的 3 倍，
 * 但本作真人语料中位数就有 3.89 次/千字，深度的绝对值落在本作中位数以下。
 */
const checkDensityMetrics = (text: string): WorkflowQualityIssue[] => {
  const issues: WorkflowQualityIssue[] = []
  const chars = countCJK(text)
  if (!chars) return issues

  for (const metric of style.densityMetrics || []) {
    const count = countOccurrences(text, metric.term)
    if (!count) continue
    const density = densityPer1000(count, chars)
    if (density <= metric.maxPer1000) continue
    issues.push(toIssue({
      code: metric.id,
      dimension: metric.dimension || 'AI味',
      grade: metric.severity,
      blocking: false,
      message: `${metric.label}：${density.toFixed(1)}/千字（共 ${count} 处 / ${chars} 字），超出本书阈值 ${metric.maxPer1000}/千字`,
      fix: `减少「${metric.term}」的使用，把其中一部分改成句号断句或直接叙述`,
      metrics: { density: Number(density.toFixed(1)), threshold: metric.maxPer1000, count, chars },
    }))
  }
  return issues
}

// ---------------------------------------------------------------------------
// 闸二·可数物件账本（数字连续性）—— 把「数字对不对得上」从 AI 手里拿回来
// ---------------------------------------------------------------------------
//
// 起因：第 5 章正文写「加上纸坊里那枚，共十一枚」，可全章只交代了 6~7 枚。
// 这类错误的性质是**算术**，不是理解 —— 交给人写也不会犯，交给 400 秒的大模型
// 反而是碰运气（实测两个直答型模型一条都没抓到）。所以下沉到本地账本：
//
//   生成前：describeArtifactLedger() 把「截至上一章共 N 枚」写进提示词 —— 预防；
//   生成后：checkArtifactBalance() 拿本章的累计声明与前账比对 —— 检测。
//
// 刻意保守（作者原则：宁可漏报不可过报）：
//   · 只在正文**明确说了「共 N」「合计 N」**时才比对，裸列举（「五枚铜钱。」）不参与；
//   · 「那五枚铜钱」这类**指代**一律跳过，避免同一批货被数两遍；
//   · 差量小于 tolerance 不报（容忍去重与省略带来的偏差）；
//   · 报出的语级是 P1 但 **blocking = false** —— 存疑提示，绝不拦停生成。

const CN_DIGIT: Record<string, number> = {
  '〇': 0, '零': 0, '一': 1, '二': 2, '两': 2, '三': 3,
  '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9,
}
const CN_UNIT: Record<string, number> = { '十': 10, '百': 100, '千': 1000 }
const CN_NUM_CLASS = '[〇零一二两三四五六七八九十百千0-9]+'
/** 数量前回看多远：够覆盖「一口气拾起五枚」这种短句，又不会跨句误判 */
const MENTION_WINDOW = 16
const REFERENCE_WORDS = /[那这此该其]/
/** 指代词只认**紧邻**数量词的那一个：「那五枚」算指代，「坊里那枚，共十一枚」不算 */
const REFERENCE_TAIL = 1

/** 中文/阿拉伯数字 → 数值。只认 0–9999 的常规写法，认不出的返回 null（宁可漏报） */
export const parseQuantityNumber = (raw: string): number | null => {
  const s = String(raw || '').trim()
  if (!s) return null
  if (/^\d+$/.test(s)) return Number(s)
  if (!/^[〇零一二两三四五六七八九十百千]+$/.test(s)) return null
  let section = 0
  let num = 0
  for (const ch of s) {
    if (ch in CN_DIGIT) {
      num = CN_DIGIT[ch]
      continue
    }
    const unit = CN_UNIT[ch]
    if (!unit) return null
    section += (num || 1) * unit
    num = 0
  }
  const total = section + num
  return total > 0 ? total : null
}

interface ArtifactMention {
  value: number
  kind: 'increment' | 'claim' | 'bare'
  evidence: string
}

/** 从一章正文里认出某个物件的全部数量声明，并分清「新增」还是「累计」 */
const scanArtifactMentions = (text: string, artifact: ArtifactRule, chapterNo: number): ArtifactMention[] => {
  if (artifact.fromChapter && chapterNo > 0 && chapterNo < artifact.fromChapter) return []
  const mentions: ArtifactMention[] = []
  // 量词必须限定为该物件自己的（04-artifacts.json 的 unit / units）：
  // 用全局量词表会把「共三十七封」（三十七封信）算到铜钱（枚）头上——语料实测踩过。
  const unitClass = (artifact.units?.length ? artifact.units : [artifact.unit]).join('')
  const quantityRe = new RegExp(`(${CN_NUM_CLASS})\\s*([${unitClass}])`, 'g')

  // A) 带物件名的：先定位物件名，再回看数量词
  for (const term of artifact.terms) {
    let from = 0
    for (;;) {
      const at = text.indexOf(term, from)
      if (at === -1) break
      from = at + term.length
      const back = text.slice(Math.max(0, at - MENTION_WINDOW), at)
      const found = [...back.matchAll(quantityRe)].pop()
      if (!found || found.index === undefined) continue
      const value = parseQuantityNumber(found[1])
      if (value === null) continue
      const before = back.slice(0, found.index)
      // 动词与累计标记只在**本小句**里找：不切句的话，
      // 「他拾起三枚铜钱。桌上散着七枚铜钱」会把前一句的「拾起」算到后一句的七枚头上
      const clause = before.split(/[。！？；\n]/).pop() || ''
      // 「那五枚铜钱」＝指代：不当作新增，但要记下数值，供后面的「章内自洽」判定
      const isReference = REFERENCE_WORDS.test(clause.slice(-REFERENCE_TAIL))
      const isClaim = !isReference && artifactCfg.totalMarkers.some(marker => clause.includes(marker))
      const isIncrement = !isReference && artifactCfg.incrementVerbs.some(verb => clause.includes(verb))
      mentions.push({
        value,
        kind: isClaim ? 'claim' : isIncrement ? 'increment' : 'bare',
        evidence: clip(text.slice(Math.max(0, at - MENTION_WINDOW), at + term.length + 4), 60),
      })
    }
  }

  // B) 不带物件名的累计声明（「共十一枚」）：只有该量词唯一归属本物件时才敢认，否则宁可不认
  const sameUnit = artifactCfg.artifacts.filter(item => item.unit === artifact.unit)
  if (sameUnit.length === 1) {
    const claimRe = new RegExp(`(${artifactCfg.totalMarkers.join('|')})\\s*(${CN_NUM_CLASS})\\s*[${unitClass}]`, 'g')
    for (const found of text.matchAll(claimRe)) {
      const matched = found[0]
      if (artifact.terms.some(term => matched.includes(term))) continue // A) 已认过，别数两遍
      const value = parseQuantityNumber(found[2])
      if (value === null) continue
      mentions.push({ value, kind: 'claim', evidence: clip(matched, 60) })
    }
  }
  return mentions
}

export interface ArtifactScanResult {
  /** 本章明确新增（带动词、非指代） */
  increment: number
  /** 本章明确声明的总数；没声明为 null */
  claim: number | null
  claimEvidence: string
  /** 本章出现过的全部数值（含裸列举与指代），用于「章内自洽」判定 */
  values: number[]
}

/** 扫一章正文，得出每个可数物件的（本章新增 / 本章累计声明） */
export const scanArtifactQuantities = (text: string, chapterNo: number): Record<string, ArtifactScanResult> => {
  const out: Record<string, ArtifactScanResult> = {}
  for (const artifact of artifactCfg.artifacts) {
    const mentions = scanArtifactMentions(text, artifact, chapterNo)
    if (!mentions.length) continue
    const claims = mentions.filter(item => item.kind === 'claim')
    out[artifact.key] = {
      increment: mentions.filter(item => item.kind === 'increment').reduce((sum, item) => sum + item.value, 0),
      claim: claims.length ? Math.max(...claims.map(item => item.value)) : null,
      claimEvidence: claims[0]?.evidence || '',
      values: [...new Set(mentions.filter(item => item.kind !== 'claim').map(item => item.value))],
    }
  }
  return out
}

/**
 * 生成前注入：告诉模型「截至上一章这些物件各有多少」。
 * 这是治本的一半 —— 所谓"生成前注入约束 ＞ 生成后检测"。
 */
export const describeArtifactLedger = (totals?: Record<string, number>): string => {
  if (!totals) return ''
  const lines = artifactCfg.artifacts
    .map(artifact => ({ artifact, count: Number(totals[artifact.key] || 0) }))
    .filter(item => item.count > 0)
    .map(item => `· ${item.artifact.label}：截至上一章共 ${item.count}${item.artifact.unit}`)
  if (!lines.length) return ''
  return [
    '【可数物件账本（写到这些物件时，数量必须与账本对得上）】',
    ...lines,
    '· 本章若有新增或消耗，正文里写「共 N」时 N 必须等于 账本数 ± 本章增减。',
    '· 算不清就别写具体数字（用「几枚」「一小把」这类模糊说法），宁可含糊也不要写错。',
  ].join('\n')
}

/** 生成后检测：本章的累计声明 vs（前账 ＋ 本章明确新增） */
export const checkArtifactBalance = (
  text: string,
  chapterNo: number,
  priorTotals?: Record<string, number>
): WorkflowQualityIssue[] => {
  // 没有前账就没有比对基准 —— 宁可不报，也不拿 0 当基准乱报
  if (!priorTotals) return []
  const issues: WorkflowQualityIssue[] = []
  const scans = scanArtifactQuantities(text, chapterNo)
  const tolerance = Math.max(1, Number(artifactCfg.tolerance) || 3)

  for (const artifact of artifactCfg.artifacts) {
    const scan = scans[artifact.key]
    if (!scan || scan.claim === null) continue
    const prior = Number(priorTotals?.[artifact.key] || 0)
    // 没有锚点就不判：前账为 0、本章也没明确新增，说明这个数从哪儿来完全无从谈起，
    // 报了也只是噪音（典型场景是从第 67 章开始接管一本书，前面 66 章没有账本）
    if (prior === 0 && scan.increment === 0) continue
    const expected = prior + scan.increment
    const gap = scan.claim - expected
    if (gap < tolerance) continue
    // 章内自洽优先：本章自己就列出过这个数值（哪怕是裸列举或指代），说明来源在本章内，
    // 账本没记上只是「获取动作没带取得动词」——这属于记漏，不是写错，不判。
    if (scan.values.includes(scan.claim)) continue
    issues.push(toIssue({
      code: `ARTIFACT-BALANCE-${artifact.key}`,
      dimension: '连续性',
      grade: artifact.severity || 'P1',
      blocking: false,
      message: `数量对不上存疑：本章称「${artifact.label}」共 ${scan.claim}${artifact.unit}，` +
        `账本按前文累计（前 ${prior} ＋ 本章明确新增 ${scan.increment}）只有 ${expected}${artifact.unit}，差 ${gap}。` +
        '若前文确有未计入的获取，本条可忽略',
      quotes: [scan.claimEvidence].filter(Boolean),
      fix: `核对${artifact.label}总数：补上前文获取的交代，或把数字改回 ${expected}${artifact.unit}`,
      metrics: { claim: scan.claim, prior, increment: scan.increment, expected, gap, tolerance },
    }))
  }
  return issues
}

/** 闸一总入口：对一章正文跑全部本地规则 */
export const lintChapterWithRules = (params: {
  text: string
  chapterNo: number
  targetWords?: number
  /**
   * 闸二账本里「截至上一章」各可数物件的累计数（fact-ledger 的 buildArtifactTotals）。
   * 不传则跳过数量平衡校验 —— 没有前账就没有比对基准，宁可不报。
   */
  artifactTotals?: Record<string, number>
}): WorkflowQualityIssue[] => {
  const text = String(params.text || '')
  if (!text.trim()) return []
  const order: Record<QualityGrade, number> = { P0: 0, P1: 1, P2: 2 }
  return [
    ...checkSpoilerBans(text, params.chapterNo),
    ...checkStyle(text),
    ...checkDensityMetrics(text),
    ...checkPacing(text, params.targetWords),
    ...checkArtifactBalance(text, params.chapterNo, params.artifactTotals),
  ].sort((a, b) => order[a.grade || 'P2'] - order[b.grade || 'P2'])
}

/** 级别计数，用于质检面板与「质量刻度」趋势 */
export const summarizeGrades = (issues: WorkflowQualityIssue[]) => ({
  P0: issues.filter(issue => issue.grade === 'P0').length,
  P1: issues.filter(issue => issue.grade === 'P1').length,
  P2: issues.filter(issue => issue.grade === 'P2').length,
})

export const qualityRulesMeta = {
  spoilerBanCount: spoiler.bans.length,
  stylePatternCount: style.patterns.length,
  templatePhraseCount: style.templatePhrases.length,
  densityMetricCount: (style.densityMetrics || []).length,
  behavioralPatternCount: (style.behavioralPatterns || []).length,
  artifactCount: artifactCfg.artifacts.length,
  chapters: entityRule.totalChapters,
  wordTarget: pacingRule.wordCount.target,
}

/** 供平台其余模块复用（字数口径与工作流保持一致） */
export const countChapterWords = (text: string) => countWords(text)
