/** Test-only Obsidian surface: no filesystem, account, timers, or network access. */
import type { FlomoMemo } from '../sync-core';

interface RequestOptions {
  url: string;
  method?: string;
  headers?: Record<string, string>;
}

interface MockState {
  notices: string[];
  requests: RequestOptions[];
  savedData: unknown[];
}

let memos: FlomoMemo[] = [];
let responses: Array<unknown | Error> | null = null;
let savedInput: unknown = null;
const state: MockState = { notices: [], requests: [], savedData: [] };

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function resetObsidianMock(): void {
  memos = [];
  responses = null;
  savedInput = null;
  clearMockObservations();
}

export function clearMockObservations(): void {
  state.notices.length = 0;
  state.requests.length = 0;
  state.savedData.length = 0;
}

export function setMockMemos(next: FlomoMemo[]): void {
  memos = clone(next);
  responses = null;
}
export function setMockResponses(next: Array<unknown | Error>): void { responses = [...next]; }
export function setLoadedData(data: unknown): void { savedInput = clone(data); }
export function parseYaml(text: string): unknown { return require('js-yaml').load(text); }

export function getMockState(): MockState {
  return clone(state);
}

export class MemoryAdapter {
  readonly files = new Map<string, string>();
  readonly directories = new Set<string>();
  readonly writes: Array<{ path: string; content: string }> = [];
  readonly binaryWrites: string[] = [];
  readonly moves: Array<{ from: string; to: string }> = [];
  readonly trashed: string[] = [];
  allowBinary = false;
  failWritePath = '';
  failMovePath = '';
  failTrashPath = '';

  constructor(initialFiles: Record<string, string> = {}) {
    for (const [path, content] of Object.entries(initialFiles)) this.files.set(path, content);
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.directories.has(path);
  }

  async mkdir(path: string): Promise<void> {
    this.directories.add(path);
  }

  async read(path: string): Promise<string> {
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`Missing in-memory file: ${path}`);
    return content;
  }

  async write(path: string, content: string): Promise<void> {
    if (path === this.failWritePath) throw new Error('Injected write failure');
    this.writes.push({ path, content });
    this.files.set(path, content);
  }

  async writeBinary(path: string): Promise<void> {
    this.binaryWrites.push(path);
    if (!this.allowBinary) throw new Error('Attachment writes are not permitted in these safety tests');
    this.files.set(path, 'mock attachment');
  }
}

export class TFile { constructor(public path: string) {} }
export class TFolder { constructor(public path: string) {} }
export class App {
  readonly vault;
  readonly fileManager;

  constructor(adapter: MemoryAdapter) {
    this.vault = {
      adapter,
      getAbstractFileByPath: (path: string) => adapter.files.has(path) ? new TFile(path) : adapter.directories.has(path) ? new TFolder(path) : null,
      getMarkdownFiles: () => [...adapter.files.keys()].filter(path => path.toLowerCase().endsWith('.md')).map(path => new TFile(path)),
      getAllLoadedFiles: () => [...[...adapter.files.keys()].map(path => new TFile(path)), ...[...adapter.directories].map(path => new TFolder(path))],
      create: async (path: string, content: string) => { if (await adapter.exists(path)) throw new Error('Refusing to overwrite create target'); await adapter.write(path, content); return new TFile(path); },
      process: async (file: TFile, fn: (text: string) => string) => { const content = fn(await adapter.read(file.path)); await adapter.write(file.path, content); return content; },
      trash: async (file: TFile, system: boolean) => {
        if (system) throw new Error('Tests require Obsidian local trash');
        if (file.path === adapter.failTrashPath) throw new Error('Injected trash failure');
        const content = await adapter.read(file.path);
        adapter.files.set(`.trash/${file.path}`, content); adapter.files.delete(file.path); adapter.trashed.push(file.path);
      },
    };
    this.fileManager = { renameFile: async (file: TFile, path: string) => {
      if (file.path === adapter.failMovePath) throw new Error('Injected move failure');
      if (await adapter.exists(path)) throw new Error('Refusing to overwrite move target');
      const content = await adapter.read(file.path);
      adapter.files.set(path, content); adapter.files.delete(file.path); adapter.moves.push({ from: file.path, to: path }); file.path = path;
    } };
  }
}

export class Plugin {
  constructor(public app: App, public manifest: unknown) {}

  async loadData(): Promise<unknown> {
    return clone(savedInput);
  }

  async saveData(data: unknown): Promise<void> {
    state.savedData.push(clone(data));
  }
}

export class Notice {
  constructor(message: string) {
    state.notices.push(message);
  }
}

export const Platform = { isDesktop: false, isMobile: false };

// Settings UI is intentionally not mounted; these exports allow importing main.ts.
export class PluginSettingTab {
  constructor(public app: App, public plugin: Plugin) {}
}

export class Setting {}

export async function requestUrl(options: RequestOptions): Promise<{
  json: unknown;
  arrayBuffer: ArrayBuffer;
}> {
  state.requests.push(clone(options));
  const url = new URL(options.url);
  if (url.origin === 'https://img.example') return { json: null, arrayBuffer: new ArrayBuffer(8) };
  if (
    url.origin !== 'https://flomoapp.com'
    || url.pathname !== '/api/v1/memo/updated/'
    || options.method !== 'GET'
  ) {
    throw new Error(`Unmocked request rejected: ${url.origin}${url.pathname}`);
  }
  if (responses) {
    if (!responses.length) throw new Error('Mock response queue exhausted');
    const next = responses.shift(); if (next instanceof Error) throw next;
    return { json: clone(next), arrayBuffer: new ArrayBuffer(0) };
  }
  return { json: { code: 0, data: clone(memos) }, arrayBuffer: new ArrayBuffer(0) };
}
