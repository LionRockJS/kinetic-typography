#!/usr/bin/env python3
"""Tiny static server for local development (no caching, correct MIME types)."""
import functools, http.server, socketserver, sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 5178


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        '.js': 'text/javascript', '.mjs': 'text/javascript',
        '.json': 'application/json', '.woff': 'font/woff', '.otf': 'font/otf', '.ttf': 'font/ttf',
    }

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        super().end_headers()

    def log_message(self, fmt, *args):
        pass


with socketserver.TCPServer(('', PORT), Handler) as httpd:
    print(f'serving http://localhost:{PORT}')
    httpd.serve_forever()
