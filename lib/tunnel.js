'use strict';
//  ════════════════════════════════════════════════════════════════════════════
//  TUNNEL  --  a real TUN device, so proxy-unaware apps also ride Tor
//
//  WHY THIS EXISTS
//  ---------------
//  lib/containment.js can stop traffic. It cannot redirect it. Default-deny
//  means a game or an installer that ignores every proxy setting gets dropped
//  instead of leaking -- correct, but it is not a VPN, it is a wall.
//
//  On Linux this gap is closed with `iptables -j REDIRECT` into Tor's
//  TransPort. Windows has no equivalent: WFP can permit or drop a packet, it
//  cannot rewrite its destination. So the only honest way to make this a
//  whole-machine VPN on Windows is a network adapter that owns the route table
//  and hands what it receives to Tor's SOCKS5 port.
//
//  That is exactly this: Wintun (the WireGuard project's layer-3 adapter) plus
//  tun2socks (a userspace TCP/IP netstack that terminates the connection and
//  re-dials it through SOCKS5). Together they turn "every app's TCP" into
//  "every app's TCP, through Tor", with no cooperation from the app.
//
//  WHAT IT COSTS, STATED PLAINLY
//  -----------------------------
//    * UDP to the internet stays dead. Tor's SOCKS5 has no UDP ASSOCIATE, so
//      QUIC, WebRTC, games and VoIP do not work while this is up. tun2socks
//      would happily carry UDP; Tor has nowhere to put it.
//    * ICMP is not carried either -- ping and traceroute go quiet.
//    * Windows Update, telemetry and every background service now go through
//      Tor. That is the point, and it is also why some of them will be slow.
//    * The adapter is a signed kernel driver from WireGuard LLC, and
//      tun2socks.exe is an unsigned Go binary. SmartScreen and some AV engines
//      will have opinions about the second one.
//
//  WHAT IT WILL NOT PRETEND
//  ------------------------
//  If either binary is missing from the build, isAvailable() says so and
//  start() refuses. There is no code path here that reports a tunnel the
//  kernel does not have.
//  ════════════════════════════════════════════════════════════════════════════

const { execFile, spawn } = require('child_process');
const fs   = require('fs');
const path = require('path');

//  ── Fixed identity of our adapter ──
//  A name, not an index: the index changes every time the adapter is created,
//  and every netsh call below looks the current one up rather than caching it.
const TUN_NAME = 'FreeProxyTun';

//  10.77.77.0/24 -- chosen to sit outside every range a home router hands out
//  (192.168.0.0/16, 10.0.0.0/24, 172.16-31.x from Hyper-V/WSL, 192.168.137.x
//  from Windows ICS). If a machine really does use 10.77.77.0/24 on the LAN,
//  that /24 is a longer prefix than our /1 routes and keeps winning, so the
//  LAN still works -- the tunnel just cannot reach that one range.
const TUN_ADDR = '10.77.77.1';
const TUN_MASK = '255.255.255.0';

//  Two /1 routes instead of replacing 0.0.0.0/0. Same coverage, three
//  advantages: the machine's real default route is never touched, so teardown
//  is "delete two routes" rather than "restore something we overwrote"; a
//  crash leaves the original default in place; and anything with a longer
//  prefix (the LAN, loopback, the Hyper-V switches) still routes normally.
const TUN_ROUTES = ['0.0.0.0/1', '128.0.0.0/1'];

//  How often we re-check which relays tor.exe is talking to, in ms. See
//  _excludeTorPeers() for why this loop is load-bearing rather than tidy-up.
const PEER_WATCH_MS = 4000;

//  ── One process runner, argv-based, never a shell string ──
//  Same reasoning as lib/containment.js: these paths contain spaces and this
//  module runs elevated, so nothing may be re-parsed as a separator.
function run(exe, args, timeout = 20000) {
    return new Promise(resolve => {
        execFile(exe, args, { windowsHide: true, timeout, encoding: 'utf8' },
                 (err, stdout, stderr) => {
            resolve({
                ok: !err,
                code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
                out: String(stdout || '') + String(stderr || ''),
                err: err ? String(err.message).split('\n')[0] : null,
            });
        });
    });
}
const netsh = (args, t) => run('netsh.exe', args, t);

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;

//  Addresses that must never be given a host route "around the tunnel",
//  whatever netstat says tor is connected to. 127/8 already routes to
//  loopback, and the rest are either link-local, multicast or unspecified --
//  a /32 exclusion for one of them would be a silently wrong route.
function isRoutableUnicast(ip) {
    if (!IPV4.test(ip)) return false;
    const [a, b] = ip.split('.').map(Number);
    if (a === 0 || a === 127 || a >= 224) return false;          // this/loop/mcast
    if (a === 169 && b === 254) return false;                    // link-local
    return true;
}

//  Unanchored, for pulling addresses out of netsh's prose. Every hit is still
//  validated with IPV4 above before it is used for anything.
const IPV4_ANY = /\d{1,3}(?:\.\d{1,3}){3}/g;

