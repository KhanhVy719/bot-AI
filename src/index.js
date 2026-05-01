import "dotenv/config";
import { Client } from "discord.js-selfbot-v13";
import { search as ddgSearch } from "duck-duck-scrape";
import { mkdirSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createWebServer, addLog, setBotStatus, onRestart } from "./web.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Hook console để capture logs cho dashboard
const origLog = console.log.bind(console);
const origError = console.error.bind(console);
console.log = (...args) => { origLog(...args); addLog("info", args.join(" ")); };
console.error = (...args) => { origError(...args); addLog("error", args.join(" ")); };

const config = {
  discordToken: process.env.DISCORD_USER_TOKEN,
  aiBaseUrl: (process.env.AI_BASE_URL || "https://ai.khanhwiee.site/v1").replace(/\/+$/, ""),
  aiApiKey: process.env.AI_API_KEY,
  aiModel: process.env.AI_MODEL || "cx/gpt-5.5",
  botPrefix: process.env.BOT_PREFIX || "!",
  searchPrefix: process.env.SEARCH_PREFIX || "!search",
  maxSearchResults: Number(process.env.MAX_SEARCH_RESULTS || 5),
  chatLogsDir: process.env.CHAT_LOGS_DIR || join(__dirname, "..", "chat_logs"),
  enableChatLogs: parseBoolean(process.env.ENABLE_CHAT_LOGS, true),
  enableHistory: parseBoolean(process.env.ENABLE_HISTORY, true),
  replyToBotReplies: parseBoolean(process.env.REPLY_TO_BOT_REPLIES, true),
  maxHistoryMessages: Number(process.env.MAX_HISTORY_MESSAGES || 12),
  temperature: Number(process.env.AI_TEMPERATURE || 0.7),
  maxTokens: Number(process.env.AI_MAX_TOKENS || 1200),
  systemPrompt:
    process.env.SYSTEM_PROMPT ||
    "Ban la mot bot Discord huu ich. Tra loi tu nhien bang tieng Viet, ngan gon va dung trong tam neu nguoi dung khong yeu cau chi tiet.",
};

const missingVars = [];
for (const [name, value] of Object.entries({
  DISCORD_USER_TOKEN: config.discordToken,
  AI_API_KEY: config.aiApiKey,
})) {
  if (!value) missingVars.push(name);
}

if (missingVars.length) {
  console.error(`Missing env vars: ${missingVars.join(", ")}. Configure via dashboard.`);
  setBotStatus({ running: false, error: `Missing: ${missingVars.join(", ")}` });
}

const client = new Client({
  checkUpdate: false,
});

const histories = new Map();
const activeConversations = new Set();

client.on("ready", () => {
  console.log(`Logged in as ${client.user.tag} (selfbot mode)`);
  setBotStatus({ running: true, username: client.user.tag, startedAt: Date.now(), error: null });
});

client.on("messageCreate", async (message) => {
  // Bỏ qua tin nhắn của chính mình
  if (message.author.id === client.user.id) return;

  const prompt = await getUserPrompt(message);
  if (prompt === null) return;

  const imageUrls = extractImageUrls(message);
  const hasImages = imageUrls.length > 0;

  const conversationKey = getConversationKey(message);

  if (prompt.trim().toLowerCase() === "reset") {
    histories.delete(conversationKey);
    await message.reply("Da xoa lich su chat cua cuoc tro chuyen nay.");
    return;
  }

  if (!prompt.trim() && !hasImages) {
    await message.reply(
      message.guild
        ? `Gui cau hoi bang mention, prefix \`${config.botPrefix}\`, hoac reply vao tin nhan cua bot.`
        : "Ban muon hoi gi?",
    );
    return;
  }

  if (activeConversations.has(conversationKey)) {
    await message.reply("Minh dang tra loi cau truoc cua ban, doi mot chut nhe.");
    return;
  }

  activeConversations.add(conversationKey);

  const typingTimer = startTyping(message);

  try {
    // Detect search command
    const searchQuery = extractSearchQuery(prompt.trim());
    let searchContext = "";
    if (searchQuery) {
      try {
        searchContext = await searchWeb(searchQuery);
        console.log(`[Search] Context length: ${searchContext.length} chars`);
      } catch (err) {
        console.error("[Search] Search failed:", err.message);
      }
    } else {
      console.log("[Search] No search query extracted");
    }

    const history = config.enableHistory ? histories.get(conversationKey) || [] : [];

    // Nếu có search results, inject vào prompt
    let finalPrompt = prompt.trim();
    if (searchContext) {
      finalPrompt = `Nguoi dung hoi: "${finalPrompt}"\n\nKet qua tim kiem tu web:\n${searchContext}\n\nHay tra loi dua tren ket qua tim kiem phia tren. Trich dan nguon neu can.`;
    }

    const userMessage = buildUserMessage(finalPrompt, imageUrls);
    const nextHistory = [...history, { role: "user", content: userMessage }];

    const answer = await askAI(nextHistory);
    const cleanedAnswer = answer || "Minh chua tao duoc cau tra loi.";

    if (config.enableHistory) {
      histories.set(
        conversationKey,
        [...nextHistory, { role: "assistant", content: cleanedAnswer }].slice(
          -config.maxHistoryMessages,
        ),
      );
    }

    // Lưu lịch sử chat
    if (config.enableChatLogs) {
      saveChatLog(message, prompt.trim(), cleanedAnswer, searchContext);
    }

    for (const chunk of splitDiscordMessage(cleanedAnswer)) {
      await message.reply(chunk);
    }
  } catch (error) {
    console.error("AI request failed:", error);
    await message.reply("Minh khong goi duoc AI luc nay. Kiem tra API key, base URL hoac thu lai sau.");
  } finally {
    clearInterval(typingTimer);
    activeConversations.delete(conversationKey);
  }
});

