const assert = require('node:assert')
const EventEmitter = require('node:events')
const https = require('node:https')

const commonUtil = require('../src/lib/proxy/common/util')
const matchUtil = require('../src/utils/util.match')
const createUpgradeHandler = require('../src/lib/proxy/mitmproxy/createUpgradeHandler')

describe('createUpgradeHandler', () => {
  it('does not crash before issuing an upgrade request when DNS config is present', async () => {
    const originalGetOptionsFromRequest = commonUtil.getOptionsFromRequest
    const originalHttpsRequest = https.request

    let requestCalled = false
    let requestOptions

    try {
      commonUtil.getOptionsFromRequest = () => {
        return {
          method: 'GET',
          protocol: 'https:',
          hostname: 'copilot.microsoft.com',
          host: 'copilot.microsoft.com',
          port: 443,
          path: '/c/api/chat?api-version=2',
          headers: {
            host: 'copilot.microsoft.com',
            connection: 'Upgrade',
          },
        }
      }

      https.request = (options) => {
        requestCalled = true
        requestOptions = options

        const proxyReq = new EventEmitter()
        proxyReq.end = () => {}
        return proxyReq
      }

      const dnsConfig = {
        dnsMap: {
          PreSet: { dnsName: 'PreSet' },
          ForSNI: { dnsName: 'PreSet' },
        },
        preSetIpList: matchUtil.domainMapRegexply({
          'copilot.microsoft.com': true,
        }),
        mapping: matchUtil.domainMapRegexply({}),
      }

      const upgradeHandler = createUpgradeHandler(() => [], [], null, dnsConfig, {}, null)
      const req = { url: '/c/api/chat?api-version=2' }
      const cltSocket = {
        ended: false,
        on () {},
        end () {
          this.ended = true
        },
      }

      upgradeHandler(req, cltSocket, Buffer.alloc(0), true)
      await new Promise((resolve) => setImmediate(resolve))

      assert.strictEqual(requestCalled, true)
      assert.strictEqual(typeof requestOptions.lookup, 'function')
      assert.strictEqual(requestOptions.family, undefined)
      assert.strictEqual(cltSocket.ended, false)
    } finally {
      commonUtil.getOptionsFromRequest = originalGetOptionsFromRequest
      https.request = originalHttpsRequest
    }
  })
})