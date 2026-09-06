'use strict';

// ── Reveal animation (IntersectionObserver) ───────────────────
// Used by home-page game cards. Cards start invisible and slide in
// when they scroll into view — staggered by their position in the
// grid for a cascade effect.
const _revealObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (!entry.isIntersecting) return;
    const el = entry.target;
    // Small stagger based on the element's index in its parent
    const siblings = el.parentElement ? [...el.parentElement.children] : [];
    const idx = siblings.indexOf(el);
    const delay = Math.min(idx * 45, 300); // cap at 300ms
    setTimeout(() => {
      el.style.opacity = '1';
      el.style.transform = 'none';
    }, delay);
    _revealObserver.unobserve(el);
  });
}, { threshold: 0.08 });

function _observeReveal(el) {
  _revealObserver.observe(el);
}

// ── State ─────────────────────────────────────────────────────
const appState = {
  currentPage: 'home',
  prevPage:    'home',
  searchQuery: '', searchPage: 1, isLoading: false, hasMore: true, totalGames: 0,
  currentGame: null,
  gamePageInfo: null,
  downloads: {},
  library: [],
  libTab: 'downloading',
  settings: {},
  dlStartTimes: {},
};

const $ = id => document.getElementById(id);
const q = (sel, ctx) => (ctx || document).querySelector(sel);

function openCarouselFullscreen(src, allSrcs) {
  let idx = allSrcs.indexOf(src);
  const overlay = document.createElement('div');
  overlay.id = 'fs-overlay';

  function render() {
    overlay.innerHTML = `
      <button class="fs-nav fs-prev">&#8249;</button>
      <img src="${escapeHtml(safeUrl(allSrcs[idx]))}" alt="Screenshot"/>
      <button class="fs-nav fs-next">&#8250;</button>
      <button id="fs-close">&#10005;</button>
      <div id="fs-counter">${idx + 1} / ${allSrcs.length}</div>`;
    overlay.querySelector('.fs-prev').addEventListener('click', e => { e.stopPropagation(); idx = (idx - 1 + allSrcs.length) % allSrcs.length; render(); });
    overlay.querySelector('.fs-next').addEventListener('click', e => { e.stopPropagation(); idx = (idx + 1) % allSrcs.length; render(); });
    overlay.querySelector('#fs-close').addEventListener('click', () => cleanup());
  }

  function onKey(e) {
    if (e.key === 'ArrowLeft')  { idx = (idx - 1 + allSrcs.length) % allSrcs.length; render(); }
    if (e.key === 'ArrowRight') { idx = (idx + 1) % allSrcs.length; render(); }
    if (e.key === 'Escape') cleanup();
  }

  function cleanup() { overlay.remove(); document.removeEventListener('keydown', onKey); }

  overlay.addEventListener('click', e => { if (e.target === overlay) cleanup(); });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(overlay);
  render();
}

const btnMin   = $('btn-min');
const btnMax   = $('btn-max');
const btnClose = $('btn-close');
const sbBtns   = document.querySelectorAll('.sb-btn');
const searchInput  = $('search-input');
const searchBtn    = $('search-btn');
const gameGrid     = $('game-grid');
const resultsLabel = $('results-label');
const loadMoreBtn  = $('load-more-btn');
const loadMoreSpin = $('load-more-spin');
const allLoaded    = $('all-loaded');
const libGrid    = $('lib-grid');
let libSort      = 'title';        // sort key for installed tab
let libFilterTxt = '';             // text filter for installed tab
const libEmpty   = $('lib-empty');
const libCount   = $('lib-count');

// ── Money Saved: fetch Steam retail prices via SteamSpy ───────
// Prices are fetched once when a game is added to the library and cached
// permanently — we do NOT re-fetch on every library visit.
const libSizeEl       = $('lib-size');
const libSizeValEl    = $('lib-size-value');
const moneySavedEl    = $('lib-money-saved');
const moneySavedValEl = $('lib-money-saved-value');

function loadPriceCache() {
  try { return JSON.parse(localStorage.getItem('ninogames-price-cache') || '{}'); } catch { return {}; }
}
function savePriceCache(cache) {
  try { localStorage.setItem('ninogames-price-cache', JSON.stringify(cache)); } catch {}
}

let _moneySavedCache = loadPriceCache();

// Fetch price for a single title and persist it — safe to call multiple times
// because it short-circuits immediately when the cache already has a value.
async function fetchAndCacheGamePrice(title) {
  const key = title.toLowerCase().trim();
  if (_moneySavedCache[key] !== undefined) return _moneySavedCache[key];
  try {
    const price = await window.api.fetchGamePrice(title);
    _moneySavedCache[key] = price;
    savePriceCache(_moneySavedCache);
    return price;
  } catch {
    _moneySavedCache[key] = null;
    return null;
  }
}

// Fetch prices for any installed games that don't yet have a cached price.
// Called after a game is added to the library, not on every library visit.
async function fetchMissingPrices() {
  const installedGames = (appState.library || []).filter(e => e.status === 'installed');
  const uncached = installedGames.filter(e => {
    const mapped = applyFixMapping(e);
    const t = mapped.title;
    if (!t || t.startsWith('ag-') || t.startsWith('sr-')) return false;
    return _moneySavedCache[t.toLowerCase().trim()] === undefined;
  });
  for (const entry of uncached) {
    const mapped = applyFixMapping(entry);
    await fetchAndCacheGamePrice(mapped.title);
    // Polite delay between requests
    await new Promise(r => setTimeout(r, 500));
  }
  // Refresh the displayed total now that new prices may have arrived
  renderMoneySaved();
}

// Render the money-saved widget from the in-memory cache (no network call).
function renderMoneySaved() {
  if (!moneySavedEl || !moneySavedValEl) return;
  if (appState.libTab !== 'installed') { moneySavedEl.classList.add('hidden'); return; }
  const installedGames = (appState.library || []).filter(e => e.status === 'installed');
  if (installedGames.length === 0) { moneySavedEl.classList.add('hidden'); return; }
  moneySavedEl.classList.remove('hidden', 'loading');
  let total = 0; let found = 0;
  for (const entry of installedGames) {
    const mapped = applyFixMapping(entry);
    const t = mapped.title;
    if (!t || t.startsWith('ag-') || t.startsWith('sr-')) continue;
    const price = _moneySavedCache[t.toLowerCase().trim()];
    if (price !== null && price !== undefined) { total += price; found++; }
  }
  if (found === 0) {
    moneySavedValEl.textContent = 'N/A';
  } else {
    moneySavedValEl.textContent = `$${total.toFixed(2)}`;
    moneySavedEl.title = `Estimated retail value of ${found} of your ${installedGames.length} installed game${installedGames.length !== 1 ? 's' : ''} (via SteamSpy)`;
  }
}

// scheduleMoneySaved is now just a cheap render from cache — no network I/O.
function scheduleMoneySaved() {
  renderMoneySaved();
  renderLibrarySize();
}

// Total size of the games folder. Main caches the walk for a minute, so this
// is cheap to call on every library render; clicking the pill forces a fresh
// scan for when something was just installed or removed.
async function renderLibrarySize(force) {
  if (!libSizeEl || !libSizeValEl) return;
  if (appState.libTab !== 'installed') { libSizeEl.classList.add('hidden'); return; }
  const installed = (appState.library || []).filter(e => e.status === 'installed');
  if (!installed.length) { libSizeEl.classList.add('hidden'); return; }

  libSizeEl.classList.remove('hidden');
  if (force) { libSizeEl.classList.add('loading'); libSizeValEl.textContent = '…'; }
  try {
    const res = await window.api.getLibrarySize(force ? { force: true } : undefined);
    libSizeValEl.textContent = res && res.bytes ? fmtBytes(res.bytes) : '0 B';
  } catch {
    libSizeValEl.textContent = 'N/A';
  } finally {
    libSizeEl.classList.remove('loading');
  }
}

if (libSizeEl) libSizeEl.addEventListener('click', () => renderLibrarySize(true));

// Force re-fetch all installed game prices (clears cache for installed games first)
async function forceFetchAllPrices() {
  if (!moneySavedEl || !moneySavedValEl) return;
  moneySavedEl.classList.add('loading');
  moneySavedValEl.textContent = '…';
  // Clear cached prices for currently installed games so they get re-fetched
  const installedGames = (appState.library || []).filter(e => e.status === 'installed');
  for (const entry of installedGames) {
    const mapped = applyFixMapping(entry);
    const t = mapped.title;
    if (t && !t.startsWith('ag-') && !t.startsWith('sr-')) {
      delete _moneySavedCache[t.toLowerCase().trim()];
    }
  }
  savePriceCache(_moneySavedCache);
  await fetchMissingPrices();
  moneySavedEl.classList.remove('loading');
}

if (moneySavedEl) {
  moneySavedEl.addEventListener('click', () => forceFetchAllPrices());
}
const detailBannerBg   = $('detail-banner-bg');
const detailCover      = $('detail-cover');
const detailTitle      = $('detail-title');
const detailVersion    = $('detail-version');
const detailDesc       = $('detail-desc');
const detailSizeSpan   = q('#detail-size span');
const detailBack       = $('detail-back');
const detailWish       = $('detail-wish');

// ── Trailer modal ─────────────────────────────────────────────
const detailTrailerBtn     = $('detail-trailer-btn');
const detailTrailerBtnDone = $('detail-trailer-btn-done');
const trailerOverlay       = $('trailer-overlay');
const trailerIframe        = $('trailer-iframe');
const trailerClose         = $('trailer-close');
const trailerTitleBar      = $('trailer-title-bar');

async function openTrailer(videoId, title) {
  const port = await window.api.getTrailerPort();
  const src  = `http://localhost:${port}/trailer.html?v=${encodeURIComponent(videoId)}&title=${encodeURIComponent(title || '')}`;
  trailerIframe.src = src;
  if (trailerTitleBar) trailerTitleBar.textContent = title || '';
  trailerOverlay.classList.remove('hidden');
  trailerOverlay.classList.add('visible');
  document.body.style.overflow = 'hidden';
}

function closeTrailer() {
  trailerOverlay.classList.remove('visible');
  trailerOverlay.classList.add('hidden');
  trailerIframe.src = '';
  document.body.style.overflow = '';
}

if (trailerClose)   trailerClose.addEventListener('click', closeTrailer);
if (trailerOverlay) trailerOverlay.addEventListener('click', e => { if (e.target === trailerOverlay) closeTrailer(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeTrailer(); });

const dlBtn            = $('dl-btn');
const dlCancelBtn      = $('dl-cancel-btn');
const dlCancelBtn2     = $('dl-cancel-btn2');
const dlPauseBtn       = $('dl-pause-btn');
const dlRetryBtn       = $('dl-retry-btn');
const openFolderBtn    = $('open-folder-btn');
const openFolderBtn2   = $('open-folder-btn2');
const openPageBtn      = $('open-page-btn');
const dlBarFill        = $('dl-bar-fill');
const dlProgressPct    = $('dl-progress-pct');
const dlProgressBytes  = $('dl-progress-bytes');
const dlSpeedBadge     = $('dl-speed-badge');
const dlEtaBadge       = $('dl-eta-badge');
const dlProgressTitle  = $('dl-progress-title');
const dlStatusMsg      = $('dl-status-msg');
const dlExtractMsg     = $('dl-extract-msg');
const actionErrorRetry = $('action-error-retry');
const statusText       = $('status-text');
const launchBtn        = $('launch-btn');
const launchBtn2       = $('launch-btn2');
const uninstallBtn     = $('uninstall-btn');

function setStatus(msg) { statusText.textContent = msg; }

// Note the apostrophe: this output lands in single-quoted attributes and inside
// CSS url('...') in several places, so leaving ' unescaped left those contexts
// breakable. The CSP here allows 'unsafe-inline' for scripts, which means an
// injected onerror= would actually run — with window.api in reach.
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// -- URL sanitising -------------------------------------------
// Every image URL this app renders comes from somewhere we do not control:
// scraped game pages, SteamGridDB, mod manifests. Interpolating one straight
// into src="..." or url('...') lets a hostile value close the attribute and
// append its own. Run them through here first; '' is inert in both contexts.
const SAFE_URL_SCHEMES = new Set(['http:', 'https:', 'data:', 'file:', 'blob:']);

function safeUrl(raw) {
  if (typeof raw !== 'string' || !raw) return '';
  let parsed;
  try {
    parsed = new URL(raw.trim(), window.location.href);
  } catch {
    return '';
  }
  if (!SAFE_URL_SCHEMES.has(parsed.protocol)) return '';
  // data: is only acceptable here when it genuinely carries an image.
  if (parsed.protocol === 'data:' && !/^data:image\//i.test(parsed.href)) return '';
  // The URL parser percent-encodes spaces, double quotes, angle brackets and
  // backticks, but it leaves the apostrophe alone. Both callers below happen to
  // handle that (escapeHtml for attributes, safeCssUrl for CSS), but encoding it
  // here means the return value is inert in any context, including a future
  // caller that forgets. %27 is the canonical encoding, so nothing breaks.
  return parsed.href.split("'").join('%27');
}

// For CSS background: url('...'). Percent-encodes the characters that could end
// the string or the url() token; returns 'none' rather than an empty url(),
// which some engines resolve against the current document.
function safeCssUrl(raw) {
  const u = safeUrl(raw);
  if (!u) return 'none';
  const escaped = u
    .split("'").join('%27')
    .split('(').join('%28')
    .split(')').join('%29');
  return "url('" + escaped + "')";
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

function fmtBytes(bytes) {
  if (!bytes) return '0 B';
  const k = 1024, sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

function fmtSpeed(bytesPerSec) {
  if (!bytesPerSec || bytesPerSec < 100) return '';
  if (bytesPerSec > 1024 * 1024) return `${(bytesPerSec / 1024 / 1024).toFixed(1)} MB/s`;
  if (bytesPerSec > 1024) return `${(bytesPerSec / 1024).toFixed(0)} KB/s`;
  return `${bytesPerSec.toFixed(0)} B/s`;
}

function fmtEta(recv, total, speed) {
  if (!speed || !total || recv >= total) return '';
  const secs = (total - recv) / speed;
  if (secs < 60) return `~${Math.ceil(secs)}s left`;
  if (secs < 3600) return `~${Math.ceil(secs / 60)}m left`;
  return `~${(secs / 3600).toFixed(1)}h left`;
}

// ── Discovery layout ──────────────────────────────────────────
// Discovery data is loaded live — no hardcoded games

// ── Hero Carousel ─────────────────────────────────────────────
let _heroCarouselCleanup = null;
async function initHeroCarousel(games) {
  const track   = document.getElementById('hero-carousel-track');
  const dotsEl  = document.getElementById('hero-dots');
  const prevBtn = document.getElementById('hero-prev');
  const nextBtn = document.getElementById('hero-next');
  const skelEl  = document.getElementById('hero-carousel-skeleton');
  if (!track) return;

  // Clean up previous auto-advance if re-initialised
  if (_heroCarouselCleanup) { _heroCarouselCleanup(); _heroCarouselCleanup = null; }

  // Keep skeleton visible while fetching
  if (skelEl) skelEl.style.display = '';

  if (!games || games.length === 0) {
    // Fallback: keep skeleton visible with a subtle message
    if (skelEl) { skelEl.style.display = ''; }
    return;
  }

  // Shuffle so each launch shows different games first
  const shuffled = [...games].sort(() => Math.random() - 0.5);

  // Fetch SGDB assets for all games in parallel
  const assetPromises = shuffled.map(async (g) => {
    const assets = await fetchSgdbAssets(g.title);
    return {
      ...g,
      sgdbAssets: assets
    };
  });

  const gamesWithAssets = await Promise.all(assetPromises);

  // Filter out games that don't have SGDB assets (only for carousel)
  const gamesWithSgdb = gamesWithAssets.filter(g => g.sgdbAssets && g.sgdbAssets.hero && g.sgdbAssets.logo);

  // Hide skeleton after fetching
  if (skelEl) skelEl.style.display = 'none';

  // If no games have SGDB assets, show skeleton
  if (gamesWithSgdb.length === 0) {
    if (skelEl) skelEl.style.display = '';
    return;
  }

  let current = 0;
  const total = gamesWithSgdb.length;

  // Build slides
  track.innerHTML = '';
  gamesWithSgdb.forEach((g, i) => {
    const slide = document.createElement('div');
    slide.className = 'hero-slide';
    slide.innerHTML = `
      <div class="hero-slide-bg" style="background-image:url('${escapeHtml(g.sgdbAssets.hero)}')"></div>
      <div class="hero-slide-gradient"></div>
      <div class="hero-slide-content">
        <img class="hero-slide-logo" src="${escapeHtml(g.sgdbAssets.logo)}" alt="${escapeHtml(g.title)}" />
      </div>`;
    slide.addEventListener('click', () => {
      if (g.url) openGameDetail({ url: g.url, title: g.title, image: g.image, version: g.version || null });
    });
    track.appendChild(slide);
  });

  // Build dots
  if (dotsEl) {
    dotsEl.innerHTML = '';
    gamesWithSgdb.forEach((_, i) => {
      const dot = document.createElement('div');
      dot.className = 'hero-dot' + (i === 0 ? ' active' : '');
      dot.addEventListener('click', () => goTo(i));
      dotsEl.appendChild(dot);
    });
  }

  function goTo(idx) {
    current = (idx + total) % total;
    track.style.transform = `translateX(-${current * 100}%)`;
    if (dotsEl) {
      dotsEl.querySelectorAll('.hero-dot').forEach((d, i) => {
        d.classList.toggle('active', i === current);
      });
    }
  }

  if (prevBtn) prevBtn.onclick = () => { resetTimer(); goTo(current - 1); };
  if (nextBtn) nextBtn.onclick = () => { resetTimer(); goTo(current + 1); };

  // Auto-advance every 5s
  let timer = setInterval(() => goTo(current + 1), 5000);
  function resetTimer() { clearInterval(timer); timer = setInterval(() => goTo(current + 1), 5000); }
  _heroCarouselCleanup = () => clearInterval(timer);
}

function makeDiscGameCard(game) {
  const card = document.createElement('div');
  card.className = 'wide-card';
  card.innerHTML = `
    <div class="wide-card-cover">
      ${game.image
        ? `<img src="${escapeHtml(game.image)}" alt="${escapeHtml(game.title)}" loading="lazy"/>`
        : `<div class="wide-card-ph"><svg width="26" height="26" viewBox="0 0 22 22" fill="none" opacity=".2"><rect x="2" y="2" width="8" height="8" rx="1" fill="currentColor"/><rect x="12" y="2" width="8" height="8" rx="1" fill="currentColor"/><rect x="2" y="12" width="8" height="8" rx="1" fill="currentColor"/><rect x="12" y="12" width="8" height="8" rx="1" fill="currentColor"/></svg></div>`}
      <div class="wide-card-overlay">
        <span class="wide-card-btn">
          <svg width="12" height="12" viewBox="0 0 14 14" fill="none"><path d="M4 2.5l8 4.5-8 4.5V2.5z" fill="currentColor"/></svg>
          View
        </span>
      </div>
    </div>
    <div class="wide-card-info">
      <div class="wide-card-title">${escapeHtml(game.title)}</div>
      ${game.version ? `<div class="wide-card-version">${escapeHtml(game.version)}</div>` : ''}
    </div>`;
  card.style.opacity = '0';
  card.style.transform = 'translateY(14px)';
  card.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
  _observeReveal(card);
  if (game.url) {
    card.addEventListener('click', () => openGameDetail({ url: game.url, title: game.title, image: game.image, version: game.version || null }));
  }
  return card;
}

function makeCoverListItem(item, rank) {
  const el = document.createElement('div');
  el.className = 'cover-list-item';
  el.innerHTML = `
    ${rank != null ? `<span class="cover-list-num">${rank}</span>` : ''}
    ${item.image
      ? `<img class="cover-list-img" src="${escapeHtml(item.image)}" alt="${escapeHtml(item.title)}" loading="lazy"/>`
      : `<div class="cover-list-ph"></div>`}
    <div class="cover-list-info">
      <span class="cover-list-date">${escapeHtml(item.date || '')}</span>
      <div class="cover-list-title">${escapeHtml(item.title)}</div>
    </div>`;
  // Reveal animation
  el.style.opacity = '0';
  el.style.transform = 'translateX(-14px)';
  el.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
  _observeReveal(el);
  if (item.url) {
    el.addEventListener('click', () => openGameDetail({ url: item.url, title: item.title, image: item.image, version: null }));
  }
  return el;
}

function makeUpcomingCard(game) {
  const el = document.createElement('div');
  el.className = 'upcoming-list-item';
  if (game.url) el.style.cursor = 'pointer';
  el.innerHTML = `
    ${game.image
      ? `<img class="upcoming-list-cover" src="${escapeHtml(game.image)}" alt="${escapeHtml(game.title)}" loading="lazy"/>`
      : `<div class="upcoming-list-ph"></div>`}
    <div class="upcoming-list-info">
      <div class="upcoming-list-title">${escapeHtml(game.title)}</div>
      <div class="upcoming-list-date">${escapeHtml(game.date || 'TBA')}</div>
    </div>
    <span class="upcoming-soon-badge">SOON</span>`;
  // Reveal animation
  el.style.opacity = '0';
  el.style.transform = 'translateY(12px)';
  el.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
  _observeReveal(el);
  if (game.url) {
    el.addEventListener('click', () => window.api.openExternal(game.url));
  }
  return el;
}



function renderGotdCard(gotd) {
  const card     = document.getElementById('gotd-card');
  const link     = document.getElementById('gotd-card-link');
  const poster   = document.getElementById('gotd-card-poster');
  const posterPh = document.getElementById('gotd-card-poster-ph');
  const titleEl  = document.getElementById('gotd-card-title');
  const metaEl   = document.getElementById('gotd-card-meta');
  const descEl   = document.getElementById('gotd-card-desc');
  const statsEl  = document.getElementById('gotd-card-stats');
  const dateEl   = document.getElementById('gotd-date');
  const header   = document.getElementById('gotd-header');

  if (!gotd || !card) return;

  // Date in header
  if (dateEl) {
    dateEl.textContent = gotd.dateDisplay || '';
    if (gotd.datetime) dateEl.setAttribute('datetime', gotd.datetime);
  }
  if (header) header.style.display = '';

  // Poster
  if (gotd.image) {
    poster.src = gotd.image;
    poster.alt = gotd.title || '';
    poster.style.display = 'block';
    if (posterPh) posterPh.style.display = 'none';
  } else {
    poster.style.display = 'none';
    if (posterPh) posterPh.style.display = 'block';
  }

  // Link
  if (link && gotd.url) {
    link.href = gotd.url;
    link.onclick = (e) => { e.preventDefault(); window.api.openExternal(gotd.url); };
  }

  // Title
  if (titleEl) {
    titleEl.textContent = gotd.title || '';
    if (gotd.url) {
      titleEl.href = gotd.url;
      titleEl.onclick = (e) => { e.preventDefault(); window.api.openExternal(gotd.url); };
    }
  }

  // Meta: genres + version
  if (metaEl) {
    const parts = [];
    if (gotd.version) parts.push(`<span class="gotd-meta-version">${escapeHtml(gotd.version)}</span>`);
    (gotd.genres || []).forEach(g => parts.push(`<span class="gotd-meta-tag">${escapeHtml(g)}</span>`));
    metaEl.innerHTML = parts.join('');
  }

  // Description
  if (descEl) descEl.textContent = gotd.description || '';

  // Stats
  if (statsEl) {
    const stats = [];
    if (gotd.size)      stats.push(`<span><strong>${escapeHtml(gotd.size)}</strong> size</span>`);
    if (gotd.downloads) stats.push(`<span><strong>${escapeHtml(gotd.downloads)}</strong> downloads</span>`);
    if (gotd.views)     stats.push(`<span><strong>${escapeHtml(gotd.views)}</strong> views</span>`);
    if (gotd.score)     stats.push(`<span><strong>${escapeHtml(gotd.score)}</strong> score</span>`);
    statsEl.innerHTML = stats.join('');
  }

  card.style.display = '';
}

function renderUpcomingSection(games) {
  const gotdDate = document.getElementById('gotd-date');
  if (gotdDate) {
    const now = new Date();
    gotdDate.textContent = now.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    gotdDate.setAttribute('datetime', now.toISOString());
  }
  const upcomingGrid = $('grid-upcoming');
  if (!upcomingGrid) return;
  upcomingGrid.innerHTML = '';
  const badge = $('upcoming-badge');
  const count = $('upcoming-count');
  if (!games || games.length === 0) {
    upcomingGrid.innerHTML = '<div class="disc-error">Could not load upcoming games.</div>';
    if (badge) badge.classList.add('hidden');
    return;
  }
  games.slice(0, 5).forEach(g => upcomingGrid.appendChild(makeUpcomingCard(g)));
  if (badge && count) {
    count.textContent = games.length;
    badge.classList.remove('hidden');
  }
}

// ── SGDB cover art lazy-loader with concurrency-limited queue ──
const _SGDB_CONCURRENCY = 4;
let _sgdbActive = 0;
const _sgdbQueue = []; // { imgWrap, title }

// Wide art (a 16:9 banner rather than a 2:3 poster) gets letterboxed over a
// blurred copy of itself instead of being centre-cropped, which otherwise cuts
// the game's title straight off the card.
function markCoverAspect(imgWrap, img, url) {
  if (!img.naturalWidth || !img.naturalHeight) return;
  if (img.naturalWidth / img.naturalHeight > 1.2) {
    imgWrap.style.setProperty('--cover-bg', safeCssUrl(url));
    imgWrap.classList.add('cover-wide');
  }
}

function _sgdbEnqueue(imgWrap, title) {
  _sgdbQueue.push({ imgWrap, title, gameUrl: imgWrap.dataset.gameUrl || null });
  _sgdbDrain();
}

function _sgdbDrain() {
  while (_sgdbActive < _SGDB_CONCURRENCY && _sgdbQueue.length) {
    const { imgWrap, title, gameUrl } = _sgdbQueue.shift();
    _sgdbActive++;

    const apply = (url, onFail) => {
      const img = document.createElement('img');
      img.alt = title;
      img.onload = () => {
        markCoverAspect(imgWrap, img, url);
        imgWrap.classList.add('sgdb-cover-loaded');
        imgWrap.insertBefore(img, imgWrap.firstChild);
      };
      img.onerror = onFail;
      img.src = url;
    };
    const giveUp = () => imgWrap.classList.add('steam-card-ph-done');

    // Plenty of smaller titles aren't on SteamGridDB at all, but their own
    // store page has art. Fall through to that before showing a blank tile.
    const pageFallback = () => {
      if (!gameUrl || !window.api.fetchPageCover) return giveUp();
      window.api.fetchPageCover(gameUrl)
        .then(res => {
          const u = safeUrl(res && res.url);
          if (u) apply(u, giveUp); else giveUp();
        })
        .catch(giveUp);
    };

    _fetchSgdbCover(title).then(url => {
      if (!url) pageFallback();
      else apply(url, pageFallback);
    }).finally(() => {
      _sgdbActive--;
      _sgdbDrain();
    });
  }
}

const _sgdbCoverObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (!entry.isIntersecting) return;
    const imgWrap = entry.target;
    const title = imgWrap.dataset.sgdbTitle;
    if (!title || imgWrap.dataset.sgdbLoaded) return;
    imgWrap.dataset.sgdbLoaded = '1';
    _sgdbCoverObserver.unobserve(imgWrap);
    _sgdbEnqueue(imgWrap, title);
  });
}, { rootMargin: '200px' });

async function _fetchSgdbCover(title) {
  try {
    const search = await _sgFetch(`/search/autocomplete/${encodeURIComponent(title)}`);
    if (!search || !search.length) return null;
    const id = search[0].id;
    const grids = await _sgFetch(`/grids/game/${id}?dimensions=600x900,342x482,660x930`);
    if (grids && grids.length) return grids[0].url;
    // fallback: try hero
    const heroes = await _sgFetch(`/heroes/game/${id}`);
    if (heroes && heroes.length) return heroes[0].url;
    return null;
  } catch { return null; }
}

// Reflect the active source on the home switcher.
function syncHomeSourceSwitch() {
  const src = appState.settings.source || 'ankergames';
  document.querySelectorAll('.home-source-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.source === src);
  });
}

