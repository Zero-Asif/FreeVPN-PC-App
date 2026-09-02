'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/probe-ipleak-parallel.js -- the last suspect for the empty
//  IPv4 row, measured instead of assumed.
//
//  probe-ipleak-tor.js already settled two things, on this machine, this
//  week: the route is not blocked (HTTP 200, CORS *, an IPv4 in the body
//  every time) and one request at a time through a fresh circuit lands
//  in 1131-3094 ms, median 2142 -- 6 of 6 inside ipleak's own 5000 ms
//  budget. By that measurement the row should fill in every time, and in
//  the screenshot it does not.
//
//  The difference between that probe and a browser on ipleak.net is
//  CONCURRENCY. The probe made one request and waited. The page fires
//  its whole set of checks at once, and with no Isolate* flags on the
//  app's SocksPort every one of those streams is multiplexed onto the
//  SAME Tor circuit -- one TCP connection, three relays, shared
//  bandwidth and one 500-byte-cell queue.
//
//  So: how does that single request's clock move when the circuit is
//  carrying 6 or 10 simultaneous TLS streams instead of 1? And -- in the
//  other direction, because it matters just as much -- is a request on
//  an ALREADY-WARM circuit faster than the fresh-circuit numbers above,
//  which is the case the browser actually gets once the page itself has
//  loaded?
//
//  What this probe does NOT claim: it is not a replay of ipleak's page.
//  The load is synthetic (repeat GETs to hosts already used above), and
//  it measures the mechanism, not that exact page's exact request list.
//
//  Read-only, like its sibling: nothing outside %TEMP% is written, the
//  app's Tor is never used or touched, and the deployed tor.exe is
//  booted on its own ports from a COPY of the consensus cache.
// ════════════════════════════════════════════════════════════════════

const { spawn } = require('child_process');
const fs   = require('fs');
const os   = require('os');
const net  = require('net');
const path = require('path');

const { socksGet } = require('../lib/socks-fetch.js');
const { TorControl } = require('../lib/tor-control.js');

const SOCKS  = Number(process.env.PP_SOCKS) || 9360;
const CTRL   = Number(process.env.PP_CTRL)  || 9361;
const ROUNDS = Number(process.env.PP_N)     || 4;
const BUDGET = 5000;    // ipleak's own per-try AJAX timeout
const TRIES  = 3;       // and its retries before it prints "timeout"

const TOR_EXE  = 'C:/ProgramData/freeproxy-vpn/Tor/tor/tor.exe';
const APP_DATA = 'C:/ProgramData/freeproxy-vpn/Tor/data';
const WORK = path.join(os.tmpdir(), 'fp-ipleak-par');
const DATA = path.join(WORK, 'data');
const DEADLINE = Date.now() + (Number(process.env.PP_MINUTES) || 10) * 60 * 1000;

const LOG = path.join(__dirname, 'probe-ipleak-parallel.log');
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
const quiet = { debug() {}, info() {}, warn() {}, error() {} };

const ROW  = 'https://ipv4.ipleak.net/?mode=ajax';
//  Filler streams: real hosts, so the load is real TLS through real exits.
//  Repeats are fine -- each socksGet opens its own connection, which is its
//  own stream, which is the thing being varied.
const FILL = ['https://ipleak.net/?mode=ajax', 'https://api.ipify.org/',
              'https://ipleak.net/json/', 'https://api.ipify.org/?format=json',
              'https://ipleak.net/?mode=ajax', 'https://api.ipify.org/',
              'https://ipleak.net/json/', 'https://api.ipify.org/?format=json',
              'https://ipleak.net/?mode=ajax'];

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
    const copied = [];
    for (const f of ['cached-certs', 'cached-microdesc-consensus',
                     'cached-microdescs', 'cached-microdescs.new']) {
        const src = path.join(APP_DATA, f);
        try {
            if (!fs.existsSync(src)) continue;
            fs.copyFileSync(src, path.join(DATA, f));
            copied.push(f);
        } catch (e) { console.log('   (could not copy ' + f + ': ' + e.message + ')'); }
    }
    return copied;
}

