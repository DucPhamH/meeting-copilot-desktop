'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const http = require('http'), net = require('net'), fs = require('fs'), os = require('os'), path = require('path');
const { createNativeAudio } = require('../src/core/native-audio');
const { createWebServer } = require('../src/core/server');
const { createBus } = require('../src/core/bus');
const C = require('../src/core/config');

const RATE = 16000, FB = 3200;
const frame = (amp) => { const b = Buffer.alloc(FB); for (let i = 0; i < FB / 2; i++) b.writeInt16LE(amp ? Math.round(amp * Math.sin(i * 0.3)) : 0, i * 2); return b; };
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

// ---------- native audio ----------
function fakeSpawn(plan = {}) {
  const spawned = [];
  const fn = (cmd, args) => {
    const p = new EventEmitter(); p.stdout = new PassThrough(); p.killed = false;
    p.kill = () => { p.killed = true; setImmediate(() => p.emit('close', 0)); };
    p.cmd = cmd; p.args = args; spawned.push(p);
    if (plan[cmd] === 'enoent') setImmediate(() => p.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })));
    return p;
  };
  fn.spawned = spawned; return fn;
}
const mk = (over = {}, plan) => {
  const cfg = C.sanitize({ source: 'system', ...over }, C.defaults());
  const segs = [], events = []; const spawnFn = fakeSpawn(plan);
  const a = createNativeAudio({ loadCfg: () => cfg, emit: (e) => events.push(e), onSegment: (pcm, who) => segs.push({ pcm, who }), spawnFn });
  return { a, segs, events, spawnFn };
};
async function feed(p, amp, n) { for (let i = 0; i < n; i++) { p.stdout.write(frame(amp)); await tick(0); } }

