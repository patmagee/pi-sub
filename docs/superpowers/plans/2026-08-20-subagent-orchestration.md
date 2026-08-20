# Subagent Orchestration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a session-scoped Pi extension that runs visible, cancellable, recursively managed subagents in isolated Pi subprocesses.

**Architecture:** One root manager owns a tree of Pi JSON-mode subprocesses and exposes control through a private Unix socket. Extension tools provide asynchronous dispatch, bounded inspection, updates, and cancellation. A widget below the editor and a hierarchical dashboard expose every retained agent without adding full child transcripts to the parent context.

**Tech Stack:** TypeScript, Node.js 22.19 or newer, Pi extension APIs 0.84.2, `@earendil-works/pi-tui`, TypeBox, Vitest, Unix domain sockets, and Pi JSON mode.

**Spec:** `docs/superpowers/specs/2026-08-20-subagent-orchestration-design.md`

## Global Constraints

- Every dispatch is asynchronous and returns an agent receipt immediately.
- `read-only` is the default permission. It excludes `bash`, `edit`, and `write`.
- An agent cannot grant a descendant more permission than it has.
- The default live-agent and concurrency limits are both 12.
- Nesting depth cannot exceed three, even when environment configuration requests more.
- Full child transcripts remain outside parent model context unless bounded content is requested explicitly.
- Every live process must be visible and cancellable.
- Session replacement, reload, or shutdown must terminate every live descendant.
- Provider reasoning is displayed only when Pi emits it.
- Project role files load only for trusted projects.
- Commit steps require the user's confirmation before execution.

## File map

- `package.json` declares the Pi extension package and development scripts.
- `tsconfig.json` configures strict TypeScript checks for source and tests.
- `vitest.config.ts` configures deterministic unit and process tests.
- `index.ts` registers lifecycle hooks, commands, tools, and TUI integration.
- `src/types.ts` contains shared domain types and public result shapes.
- `src/config.ts` parses environment limits and returns visible diagnostics.
- `src/names.ts` assigns session-wide unique display names.
- `src/roles.ts` discovers, validates, and resolves bundled, user, and project roles.
- `src/prompt.ts` builds child role prompts and the concise reporting contract.
- `src/registry.ts` owns agent records, state transitions, hierarchy, and policy checks.
- `src/protocol.ts` defines framed socket messages and runtime validation.
- `src/socket-server.ts` authenticates child clients and routes control messages.
- `src/socket-client.ts` connects nested extension instances to the root manager.
- `src/pi-command.ts` resolves the current Pi executable and builds child arguments.
- `src/event-reducer.ts` converts Pi JSON events into bounded agent activity.
- `src/process-runner.ts` launches, observes, and terminates one child process.
- `src/manager.ts` coordinates admission, queueing, routing, completion, and cleanup.
- `src/tools.ts` defines `subagent_start`, `subagent_update`, `subagent_inspect`, and `subagent_cancel`.
- `src/tui/status-strip.ts` renders and navigates the persistent agent strip.
- `src/tui/editor-wrapper.ts` composes focus handling with the existing editor.
- `src/tui/dashboard.ts` renders hierarchy, details, and cancellation controls.
- `roles/*.md` contains the six bundled role definitions.
- `scripts/socket-smoke.mjs` verifies local Unix socket access under nono.
- `tests/helpers/fake-pi.mjs` simulates Pi JSON events and termination behavior.
- `tests/**/*.test.ts` covers each focused module.
- `README.md` documents installation, tools, roles, limits, TUI controls, and nono validation.

---

### Task 1: Package foundation, configuration, and names

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `src/types.ts`
- Create: `src/config.ts`
- Create: `src/names.ts`
- Test: `tests/config.test.ts`
- Test: `tests/names.test.ts`

**Interfaces:**
- Produces: `SubagentConfig`, `PermissionMode`, `AgentStatus`, `AgentRecord`, `parseConfig(env)`, and `UniqueNameAllocator.allocate(base)`.
- Consumes: No application interfaces.

- [ ] **Step 1: Add package and compiler metadata**

Create `package.json` with `type: "module"`, Node `>=22.19.0`, a Pi manifest pointing to `index.ts`, and scripts named `test`, `test:watch`, and `typecheck`. Set `files` to `index.ts`, `src`, `roles`, and `README.md` so published packages exclude tests and temporary files. Put Pi packages and TypeBox in `peerDependencies` with `"*"` ranges. Put TypeScript 5.9.3, Vitest 4.1.9, Node 24 types, and the Pi packages at 0.84.2 in `devDependencies`.

Create a strict `tsconfig.json` using `module` and `moduleResolution` values of `NodeNext`, `noEmit: true`, and `types: ["node", "vitest/globals"]`. Configure `vitest.config.ts` to include `tests/**/*.test.ts` and use the Node environment.

- [ ] **Step 2: Write failing configuration tests**

Cover defaults, malformed integers, concurrency clamping, and the hard depth ceiling:

```typescript
const result = parseConfig({
  PI_SUB_MAX_AGENTS: "8",
  PI_SUB_MAX_CONCURRENCY: "20",
  PI_SUB_MAX_DEPTH: "9",
});
expect(result.config).toMatchObject({ maxAgents: 8, maxConcurrency: 8, maxDepth: 3 });
expect(result.diagnostics).toEqual([
  "PI_SUB_MAX_CONCURRENCY cannot exceed PI_SUB_MAX_AGENTS; using 8.",
  "PI_SUB_MAX_DEPTH cannot exceed 3; using 3.",
]);
```

Run `npm test -- tests/config.test.ts`. Expected result: failure because `src/config.ts` does not exist.

- [ ] **Step 3: Define shared types and implement configuration parsing**

Define exact unions:

```typescript
export type PermissionMode = "read-only" | "inherit";
export type AgentStatus = "queued" | "starting" | "running" | "completed" | "failed" | "cancelled";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface SubagentConfig {
  maxAgents: number;
  maxConcurrency: number;
  maxDepth: number;
  socketDir?: string;
  cancelGraceMs: number;
}
```

