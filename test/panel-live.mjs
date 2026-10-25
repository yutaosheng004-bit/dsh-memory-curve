/**
 * 真 HTTP 端到端自测：不开宿主，用 node:http 起一个真服务器，
 * 把 registerPanel 挂上的 handler 原样接上去，然后用真请求打。
 * 目的是复现并锁死「设置页来源为 null 时被自己人 403」那个坑。
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { MemoryCurve } from '../lib/curve.js';
import { PANEL_BASE, registerPanel } from '../lib/panel.js';
import { normalizeConfig } from '../lib/config.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-live-'));
const config = normalizeConfig({ dataDir, enableJudge: false, l1MaxTurns: 10 });
const sessions = { list: () => [] };
const service = new MemoryCurve({ ctx: { get: () => sessions }, config, log: () => {} });

const routes = [];
const fakeCtx = { webServer: { register: (route) => { routes.push(route); return () => {}; } } };
registerPanel(fakeCtx, service, () => {});
assert.equal(routes.length, 1, '应该只挂一条 prefix 路由');

const route = routes[0];
const server = http.createServer((req, res) => {
  if (!req.url.startsWith(PANEL_BASE)) {
    res.writeHead(404).end('nope');
    return;
  }
  route.handler(req, res);
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const base = `http://127.0.0.1:${port}${PANEL_BASE}`;

let pass = 0;
function ok(cond, label) {
  assert.ok(cond, label);
  pass += 1;
  console.log(`  ✓ ${label}`);
}

// 1. 设置页那种来源为 null 的 GET：以前会被 trustedRequest 判成跨站 → 403
const r1 = await fetch(`${base}/ping`, { headers: { Origin: 'null', 'Sec-Fetch-Site': 'cross-site' } });
const j1 = await r1.json();
ok(r1.status === 200, 'Origin: null 的 GET 放行（200）');
ok(j1.ok === true && j1.base === PANEL_BASE, '/ping 回 ok 与 base');
ok(r1.headers.get('access-control-allow-origin') === '*', '带了 ACAO * 让 null 来源能读响应');
ok(r1.headers.get('cache-control') === 'no-store', '响应不缓存');

// 2. 预检：null 来源的 POST 会先发 OPTIONS
const r2 = await fetch(`${base}/add`, {
  method: 'OPTIONS',
  headers: { Origin: 'null', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
});
ok(r2.status === 204, '预检 204');
ok((r2.headers.get('access-control-allow-methods') || '').includes('POST'), '预检允许 POST');
ok((r2.headers.get('access-control-allow-headers') || '').toLowerCase().includes('content-type'), '预检允许 content-type');

// 3. null 来源真写入
const sid = 'session-live-test';
const r3 = await fetch(`${base}/add`, {
  method: 'POST',
  headers: { Origin: 'null', 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' },
  body: JSON.stringify({ sid, text: '面板写进来的一条', type: '事实', score: 5 }),
});
const j3 = await r3.json();
ok(r3.status === 200 && j3.ok === true, 'null 来源的 POST 能写进去');

const r4 = await fetch(`${base}/memory?sid=${encodeURIComponent(sid)}`, { headers: { Origin: 'null' } });
const j4 = await r4.json();
ok(r4.status === 200 && JSON.stringify(j4.rows || {}).includes('面板写进来的一条'), '写进去的立刻能在列表里看到');

// 4. 真的外站还是要挡
const r5 = await fetch(`${base}/state`, { headers: { Origin: 'https://evil.example.com' } });
ok(r5.status === 403, '真外站来源仍 403');

// 5. 观测：每个请求都该落一行日志
const logPath = path.join(dataDir, 'panel.log');
const logText = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
ok(logText.split('\n').filter(Boolean).length >= 5, 'panel.log 记下了每个请求');
ok(logText.includes('kind=opaque'), '日志标出了来源种类（opaque）');
ok(logText.includes('kind=remote'), '日志标出了来源种类（remote）');
ok(logText.includes('200') && logText.includes('403'), '日志里有成功也有被拒的判决');

server.close();
fs.rmSync(dataDir, { recursive: true, force: true });
console.log(`\npanel-live: 全部通过（${pass} 项）`);