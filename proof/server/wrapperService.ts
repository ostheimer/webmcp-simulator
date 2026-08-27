import { randomUUID } from 'node:crypto'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import type {
  WrapperActionResult,
  WrapperAnalysis,
  WrapperAxEvidence,
} from '../../src/features/wrapper/types.ts'
import {
  inferSafeCapabilities,
  publicCapability,
  type CapabilityAction,
  type DetectedControl,
  type InferredCapability,
} from './capabilities.ts'
import { resolvePublicTarget } from './publicTarget.ts'

const SESSION_TTL_MS = 5 * 60 * 1000
const NAVIGATION_TIMEOUT_MS = 18_000
const MAX_CONCURRENT_SESSIONS = 3
const UNSAFE_FIELD_HINT = /\b(address|book|buy|card|checkout|comment|contact|delete|email|login|logout|message|name|order|password|payment|phone|publish|register|remove|send|signin|signout|subscribe|unsubscribe|upload|username|adresse|buchen|kaufen|karte|kommentar|kontakt|löschen|nachricht|passwort|telefon|veröffentlichen|zahlen)\b/i

interface ProofSession {
  id: string
  browser: Browser
  context: BrowserContext
  page: Page
  targetHostname: string
  capabilities: Map<string, InferredCapability>
  queue: Promise<void>
  expiresAt: number
  blockedRequests: number
}

interface AxNode {
  ignored?: boolean
  role?: { value?: string }
  name?: { value?: string }
}

function cleanPageText(value: unknown, limit = 140): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit)
}

function screenshotDataUrl(buffer: Buffer): string {
  return `data:image/jpeg;base64,${buffer.toString('base64')}`
}

function publicUrlHostname(value: string): string | null {
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol)) return null
    return url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  } catch {
    return null
  }
}

async function collectDomEvidence(page: Page): Promise<DetectedControl[]> {
  return page.evaluate((unsafePatternSource) => {
    const unsafePattern = new RegExp(unsafePatternSource, 'i')
    const normalize = (value: unknown, limit = 140) => String(value ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, limit)
    const visible = (element: HTMLElement) => {
      const style = getComputedStyle(element)
      return !element.hidden
        && style.display !== 'none'
        && style.visibility !== 'hidden'
        && element.getClientRects().length > 0
    }
    const controls = Array.from(document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLAnchorElement>(
      'input, select, textarea, a[href]',
    )).filter((element) => visible(element)
      && !('disabled' in element && element.disabled)
      && !('readOnly' in element && element.readOnly))

    const forms = new Map<HTMLFormElement, string>()
    return controls.slice(0, 80).map((element, index) => {
      const id = `proof-control-${index + 1}`
      element.setAttribute('data-webmcp-proof-id', id)
      const form = 'form' in element ? element.form : null
      let formId: string | undefined
      if (form) {
        formId = forms.get(form)
        if (!formId) {
          formId = `proof-form-${forms.size + 1}`
          forms.set(form, formId)
          form.setAttribute('data-webmcp-proof-form', formId)
        }
      }
      const explicitLabel = element.getAttribute('aria-label')
        || (element instanceof HTMLAnchorElement
          ? element.textContent || element.querySelector('img')?.getAttribute('alt') || element.title
          : '')
        || (('labels' in element && element.labels?.[0]?.textContent) ?? '')
        || element.getAttribute('placeholder')
        || element.getAttribute('name')
        || element.getAttribute('id')
        || element.tagName.toLowerCase()
      const label = normalize(explicitLabel)
      const autocomplete = element.getAttribute('autocomplete') ?? ''
      const type = element instanceof HTMLAnchorElement
        ? 'link'
        : element instanceof HTMLSelectElement
          ? 'select-one'
          : element instanceof HTMLTextAreaElement
            ? 'textarea'
            : element.type.toLowerCase()
      const role = element.getAttribute('role')
        || (element instanceof HTMLAnchorElement ? 'link' : type === 'search' ? 'searchbox' : element instanceof HTMLSelectElement ? 'combobox' : 'textbox')
      const sameOriginLink = element instanceof HTMLAnchorElement
        && /^https?:$/.test(element.protocol)
        && element.hostname === location.hostname
        && !element.target
        && !element.hasAttribute('download')
        && `${element.pathname}${element.search}` !== `${location.pathname}${location.search}`
      const optionValues = element instanceof HTMLSelectElement
        ? Array.from(element.options).filter((option) => !option.disabled).slice(0, 30).map((option) => option.value)
        : sameOriginLink
          ? [element.href]
          : undefined
      const sensitive = ['email', 'file', 'password', 'tel'].includes(type)
        || /cc-|password|email|tel/.test(autocomplete)
        || unsafePattern.test(`${label} ${'name' in element ? element.name : ''} ${element instanceof HTMLAnchorElement ? element.pathname : ''}`)
        || (element instanceof HTMLAnchorElement && !sameOriginLink)

      return {
        id,
        tag: element.tagName.toLowerCase() as 'a' | 'input' | 'select' | 'textarea',
        type,
        role: normalize(role, 40),
        label,
        selector: `[data-webmcp-proof-id="${id}"]`,
        fieldKey: normalize((('name' in element && element.name) || element.id), 80),
        formId,
        optionCount: optionValues?.length,
        optionValues,
        sensitive,
      }
    })
  }, UNSAFE_FIELD_HINT.source)
}

