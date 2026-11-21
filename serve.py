#!/usr/bin/env python3
import os
import re
import sys
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

OUT_DIR = os.path.dirname(os.path.abspath(__file__))


class RangeHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=OUT_DIR, **kwargs)

    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Cache-Control", "public, max-age=31536000, immutable" if ("?v=" in self.path or "/packs/" in self.path) else "no-cache")
        super().end_headers()

    def do_GET(self):
        rng = self.headers.get("Range")
        path = self.translate_path(self.path)
        m = re.match(r"bytes=(\d*)-(\d*)$", rng or "")
        if not m or not os.path.isfile(path):
            return super().do_GET()
        size = os.path.getsize(path)
        if m.group(1) == "":
            start, end = max(0, size - int(m.group(2))), size - 1
        else:
            start = int(m.group(1))
            end = min(int(m.group(2)), size - 1) if m.group(2) else size - 1
        if start >= size or start > end:
            self.send_response(416)
            self.send_header("Content-Range", "bytes */%d" % size)
            self.end_headers()
            return
        length = end - start + 1
        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, size))
        self.send_header("Content-Length", str(length))
        self.end_headers()
        with open(path, "rb") as f:
            f.seek(start)
            remaining = length
            while remaining > 0:
                chunk = f.read(min(1 << 20, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8150
    print("serving %s on http://127.0.0.1:%d/ (Range supported)" % (OUT_DIR, port))
    server = ThreadingHTTPServer(("127.0.0.1", port), RangeHandler)
    server.daemon_threads = True
    server.serve_forever()


if __name__ == "__main__":
    main()
