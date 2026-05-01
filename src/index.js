import "dotenv/config";
import { Client } from "discord.js-selfbot-v13";
import { search as ddgSearch } from "duck-duck-scrape";
import { mkdirSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createWebServer, addLog, setBotStatus, onRestart } from "./web.js";
import { createMemoryStore } from "./memory.js";
import mammoth from "mammoth";
import JSZip from "jszip";
import * as XLSX from "xlsx";
import { PDFParse } from "pdf-parse";

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
  maxSearchResults: readPositiveIntegerEnv("MAX_SEARCH_RESULTS", 5),
  enableWebPageRead: parseBoolean(process.env.ENABLE_WEB_PAGE_READ, true),
  maxWebPagesToRead: readPositiveIntegerEnv("MAX_WEB_PAGES_TO_READ", 3),
  maxWebPageBytes: readPositiveIntegerEnv("MAX_WEB_PAGE_BYTES", 900_000),
  maxWebPageChars: readPositiveIntegerEnv("MAX_WEB_PAGE_CHARS", 6000),
  maxSearchContextChars: readPositiveIntegerEnv("MAX_SEARCH_CONTEXT_CHARS", 18000),
  webPageTimeoutMs: readPositiveIntegerEnv("WEB_PAGE_TIMEOUT_MS", 10_000),
  chatLogsDir: process.env.CHAT_LOGS_DIR || join(__dirname, "..", "chat_logs"),
  memoryBackend: (process.env.MEMORY_BACKEND || "file").trim().toLowerCase(),
  memoryDir: process.env.MEMORY_DIR || join(__dirname, "..", "memory"),
  supabaseUrl: process.env.SUPABASE_URL || "",
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || "",
  supabaseMemoryTable: process.env.SUPABASE_MEMORY_TABLE || "bot_memory",
  supabaseDbUrl: process.env.SUPABASE_DB_URL || process.env.DATABASE_URL || "",
  postgresSsl: parseBoolean(process.env.POSTGRES_SSL, true),
  enableChatLogs: parseBoolean(process.env.ENABLE_CHAT_LOGS, true),
  enableHistory: parseBoolean(process.env.ENABLE_HISTORY, true),
  enableMemory: parseBoolean(process.env.ENABLE_MEMORY, true),
  memoryUpdateEvery: readPositiveIntegerEnv("MEMORY_UPDATE_EVERY", 4),
  memoryRecentExchanges: readPositiveIntegerEnv("MEMORY_RECENT_EXCHANGES", 8),
  maxMemoryChars: readPositiveIntegerEnv("MAX_MEMORY_CHARS", 1600),
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
const memoryStore = createMemoryStore({
  backend: config.memoryBackend,
  dir: config.memoryDir,
  enabled: config.enableMemory,
  supabaseUrl: config.supabaseUrl,
  supabaseServiceRoleKey: config.supabaseServiceRoleKey,
  supabaseTable: config.supabaseMemoryTable,
  postgresUrl: config.supabaseDbUrl,
  postgresTable: config.supabaseMemoryTable,
  postgresSsl: config.postgresSsl,
  updateEvery: config.memoryUpdateEvery,
  recentExchangeLimit: config.memoryRecentExchanges,
  maxMemoryChars: config.maxMemoryChars,
});

client.on("ready", () => {
  console.log(`Logged in as ${client.user.tag} (selfbot mode)`);
  setBotStatus({ running: true, username: client.user.tag, startedAt: Date.now(), error: null });
});

