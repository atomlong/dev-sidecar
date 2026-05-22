const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const https = require('node:https')
const http = require('node:http')
const net = require('node:net')
const pluginConfig = require('./config')
const processApi = require('./process')
const portFinder = require('./port-finder')
const parser = require('./parser')
const genConfig = require('./gen_config')
const xrayCache = require('./cache')
const testHelpers = require('./test-helpers')
const networkGuard = require('./network_guard')
const probe = require('./probe')
const geoip = require('./geoip')
const { getXrayExePath } = require('../../../shell/scripts/extra-path/index')

const STARTUP_NODE_LIMIT = 10
const CACHE_REFRESH_INTERVAL = 21600
const CACHE_BATCH_TIMEOUT = 30
const CACHE_REFRESH_BATCH_SIZE = 31
const CACHE_REFRESH_BATCH_SIZE_MAX = 2000
const INITIAL_REFRESH_BATCH_SIZE = 31
const CACHE_PROBE_SAMPLE_INTERVAL = 5
const CACHE_REFRESH_PROBE_SAMPLE_COUNT = 2
const INITIAL_REFRESH_PROBE_SAMPLE_COUNT = 2
const CACHE_PROBE_SAMPLE_TIMEOUT = 15
const INITIAL_REFRESH_BATCH_TIMEOUT = 30
const EGRESS_METADATA_CONCURRENCY = 4
const EGRESS_METADATA_LOOKUP_TIMEOUT = 12000
const EGRESS_IP_LOOKUP_URLS = [
  'http://ipv4.icanhazip.com',
  'http://icanhazip.com',
  'http://ifconfig.me/ip',
  'http://ident.me',
]
const LOCAL_INPUT_STATE_FILE_NAME = 'nodes_cache.state.json'
const LOCAL_INPUT_STATE_SIGNATURE_VERSION = 2
const LOCAL_INPUT_STATE_SEMANTICS_VERSION = 'xray-stage2-local-input-v2'

const SUBSCRIPTION_SUMMARY_PROTOCOLS = new Set([
  'http',
  'https',
  'socks',
  'socks5',
  'vmess',
  'vless',
  'trojan',
  'ss',
  'ssr',
  'hy2',
  'hysteria',
  'hysteria2',
  'tuic',
  'wireguard',
  'anytls',
])

function appendItems (target, items) {
  if (!Array.isArray(target) || !Array.isArray(items) || items.length === 0) {
    return target
  }

  for (const item of items) {
    target.push(item)
  }

  return target
}

function appendUniqueNodes (target, seen, nodes) {
  if (!Array.isArray(target) || !seen || !Array.isArray(nodes) || nodes.length === 0) {
    return target
  }

  for (const node of nodes) {
    const fingerprint = xrayCache.fingerprintNode(node)
    if (!fingerprint || seen.has(fingerprint)) {
      continue
    }
    seen.add(fingerprint)
    target.push(node)
  }

  return target
}

function normalizePositiveInt (value, fallback) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    return fallback
  }

  const normalized = Math.floor(parsed)
  return normalized > 0 ? normalized : fallback
}

function normalizeNonNegativeInt (value, fallback) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    return fallback
  }

  const normalized = Math.floor(parsed)
  return normalized >= 0 ? normalized : fallback
}

function normalizeCountryCode (value) {
  const normalized = String(value || '').trim().toUpperCase()
  return /^[A-Z]{2}$/.test(normalized) ? normalized : ''
}

function normalizeOwnerFilterKeyword (value) {
  return String(value || '').trim().toLowerCase()
}

function buildCacheEntryQueryOptions ({ allowedCountries, allowedOwners, stableOnly = false, maxDelayMs = 0, limit = null, offset = 0, orderBy = 'default' } = {}) {
  const countryFilters = geoip.parseCountryFilters(allowedCountries)
  const ownerFilters = parseOwnerFilters(allowedOwners)

  return {
    stableOnly,
    maxDelayMs,
    limit,
    offset,
    orderBy,
    countryInclude: countryFilters.include,
    countryExclude: countryFilters.exclude,
    ownerInclude: ownerFilters.include,
    ownerExclude: ownerFilters.exclude,
  }
}

function parseOwnerFilters (value) {
  const include = []
  const exclude = []
  const tokens = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[\s,;]+/)
      : []

  for (const token of tokens) {
    const normalized = normalizeOwnerFilterKeyword(token)
    if (!normalized) {
      continue
    }

    if (normalized.startsWith('!')) {
      const keyword = normalizeOwnerFilterKeyword(normalized.slice(1))
      if (keyword) {
        exclude.push(keyword)
      }
      continue
    }

    include.push(normalized)
  }

  return {
    include: [...new Set(include)],
    exclude: [...new Set(exclude)],
  }
}

function ownerMatchesFilters (owner, ownerFilters) {
  const normalizedOwner = normalizeOwnerFilterKeyword(owner)
  const filters = ownerFilters || { include: [], exclude: [] }
  if (!normalizedOwner) {
    return filters.include.length === 0
  }

  if (Array.isArray(filters.exclude) && filters.exclude.some(keyword => normalizedOwner.includes(keyword))) {
    return false
  }

  if (Array.isArray(filters.include) && filters.include.length > 0) {
    return filters.include.some(keyword => normalizedOwner.includes(keyword))
  }

  return true
}

async function mapWithConcurrencyLimit (items, limit, mapper) {
  const results = Array.from({ length: items.length })
  let cursor = 0

  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      results[index] = await mapper(items[index], index)
    }
  }

  const workerCount = Math.max(1, Math.min(limit, items.length))
  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  return results
}

function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function timeoutError (message) {
  const error = new Error(message)
  error.code = 'ETIMEDOUT'
  return error
}

function withTimeout (promise, timeoutMs, message) {
  let timer = null
  const timeoutPromise = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(timeoutError(message)), timeoutMs)
  })
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) {
      clearTimeout(timer)
    }
  })
}

function fetchTextThroughHttpProxy ({ proxyPort, url, timeoutMs = 5000 }) {
  return new Promise((resolve, reject) => {
    const controller = new AbortController()
    let finished = false
    let hardTimer = null
    const finish = (callback, value) => {
      if (finished) {
        return
      }
      finished = true
      if (hardTimer) {
        clearTimeout(hardTimer)
      }
      callback(value)
    }

    const request = http.request({
      host: '127.0.0.1',
      port: proxyPort,
      method: 'GET',
      path: url,
      signal: controller.signal,
      headers: {
        Host: new URL(url).host,
        Accept: 'text/plain, application/json;q=0.9, */*;q=0.1',
        'User-Agent': 'dev-sidecar-xray-egress/1.0',
        Connection: 'close',
      },
    }, (response) => {
      if (response.statusCode !== 200) {
        response.resume()
        finish(reject, new Error(`Unexpected proxy status: ${response.statusCode}`))
        return
      }

      let data = ''
      response.on('data', (chunk) => {
        data += chunk
      })
      response.on('end', () => {
        finish(resolve, data)
      })
      response.on('error', (error) => finish(reject, error))
    })

    hardTimer = setTimeout(() => {
      controller.abort()
      request.destroy(timeoutError(`Proxy request timeout after ${timeoutMs}ms`))
    }, timeoutMs)

    request.setTimeout(timeoutMs, () => {
      controller.abort()
      request.destroy(timeoutError(`Proxy request idle timeout after ${timeoutMs}ms`))
    })

    request.on('error', (error) => finish(reject, error))
    request.end()
  })
}

async function detectEgressAddressThroughProxy ({ proxyPort, timeoutMs = EGRESS_METADATA_LOOKUP_TIMEOUT }) {
  const deadline = Date.now() + timeoutMs
  let lastError = new Error('Egress IP lookup failed')

  while (Date.now() < deadline) {
    for (const lookupUrl of EGRESS_IP_LOOKUP_URLS) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        break
      }

      try {
        const text = await fetchTextThroughHttpProxy({
          proxyPort,
          url: lookupUrl,
          timeoutMs: Math.min(remaining, 4000),
        })
        const candidate = String(text || '').trim().split(/\s+/)[0]
        if (net.isIP(candidate)) {
          return candidate
        }
        lastError = new Error(`Invalid egress IP response from ${lookupUrl}: ${candidate}`)
      } catch (error) {
        lastError = error
      }
    }

    await sleep(250)
  }

  throw lastError
}

