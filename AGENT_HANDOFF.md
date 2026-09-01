# Agent handoff

This file is the current consolidated project state. It is intentionally rewritten as the state changes; it is not a chat transcript.

## Coordination

- Active Agent Relay: https://github.com/ostheimer/webmcp-simulator/issues/6
- Collaboration protocol: `docs/agent-collaboration-protocol.md`
- Last updated: 2026-09-01
- Updated by: Claude Code
- Coordination owner: Claude Code, transferred from Codex / WebMCP Simulator Manager in Issue #6 on 2026-09-01
- Expected next agent: Claude Code, blocked on the priority decision in "Blocking decision"

## Objective

Ship a safe WebMCP Simulator that can load a real public website without requiring that website to support WebMCP, infer a bounded set of safe capabilities in an isolated browser, register real `document.modelContext` tools on the simulator page, and visibly apply those tools only inside the isolated copy.

## Current repository state

- Repository: `ostheimer/webmcp-simulator`
- Canonical branch: `main`
- Current `main` commit: `8e71edea35c047913d03fc2c71c4c3631b83d9d7`
- Production-wrapper code baseline: `4536da64cec5907c7cf43d4e6b9112a8b4a7ae07`. Everything merged since then is documentation only.
- PR #3: production wrapper architecture merged.
- PR #4: Vercel relative TypeScript import emission fixed.
- PR #5: Vercel Web Handler response emission fixed.
- PR #7: cross-agent relay protocol merged. Documentation and issue template only, 258 insertions, no code.
- PR #8: handoff reconciled with verified state. Documentation only.
- PR #9: public-deployment clarity merged. Landing copy, wrapper error copy and on-page agent test instructions. No change to wrapper behaviour, isolation policy or security contract.
- Existing Issue #2 is a separate Auto WebMCP form-adapter exploration and is not the relay for this work.

## Verification state

- Full automated suite at `4536da64cec5907c7cf43d4e6b9112a8b4a7ae07`: 20 files, 474 tests passed.
- Re-verified independently by Claude Code on 2026-09-01 at the same commit: 20 files, 474 tests passed, exit code 0.
- TypeScript, lint, application build, Vercel build, generated-function runtime verification, diff check and audit passed at `4536da64cec5907c7cf43d4e6b9112a8b4a7ae07`.
- Full automated suite at `be53adc76dda758b23ae27caf81e344cadecc68a`, the PR #9 branch head: 22 files, 492 tests passed, exit code 0. Eighteen tests added, none removed or weakened.
- Chrome verification on the live URL, 2026-09-01: `document.modelContext.getTools()` returns the five HeatFlow tools after the simulation launches, and `executeTool` produces a verified visible change. Chrome 151 with WebMCP enabled.
- Every test figure in this file is bound to a named commit. Do not carry a figure forward to a later commit without re-running it or showing that the intervening diff contains no code.
- The generated Vercel handlers are exercised through the actual local `@vercel/node` HTTP dispatcher.
- Local real-site proof with `https://www.hotwagner.at/` successfully registered `open_page_link`, navigated to `/restaurant-2/`, refreshed the visible evidence and tool catalogue, and showed activity without modifying the original site.

## Production state

- Public URL: `https://webmcp-simulator.vercel.app/`
- Current production deployment: `dpl_Eutgn45ViQpoFdPYrpmA4BCUbTxq`, built from `8e71edea35c047913d03fc2c71c4c3631b83d9d7`. The alias `webmcp-simulator.vercel.app` resolves to it.
- Superseded: `dpl_5TnPkWD9kHnDEbFuKiNrJSZDFPWa`, then `dpl_9zxX5emim5BePZoWTFEkautnNA6x`.
- Root page: live verified HTTP 200 on 2026-09-01 at approximately 10:20 CEST.
- `/api/wrapper/health`: live verified HTTP 200 on 2026-09-01 at approximately 10:20 CEST.
- Health contract currently reports `ready:false` and `configuration:"missing-browser-source"`.
- Analyze, action and session wrong-method probes return the expected sanitized 405 responses and `Allow` headers.
- No production browser Sandbox was started during verification.

