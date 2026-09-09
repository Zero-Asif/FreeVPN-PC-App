'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/test-stale-ext-id.js  --  ONE extension row, not two.
//
//  THE DEFECT THIS PINS, from the field: every install put a SECOND
//  "FreeProxy VPN Extension" in the browser's list beside the first, and only
//  one of them worked.
//
//  The mechanism, proven and not guessed: a Chromium extension id IS the hash
//  of its public key, so a lost ext-key.pem means the next run offers a
//  DIFFERENT id -- and a different id is, correctly, a different extension. Two
//  things lost the key. installer.nsh's uninstall section did
//  RMDir /r on the whole state directory, and electron-builder runs that
//  uninstaller with /S on every upgrade; and the journal that records what to
//  withdraw died in the same RMDir, so retireSideload() -- which opens with
//  "if (!j) return []" -- had nothing to withdraw the old id with.
//
//  So the fix has two halves and this file checks both:
//    1. the id SURVIVES a silent upgrade (installer.nsh), and
//    2. when it does not survive -- ProgramData deleted by hand, an interrupted
//       install -- the next install withdraws the previous id anyway, from all
//       four routes, WITHOUT withdrawing the one it is about to offer.
//
//  Half 2 is run for real against throwaway HKCU keys. Withdrawing our own
//  offer and putting it straight back is not a harmless extra step: a browser
//  that sees its offer disappear drops the extension, and the spoofed country
//  in its storage goes with it. That is why every check below is stated twice --
//  the stale id is gone AND ours is untouched.
// ════════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const browsers = require('../lib/browsers');
const G = require('../lib/geo-ext');
const { POLICY_KEYS, FORCELIST, ALLOWLIST, EXT_SETTINGS, regWriteSz, regValue,
        regValues, sweepExternal } = G;

const OURS  = 'abcdefghijklmnopabcdefghijklmnop';   // the id we are about to offer
const STALE = 'ponmlkjihgfedcbaponmlkjihgfedcba';   // a previous install's id
const THEIRS = 'cccccccccccccccccccccccccccccccc';  // somebody else's, off-store
const OUR_URL   = 'http://127.0.0.1:8081/update.xml';
const STALE_URL = 'http://127.0.0.1:9042/update.xml';
const STORE_URL = 'https://clients2.google.com/service/update2/crx';

let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
    if (cond) { pass++; console.log('  ok   ' + name); }
    else { fail++; console.log('  FAIL ' + name + (extra ? '  -- ' + extra : '')); }
};
const log = { debug: () => {}, info: () => {}, success: () => {},
              warn: () => {}, error: (...a) => console.log('   ERROR:', ...a) };

const sh = c => { try { return execSync(c, { windowsHide: true, encoding: 'utf8', stdio: 'pipe' }); }
                  catch (e) { return null; } };
const exists = k => sh(`reg query "${k}"`) !== null;

//  Both roots are redirected before installer-tasks is loaded, so nothing in
//  this file can reach a real policy key or a real browser's provider key.
const POL_ROOT = 'HKCU\\SOFTWARE\\FreeProxyStaleIdTest\\Policies';
const EXT_ROOT = 'HKCU\\SOFTWARE\\FreeProxyStaleIdTest\\Ext';
for (const k of Object.keys(POLICY_KEYS)) POLICY_KEYS[k] = POL_ROOT + '\\' + k;
const REAL_ROOTS = browsers.externalRoots;
const REAL_VIEWS = browsers.REG_VIEWS;
browsers.externalRoots = () => [{ id: 'chrome', key: EXT_ROOT }];
browsers.REG_VIEWS = ['64'];

const tasks = require('../lib/installer-tasks');

const PKEY  = POLICY_KEYS.edge;
const FKEY  = PKEY + '\\' + FORCELIST;
const AKEY  = PKEY + '\\' + ALLOWLIST;

