'use strict';
// ════════════════════════════════════════════════════════════════════
//  lib/state-dir.js  --  making C:\ProgramData\freeproxy-vpn safe to
//                        execute out of.
//
//  MEASURED, on this machine, 2026-09-04:
//
//    C:\ProgramData\freeproxy-vpn
//      D:AI(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)(A;OICIIOID;GA;;;CO)
//        (A;OICIID;0x1200a9;;;BU)(A;CIID;DCLCRPCR;;;BU)
//
//  Every one of those ACEs is inherited (ID) from C:\ProgramData, and the
//  last two are the problem:
//
//    (A;CIID;DCLCRPCR;;;BU)      BUILTIN\Users, container-inherit:
//                                DC|LC|RP|CR = 0x116 = FILE_WRITE_DATA |
//                                FILE_APPEND_DATA | WRITE_EA | WRITE_ATTRIBUTES.
//                                On a directory, WRITE_DATA *is* "add file".
//                                So ANY local user can create files and
//                                folders anywhere in this tree.
//    (A;OICIIOID;GA;;;CO)        CREATOR OWNER, GENERIC_ALL: and whatever they
//                                create, they own with full control, for good.
//
//  Verified rather than reasoned about: an UNELEVATED shell created
//  C:\ProgramData\fp-acl-rehearsal\Tor\tor\tor.exe and icacls reported
//  `DESKTOP-5K3EJBM\User pc:(I)(F)` on it -- full control, to a standard user,
//  on a file at exactly the path this app executes from.
//
//  Why that is a privilege escalation and not just untidy: this app runs
//  elevated (main.js re-launches itself with RunAs and does all its work in
//  that copy) and the boot task runs as SYSTEM. Out of that directory it runs
//    * <dir>\Tor\tor\tor.exe and <dir>\Tor\tor\pluggable_transports\lyrebird.exe
//    * eight generated .bat files, through cmd.exe
//  and setupWritableTor() copies the Tor bundle only `if (!existsSync(dst))`.
//  A standard user who creates <dir>\Tor first therefore chooses the tor.exe
//  that an administrator's next launch executes. No race, no timing: the app
//  logs "Tor bundle already present" and runs it.
//
//  WHAT THIS MODULE DOES
//    1. reads the DACL as SDDL -- SIDs, not names, because BUILTIN\Users is
//       localised and this app ships worldwide;
//    2. if any ACE grants more than read+execute to anyone but SYSTEM and
//       Administrators, resets the whole tree, protects the directory from
//       inheritance, re-grants the three ACEs it wants, and takes ownership;
//    3. reads the whole tree back and says whether it worked. Nothing here
//       reports success it did not read back -- a hardening that quietly did
//       nothing is worse than none, because the app would trust the tree.
// ════════════════════════════════════════════════════════════════════
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

//  SIDs, never names. S-1-5-11 (Authenticated Users) rather than S-1-5-32-545
//  (Users) for the read grant: Users excludes nothing this app needs and
//  Authenticated Users excludes ANONYMOUS LOGON and Guest, which it does not.
const SID_SYSTEM = 'S-1-5-18';
const SID_ADMINS = 'S-1-5-32-544';
const SID_AUTHED = 'S-1-5-11';

//  The two SDDL aliases icacls prints for the SIDs above, plus the SIDs
//  themselves -- a read-back may render either form.
const TRUSTED_SIDS = new Set([SID_SYSTEM, SID_ADMINS, 'SY', 'BA']);

//  READ_CONTROL | SYNCHRONIZE | READ_DATA | READ_EA | EXECUTE | READ_ATTRIBUTES.
//  Exactly what icacls writes for (RX) and exactly what this app's unelevated
//  half, and any browser reading a delivered file, needs. An allow ACE with a
//  bit outside this mask, held by anyone untrusted, is what "exposed" means.
const READ_MASK = 0x1200a9;

//  Passed to icacls verbatim. (OI)(CI) so files and subdirectories inherit.
const HARDEN_GRANTS = [
    `*${SID_SYSTEM}:(OI)(CI)F`,
    `*${SID_ADMINS}:(OI)(CI)F`,
    `*${SID_AUTHED}:(OI)(CI)RX`,
];

