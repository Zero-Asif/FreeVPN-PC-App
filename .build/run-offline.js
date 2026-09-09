'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/run-offline.js  --  run every suite that needs no Tor and no elevation,
//  and print one line each.
//
//  Two of them -- test-coverage and test-engine -- do read live Onionoo, and they
//  are in the gate on purpose: between them they caught a country in the built-in
//  fallback list with zero live exits, which under StrictNodes 1 is a connect that
//  can never succeed. Both exit 3 ("n/a") when the fetch itself fails, so a dead
//  network reads as "not measured" and never as a fault in the code.
//
//  The EXCLUDED entries below are not failures of the code, and the reason is
//  recorded per suite so that "it is not in the gate" always has an answer.
//  test-vendor.js reads both lists out of this file: a new test-*.js that is in
//  neither is a suite nobody runs, which is how a fix stayed unverified once.
// ════════════════════════════════════════════════════════════════════
const path = require('path');
const { execFileSync } = require('child_process');

const SUITES = [
    'test-artifact', 'test-browsers', 'test-certpurge', 'test-containment',
    'test-coverage', 'test-crx',
    'test-edge-store', 'test-engine', 'test-engine-ask', 'test-exit-ip',
    'test-exit-persistence', 'test-ext-deliver', 'test-ext-state', 'test-flight-path',
    'test-force-exit-circuit', 'test-geo-ext', 'test-geo-external', 'test-geo-forcelist',
    'test-geo-freshness', 'test-geo-gecko', 'test-geo-prefs', 'test-geo-purge',
    'test-geo-serial', 'test-geo-settings', 'test-geo-switch', 'test-geo-winshield',
    'test-guard-watermark', 'test-installer-nsh', 'test-installer-sweep',
    'test-installer-tasks', 'test-offthread', 'test-offline-tally', 'test-popup',
    'test-proxy-strand',
    'test-readme-lines',
    'test-restart-marker', 'test-stale-ext-id', 'test-standby', 'test-startup-resilience',
    'test-store-package',
    'test-tor-control-framing',
    'test-tunnel-address', 'test-tunnel-argv', 'test-tunnel-teardown',
    'test-uiblock-guard',
    'test-vendor', 'test-whole-machine', 'test-winloc-default',
];

//  Left out on purpose, with the reason. Everything here either waits on UAC or
//  measures a live exit, which is a different question from "did this change
//  break anything".
const EXCLUDED = {
    'test-clear-scope': 'launches a real Chromium in a throwaway profile to read back ' +
                        'which browsingData buckets an origin filter actually covers',
    'test-ext-install': 'writes HKLM\\SOFTWARE\\Policies -- needs an elevated shell',
    'test-geo-policy':  'spawns an elevated registry helper and waits on UAC',
    'test-geo-real':    'same helper, same UAC -- fails with "helper never became ready"',
    'test-geo-e2e':     'drives real browsers and the live app',
    'test-live':        'measures live Tor exits and real IPs',
    'test-browser-intro': 'launches a real browser window',
};

//  Read one suite's stdout and say what it proved. Exported so
//  probe-offline-tally.js can feed it the real output shapes without a
//  15-minute gate run.
//
//  Five suites print no `ok` line at all and were therefore ALL labelled
//  "(measured, no assertions)". That is true of two of them and a lie about
//  the other three: test-coverage makes three cross-checks, test-engine
//  twenty-six and test-geo-prefs four per browser -- they just spell the
//  verdict PASS, and test-geo-prefs puts it at the END of the line. Worse,
//  the label was the same for both kinds, so nothing distinguished "asserted
//  and passed" from "asserted nothing". The verdict is now read from
//  whichever end of the line carries it, once per line, and the FAIL detail
//  lines come out of the same pass so the tally and the detail can never
//  disagree.
function tallyOf(out) {
    const verdicts = [], fails = [];
    for (const L of out.split('\n')) {
        const lead = /^\s*(ok|PASS|FAIL)\b\s*(.*)$/.exec(L);
        const tail = lead ? null : /\b(PASS|FAIL)\s*$/.exec(L);
        const v = lead ? lead[1] : tail ? tail[1] : null;
        if (!v) continue;
        verdicts.push(v);
        if (v === 'FAIL') fails.push((lead ? lead[2] : L).trim());
    }
    const failN = fails.length, okN = verdicts.length - failN;
    const tally = (out.match(/^\d+\/\d+ checks passed.*$/m) || [])[0] ||
                  (out.match(/^ABORT:.*$/m) || [])[0] ||
                  (verdicts.length ? `${okN}/${verdicts.length} checks counted` : '') ||
                  '(measured, no assertions)';
    return { tally, okN, failN, fails };
}

module.exports = { SUITES, EXCLUDED, tallyOf };

if (require.main !== module) return;

//  A suite that exits 3 is saying "the thing I read is not here" -- test-artifact
//  on a tree that has not been built. That is not a failure of the code and must
//  not read as one, but it must not read as a pass either.
const NOT_BUILT = 3;

//  Per suite, not for the whole run. test-installer-tasks was killed at this cap
//  once, with another six suites running beside it by hand -- and the line read
//  "exit null", which says nothing. A killed suite now says so.
const CAP_MS = 300000;

let green = 0, red = 0, skipped = 0;
const bad = [];
for (const s of SUITES) {
    let out = '', code = 0, killed = false;
    try {
        out = execFileSync(process.execPath, [path.join(__dirname, s + '.js')],
                           { encoding: 'utf8', stdio: 'pipe', timeout: CAP_MS });
    } catch (e) {
        killed = e.status === null || !!e.signal;
        code = e.status === undefined || e.status === null ? -1 : e.status;
        out = (e.stdout || '') + (e.stderr || '');
    }
    //  The suffix is optional on purpose: a suite that ends "20/20 checks passed, 2
    //  not applicable" was being reported as "(no tally line)", which reads like a
    //  crash on a suite that passed. tallyOf() above does the reading.
    const { tally, fails } = tallyOf(out);
    if (code === NOT_BUILT) { skipped++; console.log(`  n/a   ${s.padEnd(28)} ${tally}`); }
    else if (code === 0) { green++; console.log(`  ok    ${s.padEnd(28)} ${tally}`); }
    else {
        red++; bad.push(s);
        const why = killed ? `killed at the ${CAP_MS / 1000} s cap` : `exit ${code}`;
        console.log(`  FAIL  ${s.padEnd(28)} ${why}  ${tally}`);
        fails.slice(0, 4).forEach(f => console.log(`          ${f.slice(0, 110)}`));
    }
}
console.log(`\n${green}/${green + red} offline suites green` +
            (skipped ? `, ${skipped} not applicable` : '') +
            (red ? `  --  ${bad.join(', ')}` : ''));
process.exit(red ? 1 : 0);
