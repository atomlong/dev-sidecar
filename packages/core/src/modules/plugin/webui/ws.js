const { WebSocketServer } = require('ws')

function createWsServer (context, httpServer) {
  const { config: globalConfig, log: ctxLog } = context
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 })
  const clients = new Map() // ws -> { authed, lastPong }
  const MAX_CLIENTS = 5

  // Helper: check localhost
  function isLocalhost (addr) {
    return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
  }

  // Heartbeat: ping every 30s, close if no pong in 10s
  const heartbeatTimer = setInterval(() => {
    for (const [ws, info] of clients) {
      if (info.authed && Date.now() - info.lastPong > 40000) {
        try { ws.terminate() } catch { /* ignore */ }
        clients.delete(ws)
        continue
      }
      if (info.authed) {
        try { ws.ping() } catch { /* ignore */ }
      }
    }
  }, 30000)

  heartbeatTimer.unref?.()

  // Handle upgrade
  httpServer.on('upgrade', (req, socket, head) => {
    const pathname = new URL(req.url, `http://${req.headers.host}`).pathname
    if (pathname !== '/ws') {
      socket.destroy()
      return
    }
    if (clients.size >= MAX_CLIENTS) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n')
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req)
    })
  })

  wss.on('connection', (ws, req) => {
    const addr = req.socket.remoteAddress
    const local = isLocalhost(addr)
    const cfg = globalConfig.get().plugin?.webui || {}
    const token = cfg.token || ''

    const info = { authed: local || !token, lastPong: Date.now() }
    clients.set(ws, info)

    // Send welcome
    ws.send(JSON.stringify({ type: 'connected', authed: info.authed }))

    ws.on('pong', () => {
      if (info) info.lastPong = Date.now()
    })

    ws.on('message', (raw) => {
      let msg
      try { msg = JSON.parse(raw) } catch {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }))
        return
      }
      // Auth message
      if (msg.type === 'auth') {
        if (!token || msg.token === token) {
          info.authed = true
          ws.send(JSON.stringify({ type: 'authed', success: true }))
        } else {
          ws.send(JSON.stringify({ type: 'authed', success: false, message: 'Invalid token' }))
          setTimeout(() => { try { ws.close() } catch { /* ignore */ } }, 1000)
        }
        return
      }
    })

    ws.on('close', () => {
      clients.delete(ws)
    })

    ws.on('error', () => {
      clients.delete(ws)
    })
  })

  // Broadcast function with stage channel throttle
  let lastStageBroadcast = 0
  let pendingStageTimer = null

  function broadcast (message) {
    const data = JSON.stringify(message)
    for (const [ws, info] of clients) {
      if (!info.authed) continue
      if (ws.readyState === ws.OPEN) {
        // Throttle stage channel: skip if within 1s, schedule flush
        if (message.channel === 'stage') {
          const now = Date.now()
          if (now - lastStageBroadcast < 1000) {
            // Save latest stage data, schedule flush after throttle window
            if (!pendingStageTimer) {
              pendingStageTimer = setTimeout(() => {
                pendingStageTimer = null
                lastStageBroadcast = Date.now()
                const pending = data
                for (const [ws2, info2] of clients) {
                  if (info2.authed && ws2.readyState === ws2.OPEN) {
                    try { ws2.send(pending) } catch { /* ignore */ }
                  }
                }
              }, 1000 - (now - lastStageBroadcast))
              pendingStageTimer.unref?.()
            }
            continue
          }
          lastStageBroadcast = now
        }
        try { ws.send(data) } catch { /* ignore */ }
      }
    }
  }

  // Cleanup on close
  const originalClose = wss.close.bind(wss)
  wss.close = function () {
    clearInterval(heartbeatTimer)
    if (pendingStageTimer) { clearTimeout(pendingStageTimer); pendingStageTimer = null }
    for (const [ws] of clients) {
      try { ws.terminate() } catch { /* ignore */ }
    }
    clients.clear()
    return originalClose()
  }

  return { wss, broadcast }
}

module.exports = { createWsServer }
