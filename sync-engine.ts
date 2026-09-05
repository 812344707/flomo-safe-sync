import { App, TFile, requestUrl } from 'obsidian';
import { createHash } from 'crypto';
import { FlomoMemo, buildNewMemoFile, computeDesiredPaths, extractImageSources, extractManagedBodyEmbedTargets, extractTags,
  fileNameFromUrl, hasManagedMarkers, mergeManagedMemo, memoMatchesExcludedTags,
  normalizeVaultPath, renderFileName, sanitizePathSegment, tagsInScope, updateManagedStatus,
  validateFileNameTemplate, validateNoteTemplate, validateVaultRelativePath } from './sync-core';
import { FileState, FlomoSafeSyncSettings, SyncedMemoRecord } from './settings';

export interface SyncResult {
  total: number; newCount: number; updatedCount: number; frozenCount: number; skippedCount: number;
  unmappedCount: number; deletedMarkedCount: number; archivedCount: number; pendingTrashCount: number;
  conflictCount: number; assetErrorCount: number; errors: string[];
}
interface AssetResult {
  imageMap: Record<string, string>;
  attachmentPaths: string[];
  assetMap: Record<string, string>;
  errorCount: number;
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
  previousAssetMap: Record<string, string> = {},
  currentManagedTargets: string[] = [],
): Promise<AssetResult> {
  if (!enabled) return {
    imageMap: {}, attachmentPaths: (memo.files || []).map(file => file.url),
    assetMap: { ...previousAssetMap }, errorCount: 0,
  };
  const inlineSources = extractImageSources(memo.content);
  const sources = [...inlineSources];
  for (const file of memo.files || []) {
    if (file.url && !sources.includes(file.url)) sources.push(file.url);
  }
  if (sources.length === 0) return { imageMap: {}, attachmentPaths: [], assetMap: {}, errorCount: 0 };

  await ensureDir(app, assetFolder);
  const imageMap: Record<string, string> = {};
  const attachmentPaths: string[] = [];
  const assetMap: Record<string, string> = {};
  const previousSources = Object.keys(previousAssetMap);
  const canInferMigratedOrder = previousSources.length === 0 && currentManagedTargets.length === sources.length;
  let errorCount = 0;
  for (let index = 0; index < sources.length; index++) {
    const source = sources[index];
    const previousDestination = previousAssetMap[source];
    const previousIndex = previousSources.indexOf(source);
    const currentIndex = previousIndex >= 0 ? previousIndex : canInferMigratedOrder ? index : -1;
    const currentDestination = currentIndex >= 0 ? currentManagedTargets[currentIndex] : undefined;
    const hostedReplacement = currentDestination
      && /^https?:\/\//i.test(currentDestination) && currentDestination !== source
      ? currentDestination
      : undefined;
    if (hostedReplacement) {
      imageMap[source] = hostedReplacement;
      assetMap[source] = hostedReplacement;
      attachmentPaths.push(hostedReplacement);
      continue;
    }
    if (previousDestination && /^https?:\/\//i.test(previousDestination) && previousDestination !== source) {
      imageMap[source] = previousDestination;
      assetMap[source] = previousDestination;
      attachmentPaths.push(previousDestination);
      continue;
    }
    const namedFile = (memo.files || []).find(file => file.url === source)?.name;
    const rawName = namedFile ? sanitizePathSegment(namedFile) : fileNameFromUrl(source, index + 1);
    const target = previousDestination && !/^https?:\/\//i.test(previousDestination)
      ? previousDestination
      : `${assetFolder}/${createHash('sha256').update(source).digest('hex').slice(0, 12)}-${rawName}`;
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
      assetMap[source] = target;
      attachmentPaths.push(target);
    } catch (error) {
      errorCount++;
      assetMap[source] = source;
      attachmentPaths.push(source);
      console.warn(`[Flomo Safe Sync] Failed to download attachment: ${source}`, error);
    }
  }
  return { imageMap, attachmentPaths, assetMap, errorCount };
}

