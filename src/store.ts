/**
 * 卡片表、对话原文、日程与状态的文件层。
 * 只碰本插件自己的数据目录；四套旧记忆由 importer.ts 只读导入，不改原文件。
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, appendFileSync } from 'node:fs';
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
  /**
   * 写这条时最近的一句原文（游标 + 时间）。卡片是模型改写过的结论，
   * 不是原话；留一个指针，召回时才敢说「这条能追到当时的哪一句」。
   */
  src?: { cursor: number; ts: string };
  /** 被「主动想起」过几次（每轮预激活），和 uses（工具召回）分开记。 */
  primedCount?: number;
  lastPrimedAt?: string;
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
  /** 水位是按哪一版捕获逻辑推进的。旧版用了错的 range 语义，水位不可信，见 CAPTURE_WATERMARK_VERSION。 */
  watermarkVersion?: number;
  /** 历史原文回放只做一次，做完记下时间。 */
  backfillDoneAt?: string;
  /** 回放开始时间：只在开始那一刻倒水位，中断后下次接着跑，不重复从头扫。 */
  backfillStartedAt?: string;
  /** 上一次捕获的体检结果：扫了多少、留下多少、被白名单挡掉的 key 样例。 */
  captureDebug?: {
    at: string;
    scanned: number;
    kept: number;
    keys: string[];
    /** 回放没跑完时，本轮从哪扫到哪，方便看进度。 */
    backfillFrom?: number;
    backfillTo?: number;
  };
  /** 归档里的账号号码抹过一次之后记下时间，不再重复扫。 */
  senderScrubbedAt?: string;
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

/**
 * 先写同目录的 `.tmp` 再改名覆盖。
 * 直接 writeFileSync 覆盖的窗口里断电/被杀，原文件会变成半截或空文件——整个记忆库就这么没了。
 * rename 在 Windows 上偶尔被杀软或索引服务锁住，失败时退回直接写，至少不丢这一次。
 * @returns 是否落盘成功
 */
export function writeAtomic(file: string, body: string): boolean {
  const tmp = `${file}.tmp`;
  try {
    writeFileSync(tmp, body, 'utf8');
    renameSync(tmp, file);
    return true;
  } catch {
    try {
      writeFileSync(file, body, 'utf8');
      return true;
    } catch {
      return false;
    } finally {
      try {
        unlinkSync(tmp);
      } catch {
        // 没有残留就算了
      }
    }
  }
}

