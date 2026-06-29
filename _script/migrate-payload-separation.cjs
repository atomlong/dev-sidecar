#!/usr/bin/env node
/**
 * One-time migration: separate payload tables (nodes_v2, node_identity_v2)
 * from the main cache DB into a standalone nodes_payload.sqlite file.
 *
 * Usage:
 *   node _script/migrate-payload-separation.js [path/to/nodes_cache.sqlite]
 *
 * Default path: ~/.dev-sidecar/xray/nodes_cache.sqlite
 *
 * MUST be run while dev-sidecar service is stopped.
 * The script:
 *   1. Checkpoints WAL into the main DB.
 *   2. Creates nodes_payload.sqlite next to the main DB.
 *   3. Copies nodes_v2 + node_identity_v2 (with indexes) into the payload DB.
 *   4. Verifies row counts match.
 *   5. Drops nodes_v2 + node_identity_v2 from the main DB.
 *   6. VACUUMs the main DB to reclaim ~600MB.
 *   7. Sets cache_meta payload_separated = 1 in the main DB.
 */

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

let Database = null
try {
  Database = require('better-sqlite3')
} catch (e) {
  console.error('ERROR: better-sqlite3 is required. Run from the dev-sidecar workspace.')
  console.error(e.message)
  process.exit(1)
}

function resolveCachePath () {
  const arg = process.argv[2]
  if (arg) {
    return path.resolve(arg)
  }
  return path.join(os.homedir(), '.dev-sidecar', 'xray', 'nodes_cache.sqlite')
}

