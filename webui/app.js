/* 记忆地图前端：无框架、无依赖，数据全部来自本机 /api/*。 */

const $ = (sel, root = document) => root.querySelector(sel);

const KINDS = [
  { id: 'fact', label: '事实', css: '--k-fact' },
  { id: 'self', label: '她自己', css: '--k-self' },
  { id: 'episode', label: '经历', css: '--k-episode' },
  { id: 'promise', label: '承诺', css: '--k-promise' },
  { id: 'note', label: '临时', css: '--k-note' },
];

/** 原文页一次渲染多少条。7 天窗口实测稳定在 1000 条上下，全量拼 DOM 会卡。 */
const TURNS_PAGE = 200;

const S = {
  snap: null,
  view: 'graph',
  query: '',
  kinds: new Set(),
  minWeight: 0,
  range: 'all',
  tag: null,
  selected: null,
  editing: false,
  sort: { key: 'createdAt', dir: -1 },
  docs: null,
  docsLoading: false,
  docSel: null,
  docText: null,
  showLabels: true,
  starfield: localStorage.getItem('mcore-stars') === '1',
  inspCollapsed: (localStorage.getItem('mcore-insp') ?? 'off') === 'off',
  status: 'active', // active | all | retired
  scope: null,
  maintenance: null,
  health: null,
  withArchive: localStorage.getItem('mcore-archive') === '1',
  archive: null,
  archiveQ: '',
  turnsLimit: TURNS_PAGE,
};

/** 视图清单：加一个视图只要在这里加名字，HTML 里加 tab 和容器。 */
const VIEWS = ['galaxy', 'graph', 'timeline', 'table', 'turns', 'docs', 'health'];

const el = {
  search: $('#search'),
  searchClear: $('#search-clear'),
  metrics: $('#metrics'),
  rail: $('#rail'),
  inspector: $('#inspector'),
  inspBody: $('#insp-body'),
  inspStub: $('#insp-stub'),
  statusCount: $('#status-count'),
  statusSite: $('#status-site'),
  brandSub: $('#brand-sub'),
  modal: $('#modal'),
  modalTitle: $('#modal-title'),
  modalBody: $('#modal-body'),
  modalFoot: $('#modal-foot'),
  toast: $('#toast'),
  menu: $('#menu'),
};

/* ── 小工具 ─────────────────────────────────────────── */

const pad = (n) => String(n).padStart(2, '0');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (n, a, b) => Math.min(b, Math.max(a, n));

function kindOf(id) {
  return KINDS.find((k) => k.id === id) ?? { id, label: id, css: '--ink-dim' };
}

function color(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
}

let PALETTE = null;
function palette() {
  if (PALETTE) return PALETTE;
  PALETTE = {
    ink: color('--ink'),
    line: color('--line-strong'),
    paper: color('--paper-2'),
    kinds: Object.fromEntries(KINDS.map((k) => [k.id, color(k.css)])),
  };
  return PALETTE;
}
function invalidatePalette() {
  PALETTE = null;
}

function fmtTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function dayKey(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function dayLabel(key) {
  const today = dayKey(new Date().toISOString());
  const yesterday = dayKey(new Date(Date.now() - 86400000).toISOString());
  if (key === today) return '今天';
  if (key === yesterday) return '昨天';
  const [y, m, d] = key.split('-');
  const date = new Date(Number(y), Number(m) - 1, Number(d));
  const week = '日一二三四五六'[date.getDay()];
  return `${m} 月 ${d} 日 · 周${week}`;
}

function relative(iso) {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return '—';
  const diff = Date.now() - at;
  if (diff < 60_000) return '刚刚';
  if (diff < 3600_000) return `${Math.round(diff / 60_000)} 分钟前`;
  if (diff < 86400_000) return `${Math.round(diff / 3600_000)} 小时前`;
  const days = Math.round(diff / 86400_000);
  return days < 30 ? `${days} 天前` : `${Math.round(days / 30)} 个月前`;
}

function tokens(q) {
  return String(q ?? '')
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

function matches(text, toks) {
  if (!toks.length) return true;
  const hay = text.toLowerCase();
  return toks.every((t) => hay.includes(t));
}

function highlight(text, q) {
  const toks = tokens(q).filter((t) => t.length > 0);
  let html = esc(text);
  if (!toks.length) return html;
  const pattern = toks
    .sort((a, b) => b.length - a.length)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  try {
    html = html.replace(new RegExp(`(${pattern})`, 'gi'), '<mark>$1</mark>');
  } catch {
    /* 正则出错就原样 */
  }
  return html;
}

function toast(msg, isErr = false) {
  el.toast.textContent = msg;
  el.toast.classList.toggle('err', isErr);
  el.toast.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    el.toast.hidden = true;
  }, isErr ? 4200 : 1900);
}

/** 带撤销按钮的提示条：10 秒内点一下，把刚才删的整包灌回来。 */
function toastUndo(msg, onUndo, ms = 10000) {
  el.toast.innerHTML = `<span>${esc(msg)}</span><button type="button" class="toast-undo">撤销</button>`;
  el.toast.classList.remove('err');
  el.toast.hidden = false;
  clearTimeout(toast._t);
  el.toast.querySelector('.toast-undo')?.addEventListener('click', async () => {
    el.toast.hidden = true;
    clearTimeout(toast._t);
    await onUndo();
  });
  toast._t = setTimeout(() => {
    el.toast.hidden = true;
  }, ms);
}

/**
 * 彻底删除：先把要删的摆出来确认，删完 10 秒内可撤销。
 * 撤销走 /api/import（只加不覆盖），所以不会把后来新写的记忆冲掉。
 */
async function purgeWithUndo(ids) {
  const victims = ids.map((id) => cards().find((c) => c.id === id)).filter(Boolean);
  if (!victims.length) return 0;
  const preview = victims.slice(0, 5).map((c) => `· ${c.text.slice(0, 40)}`).join('\n');
  const more = victims.length > 5 ? `\n…还有 ${victims.length - 5} 条` : '';
  if (!confirm(`彻底删除这 ${victims.length} 条？\n\n${preview}${more}\n\n删了之后 10 秒内可以撤销。`)) return 0;
  const res = await api('/api/purge', { method: 'POST', body: JSON.stringify({ ids }) });
  const removed = Number(res.removed ?? 0);
  toastUndo(`删了 ${removed} 条`, async () => {
    try {
      await api('/api/import', { method: 'POST', body: JSON.stringify({ cards: victims }) });
      await load();
      toast('已撤销');
    } catch (err) {
      toast(`撤销失败：${err.message}`, true);
    }
  });
  return removed;
}

// 服务端把一次性令牌写进首页的 meta，写接口靠它认「这是自己发的页面」
const TOKEN = document.querySelector('meta[name="mcore-token"]')?.content ?? '';

