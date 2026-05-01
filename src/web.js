import express from "express";
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const ENV_PATH = join(ROOT, ".env");

// In-memory state
let botStatus = { running: false, username: null, startedAt: null, error: null };
let logs = [];
const MAX_LOGS = 200;

export function addLog(level, msg) {
  logs.push({ time: new Date().toISOString(), level, msg });
  if (logs.length > MAX_LOGS) logs.shift();
}

export function setBotStatus(status) {
  botStatus = { ...botStatus, ...status };
}

export function getBotStatus() {
  return botStatus;
}

function loadEnv() {
  if (!existsSync(ENV_PATH)) return {};
  const lines = readFileSync(ENV_PATH, "utf-8").split("\n");
  const env = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    env[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1);
  }
  return env;
}

function saveEnv(data) {
  const lines = [
    `DISCORD_USER_TOKEN=${data.DISCORD_USER_TOKEN || ""}`,
    `AI_BASE_URL=${data.AI_BASE_URL || "https://ai.khanhwiee.site/v1"}`,
    `AI_API_KEY=${data.AI_API_KEY || ""}`,
    `AI_MODEL=${data.AI_MODEL || "cx/gpt-5.5"}`,
    "",
    `BOT_PREFIX=${data.BOT_PREFIX || "!"}`,
    `ENABLE_HISTORY=${data.ENABLE_HISTORY || "true"}`,
    `ENABLE_CHAT_LOGS=${data.ENABLE_CHAT_LOGS || "true"}`,
    `MAX_HISTORY_MESSAGES=${data.MAX_HISTORY_MESSAGES || "12"}`,
    `AI_TEMPERATURE=${data.AI_TEMPERATURE || "0.7"}`,
    `AI_MAX_TOKENS=${data.AI_MAX_TOKENS || "1200"}`,
    `SYSTEM_PROMPT=${data.SYSTEM_PROMPT || ""}`,
    "",
  ];
  writeFileSync(ENV_PATH, lines.join("\n"), "utf-8");
}

function getChatLogStats() {
  const logsDir = join(ROOT, "chat_logs");
  if (!existsSync(logsDir)) return { totalFiles: 0, totalEntries: 0, files: [] };
  const files = readdirSync(logsDir).filter(f => f.endsWith(".jsonl")).sort().reverse();
  let totalEntries = 0;
  const fileStats = files.slice(0, 10).map(f => {
    const content = readFileSync(join(logsDir, f), "utf-8");
    const count = content.trim().split("\n").filter(Boolean).length;
    totalEntries += count;
    return { name: f, entries: count };
  });
  return { totalFiles: files.length, totalEntries, files: fileStats };
}

export function createWebServer() {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // API routes
  app.get("/api/status", (_req, res) => {
    res.json({ ...botStatus, uptime: botStatus.startedAt ? Date.now() - botStatus.startedAt : 0 });
  });

  app.get("/api/logs", (_req, res) => {
    res.json(logs.slice(-100));
  });

  app.get("/api/config", (_req, res) => {
    const env = loadEnv();
    // Mask sensitive values
    res.json({
      DISCORD_USER_TOKEN: env.DISCORD_USER_TOKEN ? "***" + (env.DISCORD_USER_TOKEN || "").slice(-8) : "",
      AI_BASE_URL: env.AI_BASE_URL || "",
      AI_API_KEY: env.AI_API_KEY ? "***" + (env.AI_API_KEY || "").slice(-8) : "",
      AI_MODEL: env.AI_MODEL || "cx/gpt-5.5",
      BOT_PREFIX: env.BOT_PREFIX || "!",
      ENABLE_HISTORY: env.ENABLE_HISTORY || "true",
      ENABLE_CHAT_LOGS: env.ENABLE_CHAT_LOGS || "true",
      MAX_HISTORY_MESSAGES: env.MAX_HISTORY_MESSAGES || "12",
      AI_TEMPERATURE: env.AI_TEMPERATURE || "0.7",
      AI_MAX_TOKENS: env.AI_MAX_TOKENS || "1200",
      SYSTEM_PROMPT: env.SYSTEM_PROMPT || "",
    });
  });

  app.post("/api/config", (req, res) => {
    const current = loadEnv();
    const body = req.body;
    // Only update non-empty fields, preserve masked values
    const updated = { ...current };
    for (const key of Object.keys(body)) {
      if (body[key] && !body[key].startsWith("***")) {
        updated[key] = body[key];
      }
    }
    saveEnv(updated);
    res.json({ ok: true, message: "Config saved. Restart bot to apply changes." });
  });

  app.get("/api/chat-logs", (_req, res) => {
    res.json(getChatLogStats());
  });

  // Dashboard HTML
  app.get("/", (_req, res) => {
    res.type("html").send(getDashboardHTML());
  });

  return app;
}

