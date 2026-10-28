/* Pune Waste Routes: the page.
   All routing is done by the C++ backend (GET /api/towns once, GET /api/plan on every change).
   This file draws the result: terrain, roads, glowing routes, markers, the list, and a replay of the day.

   Sections: setup, server, map geometry, camera, terrain, markers, list, panels, popup, day replay, loop, events, boot. */
(() => {
'use strict';

/* ---------- setup ---------- */
const API = location.protocol === 'file:' ? 'http://localhost:8080' : '';
const REDUCED = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const SVGNS = 'http://www.w3.org/2000/svg';
const START_MIN = 6 * 60;                 /* the day starts at 06:00 */
const SPEEDS = [30, 60, 120, 240];        /* simulated minutes per real second */
const SPEED_LABEL = ['½ h/s', '1 h/s', '2 h/s', '4 h/s'];
const clock = (min) => {
  const m = Math.round(START_MIN + min);
  return String(Math.floor(m / 60) % 24).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
};
const fmtDur = (min) => { const m = Math.round(min); return Math.floor(m / 60) + ' h ' + String(m % 60).padStart(2, '0') + ' min'; };

const CHK = '<svg class="chk" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.2 4.2L19 7.2" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const YARD = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" fill="currentColor"/></svg>';
const PLAY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z" fill="currentColor"/></svg>';
const PAUSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6.5" y="5" width="4" height="14" rx="1.2" fill="currentColor"/><rect x="13.5" y="5" width="4" height="14" rx="1.2" fill="currentColor"/></svg>';
const REPLAY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5V2.5L7.5 6 12 9.5V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7z" fill="currentColor"/></svg>';
const CLOSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';

const mapwrap = $('mapwrap'), svg = $('map'), terrain = $('terrain'), tctx = terrain.getContext('2d');
const gRoutes = $('gRoutes'), markersEl = $('markers'), popupEl = $('popup'), glowBlur = $('glowBlur');

let TOWNS = [], EDGES = [], ALGOS = [], N = 0;
let CONST = { speedKmh: 38, stopMinutes: 10 };
const EDGEW = {};                 /* "a-b" (a<b) -> road km */
const EG = {};                    /* "a-b" (a<b) -> curved road, points from a to b, in world km */
let world = { W: 100, H: 100 };

const S = { seed: 1, thr: 50, cap: 10, algo: 'sav2', show: 'all', sort: 'fill', q: '', tab: 'towns', sel: -1, focus: -1 };
let view = null;                  /* the latest plan from the server */
let info = {};                    /* town -> { k: truck, s: stop number, arrive, leave } in minutes after 06:00 */
let drain = {};                   /* town -> 0..1, how emptied it is during the replay */
const sim = { t: 0, total: 0, playing: false, speed: 1, trucks: [] };
let mkEls = [], itemEls = [], trEls = [], routeEls = [];
let scr = [];                     /* town -> screen position */

/* ---------- the C++ server ---------- */
function getJSON(path) {
  return fetch(API + path).then(
    (r) => r.json().then((j) => { if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status); return j; }),
    () => { const e = new Error('Network error'); e.network = true; throw e; }
  );
}

function setStatus(kind, text, title) {
  const s = $('status');
  s.className = 'engine ' + kind;
  s.querySelector('span').textContent = text;
  s.title = title || '';
}

let retryTimer = 0;
function onError(err) {
  if (err && err.network) {
    setStatus('bad', 'Offline', 'The C++ server cannot be reached');
    $('offline').hidden = false;
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => (N ? schedulePlan() : boot()), 3000);
  } else {
    setStatus('bad', 'Error', err && err.message);
    if (window.console) console.error(err);
  }
}

let busy = false, again = false, firstPlan = true;
function schedulePlan() {
  if (!N) return;
  if (busy) { again = true; return; }
  busy = true;
  const t0 = performance.now();
  const url = '/api/plan?seed=' + S.seed + '&thr=' + S.thr + '&cap=' + S.cap + '&algo=' + encodeURIComponent(S.algo);
  getJSON(url).then((d) => {
    busy = false;
    $('offline').hidden = true;
    applyPlan(d, performance.now() - t0);
    if (again) { again = false; schedulePlan(); }
  }).catch((e) => { busy = false; again = false; onError(e); });
}

/* ---------- map geometry (world units are km) ---------- */
function setupWorld() {
  const lats = TOWNS.map((t) => t.lat), lons = TOWNS.map((t) => t.lon);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats), minLon = Math.min(...lons), maxLon = Math.max(...lons);
  const kmLon = 111.2 * Math.cos(((minLat + maxLat) / 2) * Math.PI / 180);
  world = { W: (maxLon - minLon) * kmLon, H: (maxLat - minLat) * 111.2 };
  TOWNS.forEach((t) => { t.x = (t.lon - minLon) * kmLon; t.y = (maxLat - t.lat) * 111.2; });
}

