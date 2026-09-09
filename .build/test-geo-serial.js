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
    const seen = { starts: [], ends: [], inproc: [], gecko: [], logs: [],
                   live: 0, maxLive: 0 };
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
    const geoEngine = () => ({
        applyAll(c) {
            seen.inproc.push(c && c.city);
            if (c && c.throwHere) throw new Error('in-process applyAll failed');
        },
        applyGecko(c) { seen.gecko.push(c && c.city); return 0; },
    });
    const fn = new Function('runOffThread', 'APPDATA_PATH', 'Logger', 'geoEngine',
        text + '\n; return { runGeoApply, runGeckoApply };')(
            runOffThread, 'C:\\STATE\\DIR', Logger, geoEngine);
    return { runGeoApply: fn.runGeoApply, runGeckoApply: fn.runGeckoApply, seen };
}

const CITY = (city, ms) => ({ lat: 1, lng: 2, accuracy: 10, city, _ms: ms });
const PROXY = { host: '127.0.0.1', port: 9050, bypass: 'example.com' };

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
        const a = runGeoApply(CITY('stockholm', 120), PROXY);
        const b = runGeoApply(CITY('berlin', 10), PROXY);
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
        //  2.0.5: the Gecko family's share of the tunnel travels the same way.
        //  It has to arrive INTACT -- a port that crossed as a string, or a
        //  bypass list that was dropped, would have geo-spoof.js either throw
        //  or write a Firefox that tunnels a host the rest of the machine sends
        //  direct. Neither failure is visible from the parent.
        ok(seen.starts.every(s => s.payload.proxy &&
                                  s.payload.proxy.host === '127.0.0.1' &&
                                  s.payload.proxy.port === 9050 &&
                                  s.payload.proxy.bypass === 'example.com'),
           'and the SOCKS descriptor crosses with it, whole -- host, numeric port ' +
           'and the split-tunnel list', JSON.stringify(seen.starts[0].payload.proxy));
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

    console.log('\n── a split-tunnel edit shares the SAME queue as a country switch ──');
    {
        //  applyLiveBypass() rewrites the Gecko no_proxies_on list while the
        //  session is up, and that touches the same journal and the same
        //  user.js files a country switch does. On its own chain it would be a
        //  second writer -- the race this whole file exists to close, reopened
        //  by the fix for the freeze.
        const { runGeoApply, runGeckoApply, seen } = build({
            answer: async p => { await sleep(p.coord._ms); return { ok: true }; },
        });
        const a = runGeoApply(CITY('lisbon', 90), PROXY);
        const b = runGeckoApply(CITY('lisbon', 5), { ...PROXY, bypass: 'edited.test' });
        await Promise.all([a, b]);
        ok(seen.maxLive === 1, 'still never two children at once', 'peak ' + seen.maxLive);
        ok(seen.starts.map(s => s.job).join(',') === 'geo-apply,geo-gecko',
           'the bypass edit waits for the switch, and asks for the narrower job',
           seen.starts.map(s => s.job).join(','));
        ok(seen.starts[1].payload.proxy.bypass === 'edited.test',
           'and the edited list is the one that lands last');
        ok(seen.starts[1].payload.coord && seen.starts[1].payload.coord.city === 'lisbon',
           'the connected country goes WITH it -- the fenced block is rewritten whole, ' +
           'so a proxy-only call would delete the spoofed location');
    }

    console.log('\n── the call site really uses it ──');
    {
        const at = src.indexOf('await runGeoApply(coord, proxy);');
        ok(at > 0, 'applyGeolocationSpoof awaits runGeoApply(coord, proxy)');
        ok(src.indexOf('geo.applyAll(') < 0,
           'and nothing in main.js calls applyAll on the main thread outside that fallback',
           'still present at ' + src.indexOf('geo.applyAll('));
        //  Counted, not pinned at two. The set of geo jobs grew -- restore and
        //  startup moved off the pump after this file was written -- and a check
        //  that asserted "exactly 2" would have gone red for a change it was
        //  written to protect rather than forbid. What must stay true is one fork
        //  site per job, all of them inside the chained block.
        const jobs = [...src.matchAll(/runOffThread\('(geo-[a-z]+)'/g)].map(m => m[1]);
        const dupe = jobs.filter((j, i) => jobs.indexOf(j) !== i);
        ok(jobs.length > 0 && dupe.length === 0,
           'every geo job has exactly one place that forks it -- so nothing can ' +
           'bypass the queue', jobs.join(',') + (dupe.length ? '  DUPLICATED: ' + dupe : ''));
        const inBlock = [...text.matchAll(/runOffThread\('(geo-[a-z]+)'/g)].map(m => m[1]);
        ok(inBlock.length === jobs.length,
           'and all of them are inside the chained block, not somewhere that forks ' +
           'a geo child directly', inBlock.length + '/' + jobs.length);
        //  Each must be built on the shared chain, by name. Two `let` chains would
        //  look identical from the outside and serialise nothing.
        const hooks = (text.match(/_geoApplyChain\.then\(step, step\)/g) || []).length;
        ok(hooks === jobs.length && (text.match(/let _geoApplyChain/g) || []).length === 1,
           'and each hangs off the one chain variable, not a second one of its own',
           hooks + ' chain hook(s) for ' + jobs.length + ' job(s)');
        //  The descriptor is built where SOCKS_PORT and appState are in scope,
        //  and passed in. Read from a global it would be undefined -- the
        //  wrapper is at module scope, outside runAdminApp().
        ok(/applyGeolocationSpoof\(\s*\n?\s*mainWindow, finalCode,\s*\n?\s*\{ socksPort: SOCKS_PORT, bypass: appState\.bypassList \}\)/
           .test(src),
           'the connect path hands the wrapper the SOCKS port and the split-tunnel list');
        //  The country the handler passes, not the fact that it passes one. It
        //  used to be pinned as `GEO_COORDS[` literally, which broke the day the
        //  table stopped being indexed at the call site: geoCoord() is a checked
        //  accessor over that same table (it rejects a non-string, lower-cases,
        //  demands two letters, and uses hasOwnProperty so a country called
        //  'constructor' cannot resolve to a function). So the assertion asks
        //  for either shape and then asks the thing that actually matters -- the
        //  argument is the CONNECTED country, and it is not null.
        const gecko = src.match(/runGeckoApply\(\s*\n?\s*([^,]+),/);
        ok(!!gecko && /^(?:geoCoord\(|GEO_COORDS\[)/.test(gecko[1].trim()),
           'and the split-tunnel handler re-applies the Gecko half with the current country',
           gecko ? 'first argument is ' + gecko[1].trim() : 'no runGeckoApply call found');
        ok(!!gecko && /appState\.serverCode/.test(gecko[1]),
           'and that country is read from appState.serverCode, so the block it rewrites ' +
           'carries the country the user is connected under rather than a stale one',
           gecko ? gecko[1].trim() : '');
    }

    console.log(`\n${pass}/${pass + fail} checks passed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.log('ABORT: ' + e.stack); process.exit(3); });
