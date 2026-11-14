'use strict';
// GoalForgeX FlightLink — main process.
// sim.js (SimConnect) or demo.js → tracker.js (derived values + events) → cloud.js (GoalForgeX),
// with the window showing all of it live.
const { app, BrowserWindow, ipcMain, shell, safeStorage, clipboard, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { SimLink } = require('./sim');
const { DemoSim } = require('./demo');
const { FlightTracker } = require('./tracker');
const { Cloud } = require('./cloud');

const VERSION = app.getVersion();
const argServer = (process.argv.find(a => a.startsWith('--server=')) || '').slice(9);

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

// ── settings (userData/settings.json; the token is encrypted with Windows DPAPI) ──
const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');
let settings = { rate: 4, remote: null, server: null, tokenEnc: null, account: null, demo: false };
try { settings = { ...settings, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) }; } catch {}
function saveSettings() { try { fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true }); fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2)); } catch {} }
let tokenCache;
function getToken() {
  if (tokenCache !== undefined) return tokenCache;
  tokenCache = null;
  if (settings.tokenEnc) {
    try { tokenCache = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(settings.tokenEnc, 'base64')) : Buffer.from(settings.tokenEnc, 'base64').toString('utf8'); } catch { tokenCache = null; }
  }
  return tokenCache;
}
function setToken(token, account) {
  tokenCache = token || null;
  settings.tokenEnc = token ? (safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(token) : Buffer.from(token, 'utf8')).toString('base64') : null;
  settings.account = account || null;
  saveSettings();
}

const server = argServer || settings.server || 'https://goalforgex.com';
const cloud = new Cloud({ server, version: VERSION, getToken, setToken });
cloud.setRate(settings.rate);
cloud.account = settings.account;
const tracker = new FlightTracker();
const real = new SimLink({ remote: settings.remote });
const demo = new DemoSim();

let demoOn = process.argv.includes('--demo') || !!settings.demo;
let simStatus = { connected: false, inSim: false, paused: false, simName: null, error: null };
let latestT = {}, lastSampleAt = 0;
const recent = []; // events shown in the window
const logLines = [];
let update = null;
function log(s) { logLines.push({ at: Date.now(), text: String(s) }); if (logLines.length > 60) logLines.shift(); }

function source() { return demoOn ? demo : real; }
function simForCloud() {
  return { connected: !!simStatus.connected, inSim: !!simStatus.inSim, paused: !!simStatus.paused, name: simStatus.simName || '', demo: !!demoOn };
}
function onStatus(src, st) {
  if (src !== source()) return;
  const was = simStatus.connected;
  simStatus = st;
  if (st.connected && !was) { log(`Connected to ${st.simName || 'the sim'}.`); tracker.reset(); }
  if (!st.connected && was) log(st.error || 'Sim disconnected.');
  cloud.push(simForCloud(), latestT, []);
}
function onData(src, s) {
  if (src !== source()) return;
  const { t, events } = tracker.update(s, simStatus);
  latestT = t; lastSampleAt = Date.now();
  for (const e of events) { recent.unshift({ ...e, at: Date.now() }); if (recent.length > 40) recent.pop(); }
  cloud.push(simForCloud(), t, events);
}
function onSystem(src, e) {
  if (src !== source()) return;
  const ev = e.name === 'Crashed' ? { type: 'crash' } : e.name === 'FlightLoaded' ? { type: 'flight-loaded' } : e.name === 'AircraftLoaded' ? { type: 'aircraft-loaded' }
    : e.name === 'Pause' ? { type: e.value === 1 ? 'paused' : 'resumed' } : null;
  if (!ev) return;
  if (ev.type === 'flight-loaded') tracker.reset();
  recent.unshift({ ...ev, at: Date.now() }); if (recent.length > 40) recent.pop();
  cloud.push(simForCloud(), latestT, [ev]);
}
for (const src of [real, demo]) {
  src.on('status', st => onStatus(src, st));
  src.on('data', s => onData(src, s));
  src.on('system', e => onSystem(src, e));
  src.on('log', l => log(l));
}
function setDemo(on) {
  demoOn = !!on; settings.demo = demoOn; saveSettings();
  tracker.reset(); latestT = {};
  if (demoOn) { real.stop(); demo.start(); log('Demo flight started — no sim needed.'); }
  else { demo.stop(); real.start(); log('Demo flight stopped — waiting for the sim.'); }
}

