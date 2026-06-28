// Download Forwarder - Popup UI
const LOCAL_SERVER = "http://127.0.0.1:18735";
const EXT_VERSION = "1.6.0";

// --- Element refs ---
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
const exportJsonBtn = document.getElementById("export-json");
const exportCsvBtn = document.getElementById("export-csv");
const statTotalEl = document.getElementById("stat-total");
const statSuccessEl = document.getElementById("stat-success");
const statErrorEl = document.getElementById("stat-error");
const programStatsEl = document.getElementById("program-stats");
const filetypeToggle = document.getElementById("filetype-toggle");
const filetypeFilter = document.getElementById("filetype-filter");
const blacklistToggle = document.getElementById("blacklist-toggle");
const urlBlacklist = document.getElementById("url-blacklist");
const whitelistToggle = document.getElementById("whitelist-toggle");
const urlWhitelist = document.getElementById("url-whitelist");
const concurrentLimit = document.getElementById("concurrent-limit");
const speedLimit = document.getElementById("speed-limit");
const themeBtn = document.getElementById("theme-btn");
const manualUrlEl = document.getElementById("manual-url");
const manualForwardBtn = document.getElementById("manual-forward-btn");
const historySearchEl = document.getElementById("history-search");
const refreshLogsBtn = document.getElementById("refresh-logs");
const logsBox = document.getElementById("logs-box");
const backupBtn = document.getElementById("backup-btn");
const restoreBtn = document.getElementById("restore-btn");
const resetBtn = document.getElementById("reset-btn");
const restoreModal = document.getElementById("restore-modal");
const restoreTextarea = document.getElementById("restore-textarea");
const restoreCancel = document.getElementById("restore-cancel");
const restoreApply = document.getElementById("restore-apply");
const aboutServerEl = document.getElementById("about-server");
const aboutPlatformEl = document.getElementById("about-platform");
const aboutProgramsEl = document.getElementById("about-programs");

// v1.6.0 — Network / URL rules / notification prefs
const cookieToggle = document.getElementById("cookie-toggle");
const customRefererEl = document.getElementById("custom-referer");
const customUserAgentEl = document.getElementById("custom-useragent");
const proxyUrlEl = document.getElementById("proxy-url");
const notifySilentToggle = document.getElementById("notify-silent-toggle");
const notifyOnlyErrorsToggle = document.getElementById("notify-only-errors-toggle");
const urlRulesListEl = document.getElementById("url-rules-list");
const urlRulePatternEl = document.getElementById("url-rule-pattern");
const urlRuleProgramEl = document.getElementById("url-rule-program");
const urlRuleAddBtn = document.getElementById("url-rule-add");

