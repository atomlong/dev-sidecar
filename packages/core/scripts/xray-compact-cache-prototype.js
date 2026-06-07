#!/usr/bin/env node
'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')
const zlib = require('zlib')
const Database = require('better-sqlite3')

function parseArgs (argv) {
  const home = os.homedir()
  const args = {
    input: path.join(home, '.dev-sidecar', 'xray', 'nodes_cache.sqlite'),
    outputDir: path.join(os.tmpdir(), 'dev-sidecar-xray-cache-prototype'),
    hashBytes: 16,
    compressionLevel: 1,
    batchSize: 5000,
    sampleSize: 50,
    stage3Limit: 10000,
    maxRows: 0,
    force: false
  }

  for (const arg of argv.slice(2)) {
    if (arg === '--force') {
      args.force = true
    } else if (arg.startsWith('--input=')) {
      args.input = path.resolve(arg.slice('--input='.length))
    } else if (arg.startsWith('--output-dir=')) {
      args.outputDir = path.resolve(arg.slice('--output-dir='.length))
    } else if (arg.startsWith('--hash-bytes=')) {
      args.hashBytes = Number(arg.slice('--hash-bytes='.length))
    } else if (arg.startsWith('--compression-level=')) {
      args.compressionLevel = Number(arg.slice('--compression-level='.length))
    } else if (arg.startsWith('--batch-size=')) {
      args.batchSize = Number(arg.slice('--batch-size='.length))
    } else if (arg.startsWith('--sample-size=')) {
      args.sampleSize = Number(arg.slice('--sample-size='.length))
    } else if (arg.startsWith('--stage3-limit=')) {
      args.stage3Limit = Number(arg.slice('--stage3-limit='.length))
    } else if (arg.startsWith('--max-rows=')) {
      args.maxRows = Number(arg.slice('--max-rows='.length))
    } else if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  if (![16, 32].includes(args.hashBytes)) {
    throw new Error('--hash-bytes must be 16 or 32')
  }
  if (!Number.isInteger(args.compressionLevel) || args.compressionLevel < 0 || args.compressionLevel > 9) {
    throw new Error('--compression-level must be an integer from 0 to 9')
  }
  if (!Number.isInteger(args.batchSize) || args.batchSize <= 0) {
    throw new Error('--batch-size must be a positive integer')
  }
  if (!Number.isInteger(args.sampleSize) || args.sampleSize < 0) {
    throw new Error('--sample-size must be a non-negative integer')
  }
  if (!Number.isInteger(args.stage3Limit) || args.stage3Limit < 0) {
    throw new Error('--stage3-limit must be a non-negative integer')
  }
  if (!Number.isInteger(args.maxRows) || args.maxRows < 0) {
    throw new Error('--max-rows must be a non-negative integer')
  }

  args.output = path.join(
    args.outputDir,
    `nodes_cache_v2.hash${args.hashBytes}.level${args.compressionLevel}.prototype.sqlite`
  )
  return args
}

function printHelp () {
  console.log(`Usage: node packages/core/scripts/xray-compact-cache-prototype.js [options]\n\nOptions:\n  --input=<path>                 Old nodes_cache.sqlite path\n  --output-dir=<dir>             Prototype output directory\n  --hash-bytes=16|32             Hash bytes to store in BLOB columns, default 16\n  --compression-level=0..9       deflateRaw compression level, default 1\n  --batch-size=<n>               Rows per transaction, default 5000\n  --sample-size=<n>              Validation sample size, default 50\n  --stage3-limit=<n>             Stage3 query simulation row limit, default 10000\n  --max-rows=<n>                 Optional smoke-test cap for nodes/refs, default 0 means all\n  --force                        Overwrite existing prototype DB\n`)
}

function ensureInputFile (file) {
  if (!fs.existsSync(file)) {
    throw new Error(`Input DB not found: ${file}`)
  }
  const stat = fs.statSync(file)
  if (!stat.isFile()) {
    throw new Error(`Input path is not a file: ${file}`)
  }
}

function prepareOutput (args) {
  fs.mkdirSync(args.outputDir, { recursive: true })
  if (fs.existsSync(args.output)) {
    if (!args.force) {
      throw new Error(`Output DB already exists: ${args.output}\nUse --force to overwrite it.`)
    }
    removeIfExists(args.output)
  }
  removeIfExists(`${args.output}-wal`)
  removeIfExists(`${args.output}-shm`)
}

function removeIfExists (file) {
  try {
    if (fs.existsSync(file)) {
      fs.rmSync(file, { force: true })
    }
  } catch (error) {
    throw new Error(`Failed to remove ${file}: ${error.message}`)
  }
}

function openOldDbReadOnly (file) {
  return new Database(file, { readonly: true, fileMustExist: true })
}

function openNewDb (file) {
  return new Database(file)
}

function applyPragmas (db) {
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('temp_store = FILE')
  db.pragma('mmap_size = 0')
  db.pragma('cache_size = -2000')
  db.pragma('wal_autocheckpoint = 1000')
}

function createV2Schema (db) {
  db.exec(`
    CREATE TABLE subscriptions_v2 (
      subscription_id INTEGER PRIMARY KEY,
      source_key TEXT UNIQUE NOT NULL,
      display_label TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      configured INTEGER NOT NULL DEFAULT 1,
      last_seen_stage2_at INTEGER,
      last_available_at INTEGER,
      zero_available_since INTEGER,
      stale_after_days INTEGER NOT NULL DEFAULT 30,
      created_at INTEGER,
      updated_at INTEGER
    );

    CREATE TABLE nodes_v2 (
      node_id INTEGER PRIMARY KEY,
      fingerprint_hash BLOB UNIQUE NOT NULL,
      node_key_hash BLOB UNIQUE NOT NULL,
      node_json_compressed BLOB NOT NULL
    );

    CREATE TABLE node_runtime_v2 (
      node_id INTEGER PRIMARY KEY,
      stable INTEGER NOT NULL DEFAULT 0,
      delay INTEGER,
      country TEXT,
      owner TEXT,
      source TEXT,
      updated_at INTEGER,
      next_check_at INTEGER,
      failure_streak INTEGER NOT NULL DEFAULT 0,
      tag TEXT
    );

    CREATE TABLE subscription_node_refs_v2 (
      subscription_id INTEGER NOT NULL,
      node_id INTEGER NOT NULL,
      last_seen_stage2_at INTEGER,
      PRIMARY KEY(subscription_id, node_id)
    ) WITHOUT ROWID;

    CREATE TABLE node_key_map_tmp (
      node_key TEXT PRIMARY KEY,
      node_id INTEGER NOT NULL
    );
  `)
}

function createV2Indexes (db) {
  db.exec(`
    CREATE INDEX idx_runtime_next_check_v2
    ON node_runtime_v2(next_check_at, node_id)
    WHERE next_check_at IS NOT NULL;
  `)
}

function toEpochSeconds (value) {
  if (value === null || value === undefined || value === '') {
    return null
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value > 100000000000) {
      return Math.floor(value / 1000)
    }
    return Math.floor(value)
  }
  const text = String(value).trim()
  if (!text) {
    return null
  }
  if (/^\d+$/.test(text)) {
    const n = Number(text)
    if (Number.isFinite(n)) {
      return n > 100000000000 ? Math.floor(n / 1000) : Math.floor(n)
    }
  }
  const candidates = [text, text.replace(' ', 'T'), `${text.replace(' ', 'T')}+08:00`]
  for (const candidate of candidates) {
    const ms = Date.parse(candidate)
    if (Number.isFinite(ms)) {
      return Math.floor(ms / 1000)
    }
  }
  return null
}

