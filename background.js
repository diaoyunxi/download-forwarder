// Download Forwarder - Background Service Worker
// Handles download interception, server communication, notifications, state,
// context menu, keyboard shortcuts, and toolbar badge.

const LOCAL_SERVER = "http://127.0.0.1:18735";
const PING_INTERVAL = 15000;
const PING_ALARM = "df-ping";
const MAX_BADGE_COUNT = 99;

let serverConnected = false;
let serverInfo = null;
let recentDownloads = [];
let activeDownloads = 0;

// --- Notification preferences (loaded from storage) ---
let notifyPrefs = {
  silent_all: false,        // mute all notification sounds
  only_errors: false,       // only show error/failure notifications
};

// v1.8.0: duplicate-download warning. When enabled (default), forwarding a URL
// that already appears in the recent history within the configured window will
// emit an extra warning notification (the download itself still proceeds).
let warnDuplicates = true;
let duplicateWarnMinutes = 30;

async function loadNotifyPrefs() {
  try {
    const data = await chrome.storage.local.get(["notifyPrefs", "warnDuplicates", "duplicateWarnMinutes"]);
    if (data.notifyPrefs && typeof data.notifyPrefs === "object") {
      notifyPrefs = Object.assign(notifyPrefs, data.notifyPrefs);
    }
    if (typeof data.warnDuplicates === "boolean") warnDuplicates = data.warnDuplicates;
    if (typeof data.duplicateWarnMinutes === "number") duplicateWarnMinutes = data.duplicateWarnMinutes;
  } catch (e) {
    /* ignore */
  }
}
loadNotifyPrefs();

// Listen for pref changes from popup
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.notifyPrefs) {
    notifyPrefs = Object.assign(
      notifyPrefs,
      changes.notifyPrefs.newValue || {}
    );
  }
  if (area === "local" && changes.warnDuplicates) {
    warnDuplicates = !!changes.warnDuplicates.newValue;
  }
  if (area === "local" && changes.duplicateWarnMinutes) {
    const v = changes.duplicateWarnMinutes.newValue;
    if (typeof v === "number") duplicateWarnMinutes = v;
  }
});

// v1.8.0: scan the in-extension recent history for a matching URL within the
// configured time window. Returns the matching entry or null.
async function findRecentDuplicate(url) {
  if (!warnDuplicates || !url) return null;
  const windowMs = Math.max(0, duplicateWarnMinutes) * 60 * 1000;
  if (windowMs <= 0) return null;
  try {
    const data = await chrome.storage.local.get(["recentDownloads"]);
    const history = data.recentDownloads || [];
    const cutoff = Date.now() - windowMs;
    for (const item of history) {
      if (!item) continue;
      if (item.url !== url) continue;
      const ts = item.timestamp ? new Date(item.timestamp).getTime() : 0;
      if (ts && ts >= cutoff) return item;
    }
  } catch (e) {
    /* ignore */
  }
  return null;
}

function notifyDuplicateWarning(url, when) {
  const ago = when
    ? new Date(when).toLocaleTimeString()
    : "earlier";
  notify(
    "可能重复下载",
    `该 URL 在 ${ago} 已下载过：${truncate(url, 50)}`,
    "error"
  );
}

// --- Helpers ---
// Severity: "success" | "error". Success notifications can be suppressed when
// the user has enabled "only errors" mode.
function notify(title, message, severity) {
  const isError = severity === "error";
  // Suppress success notifications when only_errors is enabled
  if (notifyPrefs.only_errors && !isError) return;
  try {
    chrome.notifications.create(
      String(Date.now() + Math.random()),
      {
        type: "basic",
        iconUrl: "icons/icon128.png",
        title: title,
        message: message,
        silent: !!notifyPrefs.silent_all,
        priority: isError ? 2 : 0,
      },
      () => {
        /* ignore errors */
      }
    );
  } catch (e) {
    console.error("notify error", e);
  }
}

// --- Cookie capture ---
// Returns a single "name=value; name2=value2" cookie header string for the URL.
async function getCookieHeader(url) {
  try {
    const cookies = await chrome.cookies.getAll({ url });
    if (!cookies || cookies.length === 0) return "";
    return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  } catch (e) {
    // cookies API may be unavailable or the URL invalid; treat as no cookies
    return "";
  }
}

