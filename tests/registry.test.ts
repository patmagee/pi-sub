import { describe, expect, it } from "vitest";
import { AgentRegistry, type AdmitRequest } from "../src/registry.js";
import type { SubagentConfig } from "../src/types.js";

function config(overrides: Partial<SubagentConfig> = {}): SubagentConfig {
  return {
    maxAgents: 12,
    maxConcurrency: 12,
    maxDepth: 3,
    maxRetained: 100,
    cancelGraceMs: 5000,
    ...overrides,
  };
}

function request(overrides: Partial<AdmitRequest> = {}): AdmitRequest {
  return {
    name: "worker",
    role: "scout",
    task: "Inspect the code.",
    permission: "read-only",
    cwd: "/workspace",
    ...overrides,
  };
}

describe("AgentRegistry admission", () => {
  it("assigns root children depth one and queues work above concurrency", () => {
    const registry = new AgentRegistry(config({ maxConcurrency: 1 }));

    const first = registry.admit(request({ name: "first" }));
    const second = registry.admit(request({ name: "second" }));

    expect(first).toMatchObject({ depth: 1, status: "starting" });
    expect(second).toMatchObject({ depth: 1, status: "queued" });
    expect(registry.liveCount).toBe(2);
    expect(registry.runningCount).toBe(1);
  });

  it("enforces the hard configured depth and parent permission ceiling", () => {
    const registry = new AgentRegistry(config());
    const depthOne = registry.admit(request({ name: "one" }));
    const depthTwo = registry.admit(request({ name: "two", parentId: depthOne.id }));
    const depthThree = registry.admit(request({ name: "three", parentId: depthTwo.id }));

    expect(depthThree.depth).toBe(3);
    expect(() =>
      registry.admit(request({ name: "four", parentId: depthThree.id })),
    ).toThrow("Agent depth limit reached.");
    expect(() =>
      registry.admit(
        request({ name: "escalation", parentId: depthOne.id, permission: "inherit" }),
      ),
    ).toThrow("A read-only parent cannot grant inherited permission.");
  });

  it("rejects a thirteenth live request at the default limit", () => {
    const registry = new AgentRegistry(config());
    for (let index = 1; index <= 12; index += 1) {
      registry.admit(request({ name: `worker-${index}` }));
    }

    expect(() => registry.admit(request({ name: "worker-13" }))).toThrow(
      "Live subagent limit reached: 12.",
    );
  });

  it("frees live capacity after completion but never reuses an allocated name", () => {
    const registry = new AgentRegistry(config({ maxAgents: 1 }));
    const first = registry.admit(request());
    registry.transition(first.id, "running");
    registry.transition(first.id, "completed");

    const second = registry.admit(request());

    expect(second.displayName).toBe("worker-2");
    expect(registry.liveCount).toBe(1);
  });
});

describe("AgentRegistry retention", () => {
  function complete(registry: AgentRegistry, name: string, parentId?: string) {
    const admitted = registry.admit(request({ name, ...(parentId ? { parentId } : {}) }));
    registry.transition(admitted.id, "running");
    registry.transition(admitted.id, "completed");
    return admitted;
  }

  it("prunes the oldest eligible terminal records while keeping live records and protected ancestors", () => {
    const registry = new AgentRegistry(config({ maxRetained: 2 }));
    const ancestor = registry.admit(request({ name: "ancestor" }));
    const liveChild = registry.admit(request({ name: "live-child", parentId: ancestor.id }));
    registry.transition(ancestor.id, "running");
    registry.transition(ancestor.id, "completed");
    const older = complete(registry, "older");
    const newer = complete(registry, "newer");

    const pruned = registry.pruneTerminalRecords();

    expect(pruned).toEqual([older.id]);
    expect(registry.get(older.id)).toBeUndefined();
    expect(registry.get(ancestor.id)).toBeTruthy();
    expect(registry.get(liveChild.id)).toBeTruthy();
    expect(registry.get(newer.id)).toBeTruthy();
  });

  it("keeps a terminal ancestor until its descendants also become terminal", () => {
    const registry = new AgentRegistry(config({ maxRetained: 1 }));
    const ancestor = registry.admit(request({ name: "ancestor" }));
    const child = registry.admit(request({ name: "child", parentId: ancestor.id }));
    registry.transition(ancestor.id, "running");
    registry.transition(ancestor.id, "completed");
    const other = complete(registry, "other");

    expect(registry.pruneTerminalRecords()).toEqual([other.id]);
    expect(registry.get(ancestor.id)).toBeTruthy();

    registry.transition(child.id, "running");
    registry.transition(child.id, "completed");

    expect(registry.pruneTerminalRecords()).toEqual([ancestor.id]);
    expect(registry.get(child.id)).toBeTruthy();
  });
});

describe("AgentRegistry state and snapshots", () => {
  it("allows only legal transitions and records terminal reasons", () => {
    const registry = new AgentRegistry(config());
    const record = registry.admit(request());

    expect(() => registry.transition(record.id, "queued")).toThrow(
      "Illegal agent transition: starting -> queued.",
    );
    registry.transition(record.id, "running");
    const completed = registry.transition(record.id, "completed", "summary received");

    expect(completed.statusReason).toBe("summary received");
    expect(completed.startedAt).toEqual(expect.any(Number));
    expect(completed.finishedAt).toEqual(expect.any(Number));
    expect(() => registry.transition(record.id, "failed")).toThrow(
      "Terminal agent state cannot change: completed.",
    );
  });

  it("returns deep copies and traverses hierarchy by identifier", () => {
    const registry = new AgentRegistry(config());
    const parent = registry.admit(request({ name: "parent" }));
    const child = registry.admit(request({ name: "child", parentId: parent.id }));
    const grandchild = registry.admit(request({ name: "grandchild", parentId: child.id }));

    const snapshot = registry.get(parent.id)!;
    snapshot.updates.push({ text: "mutated", promote: false, createdAt: 0 });

    expect(registry.get(parent.id)?.updates).toEqual([]);
    expect(registry.descendantsOf(parent.id).map((record) => record.id)).toEqual([
      child.id,
      grandchild.id,
    ]);
    expect(registry.list()).toHaveLength(3);
  });
});
