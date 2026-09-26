/**
 * 闸三 · AI 评审轨（DeepSeek 等，每章一次调用，可关）
 * ---------------------------------------------------------------------------
 * 闸一（规则）能确定性地抓"字面问题"，但抓不到"这段因果不成立""这个人物不该知道这件事"。
 * 这类判断只能靠语义，所以交给模型做——但**必须结构化**，不能让它写一篇读后感。
 *
 * 输出契约：§13 十维度 → scores（各维度 0-10 分）＋ issues（每条带 grade 与施工单）。
 * ⑩「修改施工单」就是自动修复的可执行指令：op（改/删/补/换/移/合并）＋ target ＋ detail。
 * 同一份素材既喂作者也喂审查者——审查者拿不到设定，就只能挑"文笔不够好"这种废话。
 *
 * 与闸一的关系：结果合并进同一个 WorkflowQualityNotice.issues（source:'critic'），
 * 复用现有质检面板，不需要新 UI。critic 字段则承载原来的评分与状态。
 */
import type { WorkflowQualityIssue, WorkflowQualityNotice } from '@/types/workflow'
import { buildChapterCriticMessages } from '@/config/workflow-prompts'
import { parseAiJson } from '@/utils/ai-json'
import { requestLocalChatCompletionStreaming } from '@/utils/local-ai-client'
import { promptTemperature } from '@/storage/local-prompts'

export type CriticGrade = 'P0' | 'P1' | 'P2'

/** 允许的维度：与 §13 十维度对齐（⑩ 施工单是"动作"，不单独成一个维度） */
const DIMENSIONS = ['逻辑', '时间线', '空间', '设定红线', '人物一致', '连续性', 'AI味', '情绪落点', '节奏钩子'] as const
/** 施工单只认这六个动词，与 §13 一致 */
const ORDER_OPS = ['改', '删', '补', '换', '移', '合并'] as const

const QUOTE_MAX = 40

/**
 * 评审的 token 上限。
 *
 * 这里必须给足：`buildChatBody` 对非流式请求只兜底到 2048（见 local-ai-client.ts 的
 * NON_STREAM_MIN_TOKENS），而思考型模型会把预算**全部**烧在思维链上 —— 实测 glm-5.1 /
 * glm-5.3 / minimax-m2.7 / mimo-v2.5-pro 在 4000 下全部返回 `finish_reason: "length"`
 * 且 content 为空，评审直接落「无法解析为 JSON」。
 *
 * 「思考型模型太慢」这条也已不适用：评审改走**流式**后（见下方 runChapterCritic），
 * 网关那条约 60 秒的**非流式**硬超时不再卡它，慢思考模型（glm / kimi / seed 等）全部解锁。
 * 实测同一个 glm-5.1：非流式 60 秒被 504 掐断，流式 79 秒完整收完。
 *
 * 作者已明确「可以用厉害一点的模型，不用考虑 token」——所以这里放开给足。
 * 上限只是**护栏**（防跑飞），不是目标长度，模型不会因为上限高就多写；
 * 最贵的 deepseek-v4-pro-0813 输出 ¥27/百万 token，这个上限拉满也就几毛钱一章。
 */
const CRITIC_MAX_TOKENS = 32_000

export interface CriticOrder {
  op: string
  target: string
  detail: string
}

export interface CriticIssue {
  dimension: string
  grade: CriticGrade
  message: string
  quote?: string
  order?: CriticOrder
}

export interface CriticReport {
  status: 'available' | 'partial' | 'unavailable'
  /** 已转成平台通用契约的问题（source:'critic'） */
  issues: WorkflowQualityIssue[]
  scores?: Record<string, number>
  summary?: string
  /** 施工单文本行：喂给修复执行器 */
  orders: string[]
  error?: string
}

const asText = (value: unknown) => String(value ?? '').trim()
const clip = (value: string, max = 60) => (value.length > max ? `${value.slice(0, max)}…` : value)

/** 模型的 grade 可能写成 p0/P0/P0 级，统一收敛；认不出就按最低级处理，宁可轻判不误拦 */
const normalizeGrade = (raw: unknown): CriticGrade => {
  const text = asText(raw).toUpperCase()
  if (text.includes('P0')) return 'P0'
  if (text.includes('P1')) return 'P1'
  return 'P2'
}

/** 维度写歪了就按关键词归位，归不上就标"其他"，不让一条脏数据毁掉整份报告 */
const normalizeDimension = (raw: unknown): string => {
  const text = asText(raw)
  const hit = DIMENSIONS.find(dimension => text.includes(dimension))
  if (hit) return hit
  if (/ai|味/i.test(text)) return 'AI味'
  return '其他'
}

const normalizeOrder = (raw: unknown): CriticOrder | undefined => {
  const holder = (raw ?? {}) as { op?: unknown; target?: unknown; detail?: unknown }
  const op = ORDER_OPS.find(item => asText(holder.op).includes(item))
  const target = asText(holder.target)
  const detail = asText(holder.detail)
  if (!op || !detail) return undefined
  return { op, target: target || '未指明位置', detail }
}

/** 施工单 → 一行可执行指令；没有合法 op 就不生成施工单（空话不算问题） */
const formatOrder = (order: CriticOrder) => `${order.op}：${order.target} → ${order.detail}`

