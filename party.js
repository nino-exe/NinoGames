'use strict';
// ══════════════════════════════════════════════════════════════
// EasyTier Party integration
//
// Lets players spin up an ad-hoc virtual LAN (using EasyTier, a
// decentralized P2P mesh VPN) and then launch a supported
// multiplayer mod (e.g. IW4x) straight into a host/join session
// over that virtual LAN — no port forwarding, no dedicated server.
//
// EasyTier itself is NOT bundled with NinoGames — most players
// never touch multiplayer, so shipping a ~15-20MB binary to
// everyone is wasteful. Instead, ensureEasyTierInstalled() lazily
// downloads it straight from EasyTier's GitHub releases the first
// time someone actually creates or joins a Party.
//
// Convention used here (keeps things simple & robust):
//   - The HOST always takes the virtual IP 10.244.244.1
//   - Each JOINING client picks a random virtual IP in
//     10.244.244.2 - 10.244.244.250
//   - Network name + secret (== the "party code") are generated
//     randomly per party and shared out-of-band by whoever hosts.
//   - EasyTier's public shared nodes are used for NAT traversal
//     and peer discovery (-p tcp://<shared-node>:11010), so no one
//     needs a public IP or to forward ports. Several nodes can be
//     given; all party members must use the same list of nodes.
// ══════════════════════════════════════════════════════════════

const { app, net } = require('electron');
const path = require('path');
const fs   = require('fs');
const os   = require('os');
const cp   = require('child_process');
const crypto = require('crypto');

const HOST_IP = '10.244.244.1';
const SUBNET_PREFIX = '10.244.244.';
const RPC_PORTAL = '127.0.0.1:15888';
// Rendezvous / relay nodes. Every party member must use the same list.
//
// This is a single third-party host, which makes it both a single point of
// failure and the latency floor for any pair of players who cannot hole-punch
// directly — `easytier-cli peer` currently measures it at ~171 ms. Adding a
// couple of closer, verified nodes here would do more for felt latency than
// any amount of tuning below.
const PUBLIC_RELAYS = ['tcp://225284.xyz:11010'];
const GITHUB_LATEST_API = 'https://api.github.com/repos/EasyTier/EasyTier/releases/latest';
// How long to wait for easytier-core to report itself ready. Long, because on
// Windows the launch sits behind a UAC prompt that a human has to answer.
const CORE_READY_TIMEOUT_MS = 90000;

let coreProc = null;
let logPollTimer = null;
let state = {
  role: null,        // 'host' | 'client' | null
  networkName: null,
  networkSecret: null,
  selfIp: null,
  modId: null,
  status: 'idle',     // idle | connecting | connected | error
  log: [],
  error: null,
};

let installing = false;

// ── Binary paths ────────────────────────────────────────────────
// EasyTier is downloaded on first use into:
//   <project>/resources/easytier/easytier-core.exe   (dev)
//   resources/easytier/easytier-core.exe              (packaged)
// Where the binaries ship. In the normal case they are bundled here via
// electron-builder's extraResources and nothing is ever downloaded.
function getBundledEasyTierDir() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'easytier')
    : path.join(__dirname, 'resources', 'easytier');
}

// Where a *downloaded* copy goes when the bundled one is missing. It must not
// be the resources folder: the portable build unpacks itself into a temp
// directory on every launch, so anything written there is gone by the next run
// and the user re-downloads EasyTier forever. userData is redirected next to
// the EXE in portable mode (see main.js), so this persists in both builds.
function getDownloadedEasyTierDir() {
  return path.join(app.getPath('userData'), 'easytier');
}

// Bundled copy wins; otherwise fall back to whatever we downloaded earlier.
function getEasyTierDir() {
  const bundled = getBundledEasyTierDir();
  const bin = process.platform === 'win32' ? 'easytier-core.exe' : 'easytier-core';
  try {
    if (fs.existsSync(path.join(bundled, bin))) return bundled;
  } catch { /* ignore */ }
  return getDownloadedEasyTierDir();
}

function getCliPath() {
  const bin = process.platform === 'win32' ? 'easytier-cli.exe' : 'easytier-cli';
  return path.join(getEasyTierDir(), bin);
}

