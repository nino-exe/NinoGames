'use strict';
/**
 * tracker.js — Game Tracking + Achievement Detection for NinoGames
 *
 * WIRE IN (main.js):
 *   const tracker = require('./tracker');
 *   tracker.init(mainWindow, store);
 *
 *   ipcMain.handle('get-tracking',      () => store.getTracking());
 *   ipcMain.handle('kill-tracked-game', () => tracker.killCurrent());
 *   ipcMain.on('confirm-close', () => { tracker.killCurrent(); setTimeout(() => mainWindow.destroy(), 200); });
 *
 *   // After spawning game process:
 *   tracker.startTracking(gameId, title, childProcess, installDir);
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { net } = require('electron');

let _win   = null;
let _store = null;

// ── Active session ────────────────────────────────────────────
let _current = null;
// { gameId, title, process, startTime, tickInterval, pollInterval,
//   appId, achievementsFile, knownEarned (Set) }

// ── Achievement schema cache ──────────────────────────────────
// appId -> { name, displayName, description, icon }[]
const _schemaCache = {};

// ── Init ──────────────────────────────────────────────────────
function init(mainWindow, store) {
  _win   = mainWindow;
  _store = store;

  mainWindow.on('close', (e) => {
    if (!_current) return;
    const settings = _store.getSettings();
    if (!settings.gameTrackingEnabled) return;
    e.preventDefault();
    mainWindow.webContents.send('close-requested');
  });
}

// ── Start tracking ────────────────────────────────────────────
function startTracking(gameId, title, proc, installDir) {
  const settings = _store ? _store.getSettings() : {};
  if (!settings.gameTrackingEnabled) return;

  if (_current) killCurrent();

  const startTime = Date.now();

  // ── Find steam_appid.txt ──────────────────────────────────
  let appId = null;
  if (installDir) {
    const appIdFile = _findFile(installDir, 'steam_appid.txt', 3);
    if (appIdFile) {
      try { appId = fs.readFileSync(appIdFile, 'utf8').trim(); } catch {}
    }
  }

  // ── Find Goldberg achievements.json ───────────────────────
  let achievementsFile = null;
  if (appId) {
    const goldbergBase = path.join(os.homedir(), 'AppData', 'Roaming', 'Goldberg SteamEmu Saves', appId);
    const candidate = path.join(goldbergBase, 'achievements.json');
    if (fs.existsSync(candidate)) achievementsFile = candidate;
  }

  // Snapshot of already-earned achievements before session starts
  const knownEarned = new Set();
  if (achievementsFile) {
    try {
      const data = JSON.parse(fs.readFileSync(achievementsFile, 'utf8'));
      for (const [key, val] of Object.entries(data)) {
        if (val && val.earned) knownEarned.add(key);
      }
    } catch {}
  }

  // ── Tick every second ─────────────────────────────────────
  const tickInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    _win && _win.webContents.send('playtime-tick', { gameId, seconds: elapsed });
  }, 1000);

  // ── Poll achievements every 30 seconds ────────────────────
  let pollInterval = null;
  if (achievementsFile && appId) {
    // Fetch schema immediately in background so it's ready
    _getSchema(appId).catch(() => {});

    pollInterval = setInterval(() => {
      _checkAchievements(gameId, appId, achievementsFile, knownEarned);
    }, 30_000);
  }

  _current = { gameId, title, process: proc, startTime, tickInterval, pollInterval,
               appId, achievementsFile, knownEarned };

  _win && _win.webContents.send('game-started', { gameId, title, hasAchievements: !!achievementsFile });

  proc.on('exit',  () => _onGameExit(gameId));
  proc.on('error', () => _onGameExit(gameId));
}

// ── Achievement polling ───────────────────────────────────────
async function _checkAchievements(gameId, appId, achievementsFile, knownEarned) {
  let data;
  try { data = JSON.parse(fs.readFileSync(achievementsFile, 'utf8')); } catch { return; }

  const schema = await _getSchema(appId).catch(() => null);

  for (const [key, val] of Object.entries(data)) {
    if (val && val.earned && !knownEarned.has(key)) {
      knownEarned.add(key);
      const info = schema ? schema.find(a => a.name === key) : null;
      _win && _win.webContents.send('achievement-unlocked', {
        gameId,
        key,
        name:        info ? info.displayName  : key,
        description: info ? info.description  : '',
        icon:        info ? info.icon         : null,
        earnedTime:  val.earned_time || Math.floor(Date.now() / 1000),
      });
      // Persist to store
      if (_store) _store.addAchievement(gameId, {
        key,
        name:        info ? info.displayName : key,
        description: info ? info.description : '',
        icon:        info ? info.icon        : null,
        earnedTime:  val.earned_time || Math.floor(Date.now() / 1000),
      });
    }
  }
}

// ── Fetch Steam achievement schema ────────────────────────────
function _getSchema(appId) {
  if (_schemaCache[appId]) return Promise.resolve(_schemaCache[appId]);
  return new Promise((resolve, reject) => {
    const url = `https://api.steampowered.com/ISteamUserStats/GetSchemaForGame/v2/?appid=${appId}&l=english`;
    const req = net.request(url);
    req.setHeader('User-Agent', 'NinoGames/1.0');
    let buf = '';
    req.on('response', res => {
      res.on('data', c => { buf += c; });
      res.on('end', () => {
        try {
          const json = JSON.parse(buf);
          const list = json?.game?.availableGameStats?.achievements || [];
          const schema = list.map(a => ({
            name:        a.name,
            displayName: a.displayName || a.name,
            description: a.description || '',
            icon:        a.icon || null,
          }));
          _schemaCache[appId] = schema;
          resolve(schema);
        } catch { reject(new Error('Schema parse failed')); }
      });
    });
    req.on('error', reject);
    // Timeout after 8 seconds
    setTimeout(() => reject(new Error('Schema fetch timeout')), 8000);
    req.end();
  });
}

// ── Game exit ─────────────────────────────────────────────────
function _onGameExit(gameId) {
  if (!_current || _current.gameId !== gameId) return;
  const { startTime, tickInterval, pollInterval, appId, achievementsFile, knownEarned } = _current;

  const seconds = Math.floor((Date.now() - startTime) / 1000);
  clearInterval(tickInterval);
  if (pollInterval) clearInterval(pollInterval);

  // Final achievement check on exit
  if (achievementsFile && appId) {
    _checkAchievements(gameId, appId, achievementsFile, knownEarned).catch(() => {});
  }

  _current = null;

  if (seconds > 5 && _store) {
    _store.addPlaySession(gameId, seconds);
  }

  _win && _win.webContents.send('game-stopped', { gameId, seconds });
}

// ── Kill current game ─────────────────────────────────────────
function killCurrent() {
  if (!_current) return;
  const { process: proc, gameId } = _current;
  try {
    if (process.platform === 'win32') {
      require('child_process').exec(`taskkill /pid ${proc.pid} /T /F`);
    } else {
      proc.kill('SIGTERM');
    }
  } catch (_) {}
  _onGameExit(gameId);
}

function isTracking() { return _current !== null; }

// ── Utility: find a file by name up to maxDepth dirs deep ─────
function _findFile(dir, filename, maxDepth) {
  if (maxDepth < 0) return null;
  try {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.isFile() && ent.name.toLowerCase() === filename.toLowerCase()) {
        return path.join(dir, ent.name);
      }
      if (ent.isDirectory()) {
        const found = _findFile(path.join(dir, ent.name), filename, maxDepth - 1);
        if (found) return found;
      }
    }
  } catch {}
  return null;
}

module.exports = { init, startTracking, killCurrent, isTracking };
