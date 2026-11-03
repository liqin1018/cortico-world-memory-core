/**
 * 验证捕获与原文归档：白名单、回放、按天归档、归档保留。
 * 跑法：node --experimental-transform-types tools/test-capture.ts
 */
import { mkdtempSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryCoreWorld } from '../src/world.ts';
import { MEMORY_CORE_DEFAULTS } from '../src/config.ts';
import { RawLog } from '../src/store.ts';

const OLD = '^(starpost\\.private\\.|qq\\.|desktop-pet\\.message)';
const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

const events = [
  { cursor: 1, ts: new Date().toISOString(), senderKey: 'private:1940008084', text: '今天去海边了' },
  { cursor: 2, ts: new Date().toISOString(), senderKey: 'desktop-pet.chat', text: '在吗' },
  { cursor: 3, ts: new Date().toISOString(), senderKey: 'desktop-pet.self', text: '我在的，你说' },
  { cursor: 4, ts: new Date().toISOString(), senderKey: 'qq.group.123', text: '群里有人在说话这句话要过滤' },
  { cursor: 5, ts: new Date().toISOString(), senderKey: 'desktop-pet.voice', text: '帮我把窗帘拉一下' },
  { cursor: 6, ts: new Date().toISOString(), senderKey: 'private:1940008084', text: '[取消]' },
  { cursor: 7, ts: new Date().toISOString(), senderKey: 'starpost.private.7', text: '晚上七点见' },
  { cursor: 8, ts: new Date().toISOString(), senderKey: 'desktop-pet.chat', text: '今天风好大，把晾的衣服收一下' },
];

function fakeHost(rows: typeof events) {
  return {
    log: { info: () => {}, warn: () => {}, error: () => {} },
    store: {
      range: ({ fromCursor, limit }: { fromCursor: number; limit: number }) =>
        rows.filter((e) => e.cursor >= fromCursor).slice(0, limit),
    },
  } as never;
}

function boot(over: Record<string, unknown> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'mcore-cap-'));
  const world = new MemoryCoreWorld({
    cfg: {
      ...MEMORY_CORE_DEFAULTS,
      enabled: true,
      siteEnabled: false,
      memoryEnabled: true,
      proactiveEnabled: false,
      ...over,
    },
    dataDir,
    timezone: 'Asia/Shanghai',
    botDir: dataDir,
  } as never);
  return { world, dataDir };
}

// 1) 新默认白名单：只留下对方说的话
{
  const { world, dataDir } = boot();
  await world.start(fakeHost(events));
  const file = join(dataDir, 'memory-core', 'turns.jsonl');
  const lines = existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean) : [];
  const texts = lines.map((l) => JSON.parse(l).text);
  console.log('1) 捕获', lines.length, '行 →', texts);
  console.log('   白名单：私聊/桌宠/语音/星邮 ✓，桌宠自己/群聊/[取消]/太短 ✗ →',
    lines.length === 4 && !texts.some((t) => t.includes('我在的') || t.includes('群里')) ? 'OK' : 'FAIL');
  await world.stop();
}

// 2) 老配置里的旧默认值会自动换成新默认（不然用户永远录不到）
{
  const { world, dataDir } = boot({ captureSenders: OLD });
  await world.start(fakeHost(events));
  const file = join(dataDir, 'memory-core', 'turns.jsonl');
  const n = existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).length : 0;
  console.log('2) 旧默认值迁移 →', n, '行', n === 4 ? 'OK' : 'FAIL');
  await world.stop();
}

// 3) 回放：水位已经推到 999，开 captureBackfill 后能把历史补回来
{
  const dataDir = mkdtempSync(join(tmpdir(), 'mcore-back-'));
  const world = new MemoryCoreWorld({
    cfg: { ...MEMORY_CORE_DEFAULTS, enabled: true, siteEnabled: false, memoryEnabled: true, proactiveEnabled: false, captureBackfill: true },
    dataDir,
    timezone: 'Asia/Shanghai',
    botDir: dataDir,
  } as never);
  const host = fakeHost(events);
  await world.start(host);
  const file = join(dataDir, 'memory-core', 'turns.jsonl');
  const n = existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).length : 0;
  const st = JSON.parse(readFileSync(join(dataDir, 'memory-core', 'state.json'), 'utf8'));
  console.log('3) 回放 →', n, '行 | 水位', st.rawWatermark, '| 已完成标记', Boolean(st.backfillDoneAt),
    n === 4 && st.rawWatermark === 8 && st.backfillDoneAt ? 'OK' : 'FAIL');
  await world.stop();
}

// 4) 按天归档：过了热数据期的行挪进 archive/，不再直接删
{
  const dir = mkdtempSync(join(tmpdir(), 'mcore-arc-'));
  const log = new RawLog(dir, 7, 90);
  log.add([
    { cursor: 1, ts: ago(10), sender: 'private:1', text: '十天前说的话' },
    { cursor: 2, ts: ago(3), sender: 'private:1', text: '三天前说的话' },
  ]);
  const files = readdirSync(join(dir, 'archive'));
  console.log('4) 热数据', log.size, '行 | 归档文件', files.join(','),
    log.size === 1 && files.length === 1 ? 'OK' : 'FAIL');

  const hit = log.readArchive(30, 100);
  console.log('   翻归档 →', hit.map((h) => h.text), hit.length === 1 ? 'OK' : 'FAIL');
  console.log('   归档概况 →', JSON.stringify(log.stats()));

  const old = new RawLog(dir, 7, 5);
  const left = readdirSync(join(dir, 'archive'));
  console.log('5) 归档只留 5 天 → 文件', left.length, '个', left.length === 0 ? 'OK' : 'FAIL');
  void old;
}

// 6) 4000 行上限：溢出的部分也归档
{
  const dir = mkdtempSync(join(tmpdir(), 'mcore-cap2-'));
  const log = new RawLog(dir, 7, 90);
  const rows = Array.from({ length: 4100 }, (_, i) => ({
    cursor: i + 1,
    ts: new Date().toISOString(),
    sender: 'private:1',
    text: `第 ${i + 1} 句话`,
  }));
  log.add(rows);
  const archived = log.readArchive(30, 9999).length;
  console.log('6) 4100 行 → 热', log.size, '| 归档', archived, log.size === 4000 && archived === 100 ? 'OK' : 'FAIL');
}
