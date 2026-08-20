import type { AgentActivity, UsageTotals } from "./types.js";

const MAX_ACTIVITY = 500;
const MAX_PREVIEW_BYTES = 8 * 1024;
const TRUNCATION_SUFFIX = "\n[truncated]";

export interface PiEventReducerSnapshot {
  activity: AgentActivity[];
  diagnostics: string[];
  usage: UsageTotals;
  finalSummary?: string;
  terminalError?: string;
  reasoningEmitted: boolean;
  reasoningState: string;
}

function boundedPreview(value: string): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= MAX_PREVIEW_BYTES) return value;
  const suffix = Buffer.from(TRUNCATION_SUFFIX, "utf8");
  return `${bytes.subarray(0, MAX_PREVIEW_BYTES - suffix.byteLength).toString("utf8")}${TRUNCATION_SUFFIX}`;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function numeric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function assistantText(message: Record<string, unknown>): string | undefined {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return undefined;
  const parts = message.content
    .map(record)
    .filter((part): part is Record<string, unknown> => part !== undefined)
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string);
  const text = parts.join("\n").trim();
  return text || undefined;
}

export class PiEventReducer {
  private readonly activity: AgentActivity[] = [];
  private readonly diagnostics: string[] = [];
  private readonly usage: UsageTotals = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: 0,
    turns: 0,
  };
  private finalSummary?: string;
  private terminalError?: string;
  private reasoningEmitted = false;

  pushLine(line: string): void {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      this.addDiagnostic(`Malformed Pi JSON event: ${boundedPreview(line)}`);
      return;
    }

    const value = record(event);
    if (!value || typeof value.type !== "string") {
      this.addDiagnostic(`Malformed Pi JSON event: ${boundedPreview(line)}`);
      return;
    }
    this.reduce(value);
  }

  snapshot(): PiEventReducerSnapshot {
    const snapshot: PiEventReducerSnapshot = {
      activity: structuredClone(this.activity),
      diagnostics: [...this.diagnostics],
      usage: { ...this.usage },
      reasoningEmitted: this.reasoningEmitted,
      reasoningState: this.reasoningEmitted
        ? "Provider-emitted reasoning is available."
        : "Reasoning was not emitted by the provider.",
    };
    if (this.finalSummary !== undefined) snapshot.finalSummary = this.finalSummary;
    if (this.terminalError !== undefined) snapshot.terminalError = this.terminalError;
    return snapshot;
  }

  private reduce(event: Record<string, unknown>): void {
    if (event.type === "session") {
      // Pi's session header carries no session-file path; the child reports it
      // through the control socket using ctx.sessionManager.getSessionFile().
      return;
    }

    if (event.type === "message_update") {
      const update = record(event.assistantMessageEvent);
      if (!update || typeof update.delta !== "string") return;
      if (update.type === "thinking_delta") {
        this.reasoningEmitted = true;
        this.addActivity("reasoning", update.delta);
      } else if (update.type === "text_delta") {
        this.addActivity("text", update.delta);
      }
      return;
    }

    if (event.type === "tool_execution_start") {
      const toolName = typeof event.toolName === "string" ? event.toolName : "unknown";
      this.addActivity("tool", JSON.stringify(event.args ?? {}), { toolName });
      return;
    }

    if (event.type === "tool_execution_end") {
      const toolName = typeof event.toolName === "string" ? event.toolName : "unknown";
      this.addActivity("tool", JSON.stringify(event.result ?? {}), {
        toolName,
        isError: event.isError === true,
      });
      return;
    }

    if (event.type !== "message_end") return;
    const message = record(event.message);
    if (!message || message.role !== "assistant") return;

    if (message.stopReason === "error") {
      const errorText =
        typeof message.errorMessage === "string" && message.errorMessage.length > 0
          ? message.errorMessage
          : "Provider reported an error without a message.";
      this.terminalError = boundedPreview(errorText);
      this.addDiagnostic(`Provider error: ${errorText}`);
    }

    const text = assistantText(message);
    if (text) {
      this.finalSummary = text;
      this.addActivity("text", text);
    }

    const usage = record(message.usage);
    if (!usage) return;
    this.usage.input += numeric(usage.input);
    this.usage.output += numeric(usage.output);
    this.usage.cacheRead += numeric(usage.cacheRead);
    this.usage.cacheWrite += numeric(usage.cacheWrite);
    this.usage.totalTokens += numeric(usage.totalTokens);
    this.usage.cost += numeric(record(usage.cost)?.total);
    this.usage.turns += 1;
  }

  private addDiagnostic(text: string): void {
    this.diagnostics.push(text);
    this.addActivity("diagnostic", text);
  }

  private addActivity(
    kind: AgentActivity["kind"],
    text: string,
    optional: { toolName?: string; isError?: boolean } = {},
  ): void {
    const activity: AgentActivity = {
      kind,
      text: boundedPreview(text),
      createdAt: Date.now(),
    };
    if (optional.toolName !== undefined) activity.toolName = optional.toolName;
    if (optional.isError !== undefined) activity.isError = optional.isError;
    this.activity.push(activity);
    if (this.activity.length > MAX_ACTIVITY) {
      this.activity.splice(0, this.activity.length - MAX_ACTIVITY);
    }
  }
}
