'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/probe-mutate-strand.js  --  can the strand checks fail?
//
//  25/25 and 136/136 on the first run is exactly as consistent with "the repair
//  works" as with "the new checks look at nothing". So each mistake this repair
//  could plausibly make is written back into a throwaway copy of background.js
//  and BOTH suites are run against it -- test-proxy-strand.js for the profile
//  that starts stranded, test-geo-switch.js for the release and re-assert around
//  windows. A mutant is caught if either notices.
//
//  Two directions matter equally, and the second is the dangerous one:
//
//    * it fails to recover   -- "brave e net pacchina" ships again
//    * it fires too eagerly  -- either a reload sweep that throws away the user's
//      half-written mail for nothing, or a proxy dropped while the VPN is live,
//      which puts the real IP on the wire and is strictly worse than the bug
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
const SUITES = [path.join(__dirname, 'test-proxy-strand.js'),
                path.join(__dirname, 'test-geo-switch.js')];
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fpstrand-'));
const src = fs.readFileSync(SRC, 'utf8');

//  The mark read is the subject of two different mutants -- replaced by a
//  call-time flag, and moved below the release -- so the block is written down
//  once here rather than twice inside the table.
const READ_BLOCK = `let strandedRead = Promise.resolve(false);
try {
    strandedRead = new Promise(resolve => {
        chrome.storage.local.get(PROXY_MARK, got => {
            void chrome.runtime.lastError;
            resolve(!!(got && got[PROXY_MARK]));
        });
    });
} catch (e) { /* strandedRead stays "nothing was marked" */ }`;

const BOOT_RELEASE = `setBrowserProxy(false);
markGeoPending();`;

