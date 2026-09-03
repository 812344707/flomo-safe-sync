import { App, Notice, Platform, Plugin, PluginSettingTab, Setting, TFolder, requestUrl } from 'obsidian';
import { createHash } from 'crypto';
import {
  ExcludedPolicy,
  FlomoMemo,
  TagFolderMapping,
  buildNewMemoFile,
  collectFlomoTags,
  computeDesiredPaths,
  extractImageSources,
  extractTags,
  findTagFolderMapping,
  findTagFolderMappingForTags,
  fileNameFromUrl,
  mergeManagedMemo,
  memoMatchesExcludedTags,
  normalizeTag,
  normalizeTagList,
  normalizeVaultPath,
  renderFileName,
  sanitizePathSegment,
  updateManagedStatus,
  validateFileNameTemplate,
  validateVaultRelativePath,
  validateYamlTemplate,
} from './sync-core';

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

type MemoRecordStatus = 'active' | 'deleted';

interface SyncedMemoRecord {
  updated_at: string;
  fileName: string;
  filePaths: string[];
  status?: MemoRecordStatus;
  excluded?: boolean;
  outOfScope?: boolean;
  lastKnownTags?: string[];
  lastAppliedFlomoTags?: string[];
  tagsMerged?: boolean;
  assetFolder?: string;
  deletedDetectedAt?: string;
}

interface FlomoSafeSyncSettings {
  bearerToken: string;
  rootFolder: string;
  fileNameTemplate: string;
  yamlTemplate: string;
  tagFolderMappings: TagFolderMapping[];
  availableFlomoTags: string[];
  excludedTags: string[];
  excludedPolicy: ExcludedPolicy;
  localizeImages: boolean;
  autoSyncOnStartup: boolean;
  autoSyncIntervalMinutes: number;
  lastSyncTime: number;
  syncedMemos: Record<string, SyncedMemoRecord>;
  flomoFolder?: string;
  syncedSlugs?: string[];
}

interface SyncResult {
  total: number;
  newCount: number;
  updatedCount: number;
  frozenCount: number;
  skippedCount: number;
  unmappedCount: number;
  deletedMarkedCount: number;
  conflictCount: number;
  assetErrorCount: number;
}

interface AssetResult {
  imageMap: Record<string, string>;
  attachmentPaths: string[];
  errorCount: number;
}

const DEFAULT_SETTINGS: FlomoSafeSyncSettings = {
  bearerToken: '',
  rootFolder: '00-Flomo收件箱',
  fileNameTemplate: '{{date}}_{{time}}_{{title:20}}_{{slug:8}}',
  yamlTemplate: '',
  tagFolderMappings: [],
  availableFlomoTags: [],
  excludedTags: [],
  excludedPolicy: 'freeze',
  localizeImages: true,
  autoSyncOnStartup: false,
  autoSyncIntervalMinutes: 60,
  lastSyncTime: 0,
  syncedMemos: {},
};

const FLOMO_API_URL = 'https://flomoapp.com/api/v1/memo/updated/';
const FLOMO_SALT = 'dbbc3dd73364b4084c3a69346e0ce2b2';
const FLOMO_LIMIT = 200;

function buildSignedParams(extra: Record<string, string> = {}): Record<string, string> {
  const params: Record<string, string> = {
    limit: String(FLOMO_LIMIT),
    tz: '8:0',
    timestamp: String(Math.floor(Date.now() / 1000)),
    api_key: 'flomo_web',
    app_version: '5.25.64',
    platform: 'mac',
    webp: '1',
    ...extra,
  };
  const paramStr = Object.keys(params).sort().map(key => `${key}=${params[key]}`).join('&');
  params.sign = createHash('md5').update(paramStr + FLOMO_SALT).digest('hex');
  return params;
}

async function fetchMemos(token: string, latestSlug?: string, latestUpdatedAt?: number): Promise<FlomoMemo[]> {
  const extra: Record<string, string> = {};
  if (latestSlug && latestUpdatedAt) {
    extra.latest_slug = latestSlug;
    extra.latest_updated_at = String(latestUpdatedAt);
  }
  const params = buildSignedParams(extra);
  const query = Object.entries(params).map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');
  const response = await requestUrl({
    url: `${FLOMO_API_URL}?${query}`,
    method: 'GET',
    headers: { Authorization: token },
  });
  const data = response.json as { code: number; data?: FlomoMemo[] };
  if (data.code !== 0) throw new Error(`Flomo API error: ${JSON.stringify(data)}`);
  return data.data || [];
}

async function fetchAllMemos(token: string): Promise<FlomoMemo[]> {
  const allMemos: FlomoMemo[] = [];
  let page = await fetchMemos(token);
  allMemos.push(...page);
  while (page.length >= FLOMO_LIMIT) {
    const last = page[page.length - 1];
    const timestamp = Math.floor(new Date(last.updated_at).getTime() / 1000);
    page = await fetchMemos(token, last.slug, timestamp);
    allMemos.push(...page);
  }
  return allMemos;
}

