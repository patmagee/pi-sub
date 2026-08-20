import { describe, expect, it } from "vitest";
import { buildChildPrompt } from "../src/prompt.js";

describe("buildChildPrompt", () => {
  it("includes only the explicit child assignment and orchestration metadata", () => {
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
    expect(prompt).toContain("Search quickly.");
    expect(prompt).toContain("auth-scout");
    expect(prompt).toContain("orchestrator");
    expect(prompt).toContain("Depth: 1 of 3");
    expect(prompt).toContain("Permission: read-only");
    expect(prompt).toContain("subagent_update");
    expect(prompt).toContain("Promotion is explicit");
    expect(prompt).toContain("## Findings");
    expect(prompt).toContain("## Evidence");
    expect(prompt).toContain("## Open questions");
    expect(prompt).toContain("## Recommended next action");
    expect(prompt).not.toContain("PARENT_TRANSCRIPT_SENTINEL");
    expect(prompt).not.toContain("Context summary");
  });

  it("includes an explicitly supplied context summary without adding other parent content", () => {
    const prompt = buildChildPrompt({
      name: "auth-review",
      parentName: "orchestrator",
      depth: 2,
      maxDepth: 3,
      permission: "inherit",
      task: "Review token validation.",
      rolePrompt: "Review contracts.",
      contextSummary: "The token parser is in src/auth.ts.",
    });

    expect(prompt).toContain("## Context summary");
    expect(prompt).toContain("The token parser is in src/auth.ts.");
  });

  it("states that delegation is unavailable at the maximum depth", () => {
    const prompt = buildChildPrompt({
      name: "leaf",
      parentName: "child",
      depth: 3,
      maxDepth: 3,
      permission: "read-only",
      task: "Inspect one file.",
      rolePrompt: "Inspect carefully.",
    });

    expect(prompt).toContain("Delegation is unavailable at this depth.");
  });
});