function h2(a, b) {
  let h = (Math.imul(a + 1, 374761393) + Math.imul(b + 1, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/* Roads bend a little, the same way every time, so the network looks drawn rather than ruled. */
function buildEdges() {
  EDGES.forEach(([a, b, w]) => {
    const lo = Math.min(a, b), hi = Math.max(a, b), A = TOWNS[lo], B = TOWNS[hi];
    EDGEW[lo + '-' + hi] = w;
    const dx = B.x - A.x, dy = B.y - A.y, len = Math.hypot(dx, dy) || 1;
    const off = (h2(lo, hi) * 2 - 1) * 0.11 * len;
    const cx = (A.x + B.x) / 2 + (-dy / len) * off, cy = (A.y + B.y) / 2 + (dx / len) * off;
    const pts = [];
    for (let j = 0; j <= 12; j++) {
      const t = j / 12, u = 1 - t;
      pts.push({ x: u * u * A.x + 2 * u * t * cx + t * t * B.x, y: u * u * A.y + 2 * u * t * cy + t * t * B.y });
    }
    EG[lo + '-' + hi] = pts;
  });
}
const edgePts = (a, b) => { const p = EG[Math.min(a, b) + '-' + Math.max(a, b)]; return a < b ? p : p.slice().reverse(); };
const edgeKm = (a, b) => EDGEW[Math.min(a, b) + '-' + Math.max(a, b)] || Math.hypot(TOWNS[a].x - TOWNS[b].x, TOWNS[a].y - TOWNS[b].y) * 1.25;

function buildRoads() {
  let d = '';
  EDGES.forEach(([a, b]) => {
    const p = edgePts(Math.min(a, b), Math.max(a, b));
    d += 'M' + p.map((q) => q.x.toFixed(2) + ' ' + q.y.toFixed(2)).join(' L') + ' ';
  });
  $('roadCase').setAttribute('d', d);
  $('roadLine').setAttribute('d', d);
}

/* ---------- camera ---------- */
const cam = { x: 0, y: 0, s: 1 };
let cw = 800, ch = 600, fitS = 1, minS = 0.5, maxS = 20, vb = { x: 0, y: 0 }, dirty = true, userMoved = false, flyAnim = null;

function measure() {
  const r = mapwrap.getBoundingClientRect();
  cw = Math.max(280, r.width); ch = Math.max(280, r.height);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  terrain.width = Math.round(cw * dpr); terrain.height = Math.round(ch * dpr);
  if (!N) return;
  fitS = Math.min(cw / (world.W + 40), (ch - 120) / (world.H + 24));
  minS = fitS * 0.7; maxS = fitS * 16;
}
const fitCenter = () => ({ x: world.W / 2, y: world.H / 2 + 44 / fitS });

function clampCam() {
  cam.x = clamp(cam.x, -world.W * 0.1, world.W * 1.1);
  cam.y = clamp(cam.y, -world.H * 0.1, world.H * 1.1);
}

function flyTo(x, y, s, ms) {
  s = clamp(s, minS, maxS);
  if (REDUCED || !ms) { cam.x = x; cam.y = y; cam.s = s; clampCam(); dirty = true; flyAnim = null; return; }
  flyAnim = { x0: cam.x, y0: cam.y, s0: cam.s, x1: x, y1: y, s1: s, t0: performance.now(), dur: ms };
}
function stepFly(now) {
  if (!flyAnim) return;
  const f = flyAnim, k = ease(clamp((now - f.t0) / f.dur, 0, 1));
  cam.x = lerp(f.x0, f.x1, k); cam.y = lerp(f.y0, f.y1, k); cam.s = f.s0 * Math.pow(f.s1 / f.s0, k);
  dirty = true;
  if (k >= 1) flyAnim = null;
}
function zoomAt(mx, my, factor) {
  const s2 = clamp(cam.s * factor, minS, maxS);
  const wx = cam.x + (mx - cw / 2) / cam.s, wy = cam.y + (my - ch / 2) / cam.s;
  cam.s = s2; cam.x = wx - (mx - cw / 2) / s2; cam.y = wy - (my - ch / 2) / s2;
  clampCam(); dirty = true; flyAnim = null;
}
function fitAll(ms) { const c = fitCenter(); flyTo(c.x, c.y, fitS, ms); userMoved = false; }
function fitBox(x0, y0, x1, y1, ms) {
  const w = x1 - x0 + 44, h = y1 - y0 + 44;
  const s = Math.min(cw / w, (ch - 130) / h);
  flyTo((x0 + x1) / 2, (y0 + y1) / 2 + 44 / s, s, ms);
}

function applyCamera() {
  const s = cam.s, vbw = cw / s, vbh = ch / s;
  vb = { x: cam.x - vbw / 2, y: cam.y - vbh / 2 };
  svg.setAttribute('viewBox', vb.x + ' ' + vb.y + ' ' + vbw + ' ' + vbh);
  svg.style.setProperty('--inv', (1 / s).toFixed(5));
  glowBlur.setAttribute('stdDeviation', (4.5 / s).toFixed(4));
  const m = clamp(s / 6.5, 0.5, 1.12);
  markersEl.style.setProperty('--m', m.toFixed(3));
  markersEl.classList.toggle('compact', m < 0.62);  /* zoomed far out: badges only, details on hover or select */
  drawTerrain();
  TOWNS.forEach((t, i) => {
    const sx = (t.x - vb.x) * s, sy = (t.y - vb.y) * s;
    scr[i] = { x: sx, y: sy };
    if (mkEls[i]) mkEls[i].style.transform = 'translate3d(' + sx.toFixed(1) + 'px,' + sy.toFixed(1) + 'px,0)';
  });
  routeEls.forEach((re) => {
    const o = re.off / s;
    re.g.setAttribute('transform', 'translate(' + o + ' ' + o + ')');
  });
  positionPopup();
}

/* ---------- terrain: generated contour lines, so the map has a ground to sit on ---------- */
let tex = null;
function hash(ix, iy) {
  let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function vnoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  return lerp(lerp(hash(xi, yi), hash(xi + 1, yi), u), lerp(hash(xi, yi + 1), hash(xi + 1, yi + 1), u), v);
}
const fbm = (x, y) => vnoise(x, y) * 0.55 + vnoise(x * 2.1 + 7.3, y * 2.1 + 1.7) * 0.3 + vnoise(x * 4.3 + 3.1, y * 4.3 + 9.2) * 0.15;

function makeTexture() {
  const light = document.documentElement.getAttribute('data-theme') === 'light';
  const tw = 560, th = Math.max(200, Math.round(tw * world.H / world.W));
  const c = document.createElement('canvas');
  c.width = tw; c.height = th;
  const x = c.getContext('2d'), img = x.createImageData(tw, th), F = new Float32Array(tw * th);
  for (let j = 0; j < th; j++) for (let i = 0; i < tw; i++) {
    F[j * tw + i] = fbm((-world.W + (i / tw) * 3 * world.W) / 46, (-world.H + (j / th) * 3 * world.H) / 46);
  }
  const c0 = light ? [233, 237, 229] : [12, 20, 18], c1 = light ? [210, 220, 209] : [27, 42, 38];
  const lc = light ? 0 : 255, levels = 10;
  for (let j = 0; j < th; j++) for (let i = 0; i < tw; i++) {
    const idx = j * tw + i, f = F[idx];
    const gx = F[j * tw + Math.min(tw - 1, i + 1)] - f, gy = F[Math.min(th - 1, j + 1) * tw + i] - f;
    const gv = (Math.abs(gx) + Math.abs(gy)) * levels + 1e-4, v = f * levels, r = Math.round(v);
    let a = clamp(1 - Math.abs(v - r) / (gv * 0.85), 0, 1) * (light ? 0.17 : 0.13);
    if (r % 3 === 0) a *= 1.7;
    const k = clamp((f - 0.2) / 0.6, 0, 1), o = idx * 4;
    img.data[o] = lerp(c0[0], c1[0], k) * (1 - a) + lc * a;
    img.data[o + 1] = lerp(c0[1], c1[1], k) * (1 - a) + lc * a;
    img.data[o + 2] = lerp(c0[2], c1[2], k) * (1 - a) + lc * a;
    img.data[o + 3] = 255;
  }
  x.putImageData(img, 0, 0);
  tex = c;
}
function drawTerrain() {
  if (!tex) return;
  const k = terrain.width / cw, s = cam.s;
  tctx.setTransform(k, 0, 0, k, 0, 0);
  tctx.imageSmoothingEnabled = true;
  tctx.imageSmoothingQuality = 'high';
  tctx.drawImage(tex, (-world.W - vb.x) * s, (-world.H - vb.y) * s, 3 * world.W * s, 3 * world.H * s);
}

/* ---------- markers ---------- */
function initials(name) {
  const parts = name.split(/[\s-]+/).filter(Boolean);
  if (parts.length > 1) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).replace(/^./, (ch0) => ch0.toUpperCase());
}

function buildMarkers() {
  markersEl.innerHTML = '';
  mkEls = [];
  TOWNS.forEach((t, i) => {
    const el = document.createElement('div');
    el.className = 'mk off' + (t.depot ? ' depot' : '');
    el.dataset.i = i; el.tabIndex = 0; el.setAttribute('role', 'button'); el.setAttribute('aria-label', t.name);
    el.innerHTML = '<div class="mk-in" style="--i:' + i + '">' +
      (t.depot
        ? '<i class="radar"></i><i class="radar r2"></i><div class="mk-badge">' + YARD + '</div>'
        : '<div class="mk-badge"><span>' + esc(initials(t.name)) + '</span>' + CHK + '</div><div class="mk-ord"></div><div class="mk-pill"><i></i><b>0%</b></div>') +
      '<div class="mk-name">' + esc(t.name) + '</div></div>';
    el.addEventListener('click', () => select(i));
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(i); } });
    el.addEventListener('mouseenter', () => hover(i, true));
    el.addEventListener('mouseleave', () => hover(i, false));
    markersEl.appendChild(el);
    mkEls[i] = el;
  });
}

