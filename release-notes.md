## Suno Feed Capture v1.8.0

### What's new

- **m4a default** — Suno switched its default playback format from MP3
  to M4A (Opus-in-MP4). The extension now saves downloads with the
  correct `.m4a` extension by default.
- **On-page Save buttons** — a small "⬇ Save" pill is injected next to
  every song card on suno.com. Click it to download that one clip
  immediately; no need to open the popup.

### Installation

1. Download `suno-feed-capture-1.8.0.zip` below
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
