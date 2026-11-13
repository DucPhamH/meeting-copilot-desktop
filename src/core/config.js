'use strict';
const fs = require('fs');
const path = require('path');

const DEFAULT_STT_PROMPT = 'Cuộc họp về công nghệ bằng tiếng Việt, xen lẫn thuật ngữ tiếng Anh như API, Docker, Kubernetes, backend, frontend, database.';
const ENUMS = {
  provider: ['api', 'claude', 'codex'],
  sttMode: ['api', 'local'],
  source: ['both', 'system', 'mic'],
  mode: ['short', 'normal', 'detailed', 'interview', 'tech'],
};
const MAXLEN = { context: 6000, profile: 12000, sttPrompt: 1000 };

function defaults(opts = {}) {
  return {
    apiKey: '', baseUrl: 'https://api.openai.com/v1', sttModel: 'whisper-1', llmModel: 'gpt-4o-mini',
    language: '', context: '', profile: '', mode: 'normal', source: 'both', silence: 0.015,
    provider: 'api', cliModel: '', sttPrompt: DEFAULT_STT_PROMPT,
    sttMode: opts.hasLocalWhisper ? 'local' : 'api', answerMic: true, whisperModel: 'small',
    captureTarget: '', serve: opts.serve != null ? opts.serve : false, port: 8765, token: '', opacity: 0.9, fontSize: 16,
  };
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

// Ép mọi giá trị về dạng hợp lệ (người dùng/tệp hỏng không làm app sập)
function sanitize(raw, def) {
  raw = raw && typeof raw === 'object' ? raw : {};
  const out = { ...def };
  for (const k of Object.keys(def)) {
    if (!(k in raw)) continue;
    const v = raw[k], d = def[k];
    if (typeof d === 'string') out[k] = typeof v === 'string' ? v.trim().slice(0, MAXLEN[k] || 500) : d;
    else if (typeof d === 'boolean') out[k] = typeof v === 'boolean' ? v : v === 'true' ? true : v === 'false' ? false : d;
    else if (typeof d === 'number') { const n = Number(v); out[k] = Number.isFinite(n) ? n : d; }
  }
  for (const [k, list] of Object.entries(ENUMS)) if (!list.includes(out[k])) out[k] = def[k];
  out.port = Math.round(clamp(out.port, 1024, 65535));
  out.silence = clamp(out.silence, 0.003, 0.1);
  out.opacity = clamp(out.opacity, 0.3, 1);
  out.fontSize = Math.round(clamp(out.fontSize, 12, 26));
  try {
    const u = new URL(out.baseUrl);
    if (!/^https?:$/.test(u.protocol)) throw new Error('proto');
    out.baseUrl = out.baseUrl.replace(/\/+$/, '');
  } catch { out.baseUrl = def.baseUrl; }
  if (!/^[a-f0-9]{8,64}$/.test(out.token)) out.token = '';
  if (!/^[\w.:\/-]*$/.test(out.cliModel)) out.cliModel = '';
  if (!/^[\w.:\/-]*$/.test(out.whisperModel) || !out.whisperModel) out.whisperModel = def.whisperModel;
  if (!/^[a-zA-Z-]{0,8}$/.test(out.language)) out.language = '';
  if (!/^[\w.:\-]{0,120}$/.test(out.captureTarget)) out.captureTarget = '';
  return out;
}

function createStore(file, defOpts = {}) {
  const def = () => defaults(defOpts);
  const readRaw = () => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) {
      if (e.code !== 'ENOENT') { try { fs.copyFileSync(file, file + '.corrupt'); } catch {} } // giữ bản hỏng để cứu
      return {};
    }
  };
  return {
    load: () => sanitize(readRaw(), def()),
    save(partial) {
      const next = sanitize({ ...readRaw(), ...partial }, def());
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, file); // ghi nguyên tử, không để lại tệp dở dang
      return next;
    },
  };
}

module.exports = { defaults, sanitize, createStore, DEFAULT_STT_PROMPT };
