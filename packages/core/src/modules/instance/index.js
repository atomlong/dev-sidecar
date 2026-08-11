const fs = require('node:fs')
const path = require('node:path')
const lodash = require('lodash')
const lockfile = require('proper-lockfile')
const event = require('../../event')

const LOCK_FILE = 'dev-sidecar.lock'
const RUNNING_JSON = 'running.json'

function getBasePath () {
  return path.join(process.env.USERPROFILE || process.env.HOME || '/', '.dev-sidecar')
}

function getLockPath (userBasePath = getBasePath()) {
  return path.join(userBasePath, LOCK_FILE)
}

function getRunningJsonPath (userBasePath = getBasePath()) {
  return path.join(userBasePath, RUNNING_JSON)
}

function getDefaultLockOptions (log) {
  return {
    lockfilePath: getLockPath(),
    realpath: false,
    stale: 10000,
    retries: 0,
    onCompromised: (err) => {
      try {
        fs.rmdirSync(getLockPath())
      } catch {}
      if (log) {
        log.error('锁被篡改，进程退出:', err)
      }
      process.exit(1)
    },
  }
}

// 获取长锁，失败时抛错（不会无限阻塞）
async function acquireLock ({ log } = {}) {
  const release = await lockfile.lock(getLockPath(), getDefaultLockOptions(log))
  watchStatusEvents({ log })
  return release
}

// 检查给定 PID 是否存活且确实是 dev-sidecar 进程（避免 PID 复用误判）
function isDevSidecarPid (pid) {
  if (!pid || isNaN(pid)) {
    return false
  }
  // Linux: 读 /proc/<pid>/cmdline 验证进程名
  try {
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8')
    return cmdline.includes('dev-sidecar') || cmdline.includes('service-entry') || cmdline.includes('@docmirrordev-sidecar')
  } catch {}
  // 非 Linux 或读取失败：退化为仅检查 PID 存活
  try {
    return process.kill(pid, 0)
  } catch {
    return false
  }
}

// 检查锁是否被新鲜持有（非阻塞，用于启动前的友好提示）
async function isLocked () {
  try {
    const locked = await lockfile.check(getLockPath(), { lockfilePath: getLockPath(), realpath: false, stale: 10000 })
    if (!locked) {
      return false
    }
    // 锁存在，但需验证持有锁的进程是否真是 dev-sidecar（防 PID 复用误判）
    const instance = readInstance()
    if (instance && instance.pid) {
      return isDevSidecarPid(instance.pid)
    }
    // 有锁但无实例信息，保守返回 true
    return true
  } catch {
    return false
  }
}

function readInstance () {
  const filePath = getRunningJsonPath()
  if (!fs.existsSync(filePath)) {
    return null
  }
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    return data?.app?.instance || null
  } catch {
    return null
  }
}

function writeInstance (instance) {
  const filePath = getRunningJsonPath()
  let data = {}
  if (fs.existsSync(filePath)) {
    try {
      data = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    } catch {}
  }
  if (!data.app) {
    data.app = {}
  }
  data.app.instance = instance
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2))
}

let statusWriteTimer = null
let statusWriteQueue = {}

function resetStateForTest () {
  if (statusWriteTimer) {
    clearTimeout(statusWriteTimer)
    statusWriteTimer = null
  }
  statusWriteQueue = {}
  if (watchStatusListenerId != null) {
    event.unregister(watchStatusListenerId)
    watchStatusListenerId = null
  }
  watchStatusRegistered = false
}

// 将状态写入 running.json 的 app.status（事件驱动，300ms 防抖合并多次更新为一次写入）
function updateStatus (key, value) {
  if (typeof key !== 'string' || key.length === 0) {
    return
  }
  statusWriteQueue[key] = value
  if (statusWriteTimer) {
    return
  }
  statusWriteTimer = setTimeout(() => {
    statusWriteTimer = null
    const queue = statusWriteQueue
    statusWriteQueue = {}
    try {
      const filePath = getRunningJsonPath()
      let data = {}
      if (fs.existsSync(filePath)) {
        try {
          data = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
        } catch {}
      }
      if (!data.app) {
        data.app = {}
      }
      if (!data.app.status) {
        data.app.status = {}
      }
      for (const key in queue) {
        lodash.set(data.app.status, key, queue[key])
      }
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2))
    } catch {}
  }, 300)
}

// 订阅 core 状态总线，同步 *.enabled 开关状态和 plugin.xray 端口字段（过滤 free_eye.result 等大 payload）
// 幂等：重复调用不会多次注册（防止 acquireLock + 显式调用导致双注册）
let watchStatusRegistered = false
let watchStatusListenerId = null
function watchStatusEvents ({ log } = {}) {
  if (watchStatusRegistered) {
    return
  }
  watchStatusRegistered = true
  watchStatusListenerId = event.register('status', (e) => {
    if (!e || typeof e.key !== 'string') {
      return
    }
    if (e.key.endsWith('.enabled')) {
      updateStatus(e.key, e.value)
      return
    }
    // Sync xray runtime ports for debugging (curl /debug/vars, xray api lso/obs)
    if (e.key === 'plugin.xray.port' || e.key === 'plugin.xray.apiPort' || e.key === 'plugin.xray.metricsPort') {
      updateStatus(e.key, e.value)
    }
  })
}

module.exports = {
  acquireLock,
  isLocked,
  readInstance,
  writeInstance,
  updateStatus,
  watchStatusEvents,
  getLockPath,
  getRunningJsonPath,
  resetStateForTest,
}
