const http = require('node:http')
const path = require('node:path')
const fs = require('node:fs')

const log = require('../../../utils/util.log.core')
const { createRouter } = require('./routes')
const { createWsServer } = require('./ws')

const pluginConfig = {
  enabled: true,
  port: 31182,
  listen: '127.0.0.1',
  token: '',
}

let server = null
let wss = null
let wsBroadcast = null
let eventIds = []
let logRingUnsubscribe = null

function Plugin (context) {
  const { config: globalConfig, event, log: ctxLog, server: ctxServer } = context

  const api = {
    async start () {
      const cfg = globalConfig.get().plugin?.webui || pluginConfig
      if (!cfg.enabled) {
        return
      }
      const port = cfg.port || pluginConfig.port
      const listen = cfg.listen || pluginConfig.listen

      try {
        const router = createRouter(context)
        server = http.createServer(async (req, res) => {
          try {
            await router(req, res)
          } catch (err) {
            ctxLog.error('WebUI 路由错误:', err)
            if (!res.headersSent) {
              res.writeHead(500, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: true, message: err.message, code: 'INTERNAL_ERROR' }))
            }
          }
        })

        // WebSocket upgrade
        const wsResult = createWsServer(context, server)
        wss = wsResult.wss
        wsBroadcast = wsResult.broadcast

        // Register event listeners for WS broadcast
        const channels = ['status', 'error', 'speed']
        for (const ch of channels) {
          const id = event.register(ch, (e) => {
            wsBroadcast({ channel: ch, data: e })
          })
          eventIds.push(id)
        }

        // 实时日志推流：log4js 环形缓冲的每条新日志经 WS 广播给 WebUI
        const logRing = require('../../../utils/util.log-ring')
        logRingUnsubscribe = logRing.subscribe((entry) => {
          wsBroadcast({ channel: 'log', data: entry })
        })

        server.listen(port, listen, () => {
          ctxLog.info(`WebUI 已启动: http://${listen}:${port}`)
          event.fire('status', { key: 'plugin.webui.enabled', value: true })
          event.fire('status', { key: 'plugin.webui.port', value: port })
        })
      } catch (err) {
        ctxLog.error('WebUI 启动失败:', err)
        event.fire('error', { key: 'webui', value: err.message })
      }
    },

    async close () {
      for (const id of eventIds) {
        try { event.unregister(id) } catch { /* ignore */ }
      }
      eventIds = []
      if (logRingUnsubscribe) {
        try { logRingUnsubscribe() } catch { /* ignore */ }
        logRingUnsubscribe = null
      }
      if (wss) {
        wss.close()
        wss = null
      }
      if (server) {
        await new Promise((resolve) => {
          server.close(() => {
            server = null
            resolve()
          })
        })
      }
      event.fire('status', { key: 'plugin.webui.enabled', value: false })
      event.fire('status', { key: 'plugin.webui.port', value: 0 })
      ctxLog.info('WebUI 已关闭')
    },

    isEnabled () {
      return server != null
    },
  }

  return api
}

module.exports = {
  key: 'webui',
  config: pluginConfig,
  status: {
    enabled: false,
    port: 0,
  },
  plugin: Plugin,
}
