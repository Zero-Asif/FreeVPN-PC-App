'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/probe-socks-catches-brave.js  --  positive proof of what is blocking
//  Brave, instead of an inference drawn from silence.
//
//  probe-orphan-pref-applies.js measured silence: three tabs, 70 s, a LAN address
//  the stuck bypass_list does not cover, nothing arrived. Silence is weak evidence.
//  It reads identically whether the proxy pref is in force or Brave simply had no
//  route at that moment -- and the interface that probe picked, 192.168.137.1 on
//  the Mobile-Hotspot/ICS adapter, is not the one an earlier run used, so "no
//  route" is a live alternative rather than a pedantic one.
//
//  So this probe listens where the pref points. A stub SOCKS5 server binds
//  127.0.0.1:9050 -- exactly the endpoint in the stuck record
//  {"mode":"fixed_servers","server":"socks5://127.0.0.1:9050"} -- and completes the
//  CONNECT for real, so the page loads. Then:
//
//    a CONNECT arrives on 9050    -> the pref IS in force, measured at the endpoint
//                                    it names. With probe-strand-owner.js showing
//                                    the LIVE id holding preferences:{}, the record
//                                    being applied can only be the FOSSIL one, and
//                                    no edit to Extension/background.js can release
//                                    another extension's pref.
//    no CONNECT, page hit arrives -> no extension proxy pref is in force at all;
//                                    the earlier silence was a routing artifact and
//                                    that verdict has to be withdrawn.
//    neither                      -> Brave is reaching nothing, for a reason that is
//                                    not this pref and that this probe cannot name.
//
//  Reads and listens only. No file is written, no pref is touched, and the only
//  process it starts is the Brave it also closes.
// ════════════════════════════════════════════════════════════════════
const fs = require('fs');
const os = require('os');
const net = require('net');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

const BRAVE = 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe';
const WINDOW_MS = 40000;

const running = name => {
    try {
        return execFileSync('tasklist', ['/FI', `IMAGENAME eq ${name}`], { encoding: 'utf8' })
            .toLowerCase().includes(name.toLowerCase());
    } catch (e) { return false; }
};

//  Every private IPv4 on the box, not just the first: the earlier probe took
//  whichever came first and that turned out to be the hotspot adapter. Each one is
//  control-fetched from node before Brave is ever asked for it, so an address that
//  is not reachable at all cannot be mistaken for one the proxy swallowed.
function lanAddresses() {
    const out = [];
    for (const [name, addrs] of Object.entries(os.networkInterfaces()))
        for (const a of addrs || [])
            if (a.family === 'IPv4' && !a.internal &&
                /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address))
                out.push({ name, address: a.address });
    return out;
}

//  A measurement taken in the wrong state reads as a clean bill of health, so every
//  precondition aborts rather than warns.
const pre = [];
if (!fs.existsSync(BRAVE)) pre.push('brave.exe not found at ' + BRAVE);
if (running('FreeProxy VPN.exe')) pre.push('the desktop app is RUNNING -- shut it down first');
if (running('tor.exe')) pre.push('tor.exe is running and already owns 9050');
if (running('brave.exe')) pre.push('brave.exe is already running -- those tabs are the user\'s, ' +
                                   'and a reused window would not re-read the proxy pref');
const lans = lanAddresses();
if (!lans.length) pre.push('no private LAN IPv4 address on this machine');

console.log('══ preconditions ══');
console.log(`  app running       ${running('FreeProxy VPN.exe') ? 'YES' : 'no'}`);
console.log(`  brave running     ${running('brave.exe') ? 'YES' : 'no'}`);
lans.forEach(l => console.log(`  private IPv4      ${l.address}   (${l.name})`));
if (pre.length) {
    console.log('\nABORT: ' + pre.join('\n       '));
    process.exit(3);
}

// ── the stub the stuck record points at ─────────────────────────────
//  Minimal SOCKS5: greet, accept "no auth", accept CONNECT, dial the real
//  destination, tunnel. It completes for real, because a stub that refused would
//  produce the same error page as no stub at all and the tab would then add nothing
//  to what the CONNECT already said.
const CONNECTS = [];
const HITS = [];
let T0 = Date.now();
const rel = () => String(Date.now() - T0).padStart(6) + ' ms';

const socks = net.createServer(sock => {
    let stage = 0, buf = Buffer.alloc(0);
    sock.on('error', () => {});
    sock.on('data', chunk => {
        if (stage === 3) return;                 // piped; the pipe owns the bytes now
        buf = Buffer.concat([buf, chunk]);
        if (stage === 0) {
            if (buf.length < 2) return;
            const n = buf[1];                    // nmethods
            if (buf.length < 2 + n) return;
            buf = buf.subarray(2 + n);
            stage = 1;
            sock.write(Buffer.from([0x05, 0x00]));            // version 5, no auth
        }
        if (stage === 1) {
            if (buf.length < 5) return;
            const atyp = buf[3];
            let host, hlen;
            if (atyp === 1) { hlen = 4; host = buf.subarray(4, 8).join('.'); }
            else if (atyp === 3) { hlen = 1 + buf[4]; host = buf.subarray(5, 4 + hlen).toString(); }
            else if (atyp === 4) { hlen = 16; host = '[ipv6]'; }
            else { sock.end(); return; }
            if (buf.length < 4 + hlen + 2) return;
            const port = buf.readUInt16BE(4 + hlen);
            buf = buf.subarray(4 + hlen + 2);
            stage = 2;
            CONNECTS.push({ at: Date.now() - T0, host, port });
            console.log(`  ${rel()}  SOCKS5 CONNECT ${host}:${port}   <-- arrived on 127.0.0.1:9050`);
            const up = net.connect(port, host, () => {
                sock.write(Buffer.from([0x05, 0, 0, 1, 0, 0, 0, 0, 0, 0]));   // succeeded
                if (buf.length) up.write(buf);
                stage = 3;
                sock.pipe(up); up.pipe(sock);
            });
            up.on('error', () => {
                try { sock.write(Buffer.from([0x05, 4, 0, 1, 0, 0, 0, 0, 0, 0])); } catch (e) {}
                sock.end();
            });
        }
    });
});

