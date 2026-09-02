'use strict';
//  A test that cannot be made to fail proves nothing. This makes exactly one
//  change to a COPY of background.js -- it takes noteLocationChange() back off the
//  queue, leaving every other line of it alone -- and runs the switch suite
//  against the copy. The two "same tick" checks must go red, and only those.
//
//  Usage: node .build/probe-mutate-race.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SRC = path.join(__dirname, '..', 'Extension', 'background.js');
const src = fs.readFileSync(SRC, 'utf8');

const FROM = 'function noteLocationChange(rec) {\n    serialiseOrigins(res => {';
const TO = 'function noteLocationChange(rec) {\n' +
           '    const unqueued = f => f(() => {});\n' +
           '    unqueued(res => {';
if (!src.includes(FROM)) {
    console.log('ABORT: noteLocationChange is not on the queue in the shape this probe patches.');
    process.exit(3);
}
const out = path.join(os.tmpdir(), 'fp-mutant-race-' + process.pid + '.js');
fs.writeFileSync(out, src.replace(FROM, TO));
console.log(`mutant: noteLocationChange taken off the queue\n        ${out}\n`);

const r = spawnSync(process.execPath, [path.join(__dirname, 'test-geo-switch.js')],
                    { encoding: 'utf8', env: { ...process.env, FP_BG: out } });
const log = (r.stdout || '') + (r.stderr || '');
const fails = log.split('\n').filter(s => /^\s*FAIL /.test(s));
const tally = (log.match(/^\d+\/\d+ checks passed$/m) || [''])[0];

console.log(tally || log.slice(-2000));
console.log(`\n${fails.length} check(s) caught the mutation:`);
fails.forEach(s => console.log('  ' + s.trim()));
try { fs.unlinkSync(out); } catch (e) {}
process.exit(fails.length ? 0 : 1);