function getDashboardHTML() {
  return `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Discord AI Bot Dashboard</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{
  --bg:#0a0a0f;--bg2:#12121a;--bg3:#1a1a2e;--bg4:#252540;
  --text:#e4e4f0;--text2:#9898b0;--text3:#6868a0;
  --accent:#6c5ce7;--accent2:#a29bfe;--accent-glow:rgba(108,92,231,0.3);
  --green:#00d68f;--red:#ff6b6b;--yellow:#ffd93d;--blue:#4fc3f7;
  --border:rgba(255,255,255,0.06);
  --radius:12px;
}
body{font-family:'Inter',sans-serif;background:var(--bg);color:var(--text);min-height:100vh;overflow-x:hidden}
.container{max-width:960px;margin:0 auto;padding:20px}

/* Header */
.header{text-align:center;padding:40px 0 30px;position:relative}
.header::before{content:'';position:absolute;top:0;left:50%;transform:translateX(-50%);width:300px;height:300px;background:radial-gradient(circle,var(--accent-glow) 0%,transparent 70%);pointer-events:none;z-index:0}
.header h1{font-size:28px;font-weight:700;background:linear-gradient(135deg,var(--accent2),var(--blue));-webkit-background-clip:text;-webkit-text-fill-color:transparent;position:relative;z-index:1}
.header p{color:var(--text2);margin-top:8px;font-size:14px;position:relative;z-index:1}

/* Status Card */
.status-bar{display:flex;gap:12px;margin-bottom:24px;flex-wrap:wrap}
.status-card{flex:1;min-width:140px;background:var(--bg2);border:1px solid var(--border);border-radius:var(--radius);padding:16px 20px;position:relative;overflow:hidden}
.status-card::after{content:'';position:absolute;top:0;left:0;right:0;height:2px}
.status-card.online::after{background:var(--green)}.status-card.offline::after{background:var(--red)}
.status-card.info::after{background:var(--blue)}.status-card.warn::after{background:var(--yellow)}
.status-label{font-size:11px;text-transform:uppercase;letter-spacing:1px;color:var(--text3);margin-bottom:6px}
.status-value{font-size:20px;font-weight:600}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;animation:pulse 2s infinite}
.dot.on{background:var(--green)}.dot.off{background:var(--red)}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.4}}

/* Tabs */
.tabs{display:flex;gap:4px;margin-bottom:20px;background:var(--bg2);border-radius:var(--radius);padding:4px;border:1px solid var(--border)}
.tab{flex:1;padding:10px 16px;text-align:center;border-radius:8px;cursor:pointer;font-size:13px;font-weight:500;color:var(--text2);transition:all .2s}
.tab:hover{color:var(--text)}.tab.active{background:var(--accent);color:#fff}

/* Panels */
.panel{display:none;animation:fadeIn .3s}.panel.active{display:block}
@keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}

/* Form */
.card{background:var(--bg2);border:1px solid var(--border);border-radius:var(--radius);padding:24px;margin-bottom:16px}
.card-title{font-size:15px;font-weight:600;margin-bottom:16px;display:flex;align-items:center;gap:8px}
.card-title span{font-size:18px}
.form-group{margin-bottom:16px}
.form-group label{display:block;font-size:12px;font-weight:500;color:var(--text2);margin-bottom:6px;text-transform:uppercase;letter-spacing:.5px}
.form-group input,.form-group textarea,.form-group select{width:100%;padding:10px 14px;background:var(--bg3);border:1px solid var(--border);border-radius:8px;color:var(--text);font-family:inherit;font-size:13px;transition:border-color .2s}
.form-group input:focus,.form-group textarea:focus{outline:none;border-color:var(--accent)}
.form-group textarea{resize:vertical;min-height:80px}
.form-row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.btn{padding:10px 24px;border:none;border-radius:8px;font-family:inherit;font-size:13px;font-weight:600;cursor:pointer;transition:all .2s}
.btn-primary{background:linear-gradient(135deg,var(--accent),#8b7cf7);color:#fff}
.btn-primary:hover{transform:translateY(-1px);box-shadow:0 4px 20px var(--accent-glow)}
.btn-danger{background:var(--red);color:#fff}
.btn-danger:hover{opacity:.9}
.btn-group{display:flex;gap:8px;margin-top:8px}

/* Logs */
.log-container{background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:12px;max-height:400px;overflow-y:auto;font-family:'JetBrains Mono','Fira Code',monospace;font-size:12px;line-height:1.8}
.log-line{display:flex;gap:8px;padding:2px 0}
.log-time{color:var(--text3);white-space:nowrap;min-width:80px}
.log-msg{color:var(--text);word-break:break-all}
.log-msg.error{color:var(--red)}.log-msg.search{color:var(--blue)}

/* Chat logs stats */
.stat-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px}
.stat-item{background:var(--bg3);border-radius:8px;padding:12px 16px}
.stat-item .name{font-size:12px;color:var(--text2)}.stat-item .val{font-size:18px;font-weight:600;margin-top:4px}

/* Toast */
.toast{position:fixed;bottom:20px;right:20px;background:var(--green);color:#000;padding:12px 20px;border-radius:8px;font-size:13px;font-weight:500;transform:translateY(100px);opacity:0;transition:all .3s;z-index:999}
.toast.show{transform:translateY(0);opacity:1}
.toast.error{background:var(--red);color:#fff}

/* Responsive */
@media(max-width:600px){.form-row{grid-template-columns:1fr}.status-bar{flex-direction:column}}
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <h1>🤖 Discord AI Bot</h1>
    <p>Selfbot Dashboard — Control Panel</p>
  </div>

  <div class="status-bar">
    <div class="status-card" id="statusCard">
      <div class="status-label">Bot Status</div>
      <div class="status-value"><span class="dot off" id="statusDot"></span><span id="statusText">Loading...</span></div>
    </div>
    <div class="status-card info">
      <div class="status-label">Account</div>
      <div class="status-value" id="accountName">—</div>
    </div>
    <div class="status-card warn">
      <div class="status-label">Uptime</div>
      <div class="status-value" id="uptimeText">—</div>
    </div>
  </div>

  <div class="tabs">
    <div class="tab active" onclick="switchTab('config')">⚙️ Config</div>
    <div class="tab" onclick="switchTab('logs')">📜 Logs</div>
    <div class="tab" onclick="switchTab('data')">📊 Data</div>
  </div>

  <div class="panel active" id="panel-config">
    <div class="card">
      <div class="card-title"><span>🔑</span> Required Settings</div>
      <div class="form-group">
        <label>Discord User Token</label>
        <input type="password" id="cfg-DISCORD_USER_TOKEN" placeholder="MTQxMjUx...">
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>AI API Key</label>
          <input type="password" id="cfg-AI_API_KEY" placeholder="sk-...">
        </div>
        <div class="form-group">
          <label>AI Base URL</label>
          <input type="text" id="cfg-AI_BASE_URL" placeholder="https://api.openai.com/v1">
        </div>
      </div>
      <div class="form-group">
        <label>AI Model</label>
        <input type="text" id="cfg-AI_MODEL" placeholder="cx/gpt-5.5">
      </div>
    </div>

    <div class="card">
      <div class="card-title"><span>🎛️</span> Optional Settings</div>
      <div class="form-row">
        <div class="form-group">
          <label>Bot Prefix</label>
          <input type="text" id="cfg-BOT_PREFIX" placeholder="!">
        </div>
        <div class="form-group">
          <label>Max History Messages</label>
          <input type="number" id="cfg-MAX_HISTORY_MESSAGES" placeholder="12">
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>Temperature</label>
          <input type="number" id="cfg-AI_TEMPERATURE" step="0.1" min="0" max="2" placeholder="0.7">
        </div>
        <div class="form-group">
          <label>Max Tokens</label>
          <input type="number" id="cfg-AI_MAX_TOKENS" placeholder="1200">
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>Enable History</label>
          <select id="cfg-ENABLE_HISTORY"><option value="true">Yes</option><option value="false">No</option></select>
        </div>
        <div class="form-group">
          <label>Enable Chat Logs</label>
          <select id="cfg-ENABLE_CHAT_LOGS"><option value="true">Yes</option><option value="false">No</option></select>
        </div>
      </div>
      <div class="form-group">
        <label>System Prompt</label>
        <textarea id="cfg-SYSTEM_PROMPT" rows="3" placeholder="Bot personality..."></textarea>
      </div>
    </div>

    <div class="btn-group">
      <button class="btn btn-primary" onclick="saveConfig()">💾 Save & Restart Bot</button>
    </div>
  </div>

  <div class="panel" id="panel-logs">
    <div class="card">
      <div class="card-title"><span>📜</span> Realtime Logs</div>
      <div class="log-container" id="logContainer">
        <div class="log-line"><span class="log-msg">Loading logs...</span></div>
      </div>
    </div>
  </div>

  <div class="panel" id="panel-data">
    <div class="card">
      <div class="card-title"><span>📊</span> Chat Log Statistics</div>
      <div class="stat-grid" id="chatStats">Loading...</div>
    </div>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
function switchTab(name) {
  document.querySelectorAll('.tab').forEach((t,i) => {
    const panels = ['config','logs','data'];
    t.classList.toggle('active', panels[i] === name);
  });
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.getElementById('panel-' + name).classList.add('active');
  if (name === 'logs') loadLogs();
  if (name === 'data') loadChatStats();
}

function toast(msg, isError) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast show' + (isError ? ' error' : '');
  setTimeout(() => el.className = 'toast', 3000);
}

async function loadStatus() {
  try {
    const r = await fetch('/api/status');
    const s = await r.json();
    const card = document.getElementById('statusCard');
    const dot = document.getElementById('statusDot');
    const text = document.getElementById('statusText');
    const account = document.getElementById('accountName');
    const uptime = document.getElementById('uptimeText');

    if (s.running) {
      card.className = 'status-card online';
      dot.className = 'dot on';
      text.textContent = 'Online';
      account.textContent = s.username || '—';
      const mins = Math.floor(s.uptime / 60000);
      const hrs = Math.floor(mins / 60);
      uptime.textContent = hrs > 0 ? hrs + 'h ' + (mins % 60) + 'm' : mins + 'm';
    } else {
      card.className = 'status-card offline';
      dot.className = 'dot off';
      text.textContent = s.error ? 'Error' : 'Offline';
      account.textContent = '—';
      uptime.textContent = '—';
    }
  } catch(e) { console.error(e); }
}

async function loadConfig() {
  try {
    const r = await fetch('/api/config');
    const c = await r.json();
    for (const [k,v] of Object.entries(c)) {
      const el = document.getElementById('cfg-' + k);
      if (el) { el.tagName === 'SELECT' ? el.value = v : el.value = v; }
    }
  } catch(e) { console.error(e); }
}

async function saveConfig() {
  const fields = ['DISCORD_USER_TOKEN','AI_API_KEY','AI_BASE_URL','AI_MODEL','BOT_PREFIX',
    'MAX_HISTORY_MESSAGES','AI_TEMPERATURE','AI_MAX_TOKENS','ENABLE_HISTORY','ENABLE_CHAT_LOGS','SYSTEM_PROMPT'];
  const data = {};
  for (const f of fields) {
    const el = document.getElementById('cfg-' + f);
    if (el && el.value) data[f] = el.value;
  }
  try {
    const r = await fetch('/api/config', {
      method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data)
    });
    const j = await r.json();
    toast(j.message || 'Saved!');
    setTimeout(loadConfig, 1000);
  } catch(e) { toast('Save failed: ' + e.message, true); }
}

async function loadLogs() {
  try {
    const r = await fetch('/api/logs');
    const logs = await r.json();
    const container = document.getElementById('logContainer');
    if (!logs.length) { container.innerHTML = '<div class="log-line"><span class="log-msg">No logs yet</span></div>'; return; }
    container.innerHTML = logs.map(l => {
      const time = new Date(l.time).toLocaleTimeString('vi-VN');
      const cls = l.level === 'error' ? 'error' : l.msg.includes('[Search]') ? 'search' : '';
      return '<div class="log-line"><span class="log-time">' + time + '</span><span class="log-msg ' + cls + '">' + escHtml(l.msg) + '</span></div>';
    }).join('');
    container.scrollTop = container.scrollHeight;
  } catch(e) { console.error(e); }
}

async function loadChatStats() {
  try {
    const r = await fetch('/api/chat-logs');
    const s = await r.json();
    const el = document.getElementById('chatStats');
    let html = '<div class="stat-item"><div class="name">Total Files</div><div class="val">' + s.totalFiles + '</div></div>';
    html += '<div class="stat-item"><div class="name">Total Conversations</div><div class="val">' + s.totalEntries + '</div></div>';
    if (s.files.length) {
      html += s.files.map(f => '<div class="stat-item"><div class="name">' + f.name + '</div><div class="val">' + f.entries + ' chats</div></div>').join('');
    }
    el.innerHTML = html;
  } catch(e) { console.error(e); }
}

function escHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

loadStatus();
loadConfig();
setInterval(loadStatus, 5000);
setInterval(() => { if (document.querySelector('#panel-logs.active')) loadLogs(); }, 3000);
</script>
</body>
</html>`;
}
