'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/test-geo-winshield.js
//
//  The Windows layer of lib/geo-spoof.js, exercised for real.
//
//  This layer replaced one that DENIED -- it wrote SensorPermissionState=0,
//  set the app-consent store to Deny and stopped lfsvc, which switched the
//  user's own Location setting off underneath them. What it does now is add
//  ONE named, service-scoped outbound firewall rule so lfsvc cannot reach
//  Microsoft's location service, and nothing else. The three things that can
//  go wrong are all checked here:
//
//    1. it must not touch SensorPermissionState, the consent store, or
//       lfsvc's running state -- those are the user's, and the whole point of
//       the change is to stop taking them
//    2. the rule must come back off, exactly, by name
//    3. unelevated it must degrade quietly and truthfully -- return nothing,
//       warn, and let status() report NOT shielded -- rather than throw or
//       claim a shield that is not there
//
//  Elevated it runs the full add/verify/remove cycle. Unelevated it runs the
//  degradation path and says which half it ran. Either way the machine is
//  left as it was found: the rule is removed by name on every exit path and
//  the three user-owned settings are read before and after and compared.
// ════════════════════════════════════════════════════════════════════
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync, execFileSync } = require('child_process');

const { GeoSpoof, SENSOR_KEY, CONSENT_KEY, FW_RULE } = require('../lib/geo-spoof');

let pass = 0, fail = 0;
const ok = (cond, msg, extra) => {
    if (cond) { pass++; console.log('  ok   ' + msg); }
    else { fail++; console.log('  FAIL ' + msg + (extra ? '\n         ' + extra : '')); }
};

const lines = [];
const log = {
    debug: (m) => lines.push(['debug', m]),
    info:  (m) => lines.push(['info', m]),
    warn:  (m) => lines.push(['warn', m]),
    error: (m) => lines.push(['error', m]),
    success: (m) => lines.push(['success', m]),
};
const said = (rx) => lines.some(([, m]) => rx.test(String(m)));

const ps = (script) => {
    try {
        return execSync('powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ' +
            JSON.stringify(script), { encoding: 'utf8', windowsHide: true, timeout: 40000 });
    } catch (e) { return (e.stdout || '') + (e.stderr || ''); }
};
const rule = () => /True/i.test(ps(
    `Write-Output ([bool](Get-NetFirewallRule -DisplayName '${FW_RULE}' -ErrorAction SilentlyContinue))`));
const reg = (key, val) => {
    try {
        const out = execSync(`reg query "${key}" /v "${val}"`, { encoding: 'utf8', windowsHide: true, stdio: 'pipe' });
        const l = out.split(/\r?\n/).find(x => new RegExp('\\s' + val + '\\s+REG_', 'i').test(x));
        return l ? l.trim().replace(/^\S+\s+REG_\w+\s+/, '') : null;
    } catch (e) { return null; }
};
const lfsvc = () => { try { return /RUNNING/.test(execSync('sc query lfsvc',
    { encoding: 'utf8', windowsHide: true, stdio: 'pipe' })); } catch (e) { return false; } };

