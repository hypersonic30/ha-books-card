"""When the bridge is down, the card offers the file instead - but not for problems with the book itself."""
import os, sys
from _server import *
from playwright.sync_api import sync_playwright
fails = []
def check(n, c, extra=""):
    print(("PASS " if c else "FAIL ") + n, "" if c else f"\n      {extra}")
    if not c: fails.append(n)
def fresh(b, code, status):
    pg = b.new_page(viewport={"width": 420, "height": 900}); errs = []; pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto("http://127.0.0.1:8321/page.html")
    pg.evaluate("s => Object.assign(window.scenario, s)", {"post": {"ok": False, "status": status, "code": code, "error": "x"}})
    pg.evaluate("""() => { const c = document.createElement('books-card'); c.setConfig({type:'custom:books-card'}); document.body.appendChild(c); c.hass = window.hassStub; window.card = c; }""")
    pg.wait_for_timeout(300); pg.evaluate("async () => { await card._onAction_openDetail({dataset:{id:'abc123'}}); }"); pg.wait_for_timeout(300)
    pg.evaluate("() => card._overlayRoot.querySelector('[data-action=sendToTolino]').click()"); pg.wait_for_timeout(500)
    return pg, errs
has_btn = lambda pg: pg.evaluate("() => !!card._overlayRoot.querySelector('[data-action=sendToTolinoFile]')")
with sync_playwright() as p:
    b = p.chromium.launch(channel="chrome", headless=True, args=["--no-sandbox"])
    for code, status in (("captcha", 503), ("unreachable", 503), ("login_backoff", 503), ("2fa", 503)):
        pg, errs = fresh(b, code, status); check(f"[{code}] file fallback offered", has_btn(pg)); pg.close()
    for code, status in (("bad_type", 415), ("too_large", 413), ("convert_failed", 422), ("no_ebook", 422)):
        pg, errs = fresh(b, code, status); check(f"[{code}] no fallback (the book itself is the problem)", not has_btn(pg)); pg.close()
    pg, errs = fresh(b, "captcha", 503)
    pg.evaluate("() => card._overlayRoot.querySelector('[data-action=sendToTolinoFile]').click()"); pg.wait_for_timeout(800)
    txt = pg.evaluate("() => card._overlayRoot.getElementById('bc-detail').innerText")
    check("clicking it starts the download path and replaces the error", "Download gestartet" in txt and "Bot-Schutz" not in txt, txt[-260:])
    check("no page errors", not errs, errs); pg.close(); b.close()
print("ALL PASSED" if not fails else f"FAILED: {fails}"); sys.exit(1 if fails else 0)
