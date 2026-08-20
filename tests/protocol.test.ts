import { describe, expect, it } from "vitest";
import {
  FrameDecoder,
  MAX_FRAME_BYTES,
  ProtocolError,
  encodeFrame,
  type ControlMessage,
} from "../src/protocol.js";

const hello: ControlMessage = { v: 1, type: "hello", token: "secret", agentId: "agent-1" };

describe("socket framing", () => {
  it("decodes fragmented frames and multiple frames in one chunk", () => {
    const decoder = new FrameDecoder();
    const first = encodeFrame(hello);
    const second = encodeFrame({
      v: 1,
      type: "update",
      agentId: "agent-1",
      text: "found evidence",
      promote: true,
    });

    expect(decoder.push(first.subarray(0, 5))).toEqual([]);
    expect(decoder.push(Buffer.concat([first.subarray(5), second]))).toEqual([
      hello,
      {
        v: 1,
        type: "update",
        agentId: "agent-1",
        text: "found evidence",
        promote: true,
      },
    ]);
  });

  it("rejects invalid JSON, oversized frames, and unknown message types", () => {
    expect(() => new FrameDecoder().push(Buffer.from("{bad}\n"))).toThrow(
      "Invalid JSON control frame.",
    );
    expect(() =>
      new FrameDecoder().push(Buffer.alloc(MAX_FRAME_BYTES + 1, "a")),
    ).toThrow("Control frame exceeds 262144 bytes.");
    expect(() =>
      new FrameDecoder().push(Buffer.from('{"v":1,"type":"unknown"}\n')),
    ).toThrow('Unknown control message type "unknown".');
  });

  it("rejects missing values, unsupported versions, and prototype-bearing payloads", () => {
    expect(() =>
      new FrameDecoder().push(
        Buffer.from('{"v":2,"type":"hello","token":"x","agentId":"a"}\n'),
      ),
    ).toThrow("Unsupported control protocol version.");
    expect(() =>
      new FrameDecoder().push(
        Buffer.from('{"v":1,"type":"hello","token":"","agentId":"a"}\n'),
      ),
    ).toThrow('Control message field "token" must be a non-empty string.');
    expect(() =>
      new FrameDecoder().push(
        Buffer.from(
          '{"v":1,"type":"hello","token":"x","agentId":"a","__proto__":{"polluted":true}}\n',
        ),
      ),
    ).toThrow("Control messages cannot contain prototype-bearing keys.");
  });

  it("rejects prototype-bearing values before encoding", () => {
    const value = Object.create({ inherited: true }) as ControlMessage;
    Object.assign(value, hello);

    expect(() => encodeFrame(value)).toThrow(ProtocolError);
  });

  it("validates session-ready messages and rejects missing, empty, mistyped, or oversized fields", () => {
    expect(
      encodeFrame({ v: 1, type: "session_ready", agentId: "agent-1", sessionFile: "/sessions/a.jsonl" }),
    ).toBeInstanceOf(Buffer);
    expect(() =>
      new FrameDecoder().push(Buffer.from('{"v":1,"type":"session_ready","agentId":"agent-1"}\n')),
    ).toThrow('Control message field "sessionFile" must be a non-empty string.');
    expect(() =>
      new FrameDecoder().push(
        Buffer.from('{"v":1,"type":"session_ready","agentId":"","sessionFile":"/s"}\n'),
      ),
    ).toThrow('Control message field "agentId" must be a non-empty string.');
    expect(() =>
      new FrameDecoder().push(
        Buffer.from('{"v":1,"type":"session_ready","agentId":"agent-1","sessionFile":5}\n'),
      ),
    ).toThrow('Control message field "sessionFile" must be a non-empty string.');
    expect(() =>
      encodeFrame({
        v: 1,
        type: "session_ready",
        agentId: "agent-1",
        sessionFile: "a".repeat(MAX_FRAME_BYTES),
      }),
    ).toThrow("Control frame exceeds 262144 bytes.");
  });

  it("validates bounded inspection requests", () => {
    expect(() =>
      encodeFrame({
        v: 1,
        type: "inspect",
        requestId: "request-1",
        requesterId: "agent-1",
        targetId: "agent-2",
        view: "session",
        limit: 50 * 1024 + 1,
      }),
    ).toThrow("Inspection limit cannot exceed 51200 bytes.");
  });
});
