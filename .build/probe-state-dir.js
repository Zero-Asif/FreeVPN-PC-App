'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/probe-state-dir.js
//
//  C:\ProgramData\freeproxy-vpn is where this app keeps tor.exe,
//  lyrebird.exe and the eight .bat files it runs through cmd.exe -- and it
//  runs all of them ELEVATED (main.js relaunches itself with RunAs and the
//  boot task runs as SYSTEM). MEASURED on this machine, 2026-09-04:
//
//    C:\ProgramData\freeproxy-vpn  BUILTIN\Users:(I)(CI)(WD,AD,WEA,WA)
//                                  CREATOR OWNER:(I)(OI)(CI)(IO)(F)
//
//  On a directory WD is "add file". So any local standard user could create
//  <state>\Tor\tor\tor.exe, and setupWritableTor() copied the real bundle
//  only `if (!existsSync(dst))` -- it would have logged "Tor bundle already
//  present" and launched theirs with an administrator token. Confirmed by
//  creating exactly that path from an UNELEVATED shell under a rehearsal
//  directory: icacls reported `DESKTOP-5K3EJBM\User pc:(I)(F)` on the file.
//
//  Three things had to become true, and this file checks each of them
//  separately, because they fail separately:
//
//    1. THE DECISION. exposures() must call the measured ACL dangerous and
//       the hardened one clean -- read out of lib/state-dir.js, against the
//       real SDDL strings, with no icacls involved. If this is wrong the app
//       either hardens forever or never notices.
//    2. THE FIX. /reset /T -> /inheritance:r /grant:r -> /setowner, run for
//       real on a temp tree with a planted file in it, and READ BACK.
//    3. THE WIRING. secureStateDir() ahead of every other startup step;
//       setupWritableTor() taking wasExposed and hashing the bundle when it
//       is set; runBat() unlinking before it writes.
//
//  WHAT THIS CANNOT VERIFY, stated rather than glossed. MEASURED here at
//  Medium integrity with BUILTIN\Administrators marked "for deny only" -- an
//  UNELEVATED shell -- and all three icacls steps still succeeded, /setowner
//  included. That is not elevation working: this process CREATED the temp
//  tree, so it holds WRITE_OWNER on it implicitly, and setting the owner to a
//  group that is in your own token needs nothing more. On
//  C:\ProgramData\freeproxy-vpn after someone else has planted a file there,
//  the owner of that file is THEM -- and taking it needs the administrator
//  token the app runs under. So what is proven here is the sequence, the
//  read-back and the verdict; what is not is /setowner against an object this
//  user does not own. Section 6 prints which of the two it measured.
//  Nothing here touches C:\ProgramData\freeproxy-vpn itself -- it works in a
//  temp tree, and deletes it.
// ════════════════════════════════════════════════════════════════════
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const SD   = require('../lib/state-dir.js');

const ROOT = path.join(__dirname, '..');
const MAIN = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');

let pass = 0, fail = 0, skip = 0;
const ok = (c, m, x) => {
    if (c) { pass++; console.log('  ok   ' + m); }
    else { fail++; console.log('  FAIL ' + m + (x ? '\n         ' + String(x) : '')); }
};
const note = (m, x) => { skip++; console.log('  ---- ' + m + (x ? '\n         ' + String(x) : '')); };

// ── The three measured SDDL strings ─────────────────────────────────
//  BEFORE is C:\ProgramData\freeproxy-vpn as it shipped; AFTER is the same
//  directory once hardenTree() has run; LEAF is what a file inside it looks
//  like afterwards -- inherited, and therefore not protected, which is why
//  the protection test is applied to the root ONLY.
const BEFORE = 'D:AI(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)(A;OICIIOID;GA;;;CO)' +
               '(A;OICIID;0x1200a9;;;BU)(A;CIID;DCLCRPCR;;;BU)';
