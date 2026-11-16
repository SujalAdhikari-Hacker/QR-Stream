#!/usr/bin/env python3
"""
QR-Stream server: static files + the tiny feedback channel.

Routes
  GET  /...                static files (sender.html, receiver.html, codec.js, vendor/*)
  GET  /feedback?session=  sender polls the receiver's latest state
  POST /feedback           receiver publishes state
  POST /metrics            append one run record to metrics.jsonl (paper data)

The feedback channel is the only thing that touches the network. The file
itself only ever travels as QR codes -> screen -> camera.
"""
import http.server
import ssl
import socket
import os
import sys
import json
import time
import threading

PORT = 8443
ROOT = os.path.dirname(os.path.abspath(__file__))
METRICS = os.path.join(ROOT, 'metrics.jsonl')

FEEDBACK_LOCK = threading.Lock()
FEEDBACK = {}
FEEDBACK_TTL = 120.0
MAX_SESSIONS = 64


def prune_feedback():
    now = time.time()
    stale = [k for k, v in FEEDBACK.items() if now - v.get('ts', 0) > FEEDBACK_TTL]
    for k in stale:
        FEEDBACK.pop(k, None)
    if len(FEEDBACK) > MAX_SESSIONS:
        for k, _ in sorted(FEEDBACK.items(), key=lambda kv: kv[1].get('ts', 0))[:len(FEEDBACK) - MAX_SESSIONS]:
            FEEDBACK.pop(k, None)


class Handler(http.server.SimpleHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'          # keep-alive: no TLS handshake per poll

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def log_message(self, fmt, *args):
        if args and str(args[0]).startswith(('4', '5')):
            super().log_message(fmt, *args)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Content-Length', '0')
        self.end_headers()

    def _send_json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _fail(self, code):
        self.send_response(code)
        self.send_header('Content-Length', '0')
        self.end_headers()

    # -- GET ---------------------------------------------------------------
    def do_GET(self):
        if self.path.startswith('/feedback'):
            return self._feedback_get()
        return super().do_GET()

    def _feedback_get(self):
        from urllib.parse import urlparse, parse_qs
        qs = parse_qs(urlparse(self.path).query)
        session = (qs.get('session') or [''])[0]
        with FEEDBACK_LOCK:
            prune_feedback()
            payload = FEEDBACK.get(session, {}) if session else dict(FEEDBACK)
        self._send_json(payload)

    # -- POST --------------------------------------------------------------
    def do_POST(self):
        if self.path.startswith('/feedback'):
            return self._feedback_post()
        if self.path.startswith('/metrics'):
            return self._metrics_post()
        return self._fail(404)

    def _read_json(self, limit=131072):
        try:
            length = int(self.headers.get('Content-Length', '0'))
        except ValueError:
            return None
        if length <= 0 or length > limit:
            return None
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode('utf-8'))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return None

    def _feedback_post(self):
        data = self._read_json()
        if not data:
            return self._fail(400)
        session = str(data.get('session', '')).strip()
        if not session or len(session) > 64:
            return self._fail(400)
        data['ts'] = time.time()
        with FEEDBACK_LOCK:
            prune_feedback()
            FEEDBACK[session] = data
        self.send_response(204)
        self.send_header('Content-Length', '0')
        self.end_headers()

    def _metrics_post(self):
        data = self._read_json(limit=1048576)
        if not data:
            return self._fail(400)
        try:
            with open(METRICS, 'a', encoding='utf-8') as f:
                f.write(json.dumps(data, separators=(',', ':')) + '\n')
        except OSError:
            return self._fail(500)
        self.send_response(204)
        self.send_header('Content-Length', '0')
        self.end_headers()


def lan_ip():
    """Best-effort local address, without needing internet access."""
    for target in ('10.255.255.255', '192.168.255.255', '127.0.0.1'):
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect((target, 1))
            ip = s.getsockname()[0]
            if ip and not ip.startswith('127.'):
                return ip
        except OSError:
            pass
        finally:
            s.close()
    try:
        return socket.gethostbyname(socket.gethostname())
    except OSError:
        return '127.0.0.1'


def main():
    cert = os.path.join(ROOT, 'cert.pem')
    key = os.path.join(ROOT, 'key.pem')
    if not (os.path.exists(cert) and os.path.exists(key)):
        sys.exit('cert.pem / key.pem missing — run: python make_cert.py')

    httpd = http.server.ThreadingHTTPServer(('0.0.0.0', PORT), Handler)
    httpd.daemon_threads = True
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(cert, key)
    httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)

    ip = lan_ip()
    print()
    print('  QR-Stream')
    print('  ' + '-' * 52)
    print(f'  PC     (sender)   https://localhost:{PORT}/sender.html')
    print(f'  Phone  (receiver) https://{ip}:{PORT}/receiver.html')
    print('  ' + '-' * 52)
    print('  The certificate is self-signed, so the phone will ask once.')
    print('  Everything is served from this folder — no internet needed.')
    print('  Ctrl+C to stop.')
    print()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print('\nbye.')


if __name__ == '__main__':
    main()
