/**
 * 新版记忆核心的“氛围层”：背景（预设 / 自定义图片）+ 新记忆到达时的轻微故障闪烁。
 *
 * 刻意不和 app.js 混在一起：app.js 是两个页面共用的，改它容易把旧页面带坏。
 * 这里只做视觉，不碰任何数据，也不写服务器。
 */
const KEY = 'mcore-bg-v1';

const PRESETS = {
  night: {
    name: '夜之城',
    css:
      'radial-gradient(65% 55% at 10% -6%, rgba(34,230,255,.34), transparent 68%),'
      + 'radial-gradient(60% 50% at 94% 2%, rgba(255,45,111,.36), transparent 70%),'
      + 'radial-gradient(75% 60% at 50% 116%, rgba(124,58,237,.34), transparent 68%),'
      + 'repeating-linear-gradient(90deg, transparent 0 30px, rgba(255,45,111,.07) 30px 31px),'
      + 'linear-gradient(#04070e, #04070e)',
  },
  acid: {
    name: '酸雨',
    css:
      'radial-gradient(70% 60% at 18% -8%, rgba(0,255,170,.28), transparent 68%),'
      + 'radial-gradient(65% 55% at 86% 4%, rgba(34,230,255,.24), transparent 70%),'
      + 'radial-gradient(80% 65% at 50% 114%, rgba(0,140,110,.30), transparent 72%),'
      + 'repeating-linear-gradient(75deg, transparent 0 14px, rgba(160,255,220,.07) 14px 15px),'
      + 'linear-gradient(#02070a, #02070a)',
  },
  chrome: {
    name: '铬',
    css:
      'radial-gradient(60% 50% at 8% -4%, rgba(255,70,90,.24), transparent 70%),'
      + 'radial-gradient(55% 45% at 92% 8%, rgba(255,190,90,.16), transparent 72%),'
      + 'linear-gradient(180deg, rgba(150,180,210,.10), transparent 42%),'
      + 'repeating-linear-gradient(0deg, transparent 0 3px, rgba(255,255,255,.035) 3px 4px),'
      + 'linear-gradient(#090a10, #090a10)',
  },
};

const state = load();
let layer = null;
let panel = null;

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}');
    return {
      preset: typeof raw.preset === 'string' && PRESETS[raw.preset] ? raw.preset : 'night',
      image: typeof raw.image === 'string' && raw.image.startsWith('data:image/') ? raw.image : null,
      dim: Number.isFinite(raw.dim) ? Math.max(0, Math.min(90, raw.dim)) : 55,
    };
  } catch {
    return { preset: 'night', image: null, dim: 55 };
  }
}

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

function apply() {
  if (!layer) return;
  const preset = PRESETS[state.preset] ?? PRESETS.night;
  layer.style.backgroundImage = state.image ? `url("${state.image}")` : preset.css;
  layer.classList.toggle('has-image', Boolean(state.image));
  layer.style.setProperty('--bg-dim', String(state.dim / 100));
}

/* ── 背景层 ─────────────────────────────────────────── */

function mountLayer() {
  layer = document.createElement('div');
  layer.className = 'bg-layer';
  layer.setAttribute('aria-hidden', 'true');
  document.body.prepend(layer);
  apply();
}

/* ── 图片：压到能塞进 localStorage 的尺寸 ───────────── */

async function toDataUrl(file, maxW, quality) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxW / bitmap.width);
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();
  return canvas.toDataURL('image/jpeg', quality);
}

async function pickImage(file) {
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    toast('这个文件不是图片');
    return;
  }
  const steps = [
    [1920, 0.82],
    [1440, 0.75],
    [1024, 0.68],
  ];
  for (const [w, q] of steps) {
    try {
      const data = await toDataUrl(file, w, q);
      const before = state.image;
      state.image = data;
      if (persist()) {
        apply();
        renderPanel();
        toast('背景已换');
        return;
      }
      state.image = before;
    } catch {
      // 换下一档再试
    }
  }
  toast('这张图太大，浏览器存不下，换一张小一点的');
}

/* ── 面板 ───────────────────────────────────────────── */

