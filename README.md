# WebMCP Simulator

> Paste a URL. Experience the WebMCP version.

WebMCP Simulator helps website owners, agencies, product managers, and other decision-makers understand what a website could become with WebMCP before changing the original site.

The current vertical slice uses a deterministic fictional HeatFlow website to propose potential WebMCP capabilities and launch a safe simulation in which a compatible agent can invoke real WebMCP tools. Every invocation produces a visible state change on the simulation page. For arbitrary URLs, the browser-only MVP records only the normalized URL and deliberately makes no unsupported capability claims.

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

## Technology

- Vite
- React
- TypeScript
- The current imperative WebMCP browser API at `document.modelContext`

No authentication, payments, multi-tenancy, or database are required for the MVP.

## Local development

Requirements: Node.js 22 or newer and npm.

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

Open the deployed application in ChatGPT's in-app browser with site tools enabled. Launch the HeatFlow simulation, then ask the agent to search for a heat pump, check postcode `2230`, compare air- and ground-source heat pumps, or prepare a quote request. Compatible ChatGPT agents can discover the tools registered by the active simulation page.

### Google Chrome

For local testing in a compatible Chrome build:

1. Open `chrome://flags/#enable-webmcp-testing`.
2. Enable WebMCP testing.
3. Relaunch Chrome.
4. Open the simulator and launch the HeatFlow simulation.
5. Inspect and invoke the registered tools with a compatible agent or the Model Context Tool Inspector extension.

The page feature-detects `document.modelContext`. Unsupported browsers keep the complete human interface available and show an accurate compatibility message instead of reporting a false connection.

WebMCP is an evolving draft. Before submission, the implementation must be verified against the current [WebMCP specification](https://webmachinelearning.github.io/webmcp/) and [Chrome documentation](https://developer.chrome.com/docs/ai/webmcp).

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
