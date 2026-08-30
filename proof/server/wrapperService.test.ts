import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { gzipSync } from 'node:zlib'
import type { Page } from 'playwright'
import { afterEach, describe, expect, it } from 'vitest'
import type { PublicTarget } from './publicTarget.ts'
import { WRAPPER_SESSION_TTL_MS } from './wrapperLimits.ts'
import { isSameOriginHttpUrl, WrapperProofService } from './wrapperService.ts'

interface Fixture {
  server: Server
  origin: string
  requests: string[]
  slowCompletedAt: number[]
  declaredResponseBytesSent: number[]
}

const TEST_TARGET_RESOURCE_BYTES = 8 * 1024
const TEST_TARGET_SESSION_BYTES = 24 * 1024

async function startFixture(): Promise<Fixture> {
  const requests: string[] = []
  const slowCompletedAt: number[] = []
  const declaredResponseBytesSent: number[] = []
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
    if (requestUrl === '/catalog-shift') {
      response.end(`<!doctype html><title>Catalog shift fixture</title>
        <input id="initial-search" data-webmcp-proof-id="copied-marker" type="search" aria-label="Initial search">
        <input id="replacement-search" data-webmcp-proof-id="copied-marker" type="search" aria-label="Replacement search" hidden>
        <select aria-label="Category filter">
          <option value="initial">Initial</option><option value="shift">Shift catalog</option>
        </select>
        <script>
          initialSearch = document.getElementById('initial-search');
          replacementSearch = document.getElementById('replacement-search');
          document.querySelector('select').addEventListener('change', () => {
            initialSearch.hidden = true;
            replacementSearch.hidden = false;
          });
        </script>`)
      return
    }
    if (requestUrl === '/viewport-visibility') {
      response.end(`<!doctype html><title>Viewport visibility fixture</title>
        <input type="search" aria-label="Partially visible search" style="position:absolute;left:-40px;top:40px;width:140px;height:32px">
        <input type="search" aria-label="Below fold search" style="position:absolute;left:20px;top:1200px;width:140px;height:32px">
        <input type="search" aria-label="Far right search" style="position:absolute;left:1700px;top:40px;width:140px;height:32px">
        <input type="search" aria-label="Transformed away search" style="position:absolute;left:20px;top:100px;width:140px;height:32px;transform:translateX(2000px)">`)
      return
    }
    if (requestUrl === '/viewport-action') {
      response.end(`<!doctype html><title>Viewport action fixture</title>
        <input type="search" aria-label="Moving search" style="position:absolute;left:20px;top:40px;width:140px;height:32px"
          oninput="this.style.transform='translateX(2000px)'">`)
      return
    }
    if (requestUrl === '/clipped-visibility') {
      response.end(`<!doctype html><title>Clipped visibility fixture</title>
        <input type="search" aria-label="Clip path hidden search" style="position:absolute;left:20px;top:20px;width:140px;height:32px;clip-path:inset(100%)">
        <div style="position:absolute;left:20px;top:80px;width:0;height:0;overflow:hidden">
          <input type="search" aria-label="Overflow hidden search" style="width:140px;height:32px">
        </div>
        <div style="position:absolute;left:20px;top:140px;width:60px;height:32px;overflow:hidden">
          <input type="search" aria-label="Partially clipped search" style="width:140px;height:32px">
        </div>`)
      return
    }
    if (requestUrl === '/clipped-action') {
      response.end(`<!doctype html><title>Clipped action fixture</title>
        <input type="search" aria-label="Clipping search" style="position:absolute;left:20px;top:40px;width:140px;height:32px"
          oninput="this.style.clipPath='inset(100%)'">`)
      return
    }
    if (requestUrl === '/filtered-visibility') {
      response.end(`<!doctype html><title>Filtered visibility fixture</title>
        <input type="search" aria-label="Visible effect control" style="position:absolute;left:20px;top:20px;width:160px;height:32px">
        <input type="search" aria-label="Element filter hidden" style="position:absolute;left:20px;top:70px;width:160px;height:32px;filter:opacity(0)">
        <div style="position:absolute;left:20px;top:120px;filter:opacity(0)">
          <input type="search" aria-label="Ancestor filter hidden" style="width:160px;height:32px">
        </div>
        <input type="search" aria-label="Element mask hidden" style="position:absolute;left:20px;top:170px;width:160px;height:32px;mask-image:linear-gradient(transparent,transparent);-webkit-mask-image:linear-gradient(transparent,transparent)">
        <div style="position:absolute;left:20px;top:220px;mask-image:linear-gradient(transparent,transparent);-webkit-mask-image:linear-gradient(transparent,transparent)">
          <input type="search" aria-label="Ancestor mask hidden" style="width:160px;height:32px">
        </div>`)
      return
    }
    if (requestUrl === '/filtered-action') {
      response.end(`<!doctype html><title>Filtered action fixture</title>
        <div style="position:absolute;left:20px;top:40px">
          <input type="search" aria-label="Filtering search" style="width:160px;height:32px"
            oninput="this.parentElement.style.filter='opacity(0)'">
        </div>`)
      return
    }
    if (requestUrl === '/redirect-source') {
      response.end(`<!doctype html><title>Redirect source</title>
        <a href="/about-risk">Neutral risky redirect</a>
        <a href="/about-safe">Neutral safe redirect</a>`)
      return
    }
    if (requestUrl === '/iframe-navigation-source') {
      response.end(`<!doctype html><title>Iframe navigation source</title>
        <a href="/iframe-destination">Open safe destination</a>`)
      return
    }
    if (requestUrl === '/iframe-destination') {
      response.end(`<!doctype html><title>Iframe destination</title>
        <input type="search" aria-label="Destination search">
        <iframe src="/booking-widget"></iframe>`)
      return
    }
    if (requestUrl === '/booking-widget') {
      response.end('<!doctype html><title>Blocked booking widget</title>')
      return
    }
    if (requestUrl === '/about-risk') {
      response.statusCode = 302
      response.setHeader('Location', '/purchase')
      response.end()
      return
    }
    if (requestUrl === '/about-safe') {
      response.statusCode = 302
      response.setHeader('Location', '/next')
      response.end()
      return
    }
    if (requestUrl === '/purchase') {
      response.end('<!doctype html><title>Purchase must not load</title>')
      return
    }
    if (requestUrl === '/oversized-content-length') {
      const declaredLength = TEST_TARGET_RESOURCE_BYTES * 4
      response.setHeader('Content-Length', declaredLength)
      let sent = 0
      const writeChunk = () => {
        if (response.destroyed || response.writableEnded) return
        const chunk = Buffer.alloc(Math.min(1_024, declaredLength - sent), 1)
        sent += chunk.byteLength
        declaredResponseBytesSent.push(sent)
        response.write(chunk)
        if (sent >= declaredLength) response.end()
      }
      writeChunk()
      const interval = setInterval(writeChunk, 10)
      response.once('close', () => clearInterval(interval))
      response.once('finish', () => clearInterval(interval))
      return
    }
    if (requestUrl === '/oversized-chunked') {
      response.write('<!doctype html><title>Oversized chunked document</title>')
      for (let index = 0; index < 5; index += 1) response.write('x'.repeat(2_048))
      response.end()
      return
    }
    if (requestUrl === '/oversized-compressed') {
      const decoded = `<!doctype html><title>Oversized compressed document</title>${'x'.repeat(TEST_TARGET_RESOURCE_BYTES)}`
      const body = gzipSync(decoded)
      response.setHeader('Content-Encoding', 'gzip')
      response.setHeader('Content-Length', body.byteLength)
      response.end(body)
      return
    }
    if (requestUrl === '/oversized-script-page') {
      response.end('<!doctype html><title>Script budget</title><script src="/oversized-script.js"></script>')
      return
    }
    if (requestUrl === '/oversized-script.js') {
      const body = `/*${'x'.repeat(TEST_TARGET_RESOURCE_BYTES)}*/`
      response.setHeader('Content-Type', 'text/javascript')
      response.setHeader('Content-Length', Buffer.byteLength(body))
      response.end(body)
      return
    }
    if (requestUrl === '/oversized-style-page') {
      response.end('<!doctype html><title>Style budget</title><link rel="stylesheet" href="/oversized-style.css">')
      return
    }
    if (requestUrl === '/oversized-style.css') {
      const body = `/*${'x'.repeat(TEST_TARGET_RESOURCE_BYTES)}*/`
      response.setHeader('Content-Type', 'text/css')
      response.setHeader('Content-Length', Buffer.byteLength(body))
      response.end(body)
      return
    }
    if (requestUrl === '/oversized-image-page') {
      response.end('<!doctype html><title>Image budget</title><img src="/oversized-image.png" alt="Fixture">')
      return
    }
    if (requestUrl === '/oversized-image.png') {
      const body = Buffer.alloc(TEST_TARGET_RESOURCE_BYTES + 1, 1)
      response.setHeader('Content-Type', 'image/png')
      response.setHeader('Content-Length', body.byteLength)
      response.end(body)
      return
    }
    if (requestUrl === '/cumulative-resources') {
      response.end(`<!doctype html><title>Cumulative budget</title>${Array.from({ length: 6 }, (_unused, index) =>
        `<script defer src="/small-resource-${index}.js"></script>`).join('')}`)
      return
    }
    if (/^\/small-resource-\d+\.js$/.test(requestUrl)) {
      const body = `/*${'x'.repeat(5 * 1024)}*/`
      response.setHeader('Content-Type', 'text/javascript')
      response.setHeader('Content-Length', Buffer.byteLength(body))
      response.end(body)
      return
    }
    if (requestUrl === '/under-budget') {
      response.end(`<!doctype html><title>Under budget</title>
        <link rel="stylesheet" href="/small-style.css">
        <script src="/small-script.js"></script>
        <input type="search" aria-label="Budget-safe search">
        <a href="/under-budget-next">Budget-safe next page</a>`)
      return
    }
    if (requestUrl === '/small-style.css') {
      response.setHeader('Content-Type', 'text/css')
      response.end(`/*${'x'.repeat(1_024)}*/`)
      return
    }
    if (requestUrl === '/small-script.js') {
      response.setHeader('Content-Type', 'text/javascript')
      response.end(`/*${'x'.repeat(1_024)}*/`)
      return
    }
    if (requestUrl === '/under-budget-next') {
      response.end('<!doctype html><title>Budget-safe next</title><input type="search" aria-label="Next safe search">')
      return
    }
    if (requestUrl === '/oversized-navigation-source') {
      response.end('<!doctype html><title>Navigation budget source</title><a href="/oversized-navigation">More details</a>')
      return
    }
    if (requestUrl === '/oversized-navigation') {
      const body = `<!doctype html><title>Oversized navigation</title>${'x'.repeat(TEST_TARGET_RESOURCE_BYTES)}`
      response.setHeader('Content-Length', Buffer.byteLength(body))
      response.end(body)
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
    if (requestUrl === '/disabled-optgroup-selects') {
      response.end(`<!doctype html><title>Disabled optgroup selects</title>
        <select id="effective-options-filter" aria-label="Category filter" onchange="document.title=this.value">
          <optgroup label="Unavailable" disabled><option value="locked-filter">Locked filter</option></optgroup>
          <optgroup id="enabled-filter-group" label="Available">
            <option value="enabled-filter-one">Enabled filter one</option>
            <option value="enabled-filter-two">Enabled filter two</option>
          </optgroup>
        </select>
        <form>
          <select name="building_choice" aria-label="Building choice">
            <optgroup label="Unavailable" disabled><option value="locked-form">Locked form option</option></optgroup>
            <option value="enabled-form-one">Enabled form one</option>
            <option value="enabled-form-two">Enabled form two</option>
          </select>
          <input type="text" name="details" aria-label="Details">
        </form>`)
      return
    }
    if (requestUrl === '/action-operability') {
      response.end(`<!doctype html><title>Action operability</title>
        <input id="search-control" type="search" aria-label="Operability search">
        <select id="select-control" aria-label="Category filter">
          <option value="initial">Initial</option><option value="prepared">Prepared</option>
        </select>
        <form id="readonly-form">
          <input id="readonly-control" type="text" aria-label="Readonly value">
          <input type="text" aria-label="Readonly detail">
        </form>
        <form id="fieldset-form">
          <fieldset id="disabled-fieldset">
            <input id="fieldset-control" type="text" aria-label="Fieldset value">
            <input type="text" aria-label="Fieldset detail">
          </fieldset>
        </form>
        <form id="enabled-form">
          <input id="enabled-control" type="text" aria-label="Enabled value">
          <input type="text" aria-label="Enabled detail">
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
    if (requestUrl === '/numeric-bounds') {
      response.end(`<!doctype html><title>Numeric bounds</title>
        <form><input type="range" min="10" max="20" step="2" aria-label="Bounded range"><input type="text" aria-label="Range details"></form>
        <form><input type="number" max="0.7" step="0.2" aria-label="Bounded decimal"><input type="text" aria-label="Decimal details"></form>
        <form><input type="range" min="10" max="20" step="0" aria-label="Zero step"><input type="text" aria-label="Zero step details"></form>
        <form><input type="range" min="10" max="20" step="-2" aria-label="Negative step"><input type="text" aria-label="Negative step details"></form>`)
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
          <input type="text" id="creditCard" aria-label="Neutral field K">
          <input type="text" id="userCredential" aria-label="Neutral field L">
          <input type="text" id="apiToken" aria-label="Neutral field M">
        </form>`)
      return
    }
    if (requestUrl === '/accessible-sensitive-labels') {
      response.end(`<!doctype html><title>Accessible label safety</title>
        <span id="neutral-description">Reference</span>
        <span id="payment-description">Credit card</span>
        <svg aria-hidden="true"><text id="svg-payment-description">Payment card</text></svg>
        <form>
          <input type="text" name="safe_one" aria-label="First neutral field">
          <input type="text" name="safe_two" aria-label="Second neutral field">
          <input type="text" name="reference" id="reference" aria-label="Neutral aria label"
            aria-labelledby="neutral-description payment-description">
          <input type="text" name="secondary_reference" id="secondary-reference" aria-label="Second neutral aria label">
          <label for="secondary-reference">Reference</label>
          <label for="secondary-reference">User password</label>
          <input type="text" name="svg_reference" id="svg-reference" aria-label="SVG neutral aria label"
            aria-labelledby="svg-payment-description">
        </form>`)
      return
    }
    if (requestUrl === '/queued-capabilities') {
      response.end(`<!doctype html><title>Queued capability fixture</title>
        <form id="first-form">
          <input type="text" aria-label="First form value" oninput="
            if (!document.getElementById('replacement-form')) {
              document.getElementById('second-form')?.remove();
              const replacement = document.createElement('form');
              replacement.id = 'replacement-form';
              replacement.innerHTML = '<input type=&quot;text&quot; aria-label=&quot;Replacement value one&quot;><input type=&quot;text&quot; aria-label=&quot;Replacement value two&quot;>';
              document.body.insertBefore(replacement, document.getElementById('first-form'));
            }
          ">
          <input type="text" aria-label="First form detail">
        </form>
        <form id="second-form">
          <input type="text" aria-label="Second form value">
          <input type="text" aria-label="Second form detail">
        </form>`)
      return
    }
    if (requestUrl === '/hostile-main-realm') {
      response.end(`<!doctype html><title>Hostile main realm</title>
        <form>
          <input type="text" name="safe_one" aria-label="First safe value">
          <input type="text" name="safe_two" aria-label="Second safe value">
          <input type="text" id="creditCard" aria-label="Reference">
          <input type="password" id="userCredential" aria-label="Hidden reference" style="display:none">
        </form>
        <script>
          const replaceValue = (owner, key, value) => {
            try { Object.defineProperty(owner, key, { configurable: true, value }); } catch {}
          };
          const replaceGetter = (owner, key, value) => {
            try { Object.defineProperty(owner, key, { configurable: true, get: () => value }); } catch {}
          };
          replaceValue(Document.prototype, 'querySelectorAll', function () { return []; });
          replaceValue(Element.prototype, 'querySelector', function () { return null; });
          replaceValue(Element.prototype, 'getAttribute', function (name) {
            return name === 'aria-label' ? 'Neutral reference' : '';
          });
          replaceValue(Element.prototype, 'hasAttribute', function () { return false; });
          replaceValue(Element.prototype, 'getClientRects', function () { return [{ width: 120, height: 24 }]; });
          replaceValue(window, 'getComputedStyle', function () {
            return { display: 'block', visibility: 'visible', opacity: '1' };
          });
          replaceGetter(HTMLElement.prototype, 'hidden', false);
          replaceGetter(HTMLInputElement.prototype, 'disabled', false);
          replaceGetter(HTMLInputElement.prototype, 'readOnly', false);
          replaceGetter(HTMLInputElement.prototype, 'type', 'text');
          replaceGetter(HTMLInputElement.prototype, 'name', '');
          replaceGetter(HTMLInputElement.prototype, 'labels', []);
          replaceGetter(Element.prototype, 'id', '');
        </script>`)
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
    declaredResponseBytesSent,
  }
}

function createService(options: {
  actionStartDelayMs?: number
  actionSettleMs?: number
  maxTargetResourceBytes?: number
  maxTargetSessionBytes?: number
} = {}) {
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
    maxTargetResourceBytes: options.maxTargetResourceBytes,
    maxTargetSessionBytes: options.maxTargetSessionBytes,
  })
}

