export const WRAPPER_SESSION_TTL_MS = 5 * 60 * 1000
export const WRAPPER_MAX_PAGES = 10
export const WRAPPER_VCPUS = 2
export const WRAPPER_MEMORY_MB = WRAPPER_VCPUS * 2048
export const WRAPPER_MAX_REQUEST_BODY_BYTES = 32 * 1024
export const WRAPPER_MAX_RESPONSE_BYTES = 2 * 1024 * 1024
export const WRAPPER_MAX_SCREENSHOT_BYTES = 900 * 1024
// Untrusted target traffic is bounded independently from API and screenshot payloads.
// The per-resource limit catches single large responses; the session limit covers
// the initial page plus every explicit same-origin navigation in the five-minute session.
export const WRAPPER_MAX_TARGET_RESOURCE_BYTES = 4 * 1024 * 1024
export const WRAPPER_MAX_TARGET_SESSION_BYTES = 20 * 1024 * 1024
export const WRAPPER_MAX_DOM_EVIDENCE = 80
// DOM classification never materializes an unbounded selector result. It examines
// at most this many elements and retains at most WRAPPER_MAX_DOM_EVIDENCE controls.
export const WRAPPER_MAX_DOM_ELEMENTS_INSPECTED = 5_000
// Date-like controls are exposed only when Chromium can enumerate their complete
// native min/max/step value set within this limit.
export const WRAPPER_MAX_DATE_LIKE_VALUES = 200
export const WRAPPER_MAX_SELECT_OPTIONS_INSPECTED = 200
export const WRAPPER_MAX_AX_EVIDENCE = 40
export const WRAPPER_MAX_RATE_IDENTITIES_PER_FUNCTION = 512
export const WRAPPER_ANALYSIS_TIMEOUT_MS = 35_000
export const WRAPPER_ACTION_TIMEOUT_MS = 15_000
// Leave platform time for a sanitized response and cleanup inside the 15 s
// session Function limit.
export const WRAPPER_CLOSE_TIMEOUT_MS = 10_000

const ACTIVE_CPU_USD_PER_VCPU_HOUR = 0.128
const MEMORY_USD_PER_GB_HOUR = 0.0212
const NETWORK_USD_PER_GB = 0.15

export interface WrapperCostEstimate {
  currency: 'USD'
  lowerBound: number
  upperBound: number
  basis: 'illustrative-list-price'
}

export interface WrapperRuntimeUsage {
  runtimeMs: number
  activeCpuMs?: number
  ingressBytes?: number
  egressBytes?: number
}

export function estimateWrapperCost(usage: WrapperRuntimeUsage): WrapperCostEstimate {
  const hours = Math.max(0, usage.runtimeMs) / 3_600_000
  const activeCpuHours = Math.max(0, usage.activeCpuMs ?? usage.runtimeMs * 0.1) / 3_600_000
  const networkGb = Math.max(0, (usage.ingressBytes ?? 0) + (usage.egressBytes ?? 0)) / 1_000_000_000
  const memoryCost = (WRAPPER_MEMORY_MB / 1024) * hours * MEMORY_USD_PER_GB_HOUR
  const networkCost = networkGb * NETWORK_USD_PER_GB
  const lower = memoryCost + networkCost + (activeCpuHours * ACTIVE_CPU_USD_PER_VCPU_HOUR)
  const upperCpuHours = Math.max(activeCpuHours, hours * WRAPPER_VCPUS)
  const upper = memoryCost + networkCost + (upperCpuHours * ACTIVE_CPU_USD_PER_VCPU_HOUR)

  return {
    currency: 'USD',
    lowerBound: Number(lower.toFixed(4)),
    upperBound: Number(Math.max(lower, upper).toFixed(4)),
    basis: 'illustrative-list-price',
  }
}