// Determine the Referer to forward. Uses the active tab's URL when the
// download originates from auto-interception; for manual/context-menu sources
// the caller may pass an explicit referer.
async function getReferer(tabId) {
  if (!tabId) return "";
  try {
    const tab = await chrome.tabs.get(tabId);
    return tab && tab.url ? tab.url : "";
  } catch (e) {
    return "";
  }
}

async function fetchJSON(url, options) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(6000),
  });
  if (!response.ok && response.status !== 200) {
    // Allow non-2xx only when body is parseable
  }
  return await response.json();
}

// --- Badge management ---
function updateBadge() {
  let text = "";
  let color = "#1a73e8";

  if (!serverConnected) {
    text = "!";
    color = "#ea4335";
  } else if (activeDownloads > 0) {
    text = activeDownloads > MAX_BADGE_COUNT
      ? `${MAX_BADGE_COUNT}+`
      : String(activeDownloads);
    color = "#34a853";
  }

  try {
    chrome.action.setBadgeText({ text });
    chrome.action.setBadgeBackgroundColor({ color });
  } catch (e) {
    /* ignore */
  }
}

function bumpActive(delta) {
  activeDownloads = Math.max(0, activeDownloads + delta);
  updateBadge();
  // Decrement after a window; downloads typically take a few minutes
  if (delta > 0) {
    setTimeout(() => {
      activeDownloads = Math.max(0, activeDownloads - 1);
      updateBadge();
    }, 5 * 60 * 1000);
  }
}

// --- Health check ---
async function checkConnection() {
  try {
    const data = await fetchJSON(LOCAL_SERVER + "/ping", { method: "GET" });
    if (data && data.status === "ok") {
      serverConnected = true;
      serverInfo = {
        version: data.version || "1.0.0",
        platform: data.platform || "unknown",
        available_programs: data.available_programs || [],
      };
      chrome.storage.local.set({
        serverConnected: true,
        serverInfo: serverInfo,
      });
      updateBadge();
      return;
    }
    throw new Error("unexpected response");
  } catch (err) {
    const wasConnected = serverConnected;
    serverConnected = false;
    serverInfo = null;
    chrome.storage.local.set({ serverConnected: false });
    if (wasConnected) {
      console.warn("Server disconnected", err);
    }
    updateBadge();
  }
}

// Periodic connectivity check (chrome.alarms survives MV3 service worker termination)
chrome.alarms.create(PING_ALARM, { periodInMinutes: PING_INTERVAL / 60000 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm && alarm.name === PING_ALARM) {
    checkConnection();
  }
  if (alarm && alarm.name === UPDATE_ALARM) {
    checkForUpdate();
  }
});
// Kick off an immediate check on SW startup
checkConnection();

// --- Context menu setup ---
function setupContextMenu() {
  try {
    chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create({
        id: "forward-link",
        title: "转发此链接到下载管理器",
        contexts: ["link"],
      });
      chrome.contextMenus.create({
        id: "forward-image",
        title: "转发此图片到下载管理器",
        contexts: ["image"],
      });
      chrome.contextMenus.create({
        id: "forward-video",
        title: "转发此视频到下载管理器",
        contexts: ["video", "audio"],
      });
      chrome.contextMenus.create({
        id: "forward-page",
        title: "转发当前页面到下载管理器",
        contexts: ["page"],
      });
      chrome.contextMenus.create({
        id: "toggle-interception-menu",
        title: "切换下载拦截开关",
        contexts: ["action"],
      });
    });
  } catch (e) {
    console.warn("contextMenus setup failed", e);
  }
}
setupContextMenu();

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  let url = "";
  let filename = "";

  switch (info.menuItemId) {
    case "forward-link":
      url = info.linkUrl || "";
      filename = extractFilenameFromUrl(url) || info.selectionText || "";
      break;
    case "forward-image":
      url = info.srcUrl || "";
      filename = extractFilenameFromUrl(url) || "image";
      break;
    case "forward-video":
      url = info.srcUrl || info.linkUrl || "";
      filename = extractFilenameFromUrl(url) || "media";
      break;
    case "forward-page":
      url = info.pageUrl || (tab && tab.url) || "";
      filename = extractFilenameFromUrl(url) || (tab && tab.title) || "page";
      break;
    case "toggle-interception-menu":
      await toggleInterception();
      return;
    default:
      return;
  }

  if (!url) return;
  await forwardUrl(url, filename, "context-menu");
});

