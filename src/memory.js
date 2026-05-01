import { createClient } from "@supabase/supabase-js";
import pg from "pg";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

const SCHEMA_VERSION = 1;
const { Pool } = pg;

export function createMemoryStore(options = {}) {
  const dir = options.dir;
  const enabled = !!options.enabled;
  const requestedBackend = String(options.backend || "file").trim().toLowerCase();
  const supabaseUrl = options.supabaseUrl || "";
  const supabaseServiceRoleKey = options.supabaseServiceRoleKey || "";
  const supabaseTable = options.supabaseTable || "bot_memory";
  const postgresUrl = options.postgresUrl || "";
  const postgresTable = options.postgresTable || supabaseTable || "bot_memory";
  const postgresSsl = options.postgresSsl !== false;
  const hasSupabaseConfig = !!(supabaseUrl && supabaseServiceRoleKey);
  const hasPostgresConfig = !!postgresUrl;
  const backend =
    requestedBackend === "supabase" && hasSupabaseConfig
      ? "supabase"
      : ["postgres", "pg", "database"].includes(requestedBackend) && hasPostgresConfig
        ? "postgres"
        : "file";
  const updateEvery = clampPositiveInteger(options.updateEvery, 4);
  const recentExchangeLimit = clampPositiveInteger(options.recentExchangeLimit, 8);
  const maxMemoryChars = clampPositiveInteger(options.maxMemoryChars, 1600);
  const maxExchangeChars = clampPositiveInteger(options.maxExchangeChars, 2500);
  const cache = new Map();
  const supabase =
    backend === "supabase"
      ? createClient(supabaseUrl, supabaseServiceRoleKey, {
          auth: {
            autoRefreshToken: false,
            persistSession: false,
          },
        })
      : null;
  const pool =
    backend === "postgres"
      ? new Pool({
          connectionString: postgresUrl,
          ssl: postgresSsl ? { rejectUnauthorized: false } : false,
          max: 3,
          idleTimeoutMillis: 30_000,
          connectionTimeoutMillis: 10_000,
        })
      : null;
  const postgresTableSql = formatQualifiedIdentifier(postgresTable);
  let postgresSchemaReady = false;

  if (enabled && requestedBackend === "supabase" && !hasSupabaseConfig) {
    console.error(
      "[Memory] MEMORY_BACKEND=supabase but SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing. Falling back to file memory.",
    );
  }

  if (
    enabled &&
    ["postgres", "pg", "database"].includes(requestedBackend) &&
    !hasPostgresConfig
  ) {
    console.error(
      "[Memory] MEMORY_BACKEND=postgres but SUPABASE_DB_URL or DATABASE_URL is missing. Falling back to file memory.",
    );
  }

  async function getPrompt(conversationKey) {
    if (!enabled) return "";
    const doc = await load(conversationKey);
    if (!doc.memory) return "";

    return [
      "Ghi nho dai han ve nguoi dung/cuoc tro chuyen nay:",
      doc.memory,
      "",
      "Dung ghi nho nay nhu ngu canh mem. Neu tin nhan hien tai mau thuan voi ghi nho, uu tien tin nhan hien tai.",
    ].join("\n");
  }

  async function recordExchange(conversationKey, exchange) {
    if (!enabled) return;
    const doc = await load(conversationKey);
    doc.recent.push({
      at: new Date().toISOString(),
      user: cleanText(exchange.user, maxExchangeChars),
      assistant: cleanText(exchange.assistant, maxExchangeChars),
    });
    doc.recent = doc.recent.slice(-recentExchangeLimit);
    doc.pendingTurns = (doc.pendingTurns || 0) + 1;
    doc.updatedAt = new Date().toISOString();
    await save(doc);
  }

  async function summarizeIfNeeded(conversationKey, summarize) {
    if (!enabled) return false;
    const doc = await load(conversationKey);
    if ((doc.pendingTurns || 0) < updateEvery || !doc.recent.length) {
      return false;
    }

    const messages = buildSummaryMessages(doc);
    const updatedMemory = cleanMemory(await summarize(messages), maxMemoryChars);
    if (updatedMemory) {
      doc.memory = updatedMemory;
    }

    doc.pendingTurns = 0;
    doc.updatedAt = new Date().toISOString();
    await save(doc);
    return true;
  }

  async function reset(conversationKey) {
    cache.delete(conversationKey);
    if (!enabled) return;

    if (backend === "supabase") {
      try {
        const { error } = await supabase
          .from(supabaseTable)
          .delete()
          .eq("id", memoryIdForKey(conversationKey));
        if (error) {
          console.error("[Memory] Supabase reset failed:", error.message);
        }
      } catch (err) {
        console.error("[Memory] Supabase reset failed:", err.message);
      }
      return;
    }

    if (backend === "postgres") {
      try {
        await ensurePostgresSchema();
        await pool.query(`delete from ${postgresTableSql} where id = $1`, [
          memoryIdForKey(conversationKey),
        ]);
      } catch (err) {
        console.error("[Memory] Postgres reset failed:", err.message);
      }
      return;
    }

    const path = filePathForKey(conversationKey);
    if (existsSync(path)) {
      await unlink(path).catch(() => {});
    }
  }

  async function getStats() {
    if (enabled && backend === "supabase") {
      const { count, error: countError } = await supabase
        .from(supabaseTable)
        .select("id", { count: "exact", head: true });
      if (countError) {
        console.error("[Memory] Supabase stats count failed:", countError.message);
        return { enabled, backend, totalFiles: 0, remembered: 0, pendingTurns: 0 };
      }

      const { data, error } = await supabase
        .from(supabaseTable)
        .select("memory,pending_turns")
        .limit(10000);
      if (error) {
        console.error("[Memory] Supabase stats failed:", error.message);
        return { enabled, backend, totalFiles: count || 0, remembered: 0, pendingTurns: 0 };
      }

      return {
        enabled,
        backend,
        totalFiles: count ?? data.length,
        remembered: data.filter((row) => row.memory).length,
        pendingTurns: data.reduce((sum, row) => sum + Number(row.pending_turns || 0), 0),
      };
    }

    if (enabled && backend === "postgres") {
      try {
        await ensurePostgresSchema();
        const result = await pool.query(
          `select memory, pending_turns from ${postgresTableSql}`,
        );
        return {
          enabled,
          backend,
          totalFiles: result.rowCount,
          remembered: result.rows.filter((row) => row.memory).length,
          pendingTurns: result.rows.reduce(
            (sum, row) => sum + Number(row.pending_turns || 0),
            0,
          ),
        };
      } catch (err) {
        console.error("[Memory] Postgres stats failed:", err.message);
        return { enabled, backend, totalFiles: 0, remembered: 0, pendingTurns: 0 };
      }
    }

    if (!enabled || !existsSync(dir)) {
      return { enabled, backend, totalFiles: 0, remembered: 0, pendingTurns: 0 };
    }

    const files = (await readdir(dir)).filter((file) => file.endsWith(".json"));
    let remembered = 0;
    let pendingTurns = 0;

    for (const file of files) {
      try {
        const doc = JSON.parse(await readFile(join(dir, file), "utf-8"));
        if (doc.memory) remembered += 1;
        pendingTurns += Number(doc.pendingTurns || 0);
      } catch {
        // Ignore malformed memory files so one bad file does not break the app.
      }
    }

    return { enabled, backend, totalFiles: files.length, remembered, pendingTurns };
  }

  async function load(conversationKey) {
    if (cache.has(conversationKey)) {
      return cache.get(conversationKey);
    }

    if (backend === "supabase") {
      const { data, error } = await supabase
        .from(supabaseTable)
        .select("schema_version,memory,recent,pending_turns,created_at,updated_at")
        .eq("id", memoryIdForKey(conversationKey))
        .maybeSingle();

      if (error) {
        console.error("[Memory] Supabase load failed:", error.message);
      } else if (data) {
        const docFromRow = rowToDoc(data, conversationKey);
        cache.set(conversationKey, docFromRow);
        return docFromRow;
      }
    }

    if (backend === "postgres") {
      try {
        await ensurePostgresSchema();
        const result = await pool.query(
          `select schema_version, memory, recent, pending_turns, created_at, updated_at from ${postgresTableSql} where id = $1 limit 1`,
          [memoryIdForKey(conversationKey)],
        );

        if (result.rows[0]) {
          const docFromRow = rowToDoc(result.rows[0], conversationKey);
          cache.set(conversationKey, docFromRow);
          return docFromRow;
        }
      } catch (err) {
        console.error("[Memory] Postgres load failed:", err.message);
      }
    }

    const path = filePathForKey(conversationKey);
    let doc = null;
    if (backend === "file" && existsSync(path)) {
      try {
        doc = JSON.parse(await readFile(path, "utf-8"));
      } catch {
        doc = null;
      }
    }

    if (!doc || doc.schemaVersion !== SCHEMA_VERSION) {
      doc = createEmptyDoc(conversationKey);
    }

    cache.set(conversationKey, doc);
    return doc;
  }

  async function save(doc) {
    if (!enabled) return;

    if (backend === "supabase") {
      const { error } = await supabase
        .from(supabaseTable)
        .upsert(docToRow(doc), { onConflict: "id" });
      if (error) {
        throw new Error(`Supabase memory save failed: ${error.message}`);
      }
      return;
    }

    if (backend === "postgres") {
      await ensurePostgresSchema();
      const row = docToRow(doc);
      await pool.query(
        `
          insert into ${postgresTableSql}
            (id, schema_version, memory, recent, pending_turns, created_at, updated_at)
          values
            ($1, $2, $3, $4::jsonb, $5, $6, $7)
          on conflict (id) do update set
            schema_version = excluded.schema_version,
            memory = excluded.memory,
            recent = excluded.recent,
            pending_turns = excluded.pending_turns,
            updated_at = excluded.updated_at
        `,
        [
          row.id,
          row.schema_version,
          row.memory,
          JSON.stringify(row.recent),
          row.pending_turns,
          row.created_at,
          row.updated_at,
        ],
      );
      return;
    }

    await mkdir(dir, { recursive: true });
    await writeFile(filePathForKey(doc.conversationKey), JSON.stringify(doc, null, 2), "utf-8");
  }

  function filePathForKey(conversationKey) {
    return join(dir, `${memoryIdForKey(conversationKey)}.json`);
  }

  function buildSummaryMessages(doc) {
    const recent = doc.recent
      .map((turn, index) => [
        `Luot ${index + 1}:`,
        `User: ${turn.user || "(trong)"}`,
        `Assistant: ${turn.assistant || "(trong)"}`,
      ].join("\n"))
      .join("\n\n");

    return [
      {
        role: "system",
        content: [
          "Ban la module cap nhat memory cho bot Discord.",
          "Chi luu thong tin ben vung giup bot tra loi tu nhien va dung ngu canh hon.",
          "Nen luu: cach xung ho, so thich ve do dai/cach giai thich, linh vuc dang hoc, thong tin nguoi dung tu nguyen cung cap.",
          "Khong luu: token, API key, mat khau, du lieu nhay cam, noi dung tam thoi, dap an co the sai, thong tin rieng tu khong can thiet.",
          `Tra ve plain text tieng Viet, toi da ${maxMemoryChars} ky tu, uu tien gach dau dong ngan.`,
          "Neu khong co gi moi dang nho, tra lai memory hien tai sau khi rut gon neu can.",
        ].join("\n"),
      },
      {
        role: "user",
        content: [
          "Memory hien tai:",
          doc.memory || "(trong)",
          "",
          "Cac luot gan day can xem de cap nhat memory:",
          recent || "(khong co)",
          "",
          "Hay tra ve memory moi da duoc cap nhat.",
        ].join("\n"),
      },
    ];
  }

  async function ensurePostgresSchema() {
    if (postgresSchemaReady) return;

    await pool.query(`
      create table if not exists ${postgresTableSql} (
        id text primary key,
        schema_version integer not null default 1,
        memory text not null default '',
        recent jsonb not null default '[]'::jsonb,
        pending_turns integer not null default 0 check (pending_turns >= 0),
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )
    `);
    await pool.query(
      `create index if not exists ${indexNameForTable(postgresTable)} on ${postgresTableSql} (updated_at desc)`,
    );
    postgresSchemaReady = true;
  }

  return {
    backend,
    enabled,
    getPrompt,
    getStats,
    recordExchange,
    reset,
    summarizeIfNeeded,
  };
}

