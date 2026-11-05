/**
 * 站点写接口的鉴权回归：令牌、Host 白名单、导出仍可下载。
 * 跑法：node --experimental-transform-types tools/test-site-auth.ts
 */
import { request as httpRequest } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemorySite, type SiteHooks } from '../src/site.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let bad = 0;
const ok = (cond: boolean, msg: string) => {
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${msg}`);
  if (!cond) bad += 1;
};

let created = 0;
const hooks: SiteHooks = {
  snapshot: () => ({}) as never,
  docs: () => [],
  docRoots: () => [],
  createCard: () => {
    created += 1;
    return { id: 'x', kind: 'fact', text: 't' } as never;
  },
  updateCard: () => undefined,
  deleteCard: () => false,
  retireCard: () => false,
  restoreCard: () => false,
  lineage: () => ({ card: null, supersedes: [], replacedBy: null }),
  maintenance: () => ({ dupes: [], stale: [], junk: [], retired: [], promises: { noDue: [], overdue: [] } }),
  mergeCards: () => ({ kept: null, merged: 0 }),
  purgeCards: () => 0,
  health: () => ({}) as never,
  importData: () => ({}) as never,
  archiveSearch: () => [],
  deleteTurn: () => false,
  patchState: () => ({}) as never,
  planAction: () => ({}),
  exportAll: () => ({ body: 'x', mime: 'text/plain', filename: 'x.txt' }),
};

const site = new MemorySite(hooks, join(root, 'webui'), 7877);
const origin = await site.start();
if (!origin) {
  console.log('FAIL 站点起不来');
  process.exit(1);
}
const port = Number(new URL(origin).port);
console.log(`站点 ${origin}`);

function call(
  method: string,
  path: string,
  opts: { headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, method, path, headers: { host: `127.0.0.1:${port}`, ...opts.headers } },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += String(c)));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

/* 1) 首页注入令牌 */
const home = await call('GET', '/');
const token = /name="mcore-token" content="([^"]+)"/.exec(home.body)?.[1] ?? '';
ok(home.status === 200 && token.length > 10, '1) 首页注入了令牌');
ok(home.body.includes('mcore-token'), '1) meta 标签在 HTML 里');

/* 2) Host 白名单 */
const evilHost = await call('GET', '/api/snapshot', { headers: { host: 'evil.example' } });
ok(evilHost.status === 403, `2) Host: evil.example 被拒（${evilHost.status}）`);
const evilHome = await call('GET', '/', { headers: { host: 'evil.example' } });
ok(evilHome.status === 403, `2) 伪造 Host 连首页都拿不到令牌（${evilHome.status}）`);
const localhostHost = await call('GET', '/api/snapshot', { headers: { host: `localhost:${port}` } });
ok(localhostHost.status === 200, '2) localhost 放行');

/* 3) 写接口要令牌 */
const noToken = await call('POST', '/api/cards', {
  headers: { 'content-type': 'text/plain' },
  body: '{"kind":"fact","text":"没有令牌"}',
});
ok(noToken.status === 403 && created === 0, `3) text/plain 不带令牌被拒（${noToken.status}）`);

const wrongToken = await call('POST', '/api/cards', {
  headers: { 'content-type': 'application/json', 'x-mcore-token': 'wrong-token-wrong-token' },
  body: '{"kind":"fact","text":"错令牌"}',
});
ok(wrongToken.status === 403 && created === 0, `3) 错令牌被拒（${wrongToken.status}）`);

const withToken = await call('POST', '/api/cards', {
  headers: { 'content-type': 'application/json', 'x-mcore-token': token },
  body: '{"kind":"fact","text":"带对令牌"}',
});
ok(withToken.status === 201 && created === 1, `3) 正确令牌写入成功（${withToken.status}）`);

/* 4) 只读接口不受令牌影响，导出仍可下载 */
const snap = await call('GET', '/api/snapshot');
ok(snap.status === 200, '4) GET 不需要令牌');
const exp = await call('GET', '/api/export?fmt=json');
ok(exp.status === 200 && exp.body === 'x', '4) 导出链接照常能下');

await site.stop();
console.log(bad ? `\n${bad} 项失败` : '\n全部通过');
process.exit(bad ? 1 : 0);
