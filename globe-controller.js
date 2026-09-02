// ════════════════════════════════════════════════════════════════════
//  🌍 FREEPROXY GLOBE CONTROLLER  — Point 2 Complete
//
//  Physics fixes:
//  • Altitude = 0.5 + (angularDistance/π) × 1.3  →  never clips globe
//  • Short routes: 50% above surface
//  • Cross-globe routes: up to 180% above surface
//
//  State machine:
//  launching (0→0.5 apex) → hovering (apex ±bob) → landing (0.5→1)
//                                                  → exploding (burst + camera home)
//
//  API exposed to renderer.js:
//    window.flyToCountry(code)  — start hover-flight to country
//    window.landRocket()        — called when Tor connects (land at dest)
//    window.explodeRocket()     — called when Tor fails (mid-air blast)
//    window.backToHome()        — normal disconnect return flight
// ════════════════════════════════════════════════════════════════════

let globe;

// ════════════════════════════════════════════════════════════════════
//  WHERE THINGS ARE  --  three separate ideas, kept separate
//
//  HOME_LOC   the user's own position, from the lookup in the main process.
//             `known` is false until something answers, and this is the only
//             thing in the file that may set it true.
//  ANCHOR     where the app currently IS on the globe: home while
//             disconnected, the connected country while connected, and null
//             when neither is known. Every flight departs from here, and
//             ANCHOR moves only when a flight RESOLVES -- never when one
//             starts. The old code assigned the destination optimistically
//             the moment Connect was pressed, so a connect that failed had
//             already forgotten where it came from.
//  PENDING    the country a connect attempt is heading for, whether or not a
//             rocket is being drawn for it. With the kill switch on and
//             nothing connected there is no honest origin to launch from, so
//             no rocket flies -- but the attempt still has to be able to land.
//
//  The rule this structure exists to keep: wherever the radar pulse ring is
//  drawn, that is where the app genuinely is. Ring coordinates therefore come
//  from main.js's GEO_COORDS -- the same table that decides what actually gets
//  spoofed -- over IPC, and not from a second copy kept here. There WAS a
//  second copy, and it had drifted: it was missing md, cy, cr and sc, so
//  choosing Moldova drew the ring at 0,0 in the Gulf of Guinea while the app
//  was correctly spoofing Chisinau.
// ════════════════════════════════════════════════════════════════════
let HOME_LOC = { lat: 0, lng: 0, name: 'your location', code: 'unknown', known: false };
let HOME_WHY = 'pending';   // pending | ok | killswitch | connected | no-answer
let ANCHOR   = null;        // { lat, lng, name, code, kind, placed } | null
let PENDING  = null;        // { code, dest, outcome } while a connect attempt runs

//  Where the light comes from. Shared by the scene's directional light and by
//  the night-lights shader, which masks itself to the hemisphere facing away
//  from exactly this vector -- if the two disagreed, city lights would burn
//  in broad daylight. Offset from straight-behind-the-camera so the
//  terminator is actually on screen without leaving the first view dark.
const SUN_DIR = { x: 260, y: 140, z: 190 };

// Rocket mesh (Three.js Group)
let rocketMesh = null;

// Active flight controller — shared state between all animation phases
let FC = null; // FlightController object (see createFC)

// ════════════════════════════════════════════════════════════════════
//  COUNTRY COORDINATES  --  main.js's GEO_COORDS, asked for once.
// ════════════════════════════════════════════════════════════════════
//  NOT named ipcRenderer. index.html loads this file and renderer.js as two
//  classic scripts, and classic scripts share ONE global lexical scope --
//  renderer.js:1 already holds `const { ipcRenderer }`. A second top-level
//  const of that name is a SyntaxError raised while parsing whichever file
//  loads second, which would take the whole of renderer.js down with it.
const ipc = require('electron').ipcRenderer;

let GEO = null;
async function loadGeo() {
    if (GEO) return GEO;
    try { GEO = (await ipc.invoke('get-geo-coords')) || null; }
    catch (e) { GEO = null; }
    return GEO;
}
//  Asked for at load rather than on the first Connect, so that by the time a
//  flight needs coordinates they are already here and no animation has to wait
//  on IPC in the middle of itself.
loadGeo();

//  Country names come from Intl, the way every other surface in this app
//  spells them, so there is no second list of names to drift either.
let _regionNames = null;
function countryLabel(cc) {
    const up = (cc || '').toUpperCase();
    try {
        if (!_regionNames) _regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
        return _regionNames.of(up) || up;
    } catch (e) { return up; }
}

//  `placed` is the honest bit: false means main.js has no coordinates for this
//  country, so it is not spoofing a position there either -- spoofableOnly() in
//  main.js already refuses to offer such a country in the list. An unplaced
//  country still gets its name in the caption, because the tunnel really is out
//  through it, but no ring is drawn for it and no rocket ever launches from it:
//  there is no point on the globe that would be true.
function destFor(cc) {
    const k   = (cc || '').toLowerCase();
    const g   = GEO && GEO[k];
    const lat = g ? Number(g.lat) : NaN;
    const lng = g ? Number(g.lng) : NaN;
    return { lat, lng, code: k, name: countryLabel(k), kind: 'country',
             placed: Number.isFinite(lat) && Number.isFinite(lng) };
}

function whenReady(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
}

// ════════════════════════════════════════════════════════════════════
//  HELPERS
// ════════════════════════════════════════════════════════════════════
function setPulse(lat, lng, color) {
    if (!globe) return;
    globe.ringsData([{ lat, lng }])
        .ringColor(() => color)
        .ringMaxRadius(7).ringPropagationSpeed(3).ringRepeatPeriod(1000);
}
function clearPulse() { if (globe) globe.ringsData([]); }

function setOverlay(text, color = '#00ffcc') {
    const el = document.getElementById('status-overlay');
    if (!el) return;
    el.innerText      = text;
    el.style.color    = color;
    el.style.borderColor = color;
}

//  Whether the app actually knows where the user is. It cannot be guessed:
//  the only source is the lookup in initUserLocation, and when that does not
//  answer -- or is deliberately not made -- home stays unknown instead of
//  becoming a fixed city.
function homeIsKnown() { return !!(HOME_LOC && HOME_LOC.known); }

//  Is the kill switch on RIGHT NOW. Read from the live checkbox rather than
//  from a cached copy, because the browser extension can flip it too and
//  renderer.js mirrors that straight into this same element.
function killSwitchOn() {
    const el = document.getElementById('killSwitchToggle');
    if (el) return !!el.checked;
    try { return localStorage.getItem('killSwitch') === 'true'; } catch (e) { return false; }
}

//  index.html loads this file BEFORE renderer.js, so this file's
//  DOMContentLoaded listener is registered first and therefore runs first --
//  before renderer.js has restored the toggle from localStorage. Read at that
//  moment the checkbox is still the markup's default, unchecked, and a saved
//  kill switch of ON would have looked OFF for exactly as long as it takes to
//  decide whether to make an IP-geolocation lookup. So the same value is put
//  into the same element from the same key here, a few lines earlier. Not a
//  second source of truth: renderer.js overwrites it with the identical read.
function restoreKillSwitchDisplay() {
    const el = document.getElementById('killSwitchToggle');
    if (!el) return;
    try { el.checked = localStorage.getItem('killSwitch') === 'true'; } catch (e) {}
}

