/**
 * 冲动链路：自我意识写下的「想说话」，记忆核心要能读出来、提前开口、并且只用一次。
 * 跑法：node --experimental-transform-types --no-warnings tools/test-urge.ts
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

function makeRoot(withUrge: boolean): string {
  const root = mkdtempSync(join(tmpdir(), 'mcore-urge-'));
  mkdirSync(join(root, 'memory-core'), { recursive: true });
  mkdirSync(join(root, 'self-awareness'), { recursive: true });
  writeFileSync(join(root, 'memory-core', 'cards.jsonl'), '', 'utf8');
  writeFileSync(join(root, 'memory-core', 'turns.jsonl'), '', 'utf8');
  writeFileSync(join(root, 'memory-core', 'state.json'), JSON.stringify({
    energy: 60, mood: 60, activity: '在窗边坐着', location: '房间', sleeping: false,
  }), 'utf8');
  if (withUrge) {
    writeFileSync(join(root, 'self-awareness', 'urges.jsonl'), JSON.stringify({
      id: 'u1234567',
      ts: new Date(Date.now() - 2 * 60_000).toISOString(),
      type: 'silence',
      text: '他刚才那句话我还没答完',
      importance: 8,
      quietMin: 10,
    }) + '\n', 'utf8');
  }
  return root;
}

async function run(withUrge: boolean): Promise<{ pushed: string; lastUrgeId?: string }> {
  const root = makeRoot(withUrge);
  const world = new MemoryCoreWorld({
    cfg: {
      ...MEMORY_CORE_DEFAULTS,
      enabled: true,
      proactiveEnabled: true,
      siteEnabled: false,
      captureTurns: false,
      nightlyConsolidate: false,
      proactiveMinGapMin: 100,
      idleGateMin: 20,
      quietStart: '03:00', quietEnd: '04:00',
      sleepStart: '05:00', sleepEnd: '06:00',
      proactiveDailyCap: 3,
    },
    dataDir: root,
    timezone: 'Asia/Shanghai',
    botDir: root,
  } as never);

  let pushed = '';
  await world.start({
    log: { info: () => {}, warn: () => {}, error: () => {} },
    store: {
      range: () => [{
        ts: new Date(Date.now() - 10 * 60_000).toISOString(),
        origin: 'external',
        senderKey: 'desktop-pet.chat',
        text: '我先去忙了',
      }],
    },
    pushEvent: async (event: { text?: string }) => {
      pushed = String(event?.text ?? '');
      return true;
    },
  } as never);

  // 把「下一次」推到一小时后：没有冲动的话，这一轮绝不该开口
  world.state.proactiveDueAt = new Date(Date.now() + 3_600_000).toISOString();
  await world.maybeProactive(new Date());
  const lastUrgeId = world.state.lastUrgeId;
  await world.stop();
  return { pushed, lastUrgeId };
}

{
  const withUrge = await run(true);
  ok(Boolean(withUrge.pushed), '01) 有冲动时，就算下一次还在一小时后也会开口');
  ok(withUrge.pushed.includes('他刚才那句话我还没答完'), '02) 由头里带上了她写的那句话');
  ok(withUrge.pushed.includes('10 分钟没说话'), '03) 由头里说清对方安静了多久');
  ok(withUrge.lastUrgeId === 'u1234567', '04) 用过的冲动被记下来');

  const without = await run(false);
  ok(!without.pushed, '05) 没有冲动时，不会提前开口');
}

console.log(bad ? `\n${bad} 项失败（共 ${total}）` : `\n全部通过（共 ${total} 项）`);
if (bad) process.exitCode = 1;
