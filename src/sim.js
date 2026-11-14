'use strict';
// SimConnect reader: Microsoft Flight Simulator 2024 (and 2020) over the sim's own
// local pipe / TCP — pure JavaScript (node-simconnect), no Microsoft SDK DLL needed.
//
// Variables are grouped into small data definitions. If the sim rejects one
// variable (renamed / missing in a sim version), only that group is rebuilt
// without it — everything else keeps streaming.
//
// Emits: 'status' {connected, inSim, paused, simName, error}
//        'data'   flat sample (merged groups, ~10/s)
//        'system' {name, value}  (crash / aircraft or flight loaded / pause)
const EventEmitter = require('events');
const { open, Protocol, SimConnectDataType, SimConnectPeriod, SimConnectConstants } = require('node-simconnect');

// key, SimVar, unit, kind ('n' number | 'b' bool | 's' string)
const GROUPS = [
  { name: 'position', rate: 'fast', vars: [
    ['lat', 'PLANE LATITUDE', 'degrees'], ['lon', 'PLANE LONGITUDE', 'degrees'],
    ['altitude', 'PLANE ALTITUDE', 'feet'], ['altitudeIndicated', 'INDICATED ALTITUDE', 'feet'],
    ['altitudeAgl', 'PLANE ALT ABOVE GROUND', 'feet'], ['groundElevation', 'GROUND ALTITUDE', 'feet'],
    ['heading', 'PLANE HEADING DEGREES MAGNETIC', 'degrees'], ['headingTrue', 'PLANE HEADING DEGREES TRUE', 'degrees'],
    ['pitch', 'PLANE PITCH DEGREES', 'degrees'], ['bank', 'PLANE BANK DEGREES', 'degrees'],
  ] },
  { name: 'speed', rate: 'fast', vars: [
    ['ias', 'AIRSPEED INDICATED', 'knots'], ['tas', 'AIRSPEED TRUE', 'knots'], ['groundSpeed', 'GROUND VELOCITY', 'knots'],
    ['verticalSpeed', 'VERTICAL SPEED', 'feet per minute'], ['mach', 'AIRSPEED MACH', 'mach'], ['gForce', 'G FORCE', 'gforce'],
    ['onGround', 'SIM ON GROUND', 'bool', 'b'], ['touchdownVelocity', 'PLANE TOUCHDOWN NORMAL VELOCITY', 'feet per second'],
    ['stallWarning', 'STALL WARNING', 'bool', 'b'], ['overspeedWarning', 'OVERSPEED WARNING', 'bool', 'b'],
  ] },
  { name: 'controls', rate: 'fast', vars: [
    ['gearDown', 'GEAR HANDLE POSITION', 'bool', 'b'], ['gearPercent', 'GEAR TOTAL PCT EXTENDED', 'percent'],
    ['flaps', 'FLAPS HANDLE PERCENT', 'percent'], ['flapsIndex', 'FLAPS HANDLE INDEX', 'number'],
    ['spoilers', 'SPOILERS HANDLE POSITION', 'percent'], ['parkingBrake', 'BRAKE PARKING POSITION', 'bool', 'b'],
    ['throttle', 'GENERAL ENG THROTTLE LEVER POSITION:1', 'percent'],
  ] },
  { name: 'engines', rate: 'fast', vars: [
    ['engines', 'NUMBER OF ENGINES', 'number'], ['engineRunning', 'GENERAL ENG COMBUSTION:1', 'bool', 'b'],
    ['rpm', 'GENERAL ENG RPM:1', 'rpm'], ['n1', 'TURB ENG N1:1', 'percent'],
    ['fuelGallons', 'FUEL TOTAL QUANTITY', 'gallons'], ['fuelCapacity', 'FUEL TOTAL CAPACITY', 'gallons'],
    ['fuelPounds', 'FUEL TOTAL QUANTITY WEIGHT', 'pounds'],
  ] },
  { name: 'autopilot', rate: 'slow', vars: [
    ['apMaster', 'AUTOPILOT MASTER', 'bool', 'b'], ['apAltitude', 'AUTOPILOT ALTITUDE LOCK VAR', 'feet'],
    ['apHeading', 'AUTOPILOT HEADING LOCK DIR', 'degrees'], ['apSpeed', 'AUTOPILOT AIRSPEED HOLD VAR', 'knots'],
    ['apVerticalSpeed', 'AUTOPILOT VERTICAL HOLD VAR', 'feet per minute'],
  ] },
  { name: 'lights', rate: 'slow', vars: [
    ['lightBeacon', 'LIGHT BEACON', 'bool', 'b'], ['lightLanding', 'LIGHT LANDING', 'bool', 'b'], ['lightStrobe', 'LIGHT STROBE', 'bool', 'b'],
    ['lightNav', 'LIGHT NAV', 'bool', 'b'], ['lightTaxi', 'LIGHT TAXI', 'bool', 'b'],
  ] },
  { name: 'environment', rate: 'slow', vars: [
    ['outsideTemp', 'AMBIENT TEMPERATURE', 'celsius'], ['windSpeed', 'AMBIENT WIND VELOCITY', 'knots'],
    ['windDirection', 'AMBIENT WIND DIRECTION', 'degrees'], ['pressure', 'SEA LEVEL PRESSURE', 'millibars'],
    ['visibility', 'AMBIENT VISIBILITY', 'meters'], ['inCloud', 'AMBIENT IN CLOUD', 'bool', 'b'],
    ['localTime', 'LOCAL TIME', 'seconds'], ['zuluTime', 'ZULU TIME', 'seconds'], ['simRate', 'SIMULATION RATE', 'number'],
  ] },
  { name: 'nav', rate: 'slow', vars: [
    ['flightPlanActive', 'GPS IS ACTIVE FLIGHT PLAN', 'bool', 'b'], ['wpCount', 'GPS FLIGHT PLAN WP COUNT', 'number'],
    ['wpIndex', 'GPS FLIGHT PLAN WP INDEX', 'number'], ['wpDistanceM', 'GPS WP DISTANCE', 'meters'],
    ['wpEte', 'GPS WP ETE', 'seconds'], ['destEte', 'GPS ETE', 'seconds'],
  ] },
  { name: 'names', rate: 'slow', vars: [
    ['aircraft', 'TITLE', null, 's'], ['atcId', 'ATC ID', null, 's'], ['airline', 'ATC AIRLINE', null, 's'],
    ['flightNumber', 'ATC FLIGHT NUMBER', null, 's'], ['atcType', 'ATC TYPE', null, 's'], ['atcModel', 'ATC MODEL', null, 's'],
    ['nextWaypoint', 'GPS WP NEXT ID', null, 's'], ['prevWaypoint', 'GPS WP PREV ID', null, 's'],
  ] },
];
const SYS = { 1: 'Pause', 2: 'Sim', 3: 'Crashed', 4: 'AircraftLoaded', 5: 'FlightLoaded' };
const REQ_SIM_STATE = 900;

