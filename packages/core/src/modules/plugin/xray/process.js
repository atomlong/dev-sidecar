const { spawn } = require('child_process')
const fs = require('node:fs')
const path = require('node:path')
const log = require('../../../utils/util.log.core')
const { moveProcessToIsolatedCgroup, cleanupIsolatedCgroup } = require('./util.cgroup')

let child = null
let isExpectedExit = false
let currentBinPath = ''
let currentConfigPath = ''
let onUnexpectedExitCallback = null

// Pidfile lives next to the live config so a stale Xray from a previous
// service generation can be identified and cleaned on next startup.
function pidFilePathOf (configPath) {
  return configPath ? path.join(path.dirname(configPath), 'xray.pid') : null
}

function isPidAlive (pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// Verify the pid really is our own xray (cmdline contains the binary path
// and the config path) so a recycled pid is never killed.
function isOwnXrayProcess (pid, binPath, configPath) {
  if (process.platform !== 'linux') {
    // no /proc to verify identity — a recycled pid could be anything
    return false
  }
  let cmdline = ''
  try {
    cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8')
  } catch {
    return false
  }
  if (!cmdline.includes(binPath)) {
    return false
  }
  return !configPath || cmdline.includes(configPath)
}

// The main Xray is moved into an isolated cgroup (memory optimization), so
// systemd KillMode=control-group never reaches it on stop. If the service
// is killed hard (shutdown timeout), xray stays as an orphan holding the
// local port and the next start fails with a Strict Mode port conflict.
// Kill it here, identified via pidfile + cmdline verification.
async function cleanupStaleProcess (binPath, configPath) {
  const pidFile = pidFilePathOf(configPath)
  if (!pidFile || process.platform !== 'linux') {
    return false
  }
  let pid = 0
  try {
    pid = Number(fs.readFileSync(pidFile, 'utf8').trim())
  } catch {
    return false
  }
  if (!Number.isInteger(pid) || pid <= 0) {
    return false
  }
  if (!isPidAlive(pid)) {
    try { fs.rmSync(pidFile, { force: true }) } catch { /* stale file */ }
    return false
  }
  if (!isOwnXrayProcess(pid, binPath, configPath)) {
    return false
  }
  log.info(`检测到残留 Xray 进程 pid=${pid}（上次服务未正常关闭），正在清理...`)
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    return false
  }
  const deadline = Date.now() + 3000
  while (Date.now() < deadline && isPidAlive(pid)) {
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  if (isPidAlive(pid)) {
    try { process.kill(pid, 'SIGKILL') } catch { /* already exited */ }
  }
  try { fs.rmSync(pidFile, { force: true }) } catch { /* ignore */ }
  return true
}

const api = {
  start (binPath, configPath, { onUnexpectedExit } = {}) {
    if (onUnexpectedExit) {
      onUnexpectedExitCallback = onUnexpectedExit
    }
    return new Promise((resolve, reject) => {
      if (child) {
        resolve()
        return
      }
      currentBinPath = binPath
      currentConfigPath = configPath
      isExpectedExit = false

      log.info(`正在启动 Xray: ${binPath} -c ${configPath}`)

      try {
        child = spawn(binPath, ['-c', configPath])
      } catch (e) {
        log.error('Xray 启动异常:', e)
        reject(e)
        return
      }

      if (!child || !child.pid) {
        const msg = 'Xray 启动失败: 无法创建子进程，请检查路径是否正确'
        log.error(msg)
        child = null
        reject(new Error(msg))
        return
      }

      // Move the main Xray process into an isolated cgroup so its file cache
      // (GeoIP dat/mmdb, config, outbound TLS) does NOT count against
      // dev-sidecar's MemoryHigh limit. Same rationale as probe processes:
      // on cold boot the system page cache is empty and Xray's mmap/read
      // of geoip.dat + geosite.dat (~5.6MB) + config pages are freshly
      // charged to the service cgroup, contributing to the startup peak.
      const isolatedCgroup = moveProcessToIsolatedCgroup(child.pid)
      if (isolatedCgroup) {
        log.info(`Xray 已移至隔离 cgroup: ${isolatedCgroup}`)
      }

      const pidFile = pidFilePathOf(configPath)
      if (pidFile) {
        try { fs.writeFileSync(pidFile, String(child.pid)) } catch { /* best-effort */ }
      }

      log.info(`Xray 已启动, PID: ${child.pid}`)

      child.stdout.on('data', (data) => {
        const str = data.toString().trim()
        if (str) log.info(`[Xray] ${str}`)
      })

      child.stderr.on('data', (data) => {
        const str = data.toString().trim()
        if (str) log.error(`[Xray Error] ${str}`)
      })

      child.on('close', (code) => {
        log.info(`Xray 退出, code: ${code}`)
        child = null
        if (!isExpectedExit) {
          log.warn('Xray 异常退出，3秒后尝试重启...')
          if (typeof onUnexpectedExitCallback === 'function') {
            try { onUnexpectedExitCallback() } catch (e) { log.warn('Xray onUnexpectedExit 回调异常:', e) }
          }
          setTimeout(() => {
            api.start(currentBinPath, currentConfigPath).catch(err => {
              log.error('Xray 自动重启失败:', err)
            })
          }, 3000)
        }
      })

      child.on('error', (err) => {
        log.error('Xray 进程错误:', err)
        if (!child.pid) {
          reject(err)
        }
      })

      resolve()
    })
  },

  async stop () {
    if (!child) {
      return
    }
    isExpectedExit = true
    log.info('正在停止 Xray...')
    // 等 close 事件确保进程真正退出、端口释放，再返回。
    // 之前 child.kill() 后立即 child=null 不等退出，导致 systemctl restart
    // 时新 xray 启动发现端口仍被旧进程占用（"端口被占用"错误）。
    // 加 3 秒超时 SIGKILL 兜底，防止 xray 不响应 SIGTERM。
    const childRef = child
    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        log.warn('Xray SIGTERM 后 3 秒未退出，发送 SIGKILL')
        try { process.kill(childRef.pid, 'SIGKILL') } catch { /* already exited */ }
        resolve()
      }, 3000)
      childRef.once('close', () => {
        clearTimeout(timeout)
        resolve()
      })
      childRef.kill()
    })
    child = null
    const stalePidFile = pidFilePathOf(currentConfigPath)
    if (stalePidFile) {
      try { fs.rmSync(stalePidFile, { force: true }) } catch { /* ignore */ }
    }
    cleanupIsolatedCgroup()
  },

  async restart (binPath, configPath) {
    await api.stop()
    // Wait for the process to fully exit before starting a new one to avoid
    // port conflicts. Use a short 200ms sleep instead of 1000ms — the close
    // event in stop() sets child=null synchronously, but the OS may need a
    // brief moment to release the listening socket.
    await new Promise(resolve => setTimeout(resolve, 200))
    await api.start(binPath, configPath)
  },
}

module.exports = {
  start: api.start,
  stop: api.stop,
  restart: api.restart,
  cleanupStaleProcess,
}