test('audio: auto -> câu nói thành đoạn, đúng nguồn "them", dùng monitor của loa', async () => {
  const { a, segs, spawnFn } = mk(); a.startAuto(); await tick();
  const p = spawnFn.spawned[0]; assert.equal(p.cmd, 'pw-record'); assert.ok(p.args.includes('stream.capture.sink=true'));
  await feed(p, 0, 5); await feed(p, 9000, 15); await feed(p, 0, 8);
  assert.equal(segs.length, 1); assert.equal(segs[0].who, 'them'); assert.ok(segs[0].pcm.length >= 15 * FB); a.killAll();
});
test('audio: source=both mở 2 luồng (loa + micro), micro KHÔNG có cờ monitor', async () => {
  const { a, spawnFn } = mk({ source: 'both' }); a.startAuto(); await tick();
  assert.equal(spawnFn.spawned.length, 2);
  const [sys, mic] = [spawnFn.spawned.find((p) => p.args.includes('stream.capture.sink=true')), spawnFn.spawned.find((p) => !p.args.includes('stream.capture.sink=true'))];
  assert.ok(sys && mic); a.killAll();
});
test('audio: source=mic chỉ mở micro; frame lẻ (chunk bất kỳ) vẫn ghép đúng', async () => {
  const { a, segs, spawnFn } = mk({ source: 'mic' }); a.startAuto(); await tick();
  assert.equal(spawnFn.spawned.length, 1);
  const all = Buffer.concat([...Array(5)].map(() => frame(0)).concat([...Array(15)].map(() => frame(9000))).concat([...Array(8)].map(() => frame(0))));
  for (let i = 0; i < all.length; i += 777) { spawnFn.spawned[0].stdout.write(all.subarray(i, i + 777)); await tick(0); }
  assert.equal(segs.length, 1); assert.equal(segs[0].who, 'me'); a.killAll();
});
test('audio: ghi thủ công gom đủ, KHÔNG phát đoạn tự động trong lúc ghi, tắt tiến trình khi xong', async () => {
  const { a, segs, spawnFn } = mk(); a.manualStart(); await tick();
  const p = spawnFn.spawned[0]; await feed(p, 9000, 20); await feed(p, 0, 10);
  const out = await a.manualStop(); assert.equal(segs.length, 0);
  assert.equal(out.them.length, 30 * FB); assert.equal(out.me, null); await tick(); assert.ok(p.killed); assert.equal(a.count(), 0);
});
test('audio: ghi thủ công giữ tối đa 120s gần nhất', async () => {
  const { a, spawnFn } = mk(); a.manualStart(); await tick();
  const p = spawnFn.spawned[0]; for (let i = 0; i < 1300; i++) { p.stdout.write(frame(5000)); if (i % 100 === 0) await tick(0); }
  await tick(20); const out = await a.manualStop(); assert.ok(out.them.length <= 1200 * FB && out.them.length >= 1100 * FB, String(out.them.length / FB));
});
test('audio: stopAuto không tắt luồng nếu đang ghi thủ công', async () => {
  const { a, spawnFn } = mk(); a.startAuto(); a.manualStart(); await tick(); a.stopAuto(); await tick();
  assert.equal(spawnFn.spawned[0].killed, false); await a.manualStop(); await tick(); assert.ok(spawnFn.spawned[0].killed);
});
test('audio: pw-record không có -> tự thử parec', async () => {
  const { a, spawnFn, events } = mk({}, { 'pw-record': 'enoent' }); a.startAuto(); await tick(30);
  assert.ok(spawnFn.spawned.some((p) => p.cmd === 'parec')); assert.equal(events.length, 0); a.killAll();
});
test('audio: không có cả hai -> báo lỗi rõ ràng', async () => {
  const { a, events } = mk({}, { 'pw-record': 'enoent', parec: 'enoent' }); a.startAuto(); await tick(40);
  assert.match(events[0].text, /pw-record\/parec/);
});
test('audio: tiến trình chết bất ngờ -> tự nối lại tối đa 3 lần rồi báo', async () => {
  const { a, spawnFn, events } = mk();
  const orig = global.setTimeout; global.setTimeout = (f, ms, ...r) => orig(f, ms > 100 ? 5 : ms, ...r);
  try {
    a.startAuto(); await tick();
    for (let i = 0; i < 4; i++) { const p = spawnFn.spawned[spawnFn.spawned.length - 1]; p.emit('close', 1); await tick(30); }
    const n = spawnFn.spawned.length; assert.equal(n, 4, 'spawn lần đầu + 3 lần nối lại, thực tế ' + n);
    assert.ok(events.some((e) => /nhiều lần/.test(e.text))); a.killAll();
  } finally { global.setTimeout = orig; }
});
test('audio: killAll rồi không tự nối lại', async () => {
  const { a, spawnFn, events } = mk(); a.startAuto(); await tick(); a.killAll(); await tick(1200);
  assert.equal(spawnFn.spawned.length, 1); assert.equal(events.length, 0);
});

test('audio: dừng rồi bật lại trong 1s KHÔNG sinh tiến trình thu thứ hai (nối lại cũ bị huỷ)', async () => {
  const { a, spawnFn } = mk();
  a.startAuto(); await tick(); spawnFn.spawned[0].emit('close', 1);       // chết bất ngờ -> hẹn nối lại sau 1s
  a.stopAuto(); a.startAuto(); await tick(1300);
  assert.equal(a.count(), 1, 'số nguồn thu đang chạy: ' + a.count());
  assert.equal(spawnFn.spawned.filter((p) => !p.killed).length <= 2, true); a.killAll();
});
test('audio: chạy ổn định >30s thì bộ đếm nối lại được làm mới', async () => {
  const { a, spawnFn, events } = mk(); const realNow = Date.now; let t = realNow();
  Date.now = () => t;
  const orig = global.setTimeout; global.setTimeout = (f, ms, ...r) => orig(f, ms > 100 ? 5 : ms, ...r);
  try {
    a.startAuto(); await tick();
    for (let i = 0; i < 6; i++) { t += 31000; spawnFn.spawned[spawnFn.spawned.length - 1].emit('close', 1); await tick(30); }
    assert.ok(spawnFn.spawned.length >= 7, 'vẫn nối lại sau nhiều lần đứt: ' + spawnFn.spawned.length);
    assert.ok(!events.some((e) => /nhiều lần/.test(e.text))); a.killAll();
  } finally { Date.now = realNow; global.setTimeout = orig; }
});
test('audio: reload() áp dụng cài đặt mới (khởi động lại nguồn thu)', async () => {
  const cfg = C.sanitize({ source: 'system' }, C.defaults()); const spawnFn = fakeSpawn(); const events = [];
  const a = createNativeAudio({ loadCfg: () => cfg, emit: (e) => events.push(e), onSegment: () => {}, spawnFn });
  a.startAuto(); await tick(); const first = spawnFn.spawned[0]; cfg.captureTarget = 'my-sink'; a.reload(); await tick();
  assert.equal(first.killed, true); const second = spawnFn.spawned[spawnFn.spawned.length - 1];
  assert.ok(second.args.includes('--target') && second.args.includes('my-sink')); a.reload(); a.killAll();
});

