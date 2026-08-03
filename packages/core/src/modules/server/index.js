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

// 自愈状态：mitmproxy 子进程异常退出 (SIGABRT/SIGSEGV/非零退出) 时自动重启。
// 主进程不感知子进程崩溃，systemd 的 Restart=on-failure 也只看主进程，
// 没有 respawn 的话代理端口直接死亡，浏览器全部 Connection refused。
let intentionalStop = false // kill/close/restart 主动调用时的正常退出，不自愈
const respawnState = { count: 0, firstCrashTime: null } // 30 秒滑动窗口内最多 3 次

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
    // 防止重复启动：如果已有子进程存活，直接返回
    if (server && server.process && !server.process.killed && server.process.exitCode == null) {
      log.warn('server is already running, skip start (pid:', server.id, ')')
      return { port: server.port }
    }

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
      // 保留现有的 instance 信息（启动类型、pid 等），避免被配置覆盖
      let existingInstance
      if (fs.existsSync(runningConfigPath)) {
        try {
          const existing = JSON.parse(fs.readFileSync(runningConfigPath, 'utf-8'))
          existingInstance = existing?.app?.instance
        } catch {}
      }
      if (existingInstance) {
        if (!serverConfig.app) {
          serverConfig.app = {}
        }
        serverConfig.app.instance = existingInstance
      }
      fs.writeFileSync(runningConfigPath, jsonApi.stringify(serverConfig))
      log.info('保存 running.json 运行时配置文件成功:', runningConfigPath)
    } catch (e) {
      log.error('保存 running.json 运行时配置文件失败:', runningConfigPath, ', error:', e)
      throw e
    }
    // Pass V8 flags to the mitmproxy child process via execArgv.
    // --expose-gc exposes global.gc for explicit GC during stage3 cache refresh.
    // --max-old-space-size caps V8 old space of the mitmproxy child process.
    // Note: this only affects the mitmproxy Node.js child process, NOT the xray
    // probe binary (which is a Go executable spawned separately and moved to an
    // isolated cgroup). mitmproxy steady-state heap is ~15MB, so 96MB gives 6x
    // headroom — sufficient for all throughput levels.
    const serverProcess = fork(mitmproxyPath, [runningConfigPath], {
      execArgv: ['--expose-gc', '--max-old-space-size=96'],
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
      // 主动 kill/close/restart 触发的正常退出，不自愈
      if (intentionalStop) {
        intentionalStop = false
        return
      }
      // 异常崩溃自愈：30 秒滑动窗口内最多 3 次，超过则放弃避免重启风暴
      const now = Date.now()
      if (respawnState.firstCrashTime == null || now - respawnState.firstCrashTime > 30000) {
        respawnState.firstCrashTime = now
        respawnState.count = 0
      }
      respawnState.count += 1
      if (respawnState.count > 3) {
        log.error(`server process 自愈放弃：30 秒内已重启 ${respawnState.count - 1} 次仍崩溃 (code=${code}, signal=${signal})，等待手动介入`)
        fireStatus(false)
        event.fire('error', { key: 'server', value: 'respawn_exceeded', message: 'mitmproxy 崩溃自愈次数超限' })
        return
      }
      log.warn(`server process 异常退出 (code=${code}, signal=${signal})，自愈重启中 (尝试 ${respawnState.count}/3)...`)
      server = null
      serverApi.start({ mitmproxyPath: currentMitmproxyPath, plugins: currentPlugins }).then(() => {
        log.warn(`server process 自愈重启成功 (第 ${respawnState.count} 次)`)
      }).catch((err) => {
        log.error('server process 自愈重启失败:', err)
      })
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
      intentionalStop = true
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
