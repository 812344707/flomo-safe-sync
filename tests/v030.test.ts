import { strict as assert } from 'assert';
import FlomoSafeSyncPlugin from '../main';
import { DEFAULT_FILE_NAME, FlomoSafeSyncSettings, migrateSettings } from '../settings';
import { FlomoMemo, buildNewMemoFile, computeDesiredPaths, extractYamlTags, renderYamlTemplate, tagsInScope, validateFileNameTemplate, validateYamlTemplate } from '../sync-core';
import { App, MemoryAdapter, clearMockObservations, getMockState, parseYaml, resetObsidianMock, setLoadedData, setMockMemos, setMockResponses } from './obsidian-mock';

const memo: FlomoMemo = { slug: 'memo-001', content: '<p>原始内容</p>', tags: [{ name: '写作' }], created_at: '2026-09-01 08:00:00', updated_at: '2026-09-01 08:00:00' };
const updated: FlomoMemo = { ...memo, content: '<p>更新内容</p>', tags: [{ name: '素材' }], updated_at: '2026-09-02 09:00:00' };
const path = 'Inbox/note.md';
const originalNote = buildNewMemoFile(memo, { syncedAt: '2026-09-01T00:00:00Z' })
  .replace('## 我的补充\n\n', '## 我的补充\n\n必须保留的手工内容\n')
  .replace('tags:\n', 'handwritten: 保留\ntags:\n').replace('  - "写作"', '  - "写作"\n  - "手工标签"');
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const cases: Array<{ name: string; run: () => void | Promise<void> }> = [];
const test = (name: string, run: () => void | Promise<void>) => cases.push({ name, run });
async function harness(overrides: Partial<FlomoSafeSyncSettings> = {}, existing = true) {
  resetObsidianMock();
  const adapter = new MemoryAdapter(existing ? { [path]: originalNote, 'Images/retained.png': 'retained binary' } : {});
  const app = new App(adapter);
  const plugin = new FlomoSafeSyncPlugin(app as unknown as ConstructorParameters<typeof FlomoSafeSyncPlugin>[0], { id: 'test', name: 'test', version: '0.3.0', minAppVersion: '1.2.3', author: 'test', description: 'test' });
  await plugin.loadSettings();
  Object.assign(plugin.settings, { bearerToken: 'v030-fake-token', rootFolder: 'Inbox', imageFolder: 'Images', scopeMode: 'exclude', scopeTags: [], localizeImages: false,
    syncedMemos: existing ? { [memo.slug]: { updated_at: memo.updated_at, bodyUpdatedAt: memo.updated_at, propertiesUpdatedAt: memo.updated_at,
      fileName: 'note', filePaths: [path], status: 'active', lastKnownTags: ['写作'], lastAppliedFlomoTags: ['写作'], tagsMerged: true, assetFolder: 'OldImages/memo-001' } } : {}, ...overrides });
  return { plugin, adapter };
}
type Harness = Awaited<ReturnType<typeof harness>>;
async function sync(h: Harness, memos: FlomoMemo[]) { setMockMemos(memos); await h.plugin.runSync(); assert.equal(h.plugin.syncRunning, false); }
async function reload(h: Harness) { setLoadedData(h.plugin.settings); await h.plugin.loadSettings(); }
const record = (h: Harness) => h.plugin.settings.syncedMemos[memo.slug];
function unchanged(h: Harness) { assert.equal(h.adapter.files.get(path), originalNote); assert.equal(h.adapter.files.get('Images/retained.png'), 'retained binary'); }

