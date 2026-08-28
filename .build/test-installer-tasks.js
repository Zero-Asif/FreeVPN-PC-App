'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/test-installer-tasks.js  --  lib/installer-tasks.js, unelevated
//
//  Two of its five sweeps reconfigure the machine (sweepNetwork resets DNS
//  and IPv6, sweepCerts deletes from trust stores), so those are checked at
//  source level and never called. What IS run for real:
//
//    * installerTask()   -- the flag parse. If this returns null for
//      --fp-setup the installer silently launches the GUI during an install;
//      if it returns a task for an argv that has neither flag, a normal
//      double-click reverts the user's settings and exits.
//    * sweepForcelists() -- against POLICY_KEYS redirected into HKCU, the
//      same sandbox test-geo-forcelist.js uses. The important direction is
//      what must SURVIVE: a workplace forcelist entry, and -- at setup time,
//      where the sweep runs with legacyOnly -- our own previous entry, which
//      install() is about to overwrite with the port it actually got.
//    * sweepTemp()       -- real files in the real TEMP directory.
//    * sweepHosts()      -- read-only unless this machine really has a
//      leftover block, so the assertion is that a hosts file WITHOUT our
//      markers comes back byte-identical.
//
//  Every registry assertion reads the key back with reg query.
// ════════════════════════════════════════════════════════════════════
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const tasks = require('../lib/installer-tasks');
const { POLICY_KEYS, FORCELIST } = require('../lib/geo-ext');
const { FW_RULE } = require('../lib/geo-spoof');

const TEST_ROOT = 'HKCU\\SOFTWARE\\FreeProxyTasksTest';
for (const k of Object.keys(POLICY_KEYS)) POLICY_KEYS[k] = TEST_ROOT + '\\' + k;
const KEY = POLICY_KEYS.edge + '\\' + FORCELIST;

let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
    if (cond) { pass++; console.log('  ok   ' + name); }
    else { fail++; console.log('  FAIL ' + name + (extra ? '  -- ' + extra : '')); }
};
const sh = c => { try { return execSync(c, { windowsHide: true, encoding: 'utf8', stdio: 'pipe' }); }
                  catch (e) { return null; } };

const warns = [];
const log = { debug: () => {}, info: () => {}, success: () => {},
              warn: (...a) => { warns.push(a.join(' ')); },
              error: (...a) => console.log('   ERROR:', ...a) };

//  Same (Default)-value exclusion as lib/geo-ext.js: `reg add <key> /f` sets
//  it, and counting that artifact as an entry is what makes "delete the subkey
//  only if we emptied it" never fire again.
function values(key) {
    const out = sh(`reg query "${key}"`);
    if (!out) return null;
    const v = {};
    for (const line of out.split(/\r?\n/)) {
        const m = line.match(/^\s{4}(\S+)\s+REG_SZ\s+(.*)$/);
        if (m && m[1] !== '(Default)') v[m[1]] = m[2].trim();
    }
    return v;
}

const OURS = 'abcdefghijklmnopabcdefghijklmnop;http://127.0.0.1:8081/updates.xml';
const OURS_OLD_PORT = 'abcdefghijklmnopabcdefghijklmnop;http://127.0.0.1:8085/updates.xml';
const FAKE = tasks.LEGACY_FAKE_ID + ';https://clients2.google.com/service/update2/crx';
const STORE_ID = 'ponmlkjihgfedcbaponmlkjihgfedcba';
const FROM_STORE = STORE_ID + ';https://clients2.google.com/service/update2/crx';
const FOREIGN = 'cjpalhdlnbpafiamejdnhcphjbkeiagm;https://clients2.google.com/service/update2/crx';

console.log('── installerTask(): the flag parse ──');
ok(tasks.installerTask(['electron.exe', '--fp-setup']) === 'setup', '--fp-setup -> setup');
ok(tasks.installerTask(['electron.exe', '--fp-teardown']) === 'teardown', '--fp-teardown -> teardown');
ok(tasks.installerTask(['app.exe', '--FP-SETUP']) === 'setup', 'case-insensitive');
ok(tasks.installerTask(['app.exe']) === null, 'a normal launch is not a task');
ok(tasks.installerTask([]) === null, 'empty argv is not a task');
ok(tasks.installerTask(undefined) === null, 'missing argv is not a task');
ok(tasks.installerTask(['app.exe', '--fp-setupx']) === null,
   'a flag that merely starts with ours is not a task');
ok(tasks.installerTask(['app.exe', '--squirrel-firstrun', '--fp-teardown']) === 'teardown',
   'found among other switches');
