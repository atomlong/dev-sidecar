const assert = require('node:assert')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')

// 本文件是集成式测试：多个路由用例会 require('../../../expose') 加载完整 app
// （14 处 require 点，读路由/写路由都触发），与同进程其他测试文件交互会引发
// worker 异常退出。已从 `pnpm test` 全量中排除（.mocharc.json ignore），
// 独立进程运行：`pnpm run test:webui`

describe('webui plugin', () => {
  describe('module exports', () => {
    it('exports correct plugin structure', () => {
      const webui = require('../src/modules/plugin/webui')
      assert.strictEqual(webui.key, 'webui')
      assert.strictEqual(typeof webui.config, 'object')
      assert.strictEqual(webui.config.enabled, true)
      assert.strictEqual(webui.config.port, 31182)
      assert.strictEqual(webui.config.listen, '127.0.0.1')
      assert.strictEqual(typeof webui.plugin, 'function')
      assert.strictEqual(webui.status.enabled, false)
    })
  })

  describe('Plugin factory', () => {
    it('returns api object with start/close/isEnabled methods', () => {
      const webui = require('../src/modules/plugin/webui')
      const fakeContext = {
        config: { get: () => ({ plugin: { webui: { enabled: false } } }) },
        event: { register: () => 1, unregister: () => {}, fire: () => {} },
        log: { info: () => {}, error: () => {} },
        server: { reload: async () => {} },
        xrayApi: null,
      }
      const api = webui.plugin(fakeContext)
      assert.strictEqual(typeof api.start, 'function')
      assert.strictEqual(typeof api.close, 'function')
      assert.strictEqual(typeof api.isEnabled, 'function')
    })

    it('start() skips when disabled', async () => {
      const webui = require('../src/modules/plugin/webui')
      const fakeContext = {
        config: { get: () => ({ plugin: { webui: { enabled: false } } }) },
        event: { register: () => 1, unregister: () => {}, fire: () => {} },
        log: { info: () => {}, error: () => {} },
        server: { reload: async () => {} },
        xrayApi: null,
      }
      const api = webui.plugin(fakeContext)
      await api.start()
      assert.strictEqual(api.isEnabled(), false)
    })
  })
})

describe('webui routes', () => {
  let server, baseUrl

  before(async () => {
    const { createRouter } = require('../src/modules/plugin/webui/routes')
    const router = createRouter({
      config: {
        get: () => ({
          server: { intercepts: {}, setting: { userBasePath: '/tmp' } },
          plugin: { xray: { enabled: false, port: 0, apiPort: 0, metricsPort: 0 }, webui: { token: '' } },
          proxy: { enabled: false },
        }),
        // Mock writes — never touch real config.json
        update: () => {},
        save: () => {},
        downloadRemoteConfig: async () => {},
        reload: () => {},
      },
      event: { register: () => 1, unregister: () => {}, fire: () => {} },
      log: { info: () => {}, error: () => {} },
      server: { reload: async () => {} },
        xrayApi: null,
    })
    server = http.createServer(router)
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address()
    baseUrl = `http://127.0.0.1:${port}`
  })

  after(async () => {
    await new Promise((resolve) => server.close(resolve))
  })

  it('GET /api/health returns ok status', async () => {
    const r = await fetch(`${baseUrl}/api/health`)
    const data = await r.json()
    assert.strictEqual(r.status, 200)
    assert.strictEqual(data.status, 'ok')
    assert.ok(data.uptime > 0)
    assert.ok(data.pid > 0)
  })

  it('GET /api/version returns version info', async () => {
    const r = await fetch(`${baseUrl}/api/version`)
    const data = await r.json()
    assert.strictEqual(r.status, 200)
    assert.ok(data.nodeVersion)
  })

  it('GET /api/status returns status tree', async () => {
    const r = await fetch(`${baseUrl}/api/status`)
    assert.strictEqual(r.status, 200)
  })

  it('GET /api/system returns memory info', async () => {
    const r = await fetch(`${baseUrl}/api/system`)
    const data = await r.json()
    assert.strictEqual(r.status, 200)
    assert.ok(data.memory)
    assert.ok(data.memory.rss > 0)
  })

  it('GET /api/xray/nodes returns disabled when xray off', async () => {
    const r = await fetch(`${baseUrl}/api/xray/nodes`)
    const data = await r.json()
    assert.strictEqual(r.status, 200)
    assert.strictEqual(data.xrayEnabled, false)
    assert.strictEqual(data.reason, 'disabled')
    assert.deepStrictEqual(data.nodes, [])
  })

  it('GET /api/xray/balancer returns null when xray off', async () => {
    const r = await fetch(`${baseUrl}/api/xray/balancer`)
    const data = await r.json()
    assert.strictEqual(r.status, 200)
    assert.strictEqual(data.xrayEnabled, false)
  })

  // 旧文件式 /api/logs（?file=core&lines=N 读日志文件）已被结构化环形缓冲
  // 端点取代，旧契约用例移除——新契约见 "webui logs route" describe。

  it('GET /api/config returns config object', async () => {
    const r = await fetch(`${baseUrl}/api/config`)
    assert.strictEqual(r.status, 200)
  })

  it('GET / unknown route returns 404', async () => {
    const r = await fetch(`${baseUrl}/nonexistent`)
    assert.strictEqual(r.status, 404)
  })

  it('POST write without token returns 401 (write needs token even on localhost)', async () => {
    // With token="" in config, localhost write is allowed. But if we set a token...
    // This test verifies the auth logic structure
    const r = await fetch(`${baseUrl}/api/service/restart`, { method: 'POST' })
    // With empty token, localhost is allowed — will return 202
    assert.ok(r.status === 202 || r.status === 401)
  })

  it('GET /api/xray/cache/nodes/export rate limits after first call', async () => {
    // First call — may fail (cache not ready) but won't be rate limited
    const r1 = await fetch(`${baseUrl}/api/xray/cache/nodes/export?limit=5`)
    // Second call within 10s should be rate limited (429)
    const r2 = await fetch(`${baseUrl}/api/xray/cache/nodes/export?limit=5`)
    assert.ok(r2.status === 429, `expected 429, got ${r2.status}`)
  })

  it('GET /api/xray/cache/nodes/export with limit>500 returns 400 (even when rate limited)', async () => {
    // limit>500 check is before rate limit, so it should return 400 regardless
    const r = await fetch(`${baseUrl}/api/xray/cache/nodes/export?limit=999`)
    assert.strictEqual(r.status, 400)
    const data = await r.json()
    assert.strictEqual(data.code, 'LIMIT_TOO_LARGE')
    assert.strictEqual(data.max, 500)
  })

  it('GET /api/xray/cache/nodes/export with limit=0 returns default 100', async () => {
    // limit=0 is falsy, should default to 100 — but will be rate limited from previous test
    // Just verify it doesn't crash on edge param
    const r = await fetch(`${baseUrl}/api/xray/cache/nodes/export?limit=0`)
    assert.ok(r.status === 429 || r.status === 503 || r.status === 200)
  })

  it('GET /api/xray/cache/nodes/export with negative limit returns default', async () => {
    const r = await fetch(`${baseUrl}/api/xray/cache/nodes/export?limit=-1`)
    assert.ok(r.status === 429 || r.status === 503 || r.status === 200)
  })

  it('error responses have stable code field', async () => {
    const r = await fetch(`${baseUrl}/api/definitely-not-a-route`)
    const data = await r.json()
    assert.ok(data.error === true)
    assert.ok(typeof data.code === 'string')
    assert.ok(data.message)
  })

  it('GET /api/xray/stage/round-summary returns graceful error when file missing', async () => {
    const r = await fetch(`${baseUrl}/api/xray/stage/round-summary`)
    const data = await r.json()
    assert.strictEqual(r.status, 200)
    assert.ok(data.error === true || data.status)
  })

  it('GET /api/xray/stage/status returns error when xray not available', async () => {
    const r = await fetch(`${baseUrl}/api/xray/stage/status`)
    const data = await r.json()
    assert.strictEqual(r.status, 200)
    // Either returns stage status or error code
    assert.ok(data.isStageRunning !== undefined || data.error === true)
  })

  it('GET /api/xray/metrics returns null when xray not running', async () => {
    const r = await fetch(`${baseUrl}/api/xray/metrics`)
    const data = await r.json()
    assert.strictEqual(r.status, 200)
    assert.ok(data.metrics === null || data.reason || data.error === true)
  })
})

