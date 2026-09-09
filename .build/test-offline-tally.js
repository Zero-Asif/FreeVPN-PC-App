'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/test-offline-tally.js  --  prove run-offline.js's tally line is
//  telling the truth about each suite, without a 15-minute gate run.
//
//  A test-*.js and in SUITES on purpose: the tally line is what a human reads
//  to decide whether this app is green, so a reader that mislabels a suite is
//  a fault in the one instrument nobody double-checks.
//
//  It labelled five suites "(measured, no assertions)". Two of them really do
//  assert nothing; three assert plenty and spell the verdict PASS instead of
//  ok -- and test-geo-prefs puts it at the end of the line. One label for both
//  kinds meant "asserted nothing" and "asserted 26 things and passed" read
//  identically, and the second one is the one you would want to know about.
//
//  The FIXTURES below are the real output shapes, copied from the suites' own
//  console.log calls (file:line recorded on each) -- not invented ones. The
//  MUTATIONS at the bottom are the red-proof: each one breaks the reader, and
//  each must change the label. A tally function that survives them all is
//  reading a constant.
//
//  Touches nothing. No spawn, no registry, no network.
// ════════════════════════════════════════════════════════════════════
const { tallyOf } = require('./run-offline.js');

let pass = 0, fail = 0;
const ok = (cond, label, detail) => {
    if (cond) { pass++; console.log('  ok   ' + label); }
    else { fail++; console.log('  FAIL ' + label + (detail ? '  -- ' + detail : '')); }
};

//  ── the real shapes ─────────────────────────────────────────────
//  Every `body` is byte-for-byte the shape its suite emits, including the
//  leading spaces, because the leading spaces are what the reader keys on.
const FIXTURES = [
    {
        name: 'test-browsers', src: 'the `ok(...)` helper most suites share',
        body: '  ok   Chrome is installed\n  ok   Brave is installed\n\n2/2 checks passed',
        wantTally: '2/2 checks passed', wantOk: 2, wantFail: 0,
    },
    {
        name: 'test-geo-purge', src: 'a tally with a not-applicable suffix',
        body: '  ok   stale entry gone\n\n23/23 checks passed, 1 not applicable',
        wantTally: '23/23 checks passed, 1 not applicable', wantOk: 1, wantFail: 0,
    },
    {
        name: 'test-crx', src: 'ok lines, then prose instead of a tally',
        body: '  ok   the crx3 header is right\n  ok   and the signature verifies\n\n' +
              'Both packs are byte-identical, so the id cannot drift.',
        wantTally: '2/2 checks counted', wantOk: 2, wantFail: 0,
    },
    {
        name: 'test-engine', src: 'test-engine.js:27 -- "  PASS  " / "  FAIL  "',
        body: '  PASS  onionoo answered   204.8.99.156\n' +
              '  PASS  every fallback country has live exits\n\nall checks passed',
        wantTally: '2/2 checks counted', wantOk: 2, wantFail: 0,
    },
    {
        name: 'test-coverage', src: 'test-coverage.js:73,84,92 -- PASS at column 0',
        body: 'GEO_COORDS      : 74 countries\n\n' +
              'PASS  every country with exit capacity has spoofable coordinates\n' +
              'PASS  every country in the fallback list has live exit capacity\n' +
              'PASS  every country in the fallback list has coordinates\n\n' +
              'all cross-checks passed',
        wantTally: '3/3 checks counted', wantOk: 3, wantFail: 0,
    },
    {
        name: 'test-coverage red', src: 'the same suite with the dead-country fault back',
        body: 'FAIL  1 country/ies have exits but NO coordinates\n' +
              '      -> hidden from the picker, so this capacity goes unused:\n' +
              'PASS  every country in the fallback list has live exit capacity\n' +
              'PASS  every country in the fallback list has coordinates\n\n' +
              '1 cross-check(s) FAILED',
        wantTally: '2/3 checks counted', wantOk: 2, wantFail: 1,
        wantFirstFail: '1 country/ies have exits but NO coordinates',
    },
    {
        name: 'test-geo-prefs', src: 'test-geo-prefs.js:162,172,180,187 -- verdict at line END',
        body: '  1  virgin profile                   -> prompt     want prompt   PASS\n' +
              '     browser wrote Default/Preferences: yes\n' +
              '  2  exception = ALLOW                -> granted    want granted  PASS\n' +
              '  3  exception = BLOCK                -> denied     want denied   PASS\n' +
              '  4  exception removed                -> prompt     want prompt   PASS\n' +
              '  Outside edits to Preferences ARE honoured.',
        wantTally: '4/4 checks counted', wantOk: 4, wantFail: 0,
    },
    {
        name: 'test-geo-prefs red', src: 'the same suite with a browser ignoring the scrub',
        body: '  1  virgin profile                   -> prompt     want prompt   PASS\n' +
              '  4  exception removed                -> granted    want prompt   FAIL\n',
        wantTally: '1/2 checks counted', wantOk: 1, wantFail: 1,
    },
    {
        name: 'test-certpurge', src: 'a measuring instrument with nothing to assert',
        body: 'Certificates in the user store before: 41\nCertificates after: 41\n' +
              'Nothing this app installed is left behind.',
        wantTally: '(measured, no assertions)', wantOk: 0, wantFail: 0,
    },
    {
        name: 'test-winloc-default', src: 'the same, recording a negative result about Windows',
        body: 'Default Location set to Reykjavik.\n' +
              'navigator.geolocation still returned 23.7276, 90.4083 -- unchanged.\n' +
              'There is no supported route; the app withholds the position instead.',
        wantTally: '(measured, no assertions)', wantOk: 0, wantFail: 0,
    },
    {
        name: 'an aborted suite', src: 'ABORT wins over a counted tally',
        body: '  ok   the engine binary is there\nABORT: tor.exe never opened the control port',
        wantTally: 'ABORT: tor.exe never opened the control port',
    },
    {
        name: 'words that only look like verdicts',
        src: 'SPAWN_FAILED, "check(s) FAILED" and "okay" must not count',
        body: '  1  launch                           -> SPAWN_FAILED\n' +
              'okay, that is the whole profile\n' +
              '2 check(s) FAILED',
        wantTally: '(measured, no assertions)', wantOk: 0, wantFail: 0,
    },
];

