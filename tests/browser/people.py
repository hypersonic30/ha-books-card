"""Library chips per person: one library, books told apart by the tag "für <name>"; untagged books are for everybody."""
import os, sys
from _server import *
from playwright.sync_api import sync_playwright
fails = []
def check(n, c, extra=""):
    print(("PASS " if c else "FAIL ") + n, "" if c else extra)
    if not c: fails.append(n)

SETUP = """(people) => {
  window.scenarioPeople = people;
  const item = (id, title, tags) => ({ id, libraryId: 'L1', mediaType: 'book', media: { metadata: { title, authorName: 'A' }, tags } });
  const items = [item('o1', 'Altbestand', []), item('a1', 'Annas Buch', ['für Anna']), item('b1', 'Bens Buch', ['für Ben']),
                 item('x1', 'Mit Fremdtag', ['Fantasy']), item('ab', 'Beiden', ['für Anna', 'für Ben'])];
  const base = window.hassStub.callApi;
  window.hassStub.callApi = async (method, path, body) => {
    if (path === 'books/people') { if (window.scenarioPeople === '404') throw { status: 404, body: {} }; return { people: window.scenarioPeople }; }
    if (path === 'books/abs/libraries') return { libraries: [{ id: 'L1', name: 'eBooks', mediaType: 'book', displayOrder: 1 }] };
    if (path.startsWith('books/abs/libraries/L1/items')) return { results: items };
    if (path === 'books/abs/me') return { mediaProgress: [] };
    if (path === 'books/abs/me/items-in-progress') return { libraryItems: [items[1], items[2]] };
    return base(method, path, body);
  };
  const c = document.createElement('books-card'); c.setConfig({ type: 'custom:books-card' }); document.body.appendChild(c); c.hass = window.hassStub; window.card = c;
}"""
TWO = [{"name": "Anna", "tag": "für Anna", "me": True}, {"name": "Ben", "tag": "für Ben", "me": False}]
TITLES = "() => [...card.shadowRoot.querySelectorAll('.bc-grid .bc-tile-title')].map(e => e.textContent).sort()"
CHIPS = "() => [...card.shadowRoot.querySelectorAll('.bc-people .bc-chip')].map(e => e.textContent)"
ACTIVE = "() => card.shadowRoot.querySelector('.bc-people .bc-chip.active')?.textContent"
COUNT = "() => [...card.shadowRoot.querySelectorAll('.bc-section-title')].map(e => e.textContent).find(t => /Titel/.test(t))"
CONT = "() => { const t = [...card.shadowRoot.querySelectorAll('.bc-section-title')].find(e => e.textContent === 'Weiter'); return t ? [...t.nextElementSibling.querySelectorAll('.bc-tile-title')].map(e => e.textContent).sort() : []; }"

def click(pg, ident):
    pg.evaluate("id => card.shadowRoot.querySelector(`.bc-people [data-id='${id}']`).click()", ident); pg.wait_for_timeout(150)

with sync_playwright() as p:
    b = p.chromium.launch(channel="chrome", headless=True, args=["--no-sandbox"])
    ctx = b.new_context(viewport={"width": 420, "height": 900})
    pg = ctx.new_page(); errs = []; pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto("http://127.0.0.1:8321/page.html"); pg.evaluate(SETUP, TWO); pg.wait_for_timeout(500)
    check("chips: Alle, Für mich and the other person (not myself)", pg.evaluate(CHIPS) == ["Alle", "Für mich", "Ben"], pg.evaluate(CHIPS))
    check("default shows everything", len(pg.evaluate(TITLES)) == 5 and pg.evaluate(ACTIVE) == "Alle", pg.evaluate(TITLES))
    click(pg, "mine")
    check("Für mich = mine + untagged/foreign-tag books, not Ben's", pg.evaluate(TITLES) == ["Altbestand", "Annas Buch", "Beiden", "Mit Fremdtag"], pg.evaluate(TITLES))
    check("title count follows the chip", "4 Titel" in pg.evaluate(COUNT), pg.evaluate(COUNT))
    check("'Weiter' follows the chip", pg.evaluate(CONT) == ["Annas Buch"], pg.evaluate(CONT))
    click(pg, "für Ben")
    check("a person's chip = only their tagged books", pg.evaluate(TITLES) == ["Beiden", "Bens Buch"], pg.evaluate(TITLES))
    check("'Weiter' for Ben", pg.evaluate(CONT) == ["Bens Buch"], pg.evaluate(CONT))
    click(pg, "all")
    check("Alle shows everything again", len(pg.evaluate(TITLES)) == 5)
    click(pg, "für Ben")
    check("choice is remembered in the browser", pg.evaluate("() => localStorage.getItem('bc-person')") == "für Ben")
    pg.reload(); pg.evaluate(SETUP, TWO); pg.wait_for_timeout(500)
    check("a new card starts with the remembered chip", pg.evaluate(ACTIVE) == "Ben" and pg.evaluate(TITLES) == ["Beiden", "Bens Buch"], pg.evaluate(ACTIVE))
    pg.evaluate("() => localStorage.setItem('bc-person', 'für Gelöscht')"); pg.reload(); pg.evaluate(SETUP, TWO); pg.wait_for_timeout(500)
    check("an unknown remembered chip falls back to Alle", pg.evaluate(ACTIVE) == "Alle" and len(pg.evaluate(TITLES)) == 5, pg.evaluate(ACTIVE))
    check("no page errors", not errs, errs); pg.close()

    for label, people in (("one person", [TWO[0]]), ("endpoint missing (404)", "404")):
        pg = ctx.new_page(); pg.goto("http://127.0.0.1:8321/page.html"); pg.evaluate("() => localStorage.clear()"); pg.evaluate(SETUP, people); pg.wait_for_timeout(500)
        check(f"{label}: no person chips, nothing filtered", pg.evaluate(CHIPS) == [] and len(pg.evaluate(TITLES)) == 5, pg.evaluate(CHIPS)); pg.close()
    b.close()
print("ALL PASSED" if not fails else f"FAILED: {fails}"); sys.exit(1 if fails else 0)
