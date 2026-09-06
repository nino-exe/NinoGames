'use strict';

const { app, BrowserWindow, ipcMain, shell, session, dialog, globalShortcut, Tray, Menu, nativeImage, Notification } = require('electron');
const { net } = require('electron');
const path   = require('path');
const fs     = require('fs');
const cp     = require('child_process');
const http   = require('http');

// ── Portable mode ─────────────────────────────────────────────
// When launched from the single-file portable EXE, keep all app data
// (settings, library, downloads config) next to the EXE instead of
// stuffing it into %APPDATA%. PORTABLE_EXECUTABLE_DIR is set by the
// electron-builder portable runtime before any of our code runs.
const portableExecutableDir = process.env.PORTABLE_EXECUTABLE_DIR;
if (portableExecutableDir) {
  app.setPath('userData', path.join(portableExecutableDir, 'NinoGamesData'));
}

// ── Local HTTP server for YouTube trailer iframes ─────────────
let trailerServerPort = 0;
const rendererDir = path.join(__dirname, 'renderer');
const trailerServer = http.createServer((req, res) => {
  const filePath = path.join(rendererDir, req.url.split('?')[0]);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath);
    const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
});
trailerServer.listen(0, '127.0.0.1', () => {
  trailerServerPort = trailerServer.address().port;
});

ipcMain.handle('get-trailer-port', () => trailerServerPort);


const store   = require('./store');
const tracker = require('./tracker');
const party   = require('./party');

// ══════════════════════════════════════════════════════════════
// DM End-to-End Encryption  (P-256 ECDH + AES-256-GCM)
// ══════════════════════════════════════════════════════════════

let mainWindow;
let splashWindow;
let tray = null;
const activeDownloads = new Map();

// ── Helpers ───────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

function sendMain(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed())
    mainWindow.webContents.send(channel, data);
}

function gameIdFromUrl(url) {
  const su = url.match(/steamunlocked\.org\/([^/?#]+)/);
  if (su) return su[1].replace(/-free-download.*$/, '').replace(/-+$/, '');
  const sr = url.match(/steamrip\.com\/([^/?#]+)/);
  if (sr) return 'sr-' + sr[1].replace(/-free-download.*$/, '').replace(/-+$/, '');
  const ag = url.match(/ankergames\.net\/game\/([^/?#]+)/);
  if (ag) return 'ag-' + ag[1].replace(/-+$/, '');
  return url;
}

function decodeHTMLEntities(str) {
  return str
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .trim();
}

function fmtBytes(bytes) {
  if (!bytes) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

function getInstallDir() {
  const settings = store.getSettings();
  if (settings.installPath) return settings.installPath;
  const username = require('os').userInfo().username || '___';
  return process.platform === 'win32'
    ? path.join('C:\\Users', username, 'NinoGames')
    : path.join(app.getPath('home'), 'NinoGames');
}

// ── aria2c binary path ────────────────────────────────────────
// Place aria2c.exe (Windows) or aria2c (Linux/Mac) in:
//   <project>/resources/aria2/aria2c.exe   (dev)
//   resources/aria2/aria2c.exe             (packaged)
function getAria2Path() {
  const bin = process.platform === 'win32' ? 'aria2c.exe' : 'aria2c';
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'aria2', bin);
  }
  return path.join(__dirname, 'resources', 'aria2', bin);
}

// ── 7-Zip binary path ─────────────────────────────────────────
// Place 7za.exe (Windows standalone) in:
//   <project>/resources/7zip/7za.exe   (dev)
//   resources/7zip/7za.exe             (packaged)
function get7ZipPath() {
  const bin = process.platform === 'win32' ? '7za.exe' : '7za';
  if (app.isPackaged) {
    return path.join(process.resourcesPath, '7zip', bin);
  }
  return path.join(__dirname, 'resources', '7zip', bin);
}

// ── Archive cache directory ───────────────────────────────────
// Archives used to be written into the OS temp folder. That is a bad home for
// a 60 GB game download: Windows' Storage Sense deletes it out from under an
// in-progress download, and it always lands on C: even when the game installs
// to another drive. Keep archives next to the install dir instead, so a partial
// download survives a reboot and a finished one survives a failed extraction.
function getArchiveDir() {
  const dir = path.join(getInstallDir(), '.archives');
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
}

// Where the archive for `filename` should live. An archive left in the temp
// folder by an older build wins, so a download that was already in flight when
// the app updated is resumed instead of started over.
function resolveArchivePath(filename) {
  const legacy = path.join(app.getPath('temp'), filename);
  try {
    if (fs.existsSync(legacy) || fs.existsSync(legacy + '.aria2')) return legacy;
  } catch {}
  return path.join(getArchiveDir(), filename);
}

// ── Throttled progress persistence ────────────────────────────
// Download progress was written straight through to the store, which
// re-serialises the whole library and writes sudata.json from scratch. aria2c
// ticks once a second and Electron's DownloadItem fires far more often than
// that, so a single download meant continuous synchronous disk writes on the
// main thread — visible UI jank, and a much wider window for a kill to land
// mid-write. The renderer gets its numbers over IPC either way; the store only
// needs to be current enough to survive a restart.
const PROGRESS_PERSIST_MS = 2000;
const lastProgressWrite = new Map();

function persistProgress(gameId, fields, { force = false } = {}) {
  const now  = Date.now();
  const last = lastProgressWrite.get(gameId) || 0;
  if (!force && now - last < PROGRESS_PERSIST_MS) return;
  lastProgressWrite.set(gameId, now);
  store.upsertLibrary(gameId, fields);
}

// ── Archive sanity check ──────────────────────────────────────
// Exit code 0 from the downloader does not mean we have a usable archive: CDNs
// routinely answer with 200 + an HTML error/captcha page, and a dropped
// connection leaves a truncated file. Without this check both cases surface as
// "extract failed", which sends the user off fixing the wrong problem.
//
// The bar for calling a file junk is deliberately high, because being wrong
// here throws away a real download. We only reject a file whose first bytes
// match *no* archive format at all — matching on extension would misjudge the
// releases that ship a RAR named .zip, which 7-Zip unpacks happily.
//   { ok: true }                    → looks sound, extraction can start
//   { ok: false, junk: true }       → not an archive; only a re-download helps
//   { ok: false, truncated: true }  → real archive, incomplete; resume it
function inspectArchive(archivePath, expectedSize) {
  let size = 0;
  try {
    size = fs.statSync(archivePath).size;
  } catch {
    return { ok: false, junk: true, reason: 'the downloaded file is missing.' };
  }
  if (size === 0) return { ok: false, junk: true, reason: 'the downloaded file is empty.' };

  let head = Buffer.alloc(0);
  try {
    const fd  = fs.openSync(archivePath, 'r');
    const buf = Buffer.alloc(8);
    const n   = fs.readSync(fd, buf, 0, 8, 0);
    fs.closeSync(fd);
    head = buf.subarray(0, n);
  } catch {}

  const SIGNATURES = [
    Buffer.from('PK'),                                         // zip
    Buffer.from('Rar!'),                                       // rar
    Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]),         // 7z
    Buffer.from('MZ'),                                         // self-extracting exe
    Buffer.from([0x1f, 0x8b]),                                 // gzip
    Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a]),               // xz
    Buffer.from('BZh'),                                        // bzip2
  ];
  const looksLikeArchive = head.length >= 2 &&
    SIGNATURES.some(sig => head.length >= sig.length && head.subarray(0, sig.length).equals(sig));

  if (!looksLikeArchive) {
    const looksLikeText = /^\s*[<{]/.test(head.toString('latin1'));
    return {
      ok: false,
      junk: true,
      reason: looksLikeText
        ? 'the download host returned a web page instead of the game files — the link has most likely expired or is rate-limiting you.'
        : 'the downloaded file is not an archive.',
    };
  }

  // Truncation. The header is genuine, so the bytes we have are worth keeping:
  // aria2c can continue from them. Only flag this when the expected size is
  // actually known, and leave a little slack for servers that report loosely.
  if (expectedSize > 0 && size < expectedSize * 0.98) {
    return {
      ok: false,
      truncated: true,
      reason: `only ${fmtBytes(size)} of ${fmtBytes(expectedSize)} arrived.`,
    };
  }

  return { ok: true, size };
}

// ── aria2c downloader ─────────────────────────────────────────
// Spawns aria2c for a known direct file URL.
// Supports resume, multi-connection, retries, and progress parsing.
function aria2Download({ fileUrl, destDir, filename, refererUrl, cookies, gameId, title }) {
  return new Promise((resolve, reject) => {
    const aria2Path = getAria2Path();

    if (!fs.existsSync(aria2Path)) {
      return reject(new Error(
        `aria2c not found at ${aria2Path}. ` +
        `Download it from https://github.com/aria2/aria2/releases and place the binary in resources/aria2/`
      ));
    }

    fs.mkdirSync(destDir, { recursive: true });

    // Read existing partial file size (if any) so we can clamp the first few
    // progress ticks. aria2c fires a summary line immediately on startup before
    // it seeks to the correct offset, which makes the UI briefly flash
    // "0% / tiny / 93GB". Knowing the real partial size lets us suppress that.
    const partialPath = path.join(destDir, filename);
    let partialBytes = 0;
    try { partialBytes = fs.existsSync(partialPath) ? fs.statSync(partialPath).size : 0; } catch {}

    const args = [
      '--continue=true',                  // resume partial downloads
      '--max-connection-per-server=4',    // 4 parallel connections per server
      '--split=4',                        // split file into 4 chunks
      '--min-split-size=10M',             // only split if file > 10MB
      '--retry-wait=3',                   // wait 3s between retries
      '--max-tries=15',                   // retry up to 15 times
      '--timeout=60',                     // 60s connection timeout
      '--connect-timeout=15',             // 15s initial connect timeout
      '--file-allocation=none',           // faster start (no pre-allocation)
      '--console-log-level=notice',
      '--summary-interval=1',             // progress update every 1s
      `--dir=${destDir}`,
      `--out=${filename}`,
      `--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36`,
    ];

    if (refererUrl) args.push(`--referer=${refererUrl}`);
    if (cookies)    args.push(`--header=Cookie: ${cookies}`);

    args.push(fileUrl);

    const proc = cp.spawn(aria2Path, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const entry = activeDownloads.get(gameId);
    if (entry) entry.proc = proc;

    let stderr = '';
    let lastPct = 0;

    // aria2c progress line format:
    // [#abc123 SIZE/TOTAL(PCT%) CN:4 DL:2.0MiB ETA:30s]
    proc.stdout.on('data', d => {
      const lines = d.toString().split('\n');
      for (const line of lines) {
        // Summary line with percent
        const pctM  = line.match(/\((\d+)%\)/);
        const dlM   = line.match(/DL:([\d.]+\w+)/);
        const etaM  = line.match(/ETA:([\w]+)/);
        const sizeM = line.match(/([\d.]+\w+)\/([\d.]+\w+)/);

        if (pctM) {
          const pct      = parseInt(pctM[1]);
          const speedRaw = dlM  ? dlM[1]  : '';
          const eta      = etaM ? etaM[1] : '';
          const recv     = sizeM ? sizeM[1] : '';
          const total    = sizeM ? sizeM[2] : '';

          // Parse aria2 size/speed strings (e.g. "6.5MiB", "0.9GiB") into bytes
          function parseAria2Bytes(str) {
            if (!str) return 0;
            const m = str.match(/([\d.]+)(GiB|MiB|KiB|GB|MB|KB|B)?/i);
            if (!m) return 0;
            const val  = parseFloat(m[1]);
            const unit = (m[2] || 'B').toUpperCase();
            const mult = { GIB: 1024**3, MIB: 1024**2, KIB: 1024, GB: 1e9, MB: 1e6, KB: 1e3, B: 1 };
            return val * (mult[unit] || 1);
          }
          const speedBytes = parseAria2Bytes(speedRaw);
          // On a resumed download aria2c briefly reports tiny recvBytes before
          // seeking to the correct offset. Clamp to partialBytes so the UI
          // never shows e.g. "0% / 3.2 MB / 93 GB" when 70 GB was already done.
          const recvBytes  = Math.max(parseAria2Bytes(recv), partialBytes);
          const totalBytes = parseAria2Bytes(total);

          // Recalculate pct from clamped values so it's consistent with recvBytes
          const displayPct = totalBytes > 0 ? Math.round((recvBytes / totalBytes) * 100) : pct;
          lastPct = displayPct;
          const recvFmt  = fmtBytes(recvBytes);
          const totalFmt = totalBytes > 0 ? fmtBytes(totalBytes) : (total || '');
          const msg = totalBytes > 0
            ? `${displayPct}%  ${recvFmt} / ${totalFmt}${speedRaw ? `  •  ${speedRaw}/s` : ''}${eta ? `  •  ETA ${eta}` : ''}`
            : `${displayPct}%${speedRaw ? `  •  ${speedRaw}/s` : ''}`;

          persistProgress(gameId, { status: 'downloading', statusMsg: msg, percent: displayPct });
          sendMain('download-progress', { gameId, pct: displayPct, speed: speedBytes, recv: recvBytes, total: totalBytes, eta, msg, state: 'downloading' });
        }
      }
    });

    proc.stderr.on('data', d => { stderr += d.toString(); });

    proc.on('error', err => reject(err));

    proc.on('close', code => {
      if (code === 0) {
        resolve(path.join(destDir, filename));
      } else if (code === null) {
        // Killed intentionally (cancel/pause)
        reject(new Error('cancelled'));
      } else {
        reject(new Error(stderr.trim() || `aria2c exited with code ${code}`));
      }
    });
  });
}

// ── HTTP fetch ────────────────────────────────────────────────
function fetchPage(url, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const req = net.request({
      url, method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        ...extraHeaders,
      },
    });
    let body = '';
    let statusCode = 200;
    req.on('response', res => {
      statusCode = res.statusCode;
      res.on('data', c => { body += c.toString(); });
      res.on('end', () => resolve({ statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

// ── Parse search results ──────────────────────────────────────
function parseGames(html) {
  const games = [];

  // SteamUnlocked has changed markup over time — try each pattern in order.
  // Pattern A (current): <a class="cover-item" ...>  (same structure as homepage)
  // Pattern B (old):     <div class="cover-item category">
  // Pattern C (fallback):<div class="cover-item">
  let parts;
  if (html.includes('<a class="cover-item"')) {
    parts = html.split('<a class="cover-item"');
  } else if (html.includes('<div class="cover-item category">')) {
    parts = html.split('<div class="cover-item category">');
  } else {
    parts = html.split('<div class="cover-item">');
  }

  for (let i = 1; i < parts.length; i++) {
    const chunk = parts[i];
    const hrefM  = chunk.match(/href="(https?:\/\/steamunlocked\.org\/[^"]+)"/);
    // Title: try new markup first, fall back to <h2>
    const titleM = chunk.match(/cover-item-content__title">\s*([^<]+)/)
                || chunk.match(/<h2>([\s\S]*?)<\/h2>/);
    const imgAbsM = chunk.match(/src="(https:\/\/steamunlocked\.org\/wp-content\/uploads\/[^"]+)"/);
    const srcsetM = chunk.match(/srcset="(https:\/\/steamunlocked\.org\/wp-content\/uploads\/[^\s"]+)/);
    const imgM   = chunk.match(/<img[^>]+src="([^"]+)"/);
    const image  = (imgAbsM ? imgAbsM[1] : null) || (srcsetM ? srcsetM[1] : null) || (imgM ? imgM[1] : null);

    if (hrefM && titleM) {
      const raw  = decodeHTMLEntities(titleM[1].trim());
      const verM = raw.match(/^(.*?)\s*(\([^)]+\))\s*$/);
      games.push({
        url: hrefM[1], title: verM ? verM[1].trim() : raw,
        version: verM ? verM[2] : null, image,
      });
    }
  }
  return games;
}

// ── Parse AnkerGames search results ──────────────────────────
function parseAnkerGames(html) {
  const games = [];
  const parts = html.split('<article ');
  for (let i = 1; i < parts.length; i++) {
    const chunk = parts[i];
    const hrefM  = chunk.match(/href="(https?:\/\/ankergames\.net\/game\/[^"]+)"/);
    const titleM = chunk.match(/<h3[^>]*>([^<]+)<\/h3>/);
    const imgM   = chunk.match(/<img[^>]+src="([^"]+)"/);
    const genreM = chunk.match(/class="[^"]*opacity-70[^"]*">([^<]+)<\/p>/);
    const metaM  = chunk.match(/class="[^"]*opacity-60[^"]*">([^<]+)<\/p>/);
    if (hrefM && titleM) {
      games.push({
        url:     hrefM[1],
        title:   decodeHTMLEntities(titleM[1].trim()),
        version: null,
        image:   imgM   ? imgM[1]   : null,
        genre:   genreM ? genreM[1].trim() : null,
        meta:    metaM  ? metaM[1].trim()  : null,
        source:  'ankergames',
      });
    }
  }
  return games;
}

// ── Parse SteamUnlocked homepage (recently added + popular) ──
function parseSteamUnlockedHome(html) {
  function parseSection(section) {
    const games = [];
    const parts = section.split('<a class="cover-item"');
    for (let i = 1; i < parts.length; i++) {
      const chunk = parts[i];
      const hrefM   = chunk.match(/href="(https?:\/\/steamunlocked\.org\/[^"]+)"/);
      const titleM  = chunk.match(/cover-item-content__title">\s*([^<]+)/);
      const dateM   = chunk.match(/cover-item-content__date">\s*([^<]*)/);
      const imgAbsM = chunk.match(/src="(https:\/\/steamunlocked\.org\/wp-content\/uploads\/[^"]+)"/);
      const srcsetM = chunk.match(/srcset="(https:\/\/steamunlocked\.org\/wp-content\/uploads\/[^\s"]+)/);
      const image   = (imgAbsM ? imgAbsM[1] : null) || (srcsetM ? srcsetM[1] : null);
      if (!hrefM || !titleM) continue;
      const rawTitle = decodeHTMLEntities(titleM[1].trim());
      const verM = rawTitle.match(/^(.*?)\s+\(([^)]+)\)\s*$/);
      games.push({
        url:     hrefM[1],
        title:   verM ? verM[1].trim() : rawTitle,
        version: verM ? verM[2] : null,
        date:    dateM ? dateM[1].trim() : '',
        image,
        source:  'steamunlocked',
      });
    }
    return games;
  }

  const raIdx  = html.indexOf('Recently Added');
  const popIdx = html.indexOf('Popular games');
  const endIdx = html.indexOf('</body>');

  const recentSection  = raIdx  !== -1 && popIdx !== -1 ? html.slice(raIdx, popIdx)  : '';
  const popularSection = popIdx !== -1                  ? html.slice(popIdx, endIdx > popIdx ? endIdx : undefined) : '';

  return {
    recent:  parseSection(recentSection).slice(0, 8),
    popular: parseSection(popularSection).slice(0, 8),
  };
}

// ── Parse AnkerGames homepage (trending carousel + latest grid) ──
function parseAnkerGamesHome(html) {
  const latestIdx = html.indexOf('Latest Games');

  function parseListingArticles(section) {
    const games = [];
    const re = /listing="(\{[^"]+\})"/g;
    let m;
    while ((m = re.exec(section)) !== null) {
      try {
        const data = JSON.parse(decodeHTMLEntities(m[1]));
        const slug    = data.slug || '';
        const genres  = (data.genres || []).map(g => g.title);
        const version = data.vote_average || null;
        const size    = data.runtime || null;
        games.push({
          url:     `https://ankergames.net/game/${slug}`,
          title:   data.title || '',
          version,
          image:   data.imageurl || null,
          genre:   genres[0] || null,
          genres,
          size,
          source:  'ankergames',
        });
      } catch (_) { /* skip malformed */ }
    }
    return games;
  }

  const carouselSection = latestIdx !== -1 ? html.slice(0, latestIdx) : html;
  const latestSection   = latestIdx !== -1 ? html.slice(latestIdx)    : '';

  return {
    trending: parseListingArticles(carouselSection).slice(0, 8),
    latest:   parseListingArticles(latestSection).slice(0, 8),
  };
}

// ── Parse AnkerGames Game of the Day ─────────────────────────
function parseAnkerGotd(html) {
  try {
    // The GOTD block contains a listing attribute with JSON data
    // It also has rich HTML for poster, title, description, stats etc.

    // Find the gotd section - look for gotd-poster or gotd-ribbon
    const gotdIdx = html.indexOf('gotd-poster') !== -1 ? html.indexOf('gotd-poster') : html.indexOf('gotd-ribbon');
    if (gotdIdx === -1) return null;

    // Grab a generous chunk around it
    const start = Math.max(0, html.lastIndexOf('<div', gotdIdx - 2000));
    const chunk = html.slice(start, gotdIdx + 8000);

    // Title
    const titleM = chunk.match(/<h2[^>]*>\s*([^<]+?)\s*<\/h2>/);
    const title = titleM ? decodeHTMLEntities(titleM[1].trim()) : null;
    if (!title) return null;

    // Game URL
    const urlM = chunk.match(/href="(https:\/\/ankergames\.net\/game\/[^"]+)"/);
    const url = urlM ? urlM[1] : null;

    // Poster image
    const webpM = chunk.match(/<source\s+srcset="(https:\/\/ankergames\.net\/uploads\/poster\/[^"]+\.webp)"/i);
    const imgM  = chunk.match(/<img[^>]+src="(https:\/\/ankergames\.net\/uploads\/poster\/[^"]+\.(?:jpg|jpeg|png))"/i);
    const image = (webpM ? webpM[1] : null) || (imgM ? imgM[1] : null);

    // Date
    const dateM = chunk.match(/<time[^>]+datetime="([^"]+)"[^>]*>\s*([^<]+?)\s*<\/time>/);
    const dateDisplay = dateM ? dateM[2].trim() : null;
    const datetime    = dateM ? dateM[1] : null;

    // Description
    const descM = chunk.match(/<p[^>]*class="[^"]*text-white\/65[^"]*"[^>]*>([\s\S]*?)<\/p>/i)
               || chunk.match(/<p[^>]*>([\s\S]{40,400}?)<\/p>/);
    const description = descM ? decodeHTMLEntities(descM[1].replace(/<[^>]+>/g, '').trim()) : null;

    // Genres
    const genres = [];
    const genreRe = /class="gotd-meta-genre[^"]*"[^>]*>([^<]+)<\/span>/g;
    let gm;
    while ((gm = genreRe.exec(chunk)) !== null) genres.push(gm[1].trim());

    // Stats: downloads, likes
    const dlM    = chunk.match(/<dd[^>]*>([\d,]+)<\/dd>[\s\S]*?Downloads/);
    const likesM = chunk.match(/<dd[^>]*>([\d,]+)<\/dd>[\s\S]*?Likes/);
    const downloads = dlM    ? dlM[1]    : null;
    const likes     = likesM ? likesM[1] : null;

    // Version
    const verM = chunk.match(/title="Version">[\s\S]*?([Vv][\d.]+)/);
    const version = verM ? verM[1] : null;

    // Size, views, score from dl list
    const sizeM  = chunk.match(/<strong[^>]*>([\d.]+ GB)<\/strong>\s*size/i);
    const viewsM = chunk.match(/<strong[^>]*>([\d,]+)<\/strong>\s*views/i);
    const scoreM = chunk.match(/<strong[^>]*>([\d.]+)<\/strong>\s*score/i);

    return {
      title, url, image, datetime, dateDisplay, description,
      genres, downloads, likes, version,
      size:  sizeM  ? sizeM[1]  : null,
      views: viewsM ? viewsM[1] : null,
      score: scoreM ? scoreM[1] : null,
    };
  } catch (_) {
    return null;
  }
}

// ── Parse AnkerGames upcoming page ───────────────────────────
function parseAnkerUpcoming(html) {
  const games = [];
  const re = /listing="(\{[^"]+\})"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      const data = JSON.parse(decodeHTMLEntities(m[1]));
      const slug = data.slug || '';
      if (!data.title || !slug) continue;
      const genres = (data.genres || []).map(g => g.title);
      games.push({
        url:   `https://ankergames.net/game/${slug}`,
        title: data.title,
        image: data.imageurl || null,
        date:  data.release_date || data.releaseDate || 'TBA',
        genres,
        source: 'ankergames',
      });
    } catch (_) { /* skip malformed */ }
  }
  return games;
}

// ── Parse AnkerGames game page ────────────────────────────────
function parseAnkerGamesPage(body, gameUrl) {
  const bannerM = body.match(/property="og:image"\s+content="([^"]+)"/)
               || body.match(/content="([^"]+)"\s+property="og:image"/);

  let description = null;
  const descM = body.match(/<p[^>]*class="[^"]*text-gray-600[^"]*mt-3[^"]*"[^>]*>([\s\S]*?)<\/p>/i)
             || body.match(/<p[^>]*class="[^"]*mt-3[^"]*text-gray-600[^"]*"[^>]*>([\s\S]*?)<\/p>/i);
  if (descM) {
    description = descM[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 800);
  }
  if (!description) {
    const metaM = body.match(/property="og:description"\s+content="([^"]+)"/)
               || body.match(/name="description"\s+content="([^"]+)"/);
    if (metaM) description = decodeHTMLEntities(metaM[1]).slice(0, 800);
  }

  const screenshots = [];
  const seenSS = new Set();
  const ssRe = /(?:src|data-src|data-lazy-src)="(https?:\/\/ankergames\.net\/uploads\/[^"]+\.(?:jpg|jpeg|png|webp))"/gi;
  let ssM;
  while ((ssM = ssRe.exec(body)) !== null) {
    const u = ssM[1];
    if (seenSS.has(u) || u.includes('/poster/') || u.includes('/user/')) continue;
    seenSS.add(u);
    screenshots.push(u);
  }

  const sysReqItems = [];
  const sysReqAnchor = body.search(/System Requirements/i);
  if (sysReqAnchor !== -1) {
    const section = body.slice(sysReqAnchor);
    const rowRe = /<dt[^>]*>([\s\S]*?)<\/dt>[\s\S]*?<dd[^>]*>([\s\S]*?)<\/dd>/gi;
    let rowM;
    while ((rowM = rowRe.exec(section)) !== null) {
      const label = rowM[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      const value = rowM[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      if (label && value) sysReqItems.push({ label, value });
    }
  }

  const idM = body.match(/generateDownloadUrl\((\d+)\)/);
  const ankerGameId = idM ? idM[1] : null;
  const sizeM = body.match(/(\d+(?:\.\d+)?\s*GB)/i);

  // ── Extract YouTube trailer ───────────────────────────────────
  let trailerVideoId = null;
  // Decode HTML entities so encoded URLs (&amp; &#x2F; etc) are matchable
  const decodedBody = body.replace(/&amp;/g, '&').replace(/&#x2F;/gi, '/').replace(/&#47;/g, '/');
  const ytEmbedM = decodedBody.match(/youtube\.com\/embed\/([A-Za-z0-9_-]{11})/i)
                || decodedBody.match(/youtu\.be\/([A-Za-z0-9_-]{11})/i)
                || decodedBody.match(/youtube\.com\/watch[?&]v=([A-Za-z0-9_-]{11})/i)
                || decodedBody.match(/data-video-id=["']([A-Za-z0-9_-]{11})["']/i)
                || decodedBody.match(/data-youtube=["']([A-Za-z0-9_-]{11})["']/i)
                || decodedBody.match(/data-yt-id=["']([A-Za-z0-9_-]{11})["']/i)
                || decodedBody.match(/"youtube_id":"([A-Za-z0-9_-]{11})"/i)
                || decodedBody.match(/"trailer":"([A-Za-z0-9_-]{11})"/i)
                || decodedBody.match(/"video_id":"([A-Za-z0-9_-]{11})"/i)
                || decodedBody.match(/"videoId":"([A-Za-z0-9_-]{11})"/i)
                || decodedBody.match(/src="[^"]*youtube[^"]*\/embed\/([A-Za-z0-9_-]{11})/i);
  if (ytEmbedM) trailerVideoId = ytEmbedM[1].trim();

  return {
    description,
    sysReqItems,
    downloadUrl: ankerGameId ? `__ankergames__:${ankerGameId}` : null,
    downloadSource: 'AnkerGames',
    bannerImage: bannerM ? bannerM[1] : null,
    size: sizeM ? sizeM[1] : null,
    screenshots: screenshots.slice(0, 10),
    ankerGameId,
    trailerVideoId,
    gamePageUrl: gameUrl,
  };
}

// ── Parse SteamRIP listing cards ──────────────────────────────
// SteamRIP uses two equivalent card layouts:
//   Search:   <div class="container-wrapper post-element tie-standard"> … .slide[data-back] …
//   Homepage: <li class="post-item … tie-standard">               … a.post-thumb[href] …
// Both share <h2 class="the-post-title"> with a <span class="game-meta-line"> (year | size),
// a <span class="tagmetafield"> (build/version), and lazy-loaded cover images.
function parseSteamRipCards(html) {
  const games = [];
  const parts = html.split(/(?=<(?:div class="container-wrapper post-element|li class="post-item))/);
  for (let i = 1; i < parts.length; i++) {
    const chunk = parts[i];

    const urlM = chunk.match(/<a[^>]+href="([^"]+)"[^>]*class="post-thumb"/i)
              || chunk.match(/class="post-thumb"[^>]*href="([^"]+)"/i)
              || chunk.match(/<a[^>]+href="([^"]+)"[^>]*class="all-over-thumb-link"/i)
              || chunk.match(/class="all-over-thumb-link"[^>]*href="([^"]+)"/i)
              || chunk.match(/the-post-title[^>]*>\s*<a[^>]+href="([^"]+)"/i);
    if (!urlM) continue;
    let url = urlM[1];
    if (url.startsWith('//')) url = 'https:' + url;
    else if (url.startsWith('/')) url = 'https://steamrip.com' + url;
    else if (!/^https?:/.test(url)) url = 'https://steamrip.com/' + url;

    let image = null;
    const imgM = chunk.match(/data-back="([^"]+)"/)
              || chunk.match(/data-src="([^"]+)"/)
              || chunk.match(/data-back-webp="([^"]+)"/);
    if (imgM) image = imgM[1].startsWith('http') ? imgM[1] : 'https://steamrip.com/' + imgM[1];

    const verM = chunk.match(/class="tagmetafield">\s*([^<]*)/i);
    const version = verM ? verM[1].trim() : null;

    const titleM = chunk.match(/<h2 class="the-post-title">([\s\S]*?)<\/h2>/i);
    if (!titleM) continue;
    const inner    = titleM[1];
    const metaM    = inner.match(/<span class="game-meta-line">([^<]*)<\/span>/i);
    const titleRaw = inner
      .replace(/<span class="game-meta-line">[^<]*<\/span>/g, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const title = decodeHTMLEntities(titleRaw.replace(/\s*Free Download\s*$/i, '').trim());
    const meta     = metaM ? metaM[1].trim() : null;

    games.push({ url, title, version, meta, image, source: 'steamrip' });
  }
  return games;
}

// ── Parse SteamRIP search results ─────────────────────────────
function parseSteamRipSearch(html) {
  return parseSteamRipCards(html);
}

// ── Parse SteamRIP homepage (Recently Added) ──────────────────
function parseSteamRipHome(html) {
  const raIdx = html.indexOf('Recently Added');
  const section = raIdx !== -1 ? html.slice(raIdx) : html;
  return { recent: parseSteamRipCards(section).slice(0, 8) };
}

// ── Parse SteamRIP game page ──────────────────────────────────
// Download blocks: <strong>BZZHR/GOFILE/FileDitch</strong> + <a class="shortc-button" href="//host/...">DOWNLOAD HERE</a>
// The LANGUAGES section repeats those links further down the page, so scanning
// stops at the LANGUAGES heading to avoid picking up per-language mirrors.
function parseSteamRipGamePage(body, gameUrl) {
  const titleM = body.match(/<h1 class="post-title entry-title"[^>]*>([\s\S]*?)<\/h1>/i);
  const title  = titleM ? decodeHTMLEntities(titleM[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()) : null;

  const bannerM = body.match(/property="og:image"\s+content="([^"]+)"/)
               || body.match(/content="([^"]+)"\s+property="og:image"/);
  const bannerImage = bannerM ? bannerM[1] : null;

  // Description — the article intro paragraphs, everything between the entry
  // heading and the SCREENSHOTS divider.
  let description = null;
  const ssIdx = body.search(/SCREENSHOTS/i);
  const entryIdx = body.search(/<div class="entry-content entry clearfix">/i);
  if (entryIdx !== -1) {
    const ssLocal  = ssIdx !== -1 && ssIdx > entryIdx ? ssIdx : entryIdx + 12000;
    const h2Idx    = body.indexOf('<h2', entryIdx);
    // Prefer the first paragraph (skips the "<Title> Download" heading),
    // falling back to the heading itself if no <p> is present nearby.
    let start = body.indexOf('<p', entryIdx);
    if (start === -1 || start >= ssLocal || (h2Idx !== -1 && start > h2Idx + 2000))
      start = h2Idx !== -1 ? h2Idx : entryIdx;
    if (start !== -1 && ssLocal > start) {
      const raw = body.slice(start, ssLocal).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (raw) description = decodeHTMLEntities(raw).slice(0, 1200);
    }
  }

  // Size — from the GAME INFO list.
  let size = null;
  const sizeM = body.match(/Game Size:[^<]*(?:<\/strong>)?\s*([\d.,]+\s*(?:GB|MB))/i);
  if (sizeM) size = sizeM[1].trim();

  // Screenshots — full-size links inside the SCREENSHOTS section. Full-size
  // shots are usually hosted on SteamRIP (/wp-content/uploads/…) but some
  // releases hotlink originals from the publisher (//www.callofduty.com/… and
  // other external hosts), so accept any absolute/protocol-relative image link.
  const screenshots = [];
  const seen = new Set();
  if (ssIdx !== -1) {
    const sysIdx = body.search(/SYSTEM REQUIREMENTS/i);
    const end    = sysIdx !== -1 && sysIdx > ssIdx ? sysIdx : ssIdx + 20000;
    const section = body.slice(ssIdx, end);
    const addShot = u => {
      let norm = u.trim();
      if (norm.startsWith('//')) norm = 'https:' + norm;
      else if (norm.startsWith('/')) norm = 'https://steamrip.com' + norm;
      else if (!/^https?:/i.test(norm)) return;
      if (seen.has(norm)) return;
      seen.add(norm);
      screenshots.push(norm);
    };
    const ssRe = /href="([^"]+\.(?:jpg|jpeg|png|webp))"/gi;
    let sm;
    while ((sm = ssRe.exec(section)) !== null) addShot(sm[1]);
    if (!screenshots.length) {
      const thumbRe = /data-src="([^"]+\.(?:jpg|jpeg|png|webp))"/gi;
      let tm;
      while ((tm = thumbRe.exec(section)) !== null) addShot(tm[1]);
    }
  }

  // System requirements — <li><strong>Label</strong>: value</li> in .checklist.
  const sysReqItems = [];
  const sysIdx = body.search(/SYSTEM REQUIREMENTS/i);
  const infoIdx = body.search(/GAME INFO/i);
  if (sysIdx !== -1) {
    const end = infoIdx !== -1 && infoIdx > sysIdx ? infoIdx : sysIdx + 8000;
    const chunk = body.slice(sysIdx, end);
    const liRe = /<li[^>]*>([\s\S]*?)<\/li>/gi;
    let liM;
    while ((liM = liRe.exec(chunk)) !== null) {
      const raw = liM[1];
      const strongM = raw.match(/<strong[^>]*>([\s\S]*?)<\/strong>([\s\S]*)/i);
      if (strongM) {
        const label = strongM[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').replace(/:$/, '').trim();
        const value = strongM[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').replace(/^:\s*/, '').trim();
        if (label && value) { sysReqItems.push({ label, value }); continue; }
      }
      const text = raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (!text || text.length < 3 || text.length > 300) continue;
      const colonIdx = text.indexOf(':');
      if (colonIdx > 0 && colonIdx < 30) {
        const label = text.slice(0, colonIdx).trim();
        const value = text.slice(colonIdx + 1).trim();
        if (label && value) sysReqItems.push({ label, value });
      }
    }
  }

  // Download links — Gofile, BuzzHeavier (bzzhr.to), FileDitch (fileditchfiles.*),
  // or MegaDB (megadb.net).
  // Priority order: Gofile → BzzHR → FileDitch → MegaDB.
  // The LANGUAGES section repeats those links further down the page, so the scan
  // stops at the LANGUAGES heading to avoid picking up per-language mirrors.
  const downloads = [];
  const langIdx = body.search(/LANGUAGES/i);
  const dlChunk = langIdx !== -1 ? body.slice(0, langIdx) : body;
  // <a … class="…shortc-button…" … href="…">DOWNLOAD HERE</a> — attribute order varies.
  const dlRe = /<a\b([^>]*shortc-button[^>]*)>\s*DOWNLOAD HERE\s*<\/a>/gi;
  let dm;
  while ((dm = dlRe.exec(dlChunk)) !== null) {
    const hrefM = dm[1].match(/href="([^"]+)"/i);
    if (!hrefM) continue;
    let u = hrefM[1];
    if (u.startsWith('//')) u = 'https:' + u;
    else if (u.startsWith('/')) u = 'https://steamrip.com' + u;
    downloads.push(u);
  }

  const downloadUrl   = downloads.find(u => /gofile\.io\//.test(u))
                     || downloads.find(u => /bzzhr\.to\//.test(u))
                     || downloads.find(u => /fileditch|fileditchfiles/.test(u))
                     || downloads.find(u => /megadb\.net\//.test(u))
                     || null;
  const downloadSource = downloadUrl
    ? (downloadUrl.includes('gofile.io') ? 'Gofile'
      : downloadUrl.includes('bzzhr.to') ? 'BzzHR'
      : downloadUrl.includes('megadb.net') ? 'MegaDB'
      : 'FileDitch')
    : null;

  return {
    title,
    description,
    size,
    bannerImage,
    screenshots: screenshots.slice(0, 10),
    sysReqItems,
    downloadUrl,
    downloadSource,
    gamePageUrl: gameUrl,
  };
}

// ── Extract archive (ZIP or RAR) ──────────────────────────────
function extractArchive(archivePath, destDir, onProgress, forceMethod) {
  const ext = path.extname(archivePath).toLowerCase();
  if (ext === '.rar') return extractRar(archivePath, destDir, onProgress);
  return extractZip(archivePath, destDir, onProgress, forceMethod);
}

function extractRar(rarPath, destDir, onProgress) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(destDir, { recursive: true });

    let proc;
    let stderr = '';

    const handleProc = () => {
      let stdout = '';
      proc.stdout?.on('data', d => {
        stdout += d.toString();
        const pctMatches = stdout.match(/(\d{1,3})%/g);
        if (pctMatches) {
          const last = pctMatches[pctMatches.length - 1];
          if (onProgress) onProgress(`Extracting… (${last})`);
        }
        const lines = stdout.split('\n');
        lines.forEach(line => {
          if (/^(Extracting|OK)\s+/i.test(line.trim())) {
            const fname = line.trim().split(/\s+/)[1] || '';
            if (onProgress) onProgress(`Extracting… ${fname}`);
          }
        });
      });
      proc.stderr?.on('data', d => { stderr += d.toString(); });
      // Without this, a spawn failure (binary moved, blocked by antivirus) emits
      // an unhandled 'error' event, which takes the whole main process down
      // mid-download instead of failing this one extraction.
      proc.on('error', err => reject(err));
      proc.on('close', code => {
        if (code === 0) resolve(destDir);
        else reject(new Error(stderr || `Extraction exited with code ${code}`));
      });
    };

    if (process.platform === 'win32') {
      const winrar = 'C:\\Program Files\\WinRAR\\WinRAR.exe';
      const zip7   = 'C:\\Program Files\\7-Zip\\7z.exe';
      const useWinrar = fs.existsSync(winrar);
      const use7zip   = !useWinrar && fs.existsSync(zip7);
      if (useWinrar) {
        proc = cp.spawn(winrar, ['x', '-y', rarPath, destDir]);
      } else if (use7zip) {
        proc = cp.spawn(zip7, ['x', rarPath, `-o${destDir}`, '-y', '-bsp1']);
      } else {
        return reject(new Error('WinRAR or 7-Zip not found. Please install one to extract .rar files.'));
      }
    } else {
      const hasUnrar = (() => { try { cp.execSync('which unrar', { stdio: 'ignore' }); return true; } catch { return false; } })();
      const has7z    = !hasUnrar && (() => { try { cp.execSync('which 7z', { stdio: 'ignore' }); return true; } catch { return false; } })();
      if (hasUnrar) {
        proc = cp.spawn('unrar', ['x', '-y', rarPath, destDir]);
      } else if (has7z) {
        proc = cp.spawn('7z', ['x', rarPath, `-o${destDir}`, '-y', '-bsp1']);
      } else {
        return reject(new Error('unrar or 7z not found. Please install one to extract .rar files.'));
      }
    }

    handleProc();
  });
}