function memoryIdForKey(conversationKey) {
  return createHash("sha256").update(conversationKey).digest("hex");
}

function rowToDoc(row, conversationKey) {
  return {
    schemaVersion: row.schema_version || SCHEMA_VERSION,
    conversationKey,
    memory: row.memory || "",
    recent: Array.isArray(row.recent) ? row.recent : [],
    pendingTurns: Number(row.pending_turns || 0),
    createdAt: row.created_at || new Date().toISOString(),
    updatedAt: row.updated_at || new Date().toISOString(),
  };
}

function docToRow(doc) {
  return {
    id: memoryIdForKey(doc.conversationKey),
    schema_version: doc.schemaVersion || SCHEMA_VERSION,
    memory: doc.memory || "",
    recent: Array.isArray(doc.recent) ? doc.recent : [],
    pending_turns: Number(doc.pendingTurns || 0),
    created_at: doc.createdAt || new Date().toISOString(),
    updated_at: doc.updatedAt || new Date().toISOString(),
  };
}

function formatQualifiedIdentifier(value) {
  const parts = String(value || "bot_memory")
    .split(".")
    .map((part) => part.trim())
    .filter(Boolean);
  const safeParts = parts.length ? parts : ["bot_memory"];

  if (
    safeParts.length > 2 ||
    safeParts.some((part) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(part))
  ) {
    console.error("[Memory] Invalid Postgres table name. Falling back to public.bot_memory.");
    return `"public"."bot_memory"`;
  }

  return safeParts.map((part) => `"${part.replaceAll('"', '""')}"`).join(".");
}

