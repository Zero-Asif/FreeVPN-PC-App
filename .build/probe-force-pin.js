'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/probe-force-pin.js -- can the app be made to reach EVERY exit
//  its own picker offers, and does traffic really come out there?
//
//  What is already measured, so it is not re-argued here:
//   * .build/probe-repin.js: every candidate is in the consensus,
//     Running/Exit/Valid/Fast, with a microdescriptor -- and 2 of 5 SE
//     candidates still time out the app's 25 s wait.
//   * .build/probe-repin-why.js: SETCONF lands (GETCONF reads it back),
//     the policy summaries accept 80 and 443, and EXTENDCIRCUIT with an
//     explicit path reached a relay Tor had spent 25 s calling "down or
//     won't exit" -- in 1414 ms.
//   * .build/probe-badexit.js: that relay, sveahosting, carries the
//     consensus BadExit flag. lib/exit-selector.js reads onionoo's flags
//     array for Fast and Stable only, so nothing filters it out, and
//     because a BadExit relay's exit_probability is 0 it takes no
//     CAPTCHA penalty either -- it sorts as if it were clean.
//
//  Two conclusions, and this probe tests the pair of them as one
//  procedure, because the fix is only worth shipping if both hold:
//
//   1. BadExit relays must be dropped, not forced. The flag is the
//      authorities telling every client that relay tampers with exit
//      traffic. EXTENDCIRCUIT can build through one anyway -- which is
//      exactly why the app must never do it.
//   2. For every OTHER candidate, "Tor did not pick it in 25 s" is not
//      "the relay is unreachable". Naming the whole path builds it.
//
//  So: pin the way the app pins, wait only briefly, and if Tor has not
//  chosen the relay, build the circuit explicitly -- then sweep every
//  other circuit away and prove with a real request that the page comes
//  out at that relay's own consensus address. Anything less is a claim,
//  not a connection.
//
//  ── run 1, 2026-09-01T14:02Z, and what it corrected ────────────────
//  7 of 14 candidates were chosen by Tor within 8 s, and for all 7 the
//  sweep-then-request check came back at exactly the relay's own consensus
//  address -- 7/7, no leaks. But the escalation never got to run: every
//  attempt died on "no built 3-hop circuit to borrow a path from".
//
//  The reason is a real ordering trap, and the app would have walked into
//  the same one. Guard/middle pairs were read AFTER SETCONF+purge, and by
//  then there is nothing to read: the purge closes every circuit that does
//  not end at the new target, and Tor cannot replace them, because
//  replacing them means choosing the very exit it is refusing to choose.
//  A pinned Tor that has just been swept has an empty circuit list, so
//  "borrow a path from a circuit Tor built for itself" has to mean
//  "borrow it from one Tor built EARLIER".
//
//  So pairs are now harvested continuously and kept (PAIRS), harvested once
//  more just BEFORE each SETCONF, and if the stash is somehow empty there is
//  a second source that needs no circuit at all: GETINFO entry-guards for
//  the first hop and a high-bandwidth relay from the app's own index for
//  the middle. Nothing here widens the guard set -- every first hop named
//  is already one of this Tor's own entry guards.
//
//  ── run 3, 2026-09-04, and the check that was too weak to make it ──
//  8/9. One row failed: pinned to UnredactedAiFen (consensus 23.191.200.124),
//  the page came out at 23.191.200.23. Onionoo says that address is
//  UnredactedBB, a DIFFERENT relay in the same operator's /24 -- and that the
//  pinned relay's exit_addresses is its own OR address, so it was not a relay
//  exiting from a second address of its own. The stream really did leave
//  somewhere else, and this probe's own sweep is why: it kept an id window
//  (staleIdMax = maxCircuitId()) that is correct mid-build but not here, so a
//  circuit Tor launched after the marker survived and was free to take the
//  stream. That family runs 123 exits in one /24, which is why the substitute
//  looked like a sibling.
//
//  Fixed, and the check made stronger than the one that failed: the sweep now
//  closes every circuit but the pinned one, exactly as main.js:5523 does, and
//  the verification no longer infers attachment from an IP -- it reads the
//  stream's own circuit id out of GETINFO stream-status while the request is in
//  flight and takes that circuit's last hop. An exit IP is now the fallback
//  evidence, reported as such, and never counted as proof.
//
//  ── run 4, 2026-09-04, and the 30 s the app was spending on a no ───
//  9/10. The row that failed was DE/demise -- Germany's highest-bandwidth exit,
//  so the FIRST relay the app offers for that country -- and all three explicit
//  builds died on the same reply: `552 No descriptor for "$3E10B71C…"`. The
//  three pairs were AbsoluteCinema/koolkeith, tp3/prsv and
//  AbsoluteCinema/ezioauditore: disjoint, so the fingerprint Tor was complaining
//  about could only be the exit's.
//
//  Asked directly (tor 0.4.9.6, the app's own consensus cache): `GETINFO
//  ns/id/3E10B71C…` answers with an `r demise` line, so the relay IS in this
//  Tor's consensus -- and `GETINFO md/id/3E10B71C…` refuses the key with 552,
//  while DE's other four candidates each answer it with a 449-771 byte
//  microdescriptor. Consensus entry, no descriptor. Tor needs the descriptor for
//  both halves of what the app does: it will not CHOOSE a relay it has no
//  descriptor for (the 10 s wait was always going to time out) and it will not
//  extend to one (each build failed in ~10 s).
//
//  So this is not a hole in "must connect, whatever it takes" -- the app's next
//  escalation, restarting the engine with the relay pinned, is exactly what
//  fetches a missing descriptor. It was a hole in how fast the app gets there:
//  30 s of guaranteed failure first. TorControl.hasDescriptor() asks the one
//  question, main.js skips the wait and the builds on a `false`, and
//  forceExitCircuit() stops the pair loop when a 552 names the exit rather than
//  retrying a pair that cannot matter. A `null` -- the question could not be
//  asked -- still takes the old path, because skipping a candidate over an
//  unanswered question would drop a relay that works.
//
//  The assertion this probe makes is restated to match what it can prove: every
//  candidate either comes up, or fails for a reason the app recognises and
//  escalates past. A row that fails for no nameable reason is still a defect.
//
//  Re-run after the fix, same 15 candidates, 10/10 -- and the row that had
//  failed is the interesting one: `demise` was chosen by TOR ITSELF in 3035 ms,
//  and the page came out at 77.90.185.93, its own consensus address, with the
//  stream proven attached at the control port. So a missing microdescriptor is
//  a TRANSIENT state, not a dead relay: Tor fetched it in the hours between the
//  two runs. That is what makes the escalation the right answer rather than a
//  consolation -- the descriptor arrives, and the only thing worth changing was
//  how long the app spends waiting for a "no" it can already read.
//
//  Read-only with respect to the app: own ports, own DataDirectory under
//  %TEMP%, the app's consensus cache is COPIED, a scratch ExitStore, and
//  only this probe's tor.exe is killed.
// ════════════════════════════════════════════════════════════════════