Implement `parseConfig(env: NodeJS.ProcessEnv): { config: SubagentConfig; diagnostics: string[] }`. Accept only positive base-ten integers. Use defaults 12, 12, 3, and 5000 milliseconds. Clamp concurrency to `maxAgents` and depth to three. Include the variable name and effective value in every diagnostic.

Run `npm test -- tests/config.test.ts`. Expected result: pass.

- [ ] **Step 4: Write failing unique-name tests**

Verify normalization, reuse, and stable suffixes:

```typescript
const names = new UniqueNameAllocator();
expect(names.allocate("Explore")).toBe("explore");
expect(names.allocate("explore")).toBe("explore-2");
expect(names.allocate(" explore! ")).toBe("explore-3");
expect(names.allocate("security review")).toBe("security-review");
```

Also verify that an empty normalized name throws `Agent names must contain a letter or number.`

Run `npm test -- tests/names.test.ts`. Expected result: failure because `UniqueNameAllocator` does not exist.

- [ ] **Step 5: Implement session-wide name allocation**

Normalize to lowercase ASCII letters, numbers, and single hyphens. Trim leading and trailing hyphens. Keep allocated names forever for the allocator lifetime, including after an agent completes.

Run `npm test -- tests/names.test.ts` and `npm run typecheck`. Expected result: pass.

- [ ] **Step 6: Commit the foundation after approval**

Stage only the files in this task. Proposed message: `build: establish typed extension foundation`.

---

### Task 2: Role discovery and child prompt construction

**Files:**
- Create: `src/roles.ts`
- Create: `src/prompt.ts`
- Create: `roles/scout.md`
- Create: `roles/investigator.md`
- Create: `roles/reviewer.md`
- Create: `roles/adversarial-reviewer.md`
- Create: `roles/security-auditor.md`
- Create: `roles/ticket-triager.md`
- Test: `tests/roles.test.ts`
- Test: `tests/prompt.test.ts`

**Interfaces:**
- Consumes: `PermissionMode` and `ThinkingLevel` from `src/types.ts`.
- Produces: `RoleDefinition`, `discoverRoles(options)`, `resolveRole(name, catalog)`, `ChildPromptInput`, and `buildChildPrompt(input)`.

- [ ] **Step 1: Write failing role precedence and trust tests**

Use temporary bundled, user, and project directories. Verify precedence `project > user > bundled` when `projectTrusted` is true. Verify that project roles are absent when trust is false. Verify that invalid frontmatter creates a diagnostic while valid sibling roles remain available.

Use this role shape:

```typescript
export interface RoleDefinition {
  name: string;
  description: string;
  systemPrompt: string;
  defaultModel?: string;
  defaultEffort?: ThinkingLevel;
  defaultPermission?: PermissionMode;
  source: "bundled" | "user" | "project";
  filePath: string;
}
```

Run `npm test -- tests/roles.test.ts`. Expected result: failure because role discovery is missing.

- [ ] **Step 2: Implement role discovery**

Use Pi's `parseFrontmatter` helper. Accept only `.md` regular files or symbolic links. Validate required `name` and `description` strings and supported effort and permission values. Return `{ roles: Map<string, RoleDefinition>, diagnostics: string[] }` without throwing for one malformed file.

Use `~/.pi/agent/subagents/roles` for user roles and the nearest trusted `.pi/subagents/roles` directory for project roles. Resolve bundled roles relative to the package root.

Run `npm test -- tests/roles.test.ts`. Expected result: pass.

- [ ] **Step 3: Add the six bundled roles**

Give every role an explicit evidence and summary contract. Configure `scout` with `model: anthropic/claude-haiku-4-5`, `effort: off`, and `permission: read-only`. Configure the other five roles as read-only without a fixed model so they inherit unless overridden.

Each role must end by requesting these concise sections: `Findings`, `Evidence`, `Open questions`, and `Recommended next action`. Each role must prohibit transcript and full-file reproduction.

- [ ] **Step 4: Write failing prompt-isolation tests**

Verify the prompt contains assignment, role, unique name, parent, depth, permission, optional context summary, update instructions, and final-summary format. Verify an omitted context summary produces no empty heading. Verify a sentinel parent transcript string never appears.

```typescript
const prompt = buildChildPrompt({
  name: "auth-scout",
  parentName: "orchestrator",
  depth: 1,
  maxDepth: 3,
  permission: "read-only",
  task: "Locate token validation.",
  rolePrompt: "Search quickly.",
});
expect(prompt).toContain("Locate token validation.");
expect(prompt).not.toContain("PARENT_TRANSCRIPT_SENTINEL");
```

Run `npm test -- tests/prompt.test.ts`. Expected result: failure because prompt construction is missing.

- [ ] **Step 5: Implement deterministic prompt construction**

Build one plain Markdown prompt. State that the child must use `subagent_update` for important updates. State that promotion is explicit. If `depth === maxDepth`, state that delegation is unavailable. Include no main-session message content other than `contextSummary` supplied in the input.

Run `npm test -- tests/prompt.test.ts tests/roles.test.ts` and `npm run typecheck`. Expected result: pass.

- [ ] **Step 6: Commit roles and prompts after approval**

Stage only the files in this task. Proposed message: `feat: define isolated subagent roles and prompts`.

---

### Task 3: Agent registry, hierarchy, and policy enforcement

**Files:**
- Create: `src/registry.ts`
- Test: `tests/registry.test.ts`

**Interfaces:**
- Consumes: `SubagentConfig`, `PermissionMode`, `AgentStatus`, and `UniqueNameAllocator`.
- Produces: `AgentRegistry.admit(request)`, `transition(id, status, reason?)`, `list()`, `get(id)`, `descendantsOf(id)`, `liveCount`, and `runningCount`.

- [ ] **Step 1: Write failing admission-policy tests**

Cover these exact outcomes:

