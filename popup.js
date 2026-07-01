// Download Forwarder - Popup UI
const LOCAL_SERVER = "http://127.0.0.1:18735";
const EXT_VERSION = "1.9.0";

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

// v1.7.0 — Batch / size check / sniff / categorize
const batchToggle = document.getElementById("batch-toggle");
const singleUrlRow = document.getElementById("single-url-row");
const batchUrlRow = document.getElementById("batch-url-row");
const batchUrlsEl = document.getElementById("batch-urls");
const batchCountLabel = document.getElementById("batch-count-label");
const batchForwardBtn = document.getElementById("batch-forward-btn");
const checkSizeBtn = document.getElementById("check-size-btn");
const sizeCheckResult = document.getElementById("size-check-result");
const sniffRefreshBtn = document.getElementById("sniff-refresh-btn");
const sniffListEl = document.getElementById("sniff-list");
const sniffStatusEl = document.getElementById("sniff-status");
const sniffFilterEl = document.getElementById("sniff-filter");
const sniffSelectAllBtn = document.getElementById("sniff-select-all");
const sniffSelectNoneBtn = document.getElementById("sniff-select-none");
const sniffSelectedLabel = document.getElementById("sniff-selected-label");
const sniffForwardBtn = document.getElementById("sniff-forward-btn");
const categorizeToggle = document.getElementById("categorize-toggle");
const categoryRulesEl = document.getElementById("category-rules");
const categoryResetBtn = document.getElementById("category-reset-btn");
const categoryApplyBtn = document.getElementById("category-apply-btn");

// v1.8.0 — ffmpeg auto-stream toggle, duplicate-warning, history filters, retry, theme tri-state
const autoFfmpegToggle = document.getElementById("auto-ffmpeg-toggle");
const dupWarnToggle = document.getElementById("dup-warn-toggle");
const dupWarnMinutesEl = document.getElementById("dup-warn-minutes");
const themeModeBadge = document.getElementById("theme-mode-badge");
const historyStatusFiltersEl = document.getElementById("history-status-filters");
const historyProgramFilterEl = document.getElementById("history-program-filter");
const historyCategoryFilterEl = document.getElementById("history-category-filter");
const historyRetryAllBtn = document.getElementById("history-retry-all");