async function ensureDir(app: App, dirPath: string): Promise<void> {
  const normalized = normalizeVaultPath(dirPath);
  let current = '';
  for (const part of normalized.split('/')) {
    current = current ? `${current}/${part}` : part;
    if (!(await app.vault.adapter.exists(current))) await app.vault.adapter.mkdir(current);
  }
}

async function ensureParentDir(app: App, filePath: string): Promise<void> {
  const slash = filePath.lastIndexOf('/');
  if (slash > 0) await ensureDir(app, filePath.slice(0, slash));
}

function addFileNameSuffix(filePath: string, suffix: string): string {
  const dot = filePath.toLowerCase().endsWith('.md') ? filePath.length - 3 : filePath.length;
  return `${filePath.slice(0, dot)}_${suffix}${filePath.slice(dot)}`;
}

function claimedPaths(settings: FlomoSafeSyncSettings): Set<string> {
  return new Set(Object.values(settings.syncedMemos).flatMap(record => record.filePaths || []));
}

async function resolveUniquePaths(
  app: App,
  candidates: string[],
  slug: string,
  settings: FlomoSafeSyncSettings,
): Promise<string[]> {
  const claimed = claimedPaths(settings);
  const resolved: string[] = [];
  for (const candidate of candidates) {
    let next = candidate;
    let counter = 1;
    while (claimed.has(next) || resolved.includes(next) || await app.vault.adapter.exists(next)) {
      const suffix = counter === 1 ? slug.slice(0, 8) : `${slug.slice(0, 8)}-${counter}`;
      next = addFileNameSuffix(candidate, suffix);
      counter++;
    }
    resolved.push(next);
  }
  return resolved;
}

function assetRequestHeaders(url: string, token: string): Record<string, string> | undefined {
  try {
    const host = new URL(url).hostname;
    return host === 'flomoapp.com' || host.endsWith('.flomoapp.com') ? { Authorization: token } : undefined;
  } catch (_error) {
    return undefined;
  }
}

async function localizeMemoAssets(
  app: App,
  memo: FlomoMemo,
  assetFolder: string,
  token: string,
  enabled: boolean,
): Promise<AssetResult> {
  if (!enabled) return { imageMap: {}, attachmentPaths: [], errorCount: 0 };
  const sources = [...extractImageSources(memo.content)];
  for (const file of memo.files || []) {
    if (file.url && !sources.includes(file.url)) sources.push(file.url);
  }
  if (sources.length === 0) return { imageMap: {}, attachmentPaths: [], errorCount: 0 };

  await ensureDir(app, assetFolder);
  const imageMap: Record<string, string> = {};
  const attachmentPaths: string[] = [];
  let errorCount = 0;
  for (let index = 0; index < sources.length; index++) {
    const source = sources[index];
    const namedFile = (memo.files || []).find(file => file.url === source)?.name;
    const rawName = namedFile ? sanitizePathSegment(namedFile) : fileNameFromUrl(source, index + 1);
    const target = `${assetFolder}/${String(index + 1).padStart(2, '0')}-${rawName}`;
    try {
      if (!(await app.vault.adapter.exists(target))) {
        const response = await requestUrl({
          url: source,
          method: 'GET',
          headers: assetRequestHeaders(source, token),
        });
        await app.vault.adapter.writeBinary(target, response.arrayBuffer);
      }
      imageMap[source] = target;
      attachmentPaths.push(target);
    } catch (error) {
      errorCount++;
      console.warn(`[Flomo Safe Sync] Failed to download attachment: ${source}`, error);
    }
  }
  return { imageMap, attachmentPaths, errorCount };
}

function assetFolderForMemo(settings: FlomoSafeSyncSettings, memo: FlomoMemo): string {
  return `${normalizeVaultPath(settings.rootFolder)}/_attachments/flomo/${sanitizePathSegment(memo.slug)}`;
}

async function createMemoFiles(
  app: App,
  memo: FlomoMemo,
  settings: FlomoSafeSyncSettings,
  token: string,
  excluded: boolean,
): Promise<{ record: SyncedMemoRecord; assetErrorCount: number }> {
  const candidates = computeDesiredPaths(memo, settings);
  if (candidates.length === 0) throw new Error(`memo ${memo.slug} 未命中任何标签文件夹映射`);
  const filePaths = await resolveUniquePaths(app, candidates, memo.slug, settings);
  const assetFolder = assetFolderForMemo(settings, memo);
  const assets = await localizeMemoAssets(app, memo, assetFolder, token, settings.localizeImages);
  const syncedAt = new Date().toISOString();
  const content = buildNewMemoFile(memo, {
    syncedAt,
    syncPolicy: excluded ? 'excluded' : 'managed',
    imageMap: assets.imageMap,
    extraAttachmentPaths: assets.attachmentPaths,
    yamlTemplate: settings.yamlTemplate,
  });
  for (const filePath of filePaths) {
    await ensureParentDir(app, filePath);
    await app.vault.adapter.write(filePath, content);
  }
  return {
    record: {
      updated_at: memo.updated_at,
      fileName: renderFileName(settings.fileNameTemplate, memo),
      filePaths,
      status: 'active',
      excluded,
      lastKnownTags: extractTags(memo),
      lastAppliedFlomoTags: extractTags(memo),
      tagsMerged: true,
      assetFolder,
    },
    assetErrorCount: assets.errorCount,
  };
}

