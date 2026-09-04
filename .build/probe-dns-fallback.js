'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/probe-dns-fallback.js
//
//  The port-53 fallback, which is the one branch of this app where doing the
//  obvious thing takes the whole machine off the internet.
//
//  WHAT THE BRANCH IS. Tor's DNSPort wants 127.0.0.1:53. If something else on
//  the PC already holds it -- Pi-hole, Acrylic, a Docker resolver, dnscache
//  refusing to stop -- tor cannot bind and this app retries on 9053. From then
//  on DNS is NOT going through Tor, and main.js's LEAK PROTECTION header states
//  the rule that follows from it: the adapters are only pointed at 127.0.0.1
//  when Tor really got :53, because "pointing Windows at a 127.0.0.1:53 that
//  nothing is listening on does not 'fail safe' -- it kills all name resolution
//  on the machine, VPN or not."
//
//  WHAT WAS WRONG. armWholeMachine() broke that rule from the other side. It
//  called tunnel.start({ ..., dnsIp: '127.0.0.1' }) unconditionally, and
//  lib/tunnel.js pinned that as the tunnel adapter's static primary resolver --
//  so in the fallback the full-device tunnel CREATED the dead resolver the DNS
//  path is careful to avoid. And the user was told nothing: the only mention was
//  a Logger.warn in a file they never open.
//
//  WHAT IS ASSERTED HERE, in order:
//    1. main.js hands the tunnel a resolver only when Tor has one.
//    2. udpPortOwners() -- run for real, against synthetic netstat output --
//       names the process holding :53, and matches the PORT strictly.
//    3. _configureAdapter() issues no `set dnsserver` at all when there is no
//       resolver, and still reads its address back.
//    4. _keepResolversReachable() keeps the machine's own resolvers off the
//       tunnel, so "DNS is not private" never becomes "DNS is not working".
//    5. start() calls it exactly when there is no resolver, before the capture.
//    6. the user is TOLD, by name, with what still works.
//    7. a server switch, which restarts tor WITHOUT rebuilding the tunnel, can
//       change the answer -- and setResolver() re-states the adapter in both
//       directions, leaving the same routes it started with.
//
//  Nothing is re-implemented: every function under test is extracted from the
//  shipped file and run with its own netsh/runQuiet replaced by a recorder.
//
//  Run:  node .build/probe-dns-fallback.js
// ════════════════════════════════════════════════════════════════════
const path = require('path');
const fs   = require('fs');

let pass = 0, fail = 0;
const ok = (c, m, x) => {
    if (c) { pass++; console.log('  ok   ' + m); }
    else { fail++; console.log('  FAIL ' + m + (x ? '\n         ' + String(x) : '')); }
};

