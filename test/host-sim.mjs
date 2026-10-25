/**
 * 宿主仿真：自己搓一个假的 ctx / systemPrompt / tools，把 apply() 真跑一遍，
 * 再按 session/event 的顺序喂一轮问答，看注入块和工具是不是真挂上了。
 *   node test/host-sim.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { apply, name as pluginName } from '../lib/index.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-curve-host-'));

const handlers = new Map();
const disposers = [];
const sections = [];
const tools = new Map();
const effects = [];
const routes = [];

const scoped = {
  effect(fn) {
    const dispose = fn();
    effects.push(dispose);
    return dispose;
  },
  on(type, fn) {
    handlers.set(type, fn);
    const dispose = () => handlers.delete(type);
    disposers.push(dispose);
    return dispose;
  },
  inject(deps, cb) {
    cb(scoped);
    return () => {};
  },
  get() {
    return undefined;
  },
  systemPrompt: {
    section(definition) {
      sections.push(definition);
      const dispose = () => {
        const index = sections.indexOf(definition);
        if (index >= 0) sections.splice(index, 1);
      };
      disposers.push(dispose);
      return dispose;
    },
  },
  tools: {
    register(tool) {
      tools.set(tool.name, tool);
      const dispose = () => tools.delete(tool.name);
      disposers.push(dispose);
      return dispose;
    },
  },
  webServer: {
    register(route) {
      routes.push(route);
      const dispose = () => {
        const index = routes.indexOf(route);
        if (index >= 0) routes.splice(index, 1);
      };
      disposers.push(dispose);
      return dispose;
    },
  },
};

const ctx = {
  effect: scoped.effect,
  on: scoped.on,
  inject: scoped.inject,
  get: scoped.get,
};

assert.equal(pluginName, 'dsh-memory-curve');
apply(ctx, { dataDir: root, enableJudge: false });

const wait = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));
const tick = () => wait(120);

const session = { id: 'onebot-private-10001' };
const fire = (type, data) => {
  const handler = handlers.get('session/event');
  assert.ok(handler, 'session/event 没挂上');
  handler(session, { type, data });
};

const textMessage = (text, kind = 'user') => ({
  source: { kind },
  content: [{ type: 'text', text }],
});

console.log('装配');
await tick();
assert.equal(sections.length, 1, '注入段落没挂上');
assert.equal(sections[0].name, 'memory-curve');
assert.equal(typeof sections[0].text, 'function');
assert.equal(tools.size, 5, `工具数 ${tools.size}`);
console.log(`  ✓ 注入段落 1 个、工具 ${tools.size} 个`);

console.log('采集一轮');
fire('user/message', textMessage('记住，我生日在三月'));
fire('assistant/message', { message: textMessage('好，我记着，三月。', 'assistant') });
fire('turn/end', {});
await tick();

const snapshot = { agent: { session } };
const block = sections[0].text(snapshot);
assert.ok(block.includes('【长期记忆】'), block);
assert.ok(block.includes('生日'), block);
console.log('  ✓ 注入块里出现长期记忆');

console.log('插件自己的消息不该被当成用户输入');
fire('user/message', textMessage('（插件注入的提醒）', 'instructions'));
fire('turn/end', {});
await tick();
const after = sections[0].text(snapshot);
assert.ok(!after.includes('插件注入的提醒'), after);
console.log('  ✓ 非用户来源跳过');

console.log('工具');
const exec = { agent: { session } };
const listTool = tools.get('memory_curve_list');
const listed = await listTool.execute({}, exec);
assert.equal(listed.ok, true);
assert.ok(listed.rows.length >= 1);
const rendered = listTool.output.render({}, { ...listed, limit: 10 });
assert.ok(rendered[0].text.includes('生日'), rendered[0].text);

const addTool = tools.get('memory_curve_add');
const added = await addTool.execute({ text: '主人不吃香菜', type: '忌讳' }, exec);
assert.equal(added.ok, true);

const forgetTool = tools.get('memory_curve_forget');
const removed = await forgetTool.execute({ refs: '香菜' }, exec);
assert.equal(removed.ok, true);

const pruneTool = tools.get('memory_curve_prune');
const pruned = await pruneTool.execute({}, exec);
assert.equal(pruned.ok, true);
console.log('  ✓ list / add / forget / prune 都能跑');

console.log('群聊只读');
const groupSession = { id: 'onebot-group-777' };
const groupList = await listTool.execute({}, { agent: { session: groupSession } });
assert.equal(groupList.ok, true);
const groupAdd = await addTool.execute({ text: '偷偷记一笔' }, { agent: { session: groupSession } });
assert.equal(groupAdd.ok, false);
assert.ok(groupAdd.error.includes('群'), groupAdd.error);
console.log('  ✓ 群聊能看不能改');

console.log('会话销毁要清缓存');
const handler = handlers.get('session/disposed');
assert.ok(handler, 'session/disposed 没挂上');
handler(session);
console.log('  ✓ session/disposed 已处理');

console.log('设置页接口');
assert.equal(routes.length, 1, `路由数 ${routes.length}`);
assert.equal(routes[0].kind, 'prefix');
assert.equal(routes[0].path, '/api/memory-curve');
assert.equal(typeof routes[0].handler, 'function');
console.log('  ✓ /api/memory-curve 已挂到 webServer');

const webMark = JSON.parse(fs.readFileSync(path.join(root, '.boot-web.json'), 'utf8'));
assert.equal(webMark.stage, 'web-mounted');
assert.equal(webMark.path, '/api/memory-curve');
assert.equal(webMark.routes, 1);
console.log('  ✓ .boot-web.json 记下 web-mounted');

for (const dispose of disposers) dispose?.();
for (const dispose of effects) if (typeof dispose === 'function') dispose();
fs.rmSync(root, { recursive: true, force: true });
console.log('\nhost-sim 全部通过');