async function updateMemoFiles(
  app: App,
  memo: FlomoMemo,
  record: SyncedMemoRecord,
  settings: FlomoSafeSyncSettings,
  token: string,
): Promise<{ success: boolean; conflictCount: number; assetErrorCount: number }> {
  const assetFolder = record.assetFolder || assetFolderForMemo(settings, memo);
  const assets = await localizeMemoAssets(app, memo, assetFolder, token, settings.localizeImages);
  const syncedAt = new Date().toISOString();
  let conflictCount = 0;

  for (const filePath of record.filePaths) {
    await ensureParentDir(app, filePath);
    if (!(await app.vault.adapter.exists(filePath))) {
      await app.vault.adapter.write(filePath, buildNewMemoFile(memo, {
        syncedAt,
        imageMap: assets.imageMap,
        extraAttachmentPaths: assets.attachmentPaths,
        yamlTemplate: settings.yamlTemplate,
      }));
      continue;
    }
    const current = await app.vault.adapter.read(filePath);
    const merged = mergeManagedMemo(current, memo, {
      syncedAt,
      imageMap: assets.imageMap,
      extraAttachmentPaths: assets.attachmentPaths,
      previousFlomoTags: record.lastAppliedFlomoTags || record.lastKnownTags,
    });
    if (!merged.ok) {
      conflictCount++;
      console.warn(`[Flomo Safe Sync] ${filePath}: ${merged.reason}`);
      continue;
    }
    await app.vault.adapter.write(filePath, merged.content);
  }

  return { success: conflictCount === 0, conflictCount, assetErrorCount: assets.errorCount };
}

async function updateRecordStatusFiles(
  app: App,
  record: SyncedMemoRecord,
  status: MemoRecordStatus,
  syncPolicy: 'managed' | 'excluded',
  detectedAt?: string,
): Promise<number> {
  let conflictCount = 0;
  const syncedAt = new Date().toISOString();
  for (const filePath of record.filePaths) {
    if (!(await app.vault.adapter.exists(filePath))) continue;
    const current = await app.vault.adapter.read(filePath);
    const merged = updateManagedStatus(current, status, syncPolicy, syncedAt, detectedAt);
    if (!merged.ok) {
      conflictCount++;
      console.warn(`[Flomo Safe Sync] ${filePath}: ${merged.reason}`);
      continue;
    }
    await app.vault.adapter.write(filePath, merged.content);
  }
  return conflictCount;
}