function getEasyTierCorePath() {
  const bin = process.platform === 'win32' ? 'easytier-core.exe' : 'easytier-core';
  return path.join(getEasyTierDir(), bin);
}

function get7ZipPath() {
  const bin = process.platform === 'win32' ? '7za.exe' : '7za';
  if (app.isPackaged) {
    return path.join(process.resourcesPath, '7zip', bin);
  }
  return path.join(__dirname, 'resources', '7zip', bin);
}

function isEasyTierInstalled() {
  return fs.existsSync(getEasyTierCorePath());
}

// ── Tiny JSON GET helper (Electron's net module, same as the rest
//    of the app uses for downloads — no external deps / no need
//    for a system curl binary) ────────────────────────────────────
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = net.request({ url, method: 'GET', redirect: 'follow' });
    req.setHeader('User-Agent', 'NinoGames');
    req.setHeader('Accept', 'application/vnd.github+json');
    let body = '';
    req.on('response', res => {
      if (res.statusCode >= 400) {
        return reject(new Error(`GitHub API returned HTTP ${res.statusCode}`));
      }
      res.on('data', chunk => { body += chunk.toString('utf8'); });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error('Failed to parse GitHub release info: ' + e.message)); }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

function downloadFile(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    const file = fs.createWriteStream(destPath);
    const req = net.request({ url, method: 'GET', redirect: 'follow' });
    req.setHeader('User-Agent', 'NinoGames');
    req.on('response', res => {
      if (res.statusCode >= 400) {
        file.close();
        return reject(new Error(`Download failed: HTTP ${res.statusCode}`));
      }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let recv = 0;
      res.on('data', chunk => {
        recv += chunk.length;
        file.write(chunk);
        if (onProgress) onProgress(recv, total);
      });
      res.on('end', () => {
        file.end(() => {
          if (recv === 0) return reject(new Error('Download returned an empty file.'));
          resolve();
        });
      });
      res.on('error', err => { file.close(); reject(err); });
    });
    req.on('error', err => { file.close(); reject(err); });
    req.end();
  });
}

function extractZipPlain(zipPath, destDir) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(destDir, { recursive: true });
    const sevenZip = get7ZipPath();
    if (process.platform === 'win32' && fs.existsSync(sevenZip)) {
      // No elevation needed — we're only ever extracting into our own
      // resources folder, which the app already has write access to.
      const proc = cp.spawn(sevenZip, ['x', zipPath, `-o${destDir}`, '-y', '-bsp1'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let stderr = '';
      proc.stderr?.on('data', d => { stderr += d.toString(); });
      proc.on('error', reject);
      proc.on('close', code => code === 0 ? resolve() : reject(new Error(stderr.trim() || `7-Zip exited with code ${code}`)));
      return;
    }
    if (process.platform === 'win32') {
      // Fallback: PowerShell's built-in Expand-Archive
      const psCmd = `Expand-Archive -Path '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`;
      const ps = cp.spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', psCmd], { windowsHide: true });
      let stderr = '';
      ps.stderr?.on('data', d => { stderr += d.toString(); });
      ps.on('error', reject);
      ps.on('close', code => code === 0 ? resolve() : reject(new Error(stderr.trim() || `Expand-Archive exited with code ${code}`)));
      return;
    }
    const proc = cp.spawn('unzip', ['-o', zipPath, '-d', destDir]);
    proc.on('error', reject);
    proc.on('close', code => code === 0 ? resolve() : reject(new Error(`unzip exited with code ${code}`)));
  });
}

// If the zip extracted into a nested folder (some releases do this),
// pull the binaries up into the top-level easytier/ dir.
function flattenIfNested(destDir) {
  if (fs.existsSync(path.join(destDir, path.basename(getEasyTierCorePath())))) return;
  const entries = fs.readdirSync(destDir, { withFileTypes: true }).filter(e => e.isDirectory());
  for (const entry of entries) {
    const nestedDir = path.join(destDir, entry.name);
    const nestedCore = path.join(nestedDir, path.basename(getEasyTierCorePath()));
    if (fs.existsSync(nestedCore)) {
      for (const f of fs.readdirSync(nestedDir)) {
        fs.renameSync(path.join(nestedDir, f), path.join(destDir, f));
      }
      try { fs.rmdirSync(nestedDir); } catch { /* ignore */ }
      return;
    }
  }
}

