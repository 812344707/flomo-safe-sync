import { App, TFile, parseYaml } from 'obsidian';
import { createHash } from 'crypto';
import { FileState, FlomoSafeSyncSettings, SyncedMemoRecord } from './settings';
import { computeDesiredFolder, extractManagedBodyEmbedTargets, normalizeVaultPath, sanitizePathSegment } from './sync-core';
import { ensureParentDir, MemoIdentityIndex, validateSettings } from './sync-engine';

export type FolderSettings = Pick<FlomoSafeSyncSettings, 'rootFolder' | 'imageFolder' | 'tagFolderMappings'>;
interface FileMove { from: string; to: string; kind: 'note' | 'asset'; hash?: string; done?: boolean }
interface LinkRepair { from: string; to: string; slug?: string; replacements: Record<string, string> }
interface MemoMove {
  slug: string;
  moves: FileMove[];
  links: LinkRepair[];
  assetFolder?: string;
  assetMap: Record<string, string>;
}
export interface FolderMigrationJob { notes: boolean; assets: boolean; current?: MemoMove }
export interface FolderMigrationResult { notes: number; assets: number; errors: string[] }

export function folderSettings(settings: FlomoSafeSyncSettings): FolderSettings {
  return JSON.parse(JSON.stringify({ rootFolder: settings.rootFolder, imageFolder: settings.imageFolder, tagFolderMappings: settings.tagFolderMappings }));
}

export function validateFolderMigrationSettings(settings: FlomoSafeSyncSettings): void {
  validateSettings(settings);
  for (const folder of [settings.rootFolder, settings.imageFolder, ...settings.tagFolderMappings.map(item => item.folder)]) {
    if (normalizeVaultPath(folder).split('/').some(part => part.startsWith('.'))) throw new Error(`${folder}：Obsidian 不加载隐藏目录，请使用普通目录`);
  }
}

const parent = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/')));
const basename = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const external = (path: string) => /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(path);
const digest = (bytes: ArrayBuffer) => createHash('sha256').update(new Uint8Array(bytes)).digest('hex');

/** Moving an identified file never rebuilds managed content. Obsidian's property
 * editor can remove YAML comments; that alone must not prevent a directory fix. */
function hasMoveIdentity(content: string, slug: string): boolean {
  const yaml = content.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  if (!yaml || (yaml.match(/^(?:flomo_slug|"flomo_slug"|'flomo_slug')\s*:/gm) || []).length !== 1) return false;
  try {
    const parsed = parseYaml(yaml);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) && String(parsed.flomo_slug) === slug;
  } catch { return false; }
}
async function readMovable(app: App, path: string, slug: string): Promise<string> {
  if (!(await app.vault.adapter.exists(path))) throw new Error(`${path}：文件缺失，请在“更新与安全”中检查并重新导入`);
  const text = await app.vault.adapter.read(path);
  if (!hasMoveIdentity(text, slug)) throw new Error(`${path}：笔记编号或 YAML 冲突，已保留原文件`);
  return text;
}

function eligible(record: SyncedMemoRecord, settings: FlomoSafeSyncSettings): boolean {
  return Boolean(computeDesiredFolder(record.lastKnownTags || [], settings)) && record.status !== 'deleted' && !record.pendingTrash
    && !(record.fileStates || []).some(file => file.state !== 'live' || file.pending);
}

function resolveRelative(base: string, path: string): string {
  const parts: string[] = [];
  for (const part of `${base}/${path}`.split('/')) {
    if (part === '..') { if (!parts.length) return ''; parts.pop(); }
    else if (part && part !== '.') parts.push(part);
  }
  return parts.join('/');
}
function relativePath(note: string, target: string): string {
  const from = parent(note).split('/').filter(Boolean), to = target.split('/');
  while (from.length && to.length && from[0] === to[0]) { from.shift(); to.shift(); }
  return [...from.map(() => '..'), ...to].join('/');
}

class LinkIndex {
  private cache = new Map<string, { mtime: number; size: number; targets: Array<{ kind: string; target: string }> }>();
  constructor(private app: App) {}
  invalidate(plan: MemoMove): void { for (const link of plan.links) { this.cache.delete(link.from); this.cache.delete(link.to); } }
  async targets(file: TFile): Promise<Array<{ kind: string; target: string }>> {
    const cached = this.cache.get(file.path);
    if (file.stat && cached && file.stat.mtime === cached.mtime && file.stat.size === cached.size) return cached.targets;
    const targets: Array<{ kind: string; target: string }> = [];
    mapNoteLinks(await this.app.vault.adapter.read(file.path), (kind, target) => { targets.push({ kind, target }); return target; });
    if (file.stat) this.cache.set(file.path, { mtime: file.stat.mtime, size: file.stat.size, targets });
    return targets;
  }
}

