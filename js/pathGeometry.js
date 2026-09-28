// 路径几何：扁平化采样、长度表、按长度取点/切线/法线、弧线端点->圆心参数化、
// 路径裁剪（按长度区间）、等弧长重采样（用于变形）。

// ---------- 弧线端点参数化 -> 圆心参数化（SVG 规范 F.6.5） ----------
export function arcToCenter(x1, y1, rx, ry, phiDeg, largeArc, sweep, x2, y2) {
  if (rx === 0 || ry === 0) return null; // 退化为直线
  const phi = (phiDeg * Math.PI) / 180;
  const cosPhi = Math.cos(phi), sinPhi = Math.sin(phi);
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
  const x1p = cosPhi * dx + sinPhi * dy;
  const y1p = -sinPhi * dx + cosPhi * dy;
  rx = Math.abs(rx); ry = Math.abs(ry);
  // 半径不足时放大
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s; ry *= s;
  }
  const rx2 = rx * rx, ry2 = ry * ry;
  const num = rx2 * ry2 - rx2 * y1p * y1p - ry2 * x1p * x1p;
  const den = rx2 * y1p * y1p + ry2 * x1p * x1p;
  let co = den === 0 ? 0 : Math.sqrt(Math.max(0, num / den));
  if (largeArc === sweep) co = -co;
  const cxp = (co * rx * y1p) / ry;
  const cyp = (-co * ry * x1p) / rx;
  const cx = cosPhi * cxp - sinPhi * cyp + (x1 + x2) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (y1 + y2) / 2;
  const angle = (ux, uy, vx, vy) => {
    const dot = ux * vx + uy * vy;
    const len = Math.sqrt((ux * ux + uy * uy) * (vx * vx + vy * vy));
    let a = Math.acos(Math.min(1, Math.max(-1, dot / len)));
    if (ux * vy - uy * vx < 0) a = -a;
    return a;
  };
  const theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dTheta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && dTheta > 0) dTheta -= 2 * Math.PI;
  if (sweep && dTheta < 0) dTheta += 2 * Math.PI;
  return { cx, cy, rx, ry, phi, theta1, dTheta };
}

export function arcPoint(c, theta) {
  const cosPhi = Math.cos(c.phi), sinPhi = Math.sin(c.phi);
  return {
    x: c.cx + c.rx * Math.cos(theta) * cosPhi - c.ry * Math.sin(theta) * sinPhi,
    y: c.cy + c.rx * Math.cos(theta) * sinPhi + c.ry * Math.sin(theta) * cosPhi,
  };
}

// ---------- 三次/二次贝塞尔 ----------
function cubicAt(p0, p1, p2, p3, t) {
  const mt = 1 - t;
  return mt * mt * mt * p0 + 3 * mt * mt * t * p1 + 3 * mt * t * t * p2 + t * t * t * p3;
}
function quadAt(p0, p1, p2, t) {
  const mt = 1 - t;
  return mt * mt * p0 + 2 * mt * t * p1 + t * t * p2;
}

// ---------- 扁平化 ----------
// 返回 { points: Float64Array [x0,y0,x1,y1,...], lengths: Float64Array 累计长度, total }
// maxPoints 用于降级：超过则自动放大容差（直线近似）
export function flattenSegments(segments, tolerance = 0.5, maxPoints = 200000) {
  const pts = [];
  const push = (x, y) => pts.push(x, y);
  let started = false;

  const flattenCubic = (s, tol) => {
    // de Casteljau 自适应细分
    const stack = [[s.start.x, s.start.y, s.x1, s.y1, s.x2, s.y2, s.x, s.y]];
    while (stack.length) {
      const [x0, y0, x1, y1, x2, y2, x3, y3] = stack.pop();
      const d1 = distToLine(x1, y1, x0, y0, x3, y3);
      const d2 = distToLine(x2, y2, x0, y0, x3, y3);
      if (Math.max(d1, d2) <= tol) {
        push(x3, y3);
      } else {
        const x01 = (x0 + x1) / 2, y01 = (y0 + y1) / 2;
        const x12 = (x1 + x2) / 2, y12 = (y1 + y2) / 2;
        const x23 = (x2 + x3) / 2, y23 = (y2 + y3) / 2;
        const x012 = (x01 + x12) / 2, y012 = (y01 + y12) / 2;
        const x123 = (x12 + x23) / 2, y123 = (y12 + y23) / 2;
        const x0123 = (x012 + x123) / 2, y0123 = (y012 + y123) / 2;
        stack.push([x0123, y0123, x123, y123, x23, y23, x3, y3]);
        stack.push([x0, y0, x01, y01, x012, y012, x0123, y0123]);
      }
    }
  };

  const flattenQuad = (s, tol) => {
    const stack = [[s.start.x, s.start.y, s.x1, s.y1, s.x, s.y]];
    while (stack.length) {
      const [x0, y0, x1, y1, x2, y2] = stack.pop();
      if (distToLine(x1, y1, x0, y0, x2, y2) <= tol) {
        push(x2, y2);
      } else {
        const x01 = (x0 + x1) / 2, y01 = (y0 + y1) / 2;
        const x12 = (x1 + x2) / 2, y12 = (y1 + y2) / 2;
        const x012 = (x01 + x12) / 2, y012 = (y01 + y12) / 2;
        stack.push([x012, y012, x12, y12, x2, y2]);
        stack.push([x0, y0, x01, y01, x012, y012]);
      }
    }
  };

  const flattenArc = (s, tol) => {
    const c = arcToCenter(s.start.x, s.start.y, s.rx, s.ry, s.rot, s.largeArc, s.sweep, s.x, s.y);
    if (!c) { push(s.x, s.y); return; } // 半径为 0 -> 直线
    // 按弦高误差自适应角度步长
    const r = Math.max(c.rx, c.ry);
    const step = r <= tol ? Math.abs(c.dTheta) : 2 * Math.acos(Math.max(-1, Math.min(1, 1 - tol / r)));
    const n = Math.max(1, Math.ceil(Math.abs(c.dTheta) / Math.max(step, 1e-4)));
    for (let k = 1; k <= n; k++) {
      const p = arcPoint(c, c.theta1 + (c.dTheta * k) / n);
      push(p.x, p.y);
    }
  };

  for (const s of segments) {
    if (s.type === 'M') {
      if (!started) { push(s.x, s.y); started = true; }
      else push(s.x, s.y); // 新子路径：用 NaN 分隔会在长度表处理，这里直接记录跳变
    } else if (s.type === 'L' || s.type === 'Z') {
      push(s.x, s.y);
    } else if (s.type === 'C') {
      flattenCubic(s, tolerance);
    } else if (s.type === 'Q') {
      flattenQuad(s, tolerance);
    } else if (s.type === 'A') {
      flattenArc(s, tolerance);
    }
    if (pts.length / 2 > maxPoints) break;
  }

  const n = pts.length / 2;
  const points = new Float64Array(pts);
  const lengths = new Float64Array(n);
  let total = 0;
  for (let k = 1; k < n; k++) {
    const dx = points[2 * k] - points[2 * k - 2];
    const dy = points[2 * k + 1] - points[2 * k - 1];
    total += Math.hypot(dx, dy);
    lengths[k] = total;
  }
  return { points, lengths, total, truncated: pts.length / 2 > maxPoints };
}

