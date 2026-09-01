# Agent handoff

This file is the current consolidated project state. It is intentionally rewritten as the state changes; it is not a chat transcript.

## Coordination

- Active Agent Relay: https://github.com/ostheimer/webmcp-simulator/issues/6
- Collaboration protocol: `docs/agent-collaboration-protocol.md`
- Last updated: 2026-09-01, evening CEST
- Updated by: Claude Code
- Coordination owner: Claude Code, transferred from Codex / WebMCP Simulator Manager in Issue #6 on 2026-09-01
- Expected next agent: Claude Code, blocked on the priority decision in "Blocking decision"

## Objective

Ship a safe WebMCP Simulator that can load a real public website without requiring that website to support WebMCP, infer a bounded set of safe capabilities in an isolated browser, register real `document.modelContext` tools on the simulator page, and visibly apply those tools only inside the isolated copy.

## Current repository state

- Repository: `ostheimer/webmcp-simulator`
- Canonical branch: `main`
- Current `main` commit: `4c0b396bde51553d41159acee81bf473695b9820`
- Production-wrapper code baseline: `4536da64cec5907c7cf43d4e6b9112a8b4a7ae07`.
- PR #3: production wrapper architecture merged.
- PR #4: Vercel relative TypeScript import emission fixed.
- PR #5: Vercel Web Handler response emission fixed.
- PR #7: cross-agent relay protocol merged. Documentation and issue template only, 258 insertions, no code.
- PR #8: handoff reconciled with verified state. Documentation only.
- PR #9: public-deployment clarity merged. Landing copy, wrapper error copy and on-page agent test instructions. No change to wrapper behaviour, isolation policy or security contract.
- PR #10: notice and error no longer shown together; handoff and checklist reconciled.
- PR #11: sandbox commands now run in an explicit working directory. First change to wrapper code since the baseline.
- Existing Issue #2 is a separate Auto WebMCP form-adapter exploration and is not the relay for this work.

## Verification state

- Full automated suite at `4536da64cec5907c7cf43d4e6b9112a8b4a7ae07`: 20 files, 474 tests passed.
- Re-verified independently by Claude Code on 2026-09-01 at the same commit: 20 files, 474 tests passed, exit code 0.
- TypeScript, lint, application build, Vercel build, generated-function runtime verification, diff check and audit passed at `4536da64cec5907c7cf43d4e6b9112a8b4a7ae07`.
- Full automated suite at `be53adc76dda758b23ae27caf81e344cadecc68a`, the PR #9 branch head: 22 files, 492 tests passed, exit code 0.
- Full automated suite at `ea6ea9017849170ebc3979870a1aeb2eb2c07b45`, the PR #11 branch head: 22 files, 494 tests passed, exit code 0. Twenty tests added since the baseline, none removed or weakened.
- Chrome verification on the live URL, 2026-09-01: `document.modelContext.getTools()` returns the five HeatFlow tools after the simulation launches, and `executeTool` produces a verified visible change. Chrome 151 with WebMCP enabled.
- Every test figure in this file is bound to a named commit. Do not carry a figure forward to a later commit without re-running it or showing that the intervening diff contains no code.
- The generated Vercel handlers are exercised through the actual local `@vercel/node` HTTP dispatcher.
- Local real-site proof with `https://www.hotwagner.at/` successfully registered `open_page_link`, navigated to `/restaurant-2/`, refreshed the visible evidence and tool catalogue, and showed activity without modifying the original site.

## Production state

- Public URL: `https://webmcp-simulator.vercel.app/`
- Current production deployment: `dpl_7dQM1UmsjHM21JFCVMeM9StAhaCz`, built from `4c0b396bde51553d41159acee81bf473695b9820`.
- Root page and `/api/wrapper/health`: live verified HTTP 200 on 2026-09-01 evening CEST.
- Health contract reports `ready:false` and `configuration:"missing-browser-source"`.
- A browser source **was** configured and then deliberately removed on 2026-09-01. `WEBMCP_SANDBOX_SNAPSHOT_ID` was set on Production, health reached `ready:true`, every analysis then failed with `500 internal_error`, and the variable was removed and the deployment redeployed. The enabled state was strictly worse than the disabled one, because the landing screen stops showing its honest boundary notice once health reports ready. Do not set that variable again until the blocker below is resolved.
- A reviewed Chromium snapshot exists in the Vercel project with a 30-day expiry from 2026-09-01. Retrieve its ID from the project rather than from this file.
- Analyze, action and session wrong-method probes return the expected sanitized 405 responses and `Allow` headers.
- No production browser Sandbox was started during verification.

## External configuration state

The Vercel Firewall is **enabled** with three published rate-limit rules. They started as method-pinned log-only drafts, were published, widened to be method-agnostic, and then converted to rate limits, all on 2026-09-01 with Andreas's authorization.

| Rule | Path | Limit | Key | If exceeded |
| --- | --- | --- | --- | --- |
| `Limit wrapper analyze traffic` | `/api/wrapper/analyze` | 4 req / 600s, fixed window | ip | rate_limit |
| `Limit wrapper action traffic` | `/api/wrapper/action` | 30 req / 60s, fixed window | ip | rate_limit |
| `Limit wrapper session traffic` | `/api/wrapper/session` | 30 req / 60s, fixed window | ip | rate_limit |

Each rule matches its path in the production environment regardless of HTTP method. The thresholds mirror the contract the service already enforces in `proof/server/productionApi.ts`.

Verified empirically rather than from documentation: seven consecutive `GET /api/wrapper/analyze` requests returned 405 four times and then **429** three times, while `/` and `/api/wrapper/health` stayed 200. This satisfies the `docs/wrapper-production.md` requirement for a published rule that rate-limits by source IP and returns 429.

