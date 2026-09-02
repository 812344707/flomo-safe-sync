export interface FlomoLinkedMemo {
  slug: string;
  content: string;
}

export interface FlomoMemo {
  slug: string;
  content: string;
  tags: Array<{ name: string }>;
  created_at: string;
  updated_at: string;
  linked_memos?: FlomoLinkedMemo[];
  files?: Array<{ url: string; name: string }>;
}

export type StorageMode = 'single' | 'first-tag' | 'all-tags';
export type ExcludedPolicy = 'freeze' | 'skip';
export type ManagedStatus = 'active' | 'deleted';
export type ManagedSyncPolicy = 'managed' | 'excluded';

export interface TagFolderMapping {
  tag: string;
  folder: string;
}

export interface TagFolderParseResult {
  mappings: TagFolderMapping[];
  error?: string;
}

export interface PathSettings {
  rootFolder: string;
  fileNameTemplate: string;
  storageMode: StorageMode;
  tagFolderMappings: TagFolderMapping[];
}

export interface ManagedRenderOptions {
  syncedAt: string;
  status?: ManagedStatus;
  syncPolicy?: ManagedSyncPolicy;
  deletedDetectedAt?: string;
  imageMap?: Record<string, string>;
  extraAttachmentPaths?: string[];
  previousFlomoTags?: string[];
  yamlTemplate?: string;
}

export interface MergeResult {
  ok: boolean;
  content: string;
  reason?: string;
}

export const FRONTMATTER_START = '# flomo-sync:frontmatter:start';
export const FRONTMATTER_END = '# flomo-sync:frontmatter:end';
export const BODY_START = '<!-- flomo-sync:content:start -->';
export const BODY_END = '<!-- flomo-sync:content:end -->';

export function normalizeTag(tag: string): string {
  return tag.trim().replace(/^#/, '').replace(/\/+$/g, '');
}

export function extractTags(memo: FlomoMemo): string[] {
  const result: string[] = [];
  for (const rawTag of memo.tags || []) {
    const value = typeof rawTag === 'string' ? rawTag : rawTag?.name;
    const tag = normalizeTag(value || '');
    if (tag && !result.includes(tag)) result.push(tag);
  }
  return result;
}

export function normalizeTagList(tags: string[]): string[] {
  const result: string[] = [];
  for (const rawTag of tags) {
    const tag = normalizeTag(rawTag);
    if (tag && !result.includes(tag)) result.push(tag);
  }
  return result;
}

export function parseTagFolderMappings(value: string): TagFolderParseResult {
  const mappings: TagFolderMapping[] = [];
  const lines = value.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (!line) continue;
    const match = line.match(/^#?(.+?)\s*(?:=|→)\s*(.+)$/);
    if (!match) return { mappings: [], error: `第 ${index + 1} 行应为：标签 = Vault/文件夹` };
    const tag = normalizeTag(match[1]);
    const folder = match[2].trim();
    const pathError = validateVaultRelativePath(folder);
    if (!tag) return { mappings: [], error: `第 ${index + 1} 行缺少标签` };
    if (pathError) return { mappings: [], error: `第 ${index + 1} 行：${pathError}` };
    mappings.push({ tag, folder: normalizeVaultPath(folder) });
  }
  return { mappings };
}

export function memoMatchesExcludedTags(memo: FlomoMemo, excludedTags: string[]): string | null {
  const excluded = normalizeTagList(excludedTags);
  return extractTags(memo).find(tag => excluded.includes(tag)) || null;
}

export function validateVaultRelativePath(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return '路径不能为空';
  if (trimmed.startsWith('/') || /^[A-Za-z]:[\\/]/.test(trimmed)) return '只能使用 Vault 内相对路径';
  const parts = trimmed.split(/[\\/]+/);
  if (parts.some(part => part === '.' || part === '..')) return '路径不能包含 . 或 ..';
  if (parts.some(part => /[<>:"|?*\u0000-\u001f]/.test(part))) return '路径包含不支持的字符';
  return null;
}

export function normalizeVaultPath(value: string): string {
  const error = validateVaultRelativePath(value);
  if (error) throw new Error(error);
  return value.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/');
}

export function sanitizePathSegment(value: string): string {
  return value
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim() || 'untitled';
}

function sanitizeTagPath(tag: string): string {
  return normalizeTag(tag).split('/').filter(Boolean).map(sanitizePathSegment).join('/') || '_untagged';
}

function joinVaultPath(...parts: string[]): string {
  return parts.filter(Boolean).join('/').replace(/\/{2,}/g, '/');
}

export function htmlToMarkdown(html: string, imageMap: Record<string, string> = {}): string {
  let md = html;

  md = md.replace(/<mark>/gi, '==').replace(/<\/mark>/gi, '==');
  md = md.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, content: string) => {
    const inner = htmlToMarkdown(content, imageMap).trim();
    return inner.split('\n').map(line => `> ${line}`).join('\n') + '\n';
  });
  md = md.replace(/<(b|strong)>([\s\S]*?)<\/\1>/gi, '**$2**');
  md = md.replace(/<(i|em)>([\s\S]*?)<\/\1>/gi, '*$2*');
  md = md.replace(/<code>([\s\S]*?)<\/code>/gi, '`$1`');
  md = md.replace(/<a[^>]+href=(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi, '[$3]($2)');
  md = md.replace(/<img[^>]+src=(["'])(.*?)\1[^>]*\/?>/gi, (_match, _quote: string, src: string) => {
    const localPath = imageMap[src];
    return localPath ? `![[${localPath}]]` : `![](${src})`;
  });
  md = md.replace(/<ul[^>]*>([\s\S]*?)<\/ul>/gi, (_, content: string) => {
    return content.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_itemMatch: string, item: string) => {
      return `- ${htmlToMarkdown(item, imageMap).trim()}\n`;
    });
  });

  let counter = 0;
  md = md.replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, (_, content: string) => {
    counter = 0;
    return content.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_itemMatch: string, item: string) => {
      counter++;
      return `${counter}. ${htmlToMarkdown(item, imageMap).trim()}\n`;
    });
  });

  md = md.replace(/<br\s*\/?>/gi, '\n');
  md = md.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '$1\n');
  for (let level = 1; level <= 6; level++) {
    const heading = new RegExp(`<h${level}[^>]*>([\\s\\S]*?)<\\/h${level}>`, 'gi');
    md = md.replace(heading, `${'#'.repeat(level)} $1\n`);
  }
  md = md.replace(/<hr\s*\/?>/gi, '\n---\n');
  md = md.replace(/<[^>]+>/g, '');
  md = md.replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
  return md.replace(/\n{3,}/g, '\n\n').trim();
}

