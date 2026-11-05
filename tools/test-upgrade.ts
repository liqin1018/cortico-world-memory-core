/**
 * 0.4.0 的回归：原子写与备份、导入、承诺闭环、体检。
 * 跑法：node --experimental-transform-types tools/test-upgrade.ts
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CardStore, RawLog } from '../src/store.ts';
import { rankCards, rankRaw } from '../src/recall.ts';
import { MemoryCoreWorld } from '../src/world.ts';
import { MEMORY_CORE_DEFAULTS } from '../src/config.ts';

let bad = 0;
const ok = (cond: boolean, msg: string) => {
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${msg}`);
  if (!cond) bad += 1;
};

/* 1) 原子写：不留 .tmp，内容完整 */
{
  const dir = mkdtempSync(join(tmpdir(), 'mcore-atom-'));
  const store = new CardStore(dir);
  store.add({ kind: 'fact', text: '第一条用来验证原子写' });
  store.save(true);
  const file = join(dir, 'cards.jsonl');
  ok(existsSync(file), '1) cards.jsonl 写出来了');
  ok(!existsSync(`${file}.tmp`), '1) 没有残留 .tmp');
  ok(readFileSync(file, 'utf8').trim().split('\n').length === 1, '1) 行数正确');
}

/* 2) 每日备份：第二次写触发备份，轮转只留 7 份 */
{
  const dir = mkdtempSync(join(tmpdir(), 'mcore-bak-'));
  const store = new CardStore(dir);
  store.add({ kind: 'fact', text: '写入第一条' });
  store.save(true);
  store.add({ kind: 'fact', text: '写入第二条触发备份' });
  store.save(true);
  const backups = readdirSync(join(dir, 'backups')).filter((f) => /^cards-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f));
  ok(backups.length === 1, `2) 当天生成 1 份备份（实际 ${backups.length}）`);
  for (let i = 1; i <= 9; i += 1) {
    writeFileSync(join(dir, 'backups', `cards-2026-01-${String(i).padStart(2, '0')}.jsonl`), '{}\n', 'utf8');
  }
  (store as unknown as { backupDay: string }).backupDay = '';
  store.add({ kind: 'fact', text: '第三次写入触发轮转' });
  store.save(true);
  const left = readdirSync(join(dir, 'backups')).filter((f) => /^cards-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f));
  ok(left.length === 7, `2) 轮转后留 7 份（实际 ${left.length}）`);
}

/* 3) 导入：同 id / 同文本都跳过，已有内容不被覆盖 */
{
  const dir = mkdtempSync(join(tmpdir(), 'mcore-imp-'));
  const store = new CardStore(dir);
  const first = store.add({ kind: 'fact', text: '她是西安人，不吃香菜。' }).card;
  store.add({ kind: 'episode', text: '昨天一起去吃了泡馍。' });
  const res = store.importCards([
    { ...first, text: '被改过的文本不该覆盖库里那条' },
    { kind: 'episode', text: '昨天一起去吃了泡馍。' },
    { kind: 'fact', text: '她养了一只叫年糕的猫。', createdAt: '2026-10-01T10:00:00.000Z', weight: 0.7 },
  ]);
  ok(res.added === 1 && res.skipped === 2, `3) 导入 1 条、跳过 2 条（实际 ${res.added}/${res.skipped}）`);
  ok(store.find(first.id)?.text === '她是西安人，不吃香菜。', '3) 同 id 的旧卡没有被覆盖');
  const cat = store.active().find((c) => c.text.includes('年糕'));
  ok(cat?.weight === 0.7 && cat?.source === 'import:backup', '3) 导入的卡保留权重并标记来源');
  const fromTool = store.importCards([{ kind: 'fact', text: '撤销删除之后来源不该变成 import:backup', source: 'tool' }]);
  const kept = store.active().find((c) => c.text.includes('撤销删除之后来源不该变'));
  ok(fromTool.added === 1 && kept?.source === 'tool', '3) 恢复时保留原本的来源');
}

