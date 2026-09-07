import { parseYaml } from 'obsidian';

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

export type ExcludedPolicy = 'freeze' | 'skip';
export type UpdateMode = 'both' | 'body' | 'properties' | 'new-only';
export type ManagedStatus = 'active' | 'deleted';
export type ManagedSyncPolicy = 'managed' | 'excluded';

export interface TagFolderMapping {
  tag: string;
  folder: string;
}

export interface HierarchicalTag {
  tag: string;
  depth: number;
}

export interface TagSelectionState {
  checked: boolean;
  indeterminate: boolean;
}

export interface TagFolderParseResult {
  mappings: TagFolderMapping[];
  error?: string;
}

export interface PathSettings {
  fileNameTemplate: string;
  tagFolderMappings: TagFolderMapping[];
  rootFolder?: string;
  scopeMode?: 'include' | 'exclude';
  scopeTags?: string[];
}

export interface ManagedRenderOptions {
  updateMode?: UpdateMode;
  syncedAt: string;
  status?: ManagedStatus;
  syncPolicy?: ManagedSyncPolicy;
  deletedDetectedAt?: string;
  imageMap?: Record<string, string>;
  extraAttachmentPaths?: string[];
  previousFlomoTags?: string[];
  noteTemplate?: string;
  /** Legacy v0.3.1 YAML-only template; used only while migrating old callers. */
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
export const NOTE_TAGS_TOKEN = '{{flomo_tags}}';
export const NOTE_CONTENT_TOKEN = '{{flomo_content}}';
export const NOTE_MANAGED_PROPERTIES_TEMPLATE = `${FRONTMATTER_START}
flomo_slug: "{{slug}}"
flomo_status: active
flomo_sync_policy: managed
flomo_created_at: "{{created_at}}"
flomo_updated_at: "{{updated_at}}"
flomo_last_synced_at: "{{synced_at}}"
${FRONTMATTER_END}`;

export function createNoteTemplateFromYaml(yamlTemplate = ''): string {
  const yaml = yamlTemplate.trim();
  return `---
${NOTE_MANAGED_PROPERTIES_TEMPLATE}
${NOTE_TAGS_TOKEN}${yaml ? `\n${yaml}` : ''}
---

${BODY_START}
${NOTE_CONTENT_TOKEN}
${BODY_END}

## 我的补充

`;
}

export const DEFAULT_NOTE_TEMPLATE = createNoteTemplateFromYaml();

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

export function hierarchicalTags(tags: string[]): HierarchicalTag[] {
  return normalizeTagList(tags)
    .sort((left, right) => left.localeCompare(right, 'zh-CN', { numeric: true }))
    .map(tag => ({ tag, depth: Math.max(0, tag.split('/').length - 1) }));
}

function tagSubtree(tags: string[], rootTag: string): string[] {
  const root = normalizeTag(rootTag);
  if (!root) return [];
  return hierarchicalTags([...tags, root]).map(item => item.tag)
    .filter(tag => tag === root || tag.startsWith(`${root}/`));
}

export function tagSelectionState(allTags: string[], selectedTags: string[], rootTag: string): TagSelectionState {
  const subtree = tagSubtree(allTags, rootTag);
  const selected = new Set(normalizeTagList(selectedTags));
  const selectedCount = subtree.filter(tag => selected.has(tag)).length;
  return {
    checked: subtree.length > 0 && selectedCount === subtree.length,
    indeterminate: selectedCount > 0 && selectedCount < subtree.length,
  };
}

export function updateCascadingTagSelection(allTags: string[], selectedTags: string[], rootTag: string, checked: boolean): string[] {
  const subtree = tagSubtree(allTags, rootTag);
  const subtreeSet = new Set(subtree);
  const unrelated = normalizeTagList(selectedTags).filter(tag => !subtreeSet.has(tag));
  return checked ? [...unrelated, ...subtree] : unrelated;
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
    const destination = imageMap[src];
    if (!destination) return `![](${src})`;
    return /^https?:\/\//i.test(destination)
      ? `![](&lt;${destination.replace(/&/g, '&amp;').replace(/>/g, '%3E')}&gt;)`
      : `![[${destination}]]`;
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

interface DateTemplateParts {
  date: string;
  time: string;
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
}

function dateParts(createdAt: string): DateTemplateParts {
  const match = createdAt.match(/(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (match) return {
    date: match[1], time: `${match[2]}-${match[3]}-${match[4]}`,
    year: match[1].slice(0, 4), month: match[1].slice(5, 7), day: match[1].slice(8, 10),
    hour: match[2], minute: match[3], second: match[4],
  };
  const fallback = new Date(createdAt);
  if (!Number.isNaN(fallback.getTime())) {
    const iso = fallback.toISOString();
    return {
      date: iso.slice(0, 10), time: iso.slice(11, 19).replace(/:/g, '-'),
      year: iso.slice(0, 4), month: iso.slice(5, 7), day: iso.slice(8, 10),
      hour: iso.slice(11, 13), minute: iso.slice(14, 16), second: iso.slice(17, 19),
    };
  }
  return {
    date: 'unknown-date', time: 'unknown-time', year: 'unknown-year', month: 'unknown-month',
    day: 'unknown-day', hour: 'unknown-hour', minute: 'unknown-minute', second: 'unknown-second',
  };
}

function compactDateTime(createdAt: string): string {
  const { date, time } = dateParts(createdAt);
  if (date === 'unknown-date' || time === 'unknown-time') return 'unknown-datetime';
  return `${date}-${time.replace(/-/g, '')}`;
}

const DATE_FORMAT_PARTS = /yyyy|yy|MM|M|dd|d|HH|H|mm|m|ss|s/g;

function isDateFormatExpression(value: string): boolean {
  if (!/(?:yyyy|yy|MM|M|dd|d|HH|H|mm|m|ss|s)/.test(value)) return false;
  return value.replace(DATE_FORMAT_PARTS, '').replace(/[-_. ]/g, '') === '';
}

function renderDateFormat(format: string, createdAt: string): string {
  const parts = dateParts(createdAt);
  if (parts.date === 'unknown-date' || parts.time === 'unknown-time') return 'unknown-datetime';
  const values: Record<string, string> = {
    yyyy: parts.year,
    yy: parts.year.slice(-2),
    MM: parts.month,
    M: String(Number(parts.month)),
    dd: parts.day,
    d: String(Number(parts.day)),
    HH: parts.hour,
    H: String(Number(parts.hour)),
    mm: parts.minute,
    m: String(Number(parts.minute)),
    ss: parts.second,
    s: String(Number(parts.second)),
  };
  return format.replace(DATE_FORMAT_PARTS, token => values[token]);
}

function templateVariableValue(expression: string, memo: FlomoMemo): string | null {
  if (isDateFormatExpression(expression)) return renderDateFormat(expression, memo.created_at);
  const lengthMatch = expression.match(/^(title|slug)(?::(\d+))?$/);
  const parts = dateParts(memo.created_at);
  const values: Record<string, string> = {
    ...parts,
    'YYYY-MM-DD-HHmmss': compactDateTime(memo.created_at),
    first_tag: extractTags(memo)[0] || 'untagged',
    title: memoTitle(memo),
    slug: memo.slug,
  };
  const key = lengthMatch?.[1] || expression;
  if (!(key in values)) return null;
  const value = values[key];
  return lengthMatch?.[2] ? value.slice(0, Math.max(1, Number.parseInt(lengthMatch[2], 10))) : value;
}

function validateTemplateVariables(template: string, label: string): string | null {
  const tokens = template.match(/{{[^}]+}}/g) || [];
  for (const token of tokens) {
    const expression = token.slice(2, -2);
    if (/^[yYMDdHhms._ -]+$/.test(expression) && /[YD]/.test(expression) && expression !== 'YYYY-MM-DD-HHmmss') {
      return `${label}日期格式请使用 yyyy 表示年份、dd 表示日期；仅完整旧变量 {{YYYY-MM-DD-HHmmss}} 保持兼容`;
    }
    if (!isDateFormatExpression(expression)
      && !/^(?:date|time|year|month|day|hour|minute|second|YYYY-MM-DD-HHmmss|first_tag|title(?::\d+)?|slug(?::\d+)?)$/.test(expression)) {
      return `不支持的${label}变量：${token}`;
    }
  }
  const remaining = template.replace(/{{[^}]+}}/g, '');
  if (remaining.includes('{{') || remaining.includes('}}')) return `${label}变量格式不完整`;
  return null;
}

export function validateFileNameTemplate(template: string): string | null {
  if (!template.trim()) return '文件名模板不能为空';
  return validateTemplateVariables(template, '文件名');
}

export function renderFileName(template: string, memo: FlomoMemo): string {
  const error = validateFileNameTemplate(template);
  if (error) throw new Error(error);

  const rendered = template.replace(/{{([^{}]+)}}/g, (_match, expression: string) => templateVariableValue(expression, memo) || '');
  return sanitizePathSegment(rendered);
}

export function validateYamlTemplate(template: string): string | null {
  if (!template.trim()) return null;
  const variableError = validateTemplateVariables(template, 'YAML 模板');
  if (variableError) return variableError;
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
    if (match[1].includes('{{')) return `第 ${index + 1} 行的字段名不能使用变量`;
    let parsed: Record<string, unknown>;
    let validationToken = 'FLOMO_TEMPLATE_VALUE';
    while (line.includes(validationToken)) validationToken += '_';
    try {
      parsed = parseYaml(line.replace(/{{[^}]+}}/g, validationToken));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).length !== 1) throw new Error('需要一个顶层字段');
    } catch (error) { return `第 ${index + 1} 行 YAML 无效：${(error as Error).message}`; }
    const key = Object.keys(parsed)[0];
    if (key.includes(validationToken)) return `第 ${index + 1} 行的字段名不能使用变量`;
    const normalizedKey = key.toLowerCase();
    if (!key) return `第 ${index + 1} 行缺少字段名`;
    if (normalizedKey === 'tags' || normalizedKey.startsWith('flomo_')) {
      return `第 ${index + 1} 行的 ${key} 由插件维护，不能在模板中定义`;
    }
    if (seenKeys.has(normalizedKey)) return `第 ${index + 1} 行重复定义字段 ${key}`;
    if (/^[|>]\s*$/.test(match[2].trim())) return `第 ${index + 1} 行暂不支持多行 YAML 值`;
    seenKeys.add(normalizedKey);
  }
  return null;
}

