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
  it("renders every retained agent with a state symbol and expanded accessible labels", () => {
    const records = [
      record("queued-agent", "queued"),
      record("running-agent", "running"),
      record("completed-agent", "completed"),
      record("failed-agent", "failed"),
      record("cancelled-agent", "cancelled"),
    ];
    const strip = new SubagentStatusStrip(records, theme, { openAgent: vi.fn() });
    strip.setFocused(true);
    const text = strip.render(120).map(stripTerminalSequences).join("\n");

    for (const entry of records) expect(text).toContain(entry.displayName);
    for (const label of ["queued", "running", "completed", "failed", "cancelled"]) expect(text).toContain(label);
    expect(text).toMatch(/[○◐●✕–]/u);
  });

  it("wraps narrow ANSI-colored output without exceeding width or leaving open escapes", () => {
    const strip = new SubagentStatusStrip(
      [record("a-very-long-running-agent-name", "running"), record("another-agent", "failed")],
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

  it("keeps selection by identifier across updates and opens the selected agent", () => {
    const openAgent = vi.fn();
    const strip = new SubagentStatusStrip(
      [record("one", "running"), record("two", "queued"), record("three", "completed")],
      theme,
      { openAgent },
    );
    strip.selectNext();
    expect(strip.selectedId).toBe("two");

    strip.setRecords([record("zero", "queued"), record("two", "running"), record("three", "completed")]);
    expect(strip.selectedId).toBe("two");
    strip.openSelected();
    expect(openAgent).toHaveBeenCalledWith("two");

    strip.setRecords([record("zero", "queued"), record("three", "completed")]);
    expect(strip.selectedId).toBe("three");
    strip.selectPrevious();
    expect(strip.selectedId).toBe("zero");
  });
});
