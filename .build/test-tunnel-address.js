'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/test-tunnel-address.js  --  the adapter's address must be waited for,
//                                     not read once.
//
//  Measured with .build/probe-tun-address.js on this machine, elevated:
//    adapter appears at ifIndex 51 after 3419 ms, interface state Connected
//    set address              -> ok, no output
//    t+1000 ms  netsh: "(no IP Address line)"   Get-NetIPAddress: 169.254.167.64,10.77.77.1
//    t+2000 ms  netsh: "IP Address: 10.77.77.1" Get-NetIPAddress: 10.77.77.1
//
//  The address is applied immediately and is simply tentative, so netsh prints
//  no IP Address line for about a second and a half. _configureAdapter() used
//  to read once, straight after netsh returned, and reported "the adapter did
//  not take its address" -- so the full-device tunnel refused to start on an
//  adapter that was correctly configured. That is a second, independent cause
//  of the same symptom the single-dash argv bug produced.
// ════════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const { stripComments } = require('./srcstrip.js');

const ROOT = path.join(__dirname, '..');
//  FP_TUNNEL points this suite at another copy of lib/tunnel.js, which is how
//  the pre-fix version is shown failing rather than described as failing.
const SRC  = process.env.FP_TUNNEL || path.join(ROOT, 'lib', 'tunnel.js');
const { Tunnel, TUN_ADDR } = require(SRC);

let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
    if (cond) { pass++; console.log('  ok   ' + name); }
    else { fail++; console.log('  FAIL ' + name + (extra ? '  -- ' + extra : '')); }
};

const silent = { info: () => {}, warn: () => {}, error: () => {},
                 success: () => {}, debug: () => {} };
const T = () => new Tunnel({ Logger: silent, binDir: path.join(__dirname, 'no-such-dir') });

//  netsh's real output in both states, so the strings under test are the ones
//  the machine actually produced rather than something shaped to pass.
const ABSENT = 'Configuration for interface "FreeProxyTun"\r\n' +
               '    DHCP enabled:                         No\r\n' +
               '    InterfaceMetric:                      5\r\n';
const PRESENT = 'Configuration for interface "FreeProxyTun"\r\n' +
                '    DHCP enabled:                         No\r\n' +
                '    IP Address:                           ' + TUN_ADDR + '\r\n' +
                '    Subnet Prefix:                        10.77.77.0/24 (mask 255.255.255.0)\r\n' +
                '    InterfaceMetric:                      5\r\n';

(async () => {
console.log('── the wait itself ──');

//  Absent on the version that shipped, so every check below has to say so by
//  name instead of the suite dying on the first call.
const HAS = typeof Tunnel.prototype._awaitAddress === 'function';
ok(HAS, 'lib/tunnel.js has a bounded wait for the address at all',
   'no _awaitAddress -- this copy reads the address exactly once');
const awaitAddr = (t, ...a) => HAS ? t._awaitAddress(...a)
                                   : Promise.resolve({ missing: true, tries: 0 });

//  A reader that behaves like the measurement: absent, absent, then there.
{
    let reads = 0, naps = 0;
    const r = await awaitAddr(T(),
        () => { reads++; return Promise.resolve({ ok: true, out: reads < 3 ? ABSENT : PRESENT }); },
        8000, 400, () => { naps++; return Promise.resolve(); });
    ok(!r.missing && r.ok === true, 'an address that shows up on the third read is found', JSON.stringify(r));
    ok(!r.missing && r.tries === 3, 'and it took exactly three reads to see it', 'tries=' + r.tries);
    ok(!r.missing && naps === 2, 'with one wait between each pair of reads, not before the first',
       'naps=' + naps);
}

//  The first read hitting must cost nothing extra: this runs on every connect.
{
    let naps = 0;
    const r = await awaitAddr(T(), () => Promise.resolve({ ok: true, out: PRESENT }),
                              8000, 400, () => { naps++; return Promise.resolve(); });
    ok(!r.missing && r.ok === true && r.tries === 1,
       'an address that is already there is found on read one', JSON.stringify(r));
    ok(!r.missing && naps === 0, 'and nothing sleeps at all in that case', 'naps=' + naps);
}

//  It has to give up, and say how hard it tried.
{
    let naps = 0;
    const r = await awaitAddr(T(), () => Promise.resolve({ ok: true, out: ABSENT }),
                              8000, 400, () => { naps++; return Promise.resolve(); });
    ok(!r.missing && r.ok === false, 'an address that never appears is reported absent, not assumed',
       JSON.stringify({ ok: r.ok, tries: r.tries }));
    ok(!r.missing && r.tries === 20, 'after 8000/400 = 20 reads', 'tries=' + r.tries);
    ok(!r.missing && naps === 19, 'and 19 waits between them', 'naps=' + naps);
    ok(!r.missing && typeof r.out === 'string' && /InterfaceMetric/.test(r.out),
       'and it hands back what netsh last said, so the log names the real state');
}

//  A failing netsh is not an answer. Without this, `ok:false` plus an address
//  left over in stderr would read as success.
{
    const r = await awaitAddr(T(),
        () => Promise.resolve({ ok: false, out: PRESENT }), 800, 400,
        () => Promise.resolve());
    ok(!r.missing && r.ok === false, 'a netsh that FAILED is never read as a hit, even if the ' +
                                     'address is somewhere in its output');
}

//  A wait shorter than one poll still reads once rather than zero times.
{
    let reads = 0;
    const r = await awaitAddr(T(),
        () => { reads++; return Promise.resolve({ ok: true, out: PRESENT }); },
        0, 400, () => Promise.resolve());
    ok(!r.missing && reads === 1 && r.ok === true, 'a zero wait still reads once', 'reads=' + reads);
}

console.log('── and _configureAdapter uses it ──');
const code = stripComments(fs.readFileSync(SRC, 'utf8'));

ok(/_awaitAddress\(\(\) => netsh\(/.test(code),
   'the read-back in _configureAdapter goes through the wait');

//  The exact shape that shipped: one netsh, one includes(), no loop.
ok(!/const chk = await netsh\(\[[^\]]*'show', 'addresses'/.test(code),
   'and the single read it replaced is gone');

const waitMs = Number((/const ADDR_WAIT_MS = (\d+)/.exec(code) || [])[1]);
const pollMs = Number((/const ADDR_POLL_MS = (\d+)/.exec(code) || [])[1]);
ok(waitMs >= 4000,
   'the wait leaves real room over the ~2000 ms measured here -- a floor, not a pin',
   'ADDR_WAIT_MS=' + waitMs);
ok(pollMs > 0 && pollMs <= 1000,
   'and it re-reads often enough that a fast machine is not made to wait',
   'ADDR_POLL_MS=' + pollMs);

//  A failed read-back must still refuse. The wait must not have turned into a
//  shrug on the way in.
{
    const t = T();
    t._ifIndex = 99;
    const src = fs.readFileSync(SRC, 'utf8');
    ok(/return \{ ok: false, reason: 'adapter address read-back mismatch' \};/.test(src),
       'and when the wait runs out the tunnel is still refused, not reported up');
}

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
})();
