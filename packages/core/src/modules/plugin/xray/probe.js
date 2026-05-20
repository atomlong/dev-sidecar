const { spawn } = require('node:child_process')
const http = require('node:http')

function getObservatoryStatusMap (metrics) {
  const observatory = metrics && (metrics.observatory || metrics.burstObservatory || metrics.Observatory || metrics.BurstObservatory)
  return observatory && typeof observatory === 'object' ? observatory : null
}

function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function fetchJson (url, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      if (response.statusCode !== 200) {
        response.resume()
        reject(new Error(`Unexpected metrics status: ${response.statusCode}`))
        return
      }

      let data = ''
      response.on('data', (chunk) => {
        data += chunk
      })
      response.on('end', () => {
        try {
          resolve(JSON.parse(data))
        } catch (e) {
          reject(e)
        }
      })
    })

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error('Metrics request timeout'))
    })

    request.on('error', reject)
  })
}

function getHealthPingStats (status) {
  if (!status || typeof status !== 'object') {
    return null
  }

  const healthPing = status.HealthPing || status.healthPing || status.health_ping || null
  if (!healthPing || typeof healthPing !== 'object') {
    return null
  }

  const all = Number(healthPing.All ?? healthPing.all ?? 0)
  const fail = Number(healthPing.Fail ?? healthPing.fail ?? 0)

  return {
    all: Number.isFinite(all) ? all : 0,
    fail: Number.isFinite(fail) ? fail : 0,
  }
}

function isObservationReady (metrics, expectedSamples = 1, expectedSubjectCount = 0) {
  const observatory = getObservatoryStatusMap(metrics)
  if (!observatory) {
    return false
  }

  const statuses = Object.values(observatory)
  if (statuses.length === 0) {
    return false
  }

  if (expectedSubjectCount > 0 && statuses.length < expectedSubjectCount) {
    return false
  }

  if (expectedSamples <= 1) {
    return true
  }

  return statuses.every((status) => {
    const healthPing = getHealthPingStats(status)
    return healthPing && healthPing.all >= expectedSamples
  })
}

function stopChild (child, options = {}) {
  return new Promise((resolve) => {
    if (!child || !child.pid || child.exitCode != null || child.signalCode != null) {
      resolve()
      return
    }

    const pid = child.pid
    const log = options.log
    const label = options.label || 'Xray 探测进程'
    const isProcessAlive = () => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }

    if (!isProcessAlive()) {
      resolve()
      return
    }

    let finished = false
    const finish = () => {
      if (finished) {
        return
      }
      finished = true
      resolve()
    }

    child.once('close', finish)
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      finish()
      return
    }

    setTimeout(() => {
      if (finished) {
        return
      }
      try {
        if (isProcessAlive()) {
          process.kill(pid, 'SIGKILL')
        }
      } catch {
        // ignore
      }
    }, 3000)

    setTimeout(finish, 3500)
    setTimeout(() => {
      if (!finished && isProcessAlive() && log && typeof log.warn === 'function') {
        log.warn(`${label} 发送 SIGKILL 后仍未退出: pid=${pid}`)
      }
    }, 3400)
  })
}

async function waitForObservatoryMetrics ({ metricsPort, timeoutMs = 45000, pollIntervalMs = 1000, child, expectedSamples = 1, expectedSubjectCount = 0 }) {
  const metricsUrl = `http://127.0.0.1:${metricsPort}/debug/vars`
  const deadline = Date.now() + timeoutMs
  let lastError = new Error('Observatory metrics are not ready yet')

  while (Date.now() < deadline) {
    if (child && (child.exitCode != null || child.signalCode != null)) {
      const exitReason = child.exitCode != null ? `code ${child.exitCode}` : `signal ${child.signalCode}`
      const details = child.__probeOutput ? `: ${child.__probeOutput}` : ''
      throw new Error(`Probe process exited early with ${exitReason}${details}`)
    }

    try {
      const metrics = await fetchJson(metricsUrl)
      if (isObservationReady(metrics, expectedSamples, expectedSubjectCount)) {
        return metrics
      }
      const observatory = getObservatoryStatusMap(metrics)
      const observedCount = observatory ? Object.keys(observatory).length : 0
      if (expectedSubjectCount > 0 && observedCount < expectedSubjectCount) {
        lastError = new Error(`Observatory metrics only collected ${observedCount}/${expectedSubjectCount} node statuses so far`)
      } else {
        lastError = new Error(`Observatory metrics have not collected ${expectedSamples} samples yet`)
      }
    } catch (e) {
      lastError = e
    }

    await sleep(pollIntervalMs)
  }

  throw lastError || new Error('Timed out waiting for observatory metrics')
}

function startProbeProcess ({ binPath, configPath, metricsPort, log, timeoutMs, expectedSamples = 1, expectedSubjectCount = 0 }) {
  const child = startXrayProcess({ binPath, configPath, log, purpose: 'batch' }).child

  const promise = waitForObservatoryMetrics({ metricsPort, timeoutMs, child, expectedSamples, expectedSubjectCount }).finally(() => stopChild(child, { log, label: 'Xray 批次探测进程' }))

  return {
    child,
    promise,
    stop: () => stopChild(child, { log, label: 'Xray 批次探测进程' }),
  }
}

function startXrayProcess ({ binPath, configPath, log, purpose = 'probe' }) {
  const child = spawn(binPath, ['-c', configPath])

  if (!child || !child.pid) {
    throw new Error('Failed to start Xray probe process')
  }

  if (purpose !== 'egress' && log && typeof log.info === 'function') {
    const label = purpose === 'egress'
      ? 'Xray 出口元数据探测进程'
      : purpose === 'batch'
        ? 'Xray 批次探测进程'
        : 'Xray 探测进程'
    log.info(`正在启动 ${label}: ${binPath} -c ${configPath}`)
  }

  child.stdout.on('data', (data) => {
    const text = data.toString().trim()
    if (text) {
      child.__probeOutput = `${child.__probeOutput || ''}\n${text}`.trim().slice(-200)
    }
    if (text && log && typeof log.debug === 'function') {
      log.debug(`[Xray Probe] ${text}`)
    }
  })

  child.stderr.on('data', (data) => {
    const text = data.toString().trim()
    if (text) {
      child.__probeOutput = `${child.__probeOutput || ''}\n${text}`.trim().slice(-200)
    }
    if (text && log && typeof log.debug === 'function') {
      log.debug(`[Xray Probe Error] ${text}`)
    }
  })

  return {
    child,
    stop: () => stopChild(child, { log, label: purpose === 'egress' ? 'Xray 出口元数据探测进程' : 'Xray 探测进程' }),
  }
}

module.exports = {
  startXrayProcess,
  startProbeProcess,
  waitForObservatoryMetrics,
}