function getCacheRefreshIntervalSeconds (cfg) {
  return normalizePositiveInt(cfg.cacheRefreshInterval, CACHE_REFRESH_INTERVAL)
}

function getCacheBatchTimeoutSeconds (cfg) {
  return Math.max(normalizePositiveInt(cfg.cacheBatchTimeout, CACHE_BATCH_TIMEOUT), CACHE_PROBE_SAMPLE_TIMEOUT)
}

function getBootstrapBatchTimeoutSeconds (cfg) {
  return Math.max(normalizePositiveInt(cfg.bootstrapBatchTimeout ?? cfg.initialRefreshBatchTimeout, INITIAL_REFRESH_BATCH_TIMEOUT), CACHE_PROBE_SAMPLE_TIMEOUT)
}

function getBootstrapProbeSamples (cfg) {
  return normalizePositiveInt(cfg.bootstrapProbeSamples ?? cfg.initialRefreshProbeSamples, INITIAL_REFRESH_PROBE_SAMPLE_COUNT)
}

function getCacheRefreshProbeSamples (cfg) {
  return normalizePositiveInt(cfg.cacheRefreshProbeSamples, CACHE_REFRESH_PROBE_SAMPLE_COUNT)
}

function getBootstrapCandidateLimit (cfg) {
  return normalizePositiveInt(cfg.bootstrapCandidateLimit ?? cfg.initialRefreshBatchSize, INITIAL_REFRESH_BATCH_SIZE)
}

function getCacheRefreshBatchSize (cfg) {
  return Math.min(normalizePositiveInt(cfg.cacheRefreshBatchSize, CACHE_REFRESH_BATCH_SIZE), CACHE_REFRESH_BATCH_SIZE_MAX)
}

function getSubscriptionSyncLowWatermark (cfg) {
  return normalizeNonNegativeInt(cfg && cfg.subscriptionSyncLowWatermark, 0)
}

function getSubscriptionStaleAfterDays (cfg) {
  return normalizePositiveInt(cfg && cfg.subscriptionStaleAfterDays, 30)
}

function isCacheRefreshEnabled (cfg) {
  return cfg ? cfg.cacheRefreshEnabled !== false : true
}

function getSubscriptionSyncDecision ({ cachePath, cfg }) {
  const lowWatermark = getSubscriptionSyncLowWatermark(cfg)
  if (lowWatermark <= 0) {
    return {
      lowWatermark,
      effectiveCacheCount: null,
      shouldSkip: false,
    }
  }

  const query = buildCacheEntryQueryOptions({
    stableOnly: true,
    maxDelayMs: normalizeNonNegativeInt(cfg && cfg.maxDelayMs, 0),
    allowedCountries: cfg && cfg.allowedCountries,
    allowedOwners: cfg && cfg.allowedOwners,
  })
  const effectiveCacheCount = xrayCache.countCacheEntries(cachePath, query)

  return {
    lowWatermark,
    effectiveCacheCount,
    shouldSkip: effectiveCacheCount >= lowWatermark,
  }
}

function getLocalInputStatePath (cachePath) {
  return path.join(path.dirname(cachePath), LOCAL_INPUT_STATE_FILE_NAME)
}

function buildLocalInputState ({ manualNodes, subscriptions }) {
  const fingerprints = []
  for (const node of xrayCache.deduplicateNodes(manualNodes || [])) {
    const fingerprint = xrayCache.fingerprintNode(node)
    if (fingerprint) {
      fingerprints.push(fingerprint)
    }
  }

  fingerprints.sort()
  const subscriptionSourceKeys = (Array.isArray(subscriptions) ? subscriptions : [])
    .map((subscription, index) => xrayCache.getSubscriptionSourceKey(subscription, index + 1))
    .filter(Boolean)
    .sort()

  const signaturePayload = {
    signatureVersion: LOCAL_INPUT_STATE_SIGNATURE_VERSION,
    semanticsVersion: LOCAL_INPUT_STATE_SEMANTICS_VERSION,
    manualNodeFingerprints: fingerprints,
    subscriptionSourceKeys,
  }

  const signature = `sha256:${crypto.createHash('sha256').update(JSON.stringify(signaturePayload)).digest('hex')}`
  return {
    signature,
    signatureVersion: LOCAL_INPUT_STATE_SIGNATURE_VERSION,
    semanticsVersion: LOCAL_INPUT_STATE_SEMANTICS_VERSION,
    manualNodeCount: fingerprints.length,
    subscriptionCount: subscriptionSourceKeys.length,
  }
}

function readLocalInputState (statePath) {
  try {
    if (!statePath || !fs.existsSync(statePath)) {
      return null
    }

    const raw = fs.readFileSync(statePath, 'utf-8')
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') {
      return null
    }

    return parsed
  } catch {
    return null
  }
}

function isLocalInputStateMatch (savedState, currentState) {
  if (!savedState || !currentState) {
    return false
  }

  return savedState.signatureVersion === currentState.signatureVersion &&
    savedState.semanticsVersion === currentState.semanticsVersion &&
    savedState.signature === currentState.signature
}

function writeLocalInputState (statePath, state) {
  if (!statePath || !state || typeof state !== 'object') {
    return false
  }

  ensureDir(path.dirname(statePath))
  const tempPath = `${statePath}.${process.pid}.${Date.now()}.tmp`
  const payload = {
    signature: state.signature,
    signatureVersion: state.signatureVersion,
    semanticsVersion: state.semanticsVersion,
    manualNodeCount: state.manualNodeCount,
    subscriptionCount: state.subscriptionCount,
    updatedAt: new Date().toISOString(),
  }

  try {
    fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2))
    fs.renameSync(tempPath, statePath)
    return true
  } catch {
    try {
      fs.rmSync(tempPath, { force: true })
    } catch {
      // ignore cleanup errors
    }
    return false
  }
}

async function filterEntriesByCountries (entries, allowedCountries, options = {}) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return []
  }

  const countryFilters = geoip.parseCountryFilters(allowedCountries)
  if (countryFilters.include.length === 0 && countryFilters.exclude.length === 0) {
    return entries.slice()
  }

  const matched = entries.map((entry) => {
    const entryCountry = normalizeCountryCode(entry.country || entry.countryCode)
    if (!geoip.countryMatchesFilters(entryCountry, countryFilters)) {
      return null
    }

    return {
      ...entry,
      country: entryCountry,
    }
  })

  return matched.filter(Boolean)
}

async function filterEntriesByOwners (entries, allowedOwners) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return []
  }

  const ownerFilters = parseOwnerFilters(allowedOwners)
  if (ownerFilters.include.length === 0 && ownerFilters.exclude.length === 0) {
    return entries.slice()
  }

  const matched = entries.map((entry) => {
    const resolvedOwner = getEntryOwnerLabel(entry)
    if (!ownerMatchesFilters(resolvedOwner, ownerFilters)) {
      return null
    }

    return {
      ...entry,
      owner: resolvedOwner,
    }
  })

  return matched.filter(Boolean)
}

function getEntryOwnerLabel (entry) {
  return xrayCache.resolveOwnerLabel(entry && entry.owner)
}