function hover(i, on) {
  if (mkEls[i]) mkEls[i].classList.toggle('hov', on);
  if (itemEls[i]) itemEls[i].classList.toggle('hov', on);
}

/* ---------- the town list ---------- */
function buildItems() {
  const ul = $('list');
  ul.innerHTML = '';
  itemEls = [];
  TOWNS.forEach((t, i) => {
    if (t.depot) { itemEls[i] = null; return; }
    const li = document.createElement('li');
    li.className = 'town off';
    li.dataset.i = i; li.tabIndex = 0; li.setAttribute('role', 'button');
    li.innerHTML = '<div class="ava"><span>' + esc(initials(t.name)) + '</span>' + CHK + '</div>' +
      '<div class="tt"><div class="name">' + esc(t.name) + '</div><div class="meta"><span>' + t.bins + ' bins</span><i class="sep">•</i><span class="st"></span></div></div>' +
      '<div class="rc"><b class="pct">0%</b><span class="tchip">–</span></div>';
    li.addEventListener('click', () => select(i, { scroll: false }));
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(i, { scroll: false }); }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const vis = itemEls.filter((x) => x && !x.hidden), at = vis.indexOf(li), nx = vis[at + (e.key === 'ArrowDown' ? 1 : -1)];
        if (nx) { nx.focus(); select(+nx.dataset.i, { scroll: false }); }
      }
    });
    li.addEventListener('mouseenter', () => hover(i, true));
    li.addEventListener('mouseleave', () => hover(i, false));
    ul.appendChild(li);
    itemEls[i] = li;
  });
  if (!REDUCED) {
    itemEls.filter(Boolean).forEach((li, n) => li.animate(
      [{ opacity: 0, transform: 'translateY(14px)' }, { opacity: 1, transform: 'none' }],
      { duration: 520, delay: 350 + n * 40, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'backwards' }
    ));
  }
}

const sorters = {
  fill: (a, b) => view.fills[b.id] - view.fills[a.id],
  route: (a, b) => {
    const ia = info[a.id], ib = info[b.id];
    if (ia && ib) return ia.k - ib.k || ia.s - ib.s;
    if (ia) return -1;
    if (ib) return 1;
    return view.fills[b.id] - view.fills[a.id];
  },
  yard: (a, b) => Math.hypot(a.x - TOWNS[0].x, a.y - TOWNS[0].y) - Math.hypot(b.x - TOWNS[0].x, b.y - TOWNS[0].y),
  bins: (a, b) => b.bins - a.bins,
  name: (a, b) => a.name.localeCompare(b.name)
};

function renderList() {
  if (!view) return;
  const q = S.q.trim().toLowerCase();
  const arr = TOWNS.filter((t) => {
    if (t.depot) return false;
    if (q && !(t.name.toLowerCase().includes(q) || t.note.toLowerCase().includes(q))) return false;
    const inf = info[t.id];
    return S.show === 'all' || (S.show === 'collected' && inf) || (S.show === 'skipped' && !inf) || (S.show === 'risk' && view.fills[t.id] >= 80);
  }).sort(sorters[S.sort]);

  const ul = $('list'), before = new Map();
  itemEls.forEach((el, i) => { if (el && !el.hidden) before.set(i, el.getBoundingClientRect().top); });
  const show = new Set(arr.map((t) => t.id));
  let ref = ul.firstElementChild;
  arr.forEach((t) => {
    const el = itemEls[t.id];
    if (el === ref) ref = ref.nextElementSibling; else ul.insertBefore(el, ref);
  });
  itemEls.forEach((el, i) => {
    if (!el) return;
    const vis = show.has(i), was = !el.hidden;
    el.hidden = !vis;
    if (vis && !was && !REDUCED) el.animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: 300, easing: 'ease-out' });
  });
  if (!REDUCED) {
    arr.forEach((t) => {
      const el = itemEls[t.id], b = before.get(t.id);
      if (b == null) return;
      const dy = b - el.getBoundingClientRect().top;
      if (Math.abs(dy) > 1) el.animate([{ transform: 'translateY(' + dy + 'px)' }, { transform: 'none' }], { duration: 460, easing: 'cubic-bezier(.2,.8,.2,1)' });
    });
  }
  $('listEmpty').hidden = arr.length > 0;
}

function stateText(i) {
  const inf = info[i];
  if (!inf) return 'Skipped · under ' + S.thr + '%';
  return (drain[i] || 0) >= 1 ? 'Emptied ' + clock(inf.leave) : 'Truck ' + (inf.k + 1) + ' · ETA ' + clock(inf.arrive);
}