//  RFC1918 plus the carrier-grade range. Used for ONE decision -- whether a
//  resolver needs a host route around the tunnel -- and the answer is no: a
//  private resolver is on-link, and its own subnet route is a longer prefix
//  than /1, so TUN_ROUTES never captured it in the first place.
function isPrivate4(ip) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || (a === 192 && b === 168) ||
           (a === 172 && b >= 16 && b <= 31) || (a === 100 && b >= 64 && b <= 127);
}

//  ── Sleep, but cancellable by stop() ──
const wait = ms => new Promise(r => setTimeout(r, ms));

class Tunnel {
    //  binDir is the directory that holds tun2socks.exe and wintun.dll. It must
    //  be a real directory on disk, which is why package.json lists Tun/** in
    //  asarUnpack -- an .exe cannot be spawned and a .dll cannot be loaded from
    //  inside app.asar.
    //
    //  onExit is called if tun2socks dies while we believed the tunnel was up.
    //  main.js uses it to fail closed rather than to keep showing "connected"
    //  over an adapter that no longer exists.
    constructor({ Logger, binDir, onExit = null }) {
        this.log     = Logger;
        this.binDir  = binDir || '';
        this.exePath = path.join(this.binDir, 'tun2socks.exe');
        this.dllPath = path.join(this.binDir, 'wintun.dll');
        this.onExit  = onExit;

        this.proc        = null;
        this._running    = false;
        this._stopping   = false;
        this._ifIndex    = null;   // our adapter's index, re-read on every start
        this._addedRoutes = [];    // exactly the routes we created, for teardown
        this._hostRoutes = new Map();  // relay IP -> gateway we pinned it to
        //  Which of those host routes are there for RESOLVERS rather than for
        //  Tor's relays. Tracked apart because they have a different lifetime:
        //  they exist only while DNS is not going through Tor, and setResolver()
        //  takes them away again the moment it is.
        this._dnsRoutes  = new Set();
        this._dnsIp      = '';     // what is actually on the adapter right now
        this._watchTimer = null;
        this._torPid     = null;
        this._phys       = null;   // { gateway, ifIndex, metric }
        this._lastLines  = [];     // tail of tun2socks stderr, for diagnostics
    }

    get running()  { return this._running; }
    get localIp()  { return this._running ? TUN_ADDR : null; }
    get ifIndex()  { return this._ifIndex; }
    get pid()      { return this.proc && !this.proc.killed ? this.proc.pid : null; }

    //  ── Is this build actually carrying the tunnel? ──
    //  Checked by size as well as existence, because a partial download or a
    //  Git LFS pointer left in the tree is a file that exists and cannot run.
    //  Called before anything is promised to the user.
    isAvailable() {
        const missing = [];
        for (const [what, p, minBytes] of [['tun2socks.exe', this.exePath, 1000000],
                                           ['wintun.dll',    this.dllPath,  100000]]) {
            let st = null;
            try { st = fs.statSync(p); } catch (e) { st = null; }
            if (!st || !st.isFile())       missing.push(`${what} is not in this build`);
            else if (st.size < minBytes)   missing.push(`${what} is only ${st.size} bytes`);
        }
        if (missing.length) return { ok: false, reason: missing.join('; '),
                                     dir: this.binDir };
        return { ok: true };
    }

        //  ── The route out that already exists ──
    //  Parsed from the real output of `netsh interface ipv4 show route`, which
    //  on this machine prints:
    //      Publish  Type      Met  Prefix        Idx  Gateway/Interface Name
    //      No       Manual    0    0.0.0.0/0      13  192.168.0.1
    //  A multi-homed machine has more than one default; we take the lowest
    //  metric whose gateway is a real address (a gateway column holding an
    //  interface NAME means an on-link default, which cannot be used as a
    //  next hop for the host routes below).
    async physicalDefault() {
        const r = await netsh(['interface', 'ipv4', 'show', 'route'], 20000);
        if (!r.ok) return null;
        const found = [];
        for (const line of r.out.split(/\r?\n/)) {
            const m = /^\s*\S+\s+\S+\s+(\d+)\s+0\.0\.0\.0\/0\s+(\d+)\s+(.+?)\s*$/.exec(line);
            if (!m) continue;
            const gw = m[3].trim();
            if (!isRoutableUnicast(gw)) continue;
            if (Number(m[2]) === this._ifIndex) continue;   // never our own
            found.push({ metric: Number(m[1]), ifIndex: Number(m[2]), gateway: gw });
        }
        found.sort((a, b) => a.metric - b.metric);
        return found[0] || null;
    }

