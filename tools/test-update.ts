/**
 * mcore_update：正文改动走改口（旧卡留档），元数据原地改。
 * 跑法：node --experimental-transform-types --no-warnings tools/test-update.ts
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
  if (!cond) { bad += 1; console.log(`FAIL ${label}`); } else { console.log(`OK   ${label}`); }
}

const root = mkdtempSync(join(tmpdir(), 'mcore-upd-'));
mkdirSync(join(root, 'memory-core'), { recursive: true });
writeFileSync(join(root, 'memory-core', 'cards.jsonl'), '', 'utf8');
writeFileSync(join(root, 'memory-core', 'turns.jsonl'), '', 'utf8');
writeFileSync(join(root, 'memory-core', 'state.json'), JSON.stringify({ energy: 50, mood: 50, activity: '待着', sleeping: false }), 'utf8');

const world = new MemoryCoreWorld({
  cfg: { ...MEMORY_CORE_DEFAULTS, enabled: true, memoryEnabled: true, siteEnabled: false, proactiveEnabled: false },
  dataDir: root, timezone: 'Asia/Shanghai', botDir: root,
} as never);
const logs: Array<{ msg: string; meta?: Record<string, unknown> }> = [];
await world.start({
  log: {
    info: (msg: string, meta?: Record<string, unknown>) => logs.push({ msg, meta }),
    warn: () => {},
    error: () => {},
  },
  store: { range: () => [] },
} as never);

const tools = world.tools();
const call = async (name: string, args: Record<string, unknown>) =>
  String(await tools.find((t) => t.name === name)!.handler(args));
const store = (world as unknown as { store: { all(): Array<Record<string, unknown>>; find(id: string): Record<string, unknown> } }).store;

const wrote = await call('mcore_write', { kind: 'fact', text: '主人让我叫他月，我们是私聊一对一的搭子。', weight: 0.5 });
const first = store.all()[0] as { id: string; text: string; weight: number; status: string };
ok(/· [0-9a-f]{8}）/.test(wrote), '01) 写入回执带 8 位编号');
ok(logs.some((l) => l.msg.includes('写入') && l.meta?.id === first.id.slice(0, 8)), '02) 写入成功会记日志');

await call('mcore_update', { id: first.id.slice(0, 8), weight: 0.9 });
const weighted = store.find(first.id) as { weight: number };
ok(weighted.weight === 0.9, '03) 只改权重 → 原地生效');
ok(logs.some((l) => l.msg.includes('改') && l.meta?.id === first.id.slice(0, 8)), '04) 元数据修改会记日志');

await call('mcore_update', { id: first.id.slice(0, 8), text: '主人让我喊他月，我们是私聊一对一的搭子，别叫错。' });
const all = store.all() as Array<{ id: string; text: string; status: string; retiredBy?: string; supersedes?: string[] }>;
const old = store.find(first.id) as { status: string; retiredBy?: string };
const fresh = all.find((c) => c.status === 'active' && c.text.includes('别叫错'));
ok(Boolean(fresh) && old.status === 'retired' && old.retiredBy === fresh?.id, '05) 改正文 → 新卡接替，旧卡留档');
ok(logs.some((l) => l.msg.includes('改口') && l.meta?.from === first.id.slice(0, 8)), '06) 改口会记日志');
ok(Boolean(fresh?.supersedes?.includes(first.id)), '07) 新卡记下了它接替谁');

const blocked = await call('mcore_update', { id: first.id.slice(0, 8), text: '再改一次' });
ok(blocked.includes('已经退休'), '08) 已退休的旧卡不能再改');

await call('mcore_write', { kind: 'promise', text: '明早七点二十叫她起床。', dueAt: '2026-11-22T07:20' });
const prom = (store.all() as Array<{ id: string; kind: string; remindCount?: number }>).find((c) => c.kind === 'promise')!;
store.update?.(prom.id, { remindCount: 5 });
await call('mcore_update', { id: prom.id.slice(0, 8), dueAt: '2026-11-23T07:20' });
const after = store.find(prom.id) as { dueAt: string; remindCount?: number };
ok(after.dueAt.startsWith('2026-11-23') && (after.remindCount ?? 0) === 0, '09) 改截止时间 → 提醒次数清零');

const miss = await call('mcore_update', { id: 'deadbeef', weight: 0.5 });
ok(miss.includes('找不到'), '10) 找不到的 id 会明说');

await world.stop();
console.log(bad ? `\n${bad} 项失败（共 ${total}）` : `\n全部通过（共 ${total} 项）`);
if (bad) process.exitCode = 1;