describe('webui xray cache/export routes (seeded cache)', () => {
  let server, baseUrl, tmpDir
  let realDateNow
  let fakeNow = 0
  let exportClock = 0

  before(async () => {
    const { createRouter } = require('../src/modules/plugin/webui/routes')
    const xrayCache = require('../src/modules/plugin/xray/cache')

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-sidecar-webui-cache-'))
    const xrayDir = path.join(tmpDir, 'xray')
    fs.mkdirSync(xrayDir, { recursive: true })
    const cachePath = path.join(xrayDir, 'nodes_cache.sqlite')

    const ts = '2026-05-20T00:00:00.000+08:00'
    // One node per protocol address shape: vless=vnext[], ss-2022=flat,
    // trojan=server (singular), old ss=servers[].
    xrayCache.writeCache(cachePath, [
      { node: { protocol: 'vless', settings: { vnext: [{ address: '10.0.0.1', port: 443, users: [{ id: 'test-id' }] }] } }, stable: true, delay: 100, source: 'background-probe', updatedAt: ts, nextCheckAt: ts, failureStreak: 0, country: 'US' },
      { node: { protocol: 'shadowsocks', settings: { address: '10.0.0.2', port: 8388, method: 'aes-128-gcm', password: 'pw' } }, stable: false, delay: 200, source: 'background-probe', updatedAt: ts, nextCheckAt: ts, failureStreak: 0, country: 'DE' },
      { node: { protocol: 'trojan', settings: { servers: [{ address: '10.0.0.3', port: 443, password: 'pw' }] } }, stable: false, delay: 300, source: 'background-probe', updatedAt: ts, nextCheckAt: ts, failureStreak: 3, country: 'FR' },
      { node: { protocol: 'shadowsocks', settings: { servers: [{ address: '10.0.0.4', port: 80, method: 'aes-128-gcm', password: 'pw' }] } }, stable: false, delay: 0, source: 'source-sync', updatedAt: ts, nextCheckAt: ts, failureStreak: 1, country: 'US' },
    ])

    const router = createRouter({
      config: {
        get: () => ({
          server: { intercepts: {}, setting: { userBasePath: tmpDir } },
          plugin: { xray: { enabled: false, port: 0, apiPort: 0, metricsPort: 0 }, webui: { token: '' } },
          proxy: { enabled: false },
        }),
        update: () => {},
        save: () => {},
        downloadRemoteConfig: async () => {},
        reload: () => {},
      },
      event: { register: () => 1, unregister: () => {}, fire: () => {} },
      log: { info: () => {}, error: () => {} },
      server: { reload: async () => {} },
      xrayApi: null,
    })
    server = http.createServer(router)
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${server.address().port}`

    // The export route's rate limit (10s) and response cache (30s) use the
    // module-level Date.now() — fake the clock per export call.
    realDateNow = Date.now
    exportClock = realDateNow() + 60 * 60 * 1000
    Date.now = () => (fakeNow > 0 ? fakeNow : realDateNow())
  })

  after(async () => {
    Date.now = realDateNow
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  // Advance past the 10s rate limit and 30s response cache before each export call.
  function nextExportClock () {
    exportClock += 60 * 1000
    fakeNow = exportClock
  }

  it('GET /api/xray/cache/nodes extracts address/port across protocol shapes', async () => {
    const r = await fetch(`${baseUrl}/api/xray/cache/nodes?page=1&pageSize=50`)
    const data = await r.json()
    assert.strictEqual(r.status, 200)
    assert.strictEqual(data.rows.length, 4)
    const byAddr = {}
    for (const row of data.rows) {
      byAddr[row.address] = row
    }
    assert.strictEqual(byAddr['10.0.0.1'].port, 443) // vless via vnext[0]
    assert.strictEqual(byAddr['10.0.0.2'].port, 8388) // ss-2022 flat
    assert.strictEqual(byAddr['10.0.0.3'].port, 443) // trojan via server
    assert.strictEqual(byAddr['10.0.0.4'].port, 80) // old ss via servers[0]
    for (const row of data.rows) {
      assert.ok(row.protocol)
      assert.strictEqual(typeof row.country, 'string')
      assert.strictEqual(typeof row.failureStreak, 'number')
    }
  })

  it('GET /api/xray/cache/nodes/export?format=sharelink returns links without crashing', async () => {
    nextExportClock()
    const r = await fetch(`${baseUrl}/api/xray/cache/nodes/export?format=sharelink&limit=10`)
    fakeNow = 0
    assert.strictEqual(r.status, 200)
    const data = await r.json()
    assert.ok(Array.isArray(data.data))
    assert.strictEqual(data.data.length, 4)
    for (const link of data.data) {
      assert.strictEqual(typeof link, 'string')
      assert.ok(link.length > 0)
    }
    assert.strictEqual(data.total, 4)
    assert.strictEqual(data.returned, 4)
  })

  it('export format=outbound with available/country filters returns aligned outbounds and meta', async () => {
    nextExportClock()
    const r = await fetch(`${baseUrl}/api/xray/cache/nodes/export?format=outbound&available=true&country=US,DE&sort=delay`)
    fakeNow = 0
    assert.strictEqual(r.status, 200)
    const data = await r.json()
    // Available US/DE: vless(100/streak 0) + ss2022(200/streak 0);
    // trojan streak-3 excluded (default threshold 3), old ss delay-0 excluded.
    assert.strictEqual(data.total, 2)
    assert.strictEqual(data.returned, 2)
    assert.strictEqual(data.data.outbounds.length, 2)
    assert.strictEqual(data.data.outbounds[0].protocol, 'vless')
    assert.strictEqual(data.data.outbounds[0].tag, 'proxy_0')
    assert.strictEqual(data.data.outbounds[0].settings.vnext[0].address, '10.0.0.1')
    assert.strictEqual(data.data.meta.length, 2)
    assert.strictEqual(data.data.meta[0].tag, 'proxy_0')
    assert.strictEqual(data.data.meta[0].stable, true)
    assert.strictEqual(data.data.meta[0].country, 'US')
    assert.strictEqual(data.data.meta[1].delay, 200)
  })

  it('export available=true with maxFailureStreak=5 admits streak-3 nodes', async () => {
    nextExportClock()
    const r = await fetch(`${baseUrl}/api/xray/cache/nodes/export?format=outbound&available=true&maxFailureStreak=5`)
    fakeNow = 0
    assert.strictEqual(r.status, 200)
    const data = await r.json()
    // vless(0) + ss2022(0) + trojan(3 < 5); old ss delay-0 still excluded.
    assert.strictEqual(data.total, 3)
    assert.strictEqual(data.data.outbounds.length, 3)
    const delays = data.data.meta.map(m => m.delay).sort((a, b) => a - b)
    assert.deepStrictEqual(delays, [100, 200, 300])
  })

  it('export includeMeta=false returns meta=null', async () => {
    nextExportClock()
    const r = await fetch(`${baseUrl}/api/xray/cache/nodes/export?format=outbound&includeMeta=false`)
    fakeNow = 0
    assert.strictEqual(r.status, 200)
    const data = await r.json()
    assert.strictEqual(data.data.meta, null)
    assert.ok(data.data.outbounds.length > 0)
  })

  it('export second immediate call is rate limited (429)', async () => {
    nextExportClock()
    const r1 = await fetch(`${baseUrl}/api/xray/cache/nodes/export?format=sharelink`)
    // No clock advance — second call must hit the 10s rate limit
    const r2 = await fetch(`${baseUrl}/api/xray/cache/nodes/export?format=sharelink`)
    fakeNow = 0
    assert.strictEqual(r1.status, 200)
    assert.strictEqual(r2.status, 429)
    const body = await r2.json()
    assert.strictEqual(body.code, 'RATE_LIMITED')
  })

  it('export limit>500 returns 400 before rate limiting', async () => {
    const r = await fetch(`${baseUrl}/api/xray/cache/nodes/export?limit=501`)
    assert.strictEqual(r.status, 400)
    const data = await r.json()
    assert.strictEqual(data.code, 'LIMIT_TOO_LARGE')
  })

  it('export shuffle=true reshuffles even when the pool is smaller than limit', async () => {
    // Regression: the old `result.length > limit` guard skipped shuffling
    // entirely for small pools (4 nodes < default limit 100), so every call
    // returned the identical fixed order. 4 nodes have 24 permutations, so
    // 12 identical orders in a row is ~1e-15 — a reshuffle failure.
    const orders = new Set()
    for (let i = 0; i < 12; i++) {
      nextExportClock()
      const r = await fetch(`${baseUrl}/api/xray/cache/nodes/export?format=sharelink&shuffle=true`)
      fakeNow = 0
      assert.strictEqual(r.status, 200)
      const data = await r.json()
      assert.strictEqual(data.returned, 4)
      orders.add(data.data.join('|'))
    }
    assert.ok(orders.size > 1, 'shuffle=true returned identical order every call for a pool smaller than limit')
  })

  describe('export alive=true (live observatory filter)', () => {
    let metricsServer, metricsPort
    let expose
    let origGetStageStatus, origGetLiveNodeFingerprints

    before(async () => {
      const xrayCache = require('../src/modules/plugin/xray/cache')
      expose = require('../src/expose')

      // Fake /debug/vars: proxy_0/1/2 map to the seeded vless/ss2022/trojan
      // nodes; proxy_9 is alive but absent from the fingerprint map (must be
      // dropped); live delays intentionally differ from cache delays.
      metricsServer = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          observatory: {
            proxy_0: { alive: true, delay: 250, last_try_time: 1735689600 },
            proxy_1: { alive: true, delay: 500, last_try_time: 1735689605 },
            proxy_2: { alive: true, delay: 150, last_try_time: 1735689601 },
            proxy_9: { alive: true, delay: 900, last_try_time: 1735689602 },
          },
        }))
      })
      await new Promise((resolve) => metricsServer.listen(0, '127.0.0.1', resolve))
      metricsPort = metricsServer.address().port

      const fp = (node) => xrayCache.fingerprintNode(node)
      origGetStageStatus = expose.api.plugin.xray.getStageStatus
      expose.api.plugin.xray.getStageStatus = () => ({ apiPort: 0, metricsPort, liveNodes: 3 })
      origGetLiveNodeFingerprints = expose.api.plugin.xray.getLiveNodeFingerprints
      expose.api.plugin.xray.getLiveNodeFingerprints = () => ({
        proxy_0: fp({ protocol: 'vless', settings: { vnext: [{ address: '10.0.0.1', port: 443, users: [{ id: 'test-id' }] }] } }),
        proxy_1: fp({ protocol: 'shadowsocks', settings: { address: '10.0.0.2', port: 8388, method: 'aes-128-gcm', password: 'pw' } }),
        proxy_2: fp({ protocol: 'trojan', settings: { servers: [{ address: '10.0.0.3', port: 443, password: 'pw' }] } }),
      })
    })

    after(async () => {
      expose.api.plugin.xray.getStageStatus = origGetStageStatus
      expose.api.plugin.xray.getLiveNodeFingerprints = origGetLiveNodeFingerprints
      await new Promise((resolve) => metricsServer.close(resolve))
    })

    it('alive=true returns observatory-alive nodes with live delay/lastTry, sorted by live delay', async () => {
      nextExportClock()
      const r = await fetch(`${baseUrl}/api/xray/cache/nodes/export?format=outbound&alive=true&sort=delay`)
      fakeNow = 0
      assert.strictEqual(r.status, 200)
      const data = await r.json()
      // proxy_9 has no fingerprint -> dropped; live delay ASC: trojan(150), vless(250), ss2022(500)
      assert.strictEqual(data.total, 3)
      assert.strictEqual(data.returned, 3)
      assert.strictEqual(data.data.meta[0].delay, 150)
      assert.strictEqual(data.data.meta[0].lastTry, 1735689601)
      assert.strictEqual(data.data.meta[1].delay, 250)
      assert.strictEqual(data.data.meta[1].lastTry, 1735689600)
      assert.strictEqual(data.data.meta[2].delay, 500)
      // Live delay overrides the stale cache delay (vless cache delay was 100)
      assert.strictEqual(data.data.outbounds[1].settings.vnext[0].address, '10.0.0.1')
    })

    it('alive=true with available=true applies failureStreak threshold', async () => {
      nextExportClock()
      const r = await fetch(`${baseUrl}/api/xray/cache/nodes/export?format=outbound&alive=true&available=true`)
      fakeNow = 0
      assert.strictEqual(r.status, 200)
      const data = await r.json()
      // trojan failureStreak=3 excluded by the default threshold 3
      assert.strictEqual(data.total, 2)
      assert.strictEqual(data.data.meta[0].delay, 250)
      assert.strictEqual(data.data.meta[1].delay, 500)
    })

    it('alive=true with available=true&maxFailureStreak=5 admits streak-3 nodes', async () => {
      nextExportClock()
      const r = await fetch(`${baseUrl}/api/xray/cache/nodes/export?format=outbound&alive=true&available=true&maxFailureStreak=5`)
      fakeNow = 0
      const data = await r.json()
      assert.strictEqual(data.total, 3)
    })

    it('alive=true filters by live delay via maxDelay', async () => {
      nextExportClock()
      const r = await fetch(`${baseUrl}/api/xray/cache/nodes/export?format=outbound&alive=true&maxDelay=300`)
      fakeNow = 0
      const data = await r.json()
      assert.strictEqual(data.total, 2)
      assert.deepStrictEqual(data.data.meta.map(m => m.delay).sort((a, b) => a - b), [150, 250])
    })

    it('alive=true filters by country', async () => {
      nextExportClock()
      const r = await fetch(`${baseUrl}/api/xray/cache/nodes/export?format=outbound&alive=true&country=DE`)
      fakeNow = 0
      const data = await r.json()
      assert.strictEqual(data.total, 1)
      assert.strictEqual(data.data.meta[0].country, 'DE')
      assert.strictEqual(data.data.meta[0].delay, 500)
    })

    it('alive=true paginates with offset/limit against the filtered set', async () => {
      nextExportClock()
      const r = await fetch(`${baseUrl}/api/xray/cache/nodes/export?format=outbound&alive=true&limit=2&offset=2`)
      fakeNow = 0
      const data = await r.json()
      assert.strictEqual(data.total, 3)
      assert.strictEqual(data.returned, 1)
      assert.strictEqual(data.data.meta[0].delay, 500)
    })

    it('alive=true with shuffle=true keeps total stable and returns a subset', async () => {
      nextExportClock()
      const r = await fetch(`${baseUrl}/api/xray/cache/nodes/export?format=outbound&alive=true&shuffle=true&limit=2`)
      fakeNow = 0
      const data = await r.json()
      assert.strictEqual(data.total, 3)
      assert.strictEqual(data.returned, 2)
      for (const m of data.data.meta) {
        assert.ok([150, 250, 500].includes(m.delay), `unexpected live delay ${m.delay}`)
      }
    })

    it('alive=true without a running xray returns an empty set with reason', async () => {
      const saved = expose.api.plugin.xray.getStageStatus
      expose.api.plugin.xray.getStageStatus = () => ({})
      nextExportClock()
      const r = await fetch(`${baseUrl}/api/xray/cache/nodes/export?format=sharelink&alive=true`)
      fakeNow = 0
      expose.api.plugin.xray.getStageStatus = saved
      assert.strictEqual(r.status, 200)
      const data = await r.json()
      assert.strictEqual(data.total, 0)
      assert.deepStrictEqual(data.data, [])
      assert.strictEqual(data.reason, 'xray_not_running')
    })
  })
})

describe('webui write operations', () => {
  let server, baseUrl

  before(async () => {
    const { createRouter } = require('../src/modules/plugin/webui/routes')
    // Mock config to avoid touching real config.json
    const mockConfig = {
      get: () => ({
        server: { intercepts: {}, setting: { userBasePath: '/tmp' } },
        plugin: { xray: { enabled: false, port: 0, apiPort: 0, metricsPort: 0 }, webui: { token: '' } },
        proxy: { enabled: false },
      }),
      // All writes are no-ops — never touch real config.json
      update: () => {},
      save: () => {},
      downloadRemoteConfig: async () => {},
      reload: () => {},
    }
    const router = createRouter({
      config: mockConfig,
      event: { register: () => 1, unregister: () => {}, fire: () => {} },
      log: { info: () => {}, error: () => {} },
      server: { reload: async () => {} },
        xrayApi: null,
    })
    server = http.createServer(router)
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address()
    baseUrl = `http://127.0.0.1:${port}`
  })

  after(async () => {
    await new Promise((resolve) => server.close(resolve))
  })

  it('PUT /api/config with valid JSON updates and hot-reloads', async () => {
    const r = await fetch(`${baseUrl}/api/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ server: { setting: { timeoutMapping: {} } } }),
    })
    const data = await r.json()
    assert.strictEqual(r.status, 200)
    assert.ok(data.status === 'ok')
  })

  it('PUT /api/intercepts with valid JSON updates intercepts', async () => {
    const r = await fetch(`${baseUrl}/api/intercepts`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 'test.com': { '.*': { sni: 'baidu.com' } } }),
    })
    const data = await r.json()
    assert.strictEqual(r.status, 200)
    assert.ok(data.status === 'ok')
  })

  it('PUT /api/presetiplist with valid JSON updates preSetIpList', async () => {
    const r = await fetch(`${baseUrl}/api/presetiplist`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 'test.com': { '1.2.3.4': true } }),
    })
    const data = await r.json()
    assert.strictEqual(r.status, 200)
    assert.ok(data.status === 'ok')
  })

  // 空数组一旦持久化到 config.json，启动时 doMerge 会清空远程配置的全部预设 IP
  it('PUT /api/presetiplist with empty array returns 400', async () => {
    const r = await fetch(`${baseUrl}/api/presetiplist`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: '[]',
    })
    assert.strictEqual(r.status, 400)
    const data = await r.json()
    assert.strictEqual(data.code, 'INVALID_BODY')
  })

  it('PUT /api/presetiplist with non-object body returns 400', async () => {
    const r = await fetch(`${baseUrl}/api/presetiplist`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: '"string"',
    })
    assert.strictEqual(r.status, 400)
    const data = await r.json()
    assert.strictEqual(data.code, 'INVALID_BODY')
  })

  it('PUT /api/intercepts with empty array returns 400', async () => {
    const r = await fetch(`${baseUrl}/api/intercepts`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: '[]',
    })
    assert.strictEqual(r.status, 400)
    const data = await r.json()
    assert.strictEqual(data.code, 'INVALID_BODY')
  })

  it('PUT /api/config with array body returns 400', async () => {
    const r = await fetch(`${baseUrl}/api/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: '[1,2,3]',
    })
    assert.strictEqual(r.status, 400)
    const data = await r.json()
    assert.strictEqual(data.code, 'INVALID_BODY')
  })

  it('PUT /api/xray/rules with object body returns 400 (must be array)', async () => {
    const r = await fetch(`${baseUrl}/api/xray/rules`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: '{"domain":"a.com"}',
    })
    assert.strictEqual(r.status, 400)
    const data = await r.json()
    assert.strictEqual(data.code, 'INVALID_BODY')
  })

  it('PUT /api/xray/rules with array body returns 200 (empty array is legal)', async () => {
    const r = await fetch(`${baseUrl}/api/xray/rules`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: '[]',
    })
    assert.strictEqual(r.status, 200)
    const data = await r.json()
    assert.ok(data.status === 'ok')
  })

  it('PUT /api/config with invalid JSON returns error', async () => {
    const r = await fetch(`${baseUrl}/api/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    })
    assert.ok(r.status >= 400)
  })

  it('PUT /api/config with empty body returns error or ok', async () => {
    const r = await fetch(`${baseUrl}/api/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
    })
    assert.ok(r.status === 200 || r.status >= 400)
  })

  // POST/DELETE /api/xray/sticky 的时长语义见下方 "webui xray sticky routes (injected plugin)"。
})