//  ── SDDL rights, as bits ────────────────────────────────────────────
//  One table, confirmed against icacls's own rendering of the ACL above:
//  it printed (WD,AD,WEA,WA) for `DCLCRPCR`, and WD|AD|WEA|WA is
//  0x2|0x4|0x10|0x100 = 0x116 = DC|LC|RP|CR. The mnemonics are shared with
//  Active Directory (DC is "delete child" there) but the VALUES are the same,
//  and values are all this file compares.
const RIGHTS = {
    CC: 0x00000001, DC: 0x00000002, LC: 0x00000004, SW: 0x00000008,
    RP: 0x00000010, WP: 0x00000020, DT: 0x00000040, LO: 0x00000080,
    CR: 0x00000100,
    SD: 0x00010000, RC: 0x00020000, WD: 0x00040000, WO: 0x00080000,
    SY: 0x00100000,
    FA: 0x001f01ff, FR: 0x00120089, FW: 0x00120116, FX: 0x001200a0,
    KA: 0x000f003f, KR: 0x00020019, KW: 0x00020006, KX: 0x00020019,
    GA: 0x10000000, GX: 0x20000000, GW: 0x40000000, GR: 0x80000000,
};

//  A rights field is either hex ("0x1200a9") or a run of two-letter codes
//  ("FA", "DCLCRPCR"). An unknown token returns null, and every caller treats
//  null as DANGEROUS -- an ACE this file cannot read is not an ACE it may
//  declare safe.
function parseRights(s) {
    if (/^0x[0-9a-f]+$/i.test(s)) return parseInt(s, 16);
    if (!/^([A-Z]{2})+$/.test(s)) return null;
    let mask = 0;
    for (let i = 0; i < s.length; i += 2) {
        const bit = RIGHTS[s.slice(i, i + 2)];
        if (bit === undefined) return null;
        mask |= bit;
    }
    return mask;
}

//  ── SDDL ────────────────────────────────────────────────────────────
//  `icacls <dir> /save` writes UTF-16LE pairs of lines: a path relative to the
//  saved root, then that object's SDDL. Only the DACL is saved (measured: no
//  O: or G: field), which is why ownership is SET and its exit code checked
//  rather than read back -- see hardenTree().
//
//    freeproxy-vpn
//    D:PAI(A;OICI;0x1200a9;;;AU)(A;OICI;FA;;;BA)(A;OICI;FA;;;SY)
//    freeproxy-vpn\Tor\tor\tor.exe
//    D:AI(A;ID;0x1200a9;;;AU)(A;ID;FA;;;BA)(A;ID;FA;;;SY)
function parseSaveFile(text) {
    //  icacls writes UTF-16LE, byte-order mark included. Compared by code
    //  point rather than matched with a literal U+FEFF in this source: an
    //  invisible character in a regex is unreviewable in a diff, and the
    //  first tool that normalises the file would delete it silently.
    let s = String(text);
    if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
    const lines = s.split(/\r?\n/).filter(l => l !== '');
    const out = [];
    for (let i = 0; i + 1 < lines.length; i += 2) {
        out.push({ name: lines[i], sddl: lines[i + 1] });
    }
    return out;
}

//  D:PAI(...)(...) -> { control: 'PAI', aces: [...] }. Returns null on
//  anything that is not a DACL, so a caller cannot mistake "unparseable" for
//  "empty, therefore harmless".
function parseSddl(sddl) {
    const m = /^D:([A-Z]*)/.exec(String(sddl || ''));
    if (!m) return null;
    const control = m[1];
    const aces = [];
    //  (type;flags;rights;objectGuid;inheritGuid;sid)
    const re = /\(([^;()]*);([^;()]*);([^;()]*);([^;()]*);([^;()]*);([^;()]*)\)/g;
    let a;
    while ((a = re.exec(sddl)) !== null) {
        aces.push({ type: a[1], flags: a[2], rights: a[3], sid: a[6],
                    mask: parseRights(a[3]) });
    }
    return { control, aces };
}

//  Inheritance blocked. Without this the ProgramData ACEs above come straight
//  back the moment anything re-applies inheritance.
function isProtected(parsed) {
    return !!parsed && /P/.test(parsed.control);
}

