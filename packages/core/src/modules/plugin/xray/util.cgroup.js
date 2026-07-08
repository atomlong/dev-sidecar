const fs = require('node:fs')
const path = require('node:path')

// Resolve the current process's cgroup path from /proc/self/cgroup.
// Returns '' on non-Linux or on read failure.
function getCurrentProcessCgroupPath () {
  if (process.platform !== 'linux') {
    return ''
  }

  try {
    const cgroupText = fs.readFileSync('/proc/self/cgroup', 'utf8').trim().split('\n')[0] || ''
    const parts = cgroupText.split(':')
    const relativePath = parts.length >= 3 ? parts.slice(2).join(':') : ''
    return relativePath ? path.join('/sys/fs/cgroup', relativePath.replace(/^\/+/, '')) : ''
  } catch {
    return ''
  }
}

function readFirstLine (filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8').trim().split('\n')[0] || ''
  } catch {
    return ''
  }
}

function readCgroupMemoryValue (cgroupPath, fileName) {
  if (!cgroupPath) {
    return null
  }

  const raw = readFirstLine(path.join(cgroupPath, fileName))
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

function readCgroupMemoryStat (cgroupPath) {
  const result = {}
  if (!cgroupPath) {
    return result
  }

  let statText = ''
  try {
    statText = fs.readFileSync(path.join(cgroupPath, 'memory.stat'), 'utf8')
  } catch {
    return result
  }

  for (const line of statText.split('\n')) {
    const [key, rawValue] = line.trim().split(/\s+/)
    if (!key || rawValue == null) {
      continue
    }
    const value = Number(rawValue)
    if (Number.isFinite(value)) {
      result[key] = value
    }
  }

  return result
}

function getCgroupMemoryUsage () {
  const cgroupPath = getCurrentProcessCgroupPath()
  if (!cgroupPath) {
    return null
  }

  const current = readCgroupMemoryValue(cgroupPath, 'memory.current')
  const peak = readCgroupMemoryValue(cgroupPath, 'memory.peak')
  if (current == null && peak == null) {
    return null
  }

  const stat = readCgroupMemoryStat(cgroupPath)
  return {
    current,
    peak,
    anon: stat.anon,
    file: stat.file,
    kernel: stat.kernel,
    fileDirty: stat.file_dirty,
    inactiveFile: stat.inactive_file,
    activeFile: stat.active_file,
  }
}

function formatMemoryUsageMb (value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric < 0) {
    return 'n/a'
  }
  return `${(numeric / (1024 * 1024)).toFixed(1)}MB`
}

module.exports = {
  getCurrentProcessCgroupPath,
  readFirstLine,
  readCgroupMemoryValue,
  readCgroupMemoryStat,
  getCgroupMemoryUsage,
  formatMemoryUsageMb,
}
