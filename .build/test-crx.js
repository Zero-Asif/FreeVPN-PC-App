'use strict';
// Structural self-test for lib/crx.js. Nothing here trusts the writer to be
// right: the ZIP is handed to an independent extractor, and the signature is
// re-verified from the bytes actually written, the way Chromium parses them.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execSync } = require('child_process');
const crx = require('../lib/crx');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'crxtest-'));
let fails = 0;
const ok = (label, cond, extra) => {
    console.log((cond ? '  ok   ' : '  FAIL ') + label + (extra ? '  ' + extra : ''));
    if (!cond) fails++;
};

// ── 1. key + id determinism ─────────────────────────────────────────
const keyPath = path.join(TMP, 'k.pem');
const pem = crx.ensureKey(keyPath);
ok('key generated', pem.includes('PRIVATE KEY'));
ok('ensureKey is idempotent', crx.ensureKey(keyPath) === pem);
const id = crx.idForKey(pem);
ok('id is 32 chars a-p', /^[a-p]{32}$/.test(id), id);

// ── 2. pack ─────────────────────────────────────────────────────────
const { crx: buf, id: packedId } = crx.packDir({
    dir: path.join(ROOT, 'Extension'), privateKeyPem: pem,
});
ok('packDir id === idForKey', packedId === id);
ok('magic is Cr24', buf.subarray(0, 4).toString('ascii') === 'Cr24');
ok('version is 3', buf.readUInt32LE(4) === 3);
const headerLen = buf.readUInt32LE(8);
ok('header length is sane', headerLen > 300 && headerLen < 1000, String(headerLen));

// ── 3. re-parse the header the way crx_verifier.cc does ─────────────
//  Minimal length-delimited protobuf reader: enough to walk the two
//  fields this writer emits and prove they are where Chromium looks.
function readVarint(b, i) {
    let v = 0, shift = 1;
    for (;;) { const byte = b[i++]; v += (byte & 0x7F) * shift; if (!(byte & 0x80)) break; shift *= 128; }
    return [v, i];
}
function fields(b) {
    const out = [];
    let i = 0;
    while (i < b.length) {
        let key; [key, i] = readVarint(b, i);
        const num = Math.floor(key / 8), wire = key % 8;
        if (wire !== 2) throw new Error('unexpected wire type ' + wire);
        let len; [len, i] = readVarint(b, i);
        out.push({ num, data: b.subarray(i, i + len) });
        i += len;
    }
    return out;
}

const header = buf.subarray(12, 12 + headerLen);
const zip = buf.subarray(12 + headerLen);
const top = fields(header);
const proofF = top.find(f => f.num === 2);
const shdF = top.find(f => f.num === 10000);
ok('header has sha256_with_rsa (field 2)', !!proofF);
ok('header has signed_header_data (field 10000)', !!shdF);

const proof = fields(proofF.data);
const pub = proof.find(f => f.num === 1).data;
const sig = proof.find(f => f.num === 2).data;
ok('public_key parses as SPKI', (() => {
    try { crypto.createPublicKey({ key: pub, format: 'der', type: 'spki' }); return true; }
    catch (e) { return false; }
})());
ok('signature is 256 bytes (RSA-2048)', sig.length === 256, String(sig.length));

const shd = fields(shdF.data);
const crxId = shd.find(f => f.num === 1).data;
ok('crx_id is 16 bytes', crxId.length === 16, String(crxId.length));
ok('crx_id === sha256(spki)[0:16]',
   crxId.equals(crypto.createHash('sha256').update(pub).digest().subarray(0, 16)));
ok('id string derives from crx_id', crx.crxIdString(pub) === id);

// ── 4. verify the signature exactly as Chromium composes the payload ─
const sizeLE = Buffer.alloc(4);
sizeLE.writeUInt32LE(shdF.data.length, 0);
const verified = crypto.createVerify('sha256')
    .update(Buffer.from('CRX3 SignedData\0', 'latin1'))
    .update(sizeLE)
    .update(Buffer.from([0x0A, 0x10]))   // SignedData{ crx_id: <16 bytes> }
    .update(crxId)
    .update(zip)
    .verify({ key: pub, format: 'der', type: 'spki' }, sig);
