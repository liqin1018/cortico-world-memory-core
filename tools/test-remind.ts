/**
 * 承诺提醒（策略 A）：到期不漏、时段内才提、没回应才重提、次数有上限。
 * 跑法：node --experimental-transform-types --no-warnings tools/test-remind.ts
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryCoreWorld } from '../src/world.ts';
import { MEMORY_CORE_DEFAULTS } from '../src/config.ts';

let bad = 0;
let total = 0;
function ok(cond: boolean, label: string): void {
  total += 1;
  if (!cond) {
    bad += 1;
    console.log(`FAIL ${label}`);
  } else {
    console.log(`OK   ${label}`);
  }
}

type Push = { type: string; text: string };

function boot(over: Record<string, unknown>, lastUserAgoMin: number) {
  const root = mkdtempSync(join(tmpdir(), 'mcore-remind-'));
  mkdirSync(join(root, 'memory-core'), { recursive: true });
  writeFileSync(join(root, 'memory-core', 'cards.jsonl'), '', 'utf8');
  writeFileSync(join(root, 'memory-core', 'turns.jsonl'), '', 'utf8');
  writeFileSync(join(root, 'memory-core', 'state.json'), JSON.stringify({ energy: 60, mood: 60, activity: '待着', sleeping: false }), 'utf8');
  const world = new MemoryCoreWorld({
    cfg: {
      ...MEMORY_CORE_DEFAULTS,
      enabled: true,
      memoryEnabled: true,
      siteEnabled: false,
      proactiveEnabled: false,
      quietStart: '00:00',
      quietEnd: '00:00',
      sleepStart: '00:00',
      sleepEnd: '00:00',
      remindWindowStart: '00:00',
      remindWindowEnd: '23:59',
      remindMinGapMin: 0,
      remindDailyCap: 0,
      remindRepeatMin: 180,
      remindMaxTimes: 6,
      ...over,
    },
    dataDir: root,
    timezone: 'Asia/Shanghai',
    botDir: root,
  } as never);
  const pushes: Push[] = [];
  const fixed = Date.now();
  const host = {
    log: { info: () => {}, warn: () => {}, error: () => {} },
    store: {
      range: () => [{
        ts: new Date(fixed - lastUserAgoMin * 60_000).toISOString(),
        origin: 'external',
        senderKey: 'desktop-pet.chat',
        text: '我先去忙了',
      }],
    },
    pushEvent: async (e: { type?: string; text?: string }) => {
      pushes.push({ type: String(e?.type ?? ''), text: String(e?.text ?? '') });
      return true;
    },
  };
  return { world, pushes, host };
}

async function addPromise(world: MemoryCoreWorld, text: string, dueAt: string) {
  const store = (world as unknown as { store: { add: (x: unknown) => { card: { id: string } } } }).store;
  return store.add({ kind: 'promise', text, dueAt, weight: 0.6, source: 'tool', origin: 'tool' }).card.id;
}

const T = (iso: string) => new Date(`2026-11-21T${iso}:00+08:00`);

{
  const { world, pushes, host } = boot({}, 10);
  await world.start(host as never);
  const id = await addPromise(world, '明早七点二十叫她起床', '2026-11-21T11:00:00+08:00');
  (world as unknown as { lastUserProbe: number }).lastUserProbe = 0;
  await (world as unknown as { maybeRemind(n: Date): Promise<void> }).maybeRemind(T('14:00'));
  const card = (world as unknown as { store: { find(id: string): { remindCount?: number; remindedAt?: string } } }).store.find(id);
  ok(pushes.length === 1 && pushes[0].type === 'mcore.due', '01) 到期且人在 → 推一条');
  ok(card.remindCount === 1 && Boolean(card.remindedAt), '02) 记下提醒次数与时间');

  await (world as unknown as { maybeRemind(n: Date): Promise<void> }).maybeRemind(T('14:30'));
  ok(pushes.length === 1, '03) 半小时内不重复提');

  await (world as unknown as { maybeRemind(n: Date): Promise<void> }).maybeRemind(T('17:01'));
  ok(pushes.length === 2 && card.remindCount === 2, '04) 过了 180 分钟还没回应 → 再提一次');

  (world as unknown as { store: { update(id: string, p: unknown): void } }).store.update(id, { remindCount: 6 });
  await (world as unknown as { maybeRemind(n: Date): Promise<void> }).maybeRemind(T('21:00'));
  ok(pushes.length === 2, '05) 到次数上限就停');
  await world.stop();
}

{
  const { world, pushes, host } = boot({ remindWindowStart: '20:00', remindWindowEnd: '23:00' }, 10);
  await world.start(host as never);
  await addPromise(world, '下午三点交房租', '2026-11-21T13:00:00+08:00');
  (world as unknown as { lastUserProbe: number }).lastUserProbe = 0;
  await (world as unknown as { maybeRemind(n: Date): Promise<void> }).maybeRemind(T('14:00'));
  ok(pushes.length === 0, '06) 不在可打扰时段 → 不推也不标记');
  await world.stop();
}

{
  const { world, pushes, host } = boot({}, 600);
  await world.start(host as never);
  await addPromise(world, '帮她把快递取回来', '2026-11-21T12:00:00+08:00');
  (world as unknown as { lastUserProbe: number }).lastUserProbe = 0;
  await (world as unknown as { maybeRemind(n: Date): Promise<void> }).maybeRemind(T('14:00'));
  ok(pushes.length === 0, '07) 对方 10 小时没说话（策略 A）→ 只登记不推');
  await world.stop();
}

{
  const { world, pushes, host } = boot({ remindWithoutUser: true, remindForceAfterHours: 6 }, 600);
  await world.start(host as never);
  await addPromise(world, '帮她把快递取回来', '2026-11-21T12:00:00+08:00');
  (world as unknown as { lastUserProbe: number }).lastUserProbe = 0;
  await (world as unknown as { maybeRemind(n: Date): Promise<void> }).maybeRemind(T('14:00'));
  ok(pushes.length === 0, '08) 无人策略下，逾期不到 6 小时 → 再等');
  await (world as unknown as { maybeRemind(n: Date): Promise<void> }).maybeRemind(T('19:10'));
  ok(pushes.length === 1, '09) 逾期超过 6 小时 → 允许推一次');
  await world.stop();
}

{
  const { world, pushes, host } = boot({}, 10);
  await world.start(host as never);
  const id = await addPromise(world, '说好晚上给她打电话', '2026-11-21T12:00:00+08:00');
  (world as unknown as { store: { update(id: string, p: unknown): void } }).store.update(id, { done: true });
  (world as unknown as { lastUserProbe: number }).lastUserProbe = 0;
  await (world as unknown as { maybeRemind(n: Date): Promise<void> }).maybeRemind(T('14:00'));
  ok(pushes.length === 0, '10) 已经标完成 → 不再提醒');
  await world.stop();
}

console.log(bad ? `\n${bad} 项失败（共 ${total}）` : `\n全部通过（共 ${total} 项）`);
if (bad) process.exitCode = 1;
