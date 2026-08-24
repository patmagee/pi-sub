import type { RoleDefinition } from "./roles.js";
import type { PermissionMode, ThinkingLevel } from "./types.js";

export interface DispatchRoleChoice {
  name: string;
  description: string;
  source: "bundled" | "user" | "project";
  defaultModel?: string;
  defaultEffort?: ThinkingLevel;
  defaultPermission?: PermissionMode;
}

export interface DispatchCatalog {
  roles: DispatchRoleChoice[];
  models: string[];
}

export interface ModelLike {
  provider: string;
  id: string;
}

export function buildDispatchCatalog(input: {
  roles: ReadonlyMap<string, RoleDefinition>;
  scopedModels: readonly ModelLike[];
  availableModels: readonly ModelLike[];
}): DispatchCatalog {
  const roles = [...input.roles.values()]
    .map((role): DispatchRoleChoice => {
      const choice: DispatchRoleChoice = {
        name: role.name,
        description: role.description,
        source: role.source,
      };
      if (role.defaultModel !== undefined) choice.defaultModel = role.defaultModel;
      if (role.defaultEffort !== undefined) choice.defaultEffort = role.defaultEffort;
      if (role.defaultPermission !== undefined) choice.defaultPermission = role.defaultPermission;
      return choice;
    })
    .sort((left, right) => left.name.localeCompare(right.name));

  const source = input.scopedModels.length > 0 ? input.scopedModels : input.availableModels;
  const models = [...new Set(source.map((model) => `${model.provider}/${model.id}`))].sort();
  return { roles, models };
}

export function resolveRoleName(
  requested: string | undefined,
  catalog: DispatchCatalog,
): string {
  const role = requested ?? "generic";
  if (catalog.roles.some((choice) => choice.name === role)) return role;

  const available = catalog.roles.map((choice) => choice.name).join(", ") || "none";
  throw new Error(
    `Unknown subagent role "${role}". Available roles: ${available}. Omit role to use generic.`,
  );
}

export function resolveModelIdentifier(
  requested: string,
  catalog: DispatchCatalog,
): string {
  const value = requested.trim();
  if (catalog.models.includes(value)) return value;

  const normalized = value.toLowerCase();
  const matches = catalog.models.filter((model) => model.toLowerCase().includes(normalized));
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw new Error(`Model shorthand "${value}" is ambiguous: ${matches.join(", ")}.`);
  }

  const available = catalog.models.join(", ") || "none";
  throw new Error(`Model "${value}" is unavailable. Available models: ${available}.`);
}
