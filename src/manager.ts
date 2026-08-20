import { readFile } from "node:fs/promises";
import { buildChildPrompt } from "./prompt.js";
import { READ_ONLY_TOOLS } from "./pi-command.js";
import type {
  InspectResult,
  InspectView,
  StartInput,
  StartReceipt,
} from "./protocol.js";
import {
  AgentRegistry,
  type AgentRecordPatch,
} from "./registry.js";
import type {
  ProcessHandle,
  ProcessResult,
  ProcessRunnerCallbacks,
  ProcessRunnerInput,
} from "./process-runner.js";
import type { RoleDefinition } from "./roles.js";
import type {
  AgentRecord,
  PermissionMode,
  SubagentConfig,
  ThinkingLevel,
} from "./types.js";

const MAX_PROMOTED_BYTES = 8 * 1024;
const MAX_COMPLETION_BYTES = 16 * 1024;
const MAX_INSPECTION_BYTES = 50 * 1024;
const MANAGEMENT_TOOLS = [
  "subagent_start",
  "subagent_update",
  "subagent_inspect",
  "subagent_cancel",
] as const;

export interface ParentContext {
  agentId?: string;
  name: string;
  model?: string;
  effort?: ThinkingLevel;
  permission: PermissionMode;
  cwd: string;
  activeTools: readonly string[];
}

export interface ParentDelivery {
  childId: string;
  kind: "update" | "complete" | "failed" | "cancelled";
  text: string;
  sessionFile?: string;
}

export interface ManagerOptions {
  config: SubagentConfig;
  roles: ReadonlyMap<string, RoleDefinition>;
  processRunner: {
    start(input: ProcessRunnerInput, callbacks: ProcessRunnerCallbacks): ProcessHandle;
  };
  modelAvailable: (model: string) => boolean;
  prepareProcess: (
    record: AgentRecord,
    prompt: string,
    parentContext: ParentContext,
  ) => Promise<ProcessRunnerInput>;
  deliverToParent: (parentId: string | undefined, message: ParentDelivery) => void;
  controlServer?: { close(): Promise<void> };
}

export interface InspectQuery {
  requesterId?: string;
  targetId: string;
  view: InspectView;
  offset?: number;
  limit?: number;
}

export interface RecordUpdateInput {
  agentId: string;
  text: string;
  promote: boolean;
}

export interface CancelInput {
  requesterId?: string;
  targetId?: string;
  scope: "one" | "tree" | "all";
}

export interface CancelResult {
  cancelled: string[];
  errors: Array<{ id: string; error: string }>;
}

interface PendingLaunch {
  parentContext: ParentContext;
  prompt: string;
}

function bounded(value: string, maximumBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maximumBytes) return value;
  const suffix = Buffer.from("\n[truncated]", "utf8");
  return `${bytes.subarray(0, maximumBytes - suffix.byteLength).toString("utf8")}\n[truncated]`;
}

function terminal(record: AgentRecord): boolean {
  return record.status === "completed" || record.status === "failed" || record.status === "cancelled";
}

export class SubagentManager {
  private readonly registry: AgentRegistry;
  private readonly handles = new Map<string, ProcessHandle>();
  private readonly pending = new Map<string, PendingLaunch>();
  private readonly contexts = new Map<string, ParentContext>();
  private readonly subscribers = new Set<(records: AgentRecord[]) => void>();
  private readonly deliveredTerminal = new Set<string>();
  private shuttingDown = false;
  private shutdownPromise?: Promise<void>;
  private scheduling = false;

  constructor(private readonly options: ManagerOptions) {
    this.registry = new AgentRegistry(options.config);
  }

