'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/probe-d1-rows.js -- D1: how many FreeProxy rows can Chrome draw,
//  which ids are they, and where did each id come from?  READ ONLY.
//
//  Chromium ids come from exactly two places:
//    key present in manifest -> GenerateId(base64decode(key))
//    key absent              -> GenerateIdForPath(dir)
//  and GenerateIdForPath on Windows hashes base::FilePath::StringType, i.e.
//  UTF-16LE, with the drive letter upper-cased (crx_file/id_util.cc,
//  MaybeNormalizePath). Hashing UTF-8 gives a different answer, which is the
//  trap the earlier probe fell into.
// ════════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const mp = buf => [...crypto.createHash('sha256').update(buf).digest().subarray(0, 16)]
    .map(b => String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 15))).join('');

//  crx_file::id_util::GenerateIdForPath
function idForPath(p) {
    let s = p;
    if (s.length >= 2 && s[1] === ':' && s[0] >= 'a' && s[0] <= 'z')
        s = s[0].toUpperCase() + s.slice(1);
    return mp(Buffer.from(s, 'utf16le'));
}
const idForKey = b64 => mp(Buffer.from(b64, 'base64'));

const LOCAL = process.env.LOCALAPPDATA;
const CHROME = path.join(LOCAL, 'Google', 'Chrome', 'User Data');

//  Every path this app has ever pointed a browser at, plus the ones the
//  profile itself names.
const CANDIDATE_PATHS = [
    'C:\\ProgramData\\freeproxy-vpn\\browser-setup\\extension',
    'C:\\Program Files\\FreeProxy VPN\\resources\\Extension',
    'C:\\Program Files\\FreeProxy VPN\\resources\\app.asar.unpacked\\Extension',
    'G:\\Personal Project\\Free-VPN-Extension',
    'G:\\Personal-Project\\FreeVPN-PC-App\\Extension',
    'G:\\Personal-Project\\FreeVPN-PC-App\\Extension-Store\\package',
    'C:\\ProgramData\\freeproxy-vpn\\extension',
];

console.log('═════ 1. path -> id, the way Chromium does it ═════');
for (const p of CANDIDATE_PATHS) {
    console.log(`  ${idForPath(p)}   exists=${fs.existsSync(p) ? 'YES' : 'no '}  ${p}`);
}

console.log('\n═════ 2. key -> id, for every key on disk ═════');
const keyFiles = [];
const scan = (dir, depth) => {
    if (depth > 3) return;
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
        const f = path.join(dir, e.name);
        if (e.isDirectory()) scan(f, depth + 1);
        else if (/\.pem$/i.test(e.name)) keyFiles.push(f);
        else if (e.name === 'manifest.json') {
            try {
                const m = JSON.parse(fs.readFileSync(f, 'utf8'));
                if (m.key) console.log(`  ${idForKey(m.key)}   manifest key   ${f}`);
            } catch (err) { /* not ours */ }
        }
    }
};
for (const d of ['C:\\ProgramData\\freeproxy-vpn',
                 'G:\\Personal-Project\\FreeVPN-PC-App\\Extension',
                 'G:\\Personal-Project\\FreeVPN-PC-App\\Extension-Store']) scan(d, 0);
for (const f of keyFiles) {
    try {
        const pem = fs.readFileSync(f, 'utf8');
        const pub = crypto.createPublicKey(crypto.createPrivateKey(pem))
            .export({ type: 'spki', format: 'der' });
        console.log(`  ${mp(pub)}   private key    ${f}   mtime ${fs.statSync(f).mtime.toISOString()}`);
    } catch (e) { console.log(`  -- ${f}: ${e.message.split('\n')[0]}`); }
}

console.log('\n═════ 3. every Chrome record whose id or path smells FreeProxy ═════');
const WANT = /freeproxy|free-vpn|freevpn/i;
const ts = n => {  //  Chromium's microseconds-since-1601
    const v = Number(n);
    if (!Number.isFinite(v) || v <= 0) return String(n);
    return new Date(v / 1000 - 11644473600000).toISOString();
};
for (const prof of ['Default']) {
    for (const file of ['Preferences', 'Secure Preferences']) {
        let j;
        try { j = JSON.parse(fs.readFileSync(path.join(CHROME, prof, file), 'utf8')); }
        catch (e) { console.log(`  ${file}: ${e.code}`); continue; }
        const s = (j.extensions && j.extensions.settings) || {};
        for (const [id, rec] of Object.entries(s)) {
            const name = (rec.manifest && rec.manifest.name) || '';
            const p = rec.path || '';
            if (!WANT.test(name) && !WANT.test(p)) continue;
            const folderOnDisk = path.isAbsolute(p)
                ? fs.existsSync(p)
                : fs.existsSync(path.join(CHROME, prof, 'Extensions', p));
            console.log(`\n  ── ${id}   (${file})`);
            console.log(`     location        ${rec.location}   state ${rec.state}   disable ${JSON.stringify(rec.disable_reasons)}`);
            console.log(`     name            ${name || '(NO cached manifest)'}`);
            console.log(`     path            ${p || '(none)'}`);
            console.log(`     PATH ON DISK    ${folderOnDisk ? 'PRESENT' : 'MISSING'}`);
            console.log(`     creation_flags  ${rec.creation_flags}`);
            console.log(`     first_install   ${rec.first_install_time ? ts(rec.first_install_time) : '(none)'}`);
            console.log(`     last_update     ${rec.last_update_time ? ts(rec.last_update_time) : '(none)'}`);
            console.log(`     sw started      ${rec.has_started_service_worker}`);
            console.log(`     idForPath(path) ${p && path.isAbsolute(p) ? idForPath(p) + (idForPath(p) === id ? '  == THIS ID (path-derived)' : '  != this id (so key-derived)') : '(relative path -- packed)'}`);
            console.log(`     all keys        ${JSON.stringify(Object.keys(rec))}`);
        }
    }
}

console.log('\n═════ 4. Local Extension Settings dirs (an id that RAN) ═════');
const les = path.join(CHROME, 'Default', 'Local Extension Settings');
try {
    for (const d of fs.readdirSync(les)) {
        let inner = [];
        try {
            inner = fs.readdirSync(path.join(les, d))
                .map(f => `${f}:${fs.statSync(path.join(les, d, f)).mtime.toISOString()}`);
        } catch (e) {}
        console.log(`  ${d}  dir-mtime ${fs.statSync(path.join(les, d)).mtime.toISOString()}`);
        for (const i of inner) console.log(`      ${i}`);
    }
} catch (e) { console.log('  -- ' + e.code); }