//  Each entry: { name, parts: [[find, replace], ...] }. `find` must match exactly
//  once or the mutation is reported NOT APPLIED -- a mutation that silently did
//  nothing would "pass" and read as a hole in the suites. Several parts express a
//  MOVE, which a single substitution cannot.
//
//  `by` is for the two mutants that exist to prove a specific check earns its
//  keep: being caught by some other check would mean that one still proves
//  nothing. `equiv` marks a mutation that is expected to change no behaviour, with
//  the reason; it is run anyway so a later reader knows it was tried.
const MUTANTS = [

//  ── it fails to recover: "brave e net pacchina" ships again ─────────
    { name: 'nothing listens for the last window closing, so the proxy outlives the browser',
      parts: [['if (chrome.windows && chrome.windows.onRemoved) {',
               'if (false && chrome.windows && chrome.windows.onRemoved) {']] },

    { name: 'the worker no longer releases the proxy at module evaluation',
      parts: [[BOOT_RELEASE, 'markGeoPending();']] },

    { name: 'the mark is never written, so a next start cannot tell it was stranded',
      parts: [['    markProxy(true);\n    chrome.proxy.settings.set({',
               '    void 0;\n    chrome.proxy.settings.set({']] },

    { name: 'the mark read always answers false, so nothing is ever repaired',
      parts: [['            resolve(!!(got && got[PROXY_MARK]));',
               '            resolve(false);']] },

    { name: 'a disconnected app no longer settles the strand, which is the reported case',
      parts: [['        setBrowserProxy(globalState.connected, globalState.bypassList,\n' +
               '                        () => settleStrandRepair(pagesFailedAtStart));',
               '        setBrowserProxy(globalState.connected, globalState.bypassList);']] },

    { name: 'the app quitting no longer settles the strand',
      parts: [['        setBrowserProxy(false, null, () => settleStrandRepair(true));\n' +
               '        //  The app is gone,',
               '        setBrowserProxy(false);\n        //  The app is gone,']] },

//  ── it recovers, but the repair itself is broken ─────────────────────
    { name: 'the reload is fired in the same tick as the release, not from its callback',
      parts: [['        setBrowserProxy(false, null, () => settleStrandRepair(true));\n' +
               '        //  The app is gone,',
               '        setBrowserProxy(false);\n        settleStrandRepair(true);\n' +
               '        //  The app is gone,']],
      by: /after the browser confirmed the clear/ },

    { name: 'the mark read is a call-time flag again, so a slow read loses the repair',
      parts: [[READ_BLOCK,
               'let strandedFlag = false;\n' +
               'const strandedRead = { then: fn => fn(strandedFlag) };\n' +
               'try {\n' +
               '    chrome.storage.local.get(PROXY_MARK, got => {\n' +
               '        void chrome.runtime.lastError;\n' +
               '        strandedFlag = !!(got && got[PROXY_MARK]);\n' +
               '    });\n' +
               '} catch (e) { /* strandedFlag stays false */ }']],
      by: /answered after the close/ },

    { name: 'the mark is read AFTER the release instead of before, so it reads its own clear',
      parts: [[READ_BLOCK, '//  the read now lives at the bottom of the file'],
              [BOOT_RELEASE, 'setBrowserProxy(false);\n' + READ_BLOCK + '\nmarkGeoPending();']],
      by: /mark was read BEFORE/ },

    { name: 'every tab is reloaded, not just http(s): the new-tab page and the popup too',
      parts: [["                    if (!t || !t.id || !/^https?:/i.test(String(t.url || ''))) return;",
               '                    if (!t || !t.id) return;']] },

//  ── it fires too eagerly: this direction can do the damage ──────────
    { name: 'no re-assert when a window opens: a live VPN comes back with no proxy at all',
      parts: [['if (chrome.windows && chrome.windows.onCreated) {',
               'if (false && chrome.windows && chrome.windows.onCreated) {']] },

    { name: 'the re-assert is unconditional, so a disconnected app gets a proxy anyway',
      parts: [['        if (globalState && globalState.connected)\n' +
               '            setBrowserProxy(true, globalState.bypassList);',
               '        setBrowserProxy(true, globalState.bypassList);']] },

    { name: 'the count of remaining windows is ignored: closing one of two drops a live proxy',
      parts: [['            if (wins && wins.length) return;', '            if (false) return;']] },

    { name: 'the mark is never removed, so every later start reloads the user\'s tabs',
      parts: [['        markProxy(false);\n        //  set, NOT clear',
               '        void 0;\n        //  set, NOT clear']] },

    //  The one that matters most on the profile as it stands. clear() does not mean
    //  "no proxy", it means "I relinquish", and Chromium then applies the next
    //  extension-controlled value in the store -- here a fossil id's fixed_servers
    //  socks5://127.0.0.1:9050 that no worker will ever exist to release. Measured
    //  both ways in .build/probe-pref-precedence.js.
    { name: 'the release goes back to clear(), which hands the pref to the fossil record',
      parts: [["chrome.proxy.settings.set({ value: { mode: 'direct' }, scope: 'regular' }, settled);",
               "chrome.proxy.settings.clear({ scope: 'regular' }, settled);"]],
      by: /never by clearing/ },

    { name: 'an unmarked profile is repaired too, so a clean browser loses its open pages',
      parts: [['        if (!marked) return;', '        void marked;']] },

    { name: 'the decision is not spent when the pages were fine, so the next disconnect sweeps',
      parts: [['    markSweptOnce = true;\n    if (!pagesFailed) return;',
               '    if (!pagesFailed) return;\n    markSweptOnce = true;']] },

    { name: 'the one-decision guard is gone, so every failed reconnect reloads again',
      parts: [['    if (markSweptOnce) return;\n    markSweptOnce = true;',
               '    markSweptOnce = true;']] },

    { name: 'the mark is rewritten on every STATE_SYNC, thousands of writes for one value',
      parts: [['    if (proxyMarked === on) return;     // STATE_SYNC arrives constantly; the mark does not change',
               '    void 0;']] },

//  ── expected to change nothing, run anyway ──────────────────────────
    { name: 'the guard alarm no longer settles the strand',
      parts: [['        setBrowserProxy(false, null, () => settleStrandRepair(true));\n' +
               '        //  And pick the socket back up.',
               '        setBrowserProxy(false);\n        //  And pick the socket back up.']],
      equiv: 'the alarm is armed only while the proxy is SET, and the proxy is only set from a ' +
             'connected STATE_SYNC -- which has already spent the decision. Nothing can reach ' +
             'this line first, so it is belt-and-braces and no check can tell it apart.' },
];

