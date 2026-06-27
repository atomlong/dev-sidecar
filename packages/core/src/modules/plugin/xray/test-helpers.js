const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const xrayCache = require('./cache')
const LOCAL_INPUT_STATE_FILE_NAME = 'nodes_cache.state.json'
const LOCAL_INPUT_STATE_SIGNATURE_VERSION = 2
const LOCAL_INPUT_STATE_SEMANTICS_VERSION = 'xray-stage2-local-input-v2'
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
function buildCacheEntryQueryOptions ({ allowedCountries, allowedOwners, stableOnly = false, maxDelayMs = 0, limit = null, offset = 0, orderBy = 'default' } = {}) {
  const countryFilters = {
    include: [],
    exclude: [],
  }
  const ownerFilters = parseOwnerFilters(allowedOwners)
  if (Array.isArray(allowedCountries)) {
    for (const value of allowedCountries) {
      const normalized = normalizeCountryCode(value)
      if (normalized) {
        countryFilters.include.push(normalized)
      }
    }
  } else if (typeof allowedCountries === 'string') {
    for (const token of allowedCountries.split(/[\s,;]+/)) {
      const normalized = normalizeCountryCode(token.startsWith('!') ? token.slice(1) : token)
      if (!normalized) {
        continue
      }
      if (token.startsWith('!')) {
        countryFilters.exclude.push(normalized)
      } else {
        countryFilters.include.push(normalized)
      }
    }
  }
  return {
    stableOnly,
    maxDelayMs,
    limit,
    offset,
    orderBy,
    countryInclude: [...new Set(countryFilters.include)],
    countryExclude: [...new Set(countryFilters.exclude)],
    ownerInclude: ownerFilters.include,
    ownerExclude: ownerFilters.exclude,
  }
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
function isStartupSelectEnabled (cfg) {
  return cfg ? cfg.startupSelectEnabled !== false : true
}
function isSubscriptionSyncEnabled (cfg) {
  return cfg ? cfg.subscriptionSyncEnabled !== false : true
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
function ensureDir (dirPath) {
  if (!dirPath) {
    return
  }
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true })
  }
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
function getStage3RoundSummaryPath (xrayDir) {
  return path.join(xrayDir, 'stage3-last-round.json')
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
      failureStreak: existingEntry && Number.isFinite(existingEntry.failureStreak) ? existingEntry.failureStreak : 0,
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
module.exports = {
  buildCacheEntryQueryOptions,
  buildLocalInputState,
  cleanupProbeArtifacts,
  createCacheSyncPlan,
  getLocalInputStatePath,
  getStage3RoundSummaryPath,
  getSubscriptionStaleAfterDays,
  getSubscriptionSyncDecision,
  isCacheRefreshEnabled,
  isStartupSelectEnabled,
  isSubscriptionSyncEnabled,
  isLocalInputStateMatch,
  readLocalInputState,
  writeLocalInputState,
}
