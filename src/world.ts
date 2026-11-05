/**
 * 记忆核心：四套记忆合成的一套。
 * 一张卡片表 + 4 个工具 + 一段静态提示词 + 自己的状态与日程 + 主动开口。
 *
 * 省 token 的三条硬约束（改代码时别破坏）：
 *  1) envPromptVars() 只返回常量，前缀永远不变 → 缓存命中率高；
 *  2) 不每轮推送状态，只有 contextEveryMin>0 才推，默认 0；
 *  3) 主动开口有「对方最近说过话」这道闸，避免对着空房间调用模型。
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ToolDef, World, WorldHost, WorldWebUiDecl } from 'cortico/core/types.ts';
import type { WorldContext } from 'cortico/world.ts';
import { MEMORY_CORE_CONFIG_GROUP, MEMORY_CORE_DEFAULTS, type MemoryCoreConfig } from './config.ts';
import { TOOL_SPECS } from './tools.ts';
import {
  CARD_KINDS,
  CardStore,
  RawLog,
  ensureDir,
  maskSender,
  readJson,
  writeJson,
  type CardKind,
  type CoreState,
  type PlanItem,
  type RawEntry,
} from './store.ts';
import { importLegacy } from './importer.ts';
import { rankCards, rankCardsScored, rankRaw } from './recall.ts';
import { advance, createInitialState, moodLabel } from './state.ts';
import { formatLocal, hmToMinutes, humanSpan, inWindow, localParts } from './time.ts';
import { MemorySite, type HealthReport, type ImportReport, type Snapshot } from './site.ts';
import { expandDirs, loadDocs, searchDocs } from './workspace.ts';

const ENV_PROMPT_FILE = fileURLToPath(new URL('../ENV_PROMPT.md', import.meta.url));
const WEB_DIR = fileURLToPath(new URL('../webui/', import.meta.url));
const TICK_MS = 60_000;
/** 同一张卡两次「主动想起」之间至少隔这么久，别每轮都推同一条。 */
const PRIME_COOLDOWN_MS = 2 * 3_600_000;
/** 对方那句话超过这么久就不算「刚说的」，不拿它做预激活。 */
const PRIME_FRESH_MS = 10 * 60_000;

/**
 * 捕获水位的可信版本号。
 * v1 用 `range({fromCursor, limit})` 分页，但宿主的 limit 是「从区间末尾取」，
 * 一次就把水位推到历史末尾、前面的全跳过。升到 v2 后旧水位作废，自动重放一遍。
 */
const CAPTURE_WATERMARK_VERSION = 2;
/** 一次 range 的窗口宽度。cursor 是全局连续的，按窗口边界推进，窗口内没有匹配也能往前走。
 *  取大一点：宿主每次 range 都要遍历一遍分片，窗口太碎会让回放变成几百次全表扫描。 */
const CAPTURE_BATCH = 2_000;

function clip(text: string, limit: number): string {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > limit ? `${s.slice(0, limit)}…` : s;
}

