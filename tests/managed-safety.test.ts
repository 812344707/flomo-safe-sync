import { strict as assert } from 'assert';
import {
  BODY_END,
  BODY_START,
  FRONTMATTER_END,
  FRONTMATTER_START,
  FlomoMemo,
  buildNewMemoFile,
  extractYamlTags,
  hasManagedMarkers,
  mergeManagedMemo,
  updateManagedStatus,
} from '../sync-core';

const original: FlomoMemo = {
  slug: 'safe-memo-123456',
  content: '<p>原始 Flomo 内容</p>',
  tags: [{ name: '原标签' }],
  created_at: '2026-09-01 08:09:10',
  updated_at: '2026-09-01 08:09:10',
};
const updated: FlomoMemo = {
  ...original,
  content: '<p>更新后的 Flomo 内容</p>',
  tags: [{ name: '新标签' }],
  updated_at: '2026-09-02 09:10:11',
};
const syncedAt = '2026-09-02T09:11:00.000Z';
const options = { syncedAt, previousFlomoTags: ['原标签'] };
const originalSlugLine = `flomo_slug: "${original.slug}"`;
const markers = [FRONTMATTER_START, FRONTMATTER_END, BODY_START, BODY_END];
const manualYaml = 'manual_notes: |+\n  手工 YAML 第一段\n\n\n  手工 YAML 第二段';
const fixture = buildNewMemoFile(original, {
  syncedAt: '2026-09-01T08:10:00.000Z',
  yamlTemplate: 'manual_key: "这个手工字段必须保留"\nreviewed: false',
})
  .replace('reviewed: false', `reviewed: false\n${manualYaml}`)
  .replace('tags:\n  - "原标签"', 'tags:\n  - "原标签"\n  - "本地标签"')
  .replace('## 我的补充\n\n', '## 我的补充\n\n手工补充必须保留。\n\n[[本地双链]]\n');

let rejectedCaseCount = 0;
let compatibleCaseCount = 0;

function assertRejected(name: string, content: string): void {
  assert.equal(hasManagedMarkers(content, original.slug), false, `${name}: 应拒绝受管身份或布局`);

  const merged = mergeManagedMemo(content, updated, options);
  assert.equal(merged.ok, false, `${name}: 不应合并`);
  assert.equal(merged.content, content, `${name}: 合并失败必须逐字返回输入`);

  const status = updateManagedStatus(content, 'deleted', 'managed', syncedAt, syncedAt, original.slug);
  assert.equal(status.ok, false, `${name}: 不应更新删除状态`);
  assert.equal(status.content, content, `${name}: 状态更新失败必须逐字返回输入`);
  rejectedCaseCount++;
}

function swapMarkers(content: string, first: string, second: string): string {
  return content.replace(first, '__temporary_marker__').replace(second, first).replace('__temporary_marker__', second);
}

assertRejected('文件属于另一篇 memo', fixture.replace(originalSlugLine, 'flomo_slug: "another-memo"'));
assertRejected('缺少 flomo_slug', fixture.replace(`${originalSlugLine}\n`, ''));
assertRejected('受管区内重复 flomo_slug', fixture.replace(originalSlugLine, `${originalSlugLine}\n${originalSlugLine}`));
assertRejected('YAML 的非受管区重复 flomo_slug', fixture.replace(FRONTMATTER_END, `${FRONTMATTER_END}\n${originalSlugLine}`));
for (const key of ['"flomo_slug"', "'flomo_slug'"]) {
  assertRejected('引号形式的重复 flomo_slug', fixture.replace(FRONTMATTER_END, `${FRONTMATTER_END}\n${key}: "another-memo"`));
}
assertRejected('空 flomo_slug', fixture.replace(originalSlugLine, 'flomo_slug: ""'));
assertRejected('无法解析的 flomo_slug', fixture.replace(originalSlugLine, 'flomo_slug: "unterminated'));
assertRejected(
  'flomo_slug 仅出现在非受管 YAML 内',
  fixture.replace(`${originalSlugLine}\n`, '').replace(FRONTMATTER_END, `${FRONTMATTER_END}\n${originalSlugLine}`),
);
assertRejected('YAML 关闭分隔线后有其他文本', fixture.replace('\n---\n\n', '\n---suffix\n\n'));

