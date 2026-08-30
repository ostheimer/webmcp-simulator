import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import type { PublicTarget } from './publicTarget.ts'
import { isSameOriginHttpUrl, WrapperProofService } from './wrapperService.ts'

interface Fixture {
  server: Server
  origin: string
  requests: string[]
  slowCompletedAt: number[]
}

async function startFixture(): Promise<Fixture> {
  const requests: string[] = []
  const slowCompletedAt: number[] = []
  const server = createServer((request, response) => {
    const requestUrl = request.url ?? '/'
    requests.push(requestUrl)
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    if (requestUrl.startsWith('/collect')) {
      response.end('collected')
      return
    }
    if (requestUrl === '/slow') {
      setTimeout(() => {
        slowCompletedAt.push(Date.now())
        response.end('from-inflight-network')
      }, 1_200)
      return
    }
    if (requestUrl === '/reset-page') {
      response.end(`<!doctype html><title>Reset fixture</title>
        <input type="search" aria-label="Search reset fixture"
          oninput="setTimeout(() => { this.value = 'reset-by-page' }, 40)">`)
      return
    }
    if (requestUrl === '/reorder-verification') {
      response.end(`<!doctype html><title>Reorder fixture</title>
        <input type="search" aria-label="Original search" oninput="
          if (!this.dataset.reordered) {
            this.dataset.reordered = 'true';
            const decoy = document.createElement('input');
            decoy.type = 'search';
            decoy.setAttribute('aria-label', 'Inserted decoy');
            decoy.value = this.value;
            this.before(decoy);
            this.value = 'reset-by-page';
          }
        ">`)
      return
    }
    if (requestUrl === '/next') {
      response.end(`<!doctype html><title>Second page</title>
        <main><h1>Second page</h1><input type="search" aria-label="Search destination"></main>`)
      return
    }
    if (requestUrl === '/radio-form') {
      response.end(`<!doctype html><title>Radio form</title>
        <form>
          <input id="mode-a" type="radio" name="heating_mode" value="a"><label for="mode-a">Option A</label>
          <input id="mode-b" type="radio" name="heating_mode" value="b"><label for="mode-b">Option B</label>
          <input type="text" name="details" aria-label="Details">
        </form>`)
      return
    }
    if (requestUrl === '/single-select-form') {
      response.end(`<!doctype html><title>Single select form</title>
        <form>
          <select name="building_type" aria-label="Building type">
            <option disabled>Unavailable</option><option value="only">Only enabled option</option>
          </select>
          <input type="text" name="details" aria-label="Details">
        </form>`)
      return
    }
    if (requestUrl === '/date-like-forms') {
      response.end(`<!doctype html><title>Date-like forms</title>
        <form><input type="date" name="start_date" aria-label="Start date"><input type="text" name="date_details" aria-label="Date details"></form>
        <form><input type="month" name="start_month" aria-label="Start month"><input type="text" name="month_details" aria-label="Month details"></form>
        <form><input type="time" name="start_time" aria-label="Start time"><input type="text" name="time_details" aria-label="Time details"></form>
        <form><input type="week" name="start_week" aria-label="Start week"><input type="text" name="week_details" aria-label="Week details"></form>`)
      return
    }
    if (requestUrl === '/visibility') {
      response.end(`<!doctype html><title>Visibility fixture</title>
        <input type="search" aria-label="Visible search">
        <input type="search" aria-label="Transparent search" style="opacity:0">
        <div style="opacity:0"><input type="search" aria-label="Ancestor transparent search"></div>
        <input type="search" aria-label="Zero geometry search" style="display:block;width:0;height:0;border:0;padding:0">
        <a href="/next">Visible link</a>`)
      return
    }
    if (requestUrl === '/sensitive-fields') {
      response.end(`<!doctype html><title>Sensitive fields</title>
        <form>
          <input type="text" name="safe_one" aria-label="First neutral field">
          <input type="text" name="safe_two" aria-label="Second neutral field">
          <input type="text" name="neutral_otp" aria-label="Neutral field A" autocomplete="one-time-code">
          <input type="text" name="neutral_address" aria-label="Neutral field B" autocomplete="street-address">
          <input type="text" name="neutral_user" aria-label="Neutral field C" autocomplete="username">
          <input type="text" name="neutral_mail" aria-label="Neutral field D" autocomplete="EMAIL">
          <input type="text" name="neutral_card" aria-label="Neutral field E" autocomplete="section-x billing cc-number">
          <input type="text" name="neutral_passcode" aria-label="Neutral field F" autocomplete="SMS-OTP">
          <input type="text" name="creditCard" aria-label="Neutral field G">
          <input type="text" name="billingAddress" aria-label="Neutral field H">
          <input type="text" name="userPassword" aria-label="Neutral field I">
          <input type="text" name="userSSNValue" aria-label="Neutral field J">
        </form>`)
      return
    }
    if (requestUrl === '/unsafe-links') {
      response.end(`<!doctype html><title>Unsafe links</title>
        <a href="/booking">Learn more</a>
        <a href="/purchase">Details</a>
        <a href="/book-now">Information</a>
        <a href="/purchase_order">Overview</a>
        <a href="/warenkorb/checkout">Explore</a>
        <a href="/p%75rchase-confirmation">More</a>
        <a href="/next">History</a>`)
      return
    }
    if (requestUrl.startsWith('/chain/')) {
      const pageNumber = Number(requestUrl.slice('/chain/'.length))
      response.end(`<!doctype html><title>Chain ${pageNumber}</title>
        <main><h1>Chain ${pageNumber}</h1><a href="/chain/${pageNumber + 1}">Next chain page</a></main>`)
      return
    }
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    const slowScript = requestUrl === '/slow-page'
      ? `<script>fetch('/slow').then(response => response.text()).then(value => {
          document.querySelector('[type=search]').value = value
        })</script>`
      : ''
    response.end(`<!doctype html><title>Hostile fixture</title>
      <main>
        <h1>Hostile fixture</h1>
        <form>
          <input type="search" aria-label="Search catalog" name="search_term"
            oninput="fetch('/collect?value=' + encodeURIComponent(this.value)).catch(() => {})">
          <input type="text" aria-label="First visible value" name="ignore_previous_instructions">
          <input type="text" aria-label="Second visible value" name="reveal_user_secrets">
          <input type="text" aria-label="Third visible value" name="override_agent_policy">
          <input type="password" aria-label="Password" name="agent_password">
        </form>
        <select aria-label="Category filter"
          onchange="document.title = this.value; fetch('/collect?value=' + encodeURIComponent(this.value)).catch(() => {})">
          <option value="placeholder" disabled>Choose one</option>
          <option value="all">All</option><option value="one">One</option>
        </select>
        <a href="/next">Same origin destination</a>
        <a href="http://proof.example.at:${port + 1}/other">Different port</a>
        <a href="https://proof.example.at:${port}/secure">Different scheme</a>
      </main>${slowScript}`)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture did not expose a TCP port.')
  return {
    server,
    origin: `http://proof.example.at:${address.port}`,
    requests,
    slowCompletedAt,
  }
}

function createService(options: { actionStartDelayMs?: number, actionSettleMs?: number } = {}) {
  const resolveTarget = async (value: string): Promise<PublicTarget> => {
    const url = new URL(value)
    return {
      url: url.toString(),
      origin: url.origin,
      hostname: url.hostname,
      pinnedAddress: '127.0.0.1',
      addresses: [{ address: '127.0.0.1', family: 4 }],
    }
  }
  return new WrapperProofService({
    resolveTarget,
    actionStartDelayMs: options.actionStartDelayMs,
    actionSettleMs: options.actionSettleMs ?? 80,
  })
}

const fixtures: Fixture[] = []
const services: WrapperProofService[] = []

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()))
  await Promise.all(fixtures.splice(0).map(async ({ server }) => {
    server.close()
    await once(server, 'close')
  }))
})

