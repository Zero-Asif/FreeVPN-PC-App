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
let HOME_LOC    = { lat: 0,  lng: 0,  name: 'Detecting…', code: 'unknown' };
let CURRENT_LOC = HOME_LOC;

// Rocket mesh (Three.js Group)
let rocketMesh = null;

// Active flight controller — shared state between all animation phases
let FC = null; // FlightController object (see createFC)

// ════════════════════════════════════════════════════════════════════
//  COUNTRY COORDINATES  (precise capital / geographic centres)
// ════════════════════════════════════════════════════════════════════
const countryCoords = {
    'us': { lat: 38.8951,  lng: -77.0364,  name: 'United States'       },
    'gb': { lat: 51.5074,  lng:  -0.1278,  name: 'United Kingdom'       },
    'ca': { lat: 45.4215,  lng: -75.6919,  name: 'Canada'               },
    'au': { lat: -35.2809, lng: 149.1300,  name: 'Australia'            },
    'de': { lat: 52.5200,  lng:  13.4050,  name: 'Germany'              },
    'fr': { lat: 48.8566,  lng:   2.3522,  name: 'France'               },
    'nl': { lat: 52.3676,  lng:   4.9041,  name: 'Netherlands'          },
    'it': { lat: 41.9028,  lng:  12.4964,  name: 'Italy'                },
    'es': { lat: 40.4168,  lng:  -3.7038,  name: 'Spain'                },
    'ch': { lat: 46.9481,  lng:   7.4474,  name: 'Switzerland'          },
    'se': { lat: 59.3293,  lng:  18.0686,  name: 'Sweden'               },
    'no': { lat: 59.9139,  lng:  10.7522,  name: 'Norway'               },
    'dk': { lat: 55.6761,  lng:  12.5683,  name: 'Denmark'              },
    'fi': { lat: 60.1699,  lng:  24.9384,  name: 'Finland'              },
    'pl': { lat: 52.2297,  lng:  21.0122,  name: 'Poland'               },
    'ro': { lat: 44.4268,  lng:  26.1025,  name: 'Romania'              },
    'at': { lat: 48.2082,  lng:  16.3738,  name: 'Austria'              },
    'be': { lat: 50.8503,  lng:   4.3517,  name: 'Belgium'              },
    'cz': { lat: 50.0755,  lng:  14.4378,  name: 'Czech Republic'       },
    'hu': { lat: 47.4979,  lng:  19.0402,  name: 'Hungary'              },
    'pt': { lat: 38.7169,  lng:  -9.1399,  name: 'Portugal'             },
    'gr': { lat: 37.9838,  lng:  23.7275,  name: 'Greece'               },
    'ie': { lat: 53.3498,  lng:  -6.2603,  name: 'Ireland'              },
    'lu': { lat: 49.6117,  lng:   6.1319,  name: 'Luxembourg'           },
    'ru': { lat: 55.7558,  lng:  37.6173,  name: 'Russia'               },
    'ua': { lat: 50.4501,  lng:  30.5234,  name: 'Ukraine'              },
    'by': { lat: 53.9045,  lng:  27.5615,  name: 'Belarus'              },
    'jp': { lat: 35.6762,  lng: 139.6503,  name: 'Japan'                },
    'kr': { lat: 37.5665,  lng: 126.9780,  name: 'South Korea'          },
    'cn': { lat: 39.9042,  lng: 116.4074,  name: 'China'                },
    'sg': { lat:  1.3521,  lng: 103.8198,  name: 'Singapore'            },
    'in': { lat: 28.6139,  lng:  77.2090,  name: 'India'                },
    'bd': { lat: 23.8103,  lng:  90.4125,  name: 'Bangladesh'           },
    'pk': { lat: 33.7294,  lng:  73.0931,  name: 'Pakistan'             },
    'lk': { lat:  6.9271,  lng:  79.8612,  name: 'Sri Lanka'            },
    'np': { lat: 27.7172,  lng:  85.3240,  name: 'Nepal'                },
    'ae': { lat: 24.4539,  lng:  54.3773,  name: 'United Arab Emirates' },
    'sa': { lat: 24.6877,  lng:  46.7219,  name: 'Saudi Arabia'         },
    'qa': { lat: 25.2854,  lng:  51.5310,  name: 'Qatar'                },
    'kw': { lat: 29.3759,  lng:  47.9774,  name: 'Kuwait'               },
    'om': { lat: 23.5880,  lng:  58.3829,  name: 'Oman'                 },
    'bh': { lat: 26.2235,  lng:  50.5876,  name: 'Bahrain'              },
    'il': { lat: 31.7683,  lng:  35.2137,  name: 'Israel'               },
    'tr': { lat: 39.9334,  lng:  32.8597,  name: 'Turkey'               },
    'ir': { lat: 35.6892,  lng:  51.3890,  name: 'Iran'                 },
    'iq': { lat: 33.3152,  lng:  44.3661,  name: 'Iraq'                 },
    'jo': { lat: 31.9454,  lng:  35.9284,  name: 'Jordan'               },
    'lb': { lat: 33.8886,  lng:  35.4955,  name: 'Lebanon'              },
    'id': { lat: -6.2088,  lng: 106.8456,  name: 'Indonesia'            },
    'my': { lat:  3.1390,  lng: 101.6869,  name: 'Malaysia'             },
    'th': { lat: 13.7563,  lng: 100.5018,  name: 'Thailand'             },
    'vn': { lat: 21.0285,  lng: 105.8542,  name: 'Vietnam'              },
    'ph': { lat: 14.5995,  lng: 120.9842,  name: 'Philippines'          },
    'tw': { lat: 25.0330,  lng: 121.5654,  name: 'Taiwan'               },
    'hk': { lat: 22.3193,  lng: 114.1694,  name: 'Hong Kong'            },
    'mm': { lat: 16.8661,  lng:  96.1951,  name: 'Myanmar'              },
    'kh': { lat: 11.5564,  lng: 104.9282,  name: 'Cambodia'             },
    'za': { lat: -25.7479, lng:  28.2293,  name: 'South Africa'         },
    'eg': { lat: 30.0444,  lng:  31.2357,  name: 'Egypt'                },
    'ng': { lat:  9.0579,  lng:   7.4951,  name: 'Nigeria'              },
    'ke': { lat: -1.2921,  lng:  36.8219,  name: 'Kenya'                },
    'gh': { lat:  5.6037,  lng:  -0.1870,  name: 'Ghana'                },
    'et': { lat:  9.0320,  lng:  38.7469,  name: 'Ethiopia'             },
    'tz': { lat: -6.7924,  lng:  39.2083,  name: 'Tanzania'             },
    'ma': { lat: 33.9716,  lng:  -6.8498,  name: 'Morocco'              },
    'dz': { lat: 36.7372,  lng:   3.0865,  name: 'Algeria'              },
    'tn': { lat: 36.8190,  lng:  10.1658,  name: 'Tunisia'              },
    'br': { lat: -15.7801, lng: -47.9292,  name: 'Brazil'               },
    'ar': { lat: -34.6037, lng: -58.3816,  name: 'Argentina'            },
    'mx': { lat: 19.4326,  lng: -99.1332,  name: 'Mexico'               },
    'co': { lat:  4.7110,  lng: -74.0721,  name: 'Colombia'             },
    'cl': { lat: -33.4489, lng: -70.6693,  name: 'Chile'                },
    'pe': { lat: -12.0464, lng: -77.0428,  name: 'Peru'                 },
    've': { lat: 10.4806,  lng: -66.9036,  name: 'Venezuela'            },
    'ec': { lat: -0.1807,  lng: -78.4678,  name: 'Ecuador'              },
    'bo': { lat: -16.5000, lng: -68.1500,  name: 'Bolivia'              },
    'nz': { lat: -41.2865, lng: 174.7762,  name: 'New Zealand'          },
    'is': { lat: 64.1355,  lng: -21.8954,  name: 'Iceland'              },
    'sk': { lat: 48.1486,  lng:  17.1077,  name: 'Slovakia'             },
    'hr': { lat: 45.8150,  lng:  15.9819,  name: 'Croatia'              },
    'rs': { lat: 44.7866,  lng:  20.4489,  name: 'Serbia'               },
    'bg': { lat: 42.6977,  lng:  23.3219,  name: 'Bulgaria'             },
    'lt': { lat: 54.6872,  lng:  25.2797,  name: 'Lithuania'            },
    'lv': { lat: 56.9460,  lng:  24.1059,  name: 'Latvia'               },
    'ee': { lat: 59.4370,  lng:  24.7536,  name: 'Estonia'              },
    'ge': { lat: 41.6938,  lng:  44.8015,  name: 'Georgia'              },
    'az': { lat: 40.4093,  lng:  49.8671,  name: 'Azerbaijan'           },
    'am': { lat: 40.1872,  lng:  44.5152,  name: 'Armenia'              },
    'kz': { lat: 51.1801,  lng:  71.4460,  name: 'Kazakhstan'           },
    'uz': { lat: 41.2995,  lng:  69.2401,  name: 'Uzbekistan'           },
    'mn': { lat: 47.8864,  lng: 106.9057,  name: 'Mongolia'             },
};

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