function buildPanel() {
  panel = document.createElement('div');
  panel.className = 'bg-modal';
  panel.hidden = true;
  panel.innerHTML = `
    <div class="bg-panel" role="dialog" aria-modal="true" aria-label="背景与氛围">
      <header>
        <h2>背景与氛围</h2>
        <button class="next-icon" data-close aria-label="关闭">×</button>
      </header>
      <div class="bg-body">
        <div class="bg-label">预设</div>
        <div class="bg-presets">
          ${Object.entries(PRESETS)
            .map(
              ([id, p]) =>
                `<button class="bg-swatch" data-preset="${id}" title="${p.name}"><i style="background-image:${p.css}"></i><span>${p.name}</span></button>`,
            )
            .join('')}
        </div>
        <div class="bg-label">自定义</div>
        <div class="bg-row">
          <button class="btn tiny" data-pick>选一张本地图片…</button>
          <button class="btn tiny" data-clear>清除图片</button>
        </div>
        <input type="file" accept="image/*" hidden />
        <label class="bg-slider">
          <span>压暗</span>
          <input type="range" min="0" max="90" step="5" />
          <b></b>
        </label>
        <p class="bg-note">图片会被压到 1920 宽以内，只存在这台机器的浏览器里，不上传、不进备份。</p>
      </div>
    </div>`;
  document.body.appendChild(panel);

  panel.addEventListener('click', (e) => {
    if (e.target === panel) closePanel();
  });
  panel.querySelector('[data-close]')?.addEventListener('click', closePanel);

  const file = panel.querySelector('input[type=file]');
  panel.querySelector('[data-pick]')?.addEventListener('click', () => file?.click());
  file?.addEventListener('change', () => {
    const picked = file.files?.[0];
    if (picked) void pickImage(picked);
    file.value = '';
  });
  panel.querySelector('[data-clear]')?.addEventListener('click', () => {
    state.image = null;
    persist();
    apply();
    renderPanel();
    toast('已回到预设背景');
  });

  const dim = panel.querySelector('.bg-slider input');
  dim?.addEventListener('input', () => {
    state.dim = Number(dim.value) || 0;
    persist();
    apply();
    renderPanel();
  });

  panel.querySelectorAll('[data-preset]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.preset = btn.dataset.preset ?? 'night';
      state.image = null;
      persist();
      apply();
      renderPanel();
    });
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !panel.hidden) closePanel();
  });
}

function renderPanel() {
  if (!panel) return;
  panel.querySelectorAll('[data-preset]').forEach((btn) => {
    btn.classList.toggle('on', btn.dataset.preset === state.preset && !state.image);
  });
  const dim = panel.querySelector('.bg-slider input');
  const out = panel.querySelector('.bg-slider b');
  if (dim) { dim.value = String(state.dim); dim.disabled = !state.image; }
  if (out) out.textContent = state.image ? `${state.dim}%` : '仅图片';
  const clear = panel.querySelector('[data-clear]');
  if (clear) clear.disabled = !state.image;
}

function openPanel() {
  if (!panel) buildPanel();
  renderPanel();
  panel.hidden = false;
}

function closePanel() {
  if (panel) panel.hidden = true;
}

/* ── 提示 ───────────────────────────────────────────── */

function toast(msg) {
  let box = document.getElementById('bg-toast');
  if (!box) {
    box = document.createElement('div');
    box.id = 'bg-toast';
    box.className = 'bg-toast';
    document.body.appendChild(box);
  }
  box.textContent = msg;
  box.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    box.hidden = true;
  }, 2200);
}

/* ── 新记忆到达：闪一下 ─────────────────────────────── */

let prevCount = null;
let flashTimer = 0;

function flash() {
  document.body.classList.add('cg-glitch');
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => document.body.classList.remove('cg-glitch'), 700);
}

async function watch() {
  if (document.hidden) return;
  try {
    const rsp = await fetch('/api/snapshot', { cache: 'no-store' });
    if (!rsp.ok) return;
    const snap = await rsp.json();
    const cards = Array.isArray(snap.cards) ? snap.cards : [];
    if (prevCount !== null && cards.length > prevCount) flash();
    prevCount = cards.length;
  } catch {
    // 读不到就算了，纯装饰
  }
}

/* ── 启动 ───────────────────────────────────────────── */

// 深链接：?bg=night|acid|chrome 直接切预设（也方便截图核对）
const qs = new URLSearchParams(location.search).get('bg');
if (qs && PRESETS[qs]) {
  state.preset = qs;
  state.image = null;
  persist();
}

mountLayer();
document.getElementById('btn-bg')?.addEventListener('click', openPanel);
// 地址带 #bg 直接打开面板：省得每次点，也方便截图核对
if (location.hash === '#bg') openPanel();
watch();
setInterval(() => void watch(), 20_000);
