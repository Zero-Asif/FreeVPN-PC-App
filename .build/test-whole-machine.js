'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/test-whole-machine.js  --  the ORDER the two new layers go up and
//  come down in, lifted out of main.js and run.
//
//  2.0.5 is the release that made this a whole-machine VPN, and it did it with
//  two layers that are dangerous in opposite directions:
//
//    the TUNNEL takes the machine's default route. Up without the block layer
//        is fine. Left behind, the PC has no internet at all.
//    CONTAINMENT is default-deny outbound. Up WITHOUT a tunnel is a PC that
//        cannot reach anything -- which is exactly what the Kill Switch means,
//        so it is correct, but only when the user asked for it.
//
//  So the sequence is the feature. Up: tunnel first, then deny -- nothing is
//  ever blocked before there is a route for it. Down: allow first, then pull
//  the routes -- nothing is ever routed-nowhere while also being dropped. Get
//  either order backwards and the failure is not a wrong pixel, it is a machine
//  with no internet at the moment the user asked to be back to normal.
//
//  lib/containment.js and lib/tunnel.js each have their own suite. NOTHING read
//  the four functions in main.js that drive them, which is where the order
//  lives. This file lifts armWholeMachine, disarmWholeMachine, onTunnelDied and
//  tearDownTunnel out of the shipped main.js -- the real text, comments
//  stripped -- and runs them in a vm against recording stubs.
//
//  Nothing is started, nothing is written, no route, rule or process is touched.
// ════════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { stripComments } = require('./srcstrip.js');

const ROOT = path.join(__dirname, '..');
const SRCFILE = process.env.FP_MAIN || path.join(ROOT, 'main.js');
const src = stripComments(fs.readFileSync(SRCFILE, 'utf8'));

let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
    if (cond) { pass++; console.log('  ok   ' + name); }
    else { fail++; console.log('  FAIL ' + name + (extra ? '  -- ' + extra : '')); }
};

//  ── lift a function out by name ──
//  Brace counting over the comment-stripped source, skipping quoted text so a
//  brace inside a string cannot close the body early. If a name is not there
//  this returns null and every check that needs it fails BY NAME, rather than
//  the file dying on line 1 and reporting nothing.
function lift(name) {
    const re = new RegExp('\\n\\s*(?:async\\s+)?function\\s+' + name + '\\s*\\(');
    const m = re.exec(src);
    if (!m) return null;
    const start = m.index + 1;
    //  Skip the parameter list first. Three of these four functions take a
    //  destructured object, so the first `{` in the text is the PARAMETER's --
    //  counting from there ends the body at `{ reason, torPid = null }`.
    let i = src.indexOf('(', m.index + m[0].length - 1);
    let depth = 0, q = null;
    for (; i < src.length; i++) {
        const c = src[i];
        if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
        if (c === '"' || c === "'" || c === '`') { q = c; continue; }
        if (c === '(') depth++;
        else if (c === ')' && --depth === 0) { i++; break; }
    }
    i = src.indexOf('{', i);
    if (i < 0) return null;
    depth = 0; q = null;
    for (; i < src.length; i++) {
        const c = src[i];
        if (q) {
            if (c === '\\') { i++; continue; }
            if (c === q) q = null;
            continue;
        }
        if (c === '"' || c === "'" || c === '`') { q = c; continue; }
        if (c === '{') depth++;
        else if (c === '}' && --depth === 0) return src.slice(start, i + 1);
    }
    return null;
}

const NAMES = ['armWholeMachine', 'disarmWholeMachine', 'onTunnelDied', 'tearDownTunnel'];
const BODIES = {};
console.log('── the four functions are still in main.js under these names ──');
for (const n of NAMES) {
    BODIES[n] = lift(n);
    ok(!!BODIES[n], n + ' lifted out of ' + path.basename(SRCFILE),
       'not found -- renamed, or moved out of main.js');
}
if (NAMES.some(n => !BODIES[n])) {
    console.log(`\n${pass}/${pass + fail} checks passed`);
    process.exit(1);
}

