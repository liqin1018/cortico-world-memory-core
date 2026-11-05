/**
 * 检索：纯本地词法打分，不调模型、不花 token。
 * 中文按二元组 + 单字、英文数字按词切；分数 = 命中 + 权重 + 新鲜度 - 反复使用惩罚。
 */
import type { Card, RawEntry } from './store.ts';

const STOP = new Set(
  '的了是在我你他她它和就都也不吗呢啊吧有会要说过这个那个把被给对说着地得然后还又很太吗嘛哦呀'.split(''),
);

export function tokenize(text: string): string[] {
  const norm = String(text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  if (!norm) return [];
  const out: string[] = [];
  for (const word of norm.split(/\s+/)) {
    if (!word) continue;
    if (/^[a-z0-9]+$/.test(word)) {
      out.push(word);
      continue;
    }
    for (let i = 0; i < word.length; i += 1) {
      const ch = word[i];
      if (!STOP.has(ch)) out.push(ch);
      if (i + 1 < word.length) out.push(word.slice(i, i + 2));
    }
  }
  return out;
}

/** 供工作区文件检索复用：同一套切词与命中打分。 */
export function scoreText(queryTokens: readonly string[], text: string): number {
  return overlap(queryTokens, text);
}

function overlap(queryTokens: readonly string[], text: string): number {
  if (!queryTokens.length) return 0;
  const hay = String(text ?? '').toLowerCase();
  let sum = 0;
  for (const token of new Set(queryTokens)) {
    if (!hay.includes(token)) continue;
    sum += token.length > 1 ? 1.4 : 0.18;
  }
  return sum / Math.sqrt(new Set(queryTokens).size + 1);
}

function freshness(iso: string | undefined, now: number): number {
  const at = Date.parse(iso ?? '');
  if (!Number.isFinite(at)) return 0;
  const days = Math.max(0, (now - at) / 86_400_000);
  return 1.1 * Math.exp(-days / 45);
}

export interface RankOptions {
  query?: string;
  kind?: string;
  days?: number;
  limit: number;
  now?: number;
  /** 是否参考「上次被想起的时间」。关掉就退回只看关键词、标签、权重和新鲜度。 */
  useAging?: boolean;
}

export function rankCards(cards: readonly Card[], opts: RankOptions): Card[] {
  const now = opts.now ?? Date.now();
  const queryTokens = tokenize(opts.query ?? '');
  let pool = cards.filter((c) => {
    if (opts.kind && c.kind !== opts.kind) return false;
    if (opts.days && opts.days > 0) {
      const at = Date.parse(c.createdAt);
      if (Number.isFinite(at) && now - at > opts.days * 86_400_000) return false;
    }
    return true;
  });
  if (!queryTokens.length) {
    pool = [...pool].sort((a, b) => {
      const sa = freshness(a.createdAt, now) + a.weight * 0.6;
      const sb = freshness(b.createdAt, now) + b.weight * 0.6;
      return sb - sa;
    });
    return pool.slice(0, opts.limit);
  }
  const scored = pool.map((card) => {
    const lexical = overlap(queryTokens, card.text);
    // 标签单独算一次：对方说「生日」时，打了 #生日 的卡要比正文里顺嘴提到的排得靠前
    const tagHit = card.tags.length ? overlap(queryTokens, card.tags.join(' ')) : 0;
    // 同一张卡被反复召回只做有限的边际压制（封顶 8 次），别让常用的重要记忆越用越沉
    const used = Math.min(card.uses || 0, 8) * 0.03;
    // 最近被想起过的卡给一点小加成：三个月没动过的旧卡不该把上周刚聊过的挤下去。
    // 权重刻意压得很小（0.15 上限），压不倒一个关键词命中（2 分）。
    const lastUsed = Date.parse(card.lastUsedAt ?? '');
    const glow =
      opts.useAging && Number.isFinite(lastUsed)
        ? 0.15 * Math.exp(-(now - lastUsed) / (30 * 86_400_000))
        : 0;
    const score = lexical * 2 + tagHit * 1.2 + card.weight * 0.5 + freshness(card.createdAt, now) + glow - used;
    return { card, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.filter((x) => x.score > 0.25).slice(0, opts.limit).map((x) => x.card);
}

export function rankRaw(entries: readonly RawEntry[], query: string, limit: number): RawEntry[] {
  const queryTokens = tokenize(query);
  if (!queryTokens.length) return [];
  const scored = entries.map((entry) => ({
    entry,
    score: overlap(queryTokens, entry.text) * 2 + freshness(entry.ts, Date.now()) * 0.4,
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.filter((x) => x.score > 0.8).slice(0, limit).map((x) => x.entry);
}
