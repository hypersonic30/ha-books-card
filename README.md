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
  filter, and a *Weiter* row with everything in progress.
- **Reader** — full-screen EPUB reader (epub.js): tap or swipe to turn pages, font size, light/sepia/dark,
  reading position synced to Audiobookshelf (continue on any device).
- **Player** — full-screen audiobook player: ±30 s, speed, chapter list, resume position, progress synced to
  Audiobookshelf every 15 s. Keeps playing in a **mini player** while you browse; lock-screen controls via the
  Media Session API where the platform supports it. Track-number chapter names ("1.1") are shown as
  "Kapitel 3 von 440".
- **An tolino** — hands the EPUB to the iOS/Android share sheet; pick the tolino app to send it to your reader.
  Falls back to a normal download on desktop browsers.
- **Suchen** — searches Chaptarr (titles in the language you search in, Hardcover/Goodreads as fallback) and
  adds a book as eBook, Hörbuch or both — **only that book**, never the author's whole catalogue.
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
```

All options are also available in the visual card editor. Tip: use a **panel** view on phones so the card gets
the full screen width.

## Notes

- The Audiobookshelf token configured in the integration belongs to one Audiobookshelf user, so everyone using
  the card shares that user's reading/listening progress. Separate progress per Home Assistant user is not
  supported yet.
- epub.js and JSZip are loaded from jsDelivr the first time the reader opens.
- Covers and audio are loaded through Home Assistant signed URLs (valid 24 h).