// --- State ---
let enabled = false;
let selectedProgram = "wget";
let availablePrograms = [];
let currentHistory = [];
let filetypeFilterEnabled = false;
let blacklistEnabled = false;
let whitelistEnabled = false;
let darkMode = false;
let historySearchQuery = "";
// v1.6.0 state
let forwardCookies = false;
let customReferer = "";
let customUserAgent = "";
let proxyUrl = "";
let notifySilentAll = false;
let notifyOnlyErrors = false;
let urlRules = []; // [{ pattern: "...", program: "wget" }, ...]

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
    "filetypeFilterEnabled",
    "filetypeFilter",
    "blacklistEnabled",
    "urlBlacklist",
    "whitelistEnabled",
    "urlWhitelist",
    "concurrentLimit",
    "speedLimit",
    "darkMode",
    // v1.6.0
    "forwardCookies",
    "customReferer",
    "customUserAgent",
    "proxyUrl",
    "notifyPrefs",
    "urlRules",
  ]);
  enabled = data.enabled || false;
  selectedProgram = data.program || "wget";
  argumentsEl.value = data.arguments || "";
  downloadDirEl.value = data.downloadDir || "";
  filetypeFilterEnabled = data.filetypeFilterEnabled || false;
  filetypeFilter.value = data.filetypeFilter || "";
  blacklistEnabled = data.blacklistEnabled || false;
  urlBlacklist.value = data.urlBlacklist || "";
  whitelistEnabled = data.whitelistEnabled || false;
  urlWhitelist.value = data.urlWhitelist || "";
  concurrentLimit.value = data.concurrentLimit || 5;
  speedLimit.value = data.speedLimit || 0;
  darkMode = data.darkMode || false;
  // v1.6.0
  forwardCookies = data.forwardCookies || false;
  customReferer = data.customReferer || "";
  customUserAgent = data.customUserAgent || "";
  proxyUrl = data.proxyUrl || "";
  const np = data.notifyPrefs || {};
  notifySilentAll = !!np.silent_all;
  notifyOnlyErrors = !!np.only_errors;
  urlRules = Array.isArray(data.urlRules) ? data.urlRules : [];

  applyTheme();
  updateToggle();
  updateProgramUI();
  updateFiletypeToggle();
  updateBlacklistToggle();
  updateWhitelistToggle();
  updateCookieToggle();
  updateNotifyToggles();
  populateNetworkInputs();
  renderUrlRules();
  updateServerStatus(data.serverConnected, data.serverInfo);
  renderHistory(data.recentDownloads || []);
  updateAbout(data.serverInfo);

  // Tell background that popup opened, get live state
  try {
    const live = await chrome.runtime.sendMessage({ type: "popup-opened" });
    if (live && live.serverConnected) {
      updateServerStatus(true, live.serverInfo);
      updateAbout(live.serverInfo);
    }
  } catch (e) {
    /* background may be sleeping */
  }

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
      updateAbout({
        version: info.version,
        platform: info.platform,
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
    // v1.6.0: pull server-side url_rules when extension has none yet
    if (cfg && cfg.status === "ok" && Array.isArray(cfg.url_rules) && urlRules.length === 0 && cfg.url_rules.length > 0) {
      urlRules = cfg.url_rules.map((r) => ({
        pattern: r.pattern || "",
        program: r.program || "wget",
      }));
      chrome.storage.local.set({ urlRules });
      renderUrlRules();
    }
  } catch (e) {}

  // Load stats
  try {
    const stats = await fetchJSON(LOCAL_SERVER + "/stats");
    if (stats && stats.status === "ok") {
      renderStats(stats);
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

// --- Theme ---
function applyTheme() {
  document.body.classList.toggle("dark", darkMode);
  themeBtn.textContent = darkMode ? "\u2600\uFE0F" : "\u{1F313}";
}
themeBtn.addEventListener("click", () => {
  darkMode = !darkMode;
  chrome.storage.local.set({ darkMode });
  applyTheme();
});

// --- Tabs ---
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document
      .querySelectorAll(".tab-panel")
      .forEach((p) => p.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById("tab-" + tab.dataset.tab).classList.add("active");
  });
});

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

// Listen for toggle events from shortcut/menu
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "interception-toggled") {
    enabled = !!msg.enabled;
    updateToggle();
    updateProgramUI();
  }
});

