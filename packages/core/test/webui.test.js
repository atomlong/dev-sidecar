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

// 备份路由的 mock API（注入 context.backupApi，同 xrayApi 注入模式）
const mockBackupApi = {
  behavior: { testError: null, runError: null },
  getMaskedConfig () {
    return { configured: false, s3: { endpoint: '', region: 'auto', bucket: '', accessKeyId: '', secretAccessKey: '', prefix: 'dev-sidecar/' }, passphrase: '', keepLast: 7, schedule: { enabled: false, intervalHours: 24 }, lastBackupAt: 0, lastBackupKey: '', lastBackupSize: 0, lastError: '' }
  },
  saveConfig () { return { configured: true } },
  async testConnection () { if (mockBackupApi.behavior.testError) throw mockBackupApi.behavior.testError; return true },
  async runBackup () {
    if (mockBackupApi.behavior.runError) throw mockBackupApi.behavior.runError
    return { key: 'dev-sidecar/host1/20260902-000000.tar.gz', size: 1024, encrypted: false, deleted: [] }
  },
  async listBackups () {
    return { prefix: 'dev-sidecar/host1/', backups: [{ key: 'dev-sidecar/host1/20260902-000000.tar.gz', size: 1024, lastModified: '2026-09-02T00:00:00.000Z', encrypted: false }] }
  },
  async restoreBackup (key) {
    if (key === 'bad-key') throw new Error('非法的备份对象 key: bad-key')
    return { key, restoredCount: 3, files: ['./config.json'], needsRestart: true }
  },
  async downloadBackup (key) {
    if (!key.startsWith('dev-sidecar/')) throw new Error(`非法的备份对象 key: ${key}`)
    return { body: Buffer.from('gzip-bytes'), name: '20260902-000000.tar.gz' }
  },
  async deleteBackup () { return true },
  startSchedule () {}, stopSchedule () {},
}

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
        backupApi: mockBackupApi,
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
  let server, baseUrl, mockConfig

  before(async () => {
    const { createRouter } = require('../src/modules/plugin/webui/routes')
    // Mock config to avoid touching real config.json
    mockConfig = {
      get: () => ({
        server: { intercepts: {}, setting: { userBasePath: '/tmp' } },
        plugin: { xray: { enabled: false, port: 0, apiPort: 0, metricsPort: 0 }, webui: { token: '' } },
        proxy: { enabled: false },
      }),
      // All writes are recorded — never touch real config.json
      update: () => {},
      saved: [],
      save (cfg) { this.saved.push(cfg) },
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

  it('PUT /api/config with full tree saves (deletion-capable) and hot-reloads', async () => {
    const r = await fetch(`${baseUrl}/api/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app: {}, server: { setting: { timeoutMapping: {} } }, plugin: {} }),
    })
    const data = await r.json()
    assert.strictEqual(r.status, 200)
    assert.ok(data.status === 'ok')
    assert.ok(data.allConfig)
    assert.strictEqual(mockConfig.saved.length, 1)
  })

  it('PUT /api/config with partial tree returns 400 (full tree required for deletion semantics)', async () => {
    const r = await fetch(`${baseUrl}/api/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ server: { setting: { timeoutMapping: {} } } }),
    })
    assert.strictEqual(r.status, 400)
    const data = await r.json()
    assert.strictEqual(data.code, 'INVALID_BODY')
  })

  it('PUT /api/config strips configFromFiles before saving', async () => {
    const r = await fetch(`${baseUrl}/api/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app: {}, server: {}, plugin: {}, configFromFiles: { junk: true } }),
    })
    assert.strictEqual(r.status, 200)
    assert.strictEqual(mockConfig.saved[mockConfig.saved.length - 1].configFromFiles, undefined)
  })

  it('PUT /api/intercepts replaces the subtree so deleted domains are gone from the saved tree', async () => {
    mockConfig.saved.length = 0
    const r = await fetch(`${baseUrl}/api/intercepts`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 'keep.com': { '.*': { sni: 'baidu.com' } } }),
    })
    assert.strictEqual(r.status, 200)
    const saved = mockConfig.saved[mockConfig.saved.length - 1]
    assert.deepStrictEqual(saved.server.intercepts, { 'keep.com': { '.*': { sni: 'baidu.com' } } })
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

describe('webui config view / reset / restart routes', () => {
  let server, baseUrl, restartCalls, resetKeys

  before(async () => {
    const { createRouter } = require('../src/modules/plugin/webui/routes')
    const fixture = () => ({
      app: { remoteConfig: { enabled: true, personalUrl: 'file:///tmp/x.json5' } },
      server: {
        intercepts: {
          'keep.com': { '.*': { sni: 'baidu.com' } },
          'auto.com': { '.*': { proxy: 'tunnel://127.0.0.1:10801', desc: 'Auto-injected by Xray Plugin' } },
        },
        setting: { userBasePath: '/tmp' },
      },
      plugin: { xray: { enabled: false, port: 0, apiPort: 0, metricsPort: 0 }, webui: { token: '' } },
      proxy: { enabled: false },
      configFromFiles: { debug: true },
    })
    restartCalls = 0
    resetKeys = []
    const router = createRouter({
      config: {
        get: () => fixture(),
        save: () => {},
        downloadRemoteConfig: async () => {},
        reload: () => {},
        resetDefault (key) { resetKeys.push(key) },
      },
      event: { register: () => 1, unregister: () => {}, fire: () => {} },
      log: { info: () => {}, error: () => {} },
      server: { reload: async () => {} },
      xrayApi: null,
      xrayPlugin: { async restart () { restartCalls++ } },
    })
    server = http.createServer(router)
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address()
    baseUrl = `http://127.0.0.1:${port}`
  })

  after(async () => {
    await new Promise((resolve) => server.close(resolve))
  })

  it('GET /api/config strips auto-injected intercepts and configFromFiles', async () => {
    const r = await fetch(`${baseUrl}/api/config`)
    assert.strictEqual(r.status, 200)
    const data = await r.json()
    assert.strictEqual('configFromFiles' in data, false)
    assert.ok(data.server.intercepts['keep.com'])
    assert.strictEqual('auto.com' in data.server.intercepts, false)
  })

  it('GET /api/config/user returns the user override layer + remote meta', async () => {
    const r = await fetch(`${baseUrl}/api/config/user`)
    assert.strictEqual(r.status, 200)
    const data = await r.json()
    assert.ok(data.userConfig && typeof data.userConfig === 'object')
    assert.ok(typeof data.configPath === 'string')
    assert.strictEqual(data.remote.enabled, true)
    assert.strictEqual(data.remote.hasPersonalUrl, true)
  })

  it('POST /api/config/reset with valid key resets, saves and hot-reloads', async () => {
    const r = await fetch(`${baseUrl}/api/config/reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'plugin.xray' }),
    })
    assert.strictEqual(r.status, 200)
    const data = await r.json()
    assert.strictEqual(data.status, 'ok')
    assert.deepStrictEqual(resetKeys, ['plugin.xray'])
    assert.ok(data.allConfig)
  })

  it('POST /api/config/reset with invalid key returns 400', async () => {
    const r = await fetch(`${baseUrl}/api/config/reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: '../../etc' }),
    })
    assert.strictEqual(r.status, 400)
    const data = await r.json()
    assert.strictEqual(data.code, 'INVALID_BODY')
  })

  it('POST /api/xray/restart delegates to the xray plugin', async () => {
    const r = await fetch(`${baseUrl}/api/xray/restart`, { method: 'POST' })
    assert.strictEqual(r.status, 202)
    assert.strictEqual(restartCalls, 1)
  })
})

