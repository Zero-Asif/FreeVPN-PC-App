'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/probe-repin-why.js -- Tor CAN use the relay and still will
//  not pick it. What rejects it, and what forces it?
//
//  Established by .build/probe-repin.js, so not re-guessed here:
//      * every one of the app's top-5 candidates in 5 countries is in
//        this Tor's consensus with Running/Exit/Valid/Fast AND has a
//        microdescriptor. Both "cache" explanations are dead.
//      * 2 of 5 SE candidates still time out the app's 25 s
//        waitForExit, and the per-second circuit trace shows WHY the
//        message is misleading: after SETCONF ExitNodes=$new, Tor
//        launches BRAND NEW circuits (ids above the pre-SETCONF
//        watermark) that end at the OLD exit, and says
//            All routers are down or won't exit -- choosing a doomed
//            exit at random.
//            No exits in ExitNodes seem to be running: can't choose
//            an exit.
//        So this is not "the circuit took too long". Tor evaluated the
//        one-fingerprint routerset, scored it unusable, and fell back.
//
//  Tor scores an exit in choose_good_exit_server_general() by how many
//  of its PREDICTED ports the node can exit to -- and preemptive
//  circuits are all it has to go on while the app waits without making
//  a single request. A relay whose policy summary omits those ports
//  gets support 0, which prints exactly the two lines above. The
//  microdescriptor's own "p" line answers that, so it is read here.
//
//  Then the two things that decide the fix:
//      * does a REAL stream through SOCKS force the circuit that the
//        passive wait never got?
//      * does EXTENDCIRCUIT 0 $guard,$middle,$exit build it outright,
//        with a purpose the app's activeExits() accepts, and does
//        traffic actually leave through that relay's address?
//
//  Read-only: own ports, own DataDirectory under %TEMP%, the app's
//  consensus cache is COPIED and never written, a scratch ExitStore so
//  the app's exit cache is untouched, and only this probe's tor.exe is
//  killed.
// ════════════════════════════════════════════════════════════════════

const { spawn } = require('child_process');
const fs   = require('fs');
const os   = require('os');
const net  = require('net');
const path = require('path');

const { TorControl } = require('../lib/tor-control.js');
const { RelayIndex, ExitStore } = require('../lib/exit-selector.js');
const { directGet, socksGet } = require('../lib/socks-fetch.js');

const SOCKS = Number(process.env.PW_SOCKS) || 9350;
const CTRL  = Number(process.env.PW_CTRL)  || 9351;
const CC    = (process.env.PW_CC || 'se').toLowerCase();
const N     = Number(process.env.PW_N) || 5;
const WAIT  = Number(process.env.PW_WAIT) || 25000;    // the app's own budget
const DEADLINE = Date.now() + (Number(process.env.PW_MINUTES) || 14) * 60 * 1000;

const TOR_EXE  = 'C:/ProgramData/freeproxy-vpn/Tor/tor/tor.exe';
const APP_DATA = 'C:/ProgramData/freeproxy-vpn/Tor/data';
const WORK = path.join(os.tmpdir(), 'fp-repin-why');
const DATA = path.join(WORK, 'data');

const LOG = path.join(__dirname, 'probe-repin-why.log');
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
const NO_EXIT_RE = /No exits in ExitNodes seem to be running|Failed to choose an exit server|All routers are down or won't exit/;

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
        try {
            if (fs.existsSync(src)) fs.copyFileSync(src, path.join(DATA, f));
        } catch (e) { console.log('   (could not copy ' + f + ': ' + e.message + ')'); }
    }
}

//  main.js buildTorrc(), with only the three things a probe MUST change:
//  the ports, the DataDirectory, and no DNSPort (the app's is :53).
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
    const take = d => String(d).split(/\r?\n/).filter(Boolean)
        .forEach(l => torLog.push({ at: Date.now(), line: l }));
    tor.stdout.on('data', take);
    tor.stderr.on('data', take);
    tor.on('error', e => torLog.push({ at: Date.now(), line: 'spawn error: ' + e.message }));

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
        const phase = await ctl.getInfo('status/bootstrap-phase');
        const m = /PROGRESS=(\d+)/.exec(phase);
        if (m && Number(m[1]) >= 100) return i * 1000;
        await sleep(1000);
    }
    throw new Error('bootstrap never reached 100%');
}

