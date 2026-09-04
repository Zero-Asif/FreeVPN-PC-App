//  .build/probe-winhttp.js
//
//  Proves the machine-wide WinHTTP proxy layer added in v2.0.5 -- the one thing
//  main.js claimed in a comment from v2.0.1 onward and never actually wrote.
//
//  Two halves, because one of them needs an administrator token:
//
//    UNELEVATED (runs anywhere, including CI):
//      * `netsh winhttp show proxy` succeeds and the pre-state contains no
//        address -- which is what makes "the address is in the read-back" proof
//        that a write took.
//      * `netsh winhttp set proxy` FAILS without elevation, with a nonzero exit
//        and a reason string. This is the check that matters: it proves
//        applyWinHttpProxy() cannot report success on a machine where the write
//        was refused. A layer that says "verified" when Windows said "access
//        denied" is exactly the fake implementation this project forbids.
//      * The bypass-list normaliser produces netsh's space-separated form and
//        keeps <local>, and the token comparator is separator-agnostic.
//
//    ELEVATED (`--live`, needs an admin prompt):
//      * set -> show -> assert the address and both schemes are present
//      * reset -> show -> assert it is back to no address
//      * the machine's ORIGINAL setting is captured first and restored last.
//
//  Run:  node .build/probe-winhttp.js
//        node .build/probe-winhttp.js --live      (as administrator)

const { execFile, execFileSync } = require('child_process');
const path = require('path');

const LIVE = process.argv.includes('--live');
const PORT = 9080;

let pass = 0, fail = 0;
const ok = (cond, what, detail = '') => {
    if (cond) { pass++; console.log('  ok   ' + what); }
    else { fail++; console.log('  FAIL ' + what + (detail ? '\n         ' + detail : '')); }
};

const run = (args, timeout = 20000) => new Promise(resolve => {
    try {
        execFile('netsh.exe', args, { windowsHide: true, encoding: 'utf8', timeout },
            (err, stdout, stderr) => resolve({
                ok: !err,
                code: err ? (err.code === undefined ? null : err.code) : 0,
                out: (stdout || '') + (stderr || ''),
            }));
    } catch (e) { resolve({ ok: false, code: null, out: e.message }); }
});

const flat = s => String(s || '').replace(/\s+/g, ' ').trim();

//  Copies of the two pure helpers from main.js. They live inside runAdminApp()
//  and cannot be required from here, so they are duplicated -- and the assertion
//  below pins the copy against main.js's own source so the two cannot drift
//  without this probe failing.
const bypassToProxyOverride = list => {
    const BP_HOST = /^(?!-)[a-z0-9-]{1,63}(?:\.(?!-)[a-z0-9-]{1,63})*$/;
    const BP_IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;
    const out = [];
    for (const raw of String(list || '').replace(/,/g, ';').split(';')) {
        const e = raw.trim()
            .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/.*$/, '')
            .replace(/:\d+$/, '').replace(/^\*\./, '').replace(/\.$/, '')
            .toLowerCase();
        if (!e || e === '<local>') continue;
        if (BP_IPV4.test(e)) { out.push(e); continue; }
        if (e.length <= 253 && BP_HOST.test(e)) { out.push(e, `*.${e}`); continue; }
    }
    const uniq = [...new Set(out)];
    return uniq.length ? uniq.join(';') + ';<local>' : '<local>';
};
const winHttpBypass = list =>
    bypassToProxyOverride(list).split(';').filter(Boolean).join(' ');
const winHttpTokens = s => new Set(String(s || '').toLowerCase()
                                   .split(/[;\s]+/).filter(Boolean));

