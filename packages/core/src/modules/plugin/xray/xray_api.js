const { execFile } = require('node:child_process')

const API_TIMEOUT_MS = 5000
const RMO_CONCURRENCY = 16

function runXrayApi (binPath, args, { input = null, timeoutMs = API_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(binPath, ['api', ...args], {
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`xray api ${args[0]} failed: ${err.message}${stderr ? ` stderr: ${stderr}` : ''}`))
        return
      }
      resolve(stdout)
    })
    if (input && child.stdin) {
      child.stdin.write(input)
      child.stdin.end()
    }
  })
}

// Like runXrayApi but resolves even on non-zero exit code.
// ado stops processing on first invalid outbound (exit 1) but prior valid
// outbounds are already added — caller needs stdout to determine which
// succeeded. Returns { stdout, stderr, exitCode }.
function runXrayApiRaw (binPath, args, { input = null, timeoutMs = API_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const child = execFile(binPath, ['api', ...args], {
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
    }, (err, stdout, stderr) => {
      const exitCode = err ? (typeof err.code === 'number' ? err.code : 1) : 0
      resolve({ stdout: stdout || '', stderr: stderr || '', exitCode })
    })
    if (input && child.stdin) {
      child.stdin.write(input)
      child.stdin.end()
    }
  })
}

// Parse ado stdout to determine per-outbound success.
// Format: "adding: <tag>\n" followed by "{}" (possibly after warning lines) = success;
// "adding: <tag>\n" without {} before next "adding:" or EOF = failure.
function parseAdoResults (stdout) {
  const results = []
  const lines = stdout.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^adding: (\S+)/)
    if (!match) {
      continue
    }
    const tag = match[1]
    let success = false
    // Scan forward until we find "{}" (success) or another "adding:" / EOF (failure)
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].match(/^adding: /)) {
        break
      }
      if (lines[j].trim() === '{}') {
        success = true
        break
      }
    }
    results.push({ tag, success })
  }
  return results
}

// Add outbounds via HandlerService gRPC API (no process restart).
// ado stops on first invalid outbound but prior valid ones are already added.
// Returns { results, addedTags, failedTags, stoppedEarly }.
async function addOutbounds (binPath, apiPort, outbounds) {
  if (!apiPort || !binPath) {
    throw new Error('addOutbounds: apiPort and binPath are required')
  }
  const server = `127.0.0.1:${apiPort}`
  const input = JSON.stringify({ outbounds })
  const { stdout, stderr, exitCode } = await runXrayApiRaw(binPath, ['ado', '--server', server, 'stdin:'], { input })

  const results = parseAdoResults(stdout)
  const addedTags = results.filter(r => r.success).map(r => r.tag)
  const failedTags = results.filter(r => !r.success).map(r => ({ tag: r.tag, error: stderr.trim() }))

  if (exitCode !== 0 && failedTags.length === 0 && results.length === 0) {
    throw new Error(`addOutbounds failed with exit code ${exitCode}: ${stderr}`)
  }

  return { results, addedTags, failedTags, stoppedEarly: exitCode !== 0 }
}

// Remove outbounds by tag via HandlerService gRPC API (no process restart).
// rmo is idempotent: removing a non-existent tag returns exit 0.
// Uses concurrent execution (default 16) to speed up bulk removal.
async function removeOutbounds (binPath, apiPort, tags, { concurrency = RMO_CONCURRENCY } = {}) {
  if (!apiPort || !binPath) {
    throw new Error('removeOutbounds: apiPort and binPath are required')
  }
  const server = `127.0.0.1:${apiPort}`
  const results = []
  for (let i = 0; i < tags.length; i += concurrency) {
    const batch = tags.slice(i, i + concurrency)
    const batchResults = await Promise.all(batch.map(async (tag) => {
      try {
        const out = await runXrayApi(binPath, ['rmo', '--server', server, tag])
        return { tag, success: true, output: out }
      } catch (err) {
        return { tag, success: false, error: err.message }
      }
    }))
    results.push(...batchResults)
  }
  return results
}

// List outbounds via HandlerService gRPC API
async function listOutbounds (binPath, apiPort) {
  if (!apiPort || !binPath) {
    throw new Error('listOutbounds: apiPort and binPath are required')
  }
  const server = `127.0.0.1:${apiPort}`
  const out = await runXrayApi(binPath, ['lso', '--server', server])
  return out
}

module.exports = {
  addOutbounds,
  removeOutbounds,
  listOutbounds,
}