const cleanup = () => {
    sh('reg delete "HKCU\\SOFTWARE\\FreeProxyStaleIdTest" /f');
    browsers.externalRoots = REAL_ROOTS;
    browsers.REG_VIEWS = REAL_VIEWS;
};
process.on('exit', () => {
    browsers.externalRoots = REAL_ROOTS;
    browsers.REG_VIEWS = REAL_VIEWS;
});

// ════════════════════════════════════════════════════════════════════
console.log('── 1. route 3: the stale provider key goes, ours stays ──');
// ════════════════════════════════════════════════════════════════════
sh(`reg add "${EXT_ROOT}\\${OURS}" /v update_url /t REG_SZ /d "${OUR_URL}" /f`);
sh(`reg add "${EXT_ROOT}\\${STALE}" /v update_url /t REG_SZ /d "${STALE_URL}" /f`);
sh(`reg add "${EXT_ROOT}\\${THEIRS}" /v update_url /t REG_SZ /d "${STORE_URL}" /f`);

const n3 = sweepExternal(log, OURS);
ok(n3 === 1, 'exactly one subkey removed', 'removed ' + n3);
ok(!exists(`${EXT_ROOT}\\${STALE}`), 'the previous install\'s id is withdrawn');
ok(exists(`${EXT_ROOT}\\${OURS}`),
   'the id we are about to offer is STILL THERE -- withdrawing it would make the ' +
   'browser drop the extension and lose the country in its storage');
ok(exists(`${EXT_ROOT}\\${THEIRS}`),
   'a store-served entry that is not ours is never touched');
ok(exists(EXT_ROOT), 'and the provider root survives, because ours is still in it');

ok(sweepExternal(log, OURS) === 0, 'run twice, the second run removes nothing');

//  The unguarded call is what teardown uses, and it must still take everything
//  of ours -- that behaviour is what .build/test-geo-external.js pins.
ok(sweepExternal(log) === 1, 'with no id to keep, the same sweep takes ours too (teardown)');
ok(!exists(`${EXT_ROOT}\\${OURS}`), 'so after a teardown sweep no loopback offer is left');
ok(exists(`${EXT_ROOT}\\${THEIRS}`), 'and the stranger\'s entry still survives that');

console.log('');
console.log('── 2. a keepId that is not an id is refused, not obeyed ──');
sh(`reg add "${EXT_ROOT}\\${OURS}" /v update_url /t REG_SZ /d "${OUR_URL}" /f`);
for (const bad of ['', null, undefined, 'notanextensionid', OURS.toUpperCase(),
                   OURS + 'q', 'abcdefghijklmnopabcdefghijklmno']) {
    sh(`reg add "${EXT_ROOT}\\${OURS}" /v update_url /t REG_SZ /d "${OUR_URL}" /f`);
    const took = sweepExternal(log, bad);
    ok(took === 1,
       `keepId ${JSON.stringify(bad)} is not honoured as a keep -- a half-valid id ` +
       'must never silently protect the wrong row', 'removed ' + took);
}

console.log('');
console.log('── 3. retireStaleOffers() refuses to run without a real id ──');
sh(`reg add "${EXT_ROOT}\\${OURS}" /v update_url /t REG_SZ /d "${OUR_URL}" /f`);
sh(`reg add "${EXT_ROOT}\\${STALE}" /v update_url /t REG_SZ /d "${STALE_URL}" /f`);
for (const bad of [null, undefined, '', 'nope']) {
    ok(tasks.retireStaleOffers(log, bad) === 0,
       `no sweep at all when the id is ${JSON.stringify(bad)}`);
}
ok(exists(`${EXT_ROOT}\\${OURS}`) && exists(`${EXT_ROOT}\\${STALE}`),
   'and nothing was removed by those calls -- a staging failure must not ' +
   'become an uninstall of the working extension');

