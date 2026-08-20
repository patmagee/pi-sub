import { existsSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { PermissionMode, ThinkingLevel } from "./types.js";

const SUBAGENT_TOOLS = [
  "subagent_start",
  "subagent_update",
  "subagent_inspect",
  "subagent_cancel",
] as const;

export const READ_ONLY_TOOLS = ["read", "grep", "find", "ls", ...SUBAGENT_TOOLS] as const;

export interface PiInvocationRuntime {
  execPath: string;
  argv: string[];
}

export interface PiInvocation {
  command: string;
  args: string[];
}

export interface BuildPiArgsInput {
  prompt: string;
  tempParentDir?: string;
  extensionPath: string;
  permission: PermissionMode;
  parentTools: readonly string[];
  model?: string;
  effort?: ThinkingLevel;
  socketPath: string;
  token: string;
  agentId: string;
  parentId: string;
  depth: number;
  rootSessionId: string;
  childSessionId: string;
}

export interface BuiltPiArgs {
  args: string[];
  env: NodeJS.ProcessEnv;
  promptDirectory: string;
  promptPath: string;
  cleanup: () => Promise<void>;
}

export function resolvePiInvocation(
  args: string[],
  runtime: PiInvocationRuntime = { execPath: process.execPath, argv: process.argv },
): PiInvocation {
  const currentScript = runtime.argv[1];
  const bunVirtualScript = currentScript?.startsWith("/$bunfs/root/") ?? false;
  if (currentScript && !bunVirtualScript && existsSync(currentScript)) {
    return { command: runtime.execPath, args: [currentScript, ...args] };
  }

  const executable = basename(runtime.execPath).toLowerCase();
  if (!/^(node|bun)(\.exe)?$/.test(executable)) {
    return { command: runtime.execPath, args };
  }
  return { command: "pi", args };
}

function selectedTools(input: BuildPiArgsInput): string[] {
  if (input.permission === "read-only") return [...READ_ONLY_TOOLS];
  return [...new Set([...input.parentTools, ...SUBAGENT_TOOLS])];
}

export async function buildPiArgs(input: BuildPiArgsInput): Promise<BuiltPiArgs> {
  const parent = input.tempParentDir ?? tmpdir();
  const promptDirectory = await mkdtemp(join(parent, "pi-sub-prompt-"));
  await chmod(promptDirectory, 0o700);
  const promptPath = join(promptDirectory, "assignment.md");
  await writeFile(promptPath, input.prompt, { encoding: "utf8", mode: 0o600 });
  await chmod(promptPath, 0o600);

  const args = [
    "--mode",
    "json",
    "-p",
    "--session-id",
    input.childSessionId,
    "--name",
    input.agentId,
  ];
  if (input.model) args.push("--model", input.model);
  if (input.effort) args.push("--thinking", input.effort);
  args.push(
    "--tools",
    selectedTools(input).join(","),
    "--extension",
    input.extensionPath,
    "--append-system-prompt",
    promptPath,
    "Begin the assigned work.",
  );

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PI_SUB_ROOT_SOCKET: input.socketPath,
    PI_SUB_ROOT_TOKEN: input.token,
    PI_SUB_AGENT_ID: input.agentId,
    PI_SUB_PARENT_ID: input.parentId,
    PI_SUB_DEPTH: String(input.depth),
    PI_SUB_ROOT_SESSION_ID: input.rootSessionId,
  };

  let cleaned = false;
  return {
    args,
    env,
    promptDirectory,
    promptPath,
    cleanup: async () => {
      if (cleaned) return;
      cleaned = true;
      await rm(promptDirectory, { recursive: true, force: true });
    },
  };
}
