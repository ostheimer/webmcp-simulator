# Production wrapper architecture

The production path keeps the wrapper UI on Vercel and runs each inspected website in a separate, short-lived Vercel Sandbox with Chromium. It does not proxy the website into the user's browser and does not add WebMCP to the original site.

## Request flow

1. `POST /api/wrapper/analyze` validates same-site API use, request size, the per-tab client identifier, the Vercel-supplied client IP, URL syntax, DNS answers, and public-network boundaries.
2. The server creates a cryptographically random, non-semantic Sandbox name. This is only a reconnect locator, never authorization.
3. A separate 256-bit capability token is written into a mode-`0600` worker configuration inside the Sandbox. The worker checks it with a timing-safe comparison before health, analysis, action, or close operations.
4. `Sandbox.create` uses `persistent: false`, a hard five-minute timeout, 2 vCPU/4 GB, a reviewed Chromium snapshot, and a fail-closed network policy.
5. A bundled worker starts on a Unix-domain socket. No browser-control port is exposed publicly.
6. Follow-up calls use only `Sandbox.get({ name, resume: false })`. Unknown and expired names fail closed. The code never calls `getOrCreate` and never creates a replacement during reconnect.
7. `POST /api/wrapper/action` requires the wrapper-generated capability ID alongside the public tool name, then forwards the WebMCP AbortSignal through the Vercel Function, Sandbox command, worker request, and Playwright action. Request-boundary, rate, body, JSON, and required-field failures before `backend.execute` explicitly report `sessionInvalidated: false`; the backend is never reached. A stale queued capability fails before mutation. A begun, unknown, or aborted backend action deletes the Sandbox and returns a sanitized invalidation signal when a response remains possible; only an explicit worker-trusted non-mutating rejection preserves it.
8. `DELETE /api/wrapper/session` closes the worker and deletes the non-persistent Sandbox. The worker also stops on expiry, function abort, browser failure, or explicit close.

## Enforced boundaries

- Exact validated HTTP(S) origin in Playwright; exact hostname plus GET/HEAD at the Sandbox firewall.
- DNS answers must all be public. Chromium pins the validated address. Private, local, reserved, documentation, multicast, IPv4-mapped IPv6, and NAT64 ranges are denied again at the Sandbox firewall. Public IPv4/IPv6 literal targets are rejected in production because the current Sandbox subnet rule cannot express the same method- and port-restricted policy as a hostname rule.
- Cross-origin redirects, subframes, popups, downloads, uploads, service workers, WebSockets, EventSource, WebRTC, Beacon, form submission, and non-reading methods are blocked. A server-trusted CDP main-frame identity distinguishes main-document redirects from blocked subframes; every actual main-document redirect hop during explicit navigation is independently checked for consequential path/query evidence before it can reach the target origin. Decoded fragments are checked during discovery, before navigation, and again against the final post-settle page URL so hash-router checkout or booking routes cannot bypass request-level guards.
- Preparation actions set the context offline before page mutation. They never submit and allow zero page network requests.
- DOM safety classification and native control operations run in a CDP isolated world. Server-only backend-node identities bind actions and verification to the classified element; page-visible marker attributes and mutable main-realm prototypes are not trust anchors. Controls and links must have a CDP paint-hit-tested visible pixel inside the fixed 1365×900 screenshot viewport after clip-path and every ancestor overflow clip, both during classification and immediately before state reads, writes, or verification; opaque `pointer-events:none` overlays therefore cannot expose a visually covered control. Controls are rechecked for effective `:disabled` and read-only state before every read and write; select mappings retain only effectively enabled options whose bounded label attribute, actual text, and value all pass safety classification. A shared isolated-world snapshot revalidates these sources immediately before reads, writes, link navigation, and verification. Non-`none` CSS filters or masks on the element or any ancestor are conservatively excluded because their visible pixels cannot be established safely from layout geometry alone.
- Sensitive-field classification independently checks bounded `aria-labelledby` and `aria-describedby` targets (HTML, SVG, and other elements), associated labels, aria-label, title, placeholder, name, ID, autocomplete, and relevant link evidence. At most 16 references or labels and 4 KiB of safety text are inspected per source, with an additional hard 24 KiB cumulative retained-evidence/snapshot budget per control. Any individual or aggregate overflow marks the control unsafe instead of truncating away a sensitive signal. Referenced text traversal is node- and character-bounded.
- Text, search, and textarea tools mirror native length contracts conservatively: public Unicode-code-point limits are chosen so every accepted value also fits the browser's UTF-16 limit, and samples must differ from the analyzed value. Non-empty native `pattern` controls are excluded instead of publishing an incomplete schema. Numeric, Select, and radio samples likewise choose a safe state different from the analyzed state; controls without an executable alternative are omitted from samples and tools. Radio groups are exposed only when every native same-name/form-owner member is visible, non-sensitive, server-bound, and revalidated as a complete group before every state operation.
- Remote names and labels stay evidence only. Public schemas use wrapper-owned names such as `field_1`, index-based links, and index-based options. Sensitive and consequential fields are excluded.
- Date, month, time, and week inputs are exposed only when Chromium can enumerate their complete native min/max/step value set within 200 entries. The exact finite enum is used for the public schema, sample, pre-action validation, and isolated-world retained-value check. Checkbox samples invert the browser-native analyzed state so the advertised invocation produces a visible change.
- One current page is analyzed by default. Only explicit safe same-origin navigation adds another page; the hard cap is ten pages per session.
- Queued actions recheck the session TTL immediately after acquiring their turn; an expired call cannot mutate or create Activity and destroys the stale session.
- Request bodies are capped at 32 KiB, serialized responses at 2 MiB, screenshots at 900 KiB, DOM traversal at 5,000 inspected elements, DOM evidence at 80 controls, Select traversal at 200 options, and AX evidence at 40 nodes. Partial AX queries are issued only for the at most 80 retained DOM controls. Analysis is capped at 35 seconds and actions at 15 seconds. Untrusted target downloads have a separate 4 MiB per-resource and 20 MiB cumulative session budget. Response headers are rejected early and CDP continuously measures both transferred and decoded bytes; a breach stops loading, takes the context offline, and invalidates the session.
- The action response expiry is clamped to the worker-owned outer Sandbox/config deadline. A later-started inner Playwright session can never extend the five-minute Sandbox lifetime presented to the client.
- No page content, screenshots, or form values are written to application storage. `persistent: false` prevents automatic Sandbox filesystem snapshots.
- `GET /api/wrapper/health` reports liveness separately from readiness. `alive` remains true for the Function while `ready` is false until either a reviewed snapshot ID or explicit browser image is configured.
- The UI keeps tools only after a literal worker-trusted `sessionInvalidated: false`. True, missing, malformed, aborted, or otherwise uncertain action outcomes unregister tools, clear the local analysis and credentials, show a reanalysis notice, and attempt an idempotent best-effort session close.

