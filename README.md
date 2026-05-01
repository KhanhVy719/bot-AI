# Discord AI Selfbot

Bot Discord AI sử dụng **tài khoản người dùng** (selfbot) thay vì bot token truyền thống.

> ⚠️ **Cảnh báo:** Selfbot vi phạm Discord Terms of Service. Tài khoản có thể bị ban.

## Cài đặt

```bash
npm install
```

## Cấu hình

1. Copy `.env.example` thành `.env`:
   ```bash
   cp .env.example .env
   ```

2. Điền thông tin vào `.env`:
   - `DISCORD_USER_TOKEN` — Token của tài khoản Discord
   - `AI_API_KEY` — API key cho AI service

### Cách lấy Discord User Token

1. Mở Discord trên **trình duyệt** hoặc **Discord Desktop**
2. Nhấn `Ctrl + Shift + I` (hoặc `F12`) để mở DevTools
3. Chuyển qua tab **Console**
4. Paste đoạn code sau và nhấn Enter:

```js
// Cách 1: Từ Network tab
// Mở tab Network > lọc "api" > gửi 1 tin nhắn bất kỳ
// Tìm request bất kỳ > Headers > Authorization

// Cách 2: Từ Console
(webpackChunkdiscord_app.push([[''],{},e=>{m=[];for(let c in e.c)m.push(e.c[c])}]),m).find(m=>m?.exports?.default?.getToken!==void 0).exports.default.getToken()
```

5. Copy token và dán vào `.env`

> 🔐 **KHÔNG BAO GIỜ** chia sẻ token với bất kỳ ai!

## Chạy

```bash
npm start
```

## Cách sử dụng

Bot sẽ phản hồi khi:
- Được **mention** (@tên account)
- Tin nhắn bắt đầu bằng **prefix** (mặc định: `!`)
- **Reply** vào tin nhắn của account selfbot
- Nhắn tin **DM** trực tiếp

### Lệnh đặc biệt
- `!reset` hoặc mention + `reset` — Xóa lịch sử cuộc hội thoại

## Biến môi trường

| Biến | Bắt buộc | Mô tả |
|------|----------|-------|
| `DISCORD_USER_TOKEN` | ✅ | Token tài khoản Discord |
| `AI_API_KEY` | ✅ | API key cho AI |
| `AI_BASE_URL` | ❌ | URL API AI (mặc định: `https://ai.khanhwiee.site/v1`) |
| `AI_MODEL` | ❌ | Model AI (mặc định: `cx/gpt-5.5`) |
| `BOT_PREFIX` | ❌ | Prefix lệnh (mặc định: `!`) |
| `ENABLE_HISTORY` | ❌ | Lưu lịch sử chat (mặc định: `true`) |
| `MAX_HISTORY_MESSAGES` | ❌ | Số tin nhắn lịch sử tối đa (mặc định: `12`) |
| `AI_TEMPERATURE` | ❌ | Temperature AI (mặc định: `0.7`) |
| `AI_MAX_TOKENS` | ❌ | Max tokens phản hồi (mặc định: `1200`) |
| `SYSTEM_PROMPT` | ❌ | System prompt cho AI |
