#!/usr/bin/env node
'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')
const zlib = require('zlib')
const Database = require('better-sqlite3')

function parseArgs (argv) {
  const args = {
    input: '/tmp/dev-sidecar-xray-cache-prototype/nodes_cache_v2.hash16.level1.prototype.sqlite',
    outputDir: path.join(os.tmpdir(), 'dev-sidecar-xray-cache-prototype'),
    batchSize: 5000,
    compressionLevel: 1,
    nodeLimit: 100000,
    refLimit: 100000,
    force: false,
    skipDbstat: true
  }

  for (const arg of argv.slice(2)) {
    if (arg === '--force') {
      args.force = true
    } else if (arg === '--dbstat') {
      args.skipDbstat = false
    } else if (arg.startsWith('--input=')) {
      args.input = path.resolve(arg.slice('--input='.length))
    } else if (arg.startsWith('--output-dir=')) {
      args.outputDir = path.resolve(arg.slice('--output-dir='.length))
    } else if (arg.startsWith('--batch-size=')) {
      args.batchSize = Number(arg.slice('--batch-size='.length))
    } else if (arg.startsWith('--compression-level=')) {
      args.compressionLevel = Number(arg.slice('--compression-level='.length))
    } else if (arg.startsWith('--node-limit=')) {
      args.nodeLimit = Number(arg.slice('--node-limit='.length))
    } else if (arg.startsWith('--ref-limit=')) {
      args.refLimit = Number(arg.slice('--ref-limit='.length))
    } else if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  if (!Number.isInteger(args.batchSize) || args.batchSize <= 0) throw new Error('--batch-size must be a positive integer')
  if (!Number.isInteger(args.compressionLevel) || args.compressionLevel < 0 || args.compressionLevel > 9) throw new Error('--compression-level must be an integer from 0 to 9')
  if (!Number.isInteger(args.nodeLimit) || args.nodeLimit < 0) throw new Error('--node-limit must be a non-negative integer; 0 means all')
  if (!Number.isInteger(args.refLimit) || args.refLimit < 0) throw new Error('--ref-limit must be a non-negative integer; 0 means all')

  args.output = path.join(
    args.outputDir,
    `nodes_cache_v2.stage2-write.node${args.nodeLimit}.ref${args.refLimit}.batch${args.batchSize}.sqlite`
  )
  return args
}

function printHelp () {
  console.log(`Usage: node packages/core/scripts/xray-compact-cache-stage2-write-test.js [options]\n\nOptions:\n  --input=<path>                 Existing prototype v2 DB path\n  --output-dir=<dir>             Output directory for writable DB copy\n  --batch-size=<n>               Rows per transaction, default 5000\n  --compression-level=0..9       deflateRaw compression level, default 1\n  --node-limit=<n>               Existing nodes to rewrite, default 100000; 0 means all\n  --ref-limit=<n>                Existing refs to rewrite, default 100000; 0 means all\n  --dbstat                       Run dbstat at end; omitted by default to avoid page-cache contamination\n  --force                        Overwrite writable DB copy\n`)
}

function removeIfExists (file) {
  if (fs.existsSync(file)) fs.rmSync(file, { force: true })
}

function prepareWritableCopy (args) {
  if (!fs.existsSync(args.input)) throw new Error(`Input DB not found: ${args.input}`)
  fs.mkdirSync(args.outputDir, { recursive: true })
  if (fs.existsSync(args.output) && !args.force) {
    throw new Error(`Output DB already exists: ${args.output}\nUse --force to overwrite it.`)
  }
  removeIfExists(args.output)
  removeIfExists(`${args.output}-wal`)
  removeIfExists(`${args.output}-shm`)
  fs.copyFileSync(args.input, args.output)
}

function applyPragmas (db) {
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('temp_store = FILE')
  db.pragma('mmap_size = 0')
  db.pragma('cache_size = -2000')
  db.pragma('wal_autocheckpoint = 1000')
}

function resolveCgroupV2Base () {
  const fallback = '/sys/fs/cgroup'
  try {
    const text = fs.readFileSync('/proc/self/cgroup', 'utf8')
    const line = text.split(/\n+/).find(row => row.startsWith('0::'))
    if (!line) return fallback
    const relative = line.slice('0::'.length).trim()
    const normalized = relative === '/' ? '' : relative.replace(/^\/+/, '')
    const candidate = path.join(fallback, normalized)
    if (fs.existsSync(candidate)) return candidate
  } catch {}
  return fallback
}

function readNumberFile (file) {
  try {
    const n = Number(fs.readFileSync(file, 'utf8').trim())
    return Number.isFinite(n) ? n : null
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
      if (key && Number.isFinite(n)) out[key] = n
    }
    return out
  } catch {
    return null
  }
}