- Root dispatch receives depth one.
- A depth-three parent receives `Agent depth limit reached.`
- A read-only parent requesting inherited permission receives `A read-only parent cannot grant inherited permission.`
- The thirteenth live request receives `Live subagent limit reached: 12.`
- Completed records free live capacity but retain their unique names.
- When concurrency is lower than the live limit, admitted excess work starts as `queued`.

Run `npm test -- tests/registry.test.ts`. Expected result: failure because `AgentRegistry` is missing.

- [ ] **Step 2: Define complete agent records**

Use a single immutable identity and mutable lifecycle fields:

```typescript
export interface AgentRecord {
  id: string;
  requestedName: string;
  displayName: string;
  parentId?: string;
  depth: number;
  role: string;
  task: string;
  contextSummary?: string;
  permission: PermissionMode;
  requestedModel?: string;
  effectiveModel?: string;
  requestedEffort?: ThinkingLevel;
  effectiveEffort?: ThinkingLevel;
  cwd: string;
  status: AgentStatus;
  statusReason?: string;
  pid?: number;
  sessionFile?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  updates: AgentUpdate[];
  activity: AgentActivity[];
  finalSummary?: string;
  usage: UsageTotals;
}
```

Copy records at public boundaries so TUI rendering cannot mutate registry state.

- [ ] **Step 3: Implement admission and legal state transitions**

Use `crypto.randomUUID()` for identifiers. Permit only `queued -> starting`, `starting -> running|failed|cancelled`, and `running -> completed|failed|cancelled`. Reject terminal-state changes. Record timestamps and reasons.

Implement hierarchy traversal using identifiers, not names. Count `queued`, `starting`, and `running` as live. Count only `starting` and `running` against concurrency.

Run `npm test -- tests/registry.test.ts` and `npm run typecheck`. Expected result: pass.

- [ ] **Step 4: Commit registry policy after approval**

Stage only `src/registry.ts` and `tests/registry.test.ts`. Proposed message: `feat: enforce subagent hierarchy and limits`.

---

### Task 4: Authenticated socket protocol

**Files:**
- Create: `src/protocol.ts`
- Create: `src/socket-server.ts`
- Create: `src/socket-client.ts`
- Test: `tests/protocol.test.ts`
- Test: `tests/socket.test.ts`

**Interfaces:**
- Consumes: Agent identifiers, dispatch requests, updates, and cancellation requests from prior tasks.
- Produces: `encodeFrame(message)`, `FrameDecoder.push(chunk)`, `RootSocketServer`, and `RootSocketClient`.

- [ ] **Step 1: Write failing framing and validation tests**

Use newline-delimited JSON with a maximum encoded frame size of 256 KiB. Verify fragmented frames, multiple frames in one chunk, invalid JSON, oversized frames, unknown message types, and prototype-bearing payload rejection.

Define a versioned union with these message types:

```typescript
type ControlMessage =
  | { v: 1; type: "hello"; token: string; agentId: string }
  | { v: 1; type: "dispatch"; requestId: string; parentId: string; input: StartInput }
  | { v: 1; type: "dispatch_result"; requestId: string; receipt?: StartReceipt; error?: string }
  | { v: 1; type: "update"; agentId: string; text: string; promote: boolean }
  | { v: 1; type: "inspect"; requestId: string; requesterId: string; targetId: string; view: InspectView; offset?: number; limit?: number }
  | { v: 1; type: "inspect_result"; requestId: string; result?: InspectResult; error?: string }
  | { v: 1; type: "cancel"; requestId: string; requesterId: string; targetId: string; scope: "one" | "tree" }
  | { v: 1; type: "cancel_result"; requestId: string; cancelled: string[]; error?: string }
  | { v: 1; type: "parent_message"; agentId: string; childId: string; kind: "update" | "complete" | "failed" | "cancelled"; text: string; sessionFile?: string };
```

Run `npm test -- tests/protocol.test.ts`. Expected result: failure because protocol functions are missing.

- [ ] **Step 2: Implement bounded framing and runtime validation**

Reject messages before dispatch when `v !== 1`, `type` is unknown, required strings are empty, or the frame exceeds 256 KiB. Return typed validation errors without evaluating or merging untrusted objects.

Run `npm test -- tests/protocol.test.ts`. Expected result: pass.

- [ ] **Step 3: Write failing server and client tests**

Use a temporary Unix socket directory. Verify owner-only directory mode, token authentication, agent identifier binding, request-response correlation, bounded inspection, unsolicited parent-message delivery, disconnect cleanup, and socket-file removal on close.

Run `npm test -- tests/socket.test.ts`. Expected result: failure because server and client classes are missing.

- [ ] **Step 4: Implement socket server and client**

Create the socket directory with mode `0o700`. Remove only a stale socket file owned inside that freshly created session directory. Create a random 32-byte token with `randomBytes(32).toString("hex")`.

Require `hello` as the first frame. Compare tokens with `timingSafeEqual` after equal-length validation. Bind the connection to one agent identifier after the manager confirms that record. Reject later messages whose `agentId` or `parentId` does not match the bound identity.

Add `AbortSignal` support to pending client requests. Expose a subscription for unsolicited `parent_message` frames. Reject every pending request when the socket closes.

Run `npm test -- tests/socket.test.ts tests/protocol.test.ts` and `npm run typecheck`. Expected result: pass.

- [ ] **Step 5: Commit the control protocol after approval**

Stage only the files in this task. Proposed message: `feat: add authenticated subagent control socket`.

---

### Task 5: Pi child invocation, event reduction, and process cancellation

**Files:**
- Create: `src/pi-command.ts`
- Create: `src/event-reducer.ts`
- Create: `src/process-runner.ts`
- Create: `tests/helpers/fake-pi.mjs`
- Test: `tests/pi-command.test.ts`
- Test: `tests/event-reducer.test.ts`
- Test: `tests/process-runner.test.ts`

