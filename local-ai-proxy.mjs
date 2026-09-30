// 易创浏览器模式的本地 AI 反向代理
// 用途：tokenrhythm.studio 等 OpenAI 兼容接口不开放浏览器跨域（CORS），
//       桌面版用 Tauri 的 HTTP 插件不受限；浏览器开发模式需要本代理中转。
// 启动：node local-ai-proxy.mjs   （默认监听 7878 端口）
// 使用：在「模型管理」里把 Base URL 改为 http://localhost:7878/v1 即可。
// 2026-09-04 加固：上游连接失败（含瞬时 DNS ENOTFOUND / ECONNRESET / 握手失败）
//                 自动重试最多 3 次、递增间隔；仅在尚未向客户端写响应头时重试（流式已透传则不再重试）。
// 2026-09-29 加固：补上游超时。此前 https.request 没有设任何超时，供应商侧只要把连接
//                 建起来却不回数据，这条请求就会永久挂着——浏览器 fetch 永不结束，
//                 写作任务的活循环一直 await，任务永远显示 running，守护器也接管不了。
import http from 'node:http'
import https from 'node:https'

const TARGET_HOST = 'tokenrhythm.studio'
const TARGET_PORT = 443
const PORT = Number(process.env.PROXY_PORT || 7878)
const MAX_ATTEMPTS = 3
// 空闲超时：socket 上这么久没有任何字节流动，就按挂死处理。
// 流式响应（SSE）会持续吐数据，不会误伤；只有真挂死的连接才吃这一刀。
const UPSTREAM_IDLE_TIMEOUT = 180_000
// 总时长上限：防止上游用极慢的滴流把连接吊着不放。
const UPSTREAM_TOTAL_TIMEOUT = 30 * 60_000
// 超时类错误只多试一次：试两次都超时基本就是对方挂了，不必让作者继续干等。
const TIMEOUT_MAX_ATTEMPTS = 2

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With, Accept',
  'Access-Control-Max-Age': '86400',
}

// 浏览器会带的、服务端不认的请求头：转发前必须剥掉，否则上游风控会判定
// "请求安全校验失败"（该服务只允许服务端/桌面端风格的调用，不接受浏览器来源头）
const BROWSER_ONLY_HEADERS = [
  'origin', 'referer', 'sec-fetch-mode', 'sec-fetch-site', 'sec-fetch-dest',
  'sec-fetch-user', 'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform',
  'sec-ch-ua-platform-version', 'sec-ch-ua-full-version-list', 'sec-ch-ua-model',
  'sec-ch-ua-bitness', 'sec-ch-ua-wow64', 'sec-ch-prefers-color-scheme',
  'sec-gpc', 'priority',
]

// 收集请求体 + 识别 stream 参数；请求头一次性构造好供每次重试复用
function prepare(req, res, done) {
  const forwardHeaders = { ...req.headers, host: TARGET_HOST }
  for (const name of BROWSER_ONLY_HEADERS) delete forwardHeaders[name]
  forwardHeaders['user-agent'] = 'easy-writing-local-proxy/1.0'
  req._forwardHeaders = forwardHeaders

  // 必须先按字节拼接，再一次性 UTF-8 解码。逐 chunk 隐式转字符串时，中文字符若刚好
  // 被网络分片从中间切开，会变成替换字符，导致 JSON 损坏且 Content-Length 失真。
  const chunks = []
  req.on('data', (chunk) => { chunks.push(Buffer.from(chunk)) })
  req.on('end', () => {
    const reqBody = Buffer.concat(chunks)
    const reqText = reqBody.toString('utf8')
    forwardHeaders['content-length'] = String(reqBody.length)
    let streamFlag = 'n/a'
    let modelName = ''
    try {
      const parsed = JSON.parse(reqText)
      streamFlag = parsed.stream ? 'stream' : 'non-stream'
      modelName = parsed.model || ''
    } catch { /* 非 JSON 请求体 */ }
    req._streamFlag = streamFlag
    req._modelName = modelName
    done(reqBody)
  })
}