async function renderDiscovery() {
  const homeGrid = $('home-game-grid');
  syncHomeSourceSwitch();

  // Fetch full games list from games-list-page (4000+ games, no images)
  const source = appState.settings.source || 'ankergames';
  const [listResult] = await Promise.allSettled([window.api.fetchGamesList({ source })]);
  const listData = listResult.status === 'fulfilled' ? listResult.value : {};
  const games = listData.games || [];

  // Hero carousel: fetch a few recent games with images for the banner
  if (games.length) {
    // Use fetchDiscovery page 1 for hero images only
    try {
      const heroData = await window.api.fetchDiscovery(1);
      const heroGames = (heroData.games || []).filter(g => g.image).slice(0, 10);
      initHeroCarousel(heroGames);
    } catch { initHeroCarousel([]); }
  } else {
    initHeroCarousel([]);
  }

  // Update section header
  const sectionTitle = document.querySelector('.home-section-title');
  if (sectionTitle) {
    const label = source === 'steamrip' ? 'SteamRIP' : 'AnkerGames';
    sectionTitle.innerHTML = `<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 1l1.6 3.3 3.6.5-2.6 2.5.6 3.6L7 9.2l-3.2 1.7.6-3.6L1.8 4.8l3.6-.5L7 1z" fill="#66c0f4"/></svg> All ${label} Games <span style="font-size:11px;opacity:.5;font-weight:400">(${games.length.toLocaleString()})</span>`;
  }

  if (!homeGrid) return;
  homeGrid.innerHTML = '';
  document.getElementById('home-load-more-wrap')?.remove();

  if (!games.length) {
    const label = source === 'steamrip' ? 'SteamRIP' : 'AnkerGames';
    homeGrid.innerHTML = `<div class="disc-error" style="grid-column:1/-1;padding:60px 0;text-align:center;opacity:.4;">Could not reach ${label}. Check your connection.</div>`;
    return;
  }

  const PAGE_SIZE = 48;
  let shown = 0;
  let filteredGames = games;

  // A–Z filter bar
  const existingFilter = document.getElementById('home-az-filter');
  if (existingFilter) existingFilter.remove();
  const filterBar = document.createElement('div');
  filterBar.id = 'home-az-filter';
  filterBar.className = 'home-az-filter';
  const letters = ['All','0-9','A','B','C','D','E','F','G','H','I','J','K','L','M','N','O','P','Q','R','S','T','U','V','W','X','Y','Z'];
  let activeLetter = 'All';
  letters.forEach(letter => {
    const btn = document.createElement('button');
    btn.className = 'home-az-btn' + (letter === 'All' ? ' active' : '');
    btn.textContent = letter;
    btn.addEventListener('click', () => {
      if (activeLetter === letter) return;
      activeLetter = letter;
      filterBar.querySelectorAll('.home-az-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      applyAzFilter(letter);
    });
    filterBar.appendChild(btn);
  });
  homeGrid.parentElement.insertBefore(filterBar, homeGrid);

  const loadMoreWrap = document.createElement('div');
  loadMoreWrap.id = 'home-load-more-wrap';
  loadMoreWrap.className = 'home-load-more-wrap';
  const loadMoreBtn = document.createElement('button');
  loadMoreBtn.id = 'home-load-more-btn';
  loadMoreBtn.className = 'home-load-more-btn';
  loadMoreBtn.textContent = 'Load More';
  loadMoreWrap.appendChild(loadMoreBtn);
  loadMoreBtn.addEventListener('click', revealNextPage);
  homeGrid.insertAdjacentElement('afterend', loadMoreWrap);

  function applyAzFilter(letter) {
    homeGrid.innerHTML = '';
    shown = 0;
    if (letter === 'All') {
      filteredGames = games;
    } else if (letter === '0-9') {
      filteredGames = games.filter(g => /^[0-9]/.test(g.title));
    } else {
      filteredGames = games.filter(g => g.title.toUpperCase().startsWith(letter));
    }
    revealNextPage();
  }

  function revealNextPage() {
    const next = filteredGames.slice(shown, shown + PAGE_SIZE);
    next.forEach(g => homeGrid.appendChild(makeSteamCard(g)));
    shown += next.length;
    loadMoreWrap.classList.toggle('hidden', shown >= filteredGames.length);
  }

  revealNextPage();
}

function makeSteamCard(game) {
  const card = document.createElement('div');
  card.className = 'steam-card';

  const imgWrap = document.createElement('div');
  imgWrap.className = 'steam-card-img-wrap steam-card-sgdb-wrap';
  imgWrap.dataset.sgdbTitle = game.title;
  if (game.url) imgWrap.dataset.gameUrl = game.url;

  // Placeholder shimmer shown until a cover is in place
  const ph = document.createElement('div');
  ph.className = 'steam-card-ph';
  imgWrap.appendChild(ph);

  const overlay = document.createElement('div');
  overlay.className = 'steam-card-hover-overlay';
  overlay.innerHTML = '<span class="steam-card-view-btn">View Game</span>';
  imgWrap.appendChild(overlay);

  // AnkerGames ships cover art with the listing, so use it directly: no
  // SteamGridDB round trip, no rate limit to queue behind, and no chance of
  // matching the wrong game by title. SGDB stays as the fallback for sources
  // that give us nothing (SteamRIP's A-Z page has no images at all).
  const cover = safeUrl(game.image);
  if (cover) {
    imgWrap.dataset.sgdbLoaded = '1';
    const img = new Image();
    img.className = 'steam-card-img';
    img.loading = 'lazy';
    img.alt = '';
    // The wrapper's CSS holds every image at opacity:0 until it gets the
    // `sgdb-cover-loaded` class — the reveal is a fade, not just the img
    // appearing. Without adding it the cover loads and stays invisible, which
    // is exactly what a grid of blank tiles looks like.
    img.onload = () => {
      markCoverAspect(imgWrap, img, cover);
      imgWrap.classList.add('sgdb-cover-loaded');
      ph.remove();
    };
    img.onerror = () => {
      // Cover 404'd or the host is unreachable — fall back to SGDB after all.
      img.remove();
      delete imgWrap.dataset.sgdbLoaded;
      _sgdbCoverObserver.observe(imgWrap);
    };
    img.src = cover;
    imgWrap.insertBefore(img, overlay);
  } else {
    _sgdbCoverObserver.observe(imgWrap);
  }

  const body = document.createElement('div');
  body.className = 'steam-card-body';
  body.innerHTML = `
    <div class="steam-card-title">${escapeHtml(game.title)}</div>
    ${game.version ? `<div class="steam-card-meta-row"><span class="steam-card-tag steam-card-tag-size">${escapeHtml(game.version)}</span></div>` : ''}`;

  card.appendChild(imgWrap);
  card.appendChild(body);

  card.style.opacity = '0';
  card.style.transform = 'translateY(10px)';
  card.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
  _observeReveal(card);

  if (game.url) {
    card.addEventListener('click', () => openGameDetail({ url: game.url, title: game.title, image: null, version: game.version || null }));
  }
  return card;
}

// ── Scanned game fix system ────────────────────────────────────
const gameFixMappings = JSON.parse(localStorage.getItem('nino-fix-mappings') || '{}');

function saveFixMappings() {
  localStorage.setItem('nino-fix-mappings', JSON.stringify(gameFixMappings));
}

// ── Auto-fix ──────────────────────────────────────────────────
// Most "unrecognised" games are only unrecognised because the folder name is
// the source-prefixed slug. Searching for the cleaned-up name almost always
// finds the real game, so do that automatically and only fall back to the
// manual "Unrecognised Game" button when the search genuinely comes up empty
// (or returns nothing convincing enough to assign without asking).
const autoFixFailed = new Set(JSON.parse(localStorage.getItem('nino-autofix-failed') || '[]'));

function saveAutoFixFailed() {
  localStorage.setItem('nino-autofix-failed', JSON.stringify([...autoFixFailed]));
}

// Compare titles ignoring punctuation, casing, version parens and the
// "Free Download" boilerplate the sources append.
function normTitle(s) {
  return (s || '')
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/\bfree download\b/g, ' ')
    .replace(/[^a-z0-9]+/g, '');
}

// Only auto-assign on a strong match. A prefix match covers slug artefacts
// ("Minecraft 1d" -> "Minecraft") while still rejecting a wrong game
// ("007 First Light" would never accept a bare "007").
function titlesMatch(a, b) {
  const x = normTitle(a), y = normTitle(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return long.startsWith(short) && short.length / long.length >= 0.6;
}

let autoFixRunning = false;

async function autoFixUnrecognised(entries) {
  if (autoFixRunning) return false;

  const pending = entries.filter(e =>
    e.status === 'installed' &&
    !e.coverImage &&
    !gameFixMappings[e.id] &&
    !autoFixFailed.has((appState.settings.source || 'ankergames') + ':' + e.id)
  );
  if (!pending.length) return false;

  autoFixRunning = true;
  let fixedAny = false;
  try {
    const source = appState.settings.source || 'ankergames';
    for (const entry of pending) {
      const failKey = source + ':' + entry.id;
      const query = stripSourcePrefix(entry.title || '', entry.id || '').trim();
      if (!query) { autoFixFailed.add(failKey); continue; }

      let games = null;
      try {
        const res = await window.api.search(query, 1, source);
        games = res && res.games;
      } catch {
        // Network hiccup — leave it unmarked so the next refresh retries.
        continue;
      }

      const hit = (games || []).find(g => titlesMatch(query, g.title));
      if (hit) {
        gameFixMappings[entry.id] = { title: hit.title, coverImage: hit.image, gameUrl: hit.url };
        fixedAny = true;
      } else {
        // Nothing convincing — this is a genuinely unrecognised game, so let
        // the manual fix button show for it.
        autoFixFailed.add(failKey);
      }
    }

    if (fixedAny) {
      saveFixMappings();
      window.api.ninoAuth.getAuth().then(auth => {
        if (auth?.token) window.api.ninoAuth.syncProfile(auth.token, gameFixMappings).catch(() => {});
      }).catch(() => {});
    }
    saveAutoFixFailed();
  } finally {
    autoFixRunning = false;
  }
  return fixedAny;
}

// ── Library layout ────────────────────────────────────────────
let libLayout = localStorage.getItem('nino-lib-layout') || 'list';

function applyLibLayout() {
  libGrid.classList.remove('layout-cards', 'layout-list', 'layout-compact');
  if (libLayout !== 'list') libGrid.classList.add('layout-' + libLayout);
  document.querySelectorAll('.lib-layout-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.layout === libLayout);
  });

  const libContent = document.getElementById('lib-content');
  const steamPane  = document.getElementById('lib-steam-pane');
  const isCompact  = libLayout === 'compact';

  if (libContent) libContent.classList.toggle('steam-mode', isCompact);
  if (steamPane)  steamPane.style.display = isCompact ? 'flex' : 'none';

  if (isCompact) populateLibSteamSidebar();
}

// ── Hidden games system ───────────────────────────────────────
const hiddenGames = new Set(JSON.parse(localStorage.getItem('nino-hidden-games') || '[]'));
let showHiddenGames = false;
let libRefreshing = false;
let libRefreshQueued = false;

function toggleHideGame(id) {
  if (hiddenGames.has(id)) hiddenGames.delete(id);
  else hiddenGames.add(id);
  localStorage.setItem('nino-hidden-games', JSON.stringify([...hiddenGames]));
  refreshLibraryView();
}

function applyFixMapping(entry) {
  const mapping = gameFixMappings[entry.id];
  if (mapping) {
    return { ...entry, title: mapping.title, coverImage: mapping.coverImage, gameUrl: mapping.gameUrl, fixed: true };
  }
  return entry;
}

// Unrecognised games get their title derived from the install folder, which is
// the source-prefixed id ("ag-call-of-duty-…"), so the title arrives already
// prettified as "Ag Call Of Duty …". Searching for that never matches. Strip
// the prefix in either form, but only when the id actually carries one — that
// way real titles like "Agatha Knife" are left alone.
function stripSourcePrefix(title, id) {
  if (!/^(?:sr|ag)-/i.test(id)) return title;
  return title.replace(/^(?:sr|ag)[-\s]+/i, '');
}

function openFixGameDialog(entry) {
  const dialog = $('fix-game-dialog');
  const folderInput = $('fix-folder-name');
  const searchInput2 = $('fix-search-input');
  const searchBtn2 = $('fix-search-btn');
  const resultsList = $('fix-search-results');
  const cancelBtn = $('fix-cancel-btn');
  if (!dialog) return;
  folderInput.value = entry.id || entry.title || '';
  // Unrecognised games fall back to their folder name, which carries the
  // source prefix the id is built with (sr-/ag-). Searching for "sr-minecraft"
  // never matches anything, so drop the prefix from the query — the folder
  // name above still shows the real, unmodified id.
  searchInput2.value = stripSourcePrefix(entry.title || '', entry.id || '');
  resultsList.innerHTML = '';
  dialog.classList.remove('hidden');
  searchInput2.focus();
  async function runFixSearch() {
    const q2 = searchInput2.value.trim();
    if (!q2) return;
    resultsList.innerHTML = '<div class="disc-error">Searching…</div>';
    try {
      const source = appState.settings.source || 'ankergames';
      const res = await window.api.search(q2, 1, source);
      resultsList.innerHTML = '';
      if (!res.games || !res.games.length) {
        resultsList.innerHTML = '<div class="disc-error">No results found.</div>';
        return;
      }
      res.games.slice(0, 8).forEach(game => {
        const item = document.createElement('div');
        item.className = 'fix-result-item';
        item.innerHTML = `
          ${game.image ? `<img class="fix-result-cover" src="${escapeHtml(game.image)}" loading="lazy"/>` : '<div class="fix-result-cover"></div>'}
          <div>
            <div class="fix-result-title">${escapeHtml(game.title)}</div>
            <div class="fix-result-sub">${escapeHtml(game.version || '')}</div>
          </div>`;
        item.addEventListener('click', () => {
          gameFixMappings[entry.id] = { title: game.title, coverImage: game.image, gameUrl: game.url };
          saveFixMappings();
          dialog.classList.add('hidden');
          refreshLibraryView();
          setStatus(`Fixed: ${entry.id} → ${game.title}`);
          // Sync profile so the assigned game appears in friends' view
          window.api.ninoAuth.getAuth().then(auth => {
            if (auth?.token) window.api.ninoAuth.syncProfile(auth.token, gameFixMappings).catch(() => {});
          }).catch(() => {});
        });
        resultsList.appendChild(item);
      });
    } catch {
      resultsList.innerHTML = '<div class="disc-error">Search failed. Check connection.</div>';
    }
  }
  searchBtn2.onclick = runFixSearch;
  searchInput2.onkeydown = e => { if (e.key === 'Enter') runFixSearch(); };
  cancelBtn.onclick = () => dialog.classList.add('hidden');
  dialog.onclick = e => { if (e.target === dialog) dialog.classList.add('hidden'); };
}

// ── Download badge updater ─────────────────────────────────────
function updateDownloadBadge() {
  const badge = $('dl-badge');
  if (!badge) return;
  const active = Object.values(appState.downloads).filter(d => d.state !== 'completed' && d.pct < 100 && d.pct > 0).length;
  const preparing = appState.library ? appState.library.filter(e => ['downloading','preparing','extracting','paused'].includes(e.status)).length : 0;
  const count = Math.max(active, preparing);
  if (count > 0) {
    badge.textContent = count > 9 ? '9+' : String(count);
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}


const TYPING_GAMES = [];
let typingIdx = 0, typingPos = 0, typingDeleting = false, typingTimer = null;
function runTyping() { /* hero removed — discovery layout used instead */ }

// ── Titlebar ──────────────────────────────────────────────────
btnMin.addEventListener('click', () => window.api.winMinimize());
btnMax.addEventListener('click', () => window.api.winMaximize());
btnClose.addEventListener('click', () => window.api.winClose());
window.api.onWindowState(s => {
  $('icon-max').style.display     = s === 'maximized' ? 'none'  : 'block';
  $('icon-restore').style.display = s === 'maximized' ? 'block' : 'none';
});

// ── Navigation ────────────────────────────────────────────────
function navigateTo(page) {
  // In compact/steam mode, intercept installed-detail navigation —
  // embed #view-installed-detail inside the steam panel instead of
  // switching away from the library page.
  if (page === 'installed-detail' && libLayout === 'compact') {
    const igdEl   = document.getElementById('view-installed-detail');
    const panel   = document.getElementById('lib-steam-detail');
    const empty   = document.getElementById('lib-steam-empty');
    const content = document.getElementById('lib-steam-detail-content');
    if (igdEl && panel) {
      // Hide the placeholder content
      if (empty)   empty.style.display   = 'none';
      if (content) content.style.display = 'none';
      // Move IGD into the steam panel and show it (unstyled as a page — just the content)
      igdEl.classList.remove('hidden');
      igdEl.style.position = 'relative';
      igdEl.style.inset    = 'auto';
      igdEl.style.overflow = 'auto';
      igdEl.style.flex     = '1';
      panel.appendChild(igdEl);
      // Hide the back button inside IGD — sidebar handles navigation
      const backBtn = document.getElementById('igd-back');
      if (backBtn) backBtn.style.display = 'none';
      return; // don't switch pages
    }
  }

  // Restore IGD to its original parent if it was embedded in the steam panel
  const igdEl = document.getElementById('view-installed-detail');
  if (igdEl && igdEl.parentElement && igdEl.parentElement.id === 'lib-steam-detail') {
    igdEl.style.position = '';
    igdEl.style.inset    = '';
    igdEl.style.overflow = '';
    igdEl.style.flex     = '';
    const backBtn = document.getElementById('igd-back');
    if (backBtn) backBtn.style.display = '';
    const pageArea = document.getElementById('page-area');
    if (pageArea) pageArea.appendChild(igdEl);
    igdEl.classList.add('hidden');
  }

  document.querySelectorAll('.page').forEach(el => el.classList.add('hidden'));
  const el = $('view-' + page);
  if (el) el.classList.remove('hidden');
  sbBtns.forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === page || (page === 'detail' && btn.dataset.view === appState.prevPage) || (page === 'installed-detail' && btn.dataset.view === appState.prevPage) || (page === 'party' && btn.dataset.view === appState.prevPage));
  });
  appState.currentPage = page;
  if (page === 'library') refreshLibraryView();
  if (page === 'settings') (window.loadSettings || loadSettings)();
  if (page === 'wishlist') refreshWishlistView();
  if (page === 'multiplayer') refreshMultiplayerView({ animate: true });
  if (page === 'home') {
    // If there are already rendered results in the grid, just show them
    if (appState.searchQuery && gameGrid.children.length > 0) {
      showHomeState('results');
    } else if (appState.searchQuery) {
      // Results were cleared (e.g. source changed) — re-run the search
      searchInput.value = appState.searchQuery;
      doSearch(appState.searchQuery);
    } else if ($('st-welcome') && !$('st-welcome').classList.contains('hidden')) {
      if (!typingTimer) runTyping();
    }
  }
  document.dispatchEvent(new CustomEvent('page-changed', { detail: page }));
}

sbBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    const view = btn.dataset.view;
    // Clicking Home while looking at search results goes back to the actual home
    // page. Previously it just re-showed the results, so there was no way back
    // to the browse view without clearing the box by hand.
    if (view === 'home' && appState.searchQuery) {
      appState.searchQuery = '';
      appState.searchPage = 1;
      appState.totalGames = 0;
      if (searchInput) searchInput.value = '';
      gameGrid.innerHTML = '';
      showHomeState('welcome');
    }
    appState.prevPage = view;
    navigateTo(view);
  });
});

function showHomeState(name) {
  ['welcome','loading','empty','error','results'].forEach(s => {
    $('st-' + s).classList.toggle('hidden', s !== name);
  });
  // Hide the entire discovery layout (hero + all sections) when not on welcome
  const discoveryLayout = $('discovery-layout');
  if (discoveryLayout) discoveryLayout.classList.toggle('hidden', name !== 'welcome');
  const homeView = document.getElementById('view-home');
  if (homeView) homeView.classList.toggle('searching', name !== 'welcome');
  if (name === 'welcome') { if (!typingTimer) runTyping(); }
  else { clearTimeout(typingTimer); typingTimer = null; }
}

function showActionState(name) {
  ['loading','error','download','preparing','progress','extracting','done','failed','no-link','already-installed'].forEach(s => {
    const el = $('action-' + s);
    if (el) el.classList.add('hidden');
  });
  const el = $('action-' + name);
  if (el) el.classList.remove('hidden');
}

document.querySelectorAll('.lib-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.lib-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    appState.libTab = tab.dataset.tab;
    refreshLibraryView();
  });
});

