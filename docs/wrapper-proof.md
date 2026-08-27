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
     -> allow only GET/HEAD to that exact hostname
     -> block frames, popups, downloads, WebSocket, EventSource, WebRTC,
        sendBeacon, service workers, uploads, and non-read HTTP methods
     -> collect visible DOM controls/links, CDP accessibility nodes, screenshot
     -> infer fixed-metadata search, filter, safe preparation, or navigation tools
  <- evidence + proposed tools + screenshot + ephemeral session ID
  -> register wrapper-owned tools through document.modelContext
  -> POST /api/wrapper/action
     -> validate the inferred tool input
     -> serialize mutations in the isolated page
     -> fill/select/navigate without form submission
  <- refreshed screenshot + fixed activity result (`externalSubmission: false`)
```

The server plugin is `apply: "serve"`; it is absent from the production Vite
bundle. This branch does not change or deploy the existing Vercel production
site.

## Detection contract

The proof recognizes only:

- a visible search input with native or bounded search evidence;
- a visible select with bounded filter evidence;
- at least two visible, non-sensitive fields in the same form;
- visible, same-host HTTP(S) links that are not downloads, popups, or paths with
  consequential keywords.

Page labels are displayed as explicitly untrusted evidence. They are never
copied into tool titles, descriptions, or parameter instructions. Filter and
navigation choices use numeric indices, keeping page-authored strings out of
the WebMCP schema. Password, email, phone, message, payment, account, upload,
purchase, booking, publishing, deletion, and similar controls are excluded.

## Reuse assessment

### Reused from the merged simulator

- `normalizeWebsiteUrl` and the IANA-oriented special-address boundaries;
- `registerTools` with abort-based registration cleanup;
- visible tool, activity, compatibility, and safety patterns;
- HeatFlow as a deterministic fixture and fallback demonstration.

### Reused conceptually from `stash@{0}` / Issue #2

- inspect only visible, enabled, named controls;
- derive bounded schemas from native control types;
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

- Only one validated hostname is allowed. Cross-host redirects and CDN assets
  are blocked, so some sites render partially or are rejected.
- Tool inference covers native controls and links, not canvas controls, shadow
  DOM, cross-origin frames, or interactions that require authentication.
- Navigation changes the target page but does not yet re-infer and re-register a
  fresh tool catalog for the destination document.
- Ephemeral sessions live in memory for five minutes, are capped at three local
  sessions, and disappear when the dev server stops. There is no durable queue,
  persistence, account, or multi-tenant layer.
- Browser automation detection, CSP, consent walls, or rendering failures are
  reported as unsupported. The wrapper does not bypass them.
- GET is treated as the read-only transport boundary for this proof. A
  production service also needs network-level egress controls and site-specific
  abuse review because HTTP semantics alone cannot prove business safety.

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