function num(value: unknown, fallback: number, lo: number, hi: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

function str(value: unknown, limit = 200): string {
  return typeof value === 'string' ? clip(value, limit) : '';
}

/**
 * 事件正文外层常裹着东西，剥干净的才是对方说的话：
 *  - `[星邮消息] {"text":"..."}` —— JSON 壳；
 *  - `[11-03 周二 18:04] [typed] 月:在吗` —— 宿主加的抬头（时间 / 输入方式 / 说话人）；
 *  - `【QQ私聊 22:37 月(QQ:1940008084)】：#-479828398 有点` —— QQ 那层壳 + 消息号；
 *  - `[23:34] [answer] 月回答「…」:选了第 1 项「…」` —— 选项卡的答案，只留选了什么。
 */
function extractUserText(raw: string): string {
  let text = String(raw ?? '').trim();
  const m = /^\[[^\]]{0,12}消息\]\s*(\{[\s\S]*\})$/.exec(text);
  if (m) {
    try {
      const obj = JSON.parse(m[1]) as Record<string, unknown>;
      for (const key of ['text', 'message', 'content', 'msg']) {
        const v = obj[key];
        if (typeof v === 'string' && v.trim()) {
          text = v.trim();
          break;
        }
      }
    } catch {
      // 不是 JSON 就按原样
    }
  }
  // 宿主给每层壳的顺序不固定（【】、#消息号、[时间] [输入方式]、说话人:），
  // 一轮一轮剥到不再变化为止；名字那一步排除数字开头，免得把「18:30 开会」吃掉。
  let out = text;
  for (let i = 0; i < 4; i += 1) {
    const next = out
      .replace(/^【[^】]{0,40}】[:：]?\s*/, '')
      .replace(/^#-?\d+\s*/, '')
      .replace(/^\[[^\]]{0,24}\]\s*/, '')
      .replace(/^(?![\[\d])[^\s:：\d]{1,12}[:：]\s*/, '');
    if (next === out) break;
    out = next;
  }
  return out
    .replace(/^[^「」]{0,6}回答「[^」]{0,80}」[:：]\s*/, '')
    .replace(/^自己写了[:：]\s*/, '')
    .trim();
}

export class MemoryCoreWorld implements World {
  readonly id = 'memory-core';
  private readonly ctx: WorldContext<MemoryCoreConfig>;
  private host: WorldHost | null = null;
  private readonly dataDir: string;
  private readonly store: CardStore;
  private readonly raw: RawLog;
  private state: CoreState;
  private plans: PlanItem[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private ticking = false;
  private lastUserProbe = 0;
  private lastUserAt: number | null = null;
  /** 对方最近说的那一句（游标 + 文本）：预激活拿它当线索，写卡拿它当出处。 */
  private lastTurn: { cursor: number; text: string; at: number } | null = null;
  /** 已经为哪一句做过预激活，同一句不重复推。 */
  private primedFor = '';
  private lastContextAt = 0;
  private lastSaveAt = 0;
  private site: MemorySite | null = null;
  private siteOrigin: string | null = null;

  constructor(ctx: WorldContext<MemoryCoreConfig>) {
    this.ctx = ctx;
    const base = typeof ctx.dataDir === 'string' && ctx.dataDir ? ctx.dataDir : '.';
    this.dataDir = join(base, 'memory-core');
    ensureDir(this.dataDir);
    this.store = new CardStore(this.dataDir);
    this.raw = new RawLog(
      this.dataDir,
      Math.max(1, Number(ctx.cfg?.rawRetentionDays ?? 7)),
      Math.max(0, Number(ctx.cfg?.rawArchiveDays ?? 90)),
    );
    this.state = createInitialState(new Date(), this.tz(), this.cfg());
    this.load();
  }

  private cfg(): MemoryCoreConfig {
    return this.ctx.cfg;
  }

  private tz(): string {
    return this.ctx.timezone || 'Asia/Shanghai';
  }

  /**
   * 周期提醒的天数。老部署的 config.json 里没有这个键（宿主只在首次激活时写入默认值），
   * 所以不能直接 Number(undefined)，要回落到默认值。
   */
  private promiseRepeat(): number {
    const raw = this.cfg().promiseRepeatDays;
    if (raw === undefined || raw === null) return MEMORY_CORE_DEFAULTS.promiseRepeatDays;
    return Math.max(0, Number(raw) || 0);
  }

  /** 老部署的 config.json 没有 preactivateLines 这个键，缺省时回落到默认值而不是 0。 */
  private preactivateCount(): number {
    const raw = this.cfg().preactivateLines;
    if (raw === undefined || raw === null) return MEMORY_CORE_DEFAULTS.preactivateLines;
    return Math.min(3, Math.max(0, Number(raw) || 0));
  }

  /** 同样的坑：缺这个键时 Number(undefined) 是 NaN，会把冷层静默关掉。 */
  private chillDays(): number {
    const raw = this.cfg().chillAfterDays;
    if (raw === undefined || raw === null) return MEMORY_CORE_DEFAULTS.chillAfterDays;
    return Math.max(0, Number(raw) || 0);
  }

  private load(): void {
    try {
      const raw = readJson<Partial<CoreState> | null>(join(this.dataDir, 'state.json'), null);
      if (raw && typeof raw === 'object') {
        this.state = { ...createInitialState(new Date(), this.tz(), this.cfg()), ...raw };
      }
      const plans = readJson<PlanItem[]>(join(this.dataDir, 'plans.json'), []);
      this.plans = Array.isArray(plans) ? plans.filter((p) => p && typeof p.title === 'string') : [];
    } catch {
      // 读不出来就用初始状态
    }
  }

  private save(force = false): void {
    const now = Date.now();
    if (!force && now - this.lastSaveAt < 15_000) return;
    this.lastSaveAt = now;
    writeJson(join(this.dataDir, 'state.json'), this.state);
    writeJson(join(this.dataDir, 'plans.json'), this.plans);
  }

  // ---- World 契约 ----

  /** 前缀必须稳定：这里只回常量，不塞时间/计数，否则每次变动都会让整段缓存失效。 */
  envPromptVars(): Record<string, string> {
    return {};
  }

  tools(): ToolDef[] {
    return TOOL_SPECS.map((spec) => ({
      ...spec,
      handler: async (args: Record<string, unknown>) => this.dispatch(spec.name, args ?? {}),
    }));
  }

  webUi(): WorldWebUiDecl {
    const cfg = this.cfg();
    const stats = this.store.stats();
    const count = this.countToday();
    return {
      label: '记忆核心',
      lamps: [
        {
          label: '记忆',
          state: cfg.memoryEnabled ? 'online' : 'offline',
          hint: cfg.memoryEnabled
            ? `${stats.total} 条在用的${stats.retired ? ` · ${stats.retired} 条已退休` : ''}`
            : '已关闭',
        },
        {
          label: '主动开口',
          state: cfg.proactiveEnabled ? 'online' : 'offline',
          hint: cfg.proactiveEnabled ? this.dueHint() : '已关闭',
        },
        {
          label: '对话原文',
          state: cfg.captureTurns ? 'online' : 'offline',
          hint: cfg.captureTurns
            ? `${this.raw.size} 行，近 ${cfg.rawRetentionDays} 天${
                this.raw.stats().days ? ` · 归档 ${this.raw.stats().days} 天` : ''
              }`
            : '已关闭',
        },
      ],
      badges: [
        { label: '今日主动', value: `${count}/${cfg.proactiveDailyCap || '∞'}` },
        { label: '精力', value: Math.round(this.state.energy), tone: this.state.energy < 35 ? 'off' : 'on' },
        { label: '记忆', value: stats.total },
      ],
      promptDocs: [
        {
          key: 'worlds.memory-core.envPrompt',
          title: '记忆核心 · 环境提示词',
          description: '进 system 前缀的那一段，没有占位符：改这里不会影响其他插件，但会让前缀重算一次。',
          path: ENV_PROMPT_FILE,
          role: 'envPrompt',
        },
      ],
      config: [MEMORY_CORE_CONFIG_GROUP],
      links: this.siteOrigin
        ? [{ label: '记忆地图 · 图谱与时间线', href: this.siteOrigin, inheritTheme: true }]
        : [],
      storage: [
        {
          key: 'memory-core-data',
          label: '卡片 / 对话原文 / 状态 / 日程',
          kind: 'disk',
          location: this.dataDir,
          danger: true,
          note: '清空后卡片、对话原文、状态与日程都不在了（导入过就会重新导入旧记忆）。',
          stat: () => `卡片 ${stats.total} 条 · 对话原文 ${this.raw.size} 行 · 日程 ${this.plans.length} 项`,
          clear: () => {
            this.store.reset();
            this.raw.reset();
            this.plans = [];
            this.state = createInitialState(new Date(), this.tz(), this.cfg());
            this.save(true);
            return '已清空。';
          },
        },
      ],
    };
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    this.stopped = false;
    ensureDir(this.dataDir);
    this.importOnce();
    // 归档里可能还留着老格式的明文账号，抹一次就够（热数据在 load 时已经抹了）
    if (!this.state.senderScrubbedAt) {
      const scrubbed = this.raw.scrubArchiveSenders();
      this.state.senderScrubbedAt = new Date().toISOString();
      this.save(true);
      if (scrubbed) {
        try {
          host.log?.info?.(`[memory-core] 归档里 ${scrubbed} 条来源已脱敏`);
        } catch {
          // 日志失败不影响挂载
        }
      }
    }
    try {
      host.log?.info?.('[memory-core] 启动', {
        dataDir: this.dataDir,
        cards: this.store.stats().total,
        raw: this.raw.size,
      });
    } catch {
      // 日志失败不影响挂载
    }
    await this.tick(true);
    this.timer = setInterval(() => {
      void this.tick(false);
    }, TICK_MS);
    this.timer.unref?.();
    this.save(true);
    await this.startSite();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.save(true);
    this.store.save(true);
    await this.site?.stop();
    this.site = null;
    this.siteOrigin = null;
    this.host = null;
  }

  // ---- 记忆地图站点 ----

  private async startSite(): Promise<void> {
    if (!this.cfg().siteEnabled) return;
    try {
      this.site = new MemorySite(this.siteHooks(), WEB_DIR, Number(this.cfg().sitePort) || 7801);
      this.siteOrigin = await this.site.start();
      if (this.siteOrigin) {
        try {
          this.host?.log?.info?.('[memory-core] 记忆地图已启动', { origin: this.siteOrigin });
        } catch {
          // 日志失败不影响挂载
        }
      }
    } catch (error) {
      this.site = null;
      try {
        this.host?.log?.warn?.('[memory-core] 记忆地图启动失败', String(error));
      } catch {
        // ignore
      }
    }
  }

  private docs(): ReturnType<typeof loadDocs> {
    const cfg = this.cfg();
    if (!cfg.workspaceScanEnabled) return [];
    return loadDocs({
      dirs: cfg.workspaceDirs,
      exts: cfg.workspaceExts,
      maxFiles: Number(cfg.workspaceMaxFiles) || 300,
      maxFileKB: Number(cfg.workspaceMaxFileKB) || 256,
      botDir: this.ctx.botDir,
    });
  }

  private snapshot(): Snapshot {
    const all = this.store.all();
    const cards = this.store.active();
    const now = Date.now();
    const day = (ts: string) => formatLocal(ts, this.tz()).slice(0, 10);
    const today = formatLocal(new Date(now), this.tz()).slice(0, 10);
    const byKind: Record<string, number> = {};
    const tagCount = new Map<string, number>();
    const dayCount = new Map<string, number>();
    let weightSum = 0;
    for (const card of cards) {
      byKind[card.kind] = (byKind[card.kind] || 0) + 1;
      weightSum += card.weight;
      for (const tag of card.tags) tagCount.set(tag, (tagCount.get(tag) || 0) + 1);
      const d = day(card.createdAt);
      dayCount.set(d, (dayCount.get(d) || 0) + 1);
    }
    const byDay: Array<{ day: string; n: number }> = [];
    for (let i = 13; i >= 0; i -= 1) {
      const d = formatLocal(new Date(now - i * 86_400_000), this.tz()).slice(0, 10);
      byDay.push({ day: d, n: dayCount.get(d) || 0 });
    }
    const open = cards.filter((c) => c.kind === 'promise' && !c.done);
    const docs = this.docs();
    const cfg = this.cfg();
    const origin = this.site?.origin ?? this.siteOrigin ?? '';
    return {
      now: new Date().toISOString(),
      cards: all,
      turns: this.raw.all(),
      plans: this.plans,
      state: this.state,
      proactive: {
        enabled: Boolean(cfg.proactiveEnabled),
        count: this.countToday(),
        cap: Number(cfg.proactiveDailyCap) || 0,
        dueAt: this.state.proactiveDueAt ?? null,
        lastTalkAt: this.state.lastTalkAt ?? null,
      },
      stats: {
        total: cards.length,
        retired: all.length - cards.length,
        byKind,
        openPromises: open.length,
        overdue: open.filter((c) => c.dueAt && Date.parse(c.dueAt) <= now).length,
        todayNew: dayCount.get(today) || 0,
        weekNew: byDay.slice(7).reduce((sum, x) => sum + x.n, 0),
        avgWeight: cards.length ? weightSum / cards.length : 0,
        tags: [...tagCount.entries()].sort((a, b) => b[1] - a[1]).map(([tag, n]) => ({ tag, n })).slice(0, 40),
        byDay,
        scopes: this.store.scopes(),
      },
      docs: { enabled: Boolean(cfg.workspaceScanEnabled), count: docs.length, dirs: cfg.workspaceScanEnabled ? expandDirs(cfg.workspaceDirs, this.ctx.botDir) : [] },
      archive: { ...this.raw.stats(), retention: Math.max(0, Number(cfg.rawArchiveDays) || 0) },
      site: { port: origin ? Number(new URL(origin).port) : 0, origin },
    };
  }

  private siteHooks() {
    return {
      snapshot: () => this.snapshot(),
      docs: () => this.docs(),
      docRoots: () => expandDirs(this.cfg().workspaceDirs, this.ctx.botDir),
      createCard: (input: Record<string, unknown>) => {
        const kind = String(input.kind ?? 'note') as CardKind;
        if (!CARD_KINDS.includes(kind)) throw new Error('kind 只能是 fact / self / episode / promise / note');
        const text = String(input.text ?? '').replace(/\s+/g, ' ').trim();
        if (!text) throw new Error('内容不能为空');
        const dueAt = input.dueAt ? String(input.dueAt).replace(' ', 'T') : undefined;
        const res = this.store.add({
          kind,
          text,
          weight: num(input.weight, 0.5, 0, 1),
          tags: Array.isArray(input.tags) ? (input.tags as unknown[]).map((t) => String(t)) : [],
          dueAt,
          source: 'map',
          origin: 'map',
        });
        return res.card;
      },
      updateCard: (id: string, patch: Record<string, unknown>) => {
        const current = this.store.find(id);
        if (!current) return undefined;
        const next: Record<string, unknown> = {};
        const text = typeof patch.text === 'string' ? patch.text.replace(/\s+/g, ' ').trim().slice(0, 500) : '';
        if (patch.kind !== undefined) {
          const kind = String(patch.kind) as CardKind;
          if (!CARD_KINDS.includes(kind)) throw new Error('kind 不合法');
          next.kind = kind;
        }
        if (patch.weight !== undefined) next.weight = num(patch.weight, 0.5, 0, 1);
        if (Array.isArray(patch.tags)) {
          next.tags = (patch.tags as unknown[]).map((t) => String(t).slice(0, 20)).filter(Boolean).slice(0, 8);
        }
        if (patch.dueAt !== undefined) next.dueAt = patch.dueAt ? String(patch.dueAt).replace(' ', 'T') : undefined;
        if (patch.done !== undefined) next.done = Boolean(patch.done);
        if (patch.scope !== undefined) next.scope = String(patch.scope).slice(0, 24) || 'main';
        // 内容变了不覆盖：追加一版，旧的标退休并指向新版，可回滚
        if (text && text !== current.text) {
          const fresh = this.store.revise(id, text, 'edit');
          if (!fresh) return undefined;
          return Object.keys(next).length ? this.store.update(fresh.id, next) : fresh;
        }
        return this.store.update(id, next);
      },
      deleteCard: (id: string) => this.store.retire(id, 'manual') !== undefined,
      retireCard: (id: string) => this.store.retire(id, 'manual') !== undefined,
      restoreCard: (id: string) => this.store.restore(id) !== undefined,
      lineage: (id: string) => this.store.lineage(id),
      maintenance: () => ({
        dupes: this.store.duplicates().map((g) => ({ score: g.score, ids: g.cards.map((c) => c.id) })),
        stale: this.store.stale().map((c) => c.id),
        junk: this.store.junk().map((c) => c.id),
        retired: this.store.retired().map((c) => c.id),
        promises: {
          noDue: this.store.promisesWithoutDue().map((c) => c.id),
          overdue: this.store
            .active()
            .filter((c) => c.kind === 'promise' && !c.done && c.dueAt && Date.parse(c.dueAt) <= Date.now())
            .map((c) => c.id),
        },
      }),
      health: () => this.healthReport(),
      importData: (payload: Record<string, unknown>) => this.importBackup(payload),
      archiveSearch: (q: string, days: number, limit: number) => {
        const query = String(q ?? '').trim();
        if (!query) return [];
        const span = Math.min(3650, Math.max(1, Number(days) || 90));
        const cap = Math.min(50, Math.max(1, Number(limit) || 40));
        return rankRaw(this.raw.readArchive(span, 20000), query, cap);
      },
      deleteTurn: (cursor: number) => this.raw.remove(cursor),
      mergeCards: (keepId: string, dropIds: string[]) => this.store.merge(keepId, dropIds),
      purgeCards: (ids: string[]) => this.store.purge(ids),
      chillCards: (ids: string[]) =>
        this.store.chill(
          ids.length ? ids : this.store.chillEligible(this.chillDays(), Date.now()).map((c) => c.id),
        ),
      warmCards: (ids: string[]) => this.store.warm(ids.length ? ids : this.store.cold().map((c) => c.id)),
      patchState: (input: Record<string, unknown>) => {
        if (input.energy !== undefined) this.state.energy = num(input.energy, this.state.energy, 0, 100);
        if (input.mood !== undefined) this.state.mood = num(input.mood, this.state.mood, 0, 100);
        if (typeof input.activity === 'string' && input.activity.trim()) this.state.activity = clip(input.activity, 40);
        if (typeof input.location === 'string') this.state.location = clip(input.location, 40);
        if (input.sleeping !== undefined) {
          this.state.sleeping = input.sleeping === true;
          if (this.state.sleeping) this.state.activity = '睡觉';
        }
        this.state.updatedAt = new Date().toISOString();
        this.save(true);
        return this.state;
      },
      planAction: (input: Record<string, unknown>) => {
        this.handlePlan({ action: input.action, items: input.items, id: input.id, time: input.time, title: input.title, place: input.place });
        return { plans: this.plans };
      },
      exportAll: (fmt: string) => this.exportAll(fmt),
    };
  }

  private exportAll(fmt: string): { body: string; mime: string; filename: string } {
    const stamp = formatLocal(new Date(), this.tz()).replace(/[: ]/g, '-').slice(0, 16);
    const live = [...this.store.active()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const cards = [...this.store.all()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (fmt === 'md') {
      const title: Record<string, string> = {
        fact: '关于你',
        self: '关于我',
        episode: '一起经历过',
        promise: '答应过的事',
        note: '临时记下的',
      };
      const retired = this.store.stats().retired;
      const lines = [`# 记忆核心 · ${live.length} 条${retired ? `（另有 ${retired} 条已退休）` : ''}`, ''];
      for (const kind of CARD_KINDS) {
        const group = live.filter((c) => c.kind === kind);
        if (!group.length) continue;
        lines.push(`## ${title[kind]}（${group.length}）`, '');
        for (const card of group) {
          const when = formatLocal(card.createdAt, this.tz()).slice(0, 10);
          const meta = [`${when}`, `权重 ${card.weight.toFixed(2)}`, card.tags.length ? card.tags.map((t) => `#${t}`).join(' ') : '']
            .filter(Boolean)
            .join(' · ');
          const due = card.dueAt ? `（${card.done ? '已完成' : '未完成'} · 截止 ${formatLocal(card.dueAt, this.tz())}）` : '';
          lines.push(`- ${card.text}${due}`, `  <sub>${meta}</sub>`);
        }
        lines.push('');
      }
      return { body: lines.join('\n'), mime: 'text/markdown', filename: `memory-core-${stamp}.md` };
    }
    return {
      body: JSON.stringify(
        {
          exportedAt: new Date().toISOString(),
          cards,
          turns: this.raw.all(),
          plans: this.plans,
          state: this.state,
        },
        null,
        2,
      ),
      mime: 'application/json',
      filename: `memory-core-${stamp}.json`,
    };
  }

  /** 一轮结束：对方刚说过话才把下一次主动往后推，否则内部 turn 会把 dueAt 一路推没。 */
  /** 健康面板：只报事实，不猜。给的是「现在库长什么样」，不是评分。 */
  private healthReport(): HealthReport {
    const now = Date.now();
    const all = this.store.all();
    const live = this.store.active();
    const day = (ts: string) => formatLocal(ts, this.tz()).slice(0, 10);
    // 被用过 = 工具召回 + 每轮预激活。只算前者会把「系统主动想起过」的卡误判成死卡
    const touched = (c: { uses?: number; primedCount?: number }) => (c.uses || 0) + (c.primedCount || 0);
    const dead = live.filter((c) => touched(c) === 0 && now - Date.parse(c.createdAt) > 7 * 86_400_000);
    const count = new Map<string, number>();
    for (const c of live) {
      const d = day(c.createdAt);
      count.set(d, (count.get(d) || 0) + 1);
    }
    const perDay: Array<{ day: string; n: number }> = [];
    for (let i = 13; i >= 0; i -= 1) {
      const d = formatLocal(new Date(now - i * 86_400_000), this.tz()).slice(0, 10);
      perDay.push({ day: d, n: count.get(d) || 0 });
    }
    const open = live.filter((c) => c.kind === 'promise' && !c.done);
    const rawStats = this.raw.stats();
    return {
      generatedAt: new Date().toISOString(),
      cards: { total: all.length, active: live.length, retired: all.length - live.length, dead: dead.length },
      recall: {
        calls: live.reduce((n, c) => n + (c.uses || 0), 0),
        cardsTouched: live.filter((c) => touched(c) > 0).length,
        primed: live.reduce((n, c) => n + (c.primedCount || 0), 0),
      },
      perDay,
      promises: {
        open: open.length,
        overdue: open.filter((c) => c.dueAt && Date.parse(c.dueAt) <= now).length,
        noDue: open.filter((c) => !c.dueAt).length,
        repeating: this.promiseRepeat(),
      },
      raw: { lines: this.raw.size, archivedDays: rawStats.days, archivedLines: this.raw.archiveLines() },
      backup: this.store.backupInfo(),
      chill: {
        cold: this.store.cold().length,
        eligible: this.store.chillEligible(this.chillDays(), now).length,
        afterDays: this.chillDays(),
      },
      deadIds: dead.map((c) => c.id),
      coldIds: this.store.cold().map((c) => c.id),
    };
  }

  /**
   * 导入备份。只加不覆盖：已有的卡片按 id 或「同类型 + 同文本」跳过。
   * state 只接 rawWatermark 而且只往前推——水位倒回去会把已经录过的原文再录一遍。
   */
  private importBackup(payload: Record<string, unknown>): ImportReport {
    const warnings: string[] = [];
    const data = (payload.data && typeof payload.data === 'object' ? payload.data : payload) as Record<string, unknown>;
    if (!Array.isArray(data.cards)) warnings.push('没有 cards 字段，只导入了原文和日程。');
    const cards = this.store.importCards(Array.isArray(data.cards) ? data.cards : []);

    const turnsIn = Array.isArray(data.turns) ? data.turns : [];
    const entries: RawEntry[] = [];
    let badTurns = 0;
    for (const raw of turnsIn) {
      const t = (raw ?? {}) as Partial<RawEntry>;
      const cursor = Number(t.cursor);
      if (!Number.isFinite(cursor) || typeof t.text !== 'string' || !t.text.trim()) {
        badTurns += 1;
        continue;
      }
      entries.push({
        cursor,
        ts: typeof t.ts === 'string' && t.ts ? t.ts : new Date().toISOString(),
        sender: maskSender(String(t.sender ?? 'import')).slice(0, 40),
        text: t.text.slice(0, 200),
      });
    }
    const addedTurns = this.raw.add(entries);

    const plansIn = Array.isArray(data.plans) ? data.plans : [];
    let plansAdded = 0;
    let plansSkipped = 0;
    for (const raw of plansIn) {
      const p = (raw ?? {}) as Partial<PlanItem>;
      const title = typeof p.title === 'string' ? p.title.trim() : '';
      const time = typeof p.time === 'string' ? p.time.trim() : '';
      if (!title || !time) {
        plansSkipped += 1;
        continue;
      }
      if (this.plans.some((x) => x.time === time && x.title === title)) {
        plansSkipped += 1;
        continue;
      }
      this.plans.push({
        id: typeof p.id === 'string' && p.id ? p.id : randomUUID(),
        time,
        title,
        place: typeof p.place === 'string' ? p.place : undefined,
        done: p.done === true,
      });
      plansAdded += 1;
    }
    if (plansAdded) this.save(true);

    let watermark = Number(this.state.rawWatermark ?? 0) || 0;
    const st = data.state as Partial<CoreState> | undefined;
    const incoming = Number(st?.rawWatermark);
    if (Number.isFinite(incoming) && incoming > watermark) {
      watermark = incoming;
      this.state.rawWatermark = watermark;
      this.save(true);
    }
    if (badTurns) warnings.push(`${badTurns} 行原文格式不对，已跳过。`);
    if (turnsIn.length && addedTurns === 0) warnings.push('原文都是已有的，没有新增。');
    return {
      cards,
      turns: { added: addedTurns, skipped: turnsIn.length - addedTurns },
      plans: { added: plansAdded, skipped: plansSkipped },
      state: { watermark },
      warnings,
    };
  }

  onTurnEnded(): void {
    const now = new Date();
    this.lastUserProbe = 0;
    const lastUser = this.probeLastUser(now.getTime());
    if (!lastUser || now.getTime() - lastUser > 10 * 60_000) return;
    this.state.lastTalkAt = now.toISOString();
    this.state.proactiveDueAt = this.nextDue(now).toISOString();
    this.save(true);
    // 回合结束时就把下一轮要用的记忆推上去：心跳 60 秒一次，短对话根本等不到它
    void this.maybePreactivate(now).catch(() => {
      // 推送失败不影响这一轮
    });
    // 夜里备好的整理材料，趁这次开口交付
    void this.deliverNightly().catch(() => {
      // 同上
    });
  }

  // ---- 工具实现 ----

  private async dispatch(name: string, args: Record<string, unknown>): Promise<string> {
    try {
      if (name === 'mcore_write') return this.handleWrite(args);
      if (name === 'mcore_recall') return this.handleRecall(args);
      if (name === 'mcore_state') return this.handleState(args);
      if (name === 'mcore_plan') return this.handlePlan(args);
      return `未知工具：${name}`;
    } catch (error) {
      return `执行失败：${error instanceof Error ? error.message : String(error)}`;
    }
  }

  private handleWrite(args: Record<string, unknown>): string {
    if (!this.cfg().memoryEnabled) return '记忆已关闭（设置页里可以打开）。';
    const kind = String(args.kind ?? '') as CardKind;
    if (!CARD_KINDS.includes(kind)) return 'kind 只能是 fact / self / episode / promise / note。';
    const text = str(args.text, 500);
    if (!text) return 'text 不能为空。';
    const dueAtRaw = str(args.dueAt, 40).trim();
    // 没有时间的承诺等于永远不提醒；但也不能逼模型编一个时间。
    // 所以给一条明确出口：确实没有截止时间就写 none，当成「无截止」存下来，体检页可以补。
    const undated = /^(none|null|无|没有|无截止)$/i.test(dueAtRaw);
    if (kind === 'promise' && !dueAtRaw) {
      return '承诺必须带 dueAt（ISO 时间，例如 2026-11-06T07:20）。不知道具体时间就问对方一句；确实没有截止时间就写 dueAt:"none"。';
    }
    const dueAt = undated ? undefined : dueAtRaw.replace(' ', 'T');
    // 出处：写这条时最近的一句对方原话。半小时内才算，太久就对不上了
    this.probeLastUser(Date.now());
    const src =
      this.lastTurn && Date.now() - this.lastTurn.at < 30 * 60_000
        ? { cursor: this.lastTurn.cursor, ts: new Date(this.lastTurn.at).toISOString() }
        : undefined;
    const res = this.store.add({
      kind,
      text,
      weight: num(args.weight, 0.5, 0, 1),
      tags: Array.isArray(args.tags) ? (args.tags as unknown[]).map((t) => String(t)) : [],
      dueAt,
      source: 'tool',
      origin: 'tool',
      ...(src ? { src } : {}),
    });
    let extra = '';
    const closes = str(args.closes, 60);
    if (closes) {
      const target = this.findCard(closes);
      if (target && target.id !== res.card.id) {
        // 旧的那条不再参与检索，但留在库里可回溯（血缘挂在「新卡接替了谁」上）
        if (target.kind === 'promise') this.store.close(target.id);
        this.store.supersede(target.id, res.card);
        extra = '，被它替代的那条已经收起来';
      } else {
        extra = '，但要关的记录没找到';
      }
    }
    return `已记下（${kind}${res.merged ? '，与已有记录合并' : ''}）${extra}。共 ${this.store.stats().total} 条。`;
  }

  private findCard(prefix: string): { id: string; kind: string } | undefined {
    if (!prefix) return undefined;
    return this.store.find(prefix) ?? this.store.all().find((c) => c.id.startsWith(prefix)) ?? undefined;
  }

  private handleRecall(args: Record<string, unknown>): string {
    if (!this.cfg().memoryEnabled) return '记忆已关闭（设置页里可以打开）。';
    const query = str(args.query, 200);
    const mode = String(args.mode ?? (query ? 'search' : 'recent'));
    const limit = num(args.limit, Number(this.cfg().recallLimit) || 5, 1, 12);
    const maxChars = num(this.cfg().recallMaxChars, 600, 120, 2000);
    const tz = this.tz();
    const lines: string[] = [];
    const push = (line: string) => {
      if (lines.join('\n').length > maxChars) return;
      lines.push(line);
    };

    if (mode === 'open') {
      const open = this.store.openPromises(limit);
      if (open.length) {
        lines.push('【没做完的承诺】');
        for (const c of open) {
          const due = c.dueAt ? ` 截止 ${formatLocal(c.dueAt, tz)}` : '';
          push(`· ${c.id.slice(0, 8)} ${clip(c.text, 90)}${due}`);
        }
      }
      const today = this.plans.filter((p) => !p.done);
      if (today.length) {
        lines.push('【今天的安排】');
        for (const p of today) push(`· ${p.time} ${clip(p.title, 40)}${p.place ? `（${p.place}）` : ''}`);
      }
      return lines.length ? lines.join('\n') : '没有未完成的事。';
    }

    if (mode === 'archive') {
      if (!query) return '翻归档要带 query，给几个关键词。';
      const span = num(args.days, 30, 1, 3650);
      const hits = rankRaw(this.raw.readArchive(span), query, Math.max(1, Math.min(limit, 8)));
      if (!hits.length) return `归档里没找到「${clip(query, 20)}」。`;
      const out: string[] = ['【归档原文】'];
      for (const hit of hits) out.push(`· [${formatLocal(hit.ts, tz).slice(0, 10)}] ${clip(hit.text, 110)}`);
      return out.join('\n').slice(0, maxChars + 40);
    }

    const ranked = rankCardsScored(mode === 'search' ? this.store.active() : this.store.recallable(), {
      query: mode === 'search' ? query : undefined,
      kind: str(args.kind, 20) || undefined,
      days: num(args.days, 0, 0, 3650) || undefined,
      limit,
      useAging: this.cfg().recallUseAging !== false,
    });
    const cards = ranked.map((x) => x.card);
    const strongIds = new Set(ranked.filter((x) => x.tier === 'strong').map((x) => x.card.id));

    if (mode === 'search' && query) {
      const hits = rankRaw(this.raw.all(), query, Math.max(1, Math.min(3, limit)));
      for (const hit of hits) {
        push(`· [对话 ${formatLocal(hit.ts, tz).slice(5)}] ${clip(hit.text, 90)}`);
      }
      if (this.cfg().workspaceScanEnabled && lines.join('\n').length < maxChars) {
        const docHits = searchDocs(this.docs(), query, 2);
        for (const hit of docHits) {
          push(`· [文件 ${clip(hit.file.rel, 40)}] ${clip(hit.snippet, 90)}`);
        }
      }
    }

    const withSrc = cards.filter((c) => c.src);
    if (withSrc.length) push('（↩ 是写它时最近的那句原话；卡片本身是改写的）');
    if (cards.some((c) => c.coldAt)) push('（❄ 是很久没被想起的旧记忆，仅供参考）');

    const cardLine = (card: (typeof cards)[number]) => {
      const tag = card.kind === 'fact' ? '' : `（${card.kind}）`;
      const when = card.src ? formatLocal(card.src.ts, tz).slice(5, 10) : '';
      const mark = when ? ` ↩${when}` : '';
      const cold = card.coldAt ? '❄' : '';
      // 行首这 8 位就是 id：改口/作废时要用它传给 mcore_write 的 closes
      return `· ${card.id.slice(0, 8)} ${cold}${formatLocal(card.createdAt, tz).slice(5)} ${clip(card.text, 110)}${tag}${mark}`;
    };

    // 搜出来的分两档：真对得上的，和只是靠权重/新鲜度浮上来的。
    // 不分档的话，模型会把「有点像」当成「就是」，这也是它编故事的起点。
    if (mode === 'search' && query && cards.length) {
      const strong = cards.filter((c) => strongIds.has(c.id));
      const weak = cards.filter((c) => !strongIds.has(c.id));
      if (strong.length) {
        push('【对得上】');
        for (const card of strong) push(cardLine(card));
        if (weak.length) {
          push('【可能沾边，别当准】');
          for (const card of weak) push(cardLine(card));
        }
      } else {
        // 一条都没真对上时，别拿五条沾边的充数：明说没有，最多给两条线索
        push('【没有对得上的，下面只是沾边】');
        for (const card of weak.slice(0, 2)) push(cardLine(card));
      }
    } else {
      for (const card of cards) push(cardLine(card));
    }
    this.store.touch(cards.map((c) => c.id));
    return lines.length ? lines.join('\n') : '没有找到相关的记忆。';
  }

  private handleState(args: Record<string, unknown>): string {
    const action = String(args.action ?? 'get');
    const now = new Date();
    if (action === 'rest') {
      this.state.sleeping = true;
      this.state.activity = '睡觉';
      this.state.energy = Math.min(100, this.state.energy + 4);
      this.state.proactiveDueAt = new Date(now.getTime() + 90 * 60_000).toISOString();
      this.save(true);
      return '去睡了，精力回来一点。';
    }
    if (action === 'update') {
      if (args.energy !== undefined) this.state.energy = num(args.energy, this.state.energy, 0, 100);
      if (args.mood !== undefined) this.state.mood = num(args.mood, this.state.mood, 0, 100);
      if (args.activity !== undefined) this.state.activity = str(args.activity, 40) || this.state.activity;
      if (args.location !== undefined) this.state.location = str(args.location, 40) || this.state.location;
      if (args.sleeping !== undefined) {
        this.state.sleeping = args.sleeping === true;
        if (this.state.sleeping) this.state.activity = '睡觉';
      }
      this.state.updatedAt = now.toISOString();
      this.save(true);
    }
    const stats = this.store.stats();
    const dueAt = this.state.proactiveDueAt ? formatLocal(this.state.proactiveDueAt, this.tz()).slice(11) : '未安排';
    const count = this.countToday();
    return [
      `精力 ${Math.round(this.state.energy)}/100，心情 ${moodLabel(this.state.mood)}，正在${this.state.activity}${this.state.location ? `，在${this.state.location}` : ''}。`,
      `下次主动约 ${dueAt}；今天已主动 ${count}/${this.cfg().proactiveDailyCap || '∞'} 次。`,
      `记忆 ${stats.total} 条，对话原文 ${this.raw.size} 行。`,
    ].join('\n');
  }

  private handlePlan(args: Record<string, unknown>): string {
    const action = String(args.action ?? 'list');
    if (action === 'add') {
      // 参数是平的（time/title/place）；老调用方传 items 数组也认，一次最多 8 项
      const list: unknown[] = Array.isArray(args.items)
        ? args.items
        : args.time || args.title
          ? [{ time: args.time, title: args.title, place: args.place }]
          : [];
      let added = 0;
      for (const raw of list.slice(0, 8)) {
        const item = raw as Record<string, unknown>;
        const time = str(item.time, 5);
        const title = str(item.title, 40);
        if (!time || !title || hmToMinutes(time) === null) continue;
        this.plans.push({ id: randomUUID(), time, title, place: str(item.place, 30) || undefined });
        added += 1;
      }
      this.plans.sort((a, b) => (hmToMinutes(a.time) ?? 0) - (hmToMinutes(b.time) ?? 0));
      this.save(true);
      return added ? `加了 ${added} 项，今天共 ${this.plans.filter((p) => !p.done).length} 项。` : '没有有效的项（time 用 HH:MM，title 不能空）。';
    }
    if (action === 'done') {
      const id = str(args.id, 60);
      const hit = this.plans.find((p) => p.id === id || p.id.startsWith(id));
      if (!hit) return '没找到这一项。';
      hit.done = true;
      this.save(true);
      return `「${hit.title}」标成做完了。`;
    }
    if (action === 'clear') {
      this.plans = [];
      this.save(true);
      return '日程清空了。';
    }
    if (!this.plans.length) return '今天没有安排。';
    return this.plans
      .map((p) => `· ${p.id.slice(0, 8)} ${p.time} ${p.done ? '✓ ' : ''}${p.title}${p.place ? `（${p.place}）` : ''}`)
      .join('\n');
  }

  // ---- 内部 ----

  private importOnce(): void {
    const marker = join(this.dataDir, 'imported.json');
    if (existsSync(marker)) return;
    try {
      const report = importLegacy({ dataDir: this.ctx.dataDir, store: this.store });
      writeJson(marker, report);
      try {
        this.host?.log?.info?.('[memory-core] 旧记忆导入完成', report.sources);
      } catch {
        // ignore
      }
    } catch (error) {
      try {
        this.host?.log?.warn?.('[memory-core] 导入失败', String(error));
      } catch {
        // ignore
      }
    }
  }

  private async tick(force: boolean): Promise<void> {
    if (this.ticking) return;
    if (this.stopped && !force) return;
    this.ticking = true;
    try {
      const now = new Date();
      advance(this.state, now, this.tz(), this.cfg());
      this.capture(
        Boolean(this.cfg().captureBackfill)
        && (Number(this.state.watermarkVersion ?? 0) < CAPTURE_WATERMARK_VERSION || !this.state.backfillDoneAt),
      );
      await this.maybeContext(now);
      await this.maybePreactivate(now);
      await this.maybeRemind(now);
      await this.maybeProactive(now);
      await this.maybeNightly(now);
      this.maybeChill(now);
      this.save();
    } catch (error) {
      try {
        this.host?.log?.warn?.('[memory-core] tick 失败', String(error));
      } catch {
        // ignore
      }
    } finally {
      this.ticking = false;
    }
  }

  /**
   * 白名单正则。老版本默认值 `^(starpost\.private\.|qq\.|desktop-pet\.message)` 一个真实 key 都匹配不上
   * （实际是 `private:1940008084`、`desktop-pet.chat` 这种），读到这个旧默认就换成新的，免得用户
   * 明明没动过设置却一直录不到东西。
   */
  private senderRe(cfg: MemoryCoreConfig): RegExp {
    const raw = String(cfg.captureSenders ?? '').trim();
    const legacy = '^(starpost\\.private\\.|qq\\.|desktop-pet\\.message)';
    const pattern = !raw || raw === legacy ? MEMORY_CORE_DEFAULTS.captureSenders : raw;
    try {
      return new RegExp(pattern);
    } catch {
      return new RegExp(MEMORY_CORE_DEFAULTS.captureSenders);
    }
  }

  /**
   * 从宿主的 external 事件流里捞对方说的话。
   *
   * 宿主 `range` 的语义有两处容易踩：`limit` 是**从区间末尾取**，不是从头取；
   * 只有不传 fromCursor 时才走「倒着凑最近 N 条」的快路径。所以拿
   * `{fromCursor, limit}` 当分页会一次跳到历史末尾——v1 就是这么把 2.5 万条
   * 外对话全跳过的。这里改用 toCursor 开窗，一窗一窗往前推。
   */
  private capture(backfill = false): void {
    const cfg = this.cfg();
    const host = this.host;
    if (!cfg.captureTurns || !host?.store) return;
    const re = this.senderRe(cfg);
    // 旧版水位是按错的 limit 语义推出来的，不可信：重放一遍
    if (backfill && Number(this.state.watermarkVersion ?? 0) < CAPTURE_WATERMARK_VERSION) {
      this.state.rawWatermark = 0;
      this.state.watermarkVersion = CAPTURE_WATERMARK_VERSION;
      this.state.backfillStartedAt = new Date().toISOString();
      this.state.backfillDoneAt = undefined;
    }
    // 区间上界：只取最后一条，读一个分片就够
    let head = 0;
    try {
      const last = host.store.range({ limit: 1 });
      head = last.length ? last[0].cursor : 0;
    } catch {
      return;
    }
    let from = Number(this.state.rawWatermark ?? 0) || 0;
    if (from > head) from = 0; // 宿主换过数据目录，cursor 从头开始
    const minLen = Math.max(1, Number(cfg.captureMinLength) || 4);
    const items: RawEntry[] = [];
    const keys = new Set<string>();
    let scanned = 0;
    // 实时每拍最多追 4 窗（2000 条）防积压；回放一次最多 400 窗（20 万条）
    const budget = backfill ? 400 : 4;
    let rounds = 0;
    let drained = from >= head;
    while (!drained && rounds < budget) {
      rounds += 1;
      const to = Math.min(from + CAPTURE_BATCH, head);
      let events: readonly { cursor: number; ts: string; senderKey?: string; text: string }[] = [];
      try {
        events = host.store.range({ fromCursor: from + 1, toCursor: to, origin: 'external' });
      } catch {
        break;
      }
      scanned += events.length;
      for (const e of events) {
        const key = e.senderKey ?? '';
        if (!re.test(key)) {
          // 记几个被挡掉的 key，出问题时一眼能看出是白名单还是正文的问题
          if (key && keys.size < 6) keys.add(key);
          continue;
        }
        const text = clip(extractUserText(e.text), 200);
        // 单字、纯表情、`[取消]` 这类系统回执、图片 blob 描述，都不进原文库
        if (!text || text.length < minLen) continue;
        if (/\[blob\b/i.test(text)) continue;
        if (/^\[(表情包|CQ:|图片)/.test(text)) continue;
        if (/^[\p{P}\p{S}\s]+$/u.test(text)) continue;
        if (/^\[[^\]]{0,12}\]$/.test(text.trim())) continue;
        items.push({ cursor: e.cursor, ts: e.ts, sender: maskSender(key).slice(0, 40), text });
      }
      // 按窗口边界推进，不按「最后一个匹配到的 cursor」：窗口里可能一条 external 都没有
      from = to;
      if (from >= head) drained = true;
    }
    this.raw.add(items);
    this.state.rawWatermark = from;
    if (backfill && drained) this.state.backfillDoneAt = new Date().toISOString();
    if (scanned || items.length) {
      this.state.captureDebug = {
        at: new Date().toISOString(),
        scanned,
        kept: items.length,
        keys: items.length ? [] : [...keys],
        ...(backfill && !drained ? { backfillFrom: from, backfillTo: head } : {}),
      };
    }
  }

  private countToday(): number {
    const day = localParts(new Date(), this.tz()).date;
    return this.state.proactiveDay === day ? Number(this.state.proactiveCount ?? 0) : 0;
  }

  private nextDue(now: Date): Date {
    const cfg = this.cfg();
    const gap = Math.max(5, Number(cfg.proactiveMinGapMin) || 100);
    const jitter = Math.max(0, Number(cfg.proactiveJitterMin) || 0);
    const extra = Math.round(Math.random() * jitter);
    return new Date(now.getTime() + (gap + extra) * 60_000);
  }

  private dueHint(): string {
    if (!this.state.proactiveDueAt) return '未安排';
    return `下次约 ${formatLocal(this.state.proactiveDueAt, this.tz()).slice(11)}`;
  }

  /** 最近一次「有人跟我说话」的时间；30 秒缓存，避免每拍扫事件库。 */
  private probeLastUser(now: number): number | null {
    if (now - this.lastUserProbe < 30_000) return this.lastUserAt;
    this.lastUserProbe = now;
    try {
      let re: RegExp;
      try {
        re = new RegExp(this.cfg().captureSenders || '^(starpost\\.private\\.|qq\\.)');
      } catch {
        re = /^(starpost\.private\.|qq\.)/;
      }
      const events = this.host?.store?.range({ origin: 'external', limit: 60 }) ?? [];
      let best = 0;
      let bestText = '';
      let bestCursor = -1;
      for (const e of events) {
        if (!re.test(e.senderKey ?? '')) continue;
        const t = Date.parse(e.ts);
        if (Number.isFinite(t) && t > best) {
          best = t;
          bestText = String(e.text ?? '');
          bestCursor = Number(e.cursor ?? -1);
        }
      }
      this.lastUserAt = best ? best : null;
      // 只留最近这一句：太旧的不算「刚说的」，预激活会误触发
      this.lastTurn = best && bestText.trim()
        ? { at: best, text: bestText, cursor: Number.isFinite(bestCursor) ? bestCursor : -1 }
        : null;
    } catch {
      this.lastUserAt = null;
      this.lastTurn = null;
    }
    return this.lastUserAt;
  }

  private async push(
    type: string,
    text: string,
    trigger: 'piggyback' | 'flush' | 'preempt',
    tags?: readonly 'snapshot'[],
  ): Promise<boolean> {
    if (!this.host) return false;
    try {
      await this.host.pushEvent(
        {
          type,
          ts: new Date().toISOString(),
          source: this.id,
          origin: 'internal',
          text,
          ...(tags ? { tags } : {}),
        },
        { trigger },
      );
      return true;
    } catch (error) {
      try {
        this.host.log?.warn?.('[memory-core] 推送失败', String(error));
      } catch {
        // ignore
      }
      return false;
    }
  }

  private async maybeContext(now: Date): Promise<void> {
    const everyMin = Number(this.cfg().contextEveryMin) || 0;
    if (everyMin <= 0) return;
    if (now.getTime() - this.lastContextAt < everyMin * 60_000) return;
    this.lastContextAt = now.getTime();
    const line = `（你现在：${this.state.activity}${this.state.location ? `，在${this.state.location}` : ''}，精力 ${Math.round(this.state.energy)}，心情${moodLabel(this.state.mood)}）`;
    await this.push('mcore.context', line, 'piggyback', ['snapshot']);
  }

  /**
   * 每轮预激活：拿对方刚说的这句当线索，把 2–3 条旧记忆推到眼前。
   * 这是「不靠模型自觉」的那一环——工具召回要模型主动想起来问，预激活不用。
   * 只给一行摘要，细节仍然要它自己调 mcore_recall 来要。
   */
  private async maybePreactivate(now: Date): Promise<void> {
    const cfg = this.cfg();
    const lines = this.preactivateCount();
    if (!lines || !cfg.memoryEnabled) return;
    const turn = this.lastTurn;
    if (!turn || turn.text.trim().length < 4) return;
    if (now.getTime() - turn.at > PRIME_FRESH_MS) return;
    // 有 cursor 就用 cursor，没有就退回时间戳——不能因为宿主不给 cursor 就永远不推
    const key = turn.cursor >= 0 ? `c${turn.cursor}` : `t${turn.at}`;
    if (this.primedFor === key) return;

    const picked = rankCards(this.store.recallable(), {
      // 太长的消息会把线索稀释掉，只取开头一段当查询
      query: turn.text.slice(0, 200),
      limit: 8,
      useAging: cfg.recallUseAging !== false,
      requireHit: true,
      minBigrams: 1,
    })
      .filter((c) => {
        const last = Date.parse(c.lastPrimedAt ?? '');
        return !Number.isFinite(last) || now.getTime() - last > PRIME_COOLDOWN_MS;
      })
      .slice(0, lines);
    if (!picked.length) return;

    const tz = this.tz();
    const body = picked.map((c) => `· ${clip(c.text, 60)}（${formatLocal(c.createdAt, tz).slice(5, 10)}）`).join('\n');
    const ok = await this.push(
      'mcore.prime',
      `（以前记下的，不是对方刚说的：\n${body}）`,
      'piggyback',
    );
    if (!ok) return;
    this.primedFor = key;
    this.store.prime(picked.map((c) => c.id));
  }

  private async maybeRemind(now: Date): Promise<void> {
    const due = this.store.duePromises(now.getTime(), this.promiseRepeat());
    if (!due.length) return;
    const lastUser = this.probeLastUser(now.getTime());
    if (this.cfg().requireRecentUserHours > 0) {
      const hours = Number(this.cfg().requireRecentUserHours);
      if (!lastUser || now.getTime() - lastUser > hours * 3_600_000) return;
    }
    const card = due[0];
    const ok = await this.push('mcore.due', `（答应过的事到点了：${clip(card.text, 80)}）该提一句了。`, 'flush');
    if (!ok) return;
    this.store.update(card.id, { remindedAt: now.toISOString() });
  }

  private async maybeProactive(now: Date): Promise<void> {
    const cfg = this.cfg();
    if (!cfg.proactiveEnabled) return;
    const p = localParts(now, this.tz());
    const due = this.state.proactiveDueAt ? Date.parse(this.state.proactiveDueAt) : 0;
    if (Number.isFinite(due) && due > now.getTime()) return;

    const defer = (minutes: number) => {
      this.state.proactiveDueAt = new Date(now.getTime() + minutes * 60_000).toISOString();
      this.save();
    };

    if (this.state.sleeping || inWindow(p.minutes, cfg.sleepStart, cfg.sleepEnd)) {
      defer(45);
      return;
    }
    if (inWindow(p.minutes, cfg.quietStart, cfg.quietEnd)) {
      defer(40);
      return;
    }
    const cap = Number(cfg.proactiveDailyCap) || 0;
    const count = this.countToday();
    if (cap > 0 && count >= cap) {
      defer(60);
      return;
    }
    const lastUser = this.probeLastUser(now.getTime());
    const recentHours = Number(cfg.requireRecentUserHours) || 0;
    if (recentHours > 0 && (!lastUser || now.getTime() - lastUser > recentHours * 3_600_000)) {
      // 没人在就不开口，等下一个小时再看；这条是省 token 的关键。
      defer(30);
      return;
    }
    const gate = Number(cfg.idleGateMin) || 0;
    if (lastUser && gate > 0 && now.getTime() - lastUser < gate * 60_000) {
      defer(Math.ceil((gate * 60_000 - (now.getTime() - lastUser)) / 60_000) + 1);
      return;
    }

    const since = lastUser ? humanSpan(now.getTime() - lastUser) : null;
    const reason = this.reasonFor(now);
    const text = `（由头：${formatLocal(now, this.tz()).slice(11)}，你${this.state.activity}`
      + `${this.state.location ? `，在${this.state.location}` : ''}，精力 ${Math.round(this.state.energy)}`
      + `${since ? `；上次说话是 ${since} 前` : ''}。${reason}）想主动跟对方说一句，别问「在吗」，直接说你此刻的事。`;
    const ok = await this.push('mcore.wake', text, 'flush');
    if (!ok) {
      defer(15);
      return;
    }
    this.state.proactiveDay = p.date;
    this.state.proactiveCount = count + 1;
    this.state.proactiveDueAt = this.nextDue(now).toISOString();
    this.save(true);
  }

  private reasonFor(now: Date): string {
    const p = localParts(now, this.tz());
    const open = this.store.openPromises(3);
    if (open.length) return `上次没做完：${clip(open[0].text, 60)}。`;
    const upcoming = this.plans
      .filter((item) => !item.done && (hmToMinutes(item.time) ?? 0) >= p.minutes)
      .sort((a, b) => (hmToMinutes(a.time) ?? 0) - (hmToMinutes(b.time) ?? 0))[0];
    if (upcoming) return `你打算 ${upcoming.time} ${upcoming.title}。`;
    if (p.hour >= 22) return '天晚了，你想在睡前说一句。';
    if (p.hour >= 6 && p.hour < 9) return '刚醒，你想看看对方起了没。';
    if (this.state.energy < 35) return '你有点累，想说说话缓一缓。';
    if (this.state.mood < 40) return '你心情有点低落，想被陪一会儿。';
    return '你闲下来，忽然想到对方。';
  }

  /**
   * 夜里把当天的原文收成一份材料，等下次开口再交付。
   * 原来是在凌晨三点直接推「去整理一下」——那个点没人说话，推送就躺在历史里没人接。
   */
  private async maybeNightly(now: Date): Promise<void> {
    const cfg = this.cfg();
    if (!cfg.nightlyConsolidate) return;
    const p = localParts(now, this.tz());
    // 过了设定的小时之后的第一笔心跳就跑，不要求正好整点：进程早上才起来也能补
    if (p.hour < (Number(cfg.nightlyHour) || 3)) return;
    if (this.state.lastNightlyDay === p.date) return;

    const done = () => {
      this.state.lastNightlyDay = p.date;
      this.save(true);
    };

    const since = now.getTime() - 86_400_000;
    const turns = this.raw.all().filter((e) => (Date.parse(e.ts) || 0) >= since);
    // 一天不到四句，没什么可整的
    if (turns.length < 4) return done();
    // 白天已经自己写了 3 条以上，说明模型记得，别再催
    const wroteToday = this.store
      .active()
      .filter((c) => c.source === 'tool' && formatLocal(c.createdAt, this.tz()).slice(0, 10) === p.date).length;
    if (wroteToday >= 3) return done();

    const body = turns.slice(-40).map((e) => `· ${clip(e.text, 60)}`).join('\n');
    this.state.nightlyPending = { day: p.date, text: clip(body, 1100) };
    done();
  }

  /** 有备好的整理材料，就趁这次开口交付（回合结束时调用）。 */
  private async deliverNightly(): Promise<void> {
    const pending = this.state.nightlyPending;
    if (!pending) return;
    const today = formatLocal(new Date(), this.tz()).slice(0, 10);
    const age = (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${pending.day}T00:00:00Z`)) / 86_400_000;
    // 放太久就别再翻旧账了
    if (!Number.isFinite(age) || age > 2) {
      delete this.state.nightlyPending;
      this.save();
      return;
    }
    const ok = await this.push(
      'mcore.nightly',
      `（昨天留下的这些，顺手整理一下：最多写 3 条；能写成 fact 就别写成 episode；有承诺就带 dueAt；库里已有的别重复。\n${pending.text}）`,
      'piggyback',
    );
    if (!ok) return;
    delete this.state.nightlyPending;
    this.save(true);
  }

  /** 每天判一次冷层：只标记，不删除。 */
  private maybeChill(now: Date): void {
    const days = this.chillDays();
    if (!days) return;
    const today = formatLocal(now, this.tz()).slice(0, 10);
    if (this.state.lastChillDay === today) return;
    this.state.lastChillDay = today;
    const ids = this.store.chillEligible(days, now.getTime()).map((c) => c.id);
    if (ids.length) this.store.chill(ids);
    this.save();
  }
}
