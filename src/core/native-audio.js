'use strict';
// Thu âm trên Linux: pw-record (PipeWire) hoặc parec (PulseAudio).
//  them = âm thanh phát ra từ loa/tai nghe (người khác trong cuộc họp)
//  me   = micro của bạn
const { spawn } = require('child_process');
const Vad = require('./vad');
const { int16ToBuffer } = require('./util');

const RATE = 16000, FRAME_BYTES = RATE / 10 * 2;     // khung 100ms, s16 mono
const MANUAL_MAX_FRAMES = 1200;                       // giữ tối đa 120s gần nhất

function createNativeAudio({ loadCfg, emit, onSegment, spawnFn = spawn }) {
  const procs = new Set();
  let auto = false, manual = false, wanted = false;
  let manualBufs = { them: [], me: [] };
  let retries = { them: 0, me: 0 };
  let gen = 0;                                   // tăng mỗi lần dừng: huỷ các lần nối lại đang chờ

  const kinds = (cfg) => (cfg.source === 'both' ? ['them', 'me'] : cfg.source === 'mic' ? ['me'] : ['them']);
  const cmds = (who, target) => {
    const mic = who === 'me';
    return [
      // target (tuỳ chọn): tên thiết bị phát muốn thu, vd "alsa_output.pci-0000_00_1f.3.analog-stereo"
      ['pw-record', ['--rate', RATE, '--channels', 1, '--format', 's16', ...(!mic && target ? ['--target', target] : []), ...(mic ? [] : ['-P', 'stream.capture.sink=true']), '-']],
      ['parec', [`--device=${mic ? '@DEFAULT_SOURCE@' : target ? target + '.monitor' : '@DEFAULT_MONITOR@'}`, `--rate=${RATE}`, '--channels=1', '--format=s16le']],
    ];
  };

  function capture(cfg, who, attempt = 0) {
    const list = cmds(who, cfg.captureTarget);
    if (attempt >= list.length) { emit({ kind: 'error', text: 'Không tìm thấy pw-record/parec. Cài pipewire hoặc pulseaudio-utils.' }); wanted = false; return; }
    const [cmd, args] = list[attempt];
    const p = spawnFn(cmd, args.map(String), { stdio: ['ignore', 'pipe', 'ignore'] });
    const entry = { p, who, killed: false };
    const startedAt = Date.now();
    procs.add(entry);
    let spawned = true;
    p.on('error', () => { spawned = false; procs.delete(entry); capture(cfg, who, attempt + 1); });
    const vad = new Vad({ rate: RATE, threshold: cfg.silence });
    let buf = Buffer.alloc(0);
    p.stdout.on('data', (d) => {
      buf = buf.length ? Buffer.concat([buf, d]) : d;
      while (buf.length >= FRAME_BYTES) {
        const f = Buffer.from(buf.subarray(0, FRAME_BYTES)); buf = buf.subarray(FRAME_BYTES);
        if (manual) {
          const a = manualBufs[who]; a.push(f); if (a.length > MANUAL_MAX_FRAMES) a.shift();
          vad.reset();
        } else if (auto) {
          const seg = vad.feed(new Int16Array(f.buffer.slice(f.byteOffset, f.byteOffset + f.length)));
          if (seg) onSegment(int16ToBuffer(seg), who);
        }
      }
    });
    p.on('close', () => {
      procs.delete(entry);
      if (!spawned || entry.killed || !wanted) return;
      if (Date.now() - startedAt > 30000) retries[who] = 0; // đã chạy ổn định thì làm mới bộ đếm
      // tiến trình thu âm chết bất ngờ (đổi thiết bị, PipeWire khởi động lại…)
      if (retries[who] < 3) {
        retries[who]++;
        emit({ kind: 'error', text: `⚠ Mất nguồn thu "${who === 'me' ? 'micro' : 'loa'}", đang kết nối lại (${retries[who]}/3)…` });
        const g = gen;
        setTimeout(() => { if (wanted && g === gen) capture(loadCfg(), who, attempt); }, 1000);
      } else { emit({ kind: 'error', text: 'Nguồn thu âm bị ngắt nhiều lần. Bấm lại để thử.' }); }
    });
  }

  function ensure() {
    if (procs.size) return;
    wanted = true; retries = { them: 0, me: 0 };
    const cfg = loadCfg();
    kinds(cfg).forEach((w) => capture(cfg, w));
  }
  function killAll() {
    wanted = false; gen++;
    for (const e of procs) { e.killed = true; try { e.p.kill(); } catch {} }
    procs.clear();
  }
  const concat = (arr) => (arr.length ? Buffer.concat(arr) : null);

  return {
    startAuto() { auto = true; ensure(); },
    stopAuto() { auto = false; if (!manual) killAll(); },
    manualStart() { manualBufs = { them: [], me: [] }; manual = true; ensure(); },
    async manualStop() {
      manual = false;
      const out = { them: concat(manualBufs.them), me: concat(manualBufs.me) };
      manualBufs = { them: [], me: [] };
      if (!auto) killAll();
      return out;
    },
    reload() { if (!procs.size) return; killAll(); ensure(); },   // áp dụng cài đặt mới (nguồn, thiết bị, ngưỡng)
    isAuto: () => auto, isManual: () => manual,
    killAll,
    count: () => procs.size,
  };
}
module.exports = { createNativeAudio };
