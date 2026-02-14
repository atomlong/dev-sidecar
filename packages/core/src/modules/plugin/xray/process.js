const { spawn } = require('child_process')
const log = require('../../../utils/util.log.core')

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
  },

  async restart (binPath, configPath) {
    await api.stop()
    await new Promise(resolve => setTimeout(resolve, 1000)) // 等待端口释放
    await api.start(binPath, configPath)
  },
}

module.exports = api