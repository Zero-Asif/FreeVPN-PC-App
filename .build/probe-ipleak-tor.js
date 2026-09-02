'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/probe-ipleak-tor.js  --  can ipleak's IPv4 row finish in time
//  THROUGH the tunnel? Read-only: nothing is written outside %TEMP%, no
//  setting is touched, and it never uses the app's Tor -- it boots the
//  deployed tor.exe on its own ports with a COPY of the consensus cache.
//
//  What is already established, so it is not guessed at again here:
//
//    * ipleak's front page fills those two rows with plain cross-origin
//      AJAX GETs -- ipv4_address <- https://ipv4.ipleak.net/?mode=ajax,
//      ipv6_address <- https://ipv6.ipleak.net/?mode=ajax
//      (.build/probe-ipleak-js.js, read out of its own index.js).
//    * Each row gets 5000 ms per try and three tries, then prints
//      "IPv4 test not reachable (timeout)" -- which is exactly the text
//      in the screenshot (.build/probe-ipleak-timeout.js).
//    * IPv6 failing is this app working as designed: ClientUseIPv6 0
//      and NoIPv6Traffic on every listener. There is no IPv6 to show.
//
//  So the only open question is the IPv4 row's clock, and it needs THREE
//  numbers, not one. ipv4.ipleak.net answers directly today in about
//  2.9 s, of which ~2.5 s is the server thinking before its first byte
//  (.build/probe-ipleak-latency.js, same day as this run). A control
//  host that answers directly in 0.3 s is fetched through the same
//  circuit in the same round, so its total IS this circuit's overhead,
//  and "ipleak is slow" can be told apart from "Tor is slow".
//
//  A fresh circuit per round, because the browser opens these two
//  requests on a circuit it did not choose either.
// ════════════════════════════════════════════════════════════════════

const { spawn } = require('child_process');
const fs   = require('fs');
const os   = require('os');
const net  = require('net');
const path = require('path');

const { socksGet } = require('../lib/socks-fetch.js');
const { TorControl } = require('../lib/tor-control.js');

const SOCKS  = Number(process.env.PI_SOCKS) || 9350;
const CTRL   = Number(process.env.PI_CTRL)  || 9351;
const ROUNDS = Number(process.env.PI_N)     || 6;
const BUDGET = 5000;    // ipleak's own per-try AJAX timeout, out of its index.js
const TRIES  = 3;       // and how many times it retries before printing "timeout"

const TOR_EXE  = 'C:/ProgramData/freeproxy-vpn/Tor/tor/tor.exe';
const APP_DATA = 'C:/ProgramData/freeproxy-vpn/Tor/data';
const WORK = path.join(os.tmpdir(), 'fp-ipleak-tor');
const DATA = path.join(WORK, 'data');
const DEADLINE = Date.now() + (Number(process.env.PI_MINUTES) || 9) * 60 * 1000;

const LOG = path.join(__dirname, 'probe-ipleak-tor.log');
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

//  The two rows in the screenshot, plus a control. The control is not
//  decoration: without it, a slow total cannot be attributed, and the
//  difference between "ipleak is slow" and "this tunnel is slow" is the
//  difference between a bug we can fix and one we cannot.
const TARGETS = [
    ['ipv4.ipleak.net', 'https://ipv4.ipleak.net/?mode=ajax', true ],
    ['ipleak.net',      'https://ipleak.net/?mode=ajax',      false],
    ['api.ipify.org',   'https://api.ipify.org/',             false],
];

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

//  The app's cache is COPIED out, never used in place and never written to,
//  so the app's own Tor state cannot be disturbed by this run.
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

//  The shipped listener line, verbatim -- IPv4Traffic NoIPv6Traffic
//  NoPreferIPv6Automap -- because that is the setting the IPv6 row dies on
//  and a probe that quietly allowed IPv6 would be measuring another app.
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
        const m = /PROGRESS=(\d+)/.exec(phase);
        if (m && Number(m[1]) >= 100) return { bootMs: i * 1000, phase };
        await sleep(1000);
    }
    throw new Error('bootstrap never reached 100%: ' + last);
}