//  The two things that must never happen for an unknown home -- a caption
//  naming a place, and a marker drawn at one -- both go through here.
//
//  When home is unknown the caption says WHICH of the two reasons it is,
//  because they are not the same event. "Kill switch on" is the app doing
//  exactly what it was told: no lookup was made, so no third party was handed
//  this machine's address. "Did not answer" is a failure. Reporting the first
//  as the second is how a kill switch that was working came to look broken.
function showStandingBy() {
    if (homeIsKnown()) { setOverlay(`Standing by in ${HOME_LOC.name} 🌐`, '#00ffcc'); return; }
    if (HOME_WHY === 'killswitch')
        setOverlay('Kill switch on — no location lookup was made 🛡️', '#00ffcc');
    else setOverlay('Home location unavailable — the IP lookup did not answer 🌐', '#ffb020');
}

//  Caption and ring for wherever the app currently is, so that the end of
//  every flight -- landed, blasted or disconnected -- says the same thing
//  about the same place, in one function instead of four.
function showAnchor() {
    if (ANCHOR && ANCHOR.kind === 'country') {
        //  Named either way -- the tunnel is genuinely out through there -- but
        //  a ring is only drawn where there is a real position to draw it at.
        if (ANCHOR.placed) setPulse(ANCHOR.lat, ANCHOR.lng, '#00ffcc');
        else clearPulse();
        setOverlay(`Secured & Routed via ${ANCHOR.name} 🛡️`, '#00ffcc');
        return;
    }
    if (ANCHOR && homeIsKnown()) setPulse(HOME_LOC.lat, HOME_LOC.lng, '#FF416C');
    else clearPulse();
    showStandingBy();
}

function focusHome(ms = 2000, pulseAfter = 1000) {
    if (!globe || !homeIsKnown()) return false;
    globe.pointOfView({ lat: HOME_LOC.lat, lng: HOME_LOC.lng, altitude: 2.5 }, ms);
    if (pulseAfter >= 0)
        setTimeout(() => setPulse(HOME_LOC.lat, HOME_LOC.lng, '#FF416C'), pulseAfter);
    return true;
}

//  Where a flight departs from. null means there is nowhere honest to launch
//  from, and the caller then draws no rocket at all rather than one rising out
//  of the middle of the Atlantic -- which is exactly what a launch from 0,0
//  looked like on screen.
function originLoc() {
    if (ANCHOR && ANCHOR.placed) return ANCHOR;
    if (homeIsKnown()) return { ...HOME_LOC, kind: 'home', placed: true };
    return null;
}

//  A connect that resolved before any rocket could be built: there was no
//  origin to launch from, or the answer came back inside the 960 ms the launch
//  waits out. The app simply IS in that country now, so the ring goes there and
//  the attempt is over.
function settleWithoutFlight(dest) {
    PENDING = null;
    ANCHOR  = dest;
    if (globe && dest.placed)
        globe.pointOfView({ lat: dest.lat, lng: dest.lng, altitude: 1.8 }, 1800);
    showAnchor();
}

// ════════════════════════════════════════════════════════════════════
//  WHERE THE USER IS  (asked of the main process, never of this window)
//
//  This used to be a fetch() from here to freeipapi.com. That host now answers
//  the path with a 302 to a subdomain; index.html's Content-Security-Policy is
//  re-applied to a redirect target, and CSP host-sources do not match
//  subdomains -- so the policy silently killed the lookup on every machine,
//  and the globe correctly reported that it did not know where the user was.
//  The lookup now runs in the main process across four independent providers
//  (lib/home-location.js), which is also why no remote origin has to appear in
//  this page's connect-src at all any more.
//
//  The main process refuses the question in two states, and says which: the
//  kill switch is on -- an IP-geolocation lookup is precisely the kind of grab
//  the kill switch promises not to allow -- or the tunnel is up, where the
//  request would leave outside it carrying the real IP at the one moment the
//  user is relying on it being hidden.
//
//  With the kill switch on the question is not even asked. Main would refuse it
//  anyway, but main only learns the restored kill-switch value when renderer.js
//  reports it, and this file runs first: for that one moment main would have
//  answered honestly with a live lookup. Not asking closes the window.
// ════════════════════════════════════════════════════════════════════
async function initUserLocation() {
    HOME_LOC = { lat: 0, lng: 0, name: 'your location', code: 'unknown', known: false };
    if (killSwitchOn()) {
        HOME_WHY = 'killswitch';
        if (!PENDING && (!ANCHOR || ANCHOR.kind === 'home')) { ANCHOR = null; showAnchor(); }
        return;
    }
    setOverlay('Detecting location… 🌍', '#00ffcc');
    try {
        const r = await ipc.invoke('get-home-location');
        const d = r && r.loc;
        const lat = d ? parseFloat(d.lat) : NaN;
        const lng = d ? parseFloat(d.lng) : NaN;
        //  An answer without usable coordinates is a lookup that failed: NaN
        //  used to go straight into globe.pointOfView().
        if (!r || !r.ok || !Number.isFinite(lat) || !Number.isFinite(lng)) {
            HOME_WHY = (r && r.reason) || 'no-answer';
        } else {
            HOME_WHY = 'ok';
            HOME_LOC = {
                lat, lng,
                name: [d.city, d.country].filter(Boolean).join(', ') || 'your location',
                code: (d.cc || 'unknown').toLowerCase(),
                known: true
            };
        }
    } catch (e) {
        //  This used to become a hard-coded Dhaka, Bangladesh -- captioned,
        //  pulsed and zoomed to exactly like a real reading, so a user
        //  anywhere else was shown a home they were not in, and every connect
        //  animation launched the rocket from it. A location is not something
        //  this app can guess, so it now says that it does not know.
        HOME_WHY = 'no-answer';
    }
    //  Only touch the anchor while nothing is connected. A lookup that
    //  finishes late must not move a ring a landing has already placed.
    if (!ANCHOR || ANCHOR.kind === 'home')
        ANCHOR = homeIsKnown() ? { ...HOME_LOC, kind: 'home', placed: true } : null;
    if (!PENDING && (!ANCHOR || ANCHOR.kind === 'home')) {
        showAnchor();
        focusHome();
    }
}

//  Asked again when the kill switch goes OFF: the first attempt was refused on
//  purpose, and the ring the user expects to see is now allowed to exist.
window.refreshHomeLocation = function() {
    if (killSwitchOn()) {
        HOME_WHY = 'killswitch';
        HOME_LOC = { lat: 0, lng: 0, name: 'your location', code: 'unknown', known: false };
        if (!PENDING && (!ANCHOR || ANCHOR.kind === 'home')) { ANCHOR = null; showAnchor(); }
        return;
    }
    if (homeIsKnown() || PENDING) return;
    initUserLocation();
};

//  Both routes that can flip the toggle: this window's own checkbox, and the
//  browser extension, whose state renderer.js mirrors into that same element.
//  The extension's value is read out of the message rather than off the DOM --
//  renderer.js updates the checkbox in its own listener, and listener order is
//  not a thing to depend on.
whenReady(() => {
    const el = document.getElementById('killSwitchToggle');
    if (el) el.addEventListener('change', () => window.refreshHomeLocation());
});
ipc.on('sync-ui-state', (event, state) => {
    if (state && typeof state.killSwitch === 'boolean')
        setTimeout(() => window.refreshHomeLocation(), 0);
});

