'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/probe-brave-start-clears.js  --  does starting Brave release the
//  stale proxy pref? The one question problem 1 turns on.
//
//  What is already measured:
//    * the stuck pref belongs to the LIVE extension id, in Brave/Default
//    * the copy Brave unpacked DOES contain the guard, the onAlarm listener
//      and the module-scope setBrowserProxy(false)
//    * Brave's alarm store already mentions fp-proxy-guard
//    * Secure Preferences was last written 2026-09-01T22:02:09Z, the moment the
//      app connected -- so BRAVE HAS NOT STARTED SINCE THE PREF WAS SET, and
//      no code of ours has had a chance to run against it yet
//
//  So "Brave still has no internet" was observed before the release code could
//  possibly have run. That is a claim about the future, and this project does
//  not ship claims: start Brave with the app down and read the pref back.
//
//  --no-startup-window: the profile loads and the extension worker runs, which
//  is the whole mechanism under test, without throwing a window in the user's
//  face. Brave is left running only if it was already running before this
//  started; otherwise it is closed again at the end.
// ════════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const LOCAL = process.env.LOCALAPPDATA || '';
const LIVE = 'bmdkiblidpidilbeebghppkifmdhheog';
const SP = path.join(LOCAL, 'BraveSoftware', 'Brave-Browser', 'User Data', 'Default', 'Secure Preferences');

const CANDIDATES = [
    path.join(process.env['ProgramFiles'] || 'C:\\Program Files',
              'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
              'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    path.join(LOCAL, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
];

const readPref = () => {
    try {
        const p = JSON.parse(fs.readFileSync(SP, 'utf8'));
        const e = ((p.extensions || {}).settings || {})[LIVE] || {};
        return (e.preferences || {}).proxy;
    } catch (e) { return '(unreadable: ' + e.code + ')'; }
};
const running = name => {
    try {
        const out = execFileSync('tasklist.exe', ['/fi', `imagename eq ${name}`, '/fo', 'csv', '/nh'],
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        return new RegExp('"' + name.replace('.', '\\.') + '"', 'i').test(out);
    } catch (e) { return false; }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
    const exe = CANDIDATES.find(p => fs.existsSync(p));
    console.log('brave.exe            ' + (exe || 'NOT FOUND -- cannot test'));
    if (!exe) process.exit(2);

    const wasRunning = running('brave.exe');
    console.log('brave already running ' + wasRunning);
    console.log('mtime before          ' + fs.statSync(SP).mtime.toISOString());
    console.log('proxy pref before     ' + JSON.stringify(readPref()));
    console.log('\n── starting Brave with no window ──');

    const child = spawn(exe, ['--no-startup-window'],
        { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();

    const t0 = Date.now();
    let cleared = false;
    for (let i = 0; i < 40; i++) {                 // up to 40 s
        await sleep(1000);
        const now = readPref();
        const secs = ((Date.now() - t0) / 1000).toFixed(1);
        if (now === undefined) {
            console.log(`  +${secs}s  the proxy pref is GONE -- the worker released it`);
            cleared = true;
            break;
        }
        if (i % 4 === 0) console.log(`  +${secs}s  still ${JSON.stringify(now)}`);
    }

    console.log('\nmtime after           ' + fs.statSync(SP).mtime.toISOString());
    console.log('proxy pref after      ' + JSON.stringify(readPref()));
    console.log('verdict               ' + (cleared
        ? 'a Brave start DOES release it -- the release code in the installed copy works'
        : 'STILL SET after 40 s -- the release code did not run or could not run'));

    if (!wasRunning && running('brave.exe')) {
        console.log('\n── closing the Brave this probe started ──');
        try {
            execFileSync('taskkill.exe', ['/im', 'brave.exe', '/t', '/f'],
                { stdio: 'ignore', windowsHide: true });
            console.log('  closed');
        } catch (e) { console.log('  could not close it: ' + e.message); }
        await sleep(2000);
        console.log('  proxy pref after close  ' + JSON.stringify(readPref()));
    }
})();
