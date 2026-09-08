import { strict as assert } from 'assert';
import FlomoSafeSyncPlugin from '../main';
import { mapNoteLinks } from '../folder-migration';
import { FlomoSafeSyncSettings, migrateSettings } from '../settings';
import { buildNewMemoFile, FlomoMemo } from '../sync-core';
import { App, MemoryAdapter, clearMockObservations, getMockState, resetObsidianMock, setLoadedData, setMockMemos } from './obsidian-mock';

const slug = 'memo-001';
const source = 'https://img.example/picture.png';
const note = 'Old/自定义名字.md';
const asset = 'Old/_attachments/flomo/memo-001/123456789abc-picture.png';
const memo: FlomoMemo = { slug, content: `<p>原文</p><img src="${source}">`, tags: [{ name: '写作' }], created_at: '2026-09-01 08:00:00', updated_at: '2026-09-01 08:00:00' };
const original = buildNewMemoFile(memo, { syncedAt: '2026-09-01T00:00:00Z', imageMap: { [source]: asset } }) + '\n手写内容不变。\n';
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const cases: Array<{ name: string; run: () => void | Promise<void> }> = [];
const test = (name: string, run: () => void | Promise<void>) => cases.push({ name, run });
async function harness(overrides: Partial<FlomoSafeSyncSettings> = {}, files: Record<string, string> = {}) {
  resetObsidianMock();
  const settings = migrateSettings({ rootFolder: 'Old', imageFolder: 'Old/_attachments/flomo', scopeMode: 'exclude', scopeTags: [], localizeImages: true,
    autoSyncOnStartup: false, autoSyncIntervalMinutes: 0, syncedMemos: { [slug]: { filePaths: [note], fileName: '原始名称',
      updated_at: memo.updated_at, bodyUpdatedAt: memo.updated_at, propertiesUpdatedAt: memo.updated_at, tagsMerged: true,
      lastKnownTags: ['写作'], lastAppliedFlomoTags: ['写作'], status: 'active', assetFolder: 'Old/_attachments/flomo/memo-001', assetMap: { [source]: asset } } }, ...overrides });
  setLoadedData(settings);
  const adapter = new MemoryAdapter({ [note]: original, [asset]: 'exact binary bytes', 'Other/user.md': '用户自己的内容', ...files });
  const plugin = new FlomoSafeSyncPlugin(new App(adapter) as any, { id: 'test', name: 'test', version: '0.3.10', minAppVersion: '1.2.3', author: 'test', description: 'test' });
  await plugin.loadSettings();
  return { adapter, plugin };
}
type Harness = Awaited<ReturnType<typeof harness>>;
const record = (h: Harness) => h.plugin.settings.syncedMemos[slug];
async function changeRoot(h: Harness, path = 'Correct') { h.plugin.settings.rootFolder = path; await h.plugin.saveSettingsAndMigrate(); }
async function reload(h: Harness) { setLoadedData(getMockState().savedData.at(-1)); await h.plugin.loadSettings(); }

