/**
 * 四层记忆的核心。
 *
 * 跟 main.py 的对应关系：
 *   L1 原文窗口  —— l1.json，只用来给判分器看「上一句」+ 给存档留底；
 *                    DSH 自己管历史，所以这里不覆盖宿主的上下文（原插件会覆盖 req.contexts）。
 *   L2 短期摘要  —— l2.json，score ≥ 2 进，默认 24h 过期，注入最近几条。
 *   L3 长期事实  —— l3.json，每天维护时把 score ≥ 4 且不是一次性任务的 L2 提升上来，默认 30 天。
 *   L4 全量存档  —— archive/<YYYY-MM-DD>.jsonl，关键词命中时才回溯。
 */
import path from 'node:path';
import { MemoryStore } from './store.js';
import { judgeTurn } from './judge.js';
import { searchArchive } from './recall.js';
import {
  L2_SCORE,
  L3_SCORE,
  extractPromise,
  isOneOff,
  localDay,
  needsRecall,
  norm,
  shortId,
  textOf,
  tokensOf,
} from './lexicon.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const oneLine = (value, max = 120) => textOf(value).replace(/\s+/g, ' ').trim().slice(0, max);

function upsert(list, item) {
  const key = norm(item.text);
  if (!key) return null;
  const found = list.find((row) => norm(row.text) === key);
  if (found) {
    found.score = Math.max(Number(found.score) || 0, Number(item.score) || 0);
    found.last = Math.max(Number(found.last) || 0, Number(item.last) || 0);
    found.ts = Math.min(Number(found.ts) || item.ts, item.ts);
    if (item.type) found.type = item.type;
    if (item.kw) found.kw = item.kw;
    if (item.src) found.src = item.src;
    return found;
  }
  list.push(item);
  return item;
}

export class MemoryCurve {
  constructor({ ctx, config, log }) {
    this.ctx = ctx;
    this.config = config;
    this.log = typeof log === 'function' ? log : () => {};
    this.store = new MemoryStore(config.dataDir);
    this.cache = new Map();
    this.chains = new Map();
  }

  dirOf(sessionId) {
    return this.store.dirOf(sessionId);
  }

  // ---------------------------------------------------------------- 载入 / 落盘
  load(sessionId) {
    const key = String(sessionId ?? '');
    if (!key) return null;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const dir = this.store.dirOf(key);
    const file = (name) => path.join(dir, name);
    const s = {
      key,
      dir,
      l1: this.store.readJson(file('l1.json'), []),
      l2: this.store.readJson(file('l2.json'), []),
      l3: this.store.readJson(file('l3.json'), []),
      state: this.store.readJson(file('state.json'), { lastDay: '', lastMaintainAt: 0 }),
    };
    if (!Array.isArray(s.l1)) s.l1 = [];
    if (!Array.isArray(s.l2)) s.l2 = [];
    if (!Array.isArray(s.l3)) s.l3 = [];
    if (!s.state || typeof s.state !== 'object') s.state = { lastDay: '', lastMaintainAt: 0 };
    this.cache.set(key, s);
    return s;
  }

  drop(sessionId) {
    const key = String(sessionId ?? '');
    if (key) this.cache.delete(key);
  }

  persist(s) {
    const file = (name) => path.join(s.dir, name);
    this.store.writeJson(file('l1.json'), s.l1);
    this.store.writeJson(file('l2.json'), s.l2);
    this.store.writeJson(file('l3.json'), s.l3);
    this.store.writeJson(file('state.json'), s.state);
  }

  // ---------------------------------------------------------------- 视图
  liveL2(s, now = Date.now()) {
    const cutoff = now - this.config.l2ExpireHours * HOUR;
    const rows = s.l2.filter((row) => (Number(row.last) || Number(row.ts) || 0) >= cutoff);
    rows.sort((a, b) => (Number(a.last) || Number(a.ts) || 0) - (Number(b.last) || Number(b.ts) || 0));
    const max = this.config.l2MaxItems;
    return max > 0 ? rows.slice(-max) : [];
  }

  liveL3(s, now = Date.now()) {
    const cutoff = now - this.config.l3ExpireDays * DAY;
    const rows = s.l3.filter((row) => (Number(row.last) || Number(row.ts) || 0) >= cutoff);
    rows.sort(
      (a, b) =>
        (Number(b.score) || 0) - (Number(a.score) || 0) ||
        (Number(b.last) || 0) - (Number(a.last) || 0),
    );
    const max = this.config.l3MaxItems;
    return max > 0 ? rows.slice(0, max) : [];
  }

