/**
 * 同义词扩展、索引缓存失效、命中解释、漏检记录。
 * 跑法：node --experimental-transform-types --no-warnings tools/test-recall.ts
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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

function boot(over: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mcore-recall-'));
  mkdirSync(join(root, 'memory-core'), { recursive: true });
  writeFileSync(join(root, 'memory-core', 'cards.jsonl'), '', 'utf8');
  writeFileSync(join(root, 'memory-core', 'turns.jsonl'), '', 'utf8');
  writeFileSync(join(root, 'memory-core', 'state.json'), JSON.stringify({ energy: 50, mood: 50, activity: '待着', sleeping: false }), 'utf8');
  const world = new MemoryCoreWorld({
    cfg: { ...MEMORY_CORE_DEFAULTS, enabled: true, memoryEnabled: true, siteEnabled: false, proactiveEnabled: false, ...over },
    dataDir: root, timezone: 'Asia/Shanghai', botDir: root,
  } as never);
  return { world, root };
}

async function start(world: MemoryCoreWorld) {
  await world.start({ log: { info: () => {}, warn: () => {}, error: () => {} }, store: { range: () => [] } } as never);
}

async function main() {
  {
    const { world, root } = boot();
    await start(world);
    const call = async (name: string, args: Record<string, unknown>) =>
      String(await world.tools().find((t) => t.name === name)!.handler(args));

    await call('mcore_write', { kind: 'fact', text: '帮我把快递取回来，放在门口就行。', weight: 0.7 });
    const syn = await call('mcore_recall', { query: '拿包裹' });
    ok(syn.includes('快递'), '01) 换个说法（包裹）也能搜到快递');
    ok(syn.includes('〔') && syn.includes('快递'), '02) 召回行给出命中解释');

    const miss = await call('mcore_recall', { query: '量子纠缠塌缩实验' });
    ok(miss.includes('没有对得上'), '03) 搜不到时明确说没有');
    const missFile = join(root, 'memory-core', 'misses.jsonl');
    ok(existsSync(missFile) && readFileSync(missFile, 'utf8').includes('量子纠缠'), '04) 漏检写入 misses.jsonl');

    // 缓存失效：写入新卡后，新词必须立刻能搜到（如果索引没失效会漏）
    await call('mcore_write', { kind: 'fact', text: '她喜欢喝乌龙茶，不加糖。', weight: 0.6 });
    ok((await call('mcore_recall', { query: '乌龙' })).includes('乌龙'), '05) 新写入的卡立即可搜（索引已失效）');

    const firstId = (world as unknown as { store: { all(): Array<{ id: string; text: string }> } }).store
      .all().find((c) => c.text.includes('乌龙'))!.id;
    await call('mcore_update', { id: firstId.slice(0, 8), text: '她喜欢喝普洱，不加糖。' });
    ok((await call('mcore_recall', { query: '普洱' })).includes('普洱'), '06) 改口后新版本可搜');
    ok(!(await call('mcore_recall', { query: '乌龙' })).includes('她喜欢喝乌龙'), '07) 旧版本不再冒出');
    await world.stop();
  }

  {
    const { world } = boot({ synonyms: '奶茶=波霸,珍珠' });
    await start(world);
    const call = async (name: string, args: Record<string, unknown>) =>
      String(await world.tools().find((t) => t.name === name)!.handler(args));
    await call('mcore_write', { kind: 'fact', text: '下午想喝奶茶。', weight: 0.5 });
    ok((await call('mcore_recall', { query: '珍珠' })).includes('奶茶'), '08) 自定义同义词生效');
    await world.stop();
  }

  console.log(bad ? `\n${bad} 项失败（共 ${total}）` : `\n全部通过（共 ${total} 项）`);
  if (bad) process.exitCode = 1;
}

await main();