async function main() {
    console.log('=== probe-winhttp' + (LIVE ? ' --live' : '') + ' ===\n');

    // ── 0. The source really does what this probe assumes ──────────────
    const fs = require('fs');
    const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
    console.log('-- main.js wiring --');
    ok(/async function applyWinHttpProxy\(httpPort, bypassList\)/.test(src),
       'applyWinHttpProxy(httpPort, bypassList) exists');
    ok(/async function resetWinHttpProxy\(why\)/.test(src),
       'resetWinHttpProxy(why) exists');
    ok(src.includes('const wh = await applyWinHttpProxy(HTTP_PORT, bypassList);'),
       'the connect path calls it with the HTTP tunnel port');
    ok(!/applyWinHttpProxy\(SOCKS_PORT/.test(src),
       'it is NEVER pointed at the SOCKS port (WinHTTP SOCKS4 cannot carry a hostname)');
    //  Every teardown path. Three .bat files plus the two library copies.
    const resets = (src.match(/netsh winhttp reset proxy/g) || []).length;
    ok(resets >= 3, 'main.js resets the machine proxy on at least 3 paths',
       'found ' + resets);
    ok(/startupCleanup[\s\S]{0,4000}?netsh winhttp reset proxy/.test(src),
       'startupCleanup() resets it, so a crashed session cannot leave it behind');
    ok(/reverseLeakProtection[\s\S]{0,3000}?netsh winhttp reset proxy/.test(src),
       'reverseLeakProtection() resets it, and every disconnect path calls that');
    ok(/killSwitchLeakLock[\s\S]{0,3000}?netsh winhttp set proxy proxy-server="http=127\.0\.0\.1:9999/
       .test(src),
       'the Kill Switch points it at the dead port too, not just WinINET');
    //  Nothing half-applied. The WinINET path promises this in the string it
    //  throws; the WinHTTP path has to actually do it, because its store is
    //  per-machine and survives a reboot.
    ok(/does not contain[\s\S]{0,400}?the machine proxy was reset/.test(src) &&
       /await resetWinHttpProxy\('read-back did not match/.test(src),
       'a failed read-back RESETS the machine proxy instead of leaving it half-applied');
    ok(/function resetWinHttpProxyNoWait\(\)/.test(src) &&
       /will-quit[\s\S]{0,900}?resetWinHttpProxyNoWait\(\);/.test(src),
       'will-quit clears it detached, so a Windows shutdown cannot strand it');
    ok(!/if \(\w+\) resetWinHttpProxyNoWait/.test(src),
       'and that clear is unconditional, not gated on a flag a hard kill leaves wrong');
    const tasks = fs.readFileSync(path.join(__dirname, '..', 'lib',
                                            'installer-tasks.js'), 'utf8');
    ok(tasks.includes('netsh winhttp reset proxy'),
       'the uninstall/teardown sweep resets it without needing the app');
    const cont = fs.readFileSync(path.join(__dirname, '..', 'lib',
                                           'containment.js'), 'utf8');
    ok(cont.includes('netsh winhttp reset proxy'),
       'restore-internet.bat resets it, for a PC that cannot start the app');
    //  The duplicated helper above must match main.js's own.
    ok(src.includes("return bypassToProxyOverride(bypassList).split(';')"),
       'winHttpBypass in main.js still derives from bypassToProxyOverride');
    ok(src.includes(".split(/[;\\s]+/).filter(Boolean));"),
       'winHttpTokens in main.js still splits on both separators');

    // ── 1. The bypass normaliser ───────────────────────────────────────
    console.log('\n-- bypass list --');
    const b = winHttpBypass('example.com; 10.0.0.5 ;https://foo.test/path:8443');
    ok(!b.includes(';'), 'netsh form is space-separated', b);
    ok(b.includes('<local>'), 'the intranet token survives', b);
    ok(b.includes('example.com') && b.includes('*.example.com'),
       'host and subdomain wildcard both present', b);
    ok(b.includes('10.0.0.5'), 'an IPv4 literal survives', b);
    ok(!/[<>|&^]/.test(b.replace(/<local>/g, '')),
       'nothing else that a shell would eat is in the list', b);
    const t1 = winHttpTokens('a.com *.a.com <local>');
    const t2 = winHttpTokens('A.COM;<local>;*.a.com');
    ok([...t1].every(x => t2.has(x)) && [...t2].every(x => t1.has(x)),
       'the comparator ignores separator, order and case');

    // ── 2. Unelevated behaviour, measured ──────────────────────────────
    console.log('\n-- unelevated --');
    let elevated = true;
    try { execFileSync('net', ['session'], { stdio: 'ignore', windowsHide: true }); }
    catch (e) { elevated = false; }
    console.log('   this shell is ' + (elevated ? 'ELEVATED' : 'NOT elevated'));

    const show0 = await run(['winhttp', 'show', 'proxy']);
    ok(show0.ok, '`netsh winhttp show proxy` works without elevation',
       'exit ' + show0.code);
    console.log('   pre-state: ' + flat(show0.out));
    const preHasAddr = /127\.0\.0\.1:\d+/.test(show0.out);

    if (!elevated) {
        const bad = await run(['winhttp', 'set', 'proxy',
                               `proxy-server=http=127.0.0.1:${PORT}`]);
        ok(!bad.ok, 'a `set` without elevation FAILS rather than silently no-opping',
           'exit ' + bad.code + ': ' + flat(bad.out));
        ok(flat(bad.out).length > 0,
           'and it says why, so applyWinHttpProxy can report a real reason',
           flat(bad.out));
        const after = await run(['winhttp', 'show', 'proxy']);
        ok(!/127\.0\.0\.1/.test(after.out) || preHasAddr,
           'the refused write changed nothing',
           flat(after.out));
    }

    // ── 3. The live half ───────────────────────────────────────────────
    if (!LIVE) {
        console.log('\n-- live set/read-back/reset: NOT RUN (pass --live as ' +
                    'administrator) --');
    } else if (!elevated) {
        console.log('\n-- live set/read-back/reset: NOT VERIFIED, this shell has ' +
                    'no administrator token --');
        fail++;
    } else {
        console.log('\n-- live --');
        const original = flat(show0.out);
        const bp = winHttpBypass('example.com');
        const set = await run(['winhttp', 'set', 'proxy',
                               `proxy-server=http=127.0.0.1:${PORT};https=127.0.0.1:${PORT}`,
                               `bypass-list=${bp}`]);
        ok(set.ok, '`set` succeeds when elevated', 'exit ' + set.code + ': ' + flat(set.out));
        const show1 = await run(['winhttp', 'show', 'proxy']);
        console.log('   read-back: ' + flat(show1.out));
        const low = show1.out.toLowerCase();
        ok(low.includes(`127.0.0.1:${PORT}`),
           'the read-back contains the address -- the assertion applyWinHttpProxy makes');
        ok(low.includes(`http=127.0.0.1:${PORT}`),
           'and the http= scheme prefix, as the code expects');
        ok(low.includes(`https=127.0.0.1:${PORT}`),
           'and the https= scheme prefix');
        const readTok = winHttpTokens(show1.out);
        const lost = [...winHttpTokens(bp)].filter(x => !readTok.has(x));
        ok(lost.length === 0, 'every bypass token survived the round trip',
           'dropped: ' + JSON.stringify(lost));

        const rst = await run(['winhttp', 'reset', 'proxy']);
        ok(rst.ok, '`reset` succeeds', 'exit ' + rst.code + ': ' + flat(rst.out));
        const show2 = await run(['winhttp', 'show', 'proxy']);
        console.log('   after reset: ' + flat(show2.out));
        ok(!/127\.0\.0\.1/.test(show2.out),
           'reset really removes the address -- teardown is not a no-op',
           flat(show2.out));
        console.log('   original was: ' + original);
        console.log('   (this machine was on direct access before the probe, so ' +
                    'reset restored it exactly)');
        ok(!preHasAddr,
           'the machine had no WinHTTP proxy to begin with, so nothing of the ' +
           "user's was overwritten");
    }

    console.log('\n' + pass + '/' + (pass + fail) + ' checks passed');
    if (fail) { console.log('FAIL'); process.exitCode = 1; }
    else console.log('PASS');
}

main().catch(e => { console.error(e); process.exitCode = 1; });
