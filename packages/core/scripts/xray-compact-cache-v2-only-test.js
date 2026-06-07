#!/usr/bin/env node
'use strict'

const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const Database = require('better-sqlite3')

function parseArgs (argv) {
  const args = {
    input: '/tmp/dev-sidecar-xray-cache-prototype/nodes_cache_v2.hash16.level1.prototype.sqlite',
    stage3Limit: 10000,
    payloadScanLimit: 0,
    repeat: 1,
    skipCounts: false,
    skipDbstat: false
  }
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--input=')) {
      args.input = path.resolve(arg.slice('--input='.length))
    } else if (arg.startsWith('--stage3-limit=')) {
      args.stage3Limit = Number(arg.slice('--stage3-limit='.length))
    } else if (arg.startsWith('--payload-scan-limit=')) {
      args.payloadScanLimit = Number(arg.slice('--payload-scan-limit='.length))
    } else if (arg.startsWith('--repeat=')) {
      args.repeat = Number(arg.slice('--repeat='.length))
    } else if (arg === '--skip-counts') {
      args.skipCounts = true
    } else if (arg === '--skip-dbstat') {
      args.skipDbstat = true
    } else if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  if (!Number.isInteger(args.stage3Limit) || args.stage3Limit < 0) throw new Error('--stage3-limit must be a non-negative integer')
  if (!Number.isInteger(args.payloadScanLimit) || args.payloadScanLimit < 0) throw new Error('--payload-scan-limit must be a non-negative integer')
  if (!Number.isInteger(args.repeat) || args.repeat <= 0) throw new Error('--repeat must be a positive integer')
  return args
}

function printHelp () {
  console.log(`Usage: node packages/core/scripts/xray-compact-cache-v2-only-test.js [options]\n\nOptions:\n  --input=<path>                 Prototype v2 DB path\n  --stage3-limit=<n>             Rows per Stage3 due query simulation, default 10000\n  --payload-scan-limit=<n>       Optional sequential payload scan/decompress limit, default 0\n  --repeat=<n>                   Repeat query simulation, default 1\n  --skip-counts                  Skip COUNT(*) checks before Stage3 simulation\n  --skip-dbstat                  Skip dbstat query before Stage3 simulation\n`)
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

function main () {
  const args = parseArgs(process.argv)
  if (!fs.existsSync(args.input)) throw new Error(`v2 DB not found: ${args.input}`)
  const memory = []
  console.log(`[v2-only] input=${args.input}`)
  console.log(`[v2-only] fileSize=${formatBytes(fileSize(args.input))} stage3Limit=${args.stage3Limit} payloadScanLimit=${args.payloadScanLimit} repeat=${args.repeat}`)
  logMemory('start', memory)

  const db = new Database(args.input, { readonly: true, fileMustExist: true })
  db.pragma('mmap_size = 0')
  db.pragma('cache_size = -2000')
  logMemory('after-open-v2-db', memory)

  let counts = null
  if (!args.skipCounts) {
    counts = {
      subscriptions: db.prepare('SELECT COUNT(*) AS count FROM subscriptions_v2').get().count,
      nodes: db.prepare('SELECT COUNT(*) AS count FROM nodes_v2').get().count,
      runtime: db.prepare('SELECT COUNT(*) AS count FROM node_runtime_v2').get().count,
      refs: db.prepare('SELECT COUNT(*) AS count FROM subscription_node_refs_v2').get().count
    }
    console.log('[v2-only] counts=' + JSON.stringify(counts))
    logMemory('after-counts', memory)
  } else {
    console.log('[v2-only] counts skipped')
  }

  if (!args.skipDbstat) {
    const dbstat = db.prepare(`
      SELECT name, SUM(pgsize) AS bytes
      FROM dbstat
      GROUP BY name
      ORDER BY bytes DESC
    `).all()
    console.log('[v2-only] dbstatTop=' + JSON.stringify(dbstat.slice(0, 8).map(row => ({ name: row.name, mb: +(row.bytes / 1024 / 1024).toFixed(3) }))))
    logMemory('after-dbstat', memory)
  } else {
    console.log('[v2-only] dbstat skipped')
  }

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
  console.log('[stage3] plan=' + JSON.stringify(plan))

  const stage3 = db.prepare(`
    SELECT r.node_id, n.node_json_compressed, r.stable, r.delay, r.next_check_at
    FROM node_runtime_v2 r
    JOIN nodes_v2 n ON n.node_id = r.node_id
    WHERE r.next_check_at IS NOT NULL
      AND r.next_check_at <= ?
    ORDER BY r.next_check_at ASC
    LIMIT ?
  `)
  for (let i = 0; i < args.repeat; i++) {
    const start = Date.now()
    const rows = stage3.all(now, args.stage3Limit)
    let inflated = 0
    for (const row of rows) inflated += zlib.inflateRawSync(row.node_json_compressed).length
    console.log(`[stage3] repeat=${i + 1}/${args.repeat} rows=${rows.length} ms=${Date.now() - start} inflated=${formatBytes(inflated)}`)
    logMemory(`after-stage3-repeat-${i + 1}`, memory)
  }

  if (args.payloadScanLimit > 0) {
    const start = Date.now()
    const rows = db.prepare('SELECT node_json_compressed FROM nodes_v2 ORDER BY node_id LIMIT ?').all(args.payloadScanLimit)
    let inflated = 0
    for (const row of rows) inflated += zlib.inflateRawSync(row.node_json_compressed).length
    console.log(`[payload-scan] rows=${rows.length} ms=${Date.now() - start} inflated=${formatBytes(inflated)}`)
    logMemory('after-payload-scan', memory)
  }

  db.close()
  logMemory('after-close', memory)

  const reportPath = path.join(path.dirname(args.input), `v2-only-report.${path.basename(args.input)}.json`)
  fs.writeFileSync(reportPath, JSON.stringify({ args, counts, plan, memory, finishedAt: new Date().toISOString() }, null, 2))
  console.log(`[report] ${reportPath}`)
}

main()
