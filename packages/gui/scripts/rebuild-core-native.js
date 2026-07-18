/**
 * Rebuilds native modules in the core package for the current Electron ABI.
 *
 * The plain `npm rebuild` uses system Node.js headers (ABI 127 on Node v22),
 * but the packaged Electron app needs modules compiled with Electron's own
 * ABI (e.g. v106 for Electron 19.1.9).  This script uses node-gyp with
 * --runtime=electron so the produced .node files self-register under the
 * correct symbol version (e.g. node_register_module_v106).
 */
const cp = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const coreDir = path.resolve(__dirname, '..', '..', 'core')
const betterSqlite3Dir = path.join(coreDir, 'node_modules', 'better-sqlite3')

if (!fs.existsSync(path.join(betterSqlite3Dir, 'package.json'))) {
  console.warn('[rebuild-core-native] @atomlong/better-sqlite3 not found in core, skipping')
  process.exit(0)
}

// Detect the Electron version from gui devDependencies.
let electronVersion
try {
  const guiPkg = require(path.resolve(__dirname, '..', 'package.json'))
  const ver = (guiPkg.devDependencies && guiPkg.devDependencies.electron) || (guiPkg.dependencies && guiPkg.dependencies.electron)
  if (!ver) throw new Error('electron version not found in gui package.json')
  // Strip caret/tilde ranges: ^19.1.9 → 19.1.9
  electronVersion = ver.replace(/^[\^~>=]+/, '')
} catch (err) {
  console.error('[rebuild-core-native] Could not detect Electron version:', err.message)
  process.exit(1)
}

console.log(`[rebuild-core-native] Rebuilding better-sqlite3 for Electron ${electronVersion} (ABI must match running Electron)`)

const env = {
  ...process.env,
  // Ensure node-gyp uses Electron headers, not system Node headers.
  npm_config_runtime: 'electron',
  npm_config_target: electronVersion,
  npm_config_disturl: 'https://electronjs.org/headers',
}

const result = cp.spawnSync('npx', ['node-gyp', 'rebuild', '--release'], {
  cwd: betterSqlite3Dir,
  stdio: 'inherit',
  env,
  shell: true,
})

if (result.status !== 0) {
  console.error('[rebuild-core-native] node-gyp rebuild failed with exit code', result.status)
  process.exit(result.status || 1)
}

console.log('[rebuild-core-native] better-sqlite3 rebuilt successfully for Electron ABI')
