import { strict as assert } from 'assert';
import {
  FlomoMemo,
  DEFAULT_NOTE_TEMPLATE,
  BODY_END,
  BODY_START,
  FRONTMATTER_END,
  FRONTMATTER_START,
  buildNewMemoFile,
  collectFlomoTags,
  computeDesiredPaths,
  extractManagedBodyEmbedTargets,
  extractYamlTags,
  findTagFolderMapping,
  findTagFolderMappingForTags,
  hasManagedMarkers,
  hierarchicalTags,
  mergeManagedMemo,
  memoMatchesExcludedTags,
  parseTagFolderMappings,
  renderFileName,
  renderYamlTemplate,
  updateManagedStatus,
  validateFileNameTemplate,
  validateNoteTemplate,
  validateVaultRelativePath,
  validateYamlTemplate,
} from '../sync-core';

const original: FlomoMemo = {
  slug: 'abcdef123456',
  content: '<p>第一条写作想法</p><img src="https://img.example/a.jpg">',
  tags: [{ name: '写作' }, { name: '素材' }],
  created_at: '2026-09-01 08:09:10',
  updated_at: '2026-09-01 08:09:10',
};

const pathSettings = {
  fileNameTemplate: '{{date}}_{{time}}_{{title:6}}_{{slug:4}}',
  tagFolderMappings: [
    { tag: '写作', folder: '20-写作素材' },
    { tag: '素材', folder: '30-素材库' },
  ],
};

const mappedPaths = computeDesiredPaths(original, pathSettings);
assert.deepEqual(mappedPaths, ['20-写作素材/2026-09-01_08-09-10_第一条写作想_abcd.md']);

assert.equal(validateFileNameTemplate('{{YYYY-MM-DD-HHmmss}}'), null);
assert.equal(renderFileName('{{YYYY-MM-DD-HHmmss}}', original), '2026-09-01-080910');
assert.equal(renderFileName('{{year}}{{month}}{{day}}_{{hour}}{{minute}}{{second}}', original), '20260901_080910');
assert.equal(renderFileName('{{yyyy-MM-dd}}_{{HH-mm-ss}}', original), '2026-09-01_08-09-10');
assert.equal(renderFileName('{{yy-M-d_H-m-s}}', original), '26-9-1_8-9-10');
assert.equal(renderFileName('{{yyyyMMdd-HHmmss}}', original), '20260901-080910');
assert.match(validateFileNameTemplate('{{YYYYMMDD}}') || '', /不支持/);
assert.match(validateFileNameTemplate('{{yyyy/MM/dd}}') || '', /不支持/);
assert.deepEqual(hierarchicalTags(['工作/项目/甲', '生活', '工作', '#工作/项目']), [
  { tag: '工作', depth: 0 }, { tag: '工作/项目', depth: 1 }, { tag: '工作/项目/甲', depth: 2 }, { tag: '生活', depth: 0 },
]);

assert.deepEqual(collectFlomoTags([
  original,
  { ...original, slug: 'second', tags: [{ name: '#素材' }, { name: '六经' }] },
]), ['写作', '素材', '六经']);
assert.deepEqual(findTagFolderMapping(original, pathSettings.tagFolderMappings), {
  tag: '写作',
  folder: '20-写作素材',
});
assert.equal(findTagFolderMappingForTags(['未映射'], pathSettings.tagFolderMappings), null);

assert.equal(memoMatchesExcludedTags(original, ['写作']), '写作');
assert.equal(memoMatchesExcludedTags(original, ['写作/归档']), null);
assert.equal(memoMatchesExcludedTags(original, ['#素材']), '素材');

const parsedMappings = parseTagFolderMappings('写作 = 20-写作素材\n素材 → 30-素材库');
assert.equal(parsedMappings.error, undefined);
assert.deepEqual(parsedMappings.mappings, [
  { tag: '写作', folder: '20-写作素材' },
  { tag: '素材', folder: '30-素材库' },
]);
assert.match(parseTagFolderMappings('错误格式').error || '', /第 1 行/);

