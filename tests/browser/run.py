"""tolino send button: cloud path, error codes, share-sheet fallback."""
from _server import *

fails = []
def check(name, cond, extra=""):
    print(("PASS " if cond else "FAIL ") + name, extra if not cond else "")
    if not cond: fails.append(name)

with sync_playwright() as p:
    b = p.chromium.launch(channel="chrome", headless=True, args=["--no-sandbox"])
    def fresh(scn):
        pg = b.new_page(viewport={"width": 420, "height": 900})
        errs = []; pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.goto("http://127.0.0.1:8321/page.html")
        pg.evaluate("s => Object.assign(window.scenario, s)", scn)
        pg.evaluate("""() => { const c = document.createElement('books-card'); c.setConfig({type:'custom:books-card'}); document.body.appendChild(c); c.hass = window.hassStub; window.card = c; }""")
        pg.wait_for_timeout(300)
        pg.evaluate("async () => { await card._onAction_openDetail({dataset:{id:'abc123'}}); }")
        pg.wait_for_timeout(300)
        return pg, errs
    def overlay_text(pg):
        return pg.evaluate("() => card._overlayRoot.getElementById('bc-detail').innerText")
    def click_send(pg):
        pg.evaluate("() => card._overlayRoot.querySelector('[data-action=sendToTolino]').click()")
        pg.wait_for_timeout(500)

    # 1. cloud success
    pg, errs = fresh({})
    t = overlay_text(pg)
    check("hint mentions Cloud when enabled", "tolino Cloud" in t, t[-200:])
    click_send(pg)
    posts = pg.evaluate("() => calls.filter(c => c.method==='POST')")
    check("POST books/tolino with abs_item_id", posts == [{"method":"POST","path":"books/tolino","body":{"abs_item_id":"abc123"}}], posts)
    t = overlay_text(pg)
    check("success notice", "Synchronisieren" in t and "In deiner tolino Cloud" in t, t[-200:])
    check("no error toast class", pg.evaluate("() => !card._overlayRoot.querySelector('.bc-toast.err')"))
    check("no page errors", not errs, errs)
    # button re-enabled
    check("button re-enabled", pg.evaluate("() => !card._overlayRoot.querySelector('[data-action=sendToTolino]').disabled"))

    # 2. error codes -> German messages
    for code, status, needle in [("captcha",503,"Bot-Schutz"),("login_backoff",503,"pausiert"),("bad_type",415,"EPUB und PDF"),
                                 ("unreachable",503,"nicht erreichbar"),("no_converter",415,"Calibre"),("convert_failed",422,"Kopierschutz"),("weird_code",502,"Senden fehlgeschlagen")]:
        pg, errs = fresh({"post": {"ok": False, "status": status, "code": code, "error": "raw detail"}})
        click_send(pg)
        t = overlay_text(pg)
        check(f"error {code} -> German", needle in t, t[-160:])
        check(f"error {code} styled as error", pg.evaluate("() => !!card._overlayRoot.querySelector('.bc-toast.err')"))
        pg.close()

    # 3. fallback: bridge not configured / old integration without endpoint
    for label, tol in (("disabled", {"enabled": False}), ("404", "404")):
        pg, errs = fresh({"tolino": tol})
        t = overlay_text(pg)
        check(f"fallback hint ({label})", "Teilen-Menü" in t, t[-200:])
        pg.evaluate("() => { window.__dl = null; }")
        click_send(pg)
        posts = pg.evaluate("() => calls.filter(c => c.method==='POST' && c.path==='books/tolino')")
        check(f"fallback ({label}) does not POST to bridge", posts == [])
        pg.close()
    b.close()
print("FAILED:", fails) if fails else print("ALL PASSED")
sys.exit(1 if fails else 0)
