// configApi 持久化防御回归测试：HOME 隔离到临时目录，不碰真实 ~/.dev-sidecar
// 覆盖：
// 1. Xray 插件自动注入的 intercepts（Auto-injected by Xray Plugin）不持久化、不进内存
// 2. preSetIpList: [] 不写入 config.json（doDiff 写入侧防御）
// 3. config.json 已有 [] 脏数据时，reload + save 自愈清除
// 注：测试走 update()（WebUI/GUI 的真实路径），它先 clone 全量内存配置再 save；
//     直接 save(部分配置) 会把缺失的顶层键记为删除标记并从内存清除，属 API 误用边界。
//
// **进程级 HOME 污染说明**：mocha 加载阶段执行所有文件顶层代码——本文件
// 加载时改 process.env.HOME，会让同进程随后加载的上游裸脚本测试（versionTest
// 等顶层发真实网络请求并断言）捕获坏数据后 throw 崩掉整个 run。现已依赖
// .mocharc.json 的 --parallel（每文件独立 worker 进程）隔离此污染；after 钩子
// 仍恢复 HOME + reload 单例，保证同 worker 内后续文件不受影响。
// 独立运行：npx mocha test/configApiSave.test.js --exit
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

// 必须在 require config-api 之前设置 HOME——defaultConfig 在模块加载时求值 userBasePath。
// HOME 是进程级全局：mocha 单进程顺序跑所有测试文件，本文件字母序排最前，
// 污染会让后续依赖真实 HOME 的测试（configTest/versionTest 等发真实网络请求）
// 读到已删除的 tmpHome 而失败。必须在 after 中恢复 HOME 并 reload 单例配置。
const originalHome = process.env.HOME
const originalUserprofile = process.env.USERPROFILE
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
    // 恢复进程级环境，让同进程后续测试文件回到真实 HOME 状态。
    // reload 让 config-api 单例的内存配置也回到真实 HOME（否则 configTarget
    // 仍指向 tmpHome 的残留状态）。不删 tmpHome：log appenders 仍指向其
    // logs 目录，删除会导致后续测试写日志 ENOENT；tmp 目录由系统清理。
    process.env.HOME = originalHome
    if (originalUserprofile === undefined) {
      delete process.env.USERPROFILE
    } else {
      process.env.USERPROFILE = originalUserprofile
    }
    try {
      configApi.reload()
    } catch { /* 真实 HOME 无配置文件时 reload 走默认，允许 */ }
  })
})