export function validateSettings(settings: FlomoSafeSyncSettings): void {
  for (const [label, path] of [['保存目录', settings.rootFolder], ['图片目录', settings.imageFolder], ['归档目录', settings.archiveFolder]]) {
    const error = validateVaultRelativePath(path);
    if (error) throw new Error(`${label}无效：${error}`);
  }
  for (const error of [validateFileNameTemplate(settings.fileNameTemplate), validateNoteTemplate(settings.noteTemplate)]) if (error) throw new Error(error);
  for (const mapping of settings.tagFolderMappings) {
    if (!mapping.tag.trim() || validateVaultRelativePath(mapping.folder)) throw new Error('标签目录映射无效');
  }
}

function fileStates(record: SyncedMemoRecord): FileState[] {
  return record.fileStates ||= record.filePaths.map(path => ({ path, state: 'live' }));
}
function refreshPaths(record: SyncedMemoRecord): void {
  record.filePaths = fileStates(record).map(file => file.path);
}
async function readOwned(app: App, path: string, slug: string): Promise<string> {
  if (!(await app.vault.adapter.exists(path))) throw new Error(`${path}：文件缺失，请先恢复文件后重试`);
  const text = await app.vault.adapter.read(path);
  if (!hasManagedMarkers(text, slug)) throw new Error(`${path}：受管区或笔记身份冲突，已保留原文`);
  return text;
}
async function writeStatus(app: App, path: string, slug: string, status: 'active' | 'deleted', excluded: boolean, detectedAt?: string): Promise<void> {
  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) throw new Error(`${path}：文件未加载，请恢复文件后重试`);
  await app.vault.process(file, current => {
    const merged = updateManagedStatus(current, status, excluded ? 'excluded' : 'managed', new Date().toISOString(), detectedAt, slug);
    if (!merged.ok) throw new Error(`${path}：${merged.reason}`);
    return merged.content;
  });
}

/** Persist the intent before moving; reconcile interrupted moves from both observed paths. */
async function finishFileAction(app: App, slug: string, record: SyncedMemoRecord, file: FileState, save: () => Promise<void>, internalMoves: Set<string>): Promise<void> {
  const intent = file.pending;
  if (!intent) return;
  const sourceExists = await app.vault.adapter.exists(file.path);
  if (intent.action === 'trash') {
    if (sourceExists) {
      await readOwned(app, file.path, slug);
      const loaded = app.vault.getAbstractFileByPath(file.path);
      if (!(loaded instanceof TFile)) throw new Error(`${file.path}：Obsidian 尚未加载该笔记，请重试`);
      await app.vault.trash(loaded, false);
    }
    file.state = 'trashed';
  } else {
    const target = intent.target!;
    const targetExists = await app.vault.adapter.exists(target);
    if (sourceExists && targetExists) throw new Error(`${target}：目标路径已被占用`);
    if (!sourceExists && !targetExists) throw new Error(`${file.path}：移动状态无法确认，请恢复文件后重试`);
    if (sourceExists) {
      await readOwned(app, file.path, slug);
      await ensureParentDir(app, target);
      const loaded = app.vault.getAbstractFileByPath(file.path);
      if (!(loaded instanceof TFile)) throw new Error(`${file.path}：Obsidian 尚未加载该笔记，请重试`);
      internalMoves.add(file.path);
      try { await app.fileManager.renameFile(loaded, target); } finally { internalMoves.delete(file.path); }
    } else {
      await readOwned(app, target, slug);
    }
    file.path = target;
    file.state = intent.action === 'archive' ? 'archived' : 'live';
    if (intent.action === 'restore') delete file.originalPath;
  }
  delete file.pending;
  refreshPaths(record);
  await save();
}

