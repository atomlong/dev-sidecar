const fork = require('node:child_process').fork
const fs = require('node:fs')
const path = require('node:path')
const lodash = require('lodash')
const config = require('../../config-api')
const event = require('../../event')
const status = require('../../status')
const jsonApi = require('@docmirror/mitmproxy/src/json')
const log = require('../../utils/util.log.core')

let server = null
let currentPlugins = null
let currentMitmproxyPath = null

function fireStatus (status) {
  event.fire('status', { key: 'server.enabled', value: status })
}
function sleep (time) {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve()
    }, time)
  })
}
const serverApi = {
  async startup () {
    if (config.get().server.startup) {
      return this.start(config.get().server)
    }
  },
  async shutdown () {
    if (status.server) {
      return this.close()
    }
  },
  async start ({ mitmproxyPath, plugins }) {
    if (mitmproxyPath) currentMitmproxyPath = mitmproxyPath
    if (plugins) currentPlugins = plugins

    const allConfig = config.get()
    const serverConfig = lodash.cloneDeep(allConfig.server)

    const intercepts = serverConfig.intercepts
    const dnsMapping = serverConfig.dns.mapping

    if (allConfig.plugin) {
      lodash.each(allConfig.plugin, (value) => {
        const plugin = value
        if (!plugin.enabled) {
          return
        }
        if (plugin.intercepts) {
          lodash.merge(intercepts, plugin.intercepts)
        }
        if (plugin.dns) {
          lodash.merge(dnsMapping, plugin.dns)
        }
      })
    }

    if (allConfig.app) {
      serverConfig.app = allConfig.app
    }

    if (serverConfig.intercept.enabled === false) {
      // 如果设置为关闭拦截
      serverConfig.intercepts = {}
    }

    for (const key in plugins) {
      const plugin = plugins[key]
      if (plugin.overrideRunningConfig) {
        plugin.overrideRunningConfig(serverConfig)
      }
    }
    serverConfig.plugin = allConfig.plugin

    if (allConfig.proxy && allConfig.proxy.enabled) {
      serverConfig.proxy = allConfig.proxy
    }

    // fireStatus('ing') // 启动中
    const basePath = serverConfig.setting.userBasePath
    const runningConfigPath = path.join(basePath, '/running.json')
    try {
      fs.writeFileSync(runningConfigPath, jsonApi.stringify(serverConfig))
      log.info('保存 running.json 运行时配置文件成功:', runningConfigPath)
    } catch (e) {
      log.error('保存 running.json 运行时配置文件失败:', runningConfigPath, ', error:', e)
      throw e
    }
    // Pass V8 flags to the mitmproxy child process via execArgv.
    // --expose-gc exposes global.gc for explicit GC during stage3 cache refresh.
    // --max-old-space-size caps V8 old space per batch level. Note: Node.js fork
    // accepts bare V8 flags in execArgv (verified), but does NOT accept
    // --js-flags=... (causes SIGKILL exit 9 because Node.js doesn't recognize
    // the Chromium-specific --js-flags switch).
    //   Keep STAGE3_MAX_OLD_SPACE_BY_LEVEL in sync with
    //   STAGE3_BATCH_LEVEL_TABLE in modules/plugin/xray/config.js.
    //   level 1 (64):   48 MB   — low-memory devices (Raspberry Pi)
    //   level 2 (128):  80 MB   — default, steady heap ~15 MB
    //   level 3 (256):  128 MB  — moderate throughput
    //   level 4 (512):  256 MB  — high throughput
    //   level 5 (1024): 512 MB  — max coverage
    const STAGE3_MAX_OLD_SPACE_BY_LEVEL = { 1: 48, 2: 80, 3: 128, 4: 256, 5: 512 }
    const rawBatchLevel = Number.parseInt(allConfig.plugin?.xray?.cacheRefreshBatchLevel, 10)
    const batchLevel = Number.isInteger(rawBatchLevel) && rawBatchLevel >= 1 && rawBatchLevel <= 5
      ? rawBatchLevel
      : 2
    const maxOldSpaceSize = STAGE3_MAX_OLD_SPACE_BY_LEVEL[batchLevel]
    const serverProcess = fork(mitmproxyPath, [runningConfigPath], {
      execArgv: ['--expose-gc', `--max-old-space-size=${maxOldSpaceSize}`],
    })
    server = {
      id: serverProcess.pid,
      process: serverProcess,
      port: serverConfig.port,
      close () {
        serverProcess.send({ type: 'action', event: { key: 'close' } })
      },
    }
    serverProcess.on('beforeExit', (code) => {
      log.warn('server process beforeExit, code:', code)
    })
    serverProcess.on('SIGPIPE', (code, signal) => {
      log.warn(`server process SIGPIPE, code: ${code}, signal:`, signal)
    })
    serverProcess.on('exit', (code, signal) => {
      log.warn(`server process exit, code: ${code}, signal:`, signal)
    })
    serverProcess.on('uncaughtException', (err, origin) => {
      log.error('server process uncaughtException:', err)
    })
    serverProcess.on('message', (msg) => {
      log.debug('收到子进程消息:', JSON.stringify(msg))
      if (msg.type === 'status') {
        fireStatus(msg.event)
      } else if (msg.type === 'error') {
        let code = ''
        if (msg.event.code) {
          code = msg.event.code
        }
        fireStatus(false) // 启动失败
        event.fire('error', { key: 'server', value: code, error: msg.event, message: msg.message })
      } else if (msg.type === 'speed') {
        event.fire('speed', msg.event)
      }
    })
    return { port: serverConfig.port }
  },
  async kill () {
    if (server) {
      server.process.kill('SIGINT')
      await sleep(1000)
    }
    fireStatus(false)
  },
  async close () {
    return await serverApi.kill()
  },
  async restart ({ mitmproxyPath }) {
    await serverApi.kill()
    await serverApi.start({ mitmproxyPath: mitmproxyPath || currentMitmproxyPath, plugins: currentPlugins })
  },
  async reload () {
    if (server) {
      const allConfig = config.get()
      const serverConfig = lodash.cloneDeep(allConfig.server)

      const intercepts = serverConfig.intercepts
      const dnsMapping = serverConfig.dns.mapping

      if (allConfig.plugin) {
        lodash.each(allConfig.plugin, (value) => {
          const plugin = value
          if (!plugin.enabled) {
            return
          }
          if (plugin.intercepts) {
            lodash.merge(intercepts, plugin.intercepts)
          }
          if (plugin.dns) {
            lodash.merge(dnsMapping, plugin.dns)
          }
        })
      }

      if (allConfig.app) {
        serverConfig.app = allConfig.app
      }

      if (serverConfig.intercept.enabled === false) {
        // 如果设置为关闭拦截
        serverConfig.intercepts = {}
      }

      if (currentPlugins) {
        for (const key in currentPlugins) {
          const plugin = currentPlugins[key]
          if (plugin.overrideRunningConfig) {
            plugin.overrideRunningConfig(serverConfig)
          }
        }
      }
      serverConfig.plugin = allConfig.plugin

      if (allConfig.proxy && allConfig.proxy.enabled) {
        serverConfig.proxy = allConfig.proxy
      }
      
      server.process.send({ type: 'config', event: serverConfig })
      log.info('已发送配置热加载通知')
    }
  },
  getServer () {
    return server
  },
  getSpeedTestList () {
    if (server) {
      server.process.send({ type: 'speed', event: { key: 'getList' } })
    }
  },
  reSpeedTest () {
    if (server) {
      server.process.send({ type: 'speed', event: { key: 'reTest' } })
    }
  },
}
module.exports = serverApi
