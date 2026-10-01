import os, sys, runpy
from _server import *
from playwright.sync_api import sync_playwright
RGB = {"hell": "rgb(255, 255, 255)", "sepia": "rgb(244, 236, 216)", "dunkel": "rgb(18, 18, 18)"}
fails = []
with sync_playwright() as p:
    b = p.chromium.launch(channel="chrome", headless=True, args=["--no-sandbox"])
    pg = b.new_page(viewport={"width": 420, "height": 900})
    errs = []; pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto("http://127.0.0.1:8321/page.html")
    pg.evaluate("""() => { const c = document.createElement('books-card'); c.setConfig({type:'custom:books-card'}); document.body.appendChild(c); c.hass = window.hassStub; window.card = c; }""")
    pg.wait_for_timeout(300)
    pg.evaluate("async () => { await card._onAction_openDetail({dataset:{id:'abc123'}}); }"); pg.wait_for_timeout(300)
    pg.evaluate("() => card._onAction_openReader({dataset:{id:'abc123'}})")
    pg.wait_for_function("() => card._rendition && card._readerState.loading === false", timeout=40000)
    def bg():
        return pg.evaluate("""() => { const c = card._rendition.getContents()[0]; return getComputedStyle(c.document.body).backgroundColor; }""")
    for theme in ["hell", "sepia", "hell", "dunkel", "hell", "dunkel", "sepia", "dunkel", "hell"]:
        pg.evaluate("t => card._onAction_readerTheme({dataset:{theme:t}})", theme); pg.wait_for_timeout(150)
        got = bg(); ok = got == RGB[theme]
        print(("PASS " if ok else "FAIL ") + f"-> {theme:7} body background {got}")
        if not ok: fails.append(theme)
    # theme must also survive turning the page / re-render of the section
    pg.evaluate("t => card._onAction_readerTheme({dataset:{theme:t}})", "sepia"); pg.wait_for_timeout(100)
    pg.evaluate("async () => { await card._rendition.next(); }"); pg.wait_for_timeout(500)
    got = bg(); ok = got == RGB["sepia"]; print(("PASS " if ok else "FAIL ") + f"sepia persists after next(): {got}"); 
    if not ok: fails.append("persist")
    print("page errors:", errs); b.close()
print("ALL PASSED" if not fails else f"FAILED: {fails}"); sys.exit(1 if fails else 0)
