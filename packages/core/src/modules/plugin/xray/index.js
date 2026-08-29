const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const https = require('node:https')
const http = require('node:http')
const net = require('node:net')
const v8 = require('node:v8')
const vm = require('node:vm')
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
const cgroupUtil = require('./util.cgroup')
const xrayApi = require('./xray_api')
const { getXrayExePath } = require('../../../shell/scripts/extra-path/index')

const STAGE2_CACHE_SYNC_CHUNK_SIZE = 2000
const STAGE2_CACHE_SYNC_CHUNK_SIZE_LOW_FILE_CACHE = 500
const STAGE2_SUBSCRIPTION_PARSE_CHUNK_SIZE = 50
const STAGE2_SUBSCRIPTION_PARSE_GC_CHUNKS = 1
const STAGE2_SUBSCRIPTION_ACCEPTED_FLUSH_NODE_COUNT = 100
const STAGE2_SUBSCRIPTION_ACCEPTED_FLUSH_NODE_COUNT_LARGE = 50
const CACHE_SIZE_LIMIT_BYTES = 1 * 1024 * 1024 * 1024
const CACHE_SIZE_TARGET_BYTES = Math.floor(CACHE_SIZE_LIMIT_BYTES * 0.9)
// Stage3 duration 超过 cacheRefreshInterval 时,强制下一轮至少冷却 30 分钟。
// 防止 stage3 完成立刻触发新一轮 → cleanupOutdatedToSizeLimit 同步循环阻塞
// main thread → SIGCHLD 无法 dispatch → mitmproxy 崩溃后无 respawn。
const STAGE3_OVERRUN_COOLDOWN_MS = 30 * 60 * 1000
const LARGE_SUBSCRIPTION_BYTES_THRESHOLD = 5 * 1024 * 1024
const LARGE_SUBSCRIPTION_NODE_THRESHOLD = 50000
const STAGE2_GC_HEAP_USED_THRESHOLD_BYTES = 96 * 1024 * 1024
const CACHE_PROBE_SAMPLE_INTERVAL = 5
const CACHE_PROBE_SAMPLE_TIMEOUT = 15
const CACHE_REFRESH_ROUND_BUDGET_MULTIPLIER = 20
const CACHE_REFRESH_HOT_RATIO = 0.5
const CACHE_REFRESH_NEW_RATIO = 0.3
const CACHE_REFRESH_COLD_RATIO = 0.2
const CACHE_FAILURE_BACKOFF_DAYS = [7, 30, 90]
const EGRESS_METADATA_CONCURRENCY = 4
// Outer cap for the whole egress metadata lookup (port readiness wait +
// IP lookup through the proxy). The per-URL timeout inside
// detectEgressAddressThroughProxy is 8s; with 12 URLs the worst-case
// total is ~96s. This must be large enough to let several URLs be tried.
const EGRESS_METADATA_LOOKUP_TIMEOUT = 90000
const EGRESS_IP_LOOKUP_URLS = [
  // China-accessible IP lookup services listed first. Foreign services
  // (icanhazip, ipify, checkip.amazonaws, etc.) are blocked by the GFW
  // when probed from CN exit nodes: they either hang until timeout or
  // return an ICP filing interception page instead of the real IP.
  // Listing CN services first lets CN nodes resolve in 1-2s instead of
  // burning the whole outer timeout on blocked foreign endpoints.
  // These domestic services return the caller's public IP as plain text
  // and are accessible from both CN and overseas exit nodes.
  // All URLs use HTTP because the probeUrl (observatory) is also HTTP —
  // if a node passes observatory it supports HTTP proxying on port 80,
  // so HTTP IP lookups will work too. HTTPS would require CONNECT
  // tunnel support (port 443) which many free proxy nodes lack.
  'http://ip.3322.net',
  'http://www.bt.cn/Api/getIpAddress',
  'http://myip.ipip.net',
  'http://ipv4.icanhazip.com',
  'http://icanhazip.com',
  'http://ifconfig.me/ip',
  'http://ident.me',
  'http://api.ipify.org',
  'http://checkip.amazonaws.com',
]
const LOCAL_INPUT_STATE_FILE_NAME = 'nodes_cache.state.json'
const LOCAL_INPUT_STATE_SIGNATURE_VERSION = 2
const LOCAL_INPUT_STATE_SEMANTICS_VERSION = 'xray-stage2-local-input-v2'

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

function collectUniqueNodeKeys (nodes) {
  if (!Array.isArray(nodes) || nodes.length === 0) {
    return []
  }

  const nodeKeys = []
  const seenFingerprints = new Set()
  const seenNodeKeys = new Set()

  for (const node of nodes) {
    const fingerprint = xrayCache.fingerprintNode(node)
    if (!fingerprint || seenFingerprints.has(fingerprint)) {
      continue
    }
    seenFingerprints.add(fingerprint)

    const nodeKey = xrayCache.getNodeKey(node)
    if (!nodeKey || seenNodeKeys.has(nodeKey)) {
      continue
    }

    seenNodeKeys.add(nodeKey)
    nodeKeys.push(nodeKey)
  }

  return nodeKeys
}

const {
  formatMemoryUsageMb,
  getCurrentProcessCgroupPath,
  getCgroupMemoryUsage,
} = cgroupUtil

function shouldLogLargeSubscriptionDetail ({ bytes = 0, nodes = 0 } = {}) {
  return Number(bytes) >= LARGE_SUBSCRIPTION_BYTES_THRESHOLD || Number(nodes) >= LARGE_SUBSCRIPTION_NODE_THRESHOLD
}

function getStage2AcceptedFlushNodeCount (subscriptionSnapshot) {
  if (subscriptionSnapshot && subscriptionSnapshot.largeSubscription === true) {
    return STAGE2_SUBSCRIPTION_ACCEPTED_FLUSH_NODE_COUNT_LARGE
  }

  return STAGE2_SUBSCRIPTION_ACCEPTED_FLUSH_NODE_COUNT
}

function yieldToEventLoop () {
  return new Promise(resolve => setImmediate(resolve))
}

let stage2GcExposeAttempted = false

function getStage2GarbageCollector () {
  if (typeof global.gc === 'function') {
    return global.gc
  }

  if (!stage2GcExposeAttempted) {
    stage2GcExposeAttempted = true
    try {
      v8.setFlagsFromString('--expose_gc')
      const exposedGc = vm.runInNewContext('gc')
      if (typeof exposedGc === 'function') {
        global.gc = exposedGc
      }
    } catch {
      // ignore: explicit GC is an optimization for large subscription parsing
    }
  }

  return typeof global.gc === 'function' ? global.gc : null
}

async function runStage2GarbageCollection (log, reason, extra = {}, options = {}) {
  const gc = getStage2GarbageCollector()
  if (!gc) {
    return false
  }

  await yieldToEventLoop()
  try {
    gc()
    await yieldToEventLoop()
    if (options.logAfter !== false) {
    }
    return true
  } catch {
    return false
  }
}

async function reclaimStageSqliteFileCache (log, reason, cachePath, extra = {}, options = {}) {
  if (!cachePath) {
    return false
  }

  xrayCache.dropSqliteFileCache(cachePath, [], {
  })

  // posix_fadvise(DONTNEED) only hints the kernel and often fails to reclaim
  // file pages promptly, especially on cold boot where a 700MB+ SQLite DB scan
  // pulls ~200MB of pages into the cgroup cache. memory.reclaim (Linux 5.19+)
  // forces synchronous reclaim of both file-backed and anonymous pages, which
  // is the only reliable way to drop the cold-boot file-cache spike before it
  // stacks with anon pages and pushes cgroup peak above the target.
  if (process.platform === 'linux') {
    const cgroupPath = getCurrentProcessCgroupPath()
    const cgroupFile = cgroupPath ? path.join(cgroupPath, 'memory.current') : ''
    try {
      const currentBytes = Number.parseInt(fs.readFileSync(cgroupFile, 'utf8').trim(), 10)
      if (Number.isFinite(currentBytes) && currentBytes > 200 * 1024 * 1024) {
        const reclaimTarget = Math.min(currentBytes - 150 * 1024 * 1024, 200 * 1024 * 1024)
        if (reclaimTarget > 0) {
          const reclaimed = xrayCache.reclaimCgroupMemory(reclaimTarget)
        }
      }
    } catch {
      // best-effort: memory.reclaim is optional
    }
  }

  await runStage2GarbageCollection(log, reason, extra, {
    force: options.forceGc === true,
    logSkipped: options.logGcSkipped === true,
  })

  return true
}

function summarizeProtocolCounts (protocolCounts) {
  return Object.entries(protocolCounts || {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([protocol, count]) => `${protocol}=${count}`)
    .join(',') || 'none'
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

function buildCacheEntryQueryOptions ({ allowedCountries, allowedOwners, stableOnly = false, maxDelayMs = 0, limit = null, offset = 0, orderBy = 'default', probedOnly = false } = {}) {
  const countryFilters = geoip.parseCountryFilters(allowedCountries)
  const ownerFilters = parseOwnerFilters(allowedOwners)

  return {
    stableOnly,
    maxDelayMs,
    limit,
    offset,
    orderBy,
    probedOnly,
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

// Polls a TCP port until it accepts a connection, the child process exits, or
// the deadline elapses. Returns true when the port is ready, false otherwise.
// This bridges the gap between spawn() returning and Xray actually binding the
// listen socket — under cgroup memory pressure that delay can exceed 1s.
function waitForProxyPortReady ({ proxyPort, child, timeoutMs = 5000, pollIntervalMs = 100 }) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs
    let socket = null
    let timer = null

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      if (socket) {
        socket.destroy()
        socket = null
      }
    }

    const onChildExit = () => {
      cleanup()
      resolve(false)
    }

    if (child && typeof child.once === 'function') {
      child.once('close', onChildExit)
      child.once('error', onChildExit)
    }

    const poll = () => {
      if (Date.now() >= deadline) {
        cleanup()
        resolve(false)
        return
      }

      if (child && (child.exitCode != null || child.signalCode != null)) {
        cleanup()
        resolve(false)
        return
      }

      socket = new net.Socket()
      socket.setTimeout(pollIntervalMs)
      socket.once('connect', () => {
        cleanup()
        if (child && typeof child.removeListener === 'function') {
          child.removeListener('close', onChildExit)
          child.removeListener('error', onChildExit)
        }
        resolve(true)
      })
      socket.once('error', () => {
        socket = null
        timer = setTimeout(poll, pollIntervalMs)
      })
      socket.once('timeout', () => {
        socket = null
        timer = setTimeout(poll, pollIntervalMs)
      })
      socket.connect(proxyPort, '127.0.0.1')
    }

    poll()
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
  const perUrlTimeout = 8000
  let lastError = new Error('Egress IP lookup failed')

  for (const lookupUrl of EGRESS_IP_LOOKUP_URLS) {
    try {
      const text = await fetchTextThroughHttpProxy({
        proxyPort,
        url: lookupUrl,
        timeoutMs: perUrlTimeout,
      })
      const candidate = String(text || '').trim().split(/\s+/)[0]
      if (net.isIP(candidate)) {
        return candidate
      }
      // Some services (e.g. myip.ipip.net) return "当前 IP：1.2.3.4 来自于：..."
      // Try to extract an IP from the full response body as a fallback.
      const ipMatch = String(text || '').match(/(\d{1,3}\.){3}\d{1,3}/)
      if (ipMatch && net.isIP(ipMatch[0])) {
        return ipMatch[0]
      }
      lastError = new Error(`Invalid egress IP response from ${lookupUrl}: ${candidate}`)
    } catch (error) {
      lastError = error
    }
  }

  throw lastError
}

const CACHE_REFRESH_INTERVAL_MIN_HOURS = 1

function getCacheRefreshIntervalSeconds (cfg) {
  const hours = normalizePositiveInt(cfg.cacheRefreshIntervalHours, pluginConfig.cacheRefreshIntervalHours)
  return Math.max(hours, CACHE_REFRESH_INTERVAL_MIN_HOURS) * 3600
}

function getBootstrapProbeSamples (cfg) {
  return normalizePositiveInt(cfg.bootstrapProbeSamples ?? cfg.initialRefreshProbeSamples, pluginConfig.bootstrapProbeSamples)
}

function getCacheRefreshProbeSamples (cfg) {
  return normalizePositiveInt(cfg.cacheRefreshProbeSamples, pluginConfig.cacheRefreshProbeSamples)
}

function getBootstrapCandidateLimit (cfg) {
  return normalizePositiveInt(cfg.bootstrapCandidateLimit ?? cfg.initialRefreshBatchSize, pluginConfig.bootstrapCandidateLimit)
}

function getCacheRefreshBatchSize (cfg) {
  return resolveStage3BatchLevel(cfg).batchSize
}

// Resolve the stage3 batch level (1-5) to its { batchSize, stage3GcThresholdMB }
// tuple. Falls back to the default level when the user value is missing or out of range.
function resolveStage3BatchLevel (cfg) {
  const table = pluginConfig.STAGE3_BATCH_LEVEL_TABLE
  const defaultLevel = pluginConfig.STAGE3_BATCH_LEVEL_DEFAULT
  const rawLevel = Number.parseInt(cfg && cfg.cacheRefreshBatchLevel, 10)
  const level = Number.isInteger(rawLevel) && rawLevel >= 1 && rawLevel <= 5
    ? rawLevel
    : defaultLevel
  return table[level] || table[defaultLevel]
}

function getSubscriptionSyncLowWatermark (cfg) {
  const raw = cfg && cfg.subscriptionSyncLowWatermark
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) {
    return -1
  }
  return Math.floor(value)
}

function getSubscriptionStaleAfterDays (cfg) {
  return normalizePositiveInt(cfg && cfg.subscriptionStaleAfterDays, 30)
}

function isCacheRefreshEnabled (cfg) {
  return cfg ? cfg.cacheRefreshEnabled !== false : true
}

function isStartupSelectEnabled (cfg) {
  return cfg ? cfg.startupSelectEnabled !== false : true
}

function isSubscriptionSyncEnabled (cfg) {
  return cfg ? cfg.subscriptionSyncEnabled !== false : true
}

const SUBSCRIPTION_SYNC_INTERVAL_HOURS_DEFAULT = 24
const SUBSCRIPTION_SYNC_INTERVAL_HOURS_MIN = 1

function getSubscriptionSyncIntervalHours (cfg) {
  const raw = Number(cfg && cfg.subscriptionSyncIntervalHours)
  if (!Number.isFinite(raw) || raw < SUBSCRIPTION_SYNC_INTERVAL_HOURS_MIN) {
    return SUBSCRIPTION_SYNC_INTERVAL_HOURS_DEFAULT
  }
  return Math.floor(raw)
}

function shouldSkipRemoteFetchDueToCooldown (cachePath, cfg) {
  const intervalHours = getSubscriptionSyncIntervalHours(cfg)
  const lastFetchAt = xrayCache.getStage2LastRemoteFetchAt(cachePath)
  if (lastFetchAt === 0) {
    return false
  }
  const cooldownSeconds = intervalHours * 60 * 60
  const elapsed = Math.floor(Date.now() / 1000) - lastFetchAt
  return elapsed < cooldownSeconds
}

function getSubscriptionSyncDecision ({ cachePath, cfg }) {
  const lowWatermark = getSubscriptionSyncLowWatermark(cfg)
  if (lowWatermark < 0) {
    // Invalid value (negative or non-number): report error, do NOT sync.
    return {
      lowWatermark: cfg && cfg.subscriptionSyncLowWatermark,
      effectiveCacheCount: null,
      shouldSkip: true,
      error: `subscriptionSyncLowWatermark must be a non-negative integer, got: ${cfg && cfg.subscriptionSyncLowWatermark}`,
    }
  }

  const query = buildCacheEntryQueryOptions({
    stableOnly: true,
  })
  const effectiveCacheCount = xrayCache.countCacheEntries(cachePath, query)

  return {
    lowWatermark,
    effectiveCacheCount,
    // Skip fetching only when stable nodes exceed the watermark.
    shouldSkip: effectiveCacheCount > lowWatermark,
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
    updatedAt: xrayCache.formatLocalTimestamp(),
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

  const maxEntries = Math.max(1, normalizePositiveInt(limit, pluginConfig.bootstrapCandidateLimit))
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

function openDownloadReadable (url, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http
    let settled = false
    const request = client.get(url, (res) => {
      if (res.statusCode !== 200) {
        res.resume()
        reject(new Error(`Request Failed. Status Code: ${res.statusCode}`))
        return
      }

      settled = true
      const contentLength = Number(res.headers && res.headers['content-length'])
      resolve({
        readable: res,
        contentLength: Number.isFinite(contentLength) && contentLength >= 0 ? contentLength : 0,
      })
    })

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`Request timeout after ${timeoutMs}ms`))
    })

    request.on('error', (e) => {
      if (!settled) {
        reject(e)
      }
    })
  })
}

