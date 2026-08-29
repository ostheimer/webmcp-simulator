import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { normalizeWebsiteUrl, isPublicNetworkAddress } from '../../src/features/analysis/analyzer.ts'
import { WrapperServiceError } from './wrapperErrors.ts'

export interface ResolvedAddress {
  address: string
  family: number
}
export interface PublicTarget {
  url: string
  origin: string
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
  let url: string
  try {
    url = normalizeWebsiteUrl(value)
  } catch (error) {
    const safeMessages = new Set([
      'Enter a public HTTP or HTTPS website URL.',
      'URLs containing credentials are not supported.',
      'Enter a public website URL, not a local, private, or reserved address.',
    ])
    const message = error instanceof Error && safeMessages.has(error.message)
      ? error.message
      : 'Enter a valid public HTTP or HTTPS website URL.'
    throw new WrapperServiceError('invalid_target', message, 400)
  }
  const parsedUrl = new URL(url)
  const hostname = parsedUrl.hostname.replace(/^\[|\]$/g, '')
  let addresses: ResolvedAddress[]
  try {
    addresses = isIP(hostname)
      ? [{ address: hostname, family: isIP(hostname) }]
      : await resolver(hostname)
  } catch {
    throw new WrapperServiceError('invalid_target', 'The public hostname did not resolve to an address.', 400)
  }

  if (addresses.length === 0) {
    throw new WrapperServiceError('invalid_target', 'The public hostname did not resolve to an address.', 400)
  }

  if (addresses.some(({ address }) => !isPublicNetworkAddress(address))) {
    throw new WrapperServiceError('invalid_target', 'The hostname resolves to a private, local, or reserved address.', 400)
  }

  const pinnedAddress = addresses.find(({ family }) => family === 4)?.address
    ?? addresses[0].address

  return { url, origin: parsedUrl.origin, hostname, pinnedAddress, addresses }
}
