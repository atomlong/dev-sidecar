// Sticky auto-unlock timer extracted from index.js so the duration/overflow
// semantics are unit-testable. Node's setTimeout clamps delays > 2^31-1 ms
// down to 1 ms — arming a "permanent" lock (10y sentinel = 315360000000 ms)
// would self-release instantly. This module caps every wait and re-chains
// until the real unlock time, then defers the actual release until the
// observatory reports alive nodes (leastPing with no data selects nothing).
const MAX_STICKY_TIMER_DELAY_MS = 2147483641
const STICKY_AUTO_UNLOCK_EXTENSION_MS = 60 * 1000
const MAX_STICKY_AUTO_UNLOCK_EXTENSIONS = 5

function createStickyAutoUnlockTimer ({
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  nowFn = Date.now,
  getAliveCount,
  onExtend,
  onUnlock,
}) {
  let timer = null
  let unlockAt = 0
  let extensions = 0

  function schedule (delayMs) {
    timer = setTimeoutFn(fire, delayMs)
  }

  function arm (delayMs) {
    if (timer) {
      clearTimeoutFn(timer)
      timer = null
    }
    extensions = 0
    unlockAt = nowFn() + delayMs
    schedule(Math.min(Math.max(delayMs, 0), MAX_STICKY_TIMER_DELAY_MS))
  }

  async function fire () {
    timer = null
    const remainingMs = unlockAt - nowFn()
    if (remainingMs > 1000) {
      schedule(Math.min(remainingMs, MAX_STICKY_TIMER_DELAY_MS))
      return
    }
    const aliveCount = await getAliveCount()
    if (aliveCount === 0 && extensions < MAX_STICKY_AUTO_UNLOCK_EXTENSIONS) {
      extensions++
      onExtend(extensions, MAX_STICKY_AUTO_UNLOCK_EXTENSIONS)
      schedule(STICKY_AUTO_UNLOCK_EXTENSION_MS)
      return
    }
    unlockAt = 0
    await onUnlock()
  }

  function disarm () {
    if (timer) {
      clearTimeoutFn(timer)
      timer = null
    }
    unlockAt = 0
  }

  return {
    arm,
    disarm,
    isArmed: () => timer !== null,
    getUnlockAt: () => unlockAt,
  }
}

// Best surviving tag to hold the override: lowest valid delay, else the first
// survivor (a possibly-dead survivor still beats releasing the override —
// leastPing without observatory data selects nothing and traffic drops).
// survivors: [[fingerprint, tag], ...]; getDelay: (fingerprint) => delay.
function pickStickySurvivorTag ({ survivors, getDelay }) {
  if (!Array.isArray(survivors) || survivors.length === 0) {
    return null
  }
  let bestTag = survivors[0][1]
  let bestDelay = Infinity
  for (const [fp, tag] of survivors) {
    const d = Number(getDelay(fp))
    if (Number.isFinite(d) && d > 0 && d < bestDelay) {
      bestDelay = d
      bestTag = tag
    }
  }
  return bestTag
}

module.exports = {
  createStickyAutoUnlockTimer,
  pickStickySurvivorTag,
  MAX_STICKY_TIMER_DELAY_MS,
  STICKY_AUTO_UNLOCK_EXTENSION_MS,
  MAX_STICKY_AUTO_UNLOCK_EXTENSIONS,
}
