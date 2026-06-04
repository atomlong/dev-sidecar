const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const parser = require('./parser')

let betterSqlite3 = null
let betterSqlite3LoadAttempted = false
let betterSqlite3LoadError = null

const SQLITE_AUTO_VACUUM_NONE = 0
const SQLITE_AUTO_VACUUM_INCREMENTAL = 2
const SQLITE_INCREMENTAL_VACUUM_MIN_FREE_PAGES = 4096
const SQLITE_INCREMENTAL_VACUUM_FREE_RATIO = 0.05
const SQLITE_INCREMENTAL_VACUUM_AGGRESSIVE_FREE_RATIO = 0.5
const SQLITE_INCREMENTAL_VACUUM_STEP_PAGES = 2048
const SQLITE_INCREMENTAL_VACUUM_MIN_INTERVAL_MS = 10 * 60 * 1000
const SQLITE_WAL_AUTO_CHECKPOINT_PAGES = 4096
const SQLITE_WAL_JOURNAL_SIZE_LIMIT_BYTES = 32 * 1024 * 1024
const CACHE_META_LEGACY_NODES_RETIRED = 'legacy_nodes_retired'
const CACHE_META_POST_RETIRE_COMPACTED = 'post_retire_compacted'

let lastIncrementalVacuumAt = 0
const reportedSqliteCacheErrors = new Set()

function loadBetterSqlite3 () {
  if (betterSqlite3LoadAttempted) {
    return betterSqlite3
  }

  betterSqlite3LoadAttempted = true
  try {
    betterSqlite3 = require('better-sqlite3')
    betterSqlite3LoadError = null
  } catch (error) {
    betterSqlite3 = null
    betterSqlite3LoadError = error
  }
  return betterSqlite3
}

function getSqliteCacheErrorMessage (error) {
  if (!error) {
    return 'unknown error'
  }

  if (error.stack) {
    const firstLine = String(error.stack).split('\n')[0].trim()
    if (firstLine) {
      return firstLine
    }
  }

  if (error.message) {
    return String(error.message)
  }

  return String(error)
}

function reportSqliteCacheError (stage, cacheFilePath, error) {
  const sqlitePath = getSqliteCachePath(cacheFilePath || '')
  const message = getSqliteCacheErrorMessage(error)
  const key = `${stage}|${sqlitePath}|${message}`
  if (reportedSqliteCacheErrors.has(key)) {
    return
  }

  reportedSqliteCacheErrors.add(key)
  console.warn(`Xray SQLite cache ${stage} failed: ${sqlitePath} - ${message}`)
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

function getStage2SeenDbPath (cacheFilePath) {
  const sqlitePath = getSqliteCachePath(cacheFilePath)
  return sqlitePath ? `${sqlitePath}.stage2-seen.sqlite` : ''
}

function buildNodesTableSchemaSql () {
  return `
    CREATE TABLE IF NOT EXISTS nodes (
      fingerprint TEXT PRIMARY KEY,
      node_key TEXT UNIQUE,
      node_json TEXT NOT NULL,
      stable INTEGER NOT NULL DEFAULT 0,
      delay REAL,
      country TEXT,
      owner TEXT,
      source TEXT,
      updated_at TEXT,
      next_check_at TEXT,
      failure_streak INTEGER NOT NULL DEFAULT 0,
      tag TEXT
    );
  `
}

function buildNodeRuntimeTableSchemaSql () {
  return `
    CREATE TABLE IF NOT EXISTS node_runtime (
      fingerprint TEXT PRIMARY KEY,
      node_key TEXT UNIQUE,
      stable INTEGER NOT NULL DEFAULT 0,
      delay REAL,
      country TEXT,
      owner TEXT,
      source TEXT,
      updated_at TEXT,
      next_check_at TEXT,
      failure_streak INTEGER NOT NULL DEFAULT 0,
      tag TEXT
    );
  `
}

function buildNodePayloadTableSchemaSql () {
  return `
    CREATE TABLE IF NOT EXISTS node_payload (
      node_key TEXT PRIMARY KEY,
      node_json TEXT NOT NULL
    );
  `
}

function buildOutdatedTableSchemaSql () {
  return `
    CREATE TABLE IF NOT EXISTS outdated (
      hash TEXT PRIMARY KEY,
      outdated_at INTEGER NOT NULL
    );
  `
}

function createNodeKey (fingerprint) {
  const value = String(fingerprint || '')
  if (!value) {
    return ''
  }
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 32)
}

function createCompactFingerprint (canonicalFingerprint) {
  const value = String(canonicalFingerprint || '')
  if (!value) {
    return ''
  }

  // Keep SQLite's primary key/index small. The canonical node JSON is still
  // available via fingerprintNode() for in-process identity checks; the DB only
  // needs a stable, collision-resistant identity. Storing the full JSON as both
  // PRIMARY KEY and node_json made million-node HTTP/SOCKS sources inflate the
  // cache into multi-GB files and pushed cgroup file cache above Raspberry Pi
  // budgets.
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`
}

function getSqliteFingerprintCandidates (canonicalFingerprint) {
  const value = String(canonicalFingerprint || '')
  if (!value) {
    return []
  }
  const compactFingerprint = createCompactFingerprint(value)
  return compactFingerprint && compactFingerprint !== value ? [compactFingerprint, value] : [value]
}

function getNodeKey (node) {
  const fingerprint = fingerprintNode(node)
  return fingerprint ? createNodeKey(fingerprint) : ''
}

function hasTable (db, tableName) {
  if (!db || !tableName) {
    return false
  }

  try {
    const row = db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1").get(String(tableName))
    return Boolean(row && row.ok === 1)
  } catch {
    return false
  }
}

function ensureSqliteColumn (db, tableName, columnName, definition) {
  if (!hasTable(db, tableName)) {
    return false
  }
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all()
  if (columns.some(column => column && column.name === columnName)) {
    return false
  }
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`)
  return true
}

function backfillNodeKeys (db) {
  const rows = db.prepare('SELECT fingerprint FROM nodes WHERE node_key IS NULL OR node_key = \'\'').all()
  if (rows.length === 0) {
    return
  }

  const update = db.prepare('UPDATE nodes SET node_key = ? WHERE fingerprint = ?')
  const apply = db.transaction((items) => {
    for (const row of items) {
      const fingerprint = row && row.fingerprint
      const nodeKey = createNodeKey(fingerprint)
      if (fingerprint && nodeKey) {
        update.run(nodeKey, fingerprint)
      }
    }
  })
  apply(rows)
}

function backfillNextCheckAt (db) {
  const rows = db.prepare(`
    SELECT fingerprint, updated_at
    FROM nodes
    WHERE next_check_at IS NULL OR next_check_at = ''
  `).all()
  if (rows.length === 0) {
    return 0
  }

  const fallbackTimestamp = formatLocalTimestamp(new Date())
  const update = db.prepare('UPDATE nodes SET next_check_at = ? WHERE fingerprint = ?')
  const apply = db.transaction((items) => {
    for (const row of items) {
      const nextCheckAt = formatLocalTimestamp(row && row.updated_at) || fallbackTimestamp
      const fingerprint = row && row.fingerprint
      if (fingerprint) {
        update.run(nextCheckAt, fingerprint)
      }
    }
  })
  apply(rows)
  return rows.length
}

function createSubscriptionSchema (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      source_key TEXT PRIMARY KEY,
      display_label TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      configured INTEGER NOT NULL DEFAULT 1,
      last_seen_stage2_at TEXT,
      last_available_at TEXT,
      zero_available_since TEXT,
      stale_after_days INTEGER NOT NULL DEFAULT 30,
      created_at TEXT,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS subscription_node_refs (
      subscription_source_key TEXT NOT NULL,
      node_key TEXT NOT NULL,
      last_seen_stage2_at TEXT,
      created_at TEXT,
      updated_at TEXT,
      PRIMARY KEY (subscription_source_key, node_key)
    );

    CREATE INDEX IF NOT EXISTS idx_subscription_node_refs_node_key ON subscription_node_refs(node_key);
    CREATE INDEX IF NOT EXISTS idx_subscriptions_configured_sort ON subscriptions(configured DESC, sort_order ASC);
  `)
}

function createStage2ScratchSchema (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS stage2_seen_node_keys (
      node_key TEXT PRIMARY KEY
    );
  `)
}

