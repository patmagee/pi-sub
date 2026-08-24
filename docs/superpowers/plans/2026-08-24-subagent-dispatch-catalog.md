# Discoverable Subagent Dispatch Choices Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `subagent_start.role` optional and expose authoritative roles and models while resolving only unambiguous model shorthand.

**Architecture:** A focused dispatch-catalog module builds stable role and model choices from Pi runtime state and resolves dispatch inputs before admission. The root runtime owns this catalogue, sends it to nested children through validated control messages, and supplies it when the tools are registered at `session_start`.

**Tech Stack:** TypeScript 5.9, Pi extension APIs, TypeBox, Vitest, Unix socket control protocol.

**Spec:** `docs/superpowers/specs/2026-08-24-subagent-dispatch-catalog-design.md`

## Global Constraints

- Use `ctx.scopedModels` when non-empty and `ctx.modelRegistry.getAvailable()` otherwise.
- Match shorthand case-insensitively against canonical `provider/model-id` strings only.
- Accept shorthand only when exactly one canonical identifier matches.
- Do not silently replace an invalid explicit role or model.
- Reject selection errors before agent registry admission.
- Preserve permission ceilings, depth limits, and existing model, effort, and permission precedence.
- Do not call a real model provider from deterministic tests.

---

### Task 1: Dispatch catalogue and generic role

**Files:**
- Create: `src/dispatch-catalog.ts`
- Create: `tests/dispatch-catalog.test.ts`
- Create: `roles/generic.md`
- Modify: `src/protocol.ts`

**Interfaces:**
- Produces: `DispatchCatalog`, `DispatchRoleChoice`, `buildDispatchCatalog()`, `resolveRoleName()`, and `resolveModelIdentifier()`.
- Consumes: `RoleDefinition` and simple Pi model values containing `provider` and `id`.

- [ ] **Step 1: Write failing catalogue and resolver tests**

Cover sorted and deduplicated roles, scoped-model preference, available-model fallback, omitted role resolution, exact model resolution, unique case-insensitive shorthand, zero matches, and ambiguous matches. Use assertions such as:

```ts
expect(resolveRoleName(undefined, catalog)).toBe("generic");
expect(resolveModelIdentifier("OPUS", catalog)).toBe("anthropic/claude-opus-4-8");
expect(() => resolveModelIdentifier("opus", ambiguous)).toThrow(
  "Model shorthand \"opus\" is ambiguous: anthropic/claude-opus-4-7, anthropic/claude-opus-4-8.",
);
```

- [ ] **Step 2: Run the focused tests and verify failure**

Run: `npm test -- tests/dispatch-catalog.test.ts`

Expected: FAIL because `src/dispatch-catalog.ts` does not exist.

- [ ] **Step 3: Implement catalogue types and pure resolution**

Use these public shapes:

```ts
export interface DispatchRoleChoice {
  name: string;
  description: string;
  source: "bundled" | "user" | "project";
  defaultModel?: string;
  defaultEffort?: ThinkingLevel;
  defaultPermission?: PermissionMode;
}

export interface DispatchCatalog {
  roles: DispatchRoleChoice[];
  models: string[];
}

export interface ModelLike {
  provider: string;
  id: string;
}

export function buildDispatchCatalog(input: {
  roles: ReadonlyMap<string, RoleDefinition>;
  scopedModels: readonly ModelLike[];
  availableModels: readonly ModelLike[];
}): DispatchCatalog;

export function resolveRoleName(requested: string | undefined, catalog: DispatchCatalog): string;
export function resolveModelIdentifier(requested: string, catalog: DispatchCatalog): string;
```

`resolveRoleName()` must default only omitted input to `generic`. `resolveModelIdentifier()` must trim input, check an exact identifier first, then perform case-insensitive substring matching. Error messages must contain deterministic sorted identifiers.

- [ ] **Step 4: Add the bundled generic role**

Create `roles/generic.md` with frontmatter name `generic`, description `Completes a bounded general-purpose assignment`, permission `read-only`, and no model or effort default. Its body must direct the child to complete the assignment using evidence and the existing reporting contract without adding a specialist perspective.

- [ ] **Step 5: Make protocol `StartInput.role` optional**

Change `StartInput.role` to `role?: string`. In `validateStartInput()`, replace the required `stringField(input, "role")` call with `optionalString(input, "role")`.