  // ---------------------------------------------------------------- 注入
  /**
   * 每轮现算的记忆块。纯同步：宿主会在组装 system prompt 时等这个返回值。
   * @param {string} sessionId
   * @param {string} lastUserText 用户这一轮说的话（用来判断要不要回溯）
   */
  block(sessionId, lastUserText = '') {
    if (!this.config.enabled) return '';
    const s = this.load(sessionId);
    if (!s) return '';
    if (this.maintain(s)) this.persist(s);

    const now = Date.now();
    const l3 = this.liveL3(s, now);
    const l2 = this.liveL2(s, now);
    const parts = [];

    if (l3.length) {
      parts.push(`【长期记忆】\n${l3.map((row) => `- ${oneLine(row.text)}${row.type ? `（${row.type}）` : ''}`).join('\n')}`);
    }
    if (l2.length) {
      parts.push(`【短期记忆】\n${l2.map((row) => `- ${oneLine(row.text)}`).join('\n')}`);
    }
    if (lastUserText && needsRecall(lastUserText)) {
      const hits = searchArchive(this.store, sessionId, lastUserText, {
        limit: this.config.retrieveLimit,
        days: this.config.archiveDays,
      });
      if (hits.length) {
        parts.push(`【相关回忆】\n${hits.map((hit) => `- [${hit.date}] ${oneLine(hit.text, 200)}`).join('\n')}`);
      }
    }
    if (!parts.length) return '';

    let body = [
      '【鲸鲸的记忆】下面这些是你自己以前记下的，不是主人这轮说的话。',
      '用得上就用，不确定就说不记得——别把记忆里的细节硬安到这一轮。',
      parts.join('\n'),
    ].join('\n');
    if (this.config.memoryBias) body += `\n【备注】${this.config.memoryBias}`;
    if (body.length > this.config.maxInjectChars) {
      body = `${body.slice(0, this.config.maxInjectChars)}…`;
    }
    return body;
  }

  // ---------------------------------------------------------------- 维护
  /** 过期、每日提升、截尾。返回是否改动过。 */
  maintain(s, { force = false } = {}) {
    const now = Date.now();
    let changed = false;

    // L2 过期
    const l2Cutoff = now - this.config.l2ExpireHours * HOUR;
    const l2Before = s.l2.length;
    s.l2 = s.l2.filter(
      (row) => (Number(row.last) || Number(row.ts) || 0) >= l2Cutoff || row.pinned === true,
    );
    if (s.l2.length !== l2Before) changed = true;

    // 每天第一次维护：把够格且不是一次性任务的 L2 提升到 L3
    const today = localDay(now);
    if (force || s.state.lastDay !== today) {
      for (const row of s.l2) {
        if ((Number(row.score) || 0) < L3_SCORE) continue;
        if (isOneOff(row.text) && row.src !== 'manual') continue;
        upsert(s.l3, {
          id: shortId(),
          text: oneLine(row.text),
          type: row.type || '事实',
          kw: row.kw || '',
          score: Number(row.score) || L3_SCORE,
          ts: Number(row.ts) || now,
          last: Number(row.last) || now,
          src: row.src === 'assistant' ? 'assistant' : 'promote',
        });
      }
      s.state.lastDay = today;
      s.state.lastMaintainAt = now;
      changed = true;
    }

    // L3 过期 + 截尾
    const l3Cutoff = now - this.config.l3ExpireDays * DAY;
    const l3Before = s.l3.length;
    s.l3 = s.l3.filter((row) => (Number(row.last) || Number(row.ts) || 0) >= l3Cutoff);
    if (s.l3.length !== l3Before) changed = true;
    const max = this.config.l3MaxItems;
    if (max > 0 && s.l3.length > max) {
      s.l3.sort(
        (a, b) =>
          (Number(b.score) || 0) - (Number(a.score) || 0) ||
          (Number(b.last) || 0) - (Number(a.last) || 0),
      );
      s.l3 = s.l3.slice(0, max);
      changed = true;
    }
    return changed;
  }

  /** 本轮提到某条长期事实，就给它续期。 */
  touch(s, text, now = Date.now()) {
    const tokens = tokensOf(text);
    if (!tokens.length) return 0;
    let touched = 0;
    for (const row of s.l3) {
      const factKey = norm(row.text);
      if (!factKey) continue;
      const kwKey = norm(row.kw);
      const hit = tokens.some((token) => {
        const key = norm(token);
        if (!key) return false;
        return factKey.includes(key) || (kwKey && kwKey === key);
      });
      if (hit) {
        row.last = now;
        touched += 1;
      }
    }
    return touched;
  }

