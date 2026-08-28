'use strict';
// ════════════════════════════════════════════════════════════════════
//  Does ExtensionInstallForcelist actually accept a loopback HTTP update
//  manifest, and does our hand-rolled CRX3 survive Chromium's verifier?
//
//  This is the one question the documentation does not answer, and the whole
//  Chromium half of the location spoof depends on it. So it gets tested for
//  real, against the real browsers, before any of it is wired into the app.
//
//  Deliberately non-destructive:
//    * each browser is launched against a THROWAWAY --user-data-dir, so the
//      user's real profiles, tabs and extensions are never touched
//    * only ExtensionInstallForcelist is written, and any pre-existing value
//      under it is saved and put back
//
//  Policy goes in HKLM, which needs elevation. HKCU looks tempting -- the
//  docs list both hives -- but HKCU\SOFTWARE\Policies is ACL'd to
//  administrators on a normal install, so `reg add` there returns "Access is
//  denied" and the browser then sees no policy at all. An earlier version of
//  this test ignored that failure and reported "URL rejected" when in truth
//  nothing had ever been written. Hence assertPolicy() below: a policy write
//  that did not happen must abort, never quietly produce a negative result.
//
//  The server logs every hit, which turns a bare "it did not install" into a
//  diagnosis: no request at all means the URL or the policy was rejected;
//  updates.xml but no .crx means the manifest was not understood; both
//  fetched with no install means the package itself was refused.
// ════════════════════════════════════════════════════════════════════
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync, spawn } = require('child_process');
const crx = require('../lib/crx');
const { ExtHost } = require('../lib/ext-host');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fpext-'));
const HITS = [];
const log = {
    debug: m => HITS.push('debug: ' + m),
    info:  m => HITS.push('info: ' + m),
    warn:  m => console.log('    [host warn] ' + m),
};

const BROWSERS = [
    { name: 'Chrome', policy: 'HKLM\\SOFTWARE\\Policies\\Google\\Chrome',
      exe: ['C:/Program Files/Google/Chrome/Application/chrome.exe',
            'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'] },
    { name: 'Edge', policy: 'HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge',
      exe: ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
            'C:/Program Files/Microsoft/Edge/Application/msedge.exe'] },
    { name: 'Brave', policy: 'HKLM\\SOFTWARE\\Policies\\BraveSoftware\\Brave',
      exe: ['C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe',
            'C:/Program Files (x86)/BraveSoftware/Brave-Browser/Application/brave.exe'] },
];

