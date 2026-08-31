'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/test-installer-sweep.js  --  the uninstaller's PowerShell
//  fallback sweep, extracted from installer.nsh and run for real.
//
//  WHY THIS EXISTS
//  That sweep is the ONLY thing that cleans up when electron-builder has
//  already deleted the program files, so it can never be exercised by running
//  the app. It is also written as a stack of NSIS FileWrite lines, where one
//  wrong `$$` produces a script that runs, prints nothing and removes nothing.
//
//  So: parse installer.nsh, undo the NSIS escaping exactly the way makensis
//  does, and run the resulting .ps1 -- with THREE substitutions, all of them
//  the registry roots it walks, pointed at HKCU\SOFTWARE\FreeProxyNshTest.
//  Real reg keys, real PowerShell, real regex; no policy hive is touched, no
//  external-extensions provider is touched, and no browser is opened.
//
//  The route-3 half MUST be redirected or this test could not be run at all:
//  it opens HKLM\SOFTWARE through OpenBaseKey and deletes any 32-letter subkey
//  of an Extensions key whose update_url is loopback. Run unredirected on a dev
//  machine, that is the real thing against the real hive. installer.nsh names
//  the hive and the root in $exHive/$exRoot for exactly this reason.
//
//  What would do damage if it were wrong, and is therefore what is checked:
//    1. An administrator's ExtensionSettings entry SURVIVES; only ours goes.
//    2. The value is deleted outright only when ours was the only entry.
//    3. A policy with nothing of ours in it is not rewritten at all.
//    4. The numbered forcelist keeps a workplace slot and drops ours.
//    5. An external-extensions entry goes only when the id shape AND the
//       loopback update_url both say it is ours -- a store-served id with a
//       perfectly valid shape stays, and so does a non-id subkey name.
//    6. The Extensions key itself goes when emptying it is what we did, and
//       stays when someone else still has an entry in it. A lone (Default)
//       value -- reg add's own litter -- does not count as someone else.
//    7. The vendor key above it is never touched either way.
// ════════════════════════════════════════════════════════════════════
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

const NSH  = path.join(__dirname, '..', 'installer.nsh');
const ROOT = 'HKCU\\SOFTWARE\\FreeProxyNshTest';
const PS_ROOT = 'HKCU:\\SOFTWARE\\FreeProxyNshTest';
//  Route 3 is reached through OpenBaseKey(hive, view), so it needs the hive
//  NAME and a root path relative to it -- not a PowerShell drive path.
const PS_EXT_HIVE = 'CurrentUser';
const PS_EXT_SUB  = 'SOFTWARE\\FreeProxyNshTest\\Ext';
const EXT_ROOT    = ROOT + '\\Ext';
const TMP  = fs.mkdtempSync(path.join(os.tmpdir(), 'fpnsh-'));

const OURS    = 'mmhnilciaeffiogonfcmcgcilkdliobc';
const LEGACY  = 'oecbgglkbdlifmaedkikgpmifiidjhfo';
const FOREIGN = 'cccccccccccccccccccccccccccccccc';
//  A second well-formed id, served from a real update server. It exists to
//  prove the id shape ALONE never triggers a delete.
const ADMINS  = 'ponmlkjihgfedcbaponmlkjihgfedcba';
const NOT_ID  = 'notanextensionid';
const OUR_URL = 'http://127.0.0.1:8081/u.xml';
const STORE   = 'https://clients2.google.com/service/update2/crx';

let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
    if (cond) { pass++; console.log('  ok   ' + name); }
    else { fail++; console.log('  FAIL ' + name + (extra ? '  -- ' + extra : '')); }
};
const sh = c => { try { return execSync(c, { windowsHide: true, encoding: 'utf8', stdio: 'pipe' }); }
                  catch (e) { return null; } };

// ── NSIS string unescaping, one pass, left to right ──────────────
//  makensis turns $$ into $, and $\r $\n $\t $\" $\' into the character they
//  name. Anything else is literal. Done as a scan rather than a chain of
//  .replace() calls because the chain order changes the answer.
function unescapeNsis(s) {
    let out = '';
    for (let i = 0; i < s.length; i++) {
        if (s[i] !== '$') { out += s[i]; continue; }
        const n = s[i + 1];
        if (n === '$') { out += '$'; i++; continue; }
        if (n === '\\') {
            const c = s[i + 2];
            if (c === 'r') { out += '\r'; i += 2; continue; }
            if (c === 'n') { out += '\n'; i += 2; continue; }
            if (c === 't') { out += '\t'; i += 2; continue; }
            if (c === '"' || c === "'" || c === '$') { out += c; i += 2; continue; }
        }
        out += '$';
    }
    return out;
}

