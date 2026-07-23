const lodash = require('lodash')
const fs = require('fs')
const childProcess = require('child_process')
const config = require('./config-api')
const event = require('./event')
const modules = require('./modules')
const shell = require('./shell')
const status = require('./status')
const log = require('./utils/util.log.core')
const { getCurrentProcessCgroupPath } = require('./modules/plugin/xray/util.cgroup')

const server = modules.server

function reclaimStartupMemory () {
  if (process.platform !== 'linux') {
    return false
  }

  const cgroupPath = getCurrentProcessCgroupPath()
  if (!cgroupPath) {
    return false
  }

  const reclaimFile = `${cgroupPath}/memory.reclaim`
  if (!fs.existsSync(reclaimFile)) {
    return false
  }

  // 回收 200M：电脑冷启动后系统页缓存为空，Electron 二进制 + asar + chromium + xray
  // 首次加载产生 ~200MB file cache，100M 不够覆盖。200M 能把 file cache 压到接近 0，
  // 给后续 mitmproxy fork + Xray Stage3 探测留出 cgroup 空间，避免冷启动峰值顶到
  // MemoryHigh 上限触发内核疯狂回收（实测 high 事件 110 次）。
  try {
    fs.writeFileSync(reclaimFile, '200M')
    log.info('启动前 cgroup 内存回收完成: 200M (memory.reclaim)')
    return true
  } catch {
    try {
      childProcess.execFileSync('sudo', [
        '-n',
        '/usr/lib/dev-sidecar/reclaim-memory.sh',
        '200M',
      ], { timeout: 5000 })
      log.info('启动前 cgroup 内存回收完成: 200M (reclaim-memory.sh)')
      return true
    } catch (e) {
      log.warn('启动前 cgroup 内存回收失败:', e.message)
      return false
    }
  }
}

const context = {
  config,
  shell,
  status,
  event,
  log,
  server,
}

function setupPlugin (key, plugin, context, config) {
  const pluginConfig = plugin.config
  const PluginClass = plugin.plugin
  const pluginStatus = plugin.status
  const api = PluginClass(context)
  config.addDefault(key, pluginConfig)
  if (pluginStatus) {
    lodash.set(status, key, pluginStatus)
  }
  return api
}

const proxy = setupPlugin('proxy', modules.proxy, context, config)
const plugin = {}
for (const key in modules.plugin) {
  const target = modules.plugin[key]
  const api = setupPlugin(`plugin.${key}`, target, context, config)
  plugin[key] = api
}
config.resetDefault()
const serverStart = server.start

function newServerStart ({ mitmproxyPath }) {
  return serverStart({ mitmproxyPath, plugins: plugin })
}
server.start = newServerStart
async function startup ({ mitmproxyPath }) {
  const conf = config.get()
  reclaimStartupMemory()
  if (conf.server.enabled) {
    try {
      await server.start({ mitmproxyPath })
    } catch (err) {
      log.error('代理服务启动失败：', err)
    }
  }
  if (conf.proxy.enabled && !status.proxy.enabled) {
    try {
      await proxy.start()
    } catch (err) {
      log.error('开启系统代理失败：', err)
    }
  }
  // 回收 mitmproxy fork + gsettings/D-Bus 产生的 file cache。
  // 冷启动时这些操作从磁盘加载大量文件进 cgroup file cache（~80MB），
  // 如果不清掉，后续 Xray 插件读 SQLite 800MB 时会叠加到 282MB（MemoryHigh）。
  // 热启动时这些文件已在系统页缓存（不计入 cgroup），所以热启动 peak 更低。
  if (process.platform === 'linux') {
    try {
      const cgroupPath = getCurrentProcessCgroupPath()
      const currentFile = cgroupPath ? `${cgroupPath}/memory.current` : ''
      if (currentFile && fs.existsSync(currentFile)) {
        const currentBytes = Number.parseInt(fs.readFileSync(currentFile, 'utf8').trim(), 10)
        const currentMB = Math.round(currentBytes / 1024 / 1024)
        // 冷启动：mitmproxy fork + D-Bus 从磁盘加载产生 ~180MB cgroup file cache。
        // 热启动：文件已在系统页缓存（不计入 cgroup），currentBytes 较低 (~87MB)。
        // 按 currentBytes 动态回收，目标压到 ~30MB 以下，给后续 SQLite 读取留 headroom。
        // reclaimTarget 受 100M 下限、350M 上限保护，确保冷热启动一致触发。
        if (Number.isFinite(currentBytes) && currentBytes > 60 * 1024 * 1024) {
          const reclaimTarget = Math.min(Math.max(currentBytes - 30 * 1024 * 1024, 100 * 1024 * 1024), 350 * 1024 * 1024)
          const reclaimMB = Math.round(reclaimTarget / 1024 / 1024)
          childProcess.execFileSync('sudo', ['-n', '/usr/lib/dev-sidecar/reclaim-memory.sh', `${reclaimMB}M`], { timeout: 5000 })
          log.info(`代理启动后 cgroup 内存回收完成: ${reclaimMB}M (before=${currentMB}MB)`)
        } else {
          log.info(`代理启动后 cgroup 内存跳过回收: current=${currentMB}MB (<=60MB)`)
        }
      }
    } catch {
      // best-effort
    }
  }
  try {
    const plugins = []
    for (const key in plugin) {
      if (conf.plugin[key].enabled && !status.plugin[key]?.enabled) {
        const start = async () => {
          try {
            await plugin[key].start()
            log.info(`插件【${key}】已启动`)
          } catch (err) {
            log.error(`插件【${key}】启动失败:`, err)
          }
        }
        plugins.push(start())
      }
    }
    if (plugins && plugins.length > 0) {
      await Promise.all(plugins)
    }
  } catch (err) {
    log.error('开启插件失败：', err)
  }
}

async function shutdown () {
  try {
    const plugins = []
    for (const key in plugin) {
      if (status.plugin[key] && status.plugin[key].enabled && plugin[key].close) {
        const close = async () => {
          try {
            await plugin[key].close()
            log.info(`插件【${key}】已关闭`)
          } catch (err) {
            log.error(`插件【${key}】关闭失败:`, err)
          }
        }
        plugins.push(close())
      }
    }
    if (plugins.length > 0) {
      await Promise.all(plugins)
    }
  } catch (error) {
    log.error('插件关闭失败:', error)
  }

  if (status.proxy.enabled) {
    try {
      await proxy.close()
      log.info('系统代理已关闭')
    } catch (err) {
      log.error('系统代理关闭失败:', err)
    }
  }
  if (status.server.enabled) {
    try {
      await server.close()
      log.info('代理服务已关闭')
    } catch (err) {
      log.error('代理服务关闭失败:', err)
    }
  }
}

const api = {
  startup,
  shutdown,
  status: {
    get () {
      return status
    },
  },
  config,
  event,
  shell,
  server,
  proxy,
  plugin,
  log,
}
module.exports = {
  status,
  api,
}
