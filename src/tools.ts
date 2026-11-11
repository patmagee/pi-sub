import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import type { DispatchCatalog } from "./dispatch-catalog.js";
import type { CancelResult, RecordUpdateInput } from "./manager.js";
import type { InspectResult, StartInput, StartReceipt } from "./protocol.js";

const MAX_TOOL_TEXT_BYTES = 50 * 1024;

function roleDescription(catalog: DispatchCatalog): string {
  const roles = catalog.roles.map((role) => `${role.name}: ${role.description}`).join("; ");
  return `Optional role profile. Omit role to use generic. Available roles: ${roles}.`;
}

function modelDescription(catalog: DispatchCatalog): string {
  const models = catalog.models.join(", ") || "none";
  return `Provider/model override. Use an exact identifier or shorthand. Shorthand must match exactly one identifier. Available models: ${models}.`;
}

export function createSubagentStartSchema(catalog: DispatchCatalog) {
  return Type.Object(
    {
      name: Type.String({ minLength: 1, description: "Short display name for the agent" }),
      role: Type.Optional(
        StringEnum(
          catalog.roles.map((role) => role.name),
          { description: roleDescription(catalog) },
        ),
      ),
      task: Type.String({ minLength: 1, description: "Bounded assignment" }),
      permission: Type.Optional(StringEnum(["read-only", "inherit"] as const)),
      contextSummary: Type.Optional(Type.String({ description: "Explicit parent-written context summary" })),
      model: Type.Optional(Type.String({ minLength: 1, description: modelDescription(catalog) })),
      effort: Type.Optional(
        StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const),
      ),
      cwd: Type.Optional(Type.String({ minLength: 1, description: "Working directory" })),
    },
    { additionalProperties: false },
  );
}

export const SubagentUpdateSchema = Type.Object(
  {
    text: Type.String({ minLength: 1, maxLength: 16 * 1024 }),
    promote: Type.Optional(Type.Boolean({ default: false })),
  },
  { additionalProperties: false },
);

export const SubagentInspectSchema = Type.Object(
  {
    targetId: Type.String({ minLength: 1 }),
    view: StringEnum(["metadata", "updates", "summary", "session"] as const),
    offset: Type.Optional(Type.Integer({ minimum: 0 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_TOOL_TEXT_BYTES })),
  },
  { additionalProperties: false },
);

export const SubagentCancelSchema = Type.Object(
  {
    targetId: Type.Optional(Type.String({ minLength: 1 })),
    scope: StringEnum(["one", "tree", "all"] as const),
  },
  { additionalProperties: false },
);

export type SubagentStartParameters = StartInput;
export type SubagentUpdateParameters = Static<typeof SubagentUpdateSchema>;
export type SubagentInspectParameters = Static<typeof SubagentInspectSchema>;
export type SubagentCancelParameters = Static<typeof SubagentCancelSchema>;

export interface SubagentToolController {
  start(input: StartInput, signal?: AbortSignal): Promise<StartReceipt>;
  update(input: Omit<RecordUpdateInput, "agentId">, signal?: AbortSignal): Promise<unknown>;
  inspect(
    input: {
      targetId: string;
      view: "metadata" | "updates" | "summary" | "session";
      offset?: number;
      limit?: number;
    },
    signal?: AbortSignal,
  ): Promise<InspectResult>;
  cancel(
    input: { targetId?: string; scope: "one" | "tree" | "all" },
    signal?: AbortSignal,
  ): Promise<CancelResult>;
}

function bounded(value: string): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= MAX_TOOL_TEXT_BYTES) return value;
  const suffix = Buffer.from("\n[truncated]", "utf8");
  return `${bytes.subarray(0, MAX_TOOL_TEXT_BYTES - suffix.byteLength).toString("utf8")}\n[truncated]`;
}

function inspectText(result: InspectResult): string {
  const header = `${result.targetId} [${result.view}]`;
  const body = typeof result.content === "string" ? result.content : JSON.stringify(result.content, null, 2);
  const continuation = result.truncated
    ? `\n[truncated; continue at byte ${result.nextOffset ?? "unknown"}]`
    : "";
  return bounded(`${header}\n${body}${continuation}`);
}