// v1.7.0: default category rules (must match the server-side defaults so the
// popup can populate the textarea even before contacting the server)
const DEFAULT_CATEGORY_RULES = [
  { name: "Documents", extensions: ["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "md", "csv", "epub"] },
  { name: "Archives", extensions: ["zip", "rar", "7z", "tar", "gz", "bz2", "xz", "iso"] },
  { name: "Video", extensions: ["mp4", "mkv", "avi", "mov", "wmv", "flv", "webm", "m4v", "mpg", "mpeg"] },
  { name: "Audio", extensions: ["mp3", "flac", "wav", "aac", "ogg", "m4a", "wma"] },
  { name: "Images", extensions: ["jpg", "jpeg", "png", "gif", "bmp", "webp", "svg", "tiff", "ico"] },
  { name: "Software", extensions: ["exe", "msi", "dmg", "pkg", "deb", "rpm", "appimage", "apk"] },
];

// --- State ---
let enabled = false;
let selectedProgram = "wget";
let availablePrograms = [];
let currentHistory = [];
let filetypeFilterEnabled = false;
let blacklistEnabled = false;
let whitelistEnabled = false;
let darkMode = false;        // retained for backward-compat restore; real source of truth is themeMode
let themeMode = "light";     // v1.8.0: "light" | "dark" | "auto"
let historySearchQuery = "";
// v1.6.0 state
let forwardCookies = false;
let customReferer = "";
let customUserAgent = "";
let proxyUrl = "";
let notifySilentAll = false;
let notifyOnlyErrors = false;
let urlRules = []; // [{ pattern: "...", program: "wget" }, ...]
// v1.7.0 state
let batchMode = false;
let sniffLinks = []; // [{url,label,filename,download_attr}]
let sniffSelected = new Set();
let sniffFilterQuery = "";
let categorizeEnabled = false;
let categoryRules = [];
// v1.8.0 state
let autoFfmpegStreams = true;
let warnDuplicates = true;
let duplicateWarnMinutes = 30;
let historyStatusFilter = "all";   // all | success | error
let historyProgramFilter = "all";  // all | <program name>
let historyCategoryFilter = "all"; // all | <category name>
let _systemDarkMql = null;        // matchMedia list handle

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
    "themeMode",
    // v1.6.0
    "forwardCookies",
    "customReferer",
    "customUserAgent",
    "proxyUrl",
    "notifyPrefs",
    "urlRules",
    // v1.7.0
    "batchMode",
    "categorizeEnabled",
    "categoryRules",
    // v1.8.0
    "autoFfmpegStreams",
    "warnDuplicates",
    "duplicateWarnMinutes",
    // v1.9.0
    "authToken",
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
  // v1.8.0: theme mode (migrate legacy darkMode boolean)
  if (data.themeMode === "light" || data.themeMode === "dark" || data.themeMode === "auto") {
    themeMode = data.themeMode;
  } else {
    themeMode = darkMode ? "dark" : "light";
  }
  // v1.6.0
  forwardCookies = data.forwardCookies || false;
  customReferer = data.customReferer || "";
  customUserAgent = data.customUserAgent || "";
  proxyUrl = data.proxyUrl || "";
  const np = data.notifyPrefs || {};
  notifySilentAll = !!np.silent_all;
  notifyOnlyErrors = !!np.only_errors;
  urlRules = Array.isArray(data.urlRules) ? data.urlRules : [];
  // v1.7.0
  batchMode = !!data.batchMode;
  categorizeEnabled = !!data.categorizeEnabled;
  categoryRules = Array.isArray(data.categoryRules) && data.categoryRules.length > 0
    ? data.categoryRules
    : DEFAULT_CATEGORY_RULES;
  // v1.8.0
  autoFfmpegStreams = data.autoFfmpegStreams !== false; // default true
  warnDuplicates = data.warnDuplicates !== false;       // default true
  duplicateWarnMinutes = typeof data.duplicateWarnMinutes === "number"
    ? data.duplicateWarnMinutes
    : 30;
  // v1.9.0
  authToken = data.authToken || "";

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
  // v1.7.0
  updateBatchToggle();
  populateCategoryInputs();
  updateCategorizeToggle();
  // v1.8.0
  updateAutoFfmpegToggle();
  updateDupWarnToggle();
  dupWarnMinutesEl.value = duplicateWarnMinutes;
  // v1.9.0
  populateAuthTokenUI();
  setupSystemThemeListener();
  renderSniffList();
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
    // v1.9.0: sync auth token from background (it may have been updated
    // by the storage.onChanged listener since the popup last opened)
    if (live && typeof live.authToken === "string" && live.authToken !== authToken) {
      authToken = live.authToken;
      populateAuthTokenUI();
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
      // v1.9.0: if the server requires auth but we don't have a token, warn
      // the user in the auth token status area so they know to set one.
      if (info.auth_required && !authToken) {
        const status = document.getElementById("auth-token-status");
        if (status) {
          status.textContent = "服务器已启用鉴权，但扩展端未设置令牌。请在下方输入令牌后保存。";
          status.style.color = "var(--error)";
        }
      }
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
    // v1.7.0: pull server-side categorize config
    if (cfg && cfg.status === "ok") {
      if (typeof cfg.categorize_enabled === "boolean") {
        categorizeEnabled = !!cfg.categorize_enabled;
        chrome.storage.local.set({ categorizeEnabled });
        updateCategorizeToggle();
      }
      if (Array.isArray(cfg.category_rules) && cfg.category_rules.length > 0) {
        categoryRules = cfg.category_rules.map((r) => ({
          name: r.name || "",
          extensions: Array.isArray(r.extensions) ? r.extensions : [],
        }));
        chrome.storage.local.set({ categoryRules });
        populateCategoryInputs();
      }
      // v1.8.0: pull server-side auto-ffmpeg-streams setting
      if (typeof cfg.auto_ffmpeg_streams === "boolean") {
        autoFfmpegStreams = !!cfg.auto_ffmpeg_streams;
        chrome.storage.local.set({ autoFfmpegStreams });
        updateAutoFfmpegToggle();
      }
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

// v1.9.0: auth token (loaded from storage, injected into all server requests)
let authToken = "";

function _authHeaders(extra) {
  const h = { ...(extra || {}) };
  if (authToken) {
    h["Authorization"] = "Bearer " + authToken;
  }
  return h;
}

function fetchJSON(url, options) {
  const opts = {
    method: "GET",
    signal: AbortSignal.timeout(3000),
    ...(options || {}),
  };
  opts.headers = _authHeaders(opts.headers);
  return fetch(url, opts).then((r) => r.json());
}

// v1.9.0: POST helper that automatically injects the Bearer token and
// JSON content-type. Returns the parsed JSON response.
async function postJSON(url, body) {
  const opts = {
    method: "POST",
    headers: _authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(5000),
  };
  const r = await fetch(url, opts);
  return r.json();
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

// --- Theme (v1.8.0: tri-state light / dark / auto) ---
function systemPrefersDark() {
  try {
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  } catch (e) {
    return false;
  }
}

function effectiveDark() {
  if (themeMode === "dark") return true;
  if (themeMode === "light") return false;
  return systemPrefersDark(); // auto
}

// Set up a matchMedia listener so "auto" reacts to OS theme changes live.
function setupSystemThemeListener() {
  try {
    if (!window.matchMedia) return;
    if (_systemDarkMql) {
      _systemDarkMql.removeEventListener("change", _onSystemThemeChange);
    }
    _systemDarkMql = window.matchMedia("(prefers-color-scheme: dark)");
    _systemDarkMql.addEventListener("change", _onSystemThemeChange);
  } catch (e) {
    /* ignore */
  }
}

function _onSystemThemeChange() {
  if (themeMode === "auto") applyTheme();
}

function applyTheme() {
  darkMode = effectiveDark();
  document.body.classList.toggle("dark", darkMode);
  // Icon: sun for light, moon for dark, crescent for auto
  let icon = "\u{1F313}";       // 🌙 new moon — light default
  let badge = "浅";
  if (themeMode === "dark") { icon = "\u2600\uFE0F"; badge = "深"; }      // ☀️
  else if (themeMode === "auto") { icon = "\u{1F317}"; badge = "自"; }    // 🌗 last quarter
  // Retain the badge span; rebuild button content
  themeBtn.textContent = icon;
  if (themeModeBadge) {
    themeModeBadge.textContent = badge;
    // ensure badge stays in the DOM (it's inside the button)
    if (!themeBtn.contains(themeModeBadge)) themeBtn.appendChild(themeModeBadge);
  }
}

themeBtn.addEventListener("click", () => {
  // Cycle: light -> dark -> auto -> light
  const order = { light: "dark", dark: "auto", auto: "light" };
  themeMode = order[themeMode] || "light";
  chrome.storage.local.set({ themeMode, darkMode: effectiveDark() });
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
    // v1.9.0: auto-load tasks when the tasks tab is activated
    if (tab.dataset.tab === "tasks") {
      loadTasks();
    }
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
    await postJSON(LOCAL_SERVER + "/config", { download_dir: dir });
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
    await postJSON(LOCAL_SERVER + "/config", {
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
      // v1.7.0
      categorize_enabled: categorizeEnabled,
      category_rules: categoryRules,
      // v1.8.0
      auto_ffmpeg_streams: autoFfmpegStreams,
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

// ===========================================================================
// v1.7.0 features
// ===========================================================================

// --- Batch mode toggle ---
function updateBatchToggle() {
  batchToggle.classList.toggle("active", batchMode);
  singleUrlRow.style.display = batchMode ? "none" : "flex";
  batchUrlRow.style.display = batchMode ? "block" : "none";
  updateBatchCount();
}
batchToggle.addEventListener("click", () => {
  batchMode = !batchMode;
  chrome.storage.local.set({ batchMode });
  updateBatchToggle();
});

function updateBatchCount() {
  const urls = parseBatchUrls();
  batchCountLabel.textContent = `${urls.length} 个 URL`;
}
function parseBatchUrls() {
  if (!batchUrlsEl.value) return [];
  return batchUrlsEl.value
    .split(/[\n\r]+/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}
batchUrlsEl.addEventListener("input", updateBatchCount);

batchForwardBtn.addEventListener("click", async () => {
  const urls = parseBatchUrls();
  if (urls.length === 0) {
    batchUrlsEl.focus();
    return;
  }
  batchForwardBtn.disabled = true;
  try {
    const resp = await chrome.runtime.sendMessage({
      type: "batch-forward",
      urls: urls,
    });
    if (resp && resp.status === "ok") {
      const msg = `成功 ${resp.success} / 失败 ${resp.failed} / 共 ${resp.total}`;
      alert("批量转发完成：" + msg);
      if (resp.failed === 0) batchUrlsEl.value = "";
      updateBatchCount();
    } else {
      alert("批量转发失败：" + ((resp && resp.message) || "未知错误"));
    }
  } catch (e) {
    console.warn("batch forward failed", e);
    alert("批量转发异常：" + String(e));
  } finally {
    batchForwardBtn.disabled = false;
  }
});

// --- File size pre-check ---
checkSizeBtn.addEventListener("click", async () => {
  const url = manualUrlEl.value.trim();
  if (!url) {
    manualUrlEl.focus();
    return;
  }
  checkSizeBtn.disabled = true;
  sizeCheckResult.style.display = "block";
  sizeCheckResult.innerHTML = '<span class="hint">正在预检…</span>';
  try {
    const resp = await chrome.runtime.sendMessage({
      type: "check-size",
      url: url,
    });
    if (resp && resp.status === "ok") {
      const parts = [];
      if (resp.size_human) parts.push(`<span class="size-ok">大小: ${escapeHtml(resp.size_human)}</span>`);
      if (resp.filename) parts.push(`文件名: ${escapeHtml(resp.filename)}`);
      if (resp.content_type) parts.push(`类型: ${escapeHtml(resp.content_type)}`);
      if (resp.redirected) parts.push(`<span class="size-error">(已重定向)</span>`);
      sizeCheckResult.innerHTML = parts.length ? parts.join(" · ") : '<span class="hint">服务器未返回大小信息</span>';
    } else {
      sizeCheckResult.innerHTML = `<span class="size-error">预检失败: ${escapeHtml((resp && resp.message) || "未知错误")}</span>`;
    }
  } catch (e) {
    sizeCheckResult.innerHTML = `<span class="size-error">预检异常: ${escapeHtml(String(e))}</span>`;
  } finally {
    checkSizeBtn.disabled = false;
  }
});

// --- Link sniffing ---
function renderSniffList() {
  const q = sniffFilterQuery.trim().toLowerCase();
  const filtered = q
    ? sniffLinks.filter((l) => {
        const u = (l.url || "").toLowerCase();
        const f = (l.filename || "").toLowerCase();
        const lb = (l.label || "").toLowerCase();
        return u.includes(q) || f.includes(q) || lb.includes(q);
      })
    : sniffLinks;

  if (!filtered.length) {
    sniffListEl.innerHTML = '<div class="sniff-empty">未找到可下载链接，点击「扫描当前页」</div>';
    updateSniffSelectedLabel();
    return;
  }
  sniffListEl.innerHTML = filtered
    .map((l, idx) => {
      const checked = sniffSelected.has(l.url) ? "checked" : "";
      const name = escapeHtml(l.filename || l.label || l.url);
      const label = l.label ? `<div class="sniff-item-name">${escapeHtml(l.label)}</div>` : "";
      return `<div class="sniff-item">
        <input type="checkbox" class="sniff-checkbox" data-url="${escapeHtml(l.url)}" ${checked}>
        <div class="sniff-item-body">
          ${label}
          <div class="sniff-item-name">${name}</div>
          <div class="sniff-item-url">${escapeHtml(l.url)}</div>
        </div>
      </div>`;
    })
    .join("");
  updateSniffSelectedLabel();
}

function updateSniffSelectedLabel() {
  sniffSelectedLabel.textContent = `已选 ${sniffSelected.size} 项 / 共 ${sniffLinks.length} 项`;
}

sniffRefreshBtn.addEventListener("click", async () => {
  sniffRefreshBtn.disabled = true;
  sniffStatusEl.textContent = "正在扫描当前页面…";
  sniffListEl.innerHTML = '<div class="sniff-empty">扫描中…</div>';
  try {
    const resp = await chrome.runtime.sendMessage({ type: "sniff-current-page" });
    if (resp && resp.status === "ok" && Array.isArray(resp.links)) {
      sniffLinks = resp.links;
      sniffSelected = new Set(sniffLinks.map((l) => l.url));
      sniffStatusEl.textContent = `在 ${escapeHtml(resp.origin || "当前页")} 找到 ${sniffLinks.length} 个可下载链接`;
      renderSniffList();
    } else {
      sniffLinks = [];
      sniffSelected = new Set();
      sniffStatusEl.textContent = "扫描失败：" + ((resp && resp.message) || "未找到链接");
      renderSniffList();
    }
  } catch (e) {
    sniffStatusEl.textContent = "扫描异常：" + escapeHtml(String(e));
    sniffLinks = [];
    sniffSelected = new Set();
    renderSniffList();
  } finally {
    sniffRefreshBtn.disabled = false;
  }
});

sniffListEl.addEventListener("change", (e) => {
  const cb = e.target.closest(".sniff-checkbox");
  if (!cb) return;
  const url = cb.dataset.url;
  if (!url) return;
  if (cb.checked) {
    sniffSelected.add(url);
  } else {
    sniffSelected.delete(url);
  }
  updateSniffSelectedLabel();
});

sniffSelectAllBtn.addEventListener("click", () => {
  for (const l of sniffLinks) sniffSelected.add(l.url);
  renderSniffList();
});
sniffSelectNoneBtn.addEventListener("click", () => {
  sniffSelected.clear();
  renderSniffList();
});

sniffFilterEl.addEventListener("input", () => {
  sniffFilterQuery = sniffFilterEl.value;
  renderSniffList();
});

sniffForwardBtn.addEventListener("click", async () => {
  const urls = sniffLinks.filter((l) => sniffSelected.has(l.url)).map((l) => l.url);
  if (urls.length === 0) {
    alert("请先勾选要转发的链接");
    return;
  }
  sniffForwardBtn.disabled = true;
  try {
    const resp = await chrome.runtime.sendMessage({
      type: "batch-forward",
      urls: urls,
    });
    if (resp && resp.status === "ok") {
      alert(`嗅探批量转发完成：成功 ${resp.success} / 失败 ${resp.failed} / 共 ${resp.total}`);
    } else {
      alert("转发失败：" + ((resp && resp.message) || "未知错误"));
    }
  } catch (e) {
    alert("转发异常：" + String(e));
  } finally {
    sniffForwardBtn.disabled = false;
  }
});

// --- Auto-categorize (v1.7.0) ---
function updateCategorizeToggle() {
  categorizeToggle.classList.toggle("active", categorizeEnabled);
  categoryRulesEl.disabled = !categorizeEnabled;
}
categorizeToggle.addEventListener("click", () => {
  categorizeEnabled = !categorizeEnabled;
  chrome.storage.local.set({ categorizeEnabled });
  updateCategorizeToggle();
  syncSettingsToServer();
});

function populateCategoryInputs() {
  // Render the rules as "Name: ext1,ext2,..." one per line
  if (!categoryRules || categoryRules.length === 0) {
    categoryRulesEl.value = "";
    return;
  }
  categoryRulesEl.value = categoryRules
    .map((r) => `${r.name}: ${(r.extensions || []).join(",")}`)
    .join("\n");
}

function parseCategoryRulesText(text) {
  if (!text) return [];
  const rules = [];
  for (const line of text.split(/[\n\r]+/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx < 0) continue;
    const name = trimmed.substring(0, colonIdx).trim();
    const extsPart = trimmed.substring(colonIdx + 1).trim();
    const exts = extsPart
      .split(/[,\s]+/)
      .map((e) => e.toLowerCase().replace(/^\./, ""))
      .filter((e) => e);
    if (name && exts.length > 0) {
      rules.push({ name: name, extensions: exts });
    }
  }
  return rules;
}

categoryApplyBtn.addEventListener("click", () => {
  const text = categoryRulesEl.value;
  const parsed = parseCategoryRulesText(text);
  if (parsed.length === 0) {
    alert("未能解析出任何有效规则。每行格式应为：分类名: ext1,ext2,...");
    return;
  }
  categoryRules = parsed;
  chrome.storage.local.set({ categoryRules });
  populateCategoryInputs();
  syncSettingsToServer();
  alert(`已应用 ${parsed.length} 条分类规则`);
});

categoryResetBtn.addEventListener("click", () => {
  categoryRules = DEFAULT_CATEGORY_RULES.map((r) => ({
    name: r.name,
    extensions: r.extensions.slice(),
  }));
  chrome.storage.local.set({ categoryRules });
  populateCategoryInputs();
  syncSettingsToServer();
});

// ===========================================================================
// v1.8.0 features: auto-ffmpeg toggle, duplicate warning, history filters
// ===========================================================================

// --- Auto ffmpeg for streams toggle ---
function updateAutoFfmpegToggle() {
  autoFfmpegToggle.classList.toggle("active", autoFfmpegStreams);
}
autoFfmpegToggle.addEventListener("click", () => {
  autoFfmpegStreams = !autoFfmpegStreams;
  chrome.storage.local.set({ autoFfmpegStreams });
  updateAutoFfmpegToggle();
  syncSettingsToServer();
});

// --- Duplicate download warning toggle ---
function updateDupWarnToggle() {
  dupWarnToggle.classList.toggle("active", warnDuplicates);
}
dupWarnToggle.addEventListener("click", () => {
  warnDuplicates = !warnDuplicates;
  chrome.storage.local.set({ warnDuplicates });
  updateDupWarnToggle();
});
dupWarnMinutesEl.addEventListener("change", () => {
  let v = parseInt(dupWarnMinutesEl.value, 10);
  if (isNaN(v)) v = 30;
  v = Math.max(0, Math.min(1440, v));
  duplicateWarnMinutes = v;
  dupWarnMinutesEl.value = v;
  chrome.storage.local.set({ duplicateWarnMinutes: v });
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

// --- History rendering (v1.8.0: status / program / category filters + retry) ---
function renderHistory(items) {
  currentHistory = items || [];
  // Refresh filter dropdown options + chip counts before filtering
  populateHistoryFilterOptions();
  updateHistoryChipCounts();
  applyHistoryFilter();
}

// Rebuild the program / category dropdowns based on the current history while
// preserving the user's current selection.
function populateHistoryFilterOptions() {
  const programs = new Set();
  const categories = new Set();
  for (const item of currentHistory) {
    if (item && item.program) programs.add(item.program);
    if (item && item.category) categories.add(item.category);
  }
  // Program dropdown
  const prevProg = historyProgramFilter;
  let progHtml = '<option value="all">所有下载器</option>';
  for (const p of [...programs].sort()) {
    progHtml += `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`;
  }
  historyProgramFilterEl.innerHTML = progHtml;
  if ([...programs].includes(prevProg) || prevProg === "all") {
    historyProgramFilterEl.value = prevProg;
  } else {
    historyProgramFilter = "all";
    historyProgramFilterEl.value = "all";
  }
  // Category dropdown
  const prevCat = historyCategoryFilter;
  let catHtml = '<option value="all">所有分类</option>';
  for (const c of [...categories].sort()) {
    catHtml += `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`;
  }
  historyCategoryFilterEl.innerHTML = catHtml;
  if ([...categories].includes(prevCat) || prevCat === "all") {
    historyCategoryFilterEl.value = prevCat;
  } else {
    historyCategoryFilter = "all";
    historyCategoryFilterEl.value = "all";
  }
}

function updateHistoryChipCounts() {
  const setCount = (id, n) => {
    const el = document.getElementById(id);
    if (el) el.textContent = n;
  };
  let success = 0, error = 0;
  for (const item of currentHistory) {
    if (!item) continue;
    if (item.status === "success") success++;
    else error++;
  }
  setCount("chip-count-all", currentHistory.length);
  setCount("chip-count-success", success);
  setCount("chip-count-error", error);
}

function applyHistoryFilter() {
  const q = historySearchQuery.trim().toLowerCase();
  let filtered = currentHistory;
  // Status filter
  if (historyStatusFilter !== "all") {
    filtered = filtered.filter((item) => item && item.status === historyStatusFilter);
  }
  // Program filter
  if (historyProgramFilter !== "all") {
    filtered = filtered.filter((item) => item && item.program === historyProgramFilter);
  }
  // Category filter
  if (historyCategoryFilter !== "all") {
    filtered = filtered.filter((item) => item && item.category === historyCategoryFilter);
  }
  // Free-text search
  if (q) {
    filtered = filtered.filter((item) => {
      const u = (item.url || "").toLowerCase();
      const f = (item.filename || "").toLowerCase();
      return u.includes(q) || f.includes(q);
    });
  }

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
      const catLabel = item.category
        ? `<span class="history-source">${escapeHtml(item.category)}</span>`
        : "";
      // Retry reads the URL/filename directly from data attributes, so no
      // index bookkeeping is needed.
      const retryDisabled = !displayUrl ? "disabled" : "";
      return `<div class="history-item">
        <div class="history-meta">
          <span class="history-program ${
            success ? "program-badge-success" : "program-badge-error"
          }">${programName}</span>
          <span class="history-time">${time}${sourceLabel}${catLabel}</span>
        </div>
        <a class="history-url" href="${escapeHtml(displayUrl)}" target="_blank" rel="noopener">${escapeHtml(
        truncate(item.filename || displayUrl, 60)
      )}</a>
        <div class="history-actions">
          <button class="retry-btn" data-url="${escapeHtml(displayUrl)}" data-filename="${escapeHtml(item.filename || "")}" ${retryDisabled}>重试</button>
        </div>
      </div>`;
    })
    .join("");
  countLabel.textContent = `共 ${currentHistory.length} 条 (显示 ${Math.min(
    20,
    filtered.length
  )} 条)`;
}

// --- History filter event handlers (v1.8.0) ---
historyStatusFiltersEl.addEventListener("click", (e) => {
  const chip = e.target.closest(".filter-chip");
  if (!chip) return;
  historyStatusFilter = chip.dataset.status || "all";
  historyStatusFiltersEl.querySelectorAll(".filter-chip").forEach((c) => {
    c.classList.toggle("active", c === chip);
  });
  applyHistoryFilter();
});

historyProgramFilterEl.addEventListener("change", () => {
  historyProgramFilter = historyProgramFilterEl.value || "all";
  applyHistoryFilter();
});

historyCategoryFilterEl.addEventListener("change", () => {
  historyCategoryFilter = historyCategoryFilterEl.value || "all";
  applyHistoryFilter();
});

// Retry a single history entry by re-forwarding its URL via the background
// service worker. Uses the same manual-forward path as the manual URL box.
async function retryHistoryItem(url, filename) {
  if (!url) return;
  try {
    const resp = await chrome.runtime.sendMessage({
      type: "manual-forward",
      url: url,
      filename: filename || "",
    });
    if (resp && resp.status === "success") {
      // subtle feedback without alerting (keeps the user in flow)
      return true;
    }
    alert("重试失败：" + ((resp && resp.message) || "未知错误"));
  } catch (e) {
    alert("重试异常：" + String(e));
  }
  return false;
}

historyListEl.addEventListener("click", async (e) => {
  const btn = e.target.closest(".retry-btn");
  if (!btn || btn.disabled) return;
  const url = btn.dataset.url || "";
  const filename = btn.dataset.filename || "";
  if (!url) return;
  btn.disabled = true;
  await retryHistoryItem(url, filename);
  btn.disabled = false;
});

historyRetryAllBtn.addEventListener("click", async () => {
  // "重试全部失败" re-forwards every failed record in the full history,
  // regardless of the active filters (so the button always does what its name
  // says even while the user is viewing "success" only).
  const failed = (currentHistory || []).filter((it) => it && it.status !== "success" && it.url);
  if (failed.length === 0) {
    alert("当前历史中没有失败记录可重试");
    return;
  }
  if (!confirm(`将重试 ${failed.length} 条失败记录，是否继续？`)) return;
  historyRetryAllBtn.disabled = true;
  let ok = 0;
  let fail = 0;
  for (const item of failed) {
    const success = await retryHistoryItem(item.url, item.filename || "");
    if (success) ok++; else fail++;
  }
  historyRetryAllBtn.disabled = false;
  alert(`重试完成：成功 ${ok} / 失败 ${fail} / 共 ${failed.length}`);
});


historySearchEl.addEventListener("input", () => {
  historySearchQuery = historySearchEl.value;
  applyHistoryFilter();
});

clearHistoryBtn.addEventListener("click", async () => {
  if (!confirm("确定清空所有下载历史吗？")) return;
  chrome.storage.local.set({ recentDownloads: [] });
  try {
    await postJSON(LOCAL_SERVER + "/history/clear", {});
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
  // v1.8.0: theme mode (also react to legacy darkMode for cross-window sync)
  if (changes.themeMode) {
    const v = changes.themeMode.newValue;
    if (v === "light" || v === "dark" || v === "auto") {
      themeMode = v;
      applyTheme();
    }
  } else if (changes.darkMode) {
    darkMode = !!changes.darkMode.newValue;
    if (themeMode !== "auto") applyTheme();
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
      "themeMode",
      // v1.6.0
      "forwardCookies",
      "customReferer",
      "customUserAgent",
      "proxyUrl",
      "notifyPrefs",
      "urlRules",
      // v1.7.0
      "batchMode",
      "categorizeEnabled",
      "categoryRules",
      // v1.8.0
      "autoFfmpegStreams",
      "warnDuplicates",
      "duplicateWarnMinutes",
      // v1.9.0
      "authToken",
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
      // v1.7.0
      "categorize_enabled",
      "category_rules",
      // v1.8.0
      "auto_ffmpeg_streams",
      // v1.9.0
      "auth_token",
    ];
    for (const f of fields) {
      if (f in s) body[f] = s[f];
    }
    try {
      await postJSON(LOCAL_SERVER + "/config", body);
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
    await postJSON(LOCAL_SERVER + "/config/reset", {});
  } catch (e) {
    /* server may not support */
  }
  alert("已重置，弹窗将重新加载");
  location.reload();
});

// ===== v1.9.0: Bearer Token 鉴权配置 =====

function populateAuthTokenUI() {
  const input = document.getElementById("auth-token-input");
  const status = document.getElementById("auth-token-status");
  if (!input || !status) return;
  input.value = authToken || "";
  if (authToken) {
    status.textContent = "已设置令牌（" + authToken.length + " 字符）。鉴权已启用。";
    status.style.color = "var(--success)";
  } else {
    status.textContent = "未设置令牌。鉴权已关闭（默认）。";
    status.style.color = "var(--text-tertiary)";
  }
}

document.getElementById("auth-token-save-btn").addEventListener("click", async () => {
  const input = document.getElementById("auth-token-input");
  const status = document.getElementById("auth-token-status");
  const token = (input.value || "").trim();
  authToken = token;
  try {
    // 通过 background 同步保存到 chrome.storage.local 并推送到服务器
    const result = await chrome.runtime.sendMessage({
      type: "set-auth-token",
      token: token,
    });
    if (result && result.status === "ok") {
      status.textContent = "令牌已保存并同步到服务器。";
      status.style.color = "var(--success)";
    } else if (result && result.status === "error") {
      // 令牌已保存到扩展端，但服务器同步失败
      status.textContent = "令牌已保存到扩展端（服务器同步失败: " + (result.message || "未知错误") + "）";
      status.style.color = "var(--error)";
    } else {
      status.textContent = "令牌已保存到扩展端。";
      status.style.color = "var(--success)";
    }
  } catch (e) {
    // background 可能未响应，直接保存到 storage
    chrome.storage.local.set({ authToken: token });
    status.textContent = "令牌已保存到扩展端（后台未响应）。";
    status.style.color = "var(--text-tertiary)";
  }
  populateAuthTokenUI();
});

document.getElementById("auth-token-clear-btn").addEventListener("click", async () => {
  authToken = "";
  document.getElementById("auth-token-input").value = "";
  try {
    await chrome.runtime.sendMessage({ type: "set-auth-token", token: "" });
  } catch (e) {
    chrome.storage.local.set({ authToken: "" });
  }
  populateAuthTokenUI();
});

document.getElementById("auth-token-toggle-visibility").addEventListener("click", () => {
  const input = document.getElementById("auth-token-input");
  if (input.type === "password") {
    input.type = "text";
  } else {
    input.type = "password";
  }
});

// ===== v1.9.0: 活动任务管理 =====

async function loadTasks() {
  const listEl = document.getElementById("tasks-list");
  const statusEl = document.getElementById("tasks-status");
  const countEl = document.getElementById("tasks-count-label");
  if (!listEl) return;

  statusEl.textContent = "正在加载…";
  try {
    const result = await chrome.runtime.sendMessage({ type: "list-tasks" });
    if (result && result.status === "ok") {
      const tasks = result.tasks || [];
      renderTasks(tasks);
      const running = tasks.filter((t) => t.status === "running").length;
      countEl.textContent = `${tasks.length} 个任务（${running} 个运行中）`;
      statusEl.textContent = "";
    } else if (result && result.status === "error") {
      listEl.innerHTML = '<div class="task-empty">' + (result.message || "加载失败") + '</div>';
      countEl.textContent = "0 个任务";
      statusEl.textContent = result.message || "";
    }
  } catch (e) {
    listEl.innerHTML = '<div class="task-empty">无法获取任务列表</div>';
    countEl.textContent = "0 个任务";
    statusEl.textContent = String(e);
  }
}

function renderTasks(tasks) {
  const listEl = document.getElementById("tasks-list");
  if (!listEl) return;

  if (!tasks || tasks.length === 0) {
    listEl.innerHTML = '<div class="task-empty">暂无任务</div>';
    return;
  }

  const statusLabels = {
    running: "运行中",
    completed: "已完成",
    failed: "失败",
    cancelled: "已取消",
  };

  listEl.innerHTML = tasks.map((t) => {
    const isRunning = t.status === "running";
    const filename = t.filename || "(未命名)";
    const url = t.url || "";
    const program = t.program || "?";
    const started = t.started_at || "";
    const ended = t.ended_at || "";
    const statusText = statusLabels[t.status] || t.status;
    const exitCode = t.exit_code !== null && t.exit_code !== undefined
      ? " 退出码: " + t.exit_code
      : "";

    return (
      '<div class="task-item">' +
        '<div class="task-item-header">' +
          '<span class="task-program">' + escapeHtml(program) + "</span>" +
          '<span class="task-status ' + t.status + '">' + statusText + "</span>" +
        "</div>" +
        '<div class="task-url">' + escapeHtml(filename) + "</div>" +
        '<div class="task-meta">' +
          (started ? "开始: " + started : "") +
          (ended ? "  结束: " + ended : "") +
          exitCode +
          (t.pid ? "  PID: " + t.pid : "") +
        "</div>" +
        (isRunning
          ? '<div style="margin-top:4px;text-align:right;">' +
              '<button class="task-cancel-btn" data-task-id="' + escapeHtml(t.task_id) + '">取消</button>' +
            "</div>"
          : "") +
      "</div>"
    );
  }).join("");

  // 绑定取消按钮事件
  listEl.querySelectorAll(".task-cancel-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const taskId = btn.dataset.taskId;
      if (!taskId) return;
      btn.disabled = true;
      btn.textContent = "取消中…";
      try {
        const result = await chrome.runtime.sendMessage({
          type: "cancel-tasks",
          task_ids: [taskId],
        });
        if (result && result.status === "ok") {
          // 刷新任务列表
          setTimeout(() => loadTasks(), 500);
        } else {
          btn.disabled = false;
          btn.textContent = "取消";
          alert("取消失败: " + (result && result.message ? result.message : "未知错误"));
        }
      } catch (e) {
        btn.disabled = false;
        btn.textContent = "取消";
        alert("取消失败: " + String(e));
      }
    });
  });
}

document.getElementById("tasks-refresh-btn").addEventListener("click", () => {
  loadTasks();
});

document.getElementById("tasks-cancel-all-btn").addEventListener("click", async () => {
  const listEl = document.getElementById("tasks-list");
  const runningIds = [];
  listEl.querySelectorAll(".task-cancel-btn").forEach((btn) => {
    runningIds.push(btn.dataset.taskId);
  });
  if (runningIds.length === 0) {
    alert("没有正在运行的任务");
    return;
  }
  if (!confirm("确定取消全部 " + runningIds.length + " 个正在运行的任务吗？")) return;
  try {
    const result = await chrome.runtime.sendMessage({
      type: "cancel-tasks",
      task_ids: runningIds,
    });
    if (result && result.status === "ok") {
      setTimeout(() => loadTasks(), 500);
    } else {
      alert("批量取消失败: " + (result && result.message ? result.message : "未知错误"));
    }
  } catch (e) {
    alert("批量取消失败: " + String(e));
  }
});

// HTML 转义辅助函数，防止任务信息中的特殊字符破坏 DOM
function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Start
init();
