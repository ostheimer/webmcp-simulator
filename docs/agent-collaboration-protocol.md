# Agent collaboration protocol

This protocol provides a tool-neutral, asynchronous communication channel for Codex, Claude Code and future coding agents.

## Two-layer model

### Consolidated state

`AGENT_HANDOFF.md` contains the latest accepted project state. Keep it compact, current and evidence-backed. Replace outdated facts instead of appending a historical diary.

### Conversation ledger

The active GitHub Agent Relay issue contains chronological messages, questions, claims, reviews and decisions. Issue comments are the durable chat transport.

## Message format

Every agent message should use this structure:

```markdown
### Agent message

From: Codex | Claude Code | <agent name>
To: <agent or Andreas>
Status: acknowledged | claimed | working | review-needed | blocked | decision-needed | complete
Scope: <bounded task>
Branch: <branch or none>
Commit: <full SHA or none>

Summary:
- <new information only>

Evidence:
- <tests, build, URL, logs, diff or review>

Request:
- <specific next action, question or review request>
```

Do not paste secrets, environment values, credentials, personal data or raw private logs into the issue.

## Lifecycle

1. **Acknowledge:** read repository instructions, handoff and unread relay comments.
2. **Reconcile:** compare stated status with Git, GitHub and relevant live systems.
3. **Claim:** post a `claimed` message naming the exact scope and branch before editing.
4. **Work:** keep implementation within the claimed scope and preserve unrelated changes.
5. **Report:** post concrete evidence and identify implemented, locally verified, deployed and live verified states separately.
6. **Review:** another agent reviews the exact commit or PR and replies with findings or `review-needed` resolution.
7. **Consolidate:** update `AGENT_HANDOFF.md` after a material accepted change.
8. **Close or rotate:** close a relay issue when the phase ends and link the next relay issue from the handoff.

## Ownership and concurrency

- One agent owns an implementation scope at a time.
- Parallel work is allowed only when scopes and working directories do not overlap.
- A claim expires when the agent reports completion, explicitly releases it or remains silent after a human-defined timeout.
- Agents must not merge, deploy, publish firewall drafts, enable paid execution or change credentials unless the current user authorization clearly includes that boundary.

## Decisions

Record a decision as a separate relay comment with `Status: decision-needed`. A human decision should be copied into `AGENT_HANDOFF.md` when it changes the project state or constraints.

## Evidence rules

- A green build is not a production acceptance test.
- A deployment marked ready is not live verification.
- Review the exact current commit and all current review threads.
- Prefer reproducible commands and stable URLs over narrative assurances.
- Treat stale comments and old chats as historical context only.

## Optional automation

Agents may poll the relay issue through `gh issue view <number> --comments` or the GitHub API. A scheduler can wake an agent when new comments appear. This transport does not by itself wake Claude Code or Codex; orchestration must start or resume the target agent.

An MCP relay can later expose `post_message`, `list_messages`, `acknowledge` and `claim_scope` over the same GitHub-backed ledger without changing this protocol.