async function getUserPrompt(message) {
  const content = message.content || "";

  // DM → luôn trả lời
  if (!message.guild) {
    return content.trim();
  }

  // Trong server → trả lời mọi tin nhắn
  // Nếu có mention thì bỏ mention ra khỏi nội dung
  const mentionPattern = new RegExp(`<@!?${client.user.id}>`, "g");
  if (mentionPattern.test(content)) {
    return content.replace(mentionPattern, "").trim();
  }

  // Nếu có prefix thì bỏ prefix
  if (config.botPrefix && content.startsWith(config.botPrefix)) {
    return content.slice(config.botPrefix.length).trim();
  }

  // Trả lời mọi tin nhắn khác
  return content.trim();
}

function extractImageUrls(message) {
  const imageExtensions = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"];
  const urls = [];

  // Từ attachments (ảnh đính kèm)
  for (const attachment of message.attachments.values()) {
    const name = (attachment.name || "").toLowerCase();
    if (
      attachment.contentType?.startsWith("image/") ||
      imageExtensions.some((ext) => name.endsWith(ext))
    ) {
      urls.push(attachment.url);
    }
  }

  // Từ embeds (ảnh nhúng qua link)
  for (const embed of message.embeds || []) {
    if (embed.image?.url) urls.push(embed.image.url);
    if (embed.thumbnail?.url) urls.push(embed.thumbnail.url);
  }

  return urls;
}

function buildUserMessage(text, imageUrls) {
  if (!imageUrls.length) {
    return text || "Xin chao";
  }

  // Format OpenAI vision: content là array gồm text + image_url
  const content = [];

  content.push({
    type: "text",
    text: text || "Hay mo ta va phan tich hinh anh nay.",
  });

  for (const url of imageUrls) {
    content.push({
      type: "image_url",
      image_url: { url },
    });
  }

  return content;
}

function extractSearchQuery(text) {
  const lower = text.toLowerCase();

  // Prefix: !search <query>
  if (lower.startsWith(config.searchPrefix)) {
    return text.slice(config.searchPrefix.length).trim();
  }

  // Vietnamese keywords: bỏ prefix nếu có
  const searchPatterns = [
    /^t[iì]m\s+ki[eế]m\s+(.+)/i,
    /^t[iì]m\s+(.+)/i,
    /^search\s+(.+)/i,
    /^tra\s+c[uứ]u\s+(.+)/i,
    /^google\s+(.+)/i,
  ];

  for (const pattern of searchPatterns) {
    const match = text.match(pattern);
    if (match) return match[1].trim();
  }

  // Luôn search cho mọi câu hỏi (dùng toàn bộ text làm query)
  if (text.trim().length > 2) {
    return text.trim();
  }

  return null;
}

async function searchWeb(query) {
  console.log(`[Search] Searching: "${query}"`);

  try {
    const results = await ddgSearch(query, { safeSearch: 0 });

    if (!results?.results?.length) {
      console.log("[Search] No results from ddgSearch, trying fallback...");
      return await searchWebFallback(query);
    }

    const topResults = results.results.slice(0, config.maxSearchResults);
    const formatted = topResults
      .map((r, i) => `${i + 1}. ${r.title}\n   ${r.description || ""}\n   Link: ${r.url}`)
      .join("\n\n");

    console.log(`[Search] Got ${topResults.length} results`);
    return formatted;
  } catch (err) {
    console.error("[Search] ddgSearch failed:", err.message);
    return await searchWebFallback(query);
  }
}