async function syncToVault(
  app: App,
  settings: FlomoSafeSyncSettings,
  memos: FlomoMemo[],
  token: string,
): Promise<SyncResult> {
  const rootError = validateVaultRelativePath(settings.rootFolder);
  const templateError = validateFileNameTemplate(settings.fileNameTemplate);
  const yamlTemplateError = validateYamlTemplate(settings.yamlTemplate);
  if (rootError) throw new Error(`保存目录无效：${rootError}`);
  if (templateError) throw new Error(`文件名模板无效：${templateError}`);
  if (yamlTemplateError) throw new Error(`YAML 模板无效：${yamlTemplateError}`);
  for (const mapping of settings.tagFolderMappings) {
    if (!normalizeTag(mapping.tag)) throw new Error('标签文件夹映射中存在空标签');
    const mappingError = validateVaultRelativePath(mapping.folder);
    if (mappingError) throw new Error(`标签“${mapping.tag}”的目录无效：${mappingError}`);
  }

  const result: SyncResult = {
    total: memos.length,
    newCount: 0,
    updatedCount: 0,
    frozenCount: 0,
    skippedCount: 0,
    unmappedCount: 0,
    deletedMarkedCount: 0,
    conflictCount: 0,
    assetErrorCount: 0,
  };
  const apiSlugs = new Set(memos.map(memo => memo.slug));

  for (const memo of memos) {
    const existing = settings.syncedMemos[memo.slug];
    const mapping = findTagFolderMapping(memo, settings.tagFolderMappings);
    if (!mapping) {
      if (existing) {
        existing.outOfScope = true;
        existing.lastKnownTags = extractTags(memo);
      }
      result.unmappedCount++;
      continue;
    }

    const wasOutOfScope = Boolean(existing?.outOfScope);
    const isExcluded = Boolean(memoMatchesExcludedTags(memo, settings.excludedTags));

    if (isExcluded && settings.excludedPolicy === 'skip') {
      if (existing) {
        existing.excluded = true;
        existing.outOfScope = false;
        existing.lastKnownTags = extractTags(memo);
        if (existing.status === 'deleted') {
          const conflicts = await updateRecordStatusFiles(app, existing, 'active', 'excluded');
          result.conflictCount += conflicts;
          if (conflicts === 0) existing.status = 'active';
        }
      }
      result.skippedCount++;
      continue;
    }

    if (isExcluded && settings.excludedPolicy === 'freeze') {
      if (!existing) {
        const created = await createMemoFiles(app, memo, settings, token, true);
        settings.syncedMemos[memo.slug] = created.record;
        result.assetErrorCount += created.assetErrorCount;
        result.newCount++;
      } else {
        existing.excluded = true;
        existing.outOfScope = false;
        existing.lastKnownTags = extractTags(memo);
        if (existing.status === 'deleted') {
          const conflicts = await updateRecordStatusFiles(app, existing, 'active', 'excluded');
          result.conflictCount += conflicts;
          if (conflicts === 0) existing.status = 'active';
        }
      }
      result.frozenCount++;
      continue;
    }

    if (!existing) {
      const created = await createMemoFiles(app, memo, settings, token, false);
      settings.syncedMemos[memo.slug] = created.record;
      result.assetErrorCount += created.assetErrorCount;
      result.newCount++;
      continue;
    }

    const shouldUpdate = existing.updated_at !== memo.updated_at
      || existing.excluded
      || wasOutOfScope
      || existing.status === 'deleted'
      || existing.tagsMerged !== true;
    if (shouldUpdate) {
      const update = await updateMemoFiles(app, memo, existing, settings, token);
      result.conflictCount += update.conflictCount;
      result.assetErrorCount += update.assetErrorCount;
      if (update.success) {
        existing.updated_at = memo.updated_at;
        existing.status = 'active';
        existing.excluded = false;
        existing.outOfScope = false;
        existing.deletedDetectedAt = undefined;
        existing.lastKnownTags = extractTags(memo);
        existing.lastAppliedFlomoTags = extractTags(memo);
        existing.tagsMerged = true;
        existing.assetFolder = existing.assetFolder || assetFolderForMemo(settings, memo);
        result.updatedCount++;
      }
    } else {
      existing.outOfScope = false;
      existing.lastKnownTags = extractTags(memo);
    }
  }

  for (const [slug, record] of Object.entries(settings.syncedMemos)) {
    if (apiSlugs.has(slug) || record.status === 'deleted') continue;
    if (record.outOfScope || !findTagFolderMappingForTags(record.lastKnownTags || [], settings.tagFolderMappings)) continue;
    const detectedAt = new Date().toISOString();
    const conflicts = await updateRecordStatusFiles(
      app,
      record,
      'deleted',
      record.excluded ? 'excluded' : 'managed',
      detectedAt,
    );
    result.conflictCount += conflicts;
    if (conflicts === 0) {
      record.status = 'deleted';
      record.deletedDetectedAt = detectedAt;
      result.deletedMarkedCount++;
    }
  }

  settings.lastSyncTime = Date.now();
  return result;
}

