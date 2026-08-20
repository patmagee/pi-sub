import { describe, expect, it } from "vitest";
import { PiEventReducer } from "../src/event-reducer.js";

describe("PiEventReducer", () => {
  it("reduces emitted reasoning, text, tools, usage, summary, and session metadata", () => {
    const reducer = new PiEventReducer();
    const events = [
      { type: "session", id: "session-id", sessionFile: "/sessions/child.jsonl" },
      {
        type: "message_update",
        assistantMessageEvent: { type: "thinking_delta", delta: "Check the boundary." },
      },
      {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "Working." },
      },
      {
        type: "tool_execution_start",
        toolCallId: "tool-1",
        toolName: "read",
        args: { path: "src/auth.ts" },
      },
      {
        type: "tool_execution_end",
        toolCallId: "tool-1",
        toolName: "read",
        result: { content: [{ type: "text", text: "token validation" }] },
        isError: false,
      },
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Final concise summary." }],
          usage: {
            input: 10,
            output: 5,
            cacheRead: 3,
            cacheWrite: 2,
            totalTokens: 20,
            cost: { total: 0.01 },
          },
        },
      },
    ];
    for (const event of events) reducer.pushLine(JSON.stringify(event));

    const snapshot = reducer.snapshot();
    expect(snapshot.activity).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "reasoning", text: "Check the boundary." }),
        expect.objectContaining({ kind: "text", text: "Working." }),
        expect.objectContaining({ kind: "tool", toolName: "read", text: expect.stringContaining("src/auth.ts") }),
        expect.objectContaining({ kind: "tool", toolName: "read", text: expect.stringContaining("token validation") }),
      ]),
    );
    expect(snapshot.reasoningEmitted).toBe(true);
    expect(snapshot.reasoningState).toBe("Provider-emitted reasoning is available.");
    expect(snapshot.usage).toEqual({
      input: 10,
      output: 5,
      cacheRead: 3,
      cacheWrite: 2,
      totalTokens: 20,
      cost: 0.01,
      turns: 1,
    });
    expect(snapshot.finalSummary).toBe("Final concise summary.");
    expect(snapshot.sessionFile).toBe("/sessions/child.jsonl");
  });

  it("classifies an exit-zero assistant error as a terminal failure", () => {
    const reducer = new PiEventReducer();
    reducer.pushLine(
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "provider denied the request",
        },
      }),
    );

    const snapshot = reducer.snapshot();
    expect(snapshot.terminalError).toBe("provider denied the request");
    expect(snapshot.finalSummary).toBeUndefined();
  });

  it("bounds previews and retained activity", () => {
    const reducer = new PiEventReducer();
    for (let index = 0; index < 510; index += 1) {
      reducer.pushLine(
        JSON.stringify({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: `${index}:${"x".repeat(9000)}` },
        }),
      );
    }

    const snapshot = reducer.snapshot();
    expect(snapshot.activity).toHaveLength(500);
    expect(Buffer.byteLength(snapshot.activity[0]!.text, "utf8")).toBeLessThanOrEqual(8 * 1024);
    expect(snapshot.activity[0]!.text).toContain("[truncated]");
  });

  it("records malformed lines visibly without throwing", () => {
    const reducer = new PiEventReducer();

    expect(() => reducer.pushLine("not-json")).not.toThrow();
    const snapshot = reducer.snapshot();
    expect(snapshot.diagnostics).toEqual(["Malformed Pi JSON event: not-json"]);
    expect(snapshot.activity).toContainEqual(
      expect.objectContaining({ kind: "diagnostic", text: "Malformed Pi JSON event: not-json" }),
    );
    expect(snapshot.reasoningEmitted).toBe(false);
    expect(snapshot.reasoningState).toBe("Reasoning was not emitted by the provider.");
  });
});
