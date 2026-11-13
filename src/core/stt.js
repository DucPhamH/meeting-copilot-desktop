'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { RECOVERABLE } = require('./util');

// deps: { emit, notice, rootDir, userDir }
function createStt({ emit, notice, rootDir, userDir }) {
  let worker = null, readyP = null, pending = [], buf = '';

  const pyCandidates = () => [
    path.join(userDir, 'venv', 'bin', 'python'), path.join(userDir, 'venv', 'Scripts', 'python.exe'),
    path.join(rootDir, '.venv', 'bin', 'python'), path.join(rootDir, '.venv', 'Scripts', 'python.exe'),
  ];
  const findPy = () => pyCandidates().find((p) => fs.existsSync(p));
  const hasLocal = () => !!findPy();

  const rm = (f) => { if (f) try { fs.unlinkSync(f); } catch {} };
  function failAll(err) { pending.splice(0).forEach((p) => { clearTimeout(p.timer); rm(p.file); p.reject(err); }); }

  function start(cfg) {
    if (worker) return readyP;
    const py = findPy();
    if (!py) throw new Error('Chưa cài Whisper local (xem README). Hãy chọn phiên âm bằng API trong ⚙.');
    const script = path.join(__dirname, '..', 'stt_worker.py').replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
    const w = spawn(py, ['-I', script], {
      env: { ...process.env, WHISPER_MODEL: cfg.whisperModel || 'small', WHISPER_LANG: cfg.language || '', PYTHONUNBUFFERED: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    worker = w; buf = '';
    w.stdout.setEncoding('utf8');
    let err = '', settled = false, resolveReady, rejectReady;
    readyP = new Promise((res, rej) => { resolveReady = res; rejectReady = rej; });
    readyP.catch(() => {}); // tránh unhandled
    const loadTimer = setTimeout(() => { if (!settled) { settled = true; rejectReady(new Error('Nạp model Whisper quá lâu (timeout 10 phút).')); stop(); } }, 600000);
    w.stdout.on('data', (d) => {
      buf += d; let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let j; try { j = JSON.parse(line); } catch { continue; }
        if (j.status === 'loading') emit({ kind: 'status', state: 'loading', text: `Đang nạp Whisper "${j.model}" (lần đầu có thể tải vài trăm MB)…` });
        else if (j.status === 'ready') { settled = true; clearTimeout(loadTimer); resolveReady(); emit({ kind: 'status', state: 'ready', text: 'Whisper local sẵn sàng' }); }
        else { const p = pending.shift(); if (p) { clearTimeout(p.timer); j.error ? p.reject(new Error(j.error)) : p.resolve(j.text || ''); } }
      }
    });
    w.stderr.on('data', (d) => { err = (err + d).slice(-600); });
    w.on('error', (e) => { err += e.message; });
    w.on('close', () => {
      clearTimeout(loadTimer);
      if (worker === w) { worker = null; readyP = null; }
      const e = new Error('Whisper local dừng đột ngột: ' + err.replace(/\s+/g, ' ').slice(-200));
      if (!settled) { settled = true; rejectReady(e); }
      failAll(e);
    });
    return readyP;
  }
  function stop() { if (worker) { try { worker.kill(); } catch {} worker = null; readyP = null; } pending.splice(0).forEach((p) => { clearTimeout(p.timer); rm(p.file); p.reject(new Error('Whisper local đã dừng')); }); }

  async function local(cfg, wav) {
    const ready = start(cfg);
    await ready;
    const f = path.join(os.tmpdir(), `mc-seg-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`);
    fs.writeFileSync(f, wav, { mode: 0o600 });
    return new Promise((resolve, reject) => {
      const p = { resolve, reject, timer: null, file: f };
      p.timer = setTimeout(() => { // worker treo -> khởi động lại ở lần sau
        const i = pending.indexOf(p); if (i >= 0) pending.splice(i, 1);
        try { fs.unlinkSync(f); } catch {}
        reject(new Error('Whisper local timeout')); stop();
      }, 90000);
      pending.push(p);
      try { worker.stdin.write(f + '\n'); } catch (e) { clearTimeout(p.timer); pending.splice(pending.indexOf(p), 1); reject(e); }
    });
  }

  async function viaApi(cfg, wav) {
    if (!cfg.apiKey) throw new Error('Chưa có API key để phiên âm (⚙) — hoặc chọn Whisper trên máy.');
    const fd = new FormData();
    fd.append('model', cfg.sttModel);
    fd.append('temperature', '0');
    if (cfg.sttPrompt) fd.append('prompt', cfg.sttPrompt);
    if (cfg.language) fd.append('language', cfg.language);
    fd.append('file', new Blob([wav], { type: 'audio/wav' }), 'a.wav');
    const r = await fetch(cfg.baseUrl + '/audio/transcriptions', {
      method: 'POST', headers: { Authorization: `Bearer ${cfg.apiKey}` }, body: fd, signal: AbortSignal.timeout(Number(process.env.MC_STT_TIMEOUT_MS) || 30000),
    });
    if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`);
    return ((await r.json()).text || '').trim();
  }

  async function transcribe(cfg, wav) {
    if (cfg.sttMode === 'local') return local(cfg, wav);
    try { return await viaApi(cfg, wav); }
    catch (e) {
      if (!RECOVERABLE.test(String(e.message)) || !hasLocal()) throw e;
      notice('⚠ API phiên âm lỗi/hết hạn mức → tạm chuyển sang Whisper trên máy');
      return local(cfg, wav);
    }
  }
  return { transcribe, warmup: (cfg) => start(cfg), stop, hasLocal };
}
module.exports = { createStt };
