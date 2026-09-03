'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/probe-mutate.js  --  is .build/test-geo-switch.js able to fail?
//
//  61/61 on the first run is exactly as consistent with "the fix is right" as it
//  is with "the checks never look at anything". So each mistake the purge could
//  plausibly make is written back INTO a throwaway copy of background.js, the
//  suite is run against the copy, and the check that catches it is named.
//
//  A mutant that still passes is the finding: it means that mistake could be
//  shipped and no test here would notice. Nothing in Extension/ is modified --
//  the copies live in the OS temp directory and are deleted at the end.
// ════════════════════════════════════════════════════════════════════
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'Extension', 'background.js');
const TEST = path.join(__dirname, 'test-geo-switch.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fpmut-'));
const src = fs.readFileSync(SRC, 'utf8');

//  Each mutation is [name, find, replace]. `find` must appear exactly once, or
//  the mutation is reported as not applied rather than silently doing nothing --
//  a mutation that failed to apply would "pass" and read as a hole in the suite.
const MUTANTS = [
    ['the cookie sweep runs in parallel with the reload, not before it',
     '    let names = LOCATION_COOKIES.length, removed = 0;\n' +
     '    const nameDone = () => { if (--names === 0) done(removed); };',
     '    let names = LOCATION_COOKIES.length, removed = 0;\n' +
     '    done(0);\n' +
     '    const nameDone = () => { if (--names === 0) void removed; };'],

    ['a session cookie is added to the location list',
     "const LOCATION_COOKIES = ['UULE'];",
     "const LOCATION_COOKIES = ['UULE', 'SID'];"],

    ['browsingData is asked to clear cookies too',
     'cacheStorage: true, indexedDB: true, localStorage: true, serviceWorkers: true,',
     'cacheStorage: true, indexedDB: true, localStorage: true, serviceWorkers: true, cookies: true,'],

    ['the repeated-disconnect guard is dropped',
     'if (prev.off) { release(); return; }',
     'if (prev.off && false) { release(); return; }'],

    ['a disconnect clears site storage and reloads tabs as well',
     '() => purgeLocationTraces(prev, false));',
     '() => purgeLocationTraces(prev, true));'],

    ['the origin list is not emptied before the reloads re-fill it',
     'chrome.storage.local.set({ [GEO_ORIGINS]: [] }, () => {',
     'chrome.storage.local.set({ [GEO_ORIGINS]: origins }, () => {'],

    ['every tab is reloaded, not only the ones that were given a position',
     'if (!want.has(o) && !clean) continue;',
     'if (false) continue;'],

    ['the Maps pin is dropped wherever it points, not only at the country being left',
     'if (Math.abs(+m[2] - from.lat) > 1.5 || Math.abs(+m[3] - from.lng) > 1.5) return null;',
     'if (false) return null;'],

    //  The two below guard the repin added for "every reload must show the
    //  connected country". The first is the old behaviour exactly: drop the pin
    //  and let Google choose. The second keeps the repin but loses the zoom
    //  segment, which is the quiet way to move a map correctly and still ruin it.
    ['the pin is dropped instead of being rewritten to the connected country',
     'const clean = repinMaps(t.url, to) || unpinMaps(t.url, from);',
     'const clean = unpinMaps(t.url, from);'],

    ['the repin throws the zoom segment away',
     "const next = m[1] + '/@' + to.lat + ',' + to.lng + (m[4] || '') + (m[5] || '');",
     "const next = m[1] + '/@' + to.lat + ',' + to.lng + (m[5] || '');"],

    ['the same country counts as a change',
     'if (prev && !sameSpot(prev, now)) {',
     'if (prev) {'],

    ['origins are recorded without serialising, so a burst loses entries',
     'serialiseOrigins(done => {\n        chrome.storage.local.get(GEO_ORIGINS, got => {\n            const list',
     'void 0; (done => {\n        chrome.storage.local.get(GEO_ORIGINS, got => {\n            const list'],

    ['the new country is published only after the whole purge finishes',
     '    writeGeo(rec);\n    noteLocationChange(rec);',
     '    noteLocationChange(rec);\n    setTimeout(() => writeGeo(rec), 0);'],

    ['a missing chrome.cookies is passed off as a success',
     "console.warn('FreeProxy: chrome.cookies is unavailable in this browser -- ' +",
     "console.info('FreeProxy: cookies cleared -- ' +"],
];

let caught = 0, escaped = 0, unapplied = 0;

//  The unmutated file first. If the suite is not green to begin with, every
//  "caught" below would be meaningless.
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

const base = run(SRC);
const tally = s => (s.match(/^\d+\/\d+ checks passed$/m) || ['?'])[0];
console.log(`── unmutated: exit ${base.code}, ${tally(base.out)}\n`);
if (base.code !== 0) {
    console.log('ABORT: the suite is not green against the real file, so mutation says nothing.');
    console.log(base.out.split('\n').filter(l => /FAIL|ABORT/.test(l)).join('\n'));
    process.exit(3);
}

MUTANTS.forEach(([name, find, repl], i) => {
    const hits = src.split(find).length - 1;
    if (hits !== 1) {
        unapplied++;
        console.log(`  ??   ${name}\n         NOT APPLIED: the pattern appears ${hits} times`);
        return;
    }
    const file = path.join(TMP, `bg${i}.js`);
    fs.writeFileSync(file, src.replace(find, repl));
    const r = run(file);
    //  exit 1 is "checks failed", which is the wanted outcome. exit 3 is an
    //  ABORT -- the mutant crashed the harness, which also counts as caught,
    //  but it is named separately because it is a weaker kind of catch.
    const fails = (r.out.match(/^ {2}FAIL /gm) || []).length;
    if (r.code === 0) {
        escaped++;
        console.log(`  ESCAPED  ${name}\n           ${tally(r.out)} -- nothing here notices this mistake`);
        return;
    }
    caught++;
    const firstFail = (r.out.match(/^ {2}FAIL (.+)$/m) || [])[1] || `ABORT (exit ${r.code})`;
    console.log(`  caught   ${name}\n           ${fails} check(s) failed, first: ${firstFail.slice(0, 110)}`);
});

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}

console.log(`\n${caught}/${MUTANTS.length} mutations caught` +
            (escaped ? `, ${escaped} ESCAPED` : '') +
            (unapplied ? `, ${unapplied} not applied` : ''));
process.exit(escaped || unapplied ? 1 : 0);
