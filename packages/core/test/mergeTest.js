const assert = require('node:assert')
const lodash = require('lodash')
const mergeApi = require('../src/merge.js')

// 默认配置
const defConfig = {
  a: {
    aa: { value: 1 },
    bb: { value: 2 },
  },
  b: { c: 2 },
  c: 1,
  d: [1, 2, 3],
  e: {
    aa: 2,
    ee: 5,
  },
  f: {
    x: 1,
  },
  g: [1, 2],
  h: null,
  i: null,
}

// 自定义配置
const customConfig = {
  a: {
    bb: { value: 2 },
    cc: { value: 3 },
  },
  b: { c: 2 },
  c: null,
  d: [1, 2, 3, 4],
  e: {
    aa: 2,
    ee: 5,
    ff: 6,
  },
  f: {},
  g: [1, 2],
  h: null,
}

// doDiff
const doDiffResult = mergeApi.doDiff(defConfig, customConfig)
console.log('doDiffResult:', JSON.stringify(doDiffResult, null, 2))
console.log('\r')
// 校验doDiff结果
const doDiffExpect = {
  a: {
    aa: null,
    cc: { value: 3 },
  },
  c: null,
  d: [1, 2, 3, 4],
  e: {
    ff: 6,
  },
  f: {
    x: null,
  },
}
console.log('check diff result:', lodash.isEqual(doDiffResult, doDiffExpect))
console.log('\r')

// doMerge
const doMergeResult = mergeApi.doMerge(defConfig, doDiffResult)
// delete null item
mergeApi.deleteNullItems(doMergeResult)
console.log('running:', JSON.stringify(doMergeResult, null, 2))
// 校验doMerge结果
const doMergeExpect = {
  a: {
    bb: { value: 2 },
    cc: { value: 3 },
  },
  b: { c: 2 },
  d: [1, 2, 3, 4],
  e: {
    aa: 2,
    ee: 5,
    ff: 6,
  },
  f: {},
  g: [1, 2],
}

const result = lodash.isEqual(doMergeResult, doMergeExpect)
console.log('check merge result:', result)
console.log('\r')
assert.strictEqual(result, true)

// doMerge: config.json 中的空数组不应清空已合并出的对象字段
// （bug: preSetIpList: [] 持久化后，每次启动都清空远程配置的全部预设 IP）
{
  const merged = { server: { preSetIpList: { 'google.com': '8.137.102.117' } } }
  const userConfig = { server: { preSetIpList: [] } }
  mergeApi.doMerge(merged, userConfig)
  assert.strictEqual(lodash.isPlainObject(merged.server.preSetIpList), true, '空数组不应把对象字段清空成数组')
  assert.deepStrictEqual(merged.server.preSetIpList, { 'google.com': '8.137.102.117' })

  // 数组字段对数组的整体替换语义不受影响（如 plugin.xray.rules）
  const merged2 = { plugin: { xray: { rules: [{ domain: 'a.com' }] } } }
  const userConfig2 = { plugin: { xray: { rules: [] } } }
  mergeApi.doMerge(merged2, userConfig2)
  assert.deepStrictEqual(merged2.plugin.xray.rules, [], '数组字段仍应被空数组整体替换')
}

// doDiff: 空数组对对象字段是类型错误，不应写入 diff（否则持久化 [] 污染 config.json）
{
  const diff = mergeApi.doDiff(
    { server: { preSetIpList: { 'google.com': '8.137.102.117' } } },
    { server: { preSetIpList: [] } },
  )
  assert.strictEqual(
    diff.server && diff.server.preSetIpList,
    undefined,
    '空数组 vs 对象不应产生 diff（写入侧防御）',
  )

  // 数组字段的正常 diff 语义不受影响：[] 清空数组字段、变更数组整体替换
  const diff2 = mergeApi.doDiff({ g: [1, 2] }, { g: [] })
  assert.deepStrictEqual(diff2.g, [], '数组字段应仍被空数组整体替换')
  const diff3 = mergeApi.doDiff({ d: [1, 2, 3] }, { d: [1, 2, 3, 4] })
  assert.deepStrictEqual(diff3.d, [1, 2, 3, 4])

  // 对象字段用 {} 收窄是合法操作，不受防御影响（逐键 null 才是删除语义）
  const diff4 = mergeApi.doDiff({ f: { x: 1 } }, { f: { x: null } })
  assert.strictEqual(diff4.f.x, null)
}

// doDiff: 默认配置中不存在的新字段，空数组是合法的用户自定义空表
// （写入 [] 合法——oldValue 为空时走"新增字段直接取新值"分支，不触发防御）
{
  const diff = mergeApi.doDiff({}, { customList: [] })
  assert.deepStrictEqual(diff.customList, [], '新增字段（旧值为空）的空数组应原样写入 diff')
  // 但注意启动合并侧：合并目标也没有该键时，[] 生效为空表（无对象可清空，无危害）
  const merged = {}
  mergeApi.doMerge(merged, { customList: [] })
  assert.deepStrictEqual(merged.customList, [])
}
