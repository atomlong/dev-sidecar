const fs = require('node:fs')
const path = require('node:path')
const net = require('node:net')
const https = require('node:https')
const dns = require('node:dns').promises
const ipaddr = require('ipaddr.js')
const maxmind = require('maxmind')
const { getXrayExePath } = require('../../../shell/scripts/extra-path/index')

let geoipCountryRangesPromise = null
const hostAddressCache = new Map()
const countryCodeCache = new Map()
const asnOwnerCache = new Map()
let localCountryReaderPromise = null
let localAsnReaderPromise = null

function normalizeCountryCodes (value) {
  if (Array.isArray(value)) {
    return [...new Set(value
      .map(country => String(country || '').trim().toUpperCase())
      .filter(Boolean))]
  }

  if (typeof value === 'string') {
    return [...new Set(value
      .split(/[\s,;]+/)
      .map(country => country.trim().toUpperCase())
      .filter(Boolean))]
  }

  return []
}

function normalizeCountryCode (value) {
  const normalized = String(value || '').trim().toUpperCase()
  return /^[A-Z]{2}$/.test(normalized) ? normalized : ''
}

function parseCountryFilters (value) {
  const include = []
  const exclude = []
  const tokens = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[\s,;]+/)
      : []

  for (const token of tokens) {
    const normalized = String(token || '').trim().toUpperCase()
    if (!normalized) {
      continue
    }

    if (normalized.startsWith('!')) {
      const country = normalizeCountryCode(normalized.slice(1))
      if (country) {
        exclude.push(country)
      }
      continue
    }

    const country = normalizeCountryCode(normalized)
    if (country) {
      include.push(country)
    }
  }

  return {
    include: [...new Set(include)],
    exclude: [...new Set(exclude)],
  }
}

function countryMatchesFilters (country, countryFilters) {
  const normalizedCountry = normalizeCountryCode(country)
  const filters = countryFilters || { include: [], exclude: [] }
  if (!normalizedCountry) {
    return filters.include.length === 0
  }

  if (Array.isArray(filters.exclude) && filters.exclude.includes(normalizedCountry)) {
    return false
  }

  if (Array.isArray(filters.include) && filters.include.length > 0) {
    return filters.include.includes(normalizedCountry)
  }

  return true
}

function readVarint (buffer, offset) {
  let value = 0n
  let shift = 0n

  while (offset < buffer.length) {
    const byte = buffer[offset]
    offset += 1
    value |= BigInt(byte & 0x7F) << shift

    if ((byte & 0x80) === 0) {
      return { value: Number(value), offset }
    }

    shift += 7n
  }

  throw new Error('Unexpected end of buffer while reading protobuf varint')
}

function readKey (buffer, offset) {
  const result = readVarint(buffer, offset)
  return {
    fieldNumber: result.value >>> 3,
    wireType: result.value & 0x07,
    offset: result.offset,
  }
}

function skipField (buffer, offset, wireType) {
  if (wireType === 0) {
    return readVarint(buffer, offset).offset
  }

  if (wireType === 1) {
    return offset + 8
  }

  if (wireType === 2) {
    const lengthResult = readVarint(buffer, offset)
    return lengthResult.offset + lengthResult.value
  }

  if (wireType === 5) {
    return offset + 4
  }

  throw new Error(`Unsupported protobuf wire type: ${wireType}`)
}

function parseCIDRMessage (buffer) {
  let offset = 0
  let ip = null
  let prefix = 0

  while (offset < buffer.length) {
    const key = readKey(buffer, offset)
    offset = key.offset

    if (key.fieldNumber === 1 && key.wireType === 2) {
      const lengthResult = readVarint(buffer, offset)
      const end = lengthResult.offset + lengthResult.value
      ip = buffer.slice(lengthResult.offset, end)
      offset = end
      continue
    }

    if (key.fieldNumber === 2 && key.wireType === 0) {
      const prefixResult = readVarint(buffer, offset)
      prefix = prefixResult.value
      offset = prefixResult.offset
      continue
    }

    offset = skipField(buffer, offset, key.wireType)
  }

  if (!ip || ip.length === 0) {
    return null
  }

  return { ip, prefix }
}

