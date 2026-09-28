// SVG path 解析器：把 path d 字符串解析为绝对坐标的段列表。
// 支持 M/L/H/V/C/S/Q/T/A/Z（大小写），收集语法错误并给出位置信息。

const PARAM_COUNT = {
  M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0,
};

const COMMANDS = new Set(Object.keys(PARAM_COUNT));

export function tokenize(d) {
  const tokens = [];
  const errors = [];
  const re = /([MmLlHhVvCcSsQqTtAaZz])|([-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?)|(\S)/g;
  let m;
  while ((m = re.exec(d)) !== null) {
    if (m[1] !== undefined) {
      tokens.push({ type: 'cmd', value: m[1], index: m.index });
    } else if (m[2] !== undefined) {
      tokens.push({ type: 'num', value: parseFloat(m[2]), index: m.index });
    } else if (m[3] !== undefined) {
      if (m[3] !== ',' && !/\s/.test(m[3])) {
        errors.push({ message: `非法字符 "${m[3]}"`, index: m.index });
      }
    }
  }
  return { tokens, errors };
}

// 解析结果: { segments, errors }
// segment: { type: 'M'|'L'|'C'|'Q'|'A'|'Z', ...绝对坐标, start:{x,y} }
export function parsePath(d) {
  if (typeof d !== 'string') {
    return { segments: [], errors: [{ message: '路径数据必须是字符串', index: 0 }] };
  }
  const { tokens, errors } = tokenize(d);
  const segments = [];
  let i = 0;
  let cmd = null;
  let x = 0, y = 0;
  let sx = 0, sy = 0;
  let prevC2 = null;
  let prevQ1 = null;
  let prevType = null;

  const readNum = (ctx) => {
    const t = tokens[i];
    if (!t || t.type !== 'num') {
      errors.push({
        message: `指令 ${ctx} 参数不足或类型错误（第 ${t ? t.index : d.length} 字符附近）`,
        index: t ? t.index : d.length,
      });
      return null;
    }
    i++;
    return t.value;
  };

  while (i < tokens.length) {
    const t = tokens[i];
    if (t.type === 'cmd') {
      const upper = t.value.toUpperCase();
      cmd = t.value;
      i++;
      if (upper === 'Z') {
        segments.push({ type: 'Z', start: { x, y }, x: sx, y: sy });
        x = sx; y = sy;
        prevC2 = prevQ1 = null; prevType = 'Z'; cmd = null;
        continue;
      }
    } else if (cmd === null) {
      errors.push({ message: '路径必须以指令字母开头', index: t.index });
      i++;
      continue;
    }
    if (cmd === null) continue;

    const upper = cmd.toUpperCase();
    const relative = cmd !== upper;
    const need = PARAM_COUNT[upper];
    let nums = 0;
    for (let j = i; j < tokens.length && tokens[j].type === 'num'; j++) nums++;
    if (nums < need) {
      errors.push({
        message: `指令 ${upper} 需要 ${need} 个参数，实际只有 ${nums} 个`,
        index: tokens[i] ? tokens[i].index : d.length,
      });
      break;
    }

    const start = { x, y };
    const ax = (v) => (relative ? v + x : v);
    const ay = (v) => (relative ? v + y : v);

    if (upper === 'M') {
      const nx = readNum('M'), ny = readNum('M');
      if (nx === null || ny === null) break;
      x = ax(nx); y = ay(ny);
      sx = x; sy = y;
      segments.push({ type: 'M', start, x, y });
      cmd = relative ? 'l' : 'L';
      prevC2 = prevQ1 = null; prevType = 'M';
      continue;
    }

    switch (upper) {
      case 'L': {
        const nx = readNum('L'), ny = readNum('L');
        if (nx === null || ny === null) break;
        const px = ax(nx), py = ay(ny);
        segments.push({ type: 'L', start, x: px, y: py });
        x = px; y = py;
        prevC2 = prevQ1 = null;
        break;
      }
      case 'H': {
        const nx = readNum('H');
        if (nx === null) break;
        const px = ax(nx);
        segments.push({ type: 'L', start, x: px, y });
        x = px;
        prevC2 = prevQ1 = null;
        break;
      }
      case 'V': {
        const ny = readNum('V');
        if (ny === null) break;
        const py = ay(ny);
        segments.push({ type: 'L', start, x, y: py });
        y = py;
        prevC2 = prevQ1 = null;
        break;
      }
      case 'C': {
        const x1 = ax(readNum('C')), y1 = ay(readNum('C'));
        const x2 = ax(readNum('C')), y2 = ay(readNum('C'));
        const xe = ax(readNum('C')), ye = ay(readNum('C'));
        if ([x1, y1, x2, y2, xe, ye].some((v) => v === null)) break;
        segments.push({ type: 'C', start, x1, y1, x2, y2, x: xe, y: ye });
        prevC2 = { x: x2, y: y2 }; prevQ1 = null;
        x = xe; y = ye;
        break;
      }
      case 'S': {
        const x2 = ax(readNum('S')), y2 = ay(readNum('S'));
        const xe = ax(readNum('S')), ye = ay(readNum('S'));
        if ([x2, y2, xe, ye].some((v) => v === null)) break;
        const x1 = prevType === 'C' && prevC2 ? 2 * x - prevC2.x : x;
        const y1 = prevType === 'C' && prevC2 ? 2 * y - prevC2.y : y;
        segments.push({ type: 'C', start, x1, y1, x2, y2, x: xe, y: ye });
        prevC2 = { x: x2, y: y2 }; prevQ1 = null;
        x = xe; y = ye;
        break;
      }
      case 'Q': {
        const x1 = ax(readNum('Q')), y1 = ay(readNum('Q'));
        const xe = ax(readNum('Q')), ye = ay(readNum('Q'));
        if ([x1, y1, xe, ye].some((v) => v === null)) break;
        segments.push({ type: 'Q', start, x1, y1, x: xe, y: ye });
        prevQ1 = { x: x1, y: y1 }; prevC2 = null;
        x = xe; y = ye;
        break;
      }
      case 'T': {
        const xe = ax(readNum('T')), ye = ay(readNum('T'));
        if (xe === null || ye === null) break;
        const x1 = prevType === 'Q' && prevQ1 ? 2 * x - prevQ1.x : x;
        const y1 = prevType === 'Q' && prevQ1 ? 2 * y - prevQ1.y : y;
        segments.push({ type: 'Q', start, x1, y1, x: xe, y: ye });
        prevQ1 = { x: x1, y: y1 }; prevC2 = null;
        x = xe; y = ye;
        break;
      }
      case 'A': {
        const rx = readNum('A'), ry = readNum('A');
        const rot = readNum('A'), laf = readNum('A'), sf = readNum('A');
        const xe = ax(readNum('A')), ye = ay(readNum('A'));
        if ([rx, ry, rot, laf, sf, xe, ye].some((v) => v === null)) break;
        if (!((laf === 0 || laf === 1) && (sf === 0 || sf === 1))) {
          errors.push({ message: `弧线标志位必须是 0 或 1（得到 ${laf}, ${sf}）`, index: t.index });
        }
        if (rx < 0 || ry < 0) {
          errors.push({ message: `弧线半径不能为负（rx=${rx}, ry=${ry}）`, index: t.index });
        }
        segments.push({
          type: 'A', start,
          rx: Math.abs(rx), ry: Math.abs(ry), rot,
          largeArc: laf === 1 ? 1 : 0, sweep: sf === 1 ? 1 : 0,
          x: xe, y: ye,
        });
        x = xe; y = ye;
        prevC2 = prevQ1 = null;
        break;
      }
      default:
        break;
    }
    prevType = (upper === 'C' || upper === 'S') ? 'C' : (upper === 'Q' || upper === 'T') ? 'Q' : upper;
  }
  return { segments, errors };
}

// 段列表序列化回 d 字符串（绝对指令）
export function serializeSegments(segments, precision = 3) {
  const f = (n) => {
    const s = n.toFixed(precision);
    return s.replace(/\.?0+$/, '') || '0';
  };
  return segments.map((s) => {
    switch (s.type) {
      case 'M': return `M${f(s.x)} ${f(s.y)}`;
      case 'L': return `L${f(s.x)} ${f(s.y)}`;
      case 'C': return `C${f(s.x1)} ${f(s.y1)} ${f(s.x2)} ${f(s.y2)} ${f(s.x)} ${f(s.y)}`;
      case 'Q': return `Q${f(s.x1)} ${f(s.y1)} ${f(s.x)} ${f(s.y)}`;
      case 'A': return `A${f(s.rx)} ${f(s.ry)} ${f(s.rot)} ${s.largeArc} ${s.sweep} ${f(s.x)} ${f(s.y)}`;
      case 'Z': return 'Z';
      default: return '';
    }
  }).join('');
}
