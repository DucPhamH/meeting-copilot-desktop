'use strict';
const { app, BrowserWindow, ipcMain, desktopCapturer, session, globalShortcut, screen, dialog, systemPreferences } = require('electron');
const fs = require('fs');
const path = require('path');

const { createStore } = require('./core/config');
const { createBus } = require('./core/bus');
const { createStt } = require('./core/stt');
const llm = require('./core/llm');
const { createPipeline } = require('./core/pipeline');
const { createNativeAudio } = require('./core/native-audio');
const { createWebServer } = require('./core/server');
const { friendlyError } = require('./core/util');

// ---- Ngụy trang + thư mục dữ liệu (đặt TRƯỚC khi app sẵn sàng; giữ nguyên thư mục cũ dù đổi tên) ----
const DISGUISE = process.env.DISGUISE_NAME || 'System Monitor';
process.title = DISGUISE;
app.setPath('userData', process.env.MC_USER_DATA || path.join(app.getPath('appData'), 'meeting-copilot'));
app.setName(DISGUISE);
if (process.platform === 'darwin') {
  if (app.dock) app.dock.hide();
  app.commandLine.appendSwitch('enable-features', 'MacLoopbackAudioForScreenShare'); // âm thanh hệ thống trên macOS 14.2+
}

const IS_LINUX = process.platform === 'linux';
const MASK = '••••••••';
const rootDir = path.join(__dirname, '..');

let win = null, recTimer = null;
const bus = createBus();
const emit = (ev) => bus.emit(ev);
const notice = (t) => emit({ kind: 'error', text: t });
const send = (ch, ...a) => { if (win && !win.isDestroyed()) win.webContents.send(ch, ...a); };

let store, stt, pipeline, audio, web;
const loadCfg = () => store.load();

// ---------- Thu âm cho Windows/macOS: renderer lấy âm thanh, main điều khiển ----------
function createRendererAudio() {
  let auto = false, manual = false, waiting = null;
  // executeJavaScript(…, userGesture=true): Chromium đòi "cử chỉ người dùng" cho getDisplayMedia,
  // mà lệnh thường đến từ phím tắt toàn cục / điện thoại nên không có sẵn.
  const run = (kind, v, cfg) => {
    if (!win || win.isDestroyed()) return;
    win.webContents.executeJavaScript(`Cap.command(${JSON.stringify(kind)},${JSON.stringify(v === undefined ? null : v)},${JSON.stringify(cfg || null)})`, true).catch(() => {});
  };
  return {
    startAuto() { auto = true; run('auto', true, loadCfg()); },
    stopAuto() { auto = false; run('auto', false, null); },       // renderer tự giữ nguồn nếu đang ghi thủ công
    manualStart() { manual = true; run('manual-start', true, loadCfg()); },
    manualStop() {
      manual = false;
      return new Promise((resolve) => {
        const timer = setTimeout(() => { if (waiting && waiting.timer === timer) { waiting = null; resolve({ them: null, me: null }); } }, 6000);
        waiting = { resolve, timer };   // mỗi lần dừng một "phiếu" riêng: hẹn giờ cũ không phá lần ghi sau
        run('manual-stop');
      });
    },
    resolveManual(o) { if (waiting) { clearTimeout(waiting.timer); const r = waiting.resolve; waiting = null; r(o); } },
    reload() { if (auto || manual) run('reload', null, loadCfg()); },
    isAuto: () => auto, isManual: () => manual,
    killAll() { auto = false; manual = false; run('auto', false, null); },
  };
}

// ---------- Điều khiển ----------
const missingKey = (cfg) => (cfg.sttMode === 'api' || cfg.provider === 'api') && !cfg.apiKey;

function preflight() {
  const cfg = loadCfg();
  if (missingKey(cfg)) {
    emit({ kind: 'error', text: 'Chưa nhập API key (⚙). Hoặc chọn "Whisper trên máy" + "Claude Code trên máy" để không cần key.' });
    send('open-settings');
    return false;
  }
  if (cfg.sttMode === 'local') {
    try { stt.warmup(cfg).catch((e) => emit({ kind: 'error', text: friendlyError(e) })); }
    catch (e) { emit({ kind: 'error', text: friendlyError(e) }); return false; }
  }
  if (process.platform === 'darwin') systemPreferences.askForMediaAccess('microphone').catch(() => {});
  return true;
}

