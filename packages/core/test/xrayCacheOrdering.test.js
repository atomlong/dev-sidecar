const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const xrayCache = require('../src/modules/plugin/xray/cache')

let sqliteAvailable = true
try {
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
})