function readMemoryStats () {
  const mem = process.memoryUsage()
  const base = resolveCgroupV2Base()
  const stat = readKeyValueFile(path.join(base, 'memory.stat')) || {}
  return {
    rss: mem.rss,
    heapUsed: mem.heapUsed,
    heapTotal: mem.heapTotal,
    external: mem.external,
    cgroupCurrent: readNumberFile(path.join(base, 'memory.current')),
    cgroupPeak: readNumberFile(path.join(base, 'memory.peak')),
    cgroupAnon: stat.anon,
    cgroupFile: stat.file,
    cgroupKernel: stat.kernel,
    cgroupFileDirty: stat.file_dirty,
    cgroupInactiveFile: stat.inactive_file,
    cgroupActiveFile: stat.active_file
  }
}

function formatBytes (value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'n/a'
  return `${(value / 1024 / 1024).toFixed(1)}MB`
}

function logMemory (label, memory) {
  const stats = readMemoryStats()
  memory.push({ label, ...stats })
  console.log(`[mem] ${label}: rss=${formatBytes(stats.rss)} heapUsed=${formatBytes(stats.heapUsed)} cgroupCurrent=${formatBytes(stats.cgroupCurrent)} cgroupPeak=${formatBytes(stats.cgroupPeak)} cgroupFile=${formatBytes(stats.cgroupFile)} cgroupAnon=${formatBytes(stats.cgroupAnon)} dirty=${formatBytes(stats.cgroupFileDirty)}`)
}

function fileSize (file) {
  try { return fs.statSync(file).size } catch { return 0 }
}

function getCount (db, sql) {
  const row = db.prepare(sql).get()
  return Number(row.count || 0)
}

function rewriteNodes (db, args, report, memory) {
  const totalAvailable = getCount(db, 'SELECT COUNT(*) AS count FROM nodes_v2')
  const target = args.nodeLimit === 0 ? totalAvailable : Math.min(args.nodeLimit, totalAvailable)
  const select = db.prepare(`
    SELECT n.node_id, n.node_json_compressed,
      r.stable, r.delay, r.country, r.owner, r.source, r.updated_at, r.next_check_at, r.failure_streak, r.tag
    FROM nodes_v2 n
    JOIN node_runtime_v2 r ON r.node_id = n.node_id
    WHERE n.node_id > ?
    ORDER BY n.node_id
    LIMIT ?
  `)
  const updateNode = db.prepare('UPDATE nodes_v2 SET node_json_compressed = ? WHERE node_id = ?')
  const updateRuntime = db.prepare(`
    UPDATE node_runtime_v2
    SET stable = ?, delay = ?, country = ?, owner = ?, source = ?, updated_at = ?, next_check_at = ?, failure_streak = ?, tag = ?
    WHERE node_id = ?
  `)
  const tx = db.transaction((rows) => {
    for (const row of rows) {
      const json = zlib.inflateRawSync(row.node_json_compressed)
      const compressed = zlib.deflateRawSync(json, { level: args.compressionLevel })
      updateNode.run(compressed, row.node_id)
      updateRuntime.run(
        row.stable || 0,
        row.delay === null || row.delay === undefined ? null : Math.round(Number(row.delay)),
        row.country,
        row.owner,
        row.source,
        row.updated_at,
        row.next_check_at,
        row.failure_streak || 0,
        row.tag,
        row.node_id
      )
      report.nodeRewrite.inflatedBytes += json.length
      report.nodeRewrite.compressedBytes += compressed.length
    }
  })

  let lastNodeId = 0
  let processed = 0
  const start = Date.now()
  while (processed < target) {
    const limit = Math.min(args.batchSize, target - processed)
    const rows = select.all(lastNodeId, limit)
    if (rows.length === 0) break
    tx(rows)
    processed += rows.length
    lastNodeId = rows[rows.length - 1].node_id
    if (processed % (args.batchSize * 10) === 0 || processed >= target) {
      console.log(`[stage2-write] nodes rewritten=${processed}/${target}`)
      logMemory(`after-node-rewrite-${processed}`, memory)
    }
  }
  report.nodeRewrite.rows = processed
  report.nodeRewrite.ms = Date.now() - start
  console.log(`[stage2-write] nodes done rows=${processed} ms=${report.nodeRewrite.ms} inflated=${formatBytes(report.nodeRewrite.inflatedBytes)} compressed=${formatBytes(report.nodeRewrite.compressedBytes)}`)
}