async function collectBootstrapCandidateEntries (entries, allowedCountries, allowedOwners, limit, options = {}) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return {
      entries: [],
      stats: {
        scannedCount: 0,
        afterCountryCount: 0,
        afterOwnerCount: 0,
      },
    }
  }

  const maxEntries = Math.max(1, normalizePositiveInt(limit, INITIAL_REFRESH_BATCH_SIZE))
  const countryFilters = geoip.parseCountryFilters(allowedCountries)
  const ownerFilters = parseOwnerFilters(allowedOwners)
  const shouldFilterByCountry = countryFilters.include.length > 0 || countryFilters.exclude.length > 0
  const shouldFilterByOwner = ownerFilters.include.length > 0 || ownerFilters.exclude.length > 0
  const matchedEntries = []
  const stats = {
    scannedCount: 0,
    afterCountryCount: 0,
    afterOwnerCount: 0,
  }

  for (const entry of entries) {
    stats.scannedCount += 1

    const entryCountry = normalizeCountryCode(entry.country || entry.countryCode)
    if (shouldFilterByCountry && !geoip.countryMatchesFilters(entryCountry, countryFilters)) {
      continue
    }
    stats.afterCountryCount += 1

    const resolvedOwner = getEntryOwnerLabel(entry)
    if (shouldFilterByOwner && !ownerMatchesFilters(resolvedOwner, ownerFilters)) {
      continue
    }
    stats.afterOwnerCount += 1

    matchedEntries.push({
      ...entry,
      country: entryCountry,
      owner: resolvedOwner || entry.owner || '',
    })

    if (matchedEntries.length >= maxEntries) {
      break
    }
  }

  return {
    entries: matchedEntries,
    stats,
  }
}

function download (url, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http
    const request = client.get(url, (res) => {
      if (res.statusCode !== 200) {
        res.resume()
        reject(new Error(`Request Failed. Status Code: ${res.statusCode}`))
        return
      }

      let data = ''
      res.on('data', (chunk) => {
        data += chunk
      })
      res.on('end', () => {
        resolve(data)
      })
    })

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`Request timeout after ${timeoutMs}ms`))
    })

    request.on('error', (e) => {
      reject(e)
    })
  })
}

function formatSubscriptionUrlForLog (value) {
  const raw = String(value || '').trim()
  if (!raw) {
    return ''
  }

  try {
    const url = new URL(raw)
    url.username = ''
    url.password = ''
    url.search = url.search ? '?...' : ''
    url.hash = ''
    return url.toString()
  } catch {
    return raw.length > 200 ? `${raw.slice(0, 200)}...` : raw
  }
}

function decodeSubscriptionTextForSummary (text) {
  const raw = String(text || '')
  if (raw.includes('://')) {
    return raw
  }

  try {
    let normalized = raw.replace(/\s/g, '').replace(/-/g, '+').replace(/_/g, '/')
    while (normalized.length % 4) {
      normalized += '='
    }
    const decoded = Buffer.from(normalized, 'base64').toString('utf-8')
    return decoded.includes('://') ? decoded : raw
  } catch {
    return raw
  }
}

function summarizeSubscriptionContent (content) {
  const decodedText = decodeSubscriptionTextForSummary(content).replace(/<br\s*\/?>/gi, '\n')
  const protocolCounts = {}
  for (const match of decodedText.matchAll(/\b([a-zA-Z][a-zA-Z0-9+.-]*):\/\//g)) {
    const protocol = match[1].toLowerCase()
    if (!SUBSCRIPTION_SUMMARY_PROTOCOLS.has(protocol)) {
      continue
    }
    protocolCounts[protocol] = (protocolCounts[protocol] || 0) + 1
  }

  return {
    bytes: Buffer.byteLength(String(content || '')),
    lines: decodedText.split(/[\n\r]+/).filter(line => line.trim()).length,
    protocolCounts,
  }
}

function ensureDir (dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true })
  }
}

function getProbeDir (xrayDir) {
  return path.join(xrayDir, 'probe')
}

function isProbeTempFileName (fileName) {
  return /^(config|egress)-.*\.json$/i.test(String(fileName || ''))
}

function cleanupProbeArtifacts (xrayDir) {
  if (!xrayDir) {
    return 0
  }

  const probeDir = getProbeDir(xrayDir)
  if (!fs.existsSync(probeDir)) {
    return 0
  }

  let removedCount = 0
  for (const fileName of fs.readdirSync(probeDir)) {
    const filePath = path.join(probeDir, fileName)
    let stat = null
    try {
      stat = fs.lstatSync(filePath)
    } catch {
      continue
    }

    if (!stat.isFile() || !isProbeTempFileName(fileName)) {
      continue
    }

    try {
      fs.rmSync(filePath, { force: true })
      removedCount += 1
    } catch {
      // ignore cleanup errors
    }
  }

  try {
    fs.rmdirSync(probeDir)
  } catch {
    // ignore non-empty or missing dir
  }

  return removedCount
}

function writeJsonFile (filePath, value) {
  ensureDir(path.dirname(filePath))
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2))
}

function backupFileIfExists (sourcePath, backupPath) {
  if (!sourcePath || !backupPath || !fs.existsSync(sourcePath)) {
    return false
  }

  ensureDir(path.dirname(backupPath))
  fs.copyFileSync(sourcePath, backupPath)
  return true
}

function collectNodesFromLinks (links) {
  if (!Array.isArray(links) || links.length === 0) {
    return []
  }

  const nodes = []
  for (const link of links) {
    if (!link || typeof link !== 'string') {
      continue
    }
    const parsed = parser.parse(link)
    if (parsed.length > 0) {
      appendItems(nodes, parsed)
    }
  }

  if (nodes.length > 0) {
    return xrayCache.deduplicateNodes(nodes)
  }

  return nodes
}

async function loadSubscriptionNodes (subscriptionUrls, log) {
  if (!Array.isArray(subscriptionUrls) || subscriptionUrls.length === 0) {
    return { nodes: [], subscriptions: [] }
  }

  const SUBSCRIPTION_BATCH_SIZE = 5
  const uniqueNodes = []
  const seen = new Set()
  const subscriptions = []
  let rawNodeCount = 0
  const total = subscriptionUrls.length

  for (let i = 0; i < subscriptionUrls.length; i += SUBSCRIPTION_BATCH_SIZE) {
    const batch = subscriptionUrls.slice(i, i + SUBSCRIPTION_BATCH_SIZE)
    const results = await Promise.allSettled(batch.map(async (subUrl, batchIndex) => {
      const subscriptionIndex = i + batchIndex + 1
      const subscriptionLabel = `[${subscriptionIndex}/${total}] ${formatSubscriptionUrlForLog(subUrl)}`
      try {
        log.info(`正在更新订阅: ${subscriptionLabel}`)
        const content = await download(subUrl)
        // Suppress parser's per-node error logs for subscription content
        // since subscriptions often contain malformed/garbage nodes
        const origError = console.error
        const origWarn = console.warn
        console.error = () => {}
        console.warn = () => {}
        try {
          const nodes = parser.parse(content)
          const summary = summarizeSubscriptionContent(content)
          const protocolSummary = Object.entries(summary.protocolCounts)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([protocol, count]) => `${protocol}=${count}`)
            .join(',') || 'none'
          if (nodes.length === 0) {
            log.warn(`订阅解析为空: ${subscriptionLabel}, bytes=${summary.bytes}, lines=${summary.lines}, protocols=${protocolSummary}`)
          } else {
            log.info(`订阅解析成功: ${subscriptionLabel}, nodes=${nodes.length}, bytes=${summary.bytes}, protocols=${protocolSummary}`)
          }
          return {
            url: subUrl,
            displayLabel: subscriptionLabel,
            sortOrder: subscriptionIndex,
            nodes,
          }
        } finally {
          console.error = origError
          console.warn = origWarn
        }
      } catch (e) {
        log.warn(`订阅更新失败: ${subscriptionLabel}`, e.message || e)
        return {
          url: subUrl,
          displayLabel: subscriptionLabel,
          sortOrder: subscriptionIndex,
          nodes: [],
        }
      }
    }))

    for (const result of results) {
      if (result.status === 'fulfilled' && result.value && Array.isArray(result.value.nodes)) {
        const parsedNodes = result.value.nodes
        rawNodeCount += parsedNodes.length
        appendUniqueNodes(uniqueNodes, seen, parsedNodes)
        subscriptions.push({
          sourceKey: xrayCache.getSubscriptionSourceKey(result.value.url, result.value.sortOrder),
          url: result.value.url,
          displayLabel: result.value.displayLabel,
          sortOrder: result.value.sortOrder,
          nodeKeys: xrayCache.deduplicateNodes(parsedNodes)
            .map(node => xrayCache.getNodeKey(node))
            .filter(Boolean),
        })
      }
    }
  }

  log.info(`订阅汇总: 原始 ${rawNodeCount} 个节点, 去重后 ${uniqueNodes.length} 个`)
  return { nodes: uniqueNodes, subscriptions }
}

