'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/probe-ipleak-latency.js  --  READ-ONLY, direct (no tunnel).
//
//  .build/probe-ipleak-timeout.js found the number that decides this: ipleak's
//  own AJAX timeout is 5000 ms, tried 3 times, and the row prints "IPv4 test not
//  reachable" when those run out. .build/probe-ipleak.js measured
//  ipv4.ipleak.net answering in ~12.8 s DIRECTLY, with no VPN in the path.
//
//  If that 13 s is real and repeatable, the row cannot pass on this connection
//  with or without the app, and nothing on our side is the cause. But "13 s"
//  is only worth something once it is broken down: 13 s of DNS is a resolver
//  this app interferes with (it sets BuiltInDnsClientEnabled=0 and turns DoH
//  off), and that WOULD be ours. 13 s of waiting for the server's first byte is
//  ipleak being slow and is not.
//
//  So: three runs per host, each split into DNS / TCP / TLS / first byte /
//  total, next to a fast control host. Nothing is written; no setting touched.
// ════════════════════════════════════════════════════════════════════
const dns = require('dns');
const net = require('net');
const tls = require('tls');

const HOSTS = ['ipleak.net', 'ipv4.ipleak.net', 'api.ipify.org', 'www.google.com'];
const RUNS = 3;
const IPLEAK_TIMEOUT_MS = 5000;      // read out of ipleak's own index.js, line 72

const ms = (a, b) => (b - a).toFixed(0).padStart(6);

function once(host) {
    return new Promise(resolve => {
        const t = { dns: 0, tcp: 0, tls: 0, first: 0, end: 0, err: null };
        const t0 = process.hrtime.bigint();
        const now = () => Number(process.hrtime.bigint() - t0) / 1e6;
        const fail = e => { t.err = e.message; t.end = now(); resolve(t); };

        //  lookup(), not resolve(): this is the call the browser's own stack makes,
        //  so a slow OS resolver shows up here exactly as a user would feel it.
        dns.lookup(host, { family: 4 }, (e, addr) => {
            if (e) return fail(e);
            t.dns = now();
            const sock = net.connect({ host: addr, port: 443 });
            sock.setTimeout(25000, () => fail(new Error('tcp/idle timeout')));
            sock.once('error', fail);
            sock.once('connect', () => {
                t.tcp = now();
                const s = tls.connect({ socket: sock, servername: host, ALPNProtocols: ['http/1.1'] });
                s.once('error', fail);
                s.once('secureConnect', () => {
                    t.tls = now();
                    s.write(`GET / HTTP/1.1\r\nHost: ${host}\r\n` +
                            'User-Agent: Mozilla/5.0\r\nAccept: */*\r\n' +
                            'Accept-Encoding: identity\r\nConnection: close\r\n\r\n');
                    let bytes = 0;
                    s.on('data', d => { if (!t.first) t.first = now(); bytes += d.length; });
                    const done = () => {
                        if (t.end) return;
                        t.end = now(); t.bytes = bytes;
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

(async () => {
    console.log(`── ${new Date().toISOString()},  direct, no proxy ──`);
    console.log(`── ipleak gives each row ${IPLEAK_TIMEOUT_MS} ms, 3 tries ──\n`);
    console.log('  host                run     DNS     TCP     TLS   1st byte   total   verdict');
    for (const host of HOSTS) {
        for (let i = 1; i <= RUNS; i++) {
            const t = await once(host);
            if (t.err) {
                console.log(`  ${host.padEnd(18)} ${i}    ${t.err}`);
                continue;
            }
            //  The comparison that matters: would ipleak's own 5 s have expired
            //  before this answer arrived?
            const verdict = t.first > IPLEAK_TIMEOUT_MS ? 'OVER ipleak\'s 5 s' : 'within 5 s';
            console.log(`  ${host.padEnd(18)} ${i}  ${ms(0, t.dns)}  ${ms(t.dns, t.tcp)}  ` +
                        `${ms(t.tcp, t.tls)}  ${ms(t.tls, t.first)}   ${ms(0, t.end)}   ${verdict}`);
        }
    }
    console.log('\n  (columns are each stage on its own, in ms, not cumulative)');
})().catch(e => { console.log('ABORT: ' + e.stack); process.exit(3); });
