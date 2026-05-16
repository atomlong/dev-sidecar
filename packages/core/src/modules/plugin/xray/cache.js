const fs = require('node:fs')
const path = require('node:path')
const parser = require('./parser')

let betterSqlite3 = null
let betterSqlite3LoadAttempted = false

const SQLITE_AUTO_VACUUM_NONE = 0
const SQLITE_AUTO_VACUUM_INCREMENTAL = 2
const SQLITE_INCREMENTAL_VACUUM_MIN_FREE_PAGES = 4096
const SQLITE_INCREMENTAL_VACUUM_FREE_RATIO = 0.05
const SQLITE_INCREMENTAL_VACUUM_AGGRESSIVE_FREE_RATIO = 0.5
const SQLITE_INCREMENTAL_VACUUM_STEP_PAGES = 2048
const SQLITE_INCREMENTAL_VACUUM_MIN_INTERVAL_MS = 10 * 60 * 1000

let lastIncrementalVacuumAt = 0

function loadBetterSqlite3 () {
  if (betterSqlite3LoadAttempted) {
    return betterSqlite3
  }

  betterSqlite3LoadAttempted = true
  try {
    betterSqlite3 = require('better-sqlite3')
  } catch {
    betterSqlite3 = null
  }
  return betterSqlite3
}

function clone (value) {
  if (value == null) {
    return value
  }
  return JSON.parse(JSON.stringify(value))
}

function ensureDir (dirPath) {
  if (!dirPath) {
    return
  }
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true })
  }
}

