const { URL } = require('node:url')
const { StringDecoder } = require('node:string_decoder')

const STREAM_PARSE_SNIFF_CHARS = 64 * 1024
const STREAM_BASE64_DECODE_CHARS = 128 * 1024
const STREAM_PROTOCOL_TAIL_CHARS = 16 * 1024
const BASE64_SUBSCRIPTION_CHARS_REGEX = /^[A-Za-z0-9+/=_\-\s]+$/

/**
 * Safely decodes a Base64 string.
 */
function safeBase64Decode (b64) {
  if (!b64) return ''
  let str = String(b64)
  // Strip whitespace only when needed. Large subscription sources can contain
  // tens of thousands of VMess links; unconditional replace() creates a short-
  // lived copy for every node and pushes the stage2 RSS peak above the systemd
  // budget even though nodes are consumed in chunks.
  if (/\s/.test(str)) {
    str = str.replace(/\s/g, '')
  }
  // Fix URL-safe base64 only when needed for the same reason.
  if (/[-_]/.test(str)) {
    str = str.replace(/-/g, '+').replace(/_/g, '/')
  }
  while (str.length % 4) {
    str += '='
  }
  return Buffer.from(str, 'base64').toString('utf-8')
}

function normalizeVlessFlow (value) {
  const flow = String(value || '').trim()
  if (!flow || flow === 'none') {
    return ''
  }

  return /^(xtls-rprx-vision|xtls-rprx-vision-udp443)$/.test(flow) ? flow : ''
}

function sanitizeNodeForCurrentXray (node) {
  if (!node || typeof node !== 'object') {
    return node
  }

  if (node.protocol !== 'vless') {
    return node
  }

  const users = node.settings?.vnext?.[0]?.users
  if (!Array.isArray(users)) {
    return node
  }

  for (const user of users) {
    if (!user || typeof user !== 'object') {
      continue
    }

    user.flow = normalizeVlessFlow(user.flow)
  }

  return node
}

function isValidHostnameOrIp (value) {
  const text = String(value || '').trim()
  if (!text) {
    return false
  }

  if (/\s/.test(text) || /:\/\//.test(text) || /[\[\]\(\)\/]/.test(text)) {
    return false
  }

  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(text)) {
    return text.split('.').every((segment) => {
      const value = Number(segment)
      return Number.isInteger(value) && value >= 0 && value <= 255
    })
  }

  return /^(?=.{1,253}\.?$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])\.?$/.test(text)
}

function isNodeSupportedByCurrentXray (node) {
  if (!node || typeof node !== 'object') {
    return false
  }

  const streamSettings = node.streamSettings || {}
  if (streamSettings.network === 'xhttp' && (streamSettings.security === 'tls' || streamSettings.security === 'reality')) {
    const serverName = streamSettings.security === 'reality'
      ? streamSettings.realitySettings && streamSettings.realitySettings.serverName
      : streamSettings.tlsSettings && streamSettings.tlsSettings.serverName

    if (!isValidHostnameOrIp(serverName)) {
      return false
    }
  }

  return true
}

function normalizeRealitySpiderX (value) {
  const spiderX = String(value || '').trim()
  if (!spiderX) {
    return ''
  }

  if (!spiderX.startsWith('/') || /[\s\x00-\x1F\x7F]/.test(spiderX)) {
    return ''
  }

  return spiderX
}

function getBase64DecodedByteLength (value) {
  let normalized = String(value || '').trim().replace(/-/g, '+').replace(/_/g, '/')
  while (normalized.length % 4) {
    normalized += '='
  }

  return Buffer.from(normalized, 'base64').length
}

function forEachNonEmptyLine (text, handler) {
  const source = String(text || '')
  const visit = typeof handler === 'function' ? handler : null
  if (!visit || source.length === 0) {
    return
  }

  let start = 0
  for (let index = 0; index <= source.length; index += 1) {
    const code = index < source.length ? source.charCodeAt(index) : -1
    if (code !== 10 && code !== 13 && index !== source.length) {
      continue
    }

    if (index > start) {
      const line = source.slice(start, index).trim()
      if (line && !line.startsWith('#')) {
        visit(line)
      }
    }

    if (code === 13 && index + 1 < source.length && source.charCodeAt(index + 1) === 10) {
      index += 1
    }
    start = index + 1
  }
}