const target = http.createServer((req, res) => {
    if (!/^\/control/.test(req.url)) {
        HITS.push({ at: Date.now() - T0, url: req.url });
        console.log(`  ${rel()}  PAGE HIT ${req.url}`);
    }
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
    res.end('<!doctype html><title>reached</title><h1>reached</h1>');
});

//  Node honours no browser proxy pref, so this answers "is the target reachable at
//  that address at all". Without it a firewalled or down interface produces silence
//  and reads as a proxy in force -- the one wrong conclusion this probe exists to
//  avoid.
function control(url) {
    return new Promise(resolve => {
        const req = http.get(url, r => { r.resume(); resolve(r.statusCode); });
        req.on('error', e => resolve('ERROR ' + e.code));
        req.setTimeout(4000, () => { req.destroy(); resolve('TIMEOUT'); });
    });
}

async function main() {
    const port = target.address().port;
    console.log(`  target http server on 0.0.0.0:${port}`);

    const good = [];
    for (const l of lans) {
        const code = await control(`http://${l.address}:${port}/control`);
        console.log(`  control fetch ${l.address.padEnd(15)} ${code}   (${l.name})`);
        if (code === 200) good.push(l);
    }
    if (!good.length) {
        console.log('\nABORT: node cannot reach its own target on any private address, so silence ' +
                    'from Brave\n       would prove nothing.');
        process.exit(3);
    }

    //  One tab per reachable address. The stuck bypass_list is
    //  "localhost,127.0.0.1,<local>" and <local> means dotless hostnames, not
    //  private ranges, so none of these are exempt from the proxy if it is on.
    T0 = Date.now();
    const urls = good.map((l, i) => `http://${l.address}:${port}/probe-${i + 1}`);
    console.log(`\n══ launching brave with ${urls.length} tab(s) ══`);
    urls.forEach(u => console.log(`  ${u}`));
    const p = spawn(BRAVE, ['--no-default-browser-check', ...urls], { detached: true, stdio: 'ignore' });
    p.unref();
    setTimeout(() => console.log(`  ${rel()}  brave.exe running: ` +
        `${running('brave.exe') ? 'yes' : 'NO -- it did not start'}`), 6000);

    await new Promise(r => setTimeout(r, WINDOW_MS));

    console.log('\n══ verdict ══');
    let code = 1;
    if (CONNECTS.length) {
        code = 0;
        console.log(`  ${CONNECTS.length} SOCKS5 CONNECT(s) arrived on 127.0.0.1:9050.`);
        console.log('  The extension proxy pref IS in force with the app shut down. This is measured');
        console.log('  at the endpoint the pref names, not inferred from a page that failed to load.');
        console.log('  probe-strand-owner.js read the LIVE id as holding preferences:{}, so the');
        console.log('  record being applied is the FOSSIL one -- and nothing inside');
        console.log('  Extension/background.js can release another extension\'s pref. The onRemoved');
        console.log('  release fixes profiles going forward; it cannot clear what is already stuck.');
    } else if (HITS.length) {
        code = 0;
        console.log(`  no CONNECT on 9050, and ${HITS.length} page hit(s) arrived directly.`);
        console.log('  No extension proxy pref is in force. The 70 s of silence in');
        console.log('  probe-orphan-pref-applies.js was an artifact of the address it picked, and');
        console.log('  that verdict is withdrawn: the fossil record is inert residue.');
    } else {
        console.log('  nothing on 9050 and nothing on the target. Brave reached neither the proxy');
        console.log('  endpoint nor the page, so whatever stops it is not this pref, and this probe');
        console.log('  cannot name it. Do not read this as either verdict.');
    }
    CONNECTS.forEach(c => console.log(`    ${String(c.at).padStart(6)} ms  CONNECT ${c.host}:${c.port}`));
    HITS.forEach(h => console.log(`    ${String(h.at).padStart(6)} ms  PAGE    ${h.url}`));

    //  Closed, not killed: /F would skip the profile write. The preconditions already
    //  established no Brave was running, so every window here was opened by this probe.
    console.log('\n  closing the Brave this probe started (gracefully -- its own tabs only)');
    try { execFileSync('taskkill', ['/IM', 'brave.exe'], { stdio: 'ignore' }); } catch (e) {}
    socks.close(); target.close();
    console.log('\nNo file was modified by this probe.');
    process.exit(code);
}

socks.on('error', e => {
    console.log(`\nABORT: cannot bind 127.0.0.1:9050 -- ${e.code}. Something else owns it, so a ` +
                'CONNECT\n       arriving there would not be ours to read.');
    process.exit(3);
});
socks.listen(9050, '127.0.0.1', () => {
    console.log('\n  stub SOCKS5 listening on 127.0.0.1:9050 (the endpoint the stuck pref names)');
    target.listen(0, '0.0.0.0', main);
});
