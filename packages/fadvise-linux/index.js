'use strict'

let bindingLoadAttempted = false
let bindingLoadError = null
let nativeBinding = null

function loadBinding () {
  if (bindingLoadAttempted) {
    return nativeBinding
  }

  bindingLoadAttempted = true
  try {
    nativeBinding = require('bindings')('fadvise_linux')
    bindingLoadError = null
  } catch (error) {
    nativeBinding = null
    bindingLoadError = error
  }

  return nativeBinding
}

function normalizeNonNegativeInteger (value, fieldName) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric) || numeric < 0 || !Number.isInteger(numeric)) {
    throw new TypeError(`${fieldName} must be a non-negative integer`)
  }
  return numeric
}

function fadviseDontNeed (fd, offset = 0, len = 0) {
  const binding = loadBinding()
  if (!binding || typeof binding.fadviseDontNeed !== 'function') {
    const error = bindingLoadError || new Error('fadvise native binding is unavailable')
    error.code = error.code || 'FADVISE_BINDING_UNAVAILABLE'
    throw error
  }

  const normalizedFd = normalizeNonNegativeInteger(fd, 'fd')
  const normalizedOffset = normalizeNonNegativeInteger(offset, 'offset')
  const normalizedLen = normalizeNonNegativeInteger(len, 'len')
  return binding.fadviseDontNeed(normalizedFd, normalizedOffset, normalizedLen)
}

function isSupported () {
  return process.platform === 'linux' && Boolean(loadBinding())
}

function getLastLoadError () {
  loadBinding()
  return bindingLoadError
}

module.exports = {
  fadviseDontNeed,
  isSupported,
  getLastLoadError,
}
