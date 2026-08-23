// 回归测试：MITM 叶子证书须带有效的 Authority Key Identifier (AKI)
// 背景：createFakeCertificateByDomain / createFakeCertificateByCA 曾用
//   { name: 'authorityKeyIdentifier' } 不给 keyIdentifier 值，node-forge 1.4.0
// 据此序列化出空 AKI（OID 存在但无 keyIdentifier），OpenSSL 3.2+ 严格校验器
// 判为 "Missing Authority Key Identifier" 并拒绝连接。
// 修复：{ name: 'authorityKeyIdentifier',
//          keyIdentifier: caCert.generateSubjectKeyIdentifier().getBytes() }
// 叶子 AKI 须指向 issuer CA 的 SKI；不可用 keyIdentifier: true（会指向叶子自身）。
const assert = require('node:assert')
const fs = require('node:fs')
const { execSync } = require('node:child_process')
const forge = require('node-forge')
const tlsUtils = require('../src/lib/proxy/tls/tlsUtils')

// 生成一对 CA 证书 + 私钥（自签，含 SKI 扩展，模拟 dev-sidecar 运行时的 CA）
function makeCA (cn = 'dev-sidecar Test CA') {
  const keys = forge.pki.rsa.generateKeyPair(2048)
  const cert = forge.pki.createCertificate()
  cert.publicKey = keys.publicKey
  cert.serialNumber = `${Date.now()}`
  cert.validity.notBefore = new Date(Date.now() - 3600 * 1000)
  cert.validity.notAfter = new Date(Date.now() + 365 * 24 * 3600 * 1000)
  const attrs = [{ name: 'commonName', value: cn }]
  cert.setSubject(attrs)
  cert.setIssuer(attrs)
  cert.setExtensions([
    { name: 'basicConstraints', critical: true, cA: true },
    { name: 'keyUsage', critical: true, keyCertSign: true },
    { name: 'subjectKeyIdentifier' },
  ])
  cert.sign(keys.privateKey, forge.md.sha256.create())
  return { key: keys.privateKey, cert }
}

// 用 openssl 解析 PEM 证书，提取指定扩展的 hex 值行，避免 node-forge 扩展
// ASN.1 内部结构差异导致的比较错误。AKI/SKI 行格式：<Label>:\n  <hex>\n
function getExtHexFromOpenssl (pem, extLabel) {
  fs.writeFileSync('/tmp/_aki_cert.pem', pem)
  const text = execSync('openssl x509 -in /tmp/_aki_cert.pem -noout -text', { encoding: 'utf8' })
  const idx = text.indexOf(extLabel)
  if (idx < 0) return null
  const match = text.slice(idx + extLabel.length).match(/\n\s*([0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2})+)/)
  return match ? match[1].toUpperCase() : null
}

const akiOf = pem => getExtHexFromOpenssl(pem, 'Authority Key Identifier')
const skiOf = pem => getExtHexFromOpenssl(pem, 'Subject Key Identifier')

// 构造带 .raw 的 originCertificate（createFakeCertificateByCA 需 originCertificate.raw）
function makeOriginCert () {
  const keys = forge.pki.rsa.generateKeyPair(2048)
  const cert = forge.pki.createCertificate()
  cert.publicKey = keys.publicKey
  cert.serialNumber = '1'
  cert.validity.notBefore = new Date(Date.now() - 3600 * 1000)
  cert.validity.notAfter = new Date(Date.now() + 365 * 24 * 3600 * 1000)
  cert.setSubject([{ name: 'commonName', value: 'origin.example.com' }])
  cert.setIssuer([{ name: 'commonName', value: 'origin.example.com' }])
  cert.setExtensions([{ name: 'subjectAltName', altNames: [{ type: 2, value: 'origin.example.com' }] }])
  cert.sign(keys.privateKey, forge.md.sha256.create())
  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes()
  cert.raw = Buffer.from(der, 'binary')
  return cert
}

describe('MITM 叶子证书 Authority Key Identifier', function () {
  this.timeout(15000)

  let ca
  before(() => {
    ca = makeCA()
  })

  after(() => {
    try { fs.unlinkSync('/tmp/_aki_cert.pem') } catch (e) {}
  })

  it('createFakeCertificateByDomain 签发的叶子 AKI 应等于 CA 的 SKI（非空）', async () => {
    const { cert } = await tlsUtils.createFakeCertificateByDomain(
      ca.key, ca.cert, 'test.example.com', ['test.example.com'],
    )
    const leafPem = forge.pki.certificateToPem(cert)
    const caPem = forge.pki.certificateToPem(ca.cert)
    const aki = akiOf(leafPem)
    const caSki = skiOf(caPem)
    assert.ok(aki, '叶子 AKI 不应为空（修复前为空 SEQUENCE，openssl 显示空）')
    assert.ok(caSki, 'CA 须有 SKI 扩展')
    assert.strictEqual(aki, caSki, '叶子 AKI 须指向 CA 的 SKI')
  })

  it('createFakeCertificateByDomain 叶子的 SKI 与 CA 的 SKI 不同（防自指方向回归）', async () => {
    const { cert } = await tlsUtils.createFakeCertificateByDomain(
      ca.key, ca.cert, 'another.example.com', ['another.example.com'],
    )
    const leafPem = forge.pki.certificateToPem(cert)
    const caPem = forge.pki.certificateToPem(ca.cert)
    const leafSki = skiOf(leafPem)
    const caSki = skiOf(caPem)
    const leafAki = akiOf(leafPem)
    assert.ok(leafSki, '叶子须有 SKI')
    assert.notStrictEqual(leafSki, caSki, '叶子 SKI 须与 CA SKI 不同')
    assert.notStrictEqual(leafAki, leafSki,
      '叶子 AKI 不可指向叶子自身 SKI（防 keyIdentifier:true 误用）')
  })

  it('createFakeCertificateByCA 签发的叶子 AKI 应等于 CA 的 SKI', async () => {
    const { cert } = await tlsUtils.createFakeCertificateByCA(ca.key, ca.cert, makeOriginCert())
    const leafPem = forge.pki.certificateToPem(cert)
    const caPem = forge.pki.certificateToPem(ca.cert)
    assert.strictEqual(akiOf(leafPem), skiOf(caPem), '叶子 AKI 须指向 CA 的 SKI')
  })

  it('对真实落盘 CA（~/.dev-sidecar）签发的叶子 AKI 等于该 CA 的 SKI', async () => {
    const caCertPath = '/home/uif79392/.dev-sidecar/dev-sidecar.ca.crt'
    if (!fs.existsSync(caCertPath)) {
      this.skip()
    }
    const caKeyPem = fs.readFileSync('/home/uif79392/.dev-sidecar/dev-sidecar.ca.key.pem', 'utf8')
    const caCertPem = fs.readFileSync(caCertPath, 'utf8')
    const caCert = forge.pki.certificateFromPem(caCertPem)
    const caKey = forge.pki.privateKeyFromPem(caKeyPem)
    const { cert } = await tlsUtils.createFakeCertificateByDomain(
      caKey, caCert, 'real.example.com', ['real.example.com'],
    )
    const leafPem = forge.pki.certificateToPem(cert)
    assert.strictEqual(akiOf(leafPem), skiOf(caCertPem), '叶子 AKI 须等于真实 CA 的 SKI')
  })
})