// ════════════════════════════════════════════════════════════════════
//  🚀 ROCKET MESH BUILDER
//  All parts aligned so nose faces +Z in local space.
//  Three.js lookAt() then automatically points the nose toward
//  the next waypoint on the curve.
// ════════════════════════════════════════════════════════════════════
function build3DRocket() {
    const G = window.THREE;
    const wrap = new G.Group();

    // Exhaust smoke (tail end, -Z direction from nose)
    const flameGeo = new G.ConeGeometry(0.45, 1.6, 12);
    flameGeo.rotateX(-Math.PI / 2);
    flameGeo.translate(0, 0, 0.8);
    wrap.add(new G.Mesh(flameGeo,
        new G.MeshBasicMaterial({ color: 0xdddddd, transparent: true, opacity: 0.75 })));

    // Body
    const bodyGeo = new G.CylinderGeometry(0.75, 0.75, 4, 14);
    bodyGeo.rotateX(Math.PI / 2);
    bodyGeo.translate(0, 0, 3.4);
    wrap.add(new G.Mesh(bodyGeo, new G.MeshLambertMaterial({ color: 0xf2f2f2 })));

    // Red accent stripe
    const stripeGeo = new G.CylinderGeometry(0.77, 0.77, 0.55, 14);
    stripeGeo.rotateX(Math.PI / 2);
    stripeGeo.translate(0, 0, 3.9);
    wrap.add(new G.Mesh(stripeGeo, new G.MeshLambertMaterial({ color: 0xff3355 })));

    // Nose cone
    const noseGeo = new G.ConeGeometry(0.75, 2.2, 14);
    noseGeo.rotateX(Math.PI / 2);
    noseGeo.translate(0, 0, 6.5);
    wrap.add(new G.Mesh(noseGeo, new G.MeshLambertMaterial({ color: 0xff3355 })));

    // 4 fins
    const finGeo = new G.BoxGeometry(0.18, 2.4, 1.6);
    const finMat = new G.MeshLambertMaterial({ color: 0xff3355 });
    for (let i = 0; i < 4; i++) {
        const fin = new G.Mesh(finGeo, finMat);
        fin.position.z = 2.2;
        fin.rotation.z = (Math.PI / 2) * i;
        fin.translateX(0.8);
        wrap.add(fin);
    }

    wrap.scale.setScalar(1.3);
    return wrap;
}

// ════════════════════════════════════════════════════════════════════
//  📐 THE FLIGHT PATH  --  a great circle on the ground, an arc in the air.
//
//  This was a QuadraticBezierCurve3 from vS to vE with one control point pushed
//  out along the midpoint direction, under a comment promising "minimum 50%
//  above surface -> rocket NEVER intersects globe". That promise was false, and
//  .build/test-flight-path.js measures by how much.
//
//  A quadratic Bezier leaves each endpoint along the line toward its control
//  point and only ever travels part of the way there, so near its ends it hugs
//  the CHORD -- and the chord between two points more than 90 degrees apart runs
//  inside the sphere. Writing h for the control point's distance from the centre
//  in globe radii, the radius grows at launch only if h > sec(angle/2). The old
//  h = 1.5 + 1.3*angle/pi is 2.66 at 160 degrees, against a sec of 5.76.
//
//  MEASURED, over every ordered pair of the countries main.js can place:
//  348 of 5402 went underground. Bangladesh -> Chile is 160.8 degrees apart and
//  dipped 2.52 units below a 100-unit globe, launching at -12 degrees -- nose
//  into the ground -- and arriving at +12, climbing back out of the Pacific.
//  Worst was Spain -> New Zealand at 178.6 degrees, 6.23 units under. That is
//  exactly what the two screenshots showed: a rocket appearing out of the open
//  Indian Ocean already in flight, and a flat trail into the sea beside Chile
//  instead of a landing on it. The ground track was never the problem -- it was
//  on the great circle to 1e-15 -- the altitude profile was.
//
//  So the path is now built as the two separate things it actually is:
//
//    GROUND TRACK   the great circle, by rotating the start direction about that
//                   circle's own normal. Exact, so the rocket passes over the
//                   same places a real flight would.
//    ALTITUDE       PAD + (PEAK - PAD) * sin(pi * t)
//
//  sin(pi*t) is zero at both ends and never negative between them, so the radius
//  is at least R*(1+PAD) at EVERY t for EVERY pair -- by construction, not by a
//  choice of h that can be too small. It also makes the nose rise steeply off
//  the pad and drop onto the destination, because that term's derivative is
//  largest at exactly the two ends.
// ════════════════════════════════════════════════════════════════════
function buildCurve(startLat, startLng, endLat, endLng) {
    const G  = window.THREE;
    const s  = globe.getCoords(startLat, startLng, 0);
    const e  = globe.getCoords(endLat,   endLng,   0);
    const vS = new G.Vector3(s.x, s.y, s.z);
    const vE = new G.Vector3(e.x, e.y, e.z);
    const R  = vS.length();

    //  PAD: the rocket mesh's origin is its TAIL, so a hair of clearance is what
    //  keeps it standing ON the ground rather than half-sunk in it.
    //  BASE/SPAN: fitted to what the OLD curve actually reached where it worked
    //  -- 0.34 R apex for a 30-degree hop, 0.43 R at 90 -- so short and medium
    //  flights look as they did before. Only the long ones, which are the broken
    //  ones, now climb higher: 0.58 R at 160 degrees, 0.62 at the antipodes.
    const PAD  = 0.006;
    const BASE = 0.28;
    const SPAN = 0.34;

    const uS = vS.clone().normalize();
    const uE = vE.clone().normalize();

    //  The rotation carrying uS onto uE along the great circle. cross() is
    //  degenerate in exactly the two cases where a pair does not define a plane
    //  -- the same point, and exact antipodes -- and a country list reaches both,
    //  so each gets an explicit axis rather than the normalize() of a zero
    //  vector that would put NaN into every point on the path.
    const angle = Math.acos(Math.max(-1, Math.min(1, uS.dot(uE))));
    let axis = uS.clone().cross(uE);
    if (axis.length() < 1e-9) {
        const perp = new G.Vector3(0, 1, 0);
        if (Math.abs(uS.dot(perp)) > 0.9) perp.set(1, 0, 0);
        axis = uS.clone().cross(perp);
    }
    axis.normalize();

    //  uS and w are an orthonormal basis of the flight plane, so the point a
    //  radians along the great circle from the start is uS*cos(a) + w*sin(a):
    //  Rodrigues with the axis term dropped, the axis being perpendicular to uS
    //  by construction. At a = angle this returns uE exactly.
    const w    = axis.clone().cross(uS).normalize();
    const peak = BASE + SPAN * (angle / Math.PI);
    const alt  = t => PAD + (peak - PAD) * Math.sin(Math.PI * t);
    const dAlt = t => (peak - PAD) * Math.PI * Math.cos(Math.PI * t);
    const dir  = a => new G.Vector3(uS.x * Math.cos(a) + w.x * Math.sin(a),
                                    uS.y * Math.cos(a) + w.y * Math.sin(a),
                                    uS.z * Math.cos(a) + w.z * Math.sin(a));

    //  getPoint() and getTangent() are the whole of what is ever asked of this
    //  -- by positionRocket() and by buildTrail(), and by nothing else -- so it
    //  is those two functions in the open, rather than a THREE.Curve subclass
    //  whose behaviour would live inside the minified vendor bundle.
    return {
        getPoint(t) { return dir(angle * t).multiplyScalar(R * (1 + alt(t))); },
        getTangent(t) {
            const a = angle * t;
            const dDir = new G.Vector3(w.x * Math.cos(a) - uS.x * Math.sin(a),
                                       w.y * Math.cos(a) - uS.y * Math.sin(a),
                                       w.z * Math.cos(a) - uS.z * Math.sin(a));
            const v = dir(a).multiplyScalar(dAlt(t))
                            .add(dDir.multiplyScalar(angle * (1 + alt(t))));
            //  Zero only where there is no ground track AND the arc is at its
            //  apex -- a "flight" to the country already connected, at t = 0.5.
            //  buildTrail() normalises this, so it must never be zero.
            return v.lengthSq() < 1e-12 ? w.clone() : v.normalize();
        },
    };
}