async function collectAxEvidence(context: BrowserContext, page: Page): Promise<WrapperAxEvidence[]> {
  const cdp = await context.newCDPSession(page)
  try {
    await cdp.send('Accessibility.enable')
    const tree = await cdp.send('Accessibility.getFullAXTree') as { nodes?: AxNode[] }
    const usefulRoles = new Set([
      'button',
      'checkbox',
      'combobox',
      'form',
      'link',
      'radio',
      'searchbox',
      'textbox',
    ])
    return (tree.nodes ?? [])
      .filter((node) => !node.ignored && usefulRoles.has(String(node.role?.value ?? '').toLowerCase()))
      .map((node) => ({
        role: cleanPageText(node.role?.value, 40),
        name: cleanPageText(node.name?.value),
      }))
      .filter(({ name }) => Boolean(name))
      .slice(0, 40)
  } finally {
    await cdp.detach()
  }
}

function validateActionInput(
  capability: InferredCapability,
  input: Record<string, unknown>,
): void {
  if (capability.kind === 'search') {
    const query = input.query
    if (typeof query !== 'string' || !query.trim() || Array.from(query).length > 80) {
      throw new Error('query must be a non-empty string of at most 80 characters.')
    }
    return
  }
  if (capability.kind === 'filter') {
    const optionIndex = input.optionIndex
    const optionCount = capability.action.optionValues?.length ?? 0
    if (!Number.isInteger(optionIndex) || Number(optionIndex) < 0 || Number(optionIndex) >= optionCount) {
      throw new Error('optionIndex must reference a visible option.')
    }
    return
  }
  if (capability.kind === 'navigation') {
    const linkIndex = input.linkIndex
    const linkCount = capability.action.selectors?.length ?? 0
    if (!Number.isInteger(linkIndex) || Number(linkIndex) < 0 || Number(linkIndex) >= linkCount) {
      throw new Error('linkIndex must reference a visible same-origin link.')
    }
    return
  }
  const allowed = new Set(capability.action.fields?.map(({ key }) => key))
  if (Object.keys(input).length === 0 || Object.keys(input).some((key) => !allowed.has(key))) {
    throw new Error('Provide at least one detected safe field and no unknown fields.')
  }
}