  async start(input: StartInput, parentContext: ParentContext): Promise<StartReceipt> {
    if (this.shuttingDown) throw new Error("Subagent manager is shutting down.");

    const role = this.options.roles.get(input.role);
    const permission = input.permission ?? role?.defaultPermission ?? "read-only";
    const effectiveModel = input.model ?? role?.defaultModel ?? parentContext.model;
    const effectiveEffort = input.effort ?? role?.defaultEffort ?? parentContext.effort;
    const record = this.registry.admit({
      name: input.name,
      ...(parentContext.agentId ? { parentId: parentContext.agentId } : {}),
      role: input.role,
      task: input.task,
      ...(input.contextSummary !== undefined ? { contextSummary: input.contextSummary } : {}),
      permission,
      ...(input.model !== undefined ? { requestedModel: input.model } : {}),
      ...(input.effort !== undefined ? { requestedEffort: input.effort } : {}),
      cwd: input.cwd ?? parentContext.cwd,
    });

    const resolution: AgentRecordPatch = {};
    if (effectiveModel !== undefined) resolution.effectiveModel = effectiveModel;
    if (effectiveEffort !== undefined) resolution.effectiveEffort = effectiveEffort;
    this.registry.patch(record.id, resolution);
    this.contexts.set(record.id, this.childContext(record.id, parentContext));

    if (!role) {
      return this.failAdmission(record.id, `Unknown subagent role "${input.role}".`);
    }
    if (effectiveModel && !this.options.modelAvailable(effectiveModel)) {
      return this.failAdmission(record.id, `Requested model "${effectiveModel}" is unavailable.`);
    }

    const prompt = buildChildPrompt({
      name: record.displayName,
      parentName: parentContext.name,
      depth: record.depth,
      maxDepth: this.options.config.maxDepth,
      permission,
      task: input.task,
      rolePrompt: role.systemPrompt,
      ...(input.contextSummary !== undefined ? { contextSummary: input.contextSummary } : {}),
    });
    this.pending.set(record.id, { parentContext: { ...parentContext }, prompt });
    this.notify();

    if (record.status === "queued") {
      return { id: record.id, displayName: record.displayName, status: "queued", depth: record.depth };
    }

    const launchError = await this.launchRecord(record.id);
    if (launchError) {
      const failed = this.registry.get(record.id)!;
      return {
        id: failed.id,
        displayName: failed.displayName,
        status: "failed",
        depth: failed.depth,
        error: launchError,
      };
    }
    return { id: record.id, displayName: record.displayName, status: "starting", depth: record.depth };
  }

  contextFor(agentId: string): ParentContext {
    const context = this.contexts.get(agentId);
    if (!context) throw new Error(`Unknown agent context: ${agentId}.`);
    return { ...context, activeTools: [...context.activeTools] };
  }

  async inspect(query: InspectQuery): Promise<InspectResult> {
    this.authorizeDescendant(query.requesterId, query.targetId, "inspect");
    const record = this.registry.get(query.targetId);
    if (!record) throw new Error(`Unknown agent: ${query.targetId}.`);

    if (query.view === "metadata") {
      return { view: query.view, targetId: query.targetId, content: record };
    }
    if (query.view === "updates") {
      return { view: query.view, targetId: query.targetId, content: record.updates };
    }
    if (query.view === "summary") {
      return {
        view: query.view,
        targetId: query.targetId,
        content: {
          status: record.status,
          statusReason: record.statusReason,
          finalSummary: record.finalSummary,
          usage: record.usage,
          sessionFile: record.sessionFile,
        },
      };
    }

    if (!record.sessionFile) throw new Error("Agent session file is not available.");
    const source = await readFile(record.sessionFile);
    const offset = query.offset ?? 0;
    const limit = Math.min(query.limit ?? 8 * 1024, MAX_INSPECTION_BYTES);
    const content = source.subarray(offset, offset + limit);
    const nextOffset = offset + content.byteLength;
    return {
      view: query.view,
      targetId: query.targetId,
      content: content.toString("utf8"),
      offset,
      ...(nextOffset < source.byteLength ? { nextOffset, truncated: true } : { truncated: false }),
    };
  }

  recordUpdate(input: RecordUpdateInput): void {
    const record = this.registry.get(input.agentId);
    if (!record) throw new Error(`Unknown agent: ${input.agentId}.`);
    if (terminal(record)) throw new Error(`Agent is no longer live: ${record.displayName}.`);

    const text = bounded(input.text, MAX_PROMOTED_BYTES);
    this.registry.appendUpdate(input.agentId, { text, promote: input.promote, createdAt: Date.now() });
    this.notify();
    if (input.promote) {
      this.options.deliverToParent(record.parentId, {
        childId: record.id,
        kind: "update",
        text,
      });
    }
  }

