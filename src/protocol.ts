import type { DispatchCatalog } from "./dispatch-catalog.js";
import type { PermissionMode, ThinkingLevel } from "./types.js";

export const MAX_FRAME_BYTES = 256 * 1024;
export const MAX_INSPECTION_BYTES = 50 * 1024;

export type InspectView = "metadata" | "updates" | "summary" | "session";

export interface StartInput {
  name: string;
  role?: string;
  task: string;
  permission?: PermissionMode;
  contextSummary?: string;
  model?: string;
  effort?: ThinkingLevel;
  cwd?: string;
}

export interface StartReceipt {
  id: string;
  displayName: string;
  status: "queued" | "starting" | "failed";
  depth: number;
  error?: string;
}

export interface InspectResult {
  view: InspectView;
  targetId: string;
  content: unknown;
  offset?: number;
  nextOffset?: number;
  truncated?: boolean;
}

export type ControlMessage =
  | { v: 1; type: "hello"; token: string; agentId: string }
  | { v: 1; type: "catalog"; requestId: string; requesterId: string }
  | { v: 1; type: "catalog_result"; requestId: string; catalog?: DispatchCatalog; error?: string }
  | { v: 1; type: "dispatch"; requestId: string; parentId: string; input: StartInput }
  | { v: 1; type: "dispatch_result"; requestId: string; receipt?: StartReceipt; error?: string }
  | { v: 1; type: "update"; agentId: string; text: string; promote: boolean }
  | { v: 1; type: "session_ready"; agentId: string; sessionFile: string }
  | {
      v: 1;
      type: "inspect";
      requestId: string;
      requesterId: string;
      targetId: string;
      view: InspectView;
      offset?: number;
      limit?: number;
    }
  | { v: 1; type: "inspect_result"; requestId: string; result?: InspectResult; error?: string }
  | {
      v: 1;
      type: "cancel";
      requestId: string;
      requesterId: string;
      targetId: string;
      scope: "one" | "tree";
    }
  | { v: 1; type: "cancel_result"; requestId: string; cancelled: string[]; error?: string }
  | {
      v: 1;
      type: "parent_message";
      agentId: string;
      childId: string;
      kind: "update" | "complete" | "failed" | "cancelled";
      text: string;
      sessionFile?: string;
    };

export class ProtocolError extends Error {
  override readonly name = "ProtocolError";
}

const MESSAGE_TYPES = new Set([
  "hello",
  "catalog",
  "catalog_result",
  "dispatch",
  "dispatch_result",
  "update",
  "session_ready",
  "inspect",
  "inspect_result",
  "cancel",
  "cancel_result",
  "parent_message",
]);
const INSPECT_VIEWS = new Set<InspectView>(["metadata", "updates", "summary", "session"]);
const THINKING_LEVELS = new Set<ThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

function assertSafeObject(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new ProtocolError("Control messages cannot contain prototype-bearing keys.");
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === "__proto__" || key === "prototype" || key === "constructor") {
      throw new ProtocolError("Control messages cannot contain prototype-bearing keys.");
    }
    assertSafeObject(child);
  }
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ProtocolError("Control message must be an object.");
  }
  return value as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, name: string): string {
  const field = value[name];
  if (typeof field !== "string" || field.length === 0) {
    throw new ProtocolError(`Control message field "${name}" must be a non-empty string.`);
  }
  return field;
}

function optionalString(value: Record<string, unknown>, name: string): string | undefined {
  if (value[name] === undefined) return undefined;
  return stringField(value, name);
}

function requestFields(value: Record<string, unknown>): void {
  stringField(value, "requestId");
}

function validateStartInput(value: unknown): void {
  const input = object(value);
  stringField(input, "name");
  optionalString(input, "role");
  stringField(input, "task");
  optionalString(input, "contextSummary");
  optionalString(input, "model");
  optionalString(input, "cwd");
  if (
    input.permission !== undefined &&
    input.permission !== "read-only" &&
    input.permission !== "inherit"
  ) {
    throw new ProtocolError("Invalid subagent permission.");
  }
  if (
    input.effort !== undefined &&
    (typeof input.effort !== "string" || !THINKING_LEVELS.has(input.effort as ThinkingLevel))
  ) {
    throw new ProtocolError("Invalid subagent thinking level.");
  }
}

function assertOnlyFields(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) throw new ProtocolError(`Unexpected ${label} field "${field}".`);
  }
}

function validateDispatchCatalog(value: unknown): void {
  const catalog = object(value);
  assertOnlyFields(catalog, new Set(["roles", "models"]), "dispatch catalogue");
  if (!Array.isArray(catalog.roles)) throw new ProtocolError("Dispatch catalogue roles must be an array.");
  for (const value of catalog.roles) {
    const role = object(value);
    assertOnlyFields(
      role,
      new Set(["name", "description", "source", "defaultModel", "defaultEffort", "defaultPermission"]),
      "dispatch role",
    );
    stringField(role, "name");
    stringField(role, "description");
    if (role.source !== "bundled" && role.source !== "user" && role.source !== "project") {
      throw new ProtocolError("Invalid dispatch role source.");
    }
    optionalString(role, "defaultModel");
    if (
      role.defaultEffort !== undefined &&
      (typeof role.defaultEffort !== "string" ||
        !THINKING_LEVELS.has(role.defaultEffort as ThinkingLevel))
    ) {
      throw new ProtocolError("Invalid dispatch role thinking level.");
    }
    if (
      role.defaultPermission !== undefined &&
      role.defaultPermission !== "read-only" &&
      role.defaultPermission !== "inherit"
    ) {
      throw new ProtocolError("Invalid dispatch role permission.");
    }
  }
  if (
    !Array.isArray(catalog.models) ||
    catalog.models.some((model) => typeof model !== "string" || model.length === 0)
  ) {
    throw new ProtocolError("Dispatch model identifiers must be non-empty strings.");
  }
}

