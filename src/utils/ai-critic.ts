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

export interface CriticReviewFocus {
  /** 修复验收只允许审查这些段落（含平台补入的相邻段）。 */
  paragraphs: number[]
  /** 初审已经生成并实际执行的施工单。 */
  checklist: string
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

/** 从「第7段」「P25-P27」这类施工单目标提取稳定段号；范围异常时宁可不给坐标。 */
const paragraphsFromTarget = (target: string): number[] | undefined => {
  const match = String(target || '').match(/(?:第\s*)?(?:P\s*)?(\d+)\s*(?:[-–—至到]\s*(?:P\s*)?(\d+))?\s*段?/i)
  if (!match) return undefined
  const start = Number(match[1])
  const end = Number(match[2] || match[1])
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end - start > 20) return undefined
  return Array.from({ length: end - start + 1 }, (_, index) => start + index)
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
      // P0/P1 都是交付硬伤；P2 交给自动修复，但不单独阻断推进。
      severity: grade === 'P2' ? 'low' : 'high',
      blocking: grade !== 'P2',
      message: asText(holder.message),
      quotes: quote ? [quote] : undefined,
      paragraphs: order ? paragraphsFromTarget(order.target) : undefined,
      fix: order ? formatOrder(order) : '未给出施工单：请人工判断',
    })
  })

  return { issues, orders }
}

const FORBIDDEN_DIALOGUE_SYMBOLS = /[「」『』“”]/
const COLON_DIALOGUE = /(?:说|道|问|答|喊|开口|低声|小声|应声|接话)[^：:\n]{0,3}[：:]/
const FALSE_DIRECT_DIALOGUE_CLAIM = /(?:直接对话|独立成行.{0,12}(?:对话|对白|问句)|对白独立成段).{0,18}(?:违反|违背|禁止|禁用|硬规则)|(?:违反|违背|禁止|禁用|硬规则).{0,18}(?:直接对话|独立成行.{0,12}(?:对话|对白|问句)|对白独立成段)/

/**
 * AI 审查者偶尔会把“对白独立成段”误读成“禁止直接对白”，甚至把自己用于引用的
 * 「」当成正文符号。平台以原文为证：原文没有禁用引号或冒号对白时，这类指控不成立。
 */
