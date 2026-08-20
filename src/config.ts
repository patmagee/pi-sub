import type { SubagentConfig } from "./types.js";

const DEFAULT_MAX_AGENTS = 12;
const DEFAULT_MAX_CONCURRENCY = 12;
const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_CANCEL_GRACE_MS = 5000;
const DEFAULT_MAX_RETAINED = 100;
const HARD_MAX_DEPTH = 3;

interface IntegerSetting {
  name: string;
  fallback: number;
}

function parsePositiveInteger(
  env: NodeJS.ProcessEnv,
  setting: IntegerSetting,
  diagnostics: string[],
): number {
  const raw = env[setting.name];
  if (raw === undefined) return setting.fallback;

  if (!/^[0-9]+$/.test(raw) || Number(raw) <= 0 || !Number.isSafeInteger(Number(raw))) {
    diagnostics.push(
      `${setting.name} must be a positive base-ten integer; using ${setting.fallback}.`,
    );
    return setting.fallback;
  }

  return Number(raw);
}

export function parseConfig(
  env: NodeJS.ProcessEnv,
): { config: SubagentConfig; diagnostics: string[] } {
  const diagnostics: string[] = [];
  const maxAgents = parsePositiveInteger(
    env,
    { name: "PI_SUB_MAX_AGENTS", fallback: DEFAULT_MAX_AGENTS },
    diagnostics,
  );
  let maxConcurrency = parsePositiveInteger(
    env,
    { name: "PI_SUB_MAX_CONCURRENCY", fallback: DEFAULT_MAX_CONCURRENCY },
    diagnostics,
  );
  let maxDepth = parsePositiveInteger(
    env,
    { name: "PI_SUB_MAX_DEPTH", fallback: DEFAULT_MAX_DEPTH },
    diagnostics,
  );
  const cancelGraceMs = parsePositiveInteger(
    env,
    { name: "PI_SUB_CANCEL_GRACE_MS", fallback: DEFAULT_CANCEL_GRACE_MS },
    diagnostics,
  );
  const maxRetained = parsePositiveInteger(
    env,
    { name: "PI_SUB_MAX_RETAINED", fallback: DEFAULT_MAX_RETAINED },
    diagnostics,
  );

  if (maxConcurrency > maxAgents) {
    maxConcurrency = maxAgents;
    diagnostics.push(
      `PI_SUB_MAX_CONCURRENCY cannot exceed PI_SUB_MAX_AGENTS; using ${maxConcurrency}.`,
    );
  }

  if (maxDepth > HARD_MAX_DEPTH) {
    maxDepth = HARD_MAX_DEPTH;
    diagnostics.push(`PI_SUB_MAX_DEPTH cannot exceed ${HARD_MAX_DEPTH}; using ${maxDepth}.`);
  }

  const config: SubagentConfig = {
    maxAgents,
    maxConcurrency,
    maxDepth,
    maxRetained,
    cancelGraceMs,
  };
  if (env.PI_SUB_SOCKET_DIR) config.socketDir = env.PI_SUB_SOCKET_DIR;

  return { config, diagnostics };
}
