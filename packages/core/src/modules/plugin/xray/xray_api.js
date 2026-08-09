const { execFile } = require('node:child_process')

const API_TIMEOUT_MS = 5000

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

// Add outbounds via HandlerService gRPC API (no process restart)
// outbounds: array of outbound config objects (with tag, protocol, settings, ...)
async function addOutbounds (binPath, apiPort, outbounds) {
  if (!apiPort || !binPath) {
    throw new Error('addOutbounds: apiPort and binPath are required')
  }
  const server = `127.0.0.1:${apiPort}`
  // xray api ado reads JSON from stdin when arg is "stdin:"
  // The JSON format is the same as config.json outbounds array
  const input = JSON.stringify({ outbounds })
  return runXrayApi(binPath, ['ado', '--server', server, 'stdin:'], { input })
}

// Remove outbounds by tag via HandlerService gRPC API (no process restart)
// tags: array of tag strings
async function removeOutbounds (binPath, apiPort, tags) {
  if (!apiPort || !binPath) {
    throw new Error('removeOutbounds: apiPort and binPath are required')
  }
  const server = `127.0.0.1:${apiPort}`
  const results = []
  for (const tag of tags) {
    try {
      const out = await runXrayApi(binPath, ['rmo', '--server', server, tag])
      results.push({ tag, success: true, output: out })
    } catch (err) {
      results.push({ tag, success: false, error: err.message })
    }
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