//  ── the world those four functions run in ──
//  Every free name they reference, as a recorder. TRACE is the whole point:
//  the order of the entries in it IS the invariant under test.
function world({ killSwitch = false, fullTunnel = true, dnsViaTor = true,
                 tunRunning = false, tunStarts = { ok: true }, tunAvail = { ok: true },
                 armed = false, contResult = { ok: true }, resolver = { ok: true },
                 connected = true, sessionLive = true, throwFrom = null } = {}) {
    const TRACE = [];
    const MSGS = [];
    const t = (what, arg) => { TRACE.push(arg === undefined ? what : what + ':' + arg);
                               if (throwFrom === what) throw new Error('stub blew up in ' + what); };
    //  TRACE is truncated for readability in a FAIL line; MSGS keeps every log
    //  message whole, because the wording of the two "the tunnel dropped"
    //  sentences is itself under test and the difference is past character 60.
    const say = lvl => m => { MSGS.push(lvl + ' ' + String(m)); t('log.' + lvl, String(m).slice(0, 40)); };
    const sandbox = {
        TRACE,
        console,
        appState: { killSwitch, connected, busy: false, since: Date.now() },
        sessionLive,
        wantFullTunnel: fullTunnel,
        dnsViaTor,
        activeDnsPort: dnsViaTor ? 53 : 9053,
        SOCKS_PORT: 9050,
        TUN_NAME: 'FreeProxyTun',
        torProc: { pid: 4242 },
        mainWindow: {},
        _tunRestarts: 0,
        faults: [],
        Logger: {
            info: say('info'), warn: say('warn'), error: say('error'),
            success: say('success'), debug: () => {},
        },
        reportFault: (title, body) => { sandbox.faults.push({ title, body }); t('fault', title); },
        tunnel: {
            running: tunRunning,
            localIp: '10.77.77.1',
            isAvailable: () => { t('tunnel.isAvailable'); return tunAvail; },
            start: async () => { t('tunnel.start'); sandbox.tunnel.running = !!tunStarts.ok;
                                 return tunStarts; },
            stop: async () => { t('tunnel.stop'); sandbox.tunnel.running = false;
                                return { ok: true }; },
            setResolver: async ip => { t('tunnel.setResolver', JSON.stringify(ip));
                                       return resolver; },
        },
        containment: {
            armed,
            enable: async o => { t('containment.enable', JSON.stringify(o.tunLocalIp));
                                 sandbox.containment.armed = !!contResult.ok; return contResult; },
            installAllowRules: async o => { t('containment.installAllowRules',
                                              JSON.stringify(o.tunLocalIp)); return contResult; },
            disable: async () => { t('containment.disable'); sandbox.containment.armed = false;
                                   return { ok: true }; },
        },
        stopCircuitGuard: () => t('stopCircuitGuard'),
        stopExitWatcher: () => t('stopExitWatcher'),
        killTor: async () => t('killTor'),
        setAppProxy: async m => t('setAppProxy', m),
        clearGeolocationSpoof: async () => t('clearGeolocationSpoof'),
        killSwitchLeakLock: async () => t('killSwitchLeakLock'),
        reverseLeakProtection: async () => t('reverseLeakProtection'),
        runBat: async (f, body) => t('runBat', /ProxyEnable/.test(String(body)) ? 'proxy-off' : '?'),
        getScriptPath: n => n,
        broadcastState: () => t('broadcastState'),
    };
    vm.createContext(sandbox);
    for (const n of NAMES) vm.runInContext(BODIES[n], sandbox, { filename: 'main.js:' + n });
    sandbox.trace = () => TRACE;
    sandbox.at = what => TRACE.findIndex(s => s === what || s.startsWith(what + ':'));
    sandbox.has = what => sandbox.at(what) >= 0;
    sandbox.said = (lvl, re) => MSGS.some(s => s.startsWith(lvl + ' ') && re.test(s));
    sandbox.show = () => JSON.stringify(TRACE);
    return sandbox;
}

