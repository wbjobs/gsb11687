// Web Worker（module）：后台线程做解析 + 扁平化 + 长度表，避免长路径阻塞主线程。
import { parsePath } from './pathParser.js';
import { flattenPath, resample } from './pathGeometry.js';

self.onmessage = (e) => {
  const { id, d, tolerance, resampleCount } = e.data;
  try {
    const { segments, errors } = parsePath(d);
    const flat = flattenPath(segments, tolerance);
    const result = {
      id,
      errors,
      segments,
      points: flat.points,
      cumLen: flat.cumLen,
      totalLength: flat.totalLength,
    };
    if (resampleCount) result.resampled = resample(flat, resampleCount);
    self.postMessage(result);
  } catch (err) {
    self.postMessage({ id, errors: [{ pos: 0, message: '内部错误: ' + err.message }] });
  }
};