export function renderYamlTemplate(template: string, memo: FlomoMemo): string {
  const error = validateYamlTemplate(template);
  if (error) throw new Error(error);
  if (!template.trim()) return '';
  const rendered = template.trim().split(/\r?\n/).map(line => {
    if (!line.includes('{{') || line.trim().startsWith('#')) return line;
    const replacements: string[] = [];
    let sentinel = 'FLOMO_TEMPLATE_SLOT_';
    while (line.includes(sentinel)) sentinel += '_';
    const skeleton = line.replace(/{{([^{}]+)}}/g, (_match, expression: string) => {
      replacements.push(templateVariableValue(expression, memo) || '');
      return `${sentinel}${replacements.length - 1}_END`;
    });
    const parsed = parseYaml(skeleton) as Record<string, unknown>;
    const substitute = (value: unknown): unknown => {
      if (typeof value === 'string') return value.replace(new RegExp(`${sentinel}(\\d+)_END`, 'g'), (_m, index: string) => replacements[Number(index)]);
      if (Array.isArray(value)) return value.map(substitute);
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, val]) => [key, substitute(val)]));
      return value;
    };
    const key = Object.keys(parsed)[0];
    const renderedKey = /^[A-Za-z0-9_\u4e00-\u9fff-]+$/.test(key) ? key : JSON.stringify(key);
    return `${renderedKey}: ${JSON.stringify(substitute(parsed[key]))}`;
  }).join('\n');
  parseYaml(rendered);
  return rendered;
}

