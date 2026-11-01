/**
 * 演示站点：用一套虚构的示例记忆起一个临时站点，供拍市场截图用；Ctrl+C / SIGTERM 时清掉临时目录。
 * 跑：node --experimental-transform-types --no-warnings tools/demo-server.ts
 * 数据落在临时目录里，不碰真实记忆。
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MEMORY_CORE_DEFAULTS } from '../src/config.ts';
import { MemoryCoreWorld } from '../src/world.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'assets', 'screenshots');
const work = 'F:/Coopanion/data/backups/shots-work';
const port = 7809;

rmSync(work, { recursive: true, force: true });
mkdirSync(join(work, 'memory-core'), { recursive: true });
mkdirSync(outDir, { recursive: true });

const day = 86400000;
const now = Date.now();
const ago = (d: number, h = 0) => new Date(now - d * day - h * 3600000).toISOString();

type Seed = {
  kind: 'fact' | 'self' | 'episode' | 'promise' | 'note';
  text: string;
  tags: string[];
  weight: number;
  days: number;
  hours?: number;
  uses?: number;
  done?: boolean;
  dueAt?: string;
  status?: 'active' | 'retired';
  retiredAt?: string;
};

const seeds: Seed[] = [
  { kind: 'fact', text: '阿岚对花生过敏，点外卖记得避开花生和花生油。', tags: ['饮食', '健康'], weight: 0.92, days: 24, uses: 11 },
  { kind: 'fact', text: '她怕黑，睡觉要留一盏小夜灯。', tags: ['日常'], weight: 0.78, days: 18, uses: 6 },
  { kind: 'fact', text: '她在做一款独立游戏的关卡设计，最近卡在第三关的节奏。', tags: ['工作', '游戏'], weight: 0.85, days: 12, uses: 9 },
  { kind: 'fact', text: '她妈妈十月要来住两周，她有点紧张。', tags: ['家人'], weight: 0.72, days: 6, uses: 3 },
  { kind: 'self', text: '我答应过不在她忙的时候连发三条消息。', tags: ['相处'], weight: 0.88, days: 22, uses: 14 },
  { kind: 'self', text: '我说话偏短句，少用感叹号。', tags: ['语气'], weight: 0.8, days: 20, uses: 8 },
  { kind: 'self', text: '我记东西只记她亲口说过的，不替她补。', tags: ['语气'], weight: 0.75, days: 9, uses: 5 },
  { kind: 'episode', text: '凌晨两点陪她把第三关通了，她说那块屏幕光像海。', tags: ['游戏', '回忆'], weight: 0.9, days: 11, uses: 7 },
  { kind: 'episode', text: '下雨天她没带伞，我在楼下等到九点半。', tags: ['回忆'], weight: 0.83, days: 15, uses: 4 },
  { kind: 'episode', text: '她第一次叫我名字，是周三早上七点。', tags: ['回忆'], weight: 0.95, days: 19, uses: 9 },
  { kind: 'episode', text: '她第一次主动说「晚安」，说完就把手机扣在桌上。', tags: ['回忆'], weight: 0.86, days: 2, uses: 5 },
  { kind: 'episode', text: '（取消了）原本约好周日去看展，她临时要加班。', tags: ['日常'], weight: 0.4, days: 5, status: 'retired' },
  { kind: 'promise', text: '明早七点二十叫她起床，别早别晚。', tags: ['日常'], weight: 0.9, days: 1, dueAt: new Date(now + day).toISOString().slice(0, 10) + 'T07:20' },
  { kind: 'promise', text: '周五晚上提醒她交述职稿，她老是拖到最后一天。', tags: ['工作'], weight: 0.84, days: 3, dueAt: new Date(now + 3 * day).toISOString().slice(0, 10) + 'T20:00' },
  { kind: 'note', text: '她喝第二杯咖啡的时候心情最好，那会儿提事最容易成。', tags: ['日常'], weight: 0.68, days: 8, uses: 6 },
  { kind: 'episode', text: '今天她把第三关的存档发过来，说「你看着办」。', tags: ['游戏'], weight: 0.7, days: 0, hours: 3, uses: 1 },
];

const cards = seeds.map((s) => {
  const created = ago(s.days, s.hours ?? 0);
  return {
    id: randomUUID(),
    kind: s.kind,
    text: s.text,
    weight: s.weight,
    tags: s.tags,
    createdAt: created,
    updatedAt: created,
    source: s.days % 3 === 0 ? 'tool' : s.days % 3 === 1 ? 'map' : 'import:private-companion',
    origin: 'demo',
    uses: s.uses ?? 0,
    lastUsedAt: s.uses ? ago(Math.max(0, s.days - 1)) : undefined,
    ...(s.dueAt ? { dueAt: s.dueAt } : {}),
    ...(s.kind === 'promise' ? { done: Boolean(s.done) } : {}),
    status: s.status ?? 'active',
    ...(s.status === 'retired' ? { retiredAt: created, retiredBy: 'manual' } : {}),
    scope: 'main',
  };
});

writeFileSync(join(work, 'memory-core', 'cards.jsonl'), cards.map((c) => JSON.stringify(c)).join('\n') + '\n');
writeFileSync(
  join(work, 'memory-core', 'state.json'),
  JSON.stringify({ energy: 63, mood: 71, activity: '在窗边翻书', location: '房间', sleeping: false, createdAt: ago(0), updatedAt: ago(0) }),
);
writeFileSync(
  join(work, 'memory-core', 'plans.json'),
  JSON.stringify([
    { id: randomUUID(), time: '09:30', title: '陪她看关卡的回放', done: true },
    { id: randomUUID(), time: '14:00', title: '提醒她喝水', done: false },
    { id: randomUUID(), time: '21:00', title: '把第三关的节奏聊完', done: false },
  ]),
);

writeFileSync(
  join(work, 'memory-core', 'turns.jsonl'),
  [
    ['阿岚', '今天第三关那个存档你看了吗', 5],
    ['阿岚', '算了你先看着，我去洗个脸', 4.6],
    ['阿岚', '外面在下雨，忘了带伞', 3.2],
    ['阿岚', '嗯……今天有点累', 2.1],
    ['阿岚', '你先说，我听着', 1.4],
    ['阿岚', '晚安', 0.6],
    ['阿岚', '嗓子有点哑，别让我一直说话了', 0.4],
    ['阿岚', '明天七点二十叫我', 0.2],
  ]
    .map(([sender, text, hours], i) => JSON.stringify({ cursor: i + 1, ts: new Date(now - Number(hours) * 3600000).toISOString(), sender, text }))
    .join('\n') + '\n',
);

const writeDrive = () => {
  const file = join(root, 'webui', '_drive.html');
  writeFileSync(
    file,
    `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%}iframe{width:100%;height:100%;border:0}</style></head>
<body><iframe id="f" src="/"></iframe>
<script>
const mode = new URLSearchParams(location.search).get('mode') ?? 'graph';
const f = document.getElementById('f');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
f.addEventListener('load', async () => {
  await wait(1500);
  const d = f.contentDocument;
  // 关掉过渡动画：headless 的虚拟时间会把淡入卡在中途，截图就发灰
  const st = d.createElement('style');
  st.textContent = '*,*::before,*::after{transition:none!important;animation:none!important;backdrop-filter:none!important}';
  d.head.appendChild(st);
  if (mode === 'graph') {
    const c = d.querySelector('#graph');
    const r = c.getBoundingClientRect();
    const at = { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    for (let i = 0; i < 1; i += 1) {
      c.dispatchEvent(new WheelEvent('wheel', { ...at, deltaY: -120, bubbles: true, cancelable: true }));
      await wait(120);
    }
    return;
  }
  d.querySelector('#btn-more').click();
  await wait(400);
  d.querySelector('#m-maint').click();
  await wait(700);
  const tab = [...d.querySelectorAll('.maint-tabs button, #modal button')].find((b) => b.textContent.includes('回收站'));
  tab?.click();
});
</script></body></html>`,
  );
  return file;
};

const cfg = { ...MEMORY_CORE_DEFAULTS, siteEnabled: true, sitePort: port, captureTurns: false, proactiveEnabled: false };
const world = new MemoryCoreWorld({
  dataDir: work,
  cfg,
  timezone: 'Asia/Shanghai',
  botDir: work,
  host: { log: { info: () => {}, warn: () => {} } },
} as never);

const drive = writeDrive();
const keep = () => new Promise<void>(() => {});

await world.start({ log: { info: () => {}, warn: () => {} } } as never);
console.log(`READY http://127.0.0.1:${port} card=${cards.find((c) => c.kind === 'promise' && !c.done)!.id}`);
process.on('SIGTERM', async () => {
  await world.stop();
  rmSync(work, { recursive: true, force: true });
  rmSync(drive, { force: true });
  process.exit(0);
});
process.on('SIGINT', () => process.exit(0));
await keep();