// ── what Tor knows, including the port summary it scores exits by ────
async function askAbout(fp) {
    const out = { ns: false, flags: [], ip: null, orPort: null, bw: null,
                  md: false, policy: null };
    try {
        const ns = await ctl.getInfo(`ns/id/${fp}`);
        const r = ns.split('\n').find(l => l.startsWith('r '));
        const s = ns.split('\n').find(l => l.startsWith('s '));
        const w = ns.split('\n').find(l => l.startsWith('w '));
        if (r) { const f = r.split(' '); out.ns = true; out.ip = f[6] || null; out.orPort = f[7] || null; }
        if (s) out.flags = s.slice(2).trim().split(/\s+/);
        if (w) out.bw = (/Bandwidth=(\d+)/.exec(w) || [])[1] || null;
    } catch (e) { out.nsErr = e.message.slice(0, 40); }
    try {
        const md = await ctl.getInfo(`md/id/${fp}`);
        if (md.trim()) out.md = true;
        const p = md.split('\n').find(l => l.startsWith('p '));
        if (p) out.policy = p.slice(2).trim();
    } catch (e) { out.mdErr = e.message.slice(0, 40); }
    return out;
}

//  Does that policy summary let a stream out to the port? "accept 80,443"
//  and "reject 1-64,66-65535" are both possible spellings.
function policyAllows(policy, port) {
    if (!policy) return null;
    const m = /^(accept|reject)\s+(.*)$/.exec(policy);
    if (!m) return null;
    const hit = m[2].split(',').some(rng => {
        const [a, b] = rng.split('-');
        const lo = Number(a), hi = b === undefined ? Number(a) : Number(b);
        return Number.isFinite(lo) && port >= lo && port <= hi;
    });
    return m[1] === 'accept' ? hit : !hit;
}

const brief = cs => cs.map(c => `${c.id}:${c.status[0]}${c.purpose.slice(0, 4)}/${c.hops.length}` +
    (c.exit ? '>' + (c.exit.nick || c.exit.fp.slice(0, 6)) : '') + (c.internal ? '!' : '')).join(' ') || '(none)';

// ── stage 1: exactly what the app does, plus the read-back it never ──
//  does. If GETCONF disagrees with SETCONF the bug is ours; if it
//  agrees and Tor still says "no exits in ExitNodes seem to be
//  running", the bug is in what we ask of Tor.
let lastNewnymAt = 0;
async function appRepin(fp) {
    const mark = torLog.length;
    const t0 = Date.now();
    const idMark = await ctl.maxCircuitId();
    const pre = await ctl.circuits();
    await ctl.setConf({ ExitNodes: '$' + fp });
    let back = '';
    try { back = await getConf('ExitNodes'); } catch (e) { back = 'GETCONF failed: ' + e.message; }
    const purged = await ctl.purgeCircuitsExcept(fp, { staleIdMax: idMark });
    let newnym = false;
    if (Date.now() - lastNewnymAt >= 11000) {
        await ctl.newIdentity();
        lastNewnymAt = Date.now();
        newnym = true;
    }
    const built = await ctl.waitForExit(fp, { timeoutMs: WAIT });
    const win = torLog.slice(mark).map(l => l.line);
    return { built, ms: Date.now() - t0, idMark, pre: brief(pre), purged, newnym,
             readBack: back, complaints: win.filter(l => NO_EXIT_RE.test(l)).length,
             notices: win };
}

//  GETCONF answers "250 ExitNodes=$FP" on one line -- a config read, not
//  a GETINFO key, so it needs its own tiny parser.
async function getConf(key) {
    const lines = await ctl.cmd('GETCONF ' + key);
    for (const l of lines) {
        const m = new RegExp('^\\d{3}[ -]' + key + '=(.*)$').exec(l);
        if (m) return m[1].trim();
    }
    return '';
}

// ── stage 2: a real stream. The passive wait never makes a request, so
//  Tor only ever has PREDICTED ports to score the exit by. One actual
//  GET tells Tor the port it must exit to, which is a different
//  question entirely.
async function forceStream(fp, url, ms = 20000) {
    const t0 = Date.now();
    let got = null, err = null;
    const req = socksGet(url, { socksPort: SOCKS, timeoutMs: ms, maxBytes: 8 * 1024 })
        .then(r => { got = r; }).catch(e => { err = e.message.slice(0, 60); });
    let built = false;
    while (Date.now() - t0 < ms) {
        try {
            const ex = await ctl.activeExits();
            if (ex.some(e => e.fp === fp.toUpperCase())) { built = true; break; }
        } catch (e) {}
        if (got || err) break;
        await sleep(700);
    }
    const waited = Date.now() - t0;
    await Promise.race([req, sleep(Math.max(0, ms - waited))]);
    return { built, ms: Date.now() - t0,
             body: got ? (got.body || '').trim().slice(0, 40) : null,
             status: got ? got.status : 0, err };
}