for (const marker of markers) {
  assertRejected(`缺少标记 ${marker}`, fixture.replace(marker, ''));
  assertRejected(`重复标记 ${marker}`, `${fixture}\n${marker}\n`);
  assertRejected(`标记前有同行文本 ${marker}`, fixture.replace(marker, `手工示例 ${marker}`));
  assertRejected(`标记后有同行文本 ${marker}`, fixture.replace(marker, `${marker} 手工示例`));
}

assertRejected('YAML 标记顺序颠倒', swapMarkers(fixture, FRONTMATTER_START, FRONTMATTER_END));
assertRejected('正文标记顺序颠倒', swapMarkers(fixture, BODY_START, BODY_END));
assertRejected('frontmatter 前存在普通正文', `说明文字\n${fixture}`);
assertRejected('受管 frontmatter 不是文件顶部的 frontmatter', `---\nmanual_key: true\n---\n\n${fixture}`);

const frontmatterStart = fixture.indexOf(FRONTMATTER_START);
const frontmatterEnd = fixture.indexOf(FRONTMATTER_END) + FRONTMATTER_END.length;
const frontmatterBlock = fixture.slice(frontmatterStart, frontmatterEnd);
assertRejected(
  'YAML 受管标记整体移到正文',
  fixture.replace(frontmatterBlock, '').replace(BODY_START, `${frontmatterBlock}\n\n${BODY_START}`),
);
assertRejected(
  'YAML 受管结束标记移到 frontmatter 外',
  fixture.replace(FRONTMATTER_END, '').replace('\n---\n\n', `\n---\n\n${FRONTMATTER_END}\n\n`),
);

const bodyStart = fixture.indexOf(BODY_START);
const bodyEnd = fixture.indexOf(BODY_END) + BODY_END.length;
const bodyBlock = fixture.slice(bodyStart, bodyEnd);
assertRejected(
  '正文受管标记出现在 YAML 内',
  fixture.replace(bodyBlock, '').replace('\n---\n\n', `\n${bodyBlock}\n---\n\n`),
);
assertRejected(
  '正文受管开始标记出现在 YAML 内',
  fixture.replace(BODY_START, '').replace('\n---\n\n', `\n${BODY_START}\n---\n\n`),
);