/** Change link destinations only; skip fenced/inline code, preserve labels and prose. */
export function mapNoteLinks(text: string, replace: (kind: string, target: string) => string): string {
  let fence = '';
  return text.split(/(?<=\n)/).map(line => {
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = '';
      return line;
    }
    if (fence) return line;
    return line.replace(/(`+)[^\n]*?\1|!?\[\[([^\]|\n]+)(?:\|[^\]\n]*)?\]\]|!?\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|((?:\\.|[^\s)\\])+))(?:\s+["'][^\n]*?["'])?\s*\)|<img\b[^>]*?\bsrc=(["'])(.*?)\5[^>]*>|^\s{0,3}\[[^\]\n]+\]:\s*(?:<([^>\n]+)>|(\S+))/gi,
      (full, code, wiki, angled, markdown, quote, html, refAngle, ref) => {
        if (code) return full;
        const target = wiki ?? angled ?? markdown ?? html ?? refAngle ?? ref;
        const kind = wiki !== undefined ? 'wiki' : html !== undefined ? 'html' : 'markdown';
        const next = replace(kind, target);
        // Match the destination after the label, which can itself contain its URL.
        const start = kind === 'wiki' ? full.indexOf('[[') + 2
          : kind === 'html' ? full.indexOf(`${quote}${target}${quote}`) + 1
          : full.includes('](') ? full.indexOf(target, full.indexOf('](') + 2) : full.indexOf(target, full.indexOf(']:') + 2);
        return full.slice(0, start) + next + full.slice(start + target.length);
      });
  }).join('');
}

function resolveLink(app: App, kind: string, value: string, note: string, paths: Set<string>): string | undefined {
  if (external(value) || value.startsWith('#')) return undefined;
  let raw: string;
  try { raw = decodeURIComponent(value.split('#')[0]).replace(/\\([() ])/g, '$1'); } catch { return undefined; }
  if (!raw) return undefined;
  if (kind === 'wiki') {
    const resolved = app.metadataCache?.getFirstLinkpathDest(raw, note)?.path;
    if (resolved && paths.has(resolved)) return resolved;
  }
  const relative = resolveRelative(parent(note), raw);
  if (kind === 'wiki' && !raw.includes('/') && raw !== relative && paths.has(raw) && paths.has(relative)) return undefined;
  const candidates = kind === 'wiki' ? [raw, relative] : [relative, raw];
  for (const path of candidates) if (paths.has(path)) return path;
  if (kind === 'wiki') {
    const matches = [...paths].filter(path => basename(path) === raw || path === `${raw}.md` || basename(path) === `${raw}.md`);
    if (matches.length === 1) return matches[0];
  }
  return undefined;
}

async function uniqueTarget(app: App, candidate: string, slug: string, reserved: Set<string>): Promise<string> {
  let target = candidate, index = 0;
  const dot = candidate.lastIndexOf('.') > candidate.lastIndexOf('/') ? candidate.lastIndexOf('.') : candidate.length;
  while (reserved.has(target) || await app.vault.adapter.exists(target)) {
    target = `${candidate.slice(0, dot)}_${sanitizePathSegment(slug).slice(0, 8)}${++index > 1 ? `-${index}` : ''}${candidate.slice(dot)}`;
  }
  reserved.add(target);
  return target;
}

async function planMemo(app: App, settings: FlomoSafeSyncSettings, slug: string, record: SyncedMemoRecord, job: FolderMigrationJob, links: LinkIndex): Promise<MemoMove | null> {
  const folder = computeDesiredFolder(record.lastKnownTags || [], settings);
  const states: FileState[] = record.fileStates || record.filePaths.map(path => ({ path, state: 'live' }));
  if (!folder || record.status === 'deleted' || record.pendingTrash || states.some(file => file.state !== 'live' || file.pending)) return null;
  if (!states.length) throw new Error(`${slug}：没有已记录的本地笔记路径`);
  const contents: string[] = [];
  for (const state of states) contents.push(await readMovable(app, state.path, slug));
  const plan: MemoMove = { slug, moves: [], links: [], assetMap: { ...record.assetMap } };
  const reserved = new Set(Object.values(settings.syncedMemos).flatMap(item => item.filePaths));
  const paths = new Set(app.vault.getAllLoadedFiles().filter(file => file instanceof TFile).map(file => file.path));
  if (job.notes) for (const file of states) {
    const candidate = `${folder}/${basename(file.path)}`;
    if (candidate !== file.path) plan.moves.push({ from: file.path, to: await uniqueTarget(app, candidate, slug, reserved), kind: 'note' });
  }
  if (job.assets) {
    plan.assetFolder = `${normalizeVaultPath(settings.imageFolder)}/${sanitizePathSegment(slug)}`;
    const ownedAssets = new Set<string>();
    const targets = extractManagedBodyEmbedTargets(contents[0], slug);
    const sources = Object.keys(record.assetMap || {});
    for (const [index, source] of sources.entries()) {
      const old = record.assetMap![source];
      const current = targets.length === sources.length ? targets[index] : undefined;
      // Keep image-host replacements even when sync has not yet observed them.
      if (current && /^https?:\/\//i.test(current) && current !== source) plan.assetMap[source] = current;
      else if (old && !external(old)) ownedAssets.add(old);
    }
    // Older records did not have assetMap. Require both a managed embed and the
    // plugin's hashed filename inside the recorded memo folder; never move folders wholesale.
    if (!sources.length && record.assetFolder) for (const [index, text] of contents.entries()) {
      for (const target of extractManagedBodyEmbedTargets(text, slug)) {
        const local = resolveLink(app, 'wiki', target, states[index].path, paths);
        if (local?.startsWith(`${record.assetFolder}/`) && /^[a-f\d]{12}-/i.test(basename(local))) ownedAssets.add(local);
      }
    }
    for (const old of ownedAssets) {
      normalizeVaultPath(old);
      const suffix = record.assetFolder && old.startsWith(`${record.assetFolder}/`) ? old.slice(record.assetFolder.length + 1) : basename(old);
      const candidate = `${plan.assetFolder}/${suffix}`;
      if (candidate === old) continue;
      if (!paths.has(old)) throw new Error(`${old}：图片或附件缺失，已保留记录，请先恢复附件`);
      if (Object.entries(settings.syncedMemos).some(([otherSlug, other]) => otherSlug !== slug && Object.values(other.assetMap || {}).includes(old))) {
        throw new Error(`${old}：多个同步记录共用该附件，暂未移动，请先核对`);
      }
      const target = await uniqueTarget(app, candidate, slug, reserved);
      plan.moves.push({ from: old, to: target, kind: 'asset', hash: digest(await app.vault.adapter.readBinary(old)) });
      for (const source of sources) if (plan.assetMap[source] === old) plan.assetMap[source] = target;
    }
  }
  const moved = new Map(plan.moves.map(item => [item.from, item.to]));
  const newLink = (kind: string, target: string, note: string, destination: string): string => {
    const fragment = target.includes('#') ? target.slice(target.indexOf('#')) : '';
    return (kind === 'wiki' ? destination : encodeURI(relativePath(note, destination)).replace(/#/g, '%23').replace(/\?/g, '%3F')) + fragment;
  };
  for (const [index, state] of states.entries()) {
    const nextNote = moved.get(state.path) || state.path;
    const replacements: Record<string, string> = {};
    mapNoteLinks(contents[index], (kind, target) => {
      const resolved = resolveLink(app, kind, target, state.path, paths);
      if (!resolved || (!moved.has(resolved) && nextNote === state.path)) return target;
      const destination = moved.get(resolved) || resolved;
      const next = newLink(kind, target, nextNote, destination);
      if (next !== target) replacements[`${kind}:${target}`] = next;
      return target;
    });
    plan.links.push({ from: state.path, to: nextNote, slug, replacements });
  }
  // FileManager.renameFile can open a link-update modal. Plan exact incoming
  // link repairs before using Vault.rename so a background migration never asks.
  // Other notes keep all text and metadata; only links to these moved files change.
  if (moved.size) for (const file of app.vault.getMarkdownFiles()) {
    if (states.some(state => state.path === file.path)) continue;
    const replacements: Record<string, string> = {};
    for (const { kind, target } of await links.targets(file)) {
      const resolved = resolveLink(app, kind, target, file.path, paths);
      if (resolved && moved.has(resolved)) replacements[`${kind}:${target}`] = newLink(kind, target, file.path, moved.get(resolved)!);
    }
    if (Object.keys(replacements).length) plan.links.push({ from: file.path, to: file.path, replacements });
  }
  return plan;
}

async function finishMemo(app: App, settings: FlomoSafeSyncSettings, plan: MemoMove, save: () => Promise<void>, internalMoves: Set<string>, result: FolderMigrationResult): Promise<void> {
  const record = settings.syncedMemos[plan.slug];
  if (!record) throw new Error(`${plan.slug}：迁移中的同步记录已不存在`);
  // Recheck ownership on every resume before moving any attachments.
  for (const link of plan.links) {
    if (!link.slug) continue;
    const completed = plan.moves.some(move => move.kind === 'note' && move.from === link.from && move.done);
    const actual = completed ? link.to : await app.vault.adapter.exists(link.from) ? link.from : link.to;
    await readMovable(app, actual, plan.slug);
  }
  for (const move of plan.moves) {
    if (move.done) {
      if (move.kind === 'note') await readMovable(app, move.to, plan.slug);
      else if (digest(await app.vault.adapter.readBinary(move.to)) !== move.hash) throw new Error(`${move.to}：已移动的附件内容改变，请先核对`);
      continue;
    }
    const sourceExists = await app.vault.adapter.exists(move.from), targetExists = await app.vault.adapter.exists(move.to);
    if (sourceExists && targetExists) throw new Error(`${move.to}：目标已被占用，迁移暂停且未覆盖文件`);
    if (!sourceExists && !targetExists) throw new Error(`${move.from}：迁移文件缺失，请先恢复`);
    const observed = sourceExists ? move.from : move.to;
    if (move.kind === 'note') await readMovable(app, observed, plan.slug);
    else if (digest(await app.vault.adapter.readBinary(observed)) !== move.hash) throw new Error(`${observed}：附件内容已改变，迁移暂停`);
    if (sourceExists) {
      await ensureParentDir(app, move.to);
      const file = app.vault.getAbstractFileByPath(move.from);
      if (!(file instanceof TFile)) throw new Error(`${move.from}：Obsidian 尚未加载文件，请重试`);
      internalMoves.add(move.from);
      try { await app.vault.rename(file, move.to); } finally { internalMoves.delete(move.from); }
    }
    if (move.kind === 'note') {
      record.filePaths = record.filePaths.map(path => path === move.from ? move.to : path);
      for (const state of record.fileStates || []) if (state.path === move.from) state.path = move.to;
      result.notes++;
    } else {
      for (const [source, path] of Object.entries(record.assetMap || {})) if (path === move.from) record.assetMap![source] = move.to;
      result.assets++;
    }
    move.done = true;
    await save();
  }
  for (const link of plan.links) {
    if (!Object.keys(link.replacements).length) continue;
    const file = app.vault.getAbstractFileByPath(link.to);
    if (!(file instanceof TFile)) throw new Error(`${link.to}：笔记未加载，图片链接修复等待重试`);
    await app.vault.process(file, current => {
      if (link.slug && !hasMoveIdentity(current, link.slug)) throw new Error(`${link.to}：笔记身份冲突，保留原文`);
      const next = mapNoteLinks(current, (kind, target) => link.replacements[`${kind}:${target}`] ?? target);
      if (link.slug && !hasMoveIdentity(next, link.slug)) throw new Error(`${link.to}：迁移后校验失败`);
      return next;
    });
  }
  if (plan.assetFolder) { record.assetFolder = plan.assetFolder; record.assetMap = plan.assetMap; }
  delete settings.pendingFolderMigration!.current;
  await save();
}

/** Local-only migration, serialized with sync; intent is durable before the first rename. */
export async function migrateFolders(app: App, settings: FlomoSafeSyncSettings, save: () => Promise<void>, internalMoves = new Set<string>()): Promise<FolderMigrationResult> {
  validateFolderMigrationSettings(settings);
  const result: FolderMigrationResult = { notes: 0, assets: 0, errors: [] };
  const job = settings.pendingFolderMigration;
  if (!job) return result;
  if (job.current) {
    try { await save(); await finishMemo(app, settings, job.current, save, internalMoves, result); }
    catch (error) { result.errors.push((error as Error).message); return result; }
  }
  const identities = await new MemoIdentityIndex(app).find(new Set(Object.keys(settings.syncedMemos)));
  const links = new LinkIndex(app);
  for (const [slug, record] of Object.entries(settings.syncedMemos)) {
    if (!eligible(record, settings)) continue;
    try {
      const claims = identities.get(slug) || [];
      // Repair a stale tracked path only when exactly one verified file exists.
      if (record.filePaths.length === 1 && !await app.vault.adapter.exists(record.filePaths[0]) && claims.length === 1) {
        await readMovable(app, claims[0], slug);
        record.filePaths = [claims[0]];
        if (record.fileStates?.length === 1) record.fileStates[0].path = claims[0];
        await save();
      }
      if (claims.some(path => !record.filePaths.includes(path))) throw new Error(`${slug}：发现未记录的同编号笔记 ${claims.filter(path => !record.filePaths.includes(path)).join('；')}，请核对后重试`);
      const plan = await planMemo(app, settings, slug, record, job, links);
      if (!plan) continue;
      if (!plan.moves.length && (!plan.assetFolder || (plan.assetFolder === record.assetFolder && JSON.stringify(plan.assetMap) === JSON.stringify(record.assetMap || {})))) continue;
      job.current = plan;
      await save();
    } catch (error) {
      result.errors.push((error as Error).message);
      // Failure to persist a prepared transaction must stop all file operations.
      if (job.current) return result;
      continue;
    }
    try {
      const current = job.current!;
      await finishMemo(app, settings, current, save, internalMoves, result);
      links.invalidate(current);
    }
    catch (error) { result.errors.push((error as Error).message); return result; }
  }
  if (!result.errors.length) { delete settings.pendingFolderMigration; await save(); }
  return result;
}