client.on("messageCreate", async (message) => {
  // Bỏ qua tin nhắn của chính mình
  if (message.author.id === client.user.id) return;

  const prompt = await getUserPrompt(message);
  if (prompt === null) return;

  let imageUrls = extractImageUrls(message);
  const hasImages = imageUrls.length > 0;
  const fileAttachments = extractFileAttachments(message);
  const hasFiles = fileAttachments.length > 0;

  const conversationKey = getConversationKey(message);

  if (prompt.trim().toLowerCase() === "reset") {
    histories.delete(conversationKey);
    await memoryStore.reset(conversationKey);
    await message.reply("Da xoa lich su chat va memory cua cuoc tro chuyen nay.");
    return;
  }

  if (!prompt.trim() && !hasImages && !hasFiles) {
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

    // Download và đọc nội dung file đính kèm
    let fileContext = "";
    let embeddedImageCount = 0;
    if (hasFiles) {
      const fileContents = await downloadFiles(fileAttachments, prompt.trim());
      const embeddedImageUrls = fileContents.flatMap((file) => file.images || []);
      embeddedImageCount = embeddedImageUrls.length;
      if (embeddedImageUrls.length > 0) {
        imageUrls = [...imageUrls, ...embeddedImageUrls];
        console.log(`[File] Added ${embeddedImageUrls.length} embedded image(s) from documents to vision input`);
      }
      if (fileContents.length > 0) {
        fileContext = fileContents
          .map((f) => `--- File: ${f.name} (${f.type}) ---\n${f.content}`)
          .join("\n\n");
        console.log(`[File] Read ${fileContents.length} file(s), total ${fileContext.length} chars`);
      }
    }

    // Nếu có search results, inject vào prompt
    let finalPrompt = prompt.trim();

    // Inject file content vào prompt
    if (fileContext) {
      const userQuestion = finalPrompt || "Hay phan tich va giai thich noi dung file nay.";
      const attachmentImageCount = fileAttachments.filter((file) => file.isImage).length;
      const totalImageCount = attachmentImageCount + embeddedImageCount;
      const attachmentLabel = totalImageCount
        ? `${fileAttachments.length} file dinh kem, trong do co ${totalImageCount} hinh anh (gom ca anh nam trong file)`
        : `${fileAttachments.length} file dinh kem`;
      finalPrompt = `Nguoi dung gui ${attachmentLabel} va hoi: "${userQuestion}"\n\nNoi dung file va thong tin dinh kem:\n${fileContext}\n\nHay phan tich, giai thich, hoac tra loi dua tren noi dung va thong tin dinh kem phia tren. Neu co hinh anh thi hay ket hop ca nhung gi ban nhin thay trong anh de tra loi.`;
    }

    if (searchContext) {
      finalPrompt = `${finalPrompt}\n\nKet qua tim kiem va noi dung trang web da mo:\n${searchContext}\n\nHay tra loi dua tren noi dung web phia tren, uu tien cac phan \"Noi dung lien quan\" cua tung nguon. Trich dan ten nguon/link neu can.`;
    }

    const memoryContext = await memoryStore.getPrompt(conversationKey);
    const userMessage = buildUserMessage(finalPrompt, imageUrls);
    const nextHistory = [...history, { role: "user", content: userMessage }];
    const requestHistory = memoryContext
      ? [{ role: "system", content: memoryContext }, ...nextHistory]
      : nextHistory;

    const answer = await askAI(requestHistory);
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

    void updateMemory(conversationKey, prompt.trim(), cleanedAnswer);
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

// ===== FILE ANALYSIS =====

// Các extension file text mà bot hỗ trợ đọc
const TEXT_FILE_EXTENSIONS = new Set([
  // Code
  ".js", ".ts", ".jsx", ".tsx", ".py", ".java", ".c", ".cpp", ".h", ".hpp",
  ".cs", ".go", ".rs", ".rb", ".php", ".swift", ".kt", ".scala", ".lua",
  ".r", ".m", ".sql", ".sh", ".bash", ".bat", ".ps1", ".cmd",
  // Web
  ".html", ".htm", ".css", ".scss", ".sass", ".less", ".vue", ".svelte",
  // Data
  ".json", ".xml", ".yaml", ".yml", ".csv", ".tsv", ".toml", ".ini", ".cfg",
  // Doc
  ".txt", ".md", ".markdown", ".rst", ".tex", ".log", ".env",
  // Config
  ".gitignore", ".dockerignore", ".editorconfig", ".eslintrc", ".prettierrc",
  ".dockerfile", ".makefile",
]);

// File binary cần thư viện đặc biệt để đọc
const BINARY_DOC_EXTENSIONS = new Set([
  ".docx", ".doc",   // Word
  ".xlsx", ".xls",   // Excel
  ".pdf",            // PDF
]);

const IMAGE_FILE_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".heic", ".heif",
]);

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB cho binary files
const VISION_IMAGE_MIME_BY_EXTENSION = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
]);
const MAX_EMBEDDED_IMAGES = readPositiveIntegerEnv("MAX_EMBEDDED_IMAGES", 24);
const MAX_EMBEDDED_IMAGE_BYTES = readPositiveIntegerEnv(
  "MAX_EMBEDDED_IMAGE_BYTES",
  4 * 1024 * 1024,
);
const MAX_EMBEDDED_IMAGE_TOTAL_BYTES = readPositiveIntegerEnv(
  "MAX_EMBEDDED_IMAGE_TOTAL_BYTES",
  10 * 1024 * 1024,
);
const MAX_PDF_PAGES_FOR_VISION = readPositiveIntegerEnv("MAX_PDF_PAGES_FOR_VISION", 4);
const PDF_SCREENSHOT_WIDTH = readPositiveIntegerEnv("PDF_SCREENSHOT_WIDTH", 1200);

