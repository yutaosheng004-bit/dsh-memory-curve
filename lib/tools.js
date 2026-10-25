/**
 * 给模型用的工具：memory_curve_*。
 * 读的四海皆可；改的只认「本地会话」和「私聊」，群聊默认只读（allowGroupEdit 可放开）。
 */
let defineTool;
try {
  ({ defineTool } = await import('@deepseek-ai/dsh-tools'));
} catch {
  defineTool = (definition) => definition;
}

const SESSION_RE = /^onebot-(private|group)-(.+)$/;

export function callerOf(exec) {
  const sid = String(exec?.agent?.session?.id ?? exec?.session?.id ?? '');
  const m = SESSION_RE.exec(sid);
  if (!m) return { kind: 'local', sessionId: sid };
  return { kind: m[1], sessionId: sid, peer: m[2] };
}

function canWrite(exec, config) {
  const caller = callerOf(exec);
  if (caller.kind === 'local' || caller.kind === 'private') return { ok: true, caller };
  if (config.allowGroupEdit) return { ok: true, caller };
  return { ok: false, caller, reason: '群里的记忆只能看，不能改。要改就让主人来私聊里说。' };
}

const stamp = (ts) => {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

function textOut(format) {
  return {
    schema: { type: 'json' },
    render: (_args, value) => [{ type: 'text', text: format(value) }],
  };
}

export function registerMemoryTools(ctx, service) {
  const config = service.config;
  const disposers = [];
  const add = (tool) => {
    disposers.push(ctx.tools.register(tool));
  };

  add(
    defineTool({
      name: 'memory_curve_list',
      description:
        '看这个会话里你自己记下的东西：长期事实（L3）和短期摘要（L2），带序号可以拿去删。回答「你记得我什么」时用。',
      parameters: {
        limit: { type: 'number', description: '最多列几条，默认 40' },
      },
      output: textOut((v) => {
        if (!v?.ok) return `读不到记忆：${v?.error || '未知错误'}`;
        if (!v.rows.length) return '这个会话里还没有记下任何东西。';
        const limit = Number(v.limit) > 0 ? Number(v.limit) : v.rows.length;
        const lines = v.rows.slice(0, limit).map(
          (r) => `${r.n}. [${r.tier}] ${r.text}${r.type ? `（${r.type}）` : ''} · ${r.score}分 · ${stamp(r.last)}`,
        );
        return `共 ${v.rows.length} 条（L3 ${v.counts.long} / L2 ${v.counts.short}）：\n${lines.join('\n')}`;
      }),
      isConcurrencySafe: () => true,
      execute: async (args, exec) => {
        const caller = callerOf(exec);
        const res = service.list(caller.sessionId);
        return { ...res, limit: args?.limit };
      },
    }),
  );

  add(
    defineTool({
      name: 'memory_curve_search',
      description: '翻自己的记忆：按关键词找长期事实、短期摘要和旧对话原文。用户提「上次」「之前」的事时用。',
      parameters: {
        query: { type: 'string', required: true, description: '要找的关键词或一句话' },
        limit: { type: 'number', description: '最多几条，默认 6' },
      },
      output: textOut((v) => {
        if (!v?.ok) return `翻记忆失败：${v?.error || '未知错误'}`;
        const parts = [];
        if (v.rows?.length) {
          parts.push(
            `【记忆条目】\n${v.rows
              .map((r) => `- [${r.tier}] ${r.text}${r.type ? `（${r.type}）` : ''}`)
              .join('\n')}`,
          );
        }
        if (v.archive?.length) {
          parts.push(
            `【旧对话】\n${v.archive
              .map((a) => `- [${a.date}] ${a.role === 'assistant' ? '我' : '对方'}：${a.text}`)
              .join('\n')}`,
          );
        }
        return parts.length ? parts.join('\n') : '没翻到相关的记忆。';
      }),
      isConcurrencySafe: () => true,
      execute: async (args, exec) => {
        const caller = callerOf(exec);
        const query = String(args?.query || '').trim();
        if (!query) return { ok: false, error: 'empty query' };
        return service.search(caller.sessionId, query, { limit: Number(args?.limit) || 6 });
      },
    }),
  );

  add(
    defineTool({
      name: 'memory_curve_add',
      description: '手动往长期记忆里写下一条事实（主人说「记住这个」时用）。默认 5 分、永久项。',
      parameters: {
        text: { type: 'string', required: true, description: '要记住的事，一句话' },
        type: { type: 'string', description: '事实 / 偏好 / 约定 / 称呼 / 忌讳 之一' },
        score: { type: 'number', description: '重要度 1-5，默认 5' },
      },
      output: textOut((v) => (v?.ok ? `记下了：${v.row.text}` : `没记下来：${v?.error || '未知错误'}`)),
      isConcurrencySafe: () => false,
      execute: async (args, exec) => {
        const gate = canWrite(exec, config);
        if (!gate.ok) return { ok: false, error: gate.reason };
        return service.add(gate.caller.sessionId, {
          text: args?.text,
          type: args?.type,
          score: args?.score,
        });
      },
    }),
  );

  add(
    defineTool({
      name: 'memory_curve_forget',
      description: '删掉记忆条目。refs 填序号（memory_curve_list 给的，可传 "3,5"）或关键词。',
      parameters: {
        refs: { type: 'string', required: true, description: '序号或关键词，多个用逗号分隔' },
      },
      output: textOut((v) =>
        v?.ok ? `删掉了 ${v.removed.length} 条：\n${v.removed.map((t) => `- ${t}`).join('\n')}` : `没删成：${v?.error || '未知错误'}`,
      ),
      isConcurrencySafe: () => false,
      execute: async (args, exec) => {
        const gate = canWrite(exec, config);
        if (!gate.ok) return { ok: false, error: gate.reason };
        const refs = String(args?.refs || '')
          .split(/[,，\s]+/)
          .filter(Boolean);
        return service.remove(gate.caller.sessionId, refs);
      },
    }),
  );

  add(
    defineTool({
      name: 'memory_curve_prune',
      description: '清一遍记忆：删掉「一次性任务」类条目（跑过就废的那些），顺手做过期维护。',
      parameters: {},
      output: textOut((v) =>
        v?.ok
          ? `清完了：短期清了 ${v.l2Dropped} 条，长期清了 ${v.l3Dropped} 条。`
          : `清理失败：${v?.error || '未知错误'}`,
      ),
      isConcurrencySafe: () => false,
      execute: async (_args, exec) => {
        const gate = canWrite(exec, config);
        if (!gate.ok) return { ok: false, error: gate.reason };
        return service.prune(gate.caller.sessionId);
      },
    }),
  );

  return disposers;
}