console.log('');
console.log('── 4. routes 1, 2 and 4 in one pass, ours held back ──');
//  Route 1: three entries -- ours, a previous install's, and an administrator's.
sh(`reg add "${FKEY}" /v 1 /t REG_SZ /d "${OURS};${OUR_URL}" /f`);
sh(`reg add "${FKEY}" /v 2 /t REG_SZ /d "${STALE};${STALE_URL}" /f`);
sh(`reg add "${FKEY}" /v 3 /t REG_SZ /d "${THEIRS};${STORE_URL}" /f`);
//  Route 4: a bare id has no shape of its own, so each is only removable
//  because a loopback entry elsewhere proves whose it is.
sh(`reg add "${AKEY}" /v 1 /t REG_SZ /d "${OURS}" /f`);
sh(`reg add "${AKEY}" /v 2 /t REG_SZ /d "${STALE}" /f`);
sh(`reg add "${AKEY}" /v 3 /t REG_SZ /d "${THEIRS}" /f`);
//  Route 2: the dictionary, with a workplace rule beside the two of ours.
regWriteSz(PKEY, EXT_SETTINGS, JSON.stringify({
    '*': { installation_mode: 'allowed' },
    [OURS]:  { installation_mode: 'force_installed', update_url: OUR_URL },
    [STALE]: { installation_mode: 'force_installed', update_url: STALE_URL },
    [THEIRS]: { installation_mode: 'force_installed', update_url: STORE_URL },
}));

const proven = tasks.ourLoopbackIds({ exceptId: OURS });
ok(proven.has(STALE), 'the previous id is proved ours by its loopback update_url');
ok(!proven.has(OURS), 'and the id we are about to offer is excluded from the proof set');
ok(!proven.has(THEIRS), 'a store update_url proves nothing, so that id is never in it');

const n12 = tasks.sweepForcelists(log, { exceptId: OURS });

const fl = regValues(FKEY);
const flv = Object.values(fl).map(String);
ok(flv.some(v => v.startsWith(OURS + ';')), 'route 1 keeps our force-install entry');
ok(!flv.some(v => v.startsWith(STALE + ';')), 'route 1 loses the previous install\'s');
ok(flv.some(v => v.startsWith(THEIRS + ';')), 'route 1 keeps the administrator\'s');

const al = Object.values(regValues(AKEY)).map(v => String(v).trim());
ok(al.includes(OURS),
   'route 4 keeps OUR allowlist entry -- that entry is the permission the ' +
   'browser needs to keep the extension enabled');
ok(!al.includes(STALE), 'route 4 loses the previous install\'s');
ok(al.includes(THEIRS), 'route 4 keeps an id it cannot prove is ours');

let dict = null;
try { dict = JSON.parse(regValue(PKEY, EXT_SETTINGS)); } catch (e) {}
ok(dict && dict[OURS], 'route 2 keeps our dictionary entry');
ok(dict && !dict[STALE], 'route 2 loses the previous install\'s');
ok(dict && dict[THEIRS], 'route 2 keeps the other force-install entry');
ok(dict && dict['*'], 'and the workplace wildcard rule is written back untouched');
ok(n12 >= 3, 'all three of the stale routes were counted', 'counted ' + n12);

console.log('');
console.log('── 5. one call does routes 1-4 together ──');
sh(`reg add "${FKEY}" /v 2 /t REG_SZ /d "${STALE};${STALE_URL}" /f`);
sh(`reg add "${AKEY}" /v 2 /t REG_SZ /d "${STALE}" /f`);
sh(`reg add "${EXT_ROOT}\\${STALE}" /v update_url /t REG_SZ /d "${STALE_URL}" /f`);
const nAll = tasks.retireStaleOffers(log, OURS);
ok(nAll >= 3, 'retireStaleOffers() withdrew every route in one pass', 'withdrew ' + nAll);
ok(!Object.values(regValues(FKEY)).some(v => String(v).startsWith(STALE + ';')) &&
   !Object.values(regValues(AKEY)).some(v => String(v).trim() === STALE) &&
   !exists(`${EXT_ROOT}\\${STALE}`),
   'nothing named by the stale id is left anywhere');
