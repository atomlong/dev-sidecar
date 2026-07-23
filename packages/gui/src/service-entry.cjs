'use strict'
// service-entry.cjs — Lightweight service-mode entry point for dev-sidecar.
//
// Runs with ELECTRON_RUN_AS_NODE=1 to use the Electron binary as a pure
// Node.js runtime, completely eliminating chromium subprocess overhead
// (GPU process, NetworkService, zygote). This is the pure-Node counterpart
// to background.js's service mode.
//
// This file is compiled by webpack into a standalone bundle (service-entry.js)
// at the asar root, alongside mitmproxy.js. Webpack bundles @docmirror/dev-sidecar
// and all its JavaScript deps inline; only native modules (better-sqlite3,
// fadvise-linux, etc.) stay external and are loaded from the asar's
// node_modules at runtime via Electron's asar support.
//
// Usage in systemd unit:
//   Environment=ELECTRON_RUN_AS_NODE=1
//   ExecStart=/opt/dev-sidecar/@docmirrordev-sidecar-gui /opt/dev-sidecar/resources/app.asar/service-entry.js
//
// The essential startup sequence (mirrors backend.js doStart + install):
//   1. Resolve mitmproxy.js path (inside asar, same dir as this bundle)
//   2. Set DS_EXTRA_PATH for xray binary / sysproxy / etc.
//   3. Reload user config
//   4. Start auto-download remote config
//   5. Call DevSidecar.api.startup({ mitmproxyPath })
//   6. Handle SIGTERM → graceful shutdown

const path = require('node:path')
const fs = require('node:fs')

// --- Resolve paths (replaces app.getAppPath / app.getPath('exe')) ---
// Use process.argv[1] instead of __dirname because webpack bundles don't
// reliably preserve __dirname. When loaded as:
//   /opt/dev-sidecar/@docmirrordev-sidecar-gui /opt/dev-sidecar/resources/app.asar/service-entry.js
// process.argv[1] = /opt/dev-sidecar/resources/app.asar/service-entry.js
const scriptPath = process.argv[1] || __dirname
const asarRoot = path.dirname(scriptPath)         // .../resources/app.asar
const resourcesPath = path.dirname(asarRoot)       // .../resources

// mitmproxy.js lives at the asar root (same level as this bundle)
const mitmproxyPath = path.join(asarRoot, 'mitmproxy.js')

// DS_EXTRA_PATH: /opt/dev-sidecar/resources/extra
// process.execPath = /opt/dev-sidecar/@docmirrordev-sidecar-gui
// appRoot = /opt/dev-sidecar/
const appRoot = path.join(path.dirname(process.execPath), '..')
const extraPath = path.join(resourcesPath, 'extra')
process.env.DS_EXTRA_PATH = extraPath

// --- Load core (CommonJS, no electron dependency) ---
const DevSidecar = require('@docmirror/dev-sidecar')
const configLoader = require('@docmirror/dev-sidecar/src/config/local-config-loader.js')
const log = DevSidecar.api.log

log.info('service-entry.cjs: starting dev-sidecar in pure-Node service mode')
log.info(`  mitmproxyPath: ${mitmproxyPath}`)
log.info(`  DS_EXTRA_PATH: ${extraPath}`)
log.info(`  process.execPath: ${process.execPath}`)

if (!fs.existsSync(mitmproxyPath)) {
  log.error(`service-entry.cjs: mitmproxy.js not found at ${mitmproxyPath}`)
  process.exit(1)
}

// --- Prevent double-launch via PID file ---
const userBasePath = configLoader.getUserBasePath()
const pidFile = path.join(userBasePath, 'service.pid')
try {
  const existingPid = fs.readFileSync(pidFile, 'utf8').trim()
  if (existingPid && process.kill(existingPid, 0)) {
    log.error(`service-entry.cjs: another instance is already running (PID ${existingPid}), exiting`)
    process.exit(1)
  }
} catch {
  // no existing PID file, or process not alive — continue
}
fs.writeFileSync(pidFile, String(process.pid))

// --- Graceful shutdown ---
let shuttingDown = false
async function shutdown (reason) {
  if (shuttingDown) {
    return
  }
  shuttingDown = true
  log.info(`service-entry.cjs: shutting down (${reason})`)
  try {
    await DevSidecar.api.shutdown()
  } catch (err) {
    log.error('service-entry.cjs: shutdown error:', err)
  }
  try {
    fs.unlinkSync(pidFile)
  } catch {
    // ignore
  }
  process.exit(0)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('uncaughtException', (err) => {
  log.error('service-entry.cjs: uncaughtException:', err)
})
process.on('unhandledRejection', (reason) => {
  log.error('service-entry.cjs: unhandledRejection:', reason)
})

// --- Startup sequence (mirrors backend.js doStart + install) ---
async function main () {
  // Register event listeners (no-op without BrowserWindow, but keeps
  // status/error logging for diagnostics)
  DevSidecar.api.event.register('status', (event) => {
    log.info('service-entry.cjs: status event:', JSON.stringify(event))
  })
  DevSidecar.api.event.register('error', (event) => {
    log.error('service-entry.cjs: error event:', event)
  })

  // Reload user config (merges defaults + remote + user overrides)
  DevSidecar.api.config.reload()

  // Start auto-download remote config
  try {
    await DevSidecar.api.config.startAutoDownloadRemoteConfig()
  } catch (err) {
    log.error('service-entry.cjs: startAutoDownloadRemoteConfig error:', err)
  }

  // Start all (proxy server + mitmproxy fork + xray + plugins)
  try {
    await DevSidecar.api.startup({ mitmproxyPath })
    log.info('service-entry.cjs: startup complete, service is running')
  } catch (err) {
    log.error('service-entry.cjs: startup failed:', err)
    process.exit(1)
  }
}

main()
