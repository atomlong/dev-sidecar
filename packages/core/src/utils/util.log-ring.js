// log4js 自定义 appender：结构化日志环形缓冲（WebUI 实时日志的数据源）。
// 由 util.logger.js 以模块对象 type 挂到所有 category。容量与消息长度受限，
// 内存上界约 3000 × ~2KB ≈ 6MB。fork 出的子进程不本地存储，经 IPC 转发
// 给主进程（见 configure），主进程用 appendExternal 接收。

const DEFAULT_CAPACITY = 3000
const MAX_MESSAGE_LENGTH = 2000
const LEVEL_ORDER = { trace: 0, debug: 1, info: 2, warn: 3, error: 4, fatal: 5 }

let capacity = DEFAULT_CAPACITY
const ring = []
const listeners = new Set()
let seq = 0

function truncate (text, max) {
  const str = String(text)
  return str.length > max ? str.slice(0, max) + '…[截断]' : str
}

// log4js 的 data 是调用参数数组：字符串直接拼、对象 JSON 序列化、Error 取堆栈
function formatData (data) {
  if (!Array.isArray(data)) {
    return truncate(data, MAX_MESSAGE_LENGTH)
  }
  const parts = []
  for (const item of data) {
    if (item instanceof Error) {
      parts.push(truncate(item.stack || String(item), MAX_MESSAGE_LENGTH))
      continue
    }
    if (typeof item === 'string') {
      parts.push(truncate(item, MAX_MESSAGE_LENGTH))
      continue
    }
    if (item === null || item === undefined) {
      parts.push(String(item))
      continue
    }
    try {
      parts.push(truncate(JSON.stringify(item), MAX_MESSAGE_LENGTH))
    } catch {
      parts.push('[unserializable]')
    }
  }
  return parts.join(' ')
}

function pushEntry (entry) {
  entry.seq = ++seq
  ring.push(entry)
  if (ring.length > capacity) {
    ring.splice(0, ring.length - capacity)
  }
  for (const cb of listeners) {
    try { cb(entry) } catch { /* 订阅方异常不能影响日志主流程 */ }
  }
}

// ---- log4js appender 工厂（log4js 按 type 路径加载后调用 configure）----
function configure () {
  return function appender (loggingEvent) {
    const entry = {
      ts: loggingEvent.startTime ? new Date(loggingEvent.startTime).getTime() : Date.now(),
      level: loggingEvent.level && loggingEvent.level.levelStr
        ? String(loggingEvent.level.levelStr).toLowerCase()
        : 'info',
      category: loggingEvent.categoryName || 'default',
      message: formatData(loggingEvent.data),
    }
    // fork 出的子进程（mitmproxy）没有 webui，本地缓冲无人读——直接把
    // 条目经 IPC 送回主进程写入主进程环形缓冲，让 WebUI 也能看到 server 日志。
    // 仅认 core fork 时注入的 DS_LOG_IPC_FORWARD 标记（pnpm/mocha 下的进程
    // 也可能有 process.send，不能只看它的存在与否）。IPC 断开时静默降级
    // （日志仍走文件/stdout appender），不影响日志主流程。
    if (process.env.DS_LOG_IPC_FORWARD === '1' && typeof process.send === 'function') {
      try { process.send({ __dsLog: entry }) } catch { /* channel closed */ }
      return
    }
    pushEntry(entry)
  }
}

// 主进程侧：接收子进程 IPC 转发的日志条目并写入本地环形缓冲。
// 防御性清洗——非法 level/category/非对象消息直接丢弃。
function appendExternal (raw) {
  if (!raw || typeof raw !== 'object') {
    return
  }
  const level = String(raw.level || '').toLowerCase()
  const category = String(raw.category || '')
  if (LEVEL_ORDER[level] == null || !category) {
    return
  }
  pushEntry({
    ts: Number(raw.ts) || Date.now(),
    level,
    category,
    message: truncate(raw.message == null ? '' : String(raw.message), MAX_MESSAGE_LENGTH),
  })
}

function getEntries ({ level = '', q = '', category = '', limit = 1000 } = {}) {
  const minLevel = LEVEL_ORDER[String(level).toLowerCase()] || 0
  const needle = String(q).toLowerCase()
  const wantCategory = String(category)
  const max = Math.max(1, Math.min(Number(limit) || 1000, 5000))
  const matched = []
  // 倒序收集后反转：优先保留最新条目，返回保持时间升序（终端式展示）
  for (let i = ring.length - 1; i >= 0 && matched.length < max; i--) {
    const e = ring[i]
    if (LEVEL_ORDER[e.level] == null || LEVEL_ORDER[e.level] < minLevel) {
      continue
    }
    if (wantCategory && e.category !== wantCategory) {
      continue
    }
    if (needle && !(e.message.toLowerCase().includes(needle) || e.category.toLowerCase().includes(needle))) {
      continue
    }
    matched.push(e)
  }
  return matched.reverse()
}

function getCategories () {
  const seen = []
  const set = new Set()
  for (const e of ring) {
    if (!set.has(e.category)) {
      set.add(e.category)
      seen.push(e.category)
    }
  }
  return seen
}

function getCapacity () {
  return capacity
}

function subscribe (listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// 仅测试使用：重置缓冲与订阅者，可指定小容量验证淘汰逻辑
function _resetForTest (testCapacity) {
  ring.length = 0
  listeners.clear()
  seq = 0
  capacity = Number.isInteger(testCapacity) && testCapacity > 0 ? testCapacity : DEFAULT_CAPACITY
}

module.exports = {
  configure,
  appendExternal,
  getEntries,
  getCategories,
  getCapacity,
  subscribe,
  _resetForTest,
}
