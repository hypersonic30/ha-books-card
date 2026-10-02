"""Child protection: for a restricted person the integration closes search, requests and downloads; the card shows only the library."""
import os, sys
from _server import *
from playwright.sync_api import sync_playwright
fails = []
def check(n, c, extra=""):
    print(("PASS " if c else "FAIL ") + n, "" if c else extra)
    if not c: fails.append(n)

SETUP = """(mode) => {
  window.mode = mode;
  const item = (id, title) => ({ id, libraryId: 'L1', mediaType: 'book', media: { metadata: { title, authorName: 'A' }, tags: ['für Lena'] } });
  const base = window.hassStub.callApi;
  window.hassStub.callApi = async (method, path, body) => {
    window.calls.push({ method, path });
    if (path === 'books/people') return window.mode === 'people' ? { people: [{ name: 'Lena', tag: 'für Lena', me: true }], restricted: true } : { people: [] };
    if (path.startsWith('books/chaptarr/') || path === 'books/rescue') {
      if (window.mode === 'locked' || window.mode === 'people') throw { status: 403, body: { code: 'restricted', error: 'Für dein Konto ist das gesperrt (Kinderschutz).' } };
      return path.startsWith('books/chaptarr/queue') ? { records: [] } : {};
    }
    if (path === 'books/abs/libraries') return { libraries: [{ id: 'L1', name: 'eBooks', mediaType: 'book', displayOrder: 1 }] };
    if (path.startsWith('books/abs/libraries/L1/items')) return { results: [item('a', 'Pixi-Buch')] };
    if (path === 'books/abs/me') return { mediaProgress: [] };
    if (path === 'books/abs/me/items-in-progress') return { libraryItems: [] };
    return base(method, path, body);
  };
  const c = document.createElement('books-card'); c.setConfig({ type: 'custom:books-card', default_tab: 'search' }); document.body.appendChild(c); c.hass = window.hassStub; window.card = c;
}"""
TABS = "() => [...card.shadowRoot.querySelectorAll('.bc-nav-btn')].map(e => e.querySelector('span').textContent.trim())"
ERR = "() => card.shadowRoot.querySelector('.bc-error')?.textContent || ''"

with sync_playwright() as p:
    b = p.chromium.launch(channel="chrome", headless=True, args=["--no-sandbox"])
    for mode, label in (("people", "the people endpoint says restricted"), ("locked", "only the downloads call says restricted (older endpoint)")):
        pg = b.new_page(viewport={"width": 420, "height": 900}); errs = []; pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.goto("http://127.0.0.1:8321/page.html"); pg.evaluate(SETUP, mode); pg.wait_for_timeout(700)
        check(f"[{label}] only the library, no tab bar", pg.evaluate(TABS) == [] and pg.evaluate("() => card._activeTab") == "library", pg.evaluate(TABS))
        check(f"[{label}] the library still shows its book", "Pixi-Buch" in pg.evaluate("() => card.shadowRoot.textContent"))
        check(f"[{label}] no error banner for the closed downloads", pg.evaluate(ERR) == "", pg.evaluate(ERR))
        n = pg.evaluate("() => window.calls.filter(c => c.path.startsWith('books/chaptarr/')).length")
        pg.evaluate("() => { card._poll(); card._poll(); }"); pg.wait_for_timeout(300)
        check(f"[{label}] polling does not ask Chaptarr again", pg.evaluate("() => window.calls.filter(c => c.path.startsWith('books/chaptarr/')).length") == n, n)
        check(f"[{label}] no page errors", not errs, errs); pg.close()
    pg = b.new_page(viewport={"width": 420, "height": 900}); pg.goto("http://127.0.0.1:8321/page.html"); pg.evaluate(SETUP, "open"); pg.wait_for_timeout(700)
    check("a person who is not restricted keeps all tabs", pg.evaluate(TABS) == ["Bibliothek", "Suchen", "Downloads"], pg.evaluate(TABS)); pg.close()
    b.close()
print("ALL PASSED" if not fails else f"FAILED: {fails}"); sys.exit(1 if fails else 0)
