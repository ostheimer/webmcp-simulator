import { heatFlowServices } from '../demo/heatflow/data'
import type { QuoteDraft, ServiceAreaResult } from '../features/simulation/simulationModel'
import { checkServiceArea, searchServices } from '../features/simulation/simulationModel'
import type { WebMcpTool } from './registerTools'

interface HeatFlowToolHandlers {
  search: (query: string, serviceIds: string[]) => Promise<void>
  checkArea: (result: ServiceAreaResult) => Promise<void>
  compare: (serviceIds: string[]) => Promise<void>
  prepareQuote: (quote: QuoteDraft) => Promise<void>
  reset: () => Promise<void>
}

const serviceValues = heatFlowServices.map((service) => service.toolValue)
const serviceIds = heatFlowServices.map((service) => service.id)
const fallbackExecutionSignal = new AbortController().signal

function executionSignal(options?: { signal: AbortSignal }): AbortSignal {
  return options?.signal ?? fallbackExecutionSignal
}

function readString(
  input: Record<string, unknown>,
  key: string,
  options: { required?: boolean; maxLength?: number } = {},
): string {
  const value = input[key]
  if (value === undefined && !options.required) return ''
  if (typeof value !== 'string' || (options.required && !value.trim())) {
    throw new Error(`${key} must be a non-empty string.`)
  }
  if (options.maxLength && Array.from(value).length > options.maxLength) {
    throw new Error(`${key} must be at most ${options.maxLength} characters.`)
  }
  return value.trim()
}

function readPostcode(input: Record<string, unknown>): string {
  const postcode = readString(input, 'postcode', { required: true })
  if (!/^\d{4}$/.test(postcode)) {
    throw new Error('postcode must contain exactly four digits.')
  }
  return postcode
}

function readService(input: Record<string, unknown>): string {
  const service = readString(input, 'service', { required: true })
  if (!serviceValues.includes(service)) {
    throw new Error(`service must be one of: ${serviceValues.join(', ')}.`)
  }
  return service
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
}

export function createHeatFlowTools(
  handlers: HeatFlowToolHandlers,
): WebMcpTool[] {
  return [
    {
      name: 'search_services',
      title: 'Search HeatFlow services',
      description:
        'Search the simulated HeatFlow catalog and focus matching services in the visible interface.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            maxLength: 80,
            description: 'Heating service or technology to search for.',
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false },
      execute: async (input, options) => {
        const query = readString(input, 'query', { required: true, maxLength: 80 })
        const signal = executionSignal(options)
        throwIfAborted(signal)
        const matches = searchServices(query)
        await handlers.search(query, matches)
        return { query, visibleServiceIds: matches, count: matches.length }
      },
    },
    {
      name: 'check_service_area',
      title: 'Check HeatFlow service area',
      description:
        'Check deterministic service availability for a four-digit Austrian postcode and show the result.',
      inputSchema: {
        type: 'object',
        properties: {
          postcode: {
            type: 'string',
            pattern: '^\\d{4}$',
            description: 'Four-digit Austrian postcode.',
          },
          service: { type: 'string', enum: serviceValues },
        },
        required: ['postcode', 'service'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false },
      execute: async (input, options) => {
        const postcode = readPostcode(input)
        const service = readService(input)
        const signal = executionSignal(options)
        throwIfAborted(signal)
        const result = checkServiceArea(postcode, service)
        await handlers.checkArea(result)
        return result
      },
    },
    {
      name: 'compare_services',
      title: 'Compare HeatFlow services',
      description:
        'Open a visible comparison for two or three supported HeatFlow service IDs.',
      inputSchema: {
        type: 'object',
        properties: {
          serviceIds: {
            type: 'array',
            items: { type: 'string', enum: serviceIds },
            minItems: 2,
            maxItems: 3,
            uniqueItems: true,
          },
        },
        required: ['serviceIds'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false },
      execute: async (input, options) => {
        const values = input.serviceIds
        if (!Array.isArray(values) || values.length < 2 || values.length > 3) {
          throw new Error('serviceIds must contain two or three service IDs.')
        }
        if (!values.every((value): value is string => typeof value === 'string')) {
          throw new Error('Every service ID must be a string.')
        }
        const unique = [...new Set(values)]
        if (unique.length !== values.length || unique.some((value) => !serviceIds.includes(value))) {
          throw new Error('Use unique service IDs from the HeatFlow catalog.')
        }
        throwIfAborted(executionSignal(options))
        await handlers.compare(unique)
        return { comparedServiceIds: unique, count: unique.length }
      },
    },
    {
      name: 'prepare_quote_request',
      title: 'Prepare HeatFlow quote request',
      description:
        'Populate an editable quote draft for human review. This tool never submits or sends the request.',
      inputSchema: {
        type: 'object',
        properties: {
          service: { type: 'string', enum: serviceValues },
          postcode: { type: 'string', pattern: '^\\d{4}$' },
          propertySize: { type: 'integer', minimum: 30, maximum: 1000 },
          message: { type: 'string', maxLength: 500 },
        },
        required: ['service', 'postcode', 'propertySize'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false },
      execute: async (input, options) => {
        const service = readService(input)
        const postcode = readPostcode(input)
        const propertySize = input.propertySize
        if (
          typeof propertySize !== 'number' ||
          !Number.isInteger(propertySize) ||
          propertySize < 30 ||
          propertySize > 1000
        ) {
          throw new Error('propertySize must be a whole number between 30 and 1000.')
        }
        const message = readString(input, 'message', { maxLength: 500 })
        throwIfAborted(executionSignal(options))
        const quote = {
          service,
          postcode,
          propertySize: String(propertySize),
          message,
        }
        await handlers.prepareQuote(quote)
        return {
          prepared: true,
          submitted: false,
          draft: quote,
          instruction: 'Review the visible form before taking any further action.',
        }
      },
    },
    {
      name: 'reset_simulation',
      title: 'Reset HeatFlow simulation',
      description: 'Restore the local HeatFlow simulation to its initial state.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: false },
      execute: async (_input, options) => {
        throwIfAborted(executionSignal(options))
        await handlers.reset()
        return { reset: true }
      },
    },
  ]
}