export function tagsInScope(tags: string[], settings: Pick<PathSettings, 'scopeMode' | 'scopeTags' | 'tagFolderMappings'>): boolean {
  const selected = new Set(normalizeTagList(settings.scopeTags ?? settings.tagFolderMappings.map(m => m.tag)));
  const matched = normalizeTagList(tags).some(tag => selected.has(tag));
  return settings.scopeMode === 'exclude' ? !matched : matched;
}

export function findTagFolderMapping(memo: FlomoMemo, mappings: TagFolderMapping[]): TagFolderMapping | null {
  return findTagFolderMappingForTags(extractTags(memo), mappings);
}

export function findTagFolderMappingForTags(tags: string[], mappings: TagFolderMapping[]): TagFolderMapping | null {
  const normalizedTags = normalizeTagList(tags);
  for (const mapping of mappings) {
    const tag = normalizeTag(mapping.tag);
    if (tag && normalizedTags.includes(tag)) return { tag, folder: normalizeVaultPath(mapping.folder) };
  }
  return null;
}

export function collectFlomoTags(memos: FlomoMemo[]): string[] {
  return normalizeTagList(memos.flatMap(extractTags));
}

export function computeDesiredPaths(memo: FlomoMemo, settings: PathSettings): string[] {
  if (!tagsInScope(extractTags(memo), settings)) return [];
  const fileName = `${renderFileName(settings.fileNameTemplate, memo)}.md`;
  const scopeTags = new Set(normalizeTagList(settings.scopeTags ?? settings.tagFolderMappings.map(mapping => mapping.tag)));
  const eligibleMappings = settings.tagFolderMappings.filter(mapping =>
    settings.scopeMode === 'exclude' ? !scopeTags.has(normalizeTag(mapping.tag)) : scopeTags.has(normalizeTag(mapping.tag)));
  const mapping = findTagFolderMapping(memo, eligibleMappings);
  if (mapping) return [joinVaultPath(mapping.folder, fileName)];
  return settings.rootFolder ? [joinVaultPath(normalizeVaultPath(settings.rootFolder), fileName)] : [];
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
  const match = content.match(/^(\uFEFF?---\r?\n)([\s\S]*?)(\r?\n---)(?=\r?\n|$)([\s\S]*)$/);
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

/** Identity claims block duplicate imports; they never authorize a managed write. */
export function extractClaimedFlomoSlugs(content: string): string[] {
  const yaml = splitFrontmatter(content)?.yaml
    ?? content.match(/^\uFEFF?---\r?\n([\s\S]*?)(?:\r?\n(?:---|\.\.\.)(?:\r?\n|$)|$)/)?.[1];
  if (yaml === undefined) return [];
  const slugs = new Set<string>();
  const readClaim = (source: string): void => {
    try {
      const parsed = parseYaml(source);
      const value = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed.flomo_slug : undefined;
      if (typeof value === 'string' || typeof value === 'number') {
        const slug = String(value).trim();
        if (/^[A-Za-z0-9_-]+$/.test(slug)) slugs.add(slug);
      }
    } catch (_error) { /* A malformed document may still contain an identity claim. */ }
  };
  readClaim(yaml);
  // Duplicate fields or unrelated broken YAML must not hide a claimed identity.
  for (const line of yaml.split(/\r?\n/)) {
    if (/^(?:flomo_slug|"flomo_slug"|'flomo_slug')\s*:/.test(line)) readClaim(line);
  }
  return [...slugs];
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
  const newline = frontmatter.open.endsWith('\r\n') ? '\r\n' : '\n';
  const yaml = lines.join(newline);
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
  const inlinePaths = new Set(extractImageSources(memo.content).map(url => options.imageMap?.[url] || url));
  const attachments = (options.extraAttachmentPaths || [])
    .filter((path, index, all) => !inlinePaths.has(path) && all.indexOf(path) === index)
    .map(path => /^https?:\/\//i.test(path) ? `[附件](<${path.replace(/>/g, '%3E')}>)` : `![[${path}]]`);
  const attachmentBlock = attachments.length > 0 ? `\n\n${attachments.join('\n')}` : '';
  return `${BODY_START}
${markdown}${attachmentBlock}
${BODY_END}`;
}

function tokenCount(template: string, token: string): number {
  return template.split(token).length - 1;
}

function isStandaloneToken(line: string, token: string): boolean {
  return line.trim() === token;
}

export function validateNoteTemplate(template: string): string | null {
  if (!template.trim()) return '笔记模板不能为空';
  for (const [token, label] of [
    [NOTE_TAGS_TOKEN, '标签合并区'],
    [NOTE_CONTENT_TOKEN, 'Flomo 正文内容'],
  ] as const) {
    const count = tokenCount(template, token);
    if (count !== 1) return `${label}占位符 ${token} 必须且只能保留一个`;
  }
  const frontmatter = splitFrontmatter(template);
  if (!frontmatter) return '模板必须以完整的 YAML frontmatter 开头（---）';
  const metadata = findManagedRegion(template, FRONTMATTER_START, FRONTMATTER_END);
  if (typeof metadata === 'string') return metadata;
  const body = findManagedRegion(template, BODY_START, BODY_END);
  if (typeof body === 'string') return body;
  const yamlStart = frontmatter.open.length, yamlEnd = yamlStart + frontmatter.yaml.length;
  if (metadata.start < yamlStart || metadata.end > yamlEnd) return '元数据受管区必须位于文件顶部的 YAML frontmatter 内';
  if (body.start < yamlEnd + frontmatter.close.length) return '正文受管区必须位于 YAML frontmatter 之后';
  const managedPrototype = template.slice(metadata.start, metadata.end).replace(/\r\n/g, '\n');
  if (managedPrototype !== NOTE_MANAGED_PROPERTIES_TEMPLATE) return 'Flomo 属性受管区是安全结构，不能删除或改写其中字段';
  const bodyPrototype = template.slice(body.start, body.end).replace(/\r\n/g, '\n');
  if (bodyPrototype !== `${BODY_START}\n${NOTE_CONTENT_TOKEN}\n${BODY_END}`) return 'Flomo 正文受管区必须保留完整标记及正文占位符';
  const yamlLines = frontmatter.yaml.split(/\r?\n/);
  if (!yamlLines.some(line => isStandaloneToken(line, NOTE_TAGS_TOKEN))) return `${NOTE_TAGS_TOKEN} 必须在 YAML 中独占一行`;
  let inManagedYaml = false;
  const userYaml = yamlLines.filter(line => {
    if (line.trim() === FRONTMATTER_START) { inManagedYaml = true; return false; }
    if (inManagedYaml) { if (line.trim() === FRONTMATTER_END) inManagedYaml = false; return false; }
    return !isStandaloneToken(line, NOTE_TAGS_TOKEN);
  }).join('\n');
  const yamlError = validateYamlTemplate(userYaml);
  if (yamlError) return `用户 YAML：${yamlError}`;
  const bodyWithoutManaged = template.slice(yamlEnd + frontmatter.close.length, body.start)
    + template.slice(body.end);
  return validateTemplateVariables(bodyWithoutManaged, '笔记模板');
}

function renderTextTemplate(template: string, memo: FlomoMemo): string {
  return template.replace(/{{([^{}]+)}}/g, (_match, expression: string) => templateVariableValue(expression, memo) || '');
}

export function renderNoteTemplate(template: string, memo: FlomoMemo, options: ManagedRenderOptions): string {
  const error = validateNoteTemplate(template);
  if (error) throw new Error(error);
  const frontmatter = splitFrontmatter(template)!;
  let inManagedYaml = false;
  const yamlLines: string[] = [];
  for (const line of frontmatter.yaml.split(/\r?\n/)) {
    if (line.trim() === FRONTMATTER_START) { inManagedYaml = true; yamlLines.push(managedFrontmatterBlock(memo, options)); continue; }
    if (inManagedYaml) { if (line.trim() === FRONTMATTER_END) inManagedYaml = false; continue; }
    if (isStandaloneToken(line, NOTE_TAGS_TOKEN)) yamlLines.push(standardTagsBlock(extractTags(memo)));
    else yamlLines.push(line.trim() ? renderYamlTemplate(line, memo) : line);
  }
  let inManagedBody = false;
  const bodyLines: string[] = [];
  for (const line of frontmatter.rest.split(/\r?\n/)) {
    if (line.trim() === BODY_START) { inManagedBody = true; bodyLines.push(managedBodyBlock(memo, options)); continue; }
    if (inManagedBody) { if (line.trim() === BODY_END) inManagedBody = false; continue; }
    bodyLines.push(renderTextTemplate(line, memo));
  }
  const content = `${frontmatter.open.replace(/\r\n/g, '\n')}${yamlLines.join('\n')}${frontmatter.close.replace(/\r\n/g, '\n')}${bodyLines.join('\n')}`;
  const renderedFrontmatter = splitFrontmatter(content);
  if (!renderedFrontmatter) throw new Error('渲染后缺少完整的 YAML frontmatter');
  try { parseYaml(renderedFrontmatter.yaml); } catch (parseError) { throw new Error(`渲染后的 YAML 无效：${(parseError as Error).message}`); }
  const validation = inspectManagedMemo(content, memo.slug);
  if (!validation.ok) throw new Error(`无法创建受管笔记：${validation.reason}`);
  return content;
}

export function buildNewMemoFile(memo: FlomoMemo, options: ManagedRenderOptions): string {
  return renderNoteTemplate(options.noteTemplate ?? createNoteTemplateFromYaml(options.yamlTemplate || ''), memo, options);
}

interface ManagedRegion {
  start: number;
  end: number;
}

type ManagedInspection = {
  ok: true;
  metadata: ManagedRegion;
  body: ManagedRegion;
  newline: string;
} | {
  ok: false;
  content: string;
  reason: string;
};

function findManagedRegion(content: string, startMarker: string, endMarker: string): ManagedRegion | string {
  for (const marker of [startMarker, endMarker]) {
    const index = content.indexOf(marker);
    if (index < 0) return `缺少受管区标记 ${marker}`;
    if (content.indexOf(marker, index + marker.length) >= 0) return `受管区标记重复 ${marker}`;
    const after = content.slice(index + marker.length);
    if ((index > 0 && content[index - 1] !== '\n') || !/^(?:\r?\n|$)/.test(after)) {
      return `受管区标记必须独占一行 ${marker}`;
    }
  }
  const start = content.indexOf(startMarker);
  const end = content.indexOf(endMarker);
  if (end < start) return `受管区标记顺序错误 ${startMarker}`;
  return { start, end: end + endMarker.length };
}

function readManagedSlug(value: string): string | null {
  const scalar = value.trim();
  if (scalar.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(scalar);
      return typeof parsed === 'string' && parsed.length > 0 ? parsed : null;
    } catch (_error) {
      return null;
    }
  }
  if (/^'(?:[^']|'')+'$/.test(scalar)) return scalar.slice(1, -1).replace(/''/g, "'");
  return /^[A-Za-z0-9_-]+$/.test(scalar) ? scalar : null;
}