// ---------- server ----------
async function freePort() { return new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); }); }
function req(port, p, { method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method }, (res) => { let d = ''; res.on('data', (x) => (d += x)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d })); });
    r.on('error', reject); if (body) r.write(body); r.end();
  });
}
async function mkServer(over = {}) {
  const port = await freePort(); let cfg = C.sanitize({ serve: true, port, ...over }, C.defaults());
  const bus = createBus(); const calls = { ask: [], rec: 0, listen: 0, clear: 0 };
  const srv = createWebServer({ getCfg: () => cfg, saveCfg: (p) => { cfg = C.sanitize({ ...cfg, ...p }, C.defaults()); }, bus,
    handlers: { ask: (t) => calls.ask.push(t), rec: () => calls.rec++, listen: () => calls.listen++, clear: () => calls.clear++ }, getState: () => ({ ok: 1 }), host: '127.0.0.1' });
  const actual = await srv.start();
  return { srv, bus, calls, port: actual, K: srv.token(), getCfg: () => cfg };
}

test('server: serve=false -> không mở cổng', async () => { const s = await mkServer({ serve: false }); assert.equal(s.port, null); });
test('server: tạo token, từ chối thiếu/sai token, chống dò mã', async () => {
  const s = await mkServer(); assert.match(s.K, /^[a-f0-9]{16}$/); assert.equal(s.getCfg().token, s.K);
  assert.equal((await req(s.port, '/')).status, 403); assert.equal((await req(s.port, '/?k=sai')).status, 403);
  assert.equal((await req(s.port, '/?k=' + 'a'.repeat(16))).status, 403);
  let last; for (let i = 0; i < 12; i++) last = await req(s.port, '/?k=x' + i);
  assert.equal(last.status, 429, 'dò quá nhiều lần bị chặn');
  assert.equal((await req(s.port, '/?k=' + s.K)).status, 200, 'chủ có token đúng vẫn vào được dù có kẻ dò mã');
  s.srv.stop();
});
test('server: trang điện thoại xoá nội dung cũ khi nối lại (không hiện đôi câu trả lời)', async () => {
  const s = await mkServer(); const home = await req(s.port, '/?k=' + s.K); assert.match(home.body, /es\.onopen=\(\)=>\{L\.textContent=''/); s.srv.stop();
});
test('server: trang chủ, md.js, state, 404, 405, header bảo mật', async () => {
  const s = await mkServer(); const k = '?k=' + s.K;
  const home = await req(s.port, '/' + k); assert.equal(home.status, 200); assert.match(home.headers['content-security-policy'], /default-src 'self'/); assert.equal(home.headers['x-content-type-options'], 'nosniff');
  assert.match(home.body, /EventSource/); assert.match((await req(s.port, '/md.js' + k)).body, /MD/);
  assert.equal(JSON.parse((await req(s.port, '/state' + k)).body).ok, 1);
  assert.equal((await req(s.port, '/zzz' + k)).status, 404); assert.equal((await req(s.port, '/' + k, { method: 'PUT' })).status, 405); s.srv.stop();
});
test('server: /ask /rec /listen /clear gọi đúng handler; body quá lớn bị từ chối', async () => {
  const s = await mkServer(); const k = '?k=' + s.K;
  await req(s.port, '/ask' + k, { method: 'POST', body: 'Docker là gì?' }); await req(s.port, '/rec' + k, { method: 'POST' });
  await req(s.port, '/listen' + k, { method: 'POST' }); await req(s.port, '/clear' + k, { method: 'POST' });
  assert.deepEqual(s.calls.ask, ['Docker là gì?']); assert.equal(s.calls.rec, 1); assert.equal(s.calls.listen, 1); assert.equal(s.calls.clear, 1);
  const big = await req(s.port, '/ask' + k, { method: 'POST', body: 'x'.repeat(10000) }).catch((e) => ({ status: 'reset' }));
  assert.ok(big.status === 413 || big.status === 'reset'); assert.equal(s.calls.ask.length, 1); s.srv.stop();
});
test('server: giới hạn 30 thao tác/phút', async () => {
  const s = await mkServer(); const k = '?k=' + s.K; let last;
  for (let i = 0; i < 32; i++) last = await req(s.port, '/rec' + k, { method: 'POST' });
  assert.equal(last.status, 429); assert.equal(s.calls.rec, 30); s.srv.stop();
});
function sse(port, k, onEvent) {
  return new Promise((resolve) => {
    const r = http.get({ host: '127.0.0.1', port, path: '/stream' + k }, (res) => {
      let buf = ''; res.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n\n')) >= 0) { const m = buf.slice(0, i); buf = buf.slice(i + 2); if (m.startsWith('data:')) onEvent(JSON.parse(m.slice(5))); } });
      resolve({ res, close: () => r.destroy() });
    });
  });
}
test('server: SSE phát lại lịch sử, nhận sự kiện mới, dọn khi ngắt', async () => {
  const s = await mkServer(); const k = '?k=' + s.K;
  s.bus.emit({ kind: 'heard', id: 'a', who: 'them', text: 'cũ' }); s.bus.emit({ kind: 'delta', id: 'a', text: 'tr' }); s.bus.emit({ kind: 'delta', id: 'a', text: 'ả lời' });
  const got = []; const c = await sse(s.port, k, (e) => got.push(e)); await tick(50);
  assert.ok(got.some((e) => e.kind === 'status')); assert.ok(got.some((e) => e.text === 'cũ')); assert.ok(got.some((e) => e.kind === 'delta' && e.text === 'trả lời'));
  s.bus.emit({ kind: 'heard', id: 'b', who: 'me', text: 'mới' }); await tick(50); assert.ok(got.some((e) => e.text === 'mới'));
  assert.equal(s.srv.clients(), 1); c.close(); await tick(60); assert.equal(s.srv.clients(), 0); s.srv.stop();
});
test('server: tối đa 20 kết nối SSE', async () => {
  const s = await mkServer(); const k = '?k=' + s.K; const cs = [];
  for (let i = 0; i < 20; i++) cs.push(await sse(s.port, k, () => {})); await tick(50);
  assert.equal(s.srv.clients(), 20); assert.equal((await req(s.port, '/stream' + k)).status, 503); cs.forEach((c) => c.close()); s.srv.stop();
});
test('server: cổng bận -> tự dùng cổng kế tiếp; stop/start lại được', async () => {
  const port = await freePort(); const blocker = net.createServer().listen(port, '127.0.0.1'); await tick(20);
  const bus = createBus(); let cfg = C.sanitize({ serve: true, port }, C.defaults());
  const srv = createWebServer({ getCfg: () => cfg, saveCfg: (p) => (cfg = C.sanitize({ ...cfg, ...p }, C.defaults())), bus, handlers: {}, host: '127.0.0.1' });
  const p1 = await srv.start(); assert.equal(p1, port + 1); assert.match(srv.url(), new RegExp(`:${port + 1}/\\?k=`));
  srv.stop(); assert.equal(srv.url(), ''); const p2 = await srv.start(); assert.ok(p2); srv.stop(); blocker.close();
});
test('server: handler ném lỗi không làm sập server', async () => {
  const port = await freePort(); let cfg = C.sanitize({ serve: true, port }, C.defaults());
  const srv = createWebServer({ getCfg: () => cfg, saveCfg: (p) => (cfg = C.sanitize({ ...cfg, ...p }, C.defaults())), bus: createBus(), handlers: { ask() { throw new Error('boom'); } }, host: '127.0.0.1' });
  await srv.start(); const k = '?k=' + srv.token();
  assert.equal((await req(port, '/ask' + k, { method: 'POST', body: 'x' })).status, 200); assert.equal((await req(port, '/' + k)).status, 200); srv.stop();
});
