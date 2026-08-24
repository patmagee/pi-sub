---
title: Discoverable subagent roles and models
date: 2026-08-24
repo: pi-sub
services: [pi-sub]
tags: [workflow, api-design, testing]
status: draft
superseded_by:
related:
  - docs/superpowers/specs/2026-08-20-subagent-orchestration-design.md
human_reviewed: false
decisions:
  - Make the subagent role optional and use a bundled generic role when it is omitted
  - Expose discovered role names and session-scoped model identifiers in the subagent_start tool schema
  - Use scoped models when configured and otherwise use Pi's available model catalogue
  - Accept an exact model identifier or shorthand that matches exactly one exposed identifier
  - Keep the root manager authoritative and give nested subagents the same dispatch catalogue
  - Reject invalid or ambiguous selections before agent admission
---

# Discoverable subagent roles and models

## Summary

`subagent_start` currently requires a free-form role name and accepts a free-form model identifier. The calling agent cannot see the discovered roles or Pi's current model scope in the tool schema. A guessed value therefore creates an avoidable failed dispatch.

This change makes roles optional and model choices discoverable. Omitting `role` selects a general-purpose role. The tool schema shows the exact role names and model identifiers that the root manager will accept. A caller may still use concise model shorthand when it identifies exactly one exposed model.

## Goals

- Let callers delegate general work without selecting a specialized role.
- Show valid specialized roles before a caller invokes `subagent_start`.
- Show the exact models available in the current Pi session.
- Resolve concise model shorthand without silently choosing between multiple matches.
- Apply the same dispatch choices to root and nested callers.
- Preserve existing role, model, effort, permission, and parent inheritance precedence.

## Non-goals

- Add persistent user-defined model aliases.
- Guess the caller's intended role from the task text.
- Select a preferred model when shorthand is ambiguous.
- Add separate role-list or model-list tools.
- Refresh role files without Pi's normal session reload lifecycle.
- Change provider authentication or Pi's model availability rules.

## Decisions

[HUMAN DECISION]
`role` is optional. When it is omitted, the extension uses a bundled `generic` role.
[/HUMAN DECISION]

[HUMAN DECISION]
The `subagent_start` schema exposes the discovered role names and exact model identifiers. The caller does not need a separate discovery call.
[/HUMAN DECISION]

[HUMAN DECISION]
The model catalogue uses `ctx.scopedModels` when that list is non-empty. Otherwise, it uses `ctx.modelRegistry.getAvailable()`.
[/HUMAN DECISION]

[HUMAN DECISION]
A model override accepts an exact identifier or case-insensitive shorthand that matches exactly one exposed canonical identifier. Zero or multiple matches are errors.
[/HUMAN DECISION]

[CONFIRMED DECISION]
The root manager owns the authoritative dispatch catalogue. Nested subagents receive that catalogue through the existing control connection.
[/CONFIRMED DECISION]

[CONFIRMED DECISION]
Invalid role and model selections fail before registry admission. Process and provider failures after admission remain retained agent records.
[/CONFIRMED DECISION]

## Dispatch catalogue

A dispatch catalogue contains two stable, sorted, deduplicated lists:

- Role entries with name, description, source, and role defaults.
- Model entries with the canonical `provider/model-id` identifier.

The root runtime builds the catalogue during `session_start`. A reload creates a new extension runtime and rebuilds it from current role files, project trust, model settings, provider registration, and authentication state.

### Role source

Role discovery keeps the existing precedence:

1. Trusted project roles.
2. User roles.
3. Bundled roles.

The extension adds `roles/generic.md`. It has a neutral general-purpose prompt, read-only permission by default, and no model or effort default. Normal role precedence applies, so a user or trusted project can customize `generic` through the existing override mechanism.

The generic prompt directs the child to complete the bounded assignment and follow the existing reporting contract. It does not add a specialist review, investigation, security, or search perspective.

### Model source

If `ctx.scopedModels` is non-empty, each entry contributes its model's canonical identifier. This mirrors the session model scope established by `--models` or `enabledModels`.

If `ctx.scopedModels` is empty, every model from `ctx.modelRegistry.getAvailable()` contributes its canonical identifier. An empty scoped list means Pi has not restricted the session catalogue.

The catalogue does not read or parse `settings.json` directly. Pi's runtime APIs remain authoritative for merged global settings, trusted project settings, registered providers, custom models, and resolved availability.

## Tool registration and schema

The extension registers the four subagent tools after `session_start` creates the session runtime. Pi supports tool registration at this lifecycle point and refreshes the active tool definitions immediately.

`subagent_start.role` becomes optional. Its schema exposes the sorted role names as allowed values. Its description states that omission selects `generic` and includes role descriptions so the caller can choose based on purpose.

`subagent_start.model` remains an optional string instead of a strict enumeration. Its schema description lists every canonical model identifier and states the exact and shorthand matching rules. Keeping a string permits shorthand to reach the resolver while still exposing the authoritative identifiers before invocation.

The remaining fields and schemas do not change.

## Dispatch resolution

Resolution occurs in this order before registry admission.

### Role resolution

1. Replace an omitted role with `generic`.
2. Require an explicit role to equal one catalogue role name.
3. Load that role's prompt and defaults through existing role resolution.

The extension never converts an unknown explicit role to `generic`. Generic behavior occurs only when the caller omits `role` or explicitly selects the known `generic` role.

### Model resolution

The effective model keeps the existing precedence:

1. Dispatch override.
2. Role default.
3. Parent model.

When a dispatch override is present, the resolver performs these steps:

