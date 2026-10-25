/**
 * 落盘：一个会话一个目录，沿用原插件的数据布局
 *   <dataDir>/<session>/l1.json l2.json l3.json state.json archive/<YYYY-MM-DD>.jsonl
 * 写法也照搬：先写 .tmp 再 rename，失败退化成直接覆盖（Windows 上 rename 偶尔被占用）。
 * 全部同步 IO —— 注入块每轮都要现算，异步反而添麻烦；文件都只有几 KB。
 */
import fs from 'node:fs';
import path from 'node:path';

const SAFE_RE = /[^0-9A-Za-z._-]/g;

export function sanitizeSessionId(sessionId) {
  const raw = String(sessionId ?? '').trim();
  if (!raw) return '';
  const cleaned = raw.replace(SAFE_RE, '_');
  if (cleaned.length <= 96) return cleaned;
  // 太长就截断 + 后缀，避免两个长 id 撞到同一个目录
  let hash = 0;
  for (let i = 0; i < raw.length; i += 1) hash = (hash * 31 + raw.charCodeAt(i)) | 0;
  return `${cleaned.slice(0, 88)}-${(hash >>> 0).toString(36)}`;
}

export class MemoryStore {
  constructor(root) {
    this.root = root;
    try {
      fs.mkdirSync(root, { recursive: true });
    } catch {
      // 目录建不出来就等到真正写的时候再报（只警告，不炸插件）
    }
  }

  dirOf(sessionId) {
    const name = sanitizeSessionId(sessionId) || 'default';
    return path.join(this.root, name);
  }

  ensureDir(dir) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      // 忽略
    }
  }

  readJson(file, fallback) {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const parsed = JSON.parse(raw);
      return parsed ?? fallback;
    } catch {
      return fallback;
    }
  }

  writeJson(file, value) {
    this.ensureDir(path.dirname(file));
    const text = `${JSON.stringify(value, null, 2)}\n`;
    const tmp = `${file}.tmp`;
    try {
      fs.writeFileSync(tmp, text, 'utf8');
      fs.renameSync(tmp, file);
      return true;
    } catch {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        // 忽略
      }
      try {
        fs.writeFileSync(file, text, 'utf8');
        return true;
      } catch {
        return false;
      }
    }
  }

  appendLine(file, value) {
    this.ensureDir(path.dirname(file));
    try {
      fs.appendFileSync(file, `${JSON.stringify(value)}\n`, 'utf8');
      return true;
    } catch {
      return false;
    }
  }

  readLines(file) {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const out = [];
      for (const line of raw.split('\n')) {
        const s = line.trim();
        if (!s) continue;
        try {
          const parsed = JSON.parse(s);
          if (parsed && typeof parsed === 'object') out.push(parsed);
        } catch {
          // 坏行跳过，别让一行烂数据废掉整个文件
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  /** archive 文件名（YYYY-MM-DD.jsonl），新的在后。 */
  archiveFiles(dir, limit = 7) {
    const archiveDir = path.join(dir, 'archive');
    let names = [];
    try {
      names = fs.readdirSync(archiveDir).filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n));
    } catch {
      return [];
    }
    names.sort();
    return names.slice(-Math.max(1, limit)).map((n) => path.join(archiveDir, n));
  }

  /** 改动前备份一份，只留最近 keep 份。 */
  backup(file, keep = 5) {
    try {
      if (!fs.existsSync(file)) return null;
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const target = `${file}.bak-${stamp}`;
      fs.copyFileSync(file, target);
      const dir = path.dirname(file);
      const base = path.basename(file);
      const olds = fs
        .readdirSync(dir)
        .filter((n) => n.startsWith(`${base}.bak-`))
        .sort();
      for (const name of olds.slice(0, Math.max(0, olds.length - keep))) {
        try {
          fs.rmSync(path.join(dir, name), { force: true });
        } catch {
          // 忽略
        }
      }
      return target;
    } catch {
      return null;
    }
  }
}