function extractZip(zipPath, destDir, onProgress, forceMethod) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(destDir, { recursive: true });
    const isPlatformWin = process.platform === 'win32';
    let proc;
    let settled = false;
    const done = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (proc) { try { proc.kill(); } catch {} }
      if (err) reject(err); else resolve(destDir);
    };

    const timer = setTimeout(() => done(new Error('Extraction timed out after 30 minutes')), 30 * 60 * 1000);

    // ── Try bundled 7-Zip first (when enabled in settings) ────
    const settings     = store.getSettings();
    const sevenZipPath = get7ZipPath();
    // forceMethod: '7zip' = always use 7zip, 'fallback' = skip 7zip and use PS/unzip
    const use7Zip      = forceMethod === 'fallback' ? false : (forceMethod === '7zip' ? fs.existsSync(sevenZipPath) : (settings.sevenZipEnabled !== false && fs.existsSync(sevenZipPath)));

    if (use7Zip) {
      // On Windows, trigger UAC by running 7-Zip via Start-Process -Verb RunAs.
      // Note: -RedirectStandardOutput/Error cannot be combined with -Verb RunAs
      // (Windows limitation), so we rely solely on the exit code for success/failure.
      if (isPlatformWin) {
        clearTimeout(timer);
        const sevenZipEsc = sevenZipPath.replace(/'/g, "''");
        const zipEsc      = zipPath.replace(/'/g, "''");
        const destEsc     = destDir.replace(/'/g, "''");
        // IMPORTANT: if the UAC prompt is denied/dismissed, Start-Process -Verb
        // RunAs throws and $p is never assigned. Without a try/catch, `$p.ExitCode`
        // on a null $p silently evaluates to $null, and `exit $null` exits with
        // code 0 — i.e. a cancelled/failed elevation was being reported to Node
        // as a *successful* extraction, even though nothing was actually
        // extracted. Wrap it so a denied prompt is reported as a real failure
        // (using Windows' own ERROR_CANCELLED code, 1223, so it's identifiable).
        const psCmd = `$ErrorActionPreference='Stop';try{$p=Start-Process -FilePath '${sevenZipEsc}' -ArgumentList 'x','${zipEsc}','-o${destEsc}','-y' -Verb RunAs -Wait -PassThru -WindowStyle Hidden;exit $p.ExitCode}catch{Write-Error $_.Exception.Message;exit 1223}`;
        const ps = cp.spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', psCmd]);
        ps.on('error', err => done(err));
        ps.on('close', code => {
          if (code === 0) done(null);
          else if (code === 1223) done(new Error('The administrator prompt for 7-Zip was cancelled or denied, so nothing was extracted. Try again and click "Yes" on the prompt, or turn off the "7-Zip" extraction option in NinoGames settings to use the built-in extractor instead (no UAC prompt).'));
          else done(new Error(`7-Zip elevated exited with code ${code}`));
        });
        return;
      }

      let stderr = '';
      let fileCount = 0;
      proc = cp.spawn(sevenZipPath, ['x', zipPath, `-o${destDir}`, '-y', '-bsp1'], { stdio: ['ignore', 'pipe', 'pipe'] });
      proc.stdout?.on('data', d => {
        const text = d.toString();
        const pctM = text.match(/(\d{1,3})%/);
        if (pctM && onProgress) onProgress(`Extracting… (${pctM[1]}%)`);
        text.split('\n').forEach(line => {
          if (/^Extracting\s+/i.test(line.trim())) {
            fileCount++;
            if (onProgress && fileCount % 20 === 0) onProgress(`Extracting… (${fileCount} files)`);
          }
        });
      });
      proc.stderr?.on('data', d => { stderr += d.toString(); });
      proc.on('error', err => done(err));
      proc.on('close', code => {
        if (code === 0) done(null);
        else done(new Error(stderr.trim() || `7-Zip exited with code ${code}`));
      });
      return;
    }

    // ── Fallback: PowerShell (Windows) or unzip (Unix) ────────
    if (isPlatformWin) {
      const escapedZip  = zipPath.replace(/'/g, "''");
      const escapedDest = destDir.replace(/'/g, "''");
      const cmd = `powershell -NoProfile -NonInteractive -Command "` +
        `$ErrorActionPreference='Stop';` +
        `Add-Type -AssemblyName System.IO.Compression.FileSystem;` +
        `$zip=[System.IO.Compression.ZipFile]::OpenRead('${escapedZip}');` +
        `$root=[System.IO.Path]::GetFullPath('${escapedDest}');` +
        `if(-not $root.EndsWith([System.IO.Path]::DirectorySeparatorChar)){$root=$root+[System.IO.Path]::DirectorySeparatorChar};` +
        `$total=$zip.Entries.Count;$i=0;` +
        `foreach($e in $zip.Entries){` +
          `$i++;` +
          `$outPath=[System.IO.Path]::GetFullPath([System.IO.Path]::Combine($root,$e.FullName));` +
          // Zip-slip guard: an entry named ..\..\Windows\System32\x.dll resolves
          // outside $root, so refuse anything that does not stay underneath it.
          `if(-not $outPath.StartsWith($root,[System.StringComparison]::OrdinalIgnoreCase)){` +
            `throw ('Archive contains an entry that escapes the install folder: ' + $e.FullName)` +
          `};` +
          `$dir=[System.IO.Path]::GetDirectoryName($outPath);` +
          `if($dir -and -not [System.IO.Directory]::Exists($dir)){[System.IO.Directory]::CreateDirectory($dir)|Out-Null};` +
          `if(-not $e.FullName.EndsWith('/')){` +
            `[System.IO.Compression.ZipFileExtensions]::ExtractToFile($e,$outPath,$true)` +
          `};` +
          `Write-Host "PROG:$i/$total"` +
        `};` +
        `$zip.Dispose()` +
        `"`;
      let stderr = '';
      proc = cp.exec(cmd, { maxBuffer: 200 * 1024 * 1024 });
      proc.stdout?.on('data', d => {
        const lines = d.toString().split('\n');
        for (const line of lines) {
          const m = line.match(/PROG:(\d+)\/(\d+)/);
          if (m && onProgress) onProgress(`Extracting… (${m[1]}/${m[2]} files)`);
        }
      });
      proc.stderr?.on('data', d => { stderr += d.toString(); });
      proc.on('error', err => done(err));
      proc.on('close', code => {
        if (code === 0) done(null);
        else done(new Error(stderr.trim() || `PowerShell extraction exited with code ${code}`));
      });
    } else {
      proc = cp.spawn('unzip', ['-o', zipPath, '-d', destDir]);
      let stderr = '';
      let fileCount = 0;
      proc.stdout?.on('data', d => {
        const lines = d.toString().split('\n');
        for (const line of lines) {
          if (line.trim().startsWith('inflating:') || line.trim().startsWith('extracting:')) {
            fileCount++;
            if (onProgress && fileCount % 20 === 0) onProgress(`Extracting… (${fileCount} files)`);
          }
        }
      });
      proc.stderr?.on('data', d => { stderr += d.toString(); });
      proc.on('error', err => done(err));
      proc.on('close', code => {
        if (code === 0 || code === 1) done(null);
        else done(new Error(stderr || `unzip exited ${code}`));
      });
    }
  });
}

// ── Find executable ───────────────────────────────────────────
function findExecutable(dir, gameTitle) {
  const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const titleNorm = gameTitle ? norm(gameTitle) : '';

  function score(name) {
    const n = norm(name);
    if (n.includes('unins') || n.includes('redist') || n.includes('setup') || n.includes('install')) return -1;
    if (titleNorm && n.includes(titleNorm.slice(0, Math.min(6, titleNorm.length)))) return 3;
    if (n.includes('launch') || n.includes('start') || n.includes('play')) return 2;
    return 1;
  }

  function scanDir(d, depth) {
    let best = null, bestScore = -1;
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return null; }
    const dirs = [];
    for (const e of entries) {
      if (!e.isDirectory() && e.name.toLowerCase().endsWith('.exe')) {
        const s = score(e.name);
        if (s > bestScore) { bestScore = s; best = path.join(d, e.name); }
      } else if (e.isDirectory() && !e.name.toLowerCase().includes('redist')) {
        dirs.push(e);
      }
    }
    if (best && bestScore >= 1) return best;
    if (depth > 0) {
      for (const subDir of dirs) {
        const r = scanDir(path.join(d, subDir.name), depth - 1);
        if (r) return r;
      }
    }
    if (best) return best;
    return null;
  }

  return scanDir(dir, 3);
}

// ── Add to Steam ──────────────────────────────────────────────
function findSteamShortcutsPath() {
  const os = require('os');
  const home = os.homedir();
  const platform = process.platform;
  let steamPaths = [];
  if (platform === 'win32') {
    steamPaths = [
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Steam'),
      path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Steam'),
    ];
  } else if (platform === 'linux') {
    steamPaths = [
      path.join(home, '.steam', 'steam'),
      path.join(home, '.local', 'share', 'Steam'),
    ];
  } else if (platform === 'darwin') {
    steamPaths = [path.join(home, 'Library', 'Application Support', 'Steam')];
  }
  for (const sp of steamPaths) {
    const userdataDir = path.join(sp, 'userdata');
    if (!fs.existsSync(userdataDir)) continue;
    try {
      const users = fs.readdirSync(userdataDir).filter(d => /^\d+$/.test(d));
      if (users.length > 0) {
        const sorted = users.sort((a, b) => {
          try { return fs.statSync(path.join(userdataDir, b)).mtimeMs - fs.statSync(path.join(userdataDir, a)).mtimeMs; } catch { return 0; }
        });
        return path.join(userdataDir, sorted[0], 'config', 'shortcuts.vdf');
      }
    } catch {}
  }
  return null;
}

function vdfStr(key, val) {
  return Buffer.concat([
    Buffer.from([0x01]),
    Buffer.from(key + '\x00', 'utf8'),
    Buffer.from((val || '') + '\x00', 'utf8'),
  ]);
}
function vdfU32(key, val) {
  const num = Buffer.alloc(4);
  num.writeUInt32LE((val >>> 0), 0);
  return Buffer.concat([Buffer.from([0x02]), Buffer.from(key + '\x00', 'utf8'), num]);
}
function vdfObjStart(key) {
  return Buffer.concat([Buffer.from([0x00]), Buffer.from(key + '\x00', 'utf8')]);
}
function vdfObjEnd() { return Buffer.from([0x08]); }

function buildShortcutsVdf(entries) {
  const parts = [vdfObjStart('shortcuts')];
  for (const e of entries) {
    parts.push(vdfObjStart(String(e.idx)));
    parts.push(vdfU32('appid', e.appId));
    parts.push(vdfStr('AppName', e.title));
    parts.push(vdfStr('Exe', `"${e.execPath}"`));
    parts.push(vdfStr('StartDir', e.startDir || path.dirname(e.execPath)));
    parts.push(vdfStr('icon', e.execPath));
    parts.push(vdfStr('ShortcutPath', ''));
    parts.push(vdfStr('LaunchOptions', e.launchArgs || ''));
    parts.push(vdfU32('IsHidden', 0));
    parts.push(vdfU32('AllowDesktopConfig', 1));
    parts.push(vdfU32('AllowOverlay', 1));
    parts.push(vdfU32('openvr', 0));
    parts.push(vdfU32('Devkit', 0));
    parts.push(vdfStr('DevkitGameID', ''));
    parts.push(vdfU32('LastPlayTime', 0));
    parts.push(vdfObjStart('tags'));
    parts.push(vdfObjEnd());
    parts.push(vdfObjEnd());
  }
  parts.push(vdfObjEnd());
  return Buffer.concat(parts);
}

function parseShortcutsVdf(buf) {
  const entries = [];
  let i = 0;
  while (i < buf.length - 2) {
    const key = 'AppName\x00';
    const needle = Buffer.from('\x01' + key, 'utf8');
    const pos = buf.indexOf(needle, i);
    if (pos === -1) break;
    let start = pos + needle.length;
    let end = start;
    while (end < buf.length && buf[end] !== 0) end++;
    const name = buf.slice(start, end).toString('utf8');
    const exeNeedle = Buffer.from('\x01Exe\x00', 'utf8');
    const exePos = buf.indexOf(exeNeedle, pos);
    let exePath = '';
    if (exePos !== -1) {
      let es = exePos + exeNeedle.length;
      let ee = es;
      while (ee < buf.length && buf[ee] !== 0) ee++;
      exePath = buf.slice(es, ee).toString('utf8').replace(/^"|"$/g, '');
    }
    entries.push({ title: name, execPath: exePath });
    i = pos + 1;
  }
  return entries;
}

ipcMain.handle('add-to-steam', async (_e, { gameId, execPath, title, launchArgs, startDir }) => {
  if (!execPath) return { error: 'No executable path provided.' };
  try {
    const shortcutsPath = findSteamShortcutsPath();
    if (!shortcutsPath) return { error: 'Steam userdata folder not found. Is Steam installed?' };
    fs.mkdirSync(path.dirname(shortcutsPath), { recursive: true });
    let appId = 0;
    const src = (title || '') + (execPath || '');
    for (let ci = 0; ci < src.length; ci++) { appId = (appId * 31 + src.charCodeAt(ci)) >>> 0; }
    let existingParsed = [];
    if (fs.existsSync(shortcutsPath)) {
      try {
        const existing = fs.readFileSync(shortcutsPath);
        existingParsed = parseShortcutsVdf(existing);
        fs.copyFileSync(shortcutsPath, shortcutsPath + '.bak');
      } catch {}
    }
    const allEntries = existingParsed.map((e, idx) => ({
      idx, appId: 0, title: e.title, execPath: e.execPath, startDir: path.dirname(e.execPath), launchArgs: '',
    }));
    allEntries.push({
      idx: allEntries.length,
      appId,
      title: title || gameId,
      execPath,
      startDir: startDir || path.dirname(execPath),
      launchArgs: launchArgs || '',
    });
    const output = buildShortcutsVdf(allEntries);
    fs.writeFileSync(shortcutsPath, output);
    return { ok: true, shortcutsPath };
  } catch (err) {
    return { error: err.message };
  }
});

// ── Add to Steam via external tool (steamtinkerlaunch / BoilR) ──
function resolveToolPath(method) {
  const platform = process.platform;
  const bases = [
    path.join(app.getAppPath(), 'resources'),
    path.join(__dirname, 'resources'),
    path.join(__dirname, '..', 'resources'),
  ];
  if (method === 'boilr') {
    const exeName = platform === 'win32' ? 'windows_BoilR.exe'
                  : platform === 'darwin' ? 'mac_BoilR'
                  : 'linux_BoilR';
    for (const base of bases) {
      const full = path.join(base, 'boilr', exeName);
      if (fs.existsSync(full)) return full;
    }
    return 'boilr'; // fall back to PATH
  }
  if (method === 'stl') {
    for (const base of bases) {
      const full = path.join(base, 'steamtinkerlaunch', 'steamtinkerlaunch');
      if (fs.existsSync(full)) return full;
    }
    return 'steamtinkerlaunch'; // fall back to PATH
  }
  return null;
}

ipcMain.handle('add-to-steam-external', async (_e, { method, execPath, title, launchArgs }) => {
  if (!execPath) return { error: 'No executable path provided.' };
  return new Promise((resolve) => {
    let cmd, args;
    if (method === 'stl') {
      cmd = resolveToolPath('stl');
      args = ['addnonsteamgame', title || path.basename(execPath), execPath];
      if (launchArgs) args.push(launchArgs);
    } else if (method === 'boilr') {
      cmd = resolveToolPath('boilr');
      args = ['--only-add'];
    } else {
      return resolve({ error: `Unknown external method: ${method}` });
    }
    cp.execFile(cmd, args, { timeout: 15000 }, (err, stdout, stderr) => {
      if (err) {
        const msg = stderr?.trim() || err.message || 'Unknown error';
        resolve({ error: `${path.basename(cmd)} failed: ${msg}` });
      } else {
        resolve({ ok: true, stdout: (stdout || '').trim() || `${path.basename(cmd)} ran successfully.` });
      }
    });
  });
});

// ── Add to Steam via steam-shortcut-editor library ────────────
ipcMain.handle('add-to-steam-lib', async (_e, { gameId, execPath, title, launchArgs, startDir }) => {
  if (!execPath) return { error: 'No executable path provided.' };
  try {
    const shortcut = require('steam-shortcut-editor');
    const shortcutsPath = findSteamShortcutsPath();
    if (!shortcutsPath) return { error: 'Steam userdata folder not found. Is Steam installed?' };
    fs.mkdirSync(path.dirname(shortcutsPath), { recursive: true });

    const parseOpts = { autoConvertArrays: true, autoConvertBooleans: true };
    const existing = await new Promise((res, rej) => {
      if (!fs.existsSync(shortcutsPath)) return res({ shortcuts: [] });
      shortcut.parseFile(shortcutsPath, parseOpts, (err, obj) => {
        if (err) return res({ shortcuts: [] });
        res(obj || { shortcuts: [] });
      });
    });

    const shortcuts = Array.isArray(existing.shortcuts) ? existing.shortcuts : [];
    // Avoid duplicates
    const already = shortcuts.some(s => (s.exe || '').replace(/"/g, '') === execPath);
    if (already) return { ok: true, stdout: 'Already in Steam shortcuts.' };

    // Backup
    if (fs.existsSync(shortcutsPath)) fs.copyFileSync(shortcutsPath, shortcutsPath + '.bak');

    shortcuts.push({
      AppName: title || gameId,
      exe: `"${execPath}"`,
      StartDir: `"${startDir || path.dirname(execPath)}"`,
      LaunchOptions: launchArgs || '',
      IsHidden: false,
      AllowDesktopConfig: true,
      OpenVR: false,
      tags: [],
    });

    await new Promise((res, rej) => {
      shortcut.writeFile(shortcutsPath, { shortcuts }, (err) => {
        if (err) rej(err); else res();
      });
    });

    return { ok: true, stdout: `Added "${title || gameId}" via steam-shortcut-editor.` };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('add-desktop-shortcut', async (_e, { title, execPath }) => {
  try {
    let chosenExe = execPath;

    // Fallback: if no execPath provided, show file picker
    if (!chosenExe) {
      const { canceled, filePaths } = await dialog.showOpenDialog({
        title: 'Select the EXE to create a shortcut for',
        defaultPath: app.getPath('home'),
        filters: [{ name: 'Executable', extensions: ['exe'] }],
        properties: ['openFile'],
      });
      if (canceled || !filePaths.length) return { canceled: true };
      chosenExe = filePaths[0];
    }

    const desktop   = app.getPath('desktop');

    // Use provided title or fall back to the exe filename (without extension)
    const baseName = path.basename(chosenExe, '.exe');
    const safeName = (title || baseName).replace(/[<>:"/\\|?*]/g, '').trim() || baseName;

    if (process.platform === 'win32') {
      const lnkPath = path.join(desktop, `${safeName}.lnk`);
      const ps = [
        `$s=(New-Object -COM WScript.Shell).CreateShortcut('${lnkPath.replace(/'/g, "''")}')`,
        `$s.TargetPath='${chosenExe.replace(/'/g, "''")}'`,
        `$s.IconLocation='${chosenExe.replace(/'/g, "''")}',0`,
        `$s.WorkingDirectory='${path.dirname(chosenExe).replace(/'/g, "''")}'`,
        `$s.Save()`,
      ].join(';');
      cp.execSync(`powershell -NoProfile -NonInteractive -Command "${ps}"`);
    } else if (process.platform === 'linux') {
      const desktopEntry = [
        '[Desktop Entry]',
        `Name=${safeName}`,
        `Exec=${chosenExe}`,
        `Icon=${chosenExe}`,
        'Type=Application',
        'Terminal=false',
      ].join('\n') + '\n';
      fs.writeFileSync(path.join(desktop, `${safeName}.desktop`), desktopEntry, { mode: 0o755 });
    }

    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
});

// ── Window creation ───────────────────────────────────────────
// ── Window navigation lockdown ────────────────────────────────
// The main window holds the preload bridge, so anything that manages to
// navigate it — a stray target=_blank, a drag-and-dropped link, a redirect —
// would inherit window.api. Pin it to the local renderer files: any other
// destination is cancelled and, if it looks like a web link, handed to the
// user's real browser instead.
function hardenWindow(win) {
  const wc = win.webContents;

  wc.setWindowOpenHandler(({ url }) => {
    try {
      const u = new URL(url);
      if (u.protocol === 'http:' || u.protocol === 'https:') shell.openExternal(u.href);
    } catch {}
    return { action: 'deny' };
  });

  wc.on('will-navigate', (e, url) => {
    if (url.startsWith('file://')) return; // our own pages
    e.preventDefault();
    try {
      const u = new URL(url);
      if (u.protocol === 'http:' || u.protocol === 'https:') shell.openExternal(u.href);
    } catch {}
  });

  // No webviews, no <iframe src> escalation, no attaching extra preloads.
  wc.on('will-attach-webview', (e) => e.preventDefault());

  // Nothing here needs camera, microphone, geolocation or notifications. Note
  // this is the default session, shared with the trailer window — so fullscreen
  // stays allowed, otherwise the YouTube player's fullscreen button breaks.
  wc.session.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'fullscreen');
  });
}

function createWindow() {
  // Show the splash only after its DOM is fully loaded
  // (avoids a blank white flash before the splash HTML renders)

  mainWindow = new BrowserWindow({
    width: 1280, height: 820, minWidth: 920, minHeight: 620,
    frame: false, backgroundColor: '#1A1A1A',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
    },
    show: false,
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  hardenWindow(mainWindow);
  tracker.init(mainWindow, store);

  // Create splash but keep it hidden until its DOM is ready
  splashWindow = new BrowserWindow({
    width: 460, height: 320,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    center: true,
    backgroundColor: '#111114',
    roundedCorners: true,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  splashWindow.loadFile(path.join(__dirname, 'renderer', 'splash.html'));
  hardenWindow(splashWindow);

  // Show splash only when its DOM is ready
  splashWindow.once('ready-to-show', () => {
    splashWindow.show();
  });

  mainWindow.once('ready-to-show', () => {
    // Use Windows' native open-window animation instead of manual opacity fade.
    // Setting animate:true on show() triggers the OS-level window-open animation
    // (scale + fade on Windows 11/10, equivalent on other platforms).
    // First destroy the splash, then show the main window with native animation.

    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.destroy();
    }

    // showInactive() then animate-show gives the cleanest native open animation.
    // On Windows this produces the built-in scale-up + fade the OS uses for
    // all app windows, which is far smoother than a manual setOpacity loop.
    mainWindow.show();
  });
  mainWindow.on('maximize',   () => sendMain('window-state', 'maximized'));
  mainWindow.on('unmaximize', () => sendMain('window-state', 'normal'));
  mainWindow.on('close', e => {
    if (app.isQuiting) return; // tray "Quit" — let it through
    e.preventDefault();
    const hasActive = [...activeDownloads.values()].some(d =>
      d.status === 'downloading' || d.status === 'preparing' || d.status === 'extracting'
    );
    if (hasActive) {
      dialog.showMessageBox(mainWindow, {
        type: 'warning',
        title: 'Download in progress',
        message: 'A download is currently in progress.',
        detail: 'Closing will minimise NinoGames to the system tray and keep the download running. Quit from the tray to cancel.',
        buttons: ['Minimise to Tray', 'Quit Anyway'],
        defaultId: 0,
        cancelId: 0,
      }).then(({ response }) => {
        if (response === 1) {
          // Force quit
          for (const dl of activeDownloads.values()) {
            try { dl.window && !dl.window.isDestroyed() && dl.window.destroy(); } catch {}
          }
          activeDownloads.clear();
          tracker.killCurrent();
          app.isQuiting = true;
          mainWindow.destroy();
        } else {
          mainWindow.hide();
        }
      });
    } else {
      mainWindow.hide();
    }
  });
}

// ── Single instance lock ──────────────────────────────────────
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    }
  });
}

app.whenReady().then(() => {
  store.resetInterrupted();

  // Remove junk entries: numeric-only IDs with no title (orphaned pre-tracking entries)
  store.getLibrary()
    .filter(e => /^\d+$/.test(e.id) && !e.title)
    .forEach(e => store.removeLibrary(e.id));

  createWindow();

  // ── System Tray ───────────────────────────────────────────
  (function setupTray() {
    // Use app icon if available, else a blank 16x16
    let trayIcon;
    const iconPath = path.join(__dirname, 'resources', 'icon.ico');
    try {
      trayIcon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
    } catch (_) {
      trayIcon = nativeImage.createEmpty();
    }
    tray = new Tray(trayIcon);
    tray.setToolTip('NinoGames');

    function buildTrayMenu() {
      const library = store.getLibrary();
      const tracking = store.getTracking();

      // Pick up to 5 recently played games (sorted by lastPlayed desc)
      const recent = library
        .filter(e => e.status === 'installed' && e.lastPlayed)
        .sort((a, b) => new Date(b.lastPlayed) - new Date(a.lastPlayed))
        .slice(0, 5);

      const recentItems = recent.length
        ? recent.map(e => {
            const secs = tracking[e.id]?.totalSeconds || 0;
            const hrs  = secs >= 3600 ? ` (${Math.round(secs/3600)}h)` : secs >= 60 ? ` (${Math.round(secs/60)}m)` : '';
            return {
              label: (e.title || e.id).slice(0, 40) + hrs,
              click: () => {
                mainWindow.show();
                mainWindow.webContents.send('tray-launch-game', { gameId: e.id });
              },
            };
          })
        : [{ label: 'No recent games', enabled: false }];

      // Active downloads
      const downloading = library.filter(e => ['downloading','preparing','extracting','paused'].includes(e.status));
      const dlItems = downloading.length
        ? downloading.map(e => ({
            label: `${(e.title || e.id).slice(0,30)} — ${e.percent || 0}%`,
            enabled: false,
          }))
        : [];

      const menuTemplate = [
        { label: 'NinoGames', enabled: false },
        { type: 'separator' },
        { label: 'Show Window', click: () => { mainWindow.show(); mainWindow.focus(); } },
        { type: 'separator' },
        { label: 'Recently Played', enabled: false },
        ...recentItems,
      ];

      if (dlItems.length) {
        menuTemplate.push({ type: 'separator' });
        menuTemplate.push({ label: 'Active Downloads', enabled: false });
        menuTemplate.push(...dlItems);
      }

      menuTemplate.push({ type: 'separator' });
      menuTemplate.push({ label: 'Quit NinoGames', click: () => { app.isQuiting = true; app.quit(); } });

      tray.setContextMenu(Menu.buildFromTemplate(menuTemplate));
    }

    buildTrayMenu();
    // Rebuild menu every 5 seconds to reflect download progress
    setInterval(buildTrayMenu, 5000);

    tray.on('click', () => {
      if (mainWindow.isVisible()) {
        mainWindow.focus();
      } else {
        mainWindow.show();
      }
    });


  })();

  // ── Discord RPC ────────────────────────────────────────────
  // Automatically retries the connection every 15 s so users never need
  // to restart NinoGames after opening Discord.
  const DEFAULT_RPC_CLIENT_ID = '1500441174006169770';

  let rpcClient    = null;
  let rpcAvailable = false;
  let rpcRetryTimer = null;
  let rpcRegistered = false;

  // ── Is Discord actually running? ─────────────────────────
  // Every RPC call travels over Discord's local IPC socket, so the socket's
  // existence is the precise precondition for talking to it — cheaper than
  // scanning the process list (no process spawn) and more accurate, since it
  // also covers Canary, PTB, Flatpak and snap builds, which all publish the
  // same discord-ipc-N endpoint under different process names.
  //
  // Without this, a closed Discord meant a fresh Client + login attempt every
  // 15 s forever, each one re-registering a protocol handler in the registry
  // and failing into a warn log.
  //
  // On Windows the check MUST enumerate the pipe directory rather than stat the
  // pipe itself: fs.existsSync() on a named pipe opens it, which consumes one
  // of Discord's free pipe instances. Measured on this machine, the first
  // existsSync returns true and the next ~200 return false until the instance
  // is recycled — so statting would both misreport Discord as closed and
  // compete with our own RPC client for the pipe. readdirSync only lists the
  // object directory and never opens anything.
  const DISCORD_PIPE_RE = /^discord-ipc-\d$/i;
  let discordSeenAt = 0;
  let discordSeen   = false;

  function probeDiscordIpc() {
    if (process.platform === 'win32') {
      try {
        return fs.readdirSync('\\\\.\\pipe\\').some(n => DISCORD_PIPE_RE.test(n));
      } catch {
        return true; // can't tell — fail open and let the login attempt decide
      }
    }
    // Unix domain sockets: existsSync is a plain stat here and does not connect,
    // so it is safe. Mirrors Discord's own lookup order, sandboxes included.
    const base = process.env.XDG_RUNTIME_DIR || process.env.TMPDIR ||
                 process.env.TMP || process.env.TEMP || '/tmp';
    const dirs = [base, path.join(base, 'app', 'com.discordapp.Discord'), path.join(base, 'snap.discord')];
    try {
      for (const d of dirs) {
        for (let i = 0; i < 10; i++) {
          if (fs.existsSync(path.join(d, `discord-ipc-${i}`))) return true;
        }
      }
      return false;
    } catch {
      return true;
    }
  }

  // update-rpc fires on every download progress tick, so memoise briefly rather
  // than listing a few hundred pipe names several times a second.
  function isDiscordRunning() {
    const now = Date.now();
    if (now - discordSeenAt < 3000) return discordSeen;
    discordSeen   = probeDiscordIpc();
    discordSeenAt = now;
    return discordSeen;
  }

  function getActiveRpcClientId() {
    const settings = store.getSettings();
    return (settings.discordRpcClientId && settings.discordRpcClientId.trim())
      ? settings.discordRpcClientId.trim()
      : DEFAULT_RPC_CLIENT_ID;
  }

  function connectDiscordRPC() {
    // If already connected, nothing to do
    if (rpcClient) return;

    // Don't knock on a door that isn't there.
    if (!isDiscordRunning()) return;

    const clientId = getActiveRpcClientId();
    let DiscordRPC;
    try { DiscordRPC = require('discord-rpc'); } catch (err) {
      console.warn('[Discord RPC] discord-rpc module not available:', err.message);
      return; // module missing — don't retry
    }

    try {
      // register() writes a protocol handler to the registry on Windows, so do
      // it once per client ID rather than on every reconnection attempt.
      if (!rpcRegistered) { DiscordRPC.register(clientId); rpcRegistered = true; }
      const client = new DiscordRPC.Client({ transport: 'ipc' });

      client.on('ready', () => {
        console.log('[Discord RPC] Connected as', client.user?.username);
        rpcClient    = client;
        rpcAvailable = true;
        sendMain('rpc-status', { connected: true });
        // The timer keeps running while connected — it is what notices Discord
        // being closed. scheduleRpcRetry() is a no-op if it is already going.
        scheduleRpcRetry();
      });

      client.on('disconnected', () => {
        console.warn('[Discord RPC] Disconnected — will retry…');
        rpcClient    = null;
        rpcAvailable = false;
        sendMain('rpc-status', { connected: false });
        scheduleRpcRetry();
      });

      client.login({ clientId }).catch(err => {
        console.warn('[Discord RPC] Login failed (Discord not running?):', err.message);
        // Destroy this client so the next retry creates a fresh one
        try { client.destroy().catch(() => {}); } catch (_) {}
        scheduleRpcRetry();
      });
    } catch (err) {
      console.warn('[Discord RPC] Setup error:', err.message);
      scheduleRpcRetry();
    }
  }

  function scheduleRpcRetry() {
    if (rpcRetryTimer) return; // already scheduled
    rpcRetryTimer = setInterval(() => {
      if (!rpcClient) {
        // Quiet no-op while Discord is closed — no client, no login, no log.
        if (!isDiscordRunning()) return;
        console.log('[Discord RPC] Retrying connection…');
        connectDiscordRPC();
        return;
      }
      // Connected. Discord does not always emit 'disconnected' when it is
      // killed, so watch the socket ourselves and tear down when it vanishes —
      // otherwise every later setActivity writes into a dead pipe.
      if (!isDiscordRunning()) {
        console.log('[Discord RPC] Discord closed — dropping the connection.');
        dropRpcClient();
      }
    }, 15_000);
  }

  // Tear the client down and go back to waiting for Discord.
  function dropRpcClient() {
    if (rpcClient) {
      try { rpcClient.destroy().catch(() => {}); } catch (_) {}
    }
    rpcClient    = null;
    rpcAvailable = false;
    sendMain('rpc-status', { connected: false });
  }

  // Initial connection attempt
  connectDiscordRPC();
  // Start retry loop in case Discord isn't open yet
  scheduleRpcRetry();

  ipcMain.handle('rpc-available', () => rpcAvailable);

  ipcMain.handle('get-rpc-config', () => {
    const settings = store.getSettings();
    const clientId = (settings.discordRpcClientId && settings.discordRpcClientId.trim())
      ? settings.discordRpcClientId.trim()
      : DEFAULT_RPC_CLIENT_ID;
    return { clientId };
  });

  ipcMain.handle('save-rpc-config', (_e, { clientId }) => {
    try {
      const trimmed = clientId && clientId.trim() ? clientId.trim() : null;
      store.saveSettings({ discordRpcClientId: trimmed || '' });

      // Reconnect immediately with the new client ID — no restart needed
      if (rpcClient) {
        try { rpcClient.destroy().catch(() => {}); } catch (_) {}
        rpcClient    = null;
        rpcAvailable = false;
      }
      rpcRegistered = false; // new client ID needs its own protocol handler
      if (rpcRetryTimer) { clearInterval(rpcRetryTimer); rpcRetryTimer = null; }
      connectDiscordRPC();
      scheduleRpcRetry();

      return { ok: true };
    } catch (err) {
      return { error: err.message };
    }
  });

  ipcMain.handle('update-rpc', (_e, activity) => {
    if (!rpcClient) return;
    // Discord may have been closed since the last check — writing to a dead
    // socket is what makes this throw, so verify before every request.
    if (!isDiscordRunning()) { dropRpcClient(); return; }
    try { rpcClient.setActivity(activity); } catch (_) {}
  });

  ipcMain.handle('clear-rpc', () => {
    if (!rpcClient) return;
    if (!isDiscordRunning()) { dropRpcClient(); return; }
    try { rpcClient.clearActivity(); } catch (_) {}
  });

  // Lets the renderer skip the IPC round-trip entirely while Discord is shut.
  ipcMain.handle('rpc-running', () => isDiscordRunning());

  ipcMain.on('tray-rebuild-menu', () => {
    if (tray && !tray.isDestroyed()) buildTrayMenu && buildTrayMenu();
  });

  // ── Handle --launch <gameId> from desktop shortcut ────────
  // When tracking is on, desktop shortcuts point to NinoGames.exe --launch <gameId>
  // We wait for the renderer to be fully ready before sending the launch command.
  const launchArg = process.argv.find(a => a === '--launch');
  const launchArgIdx = process.argv.indexOf('--launch');
  const launchGameId = launchArg && launchArgIdx !== -1 ? process.argv[launchArgIdx + 1] : null;
  if (launchGameId) {
    mainWindow.webContents.once('did-finish-load', () => {
      // Small delay to let renderer JS initialise
      setTimeout(() => {
        mainWindow.webContents.send('auto-launch-game', { gameId: launchGameId });
      }, 1500);
    });
  }

  // Register global shortcuts — merged here so mainWindow is guaranteed to exist.
  // globalShortcut.register can fail silently (returns false) if the key combo is
  // claimed by another app/Chrome, so we also hook before-input-event on the
  // webContents as a reliable in-app fallback.
  const shortcutD = globalShortcut.register('CommandOrControl+Shift+D', () => {
    sendMain('toggle-devtools-panel');
  });
  if (!shortcutD) console.warn('[shortcuts] Ctrl+Shift+D registration failed — relying on before-input-event');

  globalShortcut.register('CommandOrControl+Shift+I', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.webContents.isDevToolsOpened()) {
        mainWindow.webContents.closeDevTools();
      } else {
        mainWindow.webContents.openDevTools({ mode: 'detach' });
      }
    }
  });

  // before-input-event fires before the renderer sees the key — most reliable
  // way to handle app-level shortcuts regardless of focus or globalShortcut state.
  mainWindow.webContents.on('before-input-event', (_e, input) => {
    if (input.type !== 'keyDown') return;
    if ((input.control || input.meta) && input.shift && input.key.toLowerCase() === 'd') {
      sendMain('toggle-devtools-panel');
    }
  });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin' && app.isQuiting) app.quit(); });

// ── Window controls ───────────────────────────────────────────
ipcMain.on('win-minimize',  () => mainWindow.minimize());
ipcMain.on('win-maximize',  () => mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize());
ipcMain.on('win-close',     () => mainWindow.close());
// shell.openExternal hands the string to the OS, which will happily run a
// registered protocol handler for it. These URLs come from scraped game pages
// and mod manifests, so restrict them to plain web links — otherwise a hostile
// listing could ship a file:// or custom-scheme URL and get it launched.
ipcMain.on('open-external', (_e, url) => {
  if (typeof url !== 'string' || url.length > 2048) return;
  let parsed;
  try { parsed = new URL(url); } catch { return; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    console.warn('[security] refused openExternal for scheme', parsed.protocol);
    return;
  }
  shell.openExternal(parsed.href);
});

ipcMain.on('open-path', (_e, p) => {
  if (typeof p !== 'string' || !p) return;
  shell.showItemInFolder(path.normalize(p));
});

// ── Trailer window ─────────────────────────────────────────────
let trailerWindow = null;
ipcMain.handle('open-trailer', (_e, { videoId, title }) => {
  if (trailerWindow && !trailerWindow.isDestroyed()) {
    trailerWindow.focus();
    return;
  }
  // YouTube IDs are exactly 11 URL-safe characters. Anything else came from a
  // scraped page going wrong (or trying something), and has no business being
  // interpolated into the embed URL.
  if (!/^[A-Za-z0-9_-]{11}$/.test(String(videoId || ''))) {
    return { error: 'No valid trailer found for this game.' };
  }
  const embedUrl = `http://localhost:${trailerServerPort}/trailer.html?v=${encodeURIComponent(videoId)}&title=${encodeURIComponent(title || 'Trailer')}`;
  trailerWindow = new BrowserWindow({
    width: 1024, height: 600,
    title: title ? `${title} — Trailer` : 'Trailer',
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      // webSecurity stays ON: embedding a cross-origin YouTube iframe never
      // required disabling the same-origin policy, and turning it off gave the
      // embedded page free rein over every other origin.
    },
  });
  hardenWindow(trailerWindow);
  trailerWindow.webContents.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  );
  trailerWindow.loadURL(embedUrl);
  trailerWindow.on('closed', () => { trailerWindow = null; });
});

// ── Fetch trailer video ID via JS-rendered page ───────────────
ipcMain.handle('get-trailer-video-id', async (_e, gameUrl) => {
  if (!gameUrl || !gameUrl.includes('ankergames.net')) return null;
  return new Promise(resolve => {
    let settled = false;
    const settle = val => { if (!settled) { settled = true; resolve(val); } };
    const timeout = setTimeout(() => { try { win.destroy(); } catch {} settle(null); }, 12000);

    const win = new BrowserWindow({
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        backgroundThrottling: false,
        // Same-origin policy left intact — this window only reads its own DOM.
      },
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

    win.webContents.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );

    // After page fully loads, scrape for YouTube video ID
    win.webContents.on('did-finish-load', async () => {
      // Give Vue/React a moment to render dynamic content
      setTimeout(async () => {
        try {
          const videoId = await win.webContents.executeJavaScript(`
            (function() {
              // Check iframes
              for (const iframe of document.querySelectorAll('iframe')) {
                const src = iframe.src || iframe.getAttribute('data-src') || '';
                const m = src.match(/youtube\.com\/embed\/([A-Za-z0-9_-]{11})/i)
                       || src.match(/youtu\.be\/([A-Za-z0-9_-]{11})/i);
                if (m) return m[1];
              }
              // Check data attributes
              for (const el of document.querySelectorAll('[data-video-id],[data-youtube],[data-yt-id],[data-trailer]')) {
                const v = el.dataset.videoId || el.dataset.youtube || el.dataset.ytId || el.dataset.trailer;
                if (v && /^[A-Za-z0-9_-]{11}$/.test(v.trim())) return v.trim();
              }
              // Check all src/href attributes
              for (const el of document.querySelectorAll('[src],[href]')) {
                const s = el.src || el.href || '';
                const m = s.match(/youtube\.com\/embed\/([A-Za-z0-9_-]{11})/i)
                       || s.match(/youtu\.be\/([A-Za-z0-9_-]{11})/i)
                       || s.match(/youtube\.com\/watch[?&]v=([A-Za-z0-9_-]{11})/i);
                if (m) return m[1];
              }
              // Check innerHTML / text for any YouTube pattern
              const html = document.documentElement.innerHTML;
              const m = html.match(/youtube\.com\/embed\/([A-Za-z0-9_-]{11})/i)
                     || html.match(/youtu\.be\/([A-Za-z0-9_-]{11})/i)
                     || html.match(/youtube\.com\/watch[?&]v=([A-Za-z0-9_-]{11})/i)
                     || html.match(/"youtube_id":"([A-Za-z0-9_-]{11})"/i)
                     || html.match(/"videoId":"([A-Za-z0-9_-]{11})"/i)
                     || html.match(/"trailer":"([A-Za-z0-9_-]{11})"/i)
                     || html.match(/data-video-id="([A-Za-z0-9_-]{11})"/i);
              return m ? m[1] : null;
            })()
          `);
          clearTimeout(timeout);
          try { win.destroy(); } catch {}
          settle(videoId || null);
        } catch (err) {
          clearTimeout(timeout);
          try { win.destroy(); } catch {}
          settle(null);
        }
      }, 2500);
    });

    win.webContents.on('did-fail-load', () => {
      clearTimeout(timeout);
      try { win.destroy(); } catch {}
      settle(null);
    });

    win.loadURL(gameUrl);
  });
});

// ── Uninstall NinoGames app ────────────────────────────────────
ipcMain.handle('uninstall-app', async (_e, { deleteGames }) => {
  try {
    const appDir   = path.join('C:', 'Program Files', 'NinoGames');
    const gamesDir = path.join('C:\\Users', require('os').userInfo().username || '___', 'NinoGames');

    // Confirm dialog
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['Uninstall', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Uninstall NinoGames',
      message: 'Are you sure you want to uninstall NinoGames?',
      detail: deleteGames
        ? `This will delete:\n• ${appDir}\n• ${gamesDir}\n\nThis cannot be undone.`
        : `This will delete:\n• ${appDir}\n\nYour downloaded games will not be affected.`,
    });
    if (response !== 0) return { ok: false, cancelled: true };

    // Delete app folder
    if (fs.existsSync(appDir)) fs.rmSync(appDir, { recursive: true, force: true });

    // Optionally delete games folder
    if (deleteGames && fs.existsSync(gamesDir))
      fs.rmSync(gamesDir, { recursive: true, force: true });

    // Quit the app
    app.quit();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ── Settings ──────────────────────────────────────────────────
ipcMain.handle('get-settings', () => ({ ...store.getSettings(), osUsername: require('os').userInfo().username }));
ipcMain.handle('save-settings', (_e, s) => { store.saveSettings(s); return { ok: true }; });
ipcMain.handle('pick-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'] });
  if (result.canceled) return null;
  return result.filePaths[0];
});

