'use strict';
// ═══════════════════════════════════════════════════════════════════════
//  build-zip.js -- pack Extension-Store/package/ into the zip that gets
//  uploaded to Microsoft Edge Add-ons Partner Center.
//
//  WHY A SCRIPT AND NOT A ONE-LINER
//  Three things about this zip are easy to get wrong and every one of them is
//  a rejection:
//
//   1. `manifest.json` must be at the ROOT of the archive. Zipping the
//      FOLDER instead of its CONTENTS produces package/manifest.json, and
//      Partner Center rejects the upload without explaining why.
//   2. `zip` does not exist on this machine -- measured, not assumed:
//      `command -v zip` finds nothing.
//   3. PowerShell's Compress-Archive, the obvious substitute, WRITES THE
//      WRONG SEPARATOR. Measured on this machine: it stored `flags\ae.svg`
//      and `icons\icon-16.png`, with backslashes. The zip format specifies
//      forward slashes (APPNOTE 4.4.17.1), so those are not 74 files in a
//      `flags` folder -- they are 74 files whose names contain a backslash.
//      popup.html asks for `flags/<cc>.svg` and the manifest asks for
//      `icons/icon-16.png`; neither would be found. That is a package that
//      uploads, installs, and shows no flags and no icon.
//
//  So the archive is written here, byte by byte, with zlib -- which is in
//  Node and needs nothing installed -- because that is the only way the
//  entry names are ours to choose. Then it is read back out of the finished
//  file's central directory and checked, including a check for the very
//  backslash that started this. A zip this script calls good is one whose
//  index was parsed off the disk, not one that a packer exited 0 on.
//
//  AND THE INDEX IS NOT THE CONTENTS. An entry list can be perfect while the
//  bytes behind it are not: every field in a local header is written twice by
//  this script -- once there and once in the central directory -- and a wrong
//  compressed size or a stale offset produces a file whose names all match and
//  whose bodies are garbage from the entry after it. So step 6 inflates every
//  entry back out of the finished file and compares it byte for byte with
//  package/. That round trip used to be a thing done once by hand with .NET and
//  written down; it is an assertion now, because the zip is the artifact that
//  gets uploaded and a hand-check does not travel with it.
//
//  USAGE:  node Extension-Store/build-zip.js
//  Output: Extension-Store/FreeProxy-VPN-Extension-<version>.zip
// ═══════════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const HERE = __dirname;
const PKG  = path.join(HERE, 'package');

//  Junk a packer picks up from a Windows folder and that has no business in
//  a reviewed package. Present or not, it is checked for rather than hoped
//  about.
const JUNK = new Set(['thumbs.db', 'desktop.ini', '.ds_store']);

function fail(msg) {
    console.error('\n  FAILED: ' + msg + '\n');
    process.exit(1);
}

//  ── 1. the manifest decides the file name, so it is read first ──────
if (!fs.existsSync(PKG)) fail('no package/ folder beside this script: ' + PKG);
let manifest;
try {
    manifest = JSON.parse(fs.readFileSync(path.join(PKG, 'manifest.json'), 'utf8'));
} catch (e) {
    fail('package/manifest.json is missing or is not valid JSON -- ' + e.message);
}
const version = String(manifest.version || '').trim();
if (!/^\d+(\.\d+){1,3}$/.test(version)) fail('manifest version looks wrong: ' + version);

const OUT = path.join(HERE, `FreeProxy-VPN-Extension-${version}.zip`);

//  ── 2. what SHOULD be in the archive, walked off the disk ───────────
//  Kept as forward-slashed relative paths because that is how a zip stores
//  them, so the comparison in step 5 is against like and not against a
//  separator difference.
const wanted = [];
(function walk(dir, prefix) {
    for (const name of fs.readdirSync(dir).sort()) {
        const full = path.join(dir, name);
        const rel  = prefix ? prefix + '/' + name : name;
        const st   = fs.statSync(full);
        if (st.isDirectory()) { walk(full, rel); continue; }
        if (JUNK.has(name.toLowerCase())) fail('junk file in package/: ' + rel +
                                               ' -- delete it before packing');
        wanted.push(rel);
    }
})(PKG, '');

if (!wanted.includes('manifest.json')) fail('package/manifest.json is not there');
console.log(`\n  packing ${wanted.length} files from package/  (v${version})`);