async function restoreRecord(app: App, slug: string, record: SyncedMemoRecord, excluded: boolean, save: () => Promise<void>, internalMoves: Set<string>): Promise<void> {
  for (const file of fileStates(record)) {
    // An interrupted trash with a still-present source has not taken effect: cancel it on resurrection.
    if (file.pending?.action === 'trash' && await app.vault.adapter.exists(file.path)) { delete file.pending; await save(); }
    if (file.pending?.action === 'archive' && await app.vault.adapter.exists(file.path)) {
      // The failed archive has not moved anything; resurrection cancels its stale intent.
      if (await app.vault.adapter.exists(file.pending.target!)) throw new Error(`${file.pending.target}：移动状态冲突`);
      delete file.pending; delete file.originalPath; await save();
    }
    if (file.pending) await finishFileAction(app, slug, record, file, save, internalMoves);
    if (file.state === 'trashed') {
      if (!(await app.vault.adapter.exists(file.path))) throw new Error(`${file.path}：Flomo 已恢复，请从 Obsidian .trash 恢复原文件后重试`);
      await readOwned(app, file.path, slug);
      file.state = 'live';
      await save();
    }
    if (file.state === 'archived') {
      const target = file.originalPath!;
      if (await app.vault.adapter.exists(target)) throw new Error(`${target}：恢复路径已被占用`);
      file.pending = { action: 'restore', target };
      await save();
      await finishFileAction(app, slug, record, file, save, internalMoves);
    }
    const content = await readOwned(app, file.path, slug);
    if (/^flomo_status: deleted\r?$/m.test(content)) await writeStatus(app, file.path, slug, 'active', excluded);
  }
  record.status = 'active';
  record.deletedDetectedAt = undefined;
  record.pendingTrash = false;
  await save();
}

async function applyDeletion(app: App, settings: FlomoSafeSyncSettings, slug: string, record: SyncedMemoRecord, save: () => Promise<void>, internalMoves: Set<string>): Promise<void> {
  const detectedAt = record.deletedDetectedAt || new Date().toISOString();
  if (settings.deletionAction === 'keep' || settings.deletionAction === 'trash') {
    record.status = 'deleted';
    record.deletedDetectedAt = detectedAt;
    record.pendingTrash = settings.deletionAction === 'trash' && fileStates(record).some(file => file.state !== 'trashed');
    return;
  }
  for (const file of fileStates(record)) {
    if (file.pending) {
      // A trash operation is never initiated or retried by automatic sync.
      if (file.pending.action === 'trash') {
        if (!(await app.vault.adapter.exists(file.path))) { file.state = 'trashed'; delete file.pending; await save(); }
        else { delete file.pending; await save(); }
      } else await finishFileAction(app, slug, record, file, save, internalMoves);
    }
    if (file.state === 'trashed') continue;
    const current = await readOwned(app, file.path, slug);
    if (!/^flomo_status: deleted\r?$/m.test(current)) await writeStatus(app, file.path, slug, 'deleted', Boolean(record.excluded), detectedAt);
    if (settings.deletionAction === 'archive' && file.state !== 'archived') {
      file.originalPath = file.path;
      const candidate = `${normalizeVaultPath(settings.archiveFolder)}/${file.originalPath}`;
      const [target] = await resolveUniquePaths(app, [candidate], slug, settings);
      file.pending = { action: 'archive', target };
      await save();
      await finishFileAction(app, slug, record, file, save, internalMoves);
    }
  }
  record.status = 'deleted';
  record.deletedDetectedAt = detectedAt;
  record.pendingTrash = false;
}

async function createMemo(app: App, settings: FlomoSafeSyncSettings, memo: FlomoMemo, token: string, excluded: boolean): Promise<{ record: SyncedMemoRecord; errors: number }> {
  const options = { syncedAt: new Date().toISOString(), syncPolicy: excluded ? 'excluded' as const : 'managed' as const, noteTemplate: settings.noteTemplate };
  buildNewMemoFile(memo, options); // Validate generated ownership/markers before downloading assets.
  const paths = await resolveUniquePaths(app, computeDesiredPaths(memo, settings), memo.slug, settings);
  const assetFolder = `${normalizeVaultPath(settings.imageFolder)}/${sanitizePathSegment(memo.slug)}`;
  const assets = await localizeMemoAssets(app, memo, assetFolder, token, settings.localizeImages);
  const content = buildNewMemoFile(memo, { ...options, imageMap: assets.imageMap, extraAttachmentPaths: assets.attachmentPaths });
  for (const path of paths) { await ensureParentDir(app, path); await app.vault.create(path, content); }
  return { errors: assets.errorCount, record: {
    updated_at: memo.updated_at, bodyUpdatedAt: memo.updated_at, propertiesUpdatedAt: memo.updated_at,
    fileName: renderFileName(settings.fileNameTemplate, memo), filePaths: paths, status: 'active', excluded,
    lastKnownTags: extractTags(memo), lastAppliedFlomoTags: extractTags(memo), tagsMerged: true, assetFolder,
    assetMap: assets.assetMap,
  } };
}

