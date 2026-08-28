'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/test-geo-ext.js  --  exercise lib/geo-ext.js without Electron
//  and without touching the registry, so it is safe to run unelevated.
//
//  What it asserts, and why each one has bitten before:
//    * the staged extension is byte-identical to Extension/ apart from the
//      injected "key", and carries nothing else -- a stray file inside an
//      unpacked extension makes the browser reload it and ends up in the CRX
//    * HOW-TO-ENABLE.txt lands BESIDE the extension, not inside it
//    * the CRX is served over loopback and its bytes match what was packed
//      (a truncated or HTML-wrapped response is exactly what a browser would
//      report as "invalid package" with no further detail)
//    * the id derived from the injected key is the id the CRX header carries,
//      so an unpacked load and a force-install are the SAME extension and
//      presence detection cannot disagree with itself
//    * the version only moves when the content actually changes
// ════════════════════════════════════════════════════════════════════
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const { GeoExt } = require('../lib/geo-ext');
const crx = require('../lib/crx');
const browsersMod = require('../lib/browsers');

const ROOT = path.join(__dirname, '..');
const SRC  = path.join(ROOT, 'Extension');
const TMP  = fs.mkdtempSync(path.join(os.tmpdir(), 'fpge-'));

const log = {
    debug: () => {}, info: () => {}, warn: (...a) => console.log('   warn:', ...a),
    error: (...a) => console.log('   ERROR:', ...a), success: () => {},
};

let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
    if (cond) { pass++; console.log('  ok   ' + name); }
    else { fail++; console.log('  FAIL ' + name + (extra ? '  -- ' + extra : '')); }
};

const get = url => new Promise((res, rej) => {
    http.get(url, r => {
        const bufs = [];
        r.on('data', d => bufs.push(d));
        r.on('end', () => res({ status: r.statusCode, body: Buffer.concat(bufs) }));
    }).on('error', rej);
});

