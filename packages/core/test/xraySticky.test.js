const assert = require('node:assert')
const { overrideBalancer, removeBalancerOverride, getBalancerInfo } = require('../src/modules/plugin/xray/xray_api')

describe('xray_api balancer override', () => {
  describe('overrideBalancer', () => {
    it('throws when apiPort is missing', async () => {
      await assert.rejects(() => overrideBalancer('/bin/xray', 0, 'balancer-proxy', 'proxy_0'), /apiPort and binPath are required/)
    })

    it('throws when binPath is missing', async () => {
      await assert.rejects(() => overrideBalancer('', 12345, 'balancer-proxy', 'proxy_0'), /apiPort and binPath are required/)
    })
  })

  describe('removeBalancerOverride', () => {
    it('throws when apiPort is missing', async () => {
      await assert.rejects(() => removeBalancerOverride('/bin/xray', 0, 'balancer-proxy'), /apiPort and binPath are required/)
    })

    it('throws when binPath is missing', async () => {
      await assert.rejects(() => removeBalancerOverride('', 12345, 'balancer-proxy'), /apiPort and binPath are required/)
    })
  })

  describe('getBalancerInfo', () => {
    it('throws when apiPort is missing', async () => {
      await assert.rejects(() => getBalancerInfo('/bin/xray', 0, 'balancer-proxy'), /apiPort and binPath are required/)
    })

    it('throws when binPath is missing', async () => {
      await assert.rejects(() => getBalancerInfo('', 12345, 'balancer-proxy'), /apiPort and binPath are required/)
    })
  })

  describe('balancer info parsing', () => {
    // Test the regex used by enableSticky to extract the current selection
    function parseSelectedTag (info) {
      const match = info.match(/Selects:\s*\n\s*\d+\s+(\S+)/)
      return match ? match[1] : null
    }

    it('parses selected tag from balancer info output', () => {
      const info = '- Selecting Override:\n  1                 \n- Selects:\n  1   proxy_19      \n'
      assert.strictEqual(parseSelectedTag(info), 'proxy_19')
    })

    it('parses selected tag with proxy_0', () => {
      const info = '- Selects:\n  1   proxy_0       \n'
      assert.strictEqual(parseSelectedTag(info), 'proxy_0')
    })

    it('returns null when no Selects section', () => {
      const info = '- Selecting Override:\n  1                 \n'
      assert.strictEqual(parseSelectedTag(info), null)
    })

    it('returns null for empty info', () => {
      assert.strictEqual(parseSelectedTag(''), null)
    })
  })
})