let caught = 0, escaped = 0, unapplied = 0, weak = 0, equivalent = 0;

function run(suite, file) {
    try {
        const out = execFileSync(process.execPath, [suite], {
            env: { ...process.env, FP_BG: file }, encoding: 'utf8', stdio: 'pipe',
        });
        return { code: 0, out };
    } catch (e) {
        return { code: e.status === undefined ? -1 : e.status,
                 out: (e.stdout || '') + (e.stderr || '') };
    }
}

const tally = s => (s.match(/^\d+\/\d+ checks passed$/m) || ['?'])[0];
const failed = s => (s.match(/^ {2}FAIL (.+)$/gm) || []).map(x => x.replace(/^ {2}FAIL /, ''));
const short = p => path.basename(p).replace(/^(test|probe)-/, '').replace(/\.js$/, '');

//  The unmutated file first, both suites. If either is not green to begin with,
//  every "caught" below would mean nothing.
const base = SUITES.map(suite => ({ suite, r: run(suite, SRC) }));
base.forEach(({ suite, r }) =>
    console.log(`── unmutated ${short(suite)}: exit ${r.code}, ${tally(r.out)}`));
if (base.some(b => b.r.code !== 0)) {
    console.log('\nABORT: a suite is not green against the real file, so mutation says nothing.');
    base.filter(b => b.r.code !== 0).forEach(b =>
        console.log(b.r.out.split('\n').filter(l => /FAIL|ABORT/.test(l)).join('\n')));
    process.exit(3);
}
console.log('');

//  Parts are applied in order against the progressively mutated text, so a move
//  can delete a block in part 1 and reinsert it in part 2 without the second
//  pattern being confused by the first.
function apply(parts) {
    let out = src;
    for (let i = 0; i < parts.length; i++) {
        const [find, repl] = parts[i];
        const hits = out.split(find).length - 1;
        if (hits !== 1)
            return { err: `part ${i + 1} of ${parts.length} matches ${hits} time(s), not once` };
        out = out.replace(find, repl);
    }
    return { out };
}

MUTANTS.forEach((m, i) => {
    const built = apply(m.parts);
    if (built.err) {
        unapplied++;
        console.log(`  ??       ${m.name}\n           NOT APPLIED: ${built.err}`);
        return;
    }
    const file = path.join(TMP, `bg${i}.js`);
    fs.writeFileSync(file, built.out);

    const runs = SUITES.map(suite => ({ suite, r: run(suite, file) }));
    const noticed = runs.filter(x => x.r.code !== 0);
    const where = runs.map(x => `${short(x.suite)} ${x.r.code === 0 ? tally(x.r.out) : failed(x.r.out).length + ' fail(s)'}`)
                      .join(', ');

    if (!noticed.length) {
        if (m.equiv) {
            equivalent++;
            console.log(`  (equiv)  ${m.name}\n           escaped, as expected: ${m.equiv}`);
            return;
        }
        escaped++;
        console.log(`  ESCAPED  ${m.name}\n           ${where} -- nothing in either suite notices this mistake`);
        return;
    }

    caught++;
    const all = noticed.flatMap(x => failed(x.r.out));
    const first = all[0] || `ABORT (exit ${noticed[0].r.code})`;
    let note = '';
    if (m.by) {
        const right = all.filter(f => m.by.test(f));
        if (!right.length) { weak++; note = '\n           BUT NOT by the check that exists for it: ' + String(m.by); }
        else note = `\n           by the check that exists for it: ${right[0].slice(0, 92)}`;
    }
    if (m.equiv) note += '\n           (was expected to be equivalent, and was not)';
    console.log(`  caught   ${m.name}\n           ${where}, first: ${first.slice(0, 96)}${note}`);
});

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}

const real = MUTANTS.length - equivalent;
console.log(`\n${caught}/${real} mutations caught` +
            (equivalent ? `, ${equivalent} equivalent by construction` : '') +
            (escaped ? `, ${escaped} ESCAPED` : '') +
            (weak ? `, ${weak} caught by the wrong check` : '') +
            (unapplied ? `, ${unapplied} not applied` : ''));
process.exit(escaped || weak || unapplied ? 1 : 0);