async function api(path, init = {}) {
  const res = await fetch(path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(TOKEN ? { 'x-mcore-token': TOKEN } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    let msg = `${res.status}`;
    try {
      const body = await res.json();
      if (body && body.error) msg = body.error;
    } catch {
      /* 非 JSON */
    }
    throw new Error(msg);
  }
  if (res.status === 204) return null;
  const type = res.headers.get('content-type') ?? '';
  return type.includes('application/json') ? res.json() : res.text();
}

/* ── 主题 ───────────────────────────────────────────── */

function readThemeHandoff() {
  const hash = location.hash.replace(/^#/, '');
  if (!hash) return null;
  const params = new URLSearchParams(hash);
  const raw = params.get('cortico-theme');
  if (!raw) return null;
  try {
    const b64 = raw.replace(/-/g, '+').replace(/_/g, '/');
    const json = JSON.parse(atob(b64));
    return json && json.palette ? json : null;
  } catch {
    return null;
  }
}

function applyTheme() {
  invalidatePalette();
  const root = document.documentElement;
  // 调试/截图用：?theme=light|dark|auto 直接定死
  const forced = new URLSearchParams(location.search).get('theme');
  const saved = forced ?? localStorage.getItem('mcore-mode') ?? 'auto';
  // 用户手动选过就听用户的：宿主主题快照不再覆盖，否则按钮点了没反应
  const handoff = saved === 'auto' ? readThemeHandoff() : null;
  if (handoff) {
    root.dataset.mode = handoff.appearance === 'light' ? 'light' : 'dark';
    for (const [key, value] of Object.entries(handoff.palette)) {
      if (/^#[0-9a-f]{3,8}$/i.test(String(value))) root.style.setProperty(`--${key}`, value);
    }
    return;
  }
  root.dataset.mode = saved === 'light' ? 'light' : saved === 'dark' ? 'dark' : 'auto';
}

/** 现在屏幕上到底是什么样：auto 和宿主快照都折算成 light / dark。 */
function currentAppearance() {
  const mode = document.documentElement.dataset.mode;
  if (mode === 'light' || mode === 'dark') return mode;
  return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

$('#btn-theme').addEventListener('click', () => {
  // 按「屏幕上现在是什么」翻面：每次都一定看得见变化，
  // 不会出现「本来是浅色，点了先跳到 auto 还是浅色，以为坏了」。
  const next = currentAppearance() === 'light' ? 'dark' : 'light';
  localStorage.setItem('mcore-mode', next);
  document.documentElement.removeAttribute('style');
  applyTheme();
  render();
  toast(next === 'light' ? '浅色' : '深色');
});

/* ── 数据与筛选 ─────────────────────────────────────── */

async function load({ quiet = false } = {}) {
  try {
    const snap = await api('/api/snapshot');
    S.snap = snap;
    render();
  } catch (err) {
    toast(`读不到数据：${err.message}`, true);
  }
}

function cards() {
  return S.snap?.cards ?? [];
}

function isRetired(c) {
  return c.status === 'retired';
}

function liveCards() {
  return cards().filter((c) => !isRetired(c));
}

function filtered() {
  const toks = tokens(S.query);
  const cutoff = S.range === 'all' ? 0 : Date.now() - Number(S.range) * 86400000;
  return cards().filter((c) => {
    if (S.status === 'active' && isRetired(c)) return false;
    if (S.status === 'retired' && !isRetired(c)) return false;
    if (S.scope && (c.scope ?? 'main') !== S.scope) return false;
    if (S.kinds.size && !S.kinds.has(c.kind)) return false;
    if (c.weight < S.minWeight) return false;
    if (cutoff && Date.parse(c.createdAt) < cutoff) return false;
    if (S.tag && !c.tags.includes(S.tag)) return false;
    if (toks.length && !matches(`${c.text} ${c.tags.join(' ')}`, toks)) return false;
    return true;
  });
}

function selectedCard() {
  if (!S.selected) return null;
  return cards().find((c) => c.id === S.selected) ?? null;
}

/* ── 右栏折叠 ───────────────────────────────────────── */

function applyInspState() {
  document.body.dataset.insp = S.inspCollapsed ? 'off' : 'on';
  const badge = $('#stub-count');
  if (badge) badge.textContent = String(filtered().length);
}

function setInspCollapsed(off) {
  S.inspCollapsed = Boolean(off);
  localStorage.setItem('mcore-insp', S.inspCollapsed ? 'off' : 'on');
  applyInspState();
}

function selectCard(id, { scroll = false } = {}) {
  S.selected = id ?? null;
  S.editing = false;
  setInspCollapsed(!id); // 选中就展开详情，取消就收回去
  renderStage();
  renderInspector();
  renderStatus();
  if (scroll && id) {
    document.querySelector(`.tl-item[data-id="${id}"], tr[data-id="${id}"]`)?.scrollIntoView({ block: 'nearest' });
  }
}

function bindInspCollapse() {
  const btn = $('#btn-insp-collapse');
  if (btn) btn.addEventListener('click', () => setInspCollapsed(true));
}

/* ── 顶栏指标 ───────────────────────────────────────── */

function renderMetrics() {
  const st = S.snap?.stats;
  if (!st) {
    el.metrics.innerHTML = '';
    return;
  }
  const max = Math.max(1, ...st.byDay.map((d) => d.n));
  const spark = st.byDay
    .map((d, i) => `<i class="${i === st.byDay.length - 1 ? 'today' : ''}" style="height:${Math.max(2, (d.n / max) * 28)}px" title="${d.day} · ${d.n} 条"></i>`)
    .join('');
  const items = [
    { label: '记忆', value: st.total, unit: '条' },
    { label: '未完成承诺', value: st.openPromises, unit: st.overdue ? `含逾期 ${st.overdue}` : '条', tone: st.overdue ? 'warn' : '' },
    { label: '今天新增', value: st.todayNew, unit: '条' },
    { label: '近 7 天', value: st.weekNew, unit: '条' },
    { label: '平均权重', value: st.avgWeight.toFixed(2), unit: '' },
    { label: '对话原文', value: (S.snap.turns ?? []).length, unit: S.snap.archive?.days ? `行 · 归档 ${S.snap.archive.days} 天` : '行' },
    { label: '工作区文件', value: S.snap.docs?.count ?? 0, unit: '个', tone: S.snap.docs?.enabled ? '' : '' },
  ];
  el.metrics.innerHTML =
    items
      .map(
        (m) =>
          `<div class="metric ${m.tone ?? ''}"><span class="label">${m.label}</span><span class="value">${esc(String(m.value))}${
            m.unit ? `<small>${esc(m.unit)}</small>` : ''
          }</span></div>`,
      )
      .join('') + `<div class="spark" title="近 14 天新增">${spark}</div>`;
}

/* ── 左栏筛选 ───────────────────────────────────────── */

function renderRail() {
  const st0 = S.snap?.stats;
  // 类型计数跟着「状态」走：看已退休时，数字也是已退休的
  const all = cards().filter((c) =>
    S.status === 'active' ? !isRetired(c) : S.status === 'retired' ? isRetired(c) : true,
  );
  const counts = {};
  for (const c of all) counts[c.kind] = (counts[c.kind] || 0) + 1;
  const tagCount = new Map();
  for (const c of all) for (const t of c.tags) tagCount.set(t, (tagCount.get(t) || 0) + 1);
  const topTags = [...tagCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14);
  const st = S.snap?.state;
  const pro = S.snap?.proactive;

  el.rail.innerHTML = `
    <section>
      <h3>状态</h3>
      <div class="seg" id="status-seg">
        ${[
          ['active', '在用'],
          ['all', '全部'],
          ['retired', `已退休${st0?.retired ? `<span class="n">${st0.retired}</span>` : ''}`],
        ]
          .map(([v, label]) => `<button data-status="${v}" class="${S.status === v ? 'on' : ''}">${label}</button>`)
          .join('')}
      </div>
      <div class="hint">已退休的不参与检索，可随时恢复</div>
    </section>

    <section>
      <h3>类型</h3>
      <div class="chip-list">
        ${KINDS.map(
          (k) =>
            `<button class="chip ${S.kinds.has(k.id) ? 'on' : ''}" data-kind="${k.id}">
               <span class="dot" style="background:var(${k.css})"></span>${k.label}
               <span class="n">${counts[k.id] ?? 0}</span>
             </button>`,
        ).join('')}
      </div>
      <div class="hint">点一下只看这类，再点取消</div>
    </section>

    ${
      (st0?.scopes ?? []).length > 1
        ? `<section>
            <h3>记忆域</h3>
            <div class="chip-list">
              ${(st0?.scopes ?? [])
                .map(
                  (x) =>
                    `<button class="chip ${S.scope === x.scope ? 'on' : ''}" data-scope="${esc(x.scope)}">${esc(
                      x.scope === 'main' ? '自己写的' : x.scope === 'import' ? '旧插件导入' : x.scope,
                    )}<span class="n">${x.n}</span></button>`,
                )
                .join('')}
            </div>
            <div class="hint">${S.scope ? '只看这一域，点一下取消' : '按记忆来源分开看'}</div>
          </section>`
        : ''
    }

    <section>
      <h3>权重下限</h3>
      <div class="field">
        <input id="w-range" type="range" min="0" max="1" step="0.05" value="${S.minWeight}" />
        <div class="row" style="justify-content:space-between;font-size:11px;color:var(--ink-dim)">
          <span>全部</span><b id="w-value" style="color:var(--ink-soft)">≥ ${S.minWeight.toFixed(2)}</b><span>重要</span>
        </div>
      </div>
    </section>

    <section>
      <h3>时间</h3>
      <div class="seg" id="range-seg">
        ${[
          ['all', '全部'],
          ['7', '7 天'],
          ['30', '30 天'],
          ['90', '90 天'],
        ]
          .map(([v, label]) => `<button data-range="${v}" class="${S.range === v ? 'on' : ''}">${label}</button>`)
          .join('')}
      </div>
    </section>

    <section>
      <h3>标签 ${S.tag ? `<button class="chip-btn" id="tag-clear" style="float:right">清除</button>` : ''}</h3>
      <div class="chip-list">
        ${topTags.length
          ? topTags
              .map(([t, n]) => `<button class="chip ${S.tag === t ? 'on' : ''}" data-tag="${esc(t)}">${esc(t)}<span class="n">${n}</span></button>`)
              .join('')
          : '<span class="hint">还没有标签</span>'}
      </div>
    </section>

    <section>
      <h3>她此刻</h3>
      <div class="status-card">
        <div class="line"><span>精力</span><b>${Math.round(st?.energy ?? 0)}</b></div>
        <div class="meter"><i style="width:${clamp(st?.energy ?? 0, 0, 100)}%"></i></div>
        <div class="line"><span>心情</span><b>${Math.round(st?.mood ?? 0)}</b></div>
        <div class="meter"><i style="width:${clamp(st?.mood ?? 0, 0, 100)}%;background:var(--warn)"></i></div>
        <div class="line"><span>在做</span><b>${esc(st?.activity ?? '—')}</b></div>
        <div class="line"><span>在哪</span><b>${esc(st?.location || '—')}</b></div>
        <div class="line"><span>主动开口</span><b>${pro?.enabled ? `今天 ${pro.count}/${pro.cap || '∞'}` : '关'}</b></div>
        <div class="line"><span>下次</span><b>${pro?.dueAt ? fmtTime(pro.dueAt) : '未安排'}</b></div>
      </div>
    </section>
  `;

  const w = $('#w-range', el.rail);
  if (w) {
    w.addEventListener('input', () => {
      S.minWeight = Number(w.value);
      $('#w-value', el.rail).textContent = `≥ ${S.minWeight.toFixed(2)}`;
      renderStage();
      renderStatus();
    });
  }
}

el.rail.addEventListener('click', (event) => {
  const kindBtn = event.target.closest('[data-kind]');
  if (kindBtn) {
    const id = kindBtn.dataset.kind;
    if (S.kinds.has(id)) S.kinds.delete(id);
    else S.kinds.add(id);
    render();
    return;
  }
  const tagBtn = event.target.closest('[data-tag]');
  if (tagBtn) {
    const t = tagBtn.dataset.tag;
    S.tag = S.tag === t ? null : t;
    render();
    return;
  }
  if (event.target.id === 'tag-clear') {
    S.tag = null;
    render();
    return;
  }
  const rangeBtn = event.target.closest('[data-range]');
  if (rangeBtn) {
    S.range = rangeBtn.dataset.range;
    render();
    return;
  }
  const statusBtn = event.target.closest('[data-status]');
  if (statusBtn) {
    S.status = statusBtn.dataset.status;
    render();
    return;
  }
  const scopeBtn = event.target.closest('[data-scope]');
  if (scopeBtn) {
    S.scope = S.scope === scopeBtn.dataset.scope ? null : scopeBtn.dataset.scope;
    render();
  }
});

/* ── 图谱 ───────────────────────────────────────────── */

class Graph {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.nodes = [];
    this.links = [];
    this.view = { x: 0, y: 0, k: 1 };
    this.alpha = 1;
    this.hover = null;
    this.dragNode = null;
    this.panning = false;
    this.last = null;
    this.frame = 0;
    this.fitted = false;
    this.onSelect = null;
    this.bind();
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
    this.resize();
  }

  bind() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => {
      const p = this.toWorld(e);
      const hit = this.pick(p);
      c.setPointerCapture(e.pointerId);
      if (hit) {
        this.dragNode = hit;
        hit.vx = 0;
        hit.vy = 0;
        hit.dragging = true;
      } else {
        this.panning = true;
        this.last = { x: e.clientX, y: e.clientY };
      }
      c.classList.add('dragging');
    });
    c.addEventListener('pointermove', (e) => {
      const p = this.toWorld(e);
      if (this.dragNode) {
        this.dragNode.x = p.x;
        this.dragNode.y = p.y;
        this.alpha = Math.max(this.alpha, 0.35);
        this.kick();
        return;
      }
      if (this.panning && this.last) {
        this.view.x += e.clientX - this.last.x;
        this.view.y += e.clientY - this.last.y;
        this.last = { x: e.clientX, y: e.clientY };
        this.draw();
        return;
      }
      const hit = this.pick(p);
      const id = hit ? hit.id : null;
      if (id !== this.hover) {
        this.hover = id;
        this.draw();
        c.style.cursor = hit ? 'pointer' : 'grab';
      }
    });
    const end = () => {
      if (this.dragNode) {
        if (this.onSelect && !this.dragMoved) this.onSelect(this.dragNode.id);
        this.dragNode.dragging = false;
        this.dragNode = null;
      }
      this.panning = false;
      this.last = null;
      c.classList.remove('dragging');
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('click', (e) => {
      const hit = this.pick(this.toWorld(e));
      if (!hit && this.onSelect) this.onSelect(null);
    });
    c.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const before = this.toWorld(e);
        const k = clamp(this.view.k * (e.deltaY < 0 ? 1.12 : 0.89), 0.18, 5);
        this.view.k = k;
        const rect = c.getBoundingClientRect();
        this.view.x = e.clientX - rect.left - before.x * k;
        this.view.y = e.clientY - rect.top - before.y * k;
        this.draw();
      },
      { passive: false },
    );
    c.addEventListener('dblclick', () => this.fit());
  }

  resize() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, rect.width);
    const h = Math.max(1, rect.height);
    // 右栏收起/展开会改变舞台宽度：把画面中心钉住，别让节点跑到左边去
    if (this.w && this.h) {
      this.view.x += (w - this.w) / 2;
      this.view.y += (h - this.h) / 2;
    }
    this.w = w;
    this.h = h;
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }

  toWorld(e) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: (e.clientX - rect.left - this.view.x) / this.view.k, y: (e.clientY - rect.top - this.view.y) / this.view.k };
  }

  pick(p) {
    let best = null;
    let bestD = Infinity;
    for (const n of this.nodes) {
      const d = Math.hypot(n.x - p.x, n.y - p.y);
      if (d <= n.r + 6 / this.view.k && d < bestD) {
        best = n;
        bestD = d;
      }
    }
    return best;
  }

  setData(cards) {
    const wasEmpty = this.nodes.length === 0;
    const prev = new Map(this.nodes.map((n) => [n.id, n]));
    const nodes = cards.map((card, i) => {
      const old = prev.get(card.id);
      const angle = i * 2.399963;
      const radius = 40 + Math.sqrt(i) * 46;
      return {
        id: card.id,
        card,
        r: 5 + card.weight * 9,
        x: old ? old.x : Math.cos(angle) * radius,
        y: old ? old.y : Math.sin(angle) * radius,
        vx: 0,
        vy: 0,
      };
    });
    const index = new Map(nodes.map((n) => [n.id, n]));
    const links = [];
    const byTag = new Map();
    for (const n of nodes) {
      for (const t of n.card.tags) {
        if (!byTag.has(t)) byTag.set(t, []);
        byTag.get(t).push(n);
      }
    }
    for (const [tag, group] of byTag) {
      if (group.length < 2) continue;
      for (let i = 1; i < group.length && i <= 5; i += 1) {
        links.push({ a: group[0], b: group[i], w: 1, tag });
      }
    }
    // 版本链：新卡 supersedes 旧卡。这条边比标签共现更有信息量，所以优先级更高——
    // 两卡之间如果已经有标签边，就把它升级成版本链，不再画第二条重合的线。
    // 方向按时间流：旧 → 新，箭头指向新卡。
    const pairKey = (x, y) => (x.id < y.id ? `${x.id}|${y.id}` : `${y.id}|${x.id}`);
    const seen = new Map(links.map((l) => [pairKey(l.a, l.b), l]));
    for (const n of nodes) {
      for (const oldId of n.card.supersedes ?? []) {
        const target = index.get(oldId);
        if (!target) continue;
        const key = pairKey(target, n);
        const exist = seen.get(key);
        if (exist) {
          exist.kind = 'supersede';
          exist.w = 1.2;
          exist.a = target;
          exist.b = n;
        } else {
          const l = { a: target, b: n, w: 1.2, tag: null, kind: 'supersede' };
          links.push(l);
          seen.set(key, l);
        }
      }
    }
    // 没有标签连线的节点，按同一天挂到最近的一个节点上，避免孤岛
    const linked = new Set(links.flatMap((l) => [l.a.id, l.b.id]));
    for (const n of nodes) {
      if (linked.has(n.id)) continue;
      const same = nodes
        .filter((m) => m.id !== n.id && dayKey(m.card.createdAt) === dayKey(n.card.createdAt))
        .sort((a, b) => Math.hypot(a.x - n.x, a.y - n.y) - Math.hypot(b.x - n.x, b.y - n.y))[0];
      if (same) links.push({ a: n, b: same, w: 0.25, tag: null });
    }
    this.nodes = nodes;
    this.links = links.map((l) => ({ ...l, a: index.get(l.a.id), b: index.get(l.b.id) })).filter((l) => l.a && l.b);
    this.alpha = 1;
    this.kick();
    if (wasEmpty) {
      this.fit();
      this.fitted = true;
    }
  }

  kick() {
    if (this.frame) return;
    const loop = () => {
      this.frame = 0;
      const active = this.alpha > 0.02 || this.dragNode;
      if (active) {
        this.tick();
        this.draw();
        this.frame = requestAnimationFrame(loop);
      } else {
        this.draw();
      }
    };
    this.frame = requestAnimationFrame(loop);
  }

  tick() {
    const nodes = this.nodes;
    const links = this.links;
    if (nodes.length > 800) {
      this.alpha *= 0.9;
      return;
    }
    const REP = 5200;
    for (let i = 0; i < nodes.length; i += 1) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j += 1) {
        const b = nodes[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) {
          dx = (Math.random() - 0.5) * 2;
          dy = (Math.random() - 0.5) * 2;
          d2 = dx * dx + dy * dy;
        }
        const d = Math.sqrt(d2);
        const f = (REP * (0.6 + a.card.weight * 0.8)) / Math.max(900, d2);
        const fx = (dx / d) * f;
        const fy = (dy / d) * f;
        a.vx -= fx;
        a.vy -= fy;
        b.vx += fx;
        b.vy += fy;
      }
    }
    for (const l of links) {
      const dx = l.b.x - l.a.x;
      const dy = l.b.y - l.a.y;
      const d = Math.hypot(dx, dy) || 1;
      const target = 60 + 40 * (1 - l.w);
      const f = (d - target) * 0.012 * (0.6 + l.w);
      const fx = (dx / d) * f;
      const fy = (dy / d) * f;
      l.a.vx += fx;
      l.a.vy += fy;
      l.b.vx -= fx;
      l.b.vy -= fy;
    }
    const focusId = this.hover ?? null;
    for (const n of nodes) {
      n.vx -= n.x * 0.0016;
      n.vy -= n.y * 0.0016;
      if (n === this.dragNode) {
        n.vx = 0;
        n.vy = 0;
        continue;
      }
      n.vx *= 0.86;
      n.vy *= 0.86;
      n.x += n.vx;
      n.y += n.vy;
    }
    if (focusId) {
      const focus = nodes.find((n) => n.id === focusId);
      if (focus) {
        focus.vx *= 0.4;
        focus.vy *= 0.4;
      }
    }
    this.alpha *= 0.972;
  }

  fit() {
    if (!this.nodes.length) {
      this.view = { x: this.w / 2, y: this.h / 2, k: 1 };
      this.draw();
      return;
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const n of this.nodes) {
      minX = Math.min(minX, n.x - n.r);
      maxX = Math.max(maxX, n.x + n.r);
      minY = Math.min(minY, n.y - n.r);
      maxY = Math.max(maxY, n.y + n.r);
    }
    const padPx = 70;
    const k = clamp(Math.min((this.w - padPx * 2) / Math.max(1, maxX - minX), (this.h - padPx * 2) / Math.max(1, maxY - minY)), 0.2, 1.8);
    this.view.k = k;
    this.view.x = this.w / 2 - ((minX + maxX) / 2) * k;
    this.view.y = this.h / 2 - ((minY + maxY) / 2) * k;
    this.draw();
  }

  draw() {
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.clearRect(0, 0, this.w, this.h);
    if (!this.nodes.length) return;
    const { x, y, k } = this.view;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(k, k);

    const hoverNeighbors = new Set();
    if (this.hover) {
      for (const l of this.links) {
        if (l.a.id === this.hover) hoverNeighbors.add(l.b.id);
        if (l.b.id === this.hover) hoverNeighbors.add(l.a.id);
      }
    }
    // 版本链两端的节点一定要带标签，否则「被取代的是什么」看不出来
    const chainIds = new Set();
    for (const l of this.links) {
      if (l.kind !== 'supersede') continue;
      chainIds.add(l.a.id);
      chainIds.add(l.b.id);
    }

    const P = palette();
    const ink = P.ink;
    const line = P.line;
    for (const l of this.links) {
      const dim = this.hover && l.a.id !== this.hover && l.b.id !== this.hover;
      const sup = l.kind === 'supersede';
      ctx.strokeStyle = sup ? ink : line;
      // 星图模式把连线压到几乎看不见：留一点结构，不抢光点
      ctx.globalAlpha = this.stars
        ? dim ? 0.03 : sup ? 0.22 : 0.05
        : dim ? 0.07 : sup ? 0.45 : 0.16 + l.w * 0.22;
      ctx.lineWidth = (sup ? 1.5 : 0.8 + l.w * 1.1) / k;
      ctx.setLineDash(sup ? [4 / k, 3 / k] : []);
      ctx.beginPath();
      ctx.moveTo(l.a.x, l.a.y);
      ctx.lineTo(l.b.x, l.b.y);
      ctx.stroke();
      if (sup) {
        // 箭头指向新卡：这条线读作「旧的那条演进成了它」
        const ang = Math.atan2(l.b.y - l.a.y, l.b.x - l.a.x);
        const r = l.b.r + 3 / k;
        const tipX = l.b.x - Math.cos(ang) * r;
        const tipY = l.b.y - Math.sin(ang) * r;
        const size = 5 / k;
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(tipX, tipY);
        ctx.lineTo(tipX - Math.cos(ang - 0.42) * size, tipY - Math.sin(ang - 0.42) * size);
        ctx.lineTo(tipX - Math.cos(ang + 0.42) * size, tipY - Math.sin(ang + 0.42) * size);
        ctx.closePath();
        ctx.fillStyle = ink;
        ctx.fill();
      }
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    for (const n of this.nodes) {
      const c = P.kinds[n.card.kind] ?? ink;
      const isSel = n.card.id === S.selected;
      const isHover = n.card.id === this.hover;
      const dim = this.hover && !isHover && !hoverNeighbors.has(n.card.id) && !isSel;
      // 被版本链补进来的旧卡已经退休，压暗一档，别让人以为它还在用
      const retired = n.card.status === 'retired';
      const baseAlpha = dim ? 0.28 : retired ? 0.5 : 1;
      ctx.globalAlpha = baseAlpha;
      // 星图皮肤：三层递减的光晕代替实心圆，远看就是一片星云
      if (this.stars) {
        for (let ring = 3; ring >= 1; ring -= 1) {
          ctx.beginPath();
          ctx.arc(n.x, n.y, n.r * (1 + ring * 0.85), 0, Math.PI * 2);
          ctx.globalAlpha = baseAlpha * (0.1 / ring);
          ctx.fillStyle = c;
          ctx.fill();
        }
        ctx.globalAlpha = baseAlpha;
      }
      if (isSel || isHover) {
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r + 5 / k, 0, Math.PI * 2);
        ctx.fillStyle = c;
        ctx.globalAlpha = 0.16;
        ctx.fill();
        ctx.globalAlpha = baseAlpha;
      }
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      ctx.fillStyle = c;
      ctx.fill();
      if (isSel) {
        ctx.strokeStyle = ink;
        ctx.lineWidth = 1.6 / k;
        ctx.stroke();
      }
      const showLabel =
        isSel || isHover
        || (S.showLabels && (chainIds.has(n.card.id) || k > 1.32 || this.nodes.length <= 16));
      if (showLabel) {
        ctx.globalAlpha = dim ? 0.3 : retired ? 0.55 : 0.95;
        const size = Math.max(9.5, 11.5 / k);
        ctx.font = `${size}px -apple-system, "PingFang SC", sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        const label = n.card.text.slice(0, 14) + (n.card.text.length > 14 ? '…' : '');
        ctx.lineWidth = 3 / k;
        ctx.strokeStyle = P.paper;
        ctx.strokeText(label, n.x, n.y + n.r + 4 / k);
        ctx.fillStyle = ink;
        ctx.fillText(label, n.x, n.y + n.r + 4 / k);
      }
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }
}

/* ── 记忆星图（3D） ─────────────────────────────────── */

const GALAXY_KIND = { fact: '事实', self: '自己', episode: '经历', promise: '承诺', note: '临时' };
const GALAXY_COLOR = { fact: '#8ef0dc', self: '#9ab8ff', episode: '#ffc078', promise: '#ff9ec4', note: '#c3ccd8' };
const GALAXY_CAM = 1900;

/** 固定种子：同一批卡片每次布出来的星系一样。 */
function seeded(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const clampNum = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** 圆角矩形：不用 ctx.roundRect，老一点的宿主内核没有这个 API。 */
function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, h / 2, w / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}


class Galaxy {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.cards = [];
    this.nodes = [];
    this.links = [];
    this.regions = [];
    this.dust = [];
    this.far = [];
    this.glow = new Map();
    this.hover = null;
    this.selected = null;
    this.signature = null;
    this.onSelect = null;

    this.yaw = 0.55;
    this.pitch = 0.46;
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    const gx = new URLSearchParams(location.search).get('gx');
    if (gx) {
      const [a, b, c] = gx.split(',').map(Number);
      if (Number.isFinite(a)) this.yaw = a;
      if (Number.isFinite(b)) this.pitch = clampNum(b, -1.35, 1.35);
      if (Number.isFinite(c)) this.zoom = clampNum(c, 0.45, 3.2);
    }
    this.vy = 0;
    this.vp = 0;
    this.dragging = false;
    this.lastInteract = 0;
    this.frame = 0;
    this.running = false;
    this.tickCount = 0;

    this.w = 0;
    this.h = 0;
    this.dpr = 1;
    this.buildSprites();
    this.bind();
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
    this.resize();
  }

  bind() {
    const c = this.canvas;
    let last = null;
    let down = null;

    c.addEventListener('pointerdown', (e) => {
      this.dragging = true;
      this.vy = 0;
      this.vp = 0;
      last = { x: e.clientX, y: e.clientY };
      down = { x: e.clientX, y: e.clientY };
      this.lastInteract = performance.now();
      c.setPointerCapture(e.pointerId);
      c.classList.add('grabbing');
    });

    c.addEventListener('pointermove', (e) => {
      if (this.dragging && last) {
        const dx = e.clientX - last.x;
        const dy = e.clientY - last.y;
        last = { x: e.clientX, y: e.clientY };
        this.yaw += dx * 0.0062;
        this.pitch = clampNum(this.pitch + dy * 0.0062, -1.35, 1.35);
        this.vy = dx * 0.0062;
        this.vp = dy * 0.0062;
        this.lastInteract = performance.now();
        return;
      }
      const hit = this.pick(e.clientX, e.clientY);
      const id = hit ? hit.card.id : null;
      if (id === this.hover) return;
      this.hover = id;
      c.style.cursor = hit ? 'pointer' : 'grab';
    });

    const end = () => {
      this.dragging = false;
      last = null;
      this.lastInteract = performance.now();
      c.classList.remove('grabbing');
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('pointerleave', () => {
      this.hover = null;
    });

    c.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const box = c.getBoundingClientRect();
        const dx = e.clientX - box.left - this.CX;
        const dy = e.clientY - box.top - this.CY;
        const old = this.zoom;
        const next = clampNum(old * Math.exp(-e.deltaY * 0.0013), 0.45, 3.2);
        if (next === old) return;
        // 让光标指着的那颗星别跑：按比例反推平移量
        const ratio = next / old;
        this.panX = clampNum(dx - (dx - this.panX) * ratio, -this.w * 0.5, this.w * 0.5);
        this.panY = clampNum(dy - (dy - this.panY) * ratio, -this.h * 0.5, this.h * 0.5);
        this.zoom = next;
        this.lastInteract = performance.now();
      },
      { passive: false },
    );

    c.addEventListener('dblclick', () => {
      this.yaw = 0.55;
      this.pitch = 0.46;
      this.zoom = 1;
      this.panX = 0;
      this.panY = 0;
      this.vy = 0;
      this.vp = 0;
      this.lastInteract = performance.now();
    });

    c.addEventListener('click', (e) => {
      if (!down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      down = null;
      if (moved > 5) return;
      const hit = this.pick(e.clientX, e.clientY);
      if (this.onSelect) this.onSelect(hit ? hit.card.id : null);
    });
  }

  resize() {
    const box = this.canvas.parentElement.getBoundingClientRect();
    const w = Math.max(360, Math.round(box.width));
    const h = Math.max(320, Math.round(box.height));
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.w = w;
    this.h = h;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    // 空数据也要重排：不然空态会拿构造时那个 360×320 的小尺寸画
    this.buildScene();
  }

  start() {
    if (this.running) return;
    this.running = true;
    const loop = () => {
      if (!this.running) return;
      this.step();
      this.frame = requestAnimationFrame(loop);
    };
    this.frame = requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  setData(cards) {
    this.cards = cards.slice();
    this.buildScene();
  }

  /** 柔光贴图：节点 5 种类型各一张，旋臂薄雾再各一张。 */
  buildSprites() {
    this.glow.clear();
    this.hazeSprites = new Map();
    for (const tone of ['255,238,205', '150,225,255', '195,170,255']) {
      const size = 128;
      const cv = document.createElement('canvas');
      cv.width = size;
      cv.height = size;
      const g = cv.getContext('2d');
      const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
      grad.addColorStop(0, `rgba(${tone},1)`);
      grad.addColorStop(0.35, `rgba(${tone},0.45)`);
      grad.addColorStop(1, `rgba(${tone},0)`);
      g.fillStyle = grad;
      g.fillRect(0, 0, size, size);
      this.hazeSprites.set(tone, cv);
    }
    for (const [kind, color] of Object.entries(GALAXY_COLOR)) {
      const size = 128;
      const cv = document.createElement('canvas');
      cv.width = size;
      cv.height = size;
      const g = cv.getContext('2d');
      const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
      grad.addColorStop(0, color);
      grad.addColorStop(0.1, color);
      grad.addColorStop(0.45, `${color}55`);
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grad;
      g.fillRect(0, 0, size, size);
      this.glow.set(kind, cv);
    }
  }

  /** 场景：星系尘埃、远景星、记忆星、星座连线，全部在世界坐标里。 */
  buildScene() {
    const W = this.w;
    const H = this.h;
    this.CX = W * 0.5;
    this.CY = H * 0.52;
    this.RCORE = Math.min(W, H) * 0.1;
    this.RMAX = Math.min(W, H) * 0.4;
    const RMAX = this.RMAX;
    const RCORE = this.RCORE;
    const rnd = seeded(20261105);
    const gauss = () => (rnd() + rnd() + rnd() - 1.5) / 1.5;
    const GOLD = Math.PI * (3 - Math.sqrt(5));

    // 分区
    const tagCount = new Map();
    for (const c of this.cards) for (const t of c.tags ?? []) tagCount.set(t, (tagCount.get(t) ?? 0) + 1);
    const groups = new Map();
    for (const c of this.cards) {
      const strong = (c.tags ?? []).find((t) => (tagCount.get(t) ?? 0) >= 3);
      const key = strong || GALAXY_KIND[c.kind] || '其他';
      if (!groups.has(key)) groups.set(key, { name: key, cards: [] });
      groups.get(key).cards.push(c);
    }
    const regions = [...groups.values()].sort((a, b) => b.cards.length - a.cards.length);
    const RIN = RCORE * 2;

    regions.forEach((g, i) => {
      const f = (i + 0.5) / regions.length;
      const rc = RIN + (RMAX - RIN) * Math.pow(f, 0.92);
      const tc = -Math.PI * 0.5 + f * Math.PI * 2 * 1.55 + 0.55 * Math.log(rc / RCORE);
      g.x = Math.cos(tc) * rc;
      g.y = Math.sin(tc) * rc;
      g.br = 24 + Math.sqrt(g.cards.length) * 6.8;
    });

    // 团间排斥（在盘面上）
    for (let iter = 0; iter < 80; iter += 1) {
      for (let i = 0; i < regions.length; i += 1) {
        for (let j = i + 1; j < regions.length; j += 1) {
          const a = regions[i];
          const b = regions[j];
          let dx = b.x - a.x;
          let dy = b.y - a.y;
          const d = Math.hypot(dx, dy) || 1;
          const need = (a.br + b.br) * 1.16;
          if (d < need) {
            const push = (need - d) / 2;
            dx /= d;
            dy /= d;
            a.x -= dx * push;
            a.y -= dy * push;
            b.x += dx * push;
            b.y += dy * push;
          }
        }
      }
      for (const g of regions) {
        const d = Math.hypot(g.x, g.y) || 1;
        const lim = RMAX * 0.9;
        if (d > lim) {
          g.x = (g.x / d) * lim;
          g.y = (g.y / d) * lim;
        }
      }
    }

    // 记忆星
    const now = Date.now();
    this.nodes = [];
    for (const g of regions) {
      g.nodes = [];
      g.cards.forEach((card, k) => {
        const u = (k + 0.55) / g.cards.length;
        const rr = g.br * Math.sqrt(u) * (0.9 + rnd() * 0.2);
        const aa = k * GOLD + g.name.length * 1.3 + (rnd() - 0.5) * 0.45;
        const weight = Number(card.weight) || 0.5;
        const uses = (card.uses ?? 0) + (card.primedCount ?? 0);
        const last = Date.parse(card.lastUsedAt ?? card.createdAt ?? '') || now;
        const quiet = Math.max(0, (now - last) / 86_400_000);
        const sizeBoost = 0.72 + 0.4 * Math.min(1, g.cards.length / 14);
        const bright = (0.4 + 0.6 * Math.exp(-quiet / 45)) * (card.coldAt ? 0.42 : 1) * sizeBoost;
        const node = {
          card,
          x: g.x + Math.cos(aa) * rr,
          y: g.y + Math.sin(aa) * rr,
          z: gauss() * RMAX * 0.05,
          r: 1.6 + weight * 3.6 + Math.min(2.4, Math.sqrt(uses) * 0.7),
          bright,
          region: g,
        };
        g.nodes.push(node);
        this.nodes.push(node);
      });
      g.hub = g.nodes.reduce((b, n) => (Number(n.card.weight) > Number(b.card.weight) ? n : b), g.nodes[0]);
      g.color = GALAXY_COLOR[g.hub.card.kind] ?? '#c3ccd8';
      g.rz = gauss() * RMAX * 0.04;
    }

    // 星座连线：每个团连最近的两颗
    this.links = [];
    for (const g of regions) {
      for (let i = 0; i < g.nodes.length; i += 1) {
        const a = g.nodes[i];
        g.nodes
          .map((b, j) => ({ b, j, d: Math.hypot(b.x - a.x, b.y - a.y) }))
          .filter((o) => o.j !== i)
          .sort((x, y) => x.d - y.d)
          .slice(0, 2)
          .forEach(({ b, d }) => {
            if (d <= g.br * 2.5) this.links.push([a, b, g.color]);
          });
      }
    }

    // 超空间航道：不同星系之间、但共享标签的记忆连一条淡线
    this.lanes = [];
    const byTag = new Map();
    for (const c of this.cards) for (const t of c.tags ?? []) {
      if (!byTag.has(t)) byTag.set(t, []);
      byTag.get(t).push(c);
    }
    const byId = new Map(this.nodes.map((n) => [n.card.id, n]));
    for (const list of byTag.values()) {
      if (list.length < 2 || list.length > 6) continue;
      const head = byId.get(list[0].id);
      if (!head) continue;
      for (let i = 1; i < list.length; i += 1) {
        const other = byId.get(list[i].id);
        if (other && other.region !== head.region) this.lanes.push([head, other]);
      }
    }

    // 星系尘埃：散点按密度自然堆出旋臂，不画「虚线螺旋」
    this.dust = [];
    const arms = [
      { base: 0, tone: '150,225,255', n: 2200 },
      { base: Math.PI, tone: '195,170,255', n: 2200 },
      { base: Math.PI * 0.55, tone: '255,225,190', n: 800 },
    ];
    for (const arm of arms) {
      for (let i = 0; i < arm.n; i += 1) {
        const s = Math.pow(rnd(), 0.75);
        const r = RCORE * 0.55 + s * RMAX * 1.1;
        const t = arm.base + 2.15 * Math.PI * s + gauss() * (0.03 + 0.085 * s);
        const rr = r + gauss() * (10 + 42 * s);
        // 沿弧长做亮度起伏，看起来有「结」和「空洞」
        const knot = 0.5 + 0.5 * Math.sin(s * 19 + arm.base * 3);
        const faint = arm.n === 800 ? 0.55 : 1;
        this.dust.push({
          x: Math.cos(t) * rr,
          y: Math.sin(t) * rr,
          z: gauss() * RMAX * 0.05,
          size: 0.5 + Math.pow(rnd(), 2) * 1.7,
          alpha: (0.12 + rnd() * 0.24) * knot * (1 - s * 0.3) * faint,
          color: s < 0.22 ? '255,238,205' : arm.tone,
        });
      }
    }

    // 旋臂薄雾：几十个大而极淡的圆，把散点连成一片
    this.haze = [];
    for (const arm of arms) {
      const steps = arm.n === 800 ? 16 : 30;
      for (let i = 0; i < steps; i += 1) {
        const s0 = (i + 0.5) / steps;
        const r = RCORE * 0.55 + s0 * RMAX * 1.1;
        const t = arm.base + 2.15 * Math.PI * s0;
        this.haze.push({
          x: Math.cos(t) * r,
          y: Math.sin(t) * r,
          z: 0,
          radius: RMAX * (0.05 + 0.05 * s0),
          color: s0 < 0.22 ? '255,238,205' : arm.tone,
          alpha: 0.035 * (arm.n === 800 ? 0.6 : 1) * (1 - s0 * 0.25),
        });
      }
    }

    // 旋臂薄雾：几十个大而极淡的圆，把散点连成一片
    this.haze = [];
    for (const arm of arms) {
      const steps = arm.n === 800 ? 16 : 30;
      for (let i = 0; i < steps; i += 1) {
        const s0 = (i + 0.5) / steps;
        const r = RCORE * 0.55 + s0 * RMAX * 1.1;
        const t = arm.base + 2.15 * Math.PI * s0;
        this.haze.push({
          x: Math.cos(t) * r,
          y: Math.sin(t) * r,
          z: 0,
          radius: RMAX * (0.05 + 0.05 * s0),
          color: s0 < 0.22 ? '255,238,205' : arm.tone,
          alpha: 0.035 * (arm.n === 800 ? 0.6 : 1) * (1 - s0 * 0.25),
        });
      }
    }

    // 远景星
    this.far = [];
    for (let i = 0; i < 420; i += 1) {
      const a = rnd() * Math.PI * 2;
      const rr = RMAX * (1.15 + rnd() * 1.1);
      this.far.push({
        x: Math.cos(a) * rr,
        y: Math.sin(a) * rr,
        z: (rnd() - 0.5) * RMAX * 1.4,
        size: 0.4 + rnd() * 1.1,
        alpha: 0.2 + rnd() * 0.5,
      });
    }

    this.regions = regions;
    this.kindCounts = {};
    for (const c of this.cards) this.kindCounts[c.kind] = (this.kindCounts[c.kind] ?? 0) + 1;
    this.projected = new Map();
    this.step(true);
  }

  /** 世界坐标 → 屏幕。先绕 Y 转，再绕 X 抬，最后做一点透视。 */
  project(x, y, z) {
    const cy = Math.cos(this.yaw);
    const sy = Math.sin(this.yaw);
    const X = x * cy + z * sy;
    const Z1 = -x * sy + z * cy;
    const cp = Math.cos(this.pitch);
    const sp = Math.sin(this.pitch);
    const Y = y * cp - Z1 * sp;
    const Z = y * sp + Z1 * cp;
    const depth = Z + GALAXY_CAM;
    if (depth < 120) return null;
    const k = (GALAXY_CAM / depth) * this.zoom;
    return { x: this.CX + this.panX + X * k, y: this.CY + this.panY + Y * k, k, depth };
  }

  step(once = false) {
    const now = performance.now();
    if (!this.dragging) {
      // 惯性
      if (Math.abs(this.vy) > 0.00002 || Math.abs(this.vp) > 0.00002) {
        this.yaw += this.vy;
        this.pitch = clampNum(this.pitch + this.vp, -1.35, 1.35);
        this.vy *= 0.94;
        this.vp *= 0.94;
      } else if (now - this.lastInteract > 2600) {
        // 静置时慢慢自转，像在轨观测
        this.yaw += 0.0016;
      }
    }
    this.draw();
    this.tickCount += 1;
    if (this.tickCount % 6 === 0) this.updateTelemetry();
    if (!once) return;
  }

  draw() {
    const ctx = this.ctx;
    const W = this.w;
    const H = this.h;
    if (!ctx) return;
    ctx.clearRect(0, 0, W, H);

    // 深空底
    const bg = ctx.createRadialGradient(this.CX, this.CY, 0, this.CX, this.CY, Math.max(W, H) * 0.75);
    bg.addColorStop(0, '#0a0e1c');
    bg.addColorStop(0.55, '#05070f');
    bg.addColorStop(1, '#020308');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    // 没有记忆时也要有星空底：尘埃和远景星照画，只是没有星点和标签

    // 每个区一团淡淡的星云
    ctx.globalCompositeOperation = 'lighter';
    for (const g of this.regions) {
      const p = this.project(g.x, g.y, g.rz ?? 0);
      if (!p) continue;
      const radius = g.br * 1.9 * p.k;
      const grd = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, radius);
      const hex = g.color;
      grd.addColorStop(0, `${hex}16`);
      grd.addColorStop(0.5, `${hex}08`);
      grd.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = grd;
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';

    // 星系核心
    const core = this.project(0, 0, 0);
    if (core) {
      ctx.globalCompositeOperation = 'lighter';
      for (const [mul, alpha] of [
        [3.2, 0.1],
        [1.8, 0.22],
        [0.9, 0.5],
      ]) {
        const rr = this.RCORE * mul * core.k;
        const grd = ctx.createRadialGradient(core.x, core.y, 0, core.x, core.y, rr);
        grd.addColorStop(0, `rgba(255,246,220,${alpha})`);
        grd.addColorStop(0.45, `rgba(255,232,190,${alpha * 0.45})`);
        grd.addColorStop(1, 'rgba(255,220,170,0)');
        ctx.fillStyle = grd;
        ctx.beginPath();
        ctx.arc(core.x, core.y, rr, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = '#fffaf0';
      ctx.beginPath();
      ctx.arc(core.x, core.y, Math.max(2.5, this.RCORE * 0.12 * core.k), 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }

    // 旋臂薄雾：柔光贴图叠出来的连续感，不是一个个硬圆
    if (this.haze?.length) {
      ctx.globalCompositeOperation = 'lighter';
      for (const h of this.haze) {
        const p = this.project(h.x, h.y, h.z);
        if (!p) continue;
        const sprite = this.hazeSprites?.get(h.color);
        if (!sprite) continue;
        const r = h.radius * p.k * 2.2;
        ctx.globalAlpha = h.alpha * 2.4;
        ctx.drawImage(sprite, p.x - r, p.y - r, r * 2, r * 2);
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }

    // 旋臂薄雾：柔光贴图叠出来的连续感，不是一个个硬圆
    if (this.haze?.length) {
      ctx.globalCompositeOperation = 'lighter';
      for (const h of this.haze) {
        const p = this.project(h.x, h.y, h.z);
        if (!p) continue;
        const sprite = this.hazeSprites?.get(h.color);
        if (!sprite) continue;
        const r = h.radius * p.k * 2.2;
        ctx.globalAlpha = h.alpha * 2.4;
        ctx.drawImage(sprite, p.x - r, p.y - r, r * 2, r * 2);
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }

    // 收集并按深度排序（远的先画）
    const items = [];
    for (const d of this.dust) items.push({ z: d.z, kind: 'dust', d });
    for (const s of this.far) items.push({ z: s.z, kind: 'far', d: s });
    for (const n of this.nodes) items.push({ z: n.z, kind: 'node', d: n });
    items.sort((a, b) => b.z - a.z);

    ctx.globalCompositeOperation = 'lighter';
    let linkDrawn = false;
    for (const it of items) {
      const d = it.d;
      if (it.kind === 'dust') {
        const p = this.project(d.x, d.y, d.z);
        if (!p) continue;
        ctx.globalAlpha = d.alpha * Math.min(1.4, p.k);
        ctx.fillStyle = `rgba(${d.color},1)`;
        const sz = Math.max(0.5, d.size * p.k);
        ctx.fillRect(p.x - sz / 2, p.y - sz / 2, sz, sz);
        continue;
      }
      if (it.kind === 'far') {
        const p = this.project(d.x, d.y, d.z);
        if (!p) continue;
        ctx.globalAlpha = d.alpha * 0.7;
        ctx.fillStyle = '#d6e6ff';
        const sz = Math.max(0.4, d.size * p.k * 0.9);
        ctx.fillRect(p.x, p.y, sz, sz);
        continue;
      }
      // 连线先于节点画（同一层里节点压线）
      if (!linkDrawn) {
        linkDrawn = true;
        this.drawLinks();
      }
      const n = d;
      const p = this.project(n.x, n.y, n.z);
      if (!p) continue;
      this.projected.set(n.card.id, { x: p.x, y: p.y, k: p.k });
      const tone = GALAXY_COLOR[n.card.kind] ?? '#c3ccd8';
      const core = Math.max(0.7, (0.8 + n.r * 0.32) * p.k);
      // 光晕压到 3 倍核径以内、透明度很低：放大不会糊成一团
      const halo = core * 3;
      ctx.globalAlpha = 0.24 * n.bright;
      const sprite = this.glow.get(n.card.kind) ?? this.glow.get('note');
      ctx.drawImage(sprite, p.x - halo, p.y - halo, halo * 2, halo * 2);
      // 锐利的星核
      ctx.globalAlpha = Math.min(1, 0.72 + n.bright * 0.4);
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(p.x, p.y, core * 0.5, 0, Math.PI * 2);
      ctx.fill();
      // 十字星芒，只给够亮的
      if (core > 1.5) {
        const arm = core * (3.6 + n.bright * 3);
        ctx.globalAlpha = 0.2 * n.bright;
        ctx.strokeStyle = tone;
        ctx.lineWidth = 0.6;
        ctx.beginPath();
        ctx.moveTo(p.x - arm, p.y);
        ctx.lineTo(p.x + arm, p.y);
        ctx.moveTo(p.x, p.y - arm);
        ctx.lineTo(p.x, p.y + arm);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';

    // 选中 / 悬停
    const mark = (n, alpha) => {
      const p = this.projected.get(n.card.id);
      if (!p) return;
      ctx.strokeStyle = '#fff';
      ctx.globalAlpha = alpha;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(6, n.r * p.k) + 7, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    };
    const sel = this.nodes.find((n) => n.card.id === this.selected);
    if (sel) mark(sel, 0.7);
    const hov = this.nodes.find((n) => n.card.id === this.hover);
    if (hov && hov !== sel) mark(hov, 0.45);

    this.drawLabels();
    if (hov) this.drawTip(hov);
  }

  drawLinks() {
    const ctx = this.ctx;
    ctx.lineWidth = 0.6;
    for (const [a, b, color] of this.links) {
      const pa = this.project(a.x, a.y, a.z);
      const pb = this.project(b.x, b.y, b.z);
      if (!pa || !pb) continue;
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.18 * Math.min(1, (pa.k + pb.k) / 2);
      ctx.beginPath();
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  /** 标签贴着自己那团的外缘；两个撞上了就往下错开，别叠字。 */
  drawLabels() {
    const ctx = this.ctx;
    const placed = [];
    ctx.textBaseline = 'middle';
    ctx.font = '600 12px -apple-system, "PingFang SC", sans-serif';
    const detail = this.zoom >= 0.9;
    for (const g of this.regions) {
      if (!detail && g.cards.length < 2) continue;
      const p = this.project(g.x, g.y, g.rz ?? 0);
      if (!p) continue;
      const pts = g.nodes.map((n) => this.projected.get(n.card.id)).filter(Boolean);
      if (!pts.length) continue;

      const far = Math.max(...pts.map((q) => Math.hypot(q.x - p.x, q.y - p.y)));
      let dir = Math.atan2(p.y - this.CY, p.x - this.CX);
      // 团就在正中间时方向没有意义，直接往右上放
      if (far < 4 || Math.hypot(p.x - this.CX, p.y - this.CY) < 30) dir = -Math.PI / 3;
      const text = `${g.name} · ${g.cards.length}`;
      const w = ctx.measureText(text).width;

      let lx = p.x + Math.cos(dir) * (far + 20);
      let ly = p.y + Math.sin(dir) * (far + 18);
      lx = clampNum(lx, 20 + w / 2, this.w - 20 - w / 2);
      ly = clampNum(ly, 74, this.h - 46);

      const box = { x: lx - w / 2 - 5, y: ly - 10, w: w + 10, h: 20 };
      for (let pass = 0; pass < 16; pass += 1) {
        const hit = placed.find(
          (b) => box.x < b.x + b.w && box.x + box.w > b.x && box.y < b.y + b.h && box.y + box.h > b.y,
        );
        if (!hit) break;
        box.y += 18;
        if (box.y > this.h - 40) box.y = 66;
      }
      placed.push(box);
      ly = box.y + 10;

      ctx.fillStyle = 'rgba(4,7,14,0.6)';
      roundRect(ctx, box.x, box.y, box.w, box.h, 6);
      ctx.fill();
      ctx.textAlign = 'center';
      ctx.globalAlpha = 0.96;
      ctx.fillStyle = g.color;
      ctx.shadowColor = g.color;
      ctx.shadowBlur = 12;
      ctx.fillText(text, lx, ly);
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 1;
    }
  }

  drawTip(hov) {
    const ctx = this.ctx;
    const p = this.projected.get(hov.card.id);
    if (!p) return;
    const text = hov.card.text.length > 30 ? `${hov.card.text.slice(0, 30)}…` : hov.card.text;
    ctx.font = '12px -apple-system, "PingFang SC", sans-serif';
    const w = ctx.measureText(text).width;
    const bx = clampNum(p.x - w / 2 - 10, 12, this.w - w - 34);
    const by = clampNum(p.y - 46, 12, this.h - 44);
    roundRect(ctx, bx, by, w + 20, 26, 8);
    ctx.fillStyle = 'rgba(6,10,20,0.9)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(140,255,240,0.35)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = 'rgba(232,246,255,0.96)';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, bx + 10, by + 13);
  }

  updateTelemetry() {
    const box = $('#galaxy-telemetry');
    if (!box) return;
    const deg = ((this.yaw * 180) / Math.PI) % 360;
    box.textContent = `ROT ${((deg < 0 ? deg + 360 : deg) | 0).toString().padStart(3, '0')}° · PITCH ${((this.pitch * 180) / Math.PI).toFixed(0)}° · ZOOM ${this.zoom.toFixed(2)}×`;
  }

  pick(cx, cy) {
    const box = this.canvas.getBoundingClientRect();
    const x = cx - box.left;
    const y = cy - box.top;
    let best = null;
    let bestD = Infinity;
    for (const n of this.nodes) {
      const p = this.projected.get(n.card.id);
      if (!p) continue;
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < Math.max(11, n.r * p.k + 6) && d < bestD) {
        best = n;
        bestD = d;
      }
    }
    return best;
  }
}

let galaxy = null;

function renderGalaxy() {
  const canvas = $('#galaxy');
  if (!canvas) return;
  if (!galaxy) galaxy = new Galaxy(canvas);
  galaxy.onSelect = (id) => selectCard(id);
  galaxy.selected = S.selected;
  const list = filtered();
  $('#galaxy-empty').hidden = list.length > 0;
  const signature = list.map((c) => c.id).join(',');
  if (signature !== galaxy.signature) {
    galaxy.signature = signature;
    galaxy.setData(list);
  }
  galaxy.start();
  renderGalaxyLegend();
}

function renderGalaxyLegend() {
  const host = $('#galaxy-legend');
  if (!host || !galaxy) return;
  const counts = galaxy.kindCounts ?? {};
  host.innerHTML = Object.keys(GALAXY_KIND)
    .filter((k) => counts[k])
    .map(
      (k) =>
        `<span style="color:${GALAXY_COLOR[k]}"><i style="background:${GALAXY_COLOR[k]}"></i>${GALAXY_KIND[k]} ${counts[k]}</span>`,
    )
    .join('');
}

let graph = null;

function renderGraph() {
  const canvas = $('#graph');
  if (!graph) graph = new Graph(canvas);
  graph.onSelect = (id) => selectCard(id);
  graph.showLabels = S.showLabels;
  graph.stars = S.starfield;
  syncStarBtn();
  const base = filtered();
  // 版本链的另一头通常是已退休的旧卡，默认筛选看不到——补进图里，边才画得出来
  const list = withSuperseded(base);
  $('#graph-empty').hidden = base.length > 0;
  graph.draw();
  // 结构变化才重排；只改选中不重排
  const signature = list.map((c) => c.id).join(',');
  if (signature !== graph.signature) {
    graph.signature = signature;
    graph.setData(list);
  } else {
    graph.nodes = graph.nodes.filter((n) => list.some((c) => c.id === n.id));
    graph.kick();
  }
  renderLegend();
}

function renderLegend() {
  const box = $('#graph-legend');
  const counts = {};
  for (const c of filtered()) counts[c.kind] = (counts[c.kind] || 0) + 1;
  const hasChain = withSuperseded(filtered()).some((c) => (c.supersedes ?? []).length);
  box.innerHTML =
    '<span style="color:var(--ink-dim)">大小＝权重</span>' +
    KINDS.filter((k) => counts[k.id]).map((k) => `<span><i style="background:var(${k.css})"></i>${k.label} ${counts[k.id]}</span>`).join('') +
    (hasChain ? '<span style="color:var(--ink-dim)">虚线箭头＝被新版本接替</span>' : '');
}

/** 把被在用卡 supersedes 掉的旧卡补进图。它们默认已退休、不在筛选结果里，
 *  但版本链恰恰是这个视图最该看得见的关系。 */
function withSuperseded(list) {
  const ids = new Set(list.map((c) => c.id));
  const extra = [];
  for (const c of list) {
    for (const oldId of c.supersedes ?? []) {
      if (ids.has(oldId)) continue;
      const old = cards().find((x) => x.id === oldId);
      if (!old) continue;
      ids.add(oldId);
      extra.push(old);
    }
  }
  return extra.length ? [...list, ...extra] : list;
}

$('#graph-fit').addEventListener('click', () => graph?.fit());
$('#graph-relayout').addEventListener('click', () => {
  if (!graph) return;
  graph.fitted = false;
  graph.nodes.forEach((n, i) => {
    const angle = i * 2.399963;
    const radius = 40 + Math.sqrt(i) * 46;
    n.x = Math.cos(angle) * radius;
    n.y = Math.sin(angle) * radius;
    n.vx = 0;
    n.vy = 0;
  });
  graph.alpha = 1;
  graph.kick();
  setTimeout(() => graph?.fit(), 700);
});
$('#graph-labels').addEventListener('change', (e) => {
  S.showLabels = e.target.checked;
  if (graph) graph.showLabels = S.showLabels;
  graph?.draw();
});

/** 星图只是画法，不动数据和交互；偏好记在本地。 */
function syncStarBtn() {
  const btn = $('#graph-stars');
  if (!btn) return;
  btn.classList.toggle('on', S.starfield);
  btn.textContent = S.starfield ? '星图' : '图谱';
}
$('#graph-stars').addEventListener('click', () => {
  S.starfield = !S.starfield;
  localStorage.setItem('mcore-stars', S.starfield ? '1' : '0');
  if (graph) graph.stars = S.starfield;
  syncStarBtn();
  graph?.draw();
});

/* ── 时间线 ─────────────────────────────────────────── */

function renderTimeline() {
  const host = $('#view-timeline');
  const list = filtered().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (!list.length) {
    host.innerHTML = '<div class="empty"><p>这个条件下没有记忆。</p><p class="dim">放宽筛选，或者清空搜索。</p></div>';
    return;
  }
  const groups = new Map();
  for (const c of list) {
    const key = dayKey(c.createdAt);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  host.innerHTML = [...groups.entries()]
    .map(
      ([key, items]) => `
      <div class="day-group">
        <div class="day-head"><b>${dayLabel(key)}</b><span>${items.length} 条</span></div>
        ${items
          .map((c) => {
            const k = kindOf(c.kind);
            return `<div class="tl-item ${S.selected === c.id ? 'sel' : ''} ${isRetired(c) ? 'retired' : ''}" data-id="${c.id}">
              <span class="tl-dot" style="background:var(${k.css})"></span>
              <div class="tl-body">
                <div class="tl-text">${highlight(c.text, S.query)}</div>
                <div class="tl-meta">
                  <span>${k.label}</span>
                  ${c.dueAt ? `<span>· ${c.done ? '已完成' : '截止'} ${fmtTime(c.dueAt)}</span>` : ''}
                  ${c.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}
                </div>
              </div>
              <div class="tl-right" title="${fmtTime(c.createdAt)}">
                ${fmtTime(c.createdAt).slice(6)}
                <div class="wbar"><i style="width:${Math.round(c.weight * 100)}%"></i></div>
              </div>
            </div>`;
          })
          .join('')}
      </div>`,
    )
    .join('');
}

/* ── 列表 ───────────────────────────────────────────── */

const COLS = [
  { key: 'kind', label: '类型', width: '76px' },
  { key: 'text', label: '内容' },
  { key: 'weight', label: '权重', width: '92px' },
  { key: 'source', label: '来源', width: '132px' },
  { key: 'tags', label: '标签', width: '120px' },
  { key: 'createdAt', label: '记于', width: '82px' },
  { key: 'uses', label: '用过', width: '48px' },
];

/* 空列不占地方：全库没标签、没人被用过的时候，这两列先不出现 */
function activeCols() {
  const all = liveCards();
  const hasTags = all.some((c) => c.tags.length > 0);
  const hasUses = all.some((c) => (c.uses || 0) > 0);
  return COLS.filter((c) => (c.key === 'tags' ? hasTags : c.key === 'uses' ? hasUses : true));
}

function renderTable() {
  const host = $('#view-table');
  const cols = activeCols();
  const { key, dir } = S.sort;
  const list = filtered().sort((a, b) => {
    const va = key === 'tags' ? a.tags.join(',') : a[key] ?? '';
    const vb = key === 'tags' ? b.tags.join(',') : b[key] ?? '';
    if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
    return String(va).localeCompare(String(vb)) * dir;
  });
  host.innerHTML = `
    <table class="grid" style="min-width:${cols.reduce((n, c) => n + (parseInt(c.width, 10) || 0), 0) + 280}px">
      <thead><tr>
        ${cols
          .map(
            (c) =>
              `<th style="${c.width ? `width:${c.width}` : ''}" data-sort="${c.key}">${c.label}${
                key === c.key ? `<span class="arrow">${dir > 0 ? '↑' : '↓'}</span>` : ''
              }</th>`,
          )
          .join('')}
      </tr></thead>
      <tbody>
        ${
          list.length
            ? list
                .map((c) => {
                  const k = kindOf(c.kind);
                  return `<tr data-id="${c.id}" class="${S.selected === c.id ? 'sel' : ''} ${c.done ? 'done' : ''} ${
                    isRetired(c) ? 'retired' : ''
                  }">
                    <td class="nowrap"><span class="kind-pill"><i style="background:var(${k.css})"></i>${k.label}</span></td>
                    <td class="text">${highlight(c.text, S.query)}</td>
                    <td class="nowrap"><span class="wt" title="权重 ${c.weight.toFixed(2)}"><i class="wt-bar"><b style="width:${Math.round(
                      c.weight * 100,
                    )}%"></b></i><em>${c.weight.toFixed(2)}</em></span></td>
                    <td class="nowrap src" title="${esc(sourceLabel(c.source))}">${esc(sourceShort(c.source))}</td>
                    ${
                      cols.some((x) => x.key === 'tags')
                        ? `<td><div class="tag-list">${c.tags
                            .slice(0, 4)
                            .map((t) => `<span class="tag">${esc(t)}</span>`)
                            .join('')}</div></td>`
                        : ''
                    }
                    <td class="nowrap time" title="${fmtTime(c.createdAt)}">${relative(c.createdAt)}</td>
                    ${cols.some((x) => x.key === 'uses') ? `<td class="nowrap time">${c.uses || 0}</td>` : ''}
                  </tr>`;
                })
                .join('')
            : `<tr><td colspan="${cols.length}" style="padding:28px;text-align:center;color:var(--ink-dim)">没有符合条件的记忆</td></tr>`
        }
      </tbody>
    </table>`;
}

/* ── 对话原文 ───────────────────────────────────────── */

function archiveBar() {
  const retention = S.snap?.archive?.retention ?? 90;
  const hint = S.withArchive
    ? `连${retention ? ` ${retention} 天内` : '全部'}的归档一起搜`
    : '只搜最近 7 天；更早的句子在归档里，勾上就能搜到';
  return `<div class="turns-bar">
    <label class="switch"><input type="checkbox" id="turns-archive" ${S.withArchive ? 'checked' : ''} /><span>含归档</span></label>
    <span class="dim">${hint}</span>
  </div>`;
}

function turnRow(t) {
  return `<div class="turn">
    <div><time>${fmtTime(t.ts).slice(6)}</time><div class="who">${esc(shortSender(t.sender))}</div></div>
    <div class="msg">${highlight(t.text.slice(0, 600), S.query)}</div>
    <button class="turn-del" data-cursor="${t.cursor}" title="删掉这条原文" aria-label="删掉这条原文">×</button>
  </div>`;
}

function bindArchiveToggle() {
  const box = $('#turns-archive');
  if (!box) return;
  box.addEventListener('change', () => {
    S.withArchive = box.checked;
    localStorage.setItem('mcore-archive', S.withArchive ? '1' : '0');
    S.archive = null;
    S.archiveQ = '';
    renderTurns();
    if (S.withArchive && S.query) void ensureArchive(S.query);
  });
}

/** 归档不进快照，勾了「含归档」且有搜索词时才按需拉一次。 */
async function ensureArchive(query) {
  if (!S.withArchive || !query) return;
  if (S.archiveQ === query && S.archive) return;
  S.archiveQ = query;
  S.archive = null;
  const days = S.snap?.archive?.retention || 3650;
  try {
    const rows = await api(`/api/archive?q=${encodeURIComponent(query)}&days=${days}&limit=40`);
    if (S.query !== query) return;
    S.archive = Array.isArray(rows) ? rows : [];
  } catch (err) {
    if (S.query !== query) return;
    S.archive = [];
    toast(`翻归档失败：${err.message}`, true);
  }
  if (S.view === 'turns') renderTurns();
}

function renderTurns() {
  const host = $('#view-turns');
  const toks = tokens(S.query);
  const matched = (S.snap?.turns ?? []).filter((t) => matches(t.text, toks)).slice().reverse();
  const wantArchive = S.withArchive && Boolean(S.query);
  const archiving = wantArchive && (S.archiveQ !== S.query || S.archive === null);
  const archived = wantArchive && S.archiveQ === S.query ? (S.archive ?? []) : [];

  if (!matched.length && !archived.length && !archiving) {
    const dbg = S.snap?.state?.captureDebug;
    let hint = '在插件设置里确认「存对话原文」是开的，聊几句就会出现在这里。';
    if (dbg && dbg.scanned && !dbg.kept) {
      const keys = (dbg.keys ?? []).map((k) => esc(k)).join('、') || '无';
      hint = `上次扫了 ${dbg.scanned} 条外部事件，一条都没留下——被「算作对话的来源」白名单挡掉了（样例：${keys}），把这几个 key 加进设置里的正则就行。`;
    }
    const sub = S.query
      ? S.withArchive
        ? '归档里也没有。'
        : '最近 7 天里没有。更早的句子在归档里，勾上「含归档」再搜一次。'
      : hint;
    host.innerHTML = `<div class="turns-wrap">${archiveBar()}<div class="empty"><p>${
      S.query ? '没有匹配的对话。' : '还没有存下对话原文。'
    }</p><p class="dim">${sub}</p></div></div>`;
    bindArchiveToggle();
    return;
  }
  // 全量拼 DOM 在 1000 条时会明显卡：先渲染最近 200 条，要更多再点。
  // 分组按匹配总数算，组头显示「已显示/该天总数」，不让人误以为那天只有这么几句。
  const groups = new Map();
  for (const t of matched) {
    const key = dayKey(t.ts);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  const limit = Math.max(TURNS_PAGE, Math.min(S.turnsLimit ?? TURNS_PAGE, matched.length));
  let remain = limit;
  const parts = [];
  for (const [key, items] of groups) {
    if (remain <= 0) break;
    const take = items.slice(0, remain);
    remain -= take.length;
    parts.push(`
      <div class="day-group">
        <div class="day-head"><b>${dayLabel(key)}</b><span>${
          take.length === items.length ? `${items.length} 条` : `${take.length} / ${items.length} 条`
        }</span></div>
        ${take.map(turnRow).join('')}
      </div>`);
  }
  // 归档命中按天分组：行里只显示时分，日期靠组头，避免窄列里塞不下「09-28 08:22」
  const archGroups = new Map();
  for (const t of archived) {
    const key = dayKey(t.ts);
    if (!archGroups.has(key)) archGroups.set(key, []);
    archGroups.get(key).push(t);
  }
  const archiveBlock = archiving
    ? '<div class="day-group archive"><div class="day-head"><b>更早 · 归档</b><span>搜索中…</span></div></div>'
    : archGroups.size
      ? `<div class="archive-head">更早 · 归档<span>${archived.length} 条</span></div>${[...archGroups.entries()]
          .map(
            ([key, items]) => `<div class="day-group archive">
              <div class="day-head"><b>${dayLabel(key)}</b><span>${items.length} 条</span></div>
              ${items.map((t) => turnRow(t)).join('')}
            </div>`,
          )
          .join('')}`
      : wantArchive
        ? '<p class="turns-none dim">归档里没有匹配的句子。</p>'
        : '';
  const more =
    matched.length > limit
      ? `<button class="btn turns-more" id="turns-more">还有 ${matched.length - limit} 条 · 继续加载</button>`
      : '';
  host.innerHTML = `<div class="turns-wrap">${archiveBar()}${parts.join('')}${archiveBlock}${more}</div>`;
  bindArchiveToggle();
  $('#turns-more')?.addEventListener('click', () => {
    S.turnsLimit = limit + TURNS_PAGE;
    renderTurns();
  });
  if (archiving) void ensureArchive(S.query);
}

function shortSender(key) {
  const raw = String(key ?? '');
  const base = raw.split(/[.:]/)[0];
  const map = { starpost: '星邮', qq: 'QQ', private: 'QQ 私聊', 'desktop-pet': '桌宠' };
  return map[base] ?? (raw || '—').slice(0, 12);
}

/* ── 工作区文件 ─────────────────────────────────────── */

async function ensureDocs() {
  if (S.docs || S.docsLoading) return;
  S.docsLoading = true;
  try {
    const data = await api('/api/docs');
    S.docs = data;
  } catch (err) {
    S.docs = { roots: [], files: [] };
    toast(`读不到文件列表：${err.message}`, true);
  } finally {
    S.docsLoading = false;
    if (S.view === 'docs') renderDocs();
  }
}

function renderDocs() {
  const host = $('#view-docs');
  if (!S.snap?.docs?.enabled) {
    host.innerHTML = '<div class="docs-wrap"><div class="empty"><p>没有开启工作区检索。</p><p class="dim">在插件设置里打开「连工作区笔记一起搜」，设好目录。</p></div></div>';
    return;
  }
  if (!S.docs) {
    host.innerHTML = '<div class="docs-wrap"><div class="empty"><p>正在读目录…</p></div></div>';
    ensureDocs();
    return;
  }
  const toks = tokens(S.query);
  const files = S.docs.files.filter((f) => matches(f.rel, toks));
  host.innerHTML = `<div class="docs-wrap">
    <div class="hint" style="margin-bottom:10px;color:var(--ink-dim);font-size:11px">
      ${S.docs.roots.length} 个目录 · ${S.docs.files.length} 个文件（只读，点开看内容）
    </div>
    ${
      files.length
        ? files
            .map(
              (f) => `<div class="doc-item ${S.docSel === f.path ? 'sel' : ''}" data-path="${esc(f.path)}">
                <div><div class="name">${highlight(f.rel, S.query)}</div><div class="path">${fmtTime(new Date(f.mtimeMs).toISOString())} 改过</div></div>
                <div class="size">${f.chars} 字</div>
              </div>`,
            )
            .join('')
        : '<div class="empty" style="position:static;padding:30px"><p>没有匹配的文件。</p></div>'
    }
  </div>`;
}

async function openDoc(path) {
  S.docSel = path;
  S.docText = null;
  setInspCollapsed(false);
  renderDocs();
  renderInspector();
  try {
    const doc = await api(`/api/doc?path=${encodeURIComponent(path)}`);
    S.docText = doc;
    renderInspector();
  } catch (err) {
    toast(`打不开：${err.message}`, true);
  }
}

/* ── 详情栏 ─────────────────────────────────────────── */

function renderInspector() {
  if (S.view === 'docs' && S.docSel) return renderDocInspector();
  const card = selectedCard();
  if (!card) return renderOverview();
  const k = kindOf(card.kind);
  const related = relatedTo(card);
  el.inspBody.innerHTML = `
    <div class="insp-head">
      <span class="card-kind"><i style="background:var(${k.css})"></i>${k.label}</span>
      ${isRetired(card) ? '<span class="card-kind retired">已退休</span>' : ''}
      <div style="display:flex;gap:4px">
        ${isRetired(card) ? '' : `<button class="btn tiny ghost" id="btn-edit">${S.editing ? '取消' : '编辑'}</button>`}
        <button class="icon-btn tiny" id="btn-copy" title="复制内容">⧉</button>
        <button class="icon-btn tiny" id="btn-insp-collapse" title="收起右栏 (I)" aria-label="收起右栏">›</button>
      </div>
    </div>
    ${
      S.editing
        ? `<div class="editor">
            <textarea id="edit-text"></textarea>
            <div class="row">
              <div><div class="label">类型</div>
                <select id="edit-kind">${KINDS.map((x) => `<option value="${x.id}" ${x.id === card.kind ? 'selected' : ''}>${x.label}</option>`).join('')}</select>
              </div>
              <div><div class="label">权重 <b id="edit-weight-val">${card.weight.toFixed(2)}</b></div>
                <input id="edit-weight" type="range" min="0" max="1" step="0.05" value="${card.weight}" />
              </div>
            </div>
            <div><div class="label">标签（逗号分隔，最多 8 个）</div><input id="edit-tags" type="text" value="${esc(card.tags.join(', '))}" /></div>
            <div><div class="label">截止（承诺用，可留空）</div><input id="edit-due" type="datetime-local" value="${card.dueAt ? toLocalInput(card.dueAt) : ''}" /></div>
            <div class="row">
              <button class="btn primary" id="btn-save">保存</button>
              ${card.kind === 'promise' ? `<button class="btn" id="btn-done">${card.done ? '标为未完成' : '标为完成'}</button>` : ''}
            </div>
          </div>`
        : `<div class="card-text">${highlight(card.text, S.query)}</div>`
    }
    <div class="card-meta">
      <div class="kv"><span>记于</span><b>${fmtTime(card.createdAt)} · ${relative(card.createdAt)}</b></div>
      <div class="kv"><span>权重</span><b>${card.weight.toFixed(2)}</b></div>
      <div class="kv"><span>来源</span><b>${esc(sourceLabel(card.source))}</b></div>
      <div class="kv"><span>被想起</span><b>${card.uses || 0} 次${card.lastUsedAt ? ` · 最近 ${relative(card.lastUsedAt)}` : ''}</b></div>
      ${card.dueAt ? `<div class="kv"><span>${card.done ? '已完成' : '截止'}</span><b>${fmtTime(card.dueAt)}</b></div>` : ''}
      <div class="kv"><span>编号</span><b style="font-family:var(--mono);font-size:11px">${card.id.slice(0, 8)}</b></div>
    </div>
    <div class="card-actions">
      <button class="btn tiny" id="btn-ask">相关记忆</button>
      ${
        isRetired(card)
          ? `<button class="btn tiny" id="btn-restore">恢复这条</button>`
          : `<button class="btn tiny" id="btn-retire">退休</button>`
      }
    </div>
    ${lineageHtml(card)}
    ${
      related.length
        ? `<div class="related"><h3>相关的 ${related.length} 条</h3>${related
            .map(
              (r) => `<button class="related-item" data-goto="${r.card.id}">${esc(r.card.text.slice(0, 46))}${
                r.card.text.length > 46 ? '…' : ''
              }<span class="why">${esc(r.why)}</span></button>`,
            )
            .join('')}</div>`
        : ''
    }
  `;

  if (S.editing) {
    $('#edit-text').value = card.text;
    $('#edit-weight').addEventListener('input', (e) => {
      $('#edit-weight-val').textContent = Number(e.target.value).toFixed(2);
    });
    $('#btn-save').addEventListener('click', () => saveCard(card));
    const doneBtn = $('#btn-done');
    if (doneBtn) doneBtn.addEventListener('click', () => patchCard(card.id, { done: !card.done }, card.done ? '已标为未完成' : '已标为完成'));
  }
  $('#btn-edit')?.addEventListener('click', () => {
    S.editing = !S.editing;
    renderInspector();
  });
  $('#btn-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(card.text);
      toast('已复制');
    } catch {
      toast('复制失败，浏览器不给剪贴板权限', true);
    }
  });
  // 彻底删除只在维护面板 → 回收站里给：详情栏紧挨「退休」，误触一次就没了
  const retireBtn = $('#btn-retire');
  if (retireBtn) {
    retireBtn.addEventListener('click', async () => {
      try {
        await api(`/api/cards/${card.id}/retire`, { method: 'POST', body: '{}' });
        toast('已退休：不再参与检索，可在「已退休」里恢复');
        await load();
        renderInspector();
      } catch (err) {
        toast(`操作失败：${err.message}`, true);
      }
    });
  }
  const restoreBtn = $('#btn-restore');
  if (restoreBtn) {
    restoreBtn.addEventListener('click', async () => {
      try {
        await api(`/api/cards/${card.id}/restore`, { method: 'POST', body: '{}' });
        toast('已恢复');
        await load();
        renderInspector();
      } catch (err) {
        toast(`操作失败：${err.message}`, true);
      }
    });
  }
  $('#btn-ask').addEventListener('click', () => {
    S.query = card.tags[0] ?? card.text.slice(0, 4);
    el.search.value = S.query;
    render();
  });
  el.inspector.querySelectorAll('[data-goto]').forEach((btn) => {
    btn.addEventListener('click', () => selectCard(btn.dataset.goto));
  });
  bindInspCollapse();
}

function renderDocInspector() {
  const doc = S.docText;
  el.inspBody.innerHTML = `
    <div class="insp-head">
      <span class="card-kind">文件</span>
      <div style="display:flex;gap:4px">
        <button class="icon-btn tiny" id="btn-insp-collapse" title="收起右栏 (I)" aria-label="收起右栏">›</button>
        <button class="icon-btn tiny" id="doc-close" title="关闭">×</button>
      </div>
    </div>
    ${doc ? `<div class="card-text" style="max-height:60vh;overflow:auto;font-size:12.5px">${esc(doc.text)}</div>
      <div class="card-meta"><div class="kv"><span>路径</span><b style="font-size:10.5px;word-break:break-all">${esc(doc.rel)}</b></div></div>`
      : '<div class="card-text" style="color:var(--ink-dim)">正在读…</div>'}
  `;
  bindInspCollapse();
  $('#doc-close').addEventListener('click', () => {
    S.docSel = null;
    S.docText = null;
    setInspCollapsed(true);
    render();
  });
}

function renderOverview() {
  const st = S.snap?.stats;
  const list = filtered();
  const kindRows = KINDS.map((k) => ({ ...k, n: st?.byKind?.[k.id] ?? 0 }));
  const maxKind = Math.max(1, ...kindRows.map((k) => k.n));
  const recent = [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 7);
  const plans = S.snap?.plans ?? [];
  el.inspBody.innerHTML = `
    <div class="insp-head">
      <h3 style="margin:0">概览</h3>
      <button class="icon-btn tiny" id="btn-insp-collapse" title="收起右栏 (I)" aria-label="收起右栏">›</button>
    </div>
    <div class="dist">
      ${kindRows
        .map(
          (k) => `<div class="row"><span>${k.label}</span>
            <span class="track"><i style="width:${(k.n / maxKind) * 100}%;background:var(${k.css})"></i></span>
            <b>${k.n}</b></div>`,
        )
        .join('')}
    </div>
    <div style="margin-top:16px"><h3>最近记下</h3>
      <div class="recent-list">
        ${recent.length ? recent.map((c) => `<button data-goto="${c.id}">${esc(c.text.slice(0, 34))}</button>`).join('') : '<span class="hint">还没有</span>'}
      </div>
    </div>
    <div style="margin-top:16px"><h3>今天的安排</h3>
      <div class="recent-list">
        ${plans.length
          ? plans.map((p) => `<div class="line" style="display:flex;justify-content:space-between;font-size:12px;padding:3px 8px;color:${p.done ? 'var(--ink-dim)' : 'var(--ink-soft)'}"><span>${esc(p.time)} ${esc(p.title)}</span>${p.done ? '<span>✓</span>' : ''}</div>`).join('')
          : '<span class="hint">空</span>'}
      </div>
    </div>
    <div style="margin-top:16px">
      <h3>她的状态</h3>
      <div class="status-card">
        <div class="line"><span>精力</span><b>${Math.round(S.snap?.state?.energy ?? 0)}</b></div>
        <input id="ov-energy" type="range" min="0" max="100" value="${Math.round(S.snap?.state?.energy ?? 0)}" />
        <div class="line"><span>心情</span><b>${Math.round(S.snap?.state?.mood ?? 0)}</b></div>
        <input id="ov-mood" type="range" min="0" max="100" value="${Math.round(S.snap?.state?.mood ?? 0)}" />
        <div class="line"><span>在做</span><b>${esc(S.snap?.state?.activity ?? '')}</b></div>
        <input id="ov-activity" type="text" value="${esc(S.snap?.state?.activity ?? '')}" style="background:var(--sheet-2);border:1px solid var(--line);border-radius:6px;padding:4px 7px" />
        <button class="btn tiny" id="ov-save" style="margin-top:4px">保存状态</button>
      </div>
    </div>
    <div class="hint" style="margin-top:16px">点节点或列表里的任意一条看详情。选中后用 <kbd>E</kbd> 直接改。</div>
  `;
  el.inspector.querySelectorAll('[data-goto]').forEach((btn) => {
    btn.addEventListener('click', () => selectCard(btn.dataset.goto));
  });
  bindInspCollapse();
  $('#ov-save').addEventListener('click', async () => {
    try {
      await api('/api/state', {
        method: 'POST',
        body: JSON.stringify({
          energy: Number($('#ov-energy').value),
          mood: Number($('#ov-mood').value),
          activity: $('#ov-activity').value,
        }),
      });
      toast('状态已更新');
      await load();
    } catch (err) {
      toast(`保存失败：${err.message}`, true);
    }
  });
}

function sourceLabel(src) {
  return { tool: '聊天时写下', map: '记忆地图里手填', import: '旧插件导入', script: '系统' }[src] ?? src ?? '—';
}

/* 表格里只放得下短名，完整语义留给 title */
function sourceShort(src) {
  if (!src) return '—';
  if (src.startsWith('import:')) return `导入·${src.slice(7).replace(/^(private-|memory-)/, '')}`;
  return { tool: '聊天', map: '手填', script: '系统' }[src] ?? src;
}

function toLocalInput(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function relatedTo(card) {
  const toks = new Set(
    card.text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 1),
  );
  const scored = [];
  for (const other of cards()) {
    if (other.id === card.id || isRetired(other)) continue;
    const shared = other.tags.filter((t) => card.tags.includes(t));
    let score = shared.length * 2;
    const otherToks = new Set(other.text.toLowerCase().split(''));
    let overlap = 0;
    for (const ch of new Set(card.text)) if (otherToks.has(ch)) overlap += 1;
    score += (overlap / Math.max(1, new Set(card.text).size)) * 1.2;
    if (score < 1.1) continue;
    scored.push({
      card: other,
      score,
      why: shared.length ? `同标签 ${shared.join(' ')}` : '内容相近',
    });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, 4);
}

function lineageHtml(card) {
  const before = (card.supersedes ?? [])
    .map((id) => cards().find((c) => c.id === id))
    .filter(Boolean)
    .slice(-3);
  const after = cards().find((c) => (c.supersedes ?? []).includes(card.id));
  if (!before.length && !after) {
    if (!isRetired(card)) return '';
    const why = { merge: '被合并', manual: '手动退休', stale: '标为作废' }[card.retiredBy] ?? '被新版本接替';
    return `<div class="lineage"><h3>状态</h3><p class="lineage-note">已退休 · ${why}${card.retiredAt ? ` · ${relative(card.retiredAt)}` : ''}</p></div>`;
  }
  const item = (c, prefix) =>
    `<button class="related-item" data-goto="${c.id}">${prefix}${esc(c.text.slice(0, 40))}${c.text.length > 40 ? '…' : ''}<span class="why">${fmtTime(c.createdAt)}</span></button>`;
  return `<div class="lineage"><h3>版本链</h3>
    ${after ? item(after, '被这条接替：') : ''}
    ${before.map((c) => item(c, '它接替了：')).join('')}
  </div>`;
}

async function saveCard(card) {
  const text = $('#edit-text').value.trim();
  if (!text) return toast('内容不能为空', true);
  const patch = {
    text,
    kind: $('#edit-kind').value,
    weight: Number($('#edit-weight').value),
    tags: $('#edit-tags')
      .value.split(/[,，\s]+/)
      .map((t) => t.trim())
      .filter(Boolean),
    dueAt: $('#edit-due').value ? $('#edit-due').value : '',
  };
  try {
    const saved = await api(`/api/cards/${card.id}`, { method: 'PATCH', body: JSON.stringify(patch) });
    S.editing = false;
    // 改内容会生成新版本（旧版退休），选中落到新版上
    if (saved?.id && saved.id !== card.id) S.selected = saved.id;
    toast(saved?.id && saved.id !== card.id ? '已保存为新版本，旧版进了退休区' : '已保存');
    await load();
  } catch (err) {
    toast(`保存失败：${err.message}`, true);
  }
}

async function patchCard(id, patch, msg) {
  try {
    await api(`/api/cards/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
    toast(msg);
    await load();
  } catch (err) {
    toast(`失败：${err.message}`, true);
  }
}

/* ── 体检 ───────────────────────────────────────────── */

async function ensureHealth() {
  if (S.health) return;
  try {
    S.health = await api('/api/health');
    if (S.view === 'health') renderHealth();
  } catch (err) {
    toast(`体检读不出来：${err.message}`, true);
  }
}

function healthCard(label, value, hint, tone = '') {
  return `<div class="h-card ${tone}">
    <div class="h-label">${esc(label)}</div>
    <div class="h-value">${value}</div>
    <div class="h-hint">${esc(hint)}</div>
  </div>`;
}

function renderHealth() {
  const host = $('#view-health');
  const h = S.health;
  if (!h) {
    host.innerHTML = '<div class="empty"><p>正在算…</p></div>';
    return;
  }
  const maxN = Math.max(1, ...h.perDay.map((d) => d.n));
  const bars = h.perDay
    .map(
      (d) => `<div class="h-bar" title="${d.day} · ${d.n} 条">
        <i style="height:${Math.max(2, Math.round((d.n / maxN) * 100))}%"></i>
        <b>${d.n}</b>
        <span>${d.day.slice(5).replace('-', '/')}</span>
      </div>`,
    )
    .join('');
  const wk = h.recent?.byKind ?? {};
  const week = {
    fact: wk.fact ?? 0,
    self: wk.self ?? 0,
    episode: wk.episode ?? 0,
    promise: wk.promise ?? 0,
  };
  const dead = h.deadIds.map((id) => cards().find((c) => c.id === id)).filter(Boolean);
  const deadRows = dead
    .slice(0, 20)
    .map(
      (c) => `<div class="maint-row" data-id="${c.id}">
        <div class="maint-main">
          <span class="kind-pill"><i style="background:var(${kindOf(c.kind).css})"></i>${kindOf(c.kind).label}</span>
          <span class="maint-text" title="${esc(c.text)}">${esc(c.text.slice(0, 80))}${c.text.length > 80 ? '…' : ''}</span>
          <span class="maint-meta">${relative(c.createdAt)} · ${c.weight.toFixed(2)}</span>
        </div>
      </div>`,
    )
    .join('');
  host.innerHTML = `<div class="health-wrap">
    <div class="h-grid">
      ${healthCard('在用记忆', h.cards.active, `另有 ${h.cards.retired} 条已退休`)}
      ${healthCard('从没被想起', h.cards.dead, '建了 7 天以上，一次都没被碰到过', h.cards.dead > h.cards.active * 0.5 ? 'warn' : '')}
      ${healthCard('召回次数', h.recall.calls, `${h.recall.cardsTouched} 张卡被用过 · 主动想起 ${h.recall.primed ?? 0} 次`)}
      ${healthCard('对话原文', h.raw.lines, `归档 ${h.raw.archivedLines} 行 · ${h.raw.archivedDays} 天`)}
    </div>

    <section class="h-block">
      <h3>近 14 天新增</h3>
      <div class="h-chart">${bars}</div>
    </section>

    <section class="h-block">
      <h3>近 7 天新增了什么</h3>
      <div class="h-line">
        <span class="${(week.fact + week.self) === 0 ? 'warn' : ''}">事实 <b>${week.fact}</b></span>
        <span>自己 / 关系 <b>${week.self}</b></span>
        <span>经历 <b>${week.episode}</b></span>
        <span class="${week.promise ? '' : 'dim'}">承诺 <b>${week.promise}</b></span>
        <span class="dim">${
          week.fact + week.self === 0
            ? '这周没记下任何「她是谁」——聊天时可以直接说「记一下」'
            : '事实和自我比经历更该沉淀；全是经历说明在记流水账'
        }</span>
      </div>
    </section>

    <section class="h-block">
      <h3>承诺</h3>
      <div class="h-line">
        <span>未完成 <b>${h.promises.open}</b></span>
        <span class="${h.promises.overdue ? 'warn' : ''}">已过时间 <b>${h.promises.overdue}</b></span>
        <span class="${h.promises.noDue ? 'warn' : ''}">没有截止时间 <b>${h.promises.noDue}</b></span>
        <span class="dim">${h.promises.repeating ? `每 ${h.promises.repeating} 天重提一次` : '只提醒一次'}</span>
        ${h.promises.noDue ? '<button class="btn tiny" id="h-fix-promises">去补时间</button>' : ''}
      </div>
    </section>

    <section class="h-block">
      <h3>备份</h3>
      <div class="h-line">
        <span>${h.backup.count ? `本地有 <b>${h.backup.count}</b> 份，最新 <b>${esc(h.backup.latest ?? '')}</b>` : '还没有备份，下次写入时会自动生成'}</span>
        <span class="dim">${esc(h.backup.dir)}</span>
      </div>
    </section>

    <section class="h-block">
      <h3>冷层
        ${h.chill.eligible ? `<button class="btn tiny" id="h-chill">沉下去（${h.chill.eligible}）</button>` : ''}
        ${h.chill.cold ? `<button class="btn tiny" id="h-warm">全部回暖（${h.chill.cold}）</button>` : ''}
      </h3>
      <div class="h-line">
        <span>冷层里 <b>${h.chill.cold}</b> 条</span>
        <span class="dim">${
          h.chill.afterDays
            ? `超过 ${h.chill.afterDays} 天没被想起的低权重记忆会沉下去；搜索仍然找得到，不删除`
            : '自动分层已关闭（chillAfterDays = 0）'
        }</span>
      </div>
    </section>

    <section class="h-block">
      <h3>从没被想起的卡 ${h.cards.dead ? `<button class="btn tiny" id="h-retire-dead">全部退休（${h.cards.dead}）</button>` : ''}</h3>
      ${
        dead.length
          ? `<div class="maint-list">${deadRows}</div>${dead.length > 20 ? `<p class="dim">还有 ${dead.length - 20} 条没列出来。</p>` : ''}`
          : '<p class="maint-empty">没有。每张卡都被搜到过。</p>'
      }
    </section>
  </div>`;

  const fix = $('#h-fix-promises');
  if (fix) fix.addEventListener('click', () => void openMaintenance('promises'));
  const chillBtn = $('#h-chill');
  if (chillBtn) {
    chillBtn.addEventListener('click', async () => {
      if (!confirm(`把 ${h.chill.eligible} 张很久没被想起的低权重记忆沉到冷层？不删除，随时能回暖。`)) return;
      try {
        const res = await api('/api/chill', { method: 'POST', body: '{}' });
        S.health = null;
        await load();
        toast(`${res?.changed ?? 0} 张已沉到冷层`);
      } catch (err) {
        toast(`失败：${err.message}`, true);
      }
    });
  }
  const warmBtn = $('#h-warm');
  if (warmBtn) {
    warmBtn.addEventListener('click', async () => {
      if (!confirm(`把冷层里的 ${h.chill.cold} 张全部捞回来？`)) return;
      try {
        const res = await api('/api/warm', { method: 'POST', body: '{}' });
        S.health = null;
        await load();
        toast(`${res?.changed ?? 0} 张已回暖`);
      } catch (err) {
        toast(`失败：${err.message}`, true);
      }
    });
  }
  const retireDead = $('#h-retire-dead');
  if (retireDead) {
    retireDead.addEventListener('click', async () => {
      const ids = h.deadIds.slice();
      if (!ids.length) return;
      if (!confirm(`把 ${ids.length} 张从没被想起的卡标成退休？不删除，随时能在回收站恢复。`)) return;
      try {
        for (const id of ids) await api(`/api/cards/${id}/retire`, { method: 'POST', body: '{}' });
        S.health = null;
        await load();
        toast(`${ids.length} 张已退休`);
      } catch (err) {
        toast(`失败：${err.message}`, true);
      }
    });
  }
}

/* ── 视图切换与渲染 ─────────────────────────────────── */

function renderStage() {
  localStorage.setItem('mcore-view2', S.view);
  if (S.view !== 'galaxy') galaxy?.stop();
  for (const v of VIEWS) {
    const el = $(`#view-${v}`);
    if (el) el.hidden = S.view !== v;
  }
  document.querySelectorAll('#tabs .tab').forEach((t) => t.classList.toggle('active', t.dataset.view === S.view));

  if (S.view === 'graph') renderGraph();
  if (S.view === 'timeline') renderTimeline();
  if (S.view === 'table') renderTable();
  if (S.view === 'turns') renderTurns();
  if (S.view === 'galaxy') renderGalaxy();
  if (S.view === 'docs') {
    renderDocs();
    ensureDocs();
  }
  if (S.view === 'health') {
    renderHealth();
    void ensureHealth();
  }
}

function renderStatus() {
  const total = cards().length;
  const shown = filtered().length;
  el.statusCount.textContent = `显示 ${shown} / ${total} 条`;
  const site = S.snap?.site?.origin;
  el.statusSite.textContent = site ? `服务 ${site}` : '';
  el.brandSub.textContent = `${total} 条记忆 · ${S.snap?.stats?.openPromises ?? 0} 个承诺在等`;
  applyInspState();
}

function render() {
  renderMetrics();
  renderRail();
  renderStage();
  renderInspector();
  renderStatus();
}

/* ── 选择与键盘 ─────────────────────────────────────── */

function visibleIds() {
  const list = filtered();
  if (S.view === 'timeline') return list.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((c) => c.id);
  if (S.view === 'table') return list.map((c) => c.id);
  return list.map((c) => c.id);
}

function move(delta) {
  const ids = visibleIds();
  if (!ids.length) return;
  const at = ids.indexOf(S.selected);
  const next = at < 0 ? 0 : clamp(at + delta, 0, ids.length - 1);
  selectCard(ids[next], { scroll: true });
}

document.addEventListener('keydown', (event) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? '');
  if (event.key === 'Escape') {
    if (!el.modal.hidden) return closeModal();
    if (typing) {
      document.activeElement.blur();
      return;
    }
    if (S.query) {
      S.query = '';
      el.search.value = '';
      render();
      return;
    }
    S.selected = null;
    S.editing = false;
    setInspCollapsed(true);
    render();
    return;
  }
  if (typing) return;
  if (event.key === '/' || (event.key === 'k' && (event.metaKey || event.ctrlKey))) {
    event.preventDefault();
    el.search.focus();
    el.search.select();
    return;
  }
  if (event.key === '?') return showShortcuts();
  if (event.key === 'j' || event.key === 'ArrowDown') {
    event.preventDefault();
    return move(1);
  }
  if (event.key === 'k' || event.key === 'ArrowUp') {
    event.preventDefault();
    return move(-1);
  }
  if (event.key === 'Enter' && S.selected) {
    S.editing = true;
    renderInspector();
    $('#edit-text')?.focus();
    return;
  }
  if (event.key === 'e' && S.selected) {
    S.editing = true;
    renderInspector();
    $('#edit-text')?.focus();
    return;
  }
  if (event.key === 'n') {
    event.preventDefault();
    return openCompose();
  }
  if (event.key === 'r') return load();
  if (event.key === 'i') {
    setInspCollapsed(!S.inspCollapsed);
    if (!S.inspCollapsed) renderInspector();
    return;
  }
  if (VIEWS.map((_, i) => String(i + 1)).includes(event.key)) {
    const views = VIEWS;
    S.view = views[Number(event.key) - 1];
    return render();
  }
});