//  ── 3. a stale zip has to go first ──────────────────────────────────
//  Written fresh every time rather than updated in place: an update would
//  quietly keep a file that has since been deleted from package/ and ship
//  it to the reviewer. Removed outright, so what is uploaded is only ever
//  what package/ holds right now.
if (fs.existsSync(OUT)) {
    try { fs.unlinkSync(OUT); } catch (e) {
        fail('cannot remove the previous zip (' + e.code + '). If this is ' +
             'Controlled Folder Access, allow node.exe for the G: drive.');
    }
}

//  ── 4. pack ─────────────────────────────────────────────────────────
//  A deflate zip, written out in full. Nothing exotic in it: one local
//  header + deflated body per file, a central directory, an end record.
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

//  A fixed timestamp, not the clock: the same package/ must always produce
//  the same bytes, so a re-run can be diffed against the zip that was
//  actually uploaded. 1 Jan 2026, 00:00, in the DOS pair the format wants.
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;
const DOS_TIME = 0;

const locals = [], central = [];
let offset = 0;
for (const rel of wanted) {
    const body = fs.readFileSync(path.join(PKG, rel));
    const deflated = zlib.deflateRawSync(body, { level: 9 });
    //  Storing beats deflating when deflating grew the file -- true of the
    //  odd already-compressed png. Method is per entry, so this is free.
    const stored = deflated.length >= body.length;
    const data = stored ? body : deflated;
    //  Forward slashes, always. This is the line that clause 3 of the header
    //  comment is about: the name in the archive is ours to write, and it is
    //  written the way the format defines it.
    const name = Buffer.from(rel.split(path.sep).join('/'), 'utf8');
    const crc = CRC(body);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);          // local file header
    lh.writeUInt16LE(20, 4);                  // version needed
    lh.writeUInt16LE(0x0800, 6);              // flags: UTF-8 names
    lh.writeUInt16LE(stored ? 0 : 8, 8);      // method: store / deflate
    lh.writeUInt16LE(DOS_TIME, 10);
    lh.writeUInt16LE(DOS_DATE, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);        // compressed size
    lh.writeUInt32LE(body.length, 22);        // uncompressed size
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);                  // no extra field
    locals.push(lh, name, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);          // central directory header
    cd.writeUInt16LE(0x0014, 4);              // made by: 2.0, FAT
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(stored ? 0 : 8, 10);
    cd.writeUInt16LE(DOS_TIME, 12);
    cd.writeUInt16LE(DOS_DATE, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(body.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);             // where its local header is
    central.push(cd, name);
    offset += lh.length + name.length + data.length;
}

const cdBuf = Buffer.concat(central);
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0);            // end of central directory
eocd.writeUInt16LE(wanted.length, 8);         // entries on this disk
eocd.writeUInt16LE(wanted.length, 10);        // entries total
eocd.writeUInt32LE(cdBuf.length, 12);
eocd.writeUInt32LE(offset, 16);
try {
    fs.writeFileSync(OUT, Buffer.concat([...locals, cdBuf, eocd]));
} catch (e) {
    fail('cannot write the zip (' + e.code + '). If this is Controlled Folder ' +
         'Access, allow node.exe for the G: drive.');
}
if (!fs.existsSync(OUT)) fail('no zip at ' + OUT + ' after writing it');

//  ── 5. read the archive back and prove what is in it ────────────────
//  A zip's index is its central directory, at the end of the file. Walking
//  it needs no library and no unzip binary, which matters here: there is no
//  `unzip` on this machine either, and "it built" is not the claim being
//  made -- "these exact names are inside it, at these exact paths" is.
function zipEntries(file) {
    const buf = fs.readFileSync(file);
    //  End of central directory: scan back for its signature. The trailing
    //  comment is almost always empty, so this finds it in a few bytes.
    let eocd = -1;
    for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
        if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) return null;                     // not a zip at all
    const count = buf.readUInt16LE(eocd + 10);
    let at = buf.readUInt32LE(eocd + 16);
    const entries = [];
    for (let n = 0; n < count; n++) {
        if (at + 46 > buf.length || buf.readUInt32LE(at) !== 0x02014b50) return null;
        const nameLen  = buf.readUInt16LE(at + 28);
        const extraLen = buf.readUInt16LE(at + 30);
        const cmtLen   = buf.readUInt16LE(at + 32);
        entries.push({
            name:   buf.toString('utf8', at + 46, at + 46 + nameLen),
            method: buf.readUInt16LE(at + 10),
            crc:    buf.readUInt32LE(at + 16),
            csize:  buf.readUInt32LE(at + 20),
            usize:  buf.readUInt32LE(at + 24),
            //  Where the central directory SAYS the body is. Followed rather
            //  than assumed: this offset is the one field a writer can get
            //  wrong without any size or count disagreeing.
            at:     buf.readUInt32LE(at + 42),
        });
        at += 46 + nameLen + extraLen + cmtLen;
    }
    entries.buf = buf;
    return entries;
}