function safeReadJson (filePath, fallback = null) {
  try {
    if (!filePath || !fs.existsSync(filePath)) {
      return fallback
    }
    const raw = fs.readFileSync(filePath, 'utf-8')
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

function getSqliteCachePath (cacheFilePath) {
  if (path.extname(cacheFilePath) === '.sqlite') {
    return cacheFilePath
  }

  const parsed = path.parse(cacheFilePath)
  return path.join(parsed.dir, `${parsed.name}.sqlite`)
}

function buildNodesTableSchemaSql () {
  return `
    CREATE TABLE IF NOT EXISTS nodes (
      fingerprint TEXT PRIMARY KEY,
      node_json TEXT NOT NULL,
      stable INTEGER NOT NULL DEFAULT 0,
      delay REAL,
      country TEXT,
      owner TEXT,
      source TEXT,
      updated_at TEXT,
      tag TEXT
    );
  `
}

function createSqliteSchema (db) {
  db.exec(buildNodesTableSchemaSql())
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_nodes_sort ON nodes(stable DESC, delay ASC, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_nodes_country_sort ON nodes(country, stable DESC, delay ASC, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_nodes_refresh ON nodes(updated_at ASC, delay ASC);
  `)
}

function openSqliteCache (cacheFilePath) {
  const Database = loadBetterSqlite3()
  if (!Database) {
    return null
  }

  const sqlitePath = getSqliteCachePath(cacheFilePath)
  ensureDir(path.dirname(sqlitePath))
  const isNewDatabase = !fs.existsSync(sqlitePath) || fs.statSync(sqlitePath).size === 0
  const db = new Database(sqlitePath)
  if (isNewDatabase) {
    db.pragma('auto_vacuum = INCREMENTAL')
  }
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  createSqliteSchema(db)
  return db
}

function maybeRunIncrementalVacuum (db) {
  if (!db) {
    return false
  }

  const autoVacuum = Number(db.pragma('auto_vacuum', { simple: true }) || SQLITE_AUTO_VACUUM_NONE)
  if (autoVacuum !== SQLITE_AUTO_VACUUM_INCREMENTAL) {
    return false
  }

  const pageCount = Number(db.pragma('page_count', { simple: true }) || 0)
  const freelistCount = Number(db.pragma('freelist_count', { simple: true }) || 0)
  if (pageCount <= 0 || freelistCount < SQLITE_INCREMENTAL_VACUUM_MIN_FREE_PAGES) {
    return false
  }

  const freeRatio = freelistCount / pageCount
  if (freeRatio < SQLITE_INCREMENTAL_VACUUM_FREE_RATIO) {
    return false
  }

  const shouldRunAggressiveVacuum = freeRatio >= SQLITE_INCREMENTAL_VACUUM_AGGRESSIVE_FREE_RATIO
  if (!shouldRunAggressiveVacuum && (Date.now() - lastIncrementalVacuumAt) < SQLITE_INCREMENTAL_VACUUM_MIN_INTERVAL_MS) {
    return false
  }

  const steps = shouldRunAggressiveVacuum
    ? freelistCount
    : Math.min(SQLITE_INCREMENTAL_VACUUM_STEP_PAGES, freelistCount)
  if (steps <= 0) {
    return false
  }

  db.pragma(`incremental_vacuum(${steps})`)
  lastIncrementalVacuumAt = Date.now()
  return true
}

function normalizeMetadataLabel (value) {
  return String(value || '').trim().toUpperCase()
}

function normalizeCountryCode (value) {
  const normalized = normalizeMetadataLabel(value)
  return /^[A-Z]{2}$/.test(normalized) ? normalized : ''
}

function normalizeOwnerFilterKeyword (value) {
  return String(value || '').trim().toLowerCase()
}

function normalizeFilterValues (values, normalizer) {
  if (!Array.isArray(values)) {
    return []
  }

  return [...new Set(values
    .map(value => normalizer(value))
    .filter(Boolean))]
}

function resolveOwnerLabel (...values) {
  for (const value of values) {
    const normalized = normalizeMetadataLabel(value)
    if (normalized && !/^[A-Z]{2}$/.test(normalized)) {
      return normalized
    }
  }

  return ''
}

function normalizeDelayMs (rawDelay) {
  const parsed = Number(rawDelay)
  if (!Number.isFinite(parsed)) {
    return null
  }

  const absolute = Math.abs(parsed)
  if (absolute >= 1000000) {
    return parsed / 1000000
  }

  return parsed
}

function formatLocalTimestamp (value = new Date()) {
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) {
    return null
  }

  const pad = number => String(Math.trunc(Math.abs(number))).padStart(2, '0')
  const timezoneOffsetMinutes = -date.getTimezoneOffset()
  const timezoneSign = timezoneOffsetMinutes >= 0 ? '+' : '-'
  const offsetMinutes = Math.abs(timezoneOffsetMinutes)
  const offsetHours = pad(Math.floor(offsetMinutes / 60))
  const offsetRemainder = pad(offsetMinutes % 60)

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${String(date.getMilliseconds()).padStart(3, '0')}${timezoneSign}${offsetHours}:${offsetRemainder}`
}

function fingerprintNode (node) {
  if (!node || typeof node !== 'object') {
    return ''
  }

  const cloned = stripNodeMetadata(node)
  return JSON.stringify(cloned)
}

function stripNodeMetadata (node) {
  const cloned = clone(node)
  if (!cloned || typeof cloned !== 'object') {
    return cloned
  }

  parser.sanitizeNodeForCurrentXray(cloned)

  delete cloned.tag
  delete cloned.owner
  delete cloned.provider
  delete cloned.country
  delete cloned.countryCode
  return cloned
}

function sanitizeCacheEntryForWrite (entry) {
  if (!entry || typeof entry !== 'object') {
    return null
  }

  const owner = resolveOwnerLabel(entry.owner)
  const normalizedNode = entry.node ? stripNodeMetadata(entry.node) : undefined

  const normalizedEntry = {
    ...entry,
    node: normalizedNode,
    delay: normalizeDelayMs(entry.delay),
    updatedAt: formatLocalTimestamp(entry.updatedAt) || null,
  }

  const country = normalizeCountryCode(entry.country || entry.countryCode)
  if (country) {
    normalizedEntry.country = country
  } else {
    delete normalizedEntry.country
  }

  if (owner) {
    normalizedEntry.owner = owner
  } else {
    delete normalizedEntry.owner
  }

  return normalizedEntry
}

function serializeCacheEntryForSqlite (entry) {
  const normalizedEntry = sanitizeCacheEntryForWrite(entry)
  if (!normalizedEntry || !normalizedEntry.node) {
    return null
  }

  const fingerprint = fingerprintNode(normalizedEntry.node)
  if (!fingerprint) {
    return null
  }

  return {
    fingerprint,
    nodeJson: JSON.stringify(normalizedEntry.node),
    stable: normalizedEntry.stable === true || normalizedEntry.stable === 'true' ? 1 : 0,
    delay: Number.isFinite(normalizedEntry.delay) ? normalizedEntry.delay : null,
    country: normalizeCountryCode(normalizedEntry.country || normalizedEntry.countryCode),
    owner: resolveOwnerLabel(normalizedEntry.owner),
    source: normalizedEntry.source || '',
    updatedAt: normalizedEntry.updatedAt || null,
    tag: normalizedEntry.tag || '',
  }
}

function deserializeSqliteCacheEntry (row) {
  if (!row || !row.node_json) {
    return null
  }

  let node
  try {
    node = JSON.parse(row.node_json)
  } catch {
    return null
  }

  return normalizeCacheEntry({
    node,
    stable: row.stable === 1,
    delay: row.delay,
    country: row.country || '',
    owner: row.owner || '',
    source: row.source || '',
    updatedAt: row.updated_at || null,
    tag: row.tag || '',
  })
}

function buildSqliteFilterClauses (filters = {}) {
  const clauses = []
  const params = []

  if (filters.stableOnly === true) {
    clauses.push('stable = 1')
  }

  const maxDelayMs = normalizeDelayMs(filters.maxDelayMs)
  if (Number.isFinite(maxDelayMs) && maxDelayMs > 0) {
    clauses.push('delay IS NOT NULL')
    clauses.push('delay <= ?')
    params.push(maxDelayMs)
  }

  const countryInclude = normalizeFilterValues(filters.countryInclude, normalizeCountryCode)
  const countryExclude = normalizeFilterValues(filters.countryExclude, normalizeCountryCode)
  if (countryInclude.length > 0) {
    clauses.push(`country IN (${countryInclude.map(() => '?').join(', ')})`)
    params.push(...countryInclude)
  }
  if (countryExclude.length > 0) {
    clauses.push(`(country IS NULL OR country = '' OR country NOT IN (${countryExclude.map(() => '?').join(', ')}))`)
    params.push(...countryExclude)
  }

  const ownerInclude = normalizeFilterValues(filters.ownerInclude, normalizeOwnerFilterKeyword)
  const ownerExclude = normalizeFilterValues(filters.ownerExclude, normalizeOwnerFilterKeyword)
  if (ownerInclude.length > 0) {
    clauses.push(`(${ownerInclude.map(() => 'instr(lower(owner), ?) > 0').join(' OR ')})`)
    params.push(...ownerInclude)
  }
  if (ownerExclude.length > 0) {
    for (const keyword of ownerExclude) {
      clauses.push("(owner IS NULL OR owner = '' OR instr(lower(owner), ?) = 0)")
      params.push(keyword)
    }
  }

  return { clauses, params }
}

function getSqliteOrderByClause (orderBy = 'default') {
  if (orderBy === 'refresh') {
    return `COALESCE(updated_at, '') ASC, COALESCE(delay, 9223372036854775807) ASC`
  }

  return `stable DESC, COALESCE(delay, 9223372036854775807) ASC, COALESCE(updated_at, '') DESC`
}

function normalizeSqliteQueryLimit (value) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    return null
  }

  const normalized = Math.floor(parsed)
  return normalized >= 0 ? normalized : null
}

function normalizeSqliteQueryOffset (value) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    return 0
  }

  const normalized = Math.floor(parsed)
  return normalized > 0 ? normalized : 0
}