// --- Program selection ---
function updateProgramUI() {
  document.querySelectorAll(".program-btn").forEach((btn) => {
    btn.classList.toggle("selected", btn.dataset.program === selectedProgram);
    btn.classList.toggle("disabled", !enabled);
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

// --- File type filter toggle ---
function updateFiletypeToggle() {
  filetypeToggle.classList.toggle("active", filetypeFilterEnabled);
  filetypeFilter.disabled = !filetypeFilterEnabled;
}
filetypeToggle.addEventListener("click", () => {
  filetypeFilterEnabled = !filetypeFilterEnabled;
  chrome.storage.local.set({ filetypeFilterEnabled });
  updateFiletypeToggle();
});
filetypeFilter.addEventListener("change", () => {
  const filter = filetypeFilter.value.trim();
  chrome.storage.local.set({ filetypeFilter: filter });
  syncSettingsToServer();
});

// --- URL blacklist toggle ---
function updateBlacklistToggle() {
  blacklistToggle.classList.toggle("active", blacklistEnabled);
  urlBlacklist.disabled = !blacklistEnabled;
}
blacklistToggle.addEventListener("click", () => {
  blacklistEnabled = !blacklistEnabled;
  chrome.storage.local.set({ blacklistEnabled });
  updateBlacklistToggle();
});
urlBlacklist.addEventListener("change", () => {
  const blacklist = urlBlacklist.value.trim();
  chrome.storage.local.set({ urlBlacklist: blacklist });
  syncSettingsToServer();
});

// --- URL whitelist toggle ---
function updateWhitelistToggle() {
  whitelistToggle.classList.toggle("active", whitelistEnabled);
  urlWhitelist.disabled = !whitelistEnabled;
}
whitelistToggle.addEventListener("click", () => {
  whitelistEnabled = !whitelistEnabled;
  chrome.storage.local.set({ whitelistEnabled });
  updateWhitelistToggle();
});
urlWhitelist.addEventListener("change", () => {
  const whitelist = urlWhitelist.value.trim();
  chrome.storage.local.set({ urlWhitelist: whitelist });
  syncSettingsToServer();
});

// --- Concurrent & speed limit ---
concurrentLimit.addEventListener("change", () => {
  const limit = parseInt(concurrentLimit.value) || 5;
  chrome.storage.local.set({ concurrentLimit: limit });
  syncSettingsToServer();
});
speedLimit.addEventListener("change", () => {
  const limit = parseInt(speedLimit.value) || 0;
  chrome.storage.local.set({ speedLimit: limit });
  syncSettingsToServer();
});

async function syncSettingsToServer() {
  try {
    await fetch(LOCAL_SERVER + "/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filetype_filter_enabled: filetypeFilterEnabled,
        filetype_filter: filetypeFilter.value.trim(),
        blacklist_enabled: blacklistEnabled,
        url_blacklist: urlBlacklist.value.trim(),
        whitelist_enabled: whitelistEnabled,
        url_whitelist: urlWhitelist.value.trim(),
        concurrent_limit: parseInt(concurrentLimit.value) || 5,
        speed_limit: parseInt(speedLimit.value) || 0,
        // v1.6.0
        url_rules: urlRules,
        custom_referer: customRefererEl.value.trim(),
        custom_user_agent: customUserAgentEl.value.trim(),
        proxy_url: proxyUrlEl.value.trim(),
        forward_cookies: forwardCookies,
      }),
      signal: AbortSignal.timeout(3000),
    });
  } catch (e) {
    console.warn("Failed to sync settings to server", e);
  }
}

// --- Cookie forwarding toggle (v1.6.0) ---
function updateCookieToggle() {
  cookieToggle.classList.toggle("active", forwardCookies);
}
cookieToggle.addEventListener("click", () => {
  forwardCookies = !forwardCookies;
  chrome.storage.local.set({ forwardCookies });
  updateCookieToggle();
  syncSettingsToServer();
});

// --- Notification preferences (v1.6.0) ---
function updateNotifyToggles() {
  notifySilentToggle.classList.toggle("active", notifySilentAll);
  notifyOnlyErrorsToggle.classList.toggle("active", notifyOnlyErrors);
}

function saveNotifyPrefs() {
  chrome.storage.local.set({
    notifyPrefs: {
      silent_all: notifySilentAll,
      only_errors: notifyOnlyErrors,
    },
  });
}

notifySilentToggle.addEventListener("click", () => {
  notifySilentAll = !notifySilentAll;
  saveNotifyPrefs();
  updateNotifyToggles();
});

notifyOnlyErrorsToggle.addEventListener("click", () => {
  notifyOnlyErrors = !notifyOnlyErrors;
  saveNotifyPrefs();
  updateNotifyToggles();
});

// --- Custom headers & proxy (v1.6.0) ---
function populateNetworkInputs() {
  customRefererEl.value = customReferer;
  customUserAgentEl.value = customUserAgent;
  proxyUrlEl.value = proxyUrl;
}

