import { randomBytes } from 'node:crypto'

const SANDBOX_NAME_PREFIX = 'webmcp-wrapper-'

export function createSessionCapability(): string {
  return randomBytes(32).toString('base64url')
}

export function createSandboxLocator(): string {
  return `${SANDBOX_NAME_PREFIX}${randomBytes(18).toString('base64url').toLowerCase()}`
}

export function isSandboxLocator(value: string): boolean {
  return new RegExp(`^${SANDBOX_NAME_PREFIX}[a-z0-9_-]{24}$`).test(value)
}

export function isSessionCapability(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value)
}

