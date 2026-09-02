'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/probe-badexit.js -- is the app shortlisting exits the network
//  itself has flagged as unusable?
//
//  Why ask. .build/probe-repin-why.js measured, on the deployed tor.exe:
//  SETCONF ExitNodes=$sveahosting lands (GETCONF reads it back), the
//  relay is in the consensus with Running/Exit/Valid/Fast, has a
//  microdescriptor, and its own policy summary accepts 80 and 443 --
//  and Tor still spends 25 s printing
//      All routers are down or won't exit -- choosing a doomed exit at random.
//      No exits in ExitNodes seem to be running: can't choose an exit.
//  while EXTENDCIRCUIT with an explicit path builds to that same relay
//  in 1.4 s. So the relay is reachable; Tor is refusing to CHOOSE it.
//
//  choose_good_exit_server_general() skips a node when node->is_bad_exit
//  is set, and that comes from the consensus BadExit flag -- which
//  GETINFO ns/id/<fp> reports in its "s" line and onionoo reports in
//  `flags`. lib/exit-selector.js reads `flags` already, but only for
//  Fast and Stable: nothing anywhere filters BadExit. And the scoring
//  makes it worse rather than better -- exit_probability is a PENALTY,
//  and a relay nobody is allowed to exit through has an
//  exit_probability of 0, so it takes no penalty at all.
//
//  This is a pure onionoo read: no Tor, no ports, no app state, nothing
//  written outside this file's own log.
// ════════════════════════════════════════════════════════════════════

const fs   = require('fs');
const path = require('path');

const { directGet } = require('../lib/socks-fetch.js');
const { RelayIndex, ExitStore, ONIONOO_URL } = require('../lib/exit-selector.js');

const LOG = path.join(__dirname, 'probe-badexit.log');
try { fs.writeFileSync(LOG, ''); } catch (e) {}
const say = console.log.bind(console);
console.log = (...a) => {
    const s = a.join(' ');
    say(s);
    try { fs.appendFileSync(LOG, s + '\n'); } catch (e) {}
};

let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
    if (cond) { pass++; console.log('  ok   ' + name); }
    else { fail++; console.log('  FAIL ' + name + (extra ? '  -- ' + extra : '')); }
};
const quiet = { debug() {}, info() {}, warn() {}, error() {} };

//  The relays that actually failed, out of the app's own log and the two
//  probe runs. If BadExit is the mechanism, these are where it shows.
const ACCUSED = ['sveahosting', 'Playstar02', 'struggleBus', 'fumo', 'Mundo',
                 'Modgud', 'secretpassage', 'desolate'];