console.log('══ the real output shapes ' + '═'.repeat(40));
for (const f of FIXTURES) {
    const r = tallyOf(f.body);
    ok(r.tally === f.wantTally, f.name + ' -> "' + f.wantTally + '"  [' + f.src + ']',
       'got "' + r.tally + '"');
    if (f.wantOk !== undefined) {
        ok(r.okN === f.wantOk && r.failN === f.wantFail,
           '  and it counted ' + f.wantOk + ' green, ' + f.wantFail + ' red',
           'got ' + r.okN + ' green, ' + r.failN + ' red');
    }
    if (f.wantFirstFail) {
        ok(r.fails[0] === f.wantFirstFail,
           '  and the first FAIL detail is the line itself, verdict stripped',
           'got ' + JSON.stringify(r.fails[0]));
    }
}

//  ── the label has to separate the two kinds ─────────────────────
console.log('\n══ the distinction the old reader could not make ' + '═'.repeat(17));
const asserting = ['test-engine', 'test-coverage', 'test-geo-prefs']
    .map(n => tallyOf(FIXTURES.find(f => f.name === n).body).tally);
const measuring = ['test-certpurge', 'test-winloc-default']
    .map(n => tallyOf(FIXTURES.find(f => f.name === n).body).tally);
ok(!asserting.includes('(measured, no assertions)'),
   'no suite that asserts is labelled as one that does not', asserting.join(' | '));
ok(measuring.every(t => t === '(measured, no assertions)'),
   'and the two that really assert nothing still say so', measuring.join(' | '));

//  ── red-proof: break the reader, the label must move ────────────
//  Each mutation is a plausible simplification of tallyOf(). If the label
//  does not move, the check above it is pinning a constant.
console.log('\n══ red-proof: a broken reader must mislabel ' + '═'.repeat(22));
const MUTATIONS = [
    {
        why: 'ok only, no PASS -- the bug this replaced',
        read: s => /^\s*ok\b/gm.test(s) ? 'counted' : '(measured, no assertions)',
        on: ['test-engine', 'test-coverage', 'test-geo-prefs'],
    },
    {
        why: 'leading verdicts only -- misses test-geo-prefs at line end',
        read: s => (s.match(/^\s*(ok|PASS|FAIL)\b/gm) || []).length
                   ? 'counted' : '(measured, no assertions)',
        on: ['test-geo-prefs'],
    },
    {
        why: 'two-space indent required -- misses test-coverage at column 0',
        read: s => (s.match(/^ {2}(ok|PASS|FAIL)\b/gm) || []).length
                   ? 'counted' : '(measured, no assertions)',
        on: ['test-coverage'],
    },
];
for (const m of MUTATIONS) {
    for (const n of m.on) {
        const body = FIXTURES.find(f => f.name === n).body;
        const real = tallyOf(body).tally;
        ok(m.read(body) === '(measured, no assertions)' && real !== '(measured, no assertions)',
           'on ' + n + ': ' + m.why,
           'mutant said "' + m.read(body) + '", real reader said "' + real + '"');
    }
}
//  And the reverse direction: a reader loose enough to count SPAWN_FAILED
//  would label a measuring suite as asserting.
{
    const body = FIXTURES.find(f => f.name === 'words that only look like verdicts').body;
    const loose = s => /FAIL|PASS|ok/.test(s) ? 'counted' : '(measured, no assertions)';
    ok(loose(body) === 'counted' && tallyOf(body).tally === '(measured, no assertions)',
       'and a reader without word boundaries counts SPAWN_FAILED as a failure');
}

console.log('\n' + pass + '/' + (pass + fail) + ' checks passed');
process.exit(fail ? 1 : 0);
