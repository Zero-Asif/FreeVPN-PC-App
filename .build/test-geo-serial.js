'use strict';
// ════════════════════════════════════════════════════════════════════
//  test-geo-serial.js -- the race that moving work off the thread opened.
//
//  GeoSpoof.applyAll() used to run synchronously on the main thread: 43
//  `reg`/`sc`/`powershell` calls, 2.3-5.0 s of a window that never pumps
//  a message. It now runs in a child process (lib/offthread.js), which
//  fixes the freeze and creates a new hazard the sync version could not
//  have: two of them alive at once.
//
//  applyGeolocationSpoof's wrapper is fire-and-forget and its FIRST step
//  is an await, so a second switch really can arrive mid-run. Two
//  concurrent applyAll runs would both read the same restore journal,
//  both write it, and both write the same Firefox user.js -- and the
//  loser of that race is whichever country the user switched AWAY from,
//  left on screen as the spoofed location.
//
//  runGeoApply() in main.js is the answer: chained FIFO, so at most one
//  child is alive and the newest country is applied last. This file
//  lifts that function's SHIPPED TEXT out of main.js -- it is a closure
//  and cannot be required -- and drives it with stubs.
//
//  Nothing is applied: runOffThread and geoEngine are both fakes, so no
//  child is forked, no registry key is read and no profile is written.
// ════════════════════════════════════════════════════════════════════

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const src  = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (cond, what, detail = '') => {
    console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${what}${detail ? ' -- ' + detail : ''}`);
    cond ? pass++ : fail++;
};

// ── lift the real block, do not describe it ─────────────────────────
const FROM = src.indexOf('let _geoApplyChain = Promise.resolve();');
const TO   = src.indexOf('// ── Wrap applyGeolocationSpoof', FROM);
if (FROM < 0 || TO < 0) {
    console.log('ABORT: main.js no longer declares _geoApplyChain / runGeoApply above the wrapper');
    process.exit(3);
}
const text = src.slice(FROM, TO);

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Build a fresh runGeoApply over fresh stubs, so each scenario starts with
 * an empty chain rather than inheriting the previous one's.
 */
function build({ answer }) {
    const seen = { starts: [], ends: [], inproc: [], logs: [], live: 0, maxLive: 0 };
    const runOffThread = async (job, payload) => {
        seen.starts.push({ job, payload });
        seen.live++;
        if (seen.live > seen.maxLive) seen.maxLive = seen.live;
        const a = await answer(payload, seen.starts.length);
        seen.live--;
        seen.ends.push(payload && payload.coord ? payload.coord.city : null);
        return a;
    };
    const Logger = { debug: m => seen.logs.push(String(m)), warn: m => seen.logs.push(String(m)),
                     info(){}, error(){}, success(){} };
    const geoEngine = () => ({ applyAll(c) {
        seen.inproc.push(c && c.city);
        if (c && c.throwHere) throw new Error('in-process applyAll failed');
    } });
    const fn = new Function('runOffThread', 'APPDATA_PATH', 'Logger', 'geoEngine',
        text + '\n; return runGeoApply;')(runOffThread, 'C:\\STATE\\DIR', Logger, geoEngine);
    return { runGeoApply: fn, seen };
}

const CITY = (city, ms) => ({ lat: 1, lng: 2, accuracy: 10, city, _ms: ms });

(async () => {
    console.log(`\n── two switches in a row, one child at a time -- ${new Date().toISOString()} ──`);
    {
        //  Stockholm is asked for first and is SLOW; Berlin is asked for while
        //  it is still running and is fast. Unchained, Berlin would finish
        //  first and Stockholm would overwrite it -- the user would be looking
        //  at the country they just left.
        const { runGeoApply, seen } = build({
            answer: async p => { await sleep(p.coord._ms); return { ok: true }; },
        });
        const a = runGeoApply(CITY('stockholm', 120));
        const b = runGeoApply(CITY('berlin', 10));
        await Promise.all([a, b]);

        ok(seen.maxLive === 1, 'never more than one child alive at once',
           'peak ' + seen.maxLive);
        ok(seen.ends.join(',') === 'stockholm,berlin',
           'and they finish in the order they were asked for, so the NEWEST country ' +
           'is the one left applied', seen.ends.join(','));
        ok(seen.starts.length === 2, 'both were run -- serialising is not dropping one');
        ok(seen.starts.every(s => s.job === 'geo-apply'), 'each one asks for the geo-apply job');
        ok(seen.starts.every(s => s.payload.stateDir === 'C:\\STATE\\DIR'),
           'and passes the app state dir, so the journal is written where restore reads it');
        ok(seen.starts[1].payload.coord.city === 'berlin' &&
           seen.starts[1].payload.coord.lat === 1 && seen.starts[1].payload.coord.lng === 2,
           'the coordinates go across untouched');
        ok(seen.inproc.length === 0, 'and nothing ran on the main thread while the child worked');
    }

    console.log('\n── a child that cannot start still shields the machine ──');
    {
        const { runGeoApply, seen } = build({
            answer: async () => ({ ok: false, error: 'EACCES spawning electron' }),
        });
        await runGeoApply(CITY('oslo', 0));
        ok(seen.inproc.join(',') === 'oslo',
           'the same applyAll runs in-process instead -- a freeze is a bug, an unshielded ' +
           'machine would be a lie', seen.inproc.join(','));
        ok(seen.logs.some(l => /could not run off-thread/.test(l) && /EACCES/.test(l)),
           'and the log says why it fell back, with the real reason',
           seen.logs[0] || 'no log line');
    }

    console.log('\n── a fallback that throws does not wedge the queue ──');
    {
        //  The wrapper in main.js has its own catch for this; what matters here
        //  is that the NEXT switch still gets applied.
        const { runGeoApply, seen } = build({
            answer: async () => ({ ok: false, error: 'no result' }),
        });
        let rejected = false;
        const bad = { ...CITY('paris', 0), throwHere: true };
        await runGeoApply(bad).catch(() => { rejected = true; });
        ok(rejected, 'the failure is handed up to the caller, not swallowed');
        await runGeoApply(CITY('madrid', 0));
        ok(seen.inproc.join(',') === 'paris,madrid',
           'and the country switched to AFTER the failure is still applied',
           seen.inproc.join(','));
    }

    console.log('\n── the call site really uses it ──');
    {
        const at = src.indexOf('await runGeoApply(coord);');
        ok(at > 0, 'applyGeolocationSpoof awaits runGeoApply(coord)');
        ok(src.indexOf('geo.applyAll(') < 0,
           'and nothing in main.js calls applyAll on the main thread outside that fallback',
           'still present at ' + src.indexOf('geo.applyAll('));
        const direct = [...src.matchAll(/runOffThread\('geo-apply'/g)];
        ok(direct.length === 1,
           'there is exactly one place that forks the geo child, so nothing can bypass ' +
           'the queue', String(direct.length));
    }

    console.log(`\n${pass}/${pass + fail} checks passed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.log('ABORT: ' + e.stack); process.exit(3); });