$('lib-scan-btn').addEventListener('click', async () => {
  const btn = $('lib-scan-btn');
  btn.disabled = true;
  btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" style="vertical-align:middle;margin-right:5px"><path d="M11 6A5 5 0 1 1 8.5 1.8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M8 1h3v3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>Scanning…';
  setStatus('Scanning games folder…');
  try {
    const result = await window.api.scanLibrary();
    appState.library = await window.api.getLibrary();
    // Switch to installed tab to show results
    document.querySelectorAll('.lib-tab').forEach(t => t.classList.remove('active'));
    document.querySelector('.lib-tab[data-tab="installed"]').classList.add('active');
    appState.libTab = 'installed';
    refreshLibraryView();
    if (result.added > 0) {
      setStatus(`Scan complete — ${result.added} new game${result.added !== 1 ? 's' : ''} added.`);
    } else {
      setStatus('Scan complete — no new games found.');
    }
  } catch (err) {
    setStatus('Scan failed: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" style="vertical-align:middle;margin-right:5px"><path d="M11 6A5 5 0 1 1 8.5 1.8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M8 1h3v3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>Scan Folder';
  }
});

$('lib-clear-failed-btn').addEventListener('click', async () => {
  const failed = appState.library.filter(e => ['failed', 'cancelled', 'extract-failed'].includes(e.status));
  if (!failed.length) return;
  for (const entry of failed) {
    await window.api.removeGame(entry.id);
  }
  appState.library = await window.api.getLibrary();
  refreshLibraryView();
  setStatus(`Cleared ${failed.length} failed download${failed.length !== 1 ? 's' : ''}.`);
});


async function doSearch(query) {
  if (!query.trim()) return;
  appState.searchQuery = query.trim();
  appState.searchPage  = 1;
  appState.totalGames  = 0;
  appState.hasMore     = true;
  appState.isLoading   = true;
  showHomeState('loading');
  setStatus(`Searching "${appState.searchQuery}"…`);
  searchInput.blur();
  try {
    const result = await window.api.search(appState.searchQuery, 1, appState.settings.source || 'ankergames');
    if (result.error) { $('error-msg').textContent = result.error; showHomeState('error'); setStatus('Search error.'); return; }
    if (!result.games.length) { $('empty-msg').textContent = `No games found for "${appState.searchQuery}"`; showHomeState('empty'); setStatus('No results.'); return; }
    showHomeState('results');
    renderSearchResults(result.games, false);
    appState.hasMore = result.hasMore;
    updatePaginationUI();
    setStatus(`Results for "${appState.searchQuery}"`);
  } catch (err) {
    $('error-msg').textContent = 'Unexpected error. Check your connection.';
    showHomeState('error'); setStatus('Error.');
  } finally {
    appState.isLoading = false;
    updatePaginationUI();
  }
}

async function loadMoreResults() {
  if (appState.isLoading || !appState.hasMore) return;
  appState.searchPage++;
  appState.isLoading = true;
  updatePaginationUI();
  try {
    const result = await window.api.search(appState.searchQuery, appState.searchPage, appState.settings.source || 'ankergames');
    if (!result.games.length) appState.hasMore = false;
    else { renderSearchResults(result.games, true); appState.hasMore = result.hasMore; }
    setStatus(`${appState.totalGames} games loaded`);
  } catch { appState.searchPage--; }
  finally { appState.isLoading = false; updatePaginationUI(); }
}

function updatePaginationUI() {
  loadMoreBtn.classList.toggle('hidden', appState.isLoading || !appState.hasMore);
  loadMoreSpin.classList.toggle('hidden', !appState.isLoading);
  allLoaded.classList.toggle('hidden', appState.isLoading || appState.hasMore);
}

function renderSearchResults(games, append) {
  if (!append) { gameGrid.innerHTML = ''; appState.totalGames = 0; }
  const frag = document.createDocumentFragment();
  games.forEach((game, i) => {
    appState.totalGames++;
    const card = document.createElement('div');
    card.className = 'game-card';
    card.style.setProperty('--delay', `${i * 22}ms`);
    card.innerHTML = `
      <div class="gc-cover">
        ${game.image
          ? `<img src="${escapeHtml(game.image)}" alt="${escapeHtml(game.title)}" loading="lazy"/>`
          : `<div class="gc-placeholder"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" opacity=".3"><rect x="2" y="2" width="9" height="9" rx="1" fill="currentColor"/><rect x="13" y="2" width="9" height="9" rx="1" fill="currentColor" opacity=".5"/><rect x="2" y="13" width="9" height="9" rx="1" fill="currentColor" opacity=".5"/><rect x="13" y="13" width="9" height="9" rx="1" fill="currentColor" opacity=".25"/></svg></div>`}
        <div class="gc-overlay"><span class="gc-view-label">VIEW</span></div>
      </div>
      <div class="gc-info">
        <div class="gc-title">${escapeHtml(game.title)}</div>
        ${game.version ? `<div class="gc-version">${escapeHtml(game.version)}</div>` : ''}
      </div>`;
    card.addEventListener('click', () => openGameDetail(game));
    frag.appendChild(card);
  });
  gameGrid.appendChild(frag);
  resultsLabel.textContent = `${appState.totalGames} game${appState.totalGames !== 1 ? 's' : ''} loaded`;
}

// ── SteamGridDB integration ────────────────────────────────────
const _sgK = atob('ZTIyOWRiNTFlNzk3OWNiNTgwODQ5YWZmOWY1OTRmNzk=');
const _sgB = 'https://www.steamgriddb.com/api/v2';

async function _sgFetch(path) {
  try {
    const r = await fetch(`${_sgB}${path}`, { headers: { Authorization: `Bearer ${_sgK}` } });
    if (!r.ok) return null;
    const j = await r.json();
    return j.success ? j.data : null;
  } catch { return null; }
}

async function fetchSgdbAssets(title) {
  const search = await _sgFetch(`/search/autocomplete/${encodeURIComponent(title)}`);
  if (!search || !search.length) return null;
  const id = search[0].id;
  const [logos, heroes] = await Promise.all([
    _sgFetch(`/logos/game/${id}`),
    _sgFetch(`/heroes/game/${id}`),
  ]);
  const logo = logos && logos.length ? logos[0].url : null;
  const hero = heroes && heroes.length ? heroes[0].url : null;
  if (!logo || !hero) return null;
  return { logo, hero };
}

function applySgdbMode(logoUrl, heroUrl, title, sizeHtml) {
  const banner     = $('detail-banner');
  const sgBanner   = $('detail-sgdb-banner');
  const sgLogo     = $('detail-sgdb-logo');
  const bottomMeta = $('detail-bottom-meta');

  // Preload both images before touching the DOM at all
  let heroLoaded = false;
  let logoLoaded = false;

  const heroImg = new Image();
  const logoImg = new Image();

  const applyTransition = () => {
    if (!heroLoaded || !logoLoaded) return;

    // 1. Set srcs while elements are still invisible (opacity:0 from CSS)
    sgBanner.src = heroUrl;
    sgLogo.src   = logoUrl;

    // Make sure the hero is in the DOM and visible for transition to fire
    sgBanner.style.display = 'block';
    sgLogo.style.display   = 'block';

    // Populate bottom meta while it's still hidden
    $('detail-bottom-title').textContent    = title;
    $('detail-bottom-size-wrap').innerHTML  = sizeHtml;
    bottomMeta.style.display = 'block'; // un-hide (still opacity:0 from CSS)

    // 2. One rAF to let the browser register the display change,
    //    then add sgdb-mode which triggers all the CSS transitions.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        banner.classList.add('sgdb-mode');
        bottomMeta.classList.add('sgdb-visible');
      });
    });
  };

  heroImg.onload = () => { heroLoaded = true; applyTransition(); };
  logoImg.onload = () => { logoLoaded = true; applyTransition(); };
  // If either image fails, skip SGDB mode gracefully
  heroImg.onerror = () => {};
  logoImg.onerror = () => {};

  heroImg.src = heroUrl;
  logoImg.src = logoUrl;
}

function resetSgdbMode() {
  const banner   = $('detail-banner');
  const sgBanner = $('detail-sgdb-banner');
  const sgLogo   = $('detail-sgdb-logo');
  const bottomMeta = $('detail-bottom-meta');

  banner.classList.remove('sgdb-mode', 'sgdb-loading', 'sgdb-fallback-visible');
  bottomMeta.classList.remove('sgdb-visible');

  // Reset without transition so the next page starts clean
  sgBanner.style.transition = 'none';
  sgLogo.style.transition   = 'none';
  sgBanner.style.display = 'none';
  sgBanner.src = '';
  sgLogo.style.display = 'none';
  sgLogo.src = '';
  bottomMeta.style.display = 'none';
  bottomMeta.style.opacity = '';
  bottomMeta.style.transform = '';
  $('detail-info').style.display = '';

  // Re-enable transitions on next frame so they're ready for applySgdbMode
  requestAnimationFrame(() => {
    sgBanner.style.transition = '';
    sgLogo.style.transition   = '';
  });
}

// ── Game detail ───────────────────────────────────────────────
async function openGameDetail(game) {
  appState.prevPage    = appState.currentPage;
  appState.currentGame = game;
  appState.gamePageInfo = null;
  detailTitle.textContent    = game.title;
  detailVersion.textContent  = game.version || '';
  detailDesc.innerHTML       = '';
  detailSizeSpan.textContent = '—';
  // Reset trailer button
  if (detailTrailerBtn) {
    detailTrailerBtn.classList.add('hidden');
    detailTrailerBtn.onclick = null;
  }
  if (detailTrailerBtnDone) {
    detailTrailerBtnDone.classList.add('hidden');
    detailTrailerBtnDone.onclick = null;
  }
  $('detail-screenshots').innerHTML = '';
  $('detail-screenshots').classList.add('hidden');
  $('detail-sysreq').classList.add('hidden');
  $('detail-sysreq-content').innerHTML = '';
  // Reset SGDB mode and hide banner content — show skeleton while we check SGDB
  resetSgdbMode();
  detailBannerBg.style.backgroundImage = '';
  detailCover.style.display = 'none';
  $('detail-cover-placeholder').style.display = 'none';
  // Show banner skeleton shimmer instead of old UI
  const banner = $('detail-banner');
  banner.classList.add('sgdb-loading');

  await updateWishlistBtn(game);
  navigateTo('detail');

  // Kick off SGDB fetch — don't show old UI until we know it failed
  const _sgTitle = game.title;
  fetchSgdbAssets(game.title).then(assets => {
    if (appState.currentGame?.title !== _sgTitle) return; // user navigated away
    banner.classList.remove('sgdb-loading');
    if (assets) {
      // SGDB succeeded — go straight into SGDB mode, old UI never visible
      applySgdbMode(assets.logo, assets.hero, game.title,
        `<span class="meta-chip" id="detail-size-sgdb">${$('detail-size').innerHTML}</span>`);
    } else {
      // SGDB failed — fade in the fallback (blurred cover) UI
      if (game.image) {
        detailCover.src = game.image;
        detailBannerBg.style.backgroundImage = safeCssUrl(game.image);
      }
      detailCover.style.display   = game.image ? 'block' : 'none';
      $('detail-cover-placeholder').style.display = game.image ? 'none' : 'flex';
      banner.classList.add('sgdb-fallback-visible');
    }
  }).catch(() => {
    banner.classList.remove('sgdb-loading');
    // On error, fade in fallback
    if (game.image) {
      detailCover.src = game.image;
      detailBannerBg.style.backgroundImage = safeCssUrl(game.image);
    }
    detailCover.style.display   = game.image ? 'block' : 'none';
    $('detail-cover-placeholder').style.display = game.image ? 'none' : 'flex';
    banner.classList.add('sgdb-fallback-visible');
  });
  const gameIdFromUrlDerived = gameIdFromUrl(game.url);
  // For manually scanned games, the library id is the folder name, not the URL-derived id.
  // Prefer the URL-derived id if it matches, otherwise fall back to the explicitly passed libId.
  const libByUrl = appState.library.find(e => e.id === gameIdFromUrlDerived);
  const gameId   = libByUrl ? gameIdFromUrlDerived : (game.libId || gameIdFromUrlDerived);
  const lib      = libByUrl || (game.libId ? appState.library.find(e => e.id === game.libId) : null);
  const isAnkerUrl = game.url && game.url.includes('ankergames.net');

  if (lib && lib.status === 'installed' && lib.installDir) {
    // Open the rich installed-game detail page instead of the download detail page
    // prevPage is already saved above; pass a flag to skip re-saving it
    if (window.openInstalledDetail) {
      window.openInstalledDetail({ ...game, libId: gameId }, /* keepPrev */ true);
    }
    return;
  } else if (lib && (lib.status === 'downloading' || lib.status === 'preparing' || lib.status === 'paused')) {
    const dl = appState.downloads[gameId];
    if (dl) showDownloadProgress(dl);
    else showActionState('preparing');
    setStatus(`${game.title} — downloading…`);
    if (isAnkerUrl) loadGamePageInfo(game);
  } else if (lib && lib.status === 'extracting') {
    showActionState('extracting');
    setStatus(`${game.title} — extracting…`);
    if (isAnkerUrl) loadGamePageInfo(game);
  } else {
    showActionState('loading');
    setStatus(`Loading info for "${game.title}"…`);
    await loadGamePageInfo(game);
  }
}

function setupExtraButtons(gameId, installDir, execPath, suffix) {
  const s = suffix ? suffix : '';
  const steamBtn    = $('add-steam-btn' + s);
  const shortcutBtn = $('add-shortcut-btn' + s);
  if (steamBtn) steamBtn.onclick = () => openAddToSteamDialog(gameId, execPath, appState.currentGame?.title, appState.currentGame?.image);
  if (shortcutBtn) {
    shortcutBtn.onclick = () => window.openShortcutPicker(gameId);
  }
}

// ── Add to Steam dialog ───────────────────────────────────────
function openAddToSteamDialog(gameId, execPath, title, imageHint) {
  const existing = $('steam-dialog');
  if (existing) existing.remove();

  // Prefer explicitly passed image, then currentGame, then library entry
  const coverImage = imageHint
    || appState.currentGame?.image
    || appState.library?.find(e => e.id === gameId)?.coverImage
    || '';

  const overlay = document.createElement('div');
  overlay.id = 'steam-dialog';
  overlay.className = 'dialog-overlay';
  overlay.innerHTML = `
    <div class="dialog-box" style="max-width:400px;">
      ${coverImage ? `
      <div style="display:flex;justify-content:center;margin-bottom:14px;">
        <img src="${escapeHtml(coverImage)}"
             alt="${escapeHtml(title || gameId)}"
             style="max-width:100%;max-height:160px;object-fit:contain;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,0.5);"
             onerror="this.style.display='none'"/>
      </div>` : ''}
      <div class="dialog-title" style="text-align:center;margin-bottom:16px;">Add to Steam</div>
      <div class="dialog-field">
        <label>Game Name</label>
        <input type="text" id="steam-name" value="${escapeHtml(title || gameId)}" autocomplete="off"/>
      </div>
      <div class="dialog-field">
        <label>Executable</label>
        <input type="text" id="steam-exec" value="${escapeHtml(execPath || '')}" autocomplete="off"/>
      </div>
      <div class="dialog-actions">
        <button id="steam-cancel-btn" class="action-btn-secondary">Cancel</button>
        <button id="steam-confirm-btn" class="dl-button" style="padding:8px 20px;font-size:13px;">Add to Steam</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  $('steam-cancel-btn').onclick = () => overlay.remove();
  overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
  $('steam-confirm-btn').onclick = async () => {
    const confirmBtn = $('steam-confirm-btn');
    confirmBtn.disabled = true;
    confirmBtn.innerHTML = `<span class="btn-spinner"></span> Adding…`;
    const opts = {
      gameId,
      execPath: $('steam-exec').value.trim() || execPath,
      title:    $('steam-name').value.trim() || title,
      launchArgs: '',
      startDir:   '',
    };
    const result = await window.api.addToSteamLib(opts);
    if (result && result.ok) {
      confirmBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" style="vertical-align:middle;margin-right:4px"><polyline points="1.5,6 4.5,9.5 10.5,2.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>Added!`;
      if (result.stdout) setStatus(result.stdout.slice(0, 120));
      setTimeout(() => overlay.remove(), 1800);
    } else {
      confirmBtn.textContent = 'Add to Steam';
      confirmBtn.disabled = false;
      if (result && result.error) setStatus(`Steam error: ${result.error}`);
    }
  };
}

async function loadGamePageInfo(game) {
  try {
    const info = await window.api.getGamePage(game.url);
    appState.gamePageInfo = info;
    if (info.error) { showActionState('error'); setStatus('Failed to load game info.'); return; }
    if (info.bannerImage) detailBannerBg.style.backgroundImage = safeCssUrl(info.bannerImage);
    if (info.size) {
      detailSizeSpan.textContent = info.size;
      // Keep SGDB bottom meta size in sync if active
      const sgdbSizeWrap = $('detail-bottom-size-wrap');
      if (sgdbSizeWrap && $('detail-banner').classList.contains('sgdb-mode')) {
        sgdbSizeWrap.innerHTML = `<span class="meta-chip">${$('detail-size').innerHTML}</span>`;
      }
    }
    if (info.description) {
      detailDesc.textContent = info.description;
    }

    // ── Trailer button ────────────────────────────────────────
    function applyTrailerVideoId(videoId) {
      if (!videoId) return;
      if (detailTrailerBtn) {
        detailTrailerBtn.classList.remove('hidden');
        detailTrailerBtn.onclick = () => openTrailer(videoId, appState.currentGame?.title);
      }
      if (detailTrailerBtnDone) {
        detailTrailerBtnDone.classList.remove('hidden');
        detailTrailerBtnDone.onclick = () => openTrailer(videoId, appState.currentGame?.title);
      }
    }

    if (info.trailerVideoId) {
      applyTrailerVideoId(info.trailerVideoId);
    } else if (game.url && game.url.includes('ankergames.net')) {
      // Raw HTML didn't have the video ID (JS-rendered) — use hidden BrowserWindow
      window.api.getTrailerVideoId(game.url).then(videoId => {
        if (videoId && appState.currentGame?.url === game.url) applyTrailerVideoId(videoId);
      }).catch(() => {});
    }

    // ── Screenshots carousel ──────────────────────────────────
    const ssEl = $('detail-screenshots');
    if (info.screenshots && info.screenshots.length > 0) {
      const shots = info.screenshots;
      const n = shots.length;
      ssEl.innerHTML = `
        <div class="ss-carousel">
          <div class="ss-track-wrap">
            <button class="ss-arrow ss-prev" id="ss-prev" aria-label="Previous">&#8249;</button>
            <div class="ss-track" id="ss-track" style="width:${n * 100}%">
              ${shots.map((src, idx) => `
                <div class="ss-slide" style="width:${100 / n}%">
                  <img src="${escapeHtml(src)}" alt="Screenshot ${idx + 1}" loading="lazy"
                       onerror="this.closest('.ss-slide').style.display='none'"
                       data-src="${escapeHtml(src)}"/>
                </div>`).join('')}
            </div>
            <button class="ss-arrow ss-next" id="ss-next" aria-label="Next">&#8250;</button>
          </div>
          <div class="ss-dots" id="ss-dots">
            ${shots.map((_, i) => `<button class="ss-dot ${i === 0 ? 'active' : ''}" data-i="${i}"></button>`).join('')}
          </div>
        </div>`;
      ssEl.classList.remove('hidden');

      let current = 0;
      const dots  = ssEl.querySelectorAll('.ss-dot');
      const track = ssEl.querySelector('#ss-track');

      function goTo(idx) {
        dots[current].classList.remove('active');
        current = (idx + n) % n;
        dots[current].classList.add('active');
        track.style.transform = `translateX(-${(current / n) * 100}%)`;
      }

      ssEl.querySelector('#ss-prev').addEventListener('click', () => goTo(current - 1));
      ssEl.querySelector('#ss-next').addEventListener('click', () => goTo(current + 1));
      dots.forEach(d => d.addEventListener('click', () => goTo(+d.dataset.i)));

      ssEl.querySelector('.ss-track-wrap').addEventListener('click', e => {
        const img = e.target.closest('img[data-src]');
        if (img) openCarouselFullscreen(img.dataset.src, shots);
      });
    } else {
      ssEl.innerHTML = '';
      ssEl.classList.add('hidden');
    }

    // ── System Requirements ───────────────────────────────────
    const sysreqEl = $('detail-sysreq');
    if (info.sysReqItems && info.sysReqItems.length > 0) {
      const rows = info.sysReqItems.map(item => {
        if (item.label) {
          return `<div class="sysreq-row"><span class="sysreq-label">${escapeHtml(item.label)}</span><span class="sysreq-value">${escapeHtml(item.value)}</span></div>`;
        }
        return `<div class="sysreq-note">${escapeHtml(item.value)}</div>`;
      }).join('');
      $('detail-sysreq-content').innerHTML = `<div class="sysreq-grid">${rows}</div>`;
      sysreqEl.classList.remove('hidden');
    } else {
      sysreqEl.classList.add('hidden');
    }
    if (!info.downloadUrl) {
      showActionState('no-link');
      openPageBtn.onclick = () => window.api.openExternal(game.url);
      setStatus(`No download link found for "${game.title}".`);
      return;
    }

    // Don't overwrite the action state if the game is already installed
    const gameIdCheck = gameIdFromUrl(game.url);
    const libCheck = appState.library.find(e => e.id === gameIdCheck || e.id === game.libId);
    if (libCheck && libCheck.status === 'installed') {
      // Game is installed — keep already-installed state, just wire up the download button silently
      dlBtn.onclick = () => startDownload(game, info.downloadUrl);
    } else {
      showActionState('download');
      setStatus(`Ready to install "${game.title}"`);
      dlBtn.onclick = () => startDownload(game, info.downloadUrl);
    }
  } catch (err) {
    showActionState('error');
    setStatus('Error loading game info.');
  }
}

// ── Wishlist ──────────────────────────────────────────────────
async function updateWishlistBtn(game) {
  const id = gameIdFromUrl(game.url);
  const isListed = await window.api.isWishlisted(id);
  detailWish.classList.toggle('wishlisted', isListed);
}

detailWish.addEventListener('click', async () => {
  const game = appState.currentGame;
  if (!game) return;
  const id = gameIdFromUrl(game.url);
  const result = await window.api.toggleWishlist({ id, title: game.title, coverImage: game.image, gameUrl: game.url });
  detailWish.classList.toggle('wishlisted', result);
});

async function refreshWishlistView() {
  const list = await window.api.getWishlist();
  const wishCount = $('wish-count');
  const wishEmpty = $('wish-empty');
  const wishGrid  = $('wish-grid');
  wishCount.textContent = list.length ? `${list.length} game${list.length !== 1 ? 's' : ''}` : '';
  wishEmpty.classList.toggle('hidden', list.length > 0);
  wishGrid.innerHTML = '';
  if (!list.length) return;
  const frag = document.createDocumentFragment();
  list.forEach((entry, i) => {
    const card = document.createElement('div');
    card.className = 'game-card';
    card.style.setProperty('--delay', `${i * 22}ms`);
    card.innerHTML = `
      <div class="gc-cover">
        ${entry.coverImage
          ? `<img src="${escapeHtml(entry.coverImage)}" alt="${escapeHtml(entry.title)}" loading="lazy"/>`
          : `<div class="gc-placeholder"></div>`}
        <div class="gc-overlay"><span class="gc-view-label">VIEW</span></div>
      </div>
      <div class="gc-info">
        <div class="gc-title">${escapeHtml(entry.title || entry.id)}</div>
      </div>`;
    card.addEventListener('click', () => {
      if (entry.gameUrl) openGameDetail({ url: entry.gameUrl, title: entry.title, image: entry.coverImage, version: null });
    });
    frag.appendChild(card);
  });
  wishGrid.appendChild(frag);
}

// ── Multiplayer ─────────────────────────────────────────────────
let _mpMods = [];

function fmtMpBytes(n) {
  if (!n) return '';
  return fmtBytes(n);
}

// ── Styled confirm ────────────────────────────────────────────
// Replaces window.confirm(), which in a frameless Electron window renders as an
// unstyled OS dialog and blocks the renderer thread while it is open. Resolves
// false on Escape, backdrop click, or Cancel.
function showConfirm({ title, body, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false }) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'dialog-overlay';
    overlay.innerHTML = `
      <div class="dialog-box" style="width:400px;max-width:90vw">
        <div class="dialog-title" style="margin-bottom:10px">${escapeHtml(title)}</div>
        <div style="font-size:13px;color:var(--text-secondary,#929292);line-height:1.6;margin-bottom:20px">${escapeHtml(body)}</div>
        <div class="dialog-actions" style="display:flex;gap:10px;justify-content:flex-end">
          <button id="_cf-no" class="action-btn-secondary" style="padding:8px 16px;font-size:13px;font-family:var(--font);background:transparent;color:var(--text-secondary,#929292);border:1px solid var(--border,#282828);border-radius:var(--radius-sm,6px);cursor:pointer">${escapeHtml(cancelLabel)}</button>
          <button id="_cf-yes" style="padding:8px 18px;font-size:13px;font-weight:700;font-family:var(--font);border:none;border-radius:var(--radius-sm,6px);cursor:pointer;${danger
            ? 'background:#b91c1c;color:#fff'
            : 'background:linear-gradient(135deg,#0ea5e9,#60CDFF);color:#000'}">${escapeHtml(confirmLabel)}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    let settled = false;
    const close = val => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      resolve(val);
    };
    const onKey = e => {
      if (e.key === 'Escape') close(false);
      if (e.key === 'Enter')  close(true);
    };

    overlay.querySelector('#_cf-yes').onclick = () => close(true);
    overlay.querySelector('#_cf-no').onclick  = () => close(false);
    overlay.addEventListener('click', e => { if (e.target === overlay) close(false); });
    document.addEventListener('keydown', onKey);
    overlay.querySelector('#_cf-yes').focus();
  });
}

// Bumped on every rebuild. The SteamGridDB art for a card arrives well after
// the card is built, and the user can switch tabs or trigger a refresh in the
// meantime — without this token those late callbacks write images into cards
// that have already been thrown away.
let _mpRenderGen = 0;
let mpFilterTxt = '';   // multiplayer page search box

// Nobody searches for "Call of Duty" — they type "cod". Reducing the game title
// to its initials ("Call of Duty Modern Warfare 2" -> "codmw2") makes the
// abbreviation everyone actually uses match, and does the same for "gta",
// without maintaining a hand-written alias list.
function mpAcronym(title) {
  return String(title || '').split(/\s+/).filter(Boolean).map(w => w[0]).join('').toLowerCase();
}

const MP_ICONS = {
  check: '<svg width="11" height="11" viewBox="0 0 12 12" fill="none"><polyline points="1.5,6 4.4,8.8 10.5,2.4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  warn:  '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 1.6L13 12H1L7 1.6Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><line x1="7" y1="5.6" x2="7" y2="8.4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><circle cx="7" cy="10.2" r=".75" fill="currentColor"/></svg>',
  folder:'<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M1.5 3.5h11v8a1 1 0 01-1 1h-9a1 1 0 01-1-1v-8z" stroke="currentColor" stroke-width="1.2"/><path d="M1.5 3.5l1.5-2h4l1.5 2" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>',
  search:'<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="6" cy="6" r="4.2" stroke="currentColor" stroke-width="1.25"/><line x1="9.2" y1="9.2" x2="12.5" y2="12.5" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/></svg>',
  play:  '<svg width="11" height="11" viewBox="0 0 11 11" fill="none"><polygon points="2.2,1 9.6,5.5 2.2,10" fill="currentColor"/></svg>',
  down:  '<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M6 1.5v6.4M3.4 5.6L6 8.2l2.6-2.6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M2 9.8h8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  link:  '<svg width="13" height="13" viewBox="0 0 13 13" fill="none"><path d="M5 3H3.5a1.5 1.5 0 00-1.5 1.5v5A1.5 1.5 0 003.5 11h5A1.5 1.5 0 0010 9.5V8M7.5 2H11v3.5M11 2L6 7" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

// Everything the card needs to know about a mod's state, worked out once so the
// markup below stays declarative. The old version scattered this across a
// four-branch if/else that left `statusText` empty for the ready-to-install
// case, so the most common state was the one with no label at all.
function mpCardState(mod) {
  const game      = mod.matchedGame;
  const gameOk    = !!game && game.status === 'installed';
  const manualMod = mod.installType === 'existing';

  if (mod.installed) {
    return {
      badge: { cls: 'mp-status-installed', icon: MP_ICONS.check, text: manualMod ? 'Detected' : 'Installed' },
      req: game
        ? { cls: 'ok', icon: MP_ICONS.folder, title: game.title, sub: 'Installed', tip: game.installDir }
        : null,
      action: { kind: 'launch', label: manualMod ? 'Launch Game' : 'Launch Multiplayer' },
      canUninstall: !manualMod,
      blocked: false,
    };
  }

  if (manualMod) {
    return {
      badge: { cls: 'mp-status-missing', icon: '', text: 'Manual install' },
      req: { cls: 'miss', icon: MP_ICONS.search, title: 'Not detected on this PC', sub: 'Install it yourself, then it appears here automatically' },
      action: { kind: 'none', label: 'Install manually' },
      canUninstall: false,
      blocked: true,
    };
  }

  if (gameOk) {
    return {
      badge: { cls: 'mp-status-ready', icon: '', text: 'Ready to install' },
      req: { cls: 'ok', icon: MP_ICONS.folder, title: game.title, sub: 'Installed', tip: game.installDir },
      action: { kind: 'install', label: 'Install' },
      canUninstall: false,
      blocked: false,
    };
  }

  if (game) {
    return {
      badge: { cls: 'mp-status-warn', icon: '', text: 'Game not installed' },
      req: { cls: 'warn', icon: MP_ICONS.warn, title: game.title, sub: 'In your library, but not installed yet' },
      action: { kind: 'install', label: 'Install', disabled: true },
      canUninstall: false,
      blocked: true,
    };
  }

  return {
    badge: { cls: 'mp-status-missing', icon: '', text: 'Base game missing' },
    req: { cls: 'miss', icon: MP_ICONS.search, title: mod.gameTitle || 'Base game required', sub: 'Not found in your library' },
    action: { kind: 'install', label: 'Install', disabled: true },
    canUninstall: false,
    blocked: true,
  };
}

async function refreshMultiplayerView({ animate = false } = {}) {
  const grid  = $('mp-grid');
  const empty = $('mp-empty');
  const count = $('mp-count');
  if (!grid) return;

  const gen = ++_mpRenderGen;

  try {
    _mpMods = await window.api.getMultiplayerMods();
  } catch {
    _mpMods = [];
  }
  if (gen !== _mpRenderGen) return; // a newer refresh already took over

  // Match on everything a user might reasonably type: the mod's own name, what
  // it does, and the game it is for — searching "cod" or "gta" should work as
  // well as searching "iw4x".
  const shown = mpFilterTxt
    ? _mpMods.filter(m => [m.name, m.tagline, m.gameTitle, m.id, mpAcronym(m.gameTitle)]
        .some(v => String(v || '').toLowerCase().includes(mpFilterTxt)))
    : _mpMods;

  const n = shown.length;
  count.textContent = mpFilterTxt
    ? `${n} of ${_mpMods.length}`
    : (n ? `${n} supported title${n !== 1 ? 's' : ''}` : '');
  count.style.display = (n || mpFilterTxt) ? '' : 'none';
  empty.classList.toggle('hidden', n > 0);
  // The empty state has to explain which of the two nothings this is.
  const emptyMsg = empty.querySelector('p');
  if (emptyMsg) {
    emptyMsg.textContent = mpFilterTxt
      ? `No multiplayer mods match "${mpFilterTxt}".`
      : 'No supported multiplayer mods found.';
  }
  grid.innerHTML = '';
  if (!n) return;

  const frag = document.createDocumentFragment();

  shown.forEach((mod, i) => {
    const st   = mpCardState(mod);
    const card = document.createElement('div');
    card.className = 'mp-card2' + (st.blocked ? ' is-blocked' : '') + (animate ? ' animate-in' : '');
    card.style.setProperty('--i', i);
    card.dataset.modId = mod.id;

    const actionBtn = st.action.kind === 'none'
      ? `<button class="mp-btn-primary" disabled>${escapeHtml(st.action.label)}</button>`
      : `<button class="mp-btn-primary" data-action="${st.action.kind}"${st.action.disabled ? ' disabled' : ''}>` +
        `${st.action.kind === 'launch' ? MP_ICONS.play : MP_ICONS.down}${escapeHtml(st.action.label)}</button>`;

    card.innerHTML = `
      <div class="mp-card2-hero">
        <div class="mp-card2-hero-bg"></div>
        <div class="mp-card2-hero-overlay"></div>
        <div class="mp-card2-hero-content">
          <div class="mp-card2-logo-wrap">
            <span class="mp-card2-logo-fallback">${escapeHtml(mod.name)}</span>
          </div>
        </div>
        <div class="mp-card2-hero-meta">
          <span class="mp-status-badge ${st.badge.cls}">${st.badge.icon}${escapeHtml(st.badge.text)}</span>
        </div>
      </div>
      <div class="mp-card2-body">
        <div class="mp-card2-header">
          <div class="mp-card2-tagline">${escapeHtml(mod.tagline || '')}</div>
          ${mod.sourceUrl
            ? `<a href="#" class="mp-card2-src-link" data-open-source="${escapeHtml(safeUrl(mod.sourceUrl))}" title="${escapeHtml(mod.sourceUrl)}">${MP_ICONS.link}</a>`
            : ''}
        </div>
        ${st.req ? `
          <div class="mp-req ${st.req.cls}">
            <span class="mp-req-icon">${st.req.icon}</span>
            <span class="mp-req-text">
              <span class="mp-req-title">${escapeHtml(st.req.title)}</span>
              <span class="mp-req-sub" title="${escapeHtml(st.req.tip || st.req.sub)}">${escapeHtml(st.req.sub)}</span>
            </span>
          </div>` : ''}
        ${mod.note ? `<div class="mp-card2-note">${escapeHtml(mod.note)}</div>` : ''}
        <div class="mp-card2-footer">
          <div class="mp-card2-actions">
            ${actionBtn}
            ${st.canUninstall ? `<button class="mp-btn-secondary" data-action="uninstall">Uninstall</button>` : ''}
          </div>
          <div class="mp-card-progress mp-card2-progress">
            <div class="mp-bar-track"><div class="mp-bar-fill"></div></div>
            <div class="mp-progress-label"><span class="mp-progress-text"></span><span class="mp-progress-pct"></span></div>
          </div>
        </div>
      </div>`;

    // ── Cover art (SteamGridDB) ──
    const heroBg    = card.querySelector('.mp-card2-hero-bg');
    const logoWrap  = card.querySelector('.mp-card2-logo-wrap');
    const sgdbTitle = mod.sgdbTitle || mod.gameTitle || mod.name;
    if (sgdbTitle) {
      fetchSgdbAssets(sgdbTitle).then(assets => {
        // Both guards matter: the generation check drops art for a superseded
        // render, isConnected drops it for a card removed some other way.
        if (!assets || gen !== _mpRenderGen || !card.isConnected) return;

        const heroUrl = safeUrl(assets.hero);
        if (heroUrl && heroBg) {
          const img = new Image();
          img.onload = () => {
            if (gen !== _mpRenderGen || !card.isConnected) return;
            heroBg.style.backgroundImage = safeCssUrl(heroUrl);
            heroBg.classList.add('loaded');
          };
          img.src = heroUrl;
        }

        const logoUrl = safeUrl(assets.logo);
        if (logoUrl && logoWrap) {
          const img = new Image();
          img.onload = () => {
            if (gen !== _mpRenderGen || !card.isConnected) return;
            logoWrap.innerHTML = `<img class="mp-card2-logo" src="${escapeHtml(logoUrl)}" alt="${escapeHtml(mod.name)}"/>`;
          };
          img.src = logoUrl;
        }
      }).catch(() => {});
    }

    // ── Actions ──
    const srcLink = card.querySelector('[data-open-source]');
    if (srcLink) srcLink.addEventListener('click', e => {
      e.preventDefault();
      const u = srcLink.dataset.openSource;
      if (u) window.api.openExternal(u);
    });

    const installBtn = card.querySelector('[data-action="install"]');
    if (installBtn) installBtn.addEventListener('click', async () => {
      if (installBtn.disabled) return;
      installBtn.disabled = true;
      installBtn.innerHTML = `<span class="mp-spin"></span>Installing…`;
      mpSetProgress(card, { active: true, text: 'Starting…' });

      let result;
      try {
        result = await window.api.installMultiplayerMod(mod.id);
      } catch (err) {
        result = { error: err?.message || 'Unexpected error' };
      }

      if (result && result.error) {
        // The old code left the progress bar switched on and stuck at whatever
        // the last tick showed, so a failed install looked like a running one.
        mpSetProgress(card, { active: true, failed: true, text: result.error });
        setStatus(`${mod.name} install failed: ${result.error}`);
        installBtn.disabled = false;
        installBtn.innerHTML = `${MP_ICONS.down}Retry install`;
      } else {
        setStatus(`${mod.name} installed.`);
        refreshMultiplayerView();
      }
    });

    const launchBtn = card.querySelector('[data-action="launch"]');
    if (launchBtn) launchBtn.addEventListener('click', async () => {
      if (launchBtn.disabled) return;
      const original = launchBtn.innerHTML;
      launchBtn.disabled = true;
      launchBtn.innerHTML = `<span class="mp-spin"></span>Launching…`;
      let result;
      try {
        result = await window.api.launchMultiplayerMod(mod.id);
      } catch (err) {
        result = { error: err?.message || 'Unexpected error' };
      }
      if (result && result.error) setStatus(`Launch failed: ${result.error}`);
      else setStatus(`Launching ${mod.name}…`);
      // Restore rather than leaving a permanent spinner — the game runs in its
      // own process and there is no "stopped" event to switch this back.
      setTimeout(() => {
        if (!card.isConnected) return;
        launchBtn.disabled = false;
        launchBtn.innerHTML = original;
      }, 2500);
    });

    const uninstallBtn = card.querySelector('[data-action="uninstall"]');
    if (uninstallBtn) uninstallBtn.addEventListener('click', async () => {
      const ok = await showConfirm({
        title: `Uninstall ${mod.name}?`,
        body: 'This removes the mod files it installed. Your base game is left untouched.',
        confirmLabel: 'Uninstall',
        danger: true,
      });
      if (!ok) return;
      uninstallBtn.disabled = true;
      uninstallBtn.textContent = 'Removing…';
      try {
        const res = await window.api.uninstallMultiplayerMod(mod.id);
        if (res && res.error) setStatus(`Uninstall failed: ${res.error}`);
      } catch (err) {
        setStatus(`Uninstall failed: ${err?.message || 'Unexpected error'}`);
      }
      refreshMultiplayerView();
    });

    frag.appendChild(card);
  });

  grid.appendChild(frag);
}

// Single place that owns the card's progress strip, so no caller can leave it
// half-configured (active but stale, or failed but still animating).
function mpSetProgress(card, { active, pct, text, indeterminate, failed } = {}) {
  if (!card) return;
  const wrap  = card.querySelector('.mp-card-progress');
  if (!wrap) return;
  const fill  = card.querySelector('.mp-bar-fill');
  const label = card.querySelector('.mp-progress-text');
  const pctEl = card.querySelector('.mp-progress-pct');

  wrap.classList.toggle('active', !!active);
  wrap.classList.toggle('indeterminate', !!indeterminate);
  wrap.classList.toggle('failed', !!failed);

  if (fill && !indeterminate) fill.style.width = `${Math.max(0, Math.min(100, pct || 0))}%`;
  if (label) label.textContent = text || '';
  if (pctEl) pctEl.textContent = (!indeterminate && typeof pct === 'number') ? `${pct}%` : '';
}

if (window.api.onMpModProgress) {
  window.api.onMpModProgress(({ modId, phase, pct, msg, recv, total, error }) => {
    // Look the card up by scanning rather than building a CSS selector out of
    // modId — an id containing a quote or bracket would throw out of the whole
    // handler, and mod ids come from a JSON file rather than from us.
    const card = [...document.querySelectorAll('.mp-card2')]
      .find(c => c.dataset.modId === modId);
    if (!card) return;

    if (phase === 'downloading') {
      mpSetProgress(card, {
        active: true,
        pct: pct || 0,
        text: total ? `Downloading ${fmtMpBytes(recv)} / ${fmtMpBytes(total)}` : 'Downloading…',
      });
    } else if (phase === 'extracting') {
      // No percentage is available here, so sweep rather than parking at 100%,
      // which used to read as "finished but frozen".
      mpSetProgress(card, { active: true, indeterminate: true, text: msg || 'Extracting…' });
    } else if (phase === 'done') {
      mpSetProgress(card, { active: true, pct: 100, text: 'Installed' });
      setTimeout(() => refreshMultiplayerView(), 600);
    } else if (phase === 'failed') {
      mpSetProgress(card, { active: true, failed: true, pct: 100, text: error || 'Install failed' });
      const btn = card.querySelector('[data-action="install"]');
      if (btn) { btn.disabled = false; btn.innerHTML = `${MP_ICONS.down}Retry install`; }
    } else {
      mpSetProgress(card, { active: true, indeterminate: true, text: msg || 'Working…' });
    }
  });
}

// ── Antivirus Exclusion Prompt ────────────────────────────────
// Shown before download if the user hasn't already added a Defender exclusion.
// Only shown when settings.defenderExclusionAdded !== true.
(function () {
  const overlay        = $('defender-overlay');
  const panelMain      = $('defender-panel-main');
  const panelConfirm   = $('defender-panel-confirm');
  const panelAdding    = $('defender-panel-adding');
  const closeBtn       = $('defender-close');
  const yesBtn         = $('defender-yes');
  const noBtn          = $('defender-no');
  const confirmSkip    = $('defender-confirm-skip');
  const confirmBack    = $('defender-confirm-back');
  const addingSpinner  = $('defender-adding-spinner');
  const addingResult   = $('defender-adding-result');
  const addingContinue = $('defender-adding-continue');

  let _pendingResolve = null;

  function showPanel(name) {
    [panelMain, panelConfirm, panelAdding].forEach(p => p && p.classList.add('hidden'));
    const target = { main: panelMain, confirm: panelConfirm, adding: panelAdding }[name];
    if (target) target.classList.remove('hidden');
  }

  function dismiss(proceed) {
    overlay.classList.add('hidden');
    if (_pendingResolve) { _pendingResolve(proceed); _pendingResolve = null; }
  }

  window._showDefenderPrompt = async function () {
    // If exclusion already added (from onboarding or a prior run), skip the prompt
    const settings = await window.api.getSettings();
    if (settings.defenderExclusionAdded) return true;

    return new Promise(resolve => {
      _pendingResolve = resolve;
      // Reset to main panel
      showPanel('main');
      if (addingSpinner)  addingSpinner.classList.remove('hidden');
      if (addingResult)   addingResult.classList.add('hidden');
      overlay.classList.remove('hidden');
    });
  };

  // Close / X button → cancel download
  if (closeBtn) closeBtn.addEventListener('click', () => dismiss(false));
  if (overlay)  overlay.addEventListener('click', e => { if (e.target === overlay) dismiss(false); });

  // YES → add exclusion then proceed
  if (yesBtn) yesBtn.addEventListener('click', async () => {
    showPanel('adding');
    if (addingSpinner) addingSpinner.classList.remove('hidden');
    if (addingResult)  addingResult.classList.add('hidden');

    const settings = await window.api.getSettings();
    const installDir = settings.installPath || `C:\\Users\\${(window._ninoUser?.username) || '___'}\\NinoGames`;

    try {
      const result = await window.api.addDefenderExclusion(installDir);
      if (addingSpinner) addingSpinner.classList.add('hidden');
      if (addingResult) {
        addingResult.classList.remove('hidden');
        if (result && result.ok) {
          addingResult.textContent  = 'Exclusion added successfully';
          addingResult.style.color  = '#2ed573';
          // Persist so we never ask again
          await window.api.saveSettings({ defenderExclusionAdded: true });
        } else {
          addingResult.textContent = 'Failed to add exclusion (may need admin rights). Continuing anyway.';
          addingResult.style.color = '#f59e0b';
        }
      }
    } catch (_) {
      if (addingSpinner) addingSpinner.classList.add('hidden');
      if (addingResult) {
        addingResult.classList.remove('hidden');
        addingResult.textContent = 'Could not add exclusion. Continuing anyway.';
        addingResult.style.color = '#f59e0b';
      }
    }

    if (addingContinue) addingContinue.onclick = () => dismiss(true);
  });

  // NO → show "are you sure?" panel
  if (noBtn) noBtn.addEventListener('click', () => showPanel('confirm'));

  // Confirm: skip anyway → proceed without exclusion
  if (confirmSkip) confirmSkip.addEventListener('click', () => dismiss(true));

  // Confirm: go back → return to main panel
  if (confirmBack) confirmBack.addEventListener('click', () => showPanel('main'));
})();

// ── Download ──────────────────────────────────────────────────
async function startDownload(game, downloadUrl) {
  const gameId = gameIdFromUrl(game.url);
  const proceed = await window._showDefenderPrompt();
  if (!proceed) return;

  // ── Disk space pre-check ──────────────────────────────────
  // We need the game's download size. The detail page already fetched it;
  // if it's available in the parsed info, use it. Otherwise skip.
  const sizeText = appState.gamePageInfo?.size;
  if (sizeText) {
    // Parse the size string — e.g. "12.4 GB", "850 MB", "3.2GB"
    const sizeMatch = sizeText.match(/([\d.]+)\s*(GB|MB|KB)/i);
    if (sizeMatch) {
      const amount = parseFloat(sizeMatch[1]);
      const unit   = sizeMatch[2].toUpperCase();
      let sizeBytes = amount;
      if (unit === 'GB') sizeBytes = amount * 1024 ** 3;
      else if (unit === 'MB') sizeBytes = amount * 1024 ** 2;
      else if (unit === 'KB') sizeBytes = amount * 1024;

      // User needs at least 2× the zip size (zip + extracted copy)
      const required = sizeBytes * 2;

      try {
        const diskInfo = await window.api.checkDiskSpace();
        if (diskInfo && diskInfo.free !== null && diskInfo.free < required) {
          const freeGB = (diskInfo.free / 1024 ** 3).toFixed(1);
          const needGB = (required / 1024 ** 3).toFixed(1);
          const gameGB = (sizeBytes / 1024 ** 3).toFixed(1);

          // Show styled HTML dialog instead of native confirm()
          const userWantsDownload = await new Promise(resolve => {
            const overlay = document.createElement('div');
            overlay.className = 'dialog-overlay';
            overlay.innerHTML = `
              <div class="dialog-box" style="width:400px">
                <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px">
                  <svg width="22" height="22" viewBox="0 0 22 22" fill="none" style="flex-shrink:0">
                    <path d="M11 2L20.5 19H1.5L11 2Z" stroke="#f59e0b" stroke-width="1.6" stroke-linejoin="round"/>
                    <line x1="11" y1="8.5" x2="11" y2="13.5" stroke="#f59e0b" stroke-width="1.6" stroke-linecap="round"/>
                    <circle cx="11" cy="16.5" r="0.9" fill="#f59e0b"/>
                  </svg>
                  <div class="dialog-title" style="margin:0;color:#f59e0b">Not Enough Disk Space</div>
                </div>
                <div style="font-size:13px;color:var(--text-secondary,#a6adc8);line-height:1.6;margin-bottom:18px">
                  <strong style="color:var(--text-primary,#cdd6f4)">${escapeHtml(game.title)}</strong> requires space for both the download and extraction.
                  <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:14px">
                    <div style="background:var(--bg-input,#1e1e2e);border:1px solid var(--border,#45475a);border-radius:8px;padding:10px 12px">
                      <div style="font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:var(--text-dim,#6c7086);margin-bottom:4px">Download size</div>
                      <div style="font-size:16px;font-weight:700;color:var(--text-primary,#cdd6f4)">${gameGB} GB</div>
                    </div>
                    <div style="background:var(--bg-input,#1e1e2e);border:1px solid var(--border,#45475a);border-radius:8px;padding:10px 12px">
                      <div style="font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:var(--text-dim,#6c7086);margin-bottom:4px">Space needed</div>
                      <div style="font-size:16px;font-weight:700;color:#f59e0b">${needGB} GB</div>
                    </div>
                  </div>
                  <div style="margin-top:10px;padding:8px 12px;background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.25);border-radius:6px;color:#f87171;font-size:12px">
                    You only have <strong>${freeGB} GB</strong> free. Free up at least <strong>${(required - diskInfo.free > 0 ? ((required - diskInfo.free) / 1024**3).toFixed(1) : 0)} GB</strong> before installing.
                  </div>
                </div>
                <div class="dialog-actions">
                  <button id="_disk-cancel" class="action-btn-secondary">Cancel</button>
                  <button id="_disk-proceed" style="padding:8px 18px;font-size:13px;background:#b45309;color:#fff;border:none;border-radius:var(--radius-sm,6px);cursor:pointer;font-family:var(--font)">Download Anyway</button>
                </div>
              </div>`;
            document.body.appendChild(overlay);
            overlay.querySelector('#_disk-cancel').onclick  = () => { overlay.remove(); resolve(false); };
            overlay.querySelector('#_disk-proceed').onclick = () => { overlay.remove(); resolve(true); };
            overlay.addEventListener('click', e => { if (e.target === overlay) { overlay.remove(); resolve(false); } });
          });

          if (!userWantsDownload) return;
        }
      } catch (_) {
        // Disk check failed — don't block download
      }
    }
  }

  showActionState('preparing');
  dlProgressTitle.textContent = game.title;
  setStatus(`Starting install for "${game.title}"…`);
  appState.library = await window.api.getLibrary();
  appState.dlStartTimes[gameId] = { startTime: Date.now(), startBytes: 0 };
  const source = appState.settings.source || 'ankergames';

  const result = await window.api.startDownload({
    downloadUrl, gameUrl: game.url,
    gameId, title: game.title, coverImage: game.image, source,
  });
  if (result.error) {
    showActionState('failed');
    dlRetryBtn.onclick = () => loadGamePageInfo(game);
    setStatus(`Install failed: ${result.error}`);
  }
}

function showDownloadProgress(dl) {
  if (q('#action-progress.hidden') !== null && !q('#action-progress:not(.hidden)')) showActionState('progress');
  dlProgressTitle.textContent = appState.currentGame?.title || '';
  dlProgressPct.textContent   = `${dl.pct || 0}%`;
  dlBarFill.style.width       = `${dl.pct || 0}%`;
  dlProgressBytes.textContent = dl.msg || '';
  const speed = fmtSpeed(dl.speed);
  dlSpeedBadge.textContent    = speed;
  dlSpeedBadge.style.display  = speed ? '' : 'none';
  if (dl.recv && dl.total && dl.speed) {
    dlEtaBadge.textContent = fmtEta(dl.recv, dl.total, dl.speed);
    dlEtaBadge.style.display = '';
  } else {
    dlEtaBadge.style.display = 'none';
  }
  if (dlPauseBtn) dlPauseBtn.textContent = dl.paused ? 'Resume' : 'Pause';
}

if (dlPauseBtn) {
  dlPauseBtn.addEventListener('click', async () => {
    const game = appState.currentGame;
    if (!game) return;
    const gameId = gameIdFromUrl(game.url);
    const dl = appState.downloads[gameId];
    if (dl && dl.paused) {
      await window.api.resumeDownload(gameId);
      dl.paused = false;
      dlPauseBtn.textContent = 'Pause';
    } else {
      await window.api.pauseDownload(gameId);
      if (dl) dl.paused = true;
      dlPauseBtn.textContent = 'Resume';
    }
  });
}

[dlCancelBtn, dlCancelBtn2].forEach(btn => {
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const game = appState.currentGame;
    if (!game) return;
    const gameId = gameIdFromUrl(game.url);
    await window.api.cancelDownload(gameId);
    delete appState.downloads[gameId];
    showActionState('download');
    setStatus('Download cancelled.');
  });
});

