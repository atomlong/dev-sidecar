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
const { getXrayExePath } = require('../../../shell/scripts/extra-path/index')

const STAGE2_CACHE_SYNC_CHUNK_SIZE = 2000
const STAGE2_CACHE_SYNC_CHUNK_SIZE_LOW_FILE_CACHE = 500
const STAGE2_SUBSCRIPTION_PARSE_CHUNK_SIZE = 50
const STAGE2_SUBSCRIPTION_PARSE_GC_CHUNKS = 1
const STAGE2_SUBSCRIPTION_ACCEPTED_FLUSH_NODE_COUNT = 100
const STAGE2_SUBSCRIPTION_ACCEPTED_FLUSH_NODE_COUNT_LARGE = 50
const CACHE_SIZE_LIMIT_BYTES = 3 * 1024 * 1024 * 1024
const CACHE_SIZE_TARGET_BYTES = Math.floor(CACHE_SIZE_LIMIT_BYTES * 0.9)
const HOT_COLD_MIGRATION_STAGE1_BATCH_ROWS = 1000
const HOT_COLD_MIGRATION_STAGE2_BATCH_ROWS = 1000
const HOT_COLD_MIGRATION_STAGE3_BATCH_ROWS = 1000
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

function formatMemoryUsageMb (value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric < 0) {
    return 'n/a'
  }
  return `${(numeric / (1024 * 1024)).toFixed(1)}MB`
}

function readFirstLine (filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8').trim().split('\n')[0] || ''
  } catch (error) {
    return ''
  }
}

function getCurrentProcessCgroupPath () {
  const cgroupText = readFirstLine('/proc/self/cgroup')
  if (!cgroupText) {
    return ''
  }

  const parts = cgroupText.split(':')
  const relativePath = parts.length >= 3 ? parts.slice(2).join(':') : ''
  if (!relativePath) {
    return ''
  }

  return path.join('/sys/fs/cgroup', relativePath)
}

