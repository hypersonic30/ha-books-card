"""Audiobook player: the cover must stay when the chapter list opens/closes and while playing (real browser)."""
import os, sys
from _server import *
from playwright.sync_api import sync_playwright

fails = []
def check(n, c, extra=""):
    print(("PASS " if c else "FAIL ") + n, "" if c else f"\n      {extra}")
    if not c: fails.append(n)

with sync_playwright() as p:
    b = p.chromium.launch(channel="chrome", headless=True, args=["--no-sandbox"])
    pg = b.new_page(viewport={"width": 420, "height": 860}); errs = []; pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto("http://127.0.0.1:8321/page.html")
    pg.evaluate("""() => { const c = document.createElement('books-card'); c.setConfig({type:'custom:books-card'}); document.body.appendChild(c); c.hass = window.hassStub; window.card = c; }""")
    pg.wait_for_timeout(300)
    # a minimal, realistic player state (what startPlayback() would have built)
    pg.evaluate("""() => {
        card._player = { item: { id: 'abc123', media: { metadata: { title: 'Ein Hörbuch' } } }, session: { displayTitle: 'Ein Hörbuch', displayAuthor: 'Autor' },
                         tracks: [{ startOffset: 0, duration: 3600 }], trackIndex: 0, duration: 3600, speed: 1,
                         chapters: [ {id: 0, start: 0, end: 1200, title: 'Kapitel 1'}, {id: 1, start: 1200, end: 2400, title: 'Kapitel 2'}, {id: 2, start: 2400, end: 3600, title: 'Kapitel 3'} ] };
        card._playerOpen = true; card._render(); }""")
    pg.wait_for_timeout(600)
    info = lambda: pg.evaluate("""() => { const d = card._playerDialog; const img = d.querySelector('.bc-cover img'); const cover = d.querySelector('.bc-cover');
        const r = cover && cover.getBoundingClientRect();
        return { open: d.open, img: !!img, src: img ? img.getAttribute('src') : null, chapters: !!d.querySelector('.bc-chapters'), w: r ? Math.round(r.width) : 0, h: r ? Math.round(r.height) : 0,
                 fallbackVisible: !!d.querySelector('.bc-cover-fallback') && !img }; }""")
    s = info(); print("player opened:", s)
    check("cover image present with a src when the player opens", s["img"] and bool(s["src"]), s)
    pg.evaluate("() => card._onAction_toggleChapters()"); pg.wait_for_timeout(600)
    s = info(); print("chapters open:", s)
    check("chapter list is shown", s["chapters"], s)
    check("cover image STILL there after opening the chapter list", s["img"] and bool(s["src"]), s)
    check("cover is smaller but visible (>= 100 px)", s["w"] >= 100 and s["h"] >= 100, s)
    pg.evaluate("() => card._onAction_toggleChapters()"); pg.wait_for_timeout(600)
    s = info(); print("chapters closed:", s)
    check("cover image there after closing the chapter list again", s["img"] and bool(s["src"]) and not s["chapters"], s)
    for n in range(3):                                            # toggling repeatedly must stay stable
        pg.evaluate("() => card._onAction_toggleChapters()"); pg.wait_for_timeout(250)
    s = info(); check("cover present after repeated toggling", s["img"] and bool(s["src"]), s)
    check("no page errors", not errs, errs)
    b.close()
print("ALL PASSED" if not fails else f"FAILED: {fails}"); sys.exit(1 if fails else 0)
