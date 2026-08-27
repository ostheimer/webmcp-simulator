# WebMCP Challenge submission checklist

The repository can remain private during development. Do not submit it until every required release gate below is satisfied.

## Product

- [ ] The deployed application is reachable without payment or special access.
- [ ] The complete HeatFlow flow works from landing page to readiness report.
- [ ] At least four non-trivial tools are registered with the current WebMCP API.
- [ ] A real compatible agent can discover and invoke the tools.
- [ ] Every tool call produces an immediate, visible, verifiable UI change.
- [ ] `prepare_quote_request` only prepares editable data and never submits it.
- [ ] The original website and simulated environment are unmistakably labeled.
- [ ] Unsupported browsers receive accurate setup instructions, not a fake success state.

## Verification

- [ ] `npm run lint` passes.
- [ ] `npm run build` passes.
- [ ] Tool schemas and invalid-input behavior are tested.
- [ ] Registration and cleanup work without duplicate tools after navigation.
- [ ] The deployed app is tested in ChatGPT's in-app browser.
- [ ] The deployed app is tested in Chrome with WebMCP enabled.
- [ ] The current WebMCP specification is rechecked immediately before submission.

## Devpost deliverables

- [ ] Deploy a working live URL accessible to judges.
- [ ] Record a public YouTube demo with audio, shorter than three minutes.
- [ ] Explain why the use case is a strong fit for WebMCP.
- [ ] Explain what people and agents can do together that was previously difficult.
- [ ] Briefly explain the WebMCP implementation.
- [ ] Include all required source code, assets, and functional instructions.
- [ ] Keep the MIT license visible in the repository root.
- [ ] Change the GitHub repository from private to public before submission.
- [ ] Confirm GitHub detects the license and shows it in the repository About area.

## Competition deadline

Submission deadline: September 3, 2026 at 1:00 PM PDT. Reconfirm the displayed Devpost deadline before the final submission.