function readSqliteCacheEntries (cacheFilePath, options = {}) {
  const sqlitePath = getSqliteCachePath(cacheFilePath)
  if (!fs.existsSync(sqlitePath)) {
    return []
  }

  let db = null
  try {
    db = openSqliteCache(cacheFilePath)
    if (!db) {
      return []
    }

    const { clauses, params } = buildSqliteFilterClauses(options)
    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    const limit = normalizeSqliteQueryLimit(options.limit)
    const offset = normalizeSqliteQueryOffset(options.offset)
    let sql = `
      SELECT node_json, stable, delay, country, owner, source, updated_at, tag
      FROM nodes
      ${whereClause}
      ORDER BY ${getSqliteOrderByClause(options.orderBy)}
    `
    const queryParams = [...params]

    if (limit != null) {
      sql += '\n      LIMIT ?'
      queryParams.push(limit)
    }
    if (offset > 0) {
      if (limit == null) {
        sql += '\n      LIMIT -1'
      }
      sql += '\n      OFFSET ?'
      queryParams.push(offset)
    }

    const rows = db.prepare(sql).all(...queryParams)
    return rows.map(deserializeSqliteCacheEntry).filter(Boolean)
  } catch {
    return []
  } finally {
    if (db) {
      db.close()
    }
  }
}

