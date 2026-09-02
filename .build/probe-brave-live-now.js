'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/probe-brave-live-now.js  --  is the watchdog actually IN Brave,
//  and is anything running that would explain the proxy still being set?
//  READ ONLY.
//
//  The previous probe overturned the working theory: the stuck proxy in Brave
//  is NOT on the old fossil id, it is on the LIVE id
//  bmdkiblidpidilbeebghppkifmdhheog -- the extension we ship, in the copy Brave
//  installed at 21:40:51 UTC on 2026-09-01, whose granted permissions already
//  include `alarms`. Chrome and Edge hold the same extension with an EMPTY
//  preferences bucket, which is exactly why only Brave loses the internet.
//
//  So the question is no longer "which extension holds it". It is "why has the
//  guard not released it", and that has only a handful of possible answers:
//
//    * the bytes Brave unpacked do not contain the guard (a stale CRX)
//    * Brave has not started since the pref was written, so no alarm has run
//    * the app IS running and connected, in which case the pref is correct and
//      the user's complaint is about a different moment
//    * the alarm is registered but Chromium clamped or dropped it
//
//  Each one is a different fix, so the state gets read before anything is
//  written.
// ════════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const net = require('net');
const { execFileSync } = require('child_process');

const LOCAL = process.env.LOCALAPPDATA || '';
const LIVE = 'bmdkiblidpidilbeebghppkifmdhheog';
const BRAVE = path.join(LOCAL, 'BraveSoftware', 'Brave-Browser', 'User Data');

const chromeTime = us => {
    const n = Number(us);
    if (!Number.isFinite(n) || !n) return '(none)';
    return new Date(n / 1000 - 11644473600000).toISOString();
};

console.log('══════════ 1. what is running right now ══════════');
try {
    const out = execFileSync('tasklist.exe', ['/fo', 'csv', '/nh'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const want = /^"(FreeProxy VPN\.exe|brave\.exe|chrome\.exe|msedge\.exe|tor\.exe)"/i;
    const tally = {};
    out.split(/\r?\n/).filter(l => want.test(l)).forEach(l => {
        const name = l.split('","')[0].replace(/"/g, '');
        tally[name] = (tally[name] || 0) + 1;
    });
    const names = ['FreeProxy VPN.exe', 'tor.exe', 'brave.exe', 'chrome.exe', 'msedge.exe'];
    names.forEach(n => console.log(`  ${n.padEnd(20)} ${tally[n] ? tally[n] + ' process(es)' : 'not running'}`));
} catch (e) { console.log('  tasklist failed: ' + e.message); }

const probe = port => new Promise(res => {
    const s = net.connect({ host: '127.0.0.1', port });
    const done = v => { try { s.destroy(); } catch (e) {} res(v); };
    s.setTimeout(1200);
    s.on('connect', () => done('OPEN'));
    s.on('timeout', () => done('timeout'));
    s.on('error', () => done('refused'));
});

(async () => {
    for (const p of [9050, 9051, 8080, 8081]) {
        const label = { 9050: 'Tor SOCKS (what the proxy pref points at)',
                        9051: 'Tor control', 8080: 'the extension WebSocket',
                        8081: 'the extension delivery host' }[p];
        console.log(`  127.0.0.1:${p}  ${(await probe(p)).padEnd(8)} ${label}`);
    }

    console.log('\n══════════ 2. the bytes Brave actually unpacked ══════════');
    let versions = [];
    const extRoot = path.join(BRAVE, 'Default', 'Extensions', LIVE);
    try { versions = fs.readdirSync(extRoot).sort(); }
    catch (e) { console.log('  no unpacked copy at ' + extRoot + ' (' + e.code + ')'); }
    for (const v of versions) {
        const bgPath = path.join(extRoot, v, 'background.js');
        const mfPath = path.join(extRoot, v, 'manifest.json');
        let bg = '', mf = null;
        try { bg = fs.readFileSync(bgPath, 'utf8'); } catch (e) {}
        try { mf = JSON.parse(fs.readFileSync(mfPath, 'utf8')); } catch (e) {}
        console.log(`\n  ── ${v}`);
        console.log('     manifest version   ' + (mf ? mf.version : '?') +
                    '   permissions ' + (mf ? (mf.permissions || []).join(',') : '?'));
        console.log('     background.js      ' + bg.length + ' bytes, mtime ' +
                    (() => { try { return fs.statSync(bgPath).mtime.toISOString(); } catch (e) { return '?'; } })());
        console.log("     'fp-proxy-guard'   " + (bg.includes('fp-proxy-guard') ? 'PRESENT' : 'ABSENT'));
        console.log('     armProxyGuard      ' + (bg.includes('armProxyGuard') ? 'PRESENT' : 'ABSENT'));
        console.log('     onAlarm listener    ' + (bg.includes('chrome.alarms.onAlarm.addListener') ? 'PRESENT' : 'ABSENT'));
        //  The clear at module scope: the other half of the repair.
        const mod = bg.includes('setBrowserProxy(false)');
        console.log('     setBrowserProxy(false) call  ' + (mod ? 'PRESENT' : 'ABSENT'));
    }

    console.log('\n══════════ 3. when Brave last wrote that pref ══════════');
    for (const f of ['Secure Preferences', 'Preferences']) {
        const p = path.join(BRAVE, 'Default', f);
        try { console.log(`  ${f.padEnd(20)} mtime ${fs.statSync(p).mtime.toISOString()}`); }
        catch (e) { console.log(`  ${f}: ${e.code}`); }
    }
    const sp = (() => { try { return JSON.parse(fs.readFileSync(path.join(BRAVE, 'Default', 'Secure Preferences'), 'utf8')); } catch (e) { return null; } })();
    const rec = sp && sp.extensions && sp.extensions.settings && sp.extensions.settings[LIVE];
    if (rec) {
        console.log('  first_install_time  ' + chromeTime(rec.first_install_time));
        console.log('  last_update_time    ' + chromeTime(rec.last_update_time));
        console.log('  proxy pref          ' + JSON.stringify((rec.preferences || {}).proxy));
        console.log('  has_started_service_worker  ' + JSON.stringify(rec.has_started_service_worker));
    }

    //  Alarms live in the extension's own Local Extension Settings LevelDB for
    //  some builds and in a separate store for others; the log entries are the
    //  reliable read, so just show whether any file there mentions our name.
    console.log('\n══════════ 4. any trace of the alarm in Brave\'s profile ══════════');
    const roots = [path.join(BRAVE, 'Default', 'Local Extension Settings', LIVE),
                   path.join(BRAVE, 'Default', 'Extension State')];
    for (const r of roots) {
        let files = [];
        try { files = fs.readdirSync(r); } catch (e) { console.log('  ' + r + ' -> ' + e.code); continue; }
        let hit = 0;
        for (const f of files) {
            let b = Buffer.alloc(0);
            try { b = fs.readFileSync(path.join(r, f)); } catch (e) { continue; }
            if (b.includes('fp-proxy-guard')) { hit++; console.log(`  ${path.basename(r)}/${f}: mentions fp-proxy-guard`); }
        }
        if (!hit) console.log('  ' + path.basename(r) + ': ' + files.length +
                              ' file(s), none mention fp-proxy-guard');
    }

    console.log('\nNothing was modified.');
})();
