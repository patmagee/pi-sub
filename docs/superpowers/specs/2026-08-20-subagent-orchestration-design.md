---
title: Session-scoped subagent orchestration for Pi
date: 2026-08-20
repo: pi-sub
services: [pi-sub]
tags: [workflow, infrastructure, testing, security]
status: draft
superseded_by:
related: []
human_reviewed: false
decisions:
  - Run each subagent as an isolated Pi JSON-mode subprocess managed by one root manager
  - Keep every subagent session-scoped and cancel all live descendants when the orchestrator runtime ends
  - Support read-only and inherited permission modes, with read-only as the default
  - Support assignment-only context or an additional orchestrator-written context summary
  - Expose all subagents through a persistent status strip and a hierarchical dashboard
  - Route only explicitly promoted updates and concise final summaries into the parent context
  - Allow recursive delegation to a maximum depth of three
  - Default to twelve live subagents and twelve concurrent processes, with environment-based tuning
  - Use bundled roles plus overridable user and trusted-project Markdown role files
  - Require a simple orchestrator-provided name and add suffixes when names repeat
---

# Session-scoped subagent orchestration for Pi

## Summary

This extension gives a Pi agent an explicit, visible way to delegate work to isolated subagents. The main agent remains the orchestrator. Each subagent receives a bounded assignment and returns concise findings instead of copying its full transcript into the parent context.

The extension is session-scoped. It does not maintain a long-running fleet. Every live subagent is visible, inspectable, and cancellable from the main terminal user interface (TUI).

## Goals

The extension must support these workflows:

- Fast code search and summarization with a small model such as Haiku.
- Focused investigation, review, security audit, adversarial review, and ticket triage.
- Temporary use of a different model or reasoning effort without copying the main conversation.
- Parallel execution of independent assignments.
- Recursive delegation when a subagent becomes an orchestrator, subject to a strict depth limit.
- Context reduction by keeping exploratory transcripts outside the parent context.
- Complete operational visibility and cancellation from the main TUI.

## Non-goals

The first version will not provide these capabilities:

- A persistent agent fleet that survives the orchestrator session.
- Reconnection to live subagents after reload or session replacement.
- Direct switching from the main TUI into a child Pi session.
- Blocking dispatch calls.
- Automatic copying of the main conversation into a child.
- Hidden background processes or detached work.

## Decisions

[HUMAN DECISION]
Each subagent will run as a separate `pi --mode json` process. One root manager in the orchestrator process will own every descendant process.
[/HUMAN DECISION]

[HUMAN DECISION]
Subagents will support two permission modes. `read-only` is the default. `inherit` receives the parent's active tools. A child's permissions are an upper bound for its descendants.
[/HUMAN DECISION]

[HUMAN DECISION]
A dispatch can provide only an assignment, or an assignment plus an orchestrator-written context summary. Raw parent conversation history will not be copied.
[/HUMAN DECISION]

[HUMAN DECISION]
Subagents will run asynchronously. Dispatch returns immediately. Promoted updates and concise final summaries flow back later.
[/HUMAN DECISION]

[HUMAN DECISION]
The TUI will show a persistent status strip below the editor. `/subagents` opens the full dashboard. `Shift+Down`, arrow-key selection, and `Enter` provide keyboard navigation from the editor.
[/HUMAN DECISION]

[HUMAN DECISION]
The extension will allow twelve live subagents and twelve concurrent processes by default. Recursive delegation will stop at depth three. Environment variables may lower or tune these defaults, but depth may never exceed three.
[/HUMAN DECISION]

[HUMAN DECISION]
The extension will bundle common roles and allow Markdown role files to override them. Project role files require a trusted project.
[/HUMAN DECISION]

[HUMAN DECISION]
The orchestrator will provide a short name for every dispatch. Reused names receive a session-wide numeric suffix, such as `explore-2`.
[/HUMAN DECISION]

## Architecture

### Root manager

The root extension instance starts a manager only after the Pi session starts. The manager owns the complete process tree, agent registry, local socket, status updates, cancellation, and cleanup.

The manager assigns every agent an immutable identifier. It also records the requested name, unique display name, parent identifier, depth, role, model, reasoning effort, permission mode, working directory, process identifier, child session path, timestamps, usage, and terminal state.

Completed, failed, and cancelled records remain visible until the orchestrator session ends. Only live processes count against the live-agent limit.

