#!/usr/bin/env node

const fs = require('node:fs')
const path = require('node:path')
const childProcess = require('node:child_process')

function parseArgs (argv) {
  const args = {
    pid: null,
    match: 'dev-sidecar|electron|node.*dev-sidecar',
    intervalMs: 1000,
    durationMs: 10 * 60 * 1000,
    output: path.join('/tmp', `dev-sidecar-cgroup-samples-${Date.now()}.jsonl`),
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = () => argv[++index]
    if (arg === '--pid') {
      args.pid = Number(next()) || null
    } else if (arg === '--match') {
      args.match = next()
    } else if (arg === '--interval-ms') {
      args.intervalMs = Math.max(100, Number(next()) || args.intervalMs)
    } else if (arg === '--duration-ms') {
      args.durationMs = Math.max(args.intervalMs, Number(next()) || args.durationMs)
    } else if (arg === '--duration-sec') {
      args.durationMs = Math.max(args.intervalMs, (Number(next()) || 0) * 1000 || args.durationMs)
    } else if (arg === '--output') {
      args.output = path.resolve(next())
    } else if (arg === '-h' || arg === '--help') {
      args.help = true
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  return args
}

function printHelp () {
  console.log(`Usage: node packages/core/scripts/xray-cache-cgroup-sampler.js [options]

Sample real service memory during Xray cache Stage2/Stage3 validation.

Options:
  --pid <pid>             Process id to sample. If omitted, --match is used.
  --match <regex>         Process command regex for pgrep -f (default: dev-sidecar|electron|node.*dev-sidecar)
  --interval-ms <n>       Sampling interval in ms (default: 1000)
  --duration-sec <n>      Sampling duration in seconds (default: 600)
  --duration-ms <n>       Sampling duration in ms
  --output <path>         JSONL output path (default: /tmp/dev-sidecar-cgroup-samples-<ts>.jsonl)
  -h, --help              Show help

Each JSONL line contains cgroup memory.current/peak/stat, process RSS, and a max summary is printed at the end.
`)
}

function readText (filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8')
  } catch {
    return ''
  }
}

function readNumberFile (filePath) {
  const value = Number(readText(filePath).trim())
  return Number.isFinite(value) ? value : null
}

function parseMemoryStat (content) {
  const result = {}
  for (const line of String(content || '').split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/)
    if (parts.length === 2) {
      const value = Number(parts[1])
      if (Number.isFinite(value)) {
        result[parts[0]] = value
      }
    }
  }
  return result
}

function findPidByMatch (regexText) {
  const output = childProcess.execFileSync('pgrep', ['-f', regexText], { encoding: 'utf8' })
  const ownPid = process.pid
  const parentPid = process.ppid
  return output
    .split(/\r?\n/)
    .map(value => Number(value.trim()))
    .filter(pid => Number.isInteger(pid) && pid > 0 && pid !== ownPid && pid !== parentPid)[0] || null
}

function resolveCgroupBase (pid) {
  const cgroupText = readText(`/proc/${pid}/cgroup`)
  if (!cgroupText) {
    return null
  }

  const unified = cgroupText.split(/\r?\n/).map(line => line.trim()).find(line => line.startsWith('0::'))
  if (unified) {
    const relative = unified.split(':')[2] || '/'
    return path.join('/sys/fs/cgroup', relative)
  }

  const memoryLine = cgroupText.split(/\r?\n/).map(line => line.trim()).find(line => line.includes(':memory:'))
  if (memoryLine) {
    const relative = memoryLine.split(':')[2] || '/'
    return path.join('/sys/fs/cgroup/memory', relative)
  }

  return null
}

function readProcessRss (pid) {
  const status = readText(`/proc/${pid}/status`)
  const match = status.match(/^VmRSS:\s+(\d+)\s+kB$/m)
  return match ? Number(match[1]) * 1024 : null
}

