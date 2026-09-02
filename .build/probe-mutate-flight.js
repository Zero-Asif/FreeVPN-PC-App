'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/probe-mutate-flight.js  --  can .build/test-flight-path.js fail?
//
//  It went 7/16 against the old curve and 16/16 against the new one, which is
//  already a real before-and-after rather than a green run on its own. But the
//  new code has parts the old curve never exercised -- the two degenerate-axis
//  branches, the sin(pi*t) profile, the tangent's zero guard -- and 16/16 says
//  nothing about those unless a wrong version of each is shown to fail.
//
//  So each mistake this function could plausibly make is written back into a
//  throwaway copy of globe-controller.js and the suite is run against the copy.
//  A mutant that still passes is the finding. globe-controller.js itself is
//  never modified: the copies live in the OS temp directory and are deleted at
//  the end.
// ════════════════════════════════════════════════════════════════════
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC  = path.join(ROOT, 'globe-controller.js');
const TEST = path.join(__dirname, 'test-flight-path.js');
const TMP  = fs.mkdtempSync(path.join(os.tmpdir(), 'fpflt-'));
const src  = fs.readFileSync(SRC, 'utf8');

//  [name, find, replace]. `find` must appear exactly once or the mutation is
//  reported as not applied -- one that failed to apply would "pass" and read as
//  a hole in the suite.
const MUTANTS = [
    ['the old quadratic Bezier is put back',
     '        getPoint(t) { return dir(angle * t).multiplyScalar(R * (1 + alt(t))); },',
     '        getPoint(t) { const vC = uS.clone().add(uE).multiplyScalar(0.5).normalize()\n' +
     '                          .multiplyScalar(R * (2.5 + 1.3 * (angle / Math.PI)));\n' +
     '            const a = (1-t)*(1-t), b = 2*t*(1-t), c = t*t;\n' +
     '            return vS.clone().multiplyScalar(a).add(vC.multiplyScalar(b))\n' +
     '                     .add(vE.clone().multiplyScalar(c)); },'],

    ['the altitude profile loses its sine and becomes a straight lift',
     'const alt  = t => PAD + (peak - PAD) * Math.sin(Math.PI * t);',
     'const alt  = t => PAD + (peak - PAD) * t;'],

    ['the profile dips below the surface at the ends',
     'const alt  = t => PAD + (peak - PAD) * Math.sin(Math.PI * t);',
     'const alt  = t => PAD + (peak - PAD) * Math.sin(Math.PI * t) - 0.05;'],

    ['the apex is flattened to nothing, so the path lies on the surface',
     '    const BASE = 0.28;',
     '    const BASE = 0.0;'],

    ['the ground track is a chord instead of a great circle',
     '        getPoint(t) { return dir(angle * t).multiplyScalar(R * (1 + alt(t))); },',
     '        getPoint(t) { return uS.clone().multiplyScalar(1 - t).add(uE.clone()\n' +
     '                          .multiplyScalar(t)).multiplyScalar(R * (1 + alt(t))); },'],

    ['the antipodal / same-point axis guard is removed',
     '    if (axis.length() < 1e-9) {',
     '    if (false) {'],

    ['the guard picks an axis parallel to uS, so w collapses',
     "        if (Math.abs(uS.dot(perp)) > 0.9) perp.set(1, 0, 0);",
     '        perp.copy(uS);'],

    ['the basis vector w is built from the wrong cross product order',
     '    const w    = axis.clone().cross(uS).normalize();',
     '    const w    = uS.clone().cross(axis).normalize();'],

    ['the ground track runs backwards, away from the destination',
     '        getPoint(t) { return dir(angle * t).multiplyScalar(R * (1 + alt(t))); },',
     '        getPoint(t) { return dir(-angle * t).multiplyScalar(R * (1 + alt(t))); },'],

    ['the altitude derivative loses its sign, so it lands nose-up',
     'const dAlt = t => (peak - PAD) * Math.PI * Math.cos(Math.PI * t);',
     'const dAlt = t => (peak - PAD) * Math.PI * Math.abs(Math.cos(Math.PI * t));'],

    ['the tangent drops its ground-track term',
     '            const v = dir(a).multiplyScalar(dAlt(t))\n' +
     '                            .add(dDir.multiplyScalar(angle * (1 + alt(t))));',
     '            const v = dir(a).multiplyScalar(dAlt(t));'],

    ['the path is clamped to the surface radius',
     '        getPoint(t) { return dir(angle * t).multiplyScalar(R * (1 + alt(t))); },',
     '        getPoint(t) { return dir(angle * t).multiplyScalar(R); },'],

    ['the guard keeps its first perpendicular even when uS is parallel to it',
     '        if (Math.abs(uS.dot(perp)) > 0.9) perp.set(1, 0, 0);',
     '        if (false) perp.set(1, 0, 0);'],

    //  The one with a fourth element is EXPECTED to escape, and the fourth element
    //  is why. Leaving it in the list with its reason is the point: a mutation
    //  quietly deleted because it would not die is the same thing as a hole.
    ['the tangent loses its zero guard, so it can hand back a zero direction',
     '            return v.lengthSq() < 1e-12 ? w.clone() : v.normalize();',
     '            return v.normalize();',
     'v is zero only where the ground track has no length AND the climb rate is ' +
     'zero -- the same country twice, at t = 0.5. But Math.cos(Math.PI * 0.5) is ' +
     '6.1e-17, not 0, so v is about 5.8e-17 long rather than empty, and normalize() ' +
     'divides by the true length and returns a unit vector anyway: uS, radially ' +
     'outward, instead of w along the track. Both are length 1, and buildTrail() ' +
     'needs only a usable direction, so there is nothing observable to assert. The ' +
     'guard stays because it costs nothing and the alternative is a division saved ' +
     'only by an accident of IEEE-754.'],
];

