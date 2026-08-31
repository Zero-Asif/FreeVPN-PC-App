'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/test-geo-forcelist.js  --  install()/restore() against a REAL
//  registry key, unelevated.
//
//  POLICY_KEYS is redirected at HKCU\SOFTWARE\FreeProxyGeoTest, which a normal
//  user can write. The point is not to test reg.exe: it is to test the two
//  behaviours that would do real damage if they were wrong.
//
//    1. The user's OWN ExtensionInstallForcelist entries survive. A workplace
//       forcelist is how required extensions get deployed; clearing the subkey
//       wholesale -- which the rejected blocking layer did with its own policy
//       -- would silently uninstall them.
//    2. restore() removes ONLY the slot we wrote, and only while it still
//       holds our id. If something else has taken that slot since, ours is
//       gone already and deleting the new occupant is somebody else's outage.
//
//  Everything here is verified by reading the registry back, never by
//  trusting a return value -- a silent registry failure reported upstream as
//  success is how a whole round of wrong conclusions got drawn once already.
// ════════════════════════════════════════════════════════════════════
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const geoExtMod = require('../lib/geo-ext');
const { GeoExt, POLICY_KEYS, FORCELIST } = geoExtMod;

const TEST_ROOT = 'HKCU\\SOFTWARE\\FreeProxyGeoTest';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fpfl-'));

//  Only Edge is in FORCE_INSTALLABLE on this machine, so only Edge's key is
//  exercised. Point every fork's root at the sandbox anyway: POLICY_KEYS is
//  now derived from lib/browsers.js, so it grows whenever a browser is added
//  to that table -- and this test must never start writing to a real policy
//  hive as a side effect of someone editing the table.
for (const k of Object.keys(POLICY_KEYS)) POLICY_KEYS[k] = TEST_ROOT + '\\' + k;

const KEY = POLICY_KEYS.edge + '\\' + FORCELIST;

const sh = c => { try { return execSync(c, { windowsHide: true, encoding: 'utf8', stdio: 'pipe' }); }
                  catch (e) { return null; } };
//  Same exclusion as lib/geo-ext.js: `reg add <key> /f` sets the key's default
//  value to an empty string, and counting that artifact as an entry is exactly
//  the bug this test found -- restore() then never considers the subkey empty.
function values(key) {
    const out = sh(`reg query "${key}"`);
    if (!out) return {};
    const v = {};
    for (const line of out.split(/\r?\n/)) {
        const m = line.match(/^\s{4}(\S+)\s+REG_SZ\s+(.*)$/);
        if (m && m[1] !== '(Default)') v[m[1]] = m[2].trim();
    }
    return v;
}

let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
    if (cond) { pass++; console.log('  ok   ' + name); }
    else { fail++; console.log('  FAIL ' + name + (extra ? '  -- ' + extra : '')); }
};

const log = { debug: () => {}, info: () => {}, success: () => {},
              warn: (...a) => console.log('   warn:', ...a),
              error: (...a) => console.log('   ERROR:', ...a) };

const USER_1 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa;https://clients2.google.com/service/update2/crx';
const USER_2 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb;https://clients2.google.com/service/update2/crx';