function parseGeoIPMessage (buffer) {
  let offset = 0
  let countryCode = ''
  const cidr = []

  while (offset < buffer.length) {
    const key = readKey(buffer, offset)
    offset = key.offset

    if (key.fieldNumber === 1 && key.wireType === 2) {
      const lengthResult = readVarint(buffer, offset)
      const end = lengthResult.offset + lengthResult.value
      countryCode = buffer.slice(lengthResult.offset, end).toString('utf8')
      offset = end
      continue
    }

    if (key.fieldNumber === 2 && key.wireType === 2) {
      const lengthResult = readVarint(buffer, offset)
      const end = lengthResult.offset + lengthResult.value
      const cidrEntry = parseCIDRMessage(buffer.slice(lengthResult.offset, end))
      if (cidrEntry) {
        cidr.push(cidrEntry)
      }
      offset = end
      continue
    }

    offset = skipField(buffer, offset, key.wireType)
  }

  return {
    countryCode: countryCode.trim().toUpperCase(),
    cidr,
  }
}

function parseGeoIPList (buffer) {
  const entries = []
  let offset = 0

  while (offset < buffer.length) {
    const key = readKey(buffer, offset)
    offset = key.offset

    if (key.fieldNumber === 1 && key.wireType === 2) {
      const lengthResult = readVarint(buffer, offset)
      const end = lengthResult.offset + lengthResult.value
      const geoIP = parseGeoIPMessage(buffer.slice(lengthResult.offset, end))
      if (geoIP.countryCode && geoIP.cidr.length > 0) {
        entries.push(geoIP)
      }
      offset = end
      continue
    }

    offset = skipField(buffer, offset, key.wireType)
  }

  return entries
}

function bytesToBigInt (bytes) {
  let value = 0n
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte)
  }
  return value
}

function cidrToRange (cidr) {
  const bytes = Buffer.isBuffer(cidr.ip) ? cidr.ip : Buffer.from(cidr.ip || [])
  const totalBits = bytes.length * 8
  const prefix = Math.max(0, Math.min(Number(cidr.prefix) || 0, totalBits))
  const hostBits = BigInt(totalBits - prefix)
  const fullMask = (1n << BigInt(totalBits)) - 1n
  const hostMask = hostBits === 0n ? 0n : (1n << hostBits) - 1n
  const networkMask = fullMask ^ hostMask
  const ipValue = bytesToBigInt(bytes)

  return {
    start: ipValue & networkMask,
    end: (ipValue & networkMask) | hostMask,
  }
}

function extractNodeHosts (node) {
  const hosts = []
  const pushHost = (value) => {
    if (Array.isArray(value)) {
      value.forEach(pushHost)
      return
    }

    if (typeof value !== 'string') {
      return
    }

    const normalized = value.trim()
    if (normalized) {
      hosts.push(normalized)
    }
  }

  if (!node || typeof node !== 'object') {
    return hosts
  }

  pushHost(node.address)
  pushHost(node.serverName)
  pushHost(node.host)
  pushHost(node.streamSettings && node.streamSettings.tlsSettings && node.streamSettings.tlsSettings.serverName)
  pushHost(node.streamSettings && node.streamSettings.realitySettings && node.streamSettings.realitySettings.serverName)
  pushHost(node.streamSettings && node.streamSettings.wsSettings && node.streamSettings.wsSettings.headers && node.streamSettings.wsSettings.headers.Host)
  pushHost(node.streamSettings && node.streamSettings.httpSettings && node.streamSettings.httpSettings.host)

  if (node.settings && Array.isArray(node.settings.vnext)) {
    for (const item of node.settings.vnext) {
      pushHost(item && item.address)
    }
  }

  if (node.settings && Array.isArray(node.settings.servers)) {
    for (const item of node.settings.servers) {
      pushHost(item && item.address)
      pushHost(item && item.addr)
      pushHost(item && item.host)
    }
  }

  return [...new Set(hosts)]
}

