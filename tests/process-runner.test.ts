import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProcessRunner } from "../src/process-runner.js";

const fakePi = new URL("./helpers/fake-pi.mjs", import.meta.url).pathname;
const temporaryDirectories: string[] = [];

async function promptCleanup() {
  const directory = await mkdtemp(join(tmpdir(), "pi-sub-runner-test-"));
  temporaryDirectories.push(directory);
  const promptPath = join(directory, "prompt.md");
  await writeFile(promptPath, "assignment");
  return {
    promptPath,
    cleanup: async () => rm(directory, { recursive: true, force: true }),
  };
}

function startBehavior(
  behavior: string,
  options: { cancelGraceMs?: number; cleanup?: () => Promise<void> } = {},
) {
  return new ProcessRunner().start(
    {
      command: process.execPath,
      args: [fakePi],
      cwd: process.cwd(),
      env: { ...process.env, FAKE_PI_BEHAVIOR: behavior },
      cancelGraceMs: options.cancelGraceMs ?? 100,
      cleanup: options.cleanup ?? (async () => {}),
    },
    {
      onStart: vi.fn(),
      onUpdate: vi.fn(),
      onComplete: vi.fn(),
    },
  );
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("ProcessRunner", () => {
  it("captures launch, streamed events, completion, PID, and prompt cleanup", async () => {
    const prompt = await promptCleanup();
    const callbacks = { onStart: vi.fn(), onUpdate: vi.fn(), onComplete: vi.fn() };
    const handle = new ProcessRunner().start(
      {
        command: process.execPath,
        args: [fakePi],
        cwd: process.cwd(),
        env: { ...process.env, FAKE_PI_BEHAVIOR: "complete" },
        cancelGraceMs: 100,
        cleanup: prompt.cleanup,
      },
      callbacks,
    );
    const result = await handle.completion;

    expect(handle.pid).toEqual(expect.any(Number));
    expect(callbacks.onStart).toHaveBeenCalledWith(handle.pid);
    expect(callbacks.onUpdate).toHaveBeenCalled();
    expect(callbacks.onComplete).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: "completed",
      exitCode: 0,
      forced: false,
      snapshot: { finalSummary: "Fake child completed.", sessionFile: "/tmp/fake-child.jsonl" },
    });
    await expect(access(prompt.promptPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports crashes, bounded stderr, and malformed event diagnostics", async () => {
    const crash = await startBehavior("crash").completion;
    expect(crash.status).toBe("failed");
    expect(crash.exitCode).toBe(2);
    expect(crash.stderr).toContain("fake crash");
    expect(Buffer.byteLength(crash.stderr, "utf8")).toBeLessThanOrEqual(64 * 1024);
    expect(crash.stderrTruncated).toBe(true);

    const malformed = await startBehavior("malformed").completion;
    expect(malformed.status).toBe("completed");
    expect(malformed.snapshot.diagnostics).toContain("Malformed Pi JSON event: not-json");
  });

  it("treats an exit-zero provider error as a failure", async () => {
    const result = await startBehavior("provider-error").completion;
    expect(result.status).toBe("failed");
    expect(result.exitCode).toBe(0);
    expect(result.snapshot.terminalError).toContain("provider denied the request");
  });

  it("cancels gracefully with SIGTERM", async () => {
    const handle = startBehavior("slow", { cancelGraceMs: 200 });
    await vi.waitFor(() => expect(handle.latestSnapshot.activity.length).toBeGreaterThan(0));
    const result = await handle.cancel();

    expect(result.status).toBe("cancelled");
    expect(result.forced).toBe(false);
    expect(result.stderr).toContain("received SIGTERM");
  });

  it("forces cancellation with SIGKILL after the grace period", async () => {
    const handle = startBehavior("ignore-term", { cancelGraceMs: 20 });
    await vi.waitFor(() => expect(handle.latestSnapshot.activity.length).toBeGreaterThan(0));
    const result = await handle.cancel();

    expect(result.status).toBe("cancelled");
    expect(result.forced).toBe(true);
    expect(result.signal).toBe("SIGKILL");
  });
});
