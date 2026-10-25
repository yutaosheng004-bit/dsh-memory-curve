/**
 * 设置页「记忆曲线」的后端接口。
 *
 * 页面本身在 `client.js`（浏览器半端，走 slots 的 settings.section 那一栏），
 * 这里只提供数据：列会话、读某会话的 L2/L3、手动加一条、删几条、清理一次性任务。
 *
 * 安全：只认回环地址；来源只挡真正的跨站（别的网站/别的端口）。
 * 桌面端有可能是 `file://` 外壳或沙箱 iframe（来源是 `null`），那种情况要放行，
 * 否则页面里一切 fetch 都 403，看起来就是「接口不通」。挡不住本机恶意进程，
 * 但挡住远程页面。一切写操作都经过 MemoryCurve 自己的方法，所以备份、去重、过期照旧生效。
 *
 * 排查：每个请求都往 `<dataDir>/panel.log` 记一行（方法、路径、来的头、判决、耗时）。
 * 面板要是再喊「接口不通」，先看这个文件。
 */
import fs from 'node:fs';
import path from 'node:path';

const BASE = '/api/memory-curve';
const MAX_BODY = 256 * 1024;
const LOG_MAX = 256 * 1024;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function sendJson(res, code, value) {
  const body = JSON.stringify(value);
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch {
        reject(new Error('请求体不是 JSON'));
      }
    });
    req.on('error', reject);
  });
}

/** 这一页是从哪来的：真同源 / 本机 null 来源（file:// 或沙箱 iframe）/ 别的站。 */
export function originKind(req) {
  const origin = req.headers?.origin;
  if (!origin) return 'same-origin';
  if (origin === 'null') return 'opaque';
  try {
    const u = new URL(origin);
    return LOOPBACK.has(u.hostname) ? 'loopback' : 'remote';
  } catch {
    return 'opaque';
  }
}

/** 回环 + 只要不是真外站就放行（null 来源可能是桌面外壳，不能打死）。 */
export function trustedRequest(req) {
  const host = String(req.headers?.host || '');
  const hostname = host.split(':')[0];
  if (hostname && !LOOPBACK.has(hostname)) return false;
  return originKind(req) !== 'remote';
}

/** 给跨来源的页面补 CORS 头；同源请求带了也无害。 */
function applyCors(req, res) {
  const kind = originKind(req);
  if (kind === 'remote') return;
  const origin = req.headers?.origin;
  if (kind === 'opaque') {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.setHeader('Access-Control-Max-Age', '600');
}

/** 请求流水账，落到 `<dataDir>/panel.log`，超了就砍掉前一半。 */
function makeRequestLog(dataDir) {
  const file = dataDir ? path.join(dataDir, 'panel.log') : '';
  return (line) => {
    if (!file) return;
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
      const size = fs.statSync(file).size;
      if (size > LOG_MAX) {
        const text = fs.readFileSync(file, 'utf8');
        fs.writeFileSync(file, text.slice(-Math.floor(LOG_MAX / 2)), 'utf8');
      }
    } catch {
      // 日志写不进去就算了，不能因为这个把接口带崩
    }
  };
}

const countOf = (value) => (Array.isArray(value) ? value.length : 0);

/** 扫 dataDir 下每个会话目录，给设置页一个列表。只读文件，不动缓存。 */
export function listSessions(service) {
  const root = service.config?.dataDir;
  if (!root) return [];
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    const dir = path.join(root, entry.name);
    const l1 = service.store.readJson(path.join(dir, 'l1.json'), []);
    const l2 = service.store.readJson(path.join(dir, 'l2.json'), []);
    const l3 = service.store.readJson(path.join(dir, 'l3.json'), []);
    const rows = [...(Array.isArray(l2) ? l2 : []), ...(Array.isArray(l3) ? l3 : [])];
    if (!countOf(l1) && !rows.length) continue;
    let updated = 0;
    for (const row of rows) {
      const at = Number(row?.last) || Number(row?.ts) || 0;
      if (at > updated) updated = at;
    }
    if (!updated) {
      try {
        updated = Math.round(fs.statSync(dir).mtimeMs);
      } catch {
        updated = 0;
      }
    }
    out.push({
      id: entry.name,
      raw: countOf(l1),
      short: countOf(l2),
      long: countOf(l3),
      updated,
    });
  }
  out.sort((a, b) => b.updated - a.updated);
  return out;
}

function publicConfig(config) {
  return {
    dataDir: config.dataDir,
    enabled: config.enabled,
    enableJudge: config.enableJudge,
    judgeModel: config.judgeModel || '（跟随当前会话模型）',
    l1MaxTurns: config.l1MaxTurns,
    l2MaxItems: config.l2MaxItems,
    l2ExpireHours: config.l2ExpireHours,
    l3MaxItems: config.l3MaxItems,
    l3ExpireDays: config.l3ExpireDays,
    retrieveLimit: config.retrieveLimit,
    archiveDays: config.archiveDays,
    allowGroupEdit: config.allowGroupEdit,
  };
}

