import {
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
} from "@earendil-works/pi-tui";
import type { AgentRecord, AgentStatus } from "../types.js";

export interface StatusStripTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

export interface StatusStripCallbacks {
  openAgent(id: string): void;
  focusChanged?(focused: boolean): void;
  invalidated?(): void;
}

const statePresentation: Record<AgentStatus, { symbol: string; label: string; color: string }> = {
  queued: { symbol: "○", label: "queued", color: "muted" },
  starting: { symbol: "◐", label: "starting", color: "warning" },
  running: { symbol: "◐", label: "running", color: "warning" },
  completed: { symbol: "●", label: "completed", color: "success" },
  failed: { symbol: "✕", label: "failed", color: "error" },
  cancelled: { symbol: "–", label: "cancelled", color: "dim" },
};

function isLive(record: AgentRecord): boolean {
  return record.status === "queued" || record.status === "starting" || record.status === "running";
}

export class SubagentStatusStrip implements Component {
  private records: AgentRecord[];
  private selection = 0;
  private focused = false;
  private cached: { width: number; lines: string[] } | undefined;

  constructor(
    records: readonly AgentRecord[],
    private readonly theme: StatusStripTheme,
    private readonly callbacks: StatusStripCallbacks,
  ) {
    this.records = records.filter(isLive).map((record) => structuredClone(record));
  }

  get selectedId(): string | undefined {
    return this.records[this.selection]?.id;
  }

  get isFocused(): boolean {
    return this.focused;
  }

  setRecords(records: readonly AgentRecord[]): void {
    const selectedId = this.selectedId;
    const previousIndex = this.selection;
    this.records = records.filter(isLive).map((record) => structuredClone(record));
    const retainedIndex = selectedId
      ? this.records.findIndex((record) => record.id === selectedId)
      : -1;
    this.selection =
      retainedIndex >= 0
        ? retainedIndex
        : Math.max(0, Math.min(previousIndex, this.records.length - 1));
    this.invalidate();
  }

  setFocused(focused: boolean): void {
    if (this.focused === focused) return;
    this.focused = focused;
    this.callbacks.focusChanged?.(focused);
    this.invalidate();
  }

  selectPrevious(): void {
    if (this.records.length === 0) return;
    this.selection = Math.max(0, this.selection - 1);
    this.invalidate();
  }

  selectNext(): void {
    if (this.records.length === 0) return;
    this.selection = Math.min(this.records.length - 1, this.selection + 1);
    this.invalidate();
  }

  openSelected(): void {
    const id = this.selectedId;
    if (id) this.callbacks.openAgent(id);
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    if (this.cached?.width === safeWidth) return [...this.cached.lines];

    const logicalLines: string[] = [
      this.focused ? this.theme.fg("accent", "Subagents (focused)") : this.theme.fg("muted", "Subagents"),
    ];
    if (this.records.length === 0) {
      logicalLines.push(this.theme.fg("dim", "No live subagents."));
    } else {
      for (const [index, record] of this.records.entries()) {
        const state = statePresentation[record.status];
        const marker = this.focused && index === this.selection ? "› " : "  ";
        logicalLines.push(
          `${marker}${this.theme.fg(state.color, `${state.symbol} ${record.displayName}`)}`,
        );
      }
    }
    if (this.focused) {
      logicalLines.push(
        this.theme.fg(
          "dim",
          "States: ○ queued, ◐ starting or running, ● completed, ✕ failed, – cancelled",
        ),
      );
      logicalLines.push(this.theme.fg("dim", "↑/↓ select, Enter details, Esc editor"));
    }

    const lines = logicalLines.flatMap((line) =>
      wrapTextWithAnsi(line, safeWidth).map((wrapped) => {
        const fitted = visibleWidth(wrapped) > safeWidth
          ? truncateToWidth(wrapped, safeWidth)
          : wrapped;
        return fitted.includes("\u001b[") && !fitted.endsWith("\u001b[0m")
          ? `${fitted}\u001b[0m`
          : fitted;
      }),
    );
    this.cached = { width: safeWidth, lines };
    return [...lines];
  }

  invalidate(): void {
    this.cached = undefined;
    this.callbacks.invalidated?.();
  }
}
