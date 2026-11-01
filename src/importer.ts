/**
 * 一次性只读导入：把四套旧记忆归一成卡片。
 * 原文件一个字节都不改；导入过一次就写标记文件，之后不再扫。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { CardStore, CardKind } from './store.ts';
import { readJson } from './store.ts';

export interface ImportReport {
  at: string;
  sources: Record<string, { read: number; added: number; merged: number }>;
  total: number;
}

function mapKind(raw: unknown, fallback: CardKind = 'note'): CardKind {
  const value = String(raw ?? '').toLowerCase();
  if (value === 'fact' || value === 'self' || value === 'episode' || value === 'promise' || value === 'note') {
    return value;
  }
  if (value === 'thread' || value === 'todo' || value === 'open') return 'promise';
  if (value === 'summary' || value === 'profile' || value === 'preference') return 'fact';
  return fallback;
}

function parseFrontmatter(src: string): { meta: Record<string, string>; body: string } {
  if (!src.startsWith('---')) return { meta: {}, body: src.trim() };
  const end = src.indexOf('\n---', 3);
  if (end < 0) return { meta: {}, body: src.trim() };
  const head = src.slice(3, end).trim();
  const body = src.slice(end + 4).trim();
  const meta: Record<string, string> = {};
  for (const line of head.split('\n')) {
    const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    meta[m[1]] = m[2].replace(/^['"]|['"]$/g, '').trim();
  }
  return { meta, body };
}

function walkMarkdown(dir: string, depth = 0): string[] {
  if (!existsSync(dir) || depth > 3) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) out.push(...walkMarkdown(full, depth + 1));
    else if (name.endsWith('.md')) out.push(full);
  }
  return out;
}

interface ImportInput {
  dataDir: string;
  store: CardStore;
}

export function importLegacy(input: ImportInput): ImportReport {
  const { store } = input;
  const report: ImportReport = { at: new Date().toISOString(), sources: {}, total: 0 };
  const bump = (key: string, field: 'read' | 'added' | 'merged') => {
    const slot = (report.sources[key] ??= { read: 0, added: 0, merged: 0 });
    slot[field] += 1;
  };

  // ① 我会永远陪着你：private-companion/memory/records.json
  try {
    const file = join(input.dataDir, 'private-companion', 'memory', 'records.json');
    const data = readJson<{ records?: unknown[] } | unknown[]>(file, []);
    const records = Array.isArray(data) ? data : (data.records ?? []);
    for (const item of records) {
      const rec = item as Record<string, unknown>;
      if (!rec || typeof rec.text !== 'string' || !rec.text.trim()) continue;
      if (rec.archived === true) continue;
      bump('private-companion', 'read');
      const res = store.add({
        kind: mapKind(rec.kind),
        text: rec.text,
        weight: Number(rec.importance ?? rec.confidence ?? 0.5),
        tags: Array.isArray(rec.tags) ? (rec.tags as string[]) : [],
        createdAt: typeof rec.ts === 'string' ? rec.ts : undefined,
        source: 'import:private-companion',
        origin: 'import',
        scope: 'import',
      });
      bump('private-companion', res.merged ? 'merged' : 'added');
    }
  } catch {
    // 源不存在就跳过
  }

  // ② 记忆与陪伴小屋：data/memory.json
  try {
    const file = join(input.dataDir, 'memory.json');
    const arr = readJson<unknown[]>(file, []);
    if (Array.isArray(arr)) {
      for (const item of arr) {
        const rec = item as Record<string, unknown>;
        if (!rec || typeof rec.content !== 'string' || !rec.content.trim()) continue;
        if (rec.active === false) continue;
        bump('memcompanion', 'read');
        const res = store.add({
          kind: mapKind(rec.kind),
          text: rec.content,
          weight: Number(rec.weight ?? 0.5),
          createdAt: typeof rec.createdAt === 'string' ? rec.createdAt : undefined,
          source: 'import:memcompanion',
          origin: 'import',
          scope: 'import',
        });
        bump('memcompanion', res.merged ? 'merged' : 'added');
      }
    }
  } catch {
    // 忽略
  }

  // ③ 给鱼鱼完整的一生：workspace/memories/YYYY-MM/*.md
  try {
    const dir = resolve(input.dataDir, '..', 'workspace', 'memories');
    for (const file of walkMarkdown(dir)) {
      let src = '';
      try {
        src = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      const { meta, body } = parseFrontmatter(src);
      const text = (body || meta.gist || '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      bump('memory-weight', 'read');
      // 这家的 type 只有 promise 一档，且 10 张全是 done，其余没有 type；
      // 已经做完的当成经历，别让它跑进「未完成」里。
      const declared = String(meta.type ?? '').toLowerCase();
      const done = meta.done === 'true';
      const kind: CardKind = declared === 'promise'
        ? (done ? 'episode' : 'promise')
        : mapKind(declared, 'episode');
      const res = store.add({
        kind,
        text,
        weight: Number(meta.base ?? 0.35),
        createdAt: meta.date,
        source: 'import:memory-weight',
        origin: 'import',
        scope: 'import',
      });
      bump('memory-weight', res.merged ? 'merged' : 'added');
      if (meta.dueAt && kind === 'promise' && res.card) {
        store.update(res.card.id, { dueAt: meta.dueAt, done: false });
      }
    }
  } catch {
    // 忽略
  }

  report.total = store.stats().total;
  return report;
}
