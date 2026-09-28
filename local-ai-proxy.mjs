import http from 'node:http'
import https from 'node:https'

const target = new URL('https://tokenrhythm.studio')
const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  'access-control-allow-headers': '*',
  'access-control-expose-headers': '*',
}

const server = http.createServer((request, response) => {
  if (request.method === 'OPTIONS') {
    response.writeHead(204, cors)
    response.end()
    return
  }

  const startedAt = Date.now()
  let responseBytes = 0
  const errorChunks = []
  const headers = { ...request.headers, host: target.host }
  delete headers.origin
  delete headers.referer
  delete headers.cookie
  for (const key of Object.keys(headers)) {
    if (key.startsWith('sec-fetch-') || key.startsWith('sec-ch-ua')) delete headers[key]
  }

  const upstream = https.request({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || 443,
    method: request.method,
    path: request.url,
    headers,
  }, upstreamResponse => {
    response.writeHead(upstreamResponse.statusCode || 502, {
      ...upstreamResponse.headers,
      ...cors,
    })
    upstreamResponse.on('data', chunk => {
      responseBytes += chunk.length
      if ((upstreamResponse.statusCode || 0) >= 400 && responseBytes <= 2048) errorChunks.push(chunk)
      response.write(chunk)
    })
    upstreamResponse.on('end', () => {
      response.end()
      const contentType = String(upstreamResponse.headers['content-type'] || '')
      console.log(`[proxy] ${new Date().toISOString()} ${request.method} ${request.url} -> ${upstreamResponse.statusCode} ${responseBytes}B ct=${contentType} ${Date.now() - startedAt}ms`)
      if ((upstreamResponse.statusCode || 0) >= 400 && errorChunks.length) {
        console.log(`[proxy] upstream error: ${Buffer.concat(errorChunks).toString('utf8').slice(0, 500)}`)
      }
    })
  })

  upstream.on('error', error => {
    if (!response.headersSent) response.writeHead(502, { ...cors, 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { message: error.message } }))
  })
  request.pipe(upstream)
})

server.listen(7878, '127.0.0.1', () => {
  console.log('[proxy] listening on http://127.0.0.1:7878 -> https://tokenrhythm.studio')
})