function pickAssetPattern() {
  if (process.platform === 'win32') {
    const arch = os.arch() === 'arm64' ? 'arm64' : 'x86_64';
    return new RegExp(`^easytier-windows-${arch}-v.*\\.zip$`, 'i');
  }
  if (process.platform === 'darwin') {
    const arch = os.arch() === 'arm64' ? 'aarch64' : 'x86_64';
    return new RegExp(`^easytier-macos-${arch}-v.*\\.zip$`, 'i');
  }
  const arch = os.arch() === 'arm64' ? 'aarch64' : 'x86_64';
  return new RegExp(`^easytier-linux-${arch}-v.*\\.zip$`, 'i');
}

// ── Public: ensure EasyTier is present, downloading it if not ────
// onProgress({ phase, pct, recv, total, msg }) is called throughout.
async function ensureEasyTierInstalled(onProgress) {
  if (isEasyTierInstalled()) return { ok: true, alreadyInstalled: true };
  if (installing) return { error: 'Already installing EasyTier — hang tight.' };
  installing = true;
  const emit = (phase, extra) => { if (onProgress) onProgress({ phase, ...extra }); };

  try {
    emit('checking', { msg: 'Checking latest EasyTier release…' });
    const release = await fetchJson(GITHUB_LATEST_API);
    const assets = release && release.assets || [];
    const pattern = pickAssetPattern();
    const asset = assets.find(a => pattern.test(a.name));
    if (!asset) {
      throw new Error(`Couldn't find a matching EasyTier download for this platform (${process.platform}/${os.arch()}). You can grab it manually from https://github.com/EasyTier/EasyTier/releases and drop it in ${getEasyTierDir()}`);
    }

    const destDir = getDownloadedEasyTierDir();
    fs.mkdirSync(destDir, { recursive: true });
    const zipPath = path.join(os.tmpdir(), `easytier-${Date.now()}.zip`);

    emit('downloading', { msg: `Downloading ${asset.name}…`, pct: 0 });
    await downloadFile(asset.browser_download_url, zipPath, (recv, total) => {
      const pct = total ? Math.round((recv / total) * 100) : null;
      emit('downloading', { msg: `Downloading ${asset.name}…`, pct, recv, total });
    });

    emit('extracting', { msg: 'Extracting…' });
    await extractZipPlain(zipPath, destDir);
    flattenIfNested(destDir);

    try { fs.unlinkSync(zipPath); } catch { /* ignore */ }

    if (!isEasyTierInstalled()) {
      throw new Error('EasyTier was downloaded but easytier-core was not found after extracting. The release layout may have changed — please install it manually.');
    }

    emit('done', { msg: 'EasyTier installed.' });
    return { ok: true, version: release.tag_name };
  } catch (err) {
    emit('error', { msg: err.message });
    return { error: err.message };
  } finally {
    installing = false;
  }
}

// ── Party code generation ────────────────────────────────────────
// A party code is `<networkName>-<networkSecret>`, both short
// random hex strings — easy to read out loud / paste into Discord.
function randHex(bytes) {
  return crypto.randomBytes(bytes).toString('hex');
}

function generatePartyCode() {
  const networkName = randHex(4);   // 8 chars
  const networkSecret = randHex(6); // 12 chars
  return { networkName, networkSecret, code: `${networkName}-${networkSecret}` };
}

function parsePartyCode(code) {
  const parts = String(code || '').trim().split('-');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return { networkName: parts[0], networkSecret: parts[1] };
}

