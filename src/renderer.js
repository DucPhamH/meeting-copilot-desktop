'use strict';
const $ = (id) => document.getElementById(id);
const FIELDS = ['provider', 'cliModel', 'sttMode', 'apiKey', 'language', 'source', 'mode', 'profile', 'context', 'opacity', 'fontSize',
  'baseUrl', 'sttModel', 'llmModel', 'whisperModel', 'sttPrompt', 'answerMic', 'recAskMode', 'serve', 'port', 'silence', 'captureTarget'];
const BOOLS = ['answerMic', 'serve'], NUMS = ['opacity', 'fontSize', 'port', 'silence'];
const WHO = { them: '👥', me: '🎤', ask: '✍', sys: 'ℹ' };
const STATUS = { idle: '⚪ Sẵn sàng', listening: '🟢 Đang nghe — nói/hỏi đi', recording: '🔴 Đang ghi… bấm lại để gửi', transcribing: '⏳ Đang nhận dạng…', thinking: '💭 AI đang nghĩ…' };
const MAX_NODES = 300;
let cfg = {}, info = {}, keyDirty = false, listening = false, recording = false;

// ---------- hiển thị ----------
const nearBottom = () => { const l = $('log'); return l.scrollHeight - l.scrollTop - l.clientHeight < 60; };
const scrollDown = () => { const l = $('log'); l.scrollTop = l.scrollHeight; };
function put(el) {
  const stick = nearBottom();
  $('log').querySelector('.empty')?.remove();
  $('log').append(el);
  while ($('log').children.length > MAX_NODES) $('log').firstChild.remove();
  if (stick) scrollDown();
}
function line(cls, text) { const d = document.createElement('div'); d.className = cls; d.textContent = text; put(d); return d; }
function showEmpty() { $('log').innerHTML = '<div class="empty">Bấm <b>🎙 Ghi câu hỏi</b>, nói/để người kia nói, rồi bấm lại để gửi.<br>Hoặc gõ câu hỏi vào ô bên dưới.<br><small>Bấm vào câu trả lời để copy.</small></div>'; }

const answers = {};   // id -> {el, raw, raf}
function answerEl(id) {
  let a = answers[id];
  if (!a) {
    const el = document.createElement('div'); el.className = 'a'; el.title = 'Bấm để copy';
    a = answers[id] = { el, raw: '', raf: 0 };
    el.onclick = () => navigator.clipboard.writeText(a.raw).then(() => { el.style.outline = '1px solid #3ddc84'; setTimeout(() => (el.style.outline = ''), 400); });
    put(el);
    const ids = Object.keys(answers); if (ids.length > 60) delete answers[ids[0]];
  }
  return a;
}
function paint(a) {
  if (a.raf) return;
  a.raf = requestAnimationFrame(() => {
    a.raf = 0; const stick = nearBottom();
    a.el.textContent = ''; MD.render(document, a.raw, a.el);
    if (stick) scrollDown();
  });
}
function setStatus(state, text) {
  const s = $('status');
  s.className = state === 'recording' ? 'rec' : state === 'transcribing' || state === 'thinking' || state === 'loading' ? 'busy' : '';
  s.textContent = state === 'loading' || state === 'ready' ? (state === 'ready' ? '✅ ' : '⏳ ') + text : (STATUS[state] || state) + (state === 'thinking' ? '' : '');
}
function setListening(on) { listening = on; $('go').className = on ? 'on' : ''; $('go').textContent = on ? '■ Dừng nghe' : '👂 Nghe liên tục'; }
function setRec(on) { recording = on; $('rec').className = on ? 'on' : ''; $('rec').textContent = on ? '⏹ Dừng & gửi' : '🎙 Ghi câu hỏi'; }

api.onResult((e) => {
  switch (e.kind) {
    case 'status': return setStatus(e.state, e.text);
    case 'rec': return setRec(e.on);
    case 'listen': return setListening(e.on);
    case 'heard': return line('h', `${WHO[e.who] || ''} ${e.text}`.trim());
    case 'fill-ask': { $('askText').value = e.text || ''; $('askText').focus(); return; }
    case 'delta': { const a = answerEl(e.id); a.raw += e.text; return paint(a); }
    case 'meta': return line('m', e.text);
    case 'error': return line('e', e.text);
  }
});