function readSqliteCacheRowIds (cacheFilePath, options = {}) {
  const sqlitePath = getSqliteCachePath(cacheFilePath)
  if (!fs.existsSync(sqlitePath)) {
    return []
  }

  let db = null
  try {
    db = openSqliteCache(cacheFilePath)
    if (!db) {
      return []
    }

    const { clauses, params } = buildSqliteFilterClauses(options)
    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    const limit = normalizeSqliteQueryLimit(options.limit)
    const offset = normalizeSqliteQueryOffset(options.offset)
    let sql = `
      SELECT rowid
      FROM nodes
      ${whereClause}
      ORDER BY ${getSqliteOrderByClause(options.orderBy)}
    `
    const queryParams = [...params]

    if (limit != null) {
      sql += '\n      LIMIT ?'
      queryParams.push(limit)
    }
    if (offset > 0) {
      if (limit == null) {
        sql += '\n      LIMIT -1'
      }
      sql += '\n      OFFSET ?'
      queryParams.push(offset)
    }

    const rows = db.prepare(sql).all(...queryParams)
    return rows
      .map(row => Number(row && row.rowid))
      .filter(rowId => Number.isInteger(rowId) && rowId > 0)
  } catch {
    return []
  } finally {
    if (db) {
      db.close()
    }
  }
}

function readSqliteCacheEntriesByRowIds (cacheFilePath, rowIds) {
  if (!Array.isArray(rowIds) || rowIds.length === 0) {
    return []
  }

  const sqlitePath = getSqliteCachePath(cacheFilePath)
  if (!fs.existsSync(sqlitePath)) {
    return []
  }

  const uniqueRowIds = [...new Set(rowIds
    .map(rowId => Number(rowId))
    .filter(rowId => Number.isInteger(rowId) && rowId > 0))]
  if (uniqueRowIds.length === 0) {
    return []
  }

  let db = null
  try {
    db = openSqliteCache(cacheFilePath)
    if (!db) {
      return []
    }

    const placeholders = uniqueRowIds.map(() => '?').join(', ')
    const rows = db.prepare(`
      SELECT rowid, node_json, stable, delay, country, owner, source, updated_at, tag
      FROM nodes
      WHERE rowid IN (${placeholders})
    `).all(...uniqueRowIds)

    const rowMap = new Map()
    for (const row of rows) {
      const entry = deserializeSqliteCacheEntry(row)
      if (entry) {
        rowMap.set(Number(row.rowid), entry)
      }
    }

    return rowIds
      .map(rowId => rowMap.get(Number(rowId)))
      .filter(Boolean)
  } catch {
    return []
  } finally {
    if (db) {
      db.close()
    }
  }
}

