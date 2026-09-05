/** Test-only subclass: feeds fictional snapshots to the shipped engine in an isolated Obsidian vault. */
import FlomoSafeSyncPlugin from '../main';
import { buildNewMemoFile, FlomoMemo } from '../sync-core';
import { executeTrash, syncToVault } from '../sync-engine';

const QA_VAULT = '/private/tmp/flomo-safe-sync-qa-v030/vault';
export default class NativeTestPlugin extends FlomoSafeSyncPlugin {
  private assertFixture(): void {
    if ((this.app.vault.adapter as unknown as { basePath: string }).basePath !== QA_VAULT) throw new Error('Native tests require the isolated QA vault');
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
}