function rewriteRefs (db, args, report, memory) {
  const totalAvailable = getCount(db, 'SELECT COUNT(*) AS count FROM subscription_node_refs_v2')
  const target = args.refLimit === 0 ? totalAvailable : Math.min(args.refLimit, totalAvailable)
  db.exec(`
    DROP TABLE IF EXISTS stage2_ref_rewrite_tmp;
    CREATE TEMP TABLE stage2_ref_rewrite_tmp (
      subscription_id INTEGER NOT NULL,
      node_id INTEGER NOT NULL,
      last_seen_stage2_at INTEGER,
      PRIMARY KEY(subscription_id, node_id)
    ) WITHOUT ROWID;
  `)
  const select = db.prepare(`
    SELECT subscription_id, node_id, last_seen_stage2_at
    FROM subscription_node_refs_v2
    WHERE subscription_id > ?
       OR (subscription_id = ? AND node_id > ?)
    ORDER BY subscription_id, node_id
    LIMIT ?
  `)
  const insertTmp = db.prepare('INSERT OR IGNORE INTO stage2_ref_rewrite_tmp (subscription_id, node_id, last_seen_stage2_at) VALUES (?, ?, ?)')
  const txLoad = db.transaction((rows) => {
    for (const row of rows) insertTmp.run(row.subscription_id, row.node_id, row.last_seen_stage2_at)
  })

  let loaded = 0
  let lastSubscriptionId = 0
  let lastNodeId = 0
  const start = Date.now()
  while (loaded < target) {
    const limit = Math.min(args.batchSize, target - loaded)
    const rows = select.all(lastSubscriptionId, lastSubscriptionId, lastNodeId, limit)
    if (rows.length === 0) break
    txLoad(rows)
    loaded += rows.length
    const last = rows[rows.length - 1]
    lastSubscriptionId = last.subscription_id
    lastNodeId = last.node_id
    if (loaded % (args.batchSize * 10) === 0 || loaded >= target) {
      console.log(`[stage2-write] refs staged=${loaded}/${target}`)
      logMemory(`after-ref-stage-${loaded}`, memory)
    }
  }

  const deleteInsert = db.transaction(() => {
    db.prepare(`
      DELETE FROM subscription_node_refs_v2
      WHERE EXISTS (
        SELECT 1 FROM stage2_ref_rewrite_tmp t
        WHERE t.subscription_id = subscription_node_refs_v2.subscription_id
          AND t.node_id = subscription_node_refs_v2.node_id
      )
    `).run()
    db.prepare(`
      INSERT INTO subscription_node_refs_v2 (subscription_id, node_id, last_seen_stage2_at)
      SELECT subscription_id, node_id, last_seen_stage2_at
      FROM stage2_ref_rewrite_tmp
      ORDER BY subscription_id, node_id
    `).run()
  })
  deleteInsert()
  report.refRewrite.rows = loaded
  report.refRewrite.ms = Date.now() - start
  console.log(`[stage2-write] refs done rows=${loaded} ms=${report.refRewrite.ms}`)
  logMemory('after-ref-rewrite-commit', memory)
  db.exec('DROP TABLE IF EXISTS stage2_ref_rewrite_tmp')
}

function checkpointAndOptimize (db, memory) {
  try {
    db.pragma('wal_checkpoint(TRUNCATE)')
  } catch (error) {
    console.warn(`[warn] wal_checkpoint failed: ${error.message}`)
  }
  logMemory('after-wal-checkpoint', memory)
  try {
    db.pragma('optimize')
  } catch (error) {
    console.warn(`[warn] optimize failed: ${error.message}`)
  }
  logMemory('after-optimize', memory)
}

function collectDbstat (db) {
  return db.prepare(`
    SELECT name, SUM(pgsize) AS bytes
    FROM dbstat
    GROUP BY name
    ORDER BY bytes DESC
  `).all().map(row => ({ name: row.name, mb: +(row.bytes / 1024 / 1024).toFixed(3) }))
}

function main () {
  const args = parseArgs(process.argv)
  prepareWritableCopy(args)
  const memory = []
  const report = {
    args,
    nodeRewrite: { rows: 0, ms: 0, inflatedBytes: 0, compressedBytes: 0 },
    refRewrite: { rows: 0, ms: 0 },
    files: {},
    memory,
    dbstat: null,
    startedAt: new Date().toISOString()
  }

  console.log(`[stage2-write] input=${args.input}`)
  console.log(`[stage2-write] output=${args.output}`)
  console.log(`[stage2-write] copiedFileSize=${formatBytes(fileSize(args.output))} nodeLimit=${args.nodeLimit} refLimit=${args.refLimit} batchSize=${args.batchSize}`)
  logMemory('after-copy', memory)

  const db = new Database(args.output)
  applyPragmas(db)
  logMemory('after-open-db', memory)

  rewriteNodes(db, args, report, memory)
  rewriteRefs(db, args, report, memory)
  checkpointAndOptimize(db, memory)

  report.files.fileSize = fileSize(args.output)
  report.files.walSize = fileSize(`${args.output}-wal`)
  report.files.shmSize = fileSize(`${args.output}-shm`)
  console.log(`[stage2-write] files main=${formatBytes(report.files.fileSize)} wal=${formatBytes(report.files.walSize)} shm=${formatBytes(report.files.shmSize)}`)

  if (!args.skipDbstat) {
    report.dbstat = collectDbstat(db)
    console.log('[stage2-write] dbstatTop=' + JSON.stringify(report.dbstat.slice(0, 8)))
    logMemory('after-dbstat', memory)
  }

  db.close()
  logMemory('after-close', memory)
  report.finishedAt = new Date().toISOString()

  const reportPath = path.join(args.outputDir, `stage2-write-report.${path.basename(args.output)}.json`)
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2))
  console.log(`[report] ${reportPath}`)
}

main()
