import { describe, expect, it } from "vitest";
import {
  buildDispatchCatalog,
  resolveModelIdentifier,
  resolveRoleName,
} from "../src/dispatch-catalog.js";
import type { RoleDefinition } from "../src/roles.js";

function role(name: string, description = `${name} description`): RoleDefinition {
  return {
    name,
    description,
    systemPrompt: `${name} prompt`,
    source: "bundled",
    filePath: `/roles/${name}.md`,
  };
}

describe("dispatch catalogue", () => {
  it("sorts roles and prefers scoped models", () => {
    const catalog = buildDispatchCatalog({
      roles: new Map([
        ["scout", role("scout")],
        ["generic", role("generic")],
      ]),
      scopedModels: [
        { provider: "openai", id: "gpt-5.4" },
        { provider: "anthropic", id: "claude-opus-4-8" },
        { provider: "openai", id: "gpt-5.4" },
      ],
      availableModels: [{ provider: "google", id: "gemini-3.1-pro" }],
    });

    expect(catalog.roles.map(({ name }) => name)).toEqual(["generic", "scout"]);
    expect(catalog.models).toEqual([
      "anthropic/claude-opus-4-8",
      "openai/gpt-5.4",
    ]);
  });

  it("uses available models when the session has no model scope", () => {
    const catalog = buildDispatchCatalog({
      roles: new Map([["generic", role("generic")]]),
      scopedModels: [],
      availableModels: [
        { provider: "google", id: "gemini-3.1-pro" },
        { provider: "anthropic", id: "claude-opus-4-8" },
      ],
    });

    expect(catalog.models).toEqual([
      "anthropic/claude-opus-4-8",
      "google/gemini-3.1-pro",
    ]);
  });
});

describe("dispatch selection", () => {
  const catalog = buildDispatchCatalog({
    roles: new Map([
      ["generic", role("generic")],
      ["scout", role("scout")],
    ]),
    scopedModels: [],
    availableModels: [
      { provider: "anthropic", id: "claude-opus-4-8" },
      { provider: "openai", id: "gpt-5.4" },
    ],
  });

  it("uses generic only when role is omitted", () => {
    expect(resolveRoleName(undefined, catalog)).toBe("generic");
    expect(resolveRoleName("scout", catalog)).toBe("scout");
    expect(() => resolveRoleName("missing", catalog)).toThrow(
      'Unknown subagent role "missing". Available roles: generic, scout. Omit role to use generic.',
    );
  });

  it("prefers an exact canonical model identifier", () => {
    expect(resolveModelIdentifier("openai/gpt-5.4", catalog)).toBe("openai/gpt-5.4");
  });

  it("resolves one case-insensitive shorthand match", () => {
    expect(resolveModelIdentifier("OPUS", catalog)).toBe("anthropic/claude-opus-4-8");
  });

  it("reports unknown and ambiguous shorthand", () => {
    expect(() => resolveModelIdentifier("sonnet", catalog)).toThrow(
      'Model "sonnet" is unavailable. Available models: anthropic/claude-opus-4-8, openai/gpt-5.4.',
    );

    const ambiguous = {
      ...catalog,
      models: ["anthropic/claude-opus-4-7", "anthropic/claude-opus-4-8"],
    };
    expect(() => resolveModelIdentifier("opus", ambiguous)).toThrow(
      'Model shorthand "opus" is ambiguous: anthropic/claude-opus-4-7, anthropic/claude-opus-4-8.',
    );
  });
});
