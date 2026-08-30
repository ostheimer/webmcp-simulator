import type {
  WrapperCapability,
  WrapperDomEvidence,
  WrapperInteractionKind,
} from '../../src/features/wrapper/types.ts'

const SEARCH_HINT = /\b(search|find|query|suche|suchen)\b/i
const FILTER_HINT = /\b(filter|category|sort|type|status|kategorie|filtern|sortieren)\b/i
const UNSAFE_HINT = /\b(account|address|book|buy|card|checkout|comment|contact|delete|email|login|message|order|password|pay|phone|publish|register|remove|secrets?|security|send|signin|signup|ssn|subscribe|tokens?|upload|username|konto|adresse|buchen|kaufen|karte|kommentar|kontakt|löschen|nachricht|passwort|telefon|veröffentlichen|zahlen)\b/i

export const DATE_LIKE_FIELD_SPECS = {
  date: {},
  month: {},
  time: {},
  week: {},
} as const

export interface DetectedControl extends WrapperDomEvidence {
  backendNodeId: number
  fieldKey?: string
  formId?: string
  optionValues?: string[]
  optionIndices?: number[]
  selectSampleIndex?: number
  minimum?: number
  maximum?: number
  numericStep?: number
  numericStepBase?: number
  numericValues?: number[]
  numericSample?: number
  numericCurrent?: number
  numericUnsupported?: boolean
  dateLikeValues?: string[]
  dateLikeSample?: string
  checked?: boolean
  required?: boolean
  textMinLength?: number
  textMaxLength?: number
  textSample?: string
  textUnsupported?: boolean
  radioGroupSize?: number
  radioGroupComplete?: boolean
  safetySnapshot: string
}

export interface ActionField {
  key: string
  backendNodeId: number
  type: string
  backendNodeIds?: number[]
  optionIndices?: number[]
  selectSampleIndex?: number
  minimum?: number
  maximum?: number
  numericStep?: number
  numericStepBase?: number
  numericValues?: number[]
  numericSample?: number
  dateLikeValues?: string[]
  dateLikeSample?: string
  checked?: boolean
  required?: boolean
  textMinLength?: number
  textMaxLength?: number
  textSample?: string
  radioSampleIndex?: number
  radioGroupSize?: number
  safetySnapshot: string
  safetySnapshots?: string[]
}

export interface CapabilityAction {
  kind: WrapperInteractionKind
  backendNodeId?: number
  backendNodeIds?: number[]
  controlType?: string
  urls?: string[]
  optionValues?: string[]
  optionIndices?: number[]
  fields?: ActionField[]
  textMinLength?: number
  textMaxLength?: number
  safetySnapshot?: string
  safetySnapshots?: string[]
}

export interface InferredCapability extends WrapperCapability {
  action: CapabilityAction
}

function isSearch(control: DetectedControl): boolean {
  return control.tag === 'input'
    && !control.sensitive
    && Boolean(control.textSample)
    && (control.type === 'search' || control.role === 'searchbox' || SEARCH_HINT.test(control.label))
}

function isFilter(control: DetectedControl): boolean {
  return control.tag === 'select'
    && control.type === 'select-one'
    && !control.sensitive
    && (control.optionValues?.length ?? 0) >= 2
    && control.selectSampleIndex !== undefined
    && FILTER_HINT.test(control.label)
}

function schemaForField(control: DetectedControl): Record<string, unknown> {
  if (control.tag === 'select') {
    return {
      type: 'integer',
      minimum: 0,
      maximum: Math.max(0, (control.optionValues?.length ?? 1) - 1),
      description: 'Zero-based option index from the visible select control.',
    }
  }
  if (['number', 'range'].includes(control.type)) {
    return {
      type: 'number',
      ...(control.minimum === undefined ? {} : { minimum: control.minimum }),
      ...(control.maximum === undefined ? {} : { maximum: control.maximum }),
      ...(control.numericValues
        ? { enum: control.numericValues }
        : control.numericStep === undefined
          ? {}
          : { multipleOf: control.numericStep }),
      description: 'Value for the visible numeric control.',
    }
  }
  if (['checkbox', 'radio'].includes(control.type)) {
    return {
      type: 'boolean',
      ...(control.type === 'checkbox' && control.required ? { const: true } : {}),
      description: 'Checked state for the visible control.',
    }
  }
  const dateLikeSpec = DATE_LIKE_FIELD_SPECS[control.type as keyof typeof DATE_LIKE_FIELD_SPECS]
  if (dateLikeSpec) {
    return {
      type: 'string',
      enum: control.dateLikeValues,
      description: `Value for the visible ${control.type} control.`,
    }
  }
  return {
    type: 'string',
    ...(control.textMinLength ? { minLength: control.textMinLength } : {}),
    maxLength: Math.min(200, control.textMaxLength ?? 200),
    description: 'Value for the visible, non-sensitive control.',
  }
}

