# System Monitor (Meeting Copilot)

Nghe cuộc họp → nhận dạng giọng nói → AI gợi ý câu trả lời để bạn đọc to. Cửa sổ nổi, có thể ẩn khỏi
màn hình chia sẻ (Windows/macOS) hoặc xem trên điện thoại (mọi hệ điều hành).

## Chạy
```bash
npm install
npm start          # dev (Linux tự thêm --no-sandbox)
npm run dist       # đóng gói: AppImage/deb (Linux), nsis (Windows), dmg (macOS) — build trên đúng hệ điều hành đó
```
Mở ⚙ để cài đặt. **Không cần key nào** nếu chọn: *Bộ não AI = Claude Code trên máy* + *Phiên âm = Whisper trên máy*.

## Cách dùng
- **🎙 Ghi câu hỏi** (`Ctrl+Shift+Space`): bấm để ghi, bấm lại để nhận dạng cả đoạn thành MỘT câu hỏi. Nội dung phiên âm được điền vào ô gõ bên dưới. Ít tốn model nhất.
- **Sau khi ghi câu hỏi** (⚙ → Nâng cao): chọn *Điền vào ô và gửi AI ngay* (mặc định) hoặc *Chỉ điền vào ô* để sửa rồi gửi tay.
- **👂 Nghe liên tục**: tự cắt câu, tự trả lời khi nghe ra câu hỏi (có lọc chào hỏi/nhiễu).
- Gõ câu hỏi, các nút nhanh, **📷** chụp màn hình (cần model API có vision), **💾** xuất bản ghi `.md`, **🗑** cuộc họp mới.
- Cài **Hồ sơ của tôi** (CV/kinh nghiệm) và **Kiểu trả lời** để câu trả lời đúng giọng của bạn.
- Mỗi câu trả lời có dòng nguồn + thời gian: `↳ Claude Code trên máy · haiku · nghe 0.6s · chữ đầu 0.9s · xong 2.1s`.

## Phím tắt
`Ctrl/Cmd+Shift+` — `Space` ghi/gửi · `H` ẩn/hiện · `S` chụp màn hình · `C` click xuyên

## Ẩn khỏi màn hình chia sẻ — sự thật
| Hệ điều hành | Cửa sổ ẩn khi share? | Ghi chú |
|---|---|---|
| Windows 10 2004+ | Có (chưa tự kiểm chứng trên máy thật) | `setContentProtection` |
| macOS | Có, nhưng macOS 15+ có thể vẫn lộ | test trước khi họp |
| **Linux** | **Không** | Electron không có API; dùng **trang điện thoại** (link ở thanh vàng) hoặc chỉ share 1 cửa sổ/tab |

Trang điện thoại: cùng wifi mở link `http://IP:cổng/?k=<mã>`. Mã bí mật là thứ duy nhất chặn người lạ — đừng chia sẻ link.

## Thu âm
- **Linux**: `pw-record` (PipeWire) hoặc `parec`. Thu *mọi* âm thanh phát ra thiết bị mặc định (nhạc/video cũng bị thu!).
  Dùng ô "Thiết bị phát cần thu" (⚙ → Nâng cao) để chọn riêng một thiết bị.
- **Windows**: loopback hệ thống + micro. **macOS**: micro; âm thanh hệ thống cần BlackHole/Loopback.

## Dự phòng tự động
Phiên âm API lỗi/hết hạn mức → Whisper local. AI qua API lỗi/hết hạn mức → Claude Code. (Lỗi key sai / model sai thì báo, không chuyển.)

## Whisper local (tuỳ chọn)
```bash
python3 -m venv .venv && .venv/bin/pip install faster-whisper     # hoặc đặt venv ở <userData>/venv
```
Model `small` (~0.5GB) tự tải lần đầu. `medium` chính xác hơn, chậm hơn. Bản đóng gói không kèm Python.

## Kiểm thử
```bash
npm test          # 78 test: VAD, cấu hình, markdown, pipeline (server API giả + claude giả), thu âm, máy chủ
npm run e2e       # THẬT: Electron + PipeWire + Groq + Claude (cần key trong ~/.config/meeting-copilot, phát tiếng ra loa nhỏ)
npm run e2e:web   # đường thu âm Windows/macOS chạy trên Linux bằng micro giả của Chromium
```
(`test/audio` + `voices/` là giọng tổng hợp để test; `voices/` có thể xoá nếu không chạy e2e.)

## Dữ liệu
`~/.config/meeting-copilot/` (hoặc `%APPDATA%`/`~/Library/Application Support`): `settings.json` (quyền 600, chứa API key),
`answers.log` (nguồn + thời gian + 300 ký tự đầu mỗi câu trả lời). Biến môi trường: `DISGUISE_NAME`, `HOST`, `MC_USER_DATA`.

## Quyền riêng tư
Âm thanh/câu hỏi gửi tới nhà cung cấp bạn chọn (Groq/OpenAI/Anthropic). Chỉ Whisper local xử lý hoàn toàn trên máy.
Nhiều công ty/buổi phỏng vấn cấm dùng AI hỗ trợ — bạn tự chịu trách nhiệm.
