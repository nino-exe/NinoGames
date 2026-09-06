'use strict';
// ══════════════════════════════════════════════════════════════
// Party (EasyTier multiplayer) — renderer-side UI logic
// Depends on window.api (preload) and $() / setStatus() helpers
// already defined by renderer.js.
// ══════════════════════════════════════════════════════════════
(function () {
  const $ = id => document.getElementById(id);

  let partyState = { role: null, status: 'idle', installed: false };
  let selectedModId = null;
  let installingEasyTier = false;

  function fmt(el, txt) { if (el) el.textContent = txt; }

  // ── Top bar: pill / install-prompt / new+join buttons ─────────
  function renderPill() {
    const pill = $('party-pill');
    const newBtn = $('party-new-btn');
    const joinBtn = $('party-join-btn');
    const installRow = $('party-install-row');
    if (!pill) return;

    if (partyState.status === 'connected' || partyState.status === 'connecting') {
      pill.classList.remove('hidden');
      newBtn.classList.add('hidden');
      joinBtn.classList.add('hidden');
      installRow.classList.add('hidden');
      fmt($('party-pill-text'),
        partyState.status === 'connecting'
          ? 'Connecting…'
          : (partyState.role === 'host' ? 'Hosting Party' : 'In Party'));
      return;
    }

    pill.classList.add('hidden');

    if (!partyState.installed && !installingEasyTier) {
      installRow.classList.remove('hidden');
      newBtn.classList.add('hidden');
      joinBtn.classList.add('hidden');
      fmt($('party-install-label'), 'Multiplayer parties need EasyTier (~15MB, one-time)');
      $('party-install-btn').disabled = false;
      $('party-install-btn').textContent = 'Enable Multiplayer';
    } else if (installingEasyTier) {
      installRow.classList.remove('hidden');
      newBtn.classList.add('hidden');
      joinBtn.classList.add('hidden');
      $('party-install-btn').disabled = true;
    } else {
      installRow.classList.add('hidden');
      newBtn.classList.remove('hidden');
      joinBtn.classList.remove('hidden');
    }
  }

  // ── One-time EasyTier download, triggered from the top bar ────
  async function installEasyTier() {
    if (installingEasyTier) return;
    installingEasyTier = true;
    renderPill();
    const result = await window.api.partyInstallEasyTier();
    installingEasyTier = false;
    if (result && result.error) {
      setStatus(`Couldn't set up multiplayer: ${result.error}`);
    } else {
      setStatus('Multiplayer is ready — create or join a party!');
    }
    await refreshPartyState();
  }

  if (window.api && window.api.onPartyInstallProgress) {
    window.api.onPartyInstallProgress(progress => {
      const label = $('party-install-label');
      if (!label) return;
      if (progress.phase === 'downloading' && progress.pct != null) {
        fmt(label, `Downloading EasyTier… ${progress.pct}%`);
      } else if (progress.msg) {
        fmt(label, progress.msg);
      }
    });
  }

  // ── Custom game dropdown ─────────────────────────────────────
  let _cachedMods = [];
  let selectedMap = null;

  function buildGameSelect(mods) {
    const wrap = $('party-game-select');
    const list = $('party-game-list');
    const face = wrap && wrap.querySelector('.party-select-text');
    if (!wrap || !list || !face) return;

    list.innerHTML = '';
    _cachedMods = mods;

    mods.forEach(mod => {
      const row = document.createElement('div');
      row.className = 'party-select-opt' + (mod.installed ? '' : ' disabled') +
                      (mod.id === selectedModId ? ' selected' : '');
      row.dataset.id = mod.id;
      row.innerHTML =
        `<span class="party-select-opt-check"><svg width="10" height="8" viewBox="0 0 10 8" fill="none"><path d="M1 4l3 3 5-6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></span>` +
        `<span class="party-select-opt-label">${mod.name}</span>` +
        (mod.installed
          ? `<span class="party-select-opt-badge">Installed</span>`
          : `<span class="party-select-opt-badge">Not installed</span>`);

      if (mod.installed) {
        row.addEventListener('click', () => {
          selectedModId = mod.id;
          list.querySelectorAll('.party-select-opt').forEach(r => r.classList.remove('selected'));
          row.classList.add('selected');
          face.textContent = mod.name;
          face.classList.remove('placeholder');
          wrap.classList.remove('open');
          updateGameWarning(_cachedMods);
          updateDevmapSettings();
        });
      }
      list.appendChild(row);
    });

    // Update face label
    const activeMod = mods.find(m => m.id === selectedModId);
    if (activeMod) {
      face.textContent = activeMod.name;
      face.classList.remove('placeholder');
    } else {
      face.textContent = mods.length ? 'Select a game…' : 'No games available';
      face.classList.add('placeholder');
    }
  }

  function initGameSelectToggle() {
    const wrap = $('party-game-select');
    if (!wrap || wrap._partySelectInited) return;
    wrap._partySelectInited = true;

    wrap.addEventListener('click', e => {
      if (e.target.closest('.party-select-opt')) return;
      wrap.classList.toggle('open');
    });
    wrap.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); wrap.classList.toggle('open'); }
      if (e.key === 'Escape') wrap.classList.remove('open');
    });
    document.addEventListener('click', e => {
      if (!wrap.contains(e.target)) wrap.classList.remove('open');
    });
  }

  async function populateGameSelect() {
    initGameSelectToggle();
    let mods = [];
    try { mods = await window.api.getMultiplayerMods(); } catch { mods = []; }
    const firstInstalled = mods.find(m => m.installed);
    selectedModId = (firstInstalled && firstInstalled.id) || (mods[0] && mods[0].id) || null;
    buildGameSelect(mods);
    updateGameWarning(mods);
    updateDevmapSettings();
  }

  function updateGameWarning(mods) {
    const warn = $('party-game-warning');
    const startBtn = $('party-start-btn');
    if (!warn) return;
    const mod = (mods || []).find(m => m.id === selectedModId);
    if (mod && !mod.installed) {
      warn.textContent = `${mod.name} isn't installed yet — install it from the Multiplayer tab first.`;
      warn.classList.remove('hidden');
      if (startBtn) startBtn.disabled = true;
    } else {
      warn.classList.add('hidden');
      if (startBtn) startBtn.disabled = partyState.status !== 'connected';
    }
  }

  // ── Host-only devmap settings: map picker + limits ─────────────
  function buildMapGrid(maps) {
    const grid = $('party-map-grid');
    if (!grid) return;
    grid.innerHTML = '';
    (maps || []).forEach(map => {
      const card = document.createElement('div');
      card.className = 'party-map-card' +
                        (map.image ? ' has-img' : ' party-map-theme-' + (map.theme || 'urban')) +
                        (map.id === selectedMap ? ' selected' : '');
      card.dataset.id = map.id;
      card.setAttribute('role', 'option');
      card.setAttribute('aria-selected', map.id === selectedMap ? 'true' : 'false');
      card.title = map.name;
      const imgHtml = map.image
        ? `<img class="party-map-img" src="${escapeHtml(map.image)}" alt="${escapeHtml(map.name)}" loading="lazy" onerror="this.remove();const _c=this.parentElement.parentElement;_c.classList.remove('has-img');_c.classList.add('party-map-theme-${map.theme || 'urban'}')"/>`
        : '';
      card.innerHTML =
        `<div class="party-map-thumb">${imgHtml}<div class="party-map-label">${escapeHtml(map.name)}</div></div>` +
        `<span class="party-map-check"><svg width="9" height="7" viewBox="0 0 10 8" fill="none"><path d="M1 4l3 3 5-6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></span>`;
      card.addEventListener('click', () => {
        selectedMap = map.id;
        grid.querySelectorAll('.party-map-card').forEach(c => {
          c.classList.toggle('selected', c.dataset.id === selectedMap);
          c.setAttribute('aria-selected', c.dataset.id === selectedMap ? 'true' : 'false');
        });
      });
      grid.appendChild(card);
    });
  }

  // Shows/hides + populates the host-only settings block. For ordinary mods
  // this is the devmap block (timelimit, scorelimit, map picker); for GTAC it
  // becomes the server.xml editor GUI (name, players, password, port, world).
  // Only relevant for the host — joining players just connect to the host.
  function updateDevmapSettings() {
    const box = $('party-section-options');
    const devmapEl = $('party-devmap-settings');
    const gtacEl = $('party-gtac-settings');
    const srvEl = $('party-server-settings');
    if (!box) return;
    const mod = (_cachedMods || []).find(m => m.id === selectedModId);
    const partyCfg = (mod && mod.party) || {};
    const isHost = partyState.role === 'host';
    const isGtac = isHost && partyCfg.mode === 'gtac';
    const hasMaps = Array.isArray(partyCfg.maps) && partyCfg.maps.length > 0;
    // Mods that run their own dedicated server declare the settings they want
    // on the host screen, rather than each one getting a hardcoded panel.
    const srvFields = (isHost && !isGtac && Array.isArray(partyCfg.serverFields))
      ? partyCfg.serverFields : [];
    const hasSrvFields = srvFields.length > 0;

    if (!isHost || !mod || (!hasMaps && !isGtac && !hasSrvFields)) {
      box.classList.add('hidden');
      return;
    }
    box.classList.remove('hidden');

    if (devmapEl) devmapEl.classList.toggle('hidden', isGtac || !hasMaps);
    if (gtacEl) gtacEl.classList.toggle('hidden', !isGtac);
    if (srvEl) srvEl.classList.toggle('hidden', !hasSrvFields);

    if (hasSrvFields) buildServerFields(srvFields);

    if (isGtac) {
      resetGtacServerForm();
      return;
    }
    if (!hasMaps) return;

    if (!selectedMap || !partyCfg.maps.some(m => m.id === selectedMap)) {
      selectedMap = partyCfg.defaultMap || partyCfg.maps[0].id;
    }
    buildMapGrid(partyCfg.maps);

    const tlInput = $('party-timelimit-input');
    const slInput = $('party-scorelimit-input');
    if (tlInput && tlInput.dataset.modId !== selectedModId) {
      tlInput.value = partyCfg.defaultTimelimit ?? 0;
      tlInput.dataset.modId = selectedModId;
    }
    if (slInput && slInput.dataset.modId !== selectedModId) {
      slInput.value = partyCfg.defaultScorelimit ?? 250;
      slInput.dataset.modId = selectedModId;
    }
  }

  // ── Host server settings, built from party.serverFields ─────
  // The mod declares which of its server's settings are worth exposing; this
  // renders them and reads them back. Rebuilt only when the selected mod
  // changes so a host's edits survive the periodic state refresh.
  function buildServerFields(defs) {
    const wrap = $('party-server-fields');
    if (!wrap || wrap.dataset.modId === selectedModId) return;
    wrap.dataset.modId = selectedModId;
    wrap.innerHTML = '';

    defs.forEach(def => {
      const field = document.createElement('div');
      field.className = 'party-limit-field';

      const label = document.createElement('label');
      label.className = 'party-field-label';
      label.htmlFor = `srvfield-${def.key}`;
      label.textContent = def.label || def.key;
      field.appendChild(label);

      const input = document.createElement('input');
      input.id = `srvfield-${def.key}`;
      input.dataset.key = def.key;
      input.dataset.type = def.type || 'number';
      if (def.type === 'bool') {
        input.type = 'checkbox';
        input.className = 'party-field-check';
        input.checked = def.default !== false;
      } else {
        input.type = 'number';
        input.className = 'party-page-input party-limit-input';
        if (def.min != null) input.min = def.min;
        if (def.max != null) input.max = def.max;
        input.step = def.step || 1;
        input.value = def.default != null ? def.default : 0;
      }
      if (def.hint) input.title = def.hint;
      field.appendChild(input);

      if (def.hint) {
        const hint = document.createElement('div');
        hint.className = 'party-field-hint';
        hint.textContent = def.hint;
        field.appendChild(hint);
      }
      wrap.appendChild(field);
    });
  }

  function readServerFields() {
    const wrap = $('party-server-fields');
    const out = {};
    if (!wrap) return out;
    wrap.querySelectorAll('input[data-key]').forEach(el => {
      out[el.dataset.key] = el.dataset.type === 'bool'
        ? el.checked
        : (parseInt(el.value, 10) || 0);
    });
    return out;
  }

  // Reset the server.xml form when the selected mod changes, so a leftover
  // previous session's values (or another game's picks) never carry over.
  function resetGtacServerForm() {
    const field = $('gtac-maxplayers');
    if (!field || field.dataset.modId === selectedModId) return;
    field.dataset.modId = selectedModId;
    field.value = 16;
  }

  // Reads the server.xml editor fields into a plain object for main.js. Only
  // max players is editable — the rest of the config is fixed by the template.
  function readGtacServerFields() {
    return {
      maxplayers: $('gtac-maxplayers') ? parseInt($('gtac-maxplayers').value, 10) || 16 : 16,
    };
  }

  // ── Party members (players in the party) ────────────────────
  let partyMembers = [];
  let membersTimer = null;

  function renderPartyMembers() {
    const list = $('party-members');
    const empty = $('party-members-empty');
    const count = $('party-player-count');
    if (!list) return;
    const hostIp = partyState.hostIp || '10.244.244.1';
    const selfIp = partyState.selfIp;
    const sorted = partyMembers.slice().sort((a, b) => {
      const aHost = a.ip === hostIp ? 0 : 1;
      const bHost = b.ip === hostIp ? 0 : 1;
      if (aHost !== bHost) return aHost - bHost;
      return String(a.ip).localeCompare(String(b.ip));
    });
    if (count) fmt(count, sorted.length ? `· ${sorted.length}` : '');
    list.innerHTML = '';
    if (!sorted.length) {
      if (empty) empty.classList.remove('hidden');
      return;
    }
    if (empty) empty.classList.add('hidden');

    sorted.forEach(m => {
      const name = (m.hostname ? escapeHtml(m.hostname) : (m.isSelf ? 'This device' : 'Connected player'));
      const badges =
        (m.ip === hostIp ? '<span class="party-member-badge host">Host</span>' : '') +
        (m.ip === selfIp ? '<span class="party-member-badge me">You</span>' : '');
      const avatarLetter = (m.hostname || 'P').charAt(0).toUpperCase();
      const row = document.createElement('div');
      row.className = 'party-member' + (m.ip === selfIp ? ' self' : '');
      row.innerHTML =
        `<div class="party-member-avatar">${escapeHtml(avatarLetter)}</div>` +
        `<div class="party-member-main">` +
          `<div class="party-member-name">${name} ${badges}</div>` +
          `<div class="party-member-ip">${escapeHtml(m.ip)}</div>` +
        `</div>` +
        (m.latencyMs ? `<span class="party-member-ping">${escapeHtml(m.latencyMs)}ms</span>` : '');
      list.appendChild(row);
    });
  }

  async function refreshPartyMembers() {
    try {
      const res = await window.api.partyGetMembers();
      partyMembers = (res && res.members) || [];
    } catch {
      partyMembers = [];
    }
    renderPartyMembers();
  }

  // Poll peer list every 3s while connected so the players section stays
  // live (someone joins / leaves) without reloading the whole party page.
  function ensureMembersPolling() {
    const should = partyState.status === 'connected';
    if (should && !membersTimer) {
      membersTimer = setInterval(() => refreshPartyMembers(), 3000);
      refreshPartyMembers();
    } else if (!should && membersTimer) {
      clearInterval(membersTimer);
      membersTimer = null;
      partyMembers = [];
    }
  }

  // ── Page sections (join / connecting / panel) ──────────────
  function showPartySection(section) {
    // section: 'join' | 'connecting' | 'panel'
    const join = $('party-section-join');
    const connecting = $('party-panel-connecting');
    const body = $('party-panel-body');
    if (join) join.classList.toggle('hidden', section !== 'join');
    if (connecting) connecting.classList.toggle('hidden', section !== 'connecting');
    if (body) body.classList.toggle('hidden', section !== 'panel');
  }

  function openPartyPage(section) {
    if (typeof navigateTo === 'function') {
      if (typeof appState !== 'undefined' && appState.currentPage !== 'party') appState.prevPage = appState.currentPage;
      navigateTo('party');
    }
    showPartySection(section);
  }

  function closePartyPage() {
    if (typeof navigateTo === 'function') {
      navigateTo((typeof appState !== 'undefined' && appState.prevPage) || 'multiplayer');
    }
  }

  function resetJoinForm() {
    $('party-join-code-input').value = '';
    $('party-join-error').classList.add('hidden');
  }

  function renderPanel() {
    const startBtn = $('party-start-btn');

    if (partyState.status === 'connecting') {
      showPartySection('connecting');
      if (startBtn) startBtn.disabled = true;
      return;
    }
    // Defensively disable the button here; it gets re-enabled below
    // only when status is confirmed 'connected'.
    if (startBtn) startBtn.disabled = true;
    showPartySection('panel');

    const roleBadge = $('party-role-badge');
    const codeRow = $('party-code-row');
    const ipRow = $('party-ip-row');

    if (partyState.role === 'host') {
      roleBadge.textContent = 'Hosting';
      fmt($('party-page-title'), 'Hosting Party');
      codeRow.classList.remove('hidden');
      fmt($('party-code-text'), partyState.code || `${partyState.networkName}-${partyState.networkSecret}`);
      ipRow.innerHTML = `Hosting on <strong>${partyState.hostIp || '10.244.244.1'}</strong> — hit Start Game, then everyone else hits Join Game.`;
      startBtn.textContent = 'Start Game';
    } else {
      roleBadge.textContent = 'Joined Party';
      fmt($('party-page-title'), 'Party');
      codeRow.classList.add('hidden');
      ipRow.innerHTML = `Connected to <strong>${partyState.hostIp || '10.244.244.1'}</strong> — hit Join Game when the host is ready.`;
      startBtn.textContent = 'Join Game';
    }

    startBtn.disabled = partyState.status !== 'connected';
    updateDevmapSettings();
    ensureMembersPolling();
  }

  // ── Actions ─────────────────────────────────────────────────────
  async function createParty() {
    partyState.status = 'connecting';
    renderPill();
    openPartyPage('connecting');
    fmt($('party-page-title'), 'Party');
    renderPanel();
    const result = await window.api.partyHost();
    if (result && result.error) {
      closePartyPage();
      setStatus(`Party creation failed: ${result.error}`);
      partyState.status = 'idle';
      renderPill();
      return;
    }
    await refreshPartyState();
    await populateGameSelect();
    renderPanel();
    setStatus('Party created — share the code with your friends!');
  }

  async function joinPartyWithCode(code) {
    const errBox = $('party-join-error');
    errBox.classList.add('hidden');
    const result = await window.api.partyJoin(code);
    if (result && result.error) {
      errBox.textContent = result.error;
      errBox.classList.remove('hidden');
      return;
    }
    resetJoinForm();
    await refreshPartyState();
    await populateGameSelect();
    renderPanel();
    setStatus('Joined the party!');
  }

  async function leaveParty() {
    await window.api.partyLeave();
    await refreshPartyState();
    closePartyPage();
    setStatus('Left the party.');
  }

  async function startOrJoinGame() {
    if (!selectedModId) return;
    const startBtn = $('party-start-btn');
    startBtn.disabled = true;
    const prevLabel = startBtn.textContent;
    startBtn.textContent = 'Launching…';

    // Refresh state from main process before launching so we never
    // act on a stale cached role/status and hit the "create a party
    // first" guard in main.js.
    await refreshPartyState();

    const mod = (_cachedMods || []).find(m => m.id === selectedModId);
    const partyCfg = (mod && mod.party) || {};
    const isGtacHost = partyState.role === 'host' && partyCfg.mode === 'gtac';
    const usesDevmap = !isGtacHost && partyState.role === 'host' && Array.isArray(partyCfg.maps) && partyCfg.maps.length > 0;

    let result;
    if (isGtacHost) {
      // GTAC hosts run a real dedicated server (downloaded once) configured
      // through the server.xml editor GUI — no devmap args involved.
      result = await window.api.partyHostGtacServer({
        modId: selectedModId,
        fields: readGtacServerFields(),
      });
      if (result && result.ok && result.port) {
        startBtn.dataset.gtacPort = String(result.port);
        startBtn.dataset.gtacIp = String(result.ip || '10.244.244.1');
        if ($('party-ip-row')) {
          $('party-ip-row').innerHTML = `Server up at <strong>${result.ip || '10.244.244.1'}:${result.port}</strong> — everyone hits Join Game.`;
        }
      }
    } else if (usesDevmap) {
      // Reliable official method: single iw4x.exe process with +devmap,
      // no separate detached dedicated-server process to babysit.
      const tlInput = $('party-timelimit-input');
      const slInput = $('party-scorelimit-input');
      const timelimit  = tlInput ? Math.max(0, parseInt(tlInput.value, 10) || 0) : undefined;
      const scorelimit = slInput ? Math.max(0, parseInt(slInput.value, 10) || 0) : undefined;
      result = await window.api.iw4xLaunchDevmap({
        modId: selectedModId,
        map: selectedMap,
        timelimit,
        scorelimit,
      });
    } else if (partyState.role === 'host') {
      result = await window.api.partyStartHostGame({
        modId: selectedModId,
        fields: readServerFields(),
      });
    } else {
      result = await window.api.partyJoinGame(selectedModId);
    }

    startBtn.disabled = false;
    startBtn.textContent = prevLabel;

    if (result && result.error) {
      setStatus(`Launch failed: ${result.error}`);
    } else if (usesDevmap) {
      const mapName = (partyCfg.maps.find(m => m.id === result.map) || {}).name || result.map;
      setStatus(`Hosting ${mapName} — waiting for your party to join.`);
    } else {
      setStatus(partyState.role === 'host'
        ? `Hosting on ${result.ip}:${result.port} — waiting for your party to join.`
        : `Connecting to ${result.ip}:${result.port}…`);
    }
  }

  async function refreshPartyState() {
    try { partyState = await window.api.partyGetState(); } catch { partyState = { role: null, status: 'idle', installed: false }; }
    renderPill();
    ensureMembersPolling();
  }

  // ── Wire up ──────────────────────────────────────────────────────
  function init() {
    if (!window.api || !window.api.partyGetState) return; // preload not ready / old build

    $('party-install-btn').addEventListener('click', installEasyTier);
    $('party-new-btn').addEventListener('click', createParty);
    $('party-join-btn').addEventListener('click', () => {
      resetJoinForm();
      fmt($('party-page-title'), 'Join a Party');
      openPartyPage('join');
    });
    $('party-join-confirm-btn').addEventListener('click', () => {
      const code = $('party-join-code-input').value.trim();
      if (code) joinPartyWithCode(code);
    });
    $('party-join-code-input').addEventListener('keydown', e => {
      if (e.key === 'Enter') $('party-join-confirm-btn').click();
    });

    $('party-pill').addEventListener('click', async () => {
      await refreshPartyState();
      await populateGameSelect();
      openPartyPage('panel');
      renderPanel();
    });
    $('party-page-back-btn').addEventListener('click', closePartyPage);
    $('party-leave-btn').addEventListener('click', leaveParty);
    $('party-start-btn').addEventListener('click', startOrJoinGame);

    $('party-code-copy').addEventListener('click', () => {
      const text = $('party-code-text').textContent;
      if (!text) return;
      navigator.clipboard.writeText(text).then(() => {
        const btn = $('party-code-copy');
        btn.classList.add('copied');
        const label = btn.lastChild;
        if (label && label.nodeType === Node.TEXT_NODE) label.textContent = ' Copied!';
        setTimeout(() => {
          btn.classList.remove('copied');
          if (label && label.nodeType === Node.TEXT_NODE) label.textContent = ' Copy';
        }, 1400);
      });
    });

    if (window.api.onPartyState) {
      window.api.onPartyState(st => {
        partyState = st;
        renderPill();
        const onPartyPage = typeof appState !== 'undefined' && appState.currentPage === 'party';
        const panelVisible = $('party-panel-body') && !$('party-panel-body').classList.contains('hidden');
        const connectingVisible = $('party-panel-connecting') && !$('party-panel-connecting').classList.contains('hidden');
        if (onPartyPage && (panelVisible || connectingVisible)) renderPanel();
      });
    }

    // GTAC: surface dedicated-server staging (download/extract) progress on
    // the Start Game / Join Game button while partyHostGtacServer runs.
    if (window.api.onGtacServerProgress) {
      window.api.onGtacServerProgress(progress => {
        const btn = $('party-start-btn');
        if (!btn || btn.disabled || !progress) return;
        if (progress.msg) {
          if (progress.phase === 'downloading' && progress.pct != null) {
            btn.textContent = `${progress.msg} ${progress.pct}%`;
          } else {
            btn.textContent = progress.msg;
          }
        }
      });
    }

    refreshPartyState();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
