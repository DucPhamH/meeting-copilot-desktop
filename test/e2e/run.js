'use strict';
// E2E thật: app Electron (xvfb) + âm thanh phát qua PipeWire + Groq/Claude thật.
const { spawn, execSync, spawnSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const root = path.join(__dirname, '..', '..');
const AUD = path.join(root, 'test', 'audio');
const SINK = 'mc-test-sink';
const real = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.config', 'meeting-copilot', 'settings.json'), 'utf8'));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-e2e-'));
const PORT = 8811, TOKEN = 'e2e0123456789abc';
const base = { apiKey: real.apiKey, baseUrl: real.baseUrl, sttModel: real.sttModel, llmModel: real.llmModel, sttMode: 'api', provider: 'api', language: 'vi', source: 'system', captureTarget: SINK, mode: 'normal', answerMic: true, serve: true, port: PORT, token: TOKEN, silence: 0.015 };
const setCfg = (o) => fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ ...base, ...o }));
setCfg({});

// thiết bị phát ảo: cô lập khỏi âm thanh thật của máy (video, nhạc…)
const sinkId = () => { try { const d = JSON.parse(execSync('pw-dump', { maxBuffer: 1e8 }).toString()); const o = d.find((x) => x.info && x.info.props && x.info.props['node.name'] === SINK); return o ? o.id : null; } catch { return null; } };
const makeSink = () => { if (sinkId() == null) execSync(`pw-cli create-node adapter '{ factory.name=support.null-audio-sink node.name=${SINK} media.class=Audio/Sink object.linger=true audio.position=[FL,FR] }'`, { stdio: 'ignore' }); };
const dropSink = () => { const id = sinkId(); if (id != null) { try { execSync(`pw-cli destroy ${id}`, { stdio: 'ignore' }); } catch {} } };
makeSink(); process.on('exit', dropSink);
const results = []; const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (name, ok, extra = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); };
const events = []; let sseReq;
const since = (i) => events.slice(i);
const waitFor = async (pred, ms = 20000, from = 0) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const e = events.slice(from).find(pred); if (e) return e; await sleep(100); } return null; };
const post = (p, body) => new Promise((res) => { const r = http.request({ host: '127.0.0.1', port: PORT, path: p + '?k=' + TOKEN, method: 'POST' }, (x) => { x.resume(); x.on('end', () => res(x.statusCode)); }); r.on('error', () => res(0)); if (body) r.write(body); r.end(); });
const get = (p) => new Promise((res) => http.get({ host: '127.0.0.1', port: PORT, path: p + '?k=' + TOKEN }, (x) => { let d = ''; x.on('data', (c) => (d += c)); x.on('end', () => res(d)); }).on('error', () => res('')));
const play = (f, vol = 0.5) => new Promise((res) => { const p = spawn('pw-play', ['--target', SINK, '--volume=' + vol, path.join(AUD, f + '.wav')]); p.on('close', res); });
const count = (re) => { try { return execSync(`pgrep -fc "${re}" || true`).toString().trim() | 0; } catch { return 0; } };
const lastStatus = () => [...events].reverse().find((e) => e.kind === 'status');
const mark = () => events.length;
const answerText = (from) => events.slice(from).filter((e) => e.kind === 'delta').map((e) => e.text).join('');

function connect() {
  sseReq = http.get({ host: '127.0.0.1', port: PORT, path: '/stream?k=' + TOKEN }, (res) => {
    let buf = ''; res.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n\n')) >= 0) { const m = buf.slice(0, i); buf = buf.slice(i + 2); if (m.startsWith('data:')) { const e = JSON.parse(m.slice(5)); e._t = Date.now(); events.push(e); } } });
  }); sseReq.on('error', () => {});
}

