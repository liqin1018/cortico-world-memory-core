/**
 * 记忆地图的本地站点：一个只绑 127.0.0.1 的小 HTTP 服务。
 *
 * 六条约束（改的时候别破坏）：
 *   1) **只绑 127.0.0.1** —— 站点不对局域网露面；
 *   2) **只认 127.0.0.1 / localhost 这两个 Host** —— 别人把域名解析到本机（DNS 重绑定）也进不来；
 *   3) **写接口必须带页面注入的一次性令牌** —— 别的网页能打 localhost，但拿不到这个令牌；
 *   4) 端口被占就 +1 重试，起不来不算致命，只少一个链接；
 *   5) 写操作走**插件内存里的同一份 store**，不直接改文件 ——
 *      否则宿主下一次 save() 会用内存状态把文件覆盖回去；
 *   6) 读文件接口只允许在已扫描的目录内，防目录穿越。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { Card, CoreState, PlanItem, RawEntry } from './store.ts';
import type { DocFile } from './workspace.ts';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

const MAX_PORT_TRIES = 10;
const MAX_BODY = 512 * 1024;
/** 导入的是整包备份，比日常请求大得多。 */
const MAX_IMPORT = 32 * 1024 * 1024;

export interface Snapshot {
  now: string;
  cards: readonly Card[];
  turns: readonly RawEntry[];
  plans: readonly PlanItem[];
  state: CoreState;
  proactive: { enabled: boolean; count: number; cap: number; dueAt: string | null; lastTalkAt: string | null };
  stats: {
    total: number;
    retired: number;
    byKind: Record<string, number>;
    openPromises: number;
    overdue: number;
    todayNew: number;
    weekNew: number;
    avgWeight: number;
    tags: Array<{ tag: string; n: number }>;
    byDay: Array<{ day: string; n: number }>;
    scopes: Array<{ scope: string; n: number }>;
  };
  docs: { enabled: boolean; count: number; dirs: string[] };
  archive: { days: number; bytes: number; oldest: string; retention: number };
  site: { port: number; origin: string };
}

export interface MaintenanceReport {
  dupes: Array<{ score: number; ids: string[] }>;
  stale: string[];
  junk: string[];
  retired: string[];
  /** 承诺：没写截止时间的提醒管线管不到；overdue 是已过期还没做的。 */
  promises: { noDue: string[]; overdue: string[] };
}

export interface HealthReport {
  generatedAt: string;
  cards: { total: number; active: number; retired: number; dead: number };
  recall: { calls: number; cardsTouched: number; primed: number };
  perDay: Array<{ day: string; n: number }>;
  promises: { open: number; overdue: number; noDue: number; repeating: number };
  raw: { lines: number; archivedDays: number; archivedLines: number };
  backup: { count: number; latest: string | null; dir: string };
  deadIds: string[];
}

export interface ImportReport {
  cards: { added: number; skipped: number };
  turns: { added: number; skipped: number };
  plans: { added: number; skipped: number };
  state: { watermark: number };
  warnings: string[];
}

export interface SiteHooks {
  snapshot(): Snapshot;
  docs(): readonly DocFile[];
  docRoots(): string[];
  createCard(input: Record<string, unknown>): Card;
  updateCard(id: string, patch: Record<string, unknown>): Card | undefined;
  deleteCard(id: string): boolean;
  retireCard(id: string): boolean;
  restoreCard(id: string): boolean;
  lineage(id: string): { card: Card | null; supersedes: Card[]; replacedBy: Card | null };
  maintenance(): MaintenanceReport;
  mergeCards(keepId: string, dropIds: string[]): { kept: Card | null; merged: number };
  purgeCards(ids: string[]): number;
  health(): HealthReport;
  importData(payload: Record<string, unknown>): ImportReport;
  /** 在按天归档的旧原文里搜（页面上的「含归档」开关）。 */
  archiveSearch(q: string, days: number, limit: number): RawEntry[];
  /** 删掉一条原文（热数据或归档）。 */
  deleteTurn(cursor: number): boolean;
  patchState(input: Record<string, unknown>): CoreState;
  planAction(input: Record<string, unknown>): unknown;
  exportAll(fmt: string): { body: string; mime: string; filename: string };
}

