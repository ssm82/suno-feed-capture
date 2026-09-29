# Suno Feed Capture

A Chrome extension (Manifest V3) that intercepts the network responses from
[Suno](https://suno.com) (audio generation), keeps every song clip you
browse in `chrome.storage.local`, and lets you browse, search, sort, export
and bulk-download them locally.

It works entirely with your existing browser session — no API keys, no
server, no auth tokens to paste. You sign into Suno in your normal Chrome
tab, the extension passively captures the same JSON the page already
receives, and you get a tidy local library of everything you scrolled past.

---

## Highlights

- **Live capture** — every clip you see in Suno's feed, library, playlists
  or search results is saved automatically. No manual import, no
  copy-pasting IDs.
- **On-page Save buttons** — a small "⬇ Save" pill appears next to every
  song card directly on suno.com. Click it to download that one clip
  straight to `Downloads/suno-feed/`. Works for captured clips; shows a
  disabled state for cards you haven't browsed past yet.
- **Suno-grade parser** — new endpoints work without code changes as
  long as the items follow the standard `id`-bearing shape.
- **Local-first storage** — items live in `chrome.storage.local` (no
  upload, no telemetry). Export to JSON whenever you want.
- **Bulk download** — pick Audio and/or Video, set a per-file delay to be
  polite to Suno's CDN, and download the whole library with Pause/Resume
  /Stop controls. Errors are collected in a collapsible panel.
- **Per-clip autoplay in popup** — small inline player on each card
  (Suno's CDN URLs work directly from the popup, no auth required
  because the browser session is already authenticated).
- **Suno-recognisable UI** — dark theme, the same gradient identity as
  Suno's site, 460px popup width optimised for vertical scrolling.

---

## Screenshots

> *Drop a screenshot of the popup here. Suggested 720×900 — the popup
> shows: header, count + status, bulk row with Delay / Audio / Video
> / Download all, progress bar, filters (search / source / sort), then
> the list of clip cards with inline players.*

---

## Installation

### From source (developer mode)

1. Clone this repository.
2. Open `chrome://extensions/` in Chrome (or any Chromium 111+ browser:
   Edge, Brave, Arc, Vivaldi).
3. Toggle **Developer mode** on (top-right).
4. Click **Load unpacked** and select the `suno-feed-capture/` folder.
5. Pin the extension to the toolbar (puzzle icon → pin).

The extension icon shows a tiny badge with the number of remaining
downloads while a bulk job is running, or the number of captured items
when idle.

### From a release zip

1. Download `suno-feed-capture-X.Y.Z.zip` from the
   [Releases](../../releases) page.
2. Unzip it.
3. In `chrome://extensions/`, drag the unzipped folder onto the page
   (or use **Load unpacked**).

---

## Usage

1. Open <https://suno.com> and sign in normally.
2. Browse around — your library, your feed, search results, playlists.
   The extension quietly records every clip it sees.
3. Click the extension icon. The popup shows everything captured so far.
4. Use the search box and the **Source** dropdown to filter.
5. Sort by **Newest captures**, **Newest creations**, **Title A→Z**, or
   **Longest**.
6. Tick **Audio** (or **Video**) and click **Download all** to bulk
   save them locally with a per-file delay.
7. **Export** dumps the entire library as a single JSON file.
8. **Clear** wipes local storage. There is no undo — export first.

### Saving individual songs from the Suno page

The extension also injects a small "⬇ Save" button next to every song
card on suno.com. After you browse past a song it becomes active; click
it to download that single clip immediately (no popup, no queue — it
goes straight into `Downloads/suno-feed/`). Cards for songs you haven't
seen yet stay in a disabled state until they get captured by scrolling
the feed.

### Bulk download semantics

- Files are saved under `Downloads/suno-capture/<author>/<clipId>.<ext>`.
- The default delay is `1500ms` between files. Increase it if you see
  HTTP 429s from Suno's CDN; decrease it for faster local copies.
- **Pause** holds the queue where it is; **Resume** picks up from the
  next pending item. **Stop** cancels and marks the queue inactive.
- Errors are accumulated into a list and shown in a collapsible
  panel. Click **Clear** next to "errors" to wipe that list before
  retrying.

---

## Permissions

| Permission                                | Why it's needed                                          |
|-------------------------------------------|----------------------------------------------------------|
| `storage`                                 | `chrome.storage.local` for items, queue, and settings.   |
| `downloads`                               | `chrome.downloads.download` for the bulk saver.          |
| `host_permissions: suno.com, suno.ai, studio-api-prod.suno.com` | The intercept runs on Suno's origins. |

The extension does **not** request `tabs`, `activeTab`, `webNavigation`,
or any reading-side permission. It never reads page content — it only
observes network responses that the page itself receives.

---

## Privacy

- Nothing leaves your machine. There is no analytics, no telemetry, no
  remote server.
- The captured JSON and audio files live in `chrome.storage.local` and
  your default `Downloads/` folder, respectively.
- You can wipe everything with one click — **Clear** in the popup
  header. The service worker also exposes no background network calls.

---

## Known limitations

- **Session-based**: the popup's inline player and the downloader rely
  on the browser session already being authenticated to Suno. Sign out
  → downloads will start failing with 401/403. Re-sign in to fix.
- **Single source of truth**: items are stored as last-seen-wins. If
  Suno removes a song, the local copy stays until you Clear or
  manually delete it.
- **CDN URL expiry**: Suno's audio URLs are signed and time-limited.
  If a file fails to download with HTTP 403, the URL probably
  expired. Re-opening the corresponding page in Suno regenerates the
  URL, and the next capture will replace the local entry.
- **No re-encoding**: downloads are saved exactly as Suno serves them.
  Audio is M4A (Opus-in-MP4, Suno's default playback format since they
  switched off MP3), video is MP4.

---

## Contributing

1. Fork the repository.
2. `git checkout -b feature/your-thing`
3. Make your change. If you touched the content scripts, reload the
   extension in `chrome://extensions/`.
4. Open a pull request with a clear description of what and why.

### Local development loop

1. Edit the file.
2. `chrome://extensions/` → click **Reload** on the extension card.
3. Refresh the Suno tab (or `Ctrl+Shift+R` to bypass cache).
4. Watch the service worker console (`service worker` link in
   `chrome://extensions/`) and the regular DevTools console for the
   Suno tab.

---

## License

MIT. See [`LICENSE`](./LICENSE).
