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
VERSION = "1.1.0"
DEFAULT_PROGRAMS = ["wget", "curl", "idm", "ndm", "gopeed"]
CONFIG_DIR = os.path.join(os.path.expanduser("~"), ".download_forwarder")
CONFIG_FILE = os.path.join(CONFIG_DIR, "config.json")
HISTORY_FILE = os.path.join(CONFIG_DIR, "history.json")
LOG_FILE = os.path.join(CONFIG_DIR, "server.log")
MAX_HISTORY = 100

# Thread-safe history store
_history_lock = threading.Lock()
_config_lock = threading.Lock()


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


class DownloadHandler(BaseHTTPRequestHandler):
    def _send_cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def do_OPTIONS(self):
        self.send_response(204)
        self._send_cors_headers()
        self.end_headers()

    def do_GET(self):
        """Health check, info, history, config endpoints"""
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self._send_cors_headers()
        self.end_headers()

        if self.path == "/ping" or self.path.startswith("/ping?"):
            response = {
                "status": "ok",
                "message": "Download Forwarder server is running",
                "version": VERSION,
                "platform": platform.system(),
                "available_programs": detect_available_programs(),
            }
            self.wfile.write(json.dumps(response, ensure_ascii=False).encode("utf-8"))
        elif self.path == "/history" or self.path.startswith("/history?"):
            response = {
                "status": "ok",
                "history": load_history(),
            }
            self.wfile.write(json.dumps(response, ensure_ascii=False).encode("utf-8"))
        elif self.path == "/config" or self.path.startswith("/config?"):
            cfg = load_config()
            cfg["status"] = "ok"
            cfg["available_programs"] = detect_available_programs()
            self.wfile.write(json.dumps(cfg, ensure_ascii=False).encode("utf-8"))
        elif self.path == "/logs" or self.path.startswith("/logs?"):
            logs = []
            if os.path.exists(LOG_FILE):
                try:
                    with open(LOG_FILE, "r", encoding="utf-8", errors="replace") as f:
                        lines = f.readlines()
                        logs = lines[-50:]
                except OSError:
                    pass
            response = {"status": "ok", "logs": logs}
            self.wfile.write(json.dumps(response, ensure_ascii=False).encode("utf-8"))
        else:
            self.send_response(404)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self._send_cors_headers()
            self.end_headers()
            self.wfile.write(json.dumps({"status": "error", "message": "Not found"}).encode("utf-8"))

    def do_POST(self):
        """Receive download / config update / history clear requests"""
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
        elif self.path.startswith("/history/clear"):
            self._handle_history_clear()
        else:
            self._send_error("Not found", 404)

    def _handle_download(self, data):
        url = (data.get("url") or "").strip()
        program = (data.get("program") or "wget").strip().lower()
        args = (data.get("arguments") or "").strip()
        filename = sanitize_filename(data.get("filename") or "")

        if not url:
            log_message("ERROR", "Download request missing URL")
            self._send_error("Missing URL", 400)
            return

        cfg = load_config()
        download_dir = cfg.get("download_dir") or os.path.join(os.path.expanduser("~"), "Downloads")
        try:
            os.makedirs(download_dir, exist_ok=True)
        except OSError as e:
            log_message("ERROR", f"Failed to create download directory: {e}")
            self._send_error(f"Cannot create directory: {e}", 500)
            return

        result = self._start_download(url, program, args, filename, download_dir)

        entry = {
            "timestamp": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "url": url,
            "program": program,
            "filename": filename or get_filename_from_url(url),
            "status": result.get("status"),
            "message": result.get("message", ""),
        }

        if result.get("status") == "success":
            append_history(entry)
            log_message("INFO", f"Started download via {program}: {url}")
        else:
            entry["status"] = "error"
            append_history(entry)
            log_message("ERROR", f"Download failed ({program}): {result.get('message')}")

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

    def _start_download(self, url, program, args, filename, download_dir):
        cmd = self._build_command(url, program, args, filename, download_dir)

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

    def _build_command(self, url, program, args, filename, download_dir):
        arg_list = args.split() if args else []

        commands = {}

        # wget: preserve filename with -O if provided, otherwise use -P for dir
        if filename:
            safe_name = sanitize_filename(filename)
            commands["wget"] = ["wget", "-c", "-O", os.path.join(download_dir, safe_name), url] + arg_list
        else:
            commands["wget"] = ["wget", "-c", "-P", download_dir, url] + arg_list

        # curl
        if filename:
            safe_name = sanitize_filename(filename)
            commands["curl"] = [
                "curl",
                "-L",
                "-o",
                os.path.join(download_dir, safe_name),
                url,
            ] + arg_list
        else:
            commands["curl"] = ["curl", "-L", "-O", "--output-dir", download_dir, url] + arg_list

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
