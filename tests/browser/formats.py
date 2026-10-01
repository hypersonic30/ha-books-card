import os, sys
from _server import *
from playwright.sync_api import sync_playwright
fails = []
def check(n, c, extra=""):
    print(("PASS " if c else "FAIL ") + n, "" if c else extra)
    if not c: fails.append(n)
with sync_playwright() as p:
    b = p.chromium.launch(channel="chrome", headless=True, args=["--no-sandbox"])
    for fmt, readable in (("epub", True), ("mobi", False), ("azw3", False), ("pdf", False)):
        pg = b.new_page(viewport={"width": 420, "height": 900}); errs = []; pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.goto("http://127.0.0.1:8321/page.html")
        pg.evaluate("f => { window.scenario.ebookFormat = f; }", fmt)
        pg.evaluate("""() => { const c = document.createElement('books-card'); c.setConfig({type:'custom:books-card'}); document.body.appendChild(c); c.hass = window.hassStub; window.card = c; }""")
        pg.wait_for_timeout(300); pg.evaluate("async () => { await card._onAction_openDetail({dataset:{id:'abc123'}}); }"); pg.wait_for_timeout(400)
        t = pg.evaluate("() => card._overlayRoot.getElementById('bc-detail').innerText")
        has_read = pg.evaluate("() => !!card._overlayRoot.querySelector('[data-action=openReader]')")
        has_send = pg.evaluate("() => !!card._overlayRoot.querySelector('[data-action=sendToTolino]')")
        check(f"[{fmt}] Lesen button {'shown' if readable else 'hidden'}", has_read == readable, t[-200:])
        check(f"[{fmt}] An tolino always offered", has_send)
        if not readable:
            check(f"[{fmt}] explains why + mentions conversion", fmt.upper() in t and "umgewandelt" in t, t[-260:])
        check(f"[{fmt}] no page errors", not errs, errs); pg.close()
    b.close()
print("ALL PASSED" if not fails else f"FAILED: {fails}"); sys.exit(1 if fails else 0)
