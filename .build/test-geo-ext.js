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
const { execSync } = require('child_process');

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
    //  RECURSIVE on both sides, because _stage() is. This used to compare
    //  top-level FILES in Extension/ against everything in the staged folder,
    //  which reported a difference the moment staging started carrying
    //  flags/ -- 73 country SVGs the popup loads by name. Comparing the whole
    //  relative-path list is also the stronger statement: what the browser gets
    //  is the source tree, entry for entry, and not just its root.
    const walk = (root, sub = '') => {
        const out = [];
        for (const n of fs.readdirSync(path.join(root, sub)).sort()) {
            const r = sub ? sub + '/' + n : n;
            const st = fs.statSync(path.join(root, r));
            if (st.isDirectory()) out.push(...walk(root, r));
            else if (st.isFile()) out.push(r);
        }
        return out;
    };
    const srcNames = walk(SRC);
    const dstNames = walk(r1.dir);
    ok(JSON.stringify(srcNames) === JSON.stringify(dstNames),
       'staged file list matches Extension/ exactly, subdirectories included',
       'src=' + srcNames.length + ' dst=' + dstNames.length + '  only in one: ' +
       srcNames.filter(n => !dstNames.includes(n))
               .concat(dstNames.filter(n => !srcNames.includes(n))).join(','));
    ok(srcNames.some(n => /^flags\/[a-z]{2}\.svg$/.test(n)),
       'and the flags the popup asks for by name are among them',
       String(srcNames.filter(n => n.startsWith('flags/')).length) + ' flag file(s)');

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
    //  REGRESSION. The manifest used to name 8081 while the listener was on
    //  8082: listen(port, host, cb) registers cb as a once('listening') handler,
    //  a failed bind never fires it but never drops it either, so the handler
    //  left over from the 8081 attempt resolved the promise with 8081 when 8082
    //  finally bound. Every policy and the on-disk bundle then pointed at a port
    //  this app was not serving -- silent, and indistinguishable from a policy
    //  that was refused. Whatever port ends up bound, the URLs must name it.
    ok(codebase === `http://127.0.0.1:${ext.host.port}/freeproxy-geo.crx`,
       'codebase names the port the host actually bound',
       `${codebase} vs bound ${ext.host.port}`);
    ok(r1.updateUrl === `http://127.0.0.1:${ext.host.port}/updates.xml`,
       'and so does the update_url the policies get', r1.updateUrl);

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
    ok(Object.values(seen).every(v =>
           ['installed', 'needs-enable', 'declined', 'absent', 'not-present'].includes(v)),
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

    //  The distinction the whole honesty fix exists for: an extension that is in
    //  the profile but switched off must NEVER be in the same bucket as one that
    //  is running, and must never be sent to "Load unpacked" -- it is loaded.
    const enable = ext.needEnable();
    console.log('   needEnable -> ' + JSON.stringify(enable));
    ok(enable.every(n => seen[n] === 'needs-enable'),
       'needEnable() only contains browsers whose profile says present-but-disabled');
    ok(!enable.some(id => manual.includes(id)),
       'no browser is asked to load a folder it has already downloaded');
    ok(enable.every(id => here.has(id)),
       'and never a browser that is not installed');
    const states = ext.states();
    ok(Object.keys(states).every(id => here.has(id)),
       'states() covers the installed forks only');
    ok(Object.keys(states).every(id => typeof states[id].present === 'boolean' &&
                                      typeof states[id].enabled === 'boolean' &&
                                      Array.isArray(states[id].disabled)),
       'states() answers present/enabled/disabled[] per browser, not one boolean');
    ok(Object.keys(states).every(id => !(states[id].enabled && !states[id].present)),
       'nothing is ever reported enabled without being present');
    for (const id of Object.keys(states)) {
        const s = states[id];
        ok(seen[id] === (s.enabled ? 'installed' : s.removedByUser ? 'declined'
                                  : s.present ? 'needs-enable' : 'absent'),
           `presence() agrees with states() for ${id}`,
           `${seen[id]} vs ${JSON.stringify(s)}`);
    }

    console.log('── awaitingStart(): armed, absent, and simply not started since ──');
    //  MEASURED, and the reason this exists: all four routes were written at
    //  22:59:33 with the delivery helper serving throughout.
    //      Brave   started 23:11:45 (after)  -> extension at 23:14:47, loc 6, off
    //      Chrome  running since 19:10:53    -> nothing, hours later
    //      Edge    running since 19:10:53    -> arrived 00:33:18, +93.7 min,
    //                                           loc 7, ENABLED, worker running
    //  A policy reaches a running browser at its own refresh interval; the
    //  external-extensions provider is read only while a browser STARTS. So an
    //  absent browser whose entry is still in the registry is waiting for a
    //  start, not for the user -- and must never be told to load a folder.
    const armedNow = ext.awaitingStart();
    console.log('   awaitingStart -> ' + JSON.stringify(armedNow));
    ok(armedNow.length === 0,
       'a state dir with no journal arms nothing, whatever this machine has',
       JSON.stringify(armedNow));
    ok(armedNow.every(id => seen[id] === 'absent'),
       'awaitingStart() only ever contains browsers with nothing in the profile');
    ok(!armedNow.some(id => manual.includes(id)) && !armedNow.some(id => enable.includes(id)),
       'and never one that is also being asked to load or switch something');

    //  The read-back itself, without touching HKLM or needing elevation: the
    //  journal is ours, so it can name a key under HKCU that this test creates
    //  and deletes. That exercises the real regValueView()/regValues() path --
    //  a journal entry alone must never be enough to claim a route is armed.
    const HK = 'HKCU\\Software\\FreeProxy VPN Test';
    const journalWas = fs.readFileSync(ext.stateFile, 'utf8');
    const reg = a => { try { execSync(a, { windowsHide: true, stdio: 'pipe' }); return true; }
                       catch (e) { return false; } };
    const URL_ = 'http://127.0.0.1:8081/updates.xml';
    reg(`reg add "${HK}\\Extensions\\${r1.id}" /v update_url /t REG_SZ /d "${URL_}" /f`);
    reg(`reg add "${HK}\\Forcelist" /v 1 /t REG_SZ /d "${r1.id};${URL_}" /f`);
    reg(`reg add "${HK}\\Forcelist" /v 2 /t REG_SZ /d "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz;${URL_}" /f`);
    const journal = j => fs.writeFileSync(ext.stateFile,
        JSON.stringify({ id: r1.id, version: r1.version, slots: [], settings: [],
                         external: [], allow: [], ...j }), 'utf8');

    journal({ external: [{ browser: 'chrome', key: `${HK}\\Extensions\\${r1.id}`,
                           view: '64', url: URL_, id: r1.id }] });
    ok(ext._armedFor('chrome') === true, 'an external-extensions entry that is really there is armed');
    ok(ext._armedFor('brave') === false, 'and only for the browser the journal names');

    journal({ external: [{ browser: 'chrome', key: `${HK}\\Extensions\\${r1.id}`,
                           view: '64', url: 'http://127.0.0.1:9999/updates.xml', id: r1.id }] });
    ok(ext._armedFor('chrome') === false,
       'a key that now points somewhere else is NOT ours and is not armed');

    journal({ external: [{ browser: 'chrome', key: `${HK}\\Extensions\\nope`,
                           view: '64', url: URL_, id: r1.id }] });
    ok(ext._armedFor('chrome') === false,
       'a journal row whose key was removed since is not armed -- the registry decides');

    journal({ slots: [{ browser: 'chrome', key: `${HK}\\Forcelist`, slot: '1' }] });
    ok(ext._armedFor('chrome') === true, 'a forcelist slot still holding our id is armed');
    journal({ slots: [{ browser: 'chrome', key: `${HK}\\Forcelist`, slot: '2' }] });
    ok(ext._armedFor('chrome') === false, 'a slot holding somebody else\'s id is not');
    journal({ settings: [{ browser: 'chrome', key: `${HK}\\Forcelist`, name: '1' }],
              allow:    [{ browser: 'chrome', key: `${HK}\\Forcelist`, slot: '1' }] });
    ok(ext._armedFor('chrome') === false,
       'ExtensionSettings and the allowlist PERMIT an install, they do not cause one, ' +
       'so neither counts as something on its way');

    //  And the consequence: an armed browser leaves the manual-load list.
    const absentHere = Object.keys(seen).filter(id => seen[id] === 'absent');
    if (absentHere.length) {
        const victim = absentHere[0];
        journal({ external: [{ browser: victim, key: `${HK}\\Extensions\\${r1.id}`,
                               view: '64', url: URL_, id: r1.id }] });
        ok(ext.awaitingStart().includes(victim),
           `${victim} is absent with its entry present -> awaitingStart()`);
        ok(!ext.needManualLoad().includes(victim),
           `${victim} is NOT asked to load a folder by hand while that entry is armed`);
    } else {
        console.log('   (no absent browser on this machine to arm -- invariant only)');
    }
    reg(`reg delete "${HK}" /f`);
    fs.writeFileSync(ext.stateFile, journalWas, 'utf8');
    ok(!fs.readFileSync(ext.stateFile, 'utf8').includes('FreeProxy VPN Test'),
       'the test journal is put back the way it was found');

    console.log('── HOW-TO gets an enable section when a browser needs one ──');
    ext.writeHowTo([], ['chrome']);
    const t2 = fs.readFileSync(path.join(ext.baseDir, 'HOW-TO-ENABLE.txt'), 'utf8');
    ok(/ALREADY DOWNLOADED/.test(t2) && /switch/i.test(t2),
       'the one-click case is described as a switch, not as a setup');
    ok(!/Load unpacked/.test(t2),
       'and does NOT tell the user to load a folder that is already in the profile');
    ok(!t2.includes(ext.dir),
       'nor does it print a folder path there is no reason to open');
    ext.writeHowTo(['chrome', 'brave'], ['edge']);
    const t3 = fs.readFileSync(path.join(ext.baseDir, 'HOW-TO-ENABLE.txt'), 'utf8');
    ok(/ALREADY DOWNLOADED/.test(t3) && /Load unpacked/.test(t3) && t3.includes(ext.dir),
       'both asks can appear in one file, each with its own instructions');
    ok(t3.indexOf('ALREADY DOWNLOADED') < t3.indexOf('NOT DELIVERED'),
       'the one-click case comes first -- it is the one the user will actually have');

    console.log('── HOW-TO tells a browser that was merely open to restart, not to load ──');
    ext.writeHowTo([], [], ['chrome']);
    const t4 = fs.readFileSync(path.join(ext.baseDir, 'HOW-TO-ENABLE.txt'), 'utf8');
    ok(/ALREADY SET UP/.test(t4) && /Close Google Chrome/.test(t4),
       'the armed-but-unstarted case asks for a close-and-reopen', t4.slice(0, 300));
    ok(!/Load unpacked/.test(t4) && !t4.includes(ext.dir),
       'and never for Developer mode or a folder -- the entry is already written');
    ok(/chrome:\/\/extensions/.test(t4),
       'it still names the page where the one switch will be, by that browser\'s own URL');
    ok(/restart of Windows/.test(t4),
       'and says why this app asks for a restart -- one start covers every browser');
    //  The first version of this section told the user a browser reads the entry
    //  "while it starts -- never while it is running". Chrome's own extension
    //  folder, mtime 00:47:10, says it took it 107.6 min after the entry was
    //  written with a process that had been up 28.4 h. A restart is the fast
    //  path, not the only path, and the file has to say so.
    ok(!/never while it is running/.test(t4),
       'it does not claim a running browser will never pick the entry up');
    ok(/two hours/.test(t4),
       'it says what happens if the user does nothing at all: it arrives anyway',
       t4.slice(t4.indexOf('ALREADY SET UP'), t4.indexOf('ALREADY SET UP') + 400));
    ext.writeHowTo(['vivaldi'], ['edge'], ['chrome', 'brave']);
    const t5 = fs.readFileSync(path.join(ext.baseDir, 'HOW-TO-ENABLE.txt'), 'utf8');
    ok(t5.indexOf('ALREADY DOWNLOADED') < t5.indexOf('ALREADY SET UP') &&
       t5.indexOf('ALREADY SET UP') < t5.indexOf('NOT DELIVERED'),
       'three asks, ordered by how little they cost the user',
       [t5.indexOf('ALREADY DOWNLOADED'), t5.indexOf('ALREADY SET UP'),
        t5.indexOf('NOT DELIVERED')].join(','));
    ok(/Close Google Chrome and Brave completely/.test(t5),
       'the restart section names every browser it applies to');
    ok(t5.includes('brave://extensions') && t5.includes('chrome://extensions'),
       'each with its own extensions URL, there too');

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
