import { describe, expect, it, vi } from "vitest";
import {
  createChildRuntime,
  createSubagentExtension,
  sendParentDelivery,
  type SessionRuntime,
  type SubagentExtensionDependencies,
} from "../index.js";
import type { DispatchCatalog } from "../src/dispatch-catalog.js";
import type { SubagentToolController } from "../src/tools.js";

const dispatchCatalog: DispatchCatalog = {
  roles: [{ name: "generic", description: "General work", source: "bundled" }],
  models: ["anthropic/parent"],
};

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
    ui: {
      notify: vi.fn(),
      setWidget: vi.fn(),
      getEditorComponent: vi.fn<() => any>(() => undefined),
      setEditorComponent: vi.fn(),
      custom: vi.fn(async () => undefined),
      confirm: vi.fn(async () => true),
      theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
    },
    model: { provider: "anthropic", id: "parent" },
    thinkingLevel: "medium",
    scopedModels: [],
    modelRegistry: {
      find: vi.fn(() => ({})),
      getAvailable: vi.fn(() => [{ provider: "anthropic", id: "parent" }]),
    },
    sessionManager: {
      getSessionId: () => "root-session",
      getSessionFile: () => "/sessions/child-session.jsonl",
    },
  };
}

function runtime(): SessionRuntime {
  return {
    controller: controller(),
    catalog: dispatchCatalog,
    shutdown: vi.fn(async () => {}),
    diagnostics: [],
  };
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
      catalog: dispatchCatalog,
      shutdown: vi.fn(async () => {}),
      diagnostics: ["bad role"],
    });
    createSubagentExtension(configured.dependencies)(pi as never);
    const ctx = context(false);

    expect(pi.tools).toEqual([]);
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

  it("installs root TUI composition and removes it during shutdown", async () => {
    const pi = fakePi();
    const configured = dependencies();
    const session = runtime();
    session.subscribe = (listener) => {
      listener([]);
      return vi.fn();
    };
    configured.root.mockResolvedValue(session);
    createSubagentExtension(configured.dependencies)(pi as never);
    const ctx = context();
    const previousEditor = vi.fn();
    ctx.ui.getEditorComponent.mockReturnValue(previousEditor);

    await pi.fire("session_start", { reason: "startup" }, ctx);

    expect(ctx.ui.setWidget).toHaveBeenCalledWith(
      "pi-subagents",
      expect.any(Function),
      { placement: "belowEditor" },
    );
    expect(ctx.ui.setEditorComponent).toHaveBeenCalledWith(expect.any(Function));
    await pi.commands.get("subagents").handler("", ctx);
    expect(ctx.ui.custom).toHaveBeenCalled();

    await pi.fire("session_shutdown", { reason: "reload" }, ctx);
    expect(ctx.ui.setWidget).toHaveBeenLastCalledWith("pi-subagents", undefined);
    expect(ctx.ui.setEditorComponent).toHaveBeenLastCalledWith(previousEditor);
  });

  it("does not install custom components outside TUI mode", async () => {
    const pi = fakePi();
    const configured = dependencies();
    const session = runtime();
    session.subscribe = () => vi.fn();
    configured.root.mockResolvedValue(session);
    createSubagentExtension(configured.dependencies)(pi as never);
    const ctx = context();
    ctx.mode = "print";

    await pi.fire("session_start", { reason: "startup" }, ctx);

    expect(ctx.ui.setWidget).not.toHaveBeenCalled();
    expect(ctx.ui.setEditorComponent).not.toHaveBeenCalled();
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

describe("child parent delivery", () => {
  it("routes unsolicited parent messages into the child context and disposes the subscription before close", async () => {
    const pi = fakePi();
    let push: ((message: any) => void) | undefined;
    const unsubscribe = vi.fn();
    const close = vi.fn();
    const fakeClient = {
      request: vi.fn(async (message: any) => ({
        v: 1,
        type: "catalog_result",
        requestId: message.requestId,
        catalog: dispatchCatalog,
      })),
      send: vi.fn(),
      subscribeParentMessages: vi.fn((listener: (message: any) => void) => {
        push = listener;
        return unsubscribe;
      }),
      close,
    };
    const session = await createChildRuntime(
      {
        pi: pi as never,
        ctx: context() as never,
        environment: {
          PI_SUB_ROOT_SOCKET: "/tmp/root.sock",
          PI_SUB_ROOT_TOKEN: "token",
          PI_SUB_AGENT_ID: "agent-1",
        },
        projectTrusted: true,
      },
      { connect: async () => fakeClient as never },
    );

    expect(fakeClient.request).toHaveBeenCalledWith(
      expect.objectContaining({ type: "catalog", requesterId: "agent-1" }),
    );
    expect(session.catalog).toEqual(dispatchCatalog);
    expect(fakeClient.subscribeParentMessages).toHaveBeenCalledTimes(1);
    expect(fakeClient.send).toHaveBeenCalledWith({
      v: 1,
      type: "session_ready",
      agentId: "agent-1",
      sessionFile: "/sessions/child-session.jsonl",
    });

    push!({ v: 1, type: "parent_message", agentId: "agent-1", childId: "child-2", kind: "update", text: "progress" });
    push!({
      v: 1,
      type: "parent_message",
      agentId: "agent-1",
      childId: "child-2",
      kind: "complete",
      text: "done",
      sessionFile: "/sessions/child.jsonl",
    });

    expect(pi.messages).toEqual([
      expect.objectContaining({
        message: expect.objectContaining({ customType: "subagent-update", content: "progress" }),
        options: { deliverAs: "steer", triggerTurn: true },
      }),
      expect.objectContaining({
        message: expect.objectContaining({ customType: "subagent-complete", content: "done" }),
        options: { deliverAs: "followUp", triggerTurn: true },
      }),
    ]);

    await session.shutdown("quit");
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(unsubscribe.mock.invocationCallOrder[0]!).toBeLessThan(close.mock.invocationCallOrder[0]!);
  });
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
