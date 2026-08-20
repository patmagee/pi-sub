import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SubagentManager, type ParentContext } from "../src/manager.js";
import type { PiEventReducerSnapshot } from "../src/event-reducer.js";
import type { ProcessHandle, ProcessResult, ProcessRunnerCallbacks, ProcessRunnerInput } from "../src/process-runner.js";
import type { RoleDefinition } from "../src/roles.js";
import type { SubagentConfig } from "../src/types.js";

const emptySnapshot = {
  activity: [],
  diagnostics: [],
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, turns: 0 },
  reasoningEmitted: false,
  reasoningState: "Reasoning was not emitted by the provider.",
};

class FakeRunner {
  readonly started: string[] = [];
  readonly cancelled: string[] = [];
  private readonly processes = new Map<
    string,
    {
      callbacks: ProcessRunnerCallbacks;
      resolve: (result: ProcessResult) => void;
      handle: ProcessHandle;
      completed: boolean;
    }
  >();

  start(input: ProcessRunnerInput, callbacks: ProcessRunnerCallbacks): ProcessHandle {
    const id = input.env.FAKE_AGENT_ID!;
    this.started.push(id);
    let resolve!: (result: ProcessResult) => void;
    const completion = new Promise<ProcessResult>((done) => {
      resolve = done;
    });
    const entry = {
      callbacks,
      resolve,
      completed: false,
      handle: undefined as unknown as ProcessHandle,
    };
    const handle: ProcessHandle = {
      pid: 1000 + this.started.length,
      completion,
      latestSnapshot: structuredClone(emptySnapshot),
      cancel: async () => {
        this.cancelled.push(id);
        return this.finish(id, "cancelled");
      },
    };
    entry.handle = handle;
    this.processes.set(id, entry);
    callbacks.onStart?.(handle.pid);
    return handle;
  }

  finish(id: string, status: ProcessResult["status"] = "completed"): ProcessResult {
    const entry = this.processes.get(id)!;
    const snapshot: PiEventReducerSnapshot = {
      ...structuredClone(emptySnapshot),
    };
    if (status === "completed") snapshot.finalSummary = `summary:${id}`;
    const result: ProcessResult = {
      status,
      exitCode: status === "failed" ? 1 : 0,
      signal: null,
      forced: false,
      stderr: status === "failed" ? "failed" : "",
      stderrTruncated: false,
      snapshot,
    };
    if (!entry.completed) {
      entry.completed = true;
      entry.callbacks.onComplete?.(result);
      entry.resolve(result);
    }
    return result;
  }
}

function config(overrides: Partial<SubagentConfig> = {}): SubagentConfig {
  return { maxAgents: 12, maxConcurrency: 12, maxDepth: 3, maxRetained: 100, cancelGraceMs: 5000, ...overrides };
}

function role(overrides: Partial<RoleDefinition> = {}): RoleDefinition {
  return {
    name: "scout",
    description: "Search",
    systemPrompt: "Search quickly.",
    source: "bundled",
    filePath: "/roles/scout.md",
    ...overrides,
  };
}

const rootContext: ParentContext = {
  name: "orchestrator",
  model: "anthropic/parent",
  effort: "medium",
  permission: "inherit",
  cwd: "/workspace",
  activeTools: ["read", "bash"],
};

function manager(options: {
  config?: SubagentConfig;
  roles?: RoleDefinition[];
  availableModels?: string[];
  runner?: FakeRunner;
  deliveries?: Array<{ parentId?: string; kind: string; text: string; childId?: string }>;
  socket?: { close: () => Promise<void> };
  prepareProcess?: (record: import("../src/types.js").AgentRecord) => Promise<ProcessRunnerInput>;
} = {}) {
  const runner = options.runner ?? new FakeRunner();
  const deliveries = options.deliveries ?? [];
  const socket: { close: () => Promise<void> } = options.socket ?? { close: vi.fn(async () => {}) };
  const instance = new SubagentManager({
    config: options.config ?? config(),
    roles: new Map((options.roles ?? [role()]).map((entry) => [entry.name, entry])),
    processRunner: runner,
    modelAvailable: (model) => (options.availableModels ?? ["anthropic/parent", "anthropic/role", "openai/override"]).includes(model),
    prepareProcess:
      options.prepareProcess ??
      (async (record) => ({
        command: process.execPath,
        args: [],
        cwd: record.cwd,
        env: { ...process.env, FAKE_AGENT_ID: record.id },
        cancelGraceMs: 10,
        cleanup: async () => {},
      })),
    deliverToParent: (parentId, message) => {
      deliveries.push({
        ...(parentId ? { parentId } : {}),
        kind: message.kind,
        text: message.text,
        childId: message.childId,
      });
    },
    controlServer: socket,
  });
  return { instance, runner, deliveries, socket };
}

