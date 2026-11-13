'use strict';
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path');

// Server giả kiểu OpenAI. behavior thay đổi được trong lúc test.
function mockApi() {
  const b = { stt: { text: 'Docker là gì?', status: 200, delay: 0, body: null }, chat: { mode: 'ok', answer: 'Docker là nền tảng container hoá.', status: 200, delay: 0 }, calls: { stt: 0, chat: 0 }, lastChat: null };
  const srv = http.createServer((req, res) => {
    const chunks = []; req.on('data', (d) => chunks.push(d));
    req.on('end', async () => {
      const body = Buffer.concat(chunks);
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      if (req.url.endsWith('/audio/transcriptions')) {
        const n = ++b.calls.stt; const t = typeof b.stt.text === 'function' ? b.stt.text(n) : b.stt.text; await sleep(b.stt.delay);
        res.writeHead(b.stt.status, { 'Content-Type': 'application/json' });
        return res.end(b.stt.body || JSON.stringify(b.stt.status === 200 ? { text: t } : { error: { message: 'stt err ' + b.stt.status } }));
      }
      if (req.url.endsWith('/chat/completions')) {
        b.calls.chat++; b.lastChat = JSON.parse(body.toString()); await sleep(b.chat.delay);
        const c = b.chat;
        if (c.status !== 200) { res.writeHead(c.status, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { message: c.status === 404 ? 'model_not_found' : 'err ' + c.status } })); }
        if (c.mode === 'hang') return; // không trả lời
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const send = (t) => res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: t } }] }) + '\n\n');
        if (c.mode === 'empty') { res.write('data: ' + JSON.stringify({ choices: [{ delta: { reasoning: 'hmm' } }] }) + '\n\n'); return res.end('data: [DONE]\n\n'); }
        if (c.mode === 'none') { send('NO'); send('NE'); return res.end('data: [DONE]\n\n'); }
        if (c.mode === 'stall') { send('Docker là '); return; } // gửi một đoạn rồi im lặng, không đóng
        if (c.mode === 'cut') { send('Docker là '); setTimeout(() => res.destroy(), 30); return; }
        for (const w of c.answer.split(/(?<= )/)) { send(w); await sleep(2); }
        return res.end('data: [DONE]\n\n');
      }
      res.writeHead(404); res.end();
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ b, port: srv.address().port, url: `http://127.0.0.1:${srv.address().port}`, close: () => { srv.closeAllConnections?.(); srv.close(); } })));
}

// `claude` giả để test cliDeltas mà không tốn hạn mức. FAKE_MODE: ok | fail | hang | echo
function fakeClaudeDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-fake-'));
  const f = path.join(dir, 'claude');
  fs.writeFileSync(f, `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
let sys = ''; const i = args.indexOf('--system-prompt-file'); if (i >= 0) sys = fs.readFileSync(args[i + 1], 'utf8');
let input = ''; process.stdin.on('data', (d) => (input += d)).on('end', () => {
  const mode = process.env.FAKE_MODE || 'ok';
  if (mode === 'fail') { process.stderr.write('Not logged in'); process.exit(1); }
  if (mode === 'hang') return setTimeout(() => {}, 100000);
  const out = (t) => console.log(JSON.stringify({ type: 'stream_event', event: { delta: { type: 'text_delta', text: t } } }));
  console.log(JSON.stringify({ type: 'system', subtype: 'init' }));
  if (mode === 'echo') out('SYS[' + sys.slice(0, 80).replace(/\\n/g, ' ') + '] IN[' + input.trim().slice(-60).replace(/\\n/g, ' ') + '] M[' + args[args.indexOf('--model') + 1] + ']');
  else { out('Trả lời '); out('từ claude giả.'); }
  console.log(JSON.stringify({ type: 'result', is_error: false }));
});
`, { mode: 0o755 });
  return dir;
}
module.exports = { mockApi, fakeClaudeDir };
