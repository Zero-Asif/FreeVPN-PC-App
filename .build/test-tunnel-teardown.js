'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/test-tunnel-teardown.js  --  the way down, which is the dangerous half.
//
//  A full-tunnel VPN takes the machine's whole default route: 0.0.0.0/1 and
//  128.0.0.0/1 via 10.77.77.1, two prefixes that beat the real gateway's
//  0.0.0.0/0 by being longer. While tun2socks is alive that is the point of the
//  product. If either one survives the adapter, the machine has a default route
//  to a device that no longer exists and NOTHING reaches the internet -- not the
//  browser, not Windows Update, not this app's own retry. "VPN ta amar internet
//  nosto kore diyeche" is one leftover route away at all times.
//
//  lib/tunnel.js had 30 checks against it, all on the way UP: the argv it hands
//  tun2socks and the wait for the adapter's address. Nothing read the teardown.
//  This file does, with child_process stubbed before the module is loaded, so
//  every netsh/taskkill argv is recorded and none is executed.
//
//  NOTHING IS APPLIED. execFile and spawn are replaced with recorders at the top
//  of this file, before require('../lib/tunnel'), which destructures them at
//  load. No route is added, deleted or read; no process is killed.
// ════════════════════════════════════════════════════════════════════
const path = require('path');
const cp = require('child_process');

//  ── the recorder, installed before lib/tunnel.js reads child_process ──
const CALLS = [];          // { exe, args, detached }
let RESPOND = () => ({ code: 0, out: '' });   // per-test router, set below

const realExecFile = cp.execFile;
const realSpawn = cp.spawn;
cp.execFile = (exe, args, opts, cb) => {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    CALLS.push({ exe, args: args.slice(), detached: false });
    const r = RESPOND(exe, args) || {};
    //  execFile's contract: err is an Error with .code on a non-zero exit.
    const err = r.code ? Object.assign(new Error('Command failed'), { code: r.code }) : null;
    setImmediate(() => cb(err, r.out || '', ''));
    return { pid: 999 };
};
cp.spawn = (exe, args, opts) => {
    CALLS.push({ exe, args: args.slice(), detached: !!(opts && opts.detached) });
    return { unref() {}, pid: 998, killed: false, kill() { this.killed = true; },
             on() {}, stdout: { on() {} }, stderr: { on() {} } };
};
process.on('exit', () => { cp.execFile = realExecFile; cp.spawn = realSpawn; });

const SRC = process.env.FP_TUNNEL || path.join(__dirname, '..', 'lib', 'tunnel.js');
const { Tunnel, TUN_NAME, TUN_ADDR, TUN_ROUTES } = require(SRC);

let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
    if (cond) { pass++; console.log('  ok   ' + name); }
    else { fail++; console.log('  FAIL ' + name + (extra ? '  -- ' + extra : '')); }
};
const LOG = [];
const log = { info: (m, x) => LOG.push(['info', String(m), x]),
              warn: (m, x) => LOG.push(['warn', String(m), x]),
              error: (m, x) => LOG.push(['error', String(m), x]),
              success: (m, x) => LOG.push(['success', String(m), x]),
              debug: () => {} };

const reset = () => { CALLS.length = 0; LOG.length = 0; };
const argvs = () => CALLS.map(c => c.exe + ' ' + c.args.join(' '));
const shown = () => JSON.stringify(argvs(), null, 0).slice(0, 400);
const did = re => argvs().filter(s => re.test(s));

//  netsh's real route table, both with our capture in it and without. The two
//  /1 prefixes are what every check below is looking for, and the surrounding
//  rows are there so a regex that is too loose shows up as a false positive.
const ROUTES_WITH = [
    'Publish  Type      Met  Prefix                    Idx  Gateway/Interface Name',
    '-------  --------  ---  ------------------------  ---  ------------------',
    'No       Manual    0    0.0.0.0/0                   8  192.168.0.1',
    'No       Manual    5    0.0.0.0/1                  51  10.77.77.1',
    'No       Manual    5    128.0.0.0/1                51  10.77.77.1',
    'No       Manual    5    10.77.77.0/24              51  FreeProxyTun',
    'No       Manual    5    192.168.0.0/24              8  Wi-Fi',
].join('\r\n');
const ROUTES_WITHOUT = [
    'Publish  Type      Met  Prefix                    Idx  Gateway/Interface Name',
    '-------  --------  ---  ------------------------  ---  ------------------',
    'No       Manual    0    0.0.0.0/0                   8  192.168.0.1',
    'No       Manual    5    192.168.0.0/24              8  Wi-Fi',
].join('\r\n');