ok(Object.values(regValues(FKEY)).some(v => String(v).startsWith(OURS + ';')) &&
   Object.values(regValues(AKEY)).map(v => String(v).trim()).includes(OURS),
   'and ours is intact in every route after that pass');
ok(tasks.retireStaleOffers(log, OURS) === 0, 'and it is a no-op the second time');

cleanup();
ok(!exists('HKCU\\SOFTWARE\\FreeProxyStaleIdTest'), 'test keys removed');

// ════════════════════════════════════════════════════════════════════
console.log('');
console.log('── 6. the silent upgrade keeps the key -- installer.nsh ──');
// ════════════════════════════════════════════════════════════════════
//  Static, and said plainly: NSIS cannot be executed here, so what is checked
//  is that the carve-out exists, is inside the silent branch, brackets the
//  RMDir on both sides, and cleans TEMP unconditionally.
const nsh = fs.readFileSync(path.join(__dirname, '..', 'installer.nsh'), 'utf8');
const rmAt   = nsh.indexOf('RMDir /r "C:\\ProgramData\\freeproxy-vpn"');
const keepAt = nsh.indexOf('fp-keep-ext-key.pem');
const backAt = nsh.lastIndexOf('fp-keep-ext-key.pem');
ok(rmAt > 0, 'the uninstall section still removes the state directory');
ok(keepAt > 0 && keepAt < rmAt,
   'the key is copied out BEFORE the RMDir that would destroy it');
ok(backAt > rmAt, 'and copied back after it');
ok(/CopyFiles\s+\/SILENT\s+"C:\\ProgramData\\freeproxy-vpn\\ext-key\.pem"/.test(nsh),
   'ext-key.pem is what is preserved -- the id is the hash of that key');
ok(/fp-keep-ext-restore\.json/.test(nsh),
   'and the journal with it, so the old id can still be withdrawn by exact match');

const silentBlocks = nsh.split(/\$\{If\}\s+\$\{Silent\}/).slice(1);
ok(silentBlocks.length >= 2,
   'both halves sit in ${If} ${Silent} -- a user-initiated uninstall preserves nothing');
ok(silentBlocks.some(b => /fp-keep-ext-key\.pem/.test(b.split('${EndIf}')[0])),
   'the copy-out is inside that branch, not run unconditionally');
const tail = nsh.slice(rmAt);
ok(/Delete\s+"\$TEMP\\fp-keep-ext-key\.pem"/.test(tail),
   'the private key is deleted out of TEMP afterwards, on every path');
ok(/Delete\s+"\$TEMP\\fp-keep-ext-restore\.json"/.test(tail),
   'and so is the journal copy');

// ════════════════════════════════════════════════════════════════════
console.log('');
console.log('── 7. the sweep is wired where it runs ONCE, not per connect ──');
// ════════════════════════════════════════════════════════════════════
//  A registry sweep is ~2 spawns per provider root per view, and a spawn on
//  this machine costs ~176 ms measured -- so this must never sit on the connect
//  path, which is the same path the "(Not Responding)" report is about.
const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'installer-tasks.js'), 'utf8');
const at = (needle, from) => src.indexOf(needle, from || 0);
const setupAt = at('async function taskSetup');
const bootAt  = at('async function taskBoot');
const bootEnd = at('async function taskSetup');   // taskBoot is declared first
ok(setupAt > 0 && bootAt > 0 && bootAt < setupAt, 'both task bodies located');

const inBoot  = src.slice(bootAt, bootEnd);
const inSetup = src.slice(setupAt, at('\nmodule.exports', setupAt) > 0
                                  ? at('\nmodule.exports', setupAt) : src.length);
