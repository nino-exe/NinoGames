# NinoGames

A desktop game launcher for Windows, built with Electron. It browses game
sources, downloads and installs with resume support, keeps a library with
cover art and playtime, and sets up LAN multiplayer for a handful of older
games that no longer have working matchmaking.

> **Note**
> This is a personal project. It indexes third-party sites and does not host
> any game content itself.

---

## Features

**Library and browsing**
- Two sources — AnkerGames and SteamRIP — switchable from the home screen
- Cover art with a three-stage fallback: the source's own art → SteamGridDB →
  the game page's `og:image`, so tiles rarely come up blank
- Wishlist, playtime tracking, "money saved" and total install size
- Four themes: Dark, Light, Tokyo Night, Catppuccin

**Downloads**
- Multi-connection downloads and auto-resume via `aria2c`
- Archives are validated before extraction, and **kept** if extraction fails,
  so a bad unpack never costs you the whole download again
- Extraction via 7-Zip, with a PowerShell fallback
- Verify-install checks size on disk against the downloaded archive

**Integration**
- Discord Rich Presence (only connects when Discord is actually running)
- Add games to Steam, or create desktop shortcuts
- One-click redistributables install (VC++, .NET, DirectX) via `winget`

**Multiplayer parties**

Creates a virtual LAN with [EasyTier](https://github.com/EasyTier/EasyTier), so
players connect as if on the same network. Supported mods:

| Mod | Game | How it hosts |
|---|---|---|
| IW4x | Call of Duty: Modern Warfare 2 | listen server (`+devmap`) |
| H1-Mod | CoD: Modern Warfare Remastered | listen server |
| CoD4x | Call of Duty 4 | listen server |
| CoD2x | Call of Duty 2 | listen server |
| RageCoop | Grand Theft Auto V | dedicated server |
| GTA Connected | Grand Theft Auto IV | dedicated server |

Mods are defined declaratively in [`multiplayermod.json`](multiplayermod.json) —
install steps, party settings and host options are data, not code, so adding a
game usually means editing that file rather than touching `main.js`.

---

## Running from source

Requires **Node.js 18+** and Windows.

```bash
git clone https://github.com/nino-exe/NinoGames.git
cd NinoGames
npm install
npm start
```

### Bundled binaries are not in this repo

`resources/` holds third-party tools that aren't ours to redistribute and are
too large for git (~225 MB). The app runs without them, but the matching
features stay disabled until you drop them in:

| Folder | What goes in it | Needed for |
|---|---|---|
| `resources/aria2/` | `aria2c.exe` — [releases](https://github.com/aria2/aria2/releases) | fast/resumable downloads |
| `resources/7zip/` | `7za.exe` — [7-Zip extras](https://www.7-zip.org/download.html) | fast extraction |
| `resources/easytier/` | `easytier-core.exe`, `easytier-cli.exe` — [releases](https://github.com/EasyTier/EasyTier/releases) | multiplayer parties |
| `resources/yt-dlp/` | `yt-dlp.exe` — [releases](https://github.com/yt-dlp/yt-dlp/releases) | trailers |
| `resources/updater/` | `updater.exe` | in-app updates |

Both downloading and extraction fall back to slower built-in paths if `aria2c`
or `7za.exe` are missing, so you can develop without either.

---

## Building a release

```bash
npm run dist
```

Produces `release/NinoGames-<version>-portable.exe` — a single self-contained
executable with no install step. Configuration lives in the `build` field of
[`package.json`](package.json).

---

## Project layout

```
main.js                 Electron main process — downloads, extraction, IPC,
                        mod installs, party hosting, updater
preload.js              contextBridge API exposed to the renderer
store.js                settings/library persistence (atomic writes)
party.js                EasyTier lifecycle and virtual LAN
multiplayermod.json     declarative mod definitions
renderer/
  index.html            all views (home, library, party, settings, detail)
  renderer.js           UI logic
  party_renderer.js     party screen
  styles.css            styling and themes
```

Settings and library live in `%APPDATA%/NinoGames/sudata.json`, written
atomically so a crash mid-write can't corrupt them.

---

## Updates

On startup the app checks `version.json` in this repo and shows a notice if a
newer release exists. Dismissing it suppresses that version only — a later one
will prompt again.

---

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for what changed in each release.

---

## Licence

No licence has been chosen yet, so default copyright applies: the code is
readable here but not licensed for reuse. Bundled third-party binaries keep
their own licences.
