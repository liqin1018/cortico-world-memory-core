/**
 * 卡片表、对话原文、日程与状态的文件层。
 * 只碰本插件自己的数据目录；四套旧记忆由 importer.ts 只读导入，不改原文件。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

export type CardKind = 'fact' | 'self' | 'episode' | 'promise' | 'note';

export const CARD_KINDS: CardKind[] = ['fact', 'self', 'episode', 'promise', 'note'];

/** active = 在用；retired = 已退休（被替代/已作废/已合并），不参与检索，可恢复。 */
export type CardStatus = 'active' | 'retired';

export interface Card {
  id: string;
  kind: CardKind;
  text: string;
  weight: number;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  source: string;
  origin: string;
  uses: number;
  lastUsedAt?: string;
  dueAt?: string;
  done?: boolean;
  remindedAt?: string;
  /** 缺省视为 active：老数据没有这个字段，读的时候补上。 */
  status?: CardStatus;
  retiredAt?: string;
  /** 谁让它退休的：'merge' | 'purge' | 'stale' | 接替它的卡片 id。 */
  retiredBy?: string;
  /** 它接替了哪些卡（编辑留版本、closes 关旧记录时写）。 */
  supersedes?: string[];
  /** 记忆域：main（自己写的）/ import（旧插件导入的），给以后接 QQ 分流留位。 */
  scope?: string;
}

export interface RawEntry {
  cursor: number;
  ts: string;
  sender: string;
  text: string;
}

export interface PlanItem {
  id: string;
  time: string;
  title: string;
  place?: string;
  done?: boolean;
}

export interface CoreState {
  energy: number;
  mood: number;
  activity: string;
  location: string;
  sleeping: boolean;
  updatedAt: string;
  createdAt: string;
  lastTalkAt?: string;
  proactiveDueAt?: string;
  proactiveDay?: string;
  proactiveCount?: number;
  lastNightlyDay?: string;
  rawWatermark?: number;
}

export function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    if (!existsSync(file)) return fallback;
    const raw = readFileSync(file, 'utf8').trim();
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(file: string, value: unknown): void {
  try {
    writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
  } catch {
    // 落盘失败不阻断运行
  }
}

/** 规范化文本，用于判重：去掉标点空白与日期，只留内容。 */
export function normalizeText(text: string): string {
  return String(text ?? '')
    .toLowerCase()
    .replace(/\d{1,4}[-/年.]\d{1,2}[-/月.]\d{1,2}日?/g, '')
    .replace(/[\s，。,.!?！？、；;:：""''（）()【】\[\]《》~—-]/g, '');
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.5;
}

export class CardStore {
  private cards: Card[] = [];
  private readonly file: string;
  private dirty = false;

  constructor(dir: string) {
    ensureDir(dir);
    this.file = join(dir, 'cards.jsonl');
    this.load();
  }

