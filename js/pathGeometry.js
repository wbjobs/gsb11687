// 路径几何：弧线端点->圆心参数化、自适应细分扁平化、长度表、
// pointAtLength / 切线 / 法线、重采样（变形用）、按长度裁剪。

const TAU = Math.PI * 2;

// SVG 规范 F.6.5：端点参数化 -> 圆心参数化
export function arcToCenter(x1, y1, rx, ry, phiDeg, laf, sf, x2, y2) {
  const phi = phiDeg * Math.PI / 180;
  const cosP = Math.cos(phi), sinP = Math.sin(phi);
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
  const x1p = cosP * dx + sinP * dy;
  const y1p = -sinP * dx + cosP * dy;

  // 半径不足时按比例放大（规范要求）
  let rxSq = rx * rx, rySq = ry * ry;
  const lambda = (x1p * x1p) / rxSq + (y1p * y1p) / rySq;
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s; ry *= s;
    rxSq = rx * rx; rySq = ry * ry;
  }

  const num = rxSq * rySq - rxSq * y1p * y1p - rySq * x1p * x1p;
  const den = rxSq * y1p * y1p + rySq * x1p * x1p;
  let co = den === 0 ? 0 : Math.sqrt(Math.max(0, num / den));
  if (laf === sf) co = -co;
  const cxp = co * (rx * y1p) / ry;
  const cyp = co * -(ry * x1p) / rx;

  const cx = cosP * cxp - sinP * cyp + (x1 + x2) / 2;
  const cy = sinP * cxp + cosP * cyp + (y1 + y2) / 2;

  const angle = (ux, uy, vx, vy) => {
    const dot = ux * vx + uy * vy;
    const len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    let a = Math.acos(Math.min(1, Math.max(-1, dot / len)));
    if (ux * vy - uy * vx < 0) a = -a;
    return a;
  };
  const theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dTheta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sf && dTheta > 0) dTheta -= TAU;
  if (sf && dTheta < 0) dTheta += TAU;

  return { cx, cy, rx, ry, phi, theta1, dTheta };
}

// 单段扁平化为折线点列（不含起点，含终点）
function flattenSegment(seg, tolerance) {
  const pts = [];
  switch (seg.cmd) {
    case 'M':
      break;
    case 'L':
    case 'Z':
      pts.push({ x: seg.x, y: seg.y });
      break;
    case 'Q': {
      // 二次贝塞尔 -> 三次，再细分
      const c1x = seg.from.x + 2 / 3 * (seg.x1 - seg.from.x);
      const c1y = seg.from.y + 2 / 3 * (seg.y1 - seg.from.y);
      const c2x = seg.x + 2 / 3 * (seg.x1 - seg.x);
      const c2y = seg.y + 2 / 3 * (seg.y1 - seg.y);
      subdivideCubic(seg.from.x, seg.from.y, c1x, c1y, c2x, c2y, seg.x, seg.y, tolerance, pts);
      break;
    }
    case 'C':
      subdivideCubic(seg.from.x, seg.from.y, seg.x1, seg.y1, seg.x2, seg.y2, seg.x, seg.y, tolerance, pts);
      break;
    case 'A': {
      const a = arcToCenter(seg.from.x, seg.from.y, seg.rx, seg.ry, seg.rot, seg.laf, seg.sf, seg.x, seg.y);
      const sweep = Math.abs(a.dTheta);
      // 按角度步进细分，步长由误差容限决定
      const rMax = Math.max(a.rx, a.ry);
      const step = Math.min(Math.PI / 8, 2 * Math.acos(Math.max(-1, 1 - tolerance / Math.max(rMax, tolerance))));
      const n = Math.max(1, Math.ceil(sweep / Math.max(step, 1e-4)));
      for (let k = 1; k <= n; k++) {
        const t = a.theta1 + a.dTheta * (k / n);
        const cosP = Math.cos(a.phi), sinP = Math.sin(a.phi);
        pts.push({
          x: a.cx + a.rx * Math.cos(t) * cosP - a.ry * Math.sin(t) * sinP,
          y: a.cy + a.rx * Math.cos(t) * sinP + a.ry * Math.sin(t) * cosP,
        });
      }
      break;
    }
  }
  return pts;
}

