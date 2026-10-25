/**
 * dsh-memory-curve：把「四层记忆」从 AstrBot 搬到 DSH。
 *
 * 一句话：L1 原文窗口 → L2 短期摘要（24h）→ L3 长期事实（30 天，每天提升一次）→ L4 全量存档（关键词回溯），
 * 每轮把这些拼成一块系统提示注入，落盘靠旁路订阅 session/event，不碰任何别的插件。
 *
 * 为什么不用 agent/pre-step 改 messages：宿主的历史已经在那儿了，
 * 覆盖它等于跟 compress 抢饭碗；这里只往 system prompt 里加「记忆」这一段。
 */
import fs from 'node:fs';
import path from 'node:path';
import { normalizeConfig } from './config.js';
import { MemoryCurve } from './curve.js';
import { registerMemoryTools } from './tools.js';

export const name = 'dsh-memory-curve';

const SECTION_NAME = 'memory-curve';

function sessionIdOf(session) {
  return String(session?.id ?? session?.session?.id ?? '');
}

/** 从 message.content 里捞纯文本（跟 mnemon 的 textContent 一个路数）。 */
function textOfMessage(message) {
  const content = message?.content;
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (!block) continue;
    if (typeof block === 'string') parts.push(block);
    else if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n').trim();
}

function writeBootMark(dir, info) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.boot.json'),
      `${JSON.stringify({ ...info, at: new Date().toISOString() }, null, 2)}\n`,
      'utf8',
    );
  } catch {
    // 心跳写不出来不影响主流程
  }
}

function makeLogger(prefix) {
  return (level, message) => {
    const line = `${prefix} ${message}`;
    try {
      if (level === 'error') console.error(line);
      else if (level === 'warn') console.warn(line);
      else console.log(line);
    } catch {
      // 忽略
    }
  };
}

export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);
  const log = makeLogger('[memory-curve]');
  const service = new MemoryCurve({ ctx, config, log });

  // 会话状态：这一轮谁说了什么、我上一句是什么
  const pending = new Map(); // sid -> { user, answer }
  const lastUser = new Map(); // sid -> 最近一句用户消息（注入时判断要不要回溯）

  const probe = (name) => {
    try {
      const value = typeof ctx.get === 'function' ? ctx.get(name) : undefined;
      return value ? 'present' : 'absent';
    } catch (error) {
      return `throw:${error instanceof Error ? error.message : String(error)}`;
    }
  };
  writeBootMark(config.dataDir, {
    pid: process.pid,
    stage: 'apply-enter',
    enabled: config.enabled,
    dataDir: config.dataDir,
    hasEffect: typeof ctx.effect === 'function',
    hasInject: typeof ctx.inject === 'function',
    hasOn: typeof ctx.on === 'function',
    services: {
      systemPrompt: probe('systemPrompt'),
      tools: probe('tools'),
      llm: probe('llm'),
      agentDefaultModel: probe('agentDefaultModel'),
    },
  });

  // ---------------------------------------------------------------- 采集 + 落盘
  ctx.effect(() => {
    const dispose = ctx.on('session/event', (session, event) => {
      try {
        if (!config.enabled) return;
        if (!event || typeof event !== 'object') return;
        const type = String(event.type || '');
        const sid = sessionIdOf(session);
        if (!sid) return;

        if (type === 'user/message') {
          const data = event.data;
          if (!data) return;
          const kind = data?.source?.kind;
          if (kind && kind !== 'user') return; // 跳过插件自己塞的提醒
          const text = textOfMessage(data);
          if (!text) return;
          const slot = pending.get(sid) || { user: '', answer: '' };
          slot.user = text;
          pending.set(sid, slot);
          lastUser.set(sid, text);
          return;
        }

        if (type === 'assistant/message') {
          const text = textOfMessage(event.data?.message);
          if (!text) return;
          const slot = pending.get(sid) || { user: '', answer: '' };
          slot.answer = slot.answer ? `${slot.answer}\n${text}` : text;
          pending.set(sid, slot);
          return;
        }

        if (type === 'turn/end') {
          const slot = pending.get(sid);
          if (!slot || !slot.user) return;
          pending.delete(sid);
          const question = slot.user;
          const answer = slot.answer || '';
          service
            .saveTurn(sid, { userText: question, answerText: answer })
            .then((res) => {
              if (res?.ok) {
                const extra = res.promise ? ` +承诺` : '';
                log(
                  'info',
                  `记了一轮 score=${res.score}${res.degraded ? `（降级:${res.degraded}）` : ''}${res.stored ? ' 已入L2' : ''}${extra}`,
                );
              } else if (res?.error && res.error !== 'disabled') {
                log('warn', `这一轮没记成：${res.error}`);
              }
            })
            .catch((error) => {
              log('warn', `落盘异常：${error instanceof Error ? error.message : error}`);
            });
        }
      } catch (error) {
        log('warn', `session/event 处理失败：${error instanceof Error ? error.message : error}`);
      }
    });
    return () => {
      try {
        dispose?.();
      } catch {
        // 忽略
      }
    };
  });

  ctx.effect(() => {
    const dispose = ctx.on('session/disposed', (session) => {
      const sid = sessionIdOf(session);
      if (!sid) return;
      pending.delete(sid);
      lastUser.delete(sid);
      service.drop(sid);
    });
    return () => {
      try {
        dispose?.();
      } catch {
        // 忽略
      }
    };
  });

  // ---------------------------------------------------------------- 注入
  ctx.inject(['systemPrompt'], (scoped) => {
    scoped.effect(() => {
      const dispose = scoped.systemPrompt.section({
        name: SECTION_NAME,
        order: 96,
        text: (context) => {
          try {
            const sid = sessionIdOf(context?.agent?.session ?? context?.session) ||
              String(context?.agent?.session?.id ?? '');
            if (!sid) return '';
            return service.block(sid, lastUser.get(sid) || '');
          } catch (error) {
            log('warn', `注入失败：${error instanceof Error ? error.message : error}`);
            return '';
          }
        },
      });
      return () => {
        try {
          dispose?.();
        } catch {
          // 忽略
        }
      };
    });
    log('info', `记忆注入已挂上（systemPrompt:${SECTION_NAME}）`);
  });

  // ---------------------------------------------------------------- 工具
  if (config.toolsEnabled) {
    ctx.inject(['tools'], (scoped) => {
      scoped.effect(() => {
        const disposers = registerMemoryTools(scoped, service);
        log('info', `已注册 ${disposers.length} 个 memory_curve_* 工具`);
        return () => {
          for (const dispose of disposers) {
            try {
              dispose?.();
            } catch {
              // 忽略
            }
          }
        };
      });
    });
  }
}