**Interfaces:**
- Consumes: `AgentRecord`, built child prompt, socket endpoint, token, model, effort, permission tools, and cancellation grace.
- Produces: `resolvePiInvocation()`, `buildPiArgs(input)`, `PiEventReducer`, and `ProcessRunner.start(input, callbacks)`.

- [ ] **Step 1: Write failing invocation tests**

Verify the child arguments include `--mode json`, `-p`, model, effort, selected tools, persistent session behavior, extension path, and an appended prompt file. Verify read-only tools equal `read,grep,find,ls,subagent_start,subagent_update,subagent_inspect,subagent_cancel`. Verify inherited tools preserve the parent's active names without duplicates.

Verify child environment includes root socket, token, agent identifier, parent identifier, depth, and root session identifier. Do not place the token in command-line arguments.

Run `npm test -- tests/pi-command.test.ts`. Expected result: failure because invocation building is missing.

- [ ] **Step 2: Implement executable and argument resolution**

Follow Pi's installed subagent example. Prefer the current Pi script through `process.execPath` when `process.argv[1]` is a real script. Fall back to the `pi` command when running under a generic Node or Bun executable.

Write appended prompts into a private temporary directory with mode `0o700` and files with mode `0o600`. Return cleanup callbacks rather than deleting session files.

Run `npm test -- tests/pi-command.test.ts`. Expected result: pass.

- [ ] **Step 3: Write failing JSON event reducer tests**

Feed representative `message_update`, `message_end`, `tool_execution_start`, `tool_execution_end`, and session events. Verify:

- Emitted thinking is retained as `reasoning` activity.
- Assistant text is bounded in activity previews.
- Tool names and bounded arguments are retained.
- Usage totals accumulate from completed assistant messages.
- Final assistant text becomes the candidate final summary.
- A session path is captured when Pi reports one.
- Malformed lines create a visible diagnostic and do not throw.

Run `npm test -- tests/event-reducer.test.ts`. Expected result: failure because `PiEventReducer` is missing.

- [ ] **Step 4: Implement bounded event reduction**

Keep at most 500 in-memory activity entries per retained agent. Bound each preview to 8 KiB. Preserve the full child transcript only in Pi's child session. Label reasoning unavailable when no emitted thinking event exists.

Run `npm test -- tests/event-reducer.test.ts`. Expected result: pass.

- [ ] **Step 5: Build the fake Pi child and write failing runner tests**

The fake child accepts a behavior argument through an environment variable. Implement deterministic behaviors named `complete`, `crash`, `malformed`, `ignore-term`, and `slow`. It writes JSON lines matching the events used by the reducer.

Verify launch callbacks, PID capture, streaming updates, nonzero exit failure, malformed-event diagnostics, graceful `SIGTERM`, forced `SIGKILL` after the grace period, and prompt-file cleanup.

Run `npm test -- tests/process-runner.test.ts`. Expected result: failure because `ProcessRunner` is missing.

- [ ] **Step 6: Implement one-child process ownership**

Use `spawn` with `shell: false`, piped stdout and stderr, and a detached process group on Unix so forced cancellation can terminate descendants. Parse stdout incrementally by lines. Bound captured stderr to 64 KiB and mark truncation.

Remove abort listeners and timers after exit. Ensure the completion callback runs exactly once. Treat unknown exits as failure and explicit cancellation as cancelled.

Run `npm test -- tests/process-runner.test.ts tests/event-reducer.test.ts tests/pi-command.test.ts` and `npm run typecheck`. Expected result: pass.

- [ ] **Step 7: Commit process execution after approval**

Stage only the files in this task. Proposed message: `feat: run and cancel isolated Pi children`.

---

### Task 6: Root manager, scheduling, routing, and cleanup

**Files:**
- Create: `src/manager.ts`
- Test: `tests/manager.test.ts`

**Interfaces:**
- Consumes: `AgentRegistry`, role and prompt resolution, socket server, and `ProcessRunner`.
- Produces: `SubagentManager.start(input, parentContext)`, `inspect(query)`, `recordUpdate(input)`, `cancel(input)`, `shutdown(reason)`, and a subscription API for TUI changes.

- [ ] **Step 1: Write failing asynchronous admission tests**

Use fake runners and a fake clock. Verify `start` returns before runner completion, starts immediately below concurrency, queues above concurrency, starts the next queued record after a terminal transition, and rejects the thirteenth live record at the default limit.

Verify model and effort precedence: dispatch override, role default, then parent. Verify unavailable requested models return an explicit failed receipt without fallback.

Run `npm test -- tests/manager.test.ts -t admission`. Expected result: failure because the manager is missing.

- [ ] **Step 2: Implement manager admission and scheduling**

Return this stable receipt:

```typescript
export interface StartReceipt {
  id: string;
  displayName: string;
  status: "queued" | "starting" | "failed";
  depth: number;
  error?: string;
}
```

Resolve roles and model availability before creating a live process. Keep failed admission diagnostics inspectable without counting them as live. Notify subscribers after every registry mutation.

Run `npm test -- tests/manager.test.ts -t admission`. Expected result: pass.

- [ ] **Step 3: Write failing nested routing and promotion tests**

Verify a connected child can request a descendant, receives only its subtree, cannot spoof another parent identifier, and cannot exceed permission or depth. Verify a promoted update routes to the direct parent while an unpromoted update changes only dashboard state.

Run `npm test -- tests/manager.test.ts -t routing`. Expected result: failure because routing is incomplete.

- [ ] **Step 4: Implement root-authoritative routing**

Handle socket requests only through manager methods. Deliver promoted updates through a callback registered for each parent runtime. Bound promoted text to 8 KiB. Store both promoted and unpromoted updates in the record.

When a child finishes, prefer its explicit completion summary. If absent, use the reducer's final assistant text. Bound automatic parent delivery to 16 KiB and add a child-session path for deeper inspection.

Run `npm test -- tests/manager.test.ts -t routing`. Expected result: pass.

- [ ] **Step 5: Write failing cancellation and shutdown tests**

