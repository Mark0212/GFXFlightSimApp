'use strict';
// Auto-update (FlightLink 1.1+). Like the OBS plugin's updater:
//   1. ask GoalForgeX for the newest version (GET /api/flightsim/latest → version, installerUrl, sha256)
//   2. download that GitHub release installer in the background and check its SHA-256
//   3. install it silently (NSIS /S) and restart FlightLink —
//      straight away when you're not flying, otherwise when the sim disconnects,
//      when you press "Update now", or when FlightLink is closed.
// Nothing is installed without a matching SHA-256 from a github.com release asset.
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Readable } = require('stream');

const ASSET_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/releases\/download\/[\w.-]+\/goalforgex-flightlink-\d+\.\d+\.\d+-windows-x64-installer\.exe$/;
const CHECK_EVERY_MS = 3 * 3600 * 1000;
const AUTO_INSTALL_DELAY_S = 20;

function cmpVer(a, b) {
  const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0) ? 1 : -1;
  return 0;
}
function sha256File(file) {
  return new Promise((res, rej) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', d => h.update(d)).on('end', () => res(h.digest('hex'))).on('error', rej);
  });
}

class Updater extends EventEmitter {
  // opts: { current, dir, getLatest: async () => ({version, url, installerUrl, sha256, size}), isFlying: () => bool, quit: () => void, enabled }
  constructor(opts) {
    super();
    this.o = opts;
    this.state = { state: 'idle', version: null, pct: 0, error: null, countdown: null, page: null };
    this.file = null; this.timer = null; this.countT = null; this.busy = false;
  }
  set(p) { Object.assign(this.state, p); this.emit('state', { ...this.state }); }
  start() {
    if (!this.o.enabled) return;
    this.cleanOld();
    setTimeout(() => this.check(), 8000);
    this.timer = setInterval(() => this.check(), CHECK_EVERY_MS);
  }
  stop() { clearInterval(this.timer); clearInterval(this.countT); }
  // leftover installers from earlier updates
  cleanOld() {
    try { for (const f of fs.readdirSync(this.o.dir)) if (/^goalforgex-flightlink-update-/.test(f)) { try { fs.unlinkSync(path.join(this.o.dir, f)); } catch {} } } catch {}
  }

  async check() {
    if (this.busy || this.state.state === 'ready' || this.state.state === 'installing') return;
    this.busy = true;
    try {
      const L = await this.o.getLatest();
      if (!L || !L.version || cmpVer(L.version, this.o.current) <= 0) { if (this.state.state !== 'idle') this.set({ state: 'idle' }); return; }
      this.set({ version: L.version, page: L.url || null, error: null });
      // Can't verify it → just tell the streamer (manual download from the FlightLink page).
      if (!this.o.enabled || !L.installerUrl || !ASSET_URL.test(L.installerUrl) || !/^[a-f0-9]{64}$/.test(L.sha256 || '')) { this.set({ state: 'available' }); return; }
      const file = path.join(this.o.dir, `goalforgex-flightlink-update-${L.version}.exe`);
      if (fs.existsSync(file) && await sha256File(file) === L.sha256) { this.ready(file); return; }
      await this.download(L, file);
    } catch (e) {
      this.set({ state: 'error', error: String(e && e.message || e).slice(0, 160) });
    } finally { this.busy = false; }
  }

  async download(L, file) {
    this.set({ state: 'downloading', pct: 0 });
    const tmp = file + '.part';
    const ctrl = new AbortController(), idle = { t: null };
    const kick = () => { clearTimeout(idle.t); idle.t = setTimeout(() => ctrl.abort(), 60000); };
    kick();
    try {
      const r = await fetch(L.installerUrl, { signal: ctrl.signal, redirect: 'follow', headers: { 'User-Agent': 'GoalForgeX-FlightLink-Updater' } });
      if (!r.ok || !r.body) throw new Error('Download failed (' + r.status + ')');
      const total = Number(r.headers.get('content-length')) || L.size || 0;
      const h = crypto.createHash('sha256'), out = fs.createWriteStream(tmp);
      let got = 0, lastPct = -1;
      await new Promise((res, rej) => {
        const src = Readable.fromWeb(r.body);
        src.on('data', d => {
          kick(); h.update(d); got += d.length;
          if (!out.write(d)) { src.pause(); out.once('drain', () => src.resume()); }
          const pct = total ? Math.floor(got / total * 100) : 0;
          if (pct !== lastPct) { lastPct = pct; this.set({ pct }); }
        });
        src.on('end', () => out.end(res)); src.on('error', rej); out.on('error', rej);
      });
      const hash = h.digest('hex');
      if (hash !== L.sha256) { try { fs.unlinkSync(tmp); } catch {} throw new Error('The downloaded update didn\'t match its checksum — skipped.'); }
      fs.renameSync(tmp, file);
      this.ready(file);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch {}
      throw e.name === 'AbortError' ? new Error('Download stalled — will try again later.') : e;
    } finally { clearTimeout(idle.t); }
  }

  ready(file) {
    this.file = file;
    this.set({ state: 'ready', pct: 100 });
    this.maybeAuto();
  }
  // Not flying → install after a short countdown (Later cancels until the next chance).
  maybeAuto() {
    if (this.state.state !== 'ready' || this.countT || this.o.isFlying()) return;
    let n = AUTO_INSTALL_DELAY_S;
    this.set({ countdown: n });
    this.countT = setInterval(() => {
      if (this.o.isFlying()) { this.cancelCountdown(); return; } // started flying meanwhile → wait
      n--; this.set({ countdown: n });
      if (n <= 0) { this.cancelCountdown(); this.install(true); }
    }, 1000);
  }
  cancelCountdown() { clearInterval(this.countT); this.countT = null; this.set({ countdown: null }); }
  later() { this.cancelCountdown(); this.postponed = true; }
  // The sim just disconnected → a good moment.
  simIdle() { if (!this.postponed) this.maybeAuto(); }

  // relaunch: start FlightLink again after installing (not when the streamer closed it).
  install(relaunch) {
    if (!this.file || !fs.existsSync(this.file) || this.state.state === 'installing') return false;
    this.set({ state: 'installing', countdown: null });
    const args = ['/S', '--updated'];
    if (relaunch) args.push('--force-run');
    try {
      spawn(this.file, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } catch (e) { this.set({ state: 'error', error: 'Couldn\'t start the installer: ' + e.message }); return false; }
    setTimeout(() => this.o.quit(), 300);
    return true;
  }
  // FlightLink is closing with an update downloaded → install it on the way out.
  installOnQuit() { if (this.state.state === 'ready') return this.install(false); return false; }
}

module.exports = { Updater, cmpVer };
