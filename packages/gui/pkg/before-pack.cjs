const path = require('node:path')
const {
  copyRuntimePackage,
  removeBetterSqliteNodeGypBins,
  removeFadviseLinuxNodeGypBins,
} = require('../scripts/clean-native-artifacts')

exports.default = async function (context) {
  removeBetterSqliteNodeGypBins()
  removeFadviseLinuxNodeGypBins()

  const appDir = (context && context.appDir) || path.resolve(__dirname, '../dist_electron/bundled')
  const nodeModulesDir = path.join(appDir, 'node_modules')
  copyRuntimePackage('@docmirror/fadvise-linux', nodeModulesDir, {
    sourceDir: path.resolve(__dirname, '../../fadvise-linux'),
  })
}