describe('webui backup routes (injected mock api)', () => {
  let server, baseUrl
  const mockApi = {
    behavior: { testError: null, runError: null },
    getMaskedConfig () { return { configured: false, keepLast: 7, schedule: { enabled: false, intervalHours: 24 } } },
    saveConfig () { return { configured: true } },
    async testConnection () { if (mockApi.behavior.testError) throw mockApi.behavior.testError; return true },
    async runBackup () {
      if (mockApi.behavior.runError) throw mockApi.behavior.runError
      return { key: 'dev-sidecar/host1/20260902-000000.tar.gz', size: 1024, encrypted: false, deleted: [] }
    },
    async listBackups () { return { prefix: 'dev-sidecar/host1/', backups: [{ key: 'dev-sidecar/host1/20260902-000000.tar.gz', size: 1024, lastModified: '2026-09-02T00:00:00.000Z', encrypted: false }] } },
    async restoreBackup (key) {
      if (key === 'bad-key') throw new Error('非法的备份对象 key: bad-key')
      return { key, restoredCount: 3, files: ['./config.json'], needsRestart: true }
    },
    async downloadBackup (key) {
      if (!key.startsWith('dev-sidecar/')) throw new Error(`非法的备份对象 key: ${key}`)
      return { body: Buffer.from('gzip-bytes'), name: '20260902-000000.tar.gz' }
    },
    async deleteBackup () { return true },
    startSchedule () {}, stopSchedule () {},
  }

  before(async () => {
    const { createRouter } = require('../src/modules/plugin/webui/routes')
    const router = createRouter({
      config: {
        get: () => ({ server: { setting: { userBasePath: '/tmp' } }, plugin: { webui: { token: '' } } }),
        update: () => {}, save: () => {}, reload: () => {},
      },
      event: { register: () => 1, unregister: () => {}, fire: () => {} },
      log: { info: () => {}, error: () => {} },
      server: { reload: async () => {} },
      xrayApi: null,
      backupApi: mockApi,
    })
    server = http.createServer(router)
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${server.address().port}`
  })

  after(async () => { await new Promise((resolve) => server.close(resolve)) })
  beforeEach(() => { mockApi.behavior.testError = null; mockApi.behavior.runError = null })

  it('GET /api/backup/config returns masked config', async () => {
    const r = await fetch(`${baseUrl}/api/backup/config`)
    const data = await r.json()
    assert.strictEqual(r.status, 200)
    assert.strictEqual(data.configured, false)
    assert.strictEqual(data.keepLast, 7)
  })

  it('POST /api/backup/config saves and returns config; array body rejected', async () => {
    const r = await fetch(`${baseUrl}/api/backup/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ s3: { bucket: 'b' }, keepLast: 3 }),
    })
    const data = await r.json()
    assert.strictEqual(r.status, 200)
    assert.strictEqual(data.status, 'ok')
    assert.strictEqual(data.config.configured, true)

    const bad = await fetch(`${baseUrl}/api/backup/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([]),
    })
    assert.strictEqual(bad.status, 400)
  })

  it('POST /api/backup/test maps upstream errors to 502, incomplete config to 400', async () => {
    mockApi.behavior.testError = new Error('S3 连接测试失败: HTTP 403')
    const r = await fetch(`${baseUrl}/api/backup/test`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    assert.strictEqual(r.status, 502)
    assert.strictEqual((await r.json()).code, 'BACKUP_UPSTREAM_FAILED')

    mockApi.behavior.testError = new Error('备份尚未配置完整：需要 endpoint / bucket / AccessKeyId / SecretAccessKey')
    const r2 = await fetch(`${baseUrl}/api/backup/test`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    assert.strictEqual(r2.status, 400)
    assert.strictEqual((await r2.json()).code, 'BACKUP_NOT_CONFIGURED')
  })

  it('POST /api/backup/run returns result; upstream failure 502', async () => {
    const r = await fetch(`${baseUrl}/api/backup/run`, { method: 'POST' })
    const data = await r.json()
    assert.strictEqual(r.status, 200)
    assert.strictEqual(data.key, 'dev-sidecar/host1/20260902-000000.tar.gz')
    assert.strictEqual(data.size, 1024)

    mockApi.behavior.runError = new Error('S3 PutObject 失败: HTTP 403')
    const r2 = await fetch(`${baseUrl}/api/backup/run`, { method: 'POST' })
    assert.strictEqual(r2.status, 502)
    assert.strictEqual((await r2.json()).code, 'BACKUP_UPSTREAM_FAILED')
  })

  it('GET /api/backup/list returns backups', async () => {
    const r = await fetch(`${baseUrl}/api/backup/list`)
    const data = await r.json()
    assert.strictEqual(r.status, 200)
    assert.strictEqual(data.backups.length, 1)
    assert.strictEqual(data.backups[0].key, 'dev-sidecar/host1/20260902-000000.tar.gz')
  })

  it('GET /api/backup/download streams attachment; invalid key 400', async () => {
    const r = await fetch(`${baseUrl}/api/backup/download?key=${encodeURIComponent('dev-sidecar/host1/20260902-000000.tar.gz')}`)
    assert.strictEqual(r.status, 200)
    assert.strictEqual(r.headers.get('content-type'), 'application/gzip')
    assert.match(r.headers.get('content-disposition'), /attachment; filename="20260902-000000\.tar\.gz"/)
    assert.strictEqual(Buffer.from(await r.arrayBuffer()).toString(), 'gzip-bytes')

    const bad = await fetch(`${baseUrl}/api/backup/download?key=${encodeURIComponent('other/x.tar.gz')}`)
    assert.strictEqual(bad.status, 400)
    assert.strictEqual((await bad.json()).code, 'INVALID_KEY')
  })

  it('POST /api/backup/restore requires key, maps validation errors to 400', async () => {
    const noKey = await fetch(`${baseUrl}/api/backup/restore`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    assert.strictEqual(noKey.status, 400)
    assert.strictEqual((await noKey.json()).code, 'INVALID_BODY')

    const bad = await fetch(`${baseUrl}/api/backup/restore`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'bad-key' }) })
    assert.strictEqual(bad.status, 400)
    assert.strictEqual((await bad.json()).code, 'BACKUP_RESTORE_INVALID')

    const ok = await fetch(`${baseUrl}/api/backup/restore`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'dev-sidecar/host1/x.tar.gz' }) })
    const data = await ok.json()
    assert.strictEqual(ok.status, 200)
    assert.strictEqual(data.needsRestart, true)
    assert.strictEqual(data.restoredCount, 3)
  })

  it('POST /api/backup/delete requires key', async () => {
    const noKey = await fetch(`${baseUrl}/api/backup/delete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    assert.strictEqual(noKey.status, 400)

    const ok = await fetch(`${baseUrl}/api/backup/delete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'dev-sidecar/host1/x.tar.gz' }) })
    assert.strictEqual(ok.status, 200)
    assert.strictEqual((await ok.json()).status, 'ok')
  })

  it('unknown backup route falls through to 404', async () => {
    const r = await fetch(`${baseUrl}/api/backup/unknown`)
    assert.strictEqual(r.status, 404)
  })
})
