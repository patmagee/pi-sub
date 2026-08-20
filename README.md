# pi-sub

`pi-sub` adds visible, cancellable subagents to [Pi](https://github.com/badlogic/pi-mono). Each subagent runs in an isolated Pi process with a bounded assignment and its own session.

## Quick start

Install the extension directly from GitHub:

```bash
pi install git:git@github.com:patmagee/pi-sub
```

For one session without installation, use:

```bash
pi -e git:git@github.com:patmagee/pi-sub
```

For local development, clone the repository and load the checkout:

```bash
git clone git@github.com:patmagee/pi-sub.git
cd pi-sub
pi -e .
```

Then ask Pi to delegate work:

```text
Use a scout subagent to find where authentication tokens are refreshed.
Continue with my main task while it works.
```

The start call returns immediately. Pi receives promoted updates and a final summary as the subagent works.

## Contents

- [Tools](#tools)
- [Roles](#roles)
- [Permissions and context](#permissions-and-context)
- [Models and effort](#models-and-effort)
- [Dashboard](#dashboard)
- [Inspection and cancellation](#inspection-and-cancellation)
- [Configuration](#configuration)
- [Development](#development)

## Tools

| Tool | Purpose |
| --- | --- |
| `subagent_start` | Starts an asynchronous subagent and returns its identifier, status, and depth. |
| `subagent_update` | Records a child update and optionally promotes it to the direct parent. |
| `subagent_inspect` | Reads bounded metadata, updates, summaries, or session content. |
| `subagent_cancel` | Cancels one agent, an agent tree, or all agents when called by the root. |

Subagents may delegate to their own children. The root manager enforces the session limits and keeps completed records available for inspection.

## Roles

The bundled roles are:

- `scout`
- `investigator`
- `reviewer`
- `adversarial-reviewer`
- `security-auditor`
- `ticket-triager`

Add custom Markdown roles in either location:

- User roles: `~/.pi/agent/subagents/roles/`
- Trusted project roles: `.pi/subagents/roles/`

A role uses frontmatter followed by its system prompt:

```markdown
---
name: api-reviewer
description: Reviews API contracts and compatibility
model: anthropic/claude-sonnet-4-5
effort: high
permission: read-only
---

Review the assigned API change. Report evidence, risks, recommendations,
and unresolved questions.
```

Project roles override user roles. User roles override bundled roles. Project roles load only after Pi trusts the project.

## Permissions and context

`read-only` is the default permission. It provides file discovery and reading tools, plus the four subagent tools. It does not provide `bash`, `edit`, or `write`.

`inherit` copies the parent agent's active tools. A read-only parent cannot grant inherited permission to a child.

A child does not receive the parent transcript. Its prompt contains only:

- The assignment.
- The selected role prompt.
- An optional `contextSummary` written by the parent.
- Orchestration metadata such as its name, depth, and permission.

This keeps delegation explicit. Put every fact needed to judge the result in the assignment or `contextSummary`.

The isolation here is prompt isolation, not process isolation. These are two different boundaries. Prompt isolation means the raw parent conversation history is excluded from the child's prompt, and the only main-session content the child sees is the `contextSummary` you write. Process isolation is not claimed. The child is a normal Pi process in the assigned working directory, so it still loads the governing context that Pi discovers on its own: your user instructions, trusted-project instructions, skills, extensions, and context files. If a fact matters for the child's judgment and is not already in that governing context, put it in the assignment or the `contextSummary`.

## Models and effort

Model selection uses this order:

1. The `subagent_start` override.
2. The role default.
3. The parent model.

Thinking effort uses the same order. Supported effort values are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`.

The requested model must be available in Pi. An unavailable model produces a retained failed record instead of silently selecting another model.

## Dashboard

The below-editor status strip shows every retained agent:

| Symbol | Status |
| --- | --- |
| `○` | Queued |
| `◐` | Starting or running |
| `●` | Completed |
| `✕` | Failed |
| `–` | Cancelled |

Press `Shift+Down` to focus the strip. Use the arrow keys to select an agent, `Enter` to open details, and `Escape` or `Shift+Up` to return to the editor.

Run `/subagents` to open the full dashboard. It shows hierarchy, execution policy, activity, updates, usage, outcomes, process identifiers, and session paths.

Dashboard cancellation keys are:

- `c`: Cancel the selected agent.
- `Shift+C`: Confirm and cancel the selected agent tree.
- `Ctrl+C`: Confirm and cancel all agents. This action is available only to the root.

If a provider does not emit reasoning events, the dashboard says so. It does not infer or invent missing reasoning.

## Inspection and cancellation

`subagent_inspect` supports four views:

- `metadata`: Identity, hierarchy, policy, status, and timing.
- `updates`: Recorded child updates.
- `summary`: Final status, summary, usage, and session path.
- `session`: A byte range from the child session file.

Session reads are capped at 50 KiB per request and return a continuation offset when truncated. Promoted updates and completion messages are also bounded before entering the parent context.

Cancellation targets descendants before parents. Running process groups receive `SIGTERM`, then `SIGKILL` after the configured grace period if necessary. Session shutdown cancels live work, closes the authenticated control socket, and removes private temporary files.

## Configuration

Set these environment variables before starting Pi:

| Variable | Default | Meaning |
| --- | ---: | --- |
| `PI_SUB_MAX_AGENTS` | `12` | Maximum retained non-terminal agents admitted at once. |
| `PI_SUB_MAX_CONCURRENCY` | `12` | Maximum child processes running at once. |
| `PI_SUB_MAX_DEPTH` | `3` | Maximum delegation depth. Values above `3` are capped. |
| `PI_SUB_CANCEL_GRACE_MS` | `5000` | Milliseconds between `SIGTERM` and `SIGKILL`. |
| `PI_SUB_SOCKET_DIR` | Operating system temporary directory | Parent directory for private control sockets. |

Invalid positive-integer settings fall back to their defaults and produce a visible diagnostic. Concurrency cannot exceed the agent limit.

## Development

Install dependencies and run deterministic checks:

```bash
npm install
npm test
npm run typecheck
```

The test suite uses fake child processes and does not call a model provider. Real-model integration is intentionally opt-in and is not run by the default test command.
