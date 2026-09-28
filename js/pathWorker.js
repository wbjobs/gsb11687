// Web Worker：在后台线程解析并扁平化路径，避免长路径阻塞主线程。
// 协议:
//   请求  { id, d, tolerance, maxPoints }
//   响应  { id, ok, points, lengths, total, truncated, errors, pointCount } (points/lengths 为 Transferable)
import { parsePath } from './pathParser.js';
import { flattenSegments } from './pathGeometry.js';

self.onmessage = (e) => {
  const { id, d, tolerance, maxPoints } = e.data;
  try {
    const { segments, errors } = parsePath(d);
    const flat = flattenSegments(segments, tolerance ?? 0.5, maxPoints ?? 200000);
    self.postMessage({
      id, ok: true,
      points: flat.points, lengths: flat.lengths,
      total: flat.total, truncated: flat.truncated,
      errors, pointCount: flat.points.length / 2,
    }, [flat.points.buffer, flat.lengths.buffer]);
  } catch (err) {
    self.postMessage({ id, ok: false, errors: [{ message: String(err && err.message || err), index: 0 }] });
  }
};