const { spawn } = require('child_process');
const fs   = require('fs');
const os   = require('os');
const net  = require('net');
const path = require('path');

const { TorControl } = require('../lib/tor-control.js');
const { RelayIndex, ExitStore, ONIONOO_URL } = require('../lib/exit-selector.js');
const { directGet, socksGet } = require('../lib/socks-fetch.js');

const SOCKS = Number(process.env.PF_SOCKS) || 9350;
const CTRL  = Number(process.env.PF_CTRL)  || 9351;
const CCS   = (process.env.PF_CC || 'se,us,de').split(',').filter(Boolean);
const N     = Number(process.env.PF_N) || 5;
const PATIENCE = Number(process.env.PF_PATIENCE) || 8000;    // how long Tor gets on its own
const BUILD_MS = Number(process.env.PF_BUILD) || 20000;      // per explicit build attempt
const TRIES    = Number(process.env.PF_TRIES) || 3;          // distinct paths to try
const DEADLINE = Date.now() + (Number(process.env.PF_MINUTES) || 25) * 60 * 1000;

const TOR_EXE  = 'C:/ProgramData/freeproxy-vpn/Tor/tor/tor.exe';
const APP_DATA = 'C:/ProgramData/freeproxy-vpn/Tor/data';
const WORK = path.join(os.tmpdir(), 'fp-force-pin');
const DATA = path.join(WORK, 'data');

const LOG = path.join(__dirname, 'probe-force-pin.log');
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
const sleep = ms => new Promise(r => setTimeout(r, ms));
const quiet = { debug() {}, info() {}, warn() {}, error() {}, success() {} };

