// ==========================================
// 🌍 FREEPROXY 3D GLOBE CONTROLLER (THE ULTIMATE FLAWLESS SYNC & RECOVERY)
// ==========================================
console.log("✅ Globe Engine Loading...");

let globe; 
let HOME_LOC = { lat: 0, lng: 0, name: 'Detecting...', code: 'unknown' }; 
let CURRENT_LOC = HOME_LOC; 
let rocketMesh; 

const countryCoords = {
    'us': { lat: 37.0902, lng: -95.7129, name: 'United States' }, 'gb': { lat: 55.3781, lng: -3.4360, name: 'United Kingdom' },
    'ca': { lat: 56.1304, lng: -106.3468, name: 'Canada' }, 'au': { lat: -25.2744, lng: 133.7751, name: 'Australia' },
    'de': { lat: 51.1657, lng: 10.4515, name: 'Germany' }, 'fr': { lat: 46.2276, lng: 2.2137, name: 'France' },
    'nl': { lat: 52.1326, lng: 5.2913, name: 'Netherlands' }, 'it': { lat: 41.8719, lng: 12.5674, name: 'Italy' },
    'es': { lat: 40.4637, lng: -3.7492, name: 'Spain' }, 'ch': { lat: 46.8182, lng: 8.2275, name: 'Switzerland' },
    'se': { lat: 60.1282, lng: 18.6435, name: 'Sweden' }, 'no': { lat: 60.4720, lng: 8.4689, name: 'Norway' },
    'dk': { lat: 56.2639, lng: 9.5018, name: 'Denmark' }, 'fi': { lat: 61.9241, lng: 25.7482, name: 'Finland' },
    'pl': { lat: 51.9194, lng: 19.1451, name: 'Poland' }, 'ro': { lat: 45.9432, lng: 24.9668, name: 'Romania' },
    'ru': { lat: 61.5240, lng: 105.3188, name: 'Russia' }, 'ua': { lat: 48.3794, lng: 31.1656, name: 'Ukraine' },
    'jp': { lat: 36.2048, lng: 138.2529, name: 'Japan' }, 'kr': { lat: 35.9078, lng: 127.7669, name: 'South Korea' },
    'sg': { lat: 1.3521, lng: 103.8198, name: 'Singapore' }, 'in': { lat: 20.5937, lng: 78.9629, name: 'India' },
    'bd': { lat: 23.6850, lng: 90.3563, name: 'Bangladesh' }, 'pk': { lat: 30.3753, lng: 69.3451, name: 'Pakistan' },
    'ae': { lat: 23.4241, lng: 53.8478, name: 'United Arab Emirates' }, 'sa': { lat: 23.8859, lng: 45.0792, name: 'Saudi Arabia' },
    'za': { lat: -30.5595, lng: 22.9375, name: 'South Africa' }, 'eg': { lat: 26.8206, lng: 30.8025, name: 'Egypt' },
    'ng': { lat: 9.0820, lng: 8.6753, name: 'Nigeria' }, 'br': { lat: -14.2350, lng: -51.9253, name: 'Brazil' },
    'ar': { lat: -38.4161, lng: -63.6167, name: 'Argentina' }, 'mx': { lat: 23.6345, lng: -102.5528, name: 'Mexico' },
    'nz': { lat: -40.9006, lng: 174.8860, name: 'New Zealand' }, 'cn': { lat: 35.8617, lng: 104.1954, name: 'China' },
    'id': { lat: -0.7893, lng: 113.9213, name: 'Indonesia' }, 'my': { lat: 4.2105, lng: 101.9758, name: 'Malaysia' },
    'th': { lat: 15.8700, lng: 100.9925, name: 'Thailand' }, 'vn': { lat: 14.0583, lng: 108.2772, name: 'Vietnam' },
    'ph': { lat: 12.8797, lng: 121.7740, name: 'Philippines' }, 'tr': { lat: 38.9637, lng: 35.2433, name: 'Turkey' },
    'ir': { lat: 32.4279, lng: 53.6880, name: 'Iran' }, 'iq': { lat: 33.2232, lng: 43.6793, name: 'Iraq' },
    'il': { lat: 31.0461, lng: 34.8516, name: 'Israel' }, 'qa': { lat: 25.3548, lng: 51.1839, name: 'Qatar' },
    'kw': { lat: 29.3117, lng: 47.4818, name: 'Kuwait' }, 'om': { lat: 21.4735, lng: 55.9754, name: 'Oman' },
    'ma': { lat: 31.7917, lng: -7.0926, name: 'Morocco' }, 'dz': { lat: 28.0339, lng: 1.6596, name: 'Algeria' },
    'ke': { lat: -0.0236, lng: 37.9062, name: 'Kenya' }, 'et': { lat: 9.1450, lng: 40.4897, name: 'Ethiopia' },
    'co': { lat: 4.5709, lng: -74.2973, name: 'Colombia' }, 'pe': { lat: -9.1900, lng: -75.0152, name: 'Peru' },
    've': { lat: 6.4238, lng: -66.5897, name: 'Venezuela' }, 'cl': { lat: -35.6751, lng: -71.5430, name: 'Chile' },
    'ec': { lat: -1.8312, lng: -78.1834, name: 'Ecuador' }, 'bo': { lat: -16.2902, lng: -63.5887, name: 'Bolivia' }
};

