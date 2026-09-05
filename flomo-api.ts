import { requestUrl } from 'obsidian';
import { createHash } from 'crypto';
import { FlomoMemo } from './sync-core';

const LIMIT = 200;
function timestamp(value: string): number {
  // Flomo's timezone-less wall clock is China time, independent of the desktop timezone.
  const normalized = /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d$/.test(value) ? `${value.replace(' ', 'T')}+08:00` : value;
  return Math.floor(Date.parse(normalized) / 1000);
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function validateMemoPage(response: unknown): FlomoMemo[] {
  if (!object(response) || response.code !== 0 || !Array.isArray(response.data) || response.data.length > LIMIT) {
    throw new Error('Flomo 响应结构异常，本轮未写入笔记；请稍后重试。');
  }
  for (const item of response.data) {
    if (!object(item) || typeof item.slug !== 'string' || !item.slug.trim()
      || !/^[A-Za-z0-9_-]+$/.test(item.slug) || typeof item.content !== 'string'
      || typeof item.created_at !== 'string' || !Number.isFinite(timestamp(item.created_at))
      || typeof item.updated_at !== 'string' || !Number.isFinite(timestamp(item.updated_at))
      || !Array.isArray(item.tags) || item.tags.some(tag => !(typeof tag === 'string' || (object(tag) && typeof tag.name === 'string')))
      || (item.files != null && (!Array.isArray(item.files) || item.files.some(file => !object(file) || typeof file.url !== 'string' || (file.name != null && typeof file.name !== 'string'))))
      || (item.linked_memos != null && (!Array.isArray(item.linked_memos) || item.linked_memos.some(memo => !object(memo) || typeof memo.slug !== 'string' || typeof memo.content !== 'string')))) {
      throw new Error('Flomo 返回无效 memo，本轮未写入笔记；请稍后重试。');
    }
  }
  return response.data as FlomoMemo[];
}

export async function fetchAllMemos(token: string): Promise<FlomoMemo[]> {
  const result: FlomoMemo[] = [];
  const slugs = new Set<string>();
  const cursors = new Set<string>();
  let cursor: { slug: string; time: number } | undefined;
  // Structural completeness, not a guarantee that the upstream service itself is truthful.
  for (let pageNumber = 0; pageNumber < 10000; pageNumber++) {
    const params: Record<string, string> = {
      limit: String(LIMIT), tz: '8:0', timestamp: String(Math.floor(Date.now() / 1000)),
      api_key: 'flomo_web', app_version: '5.25.64', platform: 'mac', webp: '1',
      ...(cursor ? { latest_slug: cursor.slug, latest_updated_at: String(cursor.time) } : {}),
    };
    params.sign = createHash('md5').update(Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&') + 'dbbc3dd73364b4084c3a69346e0ce2b2').digest('hex');
    const query = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    const response = await requestUrl({ url: `https://flomoapp.com/api/v1/memo/updated/?${query}`, method: 'GET', headers: { Authorization: token } });
    const page = validateMemoPage(response.json);
    for (const memo of page) {
      if (slugs.has(memo.slug)) throw new Error('Flomo 分页重复，本轮未写入笔记。');
      slugs.add(memo.slug);
      result.push(memo);
    }
    if (page.length < LIMIT) return result;
    const last = page[page.length - 1];
    const next = { slug: last.slug, time: timestamp(last.updated_at) };
    const key = `${next.time}/${next.slug}`;
    if (cursors.has(key)) throw new Error('Flomo 分页游标未前进，本轮未写入笔记。');
    cursors.add(key);
    cursor = next;
  }
  throw new Error('Flomo 分页超过安全上限，本轮未写入笔记。');
}