function paintTown(i) {
  const t = TOWNS[i];
  if (t.depot || !view) return;
  const inf = info[i], fill = view.fills[i], p = drain[i] || 0, shown = Math.round(fill * (1 - p)), done = !!inf && p >= 1;
  const col = inf ? 'var(--t' + (inf.k % 6) + ')' : 'var(--muted2)';
  [itemEls[i], mkEls[i]].forEach((el) => {
    el.style.setProperty('--c', col);
    el.style.setProperty('--fill', shown);
    el.classList.toggle('on', !!inf);
    el.classList.toggle('off', !inf);
    el.classList.toggle('done', done);
    el.classList.toggle('risk', fill >= 80 && !done);
  });
  const li = itemEls[i];
  li.querySelector('.st').textContent = stateText(i);
  li.querySelector('.pct').textContent = shown + '%';
  li.querySelector('.tchip').textContent = inf ? inf.k + 1 : '–';
  mkEls[i].querySelector('.mk-pill b').textContent = shown + '%';
  mkEls[i].querySelector('.mk-ord').textContent = inf ? inf.s : '';
}

function paintFill(i) {
  if (!info[i]) return;
  const fill = view.fills[i], p = drain[i] || 0, shown = Math.round(fill * (1 - p)), done = p >= 1;
  [itemEls[i], mkEls[i]].forEach((el) => {
    el.style.setProperty('--fill', shown);
    el.classList.toggle('done', done);
    el.classList.toggle('risk', fill >= 80 && !done);
  });
  itemEls[i].querySelector('.pct').textContent = shown + '%';
  itemEls[i].querySelector('.st').textContent = stateText(i);
  mkEls[i].querySelector('.mk-pill b').textContent = shown + '%';
}

/* ---------- sidebar panels ---------- */
function countTo(el, to, dec) {
  const from = parseFloat(el.dataset.v || '0');
  el.dataset.v = to;
  cancelAnimationFrame(el._r);
  if (REDUCED || Math.abs(from - to) < 1e-9) { el.textContent = to.toFixed(dec); return; }
  const t0 = performance.now();
  const step = (now) => {
    const k = ease(clamp((now - t0) / 650, 0, 1));
    el.textContent = lerp(from, to, k).toFixed(dec);
    if (k < 1) el._r = requestAnimationFrame(step);
  };
  el._r = requestAnimationFrame(step);
}

function renderKpis() {
  const cur = view.cur, base = view.baseline;
  const saved = base.km > 0 ? Math.max(0, (1 - cur.km / base.km) * 100) : 0;
  countTo($('kDist'), cur.km, 0);
  countTo($('kTrucks'), cur.trucks, 0);
  countTo($('kSaved'), saved, 0);
  countTo($('kStops'), view.collected.length, 0);
  $('kStopsLbl').textContent = 'of ' + (N - 1) + ' towns';
}

function renderTrucks() {
  const rows = view.cur.rows, box = $('trucks');
  if (!rows.length) {
    box.innerHTML = '<p class="empty">No town is at or above ' + S.thr + '% today, so no truck leaves the yard. Lower the cut-off in Filters.</p>';
    return;
  }
  box.innerHTML = rows.map((row, k) => {
    const tr = sim.trucks[k];
    const legs = ['<li class="start"><span>Central yard</span><em>' + clock(0) + '</em></li>']
      .concat(tr.stops.map((st) => '<li><span>' + esc(TOWNS[st.node].name) + '</span><em>' + clock(st.arrive) + '</em></li>'))
      .concat(['<li class="end"><span>Back at the yard</span><em>' + clock(tr.total) + '</em></li>']).join('');
    return '<article class="tcard c' + (k % 6) + '" data-k="' + k + '" role="button" tabindex="0" aria-pressed="' + (S.focus === k) + '">' +
      '<header><span class="tbadge">' + (k + 1) + '</span><div><h3>Truck ' + (k + 1) + '</h3><p>' + row.km.toFixed(0) + ' km · ' + fmtDur(tr.total) + '</p></div>' +
      '<span class="tload mono"></span></header>' +
      '<div class="load"><i class="plan" style="width:' + Math.min(100, row.load / S.cap * 100).toFixed(1) + '%"></i><i class="now" style="width:0"></i></div>' +
      '<ol class="legs">' + legs + '</ol></article>';
  }).join('');
  updateTruckLoads();
}

function updateTruckLoads() {
  const box = $('trucks');
  sim.trucks.forEach((tr, k) => {
    const card = box.querySelector('[data-k="' + k + '"]');
    if (!card) return;
    const carried = tr.carried || 0;
    card.querySelector('.now').style.width = Math.min(100, carried / S.cap * 100).toFixed(1) + '%';
    card.querySelector('.tload').textContent = carried.toFixed(1) + ' / ' + tr.row.load.toFixed(1) + ' t · cap ' + S.cap;
  });
}

function renderCompare() {
  const box = $('compare');
  const kms = ALGOS.map((a) => view.results[a.id].km), maxKm = Math.max(...kms, 1);
  const pos = kms.filter((v) => v > 0), best = pos.length ? Math.min(...pos) : -1;
  box.innerHTML = ALGOS.map((a) => {
    const r = view.results[a.id], isBest = r.km > 0 && r.km <= best + 1e-6;
    return '<button type="button" class="cmp-row' + (isBest ? ' best' : '') + '" data-a="' + a.id + '" aria-pressed="' + (a.id === S.algo) + '">' +
      '<b>' + esc(a.name) + (isBest ? '<span class="badge-best">Shortest</span>' : '') + '</b><span class="v">' + r.km.toFixed(1) + ' km</span>' +
      '<span class="bar"><i data-w="' + (r.km / maxKm * 100).toFixed(1) + '"></i></span>' +
      '<small>' + r.trucks + ' trucks · ' + (r.km ? fmtDur(r.hours * 60) : '–') + ' of truck time</small></button>';
  }).join('') +
    '<p class="cmp-note">Collecting every town with this method would take ' + view.baseline.km.toFixed(0) + ' km. Road length is straight-line distance × 1.25. Tap a method to switch to it.</p>';
  requestAnimationFrame(() => requestAnimationFrame(() => {
    box.querySelectorAll('.bar i').forEach((i) => i.style.setProperty('--w', i.dataset.w + '%'));
  }));
}

function renderChips() {
  const box = $('chips');
  box.innerHTML = view.cur.rows.map((row, k) =>
    '<button type="button" class="chip c' + (k % 6) + '" data-k="' + k + '" aria-pressed="' + (S.focus === k) + '" style="animation-delay:' + (500 + k * 90) + 'ms"><i>' + (k + 1) + '</i>Truck ' + (k + 1) + '<span>' + row.km.toFixed(0) + ' km</span></button>'
  ).join('');
}

