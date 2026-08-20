import { randomUUID } from "node:crypto";
import { UniqueNameAllocator } from "./names.js";
import type {
  AgentRecord,
  AgentStatus,
  PermissionMode,
  SubagentConfig,
  ThinkingLevel,
} from "./types.js";

export interface AdmitRequest {
  name: string;
  parentId?: string;
  role: string;
  task: string;
  contextSummary?: string;
  permission: PermissionMode;
  requestedModel?: string;
  requestedEffort?: ThinkingLevel;
  cwd: string;
}

const LIVE_STATUSES = new Set<AgentStatus>(["queued", "starting", "running"]);
const RUNNING_STATUSES = new Set<AgentStatus>(["starting", "running"]);
const TERMINAL_STATUSES = new Set<AgentStatus>(["completed", "failed", "cancelled"]);
const LEGAL_TRANSITIONS: Readonly<Record<AgentStatus, ReadonlySet<AgentStatus>>> = {
  queued: new Set(["starting"]),
  starting: new Set(["running", "failed", "cancelled"]),
  running: new Set(["completed", "failed", "cancelled"]),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set(),
};

function copyRecord(record: AgentRecord): AgentRecord {
  return structuredClone(record);
}

export class AgentRegistry {
  private readonly records = new Map<string, AgentRecord>();
  private readonly names = new UniqueNameAllocator();

  constructor(private readonly config: SubagentConfig) {}

  get liveCount(): number {
    let count = 0;
    for (const record of this.records.values()) {
      if (LIVE_STATUSES.has(record.status)) count += 1;
    }
    return count;
  }

  get runningCount(): number {
    let count = 0;
    for (const record of this.records.values()) {
      if (RUNNING_STATUSES.has(record.status)) count += 1;
    }
    return count;
  }

  admit(request: AdmitRequest): AgentRecord {
    if (this.liveCount >= this.config.maxAgents) {
      throw new Error(`Live subagent limit reached: ${this.config.maxAgents}.`);
    }

    const parent = request.parentId ? this.records.get(request.parentId) : undefined;
    if (request.parentId && !parent) {
      throw new Error(`Unknown parent agent: ${request.parentId}.`);
    }

    const depth = parent ? parent.depth + 1 : 1;
    if (depth > this.config.maxDepth) {
      throw new Error("Agent depth limit reached.");
    }
    if (parent?.permission === "read-only" && request.permission === "inherit") {
      throw new Error("A read-only parent cannot grant inherited permission.");
    }

    const createdAt = Date.now();
    const status: AgentStatus =
      this.runningCount < this.config.maxConcurrency ? "starting" : "queued";
    const record: AgentRecord = {
      id: randomUUID(),
      requestedName: request.name,
      displayName: this.names.allocate(request.name),
      depth,
      role: request.role,
      task: request.task,
      permission: request.permission,
      cwd: request.cwd,
      status,
      createdAt,
      updates: [],
      activity: [],
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: 0,
        turns: 0,
      },
    };
    if (request.parentId) record.parentId = request.parentId;
    if (request.contextSummary !== undefined) record.contextSummary = request.contextSummary;
    if (request.requestedModel !== undefined) record.requestedModel = request.requestedModel;
    if (request.requestedEffort !== undefined) record.requestedEffort = request.requestedEffort;
    if (status === "starting") record.startedAt = createdAt;

    this.records.set(record.id, record);
    return copyRecord(record);
  }

  transition(id: string, status: AgentStatus, reason?: string): AgentRecord {
    const record = this.records.get(id);
    if (!record) throw new Error(`Unknown agent: ${id}.`);
    if (TERMINAL_STATUSES.has(record.status)) {
      throw new Error(`Terminal agent state cannot change: ${record.status}.`);
    }
    if (!LEGAL_TRANSITIONS[record.status].has(status)) {
      throw new Error(`Illegal agent transition: ${record.status} -> ${status}.`);
    }

    const now = Date.now();
    record.status = status;
    if (status === "starting" || status === "running") record.startedAt ??= now;
    if (TERMINAL_STATUSES.has(status)) record.finishedAt = now;
    if (reason !== undefined) record.statusReason = reason;
    return copyRecord(record);
  }

  get(id: string): AgentRecord | undefined {
    const record = this.records.get(id);
    return record ? copyRecord(record) : undefined;
  }

  list(): AgentRecord[] {
    return [...this.records.values()].map(copyRecord);
  }

  descendantsOf(id: string): AgentRecord[] {
    if (!this.records.has(id)) return [];

    const descendants: AgentRecord[] = [];
    const pending = [id];
    while (pending.length > 0) {
      const parentId = pending.shift()!;
      for (const record of this.records.values()) {
        if (record.parentId !== parentId) continue;
        descendants.push(copyRecord(record));
        pending.push(record.id);
      }
    }
    return descendants;
  }
}
