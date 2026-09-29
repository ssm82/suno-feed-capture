## Suno Feed Capture v1.8.1

### What's new (1.8.1)

- **Per-song selection in the popup** — check the items you want and
  press **Download** to grab only those. Toolbar exposes **All**, **None**
  and **Visible** (respects the active search/source filter). Stale
  selections are pruned automatically when the captured set changes.
- **Save button sits in the title row** — the on-page Save pill is now
  appended as a flex sibling of the song title (`flex items-center gap-2
  min-w-0`), so it sits where it belongs in the layout and is never
  hidden behind hover overlays.
- **Inline `<audio>`/`<video>` removed from the popup** — the cards
  keep metadata only; use **Open ↗** to play in a new tab.
- **Reliable bulk handoff** — background writes the bulk command to
  `chrome.storage.local` as a fallback, so the content script picks it
  up even when its `document_idle` listener isn't ready yet.
- **WeakSet bug fix** — replaced with a `Set` so identical retries are
  deduped without throwing on string keys.

### What's new (1.8.0)

- **m4a default** — Suno switched its default playback format from MP3
  to M4A (Opus-in-MP4). The extension now saves downloads with the
  correct `.m4a` extension by default.
- **On-page Save buttons** — a small "⬇ Save" pill is injected next to
  every song card on suno.com. Click it to download that one clip
  immediately; no need to open the popup.

### Installation

1. Download `suno-feed-capture-1.8.1.zip` below
2. Unzip it
3. Open `chrome://extensions/`, enable **Developer mode** (top-right)
4. Click **Load unpacked** and select the unzipped folder

### Permissions

- `storage` — for the captured library and download queue
- `downloads` — for the bulk saver and on-page Save buttons
- `host_permissions: suno.com, suno.ai, studio-api-prod.suno.com` — the
  intercept and Save buttons run on Suno's origins

See the [README](https://github.com/ssm82/suno-feed-capture#readme) for
the full feature list, screenshots, and known limitations.

---

## Suno Feed Capture v1.7.0

First public release.

### Highlights

- Live capture of every clip you see in Suno's feed, library, playlists
  and search results
- Local-first storage in `chrome.storage.local` — no upload, no telemetry
- Bulk download with configurable per-file delay, Pause/Resume/Stop
  controls, error panel with retry
- Per-clip autoplay in the popup
- Suno-style dark theme

### Installation

1. Download `suno-feed-capture-1.7.0.zip` below
2. Unzip it
3. Open `chrome://extensions/`, enable **Developer mode** (top-right)
4. Click **Load unpacked** and select the unzipped folder

### Permissions

- `storage` — for the captured library and download queue
- `downloads` — for the bulk saver
- `host_permissions: suno.com, suno.ai, studio-api-prod.suno.com` — the
  intercept runs on Suno's origins

See the [README](https://github.com/ssm82/suno-feed-capture#readme) for
the full feature list, screenshots, and known limitations.
