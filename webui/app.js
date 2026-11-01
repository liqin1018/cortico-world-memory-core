/* 记忆地图前端：无框架、无依赖，数据全部来自本机 /api/*。 */

const $ = (sel, root = document) => root.querySelector(sel);

const KINDS = [
  { id: 'fact', label: '事实', css: '--k-fact' },
  { id: 'self', label: '她自己', css: '--k-self' },
  { id: 'episode', label: '经历', css: '--k-episode' },
  { id: 'promise', label: '承诺', css: '--k-promise' },
  { id: 'note', label: '临时', css: '--k-note' },
];

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
  inspCollapsed: (localStorage.getItem('mcore-insp') ?? 'off') === 'off',
  status: 'active', // active | all | retired
  scope: null,
  maintenance: null,
};

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

async function api(path, init = {}) {
  const res = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
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
  const handoff = readThemeHandoff();
  const root = document.documentElement;
  if (handoff) {
    root.dataset.mode = handoff.appearance === 'light' ? 'light' : 'dark';
    for (const [key, value] of Object.entries(handoff.palette)) {
      if (/^#[0-9a-f]{3,8}$/i.test(String(value))) root.style.setProperty(`--${key}`, value);
    }
    return;
  }
  const saved = localStorage.getItem('mcore-mode') ?? 'auto';
  root.dataset.mode = saved;
}

$('#btn-theme').addEventListener('click', () => {
  const order = ['auto', 'light', 'dark'];
  const current = localStorage.getItem('mcore-mode') ?? 'auto';
  const next = order[(order.indexOf(current) + 1) % order.length];
  if (next === 'auto') localStorage.removeItem('mcore-mode');
  else localStorage.setItem('mcore-mode', next);
  document.documentElement.removeAttribute('style');
  applyTheme();
  render();
  toast(next === 'auto' ? '跟随系统' : next === 'light' ? '浅色' : '深色');
});

/* ── 数据与筛选 ─────────────────────────────────────── */

async function load({ quiet = false } = {}) {
  try {
    const snap = await api('/api/snapshot');
    S.snap = snap;
    if (!quiet) render();
    else render();
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
    { label: '对话原文', value: (S.snap.turns ?? []).length, unit: '行' },
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

    const line = palette().line;
    for (const l of this.links) {
      const dim = this.hover && l.a.id !== this.hover && l.b.id !== this.hover;
      ctx.strokeStyle = line;
      ctx.globalAlpha = dim ? 0.07 : 0.16 + l.w * 0.22;
      ctx.lineWidth = (0.8 + l.w * 1.1) / k;
      ctx.beginPath();
      ctx.moveTo(l.a.x, l.a.y);
      ctx.lineTo(l.b.x, l.b.y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    const P = palette();
    const ink = P.ink;
    for (const n of this.nodes) {
      const c = P.kinds[n.card.kind] ?? ink;
      const isSel = n.card.id === S.selected;
      const isHover = n.card.id === this.hover;
      const dim = this.hover && !isHover && !hoverNeighbors.has(n.card.id) && !isSel;
      ctx.globalAlpha = dim ? 0.28 : 1;
      if (isSel || isHover) {
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r + 5 / k, 0, Math.PI * 2);
        ctx.fillStyle = c;
        ctx.globalAlpha = 0.16;
        ctx.fill();
        ctx.globalAlpha = dim ? 0.28 : 1;
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
        isSel || isHover || (S.showLabels && (k > 1.32 || this.nodes.length <= 16));
      if (showLabel) {
        ctx.globalAlpha = dim ? 0.3 : 0.95;
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

let graph = null;

function renderGraph() {
  const canvas = $('#graph');
  if (!graph) graph = new Graph(canvas);
  graph.onSelect = (id) => selectCard(id);
  graph.showLabels = S.showLabels;
  const list = filtered();
  $('#graph-empty').hidden = list.length > 0;
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
  box.innerHTML =
    '<span style="color:var(--ink-dim)">大小＝权重</span>' +
    KINDS.filter((k) => counts[k.id]).map((k) => `<span><i style="background:var(${k.css})"></i>${k.label} ${counts[k.id]}</span>`).join('');
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

function renderTurns() {
  const host = $('#view-turns');
  const toks = tokens(S.query);
  const turns = (S.snap?.turns ?? []).filter((t) => matches(t.text, toks)).slice().reverse();
  if (!turns.length) {
    host.innerHTML = `<div class="turns-wrap"><div class="empty"><p>${S.query ? '没有匹配的对话。' : '还没有存下对话原文。'}</p><p class="dim">${
      S.query ? '' : '在插件设置里确认「存对话原文」是开的，聊几句就会出现在这里。'
    }</p></div></div>`;
    return;
  }
  const groups = new Map();
  for (const t of turns) {
    const key = dayKey(t.ts);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  host.innerHTML = `<div class="turns-wrap">${[...groups.entries()]
    .map(
      ([key, items]) => `
      <div class="day-group">
        <div class="day-head"><b>${dayLabel(key)}</b><span>${items.length} 条</span></div>
        ${items
          .map(
            (t) => `<div class="turn">
              <div><time>${fmtTime(t.ts).slice(6)}</time><div class="who">${esc(shortSender(t.sender))}</div></div>
              <div class="msg">${highlight(t.text.slice(0, 600), S.query)}</div>
            </div>`,
          )
          .join('')}
      </div>`,
    )
    .join('')}</div>`;
}

function shortSender(key) {
  const map = { starpost: '星邮', qq: 'QQ', 'desktop-pet': '桌宠' };
  const base = String(key ?? '').split('.')[0];
  return map[base] ?? String(key ?? '—').slice(0, 12);
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
      <button class="btn tiny danger" id="btn-delete">彻底删除</button>
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
  $('#btn-delete').addEventListener('click', async () => {
    if (!confirm(`彻底删掉这条？删了就找不回来了。\n\n${card.text}`)) return;
    try {
      await api('/api/purge', { method: 'POST', body: JSON.stringify({ ids: [card.id] }) });
      S.selected = null;
      setInspCollapsed(true);
      toast('已彻底删除');
      await load();
    } catch (err) {
      toast(`删除失败：${err.message}`, true);
    }
  });
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

/* ── 视图切换与渲染 ─────────────────────────────────── */

function renderStage() {
  localStorage.setItem('mcore-view', S.view);
  $('#view-graph').hidden = S.view !== 'graph';
  $('#view-timeline').hidden = S.view !== 'timeline';
  $('#view-table').hidden = S.view !== 'table';
  $('#view-turns').hidden = S.view !== 'turns';
  $('#view-docs').hidden = S.view !== 'docs';
  document.querySelectorAll('#tabs .tab').forEach((t) => t.classList.toggle('active', t.dataset.view === S.view));

  if (S.view === 'graph') renderGraph();
  if (S.view === 'timeline') renderTimeline();
  if (S.view === 'table') renderTable();
  if (S.view === 'turns') renderTurns();
  if (S.view === 'docs') {
    renderDocs();
    ensureDocs();
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
  if (['1', '2', '3', '4', '5'].includes(event.key)) {
    const views = ['graph', 'timeline', 'table', 'turns', 'docs'];
    S.view = views[Number(event.key) - 1];
    return render();
  }
});

el.search.addEventListener('input', () => {
  S.query = el.search.value;
  S.searchClear.hidden = !S.query;
  render();
});
el.searchClear.addEventListener('click', () => {
  S.query = '';
  el.search.value = '';
  S.searchClear.hidden = true;
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

function maintRow(card, actions) {
  const k = kindOf(card.kind);
  return `<div class="maint-row" data-id="${card.id}">
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
  const tabs = [
    ['dupes', '重复', m.dupes.length],
    ['stale', '疑似作废', m.stale.length],
    ['junk', '垃圾', m.junk.length],
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
      : '<p class="maint-empty">没有疑似作废的记忆。文案里带「取消了 / 改到 / 作废」的会出现在这里。</p>';
    if (list.length) bulk = `<button class="btn tiny" data-bulk="stale">全部退休（${list.length}）</button>`;
  } else if (tab === 'junk') {
    const list = rows(m.junk);
    content = list.length
      ? list.map((c) => maintRow(c, `<button class="btn tiny" data-retire="${c.id}">退休</button><button class="btn tiny danger" data-purge="${c.id}">删除</button>`)).join('')
      : '<p class="maint-empty">没有垃圾。太短、纯表情、`[取消]` 这类回执会出现在这里。</p>';
    if (list.length) bulk = `<button class="btn tiny danger" data-bulk="junk">全部删除（${list.length}）</button>`;
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
        if (!confirm('彻底删除这条？删了就找不回来了。')) return;
        try {
          await api('/api/purge', { method: 'POST', body: JSON.stringify({ ids: [btn.dataset.purge] }) });
          await refresh('已删除');
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
          const res = await api('/api/purge', { method: 'POST', body: JSON.stringify({ ids }) });
          await refresh(`删了 ${res.removed ?? 0} 条`);
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
const bootView = bootParams.get('view') ?? localStorage.getItem('mcore-view');
if (['graph', 'timeline', 'table', 'turns', 'docs'].includes(bootView)) S.view = bootView;
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
