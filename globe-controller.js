// ==========================================
// 🌍 FREEPROXY 3D GLOBE CONTROLLER (THE FLAWLESS ROCKET FIX)
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

// 🔴 THE BULLETPROOF Z-AXIS ROCKET: জন্মগতভাবেই মাথা সামনে, লেজ জিরোতে!
function build3DRocket() {
    const wrapper = new window.THREE.Group(); 
    
    // 1. Flame (ধোঁয়া) - বেস 0.75, মাথা ঠিক 0 তে (পেছনের দিকে মুখ করা)
    const flameGeo = new window.THREE.ConeGeometry(0.5, 1.5, 16);
    flameGeo.rotateX(-Math.PI / 2); // ধোঁয়ার কোণ পেছনের দিকে (-Z)
    flameGeo.translate(0, 0, 0.75); // ধোঁয়ার মাথা একদম (0,0,0) তে লক!
    const flameMat = new window.THREE.MeshBasicMaterial({ color: 0xdddddd, transparent: true, opacity: 0.8 });
    wrapper.add(new window.THREE.Mesh(flameGeo, flameMat));

    // 2. Body - Z অ্যাক্সিস বরাবর সোজা
    const bodyGeo = new window.THREE.CylinderGeometry(0.8, 0.8, 4, 16);
    bodyGeo.rotateX(Math.PI / 2); // সিলিন্ডারকে Z অ্যাক্সিসে শোয়ানো হলো
    bodyGeo.translate(0, 0, 3.5); // বডি সামনের দিকে (+Z)
    const bodyMat = new window.THREE.MeshLambertMaterial({ color: 0xffffff });
    wrapper.add(new window.THREE.Mesh(bodyGeo, bodyMat));

    // 3. Nose (লাল নাক) - মাথা একদম সামনের দিকে (+Z)
    const noseGeo = new window.THREE.ConeGeometry(0.8, 2, 16);
    noseGeo.rotateX(Math.PI / 2); // নাক সামনের দিকে (+Z)
    noseGeo.translate(0, 0, 6.5); // নাক সবার সামনে!
    const noseMat = new window.THREE.MeshLambertMaterial({ color: 0xff416c });
    wrapper.add(new window.THREE.Mesh(noseGeo, noseMat));

    // 4. Fins (পাখা)
    const finGeo = new window.THREE.BoxGeometry(0.2, 2.5, 1.5);
    const finMat = new window.THREE.MeshLambertMaterial({ color: 0xff416c });
    for(let i=0; i<4; i++) {
        const fin = new window.THREE.Mesh(finGeo, finMat);
        fin.position.z = 2.5; // পাখাগুলা বডির নিচের দিকে
        fin.rotation.z = (Math.PI / 2) * i;
        fin.translateX(0.8);
        wrapper.add(fin);
    }

    wrapper.scale.set(1.2, 1.2, 1.2); // রকেটের সুন্দর সাইজ
    return wrapper;
}

function setPulse(lat, lng, color) {
    if(!globe) return;
    globe.ringsData([{ lat: lat, lng: lng }])
        .ringColor(() => color).ringMaxRadius(6).ringPropagationSpeed(3).ringRepeatPeriod(1000);
}

async function initUserLocation() {
    const overlay = document.getElementById('status-overlay');
    if(overlay) overlay.innerText = `Detecting Present Location... 🌍`;

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
    }

    if(globe) {
        globe.pointOfView({ lat: HOME_LOC.lat, lng: HOME_LOC.lng, altitude: 2.5 }, 2000);
        setTimeout(() => setPulse(HOME_LOC.lat, HOME_LOC.lng, '#FF416C'), 1000);
    }
}

