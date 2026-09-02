'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/test-flight-path.js  --  does the rocket ever go underground?
//
//  THE REPORT, with two screenshots. Connecting Bangladesh -> Chile, the rocket
//  did not climb out of Bangladesh: it appeared out of the open Indian Ocean
//  already in flight, and instead of coming down on Chile it went into the sea
//  beside it. The radar ring was in the right place in both frames, so the fault
//  is the flight path and nothing else.
//
//  IT IS NOT A RENDERING GLITCH, IT IS ARITHMETIC. buildCurve() returned a
//  QuadraticBezierCurve3 from vS to vE with one control point pushed straight
//  out along the midpoint direction. A quadratic Bezier leaves each endpoint
//  along the line toward its control point and only ever travels a fraction of
//  the way there -- so near its ends it hugs the CHORD, and the chord between
//  two points more than 90 degrees apart passes inside the sphere.
//
//  The condition is exact. Writing h for the control point's distance from the
//  centre in globe radii, the curve's radius grows at launch only if
//
//        h  >  sec(angle / 2)
//
//  The old code chose h = 1.5 + 1.3 * angle/pi: at 160 degrees that is 2.66
//  against a sec of 5.76, so the curve turned inward instead of climbing.
//  Bangladesh -> Chile is 159.9 degrees.
//
//  So this file looks at no pixels. It lifts the REAL buildCurve out of
//  globe-controller.js, runs it over every ordered pair of the countries main.js
//  can actually place, and measures the smallest radius each curve reaches.
//  Below the globe's own radius is the rocket inside the planet.
//
//  Nothing is started, nothing is written, no network call is made.
// ════════════════════════════════════════════════════════════════════
const fs   = require('fs');
const path = require('path');
const vm   = require('vm');
const { geoFromMainJs, literalAt } = require('./geo-from-main.js');

const ROOT = path.join(__dirname, '..');
//  FP_GLOBE is how .build/probe-mutate-flight.js points this at a throwaway
//  copy; the same idiom as FP_BG in test-geo-switch.js. Unset, it reads what
//  ships.
const SRCFILE = process.env.FP_GLOBE || path.join(ROOT, 'globe-controller.js');
const src  = fs.readFileSync(SRCFILE, 'utf8');
const GEO  = geoFromMainJs(ROOT);

let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
    if (cond) { pass++; console.log('  ok   ' + name); }
    else { fail++; console.log('  FAIL ' + name + (extra ? '  -- ' + extra : '')); }
};

const R = 100;                     // three-globe's GLOBE_RADIUS
const DEG = Math.PI / 180;

