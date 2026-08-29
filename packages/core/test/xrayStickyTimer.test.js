const assert = require('node:assert')
const {
  createStickyAutoUnlockTimer,
  pickStickySurvivorTag,
  MAX_STICKY_TIMER_DELAY_MS,
  STICKY_AUTO_UNLOCK_EXTENSION_MS,
  MAX_STICKY_AUTO_UNLOCK_EXTENSIONS,
} = require('../src/modules/plugin/xray/sticky')

// Manual clock + captured timers. Node clamps setTimeout delays > 2^31-1ms
// down to 1ms, so the timer must be driven through injectable setTimeoutFn.
function createHarness ({ alive = () => 1 } = {}) {
  let now = 0
  let nextId = 1
  const pending = new Map()
  const scheduledDelays = []
  const extendsLog = []
  const unlockedAt = []

  const setTimeoutFn = (cb, delay) => {
    const id = nextId++
    pending.set(id, { at: now + delay, cb })
    scheduledDelays.push(delay)
    return id
  }
  const clearTimeoutFn = (id) => {
    pending.delete(id)
  }

  const ctl = createStickyAutoUnlockTimer({
    setTimeoutFn,
    clearTimeoutFn,
    nowFn: () => now,
    getAliveCount: async () => alive(),
    onExtend: (extension, maxExtensions) => {
      extendsLog.push({ extension, maxExtensions, at: now })
    },
    onUnlock: async () => {
      unlockedAt.push(now)
    },
  })

  async function advance (ms) {
    const target = now + ms
    for (;;) {
      let earliestId = null
      let earliest = null
      for (const [id, t] of pending) {
        if (t.at <= target && (earliest == null || t.at < earliest.at)) {
          earliest = t
          earliestId = id
        }
      }
      if (earliestId == null) {
        break
      }
      pending.delete(earliestId)
      now = Math.max(now, earliest.at)
      await earliest.cb()
    }
    now = target
  }

  return {
    ctl,
    advance,
    scheduledDelays,
    extendsLog,
    unlockedAt,
    pendingCount: () => pending.size,
  }
}

