const URL = require('node:url')

const REMOVE = '[remove]'

function replaceVar (str, rOptions) {
  if (typeof str !== 'string') return str
  const orig = rOptions.original || rOptions.origional || {}
  const hostname = orig.hostname || rOptions.hostname
  const host = (orig.headers && orig.headers.host) || rOptions.headers.host || hostname
  const protocol = orig.protocol || rOptions.protocol
  const port = orig.port || rOptions.port
  const path = orig.path || rOptions.path
  const method = orig.method || rOptions.method
  const url = `${protocol}//${host}${((protocol === 'http:' && port == 80) || (protocol === 'https:' && port == 443)) ? '' : ':' + port}${path}`

  return str.replace(/\$\{hostname\}/g, hostname)
    .replace(/\$\{host\}/g, host)
    .replace(/\$\{method\}/g, method)
    .replace(/\$\{path\}/g, path)
    .replace(/\$\{protocol\}/g, protocol)
    .replace(/\$\{port\}/g, port)
    .replace(/\$\{url\}/g, url)
}

const DS_DOWNLOAD_CHECK_RE = /DS_DOWNLOAD/i
const DS_DOWNLOAD_STRIP_RE = /[?&/]?DS_DOWNLOAD(=[^?&/]+)?$/i

function replaceRequestHeaders (rOptions, headers, log) {
  for (const key in headers) {
    let value = headers[key]
    if (value === REMOVE) {
      value = null
    }

    if (value) {
      value = replaceVar(value, rOptions)
      log.debug(`[DS-RequestReplace-Interceptor] replace '${key}': '${rOptions.headers[key.toLowerCase()]}' -> '${value}'`)
      rOptions.headers[key.toLowerCase()] = value
    } else if (rOptions.headers[key.toLowerCase()]) {
      log.debug(`[DS-RequestReplace-Interceptor] remove '${key}': '${rOptions.headers[key.toLowerCase()]}'`)
      delete rOptions.headers[key.toLowerCase()]
    }
  }

  log.debug(`[DS-RequestReplace-Interceptor] 最终headers: \r\n${JSON.stringify(rOptions.headers, null, '\t')}`)
}

function replaceQuery (rOptions, query, req, log) {
  const baseUrl = `${rOptions.protocol}//${rOptions.hostname}:${rOptions.port}`
  const url = new URL(rOptions.path, baseUrl)
  const originalQuery = url.searchParams.toString()

  for (const key in query) {
    let value = query[key]
    if (value === REMOVE) {
      url.searchParams.delete(key)
      log.debug(`[DS-RequestReplace-Interceptor] remove query '${key}'`)
    } else {
      value = replaceVar(value, rOptions)
      url.searchParams.set(key, value)
      log.debug(`[DS-RequestReplace-Interceptor] set query '${key}': '${value}'`)
    }
  }

  const newPath = url.pathname + url.search
  rOptions.path = newPath
  if (req && req.url) {
    req.url = newPath
  }

  log.debug(`[DS-RequestReplace-Interceptor] query: '${originalQuery}' -> '${url.searchParams.toString()}'`)
}

module.exports = {
  name: 'requestReplace',
  priority: 111,
  requestIntercept (context, interceptOpt, req, res, ssl, next) {
    const { rOptions, log } = context

    const requestReplaceConfig = interceptOpt.requestReplace

    let actions = ''

    // 替换请求头
    if (requestReplaceConfig.headers) {
      replaceRequestHeaders(rOptions, requestReplaceConfig.headers, log)
      actions += `${actions ? ',' : ''}headers`
    }

    // 替换查询参数
    if (requestReplaceConfig.query) {
      replaceQuery(rOptions, requestReplaceConfig.query, req, log)
      actions += `${actions ? ',' : ''}query`
    }

    // 替换下载文件请求的请求地址（此功能主要是为了方便拦截配置）
    // 注：要转换为下载请求，需要 responseReplace 拦截器的配合使用。
    if (requestReplaceConfig.doDownload && DS_DOWNLOAD_CHECK_RE.test(rOptions.path)) {
      rOptions.doDownload = true
      rOptions.path = rOptions.path.replace(DS_DOWNLOAD_STRIP_RE, '')
      actions += `${actions ? ',' : ''}path:remove-DS_DOWNLOAD`
    }

    res.setHeader('DS-RequestReplace-Interceptor', actions)

    const url = `${rOptions.method} ➜ ${rOptions.protocol}//${rOptions.hostname}:${rOptions.port}${req.url}`
    log.info('requestReplace intercept:', url)
  },
  is (interceptOpt) {
    return !!interceptOpt.requestReplace
  },
}
