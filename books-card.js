/*!
 * Books Card — a Home Assistant Lovelace card for ebooks and audiobooks,
 * backed by Chaptarr (search/download) and Audiobookshelf (library, reader,
 * player).
 *
 * Requires the companion "Books" integration
 * (https://github.com/hypersonic30/ha-books-integration): it proxies every
 * request, so no Chaptarr API key or Audiobookshelf token ever reaches the
 * browser. Built phone-first for the Home Assistant companion app.
 *
 * License: MIT
 */
"use strict";

// ─────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────

const CARD_VERSION = "0.3.1";
const CARD_TAG = "books-card";
const EDITOR_TAG = "books-card-editor";

const DEFAULT_CONFIG = {
  title: "Bücher",
  default_tab: "library",
  show_search: true,
  show_downloads: true,
  poll_seconds: 10,
  // Order of the Audiobookshelf library chips; the first one opens by default.
  // Matched case-insensitively against library names; unlisted libraries follow.
  library_order: "eBooks, Hörbücher, Hörspiele",
};

const TABS = [
  { key: "library", label: "Bibliothek", icon: "mdi:bookshelf" },
  { key: "search", label: "Suchen", icon: "mdi:magnify", configKey: "show_search" },
  { key: "downloads", label: "Downloads", icon: "mdi:download", configKey: "show_downloads" },
];

// epub.js renders EPUBs into an iframe; JSZip unpacks the EPUB container.
const EPUBJS_URL = "https://cdn.jsdelivr.net/npm/epubjs@0.3.93/dist/epub.min.js";
const JSZIP_URL = "https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js";

const PLAYER_SPEEDS = [0.8, 1, 1.1, 1.25, 1.5, 1.75, 2];
const SYNC_INTERVAL_MS = 15000;
const SIGN_EXPIRY_SECONDS = 24 * 3600;

const READER_THEMES = {
  hell: { body: { background: "#ffffff", color: "#1c1c1e" } },
  sepia: { body: { background: "#f4ecd8", color: "#433422" } },
  dunkel: { body: { background: "#121212", color: "#d7d7d7" } },
};

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function qs(params) {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  return parts.length ? `?${parts.join("&")}` : "";
}

