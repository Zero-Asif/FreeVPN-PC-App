//  The chained scan is only allowed to be cheaper if it is also the SAME answer.
//  Runs HEAD's eight-spawn lib/browsers.js and the working tree's one-spawn copy
//  in fresh child processes and diffs everything three consumers read.
'use strict';
const path = require('path');
const { execFileSync } = require('child_process');

const dump = (src) => {
    const code =
        `const B = require(${JSON.stringify(src)});` +
        `const t = Date.now();` +
        `const reg = B.regExePaths();` +
        `const found = B.detect();` +
        `const cold = Date.now() - t;` +
        `process.stdout.write(JSON.stringify({` +
          `cold,` +
          `reg,` +
          `found: found.map(b => [b.id, b.exePath, b.dataDir]),` +
          `orphans: B.orphanProfiles().map(b => [b.id, b.dataDir]),` +
          `policy: B.policyRoots('reg').map(r => r.id + '=' + r.key),` +
          `procs: B.processNames(),` +
          `ud: B.chromiumUserData(),` +
          `gp: B.geckoProfileRoots(),` +
        `}));`;
    return JSON.parse(execFileSync(process.execPath, ['-e', code],
        { encoding: 'utf8', maxBuffer: 8 << 20 }));
};

const OLD = process.env.FP_BROWSERS_OLD || 'G:/tmp/browsers-HEAD.js';
const NEW = path.join(__dirname, '..', 'lib', 'browsers.js').replace(/\\/g, '/');

//  Three samples each, alternating, so neither version gets all the cold cache.
const olds = [], news = [];
for (let i = 0; i < 3; i++) { olds.push(dump(OLD)); news.push(dump(NEW)); }

const best = a => Math.min(...a.map(x => x.cold));
console.log(`eight spawns: ${olds.map(o => o.cold).join(' / ')} ms   best ${best(olds)}`);
console.log(`one spawn:    ${news.map(n => n.cold).join(' / ')} ms   best ${best(news)}`);
console.log(`saved ${best(olds) - best(news)} ms per cold detect()\n`);

const strip = o => { const { cold, ...rest } = o; return rest; };
let bad = 0;
for (const k of Object.keys(strip(olds[0]))) {
    const a = JSON.stringify(olds[0][k]);
    const b = JSON.stringify(news[0][k]);
    const same = a === b;
    if (!same) bad++;
    console.log(`${same ? '  same ' : '  DIFF '}${k.padEnd(9)}${same ? a.slice(0, 90) : '\n     old ' + a + '\n     new ' + b}`);
}
//  A version that is not even stable against itself would make the diff above
//  meaningless, so check that too.
for (const [name, arr] of [['eight-spawn', olds], ['one-spawn', news]]) {
    const set = new Set(arr.map(x => JSON.stringify(strip(x))));
    if (set.size !== 1) { bad++; console.log(`  DIFF  ${name} disagrees with ITSELF across 3 runs`); }
    else console.log(`  same  ${name} gives the same answer all 3 runs`);
}
console.log(bad ? `\n${bad} DIFFERENCES` : '\nidentical on every field');
process.exit(bad ? 1 : 0);