function validateReceipt(value: unknown): void {
  const receipt = object(value);
  stringField(receipt, "id");
  stringField(receipt, "displayName");
  if (!new Set(["queued", "starting", "failed"]).has(String(receipt.status))) {
    throw new ProtocolError("Invalid dispatch receipt status.");
  }
  if (!Number.isInteger(receipt.depth) || Number(receipt.depth) < 1) {
    throw new ProtocolError("Invalid dispatch receipt depth.");
  }
  optionalString(receipt, "error");
}

export function validateControlMessage(value: unknown): ControlMessage {
  assertSafeObject(value);
  const message = object(value);
  if (message.v !== 1) throw new ProtocolError("Unsupported control protocol version.");
  if (typeof message.type !== "string" || !MESSAGE_TYPES.has(message.type)) {
    throw new ProtocolError(`Unknown control message type "${String(message.type)}".`);
  }

  switch (message.type) {
    case "hello":
      stringField(message, "token");
      stringField(message, "agentId");
      break;
    case "catalog":
      requestFields(message);
      stringField(message, "requesterId");
      break;
    case "catalog_result":
      requestFields(message);
      if (message.catalog !== undefined) validateDispatchCatalog(message.catalog);
      optionalString(message, "error");
      if (message.catalog === undefined && message.error === undefined) {
        throw new ProtocolError("Catalogue result must include a catalogue or error.");
      }
      break;
    case "dispatch":
      requestFields(message);
      stringField(message, "parentId");
      validateStartInput(message.input);
      break;
    case "dispatch_result":
      requestFields(message);
      if (message.receipt !== undefined) validateReceipt(message.receipt);
      optionalString(message, "error");
      if (message.receipt === undefined && message.error === undefined) {
        throw new ProtocolError("Dispatch result must include a receipt or error.");
      }
      break;
    case "update":
      stringField(message, "agentId");
      stringField(message, "text");
      if (typeof message.promote !== "boolean") {
        throw new ProtocolError('Control message field "promote" must be boolean.');
      }
      break;
    case "session_ready":
      stringField(message, "agentId");
      stringField(message, "sessionFile");
      break;
    case "inspect": {
      requestFields(message);
      stringField(message, "requesterId");
      stringField(message, "targetId");
      if (typeof message.view !== "string" || !INSPECT_VIEWS.has(message.view as InspectView)) {
        throw new ProtocolError("Invalid inspection view.");
      }
      if (message.offset !== undefined && (!Number.isInteger(message.offset) || Number(message.offset) < 0)) {
        throw new ProtocolError("Inspection offset must be a non-negative integer.");
      }
      if (message.limit !== undefined) {
        if (!Number.isInteger(message.limit) || Number(message.limit) < 1) {
          throw new ProtocolError("Inspection limit must be a positive integer.");
        }
        if (Number(message.limit) > MAX_INSPECTION_BYTES) {
          throw new ProtocolError(`Inspection limit cannot exceed ${MAX_INSPECTION_BYTES} bytes.`);
        }
      }
      break;
    }
    case "inspect_result":
      requestFields(message);
      if (message.result !== undefined) object(message.result);
      optionalString(message, "error");
      if (message.result === undefined && message.error === undefined) {
        throw new ProtocolError("Inspection result must include a result or error.");
      }
      break;
    case "cancel":
      requestFields(message);
      stringField(message, "requesterId");
      stringField(message, "targetId");
      if (message.scope !== "one" && message.scope !== "tree") {
        throw new ProtocolError("Invalid cancellation scope.");
      }
      break;
    case "cancel_result":
      requestFields(message);
      if (!Array.isArray(message.cancelled) || message.cancelled.some((id) => typeof id !== "string")) {
        throw new ProtocolError("Cancellation result must contain agent identifiers.");
      }
      optionalString(message, "error");
      break;
    case "parent_message":
      stringField(message, "agentId");
      stringField(message, "childId");
      stringField(message, "text");
      if (!new Set(["update", "complete", "failed", "cancelled"]).has(String(message.kind))) {
        throw new ProtocolError("Invalid parent message kind.");
      }
      optionalString(message, "sessionFile");
      break;
  }

  return message as ControlMessage;
}

export function encodeFrame(message: ControlMessage): Buffer {
  const validated = validateControlMessage(message);
  const frame = Buffer.from(`${JSON.stringify(validated)}\n`, "utf8");
  if (frame.byteLength > MAX_FRAME_BYTES) {
    throw new ProtocolError(`Control frame exceeds ${MAX_FRAME_BYTES} bytes.`);
  }
  return frame;
}

export class FrameDecoder {
  private buffer = Buffer.alloc(0);

  push(chunk: Uint8Array): ControlMessage[] {
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    const messages: ControlMessage[] = [];

    while (true) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline < 0) {
        if (this.buffer.byteLength > MAX_FRAME_BYTES) {
          throw new ProtocolError(`Control frame exceeds ${MAX_FRAME_BYTES} bytes.`);
        }
        return messages;
      }

      const frameLength = newline + 1;
      if (frameLength > MAX_FRAME_BYTES) {
        throw new ProtocolError(`Control frame exceeds ${MAX_FRAME_BYTES} bytes.`);
      }
      const line = this.buffer.subarray(0, newline).toString("utf8");
      this.buffer = this.buffer.subarray(frameLength);
      if (line.length === 0) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new ProtocolError("Invalid JSON control frame.");
      }
      messages.push(validateControlMessage(parsed));
    }
  }
}