ok(tasks.installerTask(['app.exe', '--fp-setup', '--fp-teardown']) === 'setup',
   'the first flag wins, so two never run at once');

console.log('\n── sweepForcelists(): legacyOnly, the setup-time pass ──');
sh(`reg delete "${TEST_ROOT}" /f`);
sh(`reg add "${KEY}" /f`);
sh(`reg add "${KEY}" /v "1" /t REG_SZ /d "${FOREIGN}" /f`);
sh(`reg add "${KEY}" /v "2" /t REG_SZ /d "${OURS_OLD_PORT}" /f`);
sh(`reg add "${KEY}" /v "3" /t REG_SZ /d "${FAKE}" /f`);
{
    warns.length = 0;
    const n = tasks.sweepForcelists(log, { legacyOnly: true });
    const v = values(KEY);
    ok(n === 1, 'removed exactly one entry', String(n));
    ok(v && v['3'] === undefined, 'the fake id an older installer pushed is gone');
    ok(v && v['1'] === FOREIGN, "a workplace entry survives");
    ok(v && v['2'] === OURS_OLD_PORT,
       'our own previous entry survives -- install() replaces it with the live port');
    ok(warns.some(w => w.includes(tasks.LEGACY_FAKE_ID)),
       'the fake removal is reported as a warning, not silently');
}

console.log('\n── sweepForcelists(): the teardown pass ──');
{
    warns.length = 0;
    const n = tasks.sweepForcelists(log);
    const v = values(KEY);
    ok(n === 1, 'removed exactly one entry', String(n));
    ok(v && v['2'] === undefined, 'our loopback entry is gone whatever port it named');
    ok(v && v['1'] === FOREIGN, 'the workplace entry still survives', JSON.stringify(v));
    ok(!warns.length, 'nothing to warn about when the fake was already gone',
       JSON.stringify(warns));
}

console.log('\n── sweepForcelists(): alsoId, for a Web Store build ──');
{
    sh(`reg add "${KEY}" /v "2" /t REG_SZ /d "${FROM_STORE}" /f`);
    const before = tasks.sweepForcelists(log);
    ok(before === 0 && (values(KEY) || {})['2'] === FROM_STORE,
       'a store-hosted id is NOT ours by default -- the update URL is Google\'s');
    const n = tasks.sweepForcelists(log, { alsoId: STORE_ID });
    ok(n === 1 && (values(KEY) || {})['2'] === undefined,
       'it is ours once FP_GEO_WEBSTORE_ID names it', String(n));
    ok((values(KEY) || {})['1'] === FOREIGN, 'and the workplace entry is still there');
}

console.log('\n── sweepForcelists(): the subkey itself ──');
{
    //  Two halves of one rule. The key may only disappear when this sweep is
    //  what emptied it, and the (Default) value `reg add <key> /f` leaves
    //  behind must not count as an occupant -- that bug makes the key
    //  immortal.
    ok(values(KEY) !== null, 'a key with a surviving entry is kept');
    sh(`reg delete "${KEY}" /v "1" /f`);
    sh(`reg add "${KEY}" /v "1" /t REG_SZ /d "${OURS}" /f`);
    const n = tasks.sweepForcelists(log);
    ok(n === 1, 'the last entry is removed', String(n));
    ok(values(KEY) === null, 'and the emptied key is deleted despite (Default)');
    ok(values(POLICY_KEYS.edge) !== null, 'the browser policy key above it is left alone');
}

console.log('\n── sweepForcelists(): nothing there ──');
{
    sh(`reg delete "${TEST_ROOT}" /f`);
    const n = tasks.sweepForcelists(log);
    ok(n === 0, 'absent keys are not an error', String(n));
}

console.log('\n── sweepTemp(): real files in the real TEMP ──');
{
    const names = ['vpn_elevate.ps1', 'vc_redist.x64.exe', 'fp_uninstall_net.bat'];
    const made = names.map(n => path.join(os.tmpdir(), n));
    for (const f of made) fs.writeFileSync(f, 'test\n', 'utf8');
    ok(made.every(f => fs.existsSync(f)), 'three leftovers staged');
    tasks.sweepTemp(log);
    ok(made.every(f => !fs.existsSync(f)), 'sweepTemp() removed all three',
       JSON.stringify(made.filter(f => fs.existsSync(f))));
    tasks.sweepTemp(log);
    ok(true, 'and running it again on nothing does not throw');
}

