import type {
  UserAiModelSavePayload,
  UserAiModelTestResult,
  UserAiRemoteModelListResult,
} from '@/types/user-ai-model'
import { createThinkStreamFilter, stripThinkBlocks } from '@/utils/ai-think-filter'
import { getLocalAiModelSecret, localAiModelCode, type LocalAiModel } from '@/storage/local-ai-models'
import { appendLocalAiRecord, estimateTokens } from '@/storage/local-ai-records'
import { isTauriRuntime } from '@/storage'

/**
 * BYOK 直连请求层（OpenAI 兼容协议）：密钥只在本机内存/存储流转，请求直发供应商。
 *
 * - 桌面端走 @tauri-apps/plugin-http 的 fetch（不受浏览器跨域限制）。
 * - 网页端走浏览器 fetch：部分供应商允许浏览器直连，不允许的会被浏览器拦下，
 *   报错文案会提示改用桌面版。
 */

const REQUEST_TIMEOUT_MS = 20000

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

const resolveAiFetch = async (): Promise<FetchLike> => {
  if (isTauriRuntime()) {
    const { fetch: tauriFetch } = await import('@tauri-apps/plugin-http')
    return tauriFetch as unknown as FetchLike
  }
  return window.fetch.bind(window)
}

/** 阿里 dashscope 接口：思考型千问模型走非流式必须显式关思考，否则服务端直接 400
 *（官方要求 enable_thinking=false 或改用流式；按 baseUrl 判断，自定义填法也能盖住） */
const isDashScope = (baseUrl: string) => String(baseUrl || '').includes('aliyuncs.com')

// OpenAI 官方接口的两个换代差异（其余兼容渠道仍认老字段）：
// token 上限字段改名 max_completion_tokens；推理系（o*/gpt-5*）只认默认温度
const isOpenAiOfficial = (baseUrl: string) => String(baseUrl || '').includes('api.openai.com')
const isOpenAiReasoningModel = (modelCode: string) => /^(o\d|gpt-5)/i.test(String(modelCode || '').trim())

// 非流式最少给足 2048 token 上限：思考型模型（Gemini flash、DeepSeek flash 等）把
// 思考计入输出上限，预算太小会被思考吃光，拿回空正文或半截 JSON（实测 1024 仍不够）；
// 上限只是护栏，普通模型不会因此多产出
const NON_STREAM_MIN_TOKENS = 2048

/**
 * 被上游拒过温度参数的模型（存 `modelCode`）。
 *
 * 有些思考型模型硬性要求 temperature = 1.0：实测 kimi-k3 开启思考时收到 0.2 直接回
 * `400 invalid temperature: must be 1.0 when thinking is enabled`。而平台提示词库按场景
 * 配了温度（评审 0.2、正文 0.82），两者天生打架。
 *
 * 这里刻意**不维护一张「挑食模型」名单** —— 名单永远追不上新模型。改成让上游自己说：
 * 它一报温度错，就记住这个模型、摘掉温度重来一次；此后该模型的请求一律不再带温度。
 */
const temperatureRejectedModels = new Set<string>()

/** 上游在抱怨温度、且本次确实带了温度 → 值得摘掉温度重试（顺带记住这个模型） */
const rememberTemperatureRejection = (
  modelCode: string,
  message: string,
  temperature?: number
): boolean => {
  const code = String(modelCode || '').trim()
  if (!code || temperature === undefined) return false
  if (!/temperature/i.test(message)) return false
  temperatureRejectedModels.add(code)
  return true
}