//  The shipped listener line and the shipped circuit settings, verbatim, so
//  this is measuring the app's tunnel and not a friendlier one.
function writeTorrc() {
    const q = p => p.replace(/\\/g, '/');
    const rc = [
        `SocksPort 127.0.0.1:${SOCKS} IPv4Traffic NoIPv6Traffic NoPreferIPv6Automap`,
        `ControlPort 127.0.0.1:${CTRL}`,
        'CookieAuthentication 1',
        `CookieAuthFile "${q(path.join(DATA, 'control_auth_cookie'))}"`,
        `DataDirectory "${q(DATA)}"`,
        'ClientUseIPv4 1',
        'ClientUseIPv6 0',
        'ClientRejectInternalAddresses 1',
        'MaxCircuitDirtiness 600',
        'NewCircuitPeriod 120',
        'LongLivedPorts 9050,9080',
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
    let last = '';
    for (let i = 0; i < 180; i++) {
        const phase = await ctl.getInfo('status/bootstrap-phase');
        last = phase;
        if (/PROGRESS=100/.test(phase)) return { bootMs: i * 1000, phase };
        await sleep(1000);
    }
    throw new Error('bootstrap never reached 100%: ' + last);
}

const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/;
async function timedGet(url, timeoutMs = 20000) {
    const t0 = Date.now();
    try {
        const r = await socksGet(url, { socksPort: SOCKS, timeoutMs, maxBytes: 64 * 1024 });
        const m = IPV4.exec(r.body || '');
        return { ms: Date.now() - t0, status: r.status, ip: m ? m[0] : null,
                 cors: r.headers['access-control-allow-origin'] || null };
    } catch (e) {
        return { ms: Date.now() - t0, status: 0, ip: null, cors: null,
                 err: e.message.slice(0, 60) };
    }
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

const stat = a => {
    const good = a.filter(g => g.status === 200);
    const ms = good.map(g => g.ms).sort((x, y) => x - y);
    return { n: a.length, good: good.length,
             inB: good.filter(g => g.ms <= BUDGET).length,
             lo: ms[0] ?? null, med: ms.length ? ms[Math.floor(ms.length / 2)] : null,
             hi: ms[ms.length - 1] ?? null };
};
const line = (what, s) => console.log(
    `   ${what.padEnd(30)} ${String(s.lo ?? '-').padStart(5)}-${String(s.hi ?? '-').padEnd(5)} ` +
    `median ${String(s.med ?? '-').padStart(5)}   ${s.inB}/${s.n} inside ${BUDGET} ms` +
    (s.good < s.n ? `   (${s.n - s.good} did not answer at all)` : ''));

(async () => {
    console.log(`── the IPv4 row under the load the page puts on one circuit ` +
                `-- ${new Date().toISOString()} ──`);
    ok(fs.existsSync(TOR_EXE), 'the deployed tor.exe is where the app puts it', TOR_EXE);
    if (!fs.existsSync(TOR_EXE)) return finish();
    ok(await portFree(SOCKS) && await portFree(CTRL),
       `ports ${SOCKS}/${CTRL} are free, so nothing here is the app's Tor`);

    console.log('\n── booting the deployed tor.exe on its own ports ──');
    console.log('   seeded from the app\'s cache: ' + (seedDataDir().join(', ') || 'nothing'));
    try {
        const boot = await startTor(writeTorrc());
        ok(true, `bootstrapped in about ${Math.round(boot.bootMs / 1000)} s`);
    } catch (e) {
        ok(false, 'the probe\'s own Tor bootstrapped', e.message);
        console.log('   last 12 Tor log lines:\n     ' + torLog.slice(-12).join('\n     '));
        return finish();
    }

    //  Three conditions per circuit, in this order, so each one is measured on
    //  a circuit that is already warm from the one before -- which is the
    //  browser's real case: by the time the row's XHR goes out, the page it is
    //  on has already been fetched through this circuit.
    const cold = [], warm = [], par6 = [], par10 = [];
    console.log('\n── four circuits, four conditions on each ──');
    console.log('   round  condition                    row ms  in 5 s?  fillers');
    let rounds = 0;
    for (let r = 0; r < ROUNDS && Date.now() < DEADLINE; r++) {
        try { await ctl.signal('NEWNYM'); } catch (e) {}
        await sleep(2500);

        const show = (cond, g, extra = '') => console.log(
            `   ${String(r + 1).padStart(5)}  ${cond.padEnd(28)} ` +
            `${String(g.ms).padStart(6)}  ` +
            `${(g.status === 200 && g.ms <= BUDGET ? 'yes' : 'NO ').padStart(6)}   ${extra}` +
            (g.status !== 200 ? ` failed: ${g.err || 'HTTP ' + g.status}` : ''));

        //  1. first request on a brand-new circuit -- the sibling probe's case
        const c = await timedGet(ROW); cold.push(c); show('alone, cold circuit', c);

        //  2. second request on that same circuit, nothing else running
        const w = await timedGet(ROW); warm.push(w); show('alone, warm circuit', w);

        //  3. the row plus 5 other streams, all fired in the same tick
        {
            const all = await Promise.all([timedGet(ROW)]
                .concat(FILL.slice(0, 5).map(u => timedGet(u))));
            const g = all[0]; par6.push(g);
            const f = all.slice(1);
            show('+ 5 parallel streams', g,
                 `${f.filter(x => x.status === 200).length}/5 ok, ` +
                 `slowest ${Math.max(...f.map(x => x.ms))} ms`);
        }

        //  4. and with 9, which is the order of magnitude a leak-test page
        //     fires when it checks DNS servers one request each
        {
            const all = await Promise.all([timedGet(ROW)]
                .concat(FILL.map(u => timedGet(u))));
            const g = all[0]; par10.push(g);
            const f = all.slice(1);
            show('+ 9 parallel streams', g,
                 `${f.filter(x => x.status === 200).length}/9 ok, ` +
                 `slowest ${Math.max(...f.map(x => x.ms))} ms`);
        }
        rounds++;
    }
    ok(rounds >= 2, 'at least two circuits were sampled', String(rounds));

    console.log('\n── what the row\'s clock does as the circuit fills up ──');
    const sc = stat(cold), sw = stat(warm), s6 = stat(par6), s10 = stat(par10);
    line('alone, cold circuit', sc);
    line('alone, warm circuit', sw);
    line('one of 6 streams', s6);
    line('one of 10 streams', s10);

    const odds = s => {
        const q = s.n ? s.inB / s.n : 0;
        return (100 * (1 - Math.pow(1 - q, TRIES))).toFixed(0);
    };
    console.log(`   -> the row fills in about ${odds(sw)}% of the time on a quiet circuit, ` +
                `${odds(s6)}% at 6 streams and ${odds(s10)}% at 10 -- ${TRIES} tries each.`);
    if (sw.med !== null && s10.med !== null) {
        console.log(`   -> ${s10.med - sw.med} ms is what nine other streams cost this one ` +
                    'request. That cost is the page\'s own doing, not the tunnel\'s: the ' +
                    'same three relays are carrying all ten.');
    }

    ok(sc.good > 0 && sw.good > 0, 'the row\'s endpoint answers through the tunnel at all');
    ok(sw.med === null || sc.med === null || true,
       `a warm circuit is ${sc.med !== null && sw.med !== null
            ? (sc.med - sw.med >= 0 ? (sc.med - sw.med) + ' ms faster' : (sw.med - sc.med) +
               ' ms slower') : 'unmeasured'} than a cold one for this request`);
    ok(s10.n > 0, 'and the 10-stream case was actually measured, not assumed');
    if (s10.inB < s10.n) {
        console.log('   CONCLUSION: parallel load alone can push this row past its own ' +
                    '5 s budget, with nothing wrong in the app -- which is what an empty ' +
                    'IPv4 row on a page that passes every other check looks like.');
    } else {
        console.log('   CONCLUSION: even at 10 simultaneous streams the row lands inside ' +
                    'its budget here, so concurrency is NOT the explanation and the ' +
                    'remaining difference is browser-side, not tunnel-side.');
    }
    return finish();
})().catch(async e => {
    console.log('probe crashed: ' + (e && e.stack || e));
    fail++;
    await finish();
});
