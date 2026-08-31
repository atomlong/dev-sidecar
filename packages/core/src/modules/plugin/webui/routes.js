const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')
const http = require('node:http')
const { execFileSync } = require('node:child_process')

const log = require('../../../utils/util.log.core')
const { getCurrentProcessCgroupPath } = require('../xray/util.cgroup')

// Cache for export results (30s TTL)
const exportCache = new Map()
const EXPORT_CACHE_TTL = 30 * 1000
// Rate limit for export (10s)
let lastExportAt = 0
// Rate limit for force refresh (60s)
let lastForceRefreshAt = 0
// Cache xray core version (static for process lifetime)
let xrayCoreVersionCache = null
function getXrayCoreVersion () {
  if (xrayCoreVersionCache !== null) return xrayCoreVersionCache
  try {
    const binPath = '/opt/dev-sidecar/resources/extra/xray/xray'
    if (!fs.existsSync(binPath)) { xrayCoreVersionCache = ''; return '' }
    const out = execFileSync(binPath, ['version'], { timeout: 3000, encoding: 'utf8' })
    // Output first line like "Xray 1.8.24 (Xray, ...) Custom"
    const m = out.match(/Xray\s+(\d+\.\d+\.\d+)/)
    xrayCoreVersionCache = m ? m[1] : ''
  } catch { xrayCoreVersionCache = '' }
  return xrayCoreVersionCache
}

// Re-inject xray rules after config save/reload.
// save() calls set(diffConfig) which resets in-memory intercepts to the
// persisted state (Auto-injected entries stripped), so any save/update/reload
// route must re-inject xray rules to keep tunnel routing alive.
// xrayApiOverride !== undefined (including null from a test context) skips the
// global expose require — loading expose in tests has process-wide side effects.
async function reInjectXrayRules (globalConfig, xrayApiOverride) {
  try {
    const xrayApi = xrayApiOverride !== undefined ? xrayApiOverride : require('../../../expose').api.plugin.xray
    await xrayApi?.removeRules?.()
    const xrayCfg = globalConfig.get().plugin.xray
    const xrayPort = globalConfig.get().server.setting.xrayPort
    if (xrayCfg?.enabled && Array.isArray(xrayCfg.rules) && xrayPort) {
      await xrayApi?.injectRules?.(xrayCfg.rules, xrayPort)
    }
  } catch { /* ignore */ }
}

