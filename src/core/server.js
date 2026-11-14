'use strict';
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MD_JS = fs.readFileSync(path.join(__dirname, 'md.js'), 'utf8');
const PAGE = `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>Copilot</title><style>
body{font:17px system-ui;background:#111;color:#eee;margin:0;padding:10px 12px 76px}
#st{position:sticky;top:0;background:#111;padding:6px 0;font-size:13px;color:#8a8;z-index:2}
.h{color:#999;font-size:14px;margin:14px 0 4px;white-space:pre-wrap}
.a{background:#1d3a2a;border-left:4px solid #3ddc84;padding:6px 12px;border-radius:6px;line-height:1.45}
.a p{margin:6px 0}.a pre{background:#0d1f16;padding:8px;border-radius:5px;overflow:auto;font-size:14px}.a code{font-family:ui-monospace,monospace}.a ul,.a ol{margin:6px 0;padding-left:22px}
.m{font-size:11px;color:#6a8;margin:2px 0 8px}.e{color:#f88;font-size:13px;margin:8px 0}
form{position:fixed;left:0;right:0;bottom:0;display:flex;gap:6px;padding:8px;background:#000}
input{flex:1;min-width:0;font-size:16px;padding:10px;border-radius:6px;border:1px solid #444;background:#222;color:#eee}
button{padding:0 14px;border:0;border-radius:6px;background:#3ddc84;font-size:15px}
</style><div id=st>…</div><div id=l></div>
<form id=f><input id=q placeholder="Gõ câu hỏi..." autocomplete=off><button>Hỏi</button>
<button type=button id=r style="background:#4c7bef;color:#fff">🎙</button><button type=button id=g style="background:#555;color:#fff">👂</button></form>
<script>document.write('<script src="/md.js?k='+encodeURIComponent(new URLSearchParams(location.search).get('k')||'')+'"><\\/script>')</script><script>
const k=new URLSearchParams(location.search).get('k'),L=document.getElementById('l'),els={};
const post=(p,b)=>fetch(p+'?k='+k,{method:'POST',body:b}).catch(()=>{});
r.onclick=()=>post('/rec');g.onclick=()=>post('/listen');
f.onsubmit=e=>{e.preventDefault();if(q.value.trim())post('/ask',q.value);q.value=''};
const WHO={them:'👥',me:'🎤',ask:'✍',sys:'ℹ'};
function add(e){
 if(e.kind==='rec'){r.style.background=e.on?'#d33':'#4c7bef';r.textContent=e.on?'⏹':'🎙';return}
 if(e.kind==='listen'){g.style.background=e.on?'#2d8a4e':'#555';return}
 if(e.kind==='fill-ask'){q.value=e.text||'';return}
 if(e.kind==='status'){st.textContent=({idle:'⚪ Sẵn sàng',listening:'🟢 Đang nghe',recording:'🔴 Đang ghi…',transcribing:'⏳ Đang nhận dạng…',thinking:'💭 AI đang nghĩ…',loading:'⏳ '+e.text,ready:'✅ '+e.text})[e.state]||e.state;return}
 if(e.kind==='delta'){let d=els[e.id];if(!d){d=els[e.id]=document.createElement('div');d.className='a';d.raw='';L.append(d)}d.raw+=e.text;d.textContent='';MD.render(document,d.raw,d)}
 else{const d=document.createElement('div');d.className=e.kind==='error'?'e':e.kind==='meta'?'m':'h';d.textContent=(e.kind==='heard'?(WHO[e.who]||'')+' ':'')+e.text;L.append(d)}
 scrollTo(0,document.body.scrollHeight)}
const es=new EventSource('/stream?k='+k);es.onopen=()=>{L.textContent='';for(const x in els)delete els[x]};es.onmessage=m=>add(JSON.parse(m.data));
es.onerror=()=>{st.textContent='⚠ Mất kết nối, đang thử lại…'};
</script>`;

function lanIp() {
  for (const list of Object.values(os.networkInterfaces()))
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) return i.address;
  return '127.0.0.1';
}

