import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import type { InspectResult, StartReceipt } from "../src/protocol.js";
import {
  registerSubagentTools,
  SubagentCancelSchema,
  SubagentInspectSchema,
  SubagentStartSchema,
  type SubagentToolController,
} from "../src/tools.js";

function fakePi() {
  const tools = new Map<string, any>();
  return {
    tools,
    registerTool(definition: any) {
      tools.set(definition.name, definition);
    },
  };
}

function controller(): SubagentToolController {
  return {
    start: vi.fn(async (): Promise<StartReceipt> => ({
      id: "agent-1",
      displayName: "scout",
      status: "starting",
      depth: 1,
    })),
    update: vi.fn(async () => ({ recorded: true, promoted: false })),
    inspect: vi.fn(async (): Promise<InspectResult> => ({
      view: "metadata",
      targetId: "agent-1",
      content: { status: "running", effectiveModel: "anthropic/haiku", permission: "read-only" },
    })),
    cancel: vi.fn(async () => ({ cancelled: ["agent-1"], errors: [] })),
  };
}

describe("subagent tool schemas", () => {
  it("requires name, role, and task while accepting optional dispatch controls", () => {
    expect(Value.Check(SubagentStartSchema, { name: "scan", role: "scout", task: "find auth" })).toBe(true);
    expect(Value.Check(SubagentStartSchema, { name: "scan", role: "scout" })).toBe(false);
    expect(
      Value.Check(SubagentStartSchema, {
        name: "scan",
        role: "scout",
        task: "find auth",
        permission: "inherit",
        contextSummary: "Auth is under src.",
        model: "openai/gpt-5.4",
        effort: "high",
        cwd: "/workspace",
      }),
    ).toBe(true);
  });

  it("uses bounded inspect views and cancellation scopes", () => {
    expect(
      Value.Check(SubagentInspectSchema, {
        targetId: "agent-1",
        view: "session",
        offset: 0,
        limit: 50 * 1024,
      }),
    ).toBe(true);
    expect(
      Value.Check(SubagentInspectSchema, {
        targetId: "agent-1",
        view: "session",
        limit: 50 * 1024 + 1,
      }),
    ).toBe(false);
    expect(Value.Check(SubagentCancelSchema, { scope: "all" })).toBe(true);
    expect(Value.Check(SubagentCancelSchema, { targetId: "agent-1", scope: "tree" })).toBe(true);
  });
});

describe("registered subagent tools", () => {
  it("registers four named tools with prompt snippets and compact structured results", async () => {
    const pi = fakePi();
    const toolController = controller();
    registerSubagentTools(pi as never, toolController);

    expect([...pi.tools.keys()]).toEqual([
      "subagent_start",
      "subagent_update",
      "subagent_inspect",
      "subagent_cancel",
    ]);
    for (const [name, tool] of pi.tools) expect(tool.promptSnippet).toContain(name);

    const start = pi.tools.get("subagent_start");
    const result = await start.execute(
      "call-1",
      { name: "scan", role: "scout", task: "find auth" },
      undefined,
      undefined,
      {},
    );
    expect(result.content[0].text).toContain("scout [starting]");
    expect(result.content[0].text).toContain("agent-1");
    expect(result.details).toMatchObject({ id: "agent-1", depth: 1 });
  });

  it("throws controller errors so Pi marks tool execution as failed", async () => {
    const pi = fakePi();
    const toolController = controller();
    vi.mocked(toolController.inspect).mockRejectedValue(new Error("not allowed"));
    registerSubagentTools(pi as never, toolController);

    await expect(
      pi.tools.get("subagent_inspect").execute(
        "call-1",
        { targetId: "agent-1", view: "metadata" },
        undefined,
        undefined,
        {},
      ),
    ).rejects.toThrow("not allowed");
  });
});
