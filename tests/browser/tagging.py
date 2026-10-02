"""Release a book for a person or for everybody from the detail sheet ("Für wen?"); locked people do not get the block."""
import json, sys
from _server import *
from playwright.sync_api import sync_playwright
fails = []
def check(n, c, extra=""):
    print(("PASS " if c else "FAIL ") + n, "" if c else extra)
    if not c: fails.append(n)

SETUP = """(mode) => {
  window.mode = mode; window.posts = [];
  const people = [{ name: 'Anna', tag: 'für Anna', me: true }, { name: 'Ben', tag: 'für Ben', me: false }];
  const tags = ['Fantasy', 'für Ben'];
  const base = window.hassStub.callApi;
  window.hassStub.callApi = async (method, path, body) => {
    if (path === 'books/people') return { people, restricted: false, can_tag: mode !== 'cannot', shared_tag: 'für alle' };
    if (path === 'books/tags' && method === 'POST') {
      window.posts.push(body);
      if (mode === 'error') throw { status: 502, body: { code: 'abs_update_denied', error: 'Der Audiobookshelf-Benutzer darf keine Tags ändern.' } };
      const cur = new Set(window.serverTags || tags); body.tagged ? cur.add(body.tag) : cur.delete(body.tag); window.serverTags = [...cur];
      return { tags: window.serverTags.filter((t) => t.startsWith('für ')) };
    }
    if (path === 'books/abs/libraries') return { libraries: [{ id: 'L1', name: 'eBooks', mediaType: 'book', displayOrder: 1 }] };
    if (path.startsWith('books/abs/libraries/L1/items')) return { results: [{ id: 'b1', libraryId: 'L1', mediaType: 'book', media: { metadata: { title: 'Pixi', authorName: 'A' }, tags: [...tags] } }] };
    if (path === 'books/abs/me') return { mediaProgress: [] };
    if (path === 'books/abs/me/items-in-progress') return { libraryItems: [] };
    if (path.startsWith('books/abs/items/b1')) return { id: 'b1', mediaType: 'book', media: { metadata: { title: 'Pixi', authors: [] }, tags: [...tags], ebookFile: { ebookFormat: 'epub' } } };
    return base(method, path, body);
  };
  const c = document.createElement('books-card'); c.setConfig({ type: 'custom:books-card' }); document.body.appendChild(c); c.hass = window.hassStub; window.card = c;
}"""
CHIPS = "() => [...card._overlayRoot.querySelectorAll('.bc-tagchips .bc-chip')].map(e => e.textContent + (e.classList.contains('active') ? '*' : ''))"
CLICK = "(tag) => card._overlayRoot.querySelector(`.bc-tagchips [data-tag='${tag}']`).click()"

def open_detail(pg):
    pg.evaluate("async () => { await card._onAction_openDetail({dataset:{id:'b1'}}); }"); pg.wait_for_timeout(300)

with sync_playwright() as p:
    b = p.chromium.launch(channel="chrome", headless=True, args=["--no-sandbox"])
    pg = b.new_page(viewport={"width": 420, "height": 900}); errs = []; pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto("http://127.0.0.1:8321/page.html"); pg.evaluate(SETUP, "ok"); pg.wait_for_timeout(500); open_detail(pg)
    check("chips for every person and 'Alle', the set tag is marked", pg.evaluate(CHIPS) == ["Anna", "Ben*", "Alle"], pg.evaluate(CHIPS))
    pg.evaluate(CLICK, "für alle"); pg.wait_for_timeout(300)
    check("'Alle' sent as a tag on", pg.evaluate("() => posts")[-1] == {"item_id": "b1", "tag": "für alle", "tagged": True}, pg.evaluate("() => posts"))
    check("the chip is marked afterwards", pg.evaluate(CHIPS) == ["Anna", "Ben*", "Alle*"], pg.evaluate(CHIPS))
    pg.evaluate(CLICK, "für Ben"); pg.wait_for_timeout(300)
    check("clicking a marked chip takes the tag back", pg.evaluate("() => posts")[-1]["tagged"] is False and pg.evaluate(CHIPS) == ["Anna", "Ben", "Alle*"], pg.evaluate(CHIPS))
    check("the library list knows the new tags too (the person chips filter on them)", pg.evaluate("() => card._libraryItems.L1[0].media.tags") == ["Fantasy", "für alle"], pg.evaluate("() => card._libraryItems.L1[0].media.tags"))
    check("no page errors", not errs, errs); pg.close()

    pg = b.new_page(viewport={"width": 420, "height": 900}); pg.goto("http://127.0.0.1:8321/page.html"); pg.evaluate(SETUP, "cannot"); pg.wait_for_timeout(500); open_detail(pg)
    check("without permission (locked person) there is no 'Für wen?' block", pg.evaluate(CHIPS) == [] and "Für wen?" not in pg.evaluate("() => card._overlayRoot.textContent")); pg.close()

    pg = b.new_page(viewport={"width": 420, "height": 900}); pg.goto("http://127.0.0.1:8321/page.html"); pg.evaluate(SETUP, "error"); pg.wait_for_timeout(500); open_detail(pg)
    pg.evaluate(CLICK, "für Anna"); pg.wait_for_timeout(300)
    check("a refused write leaves the chip as it was and says why", pg.evaluate(CHIPS) == ["Anna", "Ben*", "Alle"] and "keine Tags ändern" in pg.evaluate("() => card.shadowRoot.textContent"), pg.evaluate(CHIPS)); pg.close()
    b.close()
print("ALL PASSED" if not fails else f"FAILED: {fails}"); sys.exit(1 if fails else 0)