Verify cancellation of one agent, a complete descendant tree, and all live agents. Verify a non-root parent cannot cancel outside its subtree. Verify `shutdown` rejects new dispatches, cancels every runner, closes sockets, waits for exits, and is idempotent.

Run `npm test -- tests/manager.test.ts -t "cancel|shutdown"`. Expected result: failure because cleanup is incomplete.

- [ ] **Step 6: Implement deterministic cleanup**

Cancel descendants before parents. Use `Promise.allSettled` so one failed termination does not hide another live process. Return every cancellation result. Close the socket only after cancellation requests have been issued, then remove temporary runtime files.

Run `npm test -- tests/manager.test.ts` and `npm run typecheck`. Expected result: pass.

- [ ] **Step 7: Commit manager orchestration after approval**

Stage only the files in this task. Proposed message: `feat: orchestrate asynchronous subagent trees`.

---

### Task 7: Extension tools and parent-context delivery

**Files:**
- Create: `src/tools.ts`
- Create: `index.ts`
- Test: `tests/tools.test.ts`
- Test: `tests/extension-lifecycle.test.ts`

**Interfaces:**
- Consumes: `SubagentManager`, socket client, role catalog, Pi `ExtensionAPI`, and tool schemas.
- Produces: registered tools, `/subagents`, lifecycle cleanup, promoted-update messages, and final-summary messages.

- [ ] **Step 1: Write failing tool-schema and result tests**

Verify TypeBox schemas require `name`, `role`, and `task` for `subagent_start`. Verify `permission`, `contextSummary`, `model`, `effort`, and `cwd` are optional. Verify Google-compatible enums use `StringEnum`.

Verify `subagent_inspect` accepts `metadata`, `updates`, `summary`, and `session` views with optional byte offset and limit capped at 50 KiB. Verify cancellation supports `one`, `tree`, and root-only `all`.

Run `npm test -- tests/tools.test.ts`. Expected result: failure because tools are missing.

- [ ] **Step 2: Implement tool definitions and compact rendering**

Register these tools:

```typescript
subagent_start
subagent_update
subagent_inspect
subagent_cancel
```

Give each tool a prompt snippet that names the tool. Tell the orchestrator to use subagents for context-heavy exploration only when the omitted context is not necessary to judge the result. Return bounded text and structured details. Throw for execution errors so Pi marks tool failures correctly.

Render start receipts and inspection results with compact status, name, model, effort, permission, and session path. Keep expanded rendering bounded.

Run `npm test -- tests/tools.test.ts`. Expected result: pass.

- [ ] **Step 3: Write failing root and child lifecycle tests**

Simulate root mode with no `PI_SUB_ROOT_SOCKET` and child mode with socket environment variables. Verify only the root creates a manager. Verify children connect as clients and route nested tool calls to root. Verify `session_shutdown` cancels and disposes root resources for `quit`, `reload`, `new`, `resume`, and `fork`.

Verify project roles are passed `ctx.isProjectTrusted()`. Verify startup diagnostics use `ctx.ui.notify` only when UI exists.

Run `npm test -- tests/extension-lifecycle.test.ts`. Expected result: failure because `index.ts` is missing.

- [ ] **Step 4: Implement extension registration and delivery**

Start session resources in `session_start`, never in the extension factory. Use one idempotent cleanup path from `session_shutdown`.

For a promoted update, call `pi.sendMessage` with custom type `subagent-update`, `deliverAs: "steer"`, and `triggerTurn: true`. For completion, use custom type `subagent-complete`, `deliverAs: "followUp"`, and `triggerTurn: true`. Include only bounded summary content and identifying metadata.

Register message renderers that show source agent and status. Do not include full transcript details in message content.

Run `npm test -- tests/tools.test.ts tests/extension-lifecycle.test.ts` and `npm run typecheck`. Expected result: pass.

- [ ] **Step 5: Commit extension tools after approval**

Stage only the files in this task. Proposed message: `feat: expose asynchronous subagent controls`.

---

### Task 8: Status strip, editor focus, and dashboard

**Files:**
- Create: `src/tui/status-strip.ts`
- Create: `src/tui/editor-wrapper.ts`
- Create: `src/tui/dashboard.ts`
- Test: `tests/tui/status-strip.test.ts`
- Test: `tests/tui/editor-wrapper.test.ts`
- Test: `tests/tui/dashboard.test.ts`
- Modify: `index.ts`

**Interfaces:**
- Consumes: Read-only agent snapshots and manager subscriptions.
- Produces: below-editor widget, focus transitions, `/subagents` dashboard, detail view, and cancellation callbacks.

- [ ] **Step 1: Write failing status-strip rendering tests**

Verify every retained agent appears, lines never exceed the supplied width, and each state uses a symbol plus a textual or accessible label in expanded help. Verify narrow widths wrap without slicing ANSI escape sequences. Verify selection remains stable by agent identifier when records update.

Run `npm test -- tests/tui/status-strip.test.ts`. Expected result: failure because the strip is missing.

- [ ] **Step 2: Implement the below-editor status strip**

Use `truncateToWidth`, `visibleWidth`, and `wrapTextWithAnsi` from `@earendil-works/pi-tui`. Use theme colors from the widget factory. Map queued to muted, running to warning, completed to success, failed to error, and cancelled to dim.

Expose `selectPrevious`, `selectNext`, `selectedId`, `setFocused`, and `openSelected`. Invalidate cached lines after every manager update or focus change.

Run `npm test -- tests/tui/status-strip.test.ts`. Expected result: pass.

- [ ] **Step 3: Write failing editor-composition tests**

Use a fake prior editor. Verify ordinary keys pass through unchanged. Verify `Shift+Down` focuses the strip. While strip-focused, verify arrows change selection, `Enter` opens details, and `Escape` or `Shift+Up` restores editor focus. Verify submission does not occur while the strip owns focus.

Run `npm test -- tests/tui/editor-wrapper.test.ts`. Expected result: failure because the wrapper is missing.

- [ ] **Step 4: Implement a composable editor wrapper**

