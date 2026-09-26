import type { WorkflowQualityIssue, WorkflowQualityNotice } from '@/types/workflow'
import { scanSensitiveText } from '@/storage/local-sensitive-words'
import type { LocalChapter } from '@/storage/local-library-types'
import { buildArtifactTotals } from '@/utils/fact-ledger'
import { lintChapterWithRules, summarizeGrades } from '@/utils/quality-rules'
import { countWords } from '@/utils/word-count'

/**
 * 逐章生文的本地规则质检（服务端"规则 + AI 评审"双轨里的规则轨 = 自检三闸的「闸一」）。
 *
 * 开源版不跑 AI 评审（每章多一次付费调用，收益不稳），critic 如实标 unavailable，
 * 只把规则轨的结果按 P0/P1/P2 分级报出来；AI 评审（闸三）由外部工具接 DeepSeek 补上。
 * 规则收得很紧：只拦"明显写坏了"的硬伤（字数严重不足、整段复读、**剧透红线越界**），
 * 敏感词、字数偏多、AI 味词表只作提示不拦截——拦截意味着生成停机等确认，误拦比漏报更伤。
 *
 * 规则数据来自 src/config/quality-rules/*.json，与生成前的提示词注入（quality-rules.ts）
 * 共用同一份，保证「写之前告诉模型什么不能写」和「写完之后检查有没有违规」口径一致。
 */

const WORD_LOW_BLOCK_RATIO = 0.55
const WORD_HIGH_NOTICE_RATIO = 1.7
const REPEAT_MIN_PARAGRAPH_CHARS = 16
const QUOTE_MAX = 3
const QUOTE_SLICE = 60

const clipQuote = (value: string) => {
  const text = String(value || '').trim()
  return text.length > QUOTE_SLICE ? `${text.slice(0, QUOTE_SLICE)}…` : text
}

const checkWordCount = (words: number, targetWords: number): WorkflowQualityIssue[] => {
  if (!targetWords) return []
  if (words < Math.round(targetWords * WORD_LOW_BLOCK_RATIO)) {
    return [{
      source: 'rule',
      code: 'word_count_low',
      dimension: '篇幅',
      message: `本章只有 ${words} 字，明显低于目标 ${targetWords} 字，疑似生成中断或提前收尾`,
      severity: 'high',
      blocking: true,
      fix: '可选择"重写本章"补足剧情，或人工补写后接受',
      metrics: { wordCount: words, targetWords },
    }]
  }
  if (words > Math.round(targetWords * WORD_HIGH_NOTICE_RATIO)) {
    return [{
      source: 'rule',
      code: 'word_count_high',
      dimension: '篇幅',
      message: `本章 ${words} 字，超出目标 ${targetWords} 字较多，节奏可能偏拖`,
      severity: 'low',
      blocking: false,
      metrics: { wordCount: words, targetWords },
    }]
  }
  return []
}

const checkParagraphRepeat = (text: string): WorkflowQualityIssue[] => {
  const seen = new Map<string, number>()
  const repeated: string[] = []
  for (const raw of String(text || '').split(/\n+/)) {
    const paragraph = raw.trim()
    if (paragraph.length < REPEAT_MIN_PARAGRAPH_CHARS) continue
    const count = (seen.get(paragraph) || 0) + 1
    seen.set(paragraph, count)
    if (count === 2) repeated.push(paragraph)
  }
  if (!repeated.length) return []
  return [{
    source: 'rule',
    code: 'paragraph_repeat',
    dimension: '重复',
    message: `发现 ${repeated.length} 处整段重复内容，正文疑似复读`,
    severity: 'high',
    blocking: true,
    quotes: repeated.slice(0, QUOTE_MAX).map(clipQuote),
    fix: '建议"重写本章"，或手动删去重复段后接受',
  }]
}

const checkSensitiveWords = (text: string): WorkflowQualityIssue[] => {
  const result = scanSensitiveText(text)
  if (!result.hasSensitive) return []
  const top = result.matches.slice(0, 5)
  const quotes: string[] = []
  for (const item of top) {
    if (quotes.length >= QUOTE_MAX) break
    const index = text.indexOf(item.word)
    if (index === -1) continue
    quotes.push(clipQuote(text.slice(Math.max(0, index - 12), index + item.word.length + 24)))
  }
  return [{
    source: 'rule',
    code: 'sensitive_words',
    dimension: '敏感词',
    message: `命中本地敏感词 ${result.total} 处：${top.map(item => `${item.word}×${item.count}`).join('、')}`,
    severity: 'low',
    blocking: false,
    quotes,
    fix: '发布前可在编辑器里用敏感词检查逐处替换',
  }]
}

const gradeRank = (grade?: string) => (grade === 'P0' ? 0 : grade === 'P1' ? 1 : 2)

export const runLocalChapterQualityCheck = (params: {
  chapterId: number
  chapterNo: number
  chapterTitle: string
  text: string
  targetWords: number
  contentVersion: number
  modelCode?: string
  /**
   * 全书按序章列表：用来从闸二账本里取「截至上一章各可数物件的累计数」。
   * 账本读的是各章 planMeta 缓存，**同步**即可，不需要 await。
   * 不传就跳过数量平衡校验（没有前账就没有比对基准）。
   */
  orderedChapters?: LocalChapter[]
}): WorkflowQualityNotice => {
  const words = countWords(params.text)
  const baseIssues = [
    ...checkWordCount(words, params.targetWords),
    ...checkParagraphRepeat(params.text),
    ...checkSensitiveWords(params.text),
  ]

  // 闸一扩展：剧透红线按章排期、AI 味词表/句式、节奏与开篇钩子。
  // 与生成前注入用的是同一份规则 JSON，所以「模型被要求别写」和「写完被判违规」是同一套标准。
  const artifactTotals = params.orderedChapters
    ? buildArtifactTotals(params.orderedChapters, params.chapterNo)
    : undefined
  const ruleIssues = lintChapterWithRules({
    text: params.text,
    chapterNo: params.chapterNo,
    targetWords: params.targetWords,
    artifactTotals,
  })

  // 两套规则会有同名 code（字数、敏感词），按 code 去重且基础规则优先，避免面板里同一问题报两遍。
  const seenCodes = new Set<string>()
  const issues = [...baseIssues, ...ruleIssues]
    .filter(issue => {
      if (seenCodes.has(issue.code)) return false
      seenCodes.add(issue.code)
      return true
    })
    .sort((a, b) => gradeRank(a.grade) - gradeRank(b.grade))

  const grades = summarizeGrades(issues)
  const hasGradeHit = grades.P0 + grades.P1 + grades.P2 > 0

  return {
    version: 1,
    requiresAction: issues.some(issue => issue.blocking),
    chapterId: params.chapterId,
    chapterNo: params.chapterNo,
    chapterTitle: params.chapterTitle,
    issues,
    wordCount: words,
    contentVersion: params.contentVersion,
    modelCode: params.modelCode,
    createdAt: new Date().toISOString(),
    critic: {
      status: 'unavailable',
      error: hasGradeHit
        ? `开源版未接入 AI 评审；本地规则轨已跑：P0 ${grades.P0} / P1 ${grades.P1} / P2 ${grades.P2}（共 ${issues.length} 项）`
        : '开源版暂未接入 AI 评审，仅做规则检查；本章本地规则零命中',
    },
  }
}