async function searchWebFallback(query) {
  try {
    console.log("[Search] Using fallback HTML scrape...");
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
    });

    if (!response.ok) {
      console.log(`[Search] Fallback HTTP ${response.status}`);
      return "";
    }

    const html = await response.text();

    // Parse kết quả từ HTML
    const results = [];
    const regex = /<a[^>]+class="result__a"[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>(.*?)<\/a>/gi;
    let match;

    while ((match = regex.exec(html)) !== null && results.length < config.maxSearchResults) {
      const link = decodeURIComponent(match[1].replace(/.*uddg=/, "").replace(/&.*/, ""));
      const title = match[2].replace(/<[^>]+>/g, "").trim();
      const snippet = match[3].replace(/<[^>]+>/g, "").trim();
      if (title && link) {
        results.push({ title, snippet, link });
      }
    }

    if (!results.length) {
      console.log("[Search] Fallback: no results parsed");
      return "";
    }

    const formatted = results
      .map((r, i) => `${i + 1}. ${r.title}\n   ${r.snippet}\n   Link: ${r.link}`)
      .join("\n\n");

    console.log(`[Search] Fallback got ${results.length} results`);
    return formatted;
  } catch (err) {
    console.error("[Search] Fallback failed:", err.message);
    return "";
  }
}

async function isReplyToThisBot(message) {
  if (!message.reference?.messageId) {
    return false;
  }

  try {
    const referencedMessage = await message.fetchReference();
    return referencedMessage.author?.id === client.user.id;
  } catch {
    return false;
  }
}

function getConversationKey(message) {
  if (!message.guild) {
    return `dm:${message.author.id}`;
  }

  return `guild:${message.guild.id}:channel:${message.channel.id}:user:${message.author.id}`;
}

async function askAI(history) {
  const response = await fetch(`${config.aiBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.aiApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.aiModel,
      messages: [{ role: "system", content: config.systemPrompt }, ...history],
      temperature: config.temperature,
      max_tokens: config.maxTokens,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`AI API returned ${response.status}: ${body.slice(0, 500)}`);
  }

  const data = await response.json();
  return (
    data?.choices?.[0]?.message?.content?.trim() ||
    data?.choices?.[0]?.text?.trim() ||
    data?.output_text?.trim() ||
    ""
  );
}

function startTyping(message) {
  message.channel.sendTyping().catch(() => {});

  return setInterval(() => {
    message.channel.sendTyping().catch(() => {});
  }, 8_000);
}

function splitDiscordMessage(text, limit = 1900) {
  const chunks = [];
  let remaining = String(text || "").trim();

  while (remaining.length > limit) {
    let splitAt = remaining.lastIndexOf("\n", limit);

    if (splitAt < limit * 0.5) {
      splitAt = remaining.lastIndexOf(" ", limit);
    }

    if (splitAt < limit * 0.5) {
      splitAt = limit;
    }

    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks.length ? chunks : ["Minh chua tao duoc cau tra loi."];
}

function parseBoolean(value, fallback) {
  if (value === undefined) {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function saveChatLog(message, userPrompt, aiResponse, searchContext) {
  try {
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10); // YYYY-MM-DD

    // Tạo thư mục logs
    mkdirSync(config.chatLogsDir, { recursive: true });

    // File JSONL theo ngày (format OpenAI fine-tuning)
    const logFile = join(config.chatLogsDir, `chat_${dateStr}.jsonl`);

    const entry = {
      timestamp: now.toISOString(),
      guild: message.guild?.name || "DM",
      guildId: message.guild?.id || null,
      channel: message.channel?.name || "DM",
      channelId: message.channel?.id,
      user: message.author.tag,
      userId: message.author.id,
      messages: [
        { role: "system", content: config.systemPrompt },
        { role: "user", content: userPrompt },
        { role: "assistant", content: aiResponse },
      ],
      hasSearch: !!searchContext,
      hasImages: false,
    };

    appendFileSync(logFile, JSON.stringify(entry) + "\n", "utf-8");
  } catch (err) {
    console.error("[ChatLog] Save failed:", err.message);
  }
}

// Start web server
const PORT = process.env.PORT || 3000;
const web = createWebServer();
web.listen(PORT, () => {
  console.log(`Dashboard running at http://localhost:${PORT}`);
});

// Register restart handler — Render auto-restarts on process.exit(0)
onRestart(() => {
  console.log("Restart requested from dashboard. Shutting down...");
  try { client.destroy(); } catch {}
  setTimeout(() => process.exit(0), 300);
});

// Start bot (chỉ khi có đủ config)
if (!missingVars.length) {
  client.login(config.discordToken).catch((err) => {
    console.error("Bot login failed:", err.message);
    setBotStatus({ running: false, error: err.message });
  });
} else {
  console.log("Bot not started — configure via dashboard first.");
}
