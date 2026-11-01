/**
 * 临时集成测试：用假宿主启动 MemoryCoreWorld，跑写/查/退休/维护，确认 world.ts 没被改坏。
 * 跑法：node --experimental-transform-types tools/test-world.ts
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryCoreWorld } from '../src/world.ts';
import { MEMORY_CORE_DEFAULTS } from '../src/config.ts';

const dataDir = mkdtempSync(join(tmpdir(), 'mcore-world-'));
const world = new MemoryCoreWorld({
  cfg: { ...MEMORY_CORE_DEFAULTS, enabled: true, siteEnabled: false, memoryEnabled: true },
  dataDir,
  timezone: 'Asia/Shanghai',
  botDir: dataDir,
} as never);

const host = {
  log: { info: () => {}, warn: () => {}, error: () => {} },
  store: { range: () => [] },
} as never;

await world.start(host);
console.log('tools:', world.tools().map((t) => t.name).join(','));

const write = world.tools().find((t) => t.name === 'mcore_write')!;
const recall = world.tools().find((t) => t.name === 'mcore_recall')!;

const r1 = await write.handler({ kind: 'fact', text: '主人让我叫他月，我们是私聊一对一的搭子。', weight: 0.8 });
console.log('1) 写:', r1);

const r2 = await write.handler({ kind: 'fact', text: '约好明早七点二十叫他起床，闹钟我记着。', weight: 0.6 });
console.log('2) 写:', r2);

const idLine = String(await recall.handler({ query: '七点二十' }));
console.log('3) 查:', idLine.replace(/\n/g, ' | '));
const id = /· ([0-9a-f]{8}) /.exec(idLine)?.[1] ?? '';
console.log('   命中 id 前缀:', id);

const r3 = await write.handler({ kind: 'fact', text: '改到十点叫他起床，原来七点二十的闹钟取消了。', weight: 0.6, closes: id });
console.log('4) 带 closes 写:', r3);

const after = String(await recall.handler({ query: '七点二十' }));
console.log('5) 再查（旧的应该不出现）:', after.replace(/\n/g, ' | '));

const open = String(await recall.handler({ mode: 'open' }));
console.log('6) open:', open.replace(/\n/g, ' | '));

const ui = world.webUi();
console.log('7) 面板灯:', ui.lamps?.map((l) => `${l.label}=${l.hint}`).join(' / '));
console.log('8) 工具数 & 提示词行:', world.tools().length, '| envPromptVars', JSON.stringify(world.envPromptVars()));

await world.stop();
console.log('9) 已停止');
