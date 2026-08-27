import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { normalizeWebsiteUrl, isPublicNetworkAddress } from '../../src/features/analysis/analyzer.ts'

export interface ResolvedAddress {
  address: string
  family: number
}
export interface PublicTarget {
  url: string
  hostname: string
  pinnedAddress: string
  addresses: ResolvedAddress[]
}

export type TargetResolver = (hostname: string) => Promise<ResolvedAddress[]>

async function defaultResolver(hostname: string): Promise<ResolvedAddress[]> {
  return lookup(hostname, { all: true, verbatim: true })
}

export async function resolvePublicTarget(
  value: string,
  resolver: TargetResolver = defaultResolver,
): Promise<PublicTarget> {
  const url = normalizeWebsiteUrl(value)
  const hostname = new URL(url).hostname.replace(/^\[|\]$/g, '')
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await resolver(hostname)

  if (addresses.length === 0) {
    throw new Error('The public hostname did not resolve to an address.')
  }

  if (addresses.some(({ address }) => !isPublicNetworkAddress(address))) {
    throw new Error('The hostname resolves to a private, local, or reserved address.')
  }

  const pinnedAddress = addresses.find(({ family }) => family === 4)?.address
    ?? addresses[0].address

  return { url, hostname, pinnedAddress, addresses }
}