const normalizeScores = (raw: unknown): Record<string, number> | undefined => {
  if (!raw || typeof raw !== 'object') return undefined
  const result: Record<string, number> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const num = Number(value)
    if (Number.isFinite(num)) result[asText(key)] = Math.min(10, Math.max(0, Math.round(num * 10) / 10))
  }
  return Object.keys(result).length ? result : undefined
}

/** 把模型的 issues 数组转成平台契约。index 参与 code，避免同维度多条被去重吃掉 */
export const toCriticIssues = (raw: unknown): { issues: WorkflowQualityIssue[]; orders: string[] } => {
  const list = Array.isArray(raw) ? raw : []
  const issues: WorkflowQualityIssue[] = []
  const orders: string[] = []

  list.forEach((item, index) => {
    const holder = (item ?? {}) as Record<string, unknown>
    const message = asText(holder.message)
    if (!message) return
    const dimension = normalizeDimension(holder.dimension)
    const grade = normalizeGrade(holder.grade)
    const quote = asText(holder.quote).slice(0, QUOTE_MAX)
    const order = normalizeOrder(holder.order)
    if (order) orders.push(`(-${index + 1}) [${dimension}·${grade}] ${formatOrder(order)}`)

    issues.push({
      source: 'critic',
      code: `CRITIC-${dimension}-${index + 1}`,
      dimension,
      grade,
      // P2 不阻断：AI 评审本身有主观性，拿它停机等确认比漏报更伤
      severity: grade === 'P2' ? 'low' : 'high',
      blocking: grade === 'P0',
      message: asText(holder.message),
      quotes: quote ? [quote] : undefined,
      fix: order ? formatOrder(order) : '未给出施工单：请人工判断',
    })
  })

  return { issues, orders }
}

/**
 * 跑一次本章 AI 评审。
 * 任何失败（模型没配、超时、JSON 解析不了）都收敛成 status:'unavailable'，绝不抛给生成主流程。
 */
export const runChapterCritic = async (params: {
  modelCode: string
  chapterNo: number
  chapterTitle: string
  chapterText: string
  /** 与写正文同一份素材；其中"下一章章纲"要剔除——它是给作者的衔接提示，不该拿它挑本章的错 */
  materials: Record<string, string>
  signal?: AbortSignal
}): Promise<CriticReport> => {
  const chapterText = String(params.chapterText || '').trim()
  if (!chapterText) {
    return { status: 'unavailable', issues: [], orders: [], error: '本章正文为空，跳过 AI 评审' }
  }

  const materials: Record<string, string> = {}
  for (const [key, value] of Object.entries(params.materials || {})) {
    if (key.startsWith('下一章章纲')) continue
    if (!String(value || '').trim()) continue
    materials[key] = value
  }

  try {
    // 走流式：非流式那 60 秒网关硬超时会把思考型模型整个挡在门外，
    // 而评审恰恰是「宁可多想几秒、也要挑对」的场景。
    const raw = await requestLocalChatCompletionStreaming({
      modelCode: params.modelCode,
      scene: 'workflow_critic',
      sceneLabel: '自检·AI 评审',
      temperature: promptTemperature('workflow-writer', 'criticSystem'),
      maxTokens: CRITIC_MAX_TOKENS,
      signal: params.signal,
      messages: buildChapterCriticMessages({ materials, chapterText }),
    })

    const parsed = parseAiJson(raw, ['issues']) as Record<string, unknown> | null
    if (!parsed || typeof parsed !== 'object') {
      return {
        status: 'unavailable',
        issues: [],
        orders: [],
        error: 'AI 评审返回无法解析为 JSON（若用的是思考型模型，多半是 token 预算被思维链吃光、正文为空；换直答型模型更稳）',
      }
    }

    const { issues, orders } = toCriticIssues(parsed.issues)
    const scores = normalizeScores(parsed.scores)
    const summary = asText(parsed.summary) || undefined
    // 有评分但一条问题都没挑出来 = 正常；连结构都没给对才叫 partial
    const status: CriticReport['status'] = scores || Array.isArray(parsed.issues) ? 'available' : 'partial'

    return { status, issues, scores, summary, orders }
  } catch (error) {
    return {
      status: 'unavailable',
      issues: [],
      orders: [],
      error: `AI 评审未完成：${clip(String((error as Error)?.message || error), 120)}`,
    }
  }
}

const gradeRank = (grade?: string) => (grade === 'P0' ? 0 : grade === 'P1' ? 1 : 2)

/**
 * 把评审结果并进规则轨的质检通知：同一个 issues 数组、同一套 P0/P1/P2 排序，
 * 现有质检面板不用改一行就能显示 AI 挑出来的问题。
 */
export const mergeCriticReport = (
  notice: WorkflowQualityNotice,
  report: CriticReport
): WorkflowQualityNotice => {
  const issues = [...notice.issues, ...report.issues].sort((a, b) => gradeRank(a.grade) - gradeRank(b.grade))
  return {
    ...notice,
    issues,
    requiresAction: issues.some(issue => issue.blocking),
    critic: {
      status: report.status,
      scores: report.scores,
      error: report.error || report.summary,
    },
  }
}