`/api/wrapper/health` is deliberately not covered, because logging liveness probes would mostly record monitoring noise.

Interpretation caveat: while the browser source is absent, legitimate analyze and action requests fail at the service before doing work, so a quiet observation window is not evidence of safety.

## Non-negotiable safety invariants

- Only public HTTP(S) targets are eligible; DNS and network destinations are checked fail-closed.
- Website content remains untrusted and must not define tool names, descriptions or parameter instructions.
- Sensitive controls and evidence remain private and unsupported.
- No external submission, purchase, booking, login, upload or arbitrary write is allowed.
- Preparation actions must not dispatch page-authored input/change events.
- Navigation is bounded to verified safe same-origin reads.
- Sessions use separate capability tokens, absolute TTLs, response limits and cleanup on ambiguous state.
- The original website is never modified.

See `docs/wrapper-production.md` and `docs/wrapper-proof.md` for the detailed contract.

## Open work

Two tracks compete for the same remaining time. Track B has an external deadline; Track A does not.

### Track A: wrapper production rollout

No item in this track is a submission gate. The track is blocked at step 6 and production is back at `ready:false`.

| Step | State |
| --- | --- |
| 1. Publish the log-only Firewall rules | Done 2026-09-01 |
| 2. Confirm the rules cover only intended wrapper calls | Done; `/` and `/api/wrapper/health` unaffected |
| 3. Distributed rate limits, published and verified | Done; 429 measured at the configured threshold |
| 4. Configure a reviewed browser snapshot | Done; snapshot created and usable |
| 5. Redeploy and reach `ready:true` | Reached, then deliberately rolled back |
| 6. One bounded production analysis | **Blocked**, see below |

### Track A blocker: the Sandbox rejects every IPv6 deny rule

`buildSandboxNetworkPolicy` passes `SANDBOX_DENIED_CIDRS` as `subnets.deny`. The Vercel Sandbox API rejects the create call before any sandbox exists:

```
Status code 400 is not ok: Invalid CIDR "::/128".
```

Removing each rejected entry and retrying showed that **all twelve IPv6 entries are rejected** and the IPv4 entries are accepted: `::/128`, `::1/128`, `::ffff:0:0/96`, `64:ff9b::/96`, `64:ff9b:1::/48`, `100::/64`, `2001::/23`, `2002::/16`, `3fff::/20`, `fc00::/7`, `fe80::/10`, `ff00::/8`.

`docs/wrapper-production.md` states that IPv4-mapped IPv6 and NAT64 ranges are "denied again at the Sandbox firewall". For IPv6 that has never been true and could not have been, because any create carrying those rules fails. The production browser path cannot have run since those rules were written. This is a documentation-versus-reality gap in a security claim, not only a defect.

What still holds: `resolvePublicTarget` validates DNS answers and rejects private, local and reserved addresses before any sandbox is created, Chromium pins the validated address, and the `allow` map is hostname-scoped to GET and HEAD. The subnet deny list was the secondary backstop; for IPv6 it is unavailable at this layer.

Ruled out during diagnosis: worker assets are present in the deployed function bundle for all four functions, and the snapshot itself is sound.

Two designs are possible and they differ in what the project is willing to claim:

1. Send only the CIDRs the API accepts and state plainly that IPv6 subnet denial is unavailable at the Sandbox layer.
2. Do that and additionally refuse production targets whose pinned address is IPv6, keeping the fail-closed posture and the documented claim true. There is precedent: IP-literal targets are already refused in production for the same reason.

Claude Code recommends option 2. **This decision is open and belongs to Andreas.** Do not implement either without it, and do not set `WEBMCP_SANDBOX_SNAPSHOT_ID` again until it is resolved.

### Track B: submission gates, time-critical

Deadline: **September 3, 2026 at 1:00 PM PDT.** `SUBMISSION_CHECKLIST.md` is the source of truth for the individual gates and must be reconfirmed against the displayed Devpost deadline before final submission.

Closed on 2026-09-01: the repository is public and GitHub detects the MIT license; the live URL is reachable without special access; and a real compatible agent discovers and invokes the tools in Chrome with WebMCP enabled. The official rules require the live URL to work in ChatGPT's in-app browser **or** Chrome, so the Chrome verification satisfies that requirement.

Open gates as of 2026-09-01:

- The deployed app is tested in ChatGPT's in-app browser. Optional; the Chrome path already satisfies the rule.
- The current WebMCP specification is rechecked immediately before submission.
- A public YouTube demo with audio, shorter than three minutes, is recorded.
- The Devpost narrative covers the WebMCP fit, the new human-plus-agent capability and the implementation.

The HeatFlow vertical slice already satisfies the product gates that are checked in `SUBMISSION_CHECKLIST.md`, so Track B is achievable without Track A.

## Blocking decisions

1. **Track A blocker.** Which of the two IPv6 designs above to implement. Nothing further in Track A can proceed without it.
2. **Track B remains the deadline-bound work** and is unaffected by the Track A blocker: the demo video and the Devpost text entry are the only outstanding items, and neither is an agent task.

## Required start-up sequence for the next agent

The previous acknowledgement request was satisfied by Claude Code in Issue #6 on 2026-09-01, and Codex transferred coordination ownership in the same thread.

Any agent starting work now must:

1. read this file, `AGENTS.md`, `docs/agent-collaboration-protocol.md` and every unread comment in Issue #6;
2. reconcile the facts above against Git, GitHub and production read-only before changing anything;
3. check whether the priority decision under "Blocking decision" has been recorded, and not start Track A or Track B work while it is open;
4. post a `claimed` message naming the exact scope and branch before the first edit.