// ════════════════════════════════════════════════════════════════════
//  SMOKE TRAIL  --  what a rocket actually leaves behind it.
//
//  This was one THREE.Line: a single pixel wide, fire-orange, the full length
//  of the arc, at full brightness from launch to landing. It read as a drawn
//  line, because that is what it was. Watch a launch from the ground and what
//  you see behind the vehicle is a broad yellowish-grey column that widens and
//  goes ashen as it falls behind, and thins away to nothing a long way back.
//
//  So: a plume of soft puffs laid along the same curve the rocket flies -- the
//  tip of the smoke therefore still meets the tail of the rocket exactly, which
//  is why the old code shared the curve in the first place -- each puff pushed
//  off the centre line so the column has width, and each ageing by how far the
//  rocket has travelled since it was laid: growing, greying, fading out. The
//  sprite is drawn here on a canvas, so this costs no network request and
//  nothing new to vendor.
// ════════════════════════════════════════════════════════════════════
const TRAIL_SEG   = 300;    // curve subdivisions, kept for the landing maths
const SMOKE_PUFFS = 900;    // three per segment: enough to read as a column
const SMOKE_LIFE  = 0.42;   // in curve-t: how far back the plume still shows

let _smokeTex = null;
function smokeSprite() {
    if (_smokeTex) return _smokeTex;
    const G = window.THREE;
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d');
    //  A soft round puff: solid core, nothing whatsoever at the rim, so
    //  overlapping puffs build one continuous column instead of a bead chain.
    const rg = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    rg.addColorStop(0.00, 'rgba(255,255,255,0.95)');
    rg.addColorStop(0.35, 'rgba(255,255,255,0.42)');
    rg.addColorStop(0.70, 'rgba(255,255,255,0.10)');
    rg.addColorStop(1.00, 'rgba(255,255,255,0.00)');
    g.fillStyle = rg;
    g.fillRect(0, 0, 128, 128);
    _smokeTex = new G.CanvasTexture(c);
    return _smokeTex;
}

const SMOKE_VERT = `
attribute float aSize;
attribute float aBirth;
uniform float uHead;
uniform float uLife;
varying float vAge;
void main() {
    vAge = clamp((uHead - aBirth) / uLife, 0.0, 1.0);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    //  Smoke expands as it is left behind; a puff at the nozzle is still tight.
    gl_PointSize = aSize * (1.0 + vAge * 5.5) * (420.0 / max(-mv.z, 1.0));
    gl_Position = projectionMatrix * mv;
}`;

const SMOKE_FRAG = `
uniform sampler2D uTex;
varying float vAge;
void main() {
    float m = texture2D(uTex, gl_PointCoord).a;
    //  Hot and yellow at the nozzle, ash grey a moment later.
    vec3 c = mix(vec3(1.00, 0.87, 0.55), vec3(0.60, 0.58, 0.55),
                 smoothstep(0.0, 0.30, vAge));
    float a = m * (1.0 - vAge) * 0.80;
    if (a < 0.004) discard;
    gl_FragColor = vec4(c, a);
}`;

function buildTrail(curve) {
    const G     = window.THREE;
    const pos   = new Float32Array(SMOKE_PUFFS * 3);
    const size  = new Float32Array(SMOKE_PUFFS);
    const birth = new Float32Array(SMOKE_PUFFS);

    //  Perpendicular jitter, so the plume is a column and not a hairline. Two
    //  axes across the flight path are enough; which two does not matter.
    const axis = new G.Vector3(), sideA = new G.Vector3(), sideB = new G.Vector3();
    for (let i = 0; i < SMOKE_PUFFS; i++) {
        const t  = i / (SMOKE_PUFFS - 1);
        const pt = curve.getPoint(t);
        const tg = curve.getTangent(Math.min(t, 0.9999)).normalize();
        axis.set(0, 0, 1);
        if (Math.abs(tg.dot(axis)) > 0.9) axis.set(0, 1, 0);
        sideA.copy(tg).cross(axis).normalize();
        sideB.copy(tg).cross(sideA).normalize();
        const ang = Math.random() * Math.PI * 2;
        const rad = (0.25 + Math.random() * 0.75) * 0.9;
        const cx  = Math.cos(ang) * rad, cy = Math.sin(ang) * rad;
        pos[i*3]     = pt.x + sideA.x * cx + sideB.x * cy;
        pos[i*3 + 1] = pt.y + sideA.y * cx + sideB.y * cy;
        pos[i*3 + 2] = pt.z + sideA.z * cx + sideB.z * cy;
        size[i]  = 2.0 + Math.random() * 2.2;
        birth[i] = t;
    }

    const geo = new G.BufferGeometry();
    geo.setAttribute('position', new G.BufferAttribute(pos, 3));
    geo.setAttribute('aSize',    new G.BufferAttribute(size, 1));
    geo.setAttribute('aBirth',   new G.BufferAttribute(birth, 1));
    geo.setDrawRange(0, 0);

    //  Normal blending, not additive: smoke is lit, it does not emit. Additive
    //  is what made the old trail look like a laser rather than exhaust.
    const mat = new G.ShaderMaterial({
        uniforms: { uTex:  { value: smokeSprite() },
                    uHead: { value: 0 },
                    uLife: { value: SMOKE_LIFE } },
        vertexShader: SMOKE_VERT, fragmentShader: SMOKE_FRAG,
        transparent: true, depthWrite: false, depthTest: true,
    });
    const line = new G.Points(geo, mat);
    globe.scene().add(line);
    return { geo, mat, line };
}

//  One place advances the plume, so the head of the smoke and the position of
//  the rocket can never disagree about where the rocket is.
function advanceTrail(fc) {
    if (!fc || !fc.trail) return;
    fc.trail.geo.setDrawRange(0, Math.min(Math.floor(fc.t * SMOKE_PUFFS) + 6, SMOKE_PUFFS));
    if (fc.trail.mat.uniforms) fc.trail.mat.uniforms.uHead.value = fc.t;
}

