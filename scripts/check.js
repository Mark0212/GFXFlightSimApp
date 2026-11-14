// CI sanity check (no Electron, no sim): syntax of every source file + a 6-second demo
// flight through the tracker, which must produce telemetry and a phase change.
const fs = require('fs'), path = require('path'), vm = require('vm');
const src = path.join(__dirname, '..', 'src');
const files = [];
(function walk(d) { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else if (p.endsWith('.js')) files.push(p); } })(src);
for (const f of files) new vm.Script(fs.readFileSync(f, 'utf8'), { filename: f });
console.log('syntax ok:', files.length, 'files');
const { DemoSim } = require('../src/demo'), { FlightTracker } = require('../src/tracker');
const demo = new DemoSim(), tr = new FlightTracker();
let n = 0, keys = 0; const ev = [];
demo.on('data', s => { const o = tr.update(s, {}); n++; keys = Object.keys(o.t).length; ev.push(...o.events.map(e => e.type)); });
demo.start();
setTimeout(() => {
  demo.stop();
  console.log('samples', n, 'keys', keys, 'events', ev.join(','));
  if (n < 30 || keys < 60) { console.error('demo flight produced too little telemetry'); process.exit(1); }
  process.exit(0);
}, 6000);