// ── Search ────────────────────────────────────────────────────
ipcMain.handle('search', async (_e, { query, page, source }) => {
  try {
    const enc = encodeURIComponent(query);
    const src = source || store.getSettings().source || 'ankergames';
    let url;
    if (src === 'ankergames') {
      url = page <= 1
        ? `https://ankergames.net/search/${enc}`
        : `https://ankergames.net/search/${enc}?page=${page}`;
    } else if (src === 'steamrip') {
      url = page <= 1
        ? `https://steamrip.com/?s=${enc}`
        : `https://steamrip.com/page/${page}/?s=${enc}`;
    } else {
      // Unknown source — default to ankergames
      url = page <= 1
        ? `https://ankergames.net/search/${enc}`
        : `https://ankergames.net/search/${enc}?page=${page}`;
    }
    const { statusCode, body } = await fetchPage(url);
    console.log(`[search] ${src} status=${statusCode} bodyLen=${body.length} url=${url}`);
    if (statusCode === 404 || (body.includes('404') && body.toLowerCase().includes('not found')))
      return { games: [], hasMore: false };
    if (statusCode >= 500)
      return { games: [], hasMore: false, error: `${src === 'steamrip' ? 'SteamRIP' : 'AnkerGames'} is currently down (HTTP ${statusCode}). Try switching sources in Settings or try again later.` };
    console.log('[search] body preview:', body.substring(0, 2000));
    let games;
    if (src === 'ankergames') games = parseAnkerGames(body);
    else if (src === 'steamrip') games = parseSteamRipSearch(body);
    else games = parseAnkerGames(body);
    console.log(`[search] parsed ${games.length} games`);
    return { games, hasMore: games.length > 0 };
  } catch (err) {
    return { games: [], hasMore: false, error: err.message };
  }
});

// ── Get game page info ────────────────────────────────────────
ipcMain.handle('get-game-page', async (_e, gameUrl) => {
  try {
    const { statusCode, body } = await fetchPage(gameUrl);
    if (statusCode !== 200) return { error: 'Page not found' };

    if (gameUrl.includes('ankergames.net')) {
      return parseAnkerGamesPage(body, gameUrl);
    }

    if (gameUrl.includes('steamrip.com')) {
      return parseSteamRipGamePage(body, gameUrl);
    }

    const allHrefs = [...body.matchAll(/href="(https?:\/\/[^"]{10,})"/g)].map(m => m[1]);
    const downloadHints = allHrefs.filter(h => /download|upload|haven|file/i.test(h));

    const dlM = body.match(/class="btn-download"[^>]*href="([^"]+)"/)
             || body.match(/href="([^"]+)"[^>]*class="btn-download"/)
             || body.match(/btn-download[^>]*href="([^"]+)"/)
             || body.match(/"(https?:\/\/uploadhaven\.com\/[^"]+)"/)
             || body.match(/"(https?:\/\/[^"]*upload[^"]+\.php[^"]*)"/)
             || body.match(/href="(https?:\/\/[^"]*(?:download|file)[^"]*)"/)
             || (downloadHints.length > 0 ? [null, downloadHints[0]] : null);

    const screenshots = [];
    const seenUrls = new Set();
    const screenshotRe = /(?:data-wpfc-original-src|src)="(https?:\/\/steamunlocked\.org\/wp-content\/uploads\/[^"]+\.(?:jpg|png|webp))"/gi;
    let sm;
    while ((sm = screenshotRe.exec(body)) !== null) {
      const src = sm[1];
      if (src.includes('-300x') || src.includes('-150x') || src.includes('-768x') ||
          src.includes('-100x') || src.includes('-384x') ||
          src.toLowerCase().includes('logo') || src.toLowerCase().includes('banner') ||
          seenUrls.has(src)) continue;
      seenUrls.add(src);
      screenshots.push(src);
    }
    const screenshotsOnly = screenshots.slice(1);

    let descriptionHtml = null;
    const blogM = body.match(/<div[^>]+class="blog-content"[^>]*>([\s\S]*?)<\/div>\s*(?=<div|<section|<footer|$)/i);
    if (blogM) {
      const blogHtml = blogM[0];
      const afterHeading = blogHtml.match(/Game Overview<\/h\d>([\s\S]*)/i);
      if (afterHeading) {
        const beforeImg = afterHeading[1].split(/<img/i)[0];
        const text = beforeImg.replace(/<[^>]+>/g, '').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#\d+;/g,'').replace(/&[a-z]+;/g,'').trim();
        if (text) descriptionHtml = text;
      }
    }

    const sizeM   = body.match(/Size:\s*([\d.,]+\s*[GMKBT]+)/i);
    const bannerM = body.match(/property="og:image"\s+content="([^"]+)"/)
                 || body.match(/content="([^"]+)"\s+property="og:image"/);

    const sysReqItems = [];
    const sysReqSection = body.match(/System Requirements[\s\S]{0,8000}/i);
    if (sysReqSection) {
      const chunk = sysReqSection[0];
      const liRe = /<li[^>]*>([\s\S]*?)<\/li>/gi;
      let liM;
      while ((liM = liRe.exec(chunk)) !== null) {
        const raw = liM[1];
        if (/64.bit processor and operating system/i.test(raw)) continue;
        const strongM = raw.match(/<strong[^>]*>([\s\S]*?)<\/strong>([\s\S]*)/i);
        if (strongM) {
          const label = strongM[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').replace(/:$/, '').trim();
          const value = strongM[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
          if (label && value) { sysReqItems.push({ label, value }); continue; }
        }
        const text = raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        if (!text || text.length < 3 || text.length > 300) continue;
        const colonIdx = text.indexOf(':');
        if (colonIdx > 0 && colonIdx < 30) {
          const label = text.slice(0, colonIdx).trim();
          const value = text.slice(colonIdx + 1).trim();
          if (label && value) sysReqItems.push({ label, value });
        }
      }
    }

    return {
      downloadUrl:  dlM     ? dlM[1]                      : null,
      size:         sizeM   ? sizeM[1].trim()              : null,
      bannerImage:  bannerM ? bannerM[1]                   : null,
      description:  descriptionHtml,
      screenshots:  screenshotsOnly.slice(0, 3),
      sysReqItems,
    };
  } catch (err) {
    return { error: err.message };
  }
});

// ── Fetch AnkerGames upcoming page ────────────────────────────
ipcMain.handle('fetch-upcoming', async () => {
  try {
    const { statusCode, body } = await fetchPage('https://ankergames.net/upcoming');
    if (statusCode !== 200) return { games: [], error: `HTTP ${statusCode}` };
    return { games: parseAnkerUpcoming(body) };
  } catch (err) {
    return { games: [], error: err.message };
  }
});


// ── Fetch AnkerGames Game of the Day ─────────────────────────
ipcMain.handle('fetch-gotd', async () => {
  try {
    const { statusCode, body } = await fetchPage('https://ankergames.net');
    if (statusCode !== 200) return { gotd: null, error: `HTTP ${statusCode}` };
    const gotd = parseAnkerGotd(body);
    return { gotd };
  } catch (err) {
    return { gotd: null, error: err.message };
  }
});

// ── Fetch discovery data (SteamRIP only, one page at a time) ──
ipcMain.handle('fetch-discovery', async (_e, page) => {
  const pageNum = page && page > 0 ? page : 1;
  try {
    const url = pageNum === 1 ? 'https://steamrip.com' : `https://steamrip.com/page/${pageNum}/`;
    const res = await fetchPage(url);
    if (res.statusCode !== 200) return { ok: false, games: [] };
    const games = parseSteamRipCards(res.body);
    return { ok: true, games };
  } catch (err) {
    return { ok: false, games: [] };
  }
});

// ── Fetch every SteamRIP page, dedupe, and return sorted A→Z ──
ipcMain.handle('fetch-discovery-all', async () => {
  try {
    const seen = new Set();
    const all = [];
    const addGames = (list) => {
      let added = 0;
      for (const g of list) {
        const key = g.title?.toLowerCase().trim();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        all.push(g);
        added++;
      }
      return added;
    };

    // Page 1 first — also used to detect the last page number from
    // WordPress-style pagination markup (rel="next" / page-numbers links).
    const p1 = await fetchPage('https://steamrip.com');
    if (p1.statusCode !== 200) return { ok: false, games: [] };
    addGames(parseSteamRipCards(p1.body));

    let lastPage = 1;
    const pageNums = [...p1.body.matchAll(/\/page\/(\d+)\/[^"]*"[^>]*class="[^"]*page-numbers/gi)]
      .map(m => parseInt(m[1], 10))
      .filter(n => Number.isFinite(n));
    if (pageNums.length) lastPage = Math.max(...pageNums);

    // Safety cap so a parsing miss can't trigger an unbounded crawl.
    lastPage = Math.min(lastPage, 60);

    if (lastPage > 1) {
      const remaining = [];
      for (let p = 2; p <= lastPage; p++) remaining.push(p);

      // Fetch in small concurrent batches to be polite to the source site.
      const BATCH = 6;
      for (let i = 0; i < remaining.length; i += BATCH) {
        const batch = remaining.slice(i, i + BATCH);
        const results = await Promise.allSettled(
          batch.map(p => fetchPage(`https://steamrip.com/page/${p}/`))
        );
        let batchAdded = 0;
        results.forEach(r => {
          if (r.status === 'fulfilled' && r.value.statusCode === 200) {
            batchAdded += addGames(parseSteamRipCards(r.value.body));
          }
        });
        // If we detected no page-numbers markup and a whole batch came back
        // empty, we've likely run past the real last page — stop early.
        if (!pageNums.length && batchAdded === 0) break;
      }
    }

    all.sort((a, b) => (a.title || '').localeCompare(b.title || '', undefined, { sensitivity: 'base' }));
    return { ok: true, games: all };
  } catch (err) {
    return { ok: false, games: [] };
  }
});

// ── Fetch full game list from steamrip.com/games-list-page/ ──
// ── Full games list, per source ───────────────────────────────
// SteamRIP publishes a single lightweight A-Z page. AnkerGames does not: its
// /games-list is a Livewire app whose list is loaded by clicking "Load More",
// and the button state is not reachable from the URL.
//
// Two ways in, both measured:
//   * drive a hidden window and click the button ~60 times -> 882 games / 115 s
//   * walk ?page=N and parse the server-rendered HTML  -> 924 games / 4 s
// The plain HTTP walk wins on both counts, so that is what runs here. The
// site reports totalPosts 1916, but that is every post it has; only ~924 are
// reachable through the public list either way.
const GAMES_LIST_TTL_MS = 6 * 60 * 60 * 1000;   // 6 hours
const gamesListCache = new Map();               // source -> { at, games }

function gamesListCacheFile(source) {
  return path.join(app.getPath('userData'), `games-list-${source}.json`);
}

function readGamesListCache(source) {
  const mem = gamesListCache.get(source);
  if (mem && Date.now() - mem.at < GAMES_LIST_TTL_MS) return mem;
  try {
    const raw = JSON.parse(fs.readFileSync(gamesListCacheFile(source), 'utf8'));
    if (raw && Array.isArray(raw.games) && raw.games.length) {
      gamesListCache.set(source, raw);
      return raw;
    }
  } catch { /* no cache yet */ }
  return null;
}

function writeGamesListCache(source, games) {
  const entry = { at: Date.now(), games };
  gamesListCache.set(source, entry);
  try { fs.writeFileSync(gamesListCacheFile(source), JSON.stringify(entry)); } catch { /* ignore */ }
  return entry;
}

async function fetchSteamRipList() {
  const res = await fetchPage('https://steamrip.com/games-list-page/');
  if (res.statusCode !== 200) return [];
  const games = [];
  // <li class="az-list-item"><a href="/slug/">Title Free Download (vX)</a></li>
  const re = /<li[^>]*class="az-list-item"[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([^<]+)<\/a>/gi;
  let m;
  while ((m = re.exec(res.body)) !== null) {
    let url = m[1];
    if (url.startsWith('//')) url = 'https:' + url;
    else if (url.startsWith('/')) url = 'https://steamrip.com' + url;
    else if (!/^https?:/.test(url)) url = 'https://steamrip.com/' + url;

    const raw = m[2].trim();
    const verM = raw.match(/\(([^)]+)\)\s*$/);
    const version = verM ? verM[1] : null;
    const title = decodeHTMLEntities(
      raw.replace(/\s*Free Download\b[^(]*/i, '').replace(/\([^)]*\)\s*$/, '').trim()
    );
    if (title) games.push({ url, title, version, image: null, source: 'steamrip' });
  }
  return games;
}

async function fetchAnkerGamesList() {
  const seen = new Map();       // slug -> title, so repeats across pages collapse
  const posters = new Map();    // slug -> cover art url from the site itself
  // The site rotates which games each page returns, so "this page added nothing
  // new" is luck, not the end of the list — stopping on it gave anywhere from
  // 756 to 1764 games run to run. Walking a fixed span and letting the Map
  // dedupe returns 1888 every time, measured identical across repeat runs.
  const MAX_PAGES = 45;
  let failStreak = 0;

  for (let page = 1; page <= MAX_PAGES; page++) {
    let html;
    try {
      const res = await fetchPage(`https://ankergames.net/games-list?page=${page}`);
      if (res.statusCode !== 200) throw new Error('HTTP ' + res.statusCode);
      html = res.body;
      failStreak = 0;
    } catch {
      // One flaky page used to abort the whole walk, which is why the same
      // code returned 1888 games in isolation and 1540 from inside the app.
      // Skip it and carry on; only give up if the site is properly unhappy.
      if (++failStreak >= 4) break;
      continue;
    }

    // AnkerGames serves its own cover art, so there is no reason to go to
    // SteamGridDB for these. The poster filename is prefixed with the game's
    // slug (".../oxenfree-poster_7Mpfv2_1787392573.jpg"), which lets us pair
    // image to game by name rather than by position in the markup — the cards
    // are Livewire-rendered and their internal order is not something to lean on.
    const imgRe = /https:\/\/ankergames\.net\/uploads\/poster\/[^"']*?\/([a-z0-9-]+)-poster_[^"']+\.(?:jpg|jpeg|png|webp)/gi;
    let im;
    while ((im = imgRe.exec(html)) !== null) {
      if (!posters.has(im[1])) posters.set(im[1], im[0]);
    }

    let linksOnPage = 0;
    const re = /<a\s+href="https:\/\/ankergames\.net\/game\/([a-z0-9-]+)"\s+title="([^"]*)"/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
      linksOnPage++;
      if (!seen.has(m[1])) seen.set(m[1], decodeHTMLEntities(m[2]).trim());
    }

    // A page with no game links at all is the real end of the list.
    if (linksOnPage === 0) break;
  }

  return [...seen.entries()].map(([slug, title]) => ({
    url: `https://ankergames.net/game/${slug}`,
    title: title || slug.replace(/-/g, ' '),
    version: null,
    image: posters.get(slug) || null,
    source: 'ankergames',
  }));
}

// ── Per-game cover art from the source's own page ─────────────
// Last resort for the games SteamGridDB has never heard of. Both sources put a
// usable image in og:image on the game page — SteamRIP's are wide banners
// rather than 2:3 posters, so they crop hard in the card, but a cropped banner
// beats an empty tile. One request per game, so results are cached hard: art on
// these pages effectively never changes.
const pageCoverCache = new Map();   // game url -> image url (or '' for "none")
let pageCoverDirty = false;