function extractFileAttachments(message) {
  const files = [];

  for (const attachment of message.attachments.values()) {
    const name = (attachment.name || "").toLowerCase();
    const ext = name.includes(".") ? "." + name.split(".").pop() : "";

    const isImage =
      attachment.contentType?.startsWith("image/") ||
      IMAGE_FILE_EXTENSIONS.has(ext);

    // Check xem là file binary document (Word, Excel, PDF)
    const isBinaryDoc = BINARY_DOC_EXTENSIONS.has(ext) ||
      attachment.contentType?.includes("wordprocessingml") ||
      attachment.contentType?.includes("spreadsheetml") ||
      attachment.contentType?.includes("msword") ||
      attachment.contentType?.includes("ms-excel") ||
      attachment.contentType?.includes("pdf");

    // Check text content type hoặc extension hỗ trợ
    const isText =
      attachment.contentType?.startsWith("text/") ||
      attachment.contentType?.includes("json") ||
      attachment.contentType?.includes("xml") ||
      attachment.contentType?.includes("javascript") ||
      attachment.contentType?.includes("csv") ||
      attachment.contentType?.includes("yaml") ||
      TEXT_FILE_EXTENSIONS.has(ext) ||
      name === "dockerfile" ||
      name === "makefile";

    if (isImage || isBinaryDoc || isText) {
      files.push({
        name: attachment.name || "unknown",
        url: attachment.url,
        size: attachment.size || 0,
        contentType: attachment.contentType || (isImage ? "image/*" : "text/plain"),
        isBinary: !!isBinaryDoc,
        isImage: !!isImage,
        width: attachment.width || null,
        height: attachment.height || null,
        ext,
      });
    }
  }

  return files;
}

// === Parsers cho file binary ===

async function parseDocx(buffer) {
  try {
    const textResult = await mammoth.extractRawText({ buffer });
    const imageExtraction = await extractDocxMediaImages(buffer);
    const imageSummary = buildVisionImageSummary("File Word", imageExtraction);
    const text = appendSection(
      textResult.value || "[File Word khong co noi dung text]",
      imageSummary,
    );

    return {
      text,
      images: imageExtraction.images.map((image) => image.url),
    };
  } catch (err) {
    console.error("[File] DOCX parse error:", err.message);
    return {
      text: `[Loi doc file Word: ${err.message}]`,
      images: [],
    };
  }
}

async function extractDocxMediaImages(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const candidates = [];
  const skippedUnsupported = [];

  for (const [path, entry] of Object.entries(zip.files)) {
    if (entry.dir || !path.toLowerCase().startsWith("word/media/")) continue;

    const ext = getExtension(path);
    const mime = VISION_IMAGE_MIME_BY_EXTENSION.get(ext);
    if (!mime) {
      skippedUnsupported.push(path);
      continue;
    }

    const data = await entry.async("nodebuffer");
    candidates.push({
      name: path,
      mime,
      bytes: data.length,
      buffer: data,
    });
  }

  return selectVisionImages(candidates, skippedUnsupported);
}

function parseExcel(buffer) {
  try {
    const workbook = XLSX.read(buffer, { type: "buffer" });
    const sheets = [];

    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      const csv = XLSX.utils.sheet_to_csv(sheet);
      sheets.push(`=== Sheet: ${sheetName} ===\n${csv}`);
    }

    return sheets.join("\n\n") || "[File Excel khong co du lieu]";
  } catch (err) {
    console.error("[File] Excel parse error:", err.message);
    return `[Loi doc file Excel: ${err.message}]`;
  }
}

async function parsePdf(buffer, userPrompt = "") {
  let parser;

  try {
    parser = new PDFParse({ data: buffer });
    const textResult = await parser.getText();
    const pagesForVision = selectPdfPagesForVision(textResult, userPrompt);
    const screenshotResult = pagesForVision.length
      ? await parser.getScreenshot({
          partial: pagesForVision,
          desiredWidth: PDF_SCREENSHOT_WIDTH,
          imageBuffer: false,
          imageDataUrl: true,
        })
      : { pages: [] };
    const screenshotImages = selectVisionImages(
      (screenshotResult.pages || []).map((page) => ({
        name: `PDF page ${page.pageNumber}`,
        mime: "image/png",
        bytes: estimateDataUrlBytes(page.dataUrl),
        dataUrl: page.dataUrl,
      })),
    );

    let embeddedImages = emptyImageExtraction();
    try {
      const imageResult = await parser.getImage({
        partial: pagesForVision.length ? pagesForVision : undefined,
        imageBuffer: false,
        imageDataUrl: true,
        imageThreshold: 50,
      });
      embeddedImages = selectVisionImages(
        (imageResult.pages || []).flatMap((page) =>
          (page.images || []).map((image) => ({
            name: `PDF page ${page.pageNumber} image ${image.name}`,
            mime: "image/png",
            bytes: estimateDataUrlBytes(image.dataUrl),
            dataUrl: image.dataUrl,
          })),
        ),
      );
    } catch (imageErr) {
      console.error("[File] PDF embedded image extraction failed:", imageErr.message);
    }

    const images = dedupeImageUrls([
      ...screenshotImages.images.map((image) => image.url),
      ...embeddedImages.images.map((image) => image.url),
    ]);
    const renderedPages = (screenshotResult.pages || []).map((page) => page.pageNumber);
    const summary = appendSection(
      buildVisionImageSummary(
        renderedPages.length
          ? `File PDF screenshot trang ${renderedPages.join(", ")}`
          : "File PDF screenshot",
        screenshotImages,
      ),
      buildVisionImageSummary("File PDF anh nhung", embeddedImages),
    );

    const text = appendSection(
      textResult.text || "[File PDF khong co noi dung text]",
      summary,
    );

    return { text, images };
  } catch (err) {
    console.error("[File] PDF screenshot parse failed:", err.message);

    try {
      parser = parser || new PDFParse({ data: buffer });
      const textResult = await parser.getText();
      const imageResult = await parser.getImage({
        imageBuffer: false,
        imageDataUrl: true,
        imageThreshold: 50,
      });
      const imageExtraction = selectVisionImages(
        (imageResult.pages || []).flatMap((page) =>
          (page.images || []).map((image) => ({
            name: `PDF page ${page.pageNumber} image ${image.name}`,
            mime: "image/png",
            bytes: estimateDataUrlBytes(image.dataUrl),
            dataUrl: image.dataUrl,
          })),
        ),
      );
      const text = appendSection(
        textResult.text || "[File PDF khong co noi dung text]",
        buildVisionImageSummary("File PDF anh nhung", imageExtraction),
      );

      return {
        text,
        images: imageExtraction.images.map((image) => image.url),
      };
    } catch (fallbackErr) {
      console.error("[File] PDF parse error:", fallbackErr.message);
      return {
        text: `[Loi doc file PDF: ${fallbackErr.message}]`,
        images: [],
      };
    }
  } finally {
    if (parser) {
      await parser.destroy().catch(() => {});
    }
  }
}