// Validate the entire file before replacing anything. A familiar path or one
// matching marker is not enough to establish ownership of a local note.
function inspectManagedMemo(content: string, expectedSlug?: string): ManagedInspection {
  const fail = (reason: string): ManagedInspection => ({ ok: false, content, reason });
  const frontmatter = splitFrontmatter(content);
  if (!frontmatter) return fail('缺少文件顶部完整的 YAML frontmatter');

  const metadata = findManagedRegion(content, FRONTMATTER_START, FRONTMATTER_END);
  if (typeof metadata === 'string') return fail(metadata);
  const body = findManagedRegion(content, BODY_START, BODY_END);
  if (typeof body === 'string') return fail(body);

  const yamlStart = frontmatter.open.length;
  const yamlEnd = yamlStart + frontmatter.yaml.length;
  if (metadata.start < yamlStart || metadata.end > yamlEnd) {
    return fail('元数据受管区必须位于文件顶部的 YAML frontmatter 内');
  }
  if (body.start < yamlEnd + frontmatter.close.length) {
    return fail('正文受管区必须位于 YAML frontmatter 之后');
  }

  const slugFields = frontmatter.yaml.match(/^(?:flomo_slug|"flomo_slug"|'flomo_slug')[ \t]*:.*$/gm) || [];
  if (slugFields.length !== 1) return fail('flomo_slug 缺失或重复，无法确认笔记身份');
  const managedYaml = content.slice(metadata.start, metadata.end);
  const slugMatch = managedYaml.match(/^flomo_slug:[ \t]*(.*)$/m);
  const slug = slugMatch ? readManagedSlug(slugMatch[1]) : null;
  if (!slug) return fail('受管区内缺少可确认的 flomo_slug');
  if (expectedSlug !== undefined && slug !== expectedSlug) {
    return fail('flomo_slug 与待同步笔记不一致，已保留原文件');
  }
  return {
    ok: true,
    metadata,
    body,
    newline: frontmatter.open.endsWith('\r\n') ? '\r\n' : '\n',
  };
}