// --- Keyboard shortcuts ---
chrome.commands.onCommand.addListener(async (command) => {
  if (command === "toggle-interception") {
    await toggleInterception();
  } else if (command === "forward-current-page") {
    try {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (tab && tab.url) {
        const filename =
          extractFilenameFromUrl(tab.url) || tab.title || "page";
        await forwardUrl(tab.url, filename, "shortcut");
      }
    } catch (e) {
      console.warn("forward-current-page failed", e);
    }
  } else if (command === "sniff-links") {
    // v1.7.0: sniff the current page and forward all detected links as a batch
    try {
      const result = await sniffCurrentPage();
      if (result && result.status === "ok" && result.links && result.links.length > 0) {
        const urls = result.links.map((l) => l.url);
        await forwardBatch(urls);
      } else {
        notify(
          "链接嗅探",
          (result && result.message) || "未找到可下载链接",
          "error"
        );
      }
    } catch (e) {
      console.warn("sniff-links shortcut failed", e);
    }
  }
});

async function toggleInterception() {
  const data = await chrome.storage.local.get(["enabled"]);
  const next = !data.enabled;
  await chrome.storage.local.set({ enabled: next });
  notify(
    next ? "下载拦截已开启" : "下载拦截已关闭",
    next
      ? "浏览器下载将被转发到本地下载管理器"
      : "浏览器将使用自身下载",
    "success"
  );
  // Tell popup if it is open
  try {
    await chrome.runtime.sendMessage({
      type: "interception-toggled",
      enabled: next,
    });
  } catch (e) {
    /* popup may not be open */
  }
}

// Listen for messages from popup
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "popup-opened") {
    sendResponse({
      serverConnected,
      serverInfo,
      activeDownloads,
    });
    return true;
  }
  if (msg && msg.type === "manual-forward") {
    forwardUrl(msg.url, msg.filename || "", "manual").then((r) =>
      sendResponse(r)
    );
    return true;
  }
  // v1.7.0: batch forward
  if (msg && msg.type === "batch-forward") {
    forwardBatch(msg.urls || []).then((r) => sendResponse(r));
    return true;
  }
  // v1.7.0: file size pre-check
  if (msg && msg.type === "check-size") {
    checkFileSize(msg.url || "").then((r) => sendResponse(r));
    return true;
  }
  // v1.7.0: link sniffing — ask the active tab's content script to scan
  if (msg && msg.type === "sniff-current-page") {
    sniffCurrentPage().then((r) => sendResponse(r));
    return true;
  }
});