export class MemorySite {
  private server: Server | null = null;
  private port: number | null = null;
  private readonly basePort: number;
  private readonly webDir: string;
  /** 进程级一次性令牌：只有这个站点发出的页面才知道，别的网页拿不到。 */
  private readonly token = randomBytes(18).toString('base64url');

  constructor(private readonly hooks: SiteHooks, webDir: string, port: number) {
    this.webDir = resolve(webDir);
    this.basePort = Number(port) || 7801;
  }

  get origin(): string | null {
    return this.port ? `http://127.0.0.1:${this.port}` : null;
  }

  async start(): Promise<string | null> {
    if (this.server) return this.origin;
    for (let i = 0; i < MAX_PORT_TRIES; i += 1) {
      const port = this.basePort + i;
      if (await this.tryListen(port)) {
        this.port = port;
        return this.origin;
      }
    }
    return null;
  }

  private tryListen(port: number): Promise<boolean> {
    return new Promise((res) => {
      const server = createServer((req, rsp) => {
        this.handle(req, rsp).catch((error: unknown) => {
          this.json(rsp, 500, { error: error instanceof Error ? error.message : String(error) });
        });
      });
      server.once('error', () => {
        try {
          server.close();
        } catch {
          // 已经关了
        }
        res(false);
      });
      server.listen(port, '127.0.0.1', () => {
        server.removeAllListeners('error');
        server.on('error', () => {
          // 运行期错误不该让进程挂掉
        });
        this.server = server;
        res(true);
      });
    });
  }