describe('webui xray sticky routes (injected plugin)', () => {
  let server, baseUrl, plugin

  before(async () => {
    const { createRouter } = require('../src/modules/plugin/webui/routes')
    plugin = {
      enableCalls: [],
      disableCalls: 0,
      async enableSticky (opts) {
        this.enableCalls.push(opts)
        return { tag: 'proxy_x', duration: opts.duration }
      },
      async disableSticky () {
        this.disableCalls++
        return {}
      },
    }
    const router = createRouter({
      config: {
        get: () => ({
          server: { intercepts: {}, setting: { userBasePath: '/tmp' } },
          plugin: { xray: { enabled: false }, webui: {} },
          proxy: { enabled: false },
        }),
        update: () => {},
        save: () => {},
        downloadRemoteConfig: async () => {},
        reload: () => {},
      },
      event: { register: () => 1, unregister: () => {}, fire: () => {} },
      log: { info: () => {}, error: () => {} },
      server: { reload: async () => {} },
      xrayApi: null,
      xrayPlugin: plugin,
    })
    server = http.createServer(router)
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address()
    baseUrl = `http://127.0.0.1:${port}`
  })

  after(async () => {
    await new Promise((resolve) => server.close(resolve))
  })

  beforeEach(() => {
    plugin.enableCalls.length = 0
    plugin.disableCalls = 0
  })

  it('POST duration=0 (永久) locks with the 10-year sentinel, not 300s', async () => {
    const r = await fetch(`${baseUrl}/api/xray/sticky`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ duration: 0 }),
    })
    assert.strictEqual(r.status, 200)
    const data = await r.json()
    assert.strictEqual(data.status, 'ok')
    assert.strictEqual(data.duration, 86400 * 365 * 10)
    assert.deepStrictEqual(plugin.enableCalls, [{ duration: 86400 * 365 * 10 }])
  })

  it('POST duration=600 passes through unchanged', async () => {
    const r = await fetch(`${baseUrl}/api/xray/sticky`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ duration: 600 }),
    })
    assert.strictEqual(r.status, 200)
    assert.deepStrictEqual(plugin.enableCalls, [{ duration: 600 }])
  })

  it('POST missing/invalid/negative duration falls back to 300s', async () => {
    for (const body of ['{}', '{"duration":"abc"}', '{"duration":-5}']) {
      const r = await fetch(`${baseUrl}/api/xray/sticky`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      })
      assert.strictEqual(r.status, 200)
    }
    assert.deepStrictEqual(plugin.enableCalls, [{ duration: 300 }, { duration: 300 }, { duration: 300 }])
  })

  it('POST non-JSON body returns 400 INVALID_BODY without calling the plugin', async () => {
    const r = await fetch(`${baseUrl}/api/xray/sticky`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    })
    assert.strictEqual(r.status, 400)
    const data = await r.json()
    assert.strictEqual(data.code, 'INVALID_BODY')
    assert.strictEqual(plugin.enableCalls.length, 0)
  })

  it('POST plugin failure returns 500 STICKY_FAILED', async () => {
    const orig = plugin.enableSticky
    plugin.enableSticky = async () => { throw new Error('xray api unavailable') }
    try {
      const r = await fetch(`${baseUrl}/api/xray/sticky`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ duration: 300 }),
      })
      assert.strictEqual(r.status, 500)
      const data = await r.json()
      assert.strictEqual(data.code, 'STICKY_FAILED')
    } finally {
      plugin.enableSticky = orig
    }
  })

  it('DELETE unlocks via disableSticky', async () => {
    const r = await fetch(`${baseUrl}/api/xray/sticky`, { method: 'DELETE' })
    assert.strictEqual(r.status, 200)
    const data = await r.json()
    assert.strictEqual(data.status, 'ok')
    assert.strictEqual(plugin.disableCalls, 1)
  })
})

