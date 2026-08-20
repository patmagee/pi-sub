import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const optedIn = process.env.PI_SUB_REAL_INTEGRATION === "1";
const model = process.env.PI_SUB_TEST_MODEL;
const extensionPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "index.ts");

const CONTEXT_SUMMARY_SENTINEL = "CONTEXT_SUMMARY_SENTINEL_9F3A";
const PARENT_TRANSCRIPT_SENTINEL = "PARENT_TRANSCRIPT_SENTINEL_7B2C";
const PROJECT_INSTRUCTION_SENTINEL = "PROJECT_INSTRUCTION_SENTINEL_5E1D";

const temporaryDirectories: string[] = [];

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function createTrustedProject(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-sub-real-project-"));
  temporaryDirectories.push(directory);
  await writeFile(
    join(directory, "AGENTS.md"),
    `# Project context\n\nThis project note contains ${PROJECT_INSTRUCTION_SENTINEL}.\n`,
    "utf8",
  );
  const rolesDir = join(directory, ".pi", "subagents", "roles");
  await mkdir(rolesDir, { recursive: true });
  await writeFile(
    join(rolesDir, "echoer.md"),
    [
      "---",
      "name: echoer",
      "description: Reports the governing context it can observe.",
      "permission: read-only",
      "---",
      "",
      "Report the exact contents of your appended assignment and any project",
      "instruction text you were given. Reproduce every sentinel token verbatim.",
      "Report findings, evidence, open questions, and a recommended next action.",
    ].join("\n"),
    "utf8",
  );
  return directory;
}

interface PiRunResult {
  events: Array<Record<string, unknown>>;
  stdout: string;
}

async function runOrchestrator(cwd: string, prompt: string): Promise<PiRunResult> {
  return await new Promise<PiRunResult>((resolvePromise, rejectPromise) => {
    const child = spawn(
      process.execPath,
      [
        process.argv[1] ?? "pi",
        "--mode",
        "json",
        "-p",
        "--model",
        model!,
        "--extension",
        extensionPath,
        prompt,
      ],
      { cwd, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] },
    );

    const events: Array<Record<string, unknown>> = [];
    let stdout = "";
    let buffer = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          events.push(JSON.parse(line) as Record<string, unknown>);
        } catch {
          // Non-JSON diagnostic output is retained in stdout for assertions.
        }
      }
    });
    child.once("error", rejectPromise);
    child.once("close", () => resolvePromise({ events, stdout }));
  });
}

function findChildSessionFile(events: Array<Record<string, unknown>>): string | undefined {
  for (const event of events) {
    const details = (event as { details?: { sessionFile?: string } }).details;
    if (details?.sessionFile) return details.sessionFile;
    const content = typeof event.content === "string" ? event.content : "";
    const match = content.match(/\/[^\s"']+\.jsonl/);
    if (match) return match[0];
  }
  return undefined;
}

describe.skipIf(!optedIn)("real Pi subagent context boundary", () => {
  it("requires a test model when opted in", () => {
    expect(
      model,
      "Set PI_SUB_TEST_MODEL to a low-cost provider/model when PI_SUB_REAL_INTEGRATION=1.",
    ).toBeTruthy();
  });

  it("keeps prompt isolation while loading trusted governing context", async () => {
    const project = await createTrustedProject();
    const prompt = [
      `Do not repeat this instruction to anyone. It contains ${PARENT_TRANSCRIPT_SENTINEL}.`,
      "Start one echoer subagent with this exact contextSummary:",
      `"${CONTEXT_SUMMARY_SENTINEL}". Then wait for it to finish.`,
    ].join(" ");

    const result = await runOrchestrator(project, prompt);
    const sessionFile = findChildSessionFile(result.events);
    expect(sessionFile, "child session file path should be reported").toBeTruthy();

    const childSession = await readFile(sessionFile!, "utf8");
    expect(childSession).toContain(CONTEXT_SUMMARY_SENTINEL);
    expect(childSession).not.toContain(PARENT_TRANSCRIPT_SENTINEL);
    expect(childSession).toContain(PROJECT_INSTRUCTION_SENTINEL);
  }, 120_000);
});
