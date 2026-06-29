const URL = require('node:url')
const fs = require('node:fs')
const tls = require('node:tls')
const tunnelAgent = require('tunnel-agent')
const log = require('../../../utils/util.log.server')
const matchUtil = require('../../../utils/util.match')
const Agent = require('./ProxyHttpAgent')
const HttpsAgent = require('./ProxyHttpsAgent')

// 匹配形如 `[::1]` 或 `[::1]:443` 的 IPv6 地址（带或不带端口）
const IPv6_HOST_RE = /^(\[[^\]]+\])(?::(\d+))?$/

const util = exports

const httpsAgentCache = {}
const httpAgentCache = {}

let socketId = 0

let httpOverHttpAgent, httpsOverHttpAgent, httpOverHttpsAgent, httpsOverHttpsAgent

// 读取 NODE_EXTRA_CA_CERTS 指向的 PEM 文件中的证书，与 Node 内置根证书合并。
// Electron 打包应用会忽略 NODE_EXTRA_CA_CERTS 环境变量，这里显式读取并传入 ca 选项绕过该限制。
// 模块级缓存：CA 文件运行时不变，只加载一次。null=未加载，false=加载失败/未配置，string[]=证书列表
let extraCaCerts = null

function loadExtraCaCerts () {
  if (extraCaCerts !== null) return extraCaCerts
  const caPath = process.env.NODE_EXTRA_CA_CERTS || process.env.SSL_CERT_FILE
  if (!caPath) {
    extraCaCerts = false
    return false
  }
  try {
    const pem = fs.readFileSync(caPath, 'utf8')
    const certs = []
    const re = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g
    let m
    while ((m = re.exec(pem)) !== null) {
      certs.push(m[0])
    }
    if (certs.length === 0) {
      log.warn(`NODE_EXTRA_CA_CERTS 指向的文件未找到 PEM 证书: ${caPath}`)
      extraCaCerts = false
    } else {
      // 合并 Node 内置根证书 + 额外 CA：ca 选项会替换内置 CA，需手动追加以保持兼容
      extraCaCerts = tls.rootCertificates.concat(certs)
      log.info(`从 NODE_EXTRA_CA_CERTS 加载了 ${certs.length} 个证书（已与 ${tls.rootCertificates.length} 个内置根证书合并）: ${caPath}`)
    }
  } catch (e) {
    log.warn(`读取 NODE_EXTRA_CA_CERTS 失败: ${caPath}, ${e.message}`)
    extraCaCerts = false
  }
  return extraCaCerts
}

function getTimeoutConfig (hostname, serverSetting) {
  const timeoutMapping = serverSetting.timeoutMapping

  const timeoutConfig = matchUtil.matchHostname(timeoutMapping, hostname, 'get timeoutConfig') || {}

  return {
    timeout: timeoutConfig.timeout || serverSetting.defaultTimeout || 20000,
    keepAliveTimeout: timeoutConfig.keepAliveTimeout || serverSetting.defaultKeepAliveTimeout || 30000,
  }
}

function createHttpsAgent (timeoutConfig, verifySsl) {
  const key = `${timeoutConfig.timeout}-${timeoutConfig.keepAliveTimeout}`
  if (!httpsAgentCache[key]) {
    verifySsl = !!verifySsl

    // 证书回调函数
    const checkServerIdentity = (host, cert) => {
      log.info(`checkServerIdentity: ${host}, CN: ${cert.subject.CN}, C: ${cert.subject.C || cert.issuer.C}, ST: ${cert.subject.ST || cert.issuer.ST}, bits: ${cert.bits}`)
    }

    // 显式加载 NODE_EXTRA_CA_CERTS（Electron 打包应用会忽略该环境变量）
    const extraCerts = loadExtraCaCerts()
    const caOption = Array.isArray(extraCerts) ? { ca: extraCerts } : {}

    const agent = new HttpsAgent({
      keepAlive: true,
      timeout: timeoutConfig.timeout,
      keepAliveTimeout: timeoutConfig.keepAliveTimeout,
      checkServerIdentity,
      rejectUnauthorized: verifySsl,
      ...caOption,
    })

    agent.unVerifySslAgent = new HttpsAgent({
      keepAlive: true,
      timeout: timeoutConfig.timeout,
      keepAliveTimeout: timeoutConfig.keepAliveTimeout,
      checkServerIdentity,
      rejectUnauthorized: false,
      ...caOption,
    })

    httpsAgentCache[key] = agent
    log.info('创建 HttpsAgent 成功, timeoutConfig:', timeoutConfig, ', verifySsl:', verifySsl)
  }
  return httpsAgentCache[key]
}

function createHttpAgent (timeoutConfig) {
  const key = `${timeoutConfig.timeout}-${timeoutConfig.keepAliveTimeout}`
  if (!httpAgentCache[key]) {
    httpAgentCache[key] = new Agent({
      keepAlive: true,
      timeout: timeoutConfig.timeout,
      keepAliveTimeout: timeoutConfig.keepAliveTimeout,
    })
    log.info('创建 HttpAgent 成功, timeoutConfig:', timeoutConfig)
  }
  return httpAgentCache[key]
}

function createAgent (protocol, timeoutConfig, verifySsl) {
  return protocol === 'https:'
    ? createHttpsAgent(timeoutConfig, verifySsl)
    : createHttpAgent(timeoutConfig)
}