function openStage2SeenDb (cacheFilePath, options = {}) {
  const Database = loadBetterSqlite3()
  if (!Database) {
    reportSqliteCacheError('open-stage2-seen', cacheFilePath, betterSqlite3LoadError || new Error('better-sqlite3 is unavailable'))
    return null
  }

  const stage2SeenPath = getStage2SeenDbPath(cacheFilePath)
  if (!stage2SeenPath) {
    return null
  }

  let db = null
  try {
    ensureDir(path.dirname(stage2SeenPath))
    if (options.reset && fs.existsSync(stage2SeenPath)) {
      fs.unlinkSync(stage2SeenPath)
    }
    db = new Database(stage2SeenPath)
    // Keep the transient stage2 dedup database out of process anonymous memory.
    // The large-subscription path can insert hundreds of thousands of node keys;
    // MEMORY journal/temp pages briefly inflate Electron's RSS and the systemd
    // cgroup peak even though JS heap stays low.
    db.pragma('journal_mode = DELETE')
    db.pragma('synchronous = OFF')
    db.pragma('temp_store = FILE')
    db.pragma('mmap_size = 0')
    db.pragma('cache_size = -512')
    createStage2ScratchSchema(db)
    return db
  } catch (error) {
    if (db) {
      try {
        db.close()
      } catch {
        // ignore close errors after stage2 scratch open failure
      }
    }
    reportSqliteCacheError('open-stage2-seen', cacheFilePath, error)
    return null
  }
}

function cleanupStage2SeenDb (cacheFilePath) {
  const stage2SeenPath = getStage2SeenDbPath(cacheFilePath)
  if (!stage2SeenPath) {
    return
  }

  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    try {
      const filePath = `${stage2SeenPath}${suffix}`
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath)
      }
    } catch {
      // ignore cleanup errors for transient stage2 scratch database
    }
  }
}

function createOutdatedSchema (db) {
  db.exec(buildOutdatedTableSchemaSql())
}