function normalizeSubscriptionText (text) {
  let normalized = String(text || '')
  if (!normalized) {
    return ''
  }

  // Clean text: remove control chars but keep newlines
  // eslint-disable-next-line no-control-regex
  normalized = normalized.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')

  // Handle HTML break tags common in some subscription sources
  normalized = normalized.replace(/<br\s*\/?>/gi, '\n')

  // Handle concatenated links (e.g. vmess://...vmess://...) only when the text
  // does not already appear to be newline-delimited. This avoids copying very
  // large subscription strings that are already line-oriented.
  if (!/[\r\n]/.test(normalized)) {
    normalized = normalized.replace(/(vmess|vless|ss|trojan|https?|socks5?|socks):\/\//gi, '\n$1://')
  }

  // Check if whole text is Base64 (Subscription)
  if (!normalized.includes('://')) {
    try {
      const decoded = safeBase64Decode(normalized)
      if (decoded) {
        normalized = decoded
      }
    } catch (e) {
      // Not base64
    }
  }

  return normalized
}

function shouldParseRawLineDelimitedSubscriptionText (text) {
  const source = String(text || '')
  if (!source || !source.includes('://') || !/[\r\n]/.test(source)) {
    return false
  }

  if (/<br\s*\/?>/i.test(source)) {
    return false
  }

  // normalizeSubscriptionText removes these control characters. When they are
  // absent, large plain line-delimited subscriptions can be parsed directly and
  // avoid building a second full-size normalized string before chunk flushing.
  // eslint-disable-next-line no-control-regex
  return !/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(source)
}

function shouldParseProtocolDelimitedSubscriptionText (text) {
  const source = String(text || '')
  if (!source || !source.includes('://') || /[\r\n]/.test(source)) {
    return false
  }

  if (/<br\s*\/?>/i.test(source)) {
    return false
  }

  // Same safety condition as the raw line-delimited fast path: when no
  // normalization-only control characters are present, concatenated link
  // subscriptions can be streamed by protocol boundaries. This avoids
  // normalizeSubscriptionText() doing a global replace() over multi-megabyte
  // plaintext proxy lists such as gfpcom/free-proxy-list/http.txt, which
  // briefly flattens/copies the whole string before the first parser chunk and
  // shows up as a cgroup anon spike in systemd memory. This only changes how
  // entries are split; every link is still parsed and emitted.
  // eslint-disable-next-line no-control-regex
  return !/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(source)
}

function getSubscriptionParseSource (text) {
  return shouldParseRawLineDelimitedSubscriptionText(text) ? String(text || '') : normalizeSubscriptionText(text)
}

const PROTOCOL_BOUNDARY_REGEX = /(vmess|vless|ss|trojan|https?|socks5?|socks):\/\//ig

function createChunkedNodeEmitter (options = {}) {
  const chunkSize = Math.max(1, Number(options.chunkSize) || 1000)
  const onChunk = typeof options.onChunk === 'function' ? options.onChunk : null
  const yieldEveryChunks = Math.max(1, Number(options.yieldEveryChunks) || 1)
  const protocolCounts = {}
  let totalNodes = 0
  let flushedChunkCount = 0
  const chunk = []

  const maybeYield = async () => {
    if (flushedChunkCount % yieldEveryChunks !== 0) {
      return
    }
    await new Promise(resolve => setImmediate(resolve))
  }

  const flushChunk = async () => {
    if (!onChunk || chunk.length === 0) {
      chunk.length = 0
      return
    }
    const output = chunk.slice()
    chunk.length = 0
    await onChunk(output)
    flushedChunkCount += 1
    await maybeYield()
  }

  const parseEntry = async (line) => {
    if (!line || line.startsWith('#')) {
      return
    }

    const parsedNode = parseLineToNode(line)
    if (!parsedNode || !isParsedNodeValid(parsedNode)) {
      return
    }

    totalNodes += 1
    const protocol = String(parsedNode.protocol || '').toLowerCase()
    if (protocol) {
      protocolCounts[protocol] = (protocolCounts[protocol] || 0) + 1
    }

    if (onChunk) {
      chunk.push(parsedNode)
      if (chunk.length >= chunkSize) {
        await flushChunk()
      }
    }
  }

  return {
    parseEntry,
    flushChunk,
    summary () {
      return {
        totalNodes,
        protocolCounts,
      }
    },
  }
}

function isLikelyBase64SubscriptionText (text) {
  const source = String(text || '').trim()
  if (!source || source.includes('://')) {
    return false
  }

  return BASE64_SUBSCRIPTION_CHARS_REGEX.test(source)
}

function createStreamingSubscriptionEntryParser (entryHandler) {
  const parseEntry = typeof entryHandler === 'function' ? entryHandler : async () => {}
  let mode = null
  let remainder = ''

  const parseProtocolEntries = async (text, isFinal) => {
    if (!text) {
      return
    }

    PROTOCOL_BOUNDARY_REGEX.lastIndex = 0
    const starts = []
    let match
    while ((match = PROTOCOL_BOUNDARY_REGEX.exec(text)) !== null) {
      starts.push(match.index)
    }

    if (starts.length === 0) {
      if (isFinal) {
        await parseEntry(text.trim())
        remainder = ''
      } else {
        remainder = text.length > STREAM_PROTOCOL_TAIL_CHARS ? text.slice(-STREAM_PROTOCOL_TAIL_CHARS) : text
      }
      return
    }

    let emitUntil = starts.length - 1
    for (let index = 0; index < emitUntil; index += 1) {
      await parseEntry(text.slice(starts[index], starts[index + 1]).trim())
    }

    if (isFinal) {
      await parseEntry(text.slice(starts[emitUntil]).trim())
      remainder = ''
    } else {
      remainder = text.slice(starts[emitUntil])
    }
  }

  const processText = async (text, isFinal = false) => {
    let source = String(text || '')
    if (!source && !isFinal) {
      return
    }

    if (mode === null && /[\r\n]/.test(remainder + source)) {
      mode = 'line'
    }

    if (mode === 'line') {
      source = remainder + source
      remainder = ''
      let start = 0
      for (let index = 0; index <= source.length; index += 1) {
        const code = index < source.length ? source.charCodeAt(index) : -1
        if (index === source.length && !isFinal) {
          break
        }
        if (code !== 10 && code !== 13 && index !== source.length) {
          continue
        }

        if (index > start) {
          await parseEntry(source.slice(start, index).trim())
        }

        if (code === 13 && index + 1 < source.length && source.charCodeAt(index + 1) === 10) {
          index += 1
        }
        start = index + 1
      }

      if (!isFinal && start <= source.length) {
        remainder = source.slice(start)
      }
      return
    }

    if (isFinal && mode === null) {
      mode = /[\r\n]/.test(remainder + source) ? 'line' : 'protocol'
    }

    await parseProtocolEntries(remainder + source, isFinal)
  }

  return {
    processText,
    finish: async () => processText('', true),
  }
}

function forEachProtocolDelimitedEntry (text, handler) {
  const source = String(text || '')
  const visit = typeof handler === 'function' ? handler : null
  if (!visit || source.length === 0) {
    return
  }

  PROTOCOL_BOUNDARY_REGEX.lastIndex = 0
  let currentStart = -1
  let match
  while ((match = PROTOCOL_BOUNDARY_REGEX.exec(source)) !== null) {
    if (currentStart >= 0 && match.index > currentStart) {
      const entry = source.slice(currentStart, match.index).trim()
      if (entry && !entry.startsWith('#')) {
        visit(entry)
      }
    }
    currentStart = match.index
  }

  if (currentStart >= 0 && currentStart < source.length) {
    const entry = source.slice(currentStart).trim()
    if (entry && !entry.startsWith('#')) {
      visit(entry)
    }
  }
}

function parseLineToNode (line) {
  if (line.startsWith('vless://')) {
    return parseVless(line)
  }
  if (line.startsWith('vmess://')) {
    return parseVmess(line)
  }
  if (line.startsWith('trojan://')) {
    return parseTrojan(line)
  }
  if (line.startsWith('ss://')) {
    return parseSs(line)
  }
  if (line.startsWith('http://') || line.startsWith('https://')) {
    return parseHttpProxy(line)
  }
  if (line.startsWith('socks://') || line.startsWith('socks5://')) {
    return parseSocksProxy(line)
  }

  return null
}

function isParsedNodeValid (p) {
  if (!p) {
    return false
  }

  sanitizeNodeForCurrentXray(p)

  let isValid = false
  if (p.protocol === 'vless' || p.protocol === 'vmess') {
    const vnext = p.settings.vnext?.[0]
    if (vnext && vnext.address && vnext.port > 0 && vnext.port < 65536) {
      const user = vnext.users?.[0]
      const id = user?.id
      if (id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
        isValid = true
      }

      if (isValid && user?.flow && /xtls-rprx-(origin|direct|splice)/.test(user.flow)) {
        isValid = false
      }
    }
  } else if (p.protocol === 'trojan' || p.protocol === 'shadowsocks') {
    const server = p.settings.servers?.[0]
    if (server && server.address && server.port > 0 && server.port < 65536) {
      if (server.password) {
        isValid = true
      }

      if (isValid && p.protocol === 'shadowsocks') {
        const method = server.method
        if (!method || !/^[a-zA-Z0-9-_]+$/.test(method)) {
          isValid = false
        }
        const allowedMethods = /^(aes-(128|256)-gcm|chacha20-ietf-poly1305|xchacha20-ietf-poly1305|2022-blake3-aes-(128|256)-gcm|2022-blake3-chacha20-poly1305)$/
        if (isValid && !allowedMethods.test(method)) {
          isValid = false
        }

        if (isValid && method.startsWith('2022-blake3-')) {
          try {
            let expectedBytes = 0
            if (method.includes('aes-128-gcm')) {
              expectedBytes = 16
            } else if (method.includes('aes-256-gcm') || method.includes('chacha20-poly1305')) {
              expectedBytes = 32
            }

            if (expectedBytes > 0) {
              let key = server.password.replace(/-/g, '+').replace(/_/g, '/')
              const maxLen = expectedBytes === 16 ? 24 : 44
              if (key.length > maxLen) {
                key = key.substring(0, maxLen)
              }

              const buffer = Buffer.from(key, 'base64')
              if (buffer.length !== expectedBytes) {
                isValid = false
              } else {
                server.password = key
              }
            }
          } catch (e) {
            isValid = false
          }
        }
      }
    }
  } else if (p.protocol === 'http' || p.protocol === 'socks') {
    const server = p.settings.servers?.[0]
    if (server && server.address && server.port > 0 && server.port < 65536) {
      isValid = true
    }
  }

  if (isValid && p.streamSettings?.security === 'reality') {
    if (!['tcp', 'grpc', 'xhttp'].includes(p.streamSettings.network)) {
      isValid = false
    }

    const reality = p.streamSettings.realitySettings
    if (isValid && (!reality || !reality.publicKey)) {
      isValid = false
    } else if (isValid) {
      if (!/^[A-Za-z0-9_-]+={0,2}$/.test(reality.publicKey) || getBase64DecodedByteLength(reality.publicKey) !== 32) {
        isValid = false
      }
      const shortId = typeof reality.shortId === 'string' ? reality.shortId.trim() : ''
      if (isValid && shortId && !/^(?:[0-9a-fA-F]{2}){1,8}$/.test(shortId)) {
        isValid = false
      }
    }
  }

  if (isValid && (p.streamSettings?.network === 'http' || p.streamSettings?.network === 'h2')) {
    isValid = false
  }

  if (isValid && p.streamSettings?.network === 'kcp') {
    isValid = false
  }

  if (isValid && !isNodeSupportedByCurrentXray(p)) {
    isValid = false
  }

  return isValid
}

function parseInChunks (text, options = {}) {
  const chunkSize = Math.max(1, Number(options.chunkSize) || 1000)
  const onChunk = typeof options.onChunk === 'function' ? options.onChunk : null
  const protocolCounts = {}
  let totalNodes = 0
  const chunk = []

  const flushChunk = () => {
    if (!onChunk || chunk.length === 0) {
      chunk.length = 0
      return
    }
    const output = chunk.slice()
    chunk.length = 0
    onChunk(output)
  }

  const parseEntry = (line) => {
    const parsedNode = parseLineToNode(line)
    if (!parsedNode || !isParsedNodeValid(parsedNode)) {
      return
    }

    totalNodes += 1
    const protocol = String(parsedNode.protocol || '').toLowerCase()
    if (protocol) {
      protocolCounts[protocol] = (protocolCounts[protocol] || 0) + 1
    }

    if (onChunk) {
      chunk.push(parsedNode)
      if (chunk.length >= chunkSize) {
        flushChunk()
      }
    }
  }

  if (shouldParseProtocolDelimitedSubscriptionText(text)) {
    forEachProtocolDelimitedEntry(text, parseEntry)
  } else {
    const decodedText = getSubscriptionParseSource(text)
    forEachNonEmptyLine(decodedText, parseEntry)
  }

  flushChunk()
  return {
    totalNodes,
    protocolCounts,
  }
}

async function parseInChunksAsync (text, options = {}) {
  const emitter = createChunkedNodeEmitter(options)

  if (shouldParseProtocolDelimitedSubscriptionText(text)) {
    const source = String(text || '')
    PROTOCOL_BOUNDARY_REGEX.lastIndex = 0
    let currentStart = -1
    let match
    while ((match = PROTOCOL_BOUNDARY_REGEX.exec(source)) !== null) {
      if (currentStart >= 0 && match.index > currentStart) {
        await emitter.parseEntry(source.slice(currentStart, match.index).trim())
      }
      currentStart = match.index
    }
    if (currentStart >= 0 && currentStart < source.length) {
      await emitter.parseEntry(source.slice(currentStart).trim())
    }
  } else {
    // Avoid normalizeSubscriptionText() on large strings: it copies the entire
    // text via .replace(), which briefly doubles memory for multi-MB inputs.
    // Instead, use the raw text and normalize each line individually.
    const rawSource = String(text || '')
    const needsLineLevelNormalize = !shouldParseRawLineDelimitedSubscriptionText(text) && /[\r\n]/.test(rawSource)
    const source = needsLineLevelNormalize ? rawSource : (getSubscriptionParseSource(text) || rawSource)
    // eslint-disable-next-line no-control-regex
    const CTRL_CHAR_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g
    const BR_RE = /<br\s*\/?>/gi
    let start = 0
    for (let index = 0; index <= source.length; index += 1) {
      const code = index < source.length ? source.charCodeAt(index) : -1
      if (code !== 10 && code !== 13 && index !== source.length) {
        continue
      }

      let line = ''
      if (index > start) {
        line = source.slice(start, index).trim()
        if (needsLineLevelNormalize && line) {
          line = line.replace(CTRL_CHAR_RE, '').replace(BR_RE, '\n')
          // <br> may have split this line into sub-lines
          if (line.includes('\n')) {
            for (const subLine of line.split('\n')) {
              const trimmed = subLine.trim()
              if (trimmed) {
                await emitter.parseEntry(trimmed)
              }
            }
            line = ''
          }
        }
      }

      if (code === 13 && index + 1 < source.length && source.charCodeAt(index + 1) === 10) {
        index += 1
      }
      start = index + 1

      await emitter.parseEntry(line)
    }
  }

  await emitter.flushChunk()
  return emitter.summary()
}

async function parseReadableInChunksAsync (readable, options = {}) {
  if (!readable || typeof readable[Symbol.asyncIterator] !== 'function') {
    throw new TypeError('parseReadableInChunksAsync requires an async iterable readable stream')
  }

  const emitter = createChunkedNodeEmitter(options)
  const textParser = createStreamingSubscriptionEntryParser(emitter.parseEntry)
  const utf8Decoder = new StringDecoder('utf8')
  const base64Utf8Decoder = new StringDecoder('utf8')
  let mode = options.mode === 'base64' || options.mode === 'plain' ? options.mode : 'detect'
  let sniffBuffer = ''
  let base64Buffer = ''
  let bytes = 0

  const feedPlainBuffer = async (buffer) => {
    const text = utf8Decoder.write(buffer)
    if (text) {
      await textParser.processText(text)
    }
  }

  const feedBase64Text = async (text, isFinal = false) => {
    if (text) {
      base64Buffer += text.replace(/\s/g, '').replace(/-/g, '+').replace(/_/g, '/')
    }

    let usableLength = isFinal ? base64Buffer.length : base64Buffer.length - (base64Buffer.length % 4)
    if (!isFinal && usableLength > STREAM_BASE64_DECODE_CHARS) {
      usableLength -= usableLength % 4
    }

    if (usableLength > 0) {
      let part = base64Buffer.slice(0, usableLength)
      base64Buffer = base64Buffer.slice(usableLength)
      if (isFinal) {
        while (part.length % 4) {
          part += '='
        }
      }
      const decoded = Buffer.from(part, 'base64')
      const decodedText = base64Utf8Decoder.write(decoded)
      if (decodedText) {
        await textParser.processText(decodedText)
      }
    }

    if (isFinal) {
      const tail = base64Utf8Decoder.end()
      if (tail) {
        await textParser.processText(tail)
      }
    }
  }

  const decideMode = async (force = false) => {
    if (mode !== 'detect') {
      return
    }
    if (!force && sniffBuffer.length < STREAM_PARSE_SNIFF_CHARS && !sniffBuffer.includes('://')) {
      return
    }
    mode = isLikelyBase64SubscriptionText(sniffBuffer) ? 'base64' : 'plain'
    if (mode === 'base64') {
      await feedBase64Text(sniffBuffer)
    } else {
      await textParser.processText(sniffBuffer)
    }
    sniffBuffer = ''
  }

  for await (const item of readable) {
    const buffer = Buffer.isBuffer(item) ? item : Buffer.from(item)
    bytes += buffer.length

    if (mode === 'plain') {
      await feedPlainBuffer(buffer)
    } else if (mode === 'base64') {
      const text = utf8Decoder.write(buffer)
      if (text) {
        await feedBase64Text(text, false)
      }
    } else {
      sniffBuffer += utf8Decoder.write(buffer)
      await decideMode(false)
    }
  }

  if (mode === 'detect') {
    sniffBuffer += utf8Decoder.end()
    await decideMode(true)
  } else if (mode === 'plain') {
    const tail = utf8Decoder.end()
    if (tail) {
      await textParser.processText(tail)
    }
  } else {
    const tail = utf8Decoder.end()
    if (tail) {
      await feedBase64Text(tail)
    }
  }

  if (mode === 'base64') {
    await feedBase64Text('', true)
  }

  await textParser.finish()
  await emitter.flushChunk()
  return {
    ...emitter.summary(),
    bytes,
    streamMode: mode,
  }
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
            flow: normalizeVlessFlow(params.get('flow')),
          }],
        }],
      },
      streamSettings: {
        network: (function () {
          const n = (params.get('type') || 'tcp').trim()
          // Allow only valid Xray transport protocols
          return /^(tcp|kcp|ws|http|domainsocket|grpc|httpupgrade|xhttp)$/.test(n) ? n : 'tcp'
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
        spiderX: normalizeRealitySpiderX(params.get('spx')),
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
    if (/\s+#/.test(link)) {
      link = link.replace(/\s+#/g, '#')
    }
    
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
          return /^(tcp|kcp|ws|http|domainsocket|grpc|httpupgrade|xhttp)$/.test(n) ? n : 'tcp'
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
          return /^(tcp|kcp|ws|http|domainsocket|grpc|httpupgrade|xhttp)$/.test(n) ? n : 'tcp'
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
              spiderX: normalizeRealitySpiderX(params.get('spx')),
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

function parseHttpProxy (link) {
  try {
    const fastParsed = parseHttpProxyFast(link)
    if (fastParsed) {
      return fastParsed
    }

    link = link.replace(/\s+#/g, '#').replace(/ /g, '%20')
    const url = new URL(link)
    const isHttps = url.protocol === 'https:'
    const tag = decodeURIComponent(url.hash).substring(1)
    const server = {
      address: url.hostname,
      port: Number.parseInt(url.port, 10),
    }

    if (url.username || url.password) {
      server.users = [{
        user: decodeURIComponent(url.username || ''),
        pass: decodeURIComponent(url.password || ''),
      }]
    }

    const proxy = {
      tag: tag || `${isHttps ? 'https' : 'http'}-${server.address}:${server.port}`,
      protocol: 'http',
      settings: {
        servers: [server],
      },
    }

    if (isHttps) {
      proxy.streamSettings = {
        security: 'tls',
        tlsSettings: {
          serverName: url.hostname,
        },
      }
    }

    return proxy
  } catch (e) {
    console.error('Parse HTTP proxy error:', e)
    return null
  }
}

function decodeUrlComponentIfNeeded (value) {
  const text = String(value || '')
  if (!text.includes('%')) {
    return text
  }
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

function parseHttpProxyFast (link) {
  let source = typeof link === 'string' ? link.trim() : String(link || '').trim()
  if (!source) {
    return null
  }

  const lower = source.slice(0, 8).toLowerCase()
  const isHttps = lower.startsWith('https://')
  const isHttp = !isHttps && lower.startsWith('http://')
  if (!isHttp && !isHttps) {
    return null
  }

  // Keep complex URL forms on the standards-compliant fallback path. The large
  // plaintext proxy lists that dominate stage2 memory are simple
  // http(s)://[user[:pass]@]host:port[#tag] entries, so this avoids thousands of
  // transient WHATWG URL objects in the hot path without changing behavior for
  // uncommon forms.
  const protocolLength = isHttps ? 8 : 7
  source = source.slice(protocolLength)
  if (!source || /\s/.test(source)) {
    return null
  }

  let hash = ''
  const hashIndex = source.indexOf('#')
  if (hashIndex >= 0) {
    hash = source.slice(hashIndex + 1)
    source = source.slice(0, hashIndex)
  }

  if (!source || /[/?]/.test(source)) {
    return null
  }

  let auth = ''
  const atIndex = source.lastIndexOf('@')
  if (atIndex >= 0) {
    auth = source.slice(0, atIndex)
    source = source.slice(atIndex + 1)
  }

  let host = ''
  let portText = ''
  if (source.startsWith('[')) {
    const end = source.indexOf(']')
    if (end <= 1 || source[end + 1] !== ':') {
      return null
    }
    host = source.slice(1, end)
    portText = source.slice(end + 2)
  } else {
    const colonIndex = source.lastIndexOf(':')
    if (colonIndex <= 0) {
      return null
    }
    host = source.slice(0, colonIndex)
    portText = source.slice(colonIndex + 1)
  }

  const port = Number.parseInt(portText, 10)
  if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) {
    return null
  }

  const server = {
    address: decodeUrlComponentIfNeeded(host),
    port,
  }

  if (auth) {
    const colonIndex = auth.indexOf(':')
    const user = colonIndex >= 0 ? auth.slice(0, colonIndex) : auth
    const pass = colonIndex >= 0 ? auth.slice(colonIndex + 1) : ''
    server.users = [{
      user: decodeUrlComponentIfNeeded(user),
      pass: decodeUrlComponentIfNeeded(pass),
    }]
  }

  const tag = decodeUrlComponentIfNeeded(hash)
  const proxy = {
    tag: tag || `${isHttps ? 'https' : 'http'}-${server.address}:${server.port}`,
    protocol: 'http',
    settings: {
      servers: [server],
    },
  }

  if (isHttps) {
    proxy.streamSettings = {
      security: 'tls',
      tlsSettings: {
        serverName: server.address,
      },
    }
  }

  return proxy
}

function parseSocksProxy (link) {
  try {
    link = link.replace(/\s+#/g, '#').replace(/ /g, '%20')
    const url = new URL(link)
    const tag = decodeURIComponent(url.hash).substring(1)
    const server = {
      address: url.hostname,
      port: Number.parseInt(url.port, 10),
    }

    if (url.username || url.password) {
      server.users = [{
        user: decodeURIComponent(url.username || ''),
        pass: decodeURIComponent(url.password || ''),
      }]
    }

    return {
      tag: tag || `socks-${server.address}:${server.port}`,
      protocol: 'socks',
      settings: {
        servers: [server],
      },
    }
  } catch (e) {
    console.error('Parse SOCKS proxy error:', e)
    return null
  }
}

module.exports = {
  sanitizeNodeForCurrentXray,
  isParsedNodeValid,
  isNodeSupportedByCurrentXray,
  parseInChunks,
  parseInChunksAsync,
  parseReadableInChunksAsync,
  parse (text) {
    const proxies = []
    if (!text) return proxies

    parseInChunks(text, {
      chunkSize: 1000,
      onChunk: (items) => {
        proxies.push(...items)
      },
    })

    return proxies
  },
}