const AFTER  = 'D:PAI(A;OICI;0x1200a9;;;AU)(A;OICI;FA;;;BA)(A;OICI;FA;;;SY)';
const LEAF   = 'D:AI(A;ID;0x1200a9;;;AU)(A;ID;FA;;;BA)(A;ID;FA;;;SY)';

console.log('── 1. the rights table, against icacls\'s own arithmetic ──');
{
    //  icacls printed (WD,AD,WEA,WA) for the mask SDDL renders as DCLCRPCR.
    //  WD|AD|WEA|WA is 0x2|0x4|0x10|0x100. If this table drifts, every
    //  decision below is made on the wrong number and nothing says so.
    ok(SD.parseRights('DCLCRPCR') === 0x116,
       'DCLCRPCR is 0x116 -- FILE_WRITE_DATA|APPEND|WRITE_EA|WRITE_ATTRIBUTES',
       '0x' + SD.parseRights('DCLCRPCR').toString(16));
    ok(SD.parseRights('0x1200a9') === SD.READ_MASK,
       'and 0x1200a9 is exactly the read+execute mask icacls writes for (RX)');
    ok(SD.parseRights('FA') === 0x001f01ff, 'FA is FILE_ALL_ACCESS');
    ok((0x116 & ~SD.READ_MASK) !== 0,
       'add-file is NOT a subset of read+execute -- which is what makes the ' +
       'measured ACL an escalation rather than a nuisance');
    ok(SD.parseRights('ZZ') === null && SD.parseRights('') === null &&
       SD.parseRights('DCL') === null,
       'an unknown or odd-length rights field parses as null, never as 0');
}

console.log('\n── 2. the decision, on the ACL that was actually measured ──');
{
    const before = SD.parseSddl(BEFORE);
    const after  = SD.parseSddl(AFTER);
    const leaf   = SD.parseSddl(LEAF);
    ok(before && before.aces.length === 5, 'the shipped DACL parses to five aces',
       before && before.aces.length);
    ok(SD.isProtected(before) === false,
       'it is NOT protected -- every ace in it is inherited from C:\\ProgramData');
    const ex = SD.exposures(before);
    ok(ex.length === 2, 'and two of the five are exposures', JSON.stringify(ex));
    ok(ex.some(e => e.sid === 'BU' && /create or overwrite/.test(e.why)),
       'BUILTIN\\Users is reported as able to create files here',
       JSON.stringify(ex));
    ok(ex.some(e => e.sid === 'CO' && e.why === 'full control'),
       'and CREATOR OWNER as full control -- what they make, they keep');
    //  The bug this test exists for: `extra & FA` matches 0x116, because every
    //  file right is a subset of FILE_ALL_ACCESS. Add-file must not be
    //  described to the user as full control.
    ok(SD.exposures(SD.parseSddl('D:AI(A;CIID;DCLCRPCR;;;BU)'))[0].why !== 'full control',
       'add-file alone is NOT described as full control');

    ok(SD.isProtected(after) === true, 'the hardened root reads as protected');
    ok(SD.exposures(after).length === 0,
       'and has no exposures at all: SY and BA full, AU read+execute',
       JSON.stringify(SD.exposures(after)));
    ok(SD.exposures(leaf).length === 0,
       'a file inside it has no exposures either -- the three aces propagated');
    ok(SD.isProtected(leaf) === false,
       'while the FILE is not protected, which is correct and is why only the ' +
       'root is tested for it');

    //  Fail-safe, in both directions.
    ok(SD.exposures(null).length === 1 && /could not be parsed/.test(SD.exposures(null)[0].why),
       'an unparseable DACL counts as exposed, never as empty-and-harmless');
    ok(SD.exposures(SD.parseSddl('D:PAI(A;OICI;WOWDSD;;;AU)')).length === 1,
       'WRITE_OWNER/WRITE_DAC/DELETE to Authenticated Users is an exposure ' +
       'even with no write-data bit -- taking ownership is how you grant ' +
       'yourself the write-data bit');
    ok(SD.exposures(SD.parseSddl('D:PAI(D;OICI;FA;;;WD)')).length === 0,
       'a DENY ace is not an exposure -- a deny cannot grant');
    ok(SD.exposures(SD.parseSddl('D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)')).length === 0,
       'SYSTEM and Administrators with full control are not exposures; they are ' +
       'the point');
    ok(SD.exposures(SD.parseSddl('D:PAI(A;OICI;0xdeadbe;;;AU)')).length === 1,
       'and a mask this file has no name for is still reported, by number');
}