cloud.on('linked', a => log(`Connected to GoalForgeX as ${a.displayName || a.username}.`));
cloud.on('unlinked', m => log(m || 'Disconnected from GoalForgeX.'));
cloud.on('linkFailed', m => log(m));

// ── window ──
let win = null;
function createWindow() {
  win = new BrowserWindow({
    width: 1180, height: 800, minWidth: 900, minHeight: 620, show: false, backgroundColor: '#07070d',
    title: 'GoalForgeX FlightLink', icon: path.join(__dirname, 'ui', 'icon.png'),
    titleBarStyle: 'hidden', titleBarOverlay: { color: '#07070d', symbolColor: '#c4b5fd', height: 44 },
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.on('closed', () => { win = null; });
}
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

function state() {
  return {
    version: VERSION, server, demo: demoOn, sim: simStatus, sampleAgeMs: lastSampleAt ? Date.now() - lastSampleAt : null,
    account: cloud.account, linking: cloud.linking ? { code: cloud.linking.code, url: cloud.linking.url, expiresAt: cloud.linking.expiresAt } : null,
    stats: cloud.stats, rate: cloud.rate, remote: settings.remote, t: latestT, events: recent.slice(0, 25), log: logLines.slice(-12), update,
  };
}
ipcMain.handle('state', () => state());
ipcMain.handle('link', async () => {
  try { const L = await cloud.startLink(os.hostname()); shell.openExternal(L.url); return { ok: true }; }
  catch (e) { log(e.message); return { ok: false, error: e.message }; }
});
ipcMain.handle('cancelLink', () => { cloud.cancelLink(); return true; });
ipcMain.handle('disconnect', async () => { await cloud.disconnect(); return true; });
ipcMain.handle('setDemo', (_e, on) => { setDemo(on); return true; });
ipcMain.handle('setRate', (_e, r) => { cloud.setRate(r); settings.rate = cloud.rate; saveSettings(); return cloud.rate; });
ipcMain.handle('setRemote', (_e, r) => {
  settings.remote = r && r.host ? { host: String(r.host).slice(0, 100), port: Math.max(1, Math.min(65535, Number(r.port) || 500)) } : null;
  saveSettings(); real.setOptions({ remote: settings.remote }); return settings.remote;
});
ipcMain.handle('open', (_e, which) => {
  const urls = { docs: server + '/scene-studio?tab=flight', page: server + '/flightlink', scenes: server + '/scenes', update: server + '/flightlink' };
  if (urls[which]) shell.openExternal(urls[which]);
  if (which === 'link' && cloud.linking) shell.openExternal(cloud.linking.url);
  return true;
});
ipcMain.handle('copy', (_e, text) => { clipboard.writeText(String(text || '').slice(0, 20000)); return true; });

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  createWindow();
  cloud.start();
  if (demoOn) demo.start(); else real.start();
  if (getToken()) cloud.checkAccount();
  setInterval(() => { if (getToken()) cloud.checkAccount(); }, 5 * 60 * 1000).unref();
  // heartbeat even before the first sample, so the site knows the app is open
  cloud.push(simForCloud(), latestT, []);
  const u = await cloud.latestVersion();
  if (u && u.version && cmpVer(u.version, VERSION) > 0) { update = { version: u.version, url: u.url }; log(`FlightLink ${u.version} is available.`); }
});
app.on('window-all-closed', () => { real.stop(); demo.stop(); cloud.stop(); app.quit(); });

function cmpVer(a, b) {
  const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0) ? 1 : -1;
  return 0;
}