function forward(req, res, reqBody, attempt) {
  let downstreamClosed = false
  let activeProxyResponse = null

  // 总时长看门狗：正常结束或出错都要清掉，否则进程里会越积越多。
  const totalTimer = setTimeout(() => {
    const err = new Error(`上游总耗时超过 ${UPSTREAM_TOTAL_TIMEOUT / 60_000} 分钟`)
    err.code = 'UPSTREAM_TOTAL_TIMEOUT'
    proxyReq.destroy(err)
  }, UPSTREAM_TOTAL_TIMEOUT)
  const clearTotalTimer = () => clearTimeout(totalTimer)

  const proxyReq = https.request(
    {
      host: TARGET_HOST,
      port: TARGET_PORT,
      path: req.url,
      method: req.method,
      headers: req._forwardHeaders,
    },
    (proxyRes) => {
      activeProxyResponse = proxyRes
      // 记录上游响应：状态码 + 字节数 + 请求类型，用于排查空响应体
      let bytes = 0
      // 4xx/5xx 的响应体是「为什么失败」的唯一线索：400 常见于参数不合法、上下文超限、
      // 模型名不可用。此前只记了状态码和字节数（133B），回头看日志根本推不出原因。
      // 只留前 2048 字节（错误体通常 ~130B），正常 200 的 SSE 流完全不受影响。
      const isUpstreamError = proxyRes.statusCode >= 400
      const errorChunks = []
      let errorBytes = 0
      proxyRes.on('data', (chunk) => {
        bytes += chunk.length
        if (isUpstreamError && errorBytes < 2048) {
          errorChunks.push(chunk)
          errorBytes += chunk.length
        }
      })
      proxyRes.on('end', () => {
        clearTotalTimer()
        const ts = new Date().toISOString()
        const ctype = String(proxyRes.headers['content-type'] || '').split(';')[0]
        console.log(`[proxy] ${ts} ${req.method} ${req.url} [${req._streamFlag}] ${req._modelName} -> ${proxyRes.statusCode} ${bytes}B ct=${ctype}`)
        if (errorChunks.length) {
          const snippet = Buffer.concat(errorChunks).toString('utf8').replace(/\s+/g, ' ').slice(0, 400)
          console.log(`[proxy] ${ts} 上游错误体 -> ${snippet}`)
        }
      })
      const headers = { ...proxyRes.headers }
      // 去掉上游禁止跨域读取的头，换成允许
      delete headers['cross-origin-resource-policy']
      delete headers['access-control-allow-origin']
      delete headers['access-control-allow-credentials']
      Object.assign(headers, corsHeaders)
      res.writeHead(proxyRes.statusCode, headers)
      proxyRes.pipe(res) // 流式响应（SSE）直接透传
    }
  )

  // 浏览器刷新、HMR 或正文层主动切备用模型时，必须同步终止上游流。
  // 否则客户端虽然不再读取，供应商仍会继续生成并计费到 max_tokens。
  // 空闲超时：上游这么久一个字节都没发就判死，主动断开而不是无限期挂着。
  proxyReq.setTimeout(UPSTREAM_IDLE_TIMEOUT, () => {
    const err = new Error(`上游 ${UPSTREAM_IDLE_TIMEOUT / 1000} 秒无任何响应数据`)
    err.code = 'UPSTREAM_IDLE_TIMEOUT'
    proxyReq.destroy(err)
  })

  res.once('close', () => {
    if (res.writableEnded) return
    downstreamClosed = true
    clearTotalTimer()
    activeProxyResponse?.destroy()
    proxyReq.destroy()
  })

  proxyReq.on('error', (err) => {
    clearTotalTimer()
    if (downstreamClosed) return
    const timedOut = err.code === 'UPSTREAM_IDLE_TIMEOUT' || err.code === 'UPSTREAM_TOTAL_TIMEOUT'
    const maxAttempts = timedOut ? TIMEOUT_MAX_ATTEMPTS : MAX_ATTEMPTS
    const ts = new Date().toISOString()
    // 只要还没给客户端写任何响应头，就允许安全重试（流式已开始透传则不再重试）
    if (!res.headersSent && attempt < maxAttempts) {
      console.log(`[proxy] ${ts} 上游${timedOut ? '超时' : '连接失败'}(${err.code || err.message}) 第${attempt}/${maxAttempts}次重试 ${req.method} ${req.url} [${req._streamFlag}] ${req._modelName}`)
      setTimeout(() => forward(req, res, reqBody, attempt + 1), timedOut ? 500 : 400 * attempt)
      return
    }
    if (!res.headersSent) {
      // 超时给 504：平台侧按「响应超时」归入可恢复失败，守护器会自动接回这一章。
      const status = timedOut ? 504 : 502
      console.log(`[proxy] ${ts} 放弃并返回 ${status} ${req.method} ${req.url} [${req._streamFlag}] ${req._modelName} code=${err.code || 'n/a'}`)
      res.writeHead(status, { 'Content-Type': 'application/json', ...corsHeaders })
      res.end(JSON.stringify({
        error: {
          message: `本地代理${timedOut ? '等待上游超时' : '连接上游失败'}: ${err.message}`,
          code: err.code || 'PROXY_UPSTREAM_ERROR',
        },
      }))
    } else {
      res.destroy(err)
    }
  })

  proxyReq.end(reqBody)
}

const server = http.createServer((req, res) => {
  // 浏览器预检请求：直接放行
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders)
    res.end()
    return
  }
  prepare(req, res, (reqBody) => forward(req, res, reqBody, 1))
})

server.listen(PORT, () => {
  console.log(`[local-ai-proxy] http://localhost:${PORT} -> https://${TARGET_HOST} (连接失败自动重试${MAX_ATTEMPTS}次)`)
})

// 优雅退出
process.on('SIGINT', () => {
  server.close(() => process.exit(0))
})
