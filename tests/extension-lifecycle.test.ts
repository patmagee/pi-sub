import { describe, expect, it, vi } from "vitest";
import {
  createSubagentExtension,
  sendParentDelivery,
  type SessionRuntime,
  type SubagentExtensionDependencies,
} from "../index.js";
import type { SubagentToolController } from "../src/tools.js";

function controller(): SubagentToolController {
  return {
    start: vi.fn(),
    update: vi.fn(),
    inspect: vi.fn(),
    cancel: vi.fn(),
  };
}

function fakePi() {
  const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
  return {
    handlers,
    tools: [] as any[],
    commands: new Map<string, any>(),
    renderers: new Map<string, any>(),
    messages: [] as any[],
    on(name: string, handler: (event: any, ctx: any) => unknown) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
    registerTool(tool: any) {
      this.tools.push(tool);
    },
    registerCommand(name: string, command: any) {
      this.commands.set(name, command);
    },
    registerMessageRenderer(name: string, renderer: any) {
      this.renderers.set(name, renderer);
    },
    sendMessage(message: any, options: any) {
      this.messages.push({ message, options });
    },
    getActiveTools: () => ["read", "bash"],
    getThinkingLevel: () => "medium",
    async fire(name: string, event: any, ctx: any) {
      for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
    },
  };
}

function context(trusted = true) {
  return {
    cwd: "/workspace",
    mode: "tui",
    hasUI: true,
    isProjectTrusted: vi.fn(() => trusted),
    ui: { notify: vi.fn() },
    model: { provider: "anthropic", id: "parent" },
    thinkingLevel: "medium",
    modelRegistry: { find: vi.fn(() => ({})) },
    sessionManager: { getSessionId: () => "root-session" },
  };
}

function runtime(): SessionRuntime {
  return { controller: controller(), shutdown: vi.fn(async () => {}), diagnostics: [] };
}

function dependencies(environment: NodeJS.ProcessEnv = {}): {
  dependencies: SubagentExtensionDependencies;
  root: ReturnType<typeof vi.fn>;
  child: ReturnType<typeof vi.fn>;
} {
  const root = vi.fn(async (): Promise<SessionRuntime> => runtime());
  const child = vi.fn(async (): Promise<SessionRuntime> => runtime());
  return {
    root,
    child,
    dependencies: {
      environment: () => environment,
      createRootRuntime: root,
      createChildRuntime: child,
    },
  };
}

describe("extension lifecycle", () => {
  it("creates only a root runtime and forwards project trust and visible diagnostics", async () => {
    const pi = fakePi();
    const configured = dependencies();
    configured.root.mockResolvedValue({
      controller: controller(),
      shutdown: vi.fn(async () => {}),
      diagnostics: ["bad role"],
    });
    createSubagentExtension(configured.dependencies)(pi as never);
    const ctx = context(false);

    await pi.fire("session_start", { reason: "startup" }, ctx);

    expect(configured.root).toHaveBeenCalledWith(expect.objectContaining({ projectTrusted: false }));
    expect(configured.child).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith("bad role", "warning");
    expect(pi.tools.map((tool) => tool.name)).toEqual([
      "subagent_start",
      "subagent_update",
      "subagent_inspect",
      "subagent_cancel",
    ]);
  });

  it("creates only a child socket runtime when root environment is present", async () => {
    const pi = fakePi();
    const env = {
      PI_SUB_ROOT_SOCKET: "/tmp/root.sock",
      PI_SUB_ROOT_TOKEN: "token",
      PI_SUB_AGENT_ID: "agent-1",
      PI_SUB_PARENT_ID: "root",
      PI_SUB_DEPTH: "1",
      PI_SUB_ROOT_SESSION_ID: "root-session",
    };
    const configured = dependencies(env);
    createSubagentExtension(configured.dependencies)(pi as never);

    await pi.fire("session_start", { reason: "startup" }, context());

    expect(configured.child).toHaveBeenCalledWith(expect.objectContaining({ environment: env }));
    expect(configured.root).not.toHaveBeenCalled();
  });

  it.each(["quit", "reload", "new", "resume", "fork"])(
    "disposes session resources for %s",
    async (reason) => {
      const pi = fakePi();
      const session = runtime();
      const configured = dependencies();
      configured.root.mockResolvedValue(session);
      createSubagentExtension(configured.dependencies)(pi as never);
      const ctx = context();
      await pi.fire("session_start", { reason: "startup" }, ctx);

      await pi.fire("session_shutdown", { reason }, ctx);
      await pi.fire("session_shutdown", { reason }, ctx);

      expect(session.shutdown).toHaveBeenCalledTimes(1);
      expect(session.shutdown).toHaveBeenCalledWith(reason);
    },
  );
});

describe("parent delivery", () => {
  it("uses steering for updates and follow-up delivery for completion", () => {
    const pi = fakePi();
    sendParentDelivery(pi as never, {
      childId: "child-1",
      kind: "update",
      text: "finding",
    });
    sendParentDelivery(pi as never, {
      childId: "child-1",
      kind: "complete",
      text: "summary",
      sessionFile: "/sessions/child.jsonl",
    });

    expect(pi.messages).toEqual([
      expect.objectContaining({
        message: expect.objectContaining({ customType: "subagent-update", content: "finding" }),
        options: { deliverAs: "steer", triggerTurn: true },
      }),
      expect.objectContaining({
        message: expect.objectContaining({ customType: "subagent-complete", content: "summary" }),
        options: { deliverAs: "followUp", triggerTurn: true },
      }),
    ]);
  });
});
