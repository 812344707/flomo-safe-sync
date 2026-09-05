import { Notice, Platform, Plugin } from 'obsidian';
import { collectFlomoTags } from './sync-core';
import { fetchAllMemos } from './flomo-api';
import { executeTrash, syncToVault, SyncResult } from './sync-engine';
import { FlomoSafeSyncSettings, migrateSettings } from './settings';
import { FlomoSafeSyncSettingTab } from './settings-tab';

interface ElectronWebContents {
  on(event: string, listener: (...args: unknown[]) => void): void;
  executeJavaScript(code: string): Promise<string | null>;
}

interface ElectronBrowserWindow {
  webContents: ElectronWebContents;
  on(event: string, listener: (...args: unknown[]) => void): void;
  loadURL(url: string): void;
  close(): void;
  isDestroyed(): boolean;
}

interface ElectronBrowserWindowConstructor {
  new (options: Record<string, unknown>): ElectronBrowserWindow;
}

interface ElectronModule {
  remote?: { BrowserWindow?: ElectronBrowserWindowConstructor };
  BrowserWindow?: ElectronBrowserWindowConstructor;
}

export default class FlomoSafeSyncPlugin extends Plugin {
  settings: FlomoSafeSyncSettings;
  syncIntervalId: number | null = null;
  syncRunning = false;
  lastResult: SyncResult | null = null;
  lastErrors: string[] = [];
  readonly internalMoves = new Set<string>();
  private saveQueue: Promise<void> = Promise.resolve();

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addRibbonIcon('sync', '同步 Flomo', () => { void this.runSync(); });
    this.addCommand({ id: 'sync-now', name: '立即安全同步', callback: () => { void this.runSync(); } });
    this.addSettingTab(new FlomoSafeSyncSettingTab(this.app, this, autoLoginFlomo));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => { void this.handleVaultRename(oldPath, file.path); }));
    if (this.settings.autoSyncOnStartup && this.settings.bearerToken) {
      activeWindow.setTimeout(() => { void this.runSync(); }, 3000);
    }
    if (this.settings.autoSyncIntervalMinutes > 0 && this.settings.bearerToken) this.startIntervalSync();
  }
  onunload(): void { this.stopIntervalSync(); }
  startIntervalSync(): void {
    this.stopIntervalSync();
    const milliseconds = this.settings.autoSyncIntervalMinutes * 60000;
    if (milliseconds > 0 && this.settings.bearerToken) {
      this.syncIntervalId = activeWindow.setInterval(() => { void this.runSync(); }, milliseconds);
      this.registerInterval(this.syncIntervalId);
    }
  }
  stopIntervalSync(): void {
    if (this.syncIntervalId !== null) activeWindow.clearInterval(this.syncIntervalId);
    this.syncIntervalId = null;
  }
  private token(): string {
    return this.settings.bearerToken.startsWith('Bearer ') ? this.settings.bearerToken : `Bearer ${this.settings.bearerToken}`;
  }
  private captureSettings(): FlomoSafeSyncSettings {
    return { ...JSON.parse(JSON.stringify(this.settings)), syncedMemos: this.settings.syncedMemos };
  }
  async runSync(): Promise<void> {
    if (this.syncRunning) { new Notice('Flomo 安全同步正在运行，请稍候。'); return; }
    if (!this.settings.bearerToken) { new Notice('请先在设置中登录 Flomo。'); return; }
    this.syncRunning = true;
    this.lastErrors = [];
    try {
      new Notice('Flomo 安全同步：正在读取…');
      const token = this.token();
      const settings = this.captureSettings();
      const memos = await fetchAllMemos(token);
      const result = await syncToVault(this.app, settings, memos, token, () => this.saveSettings(), this.internalMoves);
      this.settings.availableFlomoTags = collectFlomoTags(memos);
      this.settings.lastSyncTime = settings.lastSyncTime;
      this.lastResult = result;
      this.lastErrors = result.errors;
      await this.saveSettings();
      const counts: Array<[string, number]> = [['新增', result.newCount], ['更新', result.updatedCount], ['冻结', result.frozenCount],
        ['排除', result.skippedCount], ['范围外', result.unmappedCount], ['标记删除', result.deletedMarkedCount],
        ['归档', result.archivedCount], ['待移入回收站', result.pendingTrashCount], ['冲突', result.conflictCount], ['附件失败', result.assetErrorCount]];
      new Notice(`Flomo 安全同步完成：${counts.filter(([, n]) => n).map(([label, n]) => `${label} ${n}`).join('，') || '没有变化'}（共 ${result.total} 条）`);
    } catch (error) {
      this.lastErrors = [(error as Error).message];
      new Notice(`Flomo 安全同步失败：${(error as Error).message}`);
    } finally { this.syncRunning = false; }
  }
  async trashSelected(paths: string[]): Promise<void> {
    if (this.syncRunning) { new Notice('同步正在运行，请稍后处理回收站列表。'); return; }
    if (!this.settings.bearerToken || paths.length === 0) return;
    this.syncRunning = true;
    this.lastErrors = [];
    try {
      const snapshot = await fetchAllMemos(this.token());
      const result = await executeTrash(this.app, this.settings, paths, snapshot, () => this.saveSettings(), this.internalMoves);
      this.lastErrors = result.errors;
      new Notice(`已移入 Obsidian 回收站 ${result.moved} 篇${result.errors.length ? `，冲突 ${result.errors.length}` : ''}。附件继续保留。`);
    } catch (error) {
      this.lastErrors = [(error as Error).message];
      new Notice(`回收站操作未完成：${(error as Error).message}`);
    } finally { this.syncRunning = false; }
  }
  async refreshAvailableFlomoTags(): Promise<number> {
    if (!this.settings.bearerToken) throw new Error('请先登录 Flomo');
    const memos = await fetchAllMemos(this.token());
    this.settings.availableFlomoTags = collectFlomoTags(memos);
    await this.saveSettings();
    return this.settings.availableFlomoTags.length;
  }
  async loadSettings(): Promise<void> { this.settings = migrateSettings(await this.loadData() || {}); }
  async saveSettings(): Promise<void> {
    const snapshot = JSON.parse(JSON.stringify(this.settings));
    const saved = this.saveQueue.catch(() => {}).then(() => this.saveData(snapshot));
    this.saveQueue = saved;
    await saved;
  }
  private async handleVaultRename(oldPath: string, newPath: string): Promise<void> {
    if (this.internalMoves.has(oldPath)) return;
    const replace = (path: string): string => path === oldPath ? newPath : path.startsWith(`${oldPath}/`) ? `${newPath}${path.slice(oldPath.length)}` : path;
    let changed = false;
    for (const record of Object.values(this.settings.syncedMemos)) {
      const next = record.filePaths.map(replace);
      if (next.some((path, i) => path !== record.filePaths[i])) { record.filePaths = next; changed = true; }
      for (const file of record.fileStates || []) {
        const path = replace(file.path);
        if (path !== file.path) { file.path = path; changed = true; }
      }
      if (record.assetFolder && replace(record.assetFolder) !== record.assetFolder) { record.assetFolder = replace(record.assetFolder); changed = true; }
      if (record.assetMap) {
        for (const [source, destination] of Object.entries(record.assetMap)) {
          const next = replace(destination);
          if (next !== destination) { record.assetMap[source] = next; changed = true; }
        }
      }
    }
    if (changed) await this.saveSettings();
  }
}