function placeInk() {
  const b = document.querySelector('.tabs [aria-selected="true"]'), ink = $('tabInk');
  if (!b) return;
  ink.style.width = b.offsetWidth + 'px';
  ink.style.transform = 'translateX(' + b.offsetLeft + 'px)';
}
function switchTab(name) {
  S.tab = name;
  document.querySelectorAll('.tabs button').forEach((b) => {
    const on = b.dataset.tab === name;
    b.setAttribute('aria-selected', on);
    b.tabIndex = on ? 0 : -1;
    $('panel-' + b.dataset.tab).hidden = !on;
  });
  $('panels').scrollTop = 0;
  placeInk();
}

let toastTimer = 0;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
}

/* ---------- selecting a town and the popup card ---------- */
function colorOf(i) { return info[i] ? 'var(--t' + (info[i].k % 6) + ')' : 'var(--muted2)'; }

function select(i, opts) {
  opts = opts || {};
  S.sel = i;
  mkEls.forEach((el, j) => el.classList.toggle('sel', j === i));
  itemEls.forEach((el, j) => { if (el) el.classList.toggle('sel', j === i); });
  if (i < 0) { popupEl.hidden = true; return; }
  showPopup(i);
  if (opts.fly !== false) flyTo(TOWNS[i].x, TOWNS[i].y, Math.max(cam.s, fitS * 1.9), 850);
  if (opts.scroll !== false && itemEls[i] && !itemEls[i].hidden && S.tab === 'towns') {
    /* Scroll only the sidebar list, never the whole page (on phones the list is part of the page). */
    const sc = $('panels'), r = itemEls[i].getBoundingClientRect(), pr = sc.getBoundingClientRect();
    if (sc.scrollHeight > sc.clientHeight + 2) {
      const b = REDUCED ? 'auto' : 'smooth';
      if (r.top < pr.top) sc.scrollBy({ top: r.top - pr.top - 8, behavior: b });
      else if (r.bottom > pr.bottom) sc.scrollBy({ top: r.bottom - pr.bottom + 8, behavior: b });
    }
  }
}

function popupHTML(i) {
  const t = TOWNS[i];
  if (t.depot) {
    const n = view.cur.rows.length;
    return '<div class="pop-head"><div class="ava" style="--fill:100;--c:var(--accent)"><span>' + YARD.replace('<svg ', '<svg width="22" height="22" ') + '</span></div><div><h2>' + esc(t.name) + '</h2><p>Where every truck starts and ends</p></div><button class="x" data-act="close" aria-label="Close">' + CLOSE + '</button></div>' +
      '<h3 class="pop-h">' + (n ? n + ' truck' + (n > 1 ? 's' : '') + ' leave at ' + clock(0) : 'No truck leaves today') + '</h3>' +
      '<ul class="pop-list"><li>Road distances start here</li><li>Truck capacity today is ' + S.cap + ' t</li></ul>';
  }
  const inf = info[i], fill = view.fills[i], tons = view.q[i], cap = t.capT, p = drain[i] || 0, done = !!inf && p >= 1;
  let heading, bullets, acts;
  if (inf) {
    const n = view.cur.rows[inf.k].nodes.length;
    heading = done ? 'Emptied at ' + clock(inf.leave) : 'Pickup planned for ' + clock(inf.arrive);
    bullets = ['Truck ' + (inf.k + 1) + ', stop ' + inf.s + ' of ' + n,
      'The truck stays ' + CONST.stopMinutes + ' minutes (' + clock(inf.arrive) + ' to ' + clock(inf.leave) + ')',
      'Takes ' + tons.toFixed(1) + ' t out of ' + cap.toFixed(1) + ' t'];
    acts = '<button class="btn primary" data-act="jump" type="button">Jump to pickup</button><button class="btn" data-act="focus" type="button">Focus route</button>';
  } else {
    heading = 'Not on today\'s run';
    bullets = ['Bins are ' + fill + '% full and the cut-off is ' + S.thr + '%',
      'Holds up to ' + cap.toFixed(1) + ' t when full',
      'Lower the cut-off to ' + fill + '% to add it'];
    acts = '<button class="btn primary" data-act="include" type="button">Collect it too</button>';
  }
  return '<div class="pop-head"><div class="ava" style="--fill:' + Math.round(fill * (1 - p)) + '"><span>' + esc(initials(t.name)) + '</span>' + CHK + '</div>' +
    '<div><h2>' + esc(t.name) + '</h2><p>' + esc(t.note) + '</p></div><button class="x" data-act="close" aria-label="Close">' + CLOSE + '</button></div>' +
    '<div class="stats"><div><small>Full</small><b>' + Math.round(fill * (1 - p)) + '%</b></div><div><small>Bins</small><b>' + t.bins + '</b></div><div><small>Waste</small><b>' + (tons * (1 - p)).toFixed(1) + ' t</b></div></div>' +
    '<h3 class="pop-h">' + heading + '</h3>' +
    '<ul class="pop-list">' + bullets.map((b) => '<li>' + b + '</li>').join('') + '</ul>' +
    '<div class="pop-act">' + acts + '</div>';
}

function showPopup(i, silent) {
  popupEl.hidden = false;
  popupEl.style.setProperty('--c', colorOf(i));
  popupEl.classList.toggle('done', !!info[i] && (drain[i] || 0) >= 1);
  popupEl.innerHTML = popupHTML(i);
  if (!silent) { popupEl.classList.remove('in'); void popupEl.offsetWidth; popupEl.classList.add('in'); }
  positionPopup();
}
function positionPopup() {
  if (popupEl.hidden || S.sel < 0 || !scr[S.sel]) return;
  if (cw < 560) {  /* phones: a card above the dock instead of beside the marker */
    popupEl.style.width = (cw - 24) + 'px';
    popupEl.style.left = '12px';
    popupEl.style.top = Math.max(12, ch - popupEl.offsetHeight - 86) + 'px';
    return;
  }
  popupEl.style.width = '';
  const p = scr[S.sel], w = popupEl.offsetWidth, h = popupEl.offsetHeight;
  let left = p.x + 38, top = p.y - h / 2;
  if (left + w > cw - 12) left = p.x - 38 - w;
  if (left < 12) left = clamp((cw - w) / 2, 12, cw);
  top = clamp(top, 12, Math.max(12, ch - h - 92));
  popupEl.style.left = left.toFixed(0) + 'px';
  popupEl.style.top = top.toFixed(0) + 'px';
}