(async () => {
  const baselinePw = count('[p]w-record');
  const app = spawn('xvfb-run', ['-a', '-s', '-screen 0 1280x800x24', path.join(root, 'node_modules/electron/dist/electron'), root, '--no-sandbox', '--disable-gpu', '--ozone-platform=x11'],
    { env: { ...process.env, MC_USER_DATA: dataDir, MC_E2E: '1' }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let appLog = ''; app.stdout.on('data', (d) => (appLog += d)); app.stderr.on('data', (d) => (appLog += d));
  for (let i = 0; i < 60; i++) { if ((await get('/state')).includes('status')) break; await sleep(500); }
  check('app khởi động & máy chủ điện thoại lên', (await get('/state')).includes('"status"'));
  connect(); await sleep(800);

  // S1: nghe liên tục, câu hỏi tiếng Việt từ loa
  let m = mark(); await post('/listen'); await sleep(1500);
  check('bật nghe liên tục -> trạng thái listening', lastStatus()?.state === 'listening', JSON.stringify(lastStatus()));
  check('có đúng 1 tiến trình thu loa (source=system)', count('[p]w-record') - baselinePw === 1, `đếm ${count('[p]w-record') - baselinePw}`);
  const tPlay = Date.now(); await play('vi_docker'); const tEnd = Date.now();
  const heard = await waitFor((e) => e.kind === 'heard', 20000, m);
  check('S1 nghe được lời người khác (who=them)', heard?.who === 'them', heard?.text);
  check('S1 chữ nhận dạng đúng phần tiếng Việt (giọng tổng hợp đọc "Docker" nên có thể sai thuật ngữ)', /giải thích.*máy ảo/i.test(heard?.text || ''), heard?.text);
  const d1 = await waitFor((e) => e.kind === 'delta', 25000, m);
  check('S1 AI trả lời câu hỏi (stream)', !!d1, d1 ? `chữ đầu sau ${((d1._t - tEnd) / 1000).toFixed(1)}s kể từ khi nói xong` : '');
  const meta = await waitFor((e) => e.kind === 'meta', 25000, m);
  check('S1 có dòng nguồn + thời gian', /API · .*nghe .*chữ đầu .*xong/.test(meta?.text || ''), meta?.text);
  console.log('      trả lời:', answerText(m).slice(0, 160).replace(/\n/g, ' '));

  // S2: câu không phải câu hỏi
  m = mark(); await play('vi_chat'); await sleep(9000);
  check('S2 câu chào/không phải câu hỏi -> AI im lặng', !events.slice(m).some((e) => e.kind === 'delta'), `heard: ${events.slice(m).filter((e) => e.kind === 'heard').map((e) => e.text).join(' | ')}`);
  // S3: đếm số
  m = mark(); await play('en_count'); await sleep(7000);
  check('S3 "one two three four" -> AI im lặng', !events.slice(m).some((e) => e.kind === 'delta'));
  // S4: dừng
  await post('/listen'); await sleep(1500);
  check('S4 tắt nghe -> không còn tiến trình thu âm', count('[p]w-record') - baselinePw === 0, `còn ${count('[p]w-record') - baselinePw}`);

  // S5: ghi thủ công
  m = mark(); await post('/rec'); await sleep(1200);
  check('S5 đang ghi -> trạng thái recording', lastStatus()?.state === 'recording', JSON.stringify(lastStatus()));
  await play('vi_k8s'); await sleep(500); await post('/rec');
  const h5 = await waitFor((e) => e.kind === 'heard', 20000, m);
  check('S5 ghi thủ công nhận dạng được', /kubernetes|k8s|triển khai/i.test(h5?.text || ''), h5?.text);
  const d5 = await waitFor((e) => e.kind === 'delta', 25000, m);
  check('S5 AI trả lời đoạn đã ghi', !!d5); console.log('      trả lời:', answerText(m).slice(0, 160).replace(/\n/g, ' '));
  await sleep(1000);
  check('S5 dừng ghi -> tắt tiến trình thu âm', count('[p]w-record') - baselinePw === 0);

  // S6: ghi im lặng
  m = mark(); await post('/rec'); await sleep(2500); await post('/rec');
  const e6 = await waitFor((e) => e.kind === 'error', 8000, m);
  check('S6 ghi im lặng -> báo "không nghe thấy", không gọi AI', /Không nghe thấy/.test(e6?.text || '') && !events.slice(m).some((e) => e.kind === 'delta'), e6?.text);

  // S7: gõ câu hỏi
  m = mark(); await post('/ask', 'REST API là gì? Trả lời đúng một câu.');
  const d7 = await waitFor((e) => e.kind === 'delta', 20000, m);
  check('S7 gõ câu hỏi -> có trả lời', !!d7); await sleep(2500);

  // S8: Claude Code trên máy
  setCfg({ provider: 'claude', cliModel: 'haiku' }); m = mark(); await post('/ask', 'GraphQL là gì? Trả lời đúng một câu.');
  const meta8 = await waitFor((e) => e.kind === 'meta', 60000, m);
  check('S8 Claude Code trên máy trả lời thật', /Claude Code trên máy · haiku/.test(meta8?.text || ''), meta8?.text); console.log('      trả lời:', answerText(m).slice(0, 160).replace(/\n/g, ' '));

  // S9: Whisper local
  setCfg({ provider: 'claude', cliModel: 'haiku', sttMode: 'local', whisperModel: 'small' });
  m = mark(); await post('/rec'); await sleep(8000); await play('vi_docker'); await sleep(300); await post('/rec');
  const h9 = await waitFor((e) => e.kind === 'heard', 90000, m);
  check('S9 Whisper local (small) nhận dạng được phần lớn câu', /giải thích|sự khác nhau|máy/i.test(h9?.text || ''), h9?.text);
  const d9 = await waitFor((e) => e.kind === 'delta', 60000, m); check('S9 …và Claude trả lời', !!d9);

  // S10: API STT chết (mạng) -> tự chuyển Whisper local
  setCfg({ provider: 'claude', cliModel: 'haiku', sttMode: 'api', baseUrl: 'http://127.0.0.1:9' });
  m = mark(); await post('/rec'); await sleep(800); await play('vi_k8s'); await sleep(300); await post('/rec');
  const w10 = await waitFor((e) => e.kind === 'error' && /Whisper trên máy/.test(e.text), 60000, m);
  const h10 = await waitFor((e) => e.kind === 'heard', 60000, m);
  check('S10 API phiên âm chết -> cảnh báo + tự dùng Whisper local', !!w10 && !!h10, h10?.text);

  // S11: key sai
  setCfg({ provider: 'api', sttMode: 'api', apiKey: 'gsk_sai_roi' });
  m = mark(); await post('/rec'); await sleep(800); await play('vi_k8s'); await sleep(300); await post('/rec');
  const e11 = await waitFor((e) => e.kind === 'error', 30000, m);
  check('S11 key sai -> báo "API key sai" (không treo)', /API key sai/.test(e11?.text || ''), e11?.text);

  // ảnh giao diện
  setCfg({}); await sleep(500);
  fs.writeFileSync(path.join(dataDir, 'shot.req'), ''); await sleep(1500);
  fs.copyFileSync(path.join(dataDir, 'shot.png'), path.join(root, 'test', 'e2e', 'ui.png'));

  // S12: dọn dẹp khi thoát
  await post('/listen'); await sleep(1000);
  const answersLog = fs.existsSync(path.join(dataDir, 'answers.log')) ? fs.readFileSync(path.join(dataDir, 'answers.log'), 'utf8') : '';
  check('S12 answers.log ghi nguồn model', /API ·|Claude Code/.test(answersLog), `${answersLog.split('\n').filter(Boolean).length} dòng`);
  process.kill(-app.pid, 'SIGTERM'); await sleep(3000);
  check('S12 thoát app -> không còn pw-record mồ côi', count('[p]w-record') - baselinePw === 0, `còn ${count('[p]w-record') - baselinePw}`);
  check('S12 thoát app -> không còn worker whisper', count('[s]tt_worker') === 0);
  check('S12 thoát app -> đóng cổng', (await get('/state')) === '');

  sseReq && sseReq.destroy();
  const fails = results.filter((r) => !r.ok);
  console.log(`\n${results.length - fails.length}/${results.length} đạt`); if (fails.length) console.log('Hỏng:', fails.map((f) => f.name).join('; '));
  if (fails.length) console.log('--- log app ---\n' + appLog.split('\n').filter((l) => !/dbus|gpu|ERROR:|Gtk|libva/i.test(l)).slice(-15).join('\n'));
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('E2E lỗi:', e); process.exit(2); });
