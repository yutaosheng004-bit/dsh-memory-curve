/**
 * 词表和纯函数：全都从 astrbot_plugin_memory_curve 的 main.py 搬过来，
 * 只把 Python 的写法换成等价的 JS，行为（命中/去重/切词）保持一致。
 */

/** 触发「翻旧账」的说法。只在这些词出现时才去 archive 里回溯。 */
export const RECALL_WORDS = ['之前', '上次', '那天', '还记得', '我们说过', '以前', '那事', '那个事', '记不记得'];

/** 切词时丢掉的虚词。 */
export const STOP_WORDS = new Set(['什么', '怎么', '我们', '你们', '这个', '那个', '一下', '还是', '就是', '记得']);

/** 一次性任务的信号词：光有这些，说明是「这一刻要做的事」。 */
export const ONEOFF_MARKS = [
  '检查', '看看', '看一下', '重新加载', '重载', '修', '改', '跑一遍', '试一下', '重跑',
  '回顾', '整理', '测试', '移出', '移出去', '删', '装', '下载', '贴', '发出去', '移走',
  '接下来', '下一步', '确认一下', '算一下', '报一下', '汇报', '写完', '做完',
];

/** 稳定事实的信号词：沾了这些就永远不算一次性任务。 */
export const STABLE_MARKS = [
  '喜欢', '讨厌', '最爱', '爱吃', '不吃', '忌口', '过敏', '生日', '名字', '叫我', '叫',
  '住', '习惯', '每次', '以后', '之后都', '偏好', '重要', '记住', '怕', '不要', '别',
  '必须', '一律', '从来', '一直',
];

/** 我这边的承诺信号词。 */
export const PROMISE_WORDS = [
  '我会', '我帮你', '我记着', '我记得', '提醒你', '提醒我', '答应',
  '明天', '后天', '下次', '待会', '之后我', '一会儿', '回头我',
];

/** 判分器认为「值得进 L3」的分数门槛。 */
export const L3_SCORE = 4;
/** 判分器认为「值得进 L2」的分数门槛。 */
export const L2_SCORE = 2;

export function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

export function textOf(value) {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

/** 去重键：只留字母数字和汉字，小写。 */
export function norm(value) {
  return textOf(value).toLowerCase().replace(/[^0-9a-z\u4e00-\u9fa5]/g, '');
}

/** 一次性任务判定：命中 ONEOFF 且一个 STABLE 都没有。 */
export function isOneOff(text) {
  const raw = textOf(text);
  if (!raw) return false;
  if (STABLE_MARKS.some((word) => raw.includes(word))) return false;
  return ONEOFF_MARKS.some((word) => raw.includes(word));
}

export function needsRecall(text) {
  const raw = textOf(text);
  return RECALL_WORDS.some((word) => raw.includes(word));
}

/**
 * 切词：中文按 2-3 字 n-gram，英文/数字按整段；去掉虚词，最多 12 个。
 * 关键词（判分器给的那个）优先排在最前面。
 */
export function tokensOf(text, keyword = '') {
  const raw = textOf(text);
  const out = [];
  const push = (word) => {
    const w = textOf(word).trim();
    if (!w || w.length < 2) return;
    if (STOP_WORDS.has(w)) return;
    if (!out.includes(w)) out.push(w);
  };
  push(keyword);
  for (const chunk of raw.split(/[^0-9a-zA-Z\u4e00-\u9fa5]+/)) {
    if (!chunk) continue;
    if (/^[0-9a-zA-Z]+$/.test(chunk)) {
      push(chunk);
      continue;
    }
    for (const size of [3, 2]) {
      for (let i = 0; i + size <= chunk.length && i < 40; i += 1) push(chunk.slice(i, i + size));
    }
  }
  return out.slice(0, 12);
}

/** 从我的回复里挑出承诺句：4-40 字、含「我」、含承诺词。 */
export function extractPromise(answer) {
  const raw = textOf(answer);
  if (!raw) return '';
  const sentences = raw.split(/[。！？!?\n；;]/).map((s) => s.trim()).filter(Boolean);
  for (const sentence of sentences) {
    const s = sentence.replace(/^[，,、\s]+/, '');
    if (s.length < 4 || s.length > 40) continue;
    if (!s.includes('我')) continue;
    if (!PROMISE_WORDS.some((word) => s.includes(word))) continue;
    return s;
  }
  return '';
}

/** 本地日期 YYYY-MM-DD（按机器时区，跟着主人走）。 */
export function localDay(ts = Date.now()) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function shortId(ts = Date.now()) {
  return `${ts.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}