async function autoLoginFlomo(): Promise<string | null> {
  if (!Platform.isDesktop) {
    new Notice('自动登录仅支持桌面版 Obsidian。');
    return null;
  }
  const electron = window.require('electron') as ElectronModule;
  const BrowserWindow = electron.remote?.BrowserWindow ?? electron.BrowserWindow;
  if (!BrowserWindow) {
    new Notice('无法打开 Flomo 登录窗口。');
    return null;
  }

  return new Promise(resolve => {
    const loginWindow = new BrowserWindow({
      width: 460,
      height: 700,
      title: '登录 Flomo',
      webPreferences: { nodeIntegration: false, contextIsolation: false },
    });
    let resolved = false;
    let pollInterval: ReturnType<typeof activeWindow.setInterval> | null = null;
    const cleanup = () => {
      if (pollInterval !== null) activeWindow.clearInterval(pollInterval);
      pollInterval = null;
    };
    const extractTokenScript = `
      (function() {
        var keys = Object.keys(localStorage || {});
        for (var i = 0; i < keys.length; i++) {
          var val = localStorage.getItem(keys[i]);
          if (!val || typeof val !== 'string') continue;
          if (val.match(/^\\d+\\|[A-Za-z0-9]/) || val.match(/^Bearer /)) return val;
          try {
            var obj = JSON.parse(val);
            if (obj && obj.token) return obj.token;
            if (obj && obj.access_token) return obj.access_token;
            if (obj && obj.authorization) return obj.authorization;
          } catch(e) {}
        }
        var cookies = document.cookie.split(';');
        for (var j = 0; j < cookies.length; j++) {
          var c = cookies[j].trim();
          if (c.startsWith('token=') || c.startsWith('authorization=')) {
            return c.split('=').slice(1).join('=');
          }
        }
        return null;
      })()
    `;
    const startPolling = () => {
      if (pollInterval !== null) return;
      pollInterval = activeWindow.setInterval(() => {
        if (resolved || loginWindow.isDestroyed()) {
          cleanup();
          return;
        }
        loginWindow.webContents.executeJavaScript(extractTokenScript)
          .then((token: string | null) => {
            if (!token || token.length <= 10 || resolved) return;
            resolved = true;
            cleanup();
            const bearerToken = token.startsWith('Bearer ') ? token : `Bearer ${token}`;
            resolve(bearerToken);
            activeWindow.setTimeout(() => {
              if (!loginWindow.isDestroyed()) loginWindow.close();
            }, 500);
          })
          .catch(() => undefined);
      }, 2000);
    };
    loginWindow.webContents.on('did-finish-load', startPolling);
    loginWindow.on('closed', () => {
      cleanup();
      if (!resolved) resolve(null);
    });
    loginWindow.loadURL('https://v.flomoapp.com/login');
  });
}