assert.equal(validateVaultRelativePath('../outside'), '路径不能包含 . 或 ..');
assert.equal(validateVaultRelativePath('/absolute'), '只能使用 Vault 内相对路径');
assert.equal(validateVaultRelativePath('20-写作素材'), null);

assert.equal(validateYamlTemplate('source: flomo\ncreated: "{{date}}"\naliases: []'), null);
assert.match(validateYamlTemplate('tags: [写作]') || '', /由插件维护/);
assert.match(validateYamlTemplate('flomo_status: active') || '', /由插件维护/);
assert.match(validateYamlTemplate('  - 不支持的多行值') || '', /顶层 YAML 字段/);
assert.equal(
  renderYamlTemplate('source: flomo\ncreated: "{{date}} {{hour}}:{{minute}}:{{second}}"\ntitle: "{{title:4}}"', original),
  'source: flomo\ncreated: "2026-09-01 08:09:10"\ntitle: "第一条写"',
);

const unmappedPaths = computeDesiredPaths(
  { ...original, tags: [{ name: '未映射' }, { name: '第二标签' }] },
  pathSettings,
);
assert.deepEqual(unmappedPaths, []);

const created = buildNewMemoFile(original, {
  syncedAt: '2026-09-01T08:10:00.000Z',
  imageMap: { 'https://img.example/a.jpg': '00-Flomo收件箱/_attachments/a.jpg' },
  yamlTemplate: 'source: flomo\nnote_type: memo\ncreated: "{{date}}"',
});
assert.equal(hasManagedMarkers(created), true);
assert.match(created, /!\[\[00-Flomo收件箱\/_attachments\/a\.jpg\]\]/);
assert.deepEqual(extractManagedBodyEmbedTargets(created, original.slug), ['00-Flomo收件箱/_attachments/a.jpg']);
const hosted = buildNewMemoFile(original, {
  syncedAt: '2026-09-01T08:10:00.000Z', imageMap: { 'https://img.example/a.jpg': 'https://cdn.example/a.jpg' },
});
assert.match(hosted, /!\[\]\(<https:\/\/cdn\.example\/a\.jpg>\)/);
assert.deepEqual(extractManagedBodyEmbedTargets(hosted, original.slug), ['https://cdn.example/a.jpg']);
assert.deepEqual(extractYamlTags(created), ['写作', '素材']);
assert.doesNotMatch(created, /flomo_tags:/);
assert.doesNotMatch(created, /#写作 #素材/);
assert.match(created, /source: flomo/);
assert.match(created, /created: "2026-09-01"/);

assert.equal(validateNoteTemplate(DEFAULT_NOTE_TEMPLATE), null);
const completeTemplate = `---
${FRONTMATTER_START}
flomo_slug: "{{slug}}"
flomo_status: active
flomo_sync_policy: managed
flomo_created_at: "{{created_at}}"
flomo_updated_at: "{{updated_at}}"
flomo_last_synced_at: "{{synced_at}}"
${FRONTMATTER_END}
{{flomo_tags}}
source: flomo
created: "{{yyyy-MM-dd}}"
---

# {{title:4}}

${BODY_START}
{{flomo_content}}
${BODY_END}

> 自定义固定说明
`;
assert.equal(validateNoteTemplate(completeTemplate), null);
const completeNote = buildNewMemoFile(original, { syncedAt: '2026-09-01T08:10:00.000Z', noteTemplate: completeTemplate });
assert.match(completeNote, /^---\n# flomo-sync:frontmatter:start/m);
assert.match(completeNote, /created: "2026-09-01"/);
assert.match(completeNote, /# 第一条写/);
assert.match(completeNote, /> 自定义固定说明/);
assert.equal(hasManagedMarkers(completeNote, original.slug), true);
assert.match(validateNoteTemplate(completeTemplate.replace('{{flomo_content}}', '')) || '', /必须且只能保留一个/);
assert.match(validateNoteTemplate(completeTemplate.replace('{{flomo_tags}}', '{{flomo_tags}}\n{{flomo_tags}}')) || '', /必须且只能保留一个/);
assert.match(validateNoteTemplate(completeTemplate.replace('{{flomo_tags}}', '{{flomo_tags}}\nflomo_status: active')) || '', /由插件维护/);

const withManualContent = created
  .replace('## 我的补充\n\n', '## 我的补充\n\n这是我的手工内容。\n')
  .replace('# flomo-sync:frontmatter:end', '# flomo-sync:frontmatter:end\nmy_field: "保留"')
  .replace('  - "素材"', '  - "素材"\n  - "重点"');

const updatedMemo: FlomoMemo = {
  ...original,
  content: '<p>Flomo 中更新后的内容</p>',
  tags: [{ name: '写作' }, { name: '六经' }],
  updated_at: '2026-09-01 09:00:00',
};
const merged = mergeManagedMemo(withManualContent, updatedMemo, {
  syncedAt: '2026-09-01T09:01:00.000Z',
  previousFlomoTags: ['写作', '素材'],
});
assert.equal(merged.ok, true);
assert.match(merged.content, /Flomo 中更新后的内容/);
assert.match(merged.content, /这是我的手工内容。/);
assert.match(merged.content, /my_field: "保留"/);
assert.match(merged.content, /source: flomo/);
assert.deepEqual(extractYamlTags(merged.content), ['写作', '六经', '重点']);
assert.doesNotMatch(merged.content, /flomo_tags:/);

const legacy = `---
# flomo-sync:frontmatter:start
flomo_slug: "abcdef123456"
flomo_status: active
flomo_sync_policy: managed
flomo_created_at: "2026-09-01 08:09:10"
flomo_updated_at: "2026-09-01 08:09:10"
flomo_last_synced_at: "2026-09-01T08:10:00.000Z"
flomo_tags:
  - "写作"
  - "素材"
# flomo-sync:frontmatter:end
tags:
  - "写作"
  - "素材"
  - "重点"
my_field: "保留"
---

<!-- flomo-sync:content:start -->
旧内容

#写作 #素材
<!-- flomo-sync:content:end -->

## 我的补充

手工补充
`;
const migrated = mergeManagedMemo(legacy, updatedMemo, {
  syncedAt: '2026-09-01T09:01:00.000Z',
});
assert.equal(migrated.ok, true);
assert.deepEqual(extractYamlTags(migrated.content), ['写作', '六经', '重点']);
assert.doesNotMatch(migrated.content, /flomo_tags:/);
assert.doesNotMatch(migrated.content, /#写作 #素材/);
assert.match(migrated.content, /手工补充/);
assert.match(migrated.content, /my_field: "保留"/);

const deleted = updateManagedStatus(
  merged.content,
  'deleted',
  'managed',
  '2026-09-01T10:00:00.000Z',
  '2026-09-01T10:00:00.000Z',
);
assert.equal(deleted.ok, true);
assert.match(deleted.content, /flomo_status: deleted/);
assert.match(deleted.content, /flomo_deleted_detected_at:/);
assert.match(deleted.content, /这是我的手工内容。/);
assert.match(deleted.content, /Flomo 中更新后的内容/);

const restored = updateManagedStatus(
  deleted.content,
  'active',
  'managed',
  '2026-09-01T11:00:00.000Z',
);
assert.equal(restored.ok, true);
assert.doesNotMatch(restored.content, /flomo_deleted_detected_at:/);
assert.match(restored.content, /这是我的手工内容。/);

const conflict = mergeManagedMemo('普通手工笔记', updatedMemo, {
  syncedAt: '2026-09-01T09:01:00.000Z',
});
assert.equal(conflict.ok, false);
assert.equal(conflict.content, '普通手工笔记');

console.log('sync-core tests passed');