const elevated = /True/i.test(ps('Write-Output ([Security.Principal.WindowsPrincipal]::new(' +
    '[Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(' +
    '[Security.Principal.WindowsBuiltInRole]::Administrator))'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fpshield-'));
const geo = new GeoSpoof({ log, stateDir: tmp });

//  Belt and braces: whatever happens below, the rule does not survive this
//  process. Registered before anything is added.
let cleaned = false;
const cleanup = () => {
    if (cleaned) return; cleaned = true;
    ps(`Remove-NetFirewallRule -DisplayName '${FW_RULE}' -ErrorAction SilentlyContinue`);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
};
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

console.log(`── environment: ${elevated ? 'ELEVATED (full cycle)' : 'unelevated (degradation path)'} ──`);

const owned = {
    sensor:  reg(SENSOR_KEY, 'SensorPermissionState'),
    consent: reg(CONSENT_KEY, 'Value'),
    lfsvc:   lfsvc(),
};
console.log('   user-owned settings before: ' + JSON.stringify(owned));
ok(!rule(), 'no leftover rule before the test', 'one was already present');

console.log('');
console.log('── snapshot records the truth, including that nothing was denied ──');
const snap = geo._snapshotWindows();
console.log('   ' + JSON.stringify(snap));
ok(snap.sensor === owned.sensor, 'snapshot read SensorPermissionState as-is');
ok(snap.consent === owned.consent, 'snapshot read the consent store as-is');
ok(snap.lfsvcWasRunning === owned.lfsvc, 'snapshot read lfsvc running state as-is');
ok(snap.fwRuleWasPresent === false, 'snapshot records that our rule was not already there');

console.log('');
console.log('── shield ──');
const applied = geo._shieldWindowsNow();
console.log('   returned ' + JSON.stringify(applied));

if (elevated) {
    ok(rule(), 'the firewall rule exists after shielding');
    ok(applied.includes('lfsvc network blocked'), 'the return value says what happened');
    ok(said(/lfsvc can no longer reach/), 'the log explains the mechanism');
    ok(said(/native apps are not given the connected/),
       'the log does NOT claim native apps get the connected country');

    console.log('');
    console.log('── shielding is idempotent ──');
    const again = geo._shieldWindowsNow();
    ok(again.includes('already present'), 'a second call notices the rule and does not duplicate it');
    const count = ps(`Write-Output (@(Get-NetFirewallRule -DisplayName '${FW_RULE}' ` +
                     `-ErrorAction SilentlyContinue).Count)`).trim();
    ok(count === '1', 'exactly one rule exists, not two', 'count=' + count);
} else {
    ok(applied.length === 0, 'unelevated it claims nothing');
    ok(said(/needs admin/), 'the log says why, and says browser geolocation is unaffected');
    ok(said(/browser geolocation is unaffected/), 'the warning is specific about what still works');
}

console.log('');
console.log('── the user\'s own settings were NOT touched ──');
ok(reg(SENSOR_KEY, 'SensorPermissionState') === owned.sensor,
   'SensorPermissionState unchanged (the old build set this to 0)',
   `${owned.sensor} -> ${reg(SENSOR_KEY, 'SensorPermissionState')}`);
ok(reg(CONSENT_KEY, 'Value') === owned.consent,
   'app consent store unchanged (the old build set this to Deny)',
   `${owned.consent} -> ${reg(CONSENT_KEY, 'Value')}`);
ok(lfsvc() === owned.lfsvc, 'lfsvc running state unchanged (the old build stopped it)');

console.log('');
console.log('── status() reports the shield, and only when it is real ──');
//  status() needs a journal, which applyAll writes; write the shape it reads.
fs.writeFileSync(path.join(tmp, 'geo-restore.json'), JSON.stringify(
    { createdAt: new Date().toISOString(), policy: [], profiles: [], windows: snap, firefox: [] }), 'utf8');
const st = geo.status();
console.log('   ' + JSON.stringify(st));
ok(st.active === true, 'status() sees the journal');
ok(st.windowsShielded === elevated,
   `windowsShielded is ${elevated} -- it reads the live rule, it does not assume`,
   JSON.stringify(st));
ok(!('windowsDenied' in st), 'the old windowsDenied field is gone, so nothing can read a stale name');

console.log('');
console.log('── restore takes the rule back off, by name ──');
geo.restoreWindows(snap);
ok(!rule(), 'the firewall rule is gone');
ok(reg(SENSOR_KEY, 'SensorPermissionState') === owned.sensor, 'restore left SensorPermissionState alone');
ok(reg(CONSENT_KEY, 'Value') === owned.consent, 'restore left the consent store alone');
ok(lfsvc() === owned.lfsvc, 'restore left lfsvc alone');
ok(geo.status().windowsShielded === false, 'status() no longer reports a shield');

console.log('');
console.log('── restore is safe to run twice, and with no record ──');
geo.restoreWindows(snap);
geo.restoreWindows(null);
ok(!rule(), 'still no rule after a double restore');

console.log('');
console.log('── a journal from the build that DENIED is still undone ──');
//  The old build recorded sensor/consent and left the machine on Deny. Those
//  machines exist; restoreWindows() has to put them back even though nothing
//  writes them any more. Verified against a fabricated old-style record whose
//  values are the CURRENT ones, so a correct restore is a no-op we can check.
const oldStyle = { sensor: owned.sensor, consent: owned.consent,
                   lfsvcWasRunning: owned.lfsvc };   // note: no fwRuleWasPresent
geo.restoreWindows(oldStyle);
ok(reg(SENSOR_KEY, 'SensorPermissionState') === owned.sensor,
   'an old-style record restores SensorPermissionState to its recorded value');
ok(reg(CONSENT_KEY, 'Value') === owned.consent,
   'an old-style record restores the consent store to its recorded value');
ok(!rule(), 'an old-style record with no rule field does not leave a rule behind');

cleanup();
console.log('');
console.log(`${pass}/${pass + fail} checks passed` + (fail ? `  (${fail} FAILED)` : ''));
process.exit(fail ? 1 : 0);