interface SafeFormField {
  control: DetectedControl
  radioGroup?: DetectedControl[]
  radioSampleIndex?: number
}

function schemaForSafeFormField(field: SafeFormField): Record<string, unknown> {
  if (field.radioGroup) {
    return {
      type: 'integer',
      minimum: 0,
      maximum: field.radioGroup.length - 1,
      description: 'Zero-based choice index from one visible radio group.',
    }
  }
  return schemaForField(field.control)
}

function sampleForActionField(field: ActionField): unknown {
  if (field.type === 'radio-group') return field.radioSampleIndex
  if (field.type === 'select-one') {
    return field.selectSampleIndex
  }
  if (field.type === 'number' || field.type === 'range') {
    return field.numericSample ?? 1
  }
  if (field.type === 'checkbox') return field.required ? true : !field.checked
  if (field.type === 'radio') return true
  if (Object.hasOwn(DATE_LIKE_FIELD_SPECS, field.type)) return field.dateLikeSample
  return field.textSample
}

export function inferSafeCapabilities(controls: DetectedControl[]): InferredCapability[] {
  const capabilities: InferredCapability[] = []
  const claimed = new Set<string>()

  const search = controls.find(isSearch)
  if (search) {
    claimed.add(search.id)
    capabilities.push({
      id: 'detected-search',
      name: 'prepare_page_search',
      title: 'Prepare a page search',
      description: 'Populate the detected search control for review without claiming that results were loaded.',
      kind: 'prepare_search',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            minLength: Math.max(1, search.textMinLength ?? 0),
            maxLength: Math.min(80, search.textMaxLength ?? 80),
            pattern: '\\S',
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
      evidenceIds: [search.id],
      sampleInput: { query: search.textSample },
      action: {
        kind: 'prepare_search',
        backendNodeId: search.backendNodeId,
        controlType: search.type,
        textMinLength: Math.max(1, search.textMinLength ?? 0),
        textMaxLength: Math.min(80, search.textMaxLength ?? 80),
        safetySnapshot: search.safetySnapshot,
      },
    })
  }

  const filters = controls.filter(isFilter).slice(0, 2)
  filters.forEach((control, index) => {
    claimed.add(control.id)
    const optionCount = control.optionValues?.length ?? 0
    capabilities.push({
      id: `detected-filter-${index + 1}`,
      name: index === 0 ? 'set_page_filter' : `set_page_filter_${index + 1}`,
      title: 'Set a visible page filter',
      description: 'Select an option by index in an isolated page without submitting a form.',
      kind: 'filter',
      inputSchema: {
        type: 'object',
        properties: {
          optionIndex: {
            type: 'integer',
            minimum: 0,
            maximum: optionCount - 1,
          },
        },
        required: ['optionIndex'],
        additionalProperties: false,
      },
      evidenceIds: [control.id],
      sampleInput: { optionIndex: control.selectSampleIndex },
      action: {
        kind: 'filter',
        backendNodeId: control.backendNodeId,
        controlType: control.type,
        optionValues: control.optionValues,
        optionIndices: control.optionIndices
          ?? control.optionValues?.map((_value, optionIndex) => optionIndex),
        safetySnapshot: control.safetySnapshot,
      },
    })
  })

  const links = controls
    .filter((control) => control.tag === 'a' && !control.sensitive && control.optionValues?.length === 1)
    .slice(0, 8)
  if (links.length > 0) {
    capabilities.push({
      id: 'detected-navigation',
      name: 'open_page_link',
      title: 'Open a visible page link',
      description: 'Open a detected same-origin link by index in the isolated browser session.',
      kind: 'navigation',
      inputSchema: {
        type: 'object',
        properties: {
          linkIndex: {
            type: 'integer',
            minimum: 0,
            maximum: links.length - 1,
          },
        },
        required: ['linkIndex'],
        additionalProperties: false,
      },
      evidenceIds: links.map(({ id }) => id),
      sampleInput: { linkIndex: 0 },
      action: {
        kind: 'navigation',
        backendNodeIds: links.map(({ backendNodeId }) => backendNodeId),
        urls: links.map(({ optionValues }) => optionValues?.[0] as string),
        safetySnapshots: links.map(({ safetySnapshot }) => safetySnapshot),
      },
    })
  }

  const formGroups = new Map<string, DetectedControl[]>()
  controls
    .filter((control) => control.formId && !claimed.has(control.id))
    .forEach((control) => {
      const formId = control.formId as string
      formGroups.set(formId, [...(formGroups.get(formId) ?? []), control])
    })
  let formIndex = 0
  for (const group of formGroups.values()) {
    const safeControls = group.filter((control) =>
      !control.sensitive
      && !control.numericUnsupported
      && !control.textUnsupported
      && !(control.type === 'checkbox' && control.required && control.checked)
      && (control.type !== 'select-one' || control.selectSampleIndex !== undefined)
      && (!Object.hasOwn(DATE_LIKE_FIELD_SPECS, control.type)
        || (Boolean(control.dateLikeValues?.length) && control.dateLikeSample !== undefined))
      && !UNSAFE_HINT.test(control.label)
      && ['checkbox', 'date', 'month', 'number', 'radio', 'range', 'select-one', 'text', 'textarea', 'time', 'week'].includes(control.type),
    )
    const radioGroups = new Map<string, DetectedControl[]>()
    safeControls
      .filter((control) => control.type === 'radio')
      .forEach((control) => {
        const key = control.fieldKey || control.id
        radioGroups.set(key, [...(radioGroups.get(key) ?? []), control])
      })
    const claimedRadioGroups = new Set<string>()
    const safeFields: SafeFormField[] = []
    for (const control of safeControls) {
      const radioGroupKey = control.type === 'radio' ? control.fieldKey || control.id : undefined
      const radioGroup = radioGroupKey
        ? radioGroups.get(radioGroupKey)
        : undefined
      if (radioGroup) {
        if (claimedRadioGroups.has(radioGroupKey as string)) continue
        claimedRadioGroups.add(radioGroupKey as string)
        if (
          !radioGroup.every(({ radioGroupComplete }) => radioGroupComplete)
          || radioGroup.some(({ radioGroupSize }) => radioGroupSize !== radioGroup.length)
        ) continue
        const checkedIndex = radioGroup.findIndex(({ checked }) => checked)
        const radioSampleIndex = radioGroup.findIndex((_choice, choiceIndex) => choiceIndex !== checkedIndex)
        if (radioSampleIndex < 0) continue
        safeFields.push({ control, radioGroup, radioSampleIndex })
      } else {
        safeFields.push({ control })
      }
      if (safeFields.length >= 6) break
    }
    if (safeFields.length < 2) continue

    formIndex += 1
    const properties: Record<string, Record<string, unknown>> = Object.create(null)
    const fields: ActionField[] = []
    safeFields.forEach((field, index) => {
      // Remote names and ids are server-only evidence. Agent-facing
      // schemas use wrapper-owned neutral keys exclusively.
      const key = `field_${index + 1}`
      properties[key] = schemaForSafeFormField(field)
      const { control, radioGroup, radioSampleIndex } = field
      fields.push({
        key,
        backendNodeId: control.backendNodeId,
        type: radioGroup ? 'radio-group' : control.type,
        backendNodeIds: radioGroup?.map(({ backendNodeId }) => backendNodeId),
        optionIndices: control.optionIndices
          ?? control.optionValues?.map((_value, optionIndex) => optionIndex),
        selectSampleIndex: control.selectSampleIndex,
        minimum: control.minimum,
        maximum: control.maximum,
        numericStep: control.numericStep,
        numericStepBase: control.numericStepBase,
        numericValues: control.numericValues,
        numericSample: control.numericSample,
        dateLikeValues: control.dateLikeValues,
        dateLikeSample: control.dateLikeSample,
        checked: control.checked,
        required: control.required,
        textMinLength: control.textMinLength,
        textMaxLength: control.textMaxLength,
        textSample: control.textSample,
        radioSampleIndex,
        radioGroupSize: radioGroup?.length,
        safetySnapshot: control.safetySnapshot,
        safetySnapshots: radioGroup?.map(({ safetySnapshot }) => safetySnapshot),
      })
    })

    capabilities.push({
      id: `detected-form-${formIndex}`,
      name: formIndex === 1 ? 'prepare_visible_form' : `prepare_visible_form_${formIndex}`,
      title: 'Prepare safe form fields',
      description: 'Populate only detected non-sensitive fields for human review. Never submits.',
      kind: 'prepare_form',
      inputSchema: {
        type: 'object',
        properties,
        minProperties: 1,
        additionalProperties: false,
      },
      evidenceIds: safeFields.flatMap(({ control, radioGroup }) =>
        (radioGroup ?? [control]).map(({ id }) => id)),
      sampleInput: Object.fromEntries(fields.slice(0, 2).map((field) => [field.key, sampleForActionField(field)])),
      action: { kind: 'prepare_form', fields },
    })
  }

  return capabilities
}

export function publicCapability(capability: InferredCapability): WrapperCapability {
  const { action: _action, ...publicFields } = capability
  return publicFields
}