// ── just enough THREE, and the real globe.getCoords convention ──────
//  three-globe maps a coordinate with phi = (90 - lat) and theta = (90 - lng),
//  read out of vendor/globe.gl.min.js rather than assumed. Which axes those land
//  on does not affect anything measured here -- every quantity below is a radius
//  or an angle -- but using the shipped convention removes the question.
class V3 {
    constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
    set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
    copy(v) { return this.set(v.x, v.y, v.z); }
    clone() { return new V3(this.x, this.y, this.z); }
    add(v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
    sub(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
    multiplyScalar(s) { this.x *= s; this.y *= s; this.z *= s; return this; }
    addScaledVector(v, s) { this.x += v.x * s; this.y += v.y * s; this.z += v.z * s; return this; }
    dot(v) { return this.x * v.x + this.y * v.y + this.z * v.z; }
    lengthSq() { return this.dot(this); }
    length() { return Math.sqrt(this.lengthSq()); }
    normalize() { const l = this.length() || 1; return this.multiplyScalar(1 / l); }
    cross(v) {
        const { x, y, z } = this;
        return this.set(y * v.z - z * v.y, z * v.x - x * v.z, x * v.y - y * v.x);
    }
    angleTo(v) {
        const d = this.dot(v) / ((this.length() * v.length()) || 1);
        return Math.acos(Math.max(-1, Math.min(1, d)));
    }
    distanceToSquared(v) { return (this.x-v.x)**2 + (this.y-v.y)**2 + (this.z-v.z)**2; }
}
//  Present so this file still runs, and still fails, against the OLD curve.
class QuadraticBezierCurve3 {
    constructor(v0, v1, v2) { this.v0 = v0; this.v1 = v1; this.v2 = v2; }
    getPoint(t) {
        const a = (1 - t) * (1 - t), b = 2 * t * (1 - t), c = t * t;
        return new V3(this.v0.x*a + this.v1.x*b + this.v2.x*c,
                      this.v0.y*a + this.v1.y*b + this.v2.y*c,
                      this.v0.z*a + this.v1.z*b + this.v2.z*c);
    }
    getTangent(t) {
        const p = this.getPoint(Math.min(t + 1e-4, 1)), q = this.getPoint(Math.max(t - 1e-4, 0));
        return p.sub(q).normalize();
    }
}

const getCoords = (lat, lng, alt = 0) => {
    const phi = (90 - lat) * DEG, theta = (90 - lng) * DEG, r = R * (1 + alt);
    return { x: r * Math.sin(phi) * Math.cos(theta),
             y: r * Math.cos(phi),
             z: r * Math.sin(phi) * Math.sin(theta) };
};

// ── lift the real buildCurve, do not re-describe it ─────────────────
const at = src.indexOf('function buildCurve(');
if (at < 0) { console.log('ABORT: globe-controller.js no longer declares buildCurve'); process.exit(3); }
const lifted = src.slice(at, src.indexOf('{', at)) + literalAt(src, at);

const ctx = vm.createContext({
    window: { THREE: { Vector3: V3, QuadraticBezierCurve3 } },
    globe: { getCoords },
    Math, console,
});
vm.runInContext(lifted, ctx, { filename: 'globe-controller-lifted.js' });
const buildCurve = (a, b, c, d) =>
    vm.runInContext('buildCurve(__a[0],__a[1],__a[2],__a[3])',
                    Object.assign(ctx, { __a: [a, b, c, d] }));

// ── what a flight path has to satisfy ───────────────────────────────
//  SAMPLES is deliberately dense at the ends: that is where a chord-hugging
//  curve dips under, and where 20 evenly spaced samples would step straight over
//  the dip and report a clean run.
const SAMPLES = (() => {
    const ts = [];
    for (let i = 0; i <= 400; i++) ts.push(i / 400);
    for (let i = 1; i <= 60; i++) { ts.push(i / 6000); ts.push(1 - i / 6000); }
    return ts.sort((x, y) => x - y);
})();

const unit = (lat, lng) => { const c = getCoords(lat, lng, 0); return new V3(c.x, c.y, c.z).normalize(); };

//  Everything one curve can be wrong about, measured in one pass.
function measure(aLat, aLng, bLat, bLng) {
    const cur = buildCurve(aLat, aLng, bLat, bLng);
    const uS = unit(aLat, aLng), uE = unit(bLat, bLng);
    //  The great-circle plane's normal. A ground track that stays on the great
    //  circle has zero component along it -- that is what "flies over the
    //  countries in between" means, as opposed to over some other longitude.
    const nrm = uS.clone().cross(uE);
    const planar = nrm.length() > 1e-9 ? nrm.normalize() : null;
    const total = uS.angleTo(uE);

    let minR = Infinity, maxR = 0, offPlane = 0, backtrack = 0, prevAng = -1;
    for (const t of SAMPLES) {
        const p = cur.getPoint(t);
        const r = p.length();
        if (!isFinite(r)) return { nan: true };
        minR = Math.min(minR, r); maxR = Math.max(maxR, r);
        const d = p.clone().normalize();
        if (planar) offPlane = Math.max(offPlane, Math.abs(d.dot(planar)));
        const ang = uS.angleTo(d);
        if (ang < prevAng - 1e-6) backtrack++;
        prevAng = ang;
    }
    //  Attitude at both ends, signed: the angle of the direction of travel above
    //  the local horizon. Launch must be POSITIVE (climbing out of the ground)
    //  and landing NEGATIVE (coming down onto it). A positive landing is the
    //  second screenshot -- the rocket rising up out of the sea into Chile,
    //  which is what a curve that went underground has to do to get back.
    const elev = t => {
        const p = cur.getPoint(t), q = cur.getPoint(t + (t < 0.5 ? 1e-3 : -1e-3));
        const step = (t < 0.5 ? q.clone().sub(p) : p.clone().sub(q));
        const up = p.clone().normalize();
        const l = step.length() || 1;
        return Math.asin(Math.max(-1, Math.min(1, step.dot(up) / l))) / DEG;
    };
    //  getTangent() is a SEPARATE analytic derivative, and nothing above would
    //  notice if it disagreed with the path it belongs to: buildTrail() is its
    //  only caller and it uses it to orient the smoke column across the flight.
    //  A mutation that flipped the sign of the altitude term's derivative went
    //  16/16 before this was added. So it is checked against the numerical
    //  derivative of getPoint(), and its attitude at both ends is checked too.
    let tanErr = 0, tanLenMin = Infinity;
    for (const t of [0, 0.02, 0.25, 0.5, 0.75, 0.98, 1]) {
        const an = cur.getTangent(t);
        tanLenMin = Math.min(tanLenMin, an.length());
        const h = 1e-5;
        const num = cur.getPoint(Math.min(1, t + h)).sub(cur.getPoint(Math.max(0, t - h)));
        const nl = num.length();
        if (nl < 1e-8) continue;
        tanErr = Math.max(tanErr, an.clone().sub(num.multiplyScalar(1 / nl)).length());
    }
    const tanElev = t => {
        const tg = cur.getTangent(t), up = cur.getPoint(t).normalize();
        return Math.asin(Math.max(-1, Math.min(1, tg.dot(up)))) / DEG;
    };
    return {
        minR, maxR, total: total / DEG, offPlane, backtrack, tanErr, tanLenMin,
        tanLaunch: tanElev(0), tanLand: tanElev(1),
        launchElev: elev(0), landElev: elev(1),
        startErr: cur.getPoint(0).sub(unit(aLat, aLng).multiplyScalar(cur.getPoint(0).length())).length(),
        endErr:   cur.getPoint(1).sub(unit(bLat, bLng).multiplyScalar(cur.getPoint(1).length())).length(),
    };
}

// ── 1. the pair that was reported ───────────────────────────────────
const codes = Object.keys(GEO);
console.log(`── 1. the reported flight: Bangladesh -> Chile ──`);
const bd = GEO.bd, cl = GEO.cl;
if (!bd || !cl) {
    console.log('  ABORT: main.js can no longer place bd and/or cl');
    process.exit(3);
}
const rep = measure(bd.lat, bd.lng, cl.lat, cl.lng);
console.log(`   ${rep.total.toFixed(1)} deg apart;  radius ranges ` +
            `${rep.minR.toFixed(2)} .. ${rep.maxR.toFixed(2)}  (surface = ${R})`);
console.log(`   launch attitude ${rep.launchElev.toFixed(1)} deg, ` +
            `landing ${rep.landElev.toFixed(1)} deg relative to the local horizon`);
ok(rep.minR >= R, 'the rocket never goes below the surface on this flight',
   `dips to ${rep.minR.toFixed(2)}, i.e. ${(R - rep.minR).toFixed(2)} units underground`);
ok(rep.launchElev > 5, 'it climbs OUT of Bangladesh instead of nosing into it',
   `launch attitude ${rep.launchElev.toFixed(1)} deg -- negative is into the ground`);
ok(rep.landElev < -5, 'it comes DOWN onto Chile instead of rising into it out of the sea',
   `landing attitude ${rep.landElev.toFixed(1)} deg -- positive means it arrives climbing`);
//  The rocket's own nose, and the smoke column, are aimed by getTangent(), not by
//  the difference of two points -- so the direction the path GOES and the
//  direction the code SAYS it goes are two separate claims and both are checked.
console.log(`   getTangent attitude ${rep.tanLaunch.toFixed(1)} / ${rep.tanLand.toFixed(1)} deg, ` +
            `worst disagreement with the path itself ${rep.tanErr.toExponential(2)}`);
ok(rep.tanErr < 1e-4, 'the analytic tangent agrees with the path it belongs to',
   `off by ${rep.tanErr.toExponential(2)}`);
ok(rep.tanLaunch > 5 && rep.tanLand < -5,
   'the tangent points up at launch and down at landing, as the path does',
   `${rep.tanLaunch.toFixed(1)} / ${rep.tanLand.toFixed(1)} deg`);

// ── 2. every ordered pair the app can actually fly ──────────────────
console.log(`\n── 2. all ${codes.length * (codes.length - 1)} ordered country pairs ──`);
let worst = null, under = 0, offPlaneMax = 0, backtracks = 0, nan = 0;
let minLaunch = Infinity, maxLand = -Infinity, endErrMax = 0;
let tanErrMax = 0, minTanLaunch = Infinity, maxTanLand = -Infinity;
for (const a of codes) for (const b of codes) {
    if (a === b) continue;
    const m = measure(GEO[a].lat, GEO[a].lng, GEO[b].lat, GEO[b].lng);
    if (m.nan) { nan++; continue; }
    if (m.minR < R - 1e-6) { under++; if (!worst || m.minR < worst.m.minR) worst = { a, b, m }; }
    offPlaneMax = Math.max(offPlaneMax, m.offPlane);
    backtracks += m.backtrack ? 1 : 0;
    minLaunch = Math.min(minLaunch, m.launchElev);
    maxLand   = Math.max(maxLand,   m.landElev);
    endErrMax = Math.max(endErrMax, m.startErr, m.endErr);
    tanErrMax = Math.max(tanErrMax, m.tanErr);
    minTanLaunch = Math.min(minTanLaunch, m.tanLaunch);
    maxTanLand   = Math.max(maxTanLand,   m.tanLand);
}
if (worst) console.log(`   deepest: ${worst.a} -> ${worst.b} at ${worst.m.total.toFixed(1)} deg, ` +
                       `${(R - worst.m.minR).toFixed(2)} units underground`);
console.log(`   shallowest launch ${minLaunch.toFixed(1)} deg (want > 0), ` +
            `shallowest landing ${maxLand.toFixed(1)} deg (want < 0)`);
console.log(`   furthest off the great-circle plane: ${offPlaneMax.toExponential(2)}`);

ok(nan === 0, 'no pair produces a NaN point', `${nan} pair(s) did`);
ok(under === 0, 'no pair sends the rocket under the surface at any point',
   `${under} pair(s) do, deepest ${worst ? worst.a + '->' + worst.b : ''}`);
ok(minLaunch > 5, 'every pair launches with the nose above the horizon',
   `shallowest ${minLaunch.toFixed(1)} deg`);
ok(maxLand < -5, 'every pair arrives descending, not climbing out of the ground',
   `shallowest ${maxLand.toFixed(1)} deg`);
//  This is the "properly curved over the countries in between" claim: the ground
//  track is the great circle through the two capitals, so the rocket passes over
//  the same places a real flight would, and never over some other longitude.
ok(offPlaneMax < 1e-6, 'every ground track stays on the great circle between the two',
   `off-plane component ${offPlaneMax.toExponential(2)}`);
ok(backtracks === 0, 'no path doubles back on itself', `${backtracks} pair(s) do`);
ok(endErrMax < 1e-6, 'every curve starts over the origin country and ends over the destination',
   `worst endpoint offset ${endErrMax.toExponential(2)}`);
console.log(`   getTangent: worst disagreement ${tanErrMax.toExponential(2)}, ` +
            `attitudes ${minTanLaunch.toFixed(1)} .. ${maxTanLand.toFixed(1)} deg`);
ok(tanErrMax < 1e-4, 'every curve\'s analytic tangent agrees with its own path',
   `worst disagreement ${tanErrMax.toExponential(2)}`);
ok(minTanLaunch > 5 && maxTanLand < -5,
   'every curve reports a nose-up launch and a nose-down landing',
   `shallowest launch ${minTanLaunch.toFixed(1)}, shallowest landing ${maxTanLand.toFixed(1)} deg`);

// ── 3. the degenerate geometry a country list can hand it ────────────
console.log('\n── 3. degenerate cases ──');
const cases = [
    ['exact antipodes across the equator', 0, 0, 0, 180],
    ['pole to pole',                       90, 0, -90, 0],
    ['pole to pole, other meridian',       90, 45, -90, 45],
    ['the same country twice',             bd.lat, bd.lng, bd.lat, bd.lng],
    ['two capitals 0.01 deg apart',        10, 20, 10.01, 20],
    ['across the date line',               -18.14, 178.44, 21.31, -157.86],
];
for (const [label, aLat, aLng, bLat, bLng] of cases) {
    const m = measure(aLat, aLng, bLat, bLng);
    ok(!m.nan && m.minR >= R - 1e-6 && m.launchElev > 5 && m.landElev < -5,
       `${label}: above the surface, climbs out, comes down, no NaN`,
       m.nan ? 'NaN point'
             : `min radius ${m.minR.toFixed(3)}, launch ${m.launchElev.toFixed(1)}, ` +
               `land ${m.landElev.toFixed(1)}`);
    //  buildTrail() normalises getTangent(), so a zero-length one puts NaN into
    //  every puff of the smoke column. The only place it can be zero is here:
    //  a "flight" whose ground track has no length, at the apex where the climb
    //  rate is also zero -- which is what "the same country twice" is.
    ok(!m.nan && m.tanLenMin > 0.5 && m.tanErr < 1e-4,
       `${label}: the tangent is a usable direction everywhere along it`,
       m.nan ? 'NaN point'
             : `shortest tangent ${m.tanLenMin.toFixed(3)}, ` +
               `worst disagreement ${m.tanErr.toExponential(2)}`);
}

// ── 4. the degenerate branch, reached on purpose ─────────────────────
//  Section 3's "exact antipodes" is not exact. getCoords(0,0) x getCoords(0,180)
//  has length 1.7e-12 rather than 0, because JS sin/cos never return an exact
//  zero at those angles -- so normalize() rescues the axis from noise, and for an
//  antipodal pair ANY plane is a correct great circle, so the path is fine and
//  the degenerate branch is never entered. Deleting that branch therefore still
//  passed everything above, which is a hole and not a licence to delete it: fed
//  two vectors that really are exactly opposite, the cross product is exactly
//  zero, THREE's normalize() leaves it zero (it divides by length() || 1), w
//  collapses to nothing and dir(a) = uS*cos(a) -- radius 0 at the apex, i.e. a
//  flight through the centre of the planet.
//
//  Whether globe.getCoords() can hand buildCurve such a pair is not something
//  this file can settle, so it hands it one directly, through the same stub the
//  rest of the file uses. These are the only checks here that reach inside.
console.log('\n── 4. coordinates that land exactly opposite / identical ──');
const EXACT = [
    //  The first is also the case where uS is parallel to the guard's own first
    //  choice of perpendicular, so its `> 0.9` escape hatch has to fire; the
    //  second is the case where it must NOT fire. Both halves of the guard.
    ['exactly opposite, on an axis',       [0, 100, 0], [0, -100, 0]],
    ['exactly opposite, off-axis (3-4-5)', [60, 80, 0], [-60, -80, 0]],
    ['exactly the same point',             [0, 100, 0], [0, 100, 0]],
];
for (const [label, A, B] of EXACT) {
    let nth = 0;
    ctx.globe.getCoords = () => {
        const v = (nth++ % 2 === 0) ? A : B;
        return { x: v[0], y: v[1], z: v[2] };
    };
    let cur;
    try { cur = buildCurve(0, 0, 0, 0); } catch (e) { cur = null; }
    let minR = Infinity, tanMin = Infinity, bad = !cur;
    if (cur) for (const t of SAMPLES) {
        const p = cur.getPoint(t), r = p.length();
        if (!isFinite(r)) { bad = true; break; }
        minR = Math.min(minR, r);
    }
    if (cur && !bad) for (const t of [0, 0.25, 0.5, 0.75, 1]) {
        const l = cur.getTangent(t).length();
        if (!isFinite(l)) { bad = true; break; }
        tanMin = Math.min(tanMin, l);
    }
    //  Landing on B is the other half of it: the fallback axis is arbitrary, but
    //  whichever one it picks, uS*cos(angle) + w*sin(angle) still has to be uE.
    const endOff = (cur && !bad)
        ? cur.getPoint(1).normalize().sub(new V3(B[0], B[1], B[2]).normalize()).length() : Infinity;
    ok(!bad && minR >= R - 1e-6 && tanMin > 0.5 && endOff < 1e-6,
       `${label}: still a real flight, over the surface, ending at the destination`,
       bad ? 'NaN or a throw'
           : `min radius ${minR.toFixed(3)}, shortest tangent ${tanMin.toFixed(3)}, ` +
             `endpoint off by ${endOff.toExponential(2)}`);
}
ctx.globe.getCoords = getCoords;

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
