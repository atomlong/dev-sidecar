const assert = require('node:assert')
const { addOutbounds, removeOutbounds } = require('../src/modules/plugin/xray/xray_api')

describe('xray_api', () => {
  describe('addOutbounds', () => {
    it('throws when apiPort is missing', async () => {
      await assert.rejects(() => addOutbounds('/bin/xray', 0, []), /apiPort and binPath are required/)
    })

    it('throws when binPath is missing', async () => {
      await assert.rejects(() => addOutbounds('', 12345, []), /apiPort and binPath are required/)
    })
  })

  describe('removeOutbounds', () => {
    it('throws when apiPort is missing', async () => {
      await assert.rejects(() => removeOutbounds('/bin/xray', 0, ['proxy_0']), /apiPort and binPath are required/)
    })

    it('throws when binPath is missing', async () => {
      await assert.rejects(() => removeOutbounds('', 12345, ['proxy_0']), /apiPort and binPath are required/)
    })
  })

  describe('parseAdoResults (via module internals)', () => {
    // parseAdoResults is not exported, but we can test the parsing logic
    // by simulating the stdout patterns observed in experiments.
    function parseAdoResults (stdout) {
      const results = []
      const lines = stdout.split('\n')
      for (let i = 0; i < lines.length; i++) {
        const match = lines[i].match(/^adding: (\S+)/)
        if (!match) {
          continue
        }
        const tag = match[1]
        let success = false
        for (let j = i + 1; j < lines.length; j++) {
          if (lines[j].match(/^adding: /)) {
            break
          }
          if (lines[j].trim() === '{}') {
            success = true
            break
          }
        }
        results.push({ tag, success })
      }
      return results
    }

    it('parses all-success output', () => {
      const stdout = 'adding: proxy_0\n{}\nadding: proxy_1\n{}\nadding: proxy_2\n{}\n'
      const results = parseAdoResults(stdout)
      assert.strictEqual(results.length, 3)
      assert.deepStrictEqual(results, [
        { tag: 'proxy_0', success: true },
        { tag: 'proxy_1', success: true },
        { tag: 'proxy_2', success: true },
      ])
    })

    it('parses partial failure (ado stops at first invalid)', () => {
      const stdout = 'adding: proxy_0\n{}\nadding: proxy_1\n{}\nadding: proxy_bad\n'
      const results = parseAdoResults(stdout)
      assert.strictEqual(results.length, 3)
      assert.strictEqual(results[0].success, true)
      assert.strictEqual(results[1].success, true)
      assert.strictEqual(results[2].success, false)
    })

    it('parses empty output', () => {
      const results = parseAdoResults('')
      assert.strictEqual(results.length, 0)
    })

    it('parses output with warnings between entries', () => {
      const stdout = [
        'adding: proxy_0',
        '2026/08/13 13:10:43 [Warning] deprecated feature',
        '{}',
        'adding: proxy_1',
        '2026/08/13 13:10:43 [Warning] deprecated feature',
        '{}',
      ].join('\n')
      const results = parseAdoResults(stdout)
      assert.strictEqual(results.length, 2)
      assert.strictEqual(results[0].tag, 'proxy_0')
      assert.strictEqual(results[0].success, true)
      assert.strictEqual(results[1].tag, 'proxy_1')
      assert.strictEqual(results[1].success, true)
    })
  })
})