  // ---------------------------------------------------------------- 一轮问答
  /** 队列化：同一个会话串行落盘，避免并发写坏文件。 */
  saveTurn(sessionId, { userText, answerText } = {}) {
    const key = String(sessionId ?? '');
    if (!key) return Promise.resolve({ ok: false, error: 'no session' });
    if (!this.config.enabled) return Promise.resolve({ ok: false, error: 'disabled' });
    const user = textOf(userText).trim();
    if (!user) return Promise.resolve({ ok: false, error: 'empty message' });
    const answer = textOf(answerText).trim().slice(0, 4000);

    const prev = this.chains.get(key) || Promise.resolve();
    const run = prev
      .catch(() => {})
      .then(() => this.#saveTurn(key, user, answer))
      .catch((error) => {
        this.log('warn', `memory save failed (${key}): ${error instanceof Error ? error.message : error}`);
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      });
    this.chains.set(
      key,
      run.then(
        () => {},
        () => {},
      ),
    );
    return run;
  }

  async #saveTurn(key, user, answer) {
    const s = this.load(key);
    if (!s) return { ok: false, error: 'no session' };
    const now = Date.now();

    // 判分要看「我上一句」，趁还没把这一轮塞进 L1 先捞出来
    const lastReply = [...s.l1].reverse().find((row) => row.role === 'assistant')?.text || '';

    // L1 原文窗口
    s.l1.push({ ts: now, role: 'user', text: oneLine(user, 600) });
    if (answer) s.l1.push({ ts: now, role: 'assistant', text: oneLine(answer, 600) });
    const keep = Math.max(2, this.config.l1MaxTurns * 4);
    if (s.l1.length > keep) s.l1 = s.l1.slice(-keep);

    // L4 存档
    const day = localDay(now);
    const archive = path.join(s.dir, 'archive', `${day}.jsonl`);
    this.store.appendLine(archive, { ts: now, date: day, role: 'user', text: oneLine(user, 600) });
    if (answer) {
      this.store.appendLine(archive, { ts: now, date: day, role: 'assistant', text: oneLine(answer, 600) });
    }

    // 判分
    const judged = await judgeTurn(this.ctx, {
      config: this.config,
      message: user,
      lastReply,
      log: this.log,
    });

    let stored = null;
    if ((Number(judged.score) || 0) >= L2_SCORE && judged.summary) {
      stored = upsert(s.l2, {
        id: shortId(now),
        text: oneLine(judged.summary, 80),
        type: judged.type || '日常',
        kw: judged.keyword || '',
        score: Number(judged.score) || L2_SCORE,
        ts: now,
        last: now,
        src: 'user',
      });
    }

    // 我答应过的事，单独记一条
    let promise = null;
    if (answer && (Number(judged.score) || 0) >= 3) {
      const text = extractPromise(answer);
      if (text) {
        promise = upsert(s.l2, {
          id: shortId(now),
          text: oneLine(`我答应过：${text}`, 100),
          type: '约定',
          kw: '',
          score: L3_SCORE,
          ts: now,
          last: now,
          src: 'assistant',
        });
      }
    }

    this.touch(s, [user, judged.summary, answer].filter(Boolean).join(' '), now);
    this.maintain(s);
    this.persist(s);

    return {
      ok: true,
      session: key,
      score: Number(judged.score) || 0,
      type: judged.type || '',
      summary: judged.summary || '',
      degraded: judged.degraded || '',
      stored: Boolean(stored),
      promise: promise ? promise.text : '',
    };
  }

  // ---------------------------------------------------------------- 管理
  /** 把 L3 / L2 摊平成一张带序号表，工具里用序号或 id 指代。 */
  list(sessionId) {
    const s = this.load(sessionId);
    if (!s) return { ok: false, error: 'no session' };
    const now = Date.now();
    const l3 = this.liveL3(s, now);
    const l2 = this.liveL2(s, now);
    const rows = [];
    l3.forEach((row, index) => {
      rows.push({
        n: index + 1,
        tier: 'L3',
        id: row.id,
        text: row.text,
        type: row.type || '',
        score: Number(row.score) || 0,
        last: Number(row.last) || Number(row.ts) || 0,
        src: row.src || '',
      });
    });
    l2.forEach((row, index) => {
      rows.push({
        n: l3.length + index + 1,
        tier: 'L2',
        id: row.id,
        text: row.text,
        type: row.type || '',
        score: Number(row.score) || 0,
        last: Number(row.last) || Number(row.ts) || 0,
        src: row.src || '',
      });
    });
    return {
      ok: true,
      session: sessionId,
      dir: s.dir,
      rows,
      counts: { raw: s.l1.length, short: s.l2.length, long: s.l3.length },
      state: { lastDay: s.state.lastDay },
    };
  }