function countSqliteCacheEntries (cacheFilePath, filters = {}) {
  const sqlitePath = getSqliteCachePath(cacheFilePath)
  if (!fs.existsSync(sqlitePath)) {
    return 0
  }

  let db = null
  try {
    db = openSqliteCache(cacheFilePath)
    if (!db) {
      return 0
    }

    const { clauses, params } = buildSqliteFilterClauses(filters)
    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    const row = db.prepare(`SELECT COUNT(1) AS count FROM nodes ${whereClause}`).get(...params)
    const count = Number(row && row.count)
    return Number.isFinite(count) ? count : 0
  } catch {
    return 0
  } finally {
    if (db) {
      db.close()
    }
  }
}

function upsertSqliteEntryStatement (db) {
  return db.prepare(`
    INSERT INTO nodes (fingerprint, node_json, stable, delay, country, owner, source, updated_at, tag)
    VALUES (@fingerprint, @nodeJson, @stable, @delay, @country, @owner, @source, @updatedAt, @tag)
    ON CONFLICT(fingerprint) DO UPDATE SET
      node_json = excluded.node_json,
      stable = excluded.stable,
      delay = excluded.delay,
      country = excluded.country,
      owner = excluded.owner,
      source = excluded.source,
      updated_at = excluded.updated_at,
      tag = excluded.tag
  `)
}

function writeSqliteCacheEntries (cacheFilePath, entries) {
  let db = null
  try {
    db = openSqliteCache(cacheFilePath)
    if (!db) {
      return false
    }

    const upsert = upsertSqliteEntryStatement(db)
    const writeAll = db.transaction((items) => {
      db.prepare('DELETE FROM nodes').run()
      for (const item of items) {
        const serialized = serializeCacheEntryForSqlite(item)
        if (serialized) {
          upsert.run(serialized)
        }
      }
    })
    writeAll(entries && typeof entries[Symbol.iterator] === 'function' ? entries : [])
    maybeRunIncrementalVacuum(db)
    return true
  } catch {
    return false
  } finally {
    if (db) {
      db.close()
    }
  }
}

function writeCacheUpdates (cacheFilePath, updatedEntries, touchedNodes = null) {
  let db = null
  try {
    db = openSqliteCache(cacheFilePath)
    if (!db) {
      return false
    }

    const updatedByFingerprint = new Map()
    for (const entry of updatedEntries || []) {
      const serialized = serializeCacheEntryForSqlite(entry)
      if (serialized) {
        updatedByFingerprint.set(serialized.fingerprint, serialized)
      }
    }

    const normalizedTouchedNodes = Array.isArray(touchedNodes)
      ? touchedNodes
      : (updatedEntries || []).map(entry => entry && entry.node)
    const touchedFingerprints = []
    for (const node of normalizedTouchedNodes) {
      const fingerprint = fingerprintNode(node)
      if (fingerprint) {
        touchedFingerprints.push(fingerprint)
      }
    }

    const upsert = upsertSqliteEntryStatement(db)
    const remove = db.prepare('DELETE FROM nodes WHERE fingerprint = ?')
    const applyUpdates = db.transaction((fingerprints) => {
      for (const fingerprint of fingerprints) {
        const replacement = updatedByFingerprint.get(fingerprint)
        if (replacement) {
          upsert.run(replacement)
        } else {
          remove.run(fingerprint)
        }
      }
    })
    const uniqueTouchedFingerprints = [...new Set(touchedFingerprints)]
    applyUpdates(uniqueTouchedFingerprints)

    if (updatedByFingerprint.size < uniqueTouchedFingerprints.length) {
      maybeRunIncrementalVacuum(db)
    }

    return true
  } catch {
    return false
  } finally {
    if (db) {
      db.close()
    }
  }
}

