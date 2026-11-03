/**
 * 用真实的事件分片当宿主，跑一遍捕获：不重启 Coopanion 也能验证线上数据能不能录进来。
 * 跑法：node --experimental-transform-types tools/check-real.ts
 */
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryCoreWorld } from '../src/world.ts';
import { MEMORY_CORE_DEFAULTS } from '../src/config.ts';

const runsDir = 'F:/Coopanion/data/home/companion/data/runs';
const events: Array<{ cursor: number; ts: string; senderKey?: string; text: string; origin?: string }> = [];
for (const run of readdirSync(runsDir).filter((n) => n.startsWith('r-2026')).sort()) {
  const file = join(runsDir, run, 'events.jsonl');
  let lines: string[] = [];
  try {
    lines = readFileSync(file, 'utf8').split('\n');
  } catch {
    continue;
  }
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (Number.isInteger(e.cursor) && typeof e.ts === 'string' && typeof e.text === 'string') events.push(e);
    } catch {
      // ignore
    }
  }
}
events.sort((a, b) => a.cursor - b.cursor);
console.log('真实事件', events.length, '条 | cursor', events[0]?.cursor, '→', events[events.length - 1]?.cursor);

const host = {
  log: { info: () => {}, warn: () => {}, error: () => {} },
  store: {
    range: ({ fromCursor, origin, limit }: { fromCursor: number; origin?: string; limit: number }) =>
      events
        .filter((e) => e.cursor >= fromCursor && (!origin || e.origin === origin))
        .slice(0, limit),
  },
} as never;

const dataDir = mkdtempSync(join(tmpdir(), 'mcore-real-'));
const world = new MemoryCoreWorld({
  cfg: { ...MEMORY_CORE_DEFAULTS, enabled: true, siteEnabled: false, memoryEnabled: true, proactiveEnabled: false, captureBackfill: true },
  dataDir,
  timezone: 'Asia/Shanghai',
  botDir: dataDir,
} as never);

await world.start(host);

const file = join(dataDir, 'memory-core', 'turns.jsonl');
const rows = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
console.log('捕获', rows.length, '行');
const bySender = new Map<string, number>();
for (const r of rows) bySender.set(r.sender, (bySender.get(r.sender) ?? 0) + 1);
console.log('来源分布', [...bySender.entries()]);
console.log('最近 5 条：');
for (const r of rows.slice(-5)) console.log(' •', r.ts.slice(5, 16), r.sender, '|', r.text.slice(0, 60));
const bad = rows.filter((r) => /^\[|^\S{1,12}[:：]/.test(r.text));
console.log('还带着抬头/前缀的：', bad.length, bad.slice(0, 3).map((b) => b.text.slice(0, 40)));
for (const b of bad.slice(0, 3)) {
  const src = events.find((e) => e.cursor === b.cursor);
  console.log('   原始:', JSON.stringify(src?.text ?? '').slice(0, 120));
}
const st = JSON.parse(readFileSync(join(dataDir, 'memory-core', 'state.json'), 'utf8'));
console.log('水位', st.rawWatermark, '| 回放完成', Boolean(st.backfillDoneAt), '| 体检', JSON.stringify(st.captureDebug));
await world.stop();
