/**
 * 检索：纯本地词法打分，不调模型、不花 token。
 * 中文按二元组 + 单字、英文数字按词切；分数 = 命中 + 权重 + 新鲜度 - 反复使用惩罚。
 */
import type { Card, RawEntry } from './store.ts';

const STOP = new Set(
  '的了是在我你他她它和就都也不吗呢啊吧有会要说过这个那个把被给对说着地得然后还又很太吗嘛哦呀'.split(''),
);

/**
 * 预激活专用：这些双字词在对话里到处都是，命中它们不代表「说到同一件事」。
 * 不在这里挡，「今天好累」会把一堆不相干的卡推上来。
 * 只影响 minBigrams 的计数，不影响普通召回打分。
 */
const PRIME_STOP = new Set(
  ('今天 明天 昨天 后天 晚上 中午 早上 上午 下午 夜里 现在 刚才 刚刚 回来 回去 出来 起来 一下 一点 一起 '
    + '时候 然后 真的 可以 什么 怎么 觉得 应该 已经 还是 就是 因为 所以 但是 如果 不过 而且 '
    + '你们 我们 他们 自己 东西 事情 一个 有点 不是 没有 知道 看到 说过 感觉 需要 之前 之后').split(' '),
);

/** 预激活只认「实词」：含有虚词的二元组（不是/不能/来了/的号）一律不算线索。 */
export function isContentToken(token: string): boolean {
  if (token.length < 2) return false;
  if (PRIME_STOP.has(token)) return false;
  for (const ch of token) if (STOP.has(ch)) return false;
  return true;
}

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

/** BM25 参数：k1 控制词频饱和，b 控制长度归一。都是常用值。 */
const BM25_K1 = 1.2;
const BM25_B = 0.75;

/**
 * 给整个候选池建一次倒排：每张卡的词频、长度、以及每个词出现在几张卡里。
 * 卡片数量级是几十到几百，一次构建比「每个词去 includes 一遍」更省。
 */