function createRouter (context) {
  const { config: globalConfig, event, log: ctxLog, server: ctxServer } = context
  const ctxXrayApi = context.xrayApi
  // sticky 插件操作:优先用注入的实现（单测）;生产回退到 expose
  const resolveXrayPlugin = () => context.xrayPlugin || require('../../../expose').api.plugin.xray

  // Helper: check if request is from localhost
  function isLocalhost (req) {
    const addr = req.socket.remoteAddress
    return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
  }

  // Helper: check auth for write operations
  function checkWriteAuth (req, res) {
    const cfg = globalConfig.get().plugin?.webui || {}
    const token = cfg.token || ''
    if (isLocalhost(req) && !token) {
      return true // localhost read without token configured
    }
    const auth = req.headers.authorization || ''
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : ''
    if (!token || bearer === token) {
      return true
    }
    res.writeHead(401, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: true, message: 'Unauthorized', code: 'AUTH_REQUIRED' }))
    return false
  }

  // Helper: check auth for read operations (localhost free, remote needs token)
  function checkReadAuth (req, res) {
    if (isLocalhost(req)) {
      return true
    }
    const cfg = globalConfig.get().plugin?.webui || {}
    const token = cfg.token || ''
    if (!token) {
      res.writeHead(403, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: true, message: 'Token required for remote access', code: 'TOKEN_REQUIRED' }))
      return false
    }
    const auth = req.headers.authorization || ''
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : ''
    if (bearer !== token) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: true, message: 'Invalid token', code: 'AUTH_INVALID' }))
      return false
    }
    return true
  }

  // Helper: send JSON response
  function sendJson (res, status, data) {
    const body = JSON.stringify(data)
    const shouldGzip = body.length > 1024 && body.length < 5 * 1024 * 1024
    if (shouldGzip) {
      const compressed = zlib.gzipSync(body)
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Content-Encoding': 'gzip',
        'Content-Length': compressed.length,
      })
      res.end(compressed)
    } else {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(body)
    }
  }

  // Helper: read body. Resolves null for invalid JSON so route-level type
  // checks reject it with 400 — rejecting here would escape the route's try
  // (readBody is awaited before it) and crash the process as unhandled.
  function readBody (req) {
    return new Promise((resolve) => {
      let data = ''
      req.on('data', (chunk) => { data += chunk })
      req.on('end', () => {
        try { resolve(data ? JSON.parse(data) : {}) }
        catch (e) { resolve(null) }
      })
      req.on('error', () => resolve(null))
    })
  }

  // Helper: validate that a PUT body is a plain object.
  // Arrays like [] must be rejected — e.g. preSetIpList: [] persisted to
  // config.json would wipe out all preset IPs merged from remote configs.
  function isPlainObject (value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
  }

  // Helper: get xray paths
  function getXrayPaths () {
    const cfg = globalConfig.get()
    const userBasePath = cfg.server?.setting?.userBasePath || path.join(require('node:os').homedir(), '.dev-sidecar')
    const xrayDir = path.join(userBasePath, 'xray')
    const cachePath = path.join(xrayDir, 'nodes_cache.sqlite')
    const binPath = '/opt/dev-sidecar/resources/extra/xray/xray'
    // xray port/apiPort/metricsPort are in the status tree (set via event.fire),
    // not in config. Read from status module.
    let apiPort = 0
    let metricsPort = 0
    let port = 0
    let enabled = false
    try {
      const status = require('../../../status').get()
      const xrayStatus = status.plugin?.xray || {}
      apiPort = xrayStatus.apiPort || 0
      metricsPort = xrayStatus.metricsPort || 0
      port = xrayStatus.port || 0
      enabled = xrayStatus.enabled || false
    } catch { /* status not available */ }
    // Fallback: try getStageStatus for live ports
    if (!apiPort) {
      try {
        const DevSidecar = require('../../../expose')
        const stageStatus = DevSidecar.api.plugin.xray.getStageStatus?.()
        if (stageStatus) {
          apiPort = stageStatus.apiPort || apiPort
          metricsPort = stageStatus.metricsPort || metricsPort
          port = stageStatus.livePort || port
          enabled = enabled || stageStatus.liveNodes > 0
        }
      } catch { /* xray plugin not available */ }
    }
    return { binPath, xrayDir, cachePath, apiPort, metricsPort, port, enabled }
  }

  async function router (req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`)
    const pathname = url.pathname
    const method = req.method

    // Static file: serve index.html
    if (method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      const htmlPath = '/opt/dev-sidecar/resources/extra/webui/index.html'
      try {
        const html = fs.readFileSync(htmlPath, 'utf8')
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(html)
      } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain' })
        res.end('WebUI index.html not found. Please reinstall dev-sidecar.')
      }
      return
    }

    // Only /api/* routes below
    if (!pathname.startsWith('/api/')) {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('Not found')
      return
    }

    // Health check (no auth)
    if (method === 'GET' && pathname === '/api/health') {
      sendJson(res, 200, {
        status: 'ok',
        uptime: process.uptime(),
        pid: process.pid,
      })
      return
    }

    // Version (no auth)
    if (method === 'GET' && pathname === '/api/version') {
      let version = 'unknown'
      try { version = require('../../../../package.json').version } catch { /* ignore */ }
      sendJson(res, 200, {
        version,
        nodeVersion: process.version,
        xrayCoreVersion: getXrayCoreVersion(),
      })
      return
    }

    // Read auth check for all other GET routes
    if (method === 'GET' && !checkReadAuth(req, res)) {
      return
    }

    // Write auth check for POST/PUT/DELETE
    if ((method === 'POST' || method === 'PUT' || method === 'DELETE') && !checkWriteAuth(req, res)) {
      return
    }

    // ---- GET routes ----

    if (method === 'GET' && pathname === '/api/status') {
      sendJson(res, 200, globalConfig.get())
      return
    }

    if (method === 'GET' && pathname === '/api/info') {
      let version = 'unknown'
      try { version = require('../../../../package.json').version } catch { /* ignore */ }
      sendJson(res, 200, {
        pid: process.pid,
        uptime: process.uptime(),
        version,
        nodeVersion: process.version,
        logDir: path.join(require('node:os').homedir(), '.dev-sidecar', 'logs'),
      })
      return
    }

    if (method === 'GET' && pathname === '/api/system') {
      const mem = process.memoryUsage()
      const sysInfo = {
        pid: process.pid,
        uptime: process.uptime(),
        memory: {
          rss: mem.rss,
          heapTotal: mem.heapTotal,
          heapUsed: mem.heapUsed,
          external: mem.external,
        },
      }
      try {
        // getCurrentProcessCgroupPath may return /init.scope for systemd services
        // Try multiple cgroup paths
        const cgroupPaths = [
          '/sys/fs/cgroup/system.slice/dev-sidecar.service',
          '/sys/fs/cgroup/system.slice/dev-sidecar-xray-probe.scope',
        ]
        // Also try getCurrentProcessCgroupPath
        try {
          const dynamicPath = getCurrentProcessCgroupPath()
          if (dynamicPath) { cgroupPaths.unshift(`/sys/fs/cgroup${dynamicPath}`) }
        } catch { /* ignore */ }
        for (const basePath of cgroupPaths) {
          if (fs.existsSync(path.join(basePath, 'memory.current'))) {
            sysInfo.cgroup = {
              current: parseInt(fs.readFileSync(path.join(basePath, 'memory.current'), 'utf8').trim()),
              high: parseInt(fs.readFileSync(path.join(basePath, 'memory.high'), 'utf8').trim()),
              peak: parseInt(fs.readFileSync(path.join(basePath, 'memory.peak'), 'utf8').trim()),
            }
            break
          }
        }
      } catch { /* not on cgroup v2 or not linux */ }
      sendJson(res, 200, sysInfo)
      return
    }

    if (method === 'GET' && pathname === '/api/logs') {
      // 结构化实时日志：来自进程内 log4js 环形缓冲（util.log-ring.js），
      // 不再读日志文件。level=最低等级，q=消息/模块子串（不分大小写），
      // category=精确模块，limit=返回最新 N 条（时间升序）。
      const logRing = require('../../../utils/util.log-ring')
      const level = url.searchParams.get('level') || ''
      const q = url.searchParams.get('q') || ''
      const category = url.searchParams.get('category') || ''
      const limitParam = parseInt(url.searchParams.get('limit'), 10)
      const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : 1000
      const entries = logRing.getEntries({ level, q, category, limit })
      sendJson(res, 200, {
        entries,
        categories: logRing.getCategories(),
        capacity: logRing.getCapacity(),
        returned: entries.length,
      })
      return
    }

    if (method === 'GET' && pathname === '/api/xray/nodes') {
      const xray = getXrayPaths()
      // Fallback: try getStageStatus if apiPort not set (status module may not have it)
      if (!xray.apiPort) {
        try {
          const DevSidecar = require('../../../expose')
          const stageStatus = DevSidecar.api.plugin.xray.getStageStatus?.()
          if (stageStatus?.apiPort) {
            xray.apiPort = stageStatus.apiPort
            xray.metricsPort = stageStatus.metricsPort || xray.metricsPort
          }
        } catch { /* ignore */ }
      }
      if (!xray.apiPort) {
        // xray enabled in config but no apiPort yet — either disabled or still starting
        const cfg = globalConfig.get()
        const xrayEnabled = cfg.plugin?.xray?.enabled !== false
        sendJson(res, 200, { nodes: [], xrayEnabled, reason: xrayEnabled ? 'starting' : 'disabled' })
        return
      }
      try {
        const xrayApi = require('../xray/xray_api')
        const raw = await xrayApi.listOutbounds(xray.binPath, xray.apiPort)
        // listOutbounds returns xray CLI stdout (a JSON string like {"outbounds":[...]}).
        // Normalize to an array so the frontend can iterate directly.
        let nodes = []
        try {
          const parsed = JSON.parse(raw)
          nodes = Array.isArray(parsed) ? parsed : (parsed.outbounds || [])
        } catch { /* stdout not JSON — leave empty */ }

        // Enrich proxy_N nodes with country/exitIp from cache via fingerprint.
        // getStageStatus().stage1.liveNodeFingerprints is a {tag: fingerprint} map.
        let nodeMetadata = {} // tag -> {country, exitIp, owner}
        try {
          const DevSidecar = require('../../../expose')
          const liveFingerprints = DevSidecar.api.plugin.xray.getLiveNodeFingerprints?.() || {}
          const fps = Object.values(liveFingerprints).filter(Boolean)
          if (fps.length > 0) {
            const xrayCache = require('../xray/cache')
            const entries = xrayCache.readCacheEntriesByFingerprints(xray.cachePath, fps)
            const fpToMeta = new Map()
            for (const entry of entries) {
              const fp = xrayCache.fingerprintNode(entry.node)
              if (fp) {
                fpToMeta.set(fp, {
                  country: entry.country || '',
                  exitIp: entry.exitIp || '',
                  owner: entry.owner || '',
                })
              }
            }
            for (const [tag, fp] of Object.entries(liveFingerprints)) {
              const meta = fpToMeta.get(fp)
              if (meta) {
                nodeMetadata[tag] = meta
              }
            }
          }
        } catch { /* metadata enrichment failed — return nodes without country */ }

        sendJson(res, 200, { nodes, xrayEnabled: true, nodeMetadata })
      } catch (err) {
        sendJson(res, 503, { error: true, code: 'XRAY_NOT_READY', message: err.message })
      }
      return
    }

    if (method === 'GET' && pathname === '/api/xray/balancer') {
      const xray = getXrayPaths()
      if (!xray.apiPort) {
        try {
          const DevSidecar = require('../../../expose')
          const stageStatus = DevSidecar.api.plugin.xray.getStageStatus?.()
          if (stageStatus?.apiPort) { xray.apiPort = stageStatus.apiPort }
        } catch { /* ignore */ }
      }
      if (!xray.apiPort) {
        sendJson(res, 200, { balancer: null, xrayEnabled: false })
        return
      }
      try {
        const xrayApi = require('../xray/xray_api')
        const result = await xrayApi.getBalancerInfo(xray.binPath, xray.apiPort, 'balancer-proxy')
        // Also return sticky status from the plugin's internal state (more reliable than parsing balancer text)
        let sticky = { active: false, tag: null }
        try {
          sticky = await resolveXrayPlugin().getStickyStatus?.() || sticky
        } catch { /* ignore */ }
        sendJson(res, 200, { balancer: result, xrayEnabled: true, sticky })
      } catch (err) {
        sendJson(res, 503, { error: true, code: 'XRAY_NOT_READY', message: err.message })
      }
      return
    }

    if (method === 'GET' && pathname === '/api/xray/cache/stats') {
      const xray = getXrayPaths()
      try {
        const xrayCache = require('../xray/cache')
        const count = xrayCache.countCacheEntries(xray.cachePath)
        const sizeBytes = xrayCache.getSqliteCacheSizeBytes(xray.cachePath)
        const countryDistribution = xrayCache.readCountryDistribution(xray.cachePath, 100)
        sendJson(res, 200, { totalNodes: count, dbSizeBytes: sizeBytes, countryDistribution })
      } catch (err) {
        sendJson(res, 503, { error: true, code: 'CACHE_NOT_READY', message: err.message })
      }
      return
    }

    if (method === 'GET' && pathname === '/api/xray/cache/nodes') {
      const xray = getXrayPaths()
      try {
        const xrayCache = require('../xray/cache')
        const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10))
        const pageSize = Math.min(200, Math.max(1, parseInt(url.searchParams.get('pageSize') || '50', 10)))
        const offset = (page - 1) * pageSize
        const sort = url.searchParams.get('sort') || 'smart'
        const options = {
          limit: pageSize,
          offset,
          orderBy: sort === 'delay' ? 'delay' : (sort === 'stable' ? 'stable' : 'default'),
        }
        const entries = xrayCache.readCacheEntries(xray.cachePath, options)
        // Project to a compact row for the frontend.
        const rows = entries.map(e => {
          const n = e.node || {}
          const settings = n.settings || {}
          // Per-protocol shapes: trojan=settings.server (singular); old ss=settings.servers[];
          // vless/vmess=settings.vnext[]; ss-2022=flat settings.address/port.
          const host = settings.server || settings.servers?.[0] || settings.vnext?.[0]
          const addr = host?.address || settings.address || ''
          const port = host?.port || settings.port || ''
          return {
            tag: e.tag || n.tag || '',
            protocol: n.protocol || '',
            address: addr,
            port,
            delay: e.delay,
            country: e.country || '',
            owner: e.owner || '',
            failureStreak: e.failureStreak,
            stable: e.stable === true,
            exitIp: e.exitIp || '',
            updatedAt: e.updatedAt || '',
          }
        })
        sendJson(res, 200, { rows, page, pageSize, returned: rows.length })
      } catch (err) {
        sendJson(res, 503, { error: true, code: 'CACHE_NOT_READY', message: err.message })
      }
      return
    }

    if (method === 'GET' && pathname === '/api/xray/cache/subscriptions') {
      const xray = getXrayPaths()
      try {
        const xrayCache = require('../xray/cache')
        const summary = xrayCache.readSubscriptionAvailabilitySummary(xray.cachePath)
        sendJson(res, 200, { subscriptions: summary })
      } catch (err) {
        sendJson(res, 503, { error: true, code: 'CACHE_NOT_READY', message: err.message })
      }
      return
    }

    if (method === 'GET' && pathname === '/api/xray/stage/status') {
      try {
        const DevSidecar = require('../../../expose')
        const stageStatus = DevSidecar.api.plugin.xray.getStageStatus?.() || null
        sendJson(res, 200, stageStatus || { error: true, code: 'METHOD_NOT_AVAILABLE' })
      } catch (err) {
        sendJson(res, 503, { error: true, code: 'XRAY_NOT_READY', message: err.message })
      }
      return
    }

    if (method === 'GET' && pathname === '/api/xray/stage/round-summary') {
      try {
        const xray = getXrayPaths()
        const summaryPath = path.join(xray.xrayDir, 'stage3-last-round.json')
        const data = JSON.parse(fs.readFileSync(summaryPath, 'utf8'))
        sendJson(res, 200, data)
      } catch {
        sendJson(res, 200, { error: true, message: 'No round summary available' })
      }
      return
    }

    if (method === 'GET' && pathname === '/api/xray/probed-stats') {
      try {
        const xray = getXrayPaths()
        const statsPath = path.join(xray.xrayDir, 'probed-node-stats.json')
        const raw = JSON.parse(fs.readFileSync(statsPath, 'utf8'))
        const totalProbed = raw.totalProbed || (raw.nodes ? raw.nodes.length : 0)
        const countryDist = raw.countryDistribution || {}
        const nodes = raw.nodes || []
        // Compact node rows for the frontend.
        const compactNodes = nodes.map(n => ({
          nodeId: n.nodeId,
          country: n.country || '',
          owner: n.owner || '',
          exitIp: n.exitIp || '',
          delay: n.delay,
          stable: n.stable === true,
          protocol: n.protocol || '',
          shareLink: n.shareLink || '',
        }))
        sendJson(res, 200, { totalProbed, countryDistribution: countryDist, nodes: compactNodes })
      } catch {
        sendJson(res, 200, { totalProbed: 0, countryDistribution: {}, nodes: [], error: true, message: 'No probed stats available' })
      }
      return
    }

    if (method === 'GET' && pathname === '/api/xray/metrics') {
      const xray = getXrayPaths()
      if (!xray.metricsPort) {
        try {
          const DevSidecar = require('../../../expose')
          const stageStatus = DevSidecar.api.plugin.xray.getStageStatus?.()
          if (stageStatus?.metricsPort) { xray.metricsPort = stageStatus.metricsPort }
        } catch { /* ignore */ }
      }
      if (!xray.metricsPort) {
        sendJson(res, 200, { metrics: null, reason: 'xray_not_running' })
        return
      }
      try {
        const resp = await fetch(`http://127.0.0.1:${xray.metricsPort}/debug/vars`)
        const data = await resp.json()
        sendJson(res, 200, data)
      } catch (err) {
        sendJson(res, 503, { error: true, code: 'XRAY_NOT_READY', message: err.message })
      }
      return
    }

    if (method === 'GET' && pathname === '/api/config') {
      sendJson(res, 200, globalConfig.get())
      return
    }

    // ---- POST/PUT/DELETE routes ----

    if (method === 'POST' && pathname === '/api/service/restart') {
      sendJson(res, 202, { status: 'restarting', message: 'Service will restart in ~15s' })
      // Send response first, then shutdown + exit
      setTimeout(async () => {
        try {
          const DevSidecar = require('../../../expose')
          await DevSidecar.api.shutdown()
        } catch { /* ignore */ }
        process.exit(1)
      }, 500)
      return
    }

    if (method === 'POST' && pathname === '/api/xray/sticky') {
      const body = await readBody(req)
      if (!isPlainObject(body)) {
        sendJson(res, 400, { error: true, code: 'INVALID_BODY', message: 'sticky body must be a JSON object' })
        return
      }
      // duration=0 means permanent — must NOT fall through `|| 300`, which
      // silently converted the "永久" option (0) into a 300s auto-unlock.
      const rawDuration = parseInt(body.duration)
      const duration = Number.isFinite(rawDuration) && rawDuration >= 0 ? rawDuration : 300
      const actualDuration = duration === 0 ? 86400 * 365 * 10 : duration
      try {
        await resolveXrayPlugin().enableSticky({ duration: actualDuration })
        sendJson(res, 200, { status: 'ok', duration: actualDuration })
      } catch (err) {
        sendJson(res, 500, { error: true, code: 'STICKY_FAILED', message: err.message })
      }
      return
    }

    if (method === 'DELETE' && pathname === '/api/xray/sticky') {
      try {
        await resolveXrayPlugin().disableSticky()
        sendJson(res, 200, { status: 'ok' })
      } catch (err) {
        sendJson(res, 500, { error: true, code: 'STICKY_FAILED', message: err.message })
      }
      return
    }

    if (method === 'POST' && pathname === '/api/xray/cache/refresh') {
      const force = url.searchParams.get('force') === 'true'
      if (force) {
        const now = Date.now()
        if (now - lastForceRefreshAt < 60000) {
          sendJson(res, 429, { error: true, code: 'RATE_LIMITED', retryAfter: 60 })
          return
        }
        lastForceRefreshAt = now
      }
      try {
        const DevSidecar = require('../../../expose')
        const stageStatus = DevSidecar.api.plugin.xray.getStageStatus?.()
        if (stageStatus?.isStageRunning) {
          sendJson(res, 200, { status: 'already_running', generation: stageStatus.refreshGeneration })
          return
        }
        // Trigger Stage3
        const xray = getXrayPaths()
        const cfg = globalConfig.get().plugin?.xray || {}
        setImmediate(async () => {
          try {
            await DevSidecar.api.plugin.xray.refreshCacheFromCacheOnly({
              binPath: xray.binPath,
              cfg,
              xrayDir: xray.xrayDir,
              cachePath: xray.cachePath,
            })
          } catch (err) {
            ctxLog.error('WebUI 触发 Stage3 失败:', err)
          }
        })
        sendJson(res, 202, { status: 'accepted' })
      } catch (err) {
        sendJson(res, 500, { error: true, code: 'REFRESH_FAILED', message: err.message })
      }
      return
    }

    if (method === 'PUT' && pathname === '/api/config') {
      const body = await readBody(req)
      if (!isPlainObject(body)) {
        sendJson(res, 400, { error: true, code: 'INVALID_BODY', message: 'Config body must be a JSON object' })
        return
      }
      try {
        globalConfig.update(body)
        // Hot reload
        try { await ctxServer.reload() } catch { /* ignore */ }
        await reInjectXrayRules(globalConfig, ctxXrayApi)
        sendJson(res, 200, { status: 'ok', message: 'Config updated and hot-reloaded' })
      } catch (err) {
        sendJson(res, 500, { error: true, code: 'CONFIG_UPDATE_FAILED', message: err.message })
      }
      return
    }

    if (method === 'PUT' && pathname === '/api/intercepts') {
      const body = await readBody(req)
      if (!isPlainObject(body)) {
        sendJson(res, 400, { error: true, code: 'INVALID_BODY', message: 'Intercepts body must be a JSON object (domain -> rule mapping)' })
        return
      }
      try {
        globalConfig.update({ server: { intercepts: body } })
        try { await ctxServer.reload() } catch { /* ignore */ }
        await reInjectXrayRules(globalConfig, ctxXrayApi)
        sendJson(res, 200, { status: 'ok', message: 'Intercepts updated' })
      } catch (err) {
        sendJson(res, 500, { error: true, code: 'CONFIG_UPDATE_FAILED', message: err.message })
      }
      return
    }

    if (method === 'PUT' && pathname === '/api/presetiplist') {
      const body = await readBody(req)
      if (!isPlainObject(body)) {
        // [] would be persisted by doDiff and then wipe all preset IPs on merge
        sendJson(res, 400, { error: true, code: 'INVALID_BODY', message: 'preSetIpList body must be a JSON object (domain -> ip mapping), not an array' })
        return
      }
      try {
        globalConfig.update({ server: { preSetIpList: body } })
        try { await ctxServer.reload() } catch { /* ignore */ }
        await reInjectXrayRules(globalConfig, ctxXrayApi)
        sendJson(res, 200, { status: 'ok', message: 'preSetIpList updated' })
      } catch (err) {
        sendJson(res, 500, { error: true, code: 'CONFIG_UPDATE_FAILED', message: err.message })
      }
      return
    }

    if (method === 'PUT' && pathname === '/api/xray/rules') {
      const body = await readBody(req)
      if (!Array.isArray(body)) {
        // rules 是数组字段；传对象会被 mergeWith 畸形合并进数组字段
        sendJson(res, 400, { error: true, code: 'INVALID_BODY', message: 'xray rules body must be a JSON array' })
        return
      }
      try {
        globalConfig.update({ plugin: { xray: { rules: body } } })
        await reInjectXrayRules(globalConfig, ctxXrayApi)
        sendJson(res, 200, { status: 'ok', message: 'xray rules updated' })
      } catch (err) {
        sendJson(res, 500, { error: true, code: 'CONFIG_UPDATE_FAILED', message: err.message })
      }
      return
    }

    if (method === 'POST' && pathname === '/api/proxy/enable') {
      try {
        const DevSidecar = require('../../../expose')
        await DevSidecar.api.proxy.start()
        sendJson(res, 202, { status: 'ok' })
      } catch (err) {
        sendJson(res, 500, { error: true, code: 'PROXY_FAILED', message: err.message })
      }
      return
    }

    if (method === 'POST' && pathname === '/api/proxy/disable') {
      try {
        const DevSidecar = require('../../../expose')
        await DevSidecar.api.proxy.close()
        sendJson(res, 202, { status: 'ok' })
      } catch (err) {
        sendJson(res, 500, { error: true, code: 'PROXY_FAILED', message: err.message })
      }
      return
    }

    if (method === 'POST' && pathname === '/api/config/reload') {
      sendJson(res, 202, { status: 'accepted' })
      setImmediate(async () => {
        try {
          await globalConfig.downloadRemoteConfig()
          globalConfig.reload()
          try { await ctxServer.reload() } catch { /* ignore */ }
          await reInjectXrayRules(globalConfig, ctxXrayApi)
          ctxLog.info('WebUI 远程配置更新完成')
        } catch (err) {
          ctxLog.error('WebUI 远程配置更新失败:', err)
        }
      })
      return
    }

    // ---- Node export API ----
    if (method === 'GET' && pathname === '/api/xray/cache/nodes/export') {
      // Parse params first (before any checks)
      const format = url.searchParams.get('format') || 'sharelink'
      const country = url.searchParams.get('country')?.split(',').filter(Boolean) || null
      const owner = url.searchParams.get('owner')
      const maxDelay = parseInt(url.searchParams.get('maxDelay')) || 0
      const available = url.searchParams.get('available') === 'true'
      const maxFailureStreakParam = parseInt(url.searchParams.get('maxFailureStreak'))
      const maxFailureStreak = Number.isFinite(maxFailureStreakParam) && maxFailureStreakParam >= 0 ? maxFailureStreakParam : 3
      const sort = url.searchParams.get('sort') || 'smart'
      const shuffle = url.searchParams.get('shuffle') === 'true'
      let limit = parseInt(url.searchParams.get('limit')) || 100
      const offset = parseInt(url.searchParams.get('offset')) || 0
      const includeMeta = url.searchParams.get('includeMeta') !== 'false'
      const now = Date.now()

      // Limit check (before rate limit so invalid params return 400)
      if (limit > 500) {
        sendJson(res, 400, { error: true, code: 'LIMIT_TOO_LARGE', max: 500 })
        return
      }

      // Rate limit
      if (now - lastExportAt < 10000) {
        sendJson(res, 429, { error: true, code: 'RATE_LIMITED', retryAfter: 10 })
        return
      }
      lastExportAt = now

      // Cache key
      const cacheKey = JSON.stringify({ format, country, owner, maxDelay, available, maxFailureStreak, sort, shuffle, limit, offset, includeMeta })
      const cached = exportCache.get(cacheKey)
      if (cached && (now - cached.timestamp) < EXPORT_CACHE_TTL) {
        sendJson(res, 200, cached.data)
        return
      }

      try {
        const xray = getXrayPaths()
        const xrayCache = require('../xray/cache')

        // Build query options. Keys MUST match buildCompactV2FilterClauses /
        // getCompactV2OrderByClause — a previous revision passed mismatched
        // keys (sort/countries/owners/maxDelay), silently disabling every filter.
        const opts = {
          limit: shuffle ? limit * 2 : limit, // Get 2x for shuffle
          offset,
          orderBy: sort === 'delay' ? 'delay' : (sort === 'stable' ? 'stable' : 'default'),
          availableOnly: available === true,
          maxFailureStreak,
          maxDelayMs: maxDelay > 0 ? maxDelay : 0,
          countryInclude: country,
          ownerInclude: owner ? [owner] : null,
        }

        const entries = xrayCache.readCacheEntries(xray.cachePath, opts)
        const totalCount = xrayCache.countCacheEntries(xray.cachePath, opts)

        // Shuffle if requested
        let result = entries
        if (shuffle && result.length > limit) {
          // Fisher-Yates shuffle, take first N
          for (let i = result.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1))
            ;[result[i], result[j]] = [result[j], result[i]]
          }
          result = result.slice(0, limit)
        } else if (result.length > limit) {
          result = result.slice(0, limit)
        }

        // Build response based on format
        let data
        if (format === 'sharelink') {
          const { nodeToShareLink } = require('../xray/index')
          data = result.map((e) => nodeToShareLink(e.node, `${e.country || 'XX'} ${e.exitIp || ''}`))
        } else if (format === 'outbound') {
          const parser = require('../xray/parser')
          const outbounds = result.map((e, i) => {
            const ob = parser.sanitizeNodeForCurrentXray(JSON.parse(JSON.stringify(e.node)))
            ob.tag = `proxy_${i}`
            return ob
          })
          const meta = includeMeta ? result.map((e, i) => ({
            tag: `proxy_${i}`,
            exitIp: e.exitIp || '',
            country: e.country || '',
            delay: e.delay || 0,
            failureStreak: e.failureStreak || 0,
            stable: e.stable === true,
          })) : null
          data = { outbounds, meta }
        } else {
          // format=full
          const { nodeToShareLink } = require('../xray/index')
          data = result.map((e) => ({
            address: e.node?.settings?.servers?.[0]?.address || '',
            port: e.node?.settings?.servers?.[0]?.port || 0,
            protocol: e.node?.protocol || '',
            delay: e.delay || 0,
            country: e.country || '',
            owner: e.owner || '',
            shareLink: nodeToShareLink(e.node, `${e.country || 'XX'} ${e.exitIp || ''}`),
            exitIp: e.exitIp || '',
            failureStreak: e.failureStreak || 0,
            stable: e.stable || false,
          }))
        }

        const response = { data, total: totalCount, returned: result.length }
        exportCache.set(cacheKey, { data: response, timestamp: now })
        sendJson(res, 200, response)
      } catch (err) {
        sendJson(res, 503, { error: true, code: 'CACHE_NOT_READY', message: err.message })
      }
      return
    }

    // 404 for unmatched routes
    sendJson(res, 404, { error: true, message: `Not found: ${method} ${pathname}`, code: 'NOT_FOUND' })
  }

  return router
}

module.exports = { createRouter, reInjectXrayRules }
