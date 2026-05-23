import fs from 'node:fs'
import path from 'node:path'
import server from '@docmirror/mitmproxy'
import jsonApi from '@docmirror/mitmproxy/src/json.js'
import log from '@docmirror/mitmproxy/src/utils/util.log.server.js' // 当前脚本是在 server 的进程中执行的，所以使用 mitmproxy 中的logger

const configPath = process.argv[2]
const configJson = fs.readFileSync(configPath)
log.info('读取 running.json by gui bridge 成功:', configPath)
let config
try {
  config = jsonApi.parse(configJson.toString())
} catch (e) {
  log.error(`running.json 文件内容格式不正确，文件路径：${configPath}，文件内容: ${configJson.toString()}, error:`, e)
  config = {}
}
// const scriptDir = '../extra/scripts/'
// config.setting.script.defaultDir = path.join(__dirname, scriptDir)
// const pacFilePath = '../extra/pac/pac.txt'
// config.plugin.overwall.pac.customPacFilePath = path.join(__dirname, pacFilePath)
if (!config.setting) {
  config.setting = {}
}
config.setting.rootDir = resolveRootDir()
log.info('resolved gui bridge rootDir:', config.setting.rootDir)
log.info(`start mitmproxy by gui bridge, configPath: ${configPath}`)
server.start(config)

function resolveRootDir () {
  const candidates = []

  if (process.argv[1]) {
    candidates.push(path.resolve(path.dirname(process.argv[1]), '../'))
  }

  if (process.env.DS_EXTRA_PATH) {
    candidates.push(path.resolve(process.env.DS_EXTRA_PATH, '../'))
  }

  candidates.push(path.resolve(process.cwd(), 'dist_electron'))
  candidates.push(process.cwd())

  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'extra'))) {
      return candidate
    }
  }

  return candidates[0]
}
