// 最小化 S3 兼容对象存储客户端（Cloudflare R2 / AWS S3 / MinIO / 阿里云 OSS）。
// 只实现备份所需的 4 个操作（Put/Get/List/Delete）+ 连通性测试，
// 使用 AWS SigV4 签名 + node:https，避免引入 AWS SDK（5MB+）依赖。
// Path-style 寻址（/bucket/key）——R2 与 MinIO 均推荐/要求 path-style。
const https = require('node:https')
const http = require('node:http')
const crypto = require('node:crypto')

function sha256Hex (data) {
  return crypto.createHash('sha256').update(data).digest('hex')
}

function hmac (key, data) {
  return crypto.createHmac('sha256', key).update(data).digest()
}

// AWS 规范的 URI 编码：仅保留未保留字符 A-Za-z0-9-._~，'/' 需按段分别编码后拼接
function uriEncode (str) {
  return encodeURIComponent(String(str)).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())
}

function amzDate (d) {
  return d.toISOString().replace(/[:-]/g, '').replace(/\.\d+Z$/, 'Z')
}

// 将 S3 XML 中的实体解码（对象 Key 可能含 & < > 等）
function decodeXmlEntities (s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

// 解析 ListObjectsV2 的 XML 响应，提取 Key/Size/LastModified
function parseListXml (xml) {
  const items = []
  const re = /<Contents>([\s\S]*?)<\/Contents>/g
  let m
  while ((m = re.exec(xml)) !== null) {
    const block = m[1]
    const key = block.match(/<Key>([\s\S]*?)<\/Key>/)
    const size = block.match(/<Size>([\s\S]*?)<\/Size>/)
    const lm = block.match(/<LastModified>([\s\S]*?)<\/LastModified>/)
    if (key) {
      items.push({
        key: decodeXmlEntities(key[1]),
        size: size ? parseInt(size[1], 10) : 0,
        lastModified: lm ? lm[1] : '',
      })
    }
  }
  return items
}

/**
 * 构造一次签名请求的全部要素（纯函数，便于交叉验证签名实现）。
 * @param {object} cfg {endpoint, region, bucket, accessKeyId, secretAccessKey}
 * @param {object} opt {method, key, query, body, contentType}
 * @param {Date} now 签名时刻
 */
function buildSignedRequest (cfg, opt, now) {
  const endpoint = String(cfg.endpoint || '').replace(/\/+$/, '')
  if (!/^https?:\/\//.test(endpoint)) {
    throw new Error(`S3 endpoint 必须以 http(s):// 开头: ${cfg.endpoint}`)
  }
  if (!cfg.bucket) throw new Error('S3 bucket 不能为空')
  const region = cfg.region || 'auto' // R2 默认 auto
  const url = new URL(endpoint)
  const port = url.port ? `:${url.port}` : ''
  const host = url.hostname + port

  const method = (opt.method || 'GET').toUpperCase()
  // path-style：bucket 与 key 各段独立编码后拼接
  const canonicalUri = '/' + [cfg.bucket, ...(opt.key ? String(opt.key).split('/') : [])]
    .map(seg => uriEncode(seg)).join('/')
  const query = opt.query || {}
  const queryPairs = Object.keys(query).sort()
    .map(k => `${uriEncode(k)}=${uriEncode(query[k])}`)
  const canonicalQuery = queryPairs.join('&')

  const bodyBuf = opt.body ? (Buffer.isBuffer(opt.body) ? opt.body : Buffer.from(opt.body)) : Buffer.alloc(0)
  const payloadHash = sha256Hex(bodyBuf)
  const datestamp = amzDate(now).slice(0, 8)
  const xamzDate = amzDate(now)
  const contentHeaders = {}
  if (opt.contentType) contentHeaders['content-type'] = opt.contentType
  const canonicalHeadersMap = {
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': xamzDate,
    ...contentHeaders,
  }
  const headerNames = Object.keys(canonicalHeadersMap).sort()
  const canonicalHeaders = headerNames.map(h => `${h}:${canonicalHeadersMap[h].trim()}\n`).join('')
  const signedHeaders = headerNames.join(';')

  const canonicalRequest = [
    method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash,
  ].join('\n')

  const scope = `${datestamp}/${region}/s3/aws4_request`
  const stringToSign = [
    'AWS4-HMAC-SHA256', xamzDate, scope, sha256Hex(Buffer.from(canonicalRequest)),
  ].join('\n')

  let signingKey = hmac(Buffer.from('AWS4' + cfg.secretAccessKey), datestamp)
  signingKey = hmac(signingKey, region)
  signingKey = hmac(signingKey, 's3')
  signingKey = hmac(signingKey, 'aws4_request')
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex')

  return {
    method,
    host,
    isHttps: url.protocol === 'https:',
    hostname: url.hostname,
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
    path: canonicalUri + (canonicalQuery ? `?${canonicalQuery}` : ''),
    payloadBuf: bodyBuf,
    headers: {
      Host: host,
      Authorization: `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': xamzDate,
      ...(opt.contentType ? { 'Content-Type': opt.contentType } : {}),
    },
  }
}

/**
 * 发起一次签名的 S3 请求。
 * @param {object} cfg {endpoint, region, bucket, accessKeyId, secretAccessKey}
 * @param {object} opt {method, key, query, body(Buffer|string), contentType}
 */
function s3Request (cfg, opt) {
  return new Promise((resolve, reject) => {
    let signed
    try {
      signed = buildSignedRequest(cfg, opt, new Date())
    } catch (err) {
      return reject(err)
    }
    const lib = signed.isHttps ? https : http
    const req = lib.request({
      hostname: signed.hostname,
      port: signed.port,
      method: signed.method,
      path: signed.path,
      headers: {
        ...signed.headers,
        'Content-Length': String(signed.payloadBuf.length),
      },
      timeout: 30000,
    }, (res) => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    req.on('timeout', () => req.destroy(new Error('S3 请求超时（30s）')))
    req.on('error', reject)
    if (signed.payloadBuf.length) req.write(signed.payloadBuf)
    req.end()
  })
}

function createS3Client (cfg) {
  async function checked (opt) {
    const res = await s3Request(cfg, opt)
    if (res.status < 200 || res.status >= 300) {
      const brief = res.body.toString('utf8').slice(0, 500)
      throw new Error(`S3 ${opt.method} ${opt.key || ''} 失败: HTTP ${res.status} ${brief}`)
    }
    return res
  }
  return {
    // 用最小 List 验证 endpoint/凭据/bucket 可用（比 HeadBucket 校验更完整：含 List 权限）
    async test () {
      const res = await s3Request(cfg, { method: 'GET', query: { 'list-type': '2', 'max-keys': '1' } })
      if (res.status >= 200 && res.status < 300) return true
      const brief = res.body.toString('utf8').slice(0, 500)
      throw new Error(`S3 连接测试失败: HTTP ${res.status} ${brief}`)
    },
    async putObject (key, body, contentType) {
      const res = await checked({ method: 'PUT', key, body, contentType: contentType || 'application/octet-stream' })
      return { etag: res.headers.etag || '', size: body.length }
    },
    async getObject (key) {
      const res = await checked({ method: 'GET', key })
      return res.body
    },
    async listObjects (prefix, maxKeys) {
      const query = { 'list-type': '2', 'max-keys': String(maxKeys || 100) }
      if (prefix) query.prefix = prefix
      const res = await checked({ method: 'GET', query })
      return parseListXml(res.body.toString('utf8'))
    },
    async deleteObject (key) {
      await checked({ method: 'DELETE', key })
      return true
    },
    _s3Request: s3Request, // 测试用
  }
}

module.exports = { createS3Client, s3Request, buildSignedRequest, parseListXml, uriEncode, amzDate }
