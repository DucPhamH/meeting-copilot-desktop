'use strict';
// Bus sự kiện + bộ nhớ đệm các sự kiện gần đây (để trang điện thoại tải lại vẫn thấy).
function createBus(maxRecent = 80) {
  const recent = []; const subs = new Set(); let status = { state: 'idle', text: '' };
  return {
    emit(ev) {
      if (ev.kind === 'status') status = { state: ev.state, text: ev.text || '' };
      else if (ev.kind === 'delta') {
        const last = recent[recent.length - 1];
        if (last && last.kind === 'delta' && last.id === ev.id) last.text += ev.text;
        else recent.push({ ...ev });
      } else if (ev.kind !== 'rec') recent.push({ ...ev });
      while (recent.length > maxRecent) recent.shift();
      for (const f of subs) { try { f(ev); } catch {} }
    },
    clear() { recent.length = 0; },
    on(f) { subs.add(f); return () => subs.delete(f); },
    recent: () => recent.map((e) => ({ ...e })),
    status: () => ({ ...status }),
  };
}
module.exports = { createBus };
