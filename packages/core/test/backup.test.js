// WebUI 备份模块测试：S3 客户端（SigV4，对着本地假 S3 HTTP 服务验证）
// 与备份服务（打包/加密/保留/恢复，用注入的假对象存储）。
// 不联网、不加载 expose，可安全在 `npm test` 并行模式下运行。
const assert = require('node:assert')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const s3 = require('../src/modules/plugin/webui/s3')
const { createBackupApi, encrypt, decrypt, isEncrypted } = require('../src/modules/plugin/webui/backup')

function tmpDir () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ds-backup-test-'))
}

// 假 S3 对象存储：内存 Map 记录上传，支持前缀列表/删除
function fakeStore () {
  const objects = new Map()
  const deleted = []
  return {
    objects, deleted,
    async test () { return true },
    async putObject (key, body) {
      objects.set(key, Buffer.from(body))
      return { etag: '"fake"', size: body.length }
    },
    async getObject (key) {
      if (!objects.has(key)) throw new Error(`S3 GET ${key} 失败: HTTP 404`)
      return objects.get(key)
    },
    async listObjects (prefix, maxKeys) {
      return [...objects.keys()].filter(k => k.startsWith(prefix)).sort()
        .map(k => ({ key: k, size: objects.get(k).length, lastModified: '2026-09-02T00:00:00.000Z' }))
    },
    async deleteObject (key) {
      objects.delete(key)
      deleted.push(key)
    },
  }
}

function seedBaseDir (base) {
  fs.mkdirSync(path.join(base, 'logs'), { recursive: true })
  fs.mkdirSync(path.join(base, 'xray', 'sub'), { recursive: true })
  fs.writeFileSync(path.join(base, 'config.json'), JSON.stringify({ app: { name: 'original' } }))
  fs.writeFileSync(path.join(base, 'backup.json'), JSON.stringify({ should: 'not-be-backed-up' }))
  fs.writeFileSync(path.join(base, 'running.json'), '{"runtime":1}')
  fs.writeFileSync(path.join(base, 'logs', 'core.log'), 'log line')
  fs.writeFileSync(path.join(base, 'xray', 'sub', 'cache.db'), 'cache')
  fs.writeFileSync(path.join(base, 'dev-sidecar.ca.key.pem'), 'SECRET-CA-KEY')
}

function createApi (base, store, hostname = 'host1') {
  return createBackupApi({ config: { get: () => ({}) } }, { baseDir: base, store, hostname })
}

function saveFullConfig (api, over = {}) {
  api.saveConfig({
    s3: {
      endpoint: 'https://acct.r2.cloudflarestorage.com',
      region: 'auto',
      bucket: 'bk-bucket',
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'sk-plain-value',
      prefix: 'backups/',
      ...over.s3,
    },
    passphrase: over.passphrase,
    keepLast: over.keepLast !== undefined ? over.keepLast : 0,
    schedule: over.schedule,
  })
}