async function * countReadableBytes (readable, onBytes) {
  let bytes = 0
  for await (const item of readable) {
    const buffer = Buffer.isBuffer(item) ? item : Buffer.from(item)
    bytes += buffer.length
    if (typeof onBytes === 'function') {
      await onBytes(bytes)
    }
    yield buffer
  }
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

function summarizeParsedSubscription (nodes, content) {
  const protocolCounts = {}
  for (const node of nodes || []) {
    const protocol = String(node && node.protocol || '').toLowerCase()
    if (!protocol) {
      continue
    }
    protocolCounts[protocol] = (protocolCounts[protocol] || 0) + 1
  }

  return {
    bytes: Buffer.byteLength(String(content || '')),
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
  return /^(config|egress|persistent)-.*\.json$/i.test(String(fileName || ''))
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

function readExistingXrayLiveConfig (configPath) {
  if (!configPath || !fs.existsSync(configPath)) {
    return null
  }
  try {
    const raw = fs.readFileSync(configPath, 'utf8')
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.outbounds)) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

function extractInboundPortFromXrayConfig (config) {
  if (!config || !Array.isArray(config.inbounds)) {
    return null
  }
  for (const inbound of config.inbounds) {
    const port = Number(inbound && inbound.port)
    if (Number.isFinite(port) && port > 0) {
      return port
    }
  }
  return null
}

// ...existing code...

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

async function loadSubscriptionNodes (subscriptionUrls, log, options = {}) {
  if (!Array.isArray(subscriptionUrls) || subscriptionUrls.length === 0) {
    return { nodes: [], subscriptions: [], uniqueNodeCount: 0, rawNodeCount: 0, snapshotCount: 0 }
  }

  const SUBSCRIPTION_BATCH_SIZE = 1
  const uniqueNodes = []
  const seen = new Set()
  const seenNodeKeys = new Set()
  const nodeTarget = Array.isArray(options.nodeTarget) ? options.nodeTarget : uniqueNodes
  const maintainLocalNodeArray = nodeTarget === uniqueNodes
  const stage2SeenCachePath = typeof options.stage2SeenCachePath === 'string' && options.stage2SeenCachePath ? options.stage2SeenCachePath : ''
  const nodeSeen = !stage2SeenCachePath && options.nodeSeen instanceof Set ? options.nodeSeen : seenNodeKeys
  const supportedNodeKeysTarget = options.supportedNodeKeysTarget instanceof Set ? options.supportedNodeKeysTarget : null
  const onBatchAccepted = typeof options.onBatchAccepted === 'function' ? options.onBatchAccepted : null
  const onAcceptedNodes = typeof options.onAcceptedNodes === 'function' ? options.onAcceptedNodes : null
  const onAcceptedNodeKeys = typeof options.onAcceptedNodeKeys === 'function' ? options.onAcceptedNodeKeys : null
  const onSubscriptionProgress = typeof options.onSubscriptionProgress === 'function' ? options.onSubscriptionProgress : null
  const subscriptions = maintainLocalNodeArray ? [] : null
  const stage2SeenFilter = stage2SeenCachePath ? xrayCache.createStage2SeenNodeFilter(stage2SeenCachePath) : null
  let pendingAcceptedNodeKeys = []
  let pendingSupportedAcceptedNodes = []
  let pendingSourceMeta = null
  let rawNodeCount = 0
  let snapshotCount = 0
  let acceptedUniqueNodeCount = 0
  const total = subscriptionUrls.length

  if (stage2SeenCachePath && !stage2SeenFilter) {
    throw new Error('Xray stage2 seen-node dedup initialization failed')
  }


  const stage2SeenExtraPaths = stage2SeenCachePath ? [xrayCache.getStage2SeenDbPath(stage2SeenCachePath)].filter(Boolean) : []

  const reclaimStage2SqliteMemory = async (reason, extra = {}, options = {}) => {
    if (!stage2SeenCachePath) {
      return
    }

    if (stage2SeenFilter && typeof stage2SeenFilter.shrinkMemory === 'function') {
      stage2SeenFilter.shrinkMemory()
    }

    xrayCache.dropSqliteFileCache(stage2SeenCachePath, stage2SeenExtraPaths, {
    })

    const shouldRunGc = options.forceGc === true || process.memoryUsage().heapUsed >= STAGE2_GC_HEAP_USED_THRESHOLD_BYTES
    if (shouldRunGc) {
      await runStage2GarbageCollection(log, reason, extra, {
        logAfter: options.logAfterGc !== false,
      })
    }
  }

  const getSubscriptionSourceMeta = (subscriptionSnapshot) => ({
    sourceKey: subscriptionSnapshot.sourceKey,
    url: subscriptionSnapshot.url,
    displayLabel: subscriptionSnapshot.displayLabel,
    sortOrder: subscriptionSnapshot.sortOrder,
  })

  const flushAcceptedBuffers = (sourceMeta = {}) => {
    const meta = pendingSourceMeta || sourceMeta
    const nodeKeysToFlush = pendingAcceptedNodeKeys
    const nodesToFlush = pendingSupportedAcceptedNodes
    const pendingNodeKeyCount = nodeKeysToFlush.length
    const pendingNodeCount = nodesToFlush.length

    pendingAcceptedNodeKeys = []
    pendingSupportedAcceptedNodes = []
    pendingSourceMeta = null

    if (pendingNodeKeyCount > 0 || pendingNodeCount > 0) {
    }

    try {
      if (nodeKeysToFlush.length > 0 && onAcceptedNodeKeys) {
        onAcceptedNodeKeys(nodeKeysToFlush, meta)
      }

      if (!maintainLocalNodeArray && nodesToFlush.length > 0 && onAcceptedNodes) {
        onAcceptedNodes(nodesToFlush, meta)
      }
    } finally {
      nodeKeysToFlush.length = 0
      nodesToFlush.length = 0
    }

    if (pendingNodeKeyCount > 0 || pendingNodeCount > 0) {
    }
  }

  const queueAcceptedBuffers = (acceptedNodeKeys, supportedAcceptedNodes, subscriptionSnapshot) => {
    const sourceMeta = getSubscriptionSourceMeta(subscriptionSnapshot)
    if (pendingSourceMeta && pendingSourceMeta.sourceKey !== sourceMeta.sourceKey) {
      flushAcceptedBuffers()
    }
    pendingSourceMeta = sourceMeta

    if (acceptedNodeKeys.length > 0) {
      for (const nodeKey of acceptedNodeKeys) {
        pendingAcceptedNodeKeys.push(nodeKey)
      }
    }
    if (!maintainLocalNodeArray && supportedAcceptedNodes.length > 0) {
      for (const node of supportedAcceptedNodes) {
        pendingSupportedAcceptedNodes.push(node)
      }
    }

    const flushThreshold = getStage2AcceptedFlushNodeCount(subscriptionSnapshot)
    if (Math.max(pendingAcceptedNodeKeys.length, pendingSupportedAcceptedNodes.length) >= flushThreshold) {
      flushAcceptedBuffers(sourceMeta)
    }
  }

  const processSubscriptionChunk = (parsedNodes, subscriptionSnapshot) => {
    if (!subscriptionSnapshot || !Array.isArray(parsedNodes) || parsedNodes.length === 0) {
      return
    }

    rawNodeCount += parsedNodes.length
    const supportedAcceptedNodes = []
    const acceptedNodeKeySeen = new Set()

    const acceptNode = (node, nodeKey) => {
      if (!parser.isNodeSupportedByCurrentXray(node)) {
        return
      }

      if (!nodeKey) {
        nodeKey = xrayCache.getNodeKey(node)
      }
      if (!nodeKey || acceptedNodeKeySeen.has(nodeKey)) {
        return
      }

      acceptedNodeKeySeen.add(nodeKey)
      supportedAcceptedNodes.push(node)
      if (supportedNodeKeysTarget) {
        supportedNodeKeysTarget.add(nodeKey)
      }
    }

    if (maintainLocalNodeArray) {
      for (const node of parsedNodes) {
        const beforeCount = uniqueNodes.length
        appendUniqueNodes(uniqueNodes, seen, [node])
        if (uniqueNodes.length > beforeCount) {
          acceptNode(node)
        }
      }
    } else if (stage2SeenFilter) {
      acceptedUniqueNodeCount += stage2SeenFilter.acceptNodes(parsedNodes, {
        onAcceptedNode: (node, nodeKey) => {
          acceptNode(node, nodeKey)
        },
      })
    } else {
      for (const node of parsedNodes) {
        const nodeKey = xrayCache.getNodeKey(node)
        if (!nodeKey || seenNodeKeys.has(nodeKey)) {
          continue
        }
        seenNodeKeys.add(nodeKey)
        nodeSeen.add(nodeKey)
        acceptNode(node, nodeKey)
      }
    }

    const acceptedNodeKeys = [...acceptedNodeKeySeen]
    subscriptionSnapshot.acceptedNodeKeyCount = (subscriptionSnapshot.acceptedNodeKeyCount || 0) + acceptedNodeKeys.length

    if (acceptedNodeKeys.length > 0 || supportedAcceptedNodes.length > 0) {
      queueAcceptedBuffers(acceptedNodeKeys, supportedAcceptedNodes, subscriptionSnapshot)
    }
  }

  try {
    for (let i = 0; i < subscriptionUrls.length; i += SUBSCRIPTION_BATCH_SIZE) {
      const batch = subscriptionUrls.slice(i, i + SUBSCRIPTION_BATCH_SIZE)
      const batchSubscriptions = []
      for (let batchIndex = 0; batchIndex < batch.length; batchIndex += 1) {
        const subUrl = batch[batchIndex]
        const subscriptionIndex = i + batchIndex + 1
        const subscriptionLabel = `[${subscriptionIndex}/${total}] ${formatSubscriptionUrlForLog(subUrl)}`
        const subscriptionSnapshot = {
          sourceKey: xrayCache.getSubscriptionSourceKey(subUrl, subscriptionIndex),
          url: subUrl,
          displayLabel: subscriptionLabel,
          sortOrder: subscriptionIndex,
          acceptedNodeKeyCount: 0,
        }
        snapshotCount += 1
        if (subscriptions) {
          subscriptions.push(subscriptionSnapshot)
        }
        batchSubscriptions.push(subscriptionSnapshot)
        if (onSubscriptionProgress) {
          try { onSubscriptionProgress(subscriptionIndex, total, acceptedUniqueNodeCount) } catch { /* progress callback must not break fetch */ }
        }
        try {
          log.info(`正在更新订阅: ${subscriptionLabel}`)
          await reclaimStage2SqliteMemory('pre-subscription-download', {
            subscription: subscriptionLabel,
            processed: subscriptionIndex - 1,
            total,
          })
          let activeReadable = null
          const { readable, contentLength } = await openDownloadReadable(subUrl)
          activeReadable = readable
          let shouldLogDetail = shouldLogLargeSubscriptionDetail({ bytes: contentLength })
          let largeSubscriptionBeforeParseLogged = false
          subscriptionSnapshot.largeSubscription = shouldLogDetail
          const logLargeSubscriptionBeforeParse = async (bytes, reason = 'large-subscription-before-parse') => {
            if (largeSubscriptionBeforeParseLogged) {
              return
            }
            largeSubscriptionBeforeParseLogged = true
            shouldLogDetail = true
            subscriptionSnapshot.largeSubscription = true
            await reclaimStage2SqliteMemory('large-subscription-before-parse-fadvise', {
              subscription: subscriptionLabel,
              bytes,
            }, {
              logAfterGc: false,
            })
            await runStage2GarbageCollection(log, 'large-subscription-before-parse', {
              subscription: subscriptionLabel,
              bytes,
              reason,
            }, {
              logAfter: true,
            })
          }
          if (shouldLogDetail) {
            await logLargeSubscriptionBeforeParse(contentLength, 'content-length')
          }
          const origError = console.error
          const origWarn = console.warn
          console.error = () => {}
          console.warn = () => {}
          try {
            let parsedChunk_count = 0
            const streamingReadable = countReadableBytes(activeReadable, async (bytes) => {
              if (!shouldLogDetail && shouldLogLargeSubscriptionDetail({ bytes })) {
                await logLargeSubscriptionBeforeParse(bytes, 'stream-bytes-threshold')
              }
            })
            const parseSummary = await parser.parseReadableInChunksAsync(streamingReadable, {
              chunkSize: STAGE2_SUBSCRIPTION_PARSE_CHUNK_SIZE,
              yieldEveryChunks: 1,
              onChunk: async (chunkNodes) => {
                if (Array.isArray(chunkNodes) && chunkNodes.length > 0) {
                  processSubscriptionChunk(chunkNodes, subscriptionSnapshot)
                }
                parsedChunk_count += 1
                if (shouldLogDetail && parsedChunk_count % STAGE2_SUBSCRIPTION_PARSE_GC_CHUNKS === 0) {
                  const shouldLogChunkGc = parsedChunk_count === 1 || parsedChunk_count % 100 === 0
                  if (shouldLogChunkGc) {
                  }
                  await runStage2GarbageCollection(log, 'large-subscription-parse-chunks', {
                    subscription: subscriptionLabel,
                    chunks: parsedChunk_count,
                    acceptedNodeKeys: subscriptionSnapshot.acceptedNodeKeyCount,
                  }, {
                    logAfter: shouldLogChunkGc,
                  })
                }
              },
            })
            const contentBytes = Number(parseSummary.bytes) || contentLength || 0
            activeReadable = null
            if (shouldLogDetail) {
              await runStage2GarbageCollection(log, 'large-subscription-after-stream-parse', {
                subscription: subscriptionLabel,
                bytes: contentBytes,
                acceptedNodeKeys: subscriptionSnapshot.acceptedNodeKeyCount,
              }, {
                logAfter: true,
              })
            }
            flushAcceptedBuffers(getSubscriptionSourceMeta(subscriptionSnapshot))
            const summary = {
              bytes: contentBytes,
              protocolCounts: parseSummary.protocolCounts,
            }
            const parsedNodeCount = parseSummary.totalNodes
            const shouldLogPostParseDetail = shouldLogDetail || shouldLogLargeSubscriptionDetail({ bytes: summary.bytes, nodes: parsedNodeCount })
            if (shouldLogPostParseDetail) {
            }
            const protocolSummary = summarizeProtocolCounts(summary.protocolCounts)
            if (parsedNodeCount === 0) {
              log.warn(`订阅解析为空: ${subscriptionLabel}, bytes=${summary.bytes}, protocols=${protocolSummary}`)
            } else {
              log.info(`订阅解析成功: ${subscriptionLabel}, nodes=${parsedNodeCount}, bytes=${summary.bytes}, mode=${parseSummary.streamMode || 'stream'}, protocols=${protocolSummary}`)
            }
            if (shouldLogPostParseDetail) {
            }
            if (shouldLogPostParseDetail) {
              await yieldToEventLoop()
              await runStage2GarbageCollection(log, 'large-subscription', {
                subscription: subscriptionLabel,
                acceptedNodeKeys: subscriptionSnapshot.acceptedNodeKeyCount,
              })
            }
          } finally {
            if (activeReadable && typeof activeReadable.destroy === 'function' && !activeReadable.destroyed) {
              activeReadable.destroy()
            }
            console.error = origError
            console.warn = origWarn
          }
        } catch (e) {
          log.warn(`订阅更新失败: ${subscriptionLabel}`, e.message || e)
        }
      }

      if (batchSubscriptions.length > 0 && onBatchAccepted) {
        await onBatchAccepted(batchSubscriptions, {
          processed: Math.min(i + SUBSCRIPTION_BATCH_SIZE, total),
          total,
          uniqueNodes: maintainLocalNodeArray ? seen.size : (stage2SeenCachePath ? acceptedUniqueNodeCount : seenNodeKeys.size),
        })
      }


      // Drop SQLite file cache pages between subscription batches so the
      // kernel page cache does not accumulate to the full database size
      // inside the cgroup memory accounting.  Without this, the cgroup
      // file cache grows monotonically (up to ~630 MB for a 632 MB
      // database) and inflates the cgroup peak by ~400-500 MB.
      if (stage2SeenCachePath) {
        await reclaimStage2SqliteMemory('post-subscription-batch')
      }

      if (process.memoryUsage().heapUsed >= STAGE2_GC_HEAP_USED_THRESHOLD_BYTES) {
        await runStage2GarbageCollection(log, 'stage2-batch-high-heap', {
          processed: Math.min(i + SUBSCRIPTION_BATCH_SIZE, total),
          total,
        })
      }
    }
  } finally {
    if (stage2SeenFilter && typeof stage2SeenFilter.close === 'function') {
      stage2SeenFilter.close()
    }
  }

  const uniqueNodeCount = maintainLocalNodeArray ? seen.size : (stage2SeenCachePath ? acceptedUniqueNodeCount : seenNodeKeys.size)
  log.info(`订阅汇总: 原始 ${rawNodeCount} 个节点, 去重后 ${uniqueNodeCount} 个`)
  return {
    nodes: maintainLocalNodeArray ? uniqueNodes : [],
    subscriptions: subscriptions || [],
    uniqueNodeCount,
    rawNodeCount,
    snapshotCount,
  }
}

function getStage3RoundSummaryPath (xrayDir) {
  return path.join(xrayDir, 'stage3-last-round.json')
}

function writeStage3RoundSummary ({ xrayDir, summary }) {
  const summaryPath = getStage3RoundSummaryPath(xrayDir)
  writeJsonFile(summaryPath, summary)
  return summaryPath
}

function getProbedNodeStatsPath (xrayDir) {
  return path.join(xrayDir, 'probed-node-stats.json')
}

// Build a human-readable tag from country code and exit IP.
// Format: "🇺🇸 US 1.2.3.4" (flag emoji + country code + exit IP)
function buildNodeTag (country, exitIp) {
  const code = (country && country !== 'unknown') ? country : '??'
  // Convert country code to flag emoji (regional indicator symbols)
  const flag = code.toUpperCase().replace(/./g, char => String.fromCodePoint(127397 + char.charCodeAt(0)))
  const ip = exitIp || 'no-ip'
  return `${flag} ${code} ${ip}`
}

// Generate a shareable proxy link from a parsed node object.
// Supports vless, vmess, trojan, ss, http, socks protocols.
// If customTag is provided, it overrides the node's tag in the link.
function nodeToShareLink (node, customTag) {
  if (!node || !node.protocol) {
    return ''
  }

  const proto = String(node.protocol).toLowerCase()
  const settings = node.settings || {}
  const stream = node.streamSettings || {}
  const tag = encodeURIComponent(customTag || node.tag || '')

  try {
    if (proto === 'vless') {
      const vnext = settings.vnext && settings.vnext[0]
      if (!vnext) return ''
      const user = vnext.users && vnext.users[0]
      if (!user) return ''
      const params = new URLSearchParams()
      params.set('type', stream.network || 'tcp')
      params.set('security', stream.security || 'none')
      if (stream.security === 'tls' && stream.tlsSettings) {
        if (stream.tlsSettings.serverName) params.set('sni', stream.tlsSettings.serverName)
        if (stream.tlsSettings.fingerprint) params.set('fp', stream.tlsSettings.fingerprint)
        if (stream.tlsSettings.alpn) params.set('alpn', stream.tlsSettings.alpn.join(','))
      }
      if (stream.security === 'reality' && stream.realitySettings) {
        if (stream.realitySettings.serverName) params.set('sni', stream.realitySettings.serverName)
        if (stream.realitySettings.publicKey) params.set('pbk', stream.realitySettings.publicKey)
        if (stream.realitySettings.shortId) params.set('sid', stream.realitySettings.shortId)
        if (stream.realitySettings.fingerprint) params.set('fp', stream.realitySettings.fingerprint)
      }
      if (user.flow) params.set('flow', user.flow)
      if (stream.network === 'ws' && stream.wsSettings) {
        if (stream.wsSettings.path) params.set('path', stream.wsSettings.path)
        if (stream.wsSettings.host) params.set('host', stream.wsSettings.host)
      }
      if (stream.network === 'grpc' && stream.grpcSettings) {
        if (stream.grpcSettings.serviceName) params.set('serviceName', stream.grpcSettings.serviceName)
      }
      return `vless://${user.id}@${vnext.address}:${vnext.port}?${params.toString()}#${tag}`
    }

    if (proto === 'vmess') {
      const vnext = settings.vnext && settings.vnext[0]
      if (!vnext) return ''
      const user = vnext.users && vnext.users[0]
      if (!user) return ''
      const vmessObj = {
        v: '2',
        ps: node.tag || '',
        add: vnext.address,
        port: String(vnext.port),
        id: user.id,
        aid: String(user.alterId || 0),
        scy: user.security || 'auto',
        net: stream.network || 'tcp',
        type: 'none',
        host: (stream.wsSettings && stream.wsSettings.host) || (stream.httpSettings && stream.httpSettings.host) || '',
        path: (stream.wsSettings && stream.wsSettings.path) || (stream.httpSettings && stream.httpSettings.path) || '',
        tls: stream.security === 'tls' ? 'tls' : '',
        sni: (stream.tlsSettings && stream.tlsSettings.serverName) || '',
      }
      return `vmess://${Buffer.from(JSON.stringify(vmessObj)).toString('base64')}`
    }

    if (proto === 'trojan') {
      const server = settings.servers && settings.servers[0]
      if (!server) return ''
      const params = new URLSearchParams()
      params.set('type', stream.network || 'tcp')
      params.set('security', stream.security || 'tls')
      if (stream.tlsSettings && stream.tlsSettings.serverName) params.set('sni', stream.tlsSettings.serverName)
      if (stream.network === 'ws' && stream.wsSettings) {
        if (stream.wsSettings.path) params.set('path', stream.wsSettings.path)
        if (stream.wsSettings.host) params.set('host', stream.wsSettings.host)
      }
      return `trojan://${server.password}@${server.address}:${server.port}?${params.toString()}#${tag}`
    }

    if (proto === 'shadowsocks' || proto === 'ss') {
      const server = settings.servers && settings.servers[0]
      if (!server) return ''
      const userInfo = Buffer.from(`${server.method || server.cipher}:${server.password}`).toString('base64')
      return `ss://${userInfo}@${server.address}:${server.port}#${tag}`
    }

    if (proto === 'http' || proto === 'https') {
      const server = settings.servers && settings.servers[0]
      if (!server) return ''
      const scheme = (stream.security === 'tls') ? 'https' : 'http'
      let auth = ''
      if (server.users && server.users[0]) {
        auth = `${encodeURIComponent(server.users[0].user)}:${encodeURIComponent(server.users[0].pass)}@`
      }
      return `${scheme}://${auth}${server.address}:${server.port}#${tag}`
    }

    if (proto === 'socks') {
      const server = settings.servers && settings.servers[0]
      if (!server) return ''
      let auth = ''
      if (server.users && server.users[0]) {
        auth = `${encodeURIComponent(server.users[0].user)}:${encodeURIComponent(server.users[0].pass)}@`
      }
      return `socks://${auth}${server.address}:${server.port}#${tag}`
    }
  } catch {
    return ''
  }

  return ''
}

function writeProbedNodeStats ({ xrayDir, cachePath }) {
  const statsPath = getProbedNodeStatsPath(xrayDir)
  const probedNodeIds = xrayCache.readProbedNodeIdsAtPath(cachePath)
  if (probedNodeIds.length === 0) {
    writeJsonFile(statsPath, { totalProbed: 0, countryDistribution: {}, nodes: [] })
    return statsPath
  }

  const entries = xrayCache.readCacheEntriesByNodeIds(cachePath, probedNodeIds)
  const countryDistribution = {}
  const nodes = []
  for (const entry of entries) {
    const country = entry.country || 'unknown'
    countryDistribution[country] = (countryDistribution[country] || 0) + 1
    nodes.push({
      nodeId: entry.nodeId || null,
      country,
      owner: entry.owner || '',
      exitIp: entry.exitIp || '',
      delay: entry.delay || 0,
      stable: entry.stable === true,
      protocol: (entry.node && (entry.node.protocol || entry.node.type)) || 'unknown',
      shareLink: nodeToShareLink(entry.node, buildNodeTag(country, entry.exitIp)),
    })
  }
  nodes.sort((a, b) => (a.delay || 0) - (b.delay || 0))
  writeJsonFile(statsPath, {
    totalProbed: probedNodeIds.length,
    countryDistribution,
    nodes,
    updatedAt: xrayCache.formatLocalTimestamp(),
  })
  return statsPath
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

function toLocalTimestampAfterMs (delayMs, now = Date.now()) {
  const baseTime = Number(now)
  const safeBaseTime = Number.isFinite(baseTime) ? baseTime : Date.now()
  const normalizedDelay = Number(delayMs)
  const safeDelay = Number.isFinite(normalizedDelay) && normalizedDelay > 0 ? normalizedDelay : 0
  return xrayCache.formatLocalTimestamp(new Date(safeBaseTime + safeDelay))
}

function getFailureBackoffMs (failureStreak) {
  const normalizedStreak = normalizePositiveInt(failureStreak, 1)
  const index = Math.min(CACHE_FAILURE_BACKOFF_DAYS.length - 1, Math.max(0, normalizedStreak - 1))
  return CACHE_FAILURE_BACKOFF_DAYS[index] * 24 * 60 * 60 * 1000
}

function classifyRefreshPriority (entry) {
  if (!entry || typeof entry !== 'object') {
    return 'new'
  }

  if (normalizePositiveInt(entry.failureStreak, 0) > 0) {
    return 'cold'
  }

  if (entry.stable === true) {
    return 'hot'
  }

  return 'new'
}

function takePriorityEntries (items, limit) {
  if (!Array.isArray(items) || items.length === 0 || limit <= 0) {
    return []
  }
  return items.splice(0, Math.min(limit, items.length))
}

function selectStage3RefreshCandidates (entriesWithRowIds, batchSize) {
  const normalizedEntries = Array.isArray(entriesWithRowIds) ? entriesWithRowIds.filter(Boolean) : []
  if (normalizedEntries.length === 0) {
    return {
      selected: [],
      totalDueCount: 0,
      roundBudget: 0,
      distribution: { hot: 0, new: 0, cold: 0 },
    }
  }

  const normalizedBatchSize = Math.max(1, normalizePositiveInt(batchSize, pluginConfig.STAGE3_BATCH_LEVEL_TABLE[pluginConfig.STAGE3_BATCH_LEVEL_DEFAULT].batchSize))
  const roundBudget = Math.min(normalizedEntries.length, normalizedBatchSize * CACHE_REFRESH_ROUND_BUDGET_MULTIPLIER)
  const hot = []
  const fresh = []
  const cold = []
  for (const item of normalizedEntries) {
    const priority = classifyRefreshPriority(item.entry)
    if (priority === 'hot') {
      hot.push(item)
    } else if (priority === 'cold') {
      cold.push(item)
    } else {
      fresh.push(item)
    }
  }

  const selected = []
  const initialHot = Math.floor(roundBudget * CACHE_REFRESH_HOT_RATIO)
  const initialNew = Math.floor(roundBudget * CACHE_REFRESH_NEW_RATIO)
  const initialCold = Math.floor(roundBudget * CACHE_REFRESH_COLD_RATIO)

  selected.push(...takePriorityEntries(hot, initialHot))
  selected.push(...takePriorityEntries(fresh, initialNew))
  selected.push(...takePriorityEntries(cold, initialCold))

  const leftovers = [...hot, ...fresh, ...cold]
  if (selected.length < roundBudget && leftovers.length > 0) {
    selected.push(...leftovers.slice(0, roundBudget - selected.length))
  }

  return {
    selected,
    totalDueCount: normalizedEntries.length,
    roundBudget,
    distribution: {
      hot: selected.filter(item => classifyRefreshPriority(item.entry) === 'hot').length,
      new: selected.filter(item => classifyRefreshPriority(item.entry) === 'new').length,
      cold: selected.filter(item => classifyRefreshPriority(item.entry) === 'cold').length,
    },
  }
}

function applyStage3ProbeResults ({
  cachePath,
  targetBatch,
  annotatedEntries,
  observedFingerprints,
  cacheRefreshIntervalMs,
  now = Date.now(),
}) {
  const successEntriesByFingerprint = new Map()
  for (const entry of annotatedEntries || []) {
    const fingerprint = xrayCache.fingerprintNode(entry && entry.node)
    if (fingerprint) {
      successEntriesByFingerprint.set(fingerprint, entry)
    }
  }

  const observedFingerprintSet = new Set((observedFingerprints || []).filter(Boolean))
  const updatedEntries = []
  const availableNodeKeys = new Set()
  let availableCount = 0
  let removedCount = 0
  let explicitFailureCount = 0
  let partialCoverageCount = 0

  for (const existingEntry of targetBatch || []) {
    const fingerprint = xrayCache.fingerprintNode(existingEntry && existingEntry.node)
    if (!fingerprint) {
      continue
    }

    const successfulEntry = successEntriesByFingerprint.get(fingerprint)
    if (successfulEntry) {
      const mergedEntry = {
        ...existingEntry,
        ...successfulEntry,
        failureStreak: 0,
        nextCheckAt: toLocalTimestampAfterMs(cacheRefreshIntervalMs, now),
      }
      updatedEntries.push(mergedEntry)
      availableCount += 1
      const nodeKey = xrayCache.getNodeKey(mergedEntry.node)
      if (nodeKey) {
        availableNodeKeys.add(nodeKey)
      }
      xrayCache.deleteOutdated(cachePath, fingerprint)
      continue
    }

    if (!observedFingerprintSet.has(fingerprint)) {
      updatedEntries.push(existingEntry)
      partialCoverageCount += 1
      continue
    }

    const nextFailureStreak = Math.max(1, normalizePositiveInt(existingEntry.failureStreak, 0) + 1)
    explicitFailureCount += 1

    if (nextFailureStreak >= 3) {
      removedCount += 1
      xrayCache.upsertOutdated(cachePath, fingerprint, now)
      continue
    }

    updatedEntries.push({
      ...existingEntry,
      stable: false,
      delay: null,
      source: 'background-probe',
      updatedAt: xrayCache.formatLocalTimestamp(new Date(now)),
      nextCheckAt: toLocalTimestampAfterMs(getFailureBackoffMs(nextFailureStreak), now),
      failureStreak: nextFailureStreak,
    })
  }

  return {
    updatedEntries,
    availableNodeKeys: [...availableNodeKeys],
    availableCount,
    removedCount,
    explicitFailureCount,
    partialCoverageCount,
  }
}

// Persistent egress probe: one xray process for all egress lookups in a round.
// Uses fixed tag egress_0, swaps nodes via rmo+ado. Port stays fixed so
// waitForProxyPortReady is only needed once (first node).
let egressProbeController = null

async function startEgressProbeProcess ({ binPath, xrayDir, log }) {
  ensureDir(xrayDir)
  const probeDir = path.join(xrayDir, 'probe')
  ensureDir(probeDir)

  const proxyPort = await portFinder.findFreePort()
  const apiPort = await portFinder.findFreePort()
  const config = genConfig(proxyPort, [], [], null, CACHE_PROBE_SAMPLE_INTERVAL, {
    apiPort,
    observatoryEnableConcurrency: true,
    probeMode: 'none',
  })
  config.routing = {
    domainStrategy: 'AsIs',
    balancers: [],
    rules: [{ type: 'field', network: 'tcp,udp', outboundTag: 'egress_0' }],
  }
  delete config.observatory
  delete config.burstObservatory

  const configPath = path.join(probeDir, `egress-persistent-${Date.now()}-${Math.random().toString(16).slice(2)}.json`)
  writeJsonFile(configPath, config)

  let child, stop
  try {
    ({ child, stop } = probe.startXrayProcess({ binPath, configPath, log, purpose: 'egress' }))
  } catch (err) {
    try { fs.rmSync(configPath, { force: true }) } catch { /* ignore */ }
    throw err
  }

  let portReady = false
  let currentNodeTag = ''
  let portCheckFailed = false

  async function swapNode (node) {
    // Wait for xray API port readiness on first call (xray needs time to
    // initialize gRPC listener after spawn; without this, ado/rmo calls fail
    // with "failed to dial 127.0.0.1:<apiPort>").
    if (!portReady && !portCheckFailed) {
      portReady = await waitForProxyPortReady({ proxyPort: apiPort, child, timeoutMs: 10000 })
      if (!portReady) {
        log.warn(`Xray egress 常驻探测 API 端口 ${apiPort} 10s 内未就绪，后续节点将回退到一次性 spawn`)
        portCheckFailed = true
        throw new Error(`Xray egress 常驻探测 API 端口 ${apiPort} 未就绪`)
      }
    }
    if (portCheckFailed) {
      throw new Error(`Xray egress 常驻探测 API 端口 ${apiPort} 未就绪`)
    }
    // rmo previous node (idempotent)
    if (currentNodeTag) {
      await xrayApi.removeOutbounds(binPath, apiPort, [currentNodeTag]).catch(() => {})
      currentNodeTag = ''
    }
    // ado new node with fixed tag egress_0
    const outbound = parser.sanitizeNodeForCurrentXray(JSON.parse(JSON.stringify(node)))
    outbound.tag = 'egress_0'
    const result = await xrayApi.addOutbounds(binPath, apiPort, [outbound])
    if (result.addedTags.length > 0) {
      currentNodeTag = 'egress_0'
      return true
    }
    return false
  }

  return {
    child,
    proxyPort,
    configPath,
    isPortReady: () => portReady,
    setPortReady: () => { portReady = true },
    swapNode,
    stop: async () => {
      await stop().catch(() => {})
      try { fs.rmSync(configPath, { force: true }) } catch { /* ignore */ }
    },
  }
}

async function resolveEntryEgressMetadata ({ binPath, xrayDir, node, log, timeoutMs = EGRESS_METADATA_LOOKUP_TIMEOUT, probeLifecycle = null, egressController = null }) {
  if (!node || typeof node !== 'object') {
    return { country: '', owner: '' }
  }

  let exitAddress = ''

  if (egressController) {
    try {
      // Persistent egress probe mode: reuse long-lived xray, swap node via ado/rmo
      const added = await egressController.swapNode(node)
      if (!added) {
        log.warn('Xray egress 常驻探测: 节点 ado 失败')
        return { country: '', owner: '' }
      }

      const proxyPort = egressController.proxyPort
      // Wait for port readiness only on first use; subsequent swaps reuse the same port
      if (!egressController.isPortReady()) {
        await waitForProxyPortReady({ proxyPort, child: egressController.child, timeoutMs: 5000 })
        egressController.setPortReady()
      } else {
        // Brief delay after ado to let xray apply the new outbound before proxying
        await new Promise(resolve => setTimeout(resolve, 200))
      }

      try {
        exitAddress = await withTimeout(
          detectEgressAddressThroughProxy({ proxyPort, timeoutMs }),
          timeoutMs + 1000,
          `Egress metadata lookup timeout after ${timeoutMs}ms`,
        )
      } catch {
        exitAddress = ''
      }
    } catch (stickyErr) {
      // swapNode failed (API port not ready) — fall through to legacy one-shot spawn
      log.debug(`Xray egress 常驻探测不可用，回退到一次性 spawn: ${stickyErr.message}`)
    }
  }

  if (!exitAddress && node && typeof node === 'object') {
    // Fallback: spawn a one-shot xray subprocess per node (legacy behavior)
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
      rules: [{ type: 'field', network: 'tcp,udp', outboundTag: 'proxy_0' }],
    }
    delete config.observatory
    delete config.burstObservatory
    writeJsonFile(configPath, config)

    const controller = probe.startXrayProcess({ binPath, configPath, log, purpose: 'egress' })
    if (probeLifecycle && typeof probeLifecycle.registerController === 'function') {
      probeLifecycle.registerController(controller)
    }

    try {
      await waitForProxyPortReady({ proxyPort, child: controller.child, timeoutMs: 5000 })
      exitAddress = await withTimeout(
        detectEgressAddressThroughProxy({ proxyPort, timeoutMs }),
        timeoutMs + 1000,
        `Egress metadata lookup timeout after ${timeoutMs}ms`,
      )
    } finally {
      await controller.stop().catch(() => {})
      if (probeLifecycle && typeof probeLifecycle.unregisterController === 'function') {
        probeLifecycle.unregisterController(controller)
      }
      try { fs.rmSync(configPath, { force: true }) } catch { /* ignore */ }
    }
  }

  const [country, owner] = await Promise.all([
    geoip.resolveAddressCountry(exitAddress),
    geoip.resolveAddressOwner(exitAddress),
  ])
  return {
    country: normalizeCountryCode(country),
    owner: xrayCache.resolveOwnerLabel(owner),
    exitIp: exitAddress || '',
  }
}

async function annotateProbeEntries (entries, options = {}) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return []
  }

  const existingEntryMap = createEntryMapByFingerprint(options.existingEntries)
  const useEgressMetadata = options.useEgressMetadata !== false
  const logger = options.log || console
  const egressController = options.egressController || null
  // Persistent egress probe is single-process serial; legacy mode keeps concurrency 4
  const concurrency = egressController ? 1 : EGRESS_METADATA_CONCURRENCY
  return mapWithConcurrencyLimit(entries, concurrency, async (entry) => {
    const fingerprint = xrayCache.fingerprintNode(entry && entry.node)
    const existingEntry = fingerprint ? existingEntryMap.get(fingerprint) : null
    const fallbackOwner = xrayCache.resolveOwnerLabel(entry && entry.owner, existingEntry && existingEntry.owner)
    const fallbackCountry = normalizeCountryCode(entry && (entry.country || entry.countryCode) || (existingEntry && existingEntry.country))

    let metadata = null
    if (useEgressMetadata && (!fallbackCountry || !fallbackOwner || !(existingEntry && existingEntry.exitIp))) {
      try {
        metadata = await resolveEntryEgressMetadata({
          binPath: options.binPath,
          xrayDir: options.xrayDir,
          node: entry && entry.node,
          log: logger,
          probeLifecycle: options.probeLifecycle,
          egressController,
        })
      } catch (error) {
        logger.warn(`Xray egress metadata 探测失败: delay=${entry && entry.delay}ms, error=${error && error.message}`)
        metadata = null
      }
    }

    const resolvedCountry = normalizeCountryCode(metadata && metadata.country) || fallbackCountry
    const resolvedOwner = xrayCache.resolveOwnerLabel(metadata && metadata.owner, fallbackOwner)

    if (!resolvedCountry || !resolvedOwner) {
      logger.warn(`Xray 节点 metadata 不完整: country=${resolvedCountry || 'unknown'}, owner=${resolvedOwner || 'empty'}, delay=${entry && entry.delay}ms`)
    }

    // If egress metadata lookup was attempted but failed to produce a country,
    // the node cannot provide usable proxy service (rogue proxy, blocked exit,
    // or trojan returning 400). Mark it as unavailable by clearing delay and
    // setting stable=false so it gets removed from the active node pool.
    if (useEgressMetadata && !fallbackCountry && !resolvedCountry) {
      return {
        ...entry,
        owner: '',
        country: '',
        delay: null,
        stable: false,
      }
    }

    return {
      ...entry,
      owner: resolvedOwner,
      country: resolvedCountry,
      exitIp: (metadata && metadata.exitIp) || (existingEntry && existingEntry.exitIp) || '',
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

  const timestamp = xrayCache.formatLocalTimestamp()
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
      nextCheckAt: existingEntry && existingEntry.nextCheckAt ? existingEntry.nextCheckAt : timestamp,
      failureStreak: existingEntry ? normalizePositiveInt(existingEntry.failureStreak, 0) : 0,
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

  return {
    addedEntries,
    removedNodes: [],
    hasChanges: addedEntries.length > 0,
    selectedCount: candidateFingerprints.size,
  }
}

function syncCandidateNodesToCache (cachePath, candidateNodes, options = {}) {
  let supportedCount = 0
  let selectedCount = 0
  let cacheMatchedCount = 0
  let outdatedSkippedCount = 0
  let addedCount = 0
  let countryReadyCount = 0

  const flushChunkSize = options.lowFileCache === true
    ? STAGE2_CACHE_SYNC_CHUNK_SIZE_LOW_FILE_CACHE
    : STAGE2_CACHE_SYNC_CHUNK_SIZE

  const supportedChunk = []
  const flushChunk = () => {
    if (supportedChunk.length === 0) {
      return
    }

    const candidateFingerprints = []
    for (const node of supportedChunk) {
      const fingerprint = xrayCache.fingerprintNode(node)
      if (fingerprint) {
        candidateFingerprints.push(fingerprint)
      }
    }

    if (candidateFingerprints.length === 0) {
      supportedChunk.length = 0
      return
    }

    const cacheEntries = xrayCache.readCacheEntriesByFingerprints(cachePath, candidateFingerprints)
    const outdatedFingerprints = xrayCache.readOutdatedHashSet(cachePath, candidateFingerprints)
    const filteredCandidateNodes = outdatedFingerprints.size > 0
      ? supportedChunk.filter(node => !outdatedFingerprints.has(xrayCache.fingerprintNode(node)))
      : [...supportedChunk]

    const syncStats = { countryReadyCount: 0 }
    const cacheSyncPlan = createCacheSyncPlan(filteredCandidateNodes, cacheEntries, syncStats)
    if (cacheSyncPlan.hasChanges) {
      const initializedEntries = cacheSyncPlan.addedEntries.map(entry => ({
        ...entry,
        nextCheckAt: entry.nextCheckAt || xrayCache.formatLocalTimestamp(new Date()),
        failureStreak: 0,
      }))
      const touchedNodes = initializedEntries.map(entry => entry.node)
      const updated = xrayCache.writeCacheUpdates(cachePath, initializedEntries, touchedNodes, { lowFileCache: options.lowFileCache === true })
      if (!updated) {
        throw new Error('Xray SQLite cache is unavailable')
      }
    }

    selectedCount += cacheSyncPlan.selectedCount
    cacheMatchedCount += cacheEntries.length
    outdatedSkippedCount += supportedChunk.length - filteredCandidateNodes.length
    addedCount += cacheSyncPlan.addedEntries.length
    countryReadyCount += syncStats.countryReadyCount
    supportedChunk.length = 0
  }

  for (const node of candidateNodes || []) {
    if (!parser.isParsedNodeValid(node)) {
      continue
    }
    supportedCount += 1
    supportedChunk.push(node)
    if (supportedChunk.length >= flushChunkSize) {
      flushChunk()
    }
  }

  flushChunk()

  return {
    supportedCount,
    selectedCount,
    cacheMatchedCount,
    outdatedSkippedCount,
    addedCount,
    countryReadyCount,
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
  let currentLivePort = 0
  let currentLiveApiPort = 0
  let currentLiveMetricsPort = 0
  let currentLiveConfigPath = ''
  let currentBinPath = ''
  let liveConfigHasProxyNodes = false
  let isStageRunning = false
  // True only while Stage2 remote subscription fetch is in progress
  let isStage2Running = false
  // Live Stage2 round runtime data for WebUI (null when idle)
  let stage2Runtime = null
  // { startedAt, totalSubscriptions, currentSubscription, fetchedNodes }
  // Track live node-to-tag mapping for API-based hot refresh (Phase 2)
  const currentLiveNodeTags = new Map() // fingerprint -> tag
  let nextProxyTagIndex = 0
  let stickyTimer = null
  let stickyTag = null
  // Stage3 round timing — exposed via getStageStatus for WebUI
  let stage3RoundStartedAt = 0  // ms timestamp of current/last Stage3 round start
  let stage3NextRefreshAt = 0   // ms timestamp of next scheduled Stage3 round
  // Stage3 progress snapshot — updated during refreshCacheFromCacheOnly for WebUI
  let stage3Progress = {
    totalDue: 0, processed: 0, batchIndex: 0, plannedBatchCount: 0,
    successBatchCount: 0, availableCount: 0, explicitFailureCount: 0, removedCount: 0,
  }
  let stickyOpChain = Promise.resolve()

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

  // Query the live xray main process observatory for the number of alive nodes.
  // Returns -1 when metrics are unavailable (port not ready, request failed).
  async function fetchLiveObservatoryAliveCount () {
    if (!currentLiveMetricsPort) {
      return -1
    }
    try {
      return await new Promise((resolve) => {
        const req = http.get(`http://127.0.0.1:${currentLiveMetricsPort}/debug/vars`, (res) => {
          let data = ''
          res.on('data', (c) => { data += c })
          res.on('end', () => {
            try {
              const m = JSON.parse(data)
              const obs = (m && (m.observatory || m.burstObservatory || m.Observatory || m.BurstObservatory)) || {}
              resolve(Object.values(obs).filter(s => s && s.alive).length)
            } catch { resolve(-1) }
          })
        })
        req.setTimeout(3000, () => { req.destroy(new Error('timeout')); resolve(-1) })
        req.on('error', () => resolve(-1))
      })
    } catch { return -1 }
  }

  // Auto-release the sticky balancer override, but only when observatory has
  // alive-node data — leastPing with no data selects nothing and traffic drops.
  // Observatory discovers ado-injected nodes only at its next cycle boundary,
  // so the first probeInterval after startup may end before any data exists;
  // in that case extend the lock by 60s (up to MAX_STICKY_AUTO_UNLOCK_EXTENSIONS).
  const STICKY_AUTO_UNLOCK_EXTENSION_MS = 60 * 1000
  const MAX_STICKY_AUTO_UNLOCK_EXTENSIONS = 5
  function armStickyAutoUnlock (logLabel, delayMs) {
    if (stickyTimer) {
      clearTimeout(stickyTimer)
      stickyTimer = null
    }
    let extensions = 0
    const fire = async () => {
      stickyTimer = null
      const aliveCount = await fetchLiveObservatoryAliveCount()
      if (aliveCount === 0 && extensions < MAX_STICKY_AUTO_UNLOCK_EXTENSIONS) {
        extensions++
        log.info(`${logLabel}: observatory 尚无可用节点数据，延长锁定 60s (第 ${extensions}/${MAX_STICKY_AUTO_UNLOCK_EXTENSIONS} 次)`)
        stickyTimer = setTimeout(fire, STICKY_AUTO_UNLOCK_EXTENSION_MS)
        return
      }
      const heldTag = stickyTag
      stickyTag = null
      if (currentLiveApiPort && currentBinPath) {
        await xrayApi.removeBalancerOverride(currentBinPath, currentLiveApiPort, 'balancer-proxy').catch(() => {})
      }
      log.info(`${logLabel}: tag=${heldTag}`)
    }
    stickyTimer = setTimeout(fire, delayMs)
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

  // After Stage3 probes complete, check whether the live config.json nodes
  // need to be refreshed. This runs every Stage3 round:
  //   1. Read current config.json proxy nodes and check their cache status.
  //   2. Remove nodes that are no longer available (delay = 0 or failure_streak >= 3).
  //   3. Fill up to startupNodeLimit from freshly probed available nodes.
  //   4. Only restart xray if the node list actually changed.
  async function maybeRegenerateLiveConfigFromCache ({ binPath, cfg, xrayDir, cachePath, availableNodeKeys = [] }) {
    if (!currentLiveConfigPath || !currentLivePort || !binPath) {
      return
    }

    const startupNodeLimit = normalizePositiveInt(cfg.startupNodeLimit, pluginConfig.startupNodeLimit)
    const allowedCountries = cfg.allowedCountries
    const allowedOwners = cfg.allowedOwners
    const maxDelayMs = normalizeNonNegativeInt(cfg.maxDelayMs, 0)

    // Read current config.json proxy nodes
    const currentConfigNodes = xrayCache.extractNodesFromXrayConfigFile(currentLiveConfigPath)
    // No cold-start rewrite+restart: always use ado/rmo hot refresh.
    // genConfig at Stage1 always creates a balancer framework, so ado-injected
    // nodes are picked up by balancer even when config.json started empty.

    // Hot refresh: check existing config.json nodes against cache
    const currentFingerprints = currentConfigNodes.map(node => xrayCache.fingerprintNode(node)).filter(Boolean)
    let existingEntries = []
    if (currentFingerprints.length > 0) {
      existingEntries = xrayCache.readCacheEntriesByFingerprints(cachePath, currentFingerprints)
    }

    // Keep nodes that are still available (delay > 0, failure_streak < 3)
    const keptNodes = []
    const keptFingerprints = new Set()
    const fingerprintToNode = new Map()
    for (let i = 0; i < currentConfigNodes.length; i++) {
      const fp = currentFingerprints[i]
      if (fp) {
        fingerprintToNode.set(fp, currentConfigNodes[i])
      }
    }
    for (const entry of existingEntries) {
      const fp = xrayCache.fingerprintNode(entry.node)
      if (!fp) {
        continue
      }
      const failureStreak = normalizePositiveInt(entry.failureStreak, 0)
      const delay = Number(entry.delay)
      if (Number.isFinite(delay) && delay > 0 && failureStreak < 3) {
        keptNodes.push(fingerprintToNode.get(fp))
        keptFingerprints.add(fp)
      }
    }

    // If enough existing nodes are still good, no need to restart
    if (keptNodes.length >= startupNodeLimit) {
      return
    }

    // Fill remaining slots from freshly probed available nodes
    const freshProbeQuery = buildCacheEntryQueryOptions({
      allowedCountries,
      allowedOwners,
      maxDelayMs,
      limit: normalizePositiveInt(cfg.bootstrapCandidateLimit, pluginConfig.bootstrapCandidateLimit),
    })
    const freshProbeSourceEntries = xrayCache.readCacheEntriesForStartup(cachePath, freshProbeQuery)
    const freshProbeEntries = (await collectBootstrapCandidateEntries(freshProbeSourceEntries, allowedCountries, allowedOwners, startupNodeLimit)).entries
      .filter(entry => Number.isFinite(entry.delay) && entry.delay > 0)
    const freshSupported = freshProbeEntries.filter(entry => parser.isParsedNodeValid(entry.node))

    const candidateNodes = []
    appendItems(candidateNodes, keptNodes)
    for (const entry of freshSupported) {
      const fp = xrayCache.fingerprintNode(entry.node)
      if (fp && !keptFingerprints.has(fp)) {
        candidateNodes.push(entry.node)
        keptFingerprints.add(fp)
      }
    }
    const selectedNodes = xrayCache.deduplicateNodes(candidateNodes).slice(0, startupNodeLimit)

    if (selectedNodes.length === 0) {
      log.info(`Xray Stage3 后自动重生成: 仍无满足条件的可用节点 (freshSupported=${freshSupported.length}, stableSupported=${supportedFallbackEntries.length}, allowedCountries=${Array.isArray(allowedCountries) ? allowedCountries.join(',') : ''}, allowedOwners=${Array.isArray(allowedOwners) ? allowedOwners.join(',') : ''}, maxDelayMs=${maxDelayMs}, availableNodeKeys=${availableNodeKeys.length})`)
      return
    }

    // Check if the node list actually changed
    const newFingerprints = selectedNodes.map(node => xrayCache.fingerprintNode(node)).filter(Boolean).sort()
    const oldFingerprints = currentFingerprints.filter(Boolean).sort()
    if (newFingerprints.length === oldFingerprints.length && newFingerprints.every((fp, i) => fp === oldFingerprints[i])) {
      return
    }

    // Try API-based hot refresh (zero downtime) if available
    const selectedFingerprints = new Set(selectedNodes.map(node => xrayCache.fingerprintNode(node)).filter(Boolean))
    const canUseApi = currentLiveApiPort > 0 && currentBinPath

    if (canUseApi) {
      // Snapshot current state for rollback if API fails mid-way
      const savedNodeTags = new Map(currentLiveNodeTags)
      const savedNextIndex = nextProxyTagIndex

      // Compute diff: tags to remove (bad/removed nodes) and nodes to add (new nodes)
      const tagsToRemove = []
      for (const [fp, tag] of currentLiveNodeTags) {
        if (!selectedFingerprints.has(fp)) {
          tagsToRemove.push(tag)
        }
      }
      const nodesToAdd = []
      for (const node of selectedNodes) {
        const fp = xrayCache.fingerprintNode(node)
        if (fp && !currentLiveNodeTags.has(fp)) {
          const tag = `proxy_${nextProxyTagIndex++}`
          const outbound = parser.sanitizeNodeForCurrentXray(JSON.parse(JSON.stringify(node)))
          outbound.tag = tag
          nodesToAdd.push({ node, tag, fp, outbound })
        }
      }

      if (tagsToRemove.length === 0 && nodesToAdd.length === 0) {
        return
      }

      try {
        // Add new nodes first (observatory will probe them before they're selectable)
        if (nodesToAdd.length > 0) {
          const addResult = await xrayApi.addOutbounds(currentBinPath, currentLiveApiPort, nodesToAdd.map(n => n.outbound))
          for (const n of nodesToAdd) {
            if (addResult.addedTags.includes(n.tag)) {
              currentLiveNodeTags.set(n.fp, n.tag)
            }
          }
          log.info(`Xray Stage3 后API热刷新: 添加 ${addResult.addedTags.length}/${nodesToAdd.length} 个节点`)
        }
        // Then remove bad nodes (existing connections to them continue, new ones go to fresh nodes)
        let stickyNodeRemoved = false
        if (tagsToRemove.length > 0) {
          // If sticky-locked node is being removed, remember to re-lock below —
          // a bare release would leave leastPing with no data → no selection.
          if (stickyTag && tagsToRemove.includes(stickyTag)) {
            log.warn(`Xray Stage3 后API热刷新: sticky 锁定节点 ${stickyTag} 将被移除，稍后改锁新节点`)
            stickyNodeRemoved = true
            if (stickyTimer) { clearTimeout(stickyTimer); stickyTimer = null }
            stickyTag = null
          }
          const results = await xrayApi.removeOutbounds(currentBinPath, currentLiveApiPort, tagsToRemove)
          for (const r of results) {
            if (r.success) {
              for (const [fp, tag] of currentLiveNodeTags) {
                if (tag === r.tag) {
                  currentLiveNodeTags.delete(fp)
                  break
                }
              }
            } else {
              log.warn(`Xray Stage3 后API热刷新: 移除节点 ${r.tag} 失败: ${r.error}`)
            }
          }
          log.info(`Xray Stage3 后API热刷新: 移除 ${tagsToRemove.length} 个节点`)
        }
        liveConfigHasProxyNodes = currentLiveNodeTags.size > 0
        log.info(`Xray Stage3 后API热刷新完成: liveNodes=${currentLiveNodeTags.size}, kept=${keptNodes.length}, added=${nodesToAdd.length}, removed=${tagsToRemove.length}`)
        // Re-lock the balancer to the best remaining node (by cache delay) so
        // traffic keeps flowing until observatory probes the swapped-in nodes.
        if (stickyNodeRemoved && stickyTag == null && currentLiveNodeTags.size > 0) {
          try {
            const liveFingerprints = [...currentLiveNodeTags.keys()]
            const liveEntries = xrayCache.readCacheEntriesByFingerprints(cachePath, liveFingerprints)
            let bestFp = null
            let bestDelay = Infinity
            for (const e of liveEntries) {
              const d = Number(e.delay)
              if (Number.isFinite(d) && d > 0 && d < bestDelay) {
                bestDelay = d
                bestFp = xrayCache.fingerprintNode(e.node)
              }
            }
            const newTag = bestFp ? currentLiveNodeTags.get(bestFp) : null
            if (newTag && Number.isFinite(bestDelay)) {
              await xrayApi.overrideBalancer(currentBinPath, currentLiveApiPort, 'balancer-proxy', newTag)
              stickyTag = newTag
              const probeIntervalSec = normalizePositiveInt(cfg.probeInterval, pluginConfig.probeInterval) || 300
              armStickyAutoUnlock('Xray 热刷新改锁节点已自动解除', probeIntervalSec * 1000)
              log.info(`Xray Stage3 后API热刷新: sticky 节点被移除，已改锁延时最低的新节点: tag=${newTag}, delay=${bestDelay}ms`)
            } else {
              await xrayApi.removeBalancerOverride(currentBinPath, currentLiveApiPort, 'balancer-proxy').catch(() => {})
              log.warn('Xray Stage3 后API热刷新: sticky 节点被移除且无可改锁节点，已解除锁定')
            }
          } catch (e) {
            log.warn(`Xray Stage3 后API热刷新: 改锁新节点失败: ${e.message}`)
          }
        }
        return
      } catch (error) {
        log.warn(`Xray Stage3 后API热刷新失败，回退到重启: ${error.message}`)
        // Rollback in-memory state; restart path will rebuild from selectedNodes
        currentLiveNodeTags.clear()
        savedNodeTags.forEach((tag, fp) => currentLiveNodeTags.set(fp, tag))
        nextProxyTagIndex = savedNextIndex
        // Fall through to restart-based refresh below
      }
    }

    // Fallback: genConfig + restart (Phase 1 behavior)
    if (!currentLiveApiPort) {
      currentLiveApiPort = await portFinder.findFreePort()
    }
    if (!currentLiveMetricsPort) {
      currentLiveMetricsPort = await portFinder.findFreePort()
    }
    const liveConfig = genConfig(currentLivePort, selectedNodes, cfg.rules, cfg.observatoryProbeUrl || cfg.probeUrl, cfg.probeInterval, {
      apiPort: currentLiveApiPort,
      metricsPort: currentLiveMetricsPort,
      observatoryEnableConcurrency: true,
    })
    writeJsonFile(currentLiveConfigPath, liveConfig)
    liveConfigHasProxyNodes = selectedNodes.length > 0
    currentLiveNodeTags.clear()
    selectedNodes.forEach((node, i) => {
      const fp = xrayCache.fingerprintNode(node)
      if (fp) {
        currentLiveNodeTags.set(fp, `proxy_${i}`)
      }
    })
    nextProxyTagIndex = selectedNodes.length
    event.fire('status', { key: 'plugin.xray.metricsPort', value: currentLiveMetricsPort })
    event.fire('status', { key: 'plugin.xray.apiPort', value: currentLiveApiPort })
    log.info(`Xray Stage3 后热刷新 live config: proxyNodes=${selectedNodes.length}, kept=${keptNodes.length}, fresh=${selectedNodes.length - keptNodes.length} -> ${currentLiveConfigPath}`)

    // xray restart clears balancer override — reset sticky state
    if (stickyTimer) { clearTimeout(stickyTimer); stickyTimer = null }
    stickyTag = null

    try {
      await processApi.restart(binPath, currentLiveConfigPath)
      await api.injectRules(cfg.rules, currentLivePort)
      if (server) {
        await server.reload()
      }
      event.fire('status', { key: 'plugin.xray.enabled', value: true })
      log.info('Xray Stage3 后热刷新: live 进程已重启并注入规则')
    } catch (error) {
      log.warn('Xray Stage3 后热刷新: live 进程重启失败:', error)
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

    const rawDelay = Math.max(0, roundStartedAt + intervalMs - Date.now())
    // Sanity check: 如果 stage3 duration 超过 cacheRefreshInterval(rawDelay=0,
    // 立刻进下一轮),强制至少 STAGE3_OVERRUN_COOLDOWN_MS 冷却。
    // 否则 stage3 一完成立刻触发新一轮,新一轮的 stage2 cache-only 路径会再次
    // 进入 cleanupOutdatedToSizeLimit 的 while+incremental_vacuum 同步循环,
    // main thread 阻塞几十分钟,SIGCHLD 无法 dispatch → mitmproxy 崩溃后无 respawn。
    if (rawDelay < STAGE3_OVERRUN_COOLDOWN_MS) {
      log.warn(`Xray stage3 duration 超过 cacheRefreshInterval (${intervalMs}ms),强制冷却 ${STAGE3_OVERRUN_COOLDOWN_MS}ms 防止立即触发下一轮`)
      return STAGE3_OVERRUN_COOLDOWN_MS
    }
    return rawDelay
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

  async function probeNodesBatch ({ binPath, cfg, xrayDir, batchNodes, timeoutMs, probeSamples = pluginConfig.cacheRefreshProbeSamples, probeUrl = null, persistentController = null }) {
    const effectiveProbeSamples = normalizePositiveInt(probeSamples, pluginConfig.cacheRefreshProbeSamples)

    if (!Array.isArray(batchNodes) || batchNodes.length === 0) {
      return {
        entries: [],
        observedFingerprints: [],
      }
    }

    // Stage1 bootstrap passes observatoryProbeUrl (strict, near real target);
    // Stage3 cache refresh passes probeUrl (lenient, gstatic 204) for broad screening.
    const effectiveProbeUrl = probeUrl || cfg.observatoryProbeUrl || cfg.probeUrl || pluginConfig.probeUrl

    // Single-pass probe: probe ALL nodes once with the configured probeUrl.
    // The dual-protocol (HTTP + HTTPS) probing was reverted because:
    // 1. Probing twice doubled the per-batch latency.
    // 2. The "probeProtocol" classification was inaccurate — nodes flagged
    //    as HTTP-only were frequently also reachable over 443 in practice.
    // 3. Proxying plain HTTP (port 80) traffic has little practical value;
    //    the vast majority of proxied traffic is HTTPS, so the configured
    //    probeUrl's protocol is authoritative.
    return await runSingleProbePass({ binPath, cfg, xrayDir, batchNodes, timeoutMs, probeUrl: effectiveProbeUrl, probeSamples: effectiveProbeSamples, persistentController })
  }

  async function startPersistentProbeProcess ({ binPath, cfg, xrayDir, probeUrl, probeSamples }) {
    ensureDir(xrayDir)
    const probeDir = path.join(xrayDir, 'probe')
    ensureDir(probeDir)

    const probePort = await portFinder.findFreePort()
    const metricsPort = await portFinder.findFreePort()
    const apiPort = await portFinder.findFreePort()

    const config = genConfig(probePort, [], cfg.rules, probeUrl, CACHE_PROBE_SAMPLE_INTERVAL, {
      metricsPort,
      apiPort,
      observatoryEnableConcurrency: true,
      probeMode: 'observatory',
      probeSamples,
      probeTimeoutSeconds: CACHE_PROBE_SAMPLE_TIMEOUT,
    })

    const configPath = path.join(probeDir, `persistent-${Date.now()}-${Math.random().toString(16).slice(2)}.json`)
    writeJsonFile(configPath, config)

    let child, stop
    try {
      ({ child, stop } = probe.startXrayProcess({ binPath, configPath, log, purpose: 'persistent' }))
    } catch (err) {
      try { fs.rmSync(configPath, { force: true }) } catch { /* ignore */ }
      throw err
    }

    let currentTags = []

    async function swapBatch ({ nodes, log: swapLog }) {
      // rmo 上一批所有 tag (idempotent — safe even if some tags don't exist)
      if (currentTags.length > 0) {
        const rmoResults = await xrayApi.removeOutbounds(binPath, apiPort, currentTags, { concurrency: 16 })
        const rmoFailed = rmoResults.filter(r => !r.success)
        if (rmoFailed.length > 0) {
          swapLog.warn(`Xray 常驻探测: ${rmoFailed.length}/${currentTags.length} 个 tag rmo 失败: ${rmoFailed.map(r => r.tag).join(',')}`)
        }
      }

      // ado 新一批节点（固定 tag proxy_0~N，复用避免 observatory 残留累积）
      const outbounds = nodes.map((node, i) => {
        const outbound = parser.sanitizeNodeForCurrentXray(JSON.parse(JSON.stringify(node)))
        outbound.tag = `proxy_${i}`
        return outbound
      })

      const result = await xrayApi.addOutbounds(binPath, apiPort, outbounds)
      currentTags = result.addedTags

      if (result.failedTags.length > 0) {
        swapLog.warn(`Xray 常驻探测: ${result.failedTags.length} 个节点 ado 失败: ${result.failedTags.map(f => f.tag).join(',')}`)
      }
      if (result.stoppedEarly) {
        const droppedCount = outbounds.length - result.results.length
        if (droppedCount > 0) {
          swapLog.warn(`Xray 常驻探测: ado 遇无效节点提前停止，${droppedCount} 个节点未被处理`)
        }
      }

      // Record ado completion time (unix seconds, same unit as xray last_try_time)
      // Used by isObservationReady to distinguish new probe results from stale status.
      const adoCompletedAt = Math.floor(Date.now() / 1000)

      return { addedTags: new Set(result.addedTags), adoCompletedAt }
    }

    return {
      child,
      metricsPort,
      apiPort,
      configPath,
      swapBatch,
      stop: async () => {
        await stop().catch(() => {})
        try { fs.rmSync(configPath, { force: true }) } catch { /* ignore */ }
      },
    }
  }

  async function runPersistentProbePass ({ binPath, cfg, xrayDir, batchNodes, timeoutMs, probeUrl, probeSamples, persistentController }) {
    const { addedTags: expectedTags, adoCompletedAt } = await persistentController.swapBatch({ nodes: batchNodes, log })

    if (expectedTags.size === 0) {
      log.warn('Xray 常驻探测: 本批无节点成功添加')
      return { entries: [], observedFingerprints: [] }
    }

    // Wait for observatory to probe new nodes. Use minLastTryTime to ignore
    // stale status from previous batch (rmo doesn't clear old entries).
    // minLastTryTime = adoCompletedAt (no tolerance): new probes happen at
    // >= T_ado + probeInterval (5s after ado), stale probes happened before
    // rmo (which is before ado), so lastTry < T_ado for all stale entries.
    const minLastTryTime = adoCompletedAt

    const metrics = await probe.waitForObservatoryMetrics({
      metricsPort: persistentController.metricsPort,
      timeoutMs,
      child: persistentController.child,
      expectedTags,
      minLastTryTime,
    })

    const observatory = metrics && (metrics.observatory || metrics.burstObservatory || metrics.Observatory || metrics.BurstObservatory)
    if (!observatory) {
      log.warn('Xray 常驻探测: metrics 中没有 observatory 数据')
      return { entries: [], observedFingerprints: [] }
    }

    // Build nodeMap only for successfully added tags (filter out ado failures)
    const nodeMap = new Map()
    batchNodes.forEach((node, i) => {
      const tag = `proxy_${i}`
      if (expectedTags.has(tag)) {
        nodeMap.set(tag, node)
      }
    })

    const observedFingerprints = Object.keys(observatory || {})
      .filter(tag => expectedTags.has(tag))
      .map(tag => nodeMap.get(tag))
      .map(node => xrayCache.fingerprintNode(node))
      .filter(Boolean)

    return {
      entries: xrayCache.buildCacheEntriesFromObservatory(observatory, nodeMap, 'background-probe'),
      observedFingerprints,
    }
  }

  async function runSingleProbePass ({ binPath, cfg, xrayDir, batchNodes, timeoutMs, probeUrl, probeSamples, persistentController }) {
    ensureDir(xrayDir)
    const probeDir = path.join(xrayDir, 'probe')
    ensureDir(probeDir)

    // Persistent probe mode: reuse a long-lived xray subprocess, swap nodes via ado/rmo
    if (persistentController) {
      return await runPersistentProbePass({ binPath, cfg, xrayDir, batchNodes, timeoutMs, probeUrl, probeSamples, persistentController })
    }

    // Fallback: spawn a one-shot xray subprocess per batch
    const probeConfigPath = path.join(probeDir, `config-${Date.now()}-${Math.random().toString(16).slice(2)}.json`)
    const probePort = await portFinder.findFreePort()
    const metricsPort = await portFinder.findFreePort()

    const probeConfig = genConfig(probePort, batchNodes, cfg.rules, probeUrl, CACHE_PROBE_SAMPLE_INTERVAL, {
      metricsPort,
      observatoryEnableConcurrency: true,
      probeMode: 'observatory',
      probeSamples,
      probeTimeoutSeconds: CACHE_PROBE_SAMPLE_TIMEOUT,
    })

    writeJsonFile(probeConfigPath, probeConfig)

    const probeController = probe.startProbeProcess({
      binPath,
      configPath: probeConfigPath,
      metricsPort,
      log,
      timeoutMs,
      expectedSamples: probeSamples,
      expectedSubjectCount: batchNodes.length,
    })

    currentProbe = probeController

    try {
      const metrics = await probeController.promise
      const observatory = metrics && (metrics.observatory || metrics.burstObservatory || metrics.Observatory || metrics.BurstObservatory)
      if (!observatory) {
        log.warn('Xray 后台探测: metrics 中没有 observatory 数据')
        return {
          entries: [],
          observedFingerprints: [],
        }
      }

      const nodeMap = createNodeMap(batchNodes)
      const observedFingerprints = Object.keys(observatory || {})
        .map(tag => nodeMap.get(tag))
        .map(node => xrayCache.fingerprintNode(node))
        .filter(Boolean)
      return {
        entries: xrayCache.buildCacheEntriesFromObservatory(observatory, nodeMap, 'background-probe'),
        observedFingerprints,
      }
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
      const cachePath = path.join(xrayDir, 'nodes_cache.sqlite')
      currentLiveConfigPath = liveConfigPath
      currentBinPath = binPath
      liveConfigHasProxyNodes = false
      const startupNodeLimit = normalizePositiveInt(cfg.startupNodeLimit, pluginConfig.startupNodeLimit)
      const allowedCountries = cfg.allowedCountries
      const allowedOwners = cfg.allowedOwners
      const maxDelayMs = normalizeNonNegativeInt(cfg.maxDelayMs, 0)

      // Stage1 cache maintenance (migration/retire/compact/reclaim) has been
      // removed from the startup path. The database schema is still checked
      // and migrated automatically inside openSqliteCache() on every open,
      // so removing the explicit Stage1 migration call is safe — it only
      // removes the redundant batch migration that was already complete
      // (migratedRows=0) on every startup. This avoids an extra
      // openSqliteCache() call that reads the 765MB database file into
      // cgroup file cache during cold boot.

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
      // When startupSelectEnabled is false, skip the cache candidate query and
      // burst probe, and reuse the previous config.json as-is (including its
      // already-selected proxy nodes and inbound port). This avoids rewriting
      // the live config on every restart when the operator is happy with the
      // last selected node set.
      const startupSelectEnabled = isStartupSelectEnabled(cfg)
      let startupNodes = []
      let bootstrapSelectedEntries = []
      let reusedLiveConfig = false
      let liveApiPort = 0
      let liveMetricsPort = 0

      if (!startupSelectEnabled) {
        const reusedConfig = readExistingXrayLiveConfig(liveConfigPath)
        if (reusedConfig) {
          const reusedPort = extractInboundPortFromXrayConfig(reusedConfig)
          if (Number.isFinite(reusedPort) && reusedPort > 0) {
            port = reusedPort
            globalConfig.get().server.setting.xrayPort = port
          }
          startupNodes = xrayCache.extractNodesFromXrayConfigFile(liveConfigPath)
          reusedLiveConfig = startupNodes.length > 0
          log.info(`Xray 第一阶段已跳过: startupSelectEnabled=false, 复用上次 config.json, reusedProxyNodes=${startupNodes.length}, port=${port}`)
        } else {
          log.info(`Xray 第一阶段已跳过: startupSelectEnabled=false, 但未找到可复用的 config.json，回退到正常筛选流程`)
        }
      }

      if (!reusedLiveConfig) {
        // Stage1 bootstrap: read probed candidates from cache, burst-probe them,
        // select the best ones to inject via ado after xray starts.
        if (startupSelectEnabled) {
          const bootstrapCandidateLimit = getBootstrapCandidateLimit(cfg)
          const bootstrapCandidateQuery = buildCacheEntryQueryOptions({
            allowedCountries,
            allowedOwners,
            limit: bootstrapCandidateLimit,
            probedOnly: true,
          })
          // Drop file cache before SQLite read to avoid cgroup peak
          if (process.platform === 'linux') {
            xrayCache.dropSqliteFileCache(cachePath)
            xrayCache.reclaimCgroupMemory(150 * 1024 * 1024)
          }
          const bootstrapCandidateEntries = xrayCache.readCacheEntriesForStartup(cachePath, bootstrapCandidateQuery)
          const bootstrapCandidates = bootstrapCandidateEntries
            .filter(entry => parser.isParsedNodeValid(entry.node))
            .map(entry => entry.node)
          xrayCache.dropSqliteFileCache(cachePath)

          log.info(`Xray 启动预检查: source=nodes-cache, bootstrapCandidates=${bootstrapCandidateEntries.length}, supported=${bootstrapCandidates.length}`)

          let bootstrapSelectedEntriesLocal = []
          if (bootstrapCandidates.length > 0) {
            try {
              const bootstrapProbeResult = await probeNodesBatch({
                binPath,
                cfg,
                xrayDir,
                batchNodes: bootstrapCandidates,
                timeoutMs: 0,
                probeSamples: getBootstrapProbeSamples(cfg),
                probeUrl: cfg.observatoryProbeUrl || cfg.probeUrl || pluginConfig.probeUrl,
              })
              const annotatedBootstrapEntries = await annotateProbeEntries(bootstrapProbeResult.entries, {
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
              bootstrapSelectedEntriesLocal = xrayCache.sortCacheEntries(bootstrapByOwner).slice(0, startupNodeLimit)
              log.info(`Xray 启动前快速复检: tested=${bootstrapCandidates.length}, available=${annotatedBootstrapEntries.length}, selected=${bootstrapSelectedEntries.length}`)
            } catch (error) {
              log.warn('Xray 启动前快速复检失败:', error)
            }
          }

          bootstrapSelectedEntries = bootstrapSelectedEntriesLocal
          const startupNodeCandidates = []
          appendItems(startupNodeCandidates, bootstrapSelectedEntries.map(entry => entry.node))
          startupNodes = xrayCache.deduplicateNodes(startupNodeCandidates).slice(0, startupNodeLimit)
          log.info(`Xray 启动节点候选: bootstrapSelected=${bootstrapSelectedEntries.length}, startupSelected=${startupNodes.length}`)
          if (startupNodes.length === 0) {
            log.warn('Xray 警告: 未找到任何可用节点，将只启用 Direct/Block')
          }
        }

        // Prepend manual nodes from cfg.nodes — these are user-specified nodes
        // that must always be included in the live config, bypassing the
        // country/owner/delay filters that apply to cache-derived candidates.
        const manualStartupNodes = collectNodesFromLinks(cfg.nodes)
        if (manualStartupNodes.length > 0) {
          const combined = []
          appendItems(combined, manualStartupNodes)
          appendItems(combined, startupNodes)
          startupNodes = xrayCache.deduplicateNodes(combined).slice(0, Math.max(startupNodeLimit, manualStartupNodes.length))
          log.info(`Xray 预置节点已注入: manualNodes=${manualStartupNodes.length}, combinedStartupNodes=${startupNodes.length}`)
        }

        liveApiPort = await portFinder.findFreePort()
        liveMetricsPort = await portFinder.findFreePort()
        // Fixed template: no proxy nodes in config.json; Stage1 injects via ado/rmo after start
        const liveConfig = genConfig(port, [], cfg.rules, cfg.observatoryProbeUrl || cfg.probeUrl, cfg.probeInterval, {
          apiPort: liveApiPort,
          metricsPort: liveMetricsPort,
          observatoryEnableConcurrency: true,
        })
        writeJsonFile(liveConfigPath, liveConfig)
        log.info(`Xray 配置文件已生成(固定模板): ${liveConfigPath}`)
      } else {
        // Extract apiPort from reused config for hot refresh API support
        const reusedConfigObj = readExistingXrayLiveConfig(liveConfigPath)
        if (reusedConfigObj && reusedConfigObj.api && reusedConfigObj.api.listen) {
          const m = String(reusedConfigObj.api.listen).match(/:(\d+)$/)
          if (m) {
            liveApiPort = Number(m[1])
          }
        }
        // Extract metricsPort from reused config for runtime observatory debugging
        if (reusedConfigObj && reusedConfigObj.metrics && reusedConfigObj.metrics.listen) {
          const m = String(reusedConfigObj.metrics.listen).match(/:(\d+)$/)
          if (m) {
            liveMetricsPort = Number(m[1])
          }
        }
      }

      currentLivePort = port
      currentLiveApiPort = liveApiPort
      currentLiveMetricsPort = liveMetricsPort
      // Fixed template has no proxy nodes; startupNodes will be injected via ado after start
      liveConfigHasProxyNodes = false
      currentLiveNodeTags.clear()
      nextProxyTagIndex = 0

      // 3. Start live process.
      await api.stopBackgroundProbe()
      await processApi.start(binPath, liveConfigPath, {
        onUnexpectedExit: () => {
          // xray crashed and will auto-restart with the fixed template (no proxy nodes).
          // Clear live node tracking so subsequent ado/rmo starts from a clean state.
          currentLiveNodeTags.clear()
          nextProxyTagIndex = 0
          liveConfigHasProxyNodes = false
          if (stickyTimer) { clearTimeout(stickyTimer); stickyTimer = null }
          stickyTag = null
        },
      })
      event.fire('status', { key: 'plugin.xray.enabled', value: true })
      event.fire('status', { key: 'plugin.xray.port', value: port })
      if (currentLiveMetricsPort) {
        event.fire('status', { key: 'plugin.xray.metricsPort', value: currentLiveMetricsPort })
      }
      if (currentLiveApiPort) {
        event.fire('status', { key: 'plugin.xray.apiPort', value: currentLiveApiPort })
      }

      // Stage1: inject startupNodes via ado/rmo (no config.json rewrite)
      if (!reusedLiveConfig && startupNodes.length > 0 && currentLiveApiPort && currentBinPath) {
        // Wait for xray API port to be ready before ado/rmo
        const apiReady = await waitForProxyPortReady({ proxyPort: currentLiveApiPort, timeoutMs: 5000 })
        if (!apiReady) {
          log.warn('Xray 第一阶段 ado 注入: API 端口未就绪，跳过')
        } else {
          const nodesToAdd = []
          for (const node of startupNodes) {
            const fp = xrayCache.fingerprintNode(node)
            if (fp) {
              const tag = `proxy_${nextProxyTagIndex++}`
              const outbound = parser.sanitizeNodeForCurrentXray(JSON.parse(JSON.stringify(node)))
              outbound.tag = tag
              nodesToAdd.push({ node, tag, fp, outbound })
            }
          }
          if (nodesToAdd.length > 0) {
            try {
              const addResult = await xrayApi.addOutbounds(currentBinPath, currentLiveApiPort, nodesToAdd.map(n => n.outbound))
              for (const n of nodesToAdd) {
                if (addResult.addedTags.includes(n.tag)) {
                  currentLiveNodeTags.set(n.fp, n.tag)
                }
              }
              liveConfigHasProxyNodes = currentLiveNodeTags.size > 0
              log.info(`Xray 第一阶段 ado 注入: added=${addResult.addedTags.length}/${nodesToAdd.length}, liveNodes=${currentLiveNodeTags.size}`)

              // Immediately override balancer to the lowest-delay node so traffic
              // can flow without waiting for observatory's first probe cycle (probeInterval=300s).
              // The override auto-expires after probeInterval seconds, at which point
              // observatory has probed all nodes and leastPing strategy takes over.
              if (currentLiveNodeTags.size > 0 && bootstrapSelectedEntries.length > 0) {
                const bestEntry = bootstrapSelectedEntries[0]
                const bestFp = xrayCache.fingerprintNode(bestEntry.node)
                const bestTag = bestFp ? currentLiveNodeTags.get(bestFp) : null
                if (bestTag) {
                  const probeIntervalSec = normalizePositiveInt(cfg.probeInterval, pluginConfig.probeInterval) || 300
                  try {
                    await xrayApi.overrideBalancer(currentBinPath, currentLiveApiPort, 'balancer-proxy', bestTag)
                    stickyTag = bestTag
                    // Auto-unlock after one probe cycle so leastPing can take over.
                    // The release is deferred until observatory has alive-node data.
                    armStickyAutoUnlock('Xray 第一阶段临时锁定已自动解除', probeIntervalSec * 1000)
                    log.info(`Xray 第一阶段已临时锁定出口节点: tag=${bestTag}, delay=${bestEntry.delay}ms, ${probeIntervalSec}s 后自动解锁`)
                  } catch (e) {
                    log.warn(`Xray 第一阶段锁定出口节点失败: ${e.message}`)
                  }
                }
              }
            } catch (error) {
              log.warn(`Xray 第一阶段 ado 注入失败: ${error.message}`)
            }
          }
        }
      }

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
        cachePath,
      }).catch((error) => {
        isStage2Running = false
        stage2Runtime = null
        log.warn('Xray 后台节点刷新任务失败:', error)
      })
    },

    async close () {
      refreshGeneration += 1
      clearCacheRefreshTimer()
      // Clear sticky state before awaits to prevent enableSticky racing during close
      if (stickyTimer) {
        clearTimeout(stickyTimer)
        stickyTimer = null
      }
      const heldStickyTag = stickyTag
      stickyTag = null
      // Remove balancer override before stopping xray (best-effort)
      if (heldStickyTag && currentLiveApiPort && currentBinPath) {
        await xrayApi.removeBalancerOverride(currentBinPath, currentLiveApiPort, 'balancer-proxy').catch(() => {})
      }
      // Invalidate API access early to reject enableSticky during remaining awaits
      const prevApiPort = currentLiveApiPort
      const prevBinPath = currentBinPath
      currentLiveApiPort = 0
      currentBinPath = ''
      await api.stopBackgroundProbe()
      await stopTransientProbeControllers()
      cleanupStaleProbeArtifacts()
      await api.removeRules()
      if (server) {
        await server.reload()
      }
      await processApi.stop()
      liveConfigHasProxyNodes = false
      currentLivePort = 0
      currentLiveApiPort = 0
      currentLiveMetricsPort = 0
      currentLiveNodeTags.clear()
      nextProxyTagIndex = 0
      currentLiveConfigPath = ''
      currentBinPath = ''
      event.fire('status', { key: 'plugin.xray.enabled', value: false })
      event.fire('status', { key: 'plugin.xray.metricsPort', value: 0 })
      event.fire('status', { key: 'plugin.xray.apiPort', value: 0 })
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

    // --- Sticky balancer: lock exit IP for a duration ---

    resetStickyState () {
      if (stickyTimer) {
        clearTimeout(stickyTimer)
        stickyTimer = null
      }
      stickyTag = null
    },

    async getStickyStatus () {
      return {
        active: stickyTimer !== null,
        tag: stickyTag,
        apiPort: currentLiveApiPort,
      }
    },

    async enableSticky ({ duration = 300 } = {}) {
      // Serialize sticky operations to prevent enable/disable race conditions
      return stickyOpChain.then(async () => {
        if (!currentLiveApiPort || !currentBinPath) {
          throw new Error('Xray API 不可用，无法锁定节点')
        }

        // Get current balancer selection
        const info = await xrayApi.getBalancerInfo(currentBinPath, currentLiveApiPort, 'balancer-proxy')
        const match = info.match(/Selects:\s*\n\s*\d+\s+(\S+)/)
        if (!match) {
          throw new Error('无法获取当前 balancer 选中节点')
        }
        const tag = match[1]

        // Override balancer to lock to this node
        await xrayApi.overrideBalancer(currentBinPath, currentLiveApiPort, 'balancer-proxy', tag)
        stickyTag = tag

        // Auto-release after duration (release is deferred until observatory
        // has alive-node data — see armStickyAutoUnlock)
        const ms = Math.max(1, Number(duration) || 300) * 1000
        armStickyAutoUnlock('Xray sticky 锁定已到期自动解除', ms)

        log.info(`Xray sticky 锁定已启用: tag=${tag}, duration=${duration}s`)
        return { tag, duration }
      }).catch((err) => {
        // Re-throw but keep chain resolved for next op
        throw err
      })
    },

    async disableSticky () {
      return stickyOpChain.then(async () => {
        if (!currentLiveApiPort || !currentBinPath) {
          throw new Error('Xray API 不可用，无法解锁')
        }

        // Refuse unlock if observatory has no alive nodes. This happens during
        // the first probeInterval after startup (observatory's first probe cycle
        // doesn't start until probeInterval elapses). Removing the override now
        // would leave balancer's leastPing with no data → no selection → traffic drops.
        const aliveCount = await fetchLiveObservatoryAliveCount()
        if (aliveCount === 0) {
          const waitSec = pluginConfig.probeInterval || 300
          throw new Error(`observatory 还在首次探测中，balancer 暂无可用节点数据。请等待探测完成（最多 ${waitSec} 秒）后再解锁，否则 balancer 将无节点可选。`)
        }

        if (stickyTimer) {
          clearTimeout(stickyTimer)
          stickyTimer = null
        }
        const heldTag = stickyTag
        stickyTag = null
        if (currentLiveApiPort && currentBinPath) {
          await xrayApi.removeBalancerOverride(currentBinPath, currentLiveApiPort, 'balancer-proxy').catch(() => {})
        }
        log.info(`Xray sticky 锁定已手动解除: tag=${heldTag}`)
        return { tag: heldTag }
      }).catch((err) => {
        throw err
      })
    },

    async refreshCacheFromSourcesOnce ({ binPath, cfg, xrayDir, liveConfigPath, cachePath }) {
      const generation = ++refreshGeneration

      if (!isSubscriptionSyncEnabled(cfg)) {
        log.info('Xray 第二阶段已禁用: subscriptionSyncEnabled=false, 跳过订阅抓取与缓存同步，直接进入第三阶段')
        if (generation === refreshGeneration) {
          if (!isCacheRefreshEnabled(cfg)) {
            log.info('Xray 缓存周期探测已禁用，跳过第三阶段')
            return
          }
          await api.refreshCacheFromCacheOnly({ binPath, cfg, xrayDir, cachePath })
        }
        return
      }

      // Stage2 cache migration/retire/compact has been removed. The database
      // is already compact v2 only — legacy/hotcold tables are no longer
      // created or maintained. openSqliteCache() creates the v2 schema on
      // every open, so no explicit migration step is needed here.

      const manualNodes = collectNodesFromLinks(cfg.nodes)
      const subscriptionSyncDecision = getSubscriptionSyncDecision({ cachePath, cfg })
      const localInputStatePath = getLocalInputStatePath(cachePath)
      const currentLocalInputState = buildLocalInputState({ manualNodes, subscriptions: cfg.subscriptions })
      let shouldSkipSubscriptionFetch = subscriptionSyncDecision.shouldSkip

      // Cooldown check: even if the watermark says we should fetch, don't
      // fetch if the last remote fetch was within subscriptionSyncIntervalHours.
      if (!shouldSkipSubscriptionFetch && !subscriptionSyncDecision.error) {
        if (shouldSkipRemoteFetchDueToCooldown(cachePath, cfg)) {
          const lastFetchAt = xrayCache.getStage2LastRemoteFetchAt(cachePath)
          const intervalHours = getSubscriptionSyncIntervalHours(cfg)
          log.info(`Xray 订阅抓取冷却中: 距上次远端抓取 ${Math.floor((Date.now() / 1000 - lastFetchAt) / 3600)}h, 间隔 ${intervalHours}h, 跳过远端拉取`)
          shouldSkipSubscriptionFetch = true
        }
      }

      if (subscriptionSyncDecision.shouldSkip) {
        if (subscriptionSyncDecision.error) {
          // Invalid config: never fetch remote subscriptions, but still process local nodes below.
          log.warn(`Xray 订阅抓取已跳过（配置无效）: ${subscriptionSyncDecision.error}`)
        } else {
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
      }

      const configNodes = xrayCache.extractNodesFromXrayConfigFile(liveConfigPath)
      const candidateNodeSeen = new Set()
      const allSubscriptionSourceKeys = new Set()
      const localCandidateNodes = []
      appendUniqueNodes(localCandidateNodes, candidateNodeSeen, configNodes)
      appendUniqueNodes(localCandidateNodes, candidateNodeSeen, manualNodes)
      await reclaimStageSqliteFileCache(log, 'stage2-before-subscription-load-reclaim', cachePath, {
        configNodes: configNodes.length,
        manualNodes: manualNodes.length,
        deduplicated: localCandidateNodes.length,
      }, {
        forceGc: true,
      })

      let subscriptionNodeCount = 0
      let subscriptionSnapshotCount = 0
      let subscriptionSyncRefs = 0
      let totalSupportedCandidateCount = 0
      let totalCacheMatchedCount = 0
      let totalOutdatedSkippedCount = 0
      let totalAddedCount = 0
      let totalCountryReadyCount = 0


      const cacheSizeBeforeStage2 = xrayCache.getSqliteCacheSizeBytes(cachePath)
      if (cacheSizeBeforeStage2 >= CACHE_SIZE_LIMIT_BYTES) {
        const cleanupResult = await xrayCache.cleanupOutdatedToSizeLimit(cachePath, CACHE_SIZE_TARGET_BYTES)
        if (cleanupResult) {
          log.warn(`Xray 节点缓存过大，已清理过期节点: tombstones=${cleanupResult.deletedTombstones}, nodes=${cleanupResult.deletedNodes}, sizeBefore=${cleanupResult.sizeBefore}, sizeAfter=${cleanupResult.sizeAfter}, limit=${CACHE_SIZE_LIMIT_BYTES}`)
        }
      }

      const initialSyncStats = syncCandidateNodesToCache(cachePath, localCandidateNodes)
      totalSupportedCandidateCount += initialSyncStats.supportedCount
      totalCacheMatchedCount += initialSyncStats.cacheMatchedCount
      totalOutdatedSkippedCount += initialSyncStats.outdatedSkippedCount
      totalAddedCount += initialSyncStats.addedCount
      totalCountryReadyCount += initialSyncStats.countryReadyCount

      let stage2SyncStartedAt = 0
      if (shouldSkipSubscriptionFetch) {
        log.info(`Xray 订阅抓取已跳过: effectiveCache=${subscriptionSyncDecision.effectiveCacheCount}, lowWatermark=${subscriptionSyncDecision.lowWatermark}, subscriptions=${Array.isArray(cfg.subscriptions) ? cfg.subscriptions.length : 0}`)
      } else {
        stage2SyncStartedAt = Date.now()
        isStage2Running = true
        stage2Runtime = {
          startedAt: stage2SyncStartedAt,
          totalSubscriptions: Array.isArray(cfg.subscriptions) ? cfg.subscriptions.length : 0,
          currentSubscription: 0,
          fetchedNodes: 0,
        }
        const initialStage2SeenNodeKeys = collectUniqueNodeKeys(localCandidateNodes)
        if (!xrayCache.resetStage2SeenNodeKeys(cachePath, initialStage2SeenNodeKeys)) {
          throw new Error('Xray stage2 seen-node initialization failed')
        }
        log.info(`Xray 订阅抓取已触发: effectiveCache=${subscriptionSyncDecision.effectiveCacheCount}, lowWatermark=${subscriptionSyncDecision.lowWatermark}, subscriptions=${Array.isArray(cfg.subscriptions) ? cfg.subscriptions.length : 0}`)
        const subscriptionResult = await loadSubscriptionNodes(cfg.subscriptions, log, {
          nodeTarget: [],
          stage2SeenCachePath: cachePath,
          onSubscriptionProgress: (current, total, fetchedNodes) => {
            if (stage2Runtime) {
              stage2Runtime.currentSubscription = current
              stage2Runtime.totalSubscriptions = total
              stage2Runtime.fetchedNodes = fetchedNodes
            }
          },
          onAcceptedNodeKeys: (acceptedNodeKeys, sourceMeta = {}) => {
            const nodeKeys = Array.isArray(acceptedNodeKeys) ? acceptedNodeKeys : []
            if (nodeKeys.length === 0 || !sourceMeta.sourceKey) {
              return
            }

            const shouldReplaceExistingRefs = !allSubscriptionSourceKeys.has(sourceMeta.sourceKey)
            const subscriptionChunkSyncStats = xrayCache.syncSubscriptionSourceChunk(cachePath, {
              sourceKey: sourceMeta.sourceKey,
              url: sourceMeta.url,
              displayLabel: sourceMeta.displayLabel,
              sortOrder: sourceMeta.sortOrder,
            }, nodeKeys, {
              staleAfterDays: getSubscriptionStaleAfterDays(cfg),
              replaceExistingRefs: shouldReplaceExistingRefs,
              lowFileCache: true,
            })

            if (!subscriptionChunkSyncStats) {
              console.error(`[CHUNK-DEBUG] syncSubscriptionSourceChunk returned null: sourceKey=${sourceMeta.sourceKey}, nodeKeys=${nodeKeys.length}, url=${sourceMeta.url}, lowFileCache=true`)
              log.warn(`Xray subscription source chunk sync returned null: sourceKey=${sourceMeta.sourceKey}, nodeKeys=${nodeKeys.length}, url=${sourceMeta.url}`)
            } else {
              subscriptionSyncRefs += subscriptionChunkSyncStats.refs
              allSubscriptionSourceKeys.add(sourceMeta.sourceKey)
            }

            // Drop the main cache + stage2-seen file cache pages after each chunk write
            // to prevent monotonic file cache growth during large subscriptions.
            xrayCache.dropSqliteFileCache(cachePath, [xrayCache.getStage2SeenDbPath(cachePath)])
          },
          onAcceptedNodes: (acceptedChunkNodes) => {
            const acceptedNodes = Array.isArray(acceptedChunkNodes) ? acceptedChunkNodes : []
            if (acceptedNodes.length === 0) {
              return
            }

            const chunkSyncStats = syncCandidateNodesToCache(cachePath, acceptedNodes, { lowFileCache: true })
            totalSupportedCandidateCount += chunkSyncStats.supportedCount
            totalCacheMatchedCount += chunkSyncStats.cacheMatchedCount
            totalOutdatedSkippedCount += chunkSyncStats.outdatedSkippedCount
            totalAddedCount += chunkSyncStats.addedCount
            totalCountryReadyCount += chunkSyncStats.countryReadyCount

            // Drop the main cache + stage2-seen file cache pages after each candidate sync.
            xrayCache.dropSqliteFileCache(cachePath, [xrayCache.getStage2SeenDbPath(cachePath)])
          },
          onBatchAccepted: async (batchSubscriptions, batchStats = {}) => {
            for (const subscription of batchSubscriptions) {
              if (subscription && subscription.sourceKey) {
                allSubscriptionSourceKeys.add(subscription.sourceKey)
              }
            }
            const subscriptionSyncStats = xrayCache.syncSubscriptions(cachePath, batchSubscriptions, {
              staleAfterDays: getSubscriptionStaleAfterDays(cfg),
              markMissingUnconfigured: false,
              replaceRefs: false,
              lowFileCache: true,
            })
            if (!subscriptionSyncStats) {
              log.warn('Xray subscription batch sync returned null')
            } else {
              subscriptionSnapshotCount += subscriptionSyncStats.configured
            }
          },
        })
        subscriptionNodeCount = subscriptionResult.uniqueNodeCount
        subscriptionSnapshotCount = subscriptionResult.subscriptions.length
      }

      if (generation !== refreshGeneration) {
        return
      }

      // if/else 汇合后的固定出口：订阅抓取（无论真实拉取还是跳过）已结束
      isStage2Running = false
      stage2Runtime = null
      const subscriptionFetchMode = shouldSkipSubscriptionFetch ? 'skipped' : 'loaded'
      if (subscriptionFetchMode === 'loaded') {
        xrayCache.setStage2LastRemoteFetchAt(cachePath)
        // Persist sync duration + fetched count for WebUI Stage2 status display
        if (stage2SyncStartedAt > 0) {
          xrayCache.setStage2LastSyncStats(cachePath, Date.now() - stage2SyncStartedAt, subscriptionNodeCount)
        }
      }
      const effectiveCacheLabel = subscriptionSyncDecision.effectiveCacheCount == null ? 'n/a' : subscriptionSyncDecision.effectiveCacheCount

      const totalUniqueCandidateCount = localCandidateNodes.length + subscriptionNodeCount


      log.info(`Xray 节点汇总候选: configBak=${configNodes.length}, cacheMatched=${totalCacheMatchedCount}, manual=${manualNodes.length}, subscriptions=${subscriptionNodeCount}, subscriptionFetch=${subscriptionFetchMode}, effectiveCache=${effectiveCacheLabel}, lowWatermark=${subscriptionSyncDecision.lowWatermark}, deduplicated=${totalUniqueCandidateCount}, unsupportedDropped=${Math.max(0, totalUniqueCandidateCount - totalSupportedCandidateCount)}, selected=${totalSupportedCandidateCount}`)

      if (totalSupportedCandidateCount === 0) {
        log.warn('Xray 节点汇总: 未找到任何候选节点，跳过缓存同步')
        if (generation === refreshGeneration && isCacheRefreshEnabled(cfg)) {
          await api.refreshCacheFromCacheOnly({ binPath, cfg, xrayDir, cachePath })
        }
        return
      }

      if (generation !== refreshGeneration) {
        return
      }

      if (totalAddedCount === 0) {
        log.info(`Xray 节点缓存同步已跳过: 候选集未变化, selected=${totalSupportedCandidateCount}, countryReady=${totalCountryReadyCount}, outdatedSkipped=${totalOutdatedSkippedCount}`)
      } else {
        log.info(`Xray 节点缓存已同步: 新增 ${totalAddedCount} 个节点, 删除 0 个节点, selected=${totalSupportedCandidateCount}, countryReady=${totalCountryReadyCount}, outdatedSkipped=${totalOutdatedSkippedCount} -> ${cachePath}`)
      }

      if (!shouldSkipSubscriptionFetch) {
        const subscriptionSyncStats = xrayCache.syncSubscriptions(cachePath, [], {
          staleAfterDays: getSubscriptionStaleAfterDays(cfg),
          currentSourceKeys: [...allSubscriptionSourceKeys],
          lowFileCache: true,
        })
        if (subscriptionSyncStats) {
          log.info(`Xray 订阅来源已同步: configured=${subscriptionSnapshotCount}, unconfigured=${subscriptionSyncStats.unconfigured}, refs=${subscriptionSyncRefs}`)
        } else {
          log.warn('Xray 订阅来源同步失败')
        }
      }

      // Build the delay partial index after Stage2 writes are complete but
      // before the file cache reclaim. This avoids building it during cold
      // boot (Stage1) where it pushed memory.peak above 350MB. By the time we
      // get here, Stage2 writes have warmed the relevant pages and the
      // subsequent dropSqliteFileCache + reclaim will clean up any file cache
      // the index build touched.
      try {
        const built = xrayCache.ensureCompactV2DelayIndexAtPath(cachePath)
        if (built) {
          log.info('Xray compact-v2 delay partial index built during Stage2 maintenance')
        }
      } catch (indexError) {
        log.warn(`Xray compact-v2 delay index build failed: ${indexError && indexError.message}`)
      }

      xrayCache.dropSqliteFileCache(cachePath)

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

      if (isStageRunning) {
        log.info('Xray 缓存周期探测: Stage 正在运行，跳过本轮 Stage3')
        const nextDelay = getCacheRefreshIntervalSeconds(cfg) * 1000
        scheduleCacheRefresh({ binPath, cfg, xrayDir, cachePath }, nextDelay)
        return
      }

      isStageRunning = true
        // Stage3 cache maintenance (migration/retire/compact/reclaim) has been
        // removed from the per-round entry path. The database schema is still
      // checked and migrated automatically inside openSqliteCache() on every
      // open, so removing the explicit migration call is safe — it only
      // removes the redundant batch migration that was already complete
      // (migratedRows=0) on every round. This avoids an extra openSqliteCache()
      // call that reads the 765MB database file into cgroup file cache at the
      // start of every Stage3 round, which was pushing memory.peak above 300MB
      // before any guardrail could fire.

      const generation = ++refreshGeneration
      const roundStartedAt = Date.now()
      stage3RoundStartedAt = roundStartedAt
      const cacheRefreshInterval = getCacheRefreshIntervalSeconds(cfg) * 1000

      // 在 countCacheEntries 之前回收：Stage1 启动期间读取配置/缓存已累积
      // ~100MB file cache，如果不清空，countCacheEntries 的索引扫描再拉入
      // ~168MB 会叠加到 280MB（MemoryHigh），peak 在 reclaim 之前就形成了。
      // 先清空再扫描，让 countCacheEntries 从低基线开始。
      if (process.platform === 'linux') {
        xrayCache.dropSqliteFileCache(cachePath, [], { label: 'stage3-before-count' })
        const reclaimed = xrayCache.reclaimCgroupMemory(150 * 1024 * 1024)
        if (reclaimed) {
          log.info('Xray stage3 计数前内存回收完成: 150M')
        }
      }

      const dueBefore = xrayCache.formatLocalTimestamp(new Date(roundStartedAt))
      const stage3BatchLevel = resolveStage3BatchLevel(cfg)
      const batchSize = stage3BatchLevel.batchSize
      const stage3GcThresholdBytes = stage3BatchLevel.stage3GcThresholdMB * 1024 * 1024
      const totalDueCandidateCount = xrayCache.countCacheEntries(cachePath, { dueBefore })
      const maxDueRowIds = xrayCache.readCacheRowIds(cachePath, {
        orderBy: 'rowid_desc',
        dueBefore,
        limit: 1,
      })
      const maxDueRowId = maxDueRowIds.length > 0 ? maxDueRowIds[0] : 0
      const plannedBatchCount = totalDueCandidateCount === 0 ? 0 : Math.ceil(totalDueCandidateCount / batchSize)

      // Drop SQLite file cache immediately after the initial count + maxRowId
      // query. countCacheEntries does a full-table-scan over the 800MB+ cache
      // to count due nodes, pulling ~168MB of file pages into the service
      // cgroup. Without this early drop, the file cache stacks with the
      // mitmproxy fork's anon memory (~112MB) and pushes memory.peak to 280MB
      // (MemoryHigh limit) before the per-batch guardrail at line ~3078 runs.
      // Dropping here keeps the peak under ~130MB during the batch loop.
      if (totalDueCandidateCount > 0) {
        xrayCache.dropSqliteFileCache(cachePath, [], { label: 'stage3-initial-count' })
        if (process.platform === 'linux') {
          // memory.reclaim 权限为 root-only (--w------- root root)，
          // 服务用户直接写会 EACCES。reclaimCgroupMemory 内部有 sudo fallback
          // (reclaim-memory.sh NOPASSWD sudoers 规则)。
          const reclaimed = xrayCache.reclaimCgroupMemory(150 * 1024 * 1024)
          if (reclaimed) {
            log.info('Xray stage3 初始计数后内存回收完成: 150M')
          } else {
            log.warn('Xray stage3 初始计数后内存回收失败')
          }
        }
      }

      if (totalDueCandidateCount === 0) {
        log.info('Xray 缓存周期探测: 当前没有到期的可探测节点')
        // Still refresh probed-node-stats.json so it reflects the current
        // cache state (e.g. totalProbed=0 when all nodes are dead), rather
        // than leaving stale data from a previous round with alive nodes.
        try {
          xrayCache.updateProbedNodeIdsAtPath(cachePath)
          writeProbedNodeStats({ xrayDir, cachePath })
        } catch {
          // non-fatal
        }
        const nextDelay = resolveNextCacheRefreshDelay(roundStartedAt, cacheRefreshInterval)
        stage3NextRefreshAt = Date.now() + nextDelay
        writeStage3RoundSummary({
          xrayDir,
          summary: {
            status: 'empty',
            startedAt: xrayCache.formatLocalTimestamp(new Date(roundStartedAt)),
            endedAt: xrayCache.formatLocalTimestamp(),
            durationMs: Date.now() - roundStartedAt,
            candidateCount: 0,
            dueCandidateCount: 0,
            processedNodeCount: 0,
            roundAvailableNodeCount: 0,
            batchSize,
            plannedBatchCount,
            processedBatchCount: 0,
            successBatchCount: 0,
            failedBatchCount: 0,
            availableNodeCount: 0,
            removedNodeCount: 0,
            explicitFailureCount: 0,
            partialCoverageCount: 0,
            nextRefreshAt: xrayCache.formatLocalTimestamp(new Date(Date.now() + nextDelay)),
            subscriptions: xrayCache.readSubscriptionAvailabilitySummary(cachePath).filter(subscription => subscription.configured),
          },
        })
        scheduleCacheRefresh({ binPath, cfg, xrayDir, cachePath }, nextDelay)
        return
      }

      log.info(`Xray 缓存周期探测候选: due=${totalDueCandidateCount}, batchSize=${batchSize}, plannedBatchCount=${plannedBatchCount}`)

      // Start persistent probe subprocess: one xray for the entire round,
      // batches swap nodes via ado/rmo instead of spawning new processes.
      let persistentController = null
      const stopPersistentProbe = async () => {
        if (persistentController) {
          unregisterTransientProbeController(persistentController)
          await persistentController.stop().catch(() => {})
          persistentController = null
        }
      }
      persistentController = await startPersistentProbeProcess({
        binPath,
        cfg,
        xrayDir,
        probeUrl: cfg.observatoryProbeUrl || cfg.probeUrl || pluginConfig.probeUrl,
        probeSamples: getCacheRefreshProbeSamples(cfg),
      })
      registerTransientProbeController(persistentController)
      log.info(`Xray 常驻探测子进程已启动: apiPort=${persistentController.apiPort}, metricsPort=${persistentController.metricsPort}`)

      // Start persistent egress probe subprocess for exit IP/country/owner lookup.
      // One xray for all egress lookups in this round; nodes swapped via ado/rmo.
      let egressController = null
      const stopEgressProbe = async () => {
        if (egressController) {
          unregisterTransientProbeController(egressController)
          await egressController.stop().catch(() => {})
          egressController = null
        }
      }
      try {
        egressController = await startEgressProbeProcess({ binPath, xrayDir, log })
        registerTransientProbeController(egressController)
        log.info(`Xray 常驻出口探测子进程已启动: proxyPort=${egressController.proxyPort}`)
      } catch (err) {
        log.warn(`Xray 常驻出口探测子进程启动失败，回退到一次性 spawn: ${err.message}`)
        egressController = null
      }

      try {
      let successBatchCount = 0
      let availableCount = 0
      let removedCount = 0
      let explicitFailureCount = 0
      let partialCoverageCount = 0
      let batchIndex = 0
      let processedCount = 0
      let lastScannedRowId = 0
      const roundAvailableNodeKeys = new Set()
      // Initialize WebUI progress snapshot with planned totals
      stage3Progress = {
        totalDue: totalDueCandidateCount, processed: 0, batchIndex: 0,
        plannedBatchCount, successBatchCount: 0, availableCount: 0,
        explicitFailureCount: 0, removedCount: 0,
      }

      while (processedCount < totalDueCandidateCount) {
        if (generation !== refreshGeneration) {
          return
        }

        const targetBatchRowIds = xrayCache.readCacheRowIds(cachePath, {
          orderBy: 'rowid',
          dueBefore,
          afterRowId: lastScannedRowId,
          maxRowId: maxDueRowId,
          limit: batchSize,
        })
        if (targetBatchRowIds.length === 0) {
          break
        }
        lastScannedRowId = targetBatchRowIds[targetBatchRowIds.length - 1]
        const targetBatch = xrayCache.readCacheEntriesForRefreshByRowIds(cachePath, targetBatchRowIds)
        const validTargetBatch = targetBatch.filter(entry => parser.isParsedNodeValid(entry.node))
        const invalidTargetBatch = targetBatch.length - validTargetBatch.length
        const candidateNodes = validTargetBatch.map(entry => entry.node)
        const nextBatchIndex = batchIndex + 1

        if (invalidTargetBatch > 0) {
          log.warn(`Xray 缓存周期探测: 批次 ${nextBatchIndex} 跳过 ${invalidTargetBatch} 个非法缓存节点`)
          if (xrayCache.writeCacheUpdates(cachePath, validTargetBatch, targetBatch.map(entry => entry.node), {
            lowFileCache: true,
          })) {
            log.info(`Xray 缓存周期探测: 批次 ${nextBatchIndex} 已从缓存移除 ${invalidTargetBatch} 个非法节点`)
          }
        }

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

        log.info(`Xray 缓存周期探测批次: ${nextBatchIndex}, progress=${processedCount}/${totalDueCandidateCount}, batchSize=${candidateNodes.length}`)

        // Reclaim before starting the probe subprocess. Reclaiming only after
        // write-back is too late: the transient probe process can stack on top
        // of SQLite file cache and raise memory.peak before the post-batch
        // guardrail runs.
        if (process.platform === 'linux') {
          xrayCache.dropSqliteFileCache(cachePath, [], { label: `stage3-before-probe-${nextBatchIndex}` })
          try {
            const cgroupPath = getCurrentProcessCgroupPath()
            const cgroupFile = cgroupPath ? path.join(cgroupPath, 'memory.current') : ''
            const currentBytes = Number.parseInt(fs.readFileSync(cgroupFile, 'utf8').trim(), 10)
            if (Number.isFinite(currentBytes) && currentBytes > 120 * 1024 * 1024) {
              const reclaimTarget = Math.min(currentBytes - 100 * 1024 * 1024, 120 * 1024 * 1024)
              if (reclaimTarget > 0) {
                const reclaimed = xrayCache.reclaimCgroupMemory(reclaimTarget)
              }
            }
          } catch {
            // best-effort: memory.reclaim is optional
          }
        }

        try {
          const batchProbeResult = await probeNodesBatch({
            binPath,
            cfg,
            xrayDir,
            batchNodes: candidateNodes,
            timeoutMs: 0,
            probeSamples: getCacheRefreshProbeSamples(cfg),
            probeUrl: cfg.observatoryProbeUrl || cfg.probeUrl || pluginConfig.probeUrl,
            persistentController,
          })

          if (generation !== refreshGeneration) {
            return
          }

          const annotatedEntries = await annotateProbeEntries(batchProbeResult.entries, {
            binPath,
            xrayDir,
            existingEntries: validTargetBatch,
            log,
            egressController,
            probeLifecycle: {
              registerController: registerTransientProbeController,
              unregisterController: unregisterTransientProbeController,
            },
          })

          if (annotatedEntries.length === 0 && batchProbeResult.observedFingerprints.length === 0) {
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

          const batchWritePlan = applyStage3ProbeResults({
            cachePath,
            targetBatch: validTargetBatch,
            annotatedEntries,
            observedFingerprints: batchProbeResult.observedFingerprints,
            cacheRefreshIntervalMs: cacheRefreshInterval,
            now: Date.now(),
          })

          let stage3WriteSucceeded = xrayCache.writeCacheUpdates(cachePath, batchWritePlan.updatedEntries, candidateNodes)
          if (!stage3WriteSucceeded) {
            log.warn(`Xray 缓存周期探测批次写回失败，尝试低缓存模式重试: batch=${nextBatchIndex}, cachePath=${cachePath}`)
            stage3WriteSucceeded = xrayCache.writeCacheUpdates(cachePath, batchWritePlan.updatedEntries, candidateNodes, {
              lowFileCache: true,
            })
          }
          if (!stage3WriteSucceeded) {
            log.error(`Xray 缓存周期探测批次写回失败，已跳过本批持久化以避免整库回退重读: batch=${nextBatchIndex}, cachePath=${cachePath}`)
            continue
          }

          batchIndex = nextBatchIndex
          processedCount += targetBatchRowIds.length
          successBatchCount += 1
          availableCount += batchWritePlan.availableCount
          removedCount += batchWritePlan.removedCount
          explicitFailureCount += batchWritePlan.explicitFailureCount
          // Update WebUI progress snapshot after each successful batch
          stage3Progress = {
            totalDue: totalDueCandidateCount, processed: processedCount,
            batchIndex, plannedBatchCount, successBatchCount,
            availableCount, explicitFailureCount, removedCount,
          }
          partialCoverageCount += batchWritePlan.partialCoverageCount
          for (const nodeKey of batchWritePlan.availableNodeKeys) {
            if (nodeKey) {
              roundAvailableNodeKeys.add(nodeKey)
            }
          }

          log.info(`Xray 缓存周期探测批次已写回: ${batchIndex}, available=${batchWritePlan.availableCount}, explicitFailed=${batchWritePlan.explicitFailureCount}, removed=${batchWritePlan.removedCount}, partialCoverage=${batchWritePlan.partialCoverageCount}, progress=${processedCount}/${totalDueCandidateCount} -> ${cachePath}`)

          // Inject available nodes from this batch via ado/rmo (no config.json rewrite, no restart)
          if (batchWritePlan.availableCount > 0 && currentLiveApiPort && currentBinPath) {
            const availableEntries = batchWritePlan.updatedEntries.filter(
              e => Number.isFinite(e.delay) && e.delay > 0 && parser.isParsedNodeValid(e.node)
            )
            const nodesToAdd = []
            for (const entry of availableEntries) {
              const fp = xrayCache.fingerprintNode(entry.node)
              if (fp && !currentLiveNodeTags.has(fp)) {
                const tag = `proxy_${nextProxyTagIndex++}`
                const outbound = parser.sanitizeNodeForCurrentXray(JSON.parse(JSON.stringify(entry.node)))
                outbound.tag = tag
                nodesToAdd.push({ node: entry.node, tag, fp, outbound })
              }
            }
            if (nodesToAdd.length > 0) {
              try {
                const addResult = await xrayApi.addOutbounds(currentBinPath, currentLiveApiPort, nodesToAdd.map(n => n.outbound))
                for (const n of nodesToAdd) {
                  if (addResult.addedTags.includes(n.tag)) {
                    currentLiveNodeTags.set(n.fp, n.tag)
                  }
                }
                liveConfigHasProxyNodes = currentLiveNodeTags.size > 0
                // rmo over-limit nodes: prioritize failed, then highest delay (keep lowest-delay nodes)
                const nodeLimit = normalizePositiveInt(cfg.startupNodeLimit, pluginConfig.startupNodeLimit)
                const allEntries = [...currentLiveNodeTags.entries()]
                const excess = Math.max(0, allEntries.length - nodeLimit)
                let toRemove = []
                if (excess > 0) {
                  try {
                    const liveFps = allEntries.map(([fp]) => fp)
                    const liveEntries = xrayCache.readCacheEntriesByFingerprints(cachePath, liveFps)
                    const fpToEntry = new Map(liveEntries.map(e => [xrayCache.fingerprintNode(e.node), e]))
                    const failed = []
                    const healthy = []
                    for (const [fp, tag] of allEntries) {
                      const entry = fpToEntry.get(fp)
                      const delay = entry ? Number(entry.delay) : 0
                      const streak = entry ? normalizePositiveInt(entry.failureStreak, 0) : 0
                      if (!Number.isFinite(delay) || delay <= 0 || streak >= 3) {
                        failed.push({ fp, tag })
                      } else {
                        healthy.push({ fp, tag, delay })
                      }
                    }
                    // Prioritize failed, then highest delay (keep lowest-delay nodes alive)
                    toRemove.push(...failed.slice(0, excess))
                    if (toRemove.length < excess) {
                      healthy.sort((a, b) => b.delay - a.delay)
                      toRemove.push(...healthy.slice(0, excess - toRemove.length).map(({ fp, tag }) => ({ fp, tag })))
                    }
                  } catch (cacheError) {
                    // cache query failed — skip rmo this batch, retry next batch
                    log.warn(`Xray Stage3 批次 ${batchIndex} rmo 跳过: 缓存查询失败 ${cacheError.message}`)
                  }
                }
                if (toRemove.length > 0) {
                  const tagsToRemove = toRemove.map(({ tag }) => tag)
                  // Release sticky lock if the locked node is being removed
                  if (stickyTag && tagsToRemove.includes(stickyTag)) {
                    await xrayApi.removeBalancerOverride(currentBinPath, currentLiveApiPort, 'balancer-proxy').catch(() => {})
                    if (stickyTimer) { clearTimeout(stickyTimer); stickyTimer = null }
                    stickyTag = null
                  }
                  try {
                    await xrayApi.removeOutbounds(currentBinPath, currentLiveApiPort, tagsToRemove)
                    // Only delete from Map after rmo succeeds (keep consistency)
                    for (const { fp, tag } of toRemove) {
                      currentLiveNodeTags.delete(fp)
                    }
                  } catch (rmoError) {
                    log.warn(`Xray Stage3 批次 ${batchIndex} rmo 失败: ${rmoError.message}`)
                  }
                }
                log.info(`Xray Stage3 批次 ${batchIndex} 注入: added=${addResult.addedTags.length}/${nodesToAdd.length}, rmo=${toRemove.length}, liveNodes=${currentLiveNodeTags.size}`)
              } catch (injectError) {
                log.warn(`Xray Stage3 批次 ${batchIndex} 注入失败: ${injectError.message}`)
              }
            }
          }

          // Update probed_node_ids after each batch so that a restart during
          // a long Stage3 round still has the latest probed nodes for Stage1
          // bootstrap. The query uses a partial index and takes <10ms.
          if (batchWritePlan.availableCount > 0) {
            try {
              xrayCache.updateProbedNodeIdsAtPath(cachePath)
              writeProbedNodeStats({ xrayDir, cachePath })
            } catch (probedUpdateError) {
              // non-fatal: probed_node_ids will be updated at round end
            }
          }

          // Sample heap/cgroup memory every 10 batches to track Stage3 memory growth over time.
          if (batchIndex % 10 === 0) {
            // Stage3 batch loop never called runStage2GarbageCollection, so V8
            // old-space pages expanded by a single large parse (e.g. the first
            // batch that finds available nodes) were never returned to the OS,
            // leaving heapUsed pegged at ~90 MB for the entire multi-hour run.
            // The trigger threshold is pinned per cacheRefreshBatchLevel (see
            // STAGE3_BATCH_LEVEL_TABLE in config.js) so it stays in sync with
            // the V8 old-space cap set in server/index.js.
            const memSample = process.memoryUsage()
            if (memSample.heapUsed >= stage3GcThresholdBytes) {
              await runStage2GarbageCollection(log, `stage3-batch-${batchIndex}-high-heap`, {
                progress: `${processedCount}/${totalDueCandidateCount}`,
                availableRound: availableCount,
                removedRound: removedCount,
              }, {
                logAfter: true,
              })
            }
          }

          // Drop SQLite file cache pages after each stage-3 batch write-back
          // to prevent monotonic page-cache growth during long-running probe cycles.
          xrayCache.dropSqliteFileCache(cachePath, [], { label: `stage3-batch-${batchIndex}` })

          // Trigger cgroup memory.reclaim after every batch once memory.current
          // crosses the guardrail. Waiting until batch 10 is too late on this
          // service: the cgroup can already hit MemoryHigh around batch 7.
          if (process.platform === 'linux') {
            const cgroupPath = getCurrentProcessCgroupPath()
            const cgroupFile = cgroupPath ? path.join(cgroupPath, 'memory.current') : ''
            try {
              const currentBytes = Number.parseInt(fs.readFileSync(cgroupFile, 'utf8').trim(), 10)
              if (Number.isFinite(currentBytes) && currentBytes > 170 * 1024 * 1024) {
                const reclaimTarget = Math.min(currentBytes - 120 * 1024 * 1024, 150 * 1024 * 1024)
                if (reclaimTarget > 0) {
                  xrayCache.reclaimCgroupMemory(reclaimTarget)
                  log.info(`Xray 缓存周期探测批次回收 cgroup 文件缓存: batch=${batchIndex}, currentMB=${(currentBytes / 1024 / 1024).toFixed(1)}, reclaimMB=${(reclaimTarget / 1024 / 1024).toFixed(1)}`)
                }
              }
            } catch {
              // best-effort: memory.reclaim is optional
            }
          }

          if (batchWritePlan.availableCount === 0 && batchWritePlan.explicitFailureCount > 0) {
            log.warn(`Xray 缓存周期探测: 批次 ${batchIndex} 没有可用节点，已按失败回退策略处理`)
          }
        } catch (error) {
          if (generation !== refreshGeneration) {
            return
          }

          // If persistent probe subprocess died, stop retrying — further swapBatch
          // calls would spawn pointless xray api rmo/ado against a dead process.
          if (persistentController && persistentController.child && (persistentController.child.exitCode != null || persistentController.child.signalCode != null)) {
            log.error(`Xray 缓存周期探测: 常驻探测子进程已退出，中止本轮 Stage3: ${error.message}`)
            break
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
        stage3NextRefreshAt = Date.now() + nextDelay
        const nextRefreshAt = xrayCache.formatLocalTimestamp(new Date(Date.now() + nextDelay))
        writeStage3RoundSummary({
          xrayDir,
          summary: {
            status: 'all_failed',
            startedAt: xrayCache.formatLocalTimestamp(new Date(roundStartedAt)),
            endedAt: xrayCache.formatLocalTimestamp(),
            durationMs: Date.now() - roundStartedAt,
            candidateCount: processedCount,
            dueCandidateCount: totalDueCandidateCount,
            processedNodeCount: processedCount,
            batchSize,
            plannedBatchCount,
            processedBatchCount: batchIndex,
            successBatchCount,
            failedBatchCount: batchIndex - successBatchCount,
            availableNodeCount: availableCount,
            roundAvailableNodeCount: availableCount,
            removedNodeCount: 0,
            explicitFailureCount,
            partialCoverageCount,
            nextRefreshAt,
            subscriptions: xrayCache.readSubscriptionAvailabilitySummary(cachePath).filter(subscription => subscription.configured)
              .sort((left, right) => {
                if (left.availableNodeCount !== right.availableNodeCount) {
                  return right.availableNodeCount - left.availableNodeCount
                }
                return left.sortOrder - right.sortOrder
              }),
          },
        })
        scheduleCacheRefresh({ binPath, cfg, xrayDir, cachePath }, nextDelay)
        return
      }

      log.info(`Xray 缓存文件已刷新: 本轮检测 ${processedCount}/${totalDueCandidateCount} 个到期节点，成功批次 ${successBatchCount}/${batchIndex}，本轮探测成功 ${availableCount} 个，显式失败 ${explicitFailureCount} 个，删除 ${removedCount} 个 -> ${cachePath}`)

      if (generation === refreshGeneration) {
        const roundStatus = processedCount >= totalDueCandidateCount && successBatchCount === plannedBatchCount ? 'completed' : 'partial'
        const availabilityResult = roundStatus === 'completed'
          ? xrayCache.updateSubscriptionAvailability(cachePath, {
              staleAfterDays: getSubscriptionStaleAfterDays(cfg),
              availableNodeKeys: [...roundAvailableNodeKeys],
            })
          : null
        if (availabilityResult && availabilityResult.deleted.length > 0) {
          log.info(`Xray stale 订阅元数据已删除: ${availabilityResult.deleted.length} 个`)
        }

        // Update the probed node_id list in cache_meta so the next bootstrap
        // startup can use WHERE node_id IN (...) instead of a full-table SCAN.
        // This is the key optimization that keeps bootstrap memory under 300MB:
        // with ~1.6M rows but only ~99 probed, the SCAN reads 765MB of file
        // pages into cgroup file cache. The probed node_id list lets bootstrap
        // do a primary-key lookup instead. Updated once per Stage3 round.
        try {
          const probedCount = xrayCache.updateProbedNodeIdsAtPath(cachePath, phase => {
          })
          if (probedCount > 0) {
            log.info(`Xray 启动缓存已更新: probedNodeIds=${probedCount}`)
          }
          // Always refresh probed-node-stats.json so it reflects the current
          // state (including totalProbed=0 when all nodes are dead), rather
          // than leaving stale data from a previous round with alive nodes.
          writeProbedNodeStats({ xrayDir, cachePath })
        } catch (probedError) {
          log.warn(`Xray 启动缓存更新失败: ${probedError && probedError.message}`)
        }

        const nextDelay = resolveNextCacheRefreshDelay(roundStartedAt, cacheRefreshInterval)
        stage3NextRefreshAt = Date.now() + nextDelay
        const nextRefreshAt = xrayCache.formatLocalTimestamp(new Date(Date.now() + nextDelay))
        const summaryPath = writeStage3RoundSummary({
          xrayDir,
          summary: {
            status: roundStatus,
            startedAt: xrayCache.formatLocalTimestamp(new Date(roundStartedAt)),
            endedAt: xrayCache.formatLocalTimestamp(),
            durationMs: Date.now() - roundStartedAt,
            candidateCount: processedCount,
            dueCandidateCount: totalDueCandidateCount,
            processedNodeCount: processedCount,
            batchSize,
            plannedBatchCount,
            processedBatchCount: batchIndex,
            successBatchCount,
            failedBatchCount: batchIndex - successBatchCount,
            availableNodeCount: availableCount,
            roundAvailableNodeCount: availableCount,
            removedNodeCount: removedCount,
            explicitFailureCount,
            partialCoverageCount,
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

        // After each Stage3 round, refresh the live config: remove stale
        // nodes and fill with freshly probed available nodes. Only restarts
        // xray if the node list actually changed.
        if (availableCount > 0 && generation === refreshGeneration) {
          await maybeRegenerateLiveConfigFromCache({
            binPath,
            cfg,
            xrayDir,
            cachePath,
            availableNodeKeys: [...roundAvailableNodeKeys],
          })
        }

        // After Stage3 completes, check if Stage2 needs to run (periodic
        // subscription refresh). This runs independently of Stage3 node
        // refresh and is guarded by isStageRunning to prevent overlap.
        if (generation === refreshGeneration && isSubscriptionSyncEnabled(cfg) && !isStageRunning) {
          const lastFetchAt = xrayCache.getStage2LastRemoteFetchAt(cachePath)
          const intervalHours = getSubscriptionSyncIntervalHours(cfg)
          const elapsedHours = lastFetchAt > 0 ? Math.floor((Date.now() / 1000 - lastFetchAt) / 3600) : Infinity
          if (elapsedHours >= intervalHours) {
            log.info(`Xray Stage3 后触发 Stage2: 距上次远端抓取 ${elapsedHours === Infinity ? 'never' : elapsedHours + 'h'}, 间隔 ${intervalHours}h`)
            isStageRunning = true
            try {
              await api.refreshCacheFromSourcesOnce({
                binPath,
                cfg,
                xrayDir,
                liveConfigPath: currentLiveConfigPath,
                cachePath,
              })
            } catch (stage2Error) {
              log.warn('Xray Stage3 后触发 Stage2 失败:', stage2Error)
            } finally {
              isStage2Running = false
              stage2Runtime = null
              isStageRunning = false
            }
          }
        }

        scheduleCacheRefresh({ binPath, cfg, xrayDir, cachePath }, nextDelay)
        await reclaimStageSqliteFileCache(log, 'stage3-after-round-finalize-reclaim', cachePath, {
          nextDelay,
        }, {
          forceGc: true,
        })
      }
      } finally {
        isStageRunning = false
        await stopEgressProbe()
        await stopPersistentProbe()
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

    getStageStatus () {
      const cfg = globalConfig.get().plugin?.xray || {}
      const cachePath = currentXrayDir ? path.join(currentXrayDir, 'nodes_cache.sqlite') : ''

      // Stage2 metadata
      let stage2 = null
      if (cachePath) {
        try {
          const lastFetchAt = xrayCache.getStage2LastRemoteFetchAt(cachePath)
          const syncStats = xrayCache.getStage2LastSyncStats(cachePath)
          const intervalHours = getSubscriptionSyncIntervalHours(cfg)
          const intervalMs = intervalHours * 3600 * 1000
          const lastFetchMs = lastFetchAt > 0 ? lastFetchAt * 1000 : 0
          // Estimated next sync: last fetch + interval. Stage2 triggers at Stage3
          // round end when this time has elapsed, so it's an estimate, not exact.
          const nextSyncAt = lastFetchMs > 0 ? lastFetchMs + intervalMs : 0
          const stage2Enabled = isSubscriptionSyncEnabled(cfg)
          // Stage2 触发点在 Stage3 轮末：到期后的第一个 Stage3 轮结束时。
          // nextTriggerAt = max(到期时间, 下一轮 Stage3 开始时间) 的近似值。
          const nextTriggerAt = stage2Enabled ? Math.max(nextSyncAt || 0, stage3NextRefreshAt || 0) : 0
          stage2 = {
            enabled: stage2Enabled,
            state: !stage2Enabled ? 'off' : (isStage2Running ? 'running' : 'idle'),
            intervalHours,
            lastSyncAt: lastFetchMs,
            lastSyncDurationMs: syncStats.durationMs,
            lastSyncFetchedCount: syncStats.fetchedCount,
            nextSyncAt,
            nextSyncOverdue: nextSyncAt > 0 && Date.now() > nextSyncAt,
            nextTriggerAt,
            // 本轮实时数据（state === 'running' 时有效）
            startedAt: stage2Runtime ? stage2Runtime.startedAt : 0,
            progress: stage2Runtime ? { current: stage2Runtime.currentSubscription, total: stage2Runtime.totalSubscriptions } : null,
            fetched: stage2Runtime ? stage2Runtime.fetchedNodes : syncStats.fetchedCount,
          }
        } catch { /* cache not available */ }
      }

      return {
        // Legacy fields (kept for backward compat)
        isStageRunning,
        refreshGeneration,
        liveNodes: currentLiveNodeTags.size,
        livePort: currentLivePort,
        apiPort: currentLiveApiPort,
        metricsPort: currentLiveMetricsPort,
        // Real next refresh time (replaces the Date.now()+1 placeholder)
        nextRefreshAt: stage3NextRefreshAt || null,

        // Stage1: live xray process
        stage1: {
          processStarted: currentLivePort > 0,
          livePort: currentLivePort,
          apiPort: currentLiveApiPort,
          metricsPort: currentLiveMetricsPort,
          liveNodes: currentLiveNodeTags.size,
          currentSelectTag: stickyTag,
        },

        // Stage2: subscription sync
        stage2,

        // Stage3: cache probe round
        stage3: {
          enabled: isCacheRefreshEnabled(cfg),
          state: !isCacheRefreshEnabled(cfg) ? 'off' : (isStageRunning ? 'running' : 'idle'),
          generation: refreshGeneration,
          roundStartedAt: stage3RoundStartedAt,
          nextRefreshAt: stage3NextRefreshAt,
          totalDue: stage3Progress.totalDue,
          processed: stage3Progress.processed,
          batchIndex: stage3Progress.batchIndex,
          plannedBatchCount: stage3Progress.plannedBatchCount,
          successBatchCount: stage3Progress.successBatchCount,
          availableCount: stage3Progress.availableCount,
          explicitFailureCount: stage3Progress.explicitFailureCount,
          removedCount: stage3Progress.removedCount,
        },
      }
    },

    // Reverse map tag -> fingerprint, used by /api/xray/nodes to join country
    // from cache. Not exposed via getStageStatus to keep that response small.
    getLiveNodeFingerprints () {
      return Object.fromEntries(
        Array.from(currentLiveNodeTags.entries()).map(([fp, tag]) => [tag, fp])
      )
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
    applyStage3ProbeResults,
    classifyRefreshPriority,
    getFailureBackoffMs,
    isParsedNodeValid: parser.isParsedNodeValid,
    selectStage3RefreshCandidates,
    toLocalTimestampAfterMs,
  },
}