function readCgroupMemoryValue (cgroupPath, fileName) {
  if (!cgroupPath) {
    return null
  }

  const raw = readFirstLine(path.join(cgroupPath, fileName))
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

function readCgroupMemoryStat (cgroupPath) {
  const result = {}
  if (!cgroupPath) {
    return result
  }

  let statText = ''
  try {
    statText = fs.readFileSync(path.join(cgroupPath, 'memory.stat'), 'utf8')
  } catch (error) {
    return result
  }

  for (const line of statText.split('\n')) {
    const [key, rawValue] = line.trim().split(/\s+/)
    if (!key || rawValue == null) {
      continue
    }
    const value = Number(rawValue)
    if (Number.isFinite(value)) {
      result[key] = value
    }
  }

  return result
}

function getCgroupMemoryUsage () {
  const cgroupPath = getCurrentProcessCgroupPath()
  if (!cgroupPath) {
    return null
  }

  const current = readCgroupMemoryValue(cgroupPath, 'memory.current')
  const peak = readCgroupMemoryValue(cgroupPath, 'memory.peak')
  if (current == null && peak == null) {
    return null
  }

  const stat = readCgroupMemoryStat(cgroupPath)
  return {
    current,
    peak,
    anon: stat.anon,
    file: stat.file,
    kernel: stat.kernel,
    fileDirty: stat.file_dirty,
    inactiveFile: stat.inactive_file,
    activeFile: stat.active_file,
  }
}

// TEMP DEBUG: remove after stage2 memory investigation is complete.
function logStage2MemoryUsage (log, label, extra = {}) {
  const usage = process.memoryUsage()
  const cgroupUsage = getCgroupMemoryUsage()
  const extraFields = Object.entries(extra)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${value}`)
    .join(', ')
  const cgroupFields = cgroupUsage
    ? [
        `cgroupCurrent=${formatMemoryUsageMb(cgroupUsage.current)}`,
        `cgroupPeak=${formatMemoryUsageMb(cgroupUsage.peak)}`,
        `cgroupAnon=${formatMemoryUsageMb(cgroupUsage.anon)}`,
        `cgroupFile=${formatMemoryUsageMb(cgroupUsage.file)}`,
        `cgroupKernel=${formatMemoryUsageMb(cgroupUsage.kernel)}`,
        `cgroupFileDirty=${formatMemoryUsageMb(cgroupUsage.fileDirty)}`,
        `cgroupInactiveFile=${formatMemoryUsageMb(cgroupUsage.inactiveFile)}`,
        `cgroupActiveFile=${formatMemoryUsageMb(cgroupUsage.activeFile)}`,
      ].join(', ')
    : ''
  const allExtraFields = [cgroupFields, extraFields].filter(Boolean).join(', ')

  const message = `[TEMP][stage2-mem] ${label}: rss=${formatMemoryUsageMb(usage.rss)}, heapUsed=${formatMemoryUsageMb(usage.heapUsed)}, heapTotal=${formatMemoryUsageMb(usage.heapTotal)}, external=${formatMemoryUsageMb(usage.external)}${allExtraFields ? `, ${allExtraFields}` : ''}`

  if (log && typeof log.info === 'function') {
    log.info(message)
  }

  try {
    console.error(message)
  } catch (error) {
    // ignore temporary debug output failures
  }
}

function statStage2FilePath (filePath) {
  if (!filePath) {
    return null
  }
  try {
    const stat = fs.statSync(filePath)
    return {
      exists: true,
      size: stat.size,
      mtimeMs: Math.round(stat.mtimeMs),
    }
  } catch {
    return {
      exists: false,
      size: 0,
      mtimeMs: 0,
    }
  }
}

function readProcessOpenFileStats (targetPaths = []) {
  const normalizedTargets = new Map()
  for (const targetPath of targetPaths) {
    if (!targetPath) {
      continue
    }
    normalizedTargets.set(path.normalize(targetPath), {
      path: targetPath,
      fds: 0,
      deletedFds: 0,
    })
  }

  if (normalizedTargets.size === 0) {
    return []
  }

  let fdNames = []
  try {
    fdNames = fs.readdirSync('/proc/self/fd')
  } catch {
    return []
  }

  for (const fdName of fdNames) {
    const fdPath = path.join('/proc/self/fd', fdName)
    let link = ''
    try {
      link = fs.readlinkSync(fdPath)
    } catch {
      continue
    }

    const deleted = link.endsWith(' (deleted)')
    const normalizedLink = path.normalize(deleted ? link.slice(0, -10) : link)
    const stat = normalizedTargets.get(normalizedLink)
    if (!stat) {
      continue
    }

    stat.fds += 1
    if (deleted) {
      stat.deletedFds += 1
    }
  }

  return [...normalizedTargets.values()]
}

// TEMP DEBUG: remove after stage2 file-cache investigation is complete.
function logStage2FileUsage (log, label, cachePath, extra = {}) {
  if (!cachePath) {
    return
  }

  const diagnosticPaths = xrayCache.getStage2DiagnosticPaths(cachePath)
  const fileStats = diagnosticPaths.map(item => ({
    label: item.label,
    path: item.path,
    ...statStage2FilePath(item.path),
  }))
  const openStatsByPath = new Map(readProcessOpenFileStats(fileStats.map(item => item.path)).map(item => [path.normalize(item.path), item]))
  const existingFiles = fileStats
    .filter(item => item.exists || openStatsByPath.has(path.normalize(item.path)))
    .map(item => {
      const openStat = openStatsByPath.get(path.normalize(item.path)) || {}
      return `${item.label}:size=${formatMemoryUsageMb(item.size)},fds=${openStat.fds || 0},deletedFds=${openStat.deletedFds || 0},mtimeMs=${item.mtimeMs || 0}`
    })
    .join('; ')
  const extraFields = Object.entries(extra)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${value}`)
    .join(', ')
  const message = `[TEMP][stage2-file] ${label}: ${[existingFiles || 'files=none', extraFields].filter(Boolean).join(', ')}`

  if (log && typeof log.info === 'function') {
    log.info(message)
  }

  try {
    console.error(message)
  } catch {
    // ignore temporary debug output failures
  }
}

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
      logStage2MemoryUsage(log, 'stage2-after-gc', {
        reason,
        ...extra,
      })
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
    logFadvise: (label, detail) => logStage2MemoryUsage(log, label, { ...detail, reason, ...extra }),
  })

  await runStage2GarbageCollection(log, reason, extra, {
    force: options.forceGc === true,
    logSkipped: options.logGcSkipped === true,
  })

  logStage2MemoryUsage(log, reason, extra)
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