/* 4) 承诺：到期判定与可选的周期提醒 */
{
  const dir = mkdtempSync(join(tmpdir(), 'mcore-prom-'));
  const store = new CardStore(dir);
  const past = new Date(Date.now() - 3 * 86_400_000).toISOString();
  const card = store.add({ kind: 'promise', text: '每天发一条小黑盒帖子', dueAt: past }).card;
  ok(store.duePromises(Date.now(), 0).length === 1, '4) 到期未提醒 → 该提');
  store.update(card.id, { remindedAt: new Date().toISOString() });
  ok(store.duePromises(Date.now(), 0).length === 0, '4) 提醒过一次 + repeatDays=0 → 不再提（旧行为不变）');
  ok(store.duePromises(Date.now(), 1).length === 0, '4) 刚提醒过 + repeatDays=1 → 还不到时候');
  store.update(card.id, { remindedAt: past });
  ok(store.duePromises(Date.now(), 1).length === 1, '4) 三天前提醒过 + repeatDays=1 → 再提一次');
  const noDue = store.add({ kind: 'promise', text: '答应帮她看一眼配置' }).card;
  ok(store.promisesWithoutDue().some((c) => c.id === noDue.id), '4) 没截止时间的承诺能被单独列出来');
}

/* 5) 世界层：写承诺不带 dueAt 被挡、带 dueAt 通过、体检与导入能跑 */
{
  const dataDir = mkdtempSync(join(tmpdir(), 'mcore-up-'));
  const world = new MemoryCoreWorld({
    cfg: { ...MEMORY_CORE_DEFAULTS, enabled: true, siteEnabled: false, memoryEnabled: true },
    dataDir,
    timezone: 'Asia/Shanghai',
    botDir: dataDir,
  } as never);
  const host = { log: { info: () => {}, warn: () => {}, error: () => {} }, store: { range: () => [] } } as never;
  await world.start(host);
  const write = world.tools().find((t) => t.name === 'mcore_write')!;

  const reject = String(await write.handler({ kind: 'promise', text: '答应明早叫她起床' }));
  ok(reject.includes('dueAt'), '5) 承诺不带 dueAt → 被拒绝并提示问清楚');
  const accept = String(await write.handler({ kind: 'promise', text: '明早七点二十叫她起床', dueAt: '2026-11-06T07:20' }));
  ok(accept.includes('已记下'), '5) 带 dueAt 的承诺正常写入');
  const undated = String(await write.handler({ kind: 'promise', text: '答应下次见面给她带那本书', dueAt: 'none' }));
  ok(undated.includes('已记下'), '5) dueAt 写 none → 允许，存成「无截止」而不是逼模型编时间');

  const health = (world as unknown as { healthReport(): Record<string, any> }).healthReport();
  ok(health.cards.active >= 1 && Array.isArray(health.perDay) && health.perDay.length === 14, '5) 体检报告结构正常');
  ok(typeof health.backup.count === 'number' && health.raw.lines === 0, '5) 体检带备份与原文统计');
  ok(health.promises.noDue === 1, '5) 无截止的承诺被单独统计出来');
  ok(health.promises.repeating === 1, '5) 默认周期提醒是 1 天（过期未做每天提一次）');

  const importBackup = (world as unknown as { importBackup(p: unknown): Record<string, any> }).importBackup.bind(world);
  const report = importBackup({
    cards: [{ kind: 'fact', text: '导入进来的第一条', weight: 0.6 }],
    turns: [
      { cursor: 101, ts: new Date().toISOString(), sender: 'private:1', text: '这条原文应该被导进来' },
      { cursor: 102, ts: new Date().toISOString(), sender: 'private:1', text: '还有这条' },
    ],
    plans: [{ id: 'p1', time: '19:00', title: '一起去吃饭' }],
    state: { rawWatermark: 5000 },
  });
  ok(report.cards?.added === 1, '5) 导入加了 1 张卡');
  ok(report.turns?.added === 2, '5) 导入加了 2 行原文');
  ok(report.plans?.added === 1, '5) 导入加了 1 条日程');
  ok((world as unknown as { state: { rawWatermark?: number } }).state.rawWatermark === 5000, '5) 水位被接上');

  const again = importBackup({
    cards: [{ kind: 'fact', text: '导入进来的第一条', weight: 0.6 }],
    turns: [{ cursor: 101, ts: new Date().toISOString(), sender: 'private:1', text: '这条原文应该被导进来' }],
    plans: [{ id: 'p1', time: '19:00', title: '一起去吃饭' }],
    state: { rawWatermark: 10 },
  });
  ok(again.cards?.added === 0 && again.turns?.added === 0 && again.plans?.added === 0, '6) 重复导入一条都不加');
  ok((world as unknown as { state: { rawWatermark?: number } }).state.rawWatermark === 5000, '6) 水位只往前推，不会被旧备份倒回去');

  await world.stop();
}

