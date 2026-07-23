const fs = require('node:fs')
const path = require('node:path')
const childProcess = require('node:child_process')

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

// Move a child process (by PID) into an isolated sibling cgroup so its file
// cache does NOT count against the dev-sidecar service's MemoryHigh limit.
//
// This is critical for cold-boot: xray probe processes read an 800MB+ SQLite
// cache, pulling ~137MB of file pages into the cgroup. On warm boot the system
// page cache already holds these pages (not charged to any cgroup), but on
// cold boot they are freshly faulted in and charged to dev-sidecar.service,
// pushing memory.current to ~230MB against a 280MB MemoryHigh.
//
// The isolated cgroup has memory.high=max (no limit) — we only want to move
// the file-cache charge out, not restrict the probe process.
//
// Uses the /usr/lib/dev-sidecar/xray-probe-cgroup.sh helper via `sudo -n`
// (configured by the deb postinst sudoers drop-in).
//
// Returns the target cgroup path on success, '' on failure (non-fatal).
function moveProcessToIsolatedCgroup (pid, scopeName = 'dev-sidecar-xray-probe.scope') {
  if (process.platform !== 'linux') {
    return ''
  }

  const helperPath = '/usr/lib/dev-sidecar/xray-probe-cgroup.sh'
  const targetPath = `/sys/fs/cgroup/system.slice/${scopeName}`

  try {
    childProcess.execFileSync('sudo', ['-n', helperPath, 'create', String(pid)], { timeout: 5000, stdio: 'ignore' })
    return targetPath
  } catch {
    // best-effort: if cgroup isolation fails, the probe still runs in the
    // service cgroup (same as before this optimization)
    return ''
  }
}

// Remove an isolated cgroup scope after the probe process has exited.
// The cgroup must be empty (no processes) for rmdir to succeed.
function cleanupIsolatedCgroup (scopeName = 'dev-sidecar-xray-probe.scope') {
  if (process.platform !== 'linux') {
    return
  }

  const helperPath = '/usr/lib/dev-sidecar/xray-probe-cgroup.sh'
  try {
    childProcess.execFileSync('sudo', ['-n', helperPath, 'cleanup'], { timeout: 3000, stdio: 'ignore' })
  } catch {
    // best-effort: if rmdir fails (process still exiting), systemd will
    // clean up the empty cgroup eventually
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
  moveProcessToIsolatedCgroup,
  cleanupIsolatedCgroup,
  readFirstLine,
  readCgroupMemoryValue,
  readCgroupMemoryStat,
  getCgroupMemoryUsage,
  formatMemoryUsageMb,
}