## External configuration state

Three Vercel Firewall rules are staged as unpublished log-only drafts:

| Rule | Path | Method | Environment | Action |
| --- | --- | --- | --- | --- |
| `Observe wrapper analyze traffic` | `/api/wrapper/analyze` | `POST` | production | Log |
| `Observe wrapper action traffic` | `/api/wrapper/action` | `POST` | production | Log |
| `Observe wrapper session traffic` | `/api/wrapper/session` | `DELETE` | production | Log |

Conditions reviewed read-only by Claude Code on 2026-09-01 via `vercel firewall rules ls --expand`. All three are log-only; none blocks, challenges or rate-limits, and the methods match the live `Allow` headers. Open review point: because each rule pins a single method, wrong-method and malformed probing traffic is not measured, and `/api/wrapper/health` is not covered at all. Decide whether the observation window should be method-agnostic per path before publishing.

They do not affect live traffic until a human publishes the draft. Do not enable a public browser source until the distributed rate-limit rollout is verified.

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

No item in this track is a submission gate. The track is paused at `ready:false`.

1. Human publishes the three log-only Firewall drafts.
2. Review matched traffic and confirm the rules only cover intended wrapper calls.
3. Stage and verify endpoint-specific distributed rate limits before production enforcement.
4. Configure an approved browser snapshot or image only after the quota boundary is live.
5. Redeploy and verify health changes to `ready:true`.
6. Run one bounded production analysis of `https://www.hotwagner.at/` and verify a real `document.modelContext` tool call without external side effects.

Steps 1, 4 and 6 require explicit Andreas authorization. Step 1 writes production firewall configuration; steps 4 and 6 incur Sandbox cost.

### Track B: submission gates, time-critical

Deadline: **September 3, 2026 at 1:00 PM PDT.** `SUBMISSION_CHECKLIST.md` is the source of truth for the individual gates and must be reconfirmed against the displayed Devpost deadline before final submission.

Closed on 2026-09-01: the repository is public and GitHub detects the MIT license; the live URL is reachable without special access; and a real compatible agent discovers and invokes the tools in Chrome with WebMCP enabled. The official rules require the live URL to work in ChatGPT's in-app browser **or** Chrome, so the Chrome verification satisfies that requirement.

Open gates as of 2026-09-01:

- The deployed app is tested in ChatGPT's in-app browser. Optional; the Chrome path already satisfies the rule.
- The current WebMCP specification is rechecked immediately before submission.
- A public YouTube demo with audio, shorter than three minutes, is recorded.
- The Devpost narrative covers the WebMCP fit, the new human-plus-agent capability and the implementation.

The HeatFlow vertical slice already satisfies the product gates that are checked in `SUBMISSION_CHECKLIST.md`, so Track B is achievable without Track A.

## Blocking decision

Andreas must decide the priority between Track A and Track B. Roughly two days remain before the Track B deadline, Track A contains at least two unresolved dependencies (distributed rate limits, approved Chromium snapshot) and consumes Sandbox budget, and no Track A item is required for submission. Until this decision is recorded here, agents should not start work in either track beyond documentation and read-only verification.

## Required start-up sequence for the next agent

The previous acknowledgement request was satisfied by Claude Code in Issue #6 on 2026-09-01, and Codex transferred coordination ownership in the same thread.

Any agent starting work now must:

1. read this file, `AGENTS.md`, `docs/agent-collaboration-protocol.md` and every unread comment in Issue #6;
2. reconcile the facts above against Git, GitHub and production read-only before changing anything;
3. check whether the priority decision under "Blocking decision" has been recorded, and not start Track A or Track B work while it is open;
4. post a `claimed` message naming the exact scope and branch before the first edit.