function normalizeHostCandidate (host) {
  if (!host) {
    return ''
  }

  const trimmed = String(host).trim()
  if (!trimmed) {
    return ''
  }

  if (trimmed.startsWith('[') && trimmed.includes(']')) {
    return trimmed.slice(1, trimmed.indexOf(']'))
  }

  if (trimmed.includes(':') && trimmed.indexOf(':') === trimmed.lastIndexOf(':')) {
    const portCandidate = trimmed.slice(trimmed.lastIndexOf(':') + 1)
    if (/^\d+$/.test(portCandidate)) {
      return trimmed.slice(0, trimmed.lastIndexOf(':'))
    }
  }

  return trimmed
}

async function resolveHostAddresses (host) {
  const normalizedHost = normalizeHostCandidate(host)
  if (!normalizedHost) {
    return []
  }

  if (net.isIP(normalizedHost)) {
    return [normalizedHost]
  }

  if (hostAddressCache.has(normalizedHost)) {
    return hostAddressCache.get(normalizedHost)
  }

  const lookupPromise = dns.lookup(normalizedHost, { all: true })
    .then(results => results.map(item => item.address))
    .catch(() => [])

  hostAddressCache.set(normalizedHost, lookupPromise)
  return lookupPromise
}

function fetchJson (url, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, (response) => {
      if (response.statusCode !== 200) {
        response.resume()
        reject(new Error(`Unexpected status: ${response.statusCode}`))
        return
      }

      let data = ''
      response.on('data', (chunk) => {
        data += chunk
      })
      response.on('end', () => {
        try {
          resolve(JSON.parse(data))
        } catch (error) {
          reject(error)
        }
      })
    })

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error('ASN lookup request timeout'))
    })

    request.on('error', reject)
  })
}

function getLocalCountryDatabasePath () {
  const explicitPath = process.env.DEV_SIDECAR_COUNTRY_MMDB_PATH
  if (explicitPath) {
    return explicitPath
  }

  const xrayDir = path.dirname(getXrayExePath())

  const candidatePaths = [
    path.join(xrayDir, 'Country-without-asn.mmdb'),
    path.join(xrayDir, 'GeoLite2-Country.mmdb'),
    path.join(xrayDir, 'Country.mmdb'),
    path.join(xrayDir, 'geoip', 'Country-without-asn.mmdb'),
    path.join(xrayDir, 'geoip', 'GeoLite2-Country.mmdb'),
    path.join(xrayDir, 'geoip', 'Country.mmdb'),
  ]

  return candidatePaths.find(filePath => fs.existsSync(filePath)) || ''
}

async function loadLocalCountryReader () {
  if (localCountryReaderPromise) {
    return localCountryReaderPromise
  }

  const databasePath = getLocalCountryDatabasePath()
  if (!databasePath || !fs.existsSync(databasePath)) {
    return null
  }

  localCountryReaderPromise = maxmind.open(databasePath).catch(() => null)
  return localCountryReaderPromise
}

function extractCountryCodeFromCountryRecord (record) {
  if (!record || typeof record !== 'object') {
    return ''
  }

  const countryCode = record.country_code
    || record.countryCode
    || (record.country && (record.country.iso_code || record.country.isoCode))
    || (record.registered_country && (record.registered_country.iso_code || record.registered_country.isoCode))
    || (record.represented_country && (record.represented_country.iso_code || record.represented_country.isoCode))

  return normalizeCountryCode(countryCode)
}

async function resolveAddressCountry (address, rangeMap) {
  const normalizedAddress = normalizeHostCandidate(address)
  if (!normalizedAddress || !net.isIP(normalizedAddress)) {
    return ''
  }

  if (countryCodeCache.has(normalizedAddress)) {
    return countryCodeCache.get(normalizedAddress)
  }

  const lookupPromise = (async () => {
    const localReader = await loadLocalCountryReader()
    if (localReader) {
      const localRecord = localReader.get(normalizedAddress)
      const localCountry = extractCountryCodeFromCountryRecord(localRecord)
      if (localCountry) {
        return localCountry
      }
    }

    const activeRangeMap = rangeMap || await loadGeoipCountryRanges()
    if (activeRangeMap && activeRangeMap.size > 0) {
      const geoipCountry = findCountryCodeForAddress(normalizedAddress, activeRangeMap)
      if (geoipCountry) {
        return geoipCountry
      }
    }

    const remoteRecord = await fetchJson(`https://api.ip.sb/geoip/${encodeURIComponent(normalizedAddress)}`)
    return extractCountryCodeFromCountryRecord(remoteRecord)
  })()
    .catch(() => '')
    .then((country) => {
      if (!country) {
        countryCodeCache.delete(normalizedAddress)
      }
      return country
    })

  countryCodeCache.set(normalizedAddress, lookupPromise)
  return lookupPromise
}