// ════════════════════════════════════════════════════════════════════
//  AUTO-DETECT USER LOCATION
// ════════════════════════════════════════════════════════════════════
async function initUserLocation() {
    setOverlay('Detecting location… 🌍', '#00ffcc');
    try {
        const ctl = new AbortController();
        const tid = setTimeout(() => ctl.abort(), 5000);
        const res = await fetch('https://freeipapi.com/api/json', { signal: ctl.signal });
        clearTimeout(tid);
        if (!res.ok) throw new Error();
        const d = await res.json();
        HOME_LOC = {
            lat:  parseFloat(d.latitude),
            lng:  parseFloat(d.longitude),
            name: `${d.cityName || 'Local'}, ${d.countryName || 'Region'}`,
            code: (d.countryCode || 'unknown').toLowerCase()
        };
    } catch {
        HOME_LOC = { lat: 23.8103, lng: 90.4125, name: 'Dhaka, Bangladesh', code: 'bd' };
    }
    CURRENT_LOC = HOME_LOC;
    setOverlay(`Standing by in ${HOME_LOC.name} 🌐`, '#00ffcc');
    if (globe) {
        globe.pointOfView({ lat: HOME_LOC.lat, lng: HOME_LOC.lng, altitude: 2.5 }, 2000);
        setTimeout(() => setPulse(HOME_LOC.lat, HOME_LOC.lng, '#FF416C'), 1000);
    }
}

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
//  📐 PHYSICS-CORRECT BEZIER CURVE
//
//  Altitude formula:
//    angle    = acos(vS · vE / |vS||vE|)        [0 … π rad]
//    arcFrac  = angle / π                        [0 … 1]
//    peakAlt  = 0.50 + arcFrac × 1.30           [0.50 … 1.80]
//    control  = midDir × R × (1 + peakAlt)
//
//  Minimum 50% above surface → rocket NEVER intersects globe.
//  Antipodal guard: if midpoint ≈ 0, build perpendicular control.
// ════════════════════════════════════════════════════════════════════
function buildCurve(startLat, startLng, endLat, endLng) {
    const G  = window.THREE;
    const s  = globe.getCoords(startLat, startLng, 0);
    const e  = globe.getCoords(endLat,   endLng,   0);
    const vS = new G.Vector3(s.x, s.y, s.z);
    const vE = new G.Vector3(e.x, e.y, e.z);
    const R  = vS.length();

    // Angular distance → arc height
    const angle   = vS.angleTo(vE);           // 0 … π
    const arcFrac = angle / Math.PI;           // 0 … 1
    const peakAlt = 0.50 + arcFrac * 1.30;    // 0.50 … 1.80 above surface

    // Midpoint direction (handle near-antipodal: vMid ≈ 0)
    const vMid   = vS.clone().add(vE).multiplyScalar(0.5);
    const midLen = vMid.length();
    let   vCtrl;

    if (midLen < R * 0.01) {
        // Nearly antipodal — pick a perpendicular axis
        let perp = new G.Vector3(1, 0, 0);
        if (Math.abs(vS.dot(perp) / R) > 0.9) perp.set(0, 1, 0);
        vCtrl = vS.clone().cross(perp).normalize()
                  .multiplyScalar(R * (1 + peakAlt));
    } else {
        vCtrl = vMid.clone().normalize().multiplyScalar(R * (1 + peakAlt));
    }

    return new G.QuadraticBezierCurve3(vS, vCtrl, vE);
}

