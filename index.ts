import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { parseConfig } from "./src/config.js";
import {
  type ParentDelivery,
  type ParentContext,
  SubagentManager,
} from "./src/manager.js";
import { buildPiArgs, resolvePiInvocation } from "./src/pi-command.js";
import { ProcessRunner } from "./src/process-runner.js";
import type { ControlMessage, InspectResult, StartReceipt } from "./src/protocol.js";
import { discoverRoles } from "./src/roles.js";
import { RootSocketClient, type RootSocketClientOptions } from "./src/socket-client.js";
import { RootSocketServer } from "./src/socket-server.js";
import {
  registerSubagentTools,
  type SubagentToolController,
} from "./src/tools.js";
import { SubagentDashboard } from "./src/tui/dashboard.js";
import { createStatusEditorFactory } from "./src/tui/editor-wrapper.js";
import { SubagentStatusStrip } from "./src/tui/status-strip.js";
import type { AgentRecord } from "./src/types.js";

const extensionPath = fileURLToPath(import.meta.url);

export interface SessionRuntime {
  controller: SubagentToolController;
  shutdown(reason: string): Promise<void>;
  diagnostics: string[];
  subscribe?(listener: (records: AgentRecord[]) => void): () => void;
}

export interface RuntimeFactoryInput {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  environment: NodeJS.ProcessEnv;
  projectTrusted: boolean;
}

export interface SubagentExtensionDependencies {
  environment: () => NodeJS.ProcessEnv;
  createRootRuntime(input: RuntimeFactoryInput): Promise<SessionRuntime>;
  createChildRuntime(input: RuntimeFactoryInput): Promise<SessionRuntime>;
}

function requiredEnvironment(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (!value) throw new Error(`Missing child control environment variable ${name}.`);
  return value;
}

function currentParentContext(pi: ExtensionAPI, ctx: ExtensionContext): ParentContext {
  const context: ParentContext = {
    name: "orchestrator",
    permission: "inherit",
    cwd: ctx.cwd,
    activeTools: pi.getActiveTools(),
  };
  if (ctx.model) context.model = `${ctx.model.provider}/${ctx.model.id}`;
  context.effort = pi.getThinkingLevel();
  return context;
}

export function sendParentDelivery(pi: Pick<ExtensionAPI, "sendMessage">, delivery: ParentDelivery): void {
  const update = delivery.kind === "update";
  pi.sendMessage(
    {
      customType: update ? "subagent-update" : "subagent-complete",
      content: delivery.text,
      display: true,
      details: {
        childId: delivery.childId,
        status: delivery.kind,
        ...(delivery.sessionFile ? { sessionFile: delivery.sessionFile } : {}),
      },
    },
    {
      deliverAs: update ? "steer" : "followUp",
      triggerTurn: true,
    },
  );
}