//  One request, the way the browser makes it: a brand-new connection through
//  the SOCKS port, and the clock stopped when the body is in hand. The timeout
//  is deliberately far past ipleak's 5 s -- a request that takes 9 s has told
//  us something a request recorded as "failed at 5 s" would not.
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/;
async function timedGet(url) {
    const t0 = Date.now();
    try {
        const r = await socksGet(url, { socksPort: SOCKS, timeoutMs: 20000,
                                        maxBytes: 64 * 1024 });
        const ms = Date.now() - t0;
        const m = IPV4.exec(r.body || '');
        return { ms, status: r.status, ip: m ? m[0] : null,
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

(async () => {
    console.log(`── ipleak's IPv4 row, through Tor -- ${new Date().toISOString()} ──`);
    console.log(`── its own budget: ${BUDGET} ms per try, ${TRIES} tries ──`);
    ok(fs.existsSync(TOR_EXE), 'the deployed tor.exe is where the app puts it', TOR_EXE);
    if (!fs.existsSync(TOR_EXE)) return finish();
    ok(await portFree(SOCKS) && await portFree(CTRL),
       `ports ${SOCKS}/${CTRL} are free, so nothing here can be the app's Tor`);

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

    console.log('\n── a fresh circuit each round, three GETs on it ──');
    console.log('   round  host              ms  in 5 s?  what came back');
    const per = new Map(TARGETS.map(([n]) => [n, []]));
    let rounds = 0;
    for (let r = 0; r < ROUNDS && Date.now() < DEADLINE; r++) {
        try { await ctl.signal('NEWNYM'); } catch (e) {}
        await sleep(2500);
        for (const [name, url] of TARGETS) {
            const g = await timedGet(url);
            per.get(name).push(g);
            console.log(`   ${String(r + 1).padStart(5)}  ${name.padEnd(16)} ` +
                        `${String(g.ms).padStart(5)}  ` +
                        `${(g.ms <= BUDGET && g.status === 200 ? 'yes' : 'NO ').padStart(6)}   ` +
                        (g.status === 200
                            ? `HTTP 200${g.ip ? ', ip ' + g.ip : ', no ip in body'}` +
                              `${g.cors ? ', CORS ' + g.cors : ', no CORS header'}`
                            : `failed: ${g.err || 'HTTP ' + g.status}`));
        }
        rounds++;
    }
    ok(rounds >= 3, 'at least three circuits were sampled', String(rounds));

    console.log('\n── what that means ──');
    const stat = name => {
        const a = per.get(name);
        const good = a.filter(g => g.status === 200);
        const inB = good.filter(g => g.ms <= BUDGET);
        const ms = good.map(g => g.ms).sort((x, y) => x - y);
        return { a, good, inB, med: ms.length ? ms[Math.floor(ms.length / 2)] : null,
                 lo: ms[0] ?? null, hi: ms[ms.length - 1] ?? null };
    };
    const ctrl = stat('api.ipify.org');
    const v4   = stat('ipv4.ipleak.net');
    const main = stat('ipleak.net');

    console.log(`   control (api.ipify.org, 0.3 s direct): ${ctrl.lo}-${ctrl.hi} ms ` +
                `through these circuits, median ${ctrl.med} -- that is what Tor itself ` +
                'costs on a fresh connection');
    console.log(`   ipv4.ipleak.net (2.9 s direct today): ${v4.lo}-${v4.hi} ms, ` +
                `median ${v4.med}; ${v4.inB.length} of ${v4.a.length} tries inside ${BUDGET} ms`);
    console.log(`   ipleak.net      : ${main.lo}-${main.hi} ms, median ${main.med}; ` +
                `${main.inB.length} of ${main.a.length} inside ${BUDGET} ms`);

    //  Per-try success is what the row's three retries are drawn from, so the
    //  chance the row fills in is 1 - (1 - q)^3. Stated as a probability
    //  because that is what it is: the same tunnel can pass and fail the same
    //  row minutes apart, which is exactly what "Try 2/3" on screen means.
    const q = v4.a.length ? v4.inB.length / v4.a.length : 0;
    const rowOdds = 1 - Math.pow(1 - q, TRIES);
    console.log(`   -> a single try passes ${(q * 100).toFixed(0)}% of the time here, so with ` +
                `${TRIES} tries the row fills in about ${(rowOdds * 100).toFixed(0)}% of the ` +
                'time and prints "not reachable (timeout)" the rest of the time.');
    if (ctrl.med !== null && v4.med !== null) {
        console.log(`   -> of the ${v4.med} ms median, about ${ctrl.med} ms is the tunnel ` +
                    `(the control's own total) and about ${v4.med - ctrl.med} ms is ` +
                    'ipleak\'s server thinking -- it spends ~2.5 s on that directly too.');
    }
    ok(v4.good.length > 0,
       'ipv4.ipleak.net is reachable through the tunnel at all -- the row is a clock ' +
       'problem, not a blocked route',
       v4.good.length ? '' : 'every try failed outright, which would be a different bug');
    const gotIp = v4.good.find(g => g.ip);
    ok(!!gotIp, 'and when it answers, the body carries an IPv4 address',
       gotIp ? '' : 'answered without an address in it');
    ok(v4.good.every(g => g.cors),
       'every answer carried the CORS header the browser needs to read it',
       v4.good.filter(g => !g.cors).length + ' without it');
    console.log('   IPv6 row: nothing to measure. ClientUseIPv6 0 and NoIPv6Traffic are set ' +
                'on purpose, so ipv6.ipleak.net has no route and "not reachable (error)" is ' +
                'this app working, not failing.');
    return finish();
})().catch(async e => {
    console.log('probe crashed: ' + (e && e.stack || e));
    fail++;
    await finish();
});