function tarList (buf) {
  const tmp = path.join(os.tmpdir(), `tarlist-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  fs.writeFileSync(tmp, buf)
  try {
    return execFileSync('tar', ['-tzf', tmp], { encoding: 'utf8' }).split('\n').map(s => s.trim()).filter(Boolean)
  } finally {
    fs.rmSync(tmp, { force: true })
  }
}

describe('s3 client', () => {
  describe('helpers', () => {
    it('uriEncode encodes reserved chars', () => {
      assert.strictEqual(s3.uriEncode('a b'), 'a%20b')
      assert.strictEqual(s3.uriEncode('a/b'), 'a%2Fb')
      assert.strictEqual(s3.uriEncode('a&b'), 'a%26b')
      assert.strictEqual(s3.uriEncode('a~b.c-d'), 'a~b.c-d')
    })
    it('amzDate formats to ISO basic', () => {
      assert.strictEqual(s3.amzDate(new Date('2026-09-02T05:48:21.990Z')), '20260902T054821Z')
    })
    it('parseListXml extracts keys with entities decoded', () => {
      const xml = `<ListBucketResult><Contents><Key>dev-sidecar/h1/a &amp; b.tar.gz</Key><Size>123</Size><LastModified>2026-09-02T00:00:00.000Z</LastModified></Contents><Contents><Key>dev-sidecar/h1/c.tar.gz</Key><Size>45</Size><LastModified>2026-09-02T01:00:00.000Z</LastModified></Contents></ListBucketResult>`
      const items = s3.parseListXml(xml)
      assert.strictEqual(items.length, 2)
      assert.strictEqual(items[0].key, 'dev-sidecar/h1/a & b.tar.gz')
      assert.strictEqual(items[0].size, 123)
      assert.strictEqual(items[1].key, 'dev-sidecar/h1/c.tar.gz')
    })
  })

  describe('against a local fake S3 server', () => {
    let server, baseUrl, seen
    before(async () => {
      seen = []
      server = http.createServer((req, res) => {
        seen.push({ method: req.method, url: req.url, headers: req.headers, body: [] })
        req.on('data', c => seen[seen.length - 1].body.push(c))
        req.on('end', () => {
          if (req.url.startsWith('/denied')) {
            res.writeHead(403, { 'Content-Type': 'application/xml' })
            res.end('<Error><Code>AccessDenied</Code><Message>denied</Message></Error>')
          } else if (req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/xml' })
            res.end('<ListBucketResult><Contents><Key>k1.tar.gz</Key><Size>9</Size><LastModified>2026-09-02T00:00:00.000Z</LastModified></Contents></ListBucketResult>')
          } else if (req.method === 'PUT') {
            res.writeHead(200, { etag: '"abc"' })
            res.end()
          } else {
            res.writeHead(204)
            res.end()
          }
        })
      })
      await new Promise(r => server.listen(0, '127.0.0.1', r))
      baseUrl = `http://127.0.0.1:${server.address().port}`
    })
    after(async () => { await new Promise(r => server.close(r)) })

    const cfg = () => ({
      endpoint: baseUrl, region: 'auto', bucket: 'test-bucket',
      accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    })

    it('listObjects sends signed path-style GET with query and parses response', async () => {
      const client = s3.createS3Client(cfg())
      const items = await client.listObjects('dev-sidecar/', 100)
      assert.strictEqual(items.length, 1)
      assert.strictEqual(items[0].key, 'k1.tar.gz')
      const req = seen[seen.length - 1]
      assert.strictEqual(req.method, 'GET')
      assert.strictEqual(req.url, '/test-bucket?list-type=2&max-keys=100&prefix=dev-sidecar%2F')
      assert.ok(req.headers.authorization.startsWith('AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/'))
      assert.ok(req.headers.authorization.includes('/auto/s3/aws4_request'))
      assert.ok(req.headers.authorization.includes('SignedHeaders=host;x-amz-content-sha256;x-amz-date'))
      assert.match(req.headers['x-amz-date'], /^\d{8}T\d{6}Z$/)
      assert.strictEqual(req.headers['x-amz-content-sha256'],
        require('node:crypto').createHash('sha256').update(Buffer.alloc(0)).digest('hex'))
    })
    it('putObject signs payload hash and encodes key segments', async () => {
      const client = s3.createS3Client(cfg())
      const buf = Buffer.from('hello backup')
      const r = await client.putObject('dev-sidecar/host1/a b.tar.gz', buf, 'application/gzip')
      assert.strictEqual(r.etag, '"abc"')
      const req = seen[seen.length - 1]
      assert.strictEqual(req.method, 'PUT')
      assert.strictEqual(req.url, '/test-bucket/dev-sidecar/host1/a%20b.tar.gz')
      assert.strictEqual(req.headers['content-type'], 'application/gzip')
      assert.strictEqual(req.headers['x-amz-content-sha256'],
        require('node:crypto').createHash('sha256').update(buf).digest('hex'))
    })
    it('throws with status and body excerpt on upstream error', async () => {
      const client = s3.createS3Client({ ...cfg(), bucket: 'denied' })
      await assert.rejects(() => client.listObjects(''), /HTTP 403[\s\S]*AccessDenied/)
    })
    it('rejects invalid endpoint scheme', async () => {
      await assert.rejects(() => s3.createS3Client({ ...cfg(), endpoint: 'ftp://x' }).listObjects(''), /http\(s\):\/\//)
    })
  })
})