1. Trim the input.
2. Check for an exact canonical identifier.
3. If no exact match exists, compare the lower-cased input with each lower-cased canonical identifier using substring matching.
4. If exactly one identifier matches, replace the input with that canonical identifier.
5. If no identifier matches, reject the dispatch.
6. If multiple identifiers match, reject the dispatch and report all matching identifiers.

For example, `opus` resolves to `anthropic/claude-opus-4-8` only when that is the sole exposed identifier containing `opus`. It is ambiguous when the catalogue also contains `anthropic/claude-opus-4-7`.

After precedence resolution, the effective canonical model must belong to the dispatch catalogue. This check also applies to a role default. The parent model remains valid because it already runs in the current Pi session.

Model resolution never uses a model's display name, provider marketing name, or an implicit preferred version. Only the exposed canonical identifiers participate.

### Existing precedence

Permission continues to resolve from the dispatch override, role default, then `read-only`. Effort continues to resolve from the dispatch override, role default, then parent effort. This change does not alter permission ceilings, depth limits, concurrency, naming, or working-directory behavior.

## Nested subagents

The root manager remains the only authority that admits agents. The control protocol adds a bounded dispatch-catalogue request and response.

A child runtime requests the root catalogue when it connects. It uses the returned catalogue to build its local `subagent_start` schema. A child dispatch sends the selected role and model input to the root. The root repeats authoritative resolution before admission.

This avoids differences caused by child process mode, project trust, working directory, provider state, or local resource discovery. If the child cannot retrieve a valid catalogue, it does not install a permissive fallback schema. Delegation fails with a clear control-protocol error.

The catalogue contains identifiers and role metadata only. It does not contain credentials, provider headers, settings file contents, or role file paths.

## Error handling

Selection errors occur before the agent registry admits a record. They appear as failed tool calls and do not add dashboard entries.

- An unknown role error lists every valid role and states that omission selects `generic`.
- A model input with no match lists every available canonical identifier.
- An ambiguous model input lists only the matching canonical identifiers.
- An unavailable exact identifier reports that identifier and lists the available identifiers.
- An unavailable role default identifies the role, its configured model, and the current available identifiers.
- An invalid or missing catalogue response reports a protocol error and prevents dispatch.

Errors remain bounded by the extension's existing tool-output limit. Catalogue entries are sorted to keep schemas and errors deterministic.

No invalid model silently falls back to the parent model. Parent inheritance applies only when no model override and no role model default exist.

Launch, provider, process, socket, and cancellation failures that happen after admission retain their existing agent-record behavior.

## Compatibility

The public source-level `StartInput.role` field becomes optional. Protocol validation accepts an omitted role and preserves explicit non-empty role strings.

New catalogue messages use strict protocol validation and existing frame limits. A missing or unsupported catalogue response fails clearly. The root and its children normally load the same extension path, so they use the same protocol implementation.

Existing callers that pass exact role names and exact model identifiers continue to work. Existing role files remain valid. The only intentional record-level behavior change is that invalid selections no longer create retained failed records.

The README will update the role requirement, generic behavior, model catalogue source, shorthand rules, and error behavior. It will remove the statement that every unavailable requested model creates a retained failed record.

## Testing strategy

### Tool schema tests

- `role` is optional.
- The runtime schema exposes all sorted role names and descriptions.
- The model description exposes all sorted canonical identifiers.
- Other dispatch controls retain their current validation.
- Tool registration after `session_start` makes all four tools active.

### Catalogue tests

- Non-empty `ctx.scopedModels` takes precedence over the full available catalogue.
- Empty `ctx.scopedModels` falls back to `ctx.modelRegistry.getAvailable()`.
- Role and model entries are deduplicated and sorted.
- The `generic` bundled role is always available unless normal role override precedence replaces its definition.
- Project role trust rules remain unchanged.

### Resolution tests

- Omitted role resolves to `generic`.
- An explicit known role resolves unchanged.
- An explicit unknown role fails before admission.
- An exact model identifier wins before shorthand matching.
- Shorthand matching is case-insensitive.
- One shorthand match resolves to the canonical identifier.
- Zero matches report the available identifiers.
- Multiple matches report only those matches.
- Display names do not affect matching.
- Role model defaults are checked against the catalogue.
- Model, effort, and permission precedence remains unchanged.

### Protocol and nested-dispatch tests

- A child retrieves the root catalogue after connection.
- Catalogue frames reject malformed entries and unexpected fields.
- A nested tool schema uses the root catalogue.
- The root revalidates child dispatch input.
- A missing or invalid catalogue response does not cause a permissive fallback.
- Existing dispatch, inspection, update, cancellation, and parent-message flows continue to work.

### Documentation tests

README examples show dispatch with no role, dispatch with a specialized role, an exact model identifier, and unique shorthand. Documentation states that ambiguous shorthand fails.

## Acceptance criteria

- `subagent_start` accepts `name` and `task` without `role` and starts the child with `generic`.
- The calling model sees all accepted role names in the tool schema.
- The calling model sees the current session's canonical model identifiers in the tool schema.
- The model list follows `ctx.scopedModels` when configured and otherwise follows `ctx.modelRegistry.getAvailable()`.
- An exact model identifier resolves unchanged.
- Shorthand resolves only when one canonical identifier matches.
- Ambiguous or unknown shorthand creates no agent record and reports actionable identifiers.
- Nested callers receive and use the root manager's catalogue.
- Existing exact dispatch calls and precedence rules remain compatible.
- Deterministic tests make no provider calls.