//  Every FileWrite that belongs to the named script, in order.
function extractScript(nsh, marker) {
    const lines = nsh.split(/\r?\n/);
    let i = lines.findIndex(l => l.includes(marker));
    if (i < 0) return null;
    let body = '';
    for (; i < lines.length; i++) {
        if (/FileClose\s+\$2/.test(lines[i])) return body;
        const m = lines[i].match(/^\s*FileWrite\s+\$2\s+"([\s\S]*)"\s*$/);
        if (m) body += unescapeNsis(m[1]);
    }
    return null;
}

const regJson = (key, obj) => sh(`reg add "${key}" /v ExtensionSettings /t REG_SZ /d ` +
                                 `"${JSON.stringify(obj).replace(/"/g, '\\"')}" /f`);
function readJson(key) {
    const out = sh(`reg query "${key}" /v ExtensionSettings`);
    if (!out) return null;
    for (const line of out.split(/\r?\n/)) {
        const i = line.indexOf('REG_SZ');
        if (i > 0 && line.slice(0, i).trim() === 'ExtensionSettings') {
            try { return JSON.parse(line.slice(i + 6).trim()); } catch (e) { return 'unparseable'; }
        }
    }
    return null;
}

const entry = url => ({ installation_mode: 'force_installed', update_url: url,
                        toolbar_pin: 'force_pinned' });

//  ── route-3 seeding and reading, through reg.exe ──
//  Deliberately reg.exe and not the .NET API the sweep itself uses: if both
//  sides shared one implementation a bug in it would cancel out and the test
//  would pass on a sweep that removes nothing.
const keyExists = key => sh(`reg query "${key}"`) !== null;
const extAdd = (key, url) => sh(`reg add "${key}" /v update_url /t REG_SZ /d "${url}" /f`);
//  Names of the immediate subkeys of a key, or null if the key is gone.
//  reg query echoes paths with the hive spelled out in full, so the short form
//  we pass in has to be expanded before anything can be matched against it.
function subkeys(key) {
    const out = sh(`reg query "${key}"`);
    if (out === null) return null;
    const full = key.replace(/^HKCU\\/i, 'HKEY_CURRENT_USER\\')
                    .replace(/^HKLM\\/i, 'HKEY_LOCAL_MACHINE\\');
    const pre = full.toUpperCase() + '\\';
    const names = [];
    for (const raw of out.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line.toUpperCase().startsWith(pre)) continue;
        const rest = line.slice(full.length + 1);
        if (rest && !rest.includes('\\')) names.push(rest);
    }
    return names;
}