console.log('\n── 3. the save-file format icacls actually writes ──');
{
    //  UTF-16LE with a BOM, pairs of lines: relative name, then SDDL. Built
    //  from character codes rather than a literal BOM in this source, for the
    //  same reason lib/state-dir.js does not contain one either.
    const BOM = String.fromCharCode(0xFEFF);
    const text = BOM + ['freeproxy-vpn', AFTER, 'freeproxy-vpn\\Tor\\tor\\tor.exe', LEAF]
        .join('\r\n') + '\r\n';
    const objs = SD.parseSaveFile(text);
    ok(objs.length === 2, 'two objects out of four lines', objs.length);
    ok(objs[0].name === 'freeproxy-vpn' && objs[0].sddl === AFTER,
       'the ROOT is first, which is what secureStateDir() relies on');
    ok(objs[1].name.endsWith('tor.exe') && objs[1].sddl === LEAF,
       'and the leaf keeps its relative path, so a failure can name the file');
    ok(SD.parseSaveFile(BOM + '').length === 0, 'an empty save file yields nothing');
    ok(SD.parseSaveFile(BOM + 'only-a-name\r\n').length === 0,
       'and a half-written pair is dropped rather than read as an empty DACL');
    ok(JSON.stringify(SD.parseSaveFile(text)) ===
       JSON.stringify(SD.parseSaveFile(text.slice(1))),
       'the BOM is stripped, and its absence changes nothing');
}

console.log('\n── 4. what it asks icacls for ──');
{
    //  hardenTree with a recording stub. The ORDER is the part that was
    //  rehearsed and the part that matters: protecting the root does not touch
    //  an explicit ace a standard user already owns on a file they created, so
    //  /reset /T has to come first.
    const seen = [];
    const runner = (exe, args) => { seen.push(args.join(' ')); return ''; };
    const steps = SD.hardenTree('C:\\nope', runner);
    ok(seen.length === 3 && steps.length === 3, 'three icacls calls, no more',
       seen.join('  |  '));
    ok(/\/reset/.test(seen[0]) && /\/T/.test(seen[0]) && /\/C/.test(seen[0]),
       '1. /reset /T /C -- children first, or their explicit aces survive',
       seen[0]);
    ok(/\/inheritance:r/.test(seen[1]) && /\/grant:r/.test(seen[1]),
       '2. /inheritance:r /grant:r on the root', seen[1]);
    ok(/\/setowner/.test(seen[2]) && /\/T/.test(seen[2]),
       '3. /setowner /T -- an owner implicitly holds WRITE_DAC, so leaving a ' +
       'standard user owning the tree leaves them able to grant themselves back in',
       seen[2]);
    ok(seen.indexOf(seen.find(s => /\/reset/.test(s))) === 0,
       'and /reset is genuinely first, not merely present');
    ok(SD.HARDEN_GRANTS.every(g => /^\*S-1-5-/.test(g)),
       'every grant names a SID, not a name -- BUILTIN\\Users is localised and ' +
       'this app ships worldwide', SD.HARDEN_GRANTS.join(' '));
    ok(SD.HARDEN_GRANTS.includes('*S-1-5-11:(OI)(CI)RX'),
       'the read grant goes to Authenticated Users (S-1-5-11), which excludes ' +
       'ANONYMOUS LOGON and Guest and excludes nothing this app needs');
    ok(!SD.HARDEN_GRANTS.some(g => /S-1-5-32-545/.test(g)),
       'and NOT to Users (S-1-5-32-545)');
    ok(!SD.TRUSTED_SIDS.has('AU') && !SD.TRUSTED_SIDS.has('BU') &&
       SD.TRUSTED_SIDS.has('SY') && SD.TRUSTED_SIDS.has('BA'),
       'only SYSTEM and Administrators are trusted to hold more than read+execute');
}