// 🔴 EXACT GLOBE.GL MATH
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
    
    let curve = new window.THREE.QuadraticBezierCurve3(vStart, vControl, vEnd);

    function update() {
        let t = (Date.now() - startTime) / duration;
        if (t > 1) t = 1;
        
        let vCur = curve.getPoint(t);
        let vNext = curve.getPoint(Math.min(t + 0.02, 1.0));
        
        rocketMesh.position.copy(vCur); // লেজ ঠিক ধোঁয়ার শেষ মাথায় থাকবে
        rocketMesh.up.copy(vCur).normalize(); // পৃথিবীর দিকে পেট
        
        if (vNext.distanceToSquared(vCur) > 0.0001) {
            rocketMesh.lookAt(vNext); // নাক গ্যারান্টি দিয়ে সামনের দিকে থাকবে!
        }

        if (t < 1) {
            requestAnimationFrame(update);
        } else {
            rocketMesh.visible = false; 
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

    // 🔴 UI FIX: আপনার HTML এর ডিজাইনে কোনো হাত দেওয়া হয়নি।
    let overlay = document.getElementById('status-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'status-overlay';
        document.body.appendChild(overlay); 
    }

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
        if(globe) { globe.width(window.innerWidth - sidebarWidth); globe.height(window.innerHeight); }
    });
}

if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', buildGlobeUI); } 
else { buildGlobeUI(); }

// 🚀 কানেক্ট ফ্লাইট (Perfect Smoke Sync)
window.flyToCountry = function(countryCode) {
    if(!globe) return;
    let dest = countryCoords[countryCode.toLowerCase()] || { lat: 0, lng: 0, name: countryCode.toUpperCase() };

    const overlay = document.getElementById('status-overlay');
    if(overlay) {
        overlay.innerText = `Routing to ${dest.name}... 🛰️`;
    }

    globe.ringsData([]); 
    globe.arcsData([]);
    globe.pointOfView({ altitude: 3.5 }, 1000); 

    let flightDuration = 2500;

    setTimeout(() => {
        animate3DRocket(CURRENT_LOC.lat, CURRENT_LOC.lng, dest.lat, dest.lng, flightDuration);

        // 🔴 SMOKE TRAIL LOGIC: রকেটের সাথে সাথে সাদা ধোঁয়া!
        globe.arcsData([{ 
            startLat: CURRENT_LOC.lat, startLng: CURRENT_LOC.lng, 
            endLat: dest.lat, endLng: dest.lng, 
            color: ['rgba(255,255,255,0.0)', 'rgba(200,200,200,0.8)'] 
        }])
        .arcAltitude(0.35) 
        .arcColor('color')
        .arcDashLength(1) 
        .arcDashGap(2) 
        .arcDashInitialGap(() => 1) 
        .arcDashAnimateTime(flightDuration) 
        .arcStroke(2.5);

        setTimeout(() => {
            globe.pointOfView({ lat: dest.lat, lng: dest.lng, altitude: 1.5 }, 2000); 
            setTimeout(() => {
                globe.arcsData([]); // ধোঁয়া গায়েব
                setPulse(dest.lat, dest.lng, '#00ffcc'); 
                CURRENT_LOC = dest; 

                if(overlay) {
                    overlay.innerText = `Secured & Routed via ${dest.name} 🛡️`;
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
    }

    globe.ringsData([]); 
    globe.arcsData([]);
    globe.pointOfView({ altitude: 3.5 }, 1200);

    let flightDuration = 2500;

    setTimeout(() => {
        animate3DRocket(CURRENT_LOC.lat, CURRENT_LOC.lng, HOME_LOC.lat, HOME_LOC.lng, flightDuration);

        globe.arcsData([{ 
            startLat: CURRENT_LOC.lat, startLng: CURRENT_LOC.lng, 
            endLat: HOME_LOC.lat, endLng: HOME_LOC.lng, 
            color: ['rgba(255,255,255,0.0)', 'rgba(200,200,200,0.8)'] 
        }])
        .arcAltitude(0.35)
        .arcColor('color')
        .arcDashLength(1).arcDashGap(2).arcDashInitialGap(() => 1)
        .arcDashAnimateTime(flightDuration).arcStroke(2.5);

        globe.pointOfView({ lat: HOME_LOC.lat, lng: HOME_LOC.lng, altitude: 2.5 }, 2000);
        
        setTimeout(() => {
            globe.arcsData([]); 
            setPulse(HOME_LOC.lat, HOME_LOC.lng, '#FF416C'); 
            CURRENT_LOC = HOME_LOC; 

            if(overlay) {
                overlay.innerText = `Standing by in ${HOME_LOC.name} 🌐`;
            }
        }, 2000);
    }, 1200);
};