function getLocalAsnDatabasePath () {
  const explicitPath = process.env.DEV_SIDECAR_ASN_MMDB_PATH
  if (explicitPath) {
    return explicitPath
  }

  const xrayDir = path.dirname(getXrayExePath())
  const candidatePaths = [
    path.join(xrayDir, 'GeoLite2-ASN.mmdb'),
    path.join(xrayDir, 'geoip', 'GeoLite2-ASN.mmdb'),
  ]

  return candidatePaths.find(filePath => fs.existsSync(filePath)) || ''
}

async function loadLocalAsnReader () {
  if (localAsnReaderPromise) {
    return localAsnReaderPromise
  }

  const databasePath = getLocalAsnDatabasePath()
  if (!databasePath || !fs.existsSync(databasePath)) {
    return null
  }

  localAsnReaderPromise = maxmind.open(databasePath).catch(() => null)
  return localAsnReaderPromise
}

function normalizeOwnerName (value) {
  return String(value || '').trim()
}

function extractOwnerFromAsnRecord (record) {
  if (!record || typeof record !== 'object') {
    return ''
  }

  const owner = record.autonomous_system_organization
    || record.asn_organization
    || record.organization
    || record.company
    || record.asn_name
    || record.descr

  return normalizeOwnerName(owner)
}

async function resolveAddressOwner (address) {
  const normalizedAddress = normalizeHostCandidate(address)
  if (!normalizedAddress || !net.isIP(normalizedAddress)) {
    return ''
  }

  if (asnOwnerCache.has(normalizedAddress)) {
    return asnOwnerCache.get(normalizedAddress)
  }

  const lookupPromise = (async () => {
    const localReader = await loadLocalAsnReader()
    if (localReader) {
      const localRecord = localReader.get(normalizedAddress)
      const localOwner = extractOwnerFromAsnRecord(localRecord)
      if (localOwner) {
        return localOwner
      }
    }

    const remoteRecord = await fetchJson(`https://api.ipapi.is/?q=${encodeURIComponent(normalizedAddress)}`)
    return extractOwnerFromAsnRecord({
      autonomous_system_organization: remoteRecord && remoteRecord.asn && remoteRecord.asn.org,
      asn_organization: remoteRecord && remoteRecord.company && remoteRecord.company.name,
      descr: remoteRecord && remoteRecord.asn && remoteRecord.asn.descr,
    })
  })()
    .catch(() => '')
    .then((owner) => {
      if (!owner) {
        asnOwnerCache.delete(normalizedAddress)
      }
      return owner
    })

  asnOwnerCache.set(normalizedAddress, lookupPromise)
  return lookupPromise
}

async function resolveNodeOwner (node) {
  if (!node || typeof node !== 'object') {
    return ''
  }

  const hosts = extractNodeHosts(node)
  for (const host of hosts) {
    const addresses = await resolveHostAddresses(host)
    for (const address of addresses) {
      const owner = await resolveAddressOwner(address)
      if (owner) {
        return owner
      }
    }
  }

  return ''
}

function ipStringToBigInt (ip) {
  const parsed = ipaddr.parse(ip)
  const bytes = parsed.toByteArray()
  return bytesToBigInt(bytes)
}

function findCountryCodeForAddress (address, rangeMap) {
  if (!rangeMap || rangeMap.size === 0) {
    return ''
  }

  let ipValue
  try {
    ipValue = ipStringToBigInt(address)
  } catch {
    return ''
  }

  for (const [countryCode, ranges] of rangeMap.entries()) {
    for (const range of ranges) {
      if (ipValue >= range.start && ipValue <= range.end) {
        return countryCode.toUpperCase()
      }
    }
  }

  return ''
}

