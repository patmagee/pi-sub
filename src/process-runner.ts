import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { PiEventReducer, type PiEventReducerSnapshot } from "./event-reducer.js";

const MAX_STDERR_BYTES = 64 * 1024;
const UPDATE_INTERVAL_MS = 100;

export interface ProcessRunnerInput {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  cancelGraceMs: number;
  cleanup: () => Promise<void>;
  signal?: AbortSignal;
}

export interface ProcessRunnerCallbacks {
  onStart?: (pid: number) => void;
  onUpdate?: (snapshot: PiEventReducerSnapshot) => void;
  onComplete?: (result: ProcessResult) => void;
}

export interface ProcessResult {
  status: "completed" | "failed" | "cancelled";
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  forced: boolean;
  stderr: string;
  stderrTruncated: boolean;
  snapshot: PiEventReducerSnapshot;
}

export interface ProcessHandle {
  readonly pid: number;
  readonly completion: Promise<ProcessResult>;
  readonly latestSnapshot: PiEventReducerSnapshot;
  cancel(): Promise<ProcessResult>;
}

function safeCallback(callback: (() => void) | undefined): void {
  try {
    callback?.();
  } catch {
    // Lifecycle observers cannot take ownership away from the runner.
  }
}

class OwnedProcessHandle implements ProcessHandle {
  readonly pid: number;
  readonly completion: Promise<ProcessResult>;

  private readonly reducer = new PiEventReducer();
  private readonly stderrChunks: Buffer[] = [];
  private stderrBytes = 0;
  private stderrTruncated = false;
  private stdoutBuffer = "";
  private cancelling = false;
  private forced = false;
  private settled = false;
  private killTimer?: NodeJS.Timeout;
  private updateTimer: NodeJS.Timeout | undefined;
  private abortListener?: () => void;
  private resolveCompletion!: (result: ProcessResult) => void;

  constructor(
    private readonly child: ChildProcessByStdio<null, Readable, Readable>,
    private readonly input: ProcessRunnerInput,
    private readonly callbacks: ProcessRunnerCallbacks,
  ) {
    this.pid = child.pid ?? -1;
    this.completion = new Promise<ProcessResult>((resolve) => {
      this.resolveCompletion = resolve;
    });

    child.stdout.on("data", (chunk: Buffer) => this.readStdout(chunk));
    child.stderr.on("data", (chunk: Buffer) => this.readStderr(chunk));
    child.once("error", (error) => {
      this.readStderr(Buffer.from(`${error.message}\n`, "utf8"));
    });
    child.once("close", (code, signal) => {
      void this.finish(code, signal);
    });

    if (input.signal) {
      this.abortListener = () => {
        void this.cancel();
      };
      if (input.signal.aborted) this.abortListener();
      else input.signal.addEventListener("abort", this.abortListener, { once: true });
    }

    if (this.pid > 0) safeCallback(() => callbacks.onStart?.(this.pid));
  }

  get latestSnapshot(): PiEventReducerSnapshot {
    return this.reducer.snapshot();
  }

  cancel(): Promise<ProcessResult> {
    if (this.settled) return this.completion;
    if (!this.cancelling) {
      this.cancelling = true;
      this.signalProcess("SIGTERM");
      this.killTimer = setTimeout(() => {
        if (this.settled) return;
        this.forced = true;
        this.signalProcess("SIGKILL");
      }, this.input.cancelGraceMs);
      this.killTimer.unref?.();
    }
    return this.completion;
  }

  private readStdout(chunk: Buffer): void {
    this.stdoutBuffer += chunk.toString("utf8");
    const lines = this.stdoutBuffer.split("\n");
    this.stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) this.reduceLine(line);
  }

  private reduceLine(line: string): void {
    if (!line) return;
    this.reducer.pushLine(line);
    // Reduce every event, but do not copy the activity history for every token.
    if (!this.updateTimer && this.callbacks.onUpdate) {
      this.updateTimer = setTimeout(() => this.flushUpdate(), UPDATE_INTERVAL_MS);
      this.updateTimer.unref();
    }
  }

  private flushUpdate(): void {
    if (!this.updateTimer) return;
    clearTimeout(this.updateTimer);
    this.updateTimer = undefined;
    safeCallback(() => this.callbacks.onUpdate?.(this.reducer.snapshot()));
  }

  private readStderr(chunk: Buffer): void {
    if (this.stderrBytes >= MAX_STDERR_BYTES) {
      this.stderrTruncated = true;
      return;
    }
    const remaining = MAX_STDERR_BYTES - this.stderrBytes;
    const retained = chunk.subarray(0, remaining);
    this.stderrChunks.push(retained);
    this.stderrBytes += retained.byteLength;
    if (retained.byteLength < chunk.byteLength) this.stderrTruncated = true;
  }

  private signalProcess(signal: NodeJS.Signals): void {
    if (this.child.pid === undefined || this.child.exitCode !== null) return;
    if (process.platform !== "win32") {
      try {
        process.kill(-this.child.pid, signal);
        return;
      } catch {
        // Fall back to the direct child when the process group is already gone.
      }
    }
    try {
      this.child.kill(signal);
    } catch {
      // The close event remains authoritative when the process has already exited.
    }
  }

  private async finish(code: number | null, signal: NodeJS.Signals | null): Promise<void> {
    if (this.settled) return;
    this.settled = true;
    if (this.killTimer) clearTimeout(this.killTimer);
    if (this.input.signal && this.abortListener) {
      this.input.signal.removeEventListener("abort", this.abortListener);
    }
    if (this.stdoutBuffer.trim()) this.reduceLine(this.stdoutBuffer);
    this.flushUpdate();

    try {
      await this.input.cleanup();
    } catch (error) {
      this.readStderr(Buffer.from(`Prompt cleanup failed: ${String(error)}\n`, "utf8"));
    }

    const snapshot = this.reducer.snapshot();
    const status: ProcessResult["status"] = this.cancelling
      ? "cancelled"
      : snapshot.terminalError !== undefined
        ? "failed"
        : code === 0
          ? "completed"
          : "failed";
    const result: ProcessResult = {
      status,
      exitCode: code,
      signal,
      forced: this.forced,
      stderr: Buffer.concat(this.stderrChunks).toString("utf8"),
      stderrTruncated: this.stderrTruncated,
      snapshot,
    };
    safeCallback(() => this.callbacks.onComplete?.(result));
    this.resolveCompletion(result);
  }
}

export class ProcessRunner {
  start(input: ProcessRunnerInput, callbacks: ProcessRunnerCallbacks = {}): ProcessHandle {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: input.env,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return new OwnedProcessHandle(child, input, callbacks);
  }
}