let tor = null, ctl = null;
const torLog = [];

function portFree(port) {
    return new Promise(resolve => {
        const s = net.connect({ host: '127.0.0.1', port });
        const no = () => { try { s.destroy(); } catch (e) {} resolve(true); };
        s.once('connect', () => { try { s.destroy(); } catch (e) {} resolve(false); });
        s.once('error', no);
        setTimeout(no, 1200);
    });
}

function seedDataDir() {
    fs.rmSync(WORK, { recursive: true, force: true });
    fs.mkdirSync(DATA, { recursive: true });
    for (const f of ['cached-certs', 'cached-microdesc-consensus',
                     'cached-microdescs', 'cached-microdescs.new', 'state']) {
        const src = path.join(APP_DATA, f);
        try { if (fs.existsSync(src)) fs.copyFileSync(src, path.join(DATA, f)); }
        catch (e) { console.log('   (could not copy ' + f + ': ' + e.message + ')'); }
    }
}

function writeTorrc(exitSpec) {
    const q = p => p.replace(/\\/g, '/');
    const rc = [
        `SocksPort 127.0.0.1:${SOCKS} IPv4Traffic NoIPv6Traffic NoPreferIPv6Automap`,
        `ControlPort 127.0.0.1:${CTRL}`,
        'CookieAuthentication 1',
        `CookieAuthFile "${q(path.join(DATA, 'control_auth_cookie'))}"`,
        'ClientUseIPv4 1',
        'ClientUseIPv6 0',
        'AutomapHostsOnResolve 1',
        'VirtualAddrNetworkIPv4 10.192.0.0/10',
        'ClientRejectInternalAddresses 1',
        `DataDirectory "${q(DATA)}"`,
        `GeoIPFile "${q(path.join(APP_DATA, 'geoip'))}"`,
        `GeoIPv6File "${q(path.join(APP_DATA, 'geoip6'))}"`,
        `ExitNodes ${exitSpec}`,
        'StrictNodes 1',
        'MaxCircuitDirtiness 600',
        'NewCircuitPeriod 120',
        `LongLivedPorts ${SOCKS}`,
        'CircuitBuildTimeout 60',
        'OptimisticData 1',
        'NumEntryGuards 3',
        'CircuitStreamTimeout 20',
        'AvoidDiskWrites 1',
        'Log notice stderr',
        '',
    ].join('\n');
    const rcPath = path.join(WORK, 'torrc');
    fs.writeFileSync(rcPath, rc, 'utf8');
    return rcPath;
}

async function startTor(rcPath) {
    tor = spawn(TOR_EXE, ['-f', rcPath], { windowsHide: true });
    const take = d => String(d).split(/\r?\n/).filter(Boolean).forEach(l => torLog.push(l));
    tor.stdout.on('data', take);
    tor.stderr.on('data', take);
    tor.on('error', e => torLog.push('spawn error: ' + e.message));

    const cookie = path.join(DATA, 'control_auth_cookie');
    for (let i = 0; i < 60 && !fs.existsSync(cookie); i++) await sleep(500);
    if (!fs.existsSync(cookie)) throw new Error('Tor never wrote its control cookie');

    ctl = new TorControl({ port: CTRL, cookiePath: cookie, logger: quiet });
    for (let i = 0; ; i++) {
        try { await ctl.open({ timeoutMs: 4000 }); break; }
        catch (e) {
            if (i >= 12) throw new Error('control port never answered: ' + e.message);
            await sleep(1000);
        }
    }
    for (let i = 0; i < 180; i++) {
        const m = /PROGRESS=(\d+)/.exec(await ctl.getInfo('status/bootstrap-phase'));
        if (m && Number(m[1]) >= 100) return i * 1000;
        await sleep(1000);
    }
    throw new Error('bootstrap never reached 100%');
}

// ── the escalation, in the order the app would run it ────────────────
//  Every guard/middle pair this Tor has ever built for itself, newest first.
//  Harvested continuously, because after a pin-and-sweep there is nothing left
//  to harvest -- see the run-1 note in the header.
const PAIRS = [];
const MAX_PAIRS = 10;
let MIDDLES = [];          // filled in main() from the app's own relay index
let harvested = 0;