function pageCoverFile() {
  return path.join(app.getPath('userData'), 'page-covers.json');
}

(function loadPageCovers() {
  try {
    const raw = JSON.parse(fs.readFileSync(pageCoverFile(), 'utf8'));
    for (const [k, v] of Object.entries(raw)) pageCoverCache.set(k, v);
  } catch { /* first run */ }
})();

// Batched so a screenful of misses doesn't mean a screenful of disk writes.
let pageCoverFlushTimer = null;
function schedulePageCoverFlush() {
  pageCoverDirty = true;
  if (pageCoverFlushTimer) return;
  pageCoverFlushTimer = setTimeout(() => {
    pageCoverFlushTimer = null;
    if (!pageCoverDirty) return;
    pageCoverDirty = false;
    try {
      fs.writeFileSync(pageCoverFile(), JSON.stringify(Object.fromEntries(pageCoverCache)));
    } catch { /* ignore */ }
  }, 4000);
  pageCoverFlushTimer.unref?.();
}

ipcMain.handle('fetch-page-cover', async (_e, gameUrl) => {
  if (typeof gameUrl !== 'string') return { url: null };
  let host;
  try { host = new URL(gameUrl).hostname; } catch { return { url: null }; }
  // Only ever fetch the two sites this app scrapes.
  if (!/(^|\.)steamrip\.com$|(^|\.)ankergames\.net$/i.test(host)) return { url: null };

  if (pageCoverCache.has(gameUrl)) {
    return { url: pageCoverCache.get(gameUrl) || null, cached: true };
  }

  try {
    const res = await fetchPage(gameUrl);
    if (res.statusCode !== 200) throw new Error('HTTP ' + res.statusCode);
    const m = res.body.match(/property="og:image"\s+content="([^"]+)"/i)
           || res.body.match(/content="([^"]+)"\s+property="og:image"/i);
    let img = m ? m[1] : '';
    // Keep it to real image URLs on the sites we asked about.
    if (img) {
      try {
        const u = new URL(img, gameUrl);
        img = /^https?:$/.test(u.protocol) ? u.href : '';
      } catch { img = ''; }
    }
    pageCoverCache.set(gameUrl, img);
    schedulePageCoverFlush();
    return { url: img || null };
  } catch {
    // Cache the miss too — a game with no art shouldn't be re-fetched on every
    // scroll past it. Left out of the persisted file so a transient network
    // failure doesn't become permanent.
    pageCoverCache.set(gameUrl, '');
    return { url: null };
  }
});

ipcMain.handle('fetch-games-list', async (_e, opts) => {
  const source = (opts && opts.source) || store.getSettings().source || 'ankergames';
  const force  = !!(opts && opts.force);

  if (!force) {
    const cached = readGamesListCache(source);
    if (cached) return { ok: true, games: cached.games, cached: true, fetchedAt: cached.at };
  }

  try {
    const games = source === 'steamrip'
      ? await fetchSteamRipList()
      : await fetchAnkerGamesList();

    if (!games.length) {
      // Serve a stale cache rather than an empty page when the site is down.
      const stale = gamesListCache.get(source);
      if (stale) return { ok: true, games: stale.games, cached: true, stale: true, fetchedAt: stale.at };
      return { ok: false, games: [] };
    }

    const entry = writeGamesListCache(source, games);
    return { ok: true, games, cached: false, fetchedAt: entry.at };
  } catch (err) {
    const stale = gamesListCache.get(source);
    if (stale) return { ok: true, games: stale.games, cached: true, stale: true, fetchedAt: stale.at };
    return { ok: false, games: [], error: err.message };
  }
});

// ── Resolve BuzzHeavier (bzzhr.to) direct download URL ───────
ipcMain.handle('resolve-bzzhr', async (_e, pageUrl) => {
  try {
    const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
    const res = await fetchPage(pageUrl, { 'User-Agent': UA });
    if (res.statusCode !== 200) return { error: `HTTP ${res.statusCode}` };
    const html = res.body;

    // Find the download path — BzzHR puts it in hx-get on the .download-btn
    // e.g. hx-get="/wkmu35eyxb35/download?t=MTc4..."
    let downloadPath = null;
    const _bzzPatterns = [
      /download-btn[^>]+hx-get="([^"]+)"/i,      // hx-get on .download-btn
      /hx-get="([^"]+\/download[^?"][^"]*)"/i,  // hx-get with /download path
      /hx-get="([^"]*\/download\?[^"]*)"/i,    // hx-get with /download?t= token
      /href="([^"]*\/download\?[^"]*)"/i,      // href with /download?t= token
      /href="([^"]*\/download[^"]*)"/i,         // href with /download path
    ];
    for (const pat of _bzzPatterns) {
      const m = pat.exec(html);
      if (m) { downloadPath = m[1]; break; }
    }

    if (!downloadPath) return { error: 'Could not find download link on BzzHR page' };

    const parsed = new URL(pageUrl);
    const directUrl = new URL(downloadPath, `${parsed.protocol}//${parsed.host}`).href;

    // Extract metadata shown on the page
    const filenameM = html.match(/class="file-name"[^>]*>([^<]+)</i);
    const sizeM     = html.match(/class="size"[^>]*>([^<]+)</i);
    const md5M      = html.match(/MD5[^<]*<code[^>]*>([^<]+)<\/code>/i);
    const sha256M   = html.match(/SHA-256[^<]*<code[^>]*>([^<]+)<\/code>/i);

    return {
      ok: true,
      directUrl,
      filename: filenameM ? filenameM[1].trim() : null,
      size:     sizeM     ? sizeM[1].trim()     : null,
      md5:      md5M      ? md5M[1].trim()       : null,
      sha256:   sha256M   ? sha256M[1].trim()    : null,
    };
  } catch (err) {
    return { error: err.message };
  }
});

// ── Scan games folder for manually added games ────────────────
ipcMain.handle('scan-library', async () => {
  const installBase = getInstallDir();
  if (!fs.existsSync(installBase)) return { added: 0 };
  const existing = store.getLibrary();
  const existingIds = new Set(existing.map(e => e.id));
  let added = 0;
  const entries = fs.readdirSync(installBase, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const folderId = entry.name;
    if (folderId.startsWith('.')) continue; // .archives and friends aren't games
    if (existingIds.has(folderId)) continue;
    const installDir = path.join(installBase, folderId);
    const title = folderId.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    const execPath = findExecutable(installDir, title) || null;
    store.upsertLibrary(folderId, {
      id: folderId, title, status: 'installed', statusMsg: 'Installed (manual)',
      installDir, execPath, addedAt: new Date().toISOString(), scanned: true,
    });
    existingIds.add(folderId);
    added++;
  }
  sendMain('library-updated');
  return { added };
});


ipcMain.handle('get-library', () => store.getLibrary());

// ── SteamSpy price lookup (routed through main to bypass renderer CSP) ──
// Uses SteamSpy's free public API: no key required.
// Strategy: search Steam store by title → get appid → query SteamSpy for price.
ipcMain.handle('fetch-game-price', async (_e, title) => {
  try {
    const encoded = encodeURIComponent(title.trim());

    // Step 1: Steam store search to get the best matching appid
    const r1 = await fetchPage(
      `https://store.steampowered.com/api/storesearch/?term=${encoded}&l=en&cc=US`,
      { Accept: 'application/json' }
    );
    console.log(`[price] "${title}" → Steam search status ${r1.statusCode}, body: ${r1.body.slice(0, 200)}`);
    if (r1.statusCode !== 200) return null;
    const searchData = JSON.parse(r1.body);
    const items = searchData?.items;
    if (!items || items.length === 0) return null;

    // Pick the item whose name most closely matches the query (first result is usually best)
    const appid = items[0].id;
    if (!appid) return null;

    // Step 2: SteamSpy for that appid — returns initialprice in US cents
    const r2 = await fetchPage(
      `https://steamspy.com/api.php?request=appdetails&appid=${appid}`,
      { Accept: 'application/json' }
    );
    console.log(`[price] appid ${appid} → SteamSpy status ${r2.statusCode}, body: ${r2.body.slice(0, 200)}`);
    if (r2.statusCode !== 200) return null;
    const spy = JSON.parse(r2.body);
    // initialprice is the full (non-discounted) price in US cents
    const cents = spy?.initialprice;
    if (cents === undefined || cents === null || cents === 0) return null;
    const price = cents / 100;
    console.log(`[price] "${title}" (appid ${appid}) → $${price}`);
    return price > 0 ? price : null;
  } catch (e) { console.error('[price] error:', e); return null; }
});

ipcMain.handle('get-wishlist', () => store.getWishlist());
ipcMain.handle('is-wishlisted', (_e, id) => store.isWishlisted(id));
ipcMain.handle('toggle-wishlist', (_e, game) => store.toggleWishlist(game));




// ── Game Tracking ─────────────────────────────────────────────
ipcMain.handle('get-tracking',      () => store.getTracking());
ipcMain.handle('kill-tracked-game', () => tracker.killCurrent());
ipcMain.on('confirm-close', () => {
  tracker.killCurrent();
  setTimeout(() => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy(); }, 200);
});

ipcMain.handle('remove-game', (_e, id) => {
  // Drop any archive we were holding on to for a retry — removing the entry is
  // the user saying they no longer want it, and these files are huge.
  const entry = store.getLibraryEntry(id);
  if (entry?.zipPath) {
    try { fs.unlinkSync(entry.zipPath); } catch {}
    try { fs.unlinkSync(entry.zipPath + '.aria2'); } catch {}
  }
  store.removeLibrary(id);
  sendMain('library-updated');
  return { ok: true };
});

ipcMain.handle('uninstall-game', async (_e, id) => {
  const entry = store.getLibraryEntry(id);
  if (entry && entry.installDir) {
    try { fs.rmSync(entry.installDir, { recursive: true, force: true }); } catch {}
  }
  if (entry && entry.zipPath) {
    try { fs.unlinkSync(entry.zipPath); } catch {}
  }
  store.upsertLibrary(id, { status: 'failed', statusMsg: 'Uninstalled', installDir: null, execPath: null });
  sendMain('library-updated');
  return { ok: true };
});

// ── List all EXEs in a game's install dir ─────────────────────
ipcMain.handle('list-exes', (_e, installDir) => {
  if (!installDir || !fs.existsSync(installDir)) return { exes: [] };
  const exes = [];
  const ignore = ['unins', 'redist', 'setup', 'install', 'vcredist', 'dxsetup', 'ue4prereq'];
  function scan(dir, depth) {
    if (depth < 0) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isFile() && e.name.toLowerCase().endsWith('.exe')) {
        const lower = e.name.toLowerCase();
        if (!ignore.some(i => lower.includes(i))) {
          exes.push(path.join(dir, e.name));
        }
      } else if (e.isDirectory() && !e.name.toLowerCase().includes('redist')) {
        scan(path.join(dir, e.name), depth - 1);
      }
    }
  }
  scan(installDir, 3);
  return { exes };
});

// ── Open file picker to manually browse for an EXE ────────────
ipcMain.handle('pick-exe', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Game Executable',
    properties: ['openFile'],
    filters: [{ name: 'Executables', extensions: ['exe'] }],
  });
  return result.canceled ? null : result.filePaths[0];
});

// ── Save launch config for a game ────────────────────────────
ipcMain.handle('set-launch-config', (_e, { id, execPath, launchArgs, skipExePicker }) => {
  store.upsertLibrary(id, { execPath, launchArgs: launchArgs || '', skipExePicker: !!skipExePicker });
  return { ok: true };
});

ipcMain.handle('launch-game', (_e, id) => {
  const entry = store.getLibraryEntry(id);
  if (!entry) return { error: 'Game not found' };

  // Return picker data if skipExePicker is not set
  if (!entry.skipExePicker) {
    // Still resolve the best exe so picker can pre-select it
    let suggested = entry.execPath && fs.existsSync(entry.execPath) ? entry.execPath : null;
    let installDir = entry.installDir || null;
    // If installDir is missing but we have an execPath, derive it from the exe's directory
    if (!installDir && entry.execPath) {
      const derived = path.dirname(entry.execPath);
      if (fs.existsSync(derived)) installDir = derived;
    }
    if (!suggested && installDir) {
      suggested = findExecutable(installDir, entry.title) || null;
    }
    return { needsPicker: true, suggested, installDir };
  }

  // Launch directly
  const execPath = entry.execPath;
  if (execPath && fs.existsSync(execPath)) {
    try {
      const args = (entry.launchArgs || '').trim();
      const cwd = path.dirname(execPath);
      const proc = args
        ? cp.spawn(execPath, args.split(/\s+/), { detached: true, stdio: 'ignore', cwd })
        : cp.spawn(execPath, [], { detached: true, stdio: 'ignore', cwd });
      proc.unref();
      tracker.startTracking(id, entry.title || id, proc, entry.installDir || null);
      return { ok: true };
    } catch {}
  }
  if (entry.installDir && fs.existsSync(entry.installDir)) {
    const found = findExecutable(entry.installDir, entry.title);
    if (found) {
      store.upsertLibrary(id, { execPath: found });
      try {
        const cwd = path.dirname(found);
        const proc = cp.spawn(found, [], { detached: true, stdio: 'ignore', cwd });
        proc.unref();
        tracker.startTracking(id, entry.title || id, proc, entry.installDir || null);
        return { ok: true };
      } catch {}
    }
  }
  return { error: 'No executable found' };
});

// ── Launch game directly (used by the exe-picker after selection) ──────────
ipcMain.handle('launch-game-now', (_e, id) => {
  const entry = store.getLibraryEntry(id);
  if (!entry) return { error: 'Game not found' };
  const execPath = entry.execPath;
  if (execPath && fs.existsSync(execPath)) {
    try {
      const args = (entry.launchArgs || '').trim();
      const cwd = path.dirname(execPath);
      const proc = args
        ? cp.spawn(execPath, args.split(/\s+/), { detached: true, stdio: 'ignore', cwd })
        : cp.spawn(execPath, [], { detached: true, stdio: 'ignore', cwd });
      proc.unref();
      tracker.startTracking(id, entry.title || id, proc, entry.installDir || null);
      return { ok: true };
    } catch {}
  }
  if (entry.installDir && fs.existsSync(entry.installDir)) {
    const found = findExecutable(entry.installDir, entry.title);
    if (found) {
      store.upsertLibrary(id, { execPath: found });
      try {
        const cwd = path.dirname(found);
        const proc = cp.spawn(found, [], { detached: true, stdio: 'ignore', cwd });
        proc.unref();
        tracker.startTracking(id, entry.title || id, proc, entry.installDir || null);
        return { ok: true };
      } catch {}
    }
  }
  return { error: 'No executable found' };
});

// ── Pause / Resume (aria2c: kill proc and store progress, resume = re-download with continue) ──
function killDownload(gameId) {
  const dl = activeDownloads.get(gameId);
  if (!dl) return;
  // Kill aria2c process if running
  try { if (dl.proc && !dl.proc.killed) dl.proc.kill(); } catch {}
  // Cancel Electron DownloadItem if in built-in mode
  try { if (dl.item) dl.item.cancel(); } catch {}
  // Destroy hidden window if still in preparing phase
  try { if (dl.window && !dl.window.isDestroyed()) dl.window.destroy(); } catch {}
}

ipcMain.handle('pause-download', (_e, gameId) => {
  const dl = activeDownloads.get(gameId);
  if (!dl) return { ok: true };

  if (dl.item) {
    // Electron built-in: use native pause
    try { dl.item.pause(); } catch {}
    dl.paused = true;
    dl.status = 'paused';
  } else if (dl.proc) {
    // aria2c: kill the process — --continue=true will resume from partial file
    try { dl.proc.kill(); } catch {}
    dl.paused = true;
    dl.status = 'paused';
  } else {
    // Still in preparing phase (hidden window clicking buttons) — cancel it fully
    // Can't meaningfully pause here; treat as cancel and let user retry
    killDownload(gameId);
    activeDownloads.delete(gameId);
    store.upsertLibrary(gameId, { status: 'failed', statusMsg: 'Cancelled during preparation' });
    sendMain('library-updated');
    return { ok: true };
  }

  lastProgressWrite.delete(gameId); // let the next write through unthrottled
  store.upsertLibrary(gameId, { status: 'paused', statusMsg: 'Paused — resume to continue', paused: true });
  sendMain('library-updated');
  return { ok: true };
});

ipcMain.handle('resume-download', (_e, gameId) => {
  let dl = activeDownloads.get(gameId);

  // activeDownloads only lives as long as the process. After a restart a paused
  // download had no in-memory entry and could never be resumed, stranding the
  // partial file forever — rebuild the entry from what we persisted instead.
  if (!dl) {
    const saved = store.getLibraryEntry(gameId);
    if (!saved || !saved.fileUrl || !saved.filename) {
      return { error: 'No paused download found' };
    }
    dl = {
      status: 'paused', paused: true,
      fileUrl:    saved.fileUrl,
      filename:   saved.filename,
      refererUrl: saved.refererUrl,
      zipPath:    saved.zipPath,
      title:      saved.title,
    };
    activeDownloads.set(gameId, dl);
  }

  if (!dl.paused) return { error: 'No paused download found' };

  if (dl.item) {
    // Electron built-in: native resume
    try { dl.item.resume(); } catch {}
    dl.paused = false;
    dl.status = 'downloading';
    store.upsertLibrary(gameId, { status: 'downloading', statusMsg: 'Resuming…' });
    sendMain('library-updated');
    return { ok: true };
  }

  // aria2c: need the original file URL to re-spawn
  if (!dl.fileUrl) return { error: 'Cannot resume — original URL not stored' };

  dl.paused = false;
  dl.status = 'downloading';
  store.upsertLibrary(gameId, { status: 'downloading', statusMsg: 'Resuming…', paused: false });
  sendMain('library-updated');

  runAria2AndExtract({
    fileUrl:    dl.fileUrl,
    filename:   dl.filename,
    refererUrl: dl.refererUrl,
    cookies:    dl.cookies,
    gameId,
    title:      dl.title,
  });

  return { ok: true };
});

// ── Retry extraction from the archive we kept ─────────────────
// The whole point of holding on to the archive after a failed extraction: this
// costs seconds instead of another full download.
ipcMain.handle('retry-extract', async (_e, gameId) => {
  if (activeDownloads.has(gameId)) return { error: 'Already working on this game' };

  const entry = store.getLibraryEntry(gameId);
  if (!entry?.zipPath || !fs.existsSync(entry.zipPath)) {
    return { error: 'The downloaded archive is no longer on disk — this game has to be downloaded again.' };
  }

  activeDownloads.set(gameId, { status: 'extracting', paused: false, zipPath: entry.zipPath, title: entry.title });
  store.upsertLibrary(gameId, { status: 'extracting', statusMsg: 'Extracting…' });
  sendMain('library-updated');

  extractAndFinalize({
    gameId,
    zipPath: entry.zipPath,
    installDir: path.join(getInstallDir(), gameId),
    title: entry.title,
  });
  return { ok: true };
});

// ── Cancel download ───────────────────────────────────────────
ipcMain.handle('cancel-download', (_e, gameId) => {
  const dl = activeDownloads.get(gameId);
  // Delete the partial zip before killing so aria2c can't resume it
  const entry = store.getLibrary().find(e => e.id === gameId);
  const zipPath = dl?.zipPath || entry?.zipPath;
  killDownload(gameId);
  activeDownloads.delete(gameId);
  // Delete the partial archive and any aria2c control file (.aria2)
  if (zipPath) {
    try { fs.unlinkSync(zipPath); } catch {}
    try { fs.unlinkSync(zipPath + '.aria2'); } catch {}
  }
  // Remove the game from library entirely so UI is clean
  store.removeLibrary(gameId);
  sendMain('library-updated');
  return { ok: true };
});

// ── Extract + finalise ────────────────────────────────────────
// Shared by the aria2c path and the Electron built-in downloader.
//
// The archive is deliberately KEPT whenever extraction fails. A finished
// download that merely failed to unpack used to be marked "failed" with the zip
// deleted, throwing away tens of gigabytes of a perfectly good download and
// forcing a full re-download for what is usually a one-click fix (denied UAC
// prompt, antivirus lock, disk full). Now the entry lands in `extract-failed`
// with `zipPath` intact, so `retry-extract` can unpack it again for free. The
// archive is removed only once extraction actually succeeds — or when the user
// removes/uninstalls the game.
async function extractAndFinalize({ gameId, zipPath, installDir, title }) {
  const finishFailed = (statusMsg, state, extra = {}) => {
    store.upsertLibrary(gameId, {
      status: state === 'extract-failed' ? 'extract-failed' : 'failed',
      statusMsg, ...extra,
    });
    sendMain('download-done', { gameId, state, error: statusMsg });
    sendMain('library-updated');
    activeDownloads.delete(gameId);
  };

  // ── Is this even an archive? ──────────────────────────────
  // Catching a junk download here means the user is told to re-download rather
  // than being sent to chase an extraction problem that does not exist.
  const entry0  = store.getLibraryEntry(gameId) || {};
  const inspect = inspectArchive(zipPath, entry0.zipSize || 0);

  if (inspect.truncated) {
    // Genuine archive, just not all of it. Park it as paused so Resume picks up
    // where aria2c left off — deleting it here would repeat the whole download.
    const canResume = !!(entry0.fileUrl && entry0.filename);
    store.upsertLibrary(gameId, {
      status:    canResume ? 'paused' : 'failed',
      statusMsg: canResume
        ? `Download incomplete — ${inspect.reason} Resume to finish it.`
        : `Download incomplete — ${inspect.reason}`,
      paused: canResume,
    });
    sendMain('download-done', { gameId, state: 'failed', error: `Download incomplete — ${inspect.reason}` });
    sendMain('library-updated');
    activeDownloads.delete(gameId);
    return;
  }

  if (!inspect.ok) {
    try { fs.unlinkSync(zipPath); } catch {}
    try { fs.unlinkSync(zipPath + '.aria2'); } catch {}
    try { fs.rmSync(installDir, { recursive: true, force: true }); } catch {}
    finishFailed(`Download failed — ${inspect.reason}`, 'failed', { zipPath: null, installDir: null, canRetryExtract: false });
    return;
  }

  fs.mkdirSync(installDir, { recursive: true });

  // ── Warn about the UAC prompt before extracting ───────────
  const sevenZipPath = get7ZipPath();
  const settings0    = store.getSettings();
  const use7ZipCheck = settings0.sevenZipEnabled !== false && fs.existsSync(sevenZipPath);
  if (process.platform === 'win32' && use7ZipCheck) {
    const userConfirmed = await confirmUacWithRenderer(gameId);
    if (!userConfirmed) {
      // Keep the archive: the user only declined the elevation prompt, the
      // download itself is fine and can be extracted later.
      finishFailed(
        'Extraction cancelled — the download is still here, use Retry Extraction.',
        'extract-failed',
        { zipPath, canRetryExtract: true },
      );
      return;
    }
  }

  store.upsertLibrary(gameId, { status: 'extracting', statusMsg: 'Extracting…', percent: 100 });
  sendMain('library-updated');
  sendMain('extract-progress', { gameId, msg: 'Extracting files…' });

  const extractHeartbeat = setInterval(() => {
    sendMain('extract-progress', { gameId, msg: 'Extracting files…' });
  }, 3000);

  const MAX_EXTRACT_ATTEMPTS = 3;
  let extractErr = null;

  for (let attempt = 1; attempt <= MAX_EXTRACT_ATTEMPTS; attempt++) {
    // Clean the partial install dir before each attempt
    try { fs.rmSync(installDir, { recursive: true, force: true }); } catch {}
    fs.mkdirSync(installDir, { recursive: true });

    if (attempt > 1) {
      const diagMsg = `Extraction failed (attempt ${attempt - 1}), retrying… (${attempt}/${MAX_EXTRACT_ATTEMPTS})`;
      store.upsertLibrary(gameId, { statusMsg: diagMsg });
      sendMain('extract-progress', { gameId, msg: diagMsg });
      await new Promise(r => setTimeout(r, 1500));
    }

    try {
      // Alternate method on retry: attempt 2 forces the non-default tool
      const method = attempt === 2 ? (fs.existsSync(get7ZipPath()) ? 'fallback' : '7zip') : undefined;
      await extractArchive(zipPath, installDir, msg => {
        const label = attempt > 1 ? `[Retry ${attempt - 1}] ${msg}` : msg;
        sendMain('extract-progress', { gameId, msg: label });
      }, method);
      extractErr = null;
      break;
    } catch (err) {
      extractErr = err;
      console.error(`[extract] Attempt ${attempt}/${MAX_EXTRACT_ATTEMPTS} failed for ${gameId}:`, err.message);
    }
  }

  clearInterval(extractHeartbeat);

  if (extractErr) {
    // Only the half-unpacked install dir goes; the archive stays put.
    try { fs.rmSync(installDir, { recursive: true, force: true }); } catch {}
    finishFailed(
      `Extraction failed: ${extractErr.message}`,
      'extract-failed',
      { zipPath, installDir: null, canRetryExtract: true },
    );
    return;
  }

  const execPath      = findExecutable(installDir, title);
  const installedSize = dirSize(installDir);
  // Extraction succeeded — now the archive is safe to delete.
  try { fs.unlinkSync(zipPath); } catch {}
  try { fs.unlinkSync(zipPath + '.aria2'); } catch {}
  store.upsertLibrary(gameId, {
    status: 'installed', statusMsg: 'Installed', installDir, execPath,
    zipPath: null, canRetryExtract: false, installedSize,
  });
  sendMain('download-done', { gameId, state: 'completed', installDir, execPath });
  sendMain('library-updated');
  activeDownloads.delete(gameId);
}

// Recursive folder size, so Verify always has a baseline even when the zip size
// was never captured or the CDN link has since expired.
function dirSize(dir) {
  let total = 0;
  try {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) total += dirSize(full);
      else if (ent.isFile()) { try { total += fs.statSync(full).size; } catch {} }
    }
  } catch {}
  return total;
}

// Total bytes under the games folder.
//
// Walking the tree from Node means a stat() per file, which on a real library
// (137k files / 850 GB here) takes ~28 seconds. Letting `dir /s` do the same
// walk in one process takes ~3, because it reads sizes straight out of each
// directory entry instead of paying a syscall per file. Its output ends with
// a "Total Files Listed" summary, so the last "N File(s)  M bytes" line is the
// grand total — the earlier ones are per-directory subtotals and must not be
// added up, or the result comes out roughly double.
function measureInstallDir(dir) {
  return new Promise(resolve => {
    if (!dir || !fs.existsSync(dir)) return resolve(0);
    let out = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      const matches = out.match(/([\d]+) bytes/g);
      if (!matches || !matches.length) return resolve(0);
      // Second-to-last "bytes" figure is the file total; the very last is the
      // free-space line that dir prints after it.
      const fileLines = out.match(/^\s+[\d,]+ File\(s\)\s+([\d]+) bytes/gm);
      if (!fileLines || !fileLines.length) return resolve(0);
      const m = fileLines[fileLines.length - 1].match(/([\d]+) bytes/);
      resolve(m ? Number(m[1]) : 0);
    };
    try {
      const proc = cp.spawn('cmd.exe', ['/c', 'dir', '/s', '/-c', dir], { windowsHide: true });
      proc.stdout.on('data', d => { out += d.toString('latin1'); });
      proc.on('error', () => { done = true; resolve(0); });
      proc.on('close', finish);
      // Never let a stuck scan hang the pill forever.
      setTimeout(() => { try { proc.kill(); } catch {} finish(); }, 60000).unref?.();
    } catch { resolve(0); }
  });
}

let _librarySizeCache = { at: 0, bytes: 0 };
let _librarySizeInFlight = null;
ipcMain.handle('get-library-size', async (_e, opts) => {
  const force = !!(opts && opts.force);
  // Scanning is measured in seconds, so serve a recent result unless the user
  // explicitly asked to recalculate, and never run two scans at once.
  if (!force && Date.now() - _librarySizeCache.at < 5 * 60 * 1000) {
    return { bytes: _librarySizeCache.bytes, cached: true };
  }
  if (_librarySizeInFlight) return _librarySizeInFlight;

  _librarySizeInFlight = (async () => {
    try {
      const bytes = await measureInstallDir(getInstallDir());
      _librarySizeCache = { at: Date.now(), bytes };
      return { bytes, cached: false };
    } finally {
      _librarySizeInFlight = null;
    }
  })();
  return _librarySizeInFlight;
});

// ── UAC confirmation round-trip ───────────────────────────────
// Keyed by gameId: two downloads finishing at once used to cross their
// responses through a single global `ipcMain.once`, leaving one of them stuck
// on "Extracting…" forever. The 10-minute cap means a renderer that never
// answers (window closed, reloaded) fails the download instead of hanging it.
const pendingUacConfirms = new Map();

ipcMain.on('uac-confirm-response', (_e, { proceed, gameId } = {}) => {
  if (gameId && pendingUacConfirms.has(gameId)) {
    pendingUacConfirms.get(gameId)(!!proceed);
    return;
  }
  // Older renderers do not send a gameId — answer whichever request is
  // outstanding, which is correct in the common single-download case.
  const first = pendingUacConfirms.keys().next();
  if (!first.done) pendingUacConfirms.get(first.value)(!!proceed);
});

function confirmUacWithRenderer(gameId) {
  return new Promise(resolve => {
    let settled = false;
    const finish = val => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      pendingUacConfirms.delete(gameId);
      resolve(val);
    };
    const timer = setTimeout(() => finish(false), 10 * 60 * 1000);
    pendingUacConfirms.set(gameId, finish);
    sendMain('uac-confirm-needed', { gameId });
  });
}

// ── aria2c + extract pipeline ─────────────────────────────────
// Called once we have the real direct file URL.
async function runAria2AndExtract({ fileUrl, filename, refererUrl, cookies, gameId, title }) {
  const installBase = getInstallDir();
  const zipPath     = resolveArchivePath(filename);
  const archiveDir  = path.dirname(zipPath);

  // Store state so pause/resume/cancel can reference it
  const entry = activeDownloads.get(gameId) || {};
  entry.fileUrl    = fileUrl;
  entry.filename   = filename;
  entry.refererUrl = refererUrl;
  entry.cookies    = cookies;
  entry.title      = title;
  entry.zipPath    = zipPath;
  entry.status     = 'downloading';
  activeDownloads.set(gameId, entry);

  store.upsertLibrary(gameId, {
    status: 'downloading', statusMsg: '0%', zipPath, filename,
    fileUrl, refererUrl, paused: false, canRetryExtract: false,
  });
  sendMain('library-updated');

  try {
    await aria2Download({ fileUrl, destDir: archiveDir, filename, refererUrl, cookies, gameId, title });
  } catch (err) {
    if (err.message === 'cancelled') return; // user cancelled — already handled
    if (activeDownloads.get(gameId)?.paused) return; // user paused — don't mark failed

    store.upsertLibrary(gameId, { status: 'failed', statusMsg: err.message });
    sendMain('download-done', { gameId, state: 'failed' });
    sendMain('library-updated');
    activeDownloads.delete(gameId);
    return;
  }

  // Send a final pct:100 progress event so the renderer's hasActiveDownload guard
  // (which blocks library rebuilds while pct is 1–99) knows the download is done.
  // aria2c doesn't always emit a 100% line before exiting, so we send it explicitly.
  sendMain('download-progress', { gameId, pct: 100, speed: '', eta: '', msg: '100%  Download complete' });

  // Hand off to the shared extract pipeline (also used by the built-in
  // downloader) so both paths recover from a failed extraction identically.
  await extractAndFinalize({ gameId, zipPath, installDir: path.join(installBase, gameId), title });
}

// ── Start download ────────────────────────────────────────────
// Game-specific download URL overrides, matched by title (case-insensitive,
// substring). Works across all sources since the same game has different IDs
// on SteamRIP vs AnkerGames.
const DOWNLOAD_OVERRIDES = {
  'sr-minecraft-1d': 'https://files.catbox.moe/cy3kca.zip',
  'ag-minecraft':    'https://files.catbox.moe/cy3kca.zip',
};