// 2-250, avoiding the host's .1.
function randomClientIp(exclude = []) {
  const taken = new Set(exclude);
  for (let attempt = 0; attempt < 50; attempt++) {
    // crypto rather than Math.random: two clients joining the same party at the
    // same moment are exactly the case that matters here, and Math.random is
    // seeded per-process in a way that makes that collision more likely.
    const n = 2 + (crypto.randomBytes(2).readUInt16BE(0) % 249);
    const ip = SUBNET_PREFIX + n;
    if (!taken.has(ip)) return ip;
  }
  return SUBNET_PREFIX + (2 + (crypto.randomBytes(2).readUInt16BE(0) % 249));
}

// Two clients can independently pick the same address; nothing in EasyTier
// stops them, and the result is a party where one member silently cannot be
// reached. Once we are on the network we can actually see the other peers, so
// look for someone else already holding our IP and move if so.
async function detectIpConflict(selfIp) {
  const res = await listMembers();
  if (!res || !Array.isArray(res.members)) return false;
  return res.members.some(m => m.ip === selfIp && !m.isSelf);
}

// ── Process management ───────────────────────────────────────────
function pushLog(line) {
  state.log.push(line);
  if (state.log.length > 200) state.log.shift();
}

function isCoreRunning() {
  return new Promise(resolve => {
    try {
      const proc = cp.spawn('tasklist', ['/FI', 'IMAGENAME eq easytier-core.exe', '/FO', 'CSV', '/NH'], { windowsHide: true });
      let out = '';
      proc.stdout.on('data', d => { out += d.toString(); });
      proc.on('error', () => resolve(false));
      proc.on('close', () => resolve(/easytier-core\.exe/i.test(out)));
    } catch { resolve(false); }
  });
}

// Stops any running easytier-core BEFORE a new party starts, and waits until
// the process is actually gone. Creating a new party while the previous core
// is still alive would fail at bind time with "os error 10048 (port already
// in use)", or leave two core processes fighting over the same virtual adapter.
async function killCore() {
  if (logPollTimer) { clearInterval(logPollTimer); logPollTimer = null; }
  const wasCore = coreProc;
  coreProc = null;

  if (process.platform === 'win32') {
    // easytier-core always runs ELEVATED (see startCore below), so a plain
    // unelevated `taskkill` from NinoGames itself gets "Access is denied" and
    // silently fails to kill it. Elevate the kill too, via the same
    // Start-Process -Verb RunAs pattern used to launch it — but only if a core
    // is actually running, so we don't pop a pointless UAC prompt.
    if (!(await isCoreRunning())) return true;
    await new Promise(resolve => {
      const psCmd =
        `try{Start-Process -FilePath 'taskkill' -ArgumentList '/IM','easytier-core.exe','/T','/F' -Verb RunAs -WindowStyle Hidden -Wait}catch{}`;
      let ps;
      try {
        ps = cp.spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', psCmd], { windowsHide: true });
      } catch { return resolve(); }
      ps.on('exit', () => resolve());
      ps.on('error', () => resolve());
      setTimeout(resolve, 20000).unref();
    });
    // Also try a plain (unelevated) taskkill in case a future version ever
    // runs unelevated for some reason — harmless no-op otherwise.
    try { cp.spawn('taskkill', ['/IM', 'easytier-core.exe', '/T', '/F']); } catch { /* ignore */ }
  } else if (wasCore && !wasCore.killed) {
    try { wasCore.kill('SIGTERM'); } catch { /* ignore */ }
    await new Promise(resolve => {
      const t = setTimeout(resolve, 5000);
      wasCore.once('exit', () => { clearTimeout(t); resolve(); });
    });
  }

  // Wait (briefly) for the process to actually disappear before we return.
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (process.platform !== 'win32' || !(await isCoreRunning())) return true;
    await new Promise(r => setTimeout(r, 250));
  }
  return false;
}

function resetState() {
  state = { role: null, networkName: null, networkSecret: null, selfIp: null, modId: null, status: 'idle', log: [], error: null };
}

