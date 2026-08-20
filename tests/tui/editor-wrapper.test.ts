import { Key, matchesKey, type EditorComponent } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { wrapEditorComponent } from "../../src/tui/editor-wrapper.js";
import { SubagentStatusStrip } from "../../src/tui/status-strip.js";
import type { AgentRecord } from "../../src/types.js";

function record(id: string): AgentRecord {
  return {
    id,
    requestedName: id,
    displayName: id,
    role: "scout",
    task: id,
    depth: 1,
    permission: "read-only",
    cwd: "/workspace",
    status: "running",
    createdAt: 1,
    updates: [],
    activity: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, turns: 0 },
  };
}

function priorEditor() {
  let text = "draft";
  const submitted: string[] = [];
  const inputs: string[] = [];
  const component: EditorComponent & { focused: boolean; dispose: ReturnType<typeof vi.fn> } = {
    focused: true,
    onSubmit(value) {
      submitted.push(value);
    },
    getText: () => text,
    setText: (value) => {
      text = value;
    },
    handleInput(data) {
      inputs.push(data);
      if (matchesKey(data, Key.enter)) this.onSubmit?.(text);
    },
    render: vi.fn(() => [text]),
    invalidate: vi.fn(),
    dispose: vi.fn(),
  };
  return { component, submitted, inputs };
}

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const keybindings = {
  matches(data: string, binding: string) {
    if (binding === "tui.select.confirm") return matchesKey(data, Key.enter);
    if (binding === "tui.select.cancel") return matchesKey(data, Key.escape);
    if (binding === "tui.select.up") return matchesKey(data, Key.up);
    if (binding === "tui.select.down") return matchesKey(data, Key.down);
    return false;
  },
};

describe("editor composition", () => {
  it("passes ordinary input and rendering through to the prior editor", () => {
    const prior = priorEditor();
    const strip = new SubagentStatusStrip([record("one")], theme, { openAgent: vi.fn() });
    const wrapper = wrapEditorComponent(prior.component, strip, keybindings);

    wrapper.handleInput("x");
    expect(prior.inputs).toEqual(["x"]);
    expect(wrapper.render(40)).toEqual(["draft"]);
    wrapper.invalidate();
    wrapper.dispose?.();
    expect(prior.component.invalidate).toHaveBeenCalled();
    expect(prior.component.dispose).toHaveBeenCalled();
  });

  it("moves focus to the strip with Shift+Down and restores editor focus with Escape", () => {
    const prior = priorEditor();
    const strip = new SubagentStatusStrip([record("one"), record("two")], theme, { openAgent: vi.fn() });
    const wrapper = wrapEditorComponent(prior.component, strip, keybindings);

    wrapper.handleInput("\u001b[1;2B");
    expect(strip.isFocused).toBe(true);
    expect(prior.component.focused).toBe(false);
    expect(prior.inputs).toEqual([]);

    wrapper.handleInput("\u001b");
    expect(strip.isFocused).toBe(false);
    expect(prior.component.focused).toBe(true);
  });

  it("owns selection keys and prevents editor submission while strip-focused", () => {
    const openAgent = vi.fn();
    const prior = priorEditor();
    const strip = new SubagentStatusStrip([record("one"), record("two")], theme, { openAgent });
    const wrapper = wrapEditorComponent(prior.component, strip, keybindings);
    wrapper.handleInput("\u001b[1;2B");

    wrapper.handleInput("\u001b[B");
    expect(strip.selectedId).toBe("two");
    wrapper.handleInput("\r");
    expect(openAgent).toHaveBeenCalledWith("two");
    expect(prior.submitted).toEqual([]);
    expect(prior.inputs).toEqual([]);

    wrapper.handleInput("\u001b[1;2A");
    expect(strip.isFocused).toBe(false);
    expect(prior.component.focused).toBe(true);
  });
});