if (dlRetryBtn) dlRetryBtn.addEventListener('click', () => {
  if (appState.currentGame && appState.gamePageInfo?.downloadUrl)
    startDownload(appState.currentGame, appState.gamePageInfo.downloadUrl);
});

if (actionErrorRetry) actionErrorRetry.addEventListener('click', () => {
  if (appState.currentGame) loadGamePageInfo(appState.currentGame);
});

async function confirmUninstall(gameId, title) {
  if (!await showConfirm({
    title: 'Uninstall game?',
    body: `This deletes the installed files for ${title}. Your saves are not touched unless the game stores them in its own folder.`,
    confirmLabel: 'Uninstall', danger: true,
  })) return;
  await window.api.uninstallGame(gameId);
  showActionState('download');
  if (appState.gamePageInfo?.downloadUrl)
    dlBtn.onclick = () => startDownload(appState.currentGame, appState.gamePageInfo.downloadUrl);
  setStatus(`${title} uninstalled.`);
}

// ── Discord presence gating ───────────────────────────────────
// Main already refuses to talk to a closed Discord, but download progress fires
// every second and each updateRPC is an IPC round-trip. Mirror the connection
// state here so those ticks stop at the renderer instead.
let rpcConnected = false;
window.api.onRpcStatus?.(({ connected }) => { rpcConnected = !!connected; });
window.api.rpcAvailable?.().then(v => { rpcConnected = !!v; }).catch(() => {});

// ── Download events ───────────────────────────────────────────
window.api.onDownloadProgress(({ gameId, recv, total, pct, state, msg, speed }) => {
  const wasDownloading = appState.downloads[gameId]?._presenceSet;
  appState.downloads[gameId] = { ...(appState.downloads[gameId] || {}), pct, msg, state, speed, recv, total };
  // ── Discord RPC ─────────────────────────────────────────
  if (rpcConnected && window.api.updateRPC) {
    const dlEntry = appState.library.find(e => e.id === gameId) || appState.downloads[gameId];
    const dlTitle = dlEntry?.title || gameId;
    window.api.updateRPC({
      details: `Downloading ${dlTitle}`,
      state: `${pct}% — ${msg || ''}`.trim().replace(/—\s*$/, ''),
      largeImageKey: 'logo',
      largeImageText: 'NinoGames',
      startTimestamp: Math.floor(Date.now() / 1000),
    }).catch(() => {});
  }
  if (appState.currentPage === 'detail' && appState.currentGame &&
      gameIdFromUrl(appState.currentGame.url) === gameId) {
    // At 100% the file is done — switch to extracting immediately so the UI
    // doesn't freeze on "100%" while the archive is being unpacked.
    if (pct >= 100) {
      showActionState('extracting');
      dlExtractMsg.textContent = 'Extracting files…';
    } else {
      const progressVisible = !$('action-progress').classList.contains('hidden');
      if (progressVisible) {
        // Update in-place, no animation re-trigger
        dlProgressPct.textContent   = `${pct || 0}%`;
        dlBarFill.style.width       = `${pct || 0}%`;
        dlProgressBytes.textContent = msg || '';
        const speedStr = fmtSpeed(speed);
        dlSpeedBadge.textContent    = speedStr;
        dlSpeedBadge.style.display  = speedStr ? '' : 'none';
        if (recv && total && speed) { dlEtaBadge.textContent = fmtEta(recv, total, speed); dlEtaBadge.style.display = ''; }
        else dlEtaBadge.style.display = 'none';
      } else {
        showDownloadProgress(appState.downloads[gameId]);
      }
    }
  }
  setStatus(msg);
  updateDownloadBadge();
  if (appState.currentPage === 'library') {
    // Always update in-place — never full-rebuild during active download
    // (full rebuild replays CSS entrance animations on every progress tick)
    const barFill = libGrid.querySelector(`[data-lid="${gameId}"] .lib-bar-fill`);
    if (barFill) {
      barFill.style.width = `${pct}%`;
      const pctEl = barFill.closest('.lib-bar-wrap')?.querySelector('.lib-bar-pct');
      if (pctEl) pctEl.textContent = `${pct}%`;
      const bytesEl = barFill.closest('.lib-card-progress')?.querySelector('.lib-bar-bytes');
      if (bytesEl) bytesEl.textContent = msg || '';
      const speedEl = barFill.closest('.lib-card-info')?.querySelector('.lib-speed');
      if (speedEl) {
        const sp = fmtSpeed(speed);
        const eta = (recv && total && speed) ? fmtEta(recv, total, speed) : '';
        speedEl.textContent = sp ? (eta ? `${sp} · ${eta}` : sp) : '';
      }
    } else if (appState.libTab !== 'installed') {
      // Card not rendered yet and we're on downloading tab.
      // Only rebuild if no other refresh is already queued/running to avoid
      // an infinite wipe-and-rebuild loop driven by aria2's 1s progress ticks.
      if (!libRefreshing && !libRefreshQueued) {
        refreshLibraryView();
      }
    }
    // On installed tab: no rebuild needed — installed cards are unaffected by downloads
  }

  // ── Steam panel live progress (mirrors libGrid in-place update) ──
  if (libLayout === 'compact') {
    const barFill2 = document.querySelector(`#lib-steam-list [data-lid="${gameId}"] .lib-bar-fill`);
    if (barFill2) {
      barFill2.style.width = `${pct}%`;
      const pctEl2 = barFill2.closest('.lib-bar-wrap')?.querySelector('.lib-bar-pct');
      if (pctEl2) pctEl2.textContent = `${pct}%`;
      const bytesEl2 = barFill2.closest('.lib-card-progress')?.querySelector('.lib-bar-bytes');
      if (bytesEl2) bytesEl2.textContent = msg || '';
      const speedEl2 = barFill2.closest('.lib-card-info')?.querySelector('.lib-speed');
      if (speedEl2) {
        const sp = fmtSpeed(speed);
        const eta = (recv && total && speed) ? fmtEta(recv, total, speed) : '';
        speedEl2.textContent = sp ? (eta ? `${sp} · ${eta}` : sp) : '';
      }
      const pauseBtn = barFill2.closest('.lib-card')?.querySelector('[data-action="pause"]');
      if (pauseBtn) {
        const isPaused2 = appState.downloads[gameId]?.paused;
        pauseBtn.innerHTML = isPaused2
          ? `<svg width="11" height="11" viewBox="0 0 11 11" fill="none"><polygon points="2,1 10,5.5 2,10" fill="currentColor"/></svg> Resume`
          : `<svg width="11" height="11" viewBox="0 0 11 11" fill="none"><rect x="1.5" y="1" width="3" height="9" rx="1" fill="currentColor"/><rect x="6.5" y="1" width="3" height="9" rx="1" fill="currentColor"/></svg> Pause`;
      }
    }
  }
});

window.api.onDownloadDone(({ gameId, state, installDir, execPath, error }) => {
  // Clear Discord RPC when a download finishes
  if (rpcConnected && window.api.clearRPC) window.api.clearRPC().catch(() => {});
  if (state === 'completed') {
    // Keep temporarily so detail page can read installDir/execPath, then clean up
    appState.downloads[gameId] = { pct: 100, state: 'completed', installDir, execPath };
    if (appState.currentPage === 'detail' && appState.currentGame &&
        gameIdFromUrl(appState.currentGame.url) === gameId) {
      showActionState('done');
      if (openFolderBtn) openFolderBtn.onclick = () => window.api.openPath(installDir);
      if (launchBtn) launchBtn.onclick = () => launchGameWithPicker(gameId);
      setupExtraButtons(gameId, installDir, execPath, '');
    }
    setStatus('Install complete!');
    // Remove from active downloads so library-updated guard doesn't block rebuilds
    delete appState.downloads[gameId];
  } else {
    delete appState.downloads[gameId];
    if (appState.currentPage === 'detail' && appState.currentGame &&
        gameIdFromUrl(appState.currentGame.url) === gameId) {
      // Always show download button after cancel/fail — library entry is gone on cancel
      showActionState('download');
    }
    // 'extract-failed' means the archive downloaded fine and is still on disk —
    // saying "Download failed" there sends the user off to re-download 60 GB for
    // nothing, so name what actually broke.
    setStatus(
      state === 'cancelled'      ? 'Download cancelled.'
      : state === 'extract-failed' ? (error || 'Extraction failed — use Retry Extraction, the download is kept.')
      : (error || 'Download failed.')
    );
  }
  updateDownloadBadge();
  refreshLibraryView();
});

// ── UAC confirm dialog (shown before 7-Zip extraction) ────────
window.api.onUacConfirmNeeded(({ gameId } = {}) => {
  // A second prompt used to silently replace the first, leaving that download
  // stuck on "Extracting…" with nothing left to answer it. Decline the older
  // one explicitly so its extraction resolves (and keeps its archive).
  const existing = document.getElementById('_uac-overlay');
  if (existing) {
    const prevId = existing.dataset.gameId;
    existing.remove();
    if (prevId && prevId !== gameId) window.api.sendUacResponse(false, prevId);
  }

  const overlay = document.createElement('div');
  overlay.id = '_uac-overlay';
  overlay.className = 'dialog-overlay';
  overlay.dataset.gameId = gameId || '';
  overlay.innerHTML = `
    <div class="dialog-box" style="width:410px;max-width:90vw">
      <div style="display:flex;align-items:flex-start;gap:13px;margin-bottom:16px">
        <div style="width:40px;height:40px;border-radius:9px;background:rgba(96,205,255,.12);border:1px solid rgba(96,205,255,.25);display:flex;align-items:center;justify-content:center;flex-shrink:0">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
            <path d="M12 2L2 7v5c0 5.5 4.1 10.7 10 12 5.9-1.3 10-6.5 10-12V7L12 2z" stroke="#60CDFF" stroke-width="1.8" stroke-linejoin="round"/>
            <path d="M9 12l2 2 4-4" stroke="#60CDFF" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </div>
        <div>
          <div style="font-size:14px;font-weight:700;color:var(--text-primary,#cdd6f4);margin-bottom:3px">Administrator Access Required</div>
          <div style="font-size:12.5px;color:var(--text-secondary,#a6adc8);line-height:1.55">Windows will ask for permission to run 7-Zip as administrator for extraction. Click <strong style="color:var(--text-primary,#cdd6f4)">Yes</strong> on the UAC prompt that appears.</div>
        </div>
      </div>
      <div id="_uac-warning" class="hidden" style="background:rgba(245,158,11,.08);border:1px solid rgba(245,158,11,.25);border-radius:7px;padding:10px 13px;margin-bottom:14px;font-size:12px;color:#fbbf24;line-height:1.6">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" style="vertical-align:middle;display:inline-block"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg> Skipping admin access may cause extraction to fail or files to be incomplete. Are you sure?
      </div>
      <div style="display:flex;gap:10px;justify-content:flex-end">
        <button id="_uac-skip" style="padding:8px 16px;font-size:13px;background:transparent;color:var(--text-secondary,#a6adc8);border:1px solid var(--border,#45475a);border-radius:var(--radius-sm,6px);cursor:pointer;font-family:var(--font)">Skip</button>
        <button id="_uac-ok" style="padding:8px 20px;font-size:13px;background:linear-gradient(135deg,#0ea5e9,#60CDFF);color:#000;font-weight:700;border:none;border-radius:var(--radius-sm,6px);cursor:pointer;font-family:var(--font);box-shadow:0 2px 10px rgba(96,205,255,.3)">Continue as Administrator</button>
      </div>
    </div>`;

  document.body.appendChild(overlay);

  const warning = overlay.querySelector('#_uac-warning');
  const skipBtn = overlay.querySelector('#_uac-skip');
  const okBtn   = overlay.querySelector('#_uac-ok');
  let skipPressed = false;

  okBtn.onclick = () => {
    overlay.remove();
    window.api.sendUacResponse(true, gameId);
  };

  skipBtn.onclick = () => {
    if (!skipPressed) {
      // First click: show warning, change buttons
      skipPressed = true;
      warning.classList.remove('hidden');
      skipBtn.textContent = 'Cancel Extraction';
      skipBtn.style.color = '#f87171';
      skipBtn.style.borderColor = 'rgba(248,113,113,.4)';
      okBtn.textContent = 'Continue Anyway';
    } else {
      // Second click: actually cancel
      overlay.remove();
      window.api.sendUacResponse(false, gameId);
    }
  };
});

window.api.onDownloadStatus(({ gameId, msg }) => {
  if (appState.currentPage === 'detail' && appState.currentGame &&
      gameIdFromUrl(appState.currentGame.url) === gameId) {
    showActionState('preparing');
    dlStatusMsg.textContent = msg;
  }
  setStatus(msg);
});

window.api.onExtractProgress(({ gameId, msg }) => {
  if (appState.currentPage === 'detail' && appState.currentGame &&
      gameIdFromUrl(appState.currentGame.url) === gameId) {
    showActionState('extracting');
    dlExtractMsg.textContent = msg;
  }
  setStatus(msg);
  // Update library card extract message in-place without full rebuild
  if (appState.currentPage === 'library') {
    const bytesEl = libGrid.querySelector(`[data-lid="${gameId}"] .lib-bar-bytes`);
    if (bytesEl) bytesEl.textContent = msg;
  }
});

window.api.onLibraryUpdated(async () => {
  appState.library = await window.api.getLibrary();
  // Fetch prices for any newly installed games (no-op if already cached)
  fetchMissingPrices();
  if (appState.currentPage === 'library') {
    const hasActiveDownload = Object.values(appState.downloads).some(
      d => d.state !== 'completed' && d.pct > 0 && d.pct < 100
    );
    if (hasActiveDownload) return;
    refreshLibraryView();
  }
});

// ── Steam-style sidebar+detail (compact mode only) ────────────
let libSteamSelectedId = null;