// 逐字 render 会把原文 1000+ 条、表格几十行整体重建，打字快了肉眼可见地卡。
// 输入框状态立刻更新（清除按钮要跟手），重绘压到 150ms 后。
let searchTimer = 0;
el.search.addEventListener('input', () => {
  S.query = el.search.value;
  el.searchClear.hidden = !S.query;
  S.turnsLimit = TURNS_PAGE;
  S.archive = null;
  S.archiveQ = '';
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => render(), 150);
});
el.searchClear.addEventListener('click', () => {
  S.query = '';
  el.search.value = '';
  el.searchClear.hidden = true;
  S.turnsLimit = TURNS_PAGE;
  S.archive = null;
  S.archiveQ = '';
  clearTimeout(searchTimer);
  render();
});

document.querySelectorAll('#tabs .tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    S.view = tab.dataset.view;
    render();
  });
});

$('#view-timeline').addEventListener('click', (event) => {
  const item = event.target.closest('[data-id]');
  if (!item) return;
  selectCard(item.dataset.id);
});

// 原文单条删除：按钮随行渲染，用事件委托，重绘后不用重新绑定
$('#view-turns').addEventListener('click', async (event) => {
  const btn = event.target.closest('.turn-del');
  if (!btn) return;
  const cursor = Number(btn.dataset.cursor);
  if (!Number.isFinite(cursor)) return;
  if (!confirm('删掉这条原文？只删本地这一行，对方那边不受影响。删了补不回来。')) return;
  try {
    const res = await api(`/api/turns/${cursor}`, { method: 'DELETE', body: '{}' });
    if (!res?.removed) return toast('没找到这条', true);
    S.archiveQ = '';
    S.archive = null;
    await load();
    toast('已删掉');
  } catch (err) {
    toast(`删除失败：${err.message}`, true);
  }
});