// ── Readiness probe ─────────────────────────────────────────────
// Asks the running core, over its local RPC portal, what IP it actually holds.
// This only answers once easytier-core is genuinely up, which makes it a far
// better "are we connected" signal than the two things it replaces:
//
//   * a 4-second timer that resolved regardless of what happened. On Windows
//     the core is launched behind a UAC prompt, and nobody clicks Yes in four
//     seconds — so the UI announced "Connected" while the prompt was still on
//     screen, and again if the user then denied it.
//   * a regex looking for /Starting easytier/ in the log, which matches the
//     very first line the process prints. That is process start, not network
//     readiness.
//
// Returns the reported ipv4 (without the /24) or null.
function probeCoreIp() {
  return new Promise(resolve => {
    const cli = getCliPath();
    if (!fs.existsSync(cli)) return resolve(null);
    let stdout = '';
    let proc;
    try {
      proc = cp.spawn(cli, ['-p', RPC_PORTAL, '-o', 'json', 'node'], {
        cwd: path.dirname(cli), windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch { return resolve(null); }
    const timer = setTimeout(() => { try { proc.kill(); } catch { /* ignore */ } }, 4000);
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.on('error', () => { clearTimeout(timer); resolve(null); });
    proc.on('close', () => {
      clearTimeout(timer);
      try {
        const info = JSON.parse(stdout);
        const addr = info && info.ipv4_addr;
        resolve(typeof addr === 'string' ? addr.split('/')[0] : null);
      } catch { resolve(null); }
    });
  });
}

// Poll until the core reports the exact IP we asked it for. Matching the IP
// matters: killCore() can leave a stale core mid-shutdown, and an unrelated
// EasyTier the user runs themselves would otherwise look like our party.
async function waitForCore(expectedIp, { timeoutMs, isCancelled }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isCancelled && isCancelled()) return false;
    if ((await probeCoreIp()) === expectedIp) return true;
    await new Promise(r => setTimeout(r, 700));
  }
  return false;
}

async function startCore({ role, networkName, networkSecret, ip, onEvent }) {
  const corePath = getEasyTierCorePath();
  if (!fs.existsSync(corePath)) {
    const err = `EasyTier isn't installed yet. It downloads automatically the first time you create or join a party.`;
    throw new Error(err);
  }

  const killed = await killCore();
  if (!killed) {
    throw new Error('Could not stop the previous EasyTier process. Approve the admin prompt (or close EasyTier) and try again.');
  }

  return new Promise((resolve, reject) => {
    const args = [
      '-i', `${ip}/24`,
      '--network-name', networkName,
      '--network-secret', networkSecret,
      '--private-mode', 'true',
      '-r', RPC_PORTAL,

      // EasyTier defaults to a single-threaded runtime. This process is
      // forwarding every packet of a live game session, so give it more than
      // one thread to do it on.
      '--multi-thread', 'true',

      // Default routing picks the path with the fewest hops. For a game LAN the
      // thing that matters is round-trip time, not hop count — a two-hop route
      // through a nearby peer beats one hop through a relay on another
      // continent. (Our only public relay currently measures ~171 ms.)
      '--latency-first', 'true',
    ];

    if (process.platform === 'win32') {
      // The one that makes in-game LAN server browsers work at all. From
      // easytier-core's own help: "capture local UDP broadcast packets from
      // physical interfaces and forward them to EasyTier peers. Helps games to
      // find rooms in local network. Requires administrator privileges."
      //
      // Every game NinoGames supports parties for — the Call of Duty titles,
      // GTA IV/V — finds sessions by UDP broadcast. Without this the party
      // connects fine and the server list stays empty, which reads as "the
      // party is broken". We already run the core elevated, so the admin
      // requirement is met. Windows-only, hence the guard.
      args.push('--enable-udp-broadcast-relay', 'true');
    }

    for (const relay of PUBLIC_RELAYS) {
      args.push('-p', relay);
    }

    pushLog(`$ easytier-core ${args.join(' ')}`);

    let resolved = false;
    const settle = (fn, val) => { if (!resolved) { resolved = true; fn(val); } };

    if (process.platform === 'win32') {
      // EasyTier needs to create a TUN network adapter and add a Windows
      // Firewall allowlist entry — both require admin rights. Running
      // unelevated fails immediately with "Access is denied" / "Failed to
      // create adapter" and easytier-core exits right away. So on Windows,
      // always launch it elevated via PowerShell's Start-Process -Verb RunAs
      // (same pattern already used elsewhere in this app for 7-Zip).
      //
      // An elevated child's stdio can't be piped back to us directly, so we
      // redirect stdout/stderr to temp files and poll them instead.
      const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const outLog = path.join(os.tmpdir(), `easytier-out-${runId}.log`);
      const errLog = path.join(os.tmpdir(), `easytier-err-${runId}.log`);

      const corePathEsc = corePath.replace(/'/g, "''");
      const outLogEsc   = outLog.replace(/'/g, "''");
      const errLogEsc   = errLog.replace(/'/g, "''");
      // Space-joined, each single-quoted — correct syntax for the '&' call
      // operator (NOT the comma-joined array syntax that Start-Process's
      // -ArgumentList expects; that would pass one big array as a single
      // argument instead of separate ones).
      const argListSpaced = args.map(a => `'${String(a).replace(/'/g, "''")}'`).join(' ');

      // NOTE: Start-Process -Verb RunAs cannot be combined with
      // -RedirectStandardOutput/-RedirectStandardError — Windows rejects
      // that parameter combination outright ("Parameter set cannot be
      // resolved"), since an elevated process runs in a different session
      // and its own stdio can't be redirected that way from the launcher.
      // Workaround: elevate a short *inner* PowerShell command instead of
      // easytier-core.exe directly. That inner PowerShell is the thing
      // that's elevated (no redirection needed on the outer Start-Process
      // call), and it does its own ordinary '>'/'2>' redirection of
      // easytier-core's output to files — which is allowed, since it's
      // just an elevated process redirecting its own child process.
      const innerCmd =
        `& '${corePathEsc}' ${argListSpaced} ` +
        `1> '${outLogEsc}' 2> '${errLogEsc}'`;
      const innerCmdEsc = innerCmd.replace(/'/g, "''");

      const psCmd =
        `$ErrorActionPreference='Stop';` +
        `try{` +
          `$p=Start-Process -FilePath 'powershell' ` +
          `-ArgumentList '-NoProfile','-NonInteractive','-Command','${innerCmdEsc}' ` +
          `-Verb RunAs -WindowStyle Hidden -PassThru;` +
          `Write-Host "PID:$($p.Id)";` +
          `$p.WaitForExit();` +
          `exit $p.ExitCode` +
        `}catch{Write-Error $_.Exception.Message;exit 1223}`;

      const ps = cp.spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', psCmd], { windowsHide: true });
      coreProc = ps; // tracked only so callers can tell "something is running"; killCore() uses taskkill by image name instead

      let corePid = null;
      ps.stdout.on('data', d => {
        const m = d.toString().match(/PID:(\d+)/);
        if (m) corePid = m[1];
      });
      let psStderr = '';
      ps.stderr.on('data', d => { psStderr += d.toString(); });

      ps.on('error', err => {
        state.status = 'error';
        state.error = err.message;
        settle(reject, err);
      });

      ps.on('close', code => {
        if (logPollTimer === myPoll) { clearInterval(logPollTimer); logPollTimer = null; }
        // If this is a stale process from a PREVIOUS party that we just killed
        // in killCore(), coreProc no longer points at it — don't let its exit
        // clobber the state of the new party that's starting up.
        const isCurrent = coreProc === ps;
        // Flush any remaining log output once the process has actually exited.
        try {
          const tail = fs.readFileSync(outLog, 'utf8') + fs.readFileSync(errLog, 'utf8').toString();
          tail.split(/\r?\n/).filter(Boolean).forEach(l => pushLog(l));
        } catch { /* ignore */ }
        // A fresh pair of these was left in %TEMP% for every party ever started.
        try { fs.unlinkSync(outLog); } catch { /* ignore */ }
        try { fs.unlinkSync(errLog); } catch { /* ignore */ }
        pushLog(`easytier-core exited (${code})`);
        if (code === 1223 && isCurrent) {
          const err = new Error('The administrator prompt for EasyTier was cancelled or denied, so the party network could not start. Try again and click "Yes" on the prompt — EasyTier needs admin rights to create its virtual network adapter.');
          state.status = 'error';
          state.error = err.message;
          settle(reject, err);
          return;
        }
        if (isCurrent) {
          if (state.status !== 'idle') {
            state.status = 'error';
            state.error = psStderr.trim() || `EasyTier disconnected (exit code ${code})`;
          }
          coreProc = null;
          if (onEvent) onEvent({ type: 'exit', code });
          settle(reject, new Error(state.error || `easytier-core exited (${code})`));
        }
      });

      // Poll the redirected log files for the same "we're up" signal used on
      // other platforms, so host/join resolves as soon as EasyTier is
      // actually listening rather than waiting for the fixed grace period.
      let lastOutSize = 0, lastErrSize = 0;
      let myPoll = null;
      logPollTimer = myPoll = setInterval(() => {
        try {
          for (const [file, lastRef] of [[outLog, 'lastOutSize'], [errLog, 'lastErrSize']]) {
            if (!fs.existsSync(file)) continue;
            const size = fs.statSync(file).size;
            const last = file === outLog ? lastOutSize : lastErrSize;
            if (size <= last) continue;
            const fd = fs.openSync(file, 'r');
            const buf = Buffer.alloc(size - last);
            fs.readSync(fd, buf, 0, buf.length, last);
            fs.closeSync(fd);
            if (file === outLog) lastOutSize = size; else lastErrSize = size;
            const text = buf.toString('utf8');
            text.split(/\r?\n/).filter(Boolean).forEach(l => pushLog(l));
            if (onEvent) onEvent({ type: 'log', line: text });
          }
        } catch { /* file may not exist yet, or be mid-write — ignore and retry */ }
      }, 300);

      // Readiness is decided by asking the core, not by guessing from its log.
      // The window is generous because the UAC prompt sits in front of the
      // process starting at all, and that is on human time. A denied prompt
      // still fails fast: PowerShell exits 1223 and the close handler above
      // rejects immediately.
      waitForCore(ip, {
        timeoutMs: CORE_READY_TIMEOUT_MS,
        isCancelled: () => resolved || coreProc !== ps,
      }).then(ok => {
        if (resolved) return;
        if (ok) return settle(resolve);
        settle(reject, new Error(
          'EasyTier did not come up in time. Approve the administrator prompt when it appears — ' +
          'it needs admin rights to create the virtual network adapter.'
        ));
      });
      return;
    }

    // ── Non-Windows: run directly, no elevation dance needed ───────────
    const proc = cp.spawn(corePath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    coreProc = proc;

    proc.stdout.on('data', d => {
      const text = d.toString();
      text.split(/\r?\n/).filter(Boolean).forEach(l => pushLog(l));
      if (onEvent) onEvent({ type: 'log', line: text });
    });
    proc.stderr.on('data', d => {
      const text = d.toString();
      text.split(/\r?\n/).filter(Boolean).forEach(l => pushLog(l));
      if (onEvent) onEvent({ type: 'log', line: text });
    });
    proc.on('error', err => {
      state.status = 'error';
      state.error = err.message;
      settle(reject, err);
    });
    proc.on('exit', code => {
      pushLog(`easytier-core exited (${code})`);
      if (coreProc === proc) {
        if (state.status !== 'idle') {
          state.status = 'error';
          state.error = `EasyTier disconnected (exit code ${code})`;
        }
        coreProc = null;
        if (onEvent) onEvent({ type: 'exit', code });
      }
    });

    waitForCore(ip, {
      timeoutMs: CORE_READY_TIMEOUT_MS,
      isCancelled: () => resolved || coreProc !== proc,
    }).then(ok => {
      if (resolved) return;
      if (ok) return settle(resolve);
      settle(reject, new Error('EasyTier did not come up in time.'));
    });
  });
}

// List the players currently in the party by asking the local easytier-core
// (via easytier-cli `peer list`) which virtual-LAN members it can see. Only
// members inside our 10.244.244.0/24 subnet count — public relay/rendezvous
// nodes get filtered out by the IP prefix check.
function listMembers() {
  return new Promise(resolve => {
    const cli = getCliPath();
    if (!fs.existsSync(cli)) return resolve({ ok: true, members: [] });
    let stdout = '';
    const proc = cp.spawn(cli, ['-p', RPC_PORTAL, '-o', 'json', 'peer', 'list'], {
      cwd: path.dirname(cli),
      windowsHide: true,
    });
    const timer = setTimeout(() => { try { proc.kill(); } catch { /* ignore */ } }, 5000);
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.on('error', err => { clearTimeout(timer); resolve({ ok: true, members: [], error: err.message }); });
    proc.on('close', () => {
      clearTimeout(timer);
      if (!stdout.trim()) return resolve({ ok: true, members: [] });
      try {
        const parsed = JSON.parse(stdout);
        let items = Array.isArray(parsed) ? parsed : [];
        // Multi-instance cores wrap their output as [{ instance_id, result: [...] }]
        if (items.length && items.every(x => Array.isArray(x && x.result))) {
          items = items.flatMap(x => x.result);
        }
        const members = (Array.isArray(items) ? items : [])
          .filter(i => i && typeof i.ipv4 === 'string' && i.ipv4.startsWith(SUBNET_PREFIX))
          .map(i => ({
            ip: i.ipv4,
            hostname: String(i.hostname || '').trim() || null,
            isSelf: i.cost === 'Local',
            latencyMs: i.lat_ms && i.lat_ms !== '-' ? i.lat_ms : null,
          }));
        resolve({ ok: true, members });
      } catch (e) {
        resolve({ ok: true, members: [], error: 'Failed to parse peer list: ' + e.message });
      }
    });
  });
}

async function hostParty(onEvent) {
  resetState();
  const { networkName, networkSecret, code } = generatePartyCode();
  state.role = 'host';
  state.networkName = networkName;
  state.networkSecret = networkSecret;
  state.selfIp = HOST_IP;
  state.status = 'connecting';
  try {
    await startCore({ role: 'host', networkName, networkSecret, ip: HOST_IP, onEvent });
    state.status = 'connected';
    return { ok: true, code, ip: HOST_IP };
  } catch (err) {
    state.status = 'error';
    state.error = err.message;
    return { error: err.message };
  }
}

async function joinParty(codeStr, onEvent) {
  const parsed = parsePartyCode(codeStr);
  if (!parsed) return { error: 'Invalid party code. It should look like abcd1234-ef56ab78cdef.' };

  resetState();
  state.role = 'client';
  state.networkName = parsed.networkName;
  state.networkSecret = parsed.networkSecret;
  state.status = 'connecting';

  const tried = [];
  try {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const ip = randomClientIp(tried);
      tried.push(ip);
      state.selfIp = ip;

      await startCore({ role: 'client', networkName: parsed.networkName, networkSecret: parsed.networkSecret, ip, onEvent });

      // Peer discovery is not instant, so give the mesh a moment to tell us
      // who else is here before deciding the address is ours.
      await new Promise(r => setTimeout(r, 2500));
      if (!(await detectIpConflict(ip))) {
        state.status = 'connected';
        return { ok: true, ip, hostIp: HOST_IP };
      }

      pushLog(`IP ${ip} is already taken in this party — reconnecting on a different address.`);
      if (onEvent) onEvent({ type: 'log', line: `IP ${ip} already taken, retrying…` });
    }

    // Three collisions in a row is not bad luck, it is a full or broken party.
    state.status = 'connected';
    return { ok: true, ip: state.selfIp, hostIp: HOST_IP, warning: 'Could not find a free address in this party — connection may be unreliable.' };
  } catch (err) {
    state.status = 'error';
    state.error = err.message;
    return { error: err.message };
  }
}

async function leaveParty() {
  await killCore();
  resetState();
  return { ok: true };
}

function getState() {
  return { ...state, hostIp: HOST_IP, installed: isEasyTierInstalled(), installing };
}

module.exports = {
  HOST_IP,
  SUBNET_PREFIX,
  isEasyTierInstalled,
  ensureEasyTierInstalled,
  getEasyTierCorePath,
  getEasyTierDir,
  generatePartyCode,
  parsePartyCode,
  hostParty,
  joinParty,
  leaveParty,
  listMembers,
  getState,
};
