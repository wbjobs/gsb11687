import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePath, serializeSegments } from '../js/pathParser.js';
import {
  flattenSegments, MeasuredPath, arcToCenter,
  clipPathByLength, resample, morphPaths,
} from '../js/pathGeometry.js';

const measure = (d, tol = 0.1) => {
  const { segments, errors } = parsePath(d);
  assert.deepEqual(errors, []);
  return new MeasuredPath(flattenSegments(segments, tol));
};

test('解析：基本指令 M/L/H/V/C/S/Q/T/A/Z', () => {
  const { segments, errors } = parsePath('M10 10 h20 v20 l-5 5 C0 0 1 1 2 2 S3 3 4 4 Q5 5 6 6 T7 7 A1 1 0 0 1 9 9 Z');
  assert.equal(errors.length, 0);
  const types = segments.map((s) => s.type);
  assert.deepEqual(types, ['M', 'L', 'L', 'L', 'C', 'C', 'Q', 'Q', 'A', 'Z']);
});

test('解析：相对指令与隐式 L（M 后跟多组坐标）', () => {
  const { segments, errors } = parsePath('m10 10 20 0 20 0');
  assert.equal(errors.length, 0);
  assert.equal(segments.length, 3);
  assert.equal(segments[2].x, 50);
  assert.equal(segments[2].y, 10);
});

test('解析：S/T 反射控制点', () => {
  const { segments } = parsePath('M0 0 C0 0 10 0 10 10 S20 20 20 30');
  const s = segments[2]; // S 转成的 C
  assert.equal(s.x1, 10); // 2*10-10
  assert.equal(s.y1, 20); // 2*10-0
});

test('长度：直线与矩形闭合路径', () => {
  assert.equal(measure('M0 0 L100 0').total, 100);
  const rect = measure('M0 0 L100 0 L100 50 L0 50 Z');
  assert.ok(Math.abs(rect.total - 300) < 1e-6);
});

test('长度：三次贝塞尔与二次贝塞尔在合理范围', () => {
  const c = measure('M0 0 C0 100 100 100 100 0');
  assert.ok(c.total > 100 && c.total < 210);
  const q = measure('M0 0 Q50 100 100 0');
  assert.ok(q.total > 100 && q.total < 160);
});

test('切线/法线：直线方向正确', () => {
  const m = measure('M0 0 L100 0');
  const t = m.tangentAtLength(50);
  assert.ok(Math.abs(t.x - 1) < 1e-9 && Math.abs(t.y) < 1e-9);
  const n = m.normalAtLength(50);
  assert.ok(Math.abs(n.x) < 1e-9 && Math.abs(n.y - 1) < 1e-9);
  // 切线·法线 = 0
  assert.ok(Math.abs(t.x * n.x + t.y * n.y) < 1e-9);
});

test('弧线：半圆长度 ≈ πr，端点正确', () => {
  const m = measure('M0 0 A50 50 0 0 1 100 0');
  assert.ok(Math.abs(m.total - Math.PI * 50) < 0.5, `got ${m.total}`);
  const end = m.pointAtLength(m.total);
  assert.ok(Math.abs(end.x - 100) < 0.01 && Math.abs(end.y) < 0.01);
});

test('弧线：rx=0 退化为直线', () => {
  const c = arcToCenter(0, 0, 0, 5, 0, 0, 1, 10, 0);
  assert.equal(c, null);
  const m = measure('M0 0 A0 5 0 0 1 10 0');
  assert.ok(Math.abs(m.total - 10) < 1e-6);
});

test('弧线：半径不足自动放大', () => {
  // 端点相距 100，rx=ry=10 不够，应放大为 >= 50
  const c = arcToCenter(0, 0, 10, 10, 0, 0, 1, 100, 0);
  assert.ok(c.rx >= 50 - 1e-9);
});

