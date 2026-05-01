# Discord AI Bot

Bot Discord có dashboard web, hỗ trợ hội thoại AI và phân tích file đính kèm.

> Lưu ý: project này chạy bằng tài khoản người dùng Discord. Hãy tự kiểm tra và chịu trách nhiệm với cách bạn sử dụng.

## Yêu cầu

- Node.js `22.3.0` trở lên
- npm

## Cài đặt

1. Clone repository.
2. Cài dependency:

```bash
npm install
```

## Cấu hình

1. Tạo file `.env` từ `.env.example`.
2. Điền các biến cần thiết trong `.env`.

### Biến bắt buộc

- `DISCORD_USER_TOKEN` — token tài khoản Discord dùng để chạy bot
- `AI_API_KEY` — khóa truy cập dịch vụ AI

### Biến tùy chọn

Các biến còn lại trong `.env.example` có thể giữ mặc định hoặc chỉnh sau theo nhu cầu, ví dụ:
- `BOT_PREFIX`
- `ENABLE_HISTORY`
- `MAX_HISTORY_MESSAGES`
- `SYSTEM_PROMPT`

## Chạy ứng dụng

```bash
npm start
```

Sau khi chạy, ứng dụng sẽ:
- khởi động bot Discord
- mở dashboard local để xem trạng thái, logs và cấu hình

## Dashboard

Dashboard dùng để:
- xem bot đang online hay offline
- xem log hoạt động
- cập nhật cấu hình
- khởi động lại bot sau khi đổi cấu hình

## Cách dùng

### Hội thoại

- Trong DM: bot trả lời trực tiếp.
- Trong server: bot xử lý tin nhắn trong kênh mà tài khoản đang tham gia.
- Gửi `reset` để xóa lịch sử hội thoại của cuộc trò chuyện hiện tại.

### Gửi file để phân tích

Bot có thể đọc và phân tích:
- file text / code / config như `txt`, `md`, `js`, `ts`, `json`, `yaml`, `csv`, ...
- file Word `docx`
- file Excel `xlsx`, `xls`
- file PDF `pdf`
- file ảnh như `png`, `jpg`, `jpeg`, `webp`, ...

### Phân tích hình ảnh

Bot hỗ trợ:
- ảnh đính kèm trực tiếp trong tin nhắn
- ảnh nằm bên trong file Word (`.docx`)
- ảnh nằm bên trong file PDF (`.pdf`)

Khi một tài liệu có cả chữ và ảnh, bot sẽ kết hợp cả hai để trả lời.

## Gợi ý sử dụng

- Gửi file kèm câu hỏi cụ thể để bot phân tích chính xác hơn.
- Với tài liệu dài, nên hỏi rõ phần bạn muốn bot tập trung.
- Với ảnh hoặc tài liệu có ảnh, nên nói rõ bạn muốn mô tả, tóm tắt hay trích xuất thông tin gì.

## Kiểm tra nhanh

Có thể kiểm tra cú pháp file chính bằng lệnh:

```bash
node --check src/index.js
```
