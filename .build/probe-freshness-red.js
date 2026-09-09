'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/probe-freshness-red.js  --  can test-geo-freshness.js fail?
//
//  It is the suite that guards the geolocation leak and the record ordering, and
//  nothing had ever shown it able to go red. Each mutation below takes one rule
//  back out of Extension/geo-spoof.js, writes the result to a throwaway copy and
//  points the suite at it with FP_SPOOF. A mutation the suite does not catch is
//  a rule nobody is actually holding.
//
//  One entry carries TWO edits, and that is the finding rather than a shortcut:
//  a bare {active:false} is refused in accept() AND again in passthrough(), so
//  removing either alone changes nothing a page can observe. Only the pair is a
//  leak, and only the pair is a mutant.
// ════════════════════════════════════════════════════════════════════
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SRC = path.join(__dirname, '..', 'Extension', 'geo-spoof.js');
const SUITE = path.join(__dirname, 'test-geo-freshness.js');
const src = fs.readFileSync(SRC, 'utf8');
//  realpath because Node's tmpdir is the 8.3 form on this machine.
const TMP = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'fresh-red-')));

const ORDER = '        if (haveConfig && stampOf(cfg) < stampOf(current)) { settle(); return; }';
const NUDGE = '                    if (!fresh()) askAgain();';
const PASS  = '        return haveConfig && current && current.active !== true && current.appOff === true;';
const SHAPE = '        } else if (cfg.appOff !== true) {';

const MUTANTS = [
    ['an older record may replace a newer one', [[ORDER, '']]],
    ['an equal stamp is treated as older and dropped',
     [[ORDER, ORDER.replace('stampOf(cfg) <', 'stampOf(cfg) <=')]]],
    ['a dropped record leaves the waiters to time out',
     [[ORDER, ORDER.replace('{ settle(); return; }', '{ return; }')]]],
    ['a stale watch never asks the worker again', [[NUDGE, '']]],
    ['a stale watch stops reporting instead of asking',
     [[NUDGE, '                    if (!fresh()) return;']]],
    ['a bare {active:false} authorises the real provider again -- both guards removed',
     [[SHAPE, '        } else if (false) {'],
      [PASS, '        return haveConfig && current && current.active !== true;']]],
    ['an unanswered re-ask is treated as vouched for',
     [['            recheck(function () { fn(fresh() || unreachable); });',
       '            recheck(function () { fn(true); });']]],
];

let proved = 0, missed = 0;
MUTANTS.forEach(([what, edits], i) => {
    let text = src, lost = null;
    for (const [from, to] of edits) {
        if (!text.includes(from)) { lost = from; break; }
        text = text.replace(from, to);
    }
    if (lost) {
        console.log('  ANCHOR LOST  ' + what + '\n               ' + JSON.stringify(lost.slice(0, 60)));
        missed++;
        return;
    }
    const out = path.join(TMP, 'spoof-' + i + '.js');
    fs.writeFileSync(out, text);
    let log = '', code = 0;
    try {
        log = execFileSync(process.execPath, [SUITE],
                           { encoding: 'utf8', env: { ...process.env, FP_SPOOF: out } });
    } catch (e) { log = String(e.stdout || '') + String(e.stderr || ''); code = e.status || 1; }
    const tally = (log.match(/(\d+)\/(\d+) checks passed/) || [])[0] || 'no tally';
    const fails = (log.match(/^  FAIL /gm) || []).length;
    if (code !== 0 && fails > 0) {
        proved++;
        console.log('  RED   ' + what + '   (' + fails + ' check(s) failed, ' + tally + ')');
    } else {
        missed++;
        console.log('  GREEN ' + what + '   -- the suite did NOT catch this   ' + tally);
    }
});

console.log('\n' + proved + '/' + (proved + missed) + ' mutant(s) caught');
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
if (missed) process.exitCode = 1;
