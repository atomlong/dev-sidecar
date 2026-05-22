const { removeBetterSqliteNodeGypBins } = require('../scripts/clean-native-artifacts')

exports.default = async function () {
  removeBetterSqliteNodeGypBins()
}