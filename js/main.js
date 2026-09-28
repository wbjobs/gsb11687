import { parsePath, serializeSegments } from './pathParser.js';
import { MeasuredPath, flattenSegments, clipPathByLength, resample, morphPaths } from './pathGeometry.js';
import { Animator, QUALITY_LEVELS } from './animator.js';
import { savePreset, loadPreset, listPresets, deletePreset } from './storage.js';

const $ = (id) => document.getElementById(id);
const canvas = $('stage');
const ctx = canvas.getContext('2d');

const state = {
  segments: [],
  errors: [],
  measured: null,        // MeasuredPath（可能被裁剪）
  fullMeasured: null,    // 未裁剪的完整路径
  pointCount: 0,
  truncated: false,
  playing: false,
  morphSamplesA: null,
  morphSamplesB: null,
  morphT: 0,
  clipStart: 0,
  clipEnd: 1,            // 比例
  showControls: true,
  showNormal: true,
  dragHandle: null,
  worker: null,
  workerReqId: 0,
  pendingWorker: new Map(),
  useWorker: true,
};

// ---------- Worker ----------
function getWorker() {
  if (!state.worker) {
    state.worker = new Worker('./js/pathWorker.js', { type: 'module' });
    state.worker.onmessage = (e) => {
      const { id } = e.data;
      const resolve = state.pendingWorker.get(id);
      if (resolve) { state.pendingWorker.delete(id); resolve(e.data); }
    };
    state.worker.onerror = () => {
      // Worker 失败：全部待处理请求回退主线程
      state.useWorker = false;
      for (const [, resolve] of state.pendingWorker) resolve(null);
      state.pendingWorker.clear();
    };
  }
  return state.worker;
}

function flattenAsync(d, tolerance, maxPoints) {
  if (!state.useWorker) return Promise.resolve(flattenMain(d, tolerance, maxPoints));
  const id = ++state.workerReqId;
  return new Promise((resolve) => {
    state.pendingWorker.set(id, (msg) => {
      if (!msg) return resolve(flattenMain(d, tolerance, maxPoints));
      resolve(msg.ok ? msg : flattenMain(d, tolerance, maxPoints));
    });
    getWorker().postMessage({ id, d, tolerance, maxPoints });
  });
}

function flattenMain(d, tolerance, maxPoints) {
  const { segments, errors } = parsePath(d);
  const flat = flattenSegments(segments, tolerance, maxPoints);
  return { ok: true, ...flat, errors, pointCount: flat.points.length / 2 };
}

// ---------- 路径更新 ----------
async function rebuild() {
  const d = $('pathInput').value;
  const { segments, errors } = parsePath(d);
  state.segments = segments;
  state.errors = errors;
  renderErrors(errors);

  const q = QUALITY_LEVELS[animator.qualityLevel];
  const result = await flattenAsync(d, q.tolerance, q.maxPoints);
  if (!result) return;
  state.fullMeasured = new MeasuredPath(result);
  state.pointCount = result.pointCount;
  state.truncated = !!result.truncated;
  applyClip();
  prepareMorph();
  updateHud();
}

function applyClip() {
  const fm = state.fullMeasured;
  if (!fm) return;
  const s = state.clipStart * fm.total;
  const e = state.clipEnd * fm.total;
  if (state.clipStart <= 0 && state.clipEnd >= 1) {
    state.measured = fm;
    $('clipOutput').value = '';
    return;
  }
  const clipD = clipPathByLength(fm, s, e);
  $('clipOutput').value = clipD;
  const { segments } = parsePath(clipD);
  state.measured = new MeasuredPath(flattenSegments(segments, 0.5));
}

function prepareMorph() {
  const d2 = $('morphInput').value.trim();
  state.morphSamplesA = null;
  state.morphSamplesB = null;
  if (!d2 || !state.fullMeasured) return;
  const { segments, errors } = parsePath(d2);
  if (errors.length || !segments.length) return;
  const N = 400;
  const mb = new MeasuredPath(flattenSegments(segments, 0.5));
  state.morphSamplesA = resample(state.fullMeasured, N);
  state.morphSamplesB = resample(mb, N);
}

