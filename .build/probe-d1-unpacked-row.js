'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/probe-d1-unpacked-row.js -- does a stale UNPACKED record still draw
//  a row on chrome://extensions?
//
//  The user's Chrome holds three location-4 records besides the real install:
//    aoadoifmonclfkfmabohfhbigmioaanp  path G:\Personal Project\Free-VPN-Extension  MISSING
//    imlmcdmjclmlkhgljdokgjepcppgjfob  path C:\Program Files\FreeProxy VPN\resources\Extension  MISSING
//    egclniilmgnaildaaiccpmakehnhledg  path C:\ProgramData\...\browser-setup\extension  PRESENT,
//                                      but that folder's manifest key now yields a DIFFERENT id
//  This reproduces both shapes in a THROWAWAY profile under os.tmpdir() and reads
//  the answer out of the throwaway profile's own Secure Preferences.
//
//  Nothing here touches the user's browser profiles. Chrome is launched with an
//  explicit --user-data-dir under the temp dir and killed by PID.
// ════════════════════════════════════════════════════════════════════
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const SRC = 'C:\\ProgramData\\freeproxy-vpn\\browser-setup\\extension';

//  realpathSync.native: node's mkdtemp hands back the 8.3 form (USERPC~1) and
//  the extension id is a hash of the PATH, so the short form would give a
//  different id than the one Chromium computes from the long one.
const TMP = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'd1row-')));
const UD = path.join(TMP, 'ud');
const EXT = path.join(TMP, 'ext');

const mp = buf => [...crypto.createHash('sha256').update(buf).digest().subarray(0, 16)]
    .map(b => String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 15))).join('');
function idForPath(p) {
    let s = p;
    if (s.length >= 2 && s[1] === ':' && s[0] >= 'a' && s[0] <= 'z') s = s[0].toUpperCase() + s.slice(1);
    return mp(Buffer.from(s, 'utf16le'));
}
const idForKey = b64 => mp(Buffer.from(b64, 'base64'));

function copyTree(src, dst) {
    fs.mkdirSync(dst, { recursive: true });
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
        const s = path.join(src, e.name), d = path.join(dst, e.name);
        if (e.isDirectory()) copyTree(s, d); else fs.copyFileSync(s, d);
    }
}

function runChrome(label, extraArgs) {
    const args = ['--user-data-dir=' + UD, '--no-first-run', '--no-default-browser-check',
                  '--disable-background-networking', '--headless', '--dump-dom',
                  ...extraArgs, 'about:blank'];
    const t0 = Date.now();
    const r = spawnSync(CHROME, args, { encoding: 'utf8', timeout: 90000, windowsHide: true });
    console.log(`   [${label}] exit=${r.status} ${Date.now() - t0} ms`);
    const err = String(r.stderr || '');
    for (const l of err.split(/\r?\n/)) {
        if (/load-extension|not allowed|extension/i.test(l) && l.trim()) console.log('      stderr: ' + l.trim());
    }
}

function readIds(label) {
    const out = [];
    for (const f of ['Preferences', 'Secure Preferences']) {
        let j;
        try { j = JSON.parse(fs.readFileSync(path.join(UD, 'Default', f), 'utf8')); } catch (e) { continue; }
        const s = (j.extensions && j.extensions.settings) || {};
        for (const [id, rec] of Object.entries(s)) {
            if (rec.location === 5) continue;                     // component, not a row
            if (rec.manifest && /Chrome|Google|Web Store|PDF|Hangout|speech/i.test(rec.manifest.name || '')) continue;
            out.push({ id, file: f, location: rec.location, state: rec.state,
                       name: (rec.manifest && rec.manifest.name) || '(no manifest)',
                       pathv: rec.path || '', keys: Object.keys(rec).length });
        }
    }
    console.log(`   [${label}] non-component records: ${out.length}`);
    for (const r of out)
        console.log(`      ${r.id}  loc ${r.location}  state ${r.state}  keys ${r.keys}  ` +
                    `"${r.name}"  path=${r.pathv}`);
    return out;
}

console.log('tmp = ' + TMP);
copyTree(SRC, EXT);

// ── run 1: KEYLESS folder, so the id must come from the path ──────────
const mf = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
const REALKEY = mf.key;
delete mf.key;
fs.writeFileSync(path.join(EXT, 'manifest.json'), JSON.stringify(mf, null, 2));
console.log('\n══ run 1: --load-extension on a KEYLESS folder');
console.log('   expect id = idForPath(EXT) = ' + idForPath(EXT));
runChrome('run1', ['--load-extension=' + EXT, '--enable-unsafe-extension-debugging']);
readIds('run1');

// ── run 2: same folder, key ADDED -> the folder's identity moves ──────
mf.key = REALKEY;
fs.writeFileSync(path.join(EXT, 'manifest.json'), JSON.stringify(mf, null, 2));
console.log('\n══ run 2: SAME profile, key added -> folder now hashes to ' + idForKey(REALKEY));
console.log('   does the old path-derived record survive as a SECOND row?');
runChrome('run2', ['--load-extension=' + EXT, '--enable-unsafe-extension-debugging']);
readIds('run2');

// ── run 3: same profile, NO --load-extension, folder still present ────
console.log('\n══ run 3: SAME profile, no --load-extension flag, folder still on disk');
runChrome('run3', []);
readIds('run3');

// ── run 4: same profile, folder DELETED (the imlmcdmj / aoadoifmon shape) ──
fs.rmSync(EXT, { recursive: true, force: true });
console.log('\n══ run 4: SAME profile, folder DELETED from disk');
runChrome('run4', []);
readIds('run4');

console.log('\ntmp left in place for inspection: ' + TMP);
