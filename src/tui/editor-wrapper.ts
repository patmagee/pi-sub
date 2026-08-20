import {
  CustomEditor,
  type ExtensionContext,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  isFocusable,
  Key,
  matchesKey,
  type EditorComponent,
  type Focusable,
} from "@earendil-works/pi-tui";
import type { SubagentStatusStrip } from "./status-strip.js";

type EditorFactory = Exclude<
  Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0],
  undefined
>;
type AutocompleteProviderParameter = Parameters<
  NonNullable<EditorComponent["setAutocompleteProvider"]>
>[0];

export interface SelectionKeybindings {
  matches(data: string, binding: "tui.select.up" | "tui.select.down" | "tui.select.confirm" | "tui.select.cancel"): boolean;
}

function selectionInput(
  data: string,
  strip: SubagentStatusStrip,
  keybindings: SelectionKeybindings,
  restoreEditor: () => void,
): boolean {
  if (matchesKey(data, Key.shift("up")) || keybindings.matches(data, "tui.select.cancel")) {
    strip.setFocused(false);
    restoreEditor();
    return true;
  }
  if (matchesKey(data, Key.up) || keybindings.matches(data, "tui.select.up")) {
    strip.selectPrevious();
    return true;
  }
  if (matchesKey(data, Key.down) || keybindings.matches(data, "tui.select.down")) {
    strip.selectNext();
    return true;
  }
  if (matchesKey(data, Key.enter) || keybindings.matches(data, "tui.select.confirm")) {
    strip.openSelected();
    return true;
  }
  return strip.isFocused;
}

class ComposedEditor implements EditorComponent, Focusable {
  private hasFocus = true;

  constructor(
    private readonly prior: EditorComponent,
    private readonly strip: SubagentStatusStrip,
    private readonly keybindings: SelectionKeybindings,
  ) {
    this.propagateFocus();
  }

  get focused(): boolean {
    return this.hasFocus;
  }

  set focused(value: boolean) {
    this.hasFocus = value;
    this.propagateFocus();
  }

  get wantsKeyRelease(): boolean {
    return this.prior.wantsKeyRelease ?? false;
  }

  get onSubmit(): (text: string) => void {
    return (text) => this.prior.onSubmit?.(text);
  }

  set onSubmit(handler: ((text: string) => void) | undefined) {
    if (handler) this.prior.onSubmit = handler;
    else delete this.prior.onSubmit;
  }

  get onChange(): (text: string) => void {
    return (text) => this.prior.onChange?.(text);
  }

  set onChange(handler: ((text: string) => void) | undefined) {
    if (handler) this.prior.onChange = handler;
    else delete this.prior.onChange;
  }

  get borderColor(): (str: string) => string {
    return this.prior.borderColor ?? ((text) => text);
  }

  set borderColor(handler: ((str: string) => string) | undefined) {
    if (handler) this.prior.borderColor = handler;
    else delete this.prior.borderColor;
  }

  getText(): string {
    return this.prior.getText();
  }

  setText(text: string): void {
    this.prior.setText(text);
  }

  handleInput(data: string): void {
    if (!this.strip.isFocused && matchesKey(data, Key.shift("down"))) {
      this.strip.setFocused(true);
      this.propagateFocus();
      return;
    }
    if (
      this.strip.isFocused &&
      selectionInput(data, this.strip, this.keybindings, () => this.propagateFocus())
    ) {
      return;
    }
    this.prior.handleInput(data);
  }

  render(width: number): string[] {
    return this.prior.render(width);
  }

  invalidate(): void {
    this.prior.invalidate();
    this.strip.invalidate();
  }

  dispose(): void {
    const disposable = this.prior as EditorComponent & { dispose?: () => void };
    disposable.dispose?.();
  }

  addToHistory(text: string): void {
    this.prior.addToHistory?.(text);
  }

  insertTextAtCursor(text: string): void {
    this.prior.insertTextAtCursor?.(text);
  }

  getExpandedText(): string {
    return this.prior.getExpandedText?.() ?? this.prior.getText();
  }

  setAutocompleteProvider(provider: AutocompleteProviderParameter): void {
    this.prior.setAutocompleteProvider?.(provider);
  }

  setPaddingX(padding: number): void {
    this.prior.setPaddingX?.(padding);
  }

  setAutocompleteMaxVisible(maxVisible: number): void {
    this.prior.setAutocompleteMaxVisible?.(maxVisible);
  }

  private propagateFocus(): void {
    if (isFocusable(this.prior)) this.prior.focused = this.hasFocus && !this.strip.isFocused;
  }
}

class StatusStripEditor extends CustomEditor {
  constructor(
    tui: ConstructorParameters<typeof CustomEditor>[0],
    theme: ConstructorParameters<typeof CustomEditor>[1],
    private readonly selectionKeybindings: KeybindingsManager,
    private readonly strip: SubagentStatusStrip,
  ) {
    super(tui, theme, selectionKeybindings);
  }

  override handleInput(data: string): void {
    if (!this.strip.isFocused && matchesKey(data, Key.shift("down"))) {
      this.strip.setFocused(true);
      this.focused = false;
      return;
    }
    if (
      this.strip.isFocused &&
      selectionInput(data, this.strip, this.selectionKeybindings, () => {
        this.focused = true;
      })
    ) {
      return;
    }
    super.handleInput(data);
  }
}

export function wrapEditorComponent(
  prior: EditorComponent,
  strip: SubagentStatusStrip,
  keybindings: SelectionKeybindings,
): EditorComponent & Focusable & { dispose(): void } {
  return new ComposedEditor(prior, strip, keybindings);
}

export function createStatusEditorFactory(
  previousFactory: EditorFactory | undefined,
  strip: SubagentStatusStrip,
): EditorFactory {
  return (tui, theme, keybindings) => {
    if (previousFactory) {
      return wrapEditorComponent(previousFactory(tui, theme, keybindings), strip, keybindings);
    }
    return new StatusStripEditor(tui, theme, keybindings, strip);
  };
}