// --- Common forward logic (used by context menu, shortcut, manual) ---
async function forwardUrl(url, filename, source) {
  if (!url) return { status: "error", message: "URL is empty" };
  if (!serverConnected) {
    notify("下载转发失败", "本地服务器未运行，请先启动 server.py", "error");
    return { status: "error", message: "server not connected" };
  }

  // v1.8.0: soft duplicate warning (does not block the forward)
  const dup = await findRecentDuplicate(url);
  if (dup) notifyDuplicateWarning(url, dup.timestamp);

  const config = await chrome.storage.local.get([
    "enabled",
    "program",
    "arguments",
    "concurrentLimit",
    "speedLimit",
    "forwardCookies",
    "customReferer",
    "customUserAgent",
    "proxyUrl",
  ]);

  // Capture cookies if the user has enabled cookie forwarding
  let cookieHeader = "";
  if (config.forwardCookies) {
    cookieHeader = await getCookieHeader(url);
  }

  // Build custom headers block
  const headers = {};
  if (config.customUserAgent && config.customUserAgent.trim()) {
    headers["User-Agent"] = config.customUserAgent.trim();
  }
  // Manual/context-menu/shortcut forwards don't have a source tab; fall back
  // to the user-configured custom Referer (if any).
  if (config.customReferer && config.customReferer.trim()) {
    headers["Referer"] = config.customReferer.trim();
  }

  // Manual forwarding should bypass the "enabled" toggle
  const payload = {
    url: url,
    filename: filename || extractFilenameFromUrl(url) || "download",
    program: config.program || "wget",
    arguments: config.arguments || "",
    speed_limit: config.speedLimit || 0,
    concurrent_limit: config.concurrentLimit || 5,
    manual: true,
    source: source,
    cookies: cookieHeader,
    headers: headers,
    proxy: (config.proxyUrl || "").trim(),
  };

  let result;
  try {
    result = await fetchJSON(LOCAL_SERVER + "/download", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    console.error("Failed to contact local server", e);
    notify("下载转发失败", "无法连接到本地服务器", "error");
    return { status: "error", message: String(e) };
  }

  if (result && result.status === "success") {
    bumpActive(1);
    notify(
      "下载已转发",
      `使用 ${config.program || "wget"} 下载: ${truncate(filename || url, 60)}`,
      "success"
    );
    await recordHistory({
      timestamp: new Date().toISOString(),
      url: url,
      filename: filename || extractFilenameFromUrl(url) || "download",
      program: config.program || "wget",
      status: "success",
      source: source,
    });
  } else {
    const msg = (result && result.message) || "未知错误";
    notify("下载转发失败", msg, "error");
    await recordHistory({
      timestamp: new Date().toISOString(),
      url: url,
      filename: filename || "",
      program: config.program || "wget",
      status: "error",
      message: msg,
      source: source,
    });
  }
  return result || { status: "error", message: "unknown" };
}

// --- v1.7.0: Batch forward ---
// Accepts an array of URL strings. Captures cookies/headers/proxy once (using
// the first URL's domain for cookie capture) and submits them all in a single
// POST /batch request to the local server.
async function forwardBatch(urls) {
  if (!Array.isArray(urls) || urls.length === 0) {
    return { status: "error", message: "URL 列表为空" };
  }
  // Normalize / dedupe while preserving order
  const cleaned = [];
  const seen = new Set();
  for (const raw of urls) {
    const u = String(raw || "").trim();
    if (!u) continue;
    if (seen.has(u)) continue;
    seen.add(u);
    cleaned.push(u);
  }
  if (cleaned.length === 0) {
    return { status: "error", message: "URL 列表为空" };
  }
  if (!serverConnected) {
    notify("批量转发失败", "本地服务器未运行，请先启动 server.py", "error");
    return { status: "error", message: "server not connected" };
  }

  // v1.8.0: consolidated duplicate warning for batch forwards
  if (warnDuplicates) {
    let dupCount = 0;
    for (const u of cleaned) {
      if (await findRecentDuplicate(u)) dupCount++;
    }
    if (dupCount > 0) {
      notify(
        "可能重复下载",
        `批量列表中有 ${dupCount} 个 URL 在最近 ${duplicateWarnMinutes} 分钟内已下载过`,
        "error"
      );
    }
  }

  const config = await chrome.storage.local.get([
    "program",
    "arguments",
    "concurrentLimit",
    "speedLimit",
    "forwardCookies",
    "customReferer",
    "customUserAgent",
    "proxyUrl",
  ]);

  // Capture cookies for the first URL's domain (best effort)
  let cookieHeader = "";
  if (config.forwardCookies) {
    cookieHeader = await getCookieHeader(cleaned[0]);
  }

  const headers = {};
  if (config.customUserAgent && config.customUserAgent.trim()) {
    headers["User-Agent"] = config.customUserAgent.trim();
  }
  if (config.customReferer && config.customReferer.trim()) {
    headers["Referer"] = config.customReferer.trim();
  } else {
    // Use the active tab URL as Referer for batch downloads
    const referer = await getRefererForActiveTab();
    if (referer) headers["Referer"] = referer;
  }

  const payload = {
    urls: cleaned,
    program: config.program || "wget",
    arguments: config.arguments || "",
    speed_limit: config.speedLimit || 0,
    concurrent_limit: config.concurrentLimit || 5,
    manual: true,
    source: "batch",
    cookies: cookieHeader,
    headers: headers,
    proxy: (config.proxyUrl || "").trim(),
  };

  let result;
  try {
    result = await fetchJSON(LOCAL_SERVER + "/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    console.error("Failed to contact local server (batch)", e);
    notify("批量转发失败", "无法连接到本地服务器", "error");
    return { status: "error", message: String(e) };
  }

  if (result && result.status === "ok") {
    const success = result.success || 0;
    const failed = result.failed || 0;
    bumpActive(success);
    if (failed === 0) {
      notify(
        "批量下载已转发",
        `成功提交 ${success} 个下载任务 (${config.program || "wget"})`,
        "success"
      );
    } else {
      notify(
        "批量下载部分完成",
        `成功 ${success} / 失败 ${failed} / 共 ${result.total}`,
        failed > 0 ? "error" : "success"
      );
    }
    return result;
  } else {
    const msg = (result && result.message) || "未知错误";
    notify("批量转发失败", msg, "error");
    return result || { status: "error", message: "unknown" };
  }
}

// Helper: get the URL of the currently active tab (for use as Referer).
async function getRefererForActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab && tab.url ? tab.url : "";
  } catch (e) {
    return "";
  }
}