/** 按供应商差异拼 chat/completions 请求体：三家怪癖集中在这一处 */
export const buildChatBody = (params: {
  baseUrl: string
  modelCode: string
  messages: LocalChatMessageInput[]
  maxTokens?: number
  temperature?: number
  stream: boolean
}): Record<string, unknown> => {
  const body: Record<string, unknown> = {
    model: params.modelCode,
    messages: params.messages,
    stream: params.stream,
  }
  const maxTokens = params.stream
    ? params.maxTokens
    : params.maxTokens
      ? Math.max(params.maxTokens, NON_STREAM_MIN_TOKENS)
      : undefined
  if (maxTokens) {
    body[isOpenAiOfficial(params.baseUrl) ? 'max_completion_tokens' : 'max_tokens'] = maxTokens
  }
  const dropTemperature =
    (isOpenAiOfficial(params.baseUrl) && isOpenAiReasoningModel(params.modelCode)) ||
    temperatureRejectedModels.has(String(params.modelCode || '').trim())
  if (params.temperature !== undefined && !dropTemperature) {
    body.temperature = params.temperature
  }
  // 阿里 dashscope：思考型千问走非流式必须显式关思考，否则服务端直接 400
  if (!params.stream && isDashScope(params.baseUrl)) {
    body.enable_thinking = false
  }
  return body
}

/** baseUrl 与端点拼接：只负责去重斜杠，版本段（/v1 等）以用户填写为准 */
export const joinAiUrl = (baseUrl: string, path: string) =>
  `${String(baseUrl || '').trim().replace(/\/+$/, '')}/${String(path).replace(/^\/+/, '')}`

/** 把测试/拉取用的载荷补齐配置：字段留空且带 id 时回查本地存储。
 *  覆盖两种调用：编辑表单（密钥留空=不修改）与列表行内测试（只传 id）。 */
const resolveRequestConfig = (payload: Partial<UserAiModelSavePayload>) => {
  let baseUrl = String(payload.baseUrl || '').trim()
  let apiKey = String(payload.apiKey || '').trim()
  let modelCode = String(payload.modelCode || '').trim()
  if (payload.id != null && (!apiKey || !baseUrl || !modelCode)) {
    const stored = getLocalAiModelSecret(localAiModelCode(payload.id))
    if (stored) {
      if (!apiKey) apiKey = stored.apiKey || ''
      if (!baseUrl) baseUrl = String(stored.baseUrl || '').trim()
      if (!modelCode) modelCode = String(stored.modelCode || '').trim()
    }
  }
  return { baseUrl, apiKey, modelCode }
}

const readableRequestError = (error: unknown): string => {
  if (error instanceof DOMException && error.name === 'AbortError') {
    return `请求超时（${REQUEST_TIMEOUT_MS / 1000} 秒无响应）`
  }
  if (error instanceof TypeError) {
    return isTauriRuntime()
      ? '网络请求失败，请检查接口地址与网络'
      : '网络请求失败：可能是接口地址不对，或该供应商不允许网页端直连（浏览器跨域限制），桌面版不受此限制'
  }
  return error instanceof Error ? error.message : '请求失败'
}

const readableHttpError = async (response: Response): Promise<string> => {
  let detail = ''
  try {
    const body = await response.json()
    detail = String(body?.error?.message || body?.message || '')
  } catch {
    // 响应体不是 JSON 时只按状态码给文案
  }
  const byStatus: Record<number, string> = {
    401: 'API Key 无效或未授权',
    402: '账户余额不足，请到供应商后台充值',
    403: '没有访问权限（检查 Key 的可用范围）',
    404: '接口路径或模型不存在（检查 BaseURL 与模型名）',
    429: '触发限流或额度不足',
  }
  const base = byStatus[response.status] || `请求失败（HTTP ${response.status}）`
  return detail ? `${base}：${detail.slice(0, 200)}` : base
}

const withTimeout = async <T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> => {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    return await run(controller.signal)
  } finally {
    window.clearTimeout(timer)
  }
}