export const filterUnsupportedCriticIssues = (
  issues: WorkflowQualityIssue[],
  chapterText: string,
): WorkflowQualityIssue[] => {
  const text = String(chapterText || '')
  const hasForbiddenDialogueFormat = FORBIDDEN_DIALOGUE_SYMBOLS.test(text) || COLON_DIALOGUE.test(text)
  if (hasForbiddenDialogueFormat) return issues
  return issues.filter(issue => !FALSE_DIRECT_DIALOGUE_CLAIM.test(String(issue.message || '')))
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
  /** 与写正文同一份素材；包含下一章边界，供审查者判断本章是否越界。 */
  materials: Record<string, string>
  /** 有值时进入“封闭验收”，不能把复审变成新一轮自由审稿。 */
  reviewFocus?: CriticReviewFocus
  signal?: AbortSignal
}): Promise<CriticReport> => {
  const chapterText = String(params.chapterText || '').trim()
  if (!chapterText) {
    return { status: 'unavailable', issues: [], orders: [], error: '本章正文为空，跳过 AI 评审' }
  }

  const materials: Record<string, string> = {}
  for (const [key, value] of Object.entries(params.materials || {})) {
    if (!String(value || '').trim()) continue
    materials[key] = value
  }

  try {
    const messages = buildChapterCriticMessages({ materials, chapterText })
    const focusParagraphs = [...new Set((params.reviewFocus?.paragraphs || [])
      .filter(no => Number.isInteger(no) && no > 0))].sort((a, b) => a - b)
    if (params.reviewFocus) {
      const last = messages[messages.length - 1]
      last.content = [
        last.content,
        [
          '【本次任务是修复验收，不是重新审稿】',
          '只核验下列施工单是否已消除，以及修复处或紧邻段落是否产生了直接的 P0/P1 硬伤。',
          '禁止提出初审中没有出现、且与本轮修复没有直接因果关系的新审美意见；禁止把同一问题换一种说法重复立项。',
          '范围外问题一律不要返回。若施工单已完成且没有直接硬伤，issues 必须返回空数组。',
          '返回问题时，order.target 必须写成准确的 P数字 或 P数字-P数字，并且只能落在验收范围内。',
          `【验收范围】${focusParagraphs.length ? focusParagraphs.map(no => `P${no}`).join('、') : '仅核验原施工单，不扩展新问题'}`,
          `【原施工单】\n${params.reviewFocus.checklist || '无'}`,
        ].join('\n'),
      ].join('\n\n')
    }
    // 走流式：非流式那 60 秒网关硬超时会把思考型模型整个挡在门外，
    // 而评审恰恰是「宁可多想几秒、也要挑对」的场景。
    const raw = await requestLocalChatCompletionStreaming({
      modelCode: params.modelCode,
      scene: 'workflow_critic',
      sceneLabel: '自检·AI 评审',
      temperature: promptTemperature('workflow-writer', 'criticSystem'),
      maxTokens: CRITIC_MAX_TOKENS,
      signal: params.signal,
      messages,
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

    const converted = toCriticIssues(parsed.issues)
    const issues = filterUnsupportedCriticIssues(converted.issues, chapterText)
    const orders = converted.orders
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

/**
 * 修复验收的第二道硬边界：即使模型无视提示词重新挑遍全章，平台也只接收
 * 命中本轮验收段落的问题。没有段号的问题不可精准施工，同样不得开启新一轮修复。
 */
export const scopeCriticReportToParagraphs = (
  report: CriticReport,
  paragraphs: number[],
): CriticReport => {
  if (report.status !== 'available') return report
  const allowed = new Set((paragraphs || []).filter(no => Number.isInteger(no) && no > 0))
  const issues = report.issues.filter(issue =>
    (issue.paragraphs || []).some(no => allowed.has(no))
  )
  return {
    ...report,
    issues,
    // orders 只供初审施工使用；验收不会再拿模型的自由文本直接开工。
    orders: [],
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
  const gateIssues: WorkflowQualityIssue[] = []
  if (report.status !== 'available') {
    gateIssues.push({
      source: 'critic',
      code: 'CRITIC-UNAVAILABLE',
      dimension: 'AI审查',
      grade: 'P0',
      severity: 'high',
      blocking: true,
      message: report.error || 'AI审查未返回完整结果，不能确认本章合格',
      fix: '未给出施工单：重新运行AI审查，审查成功前不得放行',
    })
  } else {
    const scores = report.scores || {}
    const missing = DIMENSIONS.filter(dimension => !Number.isFinite(scores[dimension]))
    const low = DIMENSIONS.filter(dimension => Number.isFinite(scores[dimension]) && scores[dimension] < 8)
    if (missing.length) {
      gateIssues.push({
        source: 'critic',
        code: 'CRITIC-SCORES-MISSING',
        dimension: 'AI审查',
        grade: 'P1',
        severity: 'high',
        blocking: true,
        message: `AI审查缺少评分维度：${missing.join('、')}`,
        fix: '未给出施工单：重新运行AI审查并补齐全部评分维度',
      })
    }
    if (low.length) {
      gateIssues.push({
        source: 'critic',
        code: 'CRITIC-SCORE-BELOW-8',
        dimension: '综合质量',
        grade: 'P2',
        severity: 'low',
        blocking: false,
        message: `以下维度低于8分：${low.map(dimension => `${dimension}${scores[dimension]}分`).join('、')}`,
        fix: '未给出施工单：低分仅作润色提示，必须由具体问题定位后才自动修改',
      })
    }
  }
  const issues = [...notice.issues, ...report.issues, ...gateIssues]
    .sort((a, b) => gradeRank(a.grade) - gradeRank(b.grade))
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