// 🔴 THE BULLETPROOF Z-AXIS ROCKET
function build3DRocket() {
    const wrapper = new window.THREE.Group(); 
    
    // 1. Flame (ধোঁয়া)
    const flameGeo = new window.THREE.ConeGeometry(0.5, 1.5, 16);
    flameGeo.rotateX(-Math.PI / 2); 
    flameGeo.translate(0, 0, 0.75); 
    const flameMat = new window.THREE.MeshBasicMaterial({ color: 0xdddddd, transparent: true, opacity: 0.8 });
    wrapper.add(new window.THREE.Mesh(flameGeo, flameMat));

    // 2. Body
    const bodyGeo = new window.THREE.CylinderGeometry(0.8, 0.8, 4, 16);
    bodyGeo.rotateX(Math.PI / 2); 
    bodyGeo.translate(0, 0, 3.5); 
    const bodyMat = new window.THREE.MeshLambertMaterial({ color: 0xffffff });
    wrapper.add(new window.THREE.Mesh(bodyGeo, bodyMat));

    // 3. Nose (লাল নাক)
    const noseGeo = new window.THREE.ConeGeometry(0.8, 2, 16);
    noseGeo.rotateX(Math.PI / 2); 
    noseGeo.translate(0, 0, 6.5); 
    const noseMat = new window.THREE.MeshLambertMaterial({ color: 0xff416c });
    wrapper.add(new window.THREE.Mesh(noseGeo, noseMat));

    // 4. Fins (পাখা)
    const finGeo = new window.THREE.BoxGeometry(0.2, 2.5, 1.5);
    const finMat = new window.THREE.MeshLambertMaterial({ color: 0xff416c });
    for(let i=0; i<4; i++) {
        const fin = new window.THREE.Mesh(finGeo, finMat);
        fin.position.z = 2.5; 
        fin.rotation.z = (Math.PI / 2) * i;
        fin.translateX(0.8);
        wrapper.add(fin);
    }

    wrapper.scale.set(1.7, 1.7, 1.7); 
    return wrapper;
}

function setPulse(lat, lng, color) {
    if(!globe) return;
    globe.ringsData([{ lat: lat, lng: lng }])
        .ringColor(() => color).ringMaxRadius(6).ringPropagationSpeed(3).ringRepeatPeriod(1000);
}

