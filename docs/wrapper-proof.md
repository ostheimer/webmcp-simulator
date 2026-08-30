# Isolated website wrapper proof

## Product definition

The target product is a wrapper around an ordinary public website that does not
already need WebMCP. The wrapper opens that exact site in a fresh, isolated
browser session, records real DOM, accessibility, and screenshot evidence,
infers only a small allowlist of safe interactions, and registers wrapper-owned
`document.modelContext` tools. Tool calls operate on the isolated session and
refresh the screenshot and activity log in the wrapper.

HeatFlow remains a deterministic fixture and reusable UI/tool-registration
reference. It is not the target website-analysis product.

## Executable proof architecture

```text
React wrapper page
  -> POST /api/wrapper/analyze (local Vite middleware only)
     -> existing public URL syntax and special-address checks
     -> resolve every DNS answer; fail if any answer is non-public
     -> launch one ephemeral Chromium process with the hostname pinned
     -> allow only document/static-resource GET/HEAD to the exact validated
        origin (scheme, host, port); block XHR/fetch even during observation
     -> reject a declared response above 4 MiB and continuously stop loading
        when decoded/encoded CDP traffic exceeds 4 MiB per resource or 20 MiB
        cumulatively across the short-lived session
     -> disable QUIC as the process-wide WebTransport egress boundary for the
        pinned, regression-tested Chromium build;
        additionally block WebTransport in document realms and disable dedicated
        and shared worker construction before page scripts run
     -> block frames, popups, downloads, WebSocket, EventSource, WebRTC,
        sendBeacon, service workers, uploads, and non-read HTTP methods
     -> collect only DOM controls/links with visible pixels inside the fixed
        screenshot viewport after clip-path and ancestor-overflow clipping;
        conservatively exclude element/ancestor CSS filters and masks,
        plus CDP accessibility nodes and the viewport screenshot
     -> put Chromium offline at the capture boundary, then require all
        already-started requests to terminate before exposing any tool
     -> infer fixed-metadata search preparation, filter, safe form preparation,
        or navigation tools with neutral wrapper-owned parameter keys
  <- evidence + proposed tools + screenshot + ephemeral session ID
  -> register wrapper-owned tools through document.modelContext
  -> POST /api/wrapper/action
     -> validate the inferred tool input
     -> bind the call to a wrapper-generated capability ID before queueing;
        stale queued calls fail before mutation instead of reusing a tool name
     -> serialize mutations and propagate cancellation into the browser queue
     -> propagate abandoned analysis requests into local/worker Chromium setup,
        navigation, capture, and immediate session teardown
     -> block every network request during and after preparation
     -> treat explicit same-origin navigation as a separate read-network policy
        and inspect every server-identified main-document redirect hop before
        network continuation without treating blocked subframes as navigation
     -> verify the exact origin and decoded path/query/hash after every action,
        including network-silent search, filter, and form preparation
  <- post-settle verified semantic state + current URL/evidence/tools + measured network result
```

The server plugin is `apply: "serve"`; it is absent from the production Vite
bundle. This branch does not change or deploy the existing Vercel production
site.

## Detection contract

The proof recognizes only:

- a visible search input that can be prepared without claiming search results;
- a visible select with bounded filter evidence;
- at least two visible, non-sensitive fields in the same form;
- visible, same-origin HTTP(S) links that are not downloads, popups, or paths with
  consequential keywords.

Page labels are displayed as explicitly untrusted evidence. They are never
copied into tool titles, descriptions, parameter names, or parameter
instructions. Form parameters use neutral `field_1`, `field_2`, and similar
wrapper-owned keys; CDP backend-node references and remote identifiers remain
server-only.
Every accessible-name and description source is safety evidence: `aria-label`,
`aria-description`, bounded `aria-labelledby` and `aria-describedby` references
(including non-HTML elements and private native textbox, selected-option, and
range-value semantics), associated-label text/`aria-label`/`title` and
descendant image alts, every bounded descendant image alt from a link,
placeholder, name, ID, and autocomplete. Reference, label, image, traversal,
and aggregate text budgets fail closed on overflow. Controls without a genuine
bounded identifying source are excluded; public display labels remain bounded
and do not determine whether a field is sensitive. Direct
`aria-disabled="true"` is excluded and revalidated atomically in the same CDP
isolated-world boundary as native disabled/read-only state.
Each control's exact private snapshot also includes its owning form and every
bounded ancestor fieldset: their ARIA/name/ID/title evidence, referenced nodes,
and bounded legends are classified and revalidated before every read, write, or
verification. Overflow in owner count, ancestry, references, text, or aggregate
evidence excludes the control; owner text never enters public tool metadata.
Filter and navigation choices use numeric indices. Password, secret, token,
email, phone, message, payment, account, upload, purchase, booking, publishing,
deletion, and similar controls are excluded.

## Reuse assessment

### Reused from the merged simulator

- `normalizeWebsiteUrl` and the IANA-oriented special-address boundaries;
- `registerTools` with abort-based registration cleanup;
- visible tool, activity, compatibility, and safety patterns;
- HeatFlow as a deterministic fixture and fallback demonstration.

