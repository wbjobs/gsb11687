import { PerfMonitor } from './perfMonitor.js';
import { savePath, listPaths, deletePath } from './storage.js';
import { parsePath } from './pathParser.js';
import { flattenPath, pointAtLength, pointAtT, clipByLength, resample, lerpPoints, pointsToPathD } from './pathGeometry.js';

const W = 800, H = 600;
const $ = (id) => document.getElementById(id);

const svgPath = $('svgPath');
const svgClipPath = $('svgClipPath');
const canvas = $('overlay');
const ctx = canvas.getContext('2d');
const mover = $('mover');

const state = {
  d: $('pathInput').value,
  segments: [],
  errors: [],
  flat: { points: [], cumLen: [], totalLength: 0 },
  playing: false,
  t: 0,                 // 归一化进度 0..1
  speed: 0.12,          // 每秒进度
  showCtrl: true,
  showTN: true,
  degraded: false,
  clipStart: 0,         // 归一化 0..1
  clipEnd: 1,
  morph: null,          // { from: pts, to: pts, start, duration }
  morphPts: null,
};

// ---------- Worker（长路径离线程计算） ----------
let worker = null;
let reqId = 0;
const pending = new Map();
try {
  worker = new Worker('js/pathWorker.js', { type: 'module' });
  worker.onmessage = (e) => {
    const entry = pending.get(e.data.id);
    pending.delete(e.data.id);
    entry && entry.resolve(e.data);
  };
  worker.onerror = () => {
    worker = null;
    // Worker 失败：所有挂起请求回退到主线程计算
    for (const [id, entry] of pending) {
      pending.delete(id);
      entry.resolve(computeSync(entry.msg.d, entry.msg.tolerance));
    }
  };
} catch (_) { worker = null; }

function computeSync(d, tolerance) {
  const { segments, errors } = parsePath(d);
  const flat = flattenPath(segments, tolerance);
  return { segments, errors, ...flat };
}

function computeAsync(d, tolerance) {
  return new Promise((resolve) => {
    if (worker) {
      const id = ++reqId;
      const msg = { id, d, tolerance };
      pending.set(id, { resolve, msg });
      worker.postMessage(msg);
    } else {
      resolve(computeSync(d, tolerance));
    }
  });
}

// ---------- 解析与渲染 ----------
let parseTimer = 0;
function scheduleParse() {
  clearTimeout(parseTimer);
  parseTimer = setTimeout(runParse, 200);
}

async function runParse() {
  const tolerance = state.degraded ? 2.5 : 0.25; // 降级：放大容差 -> 直线近似
  const result = await computeAsync(state.d, tolerance);
  if (state.d !== $('pathInput').value) return; // 过期结果
  state.segments = result.segments || [];
  state.errors = result.errors || [];
  state.flat = { points: result.points || [], cumLen: result.cumLen || [], totalLength: result.totalLength || 0 };
  renderErrors();
  renderSvg();
  updateInfo();
}

function renderErrors() {
  const box = $('errors');
  if (!state.errors.length) {
    box.textContent = '✓ 路径语法正确';
    box.className = 'ok';
    return;
  }
  box.className = 'bad';
  box.innerHTML = state.errors.slice(0, 8)
    .map(e => `<div>⚠ 位置 ${e.pos}: ${escapeHtml(e.message)}</div>`).join('');
}

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function renderSvg() {
  svgPath.setAttribute('d', state.errors.length && !state.segments.length ? '' : state.d);
  // 裁剪预览（折线近似回显）
  const clipped = clipByLength(state.flat, state.clipStart * state.flat.totalLength, state.clipEnd * state.flat.totalLength);
  svgClipPath.setAttribute('d', pointsToPathD(clipped));
}

function updateInfo() {
  $('info').textContent =
    `长度: ${state.flat.totalLength.toFixed(2)}  采样点: ${state.flat.points.length}  ` +
    `FPS: ${perf.fps}  长任务: ${perf.longTasks}  模式: ${state.degraded ? '降级(直线近似)' : '精确'}`;
}

// ---------- Canvas 叠加层：控制点 / 切线 / 法线 / 裁剪端点 ----------
function drawOverlay() {
  ctx.clearRect(0, 0, W, H);

  // 变形结果
  if (state.morphPts) {
    ctx.strokeStyle = '#e040fb';
    ctx.lineWidth = 2;
    ctx.beginPath();
    state.morphPts.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
    ctx.stroke();
  }

  if (state.showCtrl) drawControlPoints();
  if (state.showTN && state.flat.totalLength > 0) drawTangentNormal();
  drawClipHandles();
}

function drawControlPoints() {
  ctx.lineWidth = 1;
  for (const seg of state.segments) {
    if (seg.cmd === 'C') {
      ctrlLine(seg.from, seg, 'x1', 'y1');
      ctrlLine(seg, seg, 'x2', 'y2', true);
      dot(seg.x1, seg.y1, '#ff9800');
      dot(seg.x2, seg.y2, '#ff9800');
      dot(seg.x, seg.y, '#f44336');
    } else if (seg.cmd === 'Q') {
      ctrlLine(seg.from, seg, 'x1', 'y1');
      ctrlLine({ x: seg.x, y: seg.y }, seg, 'x1', 'y1');
      dot(seg.x1, seg.y1, '#ff9800');
      dot(seg.x, seg.y, '#f44336');
    } else if (seg.cmd === 'A') {
      dot(seg.x, seg.y, '#f44336');
    } else if (seg.cmd === 'L' || seg.cmd === 'M' || seg.cmd === 'Z') {
      dot(seg.x, seg.y, '#f44336');
    }
  }
}

