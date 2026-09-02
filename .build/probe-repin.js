'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/probe-repin.js -- why does SETCONF ExitNodes=$fp end in
//  "No exits in ExitNodes seem to be running"?
//
//  Straight out of the app's own log (C:/ProgramData/freeproxy-vpn/logs,
//  2026-09-01, the switch the user reported):
//      Closed 5 circuit(s) not ending at 10B689D1
//      [warn] No exits in ExitNodes seem to be running: can't choose an exit.
//      [warn] Failed to choose an exit server         (repeated for 25 s)
//      No circuit reached sveahosting in 25s
//  ...then the same for Modgud, Playstar02, secretpassage, and then for
//  the top exit of EE, FI, NO and DK. Five countries, nine relays, not
//  one circuit -- while onionoo listed every one of them as a RUNNING
//  exit seconds earlier. That is the whole bug: candidate #1 is reachable
//  (Tor was STARTED on it) and candidates #2..#5 never are.
//
//  Tor prints that warning from choose_good_exit_server_general() when
//  the usable-node count comes out zero. For a routerset holding ONE
//  fingerprint there are only two plausible reasons:
//      * the relay is not in THIS Tor's consensus, or not flagged
//        Running/Valid in it, or
//      * its microdescriptor is missing, so Tor has no ntor key to
//        extend to it and node_has_preferred_descriptor() is false.
//  Those two are distinguishable, and GETINFO answers both:
//  ns/id/<fp> for the consensus entry, md/id/<fp> for the microdesc.
//
//  So: take the app's OWN candidate list (lib/exit-selector.js fed real
//  onionoo bytes), ask a Tor booted from a COPY of the app's cache what
//  it knows about each fingerprint, then run the re-pin the app runs and
//  time it. Finally re-ask, to find out whether patience alone fixes it.
//
//  Read-only: own ports, own DataDirectory under %TEMP%, the app's cache
//  is COPIED and never written, the app's exit store is never touched
//  (a scratch one is used), and only this probe's own tor.exe is killed.
// ════════════════════════════════════════════════════════════════════

const { spawn } = require('child_process');
const fs   = require('fs');
const os   = require('os');
const net  = require('net');
const path = require('path');

const { TorControl } = require('../lib/tor-control.js');
const { RelayIndex, ExitStore } = require('../lib/exit-selector.js');
const { directGet } = require('../lib/socks-fetch.js');

const SOCKS = Number(process.env.PR_SOCKS) || 9350;
const CTRL  = Number(process.env.PR_CTRL)  || 9351;
const CCS   = (process.env.PR_CC || 'se,ee,fi,no,dk').split(',').filter(Boolean);
const PIN_TIMEOUT = Number(process.env.PR_WAIT) || 25000;   // the app's own 25 s

const TOR_EXE  = 'C:/ProgramData/freeproxy-vpn/Tor/tor/tor.exe';
const APP_DATA = 'C:/ProgramData/freeproxy-vpn/Tor/data';
const WORK = path.join(os.tmpdir(), 'fp-repin');
const DATA = path.join(WORK, 'data');

const LOG = path.join(__dirname, 'probe-repin.log');
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
//  Tor's own complaint, counted per re-pin window, so "no circuit in 25 s"
//  can be told apart from "Tor refused to even choose an exit".
const NO_EXIT_RE = /No exits in ExitNodes seem to be running|Failed to choose an exit server/;

function portFree(port) {
    return new Promise(resolve => {
        const s = net.connect({ host: '127.0.0.1', port });
        const no = () => { try { s.destroy(); } catch (e) {} resolve(true); };
        s.once('connect', () => { try { s.destroy(); } catch (e) {} resolve(false); });
        s.once('error', no);
        setTimeout(no, 1200);
    });
}

