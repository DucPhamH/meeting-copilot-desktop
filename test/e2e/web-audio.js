'use strict';
// E2E cho đường thu âm của Windows/macOS (renderer + getUserMedia), chạy ngay trên Linux bằng micro giả của Chromium.
const { spawn, execSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const root = path.join(__dirname, '..', '..');
const real = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.config', 'meeting-copilot', 'settings.json'), 'utf8'));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-web-'));
const PORT = 8812, TOKEN = 'e2e0123456789abd';
fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ apiKey: real.apiKey, baseUrl: real.baseUrl, sttModel: real.sttModel, llmModel: real.llmModel, sttMode: 'api', provider: 'api', language: 'vi', source: 'mic', answerMic: true, serve: true, port: PORT, token: TOKEN }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = []; const check = (n, ok, x = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${x ? '  — ' + x : ''}`); };
const events = [];
const waitFor = async (pred, ms, from = 0) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const e = events.slice(from).find(pred); if (e) return e; await sleep(100); } return null; };
const post = (p) => new Promise((res) => { const r = http.request({ host: '127.0.0.1', port: PORT, path: p + '?k=' + TOKEN, method: 'POST' }, (x) => { x.resume(); x.on('end', () => res(x.statusCode)); }); r.on('error', () => res(0)); r.end(); });
const get = (p) => new Promise((res) => http.get({ host: '127.0.0.1', port: PORT, path: p + '?k=' + TOKEN }, (x) => { let d = ''; x.on('data', (c) => (d += c)); x.on('end', () => res(d)); }).on('error', () => res('')));
const shot = async (name, js = '') => { fs.writeFileSync(path.join(dataDir, 'shot.req'), js); await sleep(1800); fs.copyFileSync(path.join(dataDir, 'shot.png'), path.join(root, 'test', 'e2e', name)); };

(async () => {
  const app = spawn('xvfb-run', ['-a', '-s', '-screen 0 1280x800x24', path.join(root, 'node_modules/electron/dist/electron'), root, '--no-sandbox', '--disable-gpu', '--ozone-platform=x11',
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--use-file-for-fake-audio-capture=' + path.join(root, 'test/audio/mic_loop.wav')],
    { env: { ...process.env, MC_USER_DATA: dataDir, MC_E2E: '1', MC_FORCE_WEB_AUDIO: '1' }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; app.stdout.on('data', (d) => (log += d)); app.stderr.on('data', (d) => (log += d));
  for (let i = 0; i < 60; i++) { if ((await get('/state')).includes('status')) break; await sleep(500); }
  http.get({ host: '127.0.0.1', port: PORT, path: '/stream?k=' + TOKEN }, (res) => { let b = ''; res.on('data', (d) => { b += d; let i; while ((i = b.indexOf('\n\n')) >= 0) { const m = b.slice(0, i); b = b.slice(i + 2); if (m.startsWith('data:')) events.push(JSON.parse(m.slice(5))); } }); }).on('error', () => {});
  await sleep(800);
  await shot('ui_empty.png');

  // nghe liên tục qua renderer
  let m = events.length; await post('/listen');
  const h = await waitFor((e) => e.kind === 'heard' && e.who === 'me', 40000, m);
  check('WEB auto: micro giả -> nhận dạng được qua renderer (who=me)', /kubernetes|triển khai/i.test(h?.text || ''), h?.text);
  const d = await waitFor((e) => e.kind === 'delta', 30000, m); check('WEB auto: AI trả lời', !!d);
  await shot('ui_chat.png');
  await post('/listen'); await sleep(2500); m = events.length; await sleep(12000);
  check('WEB auto: tắt nghe -> không còn câu mới (đã đóng micro)', !events.slice(m).some((e) => e.kind === 'heard'), `${events.slice(m).filter((e) => e.kind === 'heard').length} câu`);

  // ghi thủ công qua renderer
  m = events.length; await post('/rec'); await sleep(10000); await post('/rec');
  const h2 = await waitFor((e) => e.kind === 'heard', 40000, m);
  check('WEB manual: ghi -> dừng -> nhận dạng', /kubernetes|triển khai/i.test(h2?.text || ''), h2?.text);
  const d2 = await waitFor((e) => e.kind === 'delta', 30000, m); check('WEB manual: AI trả lời', !!d2);
  await shot('ui_settings.png', "document.getElementById('gear').click()");

  process.kill(-app.pid, 'SIGTERM'); await sleep(2500);
  check('thoát sạch', (await get('/state')) === '');
  const fails = results.filter((x) => !x).length; console.log(`\n${results.length - fails}/${results.length} đạt`);
  if (fails) console.log(log.split('\n').filter((l) => !/dbus|gpu|ERROR:|Gtk|libva/i.test(l)).slice(-12).join('\n'));
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
