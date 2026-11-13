'use strict';
// Cắt câu theo tiếng nói. Dùng được cả ở Node lẫn trình duyệt (renderer).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Vad = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  class Vad {
    constructor(o = {}) {
      this.rate = o.rate || 16000;
      this.threshold = o.threshold != null ? o.threshold : 0.015; // RMS 0..1
      this.endMs = o.endSilenceMs || 500;       // im lặng bao lâu thì chốt câu
      this.maxMs = o.maxMs || 10000;            // cắt cứng nếu nói quá dài
      this.minVoicedMs = o.minVoicedMs || 700;  // ít nhất ngần này tiếng nói thật
      this.peakFactor = o.peakFactor || 1.5;    // đỉnh phải > ngưỡng * hệ số
      this.preRollMs = o.preRollMs != null ? o.preRollMs : 300; // giữ lại đầu câu
      this.reset();
    }
    reset() {
      this.frames = []; this.pre = []; this.preMs = 0; this.speaking = false;
      this.silentMs = 0; this.voicedMs = 0; this.totalMs = 0; this.peak = 0; this.level = 0;
    }
    // frame: Int16Array. Trả về Int16Array (một câu hoàn chỉnh) hoặc null.
    feed(frame) {
      const ms = frame.length / this.rate * 1000;
      let s = 0;
      for (let i = 0; i < frame.length; i++) { const v = frame[i] / 32768; s += v * v; }
      const level = Math.sqrt(s / Math.max(1, frame.length));
      this.level = level;
      const loud = level > this.threshold;
      if (!this.speaking) {
        if (!loud) {
          this.pre.push(frame); this.preMs += ms;
          while (this.preMs > this.preRollMs && this.pre.length > 1) {
            this.preMs -= this.pre[0].length / this.rate * 1000; this.pre.shift();
          }
          return null;
        }
        this.speaking = true;
        this.frames = this.pre; this.totalMs = this.preMs; this.pre = []; this.preMs = 0;
        this.silentMs = 0; this.voicedMs = 0; this.peak = 0;
      }
      this.frames.push(frame); this.totalMs += ms;
      if (loud) { this.silentMs = 0; this.voicedMs += ms; if (level > this.peak) this.peak = level; }
      else this.silentMs += ms;
      if (this.silentMs >= this.endMs || this.totalMs >= this.maxMs) return this._finish();
      return null;
    }
    _finish() {
      const ok = this.voicedMs >= this.minVoicedMs && this.peak > this.threshold * this.peakFactor;
      const frames = this.frames;
      this.frames = []; this.speaking = false; this.silentMs = 0; this.voicedMs = 0; this.totalMs = 0; this.peak = 0;
      if (!ok) return null;
      let n = 0; for (const f of frames) n += f.length;
      const out = new Int16Array(n); let o = 0;
      for (const f of frames) { out.set(f, o); o += f.length; }
      return out;
    }
    flush() { return this.speaking ? this._finish() : null; }
  }
  return Vad;
});