customRefererEl.addEventListener("change", () => {
  customReferer = customRefererEl.value.trim();
  chrome.storage.local.set({ customReferer });
  syncSettingsToServer();
});
customUserAgentEl.addEventListener("change", () => {
  customUserAgent = customUserAgentEl.value.trim();
  chrome.storage.local.set({ customUserAgent });
  syncSettingsToServer();
});
proxyUrlEl.addEventListener("change", () => {
  proxyUrl = proxyUrlEl.value.trim();
  chrome.storage.local.set({ proxyUrl });
  syncSettingsToServer();
});

// --- URL rules management (v1.6.0) ---
function renderUrlRules() {
  if (!urlRules || urlRules.length === 0) {
    urlRulesListEl.innerHTML =
      '<div class="url-rules-empty">暂无 URL 规则</div>';
    return;
  }
  urlRulesListEl.innerHTML = urlRules
    .map((rule, idx) => {
      return `<div class="url-rule-item">
        <span class="url-rule-pattern">${escapeHtml(rule.pattern || "")}</span>
        <span class="url-rule-program">${escapeHtml(
          (rule.program || "?").toUpperCase()
        )}</span>
        <button class="url-rule-delete" data-idx="${idx}" title="删除">&times;</button>
      </div>`;
    })
    .join("");
}

urlRuleAddBtn.addEventListener("click", () => {
  const pattern = urlRulePatternEl.value.trim();
  const program = urlRuleProgramEl.value;
  if (!pattern) {
    urlRulePatternEl.focus();
    return;
  }
  // Validate regex
  try {
    new RegExp(pattern, "i");
  } catch (e) {
    alert("正则表达式无效：" + e.message);
    return;
  }
  urlRules.push({ pattern: pattern, program: program });
  chrome.storage.local.set({ urlRules });
  urlRulePatternEl.value = "";
  renderUrlRules();
  syncSettingsToServer();
});

urlRulesListEl.addEventListener("click", (e) => {
  const btn = e.target.closest(".url-rule-delete");
  if (!btn) return;
  const idx = parseInt(btn.dataset.idx, 10);
  if (isNaN(idx)) return;
  urlRules.splice(idx, 1);
  chrome.storage.local.set({ urlRules });
  renderUrlRules();
  syncSettingsToServer();
});

// --- Manual forward ---
manualForwardBtn.addEventListener("click", async () => {
  const url = manualUrlEl.value.trim();
  if (!url) {
    manualUrlEl.focus();
    return;
  }
  manualForwardBtn.disabled = true;
  try {
    const resp = await chrome.runtime.sendMessage({
      type: "manual-forward",
      url: url,
      filename: "",
    });
    if (resp && resp.status === "success") {
      manualUrlEl.value = "";
    }
  } catch (e) {
    console.warn("manual forward failed", e);
  } finally {
    manualForwardBtn.disabled = false;
  }
});
manualUrlEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") manualForwardBtn.click();
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
      .map((p) => `<span class="available-chip">${escapeHtml(p)}</span>`)
      .join("");
    availableProgramsEl.innerHTML =
      '<div class="hint" style="margin-bottom:6px;">已检测到:</div>' + chips;
    availablePrograms = info.available_programs;
  } else {
    availableProgramsEl.innerHTML = "";
  }
}

function updateAbout(info) {
  // Extension version is always known locally
  const aboutVersionEl = document.getElementById("about-version");
  if (aboutVersionEl) aboutVersionEl.textContent = EXT_VERSION;
  if (info && info.version) {
    aboutServerEl.textContent = "v" + info.version;
    aboutPlatformEl.textContent = info.platform || "-";
    aboutProgramsEl.textContent =
      info.available_programs && info.available_programs.length
        ? info.available_programs.join(", ")
        : "-";
  }
}

// --- History rendering ---
function renderHistory(items) {
  currentHistory = items || [];
  applyHistoryFilter();
}