Extend `CustomEditor` only when no previous factory exists. When a previous editor exists, wrap its component through a small `Component` and `Focusable` adapter. Propagate focus for Input Method Editor support. Delegate unhandled input, rendering, invalidation, and disposal to the prior component.

Use `matchesKey(data, Key.shift("down"))` and the injected keybinding manager for selection confirmation and cancellation where available.

Run `npm test -- tests/tui/editor-wrapper.test.ts`. Expected result: pass.

- [ ] **Step 5: Write failing dashboard hierarchy and detail tests**

Verify parent-child indentation, status, elapsed time, model, effort, permission, depth, and update indicator. Verify detail rendering includes assignment, optional context summary, available reasoning state, tool activity, updates, usage, final summary, failure, PID, and session path.

Verify `c` requests one-agent cancellation, `shift+c` requests subtree cancellation, and `ctrl+c` requests global cancellation only for the root. Verify subtree and global actions invoke confirmation callbacks.

Run `npm test -- tests/tui/dashboard.test.ts`. Expected result: failure because the dashboard is missing.

- [ ] **Step 6: Implement dashboard and live rerendering**

Use `ctx.ui.custom` with a fresh component per opening. Keep list and detail modes inside one component so Back does not reuse a disposed overlay. Use `tui.requestRender()` after manager subscription updates.

The reasoning section must show `Reasoning was not emitted by the provider.` when no thinking events exist. Do not display an empty section that implies certainty.

Run `npm test -- tests/tui/dashboard.test.ts`. Expected result: pass.

- [ ] **Step 7: Register TUI behavior in the extension**

In TUI mode, set the widget with `{ placement: "belowEditor" }`, compose the editor wrapper, and register `/subagents`. In non-TUI modes, register tools and lifecycle behavior without custom components.

Dispose manager subscriptions and restore no global UI state after session shutdown. Let Pi's runtime rebuild widgets and editor composition on reload.

Run all TUI tests plus `npm run typecheck`. Expected result: pass.

- [ ] **Step 8: Commit TUI management after approval**

Stage only the files in this task. Proposed message: `feat: add visible subagent dashboard and controls`.

---

### Task 9: Close integration and lifecycle gaps

**Files:**
- Modify: `index.ts`
- Modify: `src/config.ts`
- Modify: `src/event-reducer.ts`
- Modify: `src/manager.ts`
- Modify: `src/pi-command.ts`
- Modify: `src/process-runner.ts`
- Modify: `src/protocol.ts`
- Modify: `src/registry.ts`
- Modify: `src/socket-server.ts`
- Modify: `src/tools.ts`
- Modify: `src/tui/status-strip.ts`
- Modify: `src/types.ts`
- Modify: `README.md`
- Modify: focused tests under `tests/`

**Interfaces:**
- Consumes: The complete extension package and Pi 0.84.2 JSON events, session manager API, and extension lifecycle.
- Produces: Truthful terminal states, recursive parent delivery, inspectable session paths, agent-bound socket authentication, bounded terminal retention, and a live-only status strip.

#### 9.1 Classify exit-zero assistant errors as failures

- [ ] Add a failing reducer test in `tests/event-reducer.test.ts` for a `message_end` event whose assistant message has `stopReason: "error"`, `errorMessage: "provider denied the request"`, and no text. Assert that the snapshot retains the exact provider error.
- [ ] Add a failing runner test in `tests/process-runner.test.ts` where the fake Pi emits that assistant error and exits with code zero. Assert that `ProcessResult.status` is `failed` and `stderr` or the retained terminal reason contains `provider denied the request`.
- [ ] Extend `PiEventReducerSnapshot` with a bounded terminal provider error. Read `message.stopReason` and `message.errorMessage` from the authoritative `message_end.message` object.
- [ ] Make `OwnedProcessHandle` prefer cancellation state first, then reducer terminal errors, then the operating-system exit code when selecting `ProcessResult.status`.
- [ ] Run `npm test -- tests/event-reducer.test.ts tests/process-runner.test.ts` and `npm run typecheck`. Expected result: all focused tests pass and TypeScript reports no errors.
- [ ] Commit this functional unit after approval with `fix: report provider failures from child sessions`.

#### 9.2 Expose the agent identifier in visible start receipts

- [ ] Change the existing start-tool test in `tests/tools.test.ts` to require `agent-1` in `result.content[0].text`, not only in `result.details`.
- [ ] Run `npm test -- tests/tools.test.ts`. Expected result: failure because visible output omits the identifier.
- [ ] Update `registerSubagentTools()` so the compact result includes `id=<receipt.id>` alongside name, status, and depth.
- [ ] Run `npm test -- tests/tools.test.ts` and `npm run typecheck`. Expected result: pass.
- [ ] Commit this functional unit after approval with `fix: expose inspectable subagent identifiers`.

#### 9.3 Deliver descendant messages into the direct parent context

- [ ] Add a failing child-runtime lifecycle test in `tests/extension-lifecycle.test.ts`. Deliver an unsolicited `parent_message` through a fake `RootSocketClient`, then assert that the child runtime calls `sendMessage()` with `deliverAs: "steer"` for updates and `deliverAs: "followUp"` for terminal messages.
- [ ] Refactor `createChildRuntime()` dependency construction only as far as needed to inject a fake socket client without replacing the entire child runtime.
- [ ] Subscribe once through `RootSocketClient.subscribeParentMessages()` after the child connects. Route each message through `sendParentDelivery()`, preserving `childId`, `kind`, text, and optional session path.
- [ ] Dispose the parent-message subscription before closing the socket during child session shutdown.
- [ ] Run `npm test -- tests/extension-lifecycle.test.ts tests/socket.test.ts` and `npm run typecheck`. Expected result: pass with no duplicate delivery after shutdown.
- [ ] Commit this functional unit after approval with `fix: deliver recursive subagent updates to parents`.

#### 9.4 Obtain child session paths through Pi's supported session API