function readSample (pid, cgroupBase) {
  const stat = parseMemoryStat(readText(path.join(cgroupBase, 'memory.stat')))
  return {
    ts: new Date().toISOString(),
    pid,
    processRss: readProcessRss(pid),
    cgroupCurrent: readNumberFile(path.join(cgroupBase, 'memory.current')),
    cgroupPeak: readNumberFile(path.join(cgroupBase, 'memory.peak')),
    cgroupStatFile: stat.file ?? null,
    cgroupStatAnon: stat.anon ?? null,
    cgroupStatFileDirty: stat.file_dirty ?? null,
    cgroupStatFileMapped: stat.file_mapped ?? null,
  }
}

function formatBytes (value) {
  if (value == null) return 'n/a'
  if (value >= 1024 * 1024 * 1024) return `${(value / 1024 / 1024 / 1024).toFixed(2)}GB`
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(2)}MB`
  if (value >= 1024) return `${(value / 1024).toFixed(2)}KB`
  return `${value}B`
}

function updateMax (max, sample) {
  for (const key of ['processRss', 'cgroupCurrent', 'cgroupPeak', 'cgroupStatFile', 'cgroupStatAnon', 'cgroupStatFileDirty', 'cgroupStatFileMapped']) {
    const value = sample[key]
    if (value != null && (max[key] == null || value > max[key])) {
      max[key] = value
    }
  }
}

async function sleep (ms) {
  await new Promise(resolve => setTimeout(resolve, ms))
}

async function run () {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printHelp()
    return 0
  }

  const pid = args.pid || findPidByMatch(args.match)
  if (!pid) {
    throw new Error(`No target process found. Pass --pid <pid> or adjust --match ${JSON.stringify(args.match)}.`)
  }

  const cgroupBase = resolveCgroupBase(pid)
  if (!cgroupBase || !fs.existsSync(cgroupBase)) {
    throw new Error(`Could not resolve cgroup path for pid ${pid}`)
  }

  fs.mkdirSync(path.dirname(args.output), { recursive: true })
  const stream = fs.createWriteStream(args.output, { flags: 'a' })
  const startedAt = Date.now()
  const max = {}

  console.log(`[xray-cgroup-sampler] sampling pid=${pid} cgroup=${cgroupBase} intervalMs=${args.intervalMs} durationMs=${args.durationMs}`)
  console.log(`[xray-cgroup-sampler] output=${args.output}`)

  while (Date.now() - startedAt <= args.durationMs) {
    if (!fs.existsSync(`/proc/${pid}`)) {
      console.log(`[xray-cgroup-sampler] pid ${pid} exited`)
      break
    }
    const sample = readSample(pid, cgroupBase)
    updateMax(max, sample)
    stream.write(`${JSON.stringify(sample)}\n`)
    console.log(`[xray-cgroup-sampler] current=${formatBytes(sample.cgroupCurrent)} peak=${formatBytes(sample.cgroupPeak)} file=${formatBytes(sample.cgroupStatFile)} anon=${formatBytes(sample.cgroupStatAnon)} rss=${formatBytes(sample.processRss)}`)
    await sleep(args.intervalMs)
  }

  await new Promise(resolve => stream.end(resolve))
  console.log('[xray-cgroup-sampler] max', JSON.stringify({
    processRss: formatBytes(max.processRss),
    cgroupCurrent: formatBytes(max.cgroupCurrent),
    cgroupPeak: formatBytes(max.cgroupPeak),
    cgroupStatFile: formatBytes(max.cgroupStatFile),
    cgroupStatAnon: formatBytes(max.cgroupStatAnon),
    cgroupStatFileDirty: formatBytes(max.cgroupStatFileDirty),
    cgroupStatFileMapped: formatBytes(max.cgroupStatFileMapped),
    output: args.output,
  }))
  return 0
}

run().then(code => {
  process.exitCode = code
}).catch(error => {
  console.error(`[xray-cgroup-sampler] failed: ${error && error.stack ? error.stack : error}`)
  process.exitCode = 1
})