- [ ] **Step 6: Run focused tests**

Run: `npm test -- tests/dispatch-catalog.test.ts tests/protocol.test.ts tests/roles.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/dispatch-catalog.ts src/protocol.ts roles/generic.md tests/dispatch-catalog.test.ts
git commit -m "feat: resolve discoverable dispatch choices"
```

---

### Task 2: Validate role and model choices before manager admission

**Files:**
- Modify: `src/manager.ts`
- Modify: `tests/manager.test.ts`

**Interfaces:**
- Consumes: `DispatchCatalog`, `resolveRoleName()`, and `resolveModelIdentifier()` from Task 1.
- Changes: `ManagerOptions.modelAvailable` becomes `catalog: DispatchCatalog`.
- Produces: canonical role and model values in admitted `AgentRecord` objects.

- [ ] **Step 1: Replace the retained-failure tests with pre-admission tests**

Add tests that verify:

```ts
await expect(instance.start({ name: "generic", task: "inspect" }, rootContext)).resolves.toMatchObject({
  status: "starting",
});
await expect(
  instance.start({ name: "bad-role", role: "missing", task: "inspect" }, rootContext),
).rejects.toThrow('Unknown subagent role "missing"');
await expect(
  instance.start({ name: "ambiguous", role: "scout", task: "inspect", model: "opus" }, rootContext),
).rejects.toThrow('Model shorthand "opus" is ambiguous');
```

Also assert that `runner.started` and the registry remain unchanged for rejected selections. Keep coverage for dispatch override, role default, and parent-model precedence.

- [ ] **Step 2: Run manager tests and verify failure**

Run: `npm test -- tests/manager.test.ts`

Expected: FAIL because the manager still requires a role and retains invalid model records.

- [ ] **Step 3: Resolve selections before `registry.admit()`**

At the start of `SubagentManager.start()`:

```ts
const roleName = resolveRoleName(input.role, this.options.catalog);
const role = this.options.roles.get(roleName);
if (!role) throw new Error(`Resolved role is unavailable: ${roleName}.`);
const requestedModel = input.model
  ? resolveModelIdentifier(input.model, this.options.catalog)
  : undefined;
const effectiveModel = requestedModel ?? role.defaultModel ?? parentContext.model;
```

Validate a role default against `catalog.models` before admission. Store `roleName`, the original requested model text in `requestedModel`, and the canonical model in `effectiveModel`. Remove the old post-admission unknown-role and `modelAvailable` failure branches.

- [ ] **Step 4: Run manager and registry tests**

Run: `npm test -- tests/manager.test.ts tests/registry.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/manager.ts tests/manager.test.ts
git commit -m "fix: reject invalid dispatch choices before admission"
```

---

### Task 3: Transfer the root catalogue to nested subagents

**Files:**
- Modify: `src/protocol.ts`
- Modify: `src/socket-client.ts`
- Modify: `src/socket-server.ts`
- Modify: `index.ts`
- Modify: `tests/protocol.test.ts`
- Modify: `tests/socket.test.ts`
- Modify: `tests/extension-lifecycle.test.ts`
- Modify: `tests/integration/socket-contract.test.ts`

**Interfaces:**
- Adds request: `{ v: 1, type: "catalog", requestId, requesterId }`.
- Adds response: `{ v: 1, type: "catalog_result", requestId, catalog?, error? }`.
- Adds: `SessionRuntime.catalog: DispatchCatalog`.
- Consumes: root catalogue built from discovered roles and Pi runtime models.

- [ ] **Step 1: Add failing protocol and socket tests**

Verify that a bound child can request the catalogue, malformed catalogue entries fail validation, and identity spoofing returns a correlated `catalog_result` error. Update child-runtime tests so the fake client returns a valid catalogue before the runtime is created.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `npm test -- tests/protocol.test.ts tests/socket.test.ts tests/extension-lifecycle.test.ts`

Expected: FAIL because catalogue messages and `SessionRuntime.catalog` do not exist.

- [ ] **Step 3: Add strict catalogue protocol validation**

Extend `ControlMessage`, `MESSAGE_TYPES`, request and response unions, server client-message narrowing, identity selection, response errors, and client correlation. Validate role names, descriptions, sources, optional defaults, and canonical model strings. Reject unknown message shapes through the existing strict field validation conventions.

