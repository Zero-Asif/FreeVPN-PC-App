'use strict';
// ════════════════════════════════════════════════════════════════════
//  test-exit-persistence.js -- "ekta nodeo connect korte parchena"
//
//  The report: connected to USA, switched to Sweden, and the app could
//  not reach a single exit -- in a country whose relay list has 300+ of
//  them. Then "connect me to the nearest country" could not reach one
//  either, and "keep trying" ran for nine minutes without arriving.
//
//  The user's own log (2026-09-01, 12:19-12:46 local) says exactly why,
//  and it is three separate faults stacked on one path:
//
//   1. repinFor() asked the RUNNING tor to change its exit and, when tor
//      answered "No exits in ExitNodes seem to be running: can't choose
//      an exit", returned false. The engine restart underneath it -- the
//      one thing measured to work -- was only reachable when there was
//      no control port, and there was one. Same relay, same minute:
//      ferrarizGonzalez failed four consecutive 25 s waits on the live
//      process and connected 9 s after a fresh tor.exe was spawned with
//      it pinned in the torrc.
//
//   2. attemptCountry() pinned candidate 0 itself and returned
//      'unreachable' the moment that failed -- so every round of "keep
//      trying" tried ONE relay, and because nothing about it had been
//      measured it was never rejected, so it was the SAME relay every
//      round. Four identical "No circuit reached ferrarizGonzalez"
//      lines in the log are four whole rounds.
//
//   3. exitPlan() capped every attempt at 5 candidates, including the
//      rounds the user had explicitly asked to keep going.
//
//  This file drives the SHIPPED TEXT of exitPlan, lockExitCountry,
//  repinFor and attemptCountry -- lifted out of main.js, which cannot be
//  required outside Electron -- over fakes, and replays that scenario.
//
//  Nothing is executed against the machine: no tor is spawned, no
//  control port is opened, no network request is made. The relay index
//  and the reject store are the REAL classes from lib/exit-selector.js,
//  fed a synthetic onionoo body, so the exclusion really goes through
//  the shipped filter rather than a description of it.
// ════════════════════════════════════════════════════════════════════

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const { ExitStore, RelayIndex } = require('../lib/exit-selector.js');

