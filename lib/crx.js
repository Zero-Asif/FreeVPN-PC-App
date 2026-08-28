'use strict';
// ════════════════════════════════════════════════════════════════════
//  lib/crx.js  --  build a signed CRX3 package from a directory
//
//  WHY THIS EXISTS
//  ---------------
//  The only way to make a Chromium browser report the connected country's
//  COORDINATES (rather than simply refuse to answer) is to replace
//  navigator.geolocation inside the page's own JavaScript world, and the
//  only supported way to get code into that world in someone else's browser
//  is an installed extension.
//
//  Getting it installed is the hard part, and most of the obvious routes are
//  closed on Windows:
//
//    * HKLM\Software\Google\Chrome\Extensions\<id> with a `path` to a local
//      .crx -- REMOVED. "As of Chrome 33 no external installs are allowed
//      from a path to a local CRX file on Windows"; on Windows the update_url
//      must be a real update manifest. (external_crx/external_version are
//      Linux-only.)
//    * --load-extension -- needs a command-line flag, so it cannot reach a
//      browser the user launches from their own shortcut.
//    * --remote-debugging-port + CDP setGeolocationOverride -- would be a
//      genuine spoof, but it opens a local port that any process on the
//      machine can use to drive the browser and read its cookies, and since
//      M136 Chromium refuses the flag against the default profile anyway.
//      Trading the user's browser security for a location is not a fix.
//
//  What IS supported is ExtensionInstallForcelist with a self-hosted update
//  manifest -- "For self-hosted extensions use the pattern
//  extension_id;update_url where update_url points to the location of the
//  update manifest XML file." That needs a properly signed CRX3, which is
//  what this file produces. No Chrome binary, no third-party packer.
//
//  FORMAT (components/crx_file/crx3.proto, crx_creator.cc)
//  -------------------------------------------------------
//    "Cr24" | version=3 (u32le) | header_len (u32le) | header | zip
//
//    CrxFileHeader {
//        repeated AsymmetricKeyProof sha256_with_rsa = 2;
//        optional bytes             signed_header_data = 10000;
//    }
//    AsymmetricKeyProof { bytes public_key = 1; bytes signature = 2; }
//    SignedData         { bytes crx_id = 1; }        // 16 bytes
//
//  The signature is RSA PKCS#1 v1.5 / SHA-256 over
//      "CRX3 SignedData\0" || u32le(len(signed_header_data))
//                          || signed_header_data || zip
//  and the extension ID is sha256(SubjectPublicKeyInfo)[0..16) rendered as
//  hex with the digits shifted into a-p.
// ════════════════════════════════════════════════════════════════════

const fs     = require('fs');
const path   = require('path');
const zlib   = require('zlib');
const crypto = require('crypto');

// ── CRC-32, PKZIP polynomial ────────────────────────────────────────
const CRC_TABLE = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        t[n] = c;
    }
    return t;
})();

function crc32(buf) {
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
}

// ── ZIP writer (deflate, no directory entries) ──────────────────────
//  Timestamps are pinned to 1980-01-01 rather than "now" so that packing
//  the same input twice produces byte-identical output. That is what lets
//  the caller detect "nothing actually changed" instead of handing the
//  browser a new download on every reconnect.
const DOS_TIME = 0;
const DOS_DATE = 0x0021;   // 1980-01-01

/** @param {{name:string,data:Buffer}[]} entries */
function zipBuffer(entries) {
    const locals = [], centrals = [];
    let offset = 0;

    for (const e of entries) {
        const name = Buffer.from(e.name.replace(/\\/g, '/'), 'utf8');
        const comp = zlib.deflateRawSync(e.data, { level: 9 });
        const crc  = crc32(e.data);

        const lh = Buffer.alloc(30);
        lh.writeUInt32LE(0x04034b50, 0);   // local file header
        lh.writeUInt16LE(20, 4);           // version needed
        lh.writeUInt16LE(0, 6);            // flags
        lh.writeUInt16LE(8, 8);            // method: deflate
        lh.writeUInt16LE(DOS_TIME, 10);
        lh.writeUInt16LE(DOS_DATE, 12);
        lh.writeUInt32LE(crc, 14);
        lh.writeUInt32LE(comp.length, 18);
        lh.writeUInt32LE(e.data.length, 22);
        lh.writeUInt16LE(name.length, 26);
        lh.writeUInt16LE(0, 28);           // extra len
        locals.push(lh, name, comp);

        const cd = Buffer.alloc(46);
        cd.writeUInt32LE(0x02014b50, 0);   // central directory header
        cd.writeUInt16LE(20, 4);           // version made by
        cd.writeUInt16LE(20, 6);           // version needed
        cd.writeUInt16LE(0, 8);
        cd.writeUInt16LE(8, 10);
        cd.writeUInt16LE(DOS_TIME, 12);
        cd.writeUInt16LE(DOS_DATE, 14);
        cd.writeUInt32LE(crc, 16);
        cd.writeUInt32LE(comp.length, 20);
        cd.writeUInt32LE(e.data.length, 24);
        cd.writeUInt16LE(name.length, 28);
        cd.writeUInt16LE(0, 30);           // extra
        cd.writeUInt16LE(0, 32);           // comment
        cd.writeUInt16LE(0, 34);           // disk number
        cd.writeUInt16LE(0, 36);           // internal attrs
        cd.writeUInt32LE(0, 38);           // external attrs
        cd.writeUInt32LE(offset, 42);      // offset of local header
        centrals.push(cd, name);

        offset += lh.length + name.length + comp.length;
    }

    const cdBuf = Buffer.concat(centrals);
    const eocd  = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cdBuf.length, 12);
    eocd.writeUInt32LE(offset, 16);
    eocd.writeUInt16LE(0, 20);

    return Buffer.concat([...locals, cdBuf, eocd]);
}

