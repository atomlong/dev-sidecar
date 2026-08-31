const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const xrayProcess = require('../src/modules/plugin/xray/process')

const isLinux = process.platform === 'linux'
// Real-process tests are fine on dev machines (incl. WSL2); skip them only
// on hosted CI where process/kill timing can be flaky.
const isCI = process.env.CI === 'true'

// Spawn a long-lived child whose cmdline contains both the fake "binary"
// path marker and the config path, mirroring `xray -c config.json`.
function spawnFakeXray (configPath) {
  return spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)', configPath], {
    stdio: 'ignore',
  })
}

function isAlive (pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('xray stale process cleanup', () => {
  let tmpDir

  beforeEach(function () {
    if (!isLinux) {
      this.skip()
    }
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-xray-stale-'))
  })

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('returns false when no pidfile exists', async () => {
    const configPath = path.join(tmpDir, 'config.json')
    const result = await xrayProcess.cleanupStaleProcess(process.execPath, configPath)
    assert.equal(result, false)
  })

  it('kills a stale own-xray process recorded in the pidfile', async function () {
    if (isCI) {
      this.skip()
    }
    const configPath = path.join(tmpDir, 'config.json')
    const child = spawnFakeXray(configPath)
    await new Promise(resolve => child.on('spawn', resolve))

    const pidFile = path.join(tmpDir, 'xray.pid')
    fs.writeFileSync(pidFile, String(child.pid))

    const result = await xrayProcess.cleanupStaleProcess(process.execPath, configPath)

    assert.equal(result, true)
    assert.equal(isAlive(child.pid), false)
    assert.equal(fs.existsSync(pidFile), false)
  })

  it('refuses to kill a pid whose cmdline does not match the xray binary', async function () {
    if (isCI) {
      this.skip()
    }
    const configPath = path.join(tmpDir, 'config.json')
    const child = spawnFakeXray(configPath)
    await new Promise(resolve => child.on('spawn', resolve))
    try {
      const pidFile = path.join(tmpDir, 'xray.pid')
      fs.writeFileSync(pidFile, String(child.pid))

      const result = await xrayProcess.cleanupStaleProcess('/nonexistent/xray-bin', configPath)

      assert.equal(result, false)
      assert.equal(isAlive(child.pid), true)
      assert.equal(fs.existsSync(pidFile), true)
    } finally {
      child.kill('SIGKILL')
    }
  })

  it('removes the pidfile when the recorded pid is already dead', async function () {
    const configPath = path.join(tmpDir, 'config.json')
    const child = spawnFakeXray(configPath)
    await new Promise(resolve => child.on('spawn', resolve))
    child.kill('SIGKILL')
    await new Promise(resolve => child.on('exit', resolve))

    const pidFile = path.join(tmpDir, 'xray.pid')
    fs.writeFileSync(pidFile, String(child.pid))

    const result = await xrayProcess.cleanupStaleProcess(process.execPath, configPath)

    assert.equal(result, false)
    assert.equal(fs.existsSync(pidFile), false)
  })
})