- [ ] **Step 4: Build and serve the root catalogue**

In `createRootRuntime()`, build the catalogue with:

```ts
const catalog = buildDispatchCatalog({
  roles: discovered.roles,
  scopedModels: input.ctx.scopedModels.map((entry) => entry.model),
  availableModels: input.ctx.modelRegistry.getAvailable(),
});
```

Pass `catalog` into `SubagentManager`. Handle `catalog` requests before dispatch requests and return the same catalogue. Return it as `SessionRuntime.catalog`.

- [ ] **Step 5: Retrieve the catalogue in child runtimes**

After connecting, send a correlated catalogue request with the bound agent identifier. Reject a missing or error response. Return the validated catalogue as `SessionRuntime.catalog`. Do not construct a local fallback.

- [ ] **Step 6: Run protocol, socket, lifecycle, and socket-contract tests**

Run: `npm test -- tests/protocol.test.ts tests/socket.test.ts tests/extension-lifecycle.test.ts tests/integration/socket-contract.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/protocol.ts src/socket-client.ts src/socket-server.ts index.ts tests/protocol.test.ts tests/socket.test.ts tests/extension-lifecycle.test.ts tests/integration/socket-contract.test.ts
git commit -m "feat: share dispatch catalogue with nested agents"
```

---

### Task 4: Register a catalogue-aware tool schema and update documentation

**Files:**
- Modify: `src/tools.ts`
- Modify: `index.ts`
- Modify: `tests/tools.test.ts`
- Modify: `tests/extension-lifecycle.test.ts`
- Modify: `README.md`

**Interfaces:**
- Changes: `registerSubagentTools(pi, controller, catalog)`.
- Produces: an optional role enum and a model description containing exact canonical identifiers.

- [ ] **Step 1: Write failing schema and lifecycle tests**

Verify that `subagent_start` is registered during `session_start`, not before it. Assert that role omission validates, known roles validate, unknown roles fail schema validation, and the model schema description includes exact identifiers plus the unique-shorthand rule.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `npm test -- tests/tools.test.ts tests/extension-lifecycle.test.ts`

Expected: FAIL because the start schema is static and role is required.

- [ ] **Step 3: Generate `SubagentStartSchema` from the catalogue**

Replace the static start schema with:

```ts
export function createSubagentStartSchema(catalog: DispatchCatalog) {
  return Type.Object({
    name: Type.String({ minLength: 1, description: "Short display name for the agent" }),
    role: Type.Optional(StringEnum(catalog.roles.map((role) => role.name), {
      description: roleDescription(catalog),
    })),
    task: Type.String({ minLength: 1, description: "Bounded assignment" }),
    model: Type.Optional(Type.String({ minLength: 1, description: modelDescription(catalog) })),
    permission: Type.Optional(StringEnum(["read-only", "inherit"] as const)),
    contextSummary: Type.Optional(Type.String({ description: "Explicit parent-written context summary" })),
    effort: Type.Optional(
      StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const),
    ),
    cwd: Type.Optional(Type.String({ minLength: 1, description: "Working directory" })),
  }, { additionalProperties: false });
}
```

If `StringEnum` does not accept schema options in the installed Pi AI version, assign the description through the supported TypeBox schema form while preserving a Google-compatible enum. The catalogue always contains `generic`, so the role enum is never empty.

- [ ] **Step 4: Register tools after runtime creation**

Move `registerSubagentTools(pi, proxy)` from extension factory setup into `session_start`, after `runtime` is assigned. Pass `runtime.catalog`. Keep command and renderer registration at factory setup.

- [ ] **Step 5: Update README behavior and examples**

Document `generic`, optional roles, schema-visible choices, scoped-model preference, exact identifiers, unique shorthand, ambiguity errors, and pre-admission selection failures. Add one role-free example and one unambiguous shorthand example.

- [ ] **Step 6: Run focused and full validation**

Run:

```bash
npm test -- tests/tools.test.ts tests/extension-lifecycle.test.ts
npm test
npm run typecheck
npm run smoke:socket
```

Expected: all commands exit zero. The deterministic suite must not call a provider.

- [ ] **Step 7: Commit**

```bash
git add src/tools.ts index.ts tests/tools.test.ts tests/extension-lifecycle.test.ts README.md
git commit -m "feat: expose subagent roles and models"
```