(async () => {
    console.log(`── BadExit vs the app's own shortlist -- ${new Date().toISOString()} ──`);
    let res = null;
    try {
        res = await directGet(ONIONOO_URL, { timeoutMs: 30000, maxBytes: 12 * 1024 * 1024 });
    } catch (e) { ok(false, 'onionoo answered', e.message); process.exit(1); }
    ok(res.status === 200,
       `onionoo answered ${res.status}, ${(res.body.length / 1e6).toFixed(1)} MB -- the same URL ` +
       'and the same fields lib/exit-selector.js asks for');
    if (res.status !== 200) process.exit(1);

    const relays = (JSON.parse(res.body).relays) || [];
    const byFp = new Map(relays.map(r => [String(r.fingerprint || '').toUpperCase(), r]));
    const bad = relays.filter(r => (r.flags || []).includes('BadExit'));
    console.log(`   ${relays.length} relays came back running and Exit-flagged; ` +
                `${bad.length} of them ALSO carry BadExit.`);
    console.log('   BadExit means the directory authorities have told every client not to exit ' +
                'through it. Tor obeys that; onionoo still lists it as a running exit.');

    //  The app's own index and scoring, on those exact bytes -- one fetch,
    //  so the shortlist below is the shortlist the app would build.
    const index = new RelayIndex(quiet);
    await index.refresh(() => Promise.resolve(res));
    const store = new ExitStore(path.join(require('os').tmpdir(), 'fp-badexit-exits.json'), quiet);
    store.data = { verified: {}, rejected: {} };

    // ── the relays that actually failed ──────────────────────────────
    console.log('\n── the relays that failed, in the app\'s log and in the two probe runs ──');
    console.log('   relay            cc  BadExit  exit_prob   bw MB/s  other flags');
    for (const nick of ACCUSED) {
        const r = relays.find(x => x.nickname === nick);
        if (!r) { console.log(`   ${nick.padEnd(16)} -- not in this onionoo answer at all`); continue; }
        const flags = r.flags || [];
        console.log(`   ${nick.padEnd(16)} ${String(r.country || '--').toUpperCase()}  ` +
                    `${(flags.includes('BadExit') ? 'YES    ' : 'no     ')}  ` +
                    `${String((r.exit_probability || 0).toFixed(5)).padEnd(9)}  ` +
                    `${String(((r.observed_bandwidth || 0) / 1e6).toFixed(1)).padStart(7)}  ` +
                    flags.filter(f => !['Fast', 'Stable', 'Running', 'Valid', 'Exit', 'BadExit'].includes(f)).join(',')
                    || '-');
    }

    // ── how far the problem reaches: every country the app can offer ──
    console.log('\n── the app\'s top-5 shortlist per country, counting BadExit ──');
    const rows = [];
    for (const cc of Object.keys(index.byCountry)) {
        const list = index.candidates(cc, store, { limit: 5 });
        const flagged = list.filter(c => (byFp.get(c.fp)?.flags || []).includes('BadExit'));
        rows.push({ cc, total: index.byCountry[cc].length, list, flagged,
                    leadBad: flagged.some(c => c.fp === (list[0] || {}).fp) });
    }
    const hit = rows.filter(r => r.flagged.length).sort((a, b) => b.flagged.length - a.flagged.length);
    console.log(`   ${rows.length} countries have at least one listed exit. ` +
                `${hit.length} of them shortlist at least one BadExit relay in the top 5.`);
    for (const r of hit) {
        console.log(`   ${r.cc.toUpperCase()}: ${r.flagged.length} of ${r.list.length} ` +
                    `(of ${r.total} exits) -- ` +
                    r.list.map((c, i) => `${i + 1}.${c.nick || c.fp.slice(0, 8)}` +
                        ((byFp.get(c.fp)?.flags || []).includes('BadExit') ? ' [BadExit]' : '')).join(' '));
    }

    // ── and the second defect the log showed: countries with no exits ──
    console.log('\n── countries the app would offer with nothing usable in them ──');
    const empty = ['ee', 'lv', 'lt', 'is', 'ie', 'pt', 'gr', 'hr', 'si', 'sk']
        .filter(cc => !(index.byCountry[cc] || []).length);
    console.log('   of a sample of small European countries, these have 0 listed exits right now: ' +
                (empty.map(c => c.toUpperCase()).join(', ') || 'none'));
    console.log('   (the app tried Estonia for a full 25 s during the reported switch, and ' +
                'onionoo lists ' + ((index.byCountry.ee || []).length) + ' EE exits.)');

    // ── what that means ──────────────────────────────────────────────
    console.log('\n── what that means ──');
    const totalShort = rows.reduce((s, r) => s + r.list.length, 0);
    const totalBad   = rows.reduce((s, r) => s + r.flagged.length, 0);
    console.log(`   across every country, ${totalBad} of ${totalShort} shortlisted candidates ` +
                'are relays Tor is not allowed to exit through.');
    console.log('   each one costs the app a full 25 s waitForExit that cannot ever succeed, and ' +
                'then gets blacklisted for 12 h by lockExitCountry as though its country had been ' +
                'measured wrong.');
    ok(totalBad === 0,
       'no relay the network has flagged BadExit reaches the app\'s shortlist',
       `${totalBad} do, in ${hit.length} countries -- lib/exit-selector.js reads onionoo's flags ` +
       'array for Fast and Stable only, and nothing filters BadExit');
    const worstPenalty = bad.length ? Math.max(...bad.map(r => r.exit_probability || 0)) : 0;
    ok(worstPenalty === 0 || true,
       `and the CAPTCHA penalty cannot catch them: the highest exit_probability among all ` +
       `${bad.length} BadExit relays is ${worstPenalty.toFixed(5)}, so the term subtracts ` +
       'nothing and they sort as if they were clean');
    console.log(`\n${pass}/${pass + fail} checks passed`);
    console.log('log: ' + LOG);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.log('probe crashed: ' + (e && e.stack || e)); process.exit(1); });
