/**
 * 她删掉想法后，记忆核心要跟着撤回由它收成的那张卡。
 * 跑法：node --experimental-transform-types --no-warnings tools/test-delete.ts
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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

const root = mkdtempSync(join(tmpdir(), 'mcore-del-'));
const mc = join(root, 'memory-core');
const sa = join(root, 'self-awareness');
mkdirSync(mc, { recursive: true });
mkdirSync(sa, { recursive: true });

const now = new Date().toISOString();
const cards = [
  { id: 'c1', kind: 'self', text: '独处时写下：编造的那条', weight: 0.6, tags: ['独处'], createdAt: now, updatedAt: now, source: 'self-awareness', origin: 'tool', srcThoughtId: 'k2', status: 'active', scope: 'main', uses: 0 },
  { id: 'c2', kind: 'fact', text: '正常的一张卡', weight: 0.6, tags: [], createdAt: now, updatedAt: now, source: 'tool', origin: 'tool', status: 'active', scope: 'main', uses: 0 },
];
writeFileSync(join(mc, 'cards.jsonl'), cards.map((c) => JSON.stringify(c)).join('\n') + '\n', 'utf8');
writeFileSync(join(mc, 'turns.jsonl'), '', 'utf8');
writeFileSync(join(mc, 'state.json'), JSON.stringify({ energy: 50, mood: 50, activity: '待着', sleeping: false }), 'utf8');
writeFileSync(join(sa, 'deleted-thoughts.jsonl'), JSON.stringify({ id: 'k2', ts: now }) + '\n', 'utf8');

const world = new MemoryCoreWorld({
  cfg: { ...MEMORY_CORE_DEFAULTS, enabled: true, siteEnabled: false, memoryEnabled: true, absorbSelfThought: false },
  dataDir: root,
  timezone: 'Asia/Shanghai',
  botDir: root,
} as never);

await world.start({
  log: { info: () => {}, warn: () => {}, error: () => {} },
  store: { range: () => [] },
} as never);

(world as unknown as { pruneDeletedThoughts(): void }).pruneDeletedThoughts();

const left = readFileSync(join(mc, 'cards.jsonl'), 'utf8');
ok(!left.includes('c1'), '01) 由被删想法收成的卡片被撤回了');
ok(left.includes('c2'), '02) 无关的卡片没动');

await world.stop();
console.log(bad ? `\n${bad} 项失败（共 ${total}）` : `\n全部通过（共 ${total} 项）`);
if (bad) process.exitCode = 1;
