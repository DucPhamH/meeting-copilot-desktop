'use strict';
const fs = require('fs');
const { wavFromPcm, peakOf, pcmMs, similar, tooShortForAI, looksLikeQuestion, friendlyError, PHANTOM } = require('./util');

const WHO_LABEL = { them: '👥 Người khác', me: '🎤 Tôi', ask: '✍ Tôi hỏi AI', sys: 'ℹ' };

// deps: { loadCfg, emit, stt, llm, isListening, logFile }
function createPipeline({ loadCfg, emit, stt, llm, isListening = () => false, isRecording = () => false, logFile = null, maxQueue = 4 }) {
  let history = [];            // chữ làm ngữ cảnh cho AI
  let transcript = [];         // bản ghi để xuất file
  let heard = [];              // để loại tiếng vọng
  let nid = 0, lastNotice = 0;
  const newId = () => 'm' + (++nid);
  const status = (state, text = '') => emit({ kind: 'status', state, text });
  const idle = () => status(isRecording() ? 'recording' : isListening() ? 'listening' : 'idle');
  const notice = (t) => { const n = Date.now(); if (n - lastNotice > 20000) { lastNotice = n; emit({ kind: 'error', text: t }); } };
  const errorOut = (e) => emit({ kind: 'error', text: friendlyError(e) });
  const ctx = (n) => history.slice(-n).join('\n');
  const pushHistory = (s) => { history.push(s); if (history.length > 60) history = history.slice(-60); };

  // ---- hàng đợi tuần tự: câu nào ra trước hiển thị trước ----
  const queue = []; let running = false;
  function enqueue(job) {
    if (queue.length >= maxQueue) { queue.shift(); notice('⚠ Xử lý không kịp, bỏ qua đoạn cũ nhất (thử nói chậm lại / dùng Ghi câu hỏi).'); }
    queue.push(job); pump();
  }
  async function pump() {
    if (running) return; running = true;
    while (queue.length) { try { await queue.shift()(); } catch (e) { errorOut(e); } }
    running = false; idle();
  }
  const whenIdle = async () => { while (running || queue.length) await new Promise((r) => setTimeout(r, 20)); };

  function prepare(pcm) {            // Buffer PCM -> WAV, hoặc null nếu quá ngắn/quá nhỏ
    if (!pcm || pcmMs(pcm) < 500 || peakOf(pcm) < 400) return null;
    return wavFromPcm(pcm, 16000);
  }
  function isEcho(who, text) {
    const now = Date.now();
    heard = heard.filter((h) => now - h.at < 20000);
    return heard.some((h) => h.who !== who && similar(h.text, text));
  }
  function record(who, text) {
    heard.push({ who, text, at: Date.now() });
    const entry = { t: new Date(), who, text, answer: '', label: '' };
    transcript.push(entry); if (transcript.length > 500) transcript.shift();
    return entry;
  }
  function logLine(label, ms, text) {
    if (!logFile) return;
    try {
      if (fs.existsSync(logFile) && fs.statSync(logFile).size > 2e6) fs.renameSync(logFile, logFile + '.1');
      fs.appendFileSync(logFile, `${new Date().toISOString()}\t${label}\t${JSON.stringify(ms)}\t${text.replace(/\s+/g, ' ').slice(0, 300)}\n`, { mode: 0o600 });
    } catch {}
  }

  // Gọi AI và phát chữ. gate=true: có thể im lặng nếu không phải câu hỏi.
  async function answer(cfg, id, messages, gate, entry, sttMs) {
    status('thinking', 'AI đang nghĩ…');
    let ans = '';
    const r = await llm.chatStream(cfg, messages, {
      gate, notice,
      onDelta: (t) => { ans += t; emit({ kind: 'delta', id, text: t }); },
    });
    if (!r.text.trim()) { emit({ kind: 'error', text: 'AI không trả về nội dung (model rỗng/bị chặn?). Thử đổi model ở ⚙.' }); return; }
    if (!r.shown) return;
    const sec = (ms) => (ms == null ? '–' : (ms / 1000).toFixed(1) + 's');
    const timing = [sttMs != null ? `nghe ${sec(sttMs)}` : null, `chữ đầu ${sec(r.ms.first)}`, `xong ${sec(r.ms.total)}`].filter(Boolean).join(' · ');
    emit({ kind: 'meta', id, text: `↳ ${r.label} · ${timing}` });
    if (entry) { entry.answer = ans; entry.label = r.label; }
    logLine(r.label, { stt: sttMs, ...r.ms }, ans);
  }

  // ---- Nghe liên tục: một câu (PCM) từ nguồn who ----
  function handleSegment(pcm, who = 'them') {
    const wav = prepare(pcm);
    if (!wav) return;
    enqueue(async () => {
      const cfg = loadCfg();
      status('transcribing', 'Đang nhận dạng…');
      const t0 = Date.now();
      const text = (await stt.transcribe(cfg, wav)).trim();
      const sttMs = Date.now() - t0;
      if (text.length < 2 || PHANTOM.test(text) || isEcho(who, text)) return;
      const entry = record(who, text);
      const context = ctx(5);
      pushHistory(who === 'me' ? '(Tôi) ' + text : text);
      const id = newId();
      emit({ kind: 'heard', id, who, text });
      if ((who === 'me' && !cfg.answerMic) || tooShortForAI(text) || !looksLikeQuestion(text)) return;
      await answer(cfg, id, [
        { role: 'system', content: llm.sysListen(cfg) },
        { role: 'user', content: (context ? `[Ngữ cảnh trước đó — chỉ để tham khảo, KHÔNG trả lời lại]\n${context}\n\n` : '') + `[ĐOẠN MỚI — xét đoạn này]\n${text}` },
      ], true, entry, sttMs);
    });
  }

  // ---- Ghi thủ công: cả đoạn là MỘT câu hỏi ----
  function handleManual({ them, me }) {
    enqueue(async () => {
      const cfg = loadCfg();
      const wavs = { them: prepare(them), me: prepare(me) };
      if (!wavs.them && !wavs.me) { emit({ kind: 'error', text: 'Không nghe thấy gì trong đoạn ghi (nói to/gần micro hơn, hoặc kiểm tra nguồn âm thanh ở ⚙).' }); return; }
      status('transcribing', 'Đang nhận dạng…');
      const t0 = Date.now();
      const texts = await Promise.all(['them', 'me'].map(async (w) => (wavs[w] ? (await stt.transcribe(cfg, wavs[w])).trim() : '')));
      const sttMs = Date.now() - t0;
      let [tt, mt] = texts.map((t) => (PHANTOM.test(t) ? '' : t));
      if (tt && mt && similar(tt, mt)) mt = '';           // micro thu lại tiếng loa
      const parts = [];
      if (tt) parts.push(['them', tt]);
      if (mt) parts.push(['me', mt]);
      if (!parts.length) { emit({ kind: 'error', text: 'Không nhận dạng được lời nói trong đoạn ghi.' }); return; }
      const context = ctx(8);
      let lastId = null, lastEntry = null;
      for (const [w, t] of parts) {
        lastEntry = record(w, t); pushHistory(w === 'me' ? '(Tôi) ' + t : t);
        lastId = newId(); emit({ kind: 'heard', id: lastId, who: w, text: t });
      }
      const body = parts.map(([w, t]) => `${WHO_LABEL[w]}: ${t}`).join('\n');
      await answer(cfg, lastId, [
        { role: 'system', content: llm.sysAsk(cfg) },
        { role: 'user', content: (context ? `[Ngữ cảnh trước đó — chỉ để tham khảo, KHÔNG trả lời lại]\n${context}\n\n` : '') +
          `[ĐOẠN MỚI VỪA GHI ÂM — trả lời câu hỏi/yêu cầu trong đoạn này; phiên âm tự động có thể sai chính tả]\n${body}` },
      ], false, lastEntry, sttMs);
    });
  }

  // ---- Gõ câu hỏi / nút nhanh (chạy ngay, không xếp hàng) ----
  async function ask(text, quick) {
    text = String(text || '').trim().slice(0, 2000);
    if (!text) return;
    try {
      const cfg = loadCfg();
      const id = newId();
      const entry = record('ask', quick || text);
      emit({ kind: 'heard', id, who: 'ask', text: quick || text });
      const context = ctx(12);
      if (!quick) pushHistory('(Tôi hỏi AI) ' + text);
      await answer(cfg, id, [
        { role: 'system', content: llm.sysAsk(cfg) },
        { role: 'user', content: (context ? `[Nội dung cuộc họp gần đây — để tham khảo]\n${context}\n\n` : '') + `[YÊU CẦU CỦA TÔI]\n${text}` },
      ], false, entry, null);
    } catch (e) { errorOut(e); }
    finally { idle(); }
  }

  // ---- Phân tích ảnh màn hình ----
  async function shot(captureDataUrl) {
    try {
      const cfg = loadCfg();
      if (cfg.provider !== 'api') throw new Error('Phân tích ảnh cần provider API có hỗ trợ vision (⚙ → Bộ não AI = API, model có vision).');
      const id = newId();
      emit({ kind: 'heard', id, who: 'sys', text: '📷 Phân tích màn hình…' });
      const url = await captureDataUrl();
      const entry = record('sys', '(ảnh màn hình)');
      await answer(cfg, id, [
        { role: 'system', content: llm.sysAsk(cfg) },
        { role: 'user', content: [{ type: 'text', text: 'Phân tích ảnh màn hình này (đề bài, câu hỏi, slide…) và đưa ra câu trả lời/giải pháp ngắn gọn.' }, { type: 'image_url', image_url: { url } }] },
      ], false, entry, null);
    } catch (e) { errorOut(e); }
    finally { idle(); }
  }

  function exportMarkdown() {
    const L = ['# Bản ghi cuộc họp', `_Xuất lúc ${new Date().toLocaleString()}_`, ''];
    for (const e of transcript) {
      L.push(`**[${e.t.toLocaleTimeString()}] ${WHO_LABEL[e.who] || e.who}:** ${e.text}`);
      if (e.answer) L.push('', `> **AI** (${e.label}):`, ...e.answer.split('\n').map((x) => '> ' + x));
      L.push('');
    }
    return L.join('\n');
  }
  function reset() { history = []; transcript = []; heard = []; }

  return { handleSegment, handleManual, ask, shot, exportMarkdown, reset, whenIdle, status, notice, _state: () => ({ history, transcript }) };
}
module.exports = { createPipeline, WHO_LABEL };
