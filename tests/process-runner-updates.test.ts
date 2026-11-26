import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { PiEventReducer } from "../src/event-reducer.js";
import { ProcessRunner } from "../src/process-runner.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function harness() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  });
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  const onUpdate = vi.fn();
  const onComplete = vi.fn();
  const handle = new ProcessRunner().start({
    command: "pi", args: [], cwd: process.cwd(), env: {}, cancelGraceMs: 100,
    cleanup: async () => {},
  }, { onUpdate, onComplete });
  const emit = (text: string, newline = "\n") => child.stdout.emit("data", Buffer.from(JSON.stringify({
    type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text },
  }) + newline));
  return { child, handle, onUpdate, onComplete, emit };
}

describe("stream update batching", () => {
  it("reduces every event but builds only one snapshot per update interval", async () => {
    vi.useFakeTimers();
    const snapshots = vi.spyOn(PiEventReducer.prototype, "snapshot");
    const { child, handle, onUpdate, emit } = harness();
    for (let i = 0; i < 2000; i++) emit(`delta:${i}`);
    expect(snapshots).not.toHaveBeenCalled();
    expect(onUpdate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(snapshots).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate.mock.calls[0]![0].activity.at(-1).text).toBe("delta:1999");
    expect(onUpdate.mock.calls[0]![0].activity).toHaveLength(500);
    emit("next interval");
    await vi.advanceTimersByTimeAsync(100);
    expect(onUpdate).toHaveBeenCalledTimes(2);
    child.emit("close", 0, null);
    await handle.completion;
  });

  it.each(["completed", "failed", "cancelled"] as const)(
    "flushes pending output and clears timers when %s", async (status) => {
      vi.useFakeTimers();
      const { child, handle, onUpdate, onComplete, emit } = harness();
      emit("first");
      emit("last", "");
      if (status === "cancelled") void handle.cancel();
      child.emit("close", status === "failed" ? 1 : 0, null);
      const result = await handle.completion;
      expect(result.status).toBe(status);
      expect(onUpdate).toHaveBeenCalledTimes(1);
      expect(onUpdate.mock.calls[0]![0]).toEqual(result.snapshot);
      expect(result.snapshot.activity.map((entry) => entry.text)).toEqual(["first", "last"]);
      expect(onComplete).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
      await vi.runAllTimersAsync();
      expect(onUpdate).toHaveBeenCalledTimes(1);
    },
  );
});