test('v0.2 migration preserves include scope, custom template and history; runs idempotently', () => {
  const old = { rootFolder: 'Old', fileNameTemplate: '{{YYYY-MM-DD-HHmmss}}', tagFolderMappings: [{ tag: '#写作', folder: 'Writing' }], excludedTags: ['归档'], excludedPolicy: 'skip' as const,
    syncedMemos: { a: { updated_at: memo.updated_at, fileName: 'a', filePaths: ['Old/a.md'], assetFolder: 'Old/assets', lastKnownTags: ['写作'], tagsMerged: true } } };
  const migrated = migrateSettings(old);
  assert.deepEqual(migrated.scopeTags, ['写作']); assert.equal(migrated.scopeMode, 'include');
  assert.equal(migrated.fileNameMode, 'custom'); assert.equal(migrated.customFileNameTemplate, old.fileNameTemplate);
  assert.equal(migrated.imageFolder, 'Old/_attachments/flomo'); assert.equal(migrated.syncedMemos.a.assetFolder, 'Old/assets');
  assert.equal(migrated.syncedMemos.a.bodyUpdatedAt, memo.updated_at); assert.equal(migrated.syncedMemos.a.propertiesUpdatedAt, memo.updated_at);
  assert.deepEqual(migrateSettings(migrated), migrated); assert.equal(migrateSettings({ fileNameTemplate: DEFAULT_FILE_NAME }).fileNameMode, 'default');
  assert.equal(old.tagFolderMappings[0].tag, '#写作');
});
test('default settings never share arrays or records', () => { const a = migrateSettings(), b = migrateSettings(); a.scopeTags.push('a'); assert.deepEqual(b.scopeTags, []); });
test('scope empty selections, tagless memos, exact matching and first route', () => {
  const settings = migrateSettings({ scopeTags: ['写作'], tagFolderMappings: [{ tag: '写作', folder: 'First' }, { tag: '素材', folder: 'Second' }], rootFolder: 'Inbox' });
  assert.equal(tagsInScope(['写作/归档'], settings), false); assert.equal(tagsInScope([], settings), false);
  assert.ok(computeDesiredPaths({ ...memo, tags: [{ name: '素材' }, { name: '写作' }] }, settings)[0].startsWith('First/'));
  settings.scopeTags = []; assert.deepEqual(computeDesiredPaths(memo, settings), []);
  settings.scopeMode = 'exclude'; assert.ok(computeDesiredPaths({ ...memo, tags: [] }, settings)[0].startsWith('Inbox/'));
});
test('leaving scope retains file, re-entering catches up and never counts as remote deletion', async () => {
  const h = await harness({ scopeMode: 'include', scopeTags: ['写作'] }); await sync(h, [updated]); unchanged(h);
  assert.equal(record(h).status, 'active'); assert.equal(record(h).outOfScope, true);
  h.plugin.settings.scopeTags = ['素材']; await sync(h, [updated]); assert.match(h.adapter.files.get(path)!, /更新内容/);
});
test('new note in include scope falls back to root without a route', async () => {
  const h = await harness({ scopeMode: 'include', scopeTags: ['写作'] }, false); await sync(h, [memo]); assert.equal(h.plugin.lastResult?.newCount, 1);
  assert.ok(record(h).filePaths[0].startsWith('Inbox/'));
});

for (const mode of ['both', 'body', 'properties', 'new-only'] as const) test(`${mode} only changes selected regions and keeps manual content`, async () => {
  const h = await harness({ updateMode: mode }); await sync(h, [updated]); const content = h.adapter.files.get(path)!;
  assert.match(content, /必须保留的手工内容/); assert.match(content, /handwritten: 保留/);
  if (mode === 'both' || mode === 'body') assert.match(content, /更新内容/); else assert.match(content, /原始内容/);
  if (mode === 'body' || mode === 'new-only') assert.equal(content.split('<!-- flomo-sync:content:start -->')[0], originalNote.split('<!-- flomo-sync:content:start -->')[0]);
  else assert.deepEqual(extractYamlTags(content), ['素材', '手工标签']);
  assert.equal(h.adapter.binaryWrites.length, 0);
});
for (const mode of ['body', 'properties', 'new-only'] as const) test(`${mode} followed by both catches up after reload without a new remote timestamp`, async () => {
  const h = await harness({ updateMode: mode }); await sync(h, [updated]); await reload(h);
  h.plugin.settings.updateMode = 'both'; await sync(h, [updated]);
  assert.match(h.adapter.files.get(path)!, /更新内容/); assert.deepEqual(extractYamlTags(h.adapter.files.get(path)!), ['素材', '手工标签']);
  assert.equal(record(h).bodyUpdatedAt, updated.updated_at); assert.equal(record(h).propertiesUpdatedAt, updated.updated_at);
});
test('new-only still imports complete first notes', async () => { const h = await harness({ updateMode: 'new-only' }, false); await sync(h, [memo]); assert.match(h.adapter.files.get(record(h).filePaths[0])!, /原始内容/); });
test('a conflicting destination prevents attachment downloads and version advancement', async () => {
  const h = await harness({ localizeImages: true }); h.adapter.files.set(path, originalNote.replace('memo-001', 'someone-else'));
  await sync(h, [{ ...updated, content: '<img src="https://img.example/a.png">' }]);
  assert.equal(h.adapter.binaryWrites.length, 0); assert.equal(record(h).bodyUpdatedAt, memo.updated_at); assert.equal(h.plugin.lastResult?.conflictCount, 1);
});