function fmtBytes(n) {
  if (!n && n !== 0) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = Number(n);
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function fmtDuration(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

function fmtHours(seconds) {
  if (!seconds) return "";
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return h ? `${h} Std. ${m} Min.` : `${m} Min.`;
}

function errMessage(err) {
  if (!err) return "Unbekannter Fehler";
  if (typeof err === "string") return err;
  const body = err.body || {};
  return body.error || body.message || err.message || err.error || `Fehler ${err.status || ""}`.trim();
}

// tolino-bridge / integration error codes → what the user can do about it
const TOLINO_ERRORS = {
  bad_type: "Die tolino Cloud nimmt nur EPUB und PDF an.",
  no_ebook: "Zu diesem Titel gibt es keine E-Book-Datei.",
  too_large: "Die Datei ist größer als 100 MB.",
  captcha: "Thalia hat die Anmeldung der Bridge blockiert (Bot-Schutz). Die Bridge versucht es später automatisch erneut.",
  login_backoff: "Die Anmeldung bei Thalia ist gerade pausiert, weil der letzte Versuch scheiterte. Bitte später noch einmal versuchen.",
  rejected: "Thalia hat E-Mail oder Passwort der Bridge abgelehnt.",
  "2fa": "Thalia verlangt einen Bestätigungscode – das kann die Bridge nicht.",
  no_credentials: "In der Bridge sind keine Thalia-Zugangsdaten hinterlegt.",
  no_device: "Im tolino-Konto fehlt das Web-Reader-Gerät. Einmal auf webreader.mytolino.com anmelden.",
  unreachable: "Die tolino-Bridge ist nicht erreichbar.",
  bridge_auth: "Die tolino-Bridge hat den Token der Integration abgelehnt.",
  not_configured: "Die tolino-Bridge ist in der Integration nicht eingerichtet.",
};

// epub.js navigation tree → flat list with depth, for the reader's chapter list
function flattenToc(items, depth = 0, out = []) {
  for (const item of items || []) {
    const label = String(item.label || "").replace(/\s+/g, " ").trim();
    if (label && item.href) out.push({ label, href: item.href, depth: Math.min(depth, 3) });
    flattenToc(item.subitems, depth + 1, out);
  }
  return out;
}

// toc hrefs are relative to the nav document, the reader's location href to the package root
function sameSection(a, b) {
  const norm = (h) => String(h || "").split("#")[0].replace(/^\.?\//, "");
  const x = norm(a);
  const y = norm(b);
  return !!x && !!y && (x === y || x.endsWith(`/${y}`) || y.endsWith(`/${x}`));
}

function fmtDate(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function debounce(fn, wait) {
  let t = null;
  const wrapped = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
  wrapped.flush = (...args) => {
    clearTimeout(t);
    fn(...args);
  };
  return wrapped;
}

const _scriptPromises = {};
function loadScript(url) {
  if (!_scriptPromises[url]) {
    _scriptPromises[url] = new Promise((resolve, reject) => {
      const el = document.createElement("script");
      el.src = url;
      el.async = true;
      el.onload = () => resolve();
      el.onerror = () => {
        delete _scriptPromises[url];
        reject(new Error(`Konnte ${url} nicht laden`));
      };
      document.head.appendChild(el);
    });
  }
  return _scriptPromises[url];
}

// Chaptarr covers are either remote CDN URLs (Hardcover/Goodreads) or
// Chaptarr-local /MediaCover(Proxy) paths, which go through the integration.
function chaptarrCover(book) {
  if (!book) return "";
  // Prefer the provider's original URL: Chaptarr's /MediaCoverProxy paths sit
  // behind its web-UI login and refuse API-key access.
  const img = (book.images || []).find((i) => i.coverType === "cover") || (book.images || [])[0];
  const candidates = [img?.remoteUrl, book.remoteCover, img?.url].filter(Boolean);
  return candidates.find((u) => /^https?:\/\//.test(u)) || candidates[0] || "";
}

function chaptarrCoverImg(book, lazy = true) {
  const url = chaptarrCover(book);
  if (!url) return "";
  const load = lazy ? ' loading="lazy"' : "";
  if (/^https?:\/\//.test(url)) return `<img src="${esc(url)}" alt=""${load} onerror="this.remove()">`;
  const path = `/api/books/chaptarr-media/${url.replace(/^\/+/, "")}`;
  return `<img data-cover="${esc(path)}" alt=""${load} onerror="this.remove()">`;
}

function authorOf(book) {
  return book?.author?.authorName || book?.authorTitle || "";
}

function queueProgress(item) {
  if (!item.size) return 0;
  return Math.max(0, Math.min(100, Math.round(100 * (1 - (item.sizeleft || 0) / item.size))));
}

// ─────────────────────────────────────────────────────────────────────────
// Styles — same glass language as the Questarr card, phone-first sizing
// ─────────────────────────────────────────────────────────────────────────

const STYLE = `
<style>
  * { box-sizing: border-box; }
  [hidden] { display: none !important; }
  :host {
    display: block;
    --bc-radius-lg: 26px;
    --bc-radius-md: 16px;
    --bc-radius-sm: 10px;
    --bc-blur: 26px;
    --bc-accent-rgb: 10, 132, 255;
    --bc-accent: var(--primary-color, rgb(var(--bc-accent-rgb)));
    --bc-soft: rgba(128, 128, 128, 0.10);
    --bc-line: rgba(128, 128, 128, 0.18);
    font-family: var(--paper-font-body1_-_font-family, -apple-system, "SF Pro Text", "Segoe UI", system-ui, sans-serif);
  }
  ha-card {
    position: relative; overflow: hidden; border-radius: var(--bc-radius-lg);
    background: rgba(128, 128, 128, 0.14);
    background: color-mix(in srgb, var(--card-background-color, #1c1c1e) 55%, transparent);
    backdrop-filter: blur(var(--bc-blur)) saturate(160%);
    -webkit-backdrop-filter: blur(var(--bc-blur)) saturate(160%);
    border: 1px solid color-mix(in srgb, var(--divider-color, #8e8e93) 55%, transparent);
    box-shadow: 0 20px 45px rgba(0, 0, 0, 0.16), inset 0 1px 1px rgba(255, 255, 255, 0.12);
  }
  ha-card::before {
    content: ""; position: absolute; inset: 0; pointer-events: none; opacity: 0.6;
    background: linear-gradient(120deg, rgba(255,255,255,0.30), rgba(255,255,255,0.05) 35%, transparent 60%);
  }
  .bc-root { position: relative; z-index: 1; display: flex; flex-direction: column; }
  .bc-header { display: flex; align-items: center; gap: 10px; padding: 18px 18px 6px; }
  .bc-title { flex: 1; font-size: 1.35em; font-weight: 700; letter-spacing: -0.01em; color: var(--primary-text-color); }
  .bc-error {
    display: flex; align-items: center; gap: 8px; margin: 10px 16px 0; padding: 10px 14px;
    border-radius: var(--bc-radius-sm); color: white; font-size: 0.9em;
    background: color-mix(in srgb, var(--error-color, #db4437) 85%, transparent);
  }
  .bc-error button, .bc-toast button { margin-left: auto; background: none; border: none; color: inherit; font-size: 1.1em; cursor: pointer; }
  .bc-toast {
    display: flex; align-items: center; gap: 8px; margin: 10px 16px 0; padding: 10px 14px;
    border-radius: var(--bc-radius-sm); font-size: 0.9em; color: var(--primary-text-color);
    background: color-mix(in srgb, var(--success-color, #43a047) 25%, transparent);
    border: 1px solid color-mix(in srgb, var(--success-color, #43a047) 45%, transparent);
  }

  .bc-toast.err {
    background: color-mix(in srgb, var(--error-color, #db4437) 20%, transparent);
    border-color: color-mix(in srgb, var(--error-color, #db4437) 45%, transparent);
  }

  /* Segmented nav, large enough for thumbs */
  .bc-nav { display: flex; gap: 4px; margin: 8px 16px 0; padding: 4px; border-radius: 999px;
    background: color-mix(in srgb, var(--primary-text-color) 6%, transparent); }
  .bc-nav-btn { flex: 1; display: flex; align-items: center; justify-content: center; gap: 6px;
    min-height: 40px; border: none; border-radius: 999px; background: none; cursor: pointer;
    font-size: 0.9em; font-weight: 600; color: var(--secondary-text-color); }
  .bc-nav-btn ha-icon { --mdc-icon-size: 18px; }
  .bc-nav-btn.active { color: white; background: color-mix(in srgb, var(--bc-accent) 92%, transparent);
    box-shadow: 0 2px 8px rgba(var(--bc-accent-rgb), 0.4); }
  .bc-nav-badge { background: var(--error-color, #db4437); color: white; border-radius: 999px;
    font-size: 0.72em; padding: 1px 6px; }

  .bc-panel { padding: 14px 16px 18px; }
  .bc-section-title { font-size: 0.78em; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase;
    color: var(--secondary-text-color); margin: 16px 2px 8px; }
  .bc-section-title:first-child { margin-top: 2px; }
  .bc-empty, .bc-loading { padding: 26px 8px; text-align: center; color: var(--secondary-text-color); font-size: 0.92em; line-height: 1.5; }

  .bc-chips { display: flex; gap: 6px; overflow-x: auto; padding-bottom: 2px; scrollbar-width: none; }
  .bc-chip { flex: 0 0 auto; min-height: 36px; padding: 6px 14px; border-radius: 999px; cursor: pointer;
    border: 1px solid var(--bc-line); background: var(--bc-soft); color: var(--primary-text-color);
    font-size: 0.88em; font-weight: 600; }
  .bc-chip.active { background: color-mix(in srgb, var(--bc-accent) 90%, transparent); color: white; border-color: transparent; }

  .bc-searchbar { display: flex; gap: 8px; margin: 12px 0 4px; }
  .bc-searchbar input { flex: 1; min-width: 0; min-height: 44px; padding: 10px 16px; border-radius: 999px;
    font-size: 16px; /* ≥16px stops iOS zooming into the field */
    color: var(--primary-text-color); background: var(--bc-soft); border: 1px solid var(--bc-line); }
  .bc-searchbar input:focus { outline: 2px solid color-mix(in srgb, var(--bc-accent) 60%, transparent); }

  .bc-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 44px;
    padding: 10px 18px; border: none; border-radius: 999px; cursor: pointer; font-size: 0.95em; font-weight: 600;
    color: white; background: color-mix(in srgb, var(--bc-accent) 92%, transparent);
    box-shadow: 0 2px 8px rgba(var(--bc-accent-rgb), 0.35); transition: transform 0.1s ease; }
  .bc-btn:active { transform: scale(0.96); }
  .bc-btn:disabled { opacity: 0.5; transform: none; box-shadow: none; cursor: default; }
  .bc-btn.secondary { color: var(--primary-text-color); background: var(--bc-soft); border: 1px solid var(--bc-line); box-shadow: none; }
  .bc-btn.round { width: 48px; min-width: 48px; padding: 0; }
  .bc-btn.big { width: 64px; height: 64px; min-width: 64px; }
  .bc-btn ha-icon { --mdc-icon-size: 22px; }
  .bc-btn.big ha-icon { --mdc-icon-size: 34px; }
  .bc-btn.block { width: 100%; }

  /* Cover grid */
  .bc-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(104px, 1fr)); gap: 14px 12px; }
  .bc-tile { cursor: pointer; min-width: 0; -webkit-tap-highlight-color: transparent; }
  .bc-cover { position: relative; aspect-ratio: 2 / 3; border-radius: var(--bc-radius-sm); overflow: hidden;
    background: var(--bc-soft); box-shadow: 0 6px 16px rgba(0,0,0,0.22); }
  .bc-cover.square { aspect-ratio: 1 / 1; }
  .bc-cover img { position: absolute; inset: 0; z-index: 1; width: 100%; height: 100%; object-fit: cover; display: block; }
  .bc-cover .bc-cover-fallback { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
    padding: 8px; text-align: center; font-size: 0.75em; color: var(--secondary-text-color); }
  .bc-progressbar { position: absolute; left: 0; right: 0; bottom: 0; height: 4px; background: rgba(0,0,0,0.35); }
  .bc-progressbar > div { height: 100%; background: var(--bc-accent); }
  .bc-tile-title { margin-top: 6px; font-size: 0.82em; font-weight: 600; line-height: 1.25; color: var(--primary-text-color);
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .bc-tile-sub { font-size: 0.74em; color: var(--secondary-text-color); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .bc-row-scroll { display: grid; grid-auto-flow: column; grid-auto-columns: 104px; gap: 12px; overflow-x: auto; padding-bottom: 4px; scrollbar-width: none; }

  /* Lists */
  .bc-list { display: flex; flex-direction: column; gap: 10px; }
  .bc-item { display: flex; gap: 12px; align-items: center; padding: 10px; border-radius: var(--bc-radius-md);
    background: var(--bc-soft); border: 1px solid var(--bc-line); cursor: pointer; }
  .bc-item .bc-cover { width: 52px; flex: 0 0 52px; box-shadow: 0 3px 8px rgba(0,0,0,0.2); }
  .bc-item-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
  .bc-item-title { font-weight: 600; font-size: 0.95em; color: var(--primary-text-color); line-height: 1.25;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .bc-item-sub { font-size: 0.8em; color: var(--secondary-text-color); }
  .bc-pills { display: flex; gap: 5px; flex-wrap: wrap; }
  .bc-pill { font-size: 0.7em; font-weight: 700; padding: 2px 8px; border-radius: 999px; background: color-mix(in srgb, var(--primary-text-color) 12%, transparent); color: var(--primary-text-color); }
  .bc-pill.ok { background: rgba(67,160,71,0.25); color: #2e8b32; }
  .bc-pill.info { background: rgba(30,136,229,0.22); color: #1467b3; }
  .bc-pill.warn { background: rgba(251,140,0,0.25); color: #b36200; }
  .bc-meter { height: 6px; border-radius: 999px; background: color-mix(in srgb, var(--primary-text-color) 12%, transparent); overflow: hidden; }
  .bc-meter > div { height: 100%; border-radius: 999px; background: var(--bc-accent); transition: width 0.4s ease; }

  /* Mini player (lives in the card while audio plays) */
  .bc-mini { display: flex; align-items: center; gap: 10px; margin: 12px 16px 0; padding: 8px 10px 8px 8px;
    border-radius: var(--bc-radius-md); cursor: pointer;
    background: color-mix(in srgb, var(--bc-accent) 16%, transparent); border: 1px solid color-mix(in srgb, var(--bc-accent) 35%, transparent); }
  .bc-mini .bc-cover { width: 42px; flex: 0 0 42px; }
  .bc-mini-main { flex: 1; min-width: 0; }
  .bc-mini-title { font-weight: 600; font-size: 0.88em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--primary-text-color); }
  .bc-mini-sub { font-size: 0.75em; color: var(--secondary-text-color); }

  /* Dialogs: native <dialog> + showModal() → top layer, immune to ancestor
     transforms (HA sections view, iOS companion-app WebView). */
  .bc-dialog { padding: 0; border: none; background: transparent; max-width: 100vw; max-height: 100dvh; color: var(--primary-text-color); }
  .bc-dialog::backdrop { background: rgba(0,0,0,0.55); backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px); }
  .bc-sheet { position: relative; width: min(560px, 100vw); max-height: 92dvh; overflow: hidden; display: flex; flex-direction: column;
    border-radius: var(--bc-radius-lg); background: color-mix(in srgb, var(--card-background-color, #1c1c1e) 94%, transparent);
    box-shadow: 0 30px 60px rgba(0,0,0,0.45); }
  .bc-sheet-scroll { overflow-y: auto; padding: 18px 18px calc(18px + env(safe-area-inset-bottom)); }
  .bc-sheet-close { position: absolute; top: 10px; right: 10px; z-index: 3; }
  .bc-banner { position: absolute; left: 0; right: 0; top: 0; height: 240px; background-size: cover; background-position: center;
    filter: blur(28px) saturate(140%); opacity: 0.5; transform: scale(1.2);
    mask-image: linear-gradient(to bottom, black, transparent); -webkit-mask-image: linear-gradient(to bottom, black, transparent); }
  .bc-detail-top { position: relative; z-index: 1; display: flex; gap: 16px; align-items: flex-end; }
  .bc-detail-top .bc-cover { width: 120px; flex: 0 0 120px; }
  .bc-detail-top > div:last-child { min-width: 0; padding-right: 44px; }
  .bc-detail-title { font-size: 1.25em; font-weight: 700; line-height: 1.2;
    display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
  .bc-detail-sub { color: var(--secondary-text-color); font-size: 0.9em; margin-top: 4px; }
  .bc-actions { position: relative; z-index: 1; display: flex; flex-direction: column; gap: 10px; margin-top: 18px; }
  .bc-actions-row { display: flex; gap: 10px; }
  .bc-actions-row .bc-btn { flex: 1; }
  .bc-desc { position: relative; z-index: 1; margin-top: 16px; font-size: 0.9em; line-height: 1.55; color: var(--secondary-text-color); }
  .bc-hint { font-size: 0.8em; color: var(--secondary-text-color); line-height: 1.45; margin-top: 8px; }

  /* Full-screen reader & player */
  .bc-full { width: 100vw; height: 100dvh; max-height: 100dvh; border-radius: 0; }
  /* Full-screen sheets: keep the close button clear of the status bar / notch. */
  .bc-full .bc-sheet-close { top: calc(10px + env(safe-area-inset-top)); right: calc(10px + env(safe-area-inset-right)); }
  .bc-reader { display: flex; flex-direction: column; height: 100%; }
  .bc-reader-bar { display: flex; align-items: center; gap: 8px; padding: calc(8px + env(safe-area-inset-top)) 10px 8px;
    background: color-mix(in srgb, var(--card-background-color, #1c1c1e) 96%, transparent); border-bottom: 1px solid var(--bc-line); }
  .bc-reader-title { flex: 1; min-width: 0; font-weight: 600; font-size: 0.9em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .bc-reader-view { position: relative; flex: 1; min-height: 0; }
  .bc-reader-view > .bc-epub { position: absolute; inset: 0; }
  .bc-reader-toc { position: absolute; inset: 0; z-index: 5; overflow-y: auto; padding: 10px 12px 16px;
    display: flex; flex-direction: column; gap: 4px; background: var(--card-background-color, #1c1c1e); }
  .bc-toc-item { padding: 11px 12px; border-radius: var(--bc-radius-sm); cursor: pointer; font-size: 0.92em; background: var(--bc-soft); }
  .bc-toc-item.current { background: color-mix(in srgb, var(--bc-accent) 22%, transparent); font-weight: 600; }
  .bc-tapzone { position: absolute; top: 0; bottom: 0; width: 22%; z-index: 2; }
  .bc-tapzone.left { left: 0; } .bc-tapzone.right { right: 0; }
  .bc-reader-foot { display: flex; align-items: center; gap: 10px; padding: 8px 12px calc(8px + env(safe-area-inset-bottom));
    font-size: 0.8em; color: var(--secondary-text-color); border-top: 1px solid var(--bc-line);
    background: color-mix(in srgb, var(--card-background-color, #1c1c1e) 96%, transparent); }
  .bc-reader-foot .bc-meter { flex: 1; }
  .bc-reader-menu { display: flex; gap: 8px; flex-wrap: wrap; padding: 10px 12px; border-bottom: 1px solid var(--bc-line); }

  .bc-player { display: flex; flex-direction: column; align-items: center; gap: 16px; padding: calc(64px + env(safe-area-inset-top)) 22px calc(24px + env(safe-area-inset-bottom)); height: 100%; overflow-y: auto; }
  /* Never let the flex column squash the cover when the chapter list opens. */
  .bc-player > * { flex-shrink: 0; }
  .bc-player.chapters-open .bc-cover { width: min(40vw, 160px); }
  .bc-player .bc-cover { width: min(70vw, 300px); aspect-ratio: 1 / 1; border-radius: var(--bc-radius-md); box-shadow: 0 20px 40px rgba(0,0,0,0.45); }
  .bc-player-title { text-align: center; font-size: 1.15em; font-weight: 700; }
  .bc-player-sub { text-align: center; color: var(--secondary-text-color); font-size: 0.88em; margin-top: -10px; }
  .bc-player-chapter { text-align: center; font-size: 0.85em; color: var(--secondary-text-color); }
  .bc-seek { width: 100%; }
  .bc-seek input[type=range] { width: 100%; accent-color: var(--bc-accent); height: 28px; }
  .bc-seek-times { display: flex; justify-content: space-between; font-size: 0.78em; color: var(--secondary-text-color); font-variant-numeric: tabular-nums; }
  .bc-controls { display: flex; align-items: center; justify-content: center; gap: 18px; }
  .bc-player-extra { display: flex; gap: 10px; flex-wrap: wrap; justify-content: center; }
  .bc-chapters { width: 100%; display: flex; flex-direction: column; gap: 4px; max-height: 40vh; overflow-y: auto; }
  .bc-chapter { display: flex; gap: 10px; padding: 10px 12px; border-radius: var(--bc-radius-sm); cursor: pointer; font-size: 0.88em; background: var(--bc-soft); }
  .bc-chapter.current { background: color-mix(in srgb, var(--bc-accent) 22%, transparent); font-weight: 600; }
  .bc-chapter span:last-child { margin-left: auto; color: var(--secondary-text-color); font-variant-numeric: tabular-nums; }
</style>
`;

// ─────────────────────────────────────────────────────────────────────────
// Card
// ─────────────────────────────────────────────────────────────────────────

class BooksCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = { ...DEFAULT_CONFIG };
    this._hass = null;
    this._connected = false;
    this._skeletonReady = false;
    this._activeTab = DEFAULT_CONFIG.default_tab;
    this._error = null;
    this._toast = null;
    this._pollTimer = null;
    this._signed = new Map(); // path -> Promise<signed path>
    this._busy = new Set();

    // Library (Audiobookshelf)
    this._libraries = [];
    this._libraryId = null;
    this._libraryItems = {}; // libraryId -> items
    this._libraryLoading = false;
    this._libraryFilter = "";
    this._inProgress = [];
    this._progress = {}; // libraryItemId -> mediaProgress
    this._detailItemId = null;
    this._detail = null;
    this._tolino = null; // bridge status from /api/books/tolino, refreshed when a detail sheet opens
    this._tolinoCheckedAt = 0;

    // Search (Chaptarr)
    this._searchDraft = "";
    this._searchQuery = "";
    this._searchResults = null;
    this._searchLoading = false;
    this._searchNotice = null;
    this._addBook = null;

    // Downloads (Chaptarr queue + wanted)
    this._queue = [];
    this._wanted = [];
    this._rescue = { in_progress: [], events: [] };
    this._downloadsLoaded = false;

    // Reader
    this._readerItem = null;
    this._readerBook = null;
    this._rendition = null;
    this._readerState = { loading: false, percent: 0, menu: false, fontSize: 110, theme: "hell", error: null };
    this._saveReaderProgress = debounce((cfi, pct) => this._persistReaderProgress(cfi, pct), 2500);

    // Player
    this._player = null; // { item, session, tracks, trackIndex, chapters }
    this._playerOpen = false;
    this._chaptersOpen = false;
    this._lastSyncAt = 0;
    this._listenedSinceSync = 0;
    this._lastTick = null;
  }

  // ── HA lifecycle ────────────────────────────────────────────────────

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first && this._connected) this._initialLoad();
  }

  get hass() {
    return this._hass;
  }

  setConfig(config) {
    if (!config) throw new Error("Invalid configuration");
    const orderChanged = this._config.library_order !== config.library_order;
    this._config = { ...DEFAULT_CONFIG, ...config };
    if (orderChanged && this._libraries.length) {
      this._libraries = this._sortLibraries(this._libraries);
      this._libraryId = this._libraries[0]?.id || null;
      this._loadLibraryItems(this._libraryId);
    }
    if (!this._visibleTabs().find((t) => t.key === this._activeTab)) {
      this._activeTab = this._config.default_tab;
      if (!this._visibleTabs().find((t) => t.key === this._activeTab)) this._activeTab = "library";
    }
    if (this._connected) this._render();
  }

  _eventRoots() {
    return [this.shadowRoot, this._overlayRoot].filter(Boolean);
  }

  connectedCallback() {
    this._connected = true;
    clearTimeout(this._overlayCleanupTimer);
    this._ensureSkeleton();
    if (!this._overlay.isConnected) document.body.appendChild(this._overlay);
    for (const root of this._eventRoots()) {
      root.addEventListener("click", this._handleClick);
      root.addEventListener("input", this._handleInput);
      root.addEventListener("change", this._handleChange);
      root.addEventListener("submit", this._handleSubmit);
    }
    this._render();
    if (this._hass) {
      this._initialLoad();
      this._startPolling();
    }
  }

  disconnectedCallback() {
    this._connected = false;
    clearInterval(this._pollTimer);
    this._pollTimer = null;
    for (const root of this._eventRoots()) {
      root.removeEventListener("click", this._handleClick);
      root.removeEventListener("input", this._handleInput);
      root.removeEventListener("change", this._handleChange);
      root.removeEventListener("submit", this._handleSubmit);
    }
    // A re-insert comes back within the same frame; only a card that is really
    // gone releases its overlay — and never while an audiobook plays or the
    // reader/player is open.
    clearTimeout(this._overlayCleanupTimer);
    this._overlayCleanupTimer = setTimeout(() => {
      const busy = (this._audio && !this._audio.paused) || this._readerDialog?.open || this._playerDialog?.open;
      if (!this._connected && !busy) this._overlay?.remove();
    }, 30000);
  }

  getCardSize() {
    return 8;
  }

  static getConfigElement() {
    return document.createElement(EDITOR_TAG);
  }

  static getStubConfig() {
    return { ...DEFAULT_CONFIG };
  }

  _visibleTabs() {
    return TABS.filter((t) => !t.configKey || this._config[t.configKey]);
  }

  _initialLoad() {
    if (this._initialLoaded) return;
    this._initialLoaded = true;
    this._loadLibraries();
    this._loadDownloads();
    this._startPolling();
  }

  _startPolling() {
    clearInterval(this._pollTimer);
    this._pollTimer = setInterval(() => this._poll(), Math.max(5, this._config.poll_seconds) * 1000);
  }

  _poll() {
    if (document.hidden) return;
    // Downloads are cheap and are what people watch while waiting; the
    // library refreshes less often and only while it's visible.
    this._loadDownloads(true);
    this._pollCount = (this._pollCount || 0) + 1;
    if (this._activeTab === "library" && this._pollCount % 6 === 0) this._loadLibraryItems(this._libraryId, true);
  }

  // ── Networking ──────────────────────────────────────────────────────

  async _api(method, path, body) {
    try {
      return await this._hass.callApi(method, path, body);
    } catch (err) {
      if (err?.status === 401 && this._hass?.connection?.refreshAccessToken) {
        try {
          await this._hass.connection.refreshAccessToken();
        } catch (_) {
          /* retry with whatever token we have */
        }
        return this._hass.callApi(method, path, body);
      }
      throw err;
    }
  }

  _chaptarr(method, path, body) {
    return this._api(method, `books/chaptarr/${path}`, body);
  }

  _abs(method, path, body) {
    return this._api(method, `books/abs/${path}`, body);
  }

  // <img>/<audio> can't send a bearer header, so they get HA signed paths.
  _sign(path) {
    if (!this._signed.has(path)) {
      const p = this._hass
        .callWS({ type: "auth/sign_path", path, expires: SIGN_EXPIRY_SECONDS })
        .then((r) => r.path)
        .catch((err) => {
          this._signed.delete(path);
          throw err;
        });
      this._signed.set(path, p);
    }
    return this._signed.get(path);
  }

  _absCoverPath(itemId, width = 300) {
    return `/api/books/abs/items/${itemId}/cover?width=${width}&format=webp`;
  }

  // Covers are rendered with data-cover and filled in after signing, so a
  // re-render never waits on the websocket.
  _hydrateCovers(root) {
    root.querySelectorAll("img[data-cover]").forEach((img) => {
      const path = img.dataset.cover;
      const cached = this._signedCache?.get(path);
      if (cached) {
        if (img.getAttribute("src") !== cached) img.setAttribute("src", cached);
        return;
      }
      this._sign(path)
        .then((signed) => {
          this._signedCache = this._signedCache || new Map();
          this._signedCache.set(path, signed);
          img.setAttribute("src", signed);
        })
        .catch(() => img.remove());
    });
  }

  _setError(err, context) {
    const message = errMessage(err);
    this._error = context ? `${context}: ${message}` : message;
    console.error("[books-card]", context || "", err); // eslint-disable-line no-console
    this._render();
  }

  _showToast(text) {
    this._toast = text;
    this._render();
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => {
      this._toast = null;
      this._render();
    }, 6000);
  }

  // ── Delegated events (data-action="x" → _onAction_x) ────────────────

  _handleClick = (ev) => {
    const el = ev.target.closest("[data-action]");
    if (!el) return;
    const handler = this[`_onAction_${el.dataset.action}`];
    if (typeof handler === "function") {
      ev.preventDefault();
      handler.call(this, el, ev);
    }
  };

  _handleInput = (ev) => {
    const el = ev.target.closest("[data-input]");
    if (!el) return;
    const handler = this[`_onInput_${el.dataset.input}`];
    if (typeof handler === "function") handler.call(this, el, ev);
  };

  _handleChange = (ev) => {
    const el = ev.target.closest("[data-change]");
    if (!el) return;
    const handler = this[`_onChange_${el.dataset.change}`];
    if (typeof handler === "function") handler.call(this, el, ev);
  };

  _handleSubmit = (ev) => {
    const el = ev.target.closest("[data-submit]");
    if (!el) return;
    ev.preventDefault();
    const handler = this[`_onSubmit_${el.dataset.submit}`];
    if (typeof handler === "function") handler.call(this, el, ev);
  };

  _onAction_dismissError() {
    this._error = null;
    this._render();
  }

  _onAction_dismissToast() {
    this._toast = null;
    this._render();
  }

  _onAction_switchTab(el) {
    this._activeTab = el.dataset.tab;
    this._render();
    if (this._activeTab === "downloads") this._loadDownloads();
  }

  // ── Skeleton & rendering ────────────────────────────────────────────
  // The shell is re-rendered via innerHTML; the dialogs and the <audio>
  // element are created once and never torn down, so playback and open
  // popups survive every background refresh.

  _ensureSkeleton() {
    if (this._skeletonReady) return;
    this._skeletonReady = true;
    this.shadowRoot.innerHTML = `${STYLE}<ha-card><div class="bc-root" id="bc-shell"></div></ha-card>`;
    this._shellEl = this.shadowRoot.getElementById("bc-shell");

    // Dialogs and <audio> live in an overlay attached to <body>, not inside the
    // card: HA's dashboard layouts detach and re-insert card elements (resize,
    // rotation, returning to the iOS app), and a modal <dialog> that is moved
    // like that silently drops out of the top layer — the reader looked
    // "closed". The overlay never moves, so reader and player survive it.
    this._overlay = document.createElement("div");
    this._overlay.className = "books-card-overlay";
    const overlayRoot = this._overlay.attachShadow({ mode: "open" });
    overlayRoot.innerHTML = `
      ${STYLE}
      <dialog class="bc-dialog" id="bc-detail"></dialog>
      <dialog class="bc-dialog" id="bc-add"></dialog>
      <dialog class="bc-dialog" id="bc-reader"></dialog>
      <dialog class="bc-dialog" id="bc-player"></dialog>
      <audio id="bc-audio" preload="metadata" playsinline></audio>
    `;
    this._overlayRoot = overlayRoot;
    document.body.appendChild(this._overlay);
    const $ = (id) => overlayRoot.getElementById(id);
    this._detailDialog = $("bc-detail");
    this._addDialog = $("bc-add");
    this._readerDialog = $("bc-reader");
    this._playerDialog = $("bc-player");
    this._audio = $("bc-audio");

    this._wireDialog(this._detailDialog, () => {
      this._detailItemId = null;
      this._detail = null;
      this._tolinoNotice = null;
    });
    this._wireDialog(this._addDialog, () => {
      this._addBook = null;
    });
    this._wireDialog(this._readerDialog, () => this._closeReader(), false);
    this._wireDialog(this._playerDialog, () => {
      this._playerOpen = false;
    });
    this._wireAudio();
  }

  _wireDialog(dialog, onClose, lightDismiss = true) {
    if (lightDismiss) {
      dialog.addEventListener("click", (ev) => {
        if (ev.target !== dialog) return;
        const r = dialog.getBoundingClientRect();
        const inside = ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom;
        if (!inside) dialog.close();
      });
    }
    dialog.addEventListener("close", () => {
      onClose();
      this._render();
    });
  }

  _render() {
    if (!this._skeletonReady) return;
    const root = this.shadowRoot;
    const active = root.activeElement;
    const focusId = active?.dataset?.focusId;
    const selStart = active?.selectionStart;
    const selEnd = active?.selectionEnd;

    // Skip identical re-renders (background polls): keeps scroll positions
    // and loaded cover images instead of rebuilding the DOM every 10 s.
    const shellHtml = this._renderShell();
    if (shellHtml !== this._shellHtml) {
      this._shellHtml = shellHtml;
      this._shellEl.innerHTML = shellHtml;
    }
    this._syncDialog(this._detailDialog, this._detailItemId, () => this._renderDetail());
    this._syncDialog(this._addDialog, this._addBook, () => this._renderAdd());
    this._syncDialog(this._playerDialog, this._playerOpen && this._player, () => this._renderPlayer(), true);
    this._hydrateCovers(root);
    if (this._overlayRoot) this._hydrateCovers(this._overlayRoot);

    if (focusId) {
      const el = root.querySelector(`[data-focus-id="${focusId}"]`);
      if (el) {
        el.focus();
        try {
          if (typeof selStart === "number") el.setSelectionRange(selStart, selEnd);
        } catch (_) {
          /* not all inputs support selection */
        }
      }
    }
  }

  // patchOnly: the player dialog updates in place (seek bar/time) instead of
  // being rebuilt, so a drag on the range input isn't interrupted.
  _syncDialog(dialog, open, render, patchOnly = false) {
    if (open) {
      if (!patchOnly || !dialog.open || !dialog.firstElementChild) {
        const html = render();
        if (html !== dialog._html || !dialog.firstElementChild) {
          dialog._html = html;
          dialog.innerHTML = html;
        }
      }
      if (!dialog.open) dialog.showModal();
    } else if (dialog.open) {
      dialog.close();
    }
  }

  _renderShell() {
    const tabs = this._visibleTabs();
    const activeDownloads = this._queue.length;
    const nav =
      tabs.length > 1
        ? `<div class="bc-nav">${tabs
            .map(
              (t) => `<button class="bc-nav-btn ${t.key === this._activeTab ? "active" : ""}" data-action="switchTab" data-tab="${t.key}">
                <ha-icon icon="${t.icon}"></ha-icon><span>${t.label}</span>
                ${t.key === "downloads" && activeDownloads ? `<span class="bc-nav-badge">${activeDownloads}</span>` : ""}
              </button>`
            )
            .join("")}</div>`
        : "";
    return `
      <div class="bc-header"><div class="bc-title">${esc(this._config.title)}</div></div>
      ${this._error ? `<div class="bc-error"><ha-icon icon="mdi:alert-circle"></ha-icon><span>${esc(this._error)}</span><button data-action="dismissError">✕</button></div>` : ""}
      ${this._toast ? `<div class="bc-toast"><ha-icon icon="mdi:check-circle"></ha-icon><span>${esc(this._toast)}</span><button data-action="dismissToast">✕</button></div>` : ""}
      ${this._renderMiniPlayer()}
      ${nav}
      <div class="bc-panel">${this._renderPanel()}</div>
    `;
  }

  _renderPanel() {
    if (this._activeTab === "search") return this._renderSearch();
    if (this._activeTab === "downloads") return this._renderDownloads();
    return this._renderLibrary();
  }

  _coverHtml(itemId, { title = "", square = false, progress = null } = {}) {
    return `<div class="bc-cover ${square ? "square" : ""}">
      <div class="bc-cover-fallback">${esc(title)}</div>
      ${itemId ? `<img data-cover="${esc(this._absCoverPath(itemId))}" alt="" loading="lazy" onerror="this.remove()">` : ""}
      ${progress ? `<div class="bc-progressbar"><div style="width:${Math.round(progress * 100)}%"></div></div>` : ""}
    </div>`;
  }

  // ── Library (Audiobookshelf) ────────────────────────────────────────

  async _loadLibraries() {
    try {
      const data = await this._abs("GET", "libraries");
      this._libraries = this._sortLibraries((data.libraries || []).filter((l) => l.mediaType === "book"));
      if (!this._libraries.find((l) => l.id === this._libraryId)) this._libraryId = this._libraries[0]?.id || null;
      this._render();
      await Promise.all([this._loadLibraryItems(this._libraryId), this._loadProgress()]);
    } catch (err) {
      this._setError(err, "Audiobookshelf");
    }
  }

  _sortLibraries(libraries) {
    const order = String(this._config.library_order || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const rank = (lib) => {
      const i = order.indexOf((lib.name || "").trim().toLowerCase());
      return i === -1 ? order.length + (lib.displayOrder || 0) / 1000 : i;
    };
    return [...libraries].sort((a, b) => rank(a) - rank(b));
  }

  async _loadProgress() {
    try {
      const [me, inProgress] = await Promise.all([this._abs("GET", "me"), this._abs("GET", "me/items-in-progress")]);
      this._progress = {};
      (me.mediaProgress || []).forEach((p) => {
        this._progress[p.libraryItemId] = p;
      });
      this._inProgress = inProgress.libraryItems || [];
      this._render();
    } catch (err) {
      console.warn("[books-card] progress", err); // eslint-disable-line no-console
    }
  }

  async _loadLibraryItems(libraryId, quiet = false) {
    if (!libraryId) return;
    if (!quiet) {
      this._libraryLoading = !this._libraryItems[libraryId];
      this._render();
    }
    try {
      const data = await this._abs(
        "GET",
        `libraries/${libraryId}/items${qs({ limit: 500, minified: 1, sort: "addedAt", desc: 1 })}`
      );
      this._libraryItems[libraryId] = data.results || [];
    } catch (err) {
      if (!quiet) this._setError(err, "Bibliothek");
    }
    this._libraryLoading = false;
    this._render();
  }

  _isEbookItem(item) {
    const m = item.media || {};
    return !m.numAudioFiles && !m.numTracks && !m.duration;
  }

  _onAction_selectLibrary(el) {
    this._libraryId = el.dataset.id;
    this._render();
    this._loadLibraryItems(this._libraryId);
  }

  _onInput_libraryFilter(el) {
    this._libraryFilter = el.value;
    this._render();
  }

  _renderLibrary() {
    if (!this._libraries.length) {
      return `<div class="bc-loading">${this._error ? "Audiobookshelf nicht erreichbar." : "Lade Bibliothek…"}</div>`;
    }
    const chips = `<div class="bc-chips">${this._libraries
      .map(
        (l) =>
          `<button class="bc-chip ${l.id === this._libraryId ? "active" : ""}" data-action="selectLibrary" data-id="${l.id}">${esc(l.name)}</button>`
      )
      .join("")}</div>`;

    const continueItems = this._inProgress.filter((i) => i.libraryId === this._libraryId);
    const continueHtml = continueItems.length
      ? `<div class="bc-section-title">Weiter</div>
         <div class="bc-row-scroll">${continueItems.map((i) => this._renderTile(i)).join("")}</div>`
      : "";

    const items = this._libraryItems[this._libraryId];
    let body;
    if (this._libraryLoading || !items) body = `<div class="bc-loading">Lade…</div>`;
    else {
      const f = this._libraryFilter.trim().toLowerCase();
      const shown = f
        ? items.filter((i) => {
            const m = i.media.metadata;
            return [m.title, m.authorName, m.seriesName, m.narratorName].some((v) => (v || "").toLowerCase().includes(f));
          })
        : items;
      body = shown.length
        ? `<div class="bc-grid">${shown.map((i) => this._renderTile(i)).join("")}</div>`
        : `<div class="bc-empty">${f ? "Nichts gefunden." : "Hier ist noch nichts.<br>Neue Bücher findest du unter „Suchen“."}</div>`;
    }

    return `${chips}
      <div class="bc-searchbar"><input type="search" placeholder="In der Bibliothek suchen" value="${esc(this._libraryFilter)}"
        data-input="libraryFilter" data-focus-id="libfilter" autocomplete="off"></div>
      ${continueHtml}
      <div class="bc-section-title">${items ? `${items.length} Titel` : ""}</div>
      ${body}`;
  }

  _renderTile(item) {
    const m = item.media.metadata;
    const progress = this._progress[item.id];
    const pct = progress ? progress.progress || progress.ebookProgress || 0 : 0;
    return `<div class="bc-tile" data-action="openDetail" data-id="${item.id}">
      ${this._coverHtml(item.id, { title: m.title, square: !this._isEbookItem(item), progress: pct > 0 && pct < 1 ? pct : null })}
      <div class="bc-tile-title">${esc(m.title)}</div>
      <div class="bc-tile-sub">${esc(m.authorName || "")}</div>
    </div>`;
  }

  // ── Detail sheet ────────────────────────────────────────────────────

  async _onAction_openDetail(el) {
    this._detailItemId = el.dataset.id;
    this._detail = null;
    this._render();
    this._refreshTolino();
    try {
      this._detail = await this._abs("GET", `items/${this._detailItemId}?expanded=1&include=progress`);
    } catch (err) {
      this._detailItemId = null;
      this._setError(err, "Titel laden");
      return;
    }
    this._render();
  }

  _onAction_closeDialog(el) {
    el.closest("dialog")?.close();
  }

  _renderDetail() {
    const close = `<button class="bc-btn secondary round bc-sheet-close" data-action="closeDialog" aria-label="Schließen"><ha-icon icon="mdi:close"></ha-icon></button>`;
    const item = this._detail;
    if (!item) return `<div class="bc-sheet">${close}<div class="bc-sheet-scroll"><div class="bc-loading">Lade…</div></div></div>`;
    const media = item.media || {};
    const m = media.metadata || {};
    const isAudio = (media.tracks || []).length > 0 || media.duration > 0;
    const hasEbook = !!media.ebookFile;
    const progress = this._progress[item.id] || item.userMediaProgress;
    const series = (m.series || []).map((s) => `${s.name}${s.sequence ? ` #${s.sequence}` : ""}`).join(", ");
    const narrators = (m.narrators || []).join(", ");
    const facts = [
      series && `<span class="bc-pill info">${esc(series)}</span>`,
      isAudio && media.duration ? `<span class="bc-pill">${esc(fmtHours(media.duration))}</span>` : "",
      m.publishedYear ? `<span class="bc-pill">${esc(m.publishedYear)}</span>` : "",
      progress?.isFinished ? `<span class="bc-pill ok">Beendet</span>` : "",
      progress && !progress.isFinished && (progress.progress || progress.ebookProgress)
        ? `<span class="bc-pill info">${Math.round(100 * (progress.progress || progress.ebookProgress))} %</span>`
        : "",
    ].join("");
    const coverPath = this._absCoverPath(item.id, 600);
    const cachedCover = this._signedCache?.get(coverPath);

    const actions = [];
    if (isAudio) {
      const resume = progress?.currentTime > 30 && !progress?.isFinished;
      actions.push(`<button class="bc-btn block" data-action="startPlayback" data-id="${item.id}">
        <ha-icon icon="mdi:play"></ha-icon>${resume ? `Weiterhören (${esc(fmtDuration(progress.currentTime))})` : "Anhören"}</button>`);
    }
    if (hasEbook) {
      const resume = progress?.ebookLocation && !progress?.isFinished;
      actions.push(`<button class="bc-btn block" data-action="openReader" data-id="${item.id}">
        <ha-icon icon="mdi:book-open-page-variant"></ha-icon>${resume ? "Weiterlesen" : "Lesen"}</button>`);
      const cloud = !!this._tolino?.enabled;
      const sentAt = cloud ? this._tolino.sent?.[item.id]?.at : null;
      const notice = this._tolinoNotice?.id === item.id ? this._tolinoNotice : null;
      actions.push(`<div class="bc-actions-row">
        <button class="bc-btn secondary" data-action="sendToTolino" data-id="${item.id}" ${this._busy.has(`tolino-${item.id}`) ? "disabled" : ""}>
          <ha-icon icon="${cloud ? "mdi:cloud-upload-outline" : "mdi:export-variant"}"></ha-icon>${this._busy.has(`tolino-${item.id}`) && cloud ? "Wird gesendet…" : sentAt ? "Erneut an tolino" : "An tolino"}</button>
      </div>
      ${notice
        ? `<div class="bc-toast${notice.error ? " err" : ""}" style="margin:4px 0 0"><ha-icon icon="${notice.error ? "mdi:alert-circle-outline" : cloud ? "mdi:cloud-check-outline" : "mdi:download"}"></ha-icon><span>${esc(notice.text)}</span></div>`
        : cloud
          ? `<div class="bc-hint">${sentAt ? `Schon in deiner tolino Cloud (gesendet am ${esc(fmtDate(sentAt))}). „Erneut“ ersetzt die Kopie dort.` : "„An tolino“ lädt das Buch in deine tolino Cloud. In der tolino-App dann Menü → Synchronisieren."}${this._tolino.reachable === false ? " Die Bridge ist gerade nicht erreichbar." : this._tolino.logged_in === false ? " Die Bridge ist noch nicht bei Thalia angemeldet – sie versucht es beim Senden selbst." : ""}</div>`
          : `<div class="bc-hint">„An tolino“ lädt das Buch herunter bzw. öffnet das Teilen-Menü. In der tolino-App dann auf Hochladen tippen, damit es auf den Reader kommt.</div>`}`);
    }

    return `<div class="bc-sheet">
      ${close}
      <div class="bc-banner" style="${cachedCover ? `background-image:url('${esc(cachedCover)}')` : ""}"></div>
      <div class="bc-sheet-scroll">
        <div class="bc-detail-top">
          ${this._coverHtml(item.id, { title: m.title, square: isAudio })}
          <div>
            <div class="bc-detail-title">${esc(m.title)}</div>
            <div class="bc-detail-sub">${esc((m.authors || []).map((a) => a.name).join(", ") || m.authorName || "")}</div>
            ${narrators ? `<div class="bc-detail-sub">gelesen von ${esc(narrators)}</div>` : ""}
          </div>
        </div>
        <div class="bc-pills" style="position:relative;z-index:1;margin-top:12px">${facts}</div>
        <div class="bc-actions">${actions.join("") || `<div class="bc-empty">Keine lesbare oder hörbare Datei gefunden.</div>`}</div>
        ${m.description ? `<div class="bc-desc">${esc(m.description.replace(/<[^>]+>/g, " "))}</div>` : ""}
      </div>
    </div>`;
  }

  // ── "An tolino": tolino Cloud via bridge, or the OS share sheet as fallback ──

  async _refreshTolino() {
    if (Date.now() - this._tolinoCheckedAt < 60000 && this._tolino) return;
    this._tolinoCheckedAt = Date.now();
    try {
      this._tolino = await this._api("GET", "books/tolino");
    } catch (_) {
      this._tolino = null; // older integration without the endpoint → share sheet
    }
    if (this._detailItemId) this._render();
  }

  async _onAction_sendToTolino(el) {
    const id = el.dataset.id;
    const key = `tolino-${id}`;
    if (this._busy.has(key)) return;
    this._busy.add(key);
    this._tolinoNotice = null;
    this._render();
    try {
      if (this._tolino?.enabled) await this._sendToTolinoCloud(id);
      else await this._sendToTolinoShare(id);
    } finally {
      this._busy.delete(key);
      this._render();
    }
  }

  async _sendToTolinoCloud(id) {
    try {
      let res;
      try {
        res = await this._api("POST", "books/tolino", { abs_item_id: id });
      } catch (err) {
        if (err?.body?.code !== "already_sent") throw err;
        const when = fmtDate(err.body.sent_at);
        // Server confirmed the book is still in the cloud: never duplicate silently.
        const replace = window.confirm(`Dieses Buch ist schon in deiner tolino Cloud${when ? ` (gesendet am ${when})` : ""}.\n\nErsetzen? Die alte Kopie wird dabei gelöscht.`);
        if (!replace) return;
        res = await this._api("POST", "books/tolino", { abs_item_id: id, force: true });
      }
      if (this._tolino) this._tolino.sent = { ...(this._tolino.sent || {}), [id]: { at: new Date().toISOString() } };
      this._tolinoNotice = {
        id,
        text: `${res?.replaced === false ? "Gesendet, aber die alte Kopie ließ sich nicht löschen (doppelt in der Cloud). " : res?.replaced ? "Ersetzt. " : "In deiner tolino Cloud. "}Öffne die tolino-App und tippe auf Menü → Synchronisieren.`,
      };
    } catch (err) {
      const code = err?.body?.code;
      const detail = errMessage(err);
      this._tolinoNotice = { id, error: true, text: TOLINO_ERRORS[code] || `Senden fehlgeschlagen: ${detail}` };
      console.error("[books-card] tolino", code, err); // eslint-disable-line no-console
      this._tolinoCheckedAt = 0; // status may have changed (e.g. login backoff) → recheck next time
      this._refreshTolino();
    }
  }

  async _sendToTolinoShare(id) {
    const item = this._detail;
    const title = item?.media?.metadata?.title || "Buch";
    const fileName = `${title.replace(/[\\/:*?"<>|]+/g, " ").trim().slice(0, 80) || "buch"}.epub`;
    try {
      const signed = await this._sign(`/api/books/abs/items/${id}/ebook`);
      if (navigator.canShare) {
        const resp = await fetch(signed);
        if (!resp.ok) throw new Error(`Download fehlgeschlagen (${resp.status})`);
        const blob = await resp.blob();
        const file = new File([blob], fileName, { type: "application/epub+zip" });
        if (navigator.canShare({ files: [file] })) {
          try {
            await navigator.share({ files: [file], title });
          } catch (err) {
            if (err?.name !== "AbortError") throw err; // user closed the share sheet
          }
          return;
        }
      }
      // No Web Share with files (Android companion app, desktop browsers):
      // download instead — exactly like Home Assistant's own fileDownload()
      // helper (target=_blank + dispatched click), which the Android app hands
      // to its download manager.
      const a = document.createElement("a");
      a.target = "_blank";
      a.href = new URL(signed, location.origin).href;
      a.download = fileName;
      a.style.display = "none";
      document.body.appendChild(a);
      a.dispatchEvent(new MouseEvent("click"));
      document.body.removeChild(a);
      // Shown inside the open detail sheet — a card toast would sit behind it.
      this._tolinoNotice = {
        id,
        text: "Download gestartet. Öffne die Datei danach unter „Downloads“ mit der tolino-App und tippe dort auf Hochladen.",
      };
    } catch (err) {
      this._setError(err, "An tolino");
    }
  }

  // ── Reader (epub.js) ────────────────────────────────────────────────

  async _onAction_openReader(el) {
    const id = el.dataset.id;
    this._readerItem = this._detail && this._detail.id === id ? this._detail : { id, media: { metadata: {} } };
    this._detailDialog.close();
    this._readerState = { ...this._readerState, loading: true, percent: 0, menu: false, error: null, toc: [], tocOpen: false, chapter: null };
    this._readerMoved = false;
    this._readerDialog.innerHTML = this._renderReaderFrame();
    this._readerDialog.showModal();
    try {
      await loadScript(JSZIP_URL);
      await loadScript(EPUBJS_URL);
      const signed = await this._sign(`/api/books/abs/items/${id}/ebook`);
      const resp = await fetch(signed);
      if (!resp.ok) throw new Error(`EPUB konnte nicht geladen werden (${resp.status})`);
      const buffer = await resp.arrayBuffer();
      const progress = this._progress[id];
      this._readerBook = window.ePub(buffer);
      this._readerBook.loaded.navigation
        .then((nav) => {
          this._readerState.toc = flattenToc(nav?.toc);
          this._patchReaderChrome();
        })
        .catch(() => {}); // no/broken table of contents → the chapter button just stays hidden
      const container = this._readerDialog.querySelector(".bc-epub");
      this._rendition = this._readerBook.renderTo(container, {
        width: "100%",
        height: "100%",
        flow: "paginated",
        spread: "none",
        allowScriptedContent: false,
      });
      this._applyReaderLook();
      this._rendition.on("relocated", (loc) => this._onReaderRelocated(loc));
      this._rendition.on("keyup", (ev) => {
        if (ev.key === "ArrowRight") this._turnPage(1);
        if (ev.key === "ArrowLeft") this._turnPage(-1);
      });
      this._wireReaderSwipe();
      await this._rendition.display(progress?.ebookLocation || undefined);
      this._readerState.loading = false;
      this._patchReaderChrome();
      // Page-accurate percentages need a locations index; build it lazily.
      this._readerBook.ready
        .then(() => this._readerBook.locations.generate(1600))
        .then(() => {
          const loc = this._rendition?.currentLocation();
          if (loc?.start) this._onReaderRelocated(loc);
        })
        .catch(() => {});
    } catch (err) {
      this._readerState.loading = false;
      this._readerState.error = errMessage(err);
      this._patchReaderChrome();
    }
  }

  _wireReaderSwipe() {
    let startX = null;
    let startY = null;
    this._rendition.on("touchstart", (ev) => {
      const t = ev.changedTouches?.[0];
      if (t) {
        startX = t.screenX;
        startY = t.screenY;
      }
    });
    this._rendition.on("touchend", (ev) => {
      const t = ev.changedTouches?.[0];
      if (!t || startX === null) return;
      const dx = t.screenX - startX;
      const dy = t.screenY - startY;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        this._turnPage(dx < 0 ? 1 : -1);
      }
      startX = null;
    });
  }

  _applyReaderLook() {
    if (!this._rendition) return;
    // override() replaces the previous value (and is re-applied to every new section). themes.select()
    // only stacks one <style> per theme in the page, so the last-registered theme always won and you
    // could never switch back to an earlier one.
    const { background, color } = (READER_THEMES[this._readerState.theme] || READER_THEMES.hell).body;
    this._rendition.themes.override("background", background, true);
    this._rendition.themes.override("color", color, true);
    this._rendition.themes.fontSize(`${this._readerState.fontSize}%`);
  }

  _onReaderRelocated(loc) {
    const start = loc?.start;
    if (!start) return;
    // Once the locations index exists, derive the book-wide position from it;
    // epub.js' own start.percentage can lag behind or be section-relative.
    const locations = this._readerBook?.locations;
    const pct = locations?.length() ? locations.percentageFromCfi(start.cfi) : null;
    if (pct !== null) this._readerState.percent = pct;
    this._readerState.chapter = start.href;
    this._patchReaderChrome();
    // Only a real page turn moves the saved position — merely opening a book
    // (or the locations index finishing) must never overwrite it.
    if (this._readerMoved) this._saveReaderProgress(start.cfi, pct);
  }

  _turnPage(direction) {
    if (!this._rendition) return;
    this._readerMoved = true;
    if (direction > 0) this._rendition.next();
    else this._rendition.prev();
  }

  async _persistReaderProgress(cfi, pct) {
    const id = this._readerItem?.id;
    if (!id || !cfi) return;
    // pct is null while the locations index is still being built: keep the
    // stored percentage then instead of resetting it to 0.
    const body = { ebookLocation: cfi };
    if (typeof pct === "number") body.ebookProgress = pct;
    if (pct >= 0.995) body.isFinished = true;
    try {
      await this._abs("PATCH", `me/progress/${id}`, body);
      this._progress[id] = { ...(this._progress[id] || {}), libraryItemId: id, ...body };
    } catch (err) {
      console.warn("[books-card] save reading progress", err); // eslint-disable-line no-console
    }
  }

  _renderReaderFrame() {
    const m = this._readerItem?.media?.metadata || {};
    return `<div class="bc-sheet bc-full">
      <div class="bc-reader">
        <div class="bc-reader-bar">
          <button class="bc-btn secondary round" data-action="closeReader" aria-label="Schließen"><ha-icon icon="mdi:close"></ha-icon></button>
          <div class="bc-reader-title">${esc(m.title || "")}</div>
          <button class="bc-btn secondary round" id="bc-reader-toc-btn" data-action="toggleReaderToc" aria-label="Kapitel" hidden><ha-icon icon="mdi:format-list-bulleted"></ha-icon></button>
          <button class="bc-btn secondary round" data-action="toggleReaderMenu" aria-label="Darstellung"><ha-icon icon="mdi:format-size"></ha-icon></button>
        </div>
        <div class="bc-reader-menu" id="bc-reader-menu" hidden>
          <button class="bc-btn secondary" data-action="readerFont" data-delta="-10">A−</button>
          <button class="bc-btn secondary" data-action="readerFont" data-delta="10">A+</button>
          ${Object.keys(READER_THEMES)
            .map((t) => `<button class="bc-btn secondary" data-action="readerTheme" data-theme="${t}">${t[0].toUpperCase()}${t.slice(1)}</button>`)
            .join("")}
        </div>
        <div class="bc-reader-view">
          <div class="bc-epub"></div>
          <div class="bc-reader-toc" id="bc-reader-toc" hidden></div>
          <div class="bc-tapzone left" data-action="readerPrev"></div>
          <div class="bc-tapzone right" data-action="readerNext"></div>
          <div class="bc-loading" id="bc-reader-status" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;z-index:3">Buch wird geöffnet…</div>
        </div>
        <div class="bc-reader-foot">
          <span id="bc-reader-pct">0 %</span>
          <div class="bc-meter"><div id="bc-reader-meter" style="width:0%"></div></div>
        </div>
      </div>
    </div>`;
  }

  _patchReaderChrome() {
    const d = this._readerDialog;
    if (!d.open) return;
    const status = d.querySelector("#bc-reader-status");
    if (status) {
      if (this._readerState.error) {
        status.textContent = this._readerState.error;
        status.hidden = false;
      } else {
        status.hidden = !this._readerState.loading;
      }
    }
    const pct = Math.round((this._readerState.percent || 0) * 100);
    const pctEl = d.querySelector("#bc-reader-pct");
    if (pctEl) pctEl.textContent = `${pct} %`;
    const meter = d.querySelector("#bc-reader-meter");
    if (meter) meter.style.width = `${pct}%`;
    const menu = d.querySelector("#bc-reader-menu");
    if (menu) menu.hidden = !this._readerState.menu;
    const toc = this._readerState.toc || [];
    const tocBtn = d.querySelector("#bc-reader-toc-btn");
    if (tocBtn) tocBtn.hidden = toc.length < 2;
    const panel = d.querySelector("#bc-reader-toc");
    if (panel) {
      panel.hidden = !this._readerState.tocOpen || toc.length < 2;
      if (!panel.hidden) {
        let current = -1;
        toc.forEach((c, i) => {
          if (sameSection(c.href, this._readerState.chapter)) current = i;
        });
        panel.innerHTML = toc
          .map(
            (c, i) => `<div class="bc-toc-item${i === current ? " current" : ""}" data-action="readerGoto" data-index="${i}" style="padding-left:${12 + c.depth * 16}px">${esc(c.label)}</div>`
          )
          .join("");
        // Open on the current chapter instead of the top of a long list.
        panel.querySelector(".current")?.scrollIntoView({ block: "center" });
      }
    }
  }

  _onAction_readerNext() {
    this._turnPage(1);
  }

  _onAction_readerPrev() {
    this._turnPage(-1);
  }

  _onAction_toggleReaderMenu() {
    this._readerState.menu = !this._readerState.menu;
    this._readerState.tocOpen = false;
    this._patchReaderChrome();
  }

  _onAction_toggleReaderToc() {
    this._readerState.tocOpen = !this._readerState.tocOpen;
    this._readerState.menu = false;
    this._patchReaderChrome();
  }

  async _onAction_readerGoto(el) {
    const target = this._readerState.toc?.[Number(el.dataset.index)];
    if (!target || !this._rendition) return;
    this._readerState.tocOpen = false;
    this._patchReaderChrome();
    this._readerMoved = true; // a real navigation: the new position is worth saving
    try {
      await this._rendition.display(target.href);
    } catch (err) {
      console.error("[books-card] chapter jump", target.href, err); // eslint-disable-line no-console
    }
  }

  _onAction_readerFont(el) {
    this._readerState.fontSize = Math.max(70, Math.min(200, this._readerState.fontSize + Number(el.dataset.delta)));
    this._applyReaderLook();
  }

  _onAction_readerTheme(el) {
    this._readerState.theme = el.dataset.theme;
    this._applyReaderLook();
  }

  _onAction_closeReader() {
    this._readerDialog.close();
  }

  _closeReader() {
    const loc = this._rendition?.currentLocation?.();
    if (this._readerMoved && loc?.start?.cfi) {
      const locations = this._readerBook?.locations;
      const pct = locations?.length() ? locations.percentageFromCfi(loc.start.cfi) : null;
      this._saveReaderProgress.flush(loc.start.cfi, pct);
    }
    try {
      this._rendition?.destroy();
      this._readerBook?.destroy();
    } catch (_) {
      /* already gone */
    }
    this._rendition = null;
    this._readerBook = null;
    this._readerItem = null;
    this._readerDialog.innerHTML = "";
    this._loadProgress();
  }

  // ── Player (Audiobookshelf playback session) ────────────────────────

  _wireAudio() {
    const a = this._audio;
    a.addEventListener("timeupdate", () => this._onAudioTime());
    a.addEventListener("play", () => this._onPlayState());
    a.addEventListener("pause", () => {
      this._onPlayState();
      if (!this._stopping) this._syncSession();
    });
    a.addEventListener("ended", () => this._onTrackEnded());
    a.addEventListener("error", () => {
      if (this._player) this._setError(a.error?.message || "Wiedergabefehler", "Player");
    });
    window.addEventListener("pagehide", () => this._syncSession(true));
  }

  async _onAction_startPlayback(el) {
    const id = el.dataset.id;
    if (this._player?.item?.id === id) {
      this._detailDialog.close();
      this._playerOpen = true;
      if (this._audio.paused) this._audio.play().catch(() => {});
      this._render();
      return;
    }
    await this._stopPlayback();
    this._busy.add(`play-${id}`);
    try {
      const session = await this._abs("POST", `items/${id}/play`, {
        deviceInfo: { clientName: "Home Assistant Books Card", deviceId: "ha-books-card" },
        mediaPlayer: "html5",
        forceDirectPlay: true,
        supportedMimeTypes: ["audio/mp4", "audio/mpeg", "audio/aac", "audio/flac", "audio/ogg", "audio/x-m4b"],
      });
      const tracks = (session.audioTracks || []).map((t) => ({
        ...t,
        start: t.startOffset || 0,
        path: `/api/books/abs${t.contentUrl.replace(/^\/api/, "")}`,
      }));
      if (!tracks.length) throw new Error("Keine Audiospur gefunden");
      this._player = {
        item: this._detail && this._detail.id === id ? this._detail : { id, media: { metadata: {} } },
        session,
        tracks,
        trackIndex: 0,
        chapters: session.chapters || [],
        duration: session.duration || tracks.reduce((s, t) => s + (t.duration || 0), 0),
        speed: 1,
      };
      this._listenedSinceSync = 0;
      this._lastTick = null;
      await this._seekTo(session.currentTime || 0, true);
      this._setMediaSession();
      this._detailDialog.close();
      this._playerOpen = true;
      this._render();
    } catch (err) {
      this._player = null;
      this._setError(err, "Wiedergabe starten");
    } finally {
      this._busy.delete(`play-${id}`);
    }
  }

  _currentBookTime() {
    const p = this._player;
    if (!p) return 0;
    return (p.tracks[p.trackIndex]?.start || 0) + (this._audio.currentTime || 0);
  }

  async _seekTo(bookTime, autoplay = false) {
    const p = this._player;
    if (!p) return;
    const t = Math.max(0, Math.min(bookTime, p.duration - 1));
    let idx = p.tracks.findIndex((tr) => t >= tr.start && t < tr.start + (tr.duration || Infinity));
    if (idx < 0) idx = p.tracks.length - 1;
    const track = p.tracks[idx];
    const offset = t - track.start;
    const wasPlaying = !this._audio.paused || autoplay;
    if (idx !== p.trackIndex || !this._audio.src) {
      p.trackIndex = idx;
      this._audio.src = await this._sign(track.path);
      await new Promise((resolve) => {
        const done = () => {
          this._audio.removeEventListener("loadedmetadata", done);
          resolve();
        };
        this._audio.addEventListener("loadedmetadata", done);
        setTimeout(done, 8000);
      });
    }
    this._audio.currentTime = offset;
    this._audio.playbackRate = p.speed;
    if (wasPlaying) this._audio.play().catch(() => {});
    this._patchPlayer();
  }

  _onTrackEnded() {
    const p = this._player;
    if (!p) return;
    if (p.trackIndex < p.tracks.length - 1) {
      this._seekTo(p.tracks[p.trackIndex + 1].start, true);
    } else {
      this._syncSession();
      this._onPlayState();
    }
  }

  _onAudioTime() {
    const now = performance.now();
    if (!this._audio.paused && this._lastTick !== null) {
      const delta = (now - this._lastTick) / 1000;
      if (delta > 0 && delta < 5) this._listenedSinceSync += delta;
    }
    this._lastTick = now;
    this._patchPlayer();
    if (Date.now() - this._lastSyncAt > SYNC_INTERVAL_MS) this._syncSession();
  }

  _onPlayState() {
    this._lastTick = null;
    this._patchPlayer(true);
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = this._audio.paused ? "paused" : "playing";
    this._render();
  }

  async _syncSession(useBeacon = false) {
    const p = this._player;
    if (!p?.session?.id) return;
    this._lastSyncAt = Date.now();
    const body = {
      currentTime: this._currentBookTime(),
      timeListened: Math.round(this._listenedSinceSync),
      duration: p.duration,
    };
    this._listenedSinceSync = 0;
    if (useBeacon) return; // page is going away; the next sync/close catches up
    try {
      await this._abs("POST", `session/${p.session.id}/sync`, body);
      this._progress[p.item.id] = {
        ...(this._progress[p.item.id] || {}),
        libraryItemId: p.item.id,
        currentTime: body.currentTime,
        progress: body.currentTime / p.duration,
      };
    } catch (err) {
      console.warn("[books-card] sync", err); // eslint-disable-line no-console
    }
  }

  async _stopPlayback() {
    const p = this._player;
    if (!p) return;
    const closing = { currentTime: this._currentBookTime(), timeListened: Math.round(this._listenedSinceSync) };
    this._stopping = true;
    this._audio.pause();
    try {
      await this._abs("POST", `session/${p.session.id}/close`, closing);
    } catch (_) {
      /* session may already be gone */
    } finally {
      this._stopping = false;
    }
    this._audio.removeAttribute("src");
    this._audio.load();
    this._player = null;
    this._playerOpen = false;
    this._loadProgress();
  }

  _setMediaSession() {
    if (!("mediaSession" in navigator) || !this._player) return;
    const m = this._player.item.media?.metadata || {};
    const cover = this._signedCache?.get(this._absCoverPath(this._player.item.id, 600));
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: m.title || this._player.session.displayTitle || "",
        artist: this._player.session.displayAuthor || m.authorName || "",
        album: (m.series || [])[0]?.name || "",
        artwork: cover ? [{ src: new URL(cover, location.origin).href, sizes: "600x600" }] : [],
      });
      navigator.mediaSession.setActionHandler("play", () => this._audio.play());
      navigator.mediaSession.setActionHandler("pause", () => this._audio.pause());
      navigator.mediaSession.setActionHandler("seekbackward", () => this._skip(-30));
      navigator.mediaSession.setActionHandler("seekforward", () => this._skip(30));
    } catch (_) {
      /* partial Media Session support is fine */
    }
  }

  _skip(seconds) {
    this._seekTo(this._currentBookTime() + seconds);
  }

  _currentChapter() {
    const p = this._player;
    if (!p) return null;
    const t = this._currentBookTime();
    return p.chapters.find((c) => t >= c.start && t < c.end) || null;
  }

  // MP3→M4B conversions often name chapters after track numbers ("1.1",
  // "03"); show "Kapitel 3 von 440" instead of that noise.
  _chapterLabel(chapter) {
    if (!chapter) return "";
    const p = this._player;
    const title = (chapter.title || "").trim();
    if (title && !/^[\d\s._-]+$/.test(title)) return title;
    const index = p ? p.chapters.indexOf(chapter) : -1;
    return index >= 0 ? `Kapitel ${index + 1} von ${p.chapters.length}` : title;
  }

  _onAction_togglePlay() {
    if (!this._player) return;
    if (this._audio.paused) this._audio.play().catch((err) => this._setError(err, "Wiedergabe"));
    else this._audio.pause();
  }

  _onAction_skip(el) {
    this._skip(Number(el.dataset.seconds));
  }

  _onAction_cycleSpeed() {
    const p = this._player;
    if (!p) return;
    const i = PLAYER_SPEEDS.indexOf(p.speed);
    p.speed = PLAYER_SPEEDS[(i + 1) % PLAYER_SPEEDS.length];
    this._audio.playbackRate = p.speed;
    this._patchPlayer(true);
  }

  _onAction_toggleChapters() {
    this._chaptersOpen = !this._chaptersOpen;
    this._playerDialog._html = null;
    this._playerDialog.innerHTML = this._renderPlayer();
  }

  _onAction_jumpChapter(el) {
    this._seekTo(Number(el.dataset.start) + 0.1, true);
  }

  _onAction_openPlayer() {
    this._playerOpen = true;
    this._render();
  }

  _onAction_closePlayer() {
    this._playerDialog.close();
  }

  async _onAction_stopPlayer() {
    this._playerDialog.close();
    await this._stopPlayback();
    this._render();
  }

  _onChange_seek(el) {
    this._seekTo(Number(el.value));
  }

  _onInput_seek(el) {
    const cur = this._playerDialog.querySelector("#bc-time-cur");
    if (cur) cur.textContent = fmtDuration(Number(el.value));
    this._seeking = true;
    clearTimeout(this._seekingTimer);
    this._seekingTimer = setTimeout(() => {
      this._seeking = false;
    }, 800);
  }

  _renderMiniPlayer() {
    const p = this._player;
    if (!p) return "";
    const m = p.item.media?.metadata || {};
    const ch = this._currentChapter();
    return `<div class="bc-mini" data-action="openPlayer">
      ${this._coverHtml(p.item.id, { title: m.title, square: true })}
      <div class="bc-mini-main">
        <div class="bc-mini-title">${esc(m.title || p.session.displayTitle || "")}</div>
        <div class="bc-mini-sub">${esc(this._chapterLabel(ch) || fmtDuration(this._currentBookTime()))}</div>
      </div>
      <button class="bc-btn round" data-action="togglePlay" aria-label="Play/Pause"><ha-icon icon="${this._audio.paused ? "mdi:play" : "mdi:pause"}"></ha-icon></button>
    </div>`;
  }

  _renderPlayer() {
    const p = this._player;
    if (!p) return "";
    const m = p.item.media?.metadata || {};
    const t = this._currentBookTime();
    const ch = this._currentChapter();
    const chapters = this._chaptersOpen
      ? `<div class="bc-chapters">${p.chapters
          .map(
            (c) => `<div class="bc-chapter ${ch && c.id === ch.id ? "current" : ""}" data-action="jumpChapter" data-start="${c.start}">
              <span>${esc(this._chapterLabel(c))}</span><span>${fmtDuration(c.start)}</span></div>`
          )
          .join("")}</div>`
      : "";
    return `<div class="bc-sheet bc-full">
      <button class="bc-btn secondary round bc-sheet-close" data-action="closePlayer" aria-label="Minimieren"><ha-icon icon="mdi:chevron-down"></ha-icon></button>
      <div class="bc-player ${this._chaptersOpen ? "chapters-open" : ""}">
        ${this._coverHtml(p.item.id, { title: m.title, square: true })}
        <div class="bc-player-title">${esc(m.title || p.session.displayTitle || "")}</div>
        <div class="bc-player-sub">${esc(p.session.displayAuthor || m.authorName || "")}</div>
        <div class="bc-player-chapter" id="bc-chapter">${esc(this._chapterLabel(ch))}</div>
        <div class="bc-seek">
          <input type="range" min="0" max="${Math.floor(p.duration)}" step="1" value="${Math.floor(t)}" data-input="seek" data-change="seek" id="bc-seek">
          <div class="bc-seek-times"><span id="bc-time-cur">${fmtDuration(t)}</span><span id="bc-time-left">−${fmtDuration(p.duration - t)}</span></div>
        </div>
        <div class="bc-controls">
          <button class="bc-btn secondary round" data-action="skip" data-seconds="-30" aria-label="30 Sekunden zurück"><ha-icon icon="mdi:rewind-30"></ha-icon></button>
          <button class="bc-btn big round" data-action="togglePlay" aria-label="Play/Pause" id="bc-playbtn"><ha-icon icon="${this._audio.paused ? "mdi:play" : "mdi:pause"}"></ha-icon></button>
          <button class="bc-btn secondary round" data-action="skip" data-seconds="30" aria-label="30 Sekunden vor"><ha-icon icon="mdi:fast-forward-30"></ha-icon></button>
        </div>
        <div class="bc-player-extra">
          <button class="bc-btn secondary" data-action="cycleSpeed" id="bc-speed">${p.speed.toString().replace(".", ",")}×</button>
          ${p.chapters.length > 1 ? `<button class="bc-btn secondary" data-action="toggleChapters"><ha-icon icon="mdi:format-list-numbered"></ha-icon>Kapitel</button>` : ""}
          <button class="bc-btn secondary" data-action="stopPlayer"><ha-icon icon="mdi:stop"></ha-icon>Beenden</button>
        </div>
        ${chapters}
      </div>
    </div>`;
  }

  // Cheap in-place update ~4×/s while playing: no innerHTML rebuild, so the
  // seek slider can be dragged and the chapter list keeps its scroll position.
  _patchPlayer(force = false) {
    const p = this._player;
    if (!p) return;
    const now = performance.now();
    if (!force && this._lastPatch && now - this._lastPatch < 250) return;
    this._lastPatch = now;
    const t = this._currentBookTime();
    const d = this._playerDialog;
    if (d.open) {
      const seek = d.querySelector("#bc-seek");
      if (seek && !this._seeking) seek.value = Math.floor(t);
      const cur = d.querySelector("#bc-time-cur");
      if (cur && !this._seeking) cur.textContent = fmtDuration(t);
      const left = d.querySelector("#bc-time-left");
      if (left) left.textContent = `−${fmtDuration(p.duration - t)}`;
      const chEl = d.querySelector("#bc-chapter");
      const ch = this._currentChapter();
      if (chEl) chEl.textContent = this._chapterLabel(ch);
      const speed = d.querySelector("#bc-speed");
      if (speed) speed.textContent = `${p.speed.toString().replace(".", ",")}×`;
      const btn = d.querySelector("#bc-playbtn ha-icon");
      if (btn) btn.setAttribute("icon", this._audio.paused ? "mdi:play" : "mdi:pause");
    }
    const miniSub = this._shellEl.querySelector(".bc-mini-sub");
    if (miniSub) miniSub.textContent = this._chapterLabel(this._currentChapter()) || fmtDuration(t);
  }

  // ── Search & add (Chaptarr) ─────────────────────────────────────────

  _onInput_searchDraft(el) {
    this._searchDraft = el.value;
  }

  async _onSubmit_search() {
    const q = this._searchDraft.trim();
    if (!q) return;
    this._searchQuery = q;
    this._searchLoading = true;
    this._searchNotice = null;
    this._searchResults = null;
    this._render();
    // book/lookup answers with titles in the language of the query (German
    // search → German editions); /search via Hardcover is the fallback.
    let results = null;
    try {
      const lookup = await this._chaptarr("GET", `book/lookup${qs({ term: q })}`);
      if (Array.isArray(lookup) && lookup.length) results = lookup.map((book) => ({ book }));
    } catch (_) {
      /* fall through to /search */
    }
    if (!results) {
      try {
        results = await this._chaptarr("GET", `search${qs({ term: q, provider: "hardcover" })}`);
      } catch (err) {
        // Hardcover needs a token in Chaptarr and expires yearly.
        try {
          results = await this._chaptarr("GET", `search${qs({ term: q, provider: "goodreads" })}`);
          this._searchNotice = "Hardcover-Suche nicht verfügbar – Ergebnisse von Goodreads.";
        } catch (err2) {
          this._searchLoading = false;
          this._setError(err2, "Suche");
          return;
        }
      }
    }
    if (q !== this._searchQuery) return; // a newer search replaced this one
    this._searchResults = (results || []).filter((r) => r.book);
    this._searchLoading = false;
    this._render();
  }

  _libraryStatus(book) {
    const audio = (book.localAudiobookBooks || [])[0];
    const ebook = (book.localEbookBooks || [])[0];
    const state = (local) => {
      if (!local) return null;
      if (local.statistics?.bookFileCount > 0 || local.hasFiles) return "vorhanden";
      if (local.monitored) return "gesucht";
      return null;
    };
    return { audiobook: state(audio), ebook: state(ebook) };
  }

  _renderSearch() {
    const form = `<form class="bc-searchbar" data-submit="search">
      <input type="search" placeholder="Titel oder Autor" value="${esc(this._searchDraft)}" data-input="searchDraft"
        data-focus-id="search" autocomplete="off" enterkeyhint="search">
      <button class="bc-btn round" type="submit" aria-label="Suchen"><ha-icon icon="mdi:magnify"></ha-icon></button>
    </form>`;
    let body = "";
    if (this._searchLoading) body = `<div class="bc-loading">Suche läuft…</div>`;
    else if (this._searchResults && !this._searchResults.length) body = `<div class="bc-empty">Nichts gefunden. Anders schreiben oder nur den Autor suchen?</div>`;
    else if (this._searchResults) {
      body = `<div class="bc-list">${this._searchResults
        .map((r, i) => {
          const b = r.book;
          const st = this._libraryStatus(b);
          const pills = [
            st.ebook ? `<span class="bc-pill ${st.ebook === "vorhanden" ? "ok" : "info"}">eBook ${st.ebook}</span>` : "",
            st.audiobook ? `<span class="bc-pill ${st.audiobook === "vorhanden" ? "ok" : "info"}">Hörbuch ${st.audiobook}</span>` : "",
          ].join("");
          return `<div class="bc-item" data-action="openAdd" data-index="${i}">
            <div class="bc-cover"><div class="bc-cover-fallback">${esc(b.title)}</div>${chaptarrCoverImg(b)}</div>
            <div class="bc-item-main">
              <div class="bc-item-title">${esc(b.title)}</div>
              <div class="bc-item-sub">${esc(authorOf(b))}</div>
              ${pills ? `<div class="bc-pills">${pills}</div>` : ""}
            </div>
            <ha-icon icon="mdi:chevron-right"></ha-icon>
          </div>`;
        })
        .join("")}</div>`;
    } else {
      body = `<div class="bc-empty">Such nach einem Buch – als eBook, Hörbuch oder beides.<br>
        Tipp: Mit dem deutschen Titel findest du die deutschen Ausgaben (z. B. „Harry Potter Stein der Weisen“).</div>`;
    }
    const langHint = this._searchResults?.length
      ? `<div class="bc-hint">Titel werden so angezeigt, wie sie gefunden wurden – geholt wird immer die deutsche Ausgabe.</div>`
      : "";
    return `${form}${this._searchNotice ? `<div class="bc-hint">${esc(this._searchNotice)}</div>` : ""}${langHint}${body}`;
  }

  _onAction_openAdd(el) {
    const r = this._searchResults?.[Number(el.dataset.index)];
    if (!r) return;
    this._addBook = r.book;
    this._render();
  }

  _renderAdd() {
    const b = this._addBook;
    const close = `<button class="bc-btn secondary round bc-sheet-close" data-action="closeDialog" aria-label="Schließen"><ha-icon icon="mdi:close"></ha-icon></button>`;
    const st = this._libraryStatus(b);
    const busy = this._busy.has("add");
    const cover = /^https?:/.test(chaptarrCover(b)) ? chaptarrCover(b) : "";
    const option = (types, icon, label, disabledReason) =>
      `<button class="bc-btn ${types.length > 1 ? "" : "secondary"} block" data-action="addBook" data-types="${types.join(",")}" ${busy || disabledReason ? "disabled" : ""}>
        <ha-icon icon="${icon}"></ha-icon>${label}${disabledReason ? ` (${disabledReason})` : ""}</button>`;
    return `<div class="bc-sheet">
      ${close}
      <div class="bc-banner" style="${cover ? `background-image:url('${esc(cover)}')` : ""}"></div>
      <div class="bc-sheet-scroll">
        <div class="bc-detail-top">
          <div class="bc-cover"><div class="bc-cover-fallback">${esc(b.title)}</div>${chaptarrCoverImg(b, false)}</div>
          <div>
            <div class="bc-detail-title">${esc(b.title)}</div>
            <div class="bc-detail-sub">${esc(authorOf(b))}</div>
          </div>
        </div>
        <div class="bc-actions">
          ${option(["ebook"], "mdi:book-open-variant", "Als eBook holen", st.ebook)}
          ${option(["audiobook"], "mdi:headphones", "Als Hörbuch holen", st.audiobook)}
          ${!st.ebook && !st.audiobook ? option(["ebook", "audiobook"], "mdi:book-plus-multiple", "Beides holen") : ""}
          <div class="bc-hint">Es wird nur dieses eine Buch geholt – in der deutschen Ausgabe, keine weiteren Bücher des Autors. Den Fortschritt siehst du unter „Downloads“.</div>
        </div>
        ${b.overview ? `<div class="bc-desc">${esc(b.overview.replace(/<[^>]+>/g, " "))}</div>` : ""}
      </div>
    </div>`;
  }

  async _onAction_addBook(el) {
    const types = el.dataset.types.split(",");
    if (this._busy.has("add")) return;
    this._busy.add("add");
    this._addDialog._html = null;
    this._addDialog.innerHTML = this._renderAdd();
    try {
      const res = await this._api("POST", "books/add", { book: this._addBook, media_types: types, search: true });
      const failed = (res.results || []).filter((r) => !r.ok);
      if (failed.length) throw new Error(failed.map((f) => f.error).join("; "));
      const title = this._addBook.title;
      this._addDialog.close();
      this._showToast(`„${title}“ wird gesucht. Du siehst es unter „Downloads“.`);
      this._loadDownloads();
    } catch (err) {
      this._setError(err, "Hinzufügen");
    } finally {
      this._busy.delete("add");
      if (this._addDialog.open) this._addDialog._html = null;
    this._addDialog.innerHTML = this._renderAdd();
    }
  }

  // ── Downloads (Chaptarr queue + wanted) ─────────────────────────────

  async _loadDownloads(quiet = false) {
    try {
      const [queue, wanted, rescue] = await Promise.all([
        this._chaptarr("GET", `queue${qs({ page: 1, pageSize: 50, includeBook: true })}`),
        this._chaptarr("GET", `wanted/missing${qs({ page: 1, pageSize: 30, monitored: true, includeAuthor: true, sortKey: "releaseDate", sortDirection: "descending" })}`).catch(() => null),
        this._api("GET", "books/rescue").catch(() => null),
      ]);
      const before = this._queue.length;
      this._queue = queue?.records || [];
      if (wanted) this._wanted = wanted.records || [];
      if (rescue) this._rescue = rescue;
      this._downloadsLoaded = true;
      // Something finished importing → refresh the library so it shows up.
      if (quiet && this._queue.length < before) {
        this._loadLibraryItems(this._libraryId, true);
      }
      if (!quiet || this._activeTab === "downloads" || this._queue.length !== before) this._render();
    } catch (err) {
      if (!quiet) this._setError(err, "Downloads");
    }
  }

  _queueState(item) {
    const blocked = item.trackedDownloadState === "importBlocked";
    const rescuing = (this._rescue.in_progress || []).includes(item.downloadId);
    const mismatch = (item.statusMessages || []).some((s) => (s.messages || []).some((m) => m.includes("but import matched")));
    if (rescuing || (blocked && mismatch && this._rescue.enabled)) return { label: "Wird zugeordnet…", cls: "info" };
    if (item.conversionStatus === "converting") {
      return { label: item.conversionMessage || "Wird umgewandelt…", cls: "info", pct: item.conversionProgress };
    }
    if (item.trackedDownloadState === "importing" || item.trackedDownloadState === "importPending") return { label: "Wird importiert…", cls: "info" };
    if (blocked || item.trackedDownloadStatus === "warning" || item.trackedDownloadStatus === "error") return { label: "Problem – bitte Bescheid geben", cls: "warn" };
    if (item.status === "queued" || item.status === "paused") return { label: "Wartet…", cls: "" };
    return { label: `Lädt · ${queueProgress(item)} %`, cls: "", pct: queueProgress(item) };
  }

  _renderDownloads() {
    if (!this._downloadsLoaded) return `<div class="bc-loading">Lade…</div>`;
    const queue = this._queue.length
      ? `<div class="bc-list">${this._queue
          .map((q) => {
            const s = this._queueState(q);
            const b = q.book || {};
            const media = b.mediaType === "audiobook" ? "Hörbuch" : b.mediaType === "ebook" ? "eBook" : "";
            return `<div class="bc-item" style="cursor:default">
              <div class="bc-cover"><div class="bc-cover-fallback">${esc(b.title || q.title)}</div>${chaptarrCoverImg(b)}</div>
              <div class="bc-item-main">
                <div class="bc-item-title">${esc(b.title || q.title)}</div>
                <div class="bc-pills">${media ? `<span class="bc-pill">${media}</span>` : ""}<span class="bc-pill ${s.cls}">${esc(s.label)}</span></div>
                ${typeof s.pct === "number" ? `<div class="bc-meter"><div style="width:${Math.round(s.pct)}%"></div></div>` : ""}
                ${q.timeleft && s.label.startsWith("Lädt") ? `<div class="bc-item-sub">noch ${esc(q.timeleft)} · ${esc(fmtBytes(q.size))}</div>` : ""}
              </div>
            </div>`;
          })
          .join("")}</div>`
      : `<div class="bc-empty">Gerade wird nichts geladen.</div>`;

    const wanted = this._wanted.length
      ? `<div class="bc-section-title">Wird gesucht</div>
         <div class="bc-list">${this._wanted
           .map((w) => {
             const media = w.mediaType === "audiobook" ? "Hörbuch" : "eBook";
             return `<div class="bc-item" style="cursor:default">
               <div class="bc-cover"><div class="bc-cover-fallback">${esc(w.title)}</div>${chaptarrCoverImg(w)}</div>
               <div class="bc-item-main">
                 <div class="bc-item-title">${esc(w.title)}</div>
                 <div class="bc-item-sub">${esc(w.author?.authorName || w.authorTitle || "")}</div>
                 <div class="bc-pills"><span class="bc-pill">${media}</span><span class="bc-pill">noch nicht verfügbar</span></div>
               </div>
               <button class="bc-btn secondary round" data-action="searchAgain" data-id="${w.id}" aria-label="Erneut suchen" ${this._busy.has(`search-${w.id}`) ? "disabled" : ""}><ha-icon icon="mdi:refresh"></ha-icon></button>
             </div>`;
           })
           .join("")}</div>
         <div class="bc-hint">Diese Bücher gibt es gerade nirgends. Es wird automatisch weiter gesucht.</div>`
      : "";

    return `<div class="bc-section-title">Aktuell</div>${queue}${wanted}`;
  }

  async _onAction_searchAgain(el) {
    const id = Number(el.dataset.id);
    const key = `search-${id}`;
    this._busy.add(key);
    this._render();
    try {
      await this._chaptarr("POST", "command", { name: "BookSearch", bookIds: [id] });
      this._showToast("Suche gestartet.");
      setTimeout(() => this._loadDownloads(), 8000);
    } catch (err) {
      this._setError(err, "Suche");
    } finally {
      this._busy.delete(key);
      this._render();
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Visual editor
// ─────────────────────────────────────────────────────────────────────────

const EDITOR_SCHEMA = [
  { name: "title", selector: { text: {} } },
  {
    name: "default_tab",
    selector: {
      select: {
        mode: "dropdown",
        options: TABS.map((t) => ({ value: t.key, label: t.label })),
      },
    },
  },
  { name: "show_search", selector: { boolean: {} } },
  { name: "show_downloads", selector: { boolean: {} } },
  { name: "library_order", selector: { text: {} } },
  { name: "poll_seconds", selector: { number: { min: 5, max: 120, mode: "box", unit_of_measurement: "s" } } },
];

const EDITOR_LABELS = {
  title: "Titel",
  default_tab: "Start-Tab",
  show_search: "Tab „Suchen“ anzeigen",
  show_downloads: "Tab „Downloads“ anzeigen",
  library_order: "Reihenfolge der Bibliotheken (mit Komma, erste = Standard)",
  poll_seconds: "Aktualisierung (Sekunden)",
};

class BooksCardEditor extends HTMLElement {
  setConfig(config) {
    this._config = { ...DEFAULT_CONFIG, ...config };
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (this._form) this._form.hass = hass;
  }

  _render() {
    if (!this._form) {
      this._form = document.createElement("ha-form");
      this._form.computeLabel = (s) => EDITOR_LABELS[s.name] || s.name;
      this._form.addEventListener("value-changed", (ev) => {
        this._config = { ...this._config, ...ev.detail.value };
        this.dispatchEvent(new CustomEvent("config-changed", { detail: { config: this._config }, bubbles: true, composed: true }));
      });
      this.appendChild(this._form);
    }
    this._form.hass = this._hass;
    this._form.schema = EDITOR_SCHEMA;
    this._form.data = this._config;
  }
}

customElements.define(CARD_TAG, BooksCard);
customElements.define(EDITOR_TAG, BooksCardEditor);

window.customCards = window.customCards || [];
window.customCards.push({
  type: CARD_TAG,
  name: "Books Card",
  description: "eBooks & Hörbücher: Bibliothek, Reader, Player und Suche (Chaptarr + Audiobookshelf)",
  preview: false,
  documentationURL: "https://github.com/hypersonic30/ha-books-card",
});

console.info(`%c BOOKS-CARD %c ${CARD_VERSION} `, "color:white;background:#0a84ff;font-weight:700", "color:#0a84ff"); // eslint-disable-line no-console
