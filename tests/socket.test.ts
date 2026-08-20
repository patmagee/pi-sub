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
      token: server.token,
      agentId: "agent-1",
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

  it("rejects invalid tokens and identity spoofing", async () => {
    const server = await RootSocketServer.start({
      socketParentDir: await socketParent(),
      authenticateAgent: (agentId) => agentId === "agent-1",
      onMessage: async () => undefined,
    });

    const invalid = await RootSocketClient.connect({
      socketPath: server.socketPath,
      token: "wrong-token",
      agentId: "agent-1",
    });
    await expect(
      invalid.request({
        v: 1,
        type: "cancel",
        requestId: "bad-auth",
        requesterId: "agent-1",
        targetId: "agent-1",
        scope: "one",
      }),
    ).rejects.toThrow("Root control socket closed.");

    const client = await RootSocketClient.connect({
      socketPath: server.socketPath,
      token: server.token,
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
      token: server.token,
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
