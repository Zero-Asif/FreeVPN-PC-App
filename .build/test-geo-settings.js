'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/test-geo-settings.js  --  the SECOND force-install route
//  (ExtensionSettings) against a real registry key, unelevated.
//
//  POLICY_KEYS is redirected at HKCU\SOFTWARE\FreeProxyGeoSetTest, the same
//  trick test-geo-forcelist.js uses, so this exercises the shipping code path
//  without going near a policy hive. No browser is launched and nothing is
//  closed.
//
//  ExtensionSettings is a DICTIONARY in one REG_SZ value, which makes it far
//  more dangerous than the numbered forcelist: "add our entry" means rewriting
//  somebody else's whole policy. The four things that would do real damage if
//  they were wrong are what this file is for.
//
//    1. A workplace ExtensionSettings is NEVER rewritten. If the value already
//       carries a policy for another extension, the browser is skipped.
//    2. restore() removes OUR id out of the current value and leaves the rest
//       -- including an entry an administrator added after we installed. It
//       must not put the journalled blob back verbatim, which would silently
//       undo their work.
//    3. The value survives the trip byte-for-byte, at any length. A JSON
//       payload longer than a command line has to go through the .reg import
//       fallback instead of `reg add /d`, and a truncated policy is a broken
//       policy.
//    4. The ENTRY SHAPE follows what the browser will honour. force_installed
//       is written only where a force-install works; everywhere else the entry
//       is `installation_mode: allowed`. Both halves of that matter: an
//       unhonoured force_installed installs nothing (an unmanaged Edge answers
//       an off-store forcelist with [BLOCKED] -- measured on this machine), and
//       an honoured one shows "Installed by your administrator" with a DEAD
//       toggle, which takes the extension's on/off switch away from the user.
//       This app is required to leave that switch with them, so the shape is
//       pinned here under both answers -- `_setManaged` drives them on one
//       machine, since a real one only ever gives you one.
// ════════════════════════════════════════════════════════════════════
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const { GeoExt, POLICY_KEYS, EXT_SETTINGS, regValue,
        FORCE_WORKS, _setManaged } = require('../lib/geo-ext');
const browsers = require('../lib/browsers');

const TEST_ROOT = 'HKCU\\SOFTWARE\\FreeProxyGeoSetTest';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fpes-'));
for (const k of Object.keys(POLICY_KEYS)) POLICY_KEYS[k] = TEST_ROOT + '\\' + k;

const sh = c => { try { return execSync(c, { windowsHide: true, encoding: 'utf8', stdio: 'pipe' }); }
                  catch (e) { return null; } };

let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
    if (cond) { pass++; console.log('  ok   ' + name); }
    else { fail++; console.log('  FAIL ' + name + (extra ? '  -- ' + extra : '')); }
};
const log = { debug: () => {}, info: () => {}, success: () => {},
              warn: (...a) => console.log('   warn:', ...a),
              error: (...a) => console.log('   ERROR:', ...a) };

const FOREIGN = { installation_mode: 'force_installed',
                  update_url: 'https://clients2.google.com/service/update2/crx' };
const FOREIGN_ID = 'cccccccccccccccccccccccccccccccc';

