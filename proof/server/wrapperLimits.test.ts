import { describe, expect, it } from 'vitest'
import { estimateWrapperCost, WRAPPER_MEMORY_MB, WRAPPER_VCPUS } from './wrapperLimits.ts'

describe('wrapper cost and resource limits', () => {
  it('keeps the configured sandbox at 2 vCPU and 4 GB', () => {
    expect(WRAPPER_VCPUS).toBe(2)
    expect(WRAPPER_MEMORY_MB).toBe(4096)
  })

  it('returns an illustrative range that grows with runtime and measured usage', () => {
    const short = estimateWrapperCost({ runtimeMs: 10_000, activeCpuMs: 1_000, ingressBytes: 1_000 })
    const long = estimateWrapperCost({ runtimeMs: 120_000, activeCpuMs: 30_000, ingressBytes: 20_000_000 })
    expect(short.basis).toBe('illustrative-list-price')
    expect(short.lowerBound).toBeLessThanOrEqual(short.upperBound)
    expect(long.lowerBound).toBeGreaterThan(short.lowerBound)
    expect(long.upperBound).toBeGreaterThan(short.upperBound)
  })
})