class SimLink extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.opts = opts;               // { remote: {host, port} } or {}
    this.handle = null;
    this.status = { connected: false, inSim: false, paused: false, simName: null, error: null };
    this.sample = {};
    this.bad = new Set();           // SimVars the sim rejected this session
    this.defs = new Map();          // defineId → { group, vars }
    this.sendMap = new Map();       // sendId → { groupIdx, simvar }
    this.nextId = 10;
    this.stopped = true;
    this.retryT = null;
    this.emitT = null;
  }
  setOptions(opts) { this.opts = opts || {}; if (!this.stopped) { this.stop(); this.start(); } }
  start() { if (!this.stopped) return; this.stopped = false; this._connect(); }
  stop() {
    this.stopped = true;
    clearTimeout(this.retryT); clearTimeout(this.emitT);
    if (this.handle) { try { this.handle.close(); } catch {} }
    this.handle = null;
    this._setStatus({ connected: false, inSim: false, paused: false });
  }
  _setStatus(p) { Object.assign(this.status, p); this.emit('status', { ...this.status }); }

  async _connect() {
    if (this.stopped) return;
    try {
      const o = this.opts.remote && this.opts.remote.host ? { remote: { host: this.opts.remote.host, port: Number(this.opts.remote.port) || 500 } } : undefined;
      const { recvOpen, handle } = await open('GoalForgeX FlightLink', Protocol.KittyHawk, o);
      if (this.stopped) { try { handle.close(); } catch {} return; }
      this.handle = handle;
      this.sample = {}; this.defs.clear(); this.sendMap.clear();
      const ver = recvOpen && recvOpen.applicationVersionMajor ? recvOpen.applicationVersionMajor : null;
      // MSFS 2024 reports itself as "SunRise" (version 12), 2020 as "KittyHawk" (11).
      const raw = String(recvOpen && recvOpen.applicationName || '');
      const simName = /sunrise/i.test(raw) || ver >= 12 ? 'Microsoft Flight Simulator 2024'
        : /kittyhawk/i.test(raw) || ver === 11 ? 'Microsoft Flight Simulator 2020' : raw || 'Flight simulator';
      this._setStatus({ connected: true, inSim: true, paused: false, simName, simVersion: ver, error: null });
      handle.on('simObjectData', d => this._onData(d));
      handle.on('exception', ex => this._onException(ex));
      handle.on('event', e => this._onEvent(e));
      handle.on('systemState', s => { if (s && s.requestID === REQ_SIM_STATE) this._setStatus({ inSim: s.dataInteger === 1 }); });
      handle.on('quit', () => this._lost('The sim closed.'));
      handle.on('close', () => this._lost('Connection to the sim closed.'));
      handle.on('error', e => this._lost(e && e.message || 'SimConnect error'));
      for (const [id, name] of Object.entries(SYS)) { try { handle.subscribeToSystemEvent(Number(id), name); } catch {} }
      try { handle.requestSystemState(REQ_SIM_STATE, 'Sim'); } catch {}
      GROUPS.forEach((g, i) => this._define(i));
    } catch (e) {
      this._setStatus({ connected: false, inSim: false, error: friendly(e) });
      this._retry();
    }
  }
  _lost(why) {
    if (!this.handle) return;
    this.handle = null;
    this._setStatus({ connected: false, inSim: false, paused: false, error: why });
    this._retry();
  }
  _retry() { clearTimeout(this.retryT); if (!this.stopped) this.retryT = setTimeout(() => this._connect(), 4000); }

  // (Re)build one group's definition with the variables the sim accepts.
  _define(groupIdx) {
    const h = this.handle; if (!h) return;
    for (const [id, d] of this.defs) if (d.groupIdx === groupIdx) {
      try { h.requestDataOnSimObject(id, id, SimConnectConstants.OBJECT_ID_USER, SimConnectPeriod.NEVER); } catch {}
      this.defs.delete(id);
    }
    const g = GROUPS[groupIdx];
    const vars = g.vars.filter(v => !this.bad.has(v[1]));
    if (!vars.length) return;
    const id = this.nextId++;
    for (const v of vars) {
      const kind = v[3] || 'n';
      const sendId = h.addToDataDefinition(id, v[1], kind === 's' ? null : v[2], kind === 's' ? SimConnectDataType.STRING256 : SimConnectDataType.FLOAT64);
      this.sendMap.set(sendId, { groupIdx, simvar: v[1] });
    }
    this.defs.set(id, { groupIdx, vars });
    // fast groups ≈ every 4th frame (10-15/s at normal frame rates); slow ones once a second
    if (g.rate === 'fast') h.requestDataOnSimObject(id, id, SimConnectConstants.OBJECT_ID_USER, SimConnectPeriod.VISUAL_FRAME, 0, 0, 4, 0);
    else h.requestDataOnSimObject(id, id, SimConnectConstants.OBJECT_ID_USER, SimConnectPeriod.SECOND, 0, 0, 0, 0);
  }
  _onException(ex) {
    const hit = ex && this.sendMap.get(ex.sendId);
    if (!hit || this.bad.has(hit.simvar)) return;
    this.bad.add(hit.simvar);
    this.emit('log', `Sim doesn't know ${hit.simvar} — skipped.`);
    clearTimeout(this['_rb' + hit.groupIdx]);
    this['_rb' + hit.groupIdx] = setTimeout(() => this._define(hit.groupIdx), 300);
  }
  _onData(d) {
    const def = this.defs.get(d.defineID); if (!def) return;
    try {
      for (const v of def.vars) {
        const kind = v[3] || 'n';
        if (kind === 's') this.sample[v[0]] = d.data.readString256().replace(/\u0000.*$/s, '').trim();
        else { const x = d.data.readFloat64(); this.sample[v[0]] = kind === 'b' ? x >= 0.5 : x; }
      }
    } catch { return; }
    // SimConnect: pitch is negative nose-up, bank positive left — flip so up / right are positive.
    if (def.groupIdx === 0) { this.sample.pitch = -this.sample.pitch; this.sample.bank = -this.sample.bank; }
    // one 'data' per burst of groups
    if (!this.emitT) this.emitT = setTimeout(() => { this.emitT = null; this.emit('data', { ...this.sample }); }, 15);
  }
  _onEvent(e) {
    const name = SYS[e.clientEventId]; if (!name) return;
    if (name === 'Pause') this._setStatus({ paused: e.data === 1 });
    if (name === 'Sim') this._setStatus({ inSim: e.data === 1 });
    this.emit('system', { name, value: e.data });
  }
}

function friendly(e) {
  const m = String(e && (e.message || e.code) || e || '');
  if (/ENOENT|ECONNREFUSED|pipe|connect/i.test(m)) return 'Waiting for Microsoft Flight Simulator — start the sim (it connects by itself).';
  return m.slice(0, 160);
}

module.exports = { SimLink, GROUPS };
