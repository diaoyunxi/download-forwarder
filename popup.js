// Download Forwarder - Popup UI
const LOCAL_SERVER = "http://127.0.0.1:18735";

const toggleEl = document.getElementById("toggle");
const statusEl = document.getElementById("status");
const statusTextEl = document.getElementById("status-text");
const serverInfoEl = document.getElementById("server-info");
const programGrid = document.getElementById("program-grid");
const argumentsEl = document.getElementById("arguments");
const historyListEl = document.getElementById("history-list");
const clearHistoryBtn = document.getElementById("clear-history");
const downloadDirEl = document.getElementById("download-dir");
const serverDirLabel = document.getElementById("server-dir-label");
const availableProgramsEl = document.getElementById("available-programs");
const countLabel = document.getElementById("count-label");

let enabled = false;
let selectedProgram = "wget";
let availablePrograms = [];
let currentHistory = [];

function chromeGet(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, resolve);
  });
}

// --- Initial load ---
async function init() {
  const data = await chromeGet([
    "enabled",
    "program",
    "arguments",
    "serverConnected",
    "serverInfo",
    "recentDownloads",
    "downloadDir",
  ]);
  enabled = data.enabled || false;
  selectedProgram = data.program || "wget";
  argumentsEl.value = data.arguments || "";
  downloadDirEl.value = data.downloadDir || "";
  updateToggle();
  updateProgramUI();
  updateServerStatus(data.serverConnected, data.serverInfo);
  renderHistory(data.recentDownloads || []);

  // Try fetching server-side info
  try {
    const info = await fetchJSON(LOCAL_SERVER + "/ping");
    if (info && info.status === "ok") {
      availablePrograms = info.available_programs || [];
      updateProgramUI();
      updateServerStatus(true, {
        version: info.version || "1.0.0",
        platform: info.platform || "unknown",
        available_programs: availablePrograms,
      });
    }
  } catch (e) {
    // server might not be running, keep existing state
  }

  // Pull server-side history and dir if available
  try {
    const historyResp = await fetchJSON(LOCAL_SERVER + "/history");
    if (historyResp && historyResp.status === "ok") {
      const combined = mergeHistory(
        data.recentDownloads || [],
        historyResp.history || []
      );
      currentHistory = combined;
      renderHistory(combined);
    }
  } catch (e) {}

  try {
    const cfg = await fetchJSON(LOCAL_SERVER + "/config");
    if (cfg && cfg.status === "ok" && cfg.download_dir) {
      if (!downloadDirEl.value) downloadDirEl.value = cfg.download_dir;
      serverDirLabel.textContent = "当前: " + cfg.download_dir;
    }
  } catch (e) {}
}

function fetchJSON(url) {
  return fetch(url, { method: "GET", signal: AbortSignal.timeout(3000) }).then(
    (r) => r.json()
  );
}

function mergeHistory(ext, server) {
  const seen = new Set();
  const combined = [];
  for (const item of [...ext, ...server]) {
    const key = (item.timestamp || "") + "|" + (item.url || "");
    if (key && !seen.has(key)) {
      seen.add(key);
      combined.push(item);
    }
  }
  combined.sort((a, b) => {
    const ta = new Date(a.timestamp || 0).getTime();
    const tb = new Date(b.timestamp || 0).getTime();
    return tb - ta;
  });
  return combined.slice(0, 50);
}

// --- Toggle ---
function updateToggle() {
  toggleEl.classList.toggle("active", enabled);
}
toggleEl.addEventListener("click", () => {
  enabled = !enabled;
  updateToggle();
  chrome.storage.local.set({ enabled });
  updateProgramUI();
});

// --- Program selection ---
function updateProgramUI() {
  document.querySelectorAll(".program-btn").forEach((btn) => {
    btn.classList.toggle("selected", btn.dataset.program === selectedProgram);
    btn.classList.toggle("disabled", !enabled);
    // Mark programs not detected by server as "unavailable" hint
    if (
      availablePrograms.length > 0 &&
      !availablePrograms.includes(btn.dataset.program)
    ) {
      btn.classList.add("unavailable");
      btn.title = "本地服务器未检测到此程序";
    } else {
      btn.classList.remove("unavailable");
      btn.title = "";
    }
  });
}

