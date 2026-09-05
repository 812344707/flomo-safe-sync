import { strict as assert } from 'assert';
import FlomoSafeSyncPlugin from '../main';
import {
  BODY_END,
  BODY_START,
  FRONTMATTER_END,
  FRONTMATTER_START,
  FlomoMemo,
  buildNewMemoFile,
  extractYamlTags,
} from '../sync-core';
import {
  App,
  MemoryAdapter,
  clearMockObservations,
  getMockState,
  resetObsidianMock,
  setMockMemos,
} from './obsidian-mock';

// The build must alias "obsidian" to ./tests/obsidian-mock.ts. Every fixture is
// in memory, and this deliberately fake token must never reach a real service.
const TEST_TOKEN = 'safety-test-fake-token-not-a-real-account';
const NOTE_PATH = 'Inbox/example.md';
const SYNCED_AT = '2026-09-01T08:10:00.000Z';
const DELETED_AT = '2026-09-02T08:10:00.000Z';
const original: FlomoMemo = {
  slug: 'memo-safe-001',
  content: '<p>原始 Flomo 内容</p>',
  tags: [{ name: '写作' }],
  created_at: '2026-09-01 08:09:10',
  updated_at: '2026-09-01 08:09:10',
};
const updated: FlomoMemo = {
  ...original,
  content: '<p>更新后的 Flomo 内容</p>',
  tags: [{ name: '新标签' }],
  updated_at: '2026-09-03 09:00:00',
};

type RecordStatus = 'active' | 'deleted';
type Harness = Awaited<ReturnType<typeof createHarness>>;

function note(memo: FlomoMemo = original, status: RecordStatus = 'active'): string {
  return buildNewMemoFile(memo, {
    syncedAt: SYNCED_AT,
    status,
    deletedDetectedAt: status === 'deleted' ? DELETED_AT : undefined,
  })
    .replace(FRONTMATTER_END, `${FRONTMATTER_END}\nmy_field: "手工字段"`)
    .replace('  - "写作"', '  - "写作"\n  - "手工标签"')
    .replace('## 我的补充\n\n', '## 我的补充\n\n不能覆盖的手工内容。\n');
}

async function createHarness(content: string, status: RecordStatus = 'active') {
  resetObsidianMock();
  const adapter = new MemoryAdapter({ [NOTE_PATH]: content });
  const app = new App(adapter);
  const plugin = new FlomoSafeSyncPlugin(
    app as unknown as ConstructorParameters<typeof FlomoSafeSyncPlugin>[0],
    {
      id: 'flomo-safe-sync-tests',
      name: 'Flomo Safe Sync Tests',
      version: '0.0.0',
      minAppVersion: '1.0.0',
      author: 'Test',
      description: 'In-memory integration tests',
    },
  );
  await plugin.loadSettings();
  Object.assign(plugin.settings, {
    bearerToken: TEST_TOKEN,
    rootFolder: 'Inbox',
    localizeImages: false,
    autoSyncOnStartup: false,
    autoSyncIntervalMinutes: 0,
    excludedTags: [],
    scopeMode: 'exclude',
    scopeTags: [],
    syncedMemos: {
      [original.slug]: {
        updated_at: original.updated_at,
        fileName: 'example',
        filePaths: [NOTE_PATH],
        status,
        excluded: false,
        lastKnownTags: ['写作'],
        lastAppliedFlomoTags: ['写作'],
        tagsMerged: true,
        ...(status === 'deleted' ? { deletedDetectedAt: DELETED_AT } : {}),
      },
    },
  });
  return { plugin, adapter };
}

async function sync(harness: Harness, apiMemos: FlomoMemo[]) {
  clearMockObservations();
  harness.adapter.writes.length = 0;
  setMockMemos(apiMemos);
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
  try {
    await harness.plugin.runSync();
  } finally {
    console.warn = originalWarn;
  }
  const state = getMockState();
  assert.equal(harness.plugin.syncRunning, false, 'the sync lock must always release');
  assert.equal(state.requests.length, 1, 'all remote memo data must come from the mock');
  assert.equal(state.requests[0].headers?.Authorization, `Bearer ${TEST_TOKEN}`);
  assert.equal(harness.adapter.binaryWrites.length, 0, 'no attachment writes are expected');
  assert.ok(state.savedData.length >= 1, 'sync settings must be persisted');
  assert.ok(state.notices.some(message => message.startsWith('Flomo 安全同步完成：')));
  assert.ok(state.notices.every(message => !message.includes('同步失败')));
  return { ...state, warnings };
}