  private load(): void {
    try {
      if (!existsSync(this.file)) return;
      const lines = readFileSync(this.file, 'utf8').split('\n');
      let migrated = false;
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const card = JSON.parse(line) as Card;
          if (!card || typeof card.text !== 'string' || !card.text.trim()) continue;
          // 老数据没有 status / scope：读的时候补齐，不重写文件
          if (card.status !== 'retired') {
            if (card.status !== 'active') {
              card.status = 'active';
              migrated = true;
            }
          }
          if (!card.scope) {
            card.scope = String(card.source ?? '').startsWith('import') ? 'import' : 'main';
            migrated = true;
          }
          this.cards.push(card);
        } catch {
          // 跳过坏行
        }
      }
      if (migrated) this.dirty = true;
    } catch {
      this.cards = [];
    }
  }

  all(): readonly Card[] {
    return this.cards;
  }

  /** 在用的卡：默认检索、图谱、列表都只看这些。 */
  active(): Card[] {
    return this.cards.filter((c) => c.status !== 'retired');
  }

  retired(): Card[] {
    return this.cards.filter((c) => c.status === 'retired');
  }

  scopes(): Array<{ scope: string; n: number }> {
    const counts = new Map<string, number>();
    for (const c of this.active()) counts.set(c.scope ?? 'main', (counts.get(c.scope ?? 'main') ?? 0) + 1);
    return [...counts.entries()].map(([scope, n]) => ({ scope, n })).sort((a, b) => b.n - a.n);
  }

  stats(): { total: number; retired: number; byKind: Record<string, number>; oldest?: string; newest?: string } {
    const live = this.active();
    const byKind: Record<string, number> = {};
    for (const c of live) byKind[c.kind] = (byKind[c.kind] || 0) + 1;
    const sorted = [...live].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return {
      total: live.length,
      retired: this.cards.length - live.length,
      byKind,
      oldest: sorted[0]?.createdAt,
      newest: sorted[sorted.length - 1]?.createdAt,
    };
  }

  find(id: string): Card | undefined {
    return this.cards.find((c) => c.id === id);
  }

  /** 同 kind 且内容高度重合时并进旧记录，不新增。 */
  add(input: {
    kind: CardKind;
    text: string;
    weight?: number;
    tags?: string[];
    dueAt?: string;
    source?: string;
    origin?: string;
    createdAt?: string;
    scope?: string;
  }): { card: Card; merged: boolean } {
    const text = String(input.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 500);
    const key = normalizeText(text);
    if (key.length >= 6) {
      const near = this.cards.find(
        (c) => c.kind === input.kind && c.status !== 'retired' && normalizeText(c.text) === key,
      );
      if (near) {
        near.weight = Math.max(near.weight, clamp01(Number(input.weight ?? near.weight)));
        near.updatedAt = new Date().toISOString();
        if (input.dueAt && !near.dueAt) near.dueAt = input.dueAt;
        this.dirty = true;
        this.save();
        return { card: near, merged: true };
      }
    }
    const now = new Date().toISOString();
    const card: Card = {
      id: randomUUID(),
      kind: input.kind,
      text,
      weight: clamp01(Number(input.weight ?? 0.5)),
      tags: Array.isArray(input.tags) ? input.tags.map((t) => String(t).slice(0, 20)).slice(0, 6) : [],
      createdAt: input.createdAt ?? now,
      updatedAt: now,
      source: String(input.source ?? 'tool').slice(0, 40),
      origin: String(input.origin ?? 'tool').slice(0, 40),
      uses: 0,
      status: 'active',
      scope: String(input.scope ?? 'main').slice(0, 24),
      ...(input.dueAt ? { dueAt: input.dueAt } : {}),
      ...(input.kind === 'promise' ? { done: false } : {}),
    };
    this.cards.push(card);
    this.dirty = true;
    this.save();
    return { card, merged: false };
  }

  update(id: string, patch: Partial<Card>): Card | undefined {
    const card = this.find(id);
    if (!card) return undefined;
    Object.assign(card, patch, { updatedAt: new Date().toISOString() });
    this.dirty = true;
    this.save();
    return card;
  }

  close(id: string): Card | undefined {
    return this.update(id, { done: true });
  }

  /** 退休：不删，退出检索与列表，可恢复。by = 'merge' | 'stale' | 'purge' | 接替者 id。 */
  retire(id: string, by = 'manual'): Card | undefined {
    const card = this.find(id);
    if (!card) return undefined;
    card.status = 'retired';
    card.retiredAt = new Date().toISOString();
    card.retiredBy = by;
    card.updatedAt = card.retiredAt;
    this.dirty = true;
    this.save(true);
    return card;
  }

  restore(id: string): Card | undefined {
    const card = this.find(id);
    if (!card) return undefined;
    card.status = 'active';
    delete card.retiredAt;
    delete card.retiredBy;
    card.updatedAt = new Date().toISOString();
    this.dirty = true;
    this.save(true);
    return card;
  }

  /**
   * 用新卡接替旧卡：旧卡退休、新卡记下它接替了谁。
   * 返回 [新卡, 旧卡]；旧的找不到就只返回新卡。
   */
  supersede(oldId: string, next: Card): { card: Card; replaced: Card | null } {
    const old = this.find(oldId);
    if (!old || old.id === next.id) return { card: next, replaced: null };
    old.status = 'retired';
    old.retiredAt = new Date().toISOString();
    old.retiredBy = next.id;
    old.updatedAt = old.retiredAt;
    next.supersedes = [...new Set([...(next.supersedes ?? []), old.id])];
    this.dirty = true;
    this.save(true);
    return { card: next, replaced: old };
  }

  /** 改内容：不覆盖，追加一版；旧版退休并指向新版。 */
  revise(id: string, text: string, by: 'edit' | 'tool' = 'edit'): Card | undefined {
    const old = this.find(id);
    if (!old) return undefined;
    const next: Card = {
      ...old,
      id: randomUUID(),
      text: String(text).replace(/\s+/g, ' ').trim().slice(0, 500),
      createdAt: old.createdAt, // 记忆发生的时间不变
      updatedAt: new Date().toISOString(),
      source: by === 'tool' ? old.source : 'map',
      origin: by === 'tool' ? old.origin : 'map',
      status: 'active',
      uses: old.uses,
      supersedes: [...(old.supersedes ?? []), old.id],
    };
    delete next.retiredAt;
    delete next.retiredBy;
    this.cards.push(next);
    old.status = 'retired';
    old.retiredAt = next.updatedAt;
    old.retiredBy = next.id;
    this.dirty = true;
    this.save(true);
    return next;
  }

  /** 合并：keep 吸收 drops 的标签/权重/截止时间，drops 全部退休。 */
  merge(keepId: string, dropIds: readonly string[]): { kept: Card | null; merged: number } {
    const kept = this.find(keepId);
    if (!kept) return { kept: null, merged: 0 };
    let merged = 0;
    for (const id of dropIds) {
      if (id === keepId) continue;
      const drop = this.find(id);
      if (!drop || drop.status === 'retired') continue;
      kept.tags = [...new Set([...kept.tags, ...drop.tags])].slice(0, 8);
      kept.weight = Math.max(kept.weight, drop.weight);
      if (drop.dueAt && (!kept.dueAt || Date.parse(drop.dueAt) < Date.parse(kept.dueAt))) kept.dueAt = drop.dueAt;
      kept.supersedes = [...new Set([...(kept.supersedes ?? []), ...(drop.supersedes ?? []), drop.id])];
      kept.updatedAt = new Date().toISOString();
      drop.status = 'retired';
      drop.retiredAt = kept.updatedAt;
      drop.retiredBy = keepId;
      merged += 1;
    }
    this.dirty = true;
    this.save(true);
    return { kept, merged };
  }

  /** 血缘：它接替了谁、谁接替了它。 */
  lineage(id: string): { card: Card | null; supersedes: Card[]; replacedBy: Card | null } {
    const card = this.find(id);
    if (!card) return { card: null, supersedes: [], replacedBy: null };
    const supersedes = (card.supersedes ?? []).map((x) => this.find(x)).filter((x): x is Card => Boolean(x));
    const replacedBy = this.cards.find((c) => (c.supersedes ?? []).includes(card.id)) ?? null;
    return { card, supersedes, replacedBy };
  }

  /**
   * 重复候选：同 kind、在用的卡之间做二元组相似度，超过阈值就成组。
   * 现在的数据量（几十到几千条）两两比较够用；上万条再考虑分桶。
   */
  duplicates(threshold = 0.55): Array<{ score: number; cards: Card[] }> {
    const pool = this.active();
    const grams = new Map<string, Set<string>>();
    const bigrams = (text: string): Set<string> => {
      let cached = grams.get(text);
      if (cached) return cached;
      const norm = normalizeText(text);
      cached = new Set<string>();
      for (let i = 0; i < norm.length - 1; i += 1) cached.add(norm.slice(i, i + 2));
      grams.set(text, cached);
      return cached;
    };
    const seen = new Set<string>();
    const groups: Array<{ score: number; cards: Card[] }> = [];
    for (let i = 0; i < pool.length; i += 1) {
      if (seen.has(pool[i].id)) continue;
      const a = pool[i];
      const A = bigrams(a.text);
      if (A.size < 4) continue;
      const group: Card[] = [a];
      let best = 0;
      for (let j = i + 1; j < pool.length; j += 1) {
        const b = pool[j];
        if (b.kind !== a.kind || seen.has(b.id)) continue;
        const B = bigrams(b.text);
        if (B.size < 4) continue;
        let inter = 0;
        for (const g of A) if (B.has(g)) inter += 1;
        const score = inter / (A.size + B.size - inter || 1);
        if (score >= threshold) {
          group.push(b);
          best = Math.max(best, score);
        }
      }
      if (group.length > 1) {
        for (const c of group) seen.add(c.id);
        groups.push({ score: Number(best.toFixed(2)), cards: group });
      }
    }
    return groups.sort((x, y) => y.score - x.score);
  }

  /** 疑似作废：文案里自己写了「取消了 / 改到 / 作废」，多半已经被后来的记录替代。 */
  stale(limit = 50): Card[] {
    const re = /取消|黄了|作废|不去了|改成|改到|算了|不用了/;
    return this.active()
      .filter((c) => re.test(c.text))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  /** 垃圾卡：太短、纯符号/表情，或是 `[取消]` 这类系统回执。 */
  junk(limit = 50): Card[] {
    return this.active()
      .filter((c) => {
        const norm = normalizeText(c.text);
        if (norm.length < 6) return true;
        if (/^[\p{P}\p{S}\s]+$/u.test(c.text)) return true;
        return /^\[[^\]]{0,12}\]$/.test(c.text.trim());
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  /** 回收站里真删。 */
  purge(ids: readonly string[]): number {
    const set = new Set(ids);
    const before = this.cards.length;
    this.cards = this.cards.filter((c) => !set.has(c.id));
    const removed = before - this.cards.length;
    if (removed) {
      this.dirty = true;
      this.save(true);
    }
    return removed;
  }

  /** 界面上的删除：真的从表里移除，落盘立即生效。 */
  remove(id: string): boolean {
    const at = this.cards.findIndex((c) => c.id === id);
    if (at < 0) return false;
    this.cards.splice(at, 1);
    this.dirty = true;
    this.save(true);
    return true;
  }

  touch(ids: readonly string[]): void {
    const now = new Date().toISOString();
    for (const id of ids) {
      const card = this.find(id);
      if (!card) continue;
      card.uses = (card.uses || 0) + 1;
      card.lastUsedAt = now;
    }
    this.dirty = true;
    this.save(true);
  }

  openPromises(limit = 5, now = Date.now()): Card[] {
    return this.cards
      .filter((c) => c.kind === 'promise' && !c.done && c.status !== 'retired')
      .sort((a, b) => {
        const ad = a.dueAt ? Date.parse(a.dueAt) : Number.MAX_SAFE_INTEGER;
        const bd = b.dueAt ? Date.parse(b.dueAt) : Number.MAX_SAFE_INTEGER;
        if (ad !== bd) return ad - bd;
        return 0;
      })
      .slice(0, Math.max(0, limit));
  }

  duePromises(now = Date.now()): Card[] {
    const at = now;
    return this.cards.filter((c) => {
      if (c.kind !== 'promise' || c.done || c.status === 'retired' || !c.dueAt) return false;
      const due = Date.parse(c.dueAt);
      return Number.isFinite(due) && due <= at && !c.remindedAt;
    });
  }

  reset(): void {
    this.cards = [];
    this.dirty = true;
    this.save(true);
  }

  save(force = false): void {
    if (!this.dirty && !force) return;
    this.dirty = false;
    try {
      writeFileSync(this.file, this.cards.map((c) => JSON.stringify(c)).join('\n') + '\n', 'utf8');
    } catch {
      // 落盘失败下一拍再来
      this.dirty = true;
    }
  }
}

export class RawLog {
  private entries: RawEntry[] = [];
  private readonly file: string;
  private readonly retentionDays: number;

  constructor(dir: string, retentionDays: number) {
    this.retentionDays = Math.max(1, Number(retentionDays) || 7);
    ensureDir(dir);
    this.file = join(dir, 'turns.jsonl');
    this.load();
  }

  private load(): void {
    try {
      if (!existsSync(this.file)) return;
      const cutoff = Date.now() - this.retentionDays * 86_400_000;
      const kept: RawEntry[] = [];
      for (const line of readFileSync(this.file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line) as RawEntry;
          if (!e || typeof e.text !== 'string') continue;
          if (Date.parse(e.ts) >= cutoff) kept.push(e);
        } catch {
          // 跳过坏行
        }
      }
      this.entries = kept;
      this.rewrite();
    } catch {
      this.entries = [];
    }
  }

  private rewrite(): void {
    try {
      writeFileSync(this.file, this.entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
    } catch {
      // ignore
    }
  }

  get size(): number {
    return this.entries.length;
  }

  lastCursor(): number {
    return this.entries.length ? this.entries[this.entries.length - 1].cursor : 0;
  }

  all(): readonly RawEntry[] {
    return this.entries;
  }

  reset(): void {
    this.entries = [];
    this.rewrite();
  }

  add(items: RawEntry[]): number {
    if (!items.length) return 0;
    const fresh = items.filter((item) => !this.entries.some((e) => e.cursor === item.cursor));
    if (!fresh.length) return 0;
    this.entries.push(...fresh);
    const cutoff = Date.now() - this.retentionDays * 86_400_000;
    if (this.entries.length > 4000) this.entries = this.entries.slice(-4000);
    this.entries = this.entries.filter((e) => Date.parse(e.ts) >= cutoff);
    try {
      appendFileSync(this.file, fresh.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
    } catch {
      // ignore
    }
    return fresh.length;
  }
}