  async stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    this.port = null;
    if (!s) return;
    await new Promise<void>((res) => s.close(() => res()));
  }

  // ---- 路由 ----

  private async handle(req: IncomingMessage, rsp: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;

    // 只认本机这两个 Host：域名解析到 127.0.0.1（DNS 重绑定）会在这一步被挡掉
    if (!this.hostOk(req)) return this.json(rsp, 403, { error: '只能通过 127.0.0.1 或 localhost 打开' });

    if (path.startsWith('/api/')) return this.api(req, rsp, url, path);

    // 无域名、无认证：只服务本机，禁止被 iframe 之外的地方引用
    if (req.method !== 'GET' && req.method !== 'HEAD') return this.text(rsp, 405, 'method not allowed');
    const file = path === '/' ? 'index.html' : path.replace(/^\/+/, '');
    return this.sendFile(rsp, file);
  }

  private hostOk(req: IncomingMessage): boolean {
    const host = String(req.headers.host ?? '').toLowerCase();
    const port = this.port ?? this.basePort;
    return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
  }

  /** 定长比较，别用 === 给出计时侧信道。 */
  private tokenOk(req: IncomingMessage): boolean {
    const got = String(req.headers['x-mcore-token'] ?? '');
    if (got.length !== this.token.length) return false;
    try {
      return timingSafeEqual(Buffer.from(got), Buffer.from(this.token));
    } catch {
      return false;
    }
  }

  private async api(req: IncomingMessage, rsp: ServerResponse, url: URL, path: string): Promise<void> {
    // GET/HEAD 是只读，随便看（跨站也读不到内容，因为没有 CORS 头）；
    // 其余方法一律要令牌——跨站页面能打到这里，但发不出这个头。
    if (req.method !== 'GET' && req.method !== 'HEAD' && !this.tokenOk(req)) {
      return this.json(rsp, 403, { error: '写操作需要页面上带过来的一次性令牌，刷新一下页面' });
    }
    if (path === '/api/snapshot' && req.method === 'GET') {
      return this.json(rsp, 200, this.hooks.snapshot());
    }
    if (path === '/api/docs' && req.method === 'GET') {
      return this.json(rsp, 200, {
        roots: this.hooks.docRoots(),
        files: this.hooks.docs().map(({ text, ...rest }) => ({ ...rest, chars: text.length })),
      });
    }
    if (path === '/api/doc' && req.method === 'GET') {
      const target = url.searchParams.get('path') ?? '';
      return this.sendDoc(rsp, target);
    }
    if (path === '/api/export' && req.method === 'GET') {
      const fmt = url.searchParams.get('fmt') === 'md' ? 'md' : 'json';
      const out = this.hooks.exportAll(fmt);
      rsp.writeHead(200, {
        'content-type': `${out.mime}; charset=utf-8`,
        'content-disposition': `attachment; filename="${out.filename}"`,
        'cache-control': 'no-store',
      });
      return rsp.end(out.body);
    }
    if (path === '/api/cards' && req.method === 'POST') {
      const body = await this.body(req);
      const card = this.hooks.createCard(body);
      return this.json(rsp, 201, card);
    }
    if (path === '/api/maintenance' && req.method === 'GET') {
      return this.json(rsp, 200, this.hooks.maintenance());
    }
    if (path === '/api/merge' && req.method === 'POST') {
      const body = await this.body(req);
      const keep = String(body.keep ?? '');
      const drop = Array.isArray(body.drop) ? (body.drop as unknown[]).map((x) => String(x)) : [];
      if (!keep) return this.json(rsp, 400, { error: '缺少要保留的那条' });
      return this.json(rsp, 200, this.hooks.mergeCards(keep, drop));
    }
    if (path === '/api/purge' && req.method === 'POST') {
      const body = await this.body(req);
      const ids = Array.isArray(body.ids) ? (body.ids as unknown[]).map((x) => String(x)) : [];
      return this.json(rsp, 200, { removed: this.hooks.purgeCards(ids) });
    }
    if (path === '/api/health' && req.method === 'GET') {
      return this.json(rsp, 200, this.hooks.health());
    }
    if (path === '/api/archive' && req.method === 'GET') {
      const q = (url.searchParams.get('q') ?? '').trim();
      const days = Number(url.searchParams.get('days') ?? 90) || 90;
      const limit = Number(url.searchParams.get('limit') ?? 40) || 40;
      return this.json(rsp, 200, q ? this.hooks.archiveSearch(q, days, limit) : []);
    }
    const turnMatch = /^\/api\/turns\/(\d{1,12})$/.exec(path);
    if (turnMatch && req.method === 'DELETE') {
      return this.json(rsp, 200, { removed: this.hooks.deleteTurn(Number(turnMatch[1])) });
    }
    if (path === '/api/import' && req.method === 'POST') {
      let body: Record<string, unknown>;
      try {
        body = await this.body(req, MAX_IMPORT);
      } catch (err) {
        return this.json(rsp, 400, { error: err instanceof Error ? err.message : '读不了请求体' });
      }
      try {
        return this.json(rsp, 200, this.hooks.importData(body));
      } catch (err) {
        return this.json(rsp, 400, { error: err instanceof Error ? err.message : '导入失败' });
      }
    }
    const actionMatch = /^\/api\/cards\/([\w-]{1,60})\/(retire|restore|lineage)$/.exec(path);
    if (actionMatch) {
      const [, id, action] = actionMatch;
      if (action === 'lineage' && req.method === 'GET') {
        return this.json(rsp, 200, this.hooks.lineage(id));
      }
      if (req.method === 'POST') {
        if (action === 'retire') return this.hooks.retireCard(id) ? this.json(rsp, 200, { ok: true }) : this.json(rsp, 404, { error: '没有这条记忆' });
        if (action === 'restore') return this.hooks.restoreCard(id) ? this.json(rsp, 200, { ok: true }) : this.json(rsp, 404, { error: '没有这条记忆' });
      }
      return this.json(rsp, 405, { error: 'method not allowed' });
    }
    const cardMatch = /^\/api\/cards\/([\w-]{1,60})$/.exec(path);
    if (cardMatch) {
      const id = cardMatch[1];
      if (req.method === 'PATCH' || req.method === 'PUT') {
        const body = await this.body(req);
        const card = this.hooks.updateCard(id, body);
        return card ? this.json(rsp, 200, card) : this.json(rsp, 404, { error: '没有这条记忆' });
      }
      if (req.method === 'DELETE') {
        return this.hooks.deleteCard(id) ? this.json(rsp, 200, { ok: true }) : this.json(rsp, 404, { error: '没有这条记忆' });
      }
    }
    if (path === '/api/state' && req.method === 'POST') {
      const body = await this.body(req);
      return this.json(rsp, 200, this.hooks.patchState(body));
    }
    if (path === '/api/plans' && req.method === 'POST') {
      const body = await this.body(req);
      return this.json(rsp, 200, this.hooks.planAction(body));
    }
    return this.json(rsp, 404, { error: `未知接口 ${path}` });
  }

  private sendDoc(rsp: ServerResponse, rawPath: string): void {
    let target: string;
    try {
      target = normalize(decodeURIComponent(rawPath));
    } catch {
      return this.text(rsp, 400, 'bad path');
    }
    const roots = this.hooks.docRoots();
    const abs = resolve(target);
    const allowed = roots.some((root) => {
      const base = resolve(root);
      const prefix = base.endsWith(sep) ? base : base + sep;
      return abs.toLowerCase() === base.toLowerCase() || abs.toLowerCase().startsWith(prefix.toLowerCase());
    });
    if (!allowed) return this.json(rsp, 403, { error: '只能读配置里允许的目录' });
    if (!existsSync(target)) return this.json(rsp, 404, { error: '文件不在了' });
    const file = this.hooks.docs().find((d) => resolve(d.path) === resolve(target));
    if (!file) return this.json(rsp, 404, { error: '文件不在扫描结果里（可能太大或后缀不符）' });
    return this.json(rsp, 200, { path: file.path, name: file.name, rel: file.rel, mtimeMs: file.mtimeMs, text: file.text });
  }

  // ---- 静态文件 ----

  private sendFile(rsp: ServerResponse, rel: string): void {
    const safe = normalize(rel).replace(/^([.][.][\\/])+/, '');
    const full = join(this.webDir, safe);
    if (!full.startsWith(this.webDir + sep) && full !== this.webDir) return this.text(rsp, 403, 'forbidden');
    if (!existsSync(full)) return this.text(rsp, 404, 'not found');
    try {
      if (!statSync(full).isFile()) return this.text(rsp, 404, 'not found');
      const body = readFileSync(full);
      const type = MIME[extname(full).toLowerCase()] ?? 'application/octet-stream';
      // 首页注入一次性令牌：app.js 把它放进每个写请求的头里。
      // 这份 HTML 不进缓存，否则进程重启后旧令牌会让所有写操作 403。
      if (safe === 'index.html') {
        const html = body
          .toString('utf8')
          .replace('<head>', `<head>\n<meta name="mcore-token" content="${this.token}">`);
        rsp.writeHead(200, {
          'content-type': type,
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        });
        return rsp.end(html);
      }
      rsp.writeHead(200, {
        'content-type': type,
        'cache-control': 'no-cache',
        'x-content-type-options': 'nosniff',
      });
      rsp.end(body);
    } catch {
      this.text(rsp, 500, 'read failed');
    }
  }

  private readBody(req: IncomingMessage, limit = MAX_BODY): Promise<string> {
    return new Promise((res, rej) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > limit) {
          rej(new Error('请求体太大'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => res(Buffer.concat(chunks).toString('utf8')));
      req.on('error', rej);
    });
  }

  private async body(req: IncomingMessage, limit = MAX_BODY): Promise<Record<string, unknown>> {
    const raw = await this.readBody(req, limit);
    if (!raw.trim()) return {};
    try {
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    } catch {
      throw new Error('请求体不是合法 JSON');
    }
  }

  private json(rsp: ServerResponse, code: number, payload: unknown): void {
    const body = JSON.stringify(payload);
    rsp.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    rsp.end(body);
  }

  private text(rsp: ServerResponse, code: number, msg: string): void {
    rsp.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' });
    rsp.end(msg);
  }
}