ipcMain.handle('start-download', (_e, { uploadhavenUrl, downloadUrl, steamunlockedUrl, gameUrl, gameId, title, coverImage, source }) => {
  if (activeDownloads.has(gameId)) return { error: 'Already downloading' };

  if (DOWNLOAD_OVERRIDES[gameId]) {
    downloadUrl = DOWNLOAD_OVERRIDES[gameId];
    uploadhavenUrl = null;
    steamunlockedUrl = null;
  }

  const prevEntry = store.getLibraryEntry(gameId);

  // A previous run downloaded the whole archive and only failed to unpack it.
  // Re-downloading tens of gigabytes to fix an extraction problem is the single
  // worst thing this app used to do, so go straight back to extraction instead.
  if (prevEntry?.canRetryExtract && prevEntry.zipPath && fs.existsSync(prevEntry.zipPath)) {
    activeDownloads.set(gameId, { status: 'extracting', paused: false, zipPath: prevEntry.zipPath, title });
    store.upsertLibrary(gameId, { title, coverImage, status: 'extracting', statusMsg: 'Extracting…' });
    sendMain('library-updated');
    extractAndFinalize({
      gameId,
      zipPath: prevEntry.zipPath,
      installDir: path.join(getInstallDir(), gameId),
      title: title || prevEntry.title,
    });
    return { ok: true, reusedArchive: true };
  }

  // Otherwise wipe any leftover partial zip from a cancelled/failed download so
  // aria2c starts clean instead of resuming stale data.
  if (prevEntry?.zipPath) {
    try { fs.unlinkSync(prevEntry.zipPath); } catch {}
    try { fs.unlinkSync(prevEntry.zipPath + '.aria2'); } catch {}
  }

  const dlUrl      = downloadUrl || uploadhavenUrl;
  const refererUrl = gameUrl || steamunlockedUrl || '';

  const installBase = getInstallDir();
  fs.mkdirSync(installBase, { recursive: true });

  store.upsertLibrary(gameId, {
    title, coverImage, gameUrl: refererUrl,
    status: 'preparing', statusMsg: 'Starting…', addedAt: new Date().toISOString(),
  });
  sendMain('library-updated');

  // ── Phase 1: use a hidden window only to navigate JS-gated pages
  //            and intercept the real CDN file URL from will-download.
  //            Once we have it, destroy the window and hand off to aria2c.
  const partition = `persist:dl-${gameId}-${Date.now()}`;
  const dlSession = session.fromPartition(partition);

  const hiddenWin = new BrowserWindow({
    show: false,
    webPreferences: {
      session: dlSession,
      // Isolated from the remote page's JS world. The scripts we inject only
      // touch the DOM (querySelector / click / textContent), which works the
      // same from the isolated world — DOM events still reach the page's own
      // listeners, so htmx-driven download buttons behave identically.
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  hiddenWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  activeDownloads.set(gameId, { window: hiddenWin, status: 'preparing', paused: false });

  const upd = (statusMsg, status = 'preparing') => {
    store.upsertLibrary(gameId, { status, statusMsg });
    sendMain('download-status', { gameId, msg: statusMsg });
  };

  return new Promise(resolve => {
    let resolved = false;
    const done = r => { if (!resolved) { resolved = true; resolve(r); } };

    // ── Phase 1 complete: will-download fires with the real file URL ──
    dlSession.once('will-download', async (_dlEv, item) => {
      const fileUrl  = item.getURL();
      const filename = item.getFilename();
      const zipPath  = resolveArchivePath(filename);

      const settings     = store.getSettings();
      const useAria2     = !!settings.aria2Enabled;
      const aria2Exists  = useAria2 && fs.existsSync(getAria2Path());

      if (useAria2 && aria2Exists) {
        // ── aria2c path ───────────────────────────────────────
        // Cancel Electron's download, hand off to aria2c
        item.cancel();
        if (!hiddenWin.isDestroyed()) hiddenWin.destroy();

        // Collect session cookies for this URL (needed for Gofile etc.)
        let cookieHeader = '';
        try {
          const u       = new URL(fileUrl);
          const cookies = await dlSession.cookies.get({ domain: u.hostname });
          cookieHeader  = cookies.map(c => `${c.name}=${c.value}`).join('; ');
        } catch {}

        upd('Download starting (aria2)…', 'downloading');
        done({ ok: true });

        // Store fileUrl + zipSize so verify can HEAD it later
        const zipSize = item.getTotalBytes() || 0;
        store.upsertLibrary(gameId, { fileUrl, refererUrl, zipSize });

        runAria2AndExtract({ fileUrl, filename, refererUrl, cookies: cookieHeader || undefined, gameId, title });

      } else {
        // ── Electron built-in fallback ────────────────────────
        if (useAria2 && !aria2Exists) {
          upd('aria2c not found — using built-in downloader', 'downloading');
        }

        item.setSavePath(zipPath);
        const dlEntry = activeDownloads.get(gameId);
        if (dlEntry) { dlEntry.item = item; dlEntry.status = 'downloading'; dlEntry.zipPath = zipPath; }

        // Store fileUrl + zipSize so verify can HEAD it later
        const zipSize = item.getTotalBytes() || 0;
        store.upsertLibrary(gameId, { fileUrl, refererUrl, zipSize, status: 'downloading', statusMsg: '0%', zipPath, filename });
        sendMain('library-updated');

        let lastRecv = 0, lastTime = Date.now();

        item.on('updated', (_ev, state) => {
          if (state === 'interrupted') {
            if (item.canResume()) { item.resume(); return; }
            const recv  = item.getReceivedBytes();
            const total = item.getTotalBytes();
            const pct   = total > 0 ? Math.round((recv / total) * 100) : 0;
            const msg   = total > 0
              ? `Connection interrupted — retrying… (${pct}%  ${fmtBytes(recv)} / ${fmtBytes(total)})`
              : `Connection interrupted — retrying… (${fmtBytes(recv)} downloaded)`;
            persistProgress(gameId, { status: 'downloading', statusMsg: msg, receivedBytes: recv, totalBytes: total, percent: pct, speed: 0 });
            sendMain('download-progress', { gameId, recv, total, pct, state, msg, speed: 0 });
            return;
          }
          const recv  = item.getReceivedBytes();
          const total = item.getTotalBytes();
          const pct   = total > 0 ? Math.round((recv / total) * 100) : 0;
          const now   = Date.now();
          const dt    = (now - lastTime) / 1000;
          const speed = dt > 0 ? (recv - lastRecv) / dt : 0;
          lastRecv = recv; lastTime = now;
          const speedStr = speed > 0 ? ` • ${fmtBytes(speed)}/s` : '';
          const msg = total > 0
            ? `${pct}%  ${fmtBytes(recv)} / ${fmtBytes(total)}${speedStr}`
            : `${fmtBytes(recv)} downloaded${speedStr}`;
          persistProgress(gameId, { status: 'downloading', statusMsg: msg, receivedBytes: recv, totalBytes: total, percent: pct, speed });
          sendMain('download-progress', { gameId, recv, total, pct, state, msg, speed });
        });

        item.once('done', async (_ev, state) => {
          const ok = state === 'completed';
          if (!ok) {
            const reason = state === 'interrupted' ? 'Interrupted' : state === 'cancelled' ? 'Cancelled' : `Failed (${state})`;
            store.upsertLibrary(gameId, { status: 'failed', statusMsg: reason, zipPath: null });
            sendMain('download-done', { gameId, state });
            sendMain('library-updated');
            activeDownloads.delete(gameId);
            if (!hiddenWin.isDestroyed()) hiddenWin.destroy();
            return;
          }

          const installDir = path.join(installBase, gameId);
          // Same shared pipeline as the aria2c path: a failed extraction
          // keeps the archive so it can be retried without re-downloading.
          await extractAndFinalize({ gameId, zipPath, installDir, title });
          if (!hiddenWin.isDestroyed()) hiddenWin.destroy();
        });

        done({ ok: true, zipPath });
      }
    });

    // ── Navigate hidden window to trigger the download button chain ──
    // An overridden game has a known-good direct link, so none of the
    // per-host scraping below applies — go straight at the file. This has to
    // win over isAnkerGames, which keys off the referer rather than dlUrl and
    // would otherwise scrape the game page and ignore the override entirely.
    const isOverride    = !!DOWNLOAD_OVERRIDES[gameId];
    const isGofile      = !isOverride && (dlUrl ? dlUrl.includes('gofile.io') : false);
    const isAnkerGames  = !isOverride && refererUrl && refererUrl.includes('ankergames.net');
    const isBzzHR       = !isOverride && dlUrl && dlUrl.includes('bzzhr.to');
    const isFileDitch   = !isOverride && dlUrl && /fileditch|fileditchfiles/.test(dlUrl);
    const isMegaDB      = !isOverride && dlUrl && /megadb\.net\//.test(dlUrl);

    if (isOverride) {
      upd('Downloading…');
      hiddenWin.loadURL(dlUrl);
    } else if (isAnkerGames) {
      upd('Loading AnkerGames page…');
      hiddenWin.loadURL(refererUrl, { httpReferrer: 'https://ankergames.net/' });
    } else if (isGofile) {
      // Gofile is resolved entirely through api.gofile.io — no page scraping.
      upd('Resolving via Gofile API…');
      (async () => {
        try {
          const gofileIdM = dlUrl.match(/gofile\.io\/d\/([A-Za-z0-9]+)/);
          if (!gofileIdM) throw new Error('Could not parse Gofile content ID');
          const contentId = gofileIdM[1];

          upd('Getting Gofile token…');
          const crypto   = require('crypto');
          const GO_UA    = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
          const GO_LANG  = 'en-US';
          const tokenRes = await net.fetch('https://api.gofile.io/accounts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'User-Agent': GO_UA, Origin: 'https://gofile.io', Referer: 'https://gofile.io/' },
          });
          const tokenJson = await tokenRes.json();
          const token     = tokenJson?.data?.token;
          if (!token) throw new Error('Failed to get Gofile token');

          // X-Website-Token is a client-side signature (wt.obf.js → generateWT):
          //   sha256(UA + "::" + LANG + "::" + accountToken + "::" +
          //          floor(Date.now()/1000/14400) + "::9844d94d963d30")
          // Same inputs must be echoed as request headers (User-Agent, X-BL).
          const timeBucket = Math.floor(Date.now() / 1000 / 0x3840).toString();
          const websiteToken = crypto.createHash('sha256')
            .update(`${GO_UA}::${GO_LANG}::${token}::${timeBucket}::9844d94d963d30`)
            .digest('hex');

          upd('Fetching Gofile metadata…');
          const GO_BASE_HEADERS = {
            Authorization: `Bearer ${token}`,
            'X-Website-Token': websiteToken,
            'X-BL': GO_LANG,
            'User-Agent': GO_UA,
            Origin: 'https://gofile.io',
            Referer: 'https://gofile.io/',
            'Accept-Language': 'en-US,en;q=0.9',
          };
          const contentsUrl = `https://api.gofile.io/contents/${contentId}?page=1&pageSize=100&sortField=createTime&sortDirection=-1`;
          const metaRes  = await net.fetch(contentsUrl, { headers: GO_BASE_HEADERS });
          let metaJson   = await metaRes.json();
          if (metaJson?.status !== 'ok') throw new Error('Gofile error: ' + metaJson?.status);

          // Password-gated folders (most SteamRIP releases): retry with the
          // sha256 of the release password once if the first response says so.
          if (metaJson?.data && metaJson.data.canAccess === false) {
            upd('Gofile folder is password-protected, unlocking…');
            const password = crypto.createHash('sha256').update('steamrip').digest('hex');
            const retryRes  = await net.fetch(`${contentsUrl}&password=${password}`, { headers: GO_BASE_HEADERS });
            metaJson        = await retryRes.json();
            if (metaJson?.status !== 'ok' || metaJson?.data?.canAccess === false) {
              throw new Error('Gofile password rejected or content unavailable');
            }
          }

          const children  = metaJson?.data?.children || {};
          const fileEntry = Object.values(children).find(c => c.type === 'file');
          if (!fileEntry) throw new Error('No files found in Gofile folder');

          const settings     = store.getSettings();
          const useAria2     = !!settings.aria2Enabled;
          const aria2Exists  = useAria2 && fs.existsSync(getAria2Path());

          if (useAria2 && aria2Exists) {
            // Direct hand-off to aria2c — no hidden window involved.
            upd(`Starting download: ${fileEntry.name} (aria2)`, 'downloading');
            if (!hiddenWin.isDestroyed()) hiddenWin.destroy();
            store.upsertLibrary(gameId, { fileUrl: fileEntry.link, refererUrl: 'https://gofile.io/' });
            done({ ok: true });
            // The direct-link host is a store*.gofile.io subdomain and requires the
            // accountToken cookie (scope the cookie to gofile.io so it applies).
            await dlSession.cookies.set({ url: 'https://gofile.io', domain: 'gofile.io', name: 'accountToken', value: token });
            runAria2AndExtract({ fileUrl: fileEntry.link, filename: fileEntry.name, refererUrl: 'https://gofile.io/', cookies: `accountToken=${token}`, gameId, title });
          } else {
            // Built-in downloader: start the direct file URL on the session.
            upd(`Starting download: ${fileEntry.name}`, 'downloading');
            await dlSession.cookies.set({ url: 'https://gofile.io', domain: 'gofile.io', name: 'accountToken', value: token });
            dlSession.downloadURL(fileEntry.link);
          }
        } catch (err) {
          store.upsertLibrary(gameId, { status: 'failed', statusMsg: 'Gofile error: ' + err.message });
          sendMain('download-done', { gameId, state: 'failed', error: err.message });
          sendMain('library-updated');
          activeDownloads.delete(gameId);
          if (!hiddenWin.isDestroyed()) hiddenWin.destroy();
          done({ error: err.message });
        }
      })();
    } else if (dlUrl && dlUrl.includes('bzzhr.to')) {
      // BuzzHeavier: load in the real Chromium window (passes Cloudflare),
      // then click the download button. The resulting file download is caught
      // by the existing dlSession 'will-download' handler above.
      upd('Loading BuzzHeavier page…');
      hiddenWin.loadURL(dlUrl, { httpReferrer: refererUrl || 'https://steamrip.com/' });
      hiddenWin.webContents.once('did-finish-load', async () => {
        try {
          await sleep(1500); // let htmx/JS settle
          upd('Clicking BuzzHeavier download button…');
          const clicked = await hiddenWin.webContents.executeJavaScript(`
            (function() {
              var btn = document.querySelector('.download-btn[hx-get]');
              if (!btn) btn = document.querySelector('[hx-get*="/download"]');
              if (!btn) btn = document.querySelector('a[href*="/download"]');
              if (!btn) return 'not-found';
              btn.click();
              return 'clicked';
            })()
          `);
          if (clicked !== 'clicked') throw new Error('Could not find download button on BzzHR page');
          // will-download fires automatically when the click triggers a file download
        } catch (err) {
          store.upsertLibrary(gameId, { status: 'failed', statusMsg: 'BzzHR error: ' + err.message });
          sendMain('download-done', { gameId, state: 'failed', error: err.message });
          sendMain('library-updated');
          activeDownloads.delete(gameId);
          if (!hiddenWin.isDestroyed()) hiddenWin.destroy();
          done({ error: err.message });
        }
      });
    } else if (isFileDitch) {
      // FileDitch: the SteamRIP link is usually fileditchfiles.me/file.php?f=...
      // which redirects to the actual fileditchfiles.st download page.
      // We wait for the final page to load (after redirects), then click
      // the "⬇ Download" button (a.btn-main[download]) from FileDitch's own UI.
      upd('Loading FileDitch page…');
      hiddenWin.loadURL(dlUrl, { httpReferrer: refererUrl || 'https://steamrip.com/' });

      let fdSettled = false;
      const fdOnLoad = async () => {
        if (fdSettled) return;
        try {
          // Give any JS on the FileDitch page a moment to run
          await sleep(1200);
          const currentUrl = hiddenWin.webContents.getURL();
          // If still on the redirect stub, wait for next load
          if (/file\.php/i.test(currentUrl) && !/fileditchfiles\.(st|me)\/alpha/i.test(currentUrl)) {
            hiddenWin.webContents.once('did-finish-load', fdOnLoad);
            return;
          }
          fdSettled = true;
          upd('Clicking FileDitch download button…');
          const result = await hiddenWin.webContents.executeJavaScript(`
            (function() {
              // FileDitch page has <a class="btn btn-main" download href="...">⬇ Download</a>
              var btn = document.querySelector('a.btn-main[download]');
              if (!btn) btn = document.querySelector('a[download][href]');
              if (!btn) {
                // Fallback: find any anchor whose text contains 'Download'
                btn = Array.from(document.querySelectorAll('a[href]'))
                  .find(a => /download/i.test(a.textContent));
              }
              if (btn) {
                // If it's a direct file link, navigate to it so will-download fires
                var href = btn.getAttribute('href') || '';
                if (href && !href.startsWith('#')) {
                  btn.click();
                  return 'clicked:' + href;
                }
              }
              return 'not-found';
            })()
          `);
          if (typeof result === 'string' && result.startsWith('not-found')) {
            throw new Error('Could not find download button on FileDitch page');
          }
          // will-download fires automatically when the click triggers a file download
        } catch (err) {
          if (fdSettled) return; // already errored
          fdSettled = true;
          store.upsertLibrary(gameId, { status: 'failed', statusMsg: 'FileDitch error: ' + err.message });
          sendMain('download-done', { gameId, state: 'failed', error: err.message });
          sendMain('library-updated');
          activeDownloads.delete(gameId);
          if (!hiddenWin.isDestroyed()) hiddenWin.destroy();
          done({ error: err.message });
        }
      };
      hiddenWin.webContents.once('did-finish-load', fdOnLoad);
    } else if (isMegaDB) {
      // MegaDB (megadb.net): the SteamRIP button links to a file page that
      // requires a Referer from an approved domain. The page runs a ~10s
      // countdown, then "DOWNLOAD NOW" navigates to a ?pt= ticket URL — which
      // (in a real browser, with the right cookie/referer state) serves the
      // actual file as a download. will-download below catches it.
      upd('Loading MegaDB page…');
      const megaRef = refererUrl && /steamrip\.com|steamunlocked\.org|ankergames\.net/.test(refererUrl)
        ? refererUrl
        : 'https://steamrip.com/';
      hiddenWin.loadURL(dlUrl, { httpReferrer: megaRef });

      const megaFail = err => {
        if (hiddenWin.isDestroyed()) return;
        store.upsertLibrary(gameId, { status: 'failed', statusMsg: 'MegaDB error: ' + err.message });
        sendMain('download-done', { gameId, state: 'failed', error: err.message });
        sendMain('library-updated');
        activeDownloads.delete(gameId);
        if (!hiddenWin.isDestroyed()) hiddenWin.destroy();
        done({ error: err.message });
      };

      let megaHops = 0;
      const driveMegaDB = async () => {
        if (!activeDownloads.has(gameId)) return;
        if (++megaHops > 8) throw new Error('MegaDB kept bouncing between pages, giving up');
        await sleep(1500);
        const freeRes = await hiddenWin.webContents.executeJavaScript(`
          (function() {
            const btn = document.querySelector('.btn-free-element .download-btn');
            if (!btn) return 'no-free-btn';
            btn.click();
            return 'clicked';
          })()
        `);
        if (freeRes !== 'clicked') throw new Error(`Could not find MegaDB download button (${freeRes})`);

        let clicked = false;
        for (let i = 0; i < 30; i++) {
          if (!activeDownloads.has(gameId)) return;
          const res = await hiddenWin.webContents.executeJavaScript(`
            (function() {
              const btn = document.querySelector('.download-timer .download-btn');
              if (!btn || !/DOWNLOAD NOW/i.test(btn.textContent || '')) return 'waiting';
              btn.click();
              return 'clicked';
            })()
          `);
          if (res === 'clicked') { clicked = true; break; }
          await sleep(1000);
        }
        if (!clicked) throw new Error('MegaDB download link never appeared');

        // If a token hop lands on yet another MegaDB page (multi-hop chain),
        // drive it again; will-download fires when the page returns the file.
        hiddenWin.webContents.once('did-finish-load', () => {
          if (!activeDownloads.has(gameId)) return;
          if (/megadb\.net\//.test(hiddenWin.webContents.getURL()) && megaHops < 8) {
            driveMegaDB().catch(megaFail);
          }
        });
      };

      hiddenWin.webContents.once('did-finish-load', () => {
        driveMegaDB().catch(megaFail);
      });
    } else {
      hiddenWin.loadURL(dlUrl, { httpReferrer: refererUrl });
    }

    hiddenWin.webContents.once('did-finish-load', async () => {
      if (isOverride) return; // direct file link — will-download does the work
      if (isBzzHR) return; // BzzHR has its own did-finish-load handler
      if (isFileDitch) return; // FileDitch has its own did-finish-load handler
      if (isMegaDB) return; // MegaDB has its own did-finish-load handler
      if (isAnkerGames) {
        upd('Opening download modal…');
        await sleep(2500);
        for (let attempt = 0; attempt < 15; attempt++) {
          if (!activeDownloads.has(gameId)) return;
          try {
            const res = await hiddenWin.webContents.executeJavaScript(`
              (function() {
                var btn = Array.from(document.querySelectorAll('button')).find(b => {
                  var attr = b.getAttribute('@click') || '';
                  return attr.includes('open-download-modal');
                });
                if (!btn) {
                  btn = Array.from(document.querySelectorAll('button')).find(b =>
                    b.querySelector('span') && b.querySelector('span').textContent.trim() === 'Download'
                  );
                }
                if (!btn) return 'no-modal-btn:' + document.querySelectorAll('button').length;
                btn.click();
                return 'modal-clicked';
              })()
            `);
            if (res === 'modal-clicked') break;
            upd(`Waiting for modal button… (${attempt + 1}) [${res}]`);
          } catch (e) { upd(`JS error step1: ${e.message}`); }
          await sleep(1000);
        }

        await sleep(2000);
        upd('Clicking download in modal…');
        for (let attempt = 0; attempt < 20; attempt++) {
          if (!activeDownloads.has(gameId)) return;
          try {
            const res = await hiddenWin.webContents.executeJavaScript(`
              (function() {
                var btn = Array.from(document.querySelectorAll('a')).find(a => {
                  var attr = a.getAttribute('@click.prevent') || a.getAttribute('@click') || '';
                  return attr.includes('generateDownloadUrl');
                });
                if (!btn) btn = document.querySelector('a.download-button');
                if (!btn) return 'no-dl-btn:' + document.querySelectorAll('a').length;
                btn.click();
                return 'dl-clicked';
              })()
            `);
            if (res === 'dl-clicked') { upd('Waiting for download URL…', 'preparing'); break; }
            upd(`Waiting for download button… (${attempt + 1}) [${res}]`);
          } catch (e) { upd(`JS error step2: ${e.message}`); }
          await sleep(1200);
        }
      } else if (isGofile) {
        return; // already handled above
      } else {
        // SteamUnlocked / UploadHaven — wait for countdown, then click
        await hiddenWin.webContents.executeJavaScript(`
          window.open = function() { return null; };
          window.addEventListener('beforeunload', function(){});
        `);

        for (let i = 16; i > 0; i--) {
          if (!activeDownloads.has(gameId)) return;
          upd(`Waiting for timer… ${i}s`);
          await sleep(1000);
        }

        const clickScript = `
          (function() {
            window.open = function() { return null; };
            var btn =
              document.getElementById('downloadbtn') ||
              document.getElementById('submitFree') ||
              document.querySelector('a#downloadbtn') ||
              document.querySelector('form[method="post"] a') ||
              document.querySelector('a.download-btn') ||
              document.querySelector('a[class*="download-btn"]') ||
              document.querySelector('a[class*="btn-download"]') ||
              document.querySelector('button[type="submit"]') ||
              document.querySelector('input[type="submit"]') ||
              Array.from(document.querySelectorAll('a, button')).find(el => {
                var t = el.textContent.trim().toLowerCase();
                return t === 'free download' || t === 'download now' || t === 'slow download';
              });
            if (!btn) return 'no-button';
            if (btn.disabled) return 'disabled';
            btn.removeAttribute('target');
            btn.click();
            return 'clicked';
          })()
        `;

        let clicked = false;
        for (let attempt = 0; attempt < 20; attempt++) {
          if (!activeDownloads.has(gameId)) return;
          upd(`Clicking Free Download… (attempt ${attempt + 1})`);
          try {
            const res = await hiddenWin.webContents.executeJavaScript(clickScript);
            if (res === 'clicked') { clicked = true; upd('Waiting for download URL…', 'preparing'); break; }
            upd(`Button: ${res}, retrying…`);
          } catch {}
          await sleep(800);
        }

        if (clicked) {
          hiddenWin.webContents.once('did-finish-load', async () => {
            if (!activeDownloads.has(gameId)) return;
            await sleep(1500);
            try { await hiddenWin.webContents.executeJavaScript(clickScript); } catch {}
          });
        }
      }

      // Safety timeout — if will-download never fires, give up
      await sleep(90_000);
      if (activeDownloads.has(gameId) && !activeDownloads.get(gameId).fileUrl) {
        store.upsertLibrary(gameId, { status: 'failed', statusMsg: 'Timed out waiting for download URL' });
        sendMain('download-done', { gameId, state: 'failed' });
        sendMain('library-updated');
        activeDownloads.delete(gameId);
        if (!hiddenWin.isDestroyed()) hiddenWin.destroy();
        done({ error: 'Timed out' });
      }
    });

    hiddenWin.webContents.on('did-fail-load', (_e2, errorCode, desc, _validatedUrl, isMainFrame) => {
      // Ignore subframe/resource failures (ads, tracking pixels, CDN assets, etc.)
      if (!isMainFrame) return;
      // ERR_ABORTED (-3) fires normally when a download starts intercepting the navigation
      if (errorCode === -3) return;
      // If will-download already fired and we have the file URL, hidden window is done — ignore
      if (!activeDownloads.has(gameId)) return;
      if (activeDownloads.get(gameId).fileUrl) return;
      store.upsertLibrary(gameId, { status: 'failed', statusMsg: desc });
      sendMain('download-done', { gameId, state: 'failed' });
      sendMain('library-updated');
      activeDownloads.delete(gameId);
      done({ error: desc });
    });
  });
});

// ── DevTools Panel ─────────────────────────────────────────────
// Ctrl+Shift+D  →  toggle devtools overlay in the renderer
// IPC: check-aria2, get-devtools-info, capture-scraper-preview,
//      open-devtools (open Electron's own DevTools for debugging)

ipcMain.handle('check-aria2', () => {
  const aria2Path = getAria2Path();
  const exists    = fs.existsSync(aria2Path);
  const settings  = store.getSettings();
  return {
    exists,
    enabled: !!settings.aria2Enabled,
    path: aria2Path,
  };
});

ipcMain.handle('get-devtools-info', () => {
  const aria2Path   = getAria2Path();
  const aria2Exists = fs.existsSync(aria2Path);
  const settings    = store.getSettings();

  const sevenZipPath   = get7ZipPath();
  const sevenZipExists = fs.existsSync(sevenZipPath);

  // Collect info about active downloads / hidden scraper windows
  const downloads = [];
  for (const [gameId, entry] of activeDownloads.entries()) {
    let scraperUrl = null;
    try {
      if (entry.window && !entry.window.isDestroyed()) {
        scraperUrl = entry.window.webContents.getURL();
      }
    } catch {}
    downloads.push({
      gameId,
      status:    entry.status  || 'unknown',
      paused:    !!entry.paused,
      scraperUrl,
    });
  }

  return {
    aria2: {
      exists:  aria2Exists,
      enabled: !!settings.aria2Enabled,
      path:    aria2Path,
    },
    sevenZip: {
      exists:  sevenZipExists,
      enabled: settings.sevenZipEnabled !== false,
      path:    sevenZipPath,
    },
    activeDownloads: downloads,
    settings: {
      source:      settings.source      || 'ankergames',
      installPath: settings.installPath || '(default)',
    },
    platform: process.platform,
    electron: process.versions.electron,
    node:     process.versions.node,
  };
});

ipcMain.handle('capture-scraper-preview', async (_e, gameId) => {
  try {
    const entry = gameId
      ? activeDownloads.get(gameId)
      : [...activeDownloads.values()].find(e => e.window && !e.window.isDestroyed());

    if (!entry || !entry.window || entry.window.isDestroyed()) {
      return { error: 'No active scraper window found' };
    }

    const wc  = entry.window.webContents;
    const url = wc.getURL();

    // Capture a screenshot of the hidden scraper window as base64 PNG
    const img = await wc.capturePage();
    const b64 = img.toJPEG(70).toString('base64');

    return { ok: true, url, snapshot: `data:image/jpeg;base64,${b64}` };
  } catch (err) {
    return { error: err.message };
  }
});



ipcMain.on('open-devtools', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
});


ipcMain.handle('clear-cache-and-restart', async () => {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      await mainWindow.webContents.session.clearCache();
      await mainWindow.webContents.session.clearStorageData({
        storages: ['cookies', 'localstorage', 'sessionstorage', 'shadercache', 'websql', 'serviceworkers', 'cachestorage']
      });
    }
    app.relaunch();
    app.exit(0);
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
});

// ── Multiplayer Mods ────────────────────────────────────────
function getMultiplayerModsFile() {
  return path.join(__dirname, 'multiplayermod.json');
}

function loadMultiplayerModDefs() {
  try {
    const raw = fs.readFileSync(getMultiplayerModsFile(), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.mods) ? parsed.mods : [];
  } catch (err) {
    console.warn('[multiplayer] failed to load multiplayermod.json:', err.message);
    return [];
  }
}

function normTitle(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function findMatchedLibraryGame(modGameTitle) {
  const library = store.getLibrary();
  const g = normTitle(modGameTitle);
  if (!g) return null;
  // 1) Exact normalized match wins outright.
  let match = library.find(e => normTitle(e.title || e.id) === g);
  if (match) return match;

  // 2) Otherwise gather substring candidates (either direction), then pick
  //    the one whose normalized title length is closest to the mod's target
  //    title. This avoids picking the wrong edition when one title is a
  //    literal substring of another, e.g. "Modern Warfare 2" vs
  //    "Modern Warfare 2 Campaign Remastered" — without this, array order
  //    alone would decide which game gets matched.
  const candidates = library
    .map(e => ({ entry: e, t: normTitle(e.title || e.id) }))
    .filter(c => c.t && (c.t.includes(g) || g.includes(c.t)));
  if (!candidates.length) return null;

  candidates.sort((a, b) => Math.abs(a.t.length - g.length) - Math.abs(b.t.length - g.length));
  return candidates[0].entry;
}

// Recursively find the best-matching exe within a directory for a standalone mod.
// Prefers filenames containing one of the mod's exeHints; falls back to any exe.
function findModExe(dir, exeHints) {
  const hints = (exeHints || []).map(h => h.toLowerCase());
  let best = null, bestScore = -1;

  function scan(d, depth) {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isFile() && e.name.toLowerCase().endsWith('.exe')) {
        const lower = e.name.toLowerCase();
        let score = 0;
        const hintMatch = hints.some(h => lower.includes(h));
        if (lower.includes('unins')) score = -1;
        else if (hintMatch) score = 3;
        // Bundled prerequisite/redist installers (DXSETUP.exe, vcredist_*.exe,
        // dotNetFx*.exe, etc.) often sit right next to the real game exe and
        // their names can contain "setup", which used to collide with the
        // generic launcher-ish fallback below and get mistaken for the mod's
        // own launcher/installer. Exclude them explicitly unless they were
        // actually one of the mod's own hints (handled above).
        else if (!hintMatch && (lower.includes('redist') || lower.includes('dxsetup') || lower.includes('vcredist') || lower.includes('dotnetfx'))) score = -1;
        else if (lower.includes('launcher') || lower.includes('setup')) score = 2;
        else score = 1;
        if (score > bestScore) { bestScore = score; best = full; }
      } else if (e.isDirectory() && depth > 0 && !e.name.toLowerCase().includes('redist')) {
        scan(full, depth - 1);
      }
    }
  }
  scan(dir, 4);
  return best;
}

// Strict version of findModExe — returns the first .exe nested under dir whose
// name matches one of the hints, and never falls back to an unrelated .exe.
// A mod like CoD2x expects CoD2MP_s.exe; without this, findModExe would
// silently match the single-player CoD2SP_s.exe and install in the wrong spot.
function findHintExe(dir, hints) {
  const hs = (hints || []).map(h => h.toLowerCase());
  if (!hs.length) return null;
  let best = null;
  function scan(d) {
    if (best) return;
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (best) return;
      const full = path.join(d, e.name);
      if (e.isFile() && e.name.toLowerCase().endsWith('.exe')) {
        const lower = e.name.toLowerCase();
        if (hs.some(h => lower.includes(h))) { best = full; return; }
      } else if (e.isDirectory() && !e.name.toLowerCase().includes('redist')) {
        scan(full);
      }
    }
  }
  scan(dir);
  return best;
}

// Some library entries point at a wrapper/parent folder (e.g. an installer's
// top-level dir) rather than the actual game folder, which can be nested one
// or more levels deeper — e.g.:
//   ag-call-of-duty-modern-warfare-remastered-2017/
//     └── Call of Duty - Modern Warfare Remastered/
//           └── iw4sp.exe
// If we blindly install into installDir, mod files land next to the wrapper
// instead of next to the actual game exe. To fix this, scan installDir
// (recursively) for one of the mod's gameExeHints and, if found, treat the
// exe's containing folder as the real game directory. Falls back to the
// original installDir if no matching executable is found anywhere below it.
function resolveGameDir(installDir, gameExeHints) {
  const hints = (gameExeHints || []).map(h => h.toLowerCase());
  if (!hints.length) return installDir;

  let found = null;
  function scan(d, depth) {
    if (found) return;
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (found) return;
      const full = path.join(d, e.name);
      if (e.isFile() && e.name.toLowerCase().endsWith('.exe')) {
        const lower = e.name.toLowerCase();
        if (hints.some(h => lower.includes(h))) { found = full; return; }
      } else if (e.isDirectory() && depth > 0) {
        scan(full, depth - 1);
      }
    }
  }
  scan(installDir, 6);
  return found ? path.dirname(found) : installDir;
}

