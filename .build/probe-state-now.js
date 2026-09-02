'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/probe-state-now.js  --  one read of everything that decides
//  "does this browser have internet" and "does this browser offer the
//  extension prompt at startup". READ ONLY. Nothing is written.
//
//  Written because two claims are on the table and neither can be argued
//  from the source: (1) Brave still has no internet with the app down,
//  after a rebuilt install and a device restart; (2) the extension-enable
//  prompt no longer appears the first time a browser is opened after that
//  restart, only on the second open. Both are timing/state questions, so
//  the state has to be read, not reasoned about.
// ════════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const LOCAL = process.env.LOCALAPPDATA || '';
const PD = path.join(process.env.ProgramData || 'C:\\ProgramData', 'freeproxy-vpn');

const reg = args => {
    try { return execFileSync('reg.exe', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { return '(absent) ' + String((e.stdout || '') + (e.stderr || '')).trim().split('\n')[0]; }
};
const j = p => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } };

console.log('══════════ 1. the staged extension the browsers load ══════════');
const extDir = path.join(PD, 'browser-setup', 'extension');
const mf = j(path.join(extDir, 'manifest.json'));
let bg = '';
try { bg = fs.readFileSync(path.join(extDir, 'background.js'), 'utf8'); } catch (e) {}
if (!mf) console.log('  manifest.json UNREADABLE at ' + extDir);
else {
    console.log('  dir        ' + extDir);
    console.log('  version    ' + mf.version);
    console.log('  perms      ' + (mf.permissions || []).join(', '));
    console.log('  watchdog   ' + (bg.includes("'fp-proxy-guard'") ? 'PRESENT' : 'ABSENT (old copy)'));
    console.log('  bg bytes   ' + bg.length +
                '   mtime ' + (() => { try { return fs.statSync(path.join(extDir, 'background.js')).mtime.toISOString(); } catch (e) { return '?'; } })());
}
const journal = j(path.join(PD, 'ext-restore.json'));
console.log('  journal    ' + (journal ? JSON.stringify(journal).slice(0, 400) : '(none)'));
const bundle = j(path.join(PD, 'ext-bundle.json')) || j(path.join(PD, 'browser-setup', 'bundle.json'));
console.log('  bundle     ' + (bundle ? JSON.stringify(bundle).slice(0, 300) : '(not at either guessed path)'));
for (const n of (() => { try { return fs.readdirSync(PD).sort(); } catch (e) { return []; } })())
    console.log('  PD entry   ' + n);

console.log('\n══════════ 2. every proxy layer, right now ══════════');
console.log('── WinINET (HKCU Internet Settings) ──');
console.log(reg(['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
                 '/v', 'ProxyEnable']).trim());
console.log(reg(['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
                 '/v', 'ProxyServer']).trim());
for (const [name, key] of [
    ['Brave  policy', 'HKLM\\SOFTWARE\\Policies\\BraveSoftware\\Brave'],
    ['Chrome policy', 'HKLM\\SOFTWARE\\Policies\\Google\\Chrome'],
    ['Edge   policy', 'HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge'],
]) {
    console.log(`\n── ${name}: ProxySettings / ProxyMode ──`);
    const a = reg(['query', key, '/v', 'ProxySettings']);
    const b = reg(['query', key, '/v', 'ProxyMode']);
    console.log('  ProxySettings: ' + a.trim().split('\n').filter(l => /ProxySettings/.test(l)).join(' ') ||
                '  ProxySettings: absent');
    console.log('  ProxyMode    : ' + (b.trim().split('\n').filter(l => /ProxyMode/.test(l)).join(' ') || 'absent'));
}

console.log('\n══════════ 3. the extension record inside each profile ══════════');
const STATE = { 0: 'DISABLED', 1: 'enabled', 2: 'external-uninstalled' };
const LOC = { 1: 'internal(store)', 2: 'external-pref', 3: 'external-registry', 4: 'unpacked',
              5: 'component', 6: 'external-pref-download', 7: 'external-policy-download',
              8: 'command-line', 9: 'external-policy', 10: 'external-component' };
