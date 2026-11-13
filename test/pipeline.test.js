'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { mockApi, fakeClaudeDir } = require('./helpers');

process.env.MC_FIRST_BYTE_MS = '600';
process.env.MC_CLI_TIMEOUT_MS = '800';
process.env.MC_STT_TIMEOUT_MS = '600';
process.env.MC_IDLE_MS = '500';
const fakeDir = fakeClaudeDir();
process.env.PATH = fakeDir + path.delimiter + process.env.PATH;

const C = require('../src/core/config');
const { createStt } = require('../src/core/stt');
const llm = require('../src/core/llm');
const { createPipeline } = require('../src/core/pipeline');
const { createBus } = require('../src/core/bus');

const RATE = 16000;
function speechPcm(ms = 1500, amp = 9000) { const n = RATE * ms / 1000, b = Buffer.alloc(n * 2); for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(amp * Math.sin(i * 0.3)), i * 2); return b; }

async function setup(over = {}) {
  const api = await mockApi();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-t-'));
  let cfg = C.sanitize({ apiKey: 'k', baseUrl: api.url, sttMode: 'api', provider: 'api', llmModel: 'm', sttModel: 's', ...over }, C.defaults());
  const bus = createBus(); const events = []; bus.on((e) => events.push(e));
  const emit = (e) => bus.emit(e);
  const notice = (t) => emit({ kind: 'error', text: t });
  const stt = createStt({ emit, notice, rootDir: dir, userDir: dir });
  const logFile = path.join(dir, 'answers.log');
  let listening = false;
  const p = createPipeline({ loadCfg: () => cfg, emit, stt, llm, isListening: () => listening, logFile });
  return { api, p, events, bus, dir, logFile, setCfg: (o) => { cfg = C.sanitize({ ...cfg, ...o }, C.defaults()); }, kinds: () => events.filter((e) => e.kind !== 'status').map((e) => e.kind), close: () => api.close() };
}
const text = (ev, kind) => ev.filter((e) => e.kind === kind).map((e) => e.text || '').join('');

test('luồng chuẩn: nghe -> heard -> câu trả lời stream -> meta có thời gian + ghi log', async () => {
  const t = await setup();
  t.p.handleSegment(speechPcm(), 'them'); await t.p.whenIdle();
  const k = t.kinds();
  assert.deepEqual(k.slice(0, 2), ['heard', 'delta'], k.join());
  assert.equal(t.events.find((e) => e.kind === 'heard').who, 'them');
  assert.equal(text(t.events, 'delta'), 'Docker là nền tảng container hoá.');
  const meta = t.events.find((e) => e.kind === 'meta'); assert.match(meta.text, /API · m .*nghe .*chữ đầu .*xong/);
  assert.match(fs.readFileSync(t.logFile, 'utf8'), /API · m/);
  assert.ok(t.events.some((e) => e.kind === 'status' && e.state === 'transcribing'));
  assert.ok(t.events.some((e) => e.kind === 'status' && e.state === 'thinking'));
  assert.equal(t.events.filter((e) => e.kind === 'status').pop().state, 'idle');
  t.close();
});

test('âm thanh quá ngắn / quá nhỏ bị bỏ, không tốn lượt gọi API', async () => {
  const t = await setup();
  t.p.handleSegment(speechPcm(300), 'them'); t.p.handleSegment(speechPcm(2000, 100), 'them'); t.p.handleSegment(null, 'them'); t.p.handleSegment(Buffer.alloc(0), 'me');
  await t.p.whenIdle(); assert.equal(t.api.b.calls.stt, 0); assert.equal(t.events.filter((e) => e.kind !== 'status').length, 0); t.close();
});

test('AI trả NONE -> im lặng hoàn toàn (không delta, không meta, không lỗi)', async () => {
  const t = await setup(); t.api.b.chat.mode = 'none';
  t.p.handleSegment(speechPcm(), 'them'); await t.p.whenIdle();
  assert.deepEqual(t.kinds(), ['heard']); t.close();
});