describe("SubagentManager admission", () => {
  it("returns before completion, starts below concurrency, and schedules queued work", async () => {
    const { instance, runner } = manager({ config: config({ maxConcurrency: 1 }) });
    const first = await instance.start({ name: "first", role: "scout", task: "one" }, rootContext);
    const second = await instance.start({ name: "second", role: "scout", task: "two" }, rootContext);

    expect(first.status).toBe("starting");
    expect(second.status).toBe("queued");
    expect(runner.started).toEqual([first.id]);

    runner.finish(first.id);
    await vi.waitFor(() => expect(runner.started).toEqual([first.id, second.id]));
  });

  it("enforces the live limit and model and effort precedence", async () => {
    const { instance } = manager({
      config: config({ maxAgents: 2, maxConcurrency: 1 }),
      roles: [role({ defaultModel: "anthropic/role", defaultEffort: "high" })],
    });
    const fromRole = await instance.start({ name: "role", role: "scout", task: "one" }, rootContext);
    const overridden = await instance.start(
      { name: "override", role: "scout", task: "two", model: "openai/override", effort: "low" },
      rootContext,
    );

    expect((await instance.inspect({ targetId: fromRole.id, view: "metadata" })).content).toMatchObject({
      effectiveModel: "anthropic/role",
      effectiveEffort: "high",
    });
    expect((await instance.inspect({ targetId: overridden.id, view: "metadata" })).content).toMatchObject({
      effectiveModel: "openai/override",
      effectiveEffort: "low",
    });
    await expect(instance.start({ name: "third", role: "scout", task: "three" }, rootContext)).rejects.toThrow(
      "Live subagent limit reached: 2.",
    );
  });

  it("marks a queued agent failed and notifies its parent exactly once when its launch rejects", async () => {
    let calls = 0;
    const { instance, runner, deliveries } = manager({
      config: config({ maxConcurrency: 1 }),
      prepareProcess: async (record) => {
        calls += 1;
        if (calls >= 2) throw new Error("prepare failed");
        return {
          command: process.execPath,
          args: [],
          cwd: record.cwd,
          env: { ...process.env, FAKE_AGENT_ID: record.id },
          cancelGraceMs: 10,
          cleanup: async () => {},
        };
      },
    });
    const first = await instance.start({ name: "first", role: "scout", task: "one" }, rootContext);
    const second = await instance.start({ name: "second", role: "scout", task: "two" }, rootContext);
    expect(second.status).toBe("queued");

    runner.finish(first.id);

    await vi.waitFor(async () => {
      const record = await instance.inspect({ targetId: second.id, view: "metadata" });
      expect(record.content).toMatchObject({ status: "failed" });
    });
    const failedForSecond = deliveries.filter(
      (delivery) => delivery.kind === "failed" && delivery.childId === second.id,
    );
    expect(failedForSecond).toHaveLength(1);
  });

  it("records an unavailable requested model as a visible failure without launching", async () => {
    const { instance, runner } = manager();
    const receipt = await instance.start(
      { name: "bad-model", role: "scout", task: "inspect", model: "missing/model" },
      rootContext,
    );

    expect(receipt).toMatchObject({ status: "failed", error: 'Requested model "missing/model" is unavailable.' });
    expect(runner.started).toEqual([]);
    expect((await instance.inspect({ targetId: receipt.id, view: "metadata" })).content).toMatchObject({
      status: "failed",
      statusReason: 'Requested model "missing/model" is unavailable.',
    });
  });
});

