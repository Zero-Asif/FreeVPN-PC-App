'use strict';
// ════════════════════════════════════════════════════════════════════
//  probe-runningbrowsers-cost.js -- what runningBrowsers() costs the pump.
//
//  main.js:6662 runs one SYNCHRONOUS `tasklist /FI "IMAGENAME eq <exe>" /NH`
//  per browser, on Electron's main thread, on every connect and every switch.
//  This measures the shipped shape against the one-spawn shape, so the fix is
//  chosen on a number rather than on the fact that N spawns looks wrong.
//
//  Read-only: tasklist enumerates, it does not signal or close anything.
// ════════════════════════════════════════════════════════════════════
const { execSync, execFile } = require('child_process');
const browsers = require('../lib/browsers.js');

const EXES = browsers.processNames();
const t = () => Number(process.hrtime.bigint() / 1000000n);

//  Exactly what ships today.
function shipped() {
    const isUp = exe => {
        try {
            return execSync(`tasklist /FI "IMAGENAME eq ${exe}" /NH`,
                { windowsHide: true, encoding: 'utf8', stdio: 'pipe' })
                .toLowerCase().includes(exe.toLowerCase());
        } catch (e) { return false; }
    };
    return EXES.filter(isUp);
}

//  One spawn, no filter, matched in JS -- and async, so the pump keeps running.
function onceAsync() {
    return new Promise(resolve => {
        execFile('tasklist', ['/FO', 'CSV', '/NH'],
            { windowsHide: true, encoding: 'utf8', maxBuffer: 8 << 20, timeout: 8000 },
            (err, stdout) => {
                if (err && !stdout) return resolve([]);
                const low = String(stdout || '').toLowerCase();
                resolve(EXES.filter(e => low.includes('"' + e.toLowerCase() + '"')));
            });
    });
}

(async () => {
    console.log(`\n${EXES.length} browser process name(s) probed: ${EXES.join(', ')}`);

    const runs = [];
    for (let i = 0; i < 3; i++) {
        const a = t(); const got = shipped(); const b = t();
        runs.push(b - a);
        if (i === 0) console.log(`  shipped shape found: ${got.length ? got.join(', ') : 'none up'}`);
    }
    const worst = Math.max(...runs), best = Math.min(...runs);
    console.log(`  ${EXES.length} SYNC tasklist calls: ${runs.join(' / ')} ms ` +
                `(best ${best}, worst ${worst}) -- all of it blocked thread`);
    console.log(`  per spawn: ${(runs.reduce((x, y) => x + y, 0) / (3 * EXES.length)).toFixed(0)} ms`);

    const one = [];
    for (let i = 0; i < 3; i++) {
        const a = t(); const got = await onceAsync(); const b = t();
        one.push(b - a);
        if (i === 0) console.log(`  one-spawn shape found: ${got.length ? got.join(', ') : 'none up'}`);
    }
    console.log(`  1 ASYNC tasklist call:  ${one.join(' / ')} ms ` +
                `(best ${Math.min(...one)}, worst ${Math.max(...one)}) -- 0 ms blocked thread`);

    //  Do both shapes agree? A cheaper answer that is a different answer is
    //  not the same fix.
    const s = shipped().sort().join(','), o = (await onceAsync()).sort().join(',');
    console.log(`  same answer: ${s === o ? 'yes' : 'NO -- sync says [' + s + '], one-spawn says [' + o + ']'}`);
    console.log(`\n  saved off the pump per connect/switch: ~${worst} ms\n`);
})();