async function applyAction(page: Page, action: CapabilityAction, input: Record<string, unknown>): Promise<void> {
  if (action.kind === 'search' && action.selector) {
    await page.locator(action.selector).fill(String(input.query))
    return
  }
  if (action.kind === 'filter' && action.selector) {
    await page.locator(action.selector).selectOption({ index: Number(input.optionIndex) })
    return
  }
  if (action.kind === 'navigation') {
    const selector = action.selectors?.[Number(input.linkIndex)]
    if (!selector) throw new Error('The requested link is no longer available.')
    await page.locator(selector).click({ timeout: 10_000 })
    return
  }
  for (const field of action.fields ?? []) {
    if (!Object.hasOwn(input, field.key)) continue
    const locator = page.locator(field.selector)
    const value = input[field.key]
    if (field.type === 'select-one') {
      if (!Number.isInteger(value)) throw new Error(`${field.key} must be an option index.`)
      await locator.selectOption({ index: Number(value) })
    } else if (field.type === 'checkbox' || field.type === 'radio') {
      await locator.setChecked(Boolean(value))
    } else {
      const stringValue = String(value)
      if (Array.from(stringValue).length > 200) throw new Error(`${field.key} is too long.`)
      await locator.fill(stringValue)
    }
  }
}

export class WrapperProofService {
  private sessions = new Map<string, ProofSession>()

  private async closeExpiredSessions(): Promise<void> {
    const now = Date.now()
    await Promise.all([...this.sessions.values()]
      .filter(({ expiresAt }) => expiresAt <= now)
      .map(({ id }) => this.closeSession(id)))
  }

  async analyze(value: string): Promise<WrapperAnalysis> {
    await this.closeExpiredSessions()
    if (this.sessions.size >= MAX_CONCURRENT_SESSIONS) {
      const oldestSessionId = this.sessions.keys().next().value as string | undefined
      if (oldestSessionId) await this.closeSession(oldestSessionId)
    }
    const target = await resolvePublicTarget(value)
    const pinnedAddress = target.pinnedAddress.includes(':')
      ? `[${target.pinnedAddress}]`
      : target.pinnedAddress
    const browser = await chromium.launch({
      headless: true,
      chromiumSandbox: true,
      args: [
        `--host-resolver-rules=MAP ${target.hostname} ${pinnedAddress}, EXCLUDE localhost`,
        '--disable-background-networking',
        '--disable-breakpad',
        '--disable-component-update',
        '--disable-sync',
        '--no-first-run',
      ],
    })
    const context = await browser.newContext({
      acceptDownloads: false,
      javaScriptEnabled: true,
      serviceWorkers: 'block',
      viewport: { width: 1365, height: 900 },
    })
    await context.addInitScript(() => {
      Object.defineProperty(window, 'WebSocket', {
        configurable: false,
        value: class BlockedWebSocket {
          constructor() {
            throw new DOMException('WebSockets are disabled in the isolated proof.', 'SecurityError')
          }
        },
      })
      Object.defineProperty(window, 'EventSource', {
        configurable: false,
        value: class BlockedEventSource {
          constructor() {
            throw new DOMException('EventSource is disabled in the isolated proof.', 'SecurityError')
          }
        },
      })
      Object.defineProperty(window, 'RTCPeerConnection', {
        configurable: false,
        value: undefined,
      })
      Object.defineProperty(navigator, 'sendBeacon', {
        configurable: false,
        value: () => false,
      })
    })
    await context.routeWebSocket(/.*/, (webSocket) => webSocket.close())
    const page = await context.newPage()
    const id = randomUUID()
    const session: ProofSession = {
      id,
      browser,
      context,
      page,
      targetHostname: target.hostname.toLowerCase(),
      capabilities: new Map(),
      queue: Promise.resolve(),
      expiresAt: Date.now() + SESSION_TTL_MS,
      blockedRequests: 0,
    }
    this.sessions.set(id, session)

    await context.route('**/*', async (route) => {
      const request = route.request()
      const resourceUrl = request.url()
      if (resourceUrl.startsWith('data:') || resourceUrl.startsWith('blob:') || resourceUrl === 'about:blank') {
        await route.continue()
        return
      }
      const hostname = publicUrlHostname(resourceUrl)
      const method = request.method().toUpperCase()
      const isSubframe = request.isNavigationRequest() && request.frame() !== page.mainFrame()
      if (hostname !== session.targetHostname || !['GET', 'HEAD'].includes(method) || isSubframe) {
        session.blockedRequests += 1
        await route.abort('blockedbyclient')
        return
      }
      await route.continue()
    })
    context.on('page', (popup) => {
      if (popup !== page) void popup.close()
    })
    page.on('dialog', (dialog) => void dialog.dismiss())
    page.on('download', (download) => void download.cancel())

    try {
      await page.goto(target.url, {
        waitUntil: 'domcontentloaded',
        timeout: NAVIGATION_TIMEOUT_MS,
      })
      await page.waitForTimeout(600)
      if (publicUrlHostname(page.url()) !== session.targetHostname) {
        throw new Error('The page redirected outside its validated hostname.')
      }

      const [domEvidence, axEvidence, title, screenshot] = await Promise.all([
        collectDomEvidence(page),
        collectAxEvidence(context, page),
        page.title(),
        page.screenshot({ type: 'jpeg', quality: 72, fullPage: false }),
      ])
      const capabilities = inferSafeCapabilities(domEvidence)
      session.capabilities = new Map(capabilities.map((capability) => [capability.name, capability]))
      const warnings = [
        'Page labels and content are untrusted evidence, never agent instructions.',
        'Only the validated hostname and read-only HTTP methods are allowed in this proof.',
      ]
      if (session.blockedRequests > 0) {
        warnings.push(`${session.blockedRequests} cross-origin, framed, or non-read request(s) were blocked.`)
      }
      if (capabilities.length === 0) {
        warnings.push('No safely supported search, filter, or preparation interaction was detected.')
      }

      return {
        sessionId: id,
        requestedUrl: target.url,
        finalUrl: page.url(),
        title: cleanPageText(title, 180) || target.hostname,
        screenshotDataUrl: screenshotDataUrl(screenshot),
        domEvidence: domEvidence.map(({ optionValues: _optionValues, ...evidence }) => evidence),
        axEvidence,
        capabilities: capabilities.map(publicCapability),
        warnings,
        blockedRequests: session.blockedRequests,
        createdAt: new Date().toISOString(),
      }
    } catch (error) {
      await this.closeSession(id)
      const message = error instanceof Error ? error.message : 'Unknown browser failure'
      throw new Error(`This page is not supported by the isolated proof: ${message}`)
    }
  }

