import { describe, expect, it, vi } from "vitest";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { SubagentStatusStrip } from "../../src/tui/status-strip.js";
import type { AgentRecord, AgentStatus } from "../../src/types.js";

const colors: Record<string, string> = {
  muted: "\u001b[90m",
  warning: "\u001b[33m",
  success: "\u001b[32m",
  error: "\u001b[31m",
  dim: "\u001b[2m",
  accent: "\u001b[36m",
};
const theme = {
  fg(color: string, text: string) {
    return `${colors[color] ?? ""}${text}\u001b[0m`;
  },
  bold(text: string) {
    return `\u001b[1m${text}\u001b[22m`;
  },
};

function record(id: string, status: AgentStatus, parentId?: string): AgentRecord {
  return {
    id,
    requestedName: id,
    displayName: id,
    ...(parentId ? { parentId } : {}),
    role: "scout",
    task: `Task for ${id}`,
    depth: parentId ? 2 : 1,
    permission: "read-only",
    cwd: "/workspace",
    status,
    createdAt: 1,
    ...(status === "queued" ? {} : { startedAt: 2 }),
    updates: [],
    activity: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, turns: 0 },
  };
}

describe("SubagentStatusStrip", () => {
  it("renders only live agents and hides terminal ones", () => {
    const live = [
      record("queued-agent", "queued"),
      record("starting-agent", "starting"),
      record("running-agent", "running"),
    ];
    const terminal = [
      record("completed-agent", "completed"),
      record("failed-agent", "failed"),
      record("cancelled-agent", "cancelled"),
    ];
    const strip = new SubagentStatusStrip([...live, ...terminal], theme, { openAgent: vi.fn() });
    strip.setFocused(true);
    const text = strip.render(120).map(stripTerminalSequences).join("\n");

    for (const entry of live) expect(text).toContain(entry.displayName);
    for (const entry of terminal) expect(text).not.toContain(entry.displayName);
    for (const label of ["queued", "starting", "running"]) expect(text).toContain(label);
    expect(text).toMatch(/[○◐]/u);
  });

  it("shows the empty live-state message when every retained agent is terminal", () => {
    const strip = new SubagentStatusStrip(
      [record("completed-agent", "completed"), record("failed-agent", "failed")],
      theme,
      { openAgent: vi.fn() },
    );
    const text = strip.render(120).map(stripTerminalSequences).join("\n");
    expect(text).toContain("No live subagents.");
    expect(text).not.toContain("completed-agent");
  });

  it("wraps narrow ANSI-colored output without exceeding width or leaving open escapes", () => {
    const strip = new SubagentStatusStrip(
      [record("a-very-long-running-agent-name", "running"), record("another-agent", "starting")],
      theme,
      { openAgent: vi.fn() },
    );
    strip.setFocused(true);
    const lines = strip.render(12);

    expect(lines.length).toBeGreaterThan(2);
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(12);
      expect(line.includes("\u001b["), JSON.stringify(line)).toBe(
        line.includes("\u001b[0m") || line.includes("\u001b[22m"),
      );
    }
  });

  it("keeps selection by identifier across live updates and opens the selected agent", () => {
    const openAgent = vi.fn();
    const strip = new SubagentStatusStrip(
      [record("one", "running"), record("two", "queued"), record("three", "starting")],
      theme,
      { openAgent },
    );
    strip.selectNext();
    expect(strip.selectedId).toBe("two");

    strip.setRecords([record("zero", "queued"), record("two", "running"), record("three", "starting")]);
    expect(strip.selectedId).toBe("two");
    strip.openSelected();
    expect(openAgent).toHaveBeenCalledWith("two");
  });

  it("drops an agent the moment it becomes terminal and moves selection to the nearest live agent", () => {
    const strip = new SubagentStatusStrip(
      [record("one", "running"), record("two", "running"), record("three", "running")],
      theme,
      { openAgent: vi.fn() },
    );
    strip.setFocused(true);
    strip.selectNext();
    expect(strip.selectedId).toBe("two");

    strip.setRecords([record("one", "running"), record("two", "completed"), record("three", "running")]);

    const text = strip.render(120).map(stripTerminalSequences).join("\n");
    expect(text).not.toContain("two");
    expect(strip.selectedId).toBe("three");
  });
});
