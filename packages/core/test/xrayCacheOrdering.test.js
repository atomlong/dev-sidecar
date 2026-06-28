const assert = require('node:assert')
const fs = require('node:fs')
const crypto = require('node:crypto')
const os = require('node:os')
const path = require('node:path')
const xrayCache = require('../src/modules/plugin/xray/cache')

let sqliteAvailable = true
let BetterSqlite3 = null
try {
  BetterSqlite3 = require('better-sqlite3')
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-sidecar-xray-cache-probe-'))
  const probePath = path.join(probeDir, 'probe.sqlite')
  try {
    xrayCache.writeCache(probePath, [])
  } finally {
    fs.rmSync(probeDir, { recursive: true, force: true })
  }
} catch {
  sqliteAvailable = false
}

function createNode (address, port) {
  return {
    protocol: 'socks',
    settings: {
      servers: [
        {
          address,
          port,
        },
      ],
    },
  }
}

function createNodeKeyForTest (fingerprint) {
  return crypto.createHash('sha256').update(String(fingerprint || '')).digest('hex').slice(0, 32)
}

// eslint-disable-next-line no-undef
describe('xray cache ordering', () => {
  // eslint-disable-next-line no-undef
  it('orders refresh by oldest updatedAt and default by stable then delay', () => {
    if (!sqliteAvailable) {
      return
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-sidecar-xray-cache-'))
    const cachePath = path.join(tmpDir, 'nodes_cache.sqlite')

    try {
      xrayCache.writeCache(cachePath, [
        {
          node: createNode('1.1.1.1', 80),
          stable: false,
          delay: 300,
          source: 'source-sync',
          updatedAt: '2026-05-10T00:00:00.000+08:00',
          nextCheckAt: '2026-05-10T00:00:00.000+08:00',
        },
        {
          node: createNode('2.2.2.2', 80),
          stable: false,
          delay: 200,
          source: 'source-sync',
          updatedAt: '2026-05-09T00:00:00.000+08:00',
          nextCheckAt: '2026-05-09T00:00:00.000+08:00',
        },
        {
          node: createNode('3.3.3.3', 80),
          stable: true,
          delay: 100,
          source: 'background-probe',
          updatedAt: '2026-05-11T00:00:00.000+08:00',
          nextCheckAt: '2026-05-10T11:00:00.000+08:00',
        },
      ])

      const entries = xrayCache.readCacheEntries(cachePath)
      const addresses = entries.map(entry => entry.node.settings.servers[0].address)
      assert.deepStrictEqual(addresses, ['3.3.3.3', '2.2.2.2', '1.1.1.1'])

      const refreshEntries = xrayCache.readCacheEntries(cachePath, { orderBy: 'refresh' })
      const refreshAddresses = refreshEntries.map(entry => entry.node.settings.servers[0].address)
      assert.deepStrictEqual(refreshAddresses, ['2.2.2.2', '1.1.1.1', '3.3.3.3'])

      const dueBefore = xrayCache.formatLocalTimestamp('2026-05-10T12:00:00.000+08:00')
      const dueEntries = xrayCache.readCacheEntries(cachePath, {
        orderBy: 'due',
        dueBefore,
      })
      const dueAddresses = dueEntries.map(entry => entry.node.settings.servers[0].address)
      assert.deepStrictEqual(dueAddresses, ['2.2.2.2', '1.1.1.1', '3.3.3.3'])
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  // eslint-disable-next-line no-undef
  it('orders due nodes by nextCheckAt and preserves failure metadata', () => {
    if (!sqliteAvailable) {
      return
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-sidecar-xray-cache-due-'))
    const cachePath = path.join(tmpDir, 'nodes_cache.sqlite')

    try {
      xrayCache.writeCache(cachePath, [
        {
          node: createNode('1.1.1.1', 80),
          stable: true,
          delay: 100,
          source: 'background-probe',
          updatedAt: '2026-05-11T00:00:00.000+08:00',
          nextCheckAt: '2026-05-12T00:00:00.000+08:00',
          failureStreak: 0,
        },
        {
          node: createNode('2.2.2.2', 80),
          stable: false,
          delay: null,
          source: 'background-probe',
          updatedAt: '2026-05-11T00:00:00.000+08:00',
          nextCheckAt: '2026-05-09T00:00:00.000+08:00',
          failureStreak: 2,
        },
        {
          node: createNode('3.3.3.3', 80),
          stable: false,
          delay: 200,
          source: 'source-sync',
          updatedAt: '2026-05-11T00:00:00.000+08:00',
          nextCheckAt: '2026-05-08T00:00:00.000+08:00',
          failureStreak: 0,
        },
      ])

      const dueBefore = xrayCache.formatLocalTimestamp('2026-05-10T12:00:00.000+08:00')
      const dueEntries = xrayCache.readCacheEntries(cachePath, {
        orderBy: 'due',
        dueBefore,
      })
      const dueAddresses = dueEntries.map(entry => entry.node.settings.servers[0].address)
      assert.deepStrictEqual(dueAddresses, ['3.3.3.3', '2.2.2.2'])
      assert.strictEqual(dueEntries[0].failureStreak, 0)
      assert.strictEqual(dueEntries[1].failureStreak, 2)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  // eslint-disable-next-line no-undef
  it('writes compact v2 cache and reads Stage3 due entries from v2', () => {
    if (!sqliteAvailable) {
      return
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-sidecar-xray-cache-v2-'))
    const cachePath = path.join(tmpDir, 'nodes_cache.sqlite')

    try {
      xrayCache.writeCache(cachePath, [
        {
          node: createNode('4.4.4.4', 80),
          stable: true,
          delay: 40,
          source: 'source-sync',
          updatedAt: '2026-05-11T00:00:00.000+08:00',
          nextCheckAt: '2026-05-09T00:00:00.000+08:00',
          failureStreak: 0,
        },
        {
          node: createNode('5.5.5.5', 80),
          stable: false,
          delay: 50,
          source: 'source-sync',
          updatedAt: '2026-05-11T00:00:00.000+08:00',
          nextCheckAt: '2026-05-08T00:00:00.000+08:00',
          failureStreak: 3,
        },
      ])

      const dueBefore = xrayCache.formatLocalTimestamp('2026-05-10T12:00:00.000+08:00')
      const db = new BetterSqlite3(cachePath, { readonly: true })
      try {
        assert.strictEqual(db.prepare('SELECT COUNT(*) AS count FROM nodes_v2').get().count, 2)
        assert.strictEqual(db.prepare('SELECT COUNT(*) AS count FROM node_identity_v2').get().count, 2)
        assert.strictEqual(db.prepare('SELECT COUNT(*) AS count FROM node_runtime_v2').get().count, 2)
        const storedNode = db.prepare('SELECT node_json_compressed FROM nodes_v2 LIMIT 1').get()
        assert(Buffer.isBuffer(storedNode.node_json_compressed))
      } finally {
        db.close()
      }

      const rowIds = xrayCache.readCacheRowIds(cachePath, {
        orderBy: 'due',
        dueBefore,
      })
      assert.strictEqual(rowIds.length, 2)

      const dueEntries = xrayCache.readCacheEntriesByRowIds(cachePath, rowIds)
      const dueAddresses = dueEntries.map(entry => entry.node.settings.servers[0].address)
      assert.deepStrictEqual(dueAddresses, ['5.5.5.5', '4.4.4.4'])
      assert.strictEqual(dueEntries[0].failureStreak, 3)

      const entries = xrayCache.readCacheEntries(cachePath)
      assert.strictEqual(entries.length, 2)
      assert.strictEqual(xrayCache.countCacheEntries(cachePath), 2)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  // eslint-disable-next-line no-undef
  it('mirrors subscription refs into compact v2 without dropping nodes', () => {
    if (!sqliteAvailable) {
      return
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-sidecar-xray-cache-v2-refs-'))
    const cachePath = path.join(tmpDir, 'nodes_cache.sqlite')

    try {
      const nodes = [
        createNode('6.6.6.6', 80),
        createNode('7.7.7.7', 80),
        createNode('8.8.8.8', 80),
      ]
      xrayCache.writeCache(cachePath, nodes.map((node, index) => ({
        node,
        stable: index === 0,
        delay: 60 + index,
        source: 'source-sync',
        updatedAt: '2026-05-11T00:00:00.000+08:00',
        nextCheckAt: '2026-05-11T00:00:00.000+08:00',
      })))

      const firstNodeKeys = nodes.slice(0, 2).map(node => xrayCache.getNodeKey(node))
      const thirdNodeKey = xrayCache.getNodeKey(nodes[2])
      const sourceKey = xrayCache.getSubscriptionSourceKey('https://example.test/sub')

      const synced = xrayCache.syncSubscriptions(cachePath, [{
        url: 'https://example.test/sub',
        displayLabel: 'example-sub',
        nodeKeys: firstNodeKeys,
      }], { now: '2026-05-11T01:00:00.000+08:00' })
      assert.strictEqual(synced.configured, 1)
      assert.strictEqual(synced.refs, 2)

      const chunked = xrayCache.syncSubscriptionSourceChunk(cachePath, {
        sourceKey,
        displayLabel: 'example-sub',
      }, [firstNodeKeys[0], thirdNodeKey], {
        now: '2026-05-11T02:00:00.000+08:00',
        replaceExistingRefs: true,
      })
      assert.strictEqual(chunked.configured, 1)
      assert.strictEqual(chunked.refs, 2)

      const db = new BetterSqlite3(cachePath, { readonly: true })
      try {
        assert.strictEqual(db.prepare('SELECT COUNT(*) AS count FROM subscriptions_v2').get().count, 1)
        assert.strictEqual(db.prepare('SELECT COUNT(*) AS count FROM subscription_node_refs_v2').get().count, 2)
        const refAddresses = db.prepare(`
          SELECT n.node_json_compressed
          FROM subscription_node_refs_v2 r
          JOIN nodes_v2 n ON n.node_id = r.node_id
          ORDER BY r.node_id
        `).all()
        assert.strictEqual(refAddresses.length, 2)
        assert(refAddresses.every(row => Buffer.isBuffer(row.node_json_compressed)))
      } finally {
        db.close()
      }

      const entries = xrayCache.readCacheEntries(cachePath)
      const addresses = entries.map(entry => entry.node.settings.servers[0].address).sort()
      assert.deepStrictEqual(addresses, ['6.6.6.6', '7.7.7.7', '8.8.8.8'])
      assert.strictEqual(xrayCache.countCacheEntries(cachePath), 3)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  // eslint-disable-next-line no-undef
  it('migrates to compact v2 and retires old wide storage without losing nodes', () => {
    if (!sqliteAvailable) {
      return
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-sidecar-xray-cache-v2-retire-'))
    const cachePath = path.join(tmpDir, 'nodes_cache.sqlite')

    try {
      const nodes = [
        createNode('11.11.11.11', 80),
        createNode('12.12.12.12', 80),
        createNode('13.13.13.13', 80),
      ]
      xrayCache.writeCache(cachePath, nodes.map((node, index) => ({
        node,
        stable: index === 1,
        delay: 100 + index,
        source: 'source-sync',
        updatedAt: '2026-05-11T00:00:00.000+08:00',
        nextCheckAt: `2026-05-1${index + 1}T00:00:00.000+08:00`,
        failureStreak: index,
      })))

      const sourceKey = xrayCache.getSubscriptionSourceKey('https://example.test/retire')
      const nodeKeys = nodes.map(node => xrayCache.getNodeKey(node))
      xrayCache.syncSubscriptions(cachePath, [{
        url: 'https://example.test/retire',
        displayLabel: 'retire-sub',
        nodeKeys,
      }], { now: '2026-05-11T01:00:00.000+08:00' })

      let db = new BetterSqlite3(cachePath)
      try {
        db.exec(`
          DELETE FROM subscription_node_refs_v2;
          DELETE FROM subscriptions_v2;
          DELETE FROM node_runtime_v2;
          DELETE FROM node_identity_v2;
          DELETE FROM nodes_v2;
          UPDATE cache_meta SET value = '' WHERE key = 'compact_v2_migration_cursor';
        `)
        assert.strictEqual(db.prepare('SELECT COUNT(*) AS count FROM node_runtime').get().count, 3)
        assert.strictEqual(db.prepare('SELECT COUNT(*) AS count FROM nodes_v2').get().count, 0)
      } finally {
        db.close()
      }

      const firstBatch = xrayCache.migrateCompactV2Storage(cachePath, { batchLimit: 2, maxRows: 2 })
      assert.strictEqual(firstBatch.migratedRows, 2)
      assert.strictEqual(firstBatch.pending, true)

      const finalBatch = xrayCache.migrateCompactV2Storage(cachePath, { batchLimit: 2, maxRows: 10 })
      assert.strictEqual(finalBatch.pending, false)
      assert.strictEqual(finalBatch.compactV2Count, 3)
      assert.strictEqual(finalBatch.legacyCount, 3)
      assert.strictEqual(finalBatch.subscriptions, 1)
      assert.strictEqual(finalBatch.refs, 3)

      const retired = xrayCache.retireCompactV2LegacyStorage(cachePath)
      assert.strictEqual(retired.retired, true)
      assert.strictEqual(retired.pending, false)

      db = new BetterSqlite3(cachePath, { readonly: true })
      try {
        assert.strictEqual(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN ('nodes', 'node_runtime', 'node_payload', 'subscriptions', 'subscription_node_refs')").get().count, 0)
        assert.strictEqual(db.prepare('SELECT COUNT(*) AS count FROM nodes_v2').get().count, 3)
        assert.strictEqual(db.prepare('SELECT COUNT(*) AS count FROM subscription_node_refs_v2').get().count, 3)
      } finally {
        db.close()
      }

      const entries = xrayCache.readCacheEntries(cachePath)
      const addresses = entries.map(entry => entry.node.settings.servers[0].address).sort()
      assert.deepStrictEqual(addresses, ['11.11.11.11', '12.12.12.12', '13.13.13.13'])
      assert.strictEqual(xrayCache.countCacheEntries(cachePath), 3)

      const updated = xrayCache.writeCacheUpdates(cachePath, [{
        node: nodes[0],
        stable: true,
        delay: 10,
        source: 'background-probe',
        updatedAt: '2026-05-12T00:00:00.000+08:00',
        nextCheckAt: '2026-05-12T00:00:00.000+08:00',
        failureStreak: 0,
      }], [nodes[0]])
      assert.strictEqual(updated, true)

      const chunked = xrayCache.syncSubscriptionSourceChunk(cachePath, {
        sourceKey,
        displayLabel: 'retire-sub',
      }, [nodeKeys[0]], { replaceExistingRefs: true })
      assert.strictEqual(chunked.refs, 1)
      db = new BetterSqlite3(cachePath, { readonly: true })
      try {
        assert.strictEqual(db.prepare('SELECT COUNT(*) AS count FROM subscription_node_refs_v2').get().count, 1)
      } finally {
        db.close()
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  // eslint-disable-next-line no-undef
  it('keeps colliding hash16 compact v2 nodes via collision suffix fallback', () => {
    if (!sqliteAvailable) {
      return
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-sidecar-xray-cache-v2-collision-'))
    const cachePath = path.join(tmpDir, 'nodes_cache.sqlite')
    const forcedHash16 = Buffer.alloc(16, 7)

    xrayCache.setCompactV2IdentityFactoryForTest((fingerprint) => {
      const nodeKey = createNodeKeyForTest(fingerprint)
      return {
        nodeKey,
        fingerprintSha256: crypto.createHash('sha256').update(fingerprint).digest(),
        nodeKeySha256: crypto.createHash('sha256').update(nodeKey).digest(),
        fingerprintHash16: forcedHash16,
        nodeKeyHash16: forcedHash16,
      }
    })

    try {
      xrayCache.writeCache(cachePath, [
        {
          node: createNode('21.21.21.21', 80),
          stable: true,
          delay: 21,
          source: 'source-sync',
          updatedAt: '2026-05-11T00:00:00.000+08:00',
          nextCheckAt: '2026-05-11T00:00:00.000+08:00',
        },
        {
          node: createNode('22.22.22.22', 80),
          stable: false,
          delay: 22,
          source: 'source-sync',
          updatedAt: '2026-05-11T00:00:00.000+08:00',
          nextCheckAt: '2026-05-11T00:00:00.000+08:00',
        },
      ])

      const db = new BetterSqlite3(cachePath, { readonly: true })
      try {
        const suffixes = db.prepare('SELECT collision_suffix FROM nodes_v2 ORDER BY collision_suffix ASC').all().map(row => row.collision_suffix)
        assert.deepStrictEqual(suffixes, [0, 1])
        assert.strictEqual(db.prepare('SELECT COUNT(*) AS count FROM node_identity_v2').get().count, 2)
        assert.strictEqual(db.prepare('SELECT COUNT(*) AS count FROM node_runtime_v2').get().count, 2)
      } finally {
        db.close()
      }

      const entries = xrayCache.readCacheEntries(cachePath)
      const addresses = entries.map(entry => entry.node.settings.servers[0].address).sort()
      assert.deepStrictEqual(addresses, ['21.21.21.21', '22.22.22.22'])
    } finally {
      xrayCache.setCompactV2IdentityFactoryForTest(null)
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  // eslint-disable-next-line no-undef
  it('compacts retired legacy sqlite cache after migrating an existing database', () => {
    if (!sqliteAvailable) {
      return
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-sidecar-xray-cache-compact-'))
    const cachePath = path.join(tmpDir, 'nodes_cache.sqlite')

    try {
      xrayCache.writeCache(cachePath, Array.from({ length: 200 }, (_, index) => ({
        node: createNode(`10.0.0.${index + 1}`, 8000 + index),
        stable: index % 2 === 0,
        delay: 50 + index,
        source: 'source-sync',
        updatedAt: '2026-05-10T00:00:00.000+08:00',
        nextCheckAt: '2026-05-10T00:00:00.000+08:00',
      })))

      const migrated = xrayCache.migrateHotColdSchema(cachePath, { batchLimit: 500, maxRows: 500, lowFileCache: true })
      assert.strictEqual(migrated.pending, false)

      const retired = xrayCache.retireLegacyNodesStorage(cachePath, { lowFileCache: true })
      assert.strictEqual(retired.retired, true)
      assert.strictEqual(retired.pending, false)

      const compacted = xrayCache.compactRetiredSqliteCache(cachePath, { lowFileCache: true })
      assert.strictEqual(compacted.compacted, true)
      assert.strictEqual(compacted.pending, false)

      const compactedAgain = xrayCache.compactRetiredSqliteCache(cachePath, { lowFileCache: true })
      assert.strictEqual(compactedAgain.compacted, true)
      assert.strictEqual(compactedAgain.alreadyCompacted, true)

      const entries = xrayCache.readCacheEntries(cachePath)
      assert.strictEqual(entries.length, 200)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  // eslint-disable-next-line no-undef
  it('cleanupOutdatedToSizeLimit evicts oldest-due nodes to shrink below target', () => {
    if (!sqliteAvailable) {
      return
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-sidecar-xray-cache-'))
    const cachePath = path.join(tmpDir, 'nodes_cache.sqlite')

    try {
      // Insert 300 nodes with a large node_json payload so the DB exceeds the target.
      // Stagger next_check_at: node 0 oldest, node 299 newest.
      // Cleanup by next_check_at ASC should evict the oldest-due nodes first.
      const bigPayload = JSON.stringify({ padding: 'x'.repeat(4096) })
      xrayCache.writeCache(cachePath, Array.from({ length: 300 }, (_, index) => ({
        node: {
          protocol: 'socks',
          settings: { servers: [{ address: `10.0.0.${index + 1}`, port: 8000 + index }] },
          _big: bigPayload,
        },
        stable: false,
        delay: 100 + index,
        source: 'source-sync',
        // older index => older next_check_at => evicted first
        updatedAt: `2026-05-${10 + Math.floor(index / 30)}T00:00:00.000+08:00`,
        nextCheckAt: `2026-05-${10 + Math.floor(index / 30)}T00:00:00.000+08:00`,
      })))

      const sizeBefore = xrayCache.getSqliteCacheSizeBytes(cachePath)
      assert.ok(sizeBefore > 0, 'cache should have non-zero size before cleanup')

      // Target half of current size to force real eviction.
      const targetBytes = Math.floor(sizeBefore / 2)
      const result = xrayCache.cleanupOutdatedToSizeLimit(cachePath, targetBytes)
      assert.ok(result, 'cleanup should return a result object')
      assert.strictEqual(typeof result.deletedNodes, 'number')
      assert.ok(result.deletedNodes > 0, `should have evicted nodes, got deletedNodes=${result.deletedNodes}`)
      assert.ok(result.sizeAfter <= targetBytes, `sizeAfter=${result.sizeAfter} should be <= target=${targetBytes}`)
      assert.ok(result.sizeAfter < result.sizeBefore, 'size should shrink')

      // Verify surviving node count decreased by deletedNodes.
      const remaining = xrayCache.readCacheEntries(cachePath)
      assert.ok(remaining.length < 300, `remaining=${remaining.length} should be less than 300`)
      assert.strictEqual(remaining.length, 300 - result.deletedNodes)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  // eslint-disable-next-line no-undef
  it('cleanupOutdatedToSizeLimit reports deletedTombstones and deletedNodes separately', () => {
    if (!sqliteAvailable) {
      return
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-sidecar-xray-cache-'))
    const cachePath = path.join(tmpDir, 'nodes_cache.sqlite')

    try {
      xrayCache.writeCache(cachePath, Array.from({ length: 50 }, (_, index) => ({
        node: createNode(`10.0.0.${index + 1}`, 8000 + index),
        stable: false,
        delay: 100 + index,
        source: 'source-sync',
        updatedAt: '2026-05-10T00:00:00.000+08:00',
        nextCheckAt: '2026-05-10T00:00:00.000+08:00',
      })))

      // No tombstones, no oversize: cleanup should be a no-op returning zero counts.
      const result = xrayCache.cleanupOutdatedToSizeLimit(cachePath, 1024 * 1024 * 1024)
      assert.ok(result)
      assert.strictEqual(result.deletedTombstones, 0)
      assert.strictEqual(result.deletedNodes, 0)
      assert.strictEqual(result.deleted, 0)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})