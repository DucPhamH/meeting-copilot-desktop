'use strict';
// Markdown tối giản và AN TOÀN (không dùng innerHTML): đậm, nghiêng, code, khối code, danh sách, tiêu đề.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MD = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  function inline(s) {
    const out = []; let i = 0, buf = '';
    const flush = () => { if (buf) { out.push({ t: 'text', v: buf }); buf = ''; } };
    while (i < s.length) {
      if (s[i] === '`') { const j = s.indexOf('`', i + 1); if (j > i) { flush(); out.push({ t: 'code', v: s.slice(i + 1, j) }); i = j + 1; continue; } }
      if (s.startsWith('**', i)) { const j = s.indexOf('**', i + 2); if (j > i + 2) { flush(); out.push({ t: 'b', v: s.slice(i + 2, j) }); i = j + 2; continue; } }
      if ((s[i] === '*' || s[i] === '_') && s[i + 1] && s[i + 1] !== ' ' && s[i + 1] !== s[i]) {
        const j = s.indexOf(s[i], i + 1);
        if (j > i + 1 && s[j - 1] !== ' ' && (s[i] === '*' || !/\w/.test(s[i - 1] || ' '))) { flush(); out.push({ t: 'i', v: s.slice(i + 1, j) }); i = j + 1; continue; }
      }
      buf += s[i++];
    }
    flush(); return out;
  }
  // Trả về danh sách khối; chịu được văn bản dở dang khi đang stream.
  function parse(text) {
    const lines = String(text).replace(/\r/g, '').split('\n');
    const blocks = []; let i = 0;
    while (i < lines.length) {
      const l = lines[i];
      const fence = l.match(/^\s*```(\w*)\s*$/);
      if (fence) {
        const code = []; i++;
        while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) code.push(lines[i++]);
        i++; blocks.push({ t: 'code', lang: fence[1], text: code.join('\n') }); continue;
      }
      const h = l.match(/^\s{0,3}#{1,6}\s+(.*)$/);
      if (h) { blocks.push({ t: 'h', inl: inline(h[1]) }); i++; continue; }
      const ul = l.match(/^\s*[-*•]\s+(.*)$/), ol = l.match(/^\s*\d+[.)]\s+(.*)$/);
      if (ul || ol) {
        const kind = ul ? 'ul' : 'ol', re = ul ? /^\s*[-*•]\s+(.*)$/ : /^\s*\d+[.)]\s+(.*)$/, items = [];
        while (i < lines.length) { const m = lines[i].match(re); if (!m) break; items.push(inline(m[1])); i++; }
        blocks.push({ t: kind, items }); continue;
      }
      if (!l.trim()) { i++; continue; }
      const para = [];
      while (i < lines.length && lines[i].trim() && !/^\s*```/.test(lines[i]) && !/^\s{0,3}#{1,6}\s/.test(lines[i]) && !/^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) para.push(lines[i++]);
      blocks.push({ t: 'p', inl: inline(para.join('\n')) });
    }
    return blocks;
  }
  function inlDom(doc, parts, parent) {
    for (const p of parts) {
      if (p.t === 'text') parent.appendChild(doc.createTextNode(p.v));
      else { const e = doc.createElement(p.t === 'b' ? 'strong' : p.t === 'i' ? 'em' : 'code'); e.textContent = p.v; parent.appendChild(e); }
    }
  }
  function render(doc, text, into) {
    const root = into || doc.createDocumentFragment();
    for (const b of parse(text)) {
      let e;
      if (b.t === 'code') { e = doc.createElement('pre'); const c = doc.createElement('code'); c.textContent = b.text; e.appendChild(c); }
      else if (b.t === 'ul' || b.t === 'ol') { e = doc.createElement(b.t); for (const it of b.items) { const li = doc.createElement('li'); inlDom(doc, it, li); e.appendChild(li); } }
      else if (b.t === 'h') { e = doc.createElement('div'); e.className = 'md-h'; inlDom(doc, b.inl, e); }
      else { e = doc.createElement('p'); inlDom(doc, b.inl, e); }
      root.appendChild(e);
    }
    return root;
  }
  return { parse, inline, render };
});