(async () => {
    const nsh = fs.readFileSync(NSH, 'utf8');
    const body = extractScript(nsh, 'fp-uninstall-sweep.ps1');
    if (!body) { console.log('ABORT: the sweep script could not be found in installer.nsh'); process.exit(3); }

    ok(/ConvertFrom-Json/.test(body) && /ExtensionSettings/.test(body),
       'the extracted script really is the sweep');
    ok(body.includes("'^[a-p]{32}$'"),
       'the 32-letter id regex survived NSIS escaping -- $$ became one $',
       body.match(/\^\[a-p\]\{32\}\$*'/g) && body.match(/\^\[a-p\]\{32\}\$*'/g).join(' '));
    ok(body.includes('$sig') && !body.includes('$$sig'), 'variables are single-$');
    ok(body.split('\n').length > 20, 'every FileWrite line was captured',
       String(body.split('\n').length));

    //  THE substitutions: every registry root the script walks, and nothing
    //  else. Order-independent -- the policy replacement yields
    //  'HKCU:\SOFTWARE\FreeProxyNshTest', which does not contain the exact
    //  literal 'SOFTWARE' (quotes included) that the route-3 root is written as.
    const script = body
        .split("'HKLM:\\Software\\Policies'").join(`'${PS_ROOT}'`)
        .split("'LocalMachine'").join(`'${PS_EXT_HIVE}'`)
        .split("'SOFTWARE'").join(`'${PS_EXT_SUB}'`);
    ok(script !== body, 'the registry root was redirected for the test');
    ok(script.includes(`'${PS_ROOT}'`) && !script.includes("'HKLM:\\Software\\Policies'"),
       'the policy walk points at the test hive');
    ok(script.includes(`'${PS_EXT_HIVE}'`) && !/'LocalMachine'/.test(script),
       'the external-extensions walk points at HKCU, not HKLM');
    ok(script.includes(`'${PS_EXT_SUB}'`) && !/\$exRoot = 'SOFTWARE'/.test(script),
       'and at the throwaway Ext root, not the whole of SOFTWARE');
    ok((script.match(/OpenBaseKey/g) || []).length === 1,
       'exactly one OpenBaseKey call, so nothing else reads a hive directly');
    //  A hard stop, not a failed check. ok() records and carries on, and
    //  carrying on here means running a real HKLM sweep on this machine because
    //  a literal in installer.nsh was renamed. Refuse to execute instead.
    if (/'LocalMachine'/.test(script) || /HKLM/i.test(script)) {
        console.log('ABORT: a real-hive reference survived redirection -- refusing to run.');
        console.log('       Check the $exHive/$exRoot literals in installer.nsh.');
        try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
        process.exit(3);
    }
    const file = path.join(TMP, 'sweep.ps1');
    fs.writeFileSync(file, script, 'utf8');

    sh(`reg delete "${ROOT}" /f`);

    // ── the four cases, seeded side by side ──────────────────────
    const MIXED  = ROOT + '\\Google\\Chrome';
    const ONLY   = ROOT + '\\BraveSoftware\\Brave';
    const THEIRS = ROOT + '\\Microsoft\\Edge';
    const LEG    = ROOT + '\\Vendor\\Fork';
    const FL     = MIXED + '\\ExtensionInstallForcelist';

    sh(`reg add "${MIXED}" /v Placeholder /t REG_SZ /d x /f`);
    regJson(MIXED,  { [OURS]: entry(OUR_URL), [FOREIGN]: entry(STORE) });
    regJson(ONLY,   { [OURS]: entry(OUR_URL) });
    regJson(THEIRS, { '*': { installation_mode: 'blocked' }, [FOREIGN]: entry(STORE) });
    regJson(LEG,    { [LEGACY]: entry(STORE), [FOREIGN]: entry(STORE) });
    const theirsBefore = JSON.stringify(readJson(THEIRS));

    sh(`reg add "${FL}" /v 1 /t REG_SZ /d "${OURS};${OUR_URL}" /f`);
    sh(`reg add "${FL}" /v 2 /t REG_SZ /d "${FOREIGN};${STORE}" /f`);
    //  A value the sweep is supposed to strip from a policy root, to prove the
    //  ExtensionSettings block did not break the rest of the loop.
    sh(`reg add "${MIXED}" /v DnsOverHttpsMode /t REG_SZ /d off /f`);

    // ── route 4: ExtensionInstallAllowlist, the bare-id policy ────
    //  Three allowlists, because the value carries NO evidence of its own and
    //  the whole question is where the evidence comes from:
    //
    //    AL_MIXED   ours (proved by the loopback forcelist slot and the
    //               ExtensionSettings entry seeded above) next to a stranger's.
    //               Ours goes, theirs stays, and the subkey stays with it.
    //    AL_ONLY    ours alone -- the subkey has to be pruned once it is empty,
    //               and the (Default) value reg add leaves behind must not count
    //               as a survivor.
    //    AL_ALIEN   an id of exactly our shape that this machine serves NOWHERE.
    //               No proof, so it is an administrator's allowlist entry and it
    //               survives -- this is the assertion that separates "remove our
    //               policy" from "empty the allowlist".
    const AL_MIXED = MIXED  + '\\ExtensionInstallAllowlist';
    const AL_ONLY  = ONLY   + '\\ExtensionInstallAllowlist';
    const AL_ALIEN = THEIRS + '\\ExtensionInstallAllowlist';
    sh(`reg add "${AL_MIXED}" /v 1 /t REG_SZ /d "${OURS}" /f`);
    sh(`reg add "${AL_MIXED}" /v 2 /t REG_SZ /d "${FOREIGN}" /f`);
    sh(`reg add "${AL_ONLY}"  /f`);
    sh(`reg add "${AL_ONLY}"  /v 1 /t REG_SZ /d "${OURS}" /f`);
    sh(`reg add "${AL_ALIEN}" /v 1 /t REG_SZ /d "${ADMINS}" /f`);

    // ── route 3: the forks' own external-extensions provider ─────
    //  Five vendor shapes side by side, all under the throwaway Ext root the
    //  substitution above pointed the walk at. Between them they cover both
    //  halves of the ownership test, both depths installer.nsh walks, and both
    //  directions of the prune.
    const V_OURS  = EXT_ROOT + '\\VendorV\\Extensions';           // ours alone
    const V_CHR   = EXT_ROOT + '\\Google\\Chrome\\Extensions';    // shared, product level
    const V_ADMIN = EXT_ROOT + '\\VendorW\\Extensions';           // theirs alone
    const V_FORK  = EXT_ROOT + '\\VendorX\\Fork\\Extensions';     // ours alone, nested
    const V_VAL   = EXT_ROOT + '\\VendorY\\Extensions';           // ours, plus their value

    //  Key-only reg add first, on purpose: it leaves a (Default) value behind,
    //  which is what the sweep has to discount to ever call this key empty.
    sh(`reg add "${V_OURS}" /f`);
    extAdd(V_OURS + '\\' + OURS, OUR_URL);

    extAdd(V_CHR + '\\' + OURS, OUR_URL);
    extAdd(V_CHR + '\\' + FOREIGN, STORE);
    extAdd(V_CHR + '\\' + NOT_ID, OUR_URL);   // right server, wrong shape

    extAdd(V_ADMIN + '\\' + ADMINS, STORE);   // right shape, wrong server

    extAdd(V_FORK + '\\' + OURS, OUR_URL);

    extAdd(V_VAL + '\\' + OURS, OUR_URL);
    sh(`reg add "${V_VAL}" /v Comment /t REG_SZ /d "left by hand" /f`);

    ok(keyExists(V_OURS + '\\' + OURS) && keyExists(V_CHR + '\\' + FOREIGN) &&
       keyExists(V_FORK + '\\' + OURS) && keyExists(V_VAL + '\\' + OURS),
       'the external-extensions shapes were seeded');

    console.log('── running the extracted sweep ──');
    //  spawnSync, so stderr is captured rather than printed past the harness:
    //  a PowerShell non-terminating error is exactly the failure mode this test
    //  exists to catch, and it must be assertable, not merely visible.
    const runSweep = () => {
        const r = spawnSync('powershell.exe',
            ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file],
            { windowsHide: true, encoding: 'utf8' });
        return { out: String(r.stdout || ''), err: String(r.stderr || '') };
    };
    const run1 = runSweep();
    const out = run1.out;
    out.split(/\r?\n/).filter(Boolean).forEach(l => console.log('   ps: ' + l));
    run1.err.split(/\r?\n/).filter(Boolean).forEach(l => console.log('   ps!: ' + l));
    ok(run1.err.trim() === '', 'the sweep ran without a single PowerShell error',
       run1.err.replace(/\s+/g, ' ').slice(0, 300));

    console.log('── an administrator keeps everything that is theirs ──');
    const mixed = readJson(MIXED);
    ok(mixed && !mixed[OURS], 'our entry is gone from the shared policy', JSON.stringify(mixed));
    ok(mixed && mixed[FOREIGN] && mixed[FOREIGN].update_url === STORE,
       "the admin's entry is untouched", JSON.stringify(mixed));
    ok(mixed && Object.keys(mixed).length === 1, 'and nothing was invented',
       JSON.stringify(mixed));

    const leg = readJson(LEG);
    ok(leg && !leg[LEGACY] && leg[FOREIGN],
       "the old installer's fake id is removed by id alone", JSON.stringify(leg));

    console.log('── the value itself goes when ours was all of it ──');
    ok(readJson(ONLY) === null, 'ExtensionSettings deleted, not left as {}',
       JSON.stringify(readJson(ONLY)));

    console.log('── a policy with nothing of ours is not rewritten ──');
    ok(JSON.stringify(readJson(THEIRS)) === theirsBefore,
       'byte-identical afterwards', JSON.stringify(readJson(THEIRS)));

    console.log('── the forcelist half still works ──');
    const fl = sh(`reg query "${FL}"`) || '';
    ok(!fl.includes(OURS), 'our numbered slot is gone', fl.replace(/\s+/g, ' ').slice(0, 200));
    ok(fl.includes(FOREIGN), 'the workplace slot is still there');
    ok(sh(`reg query "${MIXED}" /v DnsOverHttpsMode`) === null,
       'the rest of the loop still ran -- DnsOverHttpsMode was stripped');

    console.log('── route 4: the allowlist, where the value proves nothing ──');
    const alMixed = sh(`reg query "${AL_MIXED}"`) || '';
    ok(!alMixed.includes(OURS), 'our allowlist slot is gone',
       alMixed.replace(/\s+/g, ' ').slice(0, 200));
    ok(alMixed.includes(FOREIGN), "the workplace's allowed id is still there");
    ok(keyExists(AL_MIXED), 'and the allowlist key survives, because theirs is still in it');
    ok(!keyExists(AL_ONLY),
       'an allowlist that held only ours is removed, (Default) discounted');
    const alAlien = sh(`reg query "${AL_ALIEN}"`) || '';
    ok(alAlien.includes(ADMINS),
       'an id of our exact shape that this machine serves NOWHERE survives -- ' +
       'no loopback entry named it, so it was never ours to remove');
    ok(/removed extension-allowlist entry/.test(out),
       'and the allowlist half said so, so a silent no-op cannot pass either');

    console.log('── the forks own provider: ours only, and only served from here ──');
    ok(!keyExists(V_OURS + '\\' + OURS), 'our vendor-level entry is gone');
    ok(!keyExists(V_CHR + '\\' + OURS), 'our product-level entry is gone');
    ok(!keyExists(V_FORK + '\\' + OURS), 'our entry one level deeper is gone too');
    ok(!keyExists(V_VAL + '\\' + OURS), 'and the one sharing a key with a value of theirs');
    ok(keyExists(V_ADMIN + '\\' + ADMINS),
       'a store-served id of exactly our shape SURVIVES -- the shape alone never decides');
    ok(keyExists(V_CHR + '\\' + FOREIGN), "an administrator's own external install survives");
    ok(keyExists(V_CHR + '\\' + NOT_ID),
       'a subkey that is not an id is left alone even when its url is loopback');
    const chrLeft = (subkeys(V_CHR) || []).slice().sort().join(',');
    ok(chrLeft === [FOREIGN, NOT_ID].slice().sort().join(','),
       'the shared key holds exactly the two entries that were not ours', chrLeft);
    ok(/removed external-extensions entry/.test(out),
       'and it said so, so a silent no-op cannot pass this test');

    console.log('── the Extensions key goes only when emptying it was our doing ──');
    ok(!keyExists(V_OURS),
       'the key our own reg add created on the way to our id is gone -- (Default) and all');
    ok(!keyExists(V_FORK), 'the same one level deeper, deleted by relative path');
    ok(keyExists(V_CHR), 'a key still holding their entry stays');
    ok(keyExists(V_VAL), 'and so does one still holding a value of theirs');
    ok(keyExists(V_ADMIN), 'a key we never wrote into is untouched');

    console.log('── and the vendor above it is never ours to remove ──');
    ok(keyExists(EXT_ROOT + '\\VendorV'), 'the vendor key stays even when emptied');
    ok(keyExists(EXT_ROOT + '\\VendorX\\Fork'), 'so does the product key');
    ok(keyExists(EXT_ROOT + '\\Google\\Chrome'), 'and a real fork name is never pruned');

    console.log('── run it twice: an uninstall retried must be a no-op ──');
    const run2 = runSweep();
    run2.err.split(/\r?\n/).filter(Boolean).forEach(l => console.log('   ps!: ' + l));
    ok(run2.err.trim() === '', 'the second pass errors nowhere either',
       run2.err.replace(/\s+/g, ' ').slice(0, 300));
    ok(!/removed external-extensions entry/.test(run2.out),
       'it found nothing left of ours to remove', run2.out.replace(/\s+/g, ' ').slice(0, 200));
    ok(keyExists(V_ADMIN + '\\' + ADMINS) && keyExists(V_CHR + '\\' + FOREIGN) &&
       keyExists(V_CHR + '\\' + NOT_ID) && keyExists(V_VAL),
       'and every survivor survived the second pass as well');

    sh(`reg delete "${ROOT}" /f`);
    ok(sh(`reg query "${ROOT}"`) === null, 'test hive removed');
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}

    console.log(`\n${pass}/${pass + fail} checks passed`);
    process.exit(fail ? 1 : 0);
})().catch(e => {
    console.log('ABORT: ' + e.stack);
    sh(`reg delete "${ROOT}" /f`);
    process.exit(3);
});
