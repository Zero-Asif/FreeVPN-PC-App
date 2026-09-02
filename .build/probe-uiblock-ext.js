'use strict';
// ════════════════════════════════════════════════════════════════════
//  probe-uiblock-ext.js -- the rest of the frozen window.
//
//  probe-uiblock-geo.js measured GeoSpoof.applyAll. The same connect/
//  switch path also runs, on the SAME main thread, in this order:
//
//      forceAllBrowsersOntoProxy()   -- already async (spawn), not timed
//      ext.prepare()                 -- async
//      ext.install()                 -- synchronous reg work
//      runningBrowsers()             -- synchronous tasklist
//      ext.needManualLoad/needEnable/awaitingStart/presence
//
//  Same method as the geo probe: child_process.execSync is replaced with
//  a recorder BEFORE the modules are loaded, so every command is COUNTED
//  and nothing is executed. No registry key is written or deleted, no
//  browser policy is touched, and the state dir is a throwaway in TEMP.
//
//  Per-call cost is measured against a read-only `reg query` of a key
//  this app does not own.
// ════════════════════════════════════════════════════════════════════

const cp   = require('child_process');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

const ms = t0 => Number(process.hrtime.bigint() - t0) / 1e6;

// ── 1. the rate ──────────────────────────────────────────────────────
const REG_CMD = 'reg query "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion" /v CurrentBuild';
const REPS = 10;
let t = process.hrtime.bigint();
for (let i = 0; i < REPS; i++) {
    try { cp.execSync(REG_CMD, { windowsHide: true, encoding: 'utf8', stdio: 'pipe' }); } catch (e) {}
}
const perReg = ms(t) / REPS;
console.log(`\n── rate -- ${new Date().toISOString()} ──`);
console.log(`  reg query, mean of ${REPS}: ${perReg.toFixed(0)} ms`);

// ── 2. count, do not run ─────────────────────────────────────────────
let calls = [];
const realExecSync = cp.execSync;
cp.execSync = function (cmd) { calls.push(String(cmd)); return ''; };

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-uiblock-ext-'));
const quiet = { info(){}, warn(){}, error(){}, debug(){}, success(){} };

const browsers = require('../lib/browsers.js');
const { GeoExt } = require('../lib/geo-ext.js');

const rows = [];
function count(label, fn) {
    calls = [];
    let note = '';
    const t0 = process.hrtime.bigint();
    try { fn(); } catch (e) { note = 'threw: ' + (e.message || '').split('\n')[0].slice(0, 54); }
    const own = ms(t0);
    rows.push({ label, n: calls.length, own, note, cmds: calls.slice() });
    console.log(`  ${String(calls.length).padStart(3)} call(s)  ${label}` +
                (note ? `   (${note})` : ''));
    return calls.length;
}

console.log('\n── synchronous shell calls per connect/switch, by step ──');

let ext = null;
try {
    ext = new GeoExt({
        log: quiet,
        stateDir,
        sourceDir: path.join(__dirname, '..', 'Extension'),
        baseDir: path.join(stateDir, 'ext'),
    });
} catch (e) {
    console.log('  GeoExt could not be constructed: ' + e.message);
}

count('browsers.regExePaths()  -- cold registry scan, /s over two roots',
      () => browsers.regExePaths());
count('browsers.detectChromium()  -- second call, cache warm',
      () => browsers.detectChromium());
if (ext) {
    //  install() returns [] before prepare() has produced an id, and that
    //  early return would have reported "0 calls" for the step that writes
    //  the forcelist. The two fields prepare() sets are set here instead, so
    //  the loop that runs in the app is the loop that is counted.
    ext.id = 'a'.repeat(32);
    ext.host = { updateUrl: () => 'http://127.0.0.1:1/updates.xml' };
    count('ext.install()  -- forcelist write + read-back, per browser', () => ext.install());
    browsers.resetCache && browsers.resetCache();
    count('ext.presence()  -- with the browser cache cold again', () => ext.presence());
    count('ext.needManualLoad()', () => ext.needManualLoad());
    count('ext.needEnable()', () => ext.needEnable());
    count('ext.awaitingStart()', () => ext.awaitingStart());
}

const total = rows.reduce((a, r) => a + r.n, 0);
const est   = total * perReg;
console.log(`\n  ${total} synchronous call(s) outside GeoSpoof.applyAll` +
            `  =  ${est.toFixed(0)} ms of frozen window at ${perReg.toFixed(0)} ms each`);
console.log('  (a floor: any step that threw under the stub stopped counting early,');
console.log('   and tasklist is slower than reg query)');

const byVerb = {};
for (const r of rows) for (const c of r.cmds) {
    const m = /^(\w+)(?:\.exe)?\s+(\w+)?/.exec(c.trim());
    const k = m ? (m[1].toLowerCase() === 'reg' ? 'reg ' + (m[2] || '').toLowerCase()
                                                : m[1].toLowerCase()) : 'other';
    byVerb[k] = (byVerb[k] || 0) + 1;
}
console.log('\n── by verb ──');
for (const [v, n] of Object.entries(byVerb).sort((a, b) => b[1] - a[1])) {
    console.log(`     ${String(n).padStart(3)} x ${v}`);
}

console.log('\n── the whole picture for one connect ──');
const GEO_APPLY_MS = 2343;   // measured by probe-uiblock-geo.js on this machine
console.log(`  startTor() blocking calls, now off-thread:      was ~1370 ms`);
console.log(`  GeoSpoof.applyAll(coord):                      ~${GEO_APPLY_MS} ms  (>=35 calls)`);
console.log(`  the steps measured above:                       ~${est.toFixed(0)} ms  (${total} calls)`);
console.log(`  ------------------------------------------------------------`);
console.log(`  main thread not pumping messages:              ~${(GEO_APPLY_MS + est).toFixed(0)} ms` +
            ` after the startTor fix`);
if (GEO_APPLY_MS + est > 5000) {
    console.log('  > 5000 ms: this is what paints "(Not Responding)".');
}

cp.execSync = realExecSync;
try { fs.rmSync(stateDir, { recursive: true, force: true }); } catch (e) {}
console.log('\n  nothing was executed: execSync was replaced before the modules loaded.');