function disposeTrail(trail) {
    if (!trail || !globe) return;
    try { globe.scene().remove(trail.line); trail.geo.dispose(); trail.mat.dispose(); } catch(e) {}
}

// ════════════════════════════════════════════════════════════════════
//  💥 EXPLOSION PARTICLE SYSTEM
// ════════════════════════════════════════════════════════════════════
function createExplosionAt(worldPos) {
    const G      = window.THREE;
    const scene  = globe.scene();
    const FIRE   = [0xff4500, 0xff6b35, 0xffd700, 0xff8c00, 0xffffff, 0xff2244];
    const COUNT  = 75;
    const LIFE   = 2000; // ms

    const particles = [];

    for (let i = 0; i < COUNT; i++) {
        const r   = 0.07 + Math.random() * 0.38;
        const geo = new G.SphereGeometry(r, 5, 5);
        const mat = new G.MeshBasicMaterial({
            color: FIRE[Math.floor(Math.random() * FIRE.length)],
            transparent: true, opacity: 1
        });
        const mesh = new G.Mesh(geo, mat);
        mesh.position.copy(worldPos);

        // Random spherical velocity
        const theta = Math.random() * Math.PI * 2;
        const phi   = Math.acos(2 * Math.random() - 1);
        const speed = 0.5 + Math.random() * 2.2;
        mesh.userData.vel  = new G.Vector3(
            Math.sin(phi) * Math.cos(theta) * speed,
            Math.sin(phi) * Math.sin(theta) * speed,
            Math.cos(phi) * speed
        );
        mesh.userData.born = Date.now();
        scene.add(mesh);
        particles.push({ mesh, mat, geo });
    }

    // Central flash
    const flashGeo = new G.SphereGeometry(4, 10, 10);
    const flashMat = new G.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 1 });
    const flash    = new G.Mesh(flashGeo, flashMat);
    flash.position.copy(worldPos);
    scene.add(flash);
    const flashBorn = Date.now();

    function animate() {
        const now   = Date.now();
        let   alive = false;

        // Flash
        if (flash.parent) {
            const fp = Math.max(0, 1 - (now - flashBorn) / 350);
            flashMat.opacity = fp;
            flash.scale.setScalar(1 + (1 - fp) * 3);
            if (fp <= 0) { scene.remove(flash); flashGeo.dispose(); flashMat.dispose(); }
            else alive = true;
        }

        // Debris
        particles.forEach(p => {
            if (!p.mesh.parent) return;
            const age = now - p.mesh.userData.born;
            if (age >= LIFE) {
                scene.remove(p.mesh); p.geo.dispose(); p.mat.dispose();
                return;
            }
            alive = true;
            const prog = age / LIFE;
            // Drag: velocity decays with time
            p.mesh.position.addScaledVector(p.mesh.userData.vel, 0.016 * (1 - prog * 0.7));
            p.mat.opacity  = Math.max(0, 1 - prog);
            p.mesh.scale.setScalar(1 + prog * 1.8);
        });

        if (alive) requestAnimationFrame(animate);
    }
    animate();
}

// ════════════════════════════════════════════════════════════════════
//  FLIGHT CONTROLLER  (state machine)
// ════════════════════════════════════════════════════════════════════
function createFC(curve, trail, destInfo) {
    return {
        // states: 'flying' → 'landing' | 'exploding' | 'done'
        // Removed 'launching'/'hovering' — rocket now flies continuously
        state:     'flying',
        t:         0,
        startTime: Date.now(),
        curve, trail, destInfo,
        cancelled: false,
        worldPos:  new window.THREE.Vector3()
    };
}

// Position rocket at curve.getPoint(t), nose toward t+Δ
function positionRocket(fc) {
    if (!rocketMesh) return;
    const vCur  = fc.curve.getPoint(fc.t);
    const vNext = fc.curve.getPoint(Math.min(fc.t + 0.018, 0.9999));

    rocketMesh.visible = true;
    rocketMesh.scale.setScalar(1.3); // restore scale in case it was 0'd by landing
    rocketMesh.position.copy(vCur);
    fc.worldPos.copy(vCur);

    // Up = radial outward (away from globe centre)
    rocketMesh.up.copy(vCur).normalize();
    // Nose → next waypoint
    if (vNext.distanceToSquared(vCur) > 1e-6) rocketMesh.lookAt(vNext);
}

// ── Continuous slow flight (0 → ~0.95 over FLIGHT_MS) ──────────
// Rocket flies toward destination. Landing is triggered externally
// by landRocket() when Tor bootstrap completes. No hover state.
const FLIGHT_MS = 90000; // 90 seconds max flight before auto-abort

function runContinuousFlight(fc) {
    fc.startTime = Date.now();

    function frame() {
        if (fc.cancelled || !rocketMesh) return;
        if (fc.state === 'landing' || fc.state === 'done' || fc.state === 'exploding') return;

        const elapsed = Date.now() - fc.startTime;
        // Ease-in-out so rocket accelerates out of home and decelerates near dest
        // Stop at 0.92 max so it never auto-lands (landRocket handles final descent)
        const raw   = Math.min(elapsed / FLIGHT_MS, 0.92);
        // Smooth: slow start, faster middle, slow end
        fc.t = raw < 0.5
            ? 2 * raw * raw
            : 1 - Math.pow(-2 * raw + 2, 2) / 2;
        fc.t = Math.min(fc.t, 0.92);

        advanceTrail(fc);
        positionRocket(fc);
        requestAnimationFrame(frame);
    }
    frame();
}

// ── Landing run (hover_t → 1.0) ──────────────────────────────────
function runLanding(fc, fromT, landMs) {
    const t0 = Date.now();

    function frame() {
        if (fc.cancelled || !rocketMesh || fc.state !== 'landing') return;
        const prog  = Math.min((Date.now() - t0) / landMs, 1);
        const eased = 1 - Math.pow(1 - prog, 2); // ease-out quad
        fc.t = fromT + (1 - fromT) * eased;
        advanceTrail(fc);
        positionRocket(fc);

        if (prog < 1) {
            requestAnimationFrame(frame);
        } else {
            // ✅ Landed — hide rocket, show radar pulse only
            fc.state = 'done';
            rocketMesh.visible = false;
            rocketMesh.scale.setScalar(0); // scale to 0 as belt-and-suspenders
            disposeTrail(fc.trail);
            fc.trail = null;
            FC = null;
            ANCHOR  = fc.destInfo;
            PENDING = null;
            clearPulse();
            showAnchor();
        }
    }
    frame();
}

// ════════════════════════════════════════════════════════════════════
//  PUBLIC API — called from renderer.js
//
//  THE FLIGHT RULES, gathered here because they are the whole point of the
//  file and were previously spread across four functions and a monkey-patch:
//
//  * A flight departs from the ANCHOR -- where the app is now. Never from a
//    hard-coded 0,0, which is open water off West Africa and is what the
//    rocket used to climb out of whenever home was unknown.
//  * No anchor means no origin, so no rocket is drawn at all. That is the
//    kill-switch-on, nothing-connected case: the app was told not to let
//    anything learn where this machine is, so it does not know either. The
//    connect still runs, and on success the ring simply appears in the country
//    that was reached.
//  * ANCHOR moves when a flight RESOLVES, never when one starts. So a connect
//    that fails still knows where it came from, and the ring goes back there
//    rather than to wherever the attempt was aimed.
//  * A switch always flies from the country the app was on to the country it
//    is going to, kill switch or not: both ends are public exit countries and
//    neither of them says anything about the user.
// ════════════════════════════════════════════════════════════════════