$('#view-table').addEventListener('click', (event) => {
  const th = event.target.closest('th[data-sort]');
  if (th) {
    const key = th.dataset.sort;
    S.sort = { key, dir: S.sort.key === key ? -S.sort.dir : key === 'createdAt' || key === 'weight' || key === 'uses' ? -1 : 1 };
    return renderStage();
  }
  const tr = event.target.closest('tr[data-id]');
  if (!tr) return;
  selectCard(tr.dataset.id);
});

$('#view-docs').addEventListener('click', (event) => {
  const item = event.target.closest('[data-path]');
  if (item) openDoc(item.dataset.path);
});

/* ── 新建弹层 ───────────────────────────────────────── */

/* ── 维护与回收站 ───────────────────────────────────── */

async function openMaintenance(tab = 'dupes') {
  try {
    S.maintenance = await api('/api/maintenance');
  } catch (err) {
    return toast(`读不出来：${err.message}`, true);
  }
  renderMaintenance(tab);
}

function maintRow(card, actions, extraClass = '') {
  const k = kindOf(card.kind);
  return `<div class="maint-row ${extraClass}" data-id="${card.id}">
    <div class="maint-main">
      <span class="kind-pill"><i style="background:var(${k.css})"></i>${k.label}</span>
      <span class="maint-text" title="${esc(card.text)}">${esc(card.text.slice(0, 90))}${card.text.length > 90 ? '…' : ''}</span>
      <span class="maint-meta">${relative(card.createdAt)} · ${card.weight.toFixed(2)}</span>
    </div>
    <div class="maint-act">${actions}</div>
  </div>`;
}