async function updateMemo(app: App, settings: FlomoSafeSyncSettings, memo: FlomoMemo, record: SyncedMemoRecord, token: string): Promise<{ changed: boolean; errors: number }> {
  const mode = settings.updateMode;
  if (mode === 'new-only') return { changed: false, errors: 0 };
  const force = record.excluded || record.outOfScope;
  const body = mode !== 'properties' && (force || (record.bodyUpdatedAt ?? record.updated_at) !== memo.updated_at);
  const properties = mode !== 'body' && (force || (record.propertiesUpdatedAt ?? record.updated_at) !== memo.updated_at || !record.tagsMerged);
  if (!body && !properties) return { changed: false, errors: 0 };
  const effectiveMode = body && properties ? 'both' : body ? 'body' : 'properties';
  const paths = fileStates(record).map(file => file.path);
  // Validate every destination before doing any note or attachment write for this memo.
  const ownedContents: string[] = [];
  for (const path of paths) {
    const current = await readOwned(app, path, memo.slug);
    ownedContents.push(current);
    const preflight = mergeManagedMemo(current, memo, { syncedAt: new Date().toISOString(), updateMode: effectiveMode, previousFlomoTags: record.lastAppliedFlomoTags || record.lastKnownTags });
    if (!preflight.ok) throw new Error(`${path}：${preflight.reason}`);
  }
  const assetFolder = record.assetFolder || `${normalizeVaultPath(settings.imageFolder)}/${sanitizePathSegment(memo.slug)}`;
  const assets = body
    ? await localizeMemoAssets(
      app, memo, assetFolder, token, settings.localizeImages, record.assetMap || {},
      extractManagedBodyEmbedTargets(ownedContents[0], memo.slug),
    )
    : { imageMap: {}, attachmentPaths: [], assetMap: record.assetMap || {}, errorCount: 0 };
  for (const path of paths) {
    const file = app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error(`${path}：文件未加载，请重试`);
    await app.vault.process(file, current => {
      const merged = mergeManagedMemo(current, memo, {
        syncedAt: new Date().toISOString(), updateMode: effectiveMode,
        imageMap: assets.imageMap, extraAttachmentPaths: assets.attachmentPaths,
        previousFlomoTags: record.lastAppliedFlomoTags || record.lastKnownTags,
      });
      if (!merged.ok) throw new Error(`${path}：${merged.reason}`);
      return merged.content;
    });
  }
  if (body) {
    record.bodyUpdatedAt = memo.updated_at;
    record.assetFolder = assetFolder;
    record.assetMap = assets.assetMap;
  }
  if (properties) { record.propertiesUpdatedAt = memo.updated_at; record.lastAppliedFlomoTags = extractTags(memo); record.tagsMerged = true; }
  record.updated_at = memo.updated_at;
  return { changed: true, errors: assets.errorCount };
}