function hashBlob (value, bytes) {
  const full = crypto.createHash('sha256').update(String(value || '')).digest()
  return bytes === 32 ? full : full.subarray(0, bytes)
}

function compressNodeJson (json, level) {
  return zlib.deflateRawSync(Buffer.from(String(json || ''), 'utf8'), { level })
}

function readMemoryStats () {
  const mem = process.memoryUsage()
  const result = {
    rss: mem.rss,
    heapUsed: mem.heapUsed,
    heapTotal: mem.heapTotal,
    external: mem.external
  }

  const cgroupV2Base = resolveCgroupV2Base()
  const current = readNumberFile(path.join(cgroupV2Base, 'memory.current'))
  const peak = readNumberFile(path.join(cgroupV2Base, 'memory.peak'))
  if (current !== null) {
    result.cgroupCurrent = current
  }
  if (peak !== null) {
    result.cgroupPeak = peak
  }
  const stat = readKeyValueFile(path.join(cgroupV2Base, 'memory.stat'))
  if (stat) {
    result.cgroupAnon = stat.anon
    result.cgroupFile = stat.file
    result.cgroupKernel = stat.kernel
    result.cgroupFileDirty = stat.file_dirty
    result.cgroupInactiveFile = stat.inactive_file
    result.cgroupActiveFile = stat.active_file
  }
  return result
}