function populateLibSteamSidebar() {
  const list = document.getElementById('lib-steam-list');
  if (!list) return;
  const activeStatuses = appState.libTab === 'installed'
    ? ['installed']
    : ['downloading', 'preparing', 'paused', 'extracting', 'extract-failed', 'failed', 'cancelled'];
  const entries = (appState.library || [])
    .filter(e => activeStatuses.includes(e.status))
    .filter(e => !hiddenGames.has(e.id) || showHiddenGames);
  list.innerHTML = '';
  if (!entries.length) return;

  const frag = document.createDocumentFragment();
  entries.forEach((rawEntry, i) => {
    const entry = applyFixMapping(rawEntry);
    const dl        = appState.downloads[entry.id];
    const pct       = dl?.pct ?? entry.percent ?? 0;
    const speed     = dl?.speed ?? 0;
    const speedStr  = fmtSpeed(speed);
    const recv      = dl?.recv ?? entry.receivedBytes ?? 0;
    const total     = dl?.total ?? entry.totalBytes ?? 0;
    const etaStr    = speedStr ? fmtEta(recv, total, speed) : '';
    const paused    = dl?.paused;
    const isDownloading = ['downloading','preparing'].includes(entry.status);
    const isPaused      = entry.status === 'paused';
    const isExtracting  = entry.status === 'extracting';
    const isInstalled   = entry.status === 'installed';
    const isExtractFailed = entry.status === 'extract-failed';
    const isFailed      = ['failed','cancelled','extract-failed'].includes(entry.status);
    const isUnrecognised = !entry.coverImage && !entry.fixed && isInstalled;
    const isHidden      = hiddenGames.has(entry.id);

    const statusLabel = {
      installed: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" style="vertical-align:middle;margin-right:4px"><polyline points="1.5,6 4.5,9.5 10.5,2.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>Installed',
      downloading: 'Downloading…', preparing: 'Preparing…',
      paused: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" style="vertical-align:middle;margin-right:4px"><rect x="2" y="1.5" width="3" height="9" rx="1" fill="currentColor"/><rect x="7" y="1.5" width="3" height="9" rx="1" fill="currentColor"/></svg>Paused',
      extracting: 'Extracting…', cancelled: 'Cancelled',
      // 'failed' / 'extract-failed' deliberately fall through to statusMsg — a
      // bare "Failed" tells the user nothing about what to do next.
    }[entry.status] || entry.statusMsg || entry.status;

    const card = document.createElement('div');
    card.className = 'lib-card' + (entry.id === libSteamSelectedId ? ' lib-steam-selected' : '');
    card.dataset.lid = entry.id;
    card.style.setProperty('--delay', `${i * 20}ms`);

    card.innerHTML = `
      <div class="lib-card-top">
        ${entry.coverImage
          ? `<img class="lib-card-cover" src="${escapeHtml(entry.coverImage)}" alt="" loading="lazy"/>`
          : `<div class="lib-card-cover-ph"></div>`}
        <div class="lib-card-info">
          <div class="lib-card-text">
            <div class="lib-card-title">${escapeHtml(entry.title || entry.id)}</div>
            <div class="lib-card-status ${entry.status}">${statusLabel}</div>
            ${speedStr ? `<div class="lib-speed">${escapeHtml(speedStr)}${etaStr ? ` · ${etaStr}` : ''}</div>` : ''}
          </div>
          <div class="lib-card-actions-row">
            ${isInstalled ? `<button class="lib-btn-launch" data-action="launch" data-id="${escapeHtml(entry.id)}"><svg width="11" height="11" viewBox="0 0 11 11" fill="none"><polygon points="2,1 10,5.5 2,10" fill="currentColor"/></svg>Play</button>` : ''}
            ${isDownloading || isPaused ? `
              <button class="lib-btn${isPaused || paused ? ' success' : ''}" data-action="pause" data-id="${escapeHtml(entry.id)}">
                ${isPaused || paused
                  ? `<svg width="11" height="11" viewBox="0 0 11 11" fill="none"><polygon points="2,1 10,5.5 2,10" fill="currentColor"/></svg> Resume`
                  : `<svg width="11" height="11" viewBox="0 0 11 11" fill="none"><rect x="1.5" y="1" width="3" height="9" rx="1" fill="currentColor"/><rect x="6.5" y="1" width="3" height="9" rx="1" fill="currentColor"/></svg> Pause`}
              </button>
              <button class="lib-btn danger" data-action="cancel" data-id="${escapeHtml(entry.id)}">Cancel</button>` : ''}
            ${isExtractFailed && entry.canRetryExtract ? `<button class="lib-btn success" data-action="retry-extract" data-id="${escapeHtml(entry.id)}"><svg width="11" height="11" viewBox="0 0 11 11" fill="none"><path d="M10 5.5A4.5 4.5 0 1 1 7.7 1.6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M7.3 1h2.7v2.7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg> Retry Extraction</button>` : ''}
            ${isFailed ? `<button class="lib-btn danger" data-action="remove" data-id="${escapeHtml(entry.id)}">Remove</button>` : ''}
          </div>
          <div class="lib-verify-result hidden" data-verify-id="${escapeHtml(entry.id)}"></div>
        </div>
      </div>
      ${(isDownloading || isPaused) ? `
        <div class="lib-card-progress">
          <div class="lib-bar-wrap">
            <div class="lib-bar-track"><div class="lib-bar-fill" style="width:${pct}%"></div></div>
            <div class="lib-bar-pct">${pct}%</div>
          </div>
          <div class="lib-bar-bytes">${escapeHtml(entry.statusMsg || '')}</div>
        </div>` : ''}
      ${isExtracting ? `
        <div class="lib-card-progress">
          <div class="lib-bar-wrap">
            <div class="lib-bar-track"><div class="lib-bar-fill extracting" style="width:100%"></div></div>
          </div>
          <div class="lib-bar-bytes">${escapeHtml(entry.statusMsg || 'Extracting…')}</div>
        </div>` : ''}`;

    // Click on card body (not action buttons) → open in detail panel
    card.addEventListener('click', e => {
      if (e.target.closest('[data-action]')) return;
      libSteamSelectedId = entry.id;
      list.querySelectorAll('.lib-card').forEach(c => c.classList.remove('lib-steam-selected'));
      card.classList.add('lib-steam-selected');
      openLibSteamDetail(entry);
    });

    frag.appendChild(card);
  });

  list.appendChild(frag);

  // Wire action buttons (same as refreshLibraryView does via event delegation)
  list.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const action = btn.dataset.action;
      const id     = btn.dataset.id;
      const libEntry = appState.library.find(e2 => e2.id === id);
      if (action === 'launch')  { launchGameWithPicker(id); }
      if (action === 'pause')   {
        const dl2 = appState.downloads[id];
        if (libEntry && (libEntry.status === 'paused' || dl2?.paused)) {
          await window.api.resumeDownload(id);
          if (dl2) dl2.paused = false;
        } else {
          await window.api.pauseDownload(id);
          if (dl2) dl2.paused = true;
        }
        refreshLibraryView();
      }
      if (action === 'cancel')  { await window.api.cancelDownload(id); refreshLibraryView(); }
      if (action === 'remove')  { await window.api.removeGame(id); refreshLibraryView(); }
      if (action === 'retry-extract') {
        btn.disabled = true;
        btn.textContent = 'Extracting…';
        const res = await window.api.retryExtract(id);
        if (res?.error) setStatus(res.error);
        refreshLibraryView();
      }
    });
  });

  // Auto-select
  if (!libSteamSelectedId && entries.length) {
    openLibSteamDetail(applyFixMapping(entries[0]));
  } else if (libSteamSelectedId) {
    const still = entries.find(e => e.id === libSteamSelectedId);
    if (still) openLibSteamDetail(applyFixMapping(still));
  }
}

function openLibSteamDetail(entry) {
  libSteamSelectedId = entry.id;
  // Highlight selected card in sidebar
  document.querySelectorAll('#lib-steam-list .lib-card').forEach(c =>
    c.classList.toggle('lib-steam-selected', c.dataset.lid === entry.id));

  // openInstalledDetail expects: { url, image, title, version, libId }
  // Library entries use: { gameUrl, coverImage, title, version, id }
  if (window.openInstalledDetail) {
    appState.prevPage = 'library';
    window.openInstalledDetail({
      url:     entry.gameUrl    || null,
      image:   entry.coverImage || null,
      title:   entry.title,
      version: entry.version    || null,
      libId:   entry.id,
    }, false);
  }
}

// ── Library view ──────────────────────────────────────────────
async function refreshLibraryView() {
  if (libRefreshing) { libRefreshQueued = true; return; }
  libRefreshing = true;
  try {
    await _doRefreshLibraryView();
    while (libRefreshQueued) {
      libRefreshQueued = false;
      await _doRefreshLibraryView();
    }
    // Resolve unrecognised games in the background, then redraw if any of
    // them got a real title and cover out of it.
    autoFixUnrecognised(appState.library).then(fixed => {
      if (fixed) _doRefreshLibraryView();
    }).catch(() => {});
  } finally {
    libRefreshing = false;
    libRefreshQueued = false;
  }
}

async function _doRefreshLibraryView() {
  appState.library = await window.api.getLibrary();
  const activeStatuses = appState.libTab === 'installed'
    ? ['installed']
    : ['downloading', 'preparing', 'paused', 'extracting', 'extract-failed', 'failed', 'cancelled'];
  let games = appState.library.filter(e => activeStatuses.includes(e.status))
    .filter(e => showHiddenGames || !hiddenGames.has(e.id) || e.status !== 'installed');

  // ── Text filter (installed tab only) ─────────────────────
  if (appState.libTab === 'installed' && libFilterTxt) {
    games = games.filter(e => (e.title || e.id).toLowerCase().includes(libFilterTxt));
  }

  // ── Sort (installed tab only) ─────────────────────────────
  if (appState.libTab === 'installed') {
    const _tracking = await window.api.getTracking().catch(() => ({}));
    games = [...games].sort((a, b) => {
      switch (libSort) {
        case 'title-desc':
          return (b.title || b.id).localeCompare(a.title || a.id);
        case 'last-played': {
          const la = a.lastPlayed ? new Date(a.lastPlayed).getTime() : 0;
          const lb = b.lastPlayed ? new Date(b.lastPlayed).getTime() : 0;
          return lb - la;
        }
        case 'playtime': {
          const pa = _tracking[a.id]?.totalSeconds || 0;
          const pb = _tracking[b.id]?.totalSeconds || 0;
          return pb - pa;
        }
        case 'added': {
          const da = a.addedAt ? new Date(a.addedAt).getTime() : 0;
          const db = b.addedAt ? new Date(b.addedAt).getTime() : 0;
          return db - da;
        }
        default: // 'title'
          return (a.title || a.id).localeCompare(b.title || b.id);
      }
    });
  }
  const hiddenCount = appState.library.filter(e => e.status === 'installed' && hiddenGames.has(e.id)).length;
  const hiddenBtn = $('lib-show-hidden-btn');
  if (hiddenBtn) {
    hiddenBtn.classList.toggle('active', showHiddenGames);
    hiddenBtn.innerHTML = showHiddenGames
      ? `<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M1 6s2-4 5-4 5 4 5 4-2 4-5 4-5-4-5-4z" stroke="currentColor" stroke-width="1.2" fill="none"/><circle cx="6" cy="6" r="1.5" stroke="currentColor" stroke-width="1.2"/></svg> Hide Hidden`
      : `<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M1 6s2-4 5-4 5 4 5 4-2 4-5 4-5-4-5-4z" stroke="currentColor" stroke-width="1.2" fill="none"/><circle cx="6" cy="6" r="1.5" stroke="currentColor" stroke-width="1.2"/><line x1="2" y1="2" x2="10" y2="10" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/></svg> Show Hidden${hiddenCount > 0 ? ` (${hiddenCount})` : ''}`;
    hiddenBtn.style.display = appState.libTab === 'installed' ? '' : 'none';
  }
  libCount.textContent = appState.library.length
    ? `${appState.library.length} game${appState.library.length !== 1 ? 's' : ''}` : '';
  scheduleMoneySaved();
  // Show "Clear Failed" button only on downloading tab when there are failed/cancelled entries
  const clearFailedBtn = $('lib-clear-failed-btn');
  if (clearFailedBtn) {
    const failedCount = appState.library.filter(e => ['failed', 'cancelled', 'extract-failed'].includes(e.status)).length;
    clearFailedBtn.style.display = (appState.libTab !== 'installed' && failedCount > 0) ? '' : 'none';
    clearFailedBtn.innerHTML = `<svg width="10" height="10" viewBox="0 0 10 10" fill="none" style="vertical-align:middle;margin-right:5px"><line x1="1" y1="1" x2="9" y2="9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><line x1="9" y1="1" x2="1" y2="9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>Clear Failed (${failedCount})`;
  }
  $('lib-empty-msg').textContent = appState.libTab === 'installed' ? 'No installed games yet.' : 'No active downloads.';
  libEmpty.classList.toggle('hidden', games.length > 0);
  libGrid.innerHTML = '';
  const frag = document.createDocumentFragment();
  games.forEach((rawEntry, i) => {
    const entry = applyFixMapping(rawEntry);
    const isUnrecognised = !entry.coverImage && !entry.fixed && entry.status === 'installed';
    const card = document.createElement('div');
    card.className = 'lib-card';
    card.dataset.lid = entry.id;
    card.style.setProperty('--delay', `${i * 30}ms`);
    const dl = appState.downloads[entry.id];
    const pct      = dl?.pct ?? entry.percent ?? 0;
    const speed    = dl?.speed ?? 0;
    const speedStr = fmtSpeed(speed);
    const paused   = dl?.paused;
    const recv     = dl?.recv ?? entry.receivedBytes ?? 0;
    const total    = dl?.total ?? entry.totalBytes ?? 0;
    const etaStr   = speedStr ? fmtEta(recv, total, speed) : '';
    const isDownloading = ['downloading','preparing'].includes(entry.status);
    const isPaused      = entry.status === 'paused';
    const isExtracting  = entry.status === 'extracting';
    const isInstalled   = entry.status === 'installed';
    const isExtractFailed = entry.status === 'extract-failed';
    const isFailed      = ['failed','cancelled','extract-failed'].includes(entry.status);
    const statusLabel = {
      installed: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" style="vertical-align:middle;margin-right:4px"><polyline points="1.5,6 4.5,9.5 10.5,2.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>Installed', downloading: 'Downloading…', preparing: 'Preparing…',
      paused: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" style="vertical-align:middle;margin-right:4px"><rect x="2" y="1.5" width="3" height="9" rx="1" fill="currentColor"/><rect x="7" y="1.5" width="3" height="9" rx="1" fill="currentColor"/></svg>Paused', extracting: 'Extracting…', cancelled: 'Cancelled',
      // 'failed' / 'extract-failed' deliberately fall through to statusMsg — a
      // bare "Failed" tells the user nothing about what to do next.
    }[entry.status] || entry.statusMsg || entry.status;

    const isHidden = hiddenGames.has(entry.id);

    card.innerHTML = `
      <div class="lib-card-top">
        ${entry.coverImage
          ? `<img class="lib-card-cover" src="${escapeHtml(entry.coverImage)}" alt="" loading="lazy"/>`
          : `<div class="lib-card-cover-ph"></div>`}
        <div class="lib-card-info">
          <div class="lib-card-text">
            <div class="lib-card-title">${escapeHtml(entry.title || entry.id)}</div>
            <div class="lib-card-status ${entry.status}">${statusLabel}</div>
            ${speedStr ? `<div class="lib-speed">${escapeHtml(speedStr)}${etaStr ? ` · ${etaStr}` : ''}</div>` : ''}
          </div>
          <div class="lib-card-actions-row">
            ${isInstalled ? `
              <button class="lib-btn-launch" data-action="launch" data-id="${escapeHtml(entry.id)}">
                <svg width="11" height="11" viewBox="0 0 11 11" fill="none"><polygon points="2,1 10,5.5 2,10" fill="currentColor"/></svg>
                Play
              </button>` : ''}
            ${isDownloading || isPaused ? `
              <button class="lib-btn${isPaused || paused ? ' success' : ''}" data-action="pause" data-id="${escapeHtml(entry.id)}">
                ${isPaused || paused
                  ? `<svg width="11" height="11" viewBox="0 0 11 11" fill="none"><polygon points="2,1 10,5.5 2,10" fill="currentColor"/></svg> Resume`
                  : `<svg width="11" height="11" viewBox="0 0 11 11" fill="none"><rect x="1.5" y="1" width="3" height="9" rx="1" fill="currentColor"/><rect x="6.5" y="1" width="3" height="9" rx="1" fill="currentColor"/></svg> Pause`}
              </button>
              <button class="lib-btn danger" data-action="cancel" data-id="${escapeHtml(entry.id)}">Cancel</button>` : ''}
            ${isExtractFailed && entry.canRetryExtract ? `<button class="lib-btn success" data-action="retry-extract" data-id="${escapeHtml(entry.id)}"><svg width="11" height="11" viewBox="0 0 11 11" fill="none"><path d="M10 5.5A4.5 4.5 0 1 1 7.7 1.6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M7.3 1h2.7v2.7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg> Retry Extraction</button>` : ''}
            ${isFailed ? `<button class="lib-btn danger" data-action="remove" data-id="${escapeHtml(entry.id)}">Remove</button>` : ''}
            ${isInstalled ? `
              <div class="lib-kebab-wrap">
                <button class="lib-kebab-btn" data-kebab="${escapeHtml(entry.id)}" title="More options">
                  <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
                    <circle cx="7.5" cy="3" r="1.2" fill="currentColor"/>
                    <circle cx="7.5" cy="7.5" r="1.2" fill="currentColor"/>
                    <circle cx="7.5" cy="12" r="1.2" fill="currentColor"/>
                  </svg>
                </button>
                <div class="lib-kebab-dropdown" id="kebab-${escapeHtml(entry.id)}">
                  ${entry.installDir ? `
                  <button class="lib-kebab-item" data-action="open" data-path="${escapeHtml(entry.installDir)}">
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M1.5 3.5h11v8a1 1 0 01-1 1h-9a1 1 0 01-1-1v-8z" stroke="currentColor" stroke-width="1.2"/><path d="M1.5 3.5l1.5-2h4l1.5 2" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>
                    Open Folder
                  </button>` : ''}
                  <button class="lib-kebab-item" data-action="steam" data-id="${escapeHtml(entry.id)}">
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="5.5" stroke="currentColor" stroke-width="1.2"/><path d="M4.5 7.5l1.5 1.5 4-4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
                    Add to Steam
                  </button>
                  <button class="lib-kebab-item" data-action="shortcut" data-id="${escapeHtml(entry.id)}">
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><rect x="2" y="2" width="10" height="10" rx="2" stroke="currentColor" stroke-width="1.2"/><path d="M5 7h4M7 5v4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>
                    Desktop Shortcut
                  </button>
                  <button class="lib-kebab-item verify-btn" data-action="verify" data-id="${escapeHtml(entry.id)}">
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="6" cy="6" r="4" stroke="currentColor" stroke-width="1.2"/><line x1="9" y1="9" x2="12.5" y2="12.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>
                    Verify Files
                  </button>
                  <div class="lib-kebab-divider"></div>
                  <button class="lib-kebab-item" data-action="hide" data-id="${escapeHtml(entry.id)}">
                    ${isHidden
                      ? `<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M1 7s2.5-4 6-4 6 4 6 4-2.5 4-6 4-6-4-6-4z" stroke="currentColor" stroke-width="1.2"/><circle cx="7" cy="7" r="1.8" stroke="currentColor" stroke-width="1.2"/></svg> Show in Library`
                      : `<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M1 7s2.5-4 6-4 6 4 6 4-2.5 4-6 4-6-4-6-4z" stroke="currentColor" stroke-width="1.2"/><circle cx="7" cy="7" r="1.8" stroke="currentColor" stroke-width="1.2"/><line x1="2" y1="2" x2="12" y2="12" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg> Hide from Library`}
                  </button>
                  <div class="lib-kebab-divider"></div>
                  <button class="lib-kebab-item danger" data-action="uninstall" data-id="${escapeHtml(entry.id)}" data-title="${escapeHtml(entry.title || '')}">
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2.5 4.5h9l-1 7h-7l-1-7z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M5 4.5V3a.5.5 0 01.5-.5h3a.5.5 0 01.5.5v1.5" stroke="currentColor" stroke-width="1.2"/><line x1="1.5" y1="4.5" x2="12.5" y2="4.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>
                    Uninstall
                  </button>
                </div>
              </div>` : ''}
          </div>
          <div class="lib-verify-result hidden" data-verify-id="${escapeHtml(entry.id)}"></div>
          ${isUnrecognised ? `<button class="fix-unrecognised-btn" data-action="fix" data-id="${escapeHtml(entry.id)}"><svg width="13" height="13" viewBox="0 0 13 13" fill="none" style="vertical-align:middle;margin-right:4px"><path d="M6.5 1.5L12 11.5H1L6.5 1.5Z" stroke="#f59e0b" stroke-width="1.3" stroke-linejoin="round"/><line x1="6.5" y1="5" x2="6.5" y2="8.5" stroke="#f59e0b" stroke-width="1.3" stroke-linecap="round"/><circle cx="6.5" cy="10" r="0.7" fill="#f59e0b"/></svg>Unrecognised Game — Click Here to Fix</button>` : ''}
        </div>
      </div>
      ${(isDownloading || isPaused) ? `
        <div class="lib-card-progress">
          <div class="lib-bar-wrap">
            <div class="lib-bar-track"><div class="lib-bar-fill" style="width:${pct}%"></div></div>
            <div class="lib-bar-pct">${pct}%</div>
          </div>
          <div class="lib-bar-bytes">${escapeHtml(entry.statusMsg || '')}</div>
        </div>` : ''}
      ${isExtracting ? `
        <div class="lib-card-progress">
          <div class="lib-bar-wrap">
            <div class="lib-bar-track"><div class="lib-bar-fill" style="width:100%;animation:pulse 1.2s infinite;background:linear-gradient(90deg,var(--green),#86efac)"></div></div>
          </div>
          <div class="lib-bar-bytes" style="color:var(--green)">Extracting…</div>
        </div>` : ''}`;

    // ── Kebab button toggle ──────────────────────────────────────
    card.querySelectorAll('[data-kebab]').forEach(kebabBtn => {
      const gameId  = kebabBtn.dataset.kebab;
      // The dropdown lives inside the card in the DOM (for data/event access)
      // but we clone & portal it to document.body to escape card animation stacking context
      const dropdownSource = card.querySelector(`#kebab-${gameId}`);
      if (!dropdownSource) return;

      kebabBtn.addEventListener('click', e => {
        e.stopPropagation();

        // If this button's portal is already open, just close it
        const existing = document.getElementById('kebab-portal');
        if (existing && existing.dataset.forGameId === gameId) {
          existing.remove();
          kebabBtn.classList.remove('open');
          return;
        }

        // Close any open portal
        document.getElementById('kebab-portal')?.remove();
        document.querySelectorAll('.lib-kebab-btn.open').forEach(b => b.classList.remove('open'));

        // Clone the dropdown and portal it to body
        const portal = dropdownSource.cloneNode(true);
        portal.id = 'kebab-portal';
        portal.dataset.forGameId = gameId;
        portal.classList.add('open');
        portal.style.position = 'fixed';
        portal.style.zIndex   = '99999';

        // Position: right-align to the button
        const rect = kebabBtn.getBoundingClientRect();
        const dropW = 180;
        let leftPos = rect.right - dropW;
        if (leftPos < 4) leftPos = 4;
        if (leftPos + dropW > window.innerWidth - 4) leftPos = window.innerWidth - dropW - 4;
        portal.style.top  = (rect.bottom + 5) + 'px';
        portal.style.left = leftPos + 'px';

        document.body.appendChild(portal);
        kebabBtn.classList.add('open');

        // Wire up clicks inside the portal to the real action handlers
        portal.querySelectorAll('[data-action]').forEach(btn => {
          btn.addEventListener('click', async ev => {
            ev.stopPropagation();
            portal.remove();
            kebabBtn.classList.remove('open');
            const action = btn.dataset.action;
            const id     = btn.dataset.id;
            const libEntry = appState.library.find(e2 => e2.id === id);
            if (action === 'open')     { window.api.openPath(btn.dataset.path); }
            if (action === 'steam')    { openAddToSteamDialog(id, libEntry?.execPath, libEntry?.title, libEntry?.coverImage); }
            if (action === 'shortcut') { window.openShortcutPicker(id); }
            if (action === 'uninstall') {
              if (!await showConfirm({
                title: 'Uninstall game?',
                body: `This deletes the installed files for ${btn.dataset.title}.`,
                confirmLabel: 'Uninstall', danger: true,
              })) return;
              await window.api.uninstallGame(id);
              refreshLibraryView();
            }
            if (action === 'hide') { toggleHideGame(id); }
            if (action === 'verify') {
              btn.disabled = true;
              btn.innerHTML = `<span class="btn-spinner"></span> Verifying…`;
              const resultEl = card.querySelector(`[data-verify-id="${id}"]`);
              try {
                const r = await window.api.verifyInstall(id);
                if (resultEl) {
                  resultEl.classList.remove('hidden', 'verify-ok', 'verify-warn', 'verify-error');
                  if (r.error) {
                    resultEl.classList.add('verify-error');
                    resultEl.innerHTML = `<svg width="13" height="13" viewBox="0 0 13 13" fill="none" style="vertical-align:middle;margin-right:4px"><path d="M6.5 1.5L12 11.5H1L6.5 1.5Z" stroke="#f59e0b" stroke-width="1.3" stroke-linejoin="round"/><line x1="6.5" y1="5" x2="6.5" y2="8.5" stroke="#f59e0b" stroke-width="1.3" stroke-linecap="round"/><circle cx="6.5" cy="10" r="0.7" fill="#f59e0b"/></svg>${r.error}`;
                  } else if (r.verdict === 'ok') {
                    resultEl.classList.add('verify-ok');
                    resultEl.innerHTML = `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" style="vertical-align:middle;margin-right:4px"><polyline points="1.5,6 4.5,9.5 10.5,2.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>Files OK`;
                  } else {
                    resultEl.classList.add('verify-warn');
                    resultEl.innerHTML = `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" style="vertical-align:middle;margin-right:4px"><path d="M6 10V2M2 6l4-4 4 4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>Update available`;
                  }
                  resultEl.classList.remove('hidden');
                }
              } catch {}
            }
          });
        });

        // Close on outside click
        const closeOnOutside = ev => {
          if (!portal.contains(ev.target) && ev.target !== kebabBtn) {
            portal.remove();
            kebabBtn.classList.remove('open');
            document.removeEventListener('click', closeOnOutside, true);
          }
        };
        document.addEventListener('click', closeOnOutside, true);

        // Close on scroll (lib-content scroll)
        const closeOnScroll = () => {
          portal.remove();
          kebabBtn.classList.remove('open');
        };
        const libContent = document.getElementById('lib-content');
        if (libContent) libContent.addEventListener('scroll', closeOnScroll, { once: true });
      });
    });

    card.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', async e => {
        e.stopPropagation();
        // close any open kebab dropdown
        card.querySelectorAll('.lib-kebab-dropdown.open').forEach(d => {
          d.classList.remove('open');
          d.previousElementSibling?.classList.remove('open');
        });
        const action = btn.dataset.action;
        const id     = btn.dataset.id;
        const libEntry = appState.library.find(e2 => e2.id === id);
        if (action === 'launch')   { launchGameWithPicker(id); }
        if (action === 'open')     { window.api.openPath(btn.dataset.path); }
        if (action === 'steam')    { openAddToSteamDialog(id, libEntry?.execPath, libEntry?.title, libEntry?.coverImage); }
        if (action === 'shortcut') {
          window.openShortcutPicker(id);
        }
        if (action === 'uninstall') {
          if (!await showConfirm({
            title: 'Uninstall game?',
            body: `This deletes the installed files for ${btn.dataset.title}.`,
            confirmLabel: 'Uninstall', danger: true,
          })) return;
          await window.api.uninstallGame(id);
          refreshLibraryView();
        }
        if (action === 'hide') {
          toggleHideGame(id);
        }
        if (action === 'verify') {
          btn.disabled = true;
          btn.innerHTML = `<span class="btn-spinner"></span> Verifying…`;
          const resultEl = btn.closest('.lib-card-info')?.querySelector(`[data-verify-id="${id}"]`);
          try {
            const r = await window.api.verifyInstall(id);
            btn.disabled = false;
            btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" style="vertical-align:middle;margin-right:4px"><circle cx="5" cy="5" r="3.5" stroke="currentColor" stroke-width="1.3"/><line x1="8" y1="8" x2="11" y2="11" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>Verify';
            if (resultEl) {
              resultEl.classList.remove('hidden', 'verify-ok', 'verify-warn', 'verify-error');
              if (r.error) {
                resultEl.classList.add('verify-error');
                resultEl.innerHTML = `<svg width="13" height="13" viewBox="0 0 13 13" fill="none" style="vertical-align:middle;margin-right:4px"><path d="M6.5 1.5L12 11.5H1L6.5 1.5Z" stroke="#f59e0b" stroke-width="1.3" stroke-linejoin="round"/><line x1="6.5" y1="5" x2="6.5" y2="8.5" stroke="#f59e0b" stroke-width="1.3" stroke-linecap="round"/><circle cx="6.5" cy="10" r="0.7" fill="#f59e0b"/></svg>${r.error}`;
              } else if (r.verdict === 'ok') {
                const diskStr   = fmtBytes(r.diskSize);
                // Show the server download size (zip) for reference
                const zipStr    = r.serverZipSize ? ` • download: ${fmtBytes(r.serverZipSize)}` : (r.storedZipSize ? ` • zip was ${fmtBytes(r.storedZipSize)}` : '');
                resultEl.classList.add('verify-ok');
                resultEl.innerHTML = `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" style="vertical-align:middle;margin-right:4px"><polyline points="1.5,6 4.5,9.5 10.5,2.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>Files OK — ${diskStr} on disk${zipStr}`;
              } else if (r.verdict === 'outdated') {
                const diskStr   = fmtBytes(r.diskSize);
                const storedStr = fmtBytes(r.storedZipSize);
                const serverStr = fmtBytes(r.serverZipSize);
                resultEl.classList.add('verify-warn');
                resultEl.innerHTML = `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" style="vertical-align:middle;margin-right:4px"><path d="M6 10V2M2 6l4-4 4 4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>Update available — server file changed (was ${storedStr}, now ${serverStr}, ${diskStr} on disk)`;
              } else if (r.verdict === 'corrupt') {
                resultEl.classList.add('verify-error');
                const reason = r.corruptReason || `${fmtBytes(r.diskSize)} on disk`;
                resultEl.innerHTML = `
                  <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                    <span>
                      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style="vertical-align:middle;margin-right:4px"><line x1="1" y1="1" x2="11" y2="11" stroke="#FF6B6B" stroke-width="1.5" stroke-linecap="round"/><line x1="11" y1="1" x2="1" y2="11" stroke="#FF6B6B" stroke-width="1.5" stroke-linecap="round"/></svg>Possibly corrupt — ${reason}
                    </span>
                    <button class="verify-reinstall-btn" style="padding:3px 10px;font-size:11px;font-family:var(--font);background:var(--accent,#60CDFF);color:#000;border:none;border-radius:4px;cursor:pointer;font-weight:600;white-space:nowrap;flex-shrink:0">
                      Reinstall
                    </button>
                  </div>`;
                resultEl.querySelector('.verify-reinstall-btn').addEventListener('click', () => {
                  const libEntry = appState.library.find(e => e.id === id);
                  if (libEntry && libEntry.gameUrl) {
                    appState.prevPage = appState.currentPage;
                    openGameDetail({ url: libEntry.gameUrl, title: libEntry.title, image: libEntry.coverImage, version: null });
                  } else {
                    navigateTo('home');
                    setStatus(`Search for "${libEntry?.title || id}" to reinstall.`);
                  }
                });
              } else if (r.verdict === 'missing') {
                resultEl.classList.add('verify-error');
                resultEl.innerHTML = `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" style="vertical-align:middle;margin-right:4px"><line x1="1" y1="1" x2="11" y2="11" stroke="#FF6B6B" stroke-width="1.5" stroke-linecap="round"/><line x1="11" y1="1" x2="1" y2="11" stroke="#FF6B6B" stroke-width="1.5" stroke-linecap="round"/></svg>Install folder missing — ${r.installDir}`;
              }
              if (r.headError && r.verdict !== 'ok') {
                const note = document.createElement('div');
                note.style.cssText = 'font-size:10px;opacity:0.6;margin-top:2px';
                note.textContent = `(Server check failed: ${r.headError})`;
                resultEl.appendChild(note);
              }
            }
          } catch (err) {
            btn.disabled = false;
            btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" style="vertical-align:middle;margin-right:4px"><circle cx="5" cy="5" r="3.5" stroke="currentColor" stroke-width="1.3"/><line x1="8" y1="8" x2="11" y2="11" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>Verify';
            if (resultEl) {
              resultEl.classList.remove('hidden');
              resultEl.classList.add('verify-error');
              resultEl.innerHTML = `<svg width="13" height="13" viewBox="0 0 13 13" fill="none" style="vertical-align:middle;margin-right:4px"><path d="M6.5 1.5L12 11.5H1L6.5 1.5Z" stroke="#f59e0b" stroke-width="1.3" stroke-linejoin="round"/><line x1="6.5" y1="5" x2="6.5" y2="8.5" stroke="#f59e0b" stroke-width="1.3" stroke-linecap="round"/><circle cx="6.5" cy="10" r="0.7" fill="#f59e0b"/></svg>Error: ${err.message}`;
            }
          }
        }
        if (action === 'cancel') { await window.api.cancelDownload(id); refreshLibraryView(); }
        if (action === 'remove') { await window.api.removeGame(id); refreshLibraryView(); }
        if (action === 'retry-extract') {
          btn.disabled = true;
          btn.textContent = 'Extracting…';
          const res = await window.api.retryExtract(id);
          if (res?.error) setStatus(res.error);
          refreshLibraryView();
        }
        if (action === 'fix') { openFixGameDialog(rawEntry); }
        if (action === 'pause') {
          const dl2 = appState.downloads[id];
          if (libEntry && (libEntry.status === 'paused' || dl2?.paused)) {
            await window.api.resumeDownload(id);
            if (dl2) dl2.paused = false;
          } else {
            await window.api.pauseDownload(id);
            if (dl2) dl2.paused = true;
          }
          refreshLibraryView();
        }
      });
    });

    if (entry.gameUrl) {
      card.style.cursor = 'pointer';
      card.addEventListener('click', e => {
        if (e.target.closest('[data-action]')) return;
        openGameDetail({ url: entry.gameUrl, title: entry.title, image: entry.coverImage, version: null, libId: entry.id });
      });
    }
    // Apply hidden dim
    if (hiddenGames.has(entry.id)) card.classList.add('is-hidden');
    frag.appendChild(card);
  });
  libGrid.appendChild(frag);
  applyLibLayout();
}