async function initUserLocation() {
    const overlay = document.getElementById('status-overlay');
    if(overlay) {
        overlay.innerText = `Detecting Present Location... 🌍`;
        overlay.style.color = '#00ffcc'; overlay.style.borderColor = 'rgba(0, 255, 204, 0.5)';
    }

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 4000);
        const response = await fetch('https://freeipapi.com/api/json', { signal: controller.signal });
        clearTimeout(timeoutId);
        
        if (response.ok) {
            const data = await response.json();
            HOME_LOC = {
                lat: parseFloat(data.latitude), lng: parseFloat(data.longitude),
                name: `${data.cityName || 'Local'}, ${data.countryName || 'Region'}`,
                code: (data.countryCode || 'unknown').toLowerCase()
            };
        } else { throw new Error("API Failed"); }
    } catch (e) { 
        HOME_LOC = { lat: 23.8103, lng: 90.4125, name: 'Dhaka, Bangladesh', code: 'bd' };
    }

    CURRENT_LOC = HOME_LOC; 

    if(overlay) {
        overlay.innerText = `Standing by in ${HOME_LOC.name} 🌐`;
        overlay.style.color = '#00ffcc'; overlay.style.borderColor = 'rgba(0, 255, 204, 0.5)';
    }

    if(globe) {
        globe.pointOfView({ lat: HOME_LOC.lat, lng: HOME_LOC.lng, altitude: 2.5 }, 2000);
        setTimeout(() => setPulse(HOME_LOC.lat, HOME_LOC.lng, '#FF416C'), 1000);
    }
}

// ============================================================
// 🚀 THE PERFECT FIX: Custom Three.js trail along the SAME
//    bezier curve as the rocket — zero gap, guaranteed.
//
//    পুরোনো globe.arcsData() trail এবং রকেটের bezier curve
//    দুটো আলাদা math ব্যবহার করত, তাই gap হত।
//    এখন trail-ও একই QuadraticBezierCurve3 থেকে তৈরি,
//    setDrawRange দিয়ে প্রতি frame-এ রকেটের সাথে সাথে grow করে।
// ============================================================
function animate3DRocket(startLat, startLng, endLat, endLng, duration) {
    if(!rocketMesh) return;
    rocketMesh.visible = true; 
    let startTime = Date.now();
    
    let startCoords = globe.getCoords(startLat, startLng, 0);
    let endCoords = globe.getCoords(endLat, endLng, 0);
    
    let vStart = new window.THREE.Vector3(startCoords.x, startCoords.y, startCoords.z);
    let vEnd = new window.THREE.Vector3(endCoords.x, endCoords.y, endCoords.z);
    
    let globeRadius = vStart.length();
    let maxAlt = 0.35; 
    
    let vMid = vStart.clone().add(vEnd).multiplyScalar(0.5);
    let vControl = vMid.clone().normalize().multiplyScalar(globeRadius * (1 + maxAlt * 2));
    
    // রকেট এবং trail একই curve ব্যবহার করবে
    let curve = new window.THREE.QuadraticBezierCurve3(vStart, vControl, vEnd);

    // ── Trail Setup ──────────────────────────────────────────
    // পুরো path এর সব points আগেই compute করে রাখা হল।
    // Vertex colors দিয়ে tail (উজ্জ্বল) থেকে পুরানো অংশ (ম্লান) gradient তৈরি।
    const TRAIL_SEGMENTS = 300;
    const positions = new Float32Array((TRAIL_SEGMENTS + 1) * 3);
    const colors    = new Float32Array((TRAIL_SEGMENTS + 1) * 3);

    for (let i = 0; i <= TRAIL_SEGMENTS; i++) {
        const pt = curve.getPoint(i / TRAIL_SEGMENTS);
        positions[i * 3]     = pt.x;
        positions[i * 3 + 1] = pt.y;
        positions[i * 3 + 2] = pt.z;

        // পুরানো অংশ → ম্লান ধূসর; নতুন অংশ (tail কাছে) → উজ্জ্বল সাদা
        // i / TRAIL_SEGMENTS = 0..1 → frac বাড়লে সামনের দিক
        // Trail বাড়ার সাথে সাথে পুরানো অংশ ম্লান দেখাবে।
        // রকেট সামনে যাচ্ছে মানে index শেষের দিক উজ্জ্বল থাকবে।
        const brightness = 0.25 + (i / TRAIL_SEGMENTS) * 0.75; // 0.25 → 1.0
        colors[i * 3]     = brightness;
        colors[i * 3 + 1] = brightness;
        colors[i * 3 + 2] = brightness;
    }

    const trailGeo = new window.THREE.BufferGeometry();
    trailGeo.setAttribute('position', new window.THREE.BufferAttribute(positions, 3));
    trailGeo.setAttribute('color',    new window.THREE.BufferAttribute(colors, 3));
    trailGeo.setDrawRange(0, 0); // শুরুতে কিছু দেখাবে না

    const trailMat = new window.THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.85
    });
    const trailLine = new window.THREE.Line(trailGeo, trailMat);
    globe.scene().add(trailLine);
    // ─────────────────────────────────────────────────────────

    function update() {
        let t = (Date.now() - startTime) / duration;
        if (t > 1) t = 1;
        
        let vCur  = curve.getPoint(t);
        let vNext = curve.getPoint(Math.min(t + 0.02, 1.0));
        
        rocketMesh.position.copy(vCur); 
        rocketMesh.up.copy(vCur).normalize(); 
        
        if (vNext.distanceToSquared(vCur) > 0.0001) {
            rocketMesh.lookAt(vNext);
        }

        // Trail এর endpoint সবসময় রকেটের position = curve.getPoint(t)
        // কোনো gap নেই কারণ দুটো একই curve ব্যবহার করছে।
        const visibleCount = Math.floor(t * TRAIL_SEGMENTS) + 2;
        trailGeo.setDrawRange(0, Math.min(visibleCount, TRAIL_SEGMENTS + 1));

        if (t < 1) {
            requestAnimationFrame(update);
        } else {
            rocketMesh.visible = false;
            // Trail সাথে সাথে মুছে দেওয়া হল
            globe.scene().remove(trailLine);
            trailGeo.dispose();
            trailMat.dispose();
        }
    }
    update();
}

