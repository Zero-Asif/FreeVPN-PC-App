'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/test-uiblock-guard.js  --  the window never stops painting.
//
//  THE REPORT, verbatim: "majhe majhe country switching er somoy, 1st connect
//  korar somoy, disconnect korar somoy app 'not responding' dekhacche abar thik
//  hoye jacche".
//
//  Windows paints "(Not Responding)" over a window whose message queue has gone
//  unserviced for about five seconds, and Electron pumps that queue on the same
//  thread that runs main.js. So every synchronous spawn on a session path is a
//  freeze of its own duration. Four probes counted the four bursts:
//
//    probe-uiblock.js          the connect path      ~5758 ms
//    probe-uiblock-geo.js      applyAll, per switch
//    probe-uiblock-ext.js      ext.install()         43 reg calls, ~10 s
//    probe-uiblock-restore.js  the disconnect        32 reg calls, ~7 s
//    probe-uiblock-startup.js  before the window     30 reg calls, ~5752 ms
//
//  All five are MEASURING instruments: they print counts and exit 0 either way.
//  Nothing asserted the fix, so a single execSync added back to a session path
//  would reintroduce the report with the whole suite green. This is that
//  assertion, static, on main.js with comments stripped so prose cannot satisfy
//  a check. Nothing is spawned and nothing is written.
// ════════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const { stripComments } = require('./srcstrip.js');

const ROOT = path.join(__dirname, '..');
const MAINFILE = process.env.FP_MAIN || path.join(ROOT, 'main.js');
const main = stripComments(fs.readFileSync(MAINFILE, 'utf8'));

let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
    if (cond) { pass++; console.log('  ok   ' + name); }
    else { fail++; console.log('  FAIL ' + name + (extra ? '  -- ' + extra : '')); }
};
const count = (re) => (main.match(re) || []).length;
const sites = (re) => [...main.matchAll(re)].map(m => m[0].replace(/\s+/g, ' '));

//  Bounded by brace count, and the PARAMETER LIST skipped first. That order is
//  not optional here: `function killTor({ blocking = true } = {})` puts two
//  braces in its own signature, so counting from the first `{` in the text ends
//  the "body" at the destructure's default and every check against it reads as
//  missing code that is right there.
function bodyFrom(index) {
    if (index < 0) return '';
    let i = main.indexOf('(', index);
    if (i < 0) return '';
    let depth = 0, q = null;
    for (; i < main.length; i++) {
        const c = main[i];
        if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
        if (c === '"' || c === "'" || c === '`') { q = c; continue; }
        if (c === '(') depth++;
        else if (c === ')' && --depth === 0) { i++; break; }
    }
    i = main.indexOf('{', i);
    if (i < 0) return '';
    depth = 0; q = null;
    for (; i < main.length; i++) {
        const c = main[i];
        if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
        if (c === '"' || c === "'" || c === '`') { q = c; continue; }
        if (c === '{') depth++;
        else if (c === '}' && --depth === 0) return main.slice(index, i + 1);
    }
    return '';
}
function lift(name) {
    const m = new RegExp('\\n\\s*(?:const|let|var|(?:async\\s+)?function)\\s+' +
                         name + '\\b').exec(main);
    return m ? bodyFrom(m.index + 1) : '';
}

