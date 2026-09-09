'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/probe-uiblock-restore.js  --  what DISCONNECT costs the message pump.
//
//  The two other bursts in a session were counted and moved
//  (probe-uiblock-geo.js, probe-uiblock-ext.js). The third one the user
//  reported -- "disconnect korar somoy app not responding dekhacche" -- had
//  never been counted at all, and lib/offthread.js says in as many words that
//  GeoSpoof.restoreAll() is NOT off-thread on purpose, because the quit path
//  would kill the child halfway through and leave the Windows location platform
//  half restored.
//
//  That reasoning holds for QUIT. It does not hold for a disconnect the user
//  watches: the window is still open, still expected to paint, and the burst is
//  whatever this probe measures.
//
//  Nothing is executed: execSync is replaced with a recorder before the module
//  loads, and writes outside a throwaway state dir are refused and counted. The
//  journal restoreAll() reads is the one applyAll() writes in phase 1 here, so
//  the count is the real branch a live disconnect takes, not the empty one.
// ════════════════════════════════════════════════════════════════════

const cp   = require('child_process');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

const ms = (t0) => Number(process.hrtime.bigint() - t0) / 1e6;

const REG_CMD = 'reg query "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion" /v CurrentBuild';
const REPS = 10;
let t = process.hrtime.bigint();
for (let i = 0; i < REPS; i++) {
    try { cp.execSync(REG_CMD, { windowsHide: true, encoding: 'utf8', stdio: 'pipe' }); } catch (e) {}
}
const perReg = ms(t) / REPS;
t = process.hrtime.bigint();
try {
    cp.execSync('powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$null"',
                { windowsHide: true, encoding: 'utf8', stdio: 'pipe', timeout: 30000 });
} catch (e) {}
try {
    cp.execSync('powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$null"',
                { windowsHide: true, encoding: 'utf8', stdio: 'pipe', timeout: 30000 });
} catch (e) {}
const perPs = ms(t) / 2;

console.log(`\n── one synchronous call, measured -- ${new Date().toISOString()} ──`);
console.log(`  reg query, mean of ${REPS}:  ${perReg.toFixed(0)} ms`);
console.log(`  powershell -NoProfile:      ${perPs.toFixed(0)} ms`);

const calls = [];
cp.execSync = function (cmd) { calls.push(String(cmd)); return ''; };

//  8.3 vs long path: Node's tmpdir comes back as USERPC~1 and the allow-list
//  comparison below would then reject the module's own writes into the dir this
//  probe just made.
const stateDir = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), 'fp-uiblock-restore-')));
const quietLog = { info(){}, warn(){}, error(){}, debug(){}, success(){} };

const blocked = [];
const realWrite  = fs.writeFileSync.bind(fs);
const realUnlink = fs.unlinkSync.bind(fs);
const ALLOW = path.resolve(stateDir).toLowerCase();
const insideAllow = p => {
    try { return path.resolve(String(p)).toLowerCase().startsWith(ALLOW); } catch (e) { return false; }
};
fs.writeFileSync = (p, ...r) => insideAllow(p) ? realWrite(p, ...r) : void blocked.push(String(p));
fs.unlinkSync    = (p, ...r) => insideAllow(p) ? realUnlink(p, ...r) : void blocked.push(String(p));

const { GeoSpoof } = require('../lib/geo-spoof.js');
const COORD = { lat: 59.3293, lng: 18.0686, accuracy: 12 };
const PROXY = { host: '127.0.0.1', port: 9050, bypass: '' };

const geo = new GeoSpoof({ log: quietLog, stateDir });

// ── phase 1: connect, only so the journal exists ─────────────────────
try { geo.applyAll(COORD, PROXY); } catch (e) {
    console.log('\n  applyAll threw with execSync stubbed: ' + e.message);
}
const afterApply = calls.length;
console.log(`\n── phase 1, connect (counted elsewhere, run here for the journal) ──`);
console.log(`  ${afterApply} synchronous call(s), and a journal on disk to restore from`);

// ── phase 2: the disconnect burst, which is the question ─────────────
const t2 = process.hrtime.bigint();
let threw = null;
try { geo.restoreAll(); } catch (e) { threw = e.message; }
const ownMs = ms(t2);
const restore = calls.slice(afterApply);

console.log(`\n── phase 2: GeoSpoof.restoreAll() -- what a DISCONNECT blocks on ──`);
if (threw) console.log(`  it threw with execSync stubbed: ${threw}  (count is a floor)`);
const byProg = {};
for (const c of restore) {
    const p = (c.trim().match(/^"?([A-Za-z0-9_.\\:-]+?)"?[\s]/) || [, c.trim()])[1]
        .split(/[\\/]/).pop().replace(/\.exe$/i, '').toLowerCase();
    byProg[p] = (byProg[p] || 0) + 1;
}
console.log(`  ${restore.length} synchronous shell call(s), by program:`);
for (const [p, n] of Object.entries(byProg).sort((a, b) => b[1] - a[1])) {
    console.log(`     ${String(n).padStart(3)} x ${p}`);
}
const est = restore.reduce((a, c) => a + (/^powershell/i.test(c.trim()) ? perPs : perReg), 0);
console.log(`  own runtime with every command STUBBED OUT: ${ownMs.toFixed(0)} ms`);
console.log(`  estimated real cost at the rates above:     ${est.toFixed(0)} ms of frozen window`);

const verbs = {};
for (const c of restore) {
    const m = c.trim().match(/^(?:"[^"]*"|\S+)\s+(\S+)/);
    verbs[(m ? m[1] : '(bare)').toLowerCase()] = (verbs[(m ? m[1] : '(bare)').toLowerCase()] || 0) + 1;
}
console.log('\n  by verb:');
for (const [v, n] of Object.entries(verbs).sort((a, b) => b[1] - a[1])) {
    console.log(`     ${String(n).padStart(3)} x ${v}`);
}

console.log('\n── where it runs today, read out of main.js ──');
const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const offThreaded = /runOffThread\('geo-restore'/.test(mainSrc) ||
                    /runGeoRestore\(/.test(mainSrc);
console.log(`  clearGeolocationSpoof -> restoreAll(): ` +
            (offThreaded ? 'reached through an off-thread wrapper'
                         : 'called DIRECTLY on the main thread'));
if (!offThreaded && est > 3000) {
    console.log(`  ${est.toFixed(0)} ms on the pump is the "(Not Responding)" the user`);
    console.log('  reported at disconnect. Quit is a different case -- a child killed');
    console.log('  as the process exits leaves the location platform half restored --');
    console.log('  so the two paths cannot share one answer.');
}

cp.execSync = require('child_process').execSync;
fs.writeFileSync = realWrite;
fs.unlinkSync = realUnlink;
try { fs.rmSync(stateDir, { recursive: true, force: true }); } catch (e) {}
console.log(`\n  nothing was executed. ${blocked.length} file write(s) outside the ` +
            'throwaway state dir were refused' +
            (blocked.length ? ': ' + [...new Set(blocked)].slice(0, 4).join(', ') : ''));