### Reused conceptually from `stash@{0}` / Issue #2

- inspect only visible, effectively enabled, writable, named controls and options;
- derive bounded schemas from native control types, treating `required` as a
  native minimum-length contract and exposing date-like controls only when
  Chromium can enumerate a complete finite min/max/step value set with an
  executable alternative to the analyzed value;
- use native setters/events for React-compatible preparation;
- never call `submit()`, `requestSubmit()`, or a submit button;
- treat labels and choices as untrusted content.

The stash was inspected without applying it. Its Chrome extension, popup,
polyfill, manifest, release scripts, dependencies, and generic form annotation
were not copied. They have different ownership, permissions, and release
responsibilities. The wrapper proof also narrows the prototype by excluding
sensitive and consequential fields and by keeping all page text out of tool
metadata.

## Known proof limits

- Only one validated origin is allowed. Cross-origin redirects and CDN assets
  are blocked, so some sites render partially or are rejected.
- Tool inference covers native controls and links, not canvas controls, shadow
  DOM, cross-origin frames, or interactions that require authentication.
- Classification examines at most 5,000 DOM elements and retains at most 80
  controls. Per-control option, label, ARIA-reference, text-node, and safety-text
  work is separately bounded; Selects inspect at most 200 native options, retain
  at most 30 enabled options, and fail closed when either capture is incomplete.
  Multi-select and indeterminate-checkbox states are excluded and revalidated
  before every isolated state operation. Accessibility evidence uses partial
  CDP queries only for retained controls. Overflow excludes the affected
  interaction.
- Each successful navigation returns the current final URL, re-collects DOM and
  accessibility evidence, replaces the server capability map, and re-registers
  the destination tool catalog before the updated page is shown.
- Ephemeral sessions live in memory for five minutes. Atomic reservations cap
  active plus launching local sessions at three; a fourth client receives a
  capacity error instead of evicting or racing an existing browser. Sessions
  disappear when the dev server stops. There is no durable queue,
  persistence, account, or multi-tenant layer.
- Browser automation detection, CSP, consent walls, or rendering failures are
  reported as unsupported. The wrapper does not bypass them.
- Local analysis has one fixed 35-second deadline beginning before request-body
  consumption. Request abort or deadline expiry propagates through target
  resolution, Chromium launch, CDP setup, navigation, and atomic capture; every
  partial browser/session/reservation is closed before capacity becomes reusable.
- Playwright HTTP and WebSocket routing is not treated as a WebTransport guard.
  The current lockfile-resolved Playwright 1.62.1 / Chromium 151.0.7922.34 build
  runs with QUIC disabled for every renderer realm; this implementation assumption
  must be revalidated before any Chromium or Playwright upgrade because future
  WebTransport transports may differ.
  Document WebTransport and dedicated/shared worker construction are additionally blocked.
  Service workers are disabled by the browser context. Current Chromium exposes
  WebTransport to Window/Worker, not Worklet globals; the regression exercises
  Window, dedicated worker, shared worker, and an AudioWorklet exposure probe.
- Preparation is a network-silent boundary: all HTTP requests are blocked from
  before the first DOM mutation until the session closes. Explicit navigation
  separately permits same-origin document/static-resource GET/HEAD reads and
  reports that policy instead
  of claiming that no external effect occurred. A production service still
  needs a network-level egress firewall and site-specific abuse review because
  HTTP method semantics cannot prove business safety.
- Cancellation closes any session whose browser mutation has begun; callers
  must analyze again instead of continuing from a partially mutated page. The
  wrapper also retires its local analysis, credentials, and registered tools
  after an abort or any error that lacks an explicit trusted non-mutating
  `sessionInvalidated: false`, then sends a best-effort idempotent close.

## Hosting options and operational boundaries

| Option | Fit | Cost and operational boundary |
| --- | --- | --- |
| Local process (this proof) | Best for development and judging | No new service bill. One developer machine, no public availability, no multi-user isolation. |
| Dedicated container/VM browser worker | Small public pilot | Requires sandboxed Chromium, outbound firewall, per-session CPU/RAM limits, concurrency caps, TTL cleanup, rate limiting, abuse monitoring, and patching. Provider prices vary; budget before enabling. |
| Managed browser service | Fastest operational path | Usually billed per browser minute/concurrency and adds an external data processor. Not used or booked in this proof. |
| Vercel UI plus separate browser worker | Likely production split | Keep the React shell on Vercel, but run Chromium in a dedicated worker. Ordinary static/serverless hosting is not the security boundary for untrusted browsers. |

Before any public deployment, add a network sandbox that enforces IP/CIDR
egress after DNS resolution, signed short-lived session authorization, strict
quotas, audit logs without captured personal content, deletion guarantees,
dependency/browser patching, and an independent security review.

## Local run

```bash
npm install
npx playwright install chromium
npm run dev -- --host 127.0.0.1
npm run verify:wrapper
WRAPPER_PROOF_URL=https://www.hotwagner.at/ npm run verify:wrapper
```

The local health endpoint is `GET /api/wrapper/health`. Use the landing-page URL
field to open a public site. Pages that cannot satisfy the isolation policy stay
on the landing screen with a specific unsupported message.
