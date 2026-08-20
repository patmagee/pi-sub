import { access, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildPiArgs,
  READ_ONLY_TOOLS,
  resolvePiInvocation,
} from "../src/pi-command.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-sub-command-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("resolvePiInvocation", () => {
  it("uses the current Pi script through the active JavaScript runtime", async () => {
    const directory = await temporaryDirectory();
    const script = join(directory, "pi.js");
    await writeFile(script, "");

    expect(
      resolvePiInvocation(["--mode", "json"], {
        execPath: "/usr/local/bin/node",
        argv: ["node", script],
      }),
    ).toEqual({ command: "/usr/local/bin/node", args: [script, "--mode", "json"] });
  });

  it("falls back to the pi command under a generic runtime without a real script", () => {
    expect(
      resolvePiInvocation(["--mode", "json"], {
        execPath: "/usr/local/bin/node",
        argv: ["node", "/missing/pi.js"],
      }),
    ).toEqual({ command: "pi", args: ["--mode", "json"] });
  });
});

describe("buildPiArgs", () => {
  it("builds a persistent read-only child invocation and private environment", async () => {
    const built = await buildPiArgs({
      prompt: "Child assignment.",
      tempParentDir: await temporaryDirectory(),
      extensionPath: "/extension/index.ts",
      permission: "read-only",
      parentTools: ["read", "bash"],
      model: "anthropic/claude-haiku-4-5",
      effort: "off",
      socketPath: "/tmp/root.sock",
      token: "socket-secret",
      agentId: "agent-1",
      parentId: "root",
      depth: 1,
      rootSessionId: "root-session",
      childSessionId: "child-session",
    });

    expect(built.args).toEqual([
      "--mode",
      "json",
      "-p",
      "--session-id",
      "child-session",
      "--name",
      "agent-1",
      "--model",
      "anthropic/claude-haiku-4-5",
      "--thinking",
      "off",
      "--tools",
      READ_ONLY_TOOLS.join(","),
      "--extension",
      "/extension/index.ts",
      "--append-system-prompt",
      built.promptPath,
      "Begin the assigned work.",
    ]);
    expect(built.args).not.toContain("--no-session");
    expect(built.args.join(" ")).not.toContain("socket-secret");
    expect(built.env).toMatchObject({
      PI_SUB_ROOT_SOCKET: "/tmp/root.sock",
      PI_SUB_ROOT_TOKEN: "socket-secret",
      PI_SUB_AGENT_ID: "agent-1",
      PI_SUB_PARENT_ID: "root",
      PI_SUB_DEPTH: "1",
      PI_SUB_ROOT_SESSION_ID: "root-session",
    });
    expect((await stat(built.promptDirectory)).mode & 0o777).toBe(0o700);
    expect((await stat(built.promptPath)).mode & 0o777).toBe(0o600);

    await built.cleanup();
    await expect(access(built.promptPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("gives each child only its own agent identifier and credential", async () => {
    const tempParentDir = await temporaryDirectory();
    const base = {
      prompt: "Child assignment.",
      tempParentDir,
      extensionPath: "/extension/index.ts",
      permission: "read-only" as const,
      parentTools: ["read"],
      socketPath: "/tmp/root.sock",
      parentId: "root",
      depth: 1,
      rootSessionId: "root-session",
      childSessionId: "child-session",
    };
    const first = await buildPiArgs({ ...base, agentId: "agent-1", token: "credential-1" });
    const second = await buildPiArgs({ ...base, agentId: "agent-2", token: "credential-2" });

    expect(first.env).toMatchObject({ PI_SUB_AGENT_ID: "agent-1", PI_SUB_ROOT_TOKEN: "credential-1" });
    expect(second.env).toMatchObject({ PI_SUB_AGENT_ID: "agent-2", PI_SUB_ROOT_TOKEN: "credential-2" });
    expect(first.env.PI_SUB_ROOT_TOKEN).not.toBe(second.env.PI_SUB_ROOT_TOKEN);
    expect(first.args.join(" ")).not.toContain("credential-1");

    await first.cleanup();
    await second.cleanup();
  });

  it("deduplicates inherited tools while preserving parent order", async () => {
    const built = await buildPiArgs({
      prompt: "Child assignment.",
      tempParentDir: await temporaryDirectory(),
      extensionPath: "/extension/index.ts",
      permission: "inherit",
      parentTools: ["read", "bash", "read", "subagent_update"],
      socketPath: "/tmp/root.sock",
      token: "secret",
      agentId: "agent-1",
      parentId: "root",
      depth: 1,
      rootSessionId: "root-session",
      childSessionId: "child-session",
    });

    const tools = built.args[built.args.indexOf("--tools") + 1]?.split(",");
    expect(tools).toEqual([
      "read",
      "bash",
      "subagent_update",
      "subagent_start",
      "subagent_inspect",
      "subagent_cancel",
    ]);
    await built.cleanup();
  });
});
