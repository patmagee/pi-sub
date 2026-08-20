import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  encodeFrame,
  FrameDecoder,
  type ControlMessage,
} from "./protocol.js";

type ClientMessage = Extract<
  ControlMessage,
  { type: "dispatch" | "update" | "inspect" | "cancel" }
>;
type ParentMessage = Extract<ControlMessage, { type: "parent_message" }>;

export interface RootSocketServerOptions {
  socketParentDir?: string;
  authenticateAgent: (agentId: string) => boolean | Promise<boolean>;
  onMessage: (
    message: ClientMessage,
    boundAgentId: string,
  ) => ControlMessage | undefined | Promise<ControlMessage | undefined>;
  onDisconnect?: (agentId: string) => void;
}

interface ConnectionState {
  socket: Socket;
  decoder: FrameDecoder;
  boundAgentId?: string;
  processing: Promise<void>;
}

function responseError(message: ClientMessage, error: string): ControlMessage | undefined {
  switch (message.type) {
    case "dispatch":
      return { v: 1, type: "dispatch_result", requestId: message.requestId, error };
    case "inspect":
      return { v: 1, type: "inspect_result", requestId: message.requestId, error };
    case "cancel":
      return { v: 1, type: "cancel_result", requestId: message.requestId, cancelled: [], error };
    case "update":
      return undefined;
  }
}

function identityField(message: ClientMessage): "parentId" | "agentId" | "requesterId" {
  if (message.type === "dispatch") return "parentId";
  if (message.type === "update") return "agentId";
  return "requesterId";
}

function identityValue(message: ClientMessage): string {
  if (message.type === "dispatch") return message.parentId;
  if (message.type === "update") return message.agentId;
  return message.requesterId;
}

export class RootSocketServer {
  readonly token = randomBytes(32).toString("hex");
  readonly socketDirectory: string;
  readonly socketPath: string;

  private readonly connections = new Set<ConnectionState>();
  private readonly agents = new Map<string, ConnectionState>();
  private closed = false;

  private constructor(
    private readonly server: Server,
    private readonly options: RootSocketServerOptions,
    socketDirectory: string,
  ) {
    this.socketDirectory = socketDirectory;
    this.socketPath = join(socketDirectory, "control.sock");
  }

  static async start(options: RootSocketServerOptions): Promise<RootSocketServer> {
    const parent = options.socketParentDir ?? tmpdir();
    await mkdir(parent, { recursive: true });
    const socketDirectory = await mkdtemp(join(parent, "pi-sub-"));
    await chmod(socketDirectory, 0o700);

    const server = createServer();
    const instance = new RootSocketServer(server, options, socketDirectory);
    server.on("connection", (socket) => instance.accept(socket));

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        server.once("error", onError);
        server.listen(instance.socketPath, () => {
          server.off("error", onError);
          resolve();
        });
      });
      await chmod(instance.socketPath, 0o600);
      return instance;
    } catch (error) {
      await rm(socketDirectory, { recursive: true, force: true });
      throw error;
    }
  }

  sendParentMessage(message: ParentMessage): boolean {
    const connection = this.agents.get(message.agentId);
    if (!connection || connection.socket.destroyed) return false;
    connection.socket.write(encodeFrame(message));
    return true;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const connection of this.connections) connection.socket.destroy();

    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
    await rm(this.socketDirectory, { recursive: true, force: true });
  }

  private accept(socket: Socket): void {
    const state: ConnectionState = {
      socket,
      decoder: new FrameDecoder(),
      processing: Promise.resolve(),
    };
    this.connections.add(state);

    socket.on("data", (chunk) => {
      state.processing = state.processing
        .then(async () => {
          const messages = state.decoder.push(chunk);
          for (const message of messages) await this.handleMessage(state, message);
        })
        .catch(() => {
          socket.destroy();
        });
    });
    socket.on("error", () => socket.destroy());
    socket.once("close", () => this.disconnect(state));
  }

  private async handleMessage(state: ConnectionState, message: ControlMessage): Promise<void> {
    if (!state.boundAgentId) {
      if (message.type !== "hello") {
        state.socket.destroy();
        return;
      }
      const expected = Buffer.from(this.token, "utf8");
      const received = Buffer.from(message.token, "utf8");
      if (
        expected.byteLength !== received.byteLength ||
        !timingSafeEqual(expected, received) ||
        !(await this.options.authenticateAgent(message.agentId))
      ) {
        state.socket.destroy();
        return;
      }

      const previous = this.agents.get(message.agentId);
      if (previous && previous !== state) previous.socket.destroy();
      state.boundAgentId = message.agentId;
      this.agents.set(message.agentId, state);
      return;
    }

    if (
      message.type !== "dispatch" &&
      message.type !== "update" &&
      message.type !== "inspect" &&
      message.type !== "cancel"
    ) {
      state.socket.destroy();
      return;
    }

    if (identityValue(message) !== state.boundAgentId) {
      const field = identityField(message);
      const response = responseError(
        message,
        `Control connection identity does not match ${field}.`,
      );
      if (response) state.socket.write(encodeFrame(response));
      return;
    }

    try {
      const response = await this.options.onMessage(message, state.boundAgentId);
      if (response) state.socket.write(encodeFrame(response));
    } catch (error) {
      const response = responseError(message, error instanceof Error ? error.message : String(error));
      if (response) state.socket.write(encodeFrame(response));
    }
  }

  private disconnect(state: ConnectionState): void {
    if (!this.connections.delete(state)) return;
    if (state.boundAgentId && this.agents.get(state.boundAgentId) === state) {
      this.agents.delete(state.boundAgentId);
      this.options.onDisconnect?.(state.boundAgentId);
    }
  }
}
