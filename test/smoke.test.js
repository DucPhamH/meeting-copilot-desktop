'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const { execFileSync } = require('child_process');
const src = path.join(__dirname, '..', 'src');
const files = [...fs.readdirSync(src), ...fs.readdirSync(path.join(src, 'core')).map((f) => 'core/' + f)].filter((f) => /\.(js|html|py)$/.test(f));

test('mọi file nguồn đều không rỗng và JS đều hợp lệ cú pháp', () => {
  assert.ok(files.length >= 16, 'thiếu file: ' + files.length);
  for (const f of files) {
    const p = path.join(src, f); assert.ok(fs.statSync(p).size > 100, `${f} rỗng hoặc quá nhỏ`);
    if (f.endsWith('.js')) execFileSync(process.execPath, ['--check', p]);
  }
});
test('main.js có đủ các phần cốt lõi (không bị cắt/xoá)', () => {
  const m = fs.readFileSync(path.join(src, 'main.js'), 'utf8');
  for (const k of ['requestSingleInstanceLock', 'createWindow', 'ipcMain.handle(\'cfg:set\'', 'createRendererAudio', 'setContentProtection', 'audio:segment', 'cleanup']) assert.ok(m.includes(k), 'thiếu ' + k);
  assert.match(m, /setOpacity\s*\(\s*0\.99\s*\)[\s\S]*setContentProtection[\s\S]*setOpacity\s*\(\s*1\s*\)/, 'pulse setOpacity 0.99→1 để ép layered khi cần');
  assert.match(m, /layered:\s*true/, 'chỉ pulse opacity khi tạo/show, không lúc đang kéo');
  assert.match(m, /protectSoon/, 'sau kéo/resize chỉ gắn lại protection khi đã dừng');
  assert.match(m, /\.on\(\s*['"]moved['"]\s*,\s*protectSoon\)/, 'moved phải debounce, không pulse mỗi pixel');
  assert.match(m, /\.on\(\s*['"]resized['"]\s*,\s*protectSoon\)/, 'resized phải debounce');
  assert.match(m, /resizable:\s*false/, 'tắt resize để bớt lộ cạnh cửa sổ');
  assert.match(m, /setIgnoreMouseEvents[\s\S]*protectFromCapture\s*\(/, 'sau khi tắt click xuyên phải gắn lại content protection');
  assert.match(m, /ipcMain\.on\('win:drag-start'/, 'kéo cửa sổ tự xử lý, không qua vòng kéo của Windows');
  assert.match(m, /ipcMain\.on\('win:drag-move'/, 'kéo cửa sổ tự xử lý, không qua vòng kéo của Windows');
});
test('dropdown và tooltip vẽ trong trang (popup gốc là cửa sổ riêng, lộ khi share)', () => {
  const r = fs.readFileSync(path.join(src, 'renderer.js'), 'utf8');
  assert.match(r, /'select'[\s\S]*preventDefault/, 'phải chặn popup gốc của <select>');
  assert.match(r, /removeAttribute\('title'\)/, 'phải bỏ title để không hiện tooltip gốc');
});
test('thanh tiêu đề không dùng vùng kéo hệ thống (Windows vẽ khung khi tắt "hiện nội dung khi kéo")', () => {
  const h = fs.readFileSync(path.join(src, 'index.html'), 'utf8');
  assert.doesNotMatch(h, /app-region:\s*drag/);
});
test('index.html tham chiếu đủ script và các id mà renderer cần', () => {
  const h = fs.readFileSync(path.join(src, 'index.html'), 'utf8'), r = fs.readFileSync(path.join(src, 'renderer.js'), 'utf8');
  for (const s of ['core/vad.js', 'core/md.js', 'capture-web.js', 'renderer.js']) assert.ok(h.includes(s), s);
  const ids = new Set([...r.matchAll(/\$\('([\w-]+)'\)/g)].map((m) => m[1]));
  for (const id of ids) assert.ok(h.includes(`id="${id}"`), 'renderer dùng #' + id + ' nhưng index.html không có');
});