// ════════════════════════════════════════════════════════════════════
//  TRAIL  (same curve → zero gap between trail tip and rocket tail)
//  Fire gradient: dim brownish-orange at launch → bright at tail
// ════════════════════════════════════════════════════════════════════
const TRAIL_SEG = 300;

function buildTrail(curve) {
    const G   = window.THREE;
    const pos = new Float32Array((TRAIL_SEG + 1) * 3);
    const col = new Float32Array((TRAIL_SEG + 1) * 3);

    for (let i = 0; i <= TRAIL_SEG; i++) {
        const pt = curve.getPoint(i / TRAIL_SEG);
        pos[i*3] = pt.x; pos[i*3+1] = pt.y; pos[i*3+2] = pt.z;

        // i=0 (launch point, oldest) → dim
        // i=TRAIL_SEG (rocket tail, newest) → bright orange-white
        const t = i / TRAIL_SEG;
        col[i*3]   = 0.20 + t * 0.80; // R: 0.2 → 1.0
        col[i*3+1] = 0.08 + t * 0.42; // G: 0.08 → 0.5  (fire orange)
        col[i*3+2] = 0.00 + t * 0.10; // B: very low (no blue = fire)
    }

    const geo  = new G.BufferGeometry();
    geo.setAttribute('position', new G.BufferAttribute(pos, 3));
    geo.setAttribute('color',    new G.BufferAttribute(col, 3));
    geo.setDrawRange(0, 0);

    const mat  = new G.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.92 });
    const line = new G.Line(geo, mat);
    globe.scene().add(line);
    return { geo, mat, line };
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

        fc.trail.geo.setDrawRange(0, Math.floor(fc.t * TRAIL_SEG) + 2);
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
        if (fc.trail) fc.trail.geo.setDrawRange(0, Math.min(Math.floor(fc.t * TRAIL_SEG) + 2, TRAIL_SEG + 1));
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
            CURRENT_LOC = fc.destInfo;
            clearPulse();
            setPulse(fc.destInfo.lat, fc.destInfo.lng, '#00ffcc');
            setOverlay(`Secured & Routed via ${fc.destInfo.name} 🛡️`, '#00ffcc');
        }
    }
    frame();
}