const run = file => {
    try {
        return { code: 0, out: execFileSync(process.execPath, [TEST], {
            env: { ...process.env, FP_GLOBE: file }, encoding: 'utf8', stdio: 'pipe',
        }) };
    } catch (e) {
        return { code: e.status == null ? 3 : e.status,
                 out: (e.stdout || '') + (e.stderr || '') };
    }
};

let caught = 0, escaped = 0, unapplied = 0, expected = 0, stale = 0;
const tally = s => (s.match(/^\d+\/\d+ checks passed$/m) || ['?'])[0];

//  globe-controller.js is CRLF throughout (1196 pairs, zero bare LF), so a
//  multi-line `find` written here with \n matches nothing -- it reported NOT
//  APPLIED, which reads exactly like a hole in the suite. Both endings are tried,
//  and the replacement is rewritten to whichever one matched so the patched copy
//  keeps the file's own convention.
const fit = (s) => {
    if (src.split(s).length - 1 === 1) return { s, crlf: false };
    const c = s.replace(/\r?\n/g, '\r\n');
    if (src.split(c).length - 1 === 1) return { s: c, crlf: true };
    return { s, crlf: false };
};

const base = run(SRC);
console.log(`── unmutated: exit ${base.code}, ${tally(base.out)}\n`);
if (base.code !== 0) {
    console.log('ABORT: the suite is not green against the real file, so mutation says nothing.');
    console.log(base.out.split('\n').filter(l => /FAIL|ABORT/.test(l)).join('\n'));
    process.exit(3);
}

MUTANTS.forEach(([name, rawFind, rawRepl, why], i) => {
    const { s: find, crlf } = fit(rawFind);
    const repl = crlf ? rawRepl.replace(/\r?\n/g, '\r\n') : rawRepl;
    const hits = src.split(find).length - 1;
    if (hits !== 1) {
        unapplied++;
        console.log(`  ??   ${name}\n         NOT APPLIED: the pattern appears ${hits} times`);
        return;
    }
    const file = path.join(TMP, `globe${i}.js`);
    fs.writeFileSync(file, src.replace(find, repl));
    const r = run(file);
    const fails = (r.out.match(/^ {2}FAIL /gm) || []).length;
    if (r.code === 0) {
        if (why) {
            expected++;
            console.log(`  escapes, and why  ${name}`);
            console.log(why.replace(/(.{1,86})( |$)/g, '           $1\n').replace(/\n$/, ''));
        } else {
            escaped++;
            console.log(`  ESCAPED  ${name}\n           ${tally(r.out)} -- nothing here notices this mistake`);
        }
        return;
    }
    caught++;
    const firstFail = (r.out.match(/^ {2}FAIL (.+)$/m) || [])[1] || `ABORT (exit ${r.code})`;
    console.log(`  caught   ${name}\n           ${fails} check(s) failed, first: ${firstFail.slice(0, 110)}`);
    //  A mutant carrying a written reason it cannot die, that then dies, means the
    //  reason is out of date -- which is worth saying as loudly as an escape.
    if (why) { stale++; console.log('           STALE NOTE: this one is now caught, so its written reason no longer holds'); }
});

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}

console.log(`\n${caught}/${MUTANTS.length} mutations caught` +
            (expected ? `, ${expected} escaping for a written reason` : '') +
            (escaped ? `, ${escaped} ESCAPED` : '') +
            (stale ? `, ${stale} stale note(s)` : '') +
            (unapplied ? `, ${unapplied} not applied` : ''));
process.exit(escaped || unapplied || stale ? 1 : 0);
