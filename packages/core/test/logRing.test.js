const assert = require('node:assert')
const logRing = require('../src/utils/util.log-ring')

// 复刻 log4js loggingEvent 的最小结构，走真实 configure 返回的 appender
function makeAppender () {
  return logRing.configure()
}

function fakeEvent ({ ts = 1788160000000, level = 'INFO', category = 'core', data = [] } = {}) {
  return {
    startTime: new Date(ts),
    level: { levelStr: level },
    categoryName: category,
    data,
  }
}

describe('util.log-ring (WebUI 日志环形缓冲 appender)', function () {
  let appender

  beforeEach(function () {
    logRing._resetForTest()
    appender = makeAppender()
  })

  it('capture: 字符串/对象/Error 转为结构化条目，level 归一化为小写', function () {
    appender(fakeEvent({ level: 'WARN', category: 'gui', data: ['警告', { code: 1 }] }))
    appender(fakeEvent({ level: 'ERROR', data: [new Error('爆炸')] }))
    const entries = logRing.getEntries({})
    assert.strictEqual(entries.length, 2)
    assert.strictEqual(entries[0].level, 'warn')
    assert.strictEqual(entries[0].category, 'gui')
    assert.strictEqual(entries[0].message, '警告 {"code":1}')
    assert.strictEqual(entries[1].level, 'error')
    assert.ok(entries[1].message.includes('Error: 爆炸'))
    assert.ok(entries[1].message.includes('at ')) // 堆栈已捕获
    assert.ok(entries[1].ts >= 1788160000000)
    assert.strictEqual(entries[1].seq, 2)
  })

  it('容量淘汰：超出容量的最旧条目被移除，保留最新', function () {
    logRing._resetForTest(3)
    appender = makeAppender()
    for (let i = 1; i <= 5; i++) {
      appender(fakeEvent({ data: ['条目' + i] }))
    }
    const entries = logRing.getEntries({})
    assert.strictEqual(entries.length, 3)
    assert.deepStrictEqual(entries.map(e => e.message), ['条目3', '条目4', '条目5'])
  })

  it('超长消息被截断限长（内存上界保障）', function () {
    const long = 'x'.repeat(5000)
    appender(fakeEvent({ data: [long] }))
    const entry = logRing.getEntries({})[0]
    assert.ok(entry.message.length <= 2000 + 20)
    assert.ok(entry.message.includes('截断'))
  })

  it('level 过滤：按最低等级（warn 含 error）', function () {
    appender(fakeEvent({ level: 'DEBUG', data: ['d'] }))
    appender(fakeEvent({ level: 'INFO', data: ['i'] }))
    appender(fakeEvent({ level: 'WARN', data: ['w'] }))
    appender(fakeEvent({ level: 'ERROR', data: ['e'] }))
    assert.deepStrictEqual(logRing.getEntries({ level: 'warn' }).map(e => e.message), ['w', 'e'])
    assert.strictEqual(logRing.getEntries({ level: 'info' }).length, 3)
    assert.strictEqual(logRing.getEntries({}).length, 4)
  })

  it('q 过滤：消息/模块子串、不分大小写；category 精确匹配', function () {
    appender(fakeEvent({ category: 'core', data: ['Xray 启动完成'] }))
    appender(fakeEvent({ category: 'gui', data: ['窗口已关闭'] }))
    assert.deepStrictEqual(logRing.getEntries({ q: 'xray' }).map(e => e.category), ['core'])
    assert.deepStrictEqual(logRing.getEntries({ q: 'GUI' }).map(e => e.category), ['gui'])
    assert.deepStrictEqual(logRing.getEntries({ category: 'gui' }).map(e => e.message), ['窗口已关闭'])
    assert.strictEqual(logRing.getEntries({ q: '不存在的词' }).length, 0)
  })

  it('limit：优先返回最新 N 条且保持时间升序', function () {
    for (let i = 1; i <= 10; i++) {
      appender(fakeEvent({ data: ['L' + i] }))
    }
    const entries = logRing.getEntries({ limit: 3 })
    assert.deepStrictEqual(entries.map(e => e.message), ['L8', 'L9', 'L10'])
  })

  it('subscribe：新条目回调推送，退订后停止', function () {
    const seen = []
    const off = logRing.subscribe((e) => seen.push(e.message))
    appender(fakeEvent({ data: ['推送1'] }))
    off()
    appender(fakeEvent({ data: ['推送2'] }))
    assert.deepStrictEqual(seen, ['推送1'])
  })

  it('订阅方抛错不影响日志主流程', function () {
    const off = logRing.subscribe(() => { throw new Error('订阅者炸了') })
    appender(fakeEvent({ data: ['不受影响'] }))
    off()
    assert.strictEqual(logRing.getEntries({})[0].message, '不受影响')
  })

  it('getCategories 返回去重后的模块列表', function () {
    appender(fakeEvent({ category: 'core', data: ['a'] }))
    appender(fakeEvent({ category: 'core', data: ['b'] }))
    appender(fakeEvent({ category: 'gui', data: ['c'] }))
    assert.deepStrictEqual(logRing.getCategories(), ['core', 'gui'])
  })
})