function resolveCgroupV2Base () {
  const fallback = '/sys/fs/cgroup'
  try {
    const text = fs.readFileSync('/proc/self/cgroup', 'utf8')
    const line = text.split(/\n+/).find(row => row.startsWith('0::'))
    if (!line) {
      return fallback
    }
    const relative = line.slice('0::'.length).trim()
    const normalized = relative === '/' ? '' : relative.replace(/^\/+/, '')
    const candidate = path.join(fallback, normalized)
    if (fs.existsSync(candidate)) {
      return candidate
    }
  } catch {}
  return fallback
}

function readNumberFile (file) {
  try {
    const text = fs.readFileSync(file, 'utf8').trim()
    const value = Number(text)
    return Number.isFinite(value) ? value : null
  } catch {
    return null
  }
}

function readKeyValueFile (file) {
  try {
    const rows = fs.readFileSync(file, 'utf8').trim().split(/\n+/)
    const out = {}
    for (const row of rows) {
      const [key, value] = row.trim().split(/\s+/)
      const n = Number(value)
      if (key && Number.isFinite(n)) {
        out[key] = n
      }
    }
    return out
  } catch {
    return null
  }
}

function formatBytes (value) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return 'n/a'
  }
  const mb = value / 1024 / 1024
  return `${mb.toFixed(1)}MB`
}

function logMemory (label, report) {
  const stats = readMemoryStats()
  report.memory.push({ label, ...stats })
  console.log(`[mem] ${label}: rss=${formatBytes(stats.rss)} heapUsed=${formatBytes(stats.heapUsed)} cgroupCurrent=${formatBytes(stats.cgroupCurrent)} cgroupPeak=${formatBytes(stats.cgroupPeak)} cgroupFile=${formatBytes(stats.cgroupFile)} cgroupAnon=${formatBytes(stats.cgroupAnon)} dirty=${formatBytes(stats.cgroupFileDirty)}`)
}

function getCount (db, sql, params = []) {
  const row = db.prepare(sql).get(...params)
  const value = row && (row.count !== undefined ? row.count : Object.values(row)[0])
  return Number(value || 0)
}

