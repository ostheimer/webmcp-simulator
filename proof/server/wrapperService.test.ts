import { createServer, type Server } from 'node:http'
import { createSocket } from 'node:dgram'
import { once } from 'node:events'
import { gzipSync } from 'node:zlib'
import type { Browser, Page } from 'playwright'
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
          for (let index = 0; index < 7; index += 1) {
            const reference = document.createElement('span');
            reference.id = 'overflow-reference-' + index;
            reference.setAttribute('aria-label', 'x'.repeat(4000));
            document.body.prepend(reference);
          }
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
        </form>`)
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
  maxTargetResourceBytes?: number
  maxTargetSessionBytes?: number
  beforeAnalysisScreenshot?: (page: Page, attempt: number) => Promise<void>
  beforeRadioGroupWrite?: (page: Page) => Promise<void>
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
    maxTargetResourceBytes: options.maxTargetResourceBytes,
    maxTargetSessionBytes: options.maxTargetSessionBytes,
    beforeAnalysisScreenshot: options.beforeAnalysisScreenshot,
    beforeRadioGroupWrite: options.beforeRadioGroupWrite,
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
      'Depth overflow value',
      'Depth overflow detail',
      'Text overflow value',
      'Text overflow detail',
      'Aggregate overflow value',
      'Aggregate overflow detail',
      'Fieldset overflow value',
      'Fieldset overflow detail',
    ]) expect(evidenceByLabel.get(label)?.sensitive).toBe(true)

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

  it('retries an analysis capture after screenshot-bound DOM drift and publishes only the stable state', async () => {
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

    const result = await service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      search.name,
      search.sampleInput,
      undefined,
      search.id,
    )

    expect(captureCalls).toBe(3)
    expect(result.analysis.capabilities.some(({ kind }) => kind === 'prepare_search')).toBe(false)
    expect(result.analysis.capabilities.some(({ kind }) => kind === 'filter')).toBe(false)
    expect(result.analysis.domEvidence.find(({ label }) => label === 'User password')).toMatchObject({ sensitive: true })
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

    const raceService = createService()
    services.push(raceService)
    const raceAnalysis = await raceService.analyze(`${fixture.origin}/unicode-safety-normalization`)
    const raceForm = raceAnalysis.capabilities.find(({ name }) => name === 'prepare_visible_form_2')!
    await expect(raceService.execute(
      raceAnalysis.sessionId,
      raceAnalysis.sessionToken,
      raceForm.name,
      raceForm.sampleInput,
      undefined,
      raceForm.id,
    )).rejects.toMatchObject({ code: 'action_failed', sessionInvalidated: true })
    expect(internalServiceState(raceService)).toEqual({ sessions: 0, reservations: 0 })
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
    expect(filterResult.analysis.title).toBe('visible-two')
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

  it('invalidates when safety evidence changes during the begun action', async () => {
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
    )).rejects.toMatchObject({ code: 'action_failed', sessionInvalidated: true })
    expect(internalServiceState(service)).toEqual({ sessions: 0, reservations: 0 })
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

  it('revalidates checkbox indeterminate state before mutation and after begun page races', async () => {
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
    )).rejects.toMatchObject({ code: 'action_failed', sessionInvalidated: true })
    expect(internalServiceState(service).sessions).toBe(1)
    await expect(service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      form.name,
      form.sampleInput,
      undefined,
      form.id,
    )).rejects.toMatchObject({ code: 'session_expired', sessionInvalidated: true })
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

  it('publishes no evidence from consequential initial, redirected, or encoded hash destinations', async () => {
    const fixture = await startFixture()
    fixtures.push(fixture)
    for (const path of [
      '/purchase',
      '/initial-consequential-redirect',
      '/initial-consequential-hash',
      '/about#/%63heckout',
    ]) {
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

  it('rejects consequential URL state after preparation actions and allows a neutral hash', async () => {
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
    )).rejects.toMatchObject({ code: 'invalid_action', sessionInvalidated: true })
    expect(internalServiceState(pushStateService)).toEqual({ sessions: 0, reservations: 0 })

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
    )).rejects.toMatchObject({ code: 'invalid_action', sessionInvalidated: true })
    expect(internalServiceState(malformedService)).toEqual({ sessions: 0, reservations: 0 })

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
    )).rejects.toMatchObject({ code: 'invalid_action', sessionInvalidated: true })
    expect(internalServiceState(hashService)).toEqual({ sessions: 0, reservations: 0 })

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
      finalUrl: `${fixture.origin}/preparation-url-state#overview`,
      structuredContent: {
        navigationOccurred: false,
        targetStateVerified: true,
      },
    })
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
    expect(inputEvents).toBe(1)
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
    const outerDeadline = Date.now() + 2_000
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
  })

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