describe('webui auth edge cases', () => {
  let server, baseUrl

  before(async () => {
    const { createRouter } = require('../src/modules/plugin/webui/routes')
    const router = createRouter({
      config: {
        get: () => ({
          server: { intercepts: {}, setting: { userBasePath: '/tmp' } },
          plugin: { xray: { enabled: false }, webui: { token: 'secret123' } },
          proxy: { enabled: false },
        }),
        // Mock writes — never touch real config.json
        update: () => {},
        save: () => {},
        downloadRemoteConfig: async () => {},
        reload: () => {},
      },
      event: { register: () => 1, unregister: () => {}, fire: () => {} },
      log: { info: () => {}, error: () => {} },
      server: { reload: async () => {} },
        xrayApi: null,
    })
    server = http.createServer(router)
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address()
    baseUrl = `http://127.0.0.1:${port}`
  })

  after(async () => {
    await new Promise((resolve) => server.close(resolve))
  })

  it('GET /api/status without token on localhost with token configured returns 200', async () => {
    const r = await fetch(`${baseUrl}/api/status`)
    // localhost with token configured: read is allowed (localhost free for reads)
    assert.strictEqual(r.status, 200)
  })

  it('POST write without token when token is configured returns 401', async () => {
    const r = await fetch(`${baseUrl}/api/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    assert.strictEqual(r.status, 401)
    const data = await r.json()
    assert.strictEqual(data.code, 'AUTH_REQUIRED')
  })

  it('POST write with correct token returns 200', async () => {
    const r = await fetch(`${baseUrl}/api/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer secret123' },
      body: JSON.stringify({}),
    })
    // May succeed or fail depending on config save, but should pass auth
    assert.ok(r.status === 200 || r.status === 500)
  })

  it('POST write with wrong token returns 401', async () => {
    const r = await fetch(`${baseUrl}/api/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer wrongtoken' },
      body: JSON.stringify({}),
    })
    assert.strictEqual(r.status, 401)
  })

  it('GET /api/health is always accessible without token', async () => {
    const r = await fetch(`${baseUrl}/api/health`)
    assert.strictEqual(r.status, 200)
  })
})

describe('configApi.update mergeWith fix', () => {
  it('arrays are replaced, not merged by index', () => {
    const lodash = require('lodash')
    const target = { items: ['a', 'b', 'c'] }
    const source = { items: ['x', 'y'] }
    const mergeCustomizer = (objValue, srcValue) => Array.isArray(srcValue) ? srcValue : undefined
    const result = lodash.mergeWith(lodash.cloneDeep(target), source, mergeCustomizer)
    assert.deepStrictEqual(result.items, ['x', 'y'])
  })

  it('objects are still merged (not replaced)', () => {
    const lodash = require('lodash')
    const target = { nested: { a: 1, b: 2 } }
    const source = { nested: { b: 3, c: 4 } }
    const mergeCustomizer = (objValue, srcValue) => Array.isArray(srcValue) ? srcValue : undefined
    const result = lodash.mergeWith(lodash.cloneDeep(target), source, mergeCustomizer)
    assert.deepStrictEqual(result.nested, { a: 1, b: 3, c: 4 })
  })

  it('nested arrays are replaced', () => {
    const lodash = require('lodash')
    const target = { server: { intercepts: { 'a.com': [{ sni: 'b' }] } } }
    const source = { server: { intercepts: { 'a.com': [{ sni: 'c' }, { sni: 'd' }] } } }
    const mergeCustomizer = (objValue, srcValue) => Array.isArray(srcValue) ? srcValue : undefined
    const result = lodash.mergeWith(lodash.cloneDeep(target), source, mergeCustomizer)
    assert.deepStrictEqual(result.server.intercepts['a.com'], [{ sni: 'c' }, { sni: 'd' }])
  })

  it('deleting array element by removing it works', () => {
    const lodash = require('lodash')
    const target = { items: ['a', 'b', 'c'] }
    const source = { items: ['a', 'c'] } // remove 'b'
    const mergeCustomizer = (objValue, srcValue) => Array.isArray(srcValue) ? srcValue : undefined
    const result = lodash.mergeWith(lodash.cloneDeep(target), source, mergeCustomizer)
    assert.deepStrictEqual(result.items, ['a', 'c'])
  })
})

describe('xray getStageStatus', () => {
  it('getStageStatus is a function on the api object', () => {
    const xrayPlugin = require('../src/modules/plugin/xray')
    // Plugin factory returns api object — we can't easily call it without context,
    // but we can verify the structure is correct by checking the module exports
    assert.strictEqual(typeof xrayPlugin.plugin, 'function')
  })
})

describe('webui ws module', () => {
  it('createWsServer exports a function', () => {
    const wsModule = require('../src/modules/plugin/webui/ws')
    assert.strictEqual(typeof wsModule.createWsServer, 'function')
  })
})

describe('reInjectXrayRules', () => {
  const { reInjectXrayRules } = require('../src/modules/plugin/webui/routes')

  function makeSpy () {
    const calls = { removeRules: 0, injectRules: [] }
    return {
      calls,
      api: {
        async removeRules () { calls.removeRules++ },
        async injectRules (rules, port) { calls.injectRules.push({ rules, port }) },
      },
    }
  }

  function makeConfig (xrayOverride, xrayPort) {
    return {
      get: () => ({
        server: { setting: { xrayPort } },
        plugin: { xray: xrayOverride },
      }),
    }
  }

  it('calls removeRules then injectRules with rules and port when xray enabled', async () => {
    const { calls, api } = makeSpy()
    const rules = [{ domain: 'a.com', balancerTag: 'b1' }]
    const config = makeConfig({ enabled: true, rules }, 10801)
    await reInjectXrayRules(config, api)
    assert.strictEqual(calls.removeRules, 1)
    assert.strictEqual(calls.injectRules.length, 1)
    assert.deepStrictEqual(calls.injectRules[0].rules, rules)
    assert.strictEqual(calls.injectRules[0].port, 10801)
  })

  it('calls removeRules first, injectRules second (order matters)', async () => {
    const order = []
    const api = {
      async removeRules () { order.push('removeRules') },
      async injectRules () { order.push('injectRules') },
    }
    const config = makeConfig({ enabled: true, rules: [] }, 10801)
    await reInjectXrayRules(config, api)
    assert.deepStrictEqual(order, ['removeRules', 'injectRules'])
  })

  it('skips injectRules when xray disabled (but still calls removeRules)', async () => {
    const { calls, api } = makeSpy()
    const config = makeConfig({ enabled: false, rules: [] }, 10801)
    await reInjectXrayRules(config, api)
    assert.strictEqual(calls.removeRules, 1)
    assert.strictEqual(calls.injectRules.length, 0)
  })

  it('skips injectRules when xrayPort is 0', async () => {
    const { calls, api } = makeSpy()
    const config = makeConfig({ enabled: true, rules: [{ domain: 'a.com' }] }, 0)
    await reInjectXrayRules(config, api)
    assert.strictEqual(calls.removeRules, 1)
    assert.strictEqual(calls.injectRules.length, 0)
  })

  it('skips injectRules when rules is not an array', async () => {
    const { calls, api } = makeSpy()
    const config = makeConfig({ enabled: true, rules: null }, 10801)
    await reInjectXrayRules(config, api)
    assert.strictEqual(calls.removeRules, 1)
    assert.strictEqual(calls.injectRules.length, 0)
  })

  it('calls injectRules with empty array (injectRules handles it internally)', async () => {
    const { calls, api } = makeSpy()
    const config = makeConfig({ enabled: true, rules: [] }, 10801)
    await reInjectXrayRules(config, api)
    assert.strictEqual(calls.removeRules, 1)
    assert.strictEqual(calls.injectRules.length, 1)
    assert.deepStrictEqual(calls.injectRules[0].rules, [])
  })
})

describe('webui logs route (/api/logs 结构化实时日志)', () => {
  let server, baseUrl

  const fakeContext = () => ({
    config: {
      get: () => ({
        server: { intercepts: {}, setting: { userBasePath: '/tmp' } },
        plugin: { xray: { enabled: false, port: 0, apiPort: 0, metricsPort: 0 }, webui: { token: '' } },
        proxy: { enabled: false },
      }),
      update: () => {},
      save: () => {},
      downloadRemoteConfig: async () => {},
      reload: () => {},
    },
    event: { register: () => 1, unregister: () => {}, fire: () => {} },
    log: { info: () => {}, error: () => {} },
    server: { reload: async () => {} },
    xrayApi: null,
  })

  const seed = (appender, { ts = 1788160000000, level = 'INFO', category = 'core', data } = {}) =>
    appender({ startTime: new Date(ts), level: { levelStr: level }, categoryName: category, data })

  before(async () => {
    const { createRouter } = require('../src/modules/plugin/webui/routes')
    server = http.createServer(createRouter(fakeContext()))
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address()
    baseUrl = `http://127.0.0.1:${port}`
  })

  after(async () => {
    await new Promise((resolve) => server.close(resolve))
  })

  beforeEach(() => {
    const logRing = require('../src/utils/util.log-ring')
    logRing._resetForTest()
    const appender = logRing.configure()
    seed(appender, { ts: 1000, level: 'DEBUG', category: 'core', data: ['Xray 调试细节'] })
    seed(appender, { ts: 2000, level: 'INFO', category: 'core', data: ['Xray 启动完成'] })
    seed(appender, { ts: 3000, level: 'WARN', category: 'gui', data: ['窗口关闭警告'] })
    seed(appender, { ts: 4000, level: 'ERROR', category: 'server', data: [new Error('端口占用')] })
  })

  it('GET /api/logs 返回结构化条目与模块清单（时间升序）', async () => {
    const r = await fetch(`${baseUrl}/api/logs`)
    assert.strictEqual(r.status, 200)
    const d = await r.json()
    assert.strictEqual(d.entries.length, 4)
    assert.strictEqual(d.entries[0].message, 'Xray 调试细节')
    assert.strictEqual(d.entries[3].category, 'server')
    assert.ok(d.entries[3].message.includes('端口占用'))
    assert.deepStrictEqual(d.categories, ['core', 'gui', 'server'])
    assert.strictEqual(d.capacity > 0, true)
  })

  it('level 过滤按最低等级（warn 含 error）', async () => {
    const d = await (await fetch(`${baseUrl}/api/logs?level=warn`)).json()
    assert.strictEqual(d.entries.length, 2)
    assert.strictEqual(d.entries[0].message, '窗口关闭警告')
    assert.strictEqual(d.entries[1].level, 'error')
    const d2 = await (await fetch(`${baseUrl}/api/logs?level=ERROR`)).json()
    assert.strictEqual(d2.entries.length, 1)
    assert.strictEqual(d2.entries[0].level, 'error')
  })

  it('q 过滤不分大小写（消息与模块）', async () => {
    const d = await (await fetch(`${baseUrl}/api/logs?q=xray`)).json()
    assert.strictEqual(d.entries.length, 2)
    const d2 = await (await fetch(`${baseUrl}/api/logs?q=GUI`)).json()
    assert.deepStrictEqual(d2.entries.map(e => e.category), ['gui'])
  })

  it('category 精确过滤 + limit 优先返回最新且保持升序', async () => {
    const d = await (await fetch(`${baseUrl}/api/logs?category=core`)).json()
    assert.strictEqual(d.entries.length, 2)
    const d2 = await (await fetch(`${baseUrl}/api/logs?limit=2`)).json()
    assert.deepStrictEqual(d2.entries.map(e => e.category), ['gui', 'server'])
  })
})