function indexNameForTable(value) {
  const compact = String(value || "bot_memory")
    .replace(/[^A-Za-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 40);
  return `"${compact || "bot_memory"}_updated_at_idx"`;
}

function createEmptyDoc(conversationKey) {
  const now = new Date().toISOString();
  return {
    schemaVersion: SCHEMA_VERSION,
    conversationKey,
    memory: "",
    recent: [],
    pendingTurns: 0,
    createdAt: now,
    updatedAt: now,
  };
}

function cleanMemory(value, maxChars) {
  return cleanText(value, maxChars)
    .replace(/^```(?:text|md|markdown)?/i, "")
    .replace(/```$/i, "")
    .trim();
}

function cleanText(value, maxChars) {
  const text = stringifyContent(value)
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();

  return redactSensitive(text).slice(0, maxChars);
}

function stringifyContent(value) {
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (part?.type === "text") return part.text || "";
        if (part?.type === "image_url") return "[image omitted]";
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  if (value === null || value === undefined) {
    return "";
  }

  return String(value);
}

function redactSensitive(text) {
  return text
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[redacted-api-key]")
    .replace(/\b(?:mfa\.)?[A-Za-z0-9_-]{24}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{20,}\b/g, "[redacted-token]")
    .replace(/\bBearer\s+[A-Za-z0-9._-]{12,}\b/gi, "Bearer [redacted]")
    .replace(/(api[_-]?key|token|password|secret)\s*[:=]\s*\S+/gi, "$1=[redacted]");
}

function clampPositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}