function deduplicateNodes (nodes) {
  const unique = []
  const seen = new Set()
  for (const node of nodes || []) {
    if (!node || typeof node !== 'object') {
      continue
    }
    const cloned = clone(node)
    const fingerprint = fingerprintNode(cloned)
    if (!fingerprint || seen.has(fingerprint)) {
      continue
    }
    seen.add(fingerprint)
    unique.push(cloned)
  }
  return unique
}

function isProxyOutbound (outbound) {
  return outbound != null && ['vless', 'vmess', 'trojan', 'shadowsocks', 'http', 'socks'].includes(outbound.protocol)
}

function extractNodesFromXrayConfigFile (configFilePath) {
  const config = safeReadJson(configFilePath, null)
  if (!config || !Array.isArray(config.outbounds)) {
    return []
  }
  return config.outbounds
    .filter(isProxyOutbound)
    .map(node => clone(node))
}

function normalizeCacheEntry (entry) {
  if (!entry) {
    return null
  }

  const node = entry.node || entry.outbound || entry.config || entry.proxy || entry
  if (!node || typeof node !== 'object' || !node.protocol) {
    return null
  }

  const delay = normalizeDelayMs(entry.delay ?? entry.Delay ?? entry.average ?? entry.Average)
  const country = normalizeCountryCode(entry.country || entry.countryCode || '')
  const owner = resolveOwnerLabel(entry.owner)

  return {
    node: stripNodeMetadata(node),
    delay,
    country,
    owner,
    stable: entry.stable === true || entry.stable === 'true' || entry.Stable === true || entry.Stable === 'true' || entry.status === 'stable',
    source: entry.source || '',
    updatedAt: entry.updatedAt || entry.lastSeenAt || null,
    tag: entry.tag || node.tag || '',
  }
}

function getHealthPingStats (status) {
  if (!status || typeof status !== 'object') {
    return null
  }

  const healthPing = status.HealthPing || status.healthPing || status.health_ping || null
  if (!healthPing || typeof healthPing !== 'object') {
    return null
  }

  const all = Number(healthPing.All ?? healthPing.all ?? 0)
  const fail = Number(healthPing.Fail ?? healthPing.fail ?? 0)
  const average = Number(healthPing.Average ?? healthPing.average ?? status.Delay ?? status.delay ?? 0)
  const max = Number(healthPing.Max ?? healthPing.max ?? 0)
  const min = Number(healthPing.Min ?? healthPing.min ?? 0)

  return {
    all: Number.isFinite(all) ? all : 0,
    fail: Number.isFinite(fail) ? fail : 0,
    average: Number.isFinite(average) ? average : 0,
    max: Number.isFinite(max) ? max : 0,
    min: Number.isFinite(min) ? min : 0,
  }
}

function readCacheEntries (cacheFilePath, options = {}) {
  return readSqliteCacheEntries(cacheFilePath, options)
}

function countCacheEntries (cacheFilePath, filters = {}) {
  return countSqliteCacheEntries(cacheFilePath, filters)
}

function sortCacheEntries (entries) {
  return [...entries].sort((left, right) => {
    const leftStable = left.stable === true
    const rightStable = right.stable === true
    if (leftStable !== rightStable) {
      return leftStable ? -1 : 1
    }

    const leftDelay = Number.isFinite(left.delay) ? left.delay : Number.POSITIVE_INFINITY
    const rightDelay = Number.isFinite(right.delay) ? right.delay : Number.POSITIVE_INFINITY
    if (leftDelay !== rightDelay) {
      return leftDelay - rightDelay
    }

    const leftUpdatedAt = left.updatedAt ? new Date(left.updatedAt).getTime() : 0
    const rightUpdatedAt = right.updatedAt ? new Date(right.updatedAt).getTime() : 0
    return rightUpdatedAt - leftUpdatedAt
  })
}

