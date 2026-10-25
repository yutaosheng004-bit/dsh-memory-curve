/**
 * 回溯：只在用户说了「之前 / 上次 / 还记得」这类话时才翻 archive。
 * 逻辑跟原插件一致——按 n-gram 命中数排序，只翻最近几个文件，每条裁到 200 字。
 */
import { norm, tokensOf } from './lexicon.js';

export function searchArchive(store, sessionId, query, { limit = 3, days = 7 } = {}) {
  if (!limit) return [];
  const tokens = tokensOf(query);
  if (!tokens.length) return [];
  const dir = store.dirOf(sessionId);
  const files = store.archiveFiles(dir, days);
  if (!files.length) return [];

  const queryKey = norm(query);
  const hits = [];
  for (const file of files) {
    const date = file.slice(file.lastIndexOf('archive') + 8).replace(/\.jsonl$/, '');
    for (const line of store.readLines(file)) {
      const text = typeof line?.text === 'string' ? line.text.trim() : '';
      if (!text) continue;
      const key = norm(text);
      if (!key || key === queryKey) continue;
      let score = 0;
      for (const token of tokens) if (key.includes(norm(token))) score += 1;
      if (!score) continue;
      hits.push({
        date: line.date || date,
        ts: Number(line.ts) || 0,
        role: line.role === 'assistant' ? 'assistant' : 'user',
        text: text.slice(0, 200),
        score,
      });
    }
  }
  hits.sort((a, b) => b.score - a.score || b.ts - a.ts);
  const out = [];
  const seen = new Set();
  for (const hit of hits) {
    const key = norm(hit.text);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(hit);
    if (out.length >= limit) break;
  }
  return out;
}