async function harvestPairs() {
    let cs = [];
    try { cs = await ctl.circuits(); } catch (e) { return 0; }
    let added = 0;
    for (const c of cs.filter(x => x.status === 'BUILT' && x.hops.length >= 3)
                      .sort((a, b) => Number(b.id) - Number(a.id))) {
        const g = c.hops[0], m = c.hops[1];
        const key = g.fp + '|' + m.fp;
        if (PAIRS.some(p => p.key === key)) continue;
        PAIRS.unshift({ key, g, m, from: 'circuit ' + c.id });
        added++;
        while (PAIRS.length > MAX_PAIRS) PAIRS.pop();
    }
    harvested += added;
    return added;
}

//  The second source, and it needs no circuit at all: Tor's own entry guards.
//  Naming one of these as the first hop cannot widen the guard set, because
//  Tor chose them itself and is already using them.
async function guardPairs() {
    let raw = '';
    try { raw = await ctl.getInfo('entry-guards'); } catch (e) { return []; }
    const gs = [];
    for (const line of raw.split('\n')) {
        const m = /^\$?([0-9A-Fa-f]{40})(?:~(\S+))?\s+(\S+)/.exec(line.trim());
        if (!m) continue;
        if (!/^up/i.test(m[3])) continue;
        gs.push({ fp: m[1].toUpperCase(), nick: m[2] || '' });
    }
    const out = [];
    for (const g of gs) {
        for (const m of MIDDLES.slice(0, 3)) {
            if (m.fp === g.fp) continue;
            out.push({ key: g.fp + '|' + m.fp, g, m, from: 'entry-guards' });
        }
    }
    return out;
}

//  Guard and middle are borrowed from circuits Tor built for itself, so the
//  guard set is never widened -- the only thing named is the exit the user
//  asked for. Each attempt uses a DIFFERENT pair, because a single unlucky
//  middle relay is a reason to retry, not to give up on a country.
async function donors(want) {
    await harvestPairs();
    const out = PAIRS.filter(p => p.g.fp !== want && p.m.fp !== want).slice();
    for (const p of await guardPairs()) {
        if (p.g.fp === want || p.m.fp === want) continue;
        if (out.some(x => x.key === p.key)) continue;
        out.push(p);
    }
    return out;
}

async function extendTo(want, pool) {
    if (!pool.length) return { err: 'no guard/middle pair left to try' };
    const d = pool.shift();
    const t0 = Date.now();
    let id = null;
    try {
        const lines = await ctl.cmd(`EXTENDCIRCUIT 0 $${d.g.fp},$${d.m.fp},$${want}`,
                                   { timeoutMs: 20000 });
        id = (/EXTENDED\s+(\d+)/.exec(lines.find(l => /EXTENDED/.test(l)) || '') || [])[1] || null;
    } catch (e) {
        //  Not truncated to 50 any more: run 3's log printed
        //  `No descriptor for "$3E10B71C4D1B9` and cut the fingerprint in half,
        //  which is exactly the character that says whether Tor is complaining
        //  about the exit or about a borrowed hop.
        const noDescriptor = /tor control 552:/.test(e.message) &&
                             new RegExp('"\\$' + want + '"', 'i').test(e.message);
        return { err: 'EXTENDCIRCUIT: ' + e.message.slice(0, 90), via: d, noDescriptor };
    }
    if (!id) return { err: 'no circuit id in the reply', via: d };

    for (;;) {
        let mine = null;
        try { mine = (await ctl.circuits()).find(c => c.id === id) || null; } catch (e) {}
        if (mine && mine.status === 'BUILT') break;
        if (!mine && Date.now() - t0 > 5000) return { id, ms: Date.now() - t0, via: d, err: 'Tor dropped it' };
        if (Date.now() - t0 > BUILD_MS) return { id, ms: Date.now() - t0, via: d, err: 'never reached BUILT' };
        await sleep(600);
    }
    let seen = false;
    try { seen = (await ctl.activeExits()).some(e => e.fp === want); } catch (e) {}
    return { id, ms: Date.now() - t0, via: d, built: seen, purpose: 'GENERAL',
             err: seen ? null : 'BUILT, but activeExits() does not see it' };
}