describe('backup service', () => {
  it('encrypt/decrypt roundtrip; tampered tag rejected', () => {
    const plain = Buffer.from('archive-bytes')
    const enc = encrypt(plain, 'pass123')
    assert.ok(isEncrypted(enc))
    assert.deepStrictEqual(decrypt(enc, 'pass123'), plain)
    const tampered = Buffer.from(enc)
    tampered[tampered.length - 1] ^= 0xff
    assert.throws(() => decrypt(tampered, 'pass123'))
    assert.throws(() => decrypt(enc, 'wrong-pass'))
  })

  describe('config store', () => {
    it('returns masked defaults when nothing saved', () => {
      const api = createApi(tmpDir(), fakeStore())
      const c = api.getMaskedConfig()
      assert.strictEqual(c.configured, false)
      assert.strictEqual(c.s3.region, 'auto')
      assert.strictEqual(c.s3.prefix, 'backups/')
      assert.strictEqual(c.keepLast, 7)
    })
    it('save masks secrets; masked resend keeps old, empty passphrase clears', () => {
      const api = createApi(tmpDir(), fakeStore())
      saveFullConfig(api, { passphrase: 'enc-pass' })
      let c = api.getMaskedConfig()
      assert.strictEqual(c.configured, true)
      assert.strictEqual(c.s3.secretAccessKey, '******')
      assert.strictEqual(c.passphrase, '******')
      // 掩码回传不覆盖真实 secret
      api.saveConfig({ s3: { secretAccessKey: '******' } })
      c = api.getMaskedConfig()
      assert.strictEqual(c.s3.secretAccessKey, '******')
      // 新值覆盖
      api.saveConfig({ s3: { secretAccessKey: 'sk-new' } })
      c = api.getMaskedConfig()
      assert.strictEqual(c.s3.secretAccessKey, '******')
      // 空字符串显式清除口令
      api.saveConfig({ passphrase: '' })
      c = api.getMaskedConfig()
      assert.strictEqual(c.passphrase, '')
    })
    it('normalizes prefix to trailing slash', () => {
      const api = createApi(tmpDir(), fakeStore())
      api.saveConfig({ s3: { prefix: 'mybk' } })
      assert.strictEqual(api.getMaskedConfig().s3.prefix, 'mybk/')
    })
  })

  describe('run backup', () => {
    it('uploads tar.gz under prefix/host, excludes runtime files, persists state', async () => {
      const base = tmpDir()
      seedBaseDir(base)
      const store = fakeStore()
      const api = createApi(base, store)
      saveFullConfig(api)
      const r = await api.runBackup()
      assert.match(r.key, /^backups\/host1\/\d{8}-\d{6}\.tar\.gz$/)
      assert.strictEqual(r.encrypted, false)
      const payload = store.objects.get(r.key)
      // gzip 魔数
      assert.strictEqual(payload[0], 0x1f)
      assert.strictEqual(payload[1], 0x8b)
      const names = tarList(payload)
      assert.ok(names.includes('./config.json'))
      assert.ok(names.includes('./dev-sidecar.ca.key.pem'))
      assert.ok(!names.some(n => n.startsWith('./logs')))
      assert.ok(!names.some(n => n.startsWith('./xray')))
      assert.ok(!names.some(n => n.startsWith('./running.json')))
      assert.ok(!names.some(n => n.startsWith('./backup.json')))
      // 状态落盘
      const onDisk = JSON.parse(fs.readFileSync(path.join(base, 'backup.json'), 'utf8'))
      assert.strictEqual(onDisk.lastBackupKey, r.key)
      assert.strictEqual(onDisk.lastBackupSize, payload.length)
      assert.strictEqual(onDisk.lastError, '')
    })
    it('uploads encrypted archive with .enc suffix when passphrase set', async () => {
      const base = tmpDir()
      seedBaseDir(base)
      const store = fakeStore()
      const api = createApi(base, store)
      saveFullConfig(api, { passphrase: 'sec-pass' })
      const r = await api.runBackup()
      assert.ok(/\.enc$/.test(r.key))
      assert.strictEqual(r.encrypted, true)
      const payload = store.objects.get(r.key)
      assert.ok(isEncrypted(payload))
      const plain = decrypt(payload, 'sec-pass')
      assert.strictEqual(plain[0], 0x1f)
      assert.strictEqual(plain[1], 0x8b)
    })
    it('keeps only keepLast newest objects per host', async () => {
      const base = tmpDir()
      seedBaseDir(base)
      const store = fakeStore()
      const api = createApi(base, store)
      saveFullConfig(api, { keepLast: 2 })
      // 预置 3 份旧备份
      for (const k of ['backups/host1/20260101-000000.tar.gz', 'backups/host1/20260102-000000.tar.gz', 'backups/host1/20260103-000000.tar.gz']) {
        store.objects.set(k, Buffer.from('old'))
      }
      // 其他主机前缀不受影响
      store.objects.set('backups/other-host/20260101-000000.tar.gz', Buffer.from('other'))
      const r = await api.runBackup()
      const myKeys = [...store.objects.keys()].filter(k => k.startsWith('backups/host1/')).sort()
      assert.strictEqual(myKeys.length, 2)
      assert.deepStrictEqual(store.deleted, ['backups/host1/20260101-000000.tar.gz', 'backups/host1/20260102-000000.tar.gz'])
      assert.ok(store.objects.has('backups/other-host/20260101-000000.tar.gz'))
      assert.ok(store.objects.has(r.key))
    })
    it('records lastError on failure', async () => {
      const base = tmpDir()
      seedBaseDir(base)
      const store = fakeStore()
      store.putObject = async () => { throw new Error('S3 PutObject 失败: HTTP 403') }
      const api = createApi(base, store)
      saveFullConfig(api)
      await assert.rejects(() => api.runBackup(), /HTTP 403/)
      const onDisk = JSON.parse(fs.readFileSync(path.join(base, 'backup.json'), 'utf8'))
      assert.match(onDisk.lastError, /HTTP 403/)
    })
  })

  describe('restore', () => {
    it('restores overwritten config.json and keeps a safety copy', async () => {
      const base = tmpDir()
      seedBaseDir(base)
      const store = fakeStore()
      const api = createApi(base, store)
      saveFullConfig(api)
      const r = await api.runBackup()

      fs.writeFileSync(path.join(base, 'config.json'), JSON.stringify({ app: { name: 'changed-after-backup' } }))
      const result = await api.restoreBackup(r.key)
      assert.strictEqual(result.needsRestart, true)
      assert.ok(result.restoredCount > 0)
      // 恢复为备份时的内容
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(base, 'config.json'), 'utf8')), { app: { name: 'original' } })
      // 安全副本保留了被覆盖的版本
      const baks = fs.readdirSync(base).filter(n => n.startsWith('config.json.bak-restore-'))
      assert.strictEqual(baks.length, 1)
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(base, baks[0]), 'utf8')), { app: { name: 'changed-after-backup' } })
    })
    it('fails without passphrase when archive is encrypted', async () => {
      const base = tmpDir()
      seedBaseDir(base)
      const store = fakeStore()
      const api = createApi(base, store)
      saveFullConfig(api, { passphrase: 'sec-pass' })
      const r = await api.runBackup()
      // 新实例（口令丢失）
      const api2 = createBackupApi({ config: { get: () => ({}) } }, { baseDir: base, store, hostname: 'host1' })
      api2.saveConfig({ passphrase: '' }) // 显式清除口令
      const c2 = api2.getMaskedConfig()
      assert.strictEqual(c2.passphrase, '')
      await assert.rejects(() => api2.restoreBackup(r.key), /口令/)
    })
    it('fails with wrong passphrase', async () => {
      const base = tmpDir()
      seedBaseDir(base)
      const store = fakeStore()
      const api = createApi(base, store)
      saveFullConfig(api, { passphrase: 'right' })
      const r = await api.runBackup()
      api.saveConfig({ passphrase: 'wrong' })
      await assert.rejects(() => api.restoreBackup(r.key), /解密失败/)
    })
    it('rejects keys outside the configured prefix or containing ..', async () => {
      const base = tmpDir()
      seedBaseDir(base)
      const store = fakeStore()
      const api = createApi(base, store)
      saveFullConfig(api)
      await assert.rejects(() => api.restoreBackup('other-prefix/host1/x.tar.gz'), /非法/)
      await assert.rejects(() => api.restoreBackup('backups/../../etc/passwd'), /非法/)
    })
  })

  describe('testConnection', () => {
    it('falls back to saved secret when body sends the mask', async () => {
      const base = tmpDir()
      const store = fakeStore()
      const api = createApi(base, store)
      saveFullConfig(api)
      // body 只带掩码 secret —— 应使用已保存的真实 secret
      await api.testConnection({ s3: { bucket: 'other-bucket', secretAccessKey: '******' } })
    })
  })

  describe('schedule', () => {
    it('tick runs backup when due and skips when not due', async () => {
      const base = tmpDir()
      seedBaseDir(base)
      const store = fakeStore()
      const api = createApi(base, store)
      saveFullConfig(api, { keepLast: 0, schedule: { enabled: true, intervalHours: 24 } })
      // 未到间隔（从未备份过 → due）→ 执行
      await api._scheduleTick()
      assert.strictEqual([...store.objects.keys()].length, 1)
      // 刚备份完 → 不 due → 不新增
      await api._scheduleTick()
      assert.strictEqual([...store.objects.keys()].length, 1)
      // 关闭调度后即使 due 也不执行：把 lastBackupAt 置 0 再 tick
      const onDisk = JSON.parse(fs.readFileSync(path.join(base, 'backup.json'), 'utf8'))
      onDisk.lastBackupAt = 0
      fs.writeFileSync(path.join(base, 'backup.json'), JSON.stringify(onDisk))
      api.saveConfig({ schedule: { enabled: false } })
      await api._scheduleTick()
      assert.strictEqual([...store.objects.keys()].length, 1)
    })
  })
})