async function createRootRuntime(input: RuntimeFactoryInput): Promise<SessionRuntime> {
  const parsed = parseConfig(input.environment);
  const discovered = await discoverRoles({
    cwd: input.ctx.cwd,
    projectTrusted: input.projectTrusted,
  });

  let manager: SubagentManager;
  const server = await RootSocketServer.start({
    ...(parsed.config.socketDir ? { socketParentDir: parsed.config.socketDir } : {}),
    authenticateAgent: (agentId) => {
      try {
        manager.contextFor(agentId);
        return true;
      } catch {
        return false;
      }
    },
    onMessage: async (message, boundAgentId): Promise<ControlMessage | undefined> => {
      if (message.type === "dispatch") {
        try {
          const receipt = await manager.start(message.input, manager.contextFor(boundAgentId));
          return { v: 1, type: "dispatch_result", requestId: message.requestId, receipt };
        } catch (error) {
          return {
            v: 1,
            type: "dispatch_result",
            requestId: message.requestId,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }
      if (message.type === "update") {
        manager.recordUpdate({ agentId: boundAgentId, text: message.text, promote: message.promote });
        return undefined;
      }
      if (message.type === "inspect") {
        try {
          const result = await manager.inspect({
            requesterId: boundAgentId,
            targetId: message.targetId,
            view: message.view,
            ...(message.offset !== undefined ? { offset: message.offset } : {}),
            ...(message.limit !== undefined ? { limit: message.limit } : {}),
          });
          return { v: 1, type: "inspect_result", requestId: message.requestId, result };
        } catch (error) {
          return {
            v: 1,
            type: "inspect_result",
            requestId: message.requestId,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }
      try {
        const result = await manager.cancel({
          requesterId: boundAgentId,
          targetId: message.targetId,
          scope: message.scope,
        });
        return {
          v: 1,
          type: "cancel_result",
          requestId: message.requestId,
          cancelled: result.cancelled,
          ...(result.errors.length > 0 ? { error: result.errors.map((entry) => entry.error).join("; ") } : {}),
        };
      } catch (error) {
        return {
          v: 1,
          type: "cancel_result",
          requestId: message.requestId,
          cancelled: [],
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  });

  const runner = new ProcessRunner();
  manager = new SubagentManager({
    config: parsed.config,
    roles: discovered.roles,
    processRunner: runner,
    modelAvailable: (requested) =>
      input.ctx.modelRegistry
        .getAvailable()
        .some((model) => `${model.provider}/${model.id}` === requested),
    prepareProcess: async (record, prompt, parentContext) => {
      const built = await buildPiArgs({
        prompt,
        tempParentDir: server.socketDirectory,
        extensionPath,
        permission: record.permission,
        parentTools: parentContext.activeTools,
        ...(record.effectiveModel ? { model: record.effectiveModel } : {}),
        ...(record.effectiveEffort ? { effort: record.effectiveEffort } : {}),
        socketPath: server.socketPath,
        token: server.token,
        agentId: record.id,
        parentId: record.parentId ?? input.ctx.sessionManager.getSessionId(),
        depth: record.depth,
        rootSessionId: input.ctx.sessionManager.getSessionId(),
        childSessionId: randomUUID(),
      });
      const invocation = resolvePiInvocation(built.args);
      return {
        command: invocation.command,
        args: invocation.args,
        cwd: record.cwd,
        env: built.env,
        cancelGraceMs: parsed.config.cancelGraceMs,
        cleanup: built.cleanup,
      };
    },
    deliverToParent: (parentId, delivery) => {
      if (parentId) {
        server.sendParentMessage({
          v: 1,
          type: "parent_message",
          agentId: parentId,
          childId: delivery.childId,
          kind: delivery.kind,
          text: delivery.text,
          ...(delivery.sessionFile ? { sessionFile: delivery.sessionFile } : {}),
        });
      } else {
        sendParentDelivery(input.pi, delivery);
      }
    },
    controlServer: server,
  });

  const controller: SubagentToolController = {
    start: (startInput) => manager.start(startInput, currentParentContext(input.pi, input.ctx)),
    update: async () => {
      throw new Error("The root orchestrator cannot report a child update.");
    },
    inspect: (query) => manager.inspect(query),
    cancel: (query) => manager.cancel(query),
  };
  return {
    controller,
    diagnostics: [...parsed.diagnostics, ...discovered.diagnostics],
    subscribe: (listener) => manager.subscribe(listener),
    shutdown: (reason) => manager.shutdown(reason),
  };
}

export interface ChildRuntimeDependencies {
  connect(options: RootSocketClientOptions): Promise<RootSocketClient>;
}

const defaultChildDependencies: ChildRuntimeDependencies = {
  connect: (options) => RootSocketClient.connect(options),
};

export async function createChildRuntime(
  input: RuntimeFactoryInput,
  childDependencies: ChildRuntimeDependencies = defaultChildDependencies,
): Promise<SessionRuntime> {
  const socketPath = requiredEnvironment(input.environment, "PI_SUB_ROOT_SOCKET");
  const token = requiredEnvironment(input.environment, "PI_SUB_ROOT_TOKEN");
  const agentId = requiredEnvironment(input.environment, "PI_SUB_AGENT_ID");
  const client = await childDependencies.connect({ socketPath, token, agentId });
  const unsubscribeParentMessages = client.subscribeParentMessages((message) => {
    sendParentDelivery(input.pi, {
      childId: message.childId,
      kind: message.kind,
      text: message.text,
      ...(message.sessionFile ? { sessionFile: message.sessionFile } : {}),
    });
  });

  const controller: SubagentToolController = {
    async start(startInput, signal): Promise<StartReceipt> {
      const requestId = randomUUID();
      const response = await client.request(
        { v: 1, type: "dispatch", requestId, parentId: agentId, input: startInput },
        signal,
      );
      if (response.type !== "dispatch_result") throw new Error("Unexpected dispatch response.");
      if (response.error) throw new Error(response.error);
      if (!response.receipt) throw new Error("Dispatch response did not contain a receipt.");
      return response.receipt;
    },
    async update(updateInput): Promise<unknown> {
      client.send({ v: 1, type: "update", agentId, text: updateInput.text, promote: updateInput.promote });
      return { recorded: true, promoted: updateInput.promote };
    },
    async inspect(query, signal): Promise<InspectResult> {
      const requestId = randomUUID();
      const response = await client.request(
        {
          v: 1,
          type: "inspect",
          requestId,
          requesterId: agentId,
          targetId: query.targetId,
          view: query.view,
          ...(query.offset !== undefined ? { offset: query.offset } : {}),
          ...(query.limit !== undefined ? { limit: query.limit } : {}),
        },
        signal,
      );
      if (response.type !== "inspect_result") throw new Error("Unexpected inspection response.");
      if (response.error) throw new Error(response.error);
      if (!response.result) throw new Error("Inspection response did not contain a result.");
      return response.result;
    },
    async cancel(query, signal) {
      if (query.scope === "all") throw new Error("Only the root orchestrator can cancel all agents.");
      if (!query.targetId) throw new Error("Cancellation target is required.");
      const requestId = randomUUID();
      const response = await client.request(
        {
          v: 1,
          type: "cancel",
          requestId,
          requesterId: agentId,
          targetId: query.targetId,
          scope: query.scope,
        },
        signal,
      );
      if (response.type !== "cancel_result") throw new Error("Unexpected cancellation response.");
      return {
        cancelled: response.cancelled,
        errors: response.error ? [{ id: query.targetId, error: response.error }] : [],
      };
    },
  };

  return {
    controller,
    diagnostics: [],
    shutdown: async () => {
      unsubscribeParentMessages();
      client.close();
    },
  };
}

const defaultDependencies: SubagentExtensionDependencies = {
  environment: () => process.env,
  createRootRuntime,
  createChildRuntime,
};

export function createSubagentExtension(
  dependencies: SubagentExtensionDependencies = defaultDependencies,
): ExtensionFactory {
  return (pi) => {
    let runtime: SessionRuntime | undefined;
    let cleanup: Promise<void> | undefined;
    let disposeTui: (() => void) | undefined;
    let openDashboard: ((initialId?: string) => Promise<void>) | undefined;

    const proxy: SubagentToolController = {
      start: (input, signal) => activeRuntime().controller.start(input, signal),
      update: (input, signal) => activeRuntime().controller.update(input, signal),
      inspect: (input, signal) => activeRuntime().controller.inspect(input, signal),
      cancel: (input, signal) => activeRuntime().controller.cancel(input, signal),
    };
    const activeRuntime = (): SessionRuntime => {
      if (!runtime) throw new Error("Subagent session runtime is not active.");
      return runtime;
    };

    registerSubagentTools(pi, proxy);
    pi.registerMessageRenderer("subagent-update", (message, options, theme) => {
      const details = message.details as { childId?: string } | undefined;
      return new Text(
        `${theme.fg("warning", "subagent update")} ${theme.fg("muted", String(details?.childId ?? "unknown"))}\n${String(message.content)}`,
        options.outputPad,
        0,
      );
    });
    pi.registerMessageRenderer("subagent-complete", (message, options, theme) => {
      const details = message.details as { childId?: string; status?: string } | undefined;
      return new Text(
        `${theme.fg("success", `subagent ${String(details?.status ?? "complete")}`)} ${theme.fg("muted", String(details?.childId ?? "unknown"))}\n${String(message.content)}`,
        options.outputPad,
        0,
      );
    });
    pi.registerCommand("subagents", {
      description: "Show subagent status and management controls",
      handler: async (_args, ctx) => {
        if (openDashboard) await openDashboard();
        else ctx.ui.notify("The subagent dashboard is available only in an active TUI session.", "info");
      },
    });

    pi.on("session_start", async (_event, ctx) => {
      cleanup = undefined;
      const environment = dependencies.environment();
      const factoryInput: RuntimeFactoryInput = {
        pi,
        ctx,
        environment,
        projectTrusted: ctx.isProjectTrusted(),
      };
      runtime = environment.PI_SUB_ROOT_SOCKET
        ? await dependencies.createChildRuntime(factoryInput)
        : await dependencies.createRootRuntime(factoryInput);
      if (ctx.hasUI) {
        for (const diagnostic of runtime.diagnostics) ctx.ui.notify(diagnostic, "warning");
      }
      if (ctx.mode === "tui" && runtime.subscribe) {
        let retained: AgentRecord[] = [];
        let widgetTui: { requestRender(): void } | undefined;
        const strip = new SubagentStatusStrip([], ctx.ui.theme, {
          openAgent: (id) => {
            void openDashboard?.(id);
          },
          invalidated: () => widgetTui?.requestRender(),
        });
        const unsubscribe = runtime.subscribe((records) => {
          retained = records;
          strip.setRecords(records);
        });
        openDashboard = async (initialId) => {
          const active = activeRuntime();
          await ctx.ui.custom<void>((tui, theme, _keybindings, done) =>
            new SubagentDashboard(
              retained,
              theme,
              {
                root: true,
                now: () => Date.now(),
                requestRender: () => tui.requestRender(),
                close: () => done(undefined),
                confirm: (scope, targetId) =>
                  ctx.ui.confirm(
                    scope === "all" ? "Cancel all subagents?" : "Cancel subagent tree?",
                    scope === "all"
                      ? "This stops every live subagent in the session."
                      : `This stops ${targetId ?? "the selected agent"} and all descendants.`,
                  ),
                cancel: (scope, targetId) =>
                  active.controller.cancel({
                    scope,
                    ...(targetId ? { targetId } : {}),
                  }),
                subscribe: (listener) => active.subscribe!(listener),
              },
              initialId ? { initialId } : {},
            ),
          );
        };
        const previousEditor = ctx.ui.getEditorComponent();
        ctx.ui.setWidget(
          "pi-subagents",
          (tui) => {
            widgetTui = tui;
            return strip;
          },
          { placement: "belowEditor" },
        );
        ctx.ui.setEditorComponent(createStatusEditorFactory(previousEditor, strip));
        disposeTui = () => {
          unsubscribe();
          ctx.ui.setWidget("pi-subagents", undefined);
          ctx.ui.setEditorComponent(previousEditor);
          widgetTui = undefined;
          openDashboard = undefined;
        };
      }
    });

    pi.on("session_shutdown", async (event) => {
      if (!runtime) return;
      if (disposeTui) {
        const dispose = disposeTui;
        disposeTui = undefined;
        dispose();
      }
      cleanup ??= runtime.shutdown(event.reason);
      await cleanup;
    });
  };
}

export default createSubagentExtension();