/** 连通测试：发一条最小 chat 请求验证 BaseURL/Key/模型名三件事 */
export const testLocalAiModel = async (
  payload: Partial<UserAiModelSavePayload>
): Promise<{ data: UserAiModelTestResult }> => {
  const { baseUrl, apiKey, modelCode } = resolveRequestConfig(payload)
  const url = joinAiUrl(baseUrl, 'chat/completions')
  const startedAt = Date.now()
  const result = (ok: boolean, message: string): { data: UserAiModelTestResult } => ({
    data: { ok, message, latency: Date.now() - startedAt, url, testedAt: new Date().toISOString() },
  })
  if (!baseUrl) return result(false, '请先填写接口地址（BaseURL）')
  if (!apiKey) return result(false, '请先填写 API Key')
  if (!modelCode) return result(false, '请先填写模型名称（modelCode）')

  try {
    const aiFetch = await resolveAiFetch()
    const response = await withTimeout(signal =>
      aiFetch(url, {
        method: 'POST',
        signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(
          buildChatBody({
            baseUrl,
            modelCode,
            messages: [{ role: 'user', content: '连通性测试，请回复"ok"' }],
            maxTokens: 16,
            stream: false,
          })
        ),
      })
    )
    if (!response.ok) return result(false, await readableHttpError(response))
    return result(true, '连接成功，模型可用')
  } catch (error) {
    return result(false, readableRequestError(error))
  }
}

export const NO_MODEL_MESSAGE = '还没有可用模型：请先到「模型管理」添加并启用一个文本模型'

/** 调用方标注的场景（进「AI 调用记录」账本）；不传按类型给通用标签 */
export interface LocalAiSceneTag {
  scene?: string
  sceneLabel?: string
}

const messagesToText = (messages: LocalChatMessageInput[]) =>
  messages.map(message => message.content).join('\n')

/** 落账永不影响调用本身：任何记账异常只进控制台 */
const recordAiCall = (entry: {
  recordType: 'text' | 'image'
  tag: LocalAiSceneTag | undefined
  model: LocalAiModel
  status: 0 | 1
  input: string
  output: string
  inputTokens?: number
  outputTokens?: number
  startedAt: number
  errorMsg?: string
}) => {
  void appendLocalAiRecord({
    recordType: entry.recordType,
    scene: entry.tag?.scene || (entry.recordType === 'image' ? 'image_common' : 'text_common'),
    sceneLabel: entry.tag?.sceneLabel || (entry.recordType === 'image' ? '生图' : '文本生成'),
    modelCode: localAiModelCode(entry.model.id),
    modelName: entry.model.name || entry.model.modelCode,
    status: entry.status,
    input: entry.input,
    output: entry.output,
    inputTokens: entry.inputTokens ?? estimateTokens(entry.input),
    outputTokens: entry.outputTokens ?? estimateTokens(entry.output),
    duration: Date.now() - entry.startedAt,
    errorMsg: entry.errorMsg,
  }).catch(error => console.warn('AI 调用记账失败', error))
}

// 非流式生成给足时间：润色/扩写可能一次产出几百字
const COMPLETION_TIMEOUT_MS = 90_000

/**
 * 非流式补全：一次性返回全文（划词润色/打字补全这类"拿到结果再落格"的场景）。
 * 失败抛出带可读文案的 Error；外部 signal 中止原样抛 AbortError 由调用方静默。
 */