export async function syncToVault(app: App, settings: FlomoSafeSyncSettings, memos: FlomoMemo[], token: string, save: () => Promise<void>, internalMoves = new Set<string>()): Promise<SyncResult> {
  validateSettings(settings);
  const result: SyncResult = { total: memos.length, newCount: 0, updatedCount: 0, frozenCount: 0, skippedCount: 0, unmappedCount: 0,
    deletedMarkedCount: 0, archivedCount: 0, pendingTrashCount: 0, conflictCount: 0, assetErrorCount: 0, errors: [] };
  const fail = (error: unknown) => { result.conflictCount++; result.errors.push((error as Error).message); console.warn('[Flomo Safe Sync]', (error as Error).message); };
  const seen = new Set(memos.map(memo => memo.slug)); // Entire snapshot, BEFORE any scope filtering.
  for (const memo of memos) {
    const record = settings.syncedMemos[memo.slug];
    const tags = extractTags(memo);
    if (!tagsInScope(tags, settings)) {
      if (record) { record.outOfScope = true; record.lastKnownTags = tags; record.pendingTrash = false; }
      result.unmappedCount++;
      continue;
    }
    const excluded = Boolean(memoMatchesExcludedTags(memo, settings.excludedTags));
    try {
      if (!record) {
        if (excluded && settings.excludedPolicy === 'skip') { result.skippedCount++; continue; }
        const created = await createMemo(app, settings, memo, token, excluded);
        settings.syncedMemos[memo.slug] = created.record;
        result.newCount++; result.assetErrorCount += created.errors;
        if (excluded) result.frozenCount++;
      } else {
        if (record.status === 'deleted' || record.fileStates?.some(file => file.state !== 'live' || file.pending)) await restoreRecord(app, memo.slug, record, excluded, save, internalMoves);
        if (excluded) {
          if (settings.excludedPolicy === 'skip') result.skippedCount++; else result.frozenCount++;
        } else {
          const update = await updateMemo(app, settings, memo, record, token);
          if (update.changed) result.updatedCount++;
          result.assetErrorCount += update.errors;
        }
        record.lastKnownTags = tags; record.excluded = excluded; record.outOfScope = false; record.pendingTrash = false;
      }
    } catch (error) { fail(error); }
  }
  for (const [slug, record] of Object.entries(settings.syncedMemos)) {
    if (seen.has(slug)) continue;
    if (!tagsInScope(record.lastKnownTags || [], settings)) { record.pendingTrash = false; continue; }
    try {
      const previous = record.status;
      const archived = record.fileStates?.filter(file => file.state === 'archived').length || 0;
      await applyDeletion(app, settings, slug, record, save, internalMoves);
      if (settings.deletionAction === 'mark' && previous !== 'deleted') result.deletedMarkedCount++;
      result.archivedCount += (record.fileStates?.filter(file => file.state === 'archived').length || 0) - archived;
      if (record.pendingTrash) result.pendingTrashCount++;
    } catch (error) { fail(error); }
  }
  settings.lastSyncTime = Date.now();
  return result;
}

/** Call only after a fresh complete snapshot and explicit selection of these file paths. */
export async function executeTrash(app: App, settings: FlomoSafeSyncSettings, selectedPaths: string[], snapshot: FlomoMemo[], save: () => Promise<void>, internalMoves = new Set<string>()): Promise<{ moved: number; errors: string[] }> {
  validateSettings(settings);
  const result = { moved: 0, errors: [] as string[] };
  if (settings.deletionAction !== 'trash') throw new Error('删除规则已改变，请重新同步后查看待处理列表');
  const seen = new Set(snapshot.map(memo => memo.slug));
  const selected = new Set(selectedPaths);
  for (const [slug, record] of Object.entries(settings.syncedMemos)) {
    if (!record.pendingTrash || seen.has(slug) || !tagsInScope(record.lastKnownTags || [], settings)) {
      if (seen.has(slug) || !tagsInScope(record.lastKnownTags || [], settings)) record.pendingTrash = false;
      continue;
    }
    for (const file of fileStates(record)) {
      if (!selected.has(file.path) || file.state === 'trashed') continue;
      try {
        if (file.pending && file.pending.action !== 'trash') await finishFileAction(app, slug, record, file, save, internalMoves);
        if (!file.pending) {
          await readOwned(app, file.path, slug);
          file.pending = { action: 'trash' };
          await save();
        }
        await finishFileAction(app, slug, record, file, save, internalMoves);
        result.moved++;
      } catch (error) { result.errors.push((error as Error).message); }
    }
    record.pendingTrash = fileStates(record).some(file => file.state !== 'trashed');
  }
  await save();
  return result;
}
