const { URL } = require('node:url')

/**
 * Safely decodes a Base64 string.
 */
function safeBase64Decode (b64) {
  if (!b64) return ''
  // Strip whitespace
  let str = b64.replace(/\s/g, '')
  // Fix padding
  str = str.replace(/-/g, '+').replace(/_/g, '/')
  while (str.length % 4) {
    str += '='
  }
  return Buffer.from(str, 'base64').toString('utf-8')
}

/**
 * Parses a VLESS link.
 */
function parseVless (link) {
  try {
    // Fix: Remove spaces before hash tag and encode other spaces (e.g. in tag)
    link = link.replace(/\s+#/g, '#').replace(/ /g, '%20')
    const url = new URL(link)
    const params = url.searchParams

    const proxy = {
      tag: decodeURIComponent(url.hash).substring(1) || `vless-${url.hostname}:${url.port}`,
      protocol: 'vless',
      settings: {
        vnext: [{
          address: url.hostname,
          port: Number.parseInt(url.port, 10),
          users: [{
            id: url.username,
            encryption: (function () {
              const e = (params.get('encryption') || 'none').trim().replace(/[=]/g, '')
              return e === 'none' ? 'none' : 'none'
            })(),
            flow: (params.get('flow') || '').trim(),
          }],
        }],
      },
      streamSettings: {
        network: (function () {
          const n = (params.get('type') || 'tcp').trim()
          // Allow only valid Xray transport protocols
          return /^(tcp|kcp|ws|http|domainsocket|quic|grpc|httpupgrade|xhttp)$/.test(n) ? n : 'tcp'
        })(),
        security: (function () {
          const s = (params.get('security') || 'none').trim()
          return /^(none|tls|reality)$/.test(s) ? s : 'none'
        })(),
      },
    }

    if (proxy.streamSettings.security === 'tls') {
      let fingerprint = (params.get('fp') || '').trim()
      if (fingerprint && !/^(chrome|firefox|safari|ios|android|edge|360|qq|random|randomized)$/.test(fingerprint)) {
        fingerprint = ''
      }
      proxy.streamSettings.tlsSettings = {
        serverName: (params.get('sni') || '').trim(),
        alpn: params.get('alpn') ? params.get('alpn').trim().split(',') : undefined,
        fingerprint,
      }
    } else if (proxy.streamSettings.security === 'reality') {
      let fingerprint = (params.get('fp') || '').trim()
      if (fingerprint && !/^(chrome|firefox|safari|ios|android|edge|360|qq|random|randomized)$/.test(fingerprint)) {
        fingerprint = ''
      }
      proxy.streamSettings.realitySettings = {
        show: false,
        fingerprint,
        serverName: (params.get('sni') || '').trim(),
        publicKey: (params.get('pbk') || '').trim(),
        shortId: (function () {
          const sid = (params.get('sid') || '').trim()
          return /^[0-9a-fA-F]+$/.test(sid) ? sid : ''
        })(),
        spiderX: (params.get('spx') || '').trim(),
      }
    }

    if (proxy.streamSettings.network === 'ws') {
      proxy.streamSettings.wsSettings = {
        path: (params.get('path') || '/').trim(),
        headers: {
          Host: (params.get('host') || '').trim(),
        },
      }
    } else if (proxy.streamSettings.network === 'grpc') {
      proxy.streamSettings.grpcSettings = {
        serviceName: (params.get('serviceName') || '').trim(),
        multiMode: params.get('mode') === 'multi',
      }
    } else if (proxy.streamSettings.network === 'http') {
      proxy.streamSettings.httpSettings = {
        path: (params.get('path') || '/').trim(),
        host: (params.get('host') || '').trim().split(','),
      }
    } else if (proxy.streamSettings.network === 'kcp') {
      proxy.streamSettings.kcpSettings = {
        header: {
          type: (params.get('headerType') || 'none').trim(),
        },
        seed: (params.get('seed') || '').trim(),
      }
    } else if (proxy.streamSettings.network === 'quic') {
      proxy.streamSettings.quicSettings = {
        security: (params.get('quicSecurity') || 'none').trim(),
        key: (params.get('key') || '').trim(),
        header: {
          type: (params.get('headerType') || 'none').trim(),
        },
      }
    }

    return proxy
  } catch (e) {
    console.error('Parse VLESS error:', e)
    return null
  }
}

/**
 * Parses a VMess link.
 */
function parseVmess (link) {
  try {
    // Fix: Remove spaces before hash tag
    link = link.replace(/\s+#/g, '#')
    
    let base64Data = link.substring('vmess://'.length)
    // Strip hash tag if present (VMess usually keeps config in JSON, but link might have #comment)
    const hashIndex = base64Data.indexOf('#')
    if (hashIndex !== -1) {
      base64Data = base64Data.substring(0, hashIndex)
    }

    const decoded = safeBase64Decode(base64Data)
    const config = JSON.parse(decoded)

    const proxy = {
      tag: config.ps || `vmess-${config.add}:${config.port}`,
      protocol: 'vmess',
      settings: {
        vnext: [{
          address: config.add,
          port: Number.parseInt(config.port, 10),
          users: [{
            id: config.id,
            alterId: Number.parseInt(config.aid || 0, 10),
            security: config.scy || 'auto',
          }],
        }],
      },
      streamSettings: {
        network: (function () {
          const n = (config.net || 'tcp').trim()
          return /^(tcp|kcp|ws|http|domainsocket|quic|grpc|httpupgrade|xhttp)$/.test(n) ? n : 'tcp'
        })(),
        security: config.tls === 'tls' ? 'tls' : 'none',
        tlsSettings: {},
        wsSettings: {},
        tcpSettings: {},
        kcpSettings: {},
        httpSettings: {},
        quicSettings: {},
        grpcSettings: {},
      },
    }

    if (proxy.streamSettings.security === 'tls') {
      proxy.streamSettings.tlsSettings = {
        serverName: config.sni || config.host || '',
        alpn: config.alpn ? config.alpn.split(',') : undefined,
      }
    }

    if (config.net === 'ws') {
      proxy.streamSettings.wsSettings = {
        path: config.path || '/',
        headers: {
          Host: config.host || '',
        },
      }
    } else if (config.net === 'grpc') {
      proxy.streamSettings.grpcSettings = {
        serviceName: config.path || '', // VMess gRPC path often used as serviceName
        multiMode: config.type === 'multi',
      }
    } else if (config.net === 'h2' || config.net === 'http') {
      proxy.streamSettings.httpSettings = {
        path: config.path || '/',
        host: (config.host || '').split(','),
      }
    } else if (config.net === 'kcp') {
      proxy.streamSettings.kcpSettings = {
        header: {
          type: config.type || 'none',
        },
      }
    } else if (config.net === 'quic') {
      proxy.streamSettings.quicSettings = {
        security: config.host || 'none', // quic security
        key: config.path || '', // key
        header: {
          type: config.type || 'none',
        },
      }
    }

    return proxy
  } catch (e) {
    console.error('Parse VMess error:', e)
    return null
  }
}

/**
 * Parses a Trojan link.
 */
function parseTrojan (link) {
  try {
    // Fix: Remove spaces before hash tag and encode other spaces (e.g. in tag)
    link = link.replace(/\s+#/g, '#').replace(/ /g, '%20')
    const url = new URL(link)
    const params = url.searchParams

    const proxy = {
      tag: decodeURIComponent(url.hash).substring(1) || `trojan-${url.hostname}:${url.port}`,
      protocol: 'trojan',
      settings: {
        servers: [{
          address: url.hostname,
          port: Number.parseInt(url.port, 10),
          password: decodeURIComponent(url.username || url.password),
        }],
      },
      streamSettings: {
        network: (function () {
          const n = (params.get('type') || 'tcp').trim()
          return /^(tcp|kcp|ws|http|domainsocket|quic|grpc|httpupgrade|xhttp)$/.test(n) ? n : 'tcp'
        })(),
        security: (function () {
          const s = (params.get('security') || 'tls').trim()
          return /^(none|tls|reality)$/.test(s) ? s : 'tls'
        })(),
        tlsSettings: {
          serverName: (params.get('sni') || '').trim(),
          alpn: params.get('alpn') ? params.get('alpn').trim().split(',') : undefined,
          fingerprint: (function () {
            let fp = (params.get('fp') || '').trim()
            if (fp && !/^(chrome|firefox|safari|ios|android|edge|360|qq|random|randomized)$/.test(fp)) {
              fp = ''
            }
            return fp
          })(),
        },
        realitySettings: (function () {
          if ((params.get('security') || 'tls').trim() === 'reality') {
            let fingerprint = (params.get('fp') || '').trim()
            if (fingerprint && !/^(chrome|firefox|safari|ios|android|edge|360|qq|random|randomized)$/.test(fingerprint)) {
              fingerprint = ''
            }
            return {
              show: false,
              fingerprint,
              serverName: (params.get('sni') || '').trim(),
              publicKey: (params.get('pbk') || '').trim(),
              shortId: (function () {
                const sid = (params.get('sid') || '').trim()
                return /^[0-9a-fA-F]+$/.test(sid) ? sid : ''
              })(),
              spiderX: (params.get('spx') || '').trim(),
            }
          }
          return undefined
        })(),
        wsSettings: {},
        grpcSettings: {},
      },
    }

    if (proxy.streamSettings.network === 'ws') {
      proxy.streamSettings.wsSettings = {
        path: (params.get('path') || '/').trim(),
        headers: {
          Host: (params.get('host') || '').trim(),
        },
      }
    } else if (proxy.streamSettings.network === 'grpc') {
      proxy.streamSettings.grpcSettings = {
        serviceName: (params.get('serviceName') || '').trim(),
      }
    }

    return proxy
  } catch (e) {
    console.error('Parse Trojan error:', e)
    return null
  }
}

/**
 * Parses a Shadowsocks link.
 */
function parseSs (link) {
  try {
    // ss://Base64(method:password)@server:port#tag
    // or ss://Base64(method:password@server:port)#tag
    // Fix: Remove spaces before hash tag (e.g. "ss://... # tag") which causes new URL() to throw
    // Also encode remaining spaces (e.g. in tag) to prevent ERR_INVALID_URL
    link = link.replace(/\s+#/g, '#').replace(/ /g, '%20')
    const url = new URL(link)
    let method, password, server, port
    const tag = decodeURIComponent(url.hash).substring(1)

    // Legacy format: ss://BASE64
    // If username is empty and hostname looks like base64, try to decode hostname
    if (!url.username && !url.password && url.hostname && !url.port) {
      try {
        const decoded = safeBase64Decode(url.hostname)
        // Decoded should be method:password@server:port
        const atIndex = decoded.lastIndexOf('@')
        if (atIndex !== -1) {
          const userInfo = decoded.substring(0, atIndex).split(':')
          method = userInfo[0]
          try { password = decodeURIComponent(userInfo[1]) } catch (e) { password = userInfo[1] }
          const hostInfo = decoded.substring(atIndex + 1).split(':')
          server = hostInfo[0]
          port = Number.parseInt(hostInfo[1], 10)
        }
      } catch (e) {
        // Ignore
      }
    }

    if (!method) {
      if (url.username && !url.password) {
        // Potentially Base64 encoded user info or user@host
        try {
          const decoded = safeBase64Decode(url.username)
          if (decoded.includes('@')) {
            // user info contains host info? ss://Base64(method:password@server:port)
            const atIndex = decoded.lastIndexOf('@')
            const userInfo = decoded.substring(0, atIndex).split(':')
            method = userInfo[0]
            password = userInfo[1]
            const hostInfo = decoded.substring(atIndex + 1).split(':')
            server = hostInfo[0]
            port = Number.parseInt(hostInfo[1], 10)
          } else {
             // method:password
            const parts = decoded.split(':')
            method = parts[0]
            try { password = decodeURIComponent(parts[1]) } catch (e) { password = parts[1] }
            server = url.hostname
            port = Number.parseInt(url.port, 10)
          }
        } catch (e) {
          // Fallback
          method = url.username
          server = url.hostname
          port = Number.parseInt(url.port, 10)
        }
      } else {
        method = url.username
        try { password = decodeURIComponent(url.password) } catch (e) { password = url.password }
        server = url.hostname
        port = Number.parseInt(url.port, 10)
      }
    }

    return {
      tag: tag || `ss-${server}:${port}`,
      protocol: 'shadowsocks',
      settings: {
        servers: [{
          address: server,
          port,
          method,
          password,
        }],
      },
      streamSettings: {
        network: 'tcp',
      },
    }
  } catch (e) {
    console.error('Parse SS error:', e)
    return null
  }
}

module.exports = {
  parse (text) {
    const proxies = []
    if (!text) return proxies

    // Clean text: remove control chars but keep newlines
    // eslint-disable-next-line no-control-regex
    text = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')

    // Handle HTML break tags common in some subscription sources
    text = text.replace(/<br\s*\/?>/gi, '\n')

    // Handle concatenated links (e.g. vmess://...vmess://...) by ensuring they are on separate lines
    text = text.replace(/(vmess|vless|ss|trojan):\/\//gi, '\n$1://')

    // Check if whole text is Base64 (Subscription)
    let decodedText = text
    if (!text.includes('://')) {
      try {
        decodedText = safeBase64Decode(text)
      } catch (e) {
        // Not base64
      }
    }

    const lines = decodedText.split(/[\n\r]+/)
    for (let line of lines) {
      line = line.trim()
      if (!line || line.startsWith('#')) continue

      let p = null
      if (line.startsWith('vless://')) {
        p = parseVless(line)
      } else if (line.startsWith('vmess://')) {
        p = parseVmess(line)
      } else if (line.startsWith('trojan://')) {
        p = parseTrojan(line)
      } else if (line.startsWith('ss://')) {
        p = parseSs(line)
      }

      if (p) {
        // Validate proxy node
        let isValid = false
        if (p.protocol === 'vless' || p.protocol === 'vmess') {
          const vnext = p.settings.vnext?.[0]
          if (vnext && vnext.address && vnext.port > 0 && vnext.port < 65536) {
            // Must have ID (UUID) and it must be valid
            const user = vnext.users?.[0]
            const id = user?.id
            if (id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
              isValid = true
            }

            // Filter out Legacy XTLS (xtls-rprx-origin, xtls-rprx-direct, xtls-rprx-splice)
            // Xray 1.8+ removed support for these
            if (isValid && user?.flow && /xtls-rprx-(origin|direct|splice)/.test(user.flow)) {
              isValid = false
            }
          }
        } else if (p.protocol === 'trojan' || p.protocol === 'shadowsocks') {
          const server = p.settings.servers?.[0]
          if (server && server.address && server.port > 0 && server.port < 65536) {
            // Must have password
            if (server.password) {
              isValid = true
            }

            // Validate SS method
            if (isValid && p.protocol === 'shadowsocks') {
              const method = server.method
              // 1. Method should only contain alphanumeric and hyphens/underscores
              if (!method || !/^[a-zA-Z0-9-_]+$/.test(method)) {
                isValid = false
              }
              // 2. Enforce allowed ciphers (Only AEAD and SS-2022) to prevent Xray crash
              // Legacy stream ciphers (aes-cfb, aes-ctr, chacha20-ietf, etc.) are NOT supported
              const allowedMethods = /^(aes-(128|256)-gcm|chacha20-ietf-poly1305|xchacha20-ietf-poly1305|2022-blake3-aes-(128|256)-gcm|2022-blake3-chacha20-poly1305)$/
              if (isValid && !allowedMethods.test(method)) {
                isValid = false
              }

              // Validate and fix SS-2022 key
              if (isValid && method.startsWith('2022-blake3-')) {
                try {
                  let expectedBytes = 0
                  if (method.includes('aes-128-gcm')) {
                    expectedBytes = 16
                  } else if (method.includes('aes-256-gcm') || method.includes('chacha20-poly1305')) {
                    expectedBytes = 32
                  }

                  if (expectedBytes > 0) {
                    // Normalize base64 string
                    let key = server.password.replace(/-/g, '+').replace(/_/g, '/')
                    
                    // Truncate if too long (likely garbage like '=7')
                    // 16 bytes = 24 chars max, 32 bytes = 44 chars max
                    const maxLen = expectedBytes === 16 ? 24 : 44
                    if (key.length > maxLen) {
                      key = key.substring(0, maxLen)
                    }

                    // Check if it is valid base64
                    const buffer = Buffer.from(key, 'base64')
                    if (buffer.length !== expectedBytes) {
                      isValid = false
                    } else {
                      // Update with clean key (ensure padding is correct if we truncated)
                      server.password = key
                    }
                  }
                } catch (e) {
                  isValid = false
                }
              }
            }
          }
        }

        // Validate Reality settings
        if (isValid && p.streamSettings?.security === 'reality') {
          // Xray REALITY only supports RAW (tcp), XHTTP, and gRPC
          if (!['tcp', 'grpc', 'xhttp'].includes(p.streamSettings.network)) {
            isValid = false
          }

          const reality = p.streamSettings.realitySettings
          if (isValid && (!reality || !reality.publicKey)) {
            isValid = false
          } else if (isValid) {
            // Validate publicKey (Curve25519 public key in Base64)
            // 32 bytes encoded in Base64 is approx 43 chars.
            // If length is too short (e.g. 32 chars 'XYZ...'), it is invalid and causes Xray crash.
            if (reality.publicKey.length < 40) {
              isValid = false
            }
          }
        }

        // Filter out deprecated HTTP/H2 transport
        if (isValid && (p.streamSettings?.network === 'http' || p.streamSettings?.network === 'h2')) {
          isValid = false
        }

        // Filter out deprecated mKCP (header/seed removed in recent Xray)
        if (isValid && p.streamSettings?.network === 'kcp') {
          isValid = false
        }

        if (isValid) {
          proxies.push(p)
        }
      }
    }
    return proxies
  },
}
