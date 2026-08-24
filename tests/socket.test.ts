import { access, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RootSocketClient } from "../src/socket-client.js";
import { RootSocketServer } from "../src/socket-server.js";
import type { ControlMessage } from "../src/protocol.js";

const temporaryDirectories: string[] = [];

async function socketParent(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-sub-socket-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("root socket server and client", () => {
  it("authenticates, correlates requests, bounds inspection, and delivers parent messages", async () => {
    const parent = await socketParent();
    const updates: ControlMessage[] = [];
    let disconnected = false;
    const server = await RootSocketServer.start({
      socketParentDir: parent,
      authenticateAgent: (agentId) => agentId === "agent-1",
      onDisconnect: () => {
        disconnected = true;
      },
      onMessage: async (message) => {
        if (message.type === "catalog") {
          return {
            v: 1,
            type: "catalog_result",
            requestId: message.requestId,
            catalog: {
              roles: [{ name: "generic", description: "General work", source: "bundled" }],
              models: ["anthropic/claude-opus-4-8"],
            },
          };
        }
        if (message.type === "dispatch") {
          return {
            v: 1,
            type: "dispatch_result",
            requestId: message.requestId,
            receipt: { id: "child-1", displayName: "child", status: "starting", depth: 2 },
          };
        }
        if (message.type === "inspect") {
          return {
            v: 1,
            type: "inspect_result",
            requestId: message.requestId,
            result: {
              view: message.view,
              targetId: message.targetId,
              content: "bounded",
              offset: message.offset ?? 0,
            },
          };
        }
        if (message.type === "update") updates.push(message);
        return undefined;
      },
    });

    expect((await stat(server.socketDirectory)).mode & 0o777).toBe(0o700);
    const client = await RootSocketClient.connect({
      socketPath: server.socketPath,
      token: server.issueCredential("agent-1"),
      agentId: "agent-1",
    });

    await expect(
      client.request({
        v: 1,
        type: "catalog",
        requestId: "catalog-1",
        requesterId: "agent-1",
      }),
    ).resolves.toMatchObject({
      type: "catalog_result",
      catalog: { models: ["anthropic/claude-opus-4-8"] },
    });
    await expect(
      client.request({
        v: 1,
        type: "dispatch",
        requestId: "dispatch-1",
        parentId: "agent-1",
        input: { name: "child", role: "scout", task: "inspect" },
      }),
    ).resolves.toMatchObject({ type: "dispatch_result", requestId: "dispatch-1" });
    await expect(
      client.request({
        v: 1,
        type: "inspect",
        requestId: "inspect-1",
        requesterId: "agent-1",
        targetId: "child-1",
        view: "session",
        offset: 5,
        limit: 50 * 1024,
      }),
    ).resolves.toMatchObject({
      type: "inspect_result",
      result: { content: "bounded", offset: 5 },
    });

    client.send({
      v: 1,
      type: "update",
      agentId: "agent-1",
      text: "important",
      promote: true,
    });
    await vi.waitFor(() => expect(updates).toHaveLength(1));

    const parentMessage = new Promise<ControlMessage>((resolve) => {
      client.subscribeParentMessages(resolve);
    });
    server.sendParentMessage({
      v: 1,
      type: "parent_message",
      agentId: "agent-1",
      childId: "child-1",
      kind: "complete",
      text: "done",
    });
    await expect(parentMessage).resolves.toMatchObject({ type: "parent_message", text: "done" });

    client.close();
    await vi.waitFor(() => expect(disconnected).toBe(true));
    const socketPath = server.socketPath;
    await server.close();
    await expect(access(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("binds each credential to a single agent identity", async () => {
    const admitted = new Set(["agent-1", "agent-2", "parent-1", "child-1"]);
    const server = await RootSocketServer.start({
      socketParentDir: await socketParent(),
      authenticateAgent: (agentId) => admitted.has(agentId),
      onMessage: async (message) =>
        message.type === "dispatch"
          ? {
              v: 1,
              type: "dispatch_result",
              requestId: message.requestId,
              receipt: { id: "child", displayName: "child", status: "starting", depth: 2 },
            }
          : undefined,
    });

    const agentCredential = server.issueCredential("agent-1");
    server.issueCredential("agent-2");
    server.issueCredential("parent-1");
    const childCredential = server.issueCredential("child-1");

    const issued = await RootSocketClient.connect({
      socketPath: server.socketPath,
      token: agentCredential,
      agentId: "agent-1",
    });
    await expect(
      issued.request({
        v: 1,
        type: "dispatch",
        requestId: "ok",
        parentId: "agent-1",
        input: { name: "child", role: "scout", task: "inspect" },
      }),
    ).resolves.toMatchObject({ type: "dispatch_result", requestId: "ok" });
    issued.close();

    const sibling = await RootSocketClient.connect({
      socketPath: server.socketPath,
      token: agentCredential,
      agentId: "agent-2",
    });
    await expect(
      sibling.request({
        v: 1,
        type: "dispatch",
        requestId: "sibling",
        parentId: "agent-2",
        input: { name: "child", role: "scout", task: "inspect" },
      }),
    ).rejects.toThrow("Root control socket closed.");

    const child = await RootSocketClient.connect({
      socketPath: server.socketPath,
      token: childCredential,
      agentId: "parent-1",
    });
    await expect(
      child.request({
        v: 1,
        type: "dispatch",
        requestId: "escalate",
        parentId: "parent-1",
        input: { name: "child", role: "scout", task: "inspect" },
      }),
    ).rejects.toThrow("Root control socket closed.");

    const ghostCredential = server.issueCredential("ghost-1");
    const ghost = await RootSocketClient.connect({
      socketPath: server.socketPath,
      token: ghostCredential,
      agentId: "ghost-1",
    });
    await expect(
      ghost.request({
        v: 1,
        type: "dispatch",
        requestId: "ghost",
        parentId: "ghost-1",
        input: { name: "child", role: "scout", task: "inspect" },
      }),
    ).rejects.toThrow("Root control socket closed.");

    server.revokeCredential("agent-1");
    const revoked = await RootSocketClient.connect({
      socketPath: server.socketPath,
      token: agentCredential,
      agentId: "agent-1",
    });
    await expect(
      revoked.request({
        v: 1,
        type: "dispatch",
        requestId: "after-revoke",
        parentId: "agent-1",
        input: { name: "child", role: "scout", task: "inspect" },
      }),
    ).rejects.toThrow("Root control socket closed.");

    await server.close();
  });

  it("rejects catalogue identity spoofing across bound connections", async () => {
    const server = await RootSocketServer.start({
      socketParentDir: await socketParent(),
      authenticateAgent: (agentId) => agentId === "agent-1",
      onMessage: async () => undefined,
    });

    const client = await RootSocketClient.connect({
      socketPath: server.socketPath,
      token: server.issueCredential("agent-1"),
      agentId: "agent-1",
    });
    await expect(
      client.request({
        v: 1,
        type: "catalog",
        requestId: "catalog-spoof",
        requesterId: "agent-2",
      }),
    ).resolves.toMatchObject({
      type: "catalog_result",
      error: "Control connection identity does not match requesterId.",
    });

    client.close();
    await server.close();
  });

  it("rejects identity spoofing across bound connections", async () => {
    const server = await RootSocketServer.start({
      socketParentDir: await socketParent(),
      authenticateAgent: (agentId) => agentId === "agent-1",
      onMessage: async () => undefined,
    });

    const client = await RootSocketClient.connect({
      socketPath: server.socketPath,
      token: server.issueCredential("agent-1"),
      agentId: "agent-1",
    });
    await expect(
      client.request({
        v: 1,
        type: "dispatch",
        requestId: "spoof",
        parentId: "agent-2",
        input: { name: "child", role: "scout", task: "inspect" },
      }),
    ).resolves.toMatchObject({
      type: "dispatch_result",
      error: "Control connection identity does not match parentId.",
    });

    client.close();
    await server.close();
  });

  it("supports request aborts and rejects pending requests on close", async () => {
    const server = await RootSocketServer.start({
      socketParentDir: await socketParent(),
      authenticateAgent: () => true,
      onMessage: async () => new Promise<never>(() => {}),
    });
    const client = await RootSocketClient.connect({
      socketPath: server.socketPath,
      token: server.issueCredential("agent-1"),
      agentId: "agent-1",
    });

    const abort = new AbortController();
    const aborted = client.request(
      {
        v: 1,
        type: "inspect",
        requestId: "aborted",
        requesterId: "agent-1",
        targetId: "child",
        view: "metadata",
      },
      abort.signal,
    );
    abort.abort();
    await expect(aborted).rejects.toMatchObject({ name: "AbortError" });

    const pending = client.request({
      v: 1,
      type: "cancel",
      requestId: "pending",
      requesterId: "agent-1",
      targetId: "child",
      scope: "one",
    });
    client.close();
    await expect(pending).rejects.toThrow("Root control socket closed.");
    await server.close();
  });
});
