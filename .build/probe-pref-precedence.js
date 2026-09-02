'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/probe-pref-precedence.js  --  does an explicit value MASK another
//  extension's proxy pref, where clearing hands control back to it?
//
//  probe-socks-catches-brave.js measured Brave sending every request -- pages,
//  favicons, go-updater.brave.com, ohttp.ads.brave.com -- to a stub on
//  127.0.0.1:9050, with the app shut down, still going at 16.8 s, i.e. well past
//  the 11.1 s at which probe-brave-start-clears.js timed our worker releasing.
//  So our extension DID release and the browser stayed proxied anyway. The reason
//  it can do both is that `chrome.proxy.settings.clear()` does not mean "no proxy",
//  it means "I relinquish": Chromium then applies the next value in the store, and
//  that is the fossil id's stuck fixed_servers record.
//
//  If that reading is right, the repair is a one-line change of what "off" means --
//  write an explicit value instead of clearing, and the fossil is masked rather
//  than exposed. That is a claim about Chromium's own precedence between two
//  extension-controlled values, so it is measured, not asserted.
//
//  Two throwaway unpacked extensions in a throwaway profile, so nothing here can
//  touch the real one:
//      A  stands in for the fossil: sets fixed_servers socks5://127.0.0.1:9050
//      B  stands in for ours: 4 s later does ONE of
//              clear()                     the code as it is today
//              set({mode:'direct'})        never proxy
//              set({mode:'system'})        defer to the OS settings
//         then opens the target page from the call's own completion callback.
//  A stub SOCKS5 on 9050 completes the CONNECT for real, so a page load is
//  positive evidence either way: arriving via 9050 says A won, arriving directly
//  says B won.
//
//  Phase 2, for whichever variants masked: kill the browser, blank B's worker so
//  only the STORED pref can speak, and relaunch. If it is still direct, the mask
//  covers the cold-start window too -- the 11.1 s in which everything opened
//  today fails, which no reordering inside background.js could ever shorten.
//
//  Writes only inside its own temp directory, which it removes. The real profile,
//  the repo and ProgramData are untouched.
// ════════════════════════════════════════════════════════════════════
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

const BRAVE = 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe';
const TMP = path.join(os.tmpdir(), 'fp-prec-' + Date.now());

const running = name => {
    try {
        return execFileSync('tasklist', ['/FI', `IMAGENAME eq ${name}`], { encoding: 'utf8' })
            .toLowerCase().includes(name.toLowerCase());
    } catch (e) { return false; }
};

function lanAddress() {
    for (const [name, addrs] of Object.entries(os.networkInterfaces()))
        for (const a of addrs || [])
            if (a.family === 'IPv4' && !a.internal &&
                /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address))
                return { name, address: a.address };
    return null;
}

const pre = [];
if (!fs.existsSync(BRAVE)) pre.push('brave.exe not found at ' + BRAVE);
if (running('FreeProxy VPN.exe')) pre.push('the desktop app is RUNNING -- shut it down first');
if (running('tor.exe')) pre.push('tor.exe is running and already owns 9050');
if (running('brave.exe')) pre.push('brave.exe is already running -- this probe closes every Brave ' +
                                   'between phases, and those tabs are the user\'s');
const lan = lanAddress();
if (!lan) pre.push('no private LAN IPv4 address on this machine');

console.log('══ preconditions ══');
console.log(`  app running    ${running('FreeProxy VPN.exe') ? 'YES' : 'no'}`);
console.log(`  brave running  ${running('brave.exe') ? 'YES' : 'no'}`);
console.log(`  LAN target     ${lan ? lan.address + '  (' + lan.name + ')' : '(none)'}`);
console.log(`  temp dir       ${TMP}`);
if (pre.length) { console.log('\nABORT: ' + pre.join('\n       ')); process.exit(3); }

// ── capture, re-pointed per phase so each phase reads only its own traffic ──
let CUR = { connects: [], hits: [] };
let T0 = Date.now();
const rel = () => String(Date.now() - T0).padStart(6) + ' ms';