/* 7) 归档检索：热数据之外的旧句子要能按关键词翻回来 */
{
  const dir = mkdtempSync(join(tmpdir(), 'mcore-arch-'));
  const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
  const log = new RawLog(dir, 7, 90);
  log.add([
    { cursor: 1, ts: old, sender: 'private:1', text: '回民街那家泡馍店，你说下次带我去的那家' },
    { cursor: 2, ts: new Date().toISOString(), sender: 'private:1', text: '今天天气不错' },
  ]);
  ok(log.size === 1, `7) 只有热数据留在 turns.jsonl（${log.size} 行）`);
  const hits = rankRaw(log.readArchive(90, 5000), '泡馍店', 5);
  ok(hits.length === 1 && hits[0].text.includes('泡馍'), '7) 归档里的旧句子能搜到');
  const outside = rankRaw(log.readArchive(30, 5000), '泡馍店', 5);
  ok(outside.length === 0, '7) 窗口外的归档不返回');
}

/* 8) 来源脱敏 + 原文单条删除 */
{
  const dir = mkdtempSync(join(tmpdir(), 'mcore-priv-'));
  const log = new RawLog(dir, 7, 90);
  const now = new Date().toISOString();
  log.add([
    { cursor: 1, ts: now, sender: 'private:1940008084', text: '这条的来源要被脱敏，删掉它试试' },
    { cursor: 2, ts: now, sender: 'desktop-pet.chat', text: '这条不该被删' },
    { cursor: 3, ts: new Date(Date.now() - 40 * 86_400_000).toISOString(), sender: 'qq.private:1940008084', text: '四十天前的这条要进归档' },
  ]);
  ok(log.all()[0].sender === 'private:…8084', `8) 写入即脱敏（${log.all()[0].sender}）`);
  ok(log.all()[1].sender === 'desktop-pet.chat', '8) 不是号码的来源原样保留');
  ok(!readFileSync(join(dir, 'turns.jsonl'), 'utf8').includes('1940008084'), '8) turns.jsonl 里没有完整号码');
  const arch = log.readArchive(90, 100);
  ok(arch.length === 1 && arch[0].sender === 'qq.private:…8084', '8) 归档读取也脱敏');

  // 老版本写下的归档文件：手动造一行带号码的，scrub 之后应该消失
  writeFileSync(join(dir, 'archive', '2026-09-01.jsonl'), `${JSON.stringify({ cursor: 77, ts: '2026-09-01T10:00:00.000Z', sender: 'private:1940008084', text: '老格式的一行' })}\n`, 'utf8');
  const scrubbed = log.scrubArchiveSenders();
  ok(scrubbed === 1, `8) 老归档抹掉 1 行（实际 ${scrubbed}）`);
  ok(!readFileSync(join(dir, 'archive', '2026-09-01.jsonl'), 'utf8').includes('1940008084'), '8) 归档文件里也没有号码了');

  ok(log.remove(1) && !log.all().some((e) => e.cursor === 1), '8) 热数据能按 cursor 删');
  ok(log.remove(3), '8) 归档里的那条也能删');
  ok(log.readArchive(90, 100).every((e) => e.cursor !== 3), '8) 删完归档里也查不到');
  ok(!log.remove(999), '8) 不存在的 cursor 返回 false');
}

/* 9) 线索必中：requireHit 不许靠体重混进来 */
{
  const dir = mkdtempSync(join(tmpdir(), 'mcore-hit-'));
  const store = new CardStore(dir);
  store.add({ kind: 'fact', text: '完全无关的一条高权重记忆', weight: 1 });
  store.add({ kind: 'fact', text: '她不吃香菜，点外卖别放', weight: 0.5 });
  const loose = rankCards(store.active(), { query: '香菜', limit: 5 });
  const strict = rankCards(store.active(), { query: '香菜', limit: 5, requireHit: true });
  ok(loose.some((c) => c.text.includes('无关')), '9) 不要求命中时高权重卡会混进来');
  ok(strict.length === 1 && strict[0].text.includes('香菜'), '9) requireHit 只剩真的被线索命中的那条');
}

