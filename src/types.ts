export type PermissionMode = "read-only" | "inherit";

export type AgentStatus =
  | "queued"
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface SubagentConfig {
  maxAgents: number;
  maxConcurrency: number;
  maxDepth: number;
  socketDir?: string;
  cancelGraceMs: number;
}

export interface AgentUpdate {
  text: string;
  promote: boolean;
  createdAt: number;
}

export type AgentActivityKind = "reasoning" | "text" | "tool" | "diagnostic";

export interface AgentActivity {
  kind: AgentActivityKind;
  text: string;
  createdAt: number;
  toolName?: string;
  isError?: boolean;
}

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
  turns: number;
}

export interface AgentRecord {
  id: string;
  requestedName: string;
  displayName: string;
  parentId?: string;
  depth: number;
  role: string;
  task: string;
  contextSummary?: string;
  permission: PermissionMode;
  requestedModel?: string;
  effectiveModel?: string;
  requestedEffort?: ThinkingLevel;
  effectiveEffort?: ThinkingLevel;
  cwd: string;
  status: AgentStatus;
  statusReason?: string;
  pid?: number;
  sessionFile?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  updates: AgentUpdate[];
  activity: AgentActivity[];
  finalSummary?: string;
  usage: UsageTotals;
}