function createCacheMetaSchema (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cache_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `)
}

function getCacheMetaValue (db, key) {
  if (!db || !key || !hasTable(db, 'cache_meta')) {
    return null
  }

  try {
    const row = db.prepare('SELECT value FROM cache_meta WHERE key = ? LIMIT 1').get(String(key))
    return row ? String(row.value) : null
  } catch {
    return null
  }
}

function setCacheMetaValue (db, key, value) {
  if (!db || !key) {
    return false
  }

  createCacheMetaSchema(db)
  db.prepare(`
    INSERT INTO cache_meta (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(String(key), String(value))
  return true
}

function isLegacyNodesRetired (db) {
  return getCacheMetaValue(db, CACHE_META_LEGACY_NODES_RETIRED) === '1'
}

function markLegacyNodesRetired (db) {
  return setCacheMetaValue(db, CACHE_META_LEGACY_NODES_RETIRED, '1')
}

function isPostRetireCompacted (db) {
  return getCacheMetaValue(db, CACHE_META_POST_RETIRE_COMPACTED) === '1'
}

function markPostRetireCompacted (db) {
  return setCacheMetaValue(db, CACHE_META_POST_RETIRE_COMPACTED, '1')
}

function createLegacyNodesSchema (db) {
  db.exec(buildNodesTableSchemaSql())
  const addedNodeKeyColumn = ensureSqliteColumn(db, 'nodes', 'node_key', 'TEXT')
  const addedNextCheckAtColumn = ensureSqliteColumn(db, 'nodes', 'next_check_at', 'TEXT')
  ensureSqliteColumn(db, 'nodes', 'failure_streak', 'INTEGER NOT NULL DEFAULT 0')
  if (addedNodeKeyColumn) {
    backfillNodeKeys(db)
  }
  if (addedNextCheckAtColumn) {
    backfillNextCheckAt(db)
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_nodes_node_key ON nodes(node_key);
    CREATE INDEX IF NOT EXISTS idx_nodes_sort ON nodes(stable DESC, delay ASC, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_nodes_country_sort ON nodes(country, stable DESC, delay ASC, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_nodes_refresh ON nodes(updated_at ASC, delay ASC);
    CREATE INDEX IF NOT EXISTS idx_nodes_next_check ON nodes(next_check_at ASC, stable DESC, delay ASC, updated_at ASC);
  `)
}

function createHotColdSchema (db) {
  db.exec(buildNodeRuntimeTableSchemaSql())
  db.exec(buildNodePayloadTableSchemaSql())
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_node_runtime_node_key ON node_runtime(node_key);
    CREATE INDEX IF NOT EXISTS idx_node_runtime_sort ON node_runtime(stable DESC, delay ASC, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_node_runtime_country_sort ON node_runtime(country, stable DESC, delay ASC, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_node_runtime_refresh ON node_runtime(updated_at ASC, delay ASC);
    CREATE INDEX IF NOT EXISTS idx_node_runtime_next_check ON node_runtime(next_check_at ASC, stable DESC, delay ASC, updated_at ASC);
  `)
}

function migrateNodesToHotColdSchema (db, options = {}) {
  if (!db) {
    return 0
  }

  if (!hasTable(db, 'nodes')) {
    return 0
  }

  const batchLimit = Math.max(1, Number(options.limit) || 5000)

  const rows = db.prepare(`
    SELECT fingerprint, node_key, node_json, stable, delay, country, owner, source, updated_at, next_check_at, failure_streak, tag
    FROM nodes
    WHERE node_key IS NOT NULL AND node_key != ''
      AND NOT EXISTS (SELECT 1 FROM node_runtime runtime WHERE runtime.fingerprint = nodes.fingerprint)
    LIMIT ?
  `).all(batchLimit)

  if (rows.length === 0) {
    return 0
  }

  const upsertRuntime = db.prepare(`
    INSERT INTO node_runtime (fingerprint, node_key, stable, delay, country, owner, source, updated_at, next_check_at, failure_streak, tag)
    VALUES (@fingerprint, @node_key, @stable, @delay, @country, @owner, @source, @updated_at, @next_check_at, @failure_streak, @tag)
    ON CONFLICT(fingerprint) DO UPDATE SET
      node_key = excluded.node_key,
      stable = excluded.stable,
      delay = excluded.delay,
      country = excluded.country,
      owner = excluded.owner,
      source = excluded.source,
      updated_at = excluded.updated_at,
      next_check_at = excluded.next_check_at,
      failure_streak = excluded.failure_streak,
      tag = excluded.tag
  `)
  const upsertPayload = db.prepare(`
    INSERT INTO node_payload (node_key, node_json)
    VALUES (@node_key, @node_json)
    ON CONFLICT(node_key) DO UPDATE SET
      node_json = excluded.node_json
  `)

  const apply = db.transaction((items) => {
    for (const row of items) {
      upsertRuntime.run(row)
      upsertPayload.run(row)
    }
  })
  apply(rows)
  return rows.length
}

function hasPendingHotColdMigration (db) {
  if (!db) {
    return false
  }

  if (!hasTable(db, 'nodes')) {
    return false
  }

  try {
    const row = db.prepare(`
      SELECT 1 AS pending
      FROM nodes legacy
      WHERE legacy.node_key IS NOT NULL AND legacy.node_key != ''
        AND NOT EXISTS (SELECT 1 FROM node_runtime runtime WHERE runtime.fingerprint = legacy.fingerprint)
      LIMIT 1
    `).get()
    return Boolean(row && row.pending === 1)
  } catch {
    return true
  }
}

function migrateHotColdSchema (cacheFilePath, options = {}) {
  let db = null
  try {
    db = openSqliteCache(cacheFilePath, { lowFileCache: options.lowFileCache === true })
    if (!db) {
      return {
        migratedRows: 0,
        pending: true,
      }
    }

    const batchLimit = Math.max(1, Number(options.batchLimit) || 5000)
    const maxRows = Math.max(batchLimit, Number(options.maxRows) || batchLimit)
    let migratedRows = 0

    while (migratedRows < maxRows) {
      const remaining = maxRows - migratedRows
      const migrated = migrateNodesToHotColdSchema(db, {
        limit: Math.min(batchLimit, remaining),
      })
      if (migrated <= 0) {
        break
      }
      migratedRows += migrated
    }

    return {
      migratedRows,
      pending: hasPendingHotColdMigration(db),
    }
  } catch {
    return {
      migratedRows: 0,
      pending: true,
    }
  } finally {
    if (db) {
      db.close()
    }
  }
}

function hasHotColdData (db) {
  if (!db) {
    return false
  }

  if (isLegacyNodesRetired(db) || !hasTable(db, 'nodes')) {
    return hasTable(db, 'node_runtime') && hasTable(db, 'node_payload')
  }

  if (hasTable(db, 'node_runtime') && hasTable(db, 'node_payload') && !hasPendingHotColdMigration(db)) {
    return true
  }

  try {
    const row = db.prepare('SELECT 1 AS ok FROM node_runtime LIMIT 1').get()
    return Boolean(row && row.ok === 1) && !hasPendingHotColdMigration(db)
  } catch {
    return false
  }
}

function shouldMaintainLegacyNodes (db) {
  if (!db) {
    return false
  }

  if (isLegacyNodesRetired(db)) {
    return false
  }

  return !hasHotColdData(db)
}

function createSqliteSchema (db) {
  createCacheMetaSchema(db)
  if (!isLegacyNodesRetired(db)) {
    createLegacyNodesSchema(db)
  }
  createHotColdSchema(db)
  createSubscriptionSchema(db)
  createOutdatedSchema(db)
}

function migrateLegacyFullJsonFingerprints (db, options = {}) {
  if (!db || options.lowFileCache !== true || !hasTable(db, 'nodes')) {
    return 0
  }

  const batchSize = 2000
  const rows = db.prepare(`
    SELECT rowid, fingerprint, node_json
    FROM nodes
    WHERE fingerprint NOT LIKE 'sha256:%'
    LIMIT ?
  `).all(batchSize)

  if (rows.length === 0) {
    return 0
  }

  const update = db.prepare('UPDATE nodes SET fingerprint = ?, node_key = ? WHERE rowid = ?')
  const remove = db.prepare('DELETE FROM nodes WHERE rowid = ?')
  const exists = db.prepare('SELECT 1 FROM nodes WHERE fingerprint = ? LIMIT 1')
  const migrateBatch = db.transaction((items) => {
    for (const row of items) {
      const legacyFingerprint = String(row && row.fingerprint || '')
      if (!legacyFingerprint) {
        continue
      }

      let canonicalFingerprint = legacyFingerprint
      if (!legacyFingerprint.startsWith('{') && row && row.node_json) {
        try {
          canonicalFingerprint = fingerprintNode(expandCompactCacheNodeFromStorage(JSON.parse(row.node_json))) || legacyFingerprint
        } catch {
          canonicalFingerprint = legacyFingerprint
        }
      }

      const compactFingerprint = createCompactFingerprint(canonicalFingerprint)
      if (!compactFingerprint || compactFingerprint === legacyFingerprint) {
        continue
      }

      if (exists.get(compactFingerprint)) {
        remove.run(row.rowid)
      } else {
        update.run(compactFingerprint, createNodeKey(canonicalFingerprint), row.rowid)
      }
    }
  })
  migrateBatch(rows)

  return rows.length
}

function openSqliteCache (cacheFilePath, options = {}) {
  const Database = loadBetterSqlite3()
  if (!Database) {
    reportSqliteCacheError('open', cacheFilePath, betterSqlite3LoadError || new Error('better-sqlite3 is unavailable'))
    return null
  }

  const sqlitePath = getSqliteCachePath(cacheFilePath)
  let db = null

  try {
    ensureDir(path.dirname(sqlitePath))
    const isNewDatabase = !fs.existsSync(sqlitePath) || fs.statSync(sqlitePath).size === 0
    db = new Database(sqlitePath)
    if (isNewDatabase) {
      db.pragma('auto_vacuum = INCREMENTAL')
    }
    if (options.lowFileCache === true) {
      // Stage2 writes many small chunks. Avoid MEMORY journal/temp storage here:
      // those buffers are charged as anonymous RSS to the Electron main process
      // and were observed to push the service cgroup above 500MiB around large
      // subscriptions. DELETE+FILE trades a little I/O for a much lower peak.
      db.pragma('journal_mode = DELETE')
      db.pragma('synchronous = OFF')
      db.pragma('temp_store = FILE')
      db.pragma('mmap_size = 0')
      db.pragma('cache_size = -512')
      db.pragma('journal_size_limit = 1048576')
    } else {
      db.pragma('journal_mode = WAL')
      db.pragma('synchronous = NORMAL')
      db.pragma(`wal_autocheckpoint = ${SQLITE_WAL_AUTO_CHECKPOINT_PAGES}`)
      db.pragma(`journal_size_limit = ${SQLITE_WAL_JOURNAL_SIZE_LIMIT_BYTES}`)
    }
    createSqliteSchema(db)
    migrateLegacyFullJsonFingerprints(db, { lowFileCache: options.lowFileCache === true })
    migrateNodesToHotColdSchema(db)
    return db
  } catch (error) {
    if (db) {
      try {
        db.close()
      } catch {
        // ignore close errors after open failure
      }
    }
    reportSqliteCacheError('open', cacheFilePath, error)
    return null
  }
}

function readSqliteCacheEntriesFromHotCold (db, options = {}) {
  const { clauses, params } = buildSqliteFilterClauses(options)
  const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
  const limit = normalizeSqliteQueryLimit(options.limit)
  const offset = normalizeSqliteQueryOffset(options.offset)
  let sql = `
    SELECT r.node_key, p.node_json, r.stable, r.delay, r.country, r.owner, r.source, r.updated_at, r.next_check_at, r.failure_streak, r.tag
    FROM node_runtime r
    LEFT JOIN node_payload p ON p.node_key = r.node_key
    ${whereClause}
    ORDER BY ${getSqliteOrderByClause(options.orderBy).replace(/\bupdated_at\b/g, 'r.updated_at').replace(/\bnext_check_at\b/g, 'r.next_check_at').replace(/\bstable\b/g, 'r.stable').replace(/\bdelay\b/g, 'r.delay').replace(/\bcountry\b/g, 'r.country').replace(/\browid\b/g, 'r.rowid')}
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

  return db.prepare(sql).all(...queryParams)
}

function readSqliteCacheRowIdsFromHotCold (db, options = {}) {
  const { clauses, params } = buildSqliteFilterClauses(options)
  const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
  const limit = normalizeSqliteQueryLimit(options.limit)
  const offset = normalizeSqliteQueryOffset(options.offset)
  let sql = `
    SELECT r.rowid AS rowid
    FROM node_runtime r
    ${whereClause}
    ORDER BY ${getSqliteOrderByClause(options.orderBy).replace(/\bupdated_at\b/g, 'r.updated_at').replace(/\bnext_check_at\b/g, 'r.next_check_at').replace(/\bstable\b/g, 'r.stable').replace(/\bdelay\b/g, 'r.delay').replace(/\bcountry\b/g, 'r.country').replace(/\browid\b/g, 'r.rowid')}
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

  return db.prepare(sql).all(...queryParams)
}

function countSqliteCacheEntriesFromHotCold (db, filters = {}) {
  const { clauses, params } = buildSqliteFilterClauses(filters)
  const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
  const row = db.prepare(`SELECT COUNT(1) AS count FROM node_runtime ${whereClause}`).get(...params)
  const count = Number(row && row.count)
  return Number.isFinite(count) ? count : 0
}

function readSqliteCacheEntriesByRowIdsFromHotCold (db, rowIds) {
  if (!Array.isArray(rowIds) || rowIds.length === 0) {
    return []
  }

  const uniqueRowIds = [...new Set(rowIds
    .map(rowId => Number(rowId))
    .filter(rowId => Number.isInteger(rowId) && rowId > 0))]
  if (uniqueRowIds.length === 0) {
    return []
  }

  const placeholders = uniqueRowIds.map(() => '?').join(', ')
  return db.prepare(`
    SELECT r.rowid, r.node_key, p.node_json, r.stable, r.delay, r.country, r.owner, r.source, r.updated_at, r.next_check_at, r.failure_streak, r.tag
    FROM node_runtime r
    LEFT JOIN node_payload p ON p.node_key = r.node_key
    WHERE r.rowid IN (${placeholders})
  `).all(...uniqueRowIds)
}

function readSqliteCacheRuntimeRowsByRowIdsFromHotCold (db, rowIds) {
  if (!Array.isArray(rowIds) || rowIds.length === 0) {
    return []
  }

  const uniqueRowIds = [...new Set(rowIds
    .map(rowId => Number(rowId))
    .filter(rowId => Number.isInteger(rowId) && rowId > 0))]
  if (uniqueRowIds.length === 0) {
    return []
  }

  const placeholders = uniqueRowIds.map(() => '?').join(', ')
  return db.prepare(`
    SELECT r.rowid, r.fingerprint, r.node_key, r.stable, r.delay, r.country, r.owner, r.source, r.updated_at, r.next_check_at, r.failure_streak, r.tag
    FROM node_runtime r
    WHERE r.rowid IN (${placeholders})
  `).all(...uniqueRowIds)
}

function readSqliteNodePayloadRowsByNodeKeysFromHotCold (db, nodeKeys) {
  if (!Array.isArray(nodeKeys) || nodeKeys.length === 0) {
    return []
  }

  const uniqueNodeKeys = [...new Set(nodeKeys.map(value => String(value || '').trim()).filter(Boolean))]
  if (uniqueNodeKeys.length === 0) {
    return []
  }

  const placeholders = uniqueNodeKeys.map(() => '?').join(', ')
  return db.prepare(`
    SELECT node_key, node_json
    FROM node_payload
    WHERE node_key IN (${placeholders})
  `).all(...uniqueNodeKeys)
}

function hydrateHotColdRuntimeRowsWithPayload (db, runtimeRows, requestedRowIds = null) {
  if (!Array.isArray(runtimeRows) || runtimeRows.length === 0) {
    return []
  }

  const payloadRows = readSqliteNodePayloadRowsByNodeKeysFromHotCold(db, runtimeRows.map(row => row && row.node_key))
  const payloadByNodeKey = new Map(payloadRows.map(row => [String(row && row.node_key || ''), row && row.node_json]))
  const entryByRowId = new Map()

  for (const row of runtimeRows) {
    if (!row) {
      continue
    }

    const hydratedRow = {
      ...row,
      node_json: payloadByNodeKey.get(String(row.node_key || '')) || null,
    }
    const entry = deserializeSqliteCacheEntry(hydratedRow)
    const rowId = Number(row.rowid)
    if (entry && Number.isInteger(rowId) && rowId > 0) {
      entryByRowId.set(rowId, entry)
    }
  }

  const orderedRowIds = Array.isArray(requestedRowIds) ? requestedRowIds : runtimeRows.map(row => row && row.rowid)
  return orderedRowIds
    .map(rowId => entryByRowId.get(Number(rowId)))
    .filter(Boolean)
}

function readSqliteCacheEntriesForRefreshByRowIds (cacheFilePath, rowIds) {
  if (!Array.isArray(rowIds) || rowIds.length === 0) {
    return []
  }

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

    if (hasHotColdData(db)) {
      const runtimeRows = readSqliteCacheRuntimeRowsByRowIdsFromHotCold(db, rowIds)
      return hydrateHotColdRuntimeRowsWithPayload(db, runtimeRows, rowIds)
    }

    return readSqliteCacheEntriesByRowIds(cacheFilePath, rowIds)
  } catch {
    return []
  } finally {
    if (db) {
      db.close()
    }
  }
}

function readSqliteCacheEntriesForStartup (cacheFilePath, options = {}) {
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

    if (hasHotColdData(db)) {
      const rowIds = readSqliteCacheRowIdsFromHotCold(db, options)
        .map(row => Number(row && row.rowid))
        .filter(rowId => Number.isInteger(rowId) && rowId > 0)
      if (rowIds.length === 0) {
        return []
      }

      const runtimeRows = readSqliteCacheRuntimeRowsByRowIdsFromHotCold(db, rowIds)
      return hydrateHotColdRuntimeRowsWithPayload(db, runtimeRows, rowIds)
    }

    const { clauses, params } = buildSqliteFilterClauses(options)
    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    const limit = normalizeSqliteQueryLimit(options.limit)
    const offset = normalizeSqliteQueryOffset(options.offset)
    let sql = `
      SELECT node_json, stable, delay, country, owner, source, updated_at, next_check_at, failure_streak, tag
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

function readSqliteCacheEntriesByFingerprintsFromHotCold (db, fingerprints) {
  const uniqueFingerprints = [...new Set((fingerprints || []).map(value => String(value || '').trim()).filter(Boolean))]
  if (uniqueFingerprints.length === 0) {
    return []
  }

  const lookupFingerprints = []
  const lookupToCanonical = new Map()
  for (const fingerprint of uniqueFingerprints) {
    for (const candidate of getSqliteFingerprintCandidates(fingerprint)) {
      lookupFingerprints.push(candidate)
      lookupToCanonical.set(candidate, fingerprint)
    }
  }

  const rowMap = new Map()
  const chunkSize = 500
  for (let index = 0; index < lookupFingerprints.length; index += chunkSize) {
    const chunk = lookupFingerprints.slice(index, index + chunkSize)
    const placeholders = chunk.map(() => '?').join(', ')
    const rows = db.prepare(`
      SELECT r.fingerprint, r.node_key, p.node_json, r.stable, r.delay, r.country, r.owner, r.source, r.updated_at, r.next_check_at, r.failure_streak, r.tag
      FROM node_runtime r
      LEFT JOIN node_payload p ON p.node_key = r.node_key
      WHERE r.fingerprint IN (${placeholders})
    `).all(...chunk)
    for (const row of rows) {
      const entry = deserializeSqliteCacheEntry(row)
      if (entry && row && row.fingerprint) {
        const storedFingerprint = String(row.fingerprint)
        const canonicalFingerprint = lookupToCanonical.get(storedFingerprint) || fingerprintNode(entry.node)
        if (canonicalFingerprint) {
          rowMap.set(canonicalFingerprint, entry)
        }
      }
    }
  }

  return uniqueFingerprints.map(fingerprint => rowMap.get(fingerprint)).filter(Boolean)
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

function compactRetiredSqliteCache (cacheFilePath, options = {}) {
  let db = null
  try {
    db = openSqliteCache(cacheFilePath, { lowFileCache: options.lowFileCache === true })
    if (!db) {
      return {
        compacted: false,
        pending: true,
      }
    }

    if (!isLegacyNodesRetired(db)) {
      return {
        compacted: false,
        pending: true,
      }
    }

    if (isPostRetireCompacted(db)) {
      return {
        compacted: true,
        alreadyCompacted: true,
        pending: false,
      }
    }

    const freelistCount = Number(db.pragma('freelist_count', { simple: true }) || 0)
    const pageCount = Number(db.pragma('page_count', { simple: true }) || 0)
    const autoVacuum = Number(db.pragma('auto_vacuum', { simple: true }) || SQLITE_AUTO_VACUUM_NONE)
    const freeRatio = pageCount > 0 ? (freelistCount / pageCount) : 0
    const shouldCompact = autoVacuum !== SQLITE_AUTO_VACUUM_INCREMENTAL || freelistCount >= SQLITE_INCREMENTAL_VACUUM_MIN_FREE_PAGES || freeRatio >= SQLITE_INCREMENTAL_VACUUM_FREE_RATIO

    if (!shouldCompact) {
      markPostRetireCompacted(db)
      return {
        compacted: true,
        alreadyCompacted: false,
        pending: false,
        skippedVacuum: true,
      }
    }

    if (options.lowFileCache === true) {
      db.pragma('journal_mode = DELETE')
      db.pragma('synchronous = OFF')
      db.pragma('temp_store = FILE')
      db.pragma('mmap_size = 0')
      db.pragma('cache_size = -512')
      db.pragma('journal_size_limit = 1048576')
    }

    db.pragma('wal_checkpoint(TRUNCATE)')
    db.exec('PRAGMA auto_vacuum = INCREMENTAL; VACUUM;')
    markPostRetireCompacted(db)

    return {
      compacted: true,
      alreadyCompacted: false,
      pending: false,
    }
  } catch {
    return {
      compacted: false,
      pending: true,
    }
  } finally {
    if (db) {
      db.close()
    }
  }
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

function normalizeFailureStreak (value) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    return 0
  }

  const normalized = Math.floor(parsed)
  return normalized >= 0 ? normalized : 0
}

function fingerprintNode (node) {
  if (!node || typeof node !== 'object') {
    return ''
  }

  const cloned = stripNodeMetadata(node)
  return JSON.stringify(cloned)
}

function compactCacheNodeForStorage (node) {
  if (!node || typeof node !== 'object') {
    return node
  }

  if (node.protocol !== 'http' && node.protocol !== 'socks') {
    return node
  }

  const server = node.settings && Array.isArray(node.settings.servers) ? node.settings.servers[0] : null
  if (!server || !server.address || !server.port) {
    return node
  }

  const compact = {
    $compact: 'xray-node-v1',
    p: node.protocol,
    a: server.address,
    r: server.port,
  }

  if (Array.isArray(server.users) && server.users[0]) {
    const user = server.users[0]
    compact.u = user.user || ''
    compact.w = user.pass || ''
  }

  if (node.protocol === 'http' && node.streamSettings && node.streamSettings.security === 'tls') {
    compact.t = 1
    const serverName = node.streamSettings.tlsSettings && node.streamSettings.tlsSettings.serverName
    if (serverName && serverName !== server.address) {
      compact.s = serverName
    }
  }

  return compact
}

function expandCompactCacheNodeFromStorage (node) {
  if (!node || typeof node !== 'object' || node.$compact !== 'xray-node-v1') {
    return node
  }

  const protocol = node.p === 'socks' ? 'socks' : 'http'
  const server = {
    address: node.a,
    port: node.r,
  }

  if (node.u != null || node.w != null) {
    server.users = [{
      user: node.u || '',
      pass: node.w || '',
    }]
  }

  const expanded = {
    tag: `${protocol === 'http' && node.t === 1 ? 'https' : protocol}-${server.address}:${server.port}`,
    protocol,
    settings: {
      servers: [server],
    },
  }

  if (protocol === 'http' && node.t === 1) {
    expanded.streamSettings = {
      security: 'tls',
      tlsSettings: {
        serverName: node.s || server.address,
      },
    }
  }

  return expanded
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
    nextCheckAt: formatLocalTimestamp(entry.nextCheckAt) || null,
    failureStreak: normalizeFailureStreak(entry.failureStreak),
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

  const canonicalFingerprint = fingerprintNode(normalizedEntry.node)
  if (!canonicalFingerprint) {
    return null
  }

  return {
    fingerprint: createCompactFingerprint(canonicalFingerprint),
    legacyFingerprint: canonicalFingerprint,
    nodeKey: createNodeKey(canonicalFingerprint),
    nodeJson: JSON.stringify(compactCacheNodeForStorage(normalizedEntry.node)),
    stable: normalizedEntry.stable === true || normalizedEntry.stable === 'true' ? 1 : 0,
    delay: Number.isFinite(normalizedEntry.delay) ? normalizedEntry.delay : null,
    country: normalizeCountryCode(normalizedEntry.country || normalizedEntry.countryCode),
    owner: resolveOwnerLabel(normalizedEntry.owner),
    source: normalizedEntry.source || '',
    updatedAt: normalizedEntry.updatedAt || null,
    nextCheckAt: normalizedEntry.nextCheckAt || null,
    failureStreak: normalizeFailureStreak(normalizedEntry.failureStreak),
    tag: normalizedEntry.tag || '',
  }
}

function deserializeSqliteCacheEntry (row) {
  if (!row || !row.node_json) {
    return null
  }

  let node
  try {
    node = expandCompactCacheNodeFromStorage(JSON.parse(row.node_json))
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
    nextCheckAt: row.next_check_at || null,
    failureStreak: normalizeFailureStreak(row.failure_streak),
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

  if (filters.dueBefore) {
    clauses.push('(next_check_at <= ?)')
    params.push(String(filters.dueBefore))
  }

  const afterRowId = Number(filters.afterRowId)
  if (Number.isInteger(afterRowId) && afterRowId > 0) {
    clauses.push('rowid > ?')
    params.push(afterRowId)
  }

  const maxRowId = Number(filters.maxRowId)
  if (Number.isInteger(maxRowId) && maxRowId > 0) {
    clauses.push('rowid <= ?')
    params.push(maxRowId)
  }

  if (filters.unknownOnly === true) {
    clauses.push("((country IS NULL OR country = '') OR (owner IS NULL OR owner = ''))")
  }

  return { clauses, params }
}

function getSqliteOrderByClause (orderBy = 'default') {
  if (orderBy === 'refresh') {
    return `updated_at ASC, delay ASC`
  }

  if (orderBy === 'due') {
    return `next_check_at ASC, stable DESC, delay ASC, updated_at ASC`
  }

  if (orderBy === 'rowid') {
    return 'rowid ASC'
  }

  if (orderBy === 'rowid_desc') {
    return 'rowid DESC'
  }

  return `stable DESC, delay ASC, updated_at DESC`
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

    if (hasHotColdData(db)) {
      return readSqliteCacheEntriesFromHotCold(db, options).map(deserializeSqliteCacheEntry).filter(Boolean)
    }

    const { clauses, params } = buildSqliteFilterClauses(options)
    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    const limit = normalizeSqliteQueryLimit(options.limit)
    const offset = normalizeSqliteQueryOffset(options.offset)
    let sql = `
      SELECT node_json, stable, delay, country, owner, source, updated_at, next_check_at, failure_streak, tag
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

    if (hasHotColdData(db)) {
      return readSqliteCacheRowIdsFromHotCold(db, options)
        .map(row => Number(row && row.rowid))
        .filter(rowId => Number.isInteger(rowId) && rowId > 0)
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

    if (hasHotColdData(db)) {
      const rows = readSqliteCacheEntriesByRowIdsFromHotCold(db, rowIds)
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
    }

    const placeholders = uniqueRowIds.map(() => '?').join(', ')
    const rows = db.prepare(`
      SELECT rowid, node_json, stable, delay, country, owner, source, updated_at, next_check_at, failure_streak, tag
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

function readSqliteCacheEntriesByFingerprints (cacheFilePath, fingerprints) {
  const uniqueFingerprints = [...new Set((fingerprints || []).map(value => String(value || '').trim()).filter(Boolean))]
  if (uniqueFingerprints.length === 0) {
    return []
  }

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

    if (hasHotColdData(db)) {
      return readSqliteCacheEntriesByFingerprintsFromHotCold(db, uniqueFingerprints)
    }

    const lookupFingerprints = []
    const lookupToCanonical = new Map()
    for (const fingerprint of uniqueFingerprints) {
      for (const candidate of getSqliteFingerprintCandidates(fingerprint)) {
        lookupFingerprints.push(candidate)
        lookupToCanonical.set(candidate, fingerprint)
      }
    }

    const chunkSize = 500
    const rowMap = new Map()
    for (let index = 0; index < lookupFingerprints.length; index += chunkSize) {
      const chunk = lookupFingerprints.slice(index, index + chunkSize)
      const placeholders = chunk.map(() => '?').join(', ')
      const rows = db.prepare(`
        SELECT node_json, stable, delay, country, owner, source, updated_at, next_check_at, failure_streak, tag, fingerprint
        FROM nodes
        WHERE fingerprint IN (${placeholders})
      `).all(...chunk)
      for (const row of rows) {
        const entry = deserializeSqliteCacheEntry(row)
        if (entry && row && row.fingerprint) {
          const storedFingerprint = String(row.fingerprint)
          const canonicalFingerprint = lookupToCanonical.get(storedFingerprint) || fingerprintNode(entry.node)
          if (canonicalFingerprint) {
            rowMap.set(canonicalFingerprint, entry)
          }
        }
      }
    }

    return uniqueFingerprints.map(fingerprint => rowMap.get(fingerprint)).filter(Boolean)
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

    if (hasHotColdData(db)) {
      return countSqliteCacheEntriesFromHotCold(db, filters)
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
    INSERT INTO nodes (fingerprint, node_key, node_json, stable, delay, country, owner, source, updated_at, next_check_at, failure_streak, tag)
    VALUES (@fingerprint, @nodeKey, @nodeJson, @stable, @delay, @country, @owner, @source, @updatedAt, @nextCheckAt, @failureStreak, @tag)
    ON CONFLICT(fingerprint) DO UPDATE SET
      node_key = excluded.node_key,
      node_json = excluded.node_json,
      stable = excluded.stable,
      delay = excluded.delay,
      country = excluded.country,
      owner = excluded.owner,
      source = excluded.source,
      updated_at = excluded.updated_at,
      next_check_at = excluded.next_check_at,
      failure_streak = excluded.failure_streak,
      tag = excluded.tag
  `)
}

function upsertNodeRuntimeStatement (db) {
  return db.prepare(`
    INSERT INTO node_runtime (fingerprint, node_key, stable, delay, country, owner, source, updated_at, next_check_at, failure_streak, tag)
    VALUES (@fingerprint, @nodeKey, @stable, @delay, @country, @owner, @source, @updatedAt, @nextCheckAt, @failureStreak, @tag)
    ON CONFLICT(fingerprint) DO UPDATE SET
      node_key = excluded.node_key,
      stable = excluded.stable,
      delay = excluded.delay,
      country = excluded.country,
      owner = excluded.owner,
      source = excluded.source,
      updated_at = excluded.updated_at,
      next_check_at = excluded.next_check_at,
      failure_streak = excluded.failure_streak,
      tag = excluded.tag
  `)
}

function upsertNodePayloadStatement (db) {
  return db.prepare(`
    INSERT INTO node_payload (node_key, node_json)
    VALUES (@nodeKey, @nodeJson)
    ON CONFLICT(node_key) DO UPDATE SET
      node_json = excluded.node_json
  `)
}


function getSqliteDatabaseSizeBytes (db) {
  if (!db) {
    return 0
  }

  const pageCount = Number(db.pragma('page_count', { simple: true }) || 0)
  const pageSize = Number(db.pragma('page_size', { simple: true }) || 0)
  if (!Number.isFinite(pageCount) || !Number.isFinite(pageSize) || pageCount <= 0 || pageSize <= 0) {
    return 0
  }
  return pageCount * pageSize
}

function getSqliteCacheSizeBytes (cacheFilePath) {
  const sqlitePath = getSqliteCachePath(cacheFilePath)
  if (!sqlitePath || !fs.existsSync(sqlitePath)) {
    return 0
  }

  let db = null
  try {
    db = openSqliteCache(cacheFilePath)
    if (!db) {
      return 0
    }
    return getSqliteDatabaseSizeBytes(db)
  } catch {
    return 0
  } finally {
    if (db) {
      db.close()
    }
  }
}

function cleanupOutdatedToSizeLimit (cacheFilePath, targetBytes) {
  let db = null
  try {
    db = openSqliteCache(cacheFilePath)
    if (!db) {
      return null
    }

    const normalizedTargetBytes = Number(targetBytes)
    if (!Number.isFinite(normalizedTargetBytes) || normalizedTargetBytes <= 0) {
      return {
        deleted: 0,
        sizeBefore: getSqliteDatabaseSizeBytes(db),
        sizeAfter: getSqliteDatabaseSizeBytes(db),
      }
    }

    const selectOldest = db.prepare('SELECT hash FROM outdated ORDER BY outdated_at ASC LIMIT 1024')
    const remove = db.prepare('DELETE FROM outdated WHERE hash = ?')
    const deleteBatch = db.transaction((hashes) => {
      for (const hash of hashes) {
        remove.run(hash)
      }
    })

    const sizeBefore = getSqliteDatabaseSizeBytes(db)
    let deleted = 0
    while (getSqliteDatabaseSizeBytes(db) > normalizedTargetBytes) {
      const hashes = selectOldest.all().map(row => row && row.hash).filter(Boolean)
      if (hashes.length === 0) {
        break
      }
      deleteBatch(hashes)
      deleted += hashes.length
      maybeRunIncrementalVacuum(db)
    }

    return {
      deleted,
      sizeBefore,
      sizeAfter: getSqliteDatabaseSizeBytes(db),
    }
  } catch {
    return null
  } finally {
    if (db) {
      db.close()
    }
  }
}

function upsertOutdated (cacheFilePath, hash, outdatedAt = Date.now()) {
  const normalizedHash = String(hash || '').trim()
  if (!normalizedHash) {
    return false
  }

  let db = null
  try {
    db = openSqliteCache(cacheFilePath)
    if (!db) {
      return false
    }

    db.prepare(`
      INSERT INTO outdated (hash, outdated_at)
      VALUES (?, ?)
      ON CONFLICT(hash) DO UPDATE SET outdated_at = excluded.outdated_at
    `).run(normalizedHash, Math.floor(Number(outdatedAt) || Date.now()))
    return true
  } catch {
    return false
  } finally {
    if (db) {
      db.close()
    }
  }
}

function deleteOutdated (cacheFilePath, hash) {
  const normalizedHash = String(hash || '').trim()
  if (!normalizedHash) {
    return false
  }

  let db = null
  try {
    db = openSqliteCache(cacheFilePath)
    if (!db) {
      return false
    }
    db.prepare('DELETE FROM outdated WHERE hash = ?').run(normalizedHash)
    return true
  } catch {
    return false
  } finally {
    if (db) {
      db.close()
    }
  }
}

function readOutdatedHashSet (cacheFilePath, hashes) {
  const normalizedHashes = [...new Set((hashes || []).map(hash => String(hash || '').trim()).filter(Boolean))]
  if (normalizedHashes.length === 0) {
    return new Set()
  }

  let db = null
  try {
    db = openSqliteCache(cacheFilePath)
    if (!db) {
      return new Set()
    }

    const placeholders = normalizedHashes.map(() => '?').join(', ')
    const rows = db.prepare(`SELECT hash FROM outdated WHERE hash IN (${placeholders})`).all(...normalizedHashes)
    return new Set(rows.map(row => row && row.hash).filter(Boolean))
  } catch {
    return new Set()
  } finally {
    if (db) {
      db.close()
    }
  }
}

function writeSqliteCacheEntries (cacheFilePath, entries) {
  let db = null
  try {
    db = openSqliteCache(cacheFilePath)
    if (!db) {
      return false
    }

    const maintainLegacyNodes = shouldMaintainLegacyNodes(db)
    const upsert = maintainLegacyNodes ? upsertSqliteEntryStatement(db) : null
    const upsertRuntime = upsertNodeRuntimeStatement(db)
    const upsertPayload = upsertNodePayloadStatement(db)
    const writeAll = db.transaction((items) => {
      if (maintainLegacyNodes && hasTable(db, 'nodes')) {
        db.prepare('DELETE FROM nodes').run()
      }
      db.prepare('DELETE FROM node_runtime').run()
      db.prepare('DELETE FROM node_payload').run()
      for (const item of items) {
        const serialized = serializeCacheEntryForSqlite(item)
        if (serialized) {
          if (upsert) {
            upsert.run(serialized)
          }
          upsertRuntime.run(serialized)
          upsertPayload.run(serialized)
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

function writeCacheUpdates (cacheFilePath, updatedEntries, touchedNodes = null, options = {}) {
  let db = null
  try {
    db = openSqliteCache(cacheFilePath, { lowFileCache: options.lowFileCache === true })
    if (!db) {
      return false
    }

    const updatedByFingerprint = new Map()
    const legacyFingerprintByCompact = new Map()
    for (const entry of updatedEntries || []) {
      const serialized = serializeCacheEntryForSqlite(entry)
      if (serialized) {
        updatedByFingerprint.set(serialized.fingerprint, serialized)
        if (serialized.legacyFingerprint && serialized.legacyFingerprint !== serialized.fingerprint) {
          legacyFingerprintByCompact.set(serialized.fingerprint, serialized.legacyFingerprint)
        }
      }
    }

    const normalizedTouchedNodes = Array.isArray(touchedNodes)
      ? touchedNodes
      : (updatedEntries || []).map(entry => entry && entry.node)
    const touchedFingerprints = []
    for (const node of normalizedTouchedNodes) {
      const fingerprint = fingerprintNode(node)
      if (fingerprint) {
        touchedFingerprints.push(createCompactFingerprint(fingerprint))
      }
    }

    const maintainLegacyNodes = shouldMaintainLegacyNodes(db)
    const upsert = maintainLegacyNodes ? upsertSqliteEntryStatement(db) : null
    const upsertRuntime = upsertNodeRuntimeStatement(db)
    const upsertPayload = upsertNodePayloadStatement(db)
    const remove = maintainLegacyNodes && hasTable(db, 'nodes') ? db.prepare('DELETE FROM nodes WHERE fingerprint = ?') : null
    const removeRuntime = db.prepare('DELETE FROM node_runtime WHERE fingerprint = ?')
    const removePayloadByNodeKey = db.prepare('DELETE FROM node_payload WHERE node_key = ?')
    const applyUpdates = db.transaction((fingerprints) => {
      for (const fingerprint of fingerprints) {
        const replacement = updatedByFingerprint.get(fingerprint)
        if (replacement) {
          const legacyFingerprint = legacyFingerprintByCompact.get(fingerprint)
          if (legacyFingerprint && remove) {
            remove.run(legacyFingerprint)
          }
          if (upsert) {
            upsert.run(replacement)
          }
          upsertRuntime.run(replacement)
          upsertPayload.run(replacement)
        } else {
          const existing = db.prepare('SELECT node_key FROM node_runtime WHERE fingerprint = ?').get(fingerprint)
          if (remove) {
            remove.run(fingerprint)
          }
          removeRuntime.run(fingerprint)
          if (existing && existing.node_key) {
            removePayloadByNodeKey.run(existing.node_key)
          }
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

function retireLegacyNodesStorage (cacheFilePath, options = {}) {
  let db = null
  try {
    db = openSqliteCache(cacheFilePath, { lowFileCache: options.lowFileCache === true })
    if (!db) {
      return {
        retired: false,
        pending: true,
      }
    }

    if (isLegacyNodesRetired(db)) {
      return {
        retired: true,
        alreadyRetired: true,
        pending: false,
      }
    }

    if (hasPendingHotColdMigration(db)) {
      return {
        retired: false,
        pending: true,
      }
    }

    const apply = db.transaction(() => {
      db.exec('DROP INDEX IF EXISTS idx_nodes_node_key')
      db.exec('DROP INDEX IF EXISTS idx_nodes_sort')
      db.exec('DROP INDEX IF EXISTS idx_nodes_country_sort')
      db.exec('DROP INDEX IF EXISTS idx_nodes_refresh')
      db.exec('DROP INDEX IF EXISTS idx_nodes_next_check')
      db.exec('DROP TABLE IF EXISTS nodes')
      markLegacyNodesRetired(db)
    })
    apply()
    maybeRunIncrementalVacuum(db)

    return {
      retired: true,
      alreadyRetired: false,
      pending: false,
    }
  } catch {
    return {
      retired: false,
      pending: true,
    }
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

function normalizeSubscriptionUrl (value) {
  return String(value || '').trim()
}

function getSubscriptionSourceKey (value, occurrence = null) {
  const normalized = normalizeSubscriptionUrl(value)
  if (!normalized) {
    return ''
  }
  const suffix = Number.isInteger(occurrence) && occurrence > 0 ? `#${occurrence}` : ''
  return require('node:crypto').createHash('sha256').update(`${normalized}${suffix}`).digest('hex')
}

function normalizeSubscriptionSnapshot (subscription, fallbackOrder = 0) {
  if (!subscription || typeof subscription !== 'object') {
    return null
  }

  const sourceKey = subscription.sourceKey || getSubscriptionSourceKey(subscription.url)
  if (!sourceKey) {
    return null
  }

  const nodeKeys = [...new Set((subscription.nodeKeys || [])
    .map(nodeKey => String(nodeKey || '').trim())
    .filter(Boolean))]

  return {
    sourceKey,
    displayLabel: String(subscription.displayLabel || subscription.url || sourceKey).slice(0, 500),
    sortOrder: Number.isInteger(subscription.sortOrder) ? subscription.sortOrder : fallbackOrder,
    configured: subscription.configured === false ? 0 : 1,
    nodeKeys,
  }
}

function normalizeSubscriptionSnapshotInPlace (subscription, fallbackOrder = 0) {
  const normalized = normalizeSubscriptionSnapshot(subscription, fallbackOrder)
  if (!normalized) {
    return null
  }

  if (subscription && typeof subscription === 'object') {
    subscription.sourceKey = normalized.sourceKey
    subscription.displayLabel = normalized.displayLabel
    subscription.sortOrder = normalized.sortOrder
    subscription.configured = normalized.configured !== 0
    subscription.nodeKeys = normalized.nodeKeys
  }

  return subscription
}

function syncSubscriptions (cacheFilePath, subscriptions, options = {}) {
  let db = null
  try {
    db = openSqliteCache(cacheFilePath)
    if (!db) {
      return null
    }

    const now = options.now || formatLocalTimestamp()
    const staleAfterDays = Math.max(1, Number(options.staleAfterDays) || 30)
    const markMissingUnconfigured = options.markMissingUnconfigured !== false
    const replaceRefs = options.replaceRefs !== false
    const normalizedSubscriptions = []
    const currentSourceKeys = new Set()
    let refCount = 0

    for (let index = 0; index < (subscriptions || []).length; index += 1) {
      const normalized = normalizeSubscriptionSnapshotInPlace(subscriptions[index], index + 1)
      if (!normalized) {
        continue
      }
      normalizedSubscriptions.push(normalized)
      currentSourceKeys.add(normalized.sourceKey)
      refCount += Array.isArray(normalized.nodeKeys) ? normalized.nodeKeys.length : 0
    }

    if (Array.isArray(options.currentSourceKeys)) {
      for (const sourceKey of options.currentSourceKeys) {
        const normalizedSourceKey = String(sourceKey || '').trim()
        if (normalizedSourceKey) {
          currentSourceKeys.add(normalizedSourceKey)
        }
      }
    }

    const existingRows = db.prepare('SELECT source_key FROM subscriptions WHERE configured = 1').all()
    const staleConfiguredKeys = markMissingUnconfigured
      ? existingRows
        .map(row => row && row.source_key)
        .filter(sourceKey => sourceKey && !currentSourceKeys.has(sourceKey))
      : []

    const upsertSubscription = db.prepare(`
      INSERT INTO subscriptions (source_key, display_label, sort_order, configured, last_seen_stage2_at, stale_after_days, created_at, updated_at)
      VALUES (@sourceKey, @displayLabel, @sortOrder, 1, @now, @staleAfterDays, @now, @now)
      ON CONFLICT(source_key) DO UPDATE SET
        display_label = excluded.display_label,
        sort_order = excluded.sort_order,
        configured = 1,
        last_seen_stage2_at = excluded.last_seen_stage2_at,
        stale_after_days = excluded.stale_after_days,
        updated_at = excluded.updated_at
    `)
    const markUnconfigured = db.prepare('UPDATE subscriptions SET configured = 0, updated_at = ? WHERE source_key = ?')
    const deleteRefsForSubscription = db.prepare('DELETE FROM subscription_node_refs WHERE subscription_source_key = ?')
    const upsertRef = db.prepare(`
      INSERT INTO subscription_node_refs (subscription_source_key, node_key, last_seen_stage2_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(subscription_source_key, node_key) DO UPDATE SET
        last_seen_stage2_at = excluded.last_seen_stage2_at,
        updated_at = excluded.updated_at
    `)

    const apply = db.transaction(() => {
      for (const sourceKey of staleConfiguredKeys) {
        markUnconfigured.run(now, sourceKey)
      }
      for (const subscription of normalizedSubscriptions) {
        upsertSubscription.run({
          sourceKey: subscription.sourceKey,
          displayLabel: subscription.displayLabel,
          sortOrder: subscription.sortOrder,
          staleAfterDays,
          now,
        })
        if (replaceRefs) {
          deleteRefsForSubscription.run(subscription.sourceKey)
          for (const nodeKey of subscription.nodeKeys) {
            upsertRef.run(subscription.sourceKey, nodeKey, now, now, now)
          }
        }
      }
    })
    apply()

    return {
      configured: normalizedSubscriptions.length,
      unconfigured: staleConfiguredKeys.length,
      refs: refCount,
    }
  } catch {
    return null
  } finally {
    if (db) {
      db.close()
    }
  }
}

function syncSubscriptionSourceChunk (cacheFilePath, subscription, nodeKeys, options = {}) {
  let db = null
  try {
    db = openSqliteCache(cacheFilePath, { lowFileCache: options.lowFileCache === true })
    if (!db) {
      return null
    }

    const normalizedSubscription = normalizeSubscriptionSnapshot(subscription, Number(subscription && subscription.sortOrder) || 0)
    if (!normalizedSubscription) {
      return null
    }

    const now = options.now || formatLocalTimestamp()
    const staleAfterDays = Math.max(1, Number(options.staleAfterDays) || 30)
    const replaceExistingRefs = options.replaceExistingRefs === true
    const maxRefsPerSubscription = Number.isInteger(options.maxRefsPerSubscription) && options.maxRefsPerSubscription > 0
      ? options.maxRefsPerSubscription
      : null
    const normalizedNodeKeys = [...new Set((nodeKeys || [])
      .map(nodeKey => String(nodeKey || '').trim())
      .filter(Boolean))]

    const upsertSubscription = db.prepare(`
      INSERT INTO subscriptions (source_key, display_label, sort_order, configured, last_seen_stage2_at, stale_after_days, created_at, updated_at)
      VALUES (@sourceKey, @displayLabel, @sortOrder, 1, @now, @staleAfterDays, @now, @now)
      ON CONFLICT(source_key) DO UPDATE SET
        display_label = excluded.display_label,
        sort_order = excluded.sort_order,
        configured = 1,
        last_seen_stage2_at = excluded.last_seen_stage2_at,
        stale_after_days = excluded.stale_after_days,
        updated_at = excluded.updated_at
    `)
    const deleteRefsForSubscription = db.prepare('DELETE FROM subscription_node_refs WHERE subscription_source_key = ?')
    const countRefsForSubscription = db.prepare('SELECT COUNT(*) AS count FROM subscription_node_refs WHERE subscription_source_key = ?')
    const upsertRef = db.prepare(`
      INSERT INTO subscription_node_refs (subscription_source_key, node_key, last_seen_stage2_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(subscription_source_key, node_key) DO UPDATE SET
        last_seen_stage2_at = excluded.last_seen_stage2_at,
        updated_at = excluded.updated_at
    `)

    let writtenRefs = 0
    let skippedRefs = 0

    const apply = db.transaction(() => {
      upsertSubscription.run({
        sourceKey: normalizedSubscription.sourceKey,
        displayLabel: normalizedSubscription.displayLabel,
        sortOrder: normalizedSubscription.sortOrder,
        staleAfterDays,
        now,
      })

      if (replaceExistingRefs) {
        deleteRefsForSubscription.run(normalizedSubscription.sourceKey)
      }

      let remainingRefs = Infinity
      if (maxRefsPerSubscription != null) {
        const currentRefCount = Number((countRefsForSubscription.get(normalizedSubscription.sourceKey) || {}).count) || 0
        remainingRefs = Math.max(0, maxRefsPerSubscription - currentRefCount)
      }

      for (const nodeKey of normalizedNodeKeys) {
        if (remainingRefs <= 0) {
          skippedRefs += 1
          continue
        }
        upsertRef.run(normalizedSubscription.sourceKey, nodeKey, now, now, now)
        writtenRefs += 1
        remainingRefs -= 1
      }
    })
    apply()

    if (options.lowFileCache === true) {
      try {
        db.pragma('shrink_memory')
      } catch {
        // ignore shrink errors; it is only a memory pressure hint
      }
    }

    return {
      configured: 1,
      refs: writtenRefs,
      skippedRefs,
    }
  } catch {
    return null
  } finally {
    if (db) {
      db.close()
    }
  }
}

function resetStage2SeenNodeKeys (cacheFilePath, initialNodeKeys = []) {
  let db = null
  try {
    cleanupStage2SeenDb(cacheFilePath)
    db = openStage2SeenDb(cacheFilePath, { reset: true })
    if (!db) {
      return false
    }

    const normalizedNodeKeys = [...new Set((initialNodeKeys || [])
      .map(nodeKey => String(nodeKey || '').trim())
      .filter(Boolean))]

    const insert = db.prepare('INSERT OR IGNORE INTO stage2_seen_node_keys (node_key) VALUES (?)')
    const apply = db.transaction(() => {
      for (const nodeKey of normalizedNodeKeys) {
        insert.run(nodeKey)
      }
    })
    apply()
    return true
  } catch {
    return false
  } finally {
    if (db) {
      db.close()
    }
  }
}

function filterUnseenStage2Nodes (cacheFilePath, nodes) {
  let db = null
  try {
    db = openStage2SeenDb(cacheFilePath)
    if (!db) {
      return null
    }

    const normalizedNodes = Array.isArray(nodes) ? nodes : []
    const insert = db.prepare('INSERT OR IGNORE INTO stage2_seen_node_keys (node_key) VALUES (?)')
    const acceptedNodes = []
    const acceptedNodeKeys = []

    const apply = db.transaction((items) => {
      for (const node of items) {
        const nodeKey = getNodeKey(node)
        if (!nodeKey) {
          continue
        }

        const result = insert.run(nodeKey)
        if (result && result.changes > 0) {
          acceptedNodes.push(node)
          acceptedNodeKeys.push(nodeKey)
        }
      }
    })
    apply(normalizedNodes)

    return {
      nodes: acceptedNodes,
      nodeKeys: acceptedNodeKeys,
    }
  } catch {
    return null
  } finally {
    if (db) {
      db.close()
    }
  }
}

function createStage2SeenNodeFilter (cacheFilePath) {
  const db = openStage2SeenDb(cacheFilePath)
  if (!db) {
    return null
  }

  const insert = db.prepare('INSERT OR IGNORE INTO stage2_seen_node_keys (node_key) VALUES (?)')
  const apply = db.transaction((items, callbacks = {}) => {
    const normalizedNodes = Array.isArray(items) ? items : []
    const onAcceptedNode = typeof callbacks.onAcceptedNode === 'function' ? callbacks.onAcceptedNode : null
    const onAcceptedNodeKey = typeof callbacks.onAcceptedNodeKey === 'function' ? callbacks.onAcceptedNodeKey : null
    let acceptedCount = 0

    for (const node of normalizedNodes) {
      const nodeKey = getNodeKey(node)
      if (!nodeKey) {
        continue
      }

      const result = insert.run(nodeKey)
      if (!result || result.changes <= 0) {
        continue
      }

      acceptedCount += 1
      if (onAcceptedNodeKey) {
        onAcceptedNodeKey(nodeKey, node)
      }
      if (onAcceptedNode) {
        onAcceptedNode(node, nodeKey)
      }
    }

    return acceptedCount
  })

  return {
    acceptNodes (nodes, callbacks = {}) {
      return apply(nodes, callbacks)
    },
    close () {
      try {
        db.close()
      } catch {
        // ignore close errors for temporary stage2 scratch handle
      }
      cleanupStage2SeenDb(cacheFilePath)
    },
  }
}

function readSubscriptionAvailabilitySummary (cacheFilePath, options = {}) {
  let db = null
  try {
    db = openSqliteCache(cacheFilePath, { lowFileCache: options.lowFileCache === true })
    if (!db) {
      return []
    }

    const roundAvailableNodeKeys = new Set((options.availableNodeKeys || [])
      .map(nodeKey => String(nodeKey || '').trim())
      .filter(Boolean))

    const rows = db.prepare(`
      SELECT
        s.source_key AS sourceKey,
        s.display_label AS displayLabel,
        s.sort_order AS sortOrder,
        s.configured AS configured,
        s.last_available_at AS lastAvailableAt,
        s.zero_available_since AS zeroAvailableSince,
        s.stale_after_days AS staleAfterDays,
        COUNT(r.node_key) AS stage2NodeCount,
        SUM(CASE WHEN n.node_key IS NOT NULL THEN 1 ELSE 0 END) AS retainedNodeCount
      FROM subscriptions s
      LEFT JOIN subscription_node_refs r ON r.subscription_source_key = s.source_key
      LEFT JOIN node_runtime n ON n.node_key = r.node_key
      GROUP BY s.source_key
      ORDER BY s.configured DESC, s.sort_order ASC
    `).all().map(row => ({
      sourceKey: row.sourceKey,
      displayLabel: row.displayLabel,
      sortOrder: Number(row.sortOrder) || 0,
      configured: row.configured === 1,
      lastAvailableAt: row.lastAvailableAt || null,
      zeroAvailableSince: row.zeroAvailableSince || null,
      staleAfterDays: Number(row.staleAfterDays) || 30,
      stage2NodeCount: Number(row.stage2NodeCount) || 0,
      retainedNodeCount: Number(row.retainedNodeCount) || 0,
      availableNodeCount: 0,
    }))

    for (const row of rows) {
      if (roundAvailableNodeKeys.size === 0) {
        continue
      }
      const refs = db.prepare('SELECT node_key FROM subscription_node_refs WHERE subscription_source_key = ?').all(row.sourceKey)
      row.availableNodeCount = refs.reduce((count, ref) => count + (roundAvailableNodeKeys.has(ref.node_key) ? 1 : 0), 0)
    }

    rows.sort((left, right) => {
      if (left.configured !== right.configured) {
        return left.configured ? -1 : 1
      }
      if (left.availableNodeCount !== right.availableNodeCount) {
        return right.availableNodeCount - left.availableNodeCount
      }
      return left.sortOrder - right.sortOrder
    })
    return rows
  } catch {
    return []
  } finally {
    if (db) {
      db.close()
    }
  }
}

function updateSubscriptionAvailability (cacheFilePath, options = {}) {
  let db = null
  try {
    db = openSqliteCache(cacheFilePath)
    if (!db) {
      return null
    }

    const now = options.now || formatLocalTimestamp()
    const staleAfterDays = Math.max(1, Number(options.staleAfterDays) || 30)
    const rows = readSubscriptionAvailabilitySummary(cacheFilePath, {
      availableNodeKeys: options.availableNodeKeys,
    })
    const updateAvailable = db.prepare('UPDATE subscriptions SET last_available_at = ?, zero_available_since = NULL, stale_after_days = ?, updated_at = ? WHERE source_key = ?')
    const updateZero = db.prepare('UPDATE subscriptions SET zero_available_since = COALESCE(zero_available_since, ?), stale_after_days = ?, updated_at = ? WHERE source_key = ?')
    const deleteRefs = db.prepare('DELETE FROM subscription_node_refs WHERE subscription_source_key = ?')
    const deleteSubscription = db.prepare('DELETE FROM subscriptions WHERE source_key = ?')
    const deleted = []

    const apply = db.transaction(() => {
      for (const row of rows) {
        if (row.availableNodeCount > 0) {
          updateAvailable.run(now, staleAfterDays, now, row.sourceKey)
          continue
        }

        updateZero.run(now, staleAfterDays, now, row.sourceKey)
        const zeroSince = row.zeroAvailableSince || now
        const zeroSinceTime = new Date(zeroSince).getTime()
        const nowTime = new Date(now).getTime()
        const staleMs = staleAfterDays * 24 * 60 * 60 * 1000
        if (Number.isFinite(zeroSinceTime) && Number.isFinite(nowTime) && nowTime - zeroSinceTime >= staleMs && row.retainedNodeCount === 0) {
          deleteRefs.run(row.sourceKey)
          deleteSubscription.run(row.sourceKey)
          deleted.push(row.sourceKey)
        }
      }
    })
    apply()

    const summary = readSubscriptionAvailabilitySummary(cacheFilePath, {
      availableNodeKeys: options.availableNodeKeys,
    })
    return { summary, deleted }
  } catch {
    return null
  } finally {
    if (db) {
      db.close()
    }
  }
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
    nextCheckAt: entry.nextCheckAt || null,
    failureStreak: normalizeFailureStreak(entry.failureStreak),
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
  getNodeKey,
  getSubscriptionSourceKey,
  countCacheEntries,
  readCacheEntries,
  readCacheRowIds: readSqliteCacheRowIds,
  readCacheEntriesByRowIds: readSqliteCacheEntriesByRowIds,
  readCacheEntriesForRefreshByRowIds: readSqliteCacheEntriesForRefreshByRowIds,
  readCacheEntriesForStartup: readSqliteCacheEntriesForStartup,
  readCacheEntriesByFingerprints: readSqliteCacheEntriesByFingerprints,
  migrateHotColdSchema,
  retireLegacyNodesStorage,
  compactRetiredSqliteCache,
  readSubscriptionAvailabilitySummary,
  readCacheNodes,
  buildCacheEntriesFromObservatory,
  mergeCacheEntries,
  cleanupOutdatedToSizeLimit,
  deleteOutdated,
  syncSubscriptions,
  syncSubscriptionSourceChunk,
  resetStage2SeenNodeKeys,
  filterUnseenStage2Nodes,
  createStage2SeenNodeFilter,
  formatLocalTimestamp,
  getSqliteCacheSizeBytes,
  readOutdatedHashSet,
  upsertOutdated,
  updateSubscriptionAvailability,
  writeCacheUpdates,
  writeCache,
  sortCacheEntries,
  resolveOwnerLabel,
}
