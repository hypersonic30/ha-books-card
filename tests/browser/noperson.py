"""A Home Assistant user without a person in the integration gets 403 no_person: the card says so in German."""
from _server import *
from playwright.sync_api import sync_playwright
fails = []
def check(n, c, extra=""):
    print(("PASS " if c else "FAIL ") + n, "" if c else extra)
    if not c: fails.append(n)
with sync_playwright() as p:
    b = p.chromium.launch(channel="chrome", headless=True, args=["--no-sandbox"])
    pg = b.new_page(viewport={"width": 420, "height": 900}); errs = []; pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto("http://127.0.0.1:8321/page.html")
    msg = pg.evaluate("() => errMessage({status: 403, body: {code: 'no_person', error: 'No person is set up for your Home Assistant user.'}})")
    check("no_person is translated into a German hint", msg.startswith("Für dein Konto ist keine Person angelegt") and "Person hinzufügen" in msg, msg)
    check("other errors keep their text", pg.evaluate("() => errMessage({status: 503, body: {error: 'Chaptarr is not configured'}})") == "Chaptarr is not configured")
    check("no page errors", not errs, errs)
    b.close()
print("ALL PASSED" if not fails else f"FAILED: {fails}"); sys.exit(1 if fails else 0)
