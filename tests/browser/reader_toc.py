import os, sys, shutil
from _server import *
from playwright.sync_api import sync_playwright
fails = []
def check(name, cond, extra=""):
    print(("PASS " if cond else "FAIL ") + name, "" if cond else extra)
    if not cond: fails.append(name)

def open_reader(b, epub):
    shutil.copy(os.path.join(HERE, epub), os.path.join(HERE, "current.epub"))
    pg = b.new_page(viewport={"width": 420, "height": 900}); errs = []; pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto("http://127.0.0.1:8321/page.html")
    pg.evaluate("""() => { const c = document.createElement('books-card'); c.setConfig({type:'custom:books-card'}); document.body.appendChild(c); c.hass = window.hassStub; window.card = c; }""")
    pg.wait_for_timeout(300)
    pg.evaluate("async () => { await card._onAction_openDetail({dataset:{id:'abc123'}}); }"); pg.wait_for_timeout(300)
    pg.evaluate("() => card._onAction_openReader({dataset:{id:'abc123'}})")
    pg.wait_for_function("() => card._rendition && card._readerState.loading === false", timeout=40000)
    pg.wait_for_function("() => card._readerState.toc !== undefined", timeout=10000); pg.wait_for_timeout(400)
    return pg, errs

R = lambda pg, js: pg.evaluate("() => { const d = card._readerDialog; return " + js + " }")
with sync_playwright() as p:
    b = p.chromium.launch(channel="chrome", headless=True, args=["--no-sandbox"])
    for epub, label in (("epub3.epub", "EPUB3 nested nav"), ("epub2.epub", "EPUB2 ncx")):
        pg, errs = open_reader(b, epub)
        n = R(pg, "card._readerState.toc.length")
        check(f"[{label}] toc has 4 entries", n == 4, n)
        check(f"[{label}] chapter button visible", R(pg, "!d.querySelector('#bc-reader-toc-btn').hidden"))
        check(f"[{label}] panel initially closed", R(pg, "d.querySelector('#bc-reader-toc').hidden"))
        if "EPUB3" in label:
            check("nested chapter is indented", R(pg, "card._readerState.toc.map(c => c.depth).join()") == "0,0,1,0", R(pg, "card._readerState.toc.map(c => c.depth).join()"))
        pg.evaluate("() => card._onAction_toggleReaderToc()"); pg.wait_for_timeout(200)
        items = R(pg, "[...d.querySelectorAll('.bc-toc-item')].map(e => e.textContent)")
        check(f"[{label}] panel lists chapters", items == ["Vorwort", "Teil Eins", "Erstes Kapitel", "Ende"], items)
        check(f"[{label}] current = first chapter", R(pg, "d.querySelector('.bc-toc-item.current')?.textContent") == "Vorwort")
        # jump to the last chapter ("Ende") via a real click on the item
        pg.evaluate("() => d_click()") if False else None
        pg.evaluate("() => card._readerDialog.querySelectorAll('.bc-toc-item')[3].click()"); pg.wait_for_timeout(1200)
        href = pg.evaluate("() => card._rendition.currentLocation().start.href")
        check(f"[{label}] jump lands in last chapter", "c4" in href, href)
        check(f"[{label}] panel closed after jump", R(pg, "d.querySelector('#bc-reader-toc').hidden"))
        check(f"[{label}] jump counts as movement (position gets saved)", pg.evaluate("() => card._readerMoved === true"))
        pg.evaluate("() => card._onAction_toggleReaderToc()"); pg.wait_for_timeout(200)
        check(f"[{label}] current highlight follows to 'Ende'", R(pg, "d.querySelector('.bc-toc-item.current')?.textContent") == "Ende")
        # back to a middle (nested) chapter
        pg.evaluate("() => card._readerDialog.querySelectorAll('.bc-toc-item')[2].click()"); pg.wait_for_timeout(1200)
        href = pg.evaluate("() => card._rendition.currentLocation().start.href")
        check(f"[{label}] jump back to nested chapter", "c3" in href, href)
        # menu and toc are mutually exclusive
        pg.evaluate("() => card._onAction_toggleReaderToc()"); pg.evaluate("() => card._onAction_toggleReaderMenu()")
        check(f"[{label}] opening the menu closes the toc", R(pg, "d.querySelector('#bc-reader-toc').hidden && !d.querySelector('#bc-reader-menu').hidden"))
        check(f"[{label}] no page errors", not errs, errs); pg.close()
    # book without a table of contents -> no chapter button
    pg, errs = open_reader(b, "current.epub") if False else (None, None)
    shutil.copy(os.path.join(HERE, "testbuch.epub"), os.path.join(HERE, "notoc.epub"))
    pg, errs = open_reader(b, "notoc.epub")
    n = R(pg, "card._readerState.toc.length")
    check(f"[no toc] button hidden (toc entries: {n})", R(pg, "d.querySelector('#bc-reader-toc-btn').hidden"), n)
    check("[no toc] no page errors", not errs, errs); pg.close(); b.close()
print("ALL PASSED" if not fails else f"FAILED: {fails}"); sys.exit(1 if fails else 0)