function buildGlobeUI() {
    let leftSidebar = document.querySelector('.left-panel') || document.querySelector('.sidebar');
    let sidebarWidth = leftSidebar ? leftSidebar.clientWidth : 350;

    let brokenPanel = document.getElementById('globe-parent') || document.querySelector('.right-panel');
    if(brokenPanel) brokenPanel.style.display = 'none';

    let container = document.getElementById('ultimate-globe-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'ultimate-globe-container';
        document.body.appendChild(container);
    }

    Object.assign(container.style, { 
        position: 'fixed', top: '0', left: `${sidebarWidth}px`, 
        width: `calc(100vw - ${sidebarWidth}px)`, height: '100vh', 
        zIndex: '1', backgroundColor: '#090b14', overflow: 'hidden'
    });

    let overlay = document.getElementById('status-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'status-overlay';
        document.body.appendChild(overlay); 
    }
    Object.assign(overlay.style, {
        position: 'fixed', bottom: '40px', left: `calc(${sidebarWidth}px + (100vw - ${sidebarWidth}px) / 2)`, 
        transform: 'translateX(-50%)', background: 'rgba(9, 11, 20, 0.9)', 
        border: '1px solid #00ffcc', padding: '12px 25px', borderRadius: '30px', 
        color: '#00ffcc', fontFamily: 'monospace', fontSize: '14px', fontWeight: 'bold', 
        zIndex: '9999', boxShadow: '0 0 15px rgba(0,255,204,0.4)', textAlign: 'center', whiteSpace: 'nowrap'
    });

    let gWidth = window.innerWidth - sidebarWidth;
    let gHeight = window.innerHeight;

    try {
        globe = Globe()(container)
            .width(gWidth).height(gHeight)
            .backgroundColor('#090b14')
            .showAtmosphere(true).atmosphereColor('#3a82f7').atmosphereAltitude(0.15)
            .globeImageUrl('https://unpkg.com/three-globe/example/img/earth-blue-marble.jpg') 
            .bumpImageUrl('https://unpkg.com/three-globe/example/img/earth-topology.png');

        globe.pointOfView({ lat: 20, lng: 0, altitude: 3.5 });
        globe.controls().autoRotate = true; 
        globe.controls().autoRotateSpeed = 0.3;

        setTimeout(() => {
            if (window.THREE) {
                rocketMesh = build3DRocket();
                rocketMesh.visible = false; 
                globe.scene().add(rocketMesh);
            }
        }, 500);

    } catch (err) { console.error("Globe failed:", err); }
    
    initUserLocation();

    window.addEventListener('resize', () => {
        sidebarWidth = leftSidebar ? leftSidebar.clientWidth : 350;
        container.style.left = `${sidebarWidth}px`;
        container.style.width = `calc(100vw - ${sidebarWidth}px)`;
        overlay.style.left = `calc(${sidebarWidth}px + (100vw - ${sidebarWidth}px) / 2)`;
        if(globe) { globe.width(window.innerWidth - sidebarWidth); globe.height(window.innerHeight); }
    });
}