// 🚀 Start the flight  (connect button, or a country switch)
//  Synchronous up to and including recording the attempt, because renderer.js
//  can resolve one in the SAME tick it starts it: where the verified exit
//  country differs from the one clicked it calls flyToCountry(exit) and then
//  landRocket() back to back. An attempt not yet recorded is an attempt nothing
//  can land, and the rocket would hang over the globe until the 90-second abort.
window.flyToCountry = function(countryCode) {
    if (!globe) return;
    const code = (countryCode || '').toLowerCase();

    // Cancel any in-progress flight
    if (FC) { FC.cancelled = true; disposeTrail(FC.trail); FC = null; }
    if (rocketMesh) rocketMesh.visible = false;
    clearPulse();
    globe.arcsData([]);

    const p = PENDING = { code, dest: null, outcome: null };
    setOverlay(`Routing to ${countryLabel(code)}… 🛰️`, '#f1c40f');

    const start = () => {
        //  Overtaken by a disconnect or a newer switch while GEO was loading.
        if (PENDING !== p) return;
        p.dest = destFor(code);
        //  Already resolved, before the coordinates got here: nothing flies,
        //  the ring simply appears wherever the app now is.
        if (p.outcome === 'land') return settleWithoutFlight(p.dest);
        if (p.outcome === 'fail') { PENDING = null; showAnchor(); return; }

        globe.pointOfView({ altitude: 3.8 }, 900);
        //  Either the destination is a country main.js cannot place, or there
        //  is nowhere honest to launch from -- the kill switch is on and
        //  nothing is connected, so the app was told not to let anything learn
        //  where this machine is and does not know either. The connect keeps
        //  running; when it resolves the ring appears in the country reached.
        const from = p.dest.placed ? originLoc() : null;
        if (!from) return;

        setTimeout(() => {
            //  Dropped if a disconnect or a second switch overtook this one.
            if (PENDING !== p) return;
            const curve = buildCurve(from.lat, from.lng, p.dest.lat, p.dest.lng);
            const trail = buildTrail(curve);
            FC = createFC(curve, trail, p.dest);
            runContinuousFlight(FC);

            // Camera zooms out to see the full flight path
            setTimeout(() => {
                if (FC && FC.state === 'flying') globe.pointOfView({ altitude: 2.8 }, 5000);
            }, 1200);
        }, 960);
    };
    if (GEO) start(); else loadGeo().then(start);
};

// ✅ Reached the country  (Tor bootstrap = 100%)
//
//  `countryCode` is the VERIFIED exit country and it is used only as a fallback,
//  for the case where nothing is pending any more. One click can run several
//  attempts -- the country-unavailable dialog's "keep trying until it connects"
//  loop -- and the first failed attempt already blasted its rocket, which clears
//  PENDING. With no attempt on record there is nothing to land, so the app ended
//  up reporting Protected while the ring still pulsed over home. Measured
//  2026-08-31: connected out through the United States, caption and ring both
//  still on "Standing by in Motijheel, Bangladesh".
window.landRocket = function(countryCode) {
    if (FC && (FC.state === 'done' || FC.state === 'landing' || FC.state === 'exploding')) return;

    if (!FC) {
        //  No rocket in the air. Either none was ever launched -- no honest
        //  origin to launch from -- or the connect resolved inside the 960 ms a
        //  launch waits out. Nothing to land: the app simply is in that country
        //  now, and that is where the ring goes.
        let p = PENDING;
        //  Not even an attempt on record: an earlier one in this same click took
        //  it. Re-record the country actually reached and settle there. Skipped
        //  when the globe is already showing that country, so a second land call
        //  stays the no-op it is everywhere else.
        if (!p && countryCode) {
            const code = String(countryCode).toLowerCase();
            if (ANCHOR && ANCHOR.kind === 'country' && ANCHOR.code === code) return;
            window.flyToCountry(code);
            p = PENDING;
        }
        if (!p) return;
        //  Coordinates have not arrived yet. Recorded, so start() settles it.
        if (!p.dest) { p.outcome = 'land'; return; }
        settleWithoutFlight(p.dest);
        return;
    }
    const fromT = FC.t; // wherever rocket currently is on the curve
    FC.state    = 'landing';
    setOverlay(`Establishing secure tunnel… 🔐`, '#f1c40f');
    // Zoom camera to destination for landing
    globe.pointOfView({ lat: FC.destInfo.lat, lng: FC.destInfo.lng, altitude: 1.6 }, 2000);
    // Land over 2 seconds from wherever the rocket currently is
    runLanding(FC, fromT, 2000);
};

// 💥 Could not reach it  (Tor bootstrap failed) -- or the user cancelled
//
//  `overlay` exists because the blast now has two causes and they are not the
//  same statement. A failed bootstrap really is "Server Unreachable". A cancel
//  is the user's own decision, made in the country-unavailable dialog, and the
//  relay may have been perfectly reachable -- so renderer.js passes the wording
//  that matches what happened. The animation is identical either way: the
//  rocket blasts where it is, in mid-air, still flying.
window.explodeRocket = function ({
    overlay = 'Connection Failed 💥  Server Unreachable',
    color   = '#e74c3c',
} = {}) {
    if (!FC || FC.state === 'exploding' || FC.state === 'done') {
        //  Nothing in the air to blast. Say what happened, then put the ring
        //  back wherever the app still is -- which, for a first connect with
        //  the kill switch on, is nowhere, and honestly stays nowhere.
        setOverlay(overlay, color);
        const p = PENDING;
        if (p && !p.dest) { p.outcome = 'fail'; return; }
        PENDING = null;
        setTimeout(() => { if (!PENDING) showAnchor(); }, 1800);
        return;
    }
    PENDING = null;
    const blastPos = FC.worldPos.clone();
    FC.cancelled   = true;
    FC.state       = 'exploding';
    rocketMesh.visible = false;
    disposeTrail(FC.trail);
    FC.trail = null;
    FC = null;

    createExplosionAt(blastPos);
    setOverlay(overlay, color);

    //  The launch never moved ANCHOR, so it is still the country the app was
    //  on, or home, or null. Camera returns to it and the ring comes back.
    globe.pointOfView({ altitude: 3.8 }, 800);
    setTimeout(() => {
        const back = ANCHOR;
        if (back) {
            if (back.placed)
                globe.pointOfView({ lat: back.lat, lng: back.lng, altitude: 2.5 }, 2200);
            setOverlay(`Returning to ${back.name || HOME_LOC.name}… 📡`, color);
        }
        setTimeout(() => showAnchor(), 2400);
    }, 2200);
};

