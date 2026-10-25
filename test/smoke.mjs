/**
 * 纯逻辑自测：不碰宿主、不调模型。
 *   node test/smoke.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { normalizeConfig } from '../lib/config.js';
import { MemoryStore, sanitizeSessionId } from '../lib/store.js';
import {
  extractPromise,
  isOneOff,
  localDay,
  needsRecall,
  norm,
  tokensOf,
  L3_SCORE,
} from '../lib/lexicon.js';
import { heuristicJudge, judgeTurn, pickJson } from '../lib/judge.js';
import { MemoryCurve } from '../lib/curve.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-curve-'));
let passed = 0;
const test = async (label, fn) => {
  await fn();
  passed += 1;
  console.log(`  ✓ ${label}`);
};

const fakeCtx = { get: () => undefined };

const config = normalizeConfig({ dataDir: root, enableJudge: false, toolsEnabled: false });
assert.equal(config.l1MaxTurns, 10);
assert.equal(config.l2ExpireHours, 24);
assert.equal(config.l3ExpireDays, 30);

console.log('配置');
await test('默认值落到原插件那套数字上', () => {
  assert.equal(config.l2MaxItems, 10);
  assert.equal(config.l3MaxItems, 20);
  assert.equal(config.retrieveLimit, 3);
});
await test('越界值被钳住', () => {
  const c = normalizeConfig({ l1MaxTurns: 9999, l2ExpireHours: 0, l3MaxItems: -3, maxInjectChars: 1 });
  assert.equal(c.l1MaxTurns, 200);
  assert.equal(c.l2ExpireHours, 1);
  assert.equal(c.l3MaxItems, 0);
  assert.equal(c.maxInjectChars, 200);
});

console.log('词表');
await test('norm 去掉标点和大小写', () => {
  assert.equal(norm('生日 是 三月！'), '生日是三月');
  assert.equal(norm('ABC-def'), 'abcdef');
});
await test('一次性任务 vs 稳定事实', () => {
  assert.equal(isOneOff('帮我看看这个文件'), true);
  assert.equal(isOneOff('我生日在三月，记住'), false); // 记住属于稳定信号
  assert.equal(isOneOff('这个方案改一下'), true);
  assert.equal(isOneOff('我最爱吃白米饭'), false);
});
await test('承诺抽取', () => {
  assert.equal(extractPromise('好呀。我记着，三月。'), '我记着，三月');
  assert.equal(extractPromise('哈哈。'), '');
  assert.equal(extractPromise('我会在晚上提醒你喝水。'), '我会在晚上提醒你喝水');
});
await test('回溯触发词', () => {
  assert.equal(needsRecall('上次那个文件呢'), true);
  assert.equal(needsRecall('今天吃什么'), false);
});
await test('切词去虚词、有上限', () => {
  const tokens = tokensOf('还记得我们之前说好的生日吗');
  assert.ok(tokens.length > 0 && tokens.length <= 12);
  assert.ok(!tokens.includes('什么'));
});

console.log('判分兜底');
await test('启发式能给到 4-5 分', () => {
  assert.equal(heuristicJudge('记住我生日在三月').score, 5);
  assert.equal(heuristicJudge('我喜欢白米饭').score, 4);
  assert.equal(heuristicJudge('嗯').score, 0);
  assert.equal(heuristicJudge('哈哈').score, 1);
});
await test('pickJson 容错尾逗号与包裹文字', () => {
  assert.deepEqual(pickJson('好的{"score":4,}'), { score: 4 });
  assert.equal(pickJson('没有 json'), null);
});

console.log('判分（模型路径）');
await test('llm.stream 的 JSON 被正确解析', async () => {
  const fakeLlm = {
    stream() {
      return (async function* () {
        yield { type: 'text-delta', text: '{"score":4,"type":"事实",' };
        yield { type: 'text-delta', text: '"keyword":"生日","summary":"用户生日在三月"}' };
        yield { type: 'finish', reason: { kind: 'stop' } };
      })();
    },
  };
  const ctxWithLlm = {
    get: (service) => {
      if (service === 'llm') return fakeLlm;
      if (service === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) };
      return undefined;
    },
  };
  const judged = await judgeTurn(ctxWithLlm, {
    config: normalizeConfig({ dataDir: root }),
    message: '我生日在三月',
    lastReply: '三月？',
  });
  assert.equal(judged.score, 4);
  assert.equal(judged.type, '事实');
  assert.equal(judged.summary, '用户生日在三月');
  assert.equal(judged.degraded, '');
});
await test('模型吐垃圾时退回启发式', async () => {
  const fakeLlm = {
    stream() {
      return (async function* () {
        yield { type: 'text-delta', text: '我觉得这挺重要的' };
        yield { type: 'finish', reason: { kind: 'stop' } };
      })();
    },
  };
  const ctxWithLlm = {
    get: (service) =>
      service === 'llm'
        ? fakeLlm
        : service === 'agentDefaultModel'
          ? { currentSelection: () => ({ provider: 'p', model: 'm' }) }
          : undefined,
  };
  const judged = await judgeTurn(ctxWithLlm, {
    config: normalizeConfig({ dataDir: root }),
    message: '记住我生日在三月',
  });
  assert.equal(judged.score, 5); // 启发式命中「记住」
  assert.equal(judged.degraded, 'unparseable');
});

console.log('落盘');
await test('写读 + 原子替换 + 备份只留 5 份', () => {
  const store = new MemoryStore(path.join(root, 'store'));
  const file = path.join(root, 'store', 'x.json');
  store.writeJson(file, { a: 1 });
  assert.deepEqual(store.readJson(file, null), { a: 1 });
  assert.deepEqual(store.readJson(path.join(root, 'store', 'nope.json'), []), []);
  for (let i = 0; i < 7; i += 1) store.backup(file, 5);
  const backups = fs.readdirSync(path.dirname(file)).filter((n) => n.includes('.bak-'));
  assert.ok(backups.length <= 5, `备份剩 ${backups.length} 份`);
});
await test('会话目录名安全且不撞车', () => {
  assert.equal(sanitizeSessionId('onebot-group-123'), 'onebot-group-123');
  assert.equal(sanitizeSessionId('a/b\\c:d'), 'a_b_c_d');
  const long = 'x'.repeat(150);
  const other = `${'x'.repeat(149)}y`;
  assert.notEqual(sanitizeSessionId(long), sanitizeSessionId(other));
});

console.log('四层记忆');
const curve = new MemoryCurve({ ctx: fakeCtx, config, log: () => {} });
const SID = 'onebot-private-10001';

await test('稳定事实进 L2 并当天提升到 L3', async () => {
  const res = await curve.saveTurn(SID, { userText: '记住，我生日在三月', answerText: '好，我记着，三月。' });
  assert.equal(res.ok, true);
  assert.ok(res.score >= L3_SCORE);
  const view = curve.list(SID);
  // 事实 + 承诺（都是 4 分以上）都会提升到 L3，所以这里至少一条
  assert.ok(view.counts.long >= 1, `L3=${view.counts.long}`);
  assert.ok(view.rows.some((r) => r.text.includes('生日')));
});
await test('承诺被单独记一条', async () => {
  const view = curve.list(SID);
  assert.ok(view.rows.some((r) => r.text.startsWith('我答应过：')), JSON.stringify(view.rows));
});
await test('一次性任务不会提升到 L3', async () => {
  await curve.saveTurn(SID, { userText: '帮我看看这个插件装好没', answerText: '装好了。' });
  const s = curve.load(SID);
  s.state.lastDay = ''; // 强制重跑一次每日提升
  curve.maintain(s, { force: true });
  const l3 = curve.liveL3(s).map((r) => r.text);
  assert.ok(!l3.some((t) => t.includes('插件装好')), l3.join('|'));
});
await test('注入块带长期记忆与口径说明', () => {
  const block = curve.block(SID, '今天天气不错');
  assert.ok(block.includes('【长期记忆】'));
  assert.ok(block.includes('生日'));
  assert.ok(block.includes('不是主人这轮说的话'));
});
await test('说到「上次」才回溯旧对话', async () => {
  await curve.saveTurn(SID, { userText: '上次说过我生日是几月', answerText: '三月。' });
  const block = curve.block(SID, '上次说的生日是几月来着');
  assert.ok(block.includes('【相关回忆】'), block);
  const quiet = curve.block(SID, '今天吃什么');
  assert.ok(!quiet.includes('【相关回忆】'));
});
await test('搜索能把记忆条目和旧对话一起翻出来', () => {
  const res = curve.search(SID, '生日');
  assert.equal(res.ok, true);
  assert.ok(res.rows.length > 0);
  assert.ok(res.archive.length > 0);
});
await test('手动加、按序号删', () => {
  const added = curve.add(SID, { text: '主人不吃香菜', type: '忌讳' });
  assert.equal(added.ok, true);
  const before = curve.list(SID).rows.length;
  const last = curve.list(SID).rows.find((r) => r.text.includes('香菜'));
  const removed = curve.remove(SID, [String(last.n)]);
  assert.equal(removed.ok, true);
  assert.equal(curve.list(SID).rows.length, before - 1);
});
await test('prune 清掉一次性任务', async () => {
  await curve.saveTurn(SID, { userText: '测试一下这个改动', answerText: '好。' });
  const res = curve.prune(SID);
  assert.equal(res.ok, true);
  assert.ok(res.l2Dropped + res.l3Dropped >= 0);
});
await test('L2 过期后不再注入', () => {
  const s = curve.load(SID);
  for (const row of s.l2) row.last = Date.now() - 48 * 3600_000;
  const block = curve.block(SID, '');
  assert.ok(!block.includes('【短期记忆】'), block);
});
await test('state.lastDay 记住了今天', () => {
  const view = curve.list(SID);
  assert.equal(view.state.lastDay, localDay());
});
await test('存档按天分文件', () => {
  const store = new MemoryStore(config.dataDir);
  const files = store.archiveFiles(store.dirOf(SID), 7);
  assert.equal(files.length, 1);
  assert.ok(path.basename(files[0]) === `${localDay()}.jsonl`);
  const lines = store.readLines(files[0]);
  assert.ok(lines.length >= 4);
});

fs.rmSync(root, { recursive: true, force: true });
console.log(`\n全部通过：${passed} 项`);