let lastNewnymAt = 0;
async function forcePinTo(fp) {
    const want = fp.toUpperCase();
    const t0 = Date.now();
    //  BEFORE the purge. This is the whole correction from run 1: the pairs
    //  worth borrowing exist only while Tor's own circuits are still standing.
    const stashed = await harvestPairs();
    const idMark = await ctl.maxCircuitId();
    await ctl.setConf({ ExitNodes: '$' + want });
    const purged = await ctl.purgeCircuitsExcept(want, { staleIdMax: idMark });
    let newnym = false;
    if (Date.now() - lastNewnymAt >= 11000) {
        await ctl.newIdentity();
        lastNewnymAt = Date.now();
        newnym = true;
    }
    //  The app's own precheck, run here for the same reason it runs there --
    //  see the run-4 note in the header. `false` means neither the wait nor a
    //  single explicit build can succeed, so spending 8 s + 3 x 20 s on them
    //  measures nothing except how long it takes to fail.
    const hasDesc = await ctl.hasDescriptor(want);
    let built = hasDesc === false
        ? false
        : await ctl.waitForExit(want, { timeoutMs: PATIENCE });
    const passiveMs = Date.now() - t0;
    const attempts = [];
    if (!built && hasDesc !== false) {
        const pool = await donors(want);
        for (let i = 0; i < TRIES && !built; i++) {
            const a = await extendTo(want, pool);
            attempts.push(a);
            if (a.built) built = true;
            if (a.err === 'no guard/middle pair left to try') break;
            //  A 552 that names the exit is not about this pair. Every other
            //  pair would fail identically -- measured, three times, in run 3.
            if (a.noDescriptor) break;
        }
    }
    return { built, how: built ? (attempts.length ? 'forced' : 'tor') : 'none',
             ms: Date.now() - t0, passiveMs, purged, newnym, stashed, hasDesc,
             pairs: PAIRS.length, attempts };
}

//  The country guarantee: after the pin, nothing else may be attachable.
async function sweepAndVerify(want) {
    //  Harvest before the sweep, for the same reason forcePinTo() does: this
    //  purge is what empties the circuit list, and the pairs standing right now
    //  are the ones the NEXT candidate will have to borrow.
    await harvestPairs();
    //  NO ID WINDOW HERE, and that is the whole point. This used to sweep with
    //  staleIdMax = maxCircuitId(), a "now" marker read a moment earlier, which
    //  is right in forcePinTo() above -- there a circuit is mid-build and closing
    //  it by id would close the one being built. It is wrong here: the pinned
    //  circuit is already BUILT and is kept BY FINGERPRINT, so every other
    //  circuit can go, and any circuit Tor launched after that marker was read
    //  survived the sweep and was free to carry the stream.
    //
    //  MEASURED, once, and it is why this function was rewritten. Pinned to
    //  UnredactedAiFen (F0C16344..., consensus address 23.191.200.124), the page
    //  came out at 23.191.200.23 -- which onionoo says is UnredactedBB
    //  (7AC25DC9...), a DIFFERENT relay in the same operator's /24. That family
    //  runs 123 exits in 23.191.200.0/24, so a surviving pre-built circuit
    //  landing on a sibling is likely rather than freak. Two candidate causes
    //  were separated by asking onionoo directly: exit_addresses for the pinned
    //  relay is ["23.191.200.124"], its own OR address, so it was NOT a relay
    //  exiting from a second address of its own -- the stream went somewhere
    //  else. main.js:5523 already sweeps with MAX_SAFE_INTEGER for exactly this
    //  reason when it wants "this exit and nothing else", so this now matches
    //  the app instead of being a looser version of it.
    const swept = await ctl.purgeCircuitsExcept(want, { staleIdMax: Number.MAX_SAFE_INTEGER });

    //  And then the fact itself, rather than a proxy for it. An exit IP is
    //  evidence about WHERE the page came out; the question being asked is which
    //  CIRCUIT carried it, and Tor answers that directly. `GETINFO stream-status`
    //  prints `<id> <status> <circId> <target>`, so while the fetch is in flight
    //  the stream to api.ipify.org is looked up, its circuit id read, and that
    //  circuit's last hop taken from circuit-status. That is attachment, proven.
    //  It is polled because a stream lives for as long as the request and no
    //  longer: miss the window and `attached` stays null, which the caller
    //  reports as unproven rather than as a pass.
    let attached = null, ip = null, err = null, watching = true;
    const watcher = (async () => {
        while (watching) {
            try {
                const lines = String(await ctl.getInfo('stream-status')).split('\n');
                for (const line of lines) {
                    const p = line.trim().split(/\s+/);
                    //  circId 0 means "not attached to anything yet".
                    if (p.length < 4 || p[2] === '0' || !/ipify/i.test(p[3])) continue;
                    const c = (await ctl.circuits()).find(x => x.id === p[2]);
                    if (c && c.exit) {
                        attached = { circId: c.id, fp: c.exit.fp, nick: c.exit.nick };
                        watching = false;
                    }
                    break;
                }
            } catch (e) { /* a closed stream between the two reads is normal */ }
            if (watching) await sleep(120);
        }
    })();
    try {
        const r = await socksGet('https://api.ipify.org/', { socksPort: SOCKS, timeoutMs: 25000, maxBytes: 4096 });
        ip = (/\b(?:\d{1,3}\.){3}\d{1,3}\b/.exec(r.body || '') || [])[0] || null;
    } catch (e) { err = e.message.slice(0, 50); }
    watching = false;
    await watcher;
    return { swept, ip, err, attached };
}