function selectPdfPagesForVision(textResult, userPrompt) {
  const totalPages = textResult.total || textResult.pages?.length || 0;
  if (!totalPages) return [];

  const questionNumbers = extractQuestionNumbers(userPrompt);
  const selected = new Set();

  for (const questionNumber of questionNumbers) {
    const questionPattern = new RegExp(`\\bcau\\s*0*${questionNumber}\\b`, "i");
    const numberedPattern = new RegExp(`\\b0*${questionNumber}\\s*[\\).:-]`, "i");

    for (const page of textResult.pages || []) {
      const pageText = normalizeSearchText(page.text);
      if (questionPattern.test(pageText) || numberedPattern.test(pageText)) {
        selected.add(page.num);
        if (page.num + 1 <= totalPages) selected.add(page.num + 1);
      }
    }
  }

  if (!selected.size) {
    for (let page = 1; page <= Math.min(totalPages, MAX_PDF_PAGES_FOR_VISION); page += 1) {
      selected.add(page);
    }
  }

  return [...selected]
    .filter((page) => page >= 1 && page <= totalPages)
    .sort((a, b) => a - b)
    .slice(0, MAX_PDF_PAGES_FOR_VISION);
}

function extractQuestionNumbers(text) {
  const normalized = normalizeSearchText(text);
  const numbers = new Set();
  const patterns = [
    /\b(?:cau|question|bai)\s*(?:so\s*)?[:#.-]?\s*(\d{1,3})\b/g,
    /\bq\s*\.?\s*(\d{1,3})\b/g,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(normalized)) !== null) {
      const value = Number(match[1]);
      if (Number.isInteger(value) && value > 0) {
        numbers.add(value);
      }
    }
  }

  return [...numbers];
}

function normalizeSearchText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\u0111/g, "d")
    .replace(/\u0110/g, "d")
    .toLowerCase();
}

function selectVisionImages(candidates = [], skippedUnsupported = []) {
  const result = {
    images: [],
    skippedUnsupported: [...skippedUnsupported],
    skippedTooLarge: [],
    skippedBudget: [],
  };
  let totalBytes = 0;

  for (const candidate of candidates) {
    if (!candidate?.mime || (!candidate.dataUrl && !candidate.buffer)) {
      result.skippedUnsupported.push(candidate?.name || "unknown");
      continue;
    }

    const bytes = candidate.bytes || estimateDataUrlBytes(candidate.dataUrl);
    if (bytes > MAX_EMBEDDED_IMAGE_BYTES) {
      result.skippedTooLarge.push(candidate.name);
      continue;
    }

    if (
      result.images.length >= MAX_EMBEDDED_IMAGES ||
      totalBytes + bytes > MAX_EMBEDDED_IMAGE_TOTAL_BYTES
    ) {
      result.skippedBudget.push(candidate.name);
      continue;
    }

    const url =
      candidate.dataUrl ||
      `data:${candidate.mime};base64,${candidate.buffer.toString("base64")}`;
    result.images.push({ name: candidate.name, url, bytes });
    totalBytes += bytes;
  }

  return result;
}

function emptyImageExtraction() {
  return {
    images: [],
    skippedUnsupported: [],
    skippedTooLarge: [],
    skippedBudget: [],
  };
}

