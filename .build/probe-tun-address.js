//  Scratch: the live probe got as far as an adapter named FreeProxyTun at
//  ifIndex 52 and then failed on "the adapter did not take its address" --
//  `show addresses` printed DHCP enabled: No and InterfaceMetric: 5 with no
//  IP Address line at all. Three things could produce that and they need
//  different fixes, so this measures which one it is:
//
//    timing      -- the address lands a beat after netsh returns
//    media state -- Windows drops the address of a disconnected adapter
//    dead child  -- tun2socks exited and took the adapter with it
//
//  Needs administrator. Creates the adapter, polls, tears it down. No capture
//  routes, so the machine's routing is never touched.
'use strict';
const path = require('path');
const { execFile, execFileSync, spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const { TUN_NAME, TUN_ADDR, TUN_MASK } = require('../lib/tunnel.js');
const EXE = path.join(ROOT, 'Tun', 'tun2socks.exe');

try { execFileSync('net', ['session'], { stdio: 'ignore' }); }
catch (e) { console.log('NOT ELEVATED -- nothing measured'); process.exit(2); }

const sh = (file, args, t = 20000) => new Promise(res => {
    execFile(file, args, { encoding: 'utf8', windowsHide: true, timeout: t },
        (e, out, err) => res({ ok: !e, out: String(out || '') + String(err || '') }));
});
const netsh = (args, t) => sh('netsh.exe', args, t);
const sleep = ms => new Promise(r => setTimeout(r, ms));

//  `show addresses name=<idx>` is what lib/tunnel.js reads. Get-NetIPAddress is
//  a second opinion from a different API, so "netsh is lying" is separable from
//  "the address is not there".
async function snapshot(idx) {
    const a = await netsh(['interface', 'ipv4', 'show', 'addresses', `name=${idx}`]);
    const s = await netsh(['interface', 'show', 'interface']);
    const row = (s.out.split(/\r?\n/).find(l => l.includes(TUN_NAME)) || '').trim();
    const g = await sh('powershell.exe', ['-NoProfile', '-Command',
        `(Get-NetIPAddress -InterfaceIndex ${idx} -AddressFamily IPv4 ` +
        `-ErrorAction SilentlyContinue | Select-Object -Expand IPAddress) -join ','`]);
    return {
        hasAddr: a.out.includes(TUN_ADDR),
        addrLine: (a.out.split(/\r?\n/).find(l => /IP Address/i.test(l)) || '(no IP Address line)').trim(),
        dhcp: (a.out.split(/\r?\n/).find(l => /DHCP enabled/i.test(l)) || '').trim(),
        ifRow: row || '(no ' + TUN_NAME + ' row)',
        psAddr: g.out.trim() || '(none)',
    };
}

(async () => {
    const before = await netsh(['interface', 'ipv4', 'show', 'interfaces']);
    if (before.out.includes(TUN_NAME)) {
        console.log('a ' + TUN_NAME + ' adapter is already present -- refusing to touch it');
        process.exit(1);
    }

    const proc = spawn(EXE, ['--device', 'tun://' + TUN_NAME,
                             '--proxy', 'socks5://127.0.0.1:9050',
                             '--loglevel', 'debug'],
                       { cwd: path.join(ROOT, 'Tun'), windowsHide: true,
                         stdio: ['ignore', 'pipe', 'pipe'] });
    let child = '';
    let alive = true;
    proc.stdout.on('data', d => { child += d; });
    proc.stderr.on('data', d => { child += d; });
    proc.on('exit', (c, s) => { alive = false; child += `\n[child exited code=${c} signal=${s}]\n`; });

    //  find it
    let idx = null;
    const t0 = Date.now();
    while (idx === null && Date.now() - t0 < 15000) {
        const r = await netsh(['interface', 'ipv4', 'show', 'interfaces'], 15000);
        for (const l of r.out.split(/\r?\n/)) {
            if (!l.includes(TUN_NAME)) continue;
            const m = /^\s*(\d+)\s/.exec(l);
            if (m) idx = Number(m[1]);
        }
        if (idx === null) await sleep(400);
    }
    console.log(`adapter: ${idx === null ? 'NEVER APPEARED' : 'ifIndex ' + idx} ` +
                `after ${Date.now() - t0} ms, child ${alive ? 'alive' : 'DEAD'}`);
    if (idx === null) { console.log(child.trim().slice(-800)); return kill(); }

    console.log('\n-- before the set --');
    console.log(JSON.stringify(await snapshot(idx), null, 1));

    const set = await netsh(['interface', 'ipv4', 'set', 'address',
                             `name=${idx}`, 'source=static',
                             `addr=${TUN_ADDR}`, `mask=${TUN_MASK}`], 25000);
    console.log(`\nset address -> ok=${set.ok} ${JSON.stringify(set.out.trim().slice(0, 200))}`);

    //  Poll. If it is timing, one of these rounds flips hasAddr to true and the
    //  fix is a wait; if every round is false while the child is alive and the
    //  interface row says Connected, it is not timing.
    for (let i = 1; i <= 12; i++) {
        const s = await snapshot(idx);
        console.log(`t+${String(i * 1000).padStart(5)} ms  hasAddr=${s.hasAddr}  ` +
                    `child=${alive ? 'alive' : 'DEAD'}  ps=${s.psAddr}  ` +
                    `| ${s.ifRow} | ${s.dhcp} | ${s.addrLine}`);
        if (s.hasAddr) break;
        await sleep(1000);
    }

    console.log('\n-- tun2socks said --');
    console.log(child.trim().slice(-1200) || '(nothing)');
    await kill();

    async function kill() {
        try { proc.kill(); } catch (e) {}
        await sleep(1200);
        const after = await netsh(['interface', 'ipv4', 'show', 'interfaces']);
        console.log('\nadapter gone after teardown: ' + !after.out.includes(TUN_NAME));
    }
})();
