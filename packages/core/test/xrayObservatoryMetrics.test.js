// observatory 状态解析单元测试
// 背景：sticky 锁定自动释放依赖"observatory alive 节点数"判断——为 0 时延长锁定，
// 避免 balancer leastPing 在无数据时选不出节点（v2.2.6 移除 fallbackTag 后流量直接失败）。
// 该判断通过 getObservatoryStatusMap 兼容 4 种 metrics 键名，解析失败会被当作
// "无数据"而延长锁定，因此键名解析回归是静默故障，必须单测保护。
const assert = require('node:assert')
const { getObservatoryStatusMap } = require('../src/modules/plugin/xray/probe')

// 模拟 armStickyAutoUnlock / fetchLiveObservatoryAliveCount 的 alive 计数逻辑
// （与 index.js 中的实现保持一致：Object.values(obs).filter(s => s && s.alive).length）
function countAlive (metrics) {
  const obs = getObservatoryStatusMap(metrics)
  if (!obs) return -1
  return Object.values(obs).filter(s => s && s.alive).length
}

describe('observatory 状态解析（sticky 自动解锁防护依赖）', () => {
  describe('getObservatoryStatusMap 键名兼容', () => {
    const sample = { proxy_0: { alive: true, delay: 500 }, proxy_1: { alive: false, delay: 0 } }

    it('识别小写 observatory 键（v26.3.27 regular observatory）', () => {
      assert.deepStrictEqual(getObservatoryStatusMap({ observatory: sample }), sample)
    })

    it('识别小写 burstObservatory 键', () => {
      assert.deepStrictEqual(getObservatoryStatusMap({ burstObservatory: sample }), sample)
    })

    it('识别大写 Observatory 键', () => {
      assert.deepStrictEqual(getObservatoryStatusMap({ Observatory: sample }), sample)
    })

    it('识别大写 BurstObservatory 键', () => {
      assert.deepStrictEqual(getObservatoryStatusMap({ BurstObservatory: sample }), sample)
    })

    it('未知键返回 null（当作无数据）', () => {
      assert.strictEqual(getObservatoryStatusMap({ somethingElse: sample }), null)
    })

    it('metrics 为 null/undefined 返回 null', () => {
      assert.strictEqual(getObservatoryStatusMap(null), null)
      assert.strictEqual(getObservatoryStatusMap(undefined), null)
    })

    it('observatory 非对象返回 null', () => {
      assert.strictEqual(getObservatoryStatusMap({ observatory: 'not-an-object' }), null)
    })
  })

  describe('alive 计数', () => {
    it('混合存活状态计数正确', () => {
      const metrics = {
        observatory: {
          proxy_0: { alive: true, delay: 500 },
          proxy_1: { alive: false, delay: 99999999 },
          proxy_2: { alive: true, delay: 800 },
          proxy_3: null, // 异常条目应被过滤
        },
      }
      assert.strictEqual(countAlive(metrics), 2)
    })

    it('空 observatory 计数为 0（触发延长锁定）', () => {
      // 修复的场景：observatory 首轮探测未完成，alive=0 → 不解锁、延长 60s
      assert.strictEqual(countAlive({ observatory: {} }), 0)
    })

    it('metrics 无 observatory 键时计数为 -1（metrics 未就绪）', () => {
      assert.strictEqual(countAlive({}), -1)
      // -1 ≠ 0，不触发延长也不阻止解锁——与"探测未开始"区分
      assert.notStrictEqual(countAlive({}), 0)
    })
  })
})