const got = zipEntries(OUT);
if (!got) fail('the file was written but its central directory does not parse -- ' +
               'it is not a usable zip');

//  Directory entries are not written at all -- a zip does not need them and
//  a browser does not read them -- so any that turned up would mean the
//  writer above did something other than what it says. Filtered, then the
//  count is compared, so an unexpected one cannot pass unnoticed.
const entries = got.filter(e => !e.name.endsWith('/'));
const files = entries.map(e => e.name);

//  The measured Compress-Archive bug, kept as an assertion now that the
//  writer is ours: a backslash in an entry name is a file called
//  "flags\ae.svg", not a file in a folder, and every reference in the
//  package would miss it.
const slashed = files.filter(n => n.includes('\\'));
if (slashed.length) fail('entry names contain a backslash, which the zip format ' +
                         'does not allow as a separator:\n         ' +
                         slashed.slice(0, 5).join('\n         '));

const missing = wanted.filter(w => !files.includes(w));
const extra   = files.filter(f => !wanted.includes(f));

console.log(`  archive holds ${files.length} files`);
if (missing.length) fail('missing from the zip:\n         ' + missing.join('\n         '));
if (extra.length)   fail('in the zip but not in package/:\n         ' + extra.join('\n         '));

//  The rejection this whole script exists to prevent, asserted last and
//  explicitly: manifest.json at the ROOT, no folder in front of it.
if (!files.includes('manifest.json'))
    fail('manifest.json is not at the root of the zip -- the folder was packed ' +
         'instead of its contents, and Partner Center will refuse this upload');

//  ── 6. inflate every entry back out and compare it with package/ ────
//  The step the entry list cannot do. Each body is taken by FOLLOWING the
//  central directory's offset into the local header -- the same route an
//  unzipper takes -- and not by remembering where this script put it, so a
//  wrong offset, a wrong compressed size or a wrong method fails here instead
//  of at a reviewer. Then the stored CRC is recomputed over what came out, and
//  what came out is compared with the file on disk.
const wrong = [];
for (const e of entries) {
    const lh = e.at;
    if (lh + 30 > got.buf.length || got.buf.readUInt32LE(lh) !== 0x04034b50) {
        wrong.push(`${e.name}: no local header where the index says (offset ${lh})`);
        continue;
    }
    const start = lh + 30 + got.buf.readUInt16LE(lh + 26) + got.buf.readUInt16LE(lh + 28);
    const raw = got.buf.subarray(start, start + e.csize);
    let body;
    try {
        body = e.method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw);
    } catch (err) {
        wrong.push(`${e.name}: its body does not inflate -- ${err.message}`);
        continue;
    }
    const disk = fs.readFileSync(path.join(PKG, e.name.split('/').join(path.sep)));
    if (body.length !== e.usize)
        wrong.push(`${e.name}: inflates to ${body.length} bytes, header says ${e.usize}`);
    else if (CRC(body) !== e.crc)
        wrong.push(`${e.name}: CRC of the extracted body does not match the stored one`);
    else if (!body.equals(disk))
        wrong.push(`${e.name}: extracts to ${body.length} bytes that are not package/'s`);
}
if (wrong.length) fail('the archive parses but does not extract to package/:\n         ' +
                       wrong.slice(0, 8).join('\n         '));

const kb = (fs.statSync(OUT).size / 1024).toFixed(0);
console.log(`\n  OK  ${path.basename(OUT)}  (${kb} KB)`);
console.log(`      manifest.json is at the root; ${files.length} files match package/`);
console.log(`      all ${entries.length} entries extract byte-for-byte from the finished zip`);
console.log('      upload this file at Partner Center > Extensions > Update > Package\n');
