// SVG path 解析器：支持 M/L/H/V/C/S/Q/T/A/Z（绝对+相对），输出规范化绝对指令段，
// 并收集带位置信息的语法错误（不抛出，便于 UI 提示）。

const COMMANDS = new Set(['M','L','H','V','C','S','Q','T','A','Z']);
const PARAM_COUNT = { M:2, L:2, H:1, V:1, C:6, S:4, Q:4, T:2, A:7, Z:0 };

function isCmdChar(ch) { return /[a-zA-Z]/.test(ch); }

// 词法分析：把路径字符串切成 命令/数字 token，非法字符记为错误但继续。
export function tokenize(d) {
  const tokens = [];
  const errors = [];
  let i = 0;
  const n = d.length;
  while (i < n) {
    const ch = d[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') { i++; continue; }
    if (isCmdChar(ch)) {
      if (COMMANDS.has(ch.toUpperCase())) {
        tokens.push({ type: 'cmd', value: ch, pos: i });
      } else {
        errors.push({ pos: i, message: `未知指令 "${ch}"` });
      }
      i++;
      continue;
    }
    // 数字：可选符号、小数、科学计数法；允许 "1.2.3" 这类省略写法（SVG 合法）
    const rest = d.slice(i);
    const m = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(rest);
    if (m) {
      tokens.push({ type: 'num', value: parseFloat(m[0]), pos: i });
      i += m[0].length;
      continue;
    }
    errors.push({ pos: i, message: `无法解析的字符 "${ch}"` });
    i++;
  }
  return { tokens, errors };
}

// 语法分析：token 流 -> 规范化绝对指令段数组。
// 段格式：{ cmd:'M'|'L'|'C'|'Q'|'A'|'Z', x,y, x1,y1,x2,y2, rx,ry,rot,laf,sf, from:{x,y} }
export function parsePath(d) {
  const { tokens, errors } = tokenize(d);
  const segments = [];
  let i = 0;
  let cx = 0, cy = 0;        // 当前点
  let sx = 0, sy = 0;        // 子路径起点（Z 用）
  let prevCtrl = null;       // 上一个二次/三次控制点（S/T 反射用）
  let prevCmd = '';
  let pendingCmd = null;     // M 后续隐式 L 等
  let started = false;       // 是否已遇到首个 M

  const need = (count, cmd, pos) => {
    if (i + count > tokens.length) {
      errors.push({ pos, message: `指令 ${cmd} 参数不足（需要 ${count} 个）` });
      return false;
    }
    for (let k = 0; k < count; k++) {
      const t = tokens[i + k];
      if (!t || t.type !== 'num') {
        errors.push({ pos: t ? t.pos : pos, message: `指令 ${cmd} 的第 ${k + 1} 个参数应为数字` });
        return false;
      }
    }
    return true;
  };
  const read = (count) => { const v = tokens.slice(i, i + count).map(t => t.value); i += count; return v; };

  while (i < tokens.length) {
    const tok = tokens[i];
    let cmd;
    if (tok.type === 'cmd') { cmd = tok.value; i++; }
    else if (pendingCmd) { cmd = pendingCmd; }       // 隐式重复上一指令
    else {
      errors.push({ pos: tok.pos, message: '路径必须以 M/m 指令开始' });
      i++;
      continue;
    }

    const upper = cmd.toUpperCase();
    const rel = cmd !== upper;
    const pos = tok.pos;

    if (!started && upper !== 'M') {
      errors.push({ pos, message: '路径必须以 M/m 指令开始' });
      started = true;
    }

    if (upper === 'Z') {
      segments.push({ cmd: 'Z', from: { x: cx, y: cy }, x: sx, y: sy });
      cx = sx; cy = sy;
      prevCtrl = null; prevCmd = 'Z'; pendingCmd = null;
      continue;
    }

    const count = PARAM_COUNT[upper];
    if (!need(count, cmd, pos)) {
      // 跳过到下一个指令 token，避免级联错误
      while (i < tokens.length && tokens[i].type !== 'cmd') i++;
      pendingCmd = null;
      continue;
    }
    const p = read(count);
    const ax = (v) => rel ? v + cx : v;
    const ay = (v) => rel ? v + cy : v;

    switch (upper) {
      case 'M': {
        started = true;
        cx = ax(p[0]); cy = ay(p[1]);
        sx = cx; sy = cy;
        segments.push({ cmd: 'M', x: cx, y: cy, from: { x: cx, y: cy } });
        pendingCmd = rel ? 'l' : 'L'; // 后续坐标对视为隐式 L
        prevCtrl = null;
        break;
      }
      case 'L': {
        const nx = ax(p[0]), ny = ay(p[1]);
        segments.push({ cmd: 'L', from: { x: cx, y: cy }, x: nx, y: ny });
        cx = nx; cy = ny; prevCtrl = null;
        pendingCmd = cmd;
        break;
      }
      case 'H': {
        const nx = rel ? p[0] + cx : p[0];
        segments.push({ cmd: 'L', from: { x: cx, y: cy }, x: nx, y: cy });
        cx = nx; prevCtrl = null;
        pendingCmd = cmd;
        break;
      }
      case 'V': {
        const ny = rel ? p[0] + cy : p[0];
        segments.push({ cmd: 'L', from: { x: cx, y: cy }, x: cx, y: ny });
        cy = ny; prevCtrl = null;
        pendingCmd = cmd;
        break;
      }
      case 'C': {
        const seg = { cmd: 'C', from: { x: cx, y: cy },
          x1: ax(p[0]), y1: ay(p[1]), x2: ax(p[2]), y2: ay(p[3]),
          x: ax(p[4]), y: ay(p[5]) };
        segments.push(seg);
        prevCtrl = { x: seg.x2, y: seg.y2 };
        cx = seg.x; cy = seg.y;
        pendingCmd = cmd;
        break;
      }
      case 'S': {
        const c1 = (prevCmd === 'C' || prevCmd === 'S') && prevCtrl
          ? { x: 2 * cx - prevCtrl.x, y: 2 * cy - prevCtrl.y }
          : { x: cx, y: cy };
        const seg = { cmd: 'C', from: { x: cx, y: cy },
          x1: c1.x, y1: c1.y, x2: ax(p[0]), y2: ay(p[1]),
          x: ax(p[2]), y: ay(p[3]) };
        segments.push(seg);
        prevCtrl = { x: seg.x2, y: seg.y2 };
        cx = seg.x; cy = seg.y;
        pendingCmd = cmd;
        break;
      }
      case 'Q': {
        const seg = { cmd: 'Q', from: { x: cx, y: cy },
          x1: ax(p[0]), y1: ay(p[1]), x: ax(p[2]), y: ay(p[3]) };
        segments.push(seg);
        prevCtrl = { x: seg.x1, y: seg.y1 };
        cx = seg.x; cy = seg.y;
        pendingCmd = cmd;
        break;
      }
      case 'T': {
        const c1 = (prevCmd === 'Q' || prevCmd === 'T') && prevCtrl
          ? { x: 2 * cx - prevCtrl.x, y: 2 * cy - prevCtrl.y }
          : { x: cx, y: cy };
        const seg = { cmd: 'Q', from: { x: cx, y: cy },
          x1: c1.x, y1: c1.y, x: ax(p[0]), y: ay(p[1]) };
        segments.push(seg);
        prevCtrl = { x: seg.x1, y: seg.y1 };
        cx = seg.x; cy = seg.y;
        pendingCmd = cmd;
        break;
      }
      case 'A': {
        let [rx, ry, rot, laf, sf] = p;
        const nx = ax(p[5]), ny = ay(p[6]);
        rx = Math.abs(rx); ry = Math.abs(ry);
        if (rx === 0 || ry === 0) {
          // 规范：半径为 0 退化为直线
          segments.push({ cmd: 'L', from: { x: cx, y: cy }, x: nx, y: ny });
        } else {
          segments.push({ cmd: 'A', from: { x: cx, y: cy },
            rx, ry, rot, laf: laf ? 1 : 0, sf: sf ? 1 : 0, x: nx, y: ny });
        }
        cx = nx; cy = ny; prevCtrl = null;
        pendingCmd = cmd;
        break;
      }
    }
    prevCmd = upper;
  }

  if (segments.length === 0 && errors.length === 0) {
    errors.push({ pos: 0, message: '路径为空' });
  }
  return { segments, errors };
}