for (const [name, body] of [['boot pass', inBoot], ['install', inSetup]]) {
    const call = body.indexOf('retireStaleOffers(log, prepared.id)');
    const apply = body.indexOf('applyRoutes(log, ext)');
    ok(call > 0, `the ${name} withdraws stale offers`);
    ok(call > 0 && apply > 0 && call < apply,
       `and does it BEFORE writing its own offer, so the write is not undone`);
    ok(call > 0 && body.lastIndexOf('prepared) return', call) > 0 ||
       body.lastIndexOf('return EXIT.stageFailed', call) > 0,
       `and only after ${name} has a real id to keep`);
}

const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
ok(!/retireStaleOffers|sweepExternal/.test(mainSrc),
   'main.js -- which calls ext.install() on EVERY connect -- never sweeps: ' +
   '~12 spawns at ~176 ms each does not belong on the connect path');
const geoSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'geo-ext.js'), 'utf8');
const instAt = geoSrc.indexOf('    install(');
ok(instAt > 0 && !/sweepExternal\s*\(/.test(
       geoSrc.slice(instAt, geoSrc.indexOf('\n    }', instAt))),
   'and install() itself does not call the sweep either');

// ── 8. the folder the user is TOLD to load must be the keyed one ─────
//  The third way to get two rows, and the only one left. An id comes from a
//  key; a folder with NO key gets its id from its own absolute PATH instead
//  (Chromium id_util.cc, sha256 of the UTF-16LE path). So there are two
//  loadable copies of this extension on an installed machine:
//
//    C:\ProgramData\freeproxy-vpn\browser-setup\extension  -- keyed by _stage()
//    <install dir>\resources\Extension                     -- the source, keyless
//
//  MEASURED (.build/probe-unpacked-id.js): loading the first gives
//  jnankljphnjghgegchkfcdcpgdakpmnc, the same id the CRX installs, so a user who
//  follows HOW-TO-ENABLE.txt gets ONE row however many times they do it.
//  Loading the second gives imlmcdmjclmlkhgljdokgjepcppgjfob -- a second row
//  with the same display name. Nothing points a browser at it today and no
//  profile on the test machine holds it, so it is a latent route and not the
//  reported defect; what keeps it latent is that the instructions name this.dir.
//  Naming this.sourceDir there instead would hand every user who reads them the
//  exact duplicate this file exists to prevent.
{
    const at = geoSrc.indexOf("'  3. Click \"Load unpacked\"'");
    ok(at > 0, 'geo-ext.js still writes Load-unpacked instructions');
    const near = geoSrc.slice(at, at + 400);
    ok(/\+ this\.dir\b/.test(near),
       'and it names this.dir -- the staged copy, whose manifest carries the key',
       (near.match(/'\s*'\s*\+\s*this\.\w+/) || ['?'])[0]);
    ok(!/this\.sourceDir/.test(near),
       'not this.sourceDir, which is keyless and would install under a ' +
       'path-derived id as a SECOND row');

    //  And the key really is injected into the copy that is named, not merely
    //  into some copy: _stage writes manifest.json itself, with mf.key set.
    const st = geoSrc.indexOf('    _stage(');
    const body = geoSrc.slice(st, geoSrc.indexOf('\n    }', st));
    ok(/mf\.key = spkiB64/.test(body) &&
       /writeFileSync\(path\.join\(this\.dir, 'manifest\.json'\)/.test(body),
       'the staged manifest is written with the key, so its unpacked id is the CRX id');
    ok(/if \(r === 'manifest\.json'\) continue/.test(body),
       'and the keyless source manifest is never copied over it');
}

// ════════════════════════════════════════════════════════════════════
console.log('');
console.log(`${pass}/${pass + fail} checks passed`);
if (fail) {
    console.log('\nTHE ROW COUNT IS THE SYMPTOM: a browser showing two ' +
                '"FreeProxy VPN Extension" entries is showing two ids.');
    process.exit(1);
}
process.exit(0);
