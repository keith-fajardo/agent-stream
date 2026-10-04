import { vi } from 'vitest';

export class EventEmitter<T> {
  private listeners: ((e: T) => void)[] = [];
  event = (listener: (e: T) => void) => {
    this.listeners.push(listener);
    return { dispose: () => (this.listeners = this.listeners.filter((l) => l !== listener)) };
  };
  fire(e: T): void {
    for (const l of [...this.listeners]) l(e);
  }
  dispose(): void {
    this.listeners = [];
  }
}

export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2,
}

export class ThemeIcon {
  constructor(readonly id: string) {}
}

export class TreeItem {
  id?: string;
  description?: string;
  tooltip?: string;
  contextValue?: string;
  iconPath?: unknown;
  command?: { command: string; title: string; arguments?: unknown[] };
  constructor(
    public label: string,
    public collapsibleState: TreeItemCollapsibleState = TreeItemCollapsibleState.None,
  ) {}
}

type FakeUri = { scheme: string; path: string; fsPath: string; toString(): string };
const uri = (path: string): FakeUri => ({ scheme: 'file', path, fsPath: path, toString: () => `file://${path}` });
export const Uri = {
  file: uri,
  parse: (value: string) => uri(value.replace(/^file:\/\//, '')),
  joinPath: (base: FakeUri, ...parts: string[]) => uri([base.path, ...parts].join('/')),
};

export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}

export const window = { showInformationMessage: vi.fn(), showWarningMessage: vi.fn(), showErrorMessage: vi.fn() };
export const env = { openExternal: vi.fn(async (_uri: unknown) => true) };
export const commands = { executeCommand: vi.fn() };
export const workspace = { getConfiguration: vi.fn(() => ({ get: <T>(_key: string, fallback: T) => fallback })) };
export const lm = { selectChatModels: vi.fn() };
export enum ConfigurationTarget { Global = 1, Workspace = 2, WorkspaceFolder = 3 }
export enum LanguageModelChatMessageRole {
  User = 1,
  Assistant = 2,
}
export class LanguageModelTextPart {
  constructor(public value: string) {}
}
export class LanguageModelToolCallPart {
  constructor(
    public callId: string,
    public name: string,
    public input: object,
  ) {}
}
export class LanguageModelToolResultPart {
  constructor(
    public callId: string,
    public content: unknown[],
  ) {}
}
export class LanguageModelDataPart {
  constructor(
    public data: Uint8Array,
    public mimeType: string,
  ) {}
}
export class LanguageModelChatMessage {
  constructor(
    public role: LanguageModelChatMessageRole,
    public content: unknown[] | string,
    public name?: string,
  ) {}
  static User(content: unknown[] | string, name?: string) {
    return new LanguageModelChatMessage(LanguageModelChatMessageRole.User, content, name);
  }
  static Assistant(content: unknown[] | string, name?: string) {
    return new LanguageModelChatMessage(LanguageModelChatMessageRole.Assistant, content, name);
  }
}
/** As in VS Code: `code` is the factory's name ('NoPermissions', 'Blocked', 'NotFound'). */
export class LanguageModelError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'LanguageModelError';
  }
  static NoPermissions(message = '') {
    return new LanguageModelError(message, 'NoPermissions');
  }
  static Blocked(message = '') {
    return new LanguageModelError(message, 'Blocked');
  }
  static NotFound(message = '') {
    return new LanguageModelError(message, 'NotFound');
  }
}
export class CancellationTokenSource {
  private listeners: (() => void)[] = [];
  readonly token = {
    isCancellationRequested: false,
    onCancellationRequested: (listener: () => void) => {
      this.listeners.push(listener);
      return { dispose: () => {} };
    },
  };
  cancel(): void {
    if (this.token.isCancellationRequested) return;
    this.token.isCancellationRequested = true;
    for (const l of this.listeners) l();
  }
  dispose(): void {
    this.listeners = [];
  }
}

export enum DiagnosticSeverity {
  Error = 0,
  Warning = 1,
  Information = 2,
  Hint = 3,
}
export class Range {
  constructor(
    public startLine: number,
    public startCharacter: number,
    public endLine: number,
    public endCharacter: number,
  ) {}
}
export class Diagnostic {
  source?: string;
  constructor(
    public range: Range,
    public message: string,
    public severity: DiagnosticSeverity = DiagnosticSeverity.Error,
  ) {}
}
export class RelativePattern {
  constructor(
    public base: unknown,
    public pattern: string,
  ) {}
}
