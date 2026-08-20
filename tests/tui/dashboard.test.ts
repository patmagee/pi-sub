import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { SubagentDashboard } from "../../src/tui/dashboard.js";
import type { AgentRecord } from "../../src/types.js";

const usage = { input: 12, output: 8, cacheRead: 2, cacheWrite: 1, totalTokens: 23, cost: 0.04, turns: 2 };

function record(overrides: Partial<AgentRecord> & Pick<AgentRecord, "id" | "displayName">): AgentRecord {
  const { id, displayName, ...rest } = overrides;
  return {
    id,
    requestedName: displayName,
    displayName,
    role: "scout",
    task: `Assignment for ${overrides.displayName}`,
    depth: 1,
    permission: "read-only",
    cwd: "/workspace",
    status: "running",
    createdAt: 1_000,
    startedAt: 2_000,
    updates: [],
    activity: [],
    usage,
    ...rest,
  };
}

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

function callbacks(root = true) {
  return {
    root,
    now: () => 7_000,
    requestRender: vi.fn(),
    close: vi.fn(),
    confirm: vi.fn(async () => true),
    cancel: vi.fn(async () => ({ cancelled: [], errors: [] })),
  };
}

describe("dashboard hierarchy", () => {
  it("renders nested status, elapsed time, execution policy, depth, and updates", () => {
    const parent = record({
      id: "parent",
      displayName: "parent",
      effectiveModel: "anthropic/sonnet",
      effectiveEffort: "high",
      permission: "inherit",
    });
    const child = record({
      id: "child",
      displayName: "child",
      parentId: parent.id,
      depth: 2,
      status: "queued",
      updates: [{ text: "found route", promote: false, createdAt: 3_000 }],
    });
    const dashboard = new SubagentDashboard([parent, child], theme, callbacks());
    const lines = dashboard.render(120).map(stripTerminalSequences);
    const text = lines.join("\n");

    expect(text).toContain("parent [running]");
    expect(text).toContain("5s");
    expect(text).toContain("model=anthropic/sonnet");
    expect(text).toContain("effort=high");
    expect(text).toContain("permission=inherit");
    expect(text).toContain("depth=1");
    expect(text).toMatch(/\n\s{2,}○ child \[queued\]/u);
    expect(text).toContain("updates=1");
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(120);
  });

  it("removes pruned agents from the list without moving a surviving selection", () => {
    let listener: ((records: AgentRecord[]) => void) | undefined;
    const actions = callbacks();
    const dashboard = new SubagentDashboard(
      [
        record({ id: "alpha", displayName: "alpha", status: "completed" }),
        record({ id: "beta", displayName: "beta" }),
        record({ id: "gamma", displayName: "gamma", status: "completed" }),
      ],
      theme,
      {
        ...actions,
        subscribe: (next) => {
          listener = next;
          return vi.fn();
        },
      },
    );
    dashboard.handleInput("\u001b[B");
    expect(dashboard.selectedId).toBe("beta");

    listener?.([record({ id: "beta", displayName: "beta" })]);

    expect(dashboard.selectedId).toBe("beta");
    const text = dashboard.render(120).map(stripTerminalSequences).join("\n");
    expect(text).toContain("beta [running]");
    expect(text).not.toContain("alpha");
    expect(text).not.toContain("gamma");
  });

  it("keeps list selection stable and requests a rerender when subscribed records change", () => {
    let listener: ((records: AgentRecord[]) => void) | undefined;
    const actions = callbacks();
    const dashboard = new SubagentDashboard(
      [record({ id: "one", displayName: "one" }), record({ id: "two", displayName: "two" })],
      theme,
      {
        ...actions,
        subscribe: (next) => {
          listener = next;
          return vi.fn();
        },
      },
    );
    dashboard.handleInput("\u001b[B");
    expect(dashboard.selectedId).toBe("two");

    listener?.([
      record({ id: "zero", displayName: "zero" }),
      record({ id: "two", displayName: "two", status: "completed" }),
    ]);
    expect(dashboard.selectedId).toBe("two");
    expect(actions.requestRender).toHaveBeenCalled();
  });
});

describe("dashboard detail", () => {
  it("renders assignment, context, reasoning, tools, updates, usage, outcome, process, and session", () => {
    const agent = record({
      id: "agent",
      displayName: "agent",
      task: "Audit the token flow",
      contextSummary: "Tokens enter through the gateway.",
      status: "failed",
      statusReason: "provider disconnected",
      pid: 4242,
      sessionFile: "/sessions/agent.jsonl",
      finalSummary: "The refresh path is unsafe.",
      activity: [
        { kind: "reasoning", text: "Trace all callers", createdAt: 2_100 },
        { kind: "tool", toolName: "read", text: "src/auth.ts", createdAt: 2_200 },
      ],
      updates: [{ text: "Found refresh race", promote: true, createdAt: 2_300 }],
    });
    const dashboard = new SubagentDashboard([agent], theme, callbacks(), { initialId: agent.id });
    const text = dashboard.render(100).map(stripTerminalSequences).join("\n");

    for (const expected of [
      "Audit the token flow",
      "Tokens enter through the gateway.",
      "Trace all callers",
      "read: src/auth.ts",
      "Found refresh race",
      "input=12",
      "The refresh path is unsafe.",
      "provider disconnected",
      "4242",
      "/sessions/agent.jsonl",
    ]) expect(text).toContain(expected);
  });

  it("states when provider reasoning was not emitted", () => {
    const agent = record({ id: "agent", displayName: "agent", activity: [] });
    const dashboard = new SubagentDashboard([agent], theme, callbacks(), { initialId: agent.id });

    expect(dashboard.render(100).join("\n")).toContain("Reasoning was not emitted by the provider.");
  });
});

describe("dashboard cancellation", () => {
  it("maps c to one agent and confirms subtree cancellation for Shift+C", async () => {
    const actions = callbacks();
    const agent = record({ id: "agent", displayName: "agent" });
    const dashboard = new SubagentDashboard([agent], theme, actions);

    dashboard.handleInput("c");
    await vi.waitFor(() => expect(actions.cancel).toHaveBeenCalledWith("one", agent.id));
    dashboard.handleInput("C");
    await vi.waitFor(() => expect(actions.confirm).toHaveBeenCalledWith("tree", agent.id));
    expect(actions.cancel).toHaveBeenCalledWith("tree", agent.id);
  });

  it("allows confirmed global cancellation only from the root", async () => {
    const rootActions = callbacks(true);
    const rootDashboard = new SubagentDashboard(
      [record({ id: "agent", displayName: "agent" })],
      theme,
      rootActions,
    );
    rootDashboard.handleInput("\u0003");
    await vi.waitFor(() => expect(rootActions.confirm).toHaveBeenCalledWith("all", undefined));
    expect(rootActions.cancel).toHaveBeenCalledWith("all", undefined);

    const childActions = callbacks(false);
    const childDashboard = new SubagentDashboard(
      [record({ id: "agent", displayName: "agent" })],
      theme,
      childActions,
    );
    childDashboard.handleInput("\u0003");
    await Promise.resolve();
    expect(childActions.confirm).not.toHaveBeenCalled();
    expect(childActions.cancel).not.toHaveBeenCalled();
  });
});
