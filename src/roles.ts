import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  parseFrontmatter,
} from "@earendil-works/pi-coding-agent";
import type { PermissionMode, ThinkingLevel } from "./types.js";

export interface RoleDefinition {
  name: string;
  description: string;
  systemPrompt: string;
  defaultModel?: string;
  defaultEffort?: ThinkingLevel;
  defaultPermission?: PermissionMode;
  source: "bundled" | "user" | "project";
  filePath: string;
}

export interface DiscoverRolesOptions {
  projectTrusted: boolean;
  cwd?: string;
  bundledDir?: string;
  userDir?: string;
  projectDir?: string;
}

export interface RoleDiscoveryResult {
  roles: Map<string, RoleDefinition>;
  diagnostics: string[];
}

type RawRoleFrontmatter = {
  name?: unknown;
  description?: unknown;
  model?: unknown;
  effort?: unknown;
  permission?: unknown;
};

const THINKING_LEVELS = new Set<ThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const PERMISSION_MODES = new Set<PermissionMode>(["read-only", "inherit"]);
const DEFAULT_BUNDLED_DIRECTORY = fileURLToPath(new URL("../roles", import.meta.url));

async function isDirectory(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isDirectory();
  } catch {
    return false;
  }
}

async function findNearestProjectRolesDirectory(cwd: string): Promise<string | undefined> {
  let current = cwd;
  while (true) {
    const candidate = join(current, CONFIG_DIR_NAME, "subagents", "roles");
    if (await isDirectory(candidate)) return candidate;

    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validateFrontmatter(frontmatter: RawRoleFrontmatter): string | undefined {
  if (!nonEmptyString(frontmatter.name)) return 'frontmatter field "name" must be a non-empty string.';
  if (!nonEmptyString(frontmatter.description)) {
    return 'frontmatter field "description" must be a non-empty string.';
  }
  if (frontmatter.model !== undefined && !nonEmptyString(frontmatter.model)) {
    return 'frontmatter field "model" must be a non-empty string when present.';
  }
  if (
    frontmatter.effort !== undefined &&
    (typeof frontmatter.effort !== "string" ||
      !THINKING_LEVELS.has(frontmatter.effort as ThinkingLevel))
  ) {
    return 'frontmatter field "effort" must be a supported thinking level.';
  }
  if (
    frontmatter.permission !== undefined &&
    (typeof frontmatter.permission !== "string" ||
      !PERMISSION_MODES.has(frontmatter.permission as PermissionMode))
  ) {
    return 'frontmatter field "permission" must be "read-only" or "inherit".';
  }
  return undefined;
}

async function loadDirectory(
  directory: string,
  source: RoleDefinition["source"],
  roles: Map<string, RoleDefinition>,
  diagnostics: string[],
): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") diagnostics.push(`${directory}: could not read role directory: ${String(error)}`);
    return;
  }

  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (!entry.name.endsWith(".md") || (!entry.isFile() && !entry.isSymbolicLink())) continue;

    const filePath = join(directory, entry.name);
    try {
      const content = await readFile(filePath, "utf8");
      const { frontmatter, body } = parseFrontmatter<RawRoleFrontmatter>(content);
      const validationError = validateFrontmatter(frontmatter);
      if (validationError) {
        diagnostics.push(`${filePath}: ${validationError}`);
        continue;
      }
      if (!nonEmptyString(frontmatter.name) || !nonEmptyString(frontmatter.description)) {
        continue;
      }

      const role: RoleDefinition = {
        name: frontmatter.name.trim(),
        description: frontmatter.description.trim(),
        systemPrompt: body.trim(),
        source,
        filePath,
      };
      if (nonEmptyString(frontmatter.model)) role.defaultModel = frontmatter.model.trim();
      if (typeof frontmatter.effort === "string") {
        role.defaultEffort = frontmatter.effort as ThinkingLevel;
      }
      if (typeof frontmatter.permission === "string") {
        role.defaultPermission = frontmatter.permission as PermissionMode;
      }
      roles.set(role.name, role);
    } catch (error) {
      diagnostics.push(`${filePath}: could not load role: ${String(error)}`);
    }
  }
}

export async function discoverRoles(options: DiscoverRolesOptions): Promise<RoleDiscoveryResult> {
  const roles = new Map<string, RoleDefinition>();
  const diagnostics: string[] = [];
  const bundledDir = options.bundledDir ?? DEFAULT_BUNDLED_DIRECTORY;
  const userDir = options.userDir ?? join(getAgentDir(), "subagents", "roles");

  await loadDirectory(bundledDir, "bundled", roles, diagnostics);
  await loadDirectory(userDir, "user", roles, diagnostics);

  if (options.projectTrusted) {
    const projectDir =
      options.projectDir ??
      (options.cwd ? await findNearestProjectRolesDirectory(options.cwd) : undefined);
    if (projectDir) await loadDirectory(projectDir, "project", roles, diagnostics);
  }

  return { roles, diagnostics };
}

export function resolveRole(
  name: string,
  catalog: ReadonlyMap<string, RoleDefinition>,
): RoleDefinition {
  const role = catalog.get(name);
  if (role) return role;

  const available = [...catalog.keys()].sort().join(", ") || "none";
  throw new Error(`Unknown subagent role "${name}". Available roles: ${available}.`);
}