function record(harness: Harness) {
  return harness.plugin.settings.syncedMemos[original.slug];
}

function savedRecord(result: Awaited<ReturnType<typeof sync>>) {
  const saved = result.savedData[result.savedData.length - 1] as { syncedMemos: typeof FlomoSafeSyncPlugin.prototype.settings.syncedMemos };
  return saved.syncedMemos[original.slug];
}

function assertManualContent(content: string): void {
  assert.match(content, /不能覆盖的手工内容。/);
  assert.match(content, /my_field: "手工字段"/);
  assert.ok(extractYamlTags(content).includes('手工标签'));
}

function assertConflict(
  harness: Harness,
  result: Awaited<ReturnType<typeof sync>>,
  originalContent: string,
  expectedStatus: RecordStatus = 'active',
): void {
  assert.equal(harness.adapter.writes.length, 0, 'a conflicting file must not be written');
  assert.equal(harness.adapter.files.get(NOTE_PATH), originalContent, 'the complete note must be unchanged');
  assert.equal(record(harness).updated_at, original.updated_at, 'a conflict must remain retryable');
  assert.equal(record(harness).status, expectedStatus);
  assert.equal(savedRecord(result).updated_at, original.updated_at, 'saved timestamp must not advance');
  assert.equal(savedRecord(result).status, expectedStatus, 'saved status must not advance');
  assert.ok(result.notices.some(message => message.includes('冲突 1')), 'the user must see the conflict');
  assert.ok(result.notices.every(message => !message.includes('更新 1')));
  assert.ok(result.warnings.some(message => message.includes(NOTE_PATH)), 'the conflict must identify its file');
}

const cases: Array<{ name: string; run: () => Promise<void> }> = [];

function test(name: string, run: () => Promise<void>): void {
  cases.push({ name, run });
}

test('valid update preserves manual content and advances the persisted record', async () => {
  const harness = await createHarness(note());
  const result = await sync(harness, [updated]);
  assert.equal(harness.adapter.writes.length, 1);
  const content = await harness.adapter.read(NOTE_PATH);
  assertManualContent(content);
  assert.match(content, /更新后的 Flomo 内容/);
  assert.doesNotMatch(content, /原始 Flomo 内容/);
  assert.deepEqual(extractYamlTags(content), ['新标签', '手工标签']);
  assert.equal(record(harness).updated_at, updated.updated_at);
  assert.equal(savedRecord(result).updated_at, updated.updated_at);
  assert.ok(result.notices.some(message => message.includes('更新 1')));
});

test('wrong memo ownership rejects update and succeeds on the next sync after repair', async () => {
  const wrong = note({ ...original, slug: 'unrelated-memo-002' });
  const harness = await createHarness(wrong);
  assertConflict(harness, await sync(harness, [updated]), wrong);

  // Simulate the user repairing the conflicting file; no adapter write is hidden.
  harness.adapter.files.set(NOTE_PATH, note());
  const result = await sync(harness, [updated]);
  assert.equal(harness.adapter.writes.length, 1);
  assertManualContent(await harness.adapter.read(NOTE_PATH));
  assert.equal(savedRecord(result).updated_at, updated.updated_at);
  assert.ok(result.notices.some(message => message.includes('更新 1')));
});

for (const [label, marker] of [
  ['frontmatter start', FRONTMATTER_START],
  ['frontmatter end', FRONTMATTER_END],
  ['body start', BODY_START],
  ['body end', BODY_END],
]) {
  test(`missing ${label} marker rejects all note writes`, async () => {
    const broken = note().replace(marker, '');
    const harness = await createHarness(broken);
    assertConflict(harness, await sync(harness, [updated]), broken);
  });

  test(`duplicate ${label} marker rejects all note writes`, async () => {
    const broken = note().replace(marker, `${marker}\n${marker}`);
    const harness = await createHarness(broken);
    assertConflict(harness, await sync(harness, [updated]), broken);
  });
}