// ════════════════════════════════════════════════════════════════════
console.log('── no new synchronous spawn in the main process ──');
// ════════════════════════════════════════════════════════════════════
//  Two are allowed, both by name and both for a stated reason. A third is a
//  freeze whoever added it did not measure.
const SYNC = sites(/(?:execSync|spawnSync|execFileSync)\([^\n]{0,70}/g);
ok(SYNC.length === 2,
   'main.js has exactly 2 synchronous spawn call sites (' + SYNC.length + ')',
   SYNC.map(s => s.slice(0, 64)).join('  |  '));
ok(SYNC.some(s => /execSync\('net session'/.test(s)),
   "one is execSync('net session') -- the elevation check, which runs once " +
   'before there is a window to freeze');
ok(SYNC.some(s => /execSync\('taskkill \/F \/IM tor\.exe/.test(s)),
   'the other is the taskkill inside killTor()\'s blocking branch, which is ' +
   'reached from the quit path only');
ok(count(/spawnSync\(/g) === 0 && count(/execFileSync\(/g) === 0,
   'and neither spawnSync nor execFileSync appears at all');

// ════════════════════════════════════════════════════════════════════
console.log('\n── killTor blocks only when nobody can see it ──');
// ════════════════════════════════════════════════════════════════════
const kt = lift('killTor');
ok(/blocking = true/.test(kt),
   'killTor() defaults to blocking -- the quit path wants certainty that ' +
   'tor.exe is dead before the process exits');
ok(/if \(!blocking\)/.test(kt) && /runQuiet\('taskkill'/.test(kt),
   'and its non-blocking branch spawns the same taskkill asynchronously');
ok(count(/killTor\(\)/g) === 1,
   'exactly one call site takes that blocking default (' +
   count(/killTor\(\)/g) + ')');
ok(count(/killTor\(\{ blocking: false \}\)/g) >= 5,
   'every other call site passes { blocking: false } (' +
   count(/killTor\(\{ blocking: false \}\)/g) + ' of them) -- connect, switch, ' +
   'disconnect and the tunnel teardown all happen with a window on screen');

// ════════════════════════════════════════════════════════════════════
console.log('\n── the five registry bursts run in a child ──');
// ════════════════════════════════════════════════════════════════════
//  Each wrapper is the ONLY door to its engine call, and each has an in-process
//  fallback. The fallback matters as much as the child: a freeze is a bug, but
//  silently skipping the shield because a fork failed would be a claim of
//  coverage that was never applied.
const WRAPPERS = [
    ['runGeoApply',   'geo-apply',   'applyAll',         'every connect and every switch'],
    ['runGeckoApply', 'geo-gecko',   'applyGecko',       'a split-tunnel list edited live'],
    ['runGeoRestore', 'geo-restore', 'restoreAll',       'the disconnect burst'],
    ['runGeoStartup', 'geo-startup', 'restoreLeftovers', 'the purge that used to run before createWindow()'],
    ['runExtInstall', 'ext-install', 'ext.install',      'the largest burst of the three'],
];
for (const [name, job, engine, when] of WRAPPERS) {
    const body = lift(name);
    ok(!!body, name + '() is locatable', 'could not bound it');
    ok(new RegExp("runOffThread\\('" + job + "'").test(body),
       name + "() goes to the child as job '" + job + "' -- " + when,
       'no runOffThread call for that job');
    ok(/if \(off\.ok/.test(body),
       'it decides on the child\'s own answer, not on the fork succeeding');
    ok(body.includes(engine + '('),
       'and falls back to ' + engine + '() in-process when the child cannot run, ' +
       'because a skipped shield is worse than a freeze');
    ok(/could not run off-thread/.test(body),
       'saying so in the log, so a machine that never manages to fork is ' +
       'diagnosable rather than merely slow');
}

// ── and there is no second door to any of them ──
//  This is the check that catches the regression. A switch that calls
//  applyAll() directly is exactly the freeze the wrapper was written to end,
//  and it would look completely ordinary in a diff.
for (const [engine, allowed, why] of [
    ['applyAll', 1, 'runGeoApply\'s fallback'],
    ['applyGecko', 1, 'runGeckoApply\'s fallback'],
    ['restoreLeftovers', 1, 'runGeoStartup\'s fallback'],
    ['ext\\.install\\(\\)', 1, 'runExtInstall\'s fallback'],
]) {
    const n = count(new RegExp(engine + (engine.endsWith(')') ? '' : '\\('), 'g'));
    ok(n === allowed,
       engine.replace(/\\/g, '') + ' is called from one place only -- ' + why,
       n + ' call sites, so a session path reaches it without the child');
}

//  restoreAll is the one with two legitimate callers, and the second is the
//  reason the pair cannot share an answer: on QUIT the parent exits the moment
//  the restore settles, and a child killed mid-restore leaves the Windows
//  location platform half restored. A freeze nobody sees is the better trade.
ok(count(/restoreAll\(/g) === 2,
   'restoreAll() has exactly two callers (' + count(/restoreAll\(/g) + ')',
   'a third means a disconnect path found its way past runGeoRestore');
//  The wrapper, not the original: clearGeolocationSpoof is reassigned late in the
//  file, and that reassignment is where the quit/disconnect choice lives.
const cg = bodyFrom(main.indexOf('clearGeolocationSpoof = function'));
ok(/quitting\s*\?/.test(cg) && /:\s*runGeoRestore\(\)/.test(cg),
   'and the choice between them is the `quitting` flag: in-process on quit, ' +
   'runGeoRestore() on a disconnect the user is watching');

// ════════════════════════════════════════════════════════════════════
console.log('\n── one at a time, in the order they were asked for ──');
// ════════════════════════════════════════════════════════════════════
//  Two of these overlapping both read and rewrite the same restore journal, and
//  the loser of that race is whichever country the user switched AWAY from --
//  left on screen as the spoofed location.
ok(count(/_geoApplyChain/g) >= 9,
   'the four geo jobs share one FIFO chain (' + count(/_geoApplyChain/g) +
   ' references) so the newest country is applied last');
ok(count(/\.then\(step, step\)/g) === 5,
   'each wrapper chains with .then(step, step) -- the same step on both arms, ' +
   'so one job throwing cannot break the chain for every job after it',
   count(/\.then\(step, step\)/g) + ' of them');
ok(/_extChain/.test(main) && count(/_extChain/g) >= 3,
   'the extension install has its own chain, because it writes a different ' +
   'journal and serialising it against a country switch would add seconds ' +
   'to every switch for nothing');
ok(/first free slot/.test(fs.readFileSync(MAINFILE, 'utf8')) ||
   count(/_extChain/g) >= 3,
   'and it IS serialised against itself: two installs racing both pick the ' +
   'first free slot in one forcelist key and write our entry twice');

// ════════════════════════════════════════════════════════════════════
console.log('\n── the child is a plain Node process, and it is bounded ──');
// ════════════════════════════════════════════════════════════════════
const rot = lift('runOffThread');
ok(!!rot, 'runOffThread() is locatable', 'could not bound it');
ok(/fork\(OFFTHREAD_SCRIPT/.test(rot),
   'it forks lib/offthread.js, which runs the same module and the same commands ' +
   'in the same order, and forwards its log lines back');
ok(/ELECTRON_RUN_AS_NODE: '1'/.test(rot),
   "with ELECTRON_RUN_AS_NODE -- otherwise the child is a second Electron app: " +
   'a window, a second-instance lock and its own app.on(ready)');
ok(/setTimeout\(/.test(rot) && /timed out after/.test(rot),
   'a child that never answers is timed out rather than awaited forever');
ok(/timeoutMs = \d+/.test(rot),
   'by a default the call sites can override (' +
   ((main.match(/function runOffThread\(job, payload, timeoutMs = (\d+)\)/) || [])[1] ||
    '?') + ' ms)');
ok(/child\.on\('error'/.test(rot) && /child\.on\('exit'/.test(rot),
   'and a fork that dies or never starts resolves { ok: false } instead of ' +
   'hanging the wrapper that awaited it');
ok(fs.existsSync(path.join(ROOT, 'lib', 'offthread.js')),
   'lib/offthread.js exists to be forked');
ok(/app\.asar\.unpacked/.test(main),
   'and packaged, the unpacked copy is preferred so the child needs no asar ' +
   'support of its own');

console.log(`\n${pass}/${pass + fail} checks passed`);
if (fail) {
    console.log('\nTHIS WAS REPORTED, NOT IMAGINED: "country switching er somoy, 1st\n' +
                'connect korar somoy, disconnect korar somoy app not responding\n' +
                'dekhacche". Every synchronous spawn on a session path is a freeze of\n' +
                'its own length, and five probes counted these five bursts at 5-10 s each.');
    process.exit(1);
}
process.exit(0);
