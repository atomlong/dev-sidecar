// 回归测试：热重载时空 preSetIpList 不得覆盖运行中正常的预设 IP 表
// 背景：updateConfig() 原用 `if (newProxyOptions.dnsConfig.preSetIpList)` truthy 判断，
// 而 domainMapRegexply([]) 返回 {origin:{}}（truthy），导致 config.json 中被污染的
// "preSetIpList": [] 热重载后清空内存中的预设 IP，DNS 回退到 cf-DoT 解析出被墙 IP，
// 造成依赖预设 IP 的域名间歇性 ECONNRESET。
// 修复：shouldReplacePreSetIpList 要求 origin 内容非空才替换。
const assert = require('node:assert')
const path = require('node:path')

const ProxyOptions = require('../src/options')
const matchUtil = require('../src/utils/util.match')

const REPO = path.resolve(__dirname, '..')

// 构造 ProxyOptions 可接受的最小 serverConfig
function minimalServerConfig (preSetIpList) {
  return {
    host: '127.0.0.1',
    port: 45000,
    intercepts: {},
    whiteList: {},
    preSetIpList,
    setting: {
      rootDir: REPO,
      script: { enabled: false, defaultDir: './extra/scripts/' },
      timeoutMapping: {},
      verifySsl: true,
    },
    dns: { mapping: {}, providers: {}, speedTest: {} },
    plugin: { overwall: {} },
  }
}

describe('shouldReplacePreSetIpList (updateConfig 空表防御)', () => {
  it('null 返回 false', () => {
    assert.strictEqual(ProxyOptions.shouldReplacePreSetIpList(null), false)
  })

  it('空 origin {}（domainMapRegexply 对 [] 的规范化产物）返回 false', () => {
    // 修复前的 bug：{origin:{}} 是 truthy，truthy 判断会覆盖运行中的好表
    assert.strictEqual(ProxyOptions.shouldReplacePreSetIpList({ origin: {} }), false)
  })

  it('origin 无 keys 返回 false', () => {
    assert.strictEqual(ProxyOptions.shouldReplacePreSetIpList({ origin: {}, regexpMap: {} }), false)
  })

  it('origin 有内容返回 true', () => {
    assert.strictEqual(
      ProxyOptions.shouldReplacePreSetIpList({ origin: { 'google.com': '8.137.102.117' } }),
      true,
    )
  })

  it('undefined origin 返回 false', () => {
    assert.strictEqual(ProxyOptions.shouldReplacePreSetIpList({}), false)
  })
})

describe('preSetIpList 规范化与热重载链路', () => {
  it('domainMapRegexply([]) 规范化为 {origin:{}}（空 origin，truthy——修复的前提）', () => {
    const normalized = matchUtil.domainMapRegexply([])
    assert.deepStrictEqual(normalized.origin, {})
    assert.strictEqual(Boolean(normalized), true)
  })

  it('ProxyOptions 对 preSetIpList: [] 产出空 origin 表，热重载应拒绝应用', () => {
    const options = ProxyOptions(minimalServerConfig([]))
    assert.deepStrictEqual(options.dnsConfig.preSetIpList.origin, {})
    assert.strictEqual(ProxyOptions.shouldReplacePreSetIpList(options.dnsConfig.preSetIpList), false)
  })

  it('ProxyOptions 对 preSetIpList: {} 产出空 origin 表，热重载应拒绝应用', () => {
    const options = ProxyOptions(minimalServerConfig({}))
    assert.strictEqual(ProxyOptions.shouldReplacePreSetIpList(options.dnsConfig.preSetIpList), false)
  })

  it('ProxyOptions 对正常 preSetIpList 产出有内容表，热重载应应用', () => {
    const options = ProxyOptions(minimalServerConfig({ 'google.com': '8.137.102.117' }))
    assert.deepStrictEqual(options.dnsConfig.preSetIpList.origin, { 'google.com': '8.137.102.117' })
    assert.strictEqual(ProxyOptions.shouldReplacePreSetIpList(options.dnsConfig.preSetIpList), true)
  })
})