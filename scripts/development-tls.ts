/** Cross-platform private localhost CA/PFX generation; never changes OS trust. */
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import forge from 'node-forge'

export async function generateDevelopmentTls(directory: string): Promise<void> {
  const pair = () => {
    const value = generateKeyPairSync('rsa', { modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })
    return { privateKey: forge.pki.privateKeyFromPem(value.privateKey), publicKey: forge.pki.publicKeyFromPem(value.publicKey) }
  }
  const caKeys = pair(), serverKeys = pair()
  const certificate = (keys: ReturnType<typeof pair>, commonName: string) => {
    const cert = forge.pki.createCertificate()
    cert.publicKey = keys.publicKey
    cert.serialNumber = '01' + randomBytes(15).toString('hex')
    cert.validity.notBefore = new Date(Date.now() - 300000)
    cert.validity.notAfter = new Date(Date.now() + 90 * 86400000)
    cert.setSubject([{ name: 'commonName', value: commonName }])
    return cert
  }
  const ca = certificate(caKeys, 'MCP Proxy Project Development CA')
  ca.setIssuer(ca.subject.attributes)
  ca.setExtensions([{ name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true }])
  ca.sign(caKeys.privateKey, forge.md.sha256.create())
  const server = certificate(serverKeys, 'localhost')
  server.setIssuer(ca.subject.attributes)
  server.setExtensions([{ name: 'basicConstraints', cA: false, critical: true },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }] }])
  server.sign(caKeys.privateKey, forge.md.sha256.create())
  const pfx = forge.pkcs12.toPkcs12Asn1(serverKeys.privateKey, [server, ca], '', { algorithm: 'aes256' })
  await writeFile(join(directory, 'ca.pem'), forge.pki.certificateToPem(ca), { flag: 'wx', mode: 0o600 })
  await writeFile(join(directory, 'server.pfx'), Buffer.from(forge.asn1.toDer(pfx).getBytes(), 'binary'), { flag: 'wx', mode: 0o600 })
}