## Snapshot path

Production requires a reviewed Chromium snapshot ID in `WEBMCP_SANDBOX_SNAPSHOT_ID`. The snapshot contains only the pinned Playwright runtime and Chromium dependencies; the current worker bundle is uploaded for each new session.

Snapshot creation is intentionally guarded because it consumes Sandbox resources:

```bash
vercel link
vercel env pull
CONFIRM_WEBMCP_SANDBOX_SNAPSHOT=yes npm run sandbox:snapshot
```

Review the returned snapshot, then add its ID to the Preview environment as `WEBMCP_SANDBOX_SNAPSHOT_ID`. Do not commit OIDC tokens or snapshot credentials. The script locks the snapshot source to `deny-all` before capturing it and gives the snapshot a 30-day expiry.

## Abuse and cost controls

The Function layer hashes Vercel's platform-supplied `x-vercel-forwarded-for` address and uses that trusted source identity for one-active-analysis and small analysis/action windows. Rotating the browser-controlled `X-WebMCP-Client` value therefore does not bypass the guard within one Function instance. The browser identifier is secondary request context, not authorization.

The maps remain process-local and disappear on cold starts; parallel Function instances do not share them. Expired identities are pruned, each map is hard-capped at 512 identities per warm instance, and a new identity is rejected with `429` when the cap is full rather than evicting an active quota. They are explicitly a best-effort backstop, not a distributed or billing-grade rate limiter. A public Preview is blocked until a Vercel Firewall rule is published for the wrapper API, rate-limits by source IP, and returns `429`, or an equivalent distributed authenticated quota is in place and verified. Vercel Pro usage can continue into on-demand billing, and Spend Management checks are not an immediate per-request Sandbox hard cap. Until the external rule is proven, do not describe this Preview path as production-safe or expose it as an unrestricted public crawler.

The UI shows analyzed pages, wall-clock runtime, allowed/blocked request counts, 2 vCPU/4 GB allocation, and an illustrative cost range. The estimate uses the public list-price dimensions for active CPU, provisioned memory, and network. It is deliberately labeled as a rough estimate because included usage, regional pricing, CPU utilization, and final billing can differ.

## Hosting options and operating limits

| Option | Fit | Main limit |
| --- | --- | --- |
| Vercel Functions + Vercel Sandbox snapshot | Preferred for the hackathon; same platform, OIDC, MicroVM isolation, reconnect, firewall | Requires a reviewed snapshot and Sandbox quota; usage-based cost |
| Dedicated browser worker (container/VM) | More control over browser pools and global rate limiting | More operations, patching, scaling, and isolation responsibility |
| Third-party browser API | Fastest managed alternative | New vendor, recurring cost, and an additional data-processing boundary |

The implementation deliberately does not fall back to a Function-local browser, an iframe, or an unrestricted remote browser when Sandbox configuration is unavailable. It returns an honest `sandbox_not_configured` or capacity error instead.
