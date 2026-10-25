/**
 * 判分：这句话值不值得记住（0-5）。
 *
 * 原插件只有一个分支——调模型，失败就固定给 2 分。这里多做一层：
 * 模型不可用/超时/吐不出 JSON 时用本地启发式给分，避免「记忆库里全是 2 分日常」。
 */
import { STABLE_MARKS, clamp, textOf } from './lexicon.js';

export const JUDGE_SYSTEM = `你是对话重要性判定器。给你用户刚说的一句话（可能附上我上一句回复），判断它值不值得长期记住。
只输出一行严格 JSON，不要解释、不要 markdown 代码块：
{"score":4,"type":"约定","keyword":"生日","summary":"用户生日在三月"}

score 怎么给：
- 0：纯废话、单个表情、哦/嗯/哈哈
- 1：纯情绪或语气词，没有信息
- 2：日常闲聊（默认档）
- 3：有点信息量的近况、看法、聊到的事
- 4：明确的事实 / 偏好 / 约定 / 称呼 / 忌讳（名字、生日、住哪、爱吃什么、答应过什么）
- 5：用户明确要求「记住这个」的事

type 只能是：事实 / 偏好 / 约定 / 称呼 / 忌讳 / 近况 / 日常 之一。
keyword：最能代表这条记忆的一个词，没有就给空串。
summary：一句话，不超过 30 字，写「谁 / 什么」，不要复述原话，不要流水账。`;

const HINTS = [
  { re: /记住|记一下|别忘了?|不要忘/, score: 5, type: '约定' },
  { re: /我的名字|叫我|喊我/, score: 4, type: '称呼' },
  { re: /生日|出生|几月几号生/, score: 4, type: '事实' },
  { re: /住在|住在哪|老家|搬到/, score: 4, type: '事实' },
  { re: /过敏|忌口|不能吃|不吃/, score: 4, type: '忌讳' },
  { re: /讨厌|不喜欢|烦/, score: 4, type: '偏好' },
  { re: /喜欢|爱吃|最爱|迷上/, score: 4, type: '偏好' },
  { re: /习惯|每次|以后都|之后都|一律/, score: 4, type: '偏好' },
  { re: /答应|说好了?|约定|约好/, score: 4, type: '约定' },
  { re: /我是|我在|我做|我的工作|上班/, score: 3, type: '事实' },
];

export function pickJson(text) {
  const s = textOf(text);
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  const slice = s.slice(start, end + 1);
  try {
    return JSON.parse(slice);
  } catch {
    try {
      return JSON.parse(slice.replace(/,\s*([}\]])/g, '$1'));
    } catch {
      return null;
    }
  }
}

/** 本地启发式：模型不在时的兜底，也用来校验模型吐出来的离谱分数。 */
export function heuristicJudge(message) {
  const raw = textOf(message).trim();
  if (!raw) return { score: 0, type: '日常', keyword: '', summary: '' };
  const compact = raw.replace(/\s+/g, '');
  if (compact.length <= 1) return { score: 0, type: '日常', keyword: '', summary: '' };
  if (/^[哈嗯哦啊额噢嘿~。，！？!?…\s]+$/.test(compact)) return { score: 1, type: '日常', keyword: '', summary: '' };

  const hit = HINTS.find((h) => h.re.test(raw));
  if (hit) {
    const keyword = (hit.re.exec(raw)?.[0] || '').replace(/[|?()]/g, '');
    return { score: hit.score, type: hit.type, keyword, summary: raw.slice(0, 30) };
  }
  if (STABLE_MARKS.some((w) => raw.includes(w))) {
    return { score: 4, type: '偏好', keyword: '', summary: raw.slice(0, 30) };
  }
  if (compact.length >= 40) return { score: 3, type: '近况', keyword: '', summary: raw.slice(0, 30) };
  return { score: 2, type: '日常', keyword: '', summary: raw.slice(0, 30) };
}

function sanitizeJudged(parsed, fallback) {
  const score = clamp(parsed?.score, 0, 5);
  const type = textOf(parsed?.type).trim().slice(0, 8) || fallback.type;
  const keyword = textOf(parsed?.keyword).trim().slice(0, 20);
  const summary = textOf(parsed?.summary).trim().slice(0, 60) || fallback.summary;
  return { score, type, keyword, summary };
}

export function resolveSelection(ctx, modelRef) {
  const ref = textOf(modelRef).trim();
  if (ref) {
    const [provider, ...rest] = ref.split('/');
    if (provider && rest.length) return { provider, model: rest.join('/') };
  }
  try {
    const svc = ctx?.get ? ctx.get('agentDefaultModel') : undefined;
    const sel = svc?.currentSelection?.();
    if (sel && sel.provider && sel.model) return { provider: sel.provider, model: sel.model };
  } catch {
    // 拿不到默认模型就交给兜底
  }
  return null;
}

/**
 * 判一句话。永远返回一个合法判定对象；失败时 score 来自启发式，并带 degraded 标记。
 */
export async function judgeTurn(ctx, { config, message, lastReply = '', log }) {
  const fallback = heuristicJudge(message);
  if (!config?.enableJudge) return { ...fallback, degraded: 'judge-disabled' };

  const llm = ctx?.get ? ctx.get('llm') : undefined;
  if (!llm || typeof llm.stream !== 'function') return { ...fallback, degraded: 'llm-unavailable' };
  const selection = resolveSelection(ctx, config.judgeModel);
  if (!selection) return { ...fallback, degraded: 'no-model' };

  const prompt = [
    `【用户刚说的】\n${textOf(message).slice(0, 500)}`,
    lastReply ? `【我上一句回复】\n${textOf(lastReply).slice(0, 300)}` : '【我上一句回复】\n（没有）',
    '按系统要求只输出 JSON。',
  ].join('\n\n');

  const controller = new AbortController();
  let text = '';
  let failure = '';
  const timer = setTimeout(() => {
    try {
      controller.abort(new Error('judge timeout'));
    } catch {
      // 忽略
    }
  }, config.judgeTimeoutMs ?? 45_000);
  if (typeof timer.unref === 'function') timer.unref();

  try {
    const stream = llm.stream({
      provider: selection.provider,
      model: selection.model,
      system: JUDGE_SYSTEM,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }],
      temperature: 0,
      maxTokens: 200,
      signal: controller.signal,
    });
    for await (const chunk of stream) {
      if (!chunk) continue;
      if (chunk.type === 'text-delta') text += chunk.text ?? '';
      else if (chunk.type === 'finish') {
        const kind = chunk.reason?.kind;
        if (kind && kind !== 'stop' && kind !== 'length') failure = chunk.reason?.failure?.message || String(kind);
      }
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    clearTimeout(timer);
  }

  const parsed = pickJson(text);
  if (!parsed) {
    return { ...fallback, degraded: failure || 'unparseable' };
  }
  const judged = sanitizeJudged(parsed, fallback);
  return { ...judged, degraded: '' };
}