    //  ── Find our adapter, by name, after tun2socks has created it ──
    //  Wintun adapters appear a beat after the process starts, so this polls.
    //  Returns the interface index or null. `show interfaces` prints:
    //      Idx     Met         MTU          State                Name
    //       13      35        1500      connected                Wi-Fi
    async _findAdapter(timeoutMs = 15000) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (this._stopping) return null;
            const r = await netsh(['interface', 'ipv4', 'show', 'interfaces'], 15000);
            if (r.ok) {
                for (const line of r.out.split(/\r?\n/)) {
                    const m = /^\s*(\d+)\s+\d+\s+\d+\s+\S+\s+(.+?)\s*$/.exec(line);
                    if (m && m[2].trim() === TUN_NAME) return Number(m[1]);
                }
            }
            await wait(400);
        }
        return null;
    }

        //  ── Keeping Tor's own traffic out of Tor ──
    //
    //  THE PROBLEM, precisely. Once TUN_ROUTES are in place, every outbound
    //  packet on this machine goes to our adapter -- including tor.exe's own
    //  connections to its guard relays. tun2socks would accept those, dial
    //  127.0.0.1:9050 to forward them, and hand Tor its own relay traffic to
    //  carry. Tor cannot build a circuit without a guard, and it cannot reach
    //  the guard without a circuit. The tunnel deadlocks at step one.
    //
    //  THE FIX. A /32 host route, via the physical gateway, for every remote
    //  address tor.exe currently holds a socket to. A /32 is a longer prefix
    //  than /1, so it wins route selection unconditionally, and it is scoped to
    //  exactly the relay addresses -- nothing else gains a way around the
    //  tunnel. Discovered from `netstat -ano` filtered on tor's PID, which is
    //  the kernel's own answer rather than a guess from the consensus.
    //
    //  HONEST LIMIT. Tor picks new guards while running. The first SYN to a
    //  brand-new guard can be captured by the tunnel in the window before the
    //  next sweep installs its /32 -- that one connection fails, Tor retries
    //  within seconds, and by then the route exists. So the failure mode is a
    //  retry, not a deadlock; it is not seamless and this comment is the only
    //  place that says so.
    async _excludeTorPeers() {
        if (!this._torPid || !this._phys) return { added: 0 };
        const r = await run('netstat.exe', ['-ano'], 20000);
        if (!r.ok) return { added: 0, error: r.err || 'netstat failed' };
        const peers = new Set();
        for (const line of r.out.split(/\r?\n/)) {
            //   Proto  Local Address  Foreign Address  State  PID
            const m = /^\s*TCP\s+(\S+)\s+(\S+)\s+(\S+)\s+(\d+)\s*$/.exec(line);
            if (!m || Number(m[4]) !== this._torPid) continue;
            const ip = m[2].replace(/:\d+$/, '');
            if (isRoutableUnicast(ip)) peers.add(ip);
        }
        //  The /32s themselves are added by _pinOffTunnel(), which this shares
        //  with the resolver pinning below: one place that adds a route around
        //  the tunnel, one place that records it for teardown.
        const added = await this._pinOffTunnel(peers, 'a Tor relay');
        return { added, peers: peers.size };
    }

    //  ── Keeping name resolution alive when DNS is NOT going through Tor ──
    //  Only ever called in the port-53 fallback, and only because of what the
    //  fallback costs: Tor took DNSPort 9053, a Windows adapter's resolver field
    //  has no port in it, so the tunnel adapter is left with no resolver of its
    //  own (see _configureAdapter) and Windows keeps using the physical
    //  adapter's. TUN_ROUTES would then capture the UDP/53 packets going to that
    //  resolver -- and tun2socks cannot carry them, because Tor's SOCKS5 has no
    //  UDP ASSOCIATE. The machine would have no DNS at all: strictly worse than
    //  the leak this fallback already accepts, and indistinguishable from "the
    //  VPN broke my internet".
    //
    //  A /32 via the physical gateway is the same instrument used for Tor's
    //  relays, for the same reason, and it is scoped to the resolver addresses
    //  only. Private resolvers are deliberately left alone: 192.168.x.1 is
    //  on-link, its subnet route is a longer prefix than /1, and it was never
    //  captured. Public ones -- 8.8.8.8, 1.1.1.1, an ISP's -- are the ones that
    //  need it.
    //
    //  HONEST LIMIT, and it is the point of the whole fallback: these queries go
    //  out in the clear, to whoever the machine already trusted. This function
    //  keeps DNS WORKING; it does not make it private. main.js says so to the
    //  user's face rather than only here (see the port-53 reportFault).
    async _keepResolversReachable() {
        if (!this._phys) return { pinned: 0, reason: 'no physical default' };
        const r = await netsh(['interface', 'ipv4', 'show', 'dnsservers'], 20000);
        if (!r.ok) {
            this.log.warn('Tunnel: could not read this PC\'s DNS servers, so ' +
                          'none could be kept reachable around the tunnel. If ' +
                          'name resolution stops, this is the reason.',
                          { out: r.out.trim().slice(0, 200) });
            return { pinned: 0, reason: 'could not read the DNS servers' };
        }
        const seen = new Set(), local = [];
        for (const hit of String(r.out || '').match(IPV4_ANY) || []) {
            if (!isRoutableUnicast(hit)) continue;               // drops 127.0.0.1
            if (isPrivate4(hit)) { local.push(hit); continue; }
            seen.add(hit);
        }
        const pinned = await this._pinOffTunnel(seen, 'a DNS server');
        for (const ip of seen) if (this._hostRoutes.has(ip)) this._dnsRoutes.add(ip);
        this.log.warn('Tunnel: DNS is NOT going through Tor on this connection. ' +
                      'This PC keeps resolving names with the servers it already ' +
                      'had, and those queries are visible to whoever runs them. ' +
                      'Everything else on the machine still goes through Tor.',
                      { pinnedAroundTunnel: [...seen], onLinkAlready: local });
        return { pinned, servers: seen.size };
    }

    //  ── Take those resolver routes away again ──
    //  Called when DNS moves back onto Tor. A /32 to 8.8.8.8 via the physical
    //  gateway is correct while nothing can carry UDP to it through the tunnel,
    //  and is a small hole the moment Tor's DNSPort is doing the resolving: a
    //  program with 8.8.8.8 hard-coded would send that one query around us.
    //  Only the resolver routes are removed; Tor's relays keep theirs.
    async _unpinResolvers() {
        let removed = 0;
        for (const ip of [...this._dnsRoutes]) {
            const gw = this._hostRoutes.get(ip);
            if (gw && this._phys) {
                await netsh(['interface', 'ipv4', 'delete', 'route', `${ip}/32`,
                             `interface=${this._phys.ifIndex}`, `nexthop=${gw}`,
                             'store=active'], 15000);
            }
            this._hostRoutes.delete(ip);
            this._dnsRoutes.delete(ip);
            removed++;
        }
        return removed;
    }

    //  ── Change the adapter's resolver while the tunnel is up ──
    //  A server switch restarts tor, and the new tor may not get port 53 even
    //  though the old one did -- the commonest reason it cannot bind is the
    //  PREVIOUS tor.exe not having let go of it yet. The tunnel does not need
    //  rebuilding for that. But leaving 127.0.0.1 pinned on this adapter after
    //  Tor has moved to 9053 points every program on the machine at a dead
    //  resolver, and that is the one failure this file exists to refuse. The
    //  reverse transition matters too: a resolver appearing means the /32s
    //  around the tunnel are no longer needed and are taken away.
    //
    //  `netsh delete dnsservers ... all` is the clear: an adapter with no
    //  statically configured server falls through to the machine's others,
    //  which is exactly the fallback state.
    async setResolver(dnsIp) {
        const want = dnsIp || '';
        if (!this._running || this._ifIndex === null) {
            return { ok: false, reason: 'the tunnel is not up' };
        }
        if (want === this._dnsIp) return { ok: true, unchanged: true, dnsIp: want };
        if (want) {
            const r = await netsh(['interface', 'ipv4', 'set', 'dnsserver',
                                   `name=${this._ifIndex}`, 'static', want,
                                   'primary', 'validate=no'], 25000);
            if (!r.ok && !/already|no changes/i.test(r.out)) {
                this.log.error('Tunnel: the adapter would not take the resolver ' +
                               'Tor is now using', { dnsIp: want,
                                                     out: r.out.trim().slice(0, 200) });
                return { ok: false, reason: 'could not set the adapter dns' };
            }
            const gone = await this._unpinResolvers();
            this._dnsIp = want;
            this.log.success('Tunnel: DNS is going through Tor again -- the ' +
                             'adapter now resolves at ' + want + ' and the ' +
                             'routes that kept the old resolvers reachable are ' +
                             'gone.', { unpinned: gone });
        } else {
            const r = await netsh(['interface', 'ipv4', 'delete', 'dnsservers',
                                   `name=${this._ifIndex}`, 'all'], 25000);
            if (!r.ok && !/not found|no changes|element not found/i.test(r.out)) {
                //  Not fatal, and named rather than retried: the adapter still
                //  holds a resolver Tor is no longer listening on, so the honest
                //  thing is to say which failure the machine is now in.
                this.log.error('Tunnel: could NOT clear the adapter resolver ' +
                               'after Tor moved off port 53. Name resolution on ' +
                               'this PC may fail until it disconnects.',
                               { out: r.out.trim().slice(0, 200) });
                return { ok: false, reason: 'could not clear the adapter dns' };
            }
            this._dnsIp = '';
            await this._keepResolversReachable();
        }
        return { ok: true, dnsIp: this._dnsIp };
    }

    //  ── One /32, via the physical gateway, per address ──
    //  Shared by the two callers that need something to stay outside the tunnel.
    //  A /32 is a longer prefix than /1, so it wins route selection
    //  unconditionally, and every address that takes one is recorded in
    //  _hostRoutes so teardown removes exactly what we added.
    async _pinOffTunnel(ips, what) {
        let added = 0;
        for (const ip of ips) {
            if (this._hostRoutes.has(ip)) continue;
            const a = await netsh(['interface', 'ipv4', 'add', 'route',
                `${ip}/32`, `interface=${this._phys.ifIndex}`,
                `nexthop=${this._phys.gateway}`, 'metric=1', 'store=active'], 15000);
            //  "The object already exists" is a success for our purposes: the
            //  address is reachable off-tunnel either way. Anything else is not
            //  recorded, so teardown never deletes a route we did not create.
            if (a.ok || /already exists/i.test(a.out)) {
                this._hostRoutes.set(ip, this._phys.gateway);
                added++;
            } else {
                this.log.warn(`Tunnel: could not pin ${what} outside the tunnel`,
                              { ip, out: a.out.trim().slice(0, 200) });
            }
        }
        return added;
    }

    //  ── Give the adapter an address, a DNS server and our two routes ──
    //  The next hop is the adapter's OWN address. That looks odd and is correct
    //  for a layer-3 device: Wintun has no peer to ARP for, so Windows needs a
    //  next hop it already considers on-link, and TUN_ADDR/24 makes TUN_ADDR
    //  exactly that.
    //
    //  DNS is pinned to 127.0.0.1 on this adapter because Tor's DNSPort listens
    //  there. Loopback is never routed through the tunnel (127.0.0.0/8 is a
    //  longer prefix and points at the loopback pseudo-interface), so the
    //  resolver stays reachable while everything else is captured -- and UDP/53
    //  never has to survive a SOCKS5 hop that could not carry it.
    //
    //  ...WHEN THERE IS ONE TO PIN. dnsIp arrives EMPTY when Tor did not get
    //  port 53 and fell back to DNSPort 9053, and there is no way to write that:
    //  a Windows adapter's resolver is an address with no port field, always :53.
    //  Writing 127.0.0.1 regardless -- which this function used to do
    //  unconditionally -- points the entire machine at a port nothing is
    //  listening on, and that is the one failure main.js's leak-protection
    //  header singles out as NOT failing safe: it kills name resolution
    //  everywhere, VPN or not. So the step is skipped, said out loud, and the
    //  caller keeps the machine's own resolvers reachable instead.
    async _configureAdapter(dnsIp) {
        const steps = [
            ['address', ['interface', 'ipv4', 'set', 'address',
                         `name=${this._ifIndex}`, 'source=static',
                         `addr=${TUN_ADDR}`, `mask=${TUN_MASK}`]],
        ];
        if (dnsIp) {
            steps.push(['dns', ['interface', 'ipv4', 'set', 'dnsserver',
                                `name=${this._ifIndex}`, 'static', dnsIp,
                                'primary', 'validate=no']]);
        } else {
            this.log.warn('Tunnel: no resolver was given for the adapter, so it ' +
                          'is being left without one on purpose. Tor did not get ' +
                          'port 53, and an adapter cannot be pointed at any other ' +
                          'port -- writing 127.0.0.1 here would kill DNS for the ' +
                          'whole machine. Name resolution stays with the system ' +
                          'resolver, which is NOT going through Tor.');
        }
        for (const [what, args] of steps) {
            const r = await netsh(args, 25000);
            if (!r.ok && !/already|no changes/i.test(r.out)) {
                this.log.error('Tunnel: adapter configuration failed',
                               { step: what, out: r.out.trim().slice(0, 300) });
                return { ok: false, reason: `could not set the adapter ${what}` };
            }
        }
        //  Read the address back. An adapter that exists but never took an
        //  address routes nothing, and the routes below would still "succeed".
        const chk = await netsh(['interface', 'ipv4', 'show', 'addresses',
                                 `name=${this._ifIndex}`], 20000);
        if (!chk.ok || !chk.out.includes(TUN_ADDR)) {
            this.log.error('Tunnel: the adapter did not take its address',
                           { want: TUN_ADDR, out: chk.out.trim().slice(0, 300) });
            return { ok: false, reason: 'adapter address read-back mismatch' };
        }
        return { ok: true };
    }

    async _addRoutes() {
        for (const prefix of TUN_ROUTES) {
            const r = await netsh(['interface', 'ipv4', 'add', 'route', prefix,
                `interface=${this._ifIndex}`, `nexthop=${TUN_ADDR}`,
                'metric=1', 'store=active'], 20000);
            if (!r.ok && !/already exists/i.test(r.out)) {
                this.log.error('Tunnel: a default-capture route was refused',
                               { prefix, out: r.out.trim().slice(0, 300) });
                return { ok: false, reason: `route ${prefix} was refused` };
            }
            this._addedRoutes.push(prefix);
        }
        //  Read back, by index as well as by prefix: a route that exists but
        //  points at the wrong interface is the one failure that would look
        //  like a working tunnel and send everything out the physical NIC.
        const q = await netsh(['interface', 'ipv4', 'show', 'route'], 20000);
        const have = TUN_ROUTES.filter(p => new RegExp(
            `\\s${p.replace(/[.\/]/g, m => '\\' + m)}\\s+${this._ifIndex}\\s`
        ).test(q.out || ''));
        if (have.length !== TUN_ROUTES.length) {
            this.log.error('Tunnel: routes are not in the table against our ' +
                           'adapter -- refusing to report a tunnel',
                           { wanted: TUN_ROUTES, verified: have,
                             ifIndex: this._ifIndex });
            return { ok: false, reason: 'route read-back mismatch' };
        }
        return { ok: true };
    }

    //  ── Bring the tunnel up ──
    //  Strict order, and every step can refuse. Nothing reports success that
    //  was not read back out of Windows:
    //    1. the binaries are in this build            (else: refuse, and say so)
    //    2. remember the real default route BEFORE we start competing with it
    //    3. spawn tun2socks, which creates the Wintun adapter
    //    4. wait for the adapter to appear, by name
    //    5. give it an address and a resolver, then read the address back
    //       (no resolver, and pin the machine's own instead, when Tor did not
    //        get port 53 -- see _configureAdapter and _keepResolversReachable)
    //    6. pin Tor's current relays outside the tunnel  (see _excludeTorPeers)
    //    7. only then capture the default route, and read the routes back
    //  Any failure from step 3 onwards runs the full teardown, so a half-built
    //  tunnel never survives this function.
    //  dnsIp: the resolver to put on the adapter, or '' for "there isn't one".
    //  Empty is a real and expected value, not a mistake -- main.js passes it
    //  when Tor fell back to DNSPort 9053 -- and it must NOT be defaulted back
    //  to 127.0.0.1 anywhere downstream.
    async start({ socksPort = 9050, torPid = null, dnsIp = '127.0.0.1',
                  logLevel = 'warn' } = {}) {
        if (this._running) return { ok: true, already: true, localIp: TUN_ADDR };

        const avail = this.isAvailable();
        if (!avail.ok) {
            this.log.warn('Tunnel unavailable -- this build cannot route ' +
                          'proxy-unaware apps through Tor', { reason: avail.reason,
                                                              dir: avail.dir });
            return { ok: false, reason: avail.reason, unavailable: true };
        }

        this._stopping    = false;
        this._torPid      = torPid;
        this._addedRoutes = [];
        this._hostRoutes  = new Map();
        this._dnsRoutes   = new Set();
        this._dnsIp       = dnsIp || '';
        this._lastLines   = [];

        //  Read the physical default first. Once our routes are in, ours is the
        //  one with metric 1 and this lookup would start returning our own.
        this._phys = await this.physicalDefault();
        if (!this._phys) {
            this.log.error('Tunnel: this machine has no usable default gateway, ' +
                           'so Tor could not be kept outside the tunnel. Refusing.');
            return { ok: false, reason: 'no physical default gateway to pin Tor to' };
        }

        const args = ['-device', `tun://${TUN_NAME}`,
                      '-proxy', `socks5://127.0.0.1:${socksPort}`,
                      '--loglevel', logLevel];
        try {
            this.proc = spawn(this.exePath, args, {
                cwd: this.binDir,          // wintun.dll is loaded from here
                windowsHide: true,
                stdio: ['ignore', 'pipe', 'pipe'],
            });
        } catch (e) {
            this.log.error('Tunnel: tun2socks could not be started',
                           { exe: this.exePath, err: e.message });
            return { ok: false, reason: 'tun2socks could not be started: ' + e.message };
        }

        const keep = d => {
            for (const l of String(d).split(/\r?\n/)) {
                if (!l.trim()) continue;
                this._lastLines.push(l.trim());
                if (this._lastLines.length > 12) this._lastLines.shift();
            }
        };
        this.proc.stdout?.on('data', keep);
        this.proc.stderr?.on('data', keep);
        this.proc.on('error', err =>
            this.log.error('Tunnel: tun2socks process error', { err: err.message }));
        this.proc.on('exit', (code, signal) => this._onProcExit(code, signal));

        const idx = await this._findAdapter(15000);
        if (idx === null) {
            const why = this._lastLines.length ? this._lastLines.slice(-4)
                                               : ['tun2socks printed nothing'];
            this.log.error('Tunnel: the Wintun adapter never appeared', { why });
            await this.stop({ quiet: true });
            return { ok: false, reason: 'the Wintun adapter never appeared', why };
        }
        this._ifIndex = idx;

        const cfg = await this._configureAdapter(dnsIp);
        if (!cfg.ok) { await this.stop({ quiet: true }); return cfg; }

        //  No resolver on the adapter means the machine is about to resolve
        //  through the physical one, whose UDP/53 the routes below would swallow.
        //  Done BEFORE the capture, for the same reason Tor's relays are.
        const resolvers = dnsIp ? null : await this._keepResolversReachable();

        //  Before the capture, not after: tor.exe already has guard connections
        //  open at this point and they must not be the casualty of our own
        //  routes. Seeding here means the existing circuit survives the switch.
        const pinned = await this._excludeTorPeers();
        if (this._torPid && !pinned.added) {
            //  Not fatal on its own -- tor may legitimately hold zero sockets
            //  for a moment -- but it is the single most likely cause of a
            //  tunnel that comes up and carries nothing, so it is logged loudly.
            this.log.warn('Tunnel: no Tor relay addresses were pinned outside ' +
                          'the tunnel yet. If Tor was mid-reconnect this is ' +
                          'normal and the watcher will fix it within ' +
                          `${PEER_WATCH_MS} ms.`, { torPid: this._torPid,
                                                    error: pinned.error || null });
        }

        const routes = await this._addRoutes();
        if (!routes.ok) { await this.stop({ quiet: true }); return routes; }

        this._running = true;
        this._watchTimer = setInterval(() => {
            this._excludeTorPeers().catch(() => {});
        }, PEER_WATCH_MS);

        this.log.success('Tunnel UP -- every TCP connection on this PC now goes ' +
                         'through Tor, including from apps that have no proxy ' +
                         'setting. UDP and ICMP are not carried.', {
            adapter: TUN_NAME, ifIndex: this._ifIndex, localIp: TUN_ADDR,
            socks: `127.0.0.1:${socksPort}`,
            dns: dnsIp || 'system resolver (NOT through Tor -- port 53 was taken)',
            resolversPinnedOutside: resolvers ? resolvers.pinned : 0,
            relaysPinnedOutside: this._hostRoutes.size,
            viaGateway: this._phys.gateway,
        });
        return { ok: true, localIp: TUN_ADDR, ifIndex: this._ifIndex,
                 dnsViaTor: !!dnsIp,
                 relaysPinned: this._hostRoutes.size };
    }

    //  ── tun2socks died on its own ──
    //  Distinguished from a stop() we asked for. If the tunnel was up, the
    //  adapter has just vanished and with it every route that pointed at it, so
    //  the machine has silently reverted to its real IP for anything that was
    //  relying on us. Reporting that is the whole reason this handler exists;
    //  main.js turns it into a fail-closed disconnect.
    _onProcExit(code, signal) {
        const wasRunning = this._running;
        this._running = false;
        this._stopRoutesWatcher();
        this.proc = null;
        if (this._stopping) return;
        if (wasRunning) {
            this.log.error('Tunnel DOWN -- tun2socks exited while the tunnel was ' +
                           'up. Traffic is no longer being routed through Tor.',
                           { code, signal: signal || null,
                             lastOutput: this._lastLines.slice(-6) });
        } else {
            this.log.warn('Tunnel: tun2socks exited before the tunnel was up',
                          { code, signal: signal || null,
                            lastOutput: this._lastLines.slice(-6) });
        }
        //  Routes via a dead adapter are removed by Windows, but ours are
        //  deleted explicitly anyway so nothing depends on that behaviour.
        this._removeRoutes().catch(() => {});
        if (wasRunning && typeof this.onExit === 'function') {
            try { this.onExit({ code, signal: signal || null,
                                lastOutput: this._lastLines.slice(-6) }); }
            catch (e) { /* main.js's own error path owns this */ }
        }
    }

    _stopRoutesWatcher() {
        if (this._watchTimer) { clearInterval(this._watchTimer); this._watchTimer = null; }
    }

    //  Deletes exactly what we created, and nothing else -- the two capture
    //  prefixes against our own interface index, and the /32s we recorded.
    async _removeRoutes() {
        for (const prefix of TUN_ROUTES) {
            if (this._ifIndex === null) break;
            await netsh(['interface', 'ipv4', 'delete', 'route', prefix,
                         `interface=${this._ifIndex}`, `nexthop=${TUN_ADDR}`,
                         'store=active'], 15000);
        }
        this._addedRoutes = [];
        for (const [ip, gw] of this._hostRoutes) {
            if (!this._phys) break;
            await netsh(['interface', 'ipv4', 'delete', 'route', `${ip}/32`,
                         `interface=${this._phys.ifIndex}`, `nexthop=${gw}`,
                         'store=active'], 15000);
        }
        this._hostRoutes.clear();
        this._dnsRoutes.clear();
    }

    //  ── Take it down ──
    //  Routes first, process second. The other order leaves a window in which
    //  the route table points at an adapter that no longer exists, and every
    //  connection started in that window fails instead of falling back to the
    //  physical NIC. Like Containment.disable(), this never returns early: it
    //  collects problems and reports them.
    async stop({ quiet = false } = {}) {
        this._stopping = true;
        this._stopRoutesWatcher();
        const had = this._running;
        this._running = false;

        await this._removeRoutes();

        if (this.proc && !this.proc.killed) {
            const pid = this.proc.pid;
            try { this.proc.kill(); } catch (e) { /* fall through to taskkill */ }
            //  Give it a moment, then make sure. A surviving tun2socks holds the
            //  Wintun adapter open, and the next start() would find a stale
            //  adapter with our name and configure the wrong device.
            for (let i = 0; i < 10 && this.proc && !this.proc.killed; i++) await wait(150);
            if (this.proc && !this.proc.killed) {
                await run('taskkill.exe', ['/PID', String(pid), '/T', '/F'], 15000);
            }
        }
        this.proc = null;
        this._ifIndex = null;

        //  Read back that the capture is gone. This is the check that matters
        //  most on the way down: a leftover /1 route with no adapter behind it
        //  would black-hole the machine.
        const q = await netsh(['interface', 'ipv4', 'show', 'route'], 20000);
        const left = TUN_ROUTES.filter(p => new RegExp(
            `\\s${p.replace(/[.\/]/g, m => '\\' + m)}\\s`).test(q.out || ''));
        if (left.length) {
            this.log.error('Tunnel: capture routes are STILL in the table after ' +
                           'teardown -- run "route delete 0.0.0.0 mask 128.0.0.0" ' +
                           'and the same for 128.0.0.0 as administrator',
                           { left });
            return { ok: false, reason: 'routes survived teardown', left };
        }
        if (had && !quiet) {
            this.log.success('Tunnel down -- routing is back on the physical ' +
                             'adapter. The proxy layers are unaffected.');
        }
        return { ok: true };
    }

    //  Best-effort teardown for will-quit, where nothing can be awaited. The
    //  two route deletes are what matter; the process dies with its parent.
    stopNoWait() {
        this._stopping = true;
        this._stopRoutesWatcher();
        this._running = false;
        const fire = args => {
            try {
                spawn('netsh.exe', args, { windowsHide: true, detached: true,
                                           stdio: 'ignore' }).unref();
            } catch (e) { /* nothing left to try at this point */ }
        };
        for (const prefix of TUN_ROUTES) {
            fire(['interface', 'ipv4', 'delete', 'route', prefix,
                  `nexthop=${TUN_ADDR}`, 'store=active']);
        }
        if (this.proc && !this.proc.killed) {
            try { this.proc.kill(); } catch (e) { /* it goes with the parent */ }
        }
    }

    //  ── Startup cleanup, for the run after a crash ──
    //  Called once at app start, before anything connects. If the app was killed
    //  while the tunnel was up, tun2socks died with it and Windows removed the
    //  routes that pointed at the vanished adapter -- but a leftover tun2socks
    //  from a detached process, or a route Windows kept, would poison the next
    //  start. Both are deleted here by prefix, without needing to know an
    //  interface index we no longer have.
    //
    //  NOT cleaned up, and deliberately: the /32 host routes for Tor relays.
    //  We cannot tell ours from a network administrator's after a crash, they
    //  are store=active so a reboot clears them, and what they do meanwhile is
    //  send traffic for a Tor relay address to the real gateway -- which is
    //  what an un-tunnelled machine does anyway. The only process that talks to
    //  those addresses is tor.exe, and under containment nothing else may.
    async cleanupStale() {
        const q = await netsh(['interface', 'ipv4', 'show', 'route'], 20000);
        const left = TUN_ROUTES.filter(p => new RegExp(
            `\\s${p.replace(/[.\/]/g, m => '\\' + m)}\\s`).test(q.out || ''));
        let killed = 0;
        //  Any tun2socks still holding our adapter from a previous run.
        const t = await run('taskkill.exe', ['/IM', 'tun2socks.exe', '/F'], 15000);
        if (t.ok && /SUCCESS/i.test(t.out)) killed++;
        if (!left.length && !killed) return { ok: true, cleaned: false };
        for (const prefix of left) {
            await netsh(['interface', 'ipv4', 'delete', 'route', prefix,
                         `nexthop=${TUN_ADDR}`, 'store=active'], 15000);
        }
        const after = await netsh(['interface', 'ipv4', 'show', 'route'], 20000);
        const still = TUN_ROUTES.filter(p => new RegExp(
            `\\s${p.replace(/[.\/]/g, m => '\\' + m)}\\s`).test(after.out || ''));
        if (still.length) {
            this.log.error('Tunnel: stale capture routes from a previous run ' +
                           'could not be removed', { still });
            return { ok: false, still };
        }
        this.log.warn('Tunnel: cleaned up after a previous run that did not shut ' +
                      'down cleanly', { routesRemoved: left, tun2socksKilled: killed });
        return { ok: true, cleaned: true, routesRemoved: left };
    }
}

//  Exported at the BOTTOM for the same reason as lib/containment.js: a `class`
//  binding is in a temporal dead zone until its declaration is evaluated, so an
//  export at the top of the file throws ReferenceError at require() time.
module.exports = { TUN_NAME, TUN_ADDR, TUN_MASK, TUN_ROUTES, Tunnel };

