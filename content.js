// Download Forwarder - Content Script
// v1.7.0: Link sniffing. Scans the current page for downloadable links and
// reports them back to the popup / background script on demand.

(function () {
  "use strict";

  // A broad list of extensions that almost always indicate a direct file
  // download. Used to score candidate links. The list is intentionally not
  // exhaustive — links are also captured when they carry a `download`
  // attribute or point to common download endpoints.
  var DOWNLOAD_EXTENSIONS = [
    // Archives
    "zip", "rar", "7z", "tar", "gz", "bz2", "xz", "iso", "cab",
    // Documents
    "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "md", "csv", "epub", "mobi",
    // Audio
    "mp3", "flac", "wav", "aac", "ogg", "m4a", "wma",
    // Video
    "mp4", "mkv", "avi", "mov", "wmv", "flv", "webm", "m4v", "mpg", "mpeg", "ts",
    // Images
    "jpg", "jpeg", "png", "gif", "bmp", "webp", "svg", "tiff", "ico", "psd",
    // Software / packages
    "exe", "msi", "dmg", "pkg", "deb", "rpm", "appimage", "apk", "jar", "war",
    // Code / data
    "json", "xml", "yaml", "yml", "sql", "db", "sqlite",
    // Misc
    "torrent", "bin"
  ];

  var DOWNLOAD_EXT_SET = {};
  for (var i = 0; i < DOWNLOAD_EXTENSIONS.length; i++) {
    DOWNLOAD_EXT_SET[DOWNLOAD_EXTENSIONS[i]] = true;
  }

  // Substrings that suggest a URL is a download endpoint even without a
  // recognizable file extension (e.g. signed CDN URLs).
  var DOWNLOAD_PATH_HINTS = [
    "/download/", "/downloads/", "/file/", "/files/",
    "/attachment", "/attachments/", "/get/", "/fetch/",
    "dl=", "download=", "file=", "attachmentid="
  ];

  function getExtension(name) {
    if (!name) return "";
    var idx = name.lastIndexOf(".");
    if (idx < 0) return "";
    return name.substring(idx + 1).toLowerCase().split(/[?#]/)[0];
  }

  function isProbablyDownloadable(url, hasDownloadAttr) {
    if (!url) return false;
    if (hasDownloadAttr) return true;
    try {
      var u = new URL(url, window.location.href);
      if (u.protocol !== "http:" && u.protocol !== "https:" && u.protocol !== "ftp:") {
        return false;
      }
      var path = u.pathname || "";
      var filePart = path.substring(path.lastIndexOf("/") + 1);
      var ext = getExtension(filePart);
      if (ext && DOWNLOAD_EXT_SET[ext]) {
        return true;
      }
      // Check for download-path hints
      var lower = (path + "?" + (u.search || "")).toLowerCase();
      for (var i = 0; i < DOWNLOAD_PATH_HINTS.length; i++) {
        if (lower.indexOf(DOWNLOAD_PATH_HINTS[i]) !== -1) {
          return true;
        }
      }
      return false;
    } catch (e) {
      return false;
    }
  }

  function collectLinks(maxItems) {
    maxItems = maxItems || 200;
    var results = [];
    var seen = {};
    var origin = window.location.href;

    // <a href> links
    var anchors = document.querySelectorAll("a[href]");
    for (var i = 0; i < anchors.length && results.length < maxItems; i++) {
      var a = anchors[i];
      var href = a.href || a.getAttribute("href") || "";
      if (!href) continue;
      var downloadAttr = a.hasAttribute("download");
      if (!isProbablyDownloadable(href, downloadAttr)) continue;
      var key = href;
      if (seen[key]) continue;
      seen[key] = true;
      // Build a human-friendly label from link text / title / filename
      var text = (a.textContent || "").trim();
      var title = a.getAttribute("title") || "";
      var label = text || title || "";
      results.push({
        url: href,
        label: label,
        filename: filenameFromUrl(href) || label,
        download_attr: downloadAttr
      });
    }

    // <img src>, <source src>, <video src>, <audio src>, <embed>, <iframe>
    var mediaSelectors = ["img[src]", "video[src]", "audio[src]", "source[src]", "embed[src]"];
    for (var s = 0; s < mediaSelectors.length; s++) {
      var elems = document.querySelectorAll(mediaSelectors[s]);
      for (var j = 0; j < elems.length && results.length < maxItems; j++) {
        var el = elems[j];
        var src = el.src || el.getAttribute("src") || "";
        if (!src) continue;
        if (!isProbablyDownloadable(src, false)) continue;
        if (seen[src]) continue;
        seen[src] = true;
        var alt = el.getAttribute("alt") || el.getAttribute("title") || "";
        results.push({
          url: src,
          label: alt,
          filename: filenameFromUrl(src) || alt,
          download_attr: false
        });
      }
    }

    return { origin: origin, links: results, count: results.length };
  }

  function filenameFromUrl(url) {
    try {
      var u = new URL(url, window.location.href);
      var path = u.pathname || "";
      var filePart = path.substring(path.lastIndexOf("/") + 1);
      try {
        return decodeURIComponent(filePart);
      } catch (e) {
        return filePart;
      }
    } catch (e) {
      return "";
    }
  }

  // Listen for sniff requests from popup/background
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (msg && msg.type === "sniff-links") {
      try {
        var data = collectLinks(msg.maxItems || 200);
        sendResponse({ status: "ok", origin: data.origin, links: data.links, count: data.count });
      } catch (e) {
        sendResponse({ status: "error", message: String(e), links: [], count: 0 });
      }
      return true;
    }
  });
})();