// ── stage 3: stop asking and build it. EXTENDCIRCUIT 0 with an explicit
//  path takes Tor's exit-scoring out of the loop entirely: the
//  controller names all three hops. Guard and middle are borrowed from a
//  circuit Tor itself just built, so the guard set is not disturbed.
//
//  Two things have to be true for this to be usable as a fix, and both
//  are measured, not assumed: the resulting circuit's PURPOSE must be
//  one the app's activeExits() accepts, and traffic must actually leave
//  through that relay's address.
async function forceBuild(fp, { purpose = null } = {}) {
    const want = fp.toUpperCase();
    let cs = [];
    try { cs = await ctl.circuits(); } catch (e) {}
    const donor = cs.filter(c => c.status === 'BUILT' && c.hops.length >= 3 &&
                                 !c.hops.some(h => h.fp === want))
                    .sort((a, b) => Number(b.id) - Number(a.id))[0];
    if (!donor) return { err: 'no 3-hop circuit to borrow a guard and middle from' };
    const g = donor.hops[0].fp, m = donor.hops[1].fp;

    const t0 = Date.now();
    let id = null;
    try {
        const lines = await ctl.cmd(`EXTENDCIRCUIT 0 $${g},$${m},$${want}` +
                                    (purpose ? ` purpose=${purpose}` : ''), { timeoutMs: 20000 });
        const line = lines.find(l => /EXTENDED/.test(l)) || '';
        id = (/EXTENDED\s+(\d+)/.exec(line) || [])[1] || null;
    } catch (e) { return { err: 'EXTENDCIRCUIT: ' + e.message.slice(0, 60), donor: donor.id }; }
    if (!id) return { err: 'EXTENDCIRCUIT gave no circuit id', donor: donor.id };

    let mine = null;
    for (;;) {
        try { mine = (await ctl.circuits()).find(c => c.id === id) || null; } catch (e) {}
        if (mine && mine.status === 'BUILT') break;
        if (!mine && Date.now() - t0 > 4000) break;          // Tor dropped it
        if (Date.now() - t0 > 45000) break;
        await sleep(700);
    }
    let visible = false;
    try { visible = (await ctl.activeExits()).some(e => e.fp === want); } catch (e) {}
    return { id, ms: Date.now() - t0, borrowed: `${donor.hops[0].nick || g.slice(0, 6)}/${donor.hops[1].nick || m.slice(0, 6)}`,
             status: mine ? mine.status : 'gone', purpose: mine ? mine.purpose : '-',
             hops: mine ? mine.hops.length : 0,
             endsThere: !!(mine && mine.exit && mine.exit.fp === want), visible };
}

