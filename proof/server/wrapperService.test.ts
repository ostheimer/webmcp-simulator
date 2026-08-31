import { createServer, type Server } from 'node:http'
import { createSocket } from 'node:dgram'
import { once } from 'node:events'
import { gzipSync } from 'node:zlib'
import type { Browser, CDPSession, Page } from 'playwright'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PublicTarget } from './publicTarget.ts'
import { WRAPPER_SESSION_TTL_MS } from './wrapperLimits.ts'
import {
  isConsequentialNavigationUrl,
  isSameOriginHttpUrl,
  WrapperProofService,
} from './wrapperService.ts'

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
    if (requestUrl === '/generated-accessible-safety') {
      response.end(`<!doctype html><title>Generated accessible safety</title>
        <style>
          .generated-sensitive::before { content: 'Credit ca​rd number'; }
          .generated-neutral::before { content: 'Reference'; }
          .late-generated.hostile::after { content: 'Password'; }
          .generated-overflow::before { content: '${'x'.repeat(4_200)}'; }
        </style>
        <label><span class="generated-sensitive"></span><input id="generated-sensitive" type="search" aria-label="Safe generated search"></label>
        <label id="late-generated-label" class="late-generated"><input id="late-generated" type="search" aria-label="Late generated search"></label>
        <label class="generated-neutral"><input id="generated-neutral" type="search" aria-label="Neutral generated search"></label>
        <label><span class="generated-overflow"></span><input id="generated-overflow" type="search" aria-label="Overflow generated search"></label>`)
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
    if (requestUrl === '/paint-occlusion') {
      response.end(`<!doctype html><title>Paint occlusion fixture</title>
        <input id="occluded-search" type="search" aria-label="Occluded search"
          style="position:absolute;left:20px;top:30px;width:180px;height:36px">
        <div id="opaque-overlay" style="position:absolute;left:20px;top:30px;width:180px;height:36px;background:#111;z-index:10;pointer-events:none"></div>
        <input id="painted-search" type="search" aria-label="Painted search"
          style="position:absolute;left:20px;top:100px;width:180px;height:36px">`)
      return
    }
    if (requestUrl === '/paint-occlusion-action') {
      response.end(`<!doctype html><title>Paint occlusion action fixture</title>
        <input id="action-search" type="search" aria-label="Action search"
          style="position:absolute;left:20px;top:30px;width:180px;height:36px">`)
      return
    }
    if (requestUrl === '/fragment-links') {
      response.end(`<!doctype html><title>Fragment links fixture</title>
        <a href="/about#/checkout">Unsafe fragment route</a>
        <a href="/about#overview">Neutral fragment route</a>
        <a href="/late-fragment">Late fragment route</a>`)
      return
    }
    if (requestUrl === '/about') {
      response.end('<!doctype html><title>About fragment destination</title><input type="search" aria-label="About search">')
      return
    }
    if (requestUrl === '/late-fragment') {
      response.end(`<!doctype html><title>Late fragment destination</title>
        <script>setTimeout(() => { location.hash = '/booking' }, 30)</script>`)
      return
    }
    if (requestUrl === '/redirect-source') {
      response.end(`<!doctype html><title>Redirect source</title>
        <a href="/about-risk">Neutral risky redirect</a>
        <a href="/about-safe">Neutral safe redirect</a>`)
      return
    }
    if (requestUrl === '/destructive-navigation-source') {
      response.end(`<!doctype html><title>Destructive navigation source</title>
        <a href="/delete-account">Delete account</a>
        <a href="/unsubscribe?token=agent-secret">Unsubscribe</a>
        <a href="/logout">Log out</a>
        <a href="/konto#löschen">Konto löschen</a>
        <a href="/about#overview">Neutral overview</a>
        <a href="/destructive-redirect">Neutral redirect label</a>
        <a href="/late-destructive-route">Late destructive route</a>`)
      return
    }
    if (requestUrl === '/destructive-redirect') {
      response.statusCode = 302
      response.setHeader('Location', '/remove-profile')
      response.end()
      return
    }
    if (requestUrl === '/late-destructive-route') {
      response.end(`<!doctype html><title>Late destructive destination</title>
        <script>setTimeout(() => { location.hash = '/unsubscribe?token=late' }, 30)</script>`)
      return
    }
    if (
      requestUrl.startsWith('/delete-account')
      || requestUrl.startsWith('/unsubscribe')
      || requestUrl.startsWith('/logout')
      || requestUrl.startsWith('/konto')
      || requestUrl.startsWith('/remove-profile')
    ) {
      response.end('<!doctype html><title>Destructive destination must not load</title>')
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
    if (requestUrl === '/late-non-network-subframe-boundary') {
      response.end(`<!doctype html><title>Late non-network frame</title>
        <style>body{margin:0}.main-paint{position:absolute;left:20px;top:20px;width:260px;height:90px;background:rgb(37,99,235)}</style>
        <div class="main-paint">Main frame paint</div>`)
      return
    }
    if (requestUrl === '/late-persistent-initial-subframe') {
      response.end(`<!doctype html><title>Late persistent initial frame</title>
        <input type="search" aria-label="Main frame search">
        <script>
          setTimeout(() => {
            const frame = document.createElement('iframe');
            frame.srcdoc = '<body>Persistent child</body>';
            document.body.append(frame);
          }, 560);
        </script>`)
      return
    }
    if (requestUrl.startsWith('/non-network-subframe-boundary')) {
      const kind = new URL(requestUrl, 'http://fixture.invalid').searchParams.get('kind') ?? 'neutral'
      const childDocument = `<!doctype html><style>
        html,body{margin:0;width:100%;height:100%;background:rgb(220,38,38)}
        #child-frame-marker{width:100%;height:100%;animation:child-paint 40ms linear infinite alternate}
        @keyframes child-paint{from{background:rgb(220,38,38)}to{background:rgb(250,204,21)}}
      </style><div id="child-frame-marker">Child frame paint</div>`
      const encodedChildDocument = Buffer.from(childDocument).toString('base64')
      const frameStyle = 'position:absolute;left:20px;top:20px;width:260px;height:90px;border:0;z-index:10'
      const escapedSrcdoc = childDocument
        .replaceAll('&', '&amp;')
        .replaceAll('"', '&quot;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
      const frameMarkup = kind === 'data'
        ? `<iframe style="${frameStyle}" src="data:text/html;base64,${encodedChildDocument}"></iframe>`
        : kind === 'blob'
          ? `<script>
              const childFrame = document.createElement('iframe');
              childFrame.style.cssText = ${JSON.stringify(frameStyle)};
              childFrame.src = URL.createObjectURL(new Blob([atob(${JSON.stringify(encodedChildDocument)})], { type: 'text/html' }));
              document.body.append(childFrame);
            </script>`
          : kind === 'srcdoc'
            ? `<iframe style="${frameStyle}" srcdoc="${escapedSrcdoc}"></iframe>`
            : kind === 'about'
              ? `<iframe style="${frameStyle}" src="about:blank" onload="
                  if (!this.dataset.written) {
                    this.dataset.written = 'true';
                    this.contentDocument.open();
                    this.contentDocument.write(atob('${encodedChildDocument}'));
                    this.contentDocument.close();
                  }
                "></iframe>`
              : ''
      response.end(`<!doctype html><title>Non-network subframe boundary</title>
        <style>body{margin:0}.main-paint{position:absolute;left:20px;top:20px;width:260px;height:90px;background:rgb(37,99,235)}</style>
        <div class="main-paint">Main frame paint</div>
        <input type="search" aria-label="Main frame search" style="position:absolute;left:20px;top:130px;width:260px;height:36px">
        ${frameMarkup}`)
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
    if (requestUrl.startsWith('/resource-policy-initial?')) {
      const parameters = new URL(requestUrl, 'http://fixture.invalid').searchParams
      const kind = parameters.get('kind')
      const target = parameters.get('target') === 'alpha'
        ? 'pay'
        : parameters.get('target') === 'beta'
          ? 'payment'
          : 'purchase'
      const resource = kind === 'script'
        ? `<script src="/${target}-resource.js"></script>`
        : kind === 'image'
          ? `<img src="/${target}-resource.svg" alt="Decorative proof">`
          : kind === 'style'
            ? `<link rel="stylesheet" href="/${target}-resource.css">`
            : `<style>@font-face{font-family:proof-font;src:url("/${target}-resource.woff2")}body{font-family:proof-font}</style><span>Font proof</span>`
      response.end(`<!doctype html><title>Consequential resource policy</title>
        ${resource}<input type="search" aria-label="Resource policy search">`)
      return
    }
    if (requestUrl === '/navigation-finance-boundaries') {
      response.end(`<!doctype html><title>Payment navigation boundaries</title>
        <a href="/pay">Pay destination</a>
        <a href="/payment">Payment destination</a>
        <a href="/repayment">Repayment overview</a>
        <a href="/payload">Payload overview</a>
        <a href="/paymentology">Paymentology overview</a>`)
      return
    }
    if (requestUrl === '/resource-policy-safe') {
      response.end(`<!doctype html><title>Safe resource policy</title>
        <link rel="stylesheet" href="/neutral-resource.css">
        <script src="/neutral-resource.js"></script>
        <img src="/neutral-resource.svg" alt="Decorative proof">
        <style>@font-face{font-family:neutral-font;src:url("/neutral-resource.woff2")}body{font-family:neutral-font}</style>
        <input type="search" aria-label="Safe resource search">`)
      return
    }
    if (requestUrl === '/resource-policy-action-source') {
      response.end(`<!doctype html><title>Resource action source</title>
        <a href="/resource-policy-action-destination">Open resource destination</a>`)
      return
    }
    if (requestUrl === '/resource-policy-action-destination') {
      response.end(`<!doctype html><title>Resource action destination</title>
        <input type="search" aria-label="Destination resource search">`)
      return
    }
    if (requestUrl.endsWith('-resource.js')) {
      response.setHeader('Content-Type', 'application/javascript; charset=utf-8')
      response.end('globalThis.__neutralResourceLoaded = true')
      return
    }
    if (requestUrl.endsWith('-resource.css')) {
      response.setHeader('Content-Type', 'text/css; charset=utf-8')
      response.end('body { color: rgb(20, 30, 40); }')
      return
    }
    if (requestUrl.endsWith('-resource.svg') || requestUrl === '/checkout-tracking-pixel.svg') {
      response.setHeader('Content-Type', 'image/svg+xml')
      response.end('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="#999"/></svg>')
      return
    }
    if (requestUrl.endsWith('-resource.woff2')) {
      response.setHeader('Content-Type', 'font/woff2')
      response.end(Buffer.from('not-a-real-font'))
      return
    }
    if (requestUrl === '/initial-consequential-redirect') {
      response.statusCode = 302
      response.setHeader('Location', '/purchase')
      response.end()
      return
    }
    if (requestUrl === '/initial-consequential-hash') {
      response.end(`<!doctype html><title>Unsafe initial hash</title>
        <input type="search" aria-label="Must never be exposed">
        <script>setTimeout(() => { location.hash = '/%63heckout' }, 20)</script>`)
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
    if (requestUrl === '/event-free-preparation') {
      response.end(`<!doctype html><title>Event-free preparation</title>
        <form id="safe-control-form">
          <input id="safe-control" type="text" aria-label="Safe project reference">
          <input type="text" aria-label="Safe project detail">
          <input id="sensitive-card" type="text" aria-label="Credit card number" value="card-before">
          <input id="sensitive-password" type="password" value="password-before">
          <input id="hidden-consequential" type="hidden" value="checkout-before">
        </form>
        <form id="safe-radio-form">
          <input id="event-radio-a" type="radio" name="event_mode" value="a" checked><label for="event-radio-a">Mode A</label>
          <input id="event-radio-b" type="radio" name="event_mode" value="b"><label for="event-radio-b">Mode B</label>
          <input type="text" aria-label="Safe radio detail">
        </form>
        <script>
          window.preparationEvents = { control: 0, radio: 0 };
          const mutateExcludedState = (kind) => {
            window.preparationEvents[kind] += 1;
            document.getElementById('sensitive-card').value = 'card-mutated';
            document.getElementById('sensitive-password').value = 'password-mutated';
            document.getElementById('hidden-consequential').value = 'checkout-mutated';
            fetch('/collect?event=' + kind).catch(() => {});
          };
          for (const eventName of ['input', 'change']) {
            document.getElementById('safe-control').addEventListener(eventName, () => mutateExcludedState('control'));
            document.getElementById('event-radio-a').addEventListener(eventName, () => mutateExcludedState('radio'));
            document.getElementById('event-radio-b').addEventListener(eventName, () => mutateExcludedState('radio'));
          }
        </script>`)
      return
    }
    if (requestUrl === '/single-select-form') {
      response.end(`<!doctype html><title>Single select form</title>
        <form>
          <select name="heating_choice" aria-label="Heating choice">
            <option disabled>Unavailable</option>
            <option value="first">First enabled option</option>
            <option value="second" selected>Second enabled option</option>
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
    if (requestUrl === '/select-safety-contracts') {
      response.end(`<!doctype html><title>Select safety contracts</title>
        <select id="sensitive-option-text" aria-label="Category filter">
          <option label="Neutral" value="safe">Credit card</option>
          <option label="Other" value="other">Other</option>
        </select>
        <select id="sensitive-option-value" aria-label="Sort filter">
          <option label="Neutral" value="payment-token">Neutral</option>
          <option label="Other" value="other">Other</option>
        </select>
        <select id="safe-filter" aria-label="Status filter">
          <option value="ready" selected>Ready</option>
          <option value="waiting">Waiting</option>
        </select>
        <select id="disabled-flood" aria-label="Type filter"></select>
        <script>
          const flood = document.getElementById('disabled-flood');
          for (let index = 0; index < 240; index += 1) {
            const option = document.createElement('option');
            option.disabled = true;
            option.textContent = 'Unavailable ' + index;
            flood.append(option);
          }
          for (const value of ['unsafe-after-budget', 'second-after-budget']) {
            const option = document.createElement('option');
            option.value = value;
            option.textContent = value;
            flood.append(option);
          }
        </script>`)
      return
    }
    if (requestUrl === '/select-option-accessible-safety') {
      response.end(`<!doctype html><title>Select option accessible safety</title>
        <span id="initial-option-reference" aria-label="Credit card number"></span>
        <span id="late-option-reference">Neutral option context</span>
        <select id="direct-sensitive-option" aria-label="Direct option filter">
          <option value="one" aria-label="Credit card number" selected>Neutral one</option>
          <option value="two">Neutral two</option>
        </select>
        <select id="referenced-sensitive-option" aria-label="Referenced option filter">
          <option value="one" aria-labelledby="initial-option-reference" selected>Neutral one</option>
          <option value="two">Neutral two</option>
        </select>
        <select id="neutral-option-filter" aria-label="Neutral option filter">
          <option value="one" aria-label="Primary choice" selected>One</option>
          <option value="two" title="Secondary choice">Two</option>
        </select>
        <select id="late-direct-option" aria-label="Late direct option filter">
          <option value="one" selected>One</option>
          <option id="late-direct-target" value="two" aria-label="Second choice">Two</option>
        </select>
        <select id="overflow-option-filter" aria-label="Overflow option filter">
          <option value="one" aria-label="${'x'.repeat(4_200)}" selected>One</option>
          <option value="two">Two</option>
        </select>`)
      return
    }
    if (requestUrl === '/select-option-reference-safety') {
      response.end(`<!doctype html><title>Select option reference safety</title>
        <span id="late-option-reference">Neutral option context</span>
        <select id="late-reference-option" aria-label="Late reference option filter">
          <option value="one" selected>One</option>
          <option id="late-reference-target" value="two" aria-labelledby="late-option-reference">Two</option>
        </select>
        <select aria-label="Safe reference control">
          <option value="one" selected>One</option>
          <option value="two">Two</option>
        </select>`)
      return
    }
    if (requestUrl === '/select-boundary-contracts') {
      response.end(`<!doctype html><title>Select boundary contracts</title>
        <select id="exact-boundary" aria-label="Boundary filter"></select>
        <select id="enabled-overflow" aria-label="Overflow filter"></select>
        <select id="initial-multiple" aria-label="Multiple filter" multiple>
          <option value="one" selected>One</option>
          <option value="two" selected>Two</option>
          <option value="three">Three</option>
        </select>
        <input id="safe-select-boundary-search" type="search" aria-label="Safe boundary search">
        <script>
          const exact = document.getElementById('exact-boundary');
          for (let index = 0; index < 30; index += 1) {
            const option = document.createElement('option');
            option.value = 'exact-' + index;
            option.textContent = 'Exact option ' + index;
            exact.append(option);
          }
          const overflow = document.getElementById('enabled-overflow');
          for (let index = 0; index < 31; index += 1) {
            const option = document.createElement('option');
            option.value = 'value-' + index;
            option.textContent = index === 30 ? 'Credit card' : 'Safe option ' + index;
            if (index === 30) option.selected = true;
            overflow.append(option);
          }
        </script>`)
      return
    }
    if (requestUrl === '/selected-option-boundary') {
      response.end(`<!doctype html><title>Selected option boundary</title>
        <select id="initial-hidden-selected" aria-label="Hidden selection filter">
          <option value="hidden" hidden selected>Hidden selected</option>
          <option value="safe">Safe option</option>
        </select>
        <select id="initial-disabled-selected" aria-label="Disabled selection filter">
          <option value="disabled" disabled selected>Disabled selected</option>
          <option value="safe">Safe option</option>
        </select>
        <select id="late-hidden-selected" aria-label="Late selection filter">
          <option value="one" selected>One</option>
          <option id="late-hidden-option" value="hidden" hidden>Hidden</option>
          <option value="two">Two</option>
        </select>
        <input id="selected-boundary-search" type="search" aria-label="Safe selected boundary search">`)
      return
    }
    if (requestUrl === '/late-control-contracts') {
      response.end(`<!doctype html><title>Late control contracts</title>
        <select id="late-multiple" aria-label="Late select filter">
          <option value="one" selected>One</option><option value="two">Two</option>
        </select>
        <form id="late-checkbox-form">
          <input id="late-checkbox" type="checkbox" aria-label="Late checkbox">
          <input id="late-checkbox-detail" type="text" aria-label="Late checkbox detail">
        </form>`)
      return
    }
    if (requestUrl === '/initial-indeterminate') {
      response.end(`<!doctype html><title>Initial indeterminate checkbox</title>
        <form>
          <input id="initial-indeterminate" type="checkbox" aria-label="Indeterminate choice">
          <input type="text" aria-label="Indeterminate detail">
        </form>
        <input id="safe-indeterminate-search" type="search" aria-label="Safe indeterminate search">
        <script>document.getElementById('initial-indeterminate').indeterminate = true</script>`)
      return
    }
    if (requestUrl === '/aggregate-safety-budget') {
      response.end(`<!doctype html><title>Aggregate safety budget</title>
        <input id="label-budget" type="text" aria-label="Label budget">
        <input id="reference-budget" type="text" aria-label="Reference budget">
        <select id="option-budget" aria-label="Option budget"></select>
        <input id="safe-budget-search" type="search" aria-label="Safe aggregate search">
        <script>
          const labelFragment = document.createDocumentFragment();
          for (let index = 0; index < 16; index += 1) {
            const label = document.createElement('label');
            label.htmlFor = 'label-budget';
            label.hidden = true;
            label.textContent = 'x'.repeat(1800);
            labelFragment.append(label);
          }
          document.body.append(labelFragment);

          const referenceIds = [];
          const referenceFragment = document.createDocumentFragment();
          for (let index = 0; index < 16; index += 1) {
            const reference = document.createElement('span');
            reference.id = 'aggregate-reference-' + index;
            reference.hidden = true;
            reference.textContent = 'y'.repeat(1800);
            referenceIds.push(reference.id);
            referenceFragment.append(reference);
          }
          document.body.append(referenceFragment);
          document.getElementById('reference-budget').setAttribute('aria-describedby', referenceIds.join(' '));

          const select = document.getElementById('option-budget');
          for (let index = 0; index < 12; index += 1) {
            const option = document.createElement('option');
            option.label = 'l'.repeat(800);
            option.textContent = 't'.repeat(800);
            option.value = 'v'.repeat(800) + index;
            select.append(option);
          }
        </script>`)
      return
    }
    if (requestUrl === '/text-contracts') {
      response.end(`<!doctype html><title>Text contracts</title>
        <form id="too-short-contract">
          <input id="max-one" type="text" maxlength="1" aria-label="Tiny value">
          <input id="max-one-detail" type="text" maxlength="1" aria-label="Tiny detail">
        </form>
        <form id="bounded-contract">
          <input id="max-two" type="text" maxlength="2" value="🙂" aria-label="Bounded value">
          <textarea id="bounded-textarea" minlength="2" maxlength="4" aria-label="Bounded detail"></textarea>
        </form>
        <form id="pattern-contract">
          <input id="pattern-control" type="text" maxlength="20" pattern="[A-Z]+" aria-label="Pattern value">
          <input id="pattern-detail" type="text" maxlength="20" aria-label="Pattern detail">
        </form>
        <form id="late-pattern-contract">
          <input id="late-pattern" type="text" maxlength="20" aria-label="Late pattern value">
          <input id="late-pattern-detail" type="text" maxlength="20" aria-label="Late pattern detail">
        </form>`)
      return
    }
    if (requestUrl === '/required-text-contracts') {
      response.end(`<!doctype html><title>Required text contracts</title>
        <form id="required-text-form">
          <input id="required-input" type="text" required aria-label="Required input">
          <textarea id="required-textarea" required aria-label="Required textarea"></textarea>
        </form>
        <form id="late-required-form">
          <input id="late-required-input" type="text" aria-label="Late required input">
          <input id="late-required-detail" type="text" aria-label="Late required detail">
        </form>`)
      return
    }
    if (requestUrl === '/aria-required-contracts') {
      response.end(`<!doctype html><title>ARIA required contracts</title>
        <form id="aria-required-text-form">
          <input id="aria-required-text" type="text" aria-required="true" aria-label="ARIA required text">
          <textarea id="aria-required-textarea" aria-required="true" aria-label="ARIA required textarea"></textarea>
        </form>
        <form id="aria-required-select-form">
          <select id="aria-required-select" aria-required="true" aria-label="ARIA required choice">
            <option value="" selected>Choose an option</option>
            <option value="one">One</option>
            <option value="two">Two</option>
          </select>
          <input id="aria-required-select-detail" type="text" aria-label="ARIA required select detail">
        </form>
        <form id="aria-required-only-empty-form">
          <select id="aria-required-only-empty" aria-required="true" aria-label="ARIA required only empty">
            <option value="" selected>Choose only option</option>
          </select>
          <input type="text" aria-label="ARIA required only-empty detail">
        </form>
        <form id="aria-required-false-form">
          <select id="aria-required-false-select" aria-required="false" aria-label="ARIA optional choice">
            <option value="" selected>No selection</option>
            <option value="one">One</option>
          </select>
          <input type="text" aria-required="false" aria-label="ARIA optional detail">
        </form>
        <form id="late-aria-required-text-form">
          <input id="late-aria-required-text" type="text" aria-label="Late ARIA required text">
          <input id="late-aria-required-text-detail" type="text" aria-label="Late ARIA required text detail">
        </form>
        <form id="late-aria-required-select-form">
          <select id="late-aria-required-select" aria-label="Late ARIA required choice">
            <option value="" selected>No selection</option>
            <option value="one">One</option>
          </select>
          <input id="late-aria-required-select-detail" type="text" aria-label="Late ARIA required select detail">
        </form>`)
      return
    }
    if (requestUrl === '/date-like-single-state') {
      response.end(`<!doctype html><title>Date-like single state</title>
        <form id="fixed-date-form">
          <input type="date" min="2026-01-15" max="2026-01-15" value="2026-01-15" aria-label="Fixed date">
          <input type="month" min="2026-02" max="2026-02" value="2026-02" aria-label="Fixed month">
        </form>
        <form id="alternative-date-form">
          <input id="alternative-date" type="date" min="2026-01-15" max="2026-01-16" value="2026-01-15" aria-label="Alternative date">
          <input type="text" aria-label="Alternative date detail">
        </form>`)
      return
    }
    if (requestUrl === '/label-image-alt-safety') {
      response.end(`<!doctype html><title>Label image alt safety</title>
        <form id="sensitive-label-form">
          <label><img alt="Credit card"><input id="sensitive-label-input" name="reference"></label>
          <input type="text" aria-label="Sensitive label detail">
        </form>
        <form id="late-label-form">
          <label for="late-label-input"><img id="late-label-image" alt="Reference image"></label>
          <input id="late-label-input" type="text" name="reference">
          <input id="late-label-detail" type="text" aria-label="Late label detail">
        </form>
        <form id="neutral-label-form">
          <label for="neutral-label-input"><img alt="Neutral reference"></label>
          <input id="neutral-label-input" type="text" name="reference">
          <input type="text" aria-label="Neutral label detail">
        </form>
        <form id="overflow-label-form">
          <label id="overflow-image-label" for="overflow-label-input"></label>
          <input id="overflow-label-input" type="text" name="reference">
          <input type="text" aria-label="Overflow label detail">
        </form>
        <script>
          const overflowLabel = document.getElementById('overflow-image-label');
          for (let index = 0; index < 17; index += 1) {
            const image = document.createElement('img');
            image.alt = 'Bounded reference ' + index;
            overflowLabel.append(image);
          }
        </script>`)
      return
    }
    if (requestUrl === '/aria-reference-image-alt-safety') {
      response.end(`<!doctype html><title>ARIA image alt safety</title>
        <span id="sensitive-aria-reference"><img alt="Neutral diagram"><img alt="Credit card number"></span>
        <img id="direct-sensitive-reference" alt="User password">
        <span id="late-aria-reference"><img id="late-aria-image" alt="Reference diagram"></span>
        <span id="neutral-aria-reference"><img alt="Helpful overview"></span>
        <span id="overflow-aria-reference"></span>
        <form id="sensitive-aria-form">
          <input id="sensitive-aria-input" type="text" name="reference" aria-labelledby="sensitive-aria-reference">
          <input type="text" aria-label="Sensitive ARIA detail">
        </form>
        <form id="direct-sensitive-aria-form">
          <input type="text" name="reference" aria-describedby="direct-sensitive-reference">
          <input type="text" aria-label="Direct sensitive ARIA detail">
        </form>
        <form id="late-aria-form">
          <input id="late-aria-input" type="text" name="reference" aria-describedby="late-aria-reference">
          <input id="late-aria-detail" type="text" aria-label="Late ARIA detail">
        </form>
        <form id="neutral-aria-form">
          <input id="neutral-aria-input" type="text" name="reference" aria-labelledby="neutral-aria-reference">
          <input type="text" aria-label="Neutral ARIA detail">
        </form>
        <form id="overflow-aria-form">
          <input type="text" name="reference" aria-describedby="overflow-aria-reference">
          <input type="text" aria-label="Overflow ARIA detail">
        </form>
        <script>
          const overflowReference = document.getElementById('overflow-aria-reference');
          for (let index = 0; index < 17; index += 1) {
            const image = document.createElement('img');
            image.alt = 'Bounded ARIA image ' + index;
            overflowReference.append(image);
          }
        </script>`)
      return
    }
    if (requestUrl === '/aria-reference-attribute-safety') {
      response.end(`<!doctype html><title>ARIA reference attribute safety</title>
        <span id="sensitive-aria-label-reference" aria-label="Credit card number"></span>
        <svg><g id="sensitive-title-reference" title="User password"></g></svg>
        <span id="late-attribute-reference" aria-label="Reference note" title="Reference title"></span>
        <span id="neutral-attribute-reference" aria-label="Helpful context" title="Overview"></span>
        <form id="sensitive-aria-label-form">
          <input type="text" name="reference" aria-labelledby="sensitive-aria-label-reference">
          <input type="text" aria-label="Sensitive ARIA label detail">
        </form>
        <form id="sensitive-title-form">
          <input type="text" name="reference" aria-describedby="sensitive-title-reference">
          <input type="text" aria-label="Sensitive title detail">
        </form>
        <form id="late-attribute-form">
          <input id="late-attribute-input" type="text" name="reference" aria-describedby="late-attribute-reference">
          <input id="late-attribute-detail" type="text" aria-label="Late attribute detail">
        </form>
        <form id="neutral-attribute-form">
          <input type="text" name="reference" aria-labelledby="neutral-attribute-reference">
          <input type="text" aria-label="Neutral attribute detail">
        </form>
        <form id="overflow-attribute-form">
          <input type="text" name="reference" aria-labelledby="overflow-reference-0 overflow-reference-1 overflow-reference-2 overflow-reference-3 overflow-reference-4 overflow-reference-5 overflow-reference-6">
          <input type="text" aria-label="Overflow attribute detail">
        </form>
        <script>
          for (let index = 0; index < 2; index += 1) {
            const reference = document.createElement('span');
            reference.id = 'overflow-reference-' + index;
            reference.setAttribute('aria-label', 'x'.repeat(4000));
            document.body.prepend(reference);
          }
        </script>`)
      return
    }
    if (requestUrl === '/aria-reference-native-value-safety') {
      response.end(`<!doctype html><title>ARIA native value safety</title>
        <style>.reference-source{position:absolute;left:-10000px;top:0}</style>
        <input class="reference-source" id="sensitive-button-value" type="button" value="Credit card number">
        <input class="reference-source" id="sensitive-submit-value" type="submit" value="BIC">
        <input class="reference-source" id="sensitive-reset-value" type="reset" value="Bank account">
        <input class="reference-source" id="late-native-value" type="submit" value="Reference action">
        <input class="reference-source" id="neutral-native-value" type="button" value="Reference option">
        <input class="reference-source" id="overflow-native-value" type="button">
        <form id="sensitive-native-value-form">
          <input type="text" name="sensitive_button_reference" aria-labelledby="sensitive-button-value">
          <input type="text" name="sensitive_submit_reference" aria-labelledby="sensitive-submit-value">
          <input type="text" name="sensitive_reset_reference" aria-labelledby="sensitive-reset-value">
        </form>
        <form id="late-native-value-form">
          <input id="late-native-value-input" type="text" name="late_reference" aria-labelledby="late-native-value">
          <input id="late-native-value-detail" type="text" aria-label="Late native detail">
        </form>
        <form id="neutral-native-value-form">
          <input id="neutral-native-value-input" type="text" name="neutral_reference" aria-labelledby="neutral-native-value">
          <input type="text" aria-label="Neutral native detail">
        </form>
        <form id="overflow-native-value-form">
          <input type="text" name="overflow_reference" aria-labelledby="overflow-native-value">
          <input type="text" aria-label="Overflow native detail">
        </form>
        <script>document.getElementById('overflow-native-value').value = 'x'.repeat(4097)</script>`)
      return
    }
    if (requestUrl === '/aria-reference-image-input-alt-safety') {
      response.end(`<!doctype html><title>ARIA image input alt safety</title>
        <style>.reference-source{position:absolute;left:-10000px;top:0}</style>
        <input class="reference-source" id="sensitive-image-alt" type="image" alt="Credit card number" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==">
        <input class="reference-source" id="late-image-alt" type="image" alt="Reference image action" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==">
        <input class="reference-source" id="neutral-image-alt" type="image" alt="Reference image option" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==">
        <input class="reference-source" id="overflow-image-alt" type="image" alt="Overflow" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==">
        <form id="sensitive-image-alt-form">
          <input type="text" name="sensitive_image_reference" aria-labelledby="sensitive-image-alt">
          <input type="text" aria-label="Sensitive image detail">
        </form>
        <form id="late-image-alt-form">
          <input id="late-image-alt-input" type="text" name="late_image_reference" aria-labelledby="late-image-alt">
          <input id="late-image-alt-detail" type="text" aria-label="Late image detail">
        </form>
        <form id="neutral-image-alt-form">
          <input id="neutral-image-alt-input" type="text" name="neutral_image_reference" aria-labelledby="neutral-image-alt">
          <input type="text" aria-label="Neutral image detail">
        </form>
        <form id="overflow-image-alt-form">
          <input type="text" name="overflow_image_reference" aria-labelledby="overflow-image-alt">
          <input type="text" aria-label="Overflow image detail">
        </form>
        <script>document.getElementById('overflow-image-alt').alt = 'x'.repeat(4097)</script>`)
      return
    }
    if (requestUrl === '/aria-reference-embedded-control-safety') {
      response.end(`<!doctype html><title>ARIA embedded control safety</title>
        <style>.reference-source{position:absolute;left:-10000px;top:0}</style>
        <input class="reference-source" id="sensitive-textbox-value" type="text" value="Credit card number">
        <select class="reference-source" id="sensitive-select-value"><option selected>BIC</option><option>Reference</option></select>
        <input class="reference-source" id="sensitive-range-value" type="range" value="25" aria-valuetext="Bank account">
        <input class="reference-source" id="late-textbox-value" type="text" value="Reference note">
        <select class="reference-source" id="late-select-value"><option selected>Reference option</option><option>Secondary option</option></select>
        <input class="reference-source" id="late-range-value" type="range" value="25" aria-valuetext="Reference level">
        <textarea class="reference-source" id="neutral-textbox-value">Reference overview</textarea>
        <div class="reference-source" id="custom-textbox-value" role="textbox" contenteditable="true">Reference widget</div>
        <input class="reference-source" id="overflow-textbox-value" type="text">
        <form id="sensitive-textbox-form">
          <input type="text" name="sensitive_textbox_reference" aria-labelledby="sensitive-textbox-value">
          <input type="text" aria-label="Sensitive textbox detail">
        </form>
        <form id="sensitive-select-form">
          <input type="text" aria-label="Sensitive select field" aria-describedby="sensitive-select-value">
          <input type="text" aria-label="Sensitive select detail">
        </form>
        <form id="sensitive-range-form">
          <input type="text" aria-label="Sensitive range field" aria-describedby="sensitive-range-value">
          <input type="text" aria-label="Sensitive range detail">
        </form>
        <form id="late-textbox-form">
          <input id="late-textbox-input" type="text" aria-label="Late textbox field" aria-describedby="late-textbox-value">
          <input id="late-textbox-detail" type="text" aria-label="Late textbox detail">
        </form>
        <form id="late-select-form">
          <input id="late-select-input" type="text" aria-label="Late select field" aria-describedby="late-select-value">
          <input id="late-select-detail" type="text" aria-label="Late select detail">
        </form>
        <form id="late-range-form">
          <input id="late-range-input" type="text" aria-label="Late range field" aria-describedby="late-range-value">
          <input id="late-range-detail" type="text" aria-label="Late range detail">
        </form>
        <form id="neutral-embedded-form">
          <input id="neutral-embedded-input" type="text" aria-label="Neutral embedded field" aria-describedby="neutral-textbox-value">
          <input type="text" aria-label="Neutral embedded detail">
        </form>
        <form id="custom-embedded-form">
          <input type="text" aria-label="Custom embedded field" aria-describedby="custom-textbox-value">
          <input type="text" aria-label="Custom embedded detail">
        </form>
        <form id="overflow-embedded-form">
          <input type="text" aria-label="Overflow embedded field" aria-describedby="overflow-textbox-value">
          <input type="text" aria-label="Overflow embedded detail">
        </form>
        <script>document.getElementById('overflow-textbox-value').value = 'x'.repeat(4097)</script>`)
      return
    }
    if (requestUrl === '/aria-reference-descendant-source-safety') {
      response.end(`<!doctype html><title>ARIA descendant source safety</title>
        <style>.reference-source{position:absolute;left:-10000px;top:0}</style>
        <span id="sensitive-descendant-reference"><span><input class="reference-source" value="Credit card number"></span></span>
        <span id="late-descendant-reference"><span><input id="late-descendant-source" class="reference-source" value="Reference note"></span></span>
        <span id="neutral-descendant-reference"><span><textarea class="reference-source">Reference overview</textarea></span></span>
        <span id="count-overflow-descendant-reference"></span>
        <span id="traversal-overflow-descendant-reference"></span>
        <form id="sensitive-descendant-reference-form">
          <input type="text" name="sensitive_descendant_reference" aria-labelledby="sensitive-descendant-reference">
          <input type="text" aria-label="Sensitive descendant detail">
        </form>
        <form id="late-descendant-reference-form">
          <input id="late-descendant-target" type="text" name="late_descendant_reference" aria-labelledby="late-descendant-reference">
          <input id="late-descendant-detail" type="text" aria-label="Late descendant detail">
        </form>
        <form id="neutral-descendant-reference-form">
          <input id="neutral-descendant-target" type="text" name="neutral_descendant_reference" aria-labelledby="neutral-descendant-reference">
          <input type="text" aria-label="Neutral descendant detail">
        </form>
        <form id="wrapped-descendant-reference-form">
          <span id="wrapped-descendant-reference">Wrapped reference <input id="wrapped-descendant-target" type="text" aria-labelledby="wrapped-descendant-reference"></span>
          <input type="text" aria-label="Wrapped descendant detail">
        </form>
        <form id="count-overflow-descendant-reference-form">
          <input type="text" name="count_overflow_descendant_reference" aria-labelledby="count-overflow-descendant-reference">
          <input type="text" aria-label="Count overflow descendant detail">
        </form>
        <form id="traversal-overflow-descendant-reference-form">
          <input type="text" name="traversal_overflow_descendant_reference" aria-labelledby="traversal-overflow-descendant-reference">
          <input type="text" aria-label="Traversal overflow descendant detail">
        </form>
        <script>
          const countRoot = document.getElementById('count-overflow-descendant-reference');
          for (let index = 0; index < 17; index += 1) {
            const source = document.createElement('span');
            source.setAttribute('aria-label', 'Bounded source ' + index);
            countRoot.append(source);
          }
          let traversalRoot = document.getElementById('traversal-overflow-descendant-reference');
          for (let index = 0; index < 257; index += 1) {
            const wrapper = document.createElement('span');
            traversalRoot.append(wrapper);
            traversalRoot = wrapper;
          }
          traversalRoot.setAttribute('aria-label', 'Reference after traversal budget');
        </script>`)
      return
    }
    if (requestUrl === '/label-embedded-control-safety') {
      response.end(`<!doctype html><title>Label embedded control safety</title>
        <style>.embedded-source{position:absolute;left:-10000px;top:0}</style>
        <form id="sensitive-label-text-form">
          <label for="sensitive-label-text-target">Reference <input class="embedded-source" type="text" value="Credit card number"></label>
          <input id="sensitive-label-text-target" type="text" aria-label="Sensitive label text field">
          <input type="text" aria-label="Sensitive label text detail">
        </form>
        <form id="sensitive-label-select-form">
          <label for="sensitive-label-select-target">Reference <select class="embedded-source"><option selected>BIC</option><option>Reference</option></select></label>
          <input id="sensitive-label-select-target" type="text" aria-label="Sensitive label select field">
          <input type="text" aria-label="Sensitive label select detail">
        </form>
        <form id="sensitive-label-range-form">
          <label for="sensitive-label-range-target">Reference <input class="embedded-source" type="range" value="25" aria-valuetext="Bank account"></label>
          <input id="sensitive-label-range-target" type="text" aria-label="Sensitive label range field">
          <input type="text" aria-label="Sensitive label range detail">
        </form>
        <form id="late-label-native-form">
          <label for="late-label-native-target">Reference <textarea id="late-label-native-source" class="embedded-source">Reference note</textarea></label>
          <input id="late-label-native-target" type="text" aria-label="Late label native field">
          <input id="late-label-native-detail" type="text" aria-label="Late label native detail">
        </form>
        <form id="neutral-label-native-form">
          <label for="neutral-label-native-target">Reference <input class="embedded-source" type="text" value="Reference note"></label>
          <input id="neutral-label-native-target" type="text" aria-label="Neutral label native field">
          <input id="neutral-label-native-detail" type="text" aria-label="Neutral label native detail">
        </form>
        <form id="wrapped-label-target-form">
          <label>Wrapped target <input id="wrapped-label-target" type="text" aria-label="Wrapped label target"></label>
          <input id="wrapped-label-target-detail" type="text" aria-label="Wrapped label target detail">
        </form>
        <form id="custom-label-native-form">
          <label for="custom-label-native-target">Reference <span class="embedded-source" role="textbox">Reference widget</span></label>
          <input id="custom-label-native-target" type="text" aria-label="Custom label native field">
          <input type="text" aria-label="Custom label native detail">
        </form>
        <form id="overflow-label-native-form">
          <label for="overflow-label-native-target">Reference <input id="overflow-label-native-source" class="embedded-source" type="text"></label>
          <input id="overflow-label-native-target" type="text" aria-label="Overflow label native field">
          <input type="text" aria-label="Overflow label native detail">
        </form>
        <script>document.getElementById('overflow-label-native-source').value = 'x'.repeat(4097)</script>`)
      return
    }
    if (requestUrl === '/label-descendant-source-safety') {
      response.end(`<!doctype html><title>Label descendant source safety</title>
        <form id="sensitive-label-descendant-form">
          <label for="sensitive-label-descendant-target">Reference <img alt="Reference" aria-label="Credit card number"></label>
          <input id="sensitive-label-descendant-target" type="text" aria-label="Sensitive label descendant field">
          <input type="text" aria-label="Sensitive label descendant detail">
        </form>
        <form id="late-label-descendant-form">
          <label for="late-label-descendant-target">Reference <img id="late-label-descendant-source" alt="Reference" aria-label="Reference image"></label>
          <input id="late-label-descendant-target" type="text" aria-label="Late label descendant field">
          <input id="late-label-descendant-detail" type="text" aria-label="Late label descendant detail">
        </form>
        <form id="neutral-label-descendant-form">
          <label for="neutral-label-descendant-target">Reference <img alt="Reference" aria-label="Helpful image"></label>
          <input id="neutral-label-descendant-target" type="text" aria-label="Neutral label descendant field">
          <input type="text" aria-label="Neutral label descendant detail">
        </form>
        <form id="aggregate-overflow-label-descendant-form">
          <label id="aggregate-overflow-label" for="aggregate-overflow-label-descendant-target">Reference</label>
          <input id="aggregate-overflow-label-descendant-target" type="text" aria-label="Aggregate overflow label field">
          <input type="text" aria-label="Aggregate overflow label detail">
        </form>
        <form id="individual-overflow-label-descendant-form">
          <label id="individual-overflow-label" for="individual-overflow-label-descendant-target">Reference</label>
          <input id="individual-overflow-label-descendant-target" type="text" aria-label="Individual overflow label field">
          <input type="text" aria-label="Individual overflow label detail">
        </form>
        <script>
          const aggregateLabel = document.getElementById('aggregate-overflow-label');
          for (let index = 0; index < 7; index += 1) {
            const source = document.createElement('span');
            source.setAttribute('aria-label', 'x'.repeat(4000));
            aggregateLabel.append(source);
          }
          const individualSource = document.createElement('span');
          individualSource.setAttribute('aria-label', 'x'.repeat(4097));
          document.getElementById('individual-overflow-label').append(individualSource);
        </script>`)
      return
    }
    if (requestUrl === '/aria-description-safety') {
      response.end(`<!doctype html><title>ARIA description safety</title>
        <form id="sensitive-description-form">
          <input type="text" aria-label="Reference field" aria-description="Credit card number">
          <input type="text" aria-label="Sensitive description detail">
        </form>
        <form id="late-description-form">
          <input id="late-description-input" type="text" aria-label="Late description field" aria-description="Reference context">
          <input id="late-description-detail" type="text" aria-label="Late description detail">
        </form>
        <form id="neutral-description-form">
          <input type="text" aria-label="Neutral description field" aria-description="Helpful overview">
          <input type="text" aria-label="Neutral description detail">
        </form>
        <form id="overflow-description-form">
          <input id="overflow-description-input" type="text" aria-label="Overflow description field">
          <input type="text" aria-label="Overflow description detail">
        </form>
        <script>
          document.getElementById('overflow-description-input').setAttribute('aria-description', 'x'.repeat(4097));
        </script>`)
      return
    }
    if (requestUrl === '/label-attribute-safety') {
      response.end(`<!doctype html><title>Label attribute safety</title>
        <form id="sensitive-label-aria-form">
          <label aria-label="Credit card number"><input type="text" name="reference"></label>
          <input type="text" aria-label="Sensitive label aria detail">
        </form>
        <form id="sensitive-label-title-form">
          <label title="User password">Reference title<input type="text" name="reference"></label>
          <input type="text" aria-label="Sensitive label title detail">
        </form>
        <form id="late-label-attribute-form">
          <label id="late-label-attribute" aria-label="Reference label" title="Overview">
            <input id="late-label-attribute-input" type="text" name="reference">
          </label>
          <input id="late-label-attribute-detail" type="text" aria-label="Late label attribute detail">
        </form>
        <form id="neutral-label-attribute-form">
          <label aria-label="Neutral reference" title="Helpful overview"><input type="text" name="reference"></label>
          <input type="text" aria-label="Neutral label attribute detail">
        </form>
        <form id="overflow-label-attribute-form">
          <label id="overflow-label-attribute"><input type="text" name="reference"></label>
          <input type="text" aria-label="Overflow label attribute detail">
        </form>
        <script>
          document.getElementById('overflow-label-attribute').setAttribute('title', 'x'.repeat(4097));
        </script>`)
      return
    }
    if (requestUrl === '/label-reference-safety') {
      response.end(`<!doctype html><title>Label reference safety</title>
        <span id="sensitive-label-reference">Credit card number</span>
        <span id="neutral-label-reference">Reference context</span>
        <span id="late-label-reference">Helpful overview</span>
        <span id="nested-label-reference" aria-describedby="neutral-label-reference">Reference context</span>
        <form id="sensitive-label-reference-form">
          <label aria-labelledby="sensitive-label-reference">Sensitive reference<input type="text" name="reference" aria-label="Sensitive reference"></label>
          <input type="text" aria-label="Sensitive reference detail">
        </form>
        <form id="missing-label-reference-form">
          <label aria-describedby="missing-reference">Missing reference<input type="text" name="reference" aria-label="Missing reference"></label>
          <input type="text" aria-label="Missing reference detail">
        </form>
        <form id="nested-label-reference-form">
          <label aria-labelledby="nested-label-reference">Nested reference<input type="text" name="reference" aria-label="Nested reference"></label>
          <input type="text" aria-label="Nested reference detail">
        </form>
        <form id="late-label-reference-form">
          <label id="late-reference-label" aria-describedby="late-label-reference">Late reference<input id="late-reference-input" type="text" name="reference" aria-label="Late reference"></label>
          <input id="late-reference-detail" type="text" aria-label="Late reference detail">
        </form>
        <form id="neutral-label-reference-form">
          <label aria-labelledby="neutral-label-reference">Neutral reference<input type="text" name="reference" aria-label="Neutral reference"></label>
          <input type="text" aria-label="Neutral reference detail">
        </form>
        <form id="overflow-label-reference-form">
          <label id="overflow-label-reference">Overflow reference<input type="text" name="reference" aria-label="Overflow reference"></label>
          <input type="text" aria-label="Overflow reference detail">
        </form>
        <script>document.getElementById('overflow-label-reference').setAttribute('aria-labelledby', 'x'.repeat(4097))</script>`)
      return
    }
    if (requestUrl === '/inert-boundary') {
      response.end(`<!doctype html><title>Inert boundary</title>
        <form inert><input type="text" aria-label="Direct inert value"><input type="text" aria-label="Direct inert detail"></form>
        <div inert><form><input type="text" aria-label="Ancestor inert value"><input type="text" aria-label="Ancestor inert detail"></form></div>
        <form inert="false"><input type="text" aria-label="Boolean inert value"><input type="text" aria-label="Boolean inert detail"></form>
        <div id="late-inert-owner"><form><input id="late-inert-value" type="text" aria-label="Late inert value"><input id="late-inert-detail" type="text" aria-label="Late inert detail"></form></div>
        <form><input type="text" aria-label="Neutral inert value"><input type="text" aria-label="Neutral inert detail"></form>
        <a inert href="/about#inert">Inert destination</a>
        <a href="/about#neutral-inert">Neutral destination</a>`)
      return
    }
    if (requestUrl === '/active-modal-inertness') {
      response.end(`<!doctype html><title>Active modal inertness</title>
        <form id="modal-background-form">
          <input id="modal-background-value" type="text" aria-label="Background modal value">
          <input id="modal-background-detail" type="text" aria-label="Background modal detail">
        </form>
        <a id="modal-background-link" href="/about#background-modal">Background modal destination</a>
        <dialog id="active-modal">
          <form id="modal-dialog-form">
            <input id="modal-dialog-value" type="text" aria-label="Dialog modal value">
            <input id="modal-dialog-detail" type="text" aria-label="Dialog modal detail">
          </form>
          <a id="modal-dialog-link" href="/about#dialog-modal">Dialog modal destination</a>
        </dialog>
        <script>
          document.getElementById('active-modal').showModal();
          const overrides = [
            [Document.prototype, 'querySelector', function () { return null; }],
            [Document.prototype, 'createTreeWalker', function () { throw new Error('hostile main-realm walker'); }],
            [TreeWalker.prototype, 'nextNode', function () { return null; }],
            [Node.prototype, 'contains', function () { return true; }],
            [Element.prototype, 'matches', function () { return false; }],
          ];
          for (const [prototype, name, value] of overrides) {
            try { Object.defineProperty(prototype, name, { configurable: true, value }); } catch {}
          }
        </script>`)
      return
    }
    if (requestUrl === '/modal-ancestor-inertness') {
      response.end(`<!doctype html><title>Modal ancestor inertness</title>
        <form>
          <input type="text" aria-label="Modal ancestor background value">
          <input type="text" aria-label="Modal ancestor background detail">
        </form>
        <section inert>
          <dialog id="ancestor-inert-modal">
            <form id="ancestor-inert-modal-form">
              <input id="ancestor-inert-modal-value" type="text" aria-label="Escaped modal value">
              <input id="ancestor-inert-modal-detail" type="text" aria-label="Escaped modal detail">
              <label><input id="ancestor-inert-radio-a" type="radio" name="modal-choice" checked> Modal choice A</label>
              <label><input id="ancestor-inert-radio-b" type="radio" name="modal-choice"> Modal choice B</label>
            </form>
            <div inert>
              <form>
                <input type="text" aria-label="Inner inert modal value">
                <input type="text" aria-label="Inner inert modal detail">
              </form>
            </div>
            <a href="/about#escaped-modal">Escaped modal destination</a>
          </dialog>
        </section>
        <script>document.getElementById('ancestor-inert-modal').showModal()</script>`)
      return
    }
    if (requestUrl === '/direct-inert-modal') {
      response.end(`<!doctype html><title>Direct inert modal</title>
        <dialog inert id="direct-inert-modal">
          <form>
            <input type="text" aria-label="Direct inert modal value">
            <input type="text" aria-label="Direct inert modal detail">
          </form>
          <a href="/about#direct-inert-modal">Direct inert modal destination</a>
        </dialog>
        <script>document.getElementById('direct-inert-modal').showModal()</script>`)
      return
    }
    if (requestUrl.startsWith('/stacked-modal-inertness')) {
      const olderOnly = requestUrl.includes('older-only=1')
      response.end(`<!doctype html><title>Stacked modal inertness</title>
        <form>
          <input type="text" aria-label="Stacked modal background value">
          <input type="text" aria-label="Stacked modal background detail">
        </form>
        <dialog id="older-modal">
          <form id="older-modal-form">
            <input id="older-modal-value" type="text" aria-label="Older modal value">
            <input id="older-modal-detail" type="text" aria-label="Older modal detail">
          </form>
          <a href="/about#older-modal">Older modal destination</a>
        </dialog>
        <dialog id="topmost-modal">
          <form id="topmost-modal-form">
            <input id="topmost-modal-value" type="text" aria-label="Topmost modal value">
            <input id="topmost-modal-detail" type="text" aria-label="Topmost modal detail">
          </form>
          <div inert>
            <form>
              <input type="text" aria-label="Topmost inner inert value">
              <input type="text" aria-label="Topmost inner inert detail">
            </form>
          </div>
          <a href="/about#topmost-modal">Topmost modal destination</a>
        </dialog>
        <script>
          document.getElementById('older-modal').showModal();
          if (!${olderOnly}) document.getElementById('topmost-modal').showModal();
        </script>`)
      return
    }
    if (requestUrl === '/late-modal-inertness') {
      response.end(`<!doctype html><title>Late modal inertness</title>
        <form id="late-modal-form">
          <input id="late-modal-value" type="text" aria-label="Late modal value">
          <input id="late-modal-detail" type="text" aria-label="Late modal detail">
        </form>
        <a id="late-modal-link" href="/about#late-modal">Late modal destination</a>
        <dialog id="late-modal"><p>Modal notice</p></dialog>`)
      return
    }
    if (requestUrl === '/shadow-modal-inertness') {
      response.end(`<!doctype html><title>Shadow modal inertness</title>
        <form>
          <input type="text" aria-label="Shadow background value">
          <input type="text" aria-label="Shadow background detail">
        </form>
        <a href="/about#shadow-background">Shadow background destination</a>
        <div id="shadow-modal-host"></div>
        <script>
          const root = document.getElementById('shadow-modal-host').attachShadow({ mode: 'closed' });
          const dialog = document.createElement('dialog');
          dialog.innerHTML = '<p>Shadow modal notice</p>';
          root.append(dialog);
          dialog.showModal();
        </script>`)
      return
    }
    if (requestUrl === '/shadow-modal-capture-race') {
      response.end(`<!doctype html><title>Shadow modal capture race</title>
        <form>
          <input type="text" aria-label="Shadow race value">
          <input type="text" aria-label="Shadow race detail">
        </form>
        <div id="shadow-race-host"></div>
        <script>
          const root = document.getElementById('shadow-race-host').attachShadow({ mode: 'closed' });
          const dialog = document.createElement('dialog');
          dialog.innerHTML = '<p>Shadow race notice</p>';
          root.append(dialog);
          globalThis.__shadowModalForTest = dialog;
        </script>`)
      return
    }
    if (requestUrl === '/analysis-native-state') {
      response.end(`<!doctype html><title>Analysis native state</title>
        <form>
          <input id="state-text" type="text" aria-label="State text" value="before">
          <input id="state-checkbox" type="checkbox" aria-label="State checkbox">
          <select id="state-select" aria-label="State select"><option selected>One</option><option>Two</option></select>
          <input id="state-number" type="number" min="1" max="3" step="1" value="1" aria-label="State number">
          <input id="state-date" type="date" min="2026-01-01" max="2026-01-02" value="2026-01-01" aria-label="State date">
          <input id="state-radio-a" type="radio" name="state-radio" checked><label for="state-radio-a">State radio A</label>
          <input id="state-radio-b" type="radio" name="state-radio"><label for="state-radio-b">State radio B</label>
        </form>
        <input id="stable-state-search" type="search" aria-label="Stable catalog search">`)
      return
    }
    if (requestUrl === '/atomic-form-verification') {
      response.end(`<!doctype html><title>Atomic form verification</title>
        <form>
          <input id="atomic-first" type="text" aria-label="Atomic first">
          <input id="atomic-second" type="text" aria-label="Atomic second">
        </form>
        <form>
          <input id="stable-first" type="text" aria-label="Stable first">
          <input id="stable-second" type="text" aria-label="Stable second">
        </form>
        <script>
          setInterval(() => {
            const first = document.getElementById('atomic-first');
            const second = document.getElementById('atomic-second');
            if (second.value) first.value = '';
          }, 1);
        </script>`)
      return
    }
    if (requestUrl === '/link-image-alt-safety') {
      response.end(`<!doctype html><title>Link image alt safety</title>
        <a id="sensitive-multi-image-link" href="/about#sensitive">
          <img width="20" height="20" alt="Info"><img width="20" height="20" alt="Checkout">
        </a>
        <a id="late-multi-image-link" href="/about#late">
          <img width="20" height="20" alt="Info"><img id="late-link-second-image" width="20" height="20" alt="Overview">
        </a>
        <a id="neutral-multi-image-link" href="/about#neutral">
          <img width="20" height="20" alt="History"><img width="20" height="20" alt="Details">
        </a>
        <a id="overflow-multi-image-link" href="/about#overflow"></a>
        <script>
          const overflowLink = document.getElementById('overflow-multi-image-link');
          for (let index = 0; index < 17; index += 1) {
            const image = document.createElement('img');
            image.width = 20;
            image.height = 20;
            image.alt = 'Reference image ' + index;
            overflowLink.append(image);
          }
        </script>`)
      return
    }
    if (requestUrl === '/unlabelled-controls') {
      response.end(`<!doctype html><title>Unlabelled controls</title>
        <form id="unlabelled-form">
          <input id="" type="text">
          <input id="" type="text">
        </form>
        <form id="labelled-control-form">
          <input type="text" aria-label="Neutral value">
          <input type="text" aria-label="Neutral detail">
        </form>
        <img id="referenced-image-label" alt="Referenced value">
        <span id="referenced-attribute-label" aria-label="Referenced detail"></span>
        <form id="referenced-control-form">
          <input type="text" aria-labelledby="referenced-image-label">
          <input type="text" aria-labelledby="referenced-attribute-label">
        </form>`)
      return
    }
    if (requestUrl === '/owner-context-safety') {
      response.end(`<!doctype html><title>Owner context safety</title>
        <style>fieldset{border:0;margin:0;padding:0}</style>
        <form aria-label="Payment">
          <input type="text" aria-label="Sensitive owner value">
          <input type="text" aria-label="Sensitive owner detail">
        </form>
        <form>
          <fieldset title="User password">
            <input type="text" aria-label="Sensitive fieldset value">
            <input type="text" aria-label="Sensitive fieldset detail">
          </fieldset>
        </form>
        <form>
          <fieldset>
            <legend>Credit card reference</legend>
            <input type="text" aria-label="Sensitive legend value">
            <input type="text" aria-label="Sensitive legend detail">
          </fieldset>
        </form>
        <form id="late-owner-form" aria-label="Reference context">
          <fieldset id="late-owner-fieldset" title="Overview">
            <legend id="late-owner-legend">Reference options</legend>
            <input id="late-owner-value" type="text" aria-label="Late owner value">
            <input id="late-owner-detail" type="text" aria-label="Late owner detail">
          </fieldset>
        </form>
        <form aria-label="Neutral context">
          <fieldset title="Overview"><legend>Reference options</legend>
            <input type="text" aria-label="Neutral owner value">
            <input type="text" aria-label="Neutral owner detail">
          </fieldset>
        </form>
        <form id="owner-reference-overflow" aria-label="Reference context">
          <input type="text" aria-label="Reference overflow value">
          <input type="text" aria-label="Reference overflow detail">
        </form>
        <form id="owner-depth-overflow" aria-label="Reference context"></form>
        <form id="owner-text-overflow" aria-label="Reference context">
          <fieldset><legend id="owner-huge-legend"></legend>
            <input type="text" aria-label="Text overflow value">
            <input type="text" aria-label="Text overflow detail">
          </fieldset>
        </form>
        <form id="owner-aggregate-overflow" aria-label="Reference context">
          <input type="text" aria-label="Aggregate overflow value">
          <input type="text" aria-label="Aggregate overflow detail">
        </form>
        <form id="owner-fieldset-overflow" aria-label="Reference context"></form>
        <script>
          const referenceIds = [];
          for (let index = 0; index < 17; index += 1) {
            const reference = document.createElement('span');
            reference.id = 'owner-reference-' + index;
            reference.textContent = 'Reference ' + index;
            document.body.append(reference);
            referenceIds.push(reference.id);
          }
          document.getElementById('owner-reference-overflow').setAttribute('aria-labelledby', referenceIds.join(' '));

          let depthRoot = document.getElementById('owner-depth-overflow');
          for (let index = 0; index < 260; index += 1) {
            const wrapper = document.createElement('div');
            depthRoot.append(wrapper);
            depthRoot = wrapper;
          }
          depthRoot.innerHTML = '<input type="text" aria-label="Depth overflow value"><input type="text" aria-label="Depth overflow detail">';
          document.getElementById('owner-huge-legend').textContent = 'x'.repeat(5000);

          const aggregateIds = [];
          for (let index = 0; index < 7; index += 1) {
            const reference = document.createElement('span');
            reference.id = 'owner-aggregate-' + index;
            reference.textContent = 'x'.repeat(4000);
            document.body.append(reference);
            aggregateIds.push(reference.id);
          }
          document.getElementById('owner-aggregate-overflow').setAttribute('aria-describedby', aggregateIds.join(' '));

          let fieldsetRoot = document.getElementById('owner-fieldset-overflow');
          for (let index = 0; index < 17; index += 1) {
            const fieldset = document.createElement('fieldset');
            fieldset.setAttribute('aria-label', 'Reference group ' + index);
            fieldsetRoot.append(fieldset);
            fieldsetRoot = fieldset;
          }
          fieldsetRoot.innerHTML = '<input type="text" aria-label="Fieldset overflow value"><input type="text" aria-label="Fieldset overflow detail">';
        </script>`)
      return
    }
    if (requestUrl === '/owner-form-action-safety') {
      response.end(`<!doctype html><title>Owner form action safety</title>
        <form action="/checkout">
          <input type="text" aria-label="Consequential action value">
          <input type="text" aria-label="Consequential action detail">
        </form>
        <form action="https://example.com/contact">
          <input type="text" aria-label="Cross origin action value">
          <input type="text" aria-label="Cross origin action detail">
        </form>
        <form action="http://[">
          <input type="text" aria-label="Malformed action value">
          <input type="text" aria-label="Malformed action detail">
        </form>
        <form action="${'x'.repeat(4_200)}">
          <input type="text" aria-label="Overflow action value">
          <input type="text" aria-label="Overflow action detail">
        </form>
        <form id="late-action-form" action="/about#overview">
          <input id="late-action-value" type="text" aria-label="Late action value">
          <input id="late-action-detail" type="text" aria-label="Late action detail">
        </form>
        <form action="/about?section=overview#history">
          <input type="text" aria-label="Neutral action value">
          <input type="text" aria-label="Neutral action detail">
        </form>`)
      return
    }
    if (requestUrl === '/analysis-owner-watchset') {
      response.end(`<!doctype html><title>Analysis owner watchset</title>
        <style>fieldset{border:0;margin:0;padding:0}</style>
        <span id="watch-id-retarget-decoy">Credit card number</span>
        <span id="watch-form-reference">Neutral form reference</span>
        <span id="watch-fieldset-reference">Neutral fieldset reference</span>
        <span id="watch-legend-reference">Neutral legend reference</span>
        <form id="watch-form" aria-describedby="watch-form-reference">
          <fieldset id="watch-fieldset" aria-describedby="watch-fieldset-reference">
            <legend id="watch-legend" aria-describedby="watch-legend-reference">Neutral legend</legend>
            <input id="watch-owner-value" type="text" aria-label="Watched owner value">
            <input id="watch-owner-detail" type="text" aria-label="Watched owner detail">
          </fieldset>
        </form>
        <span id="late-missing-owner-source">Neutral late reference</span>
        <form id="missing-owner-form" aria-describedby="missing-owner-reference">
          <input type="text" aria-label="Missing owner value">
          <input type="text" aria-label="Missing owner detail">
        </form>
        <form id="watch-external-owner-decoy" aria-label="Payment"></form>
        <form id="watch-external-owner" aria-label="Neutral external owner"></form>
        <input type="text" form="watch-external-owner" aria-label="External owner value">
        <input type="text" form="watch-external-owner" aria-label="External owner detail">
        <input type="text" form="late-external-form" aria-label="Missing external owner value">
        <input type="text" form="late-external-form" aria-label="Missing external owner detail">`)
      return
    }
    if (requestUrl === '/analysis-watch-budget' || requestUrl === '/analysis-watch-budget-overflow') {
      const overflow = requestUrl.endsWith('-overflow')
      const controls = Array.from({ length: 64 }, (_, controlIndex) => {
        const labelledIds = Array.from(
          { length: 16 },
          (_, referenceIndex) => `watch-label-${controlIndex}-${referenceIndex}`,
        )
        const describedIds = Array.from(
          { length: 15 + (overflow && controlIndex === 0 ? 1 : 0) },
          (_, referenceIndex) => `watch-description-${controlIndex}-${referenceIndex}`,
        )
        const references = [
          ...labelledIds.map((id) => `<span id="${id}" hidden>Neutral reference</span>`),
          ...describedIds.map((id) => `<span id="${id}" hidden>Neutral context</span>`),
        ].join('')
        return `${references}<input type="search" aria-labelledby="${labelledIds.join(' ')}" aria-describedby="${describedIds.join(' ')}">`
      }).join('')
      response.end(`<!doctype html><title>Analysis watch budget</title>
        <style>
          body{margin:0;display:grid;grid-template-columns:repeat(8,150px);gap:2px}
          input{box-sizing:border-box;width:140px;height:28px}
        </style>${controls}`)
      return
    }
    if (requestUrl === '/analysis-id-reference-explicit-form') {
      response.end(`<!doctype html><title>Explicit form id reference</title>
        <form data-id-retarget-decoy="explicit-form" id="explicit-form-decoy" aria-label="Payment"></form>
        <form id="explicit-form-owner" aria-label="Neutral external owner"></form>
        <input type="text" form="explicit-form-owner" aria-label="External value">
        <input type="text" form="explicit-form-owner" aria-label="External detail">`)
      return
    }
    if (requestUrl === '/analysis-id-reference-label-for') {
      response.end(`<!doctype html><title>Label for id reference</title>
        <input data-id-retarget-decoy="label-for" id="label-for-decoy" type="search" aria-label="Credit card number" hidden>
        <label for="label-for-control">Neutral linked label</label>
        <input id="label-for-control" type="search">`)
      return
    }
    if (requestUrl === '/unicode-safety-normalization') {
      response.end(`<!doctype html><title>Unicode safety normalization</title>
        <form id="zero-width-sensitive-form">
          <input type="text" name="reference" aria-label="Credit ca&#x200B;rd number">
          <input type="text" aria-label="Zero width detail">
        </form>
        <form id="compatibility-sensitive-form">
          <input type="text" name="reference" aria-label="Ｐａｓｓｗｏｒｄ reference">
          <input type="text" aria-label="Compatibility detail">
        </form>
        <form id="unicode-late-form">
          <input id="unicode-late-input" type="text" name="reference" aria-label="Überblick Referenz">
          <input type="text" aria-label="Unicode late detail">
        </form>
        <form id="unicode-race-form">
          <input id="unicode-race-input" type="text" name="reference" aria-label="ASCII reference"
            oninput="this.setAttribute('aria-label', 'Credit ca\u200Brd')">
          <input type="text" aria-label="Unicode race detail">
        </form>`)
      return
    }
    if (requestUrl === '/financial-field-safety') {
      response.end(`<!doctype html><title>Financial field safety</title>
        <form id="sensitive-bank-form">
          <input type="text" name="reference_one" aria-label="I&#x200B;BAN">
          <input type="text" name="reference_two" aria-label="ＢＩＣ">
        </form>
        <form id="neutral-bank-boundary-form">
          <input id="neutral-bank-boundary-one" type="text" name="bicycle_reference" aria-label="Bicycle reference">
          <input type="text" name="urban_plan" aria-label="Urban planning note">
        </form>
        <form id="late-bank-form">
          <input id="late-bank-one" type="text" name="project_reference" aria-label="Project reference">
          <input id="late-bank-two" type="text" name="project_note" aria-label="Project note">
        </form>`)
      return
    }
    if (requestUrl === '/credential-key-safety') {
      response.end(`<!doctype html><title>Project workspace</title>
        <form id="sensitive-credential-form">
          <label>api&#x200B;key<input id="credential-label" type="text" name="reference_one" value="opaque-label-secret"></label>
          <input id="credential-name" type="text" name="apikey" aria-label="Project reference" value="opaque-name-secret">
          <input id="accesskey" type="text" name="reference_three" aria-label="Project code" value="opaque-id-secret">
          <input id="credential-aria" type="text" name="reference_four" aria-label="privatekey" value="opaque-aria-secret">
          <input id="credential-title" type="text" name="reference_five" aria-label="Project identifier" title="API-key" value="opaque-title-secret">
        </form>
        <form id="plural-reference-form">
          <input id="credential-api-keys" type="text" name="reference_six" aria-label="API keys" value="opaque-api-keys-secret">
          <input id="credential-access-keys" type="text" name="reference_seven" aria-label="Access_keys" value="opaque-access-keys-secret">
          <input id="credential-private-keys" type="text" name="reference_eight" aria-label="privateKeys" value="opaque-private-keys-secret">
        </form>
        <form id="neutral-key-boundary-form">
          <input id="keynote-topic" type="text" name="keynote_topic" aria-label="Keynote topic">
          <input id="private-parking" type="text" name="private_parking" aria-label="Private parking note">
          <input id="accessibility-setting" type="text" name="accessibility_setting" aria-label="Accessibility setting">
          <input id="monkey-keys" type="text" name="monkey_keys" aria-label="Monkey keys">
          <input id="private-donkeys" type="text" name="private_donkeys" aria-label="Private donkeys">
        </form>
        <form id="late-project-form">
          <input id="late-project-one" type="text" name="project_reference" aria-label="Project reference">
          <input id="late-project-two" type="text" name="project_note" aria-label="Project note">
        </form>`)
      return
    }
    if (requestUrl === '/credential-code-safety') {
      response.end(`<!doctype html><title>Project code safety</title>
        <form id="sensitive-code-form">
          <input id="sensitive-pin" type="text" name="reference_one" aria-label="P&#x200B;IN" value="opaque-alpha-111">
          <input id="sensitive-otp" type="text" name="reference_two" aria-label="O&#x200B;TP" value="opaque-beta-222">
          <input id="sensitive-verification-code" type="text" name="verificationCode" aria-label="Project reference" value="opaque-gamma-333">
          <input id="sensitive-verification-codes" type="text" name="reference_four" aria-label="Verification_codes" value="opaque-delta-444">
          <input id="sensitive-passcode" type="text" name="reference_five" aria-label="Pass&#x200B;code" value="opaque-epsilon-555">
          <input id="sensitive-pass-code" type="text" name="passCode" aria-label="Project access" value="opaque-zeta-666">
          <input id="sensitive-one-time-code" type="text" name="oneTimeCode" aria-label="Project token" value="opaque-eta-777">
          <input id="sensitive-one-time-codes" type="text" name="reference_eight" aria-label="One-time_codes" value="opaque-theta-888">
        </form>
        <form id="neutral-code-boundary-form">
          <input id="neutral-spin" type="text" name="spin_setting" aria-label="Spin setting">
          <input id="neutral-pinot" type="text" name="pinot_note" aria-label="Pinot note">
          <input id="neutral-verification-status" type="text" name="verification_status" aria-label="Verification status">
          <input id="neutral-code-review" type="text" name="code_review" aria-label="Code review">
          <input id="neutral-compass-code" type="text" name="compass_code" aria-label="Compass code">
          <input id="neutral-pass-coding" type="text" name="pass_coding" aria-label="Pass coding">
          <input id="neutral-one-time-estimate" type="text" name="one_time_estimate" aria-label="One time estimate">
        </form>
        <form id="late-code-form">
          <input id="late-code-one" type="text" name="project_reference" aria-label="Late project reference">
          <input id="late-code-two" type="text" name="project_note" aria-label="Late project note">
          <label id="late-code-label">Late project code<input id="late-code-three" type="text" name="project_code"></label>
        </form>`)
      return
    }
    if (requestUrl === '/composed-accessible-safety') {
      response.end(`<!doctype html><title>Composed safety evidence</title>
        <span id="composed-api">API</span><span id="composed-keys">keys</span>
        <form id="sensitive-composed-reference-form">
          <input type="text" name="reference" aria-label="Composed reference field" aria-labelledby="composed-api composed-keys">
          <input type="text" aria-label="Sensitive composed reference detail">
        </form>
        <form id="sensitive-composed-label-form">
          <label for="composed-label-target">API <img alt="keys"></label>
          <input id="composed-label-target" type="text" name="reference" aria-label="Composed label field">
          <input type="text" aria-label="Sensitive composed label detail">
        </form>
        <form id="sensitive-composed-images-form">
          <label for="composed-images-target"><img alt="Bank"><img alt="account"></label>
          <input id="composed-images-target" type="text" name="reference" aria-label="Composed image field">
          <input type="text" aria-label="Sensitive composed image detail">
        </form>
        <form id="sensitive-composed-labels-form">
          <label for="composed-labels-target">Bank</label>
          <label for="composed-labels-target">account</label>
          <input id="composed-labels-target" type="text" name="reference" aria-label="Composed labels field">
          <input type="text" aria-label="Sensitive composed labels detail">
        </form>
        <form id="neutral-composed-boundary-form">
          <label for="neutral-monkey">Monkey <img alt="business"></label>
          <input id="neutral-monkey" type="text" name="monkey_business">
          <input type="text" name="private_donkeys" aria-label="Private donkeys pasture">
        </form>
        <span id="late-composed-first">Project</span><span id="late-composed-second">reference</span>
        <form id="late-composed-form">
          <input id="late-composed-input" type="text" name="reference" aria-label="Late composed field" aria-labelledby="late-composed-first late-composed-second">
          <input id="late-composed-detail" type="text" aria-label="Late composed detail">
        </form>
        <form id="overflow-composed-form">
          <input id="overflow-composed-input" type="text" aria-label="Overflow composed field">
          <input type="text" aria-label="Overflow composed detail">
        </form>
        <script>
          const overflow = document.getElementById('overflow-composed-input');
          const ids = [];
          for (let index = 0; index < 7; index += 1) {
            const source = document.createElement('span');
            source.id = 'overflow-composed-' + index;
            source.textContent = 'x'.repeat(2100);
            document.body.append(source);
            ids.push(source.id);
          }
          overflow.setAttribute('aria-labelledby', ids.join(' '));
        </script>`)
      return
    }
    if (requestUrl === '/aria-placeholder-safety') {
      response.end(`<!doctype html><title>ARIA placeholder safety</title>
        <form id="sensitive-direct-placeholder-form">
          <input type="text" aria-label="Direct placeholder field" aria-placeholder="API keys">
          <input type="text" aria-label="Sensitive direct placeholder detail">
        </form>
        <span id="placeholder-reference" aria-placeholder="Password">Reference placeholder field</span>
        <form id="sensitive-reference-placeholder-form">
          <input type="text" name="reference" aria-labelledby="placeholder-reference">
          <input type="text" aria-label="Sensitive reference placeholder detail">
        </form>
        <form id="sensitive-owner-placeholder-form" aria-placeholder="Payment">
          <input type="text" aria-label="Owner placeholder reference">
          <input type="text" aria-label="Owner placeholder detail">
        </form>
        <form id="neutral-placeholder-form">
          <input id="neutral-placeholder-input" type="text" aria-label="Neutral placeholder reference" aria-placeholder="Helpful hint">
          <input type="text" aria-label="Neutral placeholder detail">
        </form>
        <form id="late-placeholder-form">
          <input id="late-placeholder-input" type="text" aria-label="Late placeholder reference" aria-placeholder="Helpful hint">
          <input id="late-placeholder-detail" type="text" aria-label="Late placeholder detail">
        </form>
        <span id="late-reference-placeholder-source" aria-placeholder="Helpful hint">Late referenced source</span>
        <form id="late-reference-placeholder-form">
          <input id="late-reference-placeholder-input" type="text" aria-label="Late referenced placeholder reference" aria-labelledby="late-reference-placeholder-source">
          <input id="late-reference-placeholder-detail" type="text" aria-label="Late referenced placeholder detail">
        </form>
        <form id="late-owner-placeholder-form" aria-placeholder="Helpful hint">
          <input id="late-owner-placeholder-input" type="text" aria-label="Late owner placeholder reference">
          <input id="late-owner-placeholder-detail" type="text" aria-label="Late owner placeholder detail">
        </form>
        <form id="overflow-placeholder-form">
          <input id="overflow-placeholder-input" type="text" aria-label="Overflow placeholder reference">
          <input type="text" aria-label="Overflow placeholder detail">
        </form>
        <script>document.getElementById('overflow-placeholder-input').setAttribute('aria-placeholder', 'x'.repeat(4097))</script>`)
      return
    }
    if (requestUrl === '/submit-context-safety') {
      response.end(`<!doctype html><title>Submit context safety</title>
        <form id="sensitive-button-submit-form">
          <input type="text" aria-label="Button submit reference">
          <input type="text" aria-label="Button submit detail">
          <button>Pay</button>
        </form>
        <form id="sensitive-input-submit-form">
          <input type="text" aria-label="Input submit reference">
          <input type="text" aria-label="Input submit detail">
          <input type="submit" value="Pay">
        </form>
        <form id="sensitive-image-submit-form">
          <input type="text" aria-label="Image submit reference">
          <input type="text" aria-label="Image submit detail">
          <input type="image" alt="Checkout">
        </form>
        <form id="sensitive-external-submit-form">
          <input type="text" aria-label="External submit reference">
          <input type="text" aria-label="External submit detail">
        </form>
        <button type="submit" form="sensitive-external-submit-form" aria-label="Payment">Preview</button>
        <form id="sensitive-external-image-form">
          <input type="text" aria-label="External image reference">
          <input type="text" aria-label="External image detail">
        </form>
        <input type="image" form="sensitive-external-image-form" alt="Checkout">
        <form id="sensitive-external-input-submit-form">
          <input type="text" aria-label="External input submit reference">
          <input type="text" aria-label="External input submit detail">
        </form>
        <input type="submit" form="sensitive-external-input-submit-form" value="Pay">
        <form id="sensitive-button-value-form">
          <input type="text" aria-label="Button value reference">
          <input type="text" aria-label="Button value detail">
          <button type="submit" value="Payment">Preview</button>
        </form>
        <form id="sensitive-submit-title-form">
          <input type="text" aria-label="Submit title reference">
          <input type="text" aria-label="Submit title detail">
          <button type="submit" title="Payment">Preview</button>
        </form>
        <form id="sensitive-submit-generated-form">
          <input type="text" aria-label="Submit generated reference">
          <input type="text" aria-label="Submit generated detail">
          <button class="generated-submit" type="submit">Preview</button>
        </form>
        <form id="sensitive-submit-image-form">
          <input type="text" aria-label="Submit descendant image reference">
          <input type="text" aria-label="Submit descendant image detail">
          <button type="submit"><img alt="Payment"></button>
        </form>
        <span id="submit-reference-label">Payment</span>
        <form id="sensitive-submit-reference-form">
          <input type="text" aria-label="Submit ARIA reference">
          <input type="text" aria-label="Submit ARIA detail">
          <button type="submit" aria-labelledby="submit-reference-label">Preview</button>
        </form>
        <form id="sensitive-submit-action-form">
          <input type="text" aria-label="Submit action reference">
          <input type="text" aria-label="Submit action detail">
          <button type="submit" formaction="/checkout">Preview</button>
        </form>
        <form id="neutral-submit-form">
          <input id="neutral-submit-input" type="text" aria-label="Neutral submit reference">
          <input type="text" aria-label="Neutral submit detail">
          <button type="submit">Preview</button>
          <button type="button">Pay</button>
          <button type="reset">Payment</button>
        </form>
        <form id="late-submit-form">
          <input id="late-submit-input" type="text" aria-label="Late submit reference">
          <input id="late-submit-detail" type="text" aria-label="Late submit detail">
          <button id="late-submit-button" type="submit">Preview</button>
        </form>
        <form id="late-submit-action-form">
          <input id="late-submit-action-input" type="text" aria-label="Late submit action reference">
          <input id="late-submit-action-detail" type="text" aria-label="Late submit action detail">
          <button id="late-submit-action-button" type="submit" formaction="/about">Preview</button>
        </form>
        <form id="late-external-submit-form">
          <input id="late-external-submit-input" type="text" aria-label="Late external submit reference">
          <input id="late-external-submit-detail" type="text" aria-label="Late external submit detail">
        </form>
        <form id="late-external-submit-decoy-form"></form>
        <button id="late-external-submit-button" type="submit" form="late-external-submit-form">Preview</button>
        <form id="overflow-submit-form">
          <input type="text" aria-label="Overflow submit reference">
          <input type="text" aria-label="Overflow submit detail">
        </form>
        <script>
          const style = document.createElement('style');
          style.textContent = '.generated-submit::after { content: " Payment"; }';
          document.head.append(style);
          const overflowForm = document.getElementById('overflow-submit-form');
          for (let index = 0; index < 17; index += 1) {
            const button = document.createElement('button');
            button.type = 'submit';
            button.textContent = 'Preview ' + index;
            overflowForm.append(button);
          }
        </script>`)
      return
    }
    if (requestUrl === '/document-title-sensitive') {
      response.end(`<!doctype html><title>Payment details</title>
        <form id="payment-title-form">
          <input type="text" aria-label="Project reference">
          <input type="text" aria-label="Project note">
        </form>
        <a href="/about">Project overview</a>`)
      return
    }
    if (requestUrl === '/document-title-neutral') {
      response.end(`<!doctype html><title>Project workspace</title>
        <form id="neutral-title-form">
          <input id="neutral-title-one" type="text" aria-label="Project reference">
          <input id="neutral-title-two" type="text" aria-label="Project note">
        </form>`)
      return
    }
    if (requestUrl === '/card-verification-field-safety') {
      response.end(`<!doctype html><title>Verification field safety</title>
        <form id="sensitive-card-verification-form">
          <input type="text" name="reference_one" aria-label="C&#x200B;VV">
          <input type="text" name="reference_two" aria-label="ＣＶＣ">
        </form>
        <form id="neutral-verification-boundary-form">
          <input id="neutral-verification-one" type="text" name="cvvalue_reference" aria-label="CVValue reference">
          <input type="text" name="cvcustom_note" aria-label="CVCustom note">
        </form>
        <form id="late-verification-form">
          <input id="late-verification-one" type="text" name="project_reference" aria-label="Project reference">
          <input id="late-verification-two" type="text" name="project_note" aria-label="Project note">
        </form>`)
      return
    }
    if (requestUrl === '/visible-select-options') {
      response.end(`<!doctype html><title>Visible select options</title>
        <select id="visible-options-filter" aria-label="Visibility filter" onchange="document.title=this.value">
          <option value="visible-one" selected>Visible one</option>
          <option value="hidden-direct" hidden>Hidden direct</option>
          <optgroup label="Hidden group" hidden><option value="hidden-group">Hidden group option</option></optgroup>
          <optgroup label="CSS hidden group" style="display:none"><option value="hidden-css-group">CSS hidden group option</option></optgroup>
          <option value="hidden-css" style="visibility:hidden">Hidden CSS option</option>
          <option id="visible-filter-two" value="visible-two">Visible two</option>
        </select>
        <form id="visible-select-form">
          <select id="visible-form-select" aria-label="Visible form choice">
            <option value="form-one" selected>Form one</option>
            <option value="form-hidden" hidden>Form hidden</option>
            <optgroup label="Form hidden group" hidden><option value="form-group-hidden">Form group hidden</option></optgroup>
            <option value="form-two">Form two</option>
          </select>
          <input type="text" aria-label="Visible select detail">
        </form>`)
      return
    }
    if (requestUrl === '/required-select-contracts') {
      response.end(`<!doctype html><title>Required select contracts</title>
        <select id="required-filter" aria-label="Category filter" required>
          <option value="" selected>Choose category</option>
          <option value="alpha">Alpha</option>
          <option value="beta">Beta</option>
        </select>
        <form id="required-select-form">
          <select id="required-form-select" aria-label="Required form choice" required>
            <option value="" selected>Choose option</option>
            <option value="one">One</option>
            <option value="two">Two</option>
          </select>
          <input type="text" aria-label="Required select detail">
        </form>
        <form id="only-empty-required-form">
          <select id="only-empty-required" aria-label="Only empty required" required>
            <option value="" selected>Choose only option</option>
          </select>
          <input type="text" aria-label="Only empty detail">
        </form>
        <form id="nonrequired-empty-form">
          <select id="nonrequired-empty" aria-label="Optional empty choice">
            <option value="">No selection</option>
            <option value="one" selected>One</option>
          </select>
          <input type="text" aria-label="Optional empty detail">
        </form>
        <form id="late-required-select-form">
          <select id="late-required-select" aria-label="Late required choice">
            <option value="">No selection</option>
            <option value="one" selected>One</option>
            <option value="two">Two</option>
          </select>
          <input id="late-required-select-detail" type="text" aria-label="Late required detail">
        </form>
        <form id="custom-invalid-required-form">
          <select id="custom-invalid-required" aria-label="Custom invalid required choice" required>
            <option value="" selected>Choose custom option</option>
            <option value="one">Custom one</option>
            <option value="two">Custom two</option>
          </select>
          <input type="text" aria-label="Custom invalid detail">
        </form>
        <script>
          document.getElementById('custom-invalid-required').setCustomValidity('Page-owned custom warning');
        </script>`)
      return
    }
    if (requestUrl === '/preparation-url-state') {
      response.end(`<!doctype html><title>Preparation URL state</title>
        <input id="url-state-search" type="search" aria-label="URL state search" oninput="
          if (this.value === 'hostile-push') history.pushState({}, '', '/safe#/checkout');
          if (this.value === 'malformed-push') history.pushState({}, '', '/safe%ZZ?next=%63heckout');
          if (this.value === 'neutral-hash') location.hash = '#overview';
        ">
        <select id="url-state-filter" aria-label="URL state filter" onchange="
          if (this.value === 'secondary') location.hash = '#/checkout';
        ">
          <option value="safe" selected>Safe option</option>
          <option value="secondary">Secondary option</option>
        </select>`)
      return
    }
    if (requestUrl === '/checked-radio-groups') {
      response.end(`<!doctype html><title>Checked radio groups</title>
        <form id="first-radio-form">
          <input id="first-a" type="radio" name="first_mode" value="a" checked><label for="first-a">First A</label>
          <input id="first-b" type="radio" name="first_mode" value="b"><label for="first-b">First B</label>
          <input type="text" aria-label="First detail">
        </form>
        <form id="second-radio-form">
          <input id="second-a" type="radio" name="second_mode" value="a" checked><label for="second-a">Second A</label>
          <input id="second-b" type="radio" name="second_mode" value="b"><label for="second-b">Second B</label>
          <input type="text" aria-label="Second detail">
        </form>
        <form id="single-radio-form">
          <input id="single-radio" type="radio" name="single_mode" value="a" checked><label for="single-radio">Single choice</label>
          <input type="text" aria-label="Single detail">
        </form>`)
      return
    }
    if (requestUrl === '/safety-race') {
      response.end(`<!doctype html><title>Safety race</title>
        <input id="race-search" type="search" aria-label="Race search"
          oninput="this.setAttribute('aria-label', 'Credit card')">`)
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
        </form>
        <input id="initial-aria-disabled" type="search" aria-label="Initially unavailable search" aria-disabled="true">
        <form id="aria-false-form">
          <input id="aria-false-control" type="text" aria-label="ARIA false value" aria-disabled="false">
          <input type="text" aria-label="ARIA false detail">
        </form>
        <form id="ancestor-disabled-form" aria-disabled="true">
          <input id="ancestor-disabled-control" type="text" aria-label="Ancestor unavailable value" aria-disabled="false">
          <input type="text" aria-label="Ancestor unavailable detail">
        </form>
        <div id="ancestor-disabled-navigation" aria-disabled="true">
          <a id="ancestor-disabled-link" href="/safe-target">Ancestor unavailable link</a>
        </div>
        <div id="ancestor-false-navigation" aria-disabled="false">
          <a id="ancestor-false-link" href="/safe-target">Ancestor false link</a>
        </div>
        <form id="ancestor-disabled-radio-form" aria-disabled="true">
          <input id="ancestor-radio-a" type="radio" name="ancestor_mode" value="a"><label for="ancestor-radio-a">Ancestor A</label>
          <input id="ancestor-radio-b" type="radio" name="ancestor_mode" value="b"><label for="ancestor-radio-b">Ancestor B</label>
          <input type="text" aria-label="Ancestor radio detail">
        </form>
        <form id="ancestor-false-radio-form" aria-disabled="false">
          <input id="ancestor-safe-radio-a" type="radio" name="safe_ancestor_mode" value="a" checked><label for="ancestor-safe-radio-a">Ancestor safe A</label>
          <input id="ancestor-safe-radio-b" type="radio" name="safe_ancestor_mode" value="b"><label for="ancestor-safe-radio-b">Ancestor safe B</label>
          <input type="text" aria-label="Ancestor safe radio detail">
        </form>`)
      return
    }
    if (requestUrl === '/aria-disabled-depth') {
      response.end(`<!doctype html><title>ARIA disabled depth</title>
        <form id="deep-form"></form>
        <form id="safe-depth-form">
          <input id="safe-depth-control" type="text" aria-label="Safe depth value">
          <input type="text" aria-label="Safe depth detail">
        </form>
        <script>
          const deepForm = document.getElementById('deep-form');
          let parent = deepForm;
          for (let index = 0; index < 270; index += 1) {
            const wrapper = document.createElement('div');
            parent.appendChild(wrapper);
            parent = wrapper;
          }
          for (const label of ['Too deep value', 'Too deep detail']) {
            const input = document.createElement('input');
            input.type = 'text';
            input.setAttribute('aria-label', label);
            parent.appendChild(input);
          }
        </script>`)
      return
    }
    if (requestUrl === '/option-and-readonly-safety') {
      response.end(`<!doctype html><title>Option and readonly safety</title>
        <select id="direct-disabled-option" aria-label="Direct disabled option filter">
          <option value="one" selected>One</option>
          <option value="two" aria-disabled="true">Two</option>
        </select>
        <select id="ancestor-disabled-option" aria-label="Ancestor disabled option filter">
          <option value="one" selected>One</option>
          <optgroup aria-disabled="true"><option value="two">Two</option></optgroup>
        </select>
        <select id="aria-false-option" aria-label="ARIA false option filter">
          <option value="one" aria-disabled="false" selected>One</option>
          <option value="two" aria-disabled="false">Two</option>
        </select>
        <select id="late-option-operability" aria-label="Late option operability filter">
          <option value="one" selected>One</option><option id="late-option-target" value="two">Two</option>
        </select>
        <form id="initial-readonly-form">
          <input aria-label="Initial readonly value" aria-readonly="true">
          <textarea aria-label="Initial readonly detail" aria-readonly="true"></textarea>
        </form>
        <form id="false-readonly-form">
          <input id="false-readonly-value" aria-label="False readonly value" aria-readonly="false">
          <textarea aria-label="False readonly detail" aria-readonly="false"></textarea>
        </form>
        <form id="late-readonly-form">
          <input id="late-readonly-value" aria-label="Late readonly value">
          <textarea aria-label="Late readonly detail"></textarea>
        </form>`)
      return
    }
    if (requestUrl === '/select-readonly-safety') {
      response.end(`<!doctype html><title>Select readonly safety</title>
        <select id="initial-readonly-select" aria-label="Initial readonly category filter" aria-readonly="true">
          <option value="one" selected>One</option><option value="two">Two</option>
        </select>
        <select id="false-readonly-select" aria-label="False readonly category filter" aria-readonly="false">
          <option value="one" selected>One</option><option value="two">Two</option>
        </select>
        <select id="late-readonly-select" aria-label="Late readonly category filter">
          <option value="one" selected>One</option><option value="two">Two</option>
        </select>`)
      return
    }
    if (requestUrl === '/option-described-safety') {
      response.end(`<!doctype html><title>Option described safety</title>
        <span id="sensitive-option-description">Credit card number</span>
        <span id="late-option-description">Neutral option context</span>
        <span id="nested-option-description" aria-labelledby="nested-option-sensitive">Neutral nested context</span>
        <span id="nested-option-sensitive">Credit card number</span>
        ${Array.from({ length: 17 }, (_, index) => `<span hidden id="count-option-description-${index}">Reference ${index}</span>`).join('')}
        ${Array.from({ length: 7 }, (_, index) => `<span hidden id="aggregate-option-description-${index}">${'x'.repeat(3_900)}</span>`).join('')}
        <span hidden id="deep-option-description">${'<span>'.repeat(300)}Deep reference${'</span>'.repeat(300)}</span>
        <select id="direct-description-option" aria-label="Direct description option filter">
          <option value="one" selected>One</option>
          <option value="two" aria-description="Password">Two</option>
        </select>
        <select id="referenced-description-option" aria-label="Referenced description option filter">
          <option value="one" selected>One</option>
          <option value="two" aria-describedby="sensitive-option-description">Two</option>
        </select>
        <select aria-label="Nested description option filter">
          <option value="one" selected>One</option>
          <option value="two" aria-describedby="nested-option-description">Two</option>
        </select>
        <select id="neutral-description-option" aria-label="Neutral description option filter">
          <option value="one" selected>One</option>
          <option value="two" aria-description="Second neutral choice">Two</option>
        </select>
        <select id="late-description-option" aria-label="Late description option filter">
          <option value="one" selected>One</option>
          <option id="late-description-target" value="two" aria-describedby="late-option-description">Two</option>
        </select>
        <select aria-label="Missing description option filter">
          <option value="one" selected>One</option><option value="two" aria-describedby="missing-description">Two</option>
        </select>
        <select aria-label="Overflow description option filter">
          <option value="one" selected>One</option><option value="two" aria-description="${'x'.repeat(4_200)}">Two</option>
        </select>
        <select aria-label="Count overflow description option filter">
          <option value="one" selected>One</option><option value="two" aria-describedby="${Array.from({ length: 17 }, (_, index) => `count-option-description-${index}`).join(' ')}">Two</option>
        </select>
        <select aria-label="Aggregate overflow description option filter">
          <option value="one" selected>One</option><option value="two" aria-describedby="${Array.from({ length: 7 }, (_, index) => `aggregate-option-description-${index}`).join(' ')}">Two</option>
        </select>
        <select aria-label="Traversal overflow description option filter">
          <option value="one" selected>One</option><option value="two" aria-describedby="deep-option-description">Two</option>
        </select>`)
      return
    }
    if (requestUrl === '/visible-state-contract') {
      response.end(`<!doctype html><title>Visible state contract</title>
        <style>
          @keyframes unrelated-motion { from { transform: translateX(0); } to { transform: translateX(40px); } }
          @keyframes target-motion { from { background: rgb(255, 0, 0); } to { background: rgb(0, 0, 255); } }
          #semantic-css-filter { animation: target-motion 80ms linear infinite alternate; }
        </style>
        <div aria-hidden="true" style="position:absolute;left:700px;top:40px;width:40px;height:40px;background:#f00;animation:unrelated-motion 120ms linear infinite alternate"></div>
        <select id="semantic-css-filter" aria-label="Semantic CSS filter">
          <option value="one" selected>Same visible label</option>
          <option value="two">Same visible label</option>
        </select>
        <select id="visible-filter" aria-label="Visible result filter">
          <option value="one" selected>First visible label</option>
          <option value="two">Second visible label</option>
        </select>`)
      return
    }
    if (requestUrl === '/id-paint-action-contract') {
      response.end(`<!doctype html><title>ID paint action contract</title>
        <style>
          .id-paint-stack { position:relative;width:220px;height:36px }
          #id-paint-target { appearance:none;position:absolute;inset:0;width:220px;height:36px }
          #idle-id-paint { display:none }
          #armed-id-paint { display:block;position:absolute;inset:0;z-index:2;pointer-events:none;background:rgb(255,0,0) }
        </style>
        <div class="id-paint-stack">
          <select id="id-paint-target" aria-label="ID paint filter">
            <option value="one" selected>Same visible label</option>
            <option value="two">Same visible label</option>
          </select>
          <div id="idle-id-paint" aria-hidden="true"></div>
        </div>`)
      return
    }
    if (requestUrl === '/dynamic-render-contract') {
      const animatedSvg = encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="220" height="36"><rect width="220" height="36" fill="red"><animate attributeName="fill" values="red;blue;red" dur="0.08s" repeatCount="indefinite"/></rect></svg>`)
      response.end(`<!doctype html><title>Dynamic render contract</title>
        <style>
          .render-stack { position:absolute;left:20px;width:220px;height:36px }
          .semantic-render { appearance:none;background:transparent;border:0;color:#111;width:220px;height:36px;position:absolute;inset:0;z-index:1 }
        </style>
        <div class="render-stack" style="top:20px">
          <canvas id="moving-canvas" width="220" height="36" style="position:absolute;inset:0"></canvas>
          <select id="semantic-canvas-filter" class="semantic-render" aria-label="Semantic canvas filter"><option selected>Same label</option><option>Same label</option></select>
        </div>
        <div class="render-stack" style="top:80px">
          <img src="data:image/svg+xml,${animatedSvg}" alt="" width="220" height="36" style="position:absolute;inset:0;visibility:visible!important">
          <select id="semantic-image-filter" class="semantic-render" aria-label="Semantic animated image filter"><option selected>Same label</option><option>Same label</option></select>
        </div>
        <input id="visible-render-search" type="search" aria-label="Visible render search" style="position:absolute;left:20px;top:140px;width:220px;height:36px">
        <script>
          globalThis.__renderFrame = 0;
          const canvas = document.getElementById('moving-canvas');
          const context = canvas.getContext('2d');
          const draw = () => {
            globalThis.__renderFrame += 1;
            context.fillStyle = globalThis.__renderFrame % 2 ? '#ef4444' : '#2563eb';
            context.fillRect(0, 0, canvas.width, canvas.height);
            requestAnimationFrame(draw);
          };
          requestAnimationFrame(draw);
        </script>`)
      return
    }
    if (requestUrl === '/dynamic-media-contract') {
      response.end(`<!doctype html><title>Dynamic media contract</title>
        <video id="moving-video" autoplay muted playsinline style="position:absolute;left:20px;top:20px;width:220px;height:36px"></video>
        <select id="semantic-media-filter" aria-label="Semantic media filter" style="appearance:none;background:transparent;border:0;color:#111;position:absolute;left:20px;top:20px;width:220px;height:36px"><option selected>Same label</option><option>Same label</option></select>
        <script>
          const mediaCanvas = document.createElement('canvas');
          mediaCanvas.width = 220; mediaCanvas.height = 36;
          const mediaContext = mediaCanvas.getContext('2d');
          let mediaFrame = 0;
          setInterval(() => {
            mediaFrame += 1;
            mediaContext.fillStyle = mediaFrame % 2 ? '#16a34a' : '#9333ea';
            mediaContext.fillRect(0, 0, 220, 36);
          }, 30);
          const video = document.getElementById('moving-video');
          video.srcObject = mediaCanvas.captureStream(20);
          video.play();
        </script>`)
      return
    }
    if (requestUrl === '/dynamic-shadow-contract') {
      response.end(`<!doctype html><title>Dynamic shadow contract</title>
        <div id="closed-paint-host" style="position:absolute;left:20px;top:20px;width:220px;height:36px"></div>
        <select id="semantic-shadow-filter" aria-label="Semantic shadow filter" style="appearance:none;background:transparent;border:0;color:#111;position:absolute;left:20px;top:20px;width:220px;height:36px"><option selected>Same label</option><option>Same label</option></select>
        <script>
          const root = document.getElementById('closed-paint-host').attachShadow({ mode: 'closed' });
          const canvas = document.createElement('canvas');
          canvas.width = 220; canvas.height = 36;
          root.append(canvas);
          const context = canvas.getContext('2d');
          const draw = () => {
            context.fillStyle = Math.random() > .5 ? '#dc2626' : '#2563eb';
            context.fillRect(0, 0, 220, 36);
            requestAnimationFrame(draw);
          };
          requestAnimationFrame(draw);
        </script>`)
      return
    }
    if (requestUrl === '/analysis-animation-capture') {
      response.end(`<!doctype html><title>Analysis animation capture</title>
        <style>
          @keyframes capture-opacity { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }
          #css-animated-search { animation: capture-opacity 10000ms linear infinite; }
        </style>
        <input id="css-animated-search" type="search" aria-label="CSS animated search">
        <input id="web-animated-search" type="search" aria-label="Web animated search">
        <input id="stable-capture-search" type="search" aria-label="Stable capture search">
        <script>
          const animation = document.getElementById('web-animated-search').animate(
            [{ opacity: 1 }, { opacity: 0 }, { opacity: 1 }],
            { duration: 10000, iterations: Infinity },
          );
          animation.id = 'web-opacity-animation';
        </script>`)
      return
    }
    if (requestUrl === '/focus-capture-stability') {
      response.end(`<!doctype html><title>Focus capture stability</title>
        <style>
          .focus-stage { position:relative;width:260px;height:120px; }
          #focus-capture-search { position:absolute;left:10px;top:48px;width:220px;height:36px; }
          #focus-capture-probe { position:absolute;left:10px;top:4px;width:120px;height:30px; }
          #focus-capture-occluder { display:none; }
          .focus-stage:focus-within:has(#focus-capture-probe:focus) #focus-capture-occluder {
            display:block;position:absolute;left:0;top:40px;width:245px;height:48px;
            z-index:5;pointer-events:none;background:rgb(180,20,20);
          }
        </style>
        <div class="focus-stage">
          <button id="focus-capture-probe" type="button">Focus probe</button>
          <input id="focus-capture-search" type="search" aria-label="Focus stable search">
          <div id="focus-capture-occluder" aria-hidden="true"></div>
        </div>
        <script>
          addEventListener('focusin', (event) => event.stopImmediatePropagation(), true);
          addEventListener('focusout', (event) => event.stopImmediatePropagation(), true);
        </script>`)
      return
    }
    if (requestUrl === '/native-control-state-capture') {
      response.end(`<!doctype html><title>Native control state capture</title>
        <style>
          #native-state-search { width:220px;height:36px;color:transparent;caret-color:transparent;background:white; }
          body:has(#native-state-checkbox:checked) #native-state-search { background:rgb(220, 38, 38); }
        </style>
        <input id="native-state-search" type="search" aria-label="Native state search">
        <input id="native-state-input" type="text" aria-label="Native state note" value="opaque-native-capture-secret">
        <input id="native-state-checkbox" type="checkbox" aria-label="Native state toggle">
        <textarea id="native-state-textarea" aria-label="Native state details"></textarea>
        <select id="native-state-select" aria-label="Native state filter" required>
          <option value="">Choose</option><option value="safe">Safe</option>
        </select>`)
      return
    }
    if (requestUrl === '/native-control-state-overflow') {
      response.end(`<!doctype html><title>Native control state overflow</title>
        <input type="search" aria-label="Overflow state search">
        <script>
          const controls = document.createDocumentFragment();
          for (let index = 0; index < 3; index += 1) {
            const input = document.createElement('input');
            input.type = 'text'; input.hidden = true; input.value = String(index).repeat(400000);
            controls.append(input);
          }
          document.body.append(controls);
        </script>`)
      return
    }
    if (requestUrl === '/native-control-state-hashed') {
      response.end(`<!doctype html><title>Native control state hashed</title>
        <input id="hashed-state-search" type="search" aria-label="Hashed state search">
        <input id="raw-private-state" hidden value="short-private-state">
        <input id="hashed-private-state" hidden>
        <script>
          document.getElementById('hashed-private-state').value = 'private-hash-source-'.repeat(400);
        </script>`)
      return
    }
    if (requestUrl === '/native-control-xhtml') {
      response.setHeader('Content-Type', 'application/xhtml+xml; charset=utf-8')
      response.end(`<?xml version="1.0" encoding="UTF-8"?>
        <html xmlns="http://www.w3.org/1999/xhtml">
          <head><title>XHTML native control</title></head>
          <body><input id="xhtml-search" type="search" aria-label="XHTML state search" /></body>
        </html>`)
      return
    }
    if (requestUrl === '/native-control-shadow-capture') {
      response.end(`<!doctype html><title>Native shadow control capture</title>
        <input type="search" aria-label="Shadow state search">
        <div id="native-shadow-host"></div>
        <script>
          const root = document.getElementById('native-shadow-host').attachShadow({ mode: 'closed' });
          root.innerHTML = '<style>input:checked{appearance:none;width:80px;height:40px;background:red}</style><input type="checkbox">';
          globalThis.__nativeShadowCheckboxForTest = root.querySelector('input');
        </script>`)
      return
    }
    if (requestUrl === '/paint-evidence-contract') {
      response.end(`<!doctype html><title>Paint evidence contract</title>
        <style>
          .paintless {
            appearance:none; color:transparent; caret-color:transparent;
            background:transparent; border:0; outline:0; box-shadow:none;
            text-shadow:none; width:180px; height:36px; display:block; margin:10px;
          }
        </style>
        <input id="paintless-search" class="paintless" type="search" aria-label="Paintless search">
        <input id="transparent-gradient-search" class="paintless" type="search" aria-label="Transparent gradient search"
          style="background-image:linear-gradient(transparent,transparent)">
        <input id="transparent-shadow-search" class="paintless" type="search" aria-label="Transparent shadow search"
          style="box-shadow:0 0 0 4px rgba(0,0,0,0)">
        <input id="zero-size-gradient-search" class="paintless" type="search" aria-label="Zero size gradient search"
          style="background-image:linear-gradient(red,red);background-size:0 0;background-repeat:no-repeat">
        <input id="collapsed-shadow-search" class="paintless" type="search" aria-label="Collapsed shadow search"
          style="box-shadow:0 0 0 -100px red">
        <input id="appearance-auto-paintless" class="paintless" type="search" aria-label="Appearance auto paintless search"
          style="appearance:auto">
        <input id="oklab-transparent-search" class="paintless" type="search" aria-label="OKLab transparent search"
          style="background-color:oklab(60% .1 .1 / 0)">
        <input id="paintless-checkbox" class="paintless" type="checkbox" aria-label="Paintless checkbox">
        <a id="paintless-link" class="paintless" href="/about#paintless" aria-label="Paintless link">Paintless link</a>
        <input id="painted-custom-search" class="paintless" type="search" aria-label="Painted custom search"
          style="border:2px solid rgb(30,90,180);color:rgb(20,40,80);caret-color:rgb(20,40,80)">
        <input id="native-painted-search" type="search" aria-label="Native painted search">
        <input id="visible-placeholder-search" class="paintless" type="search" aria-label="Visible placeholder search"
          placeholder="Visible placeholder" style="--placeholder-color:rgb(20,80,160)">
        <style>#visible-placeholder-search::placeholder{color:var(--placeholder-color)}</style>
        <input id="visible-text-fill" class="paintless" type="text" aria-label="Visible text fill"
          value="Visible text" style="-webkit-text-fill-color:rgb(20,80,160)">
        <input id="oklab-painted-search" class="paintless" type="search" aria-label="OKLab painted search"
          style="background-color:oklab(60% .1 .1 / 1)">
        <a id="transparent-image-link" class="paintless" href="/about#transparent-image" aria-label="Transparent image link">
          <img width="24" height="24" alt="" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24'%3E%3Crect width='24' height='24' fill='none'/%3E%3C/svg%3E">
        </a>
        <a id="zero-size-image-link" class="paintless" href="/about#zero-size-image" aria-label="Zero size image link">
          <img width="24" height="24" style="width:0;height:0" alt="" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24'%3E%3Crect width='24' height='24' fill='red'/%3E%3C/svg%3E">
        </a>
        <a id="clipped-image-link" class="paintless" href="/about#clipped-image" aria-label="Clipped image link">
          <span style="display:block;width:0;height:0;overflow:hidden"><img width="24" height="24" alt="" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24'%3E%3Crect width='24' height='24' fill='red'/%3E%3C/svg%3E"></span>
        </a>
        <a id="legacy-clipped-image-link" class="paintless" href="/about#legacy-clipped-image" aria-label="Legacy clipped image link">
          <img width="24" height="24" style="position:absolute;clip:rect(0,0,0,0)" alt="" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24'%3E%3Crect width='24' height='24' fill='red'/%3E%3C/svg%3E">
        </a>
        <a id="painted-image-link" class="paintless" href="/about#painted-image" aria-label="Painted image link">
          <img width="24" height="24" alt="" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24'%3E%3Crect width='24' height='24' fill='red'/%3E%3C/svg%3E">
        </a>`)
      return
    }
    if (requestUrl === '/paint-text-state-contract') {
      response.end(`<!doctype html><title>Painted text state contract</title>
        <style>
          .paintless-text-state {
            appearance:none;color:transparent;caret-color:transparent;
            background:transparent;border:0;outline:0;box-shadow:none;
            text-shadow:none;width:220px;height:38px;display:block;margin:12px;
          }
          .painted-text-state { color:rgb(20,80,160); }
          .transparent-option-text option {
            color:transparent;-webkit-text-fill-color:transparent;
            text-shadow:none;background:transparent;
          }
          .painted-placeholder::placeholder { color:rgb(20,80,160); }
        </style>
        <span id="unreferenced-id-decoy">Unreferenced identity</span>
        <select id="empty-selected-filter" class="paintless-text-state painted-text-state" aria-label="Empty selected filter">
          <option value="" selected></option>
          <option value="decoy">Nonselected decoy text</option>
        </select>
        <select id="painted-listbox-filter" class="paintless-text-state painted-text-state" size="2" aria-label="Painted listbox filter">
          <option value="" selected></option>
          <option value="visible">Visible unselected row</option>
        </select>
        <select id="transparent-option-listbox" class="paintless-text-state painted-text-state transparent-option-text" size="2" aria-label="Transparent option listbox">
          <option value="" selected></option>
          <option value="invisible">Invisible option row</option>
        </select>
        <select id="painted-selected-filter" class="paintless-text-state painted-text-state" aria-label="Painted selected filter">
          <option value="one" label="" selected>Selected visible text</option>
          <option value="two">Second visible text</option>
        </select>
        <input id="hidden-input-placeholder" class="paintless-text-state painted-placeholder" type="text"
          aria-label="Hidden input placeholder" placeholder="Painted placeholder">
        <textarea id="hidden-textarea-placeholder" class="paintless-text-state painted-placeholder"
          aria-label="Hidden textarea placeholder" placeholder="Painted placeholder"></textarea>
        <input id="visible-input-placeholder" class="paintless-text-state painted-placeholder" type="text"
          aria-label="Visible input placeholder" placeholder="Painted placeholder" value="Stale default value">
        <textarea id="visible-textarea-placeholder" class="paintless-text-state painted-placeholder"
          aria-label="Visible textarea placeholder" placeholder="Painted placeholder">Stale default text</textarea>
        <input id="unsupported-date-placeholder" class="paintless-text-state painted-placeholder" type="date"
          aria-label="Unsupported date placeholder" placeholder="Painted placeholder">
        <textarea id="empty-current-textarea" class="paintless-text-state painted-text-state" aria-label="Empty current textarea">Stale default text</textarea>
        <form id="painted-current-form">
          <textarea id="painted-current-textarea" class="paintless-text-state painted-text-state" aria-label="Painted current textarea">Stale default text</textarea>
          <input class="paintless-text-state painted-text-state" type="text" aria-label="Painted supporting field" value="Supporting visible text">
        </form>
        <script>
          const inputValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
          inputValueSetter.call(document.getElementById('hidden-input-placeholder'), 'Invisible current value');
          inputValueSetter.call(document.getElementById('visible-input-placeholder'), '');
          valueSetter.call(document.getElementById('hidden-textarea-placeholder'), 'Invisible current value');
          valueSetter.call(document.getElementById('visible-textarea-placeholder'), '');
          valueSetter.call(document.getElementById('empty-current-textarea'), '');
          valueSetter.call(document.getElementById('painted-current-textarea'), 'Current visible text');
        </script>`)
      return
    }
    if (requestUrl === '/visible-state-web-animation') {
      response.end(`<!doctype html><title>Visible Web Animation contract</title>
        <select id="semantic-web-animation-filter" aria-label="Semantic Web Animation filter">
          <option value="one" selected>Same visible label</option>
          <option value="two">Same visible label</option>
        </select>
        <script>
          document.getElementById('semantic-web-animation-filter').animate(
            [{ background: 'rgb(255, 0, 0)' }, { background: 'rgb(0, 0, 255)' }],
            { duration: 80, direction: 'alternate', iterations: Infinity },
          );
        </script>`)
      return
    }
    if (requestUrl === '/cssom-capture-stability') {
      response.end(`<!doctype html><title>CSSOM capture stability</title>
        <style id="mutable-sheet">.cssom-control { color: rgb(10, 20, 30); }</style>
        <input class="cssom-control" type="search" aria-label="CSSOM stable search">
        <script>
          const constructed = new CSSStyleSheet();
          constructed.replaceSync('.constructed-control { color: rgb(20, 30, 40); }');
          document.adoptedStyleSheets = [...document.adoptedStyleSheets, constructed];
          window.fixtureConstructedSheet = constructed;
        </script>`)
      return
    }
    if (requestUrl === '/analysis-scroll-stability') {
      response.end(`<!doctype html><title>Analysis scroll stability</title>
        <style>
          body { min-height: 2200px; margin: 0; }
          #main-scroll-search { position: absolute; left: 30px; top: 360px; width: 220px; height: 36px; }
          #nested-scroll-host { position: absolute; left: 30px; top: 470px; width: 420px; height: 180px; overflow: auto; border: 1px solid #333; }
          #nested-scroll-search { display: block; width: 220px; height: 36px; margin-top: 60px; }
          #nested-scroll-tail { height: 600px; }
        </style>
        <input id="main-scroll-search" type="search" aria-label="Main scroll search">
        <div id="nested-scroll-host">
          <input id="nested-scroll-search" type="search" aria-label="Nested scroll search">
          <div id="nested-scroll-tail"></div>
        </div>
        <script>
          addEventListener('load', () => {
            scrollTo(0, 260);
            document.getElementById('nested-scroll-host').scrollTop = 20;
          });
        </script>`)
      return
    }
    if (requestUrl === '/date-like-forms') {
      response.end(`<!doctype html><title>Date-like forms</title>
        <form><input type="date" min="2026-01-14" max="2026-01-18" name="start_date" aria-label="Start date"><input type="text" name="date_details" aria-label="Date details"></form>
        <form><input type="month" min="2026-01" max="2026-05" step="2" name="start_month" aria-label="Start month"><input type="text" name="month_details" aria-label="Month details"></form>
        <form><input type="time" min="12:00:30" max="12:02:00" step="30" name="start_time" aria-label="Start time"><input type="text" name="time_details" aria-label="Time details"></form>
        <form><input type="week" min="2026-W52" max="2027-W02" name="start_week" aria-label="Start week"><input type="text" name="week_details" aria-label="Week details"></form>
        <form><input type="date" min="2026-01-01" name="open_date" aria-label="Open date"><input type="text" aria-label="Open date details"></form>
        <form><input type="date" min="2020-01-01" max="2022-01-01" name="large_date" aria-label="Large date"><input type="text" aria-label="Large date details"></form>
        <form><input type="date" min="2026-02-31" max="2026-03-05" name="invalid_date" aria-label="Invalid date"><input type="text" aria-label="Invalid date details"></form>`)
      return
    }
    if (requestUrl === '/numeric-bounds') {
      response.end(`<!doctype html><title>Numeric bounds</title>
        <form><input type="range" min="10" max="20" step="2" aria-label="Bounded range"><input type="text" aria-label="Range details"></form>
        <form><input type="number" max="0.7" step="0.2" aria-label="Bounded decimal"><input type="text" aria-label="Decimal details"></form>
        <form><input type="range" min="10" max="20" step="0" aria-label="Zero step"><input type="text" aria-label="Zero step details"></form>
        <form><input type="range" min="10" max="20" step="-2" aria-label="Negative step"><input type="text" aria-label="Negative step details"></form>
        <form><input type="number" min="0" max="3" step="1" value="1" aria-label="Current one"><input type="text" aria-label="Current one details"></form>
        <form><input type="range" min="10" max="20" step="2" value="10" aria-label="Current stepped minimum"><input type="text" aria-label="Current stepped details"></form>
        <form><input type="number" min="5" max="5" step="1" value="5" aria-label="Single numeric state"><input type="text" aria-label="Single state details"></form>`)
      return
    }
    if (requestUrl === '/radio-native-groups') {
      response.end(`<!doctype html><title>Native radio groups</title>
        <form id="safe-radio-form">
          <input id="safe-radio-a" type="radio" name="safe_mode" value="a" checked><label for="safe-radio-a">Safe A</label>
          <input id="safe-radio-b" type="radio" name="safe_mode" value="b"><label for="safe-radio-b">Safe B</label>
          <input type="text" aria-label="Safe radio detail">
        </form>
        <form id="hidden-radio-form">
          <input type="radio" name="hidden_mode" value="a" checked aria-label="Hidden group A">
          <input type="radio" name="hidden_mode" value="b" aria-label="Hidden group B">
          <input id="hidden-radio-member" type="radio" name="hidden_mode" value="hidden" aria-label="Hidden group member" hidden>
          <input type="text" aria-label="Hidden radio detail">
        </form>
        <form id="sensitive-radio-form">
          <input type="radio" name="sensitive_mode" value="a" checked aria-label="Sensitive group A">
          <input type="radio" name="sensitive_mode" value="b" aria-label="Sensitive group B">
          <input type="radio" name="sensitive_mode" value="secret" title="Credit card number">
          <input type="text" aria-label="Sensitive radio detail">
        </form>`)
      return
    }
    if (requestUrl === '/checkbox-samples') {
      response.end(`<!doctype html><title>Checkbox samples</title>
        <form id="checked-form">
          <input id="checked-one" type="checkbox" aria-label="Checked one" checked>
          <input id="checked-two" type="checkbox" aria-label="Checked two" checked>
        </form>
        <form id="unchecked-form">
          <input id="unchecked-one" type="checkbox" aria-label="Unchecked one">
          <input id="unchecked-two" type="checkbox" aria-label="Unchecked two">
        </form>
        <form id="required-unchecked-form">
          <input id="required-unchecked" type="checkbox" required aria-label="Required unchecked">
          <input id="required-unchecked-detail" type="text" aria-label="Required unchecked detail">
        </form>
        <form id="required-checked-form">
          <input id="required-checked" type="checkbox" required checked aria-label="Required checked">
          <input id="required-checked-first" type="text" aria-label="Required checked first">
          <input id="required-checked-second" type="text" aria-label="Required checked second">
        </form>
        <form id="late-required-checkbox-form">
          <input id="late-required-checkbox" type="checkbox" aria-label="Late required checkbox">
          <input id="late-required-checkbox-detail" type="text" aria-label="Late required checkbox detail">
        </form>
        <form id="aria-required-unchecked-form">
          <input id="aria-required-unchecked" type="checkbox" aria-required="true" aria-label="ARIA required unchecked">
          <input type="text" aria-label="ARIA required unchecked detail">
        </form>
        <form id="aria-required-checked-form">
          <input id="aria-required-checked" type="checkbox" aria-required="true" checked aria-label="ARIA required checked">
          <input type="text" aria-label="ARIA required checked first">
          <input type="text" aria-label="ARIA required checked second">
        </form>
        <form id="late-aria-required-form">
          <input id="late-aria-required" type="checkbox" aria-label="Late ARIA required checkbox">
          <input id="late-aria-required-detail" type="text" aria-label="Late ARIA required detail">
        </form>`)
      return
    }
    if (requestUrl === '/target-value-safety') {
      response.end(`<!doctype html><title>Target value safety</title>
        <form id="sensitive-live-form">
          <input id="sensitive-live-value" type="text" aria-label="Safe reference" value="Credit card number">
          <input type="text" aria-label="Safe reference detail">
        </form>
        <form id="sensitive-range-form">
          <input id="sensitive-range-value" type="range" min="0" max="100" value="25" aria-label="Safe range" aria-valuetext="Bank account">
          <input type="text" aria-label="Safe range detail">
        </form>
        <form id="neutral-live-form">
          <input id="neutral-live-value" type="text" aria-label="Neutral reference" value="private-draft">
          <input id="neutral-live-detail" type="text" aria-label="Neutral reference detail">
        </form>
        <form id="late-live-form">
          <input id="late-live-value" type="text" aria-label="Late reference" value="initial-draft">
          <input id="late-live-detail" type="text" aria-label="Late reference detail">
        </form>
        <form id="late-range-form">
          <input id="late-range-value" type="range" min="0" max="100" value="25" aria-label="Late range">
          <input id="late-range-detail" type="text" aria-label="Late range detail">
        </form>
        <form id="sensitive-checkbox-value-form">
          <input id="sensitive-checkbox-value" type="checkbox" value="Credit card number" aria-label="Sensitive checkbox value">
          <input type="text" aria-label="Sensitive checkbox detail">
        </form>
        <form id="late-checkbox-value-form">
          <input id="late-checkbox-value" type="checkbox" value="neutral-choice" aria-label="Late checkbox value">
          <input id="late-checkbox-detail" type="text" aria-label="Late checkbox detail">
        </form>
        <form id="sensitive-radio-value-form">
          <label><input id="sensitive-radio-value-a" type="radio" name="sensitive-choice" value="neutral-choice" checked> Sensitive radio A</label>
          <label><input id="sensitive-radio-value-b" type="radio" name="sensitive-choice" value="Credit card number"> Sensitive radio B</label>
          <input type="text" aria-label="Sensitive radio detail">
        </form>
        <form id="late-radio-value-form">
          <label><input id="late-radio-value-a" type="radio" name="late-choice" value="first-choice" checked> Late radio A</label>
          <label><input id="late-radio-value-b" type="radio" name="late-choice" value="second-choice"> Late radio B</label>
          <input id="late-radio-detail" type="text" aria-label="Late radio detail">
        </form>`)
      return
    }
    if (requestUrl === '/bounded-dom') {
      response.end(`<!doctype html><title>Bounded DOM</title>
        <input id="bounded-search" type="search" aria-label="Bounded search">
        <select id="disabled-option-flood" aria-label="Category filter"></select>
        <input id="many-labels" type="text" aria-label="Many labels">
        <input id="many-references" type="text" aria-label="Many references">
        <input id="huge-autocomplete" type="text" aria-label="Huge autocomplete">
        <input id="huge-label" type="text" aria-label="Huge label">
        <div id="huge-description"></div>
        <input id="huge-description-control" type="text" aria-label="Huge description" aria-describedby="huge-description">
        <input id="huge-numeric-min" type="number" aria-label="Huge numeric min">
        <input id="huge-numeric-max" type="number" aria-label="Huge numeric max">
        <input id="huge-numeric-step" type="number" aria-label="Huge numeric step">
        <input id="huge-numeric-value" type="number" aria-label="Huge numeric value">
        <input id="huge-date-min" type="date" max="2026-01-02" aria-label="Huge date min">
        <input id="huge-date-max" type="date" min="2026-01-01" aria-label="Huge date max">
        <input id="huge-date-step" type="date" min="2026-01-01" max="2026-01-02" aria-label="Huge date step">
        <a id="huge-link-path">Huge link path</a>
        <script>
          const select = document.getElementById('disabled-option-flood');
          const options = document.createDocumentFragment();
          for (let index = 0; index < 400; index += 1) {
            const option = document.createElement('option'); option.disabled = true; option.textContent = 'Disabled ' + index; options.append(option);
          }
          for (let index = 0; index < 2; index += 1) {
            const option = document.createElement('option'); option.value = 'enabled-' + index; option.textContent = 'Enabled ' + index; options.append(option);
          }
          select.append(options);
          const labels = document.createDocumentFragment();
          for (let index = 0; index < 400; index += 1) {
            const label = document.createElement('label'); label.htmlFor = 'many-labels'; label.hidden = true; label.textContent = 'Context ' + index; labels.append(label);
          }
          document.body.append(labels);
          const references = [];
          const referenceNodes = document.createDocumentFragment();
          for (let index = 0; index < 400; index += 1) {
            const node = document.createElement('span'); node.id = 'reference-' + index; node.hidden = true; node.textContent = 'Reference ' + index; references.push(node.id); referenceNodes.append(node);
          }
          document.body.append(referenceNodes);
          document.getElementById('many-references').setAttribute('aria-describedby', references.join(' '));
          document.getElementById('huge-autocomplete').setAttribute('autocomplete', ('neutral '.repeat(1200)).trim());
          document.getElementById('huge-label').setAttribute('aria-label', ('Neutral label '.repeat(900)).trim());
          const hugeText = document.createDocumentFragment();
          for (let index = 0; index < 300; index += 1) {
            const span = document.createElement('span'); span.textContent = 'x'.repeat(32); hugeText.append(span);
          }
          document.getElementById('huge-description').append(hugeText);
          const hugeAttribute = '1'.repeat(5000);
          document.getElementById('huge-numeric-min').setAttribute('min', hugeAttribute);
          document.getElementById('huge-numeric-max').setAttribute('max', hugeAttribute);
          document.getElementById('huge-numeric-step').setAttribute('step', hugeAttribute);
          document.getElementById('huge-numeric-value').setAttribute('value', hugeAttribute);
          document.getElementById('huge-date-min').setAttribute('min', hugeAttribute);
          document.getElementById('huge-date-max').setAttribute('max', hugeAttribute);
          document.getElementById('huge-date-step').setAttribute('step', hugeAttribute);
          document.getElementById('huge-link-path').setAttribute('href', '/safe?value=' + 'x'.repeat(5000));
          const nonControls = document.createDocumentFragment();
          for (let index = 0; index < 4000; index += 1) nonControls.append(document.createElement('div'));
          document.body.append(nonControls);
          const late = document.createElement('input'); late.type = 'search'; late.setAttribute('aria-label', 'Late unbounded search'); document.body.append(late);
        </script>`)
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
          <input type="text" name="reference_title" aria-label="Neutral field N" title="Credit card number">
        </form>`)
      return
    }
    if (requestUrl === '/accessible-sensitive-labels') {
      response.end(`<!doctype html><title>Accessible label safety</title>
        <span id="neutral-description">Reference</span>
        <span id="payment-description">Credit card</span>
        <svg aria-hidden="true"><text id="svg-payment-description">Payment card</text></svg>
        <span id="safe-help">Optional context</span>
        <span id="password-help">User password</span>
        <svg aria-hidden="true"><text id="svg-card-help">Credit card number</text></svg>
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
          <input type="text" name="safe_help_value" aria-label="Safe described field" aria-describedby="safe-help">
          <input type="text" name="password_help_value" aria-label="Password described field" aria-describedby="password-help">
          <input type="text" name="svg_help_value" aria-label="SVG described field" aria-describedby="svg-card-help">
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
    if (requestUrl.startsWith('/webtransport-egress')) {
      const probePort = new URL(requestUrl, 'http://fixture.invalid').searchParams.get('port') ?? '1'
      const transportUrl = `https://127.0.0.1:${probePort}`
      response.end(`<!doctype html><title>WebTransport boundary</title>
        <input type="search" aria-label="Allowed page search">
        <script>
          globalThis.webTransportProof = {
            window: 'pending', dedicated: 'pending', shared: 'pending', worklet: 'pending'
          };
          try {
            new WebTransport(${JSON.stringify(transportUrl)});
            webTransportProof.window = 'constructed';
          } catch (error) {
            webTransportProof.window = error && error.name === 'SecurityError' ? 'blocked' : 'error';
          }
          const workerSource = ${JSON.stringify(`
            self.onmessage = ({ data }) => {
              try {
                const transport = new WebTransport(data);
                transport.ready.then(
                  () => self.postMessage('connected'),
                  () => self.postMessage('blocked'),
                );
              } catch { self.postMessage('blocked'); }
            };
          `)};
          try {
            const worker = new Worker(URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' })));
            worker.onmessage = ({ data }) => { webTransportProof.dedicated = data; worker.terminate(); };
            worker.postMessage(${JSON.stringify(transportUrl)});
          } catch { webTransportProof.dedicated = 'blocked'; }
          try {
            const sharedSource = ${JSON.stringify(`
              self.onconnect = (event) => {
                const port = event.ports[0];
                port.onmessage = ({ data }) => {
                  try {
                    const transport = new WebTransport(data);
                    transport.ready.then(
                      () => port.postMessage('connected'),
                      () => port.postMessage('blocked'),
                    );
                  } catch { port.postMessage('blocked'); }
                };
                port.start();
              };
            `)};
            const shared = new SharedWorker(URL.createObjectURL(new Blob([sharedSource], { type: 'text/javascript' })));
            shared.port.onmessage = ({ data }) => { webTransportProof.shared = data; shared.port.close(); };
            shared.port.start();
            shared.port.postMessage(${JSON.stringify(transportUrl)});
          } catch { webTransportProof.shared = 'blocked'; }
          (async () => {
            try {
              const context = new OfflineAudioContext(1, 128, 44100);
              const moduleSource = ${JSON.stringify(`
                class WebTransportProbe extends AudioWorkletProcessor {
                  constructor() {
                    super();
                    let result = 'not-exposed';
                    if (typeof WebTransport === 'function') {
                      try { new WebTransport('${transportUrl}'); result = 'constructed'; }
                      catch { result = 'blocked'; }
                    }
                    this.port.postMessage(result);
                  }
                  process() { return false; }
                }
                registerProcessor('webtransport-probe', WebTransportProbe);
              `)};
              await context.audioWorklet.addModule(URL.createObjectURL(new Blob([moduleSource], { type: 'text/javascript' })));
              const node = new AudioWorkletNode(context, 'webtransport-probe');
              node.port.onmessage = ({ data }) => { webTransportProof.worklet = data; };
              node.connect(context.destination);
              await context.startRendering();
            } catch { webTransportProof.worklet = 'probe-error'; }
          })();
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
  sessionExpiresAtMs?: number
  sessionTtlMs?: number
  maxTargetResourceBytes?: number
  maxTargetSessionBytes?: number
  beforeDomEvidenceCollection?: (page: Page, attempt: number) => Promise<void>
  beforeAnalysisScreenshot?: (page: Page, attempt: number) => Promise<void>
  afterAnalysisScreenshot?: (page: Page, attempt: number) => Promise<void>
  beforeControlWrite?: (page: Page) => Promise<void>
  beforeRadioGroupWrite?: (page: Page) => Promise<void>
  afterActionRecapture?: (page: Page) => Promise<void>
  duringActionCaptureArm?: (page: Page) => Promise<void>
  beforeActionStateCapture?: (page: Page) => Promise<void>
  beforeSubframeOwnerLookup?: (page: Page, frameId: string, attempt: number) => Promise<void>
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
    sessionExpiresAtMs: options.sessionExpiresAtMs,
    sessionTtlMs: options.sessionTtlMs,
    maxTargetResourceBytes: options.maxTargetResourceBytes,
    maxTargetSessionBytes: options.maxTargetSessionBytes,
    beforeDomEvidenceCollection: options.beforeDomEvidenceCollection,
    beforeAnalysisScreenshot: options.beforeAnalysisScreenshot,
    afterAnalysisScreenshot: options.afterAnalysisScreenshot,
    beforeControlWrite: options.beforeControlWrite,
    beforeRadioGroupWrite: options.beforeRadioGroupWrite,
    afterActionRecapture: options.afterActionRecapture,
    duringActionCaptureArm: options.duringActionCaptureArm,
    beforeActionStateCapture: options.beforeActionStateCapture,
    beforeSubframeOwnerLookup: options.beforeSubframeOwnerLookup,
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
  cdp: CDPSession
  context: { newCDPSession: (page: Page) => Promise<CDPSession> }
  expiresAt: number
  createdAtMs: number
  networkLocked: boolean
  networkMode: string
  activeNetworkMetrics: unknown
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

describe('isConsequentialNavigationUrl', () => {
  it('checks decoded fragment routes without rejecting neutral fragments', () => {
    expect(isConsequentialNavigationUrl('https://public.example.at/about#/checkout')).toBe(true)
    expect(isConsequentialNavigationUrl('https://public.example.at/about#/%62ooking')).toBe(true)
    expect(isConsequentialNavigationUrl('https://public.example.at/safe%ZZ?next=%63heckout')).toBe(true)
    expect(isConsequentialNavigationUrl('https://public.example.at/about#/chec%E2%80%8Bkout')).toBe(true)
    expect(isConsequentialNavigationUrl('https://public.example.at/about#/%EF%BD%83%EF%BD%88%EF%BD%85%EF%BD%83%EF%BD%8B%EF%BD%8F%EF%BD%95%EF%BD%94')).toBe(true)
    expect(isConsequentialNavigationUrl(`https://public.example.at/${encodeURIComponent('\uFDFA'.repeat(300))}`)).toBe(true)
    expect(isConsequentialNavigationUrl('https://public.example.at/about#overview')).toBe(false)
    expect(isConsequentialNavigationUrl('https://public.example.at/%C3%9Cberblick')).toBe(false)
  })
})

describe('WrapperProofService security boundaries', () => {
  it('retains capacity for aborted pending launches until every late browser is closed', async () => {
    const pendingLaunches: Array<{
      resolveBrowser: (browser: Browser) => void
      close: ReturnType<typeof vi.fn>
      finishClose: () => void
    }> = []
    const launchBrowser = vi.fn(() => {
      let resolveBrowser!: (browser: Browser) => void
      let resolveClose!: () => void
      const close = vi.fn(() => new Promise<void>((resolve) => { resolveClose = resolve }))
      const browser = { close } as unknown as Browser
      const launch = new Promise<Browser>((resolve) => { resolveBrowser = resolve })
      pendingLaunches.push({
        resolveBrowser,
        close,
        finishClose: () => resolveClose(),
      })
      return launch.then(() => browser)
    })
    const service = new WrapperProofService({
      resolveTarget: async (value) => {
        const url = new URL(value)
        return {
          url: url.toString(),
          origin: url.origin,
          hostname: url.hostname,
          pinnedAddress: '203.0.113.10',
          addresses: [{ address: '203.0.113.10', family: 4 }],
        }
      },
      launchBrowser,
    })
    services.push(service)

    const controllers = Array.from({ length: 3 }, () => new AbortController())
    const attempts = controllers.map((controller) =>
      service.analyze('https://public.example.at/', controller.signal))
    await vi.waitFor(() => expect(launchBrowser).toHaveBeenCalledTimes(3))
    controllers.forEach((controller) => controller.abort())
    await Promise.all(attempts.map((attempt) =>
      expect(attempt).rejects.toMatchObject({ name: 'AbortError' })))
    expect(internalServiceState(service)).toEqual({ sessions: 0, reservations: 3 })

    await expect(service.analyze('https://public.example.at/')).rejects.toMatchObject({
      code: 'sandbox_capacity',
      status: 503,
    })
    expect(launchBrowser).toHaveBeenCalledTimes(3)

    pendingLaunches.forEach(({ resolveBrowser }) => resolveBrowser({} as Browser))
    await vi.waitFor(() => pendingLaunches.forEach(({ close }) => expect(close).toHaveBeenCalledOnce()))
    expect(internalServiceState(service)).toEqual({ sessions: 0, reservations: 3 })
    pendingLaunches.forEach(({ finishClose }) => finishClose())
    await vi.waitFor(() => expect(internalServiceState(service)).toEqual({ sessions: 0, reservations: 0 }))

    const recoveryController = new AbortController()
    const recovery = service.analyze('https://public.example.at/', recoveryController.signal)
    await vi.waitFor(() => expect(launchBrowser).toHaveBeenCalledTimes(4))
    recoveryController.abort()
    await expect(recovery).rejects.toMatchObject({ name: 'AbortError' })
    pendingLaunches[3]!.resolveBrowser({} as Browser)
    await vi.waitFor(() => expect(pendingLaunches[3]!.close).toHaveBeenCalledOnce())
    pendingLaunches[3]!.finishClose()
    await vi.waitFor(() => expect(internalServiceState(service)).toEqual({ sessions: 0, reservations: 0 }))
  })

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
    expect(result.structuredContent.blockedNetworkRequests).toBe(0)
    expect(filterResult.structuredContent).toMatchObject({
      actionKind: 'filter',
      targetStateVerified: true,
      networkPolicy: 'blocked-after-preparation',
      allowedNetworkRequests: 0,
    })
    expect(filterResult.structuredContent.blockedNetworkRequests).toBe(0)
    expect(filterResult.analysis.title).toBe('Hostile fixture')
    expect(result.analysis.capabilities.some(({ kind }) => kind === 'navigation')).toBe(false)
    expect(result.finalUrl).toBe(`${fixture.origin}/slow-page`)
  })

  it('prepares native control and radio state without invoking page-authored events or side effects', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService()
    services.push(service)
    let analysis = await service.analyze(`${fixture.origin}/event-free-preparation`)
    const page = internalSession(service, analysis.sessionId).page
    const values = async () => page.locator('#sensitive-card, #sensitive-password, #hidden-consequential')
      .evaluateAll((controls) => controls.map((control) => (control as HTMLInputElement).value))
    const counters = async () => page.evaluate(() =>
      (window as unknown as { preparationEvents: { control: number, radio: number } }).preparationEvents)
    const capabilityFor = (snapshot: typeof analysis, label: string) => {
      const evidenceId = snapshot.domEvidence.find((evidence) => evidence.label === label)!.id
      return snapshot.capabilities.find(({ evidenceIds }) => evidenceIds.includes(evidenceId))!
    }

    const excludedBefore = await values()
    const controlForm = capabilityFor(analysis, 'Safe project reference')
    const controlResult = await service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      controlForm.name,
      controlForm.sampleInput,
      undefined,
      controlForm.id,
    )
    expect(controlResult.structuredContent).toMatchObject({
      isolatedStateChanged: true,
      targetStateVerified: true,
      allowedNetworkRequests: 0,
      blockedNetworkRequests: 0,
    })
    expect(await page.locator('#safe-control').inputValue()).toBe(String(controlForm.sampleInput.field_1))
    expect(await values()).toEqual(excludedBefore)
    expect(await counters()).toEqual({ control: 0, radio: 0 })
    expect(fixture.requests.some((url) => url.startsWith('/collect'))).toBe(false)

    analysis = controlResult.analysis
    const radioForm = capabilityFor(analysis, 'Mode A')
    const radioResult = await service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      radioForm.name,
      radioForm.sampleInput,
      undefined,
      radioForm.id,
    )
    expect(radioResult.structuredContent).toMatchObject({
      isolatedStateChanged: true,
      targetStateVerified: true,
      allowedNetworkRequests: 0,
      blockedNetworkRequests: 0,
    })
    expect(await page.locator('#event-radio-a, #event-radio-b').evaluateAll(
      (radios) => radios.map((radio) => (radio as HTMLInputElement).checked),
    )).toEqual([false, true])
    expect(await values()).toEqual(excludedBefore)
    expect(await counters()).toEqual({ control: 0, radio: 0 })
    expect(fixture.requests.some((url) => url.startsWith('/collect'))).toBe(false)
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
    expect(selectForm.sampleInput).toEqual({ field_1: 0, field_2: 'A' })
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
    expect(filterResult.analysis.title).toBe('Disabled optgroup selects')
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
    expect(firstEnabledResult.analysis.title).toBe('Disabled optgroup selects')
    analysis = firstEnabledResult.analysis

    const form = analysis.capabilities.find(({ name }) => name === 'prepare_visible_form')!
    expect(form.inputSchema).toMatchObject({
      properties: { field_1: { minimum: 0, maximum: 1 } },
    })
    expect(form.sampleInput).toEqual({ field_1: 1, field_2: 'A' })
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

  it('keeps required single-select mappings, samples, validation, and native validity aligned', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService()
    services.push(service)
    const analysis = await service.analyze(`${fixture.origin}/required-select-contracts`)
    const page = internalSession(service, analysis.sessionId).page

    const filter = analysis.capabilities.find(({ name }) => name === 'set_page_filter')!
    expect(filter.inputSchema).toMatchObject({
      properties: { optionIndex: { type: 'integer', minimum: 0, maximum: 1 } },
    })
    expect(filter.sampleInput).toEqual({ optionIndex: 0 })
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      filter.name,
      { optionIndex: 2 },
      undefined,
      filter.id,
    )).rejects.toMatchObject({ code: 'invalid_action', status: 400, sessionInvalidated: false })
    expect(await page.locator('#required-filter').inputValue()).toBe('')

    const capabilityFor = (label: string) => {
      const evidenceId = analysis.domEvidence.find((evidence) => evidence.label === label)!.id
      return analysis.capabilities.find(({ evidenceIds }) => evidenceIds.includes(evidenceId))
    }
    const requiredForm = capabilityFor('Required form choice')!
    expect(requiredForm.inputSchema).toMatchObject({
      properties: {
        field_1: { type: 'integer', minimum: 0, maximum: 1 },
        field_2: { type: 'string' },
      },
    })
    expect(requiredForm.sampleInput).toEqual({ field_1: 0, field_2: 'A' })
    expect(JSON.stringify(requiredForm)).not.toContain('Choose option')
    const requiredResult = await service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      requiredForm.name,
      requiredForm.sampleInput,
      undefined,
      requiredForm.id,
    )
    expect(requiredResult.structuredContent).toMatchObject({
      isolatedStateChanged: true,
      targetStateVerified: true,
    })
    expect(await page.locator('#required-form-select').inputValue()).toBe('one')
    expect(await page.locator('#required-form-select').evaluate((select) =>
      (select as HTMLSelectElement).validity.valid)).toBe(true)

    expect(capabilityFor('Only empty required')).toBeUndefined()
    const updatedCapabilityFor = (label: string) => {
      const evidenceId = requiredResult.analysis.domEvidence.find((evidence) => evidence.label === label)!.id
      return requiredResult.analysis.capabilities.find(({ evidenceIds }) => evidenceIds.includes(evidenceId))
    }
    const optionalForm = updatedCapabilityFor('Optional empty choice')!
    expect(optionalForm.inputSchema).toMatchObject({
      properties: { field_1: { minimum: 0, maximum: 1 } },
    })
    expect(optionalForm.sampleInput.field_1).toBe(0)
    const optionalResult = await service.execute(
      requiredResult.analysis.sessionId,
      requiredResult.analysis.sessionToken,
      optionalForm.name,
      optionalForm.sampleInput,
      undefined,
      optionalForm.id,
    )
    expect(optionalResult).toMatchObject({ structuredContent: { targetStateVerified: true } })
    expect(await page.locator('#nonrequired-empty').inputValue()).toBe('')

    const lateEvidence = optionalResult.analysis.domEvidence.find(({ label }) => label === 'Late required choice')!
    const lateForm = optionalResult.analysis.capabilities.find(({ evidenceIds }) => evidenceIds.includes(lateEvidence.id))!
    await page.locator('#late-required-select').evaluate((select) => {
      (select as HTMLSelectElement).required = true
    })
    await expect(service.execute(
      optionalResult.analysis.sessionId,
      optionalResult.analysis.sessionToken,
      lateForm.name,
      lateForm.sampleInput,
      undefined,
      lateForm.id,
    )).rejects.toMatchObject({ code: 'invalid_action', sessionInvalidated: false })
    expect(await page.locator('#late-required-select').inputValue()).toBe('one')
    expect(await page.locator('#late-required-select-detail').inputValue()).toBe('')

    const raceService = createService({ actionStartDelayMs: 200 })
    services.push(raceService)
    const raceAnalysis = await raceService.analyze(`${fixture.origin}/required-select-contracts`)
    const raceEvidence = raceAnalysis.domEvidence.find(({ label }) => label === 'Required form choice')!
    const raceCapability = raceAnalysis.capabilities.find(({ evidenceIds }) => evidenceIds.includes(raceEvidence.id))!
    const racePage = internalSession(raceService, raceAnalysis.sessionId).page
    const pending = raceService.execute(
      raceAnalysis.sessionId,
      raceAnalysis.sessionToken,
      raceCapability.name,
      raceCapability.sampleInput,
      undefined,
      raceCapability.id,
    )
    await new Promise((resolve) => setTimeout(resolve, 40))
    await racePage.locator('#required-form-select option[value="one"]').evaluate((option) => {
      (option as HTMLOptionElement).value = ''
    })
    await expect(pending).rejects.toMatchObject({ code: 'action_failed', sessionInvalidated: true })
    expect(internalServiceState(raceService)).toEqual({ sessions: 0, reservations: 0 })

    const customService = createService()
    services.push(customService)
    const customAnalysis = await customService.analyze(`${fixture.origin}/required-select-contracts`)
    const customEvidence = customAnalysis.domEvidence
      .find(({ label }) => label === 'Custom invalid required choice')!
    const customCapability = customAnalysis.capabilities
      .find(({ evidenceIds }) => evidenceIds.includes(customEvidence.id))!
    const customPage = internalSession(customService, customAnalysis.sessionId).page
    let customEvents = 0
    await customPage.exposeFunction('recordCustomSelectEvent', () => { customEvents += 1 })
    await customPage.locator('#custom-invalid-required').evaluate((select) => {
      for (const eventName of ['input', 'change', 'invalid']) {
        select.addEventListener(eventName, () => {
          void (window as unknown as { recordCustomSelectEvent(): Promise<void> })
            .recordCustomSelectEvent()
        })
      }
    })
    expect(await customPage.locator('#custom-invalid-required').evaluate((select) => {
      const control = select as HTMLSelectElement
      return {
        selectedIndex: control.selectedIndex,
        customError: control.validity.customError,
        valueMissing: control.validity.valueMissing,
        valid: control.validity.valid,
        validationMessage: control.validationMessage,
      }
    })).toEqual({
      selectedIndex: 0,
      customError: true,
      valueMissing: true,
      valid: false,
      validationMessage: 'Page-owned custom warning',
    })
    const customResult = await customService.execute(
      customAnalysis.sessionId,
      customAnalysis.sessionToken,
      customCapability.name,
      customCapability.sampleInput,
      undefined,
      customCapability.id,
    )
    expect(customResult.structuredContent).toMatchObject({
      isolatedStateChanged: true,
      targetStateVerified: true,
    })
    expect(await customPage.locator('#custom-invalid-required').evaluate((select) => {
      const control = select as HTMLSelectElement
      return {
        selectedIndex: control.selectedIndex,
        customError: control.validity.customError,
        valueMissing: control.validity.valueMissing,
        valid: control.validity.valid,
        validationMessage: control.validationMessage,
      }
    })).toEqual({
      selectedIndex: 1,
      customError: true,
      valueMissing: false,
      valid: false,
      validationMessage: 'Page-owned custom warning',
    })
    expect(customEvents).toBe(0)
  }, 10_000)

  it('classifies every retained select label, text, and value and samples a different safe option', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService()
    services.push(service)
    const analysis = await service.analyze(`${fixture.origin}/select-safety-contracts`)

    expect(analysis.domEvidence.map(({ label, sensitive }) => ({ label, sensitive }))).toEqual([
      { label: 'Category filter', sensitive: true },
      { label: 'Sort filter', sensitive: true },
      { label: 'Status filter', sensitive: false },
      { label: 'Type filter', sensitive: true },
    ])
    const filter = analysis.capabilities.find(({ name }) => name === 'set_page_filter')!
    expect(analysis.capabilities.filter(({ kind }) => kind === 'filter')).toHaveLength(1)
    expect(filter.sampleInput).toEqual({ optionIndex: 1 })
    expect(filter.inputSchema).toMatchObject({
      properties: { optionIndex: { minimum: 0, maximum: 1 } },
    })
    const result = await service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      filter.name,
      filter.sampleInput,
      undefined,
      filter.id,
    )
    expect(result.structuredContent).toMatchObject({
      isolatedStateChanged: true,
      targetStateVerified: true,
    })
    expect(await internalSession(service, analysis.sessionId).page.locator('#safe-filter').evaluate(
      (select) => (select as HTMLSelectElement).selectedIndex,
    )).toBe(1)
  })

  it('classifies bounded option accessible names privately and revalidates direct and referenced drift', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService()
    services.push(service)
    const analysis = await service.analyze(`${fixture.origin}/select-option-accessible-safety`)
    const page = internalSession(service, analysis.sessionId).page
    const evidence = analysis.domEvidence.map(({ label, sensitive }) => ({ label, sensitive }))
    expect(evidence).toEqual([
      { label: 'Direct option filter', sensitive: true },
      { label: 'Referenced option filter', sensitive: true },
      { label: 'Neutral option filter', sensitive: false },
      { label: 'Late direct option filter', sensitive: false },
      { label: 'Overflow option filter', sensitive: true },
    ])
    const publicAnalysis = JSON.stringify({
      domEvidence: analysis.domEvidence,
      axEvidence: analysis.axEvidence,
      capabilities: analysis.capabilities,
    })
    expect(publicAnalysis).not.toMatch(/Credit card number|initial-option-reference|late-option-reference/)
    const capabilityFor = (snapshot: typeof analysis, label: string) => {
      const evidenceId = snapshot.domEvidence.find((item) => item.label === label)!.id
      return snapshot.capabilities.find(({ evidenceIds }) => evidenceIds.includes(evidenceId))!
    }
    const neutral = capabilityFor(analysis, 'Neutral option filter')
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      neutral.name,
      neutral.sampleInput,
      undefined,
      neutral.id,
    )).resolves.toMatchObject({ structuredContent: { targetStateVerified: true } })
    expect(await page.locator('#neutral-option-filter').evaluate((select) =>
      (select as HTMLSelectElement).selectedIndex)).toBe(1)

    const preActionService = createService()
    services.push(preActionService)
    const preActionAnalysis = await preActionService.analyze(`${fixture.origin}/select-option-accessible-safety`)
    const preActionPage = internalSession(preActionService, preActionAnalysis.sessionId).page
    const direct = capabilityFor(preActionAnalysis, 'Late direct option filter')
    await preActionPage.locator('#late-direct-target').evaluate((option) => {
      option.setAttribute('aria-label', 'Credit card number')
    })
    await expect(preActionService.execute(
      preActionAnalysis.sessionId,
      preActionAnalysis.sessionToken,
      direct.name,
      direct.sampleInput,
      undefined,
      direct.id,
    )).rejects.toMatchObject({ code: 'invalid_action', sessionInvalidated: false })
    expect(await preActionPage.locator('#late-direct-option').evaluate((select) =>
      (select as HTMLSelectElement).selectedIndex)).toBe(0)
    await preActionPage.locator('#late-direct-target').evaluate((option) => {
      option.setAttribute('aria-label', 'Second choice')
    })
    const restoredDirectResult = await preActionService.execute(
      preActionAnalysis.sessionId,
      preActionAnalysis.sessionToken,
      direct.name,
      direct.sampleInput,
      undefined,
      direct.id,
    )
    expect(restoredDirectResult).toMatchObject({ structuredContent: { targetStateVerified: true } })
    const referencePreService = createService()
    services.push(referencePreService)
    const referencePreAnalysis = await referencePreService
      .analyze(`${fixture.origin}/select-option-reference-safety`)
    const referencePrePage = internalSession(referencePreService, referencePreAnalysis.sessionId).page
    const referencedPreAction = capabilityFor(referencePreAnalysis, 'Late reference option filter')
    await referencePrePage.locator('#late-option-reference').evaluate((node) => {
      node.setAttribute('aria-label', 'Password')
    })
    await expect(referencePreService.execute(
      referencePreAnalysis.sessionId,
      referencePreAnalysis.sessionToken,
      referencedPreAction.name,
      referencedPreAction.sampleInput,
      undefined,
      referencedPreAction.id,
    )).rejects.toMatchObject({ code: 'invalid_action', sessionInvalidated: false })
    expect(await referencePrePage.locator('#late-reference-option').evaluate((select) =>
      (select as HTMLSelectElement).selectedIndex)).toBe(0)
    await referencePrePage.locator('#late-option-reference').evaluate((node) => {
      node.removeAttribute('aria-label')
    })

    const raceService = createService({ actionStartDelayMs: 160 })
    services.push(raceService)
    const raceAnalysis = await raceService.analyze(`${fixture.origin}/select-option-reference-safety`)
    const racePage = internalSession(raceService, raceAnalysis.sessionId).page
    const referenced = capabilityFor(raceAnalysis, 'Late reference option filter')
    const pending = raceService.execute(
      raceAnalysis.sessionId,
      raceAnalysis.sessionToken,
      referenced.name,
      referenced.sampleInput,
      undefined,
      referenced.id,
    )
    await new Promise((resolve) => setTimeout(resolve, 30))
    await racePage.locator('#late-option-reference').evaluate((node) => {
      node.textContent = 'Password'
    })
    await expect(pending).rejects.toMatchObject({ code: 'action_failed', sessionInvalidated: true })
    expect(internalServiceState(raceService)).toEqual({ sessions: 0, reservations: 0 })
  }, 10_000)

  it('fails closed on incomplete enabled-option capture and initial multi-select state while keeping a safe control usable', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService()
    services.push(service)
    const analysis = await service.analyze(`${fixture.origin}/select-boundary-contracts`)
    const page = internalSession(service, analysis.sessionId).page

    expect(analysis.domEvidence.map(({ label, sensitive }) => ({ label, sensitive }))).toEqual([
      { label: 'Boundary filter', sensitive: false },
      { label: 'Overflow filter', sensitive: true },
      { label: 'Multiple filter', sensitive: true },
      { label: 'Safe boundary search', sensitive: false },
    ])
    expect(analysis.capabilities.map(({ name }) => name)).toEqual(['prepare_page_search', 'set_page_filter'])
    const filter = analysis.capabilities.find(({ name }) => name === 'set_page_filter')!
    expect(filter.inputSchema).toMatchObject({
      properties: { optionIndex: { minimum: 0, maximum: 29 } },
    })
    const filterResult = await service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      filter.name,
      filter.sampleInput,
      undefined,
      filter.id,
    )
    expect(filterResult.structuredContent).toMatchObject({ targetStateVerified: true })
    expect(await page.locator('#enabled-overflow').evaluate(
      (select) => (select as HTMLSelectElement).selectedIndex,
    )).toBe(30)
    expect(await page.locator('#initial-multiple option').evaluateAll(
      (options) => options.map((option) => (option as HTMLOptionElement).selected),
    )).toEqual([true, true, false])

    const search = filterResult.analysis.capabilities.find(({ name }) => name === 'prepare_page_search')!
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      search.name,
      search.sampleInput,
      undefined,
      search.id,
    )).resolves.toMatchObject({ structuredContent: { targetStateVerified: true } })
  })

  it('revalidates native single-select state before mutation and preserves the selected set', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService()
    services.push(service)
    let analysis = await service.analyze(`${fixture.origin}/late-control-contracts`)
    const page = internalSession(service, analysis.sessionId).page
    const filter = analysis.capabilities.find(({ name }) => name === 'set_page_filter')!

    await page.locator('#late-multiple').evaluate((select) => {
      (select as HTMLSelectElement).multiple = true
    })
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      filter.name,
      filter.sampleInput,
      undefined,
      filter.id,
    )).rejects.toMatchObject({ code: 'invalid_action', sessionInvalidated: false })
    expect(await page.locator('#late-multiple option').evaluateAll(
      (options) => options.map((option) => (option as HTMLOptionElement).selected),
    )).toEqual([true, false])

    await page.locator('#late-multiple').evaluate((select) => {
      (select as HTMLSelectElement).multiple = false
    })
    const result = await service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      filter.name,
      filter.sampleInput,
      undefined,
      filter.id,
    )
    expect(result.structuredContent.targetStateVerified).toBe(true)
    analysis = result.analysis
    expect(await internalSession(service, analysis.sessionId).page.locator('#late-multiple').evaluate(
      (select) => (select as HTMLSelectElement).selectedIndex,
    )).toBe(1)

    const raceService = createService({ actionStartDelayMs: 120 })
    services.push(raceService)
    const raceAnalysis = await raceService.analyze(`${fixture.origin}/late-control-contracts`)
    const racePage = internalSession(raceService, raceAnalysis.sessionId).page
    const raceFilter = raceAnalysis.capabilities.find(({ name }) => name === 'set_page_filter')!
    let changeEvents = 0
    await racePage.exposeFunction('recordSelectBoundaryChange', () => {
      changeEvents += 1
    })
    await racePage.locator('#late-multiple').evaluate((select) => {
      select.addEventListener('change', () => {
        void (window as unknown as { recordSelectBoundaryChange(): Promise<void> }).recordSelectBoundaryChange()
      })
    })
    const pending = raceService.execute(
      raceAnalysis.sessionId,
      raceAnalysis.sessionToken,
      raceFilter.name,
      raceFilter.sampleInput,
      undefined,
      raceFilter.id,
    )
    await new Promise((resolve) => setTimeout(resolve, 25))
    await racePage.locator('#late-multiple').evaluate((select) => {
      (select as HTMLSelectElement).multiple = true
    })
    await expect(pending).rejects.toMatchObject({ code: 'action_failed', sessionInvalidated: true })
    expect(changeEvents).toBe(0)
    await expect(raceService.execute(
      raceAnalysis.sessionId,
      raceAnalysis.sessionToken,
      raceFilter.name,
      raceFilter.sampleInput,
      undefined,
      raceFilter.id,
    )).rejects.toMatchObject({ code: 'session_expired', sessionInvalidated: true })
  })

  it('revalidates the complete enabled-option budget before action-time selection', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService()
    services.push(service)
    const analysis = await service.analyze(`${fixture.origin}/late-control-contracts`)
    const page = internalSession(service, analysis.sessionId).page
    const filter = analysis.capabilities.find(({ name }) => name === 'set_page_filter')!

    await page.locator('#late-multiple').evaluate((select) => {
      const element = select as HTMLSelectElement
      for (let index = 0; index < 29; index += 1) {
        const option = document.createElement('option')
        option.value = `late-${index}`
        option.textContent = index === 28 ? 'Credit card' : `Late option ${index}`
        if (index === 28) option.selected = true
        element.append(option)
      }
    })
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      filter.name,
      filter.sampleInput,
      undefined,
      filter.id,
    )).rejects.toMatchObject({ code: 'invalid_action', sessionInvalidated: false })
    expect(await page.locator('#late-multiple').evaluate(
      (select) => (select as HTMLSelectElement).selectedIndex,
    )).toBe(30)

    await page.locator('#late-multiple option').evaluateAll((options) => {
      for (const option of options.slice(2)) option.remove()
    })
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      filter.name,
      filter.sampleInput,
      undefined,
      filter.id,
    )).resolves.toMatchObject({ structuredContent: { targetStateVerified: true } })
  })

  it('rejects selected options outside the retained safe mapping before any select mutation', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService()
    services.push(service)
    const analysis = await service.analyze(`${fixture.origin}/selected-option-boundary`)
    expect(analysis.domEvidence.find(({ label }) => label === 'Hidden selection filter'))
      .toMatchObject({ sensitive: true })
    expect(analysis.domEvidence.find(({ label }) => label === 'Disabled selection filter'))
      .toMatchObject({ sensitive: true })
    const filter = analysis.capabilities.find(({ evidenceIds }) => evidenceIds.some((id) =>
      analysis.domEvidence.find((item) => item.id === id)?.label === 'Late selection filter'))!
    const page = internalSession(service, analysis.sessionId).page
    await page.locator('#late-hidden-option').evaluate((option) => {
      ;(option as HTMLOptionElement).selected = true
    })
    const selectedBefore = await page.locator('#late-hidden-selected option').evaluateAll(
      (options) => options.map((option) => (option as HTMLOptionElement).selected),
    )
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      filter.name,
      filter.sampleInput,
      undefined,
      filter.id,
    )).rejects.toMatchObject({ code: 'invalid_action', sessionInvalidated: false })
    expect(await page.locator('#late-hidden-selected option').evaluateAll(
      (options) => options.map((option) => (option as HTMLOptionElement).selected),
    )).toEqual(selectedBefore)

    const search = analysis.capabilities.find(({ evidenceIds }) => evidenceIds.some((id) =>
      analysis.domEvidence.find((item) => item.id === id)?.label === 'Safe selected boundary search'))!
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      search.name,
      { query: 'still safe' },
      undefined,
      search.id,
    )).resolves.toMatchObject({ structuredContent: { targetStateVerified: true } })
  })

  it('fails closed on cumulative per-control safety evidence while keeping another control usable', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService()
    services.push(service)
    const analysis = await service.analyze(`${fixture.origin}/aggregate-safety-budget`)

    expect(analysis.domEvidence.map(({ label, sensitive }) => ({ label, sensitive }))).toEqual([
      { label: 'Label budget', sensitive: true },
      { label: 'Reference budget', sensitive: true },
      { label: 'Option budget', sensitive: true },
      { label: 'Safe aggregate search', sensitive: false },
    ])
    expect(analysis.capabilities.map(({ name }) => name)).toEqual(['prepare_page_search'])
    const search = analysis.capabilities[0]
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      search.name,
      search.sampleInput,
      undefined,
      search.id,
    )).resolves.toMatchObject({
      structuredContent: { isolatedStateChanged: true, targetStateVerified: true },
    })
  })

  it('classifies every associated-label image alt and revalidates late mutations and budgets', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService()
    services.push(service)
    let analysis = await service.analyze(`${fixture.origin}/label-image-alt-safety`)
    const sensitiveEvidence = analysis.domEvidence.filter(({ sensitive }) => sensitive)

    expect(sensitiveEvidence.map(({ label }) => label)).toEqual(expect.arrayContaining([
      'Credit card',
      'reference',
    ]))
    expect(analysis.capabilities.filter(({ kind }) => kind === 'prepare_form')).toHaveLength(2)
    expect(analysis.capabilities.some(({ evidenceIds }) => evidenceIds.some((id) =>
      analysis.domEvidence.find((evidence) => evidence.id === id)?.label === 'Credit card'))).toBe(false)

    const lateForm = analysis.capabilities.find(({ name }) => name === 'prepare_visible_form')!
    const page = internalSession(service, analysis.sessionId).page
    await page.locator('#late-label-image').evaluate((image) => image.setAttribute('alt', 'User password'))
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      lateForm.name,
      lateForm.sampleInput,
      undefined,
      lateForm.id,
    )).rejects.toMatchObject({ code: 'invalid_action', sessionInvalidated: false })
    expect(await page.locator('#late-label-input').inputValue()).toBe('')

    await page.locator('#late-label-image').evaluate((image) => image.setAttribute('alt', 'Reference image'))
    const lateResult = await service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      lateForm.name,
      lateForm.sampleInput,
      undefined,
      lateForm.id,
    )
    expect(lateResult.structuredContent.targetStateVerified).toBe(true)
    analysis = lateResult.analysis

    const neutralForm = analysis.capabilities.find(({ name }) => name === 'prepare_visible_form_2')!
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      neutralForm.name,
      neutralForm.sampleInput,
      undefined,
      neutralForm.id,
    )).resolves.toMatchObject({ structuredContent: { targetStateVerified: true } })
  })

  it('classifies every ARIA-referenced image alt and revalidates late mutations and budgets', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService()
    services.push(service)
    let analysis = await service.analyze(`${fixture.origin}/aria-reference-image-alt-safety`)

    expect(analysis.capabilities.filter(({ kind }) => kind === 'prepare_form')).toHaveLength(2)
    expect(analysis.domEvidence.filter(({ sensitive }) => sensitive)).toHaveLength(3)
    const lateForm = analysis.capabilities.find(({ name }) => name === 'prepare_visible_form')!
    const page = internalSession(service, analysis.sessionId).page

    await page.locator('#late-aria-image').evaluate((image) => {
      image.setAttribute('alt', 'Credit card number')
    })
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      lateForm.name,
      lateForm.sampleInput,
      undefined,
      lateForm.id,
    )).rejects.toMatchObject({ code: 'invalid_action', sessionInvalidated: false })
    expect(await page.locator('#late-aria-input').inputValue()).toBe('')
    expect(await page.locator('#late-aria-detail').inputValue()).toBe('')

    await page.locator('#late-aria-image').evaluate((image) => {
      image.setAttribute('alt', 'Reference diagram')
    })
    const lateResult = await service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      lateForm.name,
      lateForm.sampleInput,
      undefined,
      lateForm.id,
    )
    expect(lateResult.structuredContent.targetStateVerified).toBe(true)
    analysis = lateResult.analysis

    const neutralForm = analysis.capabilities.find(({ name }) => name === 'prepare_visible_form_2')!
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      neutralForm.name,
      neutralForm.sampleInput,
      undefined,
      neutralForm.id,
    )).resolves.toMatchObject({ structuredContent: { targetStateVerified: true } })
  })

  it('classifies bounded attributes on ARIA reference targets and revalidates late mutations', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService()
    services.push(service)
    let analysis = await service.analyze(`${fixture.origin}/aria-reference-attribute-safety`)

    expect(analysis.domEvidence.filter(({ sensitive }) => sensitive)).toHaveLength(3)
    expect(analysis.capabilities.filter(({ kind }) => kind === 'prepare_form')).toHaveLength(2)
    const lateForm = analysis.capabilities.find(({ name }) => name === 'prepare_visible_form')!
    const page = internalSession(service, analysis.sessionId).page

    await page.locator('#late-attribute-reference').evaluate((reference) => {
      reference.setAttribute('aria-label', 'Credit card number')
    })
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      lateForm.name,
      lateForm.sampleInput,
      undefined,
      lateForm.id,
    )).rejects.toMatchObject({ code: 'invalid_action', sessionInvalidated: false })
    expect(await page.locator('#late-attribute-input').inputValue()).toBe('')
    expect(await page.locator('#late-attribute-detail').inputValue()).toBe('')

    await page.locator('#late-attribute-reference').evaluate((reference) => {
      reference.setAttribute('aria-label', 'Reference note')
      reference.setAttribute('title', 'User password')
    })
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      lateForm.name,
      lateForm.sampleInput,
      undefined,
      lateForm.id,
    )).rejects.toMatchObject({ code: 'invalid_action', sessionInvalidated: false })
    expect(await page.locator('#late-attribute-input').inputValue()).toBe('')

    await page.locator('#late-attribute-reference').evaluate((reference) => {
      reference.setAttribute('title', 'Reference title')
    })
    const lateResult = await service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      lateForm.name,
      lateForm.sampleInput,
      undefined,
      lateForm.id,
    )
    expect(lateResult.structuredContent.targetStateVerified).toBe(true)
    analysis = lateResult.analysis

    const neutralForm = analysis.capabilities.find(({ name }) => name === 'prepare_visible_form_2')!
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      neutralForm.name,
      neutralForm.sampleInput,
      undefined,
      neutralForm.id,
    )).resolves.toMatchObject({ structuredContent: { targetStateVerified: true } })
  })

  it('keeps referenced native button values private while classifying and revalidating them', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService()
    services.push(service)
    let analysis = await service.analyze(`${fixture.origin}/aria-reference-native-value-safety`)
    const page = internalSession(service, analysis.sessionId).page

    expect(await page.getByRole('textbox', { name: 'Credit card number' }).count()).toBe(1)
    expect(await page.getByRole('textbox', { name: 'BIC' }).count()).toBe(1)
    expect(await page.getByRole('textbox', { name: 'Bank account' }).count()).toBe(1)
    const sensitiveReferences = analysis.domEvidence.filter(({ label }) =>
      ['sensitive_button_reference', 'sensitive_submit_reference', 'sensitive_reset_reference']
        .includes(label))
    expect(sensitiveReferences).toHaveLength(3)
    expect(sensitiveReferences.every(({ sensitive }) => sensitive)).toBe(true)
    expect(analysis.domEvidence.find(({ label }) => label === 'overflow_reference'))
      .toMatchObject({ sensitive: true })
    expect(analysis.capabilities.filter(({ kind }) => kind === 'prepare_form')).toHaveLength(2)
    expect(JSON.stringify({
      domEvidence: analysis.domEvidence,
      axEvidence: analysis.axEvidence,
      capabilities: analysis.capabilities,
    })).not.toMatch(/Credit card number|Bank account|BIC/)

    const lateEvidenceId = analysis.domEvidence.find(({ label }) => label === 'late_reference')!.id
    const lateForm = analysis.capabilities.find(({ evidenceIds }) => evidenceIds.includes(lateEvidenceId))!
    await page.locator('#late-native-value').evaluate((reference) => {
      ;(reference as HTMLInputElement).value = 'User password'
    })
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      lateForm.name,
      lateForm.sampleInput,
      undefined,
      lateForm.id,
    )).rejects.toMatchObject({ code: 'invalid_action', sessionInvalidated: false })
    expect(await page.locator('#late-native-value-input').inputValue()).toBe('')
    expect(await page.locator('#late-native-value-detail').inputValue()).toBe('')

    await page.locator('#late-native-value').evaluate((reference) => {
      ;(reference as HTMLInputElement).value = 'Reference action'
    })
    const lateResult = await service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      lateForm.name,
      lateForm.sampleInput,
      undefined,
      lateForm.id,
    )
    expect(lateResult.structuredContent.targetStateVerified).toBe(true)
    analysis = lateResult.analysis

    const neutralEvidenceId = analysis.domEvidence.find(({ label }) => label === 'neutral_reference')!.id
    const neutralForm = analysis.capabilities.find(({ evidenceIds }) => evidenceIds.includes(neutralEvidenceId))!
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      neutralForm.name,
      neutralForm.sampleInput,
      undefined,
      neutralForm.id,
    )).resolves.toMatchObject({ structuredContent: { targetStateVerified: true } })
  })

  it('keeps referenced image-input alt text private while classifying and revalidating it', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService()
    services.push(service)
    let analysis = await service.analyze(`${fixture.origin}/aria-reference-image-input-alt-safety`)
    const page = internalSession(service, analysis.sessionId).page

    expect(await page.getByRole('textbox', { name: 'Credit card number' }).count()).toBe(1)
    expect(analysis.domEvidence.find(({ label }) => label === 'sensitive_image_reference'))
      .toMatchObject({ sensitive: true })
    expect(analysis.domEvidence.find(({ label }) => label === 'overflow_image_reference'))
      .toMatchObject({ sensitive: true })
    expect(analysis.capabilities.filter(({ kind }) => kind === 'prepare_form')).toHaveLength(2)
    expect(JSON.stringify({
      domEvidence: analysis.domEvidence,
      axEvidence: analysis.axEvidence,
      capabilities: analysis.capabilities,
    })).not.toMatch(/Credit card number/)

    const lateEvidenceId = analysis.domEvidence.find(({ label }) => label === 'late_image_reference')!.id
    const lateForm = analysis.capabilities.find(({ evidenceIds }) => evidenceIds.includes(lateEvidenceId))!
    await page.locator('#late-image-alt').evaluate((reference) => {
      ;(reference as HTMLInputElement).alt = 'User password'
    })
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      lateForm.name,
      lateForm.sampleInput,
      undefined,
      lateForm.id,
    )).rejects.toMatchObject({ code: 'invalid_action', sessionInvalidated: false })
    expect(await page.locator('#late-image-alt-input').inputValue()).toBe('')
    expect(await page.locator('#late-image-alt-detail').inputValue()).toBe('')

    await page.locator('#late-image-alt').evaluate((reference) => {
      ;(reference as HTMLInputElement).alt = 'Reference image action'
    })
    const lateResult = await service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      lateForm.name,
      lateForm.sampleInput,
      undefined,
      lateForm.id,
    )
    expect(lateResult.structuredContent.targetStateVerified).toBe(true)
    analysis = lateResult.analysis

    const neutralEvidenceId = analysis.domEvidence.find(({ label }) => label === 'neutral_image_reference')!.id
    const neutralForm = analysis.capabilities.find(({ evidenceIds }) => evidenceIds.includes(neutralEvidenceId))!
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      neutralForm.name,
      neutralForm.sampleInput,
      undefined,
      neutralForm.id,
    )).resolves.toMatchObject({ structuredContent: { targetStateVerified: true } })
  })

  it('keeps ARIA-referenced embedded-control values private and revalidates native state', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService()
    services.push(service)
    const analysis = await service.analyze(`${fixture.origin}/aria-reference-embedded-control-safety`)
    const page = internalSession(service, analysis.sessionId).page

    expect(await page.getByRole('textbox', { name: 'Credit card number' }).count()).toBe(1)
    for (const label of [
      'sensitive_textbox_reference',
      'Sensitive select field',
      'Sensitive range field',
      'Custom embedded field',
      'Overflow embedded field',
    ]) {
      expect(analysis.domEvidence.find((evidence) => evidence.label === label)).toMatchObject({ sensitive: true })
    }
    expect(analysis.capabilities.filter(({ kind }) => kind === 'prepare_form')).toHaveLength(4)
    expect(JSON.stringify({
      domEvidence: analysis.domEvidence,
      axEvidence: analysis.axEvidence,
      capabilities: analysis.capabilities,
    })).not.toMatch(/Credit card number|Bank account|BIC|Reference overview/)

    const capabilityFor = (label: string) => {
      const evidenceId = analysis.domEvidence.find((evidence) => evidence.label === label)!.id
      return analysis.capabilities.find(({ evidenceIds }) => evidenceIds.includes(evidenceId))!
    }
    const lateCases = [
      {
        label: 'Late textbox field',
        reference: '#late-textbox-value',
        mutate: (element: Element) => { (element as HTMLInputElement).value = 'User password' },
        restore: (element: Element) => { (element as HTMLInputElement).value = 'Reference note' },
        target: '#late-textbox-input, #late-textbox-detail',
      },
      {
        label: 'Late select field',
        reference: '#late-select-value option:first-child',
        mutate: (element: Element) => { element.textContent = 'Credit card number' },
        restore: (element: Element) => { element.textContent = 'Reference option' },
        target: '#late-select-input, #late-select-detail',
      },
      {
        label: 'Late range field',
        reference: '#late-range-value',
        mutate: (element: Element) => { element.setAttribute('aria-valuetext', 'Bank account') },
        restore: (element: Element) => { element.setAttribute('aria-valuetext', 'Reference level') },
        target: '#late-range-input, #late-range-detail',
      },
    ]
    for (const testCase of lateCases) {
      const capability = capabilityFor(testCase.label)
      await page.locator(testCase.reference).evaluate(testCase.mutate)
      await expect(service.execute(
        analysis.sessionId,
        analysis.sessionToken,
        capability.name,
        capability.sampleInput,
        undefined,
        capability.id,
      )).rejects.toMatchObject({ code: 'invalid_action', sessionInvalidated: false })
      expect(await page.locator(testCase.target).evaluateAll((controls) =>
        controls.map((control) => (control as HTMLInputElement).value))).toEqual(['', ''])
      await page.locator(testCase.reference).evaluate(testCase.restore)
    }

    const neutral = capabilityFor('Neutral embedded field')
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      neutral.name,
      neutral.sampleInput,
      undefined,
      neutral.id,
    )).resolves.toMatchObject({ structuredContent: { targetStateVerified: true } })
  })

  it('classifies bounded descendant accessible sources on ARIA references and revalidates them', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService()
    services.push(service)
    let analysis = await service.analyze(`${fixture.origin}/aria-reference-descendant-source-safety`)
    const page = internalSession(service, analysis.sessionId).page

    for (const label of [
      'sensitive_descendant_reference',
      'count_overflow_descendant_reference',
      'traversal_overflow_descendant_reference',
    ]) {
      expect(analysis.domEvidence.find((evidence) => evidence.label === label))
        .toMatchObject({ sensitive: true })
    }
    expect(analysis.capabilities.filter(({ kind }) => kind === 'prepare_form')).toHaveLength(3)
    expect(JSON.stringify({
      domEvidence: analysis.domEvidence,
      axEvidence: analysis.axEvidence,
      capabilities: analysis.capabilities,
    })).not.toMatch(/Credit card number/)

    const capabilityFor = (snapshot: typeof analysis, label: string) => {
      const evidenceId = snapshot.domEvidence.find((evidence) => evidence.label === label)!.id
      return snapshot.capabilities.find(({ evidenceIds }) => evidenceIds.includes(evidenceId))!
    }
    const late = capabilityFor(analysis, 'late_descendant_reference')
    await page.locator('#late-descendant-source').evaluate((source) => {
      ;(source as HTMLInputElement).value = 'User password'
    })
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      late.name,
      late.sampleInput,
      undefined,
      late.id,
    )).rejects.toMatchObject({ code: 'invalid_action', sessionInvalidated: false })
    expect(await page.locator('#late-descendant-target, #late-descendant-detail').evaluateAll((controls) =>
      controls.map((control) => (control as HTMLInputElement).value))).toEqual(['', ''])

    await page.locator('#late-descendant-source').evaluate((source) => {
      ;(source as HTMLInputElement).value = 'Reference note'
    })
    const lateResult = await service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      late.name,
      late.sampleInput,
      undefined,
      late.id,
    )
    expect(lateResult).toMatchObject({ structuredContent: { targetStateVerified: true } })
    analysis = lateResult.analysis

    const neutral = capabilityFor(analysis, 'Reference overview')
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      neutral.name,
      neutral.sampleInput,
      undefined,
      neutral.id,
    )).resolves.toMatchObject({ structuredContent: { targetStateVerified: true } })

    const wrappedService = createService()
    services.push(wrappedService)
    const wrappedAnalysis = await wrappedService.analyze(`${fixture.origin}/aria-reference-descendant-source-safety`)
    const wrapped = capabilityFor(wrappedAnalysis, 'Wrapped reference')
    await expect(wrappedService.execute(
      wrappedAnalysis.sessionId,
      wrappedAnalysis.sessionToken,
      wrapped.name,
      wrapped.sampleInput,
      undefined,
      wrapped.id,
    )).resolves.toMatchObject({ structuredContent: { targetStateVerified: true } })
    expect(await internalSession(wrappedService, wrappedAnalysis.sessionId).page
      .locator('#wrapped-descendant-target').inputValue()).not.toBe('')

    const raceService = createService({ actionStartDelayMs: 200 })
    services.push(raceService)
    const raceAnalysis = await raceService.analyze(`${fixture.origin}/aria-reference-descendant-source-safety`)
    const racePage = internalSession(raceService, raceAnalysis.sessionId).page
    const raceCapability = capabilityFor(raceAnalysis, 'late_descendant_reference')
    const pending = raceService.execute(
      raceAnalysis.sessionId,
      raceAnalysis.sessionToken,
      raceCapability.name,
      raceCapability.sampleInput,
      undefined,
      raceCapability.id,
    )
    await new Promise((resolve) => setTimeout(resolve, 40))
    await racePage.locator('#late-descendant-source').evaluate((source) => {
      ;(source as HTMLInputElement).value = 'Credit card number'
    })
    await expect(pending).rejects.toMatchObject({ code: 'action_failed', sessionInvalidated: true })
    expect(internalServiceState(raceService)).toEqual({ sessions: 0, reservations: 0 })
  })

  it('keeps associated-label embedded native values private and revalidates them before mutation', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService()
    services.push(service)
    const analysis = await service.analyze(`${fixture.origin}/label-embedded-control-safety`)
    const page = internalSession(service, analysis.sessionId).page

    for (const label of [
      'Sensitive label text field',
      'Sensitive label select field',
      'Sensitive label range field',
      'Custom label native field',
      'Overflow label native field',
    ]) {
      expect(analysis.domEvidence.find((evidence) => evidence.label === label)).toMatchObject({ sensitive: true })
    }
    const publicPayload = JSON.stringify({
      domEvidence: analysis.domEvidence,
      axEvidence: analysis.axEvidence,
      capabilities: analysis.capabilities,
    })
    expect(publicPayload).not.toMatch(/Credit card number|Bank account|BIC|Reference note|Reference widget/)

    const capabilityFor = (label: string) => {
      const evidenceId = analysis.domEvidence.find((evidence) => evidence.label === label)!.id
      return analysis.capabilities.find(({ evidenceIds }) => evidenceIds.includes(evidenceId))!
    }
    const late = capabilityFor('Late label native field')
    await page.locator('#late-label-native-source').evaluate((control) => {
      (control as HTMLTextAreaElement).value = 'User password'
    })
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      late.name,
      late.sampleInput,
      undefined,
      late.id,
    )).rejects.toMatchObject({ code: 'invalid_action', sessionInvalidated: false })
    expect(await page.locator('#late-label-native-target, #late-label-native-detail').evaluateAll((controls) =>
      controls.map((control) => (control as HTMLInputElement).value))).toEqual(['', ''])
    await page.locator('#late-label-native-source').evaluate((control) => {
      (control as HTMLTextAreaElement).value = 'Reference note'
    })

    const neutral = capabilityFor('Neutral label native field')
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      neutral.name,
      neutral.sampleInput,
      undefined,
      neutral.id,
    )).resolves.toMatchObject({ structuredContent: { targetStateVerified: true } })

    const wrappedService = createService()
    services.push(wrappedService)
    const wrappedAnalysis = await wrappedService.analyze(`${fixture.origin}/label-embedded-control-safety`)
    const wrappedEvidence = wrappedAnalysis.domEvidence.find(({ label }) => label === 'Wrapped label target')!
    const wrapped = wrappedAnalysis.capabilities.find(({ evidenceIds }) => evidenceIds.includes(wrappedEvidence.id))!
    const wrappedResult = await wrappedService.execute(
      wrappedAnalysis.sessionId,
      wrappedAnalysis.sessionToken,
      wrapped.name,
      wrapped.sampleInput,
      undefined,
      wrapped.id,
    )
    expect(wrappedResult).toMatchObject({ structuredContent: { targetStateVerified: true } })
    expect(await internalSession(wrappedService, wrappedAnalysis.sessionId).page
      .locator('#wrapped-label-target').inputValue()).not.toBe('')

    const raceService = createService({ actionStartDelayMs: 200 })
    services.push(raceService)
    const raceAnalysis = await raceService.analyze(`${fixture.origin}/label-embedded-control-safety`)
    const raceEvidence = raceAnalysis.domEvidence.find(({ label }) => label === 'Late label native field')!
    const raceCapability = raceAnalysis.capabilities.find(({ evidenceIds }) => evidenceIds.includes(raceEvidence.id))!
    const racePage = internalSession(raceService, raceAnalysis.sessionId).page
    const pending = raceService.execute(
      raceAnalysis.sessionId,
      raceAnalysis.sessionToken,
      raceCapability.name,
      raceCapability.sampleInput,
      undefined,
      raceCapability.id,
    )
    await new Promise((resolve) => setTimeout(resolve, 40))
    await racePage.locator('#late-label-native-source').evaluate((control) => {
      (control as HTMLTextAreaElement).value = 'Credit card number'
    })
    await expect(pending).rejects.toMatchObject({ code: 'action_failed', sessionInvalidated: true })
    expect(internalServiceState(raceService)).toEqual({ sessions: 0, reservations: 0 })
  })

  it('classifies bounded descendant accessible sources on associated labels and revalidates them', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService()
    services.push(service)
    let analysis = await service.analyze(`${fixture.origin}/label-descendant-source-safety`)
    const page = internalSession(service, analysis.sessionId).page

    for (const label of [
      'Sensitive label descendant field',
      'Aggregate overflow label field',
      'Individual overflow label field',
    ]) {
      expect(analysis.domEvidence.find((evidence) => evidence.label === label))
        .toMatchObject({ sensitive: true })
    }
    expect(analysis.capabilities.filter(({ kind }) => kind === 'prepare_form')).toHaveLength(2)
    expect(JSON.stringify({
      domEvidence: analysis.domEvidence,
      axEvidence: analysis.axEvidence,
      capabilities: analysis.capabilities,
    })).not.toMatch(/Credit card number/)

    const capabilityFor = (snapshot: typeof analysis, label: string) => {
      const evidenceId = snapshot.domEvidence.find((evidence) => evidence.label === label)!.id
      return snapshot.capabilities.find(({ evidenceIds }) => evidenceIds.includes(evidenceId))!
    }
    const late = capabilityFor(analysis, 'Late label descendant field')
    await page.locator('#late-label-descendant-source').evaluate((source) => {
      source.setAttribute('aria-label', 'User password')
    })
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      late.name,
      late.sampleInput,
      undefined,
      late.id,
    )).rejects.toMatchObject({ code: 'invalid_action', sessionInvalidated: false })
    expect(await page.locator('#late-label-descendant-target, #late-label-descendant-detail')
      .evaluateAll((controls) => controls.map((control) => (control as HTMLInputElement).value)))
      .toEqual(['', ''])

    await page.locator('#late-label-descendant-source').evaluate((source) => {
      source.setAttribute('aria-label', 'Reference image')
    })
    const lateResult = await service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      late.name,
      late.sampleInput,
      undefined,
      late.id,
    )
    expect(lateResult).toMatchObject({ structuredContent: { targetStateVerified: true } })
    analysis = lateResult.analysis

    const neutral = capabilityFor(analysis, 'Neutral label descendant field')
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      neutral.name,
      neutral.sampleInput,
      undefined,
      neutral.id,
    )).resolves.toMatchObject({ structuredContent: { targetStateVerified: true } })
  })

  it('classifies bounded aria-description evidence and revalidates late mutations', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService()
    services.push(service)
    let analysis = await service.analyze(`${fixture.origin}/aria-description-safety`)

    expect(analysis.domEvidence.filter(({ sensitive }) => sensitive).map(({ label }) => label)).toEqual([
      'Reference field',
      'Overflow description field',
    ])
    expect(analysis.capabilities.filter(({ kind }) => kind === 'prepare_form')).toHaveLength(2)
    const lateForm = analysis.capabilities.find(({ evidenceIds }) => evidenceIds.some((id) =>
      analysis.domEvidence.find((evidence) => evidence.id === id)?.label === 'Late description field'))!
    const page = internalSession(service, analysis.sessionId).page

    await page.locator('#late-description-input').evaluate((input) => {
      input.setAttribute('aria-description', 'User password')
    })
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      lateForm.name,
      lateForm.sampleInput,
      undefined,
      lateForm.id,
    )).rejects.toMatchObject({ code: 'invalid_action', sessionInvalidated: false })
    expect(await page.locator('#late-description-input').inputValue()).toBe('')
    expect(await page.locator('#late-description-detail').inputValue()).toBe('')

    await page.locator('#late-description-input').evaluate((input) => {
      input.setAttribute('aria-description', 'Reference context')
    })
    const lateResult = await service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      lateForm.name,
      lateForm.sampleInput,
      undefined,
      lateForm.id,
    )
    expect(lateResult.structuredContent.targetStateVerified).toBe(true)
    analysis = lateResult.analysis

    const neutralForm = analysis.capabilities.find(({ evidenceIds }) => evidenceIds.some((id) =>
      analysis.domEvidence.find((evidence) => evidence.id === id)?.label === 'Neutral description field'))!
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      neutralForm.name,
      neutralForm.sampleInput,
      undefined,
      neutralForm.id,
    )).resolves.toMatchObject({ structuredContent: { targetStateVerified: true } })
  })

  it('classifies associated-label attributes and revalidates late mutations', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService()
    services.push(service)
    let analysis = await service.analyze(`${fixture.origin}/label-attribute-safety`)

    expect(analysis.domEvidence.filter(({ sensitive }) => sensitive).map(({ label }) => label)).toEqual([
      'Credit card number',
      'Reference title',
      'reference',
    ])
    expect(analysis.capabilities.filter(({ kind }) => kind === 'prepare_form')).toHaveLength(2)
    const lateForm = analysis.capabilities.find(({ evidenceIds }) => evidenceIds.some((id) =>
      analysis.domEvidence.find((evidence) => evidence.id === id)?.label === 'Reference label'))!
    const page = internalSession(service, analysis.sessionId).page

    await page.locator('#late-label-attribute').evaluate((label) => {
      label.setAttribute('aria-label', 'Credit card number')
    })
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      lateForm.name,
      lateForm.sampleInput,
      undefined,
      lateForm.id,
    )).rejects.toMatchObject({ code: 'invalid_action', sessionInvalidated: false })
    expect(await page.locator('#late-label-attribute-input').inputValue()).toBe('')

    await page.locator('#late-label-attribute').evaluate((label) => {
      label.setAttribute('aria-label', 'Reference label')
      label.setAttribute('title', 'User password')
    })
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      lateForm.name,
      lateForm.sampleInput,
      undefined,
      lateForm.id,
    )).rejects.toMatchObject({ code: 'invalid_action', sessionInvalidated: false })
    expect(await page.locator('#late-label-attribute-input').inputValue()).toBe('')
    expect(await page.locator('#late-label-attribute-detail').inputValue()).toBe('')

    await page.locator('#late-label-attribute').evaluate((label) => {
      label.setAttribute('title', 'Overview')
    })
    const lateResult = await service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      lateForm.name,
      lateForm.sampleInput,
      undefined,
      lateForm.id,
    )
    expect(lateResult.structuredContent.targetStateVerified).toBe(true)
    analysis = lateResult.analysis

    const neutralForm = analysis.capabilities.find(({ evidenceIds }) => evidenceIds.some((id) =>
      analysis.domEvidence.find((evidence) => evidence.id === id)?.label === 'Neutral reference'))!
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      neutralForm.name,
      neutralForm.sampleInput,
      undefined,
      neutralForm.id,
    )).resolves.toMatchObject({ structuredContent: { targetStateVerified: true } })
  })

  it('resolves associated-label ARIA references privately and fails closed on incomplete or drifting evidence', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService()
    services.push(service)
    let analysis = await service.analyze(`${fixture.origin}/label-reference-safety`)

    const evidenceByLabel = new Map(analysis.domEvidence.map((evidence) => [evidence.label, evidence]))
    for (const label of ['Sensitive reference', 'Missing reference', 'Nested reference', 'Overflow reference']) {
      expect(evidenceByLabel.get(label)?.sensitive).toBe(true)
    }
    const page = internalSession(service, analysis.sessionId).page
    const lateForm = analysis.capabilities.find(({ kind, evidenceIds }) => kind === 'prepare_form'
      && evidenceIds.some((id) => analysis.domEvidence.find((evidence) => evidence.id === id)?.label === 'Late reference'))!
    expect(lateForm).toBeDefined()
    expect(JSON.stringify(analysis)).not.toContain('Credit card number')

    await page.locator('#late-label-reference').evaluate((node) => { node.textContent = 'User password' })
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      lateForm.name,
      lateForm.sampleInput,
      undefined,
      lateForm.id,
    )).rejects.toMatchObject({ code: 'invalid_action', sessionInvalidated: false })
    expect(await page.locator('#late-reference-input').inputValue()).toBe('')
    expect(await page.locator('#late-reference-detail').inputValue()).toBe('')

    await page.locator('#late-label-reference').evaluate((node) => { node.textContent = 'Helpful overview' })
    const result = await service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      lateForm.name,
      lateForm.sampleInput,
      undefined,
      lateForm.id,
    )
    expect(result.structuredContent.targetStateVerified).toBe(true)
    analysis = result.analysis
    const neutralForm = analysis.capabilities.find(({ kind, evidenceIds }) => kind === 'prepare_form'
      && evidenceIds.some((id) => analysis.domEvidence.find((evidence) => evidence.id === id)?.label === 'Neutral reference'))!
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      neutralForm.name,
      neutralForm.sampleInput,
      undefined,
      neutralForm.id,
    )).resolves.toMatchObject({ structuredContent: { targetStateVerified: true } })
  })

  it('excludes effective inert ancestry and revalidates boolean inert semantics before action', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService()
    services.push(service)
    let analysis = await service.analyze(`${fixture.origin}/inert-boundary`)

    const labels = analysis.domEvidence.map(({ label }) => label)
    expect(labels).not.toContain('Direct inert value')
    expect(labels).not.toContain('Ancestor inert value')
    expect(labels).not.toContain('Boolean inert value')
    expect(labels).not.toContain('Inert destination')
    expect(labels).toEqual(expect.arrayContaining([
      'Late inert value',
      'Neutral inert value',
      'Neutral destination',
    ]))
    const lateForm = analysis.capabilities.find(({ kind, evidenceIds }) => kind === 'prepare_form'
      && evidenceIds.some((id) => analysis.domEvidence.find((evidence) => evidence.id === id)?.label === 'Late inert value'))!
    const page = internalSession(service, analysis.sessionId).page
    await page.locator('#late-inert-owner').evaluate((owner) => owner.setAttribute('inert', 'false'))
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      lateForm.name,
      lateForm.sampleInput,
      undefined,
      lateForm.id,
    )).rejects.toMatchObject({ code: 'invalid_action', sessionInvalidated: false })
    expect(await page.locator('#late-inert-value').inputValue()).toBe('')
    expect(await page.locator('#late-inert-detail').inputValue()).toBe('')

    await page.locator('#late-inert-owner').evaluate((owner) => owner.removeAttribute('inert'))
    const result = await service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      lateForm.name,
      lateForm.sampleInput,
      undefined,
      lateForm.id,
    )
    expect(result.structuredContent.targetStateVerified).toBe(true)
    analysis = result.analysis
    const neutralForm = analysis.capabilities.find(({ kind, evidenceIds }) => kind === 'prepare_form'
      && evidenceIds.some((id) => analysis.domEvidence.find((evidence) => evidence.id === id)?.label === 'Neutral inert value'))!
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      neutralForm.name,
      neutralForm.sampleInput,
      undefined,
      neutralForm.id,
    )).resolves.toMatchObject({ structuredContent: { targetStateVerified: true } })
  })

  it('excludes implicitly inert background targets while an active modal is open', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService()
    services.push(service)
    const analysis = await service.analyze(`${fixture.origin}/active-modal-inertness`)

    const labels = analysis.domEvidence.map(({ label }) => label)
    expect(labels).not.toContain('Background modal value')
    expect(labels).not.toContain('Background modal destination')
    expect(labels).toEqual(expect.arrayContaining([
      'Dialog modal value',
      'Dialog modal detail',
      'Dialog modal destination',
    ]))
    expect(JSON.stringify(analysis)).not.toMatch(/modal:(?:none|\d+:)/)
    const modalForm = analysis.capabilities.find(({ kind, evidenceIds }) => kind === 'prepare_form'
      && evidenceIds.some((id) => analysis.domEvidence.find((evidence) => evidence.id === id)?.label === 'Dialog modal value'))!
    expect(modalForm).toBeDefined()
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      modalForm.name,
      modalForm.sampleInput,
      undefined,
      modalForm.id,
    )).resolves.toMatchObject({ structuredContent: { targetStateVerified: true } })

    const shadowAnalysis = await service.analyze(`${fixture.origin}/shadow-modal-inertness`)
    expect(shadowAnalysis.domEvidence.map(({ label }) => label)).not.toEqual(expect.arrayContaining([
      'Shadow background value',
      'Shadow background destination',
    ]))
    expect(JSON.stringify(shadowAnalysis)).not.toMatch(/modal:(?:none|\d+:)/)
  })

  it('lets an active modal escape inherited inertness while preserving direct and inner inert state', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService()
    services.push(service)
    const analysis = await service.analyze(`${fixture.origin}/modal-ancestor-inertness`)
    const labels = analysis.domEvidence.map(({ label }) => label)

    expect(labels).toEqual(expect.arrayContaining([
      'Escaped modal value',
      'Escaped modal detail',
      'Modal choice A',
      'Modal choice B',
      'Escaped modal destination',
    ]))
    expect(labels).not.toEqual(expect.arrayContaining([
      'Modal ancestor background value',
      'Inner inert modal value',
    ]))
    expect(JSON.stringify(analysis)).not.toMatch(/modal:(?:none|\d+:)/)

    const form = analysis.capabilities.find(({ kind, evidenceIds }) => kind === 'prepare_form'
      && evidenceIds.some((id) => analysis.domEvidence.find((evidence) => evidence.id === id)?.label === 'Escaped modal value'))!
    expect(form).toBeDefined()
    const radioFieldKey = Object.entries(
      form.inputSchema.properties as Record<string, Record<string, unknown>>,
    ).find(([, schema]) => schema.type === 'integer')?.[0]
    expect(radioFieldKey).toBeDefined()
    const executableInput = { ...form.sampleInput, [radioFieldKey!]: 1 }
    const page = internalSession(service, analysis.sessionId).page
    await page.locator('#ancestor-inert-modal').evaluate((dialog) => dialog.setAttribute('inert', ''))
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      form.name,
      executableInput,
      undefined,
      form.id,
    )).rejects.toMatchObject({ code: 'invalid_action', sessionInvalidated: false })
    expect(await page.locator('#ancestor-inert-modal-value').inputValue()).toBe('')
    expect(await page.locator('#ancestor-inert-modal-detail').inputValue()).toBe('')
    expect(await page.locator('#ancestor-inert-radio-a').isChecked()).toBe(true)
    expect(await page.locator('#ancestor-inert-radio-b').isChecked()).toBe(false)

    await page.locator('#ancestor-inert-modal').evaluate((dialog) => dialog.removeAttribute('inert'))
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      form.name,
      executableInput,
      undefined,
      form.id,
    )).resolves.toMatchObject({ structuredContent: { targetStateVerified: true } })
    expect(await page.locator('#ancestor-inert-modal-value').inputValue()).not.toBe('')
    expect(await page.locator('#ancestor-inert-radio-b').isChecked()).toBe(true)

    const directAnalysis = await service.analyze(`${fixture.origin}/direct-inert-modal`)
    expect(directAnalysis.domEvidence.map(({ label }) => label)).not.toEqual(expect.arrayContaining([
      'Direct inert modal value',
      'Direct inert modal destination',
    ]))
  })

  it('uses only the topmost modal for implicit inertness and revalidates top-layer changes', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService()
    services.push(service)
    const analysis = await service.analyze(`${fixture.origin}/stacked-modal-inertness`)
    const labels = analysis.domEvidence.map(({ label }) => label)

    expect(labels).toEqual(expect.arrayContaining([
      'Topmost modal value',
      'Topmost modal detail',
      'Topmost modal destination',
    ]))
    expect(labels).not.toEqual(expect.arrayContaining([
      'Stacked modal background value',
      'Older modal value',
      'Older modal destination',
      'Topmost inner inert value',
    ]))
    const topmostForm = analysis.capabilities.find(({ kind, evidenceIds }) => kind === 'prepare_form'
      && evidenceIds.some((id) => analysis.domEvidence.find((evidence) => evidence.id === id)?.label === 'Topmost modal value'))!
    expect(topmostForm).toBeDefined()
    const page = internalSession(service, analysis.sessionId).page
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('DOM.enable')
    await cdp.send('DOM.getDocument', { depth: 0, pierce: true })
    const topLayer = await cdp.send('DOM.getTopLayerElements') as { nodeIds?: number[] }
    const modalOrder: string[] = []
    for (const nodeId of topLayer.nodeIds ?? []) {
      const described = await cdp.send('DOM.describeNode', { nodeId }) as {
        node?: { nodeName?: string, attributes?: string[] }
      }
      if (described.node?.nodeName !== 'DIALOG') continue
      const attributes = described.node.attributes ?? []
      const idIndex = attributes.indexOf('id')
      if (idIndex >= 0) modalOrder.push(attributes[idIndex + 1])
    }
    await cdp.detach()
    expect(modalOrder).toEqual(['older-modal', 'topmost-modal'])

    await page.locator('#topmost-modal').evaluate((dialog) => dialog.setAttribute('inert', ''))
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      topmostForm.name,
      topmostForm.sampleInput,
      undefined,
      topmostForm.id,
    )).rejects.toMatchObject({ code: 'invalid_action', sessionInvalidated: false })
    expect(await page.locator('#topmost-modal-value').inputValue()).toBe('')
    expect(await page.locator('#topmost-modal-detail').inputValue()).toBe('')
    await page.locator('#topmost-modal').evaluate((dialog) => dialog.removeAttribute('inert'))
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      topmostForm.name,
      topmostForm.sampleInput,
      undefined,
      topmostForm.id,
    )).resolves.toMatchObject({ structuredContent: { targetStateVerified: true } })

    const changingAnalysis = await service.analyze(`${fixture.origin}/stacked-modal-inertness`)
    const changingForm = changingAnalysis.capabilities.find(({ kind, evidenceIds }) => kind === 'prepare_form'
      && evidenceIds.some((id) => changingAnalysis.domEvidence.find((evidence) => evidence.id === id)?.label === 'Topmost modal value'))!
    const changingPage = internalSession(service, changingAnalysis.sessionId).page
    await changingPage.locator('#topmost-modal').evaluate((dialog) => (dialog as HTMLDialogElement).close())
    await expect(service.execute(
      changingAnalysis.sessionId,
      changingAnalysis.sessionToken,
      changingForm.name,
      changingForm.sampleInput,
      undefined,
      changingForm.id,
    )).rejects.toMatchObject({ code: 'invalid_action', sessionInvalidated: false })
    expect(await changingPage.locator('#topmost-modal-value').inputValue()).toBe('')
    expect(await changingPage.locator('#topmost-modal-detail').inputValue()).toBe('')

    const olderAnalysis = await service.analyze(`${fixture.origin}/stacked-modal-inertness?older-only=1`)
    const olderLabels = olderAnalysis.domEvidence.map(({ label }) => label)
    expect(olderLabels).toEqual(expect.arrayContaining([
      'Older modal value',
      'Older modal detail',
      'Older modal destination',
    ]))
    expect(olderLabels).not.toContain('Stacked modal background value')
    const olderForm = olderAnalysis.capabilities.find(({ kind, evidenceIds }) => kind === 'prepare_form'
      && evidenceIds.some((id) => olderAnalysis.domEvidence.find((evidence) => evidence.id === id)?.label === 'Older modal value'))!
    await expect(service.execute(
      olderAnalysis.sessionId,
      olderAnalysis.sessionToken,
      olderForm.name,
      olderForm.sampleInput,
      undefined,
      olderForm.id,
    )).resolves.toMatchObject({ structuredContent: { targetStateVerified: true } })
  })

  it('revalidates late modal inertness before mutation and allows a fresh analysis after close', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService()
    services.push(service)
    const analysis = await service.analyze(`${fixture.origin}/late-modal-inertness`)
    const form = analysis.capabilities.find(({ kind }) => kind === 'prepare_form')!
    const page = internalSession(service, analysis.sessionId).page

    await page.locator('#late-modal').evaluate((dialog) => (dialog as HTMLDialogElement).showModal())
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      form.name,
      form.sampleInput,
      undefined,
      form.id,
    )).rejects.toMatchObject({ code: 'invalid_action', sessionInvalidated: false })
    expect(await page.locator('#late-modal-value').inputValue()).toBe('')
    expect(await page.locator('#late-modal-detail').inputValue()).toBe('')

    await page.locator('#late-modal').evaluate((dialog) => (dialog as HTMLDialogElement).close())
    expect(await service.closeSession(analysis.sessionId, analysis.sessionToken)).toBe(true)
    const freshAnalysis = await service.analyze(`${fixture.origin}/late-modal-inertness`)
    const freshForm = freshAnalysis.capabilities.find(({ kind }) => kind === 'prepare_form')!
    await expect(service.execute(
      freshAnalysis.sessionId,
      freshAnalysis.sessionToken,
      freshForm.name,
      freshForm.sampleInput,
      undefined,
      freshForm.id,
    )).resolves.toMatchObject({ structuredContent: { targetStateVerified: true } })
  })

  it('retries when a closed-shadow modal opens and closes across the screenshot boundary', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    let captureCalls = 0
    const service = createService({
      beforeAnalysisScreenshot: async (page) => {
        captureCalls += 1
        if (captureCalls !== 1) return
        await page.evaluate(() => {
          ;(globalThis as typeof globalThis & { __shadowModalForTest: HTMLDialogElement })
            .__shadowModalForTest.showModal()
        })
      },
      afterAnalysisScreenshot: async (page) => {
        if (captureCalls !== 1) return
        await page.evaluate(() => {
          ;(globalThis as typeof globalThis & { __shadowModalForTest: HTMLDialogElement })
            .__shadowModalForTest.close()
        })
      },
    })
    services.push(service)
    const analysis = await service.analyze(`${fixture.origin}/shadow-modal-capture-race`)
    expect(captureCalls).toBe(2)
    const form = analysis.capabilities.find(({ kind }) => kind === 'prepare_form')!
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      form.name,
      form.sampleInput,
      undefined,
      form.id,
    )).resolves.toMatchObject({ structuredContent: { targetStateVerified: true } })
  })

  it('retries on native descriptor-state drift and never publishes stale private control values', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    let captureCalls = 0
    const service = createService({
      afterAnalysisScreenshot: async (page, attempt) => {
        captureCalls += 1
        if (attempt !== 0) return
        await page.evaluate(() => {
          setTimeout(() => {
            const text = document.querySelector<HTMLInputElement>('#state-text')!
            text.value = 'private-state-after-screenshot'
            document.querySelector<HTMLInputElement>('#state-checkbox')!.checked = true
            document.querySelector<HTMLSelectElement>('#state-select')!.selectedIndex = 1
            document.querySelector<HTMLInputElement>('#state-number')!.value = '2'
            document.querySelector<HTMLInputElement>('#state-date')!.value = '2026-01-02'
            document.querySelector<HTMLInputElement>('#state-radio-b')!.checked = true
          }, 0)
        })
        await page.waitForTimeout(20)
      },
    })
    services.push(service)
    const analysis = await service.analyze(`${fixture.origin}/analysis-native-state`)
    expect(captureCalls).toBe(2)
    expect(JSON.stringify(analysis)).not.toContain('private-state-after-screenshot')
    const search = analysis.capabilities.find(({ kind }) => kind === 'prepare_search')!
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      search.name,
      search.sampleInput,
      undefined,
      search.id,
    )).resolves.toMatchObject({ structuredContent: { targetStateVerified: true } })

    let driftingCalls = 0
    const driftingService = createService({
      afterAnalysisScreenshot: async (page) => {
        driftingCalls += 1
        await page.evaluate(() => {
          const control = document.querySelector<HTMLInputElement>('#state-text')!
          control.value = control.value === 'drift-a' ? 'drift-b' : 'drift-a'
        })
      },
    })
    services.push(driftingService)
    await expect(driftingService.analyze(`${fixture.origin}/analysis-native-state`)).rejects.toMatchObject({
      code: 'unsupported_page',
      status: 422,
    })
    expect(driftingCalls).toBe(2)
    expect(internalServiceState(driftingService)).toEqual({ sessions: 0, reservations: 0 })
  })

  it('classifies target-native value semantics privately and revalidates them before mutation', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService()
    services.push(service)
    const analysis = await service.analyze(`${fixture.origin}/target-value-safety`)
    const capabilityFor = (snapshot: typeof analysis, label: string) => {
      const evidence = snapshot.domEvidence.find((item) => item.label === label)
      return evidence && snapshot.capabilities.find(({ evidenceIds }) => evidenceIds.includes(evidence.id))
    }

    expect(capabilityFor(analysis, 'Safe reference')).toBeUndefined()
    expect(capabilityFor(analysis, 'Safe range')).toBeUndefined()
    expect(capabilityFor(analysis, 'Sensitive checkbox value')).toBeUndefined()
    expect(capabilityFor(analysis, 'Sensitive radio B')).toBeUndefined()
    expect(analysis.domEvidence.find(({ label }) => label === 'Sensitive checkbox value')).toMatchObject({ sensitive: true })
    expect(analysis.domEvidence.find(({ label }) => label === 'Sensitive radio B')).toMatchObject({ sensitive: true })
    const neutral = capabilityFor(analysis, 'Neutral reference')!
    expect(neutral).toBeDefined()
    expect(JSON.stringify(analysis)).not.toMatch(/Credit card number|Bank account|private-draft|initial-draft|neutral-choice|first-choice|second-choice/)
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      neutral.name,
      neutral.sampleInput,
      undefined,
      neutral.id,
    )).resolves.toMatchObject({ structuredContent: { targetStateVerified: true } })

    const lateService = createService()
    services.push(lateService)
    const lateAnalysis = await lateService.analyze(`${fixture.origin}/target-value-safety`)
    const latePage = internalSession(lateService, lateAnalysis.sessionId).page
    const late = capabilityFor(lateAnalysis, 'Late reference')!
    await latePage.locator('#late-live-value').evaluate((input) => {
      (input as HTMLInputElement).value = 'Credit card number'
    })
    await expect(lateService.execute(
      lateAnalysis.sessionId,
      lateAnalysis.sessionToken,
      late.name,
      late.sampleInput,
      undefined,
      late.id,
    )).rejects.toMatchObject({ code: 'invalid_action', sessionInvalidated: false })
    expect(await latePage.locator('#late-live-value').inputValue()).toBe('Credit card number')
    expect(await latePage.locator('#late-live-detail').inputValue()).toBe('')

    const lateRange = capabilityFor(lateAnalysis, 'Late range')!
    await latePage.locator('#late-range-value').evaluate((input) =>
      input.setAttribute('aria-valuetext', 'Bank account'))
    await expect(lateService.execute(
      lateAnalysis.sessionId,
      lateAnalysis.sessionToken,
      lateRange.name,
      lateRange.sampleInput,
      undefined,
      lateRange.id,
    )).rejects.toMatchObject({ code: 'invalid_action', sessionInvalidated: false })
    expect(await latePage.locator('#late-range-value').inputValue()).toBe('25')

    const lateCheckbox = capabilityFor(lateAnalysis, 'Late checkbox value')!
    await latePage.locator('#late-checkbox-value').evaluate((input) => {
      (input as HTMLInputElement).value = 'IBAN'
    })
    await expect(lateService.execute(
      lateAnalysis.sessionId,
      lateAnalysis.sessionToken,
      lateCheckbox.name,
      lateCheckbox.sampleInput,
      undefined,
      lateCheckbox.id,
    )).rejects.toMatchObject({ code: 'invalid_action', sessionInvalidated: false })
    expect(await latePage.locator('#late-checkbox-value').isChecked()).toBe(false)
    expect(await latePage.locator('#late-checkbox-detail').inputValue()).toBe('')

    const lateRadio = capabilityFor(lateAnalysis, 'Late radio A')!
    await latePage.locator('#late-radio-value-b').evaluate((input) => {
      (input as HTMLInputElement).value = 'BIC'
    })
    await expect(lateService.execute(
      lateAnalysis.sessionId,
      lateAnalysis.sessionToken,
      lateRadio.name,
      lateRadio.sampleInput,
      undefined,
      lateRadio.id,
    )).rejects.toMatchObject({ code: 'invalid_action', sessionInvalidated: false })
    expect(await latePage.locator('#late-radio-value-a, #late-radio-value-b').evaluateAll(
      (radios) => radios.map((radio) => (radio as HTMLInputElement).checked),
    )).toEqual([true, false])
    expect(await latePage.locator('#late-radio-detail').inputValue()).toBe('')

    const raceService = createService({ actionStartDelayMs: 180 })
    services.push(raceService)
    const raceAnalysis = await raceService.analyze(`${fixture.origin}/target-value-safety`)
    const racePage = internalSession(raceService, raceAnalysis.sessionId).page
    const raceCapability = capabilityFor(raceAnalysis, 'Late reference')!
    const pending = raceService.execute(
      raceAnalysis.sessionId,
      raceAnalysis.sessionToken,
      raceCapability.name,
      raceCapability.sampleInput,
      undefined,
      raceCapability.id,
    )
    await new Promise((resolve) => setTimeout(resolve, 40))
    await racePage.locator('#late-live-value').evaluate((input) => {
      (input as HTMLInputElement).value = 'Password'
    })
    await expect(pending).rejects.toMatchObject({ code: 'action_failed', sessionInvalidated: true })
    expect(internalServiceState(raceService)).toEqual({ sessions: 0, reservations: 0 })

    const seamService = createService({
      beforeControlWrite: async (page) => {
        await page.locator('#late-live-value').evaluate((input) => {
          (input as HTMLInputElement).value = 'Credit card number'
        })
      },
    })
    services.push(seamService)
    const seamAnalysis = await seamService.analyze(`${fixture.origin}/target-value-safety`)
    const seamCapability = capabilityFor(seamAnalysis, 'Late reference')!
    await expect(seamService.execute(
      seamAnalysis.sessionId,
      seamAnalysis.sessionToken,
      seamCapability.name,
      seamCapability.sampleInput,
      undefined,
      seamCapability.id,
    )).rejects.toMatchObject({ code: 'action_failed', sessionInvalidated: true })
    expect(internalServiceState(seamService)).toEqual({ sessions: 0, reservations: 0 })

    const preflightService = createService()
    services.push(preflightService)
    const preflightAnalysis = await preflightService.analyze(`${fixture.origin}/target-value-safety`)
    const preflightCapability = capabilityFor(preflightAnalysis, 'Neutral reference')!
    const preflightPage = internalSession(preflightService, preflightAnalysis.sessionId).page
    await preflightPage.locator('#neutral-live-detail').evaluate((input) => {
      (input as HTMLInputElement).value = 'Password'
    })
    await expect(preflightService.execute(
      preflightAnalysis.sessionId,
      preflightAnalysis.sessionToken,
      preflightCapability.name,
      preflightCapability.sampleInput,
      undefined,
      preflightCapability.id,
    )).rejects.toMatchObject({ code: 'invalid_action', sessionInvalidated: false })
    expect(await preflightPage.locator('#neutral-live-value').inputValue()).toBe('private-draft')
    await preflightPage.locator('#neutral-live-detail').evaluate((input) => {
      (input as HTMLInputElement).value = ''
    })
    await expect(preflightService.execute(
      preflightAnalysis.sessionId,
      preflightAnalysis.sessionToken,
      preflightCapability.name,
      preflightCapability.sampleInput,
      undefined,
      preflightCapability.id,
    )).resolves.toMatchObject({ structuredContent: { targetStateVerified: true } })
  }, 15_000)

  it('verifies every prepared form field atomically against periodic hostile resets', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService({ actionSettleMs: 80 })
    services.push(service)
    const analysis = await service.analyze(`${fixture.origin}/atomic-form-verification`)
    const hostileForm = analysis.capabilities.find(({ kind, evidenceIds }) => kind === 'prepare_form'
      && evidenceIds.some((id) => analysis.domEvidence.find((evidence) => evidence.id === id)?.label === 'Atomic first'))!
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      hostileForm.name,
      hostileForm.sampleInput,
      undefined,
      hostileForm.id,
    )).rejects.toMatchObject({ code: 'action_failed', sessionInvalidated: true })
    expect(internalServiceState(service)).toEqual({ sessions: 0, reservations: 0 })

    const stableService = createService({ actionSettleMs: 20 })
    services.push(stableService)
    const stableAnalysis = await stableService.analyze(`${fixture.origin}/atomic-form-verification`)
    const stableCapability = stableAnalysis.capabilities.find(({ kind, evidenceIds }) => kind === 'prepare_form'
      && evidenceIds.some((id) => stableAnalysis.domEvidence.find((evidence) => evidence.id === id)?.label === 'Stable first'))!
    await expect(stableService.execute(
      stableAnalysis.sessionId,
      stableAnalysis.sessionToken,
      stableCapability.name,
      stableCapability.sampleInput,
      undefined,
      stableCapability.id,
    )).resolves.toMatchObject({ structuredContent: { targetStateVerified: true } })
  })

  it('revalidates every requested form field after action recapture before reporting success', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    let stateBeforeReset: string[] = []
    const service = createService({
      actionSettleMs: 20,
      afterActionRecapture: async (page) => {
        stateBeforeReset = await page.locator('#stable-first, #stable-second').evaluateAll((controls) =>
          controls.map((control) => (control as HTMLInputElement).value))
        await page.locator('#stable-first').evaluate((control) => {
          ;(control as HTMLInputElement).value = ''
        })
      },
    })
    services.push(service)
    const analysis = await service.analyze(`${fixture.origin}/atomic-form-verification`)
    const stableForm = analysis.capabilities.find(({ kind, evidenceIds }) => kind === 'prepare_form'
      && evidenceIds.some((id) => analysis.domEvidence.find((evidence) => evidence.id === id)?.label === 'Stable first'))!
    const expectedValues = Object.values(stableForm.sampleInput).map(String)

    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      stableForm.name,
      stableForm.sampleInput,
      undefined,
      stableForm.id,
    )).rejects.toMatchObject({ code: 'action_failed', sessionInvalidated: true })
    expect(stateBeforeReset).toEqual(expectedValues)
    expect(internalServiceState(service)).toEqual({ sessions: 0, reservations: 0 })

    const stableService = createService({ actionSettleMs: 20 })
    services.push(stableService)
    const stableAnalysis = await stableService.analyze(`${fixture.origin}/atomic-form-verification`)
    const stableCapability = stableAnalysis.capabilities.find(({ kind, evidenceIds }) => kind === 'prepare_form'
      && evidenceIds.some((id) => stableAnalysis.domEvidence.find((evidence) => evidence.id === id)?.label === 'Stable first'))!
    await expect(stableService.execute(
      stableAnalysis.sessionId,
      stableAnalysis.sessionToken,
      stableCapability.name,
      stableCapability.sampleInput,
      undefined,
      stableCapability.id,
    )).resolves.toMatchObject({ structuredContent: { targetStateVerified: true } })
  })

  it('invalidates the session if isolated script execution cannot be restored', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService({ actionSettleMs: 20 })
    services.push(service)
    const analysis = await service.analyze(`${fixture.origin}/atomic-form-verification`)
    const form = analysis.capabilities.find(({ kind, evidenceIds }) => kind === 'prepare_form'
      && evidenceIds.some((id) => analysis.domEvidence.find((evidence) => evidence.id === id)?.label === 'Stable first'))!
    const context = internalSession(service, analysis.sessionId).context
    const newCDPSession = context.newCDPSession.bind(context)
    let failRestore = true
    context.newCDPSession = async (page) => {
      const cdp = await newCDPSession(page)
      const send = cdp.send.bind(cdp) as (method: string, params?: Record<string, unknown>) => Promise<unknown>
      ;(cdp as unknown as { send: typeof send }).send = async (method, params) => {
        if (
          failRestore
          && method === 'Emulation.setScriptExecutionDisabled'
          && params?.value === false
        ) {
          failRestore = false
          throw new Error('test-only restore failure')
        }
        return send(method, params)
      }
      return cdp
    }

    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      form.name,
      form.sampleInput,
      undefined,
      form.id,
    )).rejects.toMatchObject({ code: 'action_failed', sessionInvalidated: true })
    expect(failRestore).toBe(false)
    expect(internalServiceState(service)).toEqual({ sessions: 0, reservations: 0 })
  })

  it('propagates a script-restore invalidation out of action recapture without retrying it away', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    let armRestoreFailure = false
    let failRestore = false
    const service = createService({
      actionSettleMs: 20,
      afterAnalysisScreenshot: async () => {
        if (!armRestoreFailure) return
        armRestoreFailure = false
        failRestore = true
      },
    })
    services.push(service)
    const analysis = await service.analyze(`${fixture.origin}/atomic-form-verification`)
    const form = analysis.capabilities.find(({ kind, evidenceIds }) => kind === 'prepare_form'
      && evidenceIds.some((id) => analysis.domEvidence.find((evidence) => evidence.id === id)?.label === 'Stable first'))!
    const context = internalSession(service, analysis.sessionId).context
    const newCDPSession = context.newCDPSession.bind(context)
    context.newCDPSession = async (page) => {
      const cdp = await newCDPSession(page)
      const send = cdp.send.bind(cdp) as (method: string, params?: Record<string, unknown>) => Promise<unknown>
      ;(cdp as unknown as { send: typeof send }).send = async (method, params) => {
        if (
          failRestore
          && method === 'Emulation.setScriptExecutionDisabled'
          && params?.value === false
        ) {
          failRestore = false
          throw new Error('test-only recapture restore failure')
        }
        return send(method, params)
      }
      return cdp
    }
    armRestoreFailure = true

    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      form.name,
      form.sampleInput,
      undefined,
      form.id,
    )).rejects.toMatchObject({ code: 'action_failed', sessionInvalidated: true })
    expect(armRestoreFailure).toBe(false)
    expect(failRestore).toBe(false)
    expect(internalServiceState(service)).toEqual({ sessions: 0, reservations: 0 })
  }, 10_000)

  it('restores script execution after an ambiguous disable response before preserving the session', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService({ actionSettleMs: 20 })
    services.push(service)
    const analysis = await service.analyze(`${fixture.origin}/atomic-form-verification`)
    const form = analysis.capabilities.find(({ kind, evidenceIds }) => kind === 'prepare_form'
      && evidenceIds.some((id) => analysis.domEvidence.find((evidence) => evidence.id === id)?.label === 'Stable first'))!
    const context = internalSession(service, analysis.sessionId).context
    const newCDPSession = context.newCDPSession.bind(context)
    let failDisableResponse = true
    let restoreCalls = 0
    context.newCDPSession = async (page) => {
      const cdp = await newCDPSession(page)
      const send = cdp.send.bind(cdp) as (method: string, params?: Record<string, unknown>) => Promise<unknown>
      ;(cdp as unknown as { send: typeof send }).send = async (method, params) => {
        if (method === 'Emulation.setScriptExecutionDisabled' && params?.value === false) {
          restoreCalls += 1
        }
        if (
          failDisableResponse
          && method === 'Emulation.setScriptExecutionDisabled'
          && params?.value === true
        ) {
          failDisableResponse = false
          await send(method, params)
          throw new Error('test-only ambiguous disable response')
        }
        return send(method, params)
      }
      return cdp
    }

    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      form.name,
      form.sampleInput,
      undefined,
      form.id,
    )).rejects.toMatchObject({ code: 'invalid_action', sessionInvalidated: false })
    expect(failDisableResponse).toBe(false)
    expect(restoreCalls).toBeGreaterThanOrEqual(1)
    expect(internalServiceState(service)).toEqual({ sessions: 1, reservations: 0 })
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      form.name,
      form.sampleInput,
      undefined,
      form.id,
    )).resolves.toMatchObject({ structuredContent: { targetStateVerified: true } })
  }, 10_000)

  it('classifies every bounded descendant image alt on links and revalidates late mutations', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService()
    services.push(service)
    const analysis = await service.analyze(`${fixture.origin}/link-image-alt-safety`)

    expect(analysis.domEvidence.map(({ label, sensitive }) => ({ label, sensitive }))).toEqual([
      { label: 'Info', sensitive: true },
      { label: 'Info', sensitive: false },
      { label: 'History', sensitive: false },
      { label: 'overflow-multi-image-link', sensitive: true },
    ])
    const navigation = analysis.capabilities.find(({ kind }) => kind === 'navigation')!
    expect(navigation.inputSchema).toMatchObject({
      properties: { linkIndex: { minimum: 0, maximum: 1 } },
    })
    const page = internalSession(service, analysis.sessionId).page

    await page.locator('#late-link-second-image').evaluate((image) => image.setAttribute('alt', 'Checkout'))
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      navigation.name,
      { linkIndex: 0 },
      undefined,
      navigation.id,
    )).rejects.toMatchObject({ code: 'invalid_action', sessionInvalidated: false })
    expect(page.url()).toBe(`${fixture.origin}/link-image-alt-safety`)

    await page.locator('#late-link-second-image').evaluate((image) => image.setAttribute('alt', 'Overview'))
    const result = await service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      navigation.name,
      { linkIndex: 0 },
      undefined,
      navigation.id,
    )
    expect(result.structuredContent.targetStateVerified).toBe(true)
    expect(result.analysis.finalUrl).toBe(`${fixture.origin}/about#late`)
  })

  it('excludes controls without a genuine identifying label while preserving labelled controls', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService()
    services.push(service)
    const analysis = await service.analyze(`${fixture.origin}/unlabelled-controls`)

    expect(analysis.domEvidence.map(({ label, sensitive }) => ({ label, sensitive }))).toEqual([
      { label: '', sensitive: true },
      { label: '', sensitive: true },
      { label: 'Neutral value', sensitive: false },
      { label: 'Neutral detail', sensitive: false },
      { label: 'Referenced value', sensitive: false },
      { label: 'Referenced detail', sensitive: false },
    ])
    const forms = analysis.capabilities.filter(({ kind }) => kind === 'prepare_form')
    expect(forms).toHaveLength(2)
    expect(forms.every(({ evidenceIds }) => evidenceIds.every((id) =>
      analysis.domEvidence.find((evidence) => evidence.id === id)?.label))).toBe(true)
    const referencedForm = forms.find(({ evidenceIds }) => evidenceIds.some((id) =>
      analysis.domEvidence.find((evidence) => evidence.id === id)?.label === 'Referenced value'))!
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      referencedForm.name,
      referencedForm.sampleInput,
      undefined,
      referencedForm.id,
    )).resolves.toMatchObject({ structuredContent: { targetStateVerified: true } })
  })

  it('classifies bounded form, fieldset, and legend context and revalidates owner mutations', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService()
    services.push(service)
    let analysis = await service.analyze(`${fixture.origin}/owner-context-safety`)

    const evidenceByLabel = new Map(analysis.domEvidence.map((evidence) => [evidence.label, evidence]))
    for (const label of [
      'Sensitive owner value',
      'Sensitive owner detail',
      'Sensitive fieldset value',
      'Sensitive fieldset detail',
      'Sensitive legend value',
      'Sensitive legend detail',
      'Reference overflow value',
      'Reference overflow detail',
      'Text overflow value',
      'Text overflow detail',
      'Aggregate overflow value',
      'Aggregate overflow detail',
      'Fieldset overflow value',
      'Fieldset overflow detail',
    ]) expect(evidenceByLabel.get(label)?.sensitive).toBe(true)
    expect(evidenceByLabel.get('Depth overflow value')).toBeUndefined()
    expect(evidenceByLabel.get('Depth overflow detail')).toBeUndefined()

    const forms = analysis.capabilities.filter(({ kind }) => kind === 'prepare_form')
    expect(forms).toHaveLength(2)
    const lateForm = forms.find(({ evidenceIds }) => evidenceIds.some((id) =>
      analysis.domEvidence.find((evidence) => evidence.id === id)?.label === 'Late owner value'))!
    const page = internalSession(service, analysis.sessionId).page

    const expectLateMutationRejected = async (
      selector: string,
      attribute: string | undefined,
      unsafeValue: string,
      safeValue: string,
    ) => {
      await page.locator(selector).evaluate((node, mutation) => {
        if (mutation.attribute) node.setAttribute(mutation.attribute, mutation.value)
        else node.textContent = mutation.value
      }, { attribute, value: unsafeValue })
      await expect(service.execute(
        analysis.sessionId,
        analysis.sessionToken,
        lateForm.name,
        lateForm.sampleInput,
        undefined,
        lateForm.id,
      )).rejects.toMatchObject({ code: 'invalid_action', sessionInvalidated: false })
      expect(await page.locator('#late-owner-value').inputValue()).toBe('')
      expect(await page.locator('#late-owner-detail').inputValue()).toBe('')
      await page.locator(selector).evaluate((node, mutation) => {
        if (mutation.attribute) node.setAttribute(mutation.attribute, mutation.value)
        else node.textContent = mutation.value
      }, { attribute, value: safeValue })
    }

    await expectLateMutationRejected('#late-owner-form', 'aria-label', 'Payment', 'Reference context')
    await expectLateMutationRejected('#late-owner-fieldset', 'title', 'User password', 'Overview')
    await expectLateMutationRejected('#late-owner-legend', undefined, 'Credit card', 'Reference options')

    const lateResult = await service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      lateForm.name,
      lateForm.sampleInput,
      undefined,
      lateForm.id,
    )
    expect(lateResult.structuredContent.targetStateVerified).toBe(true)
    analysis = lateResult.analysis
    const neutralForm = analysis.capabilities.find(({ kind, evidenceIds }) =>
      kind === 'prepare_form' && evidenceIds.some((id) =>
        analysis.domEvidence.find((evidence) => evidence.id === id)?.label === 'Neutral owner value'))!
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      neutralForm.name,
      neutralForm.sampleInput,
      undefined,
      neutralForm.id,
    )).resolves.toMatchObject({ structuredContent: { targetStateVerified: true } })
  })

  it('classifies the owning form action privately and revalidates late action drift', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService()
    services.push(service)
    const analysis = await service.analyze(`${fixture.origin}/owner-form-action-safety`)
    const evidenceByLabel = new Map(analysis.domEvidence.map((evidence) => [evidence.label, evidence]))

    for (const label of [
      'Consequential action value',
      'Consequential action detail',
      'Cross origin action value',
      'Cross origin action detail',
      'Malformed action value',
      'Malformed action detail',
      'Overflow action value',
      'Overflow action detail',
    ]) expect(evidenceByLabel.get(label)?.sensitive).toBe(true)
    expect(JSON.stringify(analysis)).not.toContain('/checkout')
    expect(JSON.stringify(analysis)).not.toContain('example.com/contact')

    const lateEvidence = evidenceByLabel.get('Late action value')!
    const lateForm = analysis.capabilities.find(({ kind, evidenceIds }) =>
      kind === 'prepare_form' && evidenceIds.includes(lateEvidence.id))!
    const page = internalSession(service, analysis.sessionId).page
    await page.locator('#late-action-form').evaluate((form) => {
      form.setAttribute('action', '/booking')
    })
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      lateForm.name,
      lateForm.sampleInput,
      undefined,
      lateForm.id,
    )).rejects.toMatchObject({ code: 'invalid_action', sessionInvalidated: false })
    expect(await page.locator('#late-action-value').inputValue()).toBe('')
    expect(await page.locator('#late-action-detail').inputValue()).toBe('')

    await page.locator('#late-action-form').evaluate((form) => {
      form.setAttribute('action', '/about#overview')
    })
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      lateForm.name,
      lateForm.sampleInput,
      undefined,
      lateForm.id,
    )).resolves.toMatchObject({ structuredContent: { targetStateVerified: true } })

    let admittedBeforeWriteValues: string[] = []
    const admittedService = createService({
      beforeControlWrite: async (page) => {
        await page.locator('#late-action-form').evaluate((form) => {
          form.setAttribute('action', '/booking')
        })
        admittedBeforeWriteValues = await page.locator(
          '#late-action-value, #late-action-detail',
        ).evaluateAll((controls) => controls.map((control) => (control as HTMLInputElement).value))
      },
    })
    services.push(admittedService)
    const admittedAnalysis = await admittedService.analyze(`${fixture.origin}/owner-form-action-safety`)
    const admittedEvidence = admittedAnalysis.domEvidence.find(({ label }) => label === 'Late action value')!
    const admittedForm = admittedAnalysis.capabilities.find(({ kind, evidenceIds }) =>
      kind === 'prepare_form' && evidenceIds.includes(admittedEvidence.id))!
    await expect(admittedService.execute(
      admittedAnalysis.sessionId,
      admittedAnalysis.sessionToken,
      admittedForm.name,
      admittedForm.sampleInput,
      undefined,
      admittedForm.id,
    )).rejects.toMatchObject({ code: 'action_failed', sessionInvalidated: true })
    expect(admittedBeforeWriteValues).toEqual(['', ''])
    expect(internalServiceState(admittedService)).toEqual({ sessions: 0, reservations: 0 })
  })

  it('retries analysis capture when focus-only CSS paint changes during the screenshot', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    let captureCalls = 0
    const service = createService({
      beforeAnalysisScreenshot: async (page, attempt) => {
        captureCalls += 1
        if (attempt !== 0) return
        await page.locator('#focus-capture-probe').evaluate((probe) => {
          ;(probe as HTMLElement).focus({ preventScroll: true })
        })
      },
      afterAnalysisScreenshot: async (page, attempt) => {
        if (attempt !== 0) return
        await page.locator('#focus-capture-probe').evaluate((probe) => {
          ;(probe as HTMLElement).blur()
        })
      },
    })
    services.push(service)

    const analysis = await service.analyze(`${fixture.origin}/focus-capture-stability`)

    expect(captureCalls).toBe(2)
    expect(analysis.domEvidence.some(({ label }) => label === 'Focus stable search')).toBe(true)
    expect(analysis.capabilities.some(({ name }) => name === 'prepare_page_search')).toBe(true)
  })

  it('retries analysis when private native control state changes across the screenshot boundary', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    let captureCalls = 0
    const service = createService({
      beforeAnalysisScreenshot: async (page, attempt) => {
        captureCalls += 1
        if (attempt !== 0) return
        await page.evaluate(() => {
          const input = document.querySelector<HTMLInputElement>('#native-state-input')!
          const checkbox = document.querySelector<HTMLInputElement>('#native-state-checkbox')!
          const textarea = document.querySelector<HTMLTextAreaElement>('#native-state-textarea')!
          const select = document.querySelector<HTMLSelectElement>('#native-state-select')!
          input.value = 'temporary native value'
          input.setCustomValidity('temporary invalid input')
          checkbox.checked = true
          checkbox.indeterminate = true
          checkbox.setCustomValidity('temporary invalid checkbox')
          textarea.value = 'temporary textarea value'
          textarea.setCustomValidity('temporary invalid textarea')
          select.selectedIndex = 1
        })
      },
      afterAnalysisScreenshot: async (page, attempt) => {
        if (attempt !== 0) return
        await page.evaluate(() => {
          const input = document.querySelector<HTMLInputElement>('#native-state-input')!
          const checkbox = document.querySelector<HTMLInputElement>('#native-state-checkbox')!
          const textarea = document.querySelector<HTMLTextAreaElement>('#native-state-textarea')!
          const select = document.querySelector<HTMLSelectElement>('#native-state-select')!
          input.value = 'opaque-native-capture-secret'
          input.setCustomValidity('')
          checkbox.checked = false
          checkbox.indeterminate = false
          checkbox.setCustomValidity('')
          textarea.value = ''
          textarea.setCustomValidity('')
          select.selectedIndex = 0
        })
      },
    })
    services.push(service)

    const analysis = await service.analyze(`${fixture.origin}/native-control-state-capture`)

    expect(captureCalls).toBe(2)
    expect(analysis.capabilities.some(({ name }) => name === 'prepare_page_search')).toBe(true)
    expect(JSON.stringify(analysis)).not.toContain('opaque-native-capture-secret')
  })

  it('keeps short private state raw and large private state bounded-hashed while detecting either drift', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    let captureCalls = 0
    const originalHashedValue = 'private-hash-source-'.repeat(400)
    const service = createService({
      beforeAnalysisScreenshot: async (page, attempt) => {
        captureCalls += 1
        if (attempt !== 0) return
        await page.evaluate(() => {
          document.querySelector<HTMLInputElement>('#hashed-private-state')!.value = 'changed-hashed-state'.repeat(400)
        })
      },
      afterAnalysisScreenshot: async (page, attempt) => {
        if (attempt !== 0) return
        await page.evaluate((value) => {
          document.querySelector<HTMLInputElement>('#hashed-private-state')!.value = value
        }, originalHashedValue)
      },
    })
    services.push(service)

    const analysis = await service.analyze(`${fixture.origin}/native-control-state-hashed`)
    const search = analysis.capabilities.find(({ name }) => name === 'prepare_page_search')!

    expect(captureCalls).toBe(2)
    expect(search).toBeDefined()
    expect(JSON.stringify(analysis)).not.toContain('short-private-state')
    expect(JSON.stringify(analysis)).not.toContain('private-hash-source-')
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      search.name,
      search.sampleInput,
      undefined,
      search.id,
    )).resolves.toMatchObject({ structuredContent: { targetStateVerified: true } })
  })

  it('retains XHTML native controls whose CDP node names are lowercase', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService()
    services.push(service)

    const analysis = await service.analyze(`${fixture.origin}/native-control-xhtml`)
    const search = analysis.capabilities.find(({ name }) => name === 'prepare_page_search')!

    expect(search).toBeDefined()
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      search.name,
      search.sampleInput,
      undefined,
      search.id,
    )).resolves.toMatchObject({ structuredContent: { targetStateVerified: true } })
  })

  it('revalidates closed-shadow native control state after the screenshot', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    let captureCalls = 0
    const service = createService({
      afterAnalysisScreenshot: async (page, attempt) => {
        captureCalls += 1
        if (attempt !== 0) return
        await page.evaluate(() => {
          setTimeout(() => {
            ;(globalThis as typeof globalThis & {
              __nativeShadowCheckboxForTest: HTMLInputElement
            }).__nativeShadowCheckboxForTest.checked = true
          }, 0)
        })
      },
    })
    services.push(service)

    const analysis = await service.analyze(`${fixture.origin}/native-control-shadow-capture`)
    const page = internalSession(service, analysis.sessionId).page

    expect(captureCalls).toBe(2)
    expect(await page.evaluate(() => (
      globalThis as typeof globalThis & { __nativeShadowCheckboxForTest: HTMLInputElement }
    ).__nativeShadowCheckboxForTest.checked)).toBe(true)
    expect(analysis.capabilities.some(({ name }) => name === 'prepare_page_search')).toBe(true)
  })

  it('does not mask a requested control before its pre-action screenshot', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService({
      beforeActionStateCapture: async (page) => {
        await page.locator('#native-state-search').evaluate((control) => {
          ;(control as HTMLInputElement).value = 'page-authored temporary target value'
        })
      },
    })
    services.push(service)
    const analysis = await service.analyze(`${fixture.origin}/native-control-state-capture`)
    const search = analysis.capabilities.find(({ name }) => name === 'prepare_page_search')!

    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      search.name,
      { query: 'wrapper target value' },
      undefined,
      search.id,
    )).rejects.toMatchObject({ code: 'action_failed', sessionInvalidated: true })
    expect(internalServiceState(service)).toEqual({ sessions: 0, reservations: 0 })
  })

  it('does not verify an action from an unrelated native control paint change', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    let injectPaintState = true
    const service = createService({
      beforeActionStateCapture: async (page) => {
        if (!injectPaintState) return
        await page.locator('#native-state-checkbox').evaluate((control) => {
          ;(control as HTMLInputElement).checked = true
        })
      },
      afterActionRecapture: async (page) => {
        if (!injectPaintState) return
        await page.locator('#native-state-checkbox').evaluate((control) => {
          ;(control as HTMLInputElement).checked = false
        })
      },
    })
    services.push(service)
    const analysis = await service.analyze(`${fixture.origin}/native-control-state-capture`)
    const search = analysis.capabilities.find(({ name }) => name === 'prepare_page_search')!

    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      search.name,
      { query: 'visually hidden target text' },
      undefined,
      search.id,
    )).rejects.toMatchObject({ code: 'action_failed', sessionInvalidated: true })

    expect(internalServiceState(service)).toEqual({ sessions: 0, reservations: 0 })
    injectPaintState = false
  })

  it('fails closed when cumulative private native-control hash input exceeds one MiB', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService()
    services.push(service)

    await expect(service.analyze(
      `${fixture.origin}/native-control-state-overflow`,
    )).rejects.toMatchObject({ code: 'unsupported_page', status: 422 })
    expect(internalServiceState(service)).toEqual({ sessions: 0, reservations: 0 })
  })

  it('rejects a focus-only action-capture transition before any native write', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    let focusTransitions = 0
    const service = createService({
      duringActionCaptureArm: async (page) => {
        focusTransitions += 1
        await page.locator('#focus-capture-probe').evaluate((probe) => {
          ;(probe as HTMLElement).focus({ preventScroll: true })
          ;(probe as HTMLElement).blur()
        })
      },
    })
    services.push(service)
    const analysis = await service.analyze(`${fixture.origin}/focus-capture-stability`)
    const capability = analysis.capabilities.find(({ name }) => name === 'prepare_page_search')!

    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      capability.name,
      { query: 'must not be written' },
      undefined,
      capability.id,
    )).rejects.toMatchObject({ code: 'invalid_action', status: 409, sessionInvalidated: false })

    expect(focusTransitions).toBe(1)
    expect(await internalSession(service, analysis.sessionId).page
      .locator('#focus-capture-search').inputValue()).toBe('')
    expect(internalServiceState(service)).toEqual({ sessions: 1, reservations: 0 })
  })

  it('invalidates instead of verifying an action after a focus-only capture transition', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    let focusTransitions = 0
    const service = createService({
      beforeActionStateCapture: async (page) => {
        focusTransitions += 1
        await page.locator('#focus-capture-probe').evaluate((probe) => {
          ;(probe as HTMLElement).focus({ preventScroll: true })
          ;(probe as HTMLElement).blur()
        })
      },
    })
    services.push(service)
    const analysis = await service.analyze(`${fixture.origin}/focus-capture-stability`)
    const capability = analysis.capabilities.find(({ name }) => name === 'prepare_page_search')!

    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      capability.name,
      { query: 'must not be verified' },
      undefined,
      capability.id,
    )).rejects.toMatchObject({ code: 'action_failed', sessionInvalidated: true })

    expect(focusTransitions).toBe(1)
    expect(internalServiceState(service)).toEqual({ sessions: 0, reservations: 0 })
  })

  it('watches every captured owner-context source across screenshot capture and retries transient drift', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const mutations = [
      ['#watch-form', 'aria-label', 'Payment', ''],
      ['#watch-fieldset', 'title', 'User password', ''],
      ['#watch-legend', undefined, 'Credit card reference', 'Neutral legend'],
      ['#watch-form-reference', undefined, 'Payment reference', 'Neutral form reference'],
      ['#watch-fieldset-reference', undefined, 'Password reference', 'Neutral fieldset reference'],
      ['#watch-legend-reference', undefined, 'Credit card reference', 'Neutral legend reference'],
    ] as const

    for (const [selector, attribute, unsafeValue, safeValue] of mutations) {
      let captureCalls = 0
      const service = createService({
        beforeAnalysisScreenshot: async (page, attempt) => {
          captureCalls += 1
          if (attempt !== 0) return
          await page.locator(selector).evaluate((node, mutation) => {
            if (mutation.attribute) node.setAttribute(mutation.attribute, mutation.value)
            else node.textContent = mutation.value
          }, { attribute, value: unsafeValue })
        },
        afterAnalysisScreenshot: async (page, attempt) => {
          if (attempt !== 0) return
          await page.locator(selector).evaluate((node, mutation) => {
            if (mutation.attribute) {
              if (mutation.value) node.setAttribute(mutation.attribute, mutation.value)
              else node.removeAttribute(mutation.attribute)
            } else node.textContent = mutation.value
          }, { attribute, value: safeValue })
        },
      })
      services.push(service)
      const analysis = await service.analyze(`${fixture.origin}/analysis-owner-watchset`)
      expect(captureCalls).toBe(2)
      expect(await service.closeSession(analysis.sessionId, analysis.sessionToken)).toBe(true)
    }

    const stableService = createService()
    services.push(stableService)
    const stableAnalysis = await stableService.analyze(`${fixture.origin}/analysis-owner-watchset`)
    const stableForm = stableAnalysis.capabilities.find(({ kind }) => kind === 'prepare_form')!
    await expect(stableService.execute(
      stableAnalysis.sessionId,
      stableAnalysis.sessionToken,
      stableForm.name,
      stableForm.sampleInput,
      undefined,
      stableForm.id,
    )).resolves.toMatchObject({ structuredContent: { targetStateVerified: true } })
    expect(await stableService.closeSession(
      stableAnalysis.sessionId,
      stableAnalysis.sessionToken,
    )).toBe(true)

    let continuousCalls = 0
    const continuouslyChanging = createService({
      beforeAnalysisScreenshot: async (page) => {
        continuousCalls += 1
        await page.locator('#watch-form-reference').evaluate((node) => {
          node.textContent = 'Payment reference'
        })
      },
      afterAnalysisScreenshot: async (page) => {
        await page.locator('#watch-form-reference').evaluate((node) => {
          node.textContent = 'Neutral form reference'
        })
      },
    })
    services.push(continuouslyChanging)
    await expect(continuouslyChanging.analyze(
      `${fixture.origin}/analysis-owner-watchset`,
    )).rejects.toMatchObject({ code: 'unsupported_page', status: 422 })
    expect(continuousCalls).toBe(2)
    expect(internalServiceState(continuouslyChanging)).toEqual({ sessions: 0, reservations: 0 })

    let missingReferenceCaptureCalls = 0
    const missingReference = createService({
      beforeAnalysisScreenshot: async (page, attempt) => {
        missingReferenceCaptureCalls += 1
        if (attempt !== 0) return
        await page.locator('#late-missing-owner-source').evaluate((node) => {
          node.id = 'missing-owner-reference'
          node.textContent = 'Payment reference'
        })
      },
      afterAnalysisScreenshot: async (page, attempt) => {
        if (attempt !== 0) return
        await page.locator('#late-missing-owner-source').evaluate((node) => {
          node.removeAttribute('id')
          node.textContent = 'Neutral late reference'
        })
      },
    })
    services.push(missingReference)
    const missingAnalysis = await missingReference.analyze(
      `${fixture.origin}/analysis-owner-watchset`,
    )
    expect(missingReferenceCaptureCalls).toBeGreaterThanOrEqual(1)
    expect(missingReferenceCaptureCalls).toBeLessThanOrEqual(2)
    const missingEvidence = missingAnalysis.domEvidence.filter(({ label }) =>
      label === 'Missing owner value' || label === 'Missing owner detail')
    expect(missingEvidence).toHaveLength(2)
    expect(missingEvidence.every(({ sensitive }) => sensitive)).toBe(true)
    expect(missingAnalysis.capabilities.every(({ evidenceIds }) => evidenceIds.every((id) =>
      !missingEvidence.some((evidence) => evidence.id === id)))).toBe(true)
    expect(JSON.stringify(missingAnalysis)).not.toContain('Payment reference')
    const missingExternalOwnerEvidence = missingAnalysis.domEvidence.filter(({ label }) =>
      label === 'Missing external owner value' || label === 'Missing external owner detail')
    expect(missingExternalOwnerEvidence).toHaveLength(2)
    expect(missingExternalOwnerEvidence.every(({ sensitive }) => sensitive)).toBe(true)
    expect(missingAnalysis.capabilities.every(({ evidenceIds }) => evidenceIds.every((id) =>
      !missingExternalOwnerEvidence.some((evidence) => evidence.id === id)))).toBe(true)
  }, 90_000)

  it('retries viewport capture after main and nested scroll-out restoration while preserving stable pre-scroll', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    let captureCalls = 0
    let mainBaseline = 0
    let nestedBaseline = 0
    const service = createService({
      beforeAnalysisScreenshot: async (page, attempt) => {
        captureCalls += 1
        if (attempt !== 0) return
        const baseline = await page.evaluate(async () => {
          const scroller = document.querySelector<HTMLElement>('#nested-scroll-host')!
          const current = { main: window.scrollY, nested: scroller.scrollTop }
          window.scrollTo(0, 1_300)
          scroller.scrollTop = 500
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
          return current
        })
        mainBaseline = baseline.main
        nestedBaseline = baseline.nested
      },
      afterAnalysisScreenshot: async (page, attempt) => {
        if (attempt !== 0) return
        await page.evaluate(async ({ main, nested }) => {
          window.scrollTo(0, main)
          document.querySelector<HTMLElement>('#nested-scroll-host')!.scrollTop = nested
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
        }, { main: mainBaseline, nested: nestedBaseline })
      },
    })
    services.push(service)

    const analysis = await service.analyze(`${fixture.origin}/analysis-scroll-stability`)
    const page = internalSession(service, analysis.sessionId).page
    expect(captureCalls).toBe(2)
    expect(await page.evaluate(() => ({
      main: window.scrollY,
      nested: document.querySelector<HTMLElement>('#nested-scroll-host')!.scrollTop,
    }))).toEqual({ main: 260, nested: 20 })
    expect(analysis.domEvidence.filter(({ label }) =>
      label === 'Main scroll search' || label === 'Nested scroll search')).toHaveLength(2)
    expect(analysis.capabilities.filter(({ kind }) => kind === 'prepare_search')).toHaveLength(1)
    expect(internalServiceState(service)).toEqual({ sessions: 1, reservations: 0 })
  })

  it('fails closed after bounded retries when a relevant nested scroller keeps moving during capture', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    let captureCalls = 0
    let nestedBaseline = 0
    const service = createService({
      beforeAnalysisScreenshot: async (page) => {
        captureCalls += 1
        nestedBaseline = await page.locator('#nested-scroll-host').evaluate(async (scroller) => {
          const current = scroller.scrollTop
          scroller.scrollTop = 500
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
          return current
        })
      },
      afterAnalysisScreenshot: async (page) => {
        await page.locator('#nested-scroll-host').evaluate(async (scroller, baseline) => {
          scroller.scrollTop = baseline
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
        }, nestedBaseline)
      },
    })
    services.push(service)

    await expect(service.analyze(`${fixture.origin}/analysis-scroll-stability`)).rejects.toMatchObject({
      code: 'unsupported_page',
      status: 422,
    })
    expect(captureCalls).toBe(2)
    expect(internalServiceState(service)).toEqual({ sessions: 0, reservations: 0 })
  })

  it('rejects when action recapture stabilizes on a different requested-control safety identity', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    let captureCalls = 0
    const service = createService({
      beforeAnalysisScreenshot: async (page) => {
        captureCalls += 1
        if (captureCalls !== 2) return
        await page.evaluate(() => {
          const searchControl = document.querySelector<HTMLInputElement>('input[type="search"]')!
          searchControl.id = 'changed-during-capture'
          searchControl.setAttribute('aria-label', 'User password')
          ;(document.querySelector('select') as HTMLSelectElement).hidden = true
        })
      },
    })
    services.push(service)
    const analysis = await service.analyze(`${fixture.origin}/`)
    const search = analysis.capabilities.find(({ name }) => name === 'prepare_page_search')!

    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      search.name,
      search.sampleInput,
      undefined,
      search.id,
    )).rejects.toMatchObject({ code: 'action_failed', sessionInvalidated: true })

    expect(captureCalls).toBe(3)
    expect(internalServiceState(service)).toEqual({ sessions: 0, reservations: 0 })
  })

  it('fails closed after bounded analysis-capture retries on continuous DOM drift', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    let captureCalls = 0
    const service = createService({
      beforeAnalysisScreenshot: async (page) => {
        captureCalls += 1
        if (captureCalls === 1) return
        await page.locator('input[type="search"]').evaluate((input, call) => {
          input.setAttribute('aria-label', `Changing reference ${call}`)
        }, captureCalls)
      },
    })
    services.push(service)
    const analysis = await service.analyze(`${fixture.origin}/`)
    const filter = analysis.capabilities.find(({ name }) => name === 'set_page_filter')!

    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      filter.name,
      filter.sampleInput,
      undefined,
      filter.id,
    )).rejects.toMatchObject({ code: 'action_failed', sessionInvalidated: true })
    expect(captureCalls).toBe(3)
    expect(internalServiceState(service)).toEqual({ sessions: 0, reservations: 0 })
  })

  it('retries once for CSSOM and style-tree drift, then publishes only stable evidence', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    for (const mutation of ['insertRule', 'replaceSync', 'head-style'] as const) {
      let captureCalls = 0
      const service = createService({
        beforeAnalysisScreenshot: async (page) => {
          captureCalls += 1
          if (captureCalls !== 1) return
          await page.evaluate((kind) => {
            if (kind === 'insertRule') {
              document.styleSheets[0].insertRule('.cssom-control { background: rgb(240, 240, 240); }')
            } else if (kind === 'replaceSync') {
              ;(window as unknown as { fixtureConstructedSheet: CSSStyleSheet }).fixtureConstructedSheet
                .replaceSync('.constructed-control { background: rgb(240, 240, 240); }')
            } else {
              const style = document.createElement('style')
              style.textContent = '.cssom-control { border-color: rgb(30, 40, 50); }'
              document.head.append(style)
            }
          }, mutation)
        },
      })
      services.push(service)
      const analysis = await service.analyze(`${fixture.origin}/cssom-capture-stability`)
      expect(captureCalls).toBe(2)
      expect(analysis.capabilities.some(({ kind }) => kind === 'prepare_search')).toBe(true)
    }

    let preDomCaptureCalls = 0
    const preDomService = createService({
      beforeDomEvidenceCollection: async (page) => {
        preDomCaptureCalls += 1
        if (preDomCaptureCalls !== 1) return
        await page.evaluate(() => {
          const meta = document.createElement('meta')
          meta.name = 'fixture-head-drift'
          meta.content = 'changed-before-dom-capture'
          document.head.append(meta)
        })
      },
    })
    services.push(preDomService)
    const preDomAnalysis = await preDomService.analyze(`${fixture.origin}/cssom-capture-stability`)
    expect(preDomCaptureCalls).toBe(2)
    expect(preDomAnalysis.capabilities.some(({ kind }) => kind === 'prepare_search')).toBe(true)
  })

  it('fails closed after exactly one retry when CSSOM keeps changing during capture', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    let captureCalls = 0
    const service = createService({
      beforeAnalysisScreenshot: async (page) => {
        captureCalls += 1
        await page.evaluate((call) => {
          document.styleSheets[0].insertRule(`.cssom-${call} { color: rgb(${call}, 10, 20); }`)
        }, captureCalls)
      },
    })
    services.push(service)

    await expect(service.analyze(`${fixture.origin}/cssom-capture-stability`)).rejects.toMatchObject({
      code: 'unsupported_page',
      status: 422,
    })
    expect(captureCalls).toBe(2)
    expect(internalServiceState(service)).toEqual({ sessions: 0, reservations: 0 })
  })

  it('freezes CSS and Web Animations for the complete analysis capture and restores them afterwards', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const observations: Array<{ times: number[], opacities: number[] }> = []
    const readAnimationState = async (page: Page) => page.evaluate(() => ({
      times: document.getAnimations().map((animation) => Number(animation.currentTime ?? -1)),
      opacities: ['css-animated-search', 'web-animated-search'].map((id) =>
        Number(getComputedStyle(document.getElementById(id)!).opacity)),
    }))
    const service = createService({
      beforeDomEvidenceCollection: async (page) => {
        observations.push(await readAnimationState(page))
      },
      beforeAnalysisScreenshot: async (page) => {
        await new Promise((resolve) => setTimeout(resolve, 120))
        observations.push(await readAnimationState(page))
      },
      afterAnalysisScreenshot: async (page) => {
        await new Promise((resolve) => setTimeout(resolve, 120))
        observations.push(await readAnimationState(page))
      },
    })
    services.push(service)

    const analysis = await service.analyze(`${fixture.origin}/analysis-animation-capture`)
    expect(analysis.domEvidence.map(({ label }) => label)).toEqual([
      'CSS animated search',
      'Web animated search',
      'Stable capture search',
    ])
    expect(observations).toHaveLength(3)
    const initial = observations[0]
    expect(initial.times).toHaveLength(2)
    expect(observations.every(({ times }) => times.every((time, index) =>
      Math.abs(time - initial.times[index]) < 1))).toBe(true)
    expect(observations.every(({ opacities }) => opacities.every((opacity, index) =>
      Math.abs(opacity - initial.opacities[index]) < 0.001))).toBe(true)

    const session = internalSession(service, analysis.sessionId)
    expect(await session.cdp.send('Animation.getPlaybackRate')).toMatchObject({ playbackRate: 1 })
    const resumedAt = await readAnimationState(session.page)
    await new Promise((resolve) => setTimeout(resolve, 120))
    const resumedLater = await readAnimationState(session.page)
    expect(resumedLater.times.some((time, index) => time > resumedAt.times[index] + 20)).toBe(true)

    const search = analysis.capabilities.find(({ name }) => name === 'prepare_page_search')!
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      search.name,
      { query: 'nested animation capture' },
      undefined,
      search.id,
    )).resolves.toMatchObject({ structuredContent: { targetStateVerified: true } })
    const nestedObservations = observations.slice(3)
    expect(nestedObservations).toHaveLength(3)
    const nestedInitial = nestedObservations[0]
    expect(nestedObservations.every(({ times }) => times.every((time, index) =>
      Math.abs(time - nestedInitial.times[index]) < 1))).toBe(true)
    expect(nestedObservations.every(({ opacities }) => opacities.every((opacity, index) =>
      Math.abs(opacity - nestedInitial.opacities[index]) < 0.001))).toBe(true)
    expect(await session.cdp.send('Animation.getPlaybackRate')).toMatchObject({ playbackRate: 1 })
  }, 15_000)

  it('restores a late animation-pause acquisition after a pre-action abort', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService()
    services.push(service)
    const analysis = await service.analyze(`${fixture.origin}/paint-evidence-contract`)
    const search = analysis.capabilities.find(({ name }) => name === 'prepare_page_search')!
    const session = internalSession(service, analysis.sessionId)
    const originalSend = session.cdp.send.bind(session.cdp) as (
      method: string,
      params?: Record<string, unknown>,
    ) => Promise<unknown>
    let releaseAcquire!: () => void
    let acquireReached!: () => void
    const stalledAcquire = new Promise<void>((resolve) => { releaseAcquire = resolve })
    const reachedAcquire = new Promise<void>((resolve) => { acquireReached = resolve })
    let delayNextPause = true
    ;(session.cdp as unknown as { send: typeof originalSend }).send = async (method, params) => {
      if (
        delayNextPause
        && method === 'Animation.setPlaybackRate'
        && params?.playbackRate === 0
      ) {
        delayNextPause = false
        acquireReached()
        await stalledAcquire
      }
      return originalSend(method, params)
    }

    const controller = new AbortController()
    const pending = service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      search.name,
      { query: 'aborted before pause acquisition' },
      controller.signal,
      search.id,
    )
    await reachedAcquire
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    let reuseSettled = false
    const reuse = service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      search.name,
      { query: 'usable while late cleanup is pending' },
      undefined,
      search.id,
    ).finally(() => { reuseSettled = true })
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(reuseSettled).toBe(false)
    releaseAcquire()
    await expect(reuse).resolves.toMatchObject({ structuredContent: { targetStateVerified: true } })
    await expect(originalSend('Animation.getPlaybackRate')).resolves.toMatchObject({ playbackRate: 1 })
    expect(internalServiceState(service)).toEqual({ sessions: 1, reservations: 0 })
  })

  it('normalizes Unicode safety evidence identically and fails closed on late disguised terms', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService()
    services.push(service)
    let analysis = await service.analyze(`${fixture.origin}/unicode-safety-normalization`)

    expect(analysis.domEvidence.filter(({ sensitive }) => sensitive)).toHaveLength(2)
    expect(analysis.capabilities.filter(({ kind }) => kind === 'prepare_form')).toHaveLength(2)
    const safeForm = analysis.capabilities.find(({ name }) => name === 'prepare_visible_form')!
    const page = internalSession(service, analysis.sessionId).page

    await page.locator('#unicode-late-input').evaluate((input) => {
      input.setAttribute('aria-label', 'Credit ca\u200Brd number')
    })
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      safeForm.name,
      safeForm.sampleInput,
      undefined,
      safeForm.id,
    )).rejects.toMatchObject({ code: 'invalid_action', sessionInvalidated: false })
    expect(await page.locator('#unicode-late-input').inputValue()).toBe('')

    await page.locator('#unicode-late-input').evaluate((input) => {
      input.setAttribute('aria-label', 'Überblick Referenz')
    })
    const safeResult = await service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      safeForm.name,
      safeForm.sampleInput,
      undefined,
      safeForm.id,
    )
    expect(safeResult.structuredContent.targetStateVerified).toBe(true)
    analysis = safeResult.analysis

    const eventFreeService = createService()
    services.push(eventFreeService)
    const eventFreeAnalysis = await eventFreeService.analyze(`${fixture.origin}/unicode-safety-normalization`)
    const eventFreeForm = eventFreeAnalysis.capabilities.find(({ name }) => name === 'prepare_visible_form_2')!
    await expect(eventFreeService.execute(
      eventFreeAnalysis.sessionId,
      eventFreeAnalysis.sessionToken,
      eventFreeForm.name,
      eventFreeForm.sampleInput,
      undefined,
      eventFreeForm.id,
    )).resolves.toMatchObject({ structuredContent: { targetStateVerified: true } })
    expect(await internalSession(eventFreeService, eventFreeAnalysis.sessionId).page
      .locator('#unicode-race-input').getAttribute('aria-label')).toBe('ASCII reference')
    expect(internalServiceState(eventFreeService)).toEqual({ sessions: 1, reservations: 0 })
  })

  it('classifies normalized bank-account evidence without matching neutral word substrings', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService()
    services.push(service)
    let analysis = await service.analyze(`${fixture.origin}/financial-field-safety`)
    const page = internalSession(service, analysis.sessionId).page

    expect(analysis.domEvidence.find(({ label }) => label.includes('I\u200bBAN'))).toMatchObject({ sensitive: true })
    expect(analysis.domEvidence.find(({ label }) => label === 'ＢＩＣ')).toMatchObject({ sensitive: true })
    expect(analysis.domEvidence.find(({ label }) => label === 'Bicycle reference')).toMatchObject({ sensitive: false })
    expect(analysis.domEvidence.find(({ label }) => label === 'Urban planning note')).toMatchObject({ sensitive: false })
    expect(analysis.capabilities.filter(({ kind }) => kind === 'prepare_form')).toHaveLength(2)

    const lateEvidenceId = analysis.domEvidence.find(({ label }) => label === 'Project reference')!.id
    const lateForm = analysis.capabilities.find(({ evidenceIds }) => evidenceIds.includes(lateEvidenceId))!
    await page.locator('#late-bank-one').evaluate((input) => {
      input.setAttribute('aria-label', 'I\u200bBAN')
    })
    await page.locator('#late-bank-two').evaluate((input) => {
      input.setAttribute('aria-label', 'ＢＩＣ')
    })
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      lateForm.name,
      lateForm.sampleInput,
      undefined,
      lateForm.id,
    )).rejects.toMatchObject({ code: 'invalid_action', sessionInvalidated: false })
    expect(await page.locator('#late-bank-one').inputValue()).toBe('')
    expect(await page.locator('#late-bank-two').inputValue()).toBe('')

    await page.locator('#late-bank-one').evaluate((input) => {
      input.setAttribute('aria-label', 'Project reference')
    })
    await page.locator('#late-bank-two').evaluate((input) => {
      input.setAttribute('aria-label', 'Project note')
    })
    const lateResult = await service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      lateForm.name,
      lateForm.sampleInput,
      undefined,
      lateForm.id,
    )
    expect(lateResult.structuredContent.targetStateVerified).toBe(true)
    analysis = lateResult.analysis

    const neutralEvidenceId = analysis.domEvidence.find(({ label }) => label === 'Bicycle reference')!.id
    const neutralForm = analysis.capabilities.find(({ evidenceIds }) => evidenceIds.includes(neutralEvidenceId))!
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      neutralForm.name,
      neutralForm.sampleInput,
      undefined,
      neutralForm.id,
    )).resolves.toMatchObject({ structuredContent: { targetStateVerified: true } })
  })

  it('binds the private document title into field safety classification and action-time evidence', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)

    const paymentService = createService()
    services.push(paymentService)
    const paymentAnalysis = await paymentService.analyze(`${fixture.origin}/document-title-sensitive`)
    expect(paymentAnalysis.domEvidence.filter(({ tag }) => tag === 'input')).toEqual([
      expect.objectContaining({ label: 'Project reference', sensitive: true }),
      expect.objectContaining({ label: 'Project note', sensitive: true }),
    ])
    expect(paymentAnalysis.capabilities.some(({ kind }) => kind === 'prepare_form')).toBe(false)
    const safeNavigation = paymentAnalysis.capabilities.find(({ kind }) => kind === 'navigation')!
    expect(safeNavigation).toBeDefined()
    expect(JSON.stringify({
      capabilities: paymentAnalysis.capabilities,
      domEvidence: paymentAnalysis.domEvidence,
    })).not.toContain('Payment details')
    await expect(paymentService.execute(
      paymentAnalysis.sessionId,
      paymentAnalysis.sessionToken,
      safeNavigation.name,
      safeNavigation.sampleInput,
      undefined,
      safeNavigation.id,
    )).resolves.toMatchObject({ structuredContent: { targetStateVerified: true } })

    const neutralService = createService()
    services.push(neutralService)
    const analysis = await neutralService.analyze(`${fixture.origin}/document-title-neutral`)
    const page = internalSession(neutralService, analysis.sessionId).page
    const form = analysis.capabilities.find(({ kind }) => kind === 'prepare_form')!
    expect(form).toBeDefined()
    expect(JSON.stringify(form)).not.toContain('Project workspace')

    await page.evaluate(() => { document.title = 'Payment details' })
    await expect(neutralService.execute(
      analysis.sessionId,
      analysis.sessionToken,
      form.name,
      form.sampleInput,
      undefined,
      form.id,
    )).rejects.toMatchObject({ code: 'invalid_action', sessionInvalidated: false })
    expect(await page.locator('#neutral-title-one').inputValue()).toBe('')
    expect(await page.locator('#neutral-title-two').inputValue()).toBe('')

    await page.evaluate(() => { document.title = 'Project workspace' })
    await expect(neutralService.execute(
      analysis.sessionId,
      analysis.sessionToken,
      form.name,
      form.sampleInput,
      undefined,
      form.id,
    )).resolves.toMatchObject({ structuredContent: { targetStateVerified: true } })
  })

  it('blocks normalized credential-key phrases without matching neutral word boundaries', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService()
    services.push(service)
    let analysis = await service.analyze(`${fixture.origin}/credential-key-safety`)
    const page = internalSession(service, analysis.sessionId).page

    for (const label of [
      'api\u200bkey',
      'Project reference',
      'Project code',
      'privatekey',
      'Project identifier',
      'API keys',
      'Access_keys',
      'privateKeys',
    ]) {
      expect(analysis.domEvidence.find((evidence) => evidence.label === label)).toMatchObject({ sensitive: true })
    }
    for (const label of [
      'Keynote topic',
      'Private parking note',
      'Accessibility setting',
      'Monkey keys',
      'Private donkeys',
    ]) {
      expect(analysis.domEvidence.find((evidence) => evidence.label === label)).toMatchObject({ sensitive: false })
    }
    const publicPayload = JSON.stringify({
      capabilities: analysis.capabilities,
      domEvidence: analysis.domEvidence,
      axEvidence: analysis.axEvidence,
    })
    expect(publicPayload).not.toMatch(/opaque-(?:label|name|id|aria|title|api-keys|access-keys|private-keys)-secret/)

    const neutralEvidence = analysis.domEvidence.find(({ label }) => label === 'Keynote topic')!
    const neutralForm = analysis.capabilities.find(({ evidenceIds }) => evidenceIds.includes(neutralEvidence.id))!
    const neutralResult = await service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      neutralForm.name,
      neutralForm.sampleInput,
      undefined,
      neutralForm.id,
    )
    expect(neutralResult.structuredContent.targetStateVerified).toBe(true)
    analysis = neutralResult.analysis

    const lateForm = analysis.capabilities.find(({ name }) => name === 'prepare_visible_form_2')!
    await page.locator('#late-project-one').evaluate((input) => {
      input.setAttribute('aria-label', 'api\u200bkeys')
      input.setAttribute('title', 'access_keys')
    })
    await page.locator('#late-project-two').evaluate((input) => {
      input.setAttribute('name', 'privateKeys')
    })
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      lateForm.name,
      lateForm.sampleInput,
      undefined,
      lateForm.id,
    )).rejects.toMatchObject({ code: 'invalid_action', sessionInvalidated: false })
    expect(await page.locator('#late-project-one').inputValue()).toBe('')
    expect(await page.locator('#late-project-two').inputValue()).toBe('')

    await page.locator('#late-project-one').evaluate((input) => {
      input.setAttribute('aria-label', 'Project reference')
      input.removeAttribute('title')
    })
    await page.locator('#late-project-two').evaluate((input) => {
      input.setAttribute('name', 'project_note')
    })
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      lateForm.name,
      lateForm.sampleInput,
      undefined,
      lateForm.id,
    )).resolves.toMatchObject({ structuredContent: { targetStateVerified: true } })
  })

  it('classifies bounded composed accessible-name evidence and revalidates it before mutation', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService()
    services.push(service)
    let analysis = await service.analyze(`${fixture.origin}/composed-accessible-safety`)
    const page = internalSession(service, analysis.sessionId).page

    for (const label of [
      'Composed reference field',
      'Composed label field',
      'Composed image field',
      'Composed labels field',
      'Overflow composed field',
    ]) {
      expect(analysis.domEvidence.find((evidence) => evidence.label === label)).toMatchObject({ sensitive: true })
    }
    for (const label of ['Monkey', 'Private donkeys pasture']) {
      expect(analysis.domEvidence.find((evidence) => evidence.label === label)).toMatchObject({ sensitive: false })
    }

    const neutralEvidence = analysis.domEvidence.find(({ label }) => label === 'Monkey')!
    const neutralForm = analysis.capabilities.find(({ evidenceIds }) => evidenceIds.includes(neutralEvidence.id))!
    const neutralResult = await service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      neutralForm.name,
      neutralForm.sampleInput,
      undefined,
      neutralForm.id,
    )
    expect(neutralResult.structuredContent.targetStateVerified).toBe(true)
    analysis = neutralResult.analysis

    const lateEvidence = analysis.domEvidence.find(({ label }) => label === 'Late composed field')!
    const lateForm = analysis.capabilities.find(({ evidenceIds }) => evidenceIds.includes(lateEvidence.id))!
    await page.locator('#late-composed-first').evaluate((node) => { node.textContent = 'API' })
    await page.locator('#late-composed-second').evaluate((node) => { node.textContent = 'keys' })
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      lateForm.name,
      lateForm.sampleInput,
      undefined,
      lateForm.id,
    )).rejects.toMatchObject({ code: 'invalid_action', sessionInvalidated: false })
    expect(await page.locator('#late-composed-input').inputValue()).toBe('')
    expect(await page.locator('#late-composed-detail').inputValue()).toBe('')

    await page.locator('#late-composed-first').evaluate((node) => { node.textContent = 'Project' })
    await page.locator('#late-composed-second').evaluate((node) => { node.textContent = 'reference' })
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      lateForm.name,
      lateForm.sampleInput,
      undefined,
      lateForm.id,
    )).resolves.toMatchObject({ structuredContent: { targetStateVerified: true } })
  })

  it('binds aria-placeholder through direct, referenced, and owner safety evidence', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService()
    services.push(service)
    let analysis = await service.analyze(`${fixture.origin}/aria-placeholder-safety`)
    const page = internalSession(service, analysis.sessionId).page

    for (const label of [
      'Direct placeholder field',
      'Reference placeholder field',
      'Owner placeholder reference',
      'Owner placeholder detail',
      'Overflow placeholder reference',
    ]) {
      expect(analysis.domEvidence.find((evidence) => evidence.label === label)).toMatchObject({ sensitive: true })
    }
    expect(analysis.domEvidence.find(({ label }) => label === 'Neutral placeholder reference'))
      .toMatchObject({ sensitive: false })

    const neutralEvidence = analysis.domEvidence.find(({ label }) => label === 'Neutral placeholder reference')!
    const neutralForm = analysis.capabilities.find(({ evidenceIds }) => evidenceIds.includes(neutralEvidence.id))!
    const neutralResult = await service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      neutralForm.name,
      neutralForm.sampleInput,
      undefined,
      neutralForm.id,
    )
    analysis = neutralResult.analysis

    const lateEvidence = analysis.domEvidence.find(({ label }) => label === 'Late placeholder reference')!
    const lateForm = analysis.capabilities.find(({ evidenceIds }) => evidenceIds.includes(lateEvidence.id))!
    await page.locator('#late-placeholder-input').evaluate((input) =>
      input.setAttribute('aria-placeholder', 'API keys'))
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      lateForm.name,
      lateForm.sampleInput,
      undefined,
      lateForm.id,
    )).rejects.toMatchObject({ code: 'invalid_action', sessionInvalidated: false })
    expect(await page.locator('#late-placeholder-input').inputValue()).toBe('')
    expect(await page.locator('#late-placeholder-detail').inputValue()).toBe('')

    await page.locator('#late-placeholder-input').evaluate((input) =>
      input.setAttribute('aria-placeholder', 'Helpful hint'))

    const referencedEvidence = analysis.domEvidence
      .find(({ label }) => label === 'Late referenced placeholder reference')!
    const referencedForm = analysis.capabilities
      .find(({ evidenceIds }) => evidenceIds.includes(referencedEvidence.id))!
    await page.locator('#late-reference-placeholder-source').evaluate((node) =>
      node.setAttribute('aria-placeholder', 'Password'))
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      referencedForm.name,
      referencedForm.sampleInput,
      undefined,
      referencedForm.id,
    )).rejects.toMatchObject({ code: 'invalid_action', sessionInvalidated: false })
    expect(await page.locator('#late-reference-placeholder-input').inputValue()).toBe('')
    expect(await page.locator('#late-reference-placeholder-detail').inputValue()).toBe('')

    await page.locator('#late-reference-placeholder-source').evaluate((node) =>
      node.setAttribute('aria-placeholder', 'Helpful hint'))

    const ownerEvidence = analysis.domEvidence
      .find(({ label }) => label === 'Late owner placeholder reference')!
    const ownerForm = analysis.capabilities
      .find(({ evidenceIds }) => evidenceIds.includes(ownerEvidence.id))!
    await page.locator('#late-owner-placeholder-form').evaluate((form) =>
      form.setAttribute('aria-placeholder', 'API keys'))
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      ownerForm.name,
      ownerForm.sampleInput,
      undefined,
      ownerForm.id,
    )).rejects.toMatchObject({ code: 'invalid_action', sessionInvalidated: false })
    expect(await page.locator('#late-owner-placeholder-input').inputValue()).toBe('')
    expect(await page.locator('#late-owner-placeholder-detail').inputValue()).toBe('')

    await page.locator('#late-owner-placeholder-form').evaluate((form) =>
      form.setAttribute('aria-placeholder', 'Helpful hint'))
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      ownerForm.name,
      ownerForm.sampleInput,
      undefined,
      ownerForm.id,
    )).resolves.toMatchObject({ structuredContent: { targetStateVerified: true } })
  })

  it('classifies and revalidates bounded owning-form submit controls without public leakage', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService()
    services.push(service)
    let analysis = await service.analyze(`${fixture.origin}/submit-context-safety`)
    const page = internalSession(service, analysis.sessionId).page

    for (const label of [
      'Button submit reference',
      'Input submit reference',
      'Image submit reference',
      'External submit reference',
      'External image reference',
      'External input submit reference',
      'Button value reference',
      'Submit title reference',
      'Submit generated reference',
      'Submit descendant image reference',
      'Submit ARIA reference',
      'Submit action reference',
      'Overflow submit reference',
    ]) {
      const evidence = analysis.domEvidence.find((item) => item.label === label)!
      expect(evidence.sensitive).toBe(true)
      expect(analysis.capabilities.some(({ evidenceIds }) => evidenceIds.includes(evidence.id))).toBe(false)
    }
    expect(JSON.stringify(analysis.capabilities)).not.toMatch(/Pay|Payment|Checkout/)
    expect(analysis.domEvidence.some(({ type }) => ['submit', 'image'].includes(type))).toBe(false)

    const neutralEvidence = analysis.domEvidence.find(({ label }) => label === 'Neutral submit reference')!
    const neutralForm = analysis.capabilities.find(({ evidenceIds }) => evidenceIds.includes(neutralEvidence.id))!
    const neutralResult = await service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      neutralForm.name,
      neutralForm.sampleInput,
      undefined,
      neutralForm.id,
    )
    expect(neutralResult.structuredContent.targetStateVerified).toBe(true)
    analysis = neutralResult.analysis

    const lateEvidence = analysis.domEvidence.find(({ label }) => label === 'Late submit reference')!
    const lateForm = analysis.capabilities.find(({ evidenceIds }) => evidenceIds.includes(lateEvidence.id))!
    await page.locator('#late-submit-button').evaluate((button) => { button.textContent = 'Pay' })
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      lateForm.name,
      lateForm.sampleInput,
      undefined,
      lateForm.id,
    )).rejects.toMatchObject({ code: 'invalid_action', sessionInvalidated: false })
    expect(await page.locator('#late-submit-input').inputValue()).toBe('')
    expect(await page.locator('#late-submit-detail').inputValue()).toBe('')

    const actionEvidence = analysis.domEvidence.find(({ label }) => label === 'Late submit action reference')!
    const actionForm = analysis.capabilities.find(({ evidenceIds }) => evidenceIds.includes(actionEvidence.id))!
    await page.locator('#late-submit-action-button').evaluate((button) =>
      button.setAttribute('formaction', '/checkout'))
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      actionForm.name,
      actionForm.sampleInput,
      undefined,
      actionForm.id,
    )).rejects.toMatchObject({ code: 'invalid_action', sessionInvalidated: false })
    expect(await page.locator('#late-submit-action-input').inputValue()).toBe('')
    expect(await page.locator('#late-submit-action-detail').inputValue()).toBe('')

    const externalEvidence = analysis.domEvidence
      .find(({ label }) => label === 'Late external submit reference')!
    const externalForm = analysis.capabilities
      .find(({ evidenceIds }) => evidenceIds.includes(externalEvidence.id))!
    await page.locator('#late-external-submit-button').evaluate((button) =>
      button.setAttribute('form', 'late-external-submit-decoy-form'))
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      externalForm.name,
      externalForm.sampleInput,
      undefined,
      externalForm.id,
    )).rejects.toMatchObject({ code: 'invalid_action', sessionInvalidated: false })
    expect(await page.locator('#late-external-submit-input').inputValue()).toBe('')
    expect(await page.locator('#late-external-submit-detail').inputValue()).toBe('')

    await page.locator('#late-external-submit-button').evaluate((button) =>
      button.setAttribute('form', 'late-external-submit-form'))
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      externalForm.name,
      externalForm.sampleInput,
      undefined,
      externalForm.id,
    )).resolves.toMatchObject({ structuredContent: { targetStateVerified: true } })

    let raceValuesBeforeWrite: string[] = []
    const raceService = createService({
      beforeControlWrite: async (racePage) => {
        await racePage.locator('#late-submit-button').evaluate((button) => {
          button.textContent = 'Pay'
        })
        raceValuesBeforeWrite = await racePage
          .locator('#late-submit-input, #late-submit-detail')
          .evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value))
      },
    })
    services.push(raceService)
    const raceAnalysis = await raceService.analyze(`${fixture.origin}/submit-context-safety`)
    const raceEvidence = raceAnalysis.domEvidence
      .find(({ label }) => label === 'Late submit reference')!
    const raceForm = raceAnalysis.capabilities
      .find(({ evidenceIds }) => evidenceIds.includes(raceEvidence.id))!
    await expect(raceService.execute(
      raceAnalysis.sessionId,
      raceAnalysis.sessionToken,
      raceForm.name,
      raceForm.sampleInput,
      undefined,
      raceForm.id,
    )).rejects.toMatchObject({ code: 'action_failed', sessionInvalidated: true })
    expect(raceValuesBeforeWrite).toEqual(['', ''])
    expect(internalServiceState(raceService)).toEqual({ sessions: 0, reservations: 0 })
  })

  it('blocks normalized credential-code phrases without matching neutral word boundaries', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService()
    services.push(service)
    let analysis = await service.analyze(`${fixture.origin}/credential-code-safety`)
    const page = internalSession(service, analysis.sessionId).page

    for (const label of [
      'P\u200bIN',
      'O\u200bTP',
      'Project reference',
      'Verification_codes',
      'Pass\u200bcode',
      'Project access',
      'Project token',
      'One-time_codes',
    ]) {
      expect(analysis.domEvidence.find((evidence) => evidence.label === label)).toMatchObject({ sensitive: true })
    }
    for (const label of [
      'Spin setting',
      'Pinot note',
      'Verification status',
      'Code review',
      'Compass code',
      'Pass coding',
      'One time estimate',
    ]) {
      expect(analysis.domEvidence.find((evidence) => evidence.label === label)).toMatchObject({ sensitive: false })
    }
    expect(JSON.stringify({
      capabilities: analysis.capabilities,
      domEvidence: analysis.domEvidence,
      axEvidence: analysis.axEvidence,
    })).not.toMatch(/opaque-(?:alpha-111|beta-222|gamma-333|delta-444|epsilon-555|zeta-666|eta-777|theta-888)/)

    const neutralEvidence = analysis.domEvidence.find(({ label }) => label === 'Spin setting')!
    const neutralForm = analysis.capabilities.find(({ evidenceIds }) => evidenceIds.includes(neutralEvidence.id))!
    const neutralResult = await service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      neutralForm.name,
      neutralForm.sampleInput,
      undefined,
      neutralForm.id,
    )
    expect(neutralResult.structuredContent.targetStateVerified).toBe(true)
    analysis = neutralResult.analysis

    const lateEvidence = analysis.domEvidence.find(({ label }) => label === 'Late project reference')!
    const lateForm = analysis.capabilities.find(({ evidenceIds }) => evidenceIds.includes(lateEvidence.id))!
    await page.locator('#late-code-one').evaluate((input) => {
      input.setAttribute('aria-label', 'Pass\u200bcode')
    })
    await page.locator('#late-code-two').evaluate((input) => {
      input.setAttribute('name', 'oneTimeCode')
    })
    await page.locator('#late-code-label').evaluate((label) => {
      label.firstChild!.textContent = 'One-time codes'
    })
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      lateForm.name,
      lateForm.sampleInput,
      undefined,
      lateForm.id,
    )).rejects.toMatchObject({ code: 'invalid_action', sessionInvalidated: false })
    expect(await page.locator('#late-code-one').inputValue()).toBe('')
    expect(await page.locator('#late-code-two').inputValue()).toBe('')
    expect(await page.locator('#late-code-three').inputValue()).toBe('')

    await page.locator('#late-code-one').evaluate((input) => {
      input.setAttribute('aria-label', 'Late project reference')
    })
    await page.locator('#late-code-two').evaluate((input) => {
      input.setAttribute('name', 'project_note')
    })
    await page.locator('#late-code-label').evaluate((label) => {
      label.firstChild!.textContent = 'Late project code'
    })
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      lateForm.name,
      lateForm.sampleInput,
      undefined,
      lateForm.id,
    )).resolves.toMatchObject({ structuredContent: { targetStateVerified: true } })
  })

  it('classifies normalized card-verification tokens without matching neutral word substrings', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService()
    services.push(service)
    let analysis = await service.analyze(`${fixture.origin}/card-verification-field-safety`)
    const page = internalSession(service, analysis.sessionId).page

    expect(analysis.domEvidence.find(({ label }) => label.includes('C\u200bVV'))).toMatchObject({ sensitive: true })
    expect(analysis.domEvidence.find(({ label }) => label === 'ＣＶＣ')).toMatchObject({ sensitive: true })
    expect(analysis.domEvidence.find(({ label }) => label === 'CVValue reference')).toMatchObject({ sensitive: false })
    expect(analysis.domEvidence.find(({ label }) => label === 'CVCustom note')).toMatchObject({ sensitive: false })
    expect(analysis.capabilities.filter(({ kind }) => kind === 'prepare_form')).toHaveLength(2)

    const lateEvidenceId = analysis.domEvidence.find(({ label }) => label === 'Project reference')!.id
    const lateForm = analysis.capabilities.find(({ evidenceIds }) => evidenceIds.includes(lateEvidenceId))!
    await page.locator('#late-verification-one').evaluate((input) => {
      input.setAttribute('aria-label', 'C\u200bVV')
    })
    await page.locator('#late-verification-two').evaluate((input) => {
      input.setAttribute('aria-label', 'ＣＶＣ')
    })
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      lateForm.name,
      lateForm.sampleInput,
      undefined,
      lateForm.id,
    )).rejects.toMatchObject({ code: 'invalid_action', sessionInvalidated: false })
    expect(await page.locator('#late-verification-one').inputValue()).toBe('')
    expect(await page.locator('#late-verification-two').inputValue()).toBe('')

    await page.locator('#late-verification-one').evaluate((input) => {
      input.setAttribute('aria-label', 'Project reference')
    })
    await page.locator('#late-verification-two').evaluate((input) => {
      input.setAttribute('aria-label', 'Project note')
    })
    const lateResult = await service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      lateForm.name,
      lateForm.sampleInput,
      undefined,
      lateForm.id,
    )
    expect(lateResult.structuredContent.targetStateVerified).toBe(true)
    analysis = lateResult.analysis

    const neutralEvidenceId = analysis.domEvidence.find(({ label }) => label === 'CVValue reference')!.id
    const neutralForm = analysis.capabilities.find(({ evidenceIds }) => evidenceIds.includes(neutralEvidenceId))!
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      neutralForm.name,
      neutralForm.sampleInput,
      undefined,
      neutralForm.id,
    )).resolves.toMatchObject({ structuredContent: { targetStateVerified: true } })
  })

  it('maps only effectively visible select options and rejects late hiding before mutation', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService()
    services.push(service)
    let analysis = await service.analyze(`${fixture.origin}/visible-select-options`)
    const filter = analysis.capabilities.find(({ name }) => name === 'set_page_filter')!
    const form = analysis.capabilities.find(({ name }) => name === 'prepare_visible_form')!

    expect(filter.inputSchema).toMatchObject({
      properties: { optionIndex: { minimum: 0, maximum: 1 } },
    })
    expect(filter.sampleInput).toEqual({ optionIndex: 1 })
    expect(form.inputSchema).toMatchObject({
      properties: { field_1: { minimum: 0, maximum: 1 } },
    })
    expect(form.sampleInput).toEqual({ field_1: 1, field_2: 'A' })

    const filterResult = await service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      filter.name,
      filter.sampleInput,
      undefined,
      filter.id,
    )
    expect(filterResult.analysis.title).toBe('Visible select options')
    analysis = filterResult.analysis
    const currentForm = analysis.capabilities.find(({ name }) => name === 'prepare_visible_form')!
    const formResult = await service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      currentForm.name,
      currentForm.sampleInput,
      undefined,
      currentForm.id,
    )
    expect(formResult.structuredContent.targetStateVerified).toBe(true)
    expect(await internalSession(service, analysis.sessionId).page.locator('#visible-form-select').evaluate(
      (select) => (select as HTMLSelectElement).selectedIndex,
    )).toBe(3)

    const lateService = createService()
    services.push(lateService)
    const lateAnalysis = await lateService.analyze(`${fixture.origin}/visible-select-options`)
    const lateFilter = lateAnalysis.capabilities.find(({ name }) => name === 'set_page_filter')!
    const latePage = internalSession(lateService, lateAnalysis.sessionId).page
    await latePage.locator('#visible-filter-two').evaluate((option) => {
      ;(option as HTMLOptionElement).hidden = true
    })
    await expect(lateService.execute(
      lateAnalysis.sessionId,
      lateAnalysis.sessionToken,
      lateFilter.name,
      lateFilter.sampleInput,
      undefined,
      lateFilter.id,
    )).rejects.toMatchObject({ code: 'invalid_action', sessionInvalidated: false })
    expect(await latePage.locator('#visible-options-filter').evaluate(
      (select) => (select as HTMLSelectElement).selectedIndex,
    )).toBe(0)

    await latePage.locator('#visible-filter-two').evaluate((option) => {
      ;(option as HTMLOptionElement).hidden = false
    })
    await expect(lateService.execute(
      lateAnalysis.sessionId,
      lateAnalysis.sessionToken,
      lateFilter.name,
      lateFilter.sampleInput,
      undefined,
      lateFilter.id,
    )).resolves.toMatchObject({ structuredContent: { targetStateVerified: true } })
  })

  it('keeps native text contracts aligned for schema, samples, Unicode, and pre-action validation', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService()
    services.push(service)
    let analysis = await service.analyze(`${fixture.origin}/text-contracts`)

    expect(analysis.capabilities.filter(({ kind }) => kind === 'prepare_form')).toHaveLength(2)
    const bounded = analysis.capabilities.find(({ name }) => name === 'prepare_visible_form')!
    expect(bounded.inputSchema).toMatchObject({
      properties: {
        field_1: { type: 'string', maxLength: 1 },
        field_2: { type: 'string', minLength: 2, maxLength: 2 },
      },
    })
    expect(bounded.sampleInput).toEqual({ field_1: 'A', field_2: 'AA' })
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      bounded.name,
      { field_1: '🙂🙂' },
      undefined,
      bounded.id,
    )).rejects.toMatchObject({ code: 'invalid_action', status: 400, sessionInvalidated: false })
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      bounded.name,
      { field_2: '🙂' },
      undefined,
      bounded.id,
    )).rejects.toMatchObject({ code: 'invalid_action', status: 400, sessionInvalidated: false })

    const prepared = await service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      bounded.name,
      bounded.sampleInput,
      undefined,
      bounded.id,
    )
    expect(prepared.structuredContent).toMatchObject({
      isolatedStateChanged: true,
      targetStateVerified: true,
    })
    analysis = prepared.analysis
    const boundedAgain = analysis.capabilities.find(({ name }) => name === 'prepare_visible_form')!
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      boundedAgain.name,
      { field_1: '🙂' },
      undefined,
      boundedAgain.id,
    )).resolves.toMatchObject({
      structuredContent: { isolatedStateChanged: true, targetStateVerified: true },
    })

    expect(analysis.domEvidence.find(({ label }) => label === 'Tiny value')).toMatchObject({ sensitive: false })
    expect(analysis.domEvidence.find(({ label }) => label === 'Pattern value')).toMatchObject({ sensitive: false })
  })

  it('applies native required as the effective text minimum and revalidates late mutation', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService()
    services.push(service)
    let analysis = await service.analyze(`${fixture.origin}/required-text-contracts`)
    const requiredForm = analysis.capabilities.find(({ name }) => name === 'prepare_visible_form')!

    expect(requiredForm.inputSchema).toMatchObject({
      properties: {
        field_1: { type: 'string', minLength: 1 },
        field_2: { type: 'string', minLength: 1 },
      },
    })
    expect(requiredForm.sampleInput).toEqual({ field_1: 'A', field_2: 'A' })
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      requiredForm.name,
      { field_1: '' },
      undefined,
      requiredForm.id,
    )).rejects.toMatchObject({ code: 'invalid_action', status: 400, sessionInvalidated: false })
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      requiredForm.name,
      { field_2: '' },
      undefined,
      requiredForm.id,
    )).rejects.toMatchObject({ code: 'invalid_action', status: 400, sessionInvalidated: false })

    const requiredResult = await service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      requiredForm.name,
      requiredForm.sampleInput,
      undefined,
      requiredForm.id,
    )
    expect(requiredResult.structuredContent.targetStateVerified).toBe(true)
    analysis = requiredResult.analysis

    const lateForm = analysis.capabilities.find(({ name }) => name === 'prepare_visible_form_2')!
    expect(lateForm.inputSchema).toMatchObject({
      properties: { field_1: { type: 'string', maxLength: 200 } },
    })
    expect((lateForm.inputSchema.properties as Record<string, Record<string, unknown>>).field_1)
      .not.toHaveProperty('minLength')
    const page = internalSession(service, analysis.sessionId).page
    await page.locator('#late-required-input').evaluate((input) => {
      (input as HTMLInputElement).required = true
    })
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      lateForm.name,
      lateForm.sampleInput,
      undefined,
      lateForm.id,
    )).rejects.toMatchObject({ code: 'invalid_action', sessionInvalidated: false })
    expect(await page.locator('#late-required-input').inputValue()).toBe('')

    await page.locator('#late-required-input').evaluate((input) => {
      (input as HTMLInputElement).required = false
    })
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      lateForm.name,
      lateForm.sampleInput,
      undefined,
      lateForm.id,
    )).resolves.toMatchObject({ structuredContent: { targetStateVerified: true } })
  })

  it('keeps direct ARIA required text and single-select contracts aligned end to end', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService()
    services.push(service)
    let analysis = await service.analyze(`${fixture.origin}/aria-required-contracts`)
    const page = internalSession(service, analysis.sessionId).page
    const capabilityFor = (label: string) => {
      const evidenceId = analysis.domEvidence.find((evidence) => evidence.label === label)!.id
      return analysis.capabilities.find(({ evidenceIds }) => evidenceIds.includes(evidenceId))
    }

    const textForm = capabilityFor('ARIA required text')!
    expect(textForm.inputSchema).toMatchObject({
      properties: {
        field_1: { type: 'string', minLength: 1 },
        field_2: { type: 'string', minLength: 1 },
      },
    })
    expect(textForm.sampleInput).toEqual({ field_1: 'A', field_2: 'A' })
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      textForm.name,
      { ...textForm.sampleInput, field_1: '' },
      undefined,
      textForm.id,
    )).rejects.toMatchObject({ code: 'invalid_action', status: 400, sessionInvalidated: false })
    expect(await page.locator('#aria-required-text').inputValue()).toBe('')

    const textResult = await service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      textForm.name,
      textForm.sampleInput,
      undefined,
      textForm.id,
    )
    expect(textResult.structuredContent).toMatchObject({ isolatedStateChanged: true, targetStateVerified: true })
    analysis = textResult.analysis

    const selectForm = capabilityFor('ARIA required choice')!
    expect(selectForm.inputSchema).toMatchObject({
      properties: {
        field_1: { type: 'integer', minimum: 0, maximum: 1 },
        field_2: { type: 'string' },
      },
    })
    expect(selectForm.sampleInput.field_1).toBe(0)
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      selectForm.name,
      { ...selectForm.sampleInput, field_1: 2 },
      undefined,
      selectForm.id,
    )).rejects.toMatchObject({ code: 'invalid_action', status: 400, sessionInvalidated: false })
    expect(await page.locator('#aria-required-select').inputValue()).toBe('')
    const selectResult = await service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      selectForm.name,
      selectForm.sampleInput,
      undefined,
      selectForm.id,
    )
    expect(selectResult.structuredContent.targetStateVerified).toBe(true)
    expect(await page.locator('#aria-required-select').inputValue()).toBe('one')
    analysis = selectResult.analysis

    expect(capabilityFor('ARIA required only empty')).toBeUndefined()
    const optionalForm = capabilityFor('ARIA optional choice')!
    expect(optionalForm.inputSchema).toMatchObject({
      properties: { field_1: { type: 'integer', minimum: 0, maximum: 1 } },
    })
    expect((optionalForm.inputSchema.properties as Record<string, Record<string, unknown>>).field_2)
      .not.toHaveProperty('minLength')

    const lateTextForm = capabilityFor('Late ARIA required text')!
    await page.locator('#late-aria-required-text').evaluate((input) =>
      input.setAttribute('aria-required', 'true'))
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      lateTextForm.name,
      lateTextForm.sampleInput,
      undefined,
      lateTextForm.id,
    )).rejects.toMatchObject({ code: 'invalid_action', sessionInvalidated: false })
    expect(await page.locator('#late-aria-required-text').inputValue()).toBe('')
    expect(await page.locator('#late-aria-required-text-detail').inputValue()).toBe('')
    await page.locator('#late-aria-required-text').evaluate((input) =>
      input.removeAttribute('aria-required'))
    const restored = await service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      lateTextForm.name,
      lateTextForm.sampleInput,
      undefined,
      lateTextForm.id,
    )
    expect(restored.structuredContent.targetStateVerified).toBe(true)
    analysis = restored.analysis

    const lateSelectForm = capabilityFor('Late ARIA required choice')!
    await page.locator('#late-aria-required-select').evaluate((select) =>
      select.setAttribute('aria-required', 'true'))
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      lateSelectForm.name,
      lateSelectForm.sampleInput,
      undefined,
      lateSelectForm.id,
    )).rejects.toMatchObject({ code: 'invalid_action', sessionInvalidated: false })
    expect(await page.locator('#late-aria-required-select').inputValue()).toBe('')
    expect(await page.locator('#late-aria-required-select-detail').inputValue()).toBe('')
  })

  it('excludes native-pattern fields and rejects a pattern added after analysis before mutation', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService()
    services.push(service)
    const analysis = await service.analyze(`${fixture.origin}/text-contracts`)
    const latePatternForm = analysis.capabilities.find(({ name }) => name === 'prepare_visible_form_2')!
    const page = internalSession(service, analysis.sessionId).page

    expect(Object.keys((latePatternForm.inputSchema.properties ?? {}) as object)).toEqual(['field_1', 'field_2'])
    expect(analysis.capabilities.some(({ evidenceIds }) => evidenceIds.some((id) =>
      analysis.domEvidence.find((evidence) => evidence.id === id)?.label === 'Pattern value'))).toBe(false)

    await page.locator('#late-pattern').evaluate((input) => input.setAttribute('pattern', '[0-9]+'))
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      latePatternForm.name,
      { field_1: 'A' },
      undefined,
      latePatternForm.id,
    )).rejects.toMatchObject({ code: 'invalid_action', status: 409, sessionInvalidated: false })
    expect(await page.locator('#late-pattern').inputValue()).toBe('')

    await page.locator('#late-pattern').evaluate((input) => input.removeAttribute('pattern'))
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      latePatternForm.name,
      { field_1: 'A' },
      undefined,
      latePatternForm.id,
    )).resolves.toMatchObject({
      structuredContent: { isolatedStateChanged: true, targetStateVerified: true },
    })
  })

  it('classifies and revalidates bounded CSS-generated accessible evidence', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService()
    services.push(service)
    const analysis = await service.analyze(`${fixture.origin}/generated-accessible-safety`)
    const labels = analysis.domEvidence.map(({ label, sensitive }) => ({ label, sensitive }))
    expect(labels).toContainEqual({ label: 'Safe generated search', sensitive: true })
    expect(labels).toContainEqual({ label: 'Neutral generated search', sensitive: false })
    expect(labels).toContainEqual({ label: 'Late generated search', sensitive: false })
    expect(labels).toContainEqual({ label: 'Overflow generated search', sensitive: true })
    expect(analysis.capabilities.some(({ evidenceIds }) => evidenceIds.some((id) =>
      analysis.domEvidence.find((item) => item.id === id)?.label === 'Safe generated search'))).toBe(false)

    const lateSearch = analysis.capabilities.find(({ evidenceIds }) => evidenceIds.some((id) =>
      analysis.domEvidence.find((item) => item.id === id)?.label === 'Late generated search'))!
    const page = internalSession(service, analysis.sessionId).page
    await page.locator('#late-generated-label').evaluate((label) => label.classList.add('hostile'))
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      lateSearch.name,
      { query: 'must-not-apply' },
      undefined,
      lateSearch.id,
    )).rejects.toMatchObject({ code: 'invalid_action', sessionInvalidated: false })
    expect(await page.locator('#late-generated').inputValue()).toBe('')
  })

  it('samples a different checked radio choice and excludes a single-choice group', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService()
    services.push(service)
    let analysis = await service.analyze(`${fixture.origin}/checked-radio-groups`)
    const forms = analysis.capabilities.filter(({ kind }) => kind === 'prepare_form')
    expect(forms).toHaveLength(2)

    for (let index = 0; index < forms.length; index += 1) {
      const form = analysis.capabilities.find(({ name }) =>
        name === (index === 0 ? 'prepare_visible_form' : 'prepare_visible_form_2'))!
      expect(form.sampleInput).toMatchObject({ field_1: 1 })
      const result = await service.execute(
        analysis.sessionId,
        analysis.sessionToken,
        form.name,
        form.sampleInput,
        undefined,
        form.id,
      )
      expect(result.structuredContent).toMatchObject({
        isolatedStateChanged: true,
        targetStateVerified: true,
      })
      analysis = result.analysis
    }

    const page = internalSession(service, analysis.sessionId).page
    expect(await page.locator('#first-a, #first-b, #second-a, #second-b').evaluateAll(
      (radios) => radios.map((radio) => (radio as HTMLInputElement).checked),
    )).toEqual([false, true, false, true])
    expect(analysis.capabilities.some(({ evidenceIds }) => evidenceIds.some((id) =>
      analysis.domEvidence.find((evidence) => evidence.id === id)?.label === 'Single choice'))).toBe(false)
  })

  it('offers radio groups only when every native same-owner member is safely bound and revalidated', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService()
    services.push(service)
    const analysis = await service.analyze(`${fixture.origin}/radio-native-groups`)
    const forms = analysis.capabilities.filter(({ kind }) => kind === 'prepare_form')
    expect(forms).toHaveLength(1)
    const form = forms[0]
    expect(form.sampleInput).toMatchObject({ field_1: 1 })
    const advertisedLabels = form.evidenceIds.map((id) =>
      analysis.domEvidence.find((evidence) => evidence.id === id)?.label)
    expect(advertisedLabels).toEqual(['Safe A', 'Safe B', 'Safe radio detail'])
    expect(analysis.domEvidence.find(({ label }) => label === 'sensitive_mode')).toMatchObject({ sensitive: true })

    const page = internalSession(service, analysis.sessionId).page
    await page.locator('#safe-radio-form').evaluate((owner) => {
      const hidden = document.createElement('input')
      hidden.id = 'late-hidden-radio'
      hidden.type = 'radio'
      hidden.name = 'safe_mode'
      hidden.hidden = true
      owner.append(hidden)
    })
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      form.name,
      form.sampleInput,
      undefined,
      form.id,
    )).rejects.toMatchObject({ code: 'invalid_action', sessionInvalidated: false })
    expect(await page.locator('#safe-radio-a, #safe-radio-b').evaluateAll(
      (radios) => radios.map((radio) => (radio as HTMLInputElement).checked),
    )).toEqual([true, false])

    await page.locator('#late-hidden-radio').evaluate((radio) => radio.remove())
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      form.name,
      form.sampleInput,
      undefined,
      form.id,
    )).resolves.toMatchObject({ structuredContent: { targetStateVerified: true } })
    expect(await page.locator('#safe-radio-a, #safe-radio-b').evaluateAll(
      (radios) => radios.map((radio) => (radio as HTMLInputElement).checked),
    )).toEqual([false, true])

    const raceService = createService({ actionStartDelayMs: 150 })
    services.push(raceService)
    const raceAnalysis = await raceService.analyze(`${fixture.origin}/radio-native-groups`)
    const raceForm = raceAnalysis.capabilities.find(({ name }) => name === 'prepare_visible_form')!
    const racePage = internalSession(raceService, raceAnalysis.sessionId).page
    let radioMutations = 0
    await racePage.exposeFunction('recordRadioMutation', () => { radioMutations += 1 })
    await racePage.locator('#safe-radio-a, #safe-radio-b').evaluateAll((radios) => {
      for (const radio of radios) {
        radio.addEventListener('change', () => {
          void (window as unknown as { recordRadioMutation: () => Promise<void> }).recordRadioMutation()
        })
      }
    })
    const pending = raceService.execute(
      raceAnalysis.sessionId,
      raceAnalysis.sessionToken,
      raceForm.name,
      raceForm.sampleInput,
      undefined,
      raceForm.id,
    )
    await new Promise((resolve) => setTimeout(resolve, 40))
    await racePage.locator('#safe-radio-form').evaluate((owner) => {
      const hidden = document.createElement('input')
      hidden.type = 'radio'
      hidden.name = 'safe_mode'
      hidden.hidden = true
      owner.append(hidden)
    })
    await expect(pending).rejects.toMatchObject({ code: 'action_failed', sessionInvalidated: true })
    expect(radioMutations).toBe(0)
    expect(internalServiceState(raceService)).toEqual({ sessions: 0, reservations: 0 })
  })

  it('revalidates every radio sibling atomically before changing the exclusive choice', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    let mutationHookCalls = 0
    const service = createService({
      beforeRadioGroupWrite: async (page) => {
        mutationHookCalls += 1
        await page.locator('label[for="first-a"]').evaluate((label) => {
          label.textContent = 'Credit card number'
        })
      },
    })
    services.push(service)
    const analysis = await service.analyze(`${fixture.origin}/checked-radio-groups`)
    const form = analysis.capabilities.find(({ name }) => name === 'prepare_visible_form')!
    const page = internalSession(service, analysis.sessionId).page
    let changeEvents = 0
    await page.exposeFunction('recordAtomicRadioChange', () => { changeEvents += 1 })
    await page.locator('#first-a, #first-b').evaluateAll((radios) => {
      for (const radio of radios) {
        radio.addEventListener('change', () => {
          void (window as unknown as { recordAtomicRadioChange(): Promise<void> }).recordAtomicRadioChange()
        })
      }
    })

    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      form.name,
      form.sampleInput,
      undefined,
      form.id,
    )).rejects.toMatchObject({ code: 'action_failed', sessionInvalidated: true })
    expect(mutationHookCalls).toBe(1)
    expect(changeEvents).toBe(0)
    expect(internalServiceState(service)).toEqual({ sessions: 0, reservations: 0 })

    const stateDriftService = createService({
      beforeRadioGroupWrite: async (page) => {
        await page.locator('#first-a, #first-b').evaluateAll((radios) => {
          ;(radios[0] as HTMLInputElement).checked = false
          ;(radios[1] as HTMLInputElement).checked = true
        })
      },
    })
    services.push(stateDriftService)
    const stateDriftAnalysis = await stateDriftService.analyze(`${fixture.origin}/checked-radio-groups`)
    const stateDriftForm = stateDriftAnalysis.capabilities.find(({ name }) => name === 'prepare_visible_form')!
    await expect(stateDriftService.execute(
      stateDriftAnalysis.sessionId,
      stateDriftAnalysis.sessionToken,
      stateDriftForm.name,
      stateDriftForm.sampleInput,
      undefined,
      stateDriftForm.id,
    )).rejects.toMatchObject({ code: 'action_failed', sessionInvalidated: true })
    expect(internalServiceState(stateDriftService)).toEqual({ sessions: 0, reservations: 0 })
  })

  it('revalidates page-authored safety evidence before read, write, and verification', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService()
    services.push(service)
    const analysis = await service.analyze(`${fixture.origin}/`)
    const search = analysis.capabilities.find(({ name }) => name === 'prepare_page_search')!
    const filter = analysis.capabilities.find(({ name }) => name === 'set_page_filter')!
    const navigation = analysis.capabilities.find(({ name }) => name === 'open_page_link')!
    const page = internalSession(service, analysis.sessionId).page

    const searchMutations = [
      { attribute: 'aria-label', value: 'Credit card', original: 'Search catalog' },
      { attribute: 'autocomplete', value: 'current-password', original: null },
      { attribute: 'name', value: 'userPassword', original: 'search_term' },
      { attribute: 'id', value: 'creditCard', original: null },
      { attribute: 'title', value: 'Credit card number', original: null },
      { attribute: 'pattern', value: '[0-9]+', original: null },
    ]
    for (const mutation of searchMutations) {
      await page.locator('[type=search]').evaluate((input, current) => {
        input.setAttribute(current.attribute, current.value)
      }, mutation)
      await expect(service.execute(
        analysis.sessionId,
        analysis.sessionToken,
        search.name,
        { query: 'must not mutate' },
        undefined,
        search.id,
      )).rejects.toMatchObject({ code: 'invalid_action', sessionInvalidated: false })
      expect(await page.locator('[type=search]').inputValue()).toBe('')
      await page.locator('[type=search]').evaluate((input, current) => {
        if (current.original === null) input.removeAttribute(current.attribute)
        else input.setAttribute(current.attribute, current.original)
      }, mutation)
    }

    await page.locator('[type=search]').evaluate((input) => {
      const description = document.createElement('span')
      description.id = 'password-description'
      description.textContent = 'User password'
      document.body.append(description)
      input.setAttribute('aria-describedby', description.id)
    })
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      search.name,
      { query: 'must not describe' },
      undefined,
      search.id,
    )).rejects.toMatchObject({ code: 'invalid_action', sessionInvalidated: false })
    expect(await page.locator('[type=search]').inputValue()).toBe('')
    await page.locator('[type=search]').evaluate((input) => input.removeAttribute('aria-describedby'))

    await page.locator('select[aria-label="Category filter"] option[value="one"]').evaluate((option) => {
      option.textContent = 'Credit card'
    })
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      filter.name,
      filter.sampleInput,
      undefined,
      filter.id,
    )).rejects.toMatchObject({ code: 'invalid_action', sessionInvalidated: false })
    expect(await page.locator('select[aria-label="Category filter"]').evaluate(
      (select) => (select as HTMLSelectElement).selectedIndex,
    )).toBe(1)
    await page.locator('select[aria-label="Category filter"] option[value="one"]').evaluate((option) => {
      option.textContent = 'One'
    })

    await page.locator('a[href="/next"]').evaluate((link) => link.setAttribute('title', 'Purchase'))
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      navigation.name,
      navigation.sampleInput,
      undefined,
      navigation.id,
    )).rejects.toMatchObject({ code: 'invalid_action', sessionInvalidated: false })
    expect(fixture.requests).not.toContain('/next')
    await page.locator('a[href="/next"]').evaluate((link) => link.removeAttribute('title'))

    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      search.name,
      { query: 'safe after restore' },
      undefined,
      search.id,
    )).resolves.toMatchObject({ structuredContent: { targetStateVerified: true } })
  })

  it('does not invoke a page handler that would change safety evidence during preparation', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService()
    services.push(service)
    const analysis = await service.analyze(`${fixture.origin}/safety-race`)
    const search = analysis.capabilities.find(({ name }) => name === 'prepare_page_search')!

    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      search.name,
      { query: 'agent value' },
      undefined,
      search.id,
    )).resolves.toMatchObject({ structuredContent: { targetStateVerified: true } })
    const page = internalSession(service, analysis.sessionId).page
    expect(await page.locator('#race-search').getAttribute('aria-label')).toBe('Race search')
    expect(internalServiceState(service)).toEqual({ sessions: 1, reservations: 0 })
  })

  it('does not invoke a page handler that would disable the selected option', async () => {
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
    )).resolves.toMatchObject({ structuredContent: { targetStateVerified: true } })
    expect(await page.locator('#enabled-filter-group').evaluate((group) =>
      (group as HTMLOptGroupElement).disabled)).toBe(false)
    expect(internalServiceState(service)).toEqual({ sessions: 1, reservations: 0 })
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

  it('excludes aria-disabled controls and revalidates late ARIA operability before mutation', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService()
    services.push(service)
    const analysis = await service.analyze(`${fixture.origin}/action-operability`)
    const initialDisabled = analysis.domEvidence.find(({ label }) => label === 'Initially unavailable search')!
    expect(initialDisabled).toBeUndefined()
    expect(JSON.stringify(analysis.capabilities)).not.toContain('Initially unavailable search')

    const ariaFalse = analysis.domEvidence.find(({ label }) => label === 'ARIA false value')!
    expect(analysis.capabilities.some(({ evidenceIds }) => evidenceIds.includes(ariaFalse.id))).toBe(true)
    expect(analysis.domEvidence.find(({ label }) => label === 'Ancestor unavailable value')).toBeUndefined()
    expect(analysis.domEvidence.find(({ label }) => label === 'Ancestor unavailable link')).toBeUndefined()
    expect(analysis.domEvidence.find(({ label }) => label === 'Ancestor A')).toBeUndefined()
    const ancestorFalseLink = analysis.domEvidence.find(({ label }) => label === 'Ancestor false link')!
    const ancestorFalseNavigation = analysis.capabilities.find(({ evidenceIds }) =>
      evidenceIds.includes(ancestorFalseLink.id))!
    expect(ancestorFalseNavigation).toBeDefined()
    const ancestorSafeRadio = analysis.domEvidence.find(({ label }) => label === 'Ancestor safe A')!
    const ancestorSafeRadioForm = analysis.capabilities.find(({ evidenceIds }) =>
      evidenceIds.includes(ancestorSafeRadio.id))!
    expect(ancestorSafeRadioForm).toBeDefined()
    expect(JSON.stringify(analysis)).not.toContain('ariaDisabledAncestors')
    const enabledEvidence = analysis.domEvidence.find(({ label }) => label === 'Enabled value')!
    const enabledForm = analysis.capabilities.find(({ evidenceIds }) => evidenceIds.includes(enabledEvidence.id))!
    const page = internalSession(service, analysis.sessionId).page
    await page.locator('#ancestor-false-navigation').evaluate((container) =>
      container.setAttribute('aria-disabled', 'true'))
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      ancestorFalseNavigation.name,
      ancestorFalseNavigation.sampleInput,
      undefined,
      ancestorFalseNavigation.id,
    )).rejects.toMatchObject({ code: 'invalid_action', status: 409, sessionInvalidated: false })
    expect(page.url()).toBe(`${fixture.origin}/action-operability`)
    await page.locator('#ancestor-false-navigation').evaluate((container) =>
      container.setAttribute('aria-disabled', 'false'))

    await page.locator('#ancestor-false-radio-form').evaluate((form) =>
      form.setAttribute('aria-disabled', 'true'))
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      ancestorSafeRadioForm.name,
      ancestorSafeRadioForm.sampleInput,
      undefined,
      ancestorSafeRadioForm.id,
    )).rejects.toMatchObject({ code: 'invalid_action', status: 409, sessionInvalidated: false })
    expect(await page.locator('#ancestor-safe-radio-a').isChecked()).toBe(true)
    expect(await page.locator('#ancestor-safe-radio-b').isChecked()).toBe(false)
    await page.locator('#ancestor-false-radio-form').evaluate((form) =>
      form.setAttribute('aria-disabled', 'false'))

    await page.locator('#enabled-form').evaluate((form) => form.setAttribute('aria-disabled', 'true'))

    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      enabledForm.name,
      enabledForm.sampleInput,
      undefined,
      enabledForm.id,
    )).rejects.toMatchObject({ code: 'invalid_action', status: 409, sessionInvalidated: false })
    expect(await page.locator('#enabled-control').inputValue()).toBe('')
    expect(await page.locator('#enabled-form input').nth(1).inputValue()).toBe('')

    await page.locator('#enabled-form').evaluate((form) => form.removeAttribute('aria-disabled'))
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      enabledForm.name,
      enabledForm.sampleInput,
      undefined,
      enabledForm.id,
    )).resolves.toMatchObject({ structuredContent: { targetStateVerified: true } })
  })

  it('invalidates the session when aria-disabled changes after action admission', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService({ actionStartDelayMs: 200 })
    services.push(service)
    const analysis = await service.analyze(`${fixture.origin}/action-operability`)
    const enabledEvidence = analysis.domEvidence.find(({ label }) => label === 'Enabled value')!
    const enabledForm = analysis.capabilities.find(({ evidenceIds }) => evidenceIds.includes(enabledEvidence.id))!
    const page = internalSession(service, analysis.sessionId).page
    const pending = service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      enabledForm.name,
      enabledForm.sampleInput,
      undefined,
      enabledForm.id,
    )
    await new Promise((resolve) => setTimeout(resolve, 40))
    await page.locator('#enabled-form').evaluate((form) => form.setAttribute('aria-disabled', 'true'))

    await expect(pending).rejects.toMatchObject({ code: 'action_failed', sessionInvalidated: true })
    expect(internalServiceState(service)).toEqual({ sessions: 0, reservations: 0 })
  })

  it('excludes effectively aria-disabled select options and aria-readonly controls at both action boundaries', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService()
    services.push(service)
    const analysis = await service.analyze(`${fixture.origin}/option-and-readonly-safety`)
    const capabilityFor = (snapshot: typeof analysis, label: string) => {
      const evidence = snapshot.domEvidence.find((item) => item.label === label)
      return evidence && snapshot.capabilities.find(({ evidenceIds }) => evidenceIds.includes(evidence.id))
    }

    expect(capabilityFor(analysis, 'Direct disabled option filter')).toBeUndefined()
    expect(capabilityFor(analysis, 'Ancestor disabled option filter')).toBeUndefined()
    expect(capabilityFor(analysis, 'Initial readonly value')).toBeUndefined()
    const ariaFalseOption = capabilityFor(analysis, 'ARIA false option filter')!
    const falseReadonlyForm = capabilityFor(analysis, 'False readonly value')!
    expect(ariaFalseOption).toBeDefined()
    expect(falseReadonlyForm).toBeDefined()
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      ariaFalseOption.name,
      ariaFalseOption.sampleInput,
      undefined,
      ariaFalseOption.id,
    )).resolves.toMatchObject({ structuredContent: { targetStateVerified: true } })
    const optionService = createService()
    services.push(optionService)
    const optionAnalysis = await optionService.analyze(`${fixture.origin}/option-and-readonly-safety`)
    const optionPage = internalSession(optionService, optionAnalysis.sessionId).page
    const lateOption = capabilityFor(optionAnalysis, 'Late option operability filter')!
    await optionPage.locator('#late-option-target').evaluate((option) => option.setAttribute('aria-disabled', 'true'))
    await expect(optionService.execute(
      optionAnalysis.sessionId,
      optionAnalysis.sessionToken,
      lateOption.name,
      lateOption.sampleInput,
      undefined,
      lateOption.id,
    )).rejects.toMatchObject({ code: 'invalid_action', sessionInvalidated: false })
    expect(await optionPage.locator('#late-option-operability').evaluate(
      (select) => (select as HTMLSelectElement).selectedIndex,
    )).toBe(0)

    const selectService = createService()
    services.push(selectService)
    const selectAnalysis = await selectService.analyze(`${fixture.origin}/select-readonly-safety`)
    expect(capabilityFor(selectAnalysis, 'Initial readonly category filter')).toBeUndefined()
    const falseReadonlySelect = capabilityFor(selectAnalysis, 'False readonly category filter')!
    expect(falseReadonlySelect).toBeDefined()
    await expect(selectService.execute(
      selectAnalysis.sessionId,
      selectAnalysis.sessionToken,
      falseReadonlySelect.name,
      falseReadonlySelect.sampleInput,
      undefined,
      falseReadonlySelect.id,
    )).resolves.toMatchObject({ structuredContent: { targetStateVerified: true } })

    const lateSelectService = createService()
    services.push(lateSelectService)
    const lateSelectAnalysis = await lateSelectService.analyze(`${fixture.origin}/select-readonly-safety`)
    const lateSelectPage = internalSession(lateSelectService, lateSelectAnalysis.sessionId).page
    const lateReadonlySelect = capabilityFor(lateSelectAnalysis, 'Late readonly category filter')!
    await lateSelectPage.locator('#late-readonly-select').evaluate((select) =>
      select.setAttribute('aria-readonly', 'true'))
    await expect(lateSelectService.execute(
      lateSelectAnalysis.sessionId,
      lateSelectAnalysis.sessionToken,
      lateReadonlySelect.name,
      lateReadonlySelect.sampleInput,
      undefined,
      lateReadonlySelect.id,
    )).rejects.toMatchObject({ code: 'invalid_action', sessionInvalidated: false })
    expect(await lateSelectPage.locator('#late-readonly-select').evaluate(
      (select) => (select as HTMLSelectElement).selectedIndex,
    )).toBe(0)
    await lateSelectPage.locator('#late-readonly-select').evaluate((select) =>
      select.removeAttribute('aria-readonly'))
    await expect(lateSelectService.execute(
      lateSelectAnalysis.sessionId,
      lateSelectAnalysis.sessionToken,
      lateReadonlySelect.name,
      lateReadonlySelect.sampleInput,
      undefined,
      lateReadonlySelect.id,
    )).resolves.toMatchObject({ structuredContent: { targetStateVerified: true } })

    const readonlyService = createService()
    services.push(readonlyService)
    const readonlyAnalysis = await readonlyService.analyze(`${fixture.origin}/option-and-readonly-safety`)
    const readonlyPage = internalSession(readonlyService, readonlyAnalysis.sessionId).page
    const lateReadonly = capabilityFor(readonlyAnalysis, 'Late readonly value')!
    await readonlyPage.locator('#late-readonly-value').evaluate((input) => input.setAttribute('aria-readonly', 'true'))
    await expect(readonlyService.execute(
      readonlyAnalysis.sessionId,
      readonlyAnalysis.sessionToken,
      lateReadonly.name,
      lateReadonly.sampleInput,
      undefined,
      lateReadonly.id,
    )).rejects.toMatchObject({ code: 'invalid_action', sessionInvalidated: false })
    expect(await readonlyPage.locator('#late-readonly-value').inputValue()).toBe('')
    await readonlyPage.locator('#late-readonly-value').evaluate((input) => input.removeAttribute('aria-readonly'))
    await expect(readonlyService.execute(
      readonlyAnalysis.sessionId,
      readonlyAnalysis.sessionToken,
      lateReadonly.name,
      lateReadonly.sampleInput,
      undefined,
      lateReadonly.id,
    )).resolves.toMatchObject({ structuredContent: { targetStateVerified: true } })
  }, 10_000)

  it('invalidates admitted option and readonly actions when their ARIA operability changes', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const capabilityFor = (snapshot: Awaited<ReturnType<WrapperProofService['analyze']>>, label: string) => {
      const evidence = snapshot.domEvidence.find((item) => item.label === label)!
      return snapshot.capabilities.find(({ evidenceIds }) => evidenceIds.includes(evidence.id))!
    }

    const optionService = createService({ actionStartDelayMs: 180 })
    services.push(optionService)
    const optionAnalysis = await optionService.analyze(`${fixture.origin}/option-and-readonly-safety`)
    const optionPage = internalSession(optionService, optionAnalysis.sessionId).page
    const lateOption = capabilityFor(optionAnalysis, 'Late option operability filter')
    const pendingOption = optionService.execute(
      optionAnalysis.sessionId,
      optionAnalysis.sessionToken,
      lateOption.name,
      lateOption.sampleInput,
      undefined,
      lateOption.id,
    )
    await new Promise((resolve) => setTimeout(resolve, 40))
    await optionPage.locator('#late-option-target').evaluate((option) => option.setAttribute('aria-disabled', 'true'))
    await expect(pendingOption).rejects.toMatchObject({ code: 'action_failed', sessionInvalidated: true })

    const readonlyService = createService({ actionStartDelayMs: 180 })
    services.push(readonlyService)
    const readonlyAnalysis = await readonlyService.analyze(`${fixture.origin}/option-and-readonly-safety`)
    const readonlyPage = internalSession(readonlyService, readonlyAnalysis.sessionId).page
    const lateReadonly = capabilityFor(readonlyAnalysis, 'Late readonly value')
    const pendingReadonly = readonlyService.execute(
      readonlyAnalysis.sessionId,
      readonlyAnalysis.sessionToken,
      lateReadonly.name,
      lateReadonly.sampleInput,
      undefined,
      lateReadonly.id,
    )
    await new Promise((resolve) => setTimeout(resolve, 40))
    await readonlyPage.locator('#late-readonly-value').evaluate((input) => input.setAttribute('aria-readonly', 'true'))
    await expect(pendingReadonly).rejects.toMatchObject({ code: 'action_failed', sessionInvalidated: true })

    const selectService = createService({ actionStartDelayMs: 180 })
    services.push(selectService)
    const selectAnalysis = await selectService.analyze(`${fixture.origin}/select-readonly-safety`)
    const selectPage = internalSession(selectService, selectAnalysis.sessionId).page
    const lateReadonlySelect = capabilityFor(selectAnalysis, 'Late readonly category filter')
    const pendingSelect = selectService.execute(
      selectAnalysis.sessionId,
      selectAnalysis.sessionToken,
      lateReadonlySelect.name,
      lateReadonlySelect.sampleInput,
      undefined,
      lateReadonlySelect.id,
    )
    await new Promise((resolve) => setTimeout(resolve, 40))
    await selectPage.locator('#late-readonly-select').evaluate((select) =>
      select.setAttribute('aria-readonly', 'true'))
    await expect(pendingSelect).rejects.toMatchObject({ code: 'action_failed', sessionInvalidated: true })
  })

  it('classifies option descriptions privately and revalidates described evidence before mutation', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService()
    services.push(service)
    const analysis = await service.analyze(`${fixture.origin}/option-described-safety`)
    const capabilityFor = (snapshot: typeof analysis, label: string) => {
      const evidence = snapshot.domEvidence.find((item) => item.label === label)
      return evidence && snapshot.capabilities.find(({ evidenceIds }) => evidenceIds.includes(evidence.id))
    }
    expect(capabilityFor(analysis, 'Direct description option filter')).toBeUndefined()
    expect(capabilityFor(analysis, 'Referenced description option filter')).toBeUndefined()
    expect(capabilityFor(analysis, 'Nested description option filter')).toBeUndefined()
    expect(capabilityFor(analysis, 'Missing description option filter')).toBeUndefined()
    expect(capabilityFor(analysis, 'Overflow description option filter')).toBeUndefined()
    expect(capabilityFor(analysis, 'Count overflow description option filter')).toBeUndefined()
    expect(capabilityFor(analysis, 'Aggregate overflow description option filter')).toBeUndefined()
    expect(capabilityFor(analysis, 'Traversal overflow description option filter')).toBeUndefined()
    const neutral = capabilityFor(analysis, 'Neutral description option filter')!
    expect(neutral).toBeDefined()
    expect(JSON.stringify(analysis)).not.toMatch(/Credit card number|Password|sensitive-option-description/)
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      neutral.name,
      neutral.sampleInput,
      undefined,
      neutral.id,
    )).resolves.toMatchObject({ structuredContent: { targetStateVerified: true } })

    const lateService = createService()
    services.push(lateService)
    const lateAnalysis = await lateService.analyze(`${fixture.origin}/option-described-safety`)
    const latePage = internalSession(lateService, lateAnalysis.sessionId).page
    const late = capabilityFor(lateAnalysis, 'Late description option filter')!
    await latePage.locator('#late-option-description').evaluate((node) => {
      node.setAttribute('aria-description', 'Credit card number')
    })
    await expect(lateService.execute(
      lateAnalysis.sessionId,
      lateAnalysis.sessionToken,
      late.name,
      late.sampleInput,
      undefined,
      late.id,
    )).rejects.toMatchObject({ code: 'invalid_action', sessionInvalidated: false })
    expect(await latePage.locator('#late-description-option').evaluate(
      (select) => (select as HTMLSelectElement).selectedIndex,
    )).toBe(0)

    const admittedService = createService({ actionStartDelayMs: 180 })
    services.push(admittedService)
    const admittedAnalysis = await admittedService.analyze(`${fixture.origin}/option-described-safety`)
    const admittedPage = internalSession(admittedService, admittedAnalysis.sessionId).page
    const admitted = capabilityFor(admittedAnalysis, 'Late description option filter')!
    const pending = admittedService.execute(
      admittedAnalysis.sessionId,
      admittedAnalysis.sessionToken,
      admitted.name,
      admitted.sampleInput,
      undefined,
      admitted.id,
    )
    await new Promise((resolve) => setTimeout(resolve, 40))
    await admittedPage.locator('#late-option-description').evaluate((node) => {
      node.setAttribute('aria-description', 'Credit card number')
    })
    await expect(pending).rejects.toMatchObject({ code: 'action_failed', sessionInvalidated: true })
  })

  it('requires a screenshot-visible delta before reporting an action as verified', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const capabilityFor = (snapshot: Awaited<ReturnType<WrapperProofService['analyze']>>, label: string) => {
      const evidence = snapshot.domEvidence.find((item) => item.label === label)!
      return snapshot.capabilities.find(({ evidenceIds }) => evidenceIds.includes(evidence.id))!
    }
    for (const [path, label] of [
      ['/visible-state-contract', 'Semantic CSS filter'],
      ['/visible-state-web-animation', 'Semantic Web Animation filter'],
    ] as const) {
      const service = createService()
      services.push(service)
      const analysis = await service.analyze(`${fixture.origin}${path}`)
      const semanticOnly = capabilityFor(analysis, label)
      await expect(service.execute(
        analysis.sessionId,
        analysis.sessionToken,
        semanticOnly.name,
        semanticOnly.sampleInput,
        undefined,
        semanticOnly.id,
      )).rejects.toMatchObject({ code: 'invalid_action', sessionInvalidated: true })
      expect(internalServiceState(service)).toEqual({ sessions: 0, reservations: 0 })
    }

    const visibleService = createService()
    services.push(visibleService)
    const visibleAnalysis = await visibleService.analyze(`${fixture.origin}/visible-state-contract`)
    const visible = capabilityFor(visibleAnalysis, 'Visible result filter')
    const result = await visibleService.execute(
      visibleAnalysis.sessionId,
      visibleAnalysis.sessionToken,
      visible.name,
      visible.sampleInput,
      undefined,
      visible.id,
    )
    expect(result.analysis.screenshotDataUrl).not.toBe(visibleAnalysis.screenshotDataUrl)
    expect(result.structuredContent).toMatchObject({ isolatedStateChanged: true, targetStateVerified: true })
    expect(await internalSession(visibleService, result.analysis.sessionId).cdp.send(
      'Animation.getPlaybackRate',
    )).toMatchObject({ playbackRate: 1 })
  })

  it('rejects one-shot target CSS, DOM, and scroll drift as visible action evidence', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    for (const drift of ['style', 'dom', 'scroll'] as const) {
      const service = createService({
        beforeControlWrite: async (page) => {
          if (drift === 'style') {
            await page.locator('#semantic-css-filter').evaluate((select) => {
              ;(select as HTMLElement).style.background = 'rgb(255, 0, 0)'
            })
          } else if (drift === 'dom') {
            await page.evaluate(() => document.body.append(document.createElement('span')))
          } else {
            await page.evaluate(() => {
              document.documentElement.style.minHeight = '2000px'
              globalThis.scrollTo(0, 40)
            })
          }
        },
      })
      services.push(service)
      const analysis = await service.analyze(`${fixture.origin}/visible-state-contract`)
      const evidence = analysis.domEvidence.find(({ label }) => label === 'Semantic CSS filter')!
      const semanticOnly = analysis.capabilities.find(({ evidenceIds }) => evidenceIds.includes(evidence.id))!
      await expect(service.execute(
        analysis.sessionId,
        analysis.sessionToken,
        semanticOnly.name,
        semanticOnly.sampleInput,
        undefined,
        semanticOnly.id,
      )).rejects.toMatchObject({ code: 'action_failed', sessionInvalidated: true })
      expect(internalServiceState(service)).toEqual({ sessions: 0, reservations: 0 })
    }

    const idPaintService = createService({
      beforeControlWrite: async (page) => {
        await page.locator('#idle-id-paint').evaluate((node) => {
          node.id = 'armed-id-paint'
        })
      },
    })
    services.push(idPaintService)
    const idPaintAnalysis = await idPaintService.analyze(`${fixture.origin}/id-paint-action-contract`)
    const idPaintEvidence = idPaintAnalysis.domEvidence.find(({ label }) => label === 'ID paint filter')!
    const idPaintCapability = idPaintAnalysis.capabilities.find(({ evidenceIds }) =>
      evidenceIds.includes(idPaintEvidence.id))!
    await expect(idPaintService.execute(
      idPaintAnalysis.sessionId,
      idPaintAnalysis.sessionToken,
      idPaintCapability.name,
      idPaintCapability.sampleInput,
      undefined,
      idPaintCapability.id,
    )).rejects.toMatchObject({ code: 'action_failed', sessionInvalidated: true })
    expect(internalServiceState(idPaintService)).toEqual({ sessions: 0, reservations: 0 })
  }, 15_000)

  it('rejects existing sibling drift while the action-capture baseline is armed before any native write', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    let armMutations = 0
    const service = createService({
      duringActionCaptureArm: async (page) => {
        armMutations += 1
        await page.locator('#semantic-css-filter').evaluate((sibling) => {
          sibling.classList.add('action-capture-arm-drift')
        })
      },
    })
    services.push(service)
    const analysis = await service.analyze(`${fixture.origin}/visible-state-contract`)
    const evidence = analysis.domEvidence.find(({ label }) => label === 'Visible result filter')!
    const capability = analysis.capabilities.find(({ evidenceIds }) => evidenceIds.includes(evidence.id))!

    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      capability.name,
      capability.sampleInput,
      undefined,
      capability.id,
    )).rejects.toMatchObject({ code: 'invalid_action', status: 409, sessionInvalidated: false })
    expect(armMutations).toBe(1)
    expect(await internalSession(service, analysis.sessionId).page.locator('#visible-filter').evaluate(
      (select) => (select as HTMLSelectElement).selectedIndex,
    )).toBe(0)
    expect(internalServiceState(service)).toEqual({ sessions: 1, reservations: 0 })
  })

  it('restores the preparation network state after a pre-action capture rejection', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    let captureAttempts = 0
    const service = createService({
      beforeActionStateCapture: async () => {
        captureAttempts += 1
        if (captureAttempts === 1) throw new Error('test-only pre-action capture failure')
      },
    })
    services.push(service)
    const analysis = await service.analyze(`${fixture.origin}/`)
    const preparation = analysis.capabilities.find(({ name }) => name === 'prepare_page_search')!
    const navigation = analysis.capabilities.find(({ name }) => name === 'open_page_link')!

    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      preparation.name,
      preparation.sampleInput,
      undefined,
      preparation.id,
    )).rejects.toMatchObject({ code: 'invalid_action', sessionInvalidated: false })

    const preservedSession = internalSession(service, analysis.sessionId)
    expect(preservedSession).toMatchObject({
      networkLocked: false,
      networkMode: 'blocked',
      activeNetworkMetrics: null,
    })
    const navigationResult = await service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      navigation.name,
      navigation.sampleInput,
      undefined,
      navigation.id,
    )
    expect(navigationResult).toMatchObject({
      finalUrl: `${fixture.origin}/next`,
      analysis: { sessionId: analysis.sessionId },
      structuredContent: {
        targetStateVerified: true,
        navigationOccurred: true,
      },
    })

    const retryPreparation = navigationResult.analysis.capabilities.find(
      ({ name }) => name === 'prepare_page_search',
    )!
    const retryResult = await service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      retryPreparation.name,
      retryPreparation.sampleInput,
      undefined,
      retryPreparation.id,
    )
    expect(retryResult.structuredContent).toMatchObject({
      targetStateVerified: true,
      navigationOccurred: false,
      allowedNetworkRequests: 0,
      blockedNetworkRequests: 0,
    })
    expect(internalSession(service, analysis.sessionId).activeNetworkMetrics).toBeNull()
    expect(captureAttempts).toBe(2)
  })

  it('rejects intersecting dynamic paint while preserving unrelated visible actions', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const capabilityFor = (
      snapshot: Awaited<ReturnType<WrapperProofService['analyze']>>,
      label: string,
    ) => {
      const evidence = snapshot.domEvidence.find((item) => item.label === label)!
      return snapshot.capabilities.find(({ evidenceIds }) => evidenceIds.includes(evidence.id))!
    }
    const canvasService = createService()
    services.push(canvasService)
    const canvasAnalysis = await canvasService.analyze(`${fixture.origin}/dynamic-render-contract`)
    const canvasPage = internalSession(canvasService, canvasAnalysis.sessionId).page
    const movingFrame = await canvasPage.evaluate(() => Number(
      (globalThis as typeof globalThis & { __renderFrame?: number }).__renderFrame ?? -1,
    ))
    expect(movingFrame).toBeGreaterThan(0)
    const semanticCanvas = capabilityFor(canvasAnalysis, 'Semantic canvas filter')
    await expect(canvasService.execute(
      canvasAnalysis.sessionId,
      canvasAnalysis.sessionToken,
      semanticCanvas.name,
      semanticCanvas.sampleInput,
      undefined,
      semanticCanvas.id,
    )).rejects.toMatchObject({ code: 'invalid_action', sessionInvalidated: false })
    expect(await canvasPage.locator('#semantic-canvas-filter').evaluate(
      (select) => (select as HTMLSelectElement).selectedIndex,
    )).toBe(0)
    expect(internalServiceState(canvasService)).toEqual({ sessions: 1, reservations: 0 })

    const imageService = createService()
    services.push(imageService)
    const imageAnalysis = await imageService.analyze(`${fixture.origin}/dynamic-render-contract`)
    const imagePage = internalSession(imageService, imageAnalysis.sessionId).page
    const semanticImage = capabilityFor(imageAnalysis, 'Semantic animated image filter')
    await expect(imageService.execute(
      imageAnalysis.sessionId,
      imageAnalysis.sessionToken,
      semanticImage.name,
      semanticImage.sampleInput,
      undefined,
      semanticImage.id,
    )).rejects.toMatchObject({ code: 'invalid_action', sessionInvalidated: false })
    expect(await imagePage.locator('#semantic-image-filter').evaluate(
      (select) => (select as HTMLSelectElement).selectedIndex,
    )).toBe(0)

    const mediaService = createService()
    services.push(mediaService)
    const mediaAnalysis = await mediaService.analyze(`${fixture.origin}/dynamic-media-contract`)
    const mediaPage = internalSession(mediaService, mediaAnalysis.sessionId).page
    await expect.poll(() => mediaPage.locator('#moving-video').evaluate((video) => ({
      paused: (video as HTMLVideoElement).paused,
      hasStream: Boolean((video as HTMLVideoElement).srcObject),
    }))).toEqual({ paused: false, hasStream: true })
    const semanticMedia = capabilityFor(mediaAnalysis, 'Semantic media filter')
    await expect(mediaService.execute(
      mediaAnalysis.sessionId,
      mediaAnalysis.sessionToken,
      semanticMedia.name,
      semanticMedia.sampleInput,
      undefined,
      semanticMedia.id,
    )).rejects.toMatchObject({ code: 'invalid_action', sessionInvalidated: false })
    expect(await mediaPage.locator('#semantic-media-filter').evaluate(
      (select) => (select as HTMLSelectElement).selectedIndex,
    )).toBe(0)

    const shadowService = createService()
    services.push(shadowService)
    const shadowAnalysis = await shadowService.analyze(`${fixture.origin}/dynamic-shadow-contract`)
    const shadowPage = internalSession(shadowService, shadowAnalysis.sessionId).page
    const semanticShadow = capabilityFor(shadowAnalysis, 'Semantic shadow filter')
    await expect(shadowService.execute(
      shadowAnalysis.sessionId,
      shadowAnalysis.sessionToken,
      semanticShadow.name,
      semanticShadow.sampleInput,
      undefined,
      semanticShadow.id,
    )).rejects.toMatchObject({ code: 'invalid_action', sessionInvalidated: false })
    expect(await shadowPage.locator('#semantic-shadow-filter').evaluate(
      (select) => (select as HTMLSelectElement).selectedIndex,
    )).toBe(0)

    const visibleService = createService()
    services.push(visibleService)
    const visibleAnalysis = await visibleService.analyze(`${fixture.origin}/dynamic-render-contract`)
    const visiblePage = internalSession(visibleService, visibleAnalysis.sessionId).page
    const visible = capabilityFor(visibleAnalysis, 'Visible render search')
    await expect(visibleService.execute(
      visibleAnalysis.sessionId,
      visibleAnalysis.sessionToken,
      visible.name,
      visible.sampleInput,
      undefined,
      visible.id,
    )).resolves.toMatchObject({ structuredContent: { targetStateVerified: true } })
    expect(await visiblePage.locator('#visible-render-search').inputValue()).toBe(
      String(visible.sampleInput.query),
    )
  }, 40_000)

  it('fails closed on an over-budget ARIA-disabled ancestor chain while retaining safe controls', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService()
    services.push(service)
    const analysis = await service.analyze(`${fixture.origin}/aria-disabled-depth`)

    expect(analysis.domEvidence.find(({ label }) => label === 'Too deep value')).toBeUndefined()
    const safeEvidence = analysis.domEvidence.find(({ label }) => label === 'Safe depth value')!
    const safeForm = analysis.capabilities.find(({ evidenceIds }) => evidenceIds.includes(safeEvidence.id))!
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      safeForm.name,
      safeForm.sampleInput,
      undefined,
      safeForm.id,
    )).resolves.toMatchObject({ structuredContent: { targetStateVerified: true } })
  })

  it('publishes only finite Chromium-native date-like value sets and validates them before mutation', async () => {
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

    const expected = [
      ['2026-01-14', '2026-01-15', '2026-01-16', '2026-01-17', '2026-01-18'],
      ['2026-01', '2026-03', '2026-05'],
      ['12:00:30', '12:01:00', '12:01:30', '12:02:00'],
      ['2026-W52', '2026-W53', '2027-W01', '2027-W02'],
    ]
    expect(analysis.capabilities.filter(({ name }) => name.startsWith('prepare_visible_form'))).toHaveLength(4)
    expect(analysis.domEvidence.filter(({ label }) => ['Open date', 'Large date', 'Invalid date'].includes(label)))
      .toHaveLength(3)
    for (let index = 0; index < expected.length; index += 1) {
      const toolName = index === 0 ? 'prepare_visible_form' : `prepare_visible_form_${index + 1}`
      const capability = analysis.capabilities.find(({ name }) => name === toolName)!
      const fieldSchema = (capability.inputSchema.properties as Record<string, Record<string, unknown>>).field_1
      expect(fieldSchema.enum).toEqual(expected[index])
      expect(capability.sampleInput.field_1).toBe(expected[index][0])
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

  it('excludes current-only date-like controls and publishes an executable alternative', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService()
    services.push(service)
    const analysis = await service.analyze(`${fixture.origin}/date-like-single-state`)

    expect(analysis.domEvidence.find(({ label }) => label === 'Fixed date')).toMatchObject({ sensitive: true })
    expect(analysis.domEvidence.find(({ label }) => label === 'Fixed month')).toMatchObject({ sensitive: true })
    expect(analysis.capabilities.filter(({ kind }) => kind === 'prepare_form')).toHaveLength(1)

    const form = analysis.capabilities.find(({ name }) => name === 'prepare_visible_form')!
    expect(form.inputSchema).toMatchObject({
      properties: {
        field_1: { type: 'string', enum: ['2026-01-15', '2026-01-16'] },
      },
    })
    expect(form.sampleInput).toMatchObject({ field_1: '2026-01-16' })
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      form.name,
      form.sampleInput,
      undefined,
      form.id,
    )).resolves.toMatchObject({
      structuredContent: { isolatedStateChanged: true, targetStateVerified: true },
    })
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

    const currentOne = analysis.capabilities.find(({ name }) => name === 'prepare_visible_form_5')!
    expect(currentOne.sampleInput.field_1).toBe(0)
    const currentOneResult = await service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      currentOne.name,
      currentOne.sampleInput,
    )
    expect(currentOneResult.structuredContent).toMatchObject({ isolatedStateChanged: true, targetStateVerified: true })
    analysis = currentOneResult.analysis

    const currentStepped = analysis.capabilities.find(({ name }) => name === 'prepare_visible_form_6')!
    expect(currentStepped.sampleInput.field_1).toBe(12)
    const currentSteppedResult = await service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      currentStepped.name,
      currentStepped.sampleInput,
    )
    expect(currentSteppedResult.structuredContent).toMatchObject({ isolatedStateChanged: true, targetStateVerified: true })
    analysis = currentSteppedResult.analysis

    const singletonEvidence = analysis.domEvidence.find(({ label }) => label === 'Single numeric state')!
    expect(analysis.capabilities.some(({ evidenceIds }) => evidenceIds.includes(singletonEvidence.id))).toBe(false)
  })

  it('uses the opposite of the native analyzed checkbox state for executable samples', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService()
    services.push(service)
    let analysis = await service.analyze(`${fixture.origin}/checkbox-samples`)
    const checked = analysis.capabilities.find(({ name }) => name === 'prepare_visible_form')!
    expect(checked.inputSchema).toMatchObject({
      properties: { field_1: { type: 'boolean' }, field_2: { type: 'boolean' } },
    })
    expect(checked.sampleInput).toEqual({ field_1: false, field_2: false })
    const checkedResult = await service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      checked.name,
      checked.sampleInput,
      undefined,
      checked.id,
    )
    expect(checkedResult.structuredContent).toMatchObject({
      isolatedStateChanged: true,
      targetStateVerified: true,
    })
    analysis = checkedResult.analysis
    expect(await internalSession(service, analysis.sessionId).page.locator('#checked-one, #checked-two').evaluateAll(
      (controls) => controls.map((control) => (control as HTMLInputElement).checked),
    )).toEqual([false, false])

    const unchecked = analysis.capabilities.find(({ name }) => name === 'prepare_visible_form_2')!
    expect(unchecked.sampleInput).toEqual({ field_1: true, field_2: true })
    const uncheckedResult = await service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      unchecked.name,
      unchecked.sampleInput,
      undefined,
      unchecked.id,
    )
    expect(uncheckedResult.structuredContent.targetStateVerified).toBe(true)
    expect(await internalSession(service, analysis.sessionId).page.locator('#unchecked-one, #unchecked-two').evaluateAll(
      (controls) => controls.map((control) => (control as HTMLInputElement).checked),
    )).toEqual([true, true])
  })

  it('keeps required checkbox schema, samples, validation, and native state aligned', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService()
    services.push(service)
    let analysis = await service.analyze(`${fixture.origin}/checkbox-samples`)
    const requiredUncheckedEvidence = analysis.domEvidence.find(({ label }) => label === 'Required unchecked')!
    const requiredUnchecked = analysis.capabilities.find(({ evidenceIds }) =>
      evidenceIds.includes(requiredUncheckedEvidence.id))!

    expect(requiredUnchecked.inputSchema).toMatchObject({
      properties: { field_1: { type: 'boolean', const: true } },
    })
    expect(requiredUnchecked.sampleInput.field_1).toBe(true)
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      requiredUnchecked.name,
      { ...requiredUnchecked.sampleInput, field_1: false },
      undefined,
      requiredUnchecked.id,
    )).rejects.toMatchObject({ code: 'invalid_action', status: 400, sessionInvalidated: false })
    expect(await internalSession(service, analysis.sessionId).page.locator('#required-unchecked').isChecked()).toBe(false)

    const prepared = await service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      requiredUnchecked.name,
      requiredUnchecked.sampleInput,
      undefined,
      requiredUnchecked.id,
    )
    expect(prepared.structuredContent).toMatchObject({ isolatedStateChanged: true, targetStateVerified: true })
    analysis = prepared.analysis
    expect(await internalSession(service, analysis.sessionId).page.locator('#required-unchecked').isChecked()).toBe(true)

    const requiredCheckedEvidence = analysis.domEvidence.find(({ label }) => label === 'Required checked')!
    const requiredCheckedForm = analysis.capabilities.find(({ evidenceIds }) =>
      evidenceIds.includes(requiredCheckedEvidence.id))
    expect(requiredCheckedForm).toBeUndefined()
    const requiredCheckedText = analysis.domEvidence.find(({ label }) => label === 'Required checked first')!
    const textOnlyForm = analysis.capabilities.find(({ evidenceIds }) => evidenceIds.includes(requiredCheckedText.id))!
    expect(Object.values(textOnlyForm.inputSchema.properties ?? {})).not.toContainEqual(
      expect.objectContaining({ type: 'boolean' }),
    )

    const ariaRequiredEvidence = analysis.domEvidence.find(({ label }) => label === 'ARIA required unchecked')!
    const ariaRequiredForm = analysis.capabilities.find(({ evidenceIds }) =>
      evidenceIds.includes(ariaRequiredEvidence.id))!
    expect(ariaRequiredForm.inputSchema).toMatchObject({
      properties: { field_1: { type: 'boolean', const: true } },
    })
    expect(ariaRequiredForm.sampleInput.field_1).toBe(true)
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      ariaRequiredForm.name,
      { ...ariaRequiredForm.sampleInput, field_1: false },
      undefined,
      ariaRequiredForm.id,
    )).rejects.toMatchObject({ code: 'invalid_action', status: 400, sessionInvalidated: false })
    expect(await internalSession(service, analysis.sessionId).page.locator('#aria-required-unchecked').isChecked()).toBe(false)

    const ariaRequiredCheckedEvidence = analysis.domEvidence.find(({ label }) => label === 'ARIA required checked')!
    expect(analysis.capabilities.find(({ evidenceIds }) =>
      evidenceIds.includes(ariaRequiredCheckedEvidence.id))).toBeUndefined()
    expect(await internalSession(service, analysis.sessionId).page.locator('#aria-required-checked').isChecked()).toBe(true)
  })

  it('revalidates a checkbox that becomes required before and after action admission', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService()
    services.push(service)
    const analysis = await service.analyze(`${fixture.origin}/checkbox-samples`)
    const lateEvidence = analysis.domEvidence.find(({ label }) => label === 'Late required checkbox')!
    const capability = analysis.capabilities.find(({ evidenceIds }) => evidenceIds.includes(lateEvidence.id))!
    const page = internalSession(service, analysis.sessionId).page
    await page.locator('#late-required-checkbox').evaluate((checkbox) => {
      (checkbox as HTMLInputElement).required = true
    })

    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      capability.name,
      capability.sampleInput,
      undefined,
      capability.id,
    )).rejects.toMatchObject({ code: 'invalid_action', status: 409, sessionInvalidated: false })
    expect(await page.locator('#late-required-checkbox').isChecked()).toBe(false)
    expect(await page.locator('#late-required-checkbox-detail').inputValue()).toBe('')

    await page.locator('#late-required-checkbox').evaluate((checkbox) => {
      (checkbox as HTMLInputElement).required = false
    })
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      capability.name,
      capability.sampleInput,
      undefined,
      capability.id,
    )).resolves.toMatchObject({ structuredContent: { targetStateVerified: true } })

    const raceService = createService({ actionStartDelayMs: 200 })
    services.push(raceService)
    const raceAnalysis = await raceService.analyze(`${fixture.origin}/checkbox-samples`)
    const raceEvidence = raceAnalysis.domEvidence.find(({ label }) => label === 'Late required checkbox')!
    const raceCapability = raceAnalysis.capabilities.find(({ evidenceIds }) => evidenceIds.includes(raceEvidence.id))!
    const racePage = internalSession(raceService, raceAnalysis.sessionId).page
    const pending = raceService.execute(
      raceAnalysis.sessionId,
      raceAnalysis.sessionToken,
      raceCapability.name,
      raceCapability.sampleInput,
      undefined,
      raceCapability.id,
    )
    await new Promise((resolve) => setTimeout(resolve, 40))
    await racePage.locator('#late-required-checkbox').evaluate((checkbox) => {
      (checkbox as HTMLInputElement).required = true
    })

    await expect(pending).rejects.toMatchObject({ code: 'action_failed', sessionInvalidated: true })
    expect(internalServiceState(raceService)).toEqual({ sessions: 0, reservations: 0 })

    const ariaService = createService()
    services.push(ariaService)
    const ariaAnalysis = await ariaService.analyze(`${fixture.origin}/checkbox-samples`)
    const ariaEvidence = ariaAnalysis.domEvidence.find(({ label }) => label === 'Late ARIA required checkbox')!
    const ariaCapability = ariaAnalysis.capabilities.find(({ evidenceIds }) => evidenceIds.includes(ariaEvidence.id))!
    const ariaPage = internalSession(ariaService, ariaAnalysis.sessionId).page
    await ariaPage.locator('#late-aria-required').evaluate((checkbox) =>
      checkbox.setAttribute('aria-required', 'true'))
    await expect(ariaService.execute(
      ariaAnalysis.sessionId,
      ariaAnalysis.sessionToken,
      ariaCapability.name,
      ariaCapability.sampleInput,
      undefined,
      ariaCapability.id,
    )).rejects.toMatchObject({ code: 'invalid_action', sessionInvalidated: false })
    expect(await ariaPage.locator('#late-aria-required').isChecked()).toBe(false)
    expect(await ariaPage.locator('#late-aria-required-detail').inputValue()).toBe('')

    const ariaRaceService = createService({ actionStartDelayMs: 200 })
    services.push(ariaRaceService)
    const ariaRaceAnalysis = await ariaRaceService.analyze(`${fixture.origin}/checkbox-samples`)
    const ariaRaceEvidence = ariaRaceAnalysis.domEvidence.find(({ label }) => label === 'Late ARIA required checkbox')!
    const ariaRaceCapability = ariaRaceAnalysis.capabilities.find(({ evidenceIds }) =>
      evidenceIds.includes(ariaRaceEvidence.id))!
    const ariaRacePage = internalSession(ariaRaceService, ariaRaceAnalysis.sessionId).page
    const ariaPending = ariaRaceService.execute(
      ariaRaceAnalysis.sessionId,
      ariaRaceAnalysis.sessionToken,
      ariaRaceCapability.name,
      ariaRaceCapability.sampleInput,
      undefined,
      ariaRaceCapability.id,
    )
    await new Promise((resolve) => setTimeout(resolve, 40))
    await ariaRacePage.locator('#late-aria-required').evaluate((checkbox) =>
      checkbox.setAttribute('aria-required', 'true'))
    await expect(ariaPending).rejects.toMatchObject({ code: 'action_failed', sessionInvalidated: true })
    expect(internalServiceState(ariaRaceService)).toEqual({ sessions: 0, reservations: 0 })
  })

  it('excludes initially indeterminate checkboxes while preserving another safe control and state', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService()
    services.push(service)
    const analysis = await service.analyze(`${fixture.origin}/initial-indeterminate`)
    const page = internalSession(service, analysis.sessionId).page

    expect(analysis.domEvidence.find(({ label }) => label === 'Indeterminate choice')).toMatchObject({
      sensitive: true,
    })
    expect(analysis.capabilities.map(({ name }) => name)).toEqual(['prepare_page_search'])
    expect(await page.locator('#initial-indeterminate').evaluate((checkbox) => ({
      checked: (checkbox as HTMLInputElement).checked,
      indeterminate: (checkbox as HTMLInputElement).indeterminate,
    }))).toEqual({ checked: false, indeterminate: true })

    const search = analysis.capabilities[0]
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      search.name,
      search.sampleInput,
      undefined,
      search.id,
    )).resolves.toMatchObject({ structuredContent: { targetStateVerified: true } })
  })

  it('revalidates checkbox indeterminate state without invoking page-authored input handlers', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService()
    services.push(service)
    let analysis = await service.analyze(`${fixture.origin}/late-control-contracts`)
    let page = internalSession(service, analysis.sessionId).page
    let form = analysis.capabilities.find(({ kind }) => kind === 'prepare_form')!

    await page.locator('#late-checkbox').evaluate((checkbox) => {
      (checkbox as HTMLInputElement).indeterminate = true
    })
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      form.name,
      form.sampleInput,
      undefined,
      form.id,
    )).rejects.toMatchObject({ code: 'invalid_action', sessionInvalidated: false })
    expect(await page.locator('#late-checkbox').evaluate((checkbox) => ({
      checked: (checkbox as HTMLInputElement).checked,
      indeterminate: (checkbox as HTMLInputElement).indeterminate,
    }))).toEqual({ checked: false, indeterminate: true })
    expect(await page.locator('#late-checkbox-detail').inputValue()).toBe('')

    await page.locator('#late-checkbox').evaluate((checkbox) => {
      (checkbox as HTMLInputElement).indeterminate = false
    })
    const normal = await service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      form.name,
      form.sampleInput,
      undefined,
      form.id,
    )
    expect(normal.structuredContent.targetStateVerified).toBe(true)

    analysis = await service.analyze(`${fixture.origin}/late-control-contracts`)
    page = internalSession(service, analysis.sessionId).page
    form = analysis.capabilities.find(({ kind }) => kind === 'prepare_form')!
    await page.locator('#late-checkbox').evaluate((checkbox) => {
      checkbox.addEventListener('input', () => {
        (checkbox as HTMLInputElement).indeterminate = true
      }, { once: true })
    })
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      form.name,
      form.sampleInput,
      undefined,
      form.id,
    )).resolves.toMatchObject({ structuredContent: { targetStateVerified: true } })
    expect(await page.locator('#late-checkbox').evaluate((checkbox) =>
      (checkbox as HTMLInputElement).indeterminate)).toBe(false)
    expect(internalServiceState(service).sessions).toBe(2)
  })

  it('keeps follow-up actions bound when a page handler would shift the catalog', async () => {
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
    expect(shifted.analysis.domEvidence.map(({ label }) => label)).toEqual(['Initial search', 'Category filter'])
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

  it('does not invoke a page handler that would move a visible control out of the viewport', async () => {
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
    )).resolves.toMatchObject({ structuredContent: { targetStateVerified: true } })
    expect(await internalSession(service, analysis.sessionId).page.locator('[type=search]').evaluate(
      (input) => (input as HTMLElement).style.transform,
    )).toBe('')
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

  it('does not invoke a page handler that would fully clip a control', async () => {
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
    )).resolves.toMatchObject({ structuredContent: { targetStateVerified: true } })
    expect(await internalSession(service, analysis.sessionId).page.locator('[type=search]').evaluate(
      (input) => (input as HTMLElement).style.clipPath,
    )).toBe('')
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

  it('does not invoke a page handler that would hide a control through an ancestor filter', async () => {
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
    )).resolves.toMatchObject({ structuredContent: { targetStateVerified: true } })
    expect(await internalSession(service, analysis.sessionId).page.locator('[type=search]').evaluate(
      (input) => (input.parentElement as HTMLElement).style.filter,
    )).toBe('')
  })

  it('uses CDP paint hit-testing to exclude and revalidate opaque pointer-events-none overlays', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)

    const discoveryService = createService()
    services.push(discoveryService)
    const discovery = await discoveryService.analyze(`${fixture.origin}/paint-occlusion`)
    expect(discovery.domEvidence.map(({ label }) => label)).toEqual(['Painted search'])
    expect(discovery.capabilities.map(({ name }) => name)).toEqual(['prepare_page_search'])

    const actionService = createService()
    services.push(actionService)
    const analysis = await actionService.analyze(`${fixture.origin}/paint-occlusion-action`)
    const search = analysis.capabilities.find(({ name }) => name === 'prepare_page_search')!
    const page = internalSession(actionService, analysis.sessionId).page
    await page.locator('body').evaluate(() => {
      const overlay = document.createElement('div')
      overlay.id = 'late-opaque-overlay'
      overlay.setAttribute('style', 'position:absolute;left:20px;top:30px;width:180px;height:36px;background:#111;z-index:10;pointer-events:none')
      document.body.append(overlay)
    })
    await expect(actionService.execute(
      analysis.sessionId,
      analysis.sessionToken,
      search.name,
      { query: 'must remain hidden' },
      undefined,
      search.id,
    )).rejects.toMatchObject({ code: 'invalid_action', sessionInvalidated: false })
    expect(await page.locator('#action-search').inputValue()).toBe('')

    await page.locator('#late-opaque-overlay').evaluate((overlay) => overlay.remove())
    await expect(actionService.execute(
      analysis.sessionId,
      analysis.sessionToken,
      search.name,
      { query: 'painted again' },
      undefined,
      search.id,
    )).resolves.toMatchObject({ structuredContent: { targetStateVerified: true } })
  })

  it('requires bounded target paint evidence and rejects late transparency before mutation', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService()
    services.push(service)
    const analysis = await service.analyze(`${fixture.origin}/paint-evidence-contract`)

    expect(analysis.domEvidence.map(({ label }) => label)).toEqual([
      'Painted custom search',
      'Native painted search',
      'Visible placeholder search',
      'Visible text fill',
      'OKLab painted search',
      'Painted image link',
    ])
    const search = analysis.capabilities.find(({ name }) => name === 'prepare_page_search')!
    const page = internalSession(service, analysis.sessionId).page
    expect(analysis.domEvidence.find(({ id }) => search.evidenceIds.includes(id))?.label)
      .toBe('Painted custom search')

    await page.locator('#painted-custom-search').evaluate((input) => {
      ;(input as HTMLElement).style.border = '0'
    })
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      search.name,
      { query: 'must remain unpainted' },
      undefined,
      search.id,
    )).rejects.toMatchObject({ code: 'invalid_action', sessionInvalidated: false })
    expect(await page.locator('#painted-custom-search').inputValue()).toBe('')

    await page.locator('#painted-custom-search').evaluate((input) => {
      ;(input as HTMLElement).style.border = '2px solid rgb(30, 90, 180)'
    })
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      search.name,
      { query: 'painted control' },
      undefined,
      search.id,
    )).resolves.toMatchObject({ structuredContent: { targetStateVerified: true } })
  })

  it('uses only the selected option and current textarea value as rendered text paint', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService()
    services.push(service)
    const analysis = await service.analyze(`${fixture.origin}/paint-text-state-contract`)

    expect(analysis.domEvidence.map(({ label }) => label)).toEqual([
      'Painted listbox filter',
      'Painted selected filter',
      'Visible input placeholder',
      'Visible textarea placeholder',
      'Painted current textarea',
      'Painted supporting field',
    ])

    const filter = analysis.capabilities.find(({ name }) => name === 'set_page_filter')!
    const filtered = await service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      filter.name,
      filter.sampleInput,
      undefined,
      filter.id,
    )
    expect(filtered).toMatchObject({ structuredContent: { targetStateVerified: true } })

    const form = filtered.analysis.capabilities.find(({ name }) => name === 'prepare_visible_form')!
    await expect(service.execute(
      filtered.analysis.sessionId,
      filtered.analysis.sessionToken,
      form.name,
      form.sampleInput,
      undefined,
      form.id,
    )).resolves.toMatchObject({ structuredContent: { targetStateVerified: true } })
  })

  it('bounds the deduplicated control and private-source analysis watch union', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService()
    services.push(service)

    const analysis = await service.analyze(`${fixture.origin}/analysis-watch-budget`)
    expect(analysis.domEvidence).toHaveLength(64)
    const search = analysis.capabilities.find(({ kind }) => kind === 'prepare_search')!
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      search.name,
      search.sampleInput,
      undefined,
      search.id,
    )).resolves.toMatchObject({ structuredContent: { targetStateVerified: true } })

    const overflowService = createService()
    services.push(overflowService)
    await expect(overflowService.analyze(
      `${fixture.origin}/analysis-watch-budget-overflow`,
    )).rejects.toMatchObject({ code: 'unsupported_page', status: 422 })
    expect(internalServiceState(overflowService)).toEqual({ sessions: 0, reservations: 0 })
  }, 90_000)

  it('retries document id retargeting only when captured evidence uses id references', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    let referencedCaptureCalls = 0
    let referencedRetargetConsumed = false
    let referencedRetargetActive = false
    const referenced = createService({
      beforeAnalysisScreenshot: async (page, attempt) => {
        referencedCaptureCalls += 1
        if (attempt !== 0 || referencedRetargetConsumed) return
        referencedRetargetConsumed = true
        referencedRetargetActive = true
        await page.locator('#watch-id-retarget-decoy').evaluate((node) => {
          node.id = 'watch-form-reference'
        })
      },
      afterAnalysisScreenshot: async (page) => {
        if (!referencedRetargetActive) return
        referencedRetargetActive = false
        await page.locator('span').filter({ hasText: 'Credit card number' }).evaluate((node) => {
          node.id = 'watch-id-retarget-decoy'
        })
      },
    })
    services.push(referenced)
    const referencedAnalysis = await referenced.analyze(
      `${fixture.origin}/analysis-owner-watchset`,
    )
    expect(referencedCaptureCalls).toBe(2)
    expect(JSON.stringify(referencedAnalysis)).not.toContain('Credit card number')
    const form = referencedAnalysis.capabilities.find(({ kind }) => kind === 'prepare_form')!
    await expect(referenced.execute(
      referencedAnalysis.sessionId,
      referencedAnalysis.sessionToken,
      form.name,
      form.sampleInput,
      undefined,
      form.id,
    )).resolves.toMatchObject({ structuredContent: { targetStateVerified: true } })

    let continuousCaptureCalls = 0
    const continuous = createService({
      beforeAnalysisScreenshot: async (page) => {
        continuousCaptureCalls += 1
        await page.locator('#watch-id-retarget-decoy').evaluate((node) => {
          node.id = 'watch-form-reference'
        })
      },
      afterAnalysisScreenshot: async (page) => {
        await page.locator('span').filter({ hasText: 'Credit card number' }).evaluate((node) => {
          node.id = 'watch-id-retarget-decoy'
        })
      },
    })
    services.push(continuous)
    await expect(continuous.analyze(
      `${fixture.origin}/analysis-owner-watchset`,
    )).rejects.toMatchObject({ code: 'unsupported_page', status: 422 })
    expect(continuousCaptureCalls).toBe(2)
    expect(internalServiceState(continuous)).toEqual({ sessions: 0, reservations: 0 })

    let unreferencedCaptureCalls = 0
    const unreferenced = createService({
      beforeAnalysisScreenshot: async (page) => {
        unreferencedCaptureCalls += 1
        await page.locator('#unreferenced-id-decoy').evaluate((node) => {
          node.id = 'temporary-unreferenced-id'
        })
      },
      afterAnalysisScreenshot: async (page) => {
        await page.locator('#temporary-unreferenced-id').evaluate((node) => {
          node.id = 'unreferenced-id-decoy'
        })
      },
    })
    services.push(unreferenced)
    const unreferencedAnalysis = await unreferenced.analyze(
      `${fixture.origin}/paint-text-state-contract`,
    )
    expect(unreferencedCaptureCalls).toBe(1)
    expect(unreferencedAnalysis.capabilities.length).toBeGreaterThan(0)
  }, 90_000)

  it('isolates explicit form and label-for id retarget capture guards', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const cases = [
      {
        route: '/analysis-id-reference-explicit-form',
        decoy: 'explicit-form',
        targetId: 'explicit-form-owner',
        capabilityKind: 'prepare_form',
      },
      {
        route: '/analysis-id-reference-label-for',
        decoy: 'label-for',
        targetId: 'label-for-control',
        capabilityKind: 'prepare_search',
      },
    ] as const

    for (const testCase of cases) {
      let captureCalls = 0
      const service = createService({
        beforeAnalysisScreenshot: async (page, attempt) => {
          captureCalls += 1
          if (attempt !== 0) return
          await page.locator(`[data-id-retarget-decoy="${testCase.decoy}"]`).evaluate(
            (node, targetId) => { node.id = targetId },
            testCase.targetId,
          )
        },
        afterAnalysisScreenshot: async (page, attempt) => {
          if (attempt !== 0) return
          await page.locator(`[data-id-retarget-decoy="${testCase.decoy}"]`).evaluate(
            (node, decoy) => { node.id = `${decoy}-decoy` },
            testCase.decoy,
          )
        },
      })
      services.push(service)
      const analysis = await service.analyze(`${fixture.origin}${testCase.route}`)
      expect(captureCalls).toBe(2)
      expect(analysis.capabilities.some(({ kind }) => kind === testCase.capabilityKind)).toBe(true)
      expect(JSON.stringify(analysis)).not.toMatch(/Credit card number|Payment/)
      expect(await service.closeSession(analysis.sessionId, analysis.sessionToken)).toBe(true)
    }
  }, 90_000)

  it('excludes transparent and zero-geometry controls from visible evidence and capabilities', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService()
    services.push(service)
    const analysis = await service.analyze(`${fixture.origin}/visibility`)

    expect(analysis.domEvidence.map(({ label }) => label)).toEqual(['Visible search', 'Visible link'])
    expect(analysis.capabilities.map(({ name }) => name)).toEqual(['prepare_page_search', 'open_page_link'])
  })

  it('bounds DOM traversal, disabled-option inspection, labels, references, and text while keeping the session usable', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService()
    services.push(service)
    const analysis = await service.analyze(`${fixture.origin}/bounded-dom`)

    expect(analysis.domEvidence.length).toBeLessThanOrEqual(80)
    expect(analysis.domEvidence.map(({ label }) => label)).toContain('Bounded search')
    expect(analysis.domEvidence.map(({ label }) => label)).not.toContain('Late unbounded search')
    expect(analysis.capabilities.map(({ name }) => name)).not.toContain('set_page_filter')
    expect(analysis.domEvidence.find(({ label }) => label === 'Many labels')?.sensitive).toBe(true)
    expect(analysis.domEvidence.find(({ label }) => label === 'Many references')?.sensitive).toBe(true)
    expect(analysis.domEvidence.find(({ label }) => label === 'Huge autocomplete')?.sensitive).toBe(true)
    expect(analysis.domEvidence.some(({ label, sensitive }) => label.length === 140 && sensitive)).toBe(true)
    expect(analysis.domEvidence.find(({ label }) => label === 'Huge description')?.sensitive).toBe(true)
    for (const label of [
      'Huge numeric min',
      'Huge numeric max',
      'Huge numeric step',
      'Huge numeric value',
      'Huge date min',
      'Huge date max',
      'Huge date step',
      'Huge link path',
    ]) {
      expect(analysis.domEvidence.find((evidence) => evidence.label === label)?.sensitive).toBe(true)
    }
    expect(analysis.capabilities.map(({ name }) => name)).not.toContain('open_page_link')

    const search = analysis.capabilities.find(({ name }) => name === 'prepare_page_search')!
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      search.name,
      { query: 'bounded and usable' },
      undefined,
      search.id,
    )).resolves.toMatchObject({
      structuredContent: { isolatedStateChanged: true, targetStateVerified: true },
    })
  }, 15_000)

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
      'Neutral field N',
    ])

    const linkAnalysis = await service.analyze(`${fixture.origin}/unsafe-links`)
    const navigation = linkAnalysis.capabilities.find(({ name }) => name === 'open_page_link')!
    expect(navigation.evidenceIds).toHaveLength(1)
    const safeLink = linkAnalysis.domEvidence.find(({ id }) => navigation.evidenceIds.includes(id))
    expect(safeLink?.label).toBe('History')
    expect(linkAnalysis.domEvidence.filter(({ type, sensitive }) => type === 'link' && sensitive)).toHaveLength(6)
  })

  it('checks bounded accessible labels and descriptions, including SVG text, for sensitive evidence', async () => {
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
      { label: 'Safe described field', sensitive: false },
      { label: 'Password described field', sensitive: true },
      { label: 'SVG described field', sensitive: true },
    ])
    const form = analysis.capabilities.find(({ name }) => name === 'prepare_visible_form')!
    expect(Object.keys((form.inputSchema.properties ?? {}) as object)).toEqual(['field_1', 'field_2', 'field_3'])
    expect(JSON.stringify(form)).not.toMatch(/Optional context|password|Credit card number/i)
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

  it('blocks WebTransport egress process-wide across page and worker realms', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const probe = createSocket('udp4')
    let probeDatagrams = 0
    probe.on('message', () => { probeDatagrams += 1 })
    probe.bind(0, '127.0.0.1')
    await once(probe, 'listening')
    const probeAddress = probe.address()
    const fixtureAddress = fixture.server.address()
    if (typeof probeAddress === 'string' || !fixtureAddress || typeof fixtureAddress === 'string') {
      throw new Error('WebTransport fixture did not expose local ports.')
    }
    const origin = `http://127.0.0.1:${fixtureAddress.port}`
    const service = new WrapperProofService({
      actionSettleMs: 20,
      resolveTarget: async (value) => {
        const url = new URL(value)
        return {
          url: url.toString(),
          origin: url.origin,
          hostname: url.hostname,
          pinnedAddress: '127.0.0.1',
          addresses: [{ address: '127.0.0.1', family: 4 }],
        }
      },
    })
    services.push(service)

    try {
      const analysis = await service.analyze(
        `${origin}/webtransport-egress?port=${probeAddress.port}`,
      )
      const page = internalSession(service, analysis.sessionId).page
      await page.waitForTimeout(1_000)
      const realmResults = await page.evaluate(() =>
        (globalThis as typeof globalThis & {
          webTransportProof: Record<string, string>
        }).webTransportProof)
      expect(realmResults).toEqual({
        window: 'blocked',
        dedicated: 'blocked',
        shared: 'blocked',
        worklet: 'not-exposed',
      })
      await new Promise((resolve) => setTimeout(resolve, 250))
      expect(probeDatagrams).toBe(0)
      expect(analysis.capabilities.some(({ kind }) => kind === 'prepare_search')).toBe(true)
    } finally {
      probe.close()
      await once(probe, 'close')
    }
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

  it('does not invoke a page handler that would reset the prepared value', async () => {
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
    )).resolves.toMatchObject({ structuredContent: { targetStateVerified: true } })
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(await internalSession(service, analysis.sessionId).page.locator('[type=search]').inputValue())
      .toBe('agent-value')
  })

  it('does not invoke hostile DOM reordering handlers and keeps the original backend node', async () => {
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
    )).resolves.toMatchObject({ structuredContent: { targetStateVerified: true } })
    const page = internalSession(service, analysis.sessionId).page
    expect(await page.locator('input[type=search]').count()).toBe(1)
    expect(await page.locator('input[type=search]').inputValue()).toBe('agent-value')
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

  it('screens destructive navigation terms consistently at discovery, redirect, and final URL boundaries', async () => {
    expect(isConsequentialNavigationUrl('https://example.com/delete-account')).toBe(true)
    expect(isConsequentialNavigationUrl('https://example.com/unsubscribe?token=agent-secret')).toBe(true)
    expect(isConsequentialNavigationUrl('https://example.com/token/agent-secret')).toBe(true)
    expect(isConsequentialNavigationUrl('https://example.com/tokens/agent-secret')).toBe(true)
    expect(isConsequentialNavigationUrl('https://example.com/profile?token=agent-secret')).toBe(true)
    expect(isConsequentialNavigationUrl('https://example.com/profile?tokens=agent-secret')).toBe(true)
    expect(isConsequentialNavigationUrl('https://example.com/profile#logout')).toBe(true)
    expect(isConsequentialNavigationUrl('https://example.com/konto#l%C3%B6schen')).toBe(true)
    expect(isConsequentialNavigationUrl('https://example.com/profile-overview?section=details#history')).toBe(false)

    const fixture = await startFixture()
    fixtures.push(fixture)
    const capabilityAndIndex = (
      snapshot: Awaited<ReturnType<WrapperProofService['analyze']>>,
      label: string,
    ) => {
      const capability = snapshot.capabilities.find(({ kind }) => kind === 'navigation')!
      const labels = capability.evidenceIds.map((id) =>
        snapshot.domEvidence.find((evidence) => evidence.id === id)?.label)
      return { capability, linkIndex: labels.indexOf(label) }
    }

    const discoveryService = createService()
    services.push(discoveryService)
    const discovery = await discoveryService.analyze(`${fixture.origin}/destructive-navigation-source`)
    const navigation = discovery.capabilities.find(({ kind }) => kind === 'navigation')!
    const advertisedLabels = navigation.evidenceIds.map((id) =>
      discovery.domEvidence.find((evidence) => evidence.id === id)?.label)
    expect(advertisedLabels).not.toEqual(expect.arrayContaining([
      'Delete account',
      'Unsubscribe',
      'Log out',
      'Konto löschen',
    ]))
    const neutral = capabilityAndIndex(discovery, 'Neutral overview')
    expect(neutral.linkIndex).toBeGreaterThanOrEqual(0)
    await expect(discoveryService.execute(
      discovery.sessionId,
      discovery.sessionToken,
      neutral.capability.name,
      { linkIndex: neutral.linkIndex },
      undefined,
      neutral.capability.id,
    )).resolves.toMatchObject({
      finalUrl: `${fixture.origin}/about#overview`,
      structuredContent: { targetStateVerified: true },
    })

    const redirectService = createService()
    services.push(redirectService)
    const redirectAnalysis = await redirectService.analyze(`${fixture.origin}/destructive-navigation-source`)
    const redirect = capabilityAndIndex(redirectAnalysis, 'Neutral redirect label')
    await expect(redirectService.execute(
      redirectAnalysis.sessionId,
      redirectAnalysis.sessionToken,
      redirect.capability.name,
      { linkIndex: redirect.linkIndex },
      undefined,
      redirect.capability.id,
    )).rejects.toMatchObject({ code: 'invalid_action', sessionInvalidated: true })
    expect(fixture.requests).toContain('/destructive-redirect')
    expect(fixture.requests).not.toContain('/remove-profile')

    const finalService = createService()
    services.push(finalService)
    const finalAnalysis = await finalService.analyze(`${fixture.origin}/destructive-navigation-source`)
    const late = capabilityAndIndex(finalAnalysis, 'Late destructive route')
    await expect(finalService.execute(
      finalAnalysis.sessionId,
      finalAnalysis.sessionToken,
      late.capability.name,
      { linkIndex: late.linkIndex },
      undefined,
      late.capability.id,
    )).rejects.toMatchObject({ code: 'invalid_action', sessionInvalidated: true })
    expect(fixture.requests).toContain('/late-destructive-route')

    for (const path of [
      '/delete-account',
      '/unsubscribe?token=initial',
      '/logout',
      '/konto#l%C3%B6schen',
    ]) {
      const initialService = createService()
      services.push(initialService)
      await expect(initialService.analyze(`${fixture.origin}${path}`)).rejects.toMatchObject({
        code: 'unsupported_page',
      })
      expect(internalServiceState(initialService)).toEqual({ sessions: 0, reservations: 0 })
    }
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

  it('blocks consequential same-origin static resources during analysis and navigation', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    for (const [kind, resourcePath] of [
      ['script', '/purchase-resource.js'],
      ['image', '/purchase-resource.svg'],
      ['style', '/purchase-resource.css'],
      ['font', '/purchase-resource.woff2'],
    ] as const) {
      const service = createService()
      services.push(service)
      const before = fixture.requests.length
      await expect(service.analyze(
        `${fixture.origin}/resource-policy-initial?kind=${kind}`,
      )).rejects.toMatchObject({ code: 'unsupported_page', status: 422 })
      expect(fixture.requests.slice(before), kind).not.toContain(resourcePath)
      expect(internalServiceState(service), kind).toEqual({ sessions: 0, reservations: 0 })
    }
    for (const [selector, target] of [['alpha', 'pay'], ['beta', 'payment']] as const) {
      const service = createService()
      services.push(service)
      const before = fixture.requests.length
      await expect(service.analyze(
        `${fixture.origin}/resource-policy-initial?kind=style&target=${selector}`,
      )).rejects.toMatchObject({ code: 'unsupported_page', status: 422 })
      expect(fixture.requests.slice(before), target).not.toContain(`/${target}-resource.css`)
      expect(internalServiceState(service), target).toEqual({ sessions: 0, reservations: 0 })
    }

    const safeService = createService()
    services.push(safeService)
    const safeAnalysis = await safeService.analyze(`${fixture.origin}/resource-policy-safe`)
    expect(safeAnalysis.capabilities.some(({ kind }) => kind === 'prepare_search')).toBe(true)
    expect(fixture.requests).toEqual(expect.arrayContaining([
      '/neutral-resource.js',
      '/neutral-resource.css',
      '/neutral-resource.svg',
      '/neutral-resource.woff2',
    ]))

    let delayedResourceInjected = false
    const delayedActionService = createService({
      beforeAnalysisScreenshot: async (page) => {
        if (
          delayedResourceInjected
          || new URL(page.url()).pathname !== '/resource-policy-action-destination'
        ) return
        delayedResourceInjected = true
        await page.evaluate(() => new Promise<void>((resolve) => {
          const stylesheet = document.createElement('link')
          const settle = () => resolve()
          stylesheet.rel = 'stylesheet'
          stylesheet.href = '/checkout-delayed-action.css'
          stylesheet.addEventListener('load', settle, { once: true })
          stylesheet.addEventListener('error', settle, { once: true })
          document.head.append(stylesheet)
          setTimeout(settle, 1_000)
        }))
      },
    })
    services.push(delayedActionService)
    const actionAnalysis = await delayedActionService.analyze(`${fixture.origin}/resource-policy-action-source`)
    const navigation = actionAnalysis.capabilities.find(({ kind }) => kind === 'navigation')!
    await expect(delayedActionService.execute(
      actionAnalysis.sessionId,
      actionAnalysis.sessionToken,
      navigation.name,
      navigation.sampleInput,
      undefined,
      navigation.id,
    )).rejects.toMatchObject({ code: 'invalid_action', sessionInvalidated: true })
    expect(delayedResourceInjected).toBe(true)
    expect(fixture.requests).toContain('/resource-policy-action-destination')
    expect(fixture.requests).not.toContain('/checkout-delayed-action.css')
    expect(internalServiceState(delayedActionService)).toEqual({ sessions: 0, reservations: 0 })
  }, 60_000)

  it('blocks pay and payment navigation terms without rejecting neutral containing words', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService()
    services.push(service)

    expect(isConsequentialNavigationUrl('https://example.test/üpayö')).toBe(false)
    expect(isConsequentialNavigationUrl('https://example.test/üpaymentö')).toBe(false)
    expect(isConsequentialNavigationUrl('https://example.test/pay')).toBe(true)
    expect(isConsequentialNavigationUrl('https://example.test/payment')).toBe(true)

    const analysis = await service.analyze(`${fixture.origin}/navigation-finance-boundaries`)

    expect(analysis.domEvidence.find(({ label }) => label === 'Pay destination')).toMatchObject({ sensitive: true })
    expect(analysis.domEvidence.find(({ label }) => label === 'Payment destination')).toMatchObject({ sensitive: true })
    for (const label of ['Repayment overview', 'Payload overview', 'Paymentology overview']) {
      expect(analysis.domEvidence.find((evidence) => evidence.label === label)).toMatchObject({ sensitive: false })
    }
    const navigation = analysis.capabilities.find(({ name }) => name === 'open_page_link')!
    expect(navigation.inputSchema).toMatchObject({
      properties: { linkIndex: { minimum: 0, maximum: 2 } },
    })
  })

  it('publishes no evidence from consequential initial, redirected, or encoded hash destinations', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    for (const path of [
      '/purchase',
      '/pay',
      '/payment',
      '/initial-consequential-redirect',
      '/initial-consequential-hash',
      '/about#/%63heckout',
    ]) {
      const requestsBefore = fixture.requests.length
      let screenshotCalls = 0
      const service = createService({
        beforeAnalysisScreenshot: async () => { screenshotCalls += 1 },
      })
      services.push(service)
      await expect(service.analyze(`${fixture.origin}${path}`)).rejects.toMatchObject({
        code: 'unsupported_page',
        status: 422,
      })
      expect(screenshotCalls, path).toBe(0)
      expect(internalServiceState(service), path).toEqual({ sessions: 0, reservations: 0 })
      const attemptedRequests = fixture.requests.slice(requestsBefore)
      if (path === '/initial-consequential-redirect') {
        expect(attemptedRequests).toContain('/initial-consequential-redirect')
      }
      if (path === '/purchase' || path === '/about#/%63heckout') {
        expect(attemptedRequests).toHaveLength(0)
      }
      expect(attemptedRequests).not.toContain('/purchase')
    }
  })

  it('excludes consequential hash routes, allows neutral fragments, and rejects a late hash-router transition', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)

    const safeService = createService()
    services.push(safeService)
    const safeAnalysis = await safeService.analyze(`${fixture.origin}/fragment-links`)
    expect(safeAnalysis.domEvidence.find(({ label }) => label === 'Unsafe fragment route'))
      .toMatchObject({ sensitive: true })
    const safeNavigation = safeAnalysis.capabilities.find(({ name }) => name === 'open_page_link')!
    expect(safeNavigation.inputSchema).toMatchObject({ properties: { linkIndex: { maximum: 1 } } })
    await expect(safeService.execute(
      safeAnalysis.sessionId,
      safeAnalysis.sessionToken,
      safeNavigation.name,
      { linkIndex: 0 },
      undefined,
      safeNavigation.id,
    )).resolves.toMatchObject({
      finalUrl: `${fixture.origin}/about#overview`,
      structuredContent: { targetStateVerified: true, navigationOccurred: true },
    })

    const lateService = createService()
    services.push(lateService)
    const lateAnalysis = await lateService.analyze(`${fixture.origin}/fragment-links`)
    const lateNavigation = lateAnalysis.capabilities.find(({ name }) => name === 'open_page_link')!
    await expect(lateService.execute(
      lateAnalysis.sessionId,
      lateAnalysis.sessionToken,
      lateNavigation.name,
      { linkIndex: 1 },
      undefined,
      lateNavigation.id,
    )).rejects.toMatchObject({ code: 'invalid_action', sessionInvalidated: true })
    expect(fixture.requests).toContain('/late-fragment')
    expect(internalServiceState(lateService)).toEqual({ sessions: 0, reservations: 0 })
  })

  it('does not invoke page handlers that would change URL state during preparation', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)

    const pushStateService = createService()
    services.push(pushStateService)
    const pushStateAnalysis = await pushStateService.analyze(`${fixture.origin}/preparation-url-state`)
    const pushStateSearch = pushStateAnalysis.capabilities.find(({ name }) => name === 'prepare_page_search')!
    await expect(pushStateService.execute(
      pushStateAnalysis.sessionId,
      pushStateAnalysis.sessionToken,
      pushStateSearch.name,
      { query: 'hostile-push' },
      undefined,
      pushStateSearch.id,
    )).resolves.toMatchObject({
      finalUrl: `${fixture.origin}/preparation-url-state`,
      structuredContent: { targetStateVerified: true, navigationOccurred: false },
    })
    expect(internalServiceState(pushStateService)).toEqual({ sessions: 1, reservations: 0 })

    const malformedService = createService()
    services.push(malformedService)
    const malformedAnalysis = await malformedService.analyze(`${fixture.origin}/preparation-url-state`)
    const malformedSearch = malformedAnalysis.capabilities.find(({ name }) => name === 'prepare_page_search')!
    await expect(malformedService.execute(
      malformedAnalysis.sessionId,
      malformedAnalysis.sessionToken,
      malformedSearch.name,
      { query: 'malformed-push' },
      undefined,
      malformedSearch.id,
    )).resolves.toMatchObject({
      finalUrl: `${fixture.origin}/preparation-url-state`,
      structuredContent: { targetStateVerified: true, navigationOccurred: false },
    })
    expect(internalServiceState(malformedService)).toEqual({ sessions: 1, reservations: 0 })

    const hashService = createService()
    services.push(hashService)
    const hashAnalysis = await hashService.analyze(`${fixture.origin}/preparation-url-state`)
    const hashFilter = hashAnalysis.capabilities.find(({ name }) => name === 'set_page_filter')!
    await expect(hashService.execute(
      hashAnalysis.sessionId,
      hashAnalysis.sessionToken,
      hashFilter.name,
      { optionIndex: 1 },
      undefined,
      hashFilter.id,
    )).resolves.toMatchObject({
      finalUrl: `${fixture.origin}/preparation-url-state`,
      structuredContent: { targetStateVerified: true, navigationOccurred: false },
    })
    expect(internalServiceState(hashService)).toEqual({ sessions: 1, reservations: 0 })

    const neutralService = createService()
    services.push(neutralService)
    const neutralAnalysis = await neutralService.analyze(`${fixture.origin}/preparation-url-state`)
    const neutralSearch = neutralAnalysis.capabilities.find(({ name }) => name === 'prepare_page_search')!
    await expect(neutralService.execute(
      neutralAnalysis.sessionId,
      neutralAnalysis.sessionToken,
      neutralSearch.name,
      { query: 'neutral-hash' },
      undefined,
      neutralSearch.id,
    )).resolves.toMatchObject({
      finalUrl: `${fixture.origin}/preparation-url-state`,
      structuredContent: {
        navigationOccurred: false,
        targetStateVerified: true,
      },
    })
  }, 10_000)

  it('blocks consequential subframes without invalidating a safe main-frame navigation', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService()
    services.push(service)
    const analysis = await service.analyze(`${fixture.origin}/iframe-navigation-source`)
    const navigation = analysis.capabilities.find(({ name }) => name === 'open_page_link')!
    const session = internalSession(service, analysis.sessionId)
    const cdp = session.cdp as unknown as {
      send(method: string, params?: Record<string, unknown>): Promise<unknown>
    }
    const originalSend = cdp.send.bind(cdp)
    let frameOwnerAttempts = 0
    cdp.send = async (method, params) => {
      if (method === 'DOM.getFrameOwner') {
        frameOwnerAttempts += 1
        if (frameOwnerAttempts === 1) {
          throw new Error('The frame owner is not available yet.')
        }
      }
      return originalSend(method, params)
    }

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
    expect(frameOwnerAttempts).toBeGreaterThanOrEqual(2)
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

  it('invalidates when a persistent child frame cannot be removed within the bounded retry', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService()
    services.push(service)
    const analysis = await service.analyze(`${fixture.origin}/iframe-navigation-source`)
    const navigation = analysis.capabilities.find(({ name }) => name === 'open_page_link')!
    const session = internalSession(service, analysis.sessionId)
    const cdp = session.cdp as unknown as {
      send(method: string, params?: Record<string, unknown>): Promise<unknown>
    }
    const originalSend = cdp.send.bind(cdp)
    let frameOwnerAttempts = 0
    cdp.send = async (method, params) => {
      if (method === 'DOM.getFrameOwner') {
        frameOwnerAttempts += 1
        throw new Error('The persistent frame owner cannot be retained.')
      }
      return originalSend(method, params)
    }

    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      navigation.name,
      { linkIndex: 0 },
      undefined,
      navigation.id,
    )).rejects.toMatchObject({ code: 'invalid_action', sessionInvalidated: true })

    expect(frameOwnerAttempts).toBe(6)
    expect(fixture.requests).toContain('/iframe-destination')
    expect(fixture.requests).not.toContain('/booking-widget')
    expect(internalServiceState(service)).toEqual({ sessions: 0, reservations: 0 })
  })

  it('preserves the analysis error contract when a frame-owner retry crosses the freeze boundary', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    let frameOwnerAttempts = 0
    const service = createService({
      beforeSubframeOwnerLookup: async (page) => {
        if (new URL(page.url()).pathname !== '/late-persistent-initial-subframe') return
        frameOwnerAttempts += 1
        throw new Error('The initial frame owner remains unavailable.')
      },
    })
    services.push(service)

    await expect(service.analyze(
      `${fixture.origin}/late-persistent-initial-subframe`,
    )).rejects.toMatchObject({ code: 'unsupported_page', status: 422 })

    expect(frameOwnerAttempts).toBe(6)
    expect(internalServiceState(service)).toEqual({ sessions: 0, reservations: 0 })
  })

  it('removes non-network child frames before their DOM or pixels enter main-frame evidence', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const neutralService = createService()
    services.push(neutralService)
    const neutral = await neutralService.analyze(
      `${fixture.origin}/non-network-subframe-boundary?kind=neutral`,
    )
    const neutralPage = internalSession(neutralService, neutral.sessionId).page
    expect(neutralPage.frames()).toHaveLength(1)
    expect(await neutralPage.locator('iframe, frame').count()).toBe(0)
    expect(neutral.capabilities.some(({ name }) => name === 'prepare_page_search')).toBe(true)

    for (const kind of ['data', 'blob', 'srcdoc', 'about'] as const) {
      const service = createService()
      services.push(service)
      const analysis = await service.analyze(
        `${fixture.origin}/non-network-subframe-boundary?kind=${kind}`,
      )
      const page = internalSession(service, analysis.sessionId).page
      expect(page.frames(), kind).toHaveLength(1)
      expect(await page.locator('iframe, frame').count(), kind).toBe(0)
      expect(await page.locator('#child-frame-marker').count(), kind).toBe(0)
      expect(analysis.screenshotDataUrl, kind).toBe(neutral.screenshotDataUrl)
      expect(analysis.blockedRequests, kind).toBeGreaterThanOrEqual(1)
      expect(analysis.capabilities.some(({ name }) => name === 'prepare_page_search'), kind).toBe(true)
    }
  }, 30_000)

  it('retries capture when a non-network child frame attaches at the screenshot boundary', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const neutralService = createService()
    services.push(neutralService)
    const neutral = await neutralService.analyze(
      `${fixture.origin}/late-non-network-subframe-boundary`,
    )

    let captureCalls = 0
    const service = createService({
      beforeAnalysisScreenshot: async (page, attempt) => {
        captureCalls += 1
        if (attempt !== 0) return
        await page.evaluate(() => {
          const frame = document.createElement('iframe')
          frame.style.cssText = 'position:absolute;left:20px;top:20px;width:260px;height:90px;border:0;z-index:10;background:red'
          frame.srcdoc = '<body style="margin:0;background:red"><div style="width:100vw;height:100vh;background:red">Child</div></body>'
          document.body.append(frame)
        })
      },
    })
    services.push(service)
    const analysis = await service.analyze(
      `${fixture.origin}/late-non-network-subframe-boundary`,
    )
    const page = internalSession(service, analysis.sessionId).page

    expect(captureCalls).toBe(2)
    expect(page.frames()).toHaveLength(1)
    expect(await page.locator('iframe, frame').count()).toBe(0)
    expect(analysis.screenshotDataUrl).toBe(neutral.screenshotDataUrl)
    expect(analysis.blockedRequests).toBeGreaterThanOrEqual(1)
  }, 15_000)

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

  it('propagates abort after action admission and leaves no stale server state', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const controller = new AbortController()
    let writeBoundaryReached = 0
    const service = createService({
      beforeControlWrite: async () => {
        writeBoundaryReached += 1
        controller.abort()
        throw new DOMException('The request was aborted.', 'AbortError')
      },
    })
    services.push(service)
    const analysis = await service.analyze(`${fixture.origin}/action-operability`)
    const search = analysis.capabilities.find(({ name }) => name === 'prepare_page_search')!
    let completedResult: unknown

    const pending = service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      search.name,
      { query: 'must not be written' },
      controller.signal,
      search.id,
    ).then((result) => {
      completedResult = result
      return result
    })

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(completedResult).toBeUndefined()
    expect(writeBoundaryReached).toBe(1)
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      search.name,
      { query: 'stale follow-up' },
      undefined,
      search.id,
    )).rejects.toThrow('session expired')
  })

  it('bounds a delayed accepted action by the absolute session deadline before mutation', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService({ actionStartDelayMs: 150, actionSettleMs: 20 })
    services.push(service)
    const analysis = await service.analyze(`${fixture.origin}/action-operability`)
    const search = analysis.capabilities.find(({ name }) => name === 'prepare_page_search')!
    const session = internalSession(service, analysis.sessionId)
    let inputEvents = 0
    await session.page.exposeFunction('recordExpiryInput', () => { inputEvents += 1 })
    await session.page.locator('#search-control').evaluate((input) => {
      input.addEventListener('input', () => {
        void (window as unknown as { recordExpiryInput: () => Promise<void> }).recordExpiryInput()
      })
    })
    session.expiresAt = Date.now() + 60

    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      search.name,
      { query: 'must not be applied' },
      undefined,
      search.id,
    )).rejects.toMatchObject({
      code: 'session_expired',
      status: 410,
      sessionInvalidated: true,
    })
    expect(inputEvents).toBe(0)
    expect(internalServiceState(service)).toEqual({ sessions: 0, reservations: 0 })
  })

  it('never returns success when the absolute session deadline expires after mutation', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService({ actionSettleMs: 180 })
    services.push(service)
    const analysis = await service.analyze(`${fixture.origin}/action-operability`)
    const search = analysis.capabilities.find(({ name }) => name === 'prepare_page_search')!
    const session = internalSession(service, analysis.sessionId)
    let inputEvents = 0
    await session.page.exposeFunction('recordLateExpiryInput', () => { inputEvents += 1 })
    await session.page.locator('#search-control').evaluate((input) => {
      input.addEventListener('input', () => {
        void (window as unknown as { recordLateExpiryInput: () => Promise<void> }).recordLateExpiryInput()
      })
    })
    session.expiresAt = Date.now() + 80

    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      search.name,
      { query: 'mutated before expiry' },
      undefined,
      search.id,
    )).rejects.toMatchObject({
      code: 'session_expired',
      status: 410,
      sessionInvalidated: true,
    })
    expect(inputEvents).toBe(0)
    expect(internalServiceState(service)).toEqual({ sessions: 0, reservations: 0 })
  })

  it('bounds same-origin navigation and its settling work by the absolute session deadline', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService({ actionSettleMs: 180 })
    services.push(service)
    const analysis = await service.analyze(`${fixture.origin}/`)
    const navigation = analysis.capabilities.find(({ name }) => name === 'open_page_link')!
    internalSession(service, analysis.sessionId).expiresAt = Date.now() + 100

    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      navigation.name,
      { linkIndex: 0 },
      undefined,
      navigation.id,
    )).rejects.toMatchObject({
      code: 'session_expired',
      status: 410,
      sessionInvalidated: true,
    })
    expect(fixture.requests).toContain('/next')
    expect(internalServiceState(service)).toEqual({ sessions: 0, reservations: 0 })
  })

  it('clamps the inner proof session to the outer worker deadline and keeps normal actions usable', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const outerDeadline = Date.now() + 15_000
    const service = createService({ actionSettleMs: 20, sessionExpiresAtMs: outerDeadline })
    services.push(service)
    const analysis = await service.analyze(`${fixture.origin}/action-operability`)
    const search = analysis.capabilities.find(({ name }) => name === 'prepare_page_search')!

    expect(Date.parse(analysis.expiresAt)).toBeLessThanOrEqual(outerDeadline)
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      search.name,
      { query: 'within the lifetime' },
      undefined,
      search.id,
    )).resolves.toMatchObject({
      structuredContent: { isolatedStateChanged: true, targetStateVerified: true },
    })
  }, 30_000)

  it('expires queued actions at the shared absolute deadline and releases the queue', async () => {
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
    const firstExpectation = expect(first).rejects.toMatchObject({
      code: 'session_expired',
      status: 410,
      sessionInvalidated: true,
    })
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

    await firstExpectation
    await secondExpectation
    expect(internalServiceState(service)).toEqual({ sessions: 0, reservations: 0 })
  })

  it('actively destroys local sessions at their TTL and releases capacity without a follow-up request', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService({ sessionTtlMs: 1_800 })
    services.push(service)
    const analysis = await service.analyze(`${fixture.origin}/action-operability`)
    const page = internalSession(service, analysis.sessionId).page
    let pageCloseCount = 0
    page.on('close', () => { pageCloseCount += 1 })
    const remainingMs = Math.max(0, Date.parse(analysis.expiresAt) - Date.now())

    await new Promise((resolve) => setTimeout(resolve, remainingMs + 180))
    await vi.waitFor(() => {
      expect(internalServiceState(service)).toEqual({ sessions: 0, reservations: 0 })
      expect(page.isClosed()).toBe(true)
      expect(pageCloseCount).toBe(1)
    }, { timeout: 2_000 })

    const fresh = await service.analyze(`${fixture.origin}/action-operability`)
    expect(fresh.capabilities.length).toBeGreaterThan(0)
  })

  it('keeps explicit-close and expiry races idempotent', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    const service = createService({ sessionTtlMs: 1_800 })
    services.push(service)
    const analysis = await service.analyze(`${fixture.origin}/action-operability`)
    const page = internalSession(service, analysis.sessionId).page
    let pageCloseCount = 0
    page.on('close', () => { pageCloseCount += 1 })
    const remainingMs = Math.max(0, Date.parse(analysis.expiresAt) - Date.now())

    const concurrentExplicitClose = new Promise<boolean>((resolve) => {
      setTimeout(() => {
        void service.closeSession(analysis.sessionId, analysis.sessionToken).then(resolve)
      }, remainingMs)
    })
    await concurrentExplicitClose
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(pageCloseCount).toBe(1)
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