/* 10) 出处标注 + 每轮预激活 */
{
  const dataDir = mkdtempSync(join(tmpdir(), 'mcore-prime-'));
  const events: Array<Record<string, unknown>> = [];
  const pushed: Array<Record<string, any>> = [];
  const host = {
    log: { info: () => {}, warn: () => {}, error: () => {} },
    store: { range: ({ origin }: { origin?: string }) => (origin === 'external' ? events : []) },
    pushEvent: async (e: Record<string, unknown>) => {
      pushed.push(e as Record<string, any>);
      return true;
    },
  } as never;

  const world = new MemoryCoreWorld({
    cfg: { ...MEMORY_CORE_DEFAULTS, enabled: true, siteEnabled: false, memoryEnabled: true, preactivateLines: 2 },
    dataDir,
    timezone: 'Asia/Shanghai',
    botDir: dataDir,
  } as never);
  await world.start(host);

  const internals = world as unknown as {
    lastUserProbe: number;
    probeLastUser(now: number): number | null;
    maybePreactivate(now: Date): Promise<void>;
  };
  const write = world.tools().find((t) => t.name === 'mcore_write')!;
  const recall = world.tools().find((t) => t.name === 'mcore_recall')!;

  // 模拟对方刚说了一句
  events.push({
    cursor: 7,
    ts: new Date().toISOString(),
    senderKey: 'private:1940008084',
    text: '晚上点外卖吧，就那家泡馍',
  });
  internals.lastUserProbe = 0;
  internals.probeLastUser(Date.now());

  const w = String(await write.handler({ kind: 'fact', text: '她不吃香菜，点外卖别放香菜', weight: 0.7 }));
  ok(w.includes('已记下'), '10) 写卡成功');

  const card = (world as unknown as { store: CardStore }).store.active().find((c) => c.text.includes('香菜'));
  ok(Boolean(card?.src?.ts), '10) 写卡时记下了出处时间');
  const recalled = String(await recall.handler({ query: '香菜' }));
  ok(recalled.includes('↩'), '10) 召回输出带 ↩ 出处标记');
  ok(recalled.includes('改写过的记忆'), '10) 召回首行说明这是改写不是原话');

  // 预激活：应该推一条，并记一次 primed
  pushed.length = 0;
  await internals.maybePreactivate(new Date());
  ok(pushed.length === 1 && pushed[0].type === 'mcore.prime', '10) 每轮预激活推了一条');
  ok(String(pushed[0]?.text ?? '').includes('香菜'), '10) 推的是被线索命中的那条');
  ok(String(pushed[0]?.text ?? '').includes('不是对方刚说的'), '10) 内容明确标了不是刚说的');
  const after = (world as unknown as { store: CardStore }).store.active().find((c) => c.id === card?.id);
  ok(after?.primedCount === 1, '10) 预激活记了一次 primed，不混进 uses');
  ok((after?.uses ?? 0) === 1, '10) uses 仍然只算工具召回那一次');

  // 同一句不重复推
  pushed.length = 0;
  await internals.maybePreactivate(new Date());
  ok(pushed.length === 0, '10) 同一句话不重复预激活');

  // 冷却期内换一句也不重复推同一张卡
  events.push({
    cursor: 8,
    ts: new Date().toISOString(),
    senderKey: 'private:1940008084',
    text: '香菜真的不能放啊',
  });
  internals.lastUserProbe = 0;
  internals.probeLastUser(Date.now());
  pushed.length = 0;
  await internals.maybePreactivate(new Date());
  ok(pushed.length === 0, '10) 两小时内不重复推同一张卡');

  await world.stop();
}