describe('xray sticky auto-unlock timer (锁定期状态机)', () => {
  it('永久锁(10y)不再被钳成 1ms 秒解——回归保护 setTimeout >2^31-1ms 溢出', async () => {
    const h = createHarness({ alive: () => 3 })
    h.ctl.arm(315360000000)
    assert.strictEqual(h.scheduledDelays[0], MAX_STICKY_TIMER_DELAY_MS)
    assert.ok(h.ctl.isArmed())
    // 旧 bug 在 ~1ms 就触发解锁；前进 60s 不应有任何动作
    await h.advance(60 * 1000)
    assert.strictEqual(h.unlockedAt.length, 0)
    assert.strictEqual(h.extendsLog.length, 0)
    assert.ok(h.ctl.isArmed())
  })

  it('超过 24.8 天的锁链式续期，不解锁且保留 unlockAt', async () => {
    const h = createHarness({ alive: () => 3 })
    h.ctl.arm(315360000000)
    await h.advance(MAX_STICKY_TIMER_DELAY_MS)
    assert.strictEqual(h.unlockedAt.length, 0)
    assert.strictEqual(h.extendsLog.length, 0)
    assert.ok(h.ctl.isArmed())
    assert.strictEqual(h.scheduledDelays.length, 2)
    assert.strictEqual(h.scheduledDelays[1], MAX_STICKY_TIMER_DELAY_MS)
    assert.strictEqual(h.ctl.getUnlockAt(), 315360000000)
  })

  it('到期且 observatory 有数据 → 立即释放', async () => {
    const h = createHarness({ alive: () => 3 })
    h.ctl.arm(300000)
    await h.advance(300000)
    assert.deepStrictEqual(h.unlockedAt, [300000])
    assert.strictEqual(h.extendsLog.length, 0)
    assert.strictEqual(h.ctl.isArmed(), false)
    assert.strictEqual(h.ctl.getUnlockAt(), 0)
  })

  it('到期但 observatory 无数据 → 顺延 60s 最多 5 次，之后按设计裸释放', async () => {
    const h = createHarness({ alive: () => 0 })
    h.ctl.arm(300000)
    await h.advance(300000 + MAX_STICKY_AUTO_UNLOCK_EXTENSIONS * STICKY_AUTO_UNLOCK_EXTENSION_MS + 1000)
    assert.deepStrictEqual(h.extendsLog.map(e => e.extension), [1, 2, 3, 4, 5])
    assert.deepStrictEqual(h.unlockedAt, [300000 + 5 * STICKY_AUTO_UNLOCK_EXTENSION_MS])
    assert.strictEqual(h.ctl.isArmed(), false)
    assert.deepStrictEqual(h.scheduledDelays, [300000, ...Array(5).fill(STICKY_AUTO_UNLOCK_EXTENSION_MS)])
  })

  it('顺延期间数据出现 → 尽快释放', async () => {
    let calls = 0
    const h = createHarness({ alive: () => (calls++ < 2 ? 0 : 3) })
    h.ctl.arm(300000)
    await h.advance(300000 + 2 * STICKY_AUTO_UNLOCK_EXTENSION_MS + 1000)
    assert.deepStrictEqual(h.extendsLog.map(e => e.extension), [1, 2])
    assert.deepStrictEqual(h.unlockedAt, [300000 + 2 * STICKY_AUTO_UNLOCK_EXTENSION_MS])
    assert.strictEqual(h.ctl.isArmed(), false)
  })

  it('重新 arm 替换旧定时器（手动改锁/重启重锁语义）', async () => {
    const h = createHarness({ alive: () => 3 })
    h.ctl.arm(300000)
    h.ctl.arm(60000)
    assert.strictEqual(h.pendingCount(), 1)
    assert.deepStrictEqual(h.scheduledDelays, [300000, 60000])
    await h.advance(60000)
    assert.deepStrictEqual(h.unlockedAt, [60000])
    assert.strictEqual(h.ctl.getUnlockAt(), 0)
  })

  it('disarm 取消定时器并清零 unlockAt', async () => {
    const h = createHarness({ alive: () => 3 })
    h.ctl.arm(100000)
    h.ctl.disarm()
    assert.strictEqual(h.ctl.isArmed(), false)
    assert.strictEqual(h.ctl.getUnlockAt(), 0)
    await h.advance(200000)
    assert.strictEqual(h.unlockedAt.length, 0)
    assert.strictEqual(h.pendingCount(), 0)
  })

  it('0/负延迟被钳为 0，直接进入 observatory 守卫', async () => {
    const h = createHarness({ alive: () => 3 })
    h.ctl.arm(0)
    assert.strictEqual(h.scheduledDelays[0], 0)
    await h.advance(0)
    assert.deepStrictEqual(h.unlockedAt, [0])
    assert.strictEqual(h.ctl.isArmed(), false)
  })
})

describe('xray sticky survivor picker (override 迁移目标选择)', () => {
  it('选择缓存延时最低的有效存活节点', () => {
    const survivors = [['fpA', 'proxy_1'], ['fpB', 'proxy_2'], ['fpC', 'proxy_3']]
    const delays = { fpA: 120, fpB: 80, fpC: 200 }
    assert.strictEqual(pickStickySurvivorTag({ survivors, getDelay: fp => delays[fp] }), 'proxy_2')
  })

  it('无效延时(0/负/NaN/缺失)被跳过，兜底第一个存活节点', () => {
    const survivors = [['fpA', 'proxy_1'], ['fpB', 'proxy_2']]
    const delays = { fpA: 0, fpB: -5 }
    assert.strictEqual(pickStickySurvivorTag({ survivors, getDelay: fp => delays[fp] }), 'proxy_1')
    assert.strictEqual(pickStickySurvivorTag({ survivors, getDelay: () => NaN }), 'proxy_1')
    assert.strictEqual(pickStickySurvivorTag({ survivors, getDelay: () => undefined }), 'proxy_1')
  })

  it('全部有效时保持最低者；并列时保留先出现的', () => {
    const survivors = [['fpA', 'proxy_1'], ['fpB', 'proxy_2']]
    assert.strictEqual(pickStickySurvivorTag({ survivors, getDelay: () => 50 }), 'proxy_1')
  })

  it('无存活节点返回 null', () => {
    assert.strictEqual(pickStickySurvivorTag({ survivors: [], getDelay: () => 50 }), null)
    assert.strictEqual(pickStickySurvivorTag({ survivors: undefined, getDelay: () => 50 }), null)
  })
})
