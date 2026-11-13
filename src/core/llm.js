'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { RECOVERABLE } = require('./util');

const MODE_HINT = {
  short: 'Trả lời CỰC NGẮN: 1-2 câu.',
  normal: 'Trả lời ngắn gọn 2-4 câu hoặc vài gạch đầu dòng, để đọc to ngay.',
  detailed: 'Trả lời chi tiết, có cấu trúc rõ ràng (ý chính rồi giải thích), nhưng không dài dòng.',
  interview: 'Trả lời như một ứng viên phỏng vấn giỏi: tự tin, nêu ví dụ cụ thể (theo cấu trúc STAR nếu là câu hỏi kinh nghiệm), 3-5 câu.',
  tech: 'Trả lời kỹ thuật chính xác, nêu đánh đổi (trade-off); thêm ví dụ/code ngắn nếu hữu ích.',
};

function extras(cfg) {
  let s = '';
  if (cfg.profile) s += `\n\nHỒ SƠ CỦA NGƯỜI DÙNG (trả lời đúng góc nhìn của họ; KHÔNG bịa thêm thông tin về họ):\n${cfg.profile}`;
  if (cfg.context) s += `\n\nBối cảnh thêm: ${cfg.context}`;
  return s;
}
const hint = (cfg) => MODE_HINT[cfg.mode] || MODE_HINT.normal;

const common = (cfg) =>
  'Viết câu trả lời ở NGÔI THỨ NHẤT, như chính người dùng đang nói với đối phương (dùng "tôi/mình"), để họ đọc to ngay. ' +
  'Không nhắc mình là AI/trợ lý, không lặp lại câu hỏi, không viết các cụm như "Câu hỏi là…" hay "Trả lời:", vào thẳng nội dung. ' +
  'CHỈ trả lời câu hỏi/yêu cầu MỚI NHẤT trong phần "ĐOẠN MỚI"; phần ngữ cảnh cũ chỉ để hiểu, tuyệt đối không trả lời lại các câu cũ. ' +
  (cfg.profile
    ? 'Dùng HỒ SƠ bên dưới để nói đúng kinh nghiệm của người dùng; điều gì hồ sơ không nói thì không khẳng định là đã làm. '
    : 'Người dùng chưa cung cấp hồ sơ: KHÔNG bịa kinh nghiệm cá nhân/nền tảng/số liệu cụ thể (vd "tôi đã làm trên GKE"); hãy nói theo cách làm phổ biến ("thường mình sẽ…"). ') +
  'Phiên âm tự động hay nghe sai thuật ngữ kỹ thuật (vd "DLCKL" có thể là "Docker", "Coup de Hitz" là "Kubernetes"): hãy suy ra thuật ngữ đúng từ ngữ cảnh. ' +
  (cfg.sttPrompt ? `Từ vựng có thể xuất hiện: ${cfg.sttPrompt} ` : '') + hint(cfg);

const sysListen = (cfg) =>
  'Bạn là trợ lý ngầm giúp người dùng trả lời câu hỏi của đối phương trong cuộc họp. Bạn nhận một đoạn phiên âm tự động.\n' +
  'QUY TẮC: Chỉ trả lời khi đoạn đó là một CÂU HỎI hoặc YÊU CẦU rõ ràng, đầy đủ ý (kiến thức, kinh nghiệm, quan điểm, kỹ thuật, công việc). ' +
  'Nếu là chào hỏi, bình luận, thử micro, đếm số, từ rời rạc, câu bỏ lửng, hoặc không phải câu hỏi -> chỉ trả về đúng một từ: NONE. ' +
  'Ví dụ phải trả NONE: "chào mọi người", "alo 1 2 3", "ok mình bắt đầu nhé", "hôm nay trời đẹp quá nhỉ".\n' + common(cfg) + extras(cfg);
const sysAsk = (cfg) =>
  'Bạn là trợ lý ngầm cho người dùng trong cuộc họp. Dựa vào nội dung cuộc họp gần đây nếu liên quan. Dùng ngôn ngữ của người dùng. ' + common(cfg) + extras(cfg);