export const requestLocalChatCompletion = async (options: {
  modelCode: string
  messages: LocalChatMessageInput[]
  maxTokens?: number
  /** 采样温度（0-2）：来自提示词库逐场景配置；未传用模型服务默认 */
  temperature?: number
  signal?: AbortSignal
} & LocalAiSceneTag): Promise<string> => {
  const model = getLocalAiModelSecret(options.modelCode)
  if (!model) throw new Error(NO_MODEL_MESSAGE)
  if (!model.apiKey || !model.baseUrl || !model.modelCode) {
    throw new Error(`模型「${model.name}」配置不完整，请到模型管理检查`)
  }
  const startedAt = Date.now()
  const recordInput = messagesToText(options.messages)

  const controller = new AbortController()
  let timedOut = false
  const timer = window.setTimeout(() => {
    timedOut = true
    controller.abort()
  }, COMPLETION_TIMEOUT_MS)
  const onCallerAbort = () => controller.abort()
  if (options.signal) {
    if (options.signal.aborted) controller.abort()
    else options.signal.addEventListener('abort', onCallerAbort, { once: true })
  }

  try {
    // 上游偶发空响应体 / 504·502·503 网关抖动 / 网络瞬断：自动重试最多 3 次，递增间隔
    // 重试判据 RETRIABLE_UPSTREAM 声明在文件末尾，非流式与流式共用同一份
    let lastParseError: Error | null = null
    let content = ''
    // 只用得到 usage 的两个计数，给它一个具体形状，避免 any 漏进类型系统
    let body: { usage?: { prompt_tokens?: number; completion_tokens?: number } } | null = null
    const MAX_ATTEMPTS = 3
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, 800 * attempt))
        recordAiCall({
          recordType: 'text',
          tag: options,
          model,
          status: 0,
          input: recordInput,
          output: '',
          outputTokens: 0,
          startedAt,
          errorMsg: `上游异常，第 ${attempt + 1}/${MAX_ATTEMPTS} 次重试`,
        })
      }
      try {
        const aiFetch = await resolveAiFetch()
        const response = await aiFetch(joinAiUrl(model.baseUrl, 'chat/completions'), {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${model.apiKey}`,
          },
          body: JSON.stringify(
            buildChatBody({
              baseUrl: model.baseUrl,
              modelCode: model.modelCode,
              messages: options.messages,
              maxTokens: options.maxTokens || model.maxOutputTokens || undefined,
              temperature: options.temperature,
              stream: false,
            })
          ),
        })
        if (!response.ok) {
          const message = await readableHttpError(response)
          if (rememberTemperatureRejection(model.modelCode, message, options.temperature)) {
            return requestLocalChatCompletion({ ...options, temperature: undefined })
          }
          throw new Error(message)
        }
        const parsed = await response.json()
        if (parsed?.error?.message) throw new Error(String(parsed.error.message))
        body = parsed
        content = stripThinkBlocks(String(parsed?.choices?.[0]?.message?.content || '')).trim()
        if (content === '' && attempt < MAX_ATTEMPTS - 1) {
          lastParseError = new Error('上游返回空内容')
          continue
        }
        break
      } catch (error) {
        const isAbort = error instanceof DOMException && error.name === 'AbortError'
        if (isAbort) throw error
        const msg = readableRequestError(error)
        if (RETRIABLE_UPSTREAM.test(msg) && attempt < MAX_ATTEMPTS - 1) {
          lastParseError = error instanceof Error ? error : new Error(msg)
          continue
        }
        throw error
      }
    }
    if (content === '' && lastParseError) throw lastParseError
    recordAiCall({
      recordType: 'text',
      tag: options,
      model,
      status: 1,
      input: recordInput,
      output: content,
      inputTokens: Number(body?.usage?.prompt_tokens) || undefined,
      outputTokens: Number(body?.usage?.completion_tokens) || undefined,
      startedAt,
    })
    return content
  } catch (error) {
    const readable =
      error instanceof DOMException && error.name === 'AbortError'
        ? timedOut
          ? new Error(`生成超时（${COMPLETION_TIMEOUT_MS / 1000} 秒无结果），请重试`)
          : error
        : new Error(readableRequestError(error))
    // 用户主动中止不算失败，不落账；其余失败如实记一笔
    if (!(readable instanceof DOMException)) {
      recordAiCall({
        recordType: 'text',
        tag: options,
        model,
        status: 0,
        input: recordInput,
        output: '',
        outputTokens: 0,
        startedAt,
        errorMsg: readable.message,
      })
    }
    throw readable
  } finally {
    window.clearTimeout(timer)
    if (options.signal) options.signal.removeEventListener('abort', onCallerAbort)
  }
}

// ---------------------------------------------------------------------------
// 流式对话（OpenAI 兼容 SSE：data: {choices:[{delta:{content}}]} … data: [DONE]）
// ---------------------------------------------------------------------------

// 首字节等待与分片间空闲上限：任一超时主动中止，避免连接挂起时界面永远"生成中"
const STREAM_CONNECT_TIMEOUT_MS = 60_000
const STREAM_IDLE_TIMEOUT_MS = 90_000

export interface LocalChatMessageInput {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface LocalChatStreamCallbacks {
  onDelta: (text: string) => void
  onDone: () => void
  onError: (message: string) => void
}

/**
 * 流式对话：按本地模型 code 取配置直连供应商。
 * 用户主动中止（signal）按正常收尾（onDone），超时中止报错——与旧流式层同语义。
 */
export const streamLocalChatCompletion = async (
  options: {
    modelCode: string
    messages: LocalChatMessageInput[]
    /** 采样温度（0-2）：来自提示词库逐场景配置；未传用模型服务默认 */
    temperature?: number
    /** 输出上限：需要按场景收口的调用方（评审、改写）显式传；不传用模型配置值 */
    maxTokens?: number
    signal?: AbortSignal
  } & LocalAiSceneTag,
  callbacks: LocalChatStreamCallbacks
): Promise<void> => {
  const model = getLocalAiModelSecret(options.modelCode)
  if (!model) {
    callbacks.onError(NO_MODEL_MESSAGE)
    return
  }
  if (!model.apiKey || !model.baseUrl || !model.modelCode) {
    callbacks.onError(`模型「${model.name}」配置不完整，请到模型管理检查`)
    return
  }
  const startedAt = Date.now()
  const recordInput = messagesToText(options.messages)
  let collected = ''
  let recorded = false
  const recordStream = (status: 0 | 1, errorMsg?: string) => {
    if (recorded) return
    recorded = true
    recordAiCall({
      recordType: 'text',
      tag: options,
      model,
      status,
      input: recordInput,
      output: collected,
      startedAt,
      errorMsg,
    })
  }

  const controller = new AbortController()
  let timedOut = false
  let idleTimer: number | null = null
  const clearIdle = () => {
    if (idleTimer) {
      window.clearTimeout(idleTimer)
      idleTimer = null
    }
  }
  const armIdle = (ms: number) => {
    clearIdle()
    idleTimer = window.setTimeout(() => {
      timedOut = true
      controller.abort()
    }, ms)
  }
  const onCallerAbort = () => controller.abort()
  if (options.signal) {
    if (options.signal.aborted) controller.abort()
    else options.signal.addEventListener('abort', onCallerAbort, { once: true })
  }

  try {
    const aiFetch = await resolveAiFetch()
    armIdle(STREAM_CONNECT_TIMEOUT_MS)
    const response = await aiFetch(joinAiUrl(model.baseUrl, 'chat/completions'), {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${model.apiKey}`,
      },
      body: JSON.stringify(
        buildChatBody({
          baseUrl: model.baseUrl,
          modelCode: model.modelCode,
          messages: options.messages,
          maxTokens: options.maxTokens || model.maxOutputTokens || undefined,
          temperature: options.temperature,
          stream: true,
        })
      ),
    })
    if (!response.ok) {
      const message = await readableHttpError(response)
      if (rememberTemperatureRejection(model.modelCode, message, options.temperature)) {
        return streamLocalChatCompletion({ ...options, temperature: undefined }, callbacks)
      }
      recordStream(0, message)
      callbacks.onError(message)
      return
    }
    if (!response.body) {
      callbacks.onError('当前环境不支持流式读取')
      return
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder('utf-8')
    // 渠道可能把 <think> 思考段内联进增量正文，跨分片过滤后再吐给调用方
    const thinkFilter = createThinkStreamFilter()
    let buffer = ''
    let finished = false
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      armIdle(STREAM_IDLE_TIMEOUT_MS)
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      for (const rawLine of lines) {
        const line = rawLine.trim()
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (payload === '[DONE]') {
          finished = true
          break
        }
        try {
          const chunk = JSON.parse(payload)
          if (chunk?.error?.message) {
            const message = String(chunk.error.message)
            recordStream(0, message)
            callbacks.onError(message)
            return
          }
          const delta = chunk?.choices?.[0]?.delta?.content
          if (typeof delta === 'string' && delta) {
            const visible = thinkFilter.push(delta)
            if (visible) {
              collected += visible
              callbacks.onDelta(visible)
            }
          }
        } catch {
          // 跨分片被截断的 JSON 行极少见（按 \n 切已规避大半），忽略无法解析的行
        }
      }
      if (finished) break
    }
    const tail = thinkFilter.finish()
    if (tail) {
      collected += tail
      callbacks.onDelta(tail)
    }
    recordStream(1)
    callbacks.onDone()
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      if (timedOut) {
        recordStream(0, 'AI 响应超时')
        callbacks.onError('AI 响应超时，请重试')
      } else {
        // 用户主动中止按正常收尾：已产出的部分如实入账
        recordStream(1)
        callbacks.onDone()
      }
      return
    }
    const message = readableRequestError(error)
    recordStream(0, message)
    callbacks.onError(message)
  } finally {
    clearIdle()
    if (options.signal) options.signal.removeEventListener('abort', onCallerAbort)
  }
}

