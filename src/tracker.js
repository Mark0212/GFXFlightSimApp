'use strict';
// Turns raw sim samples into the telemetry GoalForgeX gets: rounded values,
// derived fields (phase, flight time, distance, fuel %, landing rate…) and
// events (takeoff, landing with a rating, gear, stall, waypoint…). Runs at
// sample rate (~10/s) so edges like touchdown are caught precisely, even
// though the upload is slower.
const PHASES = { parked: 'Parked', taxi: 'Taxi', 'takeoff-roll': 'Takeoff roll', climb: 'Climb', cruise: 'Cruise',
  descent: 'Descent', approach: 'Approach', 'landing-roll': 'Landing roll' };

function haversineNm(a, b) {
  const R = 3440.065, r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(x)));
}
const round = (v, d = 0) => { const n = Number(v); if (!Number.isFinite(n)) return 0; const p = 10 ** d; return Math.round(n * p) / p; };
function landingRating(fpm) {
  const a = Math.abs(fpm);
  if (a < 60) return 'butter';
  if (a < 180) return 'smooth';
  if (a < 350) return 'firm';
  if (a < 600) return 'hard';
  return 'very-hard';
}

class FlightTracker {
  constructor() { this.reset(); }
  reset() {
    this.prev = null;
    this.flight = { time: 0, distance: 0, maxAltitude: 0, maxSpeed: 0, landings: 0, startedAt: Date.now() };
    this.last = { fpm: null, g: null, rating: null, at: 0 };
    this.phase = 'parked'; this.phaseCand = null; this.phaseSince = 0;
    this.airborneSince = 0; this.groundSince = Date.now(); this.lastAir = null;
    this.gPeak = 1; this.vsBuf = [];
    this.lastPos = null;
    this.landedAt = 0;
  }

