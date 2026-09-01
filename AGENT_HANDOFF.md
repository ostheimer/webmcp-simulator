# Agent handoff

This file is the current consolidated project state. It is intentionally rewritten as the state changes; it is not a chat transcript.

## Coordination

- Active Agent Relay: https://github.com/ostheimer/webmcp-simulator/issues/6
- Collaboration protocol: `docs/agent-collaboration-protocol.md`
- Last updated: 2026-09-01
- Updated by: Codex / WebMCP Simulator Manager
- Expected next agent: Claude Code

## Objective

Ship a safe WebMCP Simulator that can load a real public website without requiring that website to support WebMCP, infer a bounded set of safe capabilities in an isolated browser, register real `document.modelContext` tools on the simulator page, and visibly apply those tools only inside the isolated copy.

## Current repository state

- Repository: `ostheimer/webmcp-simulator`
- Canonical branch: `main`
- Current baseline commit before this handoff change: `4536da64cec5907c7cf43d4e6b9112a8b4a7ae07`
- PR #3: production wrapper architecture merged.
- PR #4: Vercel relative TypeScript import emission fixed.
- PR #5: Vercel Web Handler response emission fixed.
- Existing Issue #2 is a separate Auto WebMCP form-adapter exploration and is not the relay for this work.

## Verification state

- Full automated suite: 20 files, 474 tests passed on the production-wrapper baseline.
- TypeScript, lint, application build, Vercel build, generated-function runtime verification, diff check and audit passed.
- The generated Vercel handlers are exercised through the actual local `@vercel/node` HTTP dispatcher.
- Local real-site proof with `https://www.hotwagner.at/` successfully registered `open_page_link`, navigated to `/restaurant-2/`, refreshed the visible evidence and tool catalogue, and showed activity without modifying the original site.

## Production state

- Public URL: `https://webmcp-simulator.vercel.app/`
- Current production deployment at handoff time: `dpl_9zxX5emim5BePZoWTFEkautnNA6x`
- Root page: live verified HTTP 200.
- `/api/wrapper/health`: live verified HTTP 200.
- Health contract currently reports `ready:false` and `configuration:"missing-browser-source"`.
- Analyze, action and session wrong-method probes return the expected sanitized 405 responses and `Allow` headers.
- No production browser Sandbox was started during verification.

## External configuration state

Three Vercel Firewall rules are staged as unpublished log-only drafts:

- `Observe wrapper analyze traffic`
- `Observe wrapper action traffic`
- `Observe wrapper session traffic`

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

1. Human publishes the three log-only Firewall drafts.
2. Review matched traffic and confirm the rules only cover intended wrapper calls.
3. Stage and verify endpoint-specific distributed rate limits before production enforcement.
4. Configure an approved browser snapshot or image only after the quota boundary is live.
5. Redeploy and verify health changes to `ready:true`.
6. Run one bounded production analysis of `https://www.hotwagner.at/` and verify a real `document.modelContext` tool call without external side effects.

## Required first response from the next agent

Read the repository and active relay completely, reconcile the facts above, and post a relay comment containing:

- `From: Claude Code`
- `To: Codex`
- `Status: acknowledged`
- the exact branch and commit inspected;
- any discrepancy found;
- the next safe action proposed;
- any decision or permission required from Andreas.
