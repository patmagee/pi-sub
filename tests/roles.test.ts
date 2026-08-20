import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverRoles, resolveRole } from "../src/roles.js";

const temporaryDirectories: string[] = [];

async function temporaryRoleDirectories() {
  const root = await mkdtemp(join(tmpdir(), "pi-sub-roles-"));
  temporaryDirectories.push(root);
  const bundledDir = join(root, "bundled");
  const userDir = join(root, "user");
  const projectDir = join(root, "project");
  await Promise.all([bundledDir, userDir, projectDir].map((directory) => mkdir(directory)));
  return { root, bundledDir, userDir, projectDir };
}

async function writeRole(
  directory: string,
  fileName: string,
  input: {
    name: string;
    description: string;
    body: string;
    model?: string;
    effort?: string;
    permission?: string;
  },
): Promise<string> {
  const filePath = join(directory, fileName);
  const optional = [
    input.model ? `model: ${input.model}` : undefined,
    input.effort ? `effort: ${input.effort}` : undefined,
    input.permission ? `permission: ${input.permission}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
  await writeFile(
    filePath,
    `---\nname: ${input.name}\ndescription: ${input.description}\n${optional}\n---\n\n${input.body}\n`,
  );
  return filePath;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("discoverRoles", () => {
  it("uses project roles before user roles and user roles before bundled roles", async () => {
    const directories = await temporaryRoleDirectories();
    await writeRole(directories.bundledDir, "reviewer.md", {
      name: "reviewer",
      description: "Bundled reviewer",
      body: "Bundled prompt.",
    });
    await writeRole(directories.userDir, "reviewer.md", {
      name: "reviewer",
      description: "User reviewer",
      body: "User prompt.",
    });
    await writeRole(directories.projectDir, "reviewer.md", {
      name: "reviewer",
      description: "Project reviewer",
      body: "Project prompt.",
      model: "openai/gpt-5.4",
      effort: "high",
      permission: "inherit",
    });

    const trusted = await discoverRoles({
      bundledDir: directories.bundledDir,
      userDir: directories.userDir,
      projectDir: directories.projectDir,
      projectTrusted: true,
    });
    expect(trusted.roles.get("reviewer")).toMatchObject({
      description: "Project reviewer",
      systemPrompt: "Project prompt.",
      defaultModel: "openai/gpt-5.4",
      defaultEffort: "high",
      defaultPermission: "inherit",
      source: "project",
    });

    const untrusted = await discoverRoles({
      bundledDir: directories.bundledDir,
      userDir: directories.userDir,
      projectDir: directories.projectDir,
      projectTrusted: false,
    });
    expect(untrusted.roles.get("reviewer")).toMatchObject({
      description: "User reviewer",
      source: "user",
    });
  });

  it("reports malformed files while retaining valid regular files and symbolic links", async () => {
    const directories = await temporaryRoleDirectories();
    const validPath = await writeRole(directories.bundledDir, "scout.md", {
      name: "scout",
      description: "Search quickly",
      body: "Find evidence.",
      effort: "off",
      permission: "read-only",
    });
    await symlink(validPath, join(directories.userDir, "linked-scout.md"));
    await writeFile(
      join(directories.userDir, "invalid.md"),
      "---\nname: invalid\ndescription: 42\neffort: impossible\n---\nBad role.\n",
    );
    await writeFile(join(directories.userDir, "ignored.txt"), "not a role");

    const result = await discoverRoles({
      bundledDir: directories.bundledDir,
      userDir: directories.userDir,
      projectTrusted: false,
    });

    expect(result.roles.get("scout")).toMatchObject({ source: "user", defaultEffort: "off" });
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toContain("invalid.md");
    expect(result.diagnostics[0]).toContain("description");
  });
});

describe("resolveRole", () => {
  it("returns a known role and gives an actionable error for an unknown role", async () => {
    const directories = await temporaryRoleDirectories();
    await writeRole(directories.bundledDir, "scout.md", {
      name: "scout",
      description: "Search quickly",
      body: "Find evidence.",
    });
    const catalog = (await discoverRoles({
      bundledDir: directories.bundledDir,
      userDir: directories.userDir,
      projectTrusted: false,
    })).roles;

    expect(resolveRole("scout", catalog).name).toBe("scout");
    expect(() => resolveRole("missing", catalog)).toThrow(
      'Unknown subagent role "missing". Available roles: scout.',
    );
  });
});