function maybeLogHotColdMigrationProgress (log, phase, result) {
  if (!result || (Number(result.migratedRows) || 0) <= 0) {
    return
  }

  log.info(`Xray hot/cold cache migration: phase=${phase}, migratedRows=${result.migratedRows}, pending=${result.pending === true ? 1 : 0}`)
}

function maybeRetireLegacyNodesStorage (log, cachePath, phase, migrationResult) {
  if (!migrationResult || migrationResult.pending === true) {
    return null
  }

  const result = xrayCache.retireLegacyNodesStorage(cachePath, { lowFileCache: true })
  if (!result || result.retired !== true) {
    return result
  }

  if (result.alreadyRetired === true) {
    return result
  }

  log.info(`Xray legacy nodes storage retired: phase=${phase}`)
  return result
}

function maybeCompactRetiredSqliteCache (log, cachePath, phase, retirementResult) {
  if (!retirementResult || retirementResult.retired !== true) {
    return null
  }

  const result = xrayCache.compactRetiredSqliteCache(cachePath, { lowFileCache: true })
  if (!result || result.compacted !== true) {
    return result
  }

  if (result.alreadyCompacted === true) {
    return result
  }

  if (result.skippedVacuum === true) {
    log.info(`Xray retired cache compaction skipped: phase=${phase}`)
    return result
  }

  log.info(`Xray retired cache compacted: phase=${phase}`)
  return result
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
  return normalizePositiveInt(cfg.cacheRefreshInterval, pluginConfig.cacheRefreshInterval)
}

function getCacheBatchTimeoutSeconds (cfg) {
  return Math.max(normalizePositiveInt(cfg.cacheBatchTimeout, pluginConfig.cacheBatchTimeout), CACHE_PROBE_SAMPLE_TIMEOUT)
}