/* 11) 关掉预激活就一条都不推 */
{
  const dataDir = mkdtempSync(join(tmpdir(), 'mcore-primeoff-'));
  const events: Array<Record<string, unknown>> = [];
  const pushed: Array<Record<string, unknown>> = [];
  const host = {
    log: { info: () => {}, warn: () => {}, error: () => {} },
    store: { range: ({ origin }: { origin?: string }) => (origin === 'external' ? events : []) },
    pushEvent: async (e: Record<string, unknown>) => {
      pushed.push(e);
      return true;
    },
  } as never;
  const world = new MemoryCoreWorld({
    cfg: { ...MEMORY_CORE_DEFAULTS, enabled: true, siteEnabled: false, memoryEnabled: true, preactivateLines: 0 },
    dataDir,
    timezone: 'Asia/Shanghai',
    botDir: dataDir,
  } as never);
  await world.start(host);
  const write = world.tools().find((t) => t.name === 'mcore_write')!;
  const internals = world as unknown as { lastUserProbe: number; probeLastUser(n: number): number | null; maybePreactivate(d: Date): Promise<void> };
  await write.handler({ kind: 'fact', text: '她不吃香菜，点外卖别放香菜', weight: 0.7 });
  events.push({ cursor: 9, ts: new Date().toISOString(), senderKey: 'private:1', text: '晚上点外卖吧' });
  internals.lastUserProbe = 0;
  internals.probeLastUser(Date.now());
  await internals.maybePreactivate(new Date());
  ok(pushed.length === 0, '11) preactivateLines=0 时完全不推');
  await world.stop();
}

/* 12) 单字噪音要被 minBigrams 挡住；缺配置键时回落到默认 2 条 */
{
  const dir = mkdtempSync(join(tmpdir(), 'mcore-bigram-'));
  const store = new CardStore(dir);
  store.add({ kind: 'fact', text: '今天心情不错，适合出门' });
  const onlyChar = rankCards(store.active(), { query: '今', limit: 5, requireHit: true });
  const noChar = rankCards(store.active(), { query: '今', limit: 5, requireHit: true, minBigrams: 1 });
  ok(onlyChar.length === 1, '12) 单字也能命中（requireHit 不管长度）');
  ok(noChar.length === 0, '12) minBigrams=1 把单字噪音挡掉');

  const dataDir = mkdtempSync(join(tmpdir(), 'mcore-predef-'));
  const cfg = { ...MEMORY_CORE_DEFAULTS, enabled: true, siteEnabled: false, memoryEnabled: true } as Record<string, unknown>;
  delete cfg.preactivateLines;
  const world = new MemoryCoreWorld({ cfg, dataDir, timezone: 'Asia/Shanghai', botDir: dataDir } as never);
  await world.start({ log: { info: () => {}, warn: () => {}, error: () => {} }, store: { range: () => [] } } as never);
  const count = (world as unknown as { preactivateCount(): number }).preactivateCount();
  ok(count === 2, `12) config 里没有这个键时回落到 2（实际 ${count}）`);
  await world.stop();
}

/* 13) 冷层：只沉该沉的，能捞回来 */
{
  const dir = mkdtempSync(join(tmpdir(), 'mcore-cold-'));
  const store = new CardStore(dir);
  const old = new Date(Date.now() - 200 * 86_400_000).toISOString();
  const plain = store.add({ kind: 'fact', text: '两百天前的一条低权重记忆', weight: 0.4, createdAt: old }).card;
  const heavy = store.add({ kind: 'fact', text: '两百天前但权重很高的一条', weight: 0.9, createdAt: old }).card;
  const prom = store.add({ kind: 'promise', text: '两百天前没做完的承诺', weight: 0.4, createdAt: old, dueAt: '2026-01-01T10:00' }).card;
  const fresh = store.add({ kind: 'fact', text: '昨天刚记的一条', weight: 0.4 }).card;

  const eligible = store.chillEligible(180).map((c) => c.id);
  ok(eligible.includes(plain.id), '13) 久 + 低权重 → 进候选');
  ok(!eligible.includes(heavy.id), '13) 高权重不沉');
  ok(!eligible.includes(prom.id), '13) 没做完的承诺不沉');
  ok(!eligible.includes(fresh.id), '13) 新的不沉');

  ok(store.chill([plain.id]) === 1, '13) 能沉到冷层');
  ok(!store.recallable().some((c) => c.id === plain.id), '13) 冷层不进 recallable');
  ok(store.active().some((c) => c.id === plain.id), '13) 但还在 active 里（没删）');
  ok(store.warm([plain.id]) === 1 && store.recallable().some((c) => c.id === plain.id), '13) 能一键回暖');
  ok(store.chillEligible(0).length === 0, '13) chillAfterDays=0 时没有候选');
}