// ---------- 渲染 ----------
function draw() {
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.save();
  ctx.translate(20, 20);

  const m = state.measured;
  if (m && m.lengths.length > 1) {
    // 路径本体
    ctx.beginPath();
    const pts = m.points;
    ctx.moveTo(pts[0], pts[1]);
    for (let k = 1; k < pts.length / 2; k++) ctx.lineTo(pts[2 * k], pts[2 * k + 1]);
    ctx.strokeStyle = state.truncated ? '#e67e22' : '#2c7be5';
    ctx.lineWidth = 2;
    ctx.stroke();

    // 变形预览
    if (state.morphSamplesA && state.morphT > 0) {
      const d = morphPaths(state.morphSamplesA, state.morphSamplesB, state.morphT);
      const { segments } = parsePath(d);
      const mm = new MeasuredPath(flattenSegments(segments, 1));
      ctx.beginPath();
      ctx.moveTo(mm.points[0], mm.points[1]);
      for (let k = 1; k < mm.points.length / 2; k++) ctx.lineTo(mm.points[2 * k], mm.points[2 * k + 1]);
      ctx.strokeStyle = 'rgba(155, 89, 182, 0.8)';
      ctx.setLineDash([6, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  if (state.showControls) drawControlPoints();
  ctx.restore();
}

function drawControlPoints() {
  ctx.font = '10px sans-serif';
  for (const s of state.segments) {
    if (s.type === 'Z') continue;
    if (s.type === 'C' || s.type === 'Q') {
      ctx.strokeStyle = '#bbb';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(s.start.x, s.start.y); ctx.lineTo(s.x1, s.y1);
      if (s.type === 'C') { ctx.moveTo(s.x, s.y); ctx.lineTo(s.x2, s.y2); }
      ctx.stroke();
      handle(s.x1, s.y1, '#e74c3c');
      if (s.type === 'C') handle(s.x2, s.y2, '#e74c3c');
    }
    handle(s.x, s.y, '#27ae60');
  }
}

function handle(x, y, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, 4, 0, Math.PI * 2);
  ctx.fill();
}

// 运动物体 + 切线/法线
function drawMover(distance) {
  const m = state.measured;
  if (!m || m.total === 0) return;
  const len = distance % m.total;
  const p = m.pointAtLength(len);
  const t = m.tangentAtLength(len);
  const n = m.normalAtLength(len);
  ctx.save();
  ctx.translate(20, 20);
  // 法线
  if (state.showNormal) {
    ctx.strokeStyle = '#f39c12';
    ctx.beginPath();
    ctx.moveTo(p.x - n.x * 20, p.y - n.y * 20);
    ctx.lineTo(p.x + n.x * 20, p.y + n.y * 20);
    ctx.stroke();
  }
  // 切线
  ctx.strokeStyle = '#8e44ad';
  ctx.beginPath();
  ctx.moveTo(p.x, p.y);
  ctx.lineTo(p.x + t.x * 30, p.y + t.y * 30);
  ctx.stroke();
  // 朝向切线的三角形
  ctx.translate(p.x, p.y);
  ctx.rotate(Math.atan2(t.y, t.x));
  ctx.fillStyle = '#e74c3c';
  ctx.beginPath();
  ctx.moveTo(10, 0); ctx.lineTo(-7, 6); ctx.lineTo(-7, -6);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

// ---------- 控制点拖拽 ----------
function collectHandles() {
  const list = [];
  state.segments.forEach((s, si) => {
    if (s.type === 'Z' || s.type === 'M') return;
    if (s.type === 'C') {
      list.push({ si, key: 'x1', keyY: 'y1', x: s.x1, y: s.y1 });
      list.push({ si, key: 'x2', keyY: 'y2', x: s.x2, y: s.y2 });
    } else if (s.type === 'Q') {
      list.push({ si, key: 'x1', keyY: 'y1', x: s.x1, y: s.y1 });
    }
    list.push({ si, key: 'x', keyY: 'y', x: s.x, y: s.y });
  });
  return list;
}

canvas.addEventListener('pointerdown', (e) => {
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left - 20, my = e.clientY - rect.top - 20;
  for (const h of collectHandles()) {
    if (Math.hypot(h.x - mx, h.y - my) < 8) {
      state.dragHandle = h;
      canvas.setPointerCapture(e.pointerId);
      return;
    }
  }
});
canvas.addEventListener('pointermove', (e) => {
  if (!state.dragHandle) return;
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left - 20, my = e.clientY - rect.top - 20;
  const s = state.segments[state.dragHandle.si];
  s[state.dragHandle.key] = Math.round(mx * 10) / 10;
  s[state.dragHandle.keyY] = Math.round(my * 10) / 10;
  $('pathInput').value = serializeSegments(state.segments, 1);
  scheduleRebuild();
});
canvas.addEventListener('pointerup', () => { state.dragHandle = null; });

// ---------- 动画 ----------
const animator = new Animator({
  onFrame(distance) {
    draw();
    drawMover(distance);
    updateHud();
  },
  onQualityChange(level, q) {
    $('quality').textContent = `${q.name}${animator.autoDegrade ? '（自动降级）' : ''}`;
    rebuild();
  },
});

let rebuildTimer = null;
function scheduleRebuild() {
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(rebuild, 150);
}

// ---------- HUD / 错误 ----------
function renderErrors(errors) {
  const box = $('errors');
  if (!errors.length) { box.textContent = '✓ 路径语法正确'; box.className = 'ok'; return; }
  box.className = 'err';
  box.innerHTML = errors.map((e) => `⚠ 位置 ${e.index}: ${e.message}`).join('<br>');
}

let frames = 0, fpsTimer = performance.now(), fps = 0;
function updateHud() {
  frames++;
  const now = performance.now();
  if (now - fpsTimer > 500) {
    fps = Math.round((frames * 1000) / (now - fpsTimer));
    frames = 0; fpsTimer = now;
  }
  const m = state.measured;
  $('hud').textContent =
    `FPS ${fps} | 帧耗 ${animator.avgFrameCost.toFixed(1)}ms | longtask ${animator.longTaskCount}` +
    ` | 采样点 ${state.pointCount}${state.truncated ? '（已截断）' : ''}` +
    ` | 路径长 ${m ? m.total.toFixed(1) : '-'}`;
}

// ---------- 事件绑定 ----------
$('pathInput').addEventListener('input', scheduleRebuild);
$('morphInput').addEventListener('input', () => { prepareMorph(); });
$('morphSlider').addEventListener('input', (e) => {
  state.morphT = e.target.value / 100;
  if (!animator.playing) { draw(); }
});
$('clipStart').addEventListener('input', (e) => { state.clipStart = e.target.value / 100; applyClip(); if (!animator.playing) draw(); });
$('clipEnd').addEventListener('input', (e) => { state.clipEnd = e.target.value / 100; applyClip(); if (!animator.playing) draw(); });
$('showControls').addEventListener('change', (e) => { state.showControls = e.target.checked; if (!animator.playing) draw(); });
$('showNormal').addEventListener('change', (e) => { state.showNormal = e.target.checked; });
$('autoDegrade').addEventListener('change', (e) => { animator.autoDegrade = e.target.checked; });
$('qualitySelect').addEventListener('change', (e) => { animator.autoDegrade = false; $('autoDegrade').checked = false; animator.setQuality(+e.target.value); });
$('speed').addEventListener('input', (e) => { animator.speed = +e.target.value; });

$('playBtn').addEventListener('click', () => {
  if (animator.playing) {
    animator.stop();
    $('playBtn').textContent = '▶ 播放';
  } else {
    animator.start();
    $('playBtn').textContent = '⏸ 暂停';
  }
});

// IndexedDB 预设
async function refreshPresets() {
  const list = await listPresets();
  $('presetList').innerHTML = list.map((p) => `<option value="${p.name}">`).join('');
}
$('savePreset').addEventListener('click', async () => {
  const name = $('presetName').value.trim();
  if (!name) return;
  await savePreset(name, $('pathInput').value);
  await refreshPresets();
});
$('loadPreset').addEventListener('click', async () => {
  const name = $('presetName').value.trim();
  const p = await loadPreset(name);
  if (p) { $('pathInput').value = p.d; rebuild(); }
});
$('deletePreset').addEventListener('click', async () => {
  const name = $('presetName').value.trim();
  if (name) { await deletePreset(name); await refreshPresets(); }
});

// 生成长路径（压力测试）
$('genLong').addEventListener('click', () => {
  let d = 'M10 200';
  for (let k = 0; k < 3000; k++) {
    const x = 10 + k * 0.5, y = 200 + Math.sin(k * 0.05) * 120;
    d += `C${x} ${y} ${x + 0.2} ${y + 30} ${x + 0.5} ${200 + Math.sin((k + 1) * 0.05) * 120}`;
  }
  $('pathInput').value = d;
  rebuild();
});

// ---------- 初始化 ----------
$('pathInput').value = 'M40 200 C120 60 240 340 320 200 S480 60 560 200 A60 60 0 0 1 680 200 Q720 260 760 200 Z';
$('morphInput').value = 'M40 200 C120 340 240 60 320 200 S480 340 560 200 A60 60 0 0 0 680 200 Q720 140 760 200 Z';
rebuild();
refreshPresets();
draw();