// deps: { getCfg, saveCfg, bus, handlers:{ask,rec,listen}, getState, host }
function createWebServer({ getCfg, saveCfg, bus, handlers, getState = () => ({}), host = process.env.HOST || '0.0.0.0' }) {
  let srv = null, port = 0, token = '';
  const sse = new Set();
  const hits = new Map(); // ip -> [timestamps]
  const limited = (ip, key, max, windowMs) => {
    const k = ip + key, now = Date.now(), a = (hits.get(k) || []).filter((t) => now - t < windowMs);
    a.push(now); hits.set(k, a); return a.length > max;
  };
  const sweep = setInterval(() => { const now = Date.now(); for (const [k, a] of hits) if (!a.some((t) => now - t < 60000)) hits.delete(k); }, 60000);
  sweep.unref();

  function authOk(u) {
    const a = Buffer.from(u.searchParams.get('k') || ''), b = Buffer.from(token);
    return a.length === b.length && b.length > 0 && crypto.timingSafeEqual(a, b);
  }
  const SEC = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' };

  function handle(req, res) {
    const ip = req.socket.remoteAddress || '?';
    let u; try { u = new URL(req.url, 'http://x'); } catch { res.writeHead(400, SEC); return res.end('bad'); }
    if (!authOk(u)) {
      if (limited(ip, 'auth', 10, 60000)) { res.writeHead(429, SEC); return res.end('too many'); }
      res.writeHead(403, SEC); return res.end('forbidden');
    }
    const p = u.pathname;
    if (req.method === 'POST' && (p === '/ask' || p === '/rec' || p === '/listen' || p === '/clear')) {
      if (limited(ip, 'act', 30, 60000)) { res.writeHead(429, SEC); return res.end('too many'); }
      let b = '', over = false;
      req.on('data', (d) => { b += d; if (b.length > 4096) { over = true; res.writeHead(413, SEC); res.end('too large'); req.destroy(); } });
      req.on('end', () => {
        if (over) return;
        try {
          if (p === '/ask') handlers.ask(b.trim().slice(0, 2000));
          else if (p === '/rec') handlers.rec();
          else if (p === '/listen') handlers.listen();
          else handlers.clear();
        } catch {}
        res.writeHead(200, SEC); res.end('ok');
      });
      return;
    }
    if (req.method !== 'GET') { res.writeHead(405, SEC); return res.end(); }
    if (p === '/md.js') { res.writeHead(200, { ...SEC, 'Content-Type': 'application/javascript; charset=utf-8' }); return res.end(MD_JS); }
    if (p === '/state') { res.writeHead(200, { ...SEC, 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ...getState(), status: bus.status() })); }
    if (p === '/stream') {
      if (sse.size >= 20) { res.writeHead(503, SEC); return res.end('busy'); }
      res.writeHead(200, { ...SEC, 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
      const send = (e) => { try { res.write(`data: ${JSON.stringify(e)}\n\n`); } catch {} };
      send({ kind: 'status', ...bus.status() });
      bus.recent().forEach(send);
      const off = bus.on(send);
      const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 15000);
      const entry = { res, off, hb }; sse.add(entry);
      req.on('close', () => { clearInterval(hb); off(); sse.delete(entry); });
      return;
    }
    if (p === '/') { res.writeHead(200, { ...SEC, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'" }); return res.end(PAGE); }
    res.writeHead(404, SEC); res.end('not found');
  }

  async function start() {
    stop();
    const cfg = getCfg();
    if (!cfg.serve) return null;
    token = cfg.token;
    if (!token) { token = crypto.randomBytes(8).toString('hex'); saveCfg({ token }); }
    for (let p = cfg.port; p < cfg.port + 10; p++) {
      const s = http.createServer(handle);
      s.requestTimeout = 0; s.headersTimeout = 15000;
      const ok = await new Promise((resolve) => {
        s.once('error', (e) => resolve(e.code === 'EADDRINUSE' ? false : Promise.reject(e)));
        s.listen(p, host, () => resolve(true));
      }).catch(() => false);
      if (ok) { srv = s; port = p; s.on('error', () => {}); return p; }
    }
    return null;
  }
  function stop() {
    for (const e of sse) { clearInterval(e.hb); e.off(); try { e.res.end(); } catch {} }
    sse.clear();
    if (srv) { srv.close(); srv.closeAllConnections?.(); srv = null; port = 0; }
  }
  return {
    start, stop,
    url: () => (srv ? `http://${lanIp()}:${port}/?k=${token}` : ''),
    port: () => port, token: () => token, clients: () => sse.size,
  };
}
module.exports = { createWebServer };