const OURS = mf && mf.key ? null : null;   // id is derived from the key; matched by path below
for (const [browser, root] of [
    ['Brave',  path.join(LOCAL, 'BraveSoftware', 'Brave-Browser', 'User Data')],
    ['Chrome', path.join(LOCAL, 'Google', 'Chrome', 'User Data')],
    ['Edge',   path.join(LOCAL, 'Microsoft', 'Edge', 'User Data')],
]) {
    let dirs = [];
    try {
        dirs = fs.readdirSync(root, { withFileTypes: true })
            .filter(d => d.isDirectory() && (d.name === 'Default' || /^Profile \d+$/.test(d.name)))
            .map(d => path.join(root, d.name));
    } catch (e) { console.log(`\n── ${browser}: no User Data`); continue; }

    for (const dir of dirs) {
        for (const file of ['Preferences', 'Secure Preferences']) {
            const p = j(path.join(dir, file));
            const es = p && p.extensions && p.extensions.settings;
            if (!es) continue;
            for (const id of Object.keys(es)) {
                const e = es[id] || {};
                const isOurs = /freeproxy-vpn/i.test(String(e.path || '')) ||
                               (e.manifest && /FreeProxy/i.test(String(e.manifest.name || '')));
                const hasProxy = ['preferences', 'regular_only_preferences',
                                  'incognito_persistent_preferences', 'incognito_session_only_preferences']
                                 .some(s => e[s] && e[s].proxy !== undefined);
                if (!isOurs && !hasProxy) continue;
                console.log(`\n── ${browser} / ${path.basename(dir)} / ${file}` +
                            (isOurs ? '   ***OURS***' : ''));
                console.log('  id        ' + id);
                console.log('  name      ' + ((e.manifest && e.manifest.name) || '(none recorded)') +
                            '  v' + ((e.manifest && e.manifest.version) || '?'));
                console.log('  path      ' + (e.path || '(none)'));
                console.log('  state     ' + (STATE[e.state] !== undefined ? STATE[e.state] : String(e.state)) +
                            '   location=' + (LOC[e.location] || e.location) +
                            '   disable_reasons=' + JSON.stringify(e.disable_reasons));
                console.log('  granted   ' + JSON.stringify((e.granted_permissions || {}).api || []));
                console.log('  withheld  ' + JSON.stringify((e.withheld_permissions || {}).api || []));
                if (hasProxy) ['preferences', 'regular_only_preferences'].forEach(s => {
                    if (e[s] && e[s].proxy !== undefined)
                        console.log(`  ${s}.proxy  ` + JSON.stringify(e[s].proxy));
                });
            }
        }
        //  Anything Chromium recorded as pending an external install decision.
        const p = j(path.join(dir, 'Preferences'));
        const pend = p && p.extensions && p.extensions.pending_installs;
        if (pend) console.log(`  (${browser}/${path.basename(dir)}) pending_installs: ` +
                              JSON.stringify(pend).slice(0, 200));
    }
}

console.log('\n══════════ 4. the delivery routes in the registry ══════════');
for (const [name, key] of [
    ['Edge   ExtensionSettings', 'HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge\\ExtensionSettings'],
    ['Brave  ExtensionSettings', 'HKLM\\SOFTWARE\\Policies\\BraveSoftware\\Brave\\ExtensionSettings'],
    ['Chrome ExtensionSettings', 'HKLM\\SOFTWARE\\Policies\\Google\\Chrome\\ExtensionSettings'],
    ['Edge   ExtensionInstallForcelist', 'HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge\\ExtensionInstallForcelist'],
    ['Brave  ExtensionInstallForcelist', 'HKLM\\SOFTWARE\\Policies\\BraveSoftware\\Brave\\ExtensionInstallForcelist'],
    ['Chrome ExtensionInstallForcelist', 'HKLM\\SOFTWARE\\Policies\\Google\\Chrome\\ExtensionInstallForcelist'],
    ['Edge   external Extensions', 'HKLM\\SOFTWARE\\Microsoft\\Edge\\Extensions'],
    ['Brave  external Extensions', 'HKLM\\SOFTWARE\\BraveSoftware\\Brave\\Extensions'],
    ['Chrome external Extensions', 'HKLM\\SOFTWARE\\Google\\Chrome\\Extensions'],
    ['Edge   external (WOW6432)', 'HKLM\\SOFTWARE\\Wow6432Node\\Microsoft\\Edge\\Extensions'],
    ['Chrome external (WOW6432)', 'HKLM\\SOFTWARE\\Wow6432Node\\Google\\Chrome\\Extensions'],
]) {
    const out = reg(['query', key, '/s']);
    const t = out.trim();
    console.log(`\n── ${name}`);
    console.log(t.startsWith('(absent)') ? '  ' + t : '  ' + t.split('\n').map(s => s.trim()).filter(Boolean).join('\n  '));
}

console.log('\n══════════ 5. the boot task ══════════');
console.log(reg(['query', 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run', '/s'])
    .split('\n').filter(l => /freeproxy|FreeProxy/i.test(l)).join('\n') || '  (nothing of ours in HKLM Run)');
try {
    const out = execFileSync('schtasks.exe', ['/query', '/fo', 'LIST', '/v'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const blocks = out.split(/\r?\n\r?\n/).filter(b => /freeproxy/i.test(b));
    if (!blocks.length) console.log('  (no scheduled task matching freeproxy)');
    blocks.forEach(b => {
        const pick = re => (b.split('\n').find(l => re.test(l)) || '').trim();
        console.log('  ' + pick(/^TaskName:/));
        console.log('    ' + pick(/^Task To Run:/));
        console.log('    ' + pick(/^Status:/) + '   ' + pick(/^Last Run Time:/));
        console.log('    ' + pick(/^Last Result:/) + '   ' + pick(/^Next Run Time:/));
        console.log('    ' + pick(/^Run As User:/) + '   ' + pick(/^Schedule Type:/));
    });
} catch (e) { console.log('  schtasks failed: ' + e.message); }

console.log('\n══════════ 6. the app log, last extension/proxy lines ══════════');
for (const cand of ['app.log', 'logs/app.log', 'freeproxy.log']) {
    const p = path.join(PD, cand);
    if (!fs.existsSync(p)) continue;
    const lines = fs.readFileSync(p, 'utf8').split('\n');
    console.log('  ' + p + '   (' + lines.length + ' lines)');
    console.log(lines.filter(l => /extension|Extension|proxy|Proxy|forcelist|Forcelist|boot/.test(l))
        .slice(-40).map(l => '    ' + l.slice(0, 200)).join('\n'));
}
const appdataLog = path.join(process.env.APPDATA || '', 'freeproxy-vpn');
try {
    for (const n of fs.readdirSync(appdataLog)) console.log('  APPDATA entry  ' + n);
} catch (e) {}

console.log('\nNothing was modified.');
