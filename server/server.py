#!/usr/bin/env python3
"""
Download Forwarder Local Server
Listens on a fixed port and receives download requests from the browser extension.
Forwards downloads to external download managers (wget, curl, NDM, IDM, Gopeed).

Enhanced with:
- CORS support for browser extension communication
- Download history tracking
- Available program detection
- Download directory configuration
- Proper logging
- Security: bind to localhost only
"""

import json
import os
import platform
import subprocess
import sys
import threading
import time
import datetime
import shutil
import re
import http.client
from http.server import HTTPServer, BaseHTTPRequestHandler

# === Configuration ===
PORT = 18735
VERSION = "1.8.0"
DEFAULT_PROGRAMS = ["wget", "curl", "idm", "ndm", "gopeed", "ffmpeg"]
CONFIG_DIR = os.path.join(os.path.expanduser("~"), ".download_forwarder")
CONFIG_FILE = os.path.join(CONFIG_DIR, "config.json")
HISTORY_FILE = os.path.join(CONFIG_DIR, "history.json")
LOG_FILE = os.path.join(CONFIG_DIR, "server.log")
MAX_HISTORY = 100

# v1.7.0: default category rules used by auto-categorize. Each rule maps a
# list of extensions (lowercase, no leading dot) to a subfolder name. The
# rules can be fully overridden from the config file / popup UI.
DEFAULT_CATEGORY_RULES = [
    {"name": "Documents", "extensions": ["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "md", "csv", "epub"]},
    {"name": "Archives", "extensions": ["zip", "rar", "7z", "tar", "gz", "bz2", "xz", "iso"]},
    {"name": "Video", "extensions": ["mp4", "mkv", "avi", "mov", "wmv", "flv", "webm", "m4v", "mpg", "mpeg"]},
    {"name": "Audio", "extensions": ["mp3", "flac", "wav", "aac", "ogg", "m4a", "wma"]},
    {"name": "Images", "extensions": ["jpg", "jpeg", "png", "gif", "bmp", "webp", "svg", "tiff", "ico"]},
    {"name": "Software", "extensions": ["exe", "msi", "dmg", "pkg", "deb", "rpm", "appimage", "apk"]},
]

# Thread-safe history store
_history_lock = threading.Lock()
_config_lock = threading.Lock()

# Active downloads tracking
_active_downloads = 0
_active_downloads_lock = threading.Lock()


def _ensure_config_dir():
    os.makedirs(CONFIG_DIR, exist_ok=True)


def load_config():
    _ensure_config_dir()
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
        except (json.JSONDecodeError, OSError):
            data = {}
    else:
        data = {}
    data.setdefault("download_dir", os.path.join(os.path.expanduser("~"), "Downloads"))
    data.setdefault("program", "wget")
    data.setdefault("arguments", "")
    data.setdefault("max_history", MAX_HISTORY)
    data.setdefault("max_retries", 3)
    data.setdefault("url_rules", [])
    data.setdefault("filetype_filter_enabled", False)
    data.setdefault("filetype_filter", "")
    data.setdefault("blacklist_enabled", False)
    data.setdefault("url_blacklist", "")
    data.setdefault("whitelist_enabled", False)
    data.setdefault("url_whitelist", "")
    data.setdefault("concurrent_limit", 5)
    data.setdefault("speed_limit", 0)
    # v1.6.0
    data.setdefault("custom_referer", "")
    data.setdefault("custom_user_agent", "")
    data.setdefault("proxy_url", "")
    data.setdefault("forward_cookies", False)
    # v1.7.0
    data.setdefault("categorize_enabled", False)
    data.setdefault("category_rules", list(DEFAULT_CATEGORY_RULES))
    # v1.8.0: when True, stream URLs (.m3u8/.m3u/.mpd) are automatically routed
    # to ffmpeg if it is installed, regardless of the chosen default program.
    data.setdefault("auto_ffmpeg_streams", True)
    return data


def save_config(data):
    _ensure_config_dir()
    with _config_lock:
        try:
            with open(CONFIG_FILE, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
        except OSError:
            pass


def load_history():
    _ensure_config_dir()
    if not os.path.exists(HISTORY_FILE):
        return []
    try:
        with open(HISTORY_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return []


def append_history(entry):
    _ensure_config_dir()
    with _history_lock:
        history = load_history()
        history.insert(0, entry)
        cfg = load_config()
        max_items = cfg.get("max_history", MAX_HISTORY)
        history = history[:max_items]
        try:
            with open(HISTORY_FILE, "w", encoding="utf-8") as f:
                json.dump(history, f, ensure_ascii=False, indent=2)
        except OSError:
            pass


def log_message(level, message):
    _ensure_config_dir()
    timestamp = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{timestamp}] [{level}] {message}\n"
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line)
    except OSError:
        pass
    print(line.rstrip())


def detect_available_programs():
    available = []
    for prog in DEFAULT_PROGRAMS:
        if shutil.which(prog):
            available.append(prog)
    # Windows-specific detection
    if platform.system() == "Windows":
        idm_path = r"C:\Program Files (x86)\Internet Download Manager\IDMan.exe"
        if os.path.exists(idm_path):
            available.append("idm")
        # Try common NDM paths
        for ndm_path in [
            r"C:\Program Files (x86)\Neat Download Manager\ndm.exe",
            r"C:\Program Files\Neat Download Manager\ndm.exe",
        ]:
            if os.path.exists(ndm_path):
                available.append("ndm")
                break
    # Deduplicate while preserving order
    seen = set()
    unique = []
    for p in available:
        if p not in seen:
            seen.add(p)
            unique.append(p)
    return unique


def sanitize_filename(filename):
    if not filename:
        return ""
    # Remove path separators and other dangerous characters
    sanitized = re.sub(r'[\\/:*?"<>|]', "_", filename)
    return sanitized.strip()


def get_filename_from_url(url):
    try:
        from urllib.parse import urlparse
        path = urlparse(url).path
        name = os.path.basename(path)
        return sanitize_filename(name) or "download"
    except Exception:
        return "download"


def match_url_rule(url, rules):
    """Match URL against configured rules to determine program"""
    if not rules:
        return None
    for rule in rules:
        pattern = rule.get("pattern", "")
        program = rule.get("program", "")
        if pattern and program:
            try:
                if re.search(pattern, url, re.IGNORECASE):
                    return program
            except re.error:
                continue
    return None


def categorize_filename(filename, rules):
    """v1.7.0: return a subfolder name for the given filename based on its
    extension, or "" when no rule matches / categorize is disabled.
    `rules` is the list of {"name": str, "extensions": [str, ...]} entries.
    """
    if not filename or not rules:
        return ""
    # Extract extension (lowercase, no leading dot)
    if "." not in filename:
        return ""
    ext = filename.rsplit(".", 1)[-1].lower().strip()
    if not ext:
        return ""
    for rule in rules:
        exts = rule.get("extensions") or []
        name = (rule.get("name") or "").strip()
        if name and ext in [e.lower().lstrip(".") for e in exts]:
            return sanitize_filename(name)
    return ""


def human_readable_size(num_bytes):
    """Format a byte count into a human-readable string."""
    try:
        n = float(num_bytes)
    except (TypeError, ValueError):
        return ""
    if n < 0:
        return ""
    for unit in ["B", "KB", "MB", "GB", "TB"]:
        if n < 1024.0 or unit == "TB":
            if unit == "B":
                return f"{int(n)} B"
            return f"{n:.2f} {unit}"
        n /= 1024.0
    return f"{n:.2f} TB"


def is_stream_url(url):
    """v1.8.0: detect HLS / DASH / manifest URLs that ffmpeg handles best.

    Returns True for .m3u8 / .m3u / .mpd URLs (ignoring query strings / fragments).
    """
    if not url:
        return False
    try:
        from urllib.parse import urlparse
        path = urlparse(url).path.lower()
    except Exception:
        path = url.lower()
    # Strip fragment / query already done by urlparse; just check suffix
    for ext in (".m3u8", ".m3u", ".mpd"):
        if path.endswith(ext):
            return True
    return False


class DownloadHandler(BaseHTTPRequestHandler):
    def _send_cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def do_OPTIONS(self):
        self.send_response(204)
        self._send_cors_headers()
        self.end_headers()

    def _send_json(self, payload, status=200):
        """Helper: send a JSON response with CORS headers."""
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self._send_cors_headers()
        self.end_headers()
        self.wfile.write(json.dumps(payload, ensure_ascii=False).encode("utf-8"))

    def do_GET(self):
        """Health check, info, history, config endpoints"""
        if self.path == "/ping" or self.path.startswith("/ping?"):
            self._send_json({
                "status": "ok",
                "message": "Download Forwarder server is running",
                "version": VERSION,
                "platform": platform.system(),
                "available_programs": detect_available_programs(),
            })
        elif self.path == "/history" or self.path.startswith("/history?"):
            self._send_json({
                "status": "ok",
                "history": load_history(),
            })
        elif self.path == "/config" or self.path.startswith("/config?"):
            cfg = load_config()
            cfg["status"] = "ok"
            cfg["available_programs"] = detect_available_programs()
            self._send_json(cfg)
        elif self.path == "/logs" or self.path.startswith("/logs?"):
            from urllib.parse import urlparse, parse_qs
            params = parse_qs(urlparse(self.path).query)
            try:
                limit = int((params.get("limit") or ["50"])[0])
            except (TypeError, ValueError):
                limit = 50
            limit = max(1, min(limit, 500))
            logs = []
            if os.path.exists(LOG_FILE):
                try:
                    with open(LOG_FILE, "r", encoding="utf-8", errors="replace") as f:
                        lines = f.readlines()
                        logs = lines[-limit:]
                except OSError:
                    pass
            self._send_json({"status": "ok", "logs": logs, "count": len(logs)})
        elif self.path.startswith("/export"):
            self._handle_export()
        elif self.path.startswith("/stats"):
            self._handle_stats()
        elif self.path.startswith("/check"):
            self._handle_check()
        else:
            self._send_json({"status": "error", "message": "Not found"}, status=404)

    def do_POST(self):
        """Receive download / config update / history clear requests"""
        # Routes that don't require a JSON body
        if self.path.startswith("/config/reset") or self.path.startswith("/history/clear"):
            if self.path.startswith("/config/reset"):
                self._handle_config_reset()
            else:
                self._handle_history_clear()
            return

        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length)

        try:
            data = json.loads(body.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            self._send_error("Invalid JSON", 400)
            return

        if self.path.startswith("/download"):
            self._handle_download(data)
        elif self.path.startswith("/batch"):
            self._handle_batch(data)
        elif self.path.startswith("/config"):
            self._handle_config_update(data)
        else:
            self._send_error("Not found", 404)

    def _handle_download(self, data):
        url = (data.get("url") or "").strip()
        program = (data.get("program") or "wget").strip().lower()
        args = (data.get("arguments") or "").strip()
        filename = sanitize_filename(data.get("filename") or "")
        speed_limit = data.get("speed_limit", 0)
        is_manual = bool(data.get("manual", False))
        source = (data.get("source") or ("manual" if is_manual else "auto")).strip()
        # v1.6.0: cookie / header / proxy forwarding (supplied by the extension).
        cookies = (data.get("cookies") or "").strip()
        headers = data.get("headers") if isinstance(data.get("headers"), dict) else {}
        proxy = (data.get("proxy") or "").strip()

        if not url:
            log_message("ERROR", "Download request missing URL")
            self._send_error("Missing URL", 400)
            return

        cfg = load_config()
        download_dir = cfg.get("download_dir") or os.path.join(os.path.expanduser("~"), "Downloads")
        max_retries = cfg.get("max_retries", 3)
        url_rules = cfg.get("url_rules", [])
        # Honor client-supplied concurrent_limit if present (extension sends its UI value),
        # otherwise fall back to the server-side configured limit.
        try:
            client_concurrent = int(data.get("concurrent_limit", 0))
        except (TypeError, ValueError):
            client_concurrent = 0
        concurrent_limit = client_concurrent or cfg.get("concurrent_limit", 5)
        speed_limit = speed_limit or cfg.get("speed_limit", 0)

        # v1.6.0: fall back to server-side proxy / custom headers when the
        # request did not already include them (e.g. direct API callers).
        if not proxy and cfg.get("proxy_url"):
            proxy = str(cfg.get("proxy_url") or "").strip()
        if not headers.get("Referer") and not headers.get("referer"):
            srv_ref = str(cfg.get("custom_referer") or "").strip()
            if srv_ref:
                headers["Referer"] = srv_ref
        if not headers.get("User-Agent") and not headers.get("user-agent"):
            srv_ua = str(cfg.get("custom_user_agent") or "").strip()
            if srv_ua:
                headers["User-Agent"] = srv_ua

        # Server-side filter enforcement (auto downloads only;
        # manual/context-menu/shortcut bypass these so users can always force a download)
        if not is_manual and source == "auto":
            # Filetype filter
            if cfg.get("filetype_filter_enabled") and cfg.get("filetype_filter"):
                allowed_exts = [
                    e.strip().lower()
                    for e in cfg["filetype_filter"].split(",")
                    if e.strip()
                ]
                candidate_name = filename or get_filename_from_url(url)
                ext = (
                    candidate_name.rsplit(".", 1)[-1].lower()
                    if "." in candidate_name
                    else ""
                )
                if allowed_exts and ext not in allowed_exts:
                    log_message("INFO", f"Skipped (filetype filter): .{ext} not in {allowed_exts}")
                    self._send_error(f"File type .{ext} not allowed by filter", 403)
                    return

            # Whitelist (only intercept these)
            if cfg.get("whitelist_enabled") and cfg.get("url_whitelist"):
                patterns = [
                    p.strip()
                    for p in cfg["url_whitelist"].splitlines()
                    if p.strip()
                ]
                if patterns:
                    allowed = False
                    for pat in patterns:
                        try:
                            if re.search(pat, url, re.IGNORECASE):
                                allowed = True
                                break
                        except re.error:
                            continue
                    if not allowed:
                        log_message("INFO", f"Skipped (whitelist): {url}")
                        self._send_error("URL not in whitelist", 403)
                        return

            # Blacklist (never intercept these)
            if cfg.get("blacklist_enabled") and cfg.get("url_blacklist"):
                patterns = [
                    p.strip()
                    for p in cfg["url_blacklist"].splitlines()
                    if p.strip()
                ]
                for pat in patterns:
                    try:
                        if re.search(pat, url, re.IGNORECASE):
                            log_message("INFO", f"Skipped (blacklist): {url}")
                            self._send_error("URL matches blacklist", 403)
                            return
                    except re.error:
                        continue

        # Check concurrent download limit
        active_downloads = self._count_active_downloads()
        if active_downloads >= concurrent_limit:
            log_message("WARNING", f"Concurrent download limit reached ({active_downloads}/{concurrent_limit})")
            self._send_error(f"Concurrent download limit reached ({active_downloads}/{concurrent_limit})", 429)
            return

        # Apply URL rules to auto-select program
        matched_program = match_url_rule(url, url_rules)
        if matched_program:
            program = matched_program
            log_message("INFO", f"URL rule matched, using {program}")

        # v1.8.0: auto-route HLS/DASH stream URLs to ffmpeg when enabled and
        # ffmpeg is installed (wget/curl cannot natively concatenate segments).
        if cfg.get("auto_ffmpeg_streams", True) and is_stream_url(url) and program != "ffmpeg":
            avail = detect_available_programs()
            if "ffmpeg" in avail:
                log_message("INFO", f"Stream URL detected, switching {program} -> ffmpeg")
                program = "ffmpeg"

        # v1.7.0: auto-categorize into a subfolder based on file extension
        effective_dir = download_dir
        category_subfolder = ""
        if cfg.get("categorize_enabled") and cfg.get("category_rules"):
            candidate_name = filename or get_filename_from_url(url)
            category_subfolder = categorize_filename(candidate_name, cfg.get("category_rules"))
            if category_subfolder:
                effective_dir = os.path.join(download_dir, category_subfolder)

        try:
            os.makedirs(effective_dir, exist_ok=True)
        except OSError as e:
            log_message("ERROR", f"Failed to create download directory: {e}")
            self._send_error(f"Cannot create directory: {e}", 500)
            return

        # Retry logic
        result = None
        attempt = 0
        for attempt in range(max_retries + 1):
            result = self._start_download(
                url, program, args, filename, effective_dir,
                speed_limit, cookies=cookies, headers=headers, proxy=proxy,
            )
            if result.get("status") == "success":
                self._register_download()
                break
            if attempt < max_retries:
                log_message("WARNING", f"Download attempt {attempt + 1} failed, retrying...")
                time.sleep(1)  # Wait 1 second before retry
            else:
                log_message("ERROR", f"All {max_retries + 1} attempts failed")

        entry = {
            "timestamp": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "url": url,
            "program": program,
            "filename": filename or get_filename_from_url(url),
            "status": result.get("status"),
            "message": result.get("message", ""),
            "retries": attempt if result.get("status") != "success" else 0,
            "source": source,
            "category": category_subfolder,
        }

        if result.get("status") == "success":
            append_history(entry)
            log_message("INFO", f"Started download via {program}: {url}")
        else:
            entry["status"] = "error"
            append_history(entry)
            log_message("ERROR", f"Download failed after {attempt + 1} attempts ({program}): {result.get('message')}")

        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self._send_cors_headers()
        self.end_headers()
        self.wfile.write(json.dumps(result, ensure_ascii=False).encode("utf-8"))

    def _handle_config_update(self, data):
        cfg = load_config()
        if "download_dir" in data and data["download_dir"]:
            cfg["download_dir"] = data["download_dir"]
        if "program" in data:
            cfg["program"] = data["program"]
        if "arguments" in data:
            cfg["arguments"] = data["arguments"]
        if "max_history" in data:
            try:
                cfg["max_history"] = int(data["max_history"])
            except (TypeError, ValueError):
                pass
        if "filetype_filter_enabled" in data:
            cfg["filetype_filter_enabled"] = bool(data["filetype_filter_enabled"])
        if "filetype_filter" in data:
            cfg["filetype_filter"] = str(data["filetype_filter"])
        if "blacklist_enabled" in data:
            cfg["blacklist_enabled"] = bool(data["blacklist_enabled"])
        if "url_blacklist" in data:
            cfg["url_blacklist"] = str(data["url_blacklist"])
        if "whitelist_enabled" in data:
            cfg["whitelist_enabled"] = bool(data["whitelist_enabled"])
        if "url_whitelist" in data:
            cfg["url_whitelist"] = str(data["url_whitelist"])
        if "concurrent_limit" in data:
            try:
                cfg["concurrent_limit"] = int(data["concurrent_limit"])
            except (TypeError, ValueError):
                pass
        if "speed_limit" in data:
            try:
                cfg["speed_limit"] = int(data["speed_limit"])
            except (TypeError, ValueError):
                pass
        # v1.6.0: URL rules / custom headers / proxy / cookie forwarding
        if "url_rules" in data:
            rules = data["url_rules"]
            if isinstance(rules, list):
                cfg["url_rules"] = [
                    {
                        "pattern": str(r.get("pattern", "")),
                        "program": str(r.get("program", "wget")),
                    }
                    for r in rules
                    if isinstance(r, dict) and r.get("pattern")
                ]
        if "custom_referer" in data:
            cfg["custom_referer"] = str(data["custom_referer"])
        if "custom_user_agent" in data:
            cfg["custom_user_agent"] = str(data["custom_user_agent"])
        if "proxy_url" in data:
            cfg["proxy_url"] = str(data["proxy_url"])
        if "forward_cookies" in data:
            cfg["forward_cookies"] = bool(data["forward_cookies"])
        # v1.7.0: auto-categorize
        if "categorize_enabled" in data:
            cfg["categorize_enabled"] = bool(data["categorize_enabled"])
        # v1.8.0: auto ffmpeg for streams
        if "auto_ffmpeg_streams" in data:
            cfg["auto_ffmpeg_streams"] = bool(data["auto_ffmpeg_streams"])
        if "category_rules" in data:
            rules = data["category_rules"]
            if isinstance(rules, list):
                cleaned = []
                for r in rules:
                    if not isinstance(r, dict):
                        continue
                    name = str(r.get("name", "")).strip()
                    exts = r.get("extensions") or []
                    if isinstance(exts, str):
                        exts = [e.strip() for e in exts.split(",") if e.strip()]
                    if name and isinstance(exts, list):
                        cleaned.append({
                            "name": name,
                            "extensions": [str(e).lower().lstrip(".") for e in exts if str(e).strip()],
                        })
                cfg["category_rules"] = cleaned
        save_config(cfg)
        log_message("INFO", "Configuration updated")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self._send_cors_headers()
        self.end_headers()
        self.wfile.write(json.dumps({"status": "ok", "message": "Config saved"}).encode("utf-8"))

    def _handle_history_clear(self):
        _ensure_config_dir()
        try:
            if os.path.exists(HISTORY_FILE):
                os.remove(HISTORY_FILE)
            log_message("INFO", "History cleared")
        except OSError:
            pass
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self._send_cors_headers()
        self.end_headers()
        self.wfile.write(json.dumps({"status": "ok"}).encode("utf-8"))

    def _handle_config_reset(self):
        """Reset server-side config to defaults (download_dir, filters, limits all reset)"""
        try:
            default_cfg = {
                "download_dir": os.path.join(os.path.expanduser("~"), "Downloads"),
                "program": "wget",
                "arguments": "",
                "max_history": MAX_HISTORY,
                "max_retries": 3,
                "url_rules": [],
                "filetype_filter_enabled": False,
                "filetype_filter": "",
                "blacklist_enabled": False,
                "url_blacklist": "",
                "whitelist_enabled": False,
                "url_whitelist": "",
                "concurrent_limit": 5,
                "speed_limit": 0,
                # v1.6.0
                "custom_referer": "",
                "custom_user_agent": "",
                "proxy_url": "",
                "forward_cookies": False,
                # v1.7.0
                "categorize_enabled": False,
                "category_rules": list(DEFAULT_CATEGORY_RULES),
                # v1.8.0
                "auto_ffmpeg_streams": True,
            }
            save_config(default_cfg)
            log_message("INFO", "Server config reset to defaults")
        except OSError as e:
            self._send_error(f"Reset failed: {e}", 500)
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self._send_cors_headers()
        self.end_headers()
        self.wfile.write(
            json.dumps({"status": "ok", "message": "Config reset"}).encode("utf-8")
        )

    def _start_download(self, url, program, args, filename, download_dir,
                       speed_limit=0, cookies="", headers=None, proxy=""):
        headers = headers or {}
        cmd = self._build_command(
            url, program, args, filename, download_dir, speed_limit,
            cookies=cookies, headers=headers, proxy=proxy,
        )

        if not cmd:
            return {"status": "error", "message": f"Unknown program: {program}"}

        try:
            flags = 0
            if os.name == "nt":
                flags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0) | 0x08000000  # DETACHED_PROCESS
            # Pass proxy via env vars too (best-effort socks5 support for wget/curl)
            env = None
            if proxy:
                env = os.environ.copy()
                env["http_proxy"] = proxy
                env["https_proxy"] = proxy
                env["HTTP_PROXY"] = proxy
                env["HTTPS_PROXY"] = proxy
                env["all_proxy"] = proxy
                env["ALL_PROXY"] = proxy
            subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                cwd=download_dir,
                env=env,
                creationflags=flags if os.name == "nt" else 0,
                start_new_session=(os.name != "nt"),
            )
            extra = []
            if cookies:
                extra.append("with cookies")
            if proxy:
                extra.append(f"via proxy {proxy}")
            if headers:
                extra.append(f"with {len(headers)} custom header(s)")
            suffix = (" (" + ", ".join(extra) + ")") if extra else ""
            return {"status": "success", "message": f"Download started via {program}{suffix}", "url": url}
        except FileNotFoundError:
            return {
                "status": "error",
                "message": f"{program} not found. Please install it first or select another program.",
            }
        except OSError as e:
            return {"status": "error", "message": f"Failed to start {program}: {e}"}
        except Exception as e:
            return {"status": "error", "message": str(e)}

    def _count_active_downloads(self):
        """Count currently active downloads"""
        global _active_downloads
        with _active_downloads_lock:
            return _active_downloads

    def _register_download(self):
        """Register a new download and schedule cleanup"""
        global _active_downloads
        with _active_downloads_lock:
            _active_downloads += 1
        # Schedule cleanup after 5 minutes (downloads should be done by then)
        def cleanup():
            global _active_downloads
            with _active_downloads_lock:
                _active_downloads = max(0, _active_downloads - 1)
        threading.Timer(300, cleanup).start()

    def _build_command(self, url, program, args, filename, download_dir,
                       speed_limit=0, cookies="", headers=None, proxy=""):
        arg_list = args.split() if args else []
        headers = headers or {}

        # Helper: build the list of --header / -H flags for cookies and any
        # custom headers. Referer/User-Agent are added via dedicated flags for
        # wget (cleaner) but via -H for curl, so they are excluded from the
        # generic header loop for wget only.
        _WGET_DEDICATED = {"referer", "user-agent"}

        def _wget_header_flags():
            flags = []
            if cookies:
                flags.extend(["--header", f"Cookie: {cookies}"])
            for k, v in headers.items():
                if k.lower() in _WGET_DEDICATED:
                    continue  # handled by --referer / -U
                flags.extend(["--header", f"{k}: {v}"])
            return flags

        def _curl_header_flags():
            flags = []
            if cookies:
                flags.extend(["-H", f"Cookie: {cookies}"])
            for k, v in headers.items():
                flags.extend(["-H", f"{k}: {v}"])
            return flags

        def _wget_proxy_flags():
            if not proxy:
                return []
            return [
                "-e", f"http_proxy={proxy}",
                "-e", f"https_proxy={proxy}",
                "--proxy=on",
            ]

        def _curl_proxy_flags():
            if not proxy:
                return []
            return ["--proxy", proxy]

        commands = {}

        # wget: preserve filename with -O if provided, otherwise use -P for dir
        if filename:
            safe_name = sanitize_filename(filename)
            wget_cmd = ["wget", "-c", "-O", os.path.join(download_dir, safe_name), url]
            if speed_limit > 0:
                wget_cmd.extend(["--limit-rate", f"{speed_limit}k"])
            # Custom Referer / User-Agent (also accept from headers dict)
            referer = headers.get("Referer") or headers.get("referer")
            if referer:
                wget_cmd.extend(["--referer", referer])
            ua = headers.get("User-Agent") or headers.get("user-agent")
            if ua:
                wget_cmd.extend(["-U", ua])
            wget_cmd += _wget_header_flags()
            wget_cmd += _wget_proxy_flags()
            commands["wget"] = wget_cmd + arg_list
        else:
            wget_cmd = ["wget", "-c", "-P", download_dir, url]
            if speed_limit > 0:
                wget_cmd.extend(["--limit-rate", f"{speed_limit}k"])
            referer = headers.get("Referer") or headers.get("referer")
            if referer:
                wget_cmd.extend(["--referer", referer])
            ua = headers.get("User-Agent") or headers.get("user-agent")
            if ua:
                wget_cmd.extend(["-U", ua])
            wget_cmd += _wget_header_flags()
            wget_cmd += _wget_proxy_flags()
            commands["wget"] = wget_cmd + arg_list

        # curl
        if filename:
            safe_name = sanitize_filename(filename)
            curl_cmd = ["curl", "-L", "-o", os.path.join(download_dir, safe_name), url]
            if speed_limit > 0:
                curl_cmd.extend(["--limit-rate", f"{speed_limit}k"])
            curl_cmd += _curl_header_flags()
            curl_cmd += _curl_proxy_flags()
            commands["curl"] = curl_cmd + arg_list
        else:
            curl_cmd = ["curl", "-L", "-O", "--output-dir", download_dir, url]
            if speed_limit > 0:
                curl_cmd.extend(["--limit-rate", f"{speed_limit}k"])
            curl_cmd += _curl_header_flags()
            curl_cmd += _curl_proxy_flags()
            commands["curl"] = curl_cmd + arg_list

        # gopeed
        commands["gopeed"] = ["gopeed", "-d", download_dir, url] + arg_list

        # v1.8.0: ffmpeg — ideal for HLS / DASH streams (.m3u8 / .mpd) and
        # general media. Default to stream-copy (-c copy) for speed; users can
        # override the output container via the filename extension. When no
        # filename is provided we derive one based on whether the URL looks
        # like a stream manifest (.ts for HLS, .mp4 for DASH).
        if filename:
            safe_name = sanitize_filename(filename)
            out_path = os.path.join(download_dir, safe_name)
        else:
            if is_stream_url(url):
                default_name = "stream.mp4" if url.lower().endswith(".mpd") else "stream.ts"
            else:
                default_name = "media.mp4"
            out_path = os.path.join(download_dir, default_name)
        # -y overwrite, -hide_banner / -loglevel error for quieter output,
        # -c copy avoids re-encoding (fast + lossless). User args appended last
        # so they can override codec / format if desired.
        ffmpeg_cmd = [
            "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
            "-i", url, "-c", "copy", out_path,
        ]
        # Forward cookies / custom headers via -headers (applies to all input
        # requests ffmpeg makes, including segment fetches for HLS).
        extra_headers = []
        if cookies:
            extra_headers.append(f"Cookie: {cookies}")
        for k, v in headers.items():
            extra_headers.append(f"{k}: {v}")
        if proxy:
            # ffmpeg understands http_proxy / https_proxy env vars; also pass
            # -http_proxy via args for older builds. We rely on env vars set
            # by _start_download, so only add the arg form when not already
            # covered. Using both is harmless.
            pass
        if extra_headers:
            # -headers expects a single string with each header terminated by \r\n
            ffmpeg_cmd[1:1] = ["-headers", "\r\n".join(extra_headers) + "\r\n"]
        commands["ffmpeg"] = ffmpeg_cmd + arg_list

        if platform.system() == "Windows":
            commands["idm"] = [
                r"C:\Program Files (x86)\Internet Download Manager\IDMan.exe",
                "/d",
                url,
                "/p",
                download_dir,
            ]
            if filename:
                commands["idm"].extend(["/f", sanitize_filename(filename)])
            commands["ndm"] = [
                r"C:\Program Files (x86)\Neat Download Manager\ndm.exe",
                url,
            ]
            # Fallback: allow user-provided arguments for NDM
            commands["ndm"] += arg_list
        else:
            # Linux / macOS fallback
            commands["idm"] = ["xdg-open", f"idm:{url}"]
            commands["ndm"] = ["xdg-open", f"ndm:{url}"]

        return commands.get(program)

    def _handle_check(self):
        """v1.7.0: HEAD/GET request to determine remote file size and filename.

        Query params:
          url=<remote url>
        Response:
          {status, url, filename, size, size_human, content_type, redirected, final_url}
        """
        from urllib.parse import urlparse, parse_qs
        params = parse_qs(urlparse(self.path).query)
        url = (params.get("url") or [""])[0]
        if not url:
            self._send_error("Missing url parameter", 400)
            return
        if not re.match(r"^https?://", url, re.IGNORECASE):
            self._send_error("Only http/https URLs are supported", 400)
            return

        cfg = load_config()
        proxy = (cfg.get("proxy_url") or "").strip()
        cookies = ""
        if cfg.get("forward_cookies"):
            cookies = ""  # cookies are captured by the extension; nothing to do here
        headers = {}
        srv_ref = str(cfg.get("custom_referer") or "").strip()
        if srv_ref:
            headers["Referer"] = srv_ref
        srv_ua = str(cfg.get("custom_user_agent") or "").strip()
        if srv_ua:
            headers["User-Agent"] = srv_ua

        try:
            import urllib.request
            import urllib.error
            req = urllib.request.Request(url, method="HEAD", headers=headers)
            if cookies:
                req.add_header("Cookie", cookies)
            opener = urllib.request.build_opener()
            if proxy:
                proxy_handler = urllib.request.ProxyHandler({
                    "http": proxy,
                    "https": proxy,
                })
                opener = urllib.request.build_opener(proxy_handler)
            resp = opener.open(req, timeout=10)
            size_raw = resp.headers.get("Content-Length") or resp.headers.get("content-length") or ""
            try:
                size = int(size_raw) if size_raw else 0
            except (TypeError, ValueError):
                size = 0
            content_type = resp.headers.get("Content-Type") or resp.headers.get("content-type") or ""
            final_url = resp.geturl() or url
            # Derive filename from final URL if the server did not provide one
            cd = resp.headers.get("Content-Disposition") or resp.headers.get("content-disposition") or ""
            fname = ""
            if cd:
                m = re.search(r'filename\*?=(?:UTF-8\'\')?"?([^";]+)"?', cd, re.IGNORECASE)
                if m:
                    fname = m.group(1)
            if not fname:
                fname = get_filename_from_url(final_url)
            payload = {
                "status": "ok",
                "url": url,
                "final_url": final_url,
                "filename": fname,
                "size": size,
                "size_human": human_readable_size(size) if size else "",
                "content_type": content_type,
                "redirected": final_url != url,
            }
            self._send_json(payload)
        except urllib.error.HTTPError as e:
            # Some servers reject HEAD; fall back to a ranged GET of 0 bytes.
            if e.code in (405, 403, 501):
                fallback = self._check_via_get(url, headers, cookies, proxy)
                if fallback:
                    self._send_json(fallback)
                    return
            self._send_json({
                "status": "error",
                "message": f"HTTP {e.code}: {e.reason}",
                "url": url,
            }, status=200)
        except urllib.error.URLError as e:
            self._send_json({
                "status": "error",
                "message": f"URL error: {e.reason}",
                "url": url,
            }, status=200)
        except Exception as e:
            self._send_json({
                "status": "error",
                "message": str(e),
                "url": url,
            }, status=200)

    def _check_via_get(self, url, headers, cookies, proxy):
        """Fallback when HEAD is rejected: issue a small ranged GET request."""
        try:
            import urllib.request
            import urllib.error
            get_headers = dict(headers or {})
            get_headers["Range"] = "bytes=0-0"
            req = urllib.request.Request(url, method="GET", headers=get_headers)
            if cookies:
                req.add_header("Cookie", cookies)
            opener = urllib.request.build_opener()
            if proxy:
                opener = urllib.request.build_opener(urllib.request.ProxyHandler({
                    "http": proxy, "https": proxy,
                }))
            resp = opener.open(req, timeout=10)
            # Content-Range: bytes 0-0/12345 -> total = 12345
            cr = resp.headers.get("Content-Range") or resp.headers.get("content-range") or ""
            size = 0
            m = re.search(r"/(\d+)\s*$", cr)
            if m:
                size = int(m.group(1))
            else:
                cl = resp.headers.get("Content-Length") or resp.headers.get("content-length") or ""
                try:
                    size = int(cl) if cl else 0
                except (TypeError, ValueError):
                    size = 0
            content_type = resp.headers.get("Content-Type") or resp.headers.get("content-type") or ""
            final_url = resp.geturl() or url
            cd = resp.headers.get("Content-Disposition") or resp.headers.get("content-disposition") or ""
            fname = ""
            if cd:
                m = re.search(r'filename\*?=(?:UTF-8\'\')?"?([^";]+)"?', cd, re.IGNORECASE)
                if m:
                    fname = m.group(1)
            if not fname:
                fname = get_filename_from_url(final_url)
            resp.close()
            return {
                "status": "ok",
                "url": url,
                "final_url": final_url,
                "filename": fname,
                "size": size,
                "size_human": human_readable_size(size) if size else "",
                "content_type": content_type,
                "redirected": final_url != url,
            }
        except Exception:
            return None

    def _handle_batch(self, data):
        """v1.7.0: forward a batch of URLs in a single request.

        Request body:
          {urls: ["...","..."], program, arguments, manual, source, cookies, headers, proxy}
        Response:
          {status, total, success, failed, results:[{url,status,message},...]}
        Each URL is dispatched to the same _handle_download logic, but without
        re-sending an HTTP response (we collect results instead).
        """
        urls = data.get("urls") or []
        if not isinstance(urls, list) or not urls:
            self._send_error("Missing or invalid 'urls' list", 400)
            return

        program = (data.get("program") or "wget").strip().lower()
        args = (data.get("arguments") or "").strip()
        is_manual = bool(data.get("manual", True))
        source = (data.get("source") or "batch").strip()
        cookies = (data.get("cookies") or "").strip()
        headers = data.get("headers") if isinstance(data.get("headers"), dict) else {}
        proxy = (data.get("proxy") or "").strip()

        results = []
        success_count = 0
        cfg = load_config()
        download_dir = cfg.get("download_dir") or os.path.join(os.path.expanduser("~"), "Downloads")
        url_rules = cfg.get("url_rules", [])
        max_retries = cfg.get("max_retries", 3)
        try:
            client_concurrent = int(data.get("concurrent_limit", 0))
        except (TypeError, ValueError):
            client_concurrent = 0
        concurrent_limit = client_concurrent or cfg.get("concurrent_limit", 5)
        speed_limit = data.get("speed_limit", 0) or cfg.get("speed_limit", 0)

        if not proxy and cfg.get("proxy_url"):
            proxy = str(cfg.get("proxy_url") or "").strip()
        if not headers.get("Referer") and not headers.get("referer"):
            srv_ref = str(cfg.get("custom_referer") or "").strip()
            if srv_ref:
                headers["Referer"] = srv_ref
        if not headers.get("User-Agent") and not headers.get("user-agent"):
            srv_ua = str(cfg.get("custom_user_agent") or "").strip()
            if srv_ua:
                headers["User-Agent"] = srv_ua

        # v1.8.0: probe ffmpeg availability once for the whole batch (avoids
        # running shutil.which on every URL).
        ffmpeg_available = "ffmpeg" in detect_available_programs()

        for raw_url in urls:
            url = str(raw_url or "").strip()
            if not url:
                results.append({"url": "", "status": "error", "message": "empty url"})
                continue
            filename = sanitize_filename(get_filename_from_url(url)) or "download"
            chosen = program
            matched = match_url_rule(url, url_rules)
            if matched:
                chosen = matched
            # v1.8.0: auto-route stream URLs to ffmpeg in batch mode too
            if cfg.get("auto_ffmpeg_streams", True) and is_stream_url(url) and chosen != "ffmpeg" and ffmpeg_available:
                chosen = "ffmpeg"

            effective_dir = download_dir
            category_subfolder = ""
            if cfg.get("categorize_enabled") and cfg.get("category_rules"):
                category_subfolder = categorize_filename(filename, cfg.get("category_rules"))
                if category_subfolder:
                    effective_dir = os.path.join(download_dir, category_subfolder)

            try:
                os.makedirs(effective_dir, exist_ok=True)
            except OSError as e:
                results.append({"url": url, "status": "error", "message": f"mkdir failed: {e}"})
                continue

            attempt = 0
            result = None
            for attempt in range(max_retries + 1):
                result = self._start_download(
                    url, chosen, args, filename, effective_dir,
                    speed_limit, cookies=cookies, headers=headers, proxy=proxy,
                )
                if result.get("status") == "success":
                    self._register_download()
                    break
                if attempt < max_retries:
                    time.sleep(0.5)
            status = result.get("status", "error")
            if status == "success":
                success_count += 1
            results.append({
                "url": url,
                "status": status,
                "message": result.get("message", ""),
                "program": chosen,
                "filename": filename,
            })
            entry = {
                "timestamp": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                "url": url,
                "program": chosen,
                "filename": filename,
                "status": status,
                "message": result.get("message", ""),
                "retries": attempt if status != "success" else 0,
                "source": source,
                "category": category_subfolder,
            }
            append_history(entry)

        log_message("INFO", f"Batch forward: {success_count}/{len(urls)} succeeded")
        self._send_json({
            "status": "ok",
            "total": len(urls),
            "success": success_count,
            "failed": len(urls) - success_count,
            "results": results,
        })

    def _handle_export(self):
        """Export history as JSON or CSV"""
        from urllib.parse import urlparse, parse_qs
        params = parse_qs(urlparse(self.path).query)
        fmt = (params.get("format") or ["json"])[0].lower()
        history = load_history()

        if fmt == "csv":
            import csv
            import io
            output = io.StringIO()
            writer = csv.writer(output)
            writer.writerow(["timestamp", "url", "filename", "program", "status", "message"])
            for item in history:
                writer.writerow([
                    item.get("timestamp", ""),
                    item.get("url", ""),
                    item.get("filename", ""),
                    item.get("program", ""),
                    item.get("status", ""),
                    item.get("message", ""),
                ])
            content_type = "text/csv; charset=utf-8"
            body = output.getvalue().encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self._send_cors_headers()
            self.send_header("Content-Disposition", "attachment; filename=download_history.csv")
            self.end_headers()
            self.wfile.write(body)
        else:
            response = {"status": "ok", "history": history}
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self._send_cors_headers()
            self.send_header("Content-Disposition", "attachment; filename=download_history.json")
            self.end_headers()
            self.wfile.write(json.dumps(response, ensure_ascii=False).encode("utf-8"))

    def _handle_stats(self):
        """Return download statistics"""
        history = load_history()
        total = len(history)
        success = sum(1 for h in history if h.get("status") == "success")
        error = total - success
        by_program = {}
        for h in history:
            prog = h.get("program", "unknown")
            if prog not in by_program:
                by_program[prog] = {"total": 0, "success": 0, "error": 0}
            by_program[prog]["total"] += 1
            if h.get("status") == "success":
                by_program[prog]["success"] += 1
            else:
                by_program[prog]["error"] += 1
        response = {
            "status": "ok",
            "total": total,
            "success": success,
            "error": error,
            "by_program": by_program,
        }
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self._send_cors_headers()
        self.end_headers()
        self.wfile.write(json.dumps(response, ensure_ascii=False).encode("utf-8"))

    def _send_error(self, message, code=400):
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self._send_cors_headers()
        self.end_headers()
        self.wfile.write(json.dumps({"status": "error", "message": message}).encode("utf-8"))

    def log_message(self, format, *args):
        """Route server access log to our own log file instead of stderr"""
        # Keep quiet for common success cases; only log errors in other places
        pass


def run_server():
    server = HTTPServer(("127.0.0.1", PORT), DownloadHandler)
    _ensure_config_dir()
    log_message("INFO", f"Download Forwarder server listening on http://127.0.0.1:{PORT}")
    log_message("INFO", f"Platform: {platform.system()} {platform.release()}")
    log_message("INFO", f"Available programs: {detect_available_programs()}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.shutdown()
        log_message("INFO", "Server stopped by user")


if __name__ == "__main__":
    run_server()