  // sample: raw values from sim.js (or the demo). status: {paused, inSim}
  update(s, status = {}) {
    const now = Date.now(), ev = [];
    const p = this.prev;
    const paused = !!status.paused;
    const dt = p ? Math.min(2, (now - p._at) / 1000) : 0;

    // aircraft changed → new flight
    if (p && s.aircraft && p.aircraft && s.aircraft !== p.aircraft) { this.reset(); ev.push({ type: 'aircraft', aircraft: s.aircraft }); }
    const pp = this.prev;

    const onGround = !!s.onGround, gs = Number(s.groundSpeed) || 0, vs = Number(s.verticalSpeed) || 0;
    // rolling buffers for touchdown
    this.vsBuf.push(vs); if (this.vsBuf.length > 12) this.vsBuf.shift();
    this.gPeak = Math.max(this.gPeak * 0.97, Number(s.gForce) || 1);

    // accumulate this flight
    if (pp && !paused && dt > 0) {
      if (!onGround) this.flight.time += dt;
      if (this.lastPos && (gs > 1 || !onGround) && Number.isFinite(s.lat) && Number.isFinite(s.lon)) {
        const d = haversineNm(this.lastPos, s);
        if (d < 5) this.flight.distance += d; // a teleport / slew isn't distance flown
      }
    }
    if (Number.isFinite(s.lat) && Number.isFinite(s.lon)) this.lastPos = { lat: s.lat, lon: s.lon };
    if (!onGround) { this.flight.maxAltitude = Math.max(this.flight.maxAltitude, Number(s.altitude) || 0); this.flight.maxSpeed = Math.max(this.flight.maxSpeed, Number(s.ias) || 0); }

    if (pp) {
      // takeoff / landing
      if (pp.onGround && !onGround && (Number(s.ias) || 0) > 30) {
        this.airborneSince = now;
        const bounce = this.landedAt && now - this.landedAt < 4000;
        if (!bounce) {
          if (this.landedAt && now - this.landedAt > 120000) { this.flight.time = 0; this.flight.distance = 0; this.flight.maxAltitude = 0; this.flight.maxSpeed = 0; }
          ev.push({ type: 'takeoff', ias: round(s.ias), heading: round(s.heading), pitch: round(s.pitch, 1) });
        } else ev.push({ type: 'bounce', fpm: this.last.fpm });
      }
      if (!pp.onGround && onGround && now - this.airborneSince > 3000) {
        const tdv = Number(s.touchdownVelocity);
        const fpm = Number.isFinite(tdv) && tdv !== 0 ? -Math.abs(tdv) * 60 : Math.min(...this.vsBuf);
        const g = round(this.gPeak, 2), rating = landingRating(fpm);
        this.flight.landings++;
        this.landedAt = now;
        this.last = { fpm: round(fpm), g, rating, at: now };
        ev.push({ type: 'landing', fpm: round(fpm), g, rating, ias: round(s.ias), groundSpeed: round(gs),
          flightTime: Math.round(this.flight.time), distance: round(this.flight.distance, 1), landings: this.flight.landings });
      }
      // edges
      const edge = (k, on, off, extra) => { if (!!pp[k] !== !!s[k] && pp[k] !== undefined && s[k] !== undefined) ev.push({ type: s[k] ? on : off, ...(extra || {}) }); };
      edge('gearDown', 'gear-down', 'gear-up', { altitudeAgl: round(s.altitudeAgl), ias: round(s.ias) });
      edge('engineRunning', 'engine-start', 'engine-stop');
      edge('apMaster', 'autopilot-on', 'autopilot-off');
      edge('parkingBrake', 'parking-brake-set', 'parking-brake-off');
      if (!pp.stallWarning && s.stallWarning && !onGround) ev.push({ type: 'stall', ias: round(s.ias), altitude: round(s.altitude) });
      if (!pp.overspeedWarning && s.overspeedWarning) ev.push({ type: 'overspeed', ias: round(s.ias) });
      if (pp.flapsIndex !== undefined && s.flapsIndex !== undefined && pp.flapsIndex !== s.flapsIndex) ev.push({ type: 'flaps', index: round(s.flapsIndex), percent: round(s.flaps) });
      if (s.nextWaypoint && pp.nextWaypoint && s.nextWaypoint !== pp.nextWaypoint) ev.push({ type: 'waypoint', passed: pp.nextWaypoint, next: s.nextWaypoint });
    }

    // phase (must hold 3 s before it counts, so a bump doesn't flicker it)
    let ph;
    if (onGround) ph = gs < 1 ? 'parked' : gs < 35 ? 'taxi' : (this.landedAt && now - this.landedAt < 60000 ? 'landing-roll' : 'takeoff-roll');
    else if ((Number(s.altitudeAgl) || 0) < 3000 && vs < -100 && (s.gearDown || (Number(s.flaps) || 0) > 10)) ph = 'approach';
    else if (vs > 400) ph = 'climb';
    else if (vs < -400) ph = 'descent';
    else ph = 'cruise';
    if (ph !== this.phase) {
      if (this.phaseCand !== ph) { this.phaseCand = ph; this.phaseSince = now; }
      else if (now - this.phaseSince > 3000) {
        ev.push({ type: 'phase', phase: ph, label: PHASES[ph], previous: this.phase });
        this.phase = ph; this.phaseCand = null;
      }
    } else this.phaseCand = null;

    this.prev = { ...s, _at: now };

    const fuelPct = Number(s.fuelCapacity) > 0 ? (Number(s.fuelGallons) / Number(s.fuelCapacity)) * 100 : 0;
    const wpNm = Number(s.wpDistanceM) > 0 ? Number(s.wpDistanceM) / 1852 : 0;
    const t = {
      aircraft: s.aircraft || '', atcId: s.atcId || '', airline: s.airline || '', flightNumber: s.flightNumber || '',
      atcType: s.atcType || '', atcModel: s.atcModel || '',
      lat: round(s.lat, 5), lon: round(s.lon, 5),
      altitude: round(s.altitude), altitudeIndicated: round(s.altitudeIndicated), altitudeAgl: round(s.altitudeAgl), groundElevation: round(s.groundElevation),
      heading: round(((Number(s.heading) % 360) + 360) % 360, 1), headingTrue: round(((Number(s.headingTrue) % 360) + 360) % 360, 1),
      pitch: round(s.pitch, 1), bank: round(s.bank, 1),
      ias: round(s.ias), tas: round(s.tas), groundSpeed: round(gs), verticalSpeed: round(vs), mach: round(s.mach, 3), gForce: round(s.gForce, 2),
      onGround, stallWarning: !!s.stallWarning, overspeedWarning: !!s.overspeedWarning,
      gearDown: !!s.gearDown, gearPercent: round(s.gearPercent), flaps: round(s.flaps), flapsIndex: round(s.flapsIndex),
      spoilers: round(s.spoilers), parkingBrake: !!s.parkingBrake, throttle: round(s.throttle),
      engines: round(s.engines), engineRunning: !!s.engineRunning, rpm: round(s.rpm), n1: round(s.n1, 1),
      fuelGallons: round(s.fuelGallons, 1), fuelCapacity: round(s.fuelCapacity, 1), fuelPounds: round(s.fuelPounds), fuelPercent: round(fuelPct, 1),
      apMaster: !!s.apMaster, apAltitude: round(s.apAltitude), apHeading: round(s.apHeading), apSpeed: round(s.apSpeed), apVerticalSpeed: round(s.apVerticalSpeed),
      lightBeacon: !!s.lightBeacon, lightLanding: !!s.lightLanding, lightStrobe: !!s.lightStrobe, lightNav: !!s.lightNav, lightTaxi: !!s.lightTaxi,
      outsideTemp: round(s.outsideTemp, 1), windSpeed: round(s.windSpeed), windDirection: round(s.windDirection), pressure: round(s.pressure, 1),
      visibility: round(s.visibility), inCloud: !!s.inCloud, localTime: round(s.localTime), zuluTime: round(s.zuluTime), simRate: round(s.simRate, 2) || 1,
      flightPlanActive: !!s.flightPlanActive, wpCount: round(s.wpCount), wpIndex: round(s.wpIndex), nextWaypoint: s.nextWaypoint || '', prevWaypoint: s.prevWaypoint || '',
      wpDistance: round(wpNm, 1), wpEte: round(s.wpEte), destEte: round(s.destEte),
      phase: this.phase, phaseLabel: PHASES[this.phase] || '',
      flightTime: Math.round(this.flight.time), distanceFlown: round(this.flight.distance, 1),
      maxAltitude: round(this.flight.maxAltitude), maxSpeed: round(this.flight.maxSpeed), landings: this.flight.landings,
      lastLandingFpm: this.last.fpm, lastLandingG: this.last.g, lastLandingRating: this.last.rating || '',
    };
    return { t, events: ev };
  }
}

module.exports = { FlightTracker, PHASES, landingRating };
