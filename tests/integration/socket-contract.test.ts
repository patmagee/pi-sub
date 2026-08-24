import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildDispatchCatalog } from "../../src/dispatch-catalog.js";
import {
  SubagentManager,
  type ParentContext,
  type ParentDelivery,
} from "../../src/manager.js";
import { ProcessRunner } from "../../src/process-runner.js";
import type { ControlMessage } from "../../src/protocol.js";
import type { RoleDefinition } from "../../src/roles.js";
import { RootSocketClient } from "../../src/socket-client.js";
import { RootSocketServer } from "../../src/socket-server.js";
import type { SubagentConfig } from "../../src/types.js";

const fakePi = fileURLToPath(new URL("../helpers/fake-pi.mjs", import.meta.url));
const temporaryDirectories: string[] = [];
const liveClients: RootSocketClient[] = [];

afterEach(async () => {
  for (const client of liveClients.splice(0)) {
    try {
      client.close();
    } catch {
      // Client may already be closed by a shutdown assertion.
    }
  }
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function config(): SubagentConfig {
  return { maxAgents: 12, maxConcurrency: 12, maxDepth: 3, maxRetained: 100, cancelGraceMs: 300 };
}

const scoutRole: RoleDefinition = {
  name: "scout",
  description: "Search",
  systemPrompt: "Search quickly.",
  defaultPermission: "read-only",
  source: "bundled",
  filePath: "/roles/scout.md",
};

const rootContext: ParentContext = {
  name: "orchestrator",
  permission: "inherit",
  cwd: process.cwd(),
  activeTools: ["read"],
};

function behaviorFor(task: string): string {
  if (task.includes("provider-error")) return "provider-error";
  if (task.includes("stay-alive")) return "slow";
  return "complete";
}

async function connectAs(server: RootSocketServer, agentId: string, token: string): Promise<RootSocketClient> {
  const client = await RootSocketClient.connect({ socketPath: server.socketPath, token, agentId });
  liveClients.push(client);
  return client;
}

interface Harness {
  server: RootSocketServer;
  manager: SubagentManager;
  rootDeliveries: ParentDelivery[];
  credentials: Map<string, string>;
}

async function harness(): Promise<Harness> {
  const socketParentDir = await mkdtemp(join(tmpdir(), "pi-sub-contract-"));
  temporaryDirectories.push(socketParentDir);
  const rootDeliveries: ParentDelivery[] = [];
  const credentials = new Map<string, string>();
  const roles = new Map([[scoutRole.name, scoutRole]]);
  const catalog = buildDispatchCatalog({ roles, scopedModels: [], availableModels: [] });

  let manager: SubagentManager;
  const server = await RootSocketServer.start({
    socketParentDir,
    authenticateAgent: (agentId) => {
      try {
        manager.contextFor(agentId);
        return true;
      } catch {
        return false;
      }
    },
    onMessage: async (message, boundAgentId): Promise<ControlMessage | undefined> => {
      if (message.type === "catalog") {
        return { v: 1, type: "catalog_result", requestId: message.requestId, catalog };
      }
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
      if (message.type === "session_ready") {
        manager.recordSessionFile(boundAgentId, message.sessionFile);
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
    },
  });

  manager = new SubagentManager({
    config: config(),
    roles,
    catalog,
    processRunner: new ProcessRunner(),
    prepareProcess: async (record) => {
      const token = server.issueCredential(record.id);
      credentials.set(record.id, token);
      return {
        command: process.execPath,
        args: [fakePi],
        cwd: record.cwd,
        env: {
          ...process.env,
          FAKE_PI_BEHAVIOR: behaviorFor(record.task),
          PI_SUB_ROOT_SOCKET: server.socketPath,
          PI_SUB_ROOT_TOKEN: token,
          PI_SUB_AGENT_ID: record.id,
        },
        cancelGraceMs: config().cancelGraceMs,
        cleanup: async () => {},
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
        rootDeliveries.push(delivery);
      }
    },
    controlServer: server,
  });

  return { server, manager, rootDeliveries, credentials };
}

describe("recursive subagent integration contract", () => {
  it("carries dispatch, updates, recursive delivery, inspection, and cleanup end to end", async () => {
    const { server, manager, rootDeliveries, credentials } = await harness();

    const child = await manager.start(
      { name: "child", role: "scout", task: "stay-alive and coordinate" },
      rootContext,
    );
    expect(child.status).toBe("starting");
    await vi.waitFor(async () => {
      const meta = await manager.inspect({ targetId: child.id, view: "metadata" });
      expect(meta.content).toMatchObject({ status: "running" });
      expect((meta.content as { pid?: number }).pid).toEqual(expect.any(Number));
    });
    const childPid = ((await manager.inspect({ targetId: child.id, view: "metadata" })).content as {
      pid?: number;
    }).pid!;

    const childClient = await connectAs(server, child.id, credentials.get(child.id)!);
    const parentMessages: ControlMessage[] = [];
    childClient.subscribeParentMessages((message) => parentMessages.push(message));

    childClient.send({ v: 1, type: "update", agentId: child.id, text: "found the entry point", promote: true });
    await vi.waitFor(() =>
      expect(rootDeliveries.some((delivery) => delivery.kind === "update" && delivery.childId === child.id)).toBe(
        true,
      ),
    );

    const grandchildResponse = await childClient.request({
      v: 1,
      type: "dispatch",
      requestId: randomUUID(),
      parentId: child.id,
      input: { name: "grandchild", role: "scout", task: "complete the sweep" },
    });
    expect(grandchildResponse.type).toBe("dispatch_result");
    const grandchildId = grandchildResponse.type === "dispatch_result" ? grandchildResponse.receipt!.id : "";
    expect(grandchildId).toBeTruthy();

    await vi.waitFor(() =>
      expect(
        parentMessages.some(
          (message) =>
            message.type === "parent_message" && message.childId === grandchildId && message.kind === "complete",
        ),
      ).toBe(true),
    );

    const grandchildSummary = await childClient.request({
      v: 1,
      type: "inspect",
      requestId: randomUUID(),
      requesterId: child.id,
      targetId: grandchildId,
      view: "summary",
    });
    expect(grandchildSummary.type === "inspect_result" && grandchildSummary.result?.content).toMatchObject({
      status: "completed",
      finalSummary: "Fake child completed.",
    });

    const bigDirectory = await mkdtemp(join(tmpdir(), "pi-sub-session-"));
    temporaryDirectories.push(bigDirectory);
    const bigSession = join(bigDirectory, "child.jsonl");
    await writeFile(bigSession, "x".repeat(64 * 1024));
    childClient.send({ v: 1, type: "session_ready", agentId: child.id, sessionFile: bigSession });
    await vi.waitFor(async () => {
      const summary = await manager.inspect({ targetId: child.id, view: "summary" });
      expect((summary.content as { sessionFile?: string }).sessionFile).toBe(bigSession);
    });
    const sessionSlice = await manager.inspect({ targetId: child.id, view: "session", limit: 8 });
    expect(sessionSlice.truncated).toBe(true);
    expect(sessionSlice.nextOffset).toBe(8);

    const socketDirectory = server.socketDirectory;
    await manager.shutdown("quit");

    expect(() => process.kill(childPid, 0)).toThrow();
    await expect(
      RootSocketClient.connect({ socketPath: server.socketPath, token: credentials.get(child.id)!, agentId: child.id }),
    ).rejects.toBeTruthy();
    await expect(
      rm(join(socketDirectory, "control.sock")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);

  it("fails an exit-zero provider error instead of reporting an empty completed summary", async () => {
    const { manager, rootDeliveries } = await harness();

    const agent = await manager.start(
      { name: "denied", role: "scout", task: "provider-error path" },
      rootContext,
    );

    await vi.waitFor(() =>
      expect(rootDeliveries.some((delivery) => delivery.kind === "failed" && delivery.childId === agent.id)).toBe(
        true,
      ),
    );
    const failure = rootDeliveries.find(
      (delivery) => delivery.kind === "failed" && delivery.childId === agent.id,
    )!;
    expect(failure.text).toContain("provider denied the request");
    const meta = await manager.inspect({ targetId: agent.id, view: "metadata" });
    expect(meta.content).toMatchObject({ status: "failed" });
    expect((meta.content as { statusReason?: string }).statusReason).toContain(
      "provider denied the request",
    );
    expect((meta.content as { finalSummary?: string }).finalSummary).toBeUndefined();

    await manager.shutdown("quit");
  }, 30_000);
});