if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', buildGlobeUI); } 
else { buildGlobeUI(); }

// 🚀 কানেক্ট ফ্লাইট
window.flyToCountry = function(countryCode) {
    if(!globe) return;
    let dest = countryCoords[countryCode.toLowerCase()] || { lat: 0, lng: 0, name: countryCode.toUpperCase() };

    const overlay = document.getElementById('status-overlay');
    if(overlay) {
        overlay.innerText = `Routing to ${dest.name}... 🛰️`;
        overlay.style.color = '#f1c40f'; overlay.style.borderColor = 'rgba(241, 196, 15, 0.5)';
    }

    globe.ringsData([]); 
    globe.arcsData([]); // যেকোনো পুরানো arc সাফ করা
    globe.pointOfView({ altitude: 3.5 }, 1000); 

    let flightDuration = 2500;

    setTimeout(() => {
        // animate3DRocket এর ভেতরেই trail তৈরি হয় — globe.arcsData() এর দরকার নেই।
        animate3DRocket(CURRENT_LOC.lat, CURRENT_LOC.lng, dest.lat, dest.lng, flightDuration);

        setTimeout(() => {
            globe.pointOfView({ lat: dest.lat, lng: dest.lng, altitude: 1.5 }, 2000); 
            setTimeout(() => {
                setPulse(dest.lat, dest.lng, '#00ffcc'); 
                CURRENT_LOC = dest; 

                if(overlay) {
                    overlay.innerText = `Secured & Routed via ${dest.name} 🛡️`;
                    overlay.style.color = '#00ffcc'; overlay.style.borderColor = 'rgba(0, 255, 204, 0.5)';
                }
            }, 1500);
        }, 1500);
    }, 1000);
};

// 📡 রিটার্ন ফ্লাইট
window.backToHome = function() {
    if(!globe) return;
    const overlay = document.getElementById('status-overlay');
    if(overlay) {
        overlay.innerText = `Connection Dropped. Returning... 📡`;
        overlay.style.color = '#e74c3c'; overlay.style.borderColor = 'rgba(231, 76, 60, 0.5)';
    }

    globe.ringsData([]); 
    globe.arcsData([]); // যেকোনো পুরানো arc সাফ করা
    globe.pointOfView({ altitude: 3.5 }, 1200);

    let flightDuration = 2500;

    setTimeout(() => {
        // animate3DRocket এর ভেতরেই trail তৈরি হয় — globe.arcsData() এর দরকার নেই।
        animate3DRocket(CURRENT_LOC.lat, CURRENT_LOC.lng, HOME_LOC.lat, HOME_LOC.lng, flightDuration);

        globe.pointOfView({ lat: HOME_LOC.lat, lng: HOME_LOC.lng, altitude: 2.5 }, 2000);
        
        setTimeout(() => {
            setPulse(HOME_LOC.lat, HOME_LOC.lng, '#FF416C'); 
            CURRENT_LOC = HOME_LOC; 

            if(overlay) {
                overlay.innerText = `Standing by in ${HOME_LOC.name} 🌐`;
                overlay.style.color = '#00ffcc'; overlay.style.borderColor = 'rgba(0, 255, 204, 0.5)';
            }
        }, 2000);
    }, 1200);
};