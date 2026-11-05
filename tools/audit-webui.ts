/**
 * 前端静态自检：查那些「node --check 查不出来、只有点到才炸」的问题。
 *  1) app.js 里 $('\\#id') 引用的元素，index.html 里到底有没有；
 *  2) S.xxx 读取的属性，S 对象上到底有没有定义（0.1.0 的搜索框就是这么坏的）；
 *  3) 前端 api('/path') 调的接口，site.ts 里有没有对应路由。
 * 跑法：node --experimental-transform-types tools/audit-webui.ts
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const app = readFileSync(join(root, 'webui', 'app.js'), 'utf8');
const html = readFileSync(join(root, 'webui', 'index.html'), 'utf8');
const site = readFileSync(join(root, 'src', 'site.ts'), 'utf8');
// 源码里的路由正则写成 \/api\/turns\/，比对前先把转义去掉
const sitePlain = site.split('\\/').join('/');

let bad = 0;
const fail = (msg: string) => {
  bad += 1;
  console.log(`FAIL ${msg}`);
};

/* 1) DOM id */
const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
const used = new Set<string>();
for (const m of app.matchAll(/\$\('#([A-Za-z0-9_-]+)'\)/g)) used.add(m[1]);
for (const m of app.matchAll(/querySelector\('#([A-Za-z0-9_-]+)'\)/g)) used.add(m[1]);
for (const m of app.matchAll(/getElementById\('([A-Za-z0-9_-]+)'\)/g)) used.add(m[1]);
const missingIds = [...used].filter((id) => !htmlIds.has(id) && !app.includes(`id="${id}"`));
if (missingIds.length) fail(`app.js 引用了不存在的元素：${missingIds.join('、')}`);
else console.log(`OK   DOM：${used.size} 个 id 引用全部存在`);

/* 2) S 上的属性 */
const sBlock = /const S = \{([\s\S]*?)\n\};/.exec(app)?.[1] ?? '';
const sKeys = new Set([...sBlock.matchAll(/^\s{2}([A-Za-z_$][\w$]*):/gm)].map((m) => m[1]));
const assigned = new Set([...app.matchAll(/\bS\.([A-Za-z_$][\w$]*)\s*=(?!=)/g)].map((m) => m[1]));
const readProps = new Set([...app.matchAll(/\bS\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]));
const ghost = [...readProps].filter((k) => !sKeys.has(k) && !assigned.has(k));
if (ghost.length) fail(`读到了 S 上不存在的属性：${ghost.join('、')}`);
else console.log(`OK   S：${readProps.size} 个属性引用全部有定义`);

/* 3) 前端调的接口 vs 后端路由 */
const clientPaths = new Set(
  [...app.matchAll(/api\(\s*[`'"]([^`'"?]+)/g)]
    .map((m) => m[1])
    .filter((p) => p.startsWith('/api/'))
    .map((p) => p.replace(/\/\$\{[^}]+\}.*$/, '') || p),
);
const serverPaths = new Set([...site.matchAll(/path === '(\/api\/[^']+)'/g)].map((m) => m[1]));
const unknown = [...clientPaths].filter((p) => {
  if (serverPaths.has(p)) return false;
  // 带参数的路径（/api/cards/:id、/api/turns/:cursor）在源码里是正则匹配的，按前缀放行
  if (p === '/api/cards' || p === '/api/turns') return !sitePlain.includes(`${p}/`);
  return true;
});
if (unknown.length) fail(`前端调了后端没有的接口：${unknown.join('、')}`);
else console.log(`OK   接口：前端 ${clientPaths.size} 个调用全部有对应路由`);

/* 4) 顺手查两个容易忘的：模板里残留的 undefined / NaN */
const suspicious = [...app.matchAll(/\$\{([^}]{1,60})\}/g)]
  .map((m) => m[1])
  .filter((expr) => /\.(length|slice|toFixed)\(/.test(expr) && !/\?\?|\?\.|if /.test(expr));
if (suspicious.length) console.log(`提示 有 ${suspicious.length} 处模板表达式直接取属性，注意空值：${suspicious.slice(0, 3).join(' | ')}`);

console.log(bad ? `\n${bad} 项问题` : '\n前端自检通过');
process.exit(bad ? 1 : 0);