//  The app's cache is COPIED, never used in place and never written to. The
//  point of the probe is to see what the app's Tor sees at boot, so the same
//  four files the app keeps are the ones that come along.
function seedDataDir() {
    fs.rmSync(WORK, { recursive: true, force: true });
    fs.mkdirSync(DATA, { recursive: true });
    const copied = [];
    for (const f of ['cached-certs', 'cached-microdesc-consensus',
                     'cached-microdescs', 'cached-microdescs.new', 'state']) {
        const src = path.join(APP_DATA, f);
        try {
            if (!fs.existsSync(src)) continue;
            fs.copyFileSync(src, path.join(DATA, f));
            copied.push(`${f} (${(fs.statSync(src).size / 1e6).toFixed(1)} MB, ` +
                        `${new Date(fs.statSync(src).mtimeMs).toTimeString().slice(0, 8)})`);
        } catch (e) { console.log('   (could not copy ' + f + ': ' + e.message + ')'); }
    }
    return copied;
}

//  main.js buildTorrc(), line for line, with only the three things a probe
//  MUST change: the ports, the DataDirectory, and no DNSPort (the app's is
//  :53 and taking it would break name resolution machine-wide).
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

// ── What does Tor know about one fingerprint? ───────────────────────
//  Two questions, not one. "In the consensus" and "usable" are different
//  states, and only the second one can build a circuit.
async function askAbout(fp) {
    const out = { ns: false, flags: [], ip: null, md: false, nsErr: null, mdErr: null };
    try {
        const ns = await ctl.getInfo(`ns/id/${fp}`);
        const r = ns.split('\n').find(l => l.startsWith('r '));
        const s = ns.split('\n').find(l => l.startsWith('s '));
        if (r) { out.ns = true; out.ip = r.split(' ')[6] || null; }
        if (s) out.flags = s.slice(2).trim().split(/\s+/);
    } catch (e) { out.nsErr = e.message.slice(0, 40); }
    try {
        const md = await ctl.getInfo(`md/id/${fp}`);
        out.md = /onion-key|ntor-onion-key/.test(md);
        if (!out.md && md.trim()) out.md = true;      // a body came back at all
    } catch (e) { out.mdErr = e.message.slice(0, 40); }
    return out;
}

