// 性能监控：PerformanceObserver 观察 longtask + 自测帧率，
// 帧率持续低于阈值时触发降级回调（调用方切到直线近似/降低采样）。
export class PerfMonitor {
  constructor({ onDegrade, onRecover, fpsThreshold = 45, windowSize = 60 } = {}) {
    this.onDegrade = onDegrade;
    this.onRecover = onRecover;
    this.fpsThreshold = fpsThreshold;
    this.windowSize = windowSize;
    this.frameTimes = [];
    this.degraded = false;
    this.longTasks = 0;
    this.lastFrame = 0;
    if ('PerformanceObserver' in window) {
      try {
        this.observer = new PerformanceObserver((list) => {
          this.longTasks += list.getEntries().length;
        });
        this.observer.observe({ entryTypes: ['longtask'] });
      } catch (_) { /* longtask 不支持时静默 */ }
    }
  }
  // 每帧调用（rAF 内）
  tick(now) {
    if (this.lastFrame) {
      this.frameTimes.push(now - this.lastFrame);
      if (this.frameTimes.length > this.windowSize) this.frameTimes.shift();
      if (this.frameTimes.length === this.windowSize) {
        const avg = this.frameTimes.reduce((a, b) => a + b, 0) / this.windowSize;
        const fps = 1000 / avg;
        if (!this.degraded && fps < this.fpsThreshold) {
          this.degraded = true;
          this.onDegrade && this.onDegrade(fps);
        } else if (this.degraded && fps > this.fpsThreshold + 10) {
          this.degraded = false;
          this.onRecover && this.onRecover(fps);
        }
      }
    }
    this.lastFrame = now;
  }
  get fps() {
    if (!this.frameTimes.length) return 0;
    const avg = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
    return Math.round(1000 / avg);
  }
}