// ── "Existing" mod detection (installType: 'existing') ───────
// Mods like RageCoop / GTA Connected have no automated install flow in
// NinoGames — the user sets them up manually, and we just DETECT them so the
// card lights up as ready. Looks inside the matched game folder (plus any
// declared external dirs, e.g. GTA Connected's AppData client) for the mod's
// marker files and/or its executable.

function expandEnvPath(p) {
  if (typeof p !== 'string') return p;
  return p.replace(/%([^%]+)%/g, (m, name) => process.env[name] ?? m);
}

// Case-insensitive recursive scan for any file OR dir whose name matches a key.
function scanForName(dir, keys, depth) {
  const ks = (keys || []).map(k => k.toLowerCase());
  if (!ks.length) return false;
  let hit = false;
  function scan(d, dep) {
    if (hit) return;
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (hit) return;
      const lower = e.name.toLowerCase();
      if (ks.some(k => lower.includes(k))) { hit = true; return; }
      if (e.isDirectory() && dep > 1 && !lower.includes('redist')) scan(path.join(d, e.name), dep - 1);
    }
  }
  scan(dir, depth > 0 ? depth : 8);
  return hit;
}

// Returns { gameDir, exePath } when the mod's files are found on disk, else null.
function detectExistingMod(mod, matched) {
  const dirs = [];
  if (matched && matched.status === 'installed' && matched.installDir) {
    dirs.push(resolveGameDir(matched.installDir, mod.gameExeHints));
  }
  for (const d of (mod.externalDirs || [])) {
    const expanded = expandEnvPath(d);
    if (expanded) dirs.push(expanded);
  }

  for (const d of dirs) {
    if (!d || !fs.existsSync(d)) continue;
    // A detectKey can match a file/dir *inside* d, or the directory itself
    // being named after the mod (e.g. GTA Connected's AppData folder).
    const ownMatch = (mod.detectKeys || []).some(k => path.basename(d).toLowerCase().includes(k.toLowerCase()));
    const markerHit = mod.detectKeys ? (ownMatch || scanForName(d, mod.detectKeys, 8)) : true;
    if (!markerHit) continue;

    // RageCoop-style mods are launched through the base game exe; others (e.g.
    // GTA Connected's Launcher.exe) launch through a mod-provided executable.
    const exePath = mod.launchGameExe
      ? findHintExe(d, mod.gameExeHints) || findModExe(d, mod.exeHints)
      : findModExe(d, mod.exeHints) || findHintExe(d, mod.gameExeHints);

    // Never report a mod as detected unless we actually found a launchable
    // executable. A directory can pass the marker check (e.g. a leftover/empty
    // "Jack's Mini Network\Grand Theft Auto Connected" folder) while still not
    // containing the client — without this, gtac would show "Mod installed"
    // even though there's nothing to launch.
    if (!exePath || !fs.existsSync(exePath)) continue;

    return { gameDir: d, exePath };
  }
  return null;
}

// Recursively copy every file/dir from src into dest, overwriting existing files.
// Overwrites are force — the destination's read-only flag is cleared first so
// patching over stock game files (which are frequently marked read-only) can't
// fail with EPERM mid-copy.
function copyDirMerge(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const e of entries) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) {
      copyDirMerge(s, d);
    } else if (e.isFile()) {
      try {
        if (fs.existsSync(d)) fs.chmodSync(d, 0o666); // clear read-only so the overwrite can succeed
        fs.copyFileSync(s, d);
      } catch { /* ignore per-file copy errors */ }
    }
  }
}

// Copy every FILE under src straight into dest's root, ignoring the folder
// structure. Some small mod/patch zips are single files wrapped in a folder
// (e.g. binkw32.zip -> "binkw32.dll (32-Bit)/binkw32.dll") — callers want the
// inner files flattened next to the game exe, not nested under a new folder.
// Returns the number of files copied.
function flattenExtractInto(srcDir, destDir) {
  let copied = 0;
  function walk(d) {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        walk(full);
      } else if (e.isFile()) {
        const dest = path.join(destDir, e.name);
        try {
          if (fs.existsSync(dest)) fs.chmodSync(dest, 0o666); // clear read-only so the overwrite succeeds
          fs.copyFileSync(full, dest);
          copied++;
        } catch { /* ignore */ }
      }
    }
  }
  walk(srcDir);
  return copied;
}

// Simple direct-file download (no JS-gated page scraping needed — mod zips are
// static GitHub release assets), using Electron's net module with redirect support.
function downloadFileSimple(url, destPath, onProgress, extraHeaders) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    const file = fs.createWriteStream(destPath);

    const tryDownload = (attemptUrl) => {
      const req = net.request({ url: attemptUrl, method: 'GET', redirect: 'follow' });
      req.setHeader('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
      req.setHeader('Referer', 'https://cbservers.xyz/');
      req.setHeader('Origin', 'https://cbservers.xyz');
      if (extraHeaders) for (const [k, v] of Object.entries(extraHeaders)) req.setHeader(k, v);
      req.on('response', res => {
        if (res.statusCode >= 400) {
          file.close();
          const err = new Error(`Download failed: HTTP ${res.statusCode} for ${path.basename(destPath)}`);
          err.statusCode = res.statusCode;
          return reject(err);
        }
        const total = parseInt(res.headers['content-length'] || '0', 10);
        const contentType = (res.headers['content-type'] || '').toLowerCase();
        // If the server returned HTML/JSON with a 200, it's an error page (CDN block).
        // Sniff the first chunk before writing anything to disk.
        let headerChecked = false;
        let recv = 0;
        let blocked = false;
        res.on('data', chunk => {
          if (!headerChecked) {
            headerChecked = true;
            const sniff = chunk.slice(0, 5).toString('utf8');
            if (contentType.includes('text/html') || sniff === '<html' || sniff === '<!DOC') {
              blocked = true;
              file.close();
              // Read the rest of the body for the error message
              let errBody = chunk.toString('utf8');
              res.on('data', c => { errBody += c.toString('utf8'); });
              res.on('end', () => reject(new Error(`CDN blocked request for ${path.basename(destPath)} — server returned HTML: ${errBody.slice(0, 200)}`)));
              return;
            }
          }
          if (blocked) return;
          recv += chunk.length;
          file.write(chunk);
          if (onProgress) onProgress(recv, total);
        });
        res.on('end', () => {
          if (blocked) return;
          file.end(() => {
            // Don't compare recv vs Content-Length — the CDN may gzip the
            // response, so Electron decompresses it and recv ends up larger
            // than the declared Content-Length. Just reject if nothing arrived.
            if (recv === 0) {
              reject(new Error(`Download returned empty body for ${path.basename(destPath)}.`));
              return;
            }
            resolve();
          });
        });
        res.on('error', err => { file.close(); reject(err); });
      });
      req.on('error', err => { file.close(); reject(err); });
      req.end();
    };

    tryDownload(url);
  });
}

ipcMain.handle('get-multiplayer-mods', () => {
  const defs = loadMultiplayerModDefs();
  return defs.map(mod => {
    const matched = findMatchedLibraryGame(mod.gameTitle);
    const installState = store.getMultiplayerMod(mod.id);
    // installType 'existing' mods have no install flow — derive "installed"
    // from the filesystem each time so they light up as soon as they're present.
    // gta-connected also keeps its detection live so the card stays accurate
    // if the client is moved/reinstalled outside NinoGames.
    let detected = null;
    if (mod.installType === 'existing' || mod.installType === 'gta-connected') detected = detectExistingMod(mod, matched);
    // A stored install only counts while its recorded exe still exists —
    // otherwise stale state would keep a card green forever (e.g. gtac's
    // install entry surviving a client removal).
    const storedOk = !!(installState && installState.installed && installState.exePath && fs.existsSync(installState.exePath));
    return {
      ...mod,
      matchedGame: matched ? {
        id: matched.id, title: matched.title, coverImage: matched.coverImage,
        installDir: matched.installDir, status: matched.status, execPath: matched.execPath,
      } : null,
      installed: storedOk || !!detected,
      modExePath: (storedOk && installState.exePath) || (detected && detected.exePath) || null,
    };
  });
});

ipcMain.handle('install-multiplayer-mod', async (event, modId) => {
  const defs = loadMultiplayerModDefs();
  const mod = defs.find(m => m.id === modId);
  if (!mod) return { error: 'Unknown mod.' };

  if (mod.installType === 'existing') {
    return { error: `${mod.name} is installed manually — NinoGames doesn't download it. Set it up yourself and this card will detect it automatically.` };
  }

  const matched = findMatchedLibraryGame(mod.gameTitle);
  if (!matched || matched.status !== 'installed' || !matched.installDir) {
    return { error: `${mod.gameTitle} isn't installed in your library yet.` };
  }

  const sendProgress = (phase, extra) => sendMain('mp-mod-progress', { modId, phase, ...extra });
  // Only place mod files next to the actual game executable — if
  // installDir turns out to be a wrapper folder, drill down until the
  // exe named in mod.gameExeHints (e.g. "iw4sp", "iw4mp") is found.
  const gameDir = resolveGameDir(matched.installDir, mod.gameExeHints);
  if (mod.gameExeHints && mod.gameExeHints.length && gameDir === matched.installDir) {
    const stillMissing = !findHintExe(matched.installDir, mod.gameExeHints);
    if (stillMissing) {
      return { error: `Could not find ${mod.gameExeHints.join('/')} under ${mod.gameTitle}'s install folder — the mod was not placed to avoid installing in the wrong location.` };
    }
  }

  try {
    if (mod.installType === 'launcher') {
      // e.g. IW4x — download a launcher ZIP, extract it straight into the
      // game directory, then run the launcher once so it can install itself.
      if (!mod.launcherUrl) throw new Error('No launcher URL configured for this mod.');

      const tempRoot = path.join(app.getPath('temp'), `ninogames-mp-${modId}-${Date.now()}`);
      const zipPath  = path.join(tempRoot, 'launcher.zip');

      sendProgress('downloading', { pct: 0 });
      let lastPct = -1;
      await downloadFileSimple(mod.launcherUrl, zipPath, (recv, total) => {
        const pct = total > 0 ? Math.round((recv / total) * 100) : 0;
        if (pct !== lastPct) { lastPct = pct; sendProgress('downloading', { pct, recv, total }); }
      });

      sendProgress('extracting', { pct: 100, msg: 'Extracting into game directory…' });
      await extractArchive(zipPath, gameDir, msg => sendProgress('extracting', { msg }));
      try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}

      // Find and run the launcher exe so it can finish installing the mod.
      // Prefer an exe whose name actually contains "launcher" (e.g.
      // iw4x-launcher.exe) over other extracted exes that also match
      // exeHints (e.g. IW4x.exe, the end-product the launcher produces) —
      // otherwise findModExe could pick either one, since both score
      // equally against exeHints.
      const launcherExe =
        findModExe(gameDir, mod.launcherExeHints || ['launcher']) ||
        findModExe(gameDir, mod.exeHints);
      if (!launcherExe || !fs.existsSync(launcherExe)) {
        throw new Error('Could not find the launcher executable after extracting.');
      }
      // Sanity check: what findModExe picked must actually match one of the
      // mod's own hints. Without this, if extraction silently failed to
      // produce the real launcher (e.g. antivirus quarantined the freshly
      // extracted exe), findModExe would fall back to whatever unrelated exe
      // already sitting in the game folder scored next-best (e.g. a bundled
      // DirectX/VC++ redist installer) and we'd try to spawn that instead.
      const launcherBase = path.basename(launcherExe).toLowerCase();
      const knownHints = [...(mod.launcherExeHints || []), ...(mod.exeHints || [])].map(h => h.toLowerCase());
      if (!knownHints.some(h => launcherBase.includes(h))) {
        throw new Error(
          `Extraction did not produce a recognizable launcher executable (found "${path.basename(launcherExe)}" instead of something matching ${knownHints.join('/')}). ` +
          `This usually means the download/extraction was interrupted, or antivirus quarantined the extracted file. Check your antivirus quarantine/history, add an exclusion for the game folder, and try installing again.`
        );
      }

      // Antivirus/Defender sometimes grabs a freshly-extracted exe to scan it,
      // which can briefly leave it at 0 bytes (or locked) right after extraction
      // finishes — spawning it in that state fails with a cryptic "spawn EFTYPE"
      // instead of a useful message. Give it a few short retries to settle before
      // giving up with a clear explanation.
      let launcherSize = 0;
      for (let attempt = 0; attempt < 6; attempt++) {
        try { launcherSize = fs.statSync(launcherExe).size; } catch { launcherSize = 0; }
        if (launcherSize > 0) break;
        await new Promise(r => setTimeout(r, 500));
      }
      if (launcherSize === 0) {
        throw new Error('The launcher file extracted as empty (0 bytes). This usually means the download or extraction step was interrupted — try installing again. If it keeps happening, check NinoGames settings and turn off the "7-Zip" extraction option so it uses the built-in extractor instead (avoids the UAC-elevated 7-Zip step entirely).');
      }

      sendProgress('extracting', { msg: 'Running the launcher to finish installing…' });
      let launcherProc = null;
      try {
        await new Promise((resolve, reject) => {
          try {
            launcherProc = cp.spawn(launcherExe, [], { cwd: gameDir, stdio: ['ignore', 'pipe', 'pipe'] });
          } catch (err) { return reject(err); }
          // The launcher is a CLI tool that normally opens its own console window
          // with live output when double-clicked. Spawned this way its stdio is
          // piped instead (Windows won't auto-allocate a console when handles are
          // redirected), so it'd otherwise run fully invisibly. Forward its output
          // into our own progress label instead so install progress is still visible.
          const forward = buf => {
            const lines = buf.toString().split(/\r?\n/).map(l => l.trim()).filter(Boolean);
            for (const line of lines) sendProgress('extracting', { msg: line });
          };
          launcherProc.stdout?.on('data', forward);
          launcherProc.stderr?.on('data', forward);

          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            clearInterval(pollTimer);
            clearTimeout(hardTimeout);
            resolve();
          };

          launcherProc.on('error', err => {
            if (settled) return;
            settled = true;
            clearInterval(pollTimer);
            clearTimeout(hardTimeout);
            reject(err);
          });
          launcherProc.on('close', finish);

          // IMPORTANT: the launcher does not reliably exit on its own once it's
          // done — on some builds it launches the installed game client itself
          // and then just sits there (possibly waiting on the game process),
          // so relying only on 'close' above can hang this step indefinitely,
          // leaving the UI stuck on "installing" forever. To avoid that, also
          // poll for the game's PROCESS (mod.launchExe) actually running, via
          // tasklist — the moment iw4x.exe shows up as a running process, the
          // launcher has clearly finished its job and handed off to the game,
          // independent of whether the launcher process itself ever closes.
          const expectedImage = mod.launchExe || null;
          let tasklistBusy = false;
          const pollTimer = (expectedImage && process.platform === 'win32') ? setInterval(() => {
            if (settled || tasklistBusy) return;
            tasklistBusy = true;
            cp.exec(`tasklist /FI "IMAGENAME eq ${expectedImage}" /FO CSV /NH`, (err, stdout) => {
              tasklistBusy = false;
              if (settled || err) return;
              if (stdout && stdout.toLowerCase().includes(expectedImage.toLowerCase())) {
                finish(); // process is running — install work is done
              }
            });
          }, 1000) : null;

          // Hard backstop so this step can never hang forever even if neither
          // signal above ever fires (e.g. launchExe missing from config, or an
          // unexpected launcher behavior).
          const hardTimeout = setTimeout(finish, 5 * 60 * 1000);
        });
      } finally {
        // The launcher often auto-launches the game itself once it's done
        // installing, leaving iw4x.exe running in the background — sometimes
        // even if the launcher process itself is still open or errors out
        // partway through. Either way this is just an install step, not a
        // play session, so always try to close both the launcher and the game
        // here regardless of how the run above finished or settled.
        if (process.platform === 'win32') {
          await new Promise(r => setTimeout(r, 800)); // give a just-spawned game a moment to exist
          const imageNames = new Set([
            mod.launcherExeHints ? path.basename(launcherExe) : null,
            mod.launchExe || 'iw4x.exe',
          ].filter(Boolean));
          for (const imageName of imageNames) {
            await new Promise(resolve => {
              cp.exec(`taskkill /F /IM "${imageName}"`, () => resolve());
            });
          }
        } else if (launcherProc && !launcherProc.killed) {
          try { launcherProc.kill(); } catch {}
        }
      }

      // The launcher has now finished installing IW4x's own client (iw4x.exe)
      // into gameDir. Record THAT as the launch target going forward, not the
      // launcher itself — check the configured launchExe first, then fall back
      // to scanning for it via exeHints, and only use the launcher exe as a
      // last resort if the real client can't be found.
      let exePath = mod.launchExe ? path.join(gameDir, mod.launchExe) : null;
      if (!exePath || !fs.existsSync(exePath)) {
        exePath = findModExe(gameDir, mod.exeHints) || launcherExe;
      }

      // For IW4x (and any mod that uses party.hostArgs with +exec partyserver.cfg),
      // write userraw/partyserver.cfg into the game directory so the dedicated
      // server can find it. This is safe to do on every install/reinstall.
      if (mod.party && mod.party.hostArgs && mod.party.hostArgs.includes('partyserver.cfg')) {
        try {
          const userrawDir = path.join(gameDir, 'userraw');
          fs.mkdirSync(userrawDir, { recursive: true });
          const cfgPath = path.join(userrawDir, 'partyserver.cfg');
          const cfgContent = [
            '// NinoGames party server config — auto-generated, safe to delete and reinstall',
            'set sv_hostname "NinoGames Party"',
            'set g_gametype "dm"',
            'set sv_maxclients 18',
            'set sv_pure 0',
            'set g_allowVote 0',
            'set scr_dm_scorelimit 7500',
            'set scr_dm_timelimit 10',
            'set sv_maprotation "exec partymaprotation.cfg"',
          ].join('\n') + '\n';
          fs.writeFileSync(cfgPath, cfgContent, 'utf8');

          // Also write a default map rotation config
          const mapRotPath = path.join(userrawDir, 'partymaprotation.cfg');
          if (!fs.existsSync(mapRotPath)) {
            const mapRot = [
              'set g_gametype "dm"',
              'map mp_afghan',
              'map mp_estate',
              'map mp_favela',
              'map mp_highrise',
              'map mp_invasion',
              'map mp_quarry',
              'map mp_rust',
              'map mp_rundown',
              'map mp_terminal',
              'map mp_underpass',
            ].join('\n') + '\n';
            fs.writeFileSync(mapRotPath, mapRot, 'utf8');
          }
        } catch (cfgErr) {
          // Non-fatal — server will still try to launch, just without the cfg
          console.warn('[install] failed to write partyserver.cfg:', cfgErr.message);
        }
      }

      store.upsertMultiplayerMod(modId, {
        installed: true, exePath, gameId: matched.id, installedAt: new Date().toISOString(),
      });
      sendProgress('done', { exePath });
      return { ok: true, exePath };

    } else if (mod.installType === 'steps') {
      // Multi-stage installs (e.g. RageCoop for GTA V) where several separate
      // archives each contribute a handful of files to the game folder, in a
      // fixed order, sometimes with an installer exe partway through. The
      // sequence lives in multiplayermod.json as `installSteps` so the recipe
      // is data rather than another hardcoded branch here.
      //
      // Step shapes:
      //   { type: 'zip', url, headers?, files: { 'path/in/zip': 'dest/rel/to/gameDir' } }
      //   { type: 'run', exe: 'Name.exe', wait?: true }
      const steps = Array.isArray(mod.installSteps) ? mod.installSteps : [];
      if (!steps.length) throw new Error('No install steps configured for this mod.');

      const tempRoot = path.join(app.getPath('temp'), `ninogames-mp-${modId}-${Date.now()}`);
      try {
        for (let i = 0; i < steps.length; i++) {
          const step  = steps[i];
          const label = step.label || `Step ${i + 1}`;
          const stepN = { step: i + 1, steps: steps.length, label };

          if (step.type === 'zip') {
            if (!step.url) throw new Error(`${label}: no URL configured.`);
            const zipPath    = path.join(tempRoot, `s${i}.zip`);
            const extractDir = path.join(tempRoot, `s${i}`);

            let lastPct = -1;
            sendProgress('downloading', { pct: 0, ...stepN });
            await downloadFileSimple(step.url, zipPath, (recv, total) => {
              const pct = total > 0 ? Math.round((recv / total) * 100) : 0;
              if (pct !== lastPct) { lastPct = pct; sendProgress('downloading', { pct, recv, total, ...stepN }); }
            }, step.headers);

            sendProgress('extracting', { pct: 100, ...stepN });
            await extractArchive(zipPath, extractDir, msg => sendProgress('extracting', { msg, ...stepN }));

            // Copy only the entries this step names. Anything else in the
            // archive (readmes, NativeTrainer.asi, the whole Server folder)
            // deliberately stays out of the game directory.
            for (const [src, dest] of Object.entries(step.files || {})) {
              const from = path.join(extractDir, ...src.split('/'));
              const to   = path.join(gameDir,    ...dest.split('/'));
              if (!fs.existsSync(from)) throw new Error(`${label}: "${src}" was not in the archive.`);
              fs.mkdirSync(path.dirname(to), { recursive: true });
              fs.copyFileSync(from, to);
            }

            // Whole folders, for payloads that only work as a complete set —
            // RageCoop's dedicated server needs every DLL beside its exe.
            for (const [src, dest] of Object.entries(step.dirs || {})) {
              const from = path.join(extractDir, ...src.split('/'));
              const to   = path.join(gameDir,    ...dest.split('/'));
              if (!fs.existsSync(from)) throw new Error(`${label}: folder "${src}" was not in the archive.`);
              fs.mkdirSync(to, { recursive: true });
              copyDirMerge(from, to);
            }

          } else if (step.type === 'run') {
            const exeAbs = path.join(gameDir, step.exe);
            if (!fs.existsSync(exeAbs)) throw new Error(`${label}: ${step.exe} is missing.`);
            // Run from inside gameDir so the exe sits next to both the game
            // and its own dependencies.
            sendProgress('running', { msg: step.msg || `Running ${step.exe}…`, ...stepN });
            await new Promise((resolve, reject) => {
              const proc = cp.spawn(exeAbs, [], { cwd: gameDir, detached: false, stdio: 'ignore' });
              proc.on('error', reject);
              if (step.wait === false) return resolve();
              proc.on('exit', () => resolve());
            });

          } else {
            throw new Error(`${label}: unknown step type "${step.type}".`);
          }
        }
      } finally {
        try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
      }

      const exePath = matched.execPath && fs.existsSync(matched.execPath)
        ? matched.execPath
        : findExecutable(gameDir, matched.title);
      if (!exePath) throw new Error('Installed the mod files, but could not find the game executable to launch.');

      store.upsertMultiplayerMod(modId, {
        installed: true, exePath, gameId: matched.id, installedAt: new Date().toISOString(),
      });
      sendProgress('done', { exePath });
      return { ok: true, exePath };

    } else if (mod.installType === 'manifest') {
      // e.g. CoD4x via the CB Servers CDN — no installer or launcher exe at
      // all. Fetch a JSON manifest of [name, size, sha1] entries, hash
      // whatever's already in gameDir, and download only what's missing or
      // stale straight into place. This mirrors how CB Launcher's own
      // client_updater works, just re-implemented here instead of shelling
      // out to their launcher exe.
      if (!mod.manifestUrl || !mod.folderUrl) throw new Error('No manifest/folder URL configured for this mod.');

      const crypto = require('crypto');

      sendProgress('downloading', { msg: 'Fetching file manifest…' });
      const manifestRaw = await new Promise((resolve, reject) => {
        const req = net.request({ url: mod.manifestUrl, method: 'GET', redirect: 'follow' });
        req.setHeader('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
        let body = '';
        req.on('response', res => {
          if (res.statusCode >= 400) return reject(new Error(`Manifest fetch failed: HTTP ${res.statusCode}`));
          res.on('data', c => { body += c.toString(); });
          res.on('end', () => resolve(body));
        });
        req.on('error', reject);
        req.end();
      });

      let manifest;
      try { manifest = JSON.parse(manifestRaw); } catch (err) { throw new Error('Manifest was not valid JSON: ' + err.message); }

      // Support two manifest shapes:
      //   1. Plain array   — [[name, size, sha1], ...]         (CoD4x / GitHub-style)
      //   2. Object        — { files: [[name, size, hash, component], ...] }  (CB Servers MWR-style)
      let files;
      if (Array.isArray(manifest)) {
        // Shape 1 — plain array, each entry is [name, size, sha1hash]
        files = manifest.map(e => ({ name: e[0], size: e[1], hash: e[2] })).filter(f => f.name);
      } else if (manifest && Array.isArray(manifest.files)) {
        // Shape 2 — CB Servers object manifest, each entry is [name, size, hash, component]
        files = manifest.files.map(e => ({ name: e[0], size: e[1], hash: e[2] })).filter(f => f.name);
      } else {
        throw new Error('Unexpected manifest format — not an array and has no .files array.');
      }

      // When skipHashCheck is true (e.g. CB Servers uses xxhash64, not SHA1)
      // we fall back to size-only verification so we never re-hash with the
      // wrong algorithm and end up re-downloading everything on every run.
      const skipHashCheck = !!mod.skipHashCheck;

      const sha1OfFile = filePath => new Promise(resolve => {
        try {
          const hash = crypto.createHash('sha1');
          const stream = fs.createReadStream(filePath);
          stream.on('data', d => hash.update(d));
          stream.on('end', () => resolve(hash.digest('hex')));
          stream.on('error', () => resolve(null));
        } catch { resolve(null); }
      });

      sendProgress('downloading', { msg: `Checking ${files.length} files…` });
      const outdated = [];
      for (const f of files) {
        const dest = path.join(gameDir, ...f.name.split('/'));
        let needsDownload = true;
        try {
          if (fs.existsSync(dest)) {
            if (skipHashCheck) {
              // Size-only check — avoids mismatched hash algorithm false-positives
              const stat = fs.statSync(dest);
              needsDownload = stat.size !== f.size;
            } else {
              const localHash = await sha1OfFile(dest);
              needsDownload = !localHash || localHash.toLowerCase() !== (f.hash || '').toLowerCase();
            }
          }
        } catch { needsDownload = true; }
        if (needsDownload) outdated.push(f);
      }

      if (!outdated.length) {
        sendProgress('downloading', { msg: 'All files already up to date.' });
      } else {
        // ── Aggregate progress tracking for the full manifest sync ──────────
        const totalFiles   = outdated.length;
        const totalBytes   = outdated.reduce((s, f) => s + (f.size || 0), 0);
        let   doneFiles    = 0;
        let   doneBytes    = 0;   // bytes fully downloaded (completed files)
        let   sessionStart = Date.now();
        let   lastSpeedTs  = Date.now();
        let   lastSpeedBytes = 0;
        let   smoothSpeed  = 0;   // exponential-smoothed bytes/s

        const fmtEta = secs => {
          if (!isFinite(secs) || secs <= 0) return '';
          const h = Math.floor(secs / 3600);
          const m = Math.floor((secs % 3600) / 60);
          const s = Math.floor(secs % 60);
          if (h > 0) return `${h}h ${m}m`;
          if (m > 0) return `${m}m ${s}s`;
          return `${s}s`;
        };

        for (const f of outdated) {
          const dest = path.join(gameDir, ...f.name.split('/'));
          const url  = skipHashCheck
            ? mod.folderUrl + f.name.split('/').map(encodeURIComponent).join('/')
            : mod.folderUrl + f.name.split('/').map(encodeURIComponent).join('/') + '?' + f.hash;

          let fileRecv = 0;

          await downloadFileSimple(url, dest, (recv, _total) => {
            // How many bytes advanced since last callback for this file
            const delta     = recv - fileRecv;
            fileRecv        = recv;
            doneBytes      += delta;

            // Speed: exponential moving average, recalculated every ~200 ms
            const now       = Date.now();
            const dtSpeed   = (now - lastSpeedTs) / 1000;
            if (dtSpeed >= 0.2) {
              const rawSpeed  = (doneBytes - lastSpeedBytes) / dtSpeed;
              smoothSpeed     = smoothSpeed === 0 ? rawSpeed : smoothSpeed * 0.7 + rawSpeed * 0.3;
              lastSpeedBytes  = doneBytes;
              lastSpeedTs     = now;
            }

            // Overall percent — use byte-level accuracy when we have sizes,
            // fall back to file-count percent when sizes are 0
            const pct = totalBytes > 0
              ? Math.min(99, Math.round((doneBytes / totalBytes) * 100))
              : Math.round((doneFiles / totalFiles) * 100);

            // ETA from smoothed speed
            const remaining = totalBytes - doneBytes;
            const etaSecs   = smoothSpeed > 0 ? remaining / smoothSpeed : Infinity;
            const etaStr    = fmtEta(etaSecs);

            // Human-readable sizes
            const recvFmt   = fmtBytes(doneBytes);
            const totalFmt  = totalBytes > 0 ? fmtBytes(totalBytes) : '';
            const speedFmt  = smoothSpeed > 0 ? `${fmtBytes(smoothSpeed)}/s` : '';

            const msg = [
              `File ${doneFiles + 1}/${totalFiles}`,
              totalFmt ? `${recvFmt} / ${totalFmt}` : recvFmt,
              speedFmt,
              etaStr ? `ETA ${etaStr}` : '',
            ].filter(Boolean).join('  •  ');

            sendProgress('downloading', { pct, msg, recv: doneBytes, total: totalBytes, speed: smoothSpeed, eta: etaStr });
          });

          doneFiles++;
          doneBytes = outdated.slice(0, doneFiles).reduce((s, x) => s + (x.size || 0), 0);
        }
        sendProgress('downloading', { msg: `Synced ${totalFiles} file(s).`, pct: 100 });
      }

      // ── Secondary manifest (e.g. h1-mod.exe layer on top of base MWR files) ──
      if (mod.secondaryManifestUrl && mod.secondaryFolderUrl) {
        sendProgress('downloading', { msg: 'Fetching mod client files manifest…' });
        const secRaw = await new Promise((resolve, reject) => {
          const req = net.request({ url: mod.secondaryManifestUrl, method: 'GET', redirect: 'follow' });
          req.setHeader('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
          let body = '';
          req.on('response', res => {
            if (res.statusCode >= 400) return reject(new Error(`Secondary manifest fetch failed: HTTP ${res.statusCode}`));
            res.on('data', c => { body += c.toString(); });
            res.on('end', () => resolve(body));
          });
          req.on('error', reject);
          req.end();
        });
        let secManifest;
        try { secManifest = JSON.parse(secRaw); } catch (err) { throw new Error('Secondary manifest was not valid JSON: ' + err.message); }
        let secFiles;
        if (Array.isArray(secManifest)) {
          secFiles = secManifest.map(e => ({ name: e[0], size: e[1], hash: e[2] })).filter(f => f.name);
        } else if (secManifest && Array.isArray(secManifest.files)) {
          secFiles = secManifest.files.map(e => ({ name: e[0], size: e[1], hash: e[2] })).filter(f => f.name);
        } else {
          throw new Error('Secondary manifest format not recognised.');
        }

        const sha1OfFile2 = filePath => new Promise(resolve => {
          try {
            const hash = crypto.createHash('sha1');
            const stream = fs.createReadStream(filePath);
            stream.on('data', d => hash.update(d));
            stream.on('end', () => resolve(hash.digest('hex')));
            stream.on('error', () => resolve(null));
          } catch { resolve(null); }
        });

        sendProgress('downloading', { msg: `Checking ${secFiles.length} mod client file(s)…` });
        const secOutdated = [];
        for (const f of secFiles) {
          const dest = path.join(gameDir, ...f.name.split('/'));
          let needs = true;
          try {
            if (fs.existsSync(dest)) {
              const localHash = await sha1OfFile2(dest);
              needs = !localHash || localHash.toLowerCase() !== (f.hash || '').toLowerCase();
            }
          } catch { needs = true; }
          if (needs) secOutdated.push(f);
        }

        if (secOutdated.length) {
          let secDone = 0;
          for (const f of secOutdated) {
            const dest = path.join(gameDir, ...f.name.split('/'));
            const url  = mod.secondaryFolderUrl + f.name.split('/').map(encodeURIComponent).join('/') + '?' + f.hash;
            sendProgress('downloading', { msg: `Mod files: ${f.name} (${secDone + 1}/${secOutdated.length})`, pct: Math.round((secDone / secOutdated.length) * 100) });
            await downloadFileSimple(url, dest);
            secDone++;
          }
        }
        sendProgress('downloading', { msg: 'Mod client files up to date.', pct: 100 });
      }

      // Prefer the configured client name; otherwise fall back to a strict
      // hint-matched client (mirrors the launcher branch above). Never fall
      // back to an unrelated exe — that could record SP CoD2SP_s.exe as the
      // CoD2x multiplayer client.
      let exePath = null;
      if (mod.launchExe && fs.existsSync(path.join(gameDir, mod.launchExe))) {
        exePath = path.join(gameDir, mod.launchExe);
      } else if (mod.exeHints && mod.exeHints.length) {
        exePath = findHintExe(gameDir, mod.exeHints);
      }
      if (!exePath) {
        throw new Error('File sync finished, but the game client executable could not be found afterward.');
      }

      store.upsertMultiplayerMod(modId, {
        installed: true, exePath, gameId: matched.id, installedAt: new Date().toISOString(),
      });
      sendProgress('done', { exePath });
      return { ok: true, exePath };

    } else if (mod.installType === 'exe') {
      // e.g. H1-Mod / H2-Mod — a single standalone .exe downloaded directly
      // into the game directory. No archive to extract.
      if (!mod.downloadUrl) throw new Error('No download URL configured for this mod.');

      const destExe = path.join(gameDir, mod.launchExe || path.basename(mod.downloadUrl));
      sendProgress('downloading', { pct: 0 });
      let lastPct = -1;
      await downloadFileSimple(mod.downloadUrl, destExe, (recv, total) => {
        const pct = total > 0 ? Math.round((recv / total) * 100) : 0;
        if (pct !== lastPct) { lastPct = pct; sendProgress('downloading', { pct, recv, total }); }
      });

      store.upsertMultiplayerMod(modId, {
        installed: true, exePath: destExe, gameId: matched.id, installedAt: new Date().toISOString(),
      });
      sendProgress('done', { exePath: destExe });
      return { ok: true, exePath: destExe };

    } else if (mod.installType === 'installer') {
      // e.g. CoD4x — the download itself is an interactive Setup.exe, not
      // the game client. Run it once (in the game folder, so if it assumes
      // "current directory" it lands in the right place) and wait for the
      // user to click through it, then scan the game folder afterward for
      // the client exe it actually produces (matched via exeHints) — the
      // installer is never the thing we record as exePath.
      if (!mod.downloadUrl) throw new Error('No download URL configured for this mod.');

      const tempRoot = path.join(app.getPath('temp'), `ninogames-mp-${modId}-${Date.now()}`);
      const installerExe = path.join(tempRoot, mod.installerName || path.basename(mod.downloadUrl));

      sendProgress('downloading', { pct: 0 });
      let lastPct = -1;
      await downloadFileSimple(mod.downloadUrl, installerExe, (recv, total) => {
        const pct = total > 0 ? Math.round((recv / total) * 100) : 0;
        if (pct !== lastPct) { lastPct = pct; sendProgress('downloading', { pct, recv, total }); }
      });

      sendProgress('extracting', { msg: 'Waiting for the installer to finish… finish the setup wizard to continue.' });
      await new Promise((resolve, reject) => {
        let proc;
        try {
          proc = cp.spawn(installerExe, [], { cwd: gameDir });
        } catch (err) { return reject(err); }
        proc.on('error', reject);
        proc.on('close', () => resolve());
      });
      try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}

      // The installer just wrote the real client into gameDir — find it now,
      // never assume the installer's own filename is the launchable exe.
      const installedExe = findModExe(gameDir, mod.exeHints);
      if (!installedExe || !fs.existsSync(installedExe)) {
        throw new Error('Installer finished, but the client executable could not be found afterward — make sure you completed the setup wizard and pointed it at your game folder.');
      }

      store.upsertMultiplayerMod(modId, {
        installed: true, exePath: installedExe, gameId: matched.id, installedAt: new Date().toISOString(),
      });
      sendProgress('done', { exePath: installedExe });
      return { ok: true, exePath: installedExe };

    } else if (mod.installType === 'gta-connected') {
      // GTA Connected client — three stages:
      //   1. Download + extract the client ZIP, run its interactive installer
      //      and WAIT for the user to click through the setup wizard.
      //   2. Download + extract Retail-1080.zip into the matched game's real
      //      folder (next to GTAIV.exe). Those files ARE the downgrade to GTA
      //      IV 1.0.8.0 that the GTAC client requires — overwriting the game's
      //      files with them is the supported downgrade method.
      //   3. Detect the installed client (Launcher.exe under AppData) and
      //      record it as the launch target.
      if (!mod.clientUrl || !mod.retailUrl) throw new Error('No client/retail URL configured for this mod.');

      const tempRoot = path.join(app.getPath('temp'), `ninogames-mp-${modId}-${Date.now()}`);

      // ── Stage 1: client installer ──────────────────────────────
      sendProgress('downloading', { msg: 'Downloading the GTA Connected client…', pct: 0 });
      const clientZip = path.join(tempRoot, 'client.zip');
      let lastPct = -1;
      await downloadFileSimple(mod.clientUrl, clientZip, (recv, total) => {
        const pct = total > 0 ? Math.round((recv / total) * 100) : 0;
        if (pct !== lastPct) { lastPct = pct; sendProgress('downloading', { pct, recv, total }); }
      });

      sendProgress('extracting', { pct: 100, msg: 'Extracting the client installer…' });
      const clientExtract = path.join(tempRoot, 'client');
      await extractArchive(clientZip, clientExtract, msg => sendProgress('extracting', { msg }));

      // Prefer a plain-named setup/install exe first (that's almost always the
      // actual installer), then fall back to anything with "gtac" in its name
      // in case the package calls the installer after the game instead.
      const installerExe =
        findHintExe(clientExtract, ['setup', 'installer', 'install']) ||
        findHintExe(clientExtract, ['gtac']);
      if (!installerExe || !fs.existsSync(installerExe)) {
        throw new Error('Could not find the GTA Connected client installer inside the downloaded ZIP. The download may have been interrupted or antivirus quarantined the extracted file — try installing again.');
      }

      sendProgress('extracting', { msg: 'Running the GTA Connected setup wizard — finish it to continue…' });
      await new Promise((resolve, reject) => {
        let proc;
        try {
          proc = cp.spawn(installerExe, [], { cwd: clientExtract });
        } catch (err) { return reject(err); }
        proc.on('error', reject);
        // Reminder in case the user glances away while the installer sits open
        const nudge = setTimeout(() => sendProgress('extracting', { msg: 'Waiting for the GTA Connected setup wizard… complete it to continue.' }), 4000);
        proc.on('close', () => { clearTimeout(nudge); resolve(); });
      });

      // ── Stage 2: downgrade the game to 1.0.8.0 with a real tool ──
      // Steam / Complete Edition / Rockstar launcher installs (1.2.x) can't be
      // downgraded by unzipping retail files over them — the binaries themselves
      // must be replaced. GTAIVDowngrader does that properly. We download it into
      // a stable folder once, run its wizard and wait for the user to finish it.
      sendProgress('extracting', { msg: 'Preparing the GTA IV downgrader…' });
      const dg = await ensureGtaIvDowngrader(mod, (phase, extra) => sendProgress('extracting', { msg: extra.msg }));
      sendProgress('extracting', { msg: 'Running the GTA IV downgrader (as administrator) — select your GTAIV.exe and downgrade to 1.0.8.0, then wait for it to finish…' });
      // The downgrader must run elevated to write into Program Files installs
      // (and even steams its own files). Start-Process -Verb RunAs raises the
      // UAC prompt; -Wait keeps our wait block alive until the wizard closes.
      // If the user declines UAC the process is never started — treat that as
      // a real failure rather than silently continuing with a non-downgraded
      // game (there's no version check anymore, the tool just always runs).
      await new Promise((resolve, reject) => {
        const safeExe = dg.exe.replace(/'/g, "''");
        const safeCwd = path.dirname(dg.exe).replace(/'/g, "''");
        const psCmd = `try { Start-Process -FilePath '${safeExe}' -WorkingDirectory '${safeCwd}' -Verb RunAs -Wait -ErrorAction Stop } catch { exit 1 }`;
        let proc;
        try {
          proc = cp.spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', psCmd], { windowsHide: true });
        } catch (err) { return reject(err); }
        proc.on('error', reject);
        // Reminder in case the wizard sits open while the user reads its steps
        const nudge = setTimeout(() => sendProgress('extracting', { msg: 'Waiting for the GTA IV downgrader… complete the wizard to continue.' }), 4000);
        proc.on('close', (code) => {
          clearTimeout(nudge);
          if (code !== 0) return reject(new Error('The GTA IV downgrader needs administrator rights to run (the UAC prompt was declined). Install again and accept the prompt.'));
          resolve();
        });
      });

      // ── Stage 3: retail 1.0.8.0 downgrade files into the game dir ──
      sendProgress('downloading', { msg: 'Downloading the GTA IV 1.0.8.0 retail update…', pct: 100 });
      const retailZip = path.join(tempRoot, 'retail-1080.zip');
      lastPct = -1;
      await downloadFileSimple(mod.retailUrl, retailZip, (recv, total) => {
        const pct = total > 0 ? Math.round((recv / total) * 100) : 0;
        if (pct !== lastPct) { lastPct = pct; sendProgress('downloading', { pct, recv, total }); }
      });

      sendProgress('extracting', { pct: 100, msg: 'Extracting GTA IV 1.0.8.0 files into the game folder…' });
      const retailExtract = path.join(tempRoot, 'retail');
      await extractArchive(retailZip, retailExtract, msg => sendProgress('extracting', { msg }));
      copyDirMerge(retailExtract, gameDir);

      // ── Stage 2b: binkw32.dll (32-bit) — the SecuROM/DRM bypass that lets
      // 1.0.8.0 launch. Download + extract the zip and flatten ALL of its
      // files into the game dir root — the package is typically wrapped in a
      // "binkw32.dll (32-Bit)" folder, so the inner files must come out next
      // to GTAIV.exe rather than nested under that folder.
      if (mod.binkw32Url) {
        sendProgress('downloading', { msg: 'Downloading binkw32.dll…', pct: 0 });
        const binkZip = path.join(tempRoot, 'binkw32.zip');
        lastPct = -1;
        await downloadFileSimple(mod.binkw32Url, binkZip, (recv, total) => {
          const pct = total > 0 ? Math.round((recv / total) * 100) : 0;
          if (pct !== lastPct) { lastPct = pct; sendProgress('downloading', { pct, recv, total }); }
        });

        sendProgress('extracting', { pct: 100, msg: 'Extracting binkw32.dll next to GTAIV.exe…' });
        const binkExtract = path.join(tempRoot, 'binkw32');
        await extractArchive(binkZip, binkExtract, msg => sendProgress('extracting', { msg }));
        flattenExtractInto(binkExtract, gameDir);
      }
      try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}

      // ── Stage 2c: point GTA Connected at the retail GTAIV.exe ──
      // The launcher auto-detects the Complete Edition exe (1.2.x) unless its
      // "Game EXE Path" registry setting is set — that's the [UNSUPPORTED
      // ENGINE] disconnect. Write the retail 1.0.8.0 exe we just laid into
      // gameDir\Retail so joining a server runs the downgraded game. Skipped
      // silently if the Retail exe isn't there (non-fatal either way).
      const retailExe = path.join(gameDir, 'Retail', 'GTAIV.exe');
      if (fs.existsSync(retailExe)) {
        sendProgress('extracting', { pct: 100, msg: 'Pointing GTA Connected at the retail GTAIV.exe…' });
        if (setGtacGameExePath(mod, retailExe)) {
          sendProgress('extracting', { pct: 100, msg: 'GTA Connected will launch the retail 1.0.8.0 GTAIV.exe.' });
        }
      }

      // ── Stage 3: locate the installed client and record it ─────
      const detected = detectExistingMod(mod, matched);
      if (!detected || !detected.exePath || !fs.existsSync(detected.exePath)) {
        throw new Error('The GTA Connected client was not found after the installer finished. Make sure you completed the setup wizard (the client installs to "%LOCALAPPDATA%\\Jack\'s Mini Network\\Grand Theft Auto Connected"), then try installing again.');
      }

      store.upsertMultiplayerMod(modId, {
        installed: true, exePath: detected.exePath, gameId: matched.id, installedAt: new Date().toISOString(),
      });
      sendProgress('done', { exePath: detected.exePath });
      return { ok: true, exePath: detected.exePath };

    } else if (mod.installType === 'standalone') {
      // Legacy: download a ZIP to a temp dir, extract, then copy the found
      // exe into the game directory.
      if (!mod.downloadUrl) throw new Error('No download URL configured for this mod.');

      const tempRoot   = path.join(app.getPath('temp'), `ninogames-mp-${modId}-${Date.now()}`);
      const zipPath    = path.join(tempRoot, 'mod.zip');
      const extractDir = path.join(tempRoot, 'extracted');

      sendProgress('downloading', { pct: 0 });
      let lastPct = -1;
      await downloadFileSimple(mod.downloadUrl, zipPath, (recv, total) => {
        const pct = total > 0 ? Math.round((recv / total) * 100) : 0;
        if (pct !== lastPct) { lastPct = pct; sendProgress('downloading', { pct, recv, total }); }
      });

      sendProgress('extracting', { pct: 100 });
      await extractArchive(zipPath, extractDir, msg => sendProgress('extracting', { msg }));
      try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}

      const foundExe = findModExe(extractDir, mod.exeHints);
      if (!foundExe) throw new Error('Could not find an executable inside the downloaded archive.');
      const destExe = path.join(gameDir, path.basename(foundExe));
      fs.copyFileSync(foundExe, destExe);

      store.upsertMultiplayerMod(modId, {
        installed: true, exePath: destExe, gameId: matched.id, installedAt: new Date().toISOString(),
      });
      sendProgress('done', { exePath: destExe });
      return { ok: true, exePath: destExe };

    } else {
      // 'patch' (legacy) — merge a downloaded archive's contents into the
      // game's install directory, then launch through its own executable.
      if (!mod.downloadUrl) throw new Error('No download URL configured for this mod.');

      const tempRoot   = path.join(app.getPath('temp'), `ninogames-mp-${modId}-${Date.now()}`);
      const zipPath    = path.join(tempRoot, 'mod.zip');
      const extractDir = path.join(tempRoot, 'extracted');

      sendProgress('downloading', { pct: 0 });
      let lastPct = -1;
      await downloadFileSimple(mod.downloadUrl, zipPath, (recv, total) => {
        const pct = total > 0 ? Math.round((recv / total) * 100) : 0;
        if (pct !== lastPct) { lastPct = pct; sendProgress('downloading', { pct, recv, total }); }
      });

      sendProgress('extracting', { pct: 100 });
      await extractArchive(zipPath, extractDir, msg => sendProgress('extracting', { msg }));
      try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}

      copyDirMerge(extractDir, gameDir);
      const exePath = matched.execPath && fs.existsSync(matched.execPath)
        ? matched.execPath
        : findExecutable(gameDir, matched.title);
      if (!exePath) throw new Error('Patched the game folder, but could not find its executable to launch.');

      store.upsertMultiplayerMod(modId, {
        installed: true, exePath, gameId: matched.id, installedAt: new Date().toISOString(),
      });
      sendProgress('done', { exePath });
      return { ok: true, exePath };
    }
  } catch (err) {
    // GitHub's "latest release" redirect for the IW4x launcher intermittently
    // 404s under load rather than returning a real "not found" — in practice
    // this means IW4x's own release infrastructure is rate-limiting us.
    const message = (modId === 'iw4x' && err.statusCode === 404)
      ? 'Your connection to IW4x servers has been ratelimited. Please try again in a few seconds.'
      : err.message;
    sendProgress('failed', { error: message });
    return { error: message };
  }
});

