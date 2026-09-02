'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/probe-mutate-proxyguard.js  --  can the watchdog checks fail?
//
//  The report was "app connected na thakle brave kono net pacchena". The cause
//  was measured, not guessed (.build/probe-brave-proxy-who.js): OUR extension's
//  persistent proxy pref was still in Brave's profile with the app shut down,
//  because every clear() needs a live MV3 worker and an evicted one has no event
//  left that can wake it. The fix is a chrome.alarms watchdog.
//
//  116/116 on the first run is exactly as consistent with "the watchdog works" as
//  with "the new checks look at nothing". So each mistake the watchdog could
//  plausibly make is written back into a throwaway copy of background.js and the
//  suite is run against it. Two directions matter equally here:
//
//    * it fails to recover  -- the reported bug ships again
//    * it fires too eagerly -- it drops a LIVE VPN's proxy, which is a real-IP
//      leak, and that is strictly worse than the bug being fixed
//
//  An ESCAPED mutant is the finding. Nothing in Extension/ is modified; the
//  copies live in the OS temp directory and are deleted at the end.
// ════════════════════════════════════════════════════════════════════
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'Extension', 'background.js');
const TEST = path.join(__dirname, 'test-geo-switch.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fpguard-'));
const src = fs.readFileSync(SRC, 'utf8');

//  [name, find, replace]. `find` must appear exactly once or the mutation is
//  reported as NOT APPLIED -- a mutation that silently did nothing would "pass"
//  and read as a hole in the suite.
const MUTANTS = [
    //  ── the watchdog never runs at all ──────────────────────────────
    ['the guard is never armed, so the fix is absent',
     '    armProxyGuard(true);\n    //  Marked before the write',
     '    void 0;\n    //  Marked before the write'],

    ['nothing listens for the alarm, so waking the worker is wasted',
     "        if (!alarm || alarm.name !== PROXY_GUARD) return;",
     "        if (!alarm || alarm.name !== PROXY_GUARD || true) return;"],

    //  ── it runs, but stops watching ─────────────────────────────────
    ['the alarm is a one-shot, so it stops watching while the proxy stays set',
     '            { delayInMinutes: PROXY_GUARD_MIN, periodInMinutes: PROXY_GUARD_MIN });',
     '            { delayInMinutes: PROXY_GUARD_MIN });'],

    ['a disconnect leaves the alarm behind, waking the worker for ever',
     '        armProxyGuard(false);\n        //  Unmarked before the write',
     '        void 0;\n        //  Unmarked before the write'],

    //  ── it runs, and does the wrong thing when it fires ─────────────
    ['the guard fires while the app is answering: a live VPN loses its proxy',
     '        if (live) return;',
     '        if (live && false) return;'],

    ['any alarm at all drops the proxy, including another feature\'s',
     "        if (!alarm || alarm.name !== PROXY_GUARD) return;\n        //  OPEN:",
     "        if (!alarm) return;\n        //  OPEN:"],

    ['a CONNECTING socket counts as dead, so a starting worker clears again',
     '        const live = socket && (socket.readyState === WebSocket.OPEN ||\n' +
     '                                socket.readyState === WebSocket.CONNECTING);',
     '        const live = socket && socket.readyState === WebSocket.OPEN;'],

    ['the guard releases the proxy but never dials the app again',
     '        if (!reconnectTimer) connectToDesktop();',
     '        void reconnectTimer;'],

    ['it recovers silently, leaving no reason in the log for why the proxy went',
     "        console.warn('FreeProxy: the desktop app is not answering and this browser was ' +",
     "        console.debug('FreeProxy: the desktop app is not answering and this browser was ' +"],

    //  ── the ordering the fix turns on ───────────────────────────────
    ['the guard is armed after the write, leaving a gap with nothing watching',
     '    armProxyGuard(true);\n    chrome.proxy.settings.set({',
     '    chrome.proxy.settings.set({'],
];