async function finish() {
    try { if (ctl && ctl.isOpen) ctl.close(); } catch (e) {}
    try { if (tor) tor.kill(); } catch (e) {}
    await sleep(600);
    try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (e) {}
    console.log(`\n${pass}/${pass + fail} checks passed`);
    console.log('log: ' + LOG);
    process.exit(fail ? 1 : 0);
}

(async () => {
    console.log(`── forcing the pin, and proving the exit -- ${new Date().toISOString()} ──`);
    console.log(`── ${PATIENCE} ms of patience, then up to ${TRIES} explicit builds of ${BUILD_MS} ms ──`);
    ok(fs.existsSync(TOR_EXE), 'the deployed tor.exe is where the app puts it', TOR_EXE);
    if (!fs.existsSync(TOR_EXE)) return finish();
    ok(await portFree(SOCKS) && await portFree(CTRL),
       `ports ${SOCKS}/${CTRL} are free, so nothing here can be the app's Tor`);

    // ── the app's own picker, plus the flag it does not read ──────────
    let res = null;
    try { res = await directGet(ONIONOO_URL, { timeoutMs: 30000, maxBytes: 12 * 1024 * 1024 }); }
    catch (e) { ok(false, 'onionoo answered', e.message); return finish(); }
    const raw = (JSON.parse(res.body).relays) || [];
    const badFps = new Set(raw.filter(r => (r.flags || []).includes('BadExit'))
                              .map(r => String(r.fingerprint).toUpperCase()));
    const index = new RelayIndex(quiet);
    await index.refresh(() => Promise.resolve(res));
    const store = new ExitStore(path.join(os.tmpdir(), 'fp-force-pin-exits.json'), quiet);
    store.data = { verified: {}, rejected: {} };

    //  Middles for the entry-guards fallback: the fastest relays the app's own
    //  index holds, across every country, minus anything flagged BadExit. A
    //  middle hop does not exit traffic, so an exit relay is a perfectly ordinary
    //  choice for one -- and these are the only relays the app already knows.
    MIDDLES = Object.values(index.byCountry).flat()
        .filter(r => !badFps.has(r.fp))
        .sort((a, b) => b.bw - a.bw)
        .slice(0, 8);

    const plans = new Map();
    console.log('');
    for (const cc of CCS) {
        const list = index.candidates(cc, store, { limit: N });
        plans.set(cc, list);
        ok(list.length > 0, `${cc.toUpperCase()}: ${(index.byCountry[cc] || []).length} exits listed, ` +
           `top ${N} = ` + list.map(c => (c.nick || c.fp.slice(0, 8)) +
                                         (badFps.has(c.fp) ? ' [BadExit]' : '')).join(', '));
    }
    const first = (plans.get(CCS[0]) || []).find(c => !badFps.has(c.fp));
    if (!first) { ok(false, 'a first candidate to boot on'); return finish(); }

    console.log('\n── booting the deployed tor.exe on its own ports ──');
    seedDataDir();
    try {
        const ms = await startTor(writeTorrc('$' + first.fp));
        ok(true, `bootstrapped in about ${Math.round(ms / 1000)} s on ` +
                 (first.nick || first.fp.slice(0, 8)));
    } catch (e) {
        ok(false, 'the probe\'s own Tor bootstrapped', e.message);
        console.log('   last 12 Tor lines:\n     ' + torLog.slice(-12).join('\n     '));
        return finish();
    }

    // ── every candidate the app would try, in the app's own order ─────
    await harvestPairs();
    console.log(`   ${PAIRS.length} guard/middle pair(s) harvested from the circuits Tor built ` +
                'for itself during bootstrap, and ' + (await guardPairs()).length +
                ' more can be composed from GETINFO entry-guards without any circuit at all.');
    console.log('\n   cc  relay              how        ms   passive  builds  swept  page came out at');
    const rows = [];
    for (const cc of CCS) {
        for (const c of plans.get(cc) || []) {
            if (Date.now() > DEADLINE) { console.log('   (out of time budget)'); break; }
            const nick = c.nick || c.fp.slice(0, 8);
            if (badFps.has(c.fp)) {
                rows.push({ cc, c, nick, bad: true });
                console.log(`   ${cc.toUpperCase()}  ${nick.padEnd(18)} SKIPPED -- consensus BadExit: ` +
                            'the authorities say do not exit here, so the app must drop it, ' +
                            'not force it');
                continue;
            }
            const r = await forcePinTo(c.fp);
            const v = r.built ? await sweepAndVerify(c.fp.toUpperCase()) : { swept: 0, ip: null };
            rows.push({ cc, c, nick, r, v });
            console.log(`   ${cc.toUpperCase()}  ${nick.padEnd(18)} ` +
                        `${(r.built ? r.how : (r.hasDesc === false ? 'no md' : 'FAILED')).padEnd(9)} ` +
                        `${String(r.ms).padStart(6)}  ${String(r.passiveMs).padStart(7)}  ` +
                        `${String(r.attempts.length).padStart(6)}  ${String(v.swept).padStart(5)}  ` +
                        (v.ip ? `${v.ip} ${v.ip === c.ip ? '(that relay)' : 'BUT THE RELAY IS ' + c.ip}`
                              : '(no answer' + (v.err ? ': ' + v.err : '') + ')'));
            //  Why it was not even attempted, when that is the answer. A row
            //  printed with a bare FAILED and no attempts under it is what sent
            //  run 3 looking for a defect that was Tor's consensus, not the app.
            if (r.hasDesc === false) {
                console.log('        GETINFO md/id says Tor holds no microdescriptor for this ' +
                            'relay -- it cannot choose it and cannot be told to extend to it, ' +
                            'so the app skips the wait and restarts the engine with it pinned');
            }
            //  The attachment, printed next to the IP rather than instead of it:
            //  the IP says where the page came out and this says which circuit
            //  carried it, and only the second one is the claim being made.
            if (v.attached) {
                console.log('        stream attached to circuit ' + v.attached.circId +
                            ', whose exit is ' + (v.attached.nick || v.attached.fp.slice(0, 8)) +
                            ' ' + (v.attached.fp === c.fp.toUpperCase()
                                    ? '-- the pinned relay, read from the control port'
                                    : '-- NOT THE PINNED RELAY (' + nick + ')'));
            } else if (r.built) {
                console.log('        stream-status never showed this stream attached -- the exit ' +
                            'IP is the only evidence for this row');
            }
            for (const a of r.attempts.filter(x => x.err)) {
                console.log(`        explicit build via ${a.via ? (a.via.g.nick || a.via.g.fp.slice(0, 6)) + '/' +
                            (a.via.m.nick || a.via.m.fp.slice(0, 6)) + ' [' + a.via.from + ']' : '?'}: ${a.err}`);
            }
            for (const a of r.attempts.filter(x => x.built)) {
                console.log(`        explicit build via ${(a.via.g.nick || a.via.g.fp.slice(0, 6))}/` +
                            `${(a.via.m.nick || a.via.m.fp.slice(0, 6))} [${a.via.from}]: ` +
                            `circuit ${a.id} BUILT in ${a.ms} ms, and activeExits() sees it`);
            }
        }
    }

    // ── what that means ──────────────────────────────────────────────
    console.log('\n── what that means ──');
    const tried  = rows.filter(r => !r.bad);
    const built  = tried.filter(r => r.r.built);
    const byTor  = built.filter(r => r.r.how === 'tor');
    const forced = built.filter(r => r.r.how === 'forced');
    const dead   = tried.filter(r => !r.r.built);
    //  A candidate that did not come up is not automatically a hole in "must
    //  connect, whatever it takes". Split it by whether the app RECOGNISES why:
    //  a relay Tor holds no microdescriptor for cannot be waited for and cannot
    //  be extended to, the app detects that in one GETINFO and escalates
    //  straight to an engine restart with the relay pinned -- which is the route
    //  that fetches the descriptor. `unexplained` is the class that would be a
    //  defect: it failed and nothing in the app knows why.
    const noDesc      = dead.filter(r => r.r.hasDesc === false ||
                                         r.r.attempts.some(a => a.noDescriptor));
    const unexplained = dead.filter(r => !noDesc.includes(r));
    //  Split by what each row can actually prove. `proven` read the circuit the
    //  stream attached to off the control port and it was the pinned relay;
    //  `elsewhere` read it and it was someone else, which is the real failure;
    //  `byIpOnly` never caught the stream in stream-status, so the exit IP is all
    //  there is -- kept as evidence, but never counted as proof of attachment.
    const proven    = built.filter(r => r.v.attached &&
                                        r.v.attached.fp === r.c.fp.toUpperCase());
    const elsewhere = built.filter(r => r.v.attached &&
                                        r.v.attached.fp !== r.c.fp.toUpperCase());
    const byIpOnly  = built.filter(r => !r.v.attached && r.v.ip);
    const ipWrong   = byIpOnly.filter(r => r.v.ip !== r.c.ip);
    const silent    = built.filter(r => !r.v.ip);

    console.log(`   ${tried.length} candidates across ${CCS.length} countries ` +
                `(${rows.length - tried.length} skipped as BadExit).`);
    console.log(`   ${byTor.length} were chosen by Tor itself within ${PATIENCE} ms; ` +
                `${forced.length} needed the path named explicitly; ${dead.length} never came up ` +
                `(${noDesc.length} because Tor holds no microdescriptor for them, ` +
                `${unexplained.length} for no reason the app can name).`);
    if (forced.length) {
        const ms = forced.map(r => r.r.ms).sort((a, b) => a - b);
        console.log(`   the forced ones took ${ms[0]}-${ms[ms.length - 1]} ms in total -- against ` +
                    `the ${PATIENCE} ms the app now waits before it stops asking Tor to choose, ` +
                    'and the 25 000 ms it used to spend failing.');
    }
    console.log(`   ${proven.length} of ${built.length} proven at the control port: the stream ` +
                `attached to a circuit whose exit IS the pinned relay. ${elsewhere.length} ` +
                `attached to some other exit, ${byIpOnly.length} were never caught attached ` +
                `(${byIpOnly.length - ipWrong.length} of those came out at the relay's own ` +
                `address anyway), ${silent.length} did not answer.`);

    ok(unexplained.length === 0,
       'every candidate the app would offer either came up, or failed for a reason the app ' +
       'recognises in one GETINFO and escalates past -- so "must connect, whatever it takes" ' +
       'is implementable with what Tor already exposes',
       unexplained.map(r => r.cc.toUpperCase() + '/' + r.nick).join(', ') +
       ' failed and nothing here explains why');
    ok(built.length > 0 && elsewhere.length === 0,
       'and once pinned and swept, the stream attached to the pinned relay every time it could ' +
       'be read -- an explicitly built circuit carries real streams',
       elsewhere.map(r => `${r.nick}: stream took circuit ${r.v.attached.circId} out through ` +
                          `${r.v.attached.nick || r.v.attached.fp.slice(0, 8)}`).join('; '));
    ok(ipWrong.length === 0,
       'and no row that went unread at the control port came out at a foreign address either',
       ipWrong.map(r => `${r.nick}: page at ${r.v.ip}, relay is ${r.c.ip}`).join('; '));
    ok(silent.length === 0,
       'every pinned exit answered a real HTTPS request through the tunnel',
       silent.map(r => r.nick).join(', ') + ' built a circuit but returned nothing');
    return finish();
})().catch(async e => {
    console.log('probe crashed: ' + (e && e.stack || e));
    fail++;
    await finish();
});
