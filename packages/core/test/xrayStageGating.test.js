const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const xrayModule = require('../src/modules/plugin/xray')
const xrayCache = require('../src/modules/plugin/xray/cache')

const {
  buildLocalInputState,
  createCacheSyncPlan,
  getLocalInputStatePath,
  getSubscriptionSyncDecision,
  isCacheRefreshEnabled,
  isLocalInputStateMatch,
  readLocalInputState,
  writeLocalInputState,
} = xrayModule.__test

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

describe('xray stage gating', () => {
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
    assert.strictEqual(changedPlan.removedNodes.length, 1)
    assert.deepStrictEqual(changedPlan.removedNodes[0], node2)
    assert.strictEqual(changedStats.countryReadyCount, 1)
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
      assert.strictEqual(writeLocalInputState(statePath, state), true)

      const savedState = readLocalInputState(statePath)
      assert.ok(savedState)
      assert.strictEqual(savedState.signature, state.signature)
      assert.strictEqual(savedState.signatureVersion, state.signatureVersion)
      assert.strictEqual(savedState.semanticsVersion, state.semanticsVersion)
      assert.strictEqual(savedState.manualNodeCount, state.manualNodeCount)
      assert.strictEqual(typeof savedState.updatedAt, 'string')

      const reorderedState = buildLocalInputState({ manualNodes: [node1, node2] })
      assert.strictEqual(isLocalInputStateMatch(savedState, reorderedState), true)

      const changedState = buildLocalInputState({ manualNodes: [node1] })
      assert.strictEqual(isLocalInputStateMatch(savedState, changedState), false)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