function migrateSubscriptions (oldDb, newDb, report) {
  const rows = oldDb.prepare(`
    SELECT source_key, display_label, sort_order, configured,
      last_seen_stage2_at, last_available_at, zero_available_since,
      stale_after_days, created_at, updated_at
    FROM subscriptions
    ORDER BY source_key
  `).all()
  const insert = newDb.prepare(`
    INSERT INTO subscriptions_v2 (
      source_key, display_label, sort_order, configured,
      last_seen_stage2_at, last_available_at, zero_available_since,
      stale_after_days, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const tx = newDb.transaction((items) => {
    for (const row of items) {
      insert.run(
        row.source_key,
        row.display_label,
        row.sort_order,
        row.configured,
        toEpochSeconds(row.last_seen_stage2_at),
        toEpochSeconds(row.last_available_at),
        toEpochSeconds(row.zero_available_since),
        row.stale_after_days,
        toEpochSeconds(row.created_at),
        toEpochSeconds(row.updated_at)
      )
    }
  })
  tx(rows)
  report.counts.subscriptionsMigrated = rows.length
  console.log(`[migrate] subscriptions=${rows.length}`)
}

function migrateNodesAndRuntime (oldDb, newDb, args, report) {
  const maxRowsClause = args.maxRows > 0 ? 'AND p.rowid <= ?' : ''
  const totalParams = args.maxRows > 0 ? [args.maxRows] : []
  const total = getCount(oldDb, `SELECT COUNT(*) AS count FROM node_payload p WHERE 1=1 ${maxRowsClause}`, totalParams)
  report.counts.nodePayloadOldConsidered = total

  const select = oldDb.prepare(`
    SELECT p.rowid AS rowid, p.node_key, p.node_json,
      r.fingerprint, r.stable, r.delay, r.country, r.owner, r.source,
      r.updated_at, r.next_check_at, r.failure_streak, r.tag
    FROM node_payload p
    LEFT JOIN node_runtime r ON r.node_key = p.node_key
    WHERE p.rowid > ? ${args.maxRows > 0 ? 'AND p.rowid <= ?' : ''}
    ORDER BY p.rowid
    LIMIT ?
  `)
  const insertNode = newDb.prepare(`
    INSERT INTO nodes_v2 (node_id, fingerprint_hash, node_key_hash, node_json_compressed)
    VALUES (?, ?, ?, ?)
  `)
  const insertRuntime = newDb.prepare(`
    INSERT INTO node_runtime_v2 (
      node_id, stable, delay, country, owner, source,
      updated_at, next_check_at, failure_streak, tag
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const insertMap = newDb.prepare('INSERT INTO node_key_map_tmp (node_key, node_id) VALUES (?, ?)')
  const tx = newDb.transaction((rows) => {
    for (const row of rows) {
      if (!row.fingerprint) {
        report.integrity.payloadWithoutRuntime++
        continue
      }
      const nodeId = report.nextNodeId++
      const compressed = compressNodeJson(row.node_json, args.compressionLevel)
      report.payloadBytes.original += Buffer.byteLength(String(row.node_json || ''), 'utf8')
      report.payloadBytes.compressed += compressed.length
      insertNode.run(nodeId, hashBlob(row.fingerprint, args.hashBytes), hashBlob(row.node_key, args.hashBytes), compressed)
      insertRuntime.run(
        nodeId,
        row.stable || 0,
        row.delay === null || row.delay === undefined ? null : Math.round(Number(row.delay)),
        row.country,
        row.owner,
        row.source,
        toEpochSeconds(row.updated_at),
        toEpochSeconds(row.next_check_at),
        row.failure_streak || 0,
        row.tag
      )
      insertMap.run(row.node_key, nodeId)
    }
  })

  let lastRowId = 0
  let migrated = 0
  while (true) {
    const params = args.maxRows > 0 ? [lastRowId, args.maxRows, args.batchSize] : [lastRowId, args.batchSize]
    const rows = select.all(...params)
    if (rows.length === 0) {
      break
    }
    tx(rows)
    lastRowId = rows[rows.length - 1].rowid
    migrated += rows.length
    if (migrated % (args.batchSize * 20) === 0 || migrated >= total) {
      console.log(`[migrate] nodes processed=${migrated}/${total}`)
    }
  }
  report.counts.nodesProcessed = migrated
  report.counts.nodesMigrated = getCount(newDb, 'SELECT COUNT(*) AS count FROM nodes_v2')
  console.log(`[migrate] nodes migrated=${report.counts.nodesMigrated}, payloadWithoutRuntime=${report.integrity.payloadWithoutRuntime}`)
}

function migrateRefs (oldDb, newDb, args, report) {
  const maxRowsClause = args.maxRows > 0 ? 'WHERE rowid <= ?' : ''
  const totalParams = args.maxRows > 0 ? [args.maxRows] : []
  const total = getCount(oldDb, `SELECT COUNT(*) AS count FROM subscription_node_refs ${maxRowsClause}`, totalParams)
  report.counts.refsOldConsidered = total

  const select = oldDb.prepare(`
    SELECT rowid, subscription_source_key, node_key, last_seen_stage2_at
    FROM subscription_node_refs
    WHERE rowid > ? ${args.maxRows > 0 ? 'AND rowid <= ?' : ''}
    ORDER BY rowid
    LIMIT ?
  `)
  const lookupSubscription = newDb.prepare('SELECT subscription_id FROM subscriptions_v2 WHERE source_key = ?')
  const lookupNode = newDb.prepare('SELECT node_id FROM node_key_map_tmp WHERE node_key = ?')
  const insertRef = newDb.prepare(`
    INSERT OR IGNORE INTO subscription_node_refs_v2 (subscription_id, node_id, last_seen_stage2_at)
    VALUES (?, ?, ?)
  `)
  const tx = newDb.transaction((rows) => {
    for (const row of rows) {
      const sub = lookupSubscription.get(row.subscription_source_key)
      if (!sub) {
        report.integrity.refsMissingSubscription++
        continue
      }
      const node = lookupNode.get(row.node_key)
      if (!node) {
        report.integrity.refsMissingNode++
        continue
      }
      insertRef.run(sub.subscription_id, node.node_id, toEpochSeconds(row.last_seen_stage2_at))
    }
  })

  let lastRowId = 0
  let migrated = 0
  while (true) {
    const params = args.maxRows > 0 ? [lastRowId, args.maxRows, args.batchSize] : [lastRowId, args.batchSize]
    const rows = select.all(...params)
    if (rows.length === 0) {
      break
    }
    tx(rows)
    lastRowId = rows[rows.length - 1].rowid
    migrated += rows.length
    if (migrated % (args.batchSize * 20) === 0 || migrated >= total) {
      console.log(`[migrate] refs processed=${migrated}/${total}`)
    }
  }
  report.counts.refsProcessed = migrated
  report.counts.refsMigrated = getCount(newDb, 'SELECT COUNT(*) AS count FROM subscription_node_refs_v2')
  console.log(`[migrate] refs migrated=${report.counts.refsMigrated}, missingSubscription=${report.integrity.refsMissingSubscription}, missingNode=${report.integrity.refsMissingNode}`)
}

function dropTempTables (db) {
  db.exec('DROP TABLE IF EXISTS node_key_map_tmp')
}

function checkpointAndOptimize (db) {
  try {
    db.pragma('wal_checkpoint(TRUNCATE)')
  } catch (error) {
    console.warn(`[warn] wal_checkpoint failed: ${error.message}`)
  }
  try {
    db.pragma('optimize')
  } catch (error) {
    console.warn(`[warn] optimize failed: ${error.message}`)
  }
}

function collectDbstat (db, dbPath, report) {
  const stat = {
    fileSize: fileSize(dbPath),
    walSize: fileSize(`${dbPath}-wal`),
    shmSize: fileSize(`${dbPath}-shm`),
    pageSize: safePragmaValue(db, 'page_size'),
    pageCount: safePragmaValue(db, 'page_count'),
    freelistCount: safePragmaValue(db, 'freelist_count'),
    journalMode: safePragmaValue(db, 'journal_mode'),
    objects: []
  }
  try {
    stat.objects = db.prepare(`
      SELECT name, SUM(pgsize) AS bytes
      FROM dbstat
      GROUP BY name
      ORDER BY bytes DESC
    `).all()
  } catch (error) {
    stat.dbstatError = error.message
  }
  stat.totalDbstatBytes = stat.objects.reduce((sum, row) => sum + Number(row.bytes || 0), 0)
  report.dbstat = stat

  console.log('[dbstat] fileSize=' + formatBytes(stat.fileSize) + ' wal=' + formatBytes(stat.walSize) + ' dbstatTotal=' + formatBytes(stat.totalDbstatBytes))
  for (const row of stat.objects.slice(0, 20)) {
    console.log(`[dbstat] ${row.name}: ${formatBytes(Number(row.bytes || 0))}`)
  }
}

function fileSize (file) {
  try {
    return fs.statSync(file).size
  } catch {
    return 0
  }
}

function safePragmaValue (db, name) {
  try {
    const row = db.pragma(name, { simple: true })
    return row
  } catch {
    return null
  }
}

function validateCounts (oldDb, newDb, args, report) {
  const oldSubscriptions = getCount(oldDb, 'SELECT COUNT(*) AS count FROM subscriptions')
  const oldPayload = getCount(oldDb, `SELECT COUNT(*) AS count FROM node_payload ${args.maxRows > 0 ? 'WHERE rowid <= ?' : ''}`, args.maxRows > 0 ? [args.maxRows] : [])
  const oldRuntime = args.maxRows > 0
    ? getCount(oldDb, `SELECT COUNT(*) AS count FROM node_runtime WHERE node_key IN (SELECT node_key FROM node_payload WHERE rowid <= ?)`, [args.maxRows])
    : getCount(oldDb, 'SELECT COUNT(*) AS count FROM node_runtime')
  const oldRefs = getCount(oldDb, `SELECT COUNT(*) AS count FROM subscription_node_refs ${args.maxRows > 0 ? 'WHERE rowid <= ?' : ''}`, args.maxRows > 0 ? [args.maxRows] : [])

  const counts = {
    oldSubscriptions,
    newSubscriptions: getCount(newDb, 'SELECT COUNT(*) AS count FROM subscriptions_v2'),
    oldPayload,
    newNodes: getCount(newDb, 'SELECT COUNT(*) AS count FROM nodes_v2'),
    oldRuntime,
    newRuntime: getCount(newDb, 'SELECT COUNT(*) AS count FROM node_runtime_v2'),
    oldRefs,
    newRefs: getCount(newDb, 'SELECT COUNT(*) AS count FROM subscription_node_refs_v2')
  }
  report.validation.counts = counts
  console.log('[validate] counts=' + JSON.stringify(counts))

  if (counts.oldSubscriptions !== counts.newSubscriptions) report.validation.errors.push('subscription count mismatch')
  if (counts.oldPayload !== counts.newNodes) report.validation.errors.push('payload/nodes count mismatch')
  if (report.integrity.payloadWithoutRuntime === 0 && counts.oldRuntime !== counts.newRuntime) report.validation.errors.push('runtime count mismatch')
  if (report.integrity.refsMissingSubscription === 0 && report.integrity.refsMissingNode === 0 && counts.oldRefs !== counts.newRefs) report.validation.errors.push('refs count mismatch')
}

function validateSamplePayloads (oldDb, newDb, args, report) {
  if (args.sampleSize <= 0) return
  const rows = oldDb.prepare(`
    SELECT p.node_key, p.node_json
    FROM node_payload p
    ${args.maxRows > 0 ? 'WHERE p.rowid <= ?' : ''}
    ORDER BY p.rowid
    LIMIT ?
  `).all(...(args.maxRows > 0 ? [args.maxRows, args.sampleSize] : [args.sampleSize]))
  const getNew = newDb.prepare('SELECT node_json_compressed FROM nodes_v2 WHERE node_key_hash = ?')
  let checked = 0
  for (const row of rows) {
    const found = getNew.get(hashBlob(row.node_key, args.hashBytes))
    if (!found) {
      report.validation.errors.push(`sample payload missing for node_key=${row.node_key}`)
      continue
    }
    const inflated = zlib.inflateRawSync(found.node_json_compressed).toString('utf8')
    if (inflated !== String(row.node_json)) {
      report.validation.errors.push(`sample payload mismatch for node_key=${row.node_key}`)
      continue
    }
    checked++
  }
  report.validation.samplePayloadsChecked = checked
  console.log(`[validate] samplePayloadsChecked=${checked}`)
}

function validateSampleMembership (oldDb, newDb, args, report) {
  if (args.sampleSize <= 0) return
  const subs = oldDb.prepare('SELECT source_key FROM subscriptions ORDER BY source_key LIMIT ?').all(args.sampleSize)
  const getSub = newDb.prepare('SELECT subscription_id FROM subscriptions_v2 WHERE source_key = ?')
  const oldCount = oldDb.prepare('SELECT COUNT(*) AS count FROM subscription_node_refs WHERE subscription_source_key = ?')
  const newCount = newDb.prepare('SELECT COUNT(*) AS count FROM subscription_node_refs_v2 WHERE subscription_id = ?')
  let checked = 0
  for (const sub of subs) {
    const newSub = getSub.get(sub.source_key)
    if (!newSub) {
      report.validation.errors.push(`sample subscription missing: ${sub.source_key}`)
      continue
    }
    const oldValue = oldCount.get(sub.source_key).count
    const newValue = newCount.get(newSub.subscription_id).count
    if (args.maxRows === 0 && oldValue !== newValue) {
      report.validation.errors.push(`sample ref count mismatch for ${sub.source_key}: old=${oldValue}, new=${newValue}`)
      continue
    }
    checked++
  }
  report.validation.sampleMembershipsChecked = checked
  console.log(`[validate] sampleMembershipsChecked=${checked}`)
}

function simulateStage3DueQuery (db, args, report) {
  if (args.stage3Limit <= 0) return
  const now = Math.floor(Date.now() / 1000)
  const plan = db.prepare(`
    EXPLAIN QUERY PLAN
    SELECT node_id
    FROM node_runtime_v2
    WHERE next_check_at IS NOT NULL
      AND next_check_at <= ?
    ORDER BY next_check_at ASC
    LIMIT ?
  `).all(now, args.stage3Limit)
  report.stage3.plan = plan
  console.log('[stage3] queryPlan=' + JSON.stringify(plan))

  const start = Date.now()
  const rows = db.prepare(`
    SELECT r.node_id, n.node_json_compressed, r.stable, r.delay, r.next_check_at
    FROM node_runtime_v2 r
    JOIN nodes_v2 n ON n.node_id = r.node_id
    WHERE r.next_check_at IS NOT NULL
      AND r.next_check_at <= ?
    ORDER BY r.next_check_at ASC
    LIMIT ?
  `).all(now, args.stage3Limit)
  let decompressedBytes = 0
  for (const row of rows) {
    decompressedBytes += zlib.inflateRawSync(row.node_json_compressed).length
  }
  report.stage3.rows = rows.length
  report.stage3.ms = Date.now() - start
  report.stage3.decompressedBytes = decompressedBytes
  console.log(`[stage3] rows=${rows.length} ms=${report.stage3.ms} decompressed=${formatBytes(decompressedBytes)}`)
}

function writeReport (args, report) {
  const reportPath = path.join(args.outputDir, `prototype-report.hash${args.hashBytes}.level${args.compressionLevel}.json`)
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2))
  console.log(`[report] ${reportPath}`)
}