//  ── The question this module exists to answer ────────────────────────
//  "Can anyone who is not SYSTEM or an administrator change what is in this
//  directory?" One list, one rule: an ALLOW ace, to an untrusted SID, with any
//  bit outside READ_MASK.
//
//  Deny aces are ignored on purpose. A deny cannot grant, so it cannot be the
//  escalation -- and after hardening nobody untrusted can add one anyway.
//  Unparseable rights count as exposed: see parseRights().
function exposures(parsed) {
    if (!parsed) return [{ sid: '?', rights: '?', why: 'the DACL could not be parsed' }];
    const out = [];
    for (const a of parsed.aces) {
        if (a.type !== 'A' && a.type !== 'AI') continue;      // allow aces only
        if (TRUSTED_SIDS.has(a.sid)) continue;
        if (a.mask === null) {
            out.push({ sid: a.sid, rights: a.rights,
                       why: 'rights this app cannot decode' });
            continue;
        }
        const extra = a.mask & ~READ_MASK;
        if (!extra) continue;
        //  Named where a name helps a log reader decide how bad it is. "Full
        //  control" has to be the WHOLE of FILE_ALL_ACCESS or GENERIC_ALL --
        //  testing `extra & FA` instead calls 0x116 (add-file) full control,
        //  because every file right is a subset of FILE_ALL_ACCESS.
        const full = (a.mask & RIGHTS.GA) ||
                     (a.mask & RIGHTS.FA) === RIGHTS.FA;
        const why = full                      ? 'full control'
                  : (extra & RIGHTS.DC)       ? 'can create or overwrite files here'
                  : (extra & RIGHTS.WD)       ? 'can rewrite the permissions'
                  : (extra & RIGHTS.SD)       ? 'can delete this'
                  : (extra & RIGHTS.DT)       ? 'can delete what is inside'
                  : '0x' + extra.toString(16) + ' beyond read+execute';
        out.push({ sid: a.sid, rights: a.rights, why });
    }
    return out;
}

//  ── icacls ──────────────────────────────────────────────────────────
//  Synchronous, deliberately. This runs once, before startupCleanup() writes
//  the first .bat and before setupWritableTor() decides whether to trust the
//  Tor bundle -- there is nothing useful to do concurrently with it, and an
//  async version would have to hold both of those back anyway. Measured cost
//  on the healthy path: one icacls (~40 ms) and one small file read.
function icacls(args, run) {
    try {
        const out = (run || execFileSync)('icacls.exe', args,
            { windowsHide: true, timeout: 60000, encoding: 'utf8',
              stdio: ['ignore', 'pipe', 'pipe'] });
        return { ok: true, out: String(out || '') };
    } catch (e) {
        return { ok: false, out: String((e && (e.stdout || e.message)) || ''),
                 code: e && e.status };
    }
}

//  Every object in the tree, or just the root. The save file goes in a
//  directory this process creates: a predictable name in a shared temp is a
//  place someone else can put a junction, and this is the one function whose
//  whole job is not to be fooled about permissions.
function readTree(dir, { recursive = false, run } = {}) {
    let tmp = null;
    try {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-acl-'));
        const save = path.join(tmp, 'dacl.txt');
        const args = [dir, '/save', save, '/Q'];
        if (recursive) args.push('/T', '/C');
        const r = icacls(args, run);
        if (!fs.existsSync(save)) return { ok: false, objects: [], out: r.out };
        return { ok: r.ok, out: r.out,
                 objects: parseSaveFile(fs.readFileSync(save, 'utf16le')) };
    } catch (e) {
        return { ok: false, objects: [], out: e.message };
    } finally {
        if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {} }
    }
}

//  ── The fix ─────────────────────────────────────────────────────────
//  Order matters and was rehearsed on a planted tree under C:\ProgramData
//  before being written here:
//
//    1. /reset /T   every object back to pure inheritance. This is what
//                   removes an ACE a standard user already owns on a file they
//                   created -- step 2 alone would leave it in place, because
//                   protecting a parent does not touch a child's EXPLICIT aces.
//                   It briefly leaves the tree inheriting ProgramData's own
//                   permissions, which is what it had all along.
//    2. /inheritance:r /grant:r
//                   the root stops inheriting and gets exactly three aces.
//                   Windows then pushes them down: measured, the planted
//                   tor.exe came back as
//                   D:AI(A;ID;0x1200a9;;;AU)(A;ID;FA;;;BA)(A;ID;FA;;;SY)
//                   with the standard user's full-control ace gone.
//    3. /setowner   NOT cosmetic. An object's owner always holds READ_CONTROL
//                   and WRITE_DAC implicitly, so a standard user left owning
//                   this tree can grant themselves back in. Measured: after
//                   steps 1 and 2 an unelevated shell could not delete the
//                   planted file -- and then re-granted itself and could,
//                   because it was still the owner.
function hardenTree(dir, run) {
    const steps = [];
    const step = (name, args) => {
        const r = icacls(args, run);
        steps.push({ name, ok: r.ok, out: (r.out || '').trim().split(/\r?\n/).pop() });
        return r.ok;
    };
    step('reset', [dir, '/reset', '/T', '/C', '/Q']);
    step('grant', [dir, '/inheritance:r', '/grant:r', ...HARDEN_GRANTS, '/Q']);
    step('setowner', [dir, '/setowner', `*${SID_ADMINS}`, '/T', '/C', '/Q']);
    return steps;
}