test('câu quá ngắn: hiện chữ nhưng không gọi AI', async () => {
  const t = await setup(); t.api.b.stt.text = '122';
  t.p.handleSegment(speechPcm(), 'them'); await t.p.whenIdle();
  assert.deepEqual(t.kinds(), ['heard']); assert.equal(t.api.b.calls.chat, 0); t.close();
});

test('câu khẳng định/chào hỏi (không có dấu hiệu câu hỏi): hiện chữ, KHÔNG gọi AI', async () => {
  const t = await setup(); t.api.b.stt.text = 'Chào mọi người, hôm nay trời đẹp quá nhỉ, mình bắt đầu họp thôi';
  t.p.handleSegment(speechPcm(), 'them'); await t.p.whenIdle();
  assert.deepEqual(t.kinds(), ['heard']); assert.equal(t.api.b.calls.chat, 0); t.close();
});
test('prompt: ngôi thứ nhất, không bịa, suy luận thuật ngữ nghe sai', () => {
  const s = llm.sysListen({ mode: 'normal', sttPrompt: 'Docker, Kubernetes' });
  assert.match(s, /NGÔI THỨ NHẤT/); assert.match(s, /KHÔNG bịa/); assert.match(s, /DLCKL/); assert.match(s, /Docker, Kubernetes/); assert.match(s, /NONE/);
});
test('câu ma của Whisper bị loại', async () => {
  const t = await setup(); t.api.b.stt.text = 'Thanks for watching!';
  t.p.handleSegment(speechPcm(), 'them'); await t.p.whenIdle(); assert.equal(t.kinds().length, 0); t.close();
});

test('tiếng vọng loa->micro bị loại (cùng nội dung hai kênh)', async () => {
  const t = await setup(); t.api.b.stt.text = 'Bạn có thể giải thích Docker là gì không?';
  t.p.handleSegment(speechPcm(), 'them'); t.p.handleSegment(speechPcm(), 'me'); await t.p.whenIdle();
  assert.equal(t.events.filter((e) => e.kind === 'heard').length, 1);
  assert.equal(t.api.b.calls.chat, 1); t.close();
});

test('micro (me) với answerMic=false: chỉ ghi vào ngữ cảnh, không gọi AI', async () => {
  const t = await setup({ answerMic: false });
  t.p.handleSegment(speechPcm(), 'me'); await t.p.whenIdle();
  assert.equal(t.api.b.calls.chat, 0); assert.equal(t.events.find((e) => e.kind === 'heard').who, 'me');
  assert.match(t.p._state().history[0], /^\(Tôi\)/); t.close();
});

test('hàng đợi giữ đúng thứ tự dù câu trước xử lý chậm hơn', async () => {
  const t = await setup(); t.api.b.chat.mode = 'none';
  t.api.b.stt.text = (n) => `Câu số ${n} trong cuộc họp hôm nay`;
  t.api.b.stt.delay = 80;
  t.p.handleSegment(speechPcm(), 'them'); t.p.handleSegment(speechPcm(), 'them'); t.p.handleSegment(speechPcm(), 'them');
  await t.p.whenIdle();
  const heard = t.events.filter((e) => e.kind === 'heard').map((e) => e.text);
  assert.deepEqual(heard.map((h) => h.match(/\d+/)[0]), ['1', '2', '3']); t.close();
});

test('quá tải: bỏ đoạn cũ nhất và báo, không treo', async () => {
  const t = await setup(); t.api.b.chat.mode = 'none'; t.api.b.stt.delay = 60;
  t.api.b.stt.text = (n) => `Đoạn nói số ${n} trong họp`;
  for (let i = 0; i < 9; i++) t.p.handleSegment(speechPcm(), 'them');
  await t.p.whenIdle();
  assert.ok(t.events.some((e) => e.kind === 'error' && /không kịp/.test(e.text)));
  assert.ok(t.events.filter((e) => e.kind === 'heard').length <= 6); t.close();
});