describe("SubagentManager routing", () => {
  it("routes nested work through parent identity and promotes only explicit updates", async () => {
    const { instance, deliveries } = manager();
    const parent = await instance.start(
      { name: "parent", role: "scout", task: "parent", permission: "read-only" },
      rootContext,
    );
    const parentContext = instance.contextFor(parent.id);
    const child = await instance.start({ name: "child", role: "scout", task: "child" }, parentContext);

    await expect(
      instance.start({ name: "escalate", role: "scout", task: "bad", permission: "inherit" }, parentContext),
    ).rejects.toThrow("A read-only parent cannot grant inherited permission.");
    await expect(
      instance.inspect({ requesterId: child.id, targetId: parent.id, view: "metadata" }),
    ).rejects.toThrow("Agent cannot inspect outside its descendant tree.");

    instance.recordUpdate({ agentId: child.id, text: "dashboard only", promote: false });
    instance.recordUpdate({ agentId: child.id, text: "tell parent", promote: true });
    expect(deliveries).toEqual([
      { parentId: parent.id, kind: "update", text: "tell parent", childId: child.id },
    ]);
    expect((await instance.inspect({ requesterId: parent.id, targetId: child.id, view: "updates" })).content).toHaveLength(2);
  });

  it("enforces depth three for nested routing", async () => {
    const { instance } = manager();
    const one = await instance.start({ name: "one", role: "scout", task: "one" }, rootContext);
    const two = await instance.start({ name: "two", role: "scout", task: "two" }, instance.contextFor(one.id));
    const three = await instance.start({ name: "three", role: "scout", task: "three" }, instance.contextFor(two.id));

    expect(three.depth).toBe(3);
    await expect(
      instance.start({ name: "four", role: "scout", task: "four" }, instance.contextFor(three.id)),
    ).rejects.toThrow("Agent depth limit reached.");
  });
});

describe("SubagentManager session files", () => {
  const temporaryDirectories: string[] = [];
  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it("records the session file for the bound agent and exposes it through summary and session inspection", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-sub-manager-session-"));
    temporaryDirectories.push(directory);
    const sessionFile = join(directory, "child.jsonl");
    await writeFile(sessionFile, "session-header\nline-two\n");

    const { instance } = manager();
    const agent = await instance.start({ name: "scout", role: "scout", task: "one" }, rootContext);
    const other = await instance.start({ name: "other", role: "scout", task: "two" }, rootContext);

    instance.recordSessionFile(agent.id, sessionFile);

    const summary = await instance.inspect({ targetId: agent.id, view: "summary" });
    expect(summary.content).toMatchObject({ sessionFile });
    const otherSummary = await instance.inspect({ targetId: other.id, view: "summary" });
    expect((otherSummary.content as { sessionFile?: string }).sessionFile).toBeUndefined();

    const session = await instance.inspect({ targetId: agent.id, view: "session", limit: 4 });
    expect(session.content).toBe("sess");
    expect(session.truncated).toBe(true);
  });
});

describe("SubagentManager cancellation and shutdown", () => {
  it("cancels descendants before parents and rejects cancellation outside a subtree", async () => {
    const { instance, runner } = manager();
    const parent = await instance.start({ name: "parent", role: "scout", task: "parent" }, rootContext);
    const child = await instance.start({ name: "child", role: "scout", task: "child" }, instance.contextFor(parent.id));
    const grandchild = await instance.start(
      { name: "grandchild", role: "scout", task: "grandchild" },
      instance.contextFor(child.id),
    );
    const unrelated = await instance.start({ name: "unrelated", role: "scout", task: "other" }, rootContext);

    await expect(
      instance.cancel({ requesterId: child.id, targetId: unrelated.id, scope: "one" }),
    ).rejects.toThrow("Agent cannot cancel outside its descendant tree.");
    const result = await instance.cancel({ targetId: parent.id, scope: "tree" });

    expect(result.cancelled).toEqual([grandchild.id, child.id, parent.id]);
    expect(runner.cancelled).toEqual([grandchild.id, child.id, parent.id]);
  });

  it("shuts down idempotently, closes control resources, and rejects new dispatch", async () => {
    const socket = { close: vi.fn(async () => {}) };
    const { instance, runner } = manager({ socket });
    const first = await instance.start({ name: "first", role: "scout", task: "one" }, rootContext);
    const second = await instance.start({ name: "second", role: "scout", task: "two" }, rootContext);

    const initial = instance.shutdown("reload");
    const repeated = instance.shutdown("reload");
    await Promise.all([initial, repeated]);

    expect(runner.cancelled).toEqual(expect.arrayContaining([first.id, second.id]));
    expect(socket.close).toHaveBeenCalledTimes(1);
    await expect(instance.start({ name: "late", role: "scout", task: "late" }, rootContext)).rejects.toThrow(
      "Subagent manager is shutting down.",
    );
  });
});