export default class FlomoSafeSyncPlugin extends Plugin {
  settings: FlomoSafeSyncSettings;
  syncIntervalId: number | null = null;
  syncRunning = false;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addRibbonIcon('sync', '同步 Flomo', () => { void this.runSync(); });
    this.addCommand({ id: 'sync-now', name: '立即安全同步', callback: () => { void this.runSync(); } });
    this.addSettingTab(new FlomoSafeSyncSettingTab(this.app, this));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      void this.handleVaultRename(oldPath, file.path);
    }));
    if (this.settings.autoSyncOnStartup && this.settings.bearerToken) {
      activeWindow.setTimeout(() => { void this.runSync(); }, 3000);
    }
    if (this.settings.autoSyncIntervalMinutes > 0 && this.settings.bearerToken) this.startIntervalSync();
  }

  onunload(): void {
    this.stopIntervalSync();
  }

  startIntervalSync(): void {
    this.stopIntervalSync();
    const milliseconds = this.settings.autoSyncIntervalMinutes * 60 * 1000;
    if (milliseconds > 0) {
      this.syncIntervalId = activeWindow.setInterval(() => { void this.runSync(); }, milliseconds);
      this.registerInterval(this.syncIntervalId);
    }
  }

  stopIntervalSync(): void {
    if (this.syncIntervalId !== null) {
      activeWindow.clearInterval(this.syncIntervalId);
      this.syncIntervalId = null;
    }
  }

  async runSync(): Promise<void> {
    if (this.syncRunning) {
      new Notice('Flomo 安全同步正在运行，请稍候。');
      return;
    }
    if (!this.settings.bearerToken) {
      new Notice('请先在设置中登录 Flomo。');
      return;
    }

    this.syncRunning = true;
    const token = this.settings.bearerToken.startsWith('Bearer ')
      ? this.settings.bearerToken
      : `Bearer ${this.settings.bearerToken}`;
    try {
      new Notice('Flomo 安全同步：正在读取…');
      const memos = await fetchAllMemos(token);
      this.settings.availableFlomoTags = collectFlomoTags(memos);
      const result = await syncToVault(this.app, this.settings, memos, token);
      await this.saveSettings();
      const parts: string[] = [];
      if (result.newCount) parts.push(`新增 ${result.newCount}`);
      if (result.updatedCount) parts.push(`更新 ${result.updatedCount}`);
      if (result.frozenCount) parts.push(`冻结 ${result.frozenCount}`);
      if (result.skippedCount) parts.push(`排除 ${result.skippedCount}`);
      if (result.unmappedCount) parts.push(`未映射 ${result.unmappedCount}`);
      if (result.deletedMarkedCount) parts.push(`标记删除 ${result.deletedMarkedCount}`);
      if (result.conflictCount) parts.push(`冲突 ${result.conflictCount}`);
      if (result.assetErrorCount) parts.push(`附件失败 ${result.assetErrorCount}`);
      new Notice(`Flomo 安全同步完成：${parts.join('，') || '没有变化'}（共 ${result.total} 条）`);
    } catch (error) {
      console.error('Flomo Safe Sync error:', error);
      new Notice(`Flomo 安全同步失败：${(error as Error).message}`);
    } finally {
      this.syncRunning = false;
    }
  }

  async refreshAvailableFlomoTags(): Promise<number> {
    if (!this.settings.bearerToken) throw new Error('请先登录 Flomo');
    const token = this.settings.bearerToken.startsWith('Bearer ')
      ? this.settings.bearerToken
      : `Bearer ${this.settings.bearerToken}`;
    const memos = await fetchAllMemos(token);
    this.settings.availableFlomoTags = collectFlomoTags(memos);
    await this.saveSettings();
    return this.settings.availableFlomoTags.length;
  }

  async loadSettings(): Promise<void> {
    const loaded = (await this.loadData()) as Partial<FlomoSafeSyncSettings> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded || {});
    if (!loaded?.rootFolder && loaded?.flomoFolder) this.settings.rootFolder = loaded.flomoFolder;
    this.settings.excludedTags = normalizeTagList(this.settings.excludedTags || []);
    this.settings.availableFlomoTags = normalizeTagList(this.settings.availableFlomoTags || []);
    this.settings.tagFolderMappings = (this.settings.tagFolderMappings || []).map(mapping => ({
      tag: normalizeTag(mapping.tag),
      folder: mapping.folder,
    })).filter(mapping => Boolean(mapping.tag));
    this.settings.yamlTemplate = this.settings.yamlTemplate || '';
    this.settings.syncedMemos = this.settings.syncedMemos || {};
    if (this.settings.syncedSlugs?.length && Object.keys(this.settings.syncedMemos).length === 0) {
      this.settings.syncedMemos = {};
      delete this.settings.syncedSlugs;
    }
    for (const record of Object.values(this.settings.syncedMemos)) {
      record.status = record.status || 'active';
      record.excluded = Boolean(record.excluded);
      record.outOfScope = Boolean(record.outOfScope);
      record.filePaths = record.filePaths || [];
      record.lastKnownTags = normalizeTagList(record.lastKnownTags || []);
      if (record.lastAppliedFlomoTags) {
        record.lastAppliedFlomoTags = normalizeTagList(record.lastAppliedFlomoTags);
      }
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  private async handleVaultRename(oldPath: string, newPath: string): Promise<void> {
    let changed = false;
    const replacePrefix = (path: string): string => {
      if (path === oldPath) return newPath;
      if (path.startsWith(`${oldPath}/`)) return `${newPath}${path.slice(oldPath.length)}`;
      return path;
    };

    for (const record of Object.values(this.settings.syncedMemos)) {
      const nextPaths = record.filePaths.map(replacePrefix);
      if (nextPaths.some((path, index) => path !== record.filePaths[index])) {
        record.filePaths = nextPaths;
        record.fileName = nextPaths[0]?.split('/').pop()?.replace(/\.md$/i, '') || record.fileName;
        changed = true;
      }
      if (record.assetFolder) {
        const nextAssetFolder = replacePrefix(record.assetFolder);
        if (nextAssetFolder !== record.assetFolder) {
          record.assetFolder = nextAssetFolder;
          changed = true;
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

const SAMPLE_MEMO: FlomoMemo = {
  slug: 'a1b2c3d4e5f6',
  content: '<p>记录一个新的写作想法</p>',
  tags: [{ name: '写作' }, { name: '素材' }],
  created_at: '2026-09-01 14:32:08',
  updated_at: '2026-09-01 14:32:08',
};

class FlomoSafeSyncSettingTab extends PluginSettingTab {
  plugin: FlomoSafeSyncPlugin;
  private suggestionListId = 0;

  constructor(app: App, plugin: FlomoSafeSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  private vaultFolderPaths(): string[] {
    return this.app.vault.getAllLoadedFiles()
      .filter((file): file is TFolder => file instanceof TFolder && Boolean(file.path))
      .map(folder => folder.path)
      .sort((left, right) => left.localeCompare(right, 'zh-CN'));
  }

  private addSuggestions(
    setting: Setting,
    input: HTMLInputElement,
    values: string[],
    kind: 'folder' | 'tag',
  ): void {
    const id = `flomo-safe-sync-${kind}-${this.suggestionListId++}`;
    input.setAttribute('list', id);
    const list = setting.settingEl.createEl('datalist', { attr: { id } });
    for (const value of [...new Set(values)].filter(Boolean)) {
      list.createEl('option', { attr: { value } });
    }
  }

  private mappingError(mapping: TagFolderMapping, indexToIgnore = -1): string | null {
    const tag = normalizeTag(mapping.tag);
    if (!tag) return '请选择或输入 Flomo 标签';
    const folderError = validateVaultRelativePath(mapping.folder);
    if (folderError) return folderError;
    const duplicate = this.plugin.settings.tagFolderMappings.some(
      (item, index) => index !== indexToIgnore && normalizeTag(item.tag) === tag,
    );
    return duplicate ? `标签“${tag}”已经设置过` : null;
  }

  private async updateMapping(index: number, mapping: TagFolderMapping, setting: Setting): Promise<void> {
    const error = this.mappingError(mapping, index);
    if (error) {
      setting.setDesc(`未保存：${error}`);
      return;
    }
    this.plugin.settings.tagFolderMappings[index] = {
      tag: normalizeTag(mapping.tag),
      folder: normalizeVaultPath(mapping.folder),
    };
    await this.plugin.saveSettings();
    setting.setDesc('已保存；顺序靠前的映射优先。旧笔记不会自动搬家。');
  }

  private async moveMapping(index: number, offset: -1 | 1): Promise<void> {
    const target = index + offset;
    if (target < 0 || target >= this.plugin.settings.tagFolderMappings.length) return;
    const mappings = this.plugin.settings.tagFolderMappings;
    [mappings[index], mappings[target]] = [mappings[target], mappings[index]];
    await this.plugin.saveSettings();
    this.display();
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass('flomo-safe-sync-settings');
    let previewSetting: Setting;

    new Setting(containerEl).setName('Flomo 连接').setHeading();
    if (Platform.isDesktop) {
      new Setting(containerEl)
        .setName('登录 Flomo')
        .setDesc('登录成功后会读取当前 memo 中的标签，令牌仅保存在本地插件数据中。')
        .addButton(button => button.setButtonText(this.plugin.settings.bearerToken ? '重新登录' : '登录').setCta().onClick(async () => {
          button.setDisabled(true).setButtonText('等待登录…');
          try {
            const token = await autoLoginFlomo();
            if (token) {
              this.plugin.settings.bearerToken = token;
              await this.plugin.saveSettings();
              button.setButtonText('正在读取标签…');
              try {
                const count = await this.plugin.refreshAvailableFlomoTags();
                new Notice(`Flomo 登录成功，已读取 ${count} 个标签。`);
              } catch (error) {
                new Notice(`登录信息已保存，但标签读取失败：${(error as Error).message}`);
              }
            }
          } finally {
            this.display();
          }
        }));
    }

    new Setting(containerEl).setName('保存位置与文件名').setHeading();
    const rootFolderSetting = new Setting(containerEl)
      .setName('默认保存根目录')
      .setDesc('作为新增映射的默认文件夹和附件根目录；输入关键词可筛选当前 Vault 文件夹，也可直接输入新路径。');
    rootFolderSetting.addText(text => {
      text.inputEl.addClass('flomo-sync-wide-input');
      text.inputEl.setAttribute('aria-label', '默认保存根目录');
      this.addSuggestions(rootFolderSetting, text.inputEl, this.vaultFolderPaths(), 'folder');
      return text.setPlaceholder('输入或选择 Vault 文件夹').setValue(this.plugin.settings.rootFolder).onChange(async value => {
        const nextRootFolder = value.trim() || DEFAULT_SETTINGS.rootFolder;
        const error = validateVaultRelativePath(nextRootFolder);
        if (error) {
          rootFolderSetting.setDesc(`设置无效：${error}。未保存，仍使用 ${this.plugin.settings.rootFolder}`);
          return;
        }
        this.plugin.settings.rootFolder = normalizeVaultPath(nextRootFolder);
        await this.plugin.saveSettings();
        rootFolderSetting.setDesc('已保存。输入关键词可继续快捷筛选 Vault 文件夹。');
        if (previewSetting) this.renderPreview(previewSetting);
      });
    });

    new Setting(containerEl)
      .setName('文件名模板')
      .setDesc('变量：{{YYYY-MM-DD-HHmmss}}、{{date}}、{{time}}、{{title:20}}、{{slug:8}}、{{first_tag}}。')
      .addText(text => text.setValue(this.plugin.settings.fileNameTemplate).onChange(async value => {
        const nextTemplate = value.trim() || DEFAULT_SETTINGS.fileNameTemplate;
        const error = validateFileNameTemplate(nextTemplate);
        if (error) {
          if (previewSetting) previewSetting.setDesc(`设置无效：${error}。未保存，仍使用上一次有效模板`);
          return;
        }
        this.plugin.settings.fileNameTemplate = nextTemplate;
        await this.plugin.saveSettings();
        if (previewSetting) this.renderPreview(previewSetting);
      }));

    new Setting(containerEl).setName('标签同步范围').setHeading();
    new Setting(containerEl)
      .setName(`可选 Flomo 标签（${this.plugin.settings.availableFlomoTags.length}）`)
      .setDesc(this.plugin.settings.bearerToken
        ? '登录或同步时自动更新。只有配置了文件夹映射的标签才参与同步。'
        : '请先登录 Flomo，插件会读取当前 memo 中的标签。')
      .addButton(button => button
        .setButtonText('刷新标签')
        .setDisabled(!this.plugin.settings.bearerToken)
        .onClick(async () => {
          button.setDisabled(true).setButtonText('读取中…');
          try {
            const count = await this.plugin.refreshAvailableFlomoTags();
            new Notice(`已读取 ${count} 个 Flomo 标签。`);
          } catch (error) {
            new Notice(`读取 Flomo 标签失败：${(error as Error).message}`);
          } finally {
            this.display();
          }
        }));

    if (this.plugin.settings.tagFolderMappings.length === 0) {
      new Setting(containerEl)
        .setName('尚未设置同步标签')
        .setDesc('当前不会导入或更新任何 Flomo memo。请在下方添加至少一条映射。');
    }

    const folderPaths = this.vaultFolderPaths();
    this.plugin.settings.tagFolderMappings.forEach((mapping, index) => {
      const mappingSetting = new Setting(containerEl)
        .setName(`映射 ${index + 1}`)
        .setDesc('顺序靠前的映射优先；输入关键词可以快速筛选。');
      mappingSetting.settingEl.addClass('flomo-sync-mapping-row');
      mappingSetting.addText(text => {
        text.inputEl.setAttribute('aria-label', `映射 ${index + 1} 的 Flomo 标签`);
        this.addSuggestions(mappingSetting, text.inputEl, this.plugin.settings.availableFlomoTags, 'tag');
        return text.setPlaceholder('Flomo 标签').setValue(mapping.tag).onChange(async value => {
          await this.updateMapping(index, {
            ...this.plugin.settings.tagFolderMappings[index],
            tag: value,
          }, mappingSetting);
          if (previewSetting) this.renderPreview(previewSetting);
        });
      });
      mappingSetting.addText(text => {
        text.inputEl.addClass('flomo-sync-wide-input');
        text.inputEl.setAttribute('aria-label', `映射 ${index + 1} 的 Vault 文件夹`);
        this.addSuggestions(mappingSetting, text.inputEl, folderPaths, 'folder');
        return text.setPlaceholder('Vault 文件夹').setValue(mapping.folder).onChange(async value => {
          await this.updateMapping(index, {
            ...this.plugin.settings.tagFolderMappings[index],
            folder: value,
          }, mappingSetting);
          if (previewSetting) this.renderPreview(previewSetting);
        });
      });
      mappingSetting.addExtraButton(button => button
        .setIcon('arrow-up')
        .setTooltip('上移映射')
        .setDisabled(index === 0)
        .onClick(async () => { await this.moveMapping(index, -1); }));
      mappingSetting.addExtraButton(button => button
        .setIcon('arrow-down')
        .setTooltip('下移映射')
        .setDisabled(index === this.plugin.settings.tagFolderMappings.length - 1)
        .onClick(async () => { await this.moveMapping(index, 1); }));
      mappingSetting.addExtraButton(button => button
        .setIcon('trash')
        .setTooltip('删除这条映射')
        .onClick(async () => {
          this.plugin.settings.tagFolderMappings.splice(index, 1);
          await this.plugin.saveSettings();
          this.display();
        }));
    });

    let draftTag = '';
    let draftFolder = this.plugin.settings.rootFolder;
    const addMappingSetting = new Setting(containerEl)
      .setName('添加标签映射')
      .setDesc('选择或输入一个 Flomo 标签，再选择对应的 Vault 文件夹。');
    addMappingSetting.settingEl.addClass('flomo-sync-mapping-row');
    addMappingSetting.addText(text => {
      text.inputEl.setAttribute('aria-label', '新映射的 Flomo 标签');
      this.addSuggestions(addMappingSetting, text.inputEl, this.plugin.settings.availableFlomoTags, 'tag');
      return text.setPlaceholder('输入或选择标签').onChange(value => { draftTag = value; });
    });
    addMappingSetting.addText(text => {
      text.inputEl.addClass('flomo-sync-wide-input');
      text.inputEl.setAttribute('aria-label', '新映射的 Vault 文件夹');
      this.addSuggestions(addMappingSetting, text.inputEl, folderPaths, 'folder');
      return text.setPlaceholder('输入或选择文件夹').setValue(draftFolder).onChange(value => { draftFolder = value; });
    });
    addMappingSetting.addButton(button => button.setButtonText('添加').setCta().onClick(async () => {
      const next = { tag: draftTag, folder: draftFolder };
      const error = this.mappingError(next);
      if (error) {
        addMappingSetting.setDesc(`无法添加：${error}`);
        return;
      }
      this.plugin.settings.tagFolderMappings.push({
        tag: normalizeTag(next.tag),
        folder: normalizeVaultPath(next.folder),
      });
      await this.plugin.saveSettings();
      this.display();
    }));

    new Setting(containerEl)
      .setName('图片本地化')
      .setDesc('把 Flomo 图片下载到默认根目录下的 _attachments/flomo；下载失败时保留远程链接。')
      .addToggle(toggle => toggle.setValue(this.plugin.settings.localizeImages).onChange(async value => {
        this.plugin.settings.localizeImages = value;
        await this.plugin.saveSettings();
      }));

    previewSetting = new Setting(containerEl).setName('样例保存路径');
    this.renderPreview(previewSetting);

    new Setting(containerEl).setName('YAML 与标签').setHeading();
    const yamlTemplateSetting = new Setting(containerEl)
      .setName('新笔记 YAML 字段模板')
      .setDesc('仅首次导入时写入；每行一个顶层字段。变量：{{YYYY-MM-DD-HHmmss}}、{{date}}、{{time}}、{{title}}、{{slug}}、{{first_tag}}。');
    yamlTemplateSetting.addTextArea(text => {
      text.inputEl.rows = 5;
      return text
        .setPlaceholder('source: flomo\nnote_type: memo\ncreated: "{{date}}"\naliases: []')
        .setValue(this.plugin.settings.yamlTemplate)
        .onChange(async value => {
          const nextTemplate = value.trim();
          const error = validateYamlTemplate(nextTemplate);
          if (error) {
            yamlTemplateSetting.setDesc(`设置无效：${error}。未保存，仍使用上一次有效模板。`);
            return;
          }
          this.plugin.settings.yamlTemplate = nextTemplate;
          await this.plugin.saveSettings();
          yamlTemplateSetting.setDesc('已保存；只影响之后首次导入的新笔记，现有笔记不会批量改写。');
        });
    });
    new Setting(containerEl)
      .setName('标签合并规则（固定）')
      .setDesc('Flomo 标签与 Obsidian 手工标签统一写入 tags；同步时更新 Flomo 部分并保留手工标签。旧 flomo_tags 会在下次受管更新时自动迁移。');

    new Setting(containerEl).setName('更新范围与安全').setHeading();
    new Setting(containerEl)
      .setName('排除更新的标签')
      .setDesc('逗号分隔，按完整标签名精确匹配；多标签命中任意一个即排除。')
      .addText(text => text
        .setPlaceholder('归档, 已完成')
        .setValue(this.plugin.settings.excludedTags.join(', '))
        .onChange(async value => {
          this.plugin.settings.excludedTags = normalizeTagList(value.split(/[,，]+/));
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('命中排除标签时')
      .setDesc('无论选择哪项，已有 Obsidian 文件都不会删除。')
      .addDropdown(dropdown => dropdown
        .addOption('freeze', '首次导入后冻结')
        .addOption('skip', '完全不导入，也不更新')
        .setValue(this.plugin.settings.excludedPolicy)
        .onChange(async value => {
          this.plugin.settings.excludedPolicy = value as ExcludedPolicy;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('受管区规则（固定）')
      .setDesc('只更新 flomo-sync 标记之间的内容、flomo_ 字段和合并后的 tags；其他 YAML 字段及手工内容保持不变。标记损坏时停止覆盖并报告冲突。');
    new Setting(containerEl)
      .setName('Flomo 删除规则（固定）')
      .setDesc('Obsidian 文件和附件永久保留，仅把 flomo_status 标记为 deleted。');

    new Setting(containerEl).setName('自动同步').setHeading();
    new Setting(containerEl)
      .setName('启动时同步')
      .addToggle(toggle => toggle.setValue(this.plugin.settings.autoSyncOnStartup).onChange(async value => {
        this.plugin.settings.autoSyncOnStartup = value;
        await this.plugin.saveSettings();
      }));
    new Setting(containerEl)
      .setName('同步间隔（分钟）')
      .setDesc('设为 0 可关闭定时同步。')
      .addText(text => text.setValue(String(this.plugin.settings.autoSyncIntervalMinutes)).onChange(async value => {
        this.plugin.settings.autoSyncIntervalMinutes = Math.max(0, Number.parseInt(value, 10) || 0);
        await this.plugin.saveSettings();
        if (this.plugin.settings.autoSyncIntervalMinutes > 0) this.plugin.startIntervalSync();
        else this.plugin.stopIntervalSync();
      }));

    new Setting(containerEl).setName('状态').setHeading();
    const syncedCount = Object.keys(this.plugin.settings.syncedMemos).length;
    const lastSync = this.plugin.settings.lastSyncTime
      ? new Date(this.plugin.settings.lastSyncTime).toLocaleString()
      : '尚未同步';
    new Setting(containerEl)
      .setName(this.plugin.settings.bearerToken ? '已连接 Flomo' : '尚未连接 Flomo')
      .setDesc(`已记录 ${syncedCount} 条 memo；上次同步：${lastSync}`);
    new Setting(containerEl)
      .setName('立即同步')
      .addButton(button => button.setButtonText('同步').setCta().onClick(async () => {
        await this.plugin.runSync();
        this.display();
      }));
  }

  private renderPreview(setting: Setting): void {
    try {
      if (!findTagFolderMapping(SAMPLE_MEMO, this.plugin.settings.tagFolderMappings)) {
        setting.setDesc('样例标签“写作 / 素材”尚未映射，因此不会参与同步。');
        return;
      }
      setting.setDesc(computeDesiredPaths(SAMPLE_MEMO, this.plugin.settings).join('；'));
    } catch (error) {
      setting.setDesc(`设置无效：${(error as Error).message}`);
    }
  }
}
