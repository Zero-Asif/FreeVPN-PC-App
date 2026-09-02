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
    } catch (e) { return { err: 'EXTENDCIRCUIT: ' + e.message.slice(0, 50), via: d }; }
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
    let built = await ctl.waitForExit(want, { timeoutMs: PATIENCE });
    const passiveMs = Date.now() - t0;
    const attempts = [];
    if (!built) {
        const pool = await donors(want);
        for (let i = 0; i < TRIES && !built; i++) {
            const a = await extendTo(want, pool);
            attempts.push(a);
            if (a.built) built = true;
            if (a.err === 'no guard/middle pair left to try') break;
        }
    }
    return { built, how: built ? (attempts.length ? 'forced' : 'tor') : 'none',
             ms: Date.now() - t0, passiveMs, purged, newnym, stashed,
             pairs: PAIRS.length, attempts };
}

//  The country guarantee: after the pin, nothing else may be attachable.
async function sweepAndVerify(want) {
    //  Harvest before the sweep, for the same reason forcePinTo() does: this
    //  purge is what empties the circuit list, and the pairs standing right now
    //  are the ones the NEXT candidate will have to borrow.
    await harvestPairs();
    const hi = await ctl.maxCircuitId();
    const swept = await ctl.purgeCircuitsExcept(want, { staleIdMax: hi });
    let ip = null, err = null;
    try {
        const r = await socksGet('https://api.ipify.org/', { socksPort: SOCKS, timeoutMs: 25000, maxBytes: 4096 });
        ip = (/\b(?:\d{1,3}\.){3}\d{1,3}\b/.exec(r.body || '') || [])[0] || null;
    } catch (e) { err = e.message.slice(0, 50); }
    return { swept, ip, err };
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
                        `${(r.built ? r.how : 'FAILED').padEnd(9)} ` +
                        `${String(r.ms).padStart(6)}  ${String(r.passiveMs).padStart(7)}  ` +
                        `${String(r.attempts.length).padStart(6)}  ${String(v.swept).padStart(5)}  ` +
                        (v.ip ? `${v.ip} ${v.ip === c.ip ? '(that relay)' : 'BUT THE RELAY IS ' + c.ip}`
                              : '(no answer' + (v.err ? ': ' + v.err : '') + ')'));
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
    const right  = built.filter(r => r.v.ip && r.v.ip === r.c.ip);
    const wrong  = built.filter(r => r.v.ip && r.v.ip !== r.c.ip);
    const silent = built.filter(r => !r.v.ip);

    console.log(`   ${tried.length} candidates across ${CCS.length} countries ` +
                `(${rows.length - tried.length} skipped as BadExit).`);
    console.log(`   ${byTor.length} were chosen by Tor itself within ${PATIENCE} ms; ` +
                `${forced.length} needed the path named explicitly; ${dead.length} never came up.`);
    if (forced.length) {
        const ms = forced.map(r => r.r.ms).sort((a, b) => a - b);
        console.log(`   the forced ones took ${ms[0]}-${ms[ms.length - 1]} ms in total -- against the ` +
                    '25 000 ms the app currently spends failing.');
    }
    console.log(`   ${right.length} of ${built.length} verified: the page came out at exactly the ` +
                `relay's own consensus address. ${wrong.length} came out elsewhere, ` +
                `${silent.length} did not answer.`);

    ok(dead.length === 0,
       'every candidate the app would offer was reachable -- so "must connect, whatever it takes" ' +
       'is implementable with what Tor already exposes',
       dead.map(r => r.cc.toUpperCase() + '/' + r.nick).join(', ') + ' stayed unreachable');
    ok(built.length > 0 && wrong.length === 0,
       'and once pinned and swept, traffic left through that exact relay every time -- an ' +
       'explicitly built circuit carries real streams',
       wrong.map(r => `${r.nick}: page at ${r.v.ip}, relay is ${r.c.ip}`).join('; '));
    ok(silent.length === 0,
       'every pinned exit answered a real HTTPS request through the tunnel',
       silent.map(r => r.nick).join(', ') + ' built a circuit but returned nothing');
    return finish();
})().catch(async e => {
    console.log('probe crashed: ' + (e && e.stack || e));
    fail++;
    await finish();
});
