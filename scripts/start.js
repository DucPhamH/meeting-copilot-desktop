'use strict';
// Chạy app ở chế độ dev, tự chọn cờ theo hệ điều hành.
const { spawn } = require('child_process');
const electron = require('electron');
const args = ['.'];
if (process.platform === 'linux') args.push('--no-sandbox', '--ozone-platform-hint=auto'); // dev: chrome-sandbox chưa cấp quyền root
const p = spawn(electron, args, { stdio: 'inherit', cwd: require('path').join(__dirname, '..') });
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => p.kill(s));
p.on('exit', (c) => process.exit(c || 0));