//  Same minimal SOCKS5 as probe-socks-catches-brave.js: greet, no-auth, CONNECT,
//  dial, tunnel. Completing for real matters -- a stub that refused would give the
//  same error page as no stub at all, and then a variant that failed to mask and a
//  variant that broke the browser outright would read identically.
const socks = net.createServer(sock => {
    let stage = 0, buf = Buffer.alloc(0);
    sock.on('error', () => {});
    sock.on('data', chunk => {
        if (stage === 3) return;
        buf = Buffer.concat([buf, chunk]);
        if (stage === 0) {
            if (buf.length < 2) return;
            const n = buf[1];
            if (buf.length < 2 + n) return;
            buf = buf.subarray(2 + n);
            stage = 1;
            sock.write(Buffer.from([0x05, 0x00]));
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
            CUR.connects.push({ at: Date.now() - T0, host, port });
            console.log(`  ${rel()}  via 9050  CONNECT ${host}:${port}`);
            const up = net.connect(port, host, () => {
                sock.write(Buffer.from([0x05, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
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
        CUR.hits.push({ at: Date.now() - T0, url: req.url });
        console.log(`  ${rel()}  DIRECT    ${req.url}`);
    }
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
    res.end('<!doctype html><title>reached</title><h1>reached</h1>');
});

function control(url) {
    return new Promise(resolve => {
        const req = http.get(url, r => { r.resume(); resolve(r.statusCode); });
        req.on('error', e => resolve('ERROR ' + e.code));
        req.setTimeout(4000, () => { req.destroy(); resolve('TIMEOUT'); });
    });
}

const EXT_A = path.join(TMP, 'ext-a');
const EXT_B = path.join(TMP, 'ext-b');

function manifest(dir, name, perms) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
        manifest_version: 3,
        name: name,
        version: '1.0.0',
        permissions: perms,
        background: { service_worker: 'bg.js' },
    }, null, 2));
}

//  A is loaded FIRST so its install time is the earlier of the two, matching the
//  real profile where the fossil predates the extension we ship.
function writeExtA() {
    manifest(EXT_A, 'fp-precedence-A (stands in for the fossil)', ['proxy']);
    fs.writeFileSync(path.join(EXT_A, 'bg.js'),
        `chrome.proxy.settings.set({\n` +
        `    value: { mode: 'fixed_servers',\n` +
        `             rules: { singleProxy: { scheme: 'socks5', host: '127.0.0.1', port: 9050 },\n` +
        `                      bypassList: ['localhost', '127.0.0.1', '<local>'] } },\n` +
        `    scope: 'regular',\n` +
        `}, () => { void chrome.runtime.lastError; console.log('A: fixed_servers set'); });\n`);
}

//  action null leaves B inert, which is how phase 2 asks what the STORED pref does
//  on its own with no worker writing anything.
function writeExtB(action, url) {
    manifest(EXT_B, 'fp-precedence-B (stands in for ours)', ['proxy', 'tabs']);
    const body = action === null
        ? `//  deliberately inert: phase 2 measures the stored pref, not a fresh write.\n`
        : `setTimeout(() => {\n` +
          `    //  The page is opened from the proxy call's OWN callback, because\n` +
          `    //  chrome.tabs.* and chrome.proxy.* are separate IPC channels and a\n` +
          `    //  navigation issued in the same tick can be dispatched under the old value.\n` +
          `    const open = () => { void chrome.runtime.lastError;\n` +
          `        chrome.tabs.create({ url: ${JSON.stringify(url)} }); };\n` +
          `    if (${JSON.stringify(action)} === 'clear') chrome.proxy.settings.clear({ scope: 'regular' }, open);\n` +
          `    else chrome.proxy.settings.set({ value: { mode: ${JSON.stringify(action)} }, scope: 'regular' }, open);\n` +
          `}, 4000);\n`;
    fs.writeFileSync(path.join(EXT_B, 'bg.js'), body);
}

function runPhase(label, extraArgs, ms, profile) {
    return new Promise(resolve => {
        CUR = { connects: [], hits: [] };
        T0 = Date.now();
        console.log(`\n── ${label} ──`);
        const p = spawn(BRAVE, [
            `--user-data-dir=${profile}`,
            '--no-first-run',
            '--no-default-browser-check',
            `--load-extension=${EXT_A},${EXT_B}`,
            ...extraArgs,
        ], { detached: true, stdio: 'ignore' });
        p.unref();
        setTimeout(() => {
            const got = CUR;
            //  Closed, not /F: the profile write is the whole point of phase 2, and a
            //  killed Chromium skips it.
            try { execFileSync('taskkill', ['/IM', 'brave.exe'], { stdio: 'ignore' }); } catch (e) {}
            setTimeout(() => resolve(got), 4000);      // let the lock clear before a relaunch
        }, ms);
    });
}

let PORT = 0;
const toTarget = r => r.connects.filter(c => c.host === lan.address && c.port === PORT);
const elsewhere = r => r.connects.filter(c => !(c.host === lan.address && c.port === PORT));
const masked = r => toTarget(r).length === 0 && r.hits.length > 0;

function line(tag, r) {
    console.log(`  ${tag.padEnd(34)} target via 9050: ${String(toTarget(r).length).padStart(2)}   ` +
                `other via 9050: ${String(elsewhere(r).length).padStart(2)}   ` +
                `page loads: ${String(r.hits.length).padStart(2)}`);
}

async function main() {
    PORT = target.address().port;
    const base = `http://${lan.address}:${PORT}/`;
    console.log(`  target http    ${base}`);
    const code = await control(base + 'control');
    console.log(`  control fetch  ${code}`);
    if (code !== 200) {
        console.log('\nABORT: node cannot reach its own target, so nothing measured here would mean ' +
                    'anything.');
        process.exit(3);
    }

    writeExtA();
    const R = {};
    for (const action of ['clear', 'direct', 'system']) {
        writeExtB(action, base + 'p1-' + action);
        R[action] = { p1: await runPhase(`variant "${action}" -- phase 1, B acts at 4 s then opens the page`,
                                        ['about:blank'], 16000, path.join(TMP, 'prof-' + action)) };
    }

    //  Phase 2 only for a variant that actually masked -- there is no stored value to
    //  ask about otherwise. B is blanked so nothing writes during the start.
    writeExtB(null);
    for (const action of ['direct', 'system']) {
        if (!masked(R[action].p1)) continue;
        R[action].p2 = await runPhase(`variant "${action}" -- phase 2, cold start, B inert, stored pref only`,
                                     [base + 'p2-' + action], 12000, path.join(TMP, 'prof-' + action));
    }

    console.log('\n══ what each variant measured ══');
    line('clear   (today\'s code)  phase 1', R.clear.p1);
    for (const action of ['direct', 'system']) {
        line(`${action}  phase 1`, R[action].p1);
        if (R[action].p2) line(`${action}  phase 2 (restart)`, R[action].p2);
    }

    console.log('\n══ verdict ══');
    let code2 = 1;
    if (!toTarget(R.clear.p1).length) {
        console.log('  INVALID: with B clearing, the page did NOT go through 9050 -- so A never had');
        console.log('  the pref in force and this setup measured nothing. Do not read the other two');
        console.log('  rows as a result either way.');
        code2 = 3;
    } else {
        console.log('  clear() hands control back: with B clearing, A\'s fixed_servers applied and the');
        console.log(`  page went through 9050 (${toTarget(R.clear.p1).length} CONNECT(s)). That is the shape of the live bug --`);
        console.log('  our extension releasing and the fossil taking over underneath it.');
        const winners = ['system', 'direct'].filter(a => masked(R[a].p1) && R[a].p2 && masked(R[a].p2));
        const partial = ['system', 'direct'].filter(a => masked(R[a].p1) && !winners.includes(a));
        for (const a of ['direct', 'system'])
            console.log(`  mode:'${a}'${a === 'direct' ? ' ' : ''}  phase 1 ${masked(R[a].p1) ? 'MASKED it' : 'did NOT mask it'}` +
                        `${R[a].p2 ? `, and after a restart ${masked(R[a].p2) ? 'it was STILL direct' : 'it was proxied again'}` : ''}`);
        if (winners.length) {
            code2 = 0;
            console.log(`\n  So "off" must WRITE a value, not clear one. ${winners.map(w => "mode:'" + w + "'").join(' and ')} both`);
            console.log('  outrank the older extension\'s record and survive a restart, which also covers');
            console.log('  the 11.1 s worker-start window that no ordering inside background.js could.');
            console.log(`  Preferred: mode:'${winners.includes('system') ? 'system' : 'direct'}'` +
                        (winners.includes('system')
                            ? " -- it masks the fossil AND still honours a proxy the user set in Windows,\n" +
                              "  where 'direct' would quietly bypass one."
                            : " -- 'system' did not hold, so this is the one that does."));
        } else if (partial.length) {
            console.log(`\n  ${partial.join(' and ')} masked while the worker was alive but not across a restart, so`);
            console.log('  a written value is not enough on its own. The cold-start window stays broken.');
        } else {
            console.log('\n  NEITHER mode masked it. A written value does not outrank the older record, so');
            console.log('  no change inside Extension/background.js can release what is already stuck.');
        }
    }

    try { execFileSync('taskkill', ['/IM', 'brave.exe'], { stdio: 'ignore' }); } catch (e) {}
    socks.close(); target.close();
    try { fs.rmSync(TMP, { recursive: true, force: true }); console.log(`\n  removed ${TMP}`); }
    catch (e) { console.log(`\n  could not remove ${TMP}: ${e.code} -- it is a temp dir, safe to delete`); }
    console.log('Nothing outside that temp directory was written.');
    process.exit(code2);
}

socks.on('error', e => {
    console.log(`\nABORT: cannot bind 127.0.0.1:9050 -- ${e.code}. A CONNECT arriving there would ` +
                'not be ours to read.');
    process.exit(3);
});
socks.listen(9050, '127.0.0.1', () => {
    console.log('\n  stub SOCKS5 on 127.0.0.1:9050');
    target.listen(0, '0.0.0.0', main);
});