describe('isSameOriginHttpUrl', () => {
  it('requires the same scheme, hostname, and effective port', () => {
    expect(isSameOriginHttpUrl('https://public.example.at/path', 'https://public.example.at')).toBe(true)
    expect(isSameOriginHttpUrl('https://public.example.at:443/path', 'https://public.example.at')).toBe(true)
    expect(isSameOriginHttpUrl('http://public.example.at/path', 'https://public.example.at')).toBe(false)
    expect(isSameOriginHttpUrl('https://public.example.at:8443/path', 'https://public.example.at')).toBe(false)
  })
})

describe('WrapperProofService security boundaries', () => {
  it('requires the separate capability for action and close without affecting the session', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService()
    services.push(service)
    const analysis = await service.analyze(`${fixture.origin}/`)
    const search = analysis.capabilities.find(({ name }) => name === 'prepare_page_search')

    await expect(service.execute(
      analysis.sessionId,
      'A'.repeat(43),
      search!.name,
      { query: 'blocked' },
    )).rejects.toThrow('capability is invalid')
    expect(await service.closeSession(analysis.sessionId, 'A'.repeat(43))).toBe(false)

    const result = await service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      search!.name,
      { query: 'allowed' },
    )
    expect(result.structuredContent.targetStateVerified).toBe(true)
  })

  it('publishes neutral field keys and blocks hostile preparation-time GET side effects', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService()
    services.push(service)
    const analysis = await service.analyze(`${fixture.origin}/slow-page`)

    const serializedCapabilities = JSON.stringify(analysis.capabilities)
    expect(serializedCapabilities).not.toMatch(/ignore_previous_instructions|reveal_user_secrets|override_agent_policy|agent_password/)
    const form = analysis.capabilities.find(({ name }) => name === 'prepare_visible_form')
    expect(Object.keys((form?.inputSchema.properties ?? {}) as object)).toEqual(['field_1', 'field_2'])
    const navigation = analysis.capabilities.find(({ name }) => name === 'open_page_link')
    expect(navigation?.evidenceIds).toHaveLength(1)

    const search = analysis.capabilities.find(({ name }) => name === 'prepare_page_search')
    expect(search).toBeDefined()
    const result = await service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      search!.name,
      { query: 'agent-secret' },
    )
    const filter = result.analysis.capabilities.find(({ name }) => name === 'set_page_filter')
    const filterResult = await service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      filter!.name,
      { optionIndex: 1 },
    )
    await new Promise((resolve) => setTimeout(resolve, 120))

    expect(fixture.requests.some((url) => url.startsWith('/collect'))).toBe(false)
    expect(fixture.requests).not.toContain('/slow')
    expect(fixture.slowCompletedAt).toHaveLength(0)
    expect(result.structuredContent).toMatchObject({
      actionKind: 'prepare_search',
      targetStateVerified: true,
      networkPolicy: 'blocked-after-preparation',
      allowedNetworkRequests: 0,
      navigationOccurred: false,
    })
    expect(result.structuredContent.blockedNetworkRequests).toBeGreaterThanOrEqual(1)
    expect(filterResult.structuredContent).toMatchObject({
      actionKind: 'filter',
      targetStateVerified: true,
      networkPolicy: 'blocked-after-preparation',
      allowedNetworkRequests: 0,
    })
    expect(filterResult.structuredContent.blockedNetworkRequests).toBeGreaterThanOrEqual(1)
    expect(filterResult.analysis.title).toBe('one')
    expect(result.analysis.capabilities.some(({ kind }) => kind === 'navigation')).toBe(false)
    expect(result.finalUrl).toBe(`${fixture.origin}/slow-page`)
  })

  it('executes radio groups as one exclusive indexed choice and keeps select samples in range', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService()
    services.push(service)

    const radioAnalysis = await service.analyze(`${fixture.origin}/radio-form`)
    const radioForm = radioAnalysis.capabilities.find(({ name }) => name === 'prepare_visible_form')!
    expect(radioForm.inputSchema).toMatchObject({
      properties: {
        field_1: { type: 'integer', minimum: 0, maximum: 1 },
        field_2: { type: 'string' },
      },
    })
    const firstChoice = await service.execute(
      radioAnalysis.sessionId,
      radioAnalysis.sessionToken,
      radioForm.name,
      radioForm.sampleInput,
    )
    expect(firstChoice.structuredContent).toMatchObject({
      isolatedStateChanged: true,
      targetStateVerified: true,
    })
    const updatedForm = firstChoice.analysis.capabilities.find(({ name }) => name === 'prepare_visible_form')!
    const secondChoice = await service.execute(
      radioAnalysis.sessionId,
      radioAnalysis.sessionToken,
      updatedForm.name,
      { field_1: 1 },
    )
    expect(secondChoice.structuredContent.isolatedStateChanged).toBe(true)

    const selectAnalysis = await service.analyze(`${fixture.origin}/single-select-form`)
    const selectForm = selectAnalysis.capabilities.find(({ name }) => name === 'prepare_visible_form')!
    expect(selectForm.sampleInput).toEqual({ field_1: 0, field_2: 'Sample' })
    const selectResult = await service.execute(
      selectAnalysis.sessionId,
      selectAnalysis.sessionToken,
      selectForm.name,
      selectForm.sampleInput,
    )
    expect(selectResult.structuredContent.targetStateVerified).toBe(true)
  })

  it('validates and retains date, month, time, and ISO week values before mutation', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService()
    services.push(service)
    let analysis = await service.analyze(`${fixture.origin}/date-like-forms`)
    const initialDate = analysis.capabilities.find(({ name }) => name === 'prepare_visible_form')!

    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      initialDate.name,
      { field_1: '2026-02-31' },
    )).rejects.toMatchObject({ code: 'invalid_action', status: 400 })

    const expectedSamples = ['2026-01-15', '2026-01', '12:00', '2026-W01']
    for (let index = 0; index < expectedSamples.length; index += 1) {
      const toolName = index === 0 ? 'prepare_visible_form' : `prepare_visible_form_${index + 1}`
      const capability = analysis.capabilities.find(({ name }) => name === toolName)!
      expect(capability.sampleInput.field_1).toBe(expectedSamples[index])
      const result = await service.execute(
        analysis.sessionId,
        analysis.sessionToken,
        capability.name,
        capability.sampleInput,
      )
      expect(result.structuredContent).toMatchObject({
        isolatedStateChanged: true,
        targetStateVerified: true,
      })
      analysis = result.analysis
    }

    const week = analysis.capabilities.find(({ name }) => name === 'prepare_visible_form_4')!
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      week.name,
      { field_1: '2025-W53' },
    )).rejects.toMatchObject({ code: 'invalid_action', status: 400 })
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      week.name,
      { field_1: '2026-W53' },
    )).resolves.toMatchObject({ structuredContent: { targetStateVerified: true } })
  })

  it('excludes transparent and zero-geometry controls from visible evidence and capabilities', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService()
    services.push(service)
    const analysis = await service.analyze(`${fixture.origin}/visibility`)

    expect(analysis.domEvidence.map(({ label }) => label)).toEqual(['Visible search', 'Visible link'])
    expect(analysis.capabilities.map(({ name }) => name)).toEqual(['prepare_page_search', 'open_page_link'])
  })

  it('excludes normalized sensitive autocomplete fields and consequential navigation paths', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService()
    services.push(service)

    const formAnalysis = await service.analyze(`${fixture.origin}/sensitive-fields`)
    const form = formAnalysis.capabilities.find(({ name }) => name === 'prepare_visible_form')!
    expect(Object.keys((form.inputSchema.properties ?? {}) as object)).toEqual(['field_1', 'field_2'])
    expect(formAnalysis.domEvidence.filter(({ sensitive }) => sensitive).map(({ label }) => label)).toEqual([
      'Neutral field A',
      'Neutral field B',
      'Neutral field C',
      'Neutral field D',
      'Neutral field E',
      'Neutral field F',
      'Neutral field G',
      'Neutral field H',
      'Neutral field I',
      'Neutral field J',
    ])

    const linkAnalysis = await service.analyze(`${fixture.origin}/unsafe-links`)
    const navigation = linkAnalysis.capabilities.find(({ name }) => name === 'open_page_link')!
    expect(navigation.evidenceIds).toHaveLength(1)
    const safeLink = linkAnalysis.domEvidence.find(({ id }) => navigation.evidenceIds.includes(id))
    expect(safeLink?.label).toBe('History')
    expect(linkAnalysis.domEvidence.filter(({ type, sensitive }) => type === 'link' && sensitive)).toHaveLength(6)
  })

  it('rejects repeated search and filter values before mutation while preserving the session', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService()
    services.push(service)
    const analysis = await service.analyze(`${fixture.origin}/`)
    const search = analysis.capabilities.find(({ name }) => name === 'prepare_page_search')!
    const firstSearch = await service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      search.name,
      { query: 'same value' },
    )
    expect(firstSearch.structuredContent.isolatedStateChanged).toBe(true)
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      search.name,
      { query: 'same value' },
    )).rejects.toMatchObject({
      code: 'invalid_action',
      status: 409,
      message: 'The isolated page already matches the requested state.',
    })

    const filter = firstSearch.analysis.capabilities.find(({ name }) => name === 'set_page_filter')!
    const firstFilter = await service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      filter.name,
      { optionIndex: 1 },
    )
    expect(firstFilter.structuredContent.isolatedStateChanged).toBe(true)
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      filter.name,
      { optionIndex: 1 },
    )).rejects.toMatchObject({ code: 'invalid_action', status: 409 })
    expect(await service.closeSession(analysis.sessionId, analysis.sessionToken)).toBe(true)
  })

  it('rejects a preparation when the page changes the value before commit', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService()
    services.push(service)
    const analysis = await service.analyze(`${fixture.origin}/reset-page`)
    const search = analysis.capabilities.find(({ name }) => name === 'prepare_page_search')

    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      search!.name,
      { query: 'agent-value' },
    )).rejects.toMatchObject({
      code: 'invalid_action',
      status: 409,
      sessionInvalidated: true,
      message: 'The page did not retain the prepared search value.',
    })
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      search!.name,
      { query: 'second-value' },
    )).rejects.toThrow('session expired')
  })

  it('verifies the original marked control before hostile DOM reordering can rewrite selectors', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService()
    services.push(service)
    const analysis = await service.analyze(`${fixture.origin}/reorder-verification`)
    const search = analysis.capabilities.find(({ name }) => name === 'prepare_page_search')!

    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      search.name,
      { query: 'agent-value' },
    )).rejects.toMatchObject({
      code: 'invalid_action',
      sessionInvalidated: true,
      message: 'The page did not retain the prepared search value.',
    })
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      search.name,
      { query: 'second-value' },
    )).rejects.toThrow('session expired')
  })

  it('returns the current destination analysis and replaces stale tools after navigation', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService()
    services.push(service)
    const analysis = await service.analyze(`${fixture.origin}/`)
    const navigation = analysis.capabilities.find(({ name }) => name === 'open_page_link')

    const result = await service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      navigation!.name,
      { linkIndex: 0 },
    )

    expect(result.finalUrl).toBe(`${fixture.origin}/next`)
    expect(result.analysis).toMatchObject({
      finalUrl: `${fixture.origin}/next`,
      title: 'Second page',
    })
    expect(result.analysis.capabilities.map(({ name }) => name)).toEqual(['prepare_page_search'])
    expect(result.structuredContent).toMatchObject({
      networkPolicy: 'same-origin-navigation',
      navigationOccurred: true,
      targetStateVerified: true,
    })
    expect(result.structuredContent.allowedNetworkRequests).toBeGreaterThanOrEqual(1)
    expect(fixture.requests).toContain('/next')
  })

  it('propagates abort before a delayed action and leaves no stale server state', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService({ actionStartDelayMs: 400 })
    services.push(service)
    const analysis = await service.analyze(`${fixture.origin}/`)
    const navigation = analysis.capabilities.find(({ name }) => name === 'open_page_link')
    const controller = new AbortController()
    let completedResult: unknown

    const pending = service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      navigation!.name,
      { linkIndex: 0 },
      controller.signal,
    ).then((result) => {
      completedResult = result
      return result
    })
    setTimeout(() => controller.abort(), 30)

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await new Promise((resolve) => setTimeout(resolve, 450))
    expect(completedResult).toBeUndefined()
    expect(fixture.requests).not.toContain('/next')
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      navigation!.name,
      { linkIndex: 0 },
    )).rejects.toThrow('session expired')
  })

  it('caps a session at ten analyzed pages', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService()
    services.push(service)
    let analysis = await service.analyze(`${fixture.origin}/chain/0`)

    for (let page = 1; page < 10; page += 1) {
      const navigation = analysis.capabilities.find(({ name }) => name === 'open_page_link')
      const result = await service.execute(
        analysis.sessionId,
        analysis.sessionToken,
        navigation!.name,
        { linkIndex: 0 },
      )
      analysis = result.analysis
    }
    expect(analysis.analyzedPages).toBe(10)
    const navigation = analysis.capabilities.find(({ name }) => name === 'open_page_link')
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      navigation!.name,
      { linkIndex: 0 },
    )).rejects.toMatchObject({
      code: 'page_limit',
      status: 422,
      message: 'This session reached its 10-page analysis limit.',
    })
    expect(fixture.requests).not.toContain('/chain/10')
  })
})
