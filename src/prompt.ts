import type { PermissionMode } from "./types.js";

export interface ChildPromptInput {
  name: string;
  parentName: string;
  depth: number;
  maxDepth: number;
  permission: PermissionMode;
  task: string;
  rolePrompt: string;
  contextSummary?: string;
}

export function buildChildPrompt(input: ChildPromptInput): string {
  const sections = [
    "# Subagent assignment",
    "",
    "## Identity",
    "",
    `Name: ${input.name}`,
    `Parent: ${input.parentName}`,
    `Depth: ${input.depth} of ${input.maxDepth}`,
    `Permission: ${input.permission}`,
    "",
    "## Role",
    "",
    input.rolePrompt.trim(),
    "",
    "## Assignment",
    "",
    input.task.trim(),
  ];

  const contextSummary = input.contextSummary?.trim();
  if (contextSummary) {
    sections.push("", "## Context summary", "", contextSummary);
  }

  sections.push(
    "",
    "## Orchestration",
    "",
    "Use `subagent_update` for important findings while work continues.",
    "Promotion is explicit. Promote only concise, self-contained updates that the direct parent needs in context.",
  );

  if (input.depth === input.maxDepth) {
    sections.push("Delegation is unavailable at this depth.");
  } else {
    sections.push(`Delegation is available only through depth ${input.maxDepth} and within your permission ceiling.`);
  }

  sections.push(
    "",
    "## Reporting contract",
    "",
    "Return a concise final summary. Do not reproduce your transcript, full files, or large tool output.",
    "End with these sections:",
    "",
    "## Findings",
    "## Evidence",
    "## Open questions",
    "## Recommended next action",
  );

  return `${sections.join("\n")}\n`;
}