- [ ] Add a `session_ready` control message to `src/protocol.ts` with the bound `agentId` and `sessionFile`. Add validation tests that reject missing, empty, oversized, or mismatched fields.
- [ ] Add a failing lifecycle test proving that child startup sends `ctx.sessionManager.getSessionFile()` to the root after socket authentication.
- [ ] Add a failing manager test proving that the root records the path only for the socket-bound agent and exposes it through `summary` and bounded `session` inspection.
- [ ] Send `session_ready` from `createChildRuntime()` when `getSessionFile()` returns a path. Do not infer a path from Pi's JSON session header.
- [ ] Route `session_ready` in `createRootRuntime()` to a dedicated `SubagentManager.recordSessionFile(agentId, path)` method. Keep socket identity binding authoritative.
- [ ] Remove `sessionFile` and `path` inference from `PiEventReducer` and update `tests/helpers/fake-pi.mjs` so fake JSON matches Pi's documented session header.
- [ ] Run `npm test -- tests/protocol.test.ts tests/manager.test.ts tests/extension-lifecycle.test.ts tests/event-reducer.test.ts tests/process-runner.test.ts` and `npm run typecheck`. Expected result: pass.
- [ ] Commit this functional unit after approval with `fix: register child session files through Pi context`.

#### 9.5 Notify parents when queued launches fail

- [ ] Add a failing manager test with one running agent and one queued agent whose later `prepareProcess()` call rejects. Assert that the queued agent becomes `failed` and its direct parent receives exactly one failed terminal delivery.
- [ ] Separate immediate admission failures from asynchronous launch failures. The immediate `subagent_start` receipt remains authoritative, while failures after a queued receipt always call `deliverTerminal()`.
- [ ] Guard terminal delivery with the existing `deliveredTerminal` set so cancellation and launch rejection cannot duplicate messages.
- [ ] Run `npm test -- tests/manager.test.ts` and `npm run typecheck`. Expected result: pass.
- [ ] Commit this functional unit after approval with `fix: deliver queued launch failures`.

#### 9.6 Bind socket credentials to one agent identity

- [ ] Replace the shared-token socket test with failing tests for three cases: the issued agent authenticates, a sibling cannot reuse that credential, and a child cannot authenticate as its parent.
- [ ] Add `RootSocketServer.issueCredential(agentId)` and `RootSocketServer.revokeCredential(agentId)`. Generate independent random credentials and compare them with `timingSafeEqual` only after validating equal byte length.
- [ ] Remove the public shared `server.token`. In `prepareProcess()`, issue the credential for `record.id` and pass only that value as `PI_SUB_ROOT_TOKEN`.
- [ ] Revoke credentials after terminal completion, cancellation, failed launch, and shutdown. Keep the owner-only socket directory and socket permissions.
- [ ] Add a process-command test proving each child environment contains only its own agent identifier and credential.
- [ ] Run `npm test -- tests/socket.test.ts tests/pi-command.test.ts tests/manager.test.ts` and `npm run typecheck`. Expected result: pass.
- [ ] Commit this security unit after adversarial review and human approval with `fix: bind control credentials to agent identities`.

#### 9.7 Show only live agents in the status strip

- [ ] Change `tests/tui/status-strip.test.ts` so queued, starting, and running agents appear, while completed, failed, and cancelled agents do not. Keep `/subagents` dashboard tests requiring terminal records for inspection.
- [ ] Add a transition test that selects a running agent, marks it completed, and asserts that it disappears immediately while selection moves to the nearest remaining live identifier.
- [ ] Filter terminal records inside `SubagentStatusStrip.setRecords()` and the constructor. Do not filter manager subscriptions or dashboard records.
- [ ] Render the empty live-state message when every retained agent is terminal.
- [ ] Run `npm test -- tests/tui/status-strip.test.ts tests/tui/dashboard.test.ts tests/extension-lifecycle.test.ts` and `npm run typecheck`. Expected result: pass.
- [ ] Commit this functional unit after approval with `fix: remove terminal agents from status strip`.

#### 9.8 Make the child context boundary explicit

The original design intentionally gives children the assigned working directory and normal Pi governing resource discovery. Do not silently change that contract while fixing prompt isolation.

- [ ] Amend `docs/superpowers/specs/2026-08-20-subagent-orchestration-design.md` and `README.md` to distinguish prompt isolation from process isolation. State that raw parent conversation history is excluded, while normal user and trusted-project instructions, skills, extensions, and context files may load.
- [ ] Add an opt-in real-Pi assertion in `tests/integration/real-pi.test.ts` with three sentinels: the explicit context-summary sentinel appears, the raw parent-transcript sentinel does not, and a trusted project-instruction sentinel does appear.
- [ ] Add a deterministic `buildPiArgs()` test proving stale inherited `PI_SUB_ROOT_SOCKET`, `PI_SUB_ROOT_TOKEN`, `PI_SUB_AGENT_ID`, `PI_SUB_PARENT_ID`, `PI_SUB_DEPTH`, and `PI_SUB_ROOT_SESSION_ID` values are replaced for each child rather than leaking from its parent environment.
- [ ] Do not add `--no-context-files` or disable normal resource discovery unless a later approved design explicitly replaces the governing-context contract.
- [ ] Run `npm test -- tests/pi-command.test.ts tests/prompt.test.ts` and `npm run typecheck`. Expected result: pass. Leave the real-Pi assertion skipped without opt-in.
- [ ] Commit this contract unit after approval with `docs: clarify subagent context boundaries`.

#### 9.9 Bound retained terminal records