function applyHistoryFilter() {
  const q = historySearchQuery.trim().toLowerCase();
  const filtered = q
    ? currentHistory.filter((item) => {
        const u = (item.url || "").toLowerCase();
        const f = (item.filename || "").toLowerCase();
        return u.includes(q) || f.includes(q);
      })
    : currentHistory;

  if (!filtered.length) {
    historyListEl.innerHTML = '<div class="history-empty">暂无下载记录</div>';
    countLabel.textContent = currentHistory.length
      ? `共 ${currentHistory.length} 条 (无匹配)`
      : "";
    return;
  }
  historyListEl.innerHTML = filtered
    .slice(0, 20)
    .map((item) => {
      const success = item.status === "success";
      const programName = (item.program || "?").toUpperCase();
      const displayUrl = item.url || "";
      const time = formatTime(item.timestamp);
      const sourceLabel = item.source
        ? `<span class="history-source">${escapeHtml(item.source)}</span>`
        : "";
      return `<div class="history-item">
        <div class="history-meta">
          <span class="history-program ${
            success ? "program-badge-success" : "program-badge-error"
          }">${programName}</span>
          <span class="history-time">${time}${sourceLabel}</span>
        </div>
        <a class="history-url" href="${escapeHtml(displayUrl)}" target="_blank" rel="noopener">${escapeHtml(
        truncate(item.filename || displayUrl, 60)
      )}</a>
      </div>`;
    })
    .join("");
  countLabel.textContent = `共 ${currentHistory.length} 条 (显示 ${Math.min(
    20,
    filtered.length
  )} 条)`;
}

historySearchEl.addEventListener("input", () => {
  historySearchQuery = historySearchEl.value;
  applyHistoryFilter();
});

clearHistoryBtn.addEventListener("click", async () => {
  if (!confirm("确定清空所有下载历史吗？")) return;
  chrome.storage.local.set({ recentDownloads: [] });
  try {
    await fetch(LOCAL_SERVER + "/history/clear", {
      method: "POST",
      signal: AbortSignal.timeout(3000),
    });
  } catch (e) {}
  currentHistory = [];
  renderHistory([]);
  statTotalEl.textContent = "0";
  statSuccessEl.textContent = "0";
  statErrorEl.textContent = "0";
  programStatsEl.innerHTML = "";
});

// --- Export ---
function downloadFile(url, filename) {
  chrome.downloads.download({
    url: url,
    filename: filename,
    saveAs: true,
  });
}

exportJsonBtn.addEventListener("click", () => {
  downloadFile(LOCAL_SERVER + "/export?format=json", "download_history.json");
});

exportCsvBtn.addEventListener("click", () => {
  downloadFile(LOCAL_SERVER + "/export?format=csv", "download_history.csv");
});

