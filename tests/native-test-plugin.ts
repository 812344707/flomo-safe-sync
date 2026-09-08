/** Test-only subclass: feeds fictional snapshots to the shipped engine in an isolated Obsidian vault. */
import { TFile } from 'obsidian';
import FlomoSafeSyncPlugin from '../main';
import { buildNewMemoFile, FlomoMemo } from '../sync-core';
import { executeTrash, reimportMissingMemos, scanMissingLocalMemos, syncToVault } from '../sync-engine';
import { ensureParentDir } from '../sync-engine';
import { migrateSettings } from '../settings';

const QA_VAULT = '/private/tmp/flomo-safe-sync-qa-v030/vault';
export default class NativeTestPlugin extends FlomoSafeSyncPlugin {
  private assertFixture(): void {
    if ((this.app.vault.adapter as unknown as { basePath: string }).basePath !== QA_VAULT) throw new Error('Native tests require the isolated QA vault');
  }
  async qaFolderFixture() {
    this.assertFixture();
    const prefix = `FolderQA-${Date.now()}`;
    const slug = `folder-${Date.now()}`;
    const note = `${prefix}/Old/手写笔记.md`;
    const asset = `${prefix}/Old/_attachments/flomo/${slug}/123456789abc-picture.png`;
    const source = 'https://img.example/folder-fixture.png';
    const memo: FlomoMemo = { slug, content: `<p>目录迁移样例</p><img src="${source}">`, tags: [{ name: '写作' }], created_at: '2026-09-01 08:00:00', updated_at: '2026-09-01 08:00:00' };
    await ensureParentDir(this.app, asset);
    await this.app.vault.createBinary(asset, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=', 'base64'));
    const original = buildNewMemoFile(memo, { syncedAt: '2026-09-01T00:00:00Z', imageMap: { [source]: asset } })
      + `\n## 手写保留\n不能丢失的手写内容。\n![相对图片](_attachments/flomo/${slug}/123456789abc-picture.png)\n`;
    await this.app.vault.create(note, original);
    return { prefix, slug, note, asset, source, original, memo, settings: migrateSettings({
      rootFolder: `${prefix}/Old`, imageFolder: `${prefix}/Old/_attachments/flomo`, bearerToken: '', autoSyncOnStartup: false, autoSyncIntervalMinutes: 0,
      scopeMode: 'exclude', scopeTags: [], availableFlomoTags: ['写作'], localizeImages: true,
      syncedMemos: { [slug]: { fileName: '手写笔记', filePaths: [note], fileStates: [{ path: note, state: 'live' }], updated_at: memo.updated_at, bodyUpdatedAt: memo.updated_at,
        propertiesUpdatedAt: memo.updated_at, status: 'active', lastKnownTags: ['写作'], lastAppliedFlomoTags: ['写作'], tagsMerged: true,
        assetFolder: `${prefix}/Old/_attachments/flomo/${slug}`, assetMap: { [source]: asset } } },
    }) };
  }
  async qaPrepare(): Promise<FlomoMemo> {
    this.assertFixture();
    const memo: FlomoMemo = { slug: 'native-memo-001', content: '<p>Native original</p>', tags: [{ name: '写作' }], created_at: '2026-09-01 08:00:00', updated_at: '2026-09-01 08:00:00' };
    const path = `native-${Date.now()}.md`;
    await this.app.vault.create(path, buildNewMemoFile(memo, { syncedAt: new Date().toISOString() }) + 'Native handwritten text\n');
    Object.assign(this.settings, { bearerToken: '', autoSyncOnStartup: false, autoSyncIntervalMinutes: 0, scopeMode: 'exclude', scopeTags: [], localizeImages: false,
      archiveFolder: 'NativeArchive', syncedMemos: { [memo.slug]: { fileName: 'native', filePaths: [path], updated_at: memo.updated_at, bodyUpdatedAt: memo.updated_at,
        propertiesUpdatedAt: memo.updated_at, status: 'active', lastKnownTags: ['写作'], lastAppliedFlomoTags: ['写作'], tagsMerged: true } } });
    await this.saveSettings(); return memo;
  }
  async qaSync(memos: FlomoMemo[]) {
    this.assertFixture();
    const result = await syncToVault(this.app, this.settings, memos, '', () => this.saveSettings(), this.internalMoves);
    await this.saveSettings(); return result;
  }
  async qaTrash(paths: string[]) {
    this.assertFixture();
    return executeTrash(this.app, this.settings, paths, [], () => this.saveSettings(), this.internalMoves);
  }
  async qaImageHost(): Promise<{ path: string; hosted: string; localStillExists: boolean; assetErrors: number }> {
    this.assertFixture();
    const source = 'https://img.example/native-source.png';
    const hosted = 'https://cdn.example/native-uploaded.png';
    const local = 'native-upload-source.png';
    const path = `native-hosted-${Date.now()}.md`;
    const memo: FlomoMemo = { slug: 'native-image-001', content: `<p>Native image</p><img src="${source}">`, tags: [{ name: '图片' }], created_at: '2026-09-01 08:00:00', updated_at: '2026-09-01 08:00:00' };
    await this.app.vault.adapter.writeBinary(local, new ArrayBuffer(1));
    await this.app.vault.create(path, buildNewMemoFile(memo, { syncedAt: new Date().toISOString(), imageMap: { [source]: local } }));
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!file || !('path' in file)) throw new Error('Native hosted-image note was not created');
    await this.app.vault.process(file as TFile, current => current.replace(`![[${local}]]`, `![](${hosted})`));
    await this.app.vault.adapter.remove(local);
    Object.assign(this.settings, { scopeMode: 'exclude', scopeTags: [], localizeImages: true, updateMode: 'both', imageFolder: 'NativeAssets', syncedMemos: {
      [memo.slug]: { fileName: 'native-hosted', filePaths: [path], updated_at: memo.updated_at, bodyUpdatedAt: memo.updated_at,
        propertiesUpdatedAt: memo.updated_at, status: 'active', lastKnownTags: ['图片'], lastAppliedFlomoTags: ['图片'], tagsMerged: true,
        assetFolder: 'NativeAssets/native-image-001', assetMap: { [source]: local } },
    } });
    const next = { ...memo, content: `<p>Native image updated</p><img src="${source}">`, updated_at: '2026-09-02 09:00:00' };
    const result = await syncToVault(this.app, this.settings, [next], '', () => this.saveSettings(), this.internalMoves);
    const content = await this.app.vault.adapter.read(path);
    if (!content.includes(hosted) || this.settings.syncedMemos[memo.slug].assetMap?.[source] !== hosted) throw new Error('Hosted image mapping was not retained');
    return { path, hosted, localStillExists: await this.app.vault.adapter.exists(local), assetErrors: result.assetErrorCount };
  }
  async qaMissingReimport(): Promise<{ oldPath: string; newPath: string; detected: number; reimported: number }> {
    this.assertFixture();
    const suffix = Date.now();
    const memo: FlomoMemo = { slug: `native-missing-${suffix}`, content: '<p>Recovered from Flomo</p>', tags: [{ name: '恢复' }], created_at: '2026-09-01 08:00:00', updated_at: '2026-09-01 08:00:00' };
    const oldPath = `native-wrong-${suffix}.md`;
    const oldFile = await this.app.vault.create(oldPath, buildNewMemoFile(memo, { syncedAt: new Date().toISOString() }));
    await this.app.vault.delete(oldFile);
    Object.assign(this.settings, { rootFolder: 'NativeRecovered', scopeMode: 'exclude', scopeTags: [], localizeImages: false, syncedMemos: {
      [memo.slug]: { fileName: 'native-missing', filePaths: [oldPath], updated_at: memo.updated_at, bodyUpdatedAt: memo.updated_at,
        propertiesUpdatedAt: memo.updated_at, status: 'active', lastKnownTags: ['恢复'], lastAppliedFlomoTags: ['恢复'], tagsMerged: true },
    } });
    const detected = (await scanMissingLocalMemos(this.app, this.settings)).length;
    const result = await reimportMissingMemos(this.app, this.settings, [memo], '', [memo.slug], () => this.saveSettings());
    const newPath = this.settings.syncedMemos[memo.slug].filePaths[0];
    const content = await this.app.vault.adapter.read(newPath);
    if (!content.includes('Recovered from Flomo')) throw new Error('Native missing note content was not recreated');
    return { oldPath, newPath, detected, reimported: result.reimportedCount };
  }
  async qaRewrittenIdentity(): Promise<{ commentsRemoved: boolean; blocked: boolean; reimported: number }> {
    this.assertFixture();
    const suffix = Date.now();
    const memo: FlomoMemo = { slug: `native-identity-${suffix}`, content: '<p>Existing memo</p>', tags: [{ name: '恢复' }], created_at: '2026-09-01 08:00:00', updated_at: '2026-09-01 08:00:00' };
    const currentPath = `native-existing-${suffix}.md`;
    const file = await this.app.vault.create(currentPath, buildNewMemoFile(memo, { syncedAt: new Date().toISOString() }));
    await this.app.fileManager.processFrontMatter(file, frontmatter => { frontmatter.review_id = 'fixture-review'; });
    const original = await this.app.vault.read(file);
    Object.assign(this.settings, { rootFolder: 'NativeRecovered', scopeMode: 'exclude', scopeTags: [], localizeImages: false, syncedMemos: {
      [memo.slug]: { fileName: 'native-existing', filePaths: [`missing-${suffix}.md`], updated_at: memo.updated_at, status: 'active', lastKnownTags: ['恢复'] },
    } });
    const detected = await scanMissingLocalMemos(this.app, this.settings);
    const result = await reimportMissingMemos(this.app, this.settings, [memo], '', [memo.slug], () => this.saveSettings());
    if (await this.app.vault.read(file) !== original) throw new Error('Identity check changed an existing note');
    return { commentsRemoved: !original.includes('# flomo-sync:frontmatter:start'), blocked: Boolean(detected[0]?.blockedReason), reimported: result.reimportedCount };
  }
}