function replaceRegion(content: string, region: ManagedRegion, replacement: string): string {
  return content.slice(0, region.start) + replacement + content.slice(region.end);
}

function withNewline(content: string, newline: string): string {
  return content.replace(/\r?\n/g, newline);
}

export function mergeManagedMemo(content: string, memo: FlomoMemo, options: ManagedRenderOptions): MergeResult {
  const inspection = inspectManagedMemo(content, memo.slug);
  if (!inspection.ok) return inspection;
  if (options.updateMode === 'new-only') return { ok: true, content };

  const legacyFlomoTags = extractYamlTags(content, 'flomo_tags');
  // Replace the later region first so the original metadata offsets stay valid.
  const body = options.updateMode === 'properties' ? content : replaceRegion(content, inspection.body, withNewline(managedBodyBlock(memo, options), inspection.newline));
  if (options.updateMode === 'body') {
    const validation = inspectManagedMemo(body, memo.slug);
    return validation.ok ? { ok: true, content: body } : { ...validation, content };
  }
  const updated = replaceRegion(body, inspection.metadata, withNewline(managedFrontmatterBlock(memo, options), inspection.newline));
  const tags = mergeStandardTags(
    updated,
    extractTags(memo),
    legacyFlomoTags.length > 0 ? legacyFlomoTags : options.previousFlomoTags,
  );
  if (!tags.ok) return { ...tags, content };

  // Remote content can contain reserved markers too. Never return a partially
  // modified file if rendering or tag merging produces an ambiguous document.
  const validation = inspectManagedMemo(tags.content, memo.slug);
  if (!validation.ok) return { ...validation, content };
  return { ok: true, content: tags.content };
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
  expectedSlug?: string,
): MergeResult {
  const inspection = inspectManagedMemo(content, expectedSlug);
  if (!inspection.ok) return inspection;
  const region = inspection.metadata;
  let block = content.slice(region.start, region.end).replace(/\r\n/g, '\n');
  block = replaceManagedField(block, 'flomo_status', status);
  block = replaceManagedField(block, 'flomo_sync_policy', syncPolicy);
  block = replaceManagedField(block, 'flomo_last_synced_at', yamlString(syncedAt));
  block = replaceManagedField(
    block,
    'flomo_deleted_detected_at',
    deletedDetectedAt ? yamlString(deletedDetectedAt) : null,
  );
  const updated = replaceRegion(content, region, withNewline(block, inspection.newline));
  const validation = inspectManagedMemo(updated, expectedSlug);
  if (!validation.ok) return { ...validation, content };
  return { ok: true, content: updated };
}