// ════════════════════════════════════════════════════════════════════
//  PUBLIC API — called from renderer.js
// ════════════════════════════════════════════════════════════════════

// 🚀 Start hover-flight  (connect button clicked)
window.flyToCountry = function(countryCode) {
    if (!globe || !rocketMesh) return;

    // Cancel any in-progress flight
    if (FC) { FC.cancelled = true; disposeTrail(FC.trail); rocketMesh.visible = false; FC = null; }
    // Force-hide rocket in case it's stuck from a previous session
    if (rocketMesh) rocketMesh.visible = false;
    clearPulse();
    globe.arcsData([]);

    const dest = countryCoords[countryCode.toLowerCase()]
              || { lat: 0, lng: 0, name: countryCode.toUpperCase() };

    // ── Optimistic CURRENT_LOC update ────────────────────────────
    // Set destination as current BEFORE the flight starts.
    // If the user disconnects mid-flight, backToHome() will fly FROM
    // the destination (not from home), producing the correct animation.
    CURRENT_LOC = dest;

    setOverlay(`Routing to ${dest.name}… 🛰️`, '#f1c40f');
    globe.pointOfView({ altitude: 3.8 }, 900);

    // Use a saved start location (before CURRENT_LOC was updated)
    const fromLoc = HOME_LOC.name !== 'Detecting…' ? HOME_LOC : { lat: 0, lng: 0, name: 'Origin' };

    setTimeout(() => {
        // Build curve from actual origin (captured before optimistic update)
        // We restore HOME_LOC as start since CURRENT_LOC is now = dest
        const startLat = fromLoc.lat, startLng = fromLoc.lng;
        const curve = buildCurve(startLat, startLng, dest.lat, dest.lng);
        const trail = buildTrail(curve);
        FC = createFC(curve, trail, dest);
        runContinuousFlight(FC);

        // Camera zooms out to see the full flight path
        setTimeout(() => {
            if (FC && FC.state === 'flying') globe.pointOfView({ altitude: 2.8 }, 5000);
        }, 1200);
    }, 960);
};

// ✅ Land rocket  (called when Tor bootstrap = 100%)
window.landRocket = function() {
    if (!FC || FC.state === 'done' || FC.state === 'landing' || FC.state === 'exploding') return;
    const fromT = FC.t; // wherever rocket currently is on the curve
    FC.state    = 'landing';
    setOverlay(`Establishing secure tunnel… 🔐`, '#f1c40f');
    // Zoom camera to destination for landing
    globe.pointOfView({ lat: FC.destInfo.lat, lng: FC.destInfo.lng, altitude: 1.6 }, 2000);
    // Land over 2 seconds from wherever the rocket currently is
    runLanding(FC, fromT, 2000);
};