const ROOT = path.join(__dirname, '..');
const src  = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (cond, what, detail = '') => {
    console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${what}${detail ? ' -- ' + detail : ''}`);
    cond ? pass++ : fail++;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── lift the real blocks, do not describe them ──────────────────────
function lift(from, to) {
    const a = src.indexOf(from);
    const b = a < 0 ? -1 : src.indexOf(to, a + from.length);
    if (a < 0 || b < 0) {
        console.log(`ABORT: main.js no longer contains ${JSON.stringify(from)} ` +
                    `followed by ${JSON.stringify(to)}`);
        process.exit(3);
    }
    return src.slice(a, b);
}
const TXT_PLAN  = lift('async function exitPlan(cc,', '//  Pin the exit, then CHECK IT');
const TXT_LOCK  = lift('async function lockExitCountry(cc,', '//  WHEN THE CHOSEN COUNTRY HAS NO EXIT');
const TXT_REPIN = lift('const noCircuit = new Set();', '//  Final enforcement sweep.');

// ── a relay list in the shape onionoo really sends ──────────────────
//  Descending bandwidth, no IPv6, each in its own /16 so one rejection
//  cannot take the next relay's netblock with it.
function onionoo(counts) {
    const relays = [];
    let n = 0;
    for (const [cc, howMany] of Object.entries(counts)) {
        for (let i = 0; i < howMany; i++, n++) {
            relays.push({
                fingerprint: (cc.toUpperCase() + String(i).padStart(2, '0'))
                                 .padEnd(40, 'F' + i.toString(16).toUpperCase()).slice(0, 40),
                nickname: `${cc}relay${i}`,
                country: cc,
                or_addresses: [`10.${n + 1}.0.${i + 1}:9001`],
                flags: ['Running', 'Valid', 'Exit', 'Fast', 'Stable'],
                observed_bandwidth: (500 - i) * 1e6,
                exit_probability: 0.001,
            });
        }
    }
    return { status: 200, body: JSON.stringify({ relays }) };
}

/**
 * Build the shipped functions over fakes.
 *
 *   live(cand)  -- does the RUNNING tor build a circuit to this relay?
 *   boot(spec)  -- does a restarted tor bootstrap with this ExitNodes?
 *   geo(pin)    -- what probeExitLocation() sees once `pin` is in force;
 *                  null means no source answered at all.
 */
function build({ counts = { se: 20 }, live = () => false, boot = () => true,
                 geo = () => null, bridges = false, verified = null } = {}) {
    const seen = { setConf: [], waited: [], forced: [], spawned: [], probes: [],
                   opened: 0, logs: [], progress: [] };
    const state = { pin: null };

    const Logger = {
        debug: (m, x) => seen.logs.push('debug ' + m), info: (m, x) => seen.logs.push('info ' + m),
        warn:  (m, x) => seen.logs.push('warn ' + m),  error: (m, x) => seen.logs.push('error ' + m),
        success: (m, x) => seen.logs.push('success ' + m),
    };

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-exitpers-'));
    const exitStore  = new ExitStore(path.join(dir, 'exits.json'), Logger);
    if (verified) exitStore.setVerified(verified.cc, verified);
    const relayIndex = new RelayIndex(Logger);
    const appState   = { connected: true };
    const refreshRelayIndex = async () => relayIndex.refresh(async () => onionoo(counts));

    //  The control port of a tor that is already running. waitForExit and
    //  forceExitCircuit are the two ways the app asks it to move, and `live`
    //  decides whether it obliges -- which is the whole question the log
    //  answered with "No exits in ExitNodes seem to be running".
    const ctl = {
        isOpen: true,
        harvestPathDonors: async () => 3,
        maxCircuitId: async () => 100,
        setConf: async c => { seen.setConf.push(c.ExitNodes); state.pin = c.ExitNodes; },
        purgeCircuitsExcept: async () => 0,
        newIdentity: async () => true,
        activeExits: async () => [],
        waitForExit: async (fp, o) => { seen.waited.push(fp); return live({ fp }); },
        forceExitCircuit: async (fp, o) => {
            seen.forced.push(fp);
            return live({ fp, forced: true })
                ? { ok: true, via: 'middleRelay', ms: 1414 }
                : { ok: false, reason: 'no built 3-hop circuit to borrow a path from' };
        },
    };

    const startTor = async ({ exitSpec, useBridges, dnsPort }) => {
        seen.spawned.push({ exitSpec, useBridges, dnsPort });
        //  A restart replaces the process, so the old control connection is dead
        //  -- exactly as killTor() leaves it, and whether or not the new one
        //  bootstraps.
        ctl.isOpen = false;
        if (!boot(exitSpec)) return { ok: false, reason: 'stall', percent: 80 };
        state.pin = exitSpec;
        return { ok: true, reason: 'ok', percent: 100 };
    };
    const openControl = async () => { seen.opened++; ctl.isOpen = true; return ctl; };

    const probeExitLocation = async () => {
        const answer = geo(state.pin);
        seen.probes.push({ pin: state.pin, answer });
        return answer;
    };
    const sendProgress = (p, m) => seen.progress.push(`${p} ${m}`);

    const exitPlan = new Function('exitStore', 'refreshRelayIndex', 'relayIndex',
        'appState', 'Logger', TXT_PLAN + '\n; return exitPlan;'
    )(exitStore, refreshRelayIndex, relayIndex, appState, Logger);

    const lockExitCountry = new Function('exitStore', 'probeExitLocation', 'SOCKS_PORT', 'Logger',
        TXT_LOCK + '\n; return lockExitCountry;'
    )(exitStore, probeExitLocation, 9050, Logger);

    const parts = new Function('ctl', 'lastNewnymAt', 'relayIndex', 'Logger', 'startTor',
        'activeDnsPort', 'usedBridges', 'sendProgress', 'openControl', 'exitPlan',
        'lockExitCountry',
        TXT_REPIN + '\n; return { repinFor, attemptCountry, noCircuit };'
    )(ctl, 0, relayIndex, Logger, startTor, 53, bridges, sendProgress, openControl,
      exitPlan, lockExitCountry);

    return { ...parts, exitPlan, lockExitCountry, seen, exitStore, relayIndex, dir };
}

//  The fingerprint onionoo() above generates for relay #i of a country.
//  Bandwidth descends with i, so candidate order is index order.
const FP = (cc, i) => (cc.toUpperCase() + String(i).padStart(2, '0'))
    .padEnd(40, 'F' + i.toString(16).toUpperCase()).slice(0, 40);

const dirs = [];
const mk = o => { const t = build(o); dirs.push(t.dir); return t; };

(async () => {
    console.log(`\n── how deep the app looks, and what it refuses to forget ` +
                `-- ${new Date().toISOString()} ──`);
    {
        const t = mk({ counts: { se: 20 } });
        const five = await t.exitPlan('se');
        ok(five.length === 5, 'a normal attempt takes the best 5 relays', String(five.length));
        const deep = await t.exitPlan('se', { limit: 12 });
        ok(deep.length === 12, 'and a round of "keep trying" can ask for more', String(deep.length));
        ok(deep[0].fp === five[0].fp, 'best-first order does not change with the depth');

        const ex = new Set([five[0].fp, five[1].fp]);
        const after = await t.exitPlan('se', { limit: 5, exclude: ex });
        ok(!after.some(c => ex.has(c.fp)),
           'a relay this connect has already proved unreachable is not offered again');
        ok(after.length === 5,
           'and the plan is refilled from further down the list, not shortened', String(after.length));
        ok(after[0].fp === five[2].fp, 'starting with the next best one');
    }

    {
        //  The other direction matters just as much: an exclusion that has
        //  emptied the country would turn "keep trying" into "stop trying".
        const t = mk({ counts: { se: 3 } });
        const all = await t.exitPlan('se', { limit: 5 });
        const ex  = new Set(all.map(c => c.fp));
        const again = await t.exitPlan('se', { limit: 5, exclude: ex });
        ok(again.length === 3, 'when the exclusion has emptied the country it is dropped, not obeyed',
           String(again.length));
        ok(ex.size === 0, 'the set is cleared, so the next round genuinely starts over');
        ok(t.seen.logs.some(l => /Re-trying 3 SE relay/.test(l)),
           'and the log says it is re-trying them rather than pretending they are new');
    }

    {
        const fp = FP('se', 0);
        const t = mk({ counts: { se: 3 }, verified: { cc: 'se', fp, nick: 'known' } });
        const p1 = await t.exitPlan('se');
        ok(p1[0].fp === fp && p1[0].cached === true,
           'a previously verified relay is still tried first');
        const p2 = await t.exitPlan('se', { exclude: new Set([fp]) });
        ok(p2[0].fp !== fp,
           'unless this connect has just failed to reach it -- then even the cached one is skipped');
    }

    // ════════════════════════════════════════════════════════════════
    //  THE REPORTED SCENARIO
    //  Connected to the USA, switched to Sweden. The running tor answers
    //  "No exits in ExitNodes seem to be running: can't choose an exit"
    //  to every relay it is handed -- live() is false for everything --
    //  but a tor STARTED with the fingerprint in its torrc comes up. Here
    //  the 4th Swedish relay is the one that geolocates to SE.
    // ════════════════════════════════════════════════════════════════
    console.log('\n── switching from a connected country, live re-pin refused ──');
    {
        const want = FP('se', 3);
        const t = mk({
            counts: { se: 6 }, live: () => false, boot: () => true,
            geo: pin => pin === '$' + want
                ? { cc: 'SE', ip: '185.154.110.142', votes: { SE: 5 }, answered: 4 }
                : { cc: 'AE', ip: '5.6.7.8',         votes: { AE: 5 }, answered: 4 },
        });
        const v = await t.attemptCountry('se', { limit: 6 });
        ok(v.verified && v.cc === 'SE',
           'the country IS reached even though the live engine refused every relay', String(v.reason));
        ok(v.fp === want,
           'and it is the 4th candidate -- the plan was walked, not abandoned at the 1st');
        ok(t.seen.spawned.length === 4, 'four engine restarts, one per candidate tried',
           String(t.seen.spawned.length));
        ok(t.seen.spawned.every((s, i) => s.exitSpec === '$' + FP('se', i)),
           'each restart pins that ONE relay by fingerprint, in plan order, never the {cc} set',
           t.seen.spawned.map(s => s.exitSpec.slice(0, 6)).join(','));
        ok(t.seen.spawned[3].exitSpec === '$' + want, 'the last of them is the relay that verified');
        ok(t.seen.waited.length === 1 && t.seen.forced.length === 1,
           'the running engine was asked once, then not asked again',
           `waited ${t.seen.waited.length}, forced ${t.seen.forced.length}`);
        ok(t.seen.logs.some(l => /restarting it with that relay pinned/.test(l)),
           'and the log says why it stopped talking to it');
        ok(t.seen.opened === 4, 'a fresh control connection is opened after each restart',
           String(t.seen.opened));
    }

    {
        //  The same refusal, but the initial connect: candidate 0 is the relay
        //  tor was STARTED on, so it must not be re-pinned or restarted at all.
        const t = mk({ counts: { se: 3 }, live: () => false, boot: () => true,
                       geo: () => ({ cc: 'SE', ip: '1.2.3.4', votes: { SE: 5 }, answered: 4 }) });
        const plan = await t.exitPlan('se');
        const v = await t.lockExitCountry('se', plan, { repin: t.repinFor('se') });
        ok(v.verified && v.fp === FP('se', 0), 'the first connect verifies candidate 0 in place');
        ok(t.seen.spawned.length === 0 && t.seen.setConf.length === 0,
           'without restarting or re-configuring anything -- the healthy path is untouched',
           `${t.seen.spawned.length} restarts, ${t.seen.setConf.length} setconf`);
    }

    console.log('\n── when the running engine DOES oblige, nothing is restarted ──');
    {
        const want = FP('se', 2);
        const t = mk({
            counts: { se: 5 }, live: () => true, boot: () => true,
            geo: pin => pin === '$' + want
                ? { cc: 'SE', ip: '45.83.104.137', votes: { SE: 5 }, answered: 4 }
                : { cc: 'AE', ip: '5.6.7.8',       votes: { AE: 5 }, answered: 4 },
        });
        const v = await t.attemptCountry('se', { limit: 5 });
        ok(v.verified && v.fp === want, 'the third candidate verifies over the control port');
        ok(t.seen.spawned.length === 0,
           'and the engine is never restarted -- a working switch stays seconds, not a bootstrap',
           String(t.seen.spawned.length));
        ok(t.seen.setConf.length === 3, 'three SETCONF re-pins instead', String(t.seen.setConf.length));
        ok(t.seen.setConf[0] === '$' + FP('se', 0),
           'starting with candidate 0, which repinFirst now pins itself');
    }

    console.log('\n── a bridged connection must not lose the tunnel to a switch ──');
    {
        const t = mk({ counts: { se: 2 }, live: () => false, boot: () => true, bridges: true,
                       geo: () => ({ cc: 'SE', ip: '1.1.1.1', votes: { SE: 5 }, answered: 4 }) });
        const v = await t.attemptCountry('se', { limit: 2 });
        ok(v.verified, 'an obfs4 user can still change country');
        ok(t.seen.spawned.length === 1, 'one restart', String(t.seen.spawned.length));
        ok(t.seen.spawned.every(s => s.useBridges === true),
           'and it keeps bridges -- a censored network would otherwise never bootstrap again');
        ok(t.seen.spawned.every(s => s.dnsPort === 53),
           'on the DNS port already negotiated, so the resolver keeps working');
    }

    console.log('\n── what the caller is told when it does not work ──');
    {
        const t = mk({ counts: { se: 3 }, live: () => false, boot: () => false, geo: () => null });
        const v = await t.attemptCountry('se', { limit: 3 });
        ok(!v.verified && v.reason === 'unreachable',
           'no circuit to any candidate is reported as unreachable, not as unverified-but-connected',
           String(v.reason));
        ok(t.seen.probes.length === 0,
           'and not one geolocation probe was spent pretending otherwise');
        ok(t.noCircuit.size === 3, 'all three are remembered as unreachable for this connect',
           String(t.noCircuit.size));
    }

    {
        const t = mk({ counts: { se: 3 }, live: () => true, boot: () => true, geo: () => null });
        const v = await t.attemptCountry('se', { limit: 3 });
        ok(!v.verified && v.reason === 'no-answer',
           'a circuit that stands but cannot be geolocated is a different failure, and says so',
           String(v.reason));
        ok(t.seen.probes.length === 3, 'every candidate was probed', String(t.seen.probes.length));
        ok(t.noCircuit.size === 0,
           'and none of them is written off -- the transport worked, the check did not');
    }

    {
        const t = mk({ counts: { se: 3 }, live: () => true, boot: () => true,
                       geo: () => ({ cc: 'AE', ip: '9.9.9.9', votes: { AE: 5 }, answered: 4 }) });
        const v = await t.attemptCountry('se', { limit: 3 });
        ok(!v.verified && v.reason === 'exhausted',
           'relays that answer from the wrong country exhaust the plan', String(v.reason));
        ok(v.lastSeen && v.lastSeen.cc === 'AE', 'and it reports where the traffic really came out');
        ok(v.pinnedFp === FP('se', 2), 'with the fingerprint still pinned, so the caller can sweep it');
    }

    console.log('\n── "keep trying" cannot try the same relay round after round ──');
    {
        //  Four identical "No circuit reached ferrarizGonzalez" lines in the
        //  user's log are four whole rounds that each tried one relay -- the
        //  same one, because nothing about it had been measured and so nothing
        //  excluded it.
        const t = mk({ counts: { se: 8 }, live: () => false, boot: () => false, geo: () => null });
        await t.attemptCountry('se', { limit: 3 });
        const round1 = t.seen.spawned.map(s => s.exitSpec);
        await t.attemptCountry('se', { limit: 3 });
        const round2 = t.seen.spawned.map(s => s.exitSpec).slice(3);
        ok(round1.length === 3, 'round 1 is a whole pass over the plan', String(round1.length));
        ok(round2.length === 3, 'so is round 2', String(round2.length));
        ok(!round2.some(h => round1.includes(h)),
           'and round 2 reaches relays round 1 never touched',
           round1.map(s => s.slice(0, 5)).join(',') + ' then ' + round2.map(s => s.slice(0, 5)).join(','));
        ok(t.noCircuit.size === 6, 'six relays ruled out after two rounds', String(t.noCircuit.size));
    }

    // ── guards on the shipped file, so the fix cannot be undone quietly ──
    console.log('\n── what main.js must keep saying ──');
    {
        const esc = src.indexOf('No circuit reached');
        ok(esc > 0 && /livePinBroken = true;\s*\n\s*restart = true;/
                        .test(src.slice(esc, esc + 900)),
           'a relay the running engine refuses escalates to a restart, not to `return false`');
        ok(/repin: repinFor\(target\), repinFirst: true/.test(src),
           'attemptCountry re-pins candidate 0 itself, so a country attempt is the whole plan');
        ok(/exitPlan\(target, \{ limit, exclude: noCircuit \}\)/.test(src),
           'and it excludes the relays this connect already failed to reach');
        ok(/attemptCountry\(cc, \{ limit: KEEP_TRYING_DEPTH \}\)/.test(src),
           '"keep trying" asks for KEEP_TRYING_DEPTH candidates, not the default 5');
        ok(/const KEEP_TRYING_DEPTH\s*=\s*(\d+);/.test(src) &&
           Number(/const KEEP_TRYING_DEPTH\s*=\s*(\d+);/.exec(src)[1]) >= 12,
           'which is at least 12', /const KEEP_TRYING_DEPTH\s*=\s*(\d+);/.exec(src)?.[1]);
        ok(/exitSpec: spec, dnsPort: activeDnsPort, useBridges: usedBridges/.test(src),
           'the re-pin restart carries bridge mode and the negotiated DNS port');
        ok(src.indexOf('const noCircuit = new Set();') < src.indexOf('exclude: noCircuit'),
           'noCircuit is declared before it is referenced -- the pre-Tor plans cannot hit a TDZ');
        ok((src.match(/await startTor\(\{/g) || []).length === 4,
           'startTor still has exactly four call sites: first try, DNS retry, bridges, re-pin',
           String((src.match(/await startTor\(\{/g) || []).length));
        ok(/reason: answers \? 'exhausted' : \(probed \? 'no-answer' : 'unreachable'\)/.test(src),
           'and the three failures are still told apart');
    }

    for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} }

    console.log(`\n── ${pass} passed, ${fail} failed ──`);
    if (fail) {
        console.log('\nThe exit-persistence fix is NOT intact. Do not ship this build.');
    } else {
        console.log('\nA country with listed exits is now walked to the end of its plan, on a\n' +
                    'restarted engine when the running one refuses, with the relays that could\n' +
                    'not be reached kept out of the next round -- and the working path unchanged.');
    }
    process.exit(fail ? 1 : 0);
})().catch(e => { console.log('\nTHREW: ' + e.stack); process.exit(2); });