export function hasManagedMarkers(content: string, expectedSlug?: string): boolean {
  return inspectManagedMemo(content, expectedSlug).ok;
}

/**
 * Returns image and wiki-embed destinations from the managed body in display order.
 * Image-host uploaders normally replace a local embed in place, so the order
 * lets sync retain that replacement without inspecting the user's free-text area.
 */
export function extractManagedBodyEmbedTargets(content: string, expectedSlug?: string): string[] {
  const inspection = inspectManagedMemo(content, expectedSlug);
  if (!inspection.ok) return [];
  const body = content.slice(inspection.body.start, inspection.body.end);
  const matches: Array<{ index: number; target: string }> = [];
  const wiki = /!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;
  const markdown = /!\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\s*\)/g;
  const html = /<img[^>]+src=(["'])(.*?)\1[^>]*\/?>/gi;
  let match: RegExpExecArray | null;
  while ((match = wiki.exec(body)) !== null) matches.push({ index: match.index, target: match[1].trim() });
  while ((match = markdown.exec(body)) !== null) matches.push({ index: match.index, target: (match[1] || match[2] || '').trim() });
  while ((match = html.exec(body)) !== null) matches.push({ index: match.index, target: (match[2] || '').trim() });
  return matches.sort((left, right) => left.index - right.index).map(item => item.target).filter(Boolean);
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
