"""Shared test setup: a tiny static server (127.0.0.1:8321) that serves the card, the stub page and a few fixtures.

Every test script starts with `from _server import *` (imports, HERE, the running server, `check`-style helpers stay in
the scripts). Fixtures: cover.png (any cover URL), current.epub (what /…/ebook returns; tests copy the EPUB they need onto it).
"""
import http.server, threading, sys, functools, os, json, shutil
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
CARD = os.path.abspath(os.path.join(HERE, "..", "..", "books-card.js"))
if not os.path.exists(os.path.join(HERE, "current.epub")):
    shutil.copy(os.path.join(HERE, "testbuch.epub"), os.path.join(HERE, "current.epub"))


class H(http.server.SimpleHTTPRequestHandler):
    def translate_path(self, path):
        p = path.split("?")[0]
        if p.startswith("/api/books/abs/items/abc123/cover"):
            return os.path.join(HERE, "cover.png")
        if p.startswith("/api/books/abs/items/abc123/ebook"):
            return os.path.join(HERE, "current.epub")
        return CARD if p == "/books-card.js" else os.path.join(HERE, p.lstrip("/") or "page.html")

    def log_message(self, *a):
        pass


srv = http.server.ThreadingHTTPServer(("127.0.0.1", 8321), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()