console.log('\n── 5. a directory that is not there, and a platform that is not Windows ──');
{
    const r = SD.secureStateDir(path.join(os.tmpdir(), 'fp-does-not-exist-' + process.pid));
    ok(r.ok === false && r.error === 'no such directory',
       'a missing directory is reported, not hardened into existence');
    ok(r.hardened === false && r.wasExposed === false,
       'and nothing is claimed about it');
    const thrower = () => { throw new Error('icacls is not on this machine'); };
    const t = SD.secureStateDir(ROOT, { run: thrower });
    ok(t.ok === false,
       'an icacls that cannot run at all reports ok:false rather than throwing ' +
       'out of the startup sequence', JSON.stringify(t).slice(0, 160));
}

console.log('\n── 6. the fix, for real, on a temp tree ──');
if (process.platform !== 'win32') {
    note('not Windows -- sections 6 is Windows-only');
} else {
    //  Which token is this? It decides what section 6 is allowed to claim about
    //  the /setowner leg, so it is read rather than assumed.
    let elevated = null;
    try {
        const groups = execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows',
                                              'System32', 'whoami.exe'),
                                    ['/groups', '/fo', 'csv'],
                                    { encoding: 'utf8', windowsHide: true });
        //  S-1-16-12288 is High, 16384 System. Administrators marked "for deny
        //  only" is the UAC-split token: a member of the group who is not
        //  currently using it.
        elevated = /S-1-16-(12288|16384)/.test(groups);
    } catch (e) {}
    console.log('  info this shell is ' +
                (elevated === null ? 'of an integrity level that could not be read'
                 : elevated ? 'ELEVATED (high integrity)'
                            : 'UNELEVATED (medium integrity)'));

    //  A planted file at the same relative path the real attack would use, so
    //  the read-back is asked the same question the app asks.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-statedir-'));
    const dir = path.join(tmp, 'freeproxy-vpn');
    const plant = path.join(dir, 'Tor', 'tor');
    fs.mkdirSync(plant, { recursive: true });
    fs.writeFileSync(path.join(plant, 'tor.exe'), 'not tor', 'utf8');
    fs.writeFileSync(path.join(dir, 'fp_conn.bat'), '@echo off', 'utf8');

    //  A temp directory does NOT inherit ProgramData's ACL, so it is made
    //  exposed on purpose first -- otherwise this section would be testing a
    //  tree that was already clean.
    let planted = false;
    try {
        execFileSync('icacls.exe', [dir, '/grant', '*S-1-5-11:(OI)(CI)F', '/T', '/C', '/Q'],
                     { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        planted = true;
    } catch (e) { note('could not plant a writable ace: ' + e.message); }

    if (planted) {
        const before = SD.readTree(dir);
        const bex = SD.exposures(SD.parseSddl(before.objects[0] && before.objects[0].sddl));
        ok(bex.length > 0,
           'the planted tree reads as exposed before anything is done to it',
           JSON.stringify(bex));

        const lines = [];
        const L = { debug: m => lines.push('debug ' + m), info: m => lines.push('info ' + m),
                    warn: m => lines.push('warn ' + m), error: m => lines.push('error ' + m),
                    success: m => lines.push('ok ' + m) };
        const res = SD.secureStateDir(dir, { log: L });

        ok(res.wasExposed === true,
           'secureStateDir reports wasExposed -- the ONE signal that cannot be ' +
           'recovered after the fix, and the one setupWritableTor() gates on');
        ok(res.hardened === true, 'and that it ran the three steps');
        ok(res.checked >= 4,
           'the read-back covered the whole tree, not just the root ' +
           `(${res.checked} objects)`);
        ok(lines.some(l => /^warn /.test(l)),
           'the exposure was logged as a warning before it was fixed');

        const owner = res.steps.find(s => s.name === 'setowner');
        const reset = res.steps.find(s => s.name === 'reset');
        const grant = res.steps.find(s => s.name === 'grant');
        ok(reset && reset.ok, 'icacls /reset /T succeeded', reset && reset.out);
        ok(grant && grant.ok, 'icacls /inheritance:r /grant:r succeeded', grant && grant.out);

        //  Read back independently of secureStateDir's own verdict: the app is
        //  not allowed to be the only witness to its own success.
        const after = SD.readTree(dir, { recursive: true });
        const root  = SD.parseSddl(after.objects[0] && after.objects[0].sddl);
        ok(SD.isProtected(root) === true,
           'read back independently: the root no longer inherits');
        const stillBad = after.objects
            .map(o => ({ name: o.name, ex: SD.exposures(SD.parseSddl(o.sddl)) }))
            .filter(o => o.ex.length);
        ok(stillBad.length === 0,
           `and not one of the ${after.objects.length} objects is writable by ` +
           'anyone but SYSTEM and Administrators -- including the planted ' +
           'Tor\\tor\\tor.exe, whose explicit ace /reset removed',
           JSON.stringify(stillBad).slice(0, 300));
        ok(after.objects.some(o => /tor\.exe$/i.test(o.name)),
           'the planted file really was in the read-back, so the line above is ' +
           'a statement about it', after.objects.map(o => o.name).join(' | '));

        if (owner && owner.ok) {
            ok(res.ok === true,
               'and with ownership taken as well, secureStateDir reports ok');
            ok(lines.some(l => /owned by Administrators/.test(l)),
               'saying so, because ownership is the part /save cannot read back');
            if (!elevated) {
                note('/setowner succeeded from an UNELEVATED shell, which proves ' +
                     'the sequence and the read-back but NOT the case that ' +
                     'matters most: this process created the temp tree, so it ' +
                     'holds WRITE_OWNER on it implicitly. Taking ownership of a ' +
                     'file a DIFFERENT user planted is what needs the ' +
                     "administrator token the app itself runs under, and that " +
                     'is not exercised here.');
            }
        } else {
            note('icacls /setowner FAILED -- expected from an unelevated shell. ' +
                 'This leg is NOT VERIFIED here; re-run this probe elevated.',
                 owner && owner.out);
            ok(res.ok === false,
               'and secureStateDir correctly refuses to report ok when ownership ' +
               'was not taken -- the current owner holds WRITE_DAC implicitly');
            ok(lines.some(l => /ownership was NOT taken/.test(l.replace(/\s+/g, ' '))),
               'and says which half failed rather than reporting success',
               lines.filter(l => /^error/.test(l)).join(' | ').slice(0, 200));
        }

        //  The cheap path: a second call must cost one icacls and no writes.
        let calls = 0;
        const counting = (exe, args) => {
            calls++;
            return execFileSync(exe, args, { windowsHide: true, encoding: 'utf8',
                                             stdio: ['ignore', 'pipe', 'pipe'] });
        };
        const again = SD.secureStateDir(dir, { log: L, run: counting });
        if (owner && owner.ok) {
            ok(again.wasExposed === false && again.hardened === false && again.ok === true,
               'a second start finds it already locked down and does nothing');
            ok(calls === 1,
               'at the cost of exactly one icacls -- the root DACL, no /T walk',
               String(calls));
            ok(again.checked === 1, 'and it says so: one object checked');
        } else {
            note('the re-check cannot be tested unelevated either: without ' +
                 '/setowner the tree is left owned by this user, and an owner ' +
                 'is not an ace, so exposures() correctly still sees nothing ' +
                 'wrong with the DACL while the tree is still not safe.');
        }

        //  Best-effort cleanup. If /setowner succeeded, Administrators own this
        //  tree and an unelevated shell cannot delete it -- which is exactly the
        //  property being tested, so a leftover directory in TEMP is reported
        //  rather than worked around.
        try {
            execFileSync('icacls.exe', [dir, '/grant', '*S-1-5-11:(OI)(CI)F', '/T', '/C', '/Q'],
                         { windowsHide: true, encoding: 'utf8', stdio: 'ignore' });
        } catch (e) {}
        try { fs.rmSync(tmp, { recursive: true, force: true }); }
        catch (e) { note('temp tree left behind (this is the fix working): ' + tmp); }
    } else {
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
    }
}

console.log('\n── 7. the wiring in main.js ──');
{
    ok(/require\('\.\/lib\/state-dir'\)/.test(MAIN),
       'main.js requires the module -- without this everything above is dead code');
    const seq = MAIN.indexOf('// ── Startup sequence ─');
    ok(seq > 0, 'the startup sequence is still marked');
    //  As far as the next marker, not a fixed number of characters: the block
    //  is mostly comment and a byte count silently stops covering the tail of
    //  it the moment a line of reasoning is added.
    const end   = MAIN.indexOf('// ── App close ─', seq);
    const block = MAIN.slice(seq, end > seq ? end : seq + 4000);
    //  And with the comments taken OUT before anything is ordered. The comment
    //  above the ACL call names setupWritableTor() and startupCleanup() in
    //  prose, ahead of the statements themselves -- indexing the raw text
    //  reported "setupWritableTor comes first" about a sentence.
    const tail = block.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
    const iAcl   = tail.indexOf('secureStateDir(');
    const iClean = tail.indexOf('startupCleanup();');
    const iTor   = tail.indexOf('setupWritableTor(');
    const iLayers= tail.indexOf('setupWholeMachineLayers();');
    const iWin   = tail.indexOf('createWindow();');
    ok(iAcl > 0, 'secureStateDir is called in it');
    ok(iClean > 0 && iTor > 0 && iLayers > 0 && iWin > 0,
       'and the whole sequence is in view, so the ordering checks below are ' +
       'about statements that were actually found',
       `clean@${iClean} tor@${iTor} layers@${iLayers} window@${iWin}`);
    ok(iAcl < iClean,
       'BEFORE startupCleanup(), which writes and then executes ' +
       'fp_startup_clean.bat out of the directory being hardened',
       `acl@${iAcl} clean@${iClean}`);
    ok(iAcl < iTor && iAcl < iLayers && iAcl < iWin,
       'and before the Tor bundle, the firewall layers and the window -- it is ' +
       'the first statement of the sequence');
    ok(/const acl = secureStateDir\(app\.getPath\('userData'\)/.test(tail),
       'it hardens app.getPath(\'userData\') rather than the APPDATA_PATH ' +
       'constant, so a machine where the setPath fell back is not left ' +
       'hardening a directory it is not using');
    ok(/setupWritableTor\(\{ verify: acl\.wasExposed \}\)/.test(tail),
       'and wasExposed is handed to setupWritableTor -- the bundle is hashed on ' +
       'exactly the starts where a tor.exe already on disk may not be ours',
       tail.slice(iTor, iTor + 60));
}

console.log('\n── 8. setupWritableTor no longer trusts existsSync alone ──');
{
    const at = MAIN.indexOf('function setupWritableTor(');
    ok(at > 0, 'setupWritableTor is still there');
    const fn = MAIN.slice(at, MAIN.indexOf('\n    }', MAIN.indexOf('torDir = path.join(dst', at)));
    ok(/function setupWritableTor\(\{ verify = false \} = \{\}\) \{/.test(MAIN.slice(at, at + 80)),
       'it takes a verify flag, defaulting to false so the 1 s hash is not paid ' +
       'on every start', MAIN.slice(at, at + 60));
    ok(/\} else if \(verify\) \{/.test(fn),
       'and the verify branch sits where the bare "already present" debug line ' +
       'used to be');
    ok(/bundleDiff\(src, dst\)/.test(fn), 'it diffs the bundle');
    ok(/fs\.rmSync\(dst, \{ recursive: true, force: true \}\)[\s\S]{0,200}fs\.cpSync\(src, dst/.test(fn),
       'replaces the whole directory on a mismatch rather than patching files ' +
       'inside a tree it has just called untrustworthy');
    ok(/const again = bundleDiff\(src, dst\)/.test(fn),
       'and diffs it AGAIN afterwards, so "replaced" is a read-back and not a ' +
       'claim');
    const bd = MAIN.indexOf('function bundleDiff(');
    ok(bd > 0 && bd < at, 'bundleDiff is defined above it');
    const bdFn = MAIN.slice(bd, at);
    ok(/createHash\('sha256'\)/.test(bdFn),
       'the comparison is a SHA-256 of the contents, not a size or an mtime');
    ok(/not part of the bundle/.test(bdFn),
       'and an EXTRA file under Tor\\tor is a finding -- that directory ships ' +
       'four files and gains none at runtime, so an unexpected .dll beside ' +
       'tor.exe is a DLL-planting attack');
    ok(/rel === 'tor' \|\| rel\.startsWith\('tor' \+ path\.sep\)/.test(bdFn),
       'while extras elsewhere are tolerated, because Tor\\data is tor\'s own ' +
       'writable DataDirectory and fills up with cached descriptors');
}

console.log('\n── 9. the hard-link overwrite on the eight .bat files ──');
{
    //  writeFileSync writes THROUGH a hard link. Until the ACL was fixed, any
    //  local user could create one of these .bat names as a hard link to a file
    //  they cannot write and this elevated process can.
    const at = MAIN.indexOf('function runBat(');
    ok(at > 0, 'runBat is still the one writer');
    const fn = MAIN.slice(at, at + 3000);
    const iRm = fn.indexOf('fs.rmSync(filePath');
    const iWr = fn.indexOf('fs.writeFileSync(filePath');
    ok(iRm > 0 && iWr > 0 && iRm < iWr,
       'the path is unlinked BEFORE it is written -- unlinking removes the ' +
       'directory entry and leaves a link target alone, so what gets written ' +
       'is always a new file this process owns', `rm@${iRm} write@${iWr}`);
    ok(/hard link/i.test(fn.slice(Math.max(0, iRm - 900), iRm)),
       'and the reason is recorded at the line, so it is not tidied away later');
}

console.log('\n── 10. a locked-down log directory must not kill the elevation ──');
{
    //  Logger.init is the first thing whenReady() does, in BOTH copies of the
    //  app -- including the unelevated one whose only job is to relaunch with
    //  RunAs. A throw there becomes an unhandled rejection inside
    //  whenReady().then() and the elevation is never requested: the app appears
    //  to start and then does nothing at all.
    const at = MAIN.indexOf('function init(ud) {');
    ok(at > 0, 'Logger.init is still there');
    const fn = MAIN.slice(at, at + 1600);
    ok(/try \{[\s\S]{0,200}mkdirSync\(logDir/.test(fn),
       'the mkdir is inside a try');
    ok(/logDir = ''; logFile = '';/.test(fn),
       'and a failure blanks both paths and returns rather than propagating');
    const w = MAIN.indexOf('if (logFile) { try { fs.appendFileSync(logFile, line); }');
    ok(w > 0, 'write() tolerates a log file it cannot append to');
    ok(/if \(!logDir\) return;[\s\S]{0,200}const nf = path\.join\(logDir,/
       .test(MAIN.slice(w, w + 700)),
       'and the midnight rollover is skipped when there is no log directory -- ' +
       "path.join('', name) is RELATIVE, so writing it would drop a log file in " +
       'whatever the working directory happens to be');
}

console.log('\n── 11. the cached fingerprints that reach an elevated torrc ──');
{
    const ES = require('../lib/exit-selector.js');
    const good = { fp: 'A'.repeat(40), nick: 'relay1', ip: '185.1.2.3',
                   hasV6: false, bw: 1e6, exitProb: 0.01, fast: true, stable: true };
    ok(ES.badCandidate(good) === null, 'a candidate as refresh() builds it is accepted');
    ok(ES.badCandidate({ ...good, fp: 'A'.repeat(40) + '\nLog notice file C:\\poc.txt' }),
       'a fingerprint with a newline in it is refused -- torrc is line-oriented ' +
       'and `ExitNodes $<fp>` would carry the extra line into the config of a ' +
       'process running as administrator');
    ok(ES.badCandidate({ ...good, fp: 'A'.repeat(40) + '"' }),
       'and one with a quote in it, which would close SETCONF\'s quoted value');
    ok(ES.badCandidate({ ...good, fp: 'g'.repeat(40) }), 'non-hex is refused');
    ok(ES.badCandidate({ ...good, fp: 'A'.repeat(39) }) &&
       ES.badCandidate({ ...good, fp: 'A'.repeat(41) }),
       'and so is the wrong length, either way');
    ok(ES.badCandidate({ ...good, ip: '1.2.3.999' }) &&
       ES.badCandidate({ ...good, ip: '1.2.3' }) &&
       ES.badCandidate({ ...good, ip: '1.2.3.4 && calc' }),
       'the address must be a real dotted quad');
    ok(ES.badCandidate({ ...good, nick: 'a\r\nb' }),
       'a control character in the nickname is refused -- it reaches the log, ' +
       'and a log a viewer can be lied to about is not a log');
    ok(ES.badCandidate({ ...good, bw: '1000000' }) &&
       ES.badCandidate({ ...good, bw: NaN }) &&
       ES.badCandidate({ ...good, exitProb: 7 }),
       'the numbers must be numbers, and a probability must be a probability');
    ok(ES.badCandidate({ ...good, fast: 'yes' }), 'and the flags must be booleans');
    ok(ES.badCandidate({ ...good, extra: 1 }),
       'an unexpected field is refused too, so a key added to the file by ' +
       'something other than save() surfaces instead of riding along');
    ok(ES.badByCountry({ lu: [good] }) === null &&
       ES.badByCountry({ 'lu/../..': [good] }) &&
       ES.badByCountry({ lu: good }),
       'and the country keys are two letters, holding lists');

    ok(ES.badVerified({ lu: { fp: 'A'.repeat(40), nick: 'x', ip: null,
                              verifiedAt: 1 } }) === null,
       'exit-cache.json accepts a verified record with no address -- ' +
       'probeExitLocation can confirm a country without returning one');
    ok(ES.badVerified({ lu: { fp: 'A'.repeat(40) + '\nBad', nick: 'x', ip: null,
                              verifiedAt: 1 } }),
       'but not a poisoned fingerprint, which is pinned ahead of every live ' +
       'candidate at main.js:3906');
    ok(ES.badRejected({ lu: { ['fp:' + 'A'.repeat(40)]: 1, 'net:104.244': 2 } }) === null &&
       ES.badRejected({ lu: { 'fp:short': 1 } }) &&
       ES.badRejected({ lu: { 'net:104.999': 1 } }),
       'and the reject buckets hold only the two key shapes reject() writes');
}

console.log(`\n${pass}/${pass + fail} checks passed` +
            (skip ? `  (${skip} not verified here -- see the ---- lines)` : '') +
            (fail ? `  (${fail} FAILED)` : ''));
process.exit(fail ? 1 : 0);