(async () => {
    const ext = new GeoExt({ log, stateDir: TMP, sourceDir: SRC });

    console.log('── prepare ──');
    const r1 = await ext.prepare();
    ok(!!r1, 'prepare() returned a descriptor');
    if (!r1) process.exit(1);
    console.log(`   id ${r1.id}  v${r1.version}  ${r1.updateUrl}`);

    ok(/^[a-p]{32}$/.test(r1.id), 'id is 32 chars in a-p');
    ok(r1.dir === path.join(TMP, 'browser-setup', 'extension'),
       'extension staged in browser-setup/extension', r1.dir);

    console.log('── staged contents ──');
    const srcNames = fs.readdirSync(SRC).filter(n => fs.statSync(path.join(SRC, n)).isFile()).sort();
    const dstNames = fs.readdirSync(r1.dir).sort();
    ok(JSON.stringify(srcNames) === JSON.stringify(dstNames),
       'staged file list matches Extension/ exactly',
       'src=' + srcNames.join(',') + ' dst=' + dstNames.join(','));

    let identical = true, differing = [];
    for (const n of srcNames) {
        if (n === 'manifest.json') continue;
        if (!fs.readFileSync(path.join(SRC, n)).equals(fs.readFileSync(path.join(r1.dir, n)))) {
            identical = false; differing.push(n);
        }
    }
    ok(identical, 'every non-manifest file is byte-identical', differing.join(','));

    const srcMf = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));
    const dstMf = JSON.parse(fs.readFileSync(path.join(r1.dir, 'manifest.json'), 'utf8'));
    ok(typeof dstMf.key === 'string' && dstMf.key.length > 200, 'manifest carries the public key');
    ok(srcMf.key === undefined, 'source manifest was NOT mutated');
    const stripped = { ...dstMf }; delete stripped.key; stripped.version = srcMf.version;
    ok(JSON.stringify(stripped) === JSON.stringify(srcMf),
       'manifest differs from source only by key + version');
    ok(crx.crxIdString(Buffer.from(dstMf.key, 'base64')) === r1.id,
       'id derived from the injected key equals the packaged id');

    console.log('── loopback host ──');
    const xml = await get(r1.updateUrl);
    ok(xml.status === 200, 'update manifest 200', 'got ' + xml.status);
    const xmlText = xml.body.toString('utf8');
    ok(xmlText.includes(r1.id) && xmlText.includes(`version='${r1.version}'`),
       'update manifest names our id and version', xmlText.slice(0, 200));
    const codebase = (xmlText.match(/codebase='([^']+)'/) || [])[1];
    ok(!!codebase, 'update manifest has a codebase');

    const pkg = await get(codebase);
    ok(pkg.status === 200, 'CRX 200', 'got ' + pkg.status);
    ok(pkg.body.slice(0, 4).toString('latin1') === 'Cr24', 'CRX magic is Cr24');
    ok(pkg.body.readUInt32LE(4) === 3, 'CRX version is 3');
    const repacked = crx.packDir({ dir: r1.dir, privateKeyPem: fs.readFileSync(ext.keyFile, 'utf8') });
    ok(repacked.id === r1.id, 'repacking the staged dir yields the same id');
    ok(crypto.createHash('sha256').update(pkg.body).digest('hex') ===
       crypto.createHash('sha256').update(repacked.crx).digest('hex'),
       'served CRX matches a fresh pack of the staged dir byte for byte');

    console.log('── version is monotonic, not per-connect ──');
    const r2 = await ext.prepare();
    ok(r2.version === r1.version, 'unchanged content keeps the version', r1.version + ' -> ' + r2.version);
    const probe = path.join(SRC, '__geoext_test_probe.js');
    fs.writeFileSync(probe, '// temporary file written by .build/test-geo-ext.js\n');
    let r3;
    try { r3 = await ext.prepare(); } finally { fs.unlinkSync(probe); }
    ok(r3.version !== r1.version, 'changed content bumps the version', r1.version + ' -> ' + r3.version);
    ok(fs.existsSync(path.join(r1.dir, '__geoext_test_probe.js')), 'new source file was staged');
    const r4 = await ext.prepare();
    ok(!fs.existsSync(path.join(r1.dir, '__geoext_test_probe.js')),
       'a file removed from the source is pruned from the staged dir');
    ok(r4.version !== r3.version, 'pruning bumps the version too', r3.version + ' -> ' + r4.version);

    console.log('── instructions ──');
    ext.writeHowTo(['chrome', 'brave']);
    const howTo = path.join(TMP, 'browser-setup', 'HOW-TO-ENABLE.txt');
    ok(fs.existsSync(howTo), 'HOW-TO-ENABLE.txt written beside the extension');
    ok(!fs.existsSync(path.join(r1.dir, 'HOW-TO-ENABLE.txt')),
       'HOW-TO-ENABLE.txt is NOT inside the extension folder');
    const txt = fs.readFileSync(howTo, 'utf8');
    ok(txt.includes(r1.dir), 'instructions name the exact folder to load');
    ok(txt.includes('Google Chrome and Brave'),
       'instructions name the browsers by their display names, not their ids');
    //  Each fork's own extensions page: chrome://extensions errors in Brave,
    //  so one generic URL would send the user somewhere that does not exist.
    ok(txt.includes('chrome://extensions') && txt.includes('brave://extensions'),
       'instructions give each browser its OWN extensions URL');

    console.log('── presence / manual-load, read-only ──');
    const seen = ext.presence();
    console.log('   ' + JSON.stringify(seen));
    ok(Object.keys(seen).length === browsersMod.CHROMIUM.length,
       'presence() reports every Chromium fork in the table, not just three',
       Object.keys(seen).length + ' vs ' + browsersMod.CHROMIUM.length);
    ok(Object.values(seen).every(v => ['installed', 'absent', 'not-present'].includes(v)),
       'presence() values are from the documented set');
    ok(Object.keys(seen).every(id => browsersMod.byId(id)),
       'presence() is keyed by real browser ids');
    const here = new Set(browsersMod.detectChromium().map(b => b.id));
    ok(Object.keys(seen).every(id => (seen[id] === 'not-present') === !here.has(id)),
       'not-present means exactly "no verified executable on this machine"');
    const manual = ext.needManualLoad();
    console.log('   needManualLoad -> ' + JSON.stringify(manual));
    ok(!manual.includes('edge'), 'Edge is never listed as needing a manual load');
    ok(manual.every(n => seen[n] === 'absent'), 'manual list only contains absent browsers');
    ok(manual.every(id => here.has(id)),
       'a browser that is not installed is never put in a "do this by hand" list');

    console.log('── restore with an empty journal is a no-op ──');
    const before = fs.readFileSync(ext.stateFile, 'utf8');
    ext.restore();
    ok(JSON.parse(fs.readFileSync(ext.stateFile, 'utf8')).slots.length === 0,
       'restore() leaves an empty slot list');
    ok(JSON.parse(before).id === r1.id, 'journal kept the id');

    ext.host.stop();
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}

    console.log(`\n${pass}/${pass + fail} checks passed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.log('ABORT: ' + e.stack); process.exit(3); });