function getStage3RoundSummaryPath (xrayDir) {
  return path.join(xrayDir, 'stage3-last-round.json')
}

function writeStage3RoundSummary ({ xrayDir, summary }) {
  const summaryPath = getStage3RoundSummaryPath(xrayDir)
  writeJsonFile(summaryPath, summary)
  return summaryPath
}

function createNodeMap (nodes) {
  const map = new Map()
  nodes.forEach((node, index) => {
    map.set(`proxy_${index}`, node)
  })
  return map
}

function createEntryMapByFingerprint (entries) {
  const map = new Map()
  for (const entry of entries || []) {
    const fingerprint = xrayCache.fingerprintNode(entry && entry.node)
    if (fingerprint) {
      map.set(fingerprint, entry)
    }
  }
  return map
}

function getEntryUpdatedAtTime (entry) {
  if (!entry || !entry.updatedAt) {
    return 0
  }

  const time = new Date(entry.updatedAt).getTime()
  return Number.isFinite(time) ? time : 0
}

function sortEntriesForRefresh (entries) {
  return [...entries].sort((left, right) => {
    const leftUpdatedAt = getEntryUpdatedAtTime(left)
    const rightUpdatedAt = getEntryUpdatedAtTime(right)
    if (leftUpdatedAt !== rightUpdatedAt) {
      return leftUpdatedAt - rightUpdatedAt
    }

    const leftDelay = Number.isFinite(left.delay) ? left.delay : Number.POSITIVE_INFINITY
    const rightDelay = Number.isFinite(right.delay) ? right.delay : Number.POSITIVE_INFINITY
    return leftDelay - rightDelay
  })
}

async function resolveEntryEgressMetadata ({ binPath, xrayDir, node, log, timeoutMs = EGRESS_METADATA_LOOKUP_TIMEOUT, probeLifecycle = null }) {
  if (!node || typeof node !== 'object') {
    return { country: '', owner: '' }
  }

  const probeDir = getProbeDir(xrayDir)
  ensureDir(probeDir)
  const configPath = path.join(probeDir, `egress-${Date.now()}-${Math.random().toString(16).slice(2)}.json`)
  const proxyPort = await portFinder.findFreePort()
  const config = genConfig(proxyPort, [node], [], null, CACHE_PROBE_SAMPLE_INTERVAL, {
    observatoryEnableConcurrency: true,
    probeMode: 'none',
  })
  config.routing = {
    domainStrategy: 'AsIs',
    balancers: [],
    rules: [{
      type: 'field',
      network: 'tcp,udp',
      outboundTag: 'proxy_0',
    }],
  }
  delete config.observatory
  delete config.burstObservatory
  writeJsonFile(configPath, config)

  const controller = probe.startXrayProcess({
    binPath,
    configPath,
    log,
    purpose: 'egress',
  })
  if (probeLifecycle && typeof probeLifecycle.registerController === 'function') {
    probeLifecycle.registerController(controller)
  }

  let exitAddress = ''
  try {
    exitAddress = await withTimeout(
      detectEgressAddressThroughProxy({
        proxyPort,
        timeoutMs,
      }),
      timeoutMs + 1000,
      `Egress metadata lookup timeout after ${timeoutMs}ms`
    )
  } finally {
    await controller.stop().catch(() => {})
    if (probeLifecycle && typeof probeLifecycle.unregisterController === 'function') {
      probeLifecycle.unregisterController(controller)
    }
    try {
      fs.rmSync(configPath, { force: true })
    } catch {
      // ignore cleanup errors
    }
  }

  const rangeMap = await geoip.loadGeoipCountryRanges()
  const [country, owner] = await Promise.all([
    geoip.resolveAddressCountry(exitAddress, rangeMap),
    geoip.resolveAddressOwner(exitAddress),
  ])
  return {
    country: normalizeCountryCode(country),
    owner: xrayCache.resolveOwnerLabel(owner),
  }
}

async function annotateProbeEntries (entries, options = {}) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return []
  }

  const existingEntryMap = createEntryMapByFingerprint(options.existingEntries)
  const useEgressMetadata = options.useEgressMetadata !== false
  return mapWithConcurrencyLimit(entries, EGRESS_METADATA_CONCURRENCY, async (entry) => {
    const fingerprint = xrayCache.fingerprintNode(entry && entry.node)
    const existingEntry = fingerprint ? existingEntryMap.get(fingerprint) : null
    const fallbackOwner = xrayCache.resolveOwnerLabel(entry && entry.owner, existingEntry && existingEntry.owner)
    const fallbackCountry = normalizeCountryCode(entry && (entry.country || entry.countryCode) || (existingEntry && existingEntry.country))

    let metadata = null
    if (useEgressMetadata && (!fallbackCountry || !fallbackOwner)) {
      try {
        metadata = await resolveEntryEgressMetadata({
          binPath: options.binPath,
          xrayDir: options.xrayDir,
          node: entry && entry.node,
          log: options.log,
          probeLifecycle: options.probeLifecycle,
        })
      } catch {
        metadata = null
      }
    }

    return {
      ...entry,
      owner: xrayCache.resolveOwnerLabel(metadata && metadata.owner, fallbackOwner),
      country: normalizeCountryCode(metadata && metadata.country) || fallbackCountry,
    }
  })
}

function createCacheSyncPlan (candidateNodes, existingEntries, stats = {}) {
  const existingEntryMap = new Map()
  for (const entry of existingEntries || []) {
    const fingerprint = xrayCache.fingerprintNode(entry && entry.node)
    if (fingerprint) {
      existingEntryMap.set(fingerprint, entry)
    }
  }

  const timestamp = new Date().toISOString()
  stats.countryReadyCount = 0
  const addedEntries = []
  const candidateFingerprints = new Set()

  for (const node of candidateNodes || []) {
    const fingerprint = xrayCache.fingerprintNode(node)
    if (!fingerprint || candidateFingerprints.has(fingerprint)) {
      continue
    }

    candidateFingerprints.add(fingerprint)
    const existingEntry = existingEntryMap.get(fingerprint)
    const entry = {
      node,
      stable: existingEntry ? existingEntry.stable === true : false,
      delay: existingEntry && Number.isFinite(existingEntry.delay) ? existingEntry.delay : null,
      country: existingEntry && existingEntry.country ? existingEntry.country : '',
      owner: existingEntry && existingEntry.owner ? existingEntry.owner : '',
      source: existingEntry && existingEntry.source ? existingEntry.source : 'source-sync',
      updatedAt: existingEntry && existingEntry.updatedAt ? existingEntry.updatedAt : timestamp,
      tag: existingEntry && existingEntry.tag ? existingEntry.tag : '',
    }

    const syncedEntry = {
      ...entry,
      country: normalizeCountryCode(entry.country),
      owner: xrayCache.resolveOwnerLabel(entry.owner),
    }

    if (normalizeCountryCode(syncedEntry.country)) {
      stats.countryReadyCount += 1
    }

    if (!existingEntry) {
      addedEntries.push(syncedEntry)
    }
  }

  const removedNodes = []
  for (const entry of existingEntries || []) {
    const fingerprint = xrayCache.fingerprintNode(entry && entry.node)
    if (fingerprint && !candidateFingerprints.has(fingerprint)) {
      removedNodes.push(entry.node)
    }
  }

  return {
    addedEntries,
    removedNodes,
    hasChanges: addedEntries.length > 0 || removedNodes.length > 0,
    selectedCount: candidateFingerprints.size,
  }
}

