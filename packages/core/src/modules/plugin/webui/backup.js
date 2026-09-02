// WebUI 备份服务：把 ~/.dev-sidecar 配置目录打包上传到 S3 兼容对象存储
// （Cloudflare R2 / AWS S3 / MinIO / 阿里云 OSS），支持加密、保留份数、
// 定时备份与恢复。备份设置存放在独立的 <userBasePath>/backup.json，
// 不进入主配置树——避免 secretAccessKey/加密口令随 GET /api/config 泄露
// 与被整树回写流程篡改。
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFile } = require('node:child_process')

const { createS3Client } = require('./s3')

const DEFAULT_CONFIG = {
  s3: {
    endpoint: '', // 如 https://<account_id>.r2.cloudflarestorage.com
    region: 'auto',
    bucket: '',
    accessKeyId: '',
    secretAccessKey: '',
    prefix: 'backups/', // 对象 key 前缀，多机共享同一 bucket 时按 <prefix><hostname>/ 区分
  },
  passphrase: '', // 非空则备份用 AES-256-GCM 加密（建议设置：备份含 CA 私钥）
  keepLast: 7, // 保留最近份数，0 = 不清理
  schedule: { enabled: false, intervalHours: 24 },
  lastBackupAt: 0,
  lastBackupKey: '',
  lastBackupSize: 0,
  lastError: '',
}

const SECRET_MASK = '******'
const ENC_MAGIC = Buffer.from('DSBK') // 加密备份头魔数
const ENC_VERSION = 1

// AES-256-GCM 加密归档：DSBK 魔数 + 版本 + salt(16) + iv(12) + tag(16) + 密文
function encrypt (plain, passphrase) {
  const salt = crypto.randomBytes(16)
  const iv = crypto.randomBytes(12)
  const key = crypto.scryptSync(passphrase, salt, 32, { N: 16384, r: 8, p: 1 })
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([cipher.update(plain), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([ENC_MAGIC, Buffer.from([ENC_VERSION]), salt, iv, tag, body])
}

function decrypt (input, passphrase) {
  if (input.length < 4 + 1 + 16 + 12 + 16) throw new Error('加密备份文件头不完整')
  const version = input[4]
  if (version !== ENC_VERSION) throw new Error(`不支持的加密备份版本: ${version}`)
  const salt = input.subarray(5, 21)
  const iv = input.subarray(21, 33)
  const tag = input.subarray(33, 49)
  const body = input.subarray(49)
  const key = crypto.scryptSync(passphrase, salt, 32, { N: 16384, r: 8, p: 1 })
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(body), decipher.final()])
}

const isEncrypted = (buf) => buf.subarray(0, 4).equals(ENC_MAGIC)
const isGzip = (buf) => buf[0] === 0x1f && buf[1] === 0x8b

// tar 打包排除项：运行态与本地敏感文件不进备份
// （backup.json 含对象存储凭据与加密口令，禁止上传到云端）
const TAR_EXCLUDES = ['logs', 'xray', 'running.json', 'service.pid', '*.pid', '*.log', '*.bak-*', 'backup.json']