function memoTitle(memo: FlomoMemo): string {
  const firstLine = htmlToMarkdown(memo.content)
    .split('\n')
    .map(line => line.replace(/^[-#>\d.\s*_=]+/, '').trim())
    .find(Boolean);
  return firstLine || 'flomo';
}

function dateParts(createdAt: string): { date: string; time: string } {
  const match = createdAt.match(/(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (match) return { date: match[1], time: `${match[2]}-${match[3]}-${match[4]}` };
  const fallback = new Date(createdAt);
  if (!Number.isNaN(fallback.getTime())) {
    const iso = fallback.toISOString();
    return { date: iso.slice(0, 10), time: iso.slice(11, 19).replace(/:/g, '-') };
  }
  return { date: 'unknown-date', time: 'unknown-time' };
}

function validateTemplateVariables(template: string, label: string): string | null {
  const tokens = template.match(/{{[^}]+}}/g) || [];
  for (const token of tokens) {
    if (!/^{{(?:date|time|first_tag|title(?::\d+)?|slug(?::\d+)?)}}$/.test(token)) {
      return `不支持的${label}变量：${token}`;
    }
  }
  if (template.includes('{{') && tokens.length === 0) return `${label}变量格式不完整`;
  return null;
}

export function validateFileNameTemplate(template: string): string | null {
  if (!template.trim()) return '文件名模板不能为空';
  return validateTemplateVariables(template, '文件名');
}

export function renderFileName(template: string, memo: FlomoMemo): string {
  const error = validateFileNameTemplate(template);
  if (error) throw new Error(error);

  const { date, time } = dateParts(memo.created_at);
  const title = memoTitle(memo);
  const firstTag = extractTags(memo)[0] || 'untagged';
  const rendered = template.replace(/{{(date|time|first_tag|title|slug)(?::(\d+))?}}/g, (_match, key: string, length: string) => {
    const values: Record<string, string> = {
      date,
      time,
      first_tag: firstTag,
      title,
      slug: memo.slug,
    };
    const value = values[key] || '';
    return length ? value.slice(0, Math.max(1, Number.parseInt(length, 10))) : value;
  });
  return sanitizePathSegment(rendered);
}

export function validateYamlTemplate(template: string): string | null {
  if (!template.trim()) return null;
  const seenKeys = new Set<string>();
  const lines = template.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (trimmed === '---') return `第 ${index + 1} 行不能包含 YAML 分隔线`;
    if (/^\s/.test(line)) return `第 ${index + 1} 行只能填写顶层 YAML 字段`;
    const match = line.match(/^([^:]+):(.*)$/);
    if (!match) return `第 ${index + 1} 行应为：字段: 值`;
    const key = match[1].trim();
    const normalizedKey = key.toLowerCase();
    if (!key) return `第 ${index + 1} 行缺少字段名`;
    if (normalizedKey === 'tags' || normalizedKey.startsWith('flomo_')) {
      return `第 ${index + 1} 行的 ${key} 由插件维护，不能在模板中定义`;
    }
    if (seenKeys.has(normalizedKey)) return `第 ${index + 1} 行重复定义字段 ${key}`;
    if (/^[|>]\s*$/.test(match[2].trim())) return `第 ${index + 1} 行暂不支持多行 YAML 值`;
    seenKeys.add(normalizedKey);
  }
  return validateTemplateVariables(template, 'YAML 模板');
}

export function renderYamlTemplate(template: string, memo: FlomoMemo): string {
  const error = validateYamlTemplate(template);
  if (error) throw new Error(error);
  if (!template.trim()) return '';
  const { date, time } = dateParts(memo.created_at);
  const values: Record<string, string> = {
    date,
    time,
    first_tag: extractTags(memo)[0] || 'untagged',
    title: memoTitle(memo),
    slug: memo.slug,
  };
  return template.trim().replace(
    /{{(date|time|first_tag|title|slug)(?::(\d+))?}}/g,
    (_match, key: string, length: string) => {
      const raw = values[key] || '';
      const value = length ? raw.slice(0, Math.max(1, Number.parseInt(length, 10))) : raw;
      return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ');
    },
  );
}

export function findTagFolderMapping(memo: FlomoMemo, mappings: TagFolderMapping[]): TagFolderMapping | null {
  const tags = extractTags(memo);
  for (const mapping of mappings) {
    const tag = normalizeTag(mapping.tag);
    if (tag && tags.includes(tag)) return { tag, folder: normalizeVaultPath(mapping.folder) };
  }
  return null;
}

export function computeDesiredPaths(memo: FlomoMemo, settings: PathSettings): string[] {
  const root = normalizeVaultPath(settings.rootFolder);
  const fileName = `${renderFileName(settings.fileNameTemplate, memo)}.md`;
  const tags = extractTags(memo);
  const mapping = findTagFolderMapping(memo, settings.tagFolderMappings);
  if (mapping) return [joinVaultPath(mapping.folder, fileName)];

  if (settings.storageMode === 'single') return [joinVaultPath(root, fileName)];
  if (settings.storageMode === 'first-tag') {
    return [joinVaultPath(root, tags.length > 0 ? sanitizeTagPath(tags[0]) : '_untagged', fileName)];
  }
  const targetTags = tags.length > 0 ? tags : ['_untagged'];
  return [...new Set(targetTags.map(tag => joinVaultPath(root, sanitizeTagPath(tag), fileName)))];
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

interface FrontmatterParts {
  open: string;
  yaml: string;
  close: string;
  rest: string;
}

function splitFrontmatter(content: string): FrontmatterParts | null {
  const match = content.match(/^(\uFEFF?---\r?\n)([\s\S]*?)(\r?\n---)([\s\S]*)$/);
  if (!match) return null;
  return { open: match[1], yaml: match[2], close: match[3], rest: match[4] };
}

function unquoteYamlScalar(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed) as string;
    } catch (_error) {
      return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed;
}

function splitInlineYamlList(value: string): string[] {
  const items: string[] = [];
  let current = '';
  let quote = '';
  let escaped = false;
  for (const character of value) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === '\\' && quote === '"') {
      current += character;
      escaped = true;
      continue;
    }
    if ((character === '"' || character === "'") && (!quote || quote === character)) {
      quote = quote ? '' : character;
      current += character;
      continue;
    }
    if (character === ',' && !quote) {
      items.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  items.push(current);
  return items;
}

function extractYamlTagsFromYaml(yaml: string, fieldName: string): string[] {
  const lines = yaml.split(/\r?\n/);
  const fieldPattern = new RegExp(`^${fieldName}\\s*:(.*)$`, 'i');
  for (let index = 0; index < lines.length; index++) {
    const match = lines[index].match(fieldPattern);
    if (!match) continue;
    const inline = match[1].trim();
    if (inline.startsWith('[') && inline.endsWith(']')) {
      return normalizeTagList(splitInlineYamlList(inline.slice(1, -1)).map(unquoteYamlScalar));
    }
    if (inline) return normalizeTagList([unquoteYamlScalar(inline)]);
    const values: string[] = [];
    for (let next = index + 1; next < lines.length; next++) {
      const item = lines[next].match(/^\s+-\s+(.*)$/);
      if (item) {
        values.push(unquoteYamlScalar(item[1]));
        continue;
      }
      if (!lines[next].trim()) continue;
      break;
    }
    return normalizeTagList(values);
  }
  return [];
}

export function extractYamlTags(content: string, fieldName = 'tags'): string[] {
  const frontmatter = splitFrontmatter(content);
  return frontmatter ? extractYamlTagsFromYaml(frontmatter.yaml, fieldName) : [];
}

function removeYamlField(lines: string[], fieldName: string): string[] {
  const fieldPattern = new RegExp(`^${fieldName}\\s*:(.*)$`, 'i');
  const result = [...lines];
  for (let index = result.length - 1; index >= 0; index--) {
    const match = result[index].match(fieldPattern);
    if (!match) continue;
    let end = index + 1;
    if (!match[1].trim()) {
      while (end < result.length && (/^\s+/.test(result[end]) || !result[end].trim())) end++;
    }
    result.splice(index, end - index);
  }
  return result;
}

function standardTagsBlock(tags: string[]): string {
  const normalized = normalizeTagList(tags);
  return normalized.length > 0
    ? `tags:\n${normalized.map(tag => `  - ${yamlString(tag)}`).join('\n')}`
    : 'tags: []';
}

export function mergeStandardTags(
  content: string,
  flomoTags: string[],
  previousFlomoTags: string[] = [],
): MergeResult {
  const frontmatter = splitFrontmatter(content);
  if (!frontmatter) return { ok: false, content, reason: '缺少 YAML frontmatter' };

  const existingTags = extractYamlTagsFromYaml(frontmatter.yaml, 'tags');
  const previous = new Set(normalizeTagList(previousFlomoTags));
  const manualTags = existingTags.filter(tag => !previous.has(tag));
  const mergedTags = normalizeTagList([...flomoTags, ...manualTags]);
  let lines = frontmatter.yaml.split(/\r?\n/);
  lines = removeYamlField(lines, 'tags');
  lines = removeYamlField(lines, 'flomo_tags');
  const markerIndex = lines.findIndex(line => line.trim() === FRONTMATTER_END);
  const insertAt = markerIndex >= 0 ? markerIndex + 1 : 0;
  lines.splice(insertAt, 0, ...standardTagsBlock(mergedTags).split('\n'));
  const yaml = lines.join('\n').replace(/\n{3,}/g, '\n\n');
  return {
    ok: true,
    content: `${frontmatter.open}${yaml}${frontmatter.close}${frontmatter.rest}`,
  };
}

function managedFrontmatterBlock(memo: FlomoMemo, options: ManagedRenderOptions): string {
  const status = options.status || 'active';
  const policy = options.syncPolicy || 'managed';
  const deletedLine = options.deletedDetectedAt
    ? `\nflomo_deleted_detected_at: ${yamlString(options.deletedDetectedAt)}`
    : '';
  return `${FRONTMATTER_START}
flomo_slug: ${yamlString(memo.slug)}
flomo_status: ${status}
flomo_sync_policy: ${policy}
flomo_created_at: ${yamlString(memo.created_at)}
flomo_updated_at: ${yamlString(memo.updated_at)}
flomo_last_synced_at: ${yamlString(options.syncedAt)}${deletedLine}
${FRONTMATTER_END}`;
}

function managedBodyBlock(memo: FlomoMemo, options: ManagedRenderOptions): string {
  const markdown = htmlToMarkdown(memo.content, options.imageMap || {});
  const attachments = (options.extraAttachmentPaths || [])
    .filter(path => !Object.values(options.imageMap || {}).includes(path))
    .map(path => `![[${path}]]`);
  const attachmentBlock = attachments.length > 0 ? `\n\n${attachments.join('\n')}` : '';
  return `${BODY_START}
${markdown}${attachmentBlock}
${BODY_END}`;
}

export function buildNewMemoFile(memo: FlomoMemo, options: ManagedRenderOptions): string {
  const template = renderYamlTemplate(options.yamlTemplate || '', memo);
  const extraYaml = [standardTagsBlock(extractTags(memo)), template].filter(Boolean).join('\n');
  return `---
${managedFrontmatterBlock(memo, options)}
${extraYaml}
---

${managedBodyBlock(memo, options)}

## 我的补充

`;
}

function replaceManagedBlock(content: string, startMarker: string, endMarker: string, replacement: string): MergeResult {
  const start = content.indexOf(startMarker);
  const end = content.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0 || end < start) {
    return { ok: false, content, reason: `缺少受管区标记 ${startMarker}` };
  }
  const suffixStart = end + endMarker.length;
  return {
    ok: true,
    content: content.slice(0, start) + replacement + content.slice(suffixStart),
  };
}

export function mergeManagedMemo(content: string, memo: FlomoMemo, options: ManagedRenderOptions): MergeResult {
  const legacyFlomoTags = extractYamlTags(content, 'flomo_tags');
  const frontmatter = replaceManagedBlock(
    content,
    FRONTMATTER_START,
    FRONTMATTER_END,
    managedFrontmatterBlock(memo, options),
  );
  if (!frontmatter.ok) return frontmatter;
  const tags = mergeStandardTags(
    frontmatter.content,
    extractTags(memo),
    legacyFlomoTags.length > 0 ? legacyFlomoTags : options.previousFlomoTags,
  );
  if (!tags.ok) return tags;
  return replaceManagedBlock(
    tags.content,
    BODY_START,
    BODY_END,
    managedBodyBlock(memo, options),
  );
}

function replaceManagedField(block: string, key: string, value: string | null): string {
  const linePattern = new RegExp(`^${key}:.*$`, 'm');
  if (value === null) return block.replace(new RegExp(`^${key}:.*\\n?`, 'm'), '');
  const nextLine = `${key}: ${value}`;
  if (linePattern.test(block)) return block.replace(linePattern, nextLine);
  return block.replace(FRONTMATTER_END, `${nextLine}\n${FRONTMATTER_END}`);
}

export function updateManagedStatus(
  content: string,
  status: ManagedStatus,
  syncPolicy: ManagedSyncPolicy,
  syncedAt: string,
  deletedDetectedAt?: string,
): MergeResult {
  const start = content.indexOf(FRONTMATTER_START);
  const end = content.indexOf(FRONTMATTER_END, start + FRONTMATTER_START.length);
  if (start < 0 || end < 0 || end < start) {
    return { ok: false, content, reason: `缺少受管区标记 ${FRONTMATTER_START}` };
  }
  const suffixStart = end + FRONTMATTER_END.length;
  let block = content.slice(start, suffixStart);
  block = replaceManagedField(block, 'flomo_status', status);
  block = replaceManagedField(block, 'flomo_sync_policy', syncPolicy);
  block = replaceManagedField(block, 'flomo_last_synced_at', yamlString(syncedAt));
  block = replaceManagedField(
    block,
    'flomo_deleted_detected_at',
    deletedDetectedAt ? yamlString(deletedDetectedAt) : null,
  );
  return { ok: true, content: content.slice(0, start) + block + content.slice(suffixStart) };
}

export function hasManagedMarkers(content: string): boolean {
  return [FRONTMATTER_START, FRONTMATTER_END, BODY_START, BODY_END].every(marker => content.includes(marker));
}

export function extractImageSources(html: string): string[] {
  const sources: string[] = [];
  const pattern = /<img[^>]+src=(["'])(.*?)\1[^>]*\/?>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    if (match[2] && !sources.includes(match[2])) sources.push(match[2]);
  }
  return sources;
}

export function fileNameFromUrl(url: string, fallbackIndex: number): string {
  try {
    const pathname = new URL(url).pathname;
    const lastPart = decodeURIComponent(pathname.split('/').filter(Boolean).pop() || '');
    if (lastPart) return sanitizePathSegment(lastPart);
  } catch (_error) {
    // Use a deterministic fallback below.
  }
  return `image-${fallbackIndex}.jpg`;
}
