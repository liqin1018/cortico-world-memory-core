/**
 * 验证捕获与原文归档：白名单、回放、按天归档、归档保留。
 * 跑法：node --experimental-transform-types tools/test-capture.ts
 */
import { mkdtempSync, readFileSync, existsSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryCoreWorld } from '../src/world.ts';
import { MEMORY_CORE_DEFAULTS } from '../src/config.ts';
import { RawLog } from '../src/store.ts';

const OLD = '^(starpost\\.private\\.|qq\\.|desktop-pet\\.message)';
const EXPECT = 6;
const LAST = 10;
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
  // 宿主真实抬头：[时间] [输入方式] 说话人:正文 —— 这些都要剥掉，只留正文
  { cursor: 9, ts: new Date().toISOString(), senderKey: 'desktop-pet.chat', text: '[11-03 周二 18:06] [typed] 月:为什么你很少在B站评论' },
  { cursor: 10, ts: new Date().toISOString(), senderKey: 'starpost.private.7', text: '[星邮消息] {"kind":"text","text":"下午三点在老地方等你"}' },
];

function fakeHost(rows: typeof events) {
  return {
    log: { info: () => {}, warn: () => {}, error: () => {} },
    store: {
      // 照宿主真实语义：limit 是「从区间末尾取至多 limit 条」，不是从头取。
      // 这里早先写成从头 slice，正好把 v1「一次跳到历史末尾」的 bug 掩盖了。
      range: ({ fromCursor, toCursor, limit }: { fromCursor?: number; toCursor?: number; limit?: number }) => {
        let hit = rows.filter(
          (e) => (fromCursor === undefined || e.cursor >= fromCursor)
            && (toCursor === undefined || e.cursor <= toCursor),
        );
        if (limit !== undefined && hit.length > limit) hit = hit.slice(hit.length - limit);
        return hit;
      },
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
    lines.length === EXPECT && !texts.some((t) => t.includes('我在的') || t.includes('群里')) ? 'OK' : 'FAIL');
  await world.stop();
}

// 2) 老配置里的旧默认值会自动换成新默认（不然用户永远录不到）
{
  const { world, dataDir } = boot({ captureSenders: OLD });
  await world.start(fakeHost(events));
  const file = join(dataDir, 'memory-core', 'turns.jsonl');
  const n = existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).length : 0;
  console.log('2) 旧默认值迁移 →', n, '行', n === EXPECT ? 'OK' : 'FAIL');
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
    n === EXPECT && st.rawWatermark === LAST && st.backfillDoneAt ? 'OK' : 'FAIL');
  await world.stop();
}

// 3b) 长历史：匹配的都在开头，后面隔着一千多条无关事件。
//     v1 拿 {fromCursor, limit} 当分页，会一次跳到末尾，只可能留下最后几条。
{
  const long = Array.from({ length: 1500 }, (_, i) => ({
    cursor: i + 1,
    ts: new Date().toISOString(),
    senderKey: i < 5 ? 'desktop-pet.chat' : 'gaming.match',
    text: i < 5 ? `开头第 ${i + 1} 句话在这里` : '无关事件',
  }));
  const { world, dataDir } = boot({ captureBackfill: true });
  await world.start(fakeHost(long as never));
  const file = join(dataDir, 'memory-core', 'turns.jsonl');
  const rows = existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean) : [];
  const st = JSON.parse(readFileSync(join(dataDir, 'memory-core', 'state.json'), 'utf8'));
  console.log('3b) 长历史回放 →', rows.length, '行 | 水位', st.rawWatermark, '/ 1500',
    rows.length === 5 && st.rawWatermark === 1500 && st.backfillDoneAt ? 'OK' : 'FAIL');
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

// 7) 过期的新行直接进归档，不留在 turns.jsonl（否则下次启动会再归档一遍）
{
  const dir = mkdtempSync(join(tmpdir(), 'mcore-idem-'));
  const log = new RawLog(dir, 7, 90);
  log.add([
    { cursor: 1, ts: ago(10), sender: 'private:1', text: '十天前的旧话' },
    { cursor: 2, ts: new Date().toISOString(), sender: 'private:1', text: '今天的话' },
  ]);
  const hotLines = (d: string) => {
    const f = join(d, 'turns.jsonl');
    return existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean) : [];
  };
  const arcLines = (d: string) => {
    const a = join(d, 'archive');
    return existsSync(a)
      ? readdirSync(a).flatMap((n) => readFileSync(join(a, n), 'utf8').trim().split('\n').filter(Boolean))
      : [];
  };
  const hot1 = hotLines(dir).length;
  const arc1 = arcLines(dir).length;
  const again = new RawLog(dir, 7, 90); // 重启一次
  const arc2 = arcLines(dir).length;
  console.log('7) 热', hot1, '行 | 归档', arc1, '→ 重启后', arc2,
    hot1 === 1 && arc1 === 1 && arc2 === 1 ? 'OK' : 'FAIL');
  void log;
  void again;
}

// 8) 老版本留下的残局：过期行还在 turns.jsonl，archive 里也已经有一份 —— 不能写第二遍
{
  const dir = mkdtempSync(join(tmpdir(), 'mcore-idem2-'));
  const stale = { cursor: 1, ts: ago(10), sender: 'private:1', text: '老版本残留的旧话' };
  writeFileSync(join(dir, 'turns.jsonl'), JSON.stringify(stale) + '\n', 'utf8');
  mkdirSync(join(dir, 'archive'), { recursive: true });
  writeFileSync(join(dir, 'archive', `${stale.ts.slice(0, 10)}.jsonl`), JSON.stringify(stale) + '\n', 'utf8');
  const log = new RawLog(dir, 7, 90);
  const arc = readdirSync(join(dir, 'archive'))
    .flatMap((n) => readFileSync(join(dir, 'archive', n), 'utf8').trim().split('\n').filter(Boolean));
  const hot = readFileSync(join(dir, 'turns.jsonl'), 'utf8').trim();
  console.log('8) 残留行已归档 → 归档', arc.length, '行 | 热文件', hot ? '还有残留' : '已清空',
    arc.length === 1 && !hot ? 'OK' : 'FAIL');
  void log;
}

// 9) 文件里行序是乱的（老行在前、补录行在后），读出来要按 cursor 归位
//    真实环境里补录 1327 行时就踩过：原文页显示成 8:25 → 10:32 → 8:24
{
  const dir = mkdtempSync(join(tmpdir(), 'mcore-sort-'));
  const now = new Date().toISOString();
  const rows = [
    { cursor: 900, ts: now, sender: 'private:1', text: '后写进来的' },
    { cursor: 5, ts: now, sender: 'private:1', text: '补录回来的' },
    { cursor: 40, ts: now, sender: 'private:1', text: '中间的' },
  ];
  writeFileSync(join(dir, 'turns.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  const log = new RawLog(dir, 7, 90);
  const out = log.all().map((e) => e.cursor);
  console.log('9) 乱序文件 → 读出', out.join(','), out.join(',') === '5,40,900' ? 'OK' : 'FAIL');
}