(async () => {
    sh(`reg delete "${TEST_ROOT}" /f`);

    const ext = new GeoExt({ log, stateDir: TMP,
                             sourceDir: path.join(__dirname, '..', 'Extension') });
    const prepared = await ext.prepare();
    if (!prepared) { console.log('ABORT: prepare() failed'); process.exit(3); }

    //  Whatever is really on this machine -- the route is attempted in every
    //  policy-capable browser that is present, Chrome and Brave included.
    const here = browsers.detectChromium().map(b => b.id).filter(id => POLICY_KEYS[id]);
    console.log(`id ${prepared.id}\nbrowsers here: ${here.join(', ') || 'none'}\n`);
    if (!here.length) { console.log('ABORT: no Chromium browser detected'); process.exit(3); }
    const KEY = POLICY_KEYS[here[0]];
    const readJson = k => { const r = regValue(k, EXT_SETTINGS);
                            try { return r == null ? null : JSON.parse(r); } catch (e) { return 'unparseable'; } };

    console.log('── an unmanaged machine: permitted, NOT force-installed ──');
    //  What every ordinary user gets. A force_installed entry here would be a
    //  claim the browser refuses to honour, and the one shape that would take
    //  the on/off switch away from them if it ever were honoured.
    _setManaged(false);
    const done0 = ext.installSettings();
    ok(done0.length === here.length, 'every detected browser accepted the write',
       `${done0.join(',')} vs ${here.join(',')}`);
    for (const id of here) {
        const j = readJson(POLICY_KEYS[id]);
        const e = j && j[prepared.id];
        ok(!!e, `${id}: our id is in the dictionary`, JSON.stringify(j));
        ok(e && e.installation_mode === 'allowed',
           `${id}: installation_mode is allowed`, JSON.stringify(e));
        ok(e && !('update_url' in e) && !('toolbar_pin' in e),
           `${id}: and nothing else -- no update_url a policy would never fetch, ` +
           'no forced pin', JSON.stringify(e));
        ok(Object.keys(j).length === 1, `${id}: nothing else was invented`, JSON.stringify(j));
    }

    console.log('── a managed machine: force-installed only where it is honoured ──');
    //  Management is necessary but not sufficient. FORCE_WORKS is the measured
    //  list -- Chrome and Brave are marked forcelist:'refused' in lib/browsers.js
    //  and stay on `allowed` even here, which is why this loop asks each browser
    //  rather than assuming the managed answer applies to all of them.
    _setManaged(true);
    const done = ext.installSettings();
    ok(done.length === here.length, 'every detected browser accepted the write',
       `${done.join(',')} vs ${here.join(',')}`);
    for (const id of here) {
        const j = readJson(POLICY_KEYS[id]);
        const e = j && j[prepared.id];
        ok(!!e, `${id}: our id is in the dictionary`, JSON.stringify(j));
        if (FORCE_WORKS.includes(id)) {
            ok(e && e.installation_mode === 'force_installed', `${id}: force_installed`);
            ok(e && /^http:\/\/127\.0\.0\.1:\d+\//.test(e.update_url || ''),
               `${id}: update_url points at this machine's own loopback host`, e && e.update_url);
            ok(e && e.toolbar_pin === 'force_pinned', `${id}: icon is pinned to the toolbar`);
        } else {
            ok(e && e.installation_mode === 'allowed',
               `${id}: still only allowed -- its forcelist is measured 'refused', ` +
               'and management does not change that', JSON.stringify(e));
            ok(e && !('update_url' in e), `${id}: no update_url it would never fetch`);
            ok(e && !('toolbar_pin' in e), `${id}: no forced pin`);
        }
        ok(Object.keys(j).length === 1, `${id}: nothing else was invented`, JSON.stringify(j));
    }
    ok(FORCE_WORKS.length > 0 && here.some(id => FORCE_WORKS.includes(id)),
       'at least one browser here is on the honoured list, so the force_installed ' +
       'shape was really exercised and not just skipped', FORCE_WORKS.join(','));

    console.log('── run it again: idempotent, one journal row per browser ──');
    ext.installSettings();
    const j1 = JSON.parse(fs.readFileSync(ext.stateFile, 'utf8'));
    ok(j1.settings.length === here.length, 'journal has exactly one row per browser',
       JSON.stringify(j1.settings.map(s => s.browser)));
    ok(j1.settings.every(s => s.prev === null), 'each row records "there was nothing here"');
    ok(Object.keys(readJson(KEY)).length === 1, 'still exactly our one entry');

    console.log('── restore: our id goes, the value goes with it ──');
    ext.restore();
    ok(regValue(KEY, EXT_SETTINGS) === null, 'the value is deleted once it is empty',
       regValue(KEY, EXT_SETTINGS));
    ok(JSON.parse(fs.readFileSync(ext.stateFile, 'utf8')).settings.length === 0,
       'journal cleared');

    console.log("── an entry added by an admin AFTER us survives restore ──");
    ext.installSettings();
    let cur = readJson(KEY);
    cur[FOREIGN_ID] = FOREIGN;
    ok(sh(`reg add "${KEY}" /v ${EXT_SETTINGS} /t REG_SZ /d "${JSON.stringify(cur).replace(/"/g, '\\"')}" /f`) !== null,
       'admin adds a second extension to the same policy');
    ext.restore();
    cur = readJson(KEY);
    ok(cur && cur[FOREIGN_ID] && cur[FOREIGN_ID].update_url === FOREIGN.update_url,
       "the admin's entry is still there, unchanged", JSON.stringify(cur));
    ok(cur && !cur[prepared.id], 'ours is gone from it', JSON.stringify(cur));

    console.log('── a policy that is already somebody else\'s is NOT touched ──');
    sh(`reg delete "${KEY}" /v ${EXT_SETTINGS} /f`);
    const theirs = JSON.stringify({ '*': { installation_mode: 'blocked' }, [FOREIGN_ID]: FOREIGN });
    sh(`reg add "${KEY}" /v ${EXT_SETTINGS} /t REG_SZ /d "${theirs.replace(/"/g, '\\"')}" /f`);
    const done2 = ext.installSettings();
    ok(!done2.includes(here[0]), `${here[0]} was skipped`, JSON.stringify(done2));
    ok(regValue(KEY, EXT_SETTINGS) === theirs, 'their policy is byte-identical afterwards',
       regValue(KEY, EXT_SETTINGS));
    ext.restore();
    ok(regValue(KEY, EXT_SETTINGS) === theirs, 'and survives a restore that never owned it');

    console.log('── a value too long for a command line still lands intact ──');
    //  The only way a huge dictionary reaches our writer is the restore path:
    //  an administrator's policy that our id was merged into, reduced back to
    //  theirs. 200 entries is comfortably past the 8191-character command line,
    //  so `reg add /d` cannot carry it and the .reg import fallback must.
    sh(`reg delete "${KEY}" /v ${EXT_SETTINGS} /f`);
    const big = {};
    for (let i = 0; i < 200; i++) {
        big['x'.repeat(28) + String.fromCharCode(97 + (i % 16)) + (100 + i)] =
            { installation_mode: 'allowed', update_url: 'https://example.invalid/update?n=' + i };
    }
    const reduced = JSON.stringify(big);
    big[prepared.id] = { installation_mode: 'force_installed',
                         update_url: ext.host.updateUrl(), toolbar_pin: 'force_pinned' };
    const seeded = JSON.stringify(big);
    const seedFile = path.join(TMP, 'seed.reg');
    fs.writeFileSync(seedFile,
        '﻿Windows Registry Editor Version 5.00\r\n\r\n' +
        `[${KEY.replace('HKCU', 'HKEY_CURRENT_USER')}]\r\n"${EXT_SETTINGS}"="` +
        seeded.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"\r\n', 'utf16le');
    sh(`reg import "${seedFile}"`);
    ok(regValue(KEY, EXT_SETTINGS) === seeded,
       `a ${seeded.length}-character policy was seeded intact`,
       String((regValue(KEY, EXT_SETTINGS) || '').length));

    ext._write({ settings: [{ browser: here[0], key: KEY, name: EXT_SETTINGS,
                             prev: null, id: prepared.id }] });
    ext.restore();
    const after = regValue(KEY, EXT_SETTINGS);
    ok(after === reduced, 'restore rewrote the whole 200-entry policy byte-for-byte',
       after === null ? 'value was deleted' : `${after.length} vs ${reduced.length} chars`);
    ok(after && Object.keys(JSON.parse(after)).length === 200 &&
       !JSON.parse(after)[prepared.id], 'ours removed, all 200 of theirs still there');
    sh(`reg delete "${KEY}" /v ${EXT_SETTINGS} /f`);

    ext.host.stop();
    _setManaged(null);          //  back to reading the real device
    sh(`reg delete "${TEST_ROOT}" /f`);
    ok(sh(`reg query "${TEST_ROOT}"`) === null, 'test hive removed');
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}

    console.log(`\n${pass}/${pass + fail} checks passed`);
    process.exit(fail ? 1 : 0);
})().catch(e => {
    console.log('ABORT: ' + e.stack);
    sh(`reg delete "${TEST_ROOT}" /f`);
    process.exit(3);
});
