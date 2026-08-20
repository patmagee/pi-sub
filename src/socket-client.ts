import { createConnection, type Socket } from "node:net";
import {
  encodeFrame,
  FrameDecoder,
  type ControlMessage,
} from "./protocol.js";

type RequestMessage = Extract<ControlMessage, { type: "dispatch" | "inspect" | "cancel" }>;
type ResponseMessage = Extract<
  ControlMessage,
  { type: "dispatch_result" | "inspect_result" | "cancel_result" }
>;
type UpdateMessage = Extract<ControlMessage, { type: "update" | "session_ready" }>;
type ParentMessage = Extract<ControlMessage, { type: "parent_message" }>;

export interface RootSocketClientOptions {
  socketPath: string;
  token: string;
  agentId: string;
}

interface PendingRequest {
  resolve: (message: ResponseMessage) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  abortListener?: () => void;
}

function abortError(): Error {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

export class RootSocketClient {
  private readonly decoder = new FrameDecoder();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly subscribers = new Set<(message: ParentMessage) => void>();
  private closed = false;

  private constructor(private readonly socket: Socket) {
    socket.on("data", (chunk) => this.receive(chunk));
    socket.on("error", () => this.failPending(new Error("Root control socket closed.")));
    socket.once("close", () => this.failPending(new Error("Root control socket closed.")));
  }

  static async connect(options: RootSocketClientOptions): Promise<RootSocketClient> {
    const socket = createConnection(options.socketPath);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    const client = new RootSocketClient(socket);
    socket.write(
      encodeFrame({
        v: 1,
        type: "hello",
        token: options.token,
        agentId: options.agentId,
      }),
    );
    return client;
  }

  request(message: RequestMessage, signal?: AbortSignal): Promise<ResponseMessage> {
    if (this.closed || this.socket.destroyed) {
      return Promise.reject(new Error("Root control socket closed."));
    }
    if (signal?.aborted) return Promise.reject(abortError());
    if (this.pending.has(message.requestId)) {
      return Promise.reject(new Error(`Duplicate control request identifier: ${message.requestId}.`));
    }

    return new Promise<ResponseMessage>((resolve, reject) => {
      const pending: PendingRequest = { resolve, reject };
      if (signal) {
        const abortListener = () => {
          this.pending.delete(message.requestId);
          reject(abortError());
        };
        pending.signal = signal;
        pending.abortListener = abortListener;
        signal.addEventListener("abort", abortListener, { once: true });
      }
      this.pending.set(message.requestId, pending);
      this.socket.write(encodeFrame(message), (error) => {
        if (!error) return;
        this.settle(message.requestId, undefined, error);
      });
    });
  }

  send(message: UpdateMessage): void {
    if (this.closed || this.socket.destroyed) throw new Error("Root control socket closed.");
    this.socket.write(encodeFrame(message));
  }

  subscribeParentMessages(listener: (message: ParentMessage) => void): () => void {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.failPending(new Error("Root control socket closed."));
    this.socket.destroy();
  }

  private receive(chunk: Uint8Array): void {
    let messages: ControlMessage[];
    try {
      messages = this.decoder.push(chunk);
    } catch {
      this.close();
      return;
    }

    for (const message of messages) {
      if (message.type === "parent_message") {
        for (const subscriber of this.subscribers) subscriber(message);
        continue;
      }
      if (
        message.type === "dispatch_result" ||
        message.type === "inspect_result" ||
        message.type === "cancel_result"
      ) {
        this.settle(message.requestId, message);
      }
    }
  }

  private settle(requestId: string, response?: ResponseMessage, error?: Error): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    if (pending.signal && pending.abortListener) {
      pending.signal.removeEventListener("abort", pending.abortListener);
    }
    if (error) pending.reject(error);
    else pending.resolve(response!);
  }

  private failPending(error: Error): void {
    if (this.closed && this.pending.size === 0) return;
    this.closed = true;
    for (const requestId of [...this.pending.keys()]) this.settle(requestId, undefined, error);
  }
}