### Child processes

Each subagent runs in a separate Pi JSON-mode subprocess with a persistent child session. The process uses the assigned working directory and normal Pi resource discovery. This causes the child to load the same standard governing instructions and applicable context files while rebuilding the tool section for its actual permissions.

The child receives an appended prompt that contains:

- Its role instructions.
- Its assignment.
- Its unique name and parent relationship.
- Its permission mode and delegation ceiling.
- Its optional orchestrator-written context summary.
- Its reporting and final-summary contract.

The child does not receive the parent transcript. Turn-specific parent messages and exploratory tool output remain isolated.

This is prompt isolation, not process isolation. Two boundaries are in play, and they are different. Prompt isolation controls the appended prompt: the raw parent conversation history is excluded, and the only main-session content the child sees is the optional context summary the parent writes. Process isolation is not claimed here. The child is a normal Pi process in the assigned working directory, so it still loads the standard governing resources that Pi discovers on its own: user instructions, trusted-project instructions, skills, extensions, and context files. If a fact matters for the child's judgment and does not live in those governing resources, the parent must place it in the assignment or the context summary.

### Local control socket

Nested extension instances connect to the root manager through a private local socket. The root manager remains the only process that admits and launches descendants. This gives one authoritative place for total limits, depth checks, naming, visibility, and cancellation.

The socket directory defaults to a private directory under the session temporary directory. `PI_SUB_SOCKET_DIR` can override it. The directory and endpoint use owner-only permissions. A random session token authenticates child connections and is passed only through child process environment variables.

The protocol carries bounded control messages. It supports registration, dispatch requests, event updates, promoted findings, completion, inspection requests, and cancellation. Large transcript content remains in the child session rather than crossing the socket.

If the root manager disappears, children terminate. They must not continue as hidden or orphaned workers.

### Process termination

Cancellation first sends a graceful termination signal. If the child does not exit within the configured grace period, the manager force-kills the process tree.

Reload, session replacement, fork, and shutdown cancel every live descendant. Cleanup removes socket and temporary prompt files. Persisted child session files remain available for later inspection.

## Roles

The extension bundles these roles:

- `scout` performs fast code search and returns compressed findings. It defaults to Haiku with reasoning disabled.
- `investigator` gathers evidence and distinguishes observations from hypotheses.
- `reviewer` checks correctness, contracts, tests, and maintainability.
- `adversarial-reviewer` searches for failure modes and challenges assumptions.
- `security-auditor` examines trust boundaries, data exposure, permissions, and abuse paths.
- `ticket-triager` groups, prioritizes, and summarizes tickets using stated evidence.

Role resolution follows this order:

1. A trusted project role file.
2. A user role file.
3. A bundled role.

User roles live under `~/.pi/agent/subagents/roles/`. Project roles live under `.pi/subagents/roles/` in the trusted project. A project role cannot be loaded from an untrusted project.

Role files use Markdown with YAML frontmatter. Frontmatter may set the role name, description, default model, default reasoning effort, and default permission mode. The Markdown body supplies role instructions. Invalid role files produce visible diagnostics and do not prevent valid roles from loading.

## Dispatch and inspection tools

### `subagent_start`

The orchestrator uses `subagent_start` to create asynchronous work. Required parameters are a short `name`, a `role`, and a `task`.

Optional parameters include:

- `permission`, which defaults to `read-only`.
- `contextSummary`, which is omitted for assignment-only isolation.
- `model`, expressed as `provider/model`.
- `effort`, using Pi's supported thinking levels.
- `cwd`, which defaults to the parent's working directory.

The tool validates the request with the root manager and returns immediately with the immutable identifier, unique display name, initial state, and depth.

Model selection follows this order:

1. Dispatch override.
2. Role default.
3. Parent model.

Reasoning effort follows the same order. The record stores requested and effective values. If a requested model is unavailable, the dispatch fails visibly. The extension must not silently substitute a model because that would change the requested perspective.

### `subagent_update`

A child uses `subagent_update` to report an important finding while it continues working. Every update appears in the dashboard.

The child must explicitly set promotion when the update should enter its parent's context. Promoted updates must be concise and self-contained. The root manager routes a promoted update only to the direct parent.

### `subagent_inspect`

The orchestrator uses `subagent_inspect` to retrieve bounded state without dumping a transcript. It can return metadata, recent updates, final summary, usage, session path, or a bounded session slice.