test('an inline marker is not accepted as a managed boundary', async () => {
  const broken = note().replace(BODY_START, `handwritten prefix ${BODY_START}`);
  const harness = await createHarness(broken);
  assertConflict(harness, await sync(harness, [updated]), broken);
});

test('frontmatter after handwritten body text is not accepted as top-level metadata', async () => {
  const broken = `手工正文在先。\n\n${note()}`;
  const harness = await createHarness(broken);
  assertConflict(harness, await sync(harness, [updated]), broken);
});

test('missing memo identity rejects updates without advancing the record', async () => {
  const broken = note().replace(`flomo_slug: "${original.slug}"\n`, '');
  const harness = await createHarness(broken);
  assertConflict(harness, await sync(harness, [updated]), broken);
});

test('duplicate memo identity rejects updates without advancing the record', async () => {
  const identity = `flomo_slug: "${original.slug}"`;
  const broken = note().replace(identity, `${identity}\n${identity}`);
  const harness = await createHarness(broken);
  assertConflict(harness, await sync(harness, [updated]), broken);
});

test('an empty remote list cannot mark another memo deleted', async () => {
  const wrong = note({ ...original, slug: 'unrelated-memo-002' });
  const harness = await createHarness(wrong);
  const result = await sync(harness, []);
  assertConflict(harness, result, wrong);
  assert.equal(record(harness).deletedDetectedAt, undefined);
  assert.ok(result.notices.every(message => !message.includes('标记删除 1')));

  harness.adapter.files.set(NOTE_PATH, note());
  const retried = await sync(harness, []);
  assert.equal(harness.adapter.writes.length, 1);
  assert.equal(savedRecord(retried).status, 'deleted');
  assertManualContent(await harness.adapter.read(NOTE_PATH));
  assert.ok(retried.notices.some(message => message.includes('标记删除 1')));
});

test('an empty remote list may mark the correctly owned note deleted', async () => {
  const harness = await createHarness(note());
  const result = await sync(harness, []);
  assert.equal(harness.adapter.writes.length, 1);
  const content = await harness.adapter.read(NOTE_PATH);
  assertManualContent(content);
  assert.match(content, /原始 Flomo 内容/);
  assert.match(content, /flomo_status: deleted/);
  assert.match(content, /flomo_deleted_detected_at:/);
  assert.equal(record(harness).status, 'deleted');
  assert.equal(savedRecord(result).status, 'deleted');
  assert.equal(savedRecord(result).updated_at, original.updated_at);
  assert.ok(result.notices.some(message => message.includes('标记删除 1')));
});

for (const policy of ['freeze', 'skip'] as const) {
  test(`${policy} restoration validates ownership and retries without updating frozen content`, async () => {
    const wrong = note({ ...original, slug: 'unrelated-memo-002' }, 'deleted');
    const harness = await createHarness(wrong, 'deleted');
    harness.plugin.settings.excludedTags = ['新标签'];
    harness.plugin.settings.excludedPolicy = policy;
    const failed = await sync(harness, [updated]);
    assertConflict(harness, failed, wrong, 'deleted');
    assert.equal(savedRecord(failed).deletedDetectedAt, DELETED_AT);

    harness.adapter.files.set(NOTE_PATH, note(original, 'deleted'));
    const result = await sync(harness, [updated]);
    assert.equal(harness.adapter.writes.length, 1);
    const content = await harness.adapter.read(NOTE_PATH);
    assertManualContent(content);
    assert.match(content, /原始 Flomo 内容/);
    assert.doesNotMatch(content, /更新后的 Flomo 内容/);
    assert.match(content, /flomo_status: active/);
    assert.match(content, /flomo_sync_policy: excluded/);
    assert.doesNotMatch(content, /flomo_deleted_detected_at:/);
    assert.equal(savedRecord(result).status, 'active');
    assert.equal(savedRecord(result).updated_at, original.updated_at);
    assert.ok(result.notices.every(message => !message.includes('冲突')));
  });
}

async function main(): Promise<void> {
  for (const entry of cases) {
    try {
      await entry.run();
    } catch (error) {
      throw new Error(`Plugin safety case failed: ${entry.name}\n${String(error)}`);
    }
  }
  console.log(`plugin safety tests passed (${cases.length} cases; in-memory vault and mocked requests only)`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