// --- v1.7.0: File size pre-check ---
// Asks the local server to perform a HEAD/ranged-GET against the remote URL
// and return the detected file size, content type and final filename.
async function checkFileSize(url) {
  if (!url) return { status: "error", message: "URL is empty" };
  if (!serverConnected) {
    return { status: "error", message: "本地服务器未运行" };
  }
  try {
    const encoded = encodeURIComponent(url);
    const result = await fetchJSON(
      LOCAL_SERVER + "/check?url=" + encoded,
      { method: "GET" }
    );
    return result || { status: "error", message: "empty response" };
  } catch (e) {
    console.error("checkFileSize failed", e);
    return { status: "error", message: String(e) };
  }
}

// --- v1.7.0: Link sniffing ---
// Sends a "sniff-links" message to the active tab's content script and
// returns the collected list of downloadable links.
async function sniffCurrentPage() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || typeof tab.id !== "number") {
      return { status: "error", message: "未找到活动标签页", links: [] };
    }
    // chrome:// and edge:// pages cannot receive content scripts
    if (tab.url && /^(chrome|edge|about|moz-extension|chrome-extension):/i.test(tab.url)) {
      return { status: "error", message: "该页面无法嗅探（浏览器内置页面）", links: [] };
    }
    return await new Promise((resolve) => {
      chrome.tabs.sendMessage(
        tab.id,
        { type: "sniff-links", maxItems: 200 },
        (resp) => {
          if (chrome.runtime.lastError) {
            // Content script may not be injected (e.g. on a fresh page); fall
            // back to programmatic injection so sniffing still works.
            chrome.scripting.executeScript(
              {
                target: { tabId: tab.id },
                files: ["content.js"],
              },
              () => {
                if (chrome.runtime.lastError) {
                  resolve({
                    status: "error",
                    message: chrome.runtime.lastError.message || "注入脚本失败",
                    links: [],
                  });
                  return;
                }
                chrome.tabs.sendMessage(
                  tab.id,
                  { type: "sniff-links", maxItems: 200 },
                  (resp2) => {
                    if (chrome.runtime.lastError) {
                      resolve({
                        status: "error",
                        message: chrome.runtime.lastError.message,
                        links: [],
                      });
                      return;
                    }
                    resolve(resp2 || { status: "error", message: "无响应", links: [] });
                  }
                );
              }
            );
            return;
          }
          resolve(resp || { status: "error", message: "无响应", links: [] });
        }
      );
    });
  } catch (e) {
    console.error("sniffCurrentPage failed", e);
    return { status: "error", message: String(e), links: [] };
  }
}

