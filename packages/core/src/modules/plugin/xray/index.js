const fs = require('node:fs')
const path = require('node:path')
const https = require('node:https')
const http = require('node:http')
const { URL } = require('node:url')
const pluginConfig = require('./config')
const processApi = require('./process')
const portFinder = require('./port-finder')
const parser = require('./parser')
const genConfig = require('./gen_config')

function download (url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http
    client.get(url, (res) => {
      if (res.statusCode !== 200) {
        res.resume()
        reject(new Error(`Request Failed. Status Code: ${res.statusCode}`))
        return
      }
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => { resolve(data) })
    }).on('error', (e) => {
      reject(e)
    })
  })
}

const Plugin = function (context) {
  const { config: globalConfig, event, log, server } = context
  let currentRuntimePort = 0
  const injectedRules = [] // List of domains injected

  const api = {
    async start () {
      const cfg = globalConfig.get().plugin.xray
      if (!cfg || !cfg.enabled) {
        return
      }

      if (!cfg.binPath || !fs.existsSync(cfg.binPath)) {
        log.error('Xray 启动失败: 未找到 Xray 可执行文件，请在配置中指定 binPath')
        throw new Error('Xray binary not found')
      }

      // 1. Determine Port
      let port = cfg.localPort
      if (port > 0) {
        // Strict Mode
        const available = await portFinder.isPortAvailable(port)
        if (!available) {
          const msg = `Xray 启动失败: 端口 ${port} 被占用 (Strict Mode)`
          log.error(msg)
          throw new Error(msg)
        }
      } else {
        // Auto Mode
        port = await portFinder.findFreePort()
        log.info(`Xray 自动选择端口: ${port}`)
      }
      currentRuntimePort = port

      // Save runtime port to global setting for mitmproxy to resolve tunnel://...:0
      globalConfig.get().server.setting.xrayPort = port

      // 2. Fetch & Parse Subscriptions
      let allNodes = []
      
      // Parse manual nodes
      if (cfg.nodes && Array.isArray(cfg.nodes)) {
        for (const link of cfg.nodes) {
          const nodes = parser.parse(link)
          allNodes = allNodes.concat(nodes)
        }
      }

      // Fetch subscriptions
      if (cfg.subscriptions && Array.isArray(cfg.subscriptions)) {
        for (const subUrl of cfg.subscriptions) {
          try {
            log.info(`正在更新订阅: ${subUrl}`)
            const content = await download(subUrl)
            const nodes = parser.parse(content)
            log.info(`订阅解析成功: ${nodes.length} 个节点`)
            allNodes = allNodes.concat(nodes)
          } catch (e) {
            log.error(`订阅更新失败: ${subUrl}`, e)
          }
        }
      }

      if (allNodes.length === 0) {
        log.warn('Xray 警告: 未找到任何可用节点，将只启用 Direct/Block')
      } else {
        // Global Deduplication
        const uniqueNodes = []
        const seen = new Set()
        for (const node of allNodes) {
          // Deduplication based on configuration (ignoring tag)
          const { tag, ...config } = node
          const fingerprint = JSON.stringify(config)
          if (!seen.has(fingerprint)) {
            seen.add(fingerprint)
            uniqueNodes.push(node)
          }
        }
        if (uniqueNodes.length < allNodes.length) {
          log.info(`Xray 全局去重: 移除 ${allNodes.length - uniqueNodes.length} 个重复节点，剩余 ${uniqueNodes.length} 个`)
        }
        allNodes = uniqueNodes
      }

      // 3. Generate Config
      const xrayConfig = genConfig(port, allNodes, cfg.rules, cfg.probeUrl, cfg.probeInterval)
      const userBasePath = globalConfig.get().server.setting.userBasePath
      const configDir = path.join(userBasePath, 'xray')
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true })
      }
      const configPath = path.join(configDir, 'config.json')
      fs.writeFileSync(configPath, JSON.stringify(xrayConfig, null, 2))
      log.info(`Xray 配置文件已生成: ${configPath}`)

      // 4. Start Process
      await processApi.start(cfg.binPath, configPath)
      event.fire('status', { key: 'plugin.xray.enabled', value: true })
      event.fire('status', { key: 'plugin.xray.port', value: port })

      // 5. Inject Rules
      await api.injectRules(cfg.rules, port)

      // 6. Hot Reload Server
      if (server) {
        await server.reload()
      }
    },

    async close () {
      await api.removeRules()
      if (server) {
        await server.reload()
      }
      await processApi.stop()
      event.fire('status', { key: 'plugin.xray.enabled', value: false })
      log.info('Xray 插件已关闭')
    },

    async restart () {
      await api.close()
      await api.start()
    },

    isEnabled () {
      return globalConfig.get().plugin.xray.enabled
    },

    async injectRules (rules, port) {
      if (!rules || !Array.isArray(rules)) return

      const intercepts = globalConfig.get().server.intercepts
      const ruleDomains = new Set()

      rules.forEach(rule => {
        if (rule.domain) {
          const domains = Array.isArray(rule.domain) ? rule.domain : [rule.domain]
          domains.forEach(d => ruleDomains.add(d))
        }
      })

      for (const domain of ruleDomains) {
        if (intercepts[domain]) {
          log.warn(`规则冲突: 域名 ${domain} 已存在拦截规则，Xray 插件跳过注入。`)
          continue
        }

        // Inject rule
        intercepts[domain] = {
          '.*': {
            proxy: `tunnel://127.0.0.1:${port}`,
            desc: 'Auto-injected by Xray Plugin',
          },
        }
        injectedRules.push(domain)
        log.info(`Xray 规则注入: ${domain} -> tunnel://127.0.0.1:${port}`)
      }
    },

    async removeRules () {
      const intercepts = globalConfig.get().server.intercepts
      for (const domain of injectedRules) {
        if (intercepts[domain] && intercepts[domain]['.*'] && intercepts[domain]['.*'].desc === 'Auto-injected by Xray Plugin') {
          delete intercepts[domain]
          log.info(`Xray 规则移除: ${domain}`)
        }
      }
      injectedRules.length = 0
    },
  }

  return api
}

module.exports = {
  key: 'xray',
  config: pluginConfig,
  status: {
    enabled: false,
    port: 0,
  },
  plugin: Plugin,
}