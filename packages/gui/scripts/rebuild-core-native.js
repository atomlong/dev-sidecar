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

// Resolve the local node-gyp@12 binary from the workspace's .pnpm store.
// `npx node-gyp` and `require.resolve('node-gyp/...')` may resolve to
// node-gyp@9.4.1 (an older version) which uses VisualStudioFinder
// that cannot detect Visual Studio 2022 on Windows CI runners.
// node-gyp@12.x supports VS 2022 correctly.
const pnpmDir = path.resolve(__dirname, '..', '..', '..', 'node_modules', '.pnpm')
let nodeGypBin = null
if (fs.existsSync(pnpmDir)) {
  const dirs = fs.readdirSync(pnpmDir).filter(d => d.startsWith('node-gyp@'))
  // Pick the highest version (node-gyp@12.x preferred over 9.x)
  dirs.sort((a, b) => {
    const va = parseInt(a.replace('node-gyp@', ''))
    const vb = parseInt(b.replace('node-gyp@', ''))
    return vb - va
  })
  for (const dir of dirs) {
    const candidate = path.join(pnpmDir, dir, 'node_modules', 'node-gyp', 'bin', 'node-gyp.js')
    if (fs.existsSync(candidate)) {
      nodeGypBin = candidate
      break
    }
  }
}
if (!nodeGypBin) {
  // Fallback: try resolving from node_modules
  try {
    nodeGypBin = require.resolve('node-gyp/bin/node-gyp.js')
  } catch {
    console.error('[rebuild-core-native] Could not find node-gyp binary')
    process.exit(1)
  }
}
console.log('[rebuild-core-native] using node-gyp:', nodeGypBin)

const result = cp.spawnSync(process.execPath, [nodeGypBin, 'rebuild', '--release'], {
  cwd: betterSqlite3Dir,
  stdio: 'inherit',
  env,
})

if (result.status !== 0) {
  console.error('[rebuild-core-native] node-gyp rebuild failed with exit code', result.status)
  process.exit(result.status || 1)
}

console.log('[rebuild-core-native] better-sqlite3 rebuilt successfully for Electron ABI')