// ---------- thanh ghi chú (link điện thoại) ----------
let noteUrl = '';
function note(t, url) { noteUrl = url || ''; $('note').style.display = 'flex'; $('noteText').textContent = t; $('noteText').title = t + (url ? '\n' + url : ''); $('copyLink').style.display = url ? '' : 'none'; }
$('noteX').onclick = () => ($('note').style.display = 'none');
$('copyLink').onclick = () => { navigator.clipboard.writeText(noteUrl); $('copyLink').textContent = 'Đã copy ✓'; setTimeout(() => ($('copyLink').textContent = 'Copy link'), 1500); };
function phoneNote() {
  if (info.platform === 'win32' || !info.url) return;
  note(info.platform === 'linux' ? '📱 Linux không ẩn được cửa sổ khi share toàn màn hình → xem trên điện thoại' : '📱 macOS 15+ có thể lộ cửa sổ khi share → test trước, hoặc xem trên điện thoại', info.url);
}

// ---------- cài đặt ----------
function applyLook() {
  const op = parseFloat($('opacity').value) || cfg.opacity || 0.9, fs = parseInt($('fontSize').value) || cfg.fontSize || 16;
  document.documentElement.style.setProperty('--op', op); document.documentElement.style.setProperty('--fs', fs + 'px');
  $('opv').textContent = Math.round(op * 100) + '%'; $('fsv').textContent = fs + 'px';
}
function fill() {
  FIELDS.forEach((f) => { $(f).value = BOOLS.includes(f) ? String(cfg[f]) : cfg[f] ?? ''; });
  $('apiKey').value = cfg.apiKey || ''; keyDirty = false;
  $('keyState').textContent = cfg.apiKey ? '(đã lưu — để nguyên nếu không đổi)' : '(chưa có)';
  applyLook();
}
function toggleSettings(show) {
  const s = show ?? $('set').style.display !== 'block';
  $('set').style.display = s ? 'block' : 'none'; $('log').style.display = s ? 'none' : 'block';
  ['quick', 'ask', 'hint'].forEach((i) => ($(i).style.display = s ? 'none' : ''));
  $('saveRow').style.display = s ? 'flex' : 'none';
  if (!s) scrollDown();
}
$('apiKey').addEventListener('input', () => (keyDirty = true));
['opacity', 'fontSize'].forEach((i) => $(i).addEventListener('input', applyLook));
$('gear').onclick = () => toggleSettings();
$('cancel').onclick = () => { fill(); toggleSettings(false); };
$('save').onclick = async () => {
  const c = {};
  FIELDS.forEach((f) => {
    if (f === 'apiKey') { if (keyDirty) c.apiKey = $('apiKey').value.trim(); return; }
    const v = $(f).value;
    c[f] = BOOLS.includes(f) ? v === 'true' : NUMS.includes(f) ? parseFloat(v) : v.trim();
  });
  const r = await api.setCfg(c);
  cfg = await api.getCfg(); info = await api.info(); if (r && r.url) info.url = r.url;
  fill(); toggleSettings(false); phoneNote();
};
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('set').style.display === 'block') $('cancel').click(); });
api.onOpenSettings(() => toggleSettings(true));

// ---------- kéo cửa sổ ----------
$('bar').addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || e.target.closest('button')) return;
  $('bar').setPointerCapture(e.pointerId);
  api.dragStart();
});
$('bar').addEventListener('pointermove', (e) => { if ($('bar').hasPointerCapture(e.pointerId)) api.dragMove(); });
$('bar').addEventListener('pointerup', (e) => { if ($('bar').hasPointerCapture(e.pointerId)) api.dragMove(); });