ok('signature verifies over context||len||signed_header||zip', verified);

// a signature that covers the archive must break when the archive changes
const tampered = Buffer.from(zip);
tampered[tampered.length - 30] ^= 0xFF;
const badVerified = crypto.createVerify('sha256')
    .update(Buffer.from('CRX3 SignedData\0', 'latin1')).update(sizeLE)
    .update(Buffer.from([0x0A, 0x10])).update(crxId).update(tampered)
    .verify({ key: pub, format: 'der', type: 'spki' }, sig);
ok('a modified archive fails verification', !badVerified);

// ── 5. hand the ZIP to an independent extractor ──────────────────────
const zipPath = path.join(TMP, 'inner.zip');
fs.writeFileSync(zipPath, zip);
const outDir = path.join(TMP, 'out');
try {
    execSync(
        'powershell -NoProfile -Command "Expand-Archive -LiteralPath ' +
        `'${zipPath}' -DestinationPath '${outDir}' -Force"`,
        { windowsHide: true, stdio: 'pipe' });
    const got = fs.readdirSync(outDir).sort();
    const want = fs.readdirSync(path.join(ROOT, 'Extension')).sort();
    ok('Expand-Archive read our ZIP', got.length > 0, got.join(','));
    ok('every source file survived', JSON.stringify(got) === JSON.stringify(want),
       got.length + ' vs ' + want.length);
    const a = fs.readFileSync(path.join(outDir, 'geo-spoof.js'));
    const b = fs.readFileSync(path.join(ROOT, 'Extension', 'geo-spoof.js'));
    ok('geo-spoof.js round-trips byte-for-byte', a.equals(b));
    const icoA = fs.readFileSync(path.join(outDir, 'icon.png'));
    const icoB = fs.readFileSync(path.join(ROOT, 'Extension', 'icon.png'));
    ok('icon.png (672 KB binary) round-trips', icoA.equals(icoB));
    JSON.parse(fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf8'));
    ok('extracted manifest.json is valid JSON', true);

    //  The flags are a whole SUBFOLDER, which is the part a packer gets wrong:
    //  a walk that only reads the top level produces a CRX that installs, runs,
    //  and shows 72 blank badges. One file per country the app can offer.
    const { geoFromMainJs } = require('./geo-from-main.js');
    const want2 = Object.keys(geoFromMainJs(ROOT)).map(c => c.toLowerCase() + '.svg').sort();
    const flagDir = path.join(outDir, 'flags');
    const gotFlags = fs.existsSync(flagDir) ? fs.readdirSync(flagDir).sort() : [];
    ok('the flags subfolder came through the round trip too, one per country',
       JSON.stringify(gotFlags) === JSON.stringify(want2),
       gotFlags.length + ' vs ' + want2.length);
    if (gotFlags.length) {
        const fa = fs.readFileSync(path.join(flagDir, gotFlags[0]));
        const fb = fs.readFileSync(path.join(ROOT, 'Extension', 'flags', gotFlags[0]));
        ok('and a nested file is byte-identical after packing', fa.equals(fb));
    }
} catch (e) {
    ok('Expand-Archive read our ZIP', false, e.message.split('\n')[0]);
}

// ── 6. determinism ──────────────────────────────────────────────────
const again = crx.packDir({ dir: path.join(ROOT, 'Extension'), privateKeyPem: pem });
ok('same input packs to the same bytes', again.crx.equals(buf));

console.log('\nCRX size: ' + (buf.length / 1024).toFixed(1) + ' KB   id: ' + id);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
console.log(fails ? '\n' + fails + ' CHECK(S) FAILED' : '\nall checks passed');
process.exit(fails ? 1 : 0);
