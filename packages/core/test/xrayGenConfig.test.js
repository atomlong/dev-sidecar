const assert = require('node:assert')
const genConfig = require('../src/modules/plugin/xray/gen_config')

function createNode (address, port) {
  return {
    protocol: 'socks',
    settings: {
      servers: [{ address, port }],
    },
  }
}

describe('xray gen_config', () => {
  describe('selector prefix', () => {
    it('balancer selector uses proxy_ prefix, not explicit tag list', () => {
      const config = genConfig(10801, [createNode('1.2.3.4', 1080)], [], 'https://example.com', 60, {
        observatoryEnableConcurrency: true,
      })

      assert.ok(config.routing.balancers.length > 0)
      const balancer = config.routing.balancers[0]
      assert.deepStrictEqual(balancer.selector, ['proxy_'])
    })

    it('observatory subjectSelector uses proxy_ prefix, not explicit tag list', () => {
      const config = genConfig(10801, [createNode('1.2.3.4', 1080)], [], 'https://example.com', 60, {
        observatoryEnableConcurrency: true,
      })

      assert.ok(config.observatory)
      assert.deepStrictEqual(config.observatory.subjectSelector, ['proxy_'])
    })

    it('prefix selector present even with zero nodes (observatory exists, balancer absent)', () => {
      const config = genConfig(10801, [], [], 'https://example.com', 60, {
        observatoryEnableConcurrency: true,
      })

      assert.strictEqual(config.routing.balancers.length, 0)
      // observatory is still generated with the prefix selector
      assert.ok(config.observatory)
      assert.deepStrictEqual(config.observatory.subjectSelector, ['proxy_'])
    })
  })

  describe('api block', () => {
    it('generates api block when apiPort is set', () => {
      const config = genConfig(10801, [createNode('1.2.3.4', 1080)], [], 'https://example.com', 60, {
        apiPort: 15437,
        observatoryEnableConcurrency: true,
      })

      assert.ok(config.api, 'api block should be present')
      assert.strictEqual(config.api.tag, 'api')
      assert.strictEqual(config.api.listen, '127.0.0.1:15437')
      assert.ok(config.api.services.includes('HandlerService'))
    })

    it('omits api block when apiPort is null', () => {
      const config = genConfig(10801, [createNode('1.2.3.4', 1080)], [], 'https://example.com', 60, {
        apiPort: null,
        observatoryEnableConcurrency: true,
      })

      assert.strictEqual(config.api, undefined)
    })

    it('omits api block when apiPort is not provided', () => {
      const config = genConfig(10801, [createNode('1.2.3.4', 1080)], [], 'https://example.com', 60, {
        observatoryEnableConcurrency: true,
      })

      assert.strictEqual(config.api, undefined)
    })
  })

  describe('outbound tags', () => {
    it('assigns proxy_0, proxy_1, ... tags to nodes', () => {
      const nodes = [createNode('1.1.1.1', 1080), createNode('2.2.2.2', 1080)]
      const config = genConfig(10801, nodes, [], 'https://example.com', 60, {
        observatoryEnableConcurrency: true,
      })

      const proxyOutbounds = config.outbounds.filter(o => o.tag && o.tag.startsWith('proxy_'))
      assert.strictEqual(proxyOutbounds.length, 2)
      assert.strictEqual(proxyOutbounds[0].tag, 'proxy_0')
      assert.strictEqual(proxyOutbounds[1].tag, 'proxy_1')
    })
  })
})
