# WebMCP Simulator

> Paste a URL. Experience the WebMCP version.

WebMCP Simulator helps website owners, agencies, product managers, and other decision-makers understand what a website could become with WebMCP before changing the original site.

The current research branch also contains a local-only isolated wrapper proof:
it opens a real public site in ephemeral Playwright Chromium, records real DOM,
accessibility, and screenshot evidence, and registers wrapper-owned WebMCP tools
for a strict allowlist of safe interactions. See
[`docs/wrapper-proof.md`](docs/wrapper-proof.md) for architecture, stash reuse,
security boundaries, verification, and hosting options. The production-stage
Vercel Functions and Sandbox architecture is documented separately in
[`docs/wrapper-production.md`](docs/wrapper-production.md). It keeps the same
security contract, adds a non-persistent five-minute Sandbox, reconnect with a
separate capability token, bounded usage metrics, and a reviewed Chromium
snapshot path. Its source-IP maps are an instance-local best-effort backstop;
a public Preview remains blocked until a distributed WAF rule or authenticated
quota is published and verified. It does not change the production site until
a Preview is explicitly verified.

The current vertical slice uses a deterministic fictional HeatFlow website to propose potential WebMCP capabilities and launch a safe simulation in which a compatible agent can invoke real WebMCP tools. Every invocation produces a visible state change on the simulation page. The section that changed is outlined and labelled with the tool name for a few seconds, and the fields or cards the call populated are emphasised, so a viewer can attribute every visible change to the call that caused it. Human interactions never trigger that emphasis, and no cursor or click is simulated. For arbitrary URLs, the browser-only MVP records only the normalized URL and deliberately makes no unsupported capability claims.

## Product boundaries

- The original website is never modified.
- The simulator never claims that an analyzed website supports WebMCP.
- Inferred capabilities are clearly labeled as proposals.
- Purchases, bookings, and external submissions are never performed.
- Consequential actions are simulated or left for explicit human confirmation.
- Website content is treated as untrusted input, never as system instructions.

## Why this is different from WebMCP Studio

Developer tooling such as WebMCP Studio helps teams implement and inspect WebMCP integrations. WebMCP Simulator addresses an earlier product decision: **How can someone understand and experience the value of WebMCP before deciding to implement it?**

The simulator focuses on visual discovery, a before-and-after explanation, a decision-oriented readiness report, and an interactive WebMCP-enabled experience.

## Implemented vertical slice

```text
Landing page
  -> HeatFlow demo analysis
  -> WebMCP opportunities
  -> WebMCP simulation
  -> visible agent activity
  -> readiness report
  -> access-aware implementation pack for Codex
```

The deterministic HeatFlow demo registers these imperative WebMCP tools:

- `search_services`
- `check_service_area`
- `compare_services`
- `prepare_quote_request`
- `reset_simulation`

The WebMCP entry points are intentionally easy to find:

- [`src/webmcp/registerTools.ts`](src/webmcp/registerTools.ts) owns feature detection, registration, and cleanup.
- [`src/webmcp/createHeatFlowTools.ts`](src/webmcp/createHeatFlowTools.ts) defines the five HeatFlow tools, validates inputs, and connects calls to visible simulator state.

`prepare_quote_request` only fills an editable local draft. It never sends a request.

## From simulation to implementation

The Implementation Pack turns selected opportunities into a Markdown brief and a ready-to-copy Codex prompt. It does not assume that the user has a repository. The default path is **No repository or technical access** and instructs Codex to identify the platform, hosting, responsible maintainer, available exports, and required authorization before proposing any production change.

Alternative paths cover a CMS or website builder, an external agency, and an existing repository. The pack can be copied or downloaded as `WEBMCP_IMPLEMENTATION.md`.

`reset_simulation` remains available for repeatable demo and evaluation runs, but it is marked test-only and excluded from production-oriented Implementation Packs by default.

## Technology

- Vite
- React
- TypeScript
- The current imperative WebMCP browser API at `document.modelContext`

No authentication, payments, multi-tenancy, or database are required for the MVP.

## Local development