// 🏠 Back to home  (normal disconnect)
window.backToHome = function() {
    if (!globe) return;
    if (FC) { FC.cancelled = true; disposeTrail(FC.trail); FC = null; }
    PENDING = null;
    if (rocketMesh) { rocketMesh.visible = false; rocketMesh.position.set(0, 0, 0); }
    clearPulse();
    globe.arcsData([]);
    setOverlay(`Connection Dropped. Returning… 📡`, '#e74c3c');
    globe.pointOfView({ altitude: 3.8 }, 900);

    const from = (ANCHOR && ANCHOR.kind === 'country' && ANCHOR.placed) ? ANCHOR : null;
    const home = homeIsKnown() ? { ...HOME_LOC, kind: 'home', placed: true } : null;

    //  Nothing to fly between: either the app was not on a country, or home is
    //  not known -- and an unknown home is nowhere to fly TO. The old code
    //  built a curve to 0,0 in that case and pulsed it as the user. When the
    //  kill switch is on this is also the moment the ring correctly disappears:
    //  the app is no longer in a country, and it was never told where the user
    //  is, so there is no place left on the globe it can claim.
    if (!from || !home) {
        ANCHOR = home;
        showAnchor();
        focusHome(1500, -1);
        return;
    }

    setTimeout(() => {
        const curve = buildCurve(from.lat, from.lng, home.lat, home.lng);
        const trail = buildTrail(curve);
        const fc    = createFC(curve, trail, home);
        FC = fc;
        const FLIGHT = 3000;
        const t0     = Date.now();

        function frame() {
            if (fc.cancelled || !rocketMesh) return;
            const prog = Math.min((Date.now() - t0) / FLIGHT, 1);
            fc.t = 1 - Math.pow(1 - prog, 2);
            advanceTrail(fc);
            positionRocket(fc);

            if (prog < 1) {
                requestAnimationFrame(frame);
            } else {
                fc.state = 'done';
                rocketMesh.visible = false;
                rocketMesh.scale.setScalar(0);
                disposeTrail(fc.trail);
                fc.trail = null;
                FC = null;
                ANCHOR = home;
                showAnchor();
            }
        }
        frame();
        focusHome(2400, -1);   // guarded: never pans to 0,0 as though it were home
    }, 960);
};

// ════════════════════════════════════════════════════════════════════
//  GLOBE INITIALISATION
// ════════════════════════════════════════════════════════════════════
function buildGlobeUI() {
    const leftSidebar = document.querySelector('.left-panel') || document.querySelector('.sidebar');
    let sidebarW = leftSidebar ? leftSidebar.clientWidth : 350;

    const placeholder = document.getElementById('globe-parent') || document.querySelector('.right-panel');
    if (placeholder) placeholder.style.display = 'none';

    let container = document.getElementById('ultimate-globe-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'ultimate-globe-container';
        document.body.appendChild(container);
    }
    Object.assign(container.style, {
        position: 'fixed', top: '0', left: `${sidebarW}px`,
        width: `calc(100vw - ${sidebarW}px)`, height: '100vh',
        zIndex: '1', backgroundColor: '#090b14', overflow: 'hidden'
    });

    let overlay = document.getElementById('status-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'status-overlay';
        document.body.appendChild(overlay);
    }
    Object.assign(overlay.style, {
        position: 'fixed', bottom: '40px',
        left: `calc(${sidebarW}px + (100vw - ${sidebarW}px) / 2)`,
        transform: 'translateX(-50%)', background: 'rgba(9,11,20,0.92)',
        border: '1px solid #00ffcc', padding: '11px 24px', borderRadius: '30px',
        color: '#00ffcc', fontFamily: 'monospace', fontSize: '13px', fontWeight: 'bold',
        zIndex: '9999', boxShadow: '0 0 15px rgba(0,255,204,0.35)',
        textAlign: 'center', whiteSpace: 'nowrap', transition: 'color 0.3s, border-color 0.3s'
    });

    try {
        globe = Globe()(container)
            .width(window.innerWidth - sidebarW).height(window.innerHeight)
            .backgroundColor('#090b14')
            .showAtmosphere(true).atmosphereColor('#3a82f7').atmosphereAltitude(0.18)
            .globeImageUrl('vendor/earth-blue-marble.jpg')
            .bumpImageUrl('vendor/earth-topology.png');

        globe.pointOfView({ lat: 20, lng: 20, altitude: 3.5 });
        globe.controls().autoRotate      = true;
        globe.controls().autoRotateSpeed = 0.25;

        //  LIGHTING. This block used to add AmbientLight(0.28) and a 1.55
        //  directional under a comment that reasoned about 0.28 as if it were
        //  the whole ambient. It was not. vendor/globe.gl.min.js bakes two
        //  lights into its own objects list -- AmbientLight(0xbbbbbb) at
        //  intensity 1, which weights to 0.733, and a 0.6 directional left at
        //  three.js's default (0,1,0) -- and it exposes no lights() accessor to
        //  replace them, so they added to ours: a real ambient of 1.013, and
        //  2.8x the texture's own colour where the sun is overhead. Past 1.0 is
        //  cut off at white, and earth-blue-marble.jpg reads 0.72 in the Sahara
        //  and 0.70 over Arabia, so the deserts nearest the sub-solar point
        //  (23.5N 53.9E, which is where SUN_DIR points) lost their colour and
        //  their relief together: 13.2% of the lit globe came out as featureless
        //  white in the default view, which is what the report ringed in red.
        //
        //  The specular is not a taste call -- MeshPhongMaterial has no
        //  specular map here, so the highlight is added across the whole lit
        //  disc and peaks exactly where the view mirrors the sun, i.e. on the
        //  reported spot. Even a quarter as bright and four times as tight
        //  (0x060c14 at shininess 140) it put 5.9% of the close view back to
        //  white and flattened Arabia's r-b spread from +0.30 to +0.12. So it
        //  is black, and no cloud layer is added, here or below.
        //
        //  The first fix for that white -- 0.21 ambient with a 1.10 directional,
        //  row 1 of set 3 of .build/probe-globe-light-sweep.js -- was measured
        //  on the day side only, and it broke the other side. A directional
        //  light contributes max(0, dot(normal, sun)), which is 0 everywhere on
        //  the hemisphere facing away from SUN_DIR: the night side is lit by the
        //  ambient and nothing else, so taking the ambient from 1.013 down to
        //  0.21 multiplied that whole hemisphere by 0.21. Measured from the
        //  anti-solar camera, 31.6% of the night disc came out black and land
        //  sat 0.02 above sea -- an unreadable globe, and reported as one.
        //
        //  Both sides are therefore one dial. With no tone mapping the night is
        //  `ambient` and the sub-solar point is `ambient + directional`, so the
        //  ambient may only be raised as far as the directional is lowered.
        //  What ships is row 8 of set 2 of .build/probe-globe-night.js, which
        //  applied 11 candidate lightings to the running app and measured BOTH
        //  hemispheres of each from four cameras: over the sun, close over the
        //  sun, over the anti-solar point, and one frame that holds the Sahara
        //  in daylight and the Amazon in night at the same time. 0.90 ambient
        //  with a 0.42 directional keeps the same ~1.32 total, so the day side
        //  stays where the first fix put it -- 0.33% featureless white in the
        //  default view, 0.05% close, Sahara r-b spread +0.34, Karakoram relief
        //  0.188 against 0.205 -- while the night side returns to 88% of the
        //  pre-fix brightness and 77% of its land-against-sea contrast, with
        //  0.00% of the disc black. A fill light at -SUN_DIR was measured first
        //  and rejected: it cannot reach the day side at all (three fill rows
        //  moved the lit mean by under 0.006), but it falls off from the
        //  anti-solar point, so no intensity short of a visible second sun got
        //  past 58% of the night it was meant to restore.
        setTimeout(() => {
            if (!window.THREE) return;
            const scene = globe.scene();

            //  Run before ours are added, so every light this finds is
            //  globe.gl's by construction -- no colour or intensity guessing.
            //  Idempotent, and repeated twice in case that objects list is
            //  rebuilt after this point; ours are skipped by identity.
            const ours = [];
            const silenceVendorLights = () => {
                try {
                    scene.traverse(o => {
                        if (o.isLight && ours.indexOf(o) === -1) o.intensity = 0;
                    });
                } catch (e) {}
            };
            silenceVendorLights();

            const amb = new window.THREE.AmbientLight(0xffffff, 0.90);
            const dir = new window.THREE.DirectionalLight(0xffffff, 0.42);
            dir.position.set(SUN_DIR.x, SUN_DIR.y, SUN_DIR.z);
            ours.push(amb, dir);
            scene.add(amb);
            scene.add(dir);
            setTimeout(silenceVendorLights, 500);
            setTimeout(silenceVendorLights, 2000);

            //  Surface response. The topology bump map was being applied at
            //  scale 1 on a sphere of radius 100, which is no relief at all;
            //  9 is what makes the dunes and the Himalayas read as terrain.
            //  The specular is black for the reason written above: with no
            //  specular map there is no way to give the oceans a sheen without
            //  also putting a white patch on Arabia.
            try {
                const gm = globe.globeMaterial();
                if (gm) {
                    if ('bumpScale' in gm) gm.bumpScale = 9;
                    if (gm.specular && gm.specular.setHex) gm.specular.setHex(0x000000);
                    if ('shininess' in gm) gm.shininess = 24;
                    gm.needsUpdate = true;
                }
            } catch (e) {}

            rocketMesh = build3DRocket();
            rocketMesh.visible = false;
            scene.add(rocketMesh);
        }, 650);

    } catch (err) { console.error('Globe init failed:', err); }

    //  Before the lookup, never after: killSwitchOn() reads that checkbox, and
    //  renderer.js has not restored it from localStorage at this point in the
    //  DOMContentLoaded queue. See restoreKillSwitchDisplay().
    restoreKillSwitchDisplay();

    initUserLocation();

    window.addEventListener('resize', () => {
        sidebarW = leftSidebar ? leftSidebar.clientWidth : 350;
        container.style.left  = `${sidebarW}px`;
        container.style.width = `calc(100vw - ${sidebarW}px)`;
        overlay.style.left    = `calc(${sidebarW}px + (100vw - ${sidebarW}px) / 2)`;
        if (globe) { globe.width(window.innerWidth - sidebarW); globe.height(window.innerHeight); }
    });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', buildGlobeUI);
} else {
    buildGlobeUI();
}
//  The night-lights layer's shaders, out here so the enhance pass below reads
//  as what it does rather than as two walls of GLSL.
const NIGHT_VERT = `
varying vec3 vNrm;
varying vec2 vUv;
void main() {
    vUv  = uv;
    vNrm = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const NIGHT_FRAG = `
