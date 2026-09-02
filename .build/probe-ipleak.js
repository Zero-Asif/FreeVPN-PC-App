'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/probe-ipleak.js  --  READ-ONLY measurement. Two passes, and the
//  DIRECT one needs nothing running.
//
//  The report is "ipleak shows no IPv4". Two very different things produce that
//  and they want opposite fixes:
//
//    a) the row's own endpoint cannot be reached AT ALL, from anywhere -- the
//       site's problem, and nothing on our side can put an address in that row
//    b) it answers fine directly but not through the tunnel -- ours, and worth
//       finding out where it dies
//
//  MEASURED already, from ipleak's own front-end (.build/probe-ipleak-js.js):
//  the two rows are plain cross-origin AJAX GETs and nothing more --
//
//      ipv4_address  ->  https://ipv4.ipleak.net/?mode=ajax
//      ipv6_address  ->  https://ipv6.ipleak.net/?mode=ajax
//
//  and each prints "IPvX test not reachable (<jQuery error>)" when its GET does
//  not come back. So those two URLs are the whole question.
//
//  Reported per target: DNS (A and AAAA separately -- a host with no A record
//  cannot be reached at all with IPv6 switched off, and that would be the
//  answer), the direct result including the CORS header the browser needs, and
//  the result through the app's SOCKS port. Timed, because a row that fails on a
//  timeout and one that fails on a refused connection are different problems.
//
//  Nothing is written and no setting is touched.
// ════════════════════════════════════════════════════════════════════
const dns = require('dns');
const net = require('net');
const https = require('https');
const { socksGet } = require('../lib/socks-fetch');

const SOCKS_PORT = 9050;                 // main.js: SocksPort 127.0.0.1:9050

const TARGETS = [
    ['ipleak main page   ipleak.net',                 'https://ipleak.net/'],
    ['ipleak IPv4 row    ipv4.ipleak.net',            'https://ipv4.ipleak.net/?mode=ajax'],
    ['ipleak IPv6 row    ipv6.ipleak.net',            'https://ipv6.ipleak.net/?mode=ajax'],
    //  A second opinion, so one site behaving oddly is not mistaken for the
    //  connection behaving oddly.
    ['second opinion v4  api.ipify.org',              'https://api.ipify.org/?format=json'],
    ['second opinion v6  api6.ipify.org',             'https://api6.ipify.org/?format=json'],
];

//  ipleak's ajax rows answer with HTML, not JSON, so the address is pulled out of
//  it. Both families in one pattern -- a v6 answer here would be the finding.
const ADDR = /\b((?:\d{1,3}\.){3}\d{1,3}|[0-9a-f]{1,4}(?::[0-9a-f]{0,4}){2,7})\b/i;

const what = body => {
    try { const j = JSON.parse(body); if (j.ip) return 'ip=' + j.ip; } catch (e) {}
    const m = ADDR.exec(body || '');
    return m ? 'address seen: ' + m[1] : 'no address in the body';
};

//  Sent WITH an Origin header, because that is the request the browser makes and
//  because Access-Control-Allow-Origin is often only echoed when one is present.
//  Without CORS the row fails in a browser no matter how healthy the endpoint is.
function browserLikeGet(url, timeoutMs) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
                              '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
                'Accept': '*/*',
                'Accept-Encoding': 'identity',
                'Origin': 'https://ipleak.net',
                'Referer': 'https://ipleak.net/',
            },
            timeout: timeoutMs,
        }, res => {
            const chunks = [];
            res.on('data', d => { if (chunks.length < 400) chunks.push(d); });
            res.on('end', () => resolve({
                status: res.statusCode, headers: res.headers,
                body: Buffer.concat(chunks).toString('utf8'),
            }));
        });
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', reject);
    });
}

const lookup = (host, family) => new Promise(res => {
    dns.resolve(host, family === 4 ? 'A' : 'AAAA', (e, r) => res(e ? 'none (' + e.code + ')' : r.join(' ')));
});

const portOpen = port => new Promise(res => {
    const s = net.connect({ host: '127.0.0.1', port });
    const done = v => { try { s.destroy(); } catch (e) {} res(v); };
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
    setTimeout(() => done(false), 1500);
});

(async () => {
    console.log(`── ${new Date().toISOString()} ──\n`);

    console.log('── DNS, resolved by this machine (not by an exit) ──');
    for (const host of ['ipleak.net', 'ipv4.ipleak.net', 'ipv6.ipleak.net',
                        'api.ipify.org', 'api6.ipify.org']) {
        const [a, aaaa] = await Promise.all([lookup(host, 4), lookup(host, 6)]);
        console.log(`  ${host.padEnd(18)} A: ${String(a).padEnd(34)} AAAA: ${aaaa}`);
    }

    console.log('\n── DIRECT, not through the tunnel: is the endpoint alive at all? ──');
    for (const [label, url] of TARGETS) {
        const t0 = Date.now();
        let line;
        try {
            const r = await browserLikeGet(url, 20000);
            const acao = r.headers['access-control-allow-origin'];
            line = `HTTP ${r.status}  ${what(r.body)}  (${r.body.length} bytes)  ` +
                   `CORS: ${acao === undefined ? 'NO Access-Control-Allow-Origin' : acao}`;
        } catch (e) {
            line = 'FAILED: ' + e.message;
        }
        console.log(`  ${label}\n      ${line}   [${Date.now() - t0} ms]`);
    }

    console.log(`\n── THROUGH SOCKS5 127.0.0.1:${SOCKS_PORT} ──`);
    if (!await portOpen(SOCKS_PORT)) {
        console.log(`  SKIPPED: nothing is listening on 127.0.0.1:${SOCKS_PORT}.\n` +
                    '  Tor only listens while the app is CONNECTED, so this half says nothing\n' +
                    '  until it is. The direct pass above is unaffected.');
        return;
    }
    for (const [label, url] of TARGETS) {
        const t0 = Date.now();
        let line;
        try {
            const r = await socksGet(url, { socksPort: SOCKS_PORT, timeoutMs: 30000 });
            line = `HTTP ${r.status}  ${what(r.body)}  (${r.body.length} bytes)`;
        } catch (e) {
            line = 'FAILED: ' + e.message;
        }
        console.log(`  ${label}\n      ${line}   [${Date.now() - t0} ms]`);
    }
})().catch(e => { console.log('ABORT: ' + e.stack); process.exit(3); });