function createBudgetedService() {
  return createService({
    maxTargetResourceBytes: TEST_TARGET_RESOURCE_BYTES,
    maxTargetSessionBytes: TEST_TARGET_SESSION_BYTES,
  })
}

interface InternalProofSession {
  page: Page
  expiresAt: number
  createdAtMs: number
}

function internalSession(service: WrapperProofService, sessionId: string): InternalProofSession {
  const sessions = (service as unknown as { sessions: Map<string, InternalProofSession> }).sessions
  const session = sessions.get(sessionId)
  if (!session) throw new Error('Expected an active internal proof session.')
  return session
}

function internalServiceState(service: WrapperProofService): { sessions: number, reservations: number } {
  const state = service as unknown as {
    sessions: Map<string, InternalProofSession>
    analysisReservations: number
  }
  return { sessions: state.sessions.size, reservations: state.analysisReservations }
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
  it('releases analysis reservations after target-resolution failures', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    let rejectTarget = true
    const service = new WrapperProofService({
      resolveTarget: async (value) => {
        if (rejectTarget) throw new Error('fixture resolver failure')
        const url = new URL(value)
        return {
          url: url.toString(),
          origin: url.origin,
          hostname: url.hostname,
          pinnedAddress: '127.0.0.1',
          addresses: [{ address: '127.0.0.1', family: 4 }],
        }
      },
      actionSettleMs: 20,
    })
    services.push(service)

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(service.analyze(`${fixture.origin}/`)).rejects.toThrow('fixture resolver failure')
      expect(internalServiceState(service)).toEqual({ sessions: 0, reservations: 0 })
    }
    rejectTarget = false
    await expect(service.analyze(`${fixture.origin}/`)).resolves.toMatchObject({ title: 'Hostile fixture' })
    expect(internalServiceState(service)).toEqual({ sessions: 1, reservations: 0 })
  })

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

  it('excludes options disabled through an optgroup from every public select mapping', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService()
    services.push(service)
    let analysis = await service.analyze(`${fixture.origin}/disabled-optgroup-selects`)
    expect(analysis.capabilities.map(({ name }) => name)).toEqual([
      'set_page_filter',
      'prepare_visible_form',
    ])

    const filter = analysis.capabilities.find(({ name }) => name === 'set_page_filter')!
    expect(filter.inputSchema).toMatchObject({
      properties: { optionIndex: { minimum: 0, maximum: 1 } },
    })
    expect(filter.sampleInput).toEqual({ optionIndex: 1 })
    const filterResult = await service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      filter.name,
      filter.sampleInput,
      undefined,
      filter.id,
    )
    expect(filterResult.analysis.title).toBe('enabled-filter-two')
    analysis = filterResult.analysis

    const firstEnabledFilter = analysis.capabilities.find(({ name }) => name === 'set_page_filter')!
    const firstEnabledResult = await service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      firstEnabledFilter.name,
      { optionIndex: 0 },
      undefined,
      firstEnabledFilter.id,
    )
    expect(firstEnabledResult.analysis.title).toBe('enabled-filter-one')
    analysis = firstEnabledResult.analysis

    const form = analysis.capabilities.find(({ name }) => name === 'prepare_visible_form')!
    expect(form.inputSchema).toMatchObject({
      properties: { field_1: { minimum: 0, maximum: 1 } },
    })
    expect(form.sampleInput).toEqual({ field_1: 1, field_2: 'Sample' })
    const formResult = await service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      form.name,
      form.sampleInput,
      undefined,
      form.id,
    )
    expect(formResult.structuredContent.targetStateVerified).toBe(true)
    expect(await internalSession(service, analysis.sessionId).page.locator('form select').evaluate(
      (select) => (select as HTMLSelectElement).selectedIndex,
    )).toBe(2)

    const currentFilter = formResult.analysis.capabilities.find(({ name }) => name === 'set_page_filter')!
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      currentFilter.name,
      { optionIndex: 2 },
      undefined,
      currentFilter.id,
    )).rejects.toMatchObject({ code: 'invalid_action', sessionInvalidated: false })
    const currentForm = formResult.analysis.capabilities.find(({ name }) => name === 'prepare_visible_form')!
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      currentForm.name,
      { field_1: 2 },
      undefined,
      currentForm.id,
    )).rejects.toMatchObject({ code: 'invalid_action', sessionInvalidated: false })
  })

  it('invalidates when a selected option becomes effectively disabled before verification', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService()
    services.push(service)
    const analysis = await service.analyze(`${fixture.origin}/disabled-optgroup-selects`)
    const filter = analysis.capabilities.find(({ name }) => name === 'set_page_filter')!
    const page = internalSession(service, analysis.sessionId).page
    await page.locator('#effective-options-filter').evaluate((select) => {
      select.addEventListener('change', () => {
        (document.querySelector('#enabled-filter-group') as HTMLOptGroupElement).disabled = true
      }, { once: true })
    })

    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      filter.name,
      filter.sampleInput,
      undefined,
      filter.id,
    )).rejects.toMatchObject({ code: 'action_failed', sessionInvalidated: true })
    expect(internalServiceState(service)).toEqual({ sessions: 0, reservations: 0 })
  })

  it.each([
    ['disabled input', '#search-control', 'disabled', 'prepare_page_search', { query: 'prepared' }, ''],
    ['disabled select', '#select-control', 'disabled', 'set_page_filter', { optionIndex: 1 }, 'initial'],
    ['readonly input', '#readonly-control', 'readOnly', 'prepare_visible_form', { field_1: 'prepared' }, ''],
    ['disabled fieldset', '#disabled-fieldset', 'disabled', 'prepare_visible_form_2', { field_1: 'prepared' }, ''],
  ])('rejects a %s before mutation and preserves the pre-action session', async (
    _label,
    selector,
    property,
    toolName,
    input,
    initialValue,
  ) => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService()
    services.push(service)
    const analysis = await service.analyze(`${fixture.origin}/action-operability`)
    const capability = analysis.capabilities.find(({ name }) => name === toolName)!
    const page = internalSession(service, analysis.sessionId).page
    await page.locator(selector).evaluate((element, propertyName) => {
      Reflect.set(element, String(propertyName), true)
    }, property)

    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      capability.name,
      input,
      undefined,
      capability.id,
    )).rejects.toMatchObject({ code: 'invalid_action', status: 409, sessionInvalidated: false })
    expect(await page.locator(selector === '#disabled-fieldset' ? '#fieldset-control' : selector).inputValue()).toBe(initialValue)

    await page.locator(selector).evaluate((element, propertyName) => {
      Reflect.set(element, String(propertyName), false)
    }, property)
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      capability.name,
      input,
      undefined,
      capability.id,
    )).resolves.toMatchObject({ structuredContent: { targetStateVerified: true } })
  })

  it('invalidates the session when a control becomes disabled after the pre-action read', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService({ actionStartDelayMs: 200 })
    services.push(service)
    const analysis = await service.analyze(`${fixture.origin}/action-operability`)
    const search = analysis.capabilities.find(({ name }) => name === 'prepare_page_search')!
    const page = internalSession(service, analysis.sessionId).page
    const pending = service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      search.name,
      { query: 'must-not-mutate' },
      undefined,
      search.id,
    )
    await new Promise((resolve) => setTimeout(resolve, 40))
    await page.locator('#search-control').evaluate((input) => {
      (input as HTMLInputElement).disabled = true
    })

    await expect(pending).rejects.toMatchObject({ code: 'action_failed', sessionInvalidated: true })
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      search.name,
      { query: 'stale' },
      undefined,
      search.id,
    )).rejects.toMatchObject({ code: 'session_expired' })
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
    )).rejects.toMatchObject({ code: 'invalid_action', status: 400, sessionInvalidated: false })

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

  it('publishes executable numeric samples within native bounds and step grids', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService()
    services.push(service)
    let analysis = await service.analyze(`${fixture.origin}/numeric-bounds`)
    const boundedRange = analysis.capabilities.find(({ name }) => name === 'prepare_visible_form')!
    expect(boundedRange.inputSchema).toMatchObject({
      properties: { field_1: { type: 'number', minimum: 10, maximum: 20, multipleOf: 2 } },
    })
    expect(boundedRange.sampleInput.field_1).toBe(10)
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      boundedRange.name,
      { field_1: 11 },
    )).rejects.toMatchObject({ code: 'invalid_action', status: 400 })
    const rangeResult = await service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      boundedRange.name,
      boundedRange.sampleInput,
    )
    expect(rangeResult.structuredContent.targetStateVerified).toBe(true)
    analysis = rangeResult.analysis

    const boundedDecimal = analysis.capabilities.find(({ name }) => name === 'prepare_visible_form_2')!
    expect(boundedDecimal.inputSchema).toMatchObject({
      properties: { field_1: { type: 'number', maximum: 0.7, multipleOf: 0.2 } },
    })
    expect(boundedDecimal.sampleInput.field_1).toBe(0.6)
    const decimalResult = await service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      boundedDecimal.name,
      boundedDecimal.sampleInput,
    )
    expect(decimalResult.structuredContent.targetStateVerified).toBe(true)
    analysis = decimalResult.analysis

    for (const toolName of ['prepare_visible_form_3', 'prepare_visible_form_4']) {
      const invalidStepFallback = analysis.capabilities.find(({ name }) => name === toolName)!
      expect(invalidStepFallback.inputSchema).toMatchObject({
        properties: { field_1: { minimum: 10, maximum: 20, multipleOf: 1 } },
      })
      expect(invalidStepFallback.sampleInput.field_1).toBe(10)
      const result = await service.execute(
        analysis.sessionId,
        analysis.sessionToken,
        invalidStepFallback.name,
        invalidStepFallback.sampleInput,
      )
      expect(result.structuredContent.targetStateVerified).toBe(true)
      analysis = result.analysis
    }
  })

  it('keeps follow-up actions usable when a marked control is hidden and replaced', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService()
    services.push(service)
    const analysis = await service.analyze(`${fixture.origin}/catalog-shift`)
    const filter = analysis.capabilities.find(({ name }) => name === 'set_page_filter')!
    const shifted = await service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      filter.name,
      { optionIndex: 1 },
    )
    expect(shifted.analysis.domEvidence.map(({ label }) => label)).toEqual([
      'Replacement search',
      'Category filter',
    ])
    expect(JSON.stringify(shifted.analysis)).not.toContain('data-webmcp-proof-id')

    const replacementSearch = shifted.analysis.capabilities.find(({ name }) => name === 'prepare_page_search')!
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      replacementSearch.name,
      { query: 'second' },
    )).resolves.toMatchObject({
      structuredContent: { isolatedStateChanged: true, targetStateVerified: true },
    })
  })

  it('publishes and mutates only controls intersecting the captured viewport', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService()
    services.push(service)
    const analysis = await service.analyze(`${fixture.origin}/viewport-visibility`)

    expect(analysis.domEvidence.map(({ label }) => label)).toEqual(['Partially visible search'])
    const search = analysis.capabilities.find(({ name }) => name === 'prepare_page_search')!
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      search.name,
      { query: 'visible state' },
    )).resolves.toMatchObject({
      structuredContent: { isolatedStateChanged: true, targetStateVerified: true },
    })
  })

  it('fails closed when a visible control leaves the captured viewport before verification', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService()
    services.push(service)
    const analysis = await service.analyze(`${fixture.origin}/viewport-action`)
    const search = analysis.capabilities.find(({ name }) => name === 'prepare_page_search')!

    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      search.name,
      { query: 'move away' },
    )).rejects.toMatchObject({
      code: 'action_failed',
      sessionInvalidated: true,
    })
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      search.name,
      { query: 'stale' },
    )).rejects.toMatchObject({ code: 'session_expired' })
  })

  it('excludes fully clipped controls while retaining a genuinely visible clipped portion', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService()
    services.push(service)
    const analysis = await service.analyze(`${fixture.origin}/clipped-visibility`)

    expect(analysis.domEvidence.map(({ label }) => label)).toEqual(['Partially clipped search'])
    const search = analysis.capabilities.find(({ name }) => name === 'prepare_page_search')!
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      search.name,
      { query: 'visible clipped state' },
      undefined,
      search.id,
    )).resolves.toMatchObject({
      structuredContent: { isolatedStateChanged: true, targetStateVerified: true },
    })
  })

  it('fails closed when a control becomes fully clipped before verification', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService()
    services.push(service)
    const analysis = await service.analyze(`${fixture.origin}/clipped-action`)
    const search = analysis.capabilities.find(({ name }) => name === 'prepare_page_search')!

    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      search.name,
      { query: 'hide after write' },
      undefined,
      search.id,
    )).rejects.toMatchObject({ code: 'action_failed', sessionInvalidated: true })
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      search.name,
      { query: 'stale' },
      undefined,
      search.id,
    )).rejects.toMatchObject({ code: 'session_expired' })
  })

  it('excludes controls hidden by element or ancestor filters and masks', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService()
    services.push(service)
    const analysis = await service.analyze(`${fixture.origin}/filtered-visibility`)

    expect(analysis.domEvidence.map(({ label }) => label)).toEqual(['Visible effect control'])
    expect(analysis.capabilities.map(({ name }) => name)).toEqual(['prepare_page_search'])
    const search = analysis.capabilities[0]
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      search.name,
      { query: 'visible effect state' },
      undefined,
      search.id,
    )).resolves.toMatchObject({
      structuredContent: { isolatedStateChanged: true, targetStateVerified: true },
    })
  })

  it('fails closed when an ancestor filter hides a control during verification', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService()
    services.push(service)
    const analysis = await service.analyze(`${fixture.origin}/filtered-action`)
    const search = analysis.capabilities.find(({ name }) => name === 'prepare_page_search')!

    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      search.name,
      { query: 'hide through filter' },
      undefined,
      search.id,
    )).rejects.toMatchObject({ code: 'action_failed', sessionInvalidated: true })
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      search.name,
      { query: 'stale' },
      undefined,
      search.id,
    )).rejects.toMatchObject({ code: 'session_expired' })
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
      'Neutral field K',
      'Neutral field L',
      'Neutral field M',
    ])

    const linkAnalysis = await service.analyze(`${fixture.origin}/unsafe-links`)
    const navigation = linkAnalysis.capabilities.find(({ name }) => name === 'open_page_link')!
    expect(navigation.evidenceIds).toHaveLength(1)
    const safeLink = linkAnalysis.domEvidence.find(({ id }) => navigation.evidenceIds.includes(id))
    expect(safeLink?.label).toBe('History')
    expect(linkAnalysis.domEvidence.filter(({ type, sensitive }) => type === 'link' && sensitive)).toHaveLength(6)
  })

  it('checks every aria-labelledby reference and associated label for sensitive evidence', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService()
    services.push(service)
    const analysis = await service.analyze(`${fixture.origin}/accessible-sensitive-labels`)

    expect(analysis.domEvidence.map(({ label, sensitive }) => ({ label, sensitive }))).toEqual([
      { label: 'First neutral field', sensitive: false },
      { label: 'Second neutral field', sensitive: false },
      { label: 'Neutral aria label', sensitive: true },
      { label: 'Second neutral aria label', sensitive: true },
      { label: 'SVG neutral aria label', sensitive: true },
    ])
    const form = analysis.capabilities.find(({ name }) => name === 'prepare_visible_form')!
    expect(Object.keys((form.inputSchema.properties ?? {}) as object)).toEqual(['field_1', 'field_2'])
  })

  it('rejects a queued stale capability binding before mutation and preserves the session', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService({ actionStartDelayMs: 120 })
    services.push(service)
    const analysis = await service.analyze(`${fixture.origin}/queued-capabilities`)
    const firstForm = analysis.capabilities.find(({ name }) => name === 'prepare_visible_form')!
    const secondForm = analysis.capabilities.find(({ name }) => name === 'prepare_visible_form_2')!

    const first = service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      firstForm.name,
      { field_1: 'first action' },
      undefined,
      firstForm.id,
    )
    const stale = service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      secondForm.name,
      { field_1: 'must not be applied' },
      undefined,
      secondForm.id,
    )
    const firstResult = await first

    await expect(stale).rejects.toMatchObject({
      code: 'invalid_action',
      sessionInvalidated: false,
      message: 'The requested tool belongs to a stale page analysis. Analyze the current page again.',
    })
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      secondForm.name,
      { field_1: 'arrived after reanalysis' },
      undefined,
      secondForm.id,
    )).rejects.toMatchObject({
      code: 'invalid_action',
      sessionInvalidated: false,
    })
    const currentSecondForm = firstResult.analysis.capabilities
      .find(({ name }) => name === 'prepare_visible_form_2')!
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      currentSecondForm.name,
      currentSecondForm.sampleInput,
      undefined,
      currentSecondForm.id,
    )).resolves.toMatchObject({
      structuredContent: { isolatedStateChanged: true, targetStateVerified: true },
    })
  })

  it('classifies DOM evidence in an isolated realm and keeps backend node identities server-only', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService()
    services.push(service)
    const analysis = await service.analyze(`${fixture.origin}/hostile-main-realm`)

    expect(analysis.domEvidence.map(({ label, sensitive }) => ({ label, sensitive }))).toEqual([
      { label: 'First safe value', sensitive: false },
      { label: 'Second safe value', sensitive: false },
      { label: 'Reference', sensitive: true },
    ])
    const form = analysis.capabilities.find(({ name }) => name === 'prepare_visible_form')!
    expect(Object.keys((form.inputSchema.properties ?? {}) as object)).toEqual(['field_1', 'field_2'])
    const serialized = JSON.stringify(analysis)
    expect(serialized).not.toMatch(/creditCard|userCredential|backendNodeId|data-webmcp-proof-id/)

    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      form.name,
      form.sampleInput,
    )).resolves.toMatchObject({
      structuredContent: { isolatedStateChanged: true, targetStateVerified: true },
    })
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

  it('verifies the original backend node when hostile DOM reordering inserts a decoy', async () => {
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

  it('blocks consequential redirect hops before requesting them and allows neutral redirects', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const blockedService = createService()
    services.push(blockedService)
    const blockedAnalysis = await blockedService.analyze(`${fixture.origin}/redirect-source`)
    const blockedNavigation = blockedAnalysis.capabilities.find(({ name }) => name === 'open_page_link')!

    await expect(blockedService.execute(
      blockedAnalysis.sessionId,
      blockedAnalysis.sessionToken,
      blockedNavigation.name,
      { linkIndex: 0 },
      undefined,
      blockedNavigation.id,
    )).rejects.toMatchObject({
      code: 'invalid_action',
      sessionInvalidated: true,
      message: 'The isolated page attempted a consequential navigation and was stopped.',
    })
    expect(fixture.requests).toContain('/about-risk')
    expect(fixture.requests).not.toContain('/purchase')
    await expect(blockedService.execute(
      blockedAnalysis.sessionId,
      blockedAnalysis.sessionToken,
      blockedNavigation.name,
      { linkIndex: 1 },
      undefined,
      blockedNavigation.id,
    )).rejects.toMatchObject({ code: 'session_expired' })

    const safeService = createService()
    services.push(safeService)
    const safeAnalysis = await safeService.analyze(`${fixture.origin}/redirect-source`)
    const safeNavigation = safeAnalysis.capabilities.find(({ name }) => name === 'open_page_link')!
    await expect(safeService.execute(
      safeAnalysis.sessionId,
      safeAnalysis.sessionToken,
      safeNavigation.name,
      { linkIndex: 1 },
      undefined,
      safeNavigation.id,
    )).resolves.toMatchObject({
      finalUrl: `${fixture.origin}/next`,
      structuredContent: { targetStateVerified: true, navigationOccurred: true },
    })
    expect(fixture.requests).toContain('/about-safe')
    expect(fixture.requests).toContain('/next')
  })

  it('blocks consequential subframes without invalidating a safe main-frame navigation', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService()
    services.push(service)
    const analysis = await service.analyze(`${fixture.origin}/iframe-navigation-source`)
    const navigation = analysis.capabilities.find(({ name }) => name === 'open_page_link')!

    const result = await service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      navigation.name,
      { linkIndex: 0 },
      undefined,
      navigation.id,
    )

    expect(result).toMatchObject({
      finalUrl: `${fixture.origin}/iframe-destination`,
      structuredContent: { navigationOccurred: true, targetStateVerified: true },
    })
    expect(result.structuredContent.blockedNetworkRequests).toBeGreaterThanOrEqual(1)
    expect(fixture.requests).toContain('/iframe-destination')
    expect(fixture.requests).not.toContain('/booking-widget')
    const search = result.analysis.capabilities.find(({ name }) => name === 'prepare_page_search')!
    await expect(service.execute(
      result.analysis.sessionId,
      result.analysis.sessionToken,
      search.name,
      { query: 'session remains usable' },
      undefined,
      search.id,
    )).resolves.toMatchObject({ structuredContent: { targetStateVerified: true } })
  })

  it('rejects oversized target documents from headers and live chunk measurement', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)

    for (const path of ['/oversized-content-length', '/oversized-chunked', '/oversized-compressed']) {
      const service = createBudgetedService()
      services.push(service)
      await expect(service.analyze(`${fixture.origin}${path}`)).rejects.toMatchObject({
        code: 'response_limit',
        status: 507,
        message: 'The isolated target exceeded the download safety limit.',
      })
    }
    expect(fixture.declaredResponseBytesSent.at(-1)).toBeLessThan(TEST_TARGET_RESOURCE_BYTES * 4)
  })

  it.each([
    '/oversized-script-page',
    '/oversized-style-page',
    '/oversized-image-page',
  ])('rejects an oversized target subresource on %s', async (path) => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createBudgetedService()
    services.push(service)

    await expect(service.analyze(`${fixture.origin}${path}`)).rejects.toMatchObject({
      code: 'response_limit',
      status: 507,
    })
  })

  it('rejects cumulative target traffic made from individually small resources', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createBudgetedService()
    services.push(service)

    await expect(service.analyze(`${fixture.origin}/cumulative-resources`)).rejects.toMatchObject({
      code: 'response_limit',
      status: 507,
    })
  })

  it('keeps an under-budget analysis and navigation session usable', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createBudgetedService()
    services.push(service)
    let analysis = await service.analyze(`${fixture.origin}/under-budget`)
    const navigation = analysis.capabilities.find(({ name }) => name === 'open_page_link')!
    const navigationResult = await service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      navigation.name,
      { linkIndex: 0 },
      undefined,
      navigation.id,
    )
    expect(navigationResult).toMatchObject({
      finalUrl: `${fixture.origin}/under-budget-next`,
      structuredContent: { targetStateVerified: true },
    })
    analysis = navigationResult.analysis
    const search = analysis.capabilities.find(({ name }) => name === 'prepare_page_search')!
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      search.name,
      { query: 'within budget' },
      undefined,
      search.id,
    )).resolves.toMatchObject({
      structuredContent: { targetStateVerified: true },
    })
  })

  it('invalidates a begun navigation when its target exceeds the resource budget', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createBudgetedService()
    services.push(service)
    const analysis = await service.analyze(`${fixture.origin}/oversized-navigation-source`)
    const navigation = analysis.capabilities.find(({ name }) => name === 'open_page_link')!

    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      navigation.name,
      { linkIndex: 0 },
      undefined,
      navigation.id,
    )).rejects.toMatchObject({
      code: 'response_limit',
      status: 507,
      sessionInvalidated: true,
    })
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      navigation.name,
      { linkIndex: 0 },
      undefined,
      navigation.id,
    )).rejects.toMatchObject({ code: 'session_expired' })
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

  it('expires a queued action after it acquires the queue without applying a second mutation', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService({ actionStartDelayMs: 650, actionSettleMs: 20 })
    services.push(service)
    const analysis = await service.analyze(`${fixture.origin}/action-operability`)
    const search = analysis.capabilities.find(({ name }) => name === 'prepare_page_search')!
    const first = service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      search.name,
      { query: 'first queued value' },
      undefined,
      search.id,
    )
    await new Promise((resolve) => setTimeout(resolve, 25))
    const session = internalSession(service, analysis.sessionId)
    const admittedAt = Date.now()
    session.createdAtMs = admittedAt - WRAPPER_SESSION_TTL_MS + 500
    session.expiresAt = admittedAt + 500
    const second = service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      search.name,
      { query: 'second queued value' },
      undefined,
      search.id,
    )
    const secondExpectation = expect(second).rejects.toMatchObject({
      code: 'session_expired',
      status: 410,
      sessionInvalidated: true,
    })

    const firstResult = await first
    expect(firstResult.activity.summary).toContain('Agent prepared visible state')
    await secondExpectation
    expect(internalServiceState(service)).toEqual({ sessions: 0, reservations: 0 })
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