programGrid.addEventListener("click", (e) => {
  const btn = e.target.closest(".program-btn");
  if (!btn || !enabled) return;
  selectedProgram = btn.dataset.program;
  updateProgramUI();
  chrome.storage.local.set({ program: selectedProgram });
});

argumentsEl.addEventListener("input", () => {
  chrome.storage.local.set({ arguments: argumentsEl.value });
});

downloadDirEl.addEventListener("change", async () => {
  const dir = downloadDirEl.value.trim();
  if (!dir) return;
  chrome.storage.local.set({ downloadDir: dir });
  try {
    await fetch(LOCAL_SERVER + "/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ download_dir: dir }),
      signal: AbortSignal.timeout(3000),
    });
    serverDirLabel.textContent = "已保存: " + dir;
  } catch (e) {
    serverDirLabel.textContent = "服务器未连接";
  }
});

// --- Status / info ---
function updateServerStatus(connected, info) {
  statusEl.classList.toggle("connected", !!connected);
  statusEl.classList.toggle("disconnected", !connected);
  statusTextEl.textContent = connected ? "已连接" : "未连接";

  let infoText = connected
    ? `本地服务器运行中 (v${(info && info.version) || "1.0.0"} / ${
        (info && info.platform) || "unknown"
      })`
    : "请先运行: python server/server.py";
  serverInfoEl.textContent = infoText;

  if (info && Array.isArray(info.available_programs) && info.available_programs.length > 0) {
    const chips = info.available_programs
      .map((p) => `<span class="available-chip">${p}</span>`)
      .join("");
    availableProgramsEl.innerHTML =
      '<div class="hint" style="margin-bottom:6px;">已检测到:</div>' + chips;
    availablePrograms = info.available_programs;
  } else {
    availableProgramsEl.innerHTML = "";
  }
}

// --- History rendering ---
function renderHistory(items) {
  currentHistory = items || [];
  if (!currentHistory.length) {
    historyListEl.innerHTML = '<div class="history-empty">暂无下载记录</div>';
    countLabel.textContent = "";
    return;
  }
  historyListEl.innerHTML = currentHistory
    .slice(0, 20)
    .map((item) => {
      const success = item.status === "success";
      const programName = (item.program || "?").toUpperCase();
      const displayUrl = item.url || "";
      const time = formatTime(item.timestamp);
      return `<div class="history-item">
        <div class="history-meta">
          <span class="history-program ${
            success ? "program-badge-success" : "program-badge-error"
          }">${programName}</span>
          <span class="history-time">${time}</span>
        </div>
        <a class="history-url" href="${displayUrl}" target="_blank" rel="noopener">${escapeHtml(
        truncate(item.filename || displayUrl, 60)
      )}</a>
      </div>`;
    })
    .join("");
  countLabel.textContent = `共 ${currentHistory.length} 条 (显示最近20条)`;
}

clearHistoryBtn.addEventListener("click", async () => {
  chrome.storage.local.set({ recentDownloads: [] });
  try {
    await fetch(LOCAL_SERVER + "/history/clear", {
      method: "POST",
      signal: AbortSignal.timeout(3000),
    });
  } catch (e) {}
  currentHistory = [];
  renderHistory([]);
});

// --- Realtime updates ---
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.serverConnected || changes.serverInfo) {
    chromeGet(["serverConnected", "serverInfo"]).then((data) => {
      updateServerStatus(data.serverConnected, data.serverInfo);
    });
  }
  if (changes.recentDownloads) {
    renderHistory(changes.recentDownloads.newValue || []);
  }
});

// --- Helpers ---
function truncate(str, n) {
  if (!str) return "";
  return str.length > n ? str.slice(0, n - 1) + "\u2026" : str;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatTime(timestamp) {
  if (!timestamp) return "";
  try {
    const d = new Date(timestamp);
    const now = new Date();
    const diff = Math.floor((now - d) / 1000);
    if (diff < 60) return "刚刚";
    if (diff < 3600) return Math.floor(diff / 60) + " 分钟前";
    if (diff < 86400) return Math.floor(diff / 3600) + " 小时前";
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `${y}-${m}-${day} ${hh}:${mm}`;
  } catch (e) {
    return timestamp;
  }
}

// Start
init();