/* 14) 冷层在召回里的表现：搜索还能找到并标 ❄，「最近」不带它 */
{
  const dataDir = mkdtempSync(join(tmpdir(), 'mcore-coldrecall-'));
  const world = new MemoryCoreWorld({
    cfg: { ...MEMORY_CORE_DEFAULTS, enabled: true, siteEnabled: false, memoryEnabled: true },
    dataDir,
    timezone: 'Asia/Shanghai',
    botDir: dataDir,
  } as never);
  await world.start({ log: { info: () => {}, warn: () => {}, error: () => {} }, store: { range: () => [] } } as never);
  const write = world.tools().find((t) => t.name === 'mcore_write')!;
  const recall = world.tools().find((t) => t.name === 'mcore_recall')!;
  await write.handler({ kind: 'fact', text: '很久以前的一条无关记忆，说要去修自行车', weight: 0.4 });
  const store = (world as unknown as { store: CardStore }).store;
  const id = store.active()[0].id;
  store.chill([id]);

  const recent = String(await recall.handler({}));
  ok(!recent.includes('自行车'), '14) 「最近」不带冷层');
  const searched = String(await recall.handler({ mode: 'search', query: '自行车' }));
  ok(searched.includes('❄'), '14) 搜索仍然找得到冷层，并标 ❄');
  ok(!store.find(id)?.coldAt, '14) 真被用上一次就自动回暖');
  await world.stop();
}

/* 15) 夜间整理：夜里备料，下次开口才交付 */
{
  const dataDir = mkdtempSync(join(tmpdir(), 'mcore-nightly-'));
  const pushed: Array<Record<string, any>> = [];
  const host = {
    log: { info: () => {}, warn: () => {}, error: () => {} },
    store: { range: () => [] },
    pushEvent: async (e: Record<string, unknown>) => {
      pushed.push(e as Record<string, any>);
      return true;
    },
  } as never;
  const world = new MemoryCoreWorld({
    cfg: { ...MEMORY_CORE_DEFAULTS, enabled: true, siteEnabled: false, memoryEnabled: true, nightlyConsolidate: true, nightlyHour: 1 },
    dataDir,
    timezone: 'Asia/Shanghai',
    botDir: dataDir,
  } as never);
  await world.start(host);

  const internals = world as unknown as {
    maybeNightly(d: Date): Promise<void>;
    deliverNightly(): Promise<void>;
    state: { nightlyPending?: { day: string; text: string }; lastNightlyDay?: string };
    raw: RawLog;
  };
  const now = new Date();
  const iso = now.toISOString();

  // 只有两句：不整
  internals.raw.add([
    { cursor: 1, ts: iso, sender: 'private:1', text: '今天出去走了走' },
    { cursor: 2, ts: iso, sender: 'private:1', text: '有点累' },
  ]);
  await internals.maybeNightly(now);
  ok(!internals.state.nightlyPending, '15) 一天不到四句不备料');

  internals.state.lastNightlyDay = undefined;
  internals.raw.add([
    { cursor: 3, ts: iso, sender: 'private:1', text: '明天记得帮我把简历改一下' },
    { cursor: 4, ts: iso, sender: 'private:1', text: '还有那家店周三要订位' },
    { cursor: 5, ts: iso, sender: 'private:1', text: '晚上想吃点热的' },
  ]);
  await internals.maybeNightly(now);
  ok(Boolean(internals.state.nightlyPending), '15) 够料时先备着，不立刻推');
  ok(pushed.length === 0, '15) 凌晨推送的问题没了：备料阶段不 push');

  await internals.deliverNightly();
  ok(pushed.length === 1 && pushed[0].type === 'mcore.nightly', '15) 下次开口时交付');
  ok(String(pushed[0]?.text ?? '').includes('最多写 3 条'), '15) 交付内容带「最多 3 条」的硬约束');
  ok(!internals.state.nightlyPending, '15) 交付后清掉备料');

  await internals.deliverNightly();
  ok(pushed.length === 1, '15) 不会重复交付');
  await world.stop();
}

console.log(bad ? `\n${bad} 项失败` : '\n全部通过');
process.exit(bad ? 1 : 0);
