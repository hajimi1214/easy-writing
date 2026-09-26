/**
 * 闸三 · 施工单自动修复执行器
 * ---------------------------------------------------------------------------
 * 输入是质检结果（闸一规则问题 + 闸三 AI 问题），输出是一份定向改写后的正文。
 *
 * 为什么不是"按条逐项外科手术"：施工单里的「补」天生要写新句子，靠字符串替换做不出来；
 * 而逐条替换要维护一套脆弱的定位器（第几段第几句在改写后立刻失效）。
 * 所以走**一次性定向重写**：把所有施工单汇成一份指令，让模型只动被指到的地方，
 * 其余逐字保留 —— 一次调用解决全部问题，且定位由模型自己读上下文完成。
 *
 * 分工说明：本模块只管「问题清单 → 新正文」，**不落库、不加锁**。
 * 修复前快照与写回由调用方（local-workflow-writer）负责，
 * 复用已有的正文写入通道与章节版本表。
 */
import type { WorkflowQualityIssue } from '@/types/workflow'
import { buildChapterFixMessages } from '@/config/workflow-prompts'
import { requestLocalChatCompletionStreaming } from '@/utils/local-ai-client'
import { promptTemperature } from '@/storage/local-prompts'
import { countWords } from '@/utils/word-count'

/** 只修这两级：P2（AI 味/排版）自动改的收益低于改坏的风险，交人工或后续回合 */
const FIXABLE_GRADES = ['P0', 'P1']
/** 改写后字数允许的漂移区间：出界说明模型在大改，宁可判失败让人来看 */
const MIN_LENGTH_RATIO = 0.7
const MAX_LENGTH_RATIO = 1.5
/** 一次最多带多少条施工单，防止指令过长把正文挤掉 */
const MAX_ORDERS = 30

const asText = (value: unknown) => String(value ?? '').trim()
const paragraphsOf = (text: string) => String(text || '').split(/\n+/).map(line => line.trim()).filter(Boolean)

export interface FixOrderLine {
  index: number
  source: '规则' | 'AI评审'
  grade: string
  dimension: string
  message: string
  action: string
  /** 规则命中时给出的正文原句，供改写时定位 */
  anchor?: string
}

/** 挑出可执行的修复项：必须带动作说明，且落在 P0/P1 */
export const selectFixableIssues = (issues: WorkflowQualityIssue[]): WorkflowQualityIssue[] =>
  (issues || []).filter(issue => {
    const grade = issue.grade || 'P2'
    if (!FIXABLE_GRADES.includes(grade)) return false
    const fix = asText(issue.fix)
    if (!fix || fix.startsWith('未给出施工单')) return false
    return true
  })

/** 问题清单 → 施工单汇总文本（这就是喂给改写模型的指令本体） */
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
    }))

export const buildFixOrderText = (issues: WorkflowQualityIssue[]): string =>
  buildFixOrderLines(issues)
    .map(line => {
      const head = `${line.index}. [${line.source}·${line.grade}·${line.dimension}] ${line.message}`
      const anchor = line.anchor ? `\n   命中原句：${line.anchor}` : ''
      return `${head}${anchor}\n   执行：${line.action}`
    })
    .join('\n')

export interface FixDiff {
  beforeWords: number
  afterWords: number
  wordDelta: number
  addedParagraphs: number
  removedParagraphs: number
  keptParagraphs: number
  /** 被替换掉的段落开头，用于人工快速扫一眼"哪些地方动过" */
  changedSamples: string[]
}

/**
 * 粗粒度 diff：按段落做集合比对。
 * 不追求精确的行级差异——目的是让作者一眼看出"动了几处、动在哪"，
 * 真正的取舍靠人读那几段原文/新文。
 */
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

export interface FixRewriteResult {
  ok: boolean
  text: string
  orderCount: number
  diff?: FixDiff
  error?: string
}

const clip = (value: string, max = 120) => (value.length > max ? `${value.slice(0, max)}…` : value)

/**
 * 按施工单定向重写一章。不落库——调用方拿到 text 后自行决定 dry-run 还是应用。
 * 任何异常都收敛成 ok:false，不抛给生成主流程。
 */
export const runChapterFixRewrite = async (params: {
  modelCode: string
  materials: Record<string, string>
  chapterText: string
  issues: WorkflowQualityIssue[]
  signal?: AbortSignal
}): Promise<FixRewriteResult> => {
  const chapterText = String(params.chapterText || '')
  const orderText = buildFixOrderText(params.issues)
  const orderCount = buildFixOrderLines(params.issues).length

  if (!orderCount) return { ok: false, text: chapterText, orderCount: 0, error: '没有可执行的施工单' }
  if (!chapterText.trim()) return { ok: false, text: chapterText, orderCount, error: '本章正文为空' }

  try {
    // 与闸三评审同因改走流式：改写一章的输出比评审更长，非流式的 60 秒超时更容易踩。
    const raw = await requestLocalChatCompletionStreaming({
      modelCode: params.modelCode,
      scene: 'workflow_fix',
      sceneLabel: '自检·施工单修复',
      temperature: promptTemperature('workflow-writer', 'fixSystem'),
      // 与评审同理：改写整章的输出更长，思考型模型还要额外花思维链预算，给足。
      maxTokens: 32_000,
      signal: params.signal,
      messages: buildChapterFixMessages({ materials: params.materials, chapterText, order: orderText }),
    })

    const text = String(raw || '')
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .replace(/^```(?:\w+)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim()

    if (!text) return { ok: false, text: chapterText, orderCount, error: '改写结果为空' }

    const beforeWords = countWords(chapterText)
    const afterWords = countWords(text)
    const ratio = beforeWords ? afterWords / beforeWords : 1
    if (ratio < MIN_LENGTH_RATIO || ratio > MAX_LENGTH_RATIO) {
      return {
        ok: false,
        text: chapterText,
        orderCount,
        error: `改写后字数 ${afterWords}，与原文 ${beforeWords} 相差过大（${Math.round(ratio * 100)}%），疑似整章重写，已放弃自动应用`,
      }
    }

    return { ok: true, text, orderCount, diff: summarizeFixDiff(chapterText, text) }
  } catch (error) {
    return {
      ok: false,
      text: chapterText,
      orderCount,
      error: `修复调用失败：${clip(String((error as Error)?.message || error))}`,
    }
  }
}
