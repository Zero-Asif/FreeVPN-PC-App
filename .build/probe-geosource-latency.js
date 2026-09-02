'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/probe-geosource-latency.js  --  READ-ONLY, direct (no tunnel).
//
//  .build/probe-ipleak-latency.js measured ipleak.net's HTML page needing
//  11-21 s for its first byte from this machine, one run not answering inside
//  25 s at all, while api.ipify.org and google answered in ~0.3 s. DNS was 0-6 ms
//  and TCP 157 ms in every run, so the wait is the server, not this machine's
//  resolver and not the link.
//
//  That was measured against `/` though, and two different things here use
//  DIFFERENT ipleak URLs:
//
//      the browser rows      https://ipv4.ipleak.net/?mode=ajax   (5 s, 3 tries)
//      THIS APP, weight 2    https://ipleak.net/json/             (14 s, once)
//
//  A slow HTML page does not prove the JSON endpoint is slow -- and the
//  difference decides whether there is anything to fix on our side. If
//  /json/ answers quickly then only ipleak's own front-end is broken here and
//  the app is unaffected. If /json/ is slow too, then the source this app
//  trusts MOST is the one least likely to answer, which would quietly turn
//  every connect into "could not be double-checked" and is ours to fix.
//
//  So: every geolocation source the app actually uses, plus the browser row
//  URLs, timed to first byte, three runs each. Nothing written, nothing touched.
// ════════════════════════════════════════════════════════════════════
const dns = require('dns');
const net = require('net');
const tls = require('tls');

//  Kept in step with lib/exit-selector.js GEO_SOURCES by hand on purpose: this
//  is a measurement of named URLs, and importing the list would hide which
//  ones were actually measured.
const TARGETS = [
    ['app  w2  ipleak.net',     'ipleak.net',      '/json/'],
    ['app  w1  geojs.io',       'get.geojs.io',    '/v1/ip/country.json'],
    ['app  w1  country.is',     'api.country.is',  '/'],
    ['app  w1  ipinfo.io',      'ipinfo.io',       '/json'],
    ['row  v4  ipv4.ipleak',    'ipv4.ipleak.net', '/?mode=ajax'],
];

const RUNS = 3;
const APP_TIMEOUT_MS = 14000;    // main.js:2170  probeExitLocation({ timeoutMs: 14000 })
const ROW_TIMEOUT_MS = 5000;     // ipleak index.js:72  var timeoutMs = 5000, 3 tries

function once(host, path) {
    return new Promise(resolve => {
        const t = { dns: 0, tcp: 0, tls: 0, first: 0, end: 0, err: null, status: '' };
        const t0 = process.hrtime.bigint();
        const now = () => Number(process.hrtime.bigint() - t0) / 1e6;
        const fail = e => { if (!t.end) { t.err = e.message; t.end = now(); resolve(t); } };

        dns.lookup(host, { family: 4 }, (e, addr) => {
            if (e) return fail(e);
            t.dns = now();
            const sock = net.connect({ host: addr, port: 443 });
            sock.setTimeout(30000, () => fail(new Error('no answer inside 30 s')));
            sock.once('error', fail);
            sock.once('connect', () => {
                t.tcp = now();
                const s = tls.connect({ socket: sock, servername: host, ALPNProtocols: ['http/1.1'] });
                s.once('error', fail);
                s.once('secureConnect', () => {
                    t.tls = now();
                    s.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\n` +
                            'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64)\r\n' +
                            'Accept: */*\r\nAccept-Encoding: identity\r\n' +
                            'Connection: close\r\n\r\n');
                    let buf = '';
                    s.on('data', d => {
                        if (!t.first) { t.first = now(); t.status = (/^HTTP\/1\.\d (\d{3})/.exec(d.toString('latin1')) || [, '?'])[1]; }
                        if (buf.length < 300) buf += d.toString('latin1');
                    });
                    const done = () => {
                        if (t.end) return;
                        t.end = now(); t.head = buf;
                        try { s.destroy(); } catch (x) {}
                        resolve(t);
                    };
                    s.on('end', done);
                    s.on('close', done);
                });
            });
        });
    });
}

const pad = (n, w) => String(n).padStart(w);

(async () => {
    console.log(`── ${new Date().toISOString()},  DIRECT, no proxy, nothing running ──`);
    console.log(`── app allows ${APP_TIMEOUT_MS} ms once;  ipleak's own rows allow ${ROW_TIMEOUT_MS} ms x3 ──\n`);
    console.log('  source                 run   DNS    TCP    TLS   1st byte    total  HTTP   verdict');

    const worst = {};
    for (const [label, host, path] of TARGETS) {
        for (let i = 1; i <= RUNS; i++) {
            const t = await once(host, path);
            if (t.err) {
                console.log(`  ${label.padEnd(21)} ${i}    ${t.err}`);
                worst[label] = 'FAILED';
                continue;
            }
            //  Judged against whichever budget actually applies to this URL.
            const budget = label.startsWith('row') ? ROW_TIMEOUT_MS : APP_TIMEOUT_MS;
            const over = t.first > budget;
            if (over) worst[label] = 'OVER';
            else if (worst[label] !== 'OVER' && worst[label] !== 'FAILED') worst[label] = 'ok';
            console.log(`  ${label.padEnd(21)} ${i} ${pad(t.dns.toFixed(0), 5)} ${pad((t.tcp - t.dns).toFixed(0), 6)} ` +
                        `${pad((t.tls - t.tcp).toFixed(0), 6)} ${pad((t.first - t.tls).toFixed(0), 10)} ` +
                        `${pad(t.end.toFixed(0), 8)}  ${t.status}   ` +
                        (over ? `OVER its ${budget} ms budget` : `within ${budget} ms`));
        }
    }

    console.log('\n  (each column is that stage alone, in ms, not cumulative)\n');
    console.log('── summary ──');
    for (const [label] of TARGETS) console.log(`  ${label.padEnd(21)} ${worst[label] || '?'}`);
})().catch(e => { console.log('ABORT: ' + e.stack); process.exit(3); });