// ---------------------------------------------------------------------------
// 流式「一次性收全」：给需要拿到完整结果才能往下走的调用方
// （闸三 AI 评审、施工单自动修复）
// ---------------------------------------------------------------------------

/** 上游抖动值得重试的判据：非流式与流式共用同一份 */
const RETRIABLE_UPSTREAM =
  /end of JSON input|empty|unexpected|\b(502|503|504)\b|gateway|timed? ?out|network|load failed|ECONNRESET|ETIMEDOUT|ERR_NETWORK/i

/**
 * 流式补全的「一次性收全」封装。
 *
 * 为什么非要流式：网关对**非流式**请求约 60 秒硬超时（超了回 504），而思考型模型的思维链
 * 动辄几十秒 —— 用非流式等于把 glm / kimi / seed 这类模型直接挡在评审之外。
 * 流式靠持续出数据保住连接：实测同一个 glm-5.1，非流式 60 秒被 504 掐断，流式 79 秒完整收完。
 *
 * 失败语义与非流式版保持一致：一律抛可读 Error，由调用方收敛成降级状态。
 * 用户主动中止也判失败——评审/改写要的是完整结果，半截等于坏结果。
 */
export const requestLocalChatCompletionStreaming = async (options: {
  modelCode: string
  messages: LocalChatMessageInput[]
  maxTokens?: number
  temperature?: number
  signal?: AbortSignal
} & LocalAiSceneTag): Promise<string> => {
  const MAX_ATTEMPTS = 3
  let lastErrorMessage = '上游未返回内容'

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) await new Promise(resolve => window.setTimeout(resolve, 800 * attempt))

    let collected = ''
    let failureMessage = ''
    await streamLocalChatCompletion(options, {
      onDelta: text => {
        collected += text
      },
      onDone: () => undefined,
      onError: message => {
        failureMessage = message
      },
    })

    if (!failureMessage) {
      if (options.signal?.aborted) throw new Error('生成已中止，本次结果不完整')
      const content = stripThinkBlocks(collected).trim()
      if (content) return content
      failureMessage = '上游返回空内容'
    }

    lastErrorMessage = failureMessage
    if (!RETRIABLE_UPSTREAM.test(lastErrorMessage) || attempt === MAX_ATTEMPTS - 1) break
  }

  throw new Error(lastErrorMessage)
}