export function writeJson(file: string, value: unknown): void {
  writeAtomic(file, JSON.stringify(value, null, 2));
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

/**
 * 原文的来源里带平台账号（`private:1940008084`），原样落盘就是明文号码，
 * 目录一同步到网盘或备份就跟着泄露。只留后 4 位——够区分是谁，不够认出是谁。
 */
export function maskSender(sender: string): string {
  return String(sender ?? '').replace(/\d{5,}/g, (digits) => `…${digits.slice(-4)}`);
}

export class CardStore {
  private cards: Card[] = [];
  private readonly file: string;
  private readonly backupDir: string;
  /** 今天是否已经备过份。同一天只备一次，避免每次 save 都复制。 */
  private backupDay = '';
  private dirty = false;

  constructor(dir: string) {
    ensureDir(dir);
    this.file = join(dir, 'cards.jsonl');
    this.backupDir = join(dir, 'backups');
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
    src?: { cursor: number; ts: string };
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
      ...(input.src ? { src: input.src } : {}),
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
      // 文本换了，旧的出处就对不上了，别再挂一个会骗人的 ↩
      src: undefined,
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

  /**
   * 疑似作废：一类是文案里自己写了「取消了 / 改到 / 作废」，
   * 另一类是放旧了没人再碰——90 天没被召回、从没带过权重、权重还低。
   * 两类都只是候选，仍然要人点一下才退休。
   */
  stale(limit = 50, now = Date.now()): Card[] {
    const re = /取消|黄了|作废|不去了|改成|改到|算了|不用了/;
    const hit: Card[] = [];
    const aged: Card[] = [];
    for (const c of this.active()) {
      if (re.test(c.text)) {
        hit.push(c);
        continue;
      }
      const born = Date.parse(c.createdAt);
      if (!Number.isFinite(born)) continue;
      const last = Date.parse(c.lastUsedAt ?? '') || born;
      const quietDays = (now - last) / 86_400_000;
      if (quietDays < 90) continue;
      if ((c.uses || 0) > 1) continue;
      if (c.weight > 0.45) continue;
      if (c.kind === 'promise' && !c.done) continue;
      aged.push(c);
    }
    return [...hit.sort((a, b) => b.createdAt.localeCompare(a.createdAt)), ...aged]
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

  /**
   * 记「主动想起」的账。和 touch 分开：预激活是系统推的，工具召回是模型要的。
   * 两者都算「被用过」，但只有后者说明模型真的去查了。
   */
  prime(ids: readonly string[]): void {
    if (!ids.length) return;
    const now = new Date().toISOString();
    for (const id of ids) {
      const card = this.find(id);
      if (!card) continue;
      card.primedCount = (card.primedCount || 0) + 1;
      card.lastPrimedAt = now;
    }
    this.dirty = true;
    this.save();
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

  /**
   * 到点该提的承诺。
   * repeatDays = 0 时和旧版一致：提醒过一次就永久沉默。
   * repeatDays > 0 时，距上次提醒够这么多天就再提一次（「每天发一条」这种周期承诺靠它）。
   */
  duePromises(now = Date.now(), repeatDays = 0): Card[] {
    const at = now;
    const gap = Math.max(0, Number(repeatDays) || 0) * 86_400_000;
    return this.cards.filter((c) => {
      if (c.kind !== 'promise' || c.done || c.status === 'retired' || !c.dueAt) return false;
      const due = Date.parse(c.dueAt);
      if (!Number.isFinite(due) || due > at) return false;
      if (!c.remindedAt) return true;
      if (gap <= 0) return false;
      const last = Date.parse(c.remindedAt);
      return !Number.isFinite(last) || at - last >= gap;
    });
  }

  /** 没有截止时间的承诺：提醒管线对它们完全无效，界面上要单独列出来让人补。 */
  promisesWithoutDue(): Card[] {
    return this.cards
      .filter((c) => c.kind === 'promise' && !c.done && c.status !== 'retired' && !c.dueAt)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * 从备份里灌卡片。同 id 或「同类型 + 同文本」已经存在就跳过，绝不覆盖现有内容——
   * 导入是恢复，不是覆盖。返回加了几条、跳了几条。
   */
  importCards(input: readonly unknown[]): { added: number; skipped: number } {
    let added = 0;
    let skipped = 0;
    const byId = new Set(this.cards.map((c) => c.id));
    const byKey = new Set(this.cards.map((c) => `${c.kind}\u0000${normalizeText(c.text)}`));
    for (const raw of input) {
      const c = (raw ?? {}) as Partial<Card>;
      if (typeof c.text !== 'string' || !c.text.trim()) {
        skipped += 1;
        continue;
      }
      const kind = CARD_KINDS.includes(c.kind as CardKind) ? (c.kind as CardKind) : 'fact';
      const text = c.text.replace(/\s+/g, ' ').trim().slice(0, 500);
      const key = `${kind}\u0000${normalizeText(text)}`;
      const id = typeof c.id === 'string' && /^[\w-]{1,60}$/.test(c.id) ? c.id : randomUUID();
      if (byId.has(id) || byKey.has(key)) {
        skipped += 1;
        continue;
      }
      const now = new Date().toISOString();
      const card: Card = {
        id,
        kind,
        text,
        weight: clamp01(Number(c.weight ?? 0.5)),
        tags: Array.isArray(c.tags) ? (c.tags as unknown[]).map((t) => String(t).slice(0, 20)).slice(0, 6) : [],
        createdAt: typeof c.createdAt === 'string' && c.createdAt ? c.createdAt : now,
        updatedAt: typeof c.updatedAt === 'string' && c.updatedAt ? c.updatedAt : now,
        // 恢复要尽量还原原样：来源、作用域能带就带，别一律改成 import:backup
        source: typeof c.source === 'string' && c.source ? c.source.slice(0, 40) : 'import:backup',
        origin: 'import',
        uses: Math.max(0, Math.floor(Number(c.uses ?? 0)) || 0),
        lastUsedAt: typeof c.lastUsedAt === 'string' ? c.lastUsedAt : undefined,
        dueAt: typeof c.dueAt === 'string' ? c.dueAt : undefined,
        done: c.done === true ? true : undefined,
        remindedAt: typeof c.remindedAt === 'string' ? c.remindedAt : undefined,
        status: c.status === 'retired' ? 'retired' : 'active',
        retiredAt: typeof c.retiredAt === 'string' ? c.retiredAt : undefined,
        retiredBy: typeof c.retiredBy === 'string' ? c.retiredBy : undefined,
        supersedes: Array.isArray(c.supersedes) ? (c.supersedes as unknown[]).map((x) => String(x)).slice(0, 20) : undefined,
        scope: typeof c.scope === 'string' && c.scope ? c.scope.slice(0, 20) : 'import',
        src:
          c.src && typeof c.src === 'object' && Number.isFinite(Number((c.src as { cursor?: unknown }).cursor))
            && typeof (c.src as { ts?: unknown }).ts === 'string'
            ? { cursor: Number((c.src as { cursor: number }).cursor), ts: String((c.src as { ts: string }).ts) }
            : undefined,
        primedCount: Number.isFinite(Number(c.primedCount)) ? Number(c.primedCount) : undefined,
        lastPrimedAt: typeof c.lastPrimedAt === 'string' ? c.lastPrimedAt : undefined,
      };
      this.cards.push(card);
      byId.add(id);
      byKey.add(key);
      added += 1;
    }
    if (added) {
      this.dirty = true;
      this.save(true);
    }
    return { added, skipped };
  }

  reset(): void {
    this.cards = [];
    this.dirty = true;
    this.save(true);
  }

  save(force = false): void {
    if (!this.dirty && !force) return;
    this.dirty = false;
    this.backupOnceADay();
    if (!writeAtomic(this.file, this.cards.map((c) => JSON.stringify(c)).join('\n') + '\n')) {
      // 落盘失败下一拍再来
      this.dirty = true;
    }
  }

  /**
   * 每天第一次写之前，把当前文件复制一份到 backups/cards-YYYY-MM-DD.jsonl，只留最近 7 份。
   * 顺序很重要：先备份、再覆盖，这样备份里至少有一份「改动前」的完整文件。
   */
  private backupOnceADay(): void {
    try {
      const d = new Date();
      const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      if (this.backupDay === day) return;
      // 文件还不存在时先不标记，等第一次写出来之后再补备份
      if (!existsSync(this.file)) return;
      ensureDir(this.backupDir);
      copyFileSync(this.file, join(this.backupDir, `cards-${day}.jsonl`));
      this.backupDay = day;
      const old = readdirSync(this.backupDir)
        .filter((f) => /^cards-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
        .sort();
      for (const f of old.slice(0, Math.max(0, old.length - 7))) {
        try {
          unlinkSync(join(this.backupDir, f));
        } catch {
          // 删不掉就留着，不影响
        }
      }
    } catch {
      // 备份失败不阻断写入
    }
  }

  /** 备份现状，健康面板用。 */
  backupInfo(): { dir: string; count: number; latest: string | null } {
    try {
      if (!existsSync(this.backupDir)) return { dir: this.backupDir, count: 0, latest: null };
      const files = readdirSync(this.backupDir).filter((f) => /^cards-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
      return { dir: this.backupDir, count: files.length, latest: files.at(-1) ?? null };
    } catch {
      return { dir: this.backupDir, count: 0, latest: null };
    }
  }
}

const DAY_FMT = new Intl.DateTimeFormat('sv-SE', { year: 'numeric', month: '2-digit', day: '2-digit' });

/** 事件属于哪一天（本地时区），归档文件按这个命名。 */
function dayKeyOf(iso: string | undefined): string {
  const at = Date.parse(iso ?? '');
  if (!Number.isFinite(at)) return '';
  return DAY_FMT.format(new Date(at));
}

export class RawLog {
  private entries: RawEntry[] = [];
  private readonly file: string;
  private readonly archiveDir: string;
  private readonly retentionDays: number;
  private readonly archiveDays: number;

  constructor(dir: string, retentionDays: number, archiveDays = 90) {
    this.retentionDays = Math.max(1, Number(retentionDays) || 7);
    this.archiveDays = Math.max(0, Number(archiveDays) || 0);
    ensureDir(dir);
    this.file = join(dir, 'turns.jsonl');
    this.archiveDir = join(dir, 'archive');
    ensureDir(this.archiveDir);
    this.load();
    this.purgeArchive();
  }

  private load(): void {
    try {
      if (!existsSync(this.file)) return;
      const cutoff = Date.now() - this.retentionDays * 86_400_000;
      const kept: RawEntry[] = [];
      const expired: RawEntry[] = [];
      for (const line of readFileSync(this.file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line) as RawEntry;
          if (!e || typeof e.text !== 'string') continue;
          const at = Date.parse(e.ts);
          if (!Number.isFinite(at)) continue;
          // 读的时候就脱敏：即便文件里还留着老格式，界面和快照也不会露号码
          e.sender = maskSender(e.sender);
          (at >= cutoff ? kept : expired).push(e);
        } catch {
          // 跳过坏行
        }
      }
      this.entries = kept;
      // 文件可能是「老版本写的最后几行 + 补录回来的开头几行」拼起来的，按 cursor 归一，
      // 不然原文页会按数组顺序显示成 8:25 → 10:32 → 8:24 这种乱序
      this.sortEntries();
      // 过期的挪进按天归档，不再直接抹掉：要翻旧日子用 mode=archive
      // 传已归档游标：启动时文件里可能还留着上次归档过的行（老版本写的），别再写一遍
      if (expired.length) this.archive(expired, this.archivedCursors());
      this.rewrite();
    } catch {
      this.entries = [];
    }
  }

  /** 归档里已经有过的游标。只在启动时算一次，避免重启后把同一行反复写进归档。 */
  private archivedCursors(): Set<number> {
    const set = new Set<number>();
    for (const { file } of this.archiveFiles()) {
      try {
        for (const line of readFileSync(file, 'utf8').split('\n')) {
          if (!line.trim()) continue;
          try {
            const e = JSON.parse(line) as RawEntry;
            if (typeof e.cursor === 'number') set.add(e.cursor);
          } catch {
            // 跳过坏行
          }
        }
      } catch {
        // 读不出就当作没归档过
      }
    }
    return set;
  }

  /** 按天追加到 archive/YYYY-MM-DD.jsonl，只写不读，读的时候再按需扫。 */
  private archive(items: readonly RawEntry[], seen?: Set<number>): void {
    const buckets = new Map<string, string[]>();
    for (const e of items) {
      if (seen?.has(e.cursor)) continue;
      const day = dayKeyOf(e.ts);
      if (!day) continue;
      const line = JSON.stringify(e);
      const list = buckets.get(day);
      if (list) list.push(line);
      else buckets.set(day, [line]);
    }
    for (const [day, lines] of buckets) {
      try {
        appendFileSync(join(this.archiveDir, `${day}.jsonl`), `${lines.join('\n')}\n`, 'utf8');
      } catch {
        // 归档失败不影响热数据
      }
    }
  }

  private archiveFiles(desc = false): Array<{ day: string; file: string }> {
    try {
      const names = readdirSync(this.archiveDir)
        .filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n))
        .sort();
      if (desc) names.reverse();
      return names.map((n) => ({ day: n.slice(0, 10), file: join(this.archiveDir, n) }));
    } catch {
      return [];
    }
  }

  /** 归档保留天数，0 = 永久。 */
  private purgeArchive(): void {
    if (!this.archiveDays) return;
    const cutoff = dayKeyOf(new Date(Date.now() - this.archiveDays * 86_400_000).toISOString());
    for (const { day, file } of this.archiveFiles()) {
      if (day >= cutoff) continue;
      try {
        unlinkSync(file);
      } catch {
        // ignore
      }
    }
  }

  /** 归档概况，给界面显示。 */
  stats(): { days: number; bytes: number; oldest: string } {
    const files = this.archiveFiles();
    let bytes = 0;
    for (const f of files) {
      try {
        bytes += statSync(f.file).size;
      } catch {
        // ignore
      }
    }
    return { days: files.length, bytes, oldest: files[0]?.day ?? '' };
  }

  /** 删掉一条原文：热数据从内存表里摘掉重写；在归档里就改写那天对应的文件。 */
  remove(cursor: number): boolean {
    const id = Number(cursor);
    if (!Number.isFinite(id)) return false;
    const at = this.entries.findIndex((e) => e.cursor === id);
    if (at >= 0) {
      this.entries.splice(at, 1);
      this.rewrite();
      return true;
    }
    for (const { file } of this.archiveFiles()) {
      try {
        const lines = readFileSync(file, 'utf8').split('\n');
        let hit = -1;
        for (let i = 0; i < lines.length; i += 1) {
          if (!lines[i].trim()) continue;
          try {
            if ((JSON.parse(lines[i]) as RawEntry).cursor === id) {
              hit = i;
              break;
            }
          } catch {
            // 坏行跳过
          }
        }
        if (hit < 0) continue;
        lines.splice(hit, 1);
        const kept = lines.filter((line) => line.trim());
        if (!kept.length) {
          // 那天只有这一条，删完就把空文件收掉，免得归档里留个 0 行的日期
          unlinkSync(file);
        } else {
          writeAtomic(file, `${kept.join('\n')}\n`);
        }
        return true;
      } catch {
        // 读不了就试下一个文件
      }
    }
    return false;
  }

  /** 热数据里的旧格式已经由 load() 的 rewrite 抹掉了，这里只处理 archive/ 下的文件。 */
  scrubArchiveSenders(): number {
    let changed = 0;
    for (const { file } of this.archiveFiles()) {
      try {
        const lines = readFileSync(file, 'utf8').split('\n');
        let dirty = false;
        const out = lines.map((line) => {
          if (!line.trim()) return line;
          try {
            const e = JSON.parse(line) as RawEntry;
            const masked = maskSender(e.sender);
            if (masked === e.sender) return line;
            e.sender = masked;
            dirty = true;
            changed += 1;
            return JSON.stringify(e);
          } catch {
            return line;
          }
        });
        if (dirty) writeAtomic(file, out.join('\n'));
      } catch {
        // 读不了就跳过
      }
    }
    return changed;
  }

  /** 归档总行数。健康面板按需调用，不进热路径。 */
  archiveLines(): number {
    let n = 0;
    for (const f of this.archiveFiles()) {
      try {
        n += readFileSync(f.file, 'utf8').split('\n').filter((line) => line.trim()).length;
      } catch {
        // 读不了就跳过
      }
    }
    return n;
  }

  /** 翻归档：默认最近 30 天，最多 8000 行。只给 mode=archive 用，不进常规召回。 */
  readArchive(days = 30, maxEntries = 8000): RawEntry[] {
    const span = Math.max(1, Math.min(365, Number(days) || 30));
    const fromDay = dayKeyOf(new Date(Date.now() - span * 86_400_000).toISOString());
    const out: RawEntry[] = [];
    for (const { day, file } of this.archiveFiles(true)) {
      if (out.length >= maxEntries) break;
      if (day < fromDay) continue;
      try {
        for (const line of readFileSync(file, 'utf8').split('\n')) {
          if (!line.trim()) continue;
          try {
            const e = JSON.parse(line) as RawEntry;
            if (e && typeof e.text === 'string') {
              e.sender = maskSender(e.sender);
              out.push(e);
            }
          } catch {
            // 跳过坏行
          }
          if (out.length >= maxEntries) break;
        }
      } catch {
        // ignore
      }
    }
    return out.sort((a, b) => a.cursor - b.cursor);
  }

  private rewrite(): void {
    writeAtomic(this.file, this.entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
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

  /** cursor 是宿主分配的单调节，拿它排最可靠；ts 在补录数据里不一定跟 cursor 同序。 */
  private sortEntries(): void {
    this.entries.sort((a, b) => a.cursor - b.cursor);
  }

  add(items: RawEntry[]): number {
    if (!items.length) return 0;
    // 回放时一次几千行，用 Set 判重，别拿 some() 平方级扫
    const have = new Set(this.entries.map((e) => e.cursor));
    const fresh = items
      .filter((item) => !have.has(item.cursor))
      // 落盘前统一脱敏：不管调用方传的是原始 key 还是已脱敏的，这里都兜一道
      .map((item) => ({ ...item, sender: maskSender(item.sender) }));
    if (!fresh.length) return 0;
    this.entries.push(...fresh);
    const cutoff = Date.now() - this.retentionDays * 86_400_000;
    const keep: RawEntry[] = [];
    const expired: RawEntry[] = [];
    for (const e of this.entries) {
      const at = Date.parse(e.ts);
      if (!Number.isFinite(at) || at < cutoff) expired.push(e);
      else keep.push(e);
    }
    // 超过 4000 行的老行也归档，不丢
    if (keep.length > 4000) {
      const over = keep.length - 4000;
      expired.push(...keep.slice(0, over));
      this.entries = keep.slice(over);
    } else {
      this.entries = keep;
    }
    if (expired.length) this.archive(expired);
    this.sortEntries();
    // 只把「还在热数据里」的新行写文件。过期的新行已经进归档了，留在 turns.jsonl 里
    // 会让下次启动再归档一遍（回放时会重复写）。
    const hot = new Set(this.entries.map((e) => e.cursor));
    const writable = fresh.filter((e) => hot.has(e.cursor));
    if (writable.length) {
      try {
        appendFileSync(this.file, writable.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
      } catch {
        // ignore
      }
    }
    return writable.length;
  }
}