// Some mods expect registry keys that the game's own installer would have
// created. Repacked copies never ran that installer, so the key is simply
// absent and the mod fails at startup — CoD2x aborts with "Failed to open
// registry key for HWID" because it stores the machine's HWID under
// Activision's key. Creating the (empty) key is enough; the mod fills in its
// own values. Only ever creates keys the mod itself declares, only under
// HKCU, and never writes values or touches an existing key.
function ensureModRegistryKeys(mod) {
  const keys = (mod && mod.registryKeys) || [];
  for (const key of keys) {
    if (typeof key !== 'string') continue;
    // HKCU only: no elevation needed, and nothing machine-wide is touched.
    if (!/^[A-Za-z0-9 \\._-]+$/.test(key) || key.includes('..')) continue;
    const full = `HKCU\\${key}`;
    try {
      const probe = cp.spawnSync('reg.exe', ['query', full], { windowsHide: true });
      if (probe.status === 0) continue;   // already there, leave it alone
      cp.spawnSync('reg.exe', ['add', full, '/f'], { windowsHide: true });
    } catch { /* non-fatal: the mod may still work */ }
  }
}

ipcMain.handle('launch-multiplayer-mod', (_e, modId) => {
  const entry = store.getMultiplayerMod(modId);
  const defs = loadMultiplayerModDefs();
  const mod = defs.find(m => m.id === modId);
  ensureModRegistryKeys(mod);

  // installType 'existing' mods are detected on disk rather than stored.
  // gta-connected also falls back to disk detection so the client install
  // survives even if the stored state is stale.
  let exePath = entry && entry.exePath;
  if (!exePath && mod && (mod.installType === 'existing' || mod.installType === 'gta-connected')) {
    const matched = findMatchedLibraryGame(mod.gameTitle);
    const detected = detectExistingMod(mod, matched);
    exePath = detected && detected.exePath;
  }

  if (!exePath || !fs.existsSync(exePath)) {
    return { error: 'Mod is not installed yet. Set it up manually and try again.' };
  }
  // Guard against stale saved state pointing at an installer exe instead of
  // the actual client (e.g. mods installed before installType: 'installer'
  // support existed, or any future case where an install ends up recording
  // the wrong file). Launching the installer again instead of the game is
  // confusing, so refuse and ask for a reinstall rather than doing that.
  if (mod && mod.installType === 'installer' && mod.installerName &&
      path.basename(exePath).toLowerCase() === mod.installerName.toLowerCase()) {
    return { error: 'This mod is set up to launch its installer instead of the game client. Please uninstall and reinstall it to fix this.' };
  }
  try {
    // Use the directory containing the mod exe as cwd — this is always the
    // real game folder (where h1_mp64_ship.exe, zone/, etc. live) because
    // that's where the manifest installer placed h1-mod.exe. Using installDir
    // instead risks pointing at a wrapper/parent folder, which makes the mod
    // fail to find the base game binary next to itself.
    const cwd = path.dirname(exePath);
    const proc = cp.spawn(exePath, [], { detached: true, stdio: 'ignore', cwd });
    proc.unref();
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
});

// ══════════════════════════════════════════════════════════════
// EasyTier Party — ad-hoc virtual LAN for multiplayer mods
// ══════════════════════════════════════════════════════════════
function partyEvent(evt) { sendMain('party-event', evt); }

ipcMain.handle('party-get-state', () => party.getState());

ipcMain.handle('party-install-easytier', async () => {
  const result = await party.ensureEasyTierInstalled(progress => {
    sendMain('party-install-progress', progress);
  });
  return result;
});

ipcMain.handle('party-host', async () => {
  const result = await party.hostParty(partyEvent);
  sendMain('party-state', party.getState());
  return result;
});

ipcMain.handle('party-join', async (_e, code) => {
  const result = await party.joinParty(code, partyEvent);
  sendMain('party-state', party.getState());
  return result;
});

ipcMain.handle('party-leave', async () => {
  stopGtacServer();
  const result = await party.leaveParty();
  sendMain('party-state', party.getState());
  return result;
});

ipcMain.handle('party-get-members', async () => {
  const st = party.getState();
  if (st.status !== 'connected') return { ok: true, members: [] };
  return await party.listMembers();
});

// ── GTA IV 1.0.8.0 downgrader (ClonkAndre/GTAIVDowngrader) ──────
// Roaming Steam / Complete Edition / Rockstar launcher installs run the game
// binaries at 1.2.x, which GTA Connected refuses to launch. The official
// GTAIVDowngrader wizard swaps in the retail 1.0.8.0 binaries; we download it
// once into a stable folder, launch its wizard and wait for the user to finish.
function gtaIvDowngraderDir(mod) {
  return expandEnvPath(mod.downgraderDir || '%APPDATA%/NinoGames/iv-downgrader');
}

// The downgrader executable, if the package is already present.
function findGtaIvDowngraderExe(mod) {
  const dir = gtaIvDowngraderDir(mod);
  if (!fs.existsSync(dir)) return null;
  return findHintExe(dir, mod.downgraderExeHints || ['IVDowngrader']);
}

// Download + extract the downgrader package into its stable folder (once),
// then return the path of the wizard executable. Mirrors ensureGtacServer.
async function ensureGtaIvDowngrader(mod, onProgress) {
  const existing = findGtaIvDowngraderExe(mod);
  if (existing && fs.existsSync(existing)) return { ok: true, exe: existing, downloaded: false };
  if (!mod.downgraderUrl) throw new Error('This mod has no GTA IV downgrader URL configured.');
  const emit = onProgress || (() => {});
  const dir = gtaIvDowngraderDir(mod);
  fs.mkdirSync(dir, { recursive: true });
  const tempRoot = path.join(app.getPath('temp'), `ninogames-gtac-downgrade-${Date.now()}`);
  const zipPath = path.join(tempRoot, 'downgrader.zip');
  emit('downloading', { pct: 0, msg: 'Downloading the GTA IV downgrader tool…' });
  let lastPct = -1;
  await downloadFileSimple(mod.downgraderUrl, zipPath, (recv, total) => {
    const pct = total > 0 ? Math.round((recv / total) * 100) : 0;
    if (pct !== lastPct) { lastPct = pct; emit('downloading', { pct, recv, total }); }
  });
  emit('extracting', { pct: 100, msg: 'Extracting the GTA IV downgrader tool…' });
  await extractArchive(zipPath, dir, msg => emit('extracting', { msg }));
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
  const exe = findGtaIvDowngraderExe(mod);
  if (!exe) throw new Error('The GTA IV downgrader downloaded but its executable was not found after extracting.');
  return { ok: true, exe, downloaded: true };
}

// ── GTA Connected game-path registry ───────────────────────────
// GTAC persists the per-game executable path in the registry, not in a config
// file: HKCU\Software\Jack's Mini Network\Grand Theft Auto Connected\<Game>
// → value "Game EXE Path" (REG_SZ). The launcher auto-detects the wrong
// (Complete Edition / 1.2.x) GTAIV.exe unless this is set, which makes it
// disconnect with [UNSUPPORTED ENGINE]. After we drop retail 1.0.8.0 into
// gameDir\Retail we point GTAC at that exe directly so joining a server runs
// the downgraded game. Returns true on success.
function setGtacGameExePath(mod, retailExePath) {
  if (process.platform !== 'win32' || !retailExePath || !fs.existsSync(retailExePath)) return false;
  const key = `HKCU\\Software\\Jack's Mini Network\\Grand Theft Auto Connected\\${mod.gameTitle || 'Grand Theft Auto IV'}`;
  const r = cp.spawnSync('reg', ['add', key, '/v', 'Game EXE Path', '/t', 'REG_SZ', '/d', retailExePath, '/f'], { windowsHide: true, timeout: 10000 });
  return r.status === 0;
}

// ── GTA Connected uninstall ────────────────────────────────────
// The GTAC client lives in %LOCALAPPDATA%\Jack's Mini Network\Grand Theft
// Auto Connected (declared via externalDirs) and the party server package in
// %APPDATA%\NinoGames\gtac-server (serverDir) — NEITHER is inside the game
// folder, so the generic gameDir-based cleanup in 'uninstall-multiplayer-mod'
// never finds them and would leave GTAC fully installed. This pass kills its
// processes, removes those folders, then drops its shortcuts and registry
// entries. The base game (GTA IV) is never touched.
async function uninstallGtac(mod) {
  const dirs = [
    ...(mod.externalDirs || []).map(expandEnvPath).filter(Boolean),
    ...(mod.serverDir ? [expandEnvPath(mod.serverDir)] : []),
  ];
  const roots = [...new Set(dirs.map(d => d.replace(/[\\/]+$/, '')))];

  const rootsPs = roots.map(d => `'${d.replace(/'/g, "''")}'`).join(', ');
  const ps = `
$roots = @(${rootsPs})
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | ForEach-Object {
  $exe = $_.ExecutablePath
  if ($exe) {
    foreach ($root in $roots) {
      if ($exe.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) {
        try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {}
        break
      }
    }
  }
}
$folders = @('Desktop', 'StartMenu', 'Programs', 'CommonDesktopDirectory', 'CommonStartMenu', 'CommonPrograms')
foreach ($f in $folders) {
  $base = [Environment]::GetFolderPath($f)
  if (Test-Path $base) {
    Get-ChildItem $base -Recurse -Filter '*.lnk' -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -match 'GTA Connected|GTAC' } |
      ForEach-Object { Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue }
  }
}
$hives = @(
  'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM:\\Software\\Wow6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
)
foreach ($h in $hives) {
  if (-not (Test-Path $h)) { continue }
  foreach ($key in Get-ChildItem $h -ErrorAction SilentlyContinue) {
    $disp = (Get-ItemProperty $key.PSPath -Name DisplayName -ErrorAction SilentlyContinue).DisplayName
    if ($disp -match 'GTA Connected|GTAC') { Remove-Item $key.PSPath -Recurse -Force -ErrorAction SilentlyContinue }
  }
}
Remove-Item 'HKCU:\\Software\\GTA Connected' -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item 'HKCU:\\Software\\Classes\\gtac' -Recurse -Force -ErrorAction SilentlyContinue
`;
  await new Promise(resolve => {
    cp.exec(`powershell -NoProfile -NonInteractive -Command "${ps}"`, { windowsHide: true, timeout: 30000 }, () => resolve());
  });

  // Files can be briefly locked by a dying process — retry a few times.
  for (const d of roots) {
    for (let attempt = 0; attempt < 5; attempt++) {
      try { fs.rmSync(d, { recursive: true, force: true }); break; }
      catch { await new Promise(r => setTimeout(r, 400)); }
    }
  }
}

// ── GTA Connected dedicated server ──────────────────────────────
// GTAC gets its own hosting story: instead of '+set'-style client flags we
// download the dedicated-server package once (into %APPDATA%/NinoGames/
// gtac-server), write a server.xml from a per-mod template + GUI fields,
// then launch the server AND the host's own client over the virtual LAN.

// Where the GTAC dedicated-server package lives on disk.
function gtacServerDir(mod) {
  return expandEnvPath(mod.serverDir || '%APPDATA%/NinoGames/gtac-server');
}

// The dedicated-server executable, if the package is already present.
function findGtacServerExe(mod) {
  const dir = gtacServerDir(mod);
  if (!dir || !fs.existsSync(dir)) return null;
  return findHintExe(dir, mod.serverExeHints || ['Multi Theft Auto Server', 'mta-server', 'GTAC Server', 'Server']);
}

// PID of the GTAC server this host started (set via Start-Process -PassThru),
// so we can stop it when the party stops playing GTA Connected. Stale servers
// from before PID tracking started are found by path in stopGtacServer too.
let gtacServerPid = null;

// kills the GTA Connected dedicated server the host started (plus any GTAC
// server still running from the server dir, e.g. a leftover invisible one).
// Synchronous (spawnSync) so it can be called from sync IPC handlers too.
function stopGtacServer() {
  const pids = new Set();
  if (gtacServerPid) pids.add(gtacServerPid);
  const gtacDef = loadMultiplayerModDefs().find(m => m.id === 'gtac');
  const dir = gtacDef ? gtacServerDir(gtacDef) : null;
  if (dir && fs.existsSync(dir)) {
    const safeDir = dir.replace(/'/g, "''");
    const ps = `
$dir = '${safeDir}'
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
  $_.ExecutablePath -and $_.ExecutablePath.StartsWith($dir, [System.StringComparison]::OrdinalIgnoreCase)
} | ForEach-Object { Write-Output $_.ProcessId }`;
    const r = cp.spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 10000 });
    (r.stdout || '').toString().split(/\s+/).forEach(t => {
      const n = parseInt(t, 10);
      if (Number.isInteger(n) && n > 0) pids.add(n);
    });
  }
  for (const p of pids) {
    try { cp.spawnSync('taskkill', ['/PID', String(p), '/T', '/F'], { windowsHide: true, timeout: 10000 }); } catch {}
  }
  gtacServerPid = null;
}

// Downloads + extracts the GTAC server package into its dir (idempotent —
// already-present server is reused, so this only hits the network once).
// onProgress({ phase, pct, recv, total, msg }) is called throughout.
async function ensureGtacServer(mod, onProgress) {
  const existing = findGtacServerExe(mod);
  if (existing && fs.existsSync(existing)) return { ok: true, serverExe: existing, downloaded: false };

  if (!mod.serverUrl) throw new Error('No server download URL configured for this mod.');
  const emit = onProgress || (() => {});
  const dir = gtacServerDir(mod);
  fs.mkdirSync(dir, { recursive: true });
  const tempRoot = path.join(app.getPath('temp'), `ninogames-gtac-server-${Date.now()}`);
  const zipPath = path.join(tempRoot, 'server.zip');

  emit('downloading', { pct: 0, msg: 'Downloading the GTA Connected server…' });
  let lastPct = -1;
  await downloadFileSimple(mod.serverUrl, zipPath, (recv, total) => {
    const pct = total > 0 ? Math.round((recv / total) * 100) : 0;
    if (pct !== lastPct) { lastPct = pct; emit('downloading', { pct, recv, total }); }
  });

  emit('extracting', { pct: 100, msg: 'Extracting the GTA Connected server…' });
  await extractArchive(zipPath, dir, msg => emit('extracting', { msg }));
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}

  const serverExe = findGtacServerExe(mod);
  if (!serverExe) throw new Error('The server downloaded, but its executable could not be found in the extracted package. Try again, or extract GTAC-Server-Win32 manually and check the log.');
  return { ok: true, serverExe, downloaded: true };
}

// ── Surgical XML settings editing ─────────────────────────────
// Both RageCoop's client and its dedicated server keep their configuration in
// a flat XML file that they rewrite themselves. We only ever want to change a
// couple of values (the host address, the anti-spam kicker) and leave every
// other setting — including anything the user edited by hand — exactly as it
// was, so each field is replaced in place rather than regenerating the file.
function upsertXmlField(xml, field, value, root) {
  const esc = String(value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  if (xml && new RegExp(`<${field}\\s*/>`).test(xml)) {
    // Self-closing empty element, e.g. <ServerKey />
    return xml.replace(new RegExp(`<${field}\\s*/>`), `<${field}>${esc}</${field}>`);
  }
  if (xml && new RegExp(`<${field}>`).test(xml)) {
    return xml.replace(
      new RegExp(`<${field}>[\\s\\S]*?</${field}>`),
      `<${field}>${esc}</${field}>`
    );
  }
  if (xml && /<\/[A-Za-z.]+>\s*$/.test(xml)) {
    // Present file that has never carried this field — add it before the
    // closing root tag rather than throwing the user's config away.
    return xml.replace(/<\/([A-Za-z.]+)>(\s*)$/, `  <${field}>${esc}</${field}>\n</$1>$2`);
  }
  return `<?xml version="1.0" encoding="utf-8"?>\n<${root || 'Settings'}>\n`
       + `  <${field}>${esc}</${field}>\n</${root || 'Settings'}>\n`;
}

function writeXmlFields(target, fields, root) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  let xml = null;
  try { xml = fs.readFileSync(target, 'utf8'); } catch { /* first run */ }
  for (const [k, v] of Object.entries(fields)) xml = upsertXmlField(xml, k, v, root);
  fs.writeFileSync(target, xml, 'utf8');
  return xml;
}

// Renders server.xml from the mod's serverTpl, substituting the GUI fields
// the host set (maxplayers) plus the party port. Only the placeholders that
// actually appear in the template are filled in; everything else in the
// template is literal config. Values are XML-escaped so a malicious value
// can't break the file.
function renderGtacServerXml(mod, fields) {
  const tpl = mod.party && mod.party.serverTpl;
  if (!tpl) throw new Error('No server XML template configured for this mod.');
  const f = fields || {};
  const defaults = { maxplayers: 16, port: 22000 };
  const map = {
    maxplayers: String(f.maxplayers != null ? f.maxplayers : defaults.maxplayers),
    port:       String(f.port != null ? f.port : defaults.port),
  };
  return tpl.replace(/\{(\w+)\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(map, k) ? map[k] : m));
}

