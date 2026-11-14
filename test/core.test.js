'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const U = require('../src/core/util');
const Vad = require('../src/core/vad');
const C = require('../src/core/config');
const MD = require('../src/core/md');
const { createBus } = require('../src/core/bus');

// ---------- helpers ----------
const RATE = 16000;
const tone = (ms, amp = 8000) => { const n = RATE * ms / 1000, a = new Int16Array(n); for (let i = 0; i < n; i++) a[i] = Math.round(amp * Math.sin(i * 0.3)); return a; };
const quiet = (ms, amp = 20) => { const n = RATE * ms / 1000, a = new Int16Array(n); for (let i = 0; i < n; i++) a[i] = Math.round((Math.random() - 0.5) * amp); return a; };
function frames(a, ms = 100) { const n = RATE * ms / 1000, out = []; for (let i = 0; i < a.length; i += n) out.push(a.subarray(i, i + n)); return out; }
function run(vad, ...parts) { const segs = []; for (const p of parts) for (const f of frames(p)) { const s = vad.feed(f); if (s) segs.push(s); } const t = vad.flush(); if (t) segs.push(t); return segs; }
const ms = (s) => s.length / RATE * 1000;

// ---------- util ----------
test('normPcm khuếch đại âm nhỏ, không đụng âm đủ to, giới hạn gain', () => {
  const small = Buffer.alloc(200); for (let i = 0; i < 100; i++) small.writeInt16LE(i % 2 ? 1000 : -1000, i * 2);
  const o = U.normPcm(small); assert.ok(U.peakOf(o) > 6000 && U.peakOf(o) <= 32767);
  const loud = Buffer.alloc(200); for (let i = 0; i < 100; i++) loud.writeInt16LE(i % 2 ? 25000 : -25000, i * 2);
  assert.equal(U.normPcm(loud), loud);
  const tiny = Buffer.alloc(200); for (let i = 0; i < 100; i++) tiny.writeInt16LE(i % 2 ? 10 : -10, i * 2);
  assert.ok(U.peakOf(U.normPcm(tiny)) <= 10 * 10 + 1, 'gain tối đa 10x');
  assert.equal(U.normPcm(Buffer.alloc(0)).length, 0);
  assert.equal(U.normPcm(Buffer.alloc(1)).length === 1 || true, true); // byte lẻ không crash
});
test('wavFromPcm có header hợp lệ', () => {
  const pcm = Buffer.alloc(3200); const w = U.wavFromPcm(pcm, 16000, false);
  assert.equal(w.toString('ascii', 0, 4), 'RIFF'); assert.equal(w.toString('ascii', 8, 12), 'WAVE');
  assert.equal(w.readUInt32LE(24), 16000); assert.equal(w.readUInt32LE(40), 3200); assert.equal(w.length, 44 + 3200);
});
test('similar nhận ra tiếng vọng, không nhầm câu khác', () => {
  assert.ok(U.similar('Bạn có thể giải thích Docker là gì không', 'bạn có thể giải thích docker là gì không?'));
  assert.ok(U.similar('what is the difference between REST and GraphQL', 'What is the difference between rest and graphql'));
  assert.ok(!U.similar('Docker là gì', 'Kubernetes dùng để làm gì thế'));
  assert.ok(!U.similar('ok', 'ok'), 'quá ngắn thì không kết luận');
  assert.ok(!U.similar('', 'abc def ghi'));
});
test('tooShortForAI', () => {
  assert.ok(U.tooShortForAI('122')); assert.ok(U.tooShortForAI('alo alo'));
  assert.ok(!U.tooShortForAI('Docker là gì?')); assert.ok(!U.tooShortForAI('bạn làm gì ở công ty cũ'));
});
test('looksLikeQuestion: nhận câu hỏi (vi/en, có/không dấu ?), bỏ chào hỏi', () => {
  for (const q of ['Bạn có thể giải thích sự khác nhau giữa Docker và máy ảo không', 'Bạn đã từng triển khai lên Kubernetes như thế nào', 'REST là gì',
    'Hãy kể về dự án khó nhất của bạn', 'What is the difference between REST and GraphQL', 'Tell me about yourself', 'Docker?', 'Can you walk me through it'])
    assert.ok(U.looksLikeQuestion(q), q);
  for (const s of ['Chào mọi người, hôm nay trời đẹp quá nhỉ, mình bắt đầu họp thôi', 'Một hai ba bốn', 'ok cảm ơn nhé', 'Tôi đã làm việc ở công ty này ba năm', ''])
    assert.ok(!U.looksLikeQuestion(s), s);
});
test('PHANTOM chặn câu ma của Whisper', () => {
  for (const s of ['Thanks for watching!', 'Cảm ơn các bạn đã theo dõi', 'Subtitles by the Amara.org community', 'you', '...']) assert.ok(U.PHANTOM.test(s), s);
  for (const s of ['Bạn dùng Docker thế nào?', 'Tell me about yourself']) assert.ok(!U.PHANTOM.test(s), s);
});
test('friendlyError và RECOVERABLE', () => {
  assert.match(U.friendlyError(new Error('401 {"error":"Invalid API Key"}')), /API key sai/);
  assert.match(U.friendlyError(new Error('codex lỗi (mã 1): unexpected status 401 Unauthorized: Missing bearer')), /codex login/i);
  assert.match(U.friendlyError(new Error('claude lỗi (mã 1): 401 Unauthorized')), /claude/i);
  assert.doesNotMatch(U.friendlyError(new Error('codex lỗi (mã 1): 401 Unauthorized')), /API key sai/);
  assert.match(U.friendlyError(new Error('404 model_not_found')), /Tên model/);
  assert.match(U.friendlyError(new Error('429 rate limit')), /giới hạn/);
  assert.match(U.friendlyError(new Error('fetch failed')), /kết nối/);
  assert.ok(U.RECOVERABLE.test('429 {"error":"rate limit"}')); assert.ok(U.RECOVERABLE.test('fetch failed'));
  assert.ok(!U.RECOVERABLE.test('401 invalid key')); assert.ok(!U.RECOVERABLE.test('404 model_not_found'));
  assert.equal(typeof U.friendlyError(undefined), 'string');
});