function buildIndex(pool: readonly Card[]) {
  const df = new Map<string, number>();
  const tf = new Map<string, Map<string, number>>();
  const len = new Map<string, number>();
  let total = 0;
  for (const card of pool) {
    const tokens = tokenize(card.text);
    const local = new Map<string, number>();
    for (const t of tokens) local.set(t, (local.get(t) ?? 0) + 1);
    tf.set(card.id, local);
    len.set(card.id, tokens.length);
    total += tokens.length;
    for (const t of local.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  }
  return { df, tf, len, avg: pool.length ? total / pool.length || 1 : 1, n: pool.length };
}

/** 一张卡的 BM25 分。字面越贴、词越罕见、卡越短，分越高。 */
function bm25(index: ReturnType<typeof buildIndex>, card: Card, tokens: readonly string[]): number {
  const local = index.tf.get(card.id);
  if (!local) return 0;
  const dl = index.len.get(card.id) ?? 0;
  let sum = 0;
  for (const token of new Set(tokens)) {
    const f = local.get(token);
    if (!f) continue;
    const df = index.df.get(token) ?? 0;
    const idf = Math.log(1 + (index.n - df + 0.5) / (df + 0.5));
    sum += (idf * (f * (BM25_K1 + 1))) / (f + BM25_K1 * (1 - BM25_B + (BM25_B * dl) / index.avg));
  }
  return sum;
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
  /**
   * 只保留真的被线索命中的卡（关键词或标签重叠 > 0）。
   * 每轮预激活必须开这个：否则一张高权重的无关卡会靠 weight 混进「想起来了」。
   */
  requireHit?: boolean;
  /**
   * 至少命中几个「双字以上」的词。中文单字太容易撞（今/天/好），
   * 只靠 requireHit 的话「今天好累」能把半库都捞上来。
   */
  minBigrams?: number;
}

export interface ScoredCard {
  card: Card;
  score: number;
  /** 词面重叠（归一化后） */
  lexical: number;
  /** 标签命中 */
  tagHit: number;
  /** 命中了几个「实词二元组」——比分数更好解释「像不像」 */
  bigrams: number;
  /** strong = 真的对上了，weak = 只是靠权重/新鲜度浮上来的 */
  tier: 'strong' | 'weak';
}

/**
 * 和 rankCards 同一套打分，但把分数和判断依据一起返回。
 * 召回要分两档口气，就靠这里的 tier，不在外面重新算一遍。
 */
export function rankCardsScored(cards: readonly Card[], opts: RankOptions): ScoredCard[] {
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
    return pool.slice(0, opts.limit).map((card) => ({
      card,
      score: 0,
      lexical: 0,
      tagHit: 0,
      bigrams: 0,
      tier: 'strong' as const,
    }));
  }
  // 「今天」「回来」这类词到处都是，命中它们不算线索。文档频率只能挡掉极端常见的，
  // 挡不住「今天」（5/66）这种——所以再加一张停用词表。
  const common = new Set<string>();
  if (opts.minBigrams) {
    const cap = Math.max(3, Math.ceil(pool.length * 0.3));
    for (const token of new Set(queryTokens)) {
      if (token.length < 2) continue;
      let n = 0;
      for (const c of pool) {
        if (`${c.text} ${c.tags.join(' ')}`.toLowerCase().includes(token)) {
          n += 1;
          if (n > cap) break;
        }
      }
      if (n > cap) common.add(token);
    }
  }
  // 标签也过一遍 IDF：出现在三成以上卡里的标签（「日常」「工作」）不该算命中
  const commonTag = new Set<string>();
  {
    const cap = Math.max(3, Math.ceil(pool.length * 0.3));
    const df = new Map<string, number>();
    for (const c of pool) for (const t of c.tags ?? []) df.set(t, (df.get(t) ?? 0) + 1);
    for (const [tag, n] of df) if (n > cap) commonTag.add(tag);
  }

  const index = buildIndex(pool);
  const scored = pool.map((card) => {
    // BM25 取代原来的「二元组命中数 / 长度」：词频和长度都归一过了，
    // 一句话里反复出现同一个词不会把分堆爆，长卡也不会因为词多而虚高。
    const lexical = bm25(index, card, queryTokens);
    // 标签单独算一次：对方说「生日」时，打了 #生日 的卡要比正文里顺嘴提到的排得靠前。
    // 但泛标签会把所有卡都拉高，所以先剔掉「到处都是」的那些。
    const weakTags = card.tags.filter((t) => !commonTag.has(t));
    const tagHit = weakTags.length ? overlap(queryTokens, weakTags.join(' ')) : 0;
    // 同一张卡被反复召回只做有限的边际压制（封顶 8 次），别让常用的重要记忆越用越沉
    const used = Math.min(card.uses || 0, 8) * 0.03;
    // 最近被想起过的卡给一点小加成：三个月没动过的旧卡不该把上周刚聊过的挤下去。
    // 权重刻意压得很小（0.15 上限），压不倒一个关键词命中（2 分）。
    const lastUsed = Date.parse(card.lastUsedAt ?? '');
    const glow =
      opts.useAging && Number.isFinite(lastUsed)
        ? 0.15 * Math.exp(-(now - lastUsed) / (30 * 86_400_000))
        : 0;
    // BM25 的量级是 0~25，乘 0.25 压回和旧版相近的比例：正文相关仍占主导，
    // 但权重 / 新鲜度 / 用进废退还能在近似分数之间起作用。
    const score = lexical * 0.25 + tagHit * 1.2 + card.weight * 0.5 + freshness(card.createdAt, now) + glow - used;
    // 双字以上的命中数：预激活用它挡单字噪音
    const hay = `${card.text} ${card.tags.join(' ')}`.toLowerCase();
    let bigrams = 0;
    for (const token of new Set(queryTokens)) {
      if (isContentToken(token) && !common.has(token) && hay.includes(token)) bigrams += 1;
    }
    return { card, score, lexical, tagHit, hit: lexical > 0 || tagHit > 0, bigrams };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored
    .filter((x) => x.score > 0.25 && (!opts.requireHit || x.hit) && (!opts.minBigrams || x.bigrams >= opts.minBigrams))
    .slice(0, opts.limit)
    .map((x) => ({
      ...x,
      // 两个实词对上、或一个实词且词面确实重合，才算「对得上」；
      // 只靠权重和新鲜度浮上来的，一律算「可能沾边」。
      // 分档靠「实词命中数」而不是裸分：BM25 在「今天」这种高频词上也会给分，
      // 但停用词表已经把这类词从 bigrams 里剔掉了，用它分档才不会被带偏。
      tier: (x.bigrams >= 2 || (x.bigrams >= 1 && x.lexical >= 2.2) || x.tagHit >= 0.6
        ? 'strong'
        : 'weak') as 'strong' | 'weak',
    }));
}

export function rankCards(cards: readonly Card[], opts: RankOptions): Card[] {
  return rankCardsScored(cards, opts).map((x) => x.card);
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