function distToLine(px, py, x0, y0, x1, y1) {
  const dx = x1 - x0, dy = y1 - y0;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - x0, py - y0);
  return Math.abs((px - x0) * dy - (py - y0) * dx) / Math.sqrt(len2);
}

// ---------- 按长度取点 / 切线 / 法线 ----------
export class MeasuredPath {
  constructor(flat) {
    this.points = flat.points;
    this.lengths = flat.lengths;
    this.total = flat.total;
    this.truncated = !!flat.truncated;
  }

  // 二分查找长度所在段
  _locate(len) {
    const L = this.lengths;
    let lo = 0, hi = L.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (L[mid] < len) lo = mid + 1; else hi = mid;
    }
    return Math.max(1, lo);
  }

  pointAtLength(len) {
    const clamped = Math.max(0, Math.min(this.total, len));
    if (this.lengths.length === 0) return { x: 0, y: 0 };
    if (this.lengths.length === 1 || clamped === 0) {
      return { x: this.points[0], y: this.points[1] };
    }
    const k = this._locate(clamped);
    const l0 = this.lengths[k - 1], l1 = this.lengths[k];
    const t = l1 === l0 ? 0 : (clamped - l0) / (l1 - l0);
    return {
      x: this.points[2 * k - 2] + (this.points[2 * k] - this.points[2 * k - 2]) * t,
      y: this.points[2 * k - 1] + (this.points[2 * k + 1] - this.points[2 * k - 1]) * t,
    };
  }

  tangentAtLength(len) {
    const clamped = Math.max(0, Math.min(this.total, len));
    if (this.lengths.length < 2) return { x: 1, y: 0 };
    const k = this._locate(Math.max(clamped, 1e-9));
    const dx = this.points[2 * k] - this.points[2 * k - 2];
    const dy = this.points[2 * k + 1] - this.points[2 * k - 1];
    const m = Math.hypot(dx, dy);
    return m === 0 ? { x: 1, y: 0 } : { x: dx / m, y: dy / m };
  }

  normalAtLength(len) {
    const t = this.tangentAtLength(len);
    return { x: -t.y, y: t.x }; // 切线逆时针 90°
  }
}

// ---------- 路径裁剪：保留 [startLen, endLen] 区间，输出折线路径 d ----------
export function clipPathByLength(measured, startLen, endLen, precision = 2) {
  const s = Math.max(0, Math.min(startLen, endLen));
  const e = Math.min(measured.total, Math.max(startLen, endLen));
  const step = Math.max(measured.total / 2000, 0.5);
  const f = (n) => n.toFixed(precision);
  let d = '';
  for (let l = s; l < e; l += step) {
    const p = measured.pointAtLength(l);
    d += (d === '' ? `M${f(p.x)} ${f(p.y)}` : `L${f(p.x)} ${f(p.y)}`);
  }
  const pe = measured.pointAtLength(e);
  d += (d === '' ? `M${f(pe.x)} ${f(pe.y)}` : `L${f(pe.x)} ${f(pe.y)}`);
  return d;
}

// ---------- 等弧长重采样（路径变形用） ----------
export function resample(measured, count) {
  const out = new Float64Array(count * 2);
  for (let k = 0; k < count; k++) {
    const p = measured.pointAtLength((measured.total * k) / (count - 1));
    out[2 * k] = p.x;
    out[2 * k + 1] = p.y;
  }
  return out;
}

// 两组等长采样点按 t 插值，生成路径 d
export function morphPaths(samplesA, samplesB, t, precision = 2) {
  const n = samplesA.length / 2;
  const f = (v) => v.toFixed(precision);
  let d = '';
  for (let k = 0; k < n; k++) {
    const x = samplesA[2 * k] + (samplesB[2 * k] - samplesA[2 * k]) * t;
    const y = samplesA[2 * k + 1] + (samplesB[2 * k + 1] - samplesA[2 * k + 1]) * t;
    d += k === 0 ? `M${f(x)} ${f(y)}` : `L${f(x)} ${f(y)}`;
  }
  return d;
}