// Host: spins up the GTAC dedicated server (downloading it on first use),
// writes server.xml from the party GUI fields, then launches the host's own
// client against it over the loopback once the server has had time to boot.
ipcMain.handle('party-host-gtac-server', async (_e, { modId, fields }) => {
  const st = party.getState();
  if (st.role !== 'host' || st.status !== 'connected') {
    return { error: st.status === 'error' && st.error ? st.error : 'You need to create a party first.' };
  }
  const defs = loadMultiplayerModDefs();
  const mod = defs.find(m => m.id === modId);
  const partyCfg = (mod && mod.party) || {};
  if (!partyCfg || partyCfg.mode !== 'gtac') return { error: 'This mod does not use a GTA Connected server.' };

  const entry = store.getMultiplayerMod(modId);
  const clientExe = entry && entry.exePath;
  if (!clientExe || !fs.existsSync(clientExe)) {
    return { error: 'Install the GTA Connected client first (Multiplayer tab), then come back and start the party.' };
  }

  const emit = (phase, extra) => sendMain('gtac-server-progress', { modId, phase, ...extra });
  try {
    emit('checking', { msg: 'Preparing the GTA Connected server…' });
    const { serverExe } = await ensureGtacServer(mod, emit);

    emit('config', { msg: 'Writing server.xml…' });
    const port = (fields && fields.port) || partyCfg.port || 22000;
    // port no longer has a GUI field — fold it in from the mod config so the
    // XML's <port>/<httpport> always match the port we advertise on the LAN.
    fs.writeFileSync(path.join(gtacServerDir(mod), 'server.xml'), renderGtacServerXml(mod, { ...(fields || {}), port }), 'utf8');

    emit('launching', { msg: 'Starting the server…' });
    // Kill any server from a previous GTAC session first, so re-clicking Start
    // never leaves a stale process bound to the port.
    stopGtacServer();

    // Launch the GTAC server exactly like a double-click would: in its own
    // window, NOT headless and NOT elevated. stdio:'ignore' + detached hid the
    // server console; Start-Process (ShellExecute) opens it normally in a fresh
    // console window on the host's desktop and returns immediately. -PassThru
    // hands back the PID so we can stop it when the party leaves/switches game.
    const pid = await new Promise((resolve, reject) => {
      const safeExe = serverExe.replace(/'/g, "''");
      const safeCwd = path.dirname(serverExe).replace(/'/g, "''");
      const psCmd = `$p = Start-Process -FilePath '${safeExe}' -WorkingDirectory '${safeCwd}' -PassThru -ErrorAction Stop; Write-Output $p.Id`;
      const proc = cp.spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', psCmd], { windowsHide: true });
      let out = '';
      proc.stdout.on('data', d => { out += d.toString(); });
      proc.on('error', reject);
      proc.on('close', code => (code === 0
        ? resolve((out.match(/\d+/) || [])[0] ? parseInt((out.match(/\d+/) || [])[0], 10) : null)
        : reject(new Error('The GTA Connected server could not be started. If a previous server is still running, close it and try again.'))));
    });
    if (!pid) throw new Error('The GTA Connected server started, but its process ID could not be captured — it won\'t be tracked for shutdown.');
    gtacServerPid = pid;

    // Give the server a moment to bind its port and load the freeroam
    // resource before the host's own client connects on loopback.
    setTimeout(() => {
      try {
        const uri = partyCfg.connectTpl.replace('{ip}', '127.0.0.1').replace('{port}', String(port));
        const cc = cp.spawn(clientExe, [uri], { detached: true, stdio: 'ignore', cwd: path.dirname(clientExe) });
        cc.unref();
      } catch (e) {
        console.warn('[party] failed to launch GTAC host client:', e.message);
      }
    }, 8000);

    emit('done', { msg: 'Server started.' });
    return { ok: true, ip: party.HOST_IP, port, serverExe };
  } catch (err) {
    emit('failed', { msg: err.message });
    return { error: err.message };
  }
});

// Host: launches the selected mod as a listen server on the virtual LAN.
ipcMain.handle('party-start-host-game', (_e, arg) => {
  // Older callers pass a bare modId; the host-settings form passes
  // { modId, fields } so the server config can be built from the GUI.
  const modId  = (arg && typeof arg === 'object') ? arg.modId : arg;
  const fields = (arg && typeof arg === 'object' && arg.fields) ? arg.fields : {};
  const st = party.getState();
  if (st.role !== 'host' || st.status !== 'connected') {
    const detail = st.status === 'error' && st.error ? st.error : 'You need to create a party first.';
    return { error: detail };
  }
  // Switching to a different game ends any GTA Connected server we started.
  if (modId !== 'gtac') stopGtacServer();
  const entry = store.getMultiplayerMod(modId);
  if (!entry || !entry.exePath || !fs.existsSync(entry.exePath)) {
    return { error: 'That mod is not installed yet.' };
  }
  const defs = loadMultiplayerModDefs();
  const mod = defs.find(m => m.id === modId);
  const partyCfg = (mod && mod.party) || {};
  const port = partyCfg.port || 28960;
  // Mods that ship a separate dedicated server executable (RageCoop) rather
  // than hosting from the game client itself. The server is configured through
  // its own XML file, so patch that before starting it, then point the host's
  // own client at the loopback the same way a joiner is pointed at the host.
  if (partyCfg.serverExe) {
    const gameDir   = path.dirname(entry.exePath);
    const serverDir = path.join(gameDir, ...String(partyCfg.serverDir || '.').split(/[\\/]/));
    const serverExe = path.join(serverDir, partyCfg.serverExe);
    if (!fs.existsSync(serverExe)) {
      return { error: `${partyCfg.serverExe} is missing — reinstall the mod to restore the server files.` };
    }

    try {
      const settingsName = partyCfg.serverSettingsFile || 'Settings.xml';
      const tmpl = partyCfg.serverSettings || {};
      const resolved = {};
      for (const [k, v] of Object.entries(tmpl)) {
        resolved[k] = String(v)
          .replace('{port}', String(port))
          .replace('{ip}', party.HOST_IP);
      }

      // Values from the host-settings form, validated against the schema the
      // mod declares. Anything not in that schema is ignored, so the renderer
      // can't be used to write arbitrary keys into the server config — and the
      // forced settings above (KickSpamming and friends) stay forced, since a
      // field is only accepted if the mod actually declared it.
      for (const def of (partyCfg.serverFields || [])) {
        if (!Object.prototype.hasOwnProperty.call(fields, def.key)) continue;
        const raw = fields[def.key];
        if (def.type === 'bool') {
          resolved[def.key] = raw ? 'true' : 'false';
        } else if (def.type === 'number') {
          let n = Number(raw);
          if (!Number.isFinite(n)) continue;
          n = Math.round(n);
          if (def.min != null) n = Math.max(def.min, n);
          if (def.max != null) n = Math.min(def.max, n);
          resolved[def.key] = String(n);
        }
      }

      writeXmlFields(path.join(serverDir, settingsName), resolved, 'Settings');
    } catch (err) {
      return { error: `Could not write the server config: ${err.message}` };
    }

    let serverProc;
    try {
      serverProc = cp.spawn(serverExe, [], { detached: true, stdio: 'ignore', cwd: serverDir });
      serverProc.unref();
    } catch (err) {
      return { error: `Could not start the server: ${err.message}` };
    }

    // Point the host's own client at the local server, then start the game
    // once the server has had a moment to bind its port.
    if (partyCfg.presetFile) {
      try {
        const target = path.join(gameDir, ...String(partyCfg.presetFile).split(/[\\/]/));
        writeXmlFields(
          target,
          { [partyCfg.presetField || 'LastServerAddress']: `127.0.0.1:${port}` },
          partyCfg.presetRoot || 'Settings'
        );
      } catch (err) {
        return { error: `Server started, but the address could not be set: ${err.message}` };
      }
    }

    setTimeout(() => {
      try {
        const clientProc = cp.spawn(entry.exePath, [], { detached: true, stdio: 'ignore', cwd: gameDir });
        clientProc.unref();
      } catch (e) {
        console.warn('[party] failed to launch host client:', e.message);
      }
    }, partyCfg.serverWarmupMs || 5000);

    return {
      ok: true, ip: party.HOST_IP, port, server: true,
      hint: partyCfg.hostHint || `Server running on ${party.HOST_IP}:${port}. Press F9 in game and hit Connect.`,
    };
  }

  const rawArgs = partyCfg.hostArgs || [];
  const args = rawArgs.map(a => String(a).replace('{port}', port).replace('{ip}', party.HOST_IP));

  try {
    const cwd = path.dirname(entry.exePath);
    // Launch the dedicated server (headless, no window)
    const serverProc = cp.spawn(entry.exePath, args, { detached: true, stdio: 'ignore', cwd });
    serverProc.unref();

    // Also launch a client instance that connects to the local dedicated server.
    // Give the server ~8 seconds to start up and load the first map before the
    // client tries to connect. 3s was too short on slower machines — iw4x needs
    // time to decompress zone files and load the map geometry before it accepts
    // incoming connections.
    const clientArgs = partyCfg.hostClientArgs
      ? partyCfg.hostClientArgs.map(a => String(a).replace('{port}', port).replace('{ip}', '127.0.0.1'))
      : ['+connect', `127.0.0.1:${port}`];
    setTimeout(() => {
      try {
        const clientProc = cp.spawn(entry.exePath, clientArgs, { detached: true, stdio: 'ignore', cwd });
        clientProc.unref();
      } catch (e) {
        console.warn('[party] failed to launch host client:', e.message);
      }
    }, 8000);

    return { ok: true, ip: party.HOST_IP, port };
  } catch (err) {
    return { error: err.message };
  }
});

// ── Local game launch (devmap/listen-server) for party-capable mods ──
// Launches the mod's client with a single process using +devmap so it
// hosts a private local game directly on the virtual LAN — the most
// reliable approach. No separate dedicated server process to babysit.
// Command form (per-mod devmapArgs template, supports {port} {map}
// {timelimit} {scorelimit} placeholders):
//   iw4x:   iw4x.exe -nointro -console +set scr_war_timelimit <t>
//          +set scr_war_scorelimit <s> +devmap <map>
ipcMain.handle('iw4x-launch-devmap', (_e, { modId, map, timelimit, scorelimit }) => {
  // Starting a listen-server match ends any GTA Connected server we started.
  stopGtacServer();
  const entry = store.getMultiplayerMod(modId || 'iw4x');
  if (!entry || !entry.exePath || !fs.existsSync(entry.exePath)) {
    return { error: 'That mod is not installed. Please install it first.' };
  }
  const defs = loadMultiplayerModDefs();
  const mod  = defs.find(m => m.id === (modId || 'iw4x'));
  const partyCfg = (mod && mod.party) || {};

  const selectedMap   = map        || partyCfg.defaultMap        || 'mp_rust';
  const selectedTime  = timelimit  != null ? timelimit  : (partyCfg.defaultTimelimit  ?? 0);
  const selectedScore = scorelimit != null ? scorelimit : (partyCfg.defaultScorelimit ?? 250);
  const port          = partyCfg.port        || 28960;

  // Build args from devmapArgs template if present, else fall back to hard-coded form
  let args;
  if (partyCfg.devmapArgs && Array.isArray(partyCfg.devmapArgs)) {
    args = partyCfg.devmapArgs.map(a =>
      String(a)
        .replace('{port}',       String(port))
        .replace('{map}',        selectedMap)
        .replace('{timelimit}',  String(selectedTime))
        .replace('{scorelimit}', String(selectedScore))
    );
  } else {
    args = [
      '-nointro', '-console',
      '+set', 'scr_war_timelimit',  String(selectedTime),
      '+set', 'scr_war_scorelimit', String(selectedScore),
      '+devmap', selectedMap,
    ];
  }

  try {
    const cwd  = path.dirname(entry.exePath);
    const proc = cp.spawn(entry.exePath, args, { detached: true, stdio: 'ignore', cwd });
    proc.unref();
    return { ok: true, map: selectedMap, timelimit: selectedTime, scorelimit: selectedScore };
  } catch (err) {
    return { error: err.message };
  }
});

// Client: launches the mod and auto-connects to the host over the virtual LAN.
ipcMain.handle('party-join-game', (_e, modId) => {
  const st = party.getState();
  if (st.status !== 'connected') {
    const detail = st.status === 'error' && st.error ? st.error : 'You need to join a party first.';
    return { error: detail };
  }
  const entry = store.getMultiplayerMod(modId);
  if (!entry || !entry.exePath || !fs.existsSync(entry.exePath)) {
    return { error: 'That mod is not installed yet.' };
  }
  const defs = loadMultiplayerModDefs();
  const mod = defs.find(m => m.id === modId);
  const partyCfg = (mod && mod.party) || {};
  const port = partyCfg.port || 28960;

  // GTA Connected-style mods connect through a URI scheme (gtac://connect/…)
  // instead of command-line connect flags — the client Launcher parses it.
  if (partyCfg.connectTpl) {
    const uri = String(partyCfg.connectTpl).replace('{ip}', party.HOST_IP).replace('{port}', String(port));
    try {
      const cwd = path.dirname(entry.exePath);
      const proc = cp.spawn(entry.exePath, [uri], { detached: true, stdio: 'ignore', cwd });
      proc.unref();
      return { ok: true, ip: party.HOST_IP, port, uri };
    } catch (err) {
      return { error: err.message };
    }
  }

  // Some mods have no connect argument at all — RageCoop is an in-game F9
  // menu, and GTA V itself takes no "join this server" flag. What its client
  // does read on startup is its settings XML, so write the host's address in
  // there before launching. The player still opens the menu and hits Connect,
  // but the address is already filled in with the party host rather than
  // having to be typed from whatever someone read out over voice chat.
  if (partyCfg.presetFile) {
    const gameDir = path.dirname(entry.exePath);
    const target  = path.join(gameDir, ...String(partyCfg.presetFile).split(/[\\/]/));
    const value   = String(partyCfg.presetValue || '{ip}:{port}')
      .replace('{ip}', party.HOST_IP).replace('{port}', String(port));
    const field   = partyCfg.presetField || 'LastServerAddress';

    try {
      writeXmlFields(target, { [field]: value }, partyCfg.presetRoot || 'Settings');
    } catch (err) {
      return { error: `Could not set the server address: ${err.message}` };
    }

    try {
      const proc = cp.spawn(entry.exePath, [], { detached: true, stdio: 'ignore', cwd: gameDir });
      proc.unref();
      return {
        ok: true, ip: party.HOST_IP, port, preset: true,
        hint: partyCfg.joinHint || `Press F9 in game and hit Connect — ${party.HOST_IP}:${port} is already filled in.`,
      };
    } catch (err) {
      return { error: err.message };
    }
  }

  const rawArgs = partyCfg.joinArgs || ['+connect', '{ip}:{port}'];
  const args = rawArgs.map(a => String(a).replace('{port}', port).replace('{ip}', party.HOST_IP));

  try {
    const cwd = path.dirname(entry.exePath);
    const proc = cp.spawn(entry.exePath, args, { detached: true, stdio: 'ignore', cwd });
    proc.unref();
    return { ok: true, ip: party.HOST_IP, port };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('uninstall-multiplayer-mod', async (_e, modId) => {
  const entry = store.getMultiplayerMod(modId);
  const defs  = loadMultiplayerModDefs();
  const mod   = defs.find(m => m.id === modId);

  // GTA Connected keeps its client and server OUTSIDE the game folder, so the
  // generic gameDir-based cleanup below can't remove them. Give it its own
  // uninstall pass (kill processes, remove folders, shortcuts, registry).
  if (mod && mod.installType === 'gta-connected') {
    await uninstallGtac(mod);
    store.removeMultiplayerMod(modId);
    return { ok: true };
  }

  // Kill the mod's process before touching any files on disk. This has to
  // happen unconditionally — regardless of whether NinoGames' own bookkeeping
  // thinks the mod "installed" successfully or not, and even if `entry` is
  // missing entirely (e.g. a previous install attempt crashed after writing
  // files but before recording state). Otherwise a still-running iw4x.exe
  // holds its own exe/dll open and every fs.rmSync below for those files
  // silently no-ops, leaving the mod folder behind even though the app
  // reports "uninstalled".
  if (process.platform === 'win32') {
    const imageNames = new Set([
      mod && mod.launchExe,
      entry && entry.exePath ? path.basename(entry.exePath) : null,
    ].filter(Boolean));
    for (const imageName of imageNames) {
      await new Promise(resolve => {
        cp.exec(`taskkill /F /IM "${imageName}"`, () => resolve());
      });
    }
    // Give the OS a moment to actually release the file handles after the
    // process dies before we try to delete anything.
    await new Promise(r => setTimeout(r, 500));
  }

  // Actually delete the files this mod put on disk, not just NinoGames'
  // bookkeeping of it. We only know the exact footprint for mods that
  // declare uninstallFiles/uninstallDirs in multiplayermod.json (e.g. IW4x) —
  // for anything else we fall back to removing the recorded exe only, since
  // guessing at an unknown mod's full footprint risks deleting the wrong
  // thing (or, for installer-based mods like CoD4x, leaving behind broken
  // registry/uninstaller state that only its own uninstaller can clean up).
  // Exception: 'manifest' mods (e.g. CoD4x via the CB Servers CDN) DO know
  // their exact footprint — it's whatever the manifest lists — so for those
  // we re-fetch it and delete every file it names, rather than falling back
  // to "just the recorded exe".
  if (entry && entry.gameId) {
    const gameEntry = store.getLibraryEntry(entry.gameId);
    if (gameEntry && gameEntry.installDir && fs.existsSync(gameEntry.installDir)) {
      const gameDir = mod && mod.gameExeHints
        ? resolveGameDir(gameEntry.installDir, mod.gameExeHints)
        : gameEntry.installDir;

      // Never delete the base game's own executable. Mods like CoD2x patch the
      // stock exe in place instead of shipping their own, so entry.exePath can
      // point at a file that belongs to the game — deleting it on uninstall
      // destroys the game's multiplayer rather than just removing the mod.
      const stockExes = new Set(
        ((mod && mod.gameExeHints) || []).map(h => String(h).toLowerCase().replace(/\.exe$/, ''))
      );
      const isStockGameExe = f =>
        stockExes.has(path.basename(String(f)).toLowerCase().replace(/\.exe$/, ''));

      if (mod && mod.installType === 'manifest' && mod.manifestUrl) {
        try {
          const manifestRaw = await new Promise((resolve, reject) => {
            const req = net.request({ url: mod.manifestUrl, method: 'GET', redirect: 'follow' });
            req.setHeader('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
            let body = '';
            req.on('response', res => {
              if (res.statusCode >= 400) return reject(new Error(`Manifest fetch failed: HTTP ${res.statusCode}`));
              res.on('data', c => { body += c.toString(); });
              res.on('end', () => resolve(body));
            });
            req.on('error', reject);
            req.end();
          });
          const manifest = JSON.parse(manifestRaw);
          if (Array.isArray(manifest)) {
            // Delete deepest files first, then walk back up removing any
            // directories the sync created that are now empty (but never
            // touch gameDir itself, since that's the base game's folder).
            const dirsToCheck = new Set();
            for (const e of manifest) {
              const name = e && e[0];
              if (!name) continue;
              const parts = name.split('/');
              if (isStockGameExe(name)) continue;
              const dest = path.join(gameDir, ...parts);
              try { fs.rmSync(dest, { force: true }); } catch {}
              for (let i = parts.length - 1; i > 0; i--) {
                dirsToCheck.add(path.join(gameDir, ...parts.slice(0, i)));
              }
            }
            // Longest paths (most nested) first, so child dirs empty out
            // before their parents are checked.
            const sortedDirs = [...dirsToCheck].sort((a, b) => b.length - a.length);
            for (const dir of sortedDirs) {
              try {
                if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
              } catch {}
            }
          }
        } catch (err) {
          console.warn('[multiplayer] manifest re-fetch for uninstall failed, falling back to exe-only removal:', err.message);
        }
      }

      const files = new Set([
        ...((mod && mod.uninstallFiles) || []),
        entry.exePath ? path.basename(entry.exePath) : null,
      ].filter(Boolean));
      for (const f of files) {
        if (isStockGameExe(f)) continue;
        try { fs.rmSync(path.join(gameDir, f), { force: true }); } catch {}
      }

      for (const d of ((mod && mod.uninstallDirs) || [])) {
        try { fs.rmSync(path.join(gameDir, d), { recursive: true, force: true }); } catch {}
      }
    }
  }

  store.removeMultiplayerMod(modId);
  return { ok: true };
});

let partyTeardownDone = false;
app.on('will-quit', e => {
  globalShortcut.unregisterAll();
  stopGtacServer();
  if (partyTeardownDone) return;

  // Nothing to tear down — let the quit through without the extra round trip.
  const st = party.getState();
  if (!st || (st.status === 'idle' && !st.role)) { partyTeardownDone = true; return; }

  // Hold the quit open just long enough to stop the elevated core, then quit
  // for real. Capped so a hung/denied elevation can never wedge the app shut.
  e.preventDefault();
  const finish = () => {
    if (partyTeardownDone) return;
    partyTeardownDone = true;
    app.quit();
  };
  const guard = setTimeout(finish, 12000);
  party.leaveParty()
    .catch(err => console.warn('[party] teardown on quit failed:', err && err.message))
    .finally(() => { clearTimeout(guard); finish(); });
});

// ── Disk space check ──────────────────────────────────────────
// Returns the free bytes available on the drive that contains the install path.
// ── Run 7-Zip elevated (UAC prompt for 7zip/PowerShell only) ──
ipcMain.handle('run-7zip-elevated', async (_e, { zipPath: zp, destDir: dd }) => {
  if (process.platform !== 'win32') return { ok: false, error: 'Not Windows' };
  const sevenZipPath = get7ZipPath();
  if (!fs.existsSync(sevenZipPath)) return { ok: false, error: '7-Zip not found' };

  const sevenZipEsc = sevenZipPath.replace(/'/g, "''");
  const zipEsc      = zp.replace(/'/g, "''");
  const destEsc     = dd.replace(/'/g, "''");

  // -RedirectStandardOutput/Error cannot be combined with -Verb RunAs (Windows limitation)
  const psCmd = `$p=Start-Process -FilePath '${sevenZipEsc}' -ArgumentList 'x','${zipEsc}','-o${destEsc}','-y' -Verb RunAs -Wait -PassThru -WindowStyle Hidden;exit $p.ExitCode`;

  return new Promise(resolve => {
    const ps = cp.spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', psCmd]);
    ps.on('error', err => resolve({ ok: false, error: err.message }));
    ps.on('close', code => {
      if (code === 0) resolve({ ok: true });
      else resolve({ ok: false, error: `7-Zip elevated exited with code ${code}`, uacCancelled: code === 1 });
    });
  });
});

ipcMain.handle('check-disk-space', async () => {
  try {
    const installPath = getInstallDir();
    // Use the drive root on Windows, otherwise the path itself on Unix
    const checkPath = process.platform === 'win32'
      ? installPath.slice(0, 3)  // e.g. "C:\"
      : installPath;

    // Use PowerShell on Windows; df on Unix
    if (process.platform === 'win32') {
      const driveLetter = checkPath[0].toUpperCase();
      const ps = `(Get-PSDrive ${driveLetter}).Free`;
      const result = cp.execSync(`powershell -NoProfile -NonInteractive -Command "${ps}"`, {
        encoding: 'utf8', timeout: 5000,
      }).trim();
      const free = parseInt(result, 10);
      return { free, path: checkPath };
    } else {
      // df -k gives 1K blocks; multiply by 1024
      const result = cp.execSync(`df -k "${checkPath}" | tail -1`, {
        encoding: 'utf8', timeout: 5000,
      });
      const parts = result.trim().split(/\s+/);
      const freeKb = parseInt(parts[3], 10);
      return { free: freeKb * 1024, path: checkPath };
    }
  } catch (err) {
    return { free: null, error: err.message };
  }
});

// ── Verify Install ─────────────────────────────────────────────
// HEAD the stored fileUrl to get current Content-Length,
// walk installDir to get on-disk size, and compare.
ipcMain.handle('verify-install', async (_e, gameId) => {
  const entry = store.getLibraryEntry(gameId);
  if (!entry) return { error: 'Game not found in library.' };
  if (entry.status !== 'installed') return { error: 'Game is not installed.' };

  const { installDir, fileUrl, refererUrl, zipSize: storedZipSize, installedSize } = entry;

  // ── Step 1: check installDir exists on disk ───────────────
  if (!installDir || !fs.existsSync(installDir)) {
    return {
      verdict: 'missing',
      detail: 'Install folder not found on disk.',
      installDir,
    };
  }

  // ── Step 2: sum all files in installDir ───────────────────
  function dirSize(dir) {
    let total = 0;
    try {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          total += dirSize(full);
        } else if (ent.isFile()) {
          try { total += fs.statSync(full).size; } catch {}
        }
      }
    } catch {}
    return total;
  }
  const diskSize = dirSize(installDir);

  // ── Step 3: HEAD the stored download URL to get live size ─
  // This tells us both the current server file size (for update detection)
  // AND gives us the definitive zip byte-count to compare against disk usage.
  let serverZipSize = null;
  let headError     = null;

  if (fileUrl) {
    try {
      serverZipSize = await new Promise((resolve, reject) => {
        const req = net.request({ method: 'HEAD', url: fileUrl });
        req.setHeader('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
        if (refererUrl) req.setHeader('Referer', refererUrl);
        const timer = setTimeout(() => { req.abort(); reject(new Error('HEAD request timed out')); }, 10000);
        req.on('response', res => {
          clearTimeout(timer);
          const cl = parseInt(res.headers['content-length'] || '0', 10);
          resolve(cl > 0 ? cl : null);
        });
        req.on('error', err => { clearTimeout(timer); reject(err); });
        req.end();
      });
    } catch (err) {
      headError = err.message;
    }
  } else {
    headError = 'No download URL stored — re-download from the store to enable server checks';
  }

  // ── Step 4: determine verdict ─────────────────────────────
  // Priority for corruption check:
  //   1. installedSize — folder size measured immediately after extraction (most reliable).
  //      If current disk is < 90% of this, files have been deleted/corrupted.
  //   2. serverZipSize / storedZipSize — zip byte count fallback for older installs.
  //      Extracted folder should always exceed zip size.

  const zipChanged = serverZipSize && storedZipSize && serverZipSize !== storedZipSize;

  let corrupt = false;
  let corruptReason = null;

  if (installedSize && installedSize > 0) {
    // Ground-truth: compare against size measured right after installation
    if (diskSize < installedSize * 0.9) {
      corrupt = true;
      corruptReason = `${fmtBytes(diskSize)} on disk vs ${fmtBytes(installedSize)} at install time`;
    }
  } else {
    // Fallback: extracted files should always be larger than the zip
    const referenceZipSize = serverZipSize || storedZipSize || null;
    if (referenceZipSize && diskSize < referenceZipSize * 0.9) {
      corrupt = true;
      corruptReason = `${fmtBytes(diskSize)} on disk is less than the ${fmtBytes(referenceZipSize)} zip`;
    }
  }

  let verdict;
  if (!installDir || !fs.existsSync(installDir)) {
    verdict = 'missing';
  } else if (corrupt) {
    verdict = 'corrupt';
  } else if (zipChanged) {
    verdict = 'outdated';
  } else {
    verdict = 'ok';
  }

  return {
    verdict,
    diskSize,
    installedSize: installedSize || null,
    serverZipSize,
    storedZipSize: storedZipSize || null,
    corruptReason: corruptReason || null,
    zipChanged,
    headError: headError || null,
    installDir,
    fileUrl: fileUrl || null,
  };
});

// ── Auto-updater ───────────────────────────────────────────────
// ── Auto-updater ─────────────────────────────────────────────
const APP_VERSION     = require('./package.json').version;
// Point this at your raw version.json on GitHub or any static host:
// e.g. https://raw.githubusercontent.com/yourname/ninogames/main/version.json
const VERSION_JSON_URL = 'https://raw.githubusercontent.com/summitrp/NinoGames/main/version.json';

ipcMain.handle('get-app-version', () => APP_VERSION);

// ── Install Common Redistributables ───────────────────────────────────────
ipcMain.handle('install-redistributables', async (event) => {
  const packages = [
    'Microsoft.DotNet.DesktopRuntime.6',
    'Microsoft.DotNet.DesktopRuntime.8',
    'Microsoft.VCRedist.2005.x86',
    'Microsoft.VCRedist.2005.x64',
    'Microsoft.VCRedist.2008.x86',
    'Microsoft.VCRedist.2008.x64',
    'Microsoft.VCRedist.2010.x86',
    'Microsoft.VCRedist.2010.x64',
    'Microsoft.VCRedist.2012.x86',
    'Microsoft.VCRedist.2012.x64',
    'Microsoft.VCRedist.2013.x86',
    'Microsoft.VCRedist.2013.x64',
    'Microsoft.VCRedist.2015+.x86',
    'Microsoft.VCRedist.2015+.x64',
    'Microsoft.XNARedist',
    'Oracle.JavaRuntimeEnvironment',
  ];

  const total = packages.length;

  for (let i = 0; i < total; i++) {
    const pkg = packages[i];
    event.sender.send('redist-progress', {
      current: i,
      total,
      package: pkg,
      pct: Math.round((i / total) * 100),
    });

    await new Promise((resolve) => {
      const args = [
        'install',
        '--id', pkg,
        '--silent',
        '--accept-package-agreements',
        '--accept-source-agreements',
      ];
      const proc = cp.spawn('winget', args, { shell: true, windowsHide: true });
      proc.on('close', () => resolve());
      proc.on('error', () => resolve()); // keep going even if winget errors
    });
  }

  event.sender.send('redist-progress', {
    current: total,
    total,
    package: '',
    pct: 100,
    done: true,
  });

  store.saveSettings({ redistInstalled: true });
  return { ok: true };
});

ipcMain.handle('add-defender-exclusion', async (_e, folderPath) => {
  if (process.platform !== 'win32') {
    return { ok: false, error: 'Not Windows' };
  }

  // This value ends up inside an elevated PowerShell command line. The quote
  // doubling below handles the ordinary case, but a non-string would throw on
  // .replace and a relative or non-existent path is never something we should
  // be excluding — validate rather than trusting whatever arrived over IPC.
  if (typeof folderPath !== 'string' || !path.isAbsolute(folderPath)) {
    return { ok: false, error: 'Invalid folder path' };
  }
  folderPath = path.normalize(folderPath);
  if (!fs.existsSync(folderPath)) {
    return { ok: false, error: 'That folder does not exist' };
  }

  try {
    // Add-MpPreference requires elevation. We use PowerShell's Start-Process
    // with -Verb RunAs so Windows shows the UAC prompt, then wait for the
    // elevated child to finish before resolving.
    await new Promise((resolve, reject) => {
      // The inner command that needs admin rights
      const innerCmd = `Add-MpPreference -ExclusionPath '${folderPath.replace(/'/g, "''")}'`;

      // Outer command: spawn an elevated PowerShell that runs innerCmd and
      // writes its exit code to a temp file so we can read it back.
      const tmpResult = path.join(app.getPath('temp'), `ng-excl-${Date.now()}.txt`);

      const outerCmd = [
        `$job = Start-Process powershell.exe`,
        ` -ArgumentList '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command','${innerCmd.replace(/'/g, "''")}'`,
        ` -Verb RunAs -Wait -PassThru;`,
        `$job.ExitCode | Out-File -FilePath '${tmpResult}' -Encoding ascii`,
      ].join('');

      const proc = cp.spawn('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-Command', outerCmd,
      ], { shell: false, windowsHide: true });

      let stderr = '';
      proc.stderr.on('data', d => { stderr += d.toString(); });

      proc.on('error', reject);
      proc.on('close', (code) => {
        // code here is the outer (non-elevated) process exit code.
        // Read the elevated child's exit code from the temp file.
        try {
          const raw = fs.readFileSync(tmpResult, 'utf8').trim();
          fs.unlinkSync(tmpResult);
          const innerCode = parseInt(raw, 10);
          if (innerCode === 0) resolve();
          else reject(new Error(`Elevated PowerShell exited with code ${innerCode}`));
        } catch {
          // Temp file missing — user likely dismissed the UAC prompt
          if (code === 0) {
            // Outer succeeded but no result file → UAC was cancelled
            reject(new Error('UAC prompt was cancelled or elevation failed'));
          } else {
            reject(new Error(stderr.trim() || `PowerShell exited with code ${code}`));
          }
        }
      });
    });

    return { ok: true };
  } catch (err) {
    console.error('Failed to add Windows Defender exclusion:', err);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('check-for-update', async () => {
  try {
    const body = await new Promise((resolve, reject) => {
      const req = net.request(VERSION_JSON_URL);
      req.setHeader('Cache-Control', 'no-cache');
      let buf = '';
      req.on('response', res => {
        res.on('data', c => buf += c);
        res.on('end', () => resolve(buf));
      });
      req.on('error', reject);
      req.end();
    });
    const info = JSON.parse(body); // { version, notes, url }
    const semver = v => v.replace(/^v/, '').split('.').map(Number);
    const [rM, rm, rp] = semver(info.version);
    const [cM, cm, cp] = semver(APP_VERSION);
    const isNewer = rM > cM || (rM === cM && rm > cm) || (rM === cM && rm === cm && rp > cp);
    return { upToDate: !isNewer, latest: info, current: APP_VERSION };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('apply-update', async (_e, downloadUrl) => {
  // Launch the updater.exe from resources/updater/
  // In packaged builds, process.resourcesPath is the correct resources folder.
  // In dev, fall back to <__dirname>/resources.
  const updaterPath = app.isPackaged
    ? path.join(process.resourcesPath, 'updater', 'updater.exe')
    : path.join(__dirname, 'resources', 'updater', 'updater.exe');

  // Check if updater.exe exists
  if (!fs.existsSync(updaterPath)) {
    throw new Error('Updater not found at: ' + updaterPath);
  }

  // updater.exe requires elevation. Use Start-Process -Verb RunAs so Windows
  // shows a UAC prompt. Do NOT use -NonInteractive or detach the process —
  // both prevent UAC from rendering on the user's desktop.
  const psPath = updaterPath.replace(/'/g, "''");
  const ps = cp.spawn('powershell.exe', [
    '-NoProfile', '-Command',
    `Start-Process '${psPath}' -Verb RunAs`
  ], { stdio: 'ignore', windowsHide: false });

  sendMain('update-progress', { pct: 100, phase: 'done' });

  // Quit once PowerShell has finished launching the updater (or after 10s max)
  const quit = () => { try { app.quit(); } catch {} };
  ps.on('close', () => setTimeout(quit, 5000));
  setTimeout(quit, 15000);
  return { ok: true };
});