//  The app's re-pin, reduced to the calls that decide whether it works:
//  SETCONF ExitNodes, the purge, the NEWNYM the app sends when its rate
//  limit allows, then the wait for a BUILT circuit that ends there.
//
//  And a per-second trace of circuit-status through the whole wait, because
//  "no circuit reached X in 25 s" is four different failures wearing one
//  message: Tor built nothing, Tor built and tore down, Tor built to the
//  wrong exit, or Tor built the right circuit and activeExits() did not
//  recognise it. Only the trace can tell them apart.
let lastNewnymAt = 0;
async function repin(fp, { newnym = true } = {}) {
    const mark = torLog.length;
    const t0 = Date.now();
    const idMark = await ctl.maxCircuitId();
    await ctl.setConf({ ExitNodes: '$' + fp });
    const purged = await ctl.purgeCircuitsExcept(fp, { staleIdMax: idMark });
    if (newnym && Date.now() - lastNewnymAt >= 11000) {
        await ctl.newIdentity();
        lastNewnymAt = Date.now();
    }

    const want = fp.toUpperCase();
    const trace = [];
    let built = false;
    for (;;) {
        let cs = [];
        try { cs = await ctl.circuits(); } catch (e) {}
        trace.push({
            at: Date.now() - t0,
            cs: cs.map(c => `${c.id}:${c.status[0]}${c.purpose.slice(0, 4)}/${c.hops.length}` +
                            (c.exit ? '>' + (c.exit.nick || c.exit.fp.slice(0, 6)) : '') +
                            (c.internal ? '!' : '')).join(' ') || '(none)',
        });
        if (cs.some(c => c.status === 'BUILT' && !c.internal &&
                         TorControl.APP_PURPOSES.has(c.purpose) &&
                         c.hops.length >= 2 && c.exit && c.exit.fp === want)) {
            built = true;
            break;
        }
        if (Date.now() - t0 >= PIN_TIMEOUT) break;
        await sleep(1000);
    }
    const win = torLog.slice(mark);
    return { built, ms: Date.now() - t0, purged, trace,
             complaints: win.filter(l => NO_EXIT_RE.test(l.line)).length,
             notices: win.map(l => l.line) };
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
    console.log(`── SETCONF ExitNodes re-pin, measured -- ${new Date().toISOString()} ──`);
    ok(fs.existsSync(TOR_EXE), 'the deployed tor.exe is where the app puts it', TOR_EXE);
    if (!fs.existsSync(TOR_EXE)) return finish();
    ok(await portFree(SOCKS) && await portFree(CTRL),
       `ports ${SOCKS}/${CTRL} are free, so nothing here can be the app's Tor`);

    // ── 1. The app's own candidate list, from real onionoo bytes ──────
    console.log('\n── the app\'s own exit picker, fed real onionoo ──');
    const store = new ExitStore(path.join(os.tmpdir(), 'fp-repin-exits.json'), quiet);
    store.data = { verified: {}, rejected: {} };     // scratch: judge every candidate
    const index = new RelayIndex(quiet);
    try {
        await index.refresh(url => directGet(url, { timeoutMs: 25000, maxBytes: 12 * 1024 * 1024 }));
        ok(true, `onionoo: exits in ${index.countryCount} countries`);
    } catch (e) {
        ok(false, 'onionoo answered', e.message);
        return finish();
    }
    const plans = new Map();
    for (const cc of CCS) {
        const list = index.candidates(cc, store, { limit: 5 });
        plans.set(cc, list);
        console.log(`   ${cc.toUpperCase()}: ${(index.byCountry[cc] || []).length} exits listed, ` +
                    `top 5 = ` + list.map(c => c.nick || c.fp.slice(0, 8)).join(', '));
    }
    const lead = plans.get(CCS[0]) || [];
    ok(lead.length > 0, `${CCS[0].toUpperCase()} has candidates to test`);
    if (!lead.length) return finish();

    // ── 2. Boot the app's Tor the way the app boots it ────────────────
    console.log('\n── booting the deployed tor.exe on its own ports ──');
    for (const l of seedDataDir()) console.log('   copied ' + l);
    let bootMs = 0;
    try {
        bootMs = await startTor(writeTorrc('$' + lead[0].fp));
        ok(true, `bootstrapped in about ${Math.round(bootMs / 1000)} s, started on ` +
                 `${lead[0].nick || lead[0].fp.slice(0, 8)} exactly as the app starts it`);
    } catch (e) {
        ok(false, 'the probe\'s own Tor bootstrapped', e.message);
        console.log('   last 12 Tor lines:\n     ' +
                    torLog.slice(-12).map(l => l.line).join('\n     '));
        return finish();
    }

    // ── 3. What does this Tor know about each candidate? ──────────────
    console.log('\n── consensus entry vs microdescriptor, per candidate ──');
    console.log('   cc  relay              in consensus  Running/Exit/Valid  microdesc');
    const known = [];
    for (const cc of CCS) {
        for (const c of plans.get(cc) || []) {
            const a = await askAbout(c.fp);
            known.push({ cc, c, a });
            const flags = ['Running', 'Exit', 'Valid', 'Fast']
                .filter(f => a.flags.includes(f)).join('/') || '-';
            console.log(`   ${cc.toUpperCase()}  ${(c.nick || c.fp.slice(0, 8)).padEnd(18)} ` +
                        `${(a.ns ? 'yes' : 'NO').padEnd(12)}  ${flags.padEnd(18)}  ` +
                        (a.md ? 'present' : 'MISSING' + (a.mdErr ? ' (' + a.mdErr + ')' : '')));
        }
    }
    const noNs = known.filter(k => !k.a.ns);
    const noMd = known.filter(k => k.a.ns && !k.a.md);
    console.log(`   -> ${known.length} candidates: ${noNs.length} absent from the consensus, ` +
                `${noMd.length} in the consensus with NO microdescriptor, ` +
                `${known.length - noNs.length - noMd.length} fully usable.`);

    // ── 4. The app's re-pin, on each candidate, in the app's order ────
    console.log(`\n── SETCONF + waitForExit(${PIN_TIMEOUT} ms), the app's own sequence ──`);
    console.log('   relay              usable?  built?      ms  purged  "cannot choose an exit"');
    const pinRows = [];
    for (const c of lead) {
        const a = known.find(k => k.c.fp === c.fp).a;
        const r = await repin(c.fp);
        pinRows.push({ c, a, r });
        console.log(`   ${(c.nick || c.fp.slice(0, 8)).padEnd(18)} ` +
                    `${(a.ns && a.md ? 'yes' : 'no ').padEnd(7)}  ` +
                    `${(r.built ? 'BUILT' : 'no   ').padEnd(6)}  ${String(r.ms).padStart(6)}  ` +
                    `${String(r.purged).padStart(6)}  ${r.complaints}`);
    }

    //  The trace, for the ones that failed. This is the whole point of the
    //  probe: the app's log says only "No circuit reached X in 25s".
    for (const p of pinRows.filter(x => !x.r.built)) {
        console.log(`\n   ── circuit-status while ${p.c.nick || p.c.fp.slice(0, 8)} ` +
                    `(${p.c.fp.slice(0, 8)}) was being waited for ──`);
        for (const t of p.r.trace) {
            console.log(`      ${String(t.at).padStart(6)} ms  ${t.cs}`);
        }
        const n = p.r.notices.filter(l => !/is relative and will resolve/.test(l));
        if (n.length) {
            console.log('      Tor said:\n        ' + n.slice(0, 14).join('\n        '));
        }
    }


    // ── 5. Does patience alone fix a missing microdescriptor? ─────────
    let fetched = 0;
    if (noMd.length) {
        console.log('\n── waiting 60 s, then asking again about the ones with no microdesc ──');
        await sleep(60000);
        for (const k of noMd) {
            const a2 = await askAbout(k.c.fp);
            if (a2.md) fetched++;
        }
        console.log(`   ${fetched} of ${noMd.length} microdescriptors arrived within 60 s ` +
                    'of the request being made.');
    }

    // ── 6. What that means ────────────────────────────────────────────
    console.log('\n── what that means ──');
    const usable   = pinRows.filter(p => p.a.ns && p.a.md);
    const unusable = pinRows.filter(p => !(p.a.ns && p.a.md));
    const builtOfUsable   = usable.filter(p => p.r.built).length;
    const builtOfUnusable = unusable.filter(p => p.r.built).length;

    console.log(`   of the ${pinRows.length} ${CCS[0].toUpperCase()} candidates the app would ` +
                `have tried, ${usable.length} were usable to Tor and ${unusable.length} were not.`);
    console.log(`   re-pin succeeded on ${builtOfUsable}/${usable.length} usable and ` +
                `${builtOfUnusable}/${unusable.length} unusable ones.`);
    if (unusable.length) {
        const c = unusable.reduce((s, p) => s + p.r.complaints, 0);
        console.log(`   the unusable ones produced ${c} "can't choose an exit" line(s) -- the same ` +
                    'line the app\'s log filled with for 25 s per candidate.');
    }
    ok(builtOfUnusable === 0 || unusable.length === 0,
       'a relay Tor cannot use never yields a circuit -- so the app is waiting 25 s for ' +
       'something that was decided before the wait started',
       builtOfUnusable + ' of them built anyway, so the cause is elsewhere');
    ok(usable.length === 0 || builtOfUsable === usable.length,
       'every relay Tor CAN use gave a circuit inside the app\'s own timeout',
       (usable.length - builtOfUsable) + ' usable one(s) still failed');
    ok(known.length > 0 && (noNs.length + noMd.length) === 0,
       `every top candidate the app would pick is usable by the Tor it asks`,
       `${noNs.length + noMd.length} of ${known.length} across ${CCS.length} countries are not -- ` +
       'the app picks from onionoo and never asks Tor whether it can use the relay');

    return finish();
})().catch(async e => {
    console.log('probe crashed: ' + (e && e.stack || e));
    fail++;
    await finish();
});