  resolveRows(sessionId, refs) {
    const s = this.load(sessionId);
    if (!s) return [];
    const now = Date.now();
    const live = [...this.liveL3(s, now), ...this.liveL2(s, now)];
    const out = [];
    for (const raw of refs) {
      const ref = textOf(raw).trim();
      if (!ref) continue;
      let hit = null;
      if (/^\d+$/.test(ref)) {
        const n = Number(ref);
        if (n >= 1 && n <= live.length && live[n - 1]) hit = live[n - 1];
      }
      if (!hit) {
        const key = norm(ref);
        hit = live.find((row) => row.id === ref || (key && norm(row.text).includes(key))) || null;
      }
      if (hit && !out.includes(hit)) out.push(hit);
    }
    return out;
  }

  #removeFrom(s, target) {
    const before = s.l2.length + s.l3.length;
    s.l2 = s.l2.filter((row) => row !== target);
    s.l3 = s.l3.filter((row) => row !== target);
    return before !== s.l2.length + s.l3.length;
  }

  add(sessionId, { text, type = '事实', score = 5 } = {}) {
    const s = this.load(sessionId);
    if (!s) return { ok: false, error: 'no session' };
    const clean = oneLine(text, 120);
    if (!clean) return { ok: false, error: 'empty text' };
    this.store.backup(path.join(s.dir, 'l3.json'));
    const now = Date.now();
    const row = upsert(s.l3, {
      id: shortId(now),
      text: clean,
      type: oneLine(type, 8) || '事实',
      kw: '',
      score: Math.min(5, Math.max(1, Number(score) || 5)),
      ts: now,
      last: now,
      src: 'manual',
    });
    this.persist(s);
    return { ok: true, row: { id: row.id, text: row.text, type: row.type, score: row.score } };
  }

  remove(sessionId, refs = []) {
    const s = this.load(sessionId);
    if (!s) return { ok: false, error: 'no session' };
    const targets = this.resolveRows(sessionId, refs);
    if (!targets.length) return { ok: false, error: '没找到要删的条目' };
    this.store.backup(path.join(s.dir, 'l2.json'));
    this.store.backup(path.join(s.dir, 'l3.json'));
    const removed = targets.filter((row) => this.#removeFrom(s, row)).map((row) => row.text);
    this.persist(s);
    return { ok: true, removed };
  }

  prune(sessionId) {
    const s = this.load(sessionId);
    if (!s) return { ok: false, error: 'no session' };
    this.store.backup(path.join(s.dir, 'l2.json'));
    this.store.backup(path.join(s.dir, 'l3.json'));
    const drop = (row) => isOneOff(row.text) && row.src !== 'manual';
    const l2Dropped = s.l2.filter(drop).length;
    const l3Dropped = s.l3.filter(drop).length;
    s.l2 = s.l2.filter((row) => !drop(row));
    s.l3 = s.l3.filter((row) => !drop(row));
    this.maintain(s, { force: false });
    this.persist(s);
    return { ok: true, l2Dropped, l3Dropped };
  }

  /** 工具：直接搜这个会话的全部记忆（不等触发词）。 */
  search(sessionId, query, { limit = 6 } = {}) {
    const s = this.load(sessionId);
    if (!s) return { ok: false, error: 'no session' };
    const key = norm(query);
    const rows = [];
    for (const [tier, list] of [
      ['L3', this.liveL3(s)],
      ['L2', this.liveL2(s)],
    ]) {
      for (const row of list) {
        const textKey = norm(row.text);
        const kwKey = norm(row.kw);
        const hit = !key || textKey.includes(key) || (kwKey && kwKey.includes(key));
        if (!hit) continue;
        rows.push({ tier, id: row.id, text: row.text, type: row.type || '', score: Number(row.score) || 0, last: Number(row.last) || 0 });
      }
    }
    const archive = searchArchive(this.store, sessionId, query, {
      limit,
      days: this.config.archiveDays,
    });
    return { ok: true, rows: rows.slice(0, limit), archive };
  }
}