/**
 * dsh-memory-curve — 浏览器半端（设置里的「记忆曲线」那一项）。
 * ============================================================================
 * ⚠️ client bundle 不是 ESM，是**自注册脚本**（照 dsh-bili-subagent / dsh-meme 的约定）：
 *
 *     window.__ModuleLoader__.load({
 *       id: '<包名>',                    // 必须等于 package.json 的 name，对不上就整条不激活
 *       factory: (require) => { ... return { inject: [...], apply(ctx) {...} } },
 *     })
 *
 * 进「设置」的办法是往 slot 里注册一栏：
 *
 *     const slots = ctx.get('slots')
 *     slots.inject('settings.section', () => slots.register(
 *       { name: 'settings.section', id: 'memory-curve', order: 32, label: '记忆曲线' },
 *       () => h(Panel),
 *     ))
 *
 * 数据全走宿主侧 `/api/memory-curve/*`（lib/panel.js），页面不碰文件系统。
 * 接口地址有几条候选（相对 / 127.0.0.1 / localhost），哪条通了就记住哪条——
 * 桌面外壳有可能是 file:// 或沙箱 iframe，相对路径在那儿会直接失败。
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-memory-curve',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useMemo, useRef, useCallback } = React;

    const API_PATH = '/api/memory-curve';
    const STYLE_ID = 'mc-panel-style';

    const CSS = `
.mc-root{display:flex;flex-direction:column;gap:14px;padding:2px 2px 28px;max-width:1020px;color:inherit}
.mc-head{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.mc-logo{width:34px;height:34px;border-radius:11px;display:grid;place-items:center;font-size:17px;background:linear-gradient(145deg,rgba(79,168,216,.30),rgba(79,168,216,.06));border:1px solid rgba(79,168,216,.35)}
.mc-title{font-size:17px;font-weight:650;letter-spacing:.2px;line-height:1.2}
.mc-sub{font-size:12px;color:var(--text-secondary,#8b93a1);margin-top:2px}
.mc-spacer{flex:1}
.mc-dot{width:7px;height:7px;border-radius:50%;display:inline-block;margin-right:5px;vertical-align:1px}
.mc-stats{display:flex;gap:10px;flex-wrap:wrap}
.mc-stat{flex:1 1 0;min-width:110px;border:1px solid var(--mc-line,rgba(128,128,128,.22));border-radius:12px;padding:10px 14px;background:var(--mc-surface,rgba(128,128,128,.05))}
.mc-stat-num{font-size:20px;font-weight:650;line-height:1.15;font-variant-numeric:tabular-nums}
.mc-stat-label{font-size:11px;color:var(--text-secondary,#8b93a1);margin-top:2px}
.mc-grid{display:grid;grid-template-columns:272px minmax(0,1fr);gap:14px;align-items:start}
@media (max-width:860px){.mc-grid{grid-template-columns:1fr}}
.mc-card{border:1px solid var(--mc-line,rgba(128,128,128,.22));border-radius:12px;background:var(--mc-surface,rgba(128,128,128,.04));overflow:hidden}
.mc-card-h{display:flex;align-items:center;gap:8px;padding:10px 13px;border-bottom:1px solid var(--mc-line,rgba(128,128,128,.16));font-size:12px;color:var(--text-secondary,#8b93a1)}
.mc-slist{max-height:min(56vh,540px);overflow:auto;padding:6px}
.mc-sitem{display:flex;flex-direction:column;gap:4px;padding:8px 10px;border-radius:9px;cursor:pointer;border:1px solid transparent;transition:background .12s,border-color .12s}
.mc-sitem:hover{background:rgba(128,128,128,.10)}
.mc-sitem.on{background:rgba(79,168,216,.13);border-color:rgba(79,168,216,.42)}
.mc-sid{font-size:11.5px;font-family:ui-monospace,Consolas,"Courier New",monospace;word-break:break-all;line-height:1.35}
.mc-mini{display:flex;gap:6px;font-size:11px;color:var(--text-secondary,#8b93a1);flex-wrap:wrap}
.mc-pill{padding:1px 7px;border-radius:99px;border:1px solid var(--mc-line,rgba(128,128,128,.26));font-size:10.5px}
.mc-pill.b{color:#4fa8d8;border-color:rgba(79,168,216,.45)}
.mc-bar{display:flex;gap:8px;align-items:center;padding:10px 12px;border-bottom:1px solid var(--mc-line,rgba(128,128,128,.16));flex-wrap:wrap}
.mc-scroll{max-height:min(52vh,520px);overflow:auto}
.mc-row{display:flex;gap:10px;align-items:flex-start;padding:10px 12px;border-top:1px solid var(--mc-line,rgba(128,128,128,.13)}
.mc-row:first-child{border-top:0}
.mc-row:hover{background:rgba(128,128,128,.05)}
.mc-num{min-width:20px;text-align:right;font-size:11px;color:var(--text-secondary,#8b93a1);font-variant-numeric:tabular-nums;padding-top:2px}
.mc-tier{font-size:10px;font-weight:700;padding:1.5px 6px;border-radius:6px;letter-spacing:.4px;flex:none;margin-top:1px}
.mc-tier.L3{background:rgba(79,168,216,.18);color:#4fa8d8}
.mc-tier.L2{background:rgba(230,168,72,.20);color:#c98a2a}
.mc-body{flex:1;min-width:0}
.mc-text{font-size:13px;line-height:1.62;word-break:break-word}
.mc-meta{font-size:11px;color:var(--text-secondary,#8b93a1);display:flex;gap:7px;flex-wrap:wrap;align-items:center;margin-top:4px}
.mc-dots{display:inline-flex;gap:2px;align-items:center}
.mc-dotv{width:5px;height:5px;border-radius:50%;background:currentColor;opacity:.22}
.mc-dotv.on{opacity:.9;color:#4fa8d8}
.mc-del{opacity:0;transition:opacity .12s;border:1px solid var(--mc-line,rgba(128,128,128,.3));background:transparent;color:inherit;border-radius:7px;font-size:11px;padding:2px 8px;cursor:pointer;flex:none}
.mc-row:hover .mc-del{opacity:1}
.mc-input{width:100%;box-sizing:border-box;padding:9px 11px;border-radius:9px;border:1px solid var(--mc-line,rgba(128,128,128,.32));background:transparent;color:inherit;font:inherit;font-size:13px;resize:vertical;line-height:1.55}
.mc-input::placeholder{color:var(--text-secondary,#8b93a1);opacity:.8}
.mc-input:focus{outline:none;border-color:rgba(79,168,216,.6);box-shadow:0 0 0 3px rgba(79,168,216,.14)}
.mc-btn{padding:6px 13px;border-radius:9px;border:1px solid var(--mc-line,rgba(128,128,128,.32));background:transparent;color:inherit;font:inherit;font-size:12px;cursor:pointer;transition:border-color .12s,background .12s}
.mc-btn:hover{border-color:rgba(128,128,128,.55)}
.mc-btn:disabled{opacity:.45;cursor:default}
.mc-btn.primary{background:rgba(79,168,216,.18);border-color:rgba(79,168,216,.55)}
.mc-btn.primary:hover{background:rgba(79,168,216,.26)}
.mc-seg{display:inline-flex;border:1px solid var(--mc-line,rgba(128,128,128,.32));border-radius:9px;overflow:hidden;flex:none}
.mc-seg button{padding:6px 10px;border:0;background:transparent;color:inherit;font:inherit;font-size:12px;cursor:pointer}
.mc-seg button.on{background:rgba(79,168,216,.22)}
.mc-tabs{display:inline-flex;gap:2px;padding:2px;border-radius:10px;background:rgba(128,128,128,.10)}
.mc-tabs button{padding:4px 11px;border:0;border-radius:8px;background:transparent;color:inherit;font:inherit;font-size:12px;cursor:pointer}
.mc-tabs button.on{background:var(--mc-surface-solid,rgba(128,128,128,.22))}
.mc-empty{padding:30px 12px;text-align:center;font-size:12px;color:var(--text-secondary,#8b93a1);line-height:1.8}
.mc-toast{position:fixed;right:22px;bottom:22px;z-index:60;padding:8px 14px;border-radius:10px;font-size:12px;box-shadow:0 8px 24px rgba(0,0,0,.25);animation:mc-in .16s ease-out}
.mc-toast.bad{background:rgba(214,86,120,.95);color:#fff}
.mc-toast.ok{background:rgba(52,158,120,.95);color:#fff}
@keyframes mc-in{from{transform:translateY(6px);opacity:0}to{transform:none;opacity:1}}
.mc-err{border:1px solid rgba(224,96,126,.45);border-radius:12px;padding:12px 14px;background:rgba(224,96,126,.08);font-size:12.5px;line-height:1.75}
.mc-code{font-family:ui-monospace,Consolas,monospace;font-size:11px;color:var(--text-secondary,#8b93a1);word-break:break-all;user-select:text}
.mc-hint{font-size:11.5px;color:var(--text-secondary,#8b93a1);line-height:1.7}
`;

    function ensureStyle() {
      if (typeof document === 'undefined') return;
      if (document.getElementById(STYLE_ID)) return;
      const el = document.createElement('style');
      el.id = STYLE_ID;
      el.textContent = CSS;
      (document.head || document.documentElement).appendChild(el);
    }

    // ── 接口：几条候选地址，哪条通就记住哪条 ──────────────────────────────
    let apiBase = API_PATH;
    let apiTried = '';

    // 桌面端有可能把这一页塞进沙箱 iframe（来源是 null、`location.port` 甚至是空的），
    // 所以端口要从能拿到的地方多猜几次：自己的 location、ancestorOrigins、referrer。
    function portGuesses() {
      const ports = [];
      const add = (u) => {
        try {
          const url = new URL(String(u));
          if (url.port) ports.push(url.port);
        } catch {
          // 不是 URL 就算了
        }
      };
      if (typeof location !== 'undefined') {
        if (location.port) ports.push(location.port);
        add(location.href);
        try {
          const ancestors = location.ancestorOrigins;
          if (ancestors && ancestors.length) add(ancestors[0]);
        } catch {
          // 有些环境不给了
        }
      }
      if (typeof document !== 'undefined' && document.referrer) add(document.referrer);
      return [...new Set(ports.filter(Boolean))];
    }

    function candidates() {
      const list = [apiBase, API_PATH];
      for (const port of portGuesses()) {
        list.push(`http://127.0.0.1:${port}${API_PATH}`);
        list.push(`http://localhost:${port}${API_PATH}`);
      }
      return [...new Set(list.filter(Boolean))];
    }

    async function request(path, opts) {
      const errors = [];
      for (const base of candidates()) {
        try {
          const res = await fetch(base + path, opts);
          apiBase = base;
          apiTried = base;
          return res;
        } catch (error) {
          errors.push(`${base} → ${error && error.message ? error.message : error}`);
        }
      }
      apiTried = errors.join('；');
      throw new Error(`连不上宿主接口。试过：${apiTried}`);
    }

    async function asJson(res) {
      let body = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      if (res.ok) return body;
      const detail = body && body.error ? `：${body.error}` : '';
      throw new Error(`HTTP ${res.status}${detail}`);
    }

    const jget = (p) => request(p, { credentials: 'same-origin' }).then(asJson);
    const jpost = (p, body) =>
      request(p, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      }).then(asJson);

    // ── 小工具 ────────────────────────────────────────────────────────
    const pad = (n) => String(n).padStart(2, '0');

    function when(ts) {
      const v = Number(ts);
      if (!v) return '—';
      const d = new Date(v);
      if (Number.isNaN(d.getTime())) return '—';
      const now = Date.now();
      const diff = now - v;
      if (diff >= 0 && diff < 60_000) return '刚刚';
      if (diff >= 0 && diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
      const sameDay = new Date(now).toDateString() === d.toDateString();
      if (sameDay) return `今天 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
      return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }

    const shortSession = (id) => {
      const raw = String(id || '');
      const m = raw.match(/^([a-z]+)-(.{7})/i);
      if (raw.length <= 22) return raw;
      return m ? `${m[1]}·${m[2]}…` : `${raw.slice(0, 10)}…`;
    };

    function ScoreDots(props) {
      const score = Math.max(0, Math.min(5, Number(props.score) || 0));
      return h(
        'span',
        { className: 'mc-dots', title: `${score} 分` },
        [0, 1, 2, 3, 4].map((i) => h('span', { key: i, className: `mc-dotv${i < score ? ' on' : ''}` })),
      );
    }

    function Toast(props) {
      if (!props.toast) return null;
      return h('div', { className: `mc-toast ${props.toast.bad ? 'bad' : 'ok'}` }, props.toast.text);
    }

    // ── 面板 ──────────────────────────────────────────────────────────
    function Panel() {
      const [boot, setBoot] = useState(null);
      const [sid, setSid] = useState('');
      const [view, setView] = useState(null);
      const [tab, setTab] = useState('facts');
      const [query, setQuery] = useState('');
      const [archive, setArchive] = useState(null);
      const [draft, setDraft] = useState('');
      const [score, setScore] = useState(5);
      const [toast, setToast] = useState(null);
      const [busy, setBusy] = useState(false);
      const [loading, setLoading] = useState(true);
      const [error, setError] = useState(null);
      const timer = useRef(null);
      const taRef = useRef(null);

      useEffect(() => {
        ensureStyle();
        return () => {
          if (timer.current) clearTimeout(timer.current);
        };
      }, []);

      const say = useCallback((text, bad) => {
        setToast({ text, bad });
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setToast(null), 2800);
      }, []);

      const loadBoot = useCallback(async () => {
        setLoading(true);
        try {
          const next = await jget('/state');
          setBoot(next);
          setError(null);
          setSid((cur) => {
            if (cur && (next.sessions || []).some((s) => s.id === cur)) return cur;
            return next.sessions && next.sessions[0] ? next.sessions[0].id : '';
          });
        } catch (e) {
          setError(e && e.message ? e.message : String(e));
        } finally {
          setLoading(false);
        }
      }, []);

      const loadMemory = useCallback(
        async (id) => {
          if (!id) {
            setView(null);
            return;
          }
          try {
            setView(await jget(`/memory?sid=${encodeURIComponent(id)}`));
          } catch (e) {
            say(`读不到：${e && e.message ? e.message : e}`, true);
          }
        },
        [say],
      );

      useEffect(() => {
        loadBoot();
      }, [loadBoot]);

      useEffect(() => {
        setArchive(null);
        loadMemory(sid);
      }, [sid, loadMemory]);

      const after = async (label) => {
        await loadMemory(sid);
        await loadBoot();
        if (label) say(label);
      };

      const onAdd = async () => {
        const text = draft.trim();
        if (!text || !sid) return;
        setBusy(true);
        try {
          const r = await jpost('/add', { sid, text, score });
          if (!r || r.ok === false) throw new Error((r && r.error) || '没加进去');
          setDraft('');
          await after('记住了');
          if (taRef.current) taRef.current.focus();
        } catch (e) {
          say(`失败：${e && e.message ? e.message : e}`, true);
        } finally {
          setBusy(false);
        }
      };

      const onForget = async (n) => {
        setBusy(true);
        try {
          const r = await jpost('/forget', { sid, refs: [String(n)] });
          if (!r || r.ok === false) throw new Error((r && r.error) || '没删掉');
          await after('删掉了');
        } catch (e) {
          say(`失败：${e && e.message ? e.message : e}`, true);
        } finally {
          setBusy(false);
        }
      };

      const onPrune = async () => {
        setBusy(true);
        try {
          const r = await jpost('/prune', { sid });
          if (!r || r.ok === false) throw new Error((r && r.error) || '没清掉');
          const dropped = (Number(r.l2Dropped) || 0) + (Number(r.l3Dropped) || 0);
          await after(dropped ? `清掉 ${dropped} 条一次性任务` : '没有一次性任务可清');
        } catch (e) {
          say(`失败：${e && e.message ? e.message : e}`, true);
        } finally {
          setBusy(false);
        }
      };

      const onSearch = async () => {
        const q = query.trim();
        if (!sid || !q) return;
        setBusy(true);
        try {
          setArchive(await jget(`/search?sid=${encodeURIComponent(sid)}&q=${encodeURIComponent(q)}`));
        } catch (e) {
          say(`翻不到：${e && e.message ? e.message : e}`, true);
        } finally {
          setBusy(false);
        }
      };

      const sessions = (boot && boot.sessions) || [];
      const config = (boot && boot.config) || {};
      const rows = (view && view.rows) || [];
      const visible = useMemo(() => {
        const q = query.trim().toLowerCase();
        if (!q || tab === 'archive') return rows;
        return rows.filter((row) => String(row.text || '').toLowerCase().includes(q));
      }, [rows, query, tab]);
      const totals = useMemo(
        () =>
          sessions.reduce(
            (acc, s) => {
              acc.long += Number(s.long) || 0;
              acc.short += Number(s.short) || 0;
              acc.raw += Number(s.raw) || 0;
              return acc;
            },
            { long: 0, short: 0, raw: 0 },
          ),
        [sessions],
      );
      const current = sessions.find((s) => s.id === sid) || null;

      const stats = [
        { label: '会话', num: sessions.length },
        { label: '长期记忆', num: totals.long },
        { label: '短期记忆', num: totals.short },
        { label: '原文窗口', num: totals.raw },
      ];

      const head = h(
        'div',
        { className: 'mc-head' },
        h('div', { className: 'mc-logo' }, '🐋'),
        h(
          'div',
          null,
          h('div', { className: 'mc-title' }, '记忆曲线'),
          h('div', { className: 'mc-sub' }, 'L1 原文 → L2 短期 → L3 长期 → 全量存档'),
        ),
        h('div', { className: 'mc-spacer' }),
        h(
          'span',
          { className: 'mc-hint' },
          h('span', {
            className: 'mc-dot',
            style: { background: error ? '#d65678' : loading ? '#c98a2a' : '#34a07a' },
          }),
          error ? '接口不通' : loading ? '读着呢' : `已连上（pid ${boot && boot.pid ? boot.pid : '—'}）`,
        ),
        h(
          'button',
          {
            className: 'mc-btn',
            disabled: busy || loading,
            onClick: () => {
              loadBoot();
              loadMemory(sid);
            },
          },
          '刷新',
        ),
      );

      const errorBox = error
        ? h(
            'div',
            { className: 'mc-err' },
            h('div', { style: { fontWeight: 600, marginBottom: 4 } }, '接口不通：', error),
            h(
              'div',
              { className: 'mc-hint' },
              '面板会依次试 ',
              h('span', { className: 'mc-code' }, '/api/memory-curve'),
              ' / ',
              h('span', { className: 'mc-code' }, `127.0.0.1:${(typeof location !== 'undefined' && location.port) || '?'}`),
              ' / ',
              h('span', { className: 'mc-code' }, 'localhost'),
              ' 三条地址，全不通才报这个。宿主侧每个请求都记在 ',
              h('span', { className: 'mc-code' }, `${config.dataDir || '~/.dsh/memory-curve'}\\panel.log`),
              '，把那段发我就能定位。',
            ),
            h(
              'div',
              { style: { marginTop: 8, display: 'flex', gap: 8, alignItems: 'center' } },
              h('button', { className: 'mc-btn primary', onClick: loadBoot }, '再试一次'),
              h('span', { className: 'mc-code' }, apiTried ? `试过：${apiTried}` : ''),
            ),
          )
        : null;

      const statRow = h(
        'div',
        { className: 'mc-stats' },
        stats.map((s) =>
          h(
            'div',
            { className: 'mc-stat', key: s.label },
            h('div', { className: 'mc-stat-num' }, String(s.num)),
            h('div', { className: 'mc-stat-label' }, s.label),
          ),
        ),
      );

      const sessionCard = h(
        'div',
        { className: 'mc-card' },
        h('div', { className: 'mc-card-h' }, `会话（${sessions.length}）`),
        sessions.length === 0
          ? h('div', { className: 'mc-empty' }, '还没有记忆。', h('br'), '随便聊两句，这里就会长出东西来。')
          : h(
              'div',
              { className: 'mc-slist' },
              sessions.map((s) =>
                h(
                  'div',
                  {
                    key: s.id,
                    className: `mc-sitem${s.id === sid ? ' on' : ''}`,
                    onClick: () => setSid(s.id),
                    title: s.id,
                  },
                  h('div', { className: 'mc-sid' }, shortSession(s.id)),
                  h(
                    'div',
                    { className: 'mc-mini' },
                    h('span', { className: 'mc-pill b' }, `长期 ${s.long}`),
                    h('span', { className: 'mc-pill' }, `短期 ${s.short}`),
                    h('span', { className: 'mc-pill' }, `原文 ${s.raw}`),
                    h('span', null, when(s.updated)),
                  ),
                ),
              ),
            ),
      );

      const composer = h(
        'div',
        { className: 'mc-card' },
        h(
          'div',
          { className: 'mc-card-h' },
          '记住一条',
          h('span', { className: 'mc-spacer', style: { flex: 1 } }),
          h('span', { className: 'mc-hint' }, '直接进 L3，Ctrl+Enter 提交'),
        ),
        h(
          'div',
          { style: { padding: 12, display: 'flex', flexDirection: 'column', gap: 10 } },
          h('textarea', {
            ref: taRef,
            className: 'mc-input',
            value: draft,
            rows: 2,
            placeholder: '比如：主人讨厌别人叫他「老板」；或者：生日是 1 月 2 日',
            onChange: (e) => setDraft(e.target.value),
            onKeyDown: (e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                onAdd();
              }
            },
          }),
          h(
            'div',
            { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
            h(
              'div',
              { className: 'mc-seg' },
              [5, 4, 3].map((v) =>
                h(
                  'button',
                  { key: v, className: score === v ? 'on' : '', onClick: () => setScore(v) },
                  `${v} 分`,
                ),
              ),
            ),
            h('div', { style: { flex: 1 } }),
            h(
              'button',
              { className: 'mc-btn', disabled: busy || !sid, onClick: onPrune },
              '清掉一次性任务',
            ),
            h(
              'button',
              { className: 'mc-btn primary', disabled: busy || !draft.trim() || !sid, onClick: onAdd },
              '记住',
            ),
          ),
        ),
      );

      const hits = (archive && archive.archive) || [];
      const hitRows = (archive && archive.rows) || [];
      const listBody =
        tab === 'archive'
          ? !archive
            ? h(
                'div',
                { className: 'mc-empty' },
                '在右边的搜索框里敲个词，点「翻旧对话」去存档里找原文。',
              )
            : hits.length
              ? hits.map((hit, i) =>
                  h(
                    'div',
                    { className: 'mc-row', key: `a-${i}` },
                    h('span', { className: 'mc-num' }, String(i + 1)),
                    h('span', { className: 'mc-tier L2' }, hit.role === 'assistant' ? '我说' : '主人'),
                    h(
                      'div',
                      { className: 'mc-body' },
                      h('div', { className: 'mc-text' }, hit.text || ''),
                      h(
                        'div',
                        { className: 'mc-meta' },
                        h('span', null, hit.date || ''),
                        hit.score ? h('span', { className: 'mc-pill' }, `命中 ${hit.score}`) : null,
                      ),
                    ),
                  ),
                )
              : hitRows.length
                ? hitRows.map((row, i) =>
                    h(
                      'div',
                      { className: 'mc-row', key: `ar-${i}` },
                      h('span', { className: 'mc-num' }, String(i + 1)),
                      h('span', { className: `mc-tier ${row.tier === 'L3' ? 'L3' : 'L2'}` }, row.tier),
                      h(
                        'div',
                        { className: 'mc-body' },
                        h('div', { className: 'mc-text' }, row.text),
                        h(
                          'div',
                          { className: 'mc-meta' },
                          h(ScoreDots, { score: row.score }),
                          row.type ? h('span', { className: 'mc-pill' }, row.type) : null,
                          h('span', null, when(row.last)),
                        ),
                      ),
                    ),
                  )
                : h('div', { className: 'mc-empty' }, '条目和存档里都没翻到相关的。')
          : visible.length === 0
            ? h(
                'div',
                { className: 'mc-empty' },
                rows.length ? '这个筛选下没有条目。' : sid ? '这个会话还没攒下东西。' : '左边选一个会话。',
              )
            : visible.map((row) =>
                h(
                  'div',
                  { className: 'mc-row', key: `${row.tier}-${row.id || ''}-${row.n}` },
                  h('span', { className: 'mc-num' }, String(row.n)),
                  h('span', { className: `mc-tier ${row.tier === 'L3' ? 'L3' : 'L2'}` }, row.tier),
                  h(
                    'div',
                    { className: 'mc-body' },
                    h('div', { className: 'mc-text' }, row.text),
                    h(
                      'div',
                      { className: 'mc-meta' },
                      h(ScoreDots, { score: row.score }),
                      h('span', null, `${row.score} 分`),
                      row.type ? h('span', { className: 'mc-pill' }, row.type) : null,
                      row.src === 'manual' ? h('span', { className: 'mc-pill b' }, '手动') : null,
                      h('span', null, when(row.last)),
                    ),
                  ),
                  h(
                    'button',
                    { className: 'mc-del', disabled: busy, onClick: () => onForget(row.n) },
                    '忘掉',
                  ),
                ),
              );

      const listCard = h(
        'div',
        { className: 'mc-card' },
        h(
          'div',
          { className: 'mc-bar' },
          h(
            'div',
            { className: 'mc-tabs' },
            h(
              'button',
              { className: tab === 'facts' ? 'on' : '', onClick: () => setTab('facts') },
              `条目${rows.length ? ` ${rows.length}` : ''}`,
            ),
            h(
              'button',
              { className: tab === 'archive' ? 'on' : '', onClick: () => setTab('archive') },
              '旧对话',
            ),
          ),
          h('input', {
            className: 'mc-input',
            style: { flex: 1, minWidth: 130, padding: '6px 10px' },
            value: query,
            placeholder: tab === 'archive' ? '翻存档：生日 / 插件 / 名字…' : '筛条目…',
            onChange: (e) => setQuery(e.target.value),
            onKeyDown: (e) => {
              if (e.key === 'Enter' && tab === 'archive') onSearch();
            },
          }),
          tab === 'archive'
            ? h('button', { className: 'mc-btn', disabled: busy || !query.trim(), onClick: onSearch }, '翻旧对话')
            : null,
          h('div', { className: 'mc-spacer', style: { flex: 1 } }),
          h(
            'span',
            { className: 'mc-hint' },
            current ? `${shortSession(current.id)} · 长期 ${current.long} / 短期 ${current.short}` : '未选会话',
          ),
        ),
        h('div', { className: 'mc-scroll' }, listBody),
      );

      const footer = h(
        'div',
        { className: 'mc-hint' },
        `数据目录 ${config.dataDir || '（默认 ~/.dsh/memory-curve）'}　·　判分模型 ${config.judgeModel || '跟随会话'}　·　L3 上限 ${config.l3MaxItems ?? '—'} 条 / ${config.l3ExpireDays ?? '—'} 天　·　L2 ${config.l2ExpireHours ?? '—'} 小时过期　·　改配置去 profile 的 cordis.patch.yml，这里只读。`,
      );

      return h(
        'div',
        { className: 'mc-root' },
        head,
        errorBox,
        statRow,
        h('div', { className: 'mc-grid' }, sessionCard, h('div', { style: { display: 'flex', flexDirection: 'column', gap: 14 } }, composer, listCard)),
        footer,
        h(Toast, { toast }),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots;
        if (!slots) return;
        try {
          slots.inject('settings.section', () =>
            slots.register(
              { name: 'settings.section', id: 'memory-curve', order: 32, label: '记忆曲线' },
              () => h(Panel),
            ),
          );
        } catch {
          // 拿不到这个 slot 就静默算了，别的插件照常用
        }
      },
    };
  },
});