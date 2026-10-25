/**
 * 配置：字段名沿用原插件（l1MaxTurns / l2ExpireHours / l3ExpireDays …），
 * 方便对照 main.py 的 _conf_schema.json；新增的只有 DSH 侧才需要的几项。
 */
import os from 'node:os';
import path from 'node:path';
import { clamp, textOf } from './lexicon.js';

export const DEFAULTS = {
  enabled: true,
  dataDir: '',
  /** 'provider/model'；空 = 用宿主当前的默认模型 */
  judgeModel: '',
  enableJudge: true,
  judgeTimeoutMs: 45_000,
  /** L1 保留多少轮（一轮 = 用户一句 + 我一句），文件里存 4 倍 */
  l1MaxTurns: 10,
  l2ExpireHours: 24,
  l2MaxItems: 10,
  l3ExpireDays: 30,
  l3MaxItems: 20,
  /** 一次最多回溯几条旧对话 */
  retrieveLimit: 3,
  /** 回溯时翻最近几个 archive 文件 */
  archiveDays: 7,
  /** 注入块最大字符数 */
  maxInjectChars: 1800,
  /** 额外的备注，拼在记忆块末尾 */
  memoryBias: '',
  toolsEnabled: true,
  /** 群聊里也允许改记忆？默认只认本地会话和私聊 */
  allowGroupEdit: false,
};

function num(value, fallback, min, max) {
  if (value === undefined || value === null || value === '') return fallback;
  return clamp(value, min, max);
}

function bool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (['false', '0', 'no', 'off', '关'].includes(v)) return false;
    if (['true', '1', 'yes', 'on', '开'].includes(v)) return true;
  }
  return Boolean(value);
}

function expandDir(value) {
  const raw = textOf(value).trim();
  if (!raw) return path.join(os.homedir(), '.dsh', 'memory-curve');
  if (raw === '~') return os.homedir();
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return path.join(os.homedir(), raw.slice(2));
  return path.resolve(raw);
}

export function normalizeConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: bool(src.enabled, DEFAULTS.enabled),
    dataDir: expandDir(src.dataDir ?? DEFAULTS.dataDir),
    judgeModel: textOf(src.judgeModel ?? DEFAULTS.judgeModel).trim(),
    enableJudge: bool(src.enableJudge, DEFAULTS.enableJudge),
    judgeTimeoutMs: num(src.judgeTimeoutMs, DEFAULTS.judgeTimeoutMs, 3_000, 180_000),
    l1MaxTurns: num(src.l1MaxTurns, DEFAULTS.l1MaxTurns, 0, 200),
    l2ExpireHours: num(src.l2ExpireHours, DEFAULTS.l2ExpireHours, 1, 24 * 90),
    l2MaxItems: num(src.l2MaxItems, DEFAULTS.l2MaxItems, 0, 200),
    l3ExpireDays: num(src.l3ExpireDays, DEFAULTS.l3ExpireDays, 1, 3650),
    l3MaxItems: num(src.l3MaxItems, DEFAULTS.l3MaxItems, 0, 500),
    retrieveLimit: num(src.retrieveLimit, DEFAULTS.retrieveLimit, 0, 20),
    archiveDays: num(src.archiveDays, DEFAULTS.archiveDays, 1, 90),
    maxInjectChars: num(src.maxInjectChars, DEFAULTS.maxInjectChars, 200, 20_000),
    memoryBias: textOf(src.memoryBias ?? DEFAULTS.memoryBias).trim(),
    toolsEnabled: bool(src.toolsEnabled, DEFAULTS.toolsEnabled),
    allowGroupEdit: bool(src.allowGroupEdit, DEFAULTS.allowGroupEdit),
  };
}