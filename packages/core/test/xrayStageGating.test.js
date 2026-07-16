const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const xrayCache = require('../src/modules/plugin/xray/cache')
const xrayIndex = require('../src/modules/plugin/xray/index')
const xrayTestHelpers = require('../src/modules/plugin/xray/test-helpers')

const {
  applyStage3ProbeResults,
  classifyRefreshPriority,
  getFailureBackoffMs,
  selectStage3RefreshCandidates,
} = xrayIndex.__test

const {
  buildLocalInputState,
  cleanupProbeArtifacts,
  createCacheSyncPlan,
  getLocalInputStatePath,
  getSubscriptionSyncDecision,
  isCacheRefreshEnabled,
  isLocalInputStateMatch,
  isStartupSelectEnabled,
  isSubscriptionSyncEnabled,
  readLocalInputState,
  writeLocalInputState,
} = xrayTestHelpers

let sqliteAvailable = true
try {
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-sidecar-xray-stage-gating-probe-'))
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

describe('xray stage gating', function () {
  // This suite performs repeated better-sqlite3 file I/O and can exceed
  // Mocha's 2s default timeout on slower CI runners, especially Windows.
  // Keep the tests enabled, but allow enough time for deterministic completion.
  this.timeout(30000)

  it('skips remote subscription sync only when effective cache reaches the low watermark', () => {
    if (!sqliteAvailable) {
      return
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-sidecar-xray-stage-gating-'))
    const cachePath = path.join(tmpDir, 'nodes_cache.sqlite')

    try {
      xrayCache.writeCache(cachePath, [
        {
          node: createNode('1.1.1.1', 80),
          stable: true,
          delay: 100,
          country: 'US',
          owner: 'Oracle Cloud',
          source: 'source-sync',
          updatedAt: '2026-05-16T00:00:00.000+08:00',
        },
        {
          node: createNode('2.2.2.2', 80),
          stable: true,
          delay: 80,
          country: 'US',
          owner: 'Cloudflare',
          source: 'source-sync',
          updatedAt: '2026-05-16T00:00:00.000+08:00',
        },
        {
          node: createNode('3.3.3.3', 80),
          stable: false,
          delay: 90,
          country: 'US',
          owner: 'Oracle Cloud',
          source: 'source-sync',
          updatedAt: '2026-05-16T00:00:00.000+08:00',
        },
        {
          node: createNode('4.4.4.4', 80),
          stable: true,
          delay: 1500,
          country: 'US',
          owner: 'Oracle Cloud',
          source: 'source-sync',
          updatedAt: '2026-05-16T00:00:00.000+08:00',
        },
        {
          node: createNode('5.5.5.5', 80),
          stable: true,
          delay: 100,
          country: 'JP',
          owner: 'Oracle Cloud',
          source: 'source-sync',
          updatedAt: '2026-05-16T00:00:00.000+08:00',
        },
      ])

      const baseCfg = {
        subscriptionSyncLowWatermark: 1,
        maxDelayMs: 1000,
        allowedCountries: ['US'],
        allowedOwners: ['oracle'],
      }

      const skipDecision = getSubscriptionSyncDecision({ cachePath, cfg: baseCfg })
      assert.strictEqual(skipDecision.lowWatermark, 1)
      assert.strictEqual(skipDecision.effectiveCacheCount, 1)
      assert.strictEqual(skipDecision.shouldSkip, true)

      const fetchDecision = getSubscriptionSyncDecision({
        cachePath,
        cfg: {
          ...baseCfg,
          subscriptionSyncLowWatermark: 2,
        },
      })
      assert.strictEqual(fetchDecision.lowWatermark, 2)
      assert.strictEqual(fetchDecision.effectiveCacheCount, 1)
      assert.strictEqual(fetchDecision.shouldSkip, false)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('treats zero low watermark as always fetch and cache refresh disabled only when explicitly false', () => {
    const alwaysFetchDecision = getSubscriptionSyncDecision({
      cachePath: path.join(os.tmpdir(), 'dev-sidecar-nonexistent-cache.sqlite'),
      cfg: {
        subscriptionSyncLowWatermark: 0,
      },
    })

    assert.strictEqual(alwaysFetchDecision.lowWatermark, 0)
    assert.strictEqual(alwaysFetchDecision.effectiveCacheCount, null)
    assert.strictEqual(alwaysFetchDecision.shouldSkip, false)

    assert.strictEqual(isCacheRefreshEnabled({}), true)
    assert.strictEqual(isCacheRefreshEnabled({ cacheRefreshEnabled: true }), true)
    assert.strictEqual(isCacheRefreshEnabled({ cacheRefreshEnabled: false }), false)
  })

  it('treats startup select and subscription sync as enabled by default and disabled only when explicitly false', () => {
    assert.strictEqual(isStartupSelectEnabled({}), true)
    assert.strictEqual(isStartupSelectEnabled({ startupSelectEnabled: true }), true)
    assert.strictEqual(isStartupSelectEnabled({ startupSelectEnabled: false }), false)
    assert.strictEqual(isStartupSelectEnabled(undefined), true)
    assert.strictEqual(isStartupSelectEnabled(null), true)

    assert.strictEqual(isSubscriptionSyncEnabled({}), true)
    assert.strictEqual(isSubscriptionSyncEnabled({ subscriptionSyncEnabled: true }), true)
    assert.strictEqual(isSubscriptionSyncEnabled({ subscriptionSyncEnabled: false }), false)
    assert.strictEqual(isSubscriptionSyncEnabled(undefined), true)
    assert.strictEqual(isSubscriptionSyncEnabled(null), true)
  })

  it('skips cache rewrite when the candidate set is unchanged and only applies incremental adds or removals', () => {
    const node1 = createNode('1.1.1.1', 80)
    const node2 = createNode('2.2.2.2', 80)
    const node3 = createNode('3.3.3.3', 80)
    const existingEntries = [
      {
        node: node1,
        stable: true,
        delay: 100,
        country: 'US',
        owner: 'Oracle Cloud',
        source: 'source-sync',
        updatedAt: '2026-05-16T00:00:00.000+08:00',
      },
      {
        node: node2,
        stable: false,
        delay: null,
        country: '',
        owner: '',
        source: 'source-sync',
        updatedAt: '2026-05-16T00:00:00.000+08:00',
      },
    ]

    const unchangedStats = {}
    const unchangedPlan = createCacheSyncPlan([node1, node2], existingEntries, unchangedStats)
    assert.strictEqual(unchangedPlan.hasChanges, false)
    assert.strictEqual(unchangedPlan.selectedCount, 2)
    assert.deepStrictEqual(unchangedPlan.addedEntries, [])
    assert.deepStrictEqual(unchangedPlan.removedNodes, [])
    assert.strictEqual(unchangedStats.countryReadyCount, 1)

    const changedStats = {}
    const changedPlan = createCacheSyncPlan([node1, node3], existingEntries, changedStats)
    assert.strictEqual(changedPlan.hasChanges, true)
    assert.strictEqual(changedPlan.selectedCount, 2)
    assert.strictEqual(changedPlan.addedEntries.length, 1)
    assert.deepStrictEqual(changedPlan.addedEntries[0].node, node3)
    assert.strictEqual(changedPlan.addedEntries[0].country, '')
    assert.strictEqual(changedPlan.addedEntries[0].owner, '')
    assert.strictEqual(changedPlan.removedNodes.length, 0)
    assert.strictEqual(changedStats.countryReadyCount, 1)
  })

  it('retains previously cached nodes during stage2 and only adds unseen candidates', () => {
    if (!sqliteAvailable) {
      return
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-sidecar-xray-stage2-retain-'))
    const cachePath = path.join(tmpDir, 'nodes_cache.sqlite')

    try {
      const node1 = createNode('1.1.1.1', 80)
      const node2 = createNode('2.2.2.2', 80)
      const node3 = createNode('3.3.3.3', 80)

      xrayCache.writeCache(cachePath, [
        {
          node: node1,
          stable: true,
          delay: 100,
          source: 'background-probe',
          updatedAt: '2026-05-16T00:00:00.000+08:00',
          nextCheckAt: '2026-05-16T00:00:00.000+08:00',
          failureStreak: 0,
        },
        {
          node: node2,
          stable: false,
          delay: null,
          source: 'source-sync',
          updatedAt: '2026-05-16T00:00:00.000+08:00',
          nextCheckAt: '2026-05-20T00:00:00.000+08:00',
          failureStreak: 1,
        },
      ])

      const existingEntries = xrayCache.readCacheEntries(cachePath)
      const plan = createCacheSyncPlan([node1, node3], existingEntries, {})
      assert.strictEqual(plan.addedEntries.length, 1)
      assert.deepStrictEqual(plan.addedEntries[0].node, node3)

      assert.strictEqual(xrayCache.writeCacheUpdates(cachePath, plan.addedEntries, plan.addedEntries.map(entry => entry.node)), true)
      const mergedEntries = xrayCache.readCacheEntries(cachePath, { orderBy: 'default' })
      const addresses = mergedEntries.map(entry => entry.node.settings.servers[0].address).sort()
      assert.deepStrictEqual(addresses, ['1.1.1.1', '2.2.2.2', '3.3.3.3'])
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('syncs all per-subscription node refs by default', () => {
    if (!sqliteAvailable) {
      return
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-sidecar-xray-subscription-refs-lossless-'))
    const cachePath = path.join(tmpDir, 'nodes_cache.sqlite')

    try {
      // v2 subscription refs require real nodes in nodes_v2 (joined by node_id);
      // raw nodeKey strings with no matching node are silently skipped on write.
      // Pre-create four real nodes and use their nodeKeys for the chunk syncs.
      const nodes = [
        createNode('10.0.0.1', 8001),
        createNode('10.0.0.2', 8002),
        createNode('10.0.0.3', 8003),
        createNode('10.0.0.4', 8004),
      ]
      xrayCache.writeCache(cachePath, nodes.map((node, index) => ({
        node,
        stable: false,
        delay: 100 + index,
        source: 'source-sync',
        updatedAt: '2026-05-10T00:00:00.000+08:00',
        nextCheckAt: '2026-05-10T00:00:00.000+08:00',
      })))
      const nodeKeys = nodes.map(node => xrayCache.getNodeKey(node))

      const sourceKey = 'subscription-ref-lossless-source'
      const firstChunkStats = xrayCache.syncSubscriptionSourceChunk(cachePath, {
        sourceKey,
        displayLabel: 'subscription ref lossless source',
        sortOrder: 1,
      }, nodeKeys.slice(0, 3), { lowFileCache: true })

      assert.deepStrictEqual(firstChunkStats, {
        configured: 1,
        refs: 3,
        skippedRefs: 0,
      })

      const secondChunkStats = xrayCache.syncSubscriptionSourceChunk(cachePath, {
        sourceKey,
        displayLabel: 'subscription ref lossless source',
        sortOrder: 1,
      }, [nodeKeys[3]], { lowFileCache: true })

      assert.deepStrictEqual(secondChunkStats, {
        configured: 1,
        refs: 1,
        skippedRefs: 0,
      })

      const summary = xrayCache.readSubscriptionAvailabilitySummary(cachePath)
      const cappedSource = summary.find(row => row.sourceKey === sourceKey)
      assert.ok(cappedSource)
      assert.strictEqual(cappedSource.stage2NodeCount, 4)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('supports outdated tombstones and due filtering for cooldown lifecycle', () => {
    if (!sqliteAvailable) {
      return
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-sidecar-xray-outdated-'))
    const cachePath = path.join(tmpDir, 'nodes_cache.sqlite')

    try {
      const hotNode = createNode('1.1.1.1', 80)
      const coldNode = createNode('2.2.2.2', 80)
      const removedNode = createNode('3.3.3.3', 80)
      const removedFingerprint = xrayCache.fingerprintNode(removedNode)

      xrayCache.writeCache(cachePath, [
        {
          node: hotNode,
          stable: true,
          delay: 80,
          source: 'background-probe',
          updatedAt: '2026-05-16T00:00:00.000+08:00',
          nextCheckAt: '2026-05-16T00:00:00.000+08:00',
          failureStreak: 0,
        },
        {
          node: coldNode,
          stable: false,
          delay: null,
          source: 'background-probe',
          updatedAt: '2026-05-16T00:00:00.000+08:00',
          nextCheckAt: '2026-05-10T00:00:00.000+08:00',
          failureStreak: 2,
        },
      ])

      assert.strictEqual(xrayCache.upsertOutdated(cachePath, removedFingerprint, Date.parse('2026-05-16T00:00:00.000+08:00')), true)
      const outdatedSet = xrayCache.readOutdatedHashSet(cachePath, [removedFingerprint, xrayCache.fingerprintNode(hotNode)])
      assert.deepStrictEqual([...outdatedSet], [removedFingerprint])

      const dueRows = xrayCache.readCacheRowIds(cachePath, {
        orderBy: 'due',
        dueBefore: '2026-05-12T00:00:00.000+08:00',
      })
      const dueEntries = xrayCache.readCacheEntriesByRowIds(cachePath, dueRows)
      assert.strictEqual(dueEntries.length, 1)
      assert.strictEqual(dueEntries[0].node.settings.servers[0].address, '2.2.2.2')

      assert.strictEqual(xrayCache.deleteOutdated(cachePath, removedFingerprint), true)
      const clearedSet = xrayCache.readOutdatedHashSet(cachePath, [removedFingerprint])
      assert.strictEqual(clearedSet.size, 0)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  // Note: 'backfills NULL next_check_at during schema migration and treats it as a bug to repair'
  // was removed because it created a legacy `nodes` table by raw SQL and relied on the deleted
  // legacy-to-v2 schema migration path (backfillNextCheckAt / migrateNodesToHotColdSchema etc.).
  // The DB is now exclusively compact v2, and writeCache always persists next_check_at, so the
  // legacy NULL-backfill scenario no longer applies.

  it('reads only matching existing cache entries for stage2 candidate nodes', () => {
    if (!sqliteAvailable) {
      return
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-sidecar-xray-read-fingerprints-'))
    const cachePath = path.join(tmpDir, 'nodes_cache.sqlite')

    try {
      const node1 = createNode('1.1.1.1', 80)
      const node2 = createNode('2.2.2.2', 80)
      const node3 = createNode('3.3.3.3', 80)
      xrayCache.writeCache(cachePath, [
        { node: node1, updatedAt: '2026-05-16T00:00:00.000+08:00', nextCheckAt: '2026-05-16T00:00:00.000+08:00' },
        { node: node2, updatedAt: '2026-05-17T00:00:00.000+08:00', nextCheckAt: '2026-05-17T00:00:00.000+08:00' },
      ])

      const matchedEntries = xrayCache.readCacheEntriesByFingerprints(cachePath, [
        xrayCache.fingerprintNode(node2),
        xrayCache.fingerprintNode(node3),
      ])

      assert.strictEqual(matchedEntries.length, 1)
      assert.strictEqual(matchedEntries[0].node.settings.servers[0].address, '2.2.2.2')
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('classifies stage3 candidates into hot, new, and cold buckets with budgeted selection', () => {
    const rows = [
      { rowId: 1, entry: { stable: true, failureStreak: 0, nextCheckAt: '2026-05-10T00:00:00.000+08:00' } },
      { rowId: 2, entry: { stable: true, failureStreak: 0, nextCheckAt: '2026-05-10T00:00:00.000+08:00' } },
      { rowId: 3, entry: { stable: false, failureStreak: 0, nextCheckAt: '2026-05-10T00:00:00.000+08:00' } },
      { rowId: 4, entry: { stable: false, failureStreak: 0, nextCheckAt: '2026-05-10T00:00:00.000+08:00' } },
      { rowId: 5, entry: { stable: false, failureStreak: 1, nextCheckAt: '2026-05-10T00:00:00.000+08:00' } },
      { rowId: 6, entry: { stable: false, failureStreak: 2, nextCheckAt: '2026-05-10T00:00:00.000+08:00' } },
    ]

    assert.strictEqual(classifyRefreshPriority(rows[0].entry), 'hot')
    assert.strictEqual(classifyRefreshPriority(rows[2].entry), 'new')
    assert.strictEqual(classifyRefreshPriority(rows[4].entry), 'cold')

    const selection = selectStage3RefreshCandidates(rows, 1)
    assert.strictEqual(selection.totalDueCount, 6)
    assert.strictEqual(selection.roundBudget, 6)
    assert.strictEqual(selection.selected.length, 6)
    assert.strictEqual(selection.distribution.hot, 2)
    assert.strictEqual(selection.distribution.new, 2)
    assert.strictEqual(selection.distribution.cold, 2)
  })

  it('limits stage3 selection by budget and backfills unused bucket capacity', () => {
    const rows = [
      { rowId: 1, entry: { stable: true, failureStreak: 0 } },
      { rowId: 2, entry: { stable: true, failureStreak: 0 } },
      { rowId: 3, entry: { stable: true, failureStreak: 0 } },
      { rowId: 4, entry: { stable: true, failureStreak: 0 } },
      { rowId: 5, entry: { stable: true, failureStreak: 0 } },
      { rowId: 6, entry: { stable: false, failureStreak: 1 } },
      { rowId: 7, entry: { stable: false, failureStreak: 1 } },
      { rowId: 8, entry: { stable: false, failureStreak: 1 } },
      { rowId: 9, entry: { stable: false, failureStreak: 1 } },
      { rowId: 10, entry: { stable: false, failureStreak: 1 } },
      { rowId: 11, entry: { stable: false, failureStreak: 1 } },
      { rowId: 12, entry: { stable: false, failureStreak: 1 } },
      { rowId: 13, entry: { stable: false, failureStreak: 1 } },
      { rowId: 14, entry: { stable: false, failureStreak: 1 } },
      { rowId: 15, entry: { stable: false, failureStreak: 1 } },
      { rowId: 16, entry: { stable: false, failureStreak: 0 } },
      { rowId: 17, entry: { stable: false, failureStreak: 0 } },
      { rowId: 18, entry: { stable: false, failureStreak: 0 } },
      { rowId: 19, entry: { stable: false, failureStreak: 0 } },
      { rowId: 20, entry: { stable: false, failureStreak: 0 } },
      { rowId: 21, entry: { stable: false, failureStreak: 0 } },
      { rowId: 22, entry: { stable: false, failureStreak: 0 } },
      { rowId: 23, entry: { stable: false, failureStreak: 0 } },
      { rowId: 24, entry: { stable: false, failureStreak: 0 } },
      { rowId: 25, entry: { stable: false, failureStreak: 0 } },
    ]

    const selection = selectStage3RefreshCandidates(rows, 1)
    assert.strictEqual(selection.totalDueCount, 25)
    assert.strictEqual(selection.roundBudget, 20)
    assert.strictEqual(selection.selected.length, 20)
    assert.strictEqual(selection.distribution.hot, 5)
    assert.strictEqual(selection.distribution.new, 10)
    assert.strictEqual(selection.distribution.cold, 5)
  })

  it('returns empty selection cleanly when there are no due stage3 candidates', () => {
    const selection = selectStage3RefreshCandidates([], 16)
    assert.strictEqual(selection.totalDueCount, 0)
    assert.strictEqual(selection.roundBudget, 0)
    assert.deepStrictEqual(selection.selected, [])
    assert.deepStrictEqual(selection.distribution, { hot: 0, new: 0, cold: 0 })
  })

  it('caps failure backoff at the last configured tier', () => {
    assert.strictEqual(getFailureBackoffMs(3), 90 * 24 * 60 * 60 * 1000)
    assert.strictEqual(getFailureBackoffMs(4), 90 * 24 * 60 * 60 * 1000)
    assert.strictEqual(getFailureBackoffMs(999), 90 * 24 * 60 * 60 * 1000)
  })

  it('tolerates malformed stage3 candidate rows and invalid batch sizes', () => {
    const rows = [
      null,
      { rowId: 1, entry: null },
      { rowId: 2, entry: { stable: true, failureStreak: 0 } },
      { rowId: 3, entry: { stable: false, failureStreak: 2 } },
      { rowId: 4, entry: { stable: false, failureStreak: 0 } },
    ]

    const selection = selectStage3RefreshCandidates(rows, 0)
    assert.strictEqual(selection.totalDueCount, 4)
    assert.strictEqual(selection.selected.length, 4)
    assert.strictEqual(selection.distribution.hot, 1)
    assert.strictEqual(selection.distribution.new, 2)
    assert.strictEqual(selection.distribution.cold, 1)
  })

  it('applies stage3 success by resetting failure streak and scheduling next checks', () => {
    if (!sqliteAvailable) {
      return
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-sidecar-xray-stage3-success-'))
    const cachePath = path.join(tmpDir, 'nodes_cache.sqlite')

    try {
      const node = createNode('1.1.1.1', 80)
      const targetBatch = [{
        node,
        stable: false,
        delay: null,
        source: 'source-sync',
        updatedAt: '2026-05-16T00:00:00.000+08:00',
        nextCheckAt: '2026-05-10T00:00:00.000+08:00',
        failureStreak: 2,
      }]
      xrayCache.writeCache(cachePath, targetBatch)

      const result = applyStage3ProbeResults({
        cachePath,
        targetBatch,
        annotatedEntries: [{
          node,
          stable: true,
          delay: 88,
          source: 'background-probe',
          updatedAt: '2026-05-20T00:00:00.000+08:00',
        }],
        observedFingerprints: [xrayCache.fingerprintNode(node)],
        cacheRefreshIntervalMs: 21600 * 1000,
        now: Date.parse('2026-05-20T00:00:00.000+08:00'),
      })

      assert.strictEqual(result.availableCount, 1)
      assert.strictEqual(result.removedCount, 0)
      assert.strictEqual(result.explicitFailureCount, 0)
      assert.strictEqual(result.partialCoverageCount, 0)
      assert.strictEqual(result.updatedEntries.length, 1)
      assert.strictEqual(result.updatedEntries[0].stable, true)
      assert.strictEqual(result.updatedEntries[0].failureStreak, 0)
      assert.strictEqual(result.updatedEntries[0].delay, 88)
      assert.ok(typeof result.updatedEntries[0].nextCheckAt === 'string')
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('clears outdated tombstones when a previously tombstoned node succeeds again', () => {
    if (!sqliteAvailable) {
      return
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-sidecar-xray-stage3-revive-'))
    const cachePath = path.join(tmpDir, 'nodes_cache.sqlite')

    try {
      const node = createNode('6.6.6.6', 80)
      const fingerprint = xrayCache.fingerprintNode(node)
      const targetBatch = [{
        node,
        stable: false,
        delay: null,
        source: 'background-probe',
        updatedAt: '2026-05-16T00:00:00.000+08:00',
        nextCheckAt: '2026-05-10T00:00:00.000+08:00',
        failureStreak: 2,
      }]
      xrayCache.writeCache(cachePath, targetBatch)
      xrayCache.upsertOutdated(cachePath, fingerprint, Date.parse('2026-05-18T00:00:00.000+08:00'))

      const before = xrayCache.readOutdatedHashSet(cachePath, [fingerprint])
      assert.strictEqual(before.has(fingerprint), true)

      applyStage3ProbeResults({
        cachePath,
        targetBatch,
        annotatedEntries: [{
          node,
          stable: true,
          delay: 66,
          source: 'background-probe',
          updatedAt: '2026-05-20T00:00:00.000+08:00',
        }],
        observedFingerprints: [fingerprint],
        cacheRefreshIntervalMs: 21600 * 1000,
        now: Date.parse('2026-05-20T00:00:00.000+08:00'),
      })

      const after = xrayCache.readOutdatedHashSet(cachePath, [fingerprint])
      assert.strictEqual(after.has(fingerprint), false)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('applies stage3 explicit failures with backoff then tombstones on third strike', () => {
    if (!sqliteAvailable) {
      return
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-sidecar-xray-stage3-failure-'))
    const cachePath = path.join(tmpDir, 'nodes_cache.sqlite')

    try {
      const node1 = createNode('2.2.2.2', 80)
      const node2 = createNode('3.3.3.3', 80)
      const now = Date.parse('2026-05-20T00:00:00.000+08:00')
      const targetBatch = [
        {
          node: node1,
          stable: true,
          delay: 50,
          source: 'background-probe',
          updatedAt: '2026-05-16T00:00:00.000+08:00',
          nextCheckAt: '2026-05-10T00:00:00.000+08:00',
          failureStreak: 0,
        },
        {
          node: node2,
          stable: false,
          delay: null,
          source: 'background-probe',
          updatedAt: '2026-05-16T00:00:00.000+08:00',
          nextCheckAt: '2026-05-10T00:00:00.000+08:00',
          failureStreak: 2,
        },
      ]
      xrayCache.writeCache(cachePath, targetBatch)

      const observedFingerprints = targetBatch.map(entry => xrayCache.fingerprintNode(entry.node))
      const result = applyStage3ProbeResults({
        cachePath,
        targetBatch,
        annotatedEntries: [],
        observedFingerprints,
        cacheRefreshIntervalMs: 21600 * 1000,
        now,
      })

      assert.strictEqual(result.availableCount, 0)
      assert.strictEqual(result.explicitFailureCount, 2)
      assert.strictEqual(result.removedCount, 1)
      assert.strictEqual(result.partialCoverageCount, 0)
      assert.strictEqual(result.updatedEntries.length, 1)
      assert.strictEqual(result.updatedEntries[0].failureStreak, 1)
      assert.ok(typeof result.updatedEntries[0].nextCheckAt === 'string')
      assert.strictEqual(getFailureBackoffMs(1), 7 * 24 * 60 * 60 * 1000)
      assert.strictEqual(getFailureBackoffMs(2), 30 * 24 * 60 * 60 * 1000)
      assert.strictEqual(getFailureBackoffMs(3), 90 * 24 * 60 * 60 * 1000)

      const outdatedSet = xrayCache.readOutdatedHashSet(cachePath, [xrayCache.fingerprintNode(node2)])
      assert.strictEqual(outdatedSet.has(xrayCache.fingerprintNode(node2)), true)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('mixes success, explicit failure, and partial coverage in one stage3 batch', () => {
    if (!sqliteAvailable) {
      return
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-sidecar-xray-stage3-mixed-'))
    const cachePath = path.join(tmpDir, 'nodes_cache.sqlite')

    try {
      const successNode = createNode('11.11.11.11', 80)
      const failedNode = createNode('12.12.12.12', 80)
      const untouchedNode = createNode('13.13.13.13', 80)
      const targetBatch = [
        {
          node: successNode,
          stable: false,
          delay: null,
          source: 'background-probe',
          updatedAt: '2026-05-16T00:00:00.000+08:00',
          nextCheckAt: '2026-05-10T00:00:00.000+08:00',
          failureStreak: 1,
        },
        {
          node: failedNode,
          stable: true,
          delay: 40,
          source: 'background-probe',
          updatedAt: '2026-05-16T00:00:00.000+08:00',
          nextCheckAt: '2026-05-10T00:00:00.000+08:00',
          failureStreak: 1,
        },
        {
          node: untouchedNode,
          stable: false,
          delay: null,
          source: 'background-probe',
          updatedAt: '2026-05-16T00:00:00.000+08:00',
          nextCheckAt: '2026-05-10T00:00:00.000+08:00',
          failureStreak: 2,
        },
      ]

      const result = applyStage3ProbeResults({
        cachePath,
        targetBatch,
        annotatedEntries: [{
          node: successNode,
          stable: true,
          delay: 77,
          source: 'background-probe',
          updatedAt: '2026-05-20T00:00:00.000+08:00',
        }],
        observedFingerprints: [
          xrayCache.fingerprintNode(successNode),
          xrayCache.fingerprintNode(failedNode),
        ],
        cacheRefreshIntervalMs: 21600 * 1000,
        now: Date.parse('2026-05-20T00:00:00.000+08:00'),
      })

      assert.strictEqual(result.availableCount, 1)
      assert.strictEqual(result.explicitFailureCount, 1)
      assert.strictEqual(result.partialCoverageCount, 1)
      assert.strictEqual(result.removedCount, 0)
      assert.strictEqual(result.updatedEntries.length, 3)

      const successEntry = result.updatedEntries.find(entry => entry.node.settings.servers[0].address === '11.11.11.11')
      const failedEntry = result.updatedEntries.find(entry => entry.node.settings.servers[0].address === '12.12.12.12')
      const untouchedEntry = result.updatedEntries.find(entry => entry.node.settings.servers[0].address === '13.13.13.13')

      assert.strictEqual(successEntry.failureStreak, 0)
      assert.strictEqual(successEntry.stable, true)
      assert.strictEqual(failedEntry.failureStreak, 2)
      assert.strictEqual(failedEntry.stable, false)
      assert.strictEqual(failedEntry.delay, null)
      assert.strictEqual(untouchedEntry.failureStreak, 2)
      assert.strictEqual(untouchedEntry.nextCheckAt, '2026-05-10T00:00:00.000+08:00')
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('uses the last duplicate success entry for the same fingerprint deterministically', () => {
    if (!sqliteAvailable) {
      return
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-sidecar-xray-stage3-duplicate-success-'))
    const cachePath = path.join(tmpDir, 'nodes_cache.sqlite')

    try {
      const node = createNode('14.14.14.14', 80)
      const fingerprint = xrayCache.fingerprintNode(node)
      const targetBatch = [{
        node,
        stable: false,
        delay: null,
        source: 'source-sync',
        updatedAt: '2026-05-16T00:00:00.000+08:00',
        nextCheckAt: '2026-05-10T00:00:00.000+08:00',
        failureStreak: 1,
      }]

      const result = applyStage3ProbeResults({
        cachePath,
        targetBatch,
        annotatedEntries: [
          {
            node,
            stable: true,
            delay: 120,
            source: 'background-probe',
            updatedAt: '2026-05-20T00:00:00.000+08:00',
          },
          {
            node,
            stable: true,
            delay: 66,
            source: 'background-probe',
            updatedAt: '2026-05-20T00:00:01.000+08:00',
          },
        ],
        observedFingerprints: [fingerprint, fingerprint],
        cacheRefreshIntervalMs: 21600 * 1000,
        now: Date.parse('2026-05-20T00:00:00.000+08:00'),
      })

      assert.strictEqual(result.availableCount, 1)
      assert.strictEqual(result.updatedEntries.length, 1)
      assert.strictEqual(result.updatedEntries[0].delay, 66)
      assert.strictEqual(result.updatedEntries[0].failureStreak, 0)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('ignores non-positive failure streak inputs when classifying and backoff normalizing', () => {
    assert.strictEqual(classifyRefreshPriority({ stable: false, failureStreak: -1 }), 'new')
    assert.strictEqual(classifyRefreshPriority({ stable: false, failureStreak: 0 }), 'new')
    assert.strictEqual(classifyRefreshPriority({ stable: true, failureStreak: -1 }), 'hot')
    assert.strictEqual(getFailureBackoffMs(0), 7 * 24 * 60 * 60 * 1000)
    assert.strictEqual(getFailureBackoffMs(-5), 7 * 24 * 60 * 60 * 1000)
  })

  it('tombstones every third-strike failure even with duplicate and unknown observed fingerprints', () => {
    if (!sqliteAvailable) {
      return
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-sidecar-xray-stage3-third-strike-'))
    const cachePath = path.join(tmpDir, 'nodes_cache.sqlite')

    try {
      const node1 = createNode('15.15.15.15', 80)
      const node2 = createNode('16.16.16.16', 80)
      const fp1 = xrayCache.fingerprintNode(node1)
      const fp2 = xrayCache.fingerprintNode(node2)
      const targetBatch = [
        {
          node: node1,
          stable: false,
          delay: null,
          source: 'background-probe',
          updatedAt: '2026-05-16T00:00:00.000+08:00',
          nextCheckAt: '2026-05-10T00:00:00.000+08:00',
          failureStreak: 2,
        },
        {
          node: node2,
          stable: false,
          delay: null,
          source: 'background-probe',
          updatedAt: '2026-05-16T00:00:00.000+08:00',
          nextCheckAt: '2026-05-10T00:00:00.000+08:00',
          failureStreak: 2,
        },
      ]

      const result = applyStage3ProbeResults({
        cachePath,
        targetBatch,
        annotatedEntries: [],
        observedFingerprints: [fp1, fp1, fp2, 'unknown-fingerprint'],
        cacheRefreshIntervalMs: 21600 * 1000,
        now: Date.parse('2026-05-20T00:00:00.000+08:00'),
      })

      assert.strictEqual(result.availableCount, 0)
      assert.strictEqual(result.explicitFailureCount, 2)
      assert.strictEqual(result.removedCount, 2)
      assert.deepStrictEqual(result.updatedEntries, [])

      const outdatedSet = xrayCache.readOutdatedHashSet(cachePath, [fp1, fp2])
      assert.strictEqual(outdatedSet.has(fp1), true)
      assert.strictEqual(outdatedSet.has(fp2), true)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('filters invalid reality shortId nodes before startup candidate selection', () => {
    if (!sqliteAvailable) {
      return
    }

    const invalidRealityNode = {
      protocol: 'vless',
      settings: {
        vnext: [{
          address: 'example.com',
          port: 443,
          users: [{ id: '11111111-1111-1111-1111-111111111111' }],
        }],
      },
      streamSettings: {
        network: 'tcp',
        security: 'reality',
        realitySettings: {
          serverName: 'example.com',
          publicKey: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY',
          shortId: '2cfb5a0ae8ab0cb063260',
        },
      },
    }

    assert.strictEqual(xrayIndex.__test.isParsedNodeValid(invalidRealityNode), false)
  })

  it('filters odd-length reality shortId nodes before startup candidate selection', () => {
    const invalidRealityNode = {
      protocol: 'vless',
      settings: {
        vnext: [{
          address: 'example.com',
          port: 443,
          users: [{ id: '11111111-1111-1111-1111-111111111111' }],
        }],
      },
      streamSettings: {
        network: 'tcp',
        security: 'reality',
        realitySettings: {
          serverName: 'example.com',
          publicKey: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY',
          shortId: '612d8fa72',
        },
      },
    }

    assert.strictEqual(xrayIndex.__test.isParsedNodeValid(invalidRealityNode), false)
  })

  it('simulates a stage2 tombstone skip followed by stage3 success writeback', () => {
    if (!sqliteAvailable) {
      return
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-sidecar-xray-stage2-stage3-flow-'))
    const cachePath = path.join(tmpDir, 'nodes_cache.sqlite')

    try {
      const retainedNode = createNode('21.21.21.21', 80)
      const tombstonedNode = createNode('22.22.22.22', 80)
      const freshNode = createNode('23.23.23.23', 80)
      const retainedFingerprint = xrayCache.fingerprintNode(retainedNode)
      const tombstonedFingerprint = xrayCache.fingerprintNode(tombstonedNode)

      xrayCache.writeCache(cachePath, [
        {
          node: retainedNode,
          stable: false,
          delay: null,
          source: 'source-sync',
          updatedAt: '2026-05-16T00:00:00.000+08:00',
          nextCheckAt: '2026-05-10T00:00:00.000+08:00',
          failureStreak: 1,
        },
      ])
      xrayCache.upsertOutdated(cachePath, tombstonedFingerprint, Date.parse('2026-05-18T00:00:00.000+08:00'))

      const stage2Candidates = [retainedNode, tombstonedNode, freshNode]
      const outdatedSet = xrayCache.readOutdatedHashSet(cachePath, stage2Candidates.map(node => xrayCache.fingerprintNode(node)))
      const filteredCandidates = stage2Candidates.filter(node => !outdatedSet.has(xrayCache.fingerprintNode(node)))
      assert.deepStrictEqual(filteredCandidates.map(node => node.settings.servers[0].address).sort(), ['21.21.21.21', '23.23.23.23'])

      const existingEntries = xrayCache.readCacheEntries(cachePath)
      const plan = createCacheSyncPlan(filteredCandidates, existingEntries, {})
      assert.strictEqual(plan.addedEntries.length, 1)
      assert.strictEqual(plan.addedEntries[0].node.settings.servers[0].address, '23.23.23.23')

      const initializedEntries = plan.addedEntries.map(entry => ({
        ...entry,
        nextCheckAt: '2026-05-20T00:00:00.000+08:00',
        failureStreak: 0,
      }))
      assert.strictEqual(xrayCache.writeCacheUpdates(cachePath, initializedEntries, initializedEntries.map(entry => entry.node)), true)

      const dueRows = xrayCache.readCacheRowIds(cachePath, {
        orderBy: 'due',
        dueBefore: '2026-05-21T00:00:00.000+08:00',
      })
      const dueEntries = xrayCache.readCacheEntriesByRowIds(cachePath, dueRows)
      assert.strictEqual(dueEntries.length, 2)

      const probeResult = applyStage3ProbeResults({
        cachePath,
        targetBatch: dueEntries,
        annotatedEntries: [
          {
            node: retainedNode,
            stable: true,
            delay: 55,
            source: 'background-probe',
            updatedAt: '2026-05-21T00:00:00.000+08:00',
          },
          {
            node: freshNode,
            stable: true,
            delay: 66,
            source: 'background-probe',
            updatedAt: '2026-05-21T00:00:00.000+08:00',
          },
        ],
        observedFingerprints: [retainedFingerprint, xrayCache.fingerprintNode(freshNode)],
        cacheRefreshIntervalMs: 21600 * 1000,
        now: Date.parse('2026-05-21T00:00:00.000+08:00'),
      })
      assert.strictEqual(xrayCache.writeCacheUpdates(cachePath, probeResult.updatedEntries, dueEntries.map(entry => entry.node)), true)

      const finalEntries = xrayCache.readCacheEntries(cachePath, { orderBy: 'default' })
      const finalAddresses = finalEntries.map(entry => entry.node.settings.servers[0].address).sort()
      assert.deepStrictEqual(finalAddresses, ['21.21.21.21', '23.23.23.23'])
      assert.strictEqual(finalEntries.every(entry => entry.stable === true), true)
      assert.strictEqual(xrayCache.readOutdatedHashSet(cachePath, [tombstonedFingerprint]).has(tombstonedFingerprint), true)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('supports first-run flow when the cache database does not exist yet', () => {
    if (!sqliteAvailable) {
      return
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-sidecar-xray-first-run-'))
    const cachePath = path.join(tmpDir, 'nodes_cache.sqlite')

    try {
      assert.deepStrictEqual(xrayCache.readCacheEntries(cachePath), [])
      assert.deepStrictEqual(xrayCache.readCacheRowIds(cachePath, {
        orderBy: 'due',
        dueBefore: '2026-05-21T00:00:00.000+08:00',
      }), [])

      const firstNode = createNode('31.31.31.31', 80)
      const plan = createCacheSyncPlan([firstNode], [], {})
      assert.strictEqual(plan.addedEntries.length, 1)
      assert.ok(typeof plan.addedEntries[0].nextCheckAt === 'string')

      assert.strictEqual(
        xrayCache.writeCacheUpdates(cachePath, plan.addedEntries, plan.addedEntries.map(entry => entry.node)),
        true
      )

      const dueRows = xrayCache.readCacheRowIds(cachePath, {
        orderBy: 'due',
        dueBefore: '2099-01-01T00:00:00.000+08:00',
      })
      assert.strictEqual(dueRows.length, 1)

      const dueEntries = xrayCache.readCacheEntriesByRowIds(cachePath, dueRows)
      assert.strictEqual(dueEntries.length, 1)
      assert.strictEqual(dueEntries[0].nextCheckAt != null, true)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('reads startup bootstrap candidates through the startup-specific cache reader with stable and default ordering preserved', () => {
    if (!sqliteAvailable) {
      return
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-sidecar-xray-startup-reader-'))
    const cachePath = path.join(tmpDir, 'nodes_cache.sqlite')

    try {
      xrayCache.writeCache(cachePath, [
        {
          node: createNode('81.81.81.81', 80),
          stable: false,
          delay: 300,
          source: 'source-sync',
          updatedAt: '2026-05-10T00:00:00.000+08:00',
          nextCheckAt: '2026-05-10T00:00:00.000+08:00',
        },
        {
          node: createNode('82.82.82.82', 80),
          stable: true,
          delay: 120,
          source: 'background-probe',
          updatedAt: '2026-05-11T00:00:00.000+08:00',
          nextCheckAt: '2026-05-11T00:00:00.000+08:00',
        },
        {
          node: createNode('83.83.83.83', 80),
          stable: true,
          delay: 80,
          source: 'background-probe',
          updatedAt: '2026-05-12T00:00:00.000+08:00',
          nextCheckAt: '2026-05-12T00:00:00.000+08:00',
        },
      ])

      // The v2 startup reader bootstraps from probed_node_ids stored in cache_meta
      // (populated by Stage3 via updateProbedNodeIdsAtPath). Without this, the
      // startup reader returns [] on a fresh cache. updateProbedNodeIdsAtPath
      // selects nodes with delay > 0 ordered by delay ASC, stable DESC,
      // updated_at DESC — which gives [83 (delay 80, stable), 82 (delay 120,
      // stable), 81 (delay 300, unstable)].
      assert.strictEqual(xrayCache.updateProbedNodeIdsAtPath(cachePath), 3)

      // v2 startup reader ignores stableOnly / maxDelayMs / orderBy filters and
      // only honors `limit` (slicing the probed_node_ids list). It returns the
      // probed nodes in their probed order. With limit: 5 all three are returned.
      const stableEntries = xrayCache.readCacheEntriesForStartup(cachePath, {
        stableOnly: true,
        maxDelayMs: 100,
        limit: 5,
      })
      assert.deepStrictEqual(
        stableEntries.map(entry => entry.node.settings.servers[0].address),
        ['83.83.83.83', '82.82.82.82', '81.81.81.81']
      )

      const bootstrapEntries = xrayCache.readCacheEntriesForStartup(cachePath, {
        orderBy: 'default',
        limit: 2,
      })
      assert.deepStrictEqual(
        bootstrapEntries.map(entry => entry.node.settings.servers[0].address),
        ['83.83.83.83', '82.82.82.82']
      )
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('reads stage3 refresh batches through the refresh-specific rowid reader while preserving requested row order', () => {
    if (!sqliteAvailable) {
      return
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-sidecar-xray-refresh-reader-'))
    const cachePath = path.join(tmpDir, 'nodes_cache.sqlite')

    try {
      xrayCache.writeCache(cachePath, [
        {
          node: createNode('91.91.91.91', 80),
          stable: true,
          delay: 50,
          source: 'background-probe',
          updatedAt: '2026-05-11T00:00:00.000+08:00',
          nextCheckAt: '2026-05-08T00:00:00.000+08:00',
        },
        {
          node: createNode('92.92.92.92', 80),
          stable: false,
          delay: 150,
          source: 'source-sync',
          updatedAt: '2026-05-11T00:00:00.000+08:00',
          nextCheckAt: '2026-05-07T00:00:00.000+08:00',
        },
        {
          node: createNode('93.93.93.93', 80),
          stable: false,
          delay: 250,
          source: 'source-sync',
          updatedAt: '2026-05-11T00:00:00.000+08:00',
          nextCheckAt: '2026-05-06T00:00:00.000+08:00',
        },
      ])

      const dueRows = xrayCache.readCacheRowIds(cachePath, {
        orderBy: 'due',
        dueBefore: '2026-05-09T00:00:00.000+08:00',
      })
      assert.strictEqual(dueRows.length, 3)

      const selectedRows = [dueRows[1], dueRows[0]]
      const refreshedEntries = xrayCache.readCacheEntriesForRefreshByRowIds(cachePath, selectedRows)
      assert.deepStrictEqual(
        refreshedEntries.map(entry => entry.node.settings.servers[0].address),
        ['92.92.92.92', '93.93.93.93']
      )
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('preserves unrelated cached nodes while stage2 only looks up matching fingerprints', () => {
    if (!sqliteAvailable) {
      return
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-sidecar-xray-stage2-preserve-'))
    const cachePath = path.join(tmpDir, 'nodes_cache.sqlite')

    try {
      const unrelatedNode = createNode('41.41.41.41', 80)
      const existingCandidateNode = createNode('42.42.42.42', 80)
      const newCandidateNode = createNode('43.43.43.43', 80)

      xrayCache.writeCache(cachePath, [
        {
          node: unrelatedNode,
          stable: true,
          delay: 40,
          source: 'background-probe',
          updatedAt: '2026-05-16T00:00:00.000+08:00',
          nextCheckAt: '2026-05-16T00:00:00.000+08:00',
          failureStreak: 0,
        },
        {
          node: existingCandidateNode,
          stable: false,
          delay: null,
          source: 'source-sync',
          updatedAt: '2026-05-17T00:00:00.000+08:00',
          nextCheckAt: '2026-05-17T00:00:00.000+08:00',
          failureStreak: 1,
        },
      ])

      const matchedEntries = xrayCache.readCacheEntriesByFingerprints(cachePath, [
        xrayCache.fingerprintNode(existingCandidateNode),
        xrayCache.fingerprintNode(newCandidateNode),
      ])
      assert.strictEqual(matchedEntries.length, 1)
      assert.strictEqual(matchedEntries[0].node.settings.servers[0].address, '42.42.42.42')

      const plan = createCacheSyncPlan([existingCandidateNode, newCandidateNode], matchedEntries, {})
      assert.strictEqual(plan.addedEntries.length, 1)
      assert.strictEqual(plan.addedEntries[0].node.settings.servers[0].address, '43.43.43.43')

      assert.strictEqual(
        xrayCache.writeCacheUpdates(cachePath, plan.addedEntries, plan.addedEntries.map(entry => entry.node)),
        true
      )

      const allEntries = xrayCache.readCacheEntries(cachePath, { orderBy: 'default' })
      const addresses = allEntries.map(entry => entry.node.settings.servers[0].address).sort()
      assert.deepStrictEqual(addresses, ['41.41.41.41', '42.42.42.42', '43.43.43.43'])
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  // Note: 'repairs legacy NULL next_check_at rows even when stage2 is skipped and stage3 runs later'
  // was removed because it created a legacy `nodes` table by raw SQL and relied on the deleted
  // legacy NULL-backfill repair path. The DB is now exclusively compact v2, and writeCache always
  // persists next_check_at, so the legacy repair scenario no longer applies.

  it('chunks fingerprint lookups so stage2 can dedupe against cache without full-table reads', () => {
    if (!sqliteAvailable) {
      return
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-sidecar-xray-fingerprint-chunks-'))
    const cachePath = path.join(tmpDir, 'nodes_cache.sqlite')

    try {
      const cachedEntries = []
      const fingerprints = []
      for (let index = 0; index < 620; index += 1) {
        const node = createNode(`61.61.${Math.floor(index / 255)}.${(index % 255) + 1}`, 80)
        cachedEntries.push({
          node,
          stable: index % 2 === 0,
          delay: index,
          source: 'source-sync',
          updatedAt: '2026-05-16T00:00:00.000+08:00',
          nextCheckAt: '2026-05-16T00:00:00.000+08:00',
          failureStreak: 0,
        })
        fingerprints.push(xrayCache.fingerprintNode(node))
      }
      xrayCache.writeCache(cachePath, cachedEntries)

      const matchedEntries = xrayCache.readCacheEntriesByFingerprints(cachePath, fingerprints)
      assert.strictEqual(matchedEntries.length, 620)
      assert.strictEqual(matchedEntries[0].node.settings.servers[0].address, '61.61.0.1')
      assert.strictEqual(matchedEntries[619].node.settings.servers[0].address, `61.61.${Math.floor(619 / 255)}.${(619 % 255) + 1}`)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('simulates startup-chain handoff from empty cache to stage2 write to stage3 due selection', () => {
    if (!sqliteAvailable) {
      return
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-sidecar-xray-startup-chain-'))
    const cachePath = path.join(tmpDir, 'nodes_cache.sqlite')

    try {
      const startupCacheEntries = xrayCache.readCacheEntries(cachePath, { stableOnly: true, orderBy: 'default' })
      assert.deepStrictEqual(startupCacheEntries, [])

      const configNode = createNode('71.71.71.71', 80)
      const manualNode = createNode('72.72.72.72', 80)
      const subscriptionNode = createNode('73.73.73.73', 80)
      const candidateNodes = xrayCache.deduplicateNodes([configNode, manualNode, subscriptionNode])
      const matchingEntries = xrayCache.readCacheEntriesByFingerprints(
        cachePath,
        candidateNodes.map(node => xrayCache.fingerprintNode(node))
      )
      assert.deepStrictEqual(matchingEntries, [])

      const plan = createCacheSyncPlan(candidateNodes, matchingEntries, {})
      assert.strictEqual(plan.addedEntries.length, 3)
      assert.strictEqual(
        xrayCache.writeCacheUpdates(cachePath, plan.addedEntries, plan.addedEntries.map(entry => entry.node)),
        true
      )

      const dueRows = xrayCache.readCacheRowIds(cachePath, {
        orderBy: 'due',
        dueBefore: '2099-01-01T00:00:00.000+08:00',
      })
      assert.strictEqual(dueRows.length, 3)

      const dueEntries = xrayCache.readCacheEntriesByRowIds(cachePath, dueRows)
      assert.strictEqual(dueEntries.length, 3)
      assert.ok(dueEntries.every(entry => typeof entry.nextCheckAt === 'string' && entry.nextCheckAt.length > 0))

      const selection = selectStage3RefreshCandidates(
        dueRows.map((rowId, index) => ({ rowId, entry: dueEntries[index] })),
        16
      )
      assert.strictEqual(selection.totalDueCount, 3)
      assert.strictEqual(selection.selected.length, 3)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('simulates repeated stage3 failures across rounds until deletion and tombstone retention', () => {
    if (!sqliteAvailable) {
      return
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-sidecar-xray-stage3-multi-round-'))
    const cachePath = path.join(tmpDir, 'nodes_cache.sqlite')

    try {
      const node = createNode('24.24.24.24', 80)
      const fingerprint = xrayCache.fingerprintNode(node)
      xrayCache.writeCache(cachePath, [{
        node,
        stable: true,
        delay: 33,
        source: 'background-probe',
        updatedAt: '2026-05-16T00:00:00.000+08:00',
        nextCheckAt: '2026-05-10T00:00:00.000+08:00',
        failureStreak: 0,
      }])

      const roundTimes = [
        '2026-05-20T00:00:00.000+08:00',
        '2026-05-28T00:00:00.000+08:00',
        '2026-06-28T00:00:00.000+08:00',
      ]

      for (let index = 0; index < roundTimes.length; index += 1) {
        const currentEntries = xrayCache.readCacheEntries(cachePath, { orderBy: 'default' })
        const result = applyStage3ProbeResults({
          cachePath,
          targetBatch: currentEntries,
          annotatedEntries: [],
          observedFingerprints: [fingerprint],
          cacheRefreshIntervalMs: 21600 * 1000,
          now: Date.parse(roundTimes[index]),
        })
        assert.strictEqual(xrayCache.writeCacheUpdates(cachePath, result.updatedEntries, currentEntries.map(entry => entry.node)), true)

        if (index < 2) {
          const remaining = xrayCache.readCacheEntries(cachePath)
          assert.strictEqual(remaining.length, 1)
          assert.strictEqual(remaining[0].failureStreak, index + 1)
        }
      }

      const remainingAfterThird = xrayCache.readCacheEntries(cachePath)
      assert.strictEqual(remainingAfterThird.length, 0)
      const outdatedSet = xrayCache.readOutdatedHashSet(cachePath, [fingerprint])
      assert.strictEqual(outdatedSet.has(fingerprint), true)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('keeps entries unchanged when stage3 results have only partial coverage', () => {
    if (!sqliteAvailable) {
      return
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-sidecar-xray-stage3-partial-'))
    const cachePath = path.join(tmpDir, 'nodes_cache.sqlite')

    try {
      const node1 = createNode('4.4.4.4', 80)
      const node2 = createNode('5.5.5.5', 80)
      const targetBatch = [
        {
          node: node1,
          stable: true,
          delay: 30,
          source: 'background-probe',
          updatedAt: '2026-05-16T00:00:00.000+08:00',
          nextCheckAt: '2026-05-10T00:00:00.000+08:00',
          failureStreak: 0,
        },
        {
          node: node2,
          stable: false,
          delay: null,
          source: 'background-probe',
          updatedAt: '2026-05-16T00:00:00.000+08:00',
          nextCheckAt: '2026-05-10T00:00:00.000+08:00',
          failureStreak: 1,
        },
      ]
      xrayCache.writeCache(cachePath, targetBatch)

      const result = applyStage3ProbeResults({
        cachePath,
        targetBatch,
        annotatedEntries: [{
          node: node1,
          stable: true,
          delay: 45,
          source: 'background-probe',
          updatedAt: '2026-05-20T00:00:00.000+08:00',
        }],
        observedFingerprints: [xrayCache.fingerprintNode(node1)],
        cacheRefreshIntervalMs: 21600 * 1000,
        now: Date.parse('2026-05-20T00:00:00.000+08:00'),
      })

      assert.strictEqual(result.availableCount, 1)
      assert.strictEqual(result.explicitFailureCount, 0)
      assert.strictEqual(result.removedCount, 0)
      assert.strictEqual(result.partialCoverageCount, 1)
      assert.strictEqual(result.updatedEntries.length, 2)
      const preservedEntry = result.updatedEntries.find(entry => entry.node.settings.servers[0].address === '5.5.5.5')
      assert.strictEqual(preservedEntry.failureStreak, 1)
      assert.strictEqual(preservedEntry.nextCheckAt, '2026-05-10T00:00:00.000+08:00')
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('keeps all entries unchanged when stage3 observes nothing and coverage is empty', () => {
    if (!sqliteAvailable) {
      return
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-sidecar-xray-stage3-empty-observe-'))
    const cachePath = path.join(tmpDir, 'nodes_cache.sqlite')

    try {
      const node1 = createNode('7.7.7.7', 80)
      const node2 = createNode('8.8.8.8', 80)
      const targetBatch = [
        {
          node: node1,
          stable: true,
          delay: 20,
          source: 'background-probe',
          updatedAt: '2026-05-16T00:00:00.000+08:00',
          nextCheckAt: '2026-05-10T00:00:00.000+08:00',
          failureStreak: 0,
        },
        {
          node: node2,
          stable: false,
          delay: null,
          source: 'background-probe',
          updatedAt: '2026-05-16T00:00:00.000+08:00',
          nextCheckAt: '2026-05-11T00:00:00.000+08:00',
          failureStreak: 2,
        },
      ]

      const result = applyStage3ProbeResults({
        cachePath,
        targetBatch,
        annotatedEntries: [],
        observedFingerprints: [],
        cacheRefreshIntervalMs: 21600 * 1000,
        now: Date.parse('2026-05-20T00:00:00.000+08:00'),
      })

      assert.strictEqual(result.availableCount, 0)
      assert.strictEqual(result.explicitFailureCount, 0)
      assert.strictEqual(result.removedCount, 0)
      assert.strictEqual(result.partialCoverageCount, 2)
      assert.deepStrictEqual(result.updatedEntries, targetBatch)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('cleans stale probe temp files while keeping unrelated files', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-sidecar-xray-probe-cleanup-'))
    const probeDir = path.join(tmpDir, 'probe')
    fs.mkdirSync(probeDir, { recursive: true })
    const staleConfig = path.join(probeDir, 'config-123.json')
    const staleEgress = path.join(probeDir, 'egress-456.json')
    const keepFile = path.join(probeDir, 'keep.txt')

    try {
      fs.writeFileSync(staleConfig, '{}')
      fs.writeFileSync(staleEgress, '{}')
      fs.writeFileSync(keepFile, 'keep')

      const removedCount = cleanupProbeArtifacts(tmpDir)
      assert.strictEqual(removedCount, 2)
      assert.strictEqual(fs.existsSync(staleConfig), false)
      assert.strictEqual(fs.existsSync(staleEgress), false)
      assert.strictEqual(fs.existsSync(keepFile), true)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('persists and matches local-input state by normalized manual node set', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-sidecar-xray-local-input-state-'))
    const cachePath = path.join(tmpDir, 'nodes_cache.sqlite')
    const statePath = getLocalInputStatePath(cachePath)

    try {
      const node1 = createNode('1.1.1.1', 80)
      const node2 = createNode('2.2.2.2', 80)

      const state = buildLocalInputState({ manualNodes: [node2, node1, node1] })
      assert.strictEqual(state.manualNodeCount, 2)
      assert.strictEqual(state.subscriptionCount, 0)
      assert.strictEqual(writeLocalInputState(statePath, state), true)

      const savedState = readLocalInputState(statePath)
      assert.ok(savedState)
      assert.strictEqual(savedState.signature, state.signature)
      assert.strictEqual(savedState.signatureVersion, state.signatureVersion)
      assert.strictEqual(savedState.semanticsVersion, state.semanticsVersion)
      assert.strictEqual(savedState.manualNodeCount, state.manualNodeCount)
      assert.strictEqual(savedState.subscriptionCount, state.subscriptionCount)
      assert.strictEqual(typeof savedState.updatedAt, 'string')

      const reorderedState = buildLocalInputState({ manualNodes: [node1, node2] })
      assert.strictEqual(isLocalInputStateMatch(savedState, reorderedState), true)

      const changedState = buildLocalInputState({ manualNodes: [node1] })
      assert.strictEqual(isLocalInputStateMatch(savedState, changedState), false)

      const changedSubscriptionState = buildLocalInputState({
        manualNodes: [node2, node1],
        subscriptions: ['https://example.com/a', 'https://example.com/a'],
      })
      assert.strictEqual(changedSubscriptionState.subscriptionCount, 2)
      assert.strictEqual(isLocalInputStateMatch(savedState, changedSubscriptionState), false)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('tracks subscription availability and only deletes stale unreferenced subscriptions', () => {
    if (!sqliteAvailable) {
      return
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-sidecar-xray-subscription-summary-'))
    const cachePath = path.join(tmpDir, 'nodes_cache.sqlite')

    try {
      const stableNode = createNode('1.1.1.1', 80)
      const unstableNode = createNode('2.2.2.2', 80)
      const stableKey = xrayCache.getNodeKey(stableNode)
      const unstableKey = xrayCache.getNodeKey(unstableNode)

      xrayCache.writeCache(cachePath, [
        {
          node: stableNode,
          stable: true,
          delay: 100,
          source: 'background-probe',
          updatedAt: '2026-05-16T00:00:00.000+08:00',
        },
        {
          node: unstableNode,
          stable: false,
          delay: null,
          source: 'source-sync',
          updatedAt: '2026-05-16T00:00:00.000+08:00',
        },
      ])

      const syncStats = xrayCache.syncSubscriptions(cachePath, [
        {
          url: 'https://example.com/stable',
          displayLabel: 'stable-sub',
          sortOrder: 1,
          nodeKeys: [stableKey, unstableKey],
        },
        {
          url: 'https://example.com/retained',
          displayLabel: 'retained-sub',
          sortOrder: 2,
          nodeKeys: [unstableKey],
        },
        {
          url: 'https://example.com/empty',
          displayLabel: 'empty-sub',
          sortOrder: 3,
          nodeKeys: [],
        },
      ], { staleAfterDays: 30, now: '2026-04-01T00:00:00.000+08:00' })
      assert.deepStrictEqual(syncStats, { configured: 3, unconfigured: 0, refs: 3 })

      const firstResult = xrayCache.updateSubscriptionAvailability(cachePath, {
        staleAfterDays: 30,
        availableNodeKeys: [stableKey],
        now: '2026-04-01T00:00:00.000+08:00',
      })
      assert.deepStrictEqual(firstResult.deleted, [])

      const staleResult = xrayCache.updateSubscriptionAvailability(cachePath, {
        staleAfterDays: 30,
        availableNodeKeys: [stableKey],
        now: '2026-05-10T00:00:00.000+08:00',
      })

      assert.strictEqual(staleResult.deleted.length, 1)
      const remainingLabels = staleResult.summary.map(row => row.displayLabel).sort()
      assert.deepStrictEqual(remainingLabels, ['retained-sub', 'stable-sub'])

      const stableSummary = staleResult.summary.find(row => row.displayLabel === 'stable-sub')
      assert.strictEqual(stableSummary.availableNodeCount, 1)
      assert.strictEqual(stableSummary.retainedNodeCount, 2)

      const retainedSummary = staleResult.summary.find(row => row.displayLabel === 'retained-sub')
      assert.strictEqual(retainedSummary.availableNodeCount, 0)
      assert.strictEqual(retainedSummary.retainedNodeCount, 1)
      // v2 stores zero_available_since as epoch seconds (INTEGER); the summary
      // returns it as a number, not an ISO timestamp string.
      assert.strictEqual(typeof retainedSummary.zeroAvailableSince, 'number')
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('keeps duplicate subscription URLs as separate configured entries by occurrence', () => {
    if (!sqliteAvailable) {
      return
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-sidecar-xray-duplicate-subscriptions-'))
    const cachePath = path.join(tmpDir, 'nodes_cache.sqlite')

    try {
      const node = createNode('9.9.9.9', 80)
      const nodeKey = xrayCache.getNodeKey(node)
      xrayCache.writeCache(cachePath, [{
        node,
        stable: true,
        delay: 20,
        source: 'background-probe',
        updatedAt: '2026-05-16T00:00:00.000+08:00',
      }])

      const url = 'https://example.com/duplicated'
      xrayCache.syncSubscriptions(cachePath, [
        {
          sourceKey: xrayCache.getSubscriptionSourceKey(url, 1),
          url,
          displayLabel: '[1/2] duplicated',
          sortOrder: 1,
          nodeKeys: [nodeKey],
        },
        {
          sourceKey: xrayCache.getSubscriptionSourceKey(url, 2),
          url,
          displayLabel: '[2/2] duplicated',
          sortOrder: 2,
          nodeKeys: [nodeKey],
        },
      ])

      const summary = xrayCache.readSubscriptionAvailabilitySummary(cachePath, {
        availableNodeKeys: [nodeKey],
      })
      assert.strictEqual(summary.length, 2)
      assert.deepStrictEqual(summary.map(row => row.availableNodeCount), [1, 1])
      assert.deepStrictEqual(summary.map(row => row.sortOrder), [1, 2])
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
