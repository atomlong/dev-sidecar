const fs = require('node:fs')
const path = require('node:path')

function resolvePackageDir (packageName, paths = [__dirname]) {
  const packageJsonPath = require.resolve(`${packageName}/package.json`, { paths })
  return path.dirname(packageJsonPath)
}

function removeNodeGypBins (packageDir, label) {
  const nodeGypBinsDir = path.join(packageDir, 'build', 'node_gyp_bins')

  if (fs.existsSync(nodeGypBinsDir)) {
    fs.rmSync(nodeGypBinsDir, { recursive: true, force: true })
    console.log(`removed ${label} native helper artifacts: ${nodeGypBinsDir}`)
  } else {
    console.log(`${label} native helper artifacts already absent: ${nodeGypBinsDir}`)
  }
}

function removeBetterSqliteNodeGypBins () {
  removeNodeGypBins(resolvePackageDir('better-sqlite3'), 'better-sqlite3')
}

function removeFadviseLinuxNodeGypBins () {
  const packageDir = path.resolve(__dirname, '../../fadvise-linux')
  removeNodeGypBins(packageDir, '@docmirror/fadvise-linux')
}

function copyRuntimePackage (packageName, targetNodeModulesDir, options = {}) {
  const sourceDir = options.sourceDir || resolvePackageDir(packageName, options.paths || [__dirname])
  const targetDir = path.join(targetNodeModulesDir, ...packageName.split('/'))
  fs.rmSync(targetDir, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(targetDir), { recursive: true })

  fs.cpSync(sourceDir, targetDir, {
    recursive: true,
    dereference: true,
  })

  removeNodeGypBins(targetDir, packageName)
  console.log(`copied runtime package: ${packageName}`)
  return targetDir
}

module.exports = {
  resolvePackageDir,
  removeNodeGypBins,
  removeBetterSqliteNodeGypBins,
  removeFadviseLinuxNodeGypBins,
  copyRuntimePackage,
}

if (require.main === module) {
  removeBetterSqliteNodeGypBins()
  removeFadviseLinuxNodeGypBins()
}