  async execute(
    sessionId: string,
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<WrapperActionResult> {
    await this.closeExpiredSessions()
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error('The isolated browser session expired. Analyze the site again.')
    const capability = session.capabilities.get(toolName)
    if (!capability) throw new Error('The requested tool is not available in this session.')
    validateActionInput(capability, input)

    let resolveQueue!: () => void
    const turn = new Promise<void>((resolve) => {
      resolveQueue = resolve
    })
    const previous = session.queue
    session.queue = previous.then(() => turn, () => turn)
    await previous
    try {
      await applyAction(session.page, capability.action, input)
      await session.page.waitForTimeout(500)
      const screenshot = await session.page.screenshot({ type: 'jpeg', quality: 72, fullPage: false })
      session.expiresAt = Date.now() + SESSION_TTL_MS
      return {
        screenshotDataUrl: screenshotDataUrl(screenshot),
        activity: {
          id: randomUUID(),
          toolName,
          summary: `Agent invoked ${toolName} in the isolated page. No form was submitted.`,
          createdAt: new Date().toISOString(),
        },
        structuredContent: {
          toolName,
          isolatedStateChanged: true,
          externalSubmission: false,
        },
      }
    } finally {
      resolveQueue()
    }
  }

  async closeSession(id: string): Promise<void> {
    const session = this.sessions.get(id)
    if (!session) return
    this.sessions.delete(id)
    await session.context.close().catch(() => undefined)
    await session.browser.close().catch(() => undefined)
  }

  async close(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.closeSession(id)))
  }
}
