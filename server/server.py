#!/usr/bin/env python3
"""
Download Forwarder Local Server
Listens on a fixed port and receives download requests from the browser extension.
Forwards downloads to external download managers (wget, curl, NDM, IDM, Gopeed).
"""

import json
import subprocess
import sys
import os
import threading
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse

# Fixed port - unlikely to conflict with common services
PORT = 18735

class DownloadHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        """Health check and test endpoint"""
        if self.path == '/ping':
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({
                'status': 'ok',
                'message': 'Download Forwarder server is running',
                'version': '1.0.0'
            }).encode())
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        """Receive download request from extension"""
        content_length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_length)

        try:
            data = json.loads(body.decode('utf-8'))
            url = data.get('url', '')
            program = data.get('program', 'wget')
            args = data.get('arguments', '')

            if not url:
                self._send_error('Missing URL')
                return

            result = self._start_download(url, program, args)
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps(result).encode())

        except json.JSONDecodeError:
            self._send_error('Invalid JSON')
        except Exception as e:
            self._send_error(str(e))

    def _start_download(self, url, program, args):
        """Start download using external program"""
        cmd = self._build_command(url, program, args)

        if not cmd:
            return {'status': 'error', 'message': f'Unknown program: {program}'}

        try:
            subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name == 'nt' else 0
            )
            return {'status': 'success', 'message': f'Download started via {program}', 'url': url}
        except FileNotFoundError:
            return {'status': 'error', 'message': f'{program} not found. Please install it first.'}
        except Exception as e:
            return {'status': 'error', 'message': str(e)}

    def _build_command(self, url, program, args):
        """Build command for external download manager"""
        arg_list = args.split() if args else []

        commands = {
            'wget': ['wget', url] + arg_list,
            'curl': ['curl', '-L', '-O', url] + arg_list,
            'gopeed': ['gopeed', url] + arg_list,
        }

        if os.name == 'nt':
            # Windows-specific programs
            commands['idm'] = [r'C:\Program Files (x86)\Internet Download Manager\IDMan.exe', '/d', url]
            commands['ndm'] = [r'C:\Program Files (x86)\NetTransport Download 2\NT_Downloader.exe', url]
        else:
            # Linux-specific
            commands['idm'] = ['xdg-open', f'idm:{url}']

        return commands.get(program)

    def _send_error(self, message):
        self.send_response(400)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps({'status': 'error', 'message': message}).encode())

    def log_message(self, format, *args):
        """Suppress default logging"""
        pass

def run_server():
    server = HTTPServer(('127.0.0.1', PORT), DownloadHandler)
    print(f'Download Forwarder server listening on http://127.0.0.1:{PORT}')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.shutdown()
        print('\nServer stopped.')

if __name__ == '__main__':
    run_server()