//  A tunnel that believes it is up, without having run start(). Every field
//  start() would have set is set here to the value it really leaves behind, so
//  the teardown under test is the teardown of a live tunnel.
function upTunnel({ stubborn = false, relays = [['198.51.100.7', '192.168.0.1']] } = {}) {
    const t = new Tunnel({ Logger: log, binDir: path.join(__dirname, 'no-such-dir'),
                           onExit: e => t._exits.push(e) });
    t._exits = [];
    t._running = true;
    t._ifIndex = 51;
    t._phys = { gateway: '192.168.0.1', ifIndex: 8, metric: 25 };
    t._dnsIp = '127.0.0.1';
    t._hostRoutes = new Map(relays);
    t._addedRoutes = TUN_ROUTES.slice();
    t._lastLines = ['tun2socks: started', 'tun2socks: up'];
    t.proc = { pid: 4242, killed: false,
               kill() { if (!stubborn) this.killed = true; },
               on() {}, stdout: { on() {} }, stderr: { on() {} } };
    return t;
}

(async () => {

// ════════════════════════════════════════════════════════════════════
console.log('── an ordinary stop: the capture goes before the adapter ──');
// ════════════════════════════════════════════════════════════════════
//  The ORDER is the check, not just the set of commands. Killing tun2socks
//  first destroys the adapter, and until the deletes land the table still
//  points 0.0.0.0/1 at a gateway on a dead interface -- every connection
//  started in that window fails instead of falling back to the real NIC.
reset();
RESPOND = (exe, args) => args.includes('show') ? { code: 0, out: ROUTES_WITHOUT }
                                               : { code: 0, out: '' };
{
    const t = upTunnel();
    const r = await t.stop();
    ok(r.ok, 'stop() reports success', JSON.stringify(r));

    const del0 = argvs().findIndex(s => /delete route 0\.0\.0\.0\/1/.test(s));
    const del1 = argvs().findIndex(s => /delete route 128\.0\.0\.0\/1/.test(s));
    ok(del0 >= 0 && del1 >= 0, 'both capture prefixes are deleted', shown());
    ok(did(/delete route 0\.0\.0\.0\/1 interface=51 nexthop=10\.77\.77\.1 store=active/).length === 1,
       'by OUR interface index and OUR nexthop -- a bare prefix delete could take ' +
       "an administrator's own route of the same shape", shown());

    const kill = argvs().findIndex(s => /taskkill/.test(s));
    ok(kill === -1, 'a process that answers kill() is not also taskkilled', shown());
    ok(t.proc === null && t.running === false && t.ifIndex === null,
       'and the tunnel no longer claims to be up');

    const readback = argvs().findIndex(s => /show route/.test(s));
    ok(readback > del0 && readback > del1,
       'the route table is read back AFTER the deletes, not before -- the claim ' +
       '"routing is back on the physical adapter" is a measurement or it is nothing', shown());
    ok(LOG.some(l => l[0] === 'success' && /routing is back on the physical/.test(l[1])),
       'and only then is the user told', JSON.stringify(LOG.map(l => l[0])));
}

// ════════════════════════════════════════════════════════════════════
console.log('\n── the /32s pinned around the tunnel go too ──');
// ════════════════════════════════════════════════════════════════════
//  Tor's relays and any public resolver were routed around the tunnel via the
//  physical gateway. Left behind they are not a black hole, but they ARE a
//  standing exception in the table for addresses this app chose, and after
//  teardown nothing of ours may remain that the user did not ask for.
reset();
{
    const t = upTunnel({ relays: [['198.51.100.7', '192.168.0.1'],
                                  ['8.8.8.8', '192.168.0.1']] });
    t._dnsRoutes = new Set(['8.8.8.8']);
    await t.stop();
    ok(did(/delete route 198\.51\.100\.7\/32 interface=8 nexthop=192\.168\.0\.1/).length === 1,
       "the relay's host route is deleted, via the PHYSICAL index it was added on", shown());
    ok(did(/delete route 8\.8\.8\.8\/32 interface=8 nexthop=192\.168\.0\.1/).length === 1,
       "and the resolver's", shown());
    ok(t._hostRoutes.size === 0 && t._dnsRoutes.size === 0,
       'and both books are emptied, so a second stop cannot delete them twice');
}

// ════════════════════════════════════════════════════════════════════
console.log('\n── a tun2socks that will not die ──');
// ════════════════════════════════════════════════════════════════════
//  A surviving tun2socks holds the Wintun adapter open, and the next start()
//  would find a stale adapter under our own name and configure the wrong
//  device. kill() is a request; taskkill /T /F is not.
reset();
{
    const t = upTunnel({ stubborn: true });
    const r = await t.stop();
    ok(did(/taskkill\.exe \/PID 4242 \/T \/F/).length === 1,
       'the tree is taskkilled by PID after kill() is ignored', shown());
    ok(r.ok, 'and the stop still reports success once the routes are gone');
    ok(argvs().findIndex(s => /taskkill/.test(s)) >
       argvs().findIndex(s => /delete route 0\.0\.0\.0\/1/.test(s)),
       'still after the routes, never before them', shown());
}

// ════════════════════════════════════════════════════════════════════
console.log('\n── a route that will not go: say so, do not claim success ──');
// ════════════════════════════════════════════════════════════════════
//  The one outcome that must never be reported as ok. If the read-back still
//  shows the capture, the machine is black-holed and the user needs the two
//  commands that fix it, not a green tick.
reset();
RESPOND = (exe, args) => args.includes('show') ? { code: 0, out: ROUTES_WITH }
                                               : { code: 0, out: '' };
{
    const t = upTunnel();
    const r = await t.stop();
    ok(r.ok === false && r.reason === 'routes survived teardown',
       'stop() reports failure by name', JSON.stringify(r));
    ok(Array.isArray(r.left) && r.left.length === 2,
       'and names both prefixes that are still there', JSON.stringify(r.left));
    const err = LOG.find(l => l[0] === 'error');
    ok(!!err && /route delete 0\.0\.0\.0 mask 128\.0\.0\.0/.test(err[1]),
       'and the log carries the literal command that repairs it, because at this ' +
       'point the app cannot', err ? err[1].slice(0, 90) : 'no error logged');
    ok(!LOG.some(l => l[0] === 'success'),
       'and nothing anywhere says routing is back');
}

// ════════════════════════════════════════════════════════════════════
console.log('\n── tun2socks dies on its own while the tunnel is up ──');
// ════════════════════════════════════════════════════════════════════
//  Not a stop we asked for. The adapter has just vanished, so the machine has
//  silently reverted to its real IP for everything that was relying on us --
//  which is the exit-IP leak the whole product exists to prevent. main.js turns
//  onExit into a fail-closed disconnect, so it has to be called.
reset();
RESPOND = (exe, args) => args.includes('show') ? { code: 0, out: ROUTES_WITHOUT }
                                               : { code: 0, out: '' };
{
    const t = upTunnel();
    t._onProcExit(1, null);
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
    ok(t.running === false, 'the tunnel stops claiming to be up immediately');
    ok(t._exits.length === 1 && t._exits[0].code === 1,
       'onExit is called exactly once, with the exit code', JSON.stringify(t._exits));
    ok(t._exits[0].lastOutput && t._exits[0].lastOutput.join('|') === 'tun2socks: started|tun2socks: up',
       "and with tun2socks' own last lines, which are the only diagnosis there is",
       JSON.stringify(t._exits[0].lastOutput));
    const e = LOG.find(l => l[0] === 'error');
    ok(!!e && /no longer being routed through Tor/.test(e[1]),
       'the log says the traffic is no longer going through Tor, in those words',
       e ? e[1].slice(0, 80) : 'nothing logged as an error');
    ok(did(/delete route 0\.0\.0\.0\/1/).length === 1 &&
       did(/delete route 128\.0\.0\.0\/1/).length === 1,
       'and our routes are deleted explicitly rather than trusting Windows to ' +
       'have removed them with the adapter', shown());
}

// ════════════════════════════════════════════════════════════════════
console.log('\n── a stop we asked for is not reported as a death ──');
// ════════════════════════════════════════════════════════════════════
//  stop() kills tun2socks, and the exit handler fires afterwards. If that
//  handler could not tell the two apart, every ordinary disconnect would raise
//  "Tunnel DOWN" and main.js would fail closed on a healthy shutdown.
reset();
{
    const t = upTunnel();
    await t.stop();
    LOG.length = 0;
    t._exits.length = 0;
    t._onProcExit(0, 'SIGTERM');
    await new Promise(r => setImmediate(r));
    ok(t._exits.length === 0, 'onExit is NOT called for the process we killed');
    ok(!LOG.some(l => /Tunnel DOWN/.test(l[1])),
       'and nothing is logged as a death', JSON.stringify(LOG.map(l => l[1].slice(0, 40))));
}

// ════════════════════════════════════════════════════════════════════
console.log('\n── an exit before the tunnel was ever up ──');
// ════════════════════════════════════════════════════════════════════
//  start() failing is a different event from the tunnel falling over: nothing
//  was ever routed through it, so there is nothing to fail closed about, and
//  start()'s own return value is what the caller acts on.
reset();
{
    const t = upTunnel();
    t._running = false;
    t._stopping = false;
    t._onProcExit(3, null);
    await new Promise(r => setImmediate(r));
    ok(t._exits.length === 0, 'onExit is not called -- there was no tunnel to lose');
    ok(LOG.some(l => l[0] === 'warn' && /exited before the tunnel was up/.test(l[1])),
       'and it is a warning, not an error', JSON.stringify(LOG.map(l => l[0])));
}

// ════════════════════════════════════════════════════════════════════
console.log('\n── the quit path, where nothing can be awaited ──');
// ════════════════════════════════════════════════════════════════════
//  will-quit gives no chance to await anything, so the two deletes are fired
//  detached and the process is left to die with its parent. Without the
//  nexthop the delete would be a prefix match against whatever else holds it.
reset();
{
    const t = upTunnel();
    t.stopNoWait();
    ok(did(/netsh\.exe interface ipv4 delete route 0\.0\.0\.0\/1 nexthop=10\.77\.77\.1 store=active/).length === 1 &&
       did(/netsh\.exe interface ipv4 delete route 128\.0\.0\.0\/1 nexthop=10\.77\.77\.1 store=active/).length === 1,
       'both capture prefixes are deleted by nexthop', shown());
    ok(CALLS.filter(c => /netsh/.test(c.exe)).every(c => c.detached),
       'detached, so they outlive the process that is quitting',
       JSON.stringify(CALLS.map(c => c.detached)));
    ok(t.running === false && t._stopping === true,
       'and the tunnel is marked stopping, so the exit handler stays quiet');
    LOG.length = 0;
    t._onProcExit(null, 'SIGTERM');
    ok(t._exits.length === 0 && !LOG.some(l => l[0] === 'error'),
       'proven: the death that follows a stopNoWait raises nothing');
}

// ════════════════════════════════════════════════════════════════════
console.log('\n── the run after a crash ──');
// ════════════════════════════════════════════════════════════════════
//  The app was killed with the tunnel up. There is no ifIndex to name any more,
//  so the leftovers are deleted by prefix and nexthop. This runs at app start,
//  before anything connects -- a stale route here would poison the first
//  connect of the new session, and a surviving tun2socks would hold the adapter.
reset();
{
    let shows = 0;
    RESPOND = (exe, args) => {
        if (/taskkill/.test(exe)) return { code: 0, out: 'SUCCESS: The process "tun2socks.exe" with PID 1234 has been terminated.' };
        if (args.includes('show')) return { code: 0, out: ++shows === 1 ? ROUTES_WITH : ROUTES_WITHOUT };
        return { code: 0, out: '' };
    };
    const t = new Tunnel({ Logger: log, binDir: path.join(__dirname, 'no-such-dir') });
    const r = await t.cleanupStale();
    ok(r.ok && r.cleaned === true, 'cleanupStale reports that it cleaned', JSON.stringify(r));
    ok(did(/taskkill\.exe \/IM tun2socks\.exe \/F/).length === 1,
       'a tun2socks left over from the dead session is killed by image name -- its ' +
       'PID died with the app that knew it', shown());
    ok(did(/delete route 0\.0\.0\.0\/1 nexthop=10\.77\.77\.1 store=active/).length === 1 &&
       did(/delete route 128\.0\.0\.0\/1 nexthop=10\.77\.77\.1 store=active/).length === 1,
       'and both leftover prefixes are deleted with no interface= at all, because ' +
       'the index they were on is not knowable any more', shown());
    ok(!/interface=/.test(argvs().filter(s => /delete route 0\.0\.0\.0\/1/.test(s))[0] || 'interface='),
       'no invented interface index: a wrong one deletes nothing and reports success', shown());
    ok(shows === 2, 'the table is read again afterwards, so "cleaned" is a read-back',
       'show route called ' + shows + ' times');
    ok(LOG.some(l => l[0] === 'warn' && /did not shut down cleanly/.test(l[1])),
       'and the previous crash is on the record', JSON.stringify(LOG.map(l => l[0])));
}

// ── nothing to clean is silent ──────────────────────────────────────
//  This is the ordinary case, every ordinary start. A warning here would train
//  the user to ignore the one that matters.
reset();
{
    RESPOND = (exe, args) => {
        if (/taskkill/.test(exe)) return { code: 128, out: 'ERROR: The process "tun2socks.exe" not found.' };
        return { code: 0, out: ROUTES_WITHOUT };
    };
    const t = new Tunnel({ Logger: log, binDir: path.join(__dirname, 'no-such-dir') });
    const r = await t.cleanupStale();
    ok(r.ok && r.cleaned === false, 'a clean machine is reported clean', JSON.stringify(r));
    ok(!did(/delete route/).length, 'and nothing is deleted', shown());
    ok(!LOG.length, 'and nothing is logged at all', JSON.stringify(LOG.map(l => l[0])));
}

// ── a leftover that will not go ─────────────────────────────────────
reset();
{
    RESPOND = (exe, args) => {
        if (/taskkill/.test(exe)) return { code: 128, out: 'not found' };
        return { code: 0, out: ROUTES_WITH };
    };
    const t = new Tunnel({ Logger: log, binDir: path.join(__dirname, 'no-such-dir') });
    const r = await t.cleanupStale();
    ok(r.ok === false && Array.isArray(r.still) && r.still.length === 2,
       'a leftover that survives the delete is reported, not swallowed -- this is a ' +
       'machine with no internet and the app must not start a connect on top of it',
       JSON.stringify(r));
    ok(LOG.some(l => l[0] === 'error' && /could not be removed/.test(l[1])),
       'and it is an error, because nothing the app does next will work');
}

// ════════════════════════════════════════════════════════════════════
console.log('\n── stopping twice, and stopping something that never started ──');
// ════════════════════════════════════════════════════════════════════
reset();
RESPOND = (exe, args) => args.includes('show') ? { code: 0, out: ROUTES_WITHOUT }
                                               : { code: 0, out: '' };
{
    const t = upTunnel();
    await t.stop();
    const n = CALLS.length;
    LOG.length = 0;
    const r = await t.stop();
    ok(r.ok, 'a second stop still reports ok');
    ok(!did(/delete route 0\.0\.0\.0\/1 interface=/).length ||
       argvs().slice(n).every(s => !/delete route .*interface=/.test(s)),
       'and deletes nothing again: ifIndex is null and both route books are empty', shown());
    ok(!LOG.some(l => l[0] === 'success'),
       'and does not tell the user the tunnel came down a second time');
}
reset();
{
    const t = new Tunnel({ Logger: log, binDir: path.join(__dirname, 'no-such-dir') });
    const r = await t.stop();
    ok(r.ok, 'stopping a tunnel that never started is ok, not an error', JSON.stringify(r));
    ok(!did(/delete route [0-9]/).length,
       'and touches no route at all -- the app calls this on every disconnect, ' +
       'tunnel or no tunnel', shown());
    ok(did(/show route/).length === 1,
       'it still reads the table, which is how a route left by an earlier crash ' +
       'is noticed on an ordinary disconnect', shown());
}

// ════════════════════════════════════════════════════════════════════
console.log('\n── what teardown must never touch ──');
// ════════════════════════════════════════════════════════════════════
//  The machine's own default route and its LAN. A teardown that removes
//  0.0.0.0/0 leaves exactly the same black hole a leftover /1 does, from the
//  other direction.
reset();
{
    const t = upTunnel();
    await t.stop();
    ok(!did(/delete route 0\.0\.0\.0\/0/).length,
       "the real default route is never deleted", shown());
    ok(!did(/delete route 192\.168/).length && !did(/delete route 10\.77\.77\.0/).length,
       'and neither the LAN nor the tunnel subnet is deleted by hand -- the subnet ' +
       'route goes with the adapter', shown());
    ok(!did(/set dnsserver/).length && !did(/delete dnsservers/).length,
       "and the PHYSICAL adapter's resolvers are never rewritten on the way down: " +
       'the tunnel adapter is disappearing and takes its own DNS with it', shown());
    ok(!did(/advfirewall/).length,
       'and no firewall rule is touched here -- that is main.js\'s leak protection, ' +
       'with its own lifetime', shown());
}

console.log(`\n${pass}/${pass + fail} checks passed`);
if (fail) {
    console.log('\nA LEFTOVER CAPTURE ROUTE IS A MACHINE WITH NO INTERNET. 0.0.0.0/1 and\n' +
                '128.0.0.0/1 beat the real gateway by prefix length, so if either one\n' +
                'outlives the adapter, nothing on this PC reaches the network until\n' +
                'somebody deletes it by hand or reboots.');
    process.exit(1);
}
process.exit(0);
})();