(async () => {

// ════════════════════════════════════════════════════════════════════
console.log('\n── the way up: a route before anything is denied ──');
// ════════════════════════════════════════════════════════════════════
{
    const w = world({ killSwitch: true });
    const out = await w.armWholeMachine({ reason: 'connect', torPid: 4242 });
    ok(w.has('tunnel.start') && w.has('containment.enable'), 'both layers come up', w.show());
    ok(w.at('tunnel.start') < w.at('containment.enable'),
       'and the tunnel comes up BEFORE default-deny -- the other order drops every ' +
       'program on the PC for as long as it takes tun2socks to start', w.show());
    ok(w.has('containment.enable:"10.77.77.1"'),
       "and the allow list is given the tunnel's own address, so traffic to it survives " +
       'the deny rule', w.show());
    ok(out.tunnel.ok && out.containment.ok, 'and both are reported ok', JSON.stringify(out));
    ok(w.has('log.success'), 'and the user is told the whole device is covered', w.show());
}

// ── the Kill Switch is the only thing that authorises default-deny ──
{
    const w = world({ killSwitch: false });
    const out = await w.armWholeMachine({ reason: 'connect' });
    ok(w.has('tunnel.start'), 'with the Kill Switch off the tunnel still comes up', w.show());
    ok(!w.has('containment.enable') && !w.has('containment.installAllowRules'),
       'and containment is never touched -- default-deny can take this PC off the ' +
       'internet, so it happens only when the user asked for it', w.show());
    ok(out.containment === null, 'and nothing claims it was armed', JSON.stringify(out));
}

// ════════════════════════════════════════════════════════════════════
console.log('\n── a tunnel that will not start must not fail the connect ──');
// ════════════════════════════════════════════════════════════════════
//  Tor is already bootstrapped and the browsers are already going through it by
//  the time this runs. Tearing that down because the extra layer failed would
//  turn a partial win into no VPN at all.
{
    const w = world({ killSwitch: true, tunStarts: { ok: false, reason: 'wintun.dll would not load' } });
    const out = await w.armWholeMachine({ reason: 'connect' });
    ok(out.tunnel.ok === false, 'the failure is reported, not swallowed', JSON.stringify(out.tunnel));
    ok(w.faults.some(f => /Full-device tunnel did not start/.test(f.title)),
       'in the window, because the user cannot read a log line', JSON.stringify(w.faults));
    ok(/wintun\.dll would not load/.test(w.faults.map(f => f.body).join(' ')),
       "and carrying tunnel.js's own reason", JSON.stringify(w.faults));
    ok(w.has('containment.enable:""'),
       'and containment STILL arms, with no tunnel address -- with the Kill Switch on, ' +
       'blocked is the answer the user asked for', w.show());
    ok(w.said('warn', /BLOCKED rather than routed/),
       'and it says out loud that programs are now blocked rather than routed', w.show());
    ok(out.containment.ok === true, 'the arm still reports containment ok', JSON.stringify(out));
}

// ── containment that will not arm ──
{
    const w = world({ killSwitch: true, contResult: { ok: false, reason: 'firewall service is stopped' } });
    const out = await w.armWholeMachine({ reason: 'connect' });
    ok(out.containment.ok === false, 'a firewall that refuses is reported');
    ok(w.faults.some(f => /Kill Switch could not seal this PC/.test(f.title)),
       'the Kill Switch says it could not seal the PC rather than implying it did',
       JSON.stringify(w.faults.map(f => f.title)));
    ok(out.tunnel.ok === true, 'and the tunnel that DID come up is still reported up');
}

// ── neither layer exists yet ──
{
    const w = world({ killSwitch: true });
    w.tunnel = null;
    const out = await w.armWholeMachine({ reason: 'connect' });
    ok(out.tunnel === null && out.containment === null && !w.trace().length,
       'called before the layers are constructed, it does nothing at all', w.show());
}

// ════════════════════════════════════════════════════════════════════
console.log('\n── a country switch does not rebuild the tunnel ──');
// ════════════════════════════════════════════════════════════════════
//  The tunnel does not depend on which exit is in use, so a switch keeps it --
//  but the switch DOES restart tor, and the new tor may not win port 53. The
//  adapter's resolver has to be re-stated against this connection's answer or
//  the machine is left pointing at a 127.0.0.1:53 with nothing behind it.
{
    const w = world({ killSwitch: true, tunRunning: true, dnsViaTor: true, armed: true });
    const out = await w.armWholeMachine({ reason: 'switch' });
    ok(!w.has('tunnel.start'), 'the tunnel is not restarted', w.show());
    ok(w.has('tunnel.setResolver:"127.0.0.1"'),
       'its resolver is re-stated as 127.0.0.1 because this tor did get port 53', w.show());
    ok(out.tunnel.already === true && out.tunnel.ok === true,
       'and it is reported as already up', JSON.stringify(out.tunnel));
    ok(w.has('containment.installAllowRules'),
       'and the allow list is rewritten rather than the policy re-enabled', w.show());
}
{
    const w = world({ tunRunning: true, dnsViaTor: false });
    await w.armWholeMachine({ reason: 'switch' });
    ok(w.has('tunnel.setResolver:""'),
       'and when tor did NOT get port 53 the resolver is cleared, not left at ' +
       '127.0.0.1 -- an adapter resolver has no port field, so DNSPort 9053 cannot ' +
       'be named there at all', w.show());
}
{
    const w = world({ tunRunning: true, resolver: { ok: false, reason: 'netsh refused' } });
    const out = await w.armWholeMachine({ reason: 'switch' });
    ok(w.faults.some(f => /DNS setting could not be updated/.test(f.title)),
       'a resolver that will not change is reported to the user',
       JSON.stringify(w.faults.map(f => f.title)));
    ok(out.tunnel.ok === true,
       'but the tunnel is still up, so the connect is not called a failure');
}
{
    const w = world({ tunRunning: true, resolver: { ok: false, unchanged: true } });
    await w.armWholeMachine({ reason: 'switch' });
    ok(!w.faults.length,
       'and a resolver that did not need changing is silent -- a fault the user can ' +
       'do nothing about teaches them to ignore the ones they can',
       JSON.stringify(w.faults.map(f => f.title)));
}

// ════════════════════════════════════════════════════════════════════
console.log('\n── the tunnel turned off, and the tunnel unavailable ──');
// ════════════════════════════════════════════════════════════════════
{
    const w = world({ killSwitch: true, fullTunnel: false });
    const out = await w.armWholeMachine({ reason: 'connect' });
    ok(!w.has('tunnel.start') && !w.has('tunnel.isAvailable'),
       'fullTunnel:false in settings.json is honoured without touching the binaries', w.show());
    ok(out.tunnel.disabled === true && out.tunnel.ok === false,
       'and it is reported as disabled by the user, not as a failure',
       JSON.stringify(out.tunnel));
    ok(w.has('containment.enable:""'),
       'the Kill Switch still seals the PC -- the two settings are independent', w.show());
}
{
    const w = world({ tunAvail: { ok: false, reason: 'tun2socks.exe is not in Tun/' } });
    const out = await w.armWholeMachine({ reason: 'connect' });
    ok(!w.has('tunnel.start'), 'a missing binary is not spawned', w.show());
    ok(out.tunnel.unavailable === true && /tun2socks\.exe is not in Tun/.test(out.tunnel.reason),
       'and the reason names the file, so it is fixable', JSON.stringify(out.tunnel));
    ok(!w.faults.length,
       'and it raises no window fault: a build without the binaries is a smaller ' +
       'product, not a broken one', JSON.stringify(w.faults.map(f => f.title)));
}

// ════════════════════════════════════════════════════════════════════
console.log('\n── the way down: reachable before the routes go ──');
// ════════════════════════════════════════════════════════════════════
{
    const w = world({ killSwitch: true, tunRunning: true, armed: true });
    await w.disarmWholeMachine({ reason: 'the user disconnected' });
    ok(w.has('containment.disable') && w.has('tunnel.stop'), 'both layers come down', w.show());
    ok(w.at('containment.disable') < w.at('tunnel.stop'),
       'and outbound is allowed again BEFORE the routes are pulled -- the reverse ' +
       'order drops every program on the PC at the moment the user asked to be back ' +
       'to normal', w.show());
}
{
    const w = world({ killSwitch: true, tunRunning: true, armed: true });
    await w.disarmWholeMachine({ reason: 'a cancelled connect', keepContainment: true });
    ok(!w.has('containment.disable'),
       'keepContainment leaves default-deny standing -- with the Kill Switch on, ' +
       '"no tunnel, no internet" is the state the user asked to be left in', w.show());
    ok(w.has('tunnel.stop'),
       'and the tunnel still comes down, because a capture route to a dead adapter is ' +
       'not part of what they asked for', w.show());
}
{
    const w = world({ tunRunning: true, armed: true, throwFrom: 'containment.disable' });
    let threw = false;
    try { await w.disarmWholeMachine({ reason: 'a throw halfway down' }); }
    catch (e) { threw = true; }
    ok(!threw, 'a disarm never throws at its caller', 'it threw');
    ok(w.has('tunnel.stop'),
       'and a containment step that blew up does NOT skip the tunnel -- a disarm that ' +
       'gives up halfway is how a machine stays offline', w.show());
    ok(w.trace().some(s => /^log.error/.test(s)), 'the throw is on the record', w.show());
}
{
    const w = world({ tunRunning: false, armed: false });
    await w.disarmWholeMachine({ reason: 'nothing was up' });
    ok(!w.has('containment.disable') && !w.has('tunnel.stop'),
       'nothing up means nothing to take down, and neither layer is called', w.show());
}

// ════════════════════════════════════════════════════════════════════
console.log('\n── the tunnel died on its own ──');
// ════════════════════════════════════════════════════════════════════
const settle = () => new Promise(r => setTimeout(r, 0));
{
    const w = world({ connected: false });
    w.onTunnelDied({ code: 1 });
    await settle();
    ok(!w.trace().length,
       'a death during a teardown we started is ignored -- otherwise every ' +
       'disconnect would fight itself', w.show());
}
{
    //  tunRunning:false is the real state here, not a convenience: lib/tunnel.js's
    //  own _onProcExit clears _running and pulls its routes BEFORE it calls this
    //  back, so by the time main.js hears about the death the tunnel is already
    //  down and a restart is a fresh start(), not a re-state.
    const w = world({ killSwitch: true, armed: true, tunRunning: false });
    w.onTunnelDied({ code: 1, lastOutput: ['tun2socks: panic'] });
    await settle();
    ok(w.said('error', /BLOCKED, not leaking/),
       'with the Kill Switch on the log says blocked, not leaking', w.show());
    ok(w.has('tunnel.start'), 'and the tunnel is restarted', w.show());
}
{
    const w = world({ killSwitch: false, tunRunning: false });
    w.onTunnelDied({ code: 1 });
    await settle();
    ok(w.said('error', /real IP again/),
       'with it off the log says the real IP is in use again -- the truth is ' +
       'different in the two cases and so is the sentence', w.show());
}
{
    const w = world({ tunRunning: false });
    for (let i = 0; i < 4; i++) { w.tunnel.running = false; w.onTunnelDied({ code: 1 }); await settle(); }
    ok(w.trace().filter(s => s === 'tunnel.start').length === 2,
       'it restarts twice and no more -- an unbounded retry on a binary that crashes ' +
       'at startup is a spin that rewrites the route table a few times a second',
       w.trace().filter(s => s === 'tunnel.start').length + ' starts');
    ok(w.faults.some(f => /keeps dying/.test(f.title)),
       'and the third death is reported to the user instead',
       JSON.stringify(w.faults.map(f => f.title)));
    ok(w.faults.some(f => /Browsers are still going through Tor/.test(f.body)),
       'saying what is still protected, so "it keeps dying" is not read as "no VPN"',
       JSON.stringify(w.faults.map(f => f.body.slice(0, 50))));
}

// ════════════════════════════════════════════════════════════════════
console.log('\n── tearing it down: one order, and it survives a throw ──');
// ════════════════════════════════════════════════════════════════════
{
    const w = world({ killSwitch: false, tunRunning: true, armed: true });
    await w.tearDownTunnel('the user disconnected');
    const seq = ['containment.disable', 'tunnel.stop', 'killTor', 'setAppProxy'];
    ok(seq.every((s, i) => i === 0 || w.at(seq[i - 1]) < w.at(s)),
       'containment, then the routes, then tor, then the system proxy', w.show());
    ok(w.at('tunnel.stop') < w.at('killTor'),
       'and the capture routes go BEFORE tor is killed -- with tor gone and the routes ' +
       'still there the whole machine hangs on connections nothing can answer', w.show());
    ok(w.has('setAppProxy:direct') && w.has('reverseLeakProtection') && w.has('runBat:proxy-off'),
       'with the Kill Switch off the PC is put all the way back to normal', w.show());
    ok(!w.has('killSwitchLeakLock'), 'and nothing is left sealed', w.show());
    ok(w.sessionLive === false && w.appState.connected === false && w.appState.busy === false,
       'and the app stops claiming to be connected',
       JSON.stringify({ s: w.sessionLive, c: w.appState.connected, b: w.appState.busy }));
    ok(w.has('broadcastState'), 'and the window is told', w.show());
}
{
    const w = world({ killSwitch: true, tunRunning: true, armed: true });
    await w.tearDownTunnel('a cancelled connect');
    ok(!w.has('containment.disable'),
       'with the Kill Switch on, default-deny stays -- cancelling a connect is exactly ' +
       'the "no tunnel" case it was turned on for', w.show());
    ok(w.has('setAppProxy:blocked') && w.has('killSwitchLeakLock'),
       'the proxy is pointed at a black hole and the leak lock is re-affirmed', w.show());
    ok(!w.has('reverseLeakProtection') && !w.has('runBat:proxy-off'),
       'and the leak protection is NOT reversed -- reversing it is what would let ' +
       'traffic out of a PC the user asked to seal', w.show());
    ok(w.appState.connected === false, 'and the app still stops claiming to be connected');
}
for (const step of ['killTor', 'setAppProxy', 'clearGeolocationSpoof', 'containment.disable']) {
    const w = world({ tunRunning: true, armed: true, throwFrom: step });
    let threw = false;
    try { await w.tearDownTunnel('a throw at ' + step); } catch (e) { threw = true; }
    ok(!threw && w.appState.connected === false && w.has('broadcastState'),
       'a throw in ' + step + ' still reaches the end of the teardown',
       threw ? 'it threw' : w.show());
}

console.log(`\n${pass}/${pass + fail} checks passed`);
if (fail) {
    console.log('\nTHE ORDER IS THE FEATURE. Denying outbound before there is a route,\n' +
                'or pulling the routes before outbound is allowed again, both end with\n' +
                'a PC that cannot reach the internet -- and the second one does it at\n' +
                'the exact moment the user asked to be back to normal.');
    process.exit(1);
}
process.exit(0);
})();
