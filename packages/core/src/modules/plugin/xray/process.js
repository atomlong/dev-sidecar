const { spawn } = require('child_process')
const log = require('../../../utils/util.log.core')
const { moveProcessToIsolatedCgroup, cleanupIsolatedCgroup } = require('./util.cgroup')

let child = null
let isExpectedExit = false
let currentBinPath = ''
let currentConfigPath = ''

const api = {
  start (binPath, configPath) {
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
    child.kill()
    // 简单等待进程结束
    // 实际应该监听 close 事件，但这里简化处理
    child = null
    // Clean up the isolated cgroup scope after the main Xray process exits.
    // The scope is shared with probe processes; cleanup is best-effort
    // (rmdir fails if other probe processes are still running in it).
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

module.exports = api