// ---------- VAD ----------
test('VAD: im lặng hoàn toàn -> không có câu', () => {
  assert.equal(run(new Vad(), quiet(3000)).length, 0);
});
test('VAD: một câu 1.5s -> đúng 1 đoạn, có giữ đầu câu', () => {
  const s = run(new Vad(), quiet(1000), tone(1500), quiet(1000));
  assert.equal(s.length, 1);
  assert.ok(ms(s[0]) >= 1500 && ms(s[0]) <= 1500 + 300 + 700, 'dài ' + ms(s[0]));
  const lead = [...s[0].subarray(0, 9000)].findIndex((v) => Math.abs(v) > 3000);
  assert.ok(lead >= 3000 && lead <= 5200, 'còn pre-roll ~300ms (4800 mẫu) trước tiếng nói, lead=' + lead);
});
test('VAD: tiếng "bụp" ngắn bị loại', () => {
  assert.equal(run(new Vad(), quiet(500), tone(200), quiet(1500)).length, 0);
});
test('VAD: tiếng quá nhỏ (dưới ngưỡng) bị loại', () => {
  assert.equal(run(new Vad(), tone(2000, 300), quiet(1000)).length, 0);
});
test('VAD: tiếng chỉ vừa chạm ngưỡng (đỉnh < 1.5x) bị loại', () => {
  // rms của sin biên độ A ~ A/1.414; threshold .015*32768=491 -> A≈ 800 cho rms 566 (1.15x)
  assert.equal(run(new Vad(), tone(2000, 800), quiet(1000)).length, 0);
});
test('VAD: nói liên tục 25s -> cắt mỗi ≤10s, không mất tiếng', () => {
  const s = run(new Vad(), tone(25000));
  assert.ok(s.length >= 3, 'số đoạn ' + s.length);
  s.forEach((x) => assert.ok(ms(x) <= 10100, 'đoạn quá dài ' + ms(x)));
  const total = s.reduce((a, x) => a + ms(x), 0); assert.ok(total > 23000, 'tổng ' + total);
});
test('VAD: hai câu cách nhau 1s -> 2 đoạn', () => {
  assert.equal(run(new Vad(), tone(1200), quiet(1000), tone(1200), quiet(1000)).length, 2);
});
test('VAD: ngập ngừng 300ms giữa câu vẫn là 1 đoạn', () => {
  assert.equal(run(new Vad(), tone(1000), quiet(300), tone(1000), quiet(1000)).length, 1);
});
test('VAD: khung bất thường (rỗng, 1 mẫu) không làm sập', () => {
  const v = new Vad(); assert.doesNotThrow(() => { v.feed(new Int16Array(0)); v.feed(new Int16Array(1)); v.flush(); });
});
test('VAD: flush trả nốt câu đang dở', () => {
  const v = new Vad(); const segs = []; for (const f of frames(tone(1500))) { const s = v.feed(f); if (s) segs.push(s); }
  assert.equal(segs.length, 0); assert.ok(v.flush());
});

