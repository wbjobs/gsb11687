import assert from 'node:assert/strict';
import { parsePath, tokenize } from '../js/pathParser.js';
import { flattenPath, pointAtLength, pointAtT, clipByLength, resample, lerpPoints, arcToCenter, pointsToPathD } from '../js/pathGeometry.js';

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('✓', name); }
  catch (e) { console.error('✗', name, '\n ', e.message); process.exitCode = 1; }
}
const near = (a, b, eps = 0.5) => Math.abs(a - b) <= eps;
const flat = (d, tol) => { const { segments, errors } = parsePath(d); return { flat: flattenPath(segments, tol), errors, segments }; };

// ---- 解析 ----
test('解析 M/L 绝对指令', () => {
  const { segments, errors } = parsePath('M10 20 L30 40');
  assert.equal(errors.length, 0);
  assert.deepEqual(segments.map(s => s.cmd), ['M', 'L']);
  assert.equal(segments[1].x, 30);
});

test('相对指令 h/v 转换为绝对 L', () => {
  const { segments, errors } = parsePath('M100 100 h600 v400 h-600 Z');
  assert.equal(errors.length, 0);
  assert.equal(segments[1].x, 700); assert.equal(segments[1].y, 100);
  assert.equal(segments[2].x, 700); assert.equal(segments[2].y, 500);
  assert.equal(segments[3].x, 100); assert.equal(segments[3].y, 500);
  assert.equal(segments[4].cmd, 'Z');
});

test('隐式重复指令（M 后多组坐标视为 L）', () => {
  const { segments, errors } = parsePath('M0 0 10 10 20 0');
  assert.equal(errors.length, 0);
  assert.deepEqual(segments.map(s => s.cmd), ['M', 'L', 'L']);
});

test('S/T 反射控制点', () => {
  const { segments } = parsePath('M0 0 C0 0 40 0 40 0 S80 0 80 0');
  assert.equal(segments[2].x1, 40); // 反射前一个 x2=40 关于当前点(40,0) -> 40
  const q = parsePath('M0 0 Q10 10 20 0 T40 0').segments;
  assert.equal(q[2].x1, 30); // 反射 (10,10) 关于 (20,0) -> (30,-10)
  assert.equal(q[2].y1, -10);
});

test('语法错误：未知指令有提示且不中断', () => {
  const { errors, segments } = parsePath('M0 0 X10 10 L20 20');
  assert.ok(errors.some(e => e.message.includes('未知指令')));
  assert.ok(segments.length >= 2); // 继续解析
});

test('语法错误：参数不足', () => {
  const { errors } = parsePath('M0 0 C10 10');
  assert.ok(errors.some(e => e.message.includes('参数不足')));
});

test('语法错误：路径必须以 M 开始', () => {
  const { errors } = parsePath('L10 10');
  assert.ok(errors.some(e => e.message.includes('M')));
});

test('语法错误：空路径', () => {
  const { errors } = parsePath('');
  assert.ok(errors.length > 0);
});

test('错误带位置信息', () => {
  const { errors } = parsePath('M0 0 X');
  assert.ok(typeof errors[0].pos === 'number');
});

// ---- 长度 ----
test('直线长度', () => {
  const { flat: f } = flat('M0 0 L100 0');
  assert.ok(near(f.totalLength, 100, 0.01));
});

test('闭合矩形长度（Z 闭合）', () => {
  const { flat: f } = flat('M0 0 h100 v100 h-100 Z');
  assert.ok(near(f.totalLength, 400, 0.01));
});

test('整圆（两段弧）长度 ≈ 2πr', () => {
  const { flat: f } = flat('M-100 0 A100 100 0 1 1 100 0 A100 100 0 1 1 -100 0 Z');
  assert.ok(near(f.totalLength, 2 * Math.PI * 100, 1));
});

test('弧线半径不足自动放大（规范 F.6.5）', () => {
  // 端点距离 100，半径 10 太小 -> 放大到 50，半圆弧长 π*50
  const { flat: f, errors } = flat('M0 0 A10 10 0 0 1 100 0');
  assert.equal(errors.length, 0);
  assert.ok(near(f.totalLength, Math.PI * 50, 1));
});

test('弧线终点精确落在指定端点', () => {
  const { flat: f } = flat('M0 0 A80 60 30 0 1 150 90');
  const last = f.points[f.points.length - 1];
  assert.ok(near(last.x, 150, 0.01) && near(last.y, 90, 0.01));
});

