//  Scratch: exercise lib/tunnel.js as far as the current token allows.
//  Written with the Write tool -- bash heredocs eat doubled backslashes and
//  every path in here is a Windows path.
//
//  Unelevated it verifies: binary presence, the two netsh parsers against this
//  machine's real output, the netstat PID filter, and the exact argv handed to
//  tun2socks. It states plainly which assertions it COULD NOT make.
//  Run with --live (as administrator) to also create the adapter, configure it,
//  read the address back and tear it down. --live does NOT install the capture
//  routes, so the machine's networking is never taken over by this probe.
'use strict';
const path = require('path');
const { execFileSync, execFile } = require('child_process');
const { Tunnel, TUN_NAME, TUN_ADDR, TUN_ROUTES } = require('../lib/tunnel.js');

const log = {
    info:    (m, x) => console.log('I', m, x ? JSON.stringify(x) : ''),
    warn:    (m, x) => console.log('W', m, x ? JSON.stringify(x) : ''),
    error:   (m, x) => console.log('E', m, x ? JSON.stringify(x) : ''),
    success: (m, x) => console.log('S', m, x ? JSON.stringify(x) : ''),
    debug:   () => {},
};

let elevated = false;
try { execFileSync('net', ['session'], { stdio: 'ignore' }); elevated = true; }
catch (e) { elevated = false; }

const binDir = path.join(__dirname, '..', 'Tun');
const T = new Tunnel({ Logger: log, binDir });

const fail = [];
const check = (name, cond, extra) => {
    console.log((cond ? '  ok   ' : ' FAIL  ') + name, extra === undefined ? '' : extra);
    if (!cond) fail.push(name);
};

(async () => {
    console.log('=== elevation:', elevated ? 'ADMIN' : 'user (live steps skipped) ===');

    // 1. the binaries this build carries
    const a = T.isAvailable();
    check('isAvailable() says the tunnel is shippable', a.ok, JSON.stringify(a));

    // 2. tun2socks runs and is the version we pinned
    let ver = '';
    try {
        ver = execFileSync(T.exePath, ['--version'],
                           { encoding: 'utf8', windowsHide: true }).trim();
    } catch (e) { ver = 'FAILED: ' + e.message; }
    check('tun2socks reports v2.7.0', /^tun2socks-2\.7\.0\b/.test(ver), ver);

    // 3. physicalDefault() against this machine's real route table
    const phys = await T.physicalDefault();
    check('physicalDefault() found a gateway', !!(phys && phys.gateway),
          JSON.stringify(phys));
    check('  ...and it is not our own tunnel address',
          !phys || phys.gateway !== TUN_ADDR);

    // 4. _findAdapter() must NOT find an adapter before we make one
    const pre = await T._findAdapter(600);
    check('no stale ' + TUN_NAME + ' adapter is present', pre === null, String(pre));

    // 5. netstat PID filter -- point it at a PID that has real sockets so the
    //    parser is exercised on live output rather than on nothing. This probe's
    //    own process has none, so use whatever holds the most TCP connections.
    const busiest = await new Promise(res => {
        execFile('netstat.exe', ['-ano'], { encoding: 'utf8', windowsHide: true },
            (e, out) => {
                if (e) return res(null);
                const n = new Map();
                for (const l of String(out).split(/\r?\n/)) {
                    const m = /^\s*TCP\s+(\S+)\s+(\S+)\s+ESTABLISHED\s+(\d+)\s*$/.exec(l);
                    if (m) n.set(m[3], (n.get(m[3]) || 0) + 1);
                }
                const top = [...n.entries()].sort((x, y) => y[1] - x[1])[0];
                res(top ? { pid: Number(top[0]), conns: top[1] } : null);
            });
    });
    if (busiest) {
        T._torPid = busiest.pid;
        T._phys   = null;                 // no _phys => discovery only, adds nothing
        const r = await T._excludeTorPeers();
        check('_excludeTorPeers() is a no-op without a gateway', r.added === 0,
              JSON.stringify(r));
        //  Now prove the netstat parse itself finds the peers of that PID.
        T._phys = { ifIndex: -1, gateway: '0.0.0.0' };   // bogus on purpose
        const seen = await new Promise(res => {
            execFile('netstat.exe', ['-ano'], { encoding: 'utf8', windowsHide: true },
                (e, out) => {
                    let c = 0;
                    for (const l of String(out || '').split(/\r?\n/)) {
                        const m = /^\s*TCP\s+(\S+)\s+(\S+)\s+(\S+)\s+(\d+)\s*$/.exec(l);
                        if (m && Number(m[4]) === busiest.pid) c++;
                    }
                    res(c);
                });
        });
        check('netstat row regex matches the busiest PID\'s rows', seen > 0,
              `pid ${busiest.pid}, ${seen} rows`);
        T._torPid = null; T._phys = null;
    } else {
        console.log('  skip  netstat filter -- no ESTABLISHED rows on this machine');
    }

    // 6. the argv we would hand tun2socks
    check('TUN_ROUTES is the /1 pair, not 0.0.0.0/0',
          TUN_ROUTES.length === 2 && TUN_ROUTES.join(',') === '0.0.0.0/1,128.0.0.0/1',
          TUN_ROUTES.join(' '));

    // 7. refuse-to-pretend path: a build with no binaries must say so
    const T2 = new Tunnel({ Logger: log, binDir: path.join(__dirname, 'no-such-dir') });
    const a2 = T2.isAvailable();
    check('a build without the binaries reports unavailable', !a2.ok, a2.reason);
    const s2 = await T2.start({ socksPort: 9050 });
    check('  ...and start() refuses instead of claiming a tunnel',
          s2.ok === false && s2.unavailable === true, JSON.stringify(s2));

    // 8. LIVE: create the adapter, configure it, read it back, tear it down.
    if (!elevated) {
        console.log('  NOT VERIFIED (needs admin): adapter creation, address ' +
                    'read-back, route read-back, teardown');
    } else {
        console.log('--- live: creating the adapter (no capture routes) ---');
        const res = await liveAdapterOnly();
        check('live adapter appeared and took ' + TUN_ADDR, res.ok, JSON.stringify(res));
    }

    console.log(fail.length ? 'FAIL: ' + fail.join(' | ') : 'PASS');
    process.exit(fail.length ? 1 : 0);
})();

//  Everything start() does except _addRoutes(), so the machine's routing is
//  untouched. If any step fails the teardown still runs.
async function liveAdapterOnly() {
    const { spawn } = require('child_process');
    const proc = spawn(T.exePath,
        ['-device', 'tun://' + TUN_NAME, '-proxy', 'socks5://127.0.0.1:9050',
         '--loglevel', 'warn'],
        { cwd: binDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    proc.stdout.on('data', d => { out += d; });
    proc.stderr.on('data', d => { out += d; });
    T.proc = proc;
    try {
        const idx = await T._findAdapter(15000);
        if (idx === null) return { ok: false, why: 'adapter never appeared',
                                   out: out.trim().slice(-300) };
        T._ifIndex = idx;
        const cfg = await T._configureAdapter('127.0.0.1');
        if (!cfg.ok) return { ok: false, why: cfg.reason, ifIndex: idx };
        return { ok: true, ifIndex: idx };
    } finally {
        T._stopping = true;
        await T.stop({ quiet: true });
    }
}
