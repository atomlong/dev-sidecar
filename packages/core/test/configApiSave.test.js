// configApi 持久化防御回归测试：HOME 隔离到临时目录，不碰真实 ~/.dev-sidecar
// 覆盖：
// 1. Xray 插件自动注入的 intercepts（Auto-injected by Xray Plugin）不持久化、不进内存
// 2. preSetIpList: [] 不写入 config.json（doDiff 写入侧防御）
// 3. config.json 已有 [] 脏数据时，reload + save 自愈清除
// 注：测试走 update()（WebUI/GUI 的真实路径），它先 clone 全量内存配置再 save；
//     直接 save(部分配置) 会把缺失的顶层键记为删除标记并从内存清除，属 API 误用边界。
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

// 必须在 require config-api 之前设置 HOME——defaultConfig 在模块加载时求值 userBasePath
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-sidecar-test-home-'))
process.env.HOME = tmpHome
delete process.env.USERPROFILE

const configApi = require('../src/config-api')

function readSavedConfig () {
  const configPath = path.join(tmpHome, '.dev-sidecar', 'config.json')
  assert.ok(fs.existsSync(configPath), 'config.json 应已写入临时 HOME')
  return JSON.parse(fs.readFileSync(configPath, 'utf8'))
}

function getMemoryIntercepts () {
  const memory = configApi.get()
  return (memory.server && memory.server.intercepts) || {}
}

describe('configApi 持久化防御（save/update/reload）', () => {
  it('update() 后 Auto-injected intercepts 不写入 config.json，用户字段正常写入', () => {
    configApi.update({
      server: {
        host: '0.0.0.0',
        intercepts: {
          '(*.)?chatgpt.com': {
            '.*': { proxy: 'tunnel://127.0.0.1:10801', desc: 'Auto-injected by Xray Plugin' },
          },
          'my-custom-domain.com': {
            '.*': { sni: 'baidu.com', desc: 'user rule' },
          },
        },
      },
    })
    const saved = readSavedConfig()
    const intercepts = (saved.server && saved.server.intercepts) || {}
    assert.strictEqual(intercepts['(*.)?chatgpt.com'], undefined, 'Auto-injected 条目不应持久化')
    assert.ok(intercepts['my-custom-domain.com'], '用户自定义条目应保留')
    assert.strictEqual(saved.server.host, '0.0.0.0')
    // 内存侧：save() 的 set(diffConfig) 重载同样不带 Auto-injected
    assert.strictEqual(getMemoryIntercepts()['(*.)?chatgpt.com'], undefined)
  })

  it('update() 后 preSetIpList: [] 不写入 config.json（doDiff 写入侧防御）', () => {
    configApi.update({
      server: {
        host: '0.0.0.1',
        preSetIpList: [],
      },
    })
    const saved = readSavedConfig()
    const preSet = saved.server && saved.server.preSetIpList
    assert.ok(preSet === undefined || !Array.isArray(preSet), 'preSetIpList 空数组不应持久化，实际: ' + JSON.stringify(preSet))
    assert.strictEqual(saved.server.host, '0.0.0.1')
  })

  it('config.json 已有 preSetIpList: [] 脏数据时，reload + save 自愈清除', () => {
    const configPath = path.join(tmpHome, '.dev-sidecar', 'config.json')
    fs.writeFileSync(configPath, JSON.stringify({ server: { preSetIpList: [] } }))

    // reload → getConfigFromFiles（doMerge 拦截 []）→ 内存恢复完整默认配置
    configApi.reload()
    assert.ok(configApi.get().app !== undefined, 'reload 后内存应为完整配置')

    // 再 update()：doDiff 不再产生 [] 差异 → config.json 重写后脏数据消失
    configApi.update({ app: { theme: 'light' } })
    const saved = readSavedConfig()
    const preSet = saved.server && saved.server.preSetIpList
    assert.ok(!Array.isArray(preSet), '脏数据 [] 应在下次 save 时消失，实际: ' + JSON.stringify(preSet))
    assert.strictEqual(saved.app.theme, 'light')
  })

  it('update() 后内存中不含 Auto-injected intercepts（需 reInjectXrayRules 补注入）', () => {
    configApi.update({
      server: {
        intercepts: {
          '(*.)?openai.com': {
            '.*': { proxy: 'tunnel://127.0.0.1:10801', desc: 'Auto-injected by Xray Plugin' },
          },
        },
      },
    })
    assert.strictEqual(getMemoryIntercepts()['(*.)?openai.com'], undefined)
  })

  after(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true })
  })
})