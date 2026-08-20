import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
} from "@earendil-works/pi-tui";
import type { AgentRecord, AgentStatus } from "../types.js";

export interface DashboardTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

export interface DashboardCallbacks {
  root: boolean;
  now(): number;
  requestRender(): void;
  close(): void;
  confirm(scope: "tree" | "all", targetId: string | undefined): Promise<boolean>;
  cancel(scope: "one" | "tree" | "all", targetId: string | undefined): Promise<unknown>;
  subscribe?(listener: (records: AgentRecord[]) => void): () => void;
}

export interface DashboardOptions {
  initialId?: string;
}

const statePresentation: Record<AgentStatus, { symbol: string; color: string }> = {
  queued: { symbol: "○", color: "muted" },
  starting: { symbol: "◐", color: "warning" },
  running: { symbol: "◐", color: "warning" },
  completed: { symbol: "●", color: "success" },
  failed: { symbol: "✕", color: "error" },
  cancelled: { symbol: "–", color: "dim" },
};

function elapsed(record: AgentRecord, now: number): string {
  const start = record.startedAt ?? record.createdAt;
  const end = record.finishedAt ?? now;
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${seconds % 60}s`;
}

function field(value: string | number | undefined): string {
  return value === undefined ? "n/a" : String(value);
}

export class SubagentDashboard implements Component {
  private records: AgentRecord[];
  private selection = 0;
  private mode: "list" | "detail" = "list";
  private readonly unsubscribe: (() => void) | undefined;

  constructor(
    records: readonly AgentRecord[],
    private readonly theme: DashboardTheme,
    private readonly callbacks: DashboardCallbacks,
    options: DashboardOptions = {},
  ) {
    this.records = records.map((record) => structuredClone(record));
    if (options.initialId) {
      const index = this.records.findIndex((record) => record.id === options.initialId);
      if (index >= 0) {
        this.selection = index;
        this.mode = "detail";
      }
    }
    this.unsubscribe = callbacks.subscribe?.((next) => this.setRecords(next));
  }

  get selectedId(): string | undefined {
    return this.records[this.selection]?.id;
  }

  setRecords(records: readonly AgentRecord[]): void {
    const selectedId = this.selectedId;
    const previousIndex = this.selection;
    this.records = records.map((record) => structuredClone(record));
    const retainedIndex = selectedId
      ? this.records.findIndex((record) => record.id === selectedId)
      : -1;
    this.selection = retainedIndex >= 0
      ? retainedIndex
      : Math.max(0, Math.min(previousIndex, this.records.length - 1));
    if (this.records.length === 0) this.mode = "list";
    this.callbacks.requestRender();
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.ctrl("c"))) {
      if (this.callbacks.root) void this.requestCancellation("all", undefined, true);
      return;
    }
    if (matchesKey(data, Key.shift("c"))) {
      const id = this.selectedId;
      if (id) void this.requestCancellation("tree", id, true);
      return;
    }
    if (data === "c") {
      const id = this.selectedId;
      if (id) void this.requestCancellation("one", id, false);
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.selection = Math.max(0, this.selection - 1);
      this.callbacks.requestRender();
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.selection = Math.min(this.records.length - 1, this.selection + 1);
      this.callbacks.requestRender();
      return;
    }
    if (matchesKey(data, Key.enter) && this.selectedId) {
      this.mode = "detail";
      this.callbacks.requestRender();
      return;
    }
    if (matchesKey(data, Key.escape)) {
      if (this.mode === "detail") {
        this.mode = "list";
        this.callbacks.requestRender();
      } else {
        this.callbacks.close();
      }
    }
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const logical = this.mode === "detail" ? this.detailLines() : this.listLines();
    return logical.flatMap((line) =>
      wrapTextWithAnsi(line, safeWidth).map((wrapped) =>
        visibleWidth(wrapped) > safeWidth ? truncateToWidth(wrapped, safeWidth) : wrapped,
      ),
    );
  }

  invalidate(): void {
    this.callbacks.requestRender();
  }

  dispose(): void {
    this.unsubscribe?.();
  }

  private listLines(): string[] {
    const lines = [this.theme.bold("Subagents")];
    if (this.records.length === 0) {
      lines.push(this.theme.fg("dim", "No retained subagents."));
    }
    for (const [index, record] of this.records.entries()) {
      const state = statePresentation[record.status];
      const marker = index === this.selection ? "› " : "  ";
      const indent = "  ".repeat(Math.max(0, record.depth - 1));
      const updateCount = record.updates.length > 0 ? ` updates=${record.updates.length}` : "";
      lines.push(
        `${marker}${indent}${this.theme.fg(state.color, `${state.symbol} ${record.displayName} [${record.status}]`)} ${elapsed(record, this.callbacks.now())} model=${field(record.effectiveModel)} effort=${field(record.effectiveEffort)} permission=${record.permission} depth=${record.depth}${updateCount}`,
      );
    }
    lines.push(this.theme.fg("dim", "↑/↓ select, Enter details, c cancel, Shift+C tree, Ctrl+C all, Esc close"));
    return lines;
  }

  private detailLines(): string[] {
    const record = this.records[this.selection];
    if (!record) return [this.theme.bold("Subagent detail"), "Agent is no longer retained."];
    const state = statePresentation[record.status];
    const reasoning = record.activity.filter((entry) => entry.kind === "reasoning");
    const tools = record.activity.filter((entry) => entry.kind === "tool");
    const otherActivity = record.activity.filter(
      (entry) => entry.kind !== "reasoning" && entry.kind !== "tool",
    );
    const lines = [
      this.theme.bold(`Subagent: ${record.displayName}`),
      this.theme.fg(state.color, `${state.symbol} ${record.status}`),
      `Role: ${record.role}`,
      `Assignment: ${record.task}`,
    ];
    if (record.contextSummary) lines.push(`Context summary: ${record.contextSummary}`);
    lines.push(
      `Execution: model=${field(record.effectiveModel)} effort=${field(record.effectiveEffort)} permission=${record.permission} depth=${record.depth}`,
      `Elapsed: ${elapsed(record, this.callbacks.now())}`,
      this.theme.bold("Reasoning"),
    );
    if (reasoning.length === 0) {
      lines.push("Reasoning was not emitted by the provider.");
    } else {
      lines.push(...reasoning.map((entry) => `• ${entry.text}`));
    }
    lines.push(this.theme.bold("Tool activity"));
    lines.push(...(tools.length > 0
      ? tools.map((entry) => `• ${entry.toolName ? `${entry.toolName}: ` : ""}${entry.text}`)
      : ["No tool activity was retained."]));
    if (otherActivity.length > 0) {
      lines.push(this.theme.bold("Other activity"));
      lines.push(...otherActivity.map((entry) => `• ${entry.text}`));
    }
    lines.push(this.theme.bold("Updates"));
    lines.push(...(record.updates.length > 0
      ? record.updates.map((entry) => `• ${entry.text}${entry.promote ? " [promoted]" : ""}`)
      : ["No updates were recorded."]));
    lines.push(
      this.theme.bold("Usage"),
      `input=${record.usage.input} output=${record.usage.output} cacheRead=${record.usage.cacheRead} cacheWrite=${record.usage.cacheWrite} total=${record.usage.totalTokens} cost=${record.usage.cost} turns=${record.usage.turns}`,
    );
    if (record.finalSummary) lines.push(this.theme.bold("Final summary"), record.finalSummary);
    if (record.statusReason) lines.push(this.theme.bold("Failure or status detail"), record.statusReason);
    lines.push(`PID: ${field(record.pid)}`, `Session: ${field(record.sessionFile)}`);
    lines.push(this.theme.fg("dim", "Esc back, c cancel, Shift+C tree, Ctrl+C all"));
    return lines;
  }

  private async requestCancellation(
    scope: "one" | "tree" | "all",
    targetId: string | undefined,
    confirmationRequired: boolean,
  ): Promise<void> {
    if (confirmationRequired) {
      const confirmed = await this.callbacks.confirm(scope as "tree" | "all", targetId);
      if (!confirmed) return;
    }
    await this.callbacks.cancel(scope, targetId);
    this.callbacks.requestRender();
  }
}