const sh = c => { try { return execSync(c, { windowsHide: true, encoding: 'utf8', stdio: 'pipe' }); } catch (e) { return null; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

try { execSync('net session', { windowsHide: true, stdio: 'pipe' }); }
catch (e) {
    console.log('ABORT: not elevated. HKLM\\SOFTWARE\\Policies is not writable, and');
    console.log('       HKCU\\SOFTWARE\\Policies is ACL\'d to administrators too, so');
    console.log('       without elevation this test can only produce a false negative.');
    process.exit(2);
}

/** Write a policy value and PROVE it landed. A silent failure here would be
 *  reported as "the browser rejected the URL", which is a different bug. */
function assertPolicy(key, name, data) {
    sh(`reg add "${key}" /f`);
    sh(`reg add "${key}\\ExtensionInstallForcelist" /f`);
    sh(`reg add "${key}\\ExtensionInstallForcelist" /v "${name}" /t REG_SZ /d "${data}" /f`);
    const back = sh(`reg query "${key}\\ExtensionInstallForcelist" /v "${name}"`);
    if (!back || !back.includes(data)) {
        throw new Error('policy write did not stick: ' + key + ' -> ' + (back || 'unreadable'));
    }
}

// ── build the package ───────────────────────────────────────────────
const stage = path.join(TMP, 'stage');
fs.mkdirSync(stage, { recursive: true });
for (const f of fs.readdirSync(path.join(ROOT, 'Extension'))) {
    fs.copyFileSync(path.join(ROOT, 'Extension', f), path.join(stage, f));
}
//  A seed file is what makes the coordinates available synchronously at
//  document_start, with no wait on chrome.storage. Included here so the test
//  exercises the same layout the app will ship.
fs.writeFileSync(path.join(stage, 'geo-seed.js'),
    'window.__FP_GEO_SEED=' + JSON.stringify({
        active: true, lat: 49.6116, lng: 6.1319, accuracy: 18, cc: 'LU', city: 'Luxembourg City',
    }) + ';\n', 'utf8');
const mf = JSON.parse(fs.readFileSync(path.join(stage, 'manifest.json'), 'utf8'));
mf.version = '1.2.0';
mf.content_scripts[0].js = ['geo-seed.js', 'geo-spoof.js'];
fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify(mf, null, 2), 'utf8');

const pem = crx.ensureKey(path.join(TMP, 'key.pem'));
const { crx: crxBuf, id } = crx.packDir({ dir: stage, privateKeyPem: pem });
console.log('packed ' + (crxBuf.length / 1024).toFixed(0) + ' KB, id ' + id + '\n');

(async () => {
    const host = new ExtHost({ log, ports: [8081, 8082, 8083] });
    const port = await host.start();
    if (!port) { console.log('FAIL: could not bind a loopback port'); process.exit(1); }
    const updateUrl = host.updateUrl();
    host.setPayload({
        xml: crx.updateManifestXml({ id, version: '1.2.0', codebase: `http://127.0.0.1:${port}/freeproxy-geo.crx` }),
        crx: crxBuf, id, version: '1.2.0',
    });
    console.log('serving ' + updateUrl + '\n');

    const results = [];
    for (const b of BROWSERS) {
        const exe = b.exe.find(p => fs.existsSync(p));
        if (!exe) { console.log(b.name + ': not installed, skipped'); continue; }

        //  Save anything a real administrator already force-installs, so this
        //  test cannot cost the user an extension they depend on.
        const preExisting = sh(`reg query "${b.policy}\\ExtensionInstallForcelist"`) || '';
        const usedSlots = [...preExisting.matchAll(/^\s{4}(\S+)\s+REG_SZ\s+(.*)$/gm)]
            .map(m => ({ name: m[1], data: m[2].trim() }));
        let slot = 1;
        while (usedSlots.some(s => s.name === String(slot))) slot++;
        if (usedSlots.length) console.log(`   (${usedSlots.length} existing forcelist entry(s); using slot ${slot})`);

        assertPolicy(b.policy, String(slot), `${id};${updateUrl}`);

        //  Headless first because it is invisible; if that installs nothing we
        //  cannot tell "loopback URL refused" from "headless skips the
        //  extension updater", so the same browser is retried with a window.
        let found = null, gotManifest = false, gotCrx = false, mode = null;
        for (const headless of [true, false]) {
            HITS.length = 0;
            const udd = path.join(TMP, 'udd-' + b.name + (headless ? '-h' : '-w'));
            const logFile = path.join(TMP, b.name + (headless ? '-h' : '-w') + '.log');
            const out = fs.openSync(logFile, 'w');
            const args = [
                `--user-data-dir=${udd}`,
                '--no-first-run', '--no-default-browser-check', '--disable-sync',
                '--no-service-autorun', '--enable-logging=stderr', '--log-level=0',
            ];
            if (headless) args.push('--headless=new');
            else args.push('--window-size=500,400', '--window-position=0,0');
            args.push('about:blank');

            const child = spawn(exe, args, { stdio: ['ignore', out, out], windowsHide: true });

            const extDir = path.join(udd, 'Default', 'Extensions', id);
            for (let i = 0; i < 45; i++) {
                await sleep(1000);
                if (fs.existsSync(extDir)) {
                    try {
                        const v = fs.readdirSync(extDir)[0];
                        if (v && fs.existsSync(path.join(extDir, v, 'manifest.json'))) { found = v; break; }
                    } catch (e) {}
                }
            }

            try { child.kill(); } catch (e) {}
            await sleep(1200);
            sh(`taskkill /F /PID ${child.pid} 2>nul`);
            try { fs.closeSync(out); } catch (e) {}

            gotManifest = gotManifest || HITS.some(h => h.includes('update manifest served'));
            gotCrx      = gotCrx      || HITS.some(h => h.includes('package downloaded'));
            mode = headless ? 'headless' : 'windowed';

            try {
                const txt = fs.readFileSync(logFile, 'utf8');
                const lines = txt.split(/\r?\n/).filter(l =>
                    /extension|crx|forcelist|install|verif|signature|policy/i.test(l) &&
                    !/garbage collection|activity_log|cloud_management/i.test(l));
                if (lines.length) {
                    console.log(`   ${b.name} (${mode}) log:`);
                    for (const l of lines.slice(0, 12)) console.log('     ' + l.trim().slice(0, 195));
                }
            } catch (e) {}

            if (found) break;
        }

        let verdict;
        if (found)            verdict = `INSTALLED (${mode}, unpacked as ${found})`;
        else if (gotCrx)      verdict = 'downloaded but NOT installed -- package refused';
        else if (gotManifest) verdict = 'manifest fetched, .crx never requested';
        else                  verdict = 'no request in either mode -- policy or URL rejected';

        console.log(`${b.name}: ${verdict}`);
        console.log(`   manifest fetched: ${gotManifest}   crx fetched: ${gotCrx}\n`);

        results.push({ name: b.name, found: !!found, gotManifest, gotCrx, mode });

        sh(`reg delete "${b.policy}\\ExtensionInstallForcelist" /v "${slot}" /f`);
        //  Put back exactly what was there, and only remove the subkey if we
        //  are the reason it exists.
        if (!usedSlots.length) sh(`reg delete "${b.policy}\\ExtensionInstallForcelist" /f`);
    }

    host.stop();
    console.log('── summary ──');
    for (const r of results) {
        console.log(`  ${r.name.padEnd(7)} install=${r.found ? 'YES (' + r.mode + ')' : 'no '}` +
                    `  manifest=${r.gotManifest}  crx=${r.gotCrx}`);
    }
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
    process.exit(results.length && results.every(r => r.found) ? 0 : 1);
})().catch(e => { console.log('ABORT: ' + e.message); process.exit(3); });
