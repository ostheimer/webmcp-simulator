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
    if (requestUrl === '/next') {
      response.end(`<!doctype html><title>Second page</title>
        <main><h1>Second page</h1><input type="search" aria-label="Search destination"></main>`)
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
    )).rejects.toThrow('did not retain the prepared search value')
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      search!.name,
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
