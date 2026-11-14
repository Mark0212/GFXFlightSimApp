'use strict';
const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = (n, d = 0) => { const x = Number(n); return Number.isFinite(x) ? x.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }) : '—'; };
const ago = ms => ms < 1500 ? 'just now' : ms < 60000 ? Math.round(ms / 1000) + ' s ago' : Math.round(ms / 60000) + ' min ago';
let S = null, lastEventKey = '', prevT = {};

// compass rose ticks
(function () {
  const g = $('rose'); let h = '';
  for (let d = 0; d < 360; d += 10) {
    const big = d % 30 === 0, r1 = 84, r2 = big ? 70 : 76, a = d * Math.PI / 180;
    h += `<line x1="${100 + r1 * Math.sin(a)}" y1="${100 - r1 * Math.cos(a)}" x2="${100 + r2 * Math.sin(a)}" y2="${100 - r2 * Math.cos(a)}" stroke="#6c6596" stroke-width="${big ? 2 : 1}"/>`;
    if (big) { const t = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' }[d] || String(d / 10); h += `<text class="rose-t" x="${100 + 58 * Math.sin(a)}" y="${104 - 58 * Math.cos(a)}" transform="rotate(${d} ${100 + 58 * Math.sin(a)} ${100 - 58 * Math.cos(a)})">${t}</text>`; }
  }
  g.innerHTML = h;
})();

const EV = {
  takeoff: ['🛫', 'Takeoff', e => `${fmt(e.ias)} kt · heading ${fmt(e.heading)}°`],
  landing: ['🛬', 'Landing', e => `${fmt(e.fpm)} fpm · ${fmt(e.g, 2)} G · ${String(e.rating || '').replace('-', ' ')}`],
  bounce: ['↕️', 'Bounce', () => 'Back in the air after touchdown'],
  'gear-up': ['⬆️', 'Gear up', e => `${fmt(e.altitudeAgl)} ft above ground`], 'gear-down': ['⬇️', 'Gear down', e => `${fmt(e.ias)} kt`],
  'engine-start': ['🔥', 'Engine start', () => ''], 'engine-stop': ['⏹', 'Engine stop', () => ''],
  'autopilot-on': ['🧭', 'Autopilot on', () => ''], 'autopilot-off': ['🧭', 'Autopilot off', () => ''],
  'parking-brake-set': ['🅿️', 'Parking brake set', () => ''], 'parking-brake-off': ['🅿️', 'Parking brake released', () => ''],
  stall: ['⚠️', 'Stall warning', e => `${fmt(e.ias)} kt`], overspeed: ['⚠️', 'Overspeed', e => `${fmt(e.ias)} kt`],
  flaps: ['🪶', 'Flaps', e => `position ${e.index} (${fmt(e.percent)}%)`], waypoint: ['📍', 'Waypoint', e => `${e.passed} → ${e.next}`],
  phase: ['✈️', 'Phase', e => e.label || e.phase], crash: ['💥', 'Crash', () => ''], paused: ['⏸', 'Paused', () => ''], resumed: ['▶️', 'Resumed', () => ''],
  'flight-loaded': ['🗺️', 'Flight loaded', () => ''], 'aircraft-loaded': ['🛩️', 'Aircraft loaded', () => ''], aircraft: ['🛩️', 'Aircraft', e => e.aircraft || ''],
};

function setCard(id, cls) { const c = $(id); c.classList.remove('ok', 'warn', 'bad'); if (cls) c.classList.add(cls); }

function render() {
  if (!S) return;
  $('ver').textContent = 'v' + S.version;
  // auto-update banner
  const U = S.update || {}, show = ['available', 'downloading', 'ready', 'installing'].includes(U.state);
  $('update').hidden = !show;
  if (show) {
    const v = 'FlightLink ' + U.version;
    $('updBar').hidden = U.state !== 'downloading';
    $('updFill').style.width = (U.pct || 0) + '%';
    let title = '', sub = '', acts = '';
    if (U.state === 'available') { title = `⬆️ ${v} is available`; sub = 'Get it from the FlightLink page.'; acts = '<button class="btn small" data-open="update">Get the update</button>'; }
    if (U.state === 'downloading') { title = `⬇️ Downloading ${v}… ${U.pct || 0}%`; sub = 'Keeps working while it downloads.'; }
    if (U.state === 'ready') {
      title = `✅ ${v} is ready`;
      sub = U.countdown != null ? `Installing in ${U.countdown} s — FlightLink restarts by itself in a few seconds.` : 'It installs when you\'re not flying, or when you close FlightLink.';
      acts = '<button class="btn small" id="updNow">Update now</button>' + (U.countdown != null ? '<button class="btn small ghost" id="updLater">Later</button>' : '');
    }
    if (U.state === 'installing') { title = `Installing ${v}…`; sub = 'FlightLink restarts by itself.'; }
    $('updTitle').textContent = title; $('updSub').textContent = sub;
    if ($('updActs').dataset.k !== U.state + (U.countdown != null)) {
      $('updActs').dataset.k = U.state + (U.countdown != null);
      $('updActs').innerHTML = acts;
      if ($('updNow')) $('updNow').onclick = () => fl.updateNow();
      if ($('updLater')) $('updLater').onclick = () => fl.updateLater().then(tick);
    }
  }
  // sim
  const sim = S.sim || {};
  if (sim.connected) {
    setCard('cSim', sim.paused ? 'warn' : 'ok');
    $('simMain').textContent = sim.simName || 'Connected';
    const t = S.t || {};
    $('simSub').textContent = sim.paused ? 'Paused' : sim.inSim === false ? 'In the menus — load a flight' : (t.aircraft || 'Flying') + (S.sampleAgeMs != null && S.sampleAgeMs > 3000 ? ' · no data for ' + ago(S.sampleAgeMs) : '');
  } else {
    setCard('cSim', sim.error && !/Waiting/.test(sim.error) ? 'bad' : null);
    $('simMain').textContent = 'Waiting for the sim…';
    $('simSub').textContent = sim.error || 'Start Microsoft Flight Simulator 2024 — FlightLink connects by itself.';
  }
  // account
  const acts = $('accActs');
  if (S.account) {
    setCard('cAcc', 'ok');
    $('accMain').textContent = S.account.displayName || S.account.username;
    $('accSub').textContent = S.account.scenes === false ? 'Connected · Scene Studio is in early access on this account' : 'Connected · ' + S.server.replace(/^https?:\/\//, '');
    if (acts.dataset.mode !== 'acc') { acts.dataset.mode = 'acc'; acts.innerHTML = '<button class="btn small danger" id="disc">Disconnect</button>'; $('disc').onclick = async () => { if (confirm('Disconnect FlightLink from your GoalForgeX account?')) { await fl.disconnect(); tick(); } }; }
  } else {
    setCard('cAcc', S.linking ? 'warn' : null);
    $('accMain').textContent = S.linking ? 'Waiting for approval…' : 'Not connected';
    $('accSub').textContent = S.linking ? 'Approve the code in your browser' : 'Connect once — it stays connected.';
    if (acts.dataset.mode !== 'none') { acts.dataset.mode = 'none'; acts.innerHTML = '<button class="btn small" id="conn1">Connect GoalForgeX</button>'; $('conn1').onclick = async () => { const r = await fl.link(); if (!r.ok) alert(r.error || 'Could not reach GoalForgeX.'); tick(); }; }
  }
  $('linkBox').hidden = !S.linking; if (S.linking) $('linkCode').textContent = S.linking.code;
  // upload
  const st = S.stats || {};
  if (!S.account) { setCard('cUp', null); $('upMain').textContent = 'Not sending'; $('upSub').textContent = 'Connect your account first.'; }
  else if (st.lastError) { setCard('cUp', 'bad'); $('upMain').textContent = 'Retrying…'; $('upSub').textContent = st.lastError; }
  else if (st.lastOkAt && Date.now() - st.lastOkAt < 6000) {
    const flying = sim.connected && sim.inSim !== false;
    setCard('cUp', flying ? 'ok' : 'warn');
    $('upMain').textContent = flying ? `Live · ${fmt(st.perSec, 1)}/s` : 'Online · waiting for the sim';
    $('upSub').textContent = (st.watching ? '🟢 A scene is using your flight data' : 'No scene is showing flight data right now') + (st.latencyMs != null ? ` · ${st.latencyMs} ms` : '');
  } else { setCard('cUp', 'warn'); $('upMain').textContent = 'Connecting…'; $('upSub').textContent = st.lastOkAt ? 'Last sent ' + ago(Date.now() - st.lastOkAt) : '—'; }

  // instruments
  const t = S.t || {};
  const has = t.altitude !== undefined;
  $('rAlt').textContent = has ? fmt(t.altitude) : '—';
  $('rIas').textContent = has ? fmt(t.ias) : '—';
  $('rVs').textContent = has ? (t.verticalSpeed > 0 ? '+' : '') + fmt(Math.round(t.verticalSpeed / 10) * 10) : '—';
  $('rGs').textContent = has ? fmt(t.groundSpeed) : '—';
  $('rAgl').textContent = has ? fmt(t.altitudeAgl) : '—';
  $('rFuel').textContent = has ? fmt(t.fuelPercent) : '—';
  $('phase').textContent = t.phaseLabel || '—';
  const hdg = Number(t.heading) || 0;
  $('rose').style.transform = `rotate(${-hdg}deg)`; $('rose').style.transformOrigin = '100px 100px';
  $('hdgTxt').textContent = String(Math.round(hdg) % 360).padStart(3, '0') + '°';
  const pitch = Math.max(-30, Math.min(30, Number(t.pitch) || 0)), bank = Number(t.bank) || 0;
  $('adiHorizon').style.transformOrigin = '100px 100px';
  $('adiHorizon').style.transform = `rotate(${-bank}deg) translateY(${pitch * 2}px)`;
  const chip = (on, label, alert) => `<span class="chip${on ? (alert ? ' alert' : ' on') : ''}">${label}</span>`;
  $('chips').innerHTML = has ? [
    chip(t.onGround, t.onGround ? 'On ground' : 'Airborne'), chip(t.gearDown, 'Gear ' + (t.gearDown ? 'down' : 'up')),
    chip(t.flapsIndex > 0, 'Flaps ' + (t.flapsIndex || 0)), chip(t.apMaster, 'Autopilot'), chip(t.parkingBrake, 'Parking brake'),
    chip(t.engineRunning, 'Engine'), chip(t.lightLanding, 'Landing lights'), chip(t.stallWarning, 'STALL', true), chip(t.overspeedWarning, 'OVERSPEED', true),
    t.lastLandingFpm != null ? `<span class="chip">Last landing ${fmt(t.lastLandingFpm)} fpm</span>` : '',
  ].join('') : '';

  // events
  const evs = S.events || [], key = evs.length ? evs[0].at + evs[0].type : '';
  if (key !== lastEventKey) {
    const fresh = evs.length && lastEventKey !== '' ? evs[0].at : 0;
    lastEventKey = key;
    $('events').innerHTML = evs.length ? evs.map(e => {
      const d = EV[e.type] || ['•', e.type, () => ''];
      return `<li class="${e.at === fresh ? 'new' : ''}"><span class="ic">${d[0]}</span><span class="tx"><b>${esc(d[1])}</b><small>${esc(d[2](e))}</small></span><time>${new Date(e.at).toLocaleTimeString()}</time></li>`;
    }).join('') : '<li class="muted">Nothing yet — take off, land, drop the gear…</li>';
  }

  // all values
  const q = $('filter').value.trim().toLowerCase();
  const keys = Object.keys(t);
  $('keyCount').textContent = keys.length ? `(${keys.length} values)` : '';
  $('tele').innerHTML = keys.length ? keys.filter(k => !q || k.toLowerCase().includes(q) || String(t[k]).toLowerCase().includes(q)).map(k => {
    const v = t[k], s = typeof v === 'boolean' ? (v ? 'true' : 'false') : v === null || v === '' ? '—' : typeof v === 'number' ? String(v) : v;
    return `<div class="kv${prevT[k] !== v ? ' chg' : ''}"><span>${esc(k)}</span><b title="${esc(s)}">${esc(s)}</b></div>`;
  }).join('') : '<div class="muted">No telemetry yet — start the sim or turn on Demo flight.</div>';
  prevT = t;

  // settings
  if (document.activeElement !== $('demo')) $('demo').checked = !!S.demo;
  if (document.activeElement !== $('rate')) $('rate').value = String(S.rate);
  if (document.activeElement !== $('conn') && !$('conn').dataset.touched) { $('conn').value = S.remote ? 'remote' : 'local'; $('remoteRow').hidden = !S.remote; if (S.remote) { $('rHost').value = S.remote.host; $('rPort').value = S.remote.port; } }
  $('connNote').textContent = S.remote ? `Connecting to ${S.remote.host}:${S.remote.port}` : 'The sim and FlightLink are on the same PC.';
  $('log').innerHTML = (S.log || []).slice().reverse().map(l => `<div>${new Date(l.at).toLocaleTimeString()} · ${esc(l.text)}</div>`).join('');
}

async function tick() { try { S = await fl.state(); render(); } catch (e) {} }
setInterval(tick, 250); tick();

document.addEventListener('click', e => { const b = e.target.closest('[data-open]'); if (b) fl.open(b.dataset.open); });
$('cancelLink').onclick = () => { fl.cancelLink(); tick(); };
$('demo').onchange = () => fl.setDemo($('demo').checked).then(tick);
$('rate').onchange = () => fl.setRate(Number($('rate').value)).then(tick);
$('conn').onchange = () => { $('conn').dataset.touched = '1'; const r = $('conn').value === 'remote'; $('remoteRow').hidden = !r; if (!r) fl.setRemote(null).then(() => { delete $('conn').dataset.touched; tick(); }); };
$('rSave').onclick = () => fl.setRemote({ host: $('rHost').value.trim(), port: Number($('rPort').value) || 500 }).then(() => { delete $('conn').dataset.touched; tick(); });
$('filter').oninput = render;
$('copyJson').onclick = () => { fl.copy(JSON.stringify(S && S.t || {}, null, 2)); $('copyJson').textContent = 'Copied'; setTimeout(() => { $('copyJson').textContent = 'Copy JSON'; }, 1200); };
