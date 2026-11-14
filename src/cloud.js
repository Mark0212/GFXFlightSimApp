'use strict';
// GoalForgeX side: account linking (device code → token) and the telemetry upload.
//
// Upload rules (kept gentle on the site):
//  • sim flying: one POST every 1000/rate ms (default 4/s), events go out at once
//    (never faster than every 120 ms — the server refuses > ~11/s).
//  • sim not connected / in the menus: a small heartbeat every 3 s, no telemetry.
//  • one request in flight at a time; a slow / failing site backs off instead of piling up.
const EventEmitter = require('events');

const UA = v => `GoalForgeX-FlightLink/${v} (Windows)`;

class Cloud extends EventEmitter {
  constructor({ server, version, getToken, setToken }) {
    super();
    this.server = String(server || 'https://goalforgex.com').replace(/\/+$/, '');
    this.version = version;
    this.getToken = getToken; this.setToken = setToken;
    this.rate = 4;
    this.latest = null;               // { sim, t }
    this.queue = [];                  // events waiting to go
    this.busy = false; this.timer = null; this.lastPost = 0; this.backoff = 0;
    this.stats = { sent: 0, failed: 0, lastOkAt: 0, lastError: null, latencyMs: null, watching: false, perSec: 0 };
    this._win = [];
    this.linking = null;
    this.account = null;
  }
  setRate(r) { this.rate = Math.max(1, Math.min(10, Number(r) || 4)); }

  async req(path, { method = 'GET', body, token } = {}) {
    const ctrl = new AbortController(), t = setTimeout(() => ctrl.abort(), 8000);
    try {
      const r = await fetch(this.server + path, {
        method, signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json', 'User-Agent': UA(this.version), ...(token ? { Authorization: 'Bearer ' + token } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      let data = null; try { data = await r.json(); } catch {}
      return { status: r.status, ok: r.ok, data: data || {} };
    } finally { clearTimeout(t); }
  }

  // ── linking ──
  async startLink(deviceName) {
    this.cancelLink();
    const r = await this.req('/api/flightsim/device', { method: 'POST', body: { device_name: deviceName, app_version: this.version } });
    if (!r.ok) throw new Error(r.data.message || r.data.error || ('GoalForgeX answered ' + r.status));
    const L = this.linking = { code: r.data.user_code, url: r.data.verification_uri_complete, expiresAt: Date.now() + r.data.expires_in * 1000, stop: false };
    this.emit('linking', { code: L.code, url: L.url, expiresAt: L.expiresAt });
    const poll = async () => {
      if (L.stop || this.linking !== L) return;
      if (Date.now() > L.expiresAt) { this.linking = null; this.emit('linkFailed', 'The code expired — press Connect again.'); return; }
      try {
        const t = await this.req('/api/flightsim/token', { method: 'POST', body: { device_code: r.data.device_code } });
        if (L.stop || this.linking !== L) return;
        if (t.ok && t.data.token) {
          this.linking = null;
          this.setToken(t.data.token, t.data.account);
          this.account = t.data.account;
          this.emit('linked', t.data.account);
          this.kick();
          return;
        }
        if (t.data.error && t.data.error !== 'authorization_pending' && t.data.error !== 'rate_limited') { this.linking = null; this.emit('linkFailed', t.data.message || 'Connection declined.'); return; }
      } catch {}
      setTimeout(poll, (r.data.interval || 3) * 1000);
    };
    setTimeout(poll, (r.data.interval || 3) * 1000);
    return L;
  }
  cancelLink() { if (this.linking) { this.linking.stop = true; this.linking = null; } }
  async checkAccount() {
    const token = this.getToken(); if (!token) { this.account = null; return null; }
    try {
      const r = await this.req('/api/flightsim/me', { token });
      if (r.status === 401) { this._unlinked(r.data.message); return null; }
      if (r.ok) { this.account = r.data.account; this.stats.watching = !!r.data.scenesWatching; this.emit('account', this.account); }
    } catch (e) { this.stats.lastError = 'Can\'t reach GoalForgeX (' + (e.name === 'AbortError' ? 'timed out' : e.message) + ')'; }
    return this.account;
  }
  async disconnect() {
    const token = this.getToken();
    if (token) { try { await this.req('/api/flightsim/disconnect', { method: 'POST', token }); } catch {} }
    this._unlinked(null);
  }
  _unlinked(msg) { this.setToken(null, null); this.account = null; this.emit('unlinked', msg || null); }

  // ── telemetry ──
  push(sim, t, events) {
    this.latest = { sim, t };
    if (events && events.length) { this.queue.push(...events); if (this.queue.length > 30) this.queue.splice(0, this.queue.length - 30); this.kick(true); }
  }
  start() { if (!this.timer) this.timer = setInterval(() => this.kick(), 100); }
  stop() { clearInterval(this.timer); this.timer = null; }
  kick(urgent) {
    if (this.busy || !this.getToken() || !this.latest) return;
    const now = Date.now(), flying = !!(this.latest.sim && this.latest.sim.connected && this.latest.sim.inSim);
    const every = flying ? 1000 / this.rate : 3000;
    if (now < this.backoff) return;
    if (now - this.lastPost < (urgent && this.queue.length ? 120 : every)) return;
    this._post(flying);
  }
  async _post(flying) {
    this.busy = true; this.lastPost = Date.now();
    const events = this.queue.splice(0, 12);
    const body = { appVersion: this.version, sim: this.latest.sim, events };
    if (flying) body.t = this.latest.t;
    const t0 = Date.now();
    try {
      const r = await this.req('/api/flightsim/telemetry', { method: 'POST', body, token: this.getToken() });
      if (r.status === 401) { this._unlinked(r.data.message); return; }
      if (r.status === 429) { this.queue.unshift(...events); this.backoff = Date.now() + 1000; return; }
      if (!r.ok) throw new Error('GoalForgeX answered ' + r.status);
      this.backoff = 0;
      this.stats.sent++; this.stats.lastOkAt = Date.now(); this.stats.latencyMs = Date.now() - t0; this.stats.lastError = null;
      this.stats.watching = !!r.data.watching;
      this._win.push(Date.now());
    } catch (e) {
      this.queue.unshift(...events);
      this.stats.failed++;
      this.stats.lastError = 'Can\'t reach GoalForgeX (' + (e.name === 'AbortError' ? 'timed out' : e.message) + ')';
      this.backoff = Date.now() + Math.min(15000, 1000 * Math.pow(2, Math.min(4, this.stats.failed % 6)));
    } finally {
      this.busy = false;
      const cut = Date.now() - 5000; while (this._win.length && this._win[0] < cut) this._win.shift();
      this.stats.perSec = Math.round(this._win.length / 5 * 10) / 10;
      this.emit('stats', { ...this.stats });
    }
  }
  async latestVersion() {
    try { const r = await this.req('/api/flightsim/latest'); return r.ok ? r.data : null; } catch { return null; }
  }
}

module.exports = { Cloud };