function assertCompatible(name: string, content: string): void {
  const manualTail = content.slice(content.indexOf('## 我的补充'));
  const manualYamlWithNewlines = manualYaml.replace(/\n/g, content.includes('\r\n') ? '\r\n' : '\n');
  assert.equal(hasManagedMarkers(content), true, `${name}: 无 expectedSlug 时仍兼容`);
  assert.equal(hasManagedMarkers(content, original.slug), true, `${name}: 应识别有效受管文件`);
  assert.equal(hasManagedMarkers(content, 'different-slug'), false, `${name}: expectedSlug 不符应拒绝`);

  const merged = mergeManagedMemo(content, updated, options);
  assert.equal(merged.ok, true, `${name}: 应正常更新`);
  assert.equal(hasManagedMarkers(merged.content, original.slug), true, `${name}: 合并后结构仍有效`);
  assert.match(merged.content, /更新后的 Flomo 内容/, `${name}: 应写入新正文`);
  assert.match(merged.content, /manual_key: "这个手工字段必须保留"/, `${name}: 应保留手工 YAML 字段`);
  assert.match(merged.content, /reviewed: false/, `${name}: 应保留其他手工 YAML 字段`);
  assert.ok(merged.content.includes(manualYamlWithNewlines), `${name}: 手工 YAML 的连续空行必须逐字保留`);
  assert.equal(merged.content.startsWith('\uFEFF'), content.startsWith('\uFEFF'), `${name}: 必须保留 BOM 状态`);
  assert.equal(merged.content.endsWith(manualTail), true, `${name}: 手工正文及其换行必须逐字保留`);
  assert.deepEqual(extractYamlTags(merged.content), ['新标签', '本地标签'], `${name}: 应保留手工标签`);

  const deleted = updateManagedStatus(content, 'deleted', 'managed', syncedAt, syncedAt, original.slug);
  assert.equal(deleted.ok, true, `${name}: 应正常更新状态`);
  assert.match(deleted.content, /flomo_status: deleted/, `${name}: 应标记删除`);
  assert.match(deleted.content, /原始 Flomo 内容/, `${name}: 状态更新不能改写 Flomo 正文`);
  assert.ok(deleted.content.includes(manualYamlWithNewlines), `${name}: 状态更新必须保留手工 YAML 原文`);
  assert.equal(deleted.content.endsWith(manualTail), true, `${name}: 状态更新必须保留手工正文`);
  assert.equal(hasManagedMarkers(deleted.content, original.slug), true, `${name}: 状态更新后结构仍有效`);

  const restored = updateManagedStatus(deleted.content, 'active', 'managed', syncedAt, undefined, original.slug);
  assert.equal(restored.ok, true, `${name}: 应恢复 active 状态`);
  assert.doesNotMatch(restored.content, /flomo_deleted_detected_at:/, `${name}: 应移除删除时间`);
  assert.equal(restored.content.endsWith(manualTail), true, `${name}: 恢复状态必须保留手工正文`);
  compatibleCaseCount++;
}

for (const slugValue of [original.slug, `'${original.slug}'`, `"${original.slug}"`]) {
  for (const lineEnding of ['\n', '\r\n']) {
    for (const bom of ['', '\uFEFF']) {
      const name = `${JSON.stringify(slugValue)} / ${lineEnding === '\n' ? 'LF' : 'CRLF'} / ${bom ? 'BOM' : '无 BOM'}`;
      const content = bom + fixture.replace(originalSlugLine, `flomo_slug: ${slugValue}`).replace(/\n/g, lineEnding);
      assertCompatible(name, content);
    }
  }
}

const legacy = fixture.replace(FRONTMATTER_END, `flomo_tags:\n  - "原标签"\n${FRONTMATTER_END}`);
assertCompatible('旧版 flomo_tags 笔记', legacy);
assert.doesNotMatch(mergeManagedMemo(legacy, updated, options).content, /flomo_tags:/);

const oldStatusCall = updateManagedStatus(fixture, 'deleted', 'managed', syncedAt, syncedAt);
assert.equal(oldStatusCall.ok, true, '原有的五参数状态更新调用仍然兼容');
const malformedWithoutExpectedSlug = fixture.replace(BODY_END, '');
const oldStatusCallMalformed = updateManagedStatus(malformedWithoutExpectedSlug, 'deleted', 'managed', syncedAt, syncedAt);
assert.equal(oldStatusCallMalformed.ok, false, '未提供 expectedSlug 的状态更新也必须检查完整受管结构');
assert.equal(oldStatusCallMalformed.content, malformedWithoutExpectedSlug, '五参数调用拒绝时必须逐字返回输入');

for (const marker of markers) {
  const encodedMarker = marker.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const remoteWithMarker: FlomoMemo = { ...updated, content: `<p>远端正文</p><p>${encodedMarker}</p>` };
  const merged = mergeManagedMemo(fixture, remoteWithMarker, options);
  assert.equal(merged.ok, false, `远端内容生成重复标记 ${marker}: 应拒绝写入`);
  assert.equal(merged.content, fixture, `远端内容生成重复标记 ${marker}: 必须原子失败并保留输入`);
  assert.throws(() => buildNewMemoFile(remoteWithMarker, options), /无法创建受管笔记/, '新建笔记也必须拒绝保留标记冲突');
  rejectedCaseCount++;
}

console.log(`managed-safety tests passed (${rejectedCaseCount} rejected cases, ${compatibleCaseCount} compatible cases)`);