function buildVisionImageSummary(label, extraction) {
  const parts = [];
  if (extraction.images.length) {
    parts.push(
      `[${label}: da dua ${extraction.images.length} hinh anh vao vision input (${formatImageNames(extraction.images)}).]`,
    );
  }
  if (extraction.skippedUnsupported.length) {
    parts.push(
      `[${label}: bo qua ${extraction.skippedUnsupported.length} hinh anh do dinh dang khong ho tro vision (${formatImageNames(extraction.skippedUnsupported)}).]`,
    );
  }
  if (extraction.skippedTooLarge.length) {
    parts.push(
      `[${label}: bo qua ${extraction.skippedTooLarge.length} hinh anh vi vuot gioi han dung luong (${formatImageNames(extraction.skippedTooLarge)}).]`,
    );
  }
  if (extraction.skippedBudget.length) {
    parts.push(
      `[${label}: bo qua ${extraction.skippedBudget.length} hinh anh vi vuot gioi han tong request (${formatImageNames(extraction.skippedBudget)}).]`,
    );
  }

  return parts.join("\n");
}

function formatImageNames(imagesOrNames) {
  const names = imagesOrNames.map((item) => item.name || item).filter(Boolean);
  const shown = names.slice(0, 6).join(", ");
  return names.length > 6 ? `${shown}, ...` : shown;
}

function appendSection(base, extra) {
  if (!base) return extra || "";
  if (!extra) return base;
  return `${base}\n\n${extra}`;
}

function dedupeImageUrls(urls) {
  return [...new Set(urls.filter(Boolean))];
}

function estimateDataUrlBytes(dataUrl) {
  if (!dataUrl) return 0;
  const commaIndex = dataUrl.indexOf(",");
  const base64Length = commaIndex === -1 ? dataUrl.length : dataUrl.length - commaIndex - 1;
  return Math.ceil((base64Length * 3) / 4);
}

function getExtension(path) {
  const normalized = String(path || "").toLowerCase();
  const dotIndex = normalized.lastIndexOf(".");
  return dotIndex === -1 ? "" : normalized.slice(dotIndex);
}

