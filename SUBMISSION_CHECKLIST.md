# WebMCP Challenge submission checklist

The repository is public as of 2026-09-01. Do not submit until every required release gate below is satisfied.

## Product

- [x] The deployed application is reachable without payment or special access.
- [x] The complete HeatFlow flow works from landing page to readiness report.
- [x] At least four non-trivial tools are registered with the current WebMCP API.
- [x] A real compatible agent can discover and invoke the tools.
- [x] Every tool call produces an immediate, visible, verifiable UI change.
- [x] `prepare_quote_request` only prepares editable data and never submits it.
- [x] The original website and simulated environment are unmistakably labeled.
- [x] Unsupported browsers receive accurate setup instructions, not a fake success state.

## Verification

- [x] `npm run lint` passes.
- [x] `npm test` passes.
- [x] `npm run build` passes.
- [x] Tool schemas and invalid-input behavior are tested.
- [x] Registration and cleanup work without duplicate tools after navigation.
- [ ] The deployed app is tested in ChatGPT's in-app browser. Optional: the rules require ChatGPT **or** Chrome, and Chrome is verified.
- [x] The deployed app is tested in Chrome with WebMCP enabled.
- [ ] The current WebMCP specification is rechecked immediately before submission.

## Devpost deliverables

- [x] Deploy a working live URL accessible to judges.
- [ ] Record a public YouTube demo with audio, shorter than three minutes.
- [ ] Explain why the use case is a strong fit for WebMCP.
- [ ] Explain what people and agents can do together that was previously difficult.
- [ ] Briefly explain the WebMCP implementation.
- [ ] Include all required source code, assets, and functional instructions.
- [x] Keep the MIT license visible in the repository root.
- [x] Change the GitHub repository from private to public before submission.
- [x] Confirm GitHub detects the license and shows it in the repository About area.

## Competition deadline

Submission deadline: September 3, 2026 at 1:00 PM PDT. Reconfirm the displayed Devpost deadline before the final submission.
