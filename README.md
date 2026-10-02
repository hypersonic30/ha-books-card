# Books Card for Home Assistant

[![HACS Custom](https://img.shields.io/badge/HACS-Custom-orange.svg)](https://github.com/hacs/integration)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A phone-first Lovelace card for ebooks and audiobooks: browse your
[Audiobookshelf](https://www.audiobookshelf.org/) library, **read EPUBs** and **listen to audiobooks**
right inside Home Assistant, and find new books through [Chaptarr](https://github.com/Chaptarr/chaptarr).
Built for the Home Assistant companion app. UI language: German.

> [!IMPORTANT]
> Requires the **[Books Integration](https://github.com/hypersonic30/ha-books-integration)** — it proxies
> every request, so no Chaptarr API key or Audiobookshelf token ever reaches the browser.

## Features

- **Bibliothek** — all Audiobookshelf libraries as chips (e.g. Hörbücher / Hörspiele / eBooks), cover grid,
  filter, and a *Weiter* row with everything in progress. With two or more people (integration ≥ 0.16.0) chips *Alle / Für mich /
  each person* sort the shared library by the tag `für NAME`; books without a person tag are for everybody. The choice is remembered per browser. For a person locked in the integration (child protection, integration ≥ 0.18.0) the card shows only the library: the Search and Downloads tabs disappear.
- **Reader** — full-screen EPUB reader (epub.js): tap or swipe to turn pages, font size, light/sepia/dark,
  reading position synced to Audiobookshelf (continue on any device). A **chapter list** (button in the top bar, shown when the book has a table of contents) jumps straight to any chapter and highlights the current one.
- **Player** — full-screen audiobook player: ±30 s, speed, chapter list, resume position, progress synced to
  Audiobookshelf every 15 s. Keeps playing in a **mini player** while you browse; lock-screen controls via the
  Media Session API where the platform supports it. Track-number chapter names ("1.1") are shown as
  "Kapitel 3 von 440".
- **An tolino** — with the optional [tolino-bridge](https://github.com/hypersonic30/tolino-bridge) configured in the
  integration, one tap uploads the EPUB straight into your **tolino Cloud** (works the same on iOS and Android; then
  tolino app → Menü → Synchronisieren). Failures come with a plain-German reason (e.g. Thalia bot protection, login
  paused). Without a bridge it falls back to the iOS/Android share sheet (or a normal download on desktop browsers).
- **Suchen** — searches Chaptarr with **both** of its sources at once (Goodreads `book/lookup`: German editions; Hardcover `search`:
  more titles) and shows the union without duplicates — e.g. 11 instead of 5 books for "Ali Hazelwood". Series and authors found
  along the way appear as chips; tapping one starts a new search. Adds a book as eBook, Hörbuch or both — **only that book**,
  never the author's whole catalogue. If one source is down, the other still answers (with a note).
- **Downloads** — what's downloading, converting (MP3→M4B) or importing, and what is still being searched for.
  Imports that the integration repairs automatically show as "Wird zugeordnet…".

## Installation

### HACS
1. HACS → ⋮ → Custom repositories → add this repo's URL, category **Dashboard**.
2. Install **Books Card**, reload the browser (in the companion app: Settings → Companion App → Debugging →
   Reset frontend cache).

### Manual
Copy `books-card.js` to `config/www/` and add it as a dashboard resource:
`/local/books-card.js` (type: JavaScript module).

## Configuration

```yaml
type: custom:books-card
title: Bücher          # optional
default_tab: library   # library | search | downloads
show_search: true      # hide the Search tab (e.g. for a kids' dashboard)
show_downloads: true
poll_seconds: 10       # refresh interval for downloads
library_order: "eBooks, Hörbücher, Hörspiele"  # chip order; the first opens by default
```

All options are also available in the visual card editor. Tip: use a **panel** view on phones so the card gets
the full screen width.

## Notes

- Everybody who uses the card needs a **person** in the integration (Books Integration ≥ 0.13.0: *Add person*, with their own Audiobookshelf
  token): that is what gives everybody their **own reading/listening progress**. Without a person the card shows "Für dein Konto ist keine
  Person angelegt" instead of the library. The tolino button only shows for people who have a tolino, each with their own Thalia account.
- epub.js and JSZip are loaded from jsDelivr the first time the reader opens.
- Covers and audio are loaded through Home Assistant signed URLs (valid 24 h).

## Development

`books-card.js` is a single file (no build step). Browser tests live in `tests/browser/`: real Chrome (Playwright) against the card
with a stubbed `hass` object, no Home Assistant needed:

```bash
pip install playwright && playwright install chrome
python tests/browser/run_all.py          # or a single script, e.g. python tests/browser/search.py
```
CI runs the same (`.github/workflows/validate.yml`).
