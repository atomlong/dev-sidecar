const assert = require('node:assert/strict')
const networkGuard = require('../src/modules/plugin/xray/network_guard')

describe('xray network guard', () => {
  it('returns immediately when local network is available', async () => {
    const requestedUrls = []
    const result = await networkGuard.ensureLocalNetworkAvailability({
      urls: ['https://example.com/a', 'https://example.com/b'],
      retryDelayMs: 1,
      requestFn: async (url) => {
        requestedUrls.push(url)
        return url.endsWith('/a')
      },
    })

    assert.deepStrictEqual(requestedUrls, ['https://example.com/a'])
    assert.deepStrictEqual(result, {
      available: true,
      waited: false,
      attempts: 0,
    })
  })

  it('waits for recovery after detecting offline state', async () => {
    let offlineNotifications = 0
    let recoveredAttempts = 0
    const outcomes = [false, false, true]
    const result = await networkGuard.ensureLocalNetworkAvailability({
      urls: ['https://example.com/a'],
      retryDelayMs: 1,
      requestFn: async () => outcomes.shift(),
      onOffline: ({ attempts }) => {
        offlineNotifications = attempts
      },
      onRecovered: ({ attempts }) => {
        recoveredAttempts = attempts
      },
    })

    assert.equal(offlineNotifications, 2)
    assert.equal(recoveredAttempts, 2)
    assert.deepStrictEqual(result, {
      available: true,
      waited: true,
      attempts: 2,
    })
  })
})