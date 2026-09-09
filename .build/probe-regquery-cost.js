//  detect() costs 1700-4400 ms while the 29 filesystem stats inside it cost
//  14 ms (probe-detect-cost.js). The only other thing it does is regExePaths(),
//  which spawns `reg query <root> /s /ve` eight times. This times each spawn
//  separately, and times a do-nothing `reg /?` too, so "reg.exe is slow to
//  start" and "the recursive walk is big" stop looking the same.
'use strict';
const { execSync, execFileSync } = require('child_process');

const APPPATHS_SUB = 'Microsoft\\Windows\\CurrentVersion\\App Paths';
const STARTMENU_SUB = 'Clients\\StartMenuInternet';

const time = (fn) => { const t = Date.now(); let r; try { r = fn(); } catch (e) { r = ''; } return [Date.now() - t, r]; };

//  Spawn cost alone: reg.exe printing its own usage, no registry read at all.
let spawnTotal = 0;
for (let i = 0; i < 4; i++) {
    const [ms] = time(() => execFileSync('reg', ['/?'], { encoding: 'utf8', windowsHide: true, stdio: 'pipe' }));
    spawnTotal += ms;
    console.log(`reg /?            ${String(ms).padStart(5)} ms`);
}
console.log(`bare spawn avg    ${(spawnTotal / 4).toFixed(0)} ms\n`);

const keys = [];
for (const root of ['HKEY_LOCAL_MACHINE', 'HKEY_CURRENT_USER']) {
    for (const soft of ['SOFTWARE', 'SOFTWARE\\WOW6432Node']) {
        keys.push(`${root}\\${soft}\\${APPPATHS_SUB}`);
        keys.push(`${root}\\${soft}\\${STARTMENU_SUB}`);
    }
}

for (const pass of [1, 2]) {
    let total = 0;
    console.log(`── pass ${pass}: the eight queries regExePaths() makes ──`);
    for (const k of keys) {
        const [ms, out] = time(() => execSync(`reg query "${k}" /s /ve`,
            { encoding: 'utf8', windowsHide: true, stdio: 'pipe', maxBuffer: 8 << 20 }));
        const subkeys = (String(out).match(/^HKEY_/gm) || []).length;
        total += ms;
        console.log(`${String(ms).padStart(6)} ms  ${String(subkeys).padStart(4)} subkeys  ${k.replace('HKEY_LOCAL_MACHINE', 'HKLM').replace('HKEY_CURRENT_USER', 'HKCU')}`);
    }
    console.log(`${String(total).padStart(6)} ms  TOTAL\n`);
}

//  What it would cost WITHOUT /s -- one key, no recursive walk. App Paths\<exe>
//  and StartMenuInternet\<key>\shell\open\command are both exact paths that the
//  table already names, so the recursion may be buying nothing.
console.log('── the same answers without /s, asked exactly ──');
const B = require('../lib/browsers.js');
let exact = 0, hits = 0;
for (const b of B.ALL) {
    for (const root of ['HKEY_LOCAL_MACHINE', 'HKEY_CURRENT_USER']) {
        const k = `${root}\\SOFTWARE\\${APPPATHS_SUB}\\${b.exe}`;
        const [ms, out] = time(() => execSync(`reg query "${k}" /ve`,
            { encoding: 'utf8', windowsHide: true, stdio: 'pipe' }));
        exact += ms;
        if (/REG_(SZ|EXPAND_SZ)/.test(String(out))) hits++;
    }
}
console.log(`${String(exact).padStart(6)} ms for ${B.ALL.length * 2} exact queries, ${hits} with a value`);
