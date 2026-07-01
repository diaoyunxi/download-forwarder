#!/usr/bin/env python3
"""
Download Forwarder Local Server
Listens on a fixed port and receives download requests from the browser extension.
Forwards downloads to external download managers (wget, curl, NDM, IDM, Gopeed,
ffmpeg, aria2c).

Enhanced with:
- CORS support for browser extension communication
- Download history tracking
- Available program detection
- Download directory configuration
- Proper logging
- Security: bind to localhost only
- v1.9.0: ThreadingHTTPServer (concurrent requests no longer block)
- v1.9.0: optional Bearer token authentication for non-ping endpoints
- v1.9.0: active task tracking (PID-level) + /tasks list + /cancel API
- v1.9.0: aria2c downloader support
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
import uuid
import signal
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

# === Configuration ===
PORT = 18735
VERSION = "1.9.0"
# v1.9.0: aria2c added as a 7th first-class downloader (multi-connection,
# resumable, BitTorrent/Metalink capable). It is detected via shutil.which.
DEFAULT_PROGRAMS = ["wget", "curl", "idm", "ndm", "gopeed", "ffmpeg", "aria2c"]
CONFIG_DIR = os.path.join(os.path.expanduser("~"), ".download_forwarder")
CONFIG_FILE = os.path.join(CONFIG_DIR, "config.json")
HISTORY_FILE = os.path.join(CONFIG_DIR, "history.json")
LOG_FILE = os.path.join(CONFIG_DIR, "server.log")
MAX_HISTORY = 100
# v1.9.0: finished tasks (completed/failed/cancelled) are pruned from the
# in-memory task table after this many seconds so the table does not grow
# unbounded over a long-running server.
TASK_TTL_SECONDS = 1800

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

# v1.9.0: active task registry. Maps task_id -> task dict.
# Each task dict contains: task_id, pid, process (subprocess.Popen handle),
# url, program, filename, started_at, status (running|completed|failed|cancelled),
# ended_at, exit_code. The subprocess.Popen handle is kept so we can poll/wait
# from a watcher thread without re-fetching by PID (which can be reused by
# the OS after a process exits).
_tasks = {}
_tasks_lock = threading.Lock()


def _gen_task_id():
    """Generate a short, URL-safe unique task id."""
    return uuid.uuid4().hex[:12]


def _register_task(process, url, program, filename, source="auto"):
    """Register a newly-spawned download subprocess and start a watcher thread
    that updates the task status when the process exits. Returns the task_id.
    """
    task_id = _gen_task_id()
    started = datetime.datetime.now()
    with _tasks_lock:
        _tasks[task_id] = {
            "task_id": task_id,
            "pid": process.pid,
            "url": url,
            "program": program,
            "filename": filename,
            "source": source,
            "started_at": started.strftime("%Y-%m-%d %H:%M:%S"),
            "started_ts": started.timestamp(),
            "status": "running",
            "ended_at": "",
            "ended_ts": 0.0,
            "exit_code": None,
        }

    def _watcher():
        # Wait for the process to exit. subprocess.Popen.wait() blocks the
        # watcher thread (not the request thread), and returns the exit code.
        try:
            rc = process.wait()
        except Exception as e:
            rc = -1
            log_message("WARNING", f"task {task_id} watcher error: {e}")
        ended = datetime.datetime.now()
        with _tasks_lock:
            if task_id in _tasks:
                # Don't overwrite a "cancelled" status set by _cancel_task.
                if _tasks[task_id]["status"] == "running":
                    _tasks[task_id]["status"] = "completed" if rc == 0 else "failed"
                _tasks[task_id]["exit_code"] = rc
                _tasks[task_id]["ended_at"] = ended.strftime("%Y-%m-%d %H:%M:%S")
                _tasks[task_id]["ended_ts"] = ended.timestamp()

    # daemon=True so the watcher never blocks server shutdown.
    threading.Thread(target=_watcher, daemon=True).start()
    return task_id


def _cancel_task(task_id):
    """Terminate a running task's process group. Returns (ok, message)."""
    with _tasks_lock:
        task = _tasks.get(task_id)
        if not task:
            return False, "task not found"
        if task["status"] != "running":
            return False, f"task is already {task['status']}"
        pid = task["pid"]

    try:
        if os.name == "nt":
            # /T kills the whole process tree, /F forces termination.
            subprocess.run(
                ["taskkill", "/PID", str(pid), "/T", "/F"],
                capture_output=True,
                check=False,
            )
        else:
            # We launch the downloaders with start_new_session=True on POSIX,
            # so the child is the leader of its own process group. Killing
            # the entire group ensures helper processes (e.g. ffmpeg segment
            # fetchers, aria2c connection workers) are also terminated.
            try:
                pgid = os.getpgid(pid)
                os.killpg(pgid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            except Exception:
                # Fall back to a direct SIGTERM on the leader.
                try:
                    os.kill(pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
        with _tasks_lock:
            if task_id in _tasks:
                _tasks[task_id]["status"] = "cancelled"
                _tasks[task_id]["ended_at"] = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                _tasks[task_id]["ended_ts"] = datetime.datetime.now().timestamp()
                _tasks[task_id]["exit_code"] = -1
        log_message("INFO", f"Task {task_id} (pid {pid}, {task.get('program','?')}) cancelled")
        return True, "cancelled"
    except Exception as e:
        return False, str(e)


def _prune_tasks():
    """Remove finished tasks older than TASK_TTL_SECONDS to bound memory use."""
    cutoff = time.time() - TASK_TTL_SECONDS
    with _tasks_lock:
        stale = []
        for tid, t in _tasks.items():
            if t["status"] == "running":
                continue
            end_ts = t.get("ended_ts") or 0.0
            if end_ts and end_ts < cutoff:
                stale.append(tid)
        for tid in stale:
            _tasks.pop(tid, None)


def _list_tasks():
    """Snapshot of all known tasks (running + recently finished)."""
    with _tasks_lock:
        # Shallow-copy each dict so callers can serialize without holding the
        # lock; drop the non-JSON-serializable Popen handle.
        out = []
        for t in _tasks.values():
            copy = {k: v for k, v in t.items() if k != "process"}
            out.append(copy)
        # Sort: running first, then by started_ts desc.
        out.sort(key=lambda x: (x.get("status") != "running", -x.get("started_ts", 0)))
        return out


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
    # v1.9.0: optional Bearer token. When non-empty, all endpoints except
    # /ping and OPTIONS require `Authorization: Bearer <token>`. Empty string
    # disables authentication (kept for backwards compatibility).
    data.setdefault("auth_token", "")
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
        # v1.9.0: allow Authorization header so the extension can send the
        # Bearer token required when auth_token is configured server-side.
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")

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

    # v1.9.0: token authentication -------------------------------------------------
    # /ping and OPTIONS are always public so the extension can detect a running
    # server and check available programs even before the user has configured a
    # token. Every other endpoint requires `Authorization: Bearer <token>` when
    # the server's auth_token config is non-empty.
    def _is_auth_required(self):
        cfg = load_config()
        return bool((cfg.get("auth_token") or "").strip())

    def _check_auth(self):
        """Returns True when the request is authorized. When auth is disabled
        (empty auth_token) the request is always authorized.
        """
        if not self._is_auth_required():
            return True
        cfg = load_config()
        expected = (cfg.get("auth_token") or "").strip()
        if not expected:
            return True
        header = self.headers.get("Authorization", "") or ""
        # Accept "Bearer <token>" (RFC 6750) or a raw token for convenience.
        token = ""
        if header.startswith("Bearer "):
            token = header[len("Bearer "):].strip()
        elif header:
            token = header.strip()
        # Also accept ?token=... query parameter as a fallback for browser-initiated
        # downloads (e.g. clicking export URLs which cannot easily set headers).
        if not token:
            from urllib.parse import urlparse, parse_qs
            params = parse_qs(urlparse(self.path).query)
            token = (params.get("token") or [""])[0]
        if not token:
            return False
        # Constant-time comparison to avoid trivial timing attacks.
        if len(token) != len(expected):
            return False
        result = 0
        for a, b in zip(token, expected):
            result |= ord(a) ^ ord(b)
        return result == 0

    def _send_unauthorized(self):
        self.send_response(401)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self._send_cors_headers()
        self.send_header("WWW-Authenticate", 'Bearer realm="download-forwarder"')
        self.end_headers()
        self.wfile.write(json.dumps({
            "status": "error",
            "message": "Unauthorized: missing or invalid auth token",
        }).encode("utf-8"))

    def do_GET(self):
        """Health check, info, history, config endpoints"""
        if self.path == "/ping" or self.path.startswith("/ping?"):
            self._send_json({
                "status": "ok",
                "message": "Download Forwarder server is running",
                "version": VERSION,
                "platform": platform.system(),
                "available_programs": detect_available_programs(),
                # v1.9.0: tell the extension whether auth is required so the
                # popup can prompt the user to enter a token.
                "auth_required": self._is_auth_required(),
            })
        # v1.9.0: /tasks is an auth-protected endpoint that lists all known
        # download tasks (running + recently finished). Used by the popup's
        # task manager UI.
        elif self.path == "/tasks" or self.path.startswith("/tasks?"):
            if not self._check_auth():
                self._send_unauthorized()
                return
            _prune_tasks()
            self._send_json({
                "status": "ok",
                "tasks": _list_tasks(),
                "running": sum(1 for t in _list_tasks() if t.get("status") == "running"),
            })
        elif self.path == "/history" or self.path.startswith("/history?"):
            if not self._check_auth():
                self._send_unauthorized()
                return
            self._send_json({
                "status": "ok",
                "history": load_history(),
            })
        elif self.path == "/config" or self.path.startswith("/config?"):
            if not self._check_auth():
                self._send_unauthorized()
                return
            cfg = load_config()
            cfg["status"] = "ok"
            cfg["available_programs"] = detect_available_programs()
            # Never echo the full auth_token back to the client; expose only
            # a boolean so the popup can show "protected" state.
            cfg["auth_enabled"] = bool((cfg.get("auth_token") or "").strip())
            cfg.pop("auth_token", None)
            self._send_json(cfg)
        elif self.path == "/logs" or self.path.startswith("/logs?"):
            if not self._check_auth():
                self._send_unauthorized()
                return
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
            if not self._check_auth():
                self._send_unauthorized()
                return
            self._handle_export()
        elif self.path.startswith("/stats"):
            if not self._check_auth():
                self._send_unauthorized()
                return
            self._handle_stats()
        elif self.path.startswith("/check"):
            if not self._check_auth():
                self._send_unauthorized()
                return
            self._handle_check()
        else:
            self._send_json({"status": "error", "message": "Not found"}, status=404)

    def do_POST(self):
        """Receive download / config update / history clear / cancel requests"""
        # v1.9.0: token auth applies to all POST endpoints (no /ping POST here).
        if not self._check_auth():
            self._send_unauthorized()
            return

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
        elif self.path.startswith("/cancel"):
            # v1.9.0: cancel a running download task by task_id.
            self._handle_cancel(data)
        elif self.path.startswith("/config"):
            self._handle_config_update(data)
        else:
            self._send_error("Not found", 404)

    def _handle_cancel(self, data):
        """v1.9.0: cancel a running download task.

        Request body: {"task_id": "..."} or {"task_ids": ["...", "..."]}
        Response: {"status": "ok", "results": [{task_id, ok, message}], "cancelled": N}
        """
        task_ids = []
        if isinstance(data.get("task_id"), str):
            task_ids.append(data["task_id"])
        if isinstance(data.get("task_ids"), list):
            task_ids.extend(str(t) for t in data["task_ids"] if t)
        if not task_ids:
            self._send_error("Missing task_id(s)", 400)
            return
        results = []
        cancelled = 0
        for tid in task_ids:
            ok, msg = _cancel_task(tid)
            results.append({"task_id": tid, "ok": ok, "message": msg})
            if ok:
                cancelled += 1
        self._send_json({
            "status": "ok",
            "cancelled": cancelled,
            "total": len(task_ids),
            "results": results,
        })

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
                source=source,
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
        # v1.9.0: optional Bearer token. An empty string clears/disables auth.
        # The extension never sends the token back in /config GET (we strip it
        # there), so this is the only way to set it short of editing config.json.
        if "auth_token" in data:
            cfg["auth_token"] = str(data["auth_token"] or "").strip()
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
                # v1.9.0
                "auth_token": "",
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
                       speed_limit=0, cookies="", headers=None, proxy="",
                       source="auto"):
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
            proc = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                cwd=download_dir,
                env=env,
                creationflags=flags if os.name == "nt" else 0,
                start_new_session=(os.name != "nt"),
            )
            # v1.9.0: register the subprocess so it can be tracked and cancelled.
            task_id = _register_task(
                proc,
                url=url,
                program=program,
                filename=filename or get_filename_from_url(url),
                source=source,
            )
            extra = []
            if cookies:
                extra.append("with cookies")
            if proxy:
                extra.append(f"via proxy {proxy}")
            if headers:
                extra.append(f"with {len(headers)} custom header(s)")
            suffix = (" (" + ", ".join(extra) + ")") if extra else ""
            return {
                "status": "success",
                "message": f"Download started via {program}{suffix}",
                "url": url,
                "task_id": task_id,
                "pid": proc.pid,
            }
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

        # v1.9.0: aria2c — multi-connection / resumable downloader. Defaults:
        #   -c           resume partial download (.aria2 control file)
        #   -x16          up to 16 connections per server (speed boost)
        #   -s16          split into 16 segments
        #   -k1M          1 MiB piece size
        #   --file-allocation=none  avoid preallocating on slow disks
        #   --console-log-level=error  quieter output
        # Cookies / headers are forwarded via --header; proxy via --all-proxy.
        aria2_cmd = [
            "aria2c", "-c",
            "-x16", "-s16", "-k1M",
            "--file-allocation=none",
            "--console-log-level=error",
            "--summary-interval=0",
            "-d", download_dir,
        ]
        if filename:
            aria2_cmd.extend(["-o", sanitize_filename(filename)])
        if speed_limit > 0:
            aria2_cmd.extend(["--max-download-limit", f"{speed_limit}k"])
        if cookies:
            aria2_cmd.extend(["--header", f"Cookie: {cookies}"])
        for k, v in headers.items():
            aria2_cmd.extend(["--header", f"{k}: {v}"])
        if proxy:
            aria2_cmd.extend(["--all-proxy", proxy])
        aria2_cmd.append(url)
        commands["aria2c"] = aria2_cmd + arg_list

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
                    source=source,
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
                "task_id": result.get("task_id", ""),
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
    # v1.9.0: ThreadingHTTPServer spawns a new thread per request so a slow
    # /check (HEAD + ranged-GET fallback) no longer blocks /ping or /download.
    server = ThreadingHTTPServer(("127.0.0.1", PORT), DownloadHandler)
    # daemon_threads=True so worker threads don't block shutdown.
    server.daemon_threads = True
    _ensure_config_dir()
    log_message("INFO", f"Download Forwarder server listening on http://127.0.0.1:{PORT}")
    log_message("INFO", f"Platform: {platform.system()} {platform.release()}")
    log_message("INFO", f"Available programs: {detect_available_programs()}")
    cfg = load_config()
    if (cfg.get("auth_token") or "").strip():
        log_message("INFO", "Auth token is set; non-ping endpoints require Bearer token")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        # Shutdown from the same thread serve_forever runs in is safe here
        # because we are inside the except block (serve_forever has returned).
        log_message("INFO", "Server stopped by user")
    finally:
        try:
            server.server_close()
        except Exception:
            pass


if __name__ == "__main__":
    run_server()
