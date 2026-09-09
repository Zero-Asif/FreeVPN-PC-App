'use strict';
//  The user's Chrome shows TWO "FreeProxy VPN Extension" rows. Chrome keys
//  extensions by id, so two rows means two ids. This reads the ground truth
//  out of every Chromium profile on the machine -- id, name, version, install
//  location, disable reasons, path -- and then every place this app could have
//  named an id: the signing key, the recorded bundle, the three policies and
//  the per-fork external-extensions key.
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const B = require('../lib/browsers.js');
const crx = require('../lib/crx.js');

const STATE = path.join(process.env.ProgramData || 'C:\\ProgramData', 'freeproxy-vpn');

//  Chromium's install locations, extensions/common/mojom/manifest.mojom.
const LOC = { 1: 'INTERNAL', 2: 'EXTERNAL_PREF', 3: 'EXTERNAL_REGISTRY',
              4: 'UNPACKED', 5: 'COMPONENT', 6: 'EXTERNAL_PREF_DOWNLOAD',
              7: 'EXTERNAL_POLICY_DOWNLOAD', 8: 'EXTERNAL_COMPONENT',
              9: 'EXTERNAL_POLICY', 10: 'COMMAND_LINE' };

console.log('── what this app thinks the id is ──');
let ourId = null;
try {
    ourId = crx.idForKey(fs.readFileSync(path.join(STATE, 'ext-key.pem'), 'utf8'));
    const st = fs.statSync(path.join(STATE, 'ext-key.pem'));
    console.log(`   ext-key.pem     ${ourId}   written ${st.mtime.toISOString()}`);
} catch (e) { console.log('   ext-key.pem     -- ' + e.code); }
for (const f of ['ext-restore.json', 'ext-bundle.json']) {
    try {
        const j = JSON.parse(fs.readFileSync(path.join(STATE, f), 'utf8'));
        console.log(`   ${f.padEnd(16)}${JSON.stringify(j)}`);
    } catch (e) { console.log(`   ${f.padEnd(16)}-- ${e.code}`); }
}
//  Any OTHER key or staged manifest lying around would be a second id.
const staged = path.join(STATE, 'browser-setup', 'extension', 'manifest.json');
try {
    const mf = JSON.parse(fs.readFileSync(staged, 'utf8'));
    console.log(`   staged manifest v${mf.version}  key -> ` +
                (mf.key ? crx.crxIdString(Buffer.from(mf.key, 'base64')) : 'NO KEY FIELD'));
} catch (e) { console.log('   staged manifest -- ' + e.code); }

console.log('');
console.log('── every FreeProxy row in every Chromium profile ──');
const found = B.detect();
const ud = B.chromiumUserData();
const seenIds = new Set();
for (const [id, root] of Object.entries(ud)) {
    let profiles = [];
    try {
        profiles = fs.readdirSync(root).filter(n => {
            if (n !== 'Default' && !/^Profile \d+$/.test(n)) return false;
            return fs.existsSync(path.join(root, n, 'Preferences'));
        });
    } catch (e) { continue; }
    for (const p of profiles) {
        for (const file of ['Preferences', 'Secure Preferences']) {
            let j;
            try { j = JSON.parse(fs.readFileSync(path.join(root, p, file), 'utf8')); }
            catch (e) { continue; }
            const settings = (j.extensions && j.extensions.settings) || {};
            for (const [extId, rec] of Object.entries(settings)) {
                const name = (rec.manifest && rec.manifest.name) || '';
                if (!/freeproxy/i.test(name) && extId !== ourId) continue;
                seenIds.add(extId);
                console.log(`   ${id}/${p}  ${file}`);
                console.log(`     id           ${extId}${extId === ourId ? '   <- OUR KEY' : '   <- NOT our key'}`);
                console.log(`     name         ${name}`);
                console.log(`     version      ${(rec.manifest && rec.manifest.version) || '?'}`);
                console.log(`     location     ${rec.location} (${LOC[rec.location] || '?'})`);
                console.log(`     state        ${rec.state}${rec.state === 1 ? ' ENABLED' : rec.state === 0 ? ' DISABLED' : ''}`);
                console.log(`     disable      ${JSON.stringify(rec.disable_reasons || [])}`);
                console.log(`     path         ${rec.path || '(profile-relative)'}`);
                console.log(`     from_webstore ${rec.from_webstore}   ack_external ${rec.ack_external}`);
                console.log(`     manifest.key ${rec.manifest && rec.manifest.key ? 'present' : 'ABSENT'}`);
            }
        }
        //  A row can also exist only as an unpacked dir the browser remembers.
        const extDir = path.join(root, p, 'Extensions');
        if (ourId && fs.existsSync(path.join(extDir, ourId))) {
            let vers = [];
            try { vers = fs.readdirSync(path.join(extDir, ourId)); } catch (e) {}
            console.log(`   ${id}/${p}  Extensions\\${ourId}  ${vers.join(', ')}`);
        }
    }
}
if (!seenIds.size) console.log('   (none found in any profile)');
console.log(`   DISTINCT IDS SEEN: ${seenIds.size}  ${[...seenIds].join(' ')}`);

console.log('');
console.log('── every id this app has written into the registry ──');
const q = (k) => {
    try {
        return execSync(`reg query "${k}" /s`, { encoding: 'utf8', windowsHide: true,
            stdio: 'pipe', maxBuffer: 8 << 20, timeout: 20000 });
    } catch (e) { return String((e && e.stdout) || ''); }
};
for (const b of B.CHROMIUM) {
    if (!b.policy) continue;
    const out = q('HKLM\\' + b.policy);
    const hits = out.split(/\r?\n/).filter(l =>
        /ExtensionInstallForcelist|ExtensionSettings|ExtensionInstallAllowlist/.test(l) ||
        /^\s+\d+\s+REG_SZ/.test(l) || /[a-p]{32}/.test(l));
    if (hits.length) {
        console.log(`   ${b.id}  HKLM\\${b.policy}`);
        for (const h of hits) console.log('     ' + h.trim());
    }
}
//  Route 3: the fork's own external-extensions key, both registry views.
for (const b of B.CHROMIUM) {
    if (!b.extKey) continue;
    for (const view of ['SOFTWARE', 'SOFTWARE\\WOW6432Node']) {
        const k = `HKLM\\${view}\\${b.extKey}`.replace(/SOFTWARE\\SOFTWARE/, 'SOFTWARE');
        const out = q(k);
        if (/[a-p]{32}/.test(out)) {
            console.log(`   ${b.id}  ${k}`);
            for (const l of out.split(/\r?\n/)) if (l.trim()) console.log('     ' + l.trim());
        }
    }
}
//  ...and whatever the table calls it, catch every external key by brute force.
for (const hive of ['HKLM', 'HKCU']) {
    for (const vendor of ['Google\\Chrome', 'Microsoft\\Edge', 'BraveSoftware\\Brave-Browser',
                          'Chromium', 'Vivaldi', 'Yandex\\YandexBrowser']) {
        for (const view of ['SOFTWARE', 'SOFTWARE\\WOW6432Node']) {
            const k = `${hive}\\${view}\\${vendor}\\Extensions`;
            const out = q(k);
            if (/[a-p]{32}/.test(out)) {
                console.log(`   EXTERNAL  ${k}`);
                for (const l of out.split(/\r?\n/)) if (l.trim()) console.log('     ' + l.trim());
            }
        }
    }
}
