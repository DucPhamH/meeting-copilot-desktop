'use strict';
// Thu âm trong renderer cho Windows/macOS (Linux dùng pw-record ở tiến trình chính).
// them = âm thanh hệ thống (loopback), me = micro.
const Cap = (() => {
  const RATE = 16000;
  let ctx = null, opened = [], auto = false, manual = false, cfg = null, curKey = '', gen = 0;
  const vads = {}, mbuf = { them: [], me: [] };
  let onError = () => {};

  const toInt16 = (f32) => { const o = new Int16Array(f32.length); for (let i = 0; i < f32.length; i++) { const v = Math.max(-1, Math.min(1, f32[i])); o[i] = v < 0 ? v * 32768 : v * 32767; } return o; };
  function handle(who, f32) {
    const i16 = toInt16(f32);
    if (manual) { mbuf[who].push(i16); if (mbuf[who].length > 480) mbuf[who].shift(); return; } // ~120s
    if (!auto) return;
    const seg = vads[who].feed(i16);
    if (seg) window.api.sendSegment(seg.buffer.slice(seg.byteOffset, seg.byteOffset + seg.byteLength), who);
  }
  async function stream(who) {
    if (who === 'me') return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
    const s = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
    s.getVideoTracks().forEach((t) => t.stop());
    if (!s.getAudioTracks().length) throw new Error('Không lấy được âm thanh hệ thống (macOS cần BlackHole/Loopback; hãy chọn nguồn Micro).');
    return s;
  }
  async function open(c) {
    cfg = c;
    const key = [c.source, c.silence].join('|');
    if (ctx) { if (key === curKey) return; close(); }   // đổi nguồn/ngưỡng -> mở lại
    curKey = key; const my = ++gen;
    ctx = new AudioContext({ sampleRate: RATE });
    const want = c.source === 'both' ? ['them', 'me'] : c.source === 'mic' ? ['me'] : ['them'];
    for (const who of want) {
      try {
        const s = await stream(who);
        if (my !== gen) { s.getTracks().forEach((t) => t.stop()); return; }   // đã bị đóng trong lúc chờ cấp quyền
        const src = ctx.createMediaStreamSource(new MediaStream(s.getAudioTracks()));
        const proc = ctx.createScriptProcessor(4096, 1, 1);
        vads[who] = new Vad({ rate: RATE, threshold: c.silence });
        proc.onaudioprocess = (e) => handle(who, e.inputBuffer.getChannelData(0));
        src.connect(proc); proc.connect(ctx.destination);
        opened.push({ s, src, proc });
      } catch (e) { onError(`Không mở được nguồn "${who === 'me' ? 'micro' : 'âm thanh hệ thống'}": ${e.message}`); }
    }
    if (my === gen && !opened.length) close();
  }
  function close() {
    gen++;
    opened.forEach(({ s, src, proc }) => { try { proc.disconnect(); src.disconnect(); s.getTracks().forEach((t) => t.stop()); } catch {} });
    opened = []; if (ctx) { try { ctx.close(); } catch {} ctx = null; }
  }
  const cat = (arr) => { if (!arr.length) return null; let n = 0; arr.forEach((a) => (n += a.length)); const o = new Int16Array(n); let p = 0; arr.forEach((a) => { o.set(a, p); p += a.length; }); return o.buffer; };

  return {
    setErrorHandler(f) { onError = f; },
    async command(kind, v, c) {
      if (kind === 'reload') { close(); if (auto || manual) await open(c); }
      else if (kind === 'auto') { auto = !!v; if (auto) await open(c); else if (!manual) close(); }
      else if (kind === 'manual-start') { mbuf.them = []; mbuf.me = []; manual = true; await open(c); }
      else if (kind === 'manual-stop') {
        manual = false; const out = { them: cat(mbuf.them), me: cat(mbuf.me) }; mbuf.them = []; mbuf.me = [];
        window.api.sendManual(out); if (!auto) close();
      }
    },
  };
})();
