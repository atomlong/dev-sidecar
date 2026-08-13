const assert = require('node:assert')
const { isObservationReady } = require('../src/modules/plugin/xray/probe')

describe('probe isObservationReady', () => {
  describe('legacy mode (no expectedTags)', () => {
    it('returns false when no observatory data', () => {
      assert.strictEqual(isObservationReady({}, 1, 0), false)
      assert.strictEqual(isObservationReady({ observatory: null }, 1, 0), false)
    })

    it('returns false when no statuses', () => {
      const metrics = { observatory: {} }
      assert.strictEqual(isObservationReady(metrics, 1, 0), false)
    })

    it('returns true when all nodes probed (delay > 0)', () => {
      const metrics = {
        observatory: {
          proxy_0: { delay: 500, last_try_time: 100 },
          proxy_1: { delay: 800, last_try_time: 100 },
        },
      }
      assert.strictEqual(isObservationReady(metrics, 1, 0), true)
    })

    it('returns true for dead nodes (delay=99999999, last_try_time > 0)', () => {
      const metrics = {
        observatory: {
          proxy_0: { delay: 99999999, last_try_time: 100, last_seen_time: 0 },
        },
      }
      assert.strictEqual(isObservationReady(metrics, 1, 0), true)
    })

    it('returns false when node not yet probed (delay=0, last_try_time=0)', () => {
      const metrics = {
        observatory: {
          proxy_0: { delay: 0, last_try_time: 0 },
        },
      }
      assert.strictEqual(isObservationReady(metrics, 1, 0), false)
    })

    it('respects expectedSubjectCount', () => {
      const metrics = {
        observatory: {
          proxy_0: { delay: 500, last_try_time: 100 },
        },
      }
      assert.strictEqual(isObservationReady(metrics, 1, 2), false)
    })
  })

  describe('persistent mode (expectedTags)', () => {
    it('returns false when expected tag not in observatory', () => {
      const metrics = { observatory: { proxy_0: { delay: 500, last_try_time: 100 } } }
      const expectedTags = new Set(['proxy_0', 'proxy_1'])
      assert.strictEqual(isObservationReady(metrics, 1, 0, expectedTags), false)
    })

    it('returns true when all expected tags have been probed', () => {
      const metrics = {
        observatory: {
          proxy_0: { delay: 500, last_try_time: 100 },
          proxy_1: { delay: 800, last_try_time: 101 },
          // stale residue from previous batch — should be ignored
          proxy_old: { delay: 200, last_try_time: 50 },
        },
      }
      const expectedTags = new Set(['proxy_0', 'proxy_1'])
      assert.strictEqual(isObservationReady(metrics, 1, 0, expectedTags), true)
    })

    it('returns false when expected tag has delay=0 and last_try_time=0', () => {
      const metrics = {
        observatory: {
          proxy_0: { delay: 500, last_try_time: 100 },
          proxy_1: { delay: 0, last_try_time: 0 },
        },
      }
      const expectedTags = new Set(['proxy_0', 'proxy_1'])
      assert.strictEqual(isObservationReady(metrics, 1, 0, expectedTags), false)
    })

    it('with minLastTryTime: rejects status from before adoCompletedAt (stale residue)', () => {
      // proxy_0 was probed in previous batch at t=99, status is stale residue
      // proxy_1 was probed in current batch at t=200
      const metrics = {
        observatory: {
          proxy_0: { delay: 500, last_try_time: 99 },
          proxy_1: { delay: 800, last_try_time: 200 },
        },
      }
      const expectedTags = new Set(['proxy_0', 'proxy_1'])
      // adoCompletedAt = 100; minLastTryTime = 100 (no tolerance)
      // proxy_0's last_try_time=99 < 100 → stale, not ready
      assert.strictEqual(isObservationReady(metrics, 1, 0, expectedTags, 100), false)
    })

    it('with minLastTryTime: returns true when all expected tags freshly probed', () => {
      const metrics = {
        observatory: {
          proxy_0: { delay: 500, last_try_time: 200 },
          proxy_1: { delay: 99999999, last_try_time: 201 },
        },
      }
      const expectedTags = new Set(['proxy_0', 'proxy_1'])
      // Both probed at t>=100 → ready (including dead node with delay=99999999)
      assert.strictEqual(isObservationReady(metrics, 1, 0, expectedTags, 100), true)
    })

    it('with minLastTryTime: boundary — lastTry == minLastTryTime is accepted', () => {
      // Edge case: new probe at exactly t=100 (same second as adoCompletedAt)
      // This can happen if observatory probe completes in the same second as ado.
      // Accepted because >= comparison; safe because stale probes happened before rmo (before ado).
      const metrics = {
        observatory: {
          proxy_0: { delay: 500, last_try_time: 100 },
        },
      }
      const expectedTags = new Set(['proxy_0'])
      assert.strictEqual(isObservationReady(metrics, 1, 0, expectedTags, 100), true)
    })

    it('with minLastTryTime: dead node (delay=99999999) counts as probed', () => {
      const metrics = {
        observatory: {
          proxy_0: { delay: 99999999, last_try_time: 200, last_seen_time: 0 },
        },
      }
      const expectedTags = new Set(['proxy_0'])
      assert.strictEqual(isObservationReady(metrics, 1, 0, expectedTags, 150), true)
    })

    it('empty expectedTags falls through to legacy mode', () => {
      const metrics = { observatory: { proxy_0: { delay: 500, last_try_time: 100 } } }
      assert.strictEqual(isObservationReady(metrics, 1, 0, new Set()), true)
    })
  })
})
