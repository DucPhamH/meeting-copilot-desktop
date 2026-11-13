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
});
test('index.html tham chiếu đủ script và các id mà renderer cần', () => {
  const h = fs.readFileSync(path.join(src, 'index.html'), 'utf8'), r = fs.readFileSync(path.join(src, 'renderer.js'), 'utf8');
  for (const s of ['core/vad.js', 'core/md.js', 'capture-web.js', 'renderer.js']) assert.ok(h.includes(s), s);
  const ids = new Set([...r.matchAll(/\$\('([\w-]+)'\)/g)].map((m) => m[1]));
  for (const id of ids) assert.ok(h.includes(`id="${id}"`), 'renderer dùng #' + id + ' nhưng index.html không có');
});