const ROOT = path.join(__dirname, '..');
const MAIN = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const TUN  = fs.readFileSync(path.join(ROOT, 'lib', 'tunnel.js'), 'utf8');
//  Comment-stripped copies, because most questions below are about code rather
//  than prose and both files' comments quote the exact expressions being
//  counted -- `dnsIp: '127.0.0.1'` among them, in the sentence saying it was
//  wrong. Same technique as probe-settings-persistence.js, and the stripper is
//  self-tested at the end of section 1.
const strip = s => s.split('\n').map(l => (/^\s*\/\//.test(l) ? '' : l)).join('\n');
const MAIN_CODE = strip(MAIN), TUN_CODE = strip(TUN);

//  Brace-matched from a known opening line, so a `}` inside the body does not
//  end the extraction early.
function extract(src, opener) {
    const at = src.indexOf(opener);
    if (at < 0) throw new Error('not found: ' + opener);
    let d = 0;
    for (let i = at; i < src.length; i++) {
        if (src[i] === '{') d++;
        else if (src[i] === '}' && --d === 0) return src.slice(at, i + 1);
    }
    throw new Error('unbalanced: ' + opener);
}
//  A class method's text is not a function declaration. Turning `async _x(a) {`
//  into `async function _x(a) {` is the whole conversion; the body is untouched,
//  and `this` is supplied by calling it as a property of the fake object below.
const asFn = (src, name) => extract(src, `async ${name}(`)
    .replace(new RegExp('^async ' + name + '\\('), `async function ${name}(`);

console.log('=== probe-dns-fallback ===\n');

// ── 1. main.js: the tunnel gets a resolver only if Tor has one ───────
console.log('-- 1. main.js hands the tunnel a resolver only when Tor has one --');
const START_CALL = (MAIN_CODE.match(/out\.tunnel = await tunnel\.start\(\{[\s\S]{0,240}?\}\);/) || [''])[0];
ok(/dnsIp:\s*dnsViaTor \? '127\.0\.0\.1' : ''/.test(START_CALL),
   'armWholeMachine() passes dnsIp only when dnsViaTor -- an empty string ' +
   'otherwise, which is a value tunnel.js is written to accept', START_CALL);
ok(!/dnsIp:\s*'127\.0\.0\.1'\s*,/.test(MAIN_CODE),
   'and the unconditional `dnsIp: \'127.0.0.1\'` is gone from main.js entirely, ' +
   'so it cannot come back by being left behind at a second call site');
ok(MAIN.includes('LEAK PROTECTION') && !MAIN_CODE.includes('LEAK PROTECTION') &&
   MAIN.includes('no port field') && !MAIN_CODE.includes('no port field'),
   'and the comment-stripped copy really is stripped -- main.js\'s LEAK ' +
   'PROTECTION header and the sentence explaining why dnsIp can be empty are ' +
   'both in the file and neither is in the code, so the search above answered ' +
   'about code. An assertion that cannot fail is worse than no assertion');

//  Order, by line number: armWholeMachine() READS dnsViaTor, so the connect
//  path has to have written it first. Nothing here would fail loudly at
//  runtime if it did not -- it would just quietly use the previous connect's
//  answer, which is the bug class this whole file is about.
const lineOf = re => { const m = MAIN_CODE.match(re); return m ? MAIN_CODE.slice(0, m.index).split('\n').length : -1; };
const L = {
    decl:   lineOf(/let dnsViaTor\s*=/),
    assign: lineOf(/dnsViaTor\s*=\s*\(dnsPort === DNS_PORT\)/),
    arm:    lineOf(/await armWholeMachine\(\{ reason: 'connect'/),
    fault:  lineOf(/reportFault\('DNS is not going through Tor/),
};
ok(L.decl > 0 && L.assign > L.decl && L.arm > L.assign,
   `dnsViaTor is declared (${L.decl}), assigned from this connect's dnsPort ` +
   `(${L.assign}) and only then read by armWholeMachine (${L.arm})`, JSON.stringify(L));
ok(L.fault > L.assign && L.fault < L.arm,
   `and the user is told at ${L.fault}, before the tunnel is even brought up`,
   JSON.stringify(L));

// ── 2. udpPortOwners(), run for real ────────────────────────────────
console.log('\n-- 2. which process holds :53, asked for real --');
//  The shipped function, with runQuiet replaced by a recorder that answers with
//  netstat/tasklist text instead of running them. Two things are under test: the
//  parse, and that this function only ever READS.
const OWNERS_SRC = extract(MAIN, 'async function udpPortOwners(port) {');
const ran = [];
const mkOwners = (netstatOut, tasklistOut, netstatOk = true) => new Function('runQuiet',
    `${OWNERS_SRC}\n return udpPortOwners;`)((file, args) => {
        ran.push([file, ...args].join(' '));
        if (file === 'netstat')  return Promise.resolve({ ok: netstatOk, out: netstatOut });
        if (file === 'tasklist') return Promise.resolve({ ok: true, out: tasklistOut });
        return Promise.resolve({ ok: false, out: '' });
    });

//  Real netstat -a -n -o -p UDP shapes, including the ones that must NOT match.
const NETSTAT = [
    '',
    'Active Connections',
    '',
    '  Proto  Local Address          Foreign Address        State           PID',
    '  UDP    0.0.0.0:53             *:*                                    4812',
    '  UDP    0.0.0.0:5353           *:*                                    2200',
    '  UDP    [::]:53                *:*                                    4812',
    '  UDP    127.0.0.1:52217        *:*                                    9001',
    '  UDP    192.168.0.14:1900      *:*                                    3344',
    '',
].join('\r\n');
const TASKLIST = [
    '"pihole.exe","4812","N/A"',
    '"svchost.exe","2200","Dnscache"',
    '"chrome.exe","9001","N/A"',
].join('\r\n');

(async () => {
const one = await mkOwners(NETSTAT, TASKLIST)(53);
ok(one.length === 1 && one[0].pid === '4812' && one[0].name === 'pihole.exe',
   'the holder of :53 is named -- one process, both its rows (0.0.0.0 and [::]) ' +
   'collapsed to one PID', JSON.stringify(one));
ok(one[0].label === 'pihole.exe [PID 4812]',
   'and the label is what the user will read', JSON.stringify(one[0]));
ok(!one.some(o => o.pid === '2200'),
   'the :5353 mDNS row is NOT reported for port 53 -- the address is matched ' +
   'loosely and the port strictly, so a :5353 or a :5300 is a different process');

const svc = await mkOwners(
    '  UDP    0.0.0.0:53             *:*                                    2200',
    TASKLIST)(53);
ok(svc.length === 1 && svc[0].svc === 'Dnscache' &&
   svc[0].label === 'svchost.exe (Dnscache) [PID 2200]',
   'a service host is named by its SERVICE, not just as svchost.exe -- ' +
   '"svchost.exe (Dnscache)" says this app\'s own `net stop dnscache` did not ' +
   'take, which is a different problem with a different answer', JSON.stringify(svc));

const unknown = await mkOwners(
    '  UDP    0.0.0.0:53             *:*                                    7777', '')(53);
ok(unknown.length === 1 && unknown[0].name === 'unknown' &&
   unknown[0].label === 'an unnamed process [PID 7777]',
   'a PID tasklist will not name is still reported as a PID rather than ' +
   'dropped -- the user can look up a PID; they cannot look up silence',
   JSON.stringify(unknown));

const two = await mkOwners([
    '  UDP    0.0.0.0:53             *:*                                    4812',
    '  UDP    192.168.0.14:53        *:*                                    2200',
].join('\r\n'), TASKLIST)(53);
ok(two.length === 2, 'two different holders are both reported', JSON.stringify(two.map(o => o.label)));

ok((await mkOwners(NETSTAT, TASKLIST, false)(53)).length === 0,
   'a netstat that fails yields an empty list, not a throw -- this runs on a ' +
   'path where a connect is already in trouble, and it must not be the reason ' +
   'the connect dies');
ok((await mkOwners('', TASKLIST)(53)).length === 0,
   'and so does a netstat that names nobody, WITHOUT asking tasklist at all');
ok(!ran.some(c => /taskkill|net stop|\/F\b|delete|set /i.test(c)),
   'every command this function ran was a read: ' +
   [...new Set(ran)].join(' | '));
ok(ran.every(c => /^netstat -a -n -o -p UDP$|^tasklist \/SVC \/FO CSV \/NH$/.test(c)),
   'and there were only ever those two commands, with those exact arguments',
   [...new Set(ran)].join(' | '));

// ── 3-5. lib/tunnel.js, run with netsh replaced by a recorder ───────
//  The real constants and the real address filters, lifted out of the shipped
//  file rather than copied: a change to isPrivate4()'s ranges or to TUN_ADDR has
//  to show up here.
const grab = re => { const m = TUN.match(re); if (!m) throw new Error('missing: ' + re); return m[0]; };
const PRELUDE = [
    grab(/const TUN_ADDR = '[^']+';/),
    grab(/const TUN_MASK = '[^']+';/),
    grab(/const IPV4 = \/.*\/;/),
    grab(/const IPV4_ANY = \/.*\/g;/),
    extract(TUN, 'function isRoutableUnicast(ip) {'),
    extract(TUN, 'function isPrivate4(ip) {'),
].join('\n');
const TUN_ADDR = grab(/const TUN_ADDR = '([^']+)';/).match(/'([^']+)'/)[1];

const tunFn = (name, netsh) => new Function('netsh',
    `${PRELUDE}\n${asFn(TUN, name)}\n return ${name};`)(netsh);

//  One fake netsh for all three methods: it records every argv it is handed and
//  answers the two queries the shipped code reads back.
const DNSSERVERS = [
    'Configuration for interface "Wi-Fi"',
    '    Statically Configured DNS Servers:    8.8.8.8',
    '                                          1.1.1.1',
    '    Register with which suffix:           Primary only',
    '',
    'Configuration for interface "Ethernet"',
    '    DNS servers configured through DHCP:  192.168.0.1',
    '',
    'Configuration for interface "Loopback Pseudo-Interface 1"',
    '    Statically Configured DNS Servers:    127.0.0.1',
    '',
].join('\r\n');
const fakeTun = (opts = {}) => {
    const seen = [];
    const netsh = args => {
        const s = args.join(' ');
        seen.push(s);
        if (/show addresses/.test(s)) {
            return Promise.resolve({ ok: true, out: opts.noAddress ? 'nothing' : `IP Address: ${TUN_ADDR}` });
        }
        if (/show dnsservers/.test(s)) {
            return Promise.resolve({ ok: !opts.dnsQueryFails, out: opts.dnsOut ?? DNSSERVERS });
        }
        if (/add route/.test(s) && opts.routeExists) {
            return Promise.resolve({ ok: false, out: 'The object already exists.' });
        }
        if (/add route/.test(s) && opts.routeRefused) {
            return Promise.resolve({ ok: false, out: 'The parameter is incorrect.' });
        }
        if (/delete dnsservers/.test(s) && opts.clearFails) {
            return Promise.resolve({ ok: false, out: 'The requested operation requires elevation.' });
        }
        if (/set dnsserver/.test(s) && opts.setFails) {
            return Promise.resolve({ ok: false, out: opts.setOut ?? 'The parameter is incorrect.' });
        }
        return Promise.resolve({ ok: true, out: '' });
    };
    const warns = [];
    const self = {
        _ifIndex: 42,
        _running: opts.running !== false,
        _dnsIp: opts.dnsIp ?? '',
        _dnsRoutes: new Set(opts.dnsRoutes || []),
        _phys: opts.noPhys ? null : { ifIndex: 7, gateway: '192.168.0.1' },
        _hostRoutes: new Map(opts.hostRoutes || []),
        log: { warn: (m, x) => warns.push(m + ' ' + JSON.stringify(x || {})),
               error: (m, x) => warns.push('E ' + m + ' ' + JSON.stringify(x || {})),
               info: () => {},
               success: (m, x) => warns.push('S ' + m + ' ' + JSON.stringify(x || {})) },
        _configureAdapter:        tunFn('_configureAdapter', netsh),
        _keepResolversReachable:  tunFn('_keepResolversReachable', netsh),
        _pinOffTunnel:            tunFn('_pinOffTunnel', netsh),
        _unpinResolvers:          tunFn('_unpinResolvers', netsh),
        setResolver:              tunFn('setResolver', netsh),
    };
    return { self, seen, warns };
};

console.log('\n-- 3. the adapter gets no resolver rather than a dead one --');
const withDns = fakeTun();
ok((await withDns.self._configureAdapter('127.0.0.1')).ok === true,
   'with a resolver, _configureAdapter() still succeeds', JSON.stringify(withDns.seen));
ok(withDns.seen.some(s => /set dnsserver/.test(s) && /127\.0\.0\.1/.test(s) && /primary/.test(s)),
   'and it is written as the adapter\'s static primary -- Tor\'s DNSPort is on ' +
   'loopback and loopback is never captured by the tunnel',
   withDns.seen.join(' | '));

const noDns = fakeTun();
const noRes = await noDns.self._configureAdapter('');
ok(noRes.ok === true,
   'with NO resolver, the adapter is still configured and still reports ok -- ' +
   'the tunnel is not refused over DNS, because the traffic itself is still ' +
   'being tunnelled', JSON.stringify(noRes));
ok(!noDns.seen.some(s => /set dnsserver/.test(s)),
   'and NOT ONE `set dnsserver` command is issued. This is the fix: writing ' +
   '127.0.0.1 here when Tor is on 9053 points the whole machine at a port ' +
   'nothing is listening on, which main.js:LEAK PROTECTION states does not ' +
   'fail safe -- it ends name resolution for every program on the PC',
   noDns.seen.join(' | '));
ok(noDns.warns.some(w => /no resolver was given/.test(w) && /kill DNS/.test(w)),
   'and it says so, naming what would have happened instead of skipping quietly',
   noDns.warns.join(' | '));
ok(noDns.seen.some(s => /show addresses/.test(s)),
   'the address read-back still runs -- an adapter that never took its address ' +
   'routes nothing, and that check is not part of the DNS step');
ok((await fakeTun({ noAddress: true }).self._configureAdapter('')).ok === false,
   'and it still fails when the address is not there, with no resolver either ' +
   'way: skipping the DNS step did not skip the verification');
ok(!/dnsIp \|\| '127\.0\.0\.1'/.test(TUN),
   "and `dnsIp || '127.0.0.1'` is gone from lib/tunnel.js -- including from the " +
   'success log, where it would have printed a resolver the adapter does not have');

console.log('\n-- 4. "not private" must not become "not working" --');
//  The other half of the fix. With no resolver on the adapter, Windows resolves
//  through the physical one -- and TUN_ROUTES capture UDP/53 going to it, which
//  tun2socks cannot carry at all (Tor's SOCKS5 has no UDP ASSOCIATE).
const keep = fakeTun();
const kr = await keep.self._keepResolversReachable();
const routes = keep.seen.filter(s => /add route/.test(s));
ok(kr.pinned === 2 && routes.length === 2,
   'the two PUBLIC resolvers this machine would use get a route around the ' +
   'tunnel -- without it the PC has no DNS at all, which is strictly worse than ' +
   'the leak this fallback already accepts', JSON.stringify({ kr, routes }));
ok(routes.every(s => /\/32/.test(s) && /interface=7/.test(s) && /nexthop=192\.168\.0\.1/.test(s) && /metric=1/.test(s)),
   'each is a /32 via the PHYSICAL gateway and interface -- a longer prefix ' +
   'than the /1 capture, so it wins route selection unconditionally',
   routes.join(' | '));
ok(routes.some(s => /8\.8\.8\.8\/32/.test(s)) && routes.some(s => /1\.1\.1\.1\/32/.test(s)),
   'and they are the addresses netsh actually reported, both of them',
   routes.join(' | '));
ok(!routes.some(s => /192\.168\.0\.1/.test(s.replace(/nexthop=\S+/, ''))),
   'the private resolver is deliberately NOT pinned: 192.168.0.1 is on-link, its ' +
   'own subnet route is a longer prefix than /1, and it was never captured');
ok(!routes.some(s => /127\.0\.0\.1\/32/.test(s)),
   'and loopback never is either -- 127.0.0.0/8 already routes to the loopback ' +
   'pseudo-interface, and a /32 for it via a gateway would be a wrong route');
ok([...keep.self._hostRoutes.keys()].sort().join(',') === '1.1.1.1,8.8.8.8',
   'every pinned address is recorded in _hostRoutes, which is what stop() ' +
   'iterates -- so teardown removes exactly these and nothing else',
   JSON.stringify([...keep.self._hostRoutes.keys()]));
ok(keep.warns.some(w => /DNS is NOT going through Tor/.test(w) && /visible to whoever/.test(w)),
   'and the honest limit is logged where the route is added: these queries go ' +
   'out in the clear. This function keeps DNS working; it does not make it ' +
   'private', keep.warns.join(' | '));

const exists = fakeTun({ routeExists: true });
await exists.self._keepResolversReachable();
ok(exists.self._hostRoutes.size === 2,
   '"The object already exists" counts as reachable, the same way it does for ' +
   "Tor's relays -- the address is off-tunnel either way");
const refused = fakeTun({ routeRefused: true });
const rr = await refused.self._keepResolversReachable();
ok(rr.pinned === 0 && refused.self._hostRoutes.size === 0 &&
   refused.warns.some(w => /could not pin a DNS server/.test(w)),
   'a refused route is named and NOT recorded, so teardown never deletes a ' +
   'route this app did not create', refused.warns.join(' | '));
const cantRead = fakeTun({ dnsQueryFails: true });
const cr = await cantRead.self._keepResolversReachable();
ok(cr.pinned === 0 && cantRead.warns.some(w => /could not read/.test(w) && /this is the reason/.test(w)),
   'and if the DNS servers cannot be read at all, that is said in advance as ' +
   'the reason name resolution may stop -- not discovered afterwards',
   cantRead.warns.join(' | '));
ok((await fakeTun({ noPhys: true }).self._keepResolversReachable()).pinned === 0,
   'with no physical default there is nothing to pin around, and it declines ' +
   'rather than building a route to nowhere');
const oddOut = fakeTun({ dnsOut: 'None\r\n8.8.4.4\r\n999.1.1.1\r\n169.254.1.1\r\n224.0.0.251' });
await oddOut.self._keepResolversReachable();
ok([...oddOut.self._hostRoutes.keys()].join(',') === '8.8.4.4',
   'and the address filter is the shipped one: an invalid literal, a link-local ' +
   'and a multicast address are all dropped from netsh\'s prose',
   JSON.stringify([...oddOut.self._hostRoutes.keys()]));

console.log('\n-- 5. and start() calls it exactly when there is no resolver --');
//  Not extract(): start()'s parameter list is itself a destructured object, so
//  brace matching from the opening line ends on the parameters rather than on
//  the body. Every method in this class closes at four-space indent and nothing
//  inside start() does, so that is the boundary used here.
const methodText = (src, opener) => {
    const at = src.indexOf(opener);
    if (at < 0) throw new Error('not found: ' + opener);
    const end = src.indexOf('\n    }\n', at);
    return src.slice(at, end < 0 ? undefined : end);
};
const START = methodText(TUN_CODE, 'async start({ socksPort = 9050');
ok(/const resolvers = dnsIp \? null : await this\._keepResolversReachable\(\);/.test(START),
   'start() keeps the resolvers reachable only when it did not give the adapter ' +
   'one -- not on every connect, where they belong inside the tunnel');
const iCfg = START.indexOf('_configureAdapter(dnsIp)');
const iKeep = START.indexOf('_keepResolversReachable()');
const iRoutes = START.indexOf('_addRoutes()');
ok(iCfg > 0 && iKeep > iCfg && iRoutes > iKeep,
   'and the order is: configure the adapter, pin the resolvers, THEN capture the ' +
   'default route -- pinning after the capture would leave a window with no DNS',
   JSON.stringify({ iCfg, iKeep, iRoutes }));
ok(/dnsViaTor: !!dnsIp,/.test(START),
   'and start() reports back whether DNS went through Tor, so a caller can never ' +
   'have to infer it from the resolver string');
//  Two places in this file write an adapter resolver, and the question is not
//  "how many" but "is every one of them behind a check that Tor actually has
//  one". Counted AND located: a third would fail the count, and an unguarded
//  one of the two would fail the guard test.
const CFG_SRC = extract(TUN_CODE, 'async _configureAdapter(dnsIp) {');
const SETRES_SRC = extract(TUN_CODE, 'async setResolver(dnsIp) {');
ok((TUN_CODE.match(/'set',\s*'dnsserver'/g) || []).length === 2,
   'exactly two places in lib/tunnel.js write an adapter resolver -- ' +
   '_configureAdapter() when the tunnel comes up, setResolver() when a server ' +
   'switch changes the answer mid-connection',
   String((TUN_CODE.match(/'set',\s*'dnsserver'/g) || []).length));
ok((CFG_SRC.match(/'set',\s*'dnsserver'/g) || []).length === 1 &&
   CFG_SRC.indexOf('if (dnsIp) {') > 0 &&
   CFG_SRC.indexOf('if (dnsIp) {') < CFG_SRC.indexOf("'set', 'dnsserver'"),
   'the first is inside `if (dnsIp)`, so an empty resolver writes nothing');
ok((SETRES_SRC.match(/'set',\s*'dnsserver'/g) || []).length === 1 &&
   SETRES_SRC.indexOf('if (want) {') > 0 &&
   SETRES_SRC.indexOf('if (want) {') < SETRES_SRC.indexOf("'set', 'dnsserver'"),
   'and the second is inside `if (want)`, whose else branch CLEARS the resolver ' +
   'rather than writing a dead one -- both writes are guarded by the same fact');

// ── 6. and the user is told, by name ────────────────────────────────
console.log('\n-- 6. the user is told, in the window, which program did it --');
const STEP4 = (MAIN_CODE.match(/await applyLeakProtection\(\{ dnsViaTor \}\);[\s\S]{0,1600}?\n        \}/) || [''])[0];
ok(/reportFault\('DNS is not going through Tor on this connection',/.test(STEP4),
   'the fallback is reported as a fault, not left in a log file the user never ' +
   'opens -- reportFault() is the channel that reaches the window', STEP4.slice(0, 200));
ok(/dnsHolders\.map\(o => o\.label\)\.join\(', '\)/.test(STEP4),
   'and it names the holding program, which is the only part of this the user ' +
   'can act on');
ok(/that Windows would not name/.test(STEP4),
   'with an honest fallback wording for when the lookup found nobody -- not a ' +
   'blank, and not a guess');
ok(/browsers still look names up at the exit/.test(STEP4) &&
   /still tunnelled/.test(STEP4),
   'and it says what is NOT affected: browsers hand the hostname to the SOCKS ' +
   'proxy, and the traffic itself is tunnelled either way. A vague DNS warning ' +
   'makes people disconnect a working tunnel');
ok(/To fix it: close that/.test(STEP4),
   'and it ends with the one action that fixes it');
ok(!/Logger\.warn\('DNS is NOT routed through Tor/.test(MAIN_CODE),
   'and the old warn-and-say-nothing is gone rather than sitting beside the ' +
   'fault, duplicating it in the log');

//  The holder list has a lifetime, and getting it wrong means blaming a program
//  the user already closed.
const ROUND = (MAIN_CODE.match(/dnsPort = DNS_PORT;[\s\S]{0,400}?dnsHolders = \[\];/) || [''])[0];
ok(ROUND.length > 0,
   'dnsHolders is cleared at the top of every engine round, beside the dnsPort ' +
   'reset and for the same reason: round 1\'s holder must not be blamed for ' +
   'round 2\'s bind failure');
ok(/dnsHolders = await udpPortOwners\(DNS_PORT\);/.test(MAIN_CODE) &&
   (MAIN_CODE.match(/udpPortOwners\(/g) || []).length === 2,
   'and it is filled in exactly once, in the dns-bind retry branch -- the only ' +
   'moment the answer is still true',
   String((MAIN_CODE.match(/udpPortOwners\(/g) || []).length));
const BRANCH = (MAIN_CODE.match(/res\.reason === 'dns-bind' && res\.port === DNS_PORT\) \{[\s\S]{0,900}?dnsPort = DNS_FALLBACK_PORT;/) || [''])[0];
ok(/dnsHolders = await udpPortOwners\(DNS_PORT\)/.test(BRANCH) &&
   /heldBy:/.test(BRANCH),
   'the lookup sits inside the :53-specific branch, and the retry log carries ' +
   'the holder rather than only the port number', BRANCH.slice(-300));
ok(!/udpPortOwners/.test((MAIN_CODE.match(/else if \(!res\.ok && res\.reason === 'dns-bind'\) \{[\s\S]{0,600}?\n            \}/) || [''])[0]),
   'and NOT in the branch for a bind failure that was not :53 -- asking who ' +
   'holds 53 when tor could not get 9050 would name an innocent process');

// ── 7. the switch, which changes the answer without rebuilding ──────
console.log('\n-- 7. a server switch can change the answer mid-connection --');
//  A switch restarts tor but NOT the tunnel: tunnel.running stays true, so
//  start() is never called again and _configureAdapter() never runs. The new tor
//  can still lose port 53 -- most often to the tor.exe it just replaced, which
//  has not let go yet -- and the adapter would keep pointing at a 127.0.0.1
//  nothing is listening on. setResolver() is what re-states it, in BOTH
//  directions, and _unpinResolvers() is what keeps the /32s honest.
const ALREADY = (MAIN_CODE.match(/\} else if \(tunnel\.running\) \{[\s\S]{0,1200}?\n            \} else \{/) || [''])[0];
ok(/const rs = await tunnel\.setResolver\(dnsViaTor \? '127\.0\.0\.1' : ''\);/.test(ALREADY),
   'the already-running branch re-states the adapter\'s resolver against THIS ' +
   "connection's dnsViaTor, instead of returning ok and leaving the previous " +
   "connection's answer on the adapter", ALREADY.slice(0, 200));
ok(/if \(!rs\.ok && !rs\.unchanged\)/.test(ALREADY) &&
   /reportFault\('The tunnel\\'s DNS setting could not be updated'/.test(ALREADY),
   'and a failure to do so is reported to the window, not swallowed -- the ' +
   'machine is then in a state the user has to be able to see');
ok(/If websites stop loading by name, disconnect/.test(ALREADY) &&
   /Reason: ' \+ rs\.reason/.test(ALREADY),
   'with the action that fixes it, and the reason carried through rather than ' +
   'flattened into "something went wrong"', ALREADY.slice(-260));
ok(/already: true,[\s\S]{0,60}resolver: rs/.test(ALREADY),
   'and the result still reports already:true, carrying what the resolver ' +
   'change actually did');

//  ── run for real, both directions ──
const notUp = fakeTun({ running: false });
const nu = await notUp.self.setResolver('127.0.0.1');
ok(nu.ok === false && nu.reason === 'the tunnel is not up' && notUp.seen.length === 0,
   'with no tunnel up there is no adapter to write to, and it says so without ' +
   'running one netsh command', JSON.stringify({ nu, seen: notUp.seen }));

const same = fakeTun({ dnsIp: '127.0.0.1' });
const sm = await same.self.setResolver('127.0.0.1');
ok(sm.unchanged === true && same.seen.length === 0,
   'an unchanged answer is a no-op -- a switch that keeps port 53 does not ' +
   'rewrite the adapter, and cannot fail while doing it',
   JSON.stringify({ sm, seen: same.seen }));

//  ── 127.0.0.1 -> '' : the switch where the new tor LOST port 53 ──
const lost = fakeTun({ dnsIp: '127.0.0.1' });
const lo = await lost.self.setResolver('');
ok(lo.ok === true && lo.dnsIp === '' &&
   lost.seen.some(s => /delete dnsservers/.test(s) && /name=42/.test(s) && /all/.test(s)),
   'when Tor loses :53 mid-connection the adapter\'s resolver is CLEARED, not ' +
   'left pointing at a port nothing is listening on',
   JSON.stringify({ lo, seen: lost.seen }));
ok(!lost.seen.some(s => /set dnsserver/.test(s)),
   'and no resolver is written in its place -- there is no address that means ' +
   '"port 9053", so the honest write is none');
ok([...lost.self._dnsRoutes].sort().join(',') === '1.1.1.1,8.8.8.8' &&
   lost.self._hostRoutes.size === 2,
   'and the machine\'s own resolvers are pinned around the tunnel in the same ' +
   'step, so the clear does not hand the PC a working adapter with no DNS',
   JSON.stringify([...lost.self._dnsRoutes]));

//  ── '' -> 127.0.0.1 : the switch where it got port 53 BACK ──
const RELAY = '198.51.100.7';
const got = fakeTun({ dnsIp: '', dnsRoutes: ['8.8.8.8', '1.1.1.1'],
                      hostRoutes: [[RELAY, '192.168.0.1'], ['8.8.8.8', '192.168.0.1'],
                                   ['1.1.1.1', '192.168.0.1']] });
const gt = await got.self.setResolver('127.0.0.1');
ok(gt.ok === true && gt.dnsIp === '127.0.0.1' &&
   got.seen.some(s => /set dnsserver/.test(s) && /127\.0\.0\.1/.test(s) && /primary/.test(s)),
   'and the reverse transition writes it back, so DNS returns to Tor without a ' +
   'reconnect', JSON.stringify({ gt, seen: got.seen }));
const deleted = got.seen.filter(s => /delete route/.test(s));
ok(deleted.length === 2 && deleted.every(s => /8\.8\.8\.8\/32|1\.1\.1\.1\/32/.test(s)),
   'the two resolver /32s are deleted at the same moment -- while Tor resolves, ' +
   'a route straight to 8.8.8.8 is a hole a hard-coded resolver would walk ' +
   'through', deleted.join(' | '));
ok(got.self._hostRoutes.size === 1 && got.self._hostRoutes.has(RELAY) &&
   got.self._dnsRoutes.size === 0,
   "and Tor's own relay pin is untouched: _dnsRoutes is a separate set because " +
   'those two kinds of /32 have different lifetimes',
   JSON.stringify([...got.self._hostRoutes.keys()]));
ok(!deleted.some(s => s.includes(RELAY)),
   'no delete was even issued for the relay -- teardown removes what it added, ' +
   'and this is not teardown', deleted.join(' | '));
//  ── the two failure paths, which must not make things worse ──
const clearBad = fakeTun({ dnsIp: '127.0.0.1', clearFails: true });
const cb = await clearBad.self.setResolver('');
ok(cb.ok === false && cb.reason === 'could not clear the adapter dns' &&
   clearBad.warns.some(w => /could NOT clear the adapter resolver/.test(w) &&
                            /may fail until it disconnects/.test(w)),
   'a clear that Windows refuses is reported as the failure the machine is now ' +
   'in -- an adapter still pointing at a resolver Tor left', clearBad.warns.join(' | '));
ok(clearBad.self._dnsIp === '127.0.0.1',
   'and _dnsIp is NOT advanced on that failure, so the next call still tries ' +
   'rather than believing the adapter is already clear');

const setBad = fakeTun({ dnsIp: '', setFails: true,
                         dnsRoutes: ['8.8.8.8'],
                         hostRoutes: [['8.8.8.8', '192.168.0.1']] });
const sb = await setBad.self.setResolver('127.0.0.1');
ok(sb.ok === false && sb.reason === 'could not set the adapter dns',
   'and an adapter that will not take Tor\'s resolver is reported too',
   JSON.stringify(sb));
ok(setBad.self._dnsRoutes.size === 1 && !setBad.seen.some(s => /delete route/.test(s)),
   'with the resolver /32s LEFT IN PLACE -- unpinning them after a failed write ' +
   'would take away the only working DNS the machine has left. Order matters ' +
   'here and this is the assertion that holds it',
   JSON.stringify([...setBad.self._dnsRoutes]));
const setSoft = fakeTun({ dnsIp: '', setFails: true, setOut: 'No changes needed.' });
ok((await setSoft.self.setResolver('127.0.0.1')).ok === true,
   'while netsh\'s "no changes needed" counts as done, the same way the rest of ' +
   'this file treats it');

//  ── _unpinResolvers() on its own ──
const un = fakeTun({ dnsRoutes: ['8.8.8.8', '9.9.9.9'],
                     hostRoutes: [['8.8.8.8', '192.168.0.1'], [RELAY, '192.168.0.1']] });
const removed = await un.self._unpinResolvers();
ok(removed === 2 && un.self._dnsRoutes.size === 0,
   'every recorded resolver route is dropped from the books, including one whose ' +
   'route was never actually added -- a stale entry must not survive as a ' +
   'permanent hole', JSON.stringify({ removed }));
ok(un.seen.filter(s => /delete route/.test(s)).length === 1,
   'but only the one with a recorded gateway is deleted from Windows -- netsh is ' +
   'not asked to remove a route this app never created',
   un.seen.join(' | '));
ok(un.self._hostRoutes.size === 1 && un.self._hostRoutes.has(RELAY),
   'and the relay pin is still there afterwards', JSON.stringify([...un.self._hostRoutes.keys()]));

//  A switch that flips :53 away and back leaves the books exactly as they were.
//  This is the property that matters over a long session with many switches:
//  neither an orphan /32 around the tunnel nor a lost relay pin.
const trip = fakeTun({ dnsIp: '127.0.0.1', hostRoutes: [[RELAY, '192.168.0.1']] });
await trip.self.setResolver('');
await trip.self.setResolver('127.0.0.1');
ok(trip.self._hostRoutes.size === 1 && trip.self._hostRoutes.has(RELAY) &&
   trip.self._dnsRoutes.size === 0 && trip.self._dnsIp === '127.0.0.1',
   'and a full round trip -- :53 lost, then regained -- ends with exactly the ' +
   'routes it started with, which is what makes this safe to run on every switch',
   JSON.stringify({ host: [...trip.self._hostRoutes.keys()],
                    dns: [...trip.self._dnsRoutes], ip: trip.self._dnsIp }));

console.log('');
console.log(`${pass}/${pass + fail} checks passed` + (fail ? `  (${fail} FAILED)` : ''));
process.exit(fail ? 1 : 0);
})().catch(e => { console.log('THREW: ' + (e && e.stack || e)); process.exit(1); });