async function downloadFiles(fileAttachments, userPrompt = "") {
  const results = [];

  for (const file of fileAttachments) {
    try {
      if (file.isImage) {
        const sizeInMb = (file.size / 1024 / 1024).toFixed(2);
        const dimensions = file.width && file.height ? `${file.width}x${file.height}` : "khong ro kich thuoc";
        const summary = `[Hinh anh dinh kem: ${file.name}, loai ${file.contentType}, dung luong ${sizeInMb}MB, kich thuoc ${dimensions}. Anh nay se duoc phan tich truc tiep tu vision input.]`;
        console.log(`[File] Registered image attachment ${file.name}: ${dimensions}, ${sizeInMb}MB`);
        results.push({
          name: file.name,
          type: file.contentType,
          content: summary,
        });
        continue;
      }

      // Check size limit
      if (file.size > MAX_FILE_SIZE) {
        results.push({
          name: file.name,
          type: file.contentType,
          content: `[File qua lon: ${(file.size / 1024 / 1024).toFixed(1)}MB, gioi han ${MAX_FILE_SIZE / 1024 / 1024}MB]`,
        });
        continue;
      }

      const response = await fetch(file.url);
      if (!response.ok) {
        console.error(`[File] Failed to download ${file.name}: HTTP ${response.status}`);
        results.push({
          name: file.name,
          type: file.contentType,
          content: `[Khong tai duoc file: HTTP ${response.status}]`,
        });
        continue;
      }

      let text;

      let embeddedImages = [];

      if (file.isBinary) {
        // Download as buffer cho file binary
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        console.log(`[File] Downloaded binary ${file.name}: ${buffer.length} bytes`);

        // Parse theo loại file
        if (file.ext === ".docx" || file.ext === ".doc") {
          const parsedDocx = await parseDocx(buffer);
          embeddedImages = parsedDocx.images || [];
          text = embeddedImages.length > 0
            ? `${parsedDocx.text}\n\n[File Word co ${embeddedImages.length} hinh anh nhung da duoc dua vao vision input de phan tich]`
            : parsedDocx.text;
        } else if (file.ext === ".xlsx" || file.ext === ".xls") {
          text = parseExcel(buffer);
        } else if (file.ext === ".pdf") {
          const parsedPdf = await parsePdf(buffer, userPrompt);
          embeddedImages = parsedPdf.images || [];
          text = embeddedImages.length > 0
            ? `${parsedPdf.text}\n\n[File PDF co ${embeddedImages.length} hinh anh nhung da duoc dua vao vision input de phan tich]`
            : parsedPdf.text;
        } else {
          text = `[Dinh dang file ${file.ext} chua duoc ho tro]`;
        }
      } else {
        // File text thường
        text = await response.text();
        // Giới hạn 100KB cho text files
        if (text.length > 100 * 1024) {
          text = text.slice(0, 100 * 1024) + "\n\n... [File text bi cat ngan do qua lon]";
        }
      }

      console.log(`[File] Parsed ${file.name}: ${text.length} chars`);

      results.push({
        name: file.name,
        type: file.contentType,
        content: text,
        images: embeddedImages,
      });
    } catch (err) {
      console.error(`[File] Error processing ${file.name}:`, err.message);
      results.push({
        name: file.name,
        type: file.contentType,
        content: `[Loi khi doc file: ${err.message}]`,
      });
    }
  }

  return results;
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

const SEARCH_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const WEB_PAGE_TEXT_TYPES = [
  "text/html",
  "application/xhtml+xml",
  "text/plain",
  "application/json",
  "application/ld+json",
];
const WEB_PAGE_SKIP_EXTENSIONS = new Set([
  ".7z", ".avi", ".bmp", ".doc", ".docx", ".exe", ".gif", ".gz", ".heic", ".heif",
  ".ico", ".jpeg", ".jpg", ".m4a", ".mov", ".mp3", ".mp4", ".mpeg", ".pdf", ".png",
  ".ppt", ".pptx", ".rar", ".svg", ".tar", ".webm", ".webp", ".xls", ".xlsx", ".zip",
]);
const WEB_SEARCH_STOP_WORDS = new Set([
  "anh", "ban", "cho", "co", "cua", "dang", "de", "di", "duoc", "gi", "hay",
  "hoi", "khong", "la", "lay", "minh", "nay", "neu", "noi", "search", "tim",
  "toi", "tra", "trang", "truc", "vao", "ve", "voi", "xem",
]);

async function searchWeb(query) {
  console.log(`[Search] Searching: "${query}"`);

  let searchResults = [];
  try {
    const results = await ddgSearch(query, { safeSearch: 0 });

    if (!results?.results?.length) {
      console.log("[Search] No results from ddgSearch, trying fallback...");
      searchResults = await searchWebFallbackResults(query);
    } else {
      searchResults = results.results.map((result) => ({
        title: result.title || "",
        description: result.description || "",
        url: normalizeWebUrl(result.url),
      }));
    }
  } catch (err) {
    console.error("[Search] ddgSearch failed:", err.message);
    searchResults = await searchWebFallbackResults(query);
  }

  const directUrlResults = extractHttpUrls(query).map((url) => ({
    title: "URL nguoi dung gui",
    description: "Trang duoc nhac truc tiep trong cau hoi.",
    url,
  }));
  const topResults = dedupeSearchResults([...directUrlResults, ...searchResults])
    .slice(0, config.maxSearchResults);

  if (!topResults.length) {
    console.log("[Search] No results available");
    return "";
  }

  const pageReads = config.enableWebPageRead
    ? await readSearchResultPages(topResults, query)
    : [];

  console.log(
    `[Search] Got ${topResults.length} result(s), read ${pageReads.length} page(s)`,
  );
  return limitText(formatSearchContext(topResults, pageReads), config.maxSearchContextChars);
}

async function searchWebFallbackResults(query) {
  try {
    console.log("[Search] Using fallback HTML scrape...");
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const response = await fetch(url, {
      headers: { "User-Agent": SEARCH_USER_AGENT },
    });

    if (!response.ok) {
      console.log(`[Search] Fallback HTTP ${response.status}`);
      return [];
    }

    const html = await response.text();

    // Parse kết quả từ HTML
    const results = [];
    const regex = /<a[^>]+class="result__a"[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>(.*?)<\/a>/gi;
    let match;

    while ((match = regex.exec(html)) !== null && results.length < config.maxSearchResults) {
      const link = normalizeWebUrl(match[1]);
      const title = stripHtml(match[2]);
      const snippet = stripHtml(match[3]);
      if (title && link) {
        results.push({ title, description: snippet, url: link });
      }
    }

    if (!results.length) {
      console.log("[Search] Fallback: no results parsed");
      return [];
    }

    console.log(`[Search] Fallback got ${results.length} results`);
    return results;
  } catch (err) {
    console.error("[Search] Fallback failed:", err.message);
    return [];
  }
}

async function readSearchResultPages(results, query) {
  const readableResults = results
    .filter((result) => isReadableWebUrl(result.url))
    .slice(0, config.maxWebPagesToRead);

  if (!readableResults.length) return [];

  const settled = await Promise.allSettled(
    readableResults.map((result, index) => readWebPage(result, query, index + 1)),
  );

  return settled
    .map((item) => (item.status === "fulfilled" ? item.value : null))
    .filter(Boolean);
}

async function readWebPage(result, query, sourceNumber) {
  const url = normalizeWebUrl(result.url);
  if (!url) return null;
  if (!isReadableWebUrl(url)) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.webPageTimeoutMs);

  try {
    const { response, finalUrl } = await fetchReadableWebPage(url, controller.signal);

    if (!response.ok) {
      console.log(`[Search] Page ${sourceNumber} HTTP ${response.status}: ${finalUrl}`);
      return null;
    }

    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    if (!isReadableContentType(contentType)) {
      console.log(`[Search] Page ${sourceNumber} skipped content-type ${contentType}: ${finalUrl}`);
      return null;
    }

    const raw = await readLimitedResponseText(response, config.maxWebPageBytes);
    const pageTitle = extractHtmlTitle(raw) || result.title || url;
    const text = contentType.includes("html") || /<\s*html[\s>]/i.test(raw)
      ? htmlToReadableText(raw)
      : cleanReadableText(raw);
    const excerpt = buildRelevantWebExcerpt(text, query, config.maxWebPageChars);

    if (!excerpt) return null;

    return {
      sourceNumber,
      title: pageTitle,
      url: finalUrl,
      excerpt,
    };
  } catch (err) {
    const reason = err.name === "AbortError" ? "timeout" : err.message;
    console.log(`[Search] Page ${sourceNumber} read failed (${reason}): ${url}`);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchReadableWebPage(url, signal) {
  let currentUrl = url;

  for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
    if (!isReadableWebUrl(currentUrl)) {
      throw new Error("blocked url");
    }

    const response = await fetch(currentUrl, {
      signal,
      redirect: "manual",
      headers: {
        "Accept": "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5",
        "User-Agent": SEARCH_USER_AGENT,
      },
    });

    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return { response, finalUrl: currentUrl };
    }

    const location = response.headers.get("location");
    if (!location) {
      return { response, finalUrl: currentUrl };
    }

    currentUrl = normalizeWebUrl(new URL(location, currentUrl).toString());
  }

  throw new Error("too many redirects");
}

function formatSearchContext(results, pageReads) {
  const searchLines = results
    .map((result, index) => {
      const description = result.description ? `\n   Tom tat: ${result.description}` : "";
      return `${index + 1}. ${result.title || result.url}${description}\n   Link: ${result.url}`;
    })
    .join("\n\n");

  const sections = [
    "Ket qua search:",
    searchLines,
  ];

  if (pageReads.length) {
    sections.push(
      "Noi dung cac trang da mo truc tiep:",
      pageReads
        .map((page) => [
          `[Nguon ${page.sourceNumber}] ${page.title}`,
          `URL: ${page.url}`,
          "Noi dung lien quan:",
          page.excerpt,
        ].join("\n"))
        .join("\n\n"),
    );
  } else if (config.enableWebPageRead) {
    sections.push("Khong doc duoc noi dung trang truc tiep; chi co title/snippet/link search.");
  }

  return sections.join("\n\n");
}

function extractHttpUrls(text) {
  const urls = [];
  const regex = /https?:\/\/[^\s<>"')\]]+/gi;
  let match;

  while ((match = regex.exec(String(text || ""))) !== null) {
    const url = normalizeWebUrl(match[0].replace(/[.,;:!?]+$/g, ""));
    if (url) urls.push(url);
  }

  return urls;
}

function dedupeSearchResults(results) {
  const seen = new Set();
  const unique = [];

  for (const result of results) {
    const url = normalizeWebUrl(result.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    unique.push({
      title: cleanReadableText(result.title || url).slice(0, 180),
      description: cleanReadableText(result.description || "").slice(0, 500),
      url,
    });
  }

  return unique;
}

function normalizeWebUrl(value) {
  let raw = decodeHtmlEntities(String(value || "").trim());
  if (!raw) return "";
  if (raw.startsWith("//")) raw = `https:${raw}`;

  try {
    const parsed = new URL(raw);
    const redirected = parsed.searchParams.get("uddg");
    const host = parsed.hostname.toLowerCase();
    if ((host === "duckduckgo.com" || host.endsWith(".duckduckgo.com")) && redirected) {
      return normalizeWebUrl(redirected);
    }

    if (!["http:", "https:"].includes(parsed.protocol)) return "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return "";
  }
}

function isReadableWebUrl(url) {
  try {
    const parsed = new URL(url);
    if (isBlockedWebHost(parsed.hostname)) return false;
    const pathname = parsed.pathname.toLowerCase();
    return ![...WEB_PAGE_SKIP_EXTENSIONS].some((ext) => pathname.endsWith(ext));
  } catch {
    return false;
  }
}

function isBlockedWebHost(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return true;
  if (
    host === "localhost" ||
    host === "0.0.0.0" ||
    host.endsWith(".local") ||
    host.endsWith(".localhost")
  ) {
    return true;
  }

  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const parts = ipv4.slice(1).map(Number);
    if (parts.some((part) => part < 0 || part > 255)) return true;
    const [a, b] = parts;
    return (
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }

  return host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80");
}

function isReadableContentType(contentType) {
  if (!contentType) return true;
  return WEB_PAGE_TEXT_TYPES.some((type) => contentType.includes(type));
}

async function readLimitedResponseText(response, maxBytes) {
  if (!response.body?.getReader) {
    return limitText(await response.text(), maxBytes);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = "";

  while (totalBytes < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;

    const remaining = maxBytes - totalBytes;
    const chunk = value.byteLength > remaining ? value.slice(0, remaining) : value;
    totalBytes += chunk.byteLength;
    const reachedLimit = totalBytes >= maxBytes;
    text += decoder.decode(chunk, { stream: !reachedLimit });

    if (reachedLimit) {
      await reader.cancel().catch(() => {});
      break;
    }
  }

  text += decoder.decode();
  return text;
}

function htmlToReadableText(html) {
  const withoutNoise = String(html || "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|canvas|iframe|form|select|template)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|main|header|footer|nav|aside|li|tr|td|th|h[1-6])>/gi, "\n")
    .replace(/<(p|div|section|article|main|header|footer|nav|aside|li|tr|td|th|h[1-6])[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");

  return cleanReadableText(decodeHtmlEntities(withoutNoise));
}

function extractHtmlTitle(html) {
  const match = String(html || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? cleanReadableText(decodeHtmlEntities(match[1])).slice(0, 180) : "";
}

function stripHtml(value) {
  return cleanReadableText(decodeHtmlEntities(String(value || "").replace(/<[^>]+>/g, " ")));
}

function cleanReadableText(value) {
  const lines = String(value || "")
    .replace(/\r/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const deduped = [];
  let previous = "";
  for (const line of lines) {
    if (line === previous) continue;
    deduped.push(line);
    previous = line;
  }

  return deduped.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function buildRelevantWebExcerpt(text, query, maxChars) {
  const cleaned = cleanReadableText(text);
  if (!cleaned || cleaned.length <= maxChars) return cleaned;

  const terms = extractSearchTerms(query);
  const normalizedText = normalizeSearchText(cleaned);
  const windows = [];
  const radius = Math.max(700, Math.floor(maxChars / 5));

  for (const term of terms.slice(0, 12)) {
    let index = normalizedText.indexOf(term);
    let hits = 0;

    while (index !== -1 && hits < 3 && windows.length < 14) {
      windows.push({
        start: Math.max(0, index - radius),
        end: Math.min(cleaned.length, index + term.length + radius),
      });
      hits += 1;
      index = normalizedText.indexOf(term, index + term.length);
    }
  }

  if (!windows.length) {
    return limitText(cleaned, maxChars);
  }

  const merged = mergeTextWindows(windows);
  let excerpt = "";

  for (const window of merged) {
    const chunk = cleaned.slice(window.start, window.end).trim();
    if (!chunk) continue;
    const next = excerpt ? `${excerpt}\n...\n${chunk}` : chunk;
    if (next.length > maxChars) break;
    excerpt = next;
  }

  return limitText(excerpt || cleaned, maxChars);
}

function extractSearchTerms(query) {
  return normalizeSearchText(query)
    .replace(/https?:\/\/\S+/g, " ")
    .split(/[^a-z0-9]+/i)
    .map((term) => term.trim())
    .filter((term) => term.length >= 3 && !WEB_SEARCH_STOP_WORDS.has(term));
}

function mergeTextWindows(windows) {
  const sorted = windows
    .filter((window) => window.end > window.start)
    .sort((a, b) => a.start - b.start);
  const merged = [];

  for (const window of sorted) {
    const last = merged[merged.length - 1];
    if (last && window.start <= last.end + 200) {
      last.end = Math.max(last.end, window.end);
    } else {
      merged.push({ ...window });
    }
  }

  return merged;
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&#(\d+);/g, (match, code) => decodeHtmlCodePoint(Number(code), match))
    .replace(/&#x([0-9a-f]+);/gi, (match, code) => decodeHtmlCodePoint(parseInt(code, 16), match))
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function decodeHtmlCodePoint(code, fallback) {
  try {
    return Number.isInteger(code) && code > 0 ? String.fromCodePoint(code) : fallback;
  } catch {
    return fallback;
  }
}

function limitText(text, maxChars) {
  const value = String(text || "");
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 20)).trim()}\n[da cat bot noi dung]`;
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

async function callAI(messages, options = {}) {
  const response = await fetch(`${config.aiBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.aiApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.aiModel,
      messages,
      temperature: options.temperature ?? config.temperature,
      max_tokens: options.maxTokens ?? config.maxTokens,
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

async function askAI(history) {
  return callAI([{ role: "system", content: config.systemPrompt }, ...history]);
}

async function updateMemory(conversationKey, userPrompt, assistantAnswer) {
  if (!config.enableMemory) return;

  try {
    await memoryStore.recordExchange(conversationKey, {
      user: userPrompt,
      assistant: assistantAnswer,
    });

    const updated = await memoryStore.summarizeIfNeeded(conversationKey, (messages) =>
      callAI(messages, {
        temperature: 0.2,
        maxTokens: Math.min(config.maxTokens, 500),
      }),
    );

    if (updated) {
      console.log("[Memory] Updated conversation memory");
    }
  } catch (err) {
    console.error("[Memory] Update failed:", err.message);
  }
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

function readPositiveIntegerEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
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