/** Every file under `dir`, recursively, as ZIP entries with forward slashes. */
function collect(dir, skip) {
    const out = [];
    const walk = (abs, rel) => {
        for (const name of fs.readdirSync(abs).sort()) {
            if (skip && skip(name)) continue;
            const full = path.join(abs, name);
            const r    = rel ? rel + '/' + name : name;
            const st   = fs.statSync(full);
            if (st.isDirectory()) walk(full, r);
            else if (st.isFile()) out.push({ name: r, data: fs.readFileSync(full) });
        }
    };
    walk(dir, '');
    return out;
}

// ── protobuf, only the two wire shapes this needs ───────────────────
function varint(n) {
    const out = [];
    do { let b = n & 0x7F; n = Math.floor(n / 128); if (n) b |= 0x80; out.push(b); } while (n);
    return Buffer.from(out);
}
function field(tag, payload) {
    return Buffer.concat([tag, varint(payload.length), payload]);
}
const TAG_1     = Buffer.from([0x0A]);              // field 1, length-delimited
const TAG_2     = Buffer.from([0x12]);              // field 2, length-delimited
const TAG_10000 = Buffer.from([0x82, 0xF1, 0x04]);  // field 10000 -> (10000<<3)|2 = 80002

//  sizeof(kSignatureContext) in crx_creator.cc includes the NUL, so the
//  signed prefix is 16 bytes, not 15.
const SIG_CONTEXT = Buffer.from('CRX3 SignedData\0', 'latin1');

/** The 16 raw bytes Chromium uses as the CRX id. */
function crxIdBytes(spkiDer) {
    return crypto.createHash('sha256').update(spkiDer).digest().subarray(0, 16);
}

/** The 32-character a-p form used in policy, URLs and chrome://extensions. */
function crxIdString(spkiDer) {
    let s = '';
    for (const ch of crxIdBytes(spkiDer).toString('hex')) {
        s += String.fromCharCode(97 + parseInt(ch, 16));
    }
    return s;
}

/**
 * Load the signing key, generating it on first use.
 *
 * The key lives on the machine rather than in the repository: it only has
 * to make the extension ID *stable across runs on this machine* so that a
 * reconnect updates the existing extension instead of installing a second
 * copy. A private key committed to a repo would be a published private key.
 */
function ensureKey(keyPath) {
    if (fs.existsSync(keyPath)) {
        const pem = fs.readFileSync(keyPath, 'utf8');
        try { crypto.createPrivateKey(pem); return pem; }
        catch (e) { /* truncated by a crash mid-write -- fall through and replace */ }
    }
    const { privateKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding:  { type: 'spki',  format: 'pem' },
    });
    fs.mkdirSync(path.dirname(keyPath), { recursive: true });
    //  Written 0600-ish: on Windows the inherited ACL of the ProgramData
    //  subtree is what actually protects it, but do not make it worse.
    fs.writeFileSync(keyPath, privateKey, { encoding: 'utf8', mode: 0o600 });
    return privateKey;
}

/** The extension ID a given key will produce, without packing anything. */
function idForKey(privateKeyPem) {
    const spki = crypto.createPublicKey(crypto.createPrivateKey(privateKeyPem))
        .export({ type: 'spki', format: 'der' });
    return crxIdString(spki);
}

/**
 * @param {Buffer} zip
 * @param {string} privateKeyPem
 * @returns {{crx: Buffer, id: string}}
 */
function signZip(zip, privateKeyPem) {
    const key  = crypto.createPrivateKey(privateKeyPem);
    const spki = crypto.createPublicKey(key).export({ type: 'spki', format: 'der' });

    const signedHeader = field(TAG_1, crxIdBytes(spki));      // SignedData{crx_id}
    const sizeLE = Buffer.alloc(4);
    sizeLE.writeUInt32LE(signedHeader.length, 0);

    const signature = crypto.createSign('sha256')
        .update(SIG_CONTEXT).update(sizeLE).update(signedHeader).update(zip)
        .sign(key);                                          // PKCS#1 v1.5

    const proof  = Buffer.concat([field(TAG_1, spki), field(TAG_2, signature)]);
    const header = Buffer.concat([field(TAG_2, proof), field(TAG_10000, signedHeader)]);

    const pre = Buffer.alloc(12);
    pre.write('Cr24', 0, 'ascii');
    pre.writeUInt32LE(3, 4);
    pre.writeUInt32LE(header.length, 8);

    return { crx: Buffer.concat([pre, header, zip]), id: crxIdString(spki) };
}

/**
 * Pack a directory into a signed .crx.
 *
 * @param {object}   o
 * @param {string}   o.dir            directory to pack (must hold manifest.json)
 * @param {string}   o.privateKeyPem
 * @param {function} [o.skip]         name => true to leave a file out
 */
function packDir({ dir, privateKeyPem, skip }) {
    const entries = collect(dir, skip);
    if (!entries.some(e => e.name === 'manifest.json')) {
        throw new Error('no manifest.json at the root of ' + dir);
    }
    return signZip(zipBuffer(entries), privateKeyPem);
}

/**
 * The Omaha-flavoured update manifest Chromium fetches from update_url.
 * `codebase` is where it then downloads the .crx from.
 */
function updateManifestXml({ id, version, codebase }) {
    return "<?xml version='1.0' encoding='UTF-8'?>\n" +
           "<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>\n" +
           `  <app appid='${id}'>\n` +
           `    <updatecheck codebase='${codebase}' version='${version}' />\n` +
           '  </app>\n' +
           '</gupdate>\n';
}

module.exports = {
    crc32, zipBuffer, collect,
    ensureKey, idForKey, signZip, packDir, updateManifestXml,
    crxIdString, crxIdBytes,
};