  async cancel(input: CancelInput): Promise<CancelResult> {
    if (input.scope === "all") {
      if (input.requesterId) throw new Error("Only the root orchestrator can cancel all agents.");
      const targets = this.registry
        .list()
        .filter((record) => !terminal(record))
        .sort((left, right) => right.depth - left.depth);
      return this.cancelRecords(targets, "cancelled by root");
    }

    if (!input.targetId) throw new Error("Cancellation target is required.");
    this.authorizeDescendant(input.requesterId, input.targetId, "cancel");
    const target = this.registry.get(input.targetId);
    if (!target) throw new Error(`Unknown agent: ${input.targetId}.`);
    const targets =
      input.scope === "tree"
        ? [...this.registry.descendantsOf(target.id)].reverse().concat(target)
        : [target];
    return this.cancelRecords(targets.filter((record) => !terminal(record)), "cancelled by request");
  }

  shutdown(reason: string): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shuttingDown = true;
    this.shutdownPromise = (async () => {
      const targets = this.registry
        .list()
        .filter((record) => !terminal(record))
        .sort((left, right) => right.depth - left.depth);
      const cancellations = targets.map((record) => this.issueCancellation(record.id, reason));
      const close = this.options.controlServer?.close() ?? Promise.resolve();
      await Promise.allSettled(cancellations);
      await close;
    })();
    return this.shutdownPromise;
  }

  subscribe(listener: (records: AgentRecord[]) => void): () => void {
    this.subscribers.add(listener);
    listener(this.registry.list());
    return () => this.subscribers.delete(listener);
  }

  private childContext(recordId: string, parent: ParentContext): ParentContext {
    const record = this.registry.get(recordId)!;
    const tools =
      record.permission === "read-only"
        ? [...READ_ONLY_TOOLS]
        : [...new Set([...parent.activeTools, ...MANAGEMENT_TOOLS])];
    const context: ParentContext = {
      agentId: record.id,
      name: record.displayName,
      permission: record.permission,
      cwd: record.cwd,
      activeTools: tools,
    };
    if (record.effectiveModel !== undefined) context.model = record.effectiveModel;
    if (record.effectiveEffort !== undefined) context.effort = record.effectiveEffort;
    return context;
  }

  private failAdmission(id: string, error: string): StartReceipt {
    let record = this.registry.get(id)!;
    if (record.status === "queued") record = this.registry.transition(id, "starting");
    record = this.registry.transition(id, "failed", error);
    this.pending.delete(id);
    this.notify();
    return {
      id: record.id,
      displayName: record.displayName,
      status: "failed",
      depth: record.depth,
      error,
    };
  }

  private async launchRecord(id: string): Promise<string | undefined> {
    const launch = this.pending.get(id);
    const record = this.registry.get(id);
    if (!launch || !record) return "Agent launch state is unavailable.";

    try {
      const processInput = await this.options.prepareProcess(record, launch.prompt, launch.parentContext);
      const handle = this.options.processRunner.start(processInput, {
        onStart: (pid) => {
          const current = this.registry.get(id);
          if (!current || terminal(current)) return;
          this.registry.patch(id, { pid });
          if (current.status === "starting") this.registry.transition(id, "running");
          this.notify();
        },
        onUpdate: (snapshot) => {
          const current = this.registry.get(id);
          if (!current || terminal(current)) return;
          const patch: AgentRecordPatch = {
            activity: snapshot.activity,
            usage: snapshot.usage,
          };
          if (snapshot.sessionFile !== undefined) patch.sessionFile = snapshot.sessionFile;
          if (snapshot.finalSummary !== undefined) patch.finalSummary = snapshot.finalSummary;
          this.registry.patch(id, patch);
          this.notify();
        },
        onComplete: (result) => {
          void this.completeRecord(id, result);
        },
      });
      this.handles.set(id, handle);
      this.pending.delete(id);
      return undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.failAdmission(id, message);
      void this.scheduleNext();
      return message;
    }
  }

  private async completeRecord(id: string, result: ProcessResult): Promise<void> {
    this.handles.delete(id);
    const existing = this.registry.get(id);
    if (!existing) return;

    const patch: AgentRecordPatch = {
      activity: result.snapshot.activity,
      usage: result.snapshot.usage,
    };
    if (result.snapshot.sessionFile !== undefined) patch.sessionFile = result.snapshot.sessionFile;
    if (result.snapshot.finalSummary !== undefined) patch.finalSummary = result.snapshot.finalSummary;
    this.registry.patch(id, patch);

    let record = this.registry.get(id)!;
    if (!terminal(record)) {
      if (result.status === "completed") {
        if (record.status === "starting") this.registry.transition(id, "running");
        record = this.registry.transition(id, "completed");
      } else if (result.status === "cancelled") {
        record = this.registry.transition(id, "cancelled", result.forced ? "force-killed" : "cancelled");
      } else {
        record = this.registry.transition(id, "failed", result.stderr || "Child process failed.");
      }
    } else {
      record = this.registry.get(id)!;
    }

    this.deliverTerminal(record);
    this.notify();
    if (!this.shuttingDown) await this.scheduleNext();
  }

  private deliverTerminal(record: AgentRecord): void {
    if (this.deliveredTerminal.has(record.id)) return;
    this.deliveredTerminal.add(record.id);
    const kind: ParentDelivery["kind"] =
      record.status === "completed"
        ? "complete"
        : record.status === "cancelled"
          ? "cancelled"
          : "failed";
    const text = bounded(
      record.finalSummary ?? record.statusReason ?? `Agent ${record.displayName} ${record.status}.`,
      MAX_COMPLETION_BYTES,
    );
    this.options.deliverToParent(record.parentId, {
      childId: record.id,
      kind,
      text,
      ...(record.sessionFile ? { sessionFile: record.sessionFile } : {}),
    });
  }

  private async scheduleNext(): Promise<void> {
    if (this.scheduling || this.shuttingDown) return;
    this.scheduling = true;
    try {
      while (this.registry.runningCount < this.options.config.maxConcurrency) {
        const next = this.registry.list().find((record) => record.status === "queued");
        if (!next) return;
        this.registry.transition(next.id, "starting");
        this.notify();
        await this.launchRecord(next.id);
      }
    } finally {
      this.scheduling = false;
    }
  }

  private authorizeDescendant(
    requesterId: string | undefined,
    targetId: string,
    operation: "inspect" | "cancel",
  ): void {
    if (!requesterId) return;
    const allowed = new Set(this.registry.descendantsOf(requesterId).map((record) => record.id));
    if (!allowed.has(targetId)) {
      throw new Error(`Agent cannot ${operation} outside its descendant tree.`);
    }
  }

  private async cancelRecords(records: AgentRecord[], reason: string): Promise<CancelResult> {
    const operations = records.map((record) => this.issueCancellation(record.id, reason));
    const settled = await Promise.allSettled(operations);
    const cancelled: string[] = [];
    const errors: Array<{ id: string; error: string }> = [];
    settled.forEach((result, index) => {
      const id = records[index]!.id;
      if (result.status === "fulfilled") cancelled.push(id);
      else errors.push({ id, error: result.reason instanceof Error ? result.reason.message : String(result.reason) });
    });
    return { cancelled, errors };
  }

  private async issueCancellation(id: string, reason: string): Promise<void> {
    const record = this.registry.get(id);
    if (!record || terminal(record)) return;
    this.pending.delete(id);
    const handle = this.handles.get(id);
    if (handle) {
      await handle.cancel();
      const current = this.registry.get(id);
      if (current && !terminal(current)) this.registry.transition(id, "cancelled", reason);
    } else {
      this.registry.transition(id, "cancelled", reason);
      this.deliverTerminal(this.registry.get(id)!);
      this.notify();
    }
    if (!this.shuttingDown) void this.scheduleNext();
  }

  private notify(): void {
    const records = this.registry.list();
    for (const subscriber of this.subscribers) subscriber(records);
  }
}