test('半径为 0 的弧退化为直线', () => {
  const { segments } = parsePath('M0 0 A0 0 0 0 1 50 0');
  assert.equal(segments[1].cmd, 'L');
});

// ---- 切线 / 法线 ----
test('直线中点位置、切线、法线', () => {
  const { flat: f } = flat('M0 0 L100 0');
  const p = pointAtLength(f, 50);
  assert.ok(near(p.x, 50, 0.01) && near(p.y, 0, 0.01));
  assert.ok(near(p.tx, 1, 1e-6) && near(p.ty, 0, 1e-6));
  assert.ok(near(p.nx, 0, 1e-6) && near(p.ny, 1, 1e-6));
});

test('切线为单位向量（曲线路径）', () => {
  const { flat: f } = flat('M0 0 C100 0 100 100 200 100 A50 50 0 0 1 300 100');
  for (const t of [0.1, 0.35, 0.6, 0.85, 0.99]) {
    const p = pointAtT(f, t);
    assert.ok(near(Math.hypot(p.tx, p.ty), 1, 1e-6), `t=${t}`);
    // 法线垂直于切线
    assert.ok(near(p.tx * p.nx + p.ty * p.ny, 0, 1e-6), `t=${t} 垂直`);
  }
});

test('pointAtLength 边界（0 和总长）', () => {
  const { flat: f } = flat('M10 10 L110 10');
  const a = pointAtLength(f, 0);
  const b = pointAtLength(f, f.totalLength);
  assert.ok(near(a.x, 10) && near(b.x, 110));
  const c = pointAtLength(f, 99999); // 超出不崩溃
  assert.ok(near(c.x, 110));
});

// ---- 裁剪 ----
test('按弧长裁剪直线', () => {
  const { flat: f } = flat('M0 0 L100 0');
  const pts = clipByLength(f, 25, 75);
  assert.ok(near(pts[0].x, 25) && near(pts[pts.length - 1].x, 75));
});

test('裁剪区间交换/越界不崩溃', () => {
  const { flat: f } = flat('M0 0 L100 0');
  const pts = clipByLength(f, 200, -50);
  assert.ok(pts.length >= 2);
});

// ---- 变形 ----
test('重采样点等距', () => {
  const { flat: f } = flat('M0 0 C100 0 100 100 200 100');
  const pts = resample(f, 32);
  assert.equal(pts.length, 32);
  const d0 = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
  const d1 = Math.hypot(pts[16].x - pts[15].x, pts[16].y - pts[15].y);
  assert.ok(near(d0, d1, d0 * 0.3));
});

test('插值端点正确', () => {
  const a = resample(flat('M0 0 L100 0').flat, 8);
  const b = resample(flat('M0 100 L100 100').flat, 8);
  const mid = lerpPoints(a, b, 0.5);
  assert.ok(near(mid[0].y, 50) && near(mid[7].y, 50));
  assert.deepEqual(lerpPoints(a, b, 0), a);
});

// ---- 性能 ----
test('长路径（2000 段曲线）扁平化 < 500ms', () => {
  const parts = ['M0 300'];
  let x = 0, seed = 42;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < 2000; i++) {
    const nx = x + 20 + rnd() * 30, ny = 100 + rnd() * 400;
    parts.push(`C${x + 10} ${ny} ${nx - 10} ${ny} ${nx.toFixed(1)} ${ny.toFixed(1)}`);
    x = nx;
  }
  const t0 = performance.now();
  const { flat: f } = flat(parts.join(' '));
  const ms = performance.now() - t0;
  assert.ok(f.totalLength > 0);
  assert.ok(ms < 500, `耗时 ${ms.toFixed(0)}ms`);
  console.log(`  (${f.points.length} 点, ${ms.toFixed(1)}ms)`);
});

test('降级容差下采样点显著减少', () => {
  const d = 'M0 0 C100 0 100 100 200 100 S400 200 500 100 A80 80 0 0 1 700 100';
  const fine = flat(d, 0.25).flat;
  const coarse = flat(d, 2.5).flat;
  assert.ok(coarse.points.length < fine.points.length * 0.6,
    `${coarse.points.length} vs ${fine.points.length}`);
});

test('pointsToPathD 输出可再解析', () => {
  const { flat: f } = flat('M0 0 L50 50 L100 0');
  const d = pointsToPathD(f.points);
  const { errors } = parsePath(d);
  assert.equal(errors.length, 0);
});

console.log(`\n${passed} 项通过`);