// ---------- config ----------
test('config.sanitize chịu được dữ liệu rác', () => {
  const def = C.defaults();
  const c = C.sanitize({ port: 'abc', silence: 99, opacity: -5, fontSize: 1000, provider: 'evil', sttMode: 5, source: null,
    baseUrl: 'javascript:alert(1)', cliModel: 'haiku; rm -rf /', token: 'ZZ', language: 'vi<script>', serve: 'true', apiKey: 12345, mode: 'x' }, def);
  assert.equal(c.port, 8765); assert.equal(c.silence, 0.1); assert.equal(c.opacity, 0.3); assert.equal(c.fontSize, 26);
  assert.equal(c.provider, 'api'); assert.equal(c.sttMode, def.sttMode); assert.equal(c.source, 'both');
  assert.equal(c.baseUrl, def.baseUrl); assert.equal(c.cliModel, ''); assert.equal(c.token, ''); assert.equal(c.language, '');
  assert.equal(c.serve, true); assert.equal(c.apiKey, ''); assert.equal(c.mode, 'normal');
  assert.deepEqual(C.sanitize(null, def), def); assert.deepEqual(C.sanitize('x', def), def);
});
test('config.sanitize giữ giá trị hợp lệ, bỏ dấu / cuối baseUrl', () => {
  const c = C.sanitize({ baseUrl: 'https://api.groq.com/openai/v1///', provider: 'claude', cliModel: 'claude-haiku-5-5', port: 9000, token: 'abcdef1234567890' }, C.defaults());
  assert.equal(c.baseUrl, 'https://api.groq.com/openai/v1'); assert.equal(c.provider, 'claude'); assert.equal(c.port, 9000); assert.equal(c.token, 'abcdef1234567890');
});
test('config.sanitize recAskMode: mặc định fillAndSend, bỏ giá trị lạ', () => {
  assert.equal(C.defaults().recAskMode, 'fillAndSend');
  assert.equal(C.sanitize({ recAskMode: 'fill' }, C.defaults()).recAskMode, 'fill');
  assert.equal(C.sanitize({ recAskMode: 'evil' }, C.defaults()).recAskMode, 'fillAndSend');
});
test('config.store: ghi nguyên tử, quyền 600, tệp hỏng không làm sập', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-')); const f = path.join(dir, 's.json');
  const st = C.createStore(f);
  assert.equal(st.load().provider, 'api');
  st.save({ apiKey: 'k', provider: 'claude' });
  assert.equal(st.load().provider, 'claude'); assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  assert.ok(!fs.existsSync(f + '.tmp'));
  fs.writeFileSync(f, '{broken json');
  assert.equal(st.load().provider, 'api'); assert.ok(fs.existsSync(f + '.corrupt'));
  st.save({ provider: 'codex' }); assert.equal(st.load().provider, 'codex');
});

// ---------- markdown ----------
test('MD: đậm, code, danh sách, khối code', () => {
  const b = MD.parse('Xin **chào** `x`\n\n- một\n- hai\n\n1. a\n2. b\n\n```js\nlet a = 1;\n```');
  assert.equal(b[0].t, 'p'); assert.deepEqual(b[0].inl.map((x) => x.t), ['text', 'b', 'text', 'code']);
  assert.equal(b[1].t, 'ul'); assert.equal(b[1].items.length, 2); assert.equal(b[2].t, 'ol');
  assert.equal(b[3].t, 'code'); assert.equal(b[3].text, 'let a = 1;'); assert.equal(b[3].lang, 'js');
});
test('MD: văn bản dở dang khi đang stream không sập', () => {
  assert.doesNotThrow(() => MD.parse('```py\nprint(1)')); assert.doesNotThrow(() => MD.parse('**chưa đóng')); assert.doesNotThrow(() => MD.parse('`'));
  assert.equal(MD.parse('```py\nprint(1)')[0].text, 'print(1)');
  assert.equal(MD.parse('**chưa đóng')[0].inl[0].t, 'text');
  assert.deepEqual(MD.parse(''), []);
});
test('MD: HTML/script chỉ là chữ (không có cách chèn thẻ)', () => {
  const b = MD.parse('<img src=x onerror=alert(1)> **<b>**');
  const flat = JSON.stringify(b); assert.ok(flat.includes('<img')); // giữ nguyên là text; DOM builder dùng textContent
  assert.ok(b.every((x) => ['p', 'ul', 'ol', 'code', 'h'].includes(x.t)));
});

// ---------- bus ----------
test('bus: gộp delta, không lưu status, giới hạn bộ nhớ', () => {
  const bus = createBus(5); const got = []; bus.on((e) => got.push(e.kind));
  bus.emit({ kind: 'status', state: 'thinking' }); bus.emit({ kind: 'delta', id: 'a', text: 'x' }); bus.emit({ kind: 'delta', id: 'a', text: 'y' });
  assert.equal(bus.recent().length, 1); assert.equal(bus.recent()[0].text, 'xy'); assert.equal(bus.status().state, 'thinking');
  for (let i = 0; i < 20; i++) bus.emit({ kind: 'heard', id: i, text: 'h' });
  assert.equal(bus.recent().length, 5);
  bus.on(() => { throw new Error('x'); }); assert.doesNotThrow(() => bus.emit({ kind: 'error', text: 'e' }));
});
