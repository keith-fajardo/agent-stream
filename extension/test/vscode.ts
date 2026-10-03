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
export const commands = { executeCommand: vi.fn() };
export const workspace = { getConfiguration: vi.fn(() => ({ get: <T>(_key: string, fallback: T) => fallback })) };
export const lm = { selectChatModels: vi.fn() };
export enum ConfigurationTarget { Global = 1, Workspace = 2, WorkspaceFolder = 3 }