function createBackupApi (context, overrides = {}) {
  const log = require('../../../utils/util.log.core')

  function userBasePath () {
    if (overrides.baseDir) return overrides.baseDir
    const cfg = context.config.get()
    return cfg.server?.setting?.userBasePath || path.join(os.homedir(), '.dev-sidecar')
  }

  function configPath () { return path.join(userBasePath(), 'backup.json') }

  function loadConfig () {
    try {
      const raw = JSON.parse(fs.readFileSync(configPath(), 'utf8'))
      return { ...DEFAULT_CONFIG, ...raw, s3: { ...DEFAULT_CONFIG.s3, ...(raw.s3 || {}) }, schedule: { ...DEFAULT_CONFIG.schedule, ...(raw.schedule || {}) } }
    } catch {
      return JSON.parse(JSON.stringify(DEFAULT_CONFIG))
    }
  }

  function saveConfigFile (cfg) {
    fs.mkdirSync(userBasePath(), { recursive: true })
    fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2))
  }

  // 供 GET /api/backup/config：脱敏读
  function getMaskedConfig () {
    const cfg = loadConfig()
    return {
      s3: { ...cfg.s3, secretAccessKey: cfg.s3.secretAccessKey ? SECRET_MASK : '' },
      passphrase: cfg.passphrase ? SECRET_MASK : '',
      keepLast: cfg.keepLast,
      schedule: cfg.schedule,
      lastBackupAt: cfg.lastBackupAt,
      lastBackupKey: cfg.lastBackupKey,
      lastBackupSize: cfg.lastBackupSize,
      lastError: cfg.lastError,
      configured: !!(cfg.s3.bucket && cfg.s3.accessKeyId && cfg.s3.secretAccessKey),
    }
  }

  // 供 POST /api/backup/config：掩码值（SECRET_MASK/未提供）保留旧值，
  // 其余字段整体替换
  function saveConfig (body) {
    const cur = loadConfig()
    const s3In = body && typeof body.s3 === 'object' ? body.s3 : null
    if (s3In) {
      for (const k of ['endpoint', 'region', 'bucket', 'accessKeyId', 'prefix']) {
        if (typeof s3In[k] === 'string') cur.s3[k] = s3In[k]
      }
      if (typeof s3In.secretAccessKey === 'string' && s3In.secretAccessKey !== SECRET_MASK && s3In.secretAccessKey !== '') {
        cur.s3.secretAccessKey = s3In.secretAccessKey
      }
    }
    if (body.passphrase !== undefined && body.passphrase !== SECRET_MASK) {
      cur.passphrase = String(body.passphrase || '')
    }
    if (Number.isFinite(body.keepLast)) cur.keepLast = Math.max(0, parseInt(body.keepLast, 10))
    if (body.schedule && typeof body.schedule === 'object') {
      if (typeof body.schedule.enabled === 'boolean') cur.schedule.enabled = body.schedule.enabled
      if (Number.isFinite(body.schedule.intervalHours)) cur.schedule.intervalHours = Math.max(1, parseInt(body.schedule.intervalHours, 10))
    }
    if (typeof cur.s3.prefix !== 'string' || !cur.s3.prefix) cur.s3.prefix = 'backups/'
    if (!cur.s3.prefix.endsWith('/')) cur.s3.prefix += '/'
    saveConfigFile(cur)
    return getMaskedConfig()
  }

  function getStore (cfg) {
    if (overrides.store) return overrides.store
    if (!cfg.s3.endpoint || !cfg.s3.bucket || !cfg.s3.accessKeyId || !cfg.s3.secretAccessKey) {
      throw new Error('备份尚未配置完整：需要 endpoint / bucket / AccessKeyId / SecretAccessKey')
    }
    return createS3Client(cfg.s3)
  }

  function hostPrefix (cfg) {
    const hostname = overrides.hostname || os.hostname()
    return `${cfg.s3.prefix}${hostname}/`
  }

  function tsName () {
    const d = new Date()
    const p = n => String(n).padStart(2, '0')
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  }

  function execTar (args) {
    return new Promise((resolve, reject) => {
      execFile('tar', args, { timeout: 120000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) reject(new Error(`tar ${args[0]} 失败: ${stderr || err.message}`))
        else resolve(stdout)
      })
    })
  }

  function buildTarArgs (outFile, dir) {
    // GNU tar 归档成员名带 ./ 前缀，bsdtar（macOS/Windows）不带 —— 两种模式都排除
    const args = ['-czf', outFile]
    for (const ex of TAR_EXCLUDES) {
      args.push(`--exclude=./${ex}`, `--exclude=${ex}`)
    }
    args.push('-C', dir, '.')
    return args
  }

  // 立即执行一次备份：打包 → 加密（可选）→ 上传 → 按保留份数清理
  async function runBackup () {
    const cfg = loadConfig()
    const store = getStore(cfg)
    const tmp = path.join(os.tmpdir(), `dev-sidecar-backup-${process.pid}-${Date.now()}`)
    try {
      await execTar(buildTarArgs(tmp, userBasePath()))
      let payload = fs.readFileSync(tmp)
      let key = `${hostPrefix(cfg)}${tsName()}.tar.gz`
      if (cfg.passphrase) {
        payload = encrypt(payload, cfg.passphrase)
        key += '.enc'
      }
      await store.putObject(key, payload, 'application/gzip')
      const deleted = []
      if (cfg.keepLast > 0) {
        const items = await store.listObjects(hostPrefix(cfg), 1000)
        const mine = items.map(i => i.key).filter(k => k.startsWith(hostPrefix(cfg)))
          .sort() // 时间戳命名，字典序即时间序
        const excess = mine.slice(0, Math.max(0, mine.length - cfg.keepLast))
        for (const k of excess) {
          await store.deleteObject(k)
          deleted.push(k)
        }
      }
      cfg.lastBackupAt = Date.now()
      cfg.lastBackupKey = key
      cfg.lastBackupSize = payload.length
      cfg.lastError = ''
      saveConfigFile(cfg)
      log.info(`WebUI 备份完成: ${key} (${payload.length}B${deleted.length ? `, 清理 ${deleted.length} 份旧备份` : ''})`)
      return { key, size: payload.length, encrypted: !!cfg.passphrase, deleted }
    } catch (err) {
      cfg.lastError = err.message
      cfg.lastBackupAt = cfg.lastBackupAt || 0
      saveConfigFile(cfg)
      log.error('WebUI 备份失败:', err)
      throw err
    } finally {
      try { fs.rmSync(tmp, { force: true }) } catch { /* ignore */ }
    }
  }

  // 列出云端备份（仅本机前缀下的对象）
  async function listBackups () {
    const cfg = loadConfig()
    const store = getStore(cfg)
    const prefix = hostPrefix(cfg)
    const items = await store.listObjects(prefix, 1000)
    return {
      prefix,
      backups: items.map(i => ({ ...i, encrypted: /\.enc$/.test(i.key) })),
    }
  }

  function assertOwnKey (cfg, key) {
    const prefix = cfg.s3.prefix
    if (typeof key !== 'string' || !key.startsWith(prefix) || key.includes('..')) {
      throw new Error(`非法的备份对象 key: ${key}`)
    }
  }

  // 恢复：下载 → 解密（若加密）→ 校验 gzip → 备份当前 config.json → 解包覆盖
  async function restoreBackup (key) {
    const cfg = loadConfig()
    assertOwnKey(cfg, key)
    const store = getStore(cfg)
    let payload = await store.getObject(key)
    if (isEncrypted(payload)) {
      if (!cfg.passphrase) throw new Error('该备份已加密，请先在备份设置中填写加密口令')
      try {
        payload = decrypt(payload, cfg.passphrase)
      } catch {
        throw new Error('解密失败：加密口令不正确')
      }
    }
    if (!isGzip(payload)) throw new Error('备份内容不是有效的 gzip 归档（可能未加密但已损坏）')

    const tmp = path.join(os.tmpdir(), `dev-sidecar-restore-${process.pid}-${Date.now()}`)
    fs.writeFileSync(tmp, payload)
    try {
      // 先列出归档内容：校验完整性 + 作为恢复清单返回
      const listing = await execTar(['-tzf', tmp])
      const files = listing.split('\n').map(s => s.trim()).filter(Boolean)

      const base = userBasePath()
      const configJson = path.join(base, 'config.json')
      if (fs.existsSync(configJson)) {
        const ts = tsName()
        fs.copyFileSync(configJson, path.join(base, `config.json.bak-restore-${ts}`))
      }
      await execTar(['-xzf', tmp, '-C', base])
      log.info(`WebUI 恢复备份完成: ${key}，共 ${files.length} 个条目`)
      return { key, restoredCount: files.length, files: files.slice(0, 50), needsRestart: true }
    } finally {
      try { fs.rmSync(tmp, { force: true }) } catch { /* ignore */ }
    }
  }

  // 下载备份文件（前端"下载"按钮：后端代理流式返回，不做预签名 URL）
  async function downloadBackup (key) {
    const cfg = loadConfig()
    assertOwnKey(cfg, key)
    const store = getStore(cfg)
    return { body: await store.getObject(key), name: path.posix.basename(key) }
  }

  async function deleteBackup (key) {
    const cfg = loadConfig()
    assertOwnKey(cfg, key)
    const store = getStore(cfg)
    await store.deleteObject(key)
    if (cfg.lastBackupKey === key) {
      cfg.lastBackupKey = ''
      cfg.lastBackupSize = 0
      saveConfigFile(cfg)
    }
    return true
  }

  async function testConnection (body) {
    // body 提供未保存的设置时优先用 body（"先测试再保存"）；
    // secretAccessKey 为掩码/空时回退到已保存值
    const saved = loadConfig()
    let cfgToTest = saved
    if (body && typeof body.s3 === 'object') {
      const merged = { s3: { ...saved.s3, ...body.s3 } }
      if (!merged.s3.secretAccessKey || merged.s3.secretAccessKey === SECRET_MASK) {
        merged.s3.secretAccessKey = saved.s3.secretAccessKey
      }
      cfgToTest = merged
    }
    const store = getStore(cfgToTest)
    await store.test()
    return true
  }

  // ---- 定时备份 ----
  let scheduleTimer = null

  async function scheduleTick () {
    try {
      const cfg = loadConfig()
      if (!cfg.schedule.enabled) return
      const intervalMs = (cfg.schedule.intervalHours || 24) * 3600 * 1000
      if (Date.now() - (cfg.lastBackupAt || 0) < intervalMs) return
      await runBackup()
    } catch (err) {
      log.error('WebUI 定时备份失败:', err)
    }
  }

  function startSchedule () {
    if (scheduleTimer) return
    // 每 10 分钟检查一次是否到达备份间隔；启动 5 分钟后先补一次检查
    scheduleTimer = setInterval(scheduleTick, 10 * 60 * 1000)
    setTimeout(scheduleTick, 5 * 60 * 1000)
  }

  function stopSchedule () {
    if (scheduleTimer) { clearInterval(scheduleTimer); scheduleTimer = null }
  }

  return {
    getMaskedConfig, saveConfig, testConnection,
    runBackup, listBackups, restoreBackup, downloadBackup, deleteBackup,
    startSchedule, stopSchedule,
    _scheduleTick: scheduleTick, // 测试用：直接触发一次调度检查
  }
}

module.exports = { createBackupApi, DEFAULT_CONFIG, SECRET_MASK, encrypt, decrypt, isEncrypted, TAR_EXCLUDES }