detailBack.addEventListener('click', () => navigateTo(appState.prevPage));

// ── Installed Game Detail Page ────────────────────────────────
(function initInstalledDetailPage() {
  const igdBack        = $('igd-back');
  const igdBannerBg    = $('igd-banner-bg');
  const igdCover       = $('igd-cover');
  const igdCoverPh     = $('igd-cover-placeholder');
  const igdTitle       = $('igd-title');
  const igdVersion     = $('igd-version');
  const igdPtVal       = $('igd-playtime-val');
  const igdLpVal       = $('igd-lastplayed-val');
  const igdSizeStat    = $('igd-stat-size');
  const igdSizeSep     = $('igd-size-sep');
  const igdSizeVal     = $('igd-size-val');
  const igdLaunchBtn   = $('igd-launch-btn');
  const igdTrailerBtn  = $('igd-trailer-btn');
  const igdDesc        = $('igd-desc');
  const igdDescSec     = $('igd-desc-section');
  const igdScreenshots = $('igd-screenshots');
  const igdSysreq      = $('igd-sysreq');
  const igdSysreqCont  = $('igd-sysreq-content');
  const igdExeInput    = $('igd-exe-input');
  const igdArgsInput   = $('igd-args-input');
  const igdSkipPicker  = $('igd-skip-picker');
  const igdSaveBtn     = $('igd-save-config-btn');
  const igdSaveMsg     = $('igd-save-msg');
  const igdExeBrowse   = $('igd-exe-browse');
  const igdOpenFolder  = $('igd-open-folder-btn');
  const igdAddSteam    = $('igd-add-steam-btn');
  const igdShortcut    = $('igd-shortcut-btn');
  const igdVerifyBtn   = $('igd-verify-btn');
  const igdHideBtn     = $('igd-hide-btn');
  const igdHideLabel   = $('igd-hide-label');
  const igdHideIcon    = $('igd-hide-icon');
  const igdUninstall   = $('igd-uninstall-btn');
  const igdVerifyRes   = $('igd-verify-result');
  const igdInstallDir  = $('igd-installdir-val');
  const igdDiskSize    = $('igd-disksize-val');
  const igdAddedAt     = $('igd-addedAt-val');
  const igdAddedRow    = $('igd-addedAt-row');
  const igdBanner        = $('igd-banner');
  const igdSgdbBanner    = $('igd-sgdb-banner');
  const igdSgdbLogo      = $('igd-sgdb-logo');
  const igdSubheader     = $('igd-subheader');
  const igdSubTitleEl    = $('igd-title-sub');
  const igdSubVersionEl  = $('igd-version-sub');
  const igdPtValSgdb     = $('igd-playtime-val-sgdb');
  const igdLpValSgdb     = $('igd-lastplayed-val-sgdb');
  const igdLaunchBtnSgdb = $('igd-launch-btn-sgdb');
  const igdTrailerBtnSgdb= $('igd-trailer-btn-sgdb');

  function resetIgdSgdbMode() {
    igdBanner.classList.remove('sgdb-mode', 'sgdb-loading', 'sgdb-fallback-visible');
    igdSgdbBanner.style.transition = 'none';
    igdSgdbLogo.style.transition   = 'none';
    igdSgdbBanner.style.display = 'none';
    igdSgdbBanner.src = '';
    igdSgdbLogo.style.display = 'none';
    igdSgdbLogo.src = '';
    igdSubheader.style.display = 'none';
    requestAnimationFrame(() => {
      igdSgdbBanner.style.transition = '';
      igdSgdbLogo.style.transition   = '';
    });
  }

  function applyIgdSgdbMode(logoUrl, heroUrl) {
    let heroLoaded = false, logoLoaded = false;
    const heroImg = new Image(), logoImg = new Image();
    const applyTransition = () => {
      if (!heroLoaded || !logoLoaded) return;
      igdSgdbBanner.src = heroUrl;
      igdSgdbLogo.src   = logoUrl;
      igdSgdbBanner.style.display = 'block';
      igdSgdbLogo.style.display   = 'block';
      igdSubheader.style.display  = 'flex';
      const sgdbBadge = $('igd-installed-badge-sgdb');
      if (sgdbBadge) sgdbBadge.style.display = 'flex';
      requestAnimationFrame(() => requestAnimationFrame(() => {
        igdBanner.classList.add('sgdb-mode');
      }));
    };
    heroImg.onload = () => { heroLoaded = true; applyTransition(); };
    logoImg.onload = () => { logoLoaded = true; applyTransition(); };
    heroImg.onerror = () => {};
    logoImg.onerror = () => {};
    heroImg.src = heroUrl;
    logoImg.src = logoUrl;
  }

  let _gameId = null;
  let _libEntry = null;

  igdBack.addEventListener('click', () => navigateTo(appState.prevPage));

  function fmtRelativeDate(isoStr) {
    if (!isoStr) return 'Never';
    const d = new Date(isoStr);
    const now = new Date();
    const diff = Math.floor((now - d) / 1000);
    if (diff < 60) return 'Just now';
    if (diff < 3600) return `${Math.floor(diff/60)}m ago`;
    if (diff < 86400) return `Today`;
    if (diff < 172800) return `Yesterday`;
    if (diff < 2592000) return `${Math.floor(diff/86400)} days ago`;
    if (diff < 31536000) return `${Math.floor(diff/2592000)} mo ago`;
    return `${Math.floor(diff/31536000)}y ago`;
  }

  function fmtPlaytime(s) {
    if (!s || s < 60) return s ? `${s}s` : '0m';
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (h === 0) return `${m}m`;
    return m === 0 ? `${h}h` : `${h}h ${m}m`;
  }

  async function loadPageInfo(game) {
    try {
      const info = await window.api.getGamePage(game.url);
      if (!info || info.error) return;
      // Description
      if (info.description) {
        igdDesc.textContent = info.description;
        igdDescSec.classList.remove('hidden');
      }
      // Size chip
      if (info.size) { igdSizeVal.textContent = info.size; igdSizeStat.style.display = ''; igdSizeSep.style.display = ''; }
      // Trailer
      if (info.trailerVideoId && igdTrailerBtn) {
        igdTrailerBtn.classList.remove('hidden');
        igdTrailerBtn.onclick = () => openTrailer(info.trailerVideoId, game.title);
        igdTrailerBtnSgdb.classList.remove('hidden');
        igdTrailerBtnSgdb.onclick = () => openTrailer(info.trailerVideoId, game.title);
      }
      // Screenshots
      if (info.screenshots && info.screenshots.length > 0) {
        const shots = info.screenshots;
        const n = shots.length;
        igdScreenshots.innerHTML = `<div class="ss-carousel"><div class="ss-track-wrap"><button class="ss-arrow ss-prev" id="igd-ss-prev">&#8249;</button><div class="ss-track" id="igd-ss-track" style="width:${n*100}%">${shots.map((src,i)=>`<div class="ss-slide" style="width:${100/n}%"><img src="${escapeHtml(src)}" alt="" loading="lazy" onerror="this.closest('.ss-slide').style.display='none'" data-src="${escapeHtml(src)}"/></div>`).join('')}</div><button class="ss-arrow ss-next" id="igd-ss-next">&#8250;</button></div><div class="ss-dots" id="igd-ss-dots">${shots.map((_,i)=>`<button class="ss-dot ${i===0?'active':''}" data-i="${i}"></button>`).join('')}</div></div>`;
        igdScreenshots.classList.remove('hidden');
        let cur = 0;
        const dots = igdScreenshots.querySelectorAll('.ss-dot');
        const track = igdScreenshots.querySelector('#igd-ss-track');
        const goTo = idx => { dots[cur].classList.remove('active'); cur=(idx+n)%n; dots[cur].classList.add('active'); track.style.transform=`translateX(-${cur/n*100}%)`; };
        igdScreenshots.querySelector('#igd-ss-prev').addEventListener('click', ()=>goTo(cur-1));
        igdScreenshots.querySelector('#igd-ss-next').addEventListener('click', ()=>goTo(cur+1));
        dots.forEach(d=>d.addEventListener('click',()=>goTo(+d.dataset.i)));
        igdScreenshots.querySelector('.ss-track-wrap').addEventListener('click', e => {
          const img = e.target.closest('img[data-src]');
          if (img) openCarouselFullscreen(img.dataset.src, shots);
        });
      }
      // Sysreq
      if (info.sysReqItems && info.sysReqItems.length > 0) {
        igdSysreqCont.innerHTML = `<div class="sysreq-grid">${info.sysReqItems.map(item => item.label ? `<div class="sysreq-row"><span class="sysreq-label">${escapeHtml(item.label)}</span><span class="sysreq-value">${escapeHtml(item.value)}</span></div>` : `<div class="sysreq-note">${escapeHtml(item.value)}</div>`).join('')}</div>`;
        igdSysreq.classList.remove('hidden');
      }
    } catch(e) { /* silently ignore */ }
  }

  window.openInstalledDetail = async function(game, keepPrev) {
    if (!keepPrev) appState.prevPage = appState.currentPage;
    appState.currentGame = game;
    _gameId = null;
    _libEntry = null;

    // Reset
    igdDesc.textContent = '';
    igdDescSec.classList.add('hidden');
    igdScreenshots.innerHTML = '';
    igdScreenshots.classList.add('hidden');
    igdSysreq.classList.add('hidden');
    igdSysreqCont.innerHTML = '';
    igdVerifyRes.classList.add('hidden');
    igdVerifyRes.className = 'igd-verify-result hidden';
    igdSaveMsg.classList.add('hidden');
    igdTrailerBtn.classList.add('hidden');
    igdTrailerBtnSgdb.classList.add('hidden');
    igdSizeStat.style.display = 'none';
    igdSizeSep.style.display = 'none';

    // Cover / banner reset — use SGDB loading shimmer
    resetIgdSgdbMode();
    igdBannerBg.style.backgroundImage = '';
    igdCover.style.display = 'none';
    igdCoverPh.style.display = 'none';
    igdBanner.classList.add('sgdb-loading');

    igdTitle.textContent = game.title || '';
    igdVersion.textContent = game.version || '';
    igdSubTitleEl.textContent = game.title || '';
    igdSubVersionEl.textContent = game.version || '';

    navigateTo('installed-detail');

    // Kick off SGDB fetch in background
    const _sgTitle = game.title;
    fetchSgdbAssets(game.title).then(assets => {
      if (appState.currentGame?.title !== _sgTitle) return;
      igdBanner.classList.remove('sgdb-loading');
      if (assets) {
        applyIgdSgdbMode(assets.logo, assets.hero);
      } else {
        // SGDB failed — fall back to blurred cover
        if (game.image) {
          igdCover.src = game.image;
          igdBannerBg.style.backgroundImage = safeCssUrl(game.image);
        }
        igdCover.style.display   = game.image ? 'block' : 'none';
        igdCoverPh.style.display = game.image ? 'none' : 'flex';
        igdBanner.classList.add('sgdb-fallback-visible');
      }
    }).catch(() => {
      igdBanner.classList.remove('sgdb-loading');
      if (game.image) {
        igdCover.src = game.image;
        igdBannerBg.style.backgroundImage = safeCssUrl(game.image);
      }
      igdCover.style.display   = game.image ? 'block' : 'none';
      igdCoverPh.style.display = game.image ? 'none' : 'flex';
      igdBanner.classList.add('sgdb-fallback-visible');
    });

    // Find lib entry
    const gameIdFromUrlDerived = gameIdFromUrl(game.url);
    const libByUrl = appState.library.find(e => e.id === gameIdFromUrlDerived);
    _gameId = libByUrl ? gameIdFromUrlDerived : (game.libId || gameIdFromUrlDerived);
    _libEntry = libByUrl || (game.libId ? appState.library.find(e => e.id === game.libId) : null);

    if (!_libEntry) return;

    // Install dir
    igdInstallDir.textContent = _libEntry.installDir || '—';

    // Added at
    if (_libEntry.addedAt) {
      igdAddedAt.textContent = new Date(_libEntry.addedAt).toLocaleDateString();
      igdAddedRow.style.display = '';
    } else {
      igdAddedRow.style.display = 'none';
    }

    // Last played
    const lpText = _libEntry.lastPlayed ? fmtRelativeDate(_libEntry.lastPlayed) : 'Never played';
    igdLpVal.textContent = lpText;
    igdLpValSgdb.textContent = lpText;

    // Playtime from tracking
    try {
      const tracking = await window.api.getTracking();
      const te = tracking[_gameId];
      const ptText = te && te.totalSeconds ? fmtPlaytime(te.totalSeconds) + ' played' : '0h played';
      igdPtVal.textContent = ptText;
      igdPtValSgdb.textContent = ptText;
    } catch(e) { igdPtVal.textContent = '0h played'; igdPtValSgdb.textContent = '0h played'; }

    // Launch config
    igdExeInput.value  = _libEntry.execPath  || '';
    igdArgsInput.value = _libEntry.launchArgs || '';
    igdSkipPicker.checked = !!_libEntry.skipExePicker;

    // Hide state
    const isHidden = hiddenGames && hiddenGames.has(_gameId);
    igdHideBtn.dataset.hidden = isHidden ? 'true' : 'false';
    igdHideLabel.textContent = isHidden ? 'Show in Library' : 'Hide from Library';
    igdHideIcon.innerHTML = isHidden
      ? `<path d="M1 7s2.5-4 6-4 6 4 6 4-2.5 4-6 4-6-4-6-4z" stroke="currentColor" stroke-width="1.2"/><circle cx="7" cy="7" r="1.8" stroke="currentColor" stroke-width="1.2"/>`
      : `<path d="M1 7s2.5-4 6-4 6 4 6 4-2.5 4-6 4-6-4-6-4z" stroke="currentColor" stroke-width="1.2"/><circle cx="7" cy="7" r="1.8" stroke="currentColor" stroke-width="1.2"/><line x1="2" y1="2" x2="12" y2="12" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>`;

    setStatus(`${game.title} — installed`);

    // Load page info (desc, screenshots, trailer) in background
    if (game.url) loadPageInfo(game);

  };


    // ── Button wiring ─────────────────────────────────────────
  igdLaunchBtn.addEventListener('click', () => { if (_gameId) launchGameWithPicker(_gameId); });
  igdLaunchBtnSgdb.addEventListener('click', () => { if (_gameId) launchGameWithPicker(_gameId); });

  igdExeBrowse.addEventListener('click', async () => {
    const result = await window.api.pickExe();
    if (result) igdExeInput.value = result;
  });

  igdSaveBtn.addEventListener('click', async () => {
    if (!_gameId) return;
    await window.api.setLaunchConfig({
      id: _gameId,
      execPath:      igdExeInput.value.trim(),
      launchArgs:    igdArgsInput.value.trim(),
      skipExePicker: igdSkipPicker.checked,
    });
    igdSaveMsg.classList.remove('hidden');
    setTimeout(() => igdSaveMsg.classList.add('hidden'), 2000);
    // Update local lib entry
    appState.library = await window.api.getLibrary();
    _libEntry = appState.library.find(e => e.id === _gameId);
  });

  igdOpenFolder.addEventListener('click', () => { if (_libEntry && _libEntry.installDir) window.api.openPath(_libEntry.installDir); });

  igdAddSteam.addEventListener('click', () => { if (_gameId) openAddToSteamDialog(_gameId, _libEntry?.execPath, appState.currentGame?.title, appState.currentGame?.image); });

  igdShortcut.addEventListener('click', () => { if (_gameId) window.openShortcutPicker(_gameId); });

  igdVerifyBtn.addEventListener('click', async () => {
    if (!_gameId) return;
    igdVerifyBtn.disabled = true;
    const orig = igdVerifyBtn.innerHTML;
    igdVerifyBtn.innerHTML = '<span class="btn-spinner"></span> Verifying…';
    igdVerifyRes.className = 'igd-verify-result hidden';
    try {
      const r = await window.api.verifyInstall(_gameId);
      igdVerifyRes.classList.remove('hidden');
      if (r.error) {
        igdVerifyRes.classList.add('verify-error');
        igdVerifyRes.textContent = r.error;
      } else if (r.verdict === 'ok') {
        igdVerifyRes.classList.add('verify-ok');
        igdVerifyRes.innerHTML = `Files OK — ${fmtBytes(r.diskSize)} on disk${r.serverZipSize ? ` · download: ${fmtBytes(r.serverZipSize)}` : ''}`;
        igdDiskSize.textContent = fmtBytes(r.diskSize);
      } else if (r.verdict === 'outdated') {
        igdVerifyRes.classList.add('verify-warn');
        igdVerifyRes.textContent = `Update available — server file changed (was ${fmtBytes(r.storedZipSize)}, now ${fmtBytes(r.serverZipSize)})`;
      } else if (r.verdict === 'corrupt') {
        igdVerifyRes.classList.add('verify-error');
        igdVerifyRes.textContent = `Possibly corrupt — ${r.corruptReason || fmtBytes(r.diskSize) + ' on disk'}`;
      } else if (r.verdict === 'missing') {
        igdVerifyRes.classList.add('verify-error');
        igdVerifyRes.textContent = `Install folder missing — ${r.installDir}`;
      }
    } catch(err) {
      igdVerifyRes.classList.remove('hidden');
      igdVerifyRes.classList.add('verify-error');
      igdVerifyRes.textContent = `Error: ${err.message}`;
    }
    igdVerifyBtn.disabled = false;
    igdVerifyBtn.innerHTML = orig;
  });

  igdHideBtn.addEventListener('click', () => {
    if (!_gameId) return;
    toggleHideGame(_gameId);
    const nowHidden = hiddenGames && hiddenGames.has(_gameId);
    igdHideBtn.dataset.hidden = nowHidden ? 'true' : 'false';
    igdHideLabel.textContent = nowHidden ? 'Show in Library' : 'Hide from Library';
    igdHideIcon.innerHTML = nowHidden
      ? `<path d="M1 7s2.5-4 6-4 6 4 6 4-2.5 4-6 4-6-4-6-4z" stroke="currentColor" stroke-width="1.2"/><circle cx="7" cy="7" r="1.8" stroke="currentColor" stroke-width="1.2"/>`
      : `<path d="M1 7s2.5-4 6-4 6 4 6 4-2.5 4-6 4-6-4-6-4z" stroke="currentColor" stroke-width="1.2"/><circle cx="7" cy="7" r="1.8" stroke="currentColor" stroke-width="1.2"/><line x1="2" y1="2" x2="12" y2="12" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>`;
  });

  igdUninstall.addEventListener('click', () => {
    if (_gameId && appState.currentGame) confirmUninstall(_gameId, appState.currentGame.title);
  });
})();
searchBtn.addEventListener('click', () => doSearch(searchInput.value));
searchInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') doSearch(searchInput.value);
  if (e.key === 'Home' && !e.shiftKey && !e.ctrlKey && !e.altKey) {
    e.preventDefault();
    appState.searchQuery = '';
    searchInput.value = '';
    showHomeState('welcome');
    navigateTo('home');
  }
});
// Fix: clicking the search bar sometimes doesn't restore keyboard focus in Electron
// (caret doesn't appear, typing is silently dropped). Explicitly re-focus on every
// click and mousedown so the input always receives keyboard events, even after
// blur() or after the renderer reloads without a full app restart.
searchInput.addEventListener('click', () => { searchInput.focus(); });
searchInput.addEventListener('mousedown', () => {
  // Schedule focus after the mousedown event cycle completes, so it wins
  // against any blur that a preceding click on another element may trigger.
  requestAnimationFrame(() => searchInput.focus());
});
loadMoreBtn.addEventListener('click', loadMoreResults);

// ── Library sort & filter ─────────────────────────────────
const libSortSelect  = $('lib-sort-select');
const libSearchInput = $('lib-search-input');
if (libSortSelect) {
  libSortSelect.addEventListener('change', () => {
    libSort = libSortSelect.value;
    refreshLibraryView();
  });
}
if (libSearchInput) {
  libSearchInput.addEventListener('input', () => {
    libFilterTxt = libSearchInput.value.toLowerCase().trim();
    refreshLibraryView();
  });
}

const mpSearchInput = $('mp-search-input');
if (mpSearchInput) {
  mpSearchInput.addEventListener('input', () => {
    mpFilterTxt = mpSearchInput.value.toLowerCase().trim();
    refreshMultiplayerView();
  });
  // Escape clears, matching how the rest of the app's inputs behave.
  mpSearchInput.addEventListener('keydown', e => {
    if (e.key === 'Escape' && mpSearchInput.value) {
      e.stopPropagation();
      mpSearchInput.value = '';
      mpFilterTxt = '';
      refreshMultiplayerView();
    }
  });
}

document.addEventListener('click', e => {
  if (e.target.closest('#lib-show-hidden-btn')) {
    showHiddenGames = !showHiddenGames;
    refreshLibraryView();
  }
  const layoutBtn = e.target.closest('.lib-layout-btn');
  if (layoutBtn) {
    libLayout = layoutBtn.dataset.layout;
    localStorage.setItem('nino-lib-layout', libLayout);
    applyLibLayout();
  }
});

async function loadSettings() {
  // Wire up settings sidebar tabs (idempotent)
  document.querySelectorAll('.snav-btn').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('.snav-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
      btn.classList.add('active');
      const panel = document.getElementById('stab-' + btn.dataset.tab);
      if (panel) panel.classList.add('active');
    };
  });
  appState.settings = await window.api.getSettings();
  if (appState.settings.osUsername) window._osUsername = appState.settings.osUsername;
  $('install-path-display').textContent = appState.settings.installPath || `Default (C:\\Users\\${window._osUsername || '___'}\\NinoGames)`;
  const themeInput = $('theme-toggle-input');
  if (themeInput) themeInput.checked = document.body.classList.contains('light');
  // Source picker
  const source = appState.settings.source || 'ankergames';
  document.querySelectorAll('.source-radio').forEach(r => {
    r.classList.toggle('active', r.dataset.source === source);
  });
  // Aria2 toggle
  const aria2Input = $('aria2-toggle-input');
  if (aria2Input) aria2Input.checked = !!appState.settings.aria2Enabled;
  // 7-Zip toggle (default on)
  const sevenZipInput = $('sevenzip-toggle-input');
  if (sevenZipInput) sevenZipInput.checked = appState.settings.sevenZipEnabled !== false;
}

$('btn-pick-folder').addEventListener('click', async () => {
  const folder = await window.api.pickFolder();
  if (folder) {
    appState.settings.installPath = folder;
    await window.api.saveSettings({ installPath: folder });
    $('install-path-display').textContent = folder;
    setStatus(`Install path set to: ${folder}`);
  }
});

$('btn-reset-path').addEventListener('click', async () => {
  appState.settings.installPath = null;
  await window.api.saveSettings({ installPath: null });
  $('install-path-display').textContent = `Default (C:\\Users\\${window._osUsername || '___'}\\NinoGames)`;
  setStatus('Install path reset to default.');
});

$('btn-uninstall-app').addEventListener('click', async () => {
  const deleteGames = document.getElementById('uninstall-delete-games-toggle').checked;
  const result = await window.api.uninstallApp({ deleteGames });
  if (result && !result.ok && !result.cancelled) {
    setStatus(`Uninstall failed: ${result.error || 'Unknown error'}`);
  }
});

// Switching source is now reachable from two places — the settings page and the
// switcher on the home screen — so the behaviour lives in one function rather
// than being duplicated per control.
async function setSource(src, { label } = {}) {
  if (!src || appState.settings.source === src) return;
  appState.settings.source = src;
  await window.api.saveSettings({ source: src });

  document.querySelectorAll('.source-radio').forEach(r => r.classList.toggle('active', r.dataset.source === src));
  syncHomeSourceSwitch();
  setStatus(`Source set to ${label || src}`);

  if (appState.searchQuery) {
    // Drop the old results so navigating home re-runs the search on the new source
    gameGrid.innerHTML = '';
    appState.totalGames = 0;
    navigateTo('home');
  } else {
    showHomeState('welcome');
    // The home grid is per-source, so it has to be rebuilt too.
    renderDiscovery();
  }
}

document.querySelectorAll('.source-radio').forEach(btn => {
  btn.addEventListener('click', () => setSource(btn.dataset.source, { label: btn.textContent.trim() }));
});

document.querySelectorAll('.home-source-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    const src = btn.dataset.source;
    if (appState.settings.source === src) return;
    // The list for a source can take a few seconds on a cold cache; disable the
    // switcher meanwhile so it cannot be double-fired into a half-swapped state.
    const all = [...document.querySelectorAll('.home-source-btn')];
    all.forEach(b => { b.disabled = true; });
    try {
      await setSource(src, { label: btn.textContent.trim() });
    } finally {
      all.forEach(b => { b.disabled = false; });
    }
  });
});

