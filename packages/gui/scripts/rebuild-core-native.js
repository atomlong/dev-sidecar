/**
 * Rebuilds native modules for the current Electron ABI.
 *
 * The plain `npm rebuild` uses system Node.js headers (ABI 127 on Node v22),
 * but the packaged Electron app needs modules compiled with Electron's own
 * ABI (e.g. v106 for Electron 19.1.9).  This script uses node-gyp with
 * --runtime=electron so the produced .node files self-register under the
 * correct symbol version (e.g. node_register_module_v106).
 *
 * This must run BEFORE electron-builder packages the app (in preelectron:build)
 * so the rebuilt .node files are included in the final asar/unpacked bundle.
 */
const cp = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

// Detect the Electron version from gui devDependencies.
let electronVersion
try {
  const guiPkg = require(path.resolve(__dirname, '..', 'package.json'))
  const ver = (guiPkg.devDependencies && guiPkg.devDependencies.electron) || (guiPkg.dependencies && guiPkg.dependencies.electron)
  if (!ver) throw new Error('electron version not found in gui package.json')
  electronVersion = ver.replace(/^[\^~>=]+/, '')
} catch (err) {
  console.error('[rebuild-core-native] Could not detect Electron version:', err.message)
  process.exit(1)
}

const env = {
  ...process.env,
  npm_config_runtime: 'electron',
  npm_config_target: electronVersion,
  npm_config_disturl: 'https://electronjs.org/headers',
}

function rebuildBetterSqlite3 (label, dir) {
  if (!fs.existsSync(path.join(dir, 'package.json'))) {
    console.warn(`[rebuild-core-native] better-sqlite3 not found in ${label}, skipping`)
    return
  }

  console.log(`[rebuild-core-native] Rebuilding better-sqlite3 (${label}) for Electron ${electronVersion}`)

  const result = cp.spawnSync('npx', ['node-gyp', 'rebuild', '--release'], {
    cwd: dir,
    stdio: 'inherit',
    env,
    shell: true,
  })

  if (result.status !== 0) {
    console.error(`[rebuild-core-native] node-gyp rebuild failed for ${label} with exit code`, result.status)
    process.exit(result.status || 1)
  }

  console.log(`[rebuild-core-native] better-sqlite3 (${label}) rebuilt successfully for Electron ABI`)
}

// Rebuild better-sqlite3 in the core package (used by mitmproxy worker).
const coreDir = path.resolve(__dirname, '..', '..', 'core')
rebuildBetterSqlite3('core', path.join(coreDir, 'node_modules', 'better-sqlite3'))

// Also rebuild better-sqlite3 in the gui package — this is the copy that
// electron-builder bundles into app.asar.unpacked. If pnpm install downloaded
// a prebuild for the system Node.js ABI, electron-builder install-app-deps may
// skip it, leaving a mismatched .node file that Electron cannot load at
// runtime.
const guiDir = path.resolve(__dirname, '..')
const guiBetterSqlite3Dir = path.join(guiDir, 'node_modules', 'better-sqlite3')
if (fs.existsSync(path.join(guiBetterSqlite3Dir, 'package.json'))) {
  rebuildBetterSqlite3('gui', guiBetterSqlite3Dir)
} else {
  const rootBetterSqlite3Dir = path.resolve(guiDir, '..', 'node_modules', 'better-sqlite3')
  if (fs.existsSync(path.join(rootBetterSqlite3Dir, 'package.json'))) {
    rebuildBetterSqlite3('root', rootBetterSqlite3Dir)
  } else {
    console.warn('[rebuild-core-native] better-sqlite3 not found in gui or root, skipping gui rebuild')
  }
}