Requirements: Node.js `^22.22.2`, `^24.15.0`, or `>=26.0.0`, plus npm.

```bash
npm install
npm run dev
```

Quality checks:

```bash
npm run lint
npm test
npm run build
```

## Testing WebMCP

### ChatGPT desktop app

OpenAI calls its WebMCP support "site tools". They work in the built-in browser of the ChatGPT desktop app, not on chatgpt.com:

1. Update the ChatGPT desktop app to the latest version and make sure **Settings › Browser › Permissions › Enable site tools** is on. Site tools are not available in Enterprise or Edu workspaces.
2. Start a chat in Work or Codex mode with GPT-5.6 Sol or GPT-5.6 Terra. GPT-5.6 Luna currently has WebMCP disabled.
3. Open the built-in browser (⌘⇧B on macOS), load the deployed application and launch the HeatFlow simulation.
4. Select **Site tools** in the browser's address bar to see the five registered tools, then ask the agent to search for a heat pump, check postcode `2230`, compare air- and ground-source heat pumps, or prepare a quote request.

Tools belong to the page that registers them: reloading or navigating away drops them until the simulation is launched again. This path has not yet been verified by the project; the Chrome path below has.

### Google Chrome

In Chrome 149 or later:

1. Open `chrome://flags/#enable-webmcp-testing`.
2. Enable WebMCP testing.
3. Relaunch Chrome.
4. Open the simulator and launch the HeatFlow simulation.
5. Inspect and invoke the registered tools with a compatible agent or the Model Context Tool Inspector extension.

To drive the tools directly from the browser console:

```js
const tools = await document.modelContext.getTools()
const tool = tools.find((candidate) => candidate.name === 'check_service_area')
await document.modelContext.executeTool(tool, JSON.stringify({ postcode: '2230', service: 'heat_pump' }))
```

`executeTool` takes the registered tool object rather than its name. Passing a
name string fails with `The provided value is not of type 'RegisteredTool'`.
In Chrome 152, verified on 2026-09-01, the arguments must be a JSON string and a
plain object fails with `Failed to parse input arguments`; the WebMCP draft of
26 August 2026 specifies a plain object that the browser serialises itself, so a
later Chrome may accept `{ postcode: '2230', service: 'heat_pump' }` directly.
`getTools` resolves to a promise, and it returns an empty list until a
simulation is launched.

The page feature-detects `document.modelContext`. Unsupported browsers keep the complete human interface available and show an accurate compatibility message instead of reporting a false connection.

WebMCP is an evolving draft. The implementation was last checked against the [WebMCP specification](https://webmachinelearning.github.io/webmcp/) draft of 26 August 2026 and the [Chrome documentation](https://developer.chrome.com/docs/ai/webmcp) on 2026-09-01: entry point, `registerTool` options, tool descriptor fields, annotation names, the execute callback and its optional abort signal, and the tool-name character rules all conform.

## Architecture

```text
src/
  components/            Shared interface components
  demo/heatflow/         Deterministic demo data and rules
  features/
    analysis/            Website analysis boundary
    opportunities/       Proposed capabilities
    implementation/      Access-aware Markdown and Codex prompt generation
    landing/             Landing page and URL intake
    readiness/           Inspectable heuristic scoring
    simulation/          Simulator state and UI
  types/                 Normalized domain models
  webmcp/                Browser API registration and schemas
```

Analysis, simulation state, implementation guidance, and WebMCP registration remain separate so that a future authorized browser-based analyzer can replace the deterministic MVP analyzer without rewriting the simulation.

The readiness score is illustrative rather than scientific. Fixed factors and weights live in [`src/demo/heatflow/data.ts`](src/demo/heatflow/data.ts), while the inspectable calculation lives in [`src/features/readiness/scoring.ts`](src/features/readiness/scoring.ts).

## Submission status

This repository starts private during development. The Devpost submission requires a **public source repository**, a visible open-source license, a working live URL, and a public demo video shorter than three minutes. See [`SUBMISSION_CHECKLIST.md`](SUBMISSION_CHECKLIST.md) for the release gate.

## License

Licensed under the [MIT License](LICENSE).
