'use strict';
const { app } = require('electron');
const path = require('path');
const fs   = require('fs');

let _data = null;

function dataPath() {
  return path.join(app.getPath('userData'), 'sudata.json');
}

function load() {
  try {
    return JSON.parse(fs.readFileSync(dataPath(), 'utf8'));
  } catch {
    return { library: {}, wishlist: [], settings: {} };
  }
}

function get() {
  if (!_data) _data = load();
  return _data;
}

// Write to a sibling temp file and rename over the real one. writeFileSync
// straight onto sudata.json means a crash (or a kill from the tray) partway
// through leaves truncated JSON, and load()'s catch then silently hands back an
// empty library — the user's whole library, wishlist and playtime, gone.
// rename() is atomic on both NTFS and POSIX, so the file is always either the
// old contents or the new ones.
function save() {
  const p = dataPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(get(), null, 2));
    fs.renameSync(tmp, p);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {}
    // Last resort: a direct write is still better than losing the change.
    try { fs.writeFileSync(p, JSON.stringify(get(), null, 2)); } catch {}
  }
}

// ── Library ───────────────────────────────────────────────────
function getLibrary() {
  return Object.entries(get().library).map(([id, v]) => ({ id, ...v }));
}

function upsertLibrary(id, fields) {
  const d = get();
  d.library[id] = Object.assign(d.library[id] || {}, fields);
  save();
}

function removeLibrary(id) {
  delete get().library[id];
  save();
}

function getLibraryEntry(id) {
  return get().library[id] || null;
}

// Called once at startup to reconcile entries that were mid-flight when the app
// last exited. Anything recoverable is parked in a state the user can resume or
// retry from — flipping everything to 'failed' meant a killed app threw away
// both a partial download and a finished-but-unextracted archive.
function resetInterrupted() {
  const fs = require('fs');
  const d = get();
  let changed = false;
  const hasArchive = e => {
    if (!e.zipPath) return false;
    try { return fs.existsSync(e.zipPath); } catch { return false; }
  };

  for (const [id, entry] of Object.entries(d.library)) {
    if (entry.status === 'extracting') {
      // The archive is downloaded; only the unpack was cut short.
      if (hasArchive(entry)) {
        entry.status = 'extract-failed';
        entry.statusMsg = 'Extraction was interrupted — the download is still here.';
        entry.canRetryExtract = true;
      } else {
        entry.status = 'failed';
        entry.statusMsg = 'Interrupted';
      }
      changed = true;
    } else if (entry.status === 'downloading' || entry.status === 'preparing' || entry.status === 'paused') {
      // aria2c resumes from the partial file, so keep it as a paused download
      // the user can pick up rather than a dead 'failed' entry.
      if (entry.fileUrl && entry.filename && hasArchive(entry)) {
        entry.status = 'paused';
        entry.statusMsg = 'Paused — resume to continue';
      } else {
        entry.status = 'failed';
        entry.statusMsg = 'Interrupted';
      }
      changed = true;
    }
  }
  if (changed) save();
}

// ── Wishlist ──────────────────────────────────────────────────
function getWishlist() { return get().wishlist || []; }
function isWishlisted(id) { return (get().wishlist || []).some(g => g.id === id); }

function toggleWishlist(game) {
  const d = get();
  if (!d.wishlist) d.wishlist = [];
  const idx = d.wishlist.findIndex(g => g.id === game.id);
  if (idx >= 0) { d.wishlist.splice(idx, 1); save(); return false; }
  d.wishlist.push(game); save(); return true;
}

// ── Settings ──────────────────────────────────────────────────
const DEFAULT_SETTINGS = {
  sevenZipEnabled: true,
  aria2Enabled:    true,
  source:          'ankergames',
};

function getSettings() {
  const d = get();
  if (!d.settings) d.settings = {};
  // Apply defaults for any key that has never been set
  let changed = false;
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    if (!(k in d.settings)) {
      d.settings[k] = v;
      changed = true;
    }
  }
  if (changed) save();
  return d.settings;
}

function saveSettings(settings) {
  const d = get();
  d.settings = Object.assign(d.settings || {}, settings);
  save();
}


// ── Multiplayer Mods ─────────────────────────────────────────
function getMultiplayerMods() { return get().multiplayerMods || {}; }
function getMultiplayerMod(id) { return (get().multiplayerMods || {})[id] || null; }
function upsertMultiplayerMod(id, fields) {
  const d = get();
  if (!d.multiplayerMods) d.multiplayerMods = {};
  d.multiplayerMods[id] = Object.assign(d.multiplayerMods[id] || {}, fields);
  save();
}
function removeMultiplayerMod(id) {
  const d = get();
  if (d.multiplayerMods) delete d.multiplayerMods[id];
  save();
}

module.exports = {
  getLibrary, upsertLibrary, removeLibrary, getLibraryEntry, resetInterrupted,
  getWishlist, isWishlisted, toggleWishlist,
  getSettings, saveSettings,
  getMultiplayerMods, getMultiplayerMod, upsertMultiplayerMod, removeMultiplayerMod,

  // ── Game Tracking ─────────────────────────────────────────────
  // tracking shape: { [gameId]: { totalSeconds: number, sessions: [{start, end, seconds}] } }
  getTracking() {
    return get().tracking || {};
  },

  addPlaySession(gameId, seconds) {
    const d = get();
    if (!d.tracking) d.tracking = {};
    if (!d.tracking[gameId]) d.tracking[gameId] = { totalSeconds: 0, sessions: [], achievements: [] };
    const now = new Date().toISOString();
    d.tracking[gameId].sessions.push({ end: now, seconds });
    d.tracking[gameId].totalSeconds = (d.tracking[gameId].totalSeconds || 0) + seconds;
    // Also stamp lastPlayed on the library entry for sort-by-last-played
    if (d.library && d.library[gameId]) {
      d.library[gameId].lastPlayed = now;
    }
    save();
    return d.tracking[gameId];
  },

  addAchievement(gameId, achievement) {
    const d = get();
    if (!d.tracking) d.tracking = {};
    if (!d.tracking[gameId]) d.tracking[gameId] = { totalSeconds: 0, sessions: [], achievements: [] };
    if (!d.tracking[gameId].achievements) d.tracking[gameId].achievements = [];
    // Avoid duplicates
    const already = d.tracking[gameId].achievements.some(a => a.key === achievement.key);
    if (!already) {
      d.tracking[gameId].achievements.push(achievement);
      save();
    }
  },
};