test('saving the root moves existing note and nested images offline and preserves history', async () => {
  const h = await harness(), before = clone(record(h));
  await changeRoot(h);
  const next = 'Correct/自定义名字.md', image = asset.replace('Old/', 'Correct/');
  assert.equal(h.plugin.settings.imageFolder, 'Correct/_attachments/flomo');
  assert.equal(h.adapter.files.get(next), original.replace(asset, image));
  assert.equal(h.adapter.files.get(image), 'exact binary bytes');
  assert.equal(h.adapter.files.has(note), false); assert.equal(h.adapter.files.has(asset), false);
  assert.equal(h.adapter.files.get('Other/user.md'), '用户自己的内容');
  assert.equal(record(h).updated_at, before.updated_at); assert.equal(record(h).fileName, before.fileName);
  assert.equal(record(h).assetMap![source], image); assert.equal(h.plugin.settings.pendingFolderMigration, undefined);
  assert.equal(getMockState().requests.length, 0);
  await reload(h); assert.deepEqual(record(h).filePaths, [next]); assert.equal(record(h).assetMap![source], image);
});
test('independently configured image folder stays when only root changes', async () => {
  const h = await harness({ imageFolder: 'Independent' });
  await changeRoot(h); assert.equal(h.plugin.settings.imageFolder, 'Independent'); assert.equal(h.adapter.files.get(asset), 'exact binary bytes');
  assert.equal(record(h).assetFolder, 'Old/_attachments/flomo/memo-001');
});
test('image-only change moves binary attachments and updates live fileStates without moving notes', async () => {
  const h = await harness(); record(h).fileStates = [{ path: note, state: 'live' }];
  h.plugin.settings.imageFolder = '新 图片'; await h.plugin.saveSettingsAndMigrate();
  assert.deepEqual(record(h).filePaths, [note]); assert.deepEqual(record(h).fileStates, [{ path: note, state: 'live' }]);
  assert.equal(h.adapter.files.get(note), original.replace(asset, '新 图片/memo-001/123456789abc-picture.png'));
  assert.equal(h.adapter.files.has(asset), false);
});
test('editing a tag folder, priority and clearing a mapping moves existing files', async () => {
  const h = await harness(); record(h).lastKnownTags = ['写作', '素材'];
  h.plugin.settings.tagFolderMappings = [{ tag: '写作', folder: 'Writing' }, { tag: '素材', folder: '素材' }];
  await h.plugin.saveSettingsAndMigrate(); assert.deepEqual(record(h).filePaths, ['Writing/自定义名字.md']);
  h.plugin.settings.tagFolderMappings.reverse(); await h.plugin.saveSettingsAndMigrate(); assert.deepEqual(record(h).filePaths, ['素材/自定义名字.md']);
  h.plugin.settings.tagFolderMappings = []; await h.plugin.saveSettingsAndMigrate(); assert.deepEqual(record(h).filePaths, [note]);
});
test('outside scope, archived, deleted and pending trash records remain untouched', async () => {
  for (const variant of ['scope', 'archive', 'deleted', 'trash', 'pending']) {
    const h = await harness();
    if (variant === 'scope') { h.plugin.settings.scopeMode = 'include'; h.plugin.settings.scopeTags = ['其它']; }
    if (variant === 'archive') record(h).fileStates = [{ path: note, state: 'archived', originalPath: 'Original/a.md' }];
    if (variant === 'deleted') record(h).status = 'deleted';
    if (variant === 'trash') record(h).pendingTrash = true;
    if (variant === 'pending') record(h).fileStates = [{ path: note, state: 'live', pending: { action: 'archive', target: 'Archive/a.md' } }];
    await changeRoot(h); assert.equal(h.adapter.moves.length, 0, variant); assert.equal(h.adapter.files.get(note), original);
  }
});
test('frozen/new-only notes migrate without changing their content update clocks', async () => {
  const h = await harness({ updateMode: 'new-only', excludedTags: ['写作'], excludedPolicy: 'freeze' });
  record(h).excluded = true; await changeRoot(h);
  assert.equal(record(h).excluded, true); assert.equal(record(h).bodyUpdatedAt, memo.updated_at);
  assert.ok(h.adapter.files.get(record(h).filePaths[0])?.includes('手写内容不变。'));
});
test('file and attachment collisions use suffixes and never overwrite', async () => {
  const destination = asset.replace('Old/', 'Correct/');
  const h = await harness({}, { 'Correct/自定义名字.md': 'private unrelated note', [destination]: 'different image' });
  await changeRoot(h);
  assert.equal(h.adapter.files.get('Correct/自定义名字.md'), 'private unrelated note'); assert.equal(h.adapter.files.get(destination), 'different image');
  assert.equal(record(h).filePaths[0], 'Correct/自定义名字_memo-001.md');
  assert.equal(record(h).assetMap![source], 'Correct/_attachments/flomo/memo-001/123456789abc-picture_memo-001.png');
});
test('multiple tracked historical copies survive a merge into one directory', async () => {
  const h = await harness({}, { 'Another/自定义名字.md': original });
  record(h).filePaths.push('Another/自定义名字.md'); await changeRoot(h);
  assert.equal(record(h).filePaths.length, 2); assert.equal(new Set(record(h).filePaths).size, 2);
  for (const path of record(h).filePaths) assert.ok(h.adapter.files.get(path)?.includes('手写内容不变。'));
});
test('legacy asset records move only managed referenced hashed files', async () => {
  const h = await harness({}, { 'Old/_attachments/flomo/memo-001/user.png': 'personal', 'Old/_attachments/flomo/memo-001/999999999999-orphan.png': 'untracked' });
  delete record(h).assetMap; await changeRoot(h);
  assert.equal(h.adapter.files.has(asset), false);
  assert.equal(h.adapter.files.get('Old/_attachments/flomo/memo-001/user.png'), 'personal');
  assert.equal(h.adapter.files.get('Old/_attachments/flomo/memo-001/999999999999-orphan.png'), 'untracked');
});
test('existing image-host URLs remain and no network download occurs', async () => {
  const hosted = 'https://cdn.example/hosted.png';
  const h = await harness({}, { [note]: original.replace(`![[${asset}]]`, `![](${hosted})`) });
  h.adapter.files.delete(asset); await changeRoot(h);
  assert.equal(record(h).assetMap![source], hosted); assert.ok(h.adapter.files.get(record(h).filePaths[0])?.includes(hosted));
  assert.equal(getMockState().requests.length, 0); assert.equal(h.plugin.lastErrors.length, 0);
});
test('missing files, broken ownership and duplicate identities are reported without moves', async () => {
  for (const variant of ['missing', 'broken', 'duplicate', 'asset']) {
    const h = await harness();
    if (variant === 'missing') h.adapter.files.delete(note);
    if (variant === 'broken') h.adapter.files.set(note, original.replace('flomo_slug: "memo-001"', 'flomo_slug: "another-memo"'));
    if (variant === 'duplicate') h.adapter.files.set('Unknown/same.md', original);
    if (variant === 'asset') h.adapter.files.delete(asset);
    await changeRoot(h); assert.ok(h.plugin.lastErrors.length > 0, variant); assert.equal(h.adapter.moves.length, 0, variant);
    assert.ok(h.plugin.settings.pendingFolderMigration);
  }
});
test('property editor removed comments do not prevent moving an identified note', async () => {
  const rewritten = original.replace(/^# flomo-sync:frontmatter:.*\n/gm, '');
  const h = await harness({}, { [note]: rewritten }); await changeRoot(h);
  assert.equal(h.plugin.lastErrors.length, 0);
  assert.equal(h.adapter.files.get(record(h).filePaths[0]), rewritten.replace(asset, asset.replace('Old/', 'Correct/')));
});
test('a unique verified memo elsewhere repairs its stale tracked path and moves once', async () => {
  const h = await harness({}, { 'Elsewhere/renamed.md': original }); h.adapter.files.delete(note);
  await changeRoot(h); assert.equal(h.plugin.lastErrors.length, 0); assert.equal(record(h).filePaths[0], 'Correct/renamed.md');
  assert.equal(h.adapter.files.has('Elsewhere/renamed.md'), false);
});
test('duplicate identity keys and invalid YAML cannot authorize a move', async () => {
  for (const text of [original.replace('flomo_status:', 'flomo_slug: "memo-001"\nflomo_status:'), original.replace('flomo_status: active', 'flomo_status: [broken')]) {
    const h = await harness({}, { [note]: text }); await changeRoot(h);
    assert.equal(h.adapter.moves.length, 0); assert.ok(h.plugin.lastErrors.length);
  }
});
test('shared attachments are not moved away from another record', async () => {
  const h = await harness(); h.plugin.settings.syncedMemos.other = { ...clone(record(h)), filePaths: [], assetMap: { other: asset } };
  await changeRoot(h); assert.equal(h.adapter.moves.length, 0); assert.ok(h.plugin.lastErrors.some(error => error.includes('共用')));
});
test('failed rename retains a resumable journal across reload', async () => {
  const h = await harness(); h.adapter.failMovePath = asset; await changeRoot(h);
  assert.ok(h.plugin.settings.pendingFolderMigration?.current); await reload(h); h.adapter.failMovePath = '';
  const result = await h.plugin.relocateExistingFiles(false); assert.equal(result.errors.length, 0);
  assert.equal(h.plugin.settings.pendingFolderMigration, undefined); assert.equal(h.adapter.files.has(asset), false);
});
test('power loss after rename but before checkpoint reconciles source/target and links', async () => {
  const h = await harness(); const save = h.plugin.saveData.bind(h.plugin); let interrupted = false;
  h.plugin.saveData = async data => {
    if (h.adapter.moves.length && !interrupted) { interrupted = true; throw new Error('power loss'); }
    await save(data);
  };
  await changeRoot(h); assert.ok(h.plugin.lastErrors.includes('power loss'));
  h.plugin.saveData = save; await reload(h); await h.plugin.relocateExistingFiles(false);
  assert.equal(h.plugin.lastErrors.length, 0); assert.equal(h.adapter.moves.length, 2);
  assert.equal(h.adapter.files.get(record(h).filePaths[0]), original.replace(asset, asset.replace('Old/', 'Correct/')));
});
test('save failure before intent performs no moves and preserves prior settings', async () => {
  const h = await harness(); h.plugin.saveData = async () => { throw new Error('disk full'); };
  await assert.rejects(() => changeRoot(h), /disk full/);
  assert.equal(h.adapter.moves.length, 0); assert.equal(h.plugin.settings.rootFolder, 'Old'); assert.equal(h.plugin.syncRunning, false);
});
test('failed link write resumes without renaming twice', async () => {
  const h = await harness(); h.adapter.failWritePath = 'Correct/自定义名字.md'; await changeRoot(h);
  assert.ok(h.plugin.lastErrors.length); assert.equal(h.adapter.moves.length, 2);
  await reload(h); h.adapter.failWritePath = ''; await h.plugin.relocateExistingFiles(false);
  assert.equal(h.adapter.moves.length, 2); assert.equal(h.plugin.lastErrors.length, 0);
  assert.ok(h.adapter.files.get(record(h).filePaths[0])?.includes(asset.replace('Old/', 'Correct/')));
});
test('an occupied interrupted target and changed asset bytes stop safely', async () => {
  for (const variant of ['collision', 'hash']) {
    const h = await harness(); h.adapter.failMovePath = asset; await changeRoot(h); h.adapter.failMovePath = '';
    if (variant === 'collision') h.adapter.files.set(asset.replace('Old/', 'Correct/'), 'intruder');
    else h.adapter.files.set(asset, 'changed');
    const before = h.adapter.moves.length; await h.plugin.relocateExistingFiles(false);
    assert.ok(h.plugin.lastErrors.length); assert.equal(h.adapter.moves.length, before);
  }
});
test('second directory change finishes pending move then uses the latest target', async () => {
  const h = await harness(); h.adapter.failMovePath = asset; await changeRoot(h); h.adapter.failMovePath = '';
  await changeRoot(h, 'Final'); assert.equal(h.plugin.lastErrors.length, 0);
  assert.equal(record(h).filePaths[0], 'Final/自定义名字.md'); assert.ok(record(h).assetMap![source].startsWith('Final/'));
});
test('no-op and non-directory settings saves do not move or re-read files', async () => {
  const h = await harness(); await h.plugin.saveSettingsAndMigrate(); h.plugin.settings.autoSyncIntervalMinutes = 5;
  await h.plugin.saveSettingsAndMigrate(); assert.equal(h.adapter.moves.length, 0); assert.equal(h.adapter.writes.length, 0);
});
test('directory changes are rejected and restored while sync is running', async () => {
  const h = await harness(); h.plugin.syncRunning = true;
  await assert.rejects(() => changeRoot(h), /正在同步/); assert.equal(h.plugin.settings.rootFolder, 'Old'); assert.equal(h.adapter.moves.length, 0);
});
test('unsafe paths are rejected before settings or files are written', async () => {
  const h = await harness(); await assert.rejects(() => changeRoot(h, '../outside'), /路径/);
  assert.equal(h.adapter.moves.length, 0); assert.equal(h.plugin.settings.rootFolder, 'Old');
});
test('hidden destination folders are rejected before any migration', async () => {
  const h = await harness(); await assert.rejects(() => changeRoot(h, '.obsidian/notes'), /隐藏目录/);
  assert.equal(h.adapter.moves.length, 0); assert.equal(h.plugin.settings.rootFolder, 'Old');
});
test('ordinary sync after migration updates same note and reuses moved attachment', async () => {
  const h = await harness(); await changeRoot(h); h.plugin.settings.bearerToken = 'fixture-token'; clearMockObservations();
  setMockMemos([{ ...memo, content: `<p>新正文</p><img src="${source}">`, updated_at: '2026-09-02 08:00:00' }]);
  await h.plugin.runSync(); assert.equal(h.plugin.lastResult?.updatedCount, 1); assert.equal(h.plugin.lastResult?.newCount, 0);
  assert.equal(h.adapter.binaryWrites.length, 0); assert.equal(getMockState().requests.filter(req => req.url === source).length, 0);
  assert.ok(h.adapter.files.get(record(h).filePaths[0])?.includes('手写内容不变。'));
});
test('relative Markdown, wiki aliases, reference links and HTML images survive note and asset moves', async () => {
  const relative = '_attachments/flomo/memo-001/123456789abc-picture.png';
  const h = await harness({}, { [note]: original + `[附件](${relative} "标题")\n![[${asset}|300]]\n<img src="${relative}" alt="图片">\n[ref]: <${relative}>\n[手工链接](../Other/user.md)\n` });
  h.plugin.settings.imageFolder = 'Images'; h.plugin.settings.rootFolder = 'Deep/Correct'; await h.plugin.saveSettingsAndMigrate();
  const content = h.adapter.files.get(record(h).filePaths[0])!;
  assert.ok(content.includes('[附件](../../Images/memo-001/123456789abc-picture.png "标题")'), content);
  assert.ok(content.includes('![[Images/memo-001/123456789abc-picture.png|300]]'));
  assert.ok(content.includes('<img src="../../Images/memo-001/123456789abc-picture.png"'));
  assert.ok(content.includes('[ref]: <../../Images/memo-001/123456789abc-picture.png>'));
  assert.ok(content.includes('[手工链接](../../Other/user.md)'));
});
test('link replacement leaves inline code, fenced examples, prose and labels unchanged', () => {
  const text = 'keep x.md `[[x.md]]`\n```md\n[[x.md]]\n```\n~~~\n[x](x.md)\n~~~\n[[x.md|label]] [x.md](x.md)\n';
  assert.equal(mapNoteLinks(text, (_kind, target) => target === 'x.md' ? 'new.md' : target), text.replace('[[x.md|label]] [x.md](x.md)', '[[new.md|label]] [x.md](new.md)'));
});
test('backlinks in other notes update without moving them or changing their prose', async () => {
  const h = await harness({}, { 'Other/backlinks.md': `用户正文\n[[${note}|别名]]\n![共享图片](../${asset})\n\n保留属性和正文` });
  await changeRoot(h);
  assert.equal(h.adapter.files.get('Other/backlinks.md'), `用户正文\n[[Correct/自定义名字.md|别名]]\n![共享图片](../${asset.replace('Old/', 'Correct/')})\n\n保留属性和正文`);
});
test('links between separately migrated memos follow both final destinations', async () => {
  const h = await harness({}, { 'Other/second.md': buildNewMemoFile({ ...memo, slug: 'second' }, { syncedAt: '2026-09-01T00:00:00Z' }) + `\n[[${note}]]\n` });
  h.adapter.files.set(note, original + '\n[[Other/second.md]]\n');
  h.plugin.settings.syncedMemos.second = { filePaths: ['Other/second.md'], fileName: 'second', updated_at: memo.updated_at, lastKnownTags: ['写作'] };
  await changeRoot(h);
  assert.equal(h.plugin.lastErrors.length, 0);
  assert.ok(h.adapter.files.get('Correct/自定义名字.md')?.includes('[[Correct/second.md]]'));
  assert.ok(h.adapter.files.get('Correct/second.md')?.includes('[[Correct/自定义名字.md]]'));
});
test('Obsidian resolution wins when a short wikilink has ambiguous filenames', async () => {
  const h = await harness({}, { '自定义名字.md': 'another file', 'Old/reference.md': '[[自定义名字.md]]' });
  (h.plugin.app as any).metadataCache = { getFirstLinkpathDest: (path: string, sourcePath: string) => path === '自定义名字.md' && sourcePath === 'Old/reference.md' ? { path: note } : null };
  await changeRoot(h); assert.equal(h.adapter.files.get('Old/reference.md'), '[[Correct/自定义名字.md]]');
  assert.equal(h.adapter.files.get('自定义名字.md'), 'another file');
});

async function main() {
  for (const item of cases) { await item.run(); console.log(`PASS ${item.name}`); }
  console.log(`Folder migration: ${cases.length} scenarios passed`);
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
