import { describe, expect, it } from 'vitest'
import { resolvePublicTarget } from './publicTarget.ts'

describe('resolvePublicTarget', () => {
  it('accepts a public hostname only when every answer is public', async () => {
    const target = await resolvePublicTarget('https://public.example.at/search', async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
    ])

    expect(target).toMatchObject({
      origin: 'https://public.example.at',
      hostname: 'public.example.at',
      pinnedAddress: '93.184.216.34',
    })
  })

  it.each([
    '127.0.0.1',
    '10.0.0.8',
    '169.254.169.254',
    '192.168.1.2',
    '::1',
    'fc00::1',
    '2001:db8::1',
    '64:ff9b::7f00:1',
    '64:ff9b::a00:1',
    '64:ff9b::a9fe:a9fe',
    '64:ff9b::0808:0808',
    '64:ff9b::5db8:d822',
    '2001:1::1',
    '2001:3::1',
    '2001:4:112::1',
    '2001:30::1',
  ])('rejects a hostname that resolves to %s', async (address) => {
    await expect(resolvePublicTarget('https://public.example.at', async () => [
      { address, family: address.includes(':') ? 6 : 4 },
    ])).rejects.toThrow('private, local, or reserved')
  })

  it('fails closed when one DNS answer is private', async () => {
    await expect(resolvePublicTarget('https://public.example.at', async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ])).rejects.toThrow('private, local, or reserved')
  })

  it.each([
    'https://[64:ff9b::5db8:d822]/',
    'https://[2001:1::1]/',
    'https://[2001:30::1]/',
  ])('rejects the direct literal %s when the Sandbox firewall denies its range', async (value) => {
    await expect(resolvePublicTarget(value, async () => {
      throw new Error('Literal addresses must not perform DNS resolution.')
    })).rejects.toMatchObject({ code: 'invalid_target', status: 400 })
  })

  it('maps DNS resolver failures to a safe invalid_target client error', async () => {
    await expect(resolvePublicTarget('https://does-not-exist.invalid-domain-test.com', async () => {
      throw Object.assign(new Error('getaddrinfo ENOTFOUND does-not-exist.invalid-domain-test.com'), { code: 'ENOTFOUND' })
    })).rejects.toMatchObject({
      code: 'invalid_target',
      status: 400,
      message: 'The public hostname did not resolve to an address.',
    })
  })
})