/** 挂路由。返回 disposer 数组，调用方负责在 effect 里收尾。 */
export function registerPanel(ctx, service, log = () => {}, meta = {}) {
  const startedAt = Date.now();
  const requestLog = makeRequestLog(service.config?.dataDir);
  meta.startedAt = startedAt;
  meta.routes = 0;

  const route = async (req, res) => {
    applyCors(req, res);

    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const sub = url.pathname.slice(BASE.length) || '/';
    const config = service.config;

    if (req.method === 'GET' && sub === '/ping') {
      sendJson(res, 200, {
        ok: true,
        pid: process.pid,
        base: BASE,
        upMs: Date.now() - startedAt,
        dataDir: config?.dataDir || '',
      });
      return;
    }

    if (req.method === 'GET' && (sub === '/' || sub === '/state')) {
      const sessions = listSessions(service);
      sendJson(res, 200, {
        ok: true,
        pid: process.pid,
        upMs: Date.now() - startedAt,
        config: publicConfig(config),
        sessions,
        hint: '这里改了就是真的改了：写入走的是同一套逻辑，删改前会自动备份。',
      });
      return;
    }

    if (req.method === 'GET' && sub === '/memory') {
      const sid = String(url.searchParams.get('sid') || '').trim();
      if (!sid) {
        sendJson(res, 400, { ok: false, error: '缺少 sid' });
        return;
      }
      sendJson(res, 200, service.list(sid));
      return;
    }

    if (req.method === 'GET' && sub === '/search') {
      const sid = String(url.searchParams.get('sid') || '').trim();
      const query = String(url.searchParams.get('q') || '').trim();
      if (!sid) {
        sendJson(res, 400, { ok: false, error: '缺少 sid' });
        return;
      }
      sendJson(res, 200, service.search(sid, query, { limit: 20 }));
      return;
    }

    if (req.method === 'POST' && sub === '/add') {
      const body = await readBody(req);
      const sid = String(body.sid || '').trim();
      if (!sid) {
        sendJson(res, 400, { ok: false, error: '缺少 sid' });
        return;
      }
      sendJson(res, 200, service.add(sid, {
        text: String(body.text || ''),
        type: String(body.type || '事实'),
        score: Number(body.score) || 5,
      }));
      return;
    }

    if (req.method === 'POST' && sub === '/forget') {
      const body = await readBody(req);
      const sid = String(body.sid || '').trim();
      const refs = Array.isArray(body.refs) ? body.refs.map(String) : [];
      if (!sid || !refs.length) {
        sendJson(res, 400, { ok: false, error: '缺少 sid 或 refs' });
        return;
      }
      sendJson(res, 200, service.remove(sid, refs));
      return;
    }

    if (req.method === 'POST' && sub === '/prune') {
      const body = await readBody(req);
      const sid = String(body.sid || '').trim();
      if (!sid) {
        sendJson(res, 400, { ok: false, error: '缺少 sid' });
        return;
      }
      sendJson(res, 200, service.prune(sid));
      return;
    }

    sendJson(res, 404, { ok: false, error: `没有这个接口：${sub}` });
  };

  const handler = async (req, res) => {
    const began = Date.now();
    const trusted = trustedRequest(req);
    const stamp = () => {
      const origin = req.headers?.origin || '-';
      const site = req.headers?.['sec-fetch-site'] || '-';
      const host = req.headers?.host || '-';
      const verdict = trusted ? (res.statusCode || 200) : 403;
      requestLog(
        `${req.method} ${req.url} -> ${verdict} (${Date.now() - began}ms) host=${host} origin=${origin} kind=${originKind(req)} sfs=${site}`,
      );
    };

    if (!trusted) {
      sendJson(res, 403, { ok: false, error: '只接受本机请求（跨站已拒绝）' });
      stamp();
      return;
    }
    try {
      await route(req, res);
      stamp();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log('warn', `面板接口出错：${message}`);
      try {
        sendJson(res, 500, { ok: false, error: message });
      } catch {
        // res 可能已经发出去了
      }
      stamp();
    }
  };

  const disposers = [];
  const register = (kind, p) => {
    meta.routes += 1;
    meta.lastPath = `${kind} ${p}`;
    try {
      const result = ctx.webServer.register({ kind, path: p, handler });
      if (typeof result === 'function') {
        disposers.push(result);
      } else if (result && typeof result.then === 'function') {
        result
          .then((dispose) => {
            if (typeof dispose === 'function') disposers.push(dispose);
          })
          .catch((error) => {
            log('warn', `面板路由收尾失败（${kind} ${p}）：${error instanceof Error ? error.message : error}`);
          });
      }
      return true;
    } catch (error) {
      meta.error = error instanceof Error ? error.message : String(error);
      log('warn', `面板路由没挂上（${kind} ${p}）：${meta.error}`);
      return false;
    }
  };

  // 主路：前缀。挂不上就退回逐条 exact（老版本宿主只认 exact）。
  const mounted = register('prefix', BASE);
  meta.mounted = mounted;
  if (!mounted) {
    for (const p of ['/state', '/memory', '/search', '/add', '/forget', '/prune', '/ping']) {
      register('exact', `${BASE}${p}`);
    }
  }

  return disposers;
}

export { BASE as PANEL_BASE };