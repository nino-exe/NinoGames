# Changelog

## 1.1.6

### Downloads

- **A failed extraction no longer throws away the download.** Previously any
  problem while unpacking marked the whole game as failed and deleted the
  archive, so a broken unpack cost you the entire re-download. The archive is
  now kept and the library card offers **Retry Extraction** instead.
- Archives are checked before extraction — truncated or wrong-format files are
  caught up front and marked resumable rather than failing halfway through.
- Archives now live in `<install folder>/.archives` instead of `%TEMP%`, so
  they survive a reboot or a disk cleanup.
- Interrupted downloads resume properly after a crash: a partly-downloaded game
  comes back as **Paused**, and one that only failed to unpack comes back ready
  to retry extraction.
- Fixed two downloads finishing at once being able to swap each other's UAC
  prompt answers.
- Progress writes are throttled, so a fast download no longer hammers the
  settings file.
- Minecraft downloads from a known-good mirror — the copies on both sources
  were broken archives.

### Library and browsing

- **Source switcher on the home screen** — swap between AnkerGames and SteamRIP
  without going into Settings.
- **All AnkerGames titles now appear on the home screen** (~1,900), not just
  SteamRIP's.
- Clicking **Home** while viewing search results returns to the home page
  instead of redisplaying the results.
- **Cover art rarely comes up blank now.** AnkerGames' own artwork is used
  directly, and anything SteamGridDB doesn't have falls back to the game page's
  own image.
- Wide banner art is letterboxed over a blurred backdrop instead of being
  centre-cropped, which had been slicing the titles off.
- **Unrecognised games fix themselves.** Installed games with no cover are
  looked up automatically, and only ask for manual matching if nothing
  convincing is found. The manual search box no longer pre-fills with the
  `ag-`/`sr-` folder prefix, which never matched anything.
- New **Size** pill showing the total size of your games folder.

### Multiplayer

- Redesigned the multiplayer page, with a search box (including acronyms —
  "cod" finds Call of Duty).
- Card animations no longer replay on every keystroke and refresh.
- **RageCoop (GTA V) is fully supported** — ScriptHookV, ScriptHookVDotNet and
  RageCoop+ install automatically, with the dedicated server included for
  hosting. Joining writes the host's address into the client config, so the
  in-game menu is pre-filled instead of needing an IP typed in by hand.
- RageCoop's spam kicker is disabled when hosting; it misfired badly enough to
  kick everyone once a second.
- **Uninstalling a mod no longer deletes the game's own executable.** CoD2x
  patches the stock `CoD2MP_s.exe` rather than shipping its own, so removing
  the mod was destroying the game's multiplayer.
- Party hosts get **Max players**, **NPC sync distance** and **Voice chat**
  settings on the host screen.

### EasyTier

- The party no longer reports "connected" before it actually is — readiness is
  now confirmed against the running core instead of assuming success after a
  fixed delay.
- Enabled multi-threading, latency-first routing and UDP broadcast relay.
- Quitting properly shuts the party down instead of leaving an orphaned
  process running in the background.
- Detects two members ending up on the same virtual IP.

### Interface

- **Game Tracking is now part of first-time setup**, so the "launcher must stay
  open while playing" caveat is visible up front rather than buried in
  Settings.
- **Update notifications on startup.** The update banner only existed on the
  Settings page where nobody saw it; a corner notice now appears if a newer
  version is out. Dismissing it hides that version only.
- Rebuilt the installed-game page: screenshots and system requirements sit side
  by side at a proper 16:9, with the description below.
- Shortened the long explanatory text throughout the app.
- Removed the "What's New" popup on launch.

### Security

- Archives can no longer write outside the install folder during extraction
  (zip-slip).
- Links and image URLs are validated before use, and the app window is locked
  down against navigating away or opening arbitrary windows.
- Trailer links are validated as YouTube IDs.
- Page-cover lookups only accept the two sources, including against
  lookalike domains such as `steamrip.com.evil.net`.
- Paths are validated before being passed to an elevated command.
- Settings and library are written atomically, so a crash mid-write can't
  corrupt them.

### Fixes

- **Discord Rich Presence only connects when Discord is actually running.**
  The previous check opened the Discord pipe to test for it, which consumed a
  connection slot and reported false negatives afterwards.
- CoD2x's "Failed to open registry key for HWID" error is handled — repacked
  copies never created the registry key the mod expects.

---

## Earlier versions

Version history before 1.1.6 wasn't recorded, and this repository starts at
1.1.6, so there's nothing reliable to list. Two changes are known from the
in-app release notes that shipped previously:

- Closing the window minimises to the system tray instead of quitting; the
  minimise button goes to the taskbar as usual. Use **Quit NinoGames** in the
  tray menu to exit fully.
- Fixed the app fully exiting when the window was closed.