/** 拉取供应商可用模型清单（GET {base}/models，OpenAI 兼容形状） */
export const listLocalAiRemoteModels = async (
  payload: Partial<UserAiModelSavePayload>
): Promise<{ data: UserAiRemoteModelListResult }> => {
  const { baseUrl, apiKey } = resolveRequestConfig(payload)
  const url = joinAiUrl(baseUrl, 'models')
  const startedAt = Date.now()
  if (!baseUrl) throw new Error('请先填写接口地址（BaseURL）')
  if (!apiKey) throw new Error('请先填写 API Key')

  try {
    const aiFetch = await resolveAiFetch()
    const response = await withTimeout(signal =>
      aiFetch(url, {
        method: 'GET',
        signal,
        headers: { Authorization: `Bearer ${apiKey}` },
      })
    )
    if (!response.ok) throw new Error(await readableHttpError(response))
    const body = await response.json()
    const rawList = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : []
    const models = rawList
      .map((item: { id?: unknown }) => String(item?.id || '').trim())
      .filter(Boolean)
      .sort((a: string, b: string) => a.localeCompare(b))
    return {
      data: {
        models,
        total: models.length,
        url,
        latency: Date.now() - startedAt,
        testedAt: new Date().toISOString(),
      },
    }
  } catch (error) {
    const message = readableRequestError(error)
    throw new Error(message === '请求失败' ? '拉取模型清单失败' : message)
  }
}