function setListening(on) {
  if (on === audio.isAuto()) return;
  if (on) { if (!preflight()) { emit({ kind: 'listen', on: false }); return; } audio.startAuto(); pipeline.status('listening'); }
  else { audio.stopAuto(); pipeline.status(audio.isManual() ? 'recording' : 'idle'); }
  emit({ kind: 'listen', on });
}
function toggleManual() { audio.isManual() ? stopManual() : startManual(); }
function startManual() {
  if (!preflight()) return;
  audio.manualStart();
  emit({ kind: 'rec', on: true });
  pipeline.status('recording', 'Đang ghi… bấm lại để dừng và gửi');
  clearTimeout(recTimer);
  recTimer = setTimeout(() => { if (audio.isManual()) { notice('⏱ Ghi quá 2 phút — tự dừng và gửi.'); stopManual(); } }, 125000);
}
async function stopManual() {
  clearTimeout(recTimer);
  emit({ kind: 'rec', on: false });
  pipeline.status('transcribing', 'Đang nhận dạng…');
  const out = await audio.manualStop();
  pipeline.handleManual(out || { them: null, me: null });
}

async function captureScreenDataUrl() {
  const d = screen.getPrimaryDisplay().size;
  const wasVisible = win && win.isVisible();
  const hideSelf = IS_LINUX && wasVisible;      // Windows/macOS: cửa sổ đã được loại khỏi ảnh chụp
  if (hideSelf) { win.hide(); await new Promise((r) => setTimeout(r, 250)); }
  try {
    const srcs = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: Math.min(d.width, 1920), height: Math.min(d.height, 1200) } });
    if (!srcs[0] || srcs[0].thumbnail.isEmpty()) throw new Error('Không chụp được màn hình (trên Wayland hãy cấp quyền chia sẻ màn hình khi được hỏi).');
    return 'data:image/jpeg;base64,' + srcs[0].thumbnail.toJPEG(80).toString('base64');
  } finally { if (hideSelf) win.showInactive(); }
}

// ---------- Cửa sổ ----------
// Windows: WDA_EXCLUDEFROMCAPTURE cần cửa sổ layered. Pulse opacity CHỈ lúc tạo/show —
// gọi setOpacity khi đang kéo sẽ lộ khung HWND trên màn hình thật và trong share.
let protectTimer = null;
function protectFromCapture(opts = {}) {
  if (!win || win.isDestroyed()) return;
  try {
    if (opts.layered) {
      win.setOpacity(0.99);
      win.setContentProtection(true);
      win.setOpacity(1);
    } else {
      win.setContentProtection(true);
    }
  } catch {
    try { win.setContentProtection(true); } catch {}
  }
}
function protectSoon() {
  clearTimeout(protectTimer);
  protectTimer = setTimeout(() => protectFromCapture(), 250);
}

