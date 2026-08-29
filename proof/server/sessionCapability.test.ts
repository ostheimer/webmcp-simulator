import { describe, expect, it } from 'vitest'
import {
  createSandboxLocator,
  createSessionCapability,
  isSandboxLocator,
  isSessionCapability,
} from './sessionCapability.ts'

describe('session capability generation', () => {
  it('creates independent high-entropy locator and authorization values', () => {
    const locator = createSandboxLocator()
    const capability = createSessionCapability()
    expect(isSandboxLocator(locator)).toBe(true)
    expect(isSessionCapability(capability)).toBe(true)
    expect(locator).not.toContain(capability)
    expect(createSandboxLocator()).not.toBe(locator)
    expect(createSessionCapability()).not.toBe(capability)
  })
})