for (const bad of [null, {}, { code: 0 }, { code: 0, data: null }, { code: 0, data: {} }, { code: 500, data: [] }, { code: 0, data: [null] },
  { code: 0, data: [{ ...memo, slug: '' }] }, { code: 0, data: [{ ...memo, updated_at: 'bad date' }] }, { code: 0, data: [{ ...memo, tags: null }] }, { code: 0, data: [memo, memo] }]) {
  test(`invalid snapshot aborts every mutation: ${JSON.stringify(bad).slice(0, 80)}`, async () => {
    const h = await harness({ deletionAction: 'archive', localizeImages: true }); const before = clone(h.plugin.settings);
    setMockResponses([bad]); await h.plugin.runSync(); unchanged(h);
    assert.equal(h.adapter.writes.length, 0); assert.equal(h.adapter.moves.length, 0); assert.equal(h.adapter.binaryWrites.length, 0);
    assert.deepEqual(h.plugin.settings, before); assert.equal(getMockState().savedData.length, 0); assert.equal(h.plugin.syncRunning, false);
  });
}
const fullPage = Array.from({ length: 200 }, (_, i) => ({ ...memo, slug: `page-${i}` }));
for (const next of [new Error('network failure'), { code: 0 }, { code: 0, data: fullPage }]) test('later page error discards earlier valid pages before all writes', async () => {
  const h = await harness(); setMockResponses([{ code: 0, data: fullPage }, next]); await h.plugin.runSync(); unchanged(h); assert.equal(h.adapter.writes.length, 0); assert.equal(getMockState().savedData.length, 0);
});
test('full page with equal timestamps advances by slug and requires terminal page', async () => {
  const h = await harness({ scopeMode: 'include', scopeTags: [] }); setMockResponses([{ code: 0, data: fullPage }, { code: 0, data: [] }]); await h.plugin.runSync();
  assert.equal(h.plugin.lastResult?.total, 200); const request = new URL(getMockState().requests[1].url);
  assert.equal(request.searchParams.get('latest_slug'), 'page-199'); assert.equal(request.searchParams.get('latest_updated_at'), String(Date.parse('2026-09-01T08:00:00+08:00') / 1000));
});

