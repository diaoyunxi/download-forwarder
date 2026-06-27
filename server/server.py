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
VERSION = "1.4.0"
DEFAULT_PROGRAMS = ["wget", "curl", "idm", "ndm", "gopeed"]
CONFIG_DIR = os.path.join(os.path.expanduser("~"), ".download_forwarder")
CONFIG_FILE = os.path.join(CONFIG_DIR, "config.json")
HISTORY_FILE = os.path.join(CONFIG_DIR, "history.json")
LOG_FILE = os.path.join(CONFIG_DIR, "server.log")
MAX_HISTORY = 100

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

        try:
            os.makedirs(download_dir, exist_ok=True)
        except OSError as e:
            log_message("ERROR", f"Failed to create download directory: {e}")
            self._send_error(f"Cannot create directory: {e}", 500)
            return

        # Retry logic
        result = None
        attempt = 0
        for attempt in range(max_retries + 1):
            result = self._start_download(url, program, args, filename, download_dir, speed_limit)
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

    def _start_download(self, url, program, args, filename, download_dir, speed_limit=0):
        cmd = self._build_command(url, program, args, filename, download_dir, speed_limit)

        if not cmd:
            return {"status": "error", "message": f"Unknown program: {program}"}

        try:
            flags = 0
            if os.name == "nt":
                flags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0) | 0x08000000  # DETACHED_PROCESS
            subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                cwd=download_dir,
                creationflags=flags if os.name == "nt" else 0,
                start_new_session=(os.name != "nt"),
            )
            return {"status": "success", "message": f"Download started via {program}", "url": url}
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

    def _build_command(self, url, program, args, filename, download_dir, speed_limit=0):
        arg_list = args.split() if args else []

        commands = {}

        # wget: preserve filename with -O if provided, otherwise use -P for dir
        if filename:
            safe_name = sanitize_filename(filename)
            wget_cmd = ["wget", "-c", "-O", os.path.join(download_dir, safe_name), url]
            if speed_limit > 0:
                wget_cmd.extend(["--limit-rate", f"{speed_limit}k"])
            commands["wget"] = wget_cmd + arg_list
        else:
            wget_cmd = ["wget", "-c", "-P", download_dir, url]
            if speed_limit > 0:
                wget_cmd.extend(["--limit-rate", f"{speed_limit}k"])
            commands["wget"] = wget_cmd + arg_list

        # curl
        if filename:
            safe_name = sanitize_filename(filename)
            curl_cmd = ["curl", "-L", "-o", os.path.join(download_dir, safe_name), url]
            if speed_limit > 0:
                curl_cmd.extend(["--limit-rate", f"{speed_limit}k"])
            commands["curl"] = curl_cmd + arg_list
        else:
            curl_cmd = ["curl", "-L", "-O", "--output-dir", download_dir, url]
            if speed_limit > 0:
                curl_cmd.extend(["--limit-rate", f"{speed_limit}k"])
            commands["curl"] = curl_cmd + arg_list

        # gopeed
        commands["gopeed"] = ["gopeed", "-d", download_dir, url] + arg_list

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
