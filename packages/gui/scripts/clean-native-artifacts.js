const fs = require('node:fs')
const path = require('node:path')

function removeBetterSqliteNodeGypBins () {
  const packageJsonPath = require.resolve('better-sqlite3/package.json', {
    paths: [__dirname],
  })
  const packageDir = path.dirname(packageJsonPath)
  const nodeGypBinsDir = path.join(packageDir, 'build', 'node_gyp_bins')

  if (fs.existsSync(nodeGypBinsDir)) {
    fs.rmSync(nodeGypBinsDir, { recursive: true, force: true })
    console.log(`removed native helper artifacts: ${nodeGypBinsDir}`)
  } else {
    console.log(`native helper artifacts already absent: ${nodeGypBinsDir}`)
  }
}

module.exports = {
  removeBetterSqliteNodeGypBins,
}

if (require.main === module) {
  removeBetterSqliteNodeGypBins()
}