// --- Realtime updates ---
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.serverConnected || changes.serverInfo) {
    chromeGet(["serverConnected", "serverInfo"]).then((data) => {
      updateServerStatus(data.serverConnected, data.serverInfo);
      updateAbout(data.serverInfo);
    });
  }
  if (changes.recentDownloads) {
    renderHistory(changes.recentDownloads.newValue || []);
  }
  if (changes.darkMode) {
    darkMode = !!changes.darkMode.newValue;
    applyTheme();
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
    if (isNaN(d.getTime())) return String(timestamp);
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

// --- Stats rendering ---
function renderStats(stats) {
  statTotalEl.textContent = stats.total || 0;
  statSuccessEl.textContent = stats.success || 0;
  statErrorEl.textContent = stats.error || 0;

  if (stats.by_program && Object.keys(stats.by_program).length > 0) {
    programStatsEl.innerHTML = Object.entries(stats.by_program)
      .map(([prog, data]) => {
        return `<div class="prog-stat-chip">
          <span class="prog-name">${escapeHtml(prog)}</span>
          <span class="prog-count">${data.success}/${data.total}</span>
        </div>`;
      })
      .join("");
  } else {
    programStatsEl.innerHTML = '<span class="hint">暂无数据</span>';
  }
}

// --- Server logs ---
refreshLogsBtn.addEventListener("click", async () => {
  logsBox.classList.add("empty");
  logsBox.textContent = "加载中…";
  try {
    const resp = await fetchJSON(LOCAL_SERVER + "/logs?limit=80");
    if (resp && resp.status === "ok") {
      const lines = resp.logs || [];
      if (!lines.length) {
        logsBox.textContent = "（暂无日志）";
        logsBox.classList.add("empty");
      } else {
        logsBox.classList.remove("empty");
        logsBox.textContent = lines.join("");
      }
      return;
    }
    logsBox.textContent = "（服务器返回异常）";
  } catch (e) {
    logsBox.textContent = "（无法连接服务器）";
  }
});

// --- Backup / Restore ---
backupBtn.addEventListener("click", async () => {
  // Pull extension storage + server config
  const ext = await chrome.storage.local.get(null);
  let serverCfg = null;
  try {
    serverCfg = await fetchJSON(LOCAL_SERVER + "/config");
  } catch (e) {
    /* server may be down */
  }
  const payload = {
    version: EXT_VERSION,
    exported_at: new Date().toISOString(),
    extension: ext,
    server: serverCfg && serverCfg.status === "ok" ? serverCfg : null,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const filename = `download-forwarder-backup-${new Date()
    .toISOString()
    .slice(0, 10)}.json`;
  chrome.downloads.download({ url, filename, saveAs: true });
});

restoreBtn.addEventListener("click", () => {
  restoreTextarea.value = "";
  restoreModal.classList.add("active");
});

restoreCancel.addEventListener("click", () => {
  restoreModal.classList.remove("active");
});

restoreApply.addEventListener("click", async () => {
  let data;
  try {
    data = JSON.parse(restoreTextarea.value);
  } catch (e) {
    alert("JSON 解析失败，请检查格式");
    return;
  }
  if (!data || typeof data !== "object") {
    alert("无效的备份内容");
    return;
  }

  // Restore extension settings
  if (data.extension && typeof data.extension === "object") {
    // Filter to known keys
    const allowed = [
      "enabled",
      "program",
      "arguments",
      "downloadDir",
      "filetypeFilterEnabled",
      "filetypeFilter",
      "blacklistEnabled",
      "urlBlacklist",
      "whitelistEnabled",
      "urlWhitelist",
      "concurrentLimit",
      "speedLimit",
      "darkMode",
      // v1.6.0
      "forwardCookies",
      "customReferer",
      "customUserAgent",
      "proxyUrl",
      "notifyPrefs",
      "urlRules",
    ];
    const toSet = {};
    for (const k of allowed) {
      if (k in data.extension) toSet[k] = data.extension[k];
    }
    await chrome.storage.local.set(toSet);
  }

  // Restore server config
  if (data.server && data.server.status === "ok") {
    const s = data.server;
    const body = {};
    const fields = [
      "download_dir",
      "program",
      "arguments",
      "filetype_filter_enabled",
      "filetype_filter",
      "blacklist_enabled",
      "url_blacklist",
      "whitelist_enabled",
      "url_whitelist",
      "concurrent_limit",
      "speed_limit",
      // v1.6.0
      "url_rules",
      "custom_referer",
      "custom_user_agent",
      "proxy_url",
      "forward_cookies",
    ];
    for (const f of fields) {
      if (f in s) body[f] = s[f];
    }
    try {
      await fetch(LOCAL_SERVER + "/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(3000),
      });
    } catch (e) {
      console.warn("server restore failed", e);
    }
  }

  restoreModal.classList.remove("active");
  alert("设置已应用，弹窗将重新加载");
  location.reload();
});

resetBtn.addEventListener("click", async () => {
  if (!confirm("确定恢复默认设置吗？这会清除扩展所有自定义配置。")) return;
  await chrome.storage.local.clear();
  try {
    await fetch(LOCAL_SERVER + "/config/reset", {
      method: "POST",
      signal: AbortSignal.timeout(3000),
    });
  } catch (e) {
    /* server may not support */
  }
  alert("已重置，弹窗将重新加载");
  location.reload();
});

// Start
init();
