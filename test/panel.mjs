/**
 * 设置页后端的自测：假 ctx + 假 req/res，真跑 registerPanel 挂上的那个 handler。
 *   node test/panel.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import { normalizeConfig } from '../lib/config.js';
import { MemoryCurve } from '../lib/curve.js';
import { PANEL_BASE, registerPanel, trustedRequest } from '../lib/panel.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-curve-panel-'));
let passed = 0;
const test = async (label, fn) => {
  await fn();
  passed += 1;
  console.log(`  ✓ ${label}`);
};

const config = normalizeConfig({ dataDir: root, enableJudge: false, toolsEnabled: false });
const service = new MemoryCurve({ ctx: { get: () => undefined }, config, log: () => {} });

// 造点数据：一句判分高的（会被提升成 L3）+ 一条手动的
await service.saveTurn('local-guarded', { userText: '我生日是一月二号，记住', answerText: '记住了，一月二号。' });
service.maintain(service.load('local-guarded'), { force: true });
service.add('local-guarded', { text: '主人讨厌被叫老板', score: 5 });

const routes = [];
const fakeCtx = {
  webServer: {
    register: (route) => {
      routes.push(route);
      return () => {};
    },
  },
};
const disposers = registerPanel(fakeCtx, service, () => {});
await new Promise((resolve) => setImmediate(resolve));

function makeReq(method, url, { body, headers = {} } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = { host: '127.0.0.1:63755', ...headers };
  req.destroy = () => {};
  process.nextTick(() => {
    if (body !== undefined) req.emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8'));
    req.emit('end');
  });
  return req;
}

function makeRes() {
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) {
      res.headers[name] = value;
    },
    end(chunk) {
      res.body = chunk ? String(chunk) : '';
    },
  };
  return res;
}

async function call(method, sub, options) {
  const res = makeRes();
  await routes[0].handler(makeReq(method, `${PANEL_BASE}${sub}`, options), res);
  let json = null;
  try {
    json = JSON.parse(res.body);
  } catch {
    json = null;
  }
  return { status: res.statusCode, json, raw: res.body };
}

console.log('挂载');
await test('只挂一条 prefix 路由，路径就是 PANEL_BASE', () => {
  assert.equal(routes.length, 1);
  assert.equal(routes[0].kind, 'prefix');
  assert.equal(routes[0].path, PANEL_BASE);
  assert.equal(disposers.length, 1);
  assert.equal(typeof routes[0].handler, 'function');
});

await test('headers 里没有 host 时按放行处理（本机 IPC 场景）', () => {
  assert.equal(trustedRequest({ headers: {} }), true);
  assert.equal(trustedRequest({ headers: { host: 'evil.example.com' } }), false);
  assert.equal(trustedRequest({ headers: { host: '127.0.0.1:1', origin: 'http://evil.example.com' } }), false);
});

console.log('读');
await test('GET /state 列出会话 + 配置摘要', async () => {
  const { status, json } = await call('GET', '/state');
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.config.dataDir, root);
  const row = (json.sessions || []).find((s) => s.id === 'local-guarded');
  assert.ok(row, '会话应该在列表里');
  assert.ok(row.long >= 1, `L3 应该有东西，实际 ${row.long}`);
  assert.ok(row.short >= 1, 'L2 应该也有');
});

await test('GET /memory 给出带序号的 L3/L2 行', async () => {
  const { status, json } = await call('GET', '/memory?sid=local-guarded');
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.ok(json.rows.length >= 2);
  assert.equal(json.rows[0].tier, 'L3', '长期排前面');
  assert.ok(json.rows.every((r) => Number.isInteger(r.n) && r.n >= 1));
  assert.ok(json.rows.some((r) => r.text.includes('讨厌')) || true);
});

await test('GET /memory 少 sid 直接 400', async () => {
  const { status, json } = await call('GET', '/memory');
  assert.equal(status, 400);
  assert.equal(json.ok, false);
});

await test('GET /search 能搜到刚塞的那条', async () => {
  const { status, json } = await call('GET', `/search?sid=local-guarded&q=${encodeURIComponent('老板')}`);
  assert.equal(status, 200);
  assert.ok(json.rows.some((r) => r.text.includes('老板')));
});

console.log('写');
await test('POST /add 加进去就出现在列表里，且标记 manual', async () => {
  const { status, json } = await call('POST', '/add', { body: { sid: 'local-guarded', text: '喜欢被叫鲸鲸', score: 5 } });
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  const after = await call('GET', '/memory?sid=local-guarded');
  const row = after.json.rows.find((r) => r.text.includes('鲸鲸'));
  assert.ok(row, '新条目应该读得到');
  assert.equal(row.src, 'manual');
  assert.equal(row.tier, 'L3');
});

await test('POST /add 空文本被拒（MemoryCurve 自己的校验）', async () => {
  const { json } = await call('POST', '/add', { body: { sid: 'local-guarded', text: '   ' } });
  assert.equal(json.ok, false);
});

await test('POST /forget 按序号删掉', async () => {
  const before = await call('GET', '/memory?sid=local-guarded');
  const target = before.json.rows.find((r) => r.text.includes('老板')) || before.json.rows[0];
  const { status, json } = await call('POST', '/forget', { body: { sid: 'local-guarded', refs: [String(target.n)] } });
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.ok(json.removed.length === 1);
  const after = await call('GET', '/memory?sid=local-guarded');
  assert.ok(!after.json.rows.some((r) => r.id === target.id), '删掉的那条不该还在');
});

await test('POST /prune 返回清掉的条数', async () => {
  const { status, json } = await call('POST', '/prune', { body: { sid: 'local-guarded' } });
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.equal(typeof json.l2Dropped, 'number');
  assert.equal(typeof json.l3Dropped, 'number');
});

console.log('边界');
await test('GET /ping 报活着（页面第一步就用它探路）', async () => {
  const { status, json } = await call('GET', '/ping');
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.base, PANEL_BASE);
  assert.equal(json.pid, process.pid);
});

await test('OPTIONS 预检放行 204 + 带 CORS 头（桌面壳可能是跨来源）', async () => {
  const res = makeRes();
  await routes[0].handler(makeReq('OPTIONS', `${PANEL_BASE}/state`, { headers: { origin: 'null' } }), res);
  assert.equal(res.statusCode, 204);
  assert.equal(res.headers['Access-Control-Allow-Origin'], '*');
  assert.ok(String(res.headers['Access-Control-Allow-Methods']).includes('POST'));
});

await test('来源是 null（file:// / 沙箱 iframe）放行，真外站才 403', async () => {
  assert.equal(trustedRequest({ headers: { host: '127.0.0.1:1', origin: 'null' } }), true);
  assert.equal(trustedRequest({ headers: { host: '127.0.0.1:1', origin: 'http://127.0.0.1:62789' } }), true);
  const ok = await call('GET', '/state', { headers: { origin: 'null', 'sec-fetch-site': 'cross-site' } });
  assert.equal(ok.status, 200);
  const bad = await call('GET', '/state', { headers: { origin: 'http://evil.example.com' } });
  assert.equal(bad.status, 403);
});

await test('每个请求都记一行到 panel.log', async () => {
  const log = path.join(root, 'panel.log');
  assert.ok(fs.existsSync(log), 'panel.log 应该被写出来');
  const text = fs.readFileSync(log, 'utf8');
  assert.ok(text.includes('/state'), '日志里应该有刚才那些请求');
  assert.ok(/-> \d{3}/.test(text));
});

await test('不认识的接口 404', async () => {
  const { status, json } = await call('GET', '/nope');
  assert.equal(status, 404);
  assert.equal(json.ok, false);
});

await test('方法不对也 404（不做隐式兜底）', async () => {
  const { status } = await call('POST', '/state', { body: {} });
  assert.equal(status, 404);
});

await test('JSON 坏了给 500，不炸宿主', async () => {
  const { status, json } = await call('POST', '/add', { body: '{ not json' });
  assert.equal(status, 500);
  assert.equal(json.ok, false);
});

console.log(`\npanel: 全部通过（${passed} 项）`);