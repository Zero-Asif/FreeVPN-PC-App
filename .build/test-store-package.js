'use strict';
// ════════════════════════════════════════════════════════════════════
//  test-store-package.js  --  Extension-Store/package/ is a COPY of Extension/,
//  and nothing until now checked that the copy was current.
//
//  It was not. The geolocation leak -- a disconnect writing {active:false} with
//  no appOff flag, which geo-spoof.js read as "the app says it is off" and
//  answered by handing the page Chromium's own Wi-Fi-derived position -- was
//  fixed in Extension/ and left unfixed in the folder that gets zipped and
//  uploaded to Partner Center. Both trees passed every suite in the gate,
//  because every suite reads Extension/.
//
//  So the shared files are compared byte for byte here. Three are allowed to
//  differ, each for a reason named below, and their manifest keys are still
//  compared field by field -- a store manifest that drifts from the code's
//  actual permissions is either a rejection or a silently broken install.
//
//  The finished zip is checked against the staged folder too. build-zip.js
//  proves the archive it writes matches package/ at the moment it writes it;
//  it cannot know that package/ changed afterwards, which is exactly what has
//  just happened.
// ════════════════════════════════════════════════════════════════════
const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT  = path.join(__dirname, '..');
const SRC   = path.join(ROOT, 'Extension');
const PKG   = path.join(ROOT, 'Extension-Store', 'package');
const STORE = path.join(ROOT, 'Extension-Store');

let pass = 0, fail = 0, na = 0;
function ok(cond, label, extra) {
    if (cond) { pass++; console.log('  ok   ' + label); }
    else { fail++; console.log('  FAIL ' + label + (extra ? '  --  ' + extra : '')); }
}
function skip(label) { na++; console.log('  n/a  ' + label); }

//  Allowed to differ, with the reason. Anything else that differs is a stale
//  copy until this list says otherwise.
const CUSTOMISED = {
    'manifest.json': 'store build carries the four PNG icon sizes Partner Center requires',
    'popup.html':    'store copy states the proxy and map-clear disclosure in the popup itself',
    'welcome.html':  'store copy points at the published listing and privacy policy',
};
//  In the package and deliberately not in Extension/.
const PKG_ONLY_DIRS = ['icons'];

function walk(dir) {
    const out = [];
    (function rec(d, prefix) {
        for (const name of fs.readdirSync(d).sort()) {
            const full = path.join(d, name);
            const rel  = prefix ? prefix + '/' + name : name;
            if (fs.statSync(full).isDirectory()) rec(full, rel);
            else out.push(rel);
        }
    })(dir, '');
    return out;
}

console.log('── the staged Edge package is the current extension ──');

if (!fs.existsSync(PKG)) {
    console.log('  FAIL no Extension-Store/package/ folder at all  --  ' + PKG);
    console.log('\n0/1 checks passed');
    process.exit(1);
}

const srcFiles = walk(SRC);
const pkgFiles = walk(PKG);

//  ── 1. nothing the extension needs is missing from the upload ───────
const absent = srcFiles.filter(f => !pkgFiles.includes(f));
ok(!absent.length,
   'every file the extension ships is in the staged package -- a file that only exists in ' +
   'Extension/ is one the reviewer never receives',
   absent.join(', '));

const unexplained = pkgFiles.filter(f => !srcFiles.includes(f) &&
                                    !PKG_ONLY_DIRS.some(d => f.startsWith(d + '/')));
ok(!unexplained.length,
   'and the package holds nothing extra beyond the icon sizes the store requires',
   unexplained.join(', '));

//  ── 2. every shared file is byte-identical, or named ────────────────
const stale = [], customised = [];
for (const rel of srcFiles) {
    if (!pkgFiles.includes(rel)) continue;
    const a = fs.readFileSync(path.join(SRC, rel));
    const b = fs.readFileSync(path.join(PKG, rel));
    if (a.equals(b)) continue;
    if (CUSTOMISED[rel]) customised.push(rel);
    else stale.push(`${rel} (${a.length} vs ${b.length} bytes)`);
}
ok(!stale.length,
   'and every other shared file is byte-identical: the staged copy IS the code the suites ' +
   'in this gate just verified, not an older one',
   stale.join(', '));

//  The three that may differ have to actually be there. A CUSTOMISED entry for
//  a file that has since converged is a licence nobody needs, and it would let
//  a real drift in later without a word.
const idle = Object.keys(CUSTOMISED).filter(f => !customised.includes(f));
ok(!idle.length,
   'and each file on the customised list is genuinely customised, so the list is not a ' +
   'standing exemption for something that has stopped differing',
   idle.join(', '));

//  ── 3. the geo fix in particular, by name ───────────────────────────
//  Byte-identity above already covers this. It is asserted separately because
//  this is the file and these are the three markers whose absence was the
//  reported leak, and a named check is what a future reader will search for.
const pkgSpoof = fs.readFileSync(path.join(PKG, 'geo-spoof.js'), 'utf8');
const pkgBg    = fs.readFileSync(path.join(PKG, 'background.js'), 'utf8');
ok(/appOff\s*===\s*true/.test(pkgSpoof) && /FRESH_MS/.test(pkgSpoof) &&
   /unreachable/.test(pkgSpoof),
   'the staged geo-spoof.js requires positive appOff evidence, measures freshness and honours ' +
   'unreachable -- the three things whose absence sent Google Maps the device\'s real position');