function renderMaintenance(tab) {
  const m = S.maintenance;
  const byId = (id) => cards().find((c) => c.id === id);
  const rows = (ids) => ids.map(byId).filter(Boolean);
  const prom = m.promises ?? { noDue: [], overdue: [] };
  const tabs = [
    ['dupes', '重复', m.dupes.length],
    ['stale', '疑似作废', m.stale.length],
    ['junk', '垃圾', m.junk.length],
    ['promises', '承诺', prom.noDue.length + prom.overdue.length],
    ['retired', '回收站', m.retired.length],
  ];
  let content = '';
  let bulk = '';
  if (tab === 'dupes') {
    const groups = m.dupes
      .map((g) => ({ ...g, cards: rows(g.ids) }))
      .filter((g) => g.cards.length > 1);
    content = groups.length
      ? groups
          .map(
            (g) => `<div class="maint-group">
              <div class="maint-group-head">相似度 ${Math.round(g.score * 100)}% · ${g.cards.length} 条</div>
              ${g.cards
                .map((c) => maintRow(c, `<button class="btn tiny" data-keep="${c.id}" data-drop="${g.cards
                  .filter((x) => x.id !== c.id)
                  .map((x) => x.id)
                  .join(',')}">保留这条</button>`))
                .join('')}
            </div>`,
          )
          .join('')
      : '<p class="maint-empty">没有重复。同类型里没有两条内容相近到值得合并的。</p>';
  } else if (tab === 'stale') {
    const list = rows(m.stale);
    content = list.length
      ? list.map((c) => maintRow(c, `<button class="btn tiny" data-retire="${c.id}">退休</button>`)).join('')
      : '<p class="maint-empty">没有疑似作废的记忆。文案里带「取消了 / 改到 / 作废」，或者 90 天没被召回、权重又低的，会出现在这里。</p>';
    if (list.length) bulk = `<button class="btn tiny" data-bulk="stale">全部退休（${list.length}）</button>`;
  } else if (tab === 'junk') {
    const list = rows(m.junk);
    content = list.length
      ? list.map((c) => maintRow(c, `<button class="btn tiny" data-retire="${c.id}">退休</button><button class="btn tiny danger" data-purge="${c.id}">删除</button>`)).join('')
      : '<p class="maint-empty">没有垃圾。太短、纯表情、`[取消]` 这类回执会出现在这里。</p>';
    if (list.length) bulk = `<button class="btn tiny danger" data-bulk="junk">全部删除（${list.length}）</button>`;
  } else if (tab === 'promises') {
    const noDue = rows(prom.noDue);
    const overdue = rows(prom.overdue);
    const blocks = [];
    if (noDue.length) {
      blocks.push(`<div class="maint-group">
        <div class="maint-group-head">没写截止时间 · 提醒管线管不到（${noDue.length}）</div>
        ${noDue
          .map((c) =>
            maintRow(
              c,
              `<input class="due-input" type="datetime-local" data-due="${c.id}" aria-label="截止时间" />
               <button class="btn tiny" data-save-due="${c.id}">补上</button>`,
              'wide',
            ),
          )
          .join('')}
      </div>`);
    }
    if (overdue.length) {
      blocks.push(`<div class="maint-group">
        <div class="maint-group-head">已过时间 · 还没做（${overdue.length}）</div>
        ${overdue
          .map((c) =>
            maintRow(c, `<button class="btn tiny" data-done="${c.id}">标记做完</button><button class="btn tiny" data-retire="${c.id}">退休</button>`, 'wide'),
          )
          .join('')}
      </div>`);
    }
    content = blocks.length
      ? blocks.join('')
      : '<p class="maint-empty">没有要补的承诺。写承诺时必须带截止时间，到点会提一次。</p>';
  } else {
    const list = rows(m.retired);
    content = list.length
      ? list.map((c) => maintRow(c, `<button class="btn tiny" data-restore="${c.id}">恢复</button><button class="btn tiny danger" data-purge="${c.id}">彻底删除</button>`)).join('')
      : '<p class="maint-empty">回收站是空的。</p>';
  }

  openModal(
    '维护',
    `<div class="maint-tabs">${tabs
      .map(([k, label, n]) => `<button data-tab="${k}" class="${tab === k ? 'on' : ''}">${label}${n ? `<span>${n}</span>` : ''}</button>`)
      .join('')}</div>
     <p class="maint-note">退休＝不参与检索、列表里默认看不到，随时能恢复；彻底删除不可撤销。</p>
     <div class="maint-body">${content}</div>`,
    `${bulk}<button class="btn" id="maint-close">关闭</button>`,
  );

  $('#modal-body')
    .querySelectorAll('[data-tab]')
    .forEach((btn) => btn.addEventListener('click', () => renderMaintenance(btn.dataset.tab)));
  $('#maint-close').addEventListener('click', closeModal);

  const refresh = async (msg) => {
    toast(msg);
    await load();
    S.maintenance = await api('/api/maintenance');
    renderMaintenance(tab);
  };
  $('#modal-body')
    .querySelectorAll('[data-keep]')
    .forEach((btn) =>
      btn.addEventListener('click', async () => {
        const drop = btn.dataset.drop.split(',').filter(Boolean);
        try {
          const res = await api('/api/merge', { method: 'POST', body: JSON.stringify({ keep: btn.dataset.keep, drop }) });
          await refresh(`合并了 ${res.merged ?? 0} 条`);
        } catch (err) {
          toast(`合并失败：${err.message}`, true);
        }
      }),
    );
  $('#modal-body')
    .querySelectorAll('[data-retire]')
    .forEach((btn) =>
      btn.addEventListener('click', async () => {
        try {
          await api(`/api/cards/${btn.dataset.retire}/retire`, { method: 'POST', body: '{}' });
          await refresh('已退休');
        } catch (err) {
          toast(`失败：${err.message}`, true);
        }
      }),
    );
  $('#modal-body')
    .querySelectorAll('[data-restore]')
    .forEach((btn) =>
      btn.addEventListener('click', async () => {
        try {
          await api(`/api/cards/${btn.dataset.restore}/restore`, { method: 'POST', body: '{}' });
          await refresh('已恢复');
        } catch (err) {
          toast(`失败：${err.message}`, true);
        }
      }),
    );
  $('#modal-body')
    .querySelectorAll('[data-purge]')
    .forEach((btn) =>
      btn.addEventListener('click', async () => {
        try {
          const n = await purgeWithUndo([btn.dataset.purge]);
          if (!n) return;
          await load();
          S.maintenance = await api('/api/maintenance');
          renderMaintenance(tab);
        } catch (err) {
          toast(`失败：${err.message}`, true);
        }
      }),
    );
  $('#modal-body')
    .querySelectorAll('[data-save-due]')
    .forEach((btn) =>
      btn.addEventListener('click', async () => {
        const input = btn.parentElement?.querySelector('[data-due]');
        const value = input?.value;
        if (!value) return toast('先选一个时间', true);
        try {
          await api(`/api/cards/${btn.dataset.saveDue}`, { method: 'PATCH', body: JSON.stringify({ dueAt: value }) });
          await refresh('补上了截止时间');
        } catch (err) {
          toast(`失败：${err.message}`, true);
        }
      }),
    );
  $('#modal-body')
    .querySelectorAll('[data-done]')
    .forEach((btn) =>
      btn.addEventListener('click', async () => {
        try {
          await api(`/api/cards/${btn.dataset.done}`, { method: 'PATCH', body: JSON.stringify({ done: true }) });
          await refresh('标记完成');
        } catch (err) {
          toast(`失败：${err.message}`, true);
        }
      }),
    );
  const bulkBtn = $('#modal-foot [data-bulk]');
  if (bulkBtn) {
    bulkBtn.addEventListener('click', async () => {
      const ids = bulkBtn.dataset.bulk === 'stale' ? S.maintenance.stale : S.maintenance.junk;
      if (!ids.length) return;
      if (!confirm(`处理这 ${ids.length} 条？`)) return;
      try {
        if (bulkBtn.dataset.bulk === 'stale') {
          for (const id of ids) await api(`/api/cards/${id}/retire`, { method: 'POST', body: '{}' });
          await refresh(`${ids.length} 条已退休`);
        } else {
          const n = await purgeWithUndo(ids);
          if (!n) return;
          await load();
          S.maintenance = await api('/api/maintenance');
          renderMaintenance(tab);
        }
      } catch (err) {
        toast(`失败：${err.message}`, true);
      }
    });
  }
}

function openModal(title, bodyHtml, footHtml) {
  el.modalTitle.textContent = title;
  el.modalBody.innerHTML = bodyHtml;
  el.modalFoot.innerHTML = footHtml;
  el.modal.hidden = false;
}

function closeModal() {
  el.modal.hidden = true;
}

$('#modal-close').addEventListener('click', closeModal);
el.modal.addEventListener('click', (e) => {
  if (e.target === el.modal) closeModal();
});

function openCompose() {
  openModal(
    '新建记忆',
    `<div class="editor">
      <textarea id="new-text" placeholder="一条只写一件事，40-80 字，写清楚谁、什么时候、怎么了"></textarea>
      <div class="row">
        <div><div class="label">类型</div>
          <select id="new-kind">${KINDS.map((k) => `<option value="${k.id}" ${k.id === 'episode' ? 'selected' : ''}>${k.label}</option>`).join('')}</select>
        </div>
        <div><div class="label">权重</div>
          <input id="new-weight" type="range" min="0" max="1" step="0.05" value="0.5" />
        </div>
      </div>
      <div><div class="label">标签（逗号分隔）</div><input id="new-tags" type="text" placeholder="例如：工作, 生日" /></div>
    </div>`,
    `<button class="btn ghost" id="new-cancel">取消</button><button class="btn primary" id="new-save">记下来</button>`,
  );
  $('#new-text').focus();
  const submit = async () => {
    const text = $('#new-text').value.trim();
    if (!text) return toast('写点什么', true);
    try {
      const card = await api('/api/cards', {
        method: 'POST',
        body: JSON.stringify({
          kind: $('#new-kind').value,
          text,
          weight: Number($('#new-weight').value),
          tags: $('#new-tags')
            .value.split(/[,，\s]+/)
            .map((t) => t.trim())
            .filter(Boolean),
        }),
      });
      closeModal();
      S.selected = card.id;
      setInspCollapsed(false);
      toast('已记下');
      await load();
    } catch (err) {
      toast(`失败：${err.message}`, true);
    }
  };
  $('#new-save').addEventListener('click', submit);
  $('#new-cancel').addEventListener('click', closeModal);
  $('#new-text').addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submit();
  });
}

$('#btn-new').addEventListener('click', openCompose);

function showShortcuts() {
  const rows = [
    ['/ · ⌘K', '聚焦搜索'],
    ['1 – 5', '图谱 / 时间线 / 列表 / 原文 / 文件'],
    ['J · K', '下一条 / 上一条'],
    ['Enter · E', '打开编辑器'],
    ['N', '新建记忆'],
    ['R', '重新读取'],
    ['I', '收起 / 展开右栏'],
    ['Esc', '清空搜索 / 取消选择'],
  ];
  openModal(
    '快捷键',
    `<div class="shortcuts">${rows.map(([k, v]) => `<kbd>${k}</kbd><span>${v}</span>`).join('')}</div>`,
    `<button class="btn" id="sc-close">知道了</button>`,
  );
  $('#sc-close').addEventListener('click', closeModal);
}

/* ── 更多菜单 ───────────────────────────────────────── */

$('#btn-more').addEventListener('click', (event) => {
  const rect = event.currentTarget.getBoundingClientRect();
  el.menu.innerHTML = `
    <button id="m-maint">维护与回收站 <span style="color:var(--ink-dim)">⌥</span></button>
    <hr />
    <button id="m-md">导出 Markdown</button>
    <button id="m-json">导出 JSON</button>
    <hr />
    <button id="m-keys">快捷键 <span style="color:var(--ink-dim)">?</span></button>
    <button id="m-refresh">重新读取 <span style="color:var(--ink-dim)">R</span></button>
  `;
  el.menu.hidden = false;
  el.menu.style.left = `${Math.min(rect.left, window.innerWidth - 210)}px`;
  el.menu.style.top = `${rect.bottom + 6}px`;
  $('#m-maint').addEventListener('click', () => {
    el.menu.hidden = true;
    void openMaintenance();
  });
  $('#m-md').addEventListener('click', () => {
    location.href = '/api/export?fmt=md';
    el.menu.hidden = true;
  });
  $('#m-json').addEventListener('click', () => {
    location.href = '/api/export?fmt=json';
    el.menu.hidden = true;
  });
  $('#m-keys').addEventListener('click', () => {
    el.menu.hidden = true;
    showShortcuts();
  });
  $('#m-refresh').addEventListener('click', () => {
    el.menu.hidden = true;
    load();
  });
});
document.addEventListener('click', (e) => {
  if (!el.menu.hidden && !el.menu.contains(e.target) && e.target.id !== 'btn-more') el.menu.hidden = true;
});

/* ── 启动 ───────────────────────────────────────────── */

applyTheme();
el.inspStub.addEventListener('click', () => {
  setInspCollapsed(false);
  renderInspector();
});
const bootParams = new URLSearchParams(location.search);
const bootView = bootParams.get('view') ?? localStorage.getItem('mcore-view2') ?? 'galaxy';
if (VIEWS.includes(bootView)) S.view = bootView;
const bootQuery = bootParams.get('q');
if (bootQuery) {
  S.query = bootQuery;
  el.search.value = bootQuery;
  el.searchClear.hidden = false;
}
if (bootParams.get('archive') === '1') {
  S.withArchive = true;
  localStorage.setItem('mcore-archive', '1');
}
if (bootParams.get('stars') === '1') {
  S.starfield = true;
  localStorage.setItem('mcore-stars', '1');
}
await load();
const bootCard = bootParams.get('card');
if (bootCard && cards().some((c) => c.id === bootCard)) {
  S.selected = bootCard;
  setInspCollapsed(false);
  render();
}
setInterval(() => {
  if (!document.hidden) load({ quiet: true });
}, 20_000);