test('lỗi STT 401 -> báo key sai, không crash, vẫn xử lý được câu sau', async () => {
  const t = await setup(); t.api.b.stt.status = 401;
  t.p.handleSegment(speechPcm(), 'them'); await t.p.whenIdle();
  assert.match(text(t.events, 'error'), /API key sai/);
  t.api.b.stt.status = 200; t.p.handleSegment(speechPcm(), 'them'); await t.p.whenIdle();
  assert.equal(text(t.events, 'delta'), 'Docker là nền tảng container hoá.'); t.close();
});

test('STT timeout -> báo lỗi thân thiện', async () => {
  const t = await setup(); t.api.b.stt.delay = 2000;
  t.p.handleSegment(speechPcm(), 'them'); await t.p.whenIdle();
  assert.match(text(t.events, 'error'), /Hết thời gian|kết nối|timeout/i); t.close();
});

test('STT 429 và không có Whisper local -> báo giới hạn', async () => {
  const t = await setup(); t.api.b.stt.status = 429;
  t.p.handleSegment(speechPcm(), 'them'); await t.p.whenIdle();
  assert.match(text(t.events, 'error'), /giới hạn/); t.close();
});

test('thiếu API key (provider api) -> hướng dẫn rõ', async () => {
  const t = await setup({ apiKey: '' }); t.api.b.stt.status = 200;
  await t.p.ask('Docker là gì?'); assert.match(text(t.events, 'error'), /API key/); t.close();
});

test('LLM 401 -> báo key sai, KHÔNG chuyển dự phòng', async () => {
  const t = await setup(); t.api.b.chat.status = 401;
  await t.p.ask('Docker là gì?');
  assert.match(text(t.events, 'error'), /API key sai/); assert.ok(!t.events.some((e) => e.kind === 'delta')); t.close();
});
test('LLM 404 (sai tên model) -> báo tên model', async () => {
  const t = await setup(); t.api.b.chat.status = 404; await t.p.ask('Docker là gì?');
  assert.match(text(t.events, 'error'), /Tên model/); t.close();
});

test('LLM 429 -> tự chuyển Claude (dự phòng), có cảnh báo, câu trả lời vẫn tới', async () => {
  const t = await setup(); t.api.b.chat.status = 429; process.env.FAKE_MODE = 'ok';
  await t.p.ask('Docker là gì?');
  assert.match(text(t.events, 'error'), /chuyển sang Claude Code/);
  assert.equal(text(t.events, 'delta'), 'Trả lời từ claude giả.');
  assert.match(t.events.find((e) => e.kind === 'meta').text, /Claude Code trên máy · haiku \(dự phòng\)/); t.close();
});

test('LLM trả nội dung rỗng (model chỉ "suy nghĩ") -> báo lỗi rõ ràng', async () => {
  const t = await setup(); t.api.b.chat.mode = 'empty'; await t.p.ask('Docker là gì?');
  assert.match(text(t.events, 'error'), /không trả về nội dung/); t.close();
});

test('LLM đứt kết nối giữa chừng -> giữ phần đã nhận + báo lỗi, không crash', async () => {
  const t = await setup(); t.api.b.chat.mode = 'cut'; await t.p.ask('Docker là gì?');
  assert.match(text(t.events, 'delta'), /Docker là/); assert.ok(t.events.some((e) => e.kind === 'error')); t.close();
});

test('LLM treo không phản hồi -> hết giờ rồi chuyển dự phòng', async () => {
  const t = await setup(); t.api.b.chat.mode = 'hang'; process.env.FAKE_MODE = 'ok';
  await t.p.ask('Docker là gì?');
  assert.equal(text(t.events, 'delta'), 'Trả lời từ claude giả.'); t.close();
});