test('弧线：非法参数报错（负半径、非法标志位）', () => {
  const r1 = parsePath('M0 0 A-5 5 0 0 1 10 0');
  assert.ok(r1.errors.some((e) => e.message.includes('半径')));
  const r2 = parsePath('M0 0 A5 5 0 2 1 10 0');
  assert.ok(r2.errors.some((e) => e.message.includes('标志位')));
});

test('语法错误：非法字符、参数不足、缺少起始指令', () => {
  assert.ok(parsePath('M0 0 L@ 5').errors.some((e) => e.message.includes('非法字符')));
  assert.ok(parsePath('M0 0 L10').errors.some((e) => e.message.includes('需要 2 个参数')));
  assert.ok(parsePath('10 10 L5 5').errors.some((e) => e.message.includes('指令字母开头')));
  assert.ok(parsePath(null).errors.length > 0);
});

test('闭合路径：Z 回到子路径起点', () => {
  const { segments } = parsePath('M10 20 L50 20 L50 60 Z');
  const z = segments[segments.length - 1];
  assert.equal(z.type, 'Z');
  assert.equal(z.x, 10);
  assert.equal(z.y, 20);
});

test('pointAtLength：中点与边界', () => {
  const m = measure('M0 0 L100 0 L100 100');
  const mid = m.pointAtLength(100);
  assert.ok(Math.abs(mid.x - 100) < 0.5 && Math.abs(mid.y) < 0.5);
  assert.deepEqual(m.pointAtLength(-5), { x: 0, y: 0 });
  const end = m.pointAtLength(9999);
  assert.ok(Math.abs(end.x - 100) < 1e-9 && Math.abs(end.y - 100) < 1e-9);
});

test('裁剪：按长度区间截取', () => {
  const m = measure('M0 0 L100 0');
  const d = clipPathByLength(m, 25, 75);
  const cm = measure(d);
  assert.ok(Math.abs(cm.total - 50) < 0.6, `got ${cm.total}`);
  const start = cm.pointAtLength(0);
  assert.ok(Math.abs(start.x - 25) < 0.6);
});

test('变形：等弧长重采样 + 插值端点正确', () => {
  const a = measure('M0 0 L100 0');
  const b = measure('M0 100 L100 100');
  const sa = resample(a, 50);
  const sb = resample(b, 50);
  const d = morphPaths(sa, sb, 0.5);
  const m = measure(d);
  const p = m.pointAtLength(50);
  assert.ok(Math.abs(p.x - 50) < 1 && Math.abs(p.y - 50) < 1);
});

test('长路径：3000 段曲线在可接受时间内扁平化', () => {
  let d = 'M0 0';
  for (let k = 0; k < 3000; k++) {
    d += `C${k} 10 ${k + 0.5} -10 ${k + 1} 0`;
  }
  const { segments } = parsePath(d);
  const t0 = performance.now();
  const flat = flattenSegments(segments, 0.5);
  const cost = performance.now() - t0;
  assert.ok(flat.total > 0);
  assert.ok(cost < 3000, `flatten took ${cost}ms`);
});

test('降级：高容差直线近似显著减少采样点且长度接近', () => {
  let d = 'M0 0';
  for (let k = 0; k < 500; k++) d += `C${k * 10 + 2.5} 1 ${k * 10 + 7.5} -1 ${(k + 1) * 10} 0`;
  const { segments } = parsePath(d);
  const hi = flattenSegments(segments, 0.3);
  const lo = flattenSegments(segments, 8.0);
  assert.ok(lo.points.length < hi.points.length / 3);
  assert.ok(Math.abs(lo.total - hi.total) / hi.total < 0.05);
});

test('序列化：parse(serialize(segments)) 往返一致', () => {
  const d = 'M10 10 C20 20 30 30 40 40 Q50 50 60 60 A10 10 0 0 1 70 70 L80 80 Z';
  const { segments } = parsePath(d);
  const d2 = serializeSegments(segments);
  const { segments: s2, errors } = parsePath(d2);
  assert.equal(errors.length, 0);
  assert.equal(s2.length, segments.length);
  assert.deepEqual(s2.map((s) => s.type), segments.map((s) => s.type));
});
