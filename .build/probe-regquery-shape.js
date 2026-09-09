//  probe-regquery-cost.js proved the cost is the SPAWN, not the walk: a `reg /?`
//  that reads nothing costs 176 ms, and a 47-subkey recursive walk costs 268 ms.
//  Eight spawns is the 1.8 s. So the only lever is spawn COUNT. This times the
//  three ways to get the same eight answers, and diffs their output so a cheaper
//  one is only cheaper if it says the same thing.
'use strict';
const { execSync, execFileSync } = require('child_process');

const KEYS = [];
for (const root of ['HKEY_LOCAL_MACHINE', 'HKEY_CURRENT_USER']) {
    for (const soft of ['SOFTWARE', 'SOFTWARE\\WOW6432Node']) {
        KEYS.push(`${root}\\${soft}\\Microsoft\\Windows\\CurrentVersion\\App Paths`);
        KEYS.push(`${root}\\${soft}\\Clients\\StartMenuInternet`);
    }
}

//  Only the (Default) values matter, so compare on those rather than on raw
//  bytes: reg.exe and PowerShell format headers differently and always would.
const defaults = (text) => {
    const map = {};
    let cur = null;
    for (const line of String(text).split(/\r?\n/)) {
        if (/^HKEY_/.test(line)) { cur = line.trim().toLowerCase(); continue; }
        const m = line.match(/^\s+\(Default\)\s+REG_(?:SZ|EXPAND_SZ)\s+(.+)$/);
        if (m && cur) map[cur] = m[1].trim();
    }
    return map;
};
const psDefaults = (text) => {
    const map = {};
    for (const line of String(text).split(/\r?\n/)) {
        const i = line.indexOf('\t');
        if (i > 0) map[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    }
    return map;
};
const time = (fn) => { const t = Date.now(); let r = ''; try { r = fn(); } catch (e) { r = (e.stdout || '') + ''; } return [Date.now() - t, r]; };
const show = (name, ms, map) => console.log(`${String(ms).padStart(6)} ms  ${String(Object.keys(map).length).padStart(3)} defaults  ${name}`);

//  A: what ships. execSync goes through cmd.exe, so this is 8 cmd + 8 reg.
let msA = 0, A = {};
for (const k of KEYS) {
    const [ms, out] = time(() => execSync(`reg query "${k}" /s /ve`,
        { encoding: 'utf8', windowsHide: true, stdio: 'pipe', maxBuffer: 8 << 20 }));
    msA += ms; Object.assign(A, defaults(out));
}
show('A  8x execSync (8 cmd.exe + 8 reg.exe)', msA, A);

//  B: same eight queries, no shell. Halves the process count for free.
let msB = 0, B = {};
for (const k of KEYS) {
    const [ms, out] = time(() => execFileSync('reg', ['query', k, '/s', '/ve'],
        { encoding: 'utf8', windowsHide: true, stdio: 'pipe', maxBuffer: 8 << 20 }));
    msB += ms; Object.assign(B, defaults(out));
}
show('B  8x execFileSync (8 reg.exe only)', msB, B);

//  C: one cmd.exe, eight chained reg.exe. `&` runs the next regardless, which a
//  key that does not exist needs.
const [msC, outC] = time(() => execSync(
    KEYS.map(k => `reg query "${k}" /s /ve`).join(' & '),
    { encoding: 'utf8', windowsHide: true, stdio: 'pipe', maxBuffer: 8 << 20 }));
const C = defaults(outC);
show('C  1 cmd.exe, 8 chained reg.exe', msC, C);

//  D: one PowerShell, no reg.exe at all -- the registry provider reads the eight
//  trees in-process. One spawn total, but a costly one to start.
const PS = KEYS.map(k => k.replace(/^(HKEY_LOCAL_MACHINE|HKEY_CURRENT_USER)/, m =>
    m === 'HKEY_LOCAL_MACHINE' ? 'HKLM:' : 'HKCU:')).map(k => `'${k.replace("'", "''")}'`).join(',');
const script =
    `$ErrorActionPreference='SilentlyContinue';` +
    `foreach($r in @(${PS})){` +
      `foreach($k in Get-ChildItem -Path $r -Recurse){` +
        `$v=$k.GetValue('');` +
        `if($v){"{0}\`t{1}" -f ($k.Name -replace '^HKEY_','HKEY_'),$v}` +
      `}` +
    `}`;
const [msD, outD] = time(() => execFileSync('powershell',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'utf8', windowsHide: true, stdio: 'pipe', maxBuffer: 8 << 20 }));
const D = psDefaults(outD);
show('D  1 powershell, registry provider', msD, D);

console.log('');
//  Cheaper is only cheaper if it agrees. Compared on the paths the table asks
//  about -- App Paths\<exe> and StartMenuInternet\...\shell\open\command --
//  because the full dump also contains keys nothing reads.
//  A ran first and cold, so re-measure the two that matter in the other order.
//  Without this, "C is 3x cheaper" could just be "A paid for the warm-up".
{
    const [msC2] = time(() => execSync(KEYS.map(k => `reg query "${k}" /s /ve`).join(' & '),
        { encoding: 'utf8', windowsHide: true, stdio: 'pipe', maxBuffer: 8 << 20 }));
    let msA2 = 0;
    for (const k of KEYS) {
        const [ms] = time(() => execSync(`reg query "${k}" /s /ve`,
            { encoding: 'utf8', windowsHide: true, stdio: 'pipe', maxBuffer: 8 << 20 }));
        msA2 += ms;
    }
    console.log(`\nreversed order: C ${msC2} ms then A ${msA2} ms`);
}

const WANT = /(\\app paths\\[^\\]+|\\startmenuinternet\\[^\\]+\\shell\\open\\command)$/;
const narrow = (m) => Object.fromEntries(Object.entries(m).filter(([k]) => WANT.test(k)));
const base = narrow(A);
console.log(`the ${Object.keys(base).length} registrations the table asks about:`);
for (const [name, m] of [['B', B], ['C', C], ['D', D]]) {
    const n = narrow(m);
    const missing = Object.keys(base).filter(k => !(k in n));
    const differs = Object.keys(base).filter(k => k in n && n[k] !== base[k]);
    const extra = Object.keys(n).filter(k => !(k in base));
    console.log(`  ${name}: ${Object.keys(n).length} found, ${missing.length} missing, ` +
                `${differs.length} different, ${extra.length} extra` +
                (missing.length ? '\n     missing: ' + missing.slice(0, 4).join('\n              ') : '') +
                (differs.length ? '\n     differs: ' + differs.slice(0, 4).join('\n              ') : ''));
}