(async () => {
  // Wait for DOM to be fully ready before initialising
  await new Promise(resolve => {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', resolve, { once: true });
    } else {
      resolve();
    }
  });
  appState.library  = await window.api.getLibrary();
  appState.settings = await window.api.getSettings();
  searchInput.focus();
  setStatus('Ready');
  applyLibLayout();
  await renderDiscovery();
  updateDownloadBadge();
})();

// ── Theme system (dark / light / gradient themes) ─────────────
const GRADIENT_THEMES = ['midnight','aurora','sunset','ocean','candy','galaxy'];
const LIGHT_GRADIENT_THEMES = ['light-rose','light-sky','light-mint','light-lavender','light-peach','light-nordic'];
const ALL_THEMED = [...GRADIENT_THEMES, ...LIGHT_GRADIENT_THEMES];

function applyTheme(theme) {
  // Strip all theme classes
  document.body.classList.remove('light', ...ALL_THEMED.map(t => 'theme-' + t));

  if (theme === 'light') {
    document.body.classList.add('light');
  } else if (ALL_THEMED.includes(theme)) {
    document.body.classList.add('theme-' + theme);
  }
  // 'dark' = no class needed

  // Keep legacy toggle in sync
  const legacyToggle = document.getElementById('theme-toggle-input');
  if (legacyToggle) legacyToggle.checked = (theme === 'light');

  // Update active state on theme swatch buttons
  document.querySelectorAll('.theme-card, .tv2-card, .theme-swatch').forEach(card => {
    card.classList.toggle('active', card.dataset.theme === theme);
  });
}

(function initTheme() {
  const saved = localStorage.getItem('ninogames-theme') || 'dark';
  applyTheme(saved);
})();

// Theme card clicks — support old .theme-card/.tv2-card and new .theme-swatch
document.querySelectorAll('.theme-card, .tv2-card, .theme-swatch').forEach(card => {
  card.addEventListener('click', function () {
    const theme = this.dataset.theme;
    localStorage.setItem('ninogames-theme', theme);
    applyTheme(theme);
  });
});

document.getElementById('theme-toggle-input')?.addEventListener('change', function () {
  const theme = this.checked ? 'light' : 'dark';
  localStorage.setItem('ninogames-theme', theme);
  applyTheme(theme);
});

document.getElementById('aria2-toggle-input')?.addEventListener('change', async function () {
  appState.settings.aria2Enabled = this.checked;
  await window.api.saveSettings({ aria2Enabled: this.checked });
  setStatus(this.checked ? 'Aria2 downloader enabled.' : 'Aria2 downloader disabled.');
});

document.getElementById('sevenzip-toggle-input')?.addEventListener('change', async function () {
  appState.settings.sevenZipEnabled = this.checked;
  await window.api.saveSettings({ sevenZipEnabled: this.checked });
  setStatus(this.checked ? '7-Zip extractor enabled.' : '7-Zip extractor disabled (using PowerShell fallback).');
});


// ── DevTools Panel ─────────────────────────────────────────────
(function initDevToolsPanel() {
  const overlay       = document.getElementById('devtools-overlay');
  const closeBtn      = document.getElementById('devtools-close-btn');
  const refreshBtn    = document.getElementById('devtools-refresh-btn');
  const nativeBtn     = document.getElementById('devtools-native-btn');
  const captureBtn    = document.getElementById('devtools-capture-btn');
  const tabs          = document.querySelectorAll('.devtools-tab');
  const tabContents   = document.querySelectorAll('.devtools-tab-content');

  // ── Visibility ───────────────────────────────────────────────
  let isOpen = false;

  function openPanel() {
    if (isOpen) return;
    isOpen = true;
    overlay.classList.remove('devtools-hidden');
    loadInfo();
  }

  function closePanel() {
    if (!isOpen) return;
    isOpen = false;
    overlay.classList.add('devtools-hidden');
  }

  function togglePanel() {
    isOpen ? closePanel() : openPanel();
  }

  // Keyboard shortcut (renderer-side fallback + native via main)
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'd') {
      e.preventDefault();
      togglePanel();
    }
  });

  // IPC toggle from main (global shortcut)
  if (window.api?.onToggleDevtoolsPanel) {
    window.api.onToggleDevtoolsPanel(togglePanel);
  }

  closeBtn.addEventListener('click', closePanel);
  nativeBtn.addEventListener('click', () => window.api?.openDevTools?.());
  refreshBtn.addEventListener('click', loadInfo);

  // ── Clear Cache & Restart ─────────────────────────────────────
  const clearCacheBtn    = document.getElementById('devtools-clear-cache-btn');
  const clearCacheStatus = document.getElementById('devtools-clear-cache-status');
  if (clearCacheBtn) {
    clearCacheBtn.addEventListener('click', async () => {
      clearCacheBtn.disabled = true;
      clearCacheBtn.textContent = 'Clearing…';
      if (clearCacheStatus) clearCacheStatus.textContent = 'Please wait…';
      try {
        await window.api?.clearCacheAndRestart?.();
        // App will restart — if somehow we get here, update status
        if (clearCacheStatus) clearCacheStatus.textContent = 'Restarting…';
      } catch (err) {
        clearCacheBtn.disabled = false;
        clearCacheBtn.textContent = 'Clear Cache & Restart';
        if (clearCacheStatus) clearCacheStatus.textContent = 'Error: ' + (err && err.message ? err.message : String(err));
      }
    });
  }

  // ── Tabs ─────────────────────────────────────────────────────
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      tabContents.forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      const target = document.getElementById(`devtools-tab-${tab.dataset.tab}`);
      if (target) target.classList.add('active');
    });
  });

  // ── Info loader ───────────────────────────────────────────────
  async function loadInfo() {
    wireRpcButtons();
    // Reset aria2 dot to loading
    setAria2Status('loading', 'Checking…', '');

    try {
      const info = await window.api?.getDevtoolsInfo?.();
      if (!info) return;

      // aria2
      const { exists, enabled, path: aria2Path } = info.aria2;
      if (!enabled) {
        setAria2Status('warn', 'Disabled in settings', aria2Path);
      } else if (!exists) {
        setAria2Status('error', 'Not found — binary missing', aria2Path);
      } else {
        setAria2Status('ok', 'Detected & ready', aria2Path);
      }

      // 7-Zip
      if (info.sevenZip) {
        const { exists: szExists, enabled: szEnabled, path: szPath } = info.sevenZip;
        const dot   = document.querySelector('#devtools-7zip-status .devtools-dot');
        const lbl   = document.getElementById('devtools-7zip-label');
        const pathEl = document.getElementById('devtools-7zip-path');
        if (dot && lbl && pathEl) {
          dot.className = 'devtools-dot devtools-dot-' + (
            !szEnabled  ? 'warn' :
            !szExists   ? 'error' : 'ok'
          );
          lbl.textContent  = !szEnabled ? 'Disabled in settings' : !szExists ? 'Not found — place 7za.exe in resources/7zip/' : 'Detected & ready';
          pathEl.textContent = szPath || '';
        }
      }

      // Runtime KV
      renderKV('devtools-runtime', {
        Platform: info.platform,
        Electron: info.electron,
        Node:     info.node,
      });

      // Settings KV
      renderKV('devtools-settings-kv', {
        Source:       info.settings.source,
        'Install to': info.settings.installPath,
      });

      // Downloads tab
      renderDownloads(info.activeDownloads);

    } catch (err) {
      setAria2Status('error', 'IPC error: ' + err.message, '');
    }

    // Discord RPC (outside try/catch so it runs even on error)
    await renderDiscordRpcStatus();
  }

  function setAria2Status(state, label, pathStr) {
    const dot   = document.querySelector('#devtools-aria2-status .devtools-dot');
    const lbl   = document.getElementById('devtools-aria2-label');
    const pathEl = document.getElementById('devtools-aria2-path');

    dot.className = 'devtools-dot devtools-dot-' + (
      state === 'ok'      ? 'ok' :
      state === 'warn'    ? 'warn' :
      state === 'error'   ? 'error' : 'loading'
    );
    lbl.textContent  = label;
    pathEl.textContent = pathStr || '';
  }

  function renderKV(containerId, obj) {
    const el = document.getElementById(containerId);
    if (!el) return;
    el.innerHTML = '';
    for (const [k, v] of Object.entries(obj)) {
      const key = document.createElement('span');
      key.className   = 'devtools-kv-key';
      key.textContent = k;
      const val = document.createElement('span');
      val.className   = 'devtools-kv-val';
      val.textContent = v ?? '—';
      el.appendChild(key);
      el.appendChild(val);
    }
  }

  // ── Discord RPC devtools section ──────────────────────────
  const DEFAULT_RPC_CLIENT_ID = '1500441174006169770';

  async function renderDiscordRpcStatus() {
    const dot    = document.getElementById('devtools-discord-dot');
    const label  = document.getElementById('devtools-discord-label');
    const input  = document.getElementById('devtools-discord-clientid');
    if (!dot || !label || !input) return;

    const cfg = await window.api.getRpcConfig?.().catch(() => ({ clientId: DEFAULT_RPC_CLIENT_ID }));
    const savedId = cfg?.clientId || DEFAULT_RPC_CLIENT_ID;
    input.value = savedId;

    const isAvailable = await window.api.rpcAvailable?.().catch(() => false);
    const discordUp   = await window.api.rpcRunning?.().catch(() => null);
    if (isAvailable) {
      dot.className = 'devtools-dot devtools-dot-ok';
      label.textContent = 'Connected';
    } else if (discordUp === false) {
      dot.className = 'devtools-dot devtools-dot-warn';
      label.textContent = 'Discord is not running — presence is paused';
    } else {
      dot.className = 'devtools-dot devtools-dot-warn';
      label.textContent = 'Discord found — connecting…';
    }
  }

  let _rpcButtonsWired = false;
  function wireRpcButtons() {
    if (_rpcButtonsWired) return;
    _rpcButtonsWired = true;

    const saveBtn   = document.getElementById('devtools-discord-save-btn');
    const clearBtn  = document.getElementById('devtools-discord-clear-btn');
    const input     = document.getElementById('devtools-discord-clientid');
    const statusMsg = document.getElementById('devtools-discord-save-status');

    if (saveBtn) {
      saveBtn.addEventListener('click', async () => {
        const id = (input?.value || '').trim();
        if (id && !/^[0-9]{17,20}$/.test(id)) {
          statusMsg.textContent = 'Invalid — Discord Client IDs are 17–20 digit numbers.';
          statusMsg.style.color = 'var(--red, #f38ba8)';
          return;
        }
        const r = await window.api.saveRpcConfig?.({ clientId: id }).catch(e => ({ error: e.message }));
        if (r?.ok) {
          statusMsg.textContent = 'Saved! Restart NinoGames to activate.';
          statusMsg.style.color = 'var(--green, #a6e3a1)';
          await renderDiscordRpcStatus();
        } else {
          statusMsg.textContent = 'Error: ' + (r?.error || 'unknown');
          statusMsg.style.color = 'var(--red, #f38ba8)';
        }
        setTimeout(() => { if (statusMsg) statusMsg.textContent = ''; }, 4000);
      });
    }

    if (clearBtn) {
      clearBtn.addEventListener('click', async () => {
        if (input) input.value = DEFAULT_RPC_CLIENT_ID;
        await window.api.saveRpcConfig?.({ clientId: '' }).catch(() => {});
        if (statusMsg) {
          statusMsg.textContent = 'Reset to default. Restart to apply.';
          statusMsg.style.color = 'var(--text-dim)';
          setTimeout(() => { statusMsg.textContent = ''; }, 3000);
        }
        await renderDiscordRpcStatus();
      });
    }
  }

  function renderDownloads(list) {
    const container = document.getElementById('devtools-downloads-list');
    if (!container) return;
    if (!list || list.length === 0) {
      container.innerHTML = '<div class="devtools-muted" style="font-size:12px">(none active)</div>';
      return;
    }
    container.innerHTML = '';
    for (const dl of list) {
      const row = document.createElement('div');
      row.className = 'devtools-dl-row';

      const statusColor =
        dl.status === 'downloading' ? '#4ADE80' :
        dl.status === 'failed'      ? '#FF6B6B' :
        dl.status === 'paused'      ? '#FBBF24' : '#aab';

      row.innerHTML = `
        <div class="devtools-dl-id">${escHtml(dl.gameId)}</div>
        <div class="devtools-dl-status" style="color:${statusColor}">${escHtml(dl.status)}${dl.paused ? ' (paused)' : ''}</div>
        ${dl.scraperUrl ? `<div class="devtools-dl-url">${escHtml(dl.scraperUrl)}</div>` : ''}
      `;

      // Capture preview button per download
      if (dl.scraperUrl) {
        const capBtn = document.createElement('button');
        capBtn.className   = 'devtools-btn-sm';
        capBtn.style.cssText = 'margin-top:4px;align-self:flex-start';
        capBtn.textContent = 'Capture preview';
        capBtn.addEventListener('click', () => capturePreview(dl.gameId));
        row.appendChild(capBtn);
      }

      container.appendChild(row);
    }
  }

  // ── Scraper Preview ───────────────────────────────────────────
  captureBtn.addEventListener('click', () => capturePreview(null));

  async function capturePreview(gameId) {
    const urlEl   = document.getElementById('devtools-preview-url');
    const img     = document.getElementById('devtools-preview-img');
    const placeholder = document.getElementById('devtools-preview-placeholder');
    const ts      = document.getElementById('devtools-preview-ts');

    urlEl.textContent = 'Capturing…';

    // Switch to preview tab
    tabs.forEach(t => t.classList.remove('active'));
    tabContents.forEach(c => c.classList.remove('active'));
    document.querySelector('.devtools-tab[data-tab="preview"]').classList.add('active');
    document.getElementById('devtools-tab-preview').classList.add('active');

    try {
      const result = await window.api?.captureScraperPreview?.(gameId);
      if (!result || result.error) {
        urlEl.textContent = result?.error || 'No scraper window active';
        placeholder.style.display = 'block';
        img.style.display = 'none';
        return;
      }
      urlEl.textContent = result.url || '(unknown URL)';
      img.src = result.snapshot;
      img.style.display = 'block';
      placeholder.style.display = 'none';
      ts.textContent = 'Captured at ' + new Date().toLocaleTimeString();
    } catch (err) {
      urlEl.textContent = 'Error: ' + err.message;
    }
  }

  // Auto-refresh downloads list every 3s when panel is open
  setInterval(() => {
    if (!isOpen) return;
    window.api?.getDevtoolsInfo?.().then(info => {
      if (info?.activeDownloads) renderDownloads(info.activeDownloads);
      if (info?.aria2) {
        const { exists, enabled, path: p } = info.aria2;
        if (!enabled) setAria2Status('warn', 'Disabled in settings', p);
        else if (!exists) setAria2Status('error', 'Not found — binary missing', p);
        else setAria2Status('ok', 'Detected & ready', p);
      }
    }).catch(() => {});
  }, 3000);

  function escHtml(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
})();

// ── Auto-updater UI ────────────────────────────────────────────
(function initUpdater() {
  const DID_YOU_KNOW = [
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" style="vertical-align:middle;flex-shrink:0"><path d="M6 11h4M8 9v4M15 12h.01M18 12h.01"/><rect x="2" y="6" width="20" height="12" rx="2"/></svg> NinoGames has over 125,000 games across all sources.',
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" style="vertical-align:middle;flex-shrink:0"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg> Aria2 can download at up to 8 connections simultaneously.',
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" style="vertical-align:middle;flex-shrink:0"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2z"/></svg> You can change your install folder anytime in Settings.',
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" style="vertical-align:middle;flex-shrink:0"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg> Wishlist games to never lose track of them.',
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" style="vertical-align:middle;flex-shrink:0"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg> AnkerGames and SteamRIP are searched live.',
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" style="vertical-align:middle;flex-shrink:0"><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/></svg> Use 7-Zip for 3× faster extraction on large games.',
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" style="vertical-align:middle;flex-shrink:0"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg> Add any game directly to Steam as a non-Steam shortcut.',
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" style="vertical-align:middle;flex-shrink:0"><path d="M16.5 9.4l-9-5.19M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg> NinoGames auto-resumes downloads if your connection drops.',
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" style="vertical-align:middle;flex-shrink:0"><line x1="9" y1="18" x2="15" y2="18"/><line x1="10" y1="22" x2="14" y2="22"/><path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .23 2.23 1.5 3.5A4.61 4.61 0 0 1 8.91 14"/></svg> Press Ctrl+Shift+D to open the developer tools panel.',
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" style="vertical-align:middle;flex-shrink:0"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg> The Verify button checks if your install matches the server.',
  ];

  let dyкIdx = 0;
  let dykTimer = null;

  function rotateDyk() {
    const el = $('update-did-you-know');
    if (!el) return;
    el.style.opacity = '0';
    setTimeout(() => {
      el.textContent = DID_YOU_KNOW[dyкIdx % DID_YOU_KNOW.length];
      el.style.opacity = '1';
      dyкIdx++;
    }, 400);
    dykTimer = setTimeout(rotateDyk, 5000);
  }

  function stopDyk() {
    clearTimeout(dykTimer);
    dykTimer = null;
  }

  function setUpdateStatus(text, color) {
    const el = $('update-status-text');
    if (el) { el.textContent = text; el.style.color = color || ''; }
  }

  function showProgressWrap(show) {
    const el = $('update-progress-wrap');
    if (el) el.classList.toggle('hidden', !show);
    if (show) { dyкIdx = 0; rotateDyk(); }
    else stopDyk();
  }

  function setProgress(pct) {
    const fill = $('update-progress-bar-fill');
    const label = $('update-progress-pct');
    if (fill)  fill.style.width = `${pct}%`;
    if (label) label.textContent = `${pct}%`;
  }

  function showUpdateBanner(info) {
    const banner = $('update-available-banner');
    if (!banner) return;
    banner.innerHTML = `
      <div class="update-banner-inner">
        <div class="update-banner-left">
          <div class="update-banner-title">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style="vertical-align:middle;margin-right:6px"><path d="M7 1v8M3.5 5.5L7 2l3.5 3.5" stroke="#60CDFF" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M1 10v1.5A1.5 1.5 0 002.5 13h9a1.5 1.5 0 001.5-1.5V10" stroke="#60CDFF" stroke-width="1.5" stroke-linecap="round"/></svg>
            v${info.version} available
          </div>
          <div class="update-banner-notes">${info.notes || 'Bug fixes and improvements.'}</div>
        </div>
        <button class="update-install-btn" id="btn-install-update">Download &amp; Install</button>
      </div>`;
    banner.classList.remove('hidden');

    document.getElementById('btn-install-update').addEventListener('click', async () => {
      const btn = $('btn-check-update');
      if (btn) { btn.disabled = true; btn.textContent = 'Launching Updater…'; }
      banner.classList.add('hidden');
      setUpdateStatus('Launching updater…', '#60CDFF');

      try {
        await window.api.applyUpdate();
        setUpdateStatus('Updater launched! NinoGames will now close.', '#4ade80');
      } catch (err) {
        setUpdateStatus('Update failed: ' + err.message, '#FF6B6B');
        if (btn) { btn.disabled = false; btn.textContent = 'Check for Updates'; }
      }
    });
  }

  // Wire up check button
  document.addEventListener('click', async e => {
    if (!e.target.matches('#btn-check-update')) return;
    const btn = e.target;
    btn.disabled = true;
    btn.textContent = 'Checking…';
    setUpdateStatus('Checking for updates…', '');
    $('update-available-banner')?.classList.add('hidden');

    try {
      const result = await window.api.checkForUpdate();
      if (result.error) {
        setUpdateStatus('Could not reach update server.', '#f59e0b');
      } else if (result.upToDate) {
        setUpdateStatus(`You're on the latest version (v${result.current}).`, '#4ade80');
      } else {
        setUpdateStatus(`v${result.latest.version} is available!`, '#60CDFF');
        showUpdateBanner(result.latest);
      }
    } catch (err) {
      setUpdateStatus('Check failed: ' + err.message, '#FF6B6B');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Check for Updates';
    }
  });

  // Show current version on settings load
  const origLoadSettings = window._loadSettings;
  const versionLabel = $('current-version-label');
  if (versionLabel) {
    window.api.getAppVersion?.().then(v => { versionLabel.textContent = `v${v}`; }).catch(() => {});
  }
})();


