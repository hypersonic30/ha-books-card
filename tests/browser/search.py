import os, sys, json
from _server import *
from playwright.sync_api import sync_playwright
fails = []
def check(n, c, extra=""):
    print(("PASS " if c else "FAIL ") + n, "" if c else f"\n      {extra}")
    if not c: fails.append(n)
snap = lambda n: json.load(open(os.path.join(HERE, "snap", n + ".json")))
HZ = {"lookup": snap("hazelwood-book_lookup"), "search": snap("hazelwood-search")}
KR = {"lookup": snap("kristoff-book_lookup"), "search": snap("kristoff-search")}

def run_search(b, scn, term):
    pg = b.new_page(viewport={"width": 420, "height": 900}); errs = []; pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto("http://127.0.0.1:8321/page.html")
    pg.evaluate("s => Object.assign(window.scenario, s)", scn)
    pg.evaluate("""() => { const c = document.createElement('books-card'); c.setConfig({type:'custom:books-card'}); document.body.appendChild(c); c.hass = window.hassStub; window.card = c; }""")
    pg.wait_for_timeout(300)
    pg.evaluate("() => { card._activeTab = 'search'; card._render(); }")
    pg.evaluate("t => { card._searchDraft = t; return card._onSubmit_search(); }", term); pg.wait_for_timeout(500)
    return pg, errs
titles = lambda pg: pg.evaluate("() => (card._searchResults || []).map(r => r.book.title)")
chips = lambda pg, kind: pg.evaluate("k => k === 'series' ? card._searchSeries.map(x => x.label) : card._searchAuthors.map(x => x.label)", kind)
shell = lambda pg: pg.evaluate("() => card.shadowRoot.getElementById('bc-shell').innerText")

with sync_playwright() as p:
    b = p.chromium.launch(channel="chrome", headless=True, args=["--no-sandbox"])
    # 1. the reported case, with Chaptarr's real answers
    pg, errs = run_search(b, HZ, "Ali Hazelwood"); t = titles(pg)
    for must in ("The Love Hypothesis", "Love on the Brain", "Love, Theoretically", "Deep End", "Cruel Winter with You", "Bride", "Check & Mate", "Not in Love", "Under One Roof", "Mate", "Below Zero"):
        check(f"[hazelwood] has {must!r}", must in t, t)
    check("[hazelwood] 11 books (was 5), no duplicates", len(t) == 11 and len(set(t)) == 11, (len(t), t))
    check("[hazelwood] lookup's entries come first", t[:5] == [x["title"] for x in HZ["lookup"]], t[:5])
    check("[hazelwood] 6 series chips", len(chips(pg, "series")) == 6 and "Bride" in chips(pg, "series"), chips(pg, "series"))
    check("[hazelwood] 4 other authors, not the queried one", sorted(chips(pg, "authors")) == ["Cat Hepburn", "Hazel Graves", "King Summaries", "Summary Hub"], chips(pg, "authors"))
    txt = shell(pg); check("[hazelwood] sections rendered", "Serien" in txt and "Autoren" in txt, txt[-300:])
    n_img = pg.evaluate("() => card.shadowRoot.querySelectorAll(\".bc-list .bc-cover img[src^='https://']\").length")
    check("[hazelwood] every book (incl. Hardcover ones) has a directly loadable cover URL", n_img == 11, n_img)
    check("[hazelwood] no page errors", not errs, errs); pg.close()
    # 2. Goodreads '(Series, #n)' suffix must not produce duplicates
    pg, errs = run_search(b, KR, "Jay Kristoff"); t = titles(pg)
    check("[kristoff] Nevernight only once", sum("nevernight" in x.lower() and "godsgrave" not in x.lower() and "darkdawn" not in x.lower() for x in t) == 1, t)
    check("[kristoff] lookup's suffixed title kept", "Nevernight (The Nevernight Chronicle, #1)" in t, t)
    check("[kristoff] search-only titles added", "Illuminae" in t, t); print("      kristoff titles:", t); pg.close()
    # 3. one source down
    pg, errs = run_search(b, {"lookup": HZ["lookup"], "search": "error"}, "Ali Hazelwood")
    check("[hardcover down] lookup results still shown (5)", len(titles(pg)) == 5, titles(pg))
    check("[hardcover down] says it is partial", "nur ein Teil" in shell(pg), shell(pg)[:300]); pg.close()
    pg, errs = run_search(b, {"lookup": "error", "search": HZ["search"]}, "Ali Hazelwood")
    check("[lookup down] search results shown (10)", len(titles(pg)) == 10, titles(pg)); check("[lookup down] no error banner", pg.evaluate("() => !card._error"), pg.evaluate("() => card._error")); pg.close()
    # 4. lookup empty AND hardcover down -> Goodreads fallback as before
    pg, errs = run_search(b, {"lookup": [], "search": "error", "goodreads": [i for i in HZ["search"] if i.get("book")][:3]}, "ali")
    check("[fallback] goodreads results shown", len(titles(pg)) == 3, titles(pg)); check("[fallback] notice names Goodreads", "Goodreads" in shell(pg), shell(pg)[:300]); pg.close()
    # 5. everything down -> error, not a silent empty page
    pg, errs = run_search(b, {"lookup": "error", "search": "error", "goodreads": "error"}, "x")
    check("[all down] error shown", pg.evaluate("() => !!card._error && /Suche/.test(card._error)"), pg.evaluate("() => card._error")); pg.close()
    # 6. nothing found
    pg, errs = run_search(b, {"lookup": [], "search": []}, "zzzz")
    check("[empty] friendly empty state", "Nichts gefunden" in shell(pg), shell(pg)[:200]); pg.close()
    # 7. only series/authors, no books: not 'nothing found'
    only = [i for i in HZ["search"] if i.get("series")]
    pg, errs = run_search(b, {"lookup": [], "search": only}, "love")
    check("[series only] chips shown instead of empty state", "Nichts gefunden" not in shell(pg) and len(chips(pg, "series")) == 6, shell(pg)[:200]); pg.close()
    # 8. tapping a chip starts a new search with that term
    pg, errs = run_search(b, HZ, "Ali Hazelwood")
    pg.evaluate("() => { window.calls.length = 0; }")
    pg.evaluate("() => card.shadowRoot.querySelector('[data-action=searchFor][data-q=\"Bride\"]').click()"); pg.wait_for_timeout(500)
    q = pg.evaluate("() => window.calls.map(c => c.path)")
    check("[chip] triggers lookup+search for the series name", any("book/lookup?term=Bride" in x for x in q) and any("search?term=Bride" in x for x in q), q)
    check("[chip] search box shows the new term", pg.evaluate("() => card._searchDraft === 'Bride' && card._searchQuery === 'Bride'"))
    pg.close(); b.close()
print("ALL PASSED" if not fails else f"FAILED: {fails}"); sys.exit(1 if fails else 0)
