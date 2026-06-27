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

// --- Helpers ---
function notify(title, message, silent) {
  try {
    chrome.notifications.create(
      String(Date.now() + Math.random()),
      {
        type: "basic",
        iconUrl: "icons/icon128.png",
        title: title,
        message: message,
        silent: !!silent,
        priority: 0,
      },
      () => {
        /* ignore errors */
      }
    );
  } catch (e) {
    console.error("notify error", e);
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
    true
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
});

// --- Common forward logic (used by context menu, shortcut, manual) ---
async function forwardUrl(url, filename, source) {
  if (!url) return { status: "error", message: "URL is empty" };
  if (!serverConnected) {
    notify("下载转发失败", "本地服务器未运行，请先启动 server.py");
    return { status: "error", message: "server not connected" };
  }

  const config = await chrome.storage.local.get([
    "enabled",
    "program",
    "arguments",
    "concurrentLimit",
    "speedLimit",
  ]);

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
    notify("下载转发失败", "无法连接到本地服务器");
    return { status: "error", message: String(e) };
  }

  if (result && result.status === "success") {
    bumpActive(1);
    notify(
      "下载已转发",
      `使用 ${config.program || "wget"} 下载: ${truncate(filename || url, 60)}`
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
    notify("下载转发失败", msg);
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

    const payload = {
      url: url,
      filename: filename,
      program: config.program || "wget",
      arguments: config.arguments || "",
      speed_limit: config.speedLimit || 0,
      concurrent_limit: config.concurrentLimit || 5,
      source: "auto",
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
        "无法连接到本地服务器。请确认 server.py 是否启动。"
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
        `使用 ${config.program || "wget"} 下载中: ${truncate(filename, 60)}`
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
      notify("下载转发失败", msg);
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