- [ ] Add `PI_SUB_MAX_RETAINED` with a default of `100`. Parse it as a positive integer and document it in `README.md`.
- [ ] Add failing config tests for the default, valid override, and invalid fallback diagnostic.
- [ ] Add failing registry tests that complete more than the configured retained limit. Assert that the oldest eligible terminal records are pruned, live records are never pruned, and terminal ancestors of live descendants remain until those descendants become terminal.
- [ ] Add `AgentRegistry.pruneTerminalRecords()` and call it after every terminal transition. Preserve deep-copy boundaries and stable insertion order for surviving records.
- [ ] Add a TUI subscription test proving pruned identifiers disappear from the dashboard without disturbing selection when the selected identifier survives.
- [ ] Run `npm test -- tests/config.test.ts tests/registry.test.ts tests/manager.test.ts tests/tui/dashboard.test.ts` and `npm run typecheck`. Expected result: pass.
- [ ] Commit this functional unit after approval with `feat: bound retained subagent records`.

#### 9.10 Add deterministic integration-contract coverage

- [ ] Add a root-to-child socket integration test that uses the real `RootSocketServer`, `RootSocketClient`, `SubagentManager`, and fake Pi process together. Cover dispatch, child update, grandchild update, terminal delivery, inspection, and shutdown without replacing runtime factories.
- [ ] Add an exit-zero provider-error scenario to `tests/helpers/fake-pi.mjs` using Pi's documented `message_end.message` shape.
- [ ] Assert that shutdown leaves no fake child process alive, removes the socket directory, revokes credentials, and resolves every pending request.
- [ ] Assert that all inspection and tool output caps report truncation rather than silently returning apparently complete data.
- [ ] Run `npm test` and `npm run typecheck`. Expected result: every deterministic test passes and TypeScript reports no errors.
- [ ] Request adversarial review of process ownership, socket identity, failure classification, context boundaries, and cleanup before Task 10.
- [ ] Commit this functional unit after approval with `test: cover recursive subagent integration contracts`.

---

### Task 10: nono smoke test, real-Pi integration, and documentation

**Files:**
- Create: `scripts/socket-smoke.mjs`
- Create: `tests/integration/real-pi.test.ts`
- Modify: `README.md`
- Modify: `package.json`

**Interfaces:**
- Consumes: The complete extension package.
- Produces: Repeatable sandbox validation, opt-in real-Pi coverage, and user documentation.

- [ ] **Step 1: Create and run the socket smoke test**

The script must create a private temporary directory under `PI_SUB_SOCKET_DIR` or `os.tmpdir()`, listen on a Unix socket, spawn one Node child, authenticate with a random token, exchange one JSON frame, close both ends, and remove the directory.

Add `npm run smoke:socket`. Run it under the current nono session. Expected result: `socket smoke test passed`.

If the command receives a nono permission denial, run:

```bash
nono why --self --path <resolved-socket-directory> --op readwrite
```

Record the exact denied path and operation. Do not edit active nono profiles.

- [ ] **Step 2: Write opt-in real-Pi integration tests**

Guard the suite with `PI_SUB_REAL_INTEGRATION=1`. Start the extension through the local Pi executable with a temporary working directory and controlled role file. Verify:

- The visible start receipt includes the agent identifier.
- The child reports its actual session file through `ctx.sessionManager.getSessionFile()`, and bounded session inspection reads that file.
- Read-only mode lacks `bash`, `edit`, and `write`.
- A context-summary sentinel appears while a parent-transcript sentinel does not and a trusted project-instruction sentinel does appear.
- A grandchild's promoted update and terminal summary enter only its direct parent's context.
- A depth-three child cannot delegate.
- A failed provider message cannot become a completed record with an empty summary.
- Completed, failed, and cancelled agents leave the status strip but remain in `/subagents` until retention pruning.
- Closing the root leaves no child PID alive.

Use a configured low-cost model from `PI_SUB_TEST_MODEL`. Fail with a clear prerequisite message when the opt-in variable is set but the model variable is absent.

Run `npm test -- tests/integration/real-pi.test.ts` without opt-in. Expected result: skipped.

- [ ] **Step 3: Update the operating documentation**

Document:

- SSH installation with `pi install git:git@github.com:patmagee/pi-sub` and temporary use with `pi -e git:git@github.com:patmagee/pi-sub`.
- The four tools and asynchronous completion behavior.
- Permission and context modes.
- Built-in and custom role locations.
- Model and effort precedence.
- Environment variables and hard depth ceiling.
- Status symbols, `/subagents`, and keyboard navigation.
- Child session inspection and output bounds.
- Cancellation and session cleanup.
- The nono smoke command and the rule that active profiles are not edited automatically.
- Deterministic tests and opt-in real-model tests.

Use complete sentences and no claims that reasoning is available when providers do not emit it.

- [ ] **Step 4: Run deterministic verification**

Run:

```bash
npm test
npm run typecheck
npm run smoke:socket
npm pack --dry-run
```

Expected result: every test passes, type checking reports no errors, the socket smoke test passes, and the package includes `index.ts`, `src`, `roles`, `README.md`, and `package.json` without tests or temporary files.

- [ ] **Step 5: Run real-model verification only after approval**

Because this validation uses model credentials and can incur cost, ask before running:

```bash
PI_SUB_REAL_INTEGRATION=1 PI_SUB_TEST_MODEL=<provider/model> npm test -- tests/integration/real-pi.test.ts
```

Expected result: all integration cases pass and no child PID remains alive.

- [ ] **Step 6: Request adversarial review**

Review process ownership, authentication, permission ceilings, cancellation races, prompt leakage, session cleanup, TUI focus composition, and documentation against the design specification. Resolve every accepted finding with a focused failing test before changing implementation.

- [ ] **Step 7: Commit validation and documentation after approval**

Stage only the files in this task. Proposed message: `docs: document and verify subagent operations`.

---

## Final verification and handoff

- [ ] Run `git diff --check` and inspect `git status --short` for generated or temporary files.
- [ ] Run `npm test`, `npm run typecheck`, `npm run smoke:socket`, and `npm pack --dry-run` with fresh output.
- [ ] Confirm every acceptance criterion in the specification has a matching passing test or documented manual check.
- [ ] Confirm no `.claude/work/` file is staged.
- [ ] Ask before the final commit, push, package installation, or real-model integration run.
- [ ] Request human review. Agent review does not authorize a merge.