// ════════════════════════════════════════════════════════════════════
//  secureStateDir(dir, { log, run })
//
//  Returns, and never throws:
//    ok          the tree was read back and NOTHING untrusted can write to it.
//                False means the app is running out of a directory a standard
//                user may be able to change -- reported, not hidden.
//    wasExposed  it was writable when we looked. On a machine where that was
//                true, anything already in the tree may have been planted, so
//                the caller must re-verify the Tor bundle instead of trusting
//                that it exists. This is the one signal that cannot be
//                recovered later: after hardening the evidence is gone.
//    hardened    the three icacls steps ran this time.
//    exposed     the offending aces, root first, for the log.
//    checked     how many objects were read back.
// ════════════════════════════════════════════════════════════════════
function secureStateDir(dir, { log, run } = {}) {
    const L = log || { debug() {}, info() {}, warn() {}, error() {}, success() {} };
    const res = { ok: false, wasExposed: false, hardened: false,
                  exposed: [], steps: [], checked: 0, error: null };
    if (process.platform !== 'win32') { res.ok = true; return res; }
    try {
        if (!fs.existsSync(dir)) { res.error = 'no such directory'; return res; }

        //  Cheap first look: the ROOT only. If the root is already protected
        //  and clean then it has been protected since the last time this ran,
        //  nothing untrusted could have created anything inside it, and the
        //  children do not need reading. That is what keeps the common case to
        //  a single icacls.
        const first = readTree(dir, { run });
        const root  = parseSddl(first.objects[0] && first.objects[0].sddl);
        res.exposed = exposures(root);
        res.wasExposed = !isProtected(root) || res.exposed.length > 0;

        if (!res.wasExposed) {
            res.ok = true; res.checked = 1;
            L.debug('State directory permissions already locked down');
            return res;
        }

        L.warn(`${dir} is writable by more than administrators -- ` +
               'locking it down. This is where the app keeps the Tor binaries ' +
               'and the .bat files it runs elevated.',
               { exposed: res.exposed.map(e => `${e.sid}: ${e.why}`) });

        res.steps    = hardenTree(dir, run);
        res.hardened = true;

        //  ── The read-back ───────────────────────────────────────────
        //  The WHOLE tree this time, because that is the claim being made, and
        //  because inherited-ace propagation to existing children is the part
        //  most likely to be wrong. Reported per object; the app is told which
        //  file, not just that something failed.
        const after = readTree(dir, { recursive: true, run });
        res.checked = after.objects.length;
        const bad = [];
        for (const o of after.objects) {
            const ex = exposures(parseSddl(o.sddl));
            if (ex.length) bad.push({ name: o.name, ex });
        }
        res.exposed = bad.map(b => ({ sid: b.ex[0].sid, rights: b.ex[0].rights,
                                      why: `${b.name}: ${b.ex[0].why}` }));
        const rootAfter = parseSddl(after.objects[0] && after.objects[0].sddl);
        res.ok = res.checked > 0 && bad.length === 0 && isProtected(rootAfter);

        if (res.ok) {
            const owner = res.steps.find(s => s.name === 'setowner');
            L.success(`State directory locked down: ${res.checked} objects, ` +
                      'SYSTEM and Administrators full control, everyone else ' +
                      'read-only' + (owner && owner.ok ? ', owned by Administrators'
                                                       : ''));
            //  Ownership is the one part /save cannot read back -- it saves the
            //  DACL and nothing else -- so its exit code is the evidence and a
            //  failure is stated rather than assumed away.
            if (owner && !owner.ok) {
                res.ok = false;
                L.error('State directory permissions were reset but ownership ' +
                        'was NOT taken. The current owner can grant themselves ' +
                        'back in, so this is not fixed.', { icacls: owner.out });
            }
        } else {
            L.error('State directory could NOT be locked down. It holds the ' +
                    'Tor binaries and the elevated .bat files, so treat this ' +
                    'machine as one where a standard user may be able to ' +
                    'replace them.',
                    { checked: res.checked, steps: res.steps,
                      stillExposed: res.exposed.slice(0, 6).map(e => e.why) });
        }
        return res;
    } catch (e) {
        res.error = e.message;
        L.error('State directory permission check threw: ' + e.message);
        return res;
    }
}

module.exports = {
    secureStateDir,
    //  For .build/probe-state-dir.js, which checks the parsing and the
    //  decision separately from the icacls calls.
    parseSddl, parseSaveFile, parseRights, exposures, isProtected, hardenTree,
    readTree, RIGHTS, READ_MASK, HARDEN_GRANTS, TRUSTED_SIDS,
    SID_SYSTEM, SID_ADMINS, SID_AUTHED,
};