// --- Download interception ---
chrome.downloads.onCreated.addListener(async (downloadItem) => {
  try {
    const config = await chrome.storage.local.get([
      "enabled",
      "program",
      "arguments",
      "filetypeFilterEnabled",
      "filetypeFilter",
      "blacklistEnabled",
      "urlBlacklist",
      "whitelistEnabled",
      "urlWhitelist",
      "concurrentLimit",
      "speedLimit",
      "forwardCookies",
      "customReferer",
      "customUserAgent",
      "proxyUrl",
    ]);

    if (!config.enabled || !serverConnected) {
      return;
    }

    // Only intercept downloads that look like real files (skip blob/internal)
    const url = downloadItem.url || "";
    if (!url || url.startsWith("blob:") || url.startsWith("data:")) {
      return;
    }

    // File type filter check
    if (config.filetypeFilterEnabled && config.filetypeFilter) {
      const filename =
        downloadItem.filename || extractFilenameFromUrl(url) || "";
      const ext = filename.split('.').pop()?.toLowerCase() || "";
      const allowedTypes = config.filetypeFilter
        .split(',')
        .map((t) => t.trim().toLowerCase())
        .filter((t) => t);
      if (allowedTypes.length > 0 && !allowedTypes.includes(ext)) {
        console.log(`Skipping download: file type .${ext} not in filter list`);
        return;
      }
    }

    // URL whitelist check (only intercept whitelisted sites when enabled)
    if (config.whitelistEnabled && config.urlWhitelist) {
      const whitelistLines = config.urlWhitelist
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l);
      if (whitelistLines.length > 0) {
        let allowed = false;
        for (const pattern of whitelistLines) {
          try {
            if (new RegExp(pattern, 'i').test(url)) {
              allowed = true;
              break;
            }
          } catch (e) {
            console.warn(`Invalid regex in whitelist: ${pattern}`);
          }
        }
        if (!allowed) {
          console.log("Skipping download: URL not in whitelist");
          return;
        }
      }
    }

    // URL blacklist check
    if (config.blacklistEnabled && config.urlBlacklist) {
      const blacklistLines = config.urlBlacklist
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l);
      for (const pattern of blacklistLines) {
        try {
          const regex = new RegExp(pattern, 'i');
          if (regex.test(url)) {
            console.log(`Skipping download: URL matches blacklist pattern: ${pattern}`);
            return;
          }
        } catch (e) {
          console.warn(`Invalid regex pattern in blacklist: ${pattern}`);
        }
      }
    }

    const filename =
      downloadItem.filename ||
      extractFilenameFromUrl(url) ||
      "download";

    // v1.8.0: soft duplicate warning for auto-intercepted downloads
    const dup = await findRecentDuplicate(url);
    if (dup) notifyDuplicateWarning(url, dup.timestamp);

    // Capture cookies for the download URL when enabled
    let cookieHeader = "";
    if (config.forwardCookies) {
      cookieHeader = await getCookieHeader(url);
    }

    // Build custom headers block. For auto-interception use the source tab's
    // URL as Referer when no explicit custom Referer is configured.
    const headers = {};
    if (config.customUserAgent && config.customUserAgent.trim()) {
      headers["User-Agent"] = config.customUserAgent.trim();
    }
    const referer =
      (config.customReferer && config.customReferer.trim()) ||
      (await getReferer(downloadItem.tabId));
    if (referer) {
      headers["Referer"] = referer;
    }

    const payload = {
      url: url,
      filename: filename,
      program: config.program || "wget",
      arguments: config.arguments || "",
      speed_limit: config.speedLimit || 0,
      concurrent_limit: config.concurrentLimit || 5,
      source: "auto",
      cookies: cookieHeader,
      headers: headers,
      proxy: (config.proxyUrl || "").trim(),
    };

    let result;
    try {
      result = await fetchJSON(LOCAL_SERVER + "/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (networkErr) {
      console.error("Failed to contact local server", networkErr);
      notify(
        "下载转发失败",
        "无法连接到本地服务器。请确认 server.py 是否启动。",
        "error"
      );
      return;
    }

    if (result && result.status === "success") {
      // Cancel the browser-managed download
      try {
        chrome.downloads.cancel(downloadItem.id, () => {
          /* ignore errors */
        });
      } catch (e) {
        console.warn("cancel failed", e);
      }
      bumpActive(1);
      notify(
        "下载已转发",
        `使用 ${config.program || "wget"} 下载中: ${truncate(filename, 60)}`,
        "success"
      );
      await recordHistory({
        timestamp: new Date().toISOString(),
        url: url,
        filename: filename,
        program: config.program || "wget",
        status: "success",
        source: "auto",
      });
    } else {
      const msg = (result && result.message) || "未知错误";
      console.error("Server returned error:", msg);
      notify("下载转发失败", msg, "error");
      await recordHistory({
        timestamp: new Date().toISOString(),
        url: url,
        filename: filename,
        program: config.program || "wget",
        status: "error",
        message: msg,
        source: "auto",
      });
    }
  } catch (error) {
    console.error("Error forwarding download:", error);
  }
});