// ---------- Nguồn chữ: API tương thích OpenAI ----------
async function* apiDeltas(cfg, messages, signal) {
  if (!cfg.apiKey) throw new Error('Chưa nhập API key cho AI (⚙) — hoặc chọn Claude Code trên máy.');
  const ctl = new AbortController();
  const onAbort = () => ctl.abort();
  if (signal) signal.addEventListener('abort', onAbort);
  const first = setTimeout(() => ctl.abort(new Error('timeout chờ phản hồi đầu tiên')), Number(process.env.MC_FIRST_BYTE_MS) || 25000);
  let r;
  try {
    r = await fetch(cfg.baseUrl + '/chat/completions', {
      method: 'POST', signal: ctl.signal,
      headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: cfg.llmModel, temperature: 0.3, stream: true, max_tokens: 700, messages,
        ...(/gpt-oss/.test(cfg.llmModel) ? { reasoning_effort: 'low' } : {}),
      }),
    });
    if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`);
  } catch (e) { clearTimeout(first); if (signal) signal.removeEventListener('abort', onAbort); throw e; }
  const reader = r.body.getReader(), dec = new TextDecoder();
  let buf = '', idle = null;
  const idleMs = Number(process.env.MC_IDLE_MS) || 30000;
  try {
    for (;;) {
      clearTimeout(idle); idle = setTimeout(() => ctl.abort(new Error('timeout: server ngừng gửi dữ liệu')), idleMs); // chống treo giữa luồng
      const { done, value } = await reader.read();
      clearTimeout(first); clearTimeout(idle);
      if (done) return;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line.startsWith('data:') || line.includes('[DONE]')) continue;
        try { const t = JSON.parse(line.slice(5)).choices?.[0]?.delta?.content; if (t) yield t; } catch {}
      }
    }
  } finally {
    clearTimeout(first); clearTimeout(idle);
    if (signal) signal.removeEventListener('abort', onAbort);
    reader.cancel().catch(() => {});
  }
}

// ---------- Nguồn chữ: CLI đã đăng nhập (claude / codex) ----------
const WIN = process.platform === 'win32';
// Windows: claude/codex thường là shim .cmd nên phải qua cmd.exe. Tự quote từng tham số (KHÔNG dùng shell:true vì nó nối chuỗi không quote).
const winQuote = (a) => (a === '' || /[\s"&|<>^%()]/.test(a) ? '"' + String(a).replace(/"/g, '\\"') + '"' : a);
function spawnCli(cmd, args, opts) {
  if (!WIN) return spawn(cmd, args, opts);
  const line = '"' + [cmd, ...args].map(winQuote).join(' ') + '"';
  return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', line], { ...opts, windowsVerbatimArguments: true, windowsHide: true });
}
function killTree(p) {
  try { if (WIN && p.pid) spawn('taskkill', ['/pid', String(p.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); else p.kill(); } catch {}
}
async function* cliDeltas(cfg, messages, signal) {
  const sys = messages.find((x) => x.role === 'system')?.content || '';
  const userMsgs = messages.filter((x) => x.role === 'user').map((x) => x.content);
  if (userMsgs.some((c) => typeof c !== 'string')) throw new Error('Chế độ CLI chưa hỗ trợ ảnh — dùng provider API có vision.');
  const user = userMsgs.join('\n');
  const isClaude = cfg.provider === 'claude';
  const cmd = isClaude ? 'claude' : 'codex';
  let sysFile = null, args;
  if (isClaude) {
    sysFile = path.join(os.tmpdir(), `mc-sys-${process.pid}-${Date.now()}.txt`);
    fs.writeFileSync(sysFile, sys, { mode: 0o600 });
    args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--no-session-persistence', '--tools', '', '--system-prompt-file', sysFile, '--model', cfg.cliModel || 'haiku'];
  } else {
    args = ['exec', '--skip-git-repo-check', '--ephemeral', '-s', 'read-only', ...(cfg.cliModel ? ['-m', cfg.cliModel] : []), '-'];
  }
  // Lời nhắn đi qua stdin: không lộ trong danh sách tiến trình, không dính giới hạn độ dài dòng lệnh.
  const stdinText = isClaude ? user : sys + '\n\n---\n' + user;
  const p = spawnCli(cmd, args, { cwd: os.tmpdir(), stdio: ['pipe', 'pipe', 'pipe'] });
  p.stdout.setEncoding('utf8'); p.stderr.setEncoding('utf8');   // không làm hỏng ký tự tiếng Việt khi bị cắt giữa chunk
  let spawnErr = null, stderr = '', code = null, ended = false, timedOut = false;
  p.on('error', (e) => { spawnErr = e; ended = true; wake(); });
  p.stderr.on('data', (d) => { stderr = (stderr + d).slice(-800); });
  p.stdin.on('error', () => {});
  p.stdin.end(stdinText);
  const q = [], waiters = [];
  function wake() { waiters.splice(0).forEach((w) => w()); }
  let buf = '', gotAny = false;
  p.stdout.on('data', (d) => {
    if (!isClaude) { q.push(String(d)); gotAny = true; return wake(); }
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      try {
        const j = JSON.parse(line);
        const t = j.type === 'stream_event' && j.event?.delta?.type === 'text_delta' && j.event.delta.text;
        if (t) { q.push(t); gotAny = true; }
        else if (j.type === 'result' && j.is_error) stderr = String(j.result || stderr);
      } catch {}
    }
    wake();
  });
  p.on('close', (c) => { code = c; ended = true; wake(); });
  const kill = () => killTree(p);
  const timer = setTimeout(() => { timedOut = true; kill(); }, Number(process.env.MC_CLI_TIMEOUT_MS) || 70000);
  const onAbort = () => kill();
  if (signal) signal.addEventListener('abort', onAbort);
  try {
    for (;;) {
      if (q.length) { yield q.shift(); continue; }
      if (ended) break;
      await new Promise((r) => waiters.push(r));
    }
  } finally {
    clearTimeout(timer); kill();
    if (signal) signal.removeEventListener('abort', onAbort);
    if (sysFile) fs.unlink(sysFile, () => {});
  }
  if (spawnErr) throw new Error(`Không chạy được "${cmd}": ${spawnErr.message}. Đã cài và đăng nhập chưa?`);
  if (timedOut && !gotAny) throw new Error(`${cmd} timeout (hết thời gian chờ)`);
  if (!gotAny && code) throw new Error(`${cmd} lỗi (mã ${code}): ${stderr.replace(/\s+/g, ' ').slice(0, 200)}`);
}

const cliLabel = (c) => `${c.provider === 'codex' ? 'Codex' : 'Claude Code'} trên máy · ${c.cliModel || (c.provider === 'codex' ? 'mặc định' : 'haiku')}`;

async function* withFallback(cfg, messages, info, notice, signal) {
  if (cfg.provider !== 'api') { info.label = cliLabel(cfg); return yield* cliDeltas(cfg, messages, signal); }
  info.label = `API · ${cfg.llmModel}`;
  let started = false;
  try { for await (const t of apiDeltas(cfg, messages, signal)) { started = true; yield t; } }
  catch (e) {
    if (started || (signal && signal.aborted) || !RECOVERABLE.test(String(e.message))) throw e;
    notice('⚠ API AI lỗi/hết hạn mức → tạm chuyển sang Claude Code trên máy');
    const alt = { ...cfg, provider: 'claude' };
    info.label = cliLabel(alt) + ' (dự phòng)';
    try { yield* cliDeltas(alt, messages, signal); }
    catch (e2) { throw new Error(`${e.message} — dự phòng Claude Code cũng lỗi: ${e2.message}`); }
  }
}

// Phát chữ ra từng đoạn. gate=true: nếu AI trả "NONE" thì không hiện gì.
// Trả về { text, label, shown, ms:{first,total} }
async function chatStream(cfg, messages, { gate, onDelta, notice, signal }) {
  const info = { label: '' };
  const t0 = Date.now();
  let held = '', open = !gate, full = '', first = null;
  const show = (t) => { if (first == null) first = Date.now() - t0; onDelta(t); };
  for await (const t of withFallback(cfg, messages, info, notice, signal)) {
    full += t;
    if (open) { show(t); continue; }
    held += t;
    const up = held.replace(/[.\s]/g, '').toUpperCase();
    if (up.length >= 4 && !up.startsWith('NONE')) { open = true; show(held); }
    else if (up.length > 8) break;
  }
  if (!open && held && !/^\W*NONE\W*$/i.test(held)) { open = true; show(held); }
  return { text: full, label: info.label, shown: open && !!full.trim(), ms: { first, total: Date.now() - t0 } };
}

module.exports = { chatStream, sysListen, sysAsk, apiDeltas, cliDeltas, withFallback, MODE_HINT };