/* ---------- focusing one truck ---------- */
function applyFocus() {
  routeEls.forEach((re, k) => re.g.classList.toggle('dim', S.focus >= 0 && S.focus !== k));
  trEls.forEach((el, k) => el.classList.toggle('dim', S.focus >= 0 && S.focus !== k));
  mkEls.forEach((el, i) => {
    if (TOWNS[i].depot) return;
    el.classList.toggle('dim', S.focus >= 0 && !(info[i] && info[i].k === S.focus));
  });
  document.querySelectorAll('#chips .chip, #trucks .tcard').forEach((b) => b.setAttribute('aria-pressed', +b.dataset.k === S.focus));
}
function focusRoute(k) {
  S.focus = S.focus === k ? -1 : k;
  applyFocus();
  if (S.focus < 0) { fitAll(800); return; }
  const tr = sim.trucks[S.focus];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  tr.segs.forEach((s) => { x0 = Math.min(x0, s.x0, s.x1); y0 = Math.min(y0, s.y0, s.y1); x1 = Math.max(x1, s.x0, s.x1); y1 = Math.max(y1, s.y0, s.y1); });
  fitBox(x0, y0, x1, y1, 900);
}

/* ---------- replaying the day ---------- */
function buildSim() {
  const rows = view.cur.rows;
  sim.trucks = [];
  info = {};
  let total = 0;
  rows.forEach((row, k) => {
    const segs = [], stops = [], targets = row.nodes.concat([0]);
    let t = 0, L = 0, ti = 0;
    for (let i = 0; i < row.path.length - 1; i++) {
      const a = row.path[i], b = row.path[i + 1], pts = edgePts(a, b), eMin = edgeKm(a, b) / CONST.speedKmh * 60;
      let tot = 0;
      for (let j = 0; j < pts.length - 1; j++) tot += Math.hypot(pts[j + 1].x - pts[j].x, pts[j + 1].y - pts[j].y);
      for (let j = 0; j < pts.length - 1; j++) {
        const sl = Math.hypot(pts[j + 1].x - pts[j].x, pts[j + 1].y - pts[j].y), dur = eMin * sl / (tot || 1);
        segs.push({ t0: t, t1: t + dur, x0: pts[j].x, y0: pts[j].y, x1: pts[j + 1].x, y1: pts[j + 1].y, l0: L, len: sl });
        t += dur; L += sl;
      }
      if (b === targets[ti]) {
        if (ti < targets.length - 1) {
          const e = pts[pts.length - 1], dw = CONST.stopMinutes;
          segs.push({ t0: t, t1: t + dw, x0: e.x, y0: e.y, x1: e.x, y1: e.y, l0: L, len: 0 });
          stops.push({ node: b, arrive: t, leave: t + dw });
          info[b] = { k, s: ti + 1, arrive: t, leave: t + dw };
          t += dw;
        }
        ti++;
      }
    }
    sim.trucks.push({ k, segs, stops, total: t, pathLen: L, row, carried: 0 });
    total = Math.max(total, t);
  });
  sim.total = total;
}

function truckAt(tr, t) {
  const segs = tr.segs;
  if (!segs.length) return { x: TOWNS[0].x, y: TOWNS[0].y, l: 0 };
  if (t <= 0) return { x: segs[0].x0, y: segs[0].y0, l: 0 };
  if (t >= tr.total) { const s = segs[segs.length - 1]; return { x: s.x1, y: s.y1, l: tr.pathLen }; }
  let lo = 0, hi = segs.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (segs[mid].t0 <= t) lo = mid; else hi = mid - 1; }
  const s = segs[lo], f = s.t1 > s.t0 ? clamp((t - s.t0) / (s.t1 - s.t0), 0, 1) : 1;
  return { x: lerp(s.x0, s.x1, f), y: lerp(s.y0, s.y1, f), l: s.l0 + s.len * f };
}

function rebuildRoutes() {
  gRoutes.innerHTML = '';
  trEls.forEach((el) => el.remove());
  trEls = []; routeEls = [];
  const R = view.cur.rows.length, now = performance.now();
  view.cur.rows.forEach((row, k) => {
    const pts = [];
    for (let i = 0; i < row.path.length - 1; i++) {
      const p = edgePts(row.path[i], row.path[i + 1]);
      for (let j = i ? 1 : 0; j < p.length; j++) pts.push(p[j]);
    }
    const d = pts.map((q, j) => (j ? 'L' : 'M') + q.x.toFixed(2) + ' ' + q.y.toFixed(2)).join(' ');
    const g = document.createElementNS(SVGNS, 'g');
    g.setAttribute('class', 'rt c' + (k % 6));
    const mk = (cls, filter) => {
      const p = document.createElementNS(SVGNS, 'path');
      p.setAttribute('class', cls); p.setAttribute('d', d);
      if (filter) p.setAttribute('filter', 'url(#glow)');
      g.appendChild(p);
      return p;
    };
    const re = { g, p1: null, p2: null, p3: null, off: (k - (R - 1) / 2) * 3.4, draw: REDUCED ? 1 : 0, start: now + k * 180, ready: false };
    mk('u0');
    re.p1 = mk('u1', true);
    re.p2 = mk('u2');
    re.p3 = mk('u3', true);
    gRoutes.appendChild(g);
    routeEls.push(re);

    const tk = document.createElement('div');
    tk.className = 'tk c' + (k % 6);
    tk.innerHTML = '<div class="tk-in">' + (k + 1) + '</div>';
    markersEl.appendChild(tk);
    trEls.push(tk);
  });
}

function setDrain(node, p) {
  const prev = drain[node] || 0;
  if (p === prev) return;
  drain[node] = p;
  paintFill(node);
  if (p >= 1 && prev < 1) {
    if (sim.playing) burst(node);
    if (S.sel === node) showPopup(node, true);
  } else if (p < 1 && prev >= 1 && S.sel === node) showPopup(node, true);
}
function burst(i) {
  const el = mkEls[i];
  el.classList.remove('burst'); void el.offsetWidth; el.classList.add('burst');
  setTimeout(() => el.classList.remove('burst'), 950);
}

