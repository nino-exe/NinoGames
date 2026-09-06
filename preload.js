'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Window
  winMinimize:  () => ipcRenderer.send('win-minimize'),
  winMaximize:  () => ipcRenderer.send('win-maximize'),
  winClose:     () => ipcRenderer.send('win-close'),
  openExternal: url => ipcRenderer.send('open-external', url),
  openPath:     p   => ipcRenderer.send('open-path', p),
  openTrailer:  (videoId, title) => ipcRenderer.invoke('open-trailer', { videoId, title }),
  getTrailerPort: () => ipcRenderer.invoke('get-trailer-port'),
  onWindowState: cb => ipcRenderer.on('window-state', (_e, s) => cb(s)),

  // Search / game info
  search:        (q, p, src) => ipcRenderer.invoke('search', { query: q, page: p, source: src }),
  getGamePage:   url    => ipcRenderer.invoke('get-game-page', url),
  getTrailerVideoId: url => ipcRenderer.invoke('get-trailer-video-id', url),
  fetchUpcoming:  ()    => ipcRenderer.invoke('fetch-upcoming'),
  fetchGotd:      ()    => ipcRenderer.invoke('fetch-gotd'),
  fetchDiscovery: (page) => ipcRenderer.invoke('fetch-discovery', page),
  fetchDiscoveryAll: () => ipcRenderer.invoke('fetch-discovery-all'),
  fetchGamesList: (opts) => ipcRenderer.invoke('fetch-games-list', opts),
  fetchPageCover: (url) => ipcRenderer.invoke('fetch-page-cover', url),
  resolveBzzhr: (url) => ipcRenderer.invoke('resolve-bzzhr', url),

  // Library
  getLibrary:    ()        => ipcRenderer.invoke('get-library'),
  getLibrarySize: (opts)   => ipcRenderer.invoke('get-library-size', opts),
  scanLibrary:   ()        => ipcRenderer.invoke('scan-library'),
  removeGame:    id        => ipcRenderer.invoke('remove-game', id),
  uninstallGame: id        => ipcRenderer.invoke('uninstall-game', id),
  launchGame:       id     => ipcRenderer.invoke('launch-game', id),
  launchGameNow:    id     => ipcRenderer.invoke('launch-game-now', id),
  listExes:         dir    => ipcRenderer.invoke('list-exes', dir),
  pickExe:          ()     => ipcRenderer.invoke('pick-exe'),
  setLaunchConfig:  opts   => ipcRenderer.invoke('set-launch-config', opts),

  // Wishlist
  getWishlist:    ()     => ipcRenderer.invoke('get-wishlist'),
  isWishlisted:   id     => ipcRenderer.invoke('is-wishlisted', id),
  toggleWishlist: game   => ipcRenderer.invoke('toggle-wishlist', game),

  // Downloads
  startDownload:         opts => ipcRenderer.invoke('start-download', opts),
  cancelDownload:  id      => ipcRenderer.invoke('cancel-download', id),
  pauseDownload:   id      => ipcRenderer.invoke('pause-download', id),
  resumeDownload:  id      => ipcRenderer.invoke('resume-download', id),
  retryExtract:    id      => ipcRenderer.invoke('retry-extract', id),

  // Settings
  getSettings:  ()  => ipcRenderer.invoke('get-settings'),
  saveSettings: s   => ipcRenderer.invoke('save-settings', s),
  pickFolder:   ()  => ipcRenderer.invoke('pick-folder'),
  uninstallApp: opts => ipcRenderer.invoke('uninstall-app', opts),

  // Extra game actions
  addToSteam:         opts => ipcRenderer.invoke('add-to-steam', opts),
  addToSteamExternal: opts => ipcRenderer.invoke('add-to-steam-external', opts),
  addToSteamLib:      opts => ipcRenderer.invoke('add-to-steam-lib', opts),
  addDesktopShortcut: opts => ipcRenderer.invoke('add-desktop-shortcut', opts),
  run7zipElevated:    opts => ipcRenderer.invoke('run-7zip-elevated', opts),
  rpcAvailable:  ()       => ipcRenderer.invoke('rpc-available'),
  rpcRunning:    ()       => ipcRenderer.invoke('rpc-running'),
  onRpcStatus:   cb       => ipcRenderer.on('rpc-status', (_e, d) => cb(d)),
  getRpcConfig:  ()       => ipcRenderer.invoke('get-rpc-config'),
  saveRpcConfig: cfg      => ipcRenderer.invoke('save-rpc-config', cfg),
  updateRPC:    activity => ipcRenderer.invoke('update-rpc', activity),
  clearRPC:     ()       => ipcRenderer.invoke('clear-rpc'),
  onTrayLaunchGame: cb => ipcRenderer.on('tray-launch-game', (_e, d) => cb(d)),

  // Events from main
  onDownloadProgress: cb => ipcRenderer.on('download-progress', (_e, d) => cb(d)),
  onDownloadDone:     cb => ipcRenderer.on('download-done',     (_e, d) => cb(d)),
  onDownloadStatus:   cb => ipcRenderer.on('download-status',   (_e, d) => cb(d)),
  onExtractProgress:  cb => ipcRenderer.on('extract-progress',  (_e, d) => cb(d)),
  onLibraryUpdated:   cb => ipcRenderer.on('library-updated',   (_e)    => cb()),
  onUacConfirmNeeded: cb => ipcRenderer.on('uac-confirm-needed', (_e, d) => cb(d)),
  sendUacResponse:    (proceed, gameId) => ipcRenderer.send('uac-confirm-response', { proceed, gameId }),

  checkAria2:            ()       => ipcRenderer.invoke('check-aria2'),
  getDevtoolsInfo:       ()       => ipcRenderer.invoke('get-devtools-info'),
  captureScraperPreview: (gameId) => ipcRenderer.invoke('capture-scraper-preview', gameId),
  openDevTools:          ()       => ipcRenderer.send('open-devtools'),
  clearCacheAndRestart:  ()       => ipcRenderer.invoke('clear-cache-and-restart'),
  onToggleDevtoolsPanel: cb       => ipcRenderer.on('toggle-devtools-panel', () => cb()),

  // Price lookup
  fetchGamePrice: (title) => ipcRenderer.invoke('fetch-game-price', title),

  // Verify
  verifyInstall:   (gameId) => ipcRenderer.invoke('verify-install', gameId),
  checkDiskSpace:  ()       => ipcRenderer.invoke('check-disk-space'),

  // Redistributables
  installRedistributables: () => ipcRenderer.invoke('install-redistributables'),
  onRedistProgress: cb => ipcRenderer.on('redist-progress', (_e, d) => cb(d)),
  addDefenderExclusion: (folderPath) => ipcRenderer.invoke('add-defender-exclusion', folderPath),

  // Updater
  getAppVersion:    ()    => ipcRenderer.invoke('get-app-version'),
  checkForUpdate:   ()    => ipcRenderer.invoke('check-for-update'),
  applyUpdate:      url   => ipcRenderer.invoke('apply-update', url),
  onUpdateProgress: cb    => ipcRenderer.on('update-progress', (_e, d) => cb(d)),

  // Multiplayer Mods
  getMultiplayerMods:      ()     => ipcRenderer.invoke('get-multiplayer-mods'),
  installMultiplayerMod:   modId  => ipcRenderer.invoke('install-multiplayer-mod', modId),
  launchMultiplayerMod:    modId  => ipcRenderer.invoke('launch-multiplayer-mod', modId),
  uninstallMultiplayerMod: modId  => ipcRenderer.invoke('uninstall-multiplayer-mod', modId),
  onMpModProgress:         cb     => ipcRenderer.on('mp-mod-progress', (_e, d) => cb(d)),

  // Game Tracking
  getTracking:         ()       => ipcRenderer.invoke('get-tracking'),
  killTrackedGame:     ()       => ipcRenderer.invoke('kill-tracked-game'),
  onGameStarted:       cb       => ipcRenderer.on('game-started',        (_e, d) => cb(d)),
  onGameStopped:       cb       => ipcRenderer.on('game-stopped',        (_e, d) => cb(d)),
  onPlaytimeTick:      cb       => ipcRenderer.on('playtime-tick',       (_e, d) => cb(d)),
  onCloseRequested:    cb       => ipcRenderer.on('close-requested',     ()      => cb()),
  onAchievementUnlocked: cb     => ipcRenderer.on('achievement-unlocked',(_e, d) => cb(d)),
  onAutoLaunchGame:    cb       => ipcRenderer.on('auto-launch-game',    (_e, d) => cb(d)),
  confirmClose:        ()       => ipcRenderer.send('confirm-close'),

  // Party (EasyTier multiplayer)
  partyGetState:      ()     => ipcRenderer.invoke('party-get-state'),
  partyInstallEasyTier: ()   => ipcRenderer.invoke('party-install-easytier'),
  partyHost:          ()     => ipcRenderer.invoke('party-host'),
  partyJoin:          code   => ipcRenderer.invoke('party-join', code),
  partyLeave:         ()     => ipcRenderer.invoke('party-leave'),
  partyGetMembers:    ()     => ipcRenderer.invoke('party-get-members'),
  // Accepts either a bare modId or { modId, fields } from the host settings form.
  partyStartHostGame: arg  => ipcRenderer.invoke('party-start-host-game', arg),
  partyHostGtacServer: ({ modId, fields }) => ipcRenderer.invoke('party-host-gtac-server', { modId, fields }),
  partyJoinGame:      modId  => ipcRenderer.invoke('party-join-game', modId),
  iw4xLaunchDevmap:   opts   => ipcRenderer.invoke('iw4x-launch-devmap', opts),
  onPartyState:       cb     => ipcRenderer.on('party-state', (_e, d) => cb(d)),
  onPartyEvent:       cb     => ipcRenderer.on('party-event', (_e, d) => cb(d)),
  onPartyInstallProgress: cb => ipcRenderer.on('party-install-progress', (_e, d) => cb(d)),
  onGtacServerProgress: cb  => ipcRenderer.on('gtac-server-progress', (_e, d) => cb(d)),
});