async function resolveNodeCountry (node, rangeMap) {
  if (!node || typeof node !== 'object') {
    return ''
  }

  const activeRangeMap = rangeMap || await loadGeoipCountryRanges()

  const hosts = extractNodeHosts(node)
  for (const host of hosts) {
    const addresses = await resolveHostAddresses(host)
    for (const address of addresses) {
      const countryCode = await resolveAddressCountry(address, activeRangeMap)
      if (countryCode) {
        return countryCode
      }
    }
  }

  return ''
}

async function loadGeoipCountryRanges () {
  if (!geoipCountryRangesPromise) {
    geoipCountryRangesPromise = (async () => {
      const geoipPath = path.join(path.dirname(getXrayExePath()), 'geoip.dat')
      if (!fs.existsSync(geoipPath)) {
        return null
      }

      const raw = fs.readFileSync(geoipPath)
      const parsed = parseGeoIPList(raw)
      const ranges = new Map()

      for (const entry of parsed) {
        const countryCode = entry.countryCode.trim().toLowerCase()
        if (!countryCode) {
          continue
        }

        const countryRanges = ranges.get(countryCode) || []
        for (const cidr of entry.cidr) {
          try {
            countryRanges.push(cidrToRange(cidr))
          } catch {
            // Ignore malformed CIDR entries and continue parsing the rest.
          }
        }

        if (countryRanges.length > 0) {
          ranges.set(countryCode, countryRanges)
        }
      }

      return ranges
    })().catch(() => null)
  }

  return geoipCountryRangesPromise
}

function collectAllowedRanges (rangeMap, allowedCountries) {
  const ranges = []

  for (const countryCode of allowedCountries) {
    const countryRanges = rangeMap.get(countryCode.toLowerCase())
    if (Array.isArray(countryRanges) && countryRanges.length > 0) {
      for (const range of countryRanges) {
        ranges.push(range)
      }
    }
  }

  return ranges
}

async function hostMatchesAllowedCountries (host, allowedCountries, rangeMap) {
  if (!Array.isArray(allowedCountries) || allowedCountries.length === 0) {
    return true
  }

  if (!rangeMap || rangeMap.size === 0) {
    return true
  }

  const addresses = await resolveHostAddresses(host)
  if (addresses.length === 0) {
    return false
  }

  const allowedRanges = collectAllowedRanges(rangeMap, allowedCountries)
  if (allowedRanges.length === 0) {
    return false
  }

  for (const address of addresses) {
    let ipValue
    try {
      ipValue = ipStringToBigInt(address)
    } catch {
      continue
    }

    for (const range of allowedRanges) {
      if (ipValue >= range.start && ipValue <= range.end) {
        return true
      }
    }
  }

  return false
}

async function nodeMatchesAllowedCountries (node, allowedCountries, rangeMap) {
  if (!Array.isArray(allowedCountries) || allowedCountries.length === 0) {
    return true
  }

  const hosts = extractNodeHosts(node)
  if (hosts.length === 0) {
    return false
  }

  for (const host of hosts) {
    if (await hostMatchesAllowedCountries(host, allowedCountries, rangeMap)) {
      return true
    }
  }

  return false
}

async function filterNodesByCountries (nodes, allowedCountries) {
  if (!Array.isArray(nodes) || nodes.length === 0) {
    return []
  }

  const countryFilters = parseCountryFilters(allowedCountries)
  if (countryFilters.include.length === 0 && countryFilters.exclude.length === 0) {
    return nodes.slice()
  }

  const rangeMap = await loadGeoipCountryRanges()
  if (!rangeMap || rangeMap.size === 0) {
    return nodes.slice()
  }

  const matched = await Promise.all(nodes.map(async (node) => {
    const country = normalizeCountryCode(await resolveNodeCountry(node, rangeMap))
    return countryMatchesFilters(country, countryFilters) ? node : null
  }))

  return matched.filter(Boolean)
}

module.exports = {
  extractNodeHosts,
  filterNodesByCountries,
  loadGeoipCountryRanges,
  countryMatchesFilters,
  normalizeCountryCodes,
  parseCountryFilters,
  resolveAddressCountry,
  resolveAddressOwner,
  resolveNodeCountry,
  resolveNodeOwner,
  nodeMatchesAllowedCountries,
}