ok(/appOff:\s*true/.test(pkgBg) && /stamp/.test(pkgBg) && /fp-app-poll/.test(pkgBg),
   'and the staged background.js says appOff explicitly, stamps what it writes, and keeps the ' +
   'alarm that survives worker eviction');

//  ── 4. the two manifests agree on everything but the icons ──────────
const srcMan = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));
const pkgMan = JSON.parse(fs.readFileSync(path.join(PKG, 'manifest.json'), 'utf8'));

ok(srcMan.version === pkgMan.version,
   'the two manifests carry the same version -- a store package numbered differently from the ' +
   'sideloaded build cannot be reasoned about',
   `${srcMan.version} vs ${pkgMan.version}`);
ok(pkgMan.version === '1.2.0',
   'and that version is still 1.2.0: the Edge submission is pending against this number and ' +
   'bumping it before review restarts the queue', String(pkgMan.version));

const KEYS = ['manifest_version', 'name', 'permissions', 'host_permissions',
              'content_scripts', 'background', 'web_accessible_resources',
              'content_security_policy', 'externally_connectable'];
const drift = KEYS.filter(k => JSON.stringify(srcMan[k]) !== JSON.stringify(pkgMan[k]));
ok(!drift.length,
   'and every manifest key that decides what the extension may do is identical -- permissions, ' +
   'host permissions, content scripts, the worker and the CSP', drift.join(', '));

const onlyIcons = Object.keys(pkgMan).filter(k => !(k in srcMan));
ok(onlyIcons.length === 0 || onlyIcons.every(k => k === 'icons'),
   'the only key the store manifest adds is `icons`', onlyIcons.join(', '));

const iconRefs = Object.values(pkgMan.icons || {})
    .concat(Object.values((pkgMan.action || {}).default_icon || {}));
const badIcon = iconRefs.filter(p => !fs.existsSync(path.join(PKG, p)));
ok(iconRefs.length >= 4 && !badIcon.length,
   'and every icon path it names is a file that is actually in the package',
   badIcon.join(', '));

//  ── 5. the zip on disk is not older than the folder ─────────────────
const zip = path.join(STORE, `FreeProxy-VPN-Extension-${pkgMan.version}.zip`);
if (!fs.existsSync(zip)) {
    skip('no zip built yet for v' + pkgMan.version + ' -- run node Extension-Store/build-zip.js');
} else {
    const CRC = (() => {
        const t = new Int32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
            t[n] = c;
        }
        return buf => {
            let c = -1;
            for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
            return (c ^ -1) >>> 0;
        };
    })();

    const buf = fs.readFileSync(zip);
    let eocd = -1;
    for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
        if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) {
        ok(false, 'the zip beside the package parses as a zip', 'no end-of-central-directory record');
    } else {
        const count = buf.readUInt16LE(eocd + 10);
        let at = buf.readUInt32LE(eocd + 16);
        const entries = [];
        let walkable = true;
        for (let n = 0; n < count; n++) {
            if (at + 46 > buf.length || buf.readUInt32LE(at) !== 0x02014b50) { walkable = false; break; }
            const nameLen = buf.readUInt16LE(at + 28);
            entries.push({
                name:   buf.toString('utf8', at + 46, at + 46 + nameLen),
                method: buf.readUInt16LE(at + 10),
                crc:    buf.readUInt32LE(at + 16),
                csize:  buf.readUInt32LE(at + 20),
                at:     buf.readUInt32LE(at + 42),
            });
            at += 46 + nameLen + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32);
        }
        ok(walkable && entries.length === count,
           'the zip beside the package has a central directory that walks',
           `${entries.length} of ${count} entries`);

        const names = entries.map(e => e.name).filter(n => !n.endsWith('/'));
        const gone  = pkgFiles.filter(f => !names.includes(f));
        const spare = names.filter(n => !pkgFiles.includes(n));
        ok(!gone.length && !spare.length,
           'and it holds exactly the files the staged folder holds',
           [...gone.map(f => '-' + f), ...spare.map(f => '+' + f)].join(', '));

        //  The point of the whole section: the BODIES, not the names. A zip built
        //  before the geo fix has an entry list that matches perfectly and a
        //  background.js inside it that still leaks.
        const wrong = [];
        for (const e of entries) {
            if (e.name.endsWith('/') || !pkgFiles.includes(e.name)) continue;
            const lh = e.at;
            if (lh + 30 > buf.length || buf.readUInt32LE(lh) !== 0x04034b50) {
                wrong.push(e.name + ': no local header at ' + lh); continue;
            }
            const start = lh + 30 + buf.readUInt16LE(lh + 26) + buf.readUInt16LE(lh + 28);
            const raw = buf.subarray(start, start + e.csize);
            let body;
            try { body = e.method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw); }
            catch (err) { wrong.push(e.name + ': will not inflate'); continue; }
            const disk = fs.readFileSync(path.join(PKG, e.name.split('/').join(path.sep)));
            if (CRC(body) !== e.crc) wrong.push(e.name + ': stored CRC is not its body\'s');
            else if (!body.equals(disk)) wrong.push(e.name + ': zip body differs from package/');
        }
        ok(!wrong.length,
           'and every body inside it extracts byte-for-byte to what is in the folder now -- so ' +
           'the artifact that would be uploaded carries the fix, not a pre-fix copy of it',
           wrong.slice(0, 6).join(', '));
    }
}

console.log('');
console.log(`${pass}/${pass + fail} checks passed` + (na ? `, ${na} not applicable` : ''));
if (fail) console.log(`${fail} FAILED`);
process.exit(fail ? 1 : 0);
