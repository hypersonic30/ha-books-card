import os, sys
from _server import *
from playwright.sync_api import sync_playwright
fails = []
def check(n, c, extra=""):
    print(("PASS " if c else "FAIL ") + n, "" if c else extra)
    if not c: fails.append(n)
def fresh(b, scn, confirm):
    pg = b.new_page(viewport={"width": 420, "height": 900}); errs = []; pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto("http://127.0.0.1:8321/page.html")
    pg.evaluate("s => Object.assign(window.scenario, s)", scn)
    pg.evaluate("c => { window.confirmText = null; window.confirm = (t) => { window.confirmText = t; return c; }; }", confirm)
    pg.evaluate("""() => { const c = document.createElement('books-card'); c.setConfig({type:'custom:books-card'}); document.body.appendChild(c); c.hass = window.hassStub; window.card = c; }""")
    pg.wait_for_timeout(300); pg.evaluate("async () => { await card._onAction_openDetail({dataset:{id:'abc123'}}); }"); pg.wait_for_timeout(300)
    return pg, errs
T = lambda pg: pg.evaluate("() => card._overlayRoot.getElementById('bc-detail').innerText")
def send(pg):
    pg.evaluate("() => card._overlayRoot.querySelector('[data-action=sendToTolino]').click()"); pg.wait_for_timeout(600)
posts = lambda pg: pg.evaluate("() => calls.filter(c => c.method==='POST' && c.path==='books/tolino').map(c => c.body)")
SENT = {"enabled": True, "reachable": True, "logged_in": True, "sent": {"abc123": {"at": "2026-09-28T10:00:00+00:00"}}}
with sync_playwright() as p:
    b = p.chromium.launch(channel="chrome", headless=True, args=["--no-sandbox"])
    # a) already-sent book is labelled as such
    pg, errs = fresh(b, {"tolino": SENT}, True); t = T(pg)
    check("label 'Erneut an tolino'", "Erneut an tolino" in t, t[-160:])
    check("hint shows German date", "gesendet am 28.09.2026" in t, t[-200:]); pg.close()
    # b) 409 -> confirm yes -> second POST with force -> 'Ersetzt'
    pg, errs = fresh(b, {"tolino": SENT, "postQueue": [{"ok": False, "status": 409, "code": "already_sent", "error": "x", "sent_at": "2026-09-28T10:00:00+00:00"}, {"ok": True, "replaced": True}]}, True)
    send(pg); ps = posts(pg); t = T(pg)
    check("two POSTs: plain then force", ps == [{"abs_item_id": "abc123"}, {"abs_item_id": "abc123", "force": True}], ps)
    check("confirm mentions date + deletion", pg.evaluate("() => /28\\.09\\.2026/.test(confirmText) && /gelöscht/.test(confirmText)"), pg.evaluate("() => confirmText"))
    check("notice says Ersetzt", "Ersetzt." in t, t[-200:])
    check("no error styling", pg.evaluate("() => !card._overlayRoot.querySelector('.bc-toast.err')")); check("no page errors", not errs, errs); pg.close()
    # c) confirm NO -> only one POST, no error, no success notice
    pg, errs = fresh(b, {"tolino": SENT, "postQueue": [{"ok": False, "status": 409, "code": "already_sent", "error": "x", "sent_at": "2026-09-28T10:00:00+00:00"}]}, False)
    send(pg); t = T(pg)
    check("declined: exactly one POST", len(posts(pg)) == 1, posts(pg))
    check("declined: no notice at all", pg.evaluate("() => !card._overlayRoot.querySelector('.bc-toast')"), t[-200:])
    check("declined: button usable again", pg.evaluate("() => !card._overlayRoot.querySelector('[data-action=sendToTolino]').disabled")); pg.close()
    # d) first send of a new book: no confirm, label updates to 'Erneut'
    pg, errs = fresh(b, {"tolino": {"enabled": True, "reachable": True, "logged_in": True, "sent": {}}, "postQueue": [{"ok": True, "replaced": None}]}, True)
    check("fresh book: plain label", "Erneut" not in T(pg)); send(pg); t = T(pg)
    check("fresh book: success notice", "In deiner tolino Cloud." in t, t[-160:])
    check("fresh book: no confirm asked", pg.evaluate("() => confirmText === null"))
    check("fresh book: label switches to Erneut", "Erneut an tolino" in t, t[-200:]); pg.close()
    # e) replaced=false is reported honestly
    pg, errs = fresh(b, {"tolino": SENT, "postQueue": [{"ok": False, "status": 409, "code": "already_sent", "error": "x", "sent_at": "2026-09-28T10:00:00+00:00"}, {"ok": True, "replaced": False}]}, True)
    send(pg); t = T(pg); check("old copy not deletable -> says so", "doppelt in der Cloud" in t, t[-200:]); pg.close()
    b.close()
print("ALL PASSED" if not fails else f"FAILED: {fails}"); sys.exit(1 if fails else 0)