function readCacheNodes (cacheFilePath, limit = 10) {
  return sortCacheEntries(readCacheEntries(cacheFilePath))
    .slice(0, limit)
    .map(entry => clone(entry.node))
}

function buildCacheEntriesFromObservatory (observatoryResults, nodeMap, source = 'probe') {
  const entries = []
  const timestamp = formatLocalTimestamp()

  for (const [tag, status] of Object.entries(observatoryResults || {})) {
    const node = nodeMap.get(tag)
    if (!node) {
      continue
    }

    const normalizedNode = stripNodeMetadata(node)

    const healthPing = getHealthPingStats(status)
    if (healthPing) {
      if (healthPing.all > 0 && healthPing.fail >= healthPing.all) {
        continue
      }

      const delaySource = Number.isFinite(healthPing.min) && healthPing.min > 0
        ? healthPing.min
        : healthPing.average
      const delay = normalizeDelayMs(delaySource)

      entries.push({
        node: normalizedNode,
        stable: healthPing.fail === 0,
        delay,
        source,
        updatedAt: timestamp,
        tag,
      })
      continue
    }

  }

  return sortCacheEntries(entries)
}

function mergeCacheEntries (existingEntries, updatedEntries, touchedNodes = null) {
  const normalizedExistingEntries = Array.isArray(existingEntries) ? existingEntries : []
  const normalizedUpdatedEntries = Array.isArray(updatedEntries) ? updatedEntries : []
  const updatedByFingerprint = new Map()
  const existingFingerprints = new Set()
  const touchedFingerprints = new Set()

  for (const entry of normalizedExistingEntries) {
    const fingerprint = fingerprintNode(entry && entry.node)
    if (fingerprint) {
      existingFingerprints.add(fingerprint)
    }
  }

  for (const entry of normalizedUpdatedEntries) {
    const fingerprint = fingerprintNode(entry && entry.node)
    if (!fingerprint) {
      continue
    }
    updatedByFingerprint.set(fingerprint, clone(entry))
  }

  const normalizedTouchedNodes = Array.isArray(touchedNodes) ? touchedNodes : normalizedUpdatedEntries.map(entry => entry && entry.node)
  for (const node of normalizedTouchedNodes) {
    const fingerprint = fingerprintNode(node)
    if (fingerprint) {
      touchedFingerprints.add(fingerprint)
    }
  }

  const merged = []

  for (const entry of normalizedExistingEntries) {
    const fingerprint = fingerprintNode(entry && entry.node)
    if (touchedFingerprints.has(fingerprint)) {
      const replacement = updatedByFingerprint.get(fingerprint)
      if (replacement) {
        merged.push(replacement)
      }
      continue
    }

    merged.push(entry)
  }

  for (const entry of normalizedUpdatedEntries) {
    const fingerprint = fingerprintNode(entry && entry.node)
    if (!fingerprint) {
      continue
    }

    if (!existingFingerprints.has(fingerprint)) {
      merged.push(clone(entry))
    }
  }

  return sortCacheEntries(merged)
}

function writeCache (cacheFilePath, entries) {
  if (writeSqliteCacheEntries(cacheFilePath, entries)) {
    return
  }

  throw new Error('Xray SQLite cache is unavailable')
}

module.exports = {
  deduplicateNodes,
  extractNodesFromXrayConfigFile,
  fingerprintNode,
  countCacheEntries,
  readCacheEntries,
  readCacheRowIds: readSqliteCacheRowIds,
  readCacheEntriesByRowIds: readSqliteCacheEntriesByRowIds,
  readCacheNodes,
  buildCacheEntriesFromObservatory,
  mergeCacheEntries,
  writeCacheUpdates,
  writeCache,
  sortCacheEntries,
  resolveOwnerLabel,
}