The full persisted child session remains the authoritative detailed record. The tool clearly reports truncation and supports bounded offsets when session content is requested.

### `subagent_cancel`

The orchestrator uses `subagent_cancel` to cancel one agent, an agent and all descendants, or every live agent. Multi-agent cancellation requires confirmation when a TUI is available.

A parent may cancel only agents in its own descendant tree. The root orchestrator may cancel any agent.

## Permissions

### Read-only mode

A read-only child receives these repository tools:

- `read`
- `grep`
- `find`
- `ls`

It also receives the subagent delegation, update, inspection, and cancellation tools needed for orchestration. It does not receive `bash`, `write`, `edit`, or other inherited mutating tools.

A read-only child may create only read-only descendants. This prevents permission escalation through delegation.

### Inherited mode

An inherited child receives the parent's active tools, subject to tool availability in the child process. The extension adds its own subagent management tools when recursive delegation is permitted.

An inherited child may create read-only or inherited descendants. The depth and live-agent limits still apply.

The dashboard always displays the effective permission mode. Permission changes after launch are not supported in the first version.

## Limits and configuration

The extension reads these environment variables:

- `PI_SUB_MAX_AGENTS` defaults to `12` and limits live descendant processes.
- `PI_SUB_MAX_CONCURRENCY` defaults to `12` and cannot exceed `PI_SUB_MAX_AGENTS`.
- `PI_SUB_MAX_DEPTH` defaults to `3` and must remain between `1` and `3`.
- `PI_SUB_SOCKET_DIR` overrides the private socket parent directory.
- `PI_SUB_CANCEL_GRACE_MS` controls graceful cancellation delay before force-kill.

Invalid values produce a visible startup diagnostic and fall back to safe defaults. The extension must not silently disable a limit.

Depth uses these meanings:

- A child of the root orchestrator has depth one.
- A grandchild has depth two.
- A great-grandchild has depth three.
- A depth-three agent cannot dispatch another agent.

If capacity is unavailable, a dispatch enters `queued` state only when the concurrency limit is lower than the live-agent limit. If the live-agent limit is reached, the dispatch fails visibly rather than becoming an unbounded hidden queue.

## Parent context behavior

The parent receives only these child messages automatically:

- A promoted update that the child explicitly marked for its parent.
- A concise final summary after completion.
- A concise failure or cancellation report when no final summary exists.

The extension delivers completion asynchronously and triggers the parent to continue orchestration. Full reasoning, tool output, and transcript content remain outside the parent context unless the parent deliberately requests a bounded session slice.

The final-summary contract asks the child to report findings, evidence locations, unresolved questions, and recommended next action. It forbids full file dumps and transcript reproduction.

## TUI

### Status strip

A persistent widget appears below the main editor. It lists every retained subagent and wraps when terminal width requires it.

State uses both a symbol and color:

- `○ queued`
- `● running`
- `✓ completed`
- `✗ failed`
- `■ cancelled`

The strip includes each unique display name. It also includes aggregate counts when space permits.

`Shift+Down` moves focus from the editor to the strip. Left and right arrow keys select an agent. `Enter` opens the selected agent's detail view. `Escape` or `Shift+Up` returns focus to the editor.

The extension wraps the currently installed editor component instead of replacing its behavior. This preserves compatibility with an editor installed by an earlier extension.

### Dashboard

The `/subagents` command opens the full hierarchical dashboard. The hierarchy shows parent-child relationships and every retained agent state.

The list view shows:

- Unique name and role.
- Status and elapsed time.
- Model and reasoning effort.
- Permission mode.
- Parent and depth.
- Recent promoted-update indicator.

The detail view shows:

- Full assignment prompt and optional context summary.
- Requested and effective model and effort.
- Permission mode and available tools.
- Process and child session metadata.
- Provider-exposed reasoning events.
- Tool activity and recent results.
- All updates and promotion state.
- Usage and final summary.
- Explicit failure or cancellation details.

The dashboard cannot show private reasoning that a provider does not emit. It must label unavailable reasoning rather than imply that no reasoning occurred.

Cancellation commands act on the selected agent, its descendant tree, or every live agent. Tree-wide and global cancellation require confirmation.

## State model

An agent moves through these states:

1. `queued`
2. `starting`
3. `running`
4. One terminal state: `completed`, `failed`, or `cancelled`