function updateClockUI() {
  $('clock').textContent = clock(sim.t);
  const nodes = Object.keys(info), total = nodes.length;
  let done = 0;
  nodes.forEach((n) => { if ((drain[n] || 0) >= 1) done++; });
  $('clockSub').textContent = !total ? 'No towns on today\'s run'
    : sim.t <= 0 ? 'Trucks ready at the yard'
    : sim.t >= sim.total ? 'All trucks back at the yard'
    : done + ' of ' + total + ' towns emptied';
}
function updatePlayIcon() {
  const b = $('play');
  const atEnd = sim.total > 0 && sim.t >= sim.total;
  b.innerHTML = sim.playing ? PAUSE : atEnd ? REPLAY : PLAY;
  b.setAttribute('aria-label', sim.playing ? 'Pause' : atEnd ? 'Replay the day' : 'Play the day');
  b.classList.toggle('idle', !sim.playing && sim.t === 0 && sim.total > 0);
  b.disabled = !sim.total;
  $('scrub').disabled = !sim.total;
}
function setPlaying(on) {
  if (on && sim.t >= sim.total) sim.t = 0;
  sim.playing = !!on && sim.total > 0;
  updatePlayIcon();
}
function applySimState() {
  const t = sim.t;
  sim.trucks.forEach((tr) => {
    let carried = 0;
    tr.stops.forEach((st) => {
      const p = clamp((t - st.arrive) / (st.leave - st.arrive), 0, 1);
      setDrain(st.node, p);
      carried += view.q[st.node] * p;
    });
    tr.carried = carried;
  });
  routeEls.forEach((re) => re.g.classList.toggle('sim', t > 0));
  $('scrub').value = sim.total ? Math.round(t / sim.total * 1000) : 0;
  updateClockUI();
  updateTruckLoads();
}

/* ---------- a new plan from the server ---------- */
function applyPlan(d, rtt) {
  view = d;
  view.cur = d.results[S.algo];
  buildSim();
  drain = {};
  sim.t = 0;
  sim.playing = false;
  rebuildRoutes();
  TOWNS.forEach((t, i) => { if (!t.depot) paintTown(i); });
  renderList(); renderTrucks(); renderCompare(); renderKpis(); renderChips();
  applyFocus();
  applySimState();
  updatePlayIcon();
  if (S.sel >= 0) showPopup(S.sel, true);
  $('dayLbl').textContent = 'Sample day ' + S.seed;
  setStatus('ok', 'C++ ' + d.computeMs.toFixed(2) + ' ms', 'Computed by the C++ backend in ' + d.computeMs.toFixed(3) + ' ms. Round trip ' + Math.round(rtt) + ' ms.');
  dirty = true;
  const summary = 'Day ' + S.seed + ' · ' + d.collected.length + ' of ' + (N - 1) + ' towns · ' + view.cur.trucks + ' trucks · ' + view.cur.km.toFixed(0) + ' km';
  if (firstPlan) {
    firstPlan = false;
    if (!REDUCED) { cam.s = fitS * 1.35; flyTo(fitCenter().x, fitCenter().y, fitS, 1500); }
    setTimeout(() => toast(summary), 900);
    setTimeout(() => {
      if (S.sel >= 0 || userMoved || cw < 560) return;
      let best = -1;
      Object.keys(info).forEach((n) => { if (best < 0 || view.fills[n] > view.fills[best]) best = +n; });
      if (best >= 0) select(best, { fly: false });
    }, 2100);
  } else if (S.lastToast !== summary && S.announce) {
    toast(summary);
  }
  S.announce = false;
  S.lastToast = summary;
}

/* ---------- the animation loop ---------- */
let lastNow = performance.now();
function frame(now) {
  const dt = Math.min(64, now - lastNow);
  lastNow = now;
  stepFly(now);
  if (sim.playing) {
    sim.t += dt / 1000 * SPEEDS[sim.speed];
    if (sim.t >= sim.total) { sim.t = sim.total; sim.playing = false; updatePlayIcon(); }
    applySimState();
  }
  if (dirty) { applyCamera(); dirty = false; }
  renderDynamic(now);
  requestAnimationFrame(frame);
}

function renderDynamic(now) {
  const inv = 1 / cam.s;
  for (let k = 0; k < routeEls.length; k++) {
    const re = routeEls[k], tr = sim.trucks[k];
    if (!re || !tr) continue;
    const L = tr.pathLen;
    if (re.draw < 1) {
      re.draw = clamp((now - re.start) / 1300, 0, 1);
      re.p1.style.strokeDasharray = (L * ease(re.draw)).toFixed(3) + ' ' + (L + 5).toFixed(3);
      if (re.draw >= 1) { re.p1.style.strokeDasharray = ''; re.g.classList.add('ready'); re.ready = true; }
    }
    re.p2.style.strokeDasharray = (7 * inv).toFixed(4) + ' ' + (15 * inv).toFixed(4);
    re.p2.style.strokeDashoffset = REDUCED ? '0' : (-(now / 1000) * 30 * inv).toFixed(4);
    const pos = truckAt(tr, sim.t);
    re.p3.style.strokeDasharray = pos.l.toFixed(3) + ' ' + (L + 5).toFixed(3);
    if (trEls[k]) {
      const sx = (pos.x - vb.x) * cam.s + re.off, sy = (pos.y - vb.y) * cam.s + re.off;
      trEls[k].style.transform = 'translate3d(' + sx.toFixed(1) + 'px,' + sy.toFixed(1) + 'px,0)';
    }
  }
}

