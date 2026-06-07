#!/usr/bin/env node

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Database = require('better-sqlite3')
const cache = require('../src/modules/plugin/xray/cache')

function parseArgs (argv) {
  const args = {
    cache: path.join(os.homedir(), '.dev-sidecar', 'xray', 'nodes_cache.sqlite'),
    batchLimit: 5000,
    maxRowsPerRound: 50000,
    lowFileCache: true,
    backup: true,
    retire: true,
    compact: true,
    forceCompact: true,
    dryRun: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = () => argv[++index]

    if (arg === '--cache') {
      args.cache = path.resolve(next())
    } else if (arg === '--batch-limit') {
      args.batchLimit = Math.max(1, Number(next()) || args.batchLimit)
    } else if (arg === '--max-rows-per-round') {
      args.maxRowsPerRound = Math.max(args.batchLimit, Number(next()) || args.maxRowsPerRound)
    } else if (arg === '--no-low-file-cache') {
      args.lowFileCache = false
    } else if (arg === '--no-backup') {
      args.backup = false
    } else if (arg === '--no-retire') {
      args.retire = false
    } else if (arg === '--no-compact') {
      args.compact = false
    } else if (arg === '--no-force-compact') {
      args.forceCompact = false
    } else if (arg === '--dry-run') {
      args.dryRun = true
    } else if (arg === '--help' || arg === '-h') {
      args.help = true
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  return args
}

function printHelp () {
  console.log(`Usage: node packages/core/scripts/xray-compact-cache-migrate-once.js [options]

One-time migration of the Xray node cache to compact v2 storage.

Options:
  --cache <path>             SQLite cache path (default: ~/.dev-sidecar/xray/nodes_cache.sqlite)
  --batch-limit <n>          Rows per migration batch (default: 5000)
  --max-rows-per-round <n>   Rows per migrateCompactV2Storage call (default: 50000)
  --no-low-file-cache        Do not apply low file-cache SQLite pragmas
  --no-backup                Do not create a timestamped .bak copy before writing
  --no-retire                Migrate to v2 but keep old wide tables
  --no-compact               Do not VACUUM after old table retirement
  --no-force-compact         Keep post_retire_compacted marker if already set
  --dry-run                  Print the plan and current cache size without writing
  -h, --help                 Show this help
`)
}

function fileSize (filePath) {
  try {
    return fs.statSync(filePath).size
  } catch {
    return 0
  }
}

function formatBytes (bytes) {
  const value = Number(bytes) || 0
  if (value >= 1024 * 1024 * 1024) {
    return `${(value / 1024 / 1024 / 1024).toFixed(2)}GB`
  }
  if (value >= 1024 * 1024) {
    return `${(value / 1024 / 1024).toFixed(2)}MB`
  }
  if (value >= 1024) {
    return `${(value / 1024).toFixed(2)}KB`
  }
  return `${value}B`
}

function createBackup (cachePath) {
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
  const backupPath = `${cachePath}.bak-compact-v2-${timestamp}`
  fs.copyFileSync(cachePath, backupPath)
  return backupPath
}

function logStep (message, details = null) {
  const suffix = details == null ? '' : ` ${JSON.stringify(details)}`
  console.log(`[xray-cache-migrate-once] ${message}${suffix}`)
}

function openReadonlyDb (cachePath) {
  return new Database(cachePath, {
    readonly: true,
    fileMustExist: true,
  })
}

function openWritableDb (cachePath) {
  return new Database(cachePath, {
    fileMustExist: true,
  })
}

function tableExists (db, tableName) {
  const row = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName)
  return !!row
}

function countRows (db, tableName) {
  if (!tableExists(db, tableName)) {
    return null
  }
  return Number(db.prepare(`SELECT COUNT(1) AS count FROM ${tableName}`).get().count) || 0
}

function readCacheState (cachePath) {
  const db = openReadonlyDb(cachePath)
  try {
    const tables = [
      'nodes',
      'node_runtime',
      'node_payload',
      'subscriptions',
      'subscription_node_refs',
      'nodes_v2',
      'node_identity_v2',
      'node_runtime_v2',
      'subscriptions_v2',
      'subscription_node_refs_v2',
    ]
    const counts = {}
    for (const table of tables) {
      counts[table] = countRows(db, table)
    }

    const meta = {}
    if (tableExists(db, 'cache_meta')) {
      for (const row of db.prepare('SELECT key, value FROM cache_meta ORDER BY key').all()) {
        if (/compact|retire|legacy/i.test(row.key)) {
          meta[row.key] = row.value
        }
      }
    }

    const pageCount = Number(db.pragma('page_count', { simple: true }) || 0)
    const freelistCount = Number(db.pragma('freelist_count', { simple: true }) || 0)
    const pageSize = Number(db.pragma('page_size', { simple: true }) || 0)
    return {
      size: formatBytes(fileSize(cachePath)),
      pageCount,
      freelistCount,
      pageSize,
      approxFreeBytes: formatBytes(freelistCount * pageSize),
      meta,
      counts,
    }
  } finally {
    db.close()
  }
}

function clearPostRetireCompactedMarker (cachePath) {
  const db = openWritableDb(cachePath)
  try {
    if (!tableExists(db, 'cache_meta')) {
      return false
    }
    const result = db.prepare("DELETE FROM cache_meta WHERE key = 'post_retire_compacted'").run()
    return result.changes > 0
  } finally {
    db.close()
  }
}

function run () {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printHelp()
    return 0
  }

  if (!fs.existsSync(args.cache)) {
    throw new Error(`Cache file does not exist: ${args.cache}`)
  }

  logStep('plan', {
    cache: args.cache,
    batchLimit: args.batchLimit,
    maxRowsPerRound: args.maxRowsPerRound,
    lowFileCache: args.lowFileCache,
    backup: args.backup,
    retire: args.retire,
    compact: args.compact,
    forceCompact: args.forceCompact,
    dryRun: args.dryRun,
    size: formatBytes(fileSize(args.cache)),
  })
  logStep('state-before', readCacheState(args.cache))

  if (args.dryRun) {
    return 0
  }

  let backupPath = null
  if (args.backup) {
    backupPath = createBackup(args.cache)
    logStep('backup-created', {
      path: backupPath,
      size: formatBytes(fileSize(backupPath)),
    })
  }

  let totalMigrated = 0
  let round = 0
  while (true) {
    round += 1
    const result = cache.migrateCompactV2Storage(args.cache, {
      batchLimit: args.batchLimit,
      maxRows: args.maxRowsPerRound,
      lowFileCache: args.lowFileCache,
    })

    if (!result) {
      throw new Error('Migration returned no result')
    }

    totalMigrated += Number(result.migratedRows) || 0
    logStep('migration-round', {
      round,
      migratedRows: result.migratedRows,
      totalMigrated,
      pending: result.pending,
      compactV2Count: result.compactV2Count,
      legacyCount: result.legacyCount,
      subscriptions: result.subscriptions,
      refs: result.refs,
    })

    if (result.error) {
      throw new Error(`Migration failed: ${result.error}`)
    }

    if (!result.pending) {
      break
    }
    if (!result.migratedRows) {
      throw new Error('Migration is still pending but no rows were migrated in this round')
    }
  }

  if (args.retire) {
    const retired = cache.retireCompactV2LegacyStorage(args.cache, {
      lowFileCache: args.lowFileCache,
    })
    logStep('retire-result', retired)
    if (!retired || retired.pending || retired.retired !== true) {
      throw new Error('Compact v2 legacy storage retirement did not complete')
    }
  }

  logStep('state-after-retire', readCacheState(args.cache))

  if (args.compact && args.retire) {
    if (args.forceCompact) {
      const markerCleared = clearPostRetireCompactedMarker(args.cache)
      logStep('force-compact-marker-cleared', { markerCleared })
    }
    const compacted = cache.compactRetiredSqliteCache(args.cache, {
      lowFileCache: args.lowFileCache,
    })
    logStep('compact-result', compacted)
    if (!compacted || compacted.pending || compacted.compacted !== true) {
      throw new Error('Post-retirement SQLite compaction did not complete')
    }
  }

  const finalCount = cache.countCacheEntries(args.cache)
  logStep('done', {
    cache: args.cache,
    backup: backupPath,
    totalMigrated,
    finalCount,
    finalSize: formatBytes(fileSize(args.cache)),
    finalState: readCacheState(args.cache),
  })
  return 0
}

try {
  process.exitCode = run()
} catch (error) {
  console.error(`[xray-cache-migrate-once] failed: ${error && error.stack ? error.stack : error}`)
  process.exitCode = 1
}