function ctrlLine(a, seg, kx, ky, toEnd) {
  ctx.strokeStyle = 'rgba(255,152,0,.6)';
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(seg[kx], seg[ky]);
  ctx.stroke();
}

function dot(x, y, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, 3.5, 0, Math.PI * 2);
  ctx.fill();
}

function drawTangentNormal() {
  const p = pointAtT(state.flat, state.t);
  ctx.strokeStyle = '#2196f3';
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x + p.tx * 40, p.y + p.ty * 40); ctx.stroke();
  ctx.strokeStyle = '#4caf50';
  ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x + p.nx * 40, p.y + p.ny * 40); ctx.stroke();
}

function drawClipHandles() {
  if (!state.flat.totalLength) return;
  const a = pointAtT(state.flat, state.clipStart);
  const b = pointAtT(state.flat, state.clipEnd);
  ctx.fillStyle = '#9c27b0';
  ctx.beginPath(); ctx.arc(a.x, a.y, 5, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(b.x, b.y, 5, 0, Math.PI * 2); ctx.fill();
}

// ---------- 动画循环 ----------
const perf = new PerfMonitor({
  onDegrade: () => { state.degraded = true; runParse(); },
  onRecover: () => { state.degraded = false; runParse(); },
});

let lastTime = 0;
function frame(now) {
  perf.tick(now);
  const dt = lastTime ? (now - lastTime) / 1000 : 0;
  lastTime = now;

  if (state.playing && state.flat.totalLength > 0) {
    state.t = (state.t + state.speed * dt) % 1;
  }
  // 沿路径运动：切线决定朝向
  if (state.flat.totalLength > 0) {
    const p = pointAtT(state.flat, state.t);
    const angle = Math.atan2(p.ty, p.tx) * 180 / Math.PI;
    mover.setAttribute('transform', `translate(${p.x} ${p.y}) rotate(${angle})`);
  }
  // 路径变形插值
  if (state.morph) {
    const k = Math.min(1, (now - state.morph.start) / state.morph.duration);
    const eased = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
    state.morphPts = lerpPoints(state.morph.from, state.morph.to, eased);
    if (k >= 1) state.morph = null;
  }
  drawOverlay();
  if ((frame.n = (frame.n || 0) + 1) % 30 === 0) updateInfo();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---------- 交互 ----------
$('pathInput').addEventListener('input', () => { state.d = $('pathInput').value; scheduleParse(); });
$('playBtn').addEventListener('click', () => {
  state.playing = !state.playing;
  $('playBtn').textContent = state.playing ? '暂停' : '播放';
});
$('speed').addEventListener('input', (e) => { state.speed = parseFloat(e.target.value); });
$('progress').addEventListener('input', (e) => { state.t = parseFloat(e.target.value); });
$('showCtrl').addEventListener('change', (e) => { state.showCtrl = e.target.checked; });
$('showTN').addEventListener('change', (e) => { state.showTN = e.target.checked; });
$('clipStart').addEventListener('input', (e) => { state.clipStart = parseFloat(e.target.value); renderSvg(); });
$('clipEnd').addEventListener('input', (e) => { state.clipEnd = parseFloat(e.target.value); renderSvg(); });
$('degradeBtn').addEventListener('click', () => { state.degraded = !state.degraded; runParse(); });

$('morphBtn').addEventListener('click', async () => {
  const targetD = $('morphInput').value;
  const N = state.degraded ? 64 : 256;
  const target = await computeAsync(targetD, state.degraded ? 2.5 : 0.25);
  if (!target.points || target.points.length < 2) { alert('目标路径无效'); return; }
  const targetFlat = { points: target.points, cumLen: target.cumLen, totalLength: target.totalLength };
  state.morph = {
    from: resample(state.flat, N),
    to: resample(targetFlat, N),
    start: performance.now(),
    duration: 1500,
  };
});

// ---------- IndexedDB ----------
$('saveBtn').addEventListener('click', async () => {
  await savePath({ name: $('pathName').value || '未命名', d: state.d });
  refreshList();
});
async function refreshList() {
  const items = await listPaths();
  $('savedList').innerHTML = items.map(it =>
    `<li><a href="#" data-id="${it.id}" data-d="${escapeHtml(it.d)}">${escapeHtml(it.name)}</a>
     <button data-del="${it.id}">删</button></li>`).join('');
}
$('savedList').addEventListener('click', async (e) => {
  if (e.target.dataset.del) { await deletePath(Number(e.target.dataset.del)); refreshList(); }
  else if (e.target.dataset.d) {
    e.preventDefault();
    $('pathInput').value = e.target.dataset.d;
    state.d = e.target.dataset.d;
    runParse();
  }
});
refreshList();
runParse();
