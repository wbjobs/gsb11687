// 动画循环 + 性能监控。
// - requestAnimationFrame 驱动
// - PerformanceObserver 监听 longtask，帧耗统计滑动窗口
// - 帧耗超标时逐级降级：提高扁平化容差 -> 减少采样 -> 直线近似
export const QUALITY_LEVELS = [
  { name: '高精度', tolerance: 0.3, maxPoints: 200000 },
  { name: '标准', tolerance: 0.8, maxPoints: 100000 },
  { name: '省点', tolerance: 2.0, maxPoints: 30000 },
  { name: '直线近似', tolerance: 8.0, maxPoints: 8000 },
];

export class Animator {
  constructor({ onFrame, onQualityChange }) {
    this.onFrame = onFrame;
    this.onQualityChange = onQualityChange || (() => {});
    this.playing = false;
    this.speed = 120;          // 单位长度/秒
    this.distance = 0;
    this.qualityLevel = 1;     // 默认“标准”
    this.autoDegrade = true;
    this._frameTimes = [];
    this._lastTs = 0;
    this._longTasks = 0;
    this._raf = null;
    this._observer = null;
    this._lastDowngrade = 0;
  }

  start() {
    if (this.playing) return;
    this.playing = true;
    this._lastTs = performance.now();
    this._observe();
    const loop = (ts) => {
      if (!this.playing) return;
      const dt = Math.min(0.1, (ts - this._lastTs) / 1000);
      this._lastTs = ts;
      this.distance += this.speed * dt;
      const frameStart = performance.now();
      this.onFrame(this.distance, dt);
      const cost = performance.now() - frameStart;
      this._recordFrame(cost);
      this._raf = requestAnimationFrame(loop);
    };
    this._raf = requestAnimationFrame(loop);
  }

  stop() {
    this.playing = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    if (this._observer) { this._observer.disconnect(); this._observer = null; }
  }

  _observe() {
    if (this._observer || typeof PerformanceObserver === 'undefined') return;
    try {
      this._observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.duration > 50) this._longTasks++;
        }
      });
      this._observer.observe({ entryTypes: ['longtask'] });
    } catch { /* longtask 不可用时静默跳过 */ }
  }

  _recordFrame(cost) {
    this._frameTimes.push(cost);
    if (this._frameTimes.length > 60) this._frameTimes.shift();
    if (!this.autoDegrade) return;
    const now = performance.now();
    // 每 2 秒最多降一级，避免抖动
    if (now - this._lastDowngrade < 2000) return;
    const avg = this.avgFrameCost;
    if ((avg > 12 || this._longTasks > 2) && this.qualityLevel < QUALITY_LEVELS.length - 1) {
      this.qualityLevel++;
      this._longTasks = 0;
      this._lastDowngrade = now;
      this.onQualityChange(this.qualityLevel, QUALITY_LEVELS[this.qualityLevel]);
    }
  }

  get avgFrameCost() {
    if (!this._frameTimes.length) return 0;
    return this._frameTimes.reduce((a, b) => a + b, 0) / this._frameTimes.length;
  }

  get longTaskCount() { return this._longTasks; }

  setQuality(level) {
    this.qualityLevel = Math.max(0, Math.min(QUALITY_LEVELS.length - 1, level));
    this.onQualityChange(this.qualityLevel, QUALITY_LEVELS[this.qualityLevel]);
  }
}