// de Casteljau 递归细分三次贝塞尔
function subdivideCubic(x0, y0, x1, y1, x2, y2, x3, y3, tol, out, depth = 0) {
  const dx = x3 - x0, dy = y3 - y0;
  const d1 = Math.abs((x1 - x3) * dy - (y1 - y3) * dx);
  const d2 = Math.abs((x2 - x3) * dy - (y2 - y3) * dx);
  const len = Math.hypot(dx, dy) || 1;
  if (depth < 24 && (d1 + d2) * (d1 + d2) > tol * tol * len * len * 8) {
    const mx1 = (x0 + x1) / 2, my1 = (y0 + y1) / 2;
    const mx2 = (x1 + x2) / 2, my2 = (y1 + y2) / 2;
    const mx3 = (x2 + x3) / 2, my3 = (y2 + y3) / 2;
    const mx12 = (mx1 + mx2) / 2, my12 = (my1 + my2) / 2;
    const mx23 = (mx2 + mx3) / 2, my23 = (my2 + my3) / 2;
    const mx123 = (mx12 + mx23) / 2, my123 = (my12 + my23) / 2;
    subdivideCubic(x0, y0, mx1, my1, mx12, my12, mx123, my123, tol, out, depth + 1);
    subdivideCubic(mx123, my123, mx23, my23, mx3, my3, x3, y3, tol, out, depth + 1);
  } else {
    out.push({ x: x3, y: y3 });
  }
}

// 整条路径 -> 折线 + 累积长度表
export function flattenPath(segments, tolerance = 0.25) {
  const points = [];
  const cumLen = [];
  let total = 0;
  let pen = null;
  for (const seg of segments) {
    if (seg.cmd === 'M') {
      pen = { x: seg.x, y: seg.y };
      points.push(pen);
      cumLen.push(total);
      continue;
    }
    if (!pen) {
      pen = { x: seg.from.x, y: seg.from.y };
      points.push(pen);
      cumLen.push(total);
    }
    const segPts = flattenSegment(seg, tolerance);
    for (const p of segPts) {
      total += Math.hypot(p.x - pen.x, p.y - pen.y);
      points.push(p);
      cumLen.push(total);
      pen = p;
    }
  }
  return { points, cumLen, totalLength: total };
}

// 在折线上按弧长取点 + 切线 + 法线
export function pointAtLength(flat, len) {
  const { points, cumLen, totalLength } = flat;
  const n = points.length;
  if (n === 0) return { x: 0, y: 0, tx: 1, ty: 0, nx: 0, ny: 1 };
  const target = Math.max(0, Math.min(totalLength, len));
  // 二分查找
  let lo = 0, hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cumLen[mid] < target) lo = mid + 1; else hi = mid;
  }
  const i = Math.max(1, lo);
  const p0 = points[i - 1], p1 = points[i];
  const segLen = cumLen[i] - cumLen[i - 1];
  const t = segLen > 0 ? (target - cumLen[i - 1]) / segLen : 0;
  const x = p0.x + (p1.x - p0.x) * t;
  const y = p0.y + (p1.y - p0.y) * t;
  let tx = p1.x - p0.x, ty = p1.y - p0.y;
  const m = Math.hypot(tx, ty);
  if (m > 1e-9) { tx /= m; ty /= m; } else { tx = 1; ty = 0; }
  return { x, y, tx, ty, nx: -ty, ny: tx }; // 法线 = 切线逆时针 90°
}

// 归一化参数 t∈[0,1] 取点
export function pointAtT(flat, t) {
  return pointAtLength(flat, t * flat.totalLength);
}

// 按弧长区间裁剪：返回折线子段（保持 [startLen, endLen] 之间的部分）
export function clipByLength(flat, startLen, endLen) {
  const s = Math.max(0, Math.min(flat.totalLength, Math.min(startLen, endLen)));
  const e = Math.max(0, Math.min(flat.totalLength, Math.max(startLen, endLen)));
  const { points, cumLen } = flat;
  const out = [];
  const startPt = pointAtLength(flat, s);
  out.push({ x: startPt.x, y: startPt.y });
  for (let i = 0; i < points.length; i++) {
    if (cumLen[i] > s && cumLen[i] < e) out.push(points[i]);
  }
  const endPt = pointAtLength(flat, e);
  out.push({ x: endPt.x, y: endPt.y });
  return out;
}

// 重采样为 N 个等弧长点（路径变形用）
export function resample(flat, count) {
  const pts = [];
  for (let k = 0; k < count; k++) {
    const p = pointAtLength(flat, flat.totalLength * (k / (count - 1)));
    pts.push({ x: p.x, y: p.y });
  }
  return pts;
}

// 两组等数点线性插值 -> 折线（变形动画帧）
export function lerpPoints(a, b, t) {
  const out = new Array(a.length);
  for (let i = 0; i < a.length; i++) {
    out[i] = { x: a[i].x + (b[i].x - a[i].x) * t, y: a[i].y + (b[i].y - a[i].y) * t };
  }
  return out;
}

// 折线 -> path d 字符串（用于裁剪/变形结果回显到 SVG）
export function pointsToPathD(points, close = false) {
  if (!points.length) return '';
  let d = `M${r2(points[0].x)} ${r2(points[0].y)}`;
  for (let i = 1; i < points.length; i++) d += `L${r2(points[i].x)} ${r2(points[i].y)}`;
  return close ? d + 'Z' : d;
}
function r2(v) { return Math.round(v * 100) / 100; }