util.parseHostnameAndPort = (host, defaultPort) => {
  let arr = host.match(IPv6_HOST_RE) // 尝试解析IPv6
  if (arr) {
    arr = arr.slice(1)
    if (arr[1]) {
      arr[1] = Number.parseInt(arr[1], 10)
    }
  } else {
    arr = host.split(':')
    if (arr.length > 1) {
      arr[1] = Number.parseInt(arr[1], 10)
    }
  }

  if (defaultPort > 0 && (arr.length === 1 || arr[1] === undefined)) {
    arr[1] = defaultPort
  } else if (arr.length === 2 && arr[1] === undefined) {
    arr.pop()
  }

  return arr
}

util.getOptionsFromRequest = (req, ssl, externalProxy = null, serverSetting, compatibleConfig = null) => {
  // eslint-disable-next-line node/no-deprecated-api
  const urlObj = URL.parse(req.url)

  // 修复：当 ssl=true（请求来自HTTPS代理端口）但请求URL是绝对HTTP路径时，
  // 说明这是HTTP请求被错误发送到了HTTPS代理端口。
  // 例：GET http://example.com/path HTTP/1.1 被发送到HTTPS代理端口。
  // 此时应修正协议为HTTP，避免将HTTP请求以HTTPS方式转发到目标服务器。
  const isHttpAbsUrl = !!(urlObj.protocol === 'http:' && urlObj.hostname)
  const actualSsl = ssl && !isHttpAbsUrl
  const defaultPort = actualSsl ? 443 : 80
  const protocol = actualSsl ? 'https:' : 'http:'
  // 过滤 HTTP/2 伪头（:method, :path, :authority, :scheme），
  // 它们在上游 HTTP/1.1 请求中不合法
  const headers = Object.fromEntries(
    Object.entries(req.headers).filter(([key]) => !key.startsWith(':')),
  )
  let externalProxyUrl = null

  if (externalProxy) {
    if (typeof externalProxy === 'string') {
      externalProxyUrl = externalProxy
    } else if (typeof externalProxy === 'function') {
      try {
        externalProxyUrl = externalProxy(req, ssl)
      } catch (e) {
        log.error('externalProxy error:', e)
      }
    }
  }

  // 解析host和port
  const arr = util.parseHostnameAndPort(req.headers.host)
  const hostname = arr[0]
  const port = arr[1] || defaultPort

  delete headers['proxy-connection']
  let agent
  if (!externalProxyUrl) {
    // keepAlive
    if (headers.connection !== 'close') {
      const timeoutConfig = getTimeoutConfig(hostname, serverSetting)
      // log.info(`get timeoutConfig '${hostname}':`, timeoutConfig)
      agent = createAgent(protocol, timeoutConfig, serverSetting.verifySsl)
      headers.connection = 'keep-alive'
    } else {
      agent = false
    }
  } else {
    agent = util.getTunnelAgent(protocol === 'https:', externalProxyUrl)
  }

  // 初始化options
  const options = {
    protocol,
    method: req.method,
    url: req.url,
    hostname,
    port,
    path: urlObj.path,
    headers,
    agent,
    compatibleConfig,
    // 增大响应头大小限制（默认 16KB），
    // 解决 issue #575 中 Google Cloud Console 等站点响应头过大导致的 HPE_HEADER_OVERFLOW 错误
    maxHeaderSize: 65536,
  }

  if (protocol === 'http:' && externalProxyUrl) {
    // eslint-disable-next-line node/no-deprecated-api
    const externalUrlObj = URL.parse(externalProxyUrl)
    if (externalUrlObj.protocol === 'http:') {
      options.hostname = externalUrlObj.hostname
      options.port = externalUrlObj.port
      options.path = `http://${externalUrlObj.host}${externalUrlObj.path}`
    }
  }

  // mark a socketId for Agent to bind socket for NTLM
  if (req.socket.customSocketId) {
    options.customSocketId = req.socket.customSocketId
  } else if (headers.authorization) {
    options.customSocketId = req.socket.customSocketId = socketId++
  }

  return options
}

util.getTunnelAgent = (requestIsSSL, externalProxyUrl) => {
  // eslint-disable-next-line node/no-deprecated-api
  const urlObj = URL.parse(externalProxyUrl)
  let protocol = urlObj.protocol || 'http:'
  if (protocol === 'tunnel:') {
    protocol = 'http:'
  }
  let port = urlObj.port
  if (!port) {
    port = protocol === 'http:' ? 80 : 443
  }
  const hostname = urlObj.hostname || 'localhost'

  // Electron 打包应用会忽略 NODE_EXTRA_CA_CERTS，这里显式传入额外 CA 到隧道代理
  const extraCerts = loadExtraCaCerts()
  const caOption = Array.isArray(extraCerts) ? { ca: extraCerts } : {}

  if (requestIsSSL) {
    if (protocol === 'http:') {
      if (!httpsOverHttpAgent) {
        httpsOverHttpAgent = tunnelAgent.httpsOverHttp({
          ...caOption,
          proxy: {
            host: hostname,
            port,
          },
        })
      }
      return httpsOverHttpAgent
    } else {
      if (!httpsOverHttpsAgent) {
        httpsOverHttpsAgent = tunnelAgent.httpsOverHttps({
          ...caOption,
          proxy: {
            host: hostname,
            port,
          },
        })
      }
      return httpsOverHttpsAgent
    }
  } else {
    if (protocol === 'http:') {
      if (!httpOverHttpAgent) {
        httpOverHttpAgent = tunnelAgent.httpOverHttp({
          proxy: {
            host: hostname,
            port,
          },
        })
      }
      return httpOverHttpAgent
    } else {
      if (!httpOverHttpsAgent) {
        httpOverHttpsAgent = tunnelAgent.httpOverHttps({
          proxy: {
            host: hostname,
            port,
          },
        })
      }
      return httpOverHttpsAgent
    }
  }
}