// ---------------------------------------------------------------------------
// 生图（OpenAI 兼容 images/generations）
// ---------------------------------------------------------------------------

// 生图是长任务：gpt-image 常规 70~120s，给足 5 分钟；超时文案单独给
const IMAGE_TIMEOUT_MS = 300_000

export interface LocalAiImageResult {
  /** 优先：图片二进制（b64 响应或 url 已成功回捞） */
  blob?: Blob
  /** 兜底：仅拿到远程地址且网页端跨域捞不回（地址可能过期，调用方如实入库） */
  remoteUrl?: string
}

const base64ToBlob = (b64: string, type = 'image/png') => {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return new Blob([bytes], { type })
}

/**
 * 按本地模型 code 直连供应商生图。请求 b64_json，供应商忽略该参数只回 url 时
 * 尝试把图捞回本地（桌面端不受跨域限制）；捞不回就退回 remoteUrl。
 */
export const generateLocalAiImageRequest = async (options: {
  modelCode: string
  prompt: string
  size?: string
  quality?: string
  signal?: AbortSignal
} & LocalAiSceneTag): Promise<LocalAiImageResult> => {
  const model = getLocalAiModelSecret(options.modelCode)
  if (!model) throw new Error(NO_MODEL_MESSAGE)
  if (!model.apiKey || !model.baseUrl || !model.modelCode) {
    throw new Error(`模型「${model.name}」配置不完整，请到模型管理检查`)
  }
  const startedAt = Date.now()
  const recordImage = (status: 0 | 1, errorMsg?: string) =>
    recordAiCall({
      recordType: 'image',
      tag: options,
      model,
      status,
      input: options.prompt,
      output: '',
      inputTokens: 0,
      outputTokens: 0,
      startedAt,
      errorMsg,
    })

  const controller = new AbortController()
  let timedOut = false
  const timer = window.setTimeout(() => {
    timedOut = true
    controller.abort()
  }, IMAGE_TIMEOUT_MS)
  const onCallerAbort = () => controller.abort()
  if (options.signal) {
    if (options.signal.aborted) controller.abort()
    else options.signal.addEventListener('abort', onCallerAbort, { once: true })
  }

  try {
    const aiFetch = await resolveAiFetch()
    const response = await aiFetch(joinAiUrl(model.baseUrl, 'images/generations'), {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${model.apiKey}`,
      },
      body: JSON.stringify({
        model: model.modelCode,
        prompt: options.prompt,
        n: 1,
        response_format: 'b64_json',
        ...(options.size ? { size: options.size } : {}),
        ...(options.quality ? { quality: options.quality } : {}),
      }),
    })
    if (!response.ok) throw new Error(await readableHttpError(response))
    const body = await response.json()
    if (body?.error?.message) throw new Error(String(body.error.message))
    const item = body?.data?.[0] || {}
    const b64 = String(item.b64_json || '')
    if (b64) {
      recordImage(1)
      return { blob: base64ToBlob(b64) }
    }
    const url = String(item.url || '')
    if (!url) throw new Error('生图接口没有返回图片数据')
    recordImage(1)
    try {
      const imageResponse = await aiFetch(url, { method: 'GET', signal: controller.signal })
      if (!imageResponse.ok) throw new Error(`HTTP ${imageResponse.status}`)
      return { blob: await imageResponse.blob() }
    } catch {
      // 网页端常见：图床跨域取不回二进制——退回远程地址，调用方如实标注可能过期
      return { remoteUrl: url }
    }
  } catch (error) {
    const readable =
      error instanceof DOMException && error.name === 'AbortError'
        ? timedOut
          ? new Error(`生图超时（${IMAGE_TIMEOUT_MS / 1000} 秒无结果），请重试`)
          : error
        : new Error(readableRequestError(error))
    if (!(readable instanceof DOMException)) recordImage(0, readable.message)
    throw readable
  } finally {
    window.clearTimeout(timer)
    if (options.signal) options.signal.removeEventListener('abort', onCallerAbort)
  }
}
