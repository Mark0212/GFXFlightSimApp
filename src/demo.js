'use strict';
// Demo flight: a pretend sim (same events / sample shape as sim.js) flying a
// ~4-minute loop — parked, taxi, takeoff, climb, cruise, descent, approach,
// landing, taxi in. Lets a streamer build and test an overlay without the sim
// running, and tests the whole app → GoalForgeX → scene path.
const EventEmitter = require('events');

const LEGS = [ // [seconds, phase]
  [10, 'parked'], [14, 'taxi'], [12, 'roll'], [45, 'climb'], [40, 'cruise'], [35, 'descent'], [30, 'approach'], [10, 'rollout'], [12, 'taxi-in'],
];
const TOTAL = LEGS.reduce((a, l) => a + l[0], 0);
const WAYPOINTS = ['KSEA', 'SUMMA', 'JAWBN', 'OLM', 'BTG', 'KPDX'];

class DemoSim extends EventEmitter {
  constructor() { super(); this.timer = null; this.status = { connected: false, inSim: false, paused: false, simName: null, error: null }; }
  start() {
    if (this.timer) return;
    this.t0 = Date.now(); this.lat = 47.4502; this.lon = -122.3088; this.alt = 433; this.hdg = 160; this.spd = 0; this.vs = 0;
    this.status = { connected: true, inSim: true, paused: false, simName: 'Demo flight', demo: true, error: null };
    this.emit('status', { ...this.status });
    this.emit('system', { name: 'FlightLoaded', value: 0 });
    this.timer = setInterval(() => this._tick(), 100);
  }
  stop() {
    clearInterval(this.timer); this.timer = null;
    this.status = { connected: false, inSim: false, paused: false, simName: null, error: null };
    this.emit('status', { ...this.status });
  }
  _tick() {
    const el = ((Date.now() - this.t0) / 1000) % TOTAL;
    let acc = 0, leg = LEGS[0], into = 0;
    for (const l of LEGS) { if (el < acc + l[0]) { leg = l; into = el - acc; break; } acc += l[0]; }
    const f = into / leg[0], ph = leg[1];
    const dt = 0.1;
    let targetSpd = 0, targetVs = 0, onGround = true, gear = true, flapsIdx = 0, ap = false, thr = 20;
    if (ph === 'parked') { this.alt = 433; this.spd = 0; }
    if (ph === 'taxi' || ph === 'taxi-in') { targetSpd = 16; thr = 30; }
    if (ph === 'roll') { targetSpd = 150; thr = 100; flapsIdx = 1; }
    if (ph === 'climb') { onGround = false; targetSpd = 250; targetVs = 5000; thr = 92; gear = f < 0.12; flapsIdx = f < 0.25 ? 1 : 0; ap = f > 0.4; }
    if (ph === 'cruise') { onGround = false; targetSpd = 280; targetVs = 0; thr = 70; gear = false; ap = true; }
    if (ph === 'descent') { onGround = false; targetSpd = 240; targetVs = -1200; thr = 35; gear = false; ap = true; }
    if (ph === 'approach') { onGround = false; targetSpd = 140; targetVs = -700; thr = 45; gear = true; flapsIdx = f < 0.4 ? 2 : 3; }
    if (ph === 'rollout') { targetSpd = 20; thr = 0; flapsIdx = 3; }
    if (ph === 'climb' || ph === 'cruise' || ph === 'descent' || ph === 'approach') {
      // keep the loop's altitude sane: land exactly where it took off
      if (ph === 'approach') targetVs = -Math.max(120, (this.alt - 433) / Math.max(0.6, leg[0] - into));
    }
    this.spd += (targetSpd - this.spd) * Math.min(1, dt * (onGround ? 0.35 : 0.25));
    this.vs += (targetVs - this.vs) * Math.min(1, dt * 0.6);
    if (onGround) { this.vs = 0; this.alt = 433; } else this.alt = Math.max(433, this.alt + this.vs / 60 * dt);
    if (ph === 'cruise' || ph === 'descent') this.hdg = (this.hdg + 0.25) % 360;
    const nm = this.spd * dt / 3600, r = this.hdg * Math.PI / 180;
    this.lat += nm / 60 * Math.cos(r); this.lon += nm / 60 * Math.sin(r) / Math.cos(this.lat * Math.PI / 180);
    const wpI = Math.min(WAYPOINTS.length - 1, Math.floor(el / TOTAL * WAYPOINTS.length));
    const sample = {
      lat: this.lat, lon: this.lon, altitude: this.alt, altitudeIndicated: this.alt + 12, altitudeAgl: this.alt - 433, groundElevation: 433,
      heading: this.hdg, headingTrue: this.hdg + 15, pitch: onGround ? 0 : this.vs / 500 + 2, bank: ph === 'cruise' || ph === 'descent' ? 8 : 0,
      ias: this.spd, tas: this.spd * (1 + this.alt / 60000), groundSpeed: this.spd * 1.02, verticalSpeed: this.vs, mach: this.spd / 661,
      gForce: 1 + Math.sin(Date.now() / 900) * 0.03, onGround, touchdownVelocity: 2.1, stallWarning: false, overspeedWarning: false,
      gearDown: gear, gearPercent: gear ? 100 : 0, flaps: [0, 33, 66, 100][flapsIdx], flapsIndex: flapsIdx, spoilers: ph === 'rollout' ? 100 : 0,
      parkingBrake: ph === 'parked', throttle: thr, engines: 2, engineRunning: true, rpm: 0, n1: 20 + thr * 0.75,
      fuelGallons: 5200 - el * 4, fuelCapacity: 6875, fuelPounds: (5200 - el * 4) * 6.7,
      apMaster: ap, apAltitude: 12000, apHeading: Math.round(this.hdg), apSpeed: 280, apVerticalSpeed: ph === 'descent' ? -1800 : 1500,
      lightBeacon: true, lightLanding: !['parked', 'cruise'].includes(ph), lightStrobe: !onGround || ph === 'roll', lightNav: true, lightTaxi: onGround,
      outsideTemp: 15 - this.alt / 500, windSpeed: 12, windDirection: 190, pressure: 1013.2, visibility: 16000, inCloud: false,
      localTime: (14 * 3600 + el) % 86400, zuluTime: (22 * 3600 + el) % 86400, simRate: 1,
      flightPlanActive: true, wpCount: WAYPOINTS.length, wpIndex: wpI, wpDistanceM: 18520 * (1 - (el / TOTAL * WAYPOINTS.length) % 1), wpEte: 240, destEte: Math.max(0, TOTAL - el) * 20,
      aircraft: 'Demo Airliner (GoalForgeX)', atcId: 'GFX101', airline: 'GoalForgeX Air', flightNumber: '101', atcType: 'Airliner', atcModel: 'A320',
      nextWaypoint: WAYPOINTS[wpI], prevWaypoint: wpI ? WAYPOINTS[wpI - 1] : '',
    };
    this.emit('data', sample);
  }
}

module.exports = { DemoSim };
