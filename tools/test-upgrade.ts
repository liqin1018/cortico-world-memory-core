/**
 * 0.4.0 的回归：原子写与备份、导入、承诺闭环、体检。
 * 跑法：node --experimental-transform-types tools/test-upgrade.ts
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CardStore, RawLog } from '../src/store.ts';
import { rankRaw } from '../src/recall.ts';
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

console.log(bad ? `\n${bad} 项失败` : '\n全部通过');
process.exit(bad ? 1 : 0);