function fmtBytes (n) {
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${n} B`
}

function fileExists (p) {
  try {
    return fs.existsSync(p)
  } catch {
    return false
  }
}

function main () {
  const cachePath = resolveCachePath()
  const payloadPath = path.join(path.dirname(cachePath), 'nodes_payload.sqlite')

  console.log(`Main DB:   ${cachePath}`)
  console.log(`Payload DB: ${payloadPath}`)

  if (!fileExists(cachePath)) {
    console.error(`ERROR: main DB not found: ${cachePath}`)
    process.exit(1)
  }

  if (fileExists(payloadPath)) {
    console.error(`ERROR: payload DB already exists: ${payloadPath}`)
    console.error('If you want to re-run migration, delete the payload DB first.')
    process.exit(1)
  }

  const sizeBefore = fs.statSync(cachePath).size
  console.log(`Main DB size before: ${fmtBytes(sizeBefore)}`)

  let db = null
  try {
    db = new Database(cachePath)
    db.pragma('journal_mode = WAL')

    // Step 1: checkpoint WAL
    console.log('\n[1/7] Checkpointing WAL...')
    db.pragma('wal_checkpoint(TRUNCATE)')

    // Verify payload tables exist in main DB
    const hasNodesV2 = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='nodes_v2' LIMIT 1").get()
    const hasIdentityV2 = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='node_identity_v2' LIMIT 1").get()

    if (!hasNodesV2) {
      console.error('ERROR: nodes_v2 table not found in main DB. Already migrated?')
      process.exit(1)
    }

    const nodesCount = db.prepare('SELECT COUNT(*) AS c FROM nodes_v2').get().c
    const identityCount = hasIdentityV2
      ? db.prepare('SELECT COUNT(*) AS c FROM node_identity_v2').get().c
      : 0
    console.log(`  nodes_v2 rows: ${nodesCount}`)
    console.log(`  node_identity_v2 rows: ${identityCount}`)

    // Step 2: create payload DB
    console.log('\n[2/7] Creating payload DB...')
    db.exec(`ATTACH DATABASE '${payloadPath}' AS payload`)

    // Create schema in payload DB
    db.exec(`
      CREATE TABLE payload.nodes_v2 (
        node_id INTEGER PRIMARY KEY,
        fingerprint_hash16 BLOB NOT NULL,
        node_key_hash16 BLOB NOT NULL,
        collision_suffix INTEGER NOT NULL DEFAULT 0,
        node_json_compressed BLOB NOT NULL,
        UNIQUE(fingerprint_hash16, collision_suffix),
        UNIQUE(node_key_hash16, collision_suffix)
      );
    `)
    db.exec(`
      CREATE TABLE payload.node_identity_v2 (
        node_id INTEGER PRIMARY KEY,
        fingerprint_sha256 BLOB UNIQUE NOT NULL,
        node_key_sha256 BLOB UNIQUE NOT NULL
      );
    `)

    // Step 3: copy data in batches
    const BATCH = 5000
    console.log('\n[3/7] Copying nodes_v2...')
    let copiedNodes = 0
    let offset = 0
    while (true) {
      const rows = db.prepare(`SELECT node_id, fingerprint_hash16, node_key_hash16, collision_suffix, node_json_compressed FROM nodes_v2 ORDER BY node_id LIMIT ? OFFSET ?`).all(BATCH, offset)
      if (rows.length === 0) break
      const insert = db.prepare(`INSERT INTO payload.nodes_v2 (node_id, fingerprint_hash16, node_key_hash16, collision_suffix, node_json_compressed) VALUES (?, ?, ?, ?, ?)`)
      const tx = db.transaction((batch) => {
        for (const r of batch) {
          insert.run(r.node_id, r.fingerprint_hash16, r.node_key_hash16, r.collision_suffix, r.node_json_compressed)
        }
      })
      tx(rows)
      copiedNodes += rows.length
      offset += rows.length
      if (copiedNodes % 50000 === 0 || rows.length < BATCH) {
        console.log(`  copied ${copiedNodes}/${nodesCount} nodes...`)
      }
      if (rows.length < BATCH) break
    }

    if (hasIdentityV2) {
      console.log('Copying node_identity_v2...')
      let copiedIdentity = 0
      offset = 0
      while (true) {
        const rows = db.prepare(`SELECT node_id, fingerprint_sha256, node_key_sha256 FROM node_identity_v2 ORDER BY node_id LIMIT ? OFFSET ?`).all(BATCH, offset)
        if (rows.length === 0) break
        const insert = db.prepare(`INSERT INTO payload.node_identity_v2 (node_id, fingerprint_sha256, node_key_sha256) VALUES (?, ?, ?)`)
        const tx = db.transaction((batch) => {
          for (const r of batch) {
            insert.run(r.node_id, r.fingerprint_sha256, r.node_key_sha256)
          }
        })
        tx(rows)
        copiedIdentity += rows.length
        offset += rows.length
        if (copiedIdentity % 50000 === 0 || rows.length < BATCH) {
          console.log(`  copied ${copiedIdentity}/${identityCount} identity rows...`)
        }
        if (rows.length < BATCH) break
      }
    }

    // Step 4: verify row counts
    console.log('\n[4/7] Verifying row counts...')
    const payloadNodesCount = db.prepare('SELECT COUNT(*) AS c FROM payload.nodes_v2').get().c
    const payloadIdentityCount = hasIdentityV2
      ? db.prepare('SELECT COUNT(*) AS c FROM payload.node_identity_v2').get().c
      : 0

    if (payloadNodesCount !== nodesCount) {
      console.error(`ERROR: nodes_v2 count mismatch: main=${nodesCount}, payload=${payloadNodesCount}`)
      console.error('Aborting before DROP. Payload DB left intact for inspection.')
      db.exec('DETACH DATABASE payload')
      process.exit(1)
    }
    if (hasIdentityV2 && payloadIdentityCount !== identityCount) {
      console.error(`ERROR: node_identity_v2 count mismatch: main=${identityCount}, payload=${payloadIdentityCount}`)
      console.error('Aborting before DROP. Payload DB left intact for inspection.')
      db.exec('DETACH DATABASE payload')
      process.exit(1)
    }
    console.log(`  nodes_v2: ${nodesCount} == ${payloadNodesCount} OK`)
    console.log(`  node_identity_v2: ${identityCount} == ${payloadIdentityCount} OK`)

    // Step 5: drop payload tables from main DB
    console.log('\n[5/7] Dropping payload tables from main DB...')
    db.exec('DROP TABLE nodes_v2')
    if (hasIdentityV2) {
      db.exec('DROP TABLE node_identity_v2')
    }

    // Detach payload before vacuuming main
    db.exec('DETACH DATABASE payload')

    // Step 6: VACUUM main DB
    console.log('\n[6/7] VACUUMing main DB...')
    db.pragma('journal_mode = DELETE')
    db.exec('VACUUM')
    db.pragma('journal_mode = WAL')

    // Step 7: set cache_meta flag
    console.log('\n[7/7] Setting cache_meta payload_separated = 1...')
    db.prepare('INSERT OR REPLACE INTO cache_meta (key, value) VALUES (?, ?)').run('payload_separated', '1')

    const sizeAfter = fs.statSync(cachePath).size
    const sizePayload = fs.statSync(payloadPath).size
    console.log('\n=== Migration complete ===')
    console.log(`Main DB size:    ${fmtBytes(sizeBefore)} -> ${fmtBytes(sizeAfter)} (freed ${fmtBytes(sizeBefore - sizeAfter)})`)
    console.log(`Payload DB size: ${fmtBytes(sizePayload)}`)
    console.log(`\nMain DB now contains only runtime tables (~${fmtBytes(sizeAfter)})`)
    console.log(`Payload DB contains nodes_v2 + node_identity_v2 (~${fmtBytes(sizePayload)})`)
  } catch (e) {
    console.error('\nFATAL:', e.message)
    console.error(e.stack)
    process.exit(1)
  } finally {
    if (db) {
      try { db.close() } catch { /* ignore */ }
    }
  }
}

main()