(async () => {
    sh(`reg delete "${TEST_ROOT}" /f`);

    const ext = new GeoExt({ log, stateDir: TMP, sourceDir: path.join(__dirname, '..', 'Extension') });
    const prepared = await ext.prepare();
    if (!prepared) { console.log('ABORT: prepare() failed'); process.exit(3); }
    console.log(`id ${prepared.id}  ${prepared.updateUrl}\n`);

    console.log("── the user already has two forced extensions ──");
    sh(`reg add "${KEY}" /f`);
    sh(`reg add "${KEY}" /v "1" /t REG_SZ /d "${USER_1}" /f`);
    sh(`reg add "${KEY}" /v "2" /t REG_SZ /d "${USER_2}" /f`);
    ok(Object.keys(values(KEY)).length === 2, 'two pre-existing entries staged');

    console.log('── install ──');
    const done = ext.install();
    ok(done.includes('edge'), 'install() reports edge by its stable id', JSON.stringify(done));
    let v = values(KEY);
    ok(v['1'] === USER_1 && v['2'] === USER_2, "the user's own entries are untouched", JSON.stringify(v));
    ok(v['3'] === `${prepared.id};${prepared.updateUrl}`,
       'our entry took the lowest free slot (3)', JSON.stringify(v));

    console.log('── install again: idempotent, no duplicate ──');
    ext.install();
    v = values(KEY);
    ok(Object.keys(v).length === 3, 'still exactly three entries', JSON.stringify(v));
    const j = JSON.parse(fs.readFileSync(ext.stateFile, 'utf8'));
    ok(j.slots.length === 1 && j.slots[0].slot === '3', 'journal records exactly one slot',
       JSON.stringify(j.slots));

    console.log('── restore ──');
    ext.restore();
    v = values(KEY);
    ok(v['3'] === undefined, 'our slot is gone');
    ok(v['1'] === USER_1 && v['2'] === USER_2, "the user's entries survived the restore",
       JSON.stringify(v));
    ok(JSON.parse(fs.readFileSync(ext.stateFile, 'utf8')).slots.length === 0, 'journal cleared');

    console.log('── restore must not evict a slot somebody else now owns ──');
    ext.install();
    ok(values(KEY)['3'] !== undefined, 'reinstalled into slot 3');
    sh(`reg add "${KEY}" /v "3" /t REG_SZ /d "${USER_1}" /f`);
    ext.restore();
    ok(values(KEY)['3'] === USER_1, 'a slot taken over by another extension is left alone',
       JSON.stringify(values(KEY)));

    console.log('── an emptied subkey is removed, a shared one is kept ──');
    sh(`reg delete "${KEY}" /f`);
    //  `reg add <key> /f` here on purpose: it leaves a default value behind,
    //  which is what made restore() decide the subkey was still in use.
    sh(`reg add "${KEY}" /f`);
    ext.install();
    v = values(KEY);
    ok(v['1'] === `${prepared.id};${prepared.updateUrl}`, 'took slot 1 in an empty forcelist',
       JSON.stringify(v));
    ext.restore();
    ok(sh(`reg query "${KEY}"`) === null,
       'empty forcelist subkey deleted despite the default-value artifact');

    console.log('── install must not create a stray default value ──');
    sh(`reg delete "${POLICY_KEYS.edge}" /f`);
    ext.install();
    const raw = sh(`reg query "${KEY}"`) || '';
    ok(!/\(Default\)/.test(raw), 'our own install leaves no default value', raw.trim());
    ok(!/\(Default\)/.test(sh(`reg query "${POLICY_KEYS.edge}"`) || ''),
       'nor on the policy key above it');
    ext.restore();

    console.log('── startup sweep: restore() with no id prepared ──');
    ext.install();
    const fresh = new GeoExt({ log, stateDir: TMP, sourceDir: path.join(__dirname, '..', 'Extension') });
    ok(fresh.id === null, 'a fresh instance has no id yet');
    fresh.restore();
    ok(sh(`reg query "${KEY}"`) === null,
       'the journal\'s own id is enough to clean up at startup');

    console.log('── ...but still refuses to evict a foreign entry ──');
    ext.install();
    sh(`reg add "${KEY}" /v "1" /t REG_SZ /d "${USER_2}" /f`);
    const fresh2 = new GeoExt({ log, stateDir: TMP, sourceDir: path.join(__dirname, '..', 'Extension') });
    fresh2.restore();
    ok(values(KEY)['1'] === USER_2, 'foreign entry survives the startup sweep too',
       JSON.stringify(values(KEY)));

    console.log('── route 4: the allowlist, written and reverted by the journal ──');
    //  What this proves, and it is the whole reason route 4 exists: the entry
    //  that keeps a browser from disabling what route 3 delivered is written for
    //  every policy-capable browser that is really here, and taken out again by
    //  the journal -- never by shape, because a bare id has no shape of ours.
    const { ALLOWLIST } = geoExtMod;
    const browsersMod = require('../lib/browsers');
    const present = browsersMod.detectChromium().map(b => b.id)
        .filter(id => POLICY_KEYS[id]);
    sh(`reg delete "${TEST_ROOT}" /f`);
    ext.install();
    for (const id of present) {
        const ak = POLICY_KEYS[id] + '\\' + ALLOWLIST;
        const v = values(ak);
        ok(Object.values(v).includes(prepared.id),
           `${id}: our id is in the allowlist`, JSON.stringify(v));
    }
    ok(present.length > 0, 'at least one Chromium is installed, so this ran at all',
       present.join(', '));

    //  A workplace allowlist next to ours, in the same subkey.
    const AK = POLICY_KEYS[present[0]] + '\\' + ALLOWLIST;
    sh(`reg add "${AK}" /v "9" /t REG_SZ /d "${USER_2.split(';')[0]}" /f`);
    ext.restore();
    ok(!Object.values(values(AK)).includes(prepared.id),
       'restore() removed our slot', JSON.stringify(values(AK)));
    ok(Object.values(values(AK)).includes(USER_2.split(';')[0]),
       "the workplace's allowed id survives", JSON.stringify(values(AK)));
    sh(`reg delete "${AK}" /f`);

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