//  The only answer that matters in the end: does a page come out at that
//  relay's address?
async function egress() {
    try {
        const r = await socksGet('https://api.ipify.org/', { socksPort: SOCKS, timeoutMs: 25000, maxBytes: 4096 });
        return (/\b(?:\d{1,3}\.){3}\d{1,3}\b/.exec(r.body || '') || [])[0] || null;
    } catch (e) { return null; }
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
    console.log(`── why SETCONF alone is not enough -- ${new Date().toISOString()} ──`);
    ok(fs.existsSync(TOR_EXE), 'the deployed tor.exe is where the app puts it', TOR_EXE);
    if (!fs.existsSync(TOR_EXE)) return finish();
    ok(await portFree(SOCKS) && await portFree(CTRL),
       `ports ${SOCKS}/${CTRL} are free, so nothing here can be the app's Tor`);

    console.log(`\n── the app's own exit picker for ${CC.toUpperCase()}, fed real onionoo ──`);
    const store = new ExitStore(path.join(os.tmpdir(), 'fp-repin-why-exits.json'), quiet);
    store.data = { verified: {}, rejected: {} };
    const index = new RelayIndex(quiet);
    try {
        await index.refresh(url => directGet(url, { timeoutMs: 25000, maxBytes: 12 * 1024 * 1024 }));
    } catch (e) { ok(false, 'onionoo answered', e.message); return finish(); }
    const cands = index.candidates(CC, store, { limit: N });
    ok(cands.length > 0, `${CC.toUpperCase()}: ${(index.byCountry[CC] || []).length} exits listed, ` +
       `top ${N} = ` + cands.map(c => c.nick || c.fp.slice(0, 8)).join(', '));
    if (!cands.length) return finish();

    console.log('\n── booting the deployed tor.exe on its own ports ──');
    seedDataDir();
    try {
        const ms = await startTor(writeTorrc('$' + cands[0].fp));
        ok(true, `bootstrapped in about ${Math.round(ms / 1000)} s, started on ` +
                 `${cands[0].nick || cands[0].fp.slice(0, 8)} exactly as the app starts it`);
    } catch (e) {
        ok(false, 'the probe\'s own Tor bootstrapped', e.message);
        console.log('   last 12 Tor lines:\n     ' + torLog.slice(-12).map(l => l.line).join('\n     '));
        return finish();
    }

    // ── the port summary Tor scores preemptive exits by ───────────────
    console.log('\n── each candidate\'s exit policy summary, out of its own microdescriptor ──');
    console.log('   relay              consensus ip     bw     80   443   policy');
    const facts = new Map();
    for (const c of cands) {
        const a = await askAbout(c.fp);
        facts.set(c.fp, a);
        console.log(`   ${(c.nick || c.fp.slice(0, 8)).padEnd(18)} ${String(a.ip).padEnd(16)} ` +
                    `${String(a.bw || '-').padEnd(6)} ` +
                    `${(policyAllows(a.policy, 80) ? 'yes' : 'NO ').padEnd(4)} ` +
                    `${(policyAllows(a.policy, 443) ? 'yes' : 'NO ').padEnd(5)} ` +
                    (a.policy || '(no p line)').slice(0, 60));
    }

    // ── the app's sequence, then two escalations it does not have ─────
    console.log(`\n── per candidate: the app's SETCONF+wait(${WAIT} ms), then a real stream, ` +
                'then an explicit build ──');
    const rows = [];
    for (const c of cands) {
        if (Date.now() > DEADLINE) { console.log('   (out of time budget)'); break; }
        const nick = c.nick || c.fp.slice(0, 8);
        const a = facts.get(c.fp);
        const r = { c, nick, a, app: await appRepin(c.fp) };
        console.log(`\n   ${nick} (${c.fp.slice(0, 8)})`);
        console.log(`      before SETCONF: idMark=${r.app.idMark}  ${r.app.pre}`);
        console.log(`      GETCONF read-back: ${r.app.readBack}` +
                    (r.app.readBack === '$' + c.fp.toUpperCase() ? '  (matches)' : '  (DIFFERENT)'));
        console.log(`      purged ${r.app.purged}, newnym ${r.app.newnym ? 'sent' : 'rate-limited'}` +
                    ` -> ${r.app.built ? 'BUILT' : 'no circuit'} in ${r.app.ms} ms, ` +
                    `${r.app.complaints} "cannot choose an exit" line(s)`);

        if (!r.app.built) {
            r.stream = await forceStream(c.fp, 'http://api.ipify.org/');
            console.log(`      a real GET to port 80: ${r.stream.built ? 'circuit APPEARED' : 'still nothing'}` +
                        ` in ${r.stream.ms} ms` +
                        (r.stream.body ? `, body ${r.stream.body}` : '') +
                        (r.stream.err ? `, request failed: ${r.stream.err}` : ''));
            if (!r.stream.built) {
                r.stream443 = await forceStream(c.fp, 'https://api.ipify.org/');
                console.log(`      a real GET to port 443: ${r.stream443.built ? 'circuit APPEARED' : 'still nothing'}` +
                            ` in ${r.stream443.ms} ms` +
                            (r.stream443.body ? `, body ${r.stream443.body}` : '') +
                            (r.stream443.err ? `, request failed: ${r.stream443.err}` : ''));
            }
            const gotByStream = r.stream.built || (r.stream443 && r.stream443.built);
            if (!gotByStream) {
                //  Nothing Tor decides for itself produced this circuit. Name
                //  the whole path and let it argue.
                r.forced = await forceBuild(c.fp);
                if (r.forced.err) {
                    console.log(`      EXTENDCIRCUIT: ${r.forced.err}`);
                } else {
                    console.log(`      EXTENDCIRCUIT 0 $guard,$middle,$exit (borrowed ${r.forced.borrowed}): ` +
                                `circuit ${r.forced.id} ${r.forced.status} after ${r.forced.ms} ms, ` +
                                `PURPOSE=${r.forced.purpose}, ${r.forced.hops} hops, ` +
                                `ends there: ${r.forced.endsThere ? 'yes' : 'no'}, ` +
                                `activeExits() sees it: ${r.forced.visible ? 'yes' : 'NO'}`);
                    //  A purpose outside APP_PURPOSES is invisible to every
                    //  check in tor-control.js, so ask for one that is not.
                    if (r.forced.status === 'BUILT' && !r.forced.visible) {
                        r.forced2 = await forceBuild(c.fp, { purpose: 'general' });
                        console.log(`      again with purpose=general: circuit ${r.forced2.id} ` +
                                    `${r.forced2.status}, PURPOSE=${r.forced2.purpose}, ` +
                                    `activeExits() sees it: ${r.forced2.visible ? 'yes' : 'NO'}` +
                                    (r.forced2.err ? ' -- ' + r.forced2.err : ''));
                    }
                    if ((r.forced.visible) || (r.forced2 && r.forced2.visible)) {
                        r.egressIp = await egress();
                        console.log(`      traffic now leaves at ${r.egressIp || '(no answer)'} ` +
                                    `-- the consensus says this relay is ${r.a.ip} ` +
                                    `(${r.egressIp === r.a.ip ? 'MATCH' : 'different'})`);
                    }
                }
            }
        }
        rows.push(r);
    }

    // ── Tor's own words, for the ones SETCONF alone did not fix ──────
    for (const r of rows.filter(x => !x.app.built)) {
        const n = r.app.notices.filter(l => !/is relative and will resolve/.test(l));
        if (n.length) {
            console.log(`\n   ── Tor, while ${r.nick} was being waited for ──\n        ` +
                        n.slice(0, 10).join('\n        '));
        }
    }

    // ── what that means ──────────────────────────────────────────────
    console.log('\n── what that means ──');
    const failed  = rows.filter(r => !r.app.built);
    const byStream = failed.filter(r => (r.stream && r.stream.built) ||
                                        (r.stream443 && r.stream443.built));
    const byForce  = failed.filter(r => (r.forced && r.forced.visible) ||
                                        (r.forced2 && r.forced2.visible));
    const stillDead = failed.filter(r => !byStream.includes(r) && !byForce.includes(r));

    console.log(`   ${rows.length} candidates: ${rows.length - failed.length} answered the app's ` +
                `SETCONF+wait, ${failed.length} did not.`);
    console.log(`   of those ${failed.length}: ${byStream.length} appeared as soon as a real stream ` +
                `named a port, ${byForce.length} needed the path spelled out with EXTENDCIRCUIT, ` +
                `${stillDead.length} never came up at all.`);

    const wrongReadBack = rows.filter(r => r.app.readBack !== '$' + r.c.fp.toUpperCase());
    ok(wrongReadBack.length === 0,
       'Tor accepted every SETCONF ExitNodes -- so a failed re-pin is never a config that ' +
       'did not land',
       wrongReadBack.map(r => r.nick + ' read back ' + r.app.readBack).join('; '));

    const policyGap = failed.filter(r => policyAllows(r.a.policy, 80) === false);
    if (failed.length) {
        console.log(`   ${policyGap.length} of the ${failed.length} failures reject port 80 in their own ` +
                    'policy summary, which is what Tor scores a preemptive exit by when the app ' +
                    'waits without making a request.');
    }

    ok(failed.length === 0 || byStream.length + byForce.length === failed.length,
       'every candidate Tor listed as a running exit could be reached by SOME means the app ' +
       'is able to use -- so "no circuit reached X in 25s" is a missing escalation, not a dead relay',
       stillDead.map(r => r.nick).join(', ') + ' stayed unreachable by all three');

    const forcedVisible = rows.filter(r => (r.forced && r.forced.visible) || (r.forced2 && r.forced2.visible));
    if (forcedVisible.length) {
        const matched = forcedVisible.filter(r => r.egressIp && r.egressIp === r.a.ip);
        ok(matched.length === forcedVisible.length,
           'and when the app builds the circuit itself, traffic really does leave at that ' +
           'relay\'s address -- an explicit path is a real connection, not a bookkeeping trick',
           forcedVisible.filter(r => !matched.includes(r))
               .map(r => `${r.nick}: exit ${r.egressIp || 'none'} vs consensus ${r.a.ip}`).join('; '));
    }
    return finish();
})().catch(async e => {
    console.log('probe crashed: ' + (e && e.stack || e));
    fail++;
    await finish();
});