// 💥 Explode rocket  (called when Tor bootstrap fails)
window.explodeRocket = function() {
    if (!FC || FC.state === 'exploding' || FC.state === 'done') return;
    const blastPos = FC.worldPos.clone();
    FC.cancelled   = true;
    FC.state       = 'exploding';
    rocketMesh.visible = false;
    disposeTrail(FC.trail);
    FC.trail = null;
    FC = null;

    createExplosionAt(blastPos);
    setOverlay('Connection Failed 💥  Server Unreachable', '#e74c3c');

    // Camera zooms out → pans home → home pulse
    globe.pointOfView({ altitude: 3.8 }, 800);
    setTimeout(() => {
        globe.pointOfView({ lat: HOME_LOC.lat, lng: HOME_LOC.lng, altitude: 2.5 }, 2200);
        setOverlay(`Returning to ${HOME_LOC.name}… 📡`, '#e74c3c');
        setTimeout(() => {
            CURRENT_LOC = HOME_LOC;
            setPulse(HOME_LOC.lat, HOME_LOC.lng, '#FF416C');
            setOverlay(`Standing by in ${HOME_LOC.name} 🌐`, '#00ffcc');
        }, 2400);
    }, 2200);
};

// 🏠 Back to home  (normal disconnect)
window.backToHome = function() {
    if (!globe || !rocketMesh) return;
    // Cancel any in-progress flight and force-hide rocket
    if (FC) { FC.cancelled = true; disposeTrail(FC.trail); FC = null; }
    rocketMesh.visible = false;  // always hide, regardless of FC state
    rocketMesh.position.set(0, 0, 0);
    clearPulse();
    globe.arcsData([]);
    setOverlay(`Connection Dropped. Returning… 📡`, '#e74c3c');
    globe.pointOfView({ altitude: 3.8 }, 900);

    // fromLoc = destination (where rocket just was / where VPN was connected)
    // CURRENT_LOC was set optimistically in flyToCountry, so this is correct
    // even if landing animation was never completed.
    const fromLoc = { ...CURRENT_LOC };

    // If fromLoc == HOME_LOC (connection failed before any flight), skip animation
    if (Math.abs(fromLoc.lat - HOME_LOC.lat) < 0.1 && Math.abs(fromLoc.lng - HOME_LOC.lng) < 0.1) {
        CURRENT_LOC = HOME_LOC;
        setPulse(HOME_LOC.lat, HOME_LOC.lng, '#FF416C');
        setOverlay(`Standing by in ${HOME_LOC.name} 🌐`, '#00ffcc');
        globe.pointOfView({ lat: HOME_LOC.lat, lng: HOME_LOC.lng, altitude: 2.5 }, 1500);
        return;
    }

    setTimeout(() => {
        const curve   = buildCurve(fromLoc.lat, fromLoc.lng, HOME_LOC.lat, HOME_LOC.lng);
        const trail   = buildTrail(curve);
        const fc      = createFC(curve, trail, HOME_LOC);
        FC = fc;
        const FLIGHT  = 3000;
        const t0      = Date.now();

        function frame() {
            if (fc.cancelled || !rocketMesh) return;
            const prog  = Math.min((Date.now() - t0) / FLIGHT, 1);
            const eased = 1 - Math.pow(1 - prog, 2);
            fc.t = eased;
            fc.trail.geo.setDrawRange(0, Math.min(Math.floor(fc.t * TRAIL_SEG) + 2, TRAIL_SEG + 1));
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
                CURRENT_LOC = HOME_LOC;
                setPulse(HOME_LOC.lat, HOME_LOC.lng, '#FF416C');
                setOverlay(`Standing by in ${HOME_LOC.name} 🌐`, '#00ffcc');
            }
        }
        frame();
        globe.pointOfView({ lat: HOME_LOC.lat, lng: HOME_LOC.lng, altitude: 2.5 }, 2400);
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
            .globeImageUrl('https://unpkg.com/three-globe/example/img/earth-blue-marble.jpg')
            .bumpImageUrl('https://unpkg.com/three-globe/example/img/earth-topology.png');

        globe.pointOfView({ lat: 20, lng: 20, altitude: 3.5 });
        globe.controls().autoRotate      = true;
        globe.controls().autoRotateSpeed = 0.25;

        // Add lights for proper rocket shading
        setTimeout(() => {
            if (!window.THREE) return;
            const scene = globe.scene();
            scene.add(new window.THREE.AmbientLight(0xffffff, 0.55));
            const dir = new window.THREE.DirectionalLight(0xffffff, 1.1);
            dir.position.set(200, 200, 300);
            scene.add(dir);
            rocketMesh = build3DRocket();
            rocketMesh.visible = false;
            scene.add(rocketMesh);
        }, 650);

    } catch (err) { console.error('Globe init failed:', err); }

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