// ── Game Tracking ─────────────────────────────────────────────
(function initGameTracking() {
  // ── State ──────────────────────────────────────────────────
  let trackingEnabled = false;
  let activeSession = null; // { gameId, title, startTime, intervalId }
  let sessionElapsed = 0;   // seconds elapsed in current session (for display)

  // ── Helpers ────────────────────────────────────────────────
  function fmtPlaytime(totalSeconds) {
    if (!totalSeconds || totalSeconds < 60) return totalSeconds ? `${totalSeconds}s` : '0m';
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    if (h === 0) return `${m}m`;
    return m === 0 ? `${h}h` : `${h}h ${m}m`;
  }

  function fmtTimerDisplay(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    return `${m}:${String(s).padStart(2,'0')}`;
  }

  // ── Now-Playing Bar ────────────────────────────────────────
  const nowPlayingBar   = document.getElementById('now-playing-bar');
  const nowPlayingTitle = document.getElementById('now-playing-title');
  const nowPlayingTimer = document.getElementById('now-playing-timer');

  function showNowPlaying(title) {
    if (!nowPlayingBar) return;
    nowPlayingTitle.textContent = title;
    nowPlayingTimer.textContent = '0:00';
    nowPlayingBar.style.display = 'block';
  }

  function hideNowPlaying() {
    if (nowPlayingBar) nowPlayingBar.style.display = 'none';
  }

  function tickNowPlaying() {
    if (!nowPlayingTimer || !activeSession) return;
    nowPlayingTimer.textContent = fmtTimerDisplay(sessionElapsed);
  }

  // ── Playtime chip in detail view ───────────────────────────
  function updateDetailPlaytime(gameId) {
    const chip = document.getElementById('detail-playtime');
    const span = chip && chip.querySelector('span');
    if (!chip || !span) return;
    if (!trackingEnabled) { chip.style.display = 'none'; return; }
    window.api.getTracking().then(tracking => {
      const entry = tracking[gameId];
      const total = entry ? entry.totalSeconds : 0;
      // Add live session seconds if this game is currently playing
      const live = (activeSession && activeSession.gameId === gameId) ? sessionElapsed : 0;
      const combined = total + live;
      if (combined > 0) {
        span.textContent = fmtPlaytime(combined) + ' played';
        chip.style.display = '';
      } else {
        chip.style.display = 'none';
      }
    });
  }

  // ── Library card playtime badge (injected after card render) ─
  function injectLibraryPlaytime(tracking) {
    if (!trackingEnabled) return;
    document.querySelectorAll('.lib-card[data-lid]').forEach(card => {
      const gameId = card.dataset.lid;
      const entry = tracking[gameId];
      const live = (activeSession && activeSession.gameId === gameId) ? sessionElapsed : 0;
      const total = (entry ? entry.totalSeconds : 0) + live;
      const isInstalled = card.querySelector('.lib-card-status.installed') !== null;

      let badge = card.querySelector('.lib-playtime-badge');
      // Always show badge for installed games; hide for non-installed with no playtime
      if (!isInstalled && total === 0) { if (badge) badge.remove(); return; }

      if (!badge) {
        badge = document.createElement('div');
        badge.className = 'lib-playtime-badge';
        badge.style.cssText = 'font-size:11px;color:var(--text-dim,#6c7086);margin-top:2px;display:flex;align-items:center;gap:4px';
        badge.innerHTML = `<svg width="10" height="10" viewBox="0 0 10 10" fill="none"><circle cx="5" cy="5" r="4" stroke="currentColor" stroke-width="1.1"/><path d="M5 2.5V5l1.5 1.5" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/></svg><span></span>`;
        const statusEl = card.querySelector('.lib-card-status');
        if (statusEl) statusEl.after(badge);
      }
      const liveLabel = (activeSession && activeSession.gameId === gameId) ? ' · playing now' : '';
      const playtimeText = total > 0 ? fmtPlaytime(total) + ' played' + liveLabel : '0h played';
      badge.querySelector('span').textContent = playtimeText;
      if (activeSession && activeSession.gameId === gameId) {
        badge.style.color = '#4ade80';
      } else {
        badge.style.color = '';
      }
      // Show last-played date
      const entry2 = appState.library.find(e => e.id === gameId);
      let lpEl = card.querySelector('.lib-lastplayed-badge');
      if (entry2 && entry2.lastPlayed && !(activeSession && activeSession.gameId === gameId)) {
        const lp = new Date(entry2.lastPlayed);
        const now2 = new Date();
        const diffMs = now2 - lp;
        const diffDays = Math.floor(diffMs / 86400000);
        let lpText;
        if (diffDays === 0) lpText = 'Last played today';
        else if (diffDays === 1) lpText = 'Last played yesterday';
        else if (diffDays < 30) lpText = `Last played ${diffDays}d ago`;
        else if (diffDays < 365) lpText = `Last played ${Math.floor(diffDays/30)}mo ago`;
        else lpText = `Last played ${Math.floor(diffDays/365)}y ago`;
        if (!lpEl) {
          lpEl = document.createElement('div');
          lpEl.className = 'lib-lastplayed-badge';
          lpEl.style.cssText = 'font-size:10px;color:var(--text-dim,#6c7086);margin-top:1px';
          badge.after(lpEl);
        }
        lpEl.textContent = lpText;
      } else if (lpEl) {
        lpEl.remove();
      }
    });
  }

  // ── Settings section ───────────────────────────────────────
  const toggle = document.getElementById('game-tracking-toggle-input');
  const statsWrap = document.getElementById('game-tracking-stats-wrap');
  const allStats  = document.getElementById('game-tracking-all-stats');

  async function renderTrackingStats() {
    if (!allStats) return;
    const tracking = await window.api.getTracking();
    const library  = appState.library;
    const entries  = Object.entries(tracking)
      .map(([id, t]) => {
        const libEntry = library.find(e => e.id === id);
        return { id, title: libEntry ? libEntry.title : id, totalSeconds: t.totalSeconds || 0 };
      })
      .filter(e => e.totalSeconds > 0)
      .sort((a, b) => b.totalSeconds - a.totalSeconds);

    if (entries.length === 0) {
      allStats.innerHTML = '<div style="font-size:12px;opacity:.5">No playtime recorded yet.</div>';
      return;
    }
    allStats.innerHTML = entries.map(e => `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:7px 0;border-bottom:1px solid var(--border,#313244);gap:12px">
        <span style="font-size:13px;color:var(--text-primary,#cdd6f4);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(e.title)}</span>
        <span style="font-size:12px;color:var(--text-dim,#6c7086);flex-shrink:0;font-variant-numeric:tabular-nums">${fmtPlaytime(e.totalSeconds)}</span>
      </div>`).join('');
  }

  if (toggle) {
    toggle.addEventListener('change', async function () {
      trackingEnabled = this.checked;
      await window.api.saveSettings({ gameTrackingEnabled: this.checked });
      if (statsWrap) statsWrap.style.display = this.checked ? 'block' : 'none';
      if (this.checked) renderTrackingStats();
      setStatus(this.checked ? 'Game tracking enabled.' : 'Game tracking disabled.');
    });
  }

  // Hydrate toggle from settings on settings page load
  const origLoadSettings = loadSettings;
  // Patch: hook into navigateTo('settings') — settings are loaded there
  const _origNavigateTo = navigateTo;
  // We re-read the setting inside loadSettings which already runs on navigateTo('settings')
  // So we extend loadSettings:
  const _baseLoadSettings = loadSettings;
  window._trackingLoadSettings = function () {
    const s = appState.settings;
    trackingEnabled = !!s.gameTrackingEnabled;
    if (toggle) toggle.checked = trackingEnabled;
    if (statsWrap) statsWrap.style.display = trackingEnabled ? 'block' : 'none';
    if (trackingEnabled) renderTrackingStats();
  };

  // ── Close guard ────────────────────────────────────────────
  const closeGuardOverlay = document.getElementById('close-guard-overlay');
  const closeGuardName    = document.getElementById('close-guard-game-name');
  const closeGuardCancel  = document.getElementById('close-guard-cancel');
  const closeGuardConfirm = document.getElementById('close-guard-confirm');

  if (closeGuardCancel) {
    closeGuardCancel.addEventListener('click', () => {
      closeGuardOverlay.classList.add('hidden');
    });
  }

  if (closeGuardConfirm) {
    closeGuardConfirm.addEventListener('click', async () => {
      closeGuardOverlay.classList.add('hidden');
      await window.api.killTrackedGame();
      window.api.confirmClose();
    });
  }

  // Main process sends this when user hits X while a game is running
  if (window.api.onCloseRequested) {
    window.api.onCloseRequested(() => {
      if (!activeSession) {
        window.api.confirmClose();
        return;
      }
      if (closeGuardName) closeGuardName.textContent = activeSession.title;
      closeGuardOverlay.classList.remove('hidden');
    });
  }

  // ── IPC events from main ───────────────────────────────────
  if (window.api.onGameStarted) {
    window.api.onGameStarted(({ gameId, title }) => {
      if (!trackingEnabled) return;
      sessionElapsed = 0;
      activeSession = { gameId, title, startTime: Date.now() };
      showNowPlaying(title);
      // Refresh detail playtime chip if we're looking at this game
      if (appState.currentGame) {
        const currentId = gameIdFromUrl(appState.currentGame.url);
        if (currentId === gameId || appState.currentGame.libId === gameId) {
          updateDetailPlaytime(gameId);
        }
      }
      window.api.getTracking().then(t => injectLibraryPlaytime(t));
    });
  }

  if (window.api.onGameStopped) {
    window.api.onGameStopped(({ gameId, seconds }) => {
      activeSession = null;
      sessionElapsed = 0;
      hideNowPlaying();
      // Refresh playtime displays
      window.api.getTracking().then(t => {
        injectLibraryPlaytime(t);
        if (appState.currentGame) {
          const currentId = gameIdFromUrl(appState.currentGame.url);
          const libId = appState.currentGame.libId;
          if (currentId === gameId || libId === gameId) updateDetailPlaytime(gameId);
        }
      });
      setStatus(`Session saved — ${fmtPlaytime(seconds)} played.`);
    });
  }

  if (window.api.onPlaytimeTick) {
    window.api.onPlaytimeTick(({ seconds }) => {
      if (!activeSession) return;
      sessionElapsed = seconds;
      tickNowPlaying();
      // Update library badges live every tick (lightweight — just text)
      window.api.getTracking().then(t => injectLibraryPlaytime(t));
      // Update detail chip if on detail page
      if (appState.currentPage === 'detail' && appState.currentGame) {
        const currentId = gameIdFromUrl(appState.currentGame.url);
        const libId = appState.currentGame.libId;
        if (activeSession && (currentId === activeSession.gameId || libId === activeSession.gameId)) {
          updateDetailPlaytime(activeSession.gameId);
        }
      }
    });
  }

  // ── Hook into library refresh to inject playtime badges ───
  const _origDoRefresh = _doRefreshLibraryView;
  // We patch by listening for any library render completion:
  // Since _doRefreshLibraryView is async and we can't monkey-patch it cleanly here,
  // we attach a MutationObserver on libGrid to inject badges whenever it re-renders.
  if (typeof libGrid !== 'undefined' && libGrid) {
    const obs = new MutationObserver(() => {
      if (!trackingEnabled) return;
      window.api.getTracking().then(t => injectLibraryPlaytime(t));
    });
    obs.observe(libGrid, { childList: true });
  }

  // ── Hook into openGameDetail to show playtime chip ─────────
  const _origOpenGameDetail = openGameDetail;
  // Wrap: after navigating to detail page, update the playtime chip
  // We do this by observing page visibility changes
  document.addEventListener('page-changed', (e) => {
    if (e.detail === 'detail' && appState.currentGame) {
      const id = gameIdFromUrl(appState.currentGame.url) || appState.currentGame.libId;
      if (id) updateDetailPlaytime(id);
    }
  });

  // ── Achievement toast ──────────────────────────────────────
  function showAchievementToast({ name, description, icon }) {
    const toast = document.createElement('div');
    toast.style.cssText = [
      'position:fixed', 'bottom:70px', 'right:20px', 'z-index:900',
      'background:var(--surface-2,#1e1e2e)',
      'border:1px solid rgba(250,204,21,.35)',
      'border-radius:12px', 'padding:12px 14px',
      'display:flex', 'align-items:center', 'gap:12px',
      'max-width:300px', 'box-shadow:0 6px 24px rgba(0,0,0,.5)',
      'animation:slideInRight .3s ease',
      'pointer-events:none',
    ].join(';');

    toast.innerHTML = `
      <style>
        @keyframes slideInRight { from { opacity:0; transform:translateX(20px); } to { opacity:1; transform:none; } }
        @keyframes slideOutRight { from { opacity:1; transform:none; } to { opacity:0; transform:translateX(20px); } }
      </style>
      ${icon
        ? `<img src="${escapeHtml(safeUrl(icon))}" style="width:40px;height:40px;border-radius:6px;flex-shrink:0" onerror="this.style.display='none'"/>`
        : `<div style="width:40px;height:40px;border-radius:6px;background:rgba(250,204,21,.15);display:flex;align-items:center;justify-content:center;flex-shrink:0">
             <svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M10 2l2.47 5.01 5.53.8-4 3.9.94 5.51L10 14.51l-4.94 2.71.94-5.51-4-3.9 5.53-.8L10 2z" fill="#facc15" stroke="#facc15" stroke-width="1" stroke-linejoin="round"/></svg>
           </div>`}
      <div style="flex:1;min-width:0">
        <div style="font-size:10px;color:#facc15;font-weight:600;letter-spacing:.5px;text-transform:uppercase;margin-bottom:2px">Achievement Unlocked</div>
        <div style="font-size:13px;font-weight:600;color:var(--text-primary,#cdd6f4);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(name)}</div>
        ${description ? `<div style="font-size:11px;color:var(--text-dim,#6c7086);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(description)}</div>` : ''}
      </div>`;

    document.body.appendChild(toast);
    setTimeout(() => {
      toast.style.animation = 'slideOutRight .3s ease forwards';
      setTimeout(() => toast.remove(), 320);
    }, 5000);
  }

  if (window.api.onAchievementUnlocked) {
    window.api.onAchievementUnlocked((data) => {
      if (!trackingEnabled) return;
      showAchievementToast(data);
      // Refresh the stats panel if it's open
      if (statsWrap && statsWrap.style.display !== 'none') renderTrackingStats();
    });
  }

  // ── Auto-launch from desktop shortcut (--launch <gameId>) ──
  // ── Tray quick-launch ──────────────────────────────────────
  if (window.api.onTrayLaunchGame) {
    window.api.onTrayLaunchGame(({ gameId }) => {
      const entry = appState.library.find(e => e.id === gameId);
      if (entry && entry.status === 'installed') {
        launchGameWithPicker(gameId);
      }
    });
  }

  if (window.api.onAutoLaunchGame) {
    window.api.onAutoLaunchGame(({ gameId }) => {
      const entry = appState.library.find(e => e.id === gameId);
      if (entry) {
        launchGameWithPicker(gameId);
      } else {
        // Library not loaded yet — wait a moment and retry
        setTimeout(() => {
          window.api.getLibrary().then(lib => {
            appState.library = lib;
            const e = lib.find(e => e.id === gameId);
            if (e) launchGameWithPicker(gameId);
          });
        }, 2000);
      }
    });
  }

  // ── Expose hook for loadSettings ──────────────────────────
  // loadSettings() is called by navigateTo('settings'), so patch it:
  const _ls = loadSettings;
  window.loadSettings = async function () {
    await _ls();
    window._trackingLoadSettings && window._trackingLoadSettings();
  };
})();

(function () {
  const overlay    = $('exe-picker-overlay');
  const list       = $('exe-picker-list');
  const argsInput  = $('exe-picker-args');
  const dontAsk    = $('exe-picker-dontask');
  const launchBtn  = $('exe-picker-launch');
  const browseBtn  = $('exe-picker-browse');
  const closeBtn   = $('exe-picker-close');
  const subText    = $('exe-picker-sub');
  const argsRow    = $('exe-picker-args-row');
  const dontAskRow = $('exe-picker-dontask-row');

  let _gameId = null;
  let _selectedExe = null;
  let _mode = 'launch'; // 'launch' | 'shortcut'
  let _shortcutTitle = null;

  function selectExe(exePath, el) {
    _selectedExe = exePath;
    list.querySelectorAll('.exe-item').forEach(i => i.classList.remove('active'));
    if (el) el.classList.add('active');
    launchBtn.disabled = !exePath;
  }

  function addExeItem(exePath, isRoot) {
    const name = exePath.split(/[\\/]/).pop();
    const dir  = exePath.replace(/[\\/][^\\/]+$/, '').split(/[\\/]/).pop();
    const el = document.createElement('div');
    el.className = 'exe-item';
    el.innerHTML = `
      <svg class="exe-item-icon" width="13" height="13" viewBox="0 0 13 13" fill="none"><rect x="1" y="1.5" width="11" height="10" rx="1.5" stroke="currentColor" stroke-width="1.2"/><path d="M4 6.5h5M6.5 4v5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>
      <div class="exe-item-info">
        <span class="exe-item-name">${escapeHtml(name)}</span>
        <span class="exe-item-path">${escapeHtml(dir)}</span>
      </div>`;
    el.addEventListener('click', () => selectExe(exePath, el));
    list.appendChild(el);
    return el;
  }

  async function openPicker(gameId, suggested, installDir, mode) {
    _gameId = gameId;
    _selectedExe = null;
    _mode = mode || 'launch';
    list.innerHTML = '<div class="exe-picker-loading">Scanning…</div>';
    launchBtn.disabled = true;
    argsInput.value = '';
    dontAsk.checked = false;
    overlay.classList.remove('hidden');

    // Update UI for mode
    if (_mode === 'shortcut') {
      if (subText) subText.textContent = 'Select which executable to create a desktop shortcut for.';
      if (launchBtn) launchBtn.textContent = 'Create Shortcut';
      if (argsRow) argsRow.style.display = 'none';
      if (dontAskRow) dontAskRow.style.display = 'none';
      if (browseBtn) browseBtn.style.display = ''; // show browse in shortcut mode too
    } else {
      if (subText) subText.textContent = 'Select which executable to launch for this game.';
      if (launchBtn) launchBtn.textContent = 'Launch';
      if (argsRow) argsRow.style.display = '';
      if (dontAskRow) dontAskRow.style.display = '';
      if (browseBtn) browseBtn.style.display = '';
    }

    // Load existing args (launch mode only)
    if (_mode === 'launch') {
      const lib = await window.api.getLibrary();
      const entry = Array.isArray(lib) ? lib.find(e => e.id === gameId) : lib[gameId];
      if (entry && entry.launchArgs) argsInput.value = entry.launchArgs;
    }

    // Fetch exe list — if installDir wasn't stored, try to derive it from the suggested exe path
    if (!installDir && suggested) {
      const parts = suggested.replace(/\\/g, '/').split('/');
      parts.pop();
      installDir = parts.join('/') || null;
    }
    const { exes } = installDir ? await window.api.listExes(installDir) : { exes: [] };
    list.innerHTML = '';

    if (exes.length === 0 && !suggested) {
      list.innerHTML = _mode === 'shortcut'
        ? '<div class="exe-picker-empty">No executables found in the install folder. Use <strong>Browse</strong> to locate the game\'s .exe manually.</div>'
        : '<div class="exe-picker-empty">No executables found. Use Browse to locate manually.</div>';
    } else {
      const all = suggested ? [suggested, ...exes.filter(e => e !== suggested)] : exes;
      all.forEach((e, i) => {
        const el = addExeItem(e);
        if (i === 0) selectExe(e, el);
      });
    }
  }

  window.launchGameWithPicker = async function (gameId) {
    let result;
    try {
      result = await window.api.launchGame(gameId);
    } catch (err) {
      setStatus('Launch error: ' + (err && err.message ? err.message : String(err)));
      console.error('Launch error:', err);
      return;
    }
    if (result && result.needsPicker) {
      await openPicker(gameId, result.suggested, result.installDir, 'launch');
    } else if (result && result.error) {
      console.error('Launch error:', result.error);
      if (result.error === 'No executable found') {
        setStatus('Launch failed: no executable found. Try re-installing or use "Fix" in library.');
      } else if (result.error === 'Game not found') {
        setStatus('Launch failed: game not found in library.');
      } else {
        setStatus('Launch failed: ' + result.error);
      }
    } else if (result && result.ok) {
      setStatus('Game launched!');
    }
  };

  window.openShortcutPicker = async function (gameId) {
    // getLibrary() returns an ARRAY of {id, ...fields}, NOT an object keyed by id
    const lib = await window.api.getLibrary();
    const entry = Array.isArray(lib)
      ? lib.find(e => e.id === gameId)
      : (lib && lib[gameId]);
    let installDir = entry && entry.installDir;
    const suggested  = entry && entry.execPath;
    // If installDir is missing but we have an execPath, derive it from the exe's directory
    if (!installDir && suggested) {
      const parts = suggested.replace(/\\/g, '/').split('/');
      parts.pop();
      installDir = parts.join('/') || null;
    }
    _shortcutTitle = entry && entry.title;
    await openPicker(gameId, suggested, installDir, 'shortcut');
  };

  if (closeBtn) closeBtn.addEventListener('click', () => overlay.classList.add('hidden'));
  if (overlay) overlay.addEventListener('click', e => { if (e.target === overlay) overlay.classList.add('hidden'); });

  if (browseBtn) browseBtn.addEventListener('click', async () => {
    const picked = await window.api.pickExe();
    if (!picked) return;
    // Check if already in list
    const existing = [...list.querySelectorAll('.exe-item')].find(
      el => el.dataset.path === picked
    );
    if (existing) { selectExe(picked, existing); return; }
    const el = addExeItem(picked);
    selectExe(picked, el);
  });

  if (launchBtn) launchBtn.addEventListener('click', async () => {
    if (!_selectedExe || !_gameId) return;

    if (_mode === 'shortcut') {
      launchBtn.disabled = true;
      launchBtn.innerHTML = '<span class="btn-spinner"></span> Creating…';
      const result = await window.api.addDesktopShortcut({ execPath: _selectedExe, title: _shortcutTitle || null });
      if (result && result.ok) {
        launchBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" style="vertical-align:middle;margin-right:4px"><polyline points="1.5,6 4.5,9.5 10.5,2.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>Shortcut Created';
        setTimeout(() => overlay.classList.add('hidden'), 1200);
      } else {
        launchBtn.textContent = 'Create Shortcut';
        launchBtn.disabled = false;
        setStatus('Failed to create shortcut' + (result && result.error ? ': ' + result.error : ''));
      }
      return;
    }

    const skipExePicker = dontAsk.checked;
    const launchArgs = argsInput.value.trim();
    await window.api.setLaunchConfig({ id: _gameId, execPath: _selectedExe, launchArgs, skipExePicker });
    overlay.classList.add('hidden');
    // Launch directly — bypass the needsPicker check since user already picked
    await window.api.launchGameNow(_gameId);
  });

  // ── Launch Settings in Settings page ──────────────────────
  const gameSelect    = $('launch-game-select');
  const configEditor  = $('launch-config-editor');
  const configExe     = $('launch-config-exe');
  const configArgs    = $('launch-config-args');
  const configSkip    = $('launch-config-skip');
  const configSave    = $('launch-config-save');
  const configBrowse  = $('launch-config-browse');
  const configStatus  = $('launch-config-status');

  async function populateLaunchGameSelect() {
    if (!gameSelect) return;
    const lib = await window.api.getLibrary();
    gameSelect.innerHTML = '<option value="">Select a game…</option>';
    Object.entries(lib)
      .filter(([, e]) => e.status === 'installed' && e.title)
      .sort(([,a],[,b]) => (a.title||'').localeCompare(b.title||''))
      .forEach(([id, e]) => {
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = e.title;
        gameSelect.appendChild(opt);
      });
  }

  if (gameSelect) {
    gameSelect.addEventListener('change', async () => {
      const id = gameSelect.value;
      if (!id) { if (configEditor) configEditor.style.display = 'none'; return; }
      const lib = await window.api.getLibrary();
      const entry = lib[id];
      if (!entry) return;
      if (configExe)  configExe.value  = entry.execPath  || '';
      if (configArgs) configArgs.value = entry.launchArgs || '';
      if (configSkip) configSkip.checked = !!entry.skipExePicker;
      if (configEditor) configEditor.style.display = 'block';
      if (configStatus) configStatus.style.display = 'none';
    });
  }

  if (configBrowse) configBrowse.addEventListener('click', async () => {
    const picked = await window.api.pickExe();
    if (picked && configExe) configExe.value = picked;
  });

  if (configSave) configSave.addEventListener('click', async () => {
    const id = gameSelect?.value;
    if (!id) return;
    await window.api.setLaunchConfig({
      id,
      execPath:       configExe?.value  || '',
      launchArgs:     configArgs?.value || '',
      skipExePicker:  configSkip?.checked || false,
    });
    if (configStatus) {
      configStatus.textContent = 'Saved!';
      configStatus.style.display = 'block';
      setTimeout(() => { configStatus.style.display = 'none'; }, 2000);
    }
  });

  // Populate when settings view is shown
  document.addEventListener('click', e => {
    if (e.target.closest('[data-view="settings"]')) {
      setTimeout(populateLaunchGameSelect, 50);
    }
  });
})();

// ── Redistributables Installer ─────────────────────────────────────────────
(function () {
  const btn        = () => document.getElementById('redist-install-btn');
  const statusText = () => document.getElementById('redist-status-text');
  const wrap       = () => document.getElementById('redist-progress-wrap');
  const bar        = () => document.getElementById('redist-progress-bar');
  const pctLabel   = () => document.getElementById('redist-progress-pct');
  const label      = () => document.getElementById('redist-progress-label');

  let listenerAttached = false;

  function attachProgressListener () {
    if (listenerAttached) return;
    listenerAttached = true;
    window.api.onRedistProgress(({ current, total, package: pkg, pct, done }) => {
      const w = wrap(), b = bar(), p = pctLabel(), l = label();
      if (!w) return;
      w.style.display = 'block';
      if (b) b.style.width = pct + '%';
      if (p) p.textContent = pct + '%';
      if (done) {
        if (l) l.textContent = 'All done!';
        if (p) p.textContent = '100%';
        const s = statusText();
        if (s) { s.textContent = 'Installed successfully'; s.style.color = '#4ade80'; }
        const installBtn = btn();
        if (installBtn) { installBtn.disabled = false; installBtn.textContent = 'Install Redistributables'; }
      } else {
        const shortName = pkg.replace('Microsoft.', '').replace('Oracle.', '');
        if (l) l.textContent = `Installing ${current + 1}/${total}: ${shortName}`;
      }
    });
  }

  function wireRedistBtn () {
    const installBtn = btn();
    if (!installBtn || installBtn._redistWired) return;
    installBtn._redistWired = true;

    attachProgressListener();

    // Show already-installed state if flag is set
    window.api.getSettings().then(settings => {
      if (settings && settings.redistInstalled) {
        const s = statusText();
        if (s) { s.textContent = 'Already installed'; s.style.color = '#4ade80'; }
        if (installBtn) installBtn.textContent = 'Reinstall Redistributables';
      }
    }).catch(() => {});

    installBtn.addEventListener('click', async () => {
      installBtn.disabled = true;
      installBtn.textContent = 'Installing…';
      const s = statusText();
      if (s) { s.textContent = ''; }
      const w = wrap(), b = bar(), p = pctLabel(), l = label();
      if (w) w.style.display = 'block';
      if (b) b.style.width = '0%';
      if (p) p.textContent = '0%';
      if (l) l.textContent = 'Starting…';

      try {
        await window.api.installRedistributables();
      } catch (err) {
        if (s) { s.textContent = 'Error: ' + (err.message || err); s.style.color = '#f87171'; }
        installBtn.disabled = false;
        installBtn.textContent = 'Reinstall Redistributables';
      }
    });
  }

  // Wire on settings page navigation
  const _origLoadSettings = window.loadSettings || (typeof loadSettings !== 'undefined' ? loadSettings : null);
  const _patchTarget = window;

  function patchLoadSettings () {
    const base = window.loadSettings;
    if (!base || base._redistPatched) return;
    base._redistPatched = true;
    window.loadSettings = async function (...args) {
      const r = await base.apply(this, args);
      wireRedistBtn();
      return r;
    };
    window.loadSettings._redistPatched = true;
  }

  // Also try wiring on any click that shows settings
  document.addEventListener('click', e => {
    if (e.target.closest('[data-tab="advanced"]') || e.target.closest('[data-view="settings"]')) {
      setTimeout(wireRedistBtn, 80);
    }
  });

  // Patch once DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', patchLoadSettings);
  } else {
    patchLoadSettings();
  }
})();

// ── Defender Exclusion (Settings → Advanced) ──────────────────
(function () {
  function wireDefenderBtn() {
    const btn    = document.getElementById('defender-exclusion-btn');
    const status = document.getElementById('defender-exclusion-status');
    if (!btn || btn._defWired) return;
    btn._defWired = true;

    // Reflect current state on load
    window.api.getSettings().then(settings => {
      if (settings.defenderExclusionAdded) {
        if (status) { status.textContent = 'Exclusion already active'; status.style.color = '#4ade80'; }
        btn.textContent = 'Re-add Exclusion';
      }
    });

    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = 'Adding…';
      if (status) { status.textContent = ''; }

      const settings = await window.api.getSettings();
      const installDir = settings.installPath || `C:\\Users\\${(window._ninoUser?.username) || '___'}\\NinoGames`;

      try {
        const result = await window.api.addDefenderExclusion(installDir);
        if (result && result.ok) {
          await window.api.saveSettings({ defenderExclusionAdded: true });
          if (status) { status.textContent = 'Exclusion added successfully'; status.style.color = '#4ade80'; }
          btn.textContent = 'Re-add Exclusion';
        } else {
          throw new Error(result?.error || 'Failed');
        }
      } catch (err) {
        if (status) {
          status.textContent = err.message.includes('cancelled')
            ? 'UAC prompt cancelled'
            : 'Failed — try running as administrator';
          status.style.color = '#f87171';
        }
        btn.textContent = 'Add Exclusion';
      }

      btn.disabled = false;
    });
  }

  document.addEventListener('click', e => {
    if (e.target.closest('[data-tab="advanced"]') || e.target.closest('[data-view="settings"]')) {
      setTimeout(wireDefenderBtn, 80);
    }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wireDefenderBtn);
  } else {
    wireDefenderBtn();
  }
})();


// ══════════════════════════════════════════════════════════════════
// ONBOARDING FLOW
// ══════════════════════════════════════════════════════════════════
(function initOnboarding() {
  const overlay     = document.getElementById('onboarding-overlay');
  if (!overlay) return;

  // Check if onboarding was already completed.
  // We require BOTH the persistent store flag AND a localStorage marker.
  // localStorage is wiped when the user clears cache, which forces onboarding
  // to re-appear even though the store file still has onboardingComplete:true.
  window.api.getSettings().then(settings => {
    if (settings.osUsername) window._osUsername = settings.osUsername;
    if (settings.onboardingComplete && localStorage.getItem('ob-session-done') === '1') return;
    
    // State
    let currentStep = 0;
    const TOTAL_STEPS = 6;

    // Pending settings collected through the flow
    const pending = {
      installPath: null,
      source:      'ankergames',
      theme:       localStorage.getItem('ninogames-theme') || 'dark',
      aria2:       true,
      sevenZip:    true,
    };

    // ── Show overlay ──────────────────────────────────────────────
    overlay.classList.remove('hidden');

  // ── Helpers ───────────────────────────────────────────────────
  function gotoStep(n, back = false) {
    const steps = overlay.querySelectorAll('.ob-step');
    const dots  = overlay.querySelectorAll('.ob-dot');
    steps[currentStep].classList.remove('active');
    if (back) steps[n].classList.add('slide-back');
    else steps[n].classList.remove('slide-back');
    setTimeout(() => steps[n].classList.remove('slide-back'), 300);
    steps[n].classList.add('active');
    dots.forEach((d, i) => d.classList.toggle('active', i === n));
    currentStep = n;
  }

  // ── Step 0: Welcome ───────────────────────────────────────────
  overlay.querySelector('#ob-welcome-next').addEventListener('click', () => gotoStep(1));

  // ── Step 1: Install Path ──────────────────────────────────────
  const pathDisplay = overlay.querySelector('#ob-path-display');

  overlay.querySelector('#ob-pick-folder').addEventListener('click', async () => {
    const folder = await window.api.pickFolder();
    if (folder) {
      pending.installPath = folder;
      pathDisplay.textContent = folder;
    }
  });

  overlay.querySelector('#ob-reset-path').addEventListener('click', () => {
    pending.installPath = null;
    pathDisplay.textContent = `Default — C:\\Users\\${window._osUsername || '___'}\\NinoGames`;
  });

  overlay.querySelector('#ob-back-1').addEventListener('click', () => gotoStep(0, true));
  overlay.querySelector('#ob-next-1').addEventListener('click', () => gotoStep(2));

  // ── Step 2: Source ────────────────────────────────────────────
  overlay.querySelectorAll('.ob-source-card').forEach(card => {
    card.addEventListener('click', () => {
      overlay.querySelectorAll('.ob-source-card').forEach(c => c.classList.remove('active'));
      card.classList.add('active');
      pending.source = card.dataset.src;
      card.querySelector('input').checked = true;
    });
  });

  overlay.querySelector('#ob-back-2').addEventListener('click', () => gotoStep(1, true));
  overlay.querySelector('#ob-next-2').addEventListener('click', () => gotoStep(3));

  // ── Step 3: Theme ─────────────────────────────────────────────
  // Pre-select saved theme
  overlay.querySelectorAll('.ob-theme-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.theme === pending.theme);
    btn.addEventListener('click', () => {
      overlay.querySelectorAll('.ob-theme-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      pending.theme = btn.dataset.theme;
      // Live preview
      applyTheme(pending.theme);
      localStorage.setItem('ninogames-theme', pending.theme);
    });
  });

  overlay.querySelector('#ob-back-3').addEventListener('click', () => gotoStep(2, true));
  overlay.querySelector('#ob-next-3').addEventListener('click', () => gotoStep(4));

  // ── Step 4: Downloads ─────────────────────────────────────────
  const aria2Toggle     = overlay.querySelector('#ob-aria2-toggle');
  const sevenzipToggle  = overlay.querySelector('#ob-sevenzip-toggle');
  aria2Toggle.addEventListener('change',    () => { pending.aria2    = aria2Toggle.checked; });
  sevenzipToggle.addEventListener('change', () => { pending.sevenZip = sevenzipToggle.checked; });

  overlay.querySelector('#ob-back-4').addEventListener('click', () => gotoStep(3, true));
  overlay.querySelector('#ob-next-4').addEventListener('click', () => gotoStep(5));

  // ── Step 5: Redistributables ──────────────────────────────────
  const redistIdleEl   = overlay.querySelector('#ob-redist-idle');
  const redistRunEl    = overlay.querySelector('#ob-redist-running');
  const redistDoneEl   = overlay.querySelector('#ob-redist-done');
  const redistPkgLbl   = overlay.querySelector('#ob-redist-pkg-label');
  const redistBar      = overlay.querySelector('#ob-redist-bar');
  const redistPct      = overlay.querySelector('#ob-redist-pct');
  const redistBtn      = overlay.querySelector('#ob-install-redist-btn');
  const finishBtn      = overlay.querySelector('#ob-finish');
  const skipLink       = overlay.querySelector('#ob-skip-redist');

  let redistStarted = false;

  redistBtn.addEventListener('click', async () => {
    if (redistStarted) return;
    redistStarted = true;
    redistBtn.disabled = true;
    redistIdleEl.classList.add('hidden');
    redistRunEl.classList.remove('hidden');

    window.api.onRedistProgress(({ current, total, package: pkg, pct, done }) => {
      redistBar.style.width = pct + '%';
      redistPct.textContent = pct + '%';
      if (pkg) redistPkgLbl.textContent = pkg;
      if (done) {
        redistRunEl.classList.add('hidden');
        redistDoneEl.classList.remove('hidden');
      }
    });

    try {
      await window.api.installRedistributables();
    } catch (err) {
      redistRunEl.classList.add('hidden');
      redistDoneEl.classList.remove('hidden');
      redistDoneEl.querySelector('.ob-redist-done-msg').textContent = 'Install finished (some packages may have failed).';
    }
  });

  overlay.querySelector('#ob-back-5').addEventListener('click', () => {
    gotoStep(4, true);
    // Reset redist state so they can restart if they want
    redistStarted = false;
    redistBtn.disabled = false;
    redistIdleEl.classList.remove('hidden');
    redistRunEl.classList.add('hidden');
    redistDoneEl.classList.add('hidden');
    redistBar.style.width = '0%';
  });

  async function finishOnboarding() {
    // Save all collected settings including onboardingComplete flag
    const settingsToSave = {
      source:          pending.source,
      aria2Enabled:    pending.aria2,
      sevenZipEnabled: pending.sevenZip,
      onboardingComplete: true,
    };
    if (pending.installPath) settingsToSave.installPath = pending.installPath;
    await window.api.saveSettings(settingsToSave);
    // Mirror completion in localStorage so cache-clear forces re-onboarding
    localStorage.setItem('ob-session-done', '1');

    // Update live app state
    appState.settings = Object.assign(appState.settings || {}, settingsToSave);

    // Hide overlay
    overlay.style.opacity = '0';
    overlay.style.transition = 'opacity 0.3s ease';
    setTimeout(() => overlay.classList.add('hidden'), 320);

    // Sync settings page if open
    if (appState.currentPage === 'settings') (window.loadSettings || loadSettings)();
    setStatus('Setup complete! Welcome to NinoGames.');
  }

  finishBtn.addEventListener('click', finishOnboarding);
  skipLink.addEventListener('click', finishOnboarding);
  });
})();





