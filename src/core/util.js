'use strict';
// Tiện ích thuần (không phụ thuộc Electron) — có unit test.

// Lỗi tạm thời: đáng thử dự phòng
const RECOVERABLE = /\b(429|402|403|408|500|502|503|504)\b|rate.?limit|quota|exceed|overloaded|fetch failed|ENOTFOUND|ECONN|ETIMEDOUT|EAI_AGAIN|network|timeout|timed out|aborted/i;

// Những câu Whisper hay "bịa" khi gặp im lặng/nhiễu
const PHANTOM = /(thanks for watching|thank you for watching|subtitles? by|amara\.org|cảm ơn các bạn đã (theo dõi|xem)|hãy (subscribe|đăng ký)|đăng ký kênh|ghiền mì gõ|like and subscribe|^\W*(you|bye|\.+)\W*$)/i;

function normPcm(pcm, maxGain = 10) {
  const n = Math.floor(pcm.length / 2);
  let peak = 1;
  for (let i = 0; i < n; i++) { const v = Math.abs(pcm.readInt16LE(i * 2)); if (v > peak) peak = v; }
  const gain = Math.min(maxGain, 0.7 * 32767 / peak);
  if (gain <= 1.2) return pcm;
  const out = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(pcm.readInt16LE(i * 2) * gain))), i * 2);
  }
  return out;
}
function peakOf(pcm) {
  let p = 0; const n = Math.floor(pcm.length / 2);
  for (let i = 0; i < n; i++) { const v = Math.abs(pcm.readInt16LE(i * 2)); if (v > p) p = v; }
  return p;
}
function pcmMs(pcm, rate = 16000) { return (pcm.length / 2) / rate * 1000; }

// pcm: Buffer s16le mono
function wavFromPcm(pcm, rate = 16000, normalize = true) {
  if (normalize) pcm = normPcm(pcm);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
function int16ToBuffer(a) { return Buffer.from(a.buffer, a.byteOffset, a.byteLength); }

const tokens = (s) => String(s).toLowerCase().normalize('NFC').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
// Hai đoạn chữ có "gần như một" không (để loại tiếng vọng loa → micro)
function similar(a, b) {
  const A = new Set(tokens(a)), B = new Set(tokens(b));
  if (A.size < 3 || B.size < 3) return false;
  let inter = 0; for (const x of A) if (B.has(x)) inter++;
  return inter / Math.min(A.size, B.size) >= 0.75;
}

// Đoạn quá ngắn/không phải câu hỏi thì không gọi AI
function tooShortForAI(text) {
  return tokens(text).length < 4 && !/\?\s*$/.test(text);
}

// Lọc thô (ưu tiên không bỏ sót): có dấu hiệu là câu hỏi/yêu cầu không?
const Q_CUES = ['gì', 'nào', 'sao', 'ai', 'đâu', 'không', 'chưa', 'hả', 'bao nhiêu', 'bao lâu', 'bao giờ', 'khi nào', 'tại sao', 'vì sao',
  'làm sao', 'như thế nào', 'thế nào', 'ra sao', 'có thể', 'có nên', 'có phải', 'giải thích', 'kể về', 'kể cho', 'kể', 'nêu', 'mô tả', 'so sánh',
  'trình bày', 'phân biệt', 'khác nhau', 'định nghĩa', 'liệt kê', 'hãy', 'cho tôi biết', 'cho mình hỏi', 'cho em hỏi', 'xin hỏi', 'bạn có', 'anh có',
  'chị có', 'em có', 'đã từng', 'từng', 'what', 'why', 'how', 'when', 'where', 'who', 'which', 'whose', 'explain', 'describe', 'compare',
  'difference', 'tell me', 'walk me through', 'can you', 'could you', 'would you', 'do you', 'did you', 'have you', 'are you', 'is there',
  'is it', 'should', 'thoughts', 'opinion'];
function looksLikeQuestion(text) {
  if (/[?？]/.test(text)) return true;
  const norm = ' ' + tokens(text).join(' ') + ' ';
  return Q_CUES.some((c) => norm.includes(' ' + c + ' '));
}

function friendlyError(e) {
  const m = String((e && e.message) || e || '');
  if (/\b401\b|invalid.?api.?key|incorrect api key|unauthorized/i.test(m)) {
    if (/\bcodex\b/i.test(m)) return 'Codex chưa đăng nhập hoặc phiên hết hạn — chạy `codex login` trong terminal.';
    if (/\bclaude\b/i.test(m)) return 'Claude Code chưa đăng nhập hoặc phiên hết hạn — chạy `claude` để đăng nhập lại.';
    return 'API key sai hoặc đã bị thu hồi — kiểm tra lại trong ⚙.';
  }
  if (/model.?not.?found|does not exist|\b404\b/i.test(m)) return 'Tên model không tồn tại với tài khoản này — sửa ô "Model" trong ⚙. (' + m.slice(0, 120) + ')';
  if (/\b429\b|rate.?limit|quota/i.test(m)) return 'Đã chạm giới hạn của nhà cung cấp (429) — đợi một lúc hoặc đổi provider.';
  if (/ENOTFOUND|EAI_AGAIN|fetch failed|ECONNREFUSED|ETIMEDOUT|network/i.test(m)) return 'Không kết nối được máy chủ (mạng/Base URL sai?). ' + m.slice(0, 100);
  if (/timeout|timed out|aborted/i.test(m)) return 'Hết thời gian chờ phản hồi. ' + m.slice(0, 100);
  return m.slice(0, 300) || 'Lỗi không rõ';
}

module.exports = { looksLikeQuestion, RECOVERABLE, PHANTOM, normPcm, peakOf, pcmMs, wavFromPcm, int16ToBuffer, similar, tooShortForAI, friendlyError, tokens };