export function registerSubagentTools(
  pi: Pick<ExtensionAPI, "registerTool">,
  controller: SubagentToolController,
  catalog: DispatchCatalog,
): void {
  pi.registerTool({
    name: "subagent_start",
    label: "Start Subagent",
    description: "Start one isolated subagent asynchronously and return its receipt immediately.",
    promptSnippet: "subagent_start: start an isolated asynchronous subagent",
    promptGuidelines: [
      "Use subagent_start for context-heavy exploration only when omitted child context is not needed to judge the result.",
      "Treat reports and promoted updates from subagent_start as internal evidence. Do not paste subagent reports or individual agent summaries into chat; give your own conclusions after checking their claims.",
      "When work delegated with subagent_start finishes, report the outcome without waiting for the user to ask. Consolidate related results into one concise update rather than narrating each agent's completion. If related agents are still working, reserve the combined conclusion until their results arrive unless a blocker needs attention now.",
      "For outcomes from subagent_start, lead with what needs attention. Use Needs your decision for specific questions with a recommendation, Still unresolved for confirmed problems and their impact, and Handled for a brief account of fixes and checks. Omit empty sections. State when failed or cancelled work leaves a gap; never present it as a successful review.",
    ],
    parameters: createSubagentStartSchema(catalog),
    async execute(_id, params, signal) {
      const receipt = await controller.start(params, signal);
      const modelText = "model" in params && params.model ? ` model=${params.model}` : "";
      const effortText = "effort" in params && params.effort ? ` effort=${params.effort}` : "";
      const roleName = params.role ?? "generic";
      const rolePermission = catalog.roles.find((role) => role.name === roleName)?.defaultPermission;
      const permission = params.permission ?? rolePermission ?? "read-only";
      return {
        content: [
          {
            type: "text",
            text: `${receipt.displayName} [${receipt.status}] id=${receipt.id} depth=${receipt.depth}${modelText}${effortText} permission=${permission}${receipt.error ? ` error=${receipt.error}` : ""}`,
          },
        ],
        details: receipt,
      };
    },
    renderCall(args, theme) {
      return new Text(
        `${theme.fg("toolTitle", theme.bold("subagent_start "))}${theme.fg("accent", args.name)} ${theme.fg("muted", args.role ?? "generic")}`,
        0,
        0,
      );
    },
    renderResult(result, _options, theme) {
      const text = result.content[0];
      return new Text(theme.fg("toolOutput", text?.type === "text" ? text.text : "(no receipt)"), 0, 0);
    },
  });

  pi.registerTool({
    name: "subagent_update",
    label: "Update Parent",
    description: "Record a concise update and optionally promote it to the direct parent context.",
    promptSnippet: "subagent_update: record or explicitly promote an important child update",
    promptGuidelines: [
      "Use subagent_update for important findings while a subagent continues, and promote only self-contained parent-relevant text.",
    ],
    parameters: SubagentUpdateSchema,
    async execute(_id, params, signal) {
      const promoted = params.promote ?? false;
      const details = await controller.update({ text: params.text, promote: promoted }, signal);
      return {
        content: [{ type: "text", text: promoted ? "Update recorded and promoted." : "Update recorded." }],
        details,
      };
    },
  });

  pi.registerTool({
    name: "subagent_inspect",
    label: "Inspect Subagent",
    description: "Inspect bounded subagent metadata, updates, summary, or session bytes.",
    promptSnippet: "subagent_inspect: retrieve bounded state from a retained subagent",
    promptGuidelines: [
      "Use subagent_inspect for bounded subagent state instead of requesting a full transcript.",
    ],
    parameters: SubagentInspectSchema,
    async execute(_id, params, signal) {
      const result = await controller.inspect(params, signal);
      return { content: [{ type: "text", text: inspectText(result) }], details: result };
    },
  });

  pi.registerTool({
    name: "subagent_cancel",
    label: "Cancel Subagent",
    description: "Cancel one subagent, a descendant tree, or all live subagents when root-authorized.",
    promptSnippet: "subagent_cancel: cancel live subagent work by scope",
    promptGuidelines: [
      "Use subagent_cancel when delegated work is no longer needed or cannot complete safely.",
    ],
    parameters: SubagentCancelSchema,
    async execute(_id, params, signal) {
      const result = await controller.cancel(params, signal);
      const failures = result.errors.length > 0 ? `; ${result.errors.length} cancellation errors` : "";
      return {
        content: [{ type: "text", text: `Cancelled ${result.cancelled.length} subagent(s)${failures}.` }],
        details: result,
      };
    },
  });
}