function createWindow() {
  const { width } = screen.getPrimaryDisplay().workAreaSize;
  win = new BrowserWindow({
    width: 460, height: 600, x: Math.max(0, width - 480), y: 40, minWidth: 320, minHeight: 360,
    frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true, hasShadow: false, resizable: false, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.setTitle(DISGUISE);
  win.on('page-title-updated', (e) => e.preventDefault());
  protectFromCapture({ layered: true }); // Windows/macOS: ẩn khỏi share. Linux: không có tác dụng.
  win.on('show', () => protectFromCapture({ layered: true }));
  win.on('moved', protectSoon);
  win.on('resized', protectSoon);
  // Một số sự kiện Windows làm mất affinity — chỉ setContentProtection, không pulse opacity.
  setInterval(() => { if (win && !win.isDestroyed() && win.isVisible()) protectFromCapture(); }, 2000).unref();
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.on('render-process-gone', () => { if (win && !win.isDestroyed()) win.reload(); });
  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(__dirname, 'index.html'));
}

function registerShortcuts() {
  const reg = (key, fn, what) => {
    let ok = false; try { ok = globalShortcut.register(key, fn); } catch {}
    if (!ok) notice(`⚠ Phím tắt ${key} (${what}) đang bị ứng dụng khác chiếm — dùng nút trên giao diện.`);
  };
  reg('CommandOrControl+Shift+H', () => { if (!win) return; win.isVisible() ? win.hide() : win.showInactive(); }, 'ẩn/hiện');
  reg('CommandOrControl+Shift+S', () => pipeline.shot(captureScreenDataUrl), 'chụp màn hình');
  reg('CommandOrControl+Shift+Space', toggleManual, 'ghi/gửi');
  let through = false;
  reg('CommandOrControl+Shift+C', () => {
    through = !through;
    win.setIgnoreMouseEvents(through, { forward: true });
    if (!through) protectFromCapture();
    send('clickthrough', through);
  }, 'click xuyên');
}

// Máy chủ trang điện thoại: tuần tự hoá để hai lần lưu cài đặt liên tiếp không mở trùng cổng
let webChain = Promise.resolve();
const startWeb = () => (webChain = webChain.then(doStartWeb, doStartWeb));
async function doStartWeb() {
  const p = await web.start();
  const cfg = loadCfg();
  if (cfg.serve && p && p !== cfg.port) notice(`ℹ Cổng ${cfg.port} đang bận, dùng cổng ${p} cho trang điện thoại.`);
  if (cfg.serve && !p) notice('⚠ Không mở được máy chủ trang điện thoại (cổng bận?).');
}

function init() {
  stt = createStt({ emit, notice, rootDir, userDir: app.getPath('userData') });
  store = createStore(path.join(app.getPath('userData'), 'settings.json'), { hasLocalWhisper: stt.hasLocal(), serve: IS_LINUX });
  audio = IS_LINUX && !process.env.MC_FORCE_WEB_AUDIO
    ? createNativeAudio({ loadCfg, emit, onSegment: (pcm, who) => pipeline.handleSegment(pcm, who) })
    : createRendererAudio();
  pipeline = createPipeline({
    loadCfg, emit, stt, llm, isListening: () => audio.isAuto(), isRecording: () => audio.isManual(),
    logFile: path.join(app.getPath('userData'), 'answers.log'),
  });
  web = createWebServer({
    getCfg: loadCfg, saveCfg: (p) => store.save(p), bus,
    handlers: { ask: (t) => pipeline.ask(t), rec: toggleManual, listen: () => setListening(!audio.isAuto()), clear: () => { pipeline.reset(); bus.clear(); } },
    getState: () => ({ listening: audio.isAuto(), recording: audio.isManual(), version: app.getVersion() }),
  });
  bus.on((ev) => send('result', ev));

  app.whenReady().then(async () => {
    session.defaultSession.setPermissionRequestHandler((wc, perm, cb, details) => cb(perm === 'media' && /^file:/.test(details.requestingUrl || '')));
    session.defaultSession.setDisplayMediaRequestHandler(async (req, cb) => {
      try { const sources = await desktopCapturer.getSources({ types: ['screen'] }); cb({ video: sources[0], audio: 'loopback' }); }
      catch { cb({}); }
    });
    createWindow();
    if (process.env.MC_E2E) { // chỉ dùng khi test: chụp ảnh cửa sổ (và chạy JS) theo yêu cầu qua tệp cờ
      const flag = path.join(app.getPath('userData'), 'shot.req');
      setInterval(async () => {
        if (!(fs.existsSync(flag) && win)) return;
        const js = fs.readFileSync(flag, 'utf8'); fs.unlinkSync(flag);
        if (js.trim()) { await win.webContents.executeJavaScript(js); await new Promise((r) => setTimeout(r, 300)); }
        fs.writeFileSync(path.join(app.getPath('userData'), 'shot.png'), (await win.webContents.capturePage()).toPNG());
      }, 300).unref();
    }
    registerShortcuts();
    await startWeb();
  });

  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.showInactive(); } });
  app.on('window-all-closed', () => app.quit());
  let cleaned = false;
  const cleanup = () => { if (cleaned) return; cleaned = true; try { globalShortcut.unregisterAll(); } catch {} audio && audio.killAll(); stt && stt.stop(); web && web.stop(); };
  app.on('will-quit', cleanup);
  process.on('exit', cleanup);
  for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(s, () => app.quit());
  process.on('uncaughtException', (e) => { try { notice('Lỗi nội bộ: ' + friendlyError(e)); } catch {} });
  process.on('unhandledRejection', (e) => { try { notice('Lỗi nội bộ: ' + friendlyError(e)); } catch {} });

  // ---- IPC ----
  ipcMain.handle('cfg:get', () => { const c = loadCfg(); return { ...c, apiKey: c.apiKey ? MASK : '', token: undefined }; });
  ipcMain.handle('cfg:set', async (_, patch) => {
    patch = patch && typeof patch === 'object' ? { ...patch } : {};
    delete patch.token;
    if (patch.apiKey === MASK) delete patch.apiKey;
    const before = loadCfg();
    store.save(patch);
    const after = loadCfg();
    // Áp dụng ngay cho thứ đang chạy
    if (['whisperModel', 'language', 'sttMode'].some((k) => before[k] !== after[k])) stt.stop();   // worker nạp lại với cấu hình mới
    if (['source', 'captureTarget', 'silence'].some((k) => before[k] !== after[k]) && audio.reload) audio.reload();
    if (before.serve !== after.serve || before.port !== after.port) await startWeb();
    return { url: web.url() };
  });
  ipcMain.handle('info', () => ({ platform: process.platform, url: web.url(), hasLocalWhisper: stt.hasLocal(), listening: audio.isAuto(), recording: audio.isManual(), version: app.getVersion() }));
  ipcMain.handle('ask', (_, t, q) => pipeline.ask(String(t || ''), q ? String(q) : undefined));
  ipcMain.handle('shot', () => pipeline.shot(captureScreenDataUrl));
  ipcMain.handle('manual', () => toggleManual());
  ipcMain.handle('listen', (_, on) => setListening(typeof on === 'boolean' ? on : !audio.isAuto()));
  ipcMain.handle('clear', () => { pipeline.reset(); bus.clear(); });
  ipcMain.handle('export', async () => {
    const { canceled, filePath } = await dialog.showSaveDialog(win, { defaultPath: `cuoc-hop-${new Date().toISOString().slice(0, 10)}.md`, filters: [{ name: 'Markdown', extensions: ['md'] }] });
    if (canceled || !filePath) return { ok: false };
    try { fs.writeFileSync(filePath, pipeline.exportMarkdown(), { mode: 0o600 }); return { ok: true, filePath }; }
    catch (e) { return { ok: false, error: e.message }; }
  });
  // Chỉ nhận đoạn âm thanh khi đang nghe (tránh "rò" nếu renderer chưa kịp đóng nguồn)
  ipcMain.on('audio:segment', (_, ab, who) => { if (audio.isAuto() && ab && (who === 'them' || who === 'me')) pipeline.handleSegment(Buffer.from(ab), who); });
  ipcMain.on('audio:manual', (_, o) => { if (audio.resolveManual) audio.resolveManual({ them: o && o.them ? Buffer.from(o.them) : null, me: o && o.me ? Buffer.from(o.me) : null }); });
  ipcMain.on('quit', () => app.quit());
  // Kéo cửa sổ tự xử lý: vùng kéo hệ thống đi qua vòng kéo của Windows, vốn chỉ vẽ khung
  // chữ nhật (lộ cả khi share) nếu người dùng tắt "Show window contents while dragging".
  let dragOffset = null;
  ipcMain.on('win:drag-start', () => {
    if (!win || win.isDestroyed()) return;
    const c = screen.getCursorScreenPoint(), b = win.getBounds();
    dragOffset = { dx: c.x - b.x, dy: c.y - b.y, width: b.width, height: b.height };
  });
  ipcMain.on('win:drag-move', () => {
    if (!dragOffset || !win || win.isDestroyed()) return;
    const c = screen.getCursorScreenPoint();
    win.setPosition(c.x - dragOffset.dx, c.y - dragOffset.dy);
    // Màn hình scale lẻ (125%…): mỗi lần đặt vị trí Electron làm tròn và nới cửa sổ thêm vài px.
    const [w, h] = win.getSize();
    if (w !== dragOffset.width || h !== dragOffset.height) win.setSize(dragOffset.width, dragOffset.height);
  });
}

if (!app.requestSingleInstanceLock()) { app.quit(); } else { init(); }