uniform sampler2D uNight;
uniform vec3 uSun;
uniform float uOpacity;
varying vec3 vNrm;
varying vec2 vUv;
void main() {
    //  1 well into the night side, 0 in daylight, soft across the terminator.
    float night = smoothstep(0.12, -0.20, dot(normalize(vNrm), normalize(uSun)));
    vec3 lit = texture2D(uNight, vUv).rgb;
    //  Keyed to the texture's own brightness, so only places that are actually
    //  lit are drawn and unlit land stays as dark as the sea beside it.
    float lum = max(max(lit.r, lit.g), lit.b);
    float a = night * uOpacity * lum;
    if (a < 0.004) discard;
    gl_FragColor = vec4(lit * 1.6, a);
}`;

// ADDITIVE: Globe visuals (stars + night lights, no clouds)
(function enhanceGlobe() {
    function tryEnhance() {
        if (!globe || !window.THREE) { setTimeout(tryEnhance, 300); return; }
        const scene = globe.scene(), R = globe.getGlobeRadius();
        // Stars
        const sg = new THREE.BufferGeometry(), N = 8000, pos = new Float32Array(N * 3);
        for (let i = 0; i < N; i++) {
            const th = Math.random()*Math.PI*2, ph = Math.acos(2*Math.random()-1), r = 800+Math.random()*600;
            pos[i*3]=r*Math.sin(ph)*Math.cos(th); pos[i*3+1]=r*Math.sin(ph)*Math.sin(th); pos[i*3+2]=r*Math.cos(ph);
        }
        sg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        scene.add(new THREE.Points(sg, new THREE.PointsMaterial({ color:0xffffff, size:0.7, sizeAttenuation:true, transparent:true, opacity:0.85 })));
        //  NIGHT LIGHTS, masked to the night side.
        //
        //  This layer used to be a MeshBasicMaterial faded up to opacity 0.38
        //  with additive blending across the WHOLE sphere, so Europe's cities
        //  glowed at local noon. It is now a shader that keeps the lights on
        //  the hemisphere facing away from SUN_DIR -- the same vector the
        //  directional light uses, so the two cannot disagree -- with a soft
        //  terminator. Still no clouds: none are wanted.
        const nm = new THREE.ShaderMaterial({
            uniforms: {
                uNight:   { value: null },
                uSun:     { value: new THREE.Vector3(SUN_DIR.x, SUN_DIR.y, SUN_DIR.z).normalize() },
                uOpacity: { value: 0.0 },
            },
            vertexShader: NIGHT_VERT, fragmentShader: NIGHT_FRAG,
            transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        });
        new THREE.TextureLoader().load('vendor/earth-night.jpg', tex => {
            //  Assigned to .map as well as to the uniform. The shader reads the
            //  uniform; .map is where anything auditing this scene for the
            //  textures it loaded can still find the same object.
            nm.map = tex;
            nm.uniforms.uNight.value = tex;
            nm.needsUpdate = true;
            scene.add(new THREE.Mesh(new THREE.SphereGeometry(R*1.001,64,64), nm));
            const fi = setInterval(() => {
                if (nm.uniforms.uOpacity.value < 0.94) nm.uniforms.uOpacity.value += 0.012;
                else clearInterval(fi);
            }, 60);
        });
        globe.atmosphereColor('#4d8ffb').atmosphereAltitude(0.22);
    }
    setTimeout(tryEnhance, 1800);
})();

//  fixRocketOrigin() used to live here: a monkey-patch that swapped HOME_LOC's
//  coordinates for CURRENT_LOC's for 1100 ms so that a country switch would
//  launch from the connected country instead of from home. It copied lat, lng,
//  name and code -- but not `known` -- so with an unknown home homeIsKnown()
//  stayed false, flyToCountry fell back to { lat: 0, lng: 0 }, and the rocket
//  climbed out of the open Atlantic. flyToCountry now departs from the ANCHOR,
//  which IS the connected country during a switch, so there is nothing left
//  here to patch and no second copy of the origin rule to keep in step.