const Plugin = function (context) {
  const { config: globalConfig, event, log, server } = context
  let currentProbe = null
  let currentXrayDir = ''
  let cacheRefreshTimer = null
  let refreshGeneration = 0
  const injectedRules = []
  let api = null
  const transientProbeControllers = new Set()

  function registerTransientProbeController (controller) {
    if (controller && typeof controller.stop === 'function') {
      transientProbeControllers.add(controller)
    }
  }

  function unregisterTransientProbeController (controller) {
    transientProbeControllers.delete(controller)
  }

  async function stopTransientProbeControllers () {
    const controllers = [...transientProbeControllers]
    transientProbeControllers.clear()
    await Promise.all(controllers.map(controller => controller.stop().catch(() => {})))
  }

  function cleanupStaleProbeArtifacts () {
    const removedCount = cleanupProbeArtifacts(currentXrayDir)
    if (removedCount > 0) {
      log.info(`Xray 探测临时文件已清理: ${removedCount} 个 -> ${getProbeDir(currentXrayDir)}`)
    }
  }

  function clearCacheRefreshTimer () {
    if (cacheRefreshTimer) {
      clearTimeout(cacheRefreshTimer)
      cacheRefreshTimer = null
    }
  }

  function scheduleCacheRefresh (payload, delayMs) {
    clearCacheRefreshTimer()

    if (!Number.isFinite(delayMs) || delayMs < 0) {
      return
    }

    cacheRefreshTimer = setTimeout(() => {
      cacheRefreshTimer = null
      if (!api.isEnabled()) {
        return
      }

      api.refreshCacheFromCacheOnly(payload).catch((error) => {
        log.warn('Xray 后台节点刷新任务失败:', error)
      })
    }, delayMs)

    if (typeof cacheRefreshTimer.unref === 'function') {
      cacheRefreshTimer.unref()
    }
  }

  function resolveNextCacheRefreshDelay (roundStartedAt, intervalMs) {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      return 0
    }

    if (!Number.isFinite(roundStartedAt) || roundStartedAt <= 0) {
      return intervalMs
    }

    return Math.max(0, roundStartedAt + intervalMs - Date.now())
  }

  async function ensureLocalNetworkAvailabilityForRefresh ({ generation, batchIndex, log }) {
    return networkGuard.ensureLocalNetworkAvailability({
      shouldContinue: () => generation === refreshGeneration,
      onOffline: ({ attempts, retryDelayMs }) => {
        if (attempts !== 1) {
          return
        }

        log.warn(`Xray 缓存周期探测: 批次 ${batchIndex} 检测到本地网络离线，暂停当前批次，${Math.round(retryDelayMs / 1000)} 秒后重试`)
      },
      onRecovered: () => {
        log.info(`Xray 缓存周期探测: 批次 ${batchIndex} 本地网络已恢复，继续重试当前批次`)
      },
    })
  }

  async function probeNodesBatch ({ binPath, cfg, xrayDir, batchNodes, timeoutMs, probeSamples = CACHE_REFRESH_PROBE_SAMPLE_COUNT }) {
    const effectiveProbeSamples = normalizePositiveInt(probeSamples, CACHE_REFRESH_PROBE_SAMPLE_COUNT)

    if (!Array.isArray(batchNodes) || batchNodes.length === 0) {
      return []
    }

    ensureDir(xrayDir)
    const probeDir = path.join(xrayDir, 'probe')
    ensureDir(probeDir)
    const probeConfigPath = path.join(probeDir, `config-${Date.now()}-${Math.random().toString(16).slice(2)}.json`)
    const probePort = await portFinder.findFreePort()
    const metricsPort = await portFinder.findFreePort()

    const probeConfig = genConfig(probePort, batchNodes, cfg.rules, cfg.probeUrl, CACHE_PROBE_SAMPLE_INTERVAL, {
      metricsPort,
      observatoryEnableConcurrency: true,
      probeMode: 'burst',
      probeSamples: effectiveProbeSamples,
      probeTimeoutSeconds: CACHE_PROBE_SAMPLE_TIMEOUT,
    })

    writeJsonFile(probeConfigPath, probeConfig)

    const probeController = probe.startProbeProcess({
      binPath,
      configPath: probeConfigPath,
      metricsPort,
      log,
      timeoutMs,
      expectedSamples: effectiveProbeSamples,
      expectedSubjectCount: batchNodes.length,
    })

    currentProbe = probeController

    try {
      const metrics = await probeController.promise
      const observatory = metrics && (metrics.observatory || metrics.burstObservatory || metrics.Observatory || metrics.BurstObservatory)
      if (!observatory) {
        log.warn('Xray 后台探测: metrics 中没有 observatory 数据')
        return []
      }

      const nodeMap = createNodeMap(batchNodes)
      return xrayCache.buildCacheEntriesFromObservatory(observatory, nodeMap, 'background-probe')
    } finally {
      if (currentProbe === probeController) {
        currentProbe = null
      }

      await probeController.stop().catch(() => {})
      try {
        fs.rmSync(probeConfigPath, { force: true })
      } catch {
        // ignore cleanup errors
      }
    }
  }

  api = {
    async start () {
      const cfg = globalConfig.get().plugin.xray
      if (!cfg || !cfg.enabled) {
        return
      }

      const binPath = getXrayExePath()
      if (!fs.existsSync(binPath)) {
        log.error(`Xray 启动失败: 未找到内置 Xray 可执行文件 (${binPath})`)
        throw new Error('Xray binary not found')
      }

      const userBasePath = globalConfig.get().server.setting.userBasePath
      const xrayDir = path.join(userBasePath, 'xray')
      currentXrayDir = xrayDir
      cleanupStaleProbeArtifacts()
      const liveConfigPath = path.join(xrayDir, 'config.json')
      const liveConfigBakPath = path.join(xrayDir, 'config.json.bak')
      const cachePath = path.join(xrayDir, 'nodes_cache.sqlite')
      const startupNodeLimit = normalizePositiveInt(cfg.startupNodeLimit, STARTUP_NODE_LIMIT)
      const allowedCountries = cfg.allowedCountries
      const allowedOwners = cfg.allowedOwners
      const maxDelayMs = normalizeNonNegativeInt(cfg.maxDelayMs, 0)

      // 1. Determine Port
      let port = cfg.localPort
      if (port > 0) {
        const available = await portFinder.isPortAvailable(port)
        if (!available) {
          const msg = `Xray 启动失败: 端口 ${port} 被占用 (Strict Mode)`
          log.error(msg)
          throw new Error(msg)
        }
      } else {
        port = await portFinder.findFreePort()
        log.info(`Xray 自动选择端口: ${port}`)
      }

      globalConfig.get().server.setting.xrayPort = port

      // 2. Stage 1 bootstrap: quickly verify a small set of previous cache nodes,
      // then fall back to last known stable entries if needed.
      const cacheEntryCount = xrayCache.countCacheEntries(cachePath)
      const cacheStableCount = xrayCache.countCacheEntries(cachePath, { stableOnly: true })
      const bootstrapCandidateLimit = getBootstrapCandidateLimit(cfg)
      const stableFallbackQuery = buildCacheEntryQueryOptions({
        stableOnly: true,
        maxDelayMs,
        limit: bootstrapCandidateLimit,
      })
      const bootstrapCandidateQuery = buildCacheEntryQueryOptions({
        limit: bootstrapCandidateLimit,
      })
      const cachedEntriesByDelay = xrayCache.readCacheEntries(cachePath, stableFallbackQuery)
      const bootstrapCandidateEntries = xrayCache.readCacheEntries(cachePath, bootstrapCandidateQuery)
      const fallbackStableEntries = (await collectBootstrapCandidateEntries(cachedEntriesByDelay, allowedCountries, allowedOwners, startupNodeLimit)).entries
      const supportedFallbackEntries = fallbackStableEntries.filter(entry => parser.isNodeSupportedByCurrentXray(entry.node))
      const bootstrapCandidates = bootstrapCandidateEntries.map(entry => entry.node).filter(node => parser.isNodeSupportedByCurrentXray(node))
      log.info(`Xray 启动预检查: cache=${cacheEntryCount}, cacheStable=${cacheStableCount}, stableFallbackLoaded=${cachedEntriesByDelay.length}, stableFallbackFiltered=${fallbackStableEntries.length}, stableFallbackSupported=${supportedFallbackEntries.length}, bootstrapCandidates=${bootstrapCandidateEntries.length}, bootstrapSupported=${bootstrapCandidates.length}, allowedCountries=${Array.isArray(allowedCountries) ? allowedCountries.join(',') : ''}, allowedOwners=${Array.isArray(allowedOwners) ? allowedOwners.join(',') : ''}`)

      let bootstrapSelectedEntries = []

      if (bootstrapCandidates.length > 0) {
        try {
          const bootstrapEntries = await probeNodesBatch({
            binPath,
            cfg,
            xrayDir,
            batchNodes: bootstrapCandidates,
            timeoutMs: getBootstrapBatchTimeoutSeconds(cfg) * 1000,
            probeSamples: getBootstrapProbeSamples(cfg),
          })
          const annotatedBootstrapEntries = await annotateProbeEntries(bootstrapEntries, {
            binPath,
            xrayDir,
            existingEntries: bootstrapCandidateEntries,
            log,
            useEgressMetadata: false,
          })
          const bootstrapByDelay = maxDelayMs > 0
            ? annotatedBootstrapEntries.filter(entry => Number.isFinite(entry.delay) && entry.delay <= maxDelayMs)
            : annotatedBootstrapEntries
          const bootstrapByCountry = await filterEntriesByCountries(bootstrapByDelay, allowedCountries)
          const bootstrapByOwner = await filterEntriesByOwners(bootstrapByCountry, allowedOwners)
          bootstrapSelectedEntries = xrayCache.sortCacheEntries(bootstrapByOwner).slice(0, startupNodeLimit)
          log.info(`Xray 启动前快速复检: cache=${cacheEntryCount}, candidateLimit=${bootstrapCandidateLimit}, queried=${bootstrapCandidateEntries.length}, tested=${bootstrapCandidates.length}, available=${bootstrapEntries.length}, afterDelay=${bootstrapByDelay.length}, afterCountry=${bootstrapByCountry.length}, afterOwner=${bootstrapByOwner.length}, selected=${bootstrapSelectedEntries.length}`)
        } catch (error) {
          log.warn('Xray 启动前快速复检失败，回退到上次稳定缓存:', error)
        }
      }

      const startupNodeCandidates = []
      appendItems(startupNodeCandidates, bootstrapSelectedEntries.map(entry => entry.node))
      appendItems(startupNodeCandidates, supportedFallbackEntries.map(entry => entry.node))
      const startupNodes = xrayCache.deduplicateNodes(startupNodeCandidates).slice(0, startupNodeLimit)

      log.info(`Xray 启动节点候选: cache=${cacheEntryCount}, cacheStable=${cacheStableCount}, fallbackStable=${fallbackStableEntries.length}, fallbackSupported=${supportedFallbackEntries.length}, startupSelected=${startupNodes.length}`)

      if (startupNodes.length === 0) {
        log.warn('Xray 警告: 未找到任何可用节点，将只启用 Direct/Block')
      }

      ensureDir(xrayDir)

      try {
        if (backupFileIfExists(liveConfigPath, liveConfigBakPath)) {
          log.info(`Xray 旧配置已备份: ${liveConfigBakPath}`)
        }
      } catch (error) {
        log.warn('Xray 旧配置备份失败:', error)
      }

      const liveConfig = genConfig(port, startupNodes, cfg.rules, cfg.probeUrl, cfg.probeInterval, {
        observatoryEnableConcurrency: true,
      })
      writeJsonFile(liveConfigPath, liveConfig)
      log.info(`Xray 配置文件已生成: ${liveConfigPath}`)

      // 3. Start live process.
      await api.stopBackgroundProbe()
      await processApi.start(binPath, liveConfigPath)
      event.fire('status', { key: 'plugin.xray.enabled', value: true })
      event.fire('status', { key: 'plugin.xray.port', value: port })

      // 4. Inject rules and reload server.
      await api.injectRules(cfg.rules, port)
      if (server) {
        await server.reload()
      }

      // 5. Kick off detached background stage 2 sync, followed by stage 3 validation.
      api.refreshCacheFromSourcesOnce({
        binPath,
        cfg,
        xrayDir,
        liveConfigPath,
        liveConfigBakPath,
        cachePath,
      }).catch((error) => {
        log.warn('Xray 后台节点刷新任务失败:', error)
      })
    },

    async close () {
      refreshGeneration += 1
      clearCacheRefreshTimer()
      await api.stopBackgroundProbe()
      await stopTransientProbeControllers()
      cleanupStaleProbeArtifacts()
      await api.removeRules()
      if (server) {
        await server.reload()
      }
      await processApi.stop()
      event.fire('status', { key: 'plugin.xray.enabled', value: false })
      log.info('Xray 插件已关闭')
    },

    async restart () {
      await api.close()
      await api.start()
    },

    isEnabled () {
      return globalConfig.get().plugin.xray.enabled
    },

    async stopBackgroundProbe () {
      if (!currentProbe) {
        return
      }

      const probeController = currentProbe
      currentProbe = null
      await probeController.stop().catch(() => {})
    },

    async refreshCacheFromSourcesOnce ({ binPath, cfg, xrayDir, liveConfigPath, liveConfigBakPath, cachePath }) {
      const generation = ++refreshGeneration

      const manualNodes = collectNodesFromLinks(cfg.nodes)
      const subscriptionSyncDecision = getSubscriptionSyncDecision({ cachePath, cfg })
      const localInputStatePath = getLocalInputStatePath(cachePath)
      const currentLocalInputState = buildLocalInputState({ manualNodes, subscriptions: cfg.subscriptions })
      let shouldSkipSubscriptionFetch = subscriptionSyncDecision.shouldSkip

      if (subscriptionSyncDecision.shouldSkip) {
        const savedLocalInputState = readLocalInputState(localInputStatePath)
        if (isLocalInputStateMatch(savedLocalInputState, currentLocalInputState)) {
          log.info(`Xray 第二阶段已跳过: 订阅抓取已跳过且本地输入未变化, effectiveCache=${subscriptionSyncDecision.effectiveCacheCount}, lowWatermark=${subscriptionSyncDecision.lowWatermark}, manualNodes=${currentLocalInputState.manualNodeCount}`)
          if (generation === refreshGeneration) {
            if (!isCacheRefreshEnabled(cfg)) {
              log.info('Xray 缓存周期探测已禁用，跳过第三阶段')
              return
            }
            await api.refreshCacheFromCacheOnly({ binPath, cfg, xrayDir, cachePath })
          }
          return
        }
        shouldSkipSubscriptionFetch = false
      }

      const configSourcePath = fs.existsSync(liveConfigBakPath) ? liveConfigBakPath : liveConfigPath
      const configNodes = xrayCache.extractNodesFromXrayConfigFile(configSourcePath)
      const cacheEntries = xrayCache.readCacheEntries(cachePath)
      const cacheNodes = cacheEntries.map(entry => entry.node)
      let subscriptionNodes = []
      let subscriptionSnapshots = []

      if (shouldSkipSubscriptionFetch) {
        log.info(`Xray 订阅抓取已跳过: effectiveCache=${subscriptionSyncDecision.effectiveCacheCount}, lowWatermark=${subscriptionSyncDecision.lowWatermark}, subscriptions=${Array.isArray(cfg.subscriptions) ? cfg.subscriptions.length : 0}`)
      } else {
        if (subscriptionSyncDecision.lowWatermark > 0) {
          log.info(`Xray 订阅抓取已触发: effectiveCache=${subscriptionSyncDecision.effectiveCacheCount}, lowWatermark=${subscriptionSyncDecision.lowWatermark}, subscriptions=${Array.isArray(cfg.subscriptions) ? cfg.subscriptions.length : 0}`)
        }
        const subscriptionResult = await loadSubscriptionNodes(cfg.subscriptions, log)
        subscriptionNodes = subscriptionResult.nodes
        subscriptionSnapshots = subscriptionResult.subscriptions
      }

      if (generation !== refreshGeneration) {
        return
      }

      const candidateNodeSources = []
      appendItems(candidateNodeSources, configNodes)
      appendItems(candidateNodeSources, cacheNodes)
      appendItems(candidateNodeSources, manualNodes)
      appendItems(candidateNodeSources, subscriptionNodes)
      const deduplicatedCandidateNodes = xrayCache.deduplicateNodes(candidateNodeSources)
      const candidateNodes = deduplicatedCandidateNodes.filter(node => parser.isNodeSupportedByCurrentXray(node))
      const subscriptionFetchMode = shouldSkipSubscriptionFetch ? 'skipped' : 'loaded'
      const effectiveCacheLabel = subscriptionSyncDecision.effectiveCacheCount == null ? 'n/a' : subscriptionSyncDecision.effectiveCacheCount

      log.info(`Xray 节点汇总候选: configBak=${configNodes.length}, cache=${cacheNodes.length}, manual=${manualNodes.length}, subscriptions=${subscriptionNodes.length}, subscriptionFetch=${subscriptionFetchMode}, effectiveCache=${effectiveCacheLabel}, lowWatermark=${subscriptionSyncDecision.lowWatermark}, deduplicated=${deduplicatedCandidateNodes.length}, unsupportedDropped=${deduplicatedCandidateNodes.length - candidateNodes.length}, selected=${candidateNodes.length}`)

      if (candidateNodes.length === 0) {
        log.warn('Xray 节点汇总: 未找到任何候选节点，跳过缓存同步')
        return
      }

      if (generation !== refreshGeneration) {
        return
      }

      const syncStats = { countryReadyCount: 0 }
      const cacheSyncPlan = createCacheSyncPlan(candidateNodes, cacheEntries, syncStats)
      const candidateNodeKeys = new Set(candidateNodes.map(node => xrayCache.getNodeKey(node)).filter(Boolean))
      const acceptedSubscriptionSnapshots = subscriptionSnapshots.map(subscription => ({
        ...subscription,
        nodeKeys: (subscription.nodeKeys || []).filter(nodeKey => candidateNodeKeys.has(nodeKey)),
      }))

      if (!cacheSyncPlan.hasChanges) {
        log.info(`Xray 节点缓存同步已跳过: 候选集未变化, selected=${cacheSyncPlan.selectedCount}, countryReady=${syncStats.countryReadyCount}`)
      } else {
        const touchedNodes = [
          ...cacheSyncPlan.addedEntries.map(entry => entry.node),
          ...cacheSyncPlan.removedNodes,
        ]
        const updated = xrayCache.writeCacheUpdates(cachePath, cacheSyncPlan.addedEntries, touchedNodes)
        if (!updated) {
          throw new Error('Xray SQLite cache is unavailable')
        }
        log.info(`Xray 节点缓存已同步: 新增 ${cacheSyncPlan.addedEntries.length} 个节点, 删除 ${cacheSyncPlan.removedNodes.length} 个节点, selected=${cacheSyncPlan.selectedCount}, countryReady=${syncStats.countryReadyCount} -> ${cachePath}`)
      }

      if (!shouldSkipSubscriptionFetch) {
        const subscriptionSyncStats = xrayCache.syncSubscriptions(cachePath, acceptedSubscriptionSnapshots, {
          staleAfterDays: getSubscriptionStaleAfterDays(cfg),
        })
        if (subscriptionSyncStats) {
          log.info(`Xray 订阅来源已同步: configured=${subscriptionSyncStats.configured}, unconfigured=${subscriptionSyncStats.unconfigured}, refs=${subscriptionSyncStats.refs}`)
        } else {
          log.warn('Xray 订阅来源同步失败')
        }
      }

      if (!writeLocalInputState(localInputStatePath, currentLocalInputState)) {
        log.warn(`Xray 本地输入状态文件写入失败: ${localInputStatePath}`)
      }

      if (generation === refreshGeneration) {
        if (!isCacheRefreshEnabled(cfg)) {
          log.info('Xray 缓存周期探测已禁用，跳过第三阶段')
          return
        }
        await api.refreshCacheFromCacheOnly({ binPath, cfg, xrayDir, cachePath })
      }
    },

    async refreshCacheFromCacheOnly ({ binPath, cfg, xrayDir, cachePath }) {
      if (!isCacheRefreshEnabled(cfg)) {
        log.info('Xray 缓存周期探测已禁用，跳过本轮刷新')
        return
      }

      const generation = ++refreshGeneration
      const roundStartedAt = Date.now()
      const cacheRefreshInterval = getCacheRefreshIntervalSeconds(cfg) * 1000
      const cacheBatchTimeout = getCacheBatchTimeoutSeconds(cfg) * 1000

      const cachedEntryRowIds = xrayCache.readCacheRowIds(cachePath, { orderBy: 'refresh' })
      const configuredBatchSize = normalizePositiveInt(cfg.cacheRefreshBatchSize, CACHE_REFRESH_BATCH_SIZE)
      const batchSize = getCacheRefreshBatchSize(cfg)
      const plannedBatchCount = cachedEntryRowIds.length === 0 ? 0 : Math.ceil(cachedEntryRowIds.length / batchSize)

      if (configuredBatchSize !== batchSize) {
        log.warn(`Xray 缓存周期探测批次大小过大，已自动收敛: requested=${configuredBatchSize}, effective=${batchSize}`)
      }

      if (cachedEntryRowIds.length === 0) {
        log.warn('Xray 缓存周期探测: 缓存文件中没有可探测的节点')
        const nextDelay = resolveNextCacheRefreshDelay(roundStartedAt, cacheRefreshInterval)
        writeStage3RoundSummary({
          xrayDir,
          summary: {
            status: 'empty',
            startedAt: new Date(roundStartedAt).toISOString(),
            endedAt: new Date().toISOString(),
            durationMs: Date.now() - roundStartedAt,
            candidateCount: 0,
            batchSize,
            plannedBatchCount,
            processedBatchCount: 0,
            successBatchCount: 0,
            failedBatchCount: 0,
            availableNodeCount: 0,
            removedNodeCount: 0,
            nextRefreshAt: new Date(Date.now() + nextDelay).toISOString(),
            subscriptions: xrayCache.readSubscriptionAvailabilitySummary(cachePath).filter(subscription => subscription.configured),
          },
        })
        scheduleCacheRefresh({ binPath, cfg, xrayDir, cachePath }, nextDelay)
        return
      }

      log.info(`Xray 缓存周期探测候选: cache=${cachedEntryRowIds.length}, batchSize=${batchSize}`)

      let successBatchCount = 0
      let availableCount = 0
      let removedCount = 0
      let batchIndex = 0
      let processedCount = 0
      const roundAvailableNodeKeys = new Set()

      while (processedCount < cachedEntryRowIds.length) {
        if (generation !== refreshGeneration) {
          return
        }

        const targetBatchRowIds = cachedEntryRowIds.slice(processedCount, processedCount + batchSize)
        const targetBatch = xrayCache.readCacheEntriesByRowIds(cachePath, targetBatchRowIds)
        const candidateNodes = targetBatch.map(entry => entry.node)
        const nextBatchIndex = batchIndex + 1

        if (candidateNodes.length === 0) {
          batchIndex = nextBatchIndex
          processedCount += targetBatchRowIds.length
          log.warn(`Xray 缓存周期探测: 批次 ${batchIndex} 的快照节点已不存在，跳过空批次`)
          continue
        }

        const networkStatusBeforeProbe = await ensureLocalNetworkAvailabilityForRefresh({
          generation,
          batchIndex: nextBatchIndex,
          log,
        })
        if (!networkStatusBeforeProbe.available) {
          return
        }

        log.info(`Xray 缓存周期探测批次: ${nextBatchIndex}, progress=${processedCount}/${cachedEntryRowIds.length}, batchSize=${candidateNodes.length}`)

        try {
          const batchEntries = await probeNodesBatch({
            binPath,
            cfg,
            xrayDir,
            batchNodes: candidateNodes,
            timeoutMs: cacheBatchTimeout,
            probeSamples: getCacheRefreshProbeSamples(cfg),
          })

          if (generation !== refreshGeneration) {
            return
          }

          const annotatedEntries = await annotateProbeEntries(batchEntries, {
            binPath,
            xrayDir,
            existingEntries: targetBatch,
            log,
            probeLifecycle: {
              registerController: registerTransientProbeController,
              unregisterController: unregisterTransientProbeController,
            },
          })
          if (annotatedEntries.length === 0) {
            const networkStatusAfterEmptyResult = await ensureLocalNetworkAvailabilityForRefresh({
              generation,
              batchIndex: nextBatchIndex,
              log,
            })
            if (!networkStatusAfterEmptyResult.available) {
              return
            }
            if (networkStatusAfterEmptyResult.waited) {
              log.warn(`Xray 缓存周期探测: 批次 ${nextBatchIndex} 在本地网络恢复后重试，忽略本次空结果`)
              continue
            }
          }

          if (!xrayCache.writeCacheUpdates(cachePath, annotatedEntries, candidateNodes)) {
            const currentEntries = xrayCache.mergeCacheEntries(xrayCache.readCacheEntries(cachePath), annotatedEntries, candidateNodes)
            xrayCache.writeCache(cachePath, currentEntries)
          }
          batchIndex = nextBatchIndex
          processedCount += targetBatchRowIds.length
          successBatchCount += 1
          availableCount += annotatedEntries.length
          removedCount += Math.max(0, candidateNodes.length - annotatedEntries.length)
          for (const entry of annotatedEntries) {
            const nodeKey = xrayCache.getNodeKey(entry && entry.node)
            if (nodeKey) {
              roundAvailableNodeKeys.add(nodeKey)
            }
          }

          log.info(`Xray 缓存周期探测批次已写回: ${batchIndex}, available=${annotatedEntries.length}, cache=${cachedEntryRowIds.length} -> ${cachePath}`)

          if (annotatedEntries.length === 0) {
            log.warn(`Xray 缓存周期探测: 批次 ${batchIndex} 没有可用节点`)
          }
        } catch (error) {
          if (generation !== refreshGeneration) {
            return
          }

          const networkStatusAfterFailure = await ensureLocalNetworkAvailabilityForRefresh({
            generation,
            batchIndex: nextBatchIndex,
            log,
          })
          if (!networkStatusAfterFailure.available) {
            return
          }
          if (networkStatusAfterFailure.waited) {
            log.warn(`Xray 缓存周期探测: 批次 ${nextBatchIndex} 因本地网络离线暂停，恢复后重试`, error)
            continue
          }

          batchIndex = nextBatchIndex
          processedCount += targetBatchRowIds.length
          log.warn(`Xray 缓存周期探测批次失败: ${batchIndex}`, error)
        }
      }

      if (generation !== refreshGeneration) {
        return
      }

      if (successBatchCount === 0) {
        log.warn('Xray 缓存周期探测: 所有批次都失败，保留原缓存')
        const nextDelay = resolveNextCacheRefreshDelay(roundStartedAt, cacheRefreshInterval)
        const nextRefreshAt = new Date(Date.now() + nextDelay).toISOString()
        writeStage3RoundSummary({
          xrayDir,
          summary: {
            status: 'all_failed',
            startedAt: new Date(roundStartedAt).toISOString(),
            endedAt: new Date().toISOString(),
            durationMs: Date.now() - roundStartedAt,
            candidateCount: cachedEntryRowIds.length,
            batchSize,
            plannedBatchCount,
            processedBatchCount: batchIndex,
            successBatchCount,
            failedBatchCount: batchIndex - successBatchCount,
            availableNodeCount: availableCount,
            removedNodeCount: 0,
            nextRefreshAt,
            subscriptions: xrayCache.readSubscriptionAvailabilitySummary(cachePath).filter(subscription => subscription.configured),
          },
        })
        scheduleCacheRefresh({ binPath, cfg, xrayDir, cachePath }, nextDelay)
        return
      }

      log.info(`Xray 缓存文件已刷新: 全量检测 ${cachedEntryRowIds.length} 个节点，成功批次 ${successBatchCount}/${batchIndex}，保留 ${availableCount} 个可用节点 -> ${cachePath}`)

      if (generation === refreshGeneration) {
        const roundStatus = successBatchCount === plannedBatchCount ? 'completed' : 'partial'
        const availabilityResult = roundStatus === 'completed'
          ? xrayCache.updateSubscriptionAvailability(cachePath, {
              staleAfterDays: getSubscriptionStaleAfterDays(cfg),
              availableNodeKeys: [...roundAvailableNodeKeys],
            })
          : null
        if (availabilityResult && availabilityResult.deleted.length > 0) {
          log.info(`Xray stale 订阅元数据已删除: ${availabilityResult.deleted.length} 个`)
        }
        const nextDelay = resolveNextCacheRefreshDelay(roundStartedAt, cacheRefreshInterval)
        const nextRefreshAt = new Date(Date.now() + nextDelay).toISOString()
        const summaryPath = writeStage3RoundSummary({
          xrayDir,
          summary: {
            status: roundStatus,
            startedAt: new Date(roundStartedAt).toISOString(),
            endedAt: new Date().toISOString(),
            durationMs: Date.now() - roundStartedAt,
            candidateCount: cachedEntryRowIds.length,
            batchSize,
            plannedBatchCount,
            processedBatchCount: batchIndex,
            successBatchCount,
            failedBatchCount: batchIndex - successBatchCount,
            availableNodeCount: availableCount,
            removedNodeCount: removedCount,
            nextRefreshAt,
            subscriptions: (availabilityResult ? availabilityResult.summary : xrayCache.readSubscriptionAvailabilitySummary(cachePath, { availableNodeKeys: [...roundAvailableNodeKeys] }))
              .filter(subscription => subscription.configured)
              .sort((left, right) => {
                if (left.availableNodeCount !== right.availableNodeCount) {
                  return right.availableNodeCount - left.availableNodeCount
                }
                return left.sortOrder - right.sortOrder
              }),
          },
        })
        log.info(`Xray 阶段三轮次汇总已写入: ${summaryPath}`)
        scheduleCacheRefresh({ binPath, cfg, xrayDir, cachePath }, nextDelay)
      }
    },

    async injectRules (rules, port) {
      if (!rules || !Array.isArray(rules))
        return

      const intercepts = globalConfig.get().server.intercepts
      const ruleDomains = new Set()

      rules.forEach((rule) => {
        if (rule.domain) {
          const domains = Array.isArray(rule.domain) ? rule.domain : [rule.domain]
          domains.forEach(d => ruleDomains.add(d))
        }
      })

      for (const domain of ruleDomains) {
        if (intercepts[domain]) {
          log.warn(`规则冲突: 域名 ${domain} 已存在拦截规则，Xray 插件跳过注入。`)
          continue
        }

        intercepts[domain] = {
          '.*': {
            proxy: `tunnel://127.0.0.1:${port}`,
            desc: 'Auto-injected by Xray Plugin',
          },
        }
        injectedRules.push(domain)
        log.info(`Xray 规则注入: ${domain} -> tunnel://127.0.0.1:${port}`)
      }
    },

    async removeRules () {
      const intercepts = globalConfig.get().server.intercepts
      for (const domain of injectedRules) {
        if (intercepts[domain] && intercepts[domain]['.*'] && intercepts[domain]['.*'].desc === 'Auto-injected by Xray Plugin') {
          delete intercepts[domain]
          log.info(`Xray 规则移除: ${domain}`)
        }
      }
      injectedRules.length = 0
    },
  }

  return api
}

module.exports = {
  key: 'xray',
  config: pluginConfig,
  status: {
    enabled: false,
    port: 0,
  },
  plugin: Plugin,
  __test: {
    ...testHelpers,
  },
}