// --- Lightweight in-extension history (also server side records) ---
// Serialize get-modify-set operations to avoid losing concurrent entries.
let _historyQueue = Promise.resolve();
function recordHistory(entry) {
  _historyQueue = _historyQueue.then(async () => {
    const data = await chrome.storage.local.get(["recentDownloads"]);
    const history = data.recentDownloads || [];
    history.unshift(entry);
    while (history.length > 50) history.pop();
    await chrome.storage.local.set({ recentDownloads: history });
  }).catch((e) => {
    console.warn("recordHistory failed", e);
  });
  return _historyQueue;
}

function extractFilenameFromUrl(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/");
    return parts[parts.length - 1] || "";
  } catch (e) {
    return "";
  }
}

function truncate(str, n) {
  if (!str) return "";
  return str.length > n ? str.slice(0, n - 1) + "\u2026" : str;
}

// --- Update Checker ---
// Checks GitHub for the latest release/tag and notifies the user when a newer
// version is available. Runs on install/update and every 24 hours via alarm.
const GITHUB_REPO = "diaoyunxi/download-forwarder";
const UPDATE_ALARM = "df-update-check";

// Create the periodic update-check alarm (every 24 hours).
chrome.alarms.create(UPDATE_ALARM, { periodInMinutes: 1440 });

// Trigger an update check immediately when the extension is installed/updated.
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install" || details.reason === "update") {
    checkForUpdate();
  }
});

function compareVersions(v1, v2) {
  const a = v1.replace(/^v/, "").split(".");
  const b = v2.replace(/^v/, "").split(".");
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const na = parseInt(a[i] || 0, 10);
    const nb = parseInt(b[i] || 0, 10);
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

async function checkForUpdate() {
  try {
    const manifest = chrome.runtime.getManifest();
    const currentVersion = manifest.version;

    // Try Releases API first
    let latestVersion = null;
    let releaseUrl = null;
    try {
      const resp = await fetch(
        `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
        {
          signal: AbortSignal.timeout(10000),
        }
      );
      if (resp.ok) {
        const data = await resp.json();
        latestVersion = data.tag_name;
        releaseUrl = data.html_url;
      }
    } catch (e) {
      console.warn("Update check: Releases API failed", e);
    }

    // Fallback to Tags API
    if (!latestVersion) {
      try {
        const resp = await fetch(
          `https://api.github.com/repos/${GITHUB_REPO}/tags`,
          {
            signal: AbortSignal.timeout(10000),
          }
        );
        if (resp.ok) {
          const data = await resp.json();
          if (data && data.length > 0) {
            latestVersion = data[0].name;
            releaseUrl = `https://github.com/${GITHUB_REPO}/releases/tag/${latestVersion}`;
          }
        }
      } catch (e) {
        console.warn("Update check: Tags API failed", e);
      }
    }

    if (!latestVersion) {
      console.log("Update check: could not determine latest version");
      return;
    }

    if (compareVersions(latestVersion, currentVersion) > 0) {
      const notificationId = `update-available-${Date.now()}`;
      chrome.notifications.create(notificationId, {
        type: "basic",
        iconUrl: "icons/icon128.png",
        title: "发现新版本",
        message: `当前版本 v${currentVersion}，最新版本 ${latestVersion}\n点击此处前往更新`,
        priority: 2,
      });

      // Store release URL for click handler
      chrome.storage.local.set({
        [`updateUrl_${notificationId}`]: releaseUrl,
      });
    } else {
      console.log(
        `Update check: current version v${currentVersion} is up to date`
      );
    }
  } catch (e) {
    console.warn("Update check failed", e);
  }
}

// Handle notification click - open release page in a new tab
chrome.notifications.onClicked.addListener((notificationId) => {
  if (notificationId.startsWith("update-available-")) {
    chrome.storage.local.get([`updateUrl_${notificationId}`], (result) => {
      const url = result[`updateUrl_${notificationId}`];
      if (url) {
        chrome.tabs.create({ url: url });
      }
      chrome.notifications.clear(notificationId);
    });
  }
});