//  The last mutant moves the arm() call to AFTER the set() rather than deleting
//  it: a plain find/replace cannot express "move", and deleting it would only
//  repeat the first mutant. Both halves are asserted to have landed, because a
//  half-applied move would read as a hole in the suite.
const LATE = {
    name: 'the guard is armed after the write, leaving a gap with nothing watching',
    from: ['    armProxyGuard(true);\n    //  Marked before the write',
           "        scope: 'regular',\n    }, settled);"],
    to:   ['    //  Marked before the write',
           "        scope: 'regular',\n    }, settled);\n    armProxyGuard(true);"],
};

let caught = 0, escaped = 0, unapplied = 0;

function run(file) {
    try {
        const out = execFileSync(process.execPath, [TEST], {
            env: { ...process.env, FP_BG: file }, encoding: 'utf8', stdio: 'pipe',
        });
        return { code: 0, out };
    } catch (e) {
        return { code: e.status === undefined ? -1 : e.status, out: (e.stdout || '') + (e.stderr || '') };
    }
}

const tally = s => (s.match(/^\d+\/\d+ checks passed$/m) || ['?'])[0];

//  The unmutated file first. If the suite is not green to begin with, every
//  "caught" below would mean nothing.
const base = run(SRC);
console.log(`── unmutated: exit ${base.code}, ${tally(base.out)}\n`);
if (base.code !== 0) {
    console.log('ABORT: the suite is not green against the real file, so mutation says nothing.');
    console.log(base.out.split('\n').filter(l => /FAIL|ABORT/.test(l)).join('\n'));
    process.exit(3);
}

//  Only the watchdog checks are of interest here, and naming them is what tells
//  a later reader whether the mutant was caught by the new block or incidentally
//  by an older one -- an important difference, since an older check catching it
//  would mean the new block still proves nothing.
const GUARD_RE = /guard|alarm|watch|REPEATS|disarms|not answering|naming why|dials the app|on Tor|evicted|connecting/i;

const report = (name, r) => {
    const fails = (r.out.match(/^ {2}FAIL (.+)$/gm) || []).map(s => s.replace(/^ {2}FAIL /, ''));
    if (r.code === 0) {
        escaped++;
        console.log(`  ESCAPED  ${name}\n           ${tally(r.out)} -- nothing here notices this mistake`);
        return;
    }
    caught++;
    const byGuard = fails.filter(f => GUARD_RE.test(f)).length;
    const first = fails[0] || `ABORT (exit ${r.code})`;
    console.log(`  caught   ${name}\n           ${fails.length} check(s) failed` +
                `, ${byGuard} in the watchdog block, first: ${first.slice(0, 104)}`);
};

MUTANTS.forEach(([name, find, repl], i) => {
    const file = path.join(TMP, `bg${i}.js`);
    //  The "armed after the write" case is a move, not a substitution.
    if (name === LATE.name) {
        const bad = LATE.from.findIndex(f => src.split(f).length - 1 !== 1);
        if (bad >= 0) {
            unapplied++;
            console.log(`  ??   ${name}\n         NOT APPLIED: half ${bad + 1} of the move ` +
                        `matches ${src.split(LATE.from[bad]).length - 1} times, not once`);
            return;
        }
        let out = src;
        LATE.from.forEach((f, k) => { out = out.replace(f, LATE.to[k]); });
        fs.writeFileSync(file, out);
        report(name, run(file));
        return;
    }
    const hits = src.split(find).length - 1;
    if (hits !== 1) {
        unapplied++;
        console.log(`  ??   ${name}\n         NOT APPLIED: the pattern appears ${hits} times`);
        return;
    }
    fs.writeFileSync(file, src.replace(find, repl));
    report(name, run(file));
});

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}

console.log(`\n${caught}/${MUTANTS.length} mutations caught` +
            (escaped ? `, ${escaped} ESCAPED` : '') +
            (unapplied ? `, ${unapplied} not applied` : ''));
process.exit(escaped || unapplied ? 1 : 0);