test('provider claude: lời nhắn qua stdin, system prompt qua file, đúng model; hồ sơ + chế độ được đưa vào', async () => {
  const t = await setup({ provider: 'claude', cliModel: 'sonnet', profile: 'Backend 5 năm Go', mode: 'interview' });
  process.env.FAKE_MODE = 'echo'; await t.p.ask('Kể về bản thân');
  const out = text(t.events, 'delta');
  assert.match(out, /SYS\[Bạn là trợ lý ngầm/); assert.match(out, /IN\[.*Kể về bản thân\]/); assert.match(out, /M\[sonnet\]/);
  t.close();
});
test('prompt chứa hồ sơ & chế độ', () => {
  const s = llm.sysAsk({ profile: 'Backend 5 năm Go', mode: 'interview', context: 'Công ty X' });
  assert.match(s, /HỒ SƠ.*\n.*Backend 5 năm Go/); assert.match(s, /STAR/); assert.match(s, /Công ty X/);
  assert.match(llm.sysListen({ mode: 'short' }), /NONE/); assert.match(llm.sysListen({ mode: 'short' }), /CỰC NGẮN/);
});
test('provider claude: CLI lỗi (chưa đăng nhập) -> báo lỗi', async () => {
  const t = await setup({ provider: 'claude' }); process.env.FAKE_MODE = 'fail'; await t.p.ask('Docker là gì?');
  assert.match(text(t.events, 'error'), /lỗi.*Not logged in/); t.close();
});
test('provider claude: CLI treo -> timeout', async () => {
  const t = await setup({ provider: 'claude' }); process.env.FAKE_MODE = 'hang'; await t.p.ask('Docker là gì?');
  assert.match(text(t.events, 'error'), /timeout|hết thời gian/i); t.close();
});
test('provider claude: chưa cài CLI -> báo rõ', async () => {
  const t = await setup({ provider: 'claude' }); const old = process.env.PATH; process.env.PATH = '/nonexistent';
  try { await t.p.ask('Docker là gì?'); } finally { process.env.PATH = old; }
  assert.match(text(t.events, 'error'), /Không chạy được "claude"/); t.close();
});

test('ghi thủ công: hai kênh -> MỘT câu hỏi, có nhãn người nói', async () => {
  const t = await setup(); t.api.b.stt.text = (n) => (n === 1 ? 'Bạn dùng Docker như thế nào trong dự án' : 'Dạ em dùng Docker Compose ạ');
  t.p.handleManual({ them: speechPcm(), me: speechPcm() }); await t.p.whenIdle();
  assert.equal(t.api.b.calls.chat, 1);
  const u = t.api.b.lastChat.messages.find((m) => m.role === 'user').content;
  assert.match(u, /ĐOẠN MỚI.*\n.*Người khác: Bạn dùng Docker/); assert.match(u, /Tôi: Dạ em dùng/);
  assert.equal(text(t.events, 'delta'), 'Docker là nền tảng container hoá.'); t.close();
});
test('ghi thủ công: micro vọng lại đúng câu của loa -> chỉ giữ 1', async () => {
  const t = await setup(); t.api.b.stt.text = 'Bạn có thể giải thích Docker là gì không';
  t.p.handleManual({ them: speechPcm(), me: speechPcm() }); await t.p.whenIdle();
  assert.equal(t.events.filter((e) => e.kind === 'heard').length, 1); t.close();
});
test('ghi thủ công: im lặng / rỗng -> báo, không gọi API', async () => {
  const t = await setup();
  t.p.handleManual({ them: null, me: null }); t.p.handleManual({ them: Buffer.alloc(100), me: speechPcm(2000, 50) }); await t.p.whenIdle();
  assert.equal(t.events.filter((e) => e.kind === 'error').length, 2); assert.equal(t.api.b.calls.stt, 0); t.close();
});
test('ghi thủ công: STT trả rỗng -> báo', async () => {
  const t = await setup(); t.api.b.stt.text = '';
  t.p.handleManual({ them: speechPcm(), me: null }); await t.p.whenIdle();
  assert.match(text(t.events, 'error'), /Không nhận dạng được/); t.close();
});

test('ask: cắt câu hỏi quá dài, bỏ chuỗi rỗng, không nổ với ký tự lạ', async () => {
  const t = await setup();
  await t.p.ask('   '); await t.p.ask(''); await t.p.ask(null); assert.equal(t.api.b.calls.chat, 0);
  await t.p.ask('x'.repeat(10000));
  assert.equal(t.api.b.lastChat.messages.find((m) => m.role === 'user').content.length <= 2000 + 200, true);
  await t.p.ask('💥 \u0000 <script>alert(1)</script> ```'); assert.equal(t.api.b.calls.chat, 2); t.close();
});

test('ask quick: không đưa câu nút nhanh vào lịch sử, có đưa câu tự gõ', async () => {
  const t = await setup(); await t.p.ask('Rút gọn đi', '✂ Rút gọn'); await t.p.ask('Câu tự gõ');
  const h = t.p._state().history; assert.equal(h.length, 1); assert.match(h[0], /Câu tự gõ/); t.close();
});

test('shot: provider claude không hỗ trợ ảnh -> báo; provider api gửi ảnh', async () => {
  const t = await setup({ provider: 'claude' }); await t.p.shot(async () => 'data:image/jpeg;base64,AAAA');
  assert.match(text(t.events, 'error'), /vision/); t.close();
  const t2 = await setup(); await t2.p.shot(async () => 'data:image/jpeg;base64,AAAA');
  assert.equal(t2.api.b.lastChat.messages[1].content[1].type, 'image_url');
  await t2.p.shot(async () => { throw new Error('Không chụp được màn hình.'); });
  assert.match(text(t2.events, 'error'), /Không chụp được/); t2.close();
});

test('exportMarkdown & reset', async () => {
  const t = await setup(); t.p.handleSegment(speechPcm(), 'them'); await t.p.whenIdle();
  const md = t.p.exportMarkdown(); assert.match(md, /# Bản ghi/); assert.match(md, /Docker là gì\?/); assert.match(md, /> .*Docker là nền tảng/);
  t.p.reset(); assert.equal(t.p._state().history.length, 0); assert.doesNotMatch(t.p.exportMarkdown(), /Docker là gì/); t.close();
});

test('đồng thời: ask trong lúc hàng đợi đang chạy không làm lẫn sự kiện', async () => {
  const t = await setup(); t.api.b.stt.delay = 50;
  t.p.handleSegment(speechPcm(), 'them'); const a = t.p.ask('Câu gõ tay xen vào'); await a; await t.p.whenIdle();
  const ids = new Set(t.events.filter((e) => e.kind === 'delta').map((e) => e.id)); assert.equal(ids.size, 2); t.close();
});

test('API ngừng gửi giữa luồng -> hết giờ (không treo hàng đợi), giữ phần đã nhận, câu sau vẫn chạy', async () => {
  const t = await setup(); t.api.b.chat.mode = 'stall'; process.env.FAKE_MODE = 'ok';
  t.p.handleSegment(speechPcm(), 'them'); await t.p.whenIdle();
  assert.match(text(t.events, 'delta'), /Docker là/); assert.match(text(t.events, 'error'), /timeout|Hết thời gian|ngừng gửi/i);
  t.api.b.chat.mode = 'ok'; t.p.handleSegment(speechPcm(), 'them'); await t.p.whenIdle();
  assert.match(text(t.events, 'delta'), /nền tảng container/); t.close();
});
test('dự phòng cũng lỗi -> báo CẢ HAI nguyên nhân (không giấu lỗi gốc)', async () => {
  const t = await setup(); t.api.b.chat.status = 429; const old = process.env.PATH; process.env.PATH = '/nonexistent';
  try { await t.p.ask('Docker là gì?'); } finally { process.env.PATH = old; }
  const e = text(t.events, 'error'); assert.match(e, /giới hạn|429/); assert.match(e, /dự phòng|claude/i); t.close();
});
test('trạng thái sau khi xử lý xong: đang ghi thì vẫn là "recording"', async () => {
  const api = await mockApi(); const cfg = C.sanitize({ apiKey: 'k', baseUrl: api.url, sttMode: 'api', provider: 'api' }, C.defaults());
  const events = []; const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-t-')); const emit = (e) => events.push(e);
  const stt = createStt({ emit, notice: () => {}, rootDir: dir, userDir: dir });
  const p = createPipeline({ loadCfg: () => cfg, emit, stt, llm, isListening: () => true, isRecording: () => true });
  api.b.chat.mode = 'none'; p.handleSegment(speechPcm(), 'them'); await p.whenIdle();
  assert.equal(events.filter((e) => e.kind === 'status').pop().state, 'recording'); api.close();
});
