const behavior = process.env.FAKE_PI_BEHAVIOR ?? "complete";

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function complete() {
  emit({ type: "session", id: "fake-session", sessionFile: "/tmp/fake-child.jsonl" });
  emit({
    type: "message_update",
    assistantMessageEvent: { type: "thinking_delta", delta: "Inspect the evidence." },
  });
  emit({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "Working." },
  });
  emit({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "read", args: { path: "src/file.ts" } });
  emit({
    type: "tool_execution_end",
    toolCallId: "tool-1",
    toolName: "read",
    result: { content: [{ type: "text", text: "evidence" }] },
    isError: false,
  });
  emit({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Fake child completed." }],
      usage: {
        input: 4,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 6,
        cost: { total: 0.001 },
      },
    },
  });
}

if (behavior === "complete") {
  complete();
} else if (behavior === "crash") {
  process.stderr.write("fake crash\n" + "x".repeat(70 * 1024));
  process.exitCode = 2;
} else if (behavior === "malformed") {
  process.stdout.write("not-json\n");
  complete();
} else if (behavior === "slow") {
  emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "ready" } });
  process.on("SIGTERM", () => {
    process.stderr.write("received SIGTERM\n");
    process.exit(0);
  });
  setInterval(() => {}, 1000);
} else if (behavior === "ignore-term") {
  emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "ready" } });
  process.on("SIGTERM", () => {
    process.stderr.write("ignored SIGTERM\n");
  });
  setInterval(() => {}, 1000);
} else {
  process.stderr.write(`unknown behavior: ${behavior}\n`);
  process.exitCode = 3;
}