function createReport (args) {
  return {
    args,
    startedAt: new Date().toISOString(),
    nextNodeId: 1,
    counts: {},
    payloadBytes: { original: 0, compressed: 0 },
    integrity: {
      payloadWithoutRuntime: 0,
      refsMissingSubscription: 0,
      refsMissingNode: 0
    },
    validation: {
      counts: {},
      errors: [],
      samplePayloadsChecked: 0,
      sampleMembershipsChecked: 0
    },
    memory: [],
    dbstat: null,
    stage3: {}
  }
}

function main () {
  const args = parseArgs(process.argv)
  ensureInputFile(args.input)
  prepareOutput(args)
  const report = createReport(args)

  console.log('[prototype] input=' + args.input)
  console.log('[prototype] output=' + args.output)
  console.log('[prototype] hashBytes=' + args.hashBytes + ' compressionLevel=' + args.compressionLevel + ' batchSize=' + args.batchSize + ' maxRows=' + args.maxRows)
  logMemory('start', report)

  const oldDb = openOldDbReadOnly(args.input)
  logMemory('after-open-old-db', report)
  const newDb = openNewDb(args.output)
  applyPragmas(newDb)
  createV2Schema(newDb)
  logMemory('after-create-v2-schema', report)

  try {
    migrateSubscriptions(oldDb, newDb, report)
    logMemory('after-migrate-subscriptions', report)

    migrateNodesAndRuntime(oldDb, newDb, args, report)
    logMemory('after-migrate-nodes-runtime', report)

    migrateRefs(oldDb, newDb, args, report)
    logMemory('after-migrate-refs', report)

    dropTempTables(newDb)
    logMemory('after-drop-temp-tables', report)

    createV2Indexes(newDb)
    logMemory('after-create-indexes', report)

    checkpointAndOptimize(newDb)
    logMemory('after-checkpoint-optimize', report)

    collectDbstat(newDb, args.output, report)

    validateCounts(oldDb, newDb, args, report)
    validateSamplePayloads(oldDb, newDb, args, report)
    validateSampleMembership(oldDb, newDb, args, report)
    logMemory('after-validation', report)

    simulateStage3DueQuery(newDb, args, report)
    logMemory('after-stage3-simulation', report)

    report.finishedAt = new Date().toISOString()
    report.payloadBytes.ratio = report.payloadBytes.original > 0 ? report.payloadBytes.compressed / report.payloadBytes.original : null
    writeReport(args, report)

    if (report.validation.errors.length > 0 || report.integrity.payloadWithoutRuntime > 0 || report.integrity.refsMissingSubscription > 0 || report.integrity.refsMissingNode > 0) {
      console.error('[result] FAILED integrity validation')
      for (const error of report.validation.errors) {
        console.error('[error] ' + error)
      }
      process.exitCode = 2
    } else {
      console.log('[result] OK')
    }
  } finally {
    try { oldDb.close() } catch {}
    try { newDb.close() } catch {}
  }
}

main()