function getBootstrapBatchTimeoutSeconds (cfg) {
  return Math.max(normalizePositiveInt(cfg.bootstrapBatchTimeout ?? cfg.initialRefreshBatchTimeout, pluginConfig.bootstrapBatchTimeout), CACHE_PROBE_SAMPLE_TIMEOUT)
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
  return normalizePositiveInt(cfg.cacheRefreshBatchSize, pluginConfig.cacheRefreshBatchSize)
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

  logStage2MemoryUsage(log, 'subscription-load-start', {
    subscriptions: total,
    candidateNodes: Array.isArray(nodeTarget) ? nodeTarget.length : 0,
  })
  logStage2FileUsage(log, 'subscription-load-start', stage2SeenCachePath, {
    subscriptions: total,
    candidateNodes: Array.isArray(nodeTarget) ? nodeTarget.length : 0,
  })

  const stage2SeenExtraPaths = stage2SeenCachePath ? [xrayCache.getStage2SeenDbPath(stage2SeenCachePath)].filter(Boolean) : []

  const reclaimStage2SqliteMemory = async (reason, extra = {}, options = {}) => {
    if (!stage2SeenCachePath) {
      return
    }

    if (stage2SeenFilter && typeof stage2SeenFilter.shrinkMemory === 'function') {
      stage2SeenFilter.shrinkMemory()
    }

    xrayCache.dropSqliteFileCache(stage2SeenCachePath, stage2SeenExtraPaths, {
      logFadvise: (label, detail) => logStage2MemoryUsage(log, label, { ...detail, reason, ...extra }),
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
      logStage2FileUsage(log, 'accepted-buffer-before-flush', stage2SeenCachePath, {
        source: meta && meta.displayLabel,
        nodeKeys: pendingNodeKeyCount,
        nodes: pendingNodeCount,
      })
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
      logStage2FileUsage(log, 'accepted-buffer-after-flush', stage2SeenCachePath, {
        source: meta && meta.displayLabel,
        nodeKeys: pendingNodeKeyCount,
        nodes: pendingNodeCount,
      })
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
            logStage2MemoryUsage(log, 'subscription-large-before-parse', {
              subscription: subscriptionLabel,
              bytes,
              reason,
            })
            logStage2FileUsage(log, 'subscription-large-before-parse', stage2SeenCachePath, {
              subscription: subscriptionLabel,
              bytes,
              reason,
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
            let parsedChunkCount = 0
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
                parsedChunkCount += 1
                if (shouldLogDetail && parsedChunkCount % STAGE2_SUBSCRIPTION_PARSE_GC_CHUNKS === 0) {
                  const shouldLogChunkGc = parsedChunkCount === 1 || parsedChunkCount % 100 === 0
                  if (shouldLogChunkGc) {
                    logStage2FileUsage(log, 'subscription-large-parse-chunks', stage2SeenCachePath, {
                      subscription: subscriptionLabel,
                      chunks: parsedChunkCount,
                      acceptedNodeKeys: subscriptionSnapshot.acceptedNodeKeyCount,
                    })
                  }
                  await runStage2GarbageCollection(log, 'large-subscription-parse-chunks', {
                    subscription: subscriptionLabel,
                    chunks: parsedChunkCount,
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
              logStage2MemoryUsage(log, 'subscription-large-after-parse', {
                subscription: subscriptionLabel,
                bytes: summary.bytes,
                nodes: parsedNodeCount,
              })
              logStage2FileUsage(log, 'subscription-large-after-parse', stage2SeenCachePath, {
                subscription: subscriptionLabel,
                bytes: summary.bytes,
                nodes: parsedNodeCount,
              })
            }
            const protocolSummary = summarizeProtocolCounts(summary.protocolCounts)
            if (parsedNodeCount === 0) {
              log.warn(`订阅解析为空: ${subscriptionLabel}, bytes=${summary.bytes}, protocols=${protocolSummary}`)
            } else {
              log.info(`订阅解析成功: ${subscriptionLabel}, nodes=${parsedNodeCount}, bytes=${summary.bytes}, mode=${parseSummary.streamMode || 'stream'}, protocols=${protocolSummary}`)
            }
            if (shouldLogPostParseDetail) {
              logStage2MemoryUsage(log, 'subscription-large-after-accept', {
                subscription: subscriptionLabel,
                acceptedNodeKeys: subscriptionSnapshot.acceptedNodeKeyCount,
                snapshots: batchSubscriptions.length,
              })
            }
            if (shouldLogPostParseDetail) {
              await yieldToEventLoop()
              logStage2MemoryUsage(log, 'subscription-large-after-yield', {
                subscription: subscriptionLabel,
                acceptedNodeKeys: subscriptionSnapshot.acceptedNodeKeyCount,
              })
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

      logStage2MemoryUsage(log, 'subscription-batch-finished', {
        processed: Math.min(i + SUBSCRIPTION_BATCH_SIZE, total),
        total,
        uniqueNodes: maintainLocalNodeArray ? seen.size : (stage2SeenCachePath ? acceptedUniqueNodeCount : seenNodeKeys.size),
        snapshots: snapshotCount,
      })

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

  const normalizedBatchSize = Math.max(1, normalizePositiveInt(batchSize, pluginConfig.cacheRefreshBatchSize))
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
    if (!parser.isNodeSupportedByCurrentXray(node)) {
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

  async function probeNodesBatch ({ binPath, cfg, xrayDir, batchNodes, timeoutMs, probeSamples = pluginConfig.cacheRefreshProbeSamples }) {
    const effectiveProbeSamples = normalizePositiveInt(probeSamples, pluginConfig.cacheRefreshProbeSamples)

    if (!Array.isArray(batchNodes) || batchNodes.length === 0) {
      return {
        entries: [],
        observedFingerprints: [],
      }
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
      const liveConfigBakPath = path.join(xrayDir, 'config.json.bak')
      const cachePath = path.join(xrayDir, 'nodes_cache.sqlite')
      const startupNodeLimit = normalizePositiveInt(cfg.startupNodeLimit, pluginConfig.startupNodeLimit)
      const allowedCountries = cfg.allowedCountries
      const allowedOwners = cfg.allowedOwners
      const maxDelayMs = normalizeNonNegativeInt(cfg.maxDelayMs, 0)

      const startupMigration = xrayCache.migrateHotColdSchema(cachePath, {
        batchLimit: HOT_COLD_MIGRATION_STAGE1_BATCH_ROWS,
        maxRows: HOT_COLD_MIGRATION_STAGE1_BATCH_ROWS,
        lowFileCache: true,
      })
      maybeLogHotColdMigrationProgress(log, 'stage1', startupMigration)
      const stage1Retirement = maybeRetireLegacyNodesStorage(log, cachePath, 'stage1', startupMigration)
      maybeCompactRetiredSqliteCache(log, cachePath, 'stage1', stage1Retirement)
      await reclaimStageSqliteFileCache(log, 'stage1-after-cache-bootstrap-reclaim', cachePath, {
        migratedRows: startupMigration.migratedRows,
        migrationPending: startupMigration.pending,
      }, {
        forceGc: true,
      })

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
      const bootstrapCandidateLimit = getBootstrapCandidateLimit(cfg)
      const stableFallbackQuery = buildCacheEntryQueryOptions({
        stableOnly: true,
        maxDelayMs,
        limit: bootstrapCandidateLimit,
      })
      const bootstrapCandidateQuery = buildCacheEntryQueryOptions({
        limit: bootstrapCandidateLimit,
      })
      const fallbackStableSourceEntries = xrayCache.readCacheEntriesForStartup(cachePath, stableFallbackQuery)
      const bootstrapCandidateEntries = xrayCache.readCacheEntriesForStartup(cachePath, bootstrapCandidateQuery)
      const fallbackStableEntries = (await collectBootstrapCandidateEntries(fallbackStableSourceEntries, allowedCountries, allowedOwners, startupNodeLimit)).entries
      const supportedFallbackEntries = fallbackStableEntries.filter(entry => parser.isNodeSupportedByCurrentXray(entry.node))
      const bootstrapCandidates = bootstrapCandidateEntries.map(entry => entry.node).filter(node => parser.isNodeSupportedByCurrentXray(node))
      log.info(`Xray 启动预检查: source=nodes-cache, stableFallbackLoaded=${fallbackStableSourceEntries.length}, stableFallbackFiltered=${fallbackStableEntries.length}, stableFallbackSupported=${supportedFallbackEntries.length}, bootstrapCandidates=${bootstrapCandidateEntries.length}, bootstrapSupported=${bootstrapCandidates.length}, allowedCountries=${Array.isArray(allowedCountries) ? allowedCountries.join(',') : ''}, allowedOwners=${Array.isArray(allowedOwners) ? allowedOwners.join(',') : ''}`)

      let bootstrapSelectedEntries = []

      if (bootstrapCandidates.length > 0) {
        try {
          const bootstrapProbeResult = await probeNodesBatch({
            binPath,
            cfg,
            xrayDir,
            batchNodes: bootstrapCandidates,
            timeoutMs: getBootstrapBatchTimeoutSeconds(cfg) * 1000,
            probeSamples: getBootstrapProbeSamples(cfg),
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
          bootstrapSelectedEntries = xrayCache.sortCacheEntries(bootstrapByOwner).slice(0, startupNodeLimit)
          log.info(`Xray 启动前快速复检: source=nodes-cache, candidateLimit=${bootstrapCandidateLimit}, queried=${bootstrapCandidateEntries.length}, tested=${bootstrapCandidates.length}, available=${annotatedBootstrapEntries.length}, afterDelay=${bootstrapByDelay.length}, afterCountry=${bootstrapByCountry.length}, afterOwner=${bootstrapByOwner.length}, selected=${bootstrapSelectedEntries.length}`)
        } catch (error) {
          log.warn('Xray 启动前快速复检失败，回退到上次稳定缓存:', error)
        }
      }

      const startupNodeCandidates = []
      appendItems(startupNodeCandidates, bootstrapSelectedEntries.map(entry => entry.node))
      appendItems(startupNodeCandidates, supportedFallbackEntries.map(entry => entry.node))
      const startupNodes = xrayCache.deduplicateNodes(startupNodeCandidates).slice(0, startupNodeLimit)

      log.info(`Xray 启动节点候选: source=nodes-cache, fallbackStable=${fallbackStableEntries.length}, fallbackSupported=${supportedFallbackEntries.length}, startupSelected=${startupNodes.length}`)

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

      const stage2Migration = xrayCache.migrateHotColdSchema(cachePath, {
        batchLimit: HOT_COLD_MIGRATION_STAGE2_BATCH_ROWS,
        maxRows: HOT_COLD_MIGRATION_STAGE2_BATCH_ROWS,
        lowFileCache: true,
      })
      maybeLogHotColdMigrationProgress(log, 'stage2', stage2Migration)
      const stage2Retirement = maybeRetireLegacyNodesStorage(log, cachePath, 'stage2', stage2Migration)
      maybeCompactRetiredSqliteCache(log, cachePath, 'stage2', stage2Retirement)
      await reclaimStageSqliteFileCache(log, 'stage2-after-migration-reclaim', cachePath, {
        migratedRows: stage2Migration.migratedRows,
        migrationPending: stage2Migration.pending,
      }, {
        forceGc: true,
      })

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

      logStage2MemoryUsage(log, 'stage2-before-subscription-load', {
        configNodes: configNodes.length,
        manualNodes: manualNodes.length,
        deduplicated: localCandidateNodes.length,
      })

      const cacheSizeBeforeStage2 = xrayCache.getSqliteCacheSizeBytes(cachePath)
      if (cacheSizeBeforeStage2 >= CACHE_SIZE_LIMIT_BYTES) {
        const cleanupResult = xrayCache.cleanupOutdatedToSizeLimit(cachePath, CACHE_SIZE_TARGET_BYTES)
        if (cleanupResult) {
          log.warn(`Xray 节点缓存过大，已尝试清理 outdated tombstone: deleted=${cleanupResult.deleted}, sizeBefore=${cleanupResult.sizeBefore}, sizeAfter=${cleanupResult.sizeAfter}, limit=${CACHE_SIZE_LIMIT_BYTES}`)
        }
      }

      const initialSyncStats = syncCandidateNodesToCache(cachePath, localCandidateNodes)
      totalSupportedCandidateCount += initialSyncStats.supportedCount
      totalCacheMatchedCount += initialSyncStats.cacheMatchedCount
      totalOutdatedSkippedCount += initialSyncStats.outdatedSkippedCount
      totalAddedCount += initialSyncStats.addedCount
      totalCountryReadyCount += initialSyncStats.countryReadyCount

      if (shouldSkipSubscriptionFetch) {
        log.info(`Xray 订阅抓取已跳过: effectiveCache=${subscriptionSyncDecision.effectiveCacheCount}, lowWatermark=${subscriptionSyncDecision.lowWatermark}, subscriptions=${Array.isArray(cfg.subscriptions) ? cfg.subscriptions.length : 0}`)
      } else {
        const initialStage2SeenNodeKeys = collectUniqueNodeKeys(localCandidateNodes)
        logStage2FileUsage(log, 'stage2-before-seen-reset', cachePath, {
          initialNodeKeys: initialStage2SeenNodeKeys.length,
        })
        if (!xrayCache.resetStage2SeenNodeKeys(cachePath, initialStage2SeenNodeKeys)) {
          throw new Error('Xray stage2 seen-node initialization failed')
        }
        logStage2FileUsage(log, 'stage2-after-seen-reset', cachePath, {
          initialNodeKeys: initialStage2SeenNodeKeys.length,
        })
        if (subscriptionSyncDecision.lowWatermark > 0) {
          log.info(`Xray 订阅抓取已触发: effectiveCache=${subscriptionSyncDecision.effectiveCacheCount}, lowWatermark=${subscriptionSyncDecision.lowWatermark}, subscriptions=${Array.isArray(cfg.subscriptions) ? cfg.subscriptions.length : 0}`)
        }
        const subscriptionResult = await loadSubscriptionNodes(cfg.subscriptions, log, {
          nodeTarget: [],
          stage2SeenCachePath: cachePath,
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

      const subscriptionFetchMode = shouldSkipSubscriptionFetch ? 'skipped' : 'loaded'
      const effectiveCacheLabel = subscriptionSyncDecision.effectiveCacheCount == null ? 'n/a' : subscriptionSyncDecision.effectiveCacheCount

      const totalUniqueCandidateCount = localCandidateNodes.length + subscriptionNodeCount

      logStage2MemoryUsage(log, 'stage2-after-subscription-load', {
        subscriptionNodes: subscriptionNodeCount,
        deduplicated: totalUniqueCandidateCount,
        supported: totalSupportedCandidateCount,
        snapshots: subscriptionSnapshotCount,
      })
      logStage2FileUsage(log, 'stage2-after-subscription-load', cachePath, {
        subscriptionNodes: subscriptionNodeCount,
        deduplicated: totalUniqueCandidateCount,
        supported: totalSupportedCandidateCount,
        snapshots: subscriptionSnapshotCount,
        refs: subscriptionSyncRefs,
      })

      log.info(`Xray 节点汇总候选: configBak=${configNodes.length}, cacheMatched=${totalCacheMatchedCount}, manual=${manualNodes.length}, subscriptions=${subscriptionNodeCount}, subscriptionFetch=${subscriptionFetchMode}, effectiveCache=${effectiveCacheLabel}, lowWatermark=${subscriptionSyncDecision.lowWatermark}, deduplicated=${totalUniqueCandidateCount}, unsupportedDropped=${Math.max(0, totalUniqueCandidateCount - totalSupportedCandidateCount)}, selected=${totalSupportedCandidateCount}`)

      if (totalSupportedCandidateCount === 0) {
        log.warn('Xray 节点汇总: 未找到任何候选节点，跳过缓存同步')
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
        logStage2MemoryUsage(log, 'stage2-before-subscription-sync', {
          snapshots: subscriptionSnapshotCount,
          supportedNodes: totalSupportedCandidateCount,
          refs: subscriptionSyncRefs,
        })
        logStage2FileUsage(log, 'stage2-before-subscription-sync', cachePath, {
          snapshots: subscriptionSnapshotCount,
          supportedNodes: totalSupportedCandidateCount,
          refs: subscriptionSyncRefs,
        })
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
        logStage2MemoryUsage(log, 'stage2-after-subscription-sync', {
          snapshots: subscriptionSnapshotCount,
        })
        logStage2FileUsage(log, 'stage2-after-subscription-sync', cachePath, {
          snapshots: subscriptionSnapshotCount,
          refs: subscriptionSyncRefs,
        })
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

      const stage3Migration = xrayCache.migrateHotColdSchema(cachePath, {
        batchLimit: HOT_COLD_MIGRATION_STAGE3_BATCH_ROWS,
        maxRows: HOT_COLD_MIGRATION_STAGE3_BATCH_ROWS,
        lowFileCache: true,
      })
      maybeLogHotColdMigrationProgress(log, 'stage3', stage3Migration)
      const stage3Retirement = maybeRetireLegacyNodesStorage(log, cachePath, 'stage3', stage3Migration)
      maybeCompactRetiredSqliteCache(log, cachePath, 'stage3', stage3Retirement)
      await reclaimStageSqliteFileCache(log, 'stage3-after-migration-reclaim', cachePath, {
        migratedRows: stage3Migration.migratedRows,
        migrationPending: stage3Migration.pending,
      })

      const generation = ++refreshGeneration
      const roundStartedAt = Date.now()
      const cacheRefreshInterval = getCacheRefreshIntervalSeconds(cfg) * 1000
      const cacheBatchTimeout = getCacheBatchTimeoutSeconds(cfg) * 1000

      const dueBefore = xrayCache.formatLocalTimestamp(new Date(roundStartedAt))
      const batchSize = getCacheRefreshBatchSize(cfg)
      const totalDueCandidateCount = xrayCache.countCacheEntries(cachePath, { dueBefore })
      const maxDueRowIds = xrayCache.readCacheRowIds(cachePath, {
        orderBy: 'rowid_desc',
        dueBefore,
        limit: 1,
      })
      const maxDueRowId = maxDueRowIds.length > 0 ? maxDueRowIds[0] : 0
      const plannedBatchCount = totalDueCandidateCount === 0 ? 0 : Math.ceil(totalDueCandidateCount / batchSize)

      if (totalDueCandidateCount === 0) {
        log.info('Xray 缓存周期探测: 当前没有到期的可探测节点')
        const nextDelay = resolveNextCacheRefreshDelay(roundStartedAt, cacheRefreshInterval)
        writeStage3RoundSummary({
          xrayDir,
          summary: {
            status: 'empty',
            startedAt: new Date(roundStartedAt).toISOString(),
            endedAt: new Date().toISOString(),
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
            nextRefreshAt: new Date(Date.now() + nextDelay).toISOString(),
            subscriptions: xrayCache.readSubscriptionAvailabilitySummary(cachePath).filter(subscription => subscription.configured),
          },
        })
        scheduleCacheRefresh({ binPath, cfg, xrayDir, cachePath }, nextDelay)
        return
      }

      log.info(`Xray 缓存周期探测候选: due=${totalDueCandidateCount}, batchSize=${batchSize}, plannedBatchCount=${plannedBatchCount}`)

      let successBatchCount = 0
      let availableCount = 0
      let removedCount = 0
      let explicitFailureCount = 0
      let partialCoverageCount = 0
      let batchIndex = 0
      let processedCount = 0
      let lastScannedRowId = 0
      const roundAvailableNodeKeys = new Set()

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

        log.info(`Xray 缓存周期探测批次: ${nextBatchIndex}, progress=${processedCount}/${totalDueCandidateCount}, batchSize=${candidateNodes.length}`)

        try {
          const batchProbeResult = await probeNodesBatch({
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

          const annotatedEntries = await annotateProbeEntries(batchProbeResult.entries, {
            binPath,
            xrayDir,
            existingEntries: targetBatch,
            log,
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
            targetBatch,
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
          partialCoverageCount += batchWritePlan.partialCoverageCount
          for (const nodeKey of batchWritePlan.availableNodeKeys) {
            if (nodeKey) {
              roundAvailableNodeKeys.add(nodeKey)
            }
          }

          log.info(`Xray 缓存周期探测批次已写回: ${batchIndex}, available=${batchWritePlan.availableCount}, explicitFailed=${batchWritePlan.explicitFailureCount}, removed=${batchWritePlan.removedCount}, partialCoverage=${batchWritePlan.partialCoverageCount}, progress=${processedCount}/${totalDueCandidateCount} -> ${cachePath}`)

          // Drop SQLite file cache pages after each stage-3 batch write-back
          // to prevent monotonic page-cache growth during long-running probe cycles.
          xrayCache.dropSqliteFileCache(cachePath, [], { label: `stage3-batch-${batchIndex}` })

          if (batchWritePlan.availableCount === 0 && batchWritePlan.explicitFailureCount > 0) {
            log.warn(`Xray 缓存周期探测: 批次 ${batchIndex} 没有可用节点，已按失败回退策略处理`)
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
            subscriptions: xrayCache.readSubscriptionAvailabilitySummary(cachePath).filter(subscription => subscription.configured),
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
        const nextDelay = resolveNextCacheRefreshDelay(roundStartedAt, cacheRefreshInterval)
        const nextRefreshAt = new Date(Date.now() + nextDelay).toISOString()
        const summaryPath = writeStage3RoundSummary({
          xrayDir,
          summary: {
            status: roundStatus,
            startedAt: new Date(roundStartedAt).toISOString(),
            endedAt: new Date().toISOString(),
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
    applyStage3ProbeResults,
    classifyRefreshPriority,
    getFailureBackoffMs,
    selectStage3RefreshCandidates,
    toLocalTimestampAfterMs,
  },
}
