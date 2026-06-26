// Download Forwarder - Background Service Worker
// Handles download interception, server communication, notifications and state

const LOCAL_SERVER = "http://127.0.0.1:18735";
const PING_INTERVAL = 15000;

let serverConnected = false;
let serverInfo = null;
let recentDownloads = [];

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
  }
}

// Periodic connectivity check
checkConnection();
setInterval(checkConnection, PING_INTERVAL);

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
      const filename = downloadItem.filename || extractFilenameFromUrl(url) || "";
      const ext = filename.split('.').pop()?.toLowerCase() || "";
      const allowedTypes = config.filetypeFilter.split(',').map(t => t.trim().toLowerCase()).filter(t => t);
      if (allowedTypes.length > 0 && !allowedTypes.includes(ext)) {
        console.log(`Skipping download: file type .${ext} not in filter list`);
        return;
      }
    }

    // URL blacklist check
    if (config.blacklistEnabled && config.urlBlacklist) {
      const blacklistLines = config.urlBlacklist.split('\n').map(l => l.trim()).filter(l => l);
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
      });
    }
  } catch (error) {
    console.error("Error forwarding download:", error);
  }
});

// --- Lightweight in-extension history (also server side records) ---
async function recordHistory(entry) {
  const data = await chrome.storage.local.get(["recentDownloads"]);
  const history = data.recentDownloads || [];
  history.unshift(entry);
  while (history.length > 50) history.pop();
  chrome.storage.local.set({ recentDownloads: history });
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