// ---------- tooltip & dropdown vẽ trong trang ----------
// Tooltip gốc và popup của <select> là cửa sổ riêng của hệ điều hành: không có cờ ẩn khi share.
document.addEventListener('mouseover', (e) => {
  const el = e.target.closest('[title],[data-tip]');
  if (!el) return;
  if (el.title) { el.dataset.tip = el.title; el.removeAttribute('title'); }
  const t = $('tip'); t.textContent = el.dataset.tip; t.style.display = 'block';
  const r = el.getBoundingClientRect(), w = t.offsetWidth, h = t.offsetHeight;
  t.style.left = Math.max(4, Math.min(r.left, innerWidth - w - 4)) + 'px';
  t.style.top = (r.bottom + h + 8 < innerHeight ? r.bottom + 4 : Math.max(4, r.top - h - 4)) + 'px';
});
document.addEventListener('mouseout', () => ($('tip').style.display = 'none'));

let ddSel = null;
function closeDd() { $('dd').style.display = 'none'; ddSel = null; }
function openDd(sel) {
  const dd = $('dd');
  dd.replaceChildren(...[...sel.options].map((o) => {
    const d = document.createElement('div'); d.textContent = o.text; if (o.value === sel.value) d.className = 'on';
    d.onmousedown = (e) => { e.preventDefault(); sel.value = o.value; sel.dispatchEvent(new Event('change', { bubbles: true })); closeDd(); };
    return d;
  }));
  const r = sel.getBoundingClientRect(), below = innerHeight - r.bottom - 4, above = r.top - 4;
  dd.style.display = 'block'; dd.style.left = r.left + 'px'; dd.style.width = r.width + 'px';
  const up = dd.scrollHeight > below && above > below;
  dd.style.maxHeight = (up ? above : below) + 'px';
  dd.style.top = (up ? r.top - Math.min(dd.scrollHeight, above) : r.bottom) + 'px';
  ddSel = sel;
}
document.addEventListener('mousedown', (e) => {
  $('tip').style.display = 'none';
  const sel = e.target.closest('select');
  if (sel) { e.preventDefault(); sel.focus(); ddSel === sel ? closeDd() : openDd(sel); return; }
  if (!e.target.closest('#dd')) closeDd();
}, true);
document.addEventListener('keydown', (e) => {
  if (ddSel && e.key === 'Escape') { e.stopPropagation(); closeDd(); return; }
  if (e.target.tagName === 'SELECT' && (e.key === ' ' || e.key === 'Enter' || e.key === 'F4' || (e.altKey && e.key === 'ArrowDown'))) { e.preventDefault(); openDd(e.target); }
}, true);
$('set').addEventListener('scroll', closeDd);

// ---------- nút ----------
$('x').onclick = () => api.quit();
$('rec').onclick = () => api.manual();
$('go').onclick = () => api.listen(!listening);
$('shot').onclick = () => api.shot();
$('clear').onclick = async () => { await api.clear(); Object.keys(answers).forEach((k) => delete answers[k]); showEmpty(); };
$('export').onclick = async () => {
  const r = await api.exportMd();
  if (r.ok) line('m', '💾 Đã lưu: ' + r.filePath); else if (r.error) line('e', 'Không lưu được: ' + r.error);
};
$('ask').onsubmit = (e) => { e.preventDefault(); const t = $('askText').value.trim(); if (t) api.ask(t); $('askText').value = ''; };
document.querySelectorAll('#quick [data-q]').forEach((b) => (b.onclick = () => api.ask(b.dataset.q, b.textContent)));
api.onClickthrough((v) => ($('hint').textContent = v ? 'Click xuyên: BẬT (Ctrl+Shift+C để tắt)' : 'Ctrl+Shift+Space: ghi/gửi · Ctrl+Shift+H: ẩn/hiện · Ctrl+Shift+S: chụp màn hình · Ctrl+Shift+C: click xuyên'));

// ---------- thu âm phía renderer (Windows/macOS) ----------
Cap.setErrorHandler((m) => line('e', m));

(async function init() {
  showEmpty();
  cfg = await api.getCfg(); info = await api.info();
  fill(); setListening(info.listening); setRec(info.recording); phoneNote();
  const needKey = (cfg.provider === 'api' || cfg.sttMode === 'api') && !cfg.apiKey;
  if (needKey) toggleSettings(true);
})();
