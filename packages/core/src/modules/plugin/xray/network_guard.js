const http = require('node:http')
const https = require('node:https')

const DEFAULT_LOCAL_NETWORK_CANARY_URLS = [
  'https://www.baidu.com/favicon.ico',
  'https://www.qq.com/favicon.ico',
]
const DEFAULT_LOCAL_NETWORK_CHECK_TIMEOUT_MS = 5000
const DEFAULT_LOCAL_NETWORK_RETRY_DELAY_MS = 15000

function wait (delayMs) {
  return new Promise(resolve => setTimeout(resolve, delayMs))
}

function requestLocalNetworkCanary (url, timeoutMs = DEFAULT_LOCAL_NETWORK_CHECK_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const client = url.startsWith('https') ? https : http
    let settled = false

    const finish = (result) => {
      if (settled) {
        return
      }
      settled = true
      resolve(Boolean(result))
    }

    // canary 请求只需检测网络连通性，不需要验证 SSL 证书。
    // 公司网络常有 SSL 拦截（中间人代理），Node.js 内嵌 CA 库不含公司 CA，
    // 导致证书验证失败误判为网络离线。放宽验证不影响安全性——
    // 这些请求不传输敏感数据，只检测 TCP/TLS 连通性。
    const request = client.get(url, { rejectUnauthorized: false }, (res) => {
      const statusCode = Number(res.statusCode || 0)
      res.resume()
      finish(statusCode >= 200 && statusCode < 400)
    })

    request.setTimeout(timeoutMs, () => {
      request.destroy()
      finish(false)
    })

    request.on('error', () => {
      finish(false)
    })
  })
}

async function detectLocalNetworkAvailability ({
  urls = DEFAULT_LOCAL_NETWORK_CANARY_URLS,
  timeoutMs = DEFAULT_LOCAL_NETWORK_CHECK_TIMEOUT_MS,
  requestFn = requestLocalNetworkCanary,
} = {}) {
  for (const url of urls) {
    const available = await requestFn(url, timeoutMs)
    if (available) {
      return true
    }
  }

  return false
}

async function ensureLocalNetworkAvailability ({
  urls = DEFAULT_LOCAL_NETWORK_CANARY_URLS,
  timeoutMs = DEFAULT_LOCAL_NETWORK_CHECK_TIMEOUT_MS,
  retryDelayMs = DEFAULT_LOCAL_NETWORK_RETRY_DELAY_MS,
  requestFn = requestLocalNetworkCanary,
  shouldContinue = () => true,
  onOffline,
  onRecovered,
} = {}) {
  let attempts = 0

  while (shouldContinue()) {
    const available = await detectLocalNetworkAvailability({
      urls,
      timeoutMs,
      requestFn,
    })

    if (available) {
      if (attempts > 0 && typeof onRecovered === 'function') {
        onRecovered({ attempts })
      }

      return {
        available: true,
        waited: attempts > 0,
        attempts,
      }
    }

    attempts += 1
    if (typeof onOffline === 'function') {
      onOffline({ attempts, retryDelayMs })
    }

    await wait(retryDelayMs)
  }

  return {
    available: false,
    waited: attempts > 0,
    attempts,
  }
}

module.exports = {
  DEFAULT_LOCAL_NETWORK_CANARY_URLS,
  DEFAULT_LOCAL_NETWORK_CHECK_TIMEOUT_MS,
  DEFAULT_LOCAL_NETWORK_RETRY_DELAY_MS,
  requestLocalNetworkCanary,
  detectLocalNetworkAvailability,
  ensureLocalNetworkAvailability,
}