test('keep deletion leaves notes and attachments byte-for-byte unchanged', async () => { const h = await harness({ deletionAction: 'keep' }); await sync(h, []); unchanged(h); assert.equal(record(h).status, 'deleted'); assert.equal(h.adapter.writes.length, 0); });
test('keep and unexecuted trash resurrection do not rewrite YAML under new-only', async () => {
  for (const deletionAction of ['keep', 'trash'] as const) {
    const h = await harness({ deletionAction, updateMode: 'new-only' }); await sync(h, []); await sync(h, [updated]); unchanged(h); assert.equal(h.adapter.writes.length, 0);
  }
});
test('remote resurrection cancels an archive that failed before the move', async () => {
  const h = await harness({ deletionAction: 'archive' }); h.adapter.failMovePath = path; await sync(h, []); assert.ok(record(h).fileStates![0].pending);
  h.adapter.failMovePath = ''; await sync(h, [updated]); assert.equal(h.adapter.moves.length, 0); assert.equal(record(h).fileStates![0].pending, undefined); assert.equal(record(h).status, 'active');
});
test('mark deletion and resurrection preserve manual text and work under new-only', async () => {
  const h = await harness({ updateMode: 'new-only' }); await sync(h, []); assert.match(h.adapter.files.get(path)!, /flomo_status: deleted/);
  await sync(h, [updated]); assert.match(h.adapter.files.get(path)!, /flomo_status: active/); assert.match(h.adapter.files.get(path)!, /原始内容/);
});
test('scope exclusions protect missing memos from deletion actions', async () => { const h = await harness({ scopeTags: ['写作'], deletionAction: 'archive' }); await sync(h, []); unchanged(h); assert.equal(h.adapter.moves.length, 0); });
test('archive keeps relative path, survives reload, and restores original path', async () => {
  const h = await harness({ deletionAction: 'archive', archiveFolder: 'Archive' }); await sync(h, []);
  assert.equal(record(h).filePaths[0], 'Archive/Inbox/note.md'); assert.equal(h.adapter.moves.length, 1);
  await reload(h); await sync(h, []); assert.equal(h.adapter.moves.length, 1);
  await sync(h, [updated]); assert.equal(record(h).filePaths[0], path); assert.equal(h.adapter.moves.length, 2);
  assert.match(h.adapter.files.get(path)!, /必须保留/); assert.equal(h.adapter.files.get('Images/retained.png'), 'retained binary');
});
test('archive collision adds suffix; occupied restore path remains unchanged', async () => {
  const h = await harness({ deletionAction: 'archive', archiveFolder: 'Archive' }); h.adapter.files.set('Archive/Inbox/note.md', 'other file'); await sync(h, []);
  assert.equal(record(h).filePaths[0], 'Archive/Inbox/note_memo-001.md'); assert.equal(h.adapter.files.get('Archive/Inbox/note.md'), 'other file');
  h.adapter.files.set(path, 'manual replacement'); await sync(h, [updated]); assert.equal(h.adapter.files.get(path), 'manual replacement'); assert.equal(record(h).status, 'deleted');
});
test('partial archive failure retries only unfinished files after reload', async () => {
  const h = await harness({ deletionAction: 'archive', archiveFolder: 'Archive' }); const second = 'Legacy/copy.md'; h.adapter.files.set(second, originalNote); record(h).filePaths.push(second); h.adapter.failMovePath = second;
  await sync(h, []); assert.equal(h.adapter.moves.length, 1); assert.ok(record(h).fileStates![1].pending);
  await reload(h); h.adapter.failMovePath = ''; await sync(h, []); assert.equal(h.adapter.moves.length, 2); assert.equal(record(h).status, 'deleted');
});
test('interrupted archive reconciles persisted intent when source was already moved', async () => {
  const h = await harness({ deletionAction: 'archive', archiveFolder: 'Archive' });
  record(h).fileStates = [{ path, originalPath: path, state: 'live', pending: { action: 'archive', target: 'Archive/Inbox/note.md' } }];
  h.adapter.files.set('Archive/Inbox/note.md', originalNote); h.adapter.files.delete(path); await reload(h); await sync(h, []);
  assert.equal(record(h).filePaths[0], 'Archive/Inbox/note.md'); assert.equal(h.adapter.moves.length, 0); assert.equal(record(h).fileStates![0].pending, undefined);
});
test('trash queues without writing, rechecks snapshot, moves only selected file and retains attachments', async () => {
  const h = await harness({ deletionAction: 'trash' }); const second = 'Legacy/copy.md'; h.adapter.files.set(second, originalNote); record(h).filePaths.push(second);
  await sync(h, []); unchanged(h); assert.equal(h.adapter.trashed.length, 0); assert.equal(record(h).pendingTrash, true);
  clearMockObservations(); setMockMemos([]); await h.plugin.trashSelected([path]); assert.equal(getMockState().requests.length, 1);
  assert.deepEqual(h.adapter.trashed, [path]); assert.ok(h.adapter.files.has(second)); assert.equal(h.adapter.files.get('Images/retained.png'), 'retained binary');
  await reload(h); await sync(h, []); assert.deepEqual(h.adapter.trashed, [path]);
});
test('trash request cancels if memo returned remotely or scope changed', async () => {
  const h = await harness({ deletionAction: 'trash' }); await sync(h, []); setMockMemos([memo]); await h.plugin.trashSelected([path]); unchanged(h); assert.equal(h.adapter.trashed.length, 0);
  await sync(h, []); h.plugin.settings.scopeTags = ['写作']; setMockMemos([]); await h.plugin.trashSelected([path]); unchanged(h); assert.equal(h.adapter.trashed.length, 0);
});
test('invalid fresh snapshot, ownership changes and changed policy all prevent trash', async () => {
  const h = await harness({ deletionAction: 'trash' }); await sync(h, []); setMockResponses([{ code: 0, data: null }]); await h.plugin.trashSelected([path]); unchanged(h);
  h.adapter.files.set(path, 'manual replacement'); setMockMemos([]); await h.plugin.trashSelected([path]); assert.equal(h.adapter.files.get(path), 'manual replacement');
  h.adapter.files.set(path, originalNote); h.plugin.settings.deletionAction = 'keep'; await h.plugin.trashSelected([path]); unchanged(h); assert.equal(h.adapter.trashed.length, 0);
});
test('partial trash failure survives restart; automatic sync cannot finish unselected operations', async () => {
  const h = await harness({ deletionAction: 'trash' }); const second = 'Legacy/copy.md'; h.adapter.files.set(second, originalNote); record(h).filePaths.push(second);
  await sync(h, []); h.adapter.failTrashPath = second; await h.plugin.trashSelected([path, second]); assert.deepEqual(h.adapter.trashed, [path]);
  await reload(h); h.adapter.failTrashPath = ''; await sync(h, []); assert.deepEqual(h.adapter.trashed, [path]);
  await h.plugin.trashSelected([second]); assert.deepEqual(h.adapter.trashed, [path, second]); assert.equal(record(h).pendingTrash, false);
});
test('remote resurrection after trash waits for manually restored original, then resumes', async () => {
  const h = await harness({ deletionAction: 'trash' }); await sync(h, []); await h.plugin.trashSelected([path]); await sync(h, [updated]);
  assert.equal(h.adapter.files.has(path), false); assert.ok(h.plugin.lastErrors.some(error => error.includes('.trash')));
  h.adapter.files.set(path, h.adapter.files.get(`.trash/${path}`)!); await sync(h, [updated]); assert.match(h.adapter.files.get(path)!, /更新内容/); assert.match(h.adapter.files.get(path)!, /必须保留/);
});
test('standalone attachments are linked once, failures keep URL, and existing image folder stays sticky', async () => {
  const h = await harness({ localizeImages: true, imageFolder: 'NewImages' }); h.adapter.allowBinary = true;
  const next = { ...updated, content: '<img src="https://img.example/a.png">', files: [{ url: 'https://img.example/a.png', name: 'a.png' }, { url: 'https://img.example/b.pdf', name: 'b.pdf' }, { url: 'https://failure.example/c.pdf', name: 'c.pdf' }] };
  await sync(h, [next]); const content = h.adapter.files.get(path)!;
  assert.ok(h.adapter.binaryWrites.every(target => target.startsWith('OldImages/memo-001/')));
  assert.equal((content.match(/a\.png/g) || []).length, 1); assert.equal((content.match(/b\.pdf/g) || []).length, 1); assert.match(content, /https:\/\/failure.example\/c.pdf/);
});
test('new imports use configured image directory, no localization still includes standalone links', async () => {
  const h = await harness({ imageFolder: 'CustomImages', localizeImages: true }, false); h.adapter.allowBinary = true;
  await sync(h, [{ ...memo, files: [{ url: 'https://img.example/a.png', name: 'a.png' }] }]); assert.ok(h.adapter.binaryWrites[0].startsWith('CustomImages/memo-001/'));
  const disabled = await harness({}, false); await sync(disabled, [{ ...memo, files: [{ url: 'https://img.example/a.png', name: 'a.png' }] }]); assert.match(disabled.adapter.files.get(record(disabled).filePaths[0])!, /https:\/\/img.example\/a.png/);
});
test('YAML variables safely handle quotes, colons, newlines and arrays', () => {
  const special = { ...memo, tags: [{ name: 'a: "quoted"\nnext' }] };
  for (const value of ['{{first_tag}}', '"{{first_tag}}"', "'{{first_tag}}'"]) {
    const rendered = renderYamlTemplate(`value: ${value}`, special); assert.equal((parseYaml(rendered) as { value: string }).value, special.tags[0].name);
  }
  const rendered = renderYamlTemplate('aliases: ["{{title}}", "literal"]', memo);
  assert.deepEqual((parseYaml(rendered) as { aliases: string[] }).aliases, ['原始内容', 'literal']);
});
for (const invalid of ['"tags": []', "'flomo_slug': x", 'source: a\nsource: b', 'value: [oops', 'value: "{{unknown}}"', 'name: a\n  nested: b']) test(`invalid YAML rejected: ${invalid}`, () => { assert.ok(validateYamlTemplate(invalid)); });
test('partially complete filename variable syntax is rejected', () => { assert.ok(validateFileNameTemplate('{{date}}_{{title')); assert.ok(validateFileNameTemplate('title}}')); });
test('quoted YAML keys with colons render safely, while variables in keys are rejected', () => {
  assert.deepEqual(parseYaml(renderYamlTemplate('"custom:title": "{{title}}"', memo)), { 'custom:title': '原始内容' });
  assert.ok(validateYamlTemplate('"custom:{{title}}": value'));
});

(async () => {
  const warn = console.warn; console.warn = () => {};
  try { for (const entry of cases) { try { await entry.run(); } catch (error) { throw new Error(`${entry.name}\n${(error as Error).stack}`); } } }
  finally { console.warn = warn; }
  console.log(`v0.3.0 tests passed (${cases.length} cases; mocked API and in-memory vault)`);
})().catch(error => { console.error(error); process.exitCode = 1; });