/* ---------- events ---------- */
function bindEvents() {
  $('algoSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    S.algo = b.dataset.a;
    syncAlgoPills();
    schedulePlan();
  });
  $('compare').addEventListener('click', (e) => {
    const b = e.target.closest('.cmp-row');
    if (!b) return;
    S.algo = b.dataset.a;
    syncAlgoPills();
    schedulePlan();
  });
  $('thr').addEventListener('input', (e) => { S.thr = +e.target.value; $('thrVal').textContent = S.thr + '%'; schedulePlan(); });
  $('cap').addEventListener('input', (e) => { S.cap = +e.target.value; $('capVal').textContent = S.cap + ' t'; schedulePlan(); });
  $('newDay').addEventListener('click', () => { S.seed++; S.announce = true; $('dayLbl').textContent = 'Sample day ' + S.seed; schedulePlan(); });

  $('search').addEventListener('input', (e) => { S.q = e.target.value; renderList(); });
  $('show').addEventListener('change', (e) => { S.show = e.target.value; renderList(); });
  $('sort').addEventListener('change', (e) => { S.sort = e.target.value; renderList(); });
  $('filtersBtn').addEventListener('click', () => {
    const open = !$('drawer').classList.contains('open');
    $('drawer').classList.toggle('open', open);
    $('drawerIn').inert = !open;
    $('filtersBtn').setAttribute('aria-expanded', open);
  });

  $('tabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) switchTab(b.dataset.tab); });
  $('tabs').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const names = ['towns', 'trucks', 'compare'], at = names.indexOf(S.tab);
    const nx = names[(at + (e.key === 'ArrowRight' ? 1 : 2)) % 3];
    switchTab(nx);
    $('tab-' + nx).focus();
  });

  $('trucks').addEventListener('click', (e) => { const c = e.target.closest('.tcard'); if (c) focusRoute(+c.dataset.k); });
  $('trucks').addEventListener('keydown', (e) => {
    const c = e.target.closest('.tcard');
    if (c && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); focusRoute(+c.dataset.k); }
  });
  $('chips').addEventListener('click', (e) => { const c = e.target.closest('.chip'); if (c) focusRoute(+c.dataset.k); });

  popupEl.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const i = S.sel, act = b.dataset.act;
    if (act === 'close') select(-1);
    else if (act === 'focus' && info[i]) focusRoute(info[i].k);
    else if (act === 'jump' && info[i]) {
      sim.t = Math.max(0, info[i].arrive - 25);
      setPlaying(true);
      applySimState();
    } else if (act === 'include') {
      S.thr = Math.min(S.thr, view.fills[i]);
      $('thr').value = S.thr; $('thrVal').textContent = S.thr + '%';
      S.announce = true;
      schedulePlan();
    }
  });

  $('play').addEventListener('click', () => {
    if (sim.playing) setPlaying(false); else setPlaying(true);
    if (sim.playing) applySimState();
  });
  $('scrub').addEventListener('input', (e) => {
    sim.t = (+e.target.value / 1000) * sim.total;
    sim.playing = false;
    updatePlayIcon();
    applySimState();
  });
  $('speed').addEventListener('click', () => {
    sim.speed = (sim.speed + 1) % SPEEDS.length;
    $('speed').textContent = SPEED_LABEL[sim.speed];
  });

  $('zin').addEventListener('click', () => { userMoved = true; flyTo(cam.x, cam.y, cam.s * 1.6, 320); });
  $('zout').addEventListener('click', () => { userMoved = true; flyTo(cam.x, cam.y, cam.s / 1.6, 320); });
  $('zfit').addEventListener('click', () => { S.focus = -1; applyFocus(); fitAll(800); });
  $('labelsBtn').addEventListener('click', () => {
    const on = !markersEl.classList.contains('labels');
    markersEl.classList.toggle('labels', on);
    $('labelsBtn').setAttribute('aria-pressed', on);
  });
  $('theme').addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('pwr-theme', next); } catch (err) { /* storage can be blocked */ }
    makeTexture();
    dirty = true;
  });
  $('retry').addEventListener('click', () => { clearTimeout(retryTimer); N ? schedulePlan() : boot(); });

  /* pan, pinch and wheel on the map */
  const ptrs = new Map();
  let drag = null, pinchPrev = 0;
  const pinch = () => { const a = [...ptrs.values()]; return { d: Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y) || 1, x: (a[0].x + a[1].x) / 2, y: (a[0].y + a[1].y) / 2 }; };
  mapwrap.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.mk, .popup, .tools, .dock, .truck-chips, .offline, .toast')) return;
    mapwrap.setPointerCapture(e.pointerId);
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    drag = drag || { x: e.clientX, y: e.clientY, moved: false };
    flyAnim = null;
    mapwrap.classList.add('drag');
    if (ptrs.size === 2) pinchPrev = pinch().d;
  });
  mapwrap.addEventListener('pointermove', (e) => {
    const p = ptrs.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (ptrs.size === 1) {
      cam.x -= dx / cam.s; cam.y -= dy / cam.s;
      clampCam(); dirty = true; userMoved = true;
      if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 4) drag.moved = true;
    } else if (ptrs.size === 2) {
      const pc = pinch(), r = mapwrap.getBoundingClientRect();
      zoomAt(pc.x - r.left, pc.y - r.top, pc.d / pinchPrev);
      pinchPrev = pc.d; userMoved = true; drag.moved = true;
    }
  });
  const end = (e) => {
    if (!ptrs.has(e.pointerId)) return;
    ptrs.delete(e.pointerId);
    if (!ptrs.size) {
      mapwrap.classList.remove('drag');
      if (drag && !drag.moved && e.type === 'pointerup') select(-1);
      drag = null;
    }
  };
  mapwrap.addEventListener('pointerup', end);
  mapwrap.addEventListener('pointercancel', end);
  mapwrap.addEventListener('wheel', (e) => {
    if (e.target.closest('.popup, .dock')) return;
    e.preventDefault();
    const r = mapwrap.getBoundingClientRect();
    zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0016));
    userMoved = true;
  }, { passive: false });
  mapwrap.addEventListener('dblclick', (e) => {
    if (e.target.closest('.mk, .popup, .tools, .dock, .truck-chips')) return;
    const r = mapwrap.getBoundingClientRect();
    const wx = cam.x + (e.clientX - r.left - cw / 2) / cam.s, wy = cam.y + (e.clientY - r.top - ch / 2) / cam.s;
    userMoved = true;
    flyTo(wx, wy, cam.s * 1.8, 500);
  });

  document.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase(), typing = tag === 'input' || tag === 'select' || tag === 'textarea';
    if (e.key === '/' && !typing) { e.preventDefault(); $('search').focus(); }
    else if (e.key === 'Escape') {
      if (typing) e.target.blur();
      else if (S.focus >= 0) { S.focus = -1; applyFocus(); fitAll(700); }
      else select(-1);
    } else if (e.key === ' ' && !typing && tag !== 'button' && !e.target.closest('[role="button"]')) {
      e.preventDefault();
      $('play').click();
    }
  });

  if (window.ResizeObserver) {
    new ResizeObserver(() => {
      measure();
      if (!userMoved && N) { const c = fitCenter(); cam.x = c.x; cam.y = c.y; cam.s = fitS; }
      dirty = true;
      placeInk();
    }).observe(mapwrap);
  }
  window.addEventListener('resize', placeInk);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(placeInk);
}

function syncAlgoPills() {
  document.querySelectorAll('#algoSeg button').forEach((b) => b.setAttribute('aria-pressed', b.dataset.a === S.algo));
}

/* ---------- boot ---------- */
function boot() {
  getJSON('/api/towns').then((d) => {
    TOWNS = d.towns; EDGES = d.edges; ALGOS = d.algos;
    CONST = Object.assign(CONST, d.constants || {});
    N = TOWNS.length;
    TOWNS.forEach((t, i) => { t.id = i; });
    setupWorld(); buildEdges(); buildRoads();
    measure();
    const c = fitCenter();
    cam.x = c.x; cam.y = c.y; cam.s = fitS;
    makeTexture();
    buildMarkers(); buildItems();
    $('algoSeg').innerHTML = ALGOS.map((a) => '<button type="button" data-a="' + a.id + '" aria-pressed="false">' + esc(a.name) + '</button>').join('');
    syncAlgoPills();
    $('speed').textContent = SPEED_LABEL[sim.speed];
    updatePlayIcon();
    dirty = true;
    schedulePlan();
  }).catch(onError);
}

bindEvents();
placeInk();
requestAnimationFrame(frame);
boot();
})();
