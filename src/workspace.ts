/**
 * 工作区文件检索：把 workspace 里的 md/txt 也纳入「你还记得吗」。
 *
 * 三条约束：
 *   1) **只读**，一个字节都不写；
 *   2) 结果带 60 秒缓存，避免每轮 recall 都去遍历目录；
 *   3) 单个文件超过 maxFileKB 直接跳过 —— 日记文件不该有几 MB。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, isAbsolute, join, resolve } from 'node:path';
import { scoreText, tokenize } from './recall.ts';

export interface DocFile {
  /** 绝对路径 */
  path: string;
  /** 文件名（带后缀） */
  name: string;
  /** 相对搜索根的名字，给界面看 */
  rel: string;
  mtimeMs: number;
  size: number;
  text: string;
}

export interface ScanOptions {
  /** 逗号或换行分隔；支持 {workspace} {bot} {data} 占位。 */
  dirs: string;
  /** 逗号分隔的后缀，不带点也认。 */
  exts: string;
  maxFiles: number;
  maxFileKB: number;
  botDir: string;
}

const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', 'dist', 'build', '.cache', 'data', '.workbuddy']);
const MAX_DEPTH = 3;
const CACHE_TTL_MS = 60_000;

interface CacheSlot {
  at: number;
  files: DocFile[];
}

const cache = new Map<string, CacheSlot>();

export function expandDirs(spec: string, botDir: string): string[] {
  const workspace = join(botDir, 'workspace');
  const parts = String(spec ?? '')
    .split(/[,，\n;；]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const out: string[] = [];
  for (const part of parts) {
    const replaced = part
      .replace(/\{workspace\}/gi, workspace)
      .replace(/\{bot\}/gi, botDir)
      .replace(/\{data\}/gi, botDir);
    const abs = isAbsolute(replaced) ? replaced : resolve(workspace, replaced);
    if (!out.includes(abs)) out.push(abs);
  }
  return out;
}

/** 旧卡片是带 frontmatter 的 Markdown；把 YAML 头去掉再检索，免得片段全是字段名。 */
function stripFrontmatter(text: string): string {
  if (!text.startsWith('---')) return text;
  const end = text.indexOf('\n---', 3);
  if (end < 0) return text;
  return text.slice(end + 4).replace(/^[\r\n]+/, '');
}

function extSet(exts: string): Set<string> {  const set = new Set<string>();
  for (const raw of String(exts ?? '').split(/[,，\s]+/)) {
    const e = raw.trim().toLowerCase().replace(/^\*?\.?/, '');
    if (e) set.add(e.startsWith('.') ? e : `.${e}`);
  }
  if (!set.size) set.add('.md');
  return set;
}

function walk(dir: string, exts: Set<string>, out: DocFile[], budget: { left: number; maxBytes: number }, root: string, depth: number): void {
  if (budget.left <= 0 || depth > MAX_DEPTH) return;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (budget.left <= 0) return;
    if (name.startsWith('.')) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      walk(full, exts, out, budget, root, depth + 1);
      continue;
    }
    if (!st.isFile()) continue;
    if (!exts.has(extname(name).toLowerCase())) continue;
    if (st.size > budget.maxBytes) continue;
    let text = '';
    try {
      text = readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    out.push({
      path: full,
      name,
      rel: full.startsWith(root) ? full.slice(root.length).replace(/^[\\/]/, '') : name,
      mtimeMs: st.mtimeMs,
      size: st.size,
      text: extname(name).toLowerCase() === '.md' ? stripFrontmatter(text) : text,
    });
    budget.left -= 1;
  }
}

/** 读一份目录快照；走缓存，最多 60 秒一次真实遍历。 */
export function loadDocs(opts: ScanOptions): DocFile[] {
  const dirs = expandDirs(opts.dirs, opts.botDir);
  if (!dirs.length) return [];
  const maxFiles = Math.min(2000, Math.max(1, Number(opts.maxFiles) || 300));
  const maxBytes = Math.max(16, Number(opts.maxFileKB) || 256) * 1024;
  const key = `${opts.botDir}|${dirs.join('|')}|${opts.exts}|${maxFiles}|${maxBytes}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.files;

  const files: DocFile[] = [];
  const budget = { left: maxFiles, maxBytes };
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    walk(dir, extSet(opts.exts), files, budget, dir, 0);
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  cache.set(key, { at: Date.now(), files });
  // 缓存别无限长：键是配置拼出来的，正常最多几条
  if (cache.size > 24) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) cache.delete(oldest[0]);
  }
  return files;
}

export interface DocHit {
  file: DocFile;
  snippet: string;
  score: number;
}

function snippetAround(text: string, token: string, width = 90): string {
  const flat = text.replace(/\r/g, '');
  const at = token ? flat.toLowerCase().indexOf(token.toLowerCase()) : -1;
  if (at < 0) {
    const head = flat.replace(/^#+\s*/gm, '').replace(/\s+/g, ' ').trim();
    return head.slice(0, width);
  }
  const start = Math.max(0, at - Math.floor(width / 3));
  const piece = flat.slice(start, start + width).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${piece}${start + width < flat.length ? '…' : ''}`;
}

/** 按内容打分，返回文件 + 命中位置的片段。纯本地，不调模型。 */
export function searchDocs(files: readonly DocFile[], query: string, limit = 3): DocHit[] {
  const tokens = tokenize(query);
  if (!tokens.length || !files.length) return [];
  const best = [...new Set(tokens)].sort((a, b) => b.length - a.length)[0] ?? '';
  const scored = files.map((file) => {
    const nameHit = scoreText(tokens, file.name.replace(/\.[^.]+$/, '')) * 0.8;
    const bodyHit = scoreText(tokens, file.text.slice(0, 40_000));
    return {
      file,
      snippet: snippetAround(file.text, best),
      score: bodyHit * 2 + nameHit,
    };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.filter((x) => x.score > 0.9).slice(0, Math.max(1, limit));
}

/** 给界面用的清单（不带正文，省流量）。 */
export function docIndex(files: readonly DocFile[]): Array<Omit<DocFile, 'text'> & { chars: number }> {
  return files.map(({ text, ...rest }) => ({ ...rest, chars: text.length }));
}