console.log('\n── sweepHosts(): must not touch a file it did not write ──');
{
    const HOSTS = path.join(process.env.SystemRoot || 'C:\\Windows',
                            'System32', 'drivers', 'etc', 'hosts');
    const hash = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
    if (!fs.existsSync(HOSTS)) {
        console.log('   skip: no hosts file on this machine');
    } else if (fs.readFileSync(HOSTS, 'utf8').includes('FreeProxy VPN -- location spoof block')) {
        //  Not a failure: it means a session really did leave a block behind,
        //  and removing it is this function's job -- but then the file is
        //  supposed to change, so there is nothing to compare.
        console.log('   skip: this machine has a real leftover block to remove');
    } else {
        const before = hash(HOSTS);
        tasks.sweepHosts(log);
        ok(hash(HOSTS) === before, 'a hosts file without our markers is byte-identical after');
    }
}

console.log('\n── the two sweeps that reconfigure the machine: source level ──');
{
    //  Called for real these reset every adapter's DNS and delete from trust
    //  stores, so what is checked is that the commands are still THERE and
    //  still named the same as what created them. A rule name that drifts by
    //  one character is a rule that stays in the firewall forever.
    const srcText = fs.readFileSync(path.join(__dirname, '..', 'lib', 'installer-tasks.js'), 'utf8');
    ok(tasks.FW_RULES.includes(FW_RULE),
       'FW_RULES carries the lfsvc shield rule name from lib/geo-spoof.js');
    ok(tasks.FW_RULES.length === 5, 'all five rules the app can create are listed',
       JSON.stringify(tasks.FW_RULES));
    for (const r of tasks.FW_RULES) {
        ok(srcText.includes(`delete rule name="${r}"`) ||
           srcText.includes('FW_RULES.map') || srcText.includes('of FW_RULES'),
           `sweepNetwork removes ${r}`);
    }
    ok(/^HKCU\\/.test(tasks.PROXY_KEY), 'the proxy key is per-user, as the app writes it',
       tasks.PROXY_KEY);
    ok(srcText.includes('net start dnscache'),
       'the resolver cache service is started again -- the kill switch stops it');
    ok(srcText.includes('DisabledComponents') && srcText.includes('ms_tcpip6'),
       'IPv6 is re-enabled, both the registry switch and the adapter binding');
    ok(srcText.includes('sc config lfsvc start= demand'),
       'the geolocation service goes back to its shipped start type');
    ok(srcText.includes('certutil') && srcText.includes('FreeProxy GeoSpoof'),
       'sweepCerts matches this app\'s own certificate name');
}

(async () => {
    console.log('\n── runInstallerTask(): an installer must never hang or throw ──');
    //  setup, not teardown: taskSetup's first act is the ctx call that throws
    //  here, so nothing on this machine is touched. taskTeardown would kill
    //  tor.exe before it got that far.
    const errs = [];
    const ctx = {
        Logger: { ...log, error: (...a) => errs.push(a[0]) },
        isRunAsAdmin: () => true,
        geoEngine: () => { throw new Error('boom'); },
        geoExt: () => { throw new Error('boom'); },
        restoreBrowserPolicy: async () => {},
    };
    const code = await tasks.runInstallerTask('setup', ctx);
    ok(code === tasks.EXIT.crashed, 'a throw becomes exit code 1, not an unhandled rejection',
       String(code));
    ok(errs.some(e => String(e).includes('crashed')), 'and it is logged as a crash',
       JSON.stringify(errs));

    warns.length = 0;
    const unelevated = [];
    await tasks.runInstallerTask('setup', {
        ...ctx,
        Logger: { ...log, warn: (...a) => unelevated.push(a[0]), error: () => {} },
        isRunAsAdmin: () => false,
    });
    ok(unelevated.some(w => /administrator/i.test(String(w))),
       'running unelevated warns instead of failing silently', JSON.stringify(unelevated));

    ok(tasks.EXIT.ok === 0 && tasks.EXIT.crashed === 1 && tasks.EXIT.stageFailed === 3 &&
       tasks.EXIT.timedOut === 4 && tasks.EXIT.manual === 10,
       'the exit-code contract installer.nsh branches on is unchanged',
       JSON.stringify(tasks.EXIT));

    sh(`reg delete "${TEST_ROOT}" /f`);
    ok(sh(`reg query "${TEST_ROOT}"`) === null, 'test hive removed');

    console.log(`\n${pass}/${pass + fail} checks passed`);
    process.exit(fail ? 1 : 0);
})().catch(e => {
    console.log('ABORT: ' + e.stack);
    sh(`reg delete "${TEST_ROOT}" /f`);
    process.exit(3);
});