Every transition records a timestamp and reason. Unknown process exits become `failed`. User cancellation becomes `cancelled`, even if force-kill was required.

The registry is authoritative for the dashboard. The child session is authoritative for transcript content. The implementation must not infer process health from a display name or from the presence of a session file.

## Error handling

The extension reports these failures explicitly:

- Invalid role, model, effort, permission, depth, or working directory.
- Live-agent or concurrency configuration errors.
- Child launch failure.
- Socket creation, authentication, protocol, or disconnect failure.
- Malformed JSON events from a child.
- Model or tool execution failure.
- Child process crash.
- Graceful cancellation timeout and force-kill.
- Persisted-session discovery failure.

A malformed event does not crash the manager. It is recorded against the child and processing continues when safe. A broken control connection fails the affected operation and causes the child to terminate if root ownership can no longer be verified.

## nono compatibility

The first validation step will test socket creation and parent-child communication under the current nono profile. The default socket location remains configurable so an already permitted directory can be used.

If nono denies the operation, implementation will run `nono why --self` for the exact path and operation. It will not edit an active or registry-managed nono profile. Remediation will use either a one-off grant or a profile draft that the user explicitly promotes.

## Package structure

The repository will contain a Pi extension package with focused modules:

- Extension registration and lifecycle hooks.
- Configuration parsing and validation.
- Role discovery and bundled role files.
- Root manager and agent registry.
- Local socket protocol and authentication.
- Child process runner and JSON event reducer.
- Prompt construction and summary contract.
- Tool definitions.
- Status strip, editor wrapper, dashboard, and detail components.
- Unit, process, protocol, integration, and TUI tests.

The extension entry point will remain small. Each module will expose a narrow interface so process management, protocol handling, and rendering can be tested independently.

## Validation strategy

### Unit tests

Unit tests will cover:

- Environment parsing and safe fallback diagnostics.
- Session-wide unique-name suffixing.
- Depth and live-agent enforcement.
- Parent permission ceilings.
- Role precedence and project trust.
- Model and effort precedence.
- Prompt construction without parent transcript leakage.
- State transitions and terminal-state reasons.
- Output bounding and truncation notices.

### Protocol and process tests

Tests will use a fake Pi child to cover:

- Registration and authentication.
- Nested dispatch routing.
- Update promotion to the direct parent.
- Completion and failure routing.
- Malformed events and socket disconnects.
- Graceful termination and forced termination.
- Root disappearance and descendant cleanup.

### Integration tests

Opt-in integration tests with a real Pi child will verify:

- Normal governing context discovery.
- Read-only and inherited tool sets.
- Model and reasoning effort selection.
- Persistent child sessions.
- Recursive dispatch through depth three.
- Concise completion delivery without transcript copying.

These tests may require configured model credentials. They will remain separate from deterministic local tests.

### TUI tests

TUI tests will verify:

- Wrapped status-strip rendering at narrow and wide terminal widths.
- Symbol and color-independent state labels.
- `Shift+Down`, arrow, `Enter`, `Escape`, and `Shift+Up` behavior.
- Dashboard hierarchy and detail rendering.
- Live rerendering as events arrive.
- Cancellation confirmation and resulting state.
- Composition with an existing custom editor.

### nono smoke test

A small smoke test will create the configured socket, connect a child process, exchange an authenticated message, and clean up. It will run before any profile change is proposed.

## Acceptance criteria

The design is complete when the implementation demonstrates all of these outcomes:

- The orchestrator can start a named, asynchronous subagent with a chosen role, model, effort, permission mode, and optional context summary.
- Twelve subagents can run concurrently by default.
- The root manager rejects work beyond configured live-agent and depth limits.
- Every agent and descendant appears in the status strip and dashboard.
- The user can inspect assignments, emitted reasoning, tools, updates, summaries, usage, failures, and child session paths.
- The user can cancel one agent, a descendant tree, or every live agent.
- A read-only agent cannot mutate through built-in tools or create an inherited-permission descendant.
- A child can promote a concise update while continuing work.
- Completion sends a concise summary to the direct parent without copying the full transcript.
- Repeated simple names receive deterministic session-wide suffixes.
- Closing or reloading the orchestrator leaves no live child process.
- The socket works under the active nono profile, or the exact required grant is documented before profile changes.
