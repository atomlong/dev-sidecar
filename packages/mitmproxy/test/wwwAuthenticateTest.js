// 回归测试：www-authenticate 响应头不被错误拆分
// 背景：createRequestHandler 曾用 split(',') 拆分 www-authenticate 头，无法区分
//   - 多 challenge 间的逗号（Bearer ...,Basic ...）
//   - 单 Bearer challenge 内 auth-param 参数分隔逗号（realm="...",service="...",scope="..."）
// 导致 Docker registry 返回的单个 Bearer challenge 被拆成多段，docker buildx imagetools
// inspect 的 Go HTTP 客户端无法解析完整 challenge，OAuth token 流程中断。
// 修复：移除 split(',')，保留字符串原值传给 res.setHeader()。
const assert = require('node:assert')
const http = require('node:http')
const path = require('node:path')

const mitmproxy = require('../src/lib/proxy')
const dnsUtil = require('../src/lib/dns')

const REPO = path.resolve(__dirname, '..')
const CA_CERT = '/home/uif79392/.dev-sidecar/dev-sidecar.ca.crt'
const CA_KEY = '/home/uif79392/.dev-sidecar/dev-sidecar.ca.key.pem'

// 起一个返回指定 www-authenticate 头的上游 HTTP 服务器
function startUpstream (headerValue) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (Array.isArray(headerValue)) {
        // 模拟 HTTP/1 多行同名头（用数组 setHeader，Node 合并时会加空格）
        res.setHeader('www-authenticate', headerValue)
      } else {
        res.setHeader('www-authenticate', headerValue)
      }
      res.writeHead(401)
      res.end('unauthorized')
    })
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

// 起一个 dev mitmproxy HTTP 代理（仅 HTTP 转发，不做 HTTPS MITM）
function startProxy () {
  return new Promise((resolve, reject) => {
    const dnsConfig = {
      preSetIpList: {},
      dnsMap: dnsUtil.initDNS({}, {}),
      mapping: {},
      speedTest: undefined,
    }
    const [httpsServer, httpServer] = mitmproxy.createProxy({
      host: '127.0.0.1',
      port: 45181, // httpsPort=45181, httpPort=45180（createProxy 内部 port-1）
      maxLength: 10000,
      caCertPath: CA_CERT,
      caKeyPath: CA_KEY,
      sslConnectInterceptor: () => false, // 不做 HTTPS MITM，只测纯 HTTP 转发
      createIntercepts: () => undefined,
      middlewares: [],
      externalProxy: null,
      dnsConfig,
      setting: {
        verifySsl: true,
        userBasePath: '/home/uif79392/.dev-sidecar',
        script: { enabled: false, defaultDir: './extra/scripts/' },
      },
      compatibleConfig: { connect: {}, request: {} },
    })
    httpServer.once('listening', () => {
      const port = httpServer.address().port
      resolve({ httpsServer, httpServer, port })
    })
    httpServer.once('error', reject)
  })
}

// 通过 dev 代理请求上游，返回响应头
function requestViaProxy (proxyPort, upstreamPort) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: proxyPort,
      path: `http://127.0.0.1:${upstreamPort}/v2/`,
      method: 'GET',
      headers: { host: `127.0.0.1:${upstreamPort}` },
    }, (res) => {
      // 统计 rawHeaders 中 www-authenticate 头行数（关键回归指标）
      let headerLineCount = 0
      for (let i = 0; i < res.rawHeaders.length; i += 2) {
        if (res.rawHeaders[i].toLowerCase() === 'www-authenticate') {
          headerLineCount++
        }
      }
      resolve({
        status: res.statusCode,
        value: res.headers['www-authenticate'],
        headerLineCount,
        rawType: typeof res.headers['www-authenticate'],
      })
      res.resume()
    })
    req.on('error', reject)
    req.end()
  })
}

describe('www-authenticate 响应头处理', function () {
  this.timeout(10000)

  let proxy
  before(async () => {
    proxy = await startProxy()
  })
  after(async () => {
    await Promise.all([
      new Promise((r) => proxy.httpServer.close(r)),
      new Promise((r) => proxy.httpsServer.close(r)),
    ])
  })

  it('单 Bearer challenge 含逗号分隔的 auth-param（Docker registry 场景）应保持单行完整', async () => {
    const headerValue = 'Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:library/alpine:pull"'
    const upstream = await startUpstream(headerValue)
    try {
      const { status, value, headerLineCount, rawType } = await requestViaProxy(proxy.port, upstream.address().port)
      assert.strictEqual(status, 401)
      assert.strictEqual(rawType, 'string', '应为字符串而非被 split 拆成的数组')
      assert.strictEqual(headerLineCount, 1, '客户端收到的 www-authenticate 头应只有 1 行')
      assert.strictEqual(
        value,
        headerValue,
        '头值应原样透传，realm/service/scope 保持在同一字符串内',
      )
    } finally {
      await new Promise((r) => upstream.close(r))
    }
  })

  it('真正多 challenge（issue #362 场景：Bearer + Basic）不应崩坏，单行多 challenge 符合 RFC 7235', async () => {
    // 用数组 setHeader 模拟 HTTP/1 多行同名头，Node 合并为逗号分隔单字符串
    const headerValue = ['Bearer realm="https://auth.example.com/token"', 'Basic realm="admin"']
    const upstream = await startUpstream(headerValue)
    try {
      const { status, value, headerLineCount, rawType } = await requestViaProxy(proxy.port, upstream.address().port)
      assert.strictEqual(status, 401)
      assert.strictEqual(rawType, 'string')
      assert.ok(value.includes('Bearer realm="https://auth.example.com/token"'), '应包含 Bearer challenge')
      assert.ok(value.includes('Basic realm="admin"'), '应包含 Basic challenge')
      // 修复后为单行（RFC 7235 1#challenge 允许逗号分隔多 challenge）；原 split 会拆成多行
      assert.strictEqual(headerLineCount, 1)
    } finally {
      await new Promise((r) => upstream.close(r))
    }
  })

  it('大小写变体 WWW-Authenticate 应被规范化为小写 key', async () => {
    // 直接验证 createRequestHandler 的 key 规范化逻辑：
    // 上游无论返回什么大小写的头名，proxyRes.headers 的 key 已被 Node 转为小写，
    // 且 WWW_AUTH_HEADER_RE /^www-authenticate$/i 会匹配并把 key 设为 'www-authenticate'
    const headerValue = 'Bearer realm="https://auth.example.com/token",service="test"'
    const upstream = await startUpstream(headerValue)
    try {
      const { status, value, headerLineCount } = await requestViaProxy(proxy.port, upstream.address().port)
      assert.strictEqual(status, 401)
      assert.strictEqual(headerLineCount, 1)
      assert.strictEqual(value, headerValue)
    } finally {
      await new Promise((r) => upstream.close(r))
    }
  })
})
