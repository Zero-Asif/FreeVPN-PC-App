const WebSocket = require('ws');
const { app, BrowserWindow, ipcMain, shell, session } = require('electron');
const { exec, execSync, execFile, spawn, spawnSync } = require('child_process');
const path = require('path');
const fs   = require('fs');
const os   = require('os');

// ════════════════════════════════════════════════════════════
//  LOCAL ENGINE MODULES
//
//  socks-fetch  -- HTTP(S) over SOCKS5 on Node's own sockets, so exit
//                  verification can never silently no-op the way the old
//                  curl.exe shell-out did.
//  tor-control  -- Tor ControlPort client: re-pin the exit in ~1 s
//                  instead of restarting Tor and wiping its consensus
//                  cache (which took far longer than the old 12 s wait,
//                  so verification always ran against a Tor that was
//                  still bootstrapping).
//  exit-selector-- pick ONE exit relay per country and remember it, the
//                  way a commercial VPN reuses a named server.
// ════════════════════════════════════════════════════════════
const { socksGet, directGet }                      = require('./lib/socks-fetch');
const { TorControl }                               = require('./lib/tor-control');
const { ExitStore, RelayIndex, probeExitLocation } = require('./lib/exit-selector');
const { GeoSpoof }                                 = require('./lib/geo-spoof');
const { GeoExt }                                   = require('./lib/geo-ext');
const browsers                                     = require('./lib/browsers');
//  What the installer and the uninstaller run inside this same exe, so
//  NSIS never holds a second copy of a registry path or a browser list.
const installerTasks                               = require('./lib/installer-tasks');
//  Where the user actually is. Asked from HERE rather than from the window, so
//  that no remote host has to be named in index.html's connect-src -- and so
//  that the kill switch can refuse the question outright. See the module head.
const { lookupHomeLocation }                       = require('./lib/home-location');

// ════════════════════════════════════════════════════════════
//  LOGGER  (ASCII-only output — no Unicode, no garbled chars)
//
//  Fix: Windows terminal (CP1252) garbles UTF-8 characters
//  like === and —. Replaced with plain ASCII equivalents.
// ════════════════════════════════════════════════════════════
const Logger = (() => {
    let logDir = '', logFile = '';

    function init(ud) {
        logDir = path.join(ud, 'logs');
        if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
        rotateLogs();
        logFile = path.join(logDir, `freeproxy-${dateStr()}.log`);
        write('INFO', '======================================');
        write('INFO', `FreeProxy VPN started -- PID ${process.pid}`);
        write('INFO', `Platform: ${os.type()} ${os.release()} | Arch: ${os.arch()}`);
        write('INFO', `Electron: ${process.versions.electron}  Node: ${process.versions.node}`);
        write('INFO', '======================================');
    }

    function dateStr() { return new Date().toISOString().slice(0, 10); }
    function timeStr() { return new Date().toISOString().replace('T', ' ').slice(0, 23); }

    function rotateLogs() {
        try {
            const files = fs.readdirSync(logDir)
                .filter(f => f.startsWith('freeproxy-') && f.endsWith('.log')).sort();
            while (files.length > 7) fs.unlinkSync(path.join(logDir, files.shift()));
        } catch(e) {}
    }

    function write(level, message, meta = null) {
        const ts   = timeStr();
        const pad  = level.padEnd(7);
        const ms   = meta ? '  ' + JSON.stringify(meta) : '';
        const line = `[${ts}] [${pad}] ${message}${ms}\n`;
        // ASCII colour codes (safe on all Windows terminals)
        const colours = {
            DEBUG: '\x1b[90m', INFO: '\x1b[37m',
            WARN:  '\x1b[33m', ERROR: '\x1b[31m', SUCCESS: '\x1b[32m'
        };
        process.stdout.write((colours[level] || '') + line + '\x1b[0m');
        if (logFile) { try { fs.appendFileSync(logFile, line); } catch(e) {} }
        const nf = path.join(logDir, `freeproxy-${dateStr()}.log`);
        if (nf !== logFile) logFile = nf;
    }

    function tail(n = 300, level = 'ALL') {
        try {
            const content = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
            let lines = content.split('\n').filter(Boolean);
            if (level !== 'ALL') lines = lines.filter(l => l.includes(`[${level}`));
            return lines.slice(-n);
        } catch(e) { return []; }
    }

    return {
        init,
        getLogFile: () => logFile,
        getLogDir:  () => logDir,
        tail,
        debug:   (m, x) => write('DEBUG',   m, x),
        info:    (m, x) => write('INFO',    m, x),
        warn:    (m, x) => write('WARN',    m, x),
        error:   (m, x) => write('ERROR',   m, x),
        success: (m, x) => write('SUCCESS', m, x),
    };
})();

// ════════════════════════════════════════════════════════════
//  GEOLOCATION COORDS  (capital cities per country)
// ════════════════════════════════════════════════════════════
const GEO_COORDS = {
    'us':{ lat:38.8951,  lng:-77.0364,  accuracy:15, city:'Washington D.C.'   },
    'gb':{ lat:51.5074,  lng:-0.1278,   accuracy:12, city:'London'            },
    'ca':{ lat:45.4215,  lng:-75.6919,  accuracy:14, city:'Ottawa'            },
    'au':{ lat:-35.2809, lng:149.1300,  accuracy:16, city:'Canberra'          },
    'de':{ lat:52.5200,  lng:13.4050,   accuracy:10, city:'Berlin'            },
    'fr':{ lat:48.8566,  lng:2.3522,    accuracy:11, city:'Paris'             },
    'nl':{ lat:52.3676,  lng:4.9041,    accuracy:10, city:'Amsterdam'         },
    'it':{ lat:41.9028,  lng:12.4964,   accuracy:13, city:'Rome'              },
    'es':{ lat:40.4168,  lng:-3.7038,   accuracy:12, city:'Madrid'            },
    'ch':{ lat:46.9481,  lng:7.4474,    accuracy:10, city:'Bern'              },
    'se':{ lat:59.3293,  lng:18.0686,   accuracy:12, city:'Stockholm'         },
    'no':{ lat:59.9139,  lng:10.7522,   accuracy:11, city:'Oslo'              },
    'dk':{ lat:55.6761,  lng:12.5683,   accuracy:10, city:'Copenhagen'        },
    'fi':{ lat:60.1699,  lng:24.9384,   accuracy:13, city:'Helsinki'          },
    'pl':{ lat:52.2297,  lng:21.0122,   accuracy:14, city:'Warsaw'            },
    'ro':{ lat:44.4268,  lng:26.1025,   accuracy:15, city:'Bucharest'         },
    'at':{ lat:48.2082,  lng:16.3738,   accuracy:11, city:'Vienna'            },
    'be':{ lat:50.8503,  lng:4.3517,    accuracy:10, city:'Brussels'          },
    'cz':{ lat:50.0755,  lng:14.4378,   accuracy:12, city:'Prague'            },
    'hu':{ lat:47.4979,  lng:19.0402,   accuracy:13, city:'Budapest'          },
    'pt':{ lat:38.7169,  lng:-9.1399,   accuracy:12, city:'Lisbon'            },
    'gr':{ lat:37.9838,  lng:23.7275,   accuracy:14, city:'Athens'            },
    'ie':{ lat:53.3498,  lng:-6.2603,   accuracy:11, city:'Dublin'            },
    'lu':{ lat:49.6117,  lng:6.1319,    accuracy:10, city:'Luxembourg City'   },
    'ru':{ lat:55.7558,  lng:37.6173,   accuracy:20, city:'Moscow'            },
    'ua':{ lat:50.4501,  lng:30.5234,   accuracy:18, city:'Kyiv'              },
    'jp':{ lat:35.6762,  lng:139.6503,  accuracy:12, city:'Tokyo'             },
    'kr':{ lat:37.5665,  lng:126.9780,  accuracy:11, city:'Seoul'             },
    'cn':{ lat:39.9042,  lng:116.4074,  accuracy:25, city:'Beijing'           },
    'sg':{ lat:1.3521,   lng:103.8198,  accuracy:10, city:'Singapore'         },
    'in':{ lat:28.6139,  lng:77.2090,   accuracy:22, city:'New Delhi'         },
    'bd':{ lat:23.8103,  lng:90.4125,   accuracy:18, city:'Dhaka'             },
    'pk':{ lat:33.7294,  lng:73.0931,   accuracy:20, city:'Islamabad'         },
    'ae':{ lat:24.4539,  lng:54.3773,   accuracy:12, city:'Abu Dhabi'         },
    'sa':{ lat:24.6877,  lng:46.7219,   accuracy:14, city:'Riyadh'            },
    'qa':{ lat:25.2854,  lng:51.5310,   accuracy:11, city:'Doha'              },
    'kw':{ lat:29.3759,  lng:47.9774,   accuracy:12, city:'Kuwait City'       },
    'om':{ lat:23.5880,  lng:58.3829,   accuracy:13, city:'Muscat'            },
    'il':{ lat:31.7683,  lng:35.2137,   accuracy:12, city:'Jerusalem'         },
    'tr':{ lat:39.9334,  lng:32.8597,   accuracy:15, city:'Ankara'            },
    'id':{ lat:-6.2088,  lng:106.8456,  accuracy:18, city:'Jakarta'           },
    'my':{ lat:3.1390,   lng:101.6869,  accuracy:13, city:'Kuala Lumpur'      },
    'th':{ lat:13.7563,  lng:100.5018,  accuracy:14, city:'Bangkok'           },
    'vn':{ lat:21.0285,  lng:105.8542,  accuracy:16, city:'Hanoi'             },
    'ph':{ lat:14.5995,  lng:120.9842,  accuracy:15, city:'Manila'            },
    'hk':{ lat:22.3193,  lng:114.1694,  accuracy:11, city:'Hong Kong'         },
    'tw':{ lat:25.0330,  lng:121.5654,  accuracy:12, city:'Taipei'            },
    'za':{ lat:-25.7479, lng:28.2293,   accuracy:18, city:'Pretoria'          },
    'eg':{ lat:30.0444,  lng:31.2357,   accuracy:16, city:'Cairo'             },
    'ng':{ lat:9.0579,   lng:7.4951,    accuracy:22, city:'Abuja'             },
    'ke':{ lat:-1.2921,  lng:36.8219,   accuracy:17, city:'Nairobi'           },
    'ma':{ lat:33.9716,  lng:-6.8498,   accuracy:15, city:'Rabat'             },
    'tn':{ lat:36.8065,  lng:10.1815,   accuracy:15, city:'Tunis'             },
    'br':{ lat:-15.7801, lng:-47.9292,  accuracy:20, city:'Brasilia'          },
    'ar':{ lat:-34.6037, lng:-58.3816,  accuracy:16, city:'Buenos Aires'      },
    'mx':{ lat:19.4326,  lng:-99.1332,  accuracy:18, city:'Mexico City'       },
    'co':{ lat:4.7110,   lng:-74.0721,  accuracy:17, city:'Bogota'            },
    'cl':{ lat:-33.4489, lng:-70.6693,  accuracy:14, city:'Santiago'          },
    'nz':{ lat:-41.2865, lng:174.7762,  accuracy:13, city:'Wellington'        },
    'is':{ lat:64.1355,  lng:-21.8954,  accuracy:12, city:'Reykjavik'         },
    'kz':{ lat:51.1801,  lng:71.4460,   accuracy:22, city:'Nur-Sultan'        },
    'hr':{ lat:45.8150,  lng:15.9819,   accuracy:13, city:'Zagreb'            },
    'bg':{ lat:42.6977,  lng:23.3219,   accuracy:14, city:'Sofia'             },
    'md':{ lat:47.0105,  lng:28.8638,   accuracy:15, city:'Chisinau'          },
    'rs':{ lat:44.7866,  lng:20.4489,   accuracy:14, city:'Belgrade'          },
    'lt':{ lat:54.6872,  lng:25.2797,   accuracy:12, city:'Vilnius'           },
    'lv':{ lat:56.9496,  lng:24.1052,   accuracy:12, city:'Riga'              },
    'ee':{ lat:59.4370,  lng:24.7536,   accuracy:12, city:'Tallinn'           },
    'cy':{ lat:35.1856,  lng:33.3823,   accuracy:13, city:'Nicosia'           },
    'az':{ lat:40.4093,  lng:49.8671,   accuracy:16, city:'Baku'              },
    'pe':{ lat:-12.0464, lng:-77.0428,  accuracy:17, city:'Lima'              },
    'cr':{ lat:9.9281,   lng:-84.0907,  accuracy:14, city:'San Jose'          },
    'sc':{ lat:-4.6191,  lng:55.4513,   accuracy:12, city:'Victoria'          },
};

// ════════════════════════════════════════════════════════════
//  GEOLOCATION SPOOF ENGINE
// ════════════════════════════════════════════════════════════
let geoSpoofActive = false;

//  Drop any country the app cannot spoof a location for.
//
//  Onionoo decides which countries have exit relays, and that set
//  changes as relays come and go -- so it will eventually contain a
//  country GEO_COORDS has never heard of. Offering it would produce
//  the worst outcome available: the tunnel comes up, the IP changes,
//  and the page still reads the real position because
//  applyGeolocationSpoof has nothing to apply. Refusing to list the
//  country is the safe direction to fail in.
function spoofableOnly(stats) {
    const out = {};
    const dropped = [];
    for (const [cc, v] of Object.entries(stats)) {
        if (GEO_COORDS[cc]) out[cc] = v; else dropped.push(cc);
    }
    if (dropped.length) {
        Logger.warn(`Hiding ${dropped.length} exit country/ies with no coordinates: ` +
                    dropped.join(', '));
    }
    return out;
}

// ════════════════════════════════════════════════════════════
//  HOW CLOSE IS CLOSE?  --  the ordering behind the "connect me
//  somewhere near instead" option
//
//  When the country the user picked has no exit relay, the app offers to
//  connect to the NEAREST country that has one. "Nearest" has to mean
//  something measurable, so it is the great-circle distance between the two
//  capitals in GEO_COORDS -- the same table the geolocation spoof reads, so
//  the distance the choice was made on is the distance between the two
//  positions the app would actually report.
//
//  Capitals, not centroids or borders: a border-to-border distance would call
//  Russia the closest country to Norway, and the position this app spoofs is
//  the capital, not the border. It is an approximation and it is named as one
//  -- but it is an approximation of the right thing, and it never guesses:
//  every country it can return is one the live relay index says has an exit.
// ════════════════════════════════════════════════════════════
function haversineKm(a, b) {
    const R = 6371;
    const rad = d => d * Math.PI / 180;
    const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 +
              Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

//  Every country in `stats` that is not `cc` and not excluded, nearest first.
//  `stats` is the live exit-relay index (countryStats()), so a country only
//  appears here if it currently HAS exit capacity -- offering a neighbour with
//  no exits would just move the same failure one country sideways.
function nearestExitCountries(cc, stats, { exclude = [] } = {}) {
    const home = GEO_COORDS[cc];
    if (!home) return [];
    const skip = new Set([cc, ...exclude]);
    return Object.keys(stats || {})
        .filter(k => !skip.has(k) && GEO_COORDS[k] && (stats[k]?.count || 0) > 0)
        .map(k => ({ cc: k, km: Math.round(haversineKm(home, GEO_COORDS[k])) }))
        .sort((a, b) => a.km - b.km);
}

//  One engine per process, built lazily -- APPDATA_PATH is not assigned
//  until further down this file.
let _geoEngine = null;
function geoEngine() {
    if (!_geoEngine) _geoEngine = new GeoSpoof({ log: Logger, stateDir: APPDATA_PATH });
    return _geoEngine;
}

//  The Chromium delivery layer: packages Extension/, serves it from
//  loopback and force-installs it wherever that route is accepted. Kept
//  separate from GeoSpoof deliberately -- one owns the user's browsers,
//  the other owns the Windows platform and Firefox, and they fail
//  independently. A browser without the extension must not stop lfsvc
//  from being denied, and vice versa.
let _geoExt = null;
function geoExt() {
    if (!_geoExt) _geoExt = new GeoExt({
        log: Logger, stateDir: APPDATA_PATH,
        //  Extension/ ships as an extraResource, not inside the asar, so the
        //  packaged path is resourcesPath -- __dirname would point into
        //  app.asar where it is not present at all.
        sourceDir: app.isPackaged
            ? path.join(process.resourcesPath, 'Extension')
            : path.join(__dirname, 'Extension'),
    });
    return _geoExt;
}

//  Report what is covered, per surface, and in WHICH SENSE.
//
//  The distinction matters and is not padding, and each word here is a
//  measurement rather than a hope.
//
//  "Spoofed" means the API hands back the connected country's coordinates.
//  That is true of this app's own window, of Firefox, and of every Chromium
//  profile where presence() can see the extension actually loaded.
//
//  "Shielded" means something weaker and is never called a spoof. The Windows
//  location platform -- Maps, Weather, and every Win32/WinRT app that calls
//  the Geolocator API -- cannot be handed fake coordinates at all. That was
//  measured, not assumed: .build/test-winloc-default.js writes Windows' own
//  documented Default Location and a native .NET consumer keeps reporting the
//  real position, with the survey working AND with lfsvc cut off from the
//  network and restarted. There is no location sensor on the machine to
//  deliver that fallback, and the only two mechanisms that would work -- a
//  signed virtual GPS driver, or injecting into every process that asks --
//  are refused on purpose, the first because shipping it unsigned means
//  asking the user to disable driver signature enforcement, the second
//  because it is indistinguishable from a rootkit.
//
//  So what the app does for that surface is cut the LEAK and leave the
//  SETTING alone: one named, service-scoped firewall rule stops lfsvc from
//  reaching Microsoft's location service, so no fresh real fix can be
//  resolved or sent while connected. Location stays ON, permission stays
//  Granted, and the user's Settings control stays theirs -- an earlier build
//  denied instead, and switching a user's own location off underneath them
//  is what that cost. A native app holding a cached fix can still report it;
//  that is the honest ceiling and it is what gets logged.
//
//  Browser coverage is DETECTED, never assumed, and every browser named in
//  this report comes from lib/browsers.js. presence() reads each installed
//  fork's OWN profile and answers whether the extension is genuinely loaded
//  there; the Gecko count is the number of profiles this run actually wrote.
//  No browser is ever named as covered because the table says it could be --
//  the table only says where to look.
function reportGeoCoverage(coord) {
    const s     = geoEngine().status();
    const where = coord ? coord.city : 'the connected country';

    //  presence() answers per browser ID; every id becomes a display name
    //  before it reaches a log line, so the user reads "Microsoft Edge" and
    //  not "edge".
    let seen = {};
    try { seen = geoExt().presence(); } catch (e) {}
    const withState = st => browsers.names(Object.keys(seen).filter(b => seen[b] === st));
    const covered   = withState('installed');
    const missing   = withState('absent');

    //  Gecko is reported by the fork whose profiles were actually written,
    //  never as "Firefox" for whatever happened to be on disk. A profile
    //  directory left behind by an uninstalled browser is not spoofed and is
    //  not counted -- claiming it was is exactly what the verified-executable
    //  check in lib/browsers.js exists to prevent.
    const geckoHere = browsers.names(browsers.detectGecko().map(b => b.id));
    const gecko = s.geckoSpoofed
        ? `${(s.geckoBrowsers || ['Gecko']).join('/')}: spoofed (${where})`
        : geckoHere.length
            ? `${geckoHere.join('/')}: installed but NOT spoofed yet`
            : 'Gecko family: not installed';

    Logger.info('Location coverage -- ' +
        `app window: spoofed (${where}); ` +
        `Chromium (${covered.join('/') || 'none'}): spoofed by the extension; ` +
        `${gecko}; ` +
        `Windows platform: ${s.windowsShielded ? 'shielded -- lfsvc cannot resolve or ' +
            'send a fresh real fix, so no native app is given ' + where + ' either: ' +
            'Windows has no coordinate-injection API' : 'NOT shielded'}`);

    if (missing.length) {
        Logger.warn(`${missing.join(' and ')} will keep reporting the real location until ` +
                    'the spoofer is loaded there once by hand -- instructions in ' +
                    geoExt().baseDir);
    }

    //  Installed browsers with no extension model at all: Internet Explorer
    //  and the WebView/UWP hosts. Their traffic goes through the system proxy,
    //  so the exit country is right there, but their geolocation comes from the
    //  Windows platform -- which is shielded and cannot be spoofed. Naming them
    //  is the difference between a coverage report and a claim.
    const noExt = browsers.names(browsers.detect().filter(b => b.family === 'wininet')
                                         .map(b => b.id));
    if (noExt.length) {
        Logger.info(`${noExt.join(' and ')}: traffic is proxied so the exit country is ` +
                    'correct there, but its location comes from the Windows platform -- ' +
                    'shielded, never spoofed');
    }

    if (!s.windowsShielded) {
        Logger.warn('The Windows location platform is not shielded -- lfsvc can still put ' +
                    "the user's real surroundings on the wire and a native app can read the " +
                    'real position. The firewall rule needs administrator rights.');
    }
    if (s.legacyGrantsPending) {
        Logger.warn(`${s.legacyGrantsPending} site permission(s) that an older build set to ` +
                    'Block are still waiting to be handed back -- close every browser and ' +
                    'disconnect once to finish that.');
    }
}

function applyGeolocationSpoof(win, serverCode) {
    const coord = GEO_COORDS[serverCode.toLowerCase()];
    if (!coord) { Logger.warn('No geo coords for code', { serverCode }); return; }

    //  Set here rather than inside the CDP .then(): if attaching the
    //  debugger fails, the device-wide layers still ran and
    //  clearGeolocationSpoof must still tear them down. Flagging this only
    //  on CDP success is how a failed attach used to leave the machine
    //  with its location switched off after disconnecting.
    geoSpoofActive = true;

    const jitter = () => (Math.random() - 0.5) * 0.004;
    const lat = coord.lat + jitter();
    const lng = coord.lng + jitter();

    // ── Layer 1: CDP override (Electron window) ─────────────────
    try {
        if (!win.webContents.debugger.isAttached()) {
            win.webContents.debugger.attach('1.3');
        }
        win.webContents.debugger.sendCommand('Emulation.setGeolocationOverride', {
            latitude:  lat,
            longitude: lng,
            accuracy:  coord.accuracy,
        }).then(() => {
            Logger.success(`GPS spoofed -> ${coord.city} (${serverCode.toUpperCase()})`);
        }).catch(e => Logger.error('CDP geo override failed', { err: e.message }));
    } catch(e) {
        Logger.error('CDP debugger attach failed', { err: e.message });
    }

    // ── Layer 2: Notify renderer to patch navigator.geolocation ─
    win.webContents.send('geo-spoof-on', {
        lat, lng, accuracy: coord.accuracy, city: coord.city, country: serverCode.toUpperCase(),
    });

    // ── The device-wide layers ──────────────────────────────────
    //  The user's browsers, lfsvc and Firefox are handled by
    //  lib/geo-ext.js and lib/geo-spoof.js, driven from the wrapper at
    //  the bottom of this file. They live there for two reasons:
    //
    //   * each change has to be RECORDED before it is made, so
    //     disconnecting restores what the user actually had. Stopping
    //     lfsvc from here, before that snapshot was taken, is what made
    //     the app record "the service was already stopped" and then never
    //     start it again.
    //   * packaging the extension, writing its install policy and waiting
    //     for the browsers to exit are all asynchronous, and cannot be
    //     awaited from a synchronous function.
}

function clearGeolocationSpoof(win) {
    if (!geoSpoofActive) return;
    try {
        if (win.webContents.debugger.isAttached()) {
            win.webContents.debugger.sendCommand('Emulation.clearGeolocationOverride')
                .catch(e => Logger.warn('CDP geo clear failed', { err: e.message }));
        }
    } catch(e) {}
    win.webContents.send('geo-spoof-off');
    //  The browser policies, the per-profile settings, the Windows
    //  location platform and Firefox are all restored by the wrapper at
    //  the bottom of this file, from the journal that recorded what each
    //  of them held BEFORE the connection. Undoing them here as well --
    //  from hard-coded values, with no backup -- is how "restore" used to
    //  hand the user settings they never had.
    geoSpoofActive = false;
    Logger.info('GPS spoof cleared -- real location restored');
}

// ════════════════════════════════════════════════════════════
//  UAC CHECK
// ════════════════════════════════════════════════════════════
function isRunAsAdmin() {
    try { execSync('net session', { stdio: 'ignore', windowsHide: true }); return true; }
    catch(e) { return false; }
}

// Override userData to C:\ProgramData\freeproxy-vpn (no spaces in path)
// Must be set BEFORE app.getPath() is ever called
const APPDATA_PATH = 'C:\\ProgramData\\freeproxy-vpn';
try {
    if (!require('fs').existsSync(APPDATA_PATH)) {
        require('fs').mkdirSync(APPDATA_PATH, { recursive: true });
    }
    app.setPath('userData', APPDATA_PATH);
} catch(e) { /* fallback to default if setPath fails */ }

app.whenReady().then(() => {
    Logger.init(app.getPath('userData'));
    Logger.info('app.whenReady() fired');

    //  --fp-setup / --fp-teardown: do that job and exit. No window, no
    //  Tor, and no elevation dance -- the installer is already elevated,
    //  and prompting from inside an install would be a UAC dialog with no
    //  visible parent. Placed before the admin check for exactly that
    //  reason; lib/installer-tasks.js warns if it really is unelevated.
    const installerJob = installerTasks.installerTask(process.argv);
    if (installerJob) {
        installerTasks.runInstallerTask(installerJob, {
            Logger, isRunAsAdmin, geoEngine, geoExt,
            restoreBrowserPolicy: restoreAllBrowsersProxy,
        }).then(code => {
            Logger.info(`--fp-${installerJob} finished with exit code ${code}`);
            app.exit(code);
        });
        return;
    }

    if (!isRunAsAdmin()) {
        Logger.warn('Not admin -- requesting elevation');
        const ps1 = path.join(os.tmpdir(), 'vpn_elevate.ps1');
        const exe = process.execPath, dir = __dirname;
        const scr = app.isPackaged
            ? `Start-Process -FilePath '${exe}' -Verb RunAs -Wait`
            : `Start-Process -FilePath '${exe}' -ArgumentList '"${dir}"' -Verb RunAs -Wait`;
        fs.writeFileSync(ps1, scr);
        const child = spawn('powershell.exe',
            ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1],
            { stdio: 'inherit' });
        child.on('exit', code => {
            Logger.info(`Elevation exited: ${code}`);
            app.quit(); process.exit(code || 0);
        });
    } else {
        Logger.success('Running with admin privileges');
        runAdminApp();
    }
});

// ════════════════════════════════════════════════════════════
//  MAIN APP
// ════════════════════════════════════════════════════════════
function runAdminApp() {
    const getScriptPath = f => path.join(app.getPath('userData'), f);
    let torDir = '';
    let mainWindow = null;

    function runBat(filePath, content) {
        // ─────────────────────────────────────────────────────
        //  ROOT CAUSE FIX: exec() path-with-spaces bug
        //
        //  exec(`"C:\Users\User pc\...\file.bat"`) runs:
        //    cmd.exe /c "C:\Users\User pc\...\file.bat"
        //  cmd.exe strips outer quotes → tries to run the bare
        //  path → space splits it → bat never executes → proxy
        //  never set → no internet.
        //
        //  spawn(['cmd.exe', '/c', filePath]) passes filePath as
        //  a separate OS argument → Windows handles spaces → works.
        // ─────────────────────────────────────────────────────
        return new Promise(resolve => {
            fs.writeFileSync(filePath, content, 'utf8');
            const proc = spawn('cmd.exe', ['/c', filePath], {
                windowsHide: true,
                stdio: 'pipe'
            });
            proc.on('exit', (code) => {
                if (code !== 0) Logger.warn(`bat exit code ${code}`, { filePath });
                else Logger.debug(`bat OK`, { filePath });
                resolve();
            });
            proc.on('error', (err) => {
                Logger.error(`bat spawn error`, { filePath, err: err.message });
                resolve(); // always resolve so Promise chain continues
            });
        });
    }

    function setupWritableTor() {
        const ud  = app.getPath('userData');
        const dst = path.join(ud, 'Tor');
        const src = app.isPackaged
            ? path.join(process.resourcesPath, 'app.asar.unpacked', 'Tor')
            : path.join(__dirname, 'Tor');
        try {
            if (!fs.existsSync(dst)) {
                Logger.info('Copying Tor bundle...');
                fs.cpSync(src, dst, { recursive: true });
                Logger.success('Tor bundle ready');
            } else {
                Logger.debug('Tor bundle already present');
            }
        } catch(e) { Logger.error('Tor bundle copy failed', { err: e.message }); }
        torDir = path.join(dst, 'tor');
    }

    // ── Startup cleanup ───────────────────────────────────
    function startupCleanup() {
        Logger.info('Startup cleanup...');
        try { execSync('taskkill /F /IM tor.exe', { stdio: 'ignore', windowsHide: true }); Logger.debug('Killed stale tor.exe'); } catch(e) {}

        //  If the app died while connected, everything it changed about
        //  the machine's location is still in place. The journal recorded
        //  what each setting was BEFORE the connection, so this puts them
        //  back exactly rather than guessing at defaults.
        //
        //  Guarded, and deliberately NOT folded into the big try below,
        //  because everything after this point -- removing the proxy,
        //  dropping the IPv6 firewall rules, putting DNS back -- has to run
        //  even if the journal is unreadable. Defaulting to false errs
        //  toward handing the location back rather than leaving it off.
        let hadGeoJournal = false;
        try { hadGeoJournal = geoEngine().restoreLeftovers(); }
        catch (e) { Logger.warn('Location restore at startup failed: ' + e.message); }

        const bat = getScriptPath('fp_startup_clean.bat');
        const content = [
            '@echo off',
            // Remove proxy
            `reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD /d 0 /f`,
            `reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer /t REG_SZ /d "" /f`,
            // Restore DNS: clear per-adapter + global NameServer
            `netsh interface portproxy delete v4tov4 listenport=53 listenaddress=127.0.0.1 2>nul`,
            `for /f %%i in ('reg query "HKLM\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters\\Interfaces"') do reg delete "%%i" /v NameServer /f 2>nul`,
            `reg delete "HKLM\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters" /v NameServer /f 2>nul`,
            // Restart dnscache in case previous session stopped it
            `net start dnscache 2>nul`,
            `ipconfig /flushdns`,
            //  Restore location access -- ONLY as a legacy safety net.
            //  Builds before the restore journal existed denied this
            //  without recording what it had been, so a crash could leave
            //  it on Deny with nothing to undo it.
            //
            //  When a journal WAS found this line is omitted, because
            //  restoreLeftovers() above has already put back the real
            //  setting -- and forcing "Allow" here would quietly switch
            //  location ON for a user who genuinely keeps it off.
            ...(hadGeoJournal ? [] : [`reg add "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\location" /v Value /t REG_SZ /d "Allow" /f`]),
            //  Remove our own location firewall rule if a hard kill left it
            //  behind. restoreWindows() takes it out on a clean disconnect,
            //  but that needs the journal; this needs nothing, and leaving
            //  lfsvc blocked forever would break the Location setting for a
            //  user who is no longer even connected.
            `netsh advfirewall firewall delete rule name="FreeProxy VPN - block Windows location resolution" 2>nul`,
            // Remove any stale IPv6-block firewall rules from a crashed session
            `netsh advfirewall firewall delete rule name="FreeProxy Block IPv6 Out" 2>nul`,
            `netsh advfirewall firewall delete rule name="FreeProxy Block IPv6 In" 2>nul`,
            // Restore IPv6
            `reg add "HKLM\\SYSTEM\\CurrentControlSet\\Services\\Tcpip6\\Parameters" /v DisabledComponents /t REG_DWORD /d 0 /f`,
            `powershell -Command "Get-NetAdapter | Where-Object {$_.Status -eq 'Up'} | ForEach-Object { try { Enable-NetAdapterBinding -Name $_.Name -ComponentID ms_tcpip6 -ErrorAction SilentlyContinue } catch {} }"`,
            `netsh interface teredo set state default`,
            `netsh interface isatap set state default`,
            `netsh interface 6to4 set state default`,
            `ipconfig /flushdns`,
        ].join('\r\n');

        try {
            fs.writeFileSync(bat, content, 'utf8');
            // Use cmd.exe with separate arg to handle spaces in path
            execSync(`cmd.exe /c "${bat}"`, { windowsHide: true, timeout: 15000 });
            //  Repair a start type an OLD build disabled. Trigger-start
            //  ("demand") is the Windows default, and leaving it disabled
            //  is what makes Settings > Privacy > Location unfixable, so
            //  this half runs unconditionally.
            try { execSync('sc config lfsvc start= demand', { windowsHide: true, stdio: 'pipe' }); } catch(e) {}
            //  STARTING it is only a legacy net. When a journal was found,
            //  restoreLeftovers() above already put the service back the way
            //  the user had it, and starting it here as well would switch
            //  Location ON for someone who deliberately keeps it off.
            if (!hadGeoJournal) {
                try { execSync('sc start lfsvc', { windowsHide: true, stdio: 'pipe' }); } catch(e) {}
            }
            // Remove stale hosts file entries from previous session
            const hostsPath = 'C:\\Windows\\System32\\drivers\\etc\\hosts';
            try {
                let hosts = fs.readFileSync(hostsPath, 'utf8');
                if (hosts.includes('FreeProxy VPN -- location spoof block')) {
                    hosts = hosts.replace(/\r?\n# FreeProxy VPN -- location spoof block[\s\S]*?# FreeProxy VPN end/g, '');
                    fs.writeFileSync(hostsPath, hosts, 'utf8');
                    Logger.debug('Startup: cleared stale hosts entries');
                }
            } catch(e) {}
            // ── Remove leftovers of the abandoned MITM experiment ──────
            //  An earlier version of this app tried to spoof geolocation by
            //  generating a self-signed certificate for www.googleapis.com,
            //  installing it in the machine's Trusted Root store and serving
            //  a fake geolocate endpoint from 127.0.0.1. That approach was
            //  dropped, but the certificates were never removed -- and a
            //  trusted root whose private key sits on disk in geospoof.pfx
            //  under a hard-coded password means anything holding that file
            //  can impersonate any Google host to this machine. Nothing in
            //  the current app needs it, so it is cleaned up on every start.
            try {
                //  Enumeration in PowerShell, deletion with certutil from here.
                //
                //  Remove-Item -DeleteKey throws on a certificate that has no
                //  private key -- which is all of these -- and the old
                //  SilentlyContinue + $n++ pairing turned that failure into a
                //  success message, so the app cheerfully reported removing
                //  certificates that are still installed. certutil names the
                //  physical store explicitly, which also matters here:
                //  CurrentUser\Root is a merged VIEW of the machine store, so
                //  deleting a machine certificate through it silently does
                //  nothing.
                const listPs =
                    'Get-ChildItem Cert:\\LocalMachine\\Root, Cert:\\LocalMachine\\My, ' +
                    'Cert:\\CurrentUser\\Root, Cert:\\CurrentUser\\My -EA SilentlyContinue | ' +
                    "Where-Object { $_.FriendlyName -eq 'FreeProxy GeoSpoof' -or " +
                    "($_.Subject -like '*CN=www.googleapis.com*' -and $_.Subject -eq $_.Issuer) } | " +
                    'Select-Object -ExpandProperty Thumbprint -Unique';

                const listCerts = () => {
                    try {
                        return execSync(
                            `powershell -NoProfile -NonInteractive -Command "${listPs}"`,
                            { windowsHide: true, timeout: 25000, stdio: 'pipe' })
                            .toString().split(/\r?\n/).map(x => x.trim())
                            .filter(x => /^[0-9A-Fa-f]{40}$/.test(x));
                    } catch (e) { return []; }
                };

                const before = listCerts();
                for (const tp of before) {
                    for (const st of ['Root', 'My', 'CA']) {
                        //  Machine scope and user scope both, because a
                        //  thumbprint found through the merged view could live
                        //  in either physical store.
                        for (const scope of [`-f -delstore ${st} ${tp}`,
                                             `-user -f -delstore ${st} ${tp}`]) {
                            try {
                                execSync(`certutil ${scope}`,
                                    { windowsHide: true, stdio: 'ignore', timeout: 20000 });
                            } catch (e) { /* not in this store */ }
                        }
                    }
                }
                const left = before.length ? listCerts() : [];

                if (!before.length) {
                    Logger.debug('No stale geo-spoof certificates present');
                } else if (!left.length) {
                    Logger.warn(`Removed ${before.length} stale self-signed ` +
                                'www.googleapis.com root certificate(s) left by an earlier build');
                } else {
                    //  Deliberately an error. A trusted root for a Google
                    //  domain that the app cannot remove is something the user
                    //  has to be told about, not a swallowed debug line.
                    Logger.error(`Could NOT remove ${left.length} of ${before.length} stale ` +
                                 'self-signed www.googleapis.com root certificate(s) -- ' +
                                 'remove them by hand in certmgr.msc under Trusted Root ' +
                                 'Certification Authorities', { thumbprints: left });
                }
            } catch(e) { Logger.warn('cert purge: ' + e.message.split('\n')[0]); }
            //  Dead scripts from the same abandoned experiment.
            //  fp_geocert_clean.ps1 matched certificates by FriendlyName,
            //  which is empty on the ones it was meant to remove -- so it
            //  never worked either. fp_cert_purge.ps1 is a leftover of the
            //  purge above, which now runs inline instead of from a file.
            for (const f of ['geospoof.pfx', 'geospoof.cer', 'fp_geocert.ps1', 'fp_geoserver.ps1',
                             'fp_geocert_clean.ps1', 'fp_cert_purge.ps1']) {
                try {
                    const p = getScriptPath(f);
                    if (fs.existsSync(p)) { fs.unlinkSync(p); Logger.debug('Deleted stale ' + f); }
                } catch(e) {}
            }
            //  Drop a geolocation BLOCK policy left behind by an older
            //  build. BOTH values matter: DefaultGeolocationSetting=2 on
            //  its own, or the GeolocationBlockedForUrls wildcard on its
            //  own, is enough to keep every map and "near me" site on this
            //  machine broken while the VPN is not even running -- and
            //  because a policy rule outranks the user's own choice, their
            //  Location control stays greyed out so they cannot fix it
            //  themselves.
            //
            //  Nothing in this app writes those values any more. This is
            //  pure cleanup, and a no-op once there is nothing to remove.
            geoEngine().clearBlockingPolicy();
            //  Same for our own force-install entry. If the app was killed
            //  while connected it still points at a loopback port nothing
            //  is listening on, so Edge would report a failing install on
            //  every start -- and a force-installed extension cannot be
            //  removed by the user, which makes leaving it behind worse
            //  than useless.
            try { geoExt().restore(); } catch(e) {}
            Logger.success('Startup cleanup complete');
        } catch(e) { Logger.error('Startup cleanup failed', { err: e.message }); }
    }

    // ── First-run verification ────────────────────────────
    function firstRunCheck() {
        const torExePath = path.join(torDir, 'tor.exe');
        if (!fs.existsSync(torExePath)) {
            Logger.warn('First-run: tor.exe not found', { path: torExePath });
        } else {
            Logger.success('First-run: tor.exe found');
        }

        // Self-heal firewall rule
        try {
            const fwOut = execSync(
                'netsh advfirewall firewall show rule name="FreeProxy Tor Engine"',
                { windowsHide: true, encoding: 'utf8' }
            );
            if (fwOut.includes('FreeProxy Tor Engine')) {
                Logger.debug('Firewall rule present');
            } else {
                throw new Error('not found');
            }
        } catch(e) {
            Logger.warn('Firewall rule missing -- adding automatically');
            const torExePath = path.join(torDir, 'tor.exe');
            try {
                execSync(
                    `netsh advfirewall firewall add rule name="FreeProxy Tor Engine" dir=out action=allow program="${torExePath}" enable=yes profile=any`,
                    { windowsHide: true }
                );
                Logger.success('Firewall rule added');
            } catch(e2) { Logger.warn('Could not add firewall rule (dev mode ok)', { err: e2.message }); }
        }
    }

    // ── Proxy bat builder ─────────────────────────────────
    //
    //  ProxyServer lists THREE entries, not just socks=.
    //
    //  The log contained repeated Tor warnings:
    //      "Socks version 22 not recognized. (did you want HTTPTunnelPort?)"
    //  0x16 is the first byte of a TLS ClientHello, so some WinINET
    //  consumer was connecting to 9050 and speaking HTTPS at it -- i.e.
    //  it read the "socks=" entry and used it as an HTTP CONNECT proxy.
    //  Tor rejected the connection, and that application then had nothing
    //  to fall back on but a direct, unproxied route.
    //
    //  Giving http=/https= their own entry pointing at Tor's
    //  HTTPTunnelPort means those apps get a proxy that actually speaks
    //  their protocol, and their traffic goes through Tor as well.
    function buildProxyBat(socksPort, httpPort, bypassList) {
        let fp = '<local>';
        if (bypassList && bypassList.trim()) {
            const parts = bypassList.split(';')
                .map(s => { const c = s.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/[\*\s]/g, ''); return c ? `*${c}*` : ''; })
                .filter(Boolean);
            if (parts.length) fp = parts.join(';') + ';<local>';
        }
        const proxyValue =
            `http=127.0.0.1:${httpPort};https=127.0.0.1:${httpPort};socks=127.0.0.1:${socksPort}`;
        return [
            '@echo off',
            `reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer /t REG_SZ /d "${proxyValue}" /f`,
            `reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD /d 1 /f`,
            `reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyOverride /t REG_SZ /d "${fp}" /f`,
        ].join('\r\n');
    }

    // ════════════════════════════════════════════════════════
    //  LEAK PROTECTION
    //
    //  DNS
    //  ---
    //  Tor's DNSPort listens on UDP. `netsh interface portproxy` -- which
    //  an earlier version used to forward 127.0.0.1:53 to Tor on 9053 --
    //  is TCP-only, so it silently forwarded nothing and every UDP query
    //  went straight out to the DHCP resolver. The only arrangement that
    //  actually works on Windows is to stop the dnscache service, let Tor
    //  bind 127.0.0.1:53 itself, and point every adapter at 127.0.0.1.
    //
    //  Crucially, the adapter DNS is only rewritten when Tor really did
    //  get port 53 (`dnsViaTor`). Pointing Windows at a 127.0.0.1:53 that
    //  nothing is listening on does not "fail safe" -- it kills all name
    //  resolution on the machine, VPN or not.
    //
    //  IPv6
    //  ----
    //  Firewall rules via `netsh advfirewall` instead of the NetSecurity
    //  PowerShell module (which timed out at 15 s on every connect and
    //  provided no protection) and instead of Disable-NetAdapterBinding
    //  (which took 36 s and ended in ETIMEDOUT in the attached log, while
    //  blocking the main process the whole time). netsh returns in
    //  milliseconds and takes effect immediately.
    // ════════════════════════════════════════════════════════
    async function applyLeakProtection({ dnsViaTor }) {
        Logger.info(`Applying leak protection (DNS via Tor: ${dnsViaTor ? 'yes' : 'no'})...`);

        const dnsLines = dnsViaTor ? [
            // Set DNS via netsh -- takes effect immediately, no restart, no
            // timing window where a browser could still read the DHCP servers.
            `for /f "tokens=3*" %%A in ('netsh interface show interface ^| findstr /i "connected"') do (`,
            // Delete ALL existing entries first, including any stale DHCP
            // secondary: a leftover secondary resolver answering some queries
            // directly is what showed up as unrelated countries in ipleak's
            // DNS test.
            `    netsh interface ipv4 delete dnsserver "%%B" all 2>nul`,
            `    netsh interface ipv4 set dnsserver "%%B" static 127.0.0.1 primary 2>nul`,
            `    netsh interface ipv6 delete dnsserver "%%B" all 2>nul`,
            `)`,
            `reg add "HKLM\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters" /v NameServer /t REG_SZ /d "127.0.0.1" /f`,
            `ipconfig /flushdns`,
        ] : [
            // Tor did not get port 53. Leave the system resolver alone --
            // browsers still resolve through the SOCKS proxy (Chromium sends
            // the hostname to the proxy, it does not resolve locally), so
            // browser DNS is unaffected; only other applications fall back
            // to the system resolver.
            `ipconfig /flushdns`,
        ];

        const bat = getScriptPath('fp_leak_on.bat');
        const content = [
            '@echo off',
            ...dnsLines,
            // ── Location: handled by the geo engine, not here ──────────
            //  This used to run `sc stop lfsvc`, three steps before the geo
            //  engine snapshots the machine -- so the snapshot recorded a
            //  service that was "already stopped" and disconnecting never
            //  started it again.
            //
            //  lib/geo-spoof.js now stops it, having first recorded whether
            //  it was running, and also denies the sensor and the
            //  app-consent store, which a bare stop does not: lfsvc is
            //  trigger-start and comes straight back the moment anything
            //  asks for a position.
            // ── IPv6: block outbound at the firewall (immediate) ───────
            //  This is what makes ipleak report no IPv6 address at all
            //  rather than an IPv6 in the wrong country. See buildTorrc().
            `netsh advfirewall firewall delete rule name="FreeProxy Block IPv6 Out" 2>nul`,
            `netsh advfirewall firewall delete rule name="FreeProxy Block IPv6 In" 2>nul`,
            `netsh advfirewall firewall add rule name="FreeProxy Block IPv6 Out" dir=out action=block remoteip=::/0 enable=yes profile=any`,
            `netsh advfirewall firewall add rule name="FreeProxy Block IPv6 In" dir=in action=block remoteip=::/0 enable=yes profile=any`,
            // ── IPv6: registry + tunnel interfaces ────────────────────
            `reg add "HKLM\\SYSTEM\\CurrentControlSet\\Services\\Tcpip6\\Parameters" /v DisabledComponents /t REG_DWORD /d 255 /f`,
            `netsh interface teredo set state disabled`,
            `netsh interface isatap set state disabled`,
            `netsh interface 6to4 set state disabled`,
        ].join('\r\n');
        await runBat(bat, content);

        //  Location is deliberately not mentioned any more: this function
        //  no longer touches it, and reportGeoCoverage() states what is
        //  really covered there, surface by surface.
        Logger.success(dnsViaTor
            ? 'Leak protection ON -- DNS locked to Tor on 127.0.0.1:53, IPv6 blocked'
            : 'Leak protection ON -- IPv6 blocked (system DNS left intact, see warning above)');
    }

    async function reverseLeakProtection() {
        Logger.info('Reversing DNS + IPv6 leak protection...');

        // Remove hosts file entries left by older builds
        const hostsPath = 'C:\\Windows\\System32\\drivers\\etc\\hosts';
        try {
            let hosts = fs.readFileSync(hostsPath, 'utf8');
            if (hosts.includes('FreeProxy VPN -- location spoof block')) {
                hosts = hosts.replace(/\r?\n# FreeProxy VPN -- location spoof block[\s\S]*?# FreeProxy VPN end/g, '');
                fs.writeFileSync(hostsPath, hosts, 'utf8');
                Logger.success('Hosts file: location API block removed');
            }
        } catch(e) { Logger.warn('Hosts file restore failed: ' + e.message); }

        const bat = getScriptPath('fp_leak_off.bat');
        const content = [
            '@echo off',
            // ── DNS: back to DHCP (netsh, immediate) ──────────────────
            `for /f "tokens=3*" %%A in ('netsh interface show interface ^| findstr /i "connected"') do (`,
            `    netsh interface ipv4 set dnsserver "%%B" dhcp 2>nul`,
            `    netsh interface ipv6 set dnsserver "%%B" dhcp 2>nul`,
            `)`,
            `reg delete "HKLM\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters" /v NameServer /f 2>nul`,
            `net start dnscache 2>nul`,
            `ipconfig /flushdns`,
            // ── Location: NOT restarted here ──────────────────────────
            //  lfsvc belongs to the geo engine, which recorded whether it
            //  was running BEFORE the connection and starts it again only
            //  if it was. Starting it unconditionally from here would
            //  switch Location ON for a user who keeps it off.
            // ── IPv6: drop the block rules and re-enable ──────────────
            `netsh advfirewall firewall delete rule name="FreeProxy Block IPv6 Out" 2>nul`,
            `netsh advfirewall firewall delete rule name="FreeProxy Block IPv6 In" 2>nul`,
            `reg add "HKLM\\SYSTEM\\CurrentControlSet\\Services\\Tcpip6\\Parameters" /v DisabledComponents /t REG_DWORD /d 0 /f`,
            `netsh interface teredo set state default`,
            `netsh interface isatap set state default`,
            `netsh interface 6to4 set state default`,
        ].join('\r\n');
        await runBat(bat, content);

        Logger.success('Leak protection OFF -- DNS and IPv6 restored');
    }

    async function killSwitchLeakLock() {
        Logger.info('Kill Switch: blocking all traffic...');
        const bat = getScriptPath('fp_ks_leak.bat');
        const content = [
            '@echo off',
            // Dead proxy port -- blocks all internet traffic
            `reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer /t REG_SZ /d "socks=127.0.0.1:9999" /f`,
            `reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD /d 1 /f`,
            // DNS locked -- dnscache stopped, Tor gone, so DNS fails safely
            `net stop dnscache /y 2>nul`,
            `for /f %%i in ('reg query "HKLM\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters\\Interfaces"') do reg add "%%i" /v NameServer /t REG_SZ /d "127.0.0.1" /f 2>nul`,
            // ── lfsvc stopped -- no WiFi geo leak, no permission error ──
            //  Stop only, never `sc config start= disabled`: disabling the
            //  start type breaks the Windows Location subsystem
            //  structurally, and browsers then show a "Location is turned
            //  off in system settings" block the user cannot clear.
            //
            //  This is the one place that still stops lfsvc directly
            //  instead of going through lib/geo-spoof.js, and that is
            //  deliberate: the Kill Switch fires when Tor has DIED, which
            //  is precisely when nothing may be restored. Fail closed.
            `sc stop lfsvc 2>nul`,
            // IPv6 disabled
            `reg add "HKLM\\SYSTEM\\CurrentControlSet\\Services\\Tcpip6\\Parameters" /v DisabledComponents /t REG_DWORD /d 255 /f`,
        ].join('\r\n');
        await runBat(bat, content);
        Logger.warn('Kill Switch LOCKED -- internet blocked, DNS locked, location blocked, IPv6 off');
    }

    //  Point the app's own window at Tor, at nothing, or at the open
    //  internet:
    //
    //      'tor'     -- SOCKS 9050, same exit as everything else
    //      'blocked' -- the dead port the Kill Switch uses
    //      'direct'  -- normal, unproxied
    //
    //  'direct' rather than 'system' is deliberate: the system proxy is
    //  what this app itself sets while connected, so inheriting it on
    //  disconnect would leave the window aimed at a Tor that is gone.
    async function setAppProxy(mode) {
        //  Resolved per-branch, not as one object literal: this is called
        //  during startup, which is before SOCKS_PORT is initialised, and
        //  an eager literal would read it for every mode and throw.
        let cfg;
        if (mode === 'tor')          cfg = { proxyRules: `socks5://127.0.0.1:${SOCKS_PORT}`, proxyBypassRules: '<local>' };
        else if (mode === 'blocked') cfg = { proxyRules: 'socks5://127.0.0.1:9999', proxyBypassRules: '<local>' };
        else                         cfg = { mode: 'direct' };
        try {
            await session.defaultSession.setProxy(cfg);
            //  Sockets opened before the switch keep their old route.
            await session.defaultSession.closeAllConnections();
            Logger.info(`App window proxy: ${mode}`);
        } catch (e) {
            Logger.warn(`Could not set app window proxy to ${mode}: ` + e.message);
        }
    }

    // ── Window creation ───────────────────────────────────
    function createWindow() {
        Logger.info('Creating BrowserWindow...');

        // Geolocation permission auto-grant
        session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
            callback(true);
        });
        session.defaultSession.setPermissionCheckHandler(() => true);

        mainWindow = new BrowserWindow({
            width: 1000, height: 670, resizable: false, autoHideMenuBar: true,
            icon: path.join(__dirname, 'icon.png'),
            webPreferences: { nodeIntegration: true, contextIsolation: false }
        });
        mainWindow.loadFile('index.html');
        Logger.success('BrowserWindow ready');

        mainWindow.webContents.setWindowOpenHandler(({ url }) => {
            if (url.startsWith('http')) { shell.openExternal(url); return { action: 'deny' }; }
            return { action: 'allow' };
        });
        mainWindow.webContents.on('will-navigate', (e, url) => {
            if (url.startsWith('http') && !url.includes('localhost')) {
                e.preventDefault(); shell.openExternal(url);
            }
        });
    }

    // ── WebSocket server ──────────────────────────────────
    const wss = new WebSocket.Server({ port: 8080 });
    Logger.info('WebSocket server started on :8080');

    let appState = { connected: false, serverCode: 'us', killSwitch: false, bypassList: '',
                     servers: {}, since: null };

    //  The most recent connection-progress record, kept so a popup that
    //  opens in the middle of a 30-second bootstrap can be told where it
    //  is instead of showing an idle Connect button.
    let lastProgress = null;

    //  The question currently on screen, for the same reason: a popup opened
    //  while the app window is showing "no exit node in that country" must show
    //  that question too, not an idle Connect button. Declared here, next to
    //  lastProgress, because stateForWire() below publishes it. See askUser().
    let lastAsk = null;

    //  What goes over the WebSocket to the browser extension.
    //
    //  appState.serverCode is the country main.js has EXTERNALLY VERIFIED
    //  the exit to be in, so the coordinates are derived from it here
    //  rather than stored separately -- that way the location a page
    //  reports can never drift away from the IP it can see, which is
    //  precisely the mismatch the ipleak.net test exposed.
    function stateForWire() {
        const coord = appState.connected
            ? GEO_COORDS[(appState.serverCode || '').toLowerCase()]
            : null;
        return {
            ...appState,
            //  `busy` is what makes the popup disable its own controls while
            //  a connect is in flight -- the same thing the app window does.
            //  It rides on STATE_SYNC as well as on PROGRESS so a popup that
            //  opens mid-connect learns it from its very first message.
            busy: !!appState.busy,
            progress: lastProgress,
            ask: lastAsk,
            geo: coord ? {
                lat: coord.lat, lng: coord.lng, accuracy: coord.accuracy,
                city: coord.city, cc: (appState.serverCode || '').toUpperCase(),
            } : null,
        };
    }

    function broadcastState() {
        const msg = JSON.stringify({ type: 'STATE_SYNC', state: stateForWire() });
        wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
    }

    //  A separate message type, not a STATE_SYNC: progress arrives about
    //  twenty times per connect and carries no authoritative state.
    //  Folding it into STATE_SYNC would make the extension rewrite its
    //  proxy settings and its geolocation record on every tick.
    function broadcastProgress(p) {
        const msg = JSON.stringify({ type: 'PROGRESS', progress: p });
        wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
    }

    //  For the progress records sent from outside establishConnection().
    //  Same two surfaces, same busy rule as its inner sendProgress(): the
    //  only phase still in flight is 'connecting', and every other status is
    //  an outcome that must release the popup's controls.
    function progressToAll(wc, p) {
        wc?.send('connection-progress', p);
        appState.busy = p.status === 'connecting';
        lastProgress  = p;
        broadcastProgress(lastProgress);
    }

    // ════════════════════════════════════════════════════════
    //  ASKING THE USER  --  one question, both surfaces, one answer
    //
    //  The app used to decide for itself what to do when the country the user
    //  chose had no exit relay: it connected them to whatever country it could
    //  reach and put the substitution in the status line. That is the wrong
    //  default. Which country the traffic comes out of is the entire reason
    //  someone picked one, and silently supplying a different one is a decision
    //  that belongs to the person using the app.
    //
    //  So the connect stops and asks. This is the channel it asks over, and it
    //  has to satisfy three things the rest of the app already guarantees:
    //
    //    * BOTH SURFACES. The app window and the browser extension popup are
    //      two views of one connect. A question that only reached one of them
    //      would leave the other showing a progress bar that never moves, so
    //      the question goes to the window over IPC and to every popup over the
    //      WebSocket, and the first answer from either wins.
    //    * A POPUP OPENED LATE STILL SEES IT. `lastAsk` rides on stateForWire()
    //      the same way lastProgress does, so a popup opened while the question
    //      is on screen in the app window shows the same question instead of an
    //      idle Connect button.
    //    * IT CAN ALWAYS BE ANSWERED. If there is no window and no popup there
    //      is nobody to ask, and blocking forever would hang the connect with
    //      no way out -- so with no surface at all it resolves to the caller's
    //      stated default immediately. A timeout does the same thing.
    //
    //  Nothing here decides anything. It carries a question one way and one of
    //  the caller's own option ids back.
    // ════════════════════════════════════════════════════════
    let askSeq  = 0;
    const pendingAsks = new Map();

    function broadcastAsk(ask) {
        const msg = JSON.stringify({ type: 'ASK', ask });
        wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
    }

    //  @param question {{title, body, options: [{id, label, hint}], note?, variant?}}
    //  @returns {{ id, answered: Promise<string|null>, close: () => void }}
    //
    //  Two shapes come out of this. askUser() below is the ordinary one: put a
    //  question up, wait for the answer. openAsk() is for the case where the
    //  code that asked may also want to TAKE THE QUESTION DOWN -- "waiting for
    //  an exit node in Luxembourg, stop waiting?" has to disappear by itself
    //  the moment the wait succeeds, or the user is left looking at a Stop
    //  button for something that already finished.
    function openAsk(question, { timeoutMs = 0, defaultAnswer = null } = {}) {
        const wc  = BrowserWindow.getAllWindows()[0]?.webContents;
        const ids = (question.options || []).map(o => o.id);
        const ask = { ...question, id: 'ask' + (++askSeq) };

        if (!wc && !wss.clients.size) {
            Logger.warn('No window and no popup to ask -- using the default answer',
                        { question: ask.title, answer: defaultAnswer });
            return { id: ask.id, answered: Promise.resolve(defaultAnswer), close() {} };
        }

        Logger.info(`Asking the user: ${ask.title}`, { options: ids });
        let close = () => {};
        const answered = new Promise(resolve => {
            const finish = raw => {
                if (!pendingAsks.has(ask.id)) return;          // already answered
                clearTimeout(pendingAsks.get(ask.id).timer);
                pendingAsks.delete(ask.id);
                //  Only ever one of the ids the caller offered, never a string
                //  off the wire. An unknown answer is the default.
                const answer = ids.includes(raw) ? raw : defaultAnswer;
                if (lastAsk && lastAsk.id === ask.id) lastAsk = null;
                wc?.send('ask-user-close', { id: ask.id });
                broadcastAsk(null);
                broadcastState();
                Logger.info(`Answer: ${answer}`, { question: ask.title, raw });
                resolve(answer);
            };

            const timer = timeoutMs ? setTimeout(() => {
                Logger.warn(`Question timed out after ${Math.round(timeoutMs / 1000)}s -- ` +
                            `using ${defaultAnswer}`, { question: ask.title });
                finish(defaultAnswer);
            }, timeoutMs) : null;
            //  unref: a question waiting for an answer must not be the reason
            //  the process cannot exit.
            timer?.unref?.();

            close = () => finish(defaultAnswer);
            pendingAsks.set(ask.id, { finish, timer });
            lastAsk = ask;
            wc?.send('ask-user', ask);
            broadcastAsk(ask);
            broadcastState();
        });
        return { id: ask.id, answered, close: () => close() };
    }

    function askUser(question, opts) {
        return openAsk(question, opts).answered;
    }

    ipcMain.on('ask-user-answer', (event, d) => {
        pendingAsks.get(d?.id)?.finish(d?.answer);
    });

    //  The window's equivalent of `ask` riding on stateForWire() for popups: a
    //  renderer that reloaded (or was slower to start than the question) asks
    //  for whatever is still on the table. Without it a reload during the
    //  country-unavailable dialog would leave the engine waiting on an answer
    //  from a dialog that no longer exists on screen.
    ipcMain.handle('get-pending-ask', () => lastAsk);

    //  Every question is dropped when the process is going down or the tunnel
    //  is torn down underneath it, so nothing is left waiting on a dialog whose
    //  window has gone.
    function cancelAllAsks(answer = null) {
        for (const [, rec] of [...pendingAsks]) rec.finish(answer);
    }

    wss.on('connection', ws => {
        Logger.debug('Extension WS client connected');
        ws.send(JSON.stringify({ type: 'STATE_SYNC', state: stateForWire() }));
        ws.on('message', async raw => {
            const d = JSON.parse(raw);
            if (d.command === 'PING') return;
            //  Answered BEFORE the no-window guard below: a question can be put
            //  to a popup while the app window is closed to the tray, and an
            //  answer that got dropped there would leave the connect waiting
            //  for a dialog nobody can see any more. askUser() validates the id
            //  and the option, so nothing off the wire decides anything here.
            if (d.command === 'ASK_ANSWER') {
                pendingAsks.get(d.id)?.finish(d.answer);
                return;
            }
            const wc = BrowserWindow.getAllWindows()[0]?.webContents;
            if (!wc) return;
            if      (d.command === 'CONNECT')       wc.send('force-connect-ui');
            else if (d.command === 'DISCONNECT')    wc.send('force-disconnect-ui');
            else if (d.command === 'CHANGE_SERVER') {
                //  Connected: this is a switch, not a re-label. Writing
                //  serverCode here would make stateForWire() hand the browser
                //  the new country's coordinates while the exit IP still
                //  belongs to the old one. force-switch-ui runs the app
                //  window's own verified switch, and establishConnection()
                //  sets serverCode once the new exit has been confirmed.
                if (appState.connected) {
                    appState.busy = true; broadcastState();
                    wc.send('force-switch-ui', d.server);
                } else {
                    appState.serverCode = d.server;
                    wc.send('sync-ui-state', appState); broadcastState();
                }
            }
            else if (d.command === 'TOGGLE_KS')     { appState.killSwitch = d.enabled; wc.send('sync-ui-state', appState); broadcastState(); }
            else if (d.command === 'UPDATE_BYPASS') { appState.bypassList = d.list; wc.send('sync-ui-state', appState); broadcastState(); }
        });
        ws.on('close', () => Logger.debug('Extension WS disconnected'));
    });

    // ── Startup sequence ──────────────────────────────────
    startupCleanup();
    setupWritableTor();
    firstRunCheck();
    setAppProxy('direct');
    createWindow();

    // ── App close ─────────────────────────────────────────
    app.on('window-all-closed', async () => {
        Logger.info('window-all-closed -- cleanup...');
        //  Anything still waiting on an answer will never get one now. Released
        //  as a cancel so the connect that is blocked on it unwinds through its
        //  own cancel path -- which is what restores this PC below -- instead of
        //  sitting on an unresolved promise while the process is torn down.
        stopExitWatcher();
        cancelAllAsks('cancel');
        //  Awaited: clearGeolocationSpoof now hands back the PowerShell
        //  promise that removes the browser proxy/DNS/WebRTC policies. Not
        //  waiting for it here would let app.quit() kill the script and
        //  leave the whole machine pointed at a Tor that is gone.
        try { if (mainWindow) await clearGeolocationSpoof(mainWindow); }
        catch (e) { Logger.warn('Geo/policy restore on exit: ' + e.message); }
        try {
            killTor();
            await runBat(getScriptPath('fp_exit.bat'), [
                '@echo off',
                `reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD /d 0 /f`,
                `reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer /t REG_SZ /d "" /f`,
            ].join('\r\n'));
            await reverseLeakProtection();
        } catch(e) { Logger.error('Exit cleanup error', { err: e.message }); }
        // Restore hosts file on exit
        const hostsPathExit = 'C:\\Windows\\System32\\drivers\\etc\\hosts';
        try {
            let hosts = fs.readFileSync(hostsPathExit, 'utf8');
            if (hosts.includes('FreeProxy VPN -- location spoof block')) {
                hosts = hosts.replace(/\r?\n# FreeProxy VPN -- location spoof block[\s\S]*?# FreeProxy VPN end/g, '');
                fs.writeFileSync(hostsPathExit, hosts, 'utf8');
            }
        } catch(e) {}
        Logger.info('Goodbye.');
        if (process.platform !== 'darwin') app.quit();
    });

    // ════════════════════════════════════════════════════════
    //  IPC HANDLERS
    // ════════════════════════════════════════════════════════
    ipcMain.handle('get-log-lines', async (e, { n, level }) => ({
        lines: Logger.tail(n || 400, level || 'ALL'), logFile: Logger.getLogFile()
    }));
    ipcMain.handle('open-log-folder', async () => { shell.openPath(Logger.getLogDir()); });
    //  The one-time browser setup folder: the staged extension plus the
    //  instructions. Chrome and Brave refuse every automatic install route,
    //  so this has to be reachable from the UI and not only from a log line.
    ipcMain.handle('open-geo-ext-folder', async () => {
        try {
            const err = await shell.openPath(geoExt().baseDir);
            return { ok: !err, dir: geoExt().baseDir, err: err || null };
        } catch (e) { return { ok: false, dir: null, err: e.message }; }
    });
    ipcMain.handle('get-fastest-server', async () => ({ best: 'sg', others: ['hk', 'jp'] }));

    // ── Where the globe may draw a ring ───────────────────────
    //
    //  ONE coordinate table. The globe used to carry its own 96-entry copy,
    //  which had drifted: it was missing md, cy, cr and sc, so selecting
    //  Moldova flew the rocket to 0,0 and pulsed a ring in the Gulf of Guinea
    //  while the app was genuinely spoofing Chisinau. Whatever GEO_COORDS says
    //  is what gets spoofed, so it has to be what gets drawn too -- the ring
    //  is then the spoofed position by construction rather than by agreement.
    //  Country NAMES are not sent: every other surface in the app derives them
    //  from Intl.DisplayNames, and a second list of names would drift the same
    //  way the coordinates did.
    ipcMain.handle('get-geo-coords', async () => GEO_COORDS);

    //  The user's own position, for the "Standing by in <city>" ring. Asked
    //  once per run and then remembered: it cannot change while the app is
    //  open, and asking twice is one more request carrying the real IP.
    //
    //  Two states in which this DOES NOT ASK, and says which:
    //
    //  killswitch -- the kill switch is the promise that nothing gets to grab
    //      an IP or a DNS name from this device. An IP-geolocation lookup is
    //      exactly such a grab, made to a third party, so it is not made. The
    //      globe captions that honestly instead of blaming a dead API.
    //  connected  -- while the tunnel is up this would leave the machine
    //      OUTSIDE it. Node's https.get does not read the Windows proxy the
    //      app sets, so the request would carry the real IP at the one moment
    //      the user is relying on it being hidden. It is also pointless: the
    //      globe is showing the exit country then, not home.
    let homeLoc = null;
    ipcMain.handle('get-home-location', async () => {
        if (appState.killSwitch)
            return { ok: false, reason: 'killswitch', loc: null };
        if (appState.connected)
            return { ok: false, reason: 'connected', loc: homeLoc };
        if (homeLoc) return { ok: true, reason: 'cached', loc: homeLoc };
        const loc = await lookupHomeLocation({ timeoutMs: 6000, log: m => Logger.info(m) });
        if (!loc) return { ok: false, reason: 'no-answer', loc: null };
        homeLoc = loc;
        return { ok: true, reason: 'fresh', loc };
    });

    //  The window restores the kill-switch toggle from localStorage on every
    //  launch and used to keep that to itself, so main -- and therefore the
    //  extension popup's mirror of it, and the guard immediately above --
    //  believed the kill switch was OFF on a fresh start no matter what the app
    //  was showing the user. This records the restored value and does nothing
    //  else: deliberately NOT the firewall and proxy work that
    //  toggle-killswitch does, because nothing about the machine has changed at
    //  that point, only main's knowledge of what the user asked for.
    ipcMain.handle('report-killswitch', async (event, isEnabled) => {
        appState.killSwitch = !!isEnabled;
        Logger.info('report-killswitch (state only, no system change)',
                    { killSwitch: appState.killSwitch });
        broadcastState();
        return { status: 'noted', killSwitch: appState.killSwitch };
    });

    // ════════════════════════════════════════════════════════
    //  TOR ENGINE -- ONE implementation, shared by connect and switch
    //
    //  The app used to carry TWO independent connect engines:
    //  connect-vpn had buildTorrc/queryGeoAPI/verifyAndFixExitCountry,
    //  switch-vpn had mkTorrc/swQueryGeoAPI/swGetActualExitCountry. They
    //  drifted -- only one of them ever wrote a ControlPort, they used
    //  different timeouts, and neither pinned an exit relay -- so a fix
    //  applied to one silently did not apply to the other. Both handlers
    //  now call establishConnection() and there is a single torrc builder.
    // ════════════════════════════════════════════════════════
    const SOCKS_PORT         = 9050;
    const HTTP_PORT          = 9080;   // HTTPTunnelPort, see buildProxyBat()
    const CTRL_PORT          = 9051;
    const DNS_PORT           = 53;
    const DNS_FALLBACK_PORT  = 9053;

    let torProc       = null;
    let torCtl        = null;
    let dnsViaTor     = false;
    let activeDnsPort = DNS_PORT;
    let lastNewnymAt  = 0;
    let guardTimer    = null;    // circuit-lock watchdog
    let guardFp       = null;    // the one exit relay allowed while connected

    //  Which relay actually turned out to be in which country, remembered
    //  across runs. A second connect to a country the app has already
    //  verified skips the whole search.
    const exitStore  = new ExitStore(getScriptPath('exit-cache.json'), Logger);
    const relayIndex = new RelayIndex(Logger);

    function torPaths() {
        const torParent = path.dirname(torDir);
        const torData   = path.join(torParent, 'data');
        return {
            torExe: path.join(torDir, 'tor.exe'),
            torData,
            geoip:  path.join(torData, 'geoip'),
            geoip6: path.join(torData, 'geoip6'),
            torrc:  getScriptPath('torrc'),
            cookie: path.join(torData, 'control_auth_cookie'),
            lyre:   path.join(torDir, 'pluggable_transports', 'lyrebird.exe'),
        };
    }

    // ── torrc ─────────────────────────────────────────────────────────
    //  `exitSpec` is written verbatim into ExitNodes. Normally a single
    //  "$FINGERPRINT" -- one relay, so web traffic and DNS leave through
    //  the same IP. "{cc}" is used only when no relay list is available.
    function buildTorrc({ exitSpec, useBridges = false, dnsPort = DNS_PORT }) {
        const P = torPaths();
        //  Tor's quoted-string parser treats "\P" as an escape sequence and
        //  refuses to load the file ("Invalid escape sequence in quoted
        //  string"), so Windows paths must be written with forward slashes.
        //  tor logs "path is relative" for those, but --verify-config from
        //  three different working directories confirms it resolves to the
        //  same absolute path every time -- the warning is cosmetic.
        const q = s => s.replace(/\\/g, '/');

        const lines = [
            // ── Listeners ────────────────────────────────────────────
            //  NoIPv6Traffic on EVERY listener is the fix for the
            //  "IPv4 = Luxembourg, IPv6 = Switzerland-Bern" split.
            //  Tor sets BEGIN_FLAG_IPV6_OK on a stream only when the
            //  listener that accepted it permits IPv6, so with this in
            //  place an exit can never answer from its IPv6 address --
            //  and FranTech's 2605:6400:30::/48, which carries most of
            //  Luxembourg's exit capacity, geolocates to Bern.
            //  ClientUseIPv6 0 alone did NOT cover this: it only governs
            //  the client-to-guard hop, not the exit-to-website hop.
            //
            //  NoPreferIPv6Automap keeps AutomapHostsOnResolve handing out
            //  IPv4 virtual addresses. The "PreferIPv6Automap 0" spelling
            //  is rejected by tor 0.4.9.6 ("Unrecognized SocksPort option
            //  '0'") -- these are bare flags, not key/value pairs.
            `SocksPort 127.0.0.1:${SOCKS_PORT} IPv4Traffic NoIPv6Traffic NoPreferIPv6Automap`,
            //  HTTPTunnelPort exists because the log recorded
            //      "Socks version 22 not recognized. (did you want HTTPTunnelPort?)"
            //  0x16 is a TLS ClientHello: some WinINET consumer was using
            //  9050 as an HTTP CONNECT proxy. Tor rejected it and that app
            //  had nothing to fall back on but an unproxied direct route.
            `HTTPTunnelPort 127.0.0.1:${HTTP_PORT} IPv4Traffic NoIPv6Traffic`,
            `DNSPort 127.0.0.1:${dnsPort} IPv4Traffic NoIPv6Traffic`,
            // ── Control port: cookie auth, loopback only ─────────────
            //  Lets us re-pin the exit with SETCONF in about a second
            //  instead of killing tor.exe, deleting the consensus cache
            //  and hoping 12 s was enough to re-download 9600 descriptors.
            `ControlPort 127.0.0.1:${CTRL_PORT}`,
            `CookieAuthentication 1`,
            `CookieAuthFile "${q(P.cookie)}"`,
            // ── Addressing ───────────────────────────────────────────
            `ClientUseIPv4 1`,
            `ClientUseIPv6 0`,
            `AutomapHostsOnResolve 1`,
            `VirtualAddrNetworkIPv4 10.192.0.0/10`,
            `ClientRejectInternalAddresses 1`,
            `DataDirectory "${q(P.torData)}"`,
            `GeoIPFile "${q(P.geoip)}"`,
            `GeoIPv6File "${q(P.geoip6)}"`,
            // ── Exit pinning ─────────────────────────────────────────
            `ExitNodes ${exitSpec}`,
            `StrictNodes 1`,
            //  ONE EXIT IP for the whole session, for web traffic AND DNS.
            //  Per-stream exit rotation is what produced simultaneous DNS
            //  answers from Slovakia, the USA, Germany and Finland.
            //
            //  But "one exit IP" and "one circuit" are not the same thing,
            //  and conflating them cost real speed. When exitSpec is a single
            //  fingerprint ($FP) every circuit Tor builds ends at that same
            //  relay, so letting it build a NEW one cannot change the address
            //  a website sees -- it only changes the guard and middle hop.
            //  That is the difference between being stuck behind one slow
            //  middle relay for an hour and moving off it in ten minutes,
            //  with no new CAPTCHA, because the IP never changed.
            //
            //  When there is no relay index and the spec is a country set
            //  ({cc}), rotation CAN land on a different exit in that country
            //  and change the IP, so the long dirtiness stays for that case.
            ...(exitSpec.startsWith('$')
                ? [`MaxCircuitDirtiness 600`, `NewCircuitPeriod 120`]
                : [`MaxCircuitDirtiness 3600`, `NewCircuitPeriod 600`]),
            `LongLivedPorts ${SOCKS_PORT},${HTTP_PORT}`,
            `CircuitBuildTimeout 60`,
            // ── Throughput and latency ───────────────────────────────
            //  Send the request without waiting for the exit to confirm the
            //  TCP connect. Saves one full circuit round-trip -- roughly a
            //  third of a second on a three-hop path -- on EVERY request a
            //  page makes. The consensus has had this on by default for
            //  years; naming it means it cannot be switched off underneath
            //  the app by a consensus parameter change.
            `OptimisticData 1`,
            //  Three primary guards instead of one. The first hop is a hard
            //  ceiling on every circuit through it, so a single slow guard
            //  makes the whole tunnel slow no matter how fast the exit is,
            //  and with one guard there is nothing to move to. The cost is
            //  honest and worth stating: more guards over time means more
            //  chance of eventually using a hostile one, which is why Tor's
            //  own default is fewer. Three is the value Tor used as its
            //  default for years, not an invented number.
            `NumEntryGuards 3`,
            //  Detach a stream that has not connected in 20 s and try again
            //  on another circuit. With the exit pinned by fingerprint the
            //  retry goes to the SAME exit over a different path, so this
            //  costs nothing and rescues the case the log kept showing: one
            //  bad middle relay leaving a page loading forever.
            `CircuitStreamTimeout 20`,
            //  Fewer state-file writes. On Windows every one of them is a
            //  file Defender's real-time scanner opens, and those stalls land
            //  in the middle of circuit handling.
            `AvoidDiskWrites 1`,
            //
            //  DELIBERATELY NOT SET: ReducedConnectionPadding / ConnectionPadding 0.
            //  They do buy a little bandwidth back, but padding is what stops
            //  a netflow record of this machine's connection to its guard from
            //  showing the shape of the browsing inside it. Page loads are
            //  slow because of relay capacity and round-trips, not because of
            //  padding cells, so this app pays the padding and keeps the
            //  protection.
            `Log notice stderr`,
        ];

        if (useBridges && fs.existsSync(P.lyre)) {
            lines.push(`UseBridges 1`);
            lines.push(`ClientTransportPlugin obfs4 exec "${q(P.lyre)}"`);
            lines.push(`Bridge obfs4 146.57.248.225:22 10A6CD36A537FCE513A322361547444B393989F0 cert=K1gAVGcKRMVJaRJGaFoMK0IQWY9HfRRmRPf6VWB7uIKwFoiX3y7GFhRvmFMKOgA3FScOQ iat-mode=0`);
            lines.push(`Bridge obfs4 109.105.109.165:10527 8DFCD8FB3285E855F5A55BDCD4E1DB1AEDB3F8B6 cert=XCHbbbz2aO5B8iVKQV+sNqz8CxCaU7FHWNiQyPFKXYZBiQFHpOq73VKwIq0KPrOJYA iat-mode=0`);
            lines.push(`Bridge obfs4 45.145.95.6:27015 C5B7CD6946FF10C5B3E89691A7D3F2C122D2117C cert=TD7bwPBhFCFRlSPaG/dPFRhTbT14q4ExKb0C1Jze8P7WRvDJW9nWz9wWe4xdGEi+5u5yqA iat-mode=0`);
            Logger.warn('Bridge mode: obfs4 enabled');
        }
        return lines.join('\n');
    }

    //  tor exits with status 1 on a bad config, and the old code learned
    //  that only by watching bootstrap never start and timing out 120 s
    //  later. --verify-config returns the actual parser error in ~200 ms.
    //  spawnSync with an args array, never execSync: the space in
    //  "C:\Users\User pc" is destroyed by cmd.exe's quote handling.
    function verifyTorrc(file) {
        const P = torPaths();
        try {
            const r = spawnSync(P.torExe, ['--verify-config', '-f', file], {
                cwd: torDir, windowsHide: true, encoding: 'utf8', timeout: 20000,
            });
            const out = (r.stdout || '') + (r.stderr || '');
            if (r.status === 0 && /Configuration was valid/.test(out)) return { ok: true };
            const why = (out.match(/\[(?:warn|err)\][^\r\n]*/g) || [])
                .filter(l => !/is relative and will resolve/.test(l))
                .slice(0, 4).join(' | ') || `exit ${r.status}`;
            return { ok: false, error: why };
        } catch (e) { return { ok: false, error: e.message }; }
    }

    function killTor() {
        //  Before torCtl goes away -- the guard has nothing to talk to
        //  after this, and an interval firing against a dead control port
        //  just logs noise every 15 s.
        stopCircuitGuard();
        if (torCtl)  { try { torCtl.close(); } catch (e) {} torCtl = null; }
        if (torProc) { try { torProc.kill(); } catch (e) {} torProc = null; }
        try { execSync('taskkill /F /IM tor.exe /IM lyrebird.exe', { stdio: 'ignore', windowsHide: true }); } catch (e) {}
        //  Remove the lock file only. The descriptor/consensus cache is
        //  KEPT: deleting it forced a ~9600-relay re-download that made
        //  switches take 36-64 s and sometimes stall outright.
        const P = torPaths();
        [path.join(P.torData, 'lock'), path.join(torDir, 'data', 'lock')]
            .forEach(lf => { try { if (fs.existsSync(lf)) fs.unlinkSync(lf); } catch (e) {} });
    }

    //  Resolves { ok, reason, percent }. reason is one of
    //  'ok' | 'config' | 'dns-bind' | 'stall' | 'timeout' | 'exit' | 'spawn'.
    //
    //  'dns-bind' is surfaced rather than swallowed so the caller can retry
    //  on DNSPort 9053. tor TERMINATES when a listener cannot bind, which
    //  is exactly why every attempt sat at 0% until the 120 s timeout
    //  whenever dnscache still held port 53.
    function startTor({ exitSpec, useBridges = false, dnsPort = DNS_PORT,
                        onProgress, stallMs = 40000, maxMs = 120000 }) {
        const P = torPaths();
        killTor();

        fs.writeFileSync(P.torrc, buildTorrc({ exitSpec, useBridges, dnsPort }), 'utf8');
        const check = verifyTorrc(P.torrc);
        if (!check.ok) {
            Logger.error('torrc rejected by tor --verify-config', { error: check.error });
            return Promise.resolve({ ok: false, reason: 'config', error: check.error, percent: 0 });
        }
        Logger.debug('torrc validated by tor --verify-config');

        //  Free port 53 for Tor's DNSPort. `netsh interface portproxy`
        //  cannot be used instead: it forwards TCP only, and DNS is UDP,
        //  so the earlier portproxy approach silently forwarded nothing.
        if (dnsPort === DNS_PORT) {
            try {
                spawnSync('net', ['stop', 'dnscache', '/y'],
                    { windowsHide: true, stdio: 'pipe', timeout: 15000 });
                Logger.debug('dnscache stopped -- port 53 free for Tor');
            } catch (e) { Logger.debug('dnscache stop: ' + e.message); }
        }

        Logger.info('Spawning tor.exe', { exitSpec, useBridges, dnsPort });

        return new Promise(resolve => {
            let settled  = false;
            let percent  = 0;
            let lastAt   = Date.now();
            let bindFail = null;
            let pollId   = null;
            let maxTimer = null;
            let buf      = '';

            const finish = (ok, reason, extra) => {
                if (settled) return;
                settled = true;
                if (pollId)   clearInterval(pollId);
                if (maxTimer) clearTimeout(maxTimer);
                resolve({ ok, reason, percent, ...(extra || {}) });
            };

            //  spawn(), not exec(): exec routes through cmd.exe, which
            //  mangles the -f argument when the path contains a space.
            const proc = spawn(P.torExe, ['-f', P.torrc], {
                cwd: torDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
            });
            torProc = proc;

            proc.on('error', e => {
                Logger.error('tor spawn failed', { err: e.message });
                finish(false, 'spawn', { error: e.message });
            });

            const onLine = raw => {
                const line = raw.trim();
                if (!line) return;
                if (/\[(?:err|warn)\]/.test(line)) Logger.warn('TOR: ' + line);

                const bind = /Could not bind to 127\.0\.0\.1:(\d+)/.exec(line);
                if (bind) bindFail = Number(bind[1]);

                const m = /Bootstrapped (\d+)%[^:]*:\s*(.*)/.exec(line);
                if (!m) return;
                const pct = parseInt(m[1], 10);
                const msg = m[2].trim();
                if (pct > percent) {
                    percent = pct;
                    lastAt  = Date.now();
                    Logger.info(`Bootstrap: ${pct}% -- ${msg}`);
                    if (onProgress) onProgress(pct, msg);
                }
                if (pct >= 100) finish(true, 'ok');
            };

            const onData = d => {
                buf += d.toString('utf8');
                const parts = buf.split('\n');
                buf = parts.pop() || '';
                parts.forEach(onLine);
            };
            proc.stdout.on('data', onData);
            proc.stderr.on('data', onData);

            proc.on('exit', (code, signal) => {
                if (buf.trim()) { onLine(buf); buf = ''; }
                if (!settled) Logger.warn('tor.exe exited during bootstrap', { code, signal, bindFail });
                if (bindFail) finish(false, 'dns-bind', { port: bindFail });
                else          finish(false, 'exit', { code });
            });

            pollId = setInterval(() => {
                if (settled) return;
                if (bindFail) return finish(false, 'dns-bind', { port: bindFail });
                if (Date.now() - lastAt > stallMs) {
                    Logger.error(`Bootstrap stalled at ${percent}% for ${Math.round((Date.now() - lastAt) / 1000)}s`);
                    finish(false, 'stall');
                }
            }, 1000);

            maxTimer = setTimeout(() => {
                Logger.error(`Bootstrap timed out after ${maxMs / 1000}s at ${percent}%`);
                finish(false, 'timeout');
            }, maxMs);
        });
    }

    async function openControl({ timeoutMs = 12000 } = {}) {
        if (torCtl && torCtl.isOpen) return torCtl;
        const P = torPaths();
        //  Tor writes the cookie during startup; give it a moment if the
        //  file is not there yet rather than failing the whole connect.
        for (let i = 0; i < 10 && !fs.existsSync(P.cookie); i++) {
            await new Promise(r => setTimeout(r, 300));
        }
        const ctl = new TorControl({ port: CTRL_PORT, cookiePath: P.cookie, logger: Logger });
        await ctl.open({ timeoutMs });
        torCtl = ctl;
        return ctl;
    }

    // ── Circuit lock ────────────────────────────────────────────────
    //  Keep enforcing the exit for as long as the connection lasts.
    //
    //  A single purge after SETCONF is not sufficient. A circuit sitting
    //  at EXTENDED with hops=0 has no exit to compare against yet, and Tor
    //  does not re-check ExitNodes on a circuit it has already launched --
    //  so it completes on the PREVIOUS exit a minute later and silently
    //  becomes attachable again. Observed exactly that: probes stayed in
    //  the right country for a full minute while activeExits() quietly
    //  went back to reporting two.
    //
    //  Relay churn does the same thing over a longer session. Which is
    //  why this runs on a timer instead of only at connect: "connect to
    //  Luxembourg" has to still mean Luxembourg twenty minutes later.
    function startCircuitGuard(fp) {
        stopCircuitGuard();
        if (!fp) return;
        guardFp = fp.replace(/^\$/, '').toUpperCase();
        guardTimer = setInterval(async () => {
            if (!appState.connected || !guardFp) return stopCircuitGuard();
            if (!torCtl || !torCtl.isOpen) return;
            try {
                //  staleIdMax: Number.MAX_SAFE_INTEGER -- by now every
                //  half-built circuit is old news, so any of them that is
                //  not headed for the pinned relay can go.
                const closed = await torCtl.purgeCircuitsExcept(guardFp,
                    { staleIdMax: Number.MAX_SAFE_INTEGER });
                if (closed) {
                    Logger.info(`Circuit guard: closed ${closed} circuit(s) drifting off ` +
                                `${guardFp.slice(0, 8)}`);
                }
            } catch (e) {
                Logger.debug('Circuit guard: ' + e.message);
            }
        }, 15000);
        //  Never let this keep the process alive on quit.
        if (guardTimer.unref) guardTimer.unref();
        Logger.info(`Circuit guard armed on ${guardFp.slice(0, 8)}`);
    }

    function stopCircuitGuard() {
        if (guardTimer) { clearInterval(guardTimer); guardTimer = null; }
        guardFp = null;
    }

    //  The relay list is fetched directly before a connection exists and
    //  through Tor's SOCKS port once one does. Node's global fetch()
    //  ignores the Windows proxy entirely -- that is why the log filled
    //  with "fetchJSON failed" on every refresh while connected.
    async function refreshRelayIndex({ viaTor, force = false } = {}) {
        if (relayIndex.isFresh && !force) return relayIndex;
        //  The exit-only Onionoo response runs to a few MB. socksGet's
        //  256 KB default would truncate it mid-object and JSON.parse
        //  would throw on valid data.
        const cap = 12 * 1024 * 1024;
        const fetcher = viaTor
            ? url => socksGet(url,  { socksPort: SOCKS_PORT, timeoutMs: 30000, maxBytes: cap })
            : url => directGet(url, { timeoutMs: 20000, maxBytes: cap });
        await relayIndex.refresh(fetcher);
        return relayIndex;
    }

    //  What to try, in order, for a country:
    //    1. the relay already verified for it (the fast path, and the
    //       reason reconnecting to a known country is nearly instant)
    //    2. best-scoring untried candidates from the live index, IPv4-only
    //       relays first (see exit-selector.js for why)
    //    3. plain {cc} if no relay list is reachable at all -- unverified,
    //       and reported as such rather than claimed as confirmed
    async function exitPlan(cc) {
        const plan = [];
        const cached = exitStore.getVerified(cc);
        if (cached && cached.fp) {
            plan.push({ fp: cached.fp, nick: cached.nick || '', ip: cached.ip || null, cached: true });
            Logger.info(`Using previously verified ${cc.toUpperCase()} exit: ${cached.nick || cached.fp.slice(0, 8)}`);
        }
        try {
            await refreshRelayIndex({ viaTor: appState.connected });
            for (const c of relayIndex.candidates(cc, exitStore, { limit: 5 })) {
                if (!plan.some(p => p.fp === c.fp)) plan.push({ ...c, cached: false });
            }
        } catch (e) {
            Logger.warn('Relay index unavailable -- falling back to Tor GeoIP selection', { err: e.message });
        }
        if (!plan.length) plan.push({ fp: null, nick: '', ip: null, cached: false });
        return plan;
    }

    //  Pin the exit, then CHECK IT against the same databases the user
    //  tests with. Every earlier version trusted Tor's own GeoIP answer;
    //  the report showed 104.244.79.61 -- labelled LU by both Tor and
    //  Onionoo -- geolocating to Switzerland on ipleak.net, which the app
    //  still announced as a successful Luxembourg connection.
    //
    //  Returns { verified, cc, ip, fp, reason, lastSeen }.
    //  `lastSeen` is the country/IP the traffic was ACTUALLY coming out of
    //  when the search gave up. The caller reports that instead of the
    //  requested country, so the geolocation spoof always agrees with the
    //  IP the user can see -- announcing Luxembourg over a Swiss exit is
    //  the exact inconsistency in the report.
    async function lockExitCountry(cc, plan, { repin, onProgress }) {
        const want = cc.toUpperCase();
        let answers = 0;
        let lastSeen = null;
        //  The last fingerprint ExitNodes was actually set to, whether or
        //  not it verified. The caller needs it even on failure: circuits
        //  from the candidates tried earlier are still standing, and
        //  leaving them attachable is what let one page resolve DNS
        //  through five different countries at once.
        let pinnedFp = plan.length && plan[0].fp ? plan[0].fp : null;

        for (let i = 0; i < plan.length; i++) {
            const cand = plan[i];
            const label = cand.nick ? `${cand.nick} (${cand.ip || '?'})`
                        : cand.fp  ? cand.fp.slice(0, 8)
                                   : `Tor GeoIP {${cc}}`;

            if (i > 0) {
                if (onProgress) onProgress(98, `Trying another ${want} exit (${i + 1}/${plan.length})...`);
                if (cand.fp) pinnedFp = cand.fp;
                if (!await repin(cand)) {
                    //  Could not get a circuit through this relay. Not a
                    //  geolocation failure, so only the fingerprint is
                    //  remembered -- blacklisting its whole /16 over an
                    //  unreachable host would throw away good netblocks.
                    //  And only once the verification path has been proven
                    //  to work at least once (`answers`), so a dropped
                    //  internet connection cannot blacklist every relay in
                    //  the country for the next 12 hours.
                    if (cand.fp && answers) exitStore.reject(cc, cand.fp, null);
                    continue;
                }
            }

            if (onProgress) onProgress(98, 'Confirming exit location...');
            const probe = await probeExitLocation(SOCKS_PORT, Logger, { timeoutMs: 14000 });

            if (!probe) {
                //  Nothing answered at all. This is NOT "wrong country" --
                //  conflating the two is precisely how the app came to
                //  report "Connected via LU" over a Swiss exit.
                Logger.warn(`Exit check ${i + 1}/${plan.length}: no geolocation source answered (relay ${label})`);
                if (cand.fp && answers) exitStore.reject(cc, cand.fp, null);
                continue;
            }
            answers++;
            lastSeen = { cc: probe.cc, ip: probe.ip };

            Logger.info(`Exit check ${i + 1}/${plan.length}: want=${want} got=${probe.cc} ip=${probe.ip}`,
                { votes: probe.votes, sources: probe.answered, relay: label });

            if (probe.cc === want) {
                if (cand.fp) {
                    exitStore.setVerified(cc, {
                        fp: cand.fp, nick: cand.nick || '', ip: probe.ip || cand.ip || null,
                    });
                    Logger.success(`Exit confirmed in ${want}: ${label} -- pinned for this country`);
                } else {
                    Logger.success(`Exit confirmed in ${want} (Tor GeoIP selection, no relay pinned)`);
                }
                return { verified: true, cc: want, ip: probe.ip, fp: cand.fp || null,
                         pinnedFp, lastSeen };
            }

            //  Wrong country: remember the fingerprint AND its /16. Geo
            //  databases classify whole netblocks, so once 104.244.79.61
            //  is shown to be mislabelled every 104.244.x.x relay is
            //  suspect -- rejecting the prefix makes the search converge
            //  in one or two attempts instead of grinding through 93.
            if (cand.fp) exitStore.reject(cc, cand.fp, probe.ip || cand.ip);
            Logger.warn(`Exit ${label} geolocates to ${probe.cc}, not ${want} -- rejected`);
        }

        return {
            verified: false, cc: null, ip: null, fp: null,
            reason: answers ? 'exhausted' : 'no-answer',
            pinnedFp, lastSeen,
        };
    }

    // ════════════════════════════════════════════════════════
    //  WHEN THE CHOSEN COUNTRY HAS NO EXIT NODE
    //
    //  The app used to substitute a country on its own and put the swap in the
    //  status line. Which country the traffic leaves from is the reason someone
    //  picked one, so that decision is handed back to them: three options, and
    //  the app does exactly the one they choose.
    //
    //    auto   -- connect through the NEAREST country that has a usable exit,
    //              by great-circle distance, and keep hunting for the country
    //              they actually asked for in the background (startExitWatcher)
    //    wait   -- do not connect anywhere else. Keep trying that one country,
    //              re-reading the live relay list and re-testing relays the
    //              geolocation databases had previously placed elsewhere
    //    cancel -- connect to nothing, tear the half-built tunnel back down
    //
    //  There are two moments this can be discovered, and both come here:
    //  BEFORE Tor starts (the live relay list says the country has no exit at
    //  all -- no point spending 30 s bootstrapping) and AFTER verification
    //  (relays exist and were tried, but every one of them geolocated
    //  somewhere else). The second is the honest one the old silent fallback
    //  was hiding.
    // ════════════════════════════════════════════════════════
    let REGION_NAMES = null;
    function ccName(cc) {
        const u = (cc || '').toUpperCase();
        if (!u) return '';
        try {
            REGION_NAMES = REGION_NAMES || new Intl.DisplayNames(['en'], { type: 'region' });
            return REGION_NAMES.of(u) || u;
        } catch (e) { return u; }
    }

    //  Countries this app could actually put someone in right now: they run an
    //  exit relay, at least one of those relays has not been measured in the
    //  wrong country, and GEO_COORDS has a position for them -- because the
    //  globe's ring and the coordinates handed to web pages both come from that
    //  table, and offering a country the app cannot spoof would put the ring
    //  somewhere the traffic is not.
    function exitCapacityStats() {
        const stats = spoofableOnly(relayIndex.countryStats());
        for (const cc of Object.keys(stats)) {
            if (relayIndex.available(cc, exitStore) === 0) delete stats[cc];
        }
        return stats;
    }

    //  The three-option question itself. `seenCc` is filled in on the
    //  after-verification path: naming the country the traffic DID come out of
    //  is the difference between "we could not do it" and a number the user can
    //  check on ipleak.net themselves.
    //
    //  No timeout and no default: this question has no safe answer to guess.
    //  Guessing 'auto' is the silent substitution that is being removed;
    //  guessing 'cancel' would throw away a tunnel someone is waiting for. If
    //  every surface disappears while it is up, openAsk() resolves null and the
    //  caller treats that as a cancel -- see the callers.
    async function askCountryUnavailable(cc, { seenCc = null, nearest = null, note = null } = {}) {
        const want = ccName(cc);
        const near = nearest ? `${ccName(nearest.cc)}, about ${nearest.km} km away` : null;
        return askUser({
            variant: 'choice',
            cc,
            title: `No exit node available in ${want}`,
            //  Carries what a previous round of this same question already
            //  tried and failed, so "let the app choose" is never offered a
            //  second time as though it were untried.
            note,
            body: seenCc
                ? `Every ${want} exit relay this app could try actually came out in ` +
                  `${ccName(seenCc)} -- Tor's own country labels and the databases websites ` +
                  `use disagree about them. Nothing has been connected in ${want}.`
                : `The live Tor relay list has no usable exit relay in ${want} right now, ` +
                  `so no traffic can leave from there. Nothing has been connected.`,
            options: [
                { id: 'auto',
                  label: near ? `Connect me to the nearest country (${near})`
                              : 'Let the app choose the nearest country',
                  hint: near
                      ? `The app keeps looking for ${want} in the background and asks you ` +
                        `before moving you there.`
                      : `No neighbouring country has a usable exit either -- this may fail.` },
                { id: 'wait',
                  label: `Keep trying ${want}`,
                  hint: `Nothing is connected while this runs. The app re-reads the live relay ` +
                        `list and re-tests relays it had ruled out, until ${want} works.` },
                { id: 'cancel',
                  label: 'Cancel -- do not connect at all',
                  hint: 'The tunnel is taken back down and this PC goes back to its normal ' +
                        'connection (or stays blocked, if the Kill Switch is on).' },
            ],
        }, { defaultAnswer: null });
    }
    //  ── Stop claiming a country, without tearing the tunnel down ──
    //
    //  Called at the moment the app is about to tell the user it could not reach
    //  the country they chose: before the question goes on screen, and on every
    //  round of the "keep trying" loop.
    //
    //  WHY IT IS NOT OPTIONAL. The circuits standing at that moment end at
    //  relays that were JUST MEASURED in the wrong country, and the browser is
    //  already pointed at this Tor. Leaving them attachable would send pages out
    //  through a country the app is simultaneously saying it could not reach --
    //  which is the silent fallback again, only now with a dialog on top of it.
    //
    //  So: ExitNodes goes back to the plain country set (StrictNodes is already
    //  1 from the torrc) and every circuit that could carry a page is closed.
    //  No replacement can be built for the wrong country either, so pages fail
    //  to load while the question is up. That is the safe direction to fail in,
    //  and it is what makes "Nothing has been connected in X" true rather than
    //  just written.
    async function sealTunnel(cc) {
        if (!torCtl || !torCtl.isOpen) return false;
        try {
            await torCtl.setConf({ ExitNodes: `{${cc}}` });
            const closed = await torCtl.closeAppCircuits();
            Logger.info(`Holding: exits restricted to {${cc}}` +
                        (closed ? `, ${closed} circuit(s) closed` : '') +
                        ' -- nothing leaves this PC until this is resolved');
            return true;
        } catch (e) {
            Logger.warn('Could not hold the tunnel: ' + e.message);
            return false;
        }
    }

    //  Undo everything a half-finished connect has already done to this PC.
    //  Cancel is the only option that has to do this, and it has to do all of
    //  it: by the time verification runs, the system proxy is pointed at Tor,
    //  the adapters' DNS is pinned, the browser policies are written and the
    //  geolocation override is in place. Leaving any one of those behind after
    //  "do not connect at all" would leave the machine pointed at a Tor that
    //  is gone -- no internet, and no clue why.
    //
    //  Same sequence, same order, as the disconnect-vpn handler, including
    //  respecting the Kill Switch: if the user asked for the internet to be
    //  sealed when there is no tunnel, cancelling a connect is exactly that
    //  situation.
    async function tearDownTunnel(why) {
        Logger.info('Tearing the tunnel back down: ' + why);
        stopCircuitGuard();
        stopExitWatcher();
        try { killTor(); } catch (e) { Logger.warn('killTor: ' + e.message); }
        try { await setAppProxy(appState.killSwitch ? 'blocked' : 'direct'); }
        catch (e) { Logger.warn('setAppProxy: ' + e.message); }
        try { if (mainWindow) await clearGeolocationSpoof(mainWindow); }
        catch (e) { Logger.warn('clearGeolocationSpoof: ' + e.message); }
        try {
            if (appState.killSwitch) {
                await killSwitchLeakLock();
            } else {
                await runBat(getScriptPath('fp_disconn.bat'), [
                    '@echo off',
                    `reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD /d 0 /f`,
                    `reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer /t REG_SZ /d "" /f`,
                ].join('\r\n'));
                await reverseLeakProtection();
            }
        } catch (e) { Logger.warn('Leak-path restore: ' + e.message); }
        appState.connected = false;
        appState.since     = null;
        appState.busy      = false;
        broadcastState();
    }

    // ── "keep looking for the country I asked for" ───────────────────
    //  Option `auto` connects somewhere else, so it owes the user the country
    //  they actually wanted the moment it becomes possible. This is that debt:
    //  every 90 s, re-read the live relay list and ask Tor's own consensus
    //  whether the best candidate is really there.
    //
    //  WHAT IT CAN AND CANNOT CLAIM. It does NOT build a probe circuit and it
    //  does not geolocate anything -- doing that would mean a second exit
    //  standing next to the pinned one, which is the "5 DNS servers in 5
    //  countries" bug. So the popup says the exit APPEARS available; the real
    //  verification is the switch itself, and if that switch then fails to
    //  verify, the app says so and stays where it is. Nothing is claimed that
    //  has not been measured.
    //
    //  Every 5th round the country's reject list is cleared. Those rejections
    //  are real measurements, but they are measurements of what a geolocation
    //  database said an hour ago -- the databases are exactly what changes when
    //  a relay's country becomes correct, so a permanent rejection would make
    //  "keep looking" a lie. This is the "sob vabe try korte thakbe" the user
    //  asked for, spent on the one country they chose.
    let exitWatchTimer = null, exitWatchFor = null, exitWatchBusy = false, exitWatchRound = 0;

    function stopExitWatcher() {
        if (exitWatchTimer) { clearInterval(exitWatchTimer); exitWatchTimer = null; }
        exitWatchFor = null; exitWatchBusy = false; exitWatchRound = 0;
    }

    function startExitWatcher(wantCc) {
        stopExitWatcher();
        if (!wantCc || !GEO_COORDS[wantCc]) return;
        exitWatchFor = wantCc;
        Logger.info(`Still looking for ${wantCc.toUpperCase()} in the background`);
        exitWatchTimer = setInterval(() => { exitWatchTick().catch(e =>
            Logger.debug('Exit watcher: ' + e.message)); }, 90000);
        if (exitWatchTimer.unref) exitWatchTimer.unref();
    }

    async function exitWatchTick() {
        const want = exitWatchFor;
        if (!want) return stopExitWatcher();
        //  Only while a tunnel is actually up, never during another connect,
        //  and never while a question is already on screen -- two dialogs
        //  fighting over one screen is its own bug.
        if (!appState.connected) return stopExitWatcher();
        if (exitWatchBusy || appState.busy || pendingAsks.size) return;
        if (appState.serverCode === want) return stopExitWatcher();   // already there

        exitWatchBusy = true;
        try {
            exitWatchRound++;
            if (exitWatchRound % 5 === 0) exitStore.clearRejected(want);
            await refreshRelayIndex({ viaTor: appState.connected, force: true });
            const cand = relayIndex.candidates(want, exitStore, { limit: 1 })[0];
            if (!cand) return;

            //  Onionoo publishes a relay list that is minutes old. Tor's own
            //  live consensus is the cheap second opinion, and reading it costs
            //  one GETINFO -- no circuit, nothing to leak.
            if (torCtl && torCtl.isOpen) {
                const addr = await torCtl.relayAddress(cand.fp).catch(() => null);
                if (!addr) {
                    Logger.debug(`Watcher: ${want.toUpperCase()} candidate ` +
                                 `${cand.nick || cand.fp.slice(0, 8)} is not in Tor's consensus yet`);
                    return;
                }
            }

            Logger.success(`An exit relay in ${want.toUpperCase()} appears available: ` +
                           `${cand.nick || cand.fp.slice(0, 8)}`);
            const answer = await askUser({
                variant: 'choice',
                cc: want,
                title: `${ccName(want)} looks available now`,
                body: `An exit relay in ${ccName(want)} -- the country you asked for first -- ` +
                      `is back in the live relay list. You are currently connected through ` +
                      `${ccName(appState.serverCode)}. Switching re-tests the ${ccName(want)} ` +
                      `exit for real; if it fails the check, you stay where you are.`,
                options: [
                    { id: 'yes', label: `Yes, switch to ${ccName(want)} now`,
                      hint: 'The circuit is rebuilt and the new exit is verified before ' +
                            'anything reports the new country.' },
                    { id: 'no',  label: `No, stay on ${ccName(appState.serverCode)}`,
                      hint: 'The app stops offering. You can still switch any time from ' +
                            'the country list.' },
                ],
            }, { defaultAnswer: 'no' });

            if (answer !== 'yes') { stopExitWatcher(); return; }

            const from = appState.serverCode;
            stopExitWatcher();
            const wc = BrowserWindow.getAllWindows()[0]?.webContents;
            if (wc) {
                //  Routed through the app window's own dropdown path, exactly
                //  like a click and like the extension's CHANGE_SERVER, so the
                //  button, the globe and the ring all move together.
                appState.busy = true; broadcastState();
                wc.send('force-switch-ui', want);
            } else {
                //  Window closed, popup only. Do the same switch here.
                await establishConnection({
                    serverCode: want, bypassList: appState.bypassList || '',
                    isSwitch: true, oldServerCode: from, wc: null,
                });
            }
        } finally {
            exitWatchBusy = false;
        }
    }

    // ════════════════════════════════════════════════════════
    //  establishConnection -- the whole sequence, in order
    //
    //  Ordering matters and used to be wrong: applyLeakProtection() was
    //  fire-and-forget, so it rewrote adapter DNS while exit verification
    //  was already running, and verification ran against a half-configured
    //  machine. Every step is awaited here.
    // ════════════════════════════════════════════════════════
    async function establishConnection({ serverCode, bypassList = '', isSwitch = false, oldServerCode = '', wc }) {
        //  `extra` exists for exactly one fact that neither surface can work out
        //  for itself: whether a cancel left a working tunnel standing. Both
        //  surfaces show a rocket that has to blast in mid-air when a connect is
        //  cancelled -- and must NOT blast when what was cancelled was a switch
        //  away from a country that is still carrying traffic. `kept` is the
        //  difference, and it is decided in cancelConnect() below.
        const sendProgress = (pct, msg, status = 'connecting', extra = null) => {
            Logger.debug(`Progress ${pct}% [${status}] ${msg}`);
            const rec = { percent: pct, message: msg, status, serverCode, ...(extra || {}) };
            wc?.send('connection-progress', rec);
            //  The extension popup is a second window onto the same
            //  connect, so it gets the identical record. 'connecting' is the
            //  only phase still in flight; every other one is an outcome,
            //  and leaving busy set after an outcome would freeze the
            //  popup's buttons for good. No broadcastState() here on
            //  purpose -- see broadcastProgress().
            appState.busy = status === 'connecting';
            lastProgress  = rec;
            broadcastProgress(lastProgress);
        };

        const P = torPaths();
        if (!fs.existsSync(P.torExe)) {
            Logger.error('tor.exe not found', { path: P.torExe });
            sendProgress(0, 'Tor engine not found. Please reinstall.', 'unavailable');
            return { status: 'unavailable', serverCode, verified: false };
        }

        // ── 1. Decide which relays to try, BEFORE tearing down Tor ─────
        //  On a switch the existing connection is still up, so the relay
        //  list can be refreshed through it.
        sendProgress(3, isSwitch ? `Switching to ${serverCode.toUpperCase()}...` : 'Selecting server...');
        let plan = await exitPlan(serverCode);

        //  The country the user actually asked for. `serverCode` can be moved
        //  below -- but only ever by their own answer to the question -- and the
        //  background watcher is owed THIS country, not the substitute.
        const requestedCode = serverCode;
        let watchFor   = null;      // country to keep hunting for after connect
        let torStarted = false;     // has this attempt replaced the tunnel yet?

        //  Every country this connect has already proved it cannot deliver, so
        //  the nearest-country search never offers the same one twice.
        const tried = new Set([requestedCode]);

        //  Whether the user has ALREADY handed the choice to the app. Option 1
        //  is "let the app connect me to the nearest country that works", and it
        //  is answered once: if the nearest one then fails its own exit check,
        //  the app walks on to the next nearest by itself instead of asking the
        //  identical question about a country the user never picked. It only
        //  comes back to them when the whole search is spent.
        let autoGranted = false;

        //  Cancel, from wherever it is chosen. Two different situations, and
        //  conflating them would be its own bug:
        //
        //    * Nothing has been restarted yet AND a tunnel was already up (this
        //      is a switch). Then "cancel" means cancel the SWITCH -- the
        //      country that was working keeps working, and the app has touched
        //      nothing at all.
        //    * Anything else: connect to nothing, and put the machine back the
        //      way it was found. That is the user's literal instruction -- no
        //      country, and the rocket blasts in mid-air.
        const cancelConnect = async why => {
            Logger.warn('Connect cancelled: ' + why);
            stopExitWatcher();
            if (!torStarted && isSwitch && appState.connected) {
                sendProgress(100, `Cancelled -- still connected via ` +
                                  `${ccName(appState.serverCode)}`, 'cancelled', { kept: true });
                return { status: 'cancelled', serverCode: appState.serverCode,
                         requested: requestedCode, kept: true, reason: why };
            }
            sendProgress(99, 'Cancelling and restoring this PC...');
            await tearDownTunnel(why);
            sendProgress(100, 'Cancelled -- not connected', 'cancelled', { kept: false });
            return { status: 'cancelled', serverCode: null,
                     requested: requestedCode, kept: false, reason: why };
        };

        //  A sleep that gives up early. Every wait in here has a Stop button on
        //  screen, and a 20-second sleep that ignored it would make that button
        //  feel broken.
        const sleepUnless = async (ms, abort) => {
            for (let waited = 0; waited < ms; waited += 500) {
                if (abort()) return false;
                await new Promise(r => setTimeout(r, 500));
            }
            return !abort();
        };

        //  Option `wait`, before Tor has been started: there is no tunnel to
        //  test anything through yet, so what is waited for is the live relay
        //  list showing an exit relay in that country at all. Returns false if
        //  the user stopped waiting.
        const waitForCapacity = async cc => {
            const gate = openAsk({
                variant: 'live', cc,
                title: `Waiting for an exit node in ${ccName(cc)}`,
                body: `Nothing is connected while this runs -- no other country is being ` +
                      `used in the meantime. The app re-reads the live Tor relay list every ` +
                      `20 seconds and starts connecting the moment ${ccName(cc)} has one.`,
                options: [{ id: 'stop', label: 'Stop waiting and cancel' }],
            }, { defaultAnswer: null });
            let stopped = false;
            gate.answered.then(a => { if (a === 'stop') stopped = true; });

            for (let round = 1; !stopped; round++) {
                //  See ExitStore.clearRejected: a rejection records what a
                //  geolocation database said earlier, and those databases are
                //  exactly what changes here. Keeping them forever would make
                //  "keep trying" a lie.
                if (round % 6 === 0) {
                    const n = exitStore.clearRejected(cc);
                    if (n) Logger.info(`Re-testing ${n} previously ruled-out ${cc.toUpperCase()} relay(s)`);
                }
                sendProgress(4, `Waiting for an exit node in ${ccName(cc)} ` +
                                `(attempt ${round})...`);
                try { await refreshRelayIndex({ viaTor: false, force: true }); }
                catch (e) { Logger.debug('Relay list refresh while waiting: ' + e.message); }
                if (relayIndex.available(cc, exitStore) > 0) {
                    Logger.success(`${cc.toUpperCase()} has an exit relay again after ${round} attempt(s)`);
                    gate.close();
                    return true;
                }
                if (!await sleepUnless(20000, () => stopped)) break;
            }
            gate.close();
            return false;
        };

        // ── 1b. Is there anything in that country to connect to at all? ─
        //  exitPlan() returns a single {fp:null} entry both when the country
        //  has no exit relay AND when the relay list could not be fetched.
        //  Those are completely different statements and only the first one
        //  justifies this question -- hence the isFresh check. An unreachable
        //  Onionoo falls through to Tor's own GeoIP selection exactly as before.
        while (plan.length === 1 && !plan[0].fp && relayIndex.isFresh &&
               relayIndex.available(serverCode, exitStore) === 0) {
            Logger.warn(`No exit relay in ${serverCode.toUpperCase()} in the live relay list`);
            const nearest = nearestExitCountries(serverCode, exitCapacityStats())[0] || null;
            const choice  = await askCountryUnavailable(serverCode, { nearest });

            if (choice === 'auto' && nearest) {
                watchFor    = requestedCode;
                autoGranted = true;
                serverCode  = nearest.cc;
                tried.add(serverCode);
                Logger.info(`Connecting to the nearest available country instead: ` +
                            `${serverCode.toUpperCase()} (${nearest.km} km)`);
                sendProgress(4, `${ccName(requestedCode)} has no exit node -- ` +
                                `connecting via ${ccName(serverCode)} instead...`);
                plan = await exitPlan(serverCode);
                break;
            }
            if (choice === 'wait') {
                if (!await waitForCapacity(serverCode)) {
                    return await cancelConnect('the user stopped waiting for ' + serverCode.toUpperCase());
                }
                plan = await exitPlan(serverCode);
                continue;                       // re-check, then fall through
            }
            return await cancelConnect(
                choice === 'auto' ? 'no country near ' + serverCode.toUpperCase() + ' has a usable exit'
                                  : 'the user cancelled');
        }

        const firstSpec = plan[0].fp ? `$${plan[0].fp}` : `{${serverCode}}`;
        Logger.info(`Exit plan for ${serverCode.toUpperCase()}: ${plan.length} candidate(s)`,
            { first: plan[0].nick || plan[0].fp || `{${serverCode}}` });

        // ── 2. Start Tor, with a DNS-port fallback ─────────────────────
        sendProgress(5, 'Starting Tor engine...');
        let dnsPort = DNS_PORT;
        //  From here on the tunnel that may have been up has been replaced, so
        //  a cancel can no longer mean "keep what was working".
        torStarted = true;
        let res = await startTor({
            exitSpec: firstSpec, dnsPort,
            onProgress: (pct, msg) => sendProgress(Math.min(pct, 95), msg),
        });

        if (!res.ok && res.reason === 'dns-bind') {
            //  Something other than dnscache owns :53 (a local resolver,
            //  Docker, Pi-hole...). Retry on 9053 instead of failing --
            //  and do NOT point the adapters at 127.0.0.1 afterwards,
            //  because that would kill name resolution machine-wide.
            Logger.warn(`Port ${res.port} unavailable -- retrying with DNSPort ${DNS_FALLBACK_PORT}`);
            sendProgress(5, 'Adjusting DNS port...');
            dnsPort = DNS_FALLBACK_PORT;
            res = await startTor({
                exitSpec: firstSpec, dnsPort,
                onProgress: (pct, msg) => sendProgress(Math.min(pct, 95), msg),
            });
        }

        if (!res.ok && (res.reason === 'stall' || res.reason === 'timeout') && fs.existsSync(P.lyre)) {
            Logger.warn('Direct connection stalled -- retrying with obfs4 bridges');
            sendProgress(res.percent, 'Switching to bridge mode...');
            res = await startTor({
                exitSpec: firstSpec, dnsPort, useBridges: true,
                onProgress: (pct, msg) => sendProgress(Math.min(pct, 95), msg),
            });
        }

        if (!res.ok) {
            const why = res.reason === 'config'
                ? 'Tor configuration error. Check the log.'
                : 'Server not responding. Try another country.';
            Logger.error('Connection failed', { serverCode, reason: res.reason, percent: res.percent });
            sendProgress(res.percent, why, 'unavailable');
            killTor();
            return { status: 'unavailable', serverCode, verified: false };
        }

        dnsViaTor     = (dnsPort === DNS_PORT);
        activeDnsPort = dnsPort;

        // ── 3. Route the machine through Tor ──────────────────────────
        sendProgress(96, 'Setting up secure proxy...');
        await runBat(getScriptPath('fp_conn.bat'), buildProxyBat(SOCKS_PORT, HTTP_PORT, bypassList));
        Logger.success(`Proxy set -> SOCKS 127.0.0.1:${SOCKS_PORT}, HTTP 127.0.0.1:${HTTP_PORT}`);

        // ── 4. Close the leak paths, and WAIT for it ──────────────────
        sendProgress(97, 'Closing leak paths...');
        await applyLeakProtection({ dnsViaTor });
        if (!dnsViaTor) {
            Logger.warn('DNS is NOT routed through Tor -- port 53 was already in use. ' +
                        'Browsers still resolve remotely via the SOCKS proxy, but other ' +
                        'applications will use the system resolver.');
        }

        // ── 5. Verify the exit, re-pinning through the control port ───
        let ctl = null;
        try { ctl = await openControl(); }
        catch (e) { Logger.warn('Control port unavailable: ' + e.message); }

        //  Curried on the target country, not closed over `serverCode`: the
        //  fallback spec for a candidate with no fingerprint is `{cc}`, and the
        //  nearest-country search and the "keep trying" loop both re-pin for a
        //  country that is not the one this connect started with. Closing over
        //  serverCode would have sent them Tor's GeoIP set for the WRONG
        //  country -- the one that had just been shown to have nothing usable.
        const repinFor = target => async cand => {
            const spec = cand.fp ? `$${cand.fp}` : `{${target}}`;
            if (ctl && ctl.isOpen) {
                try {
                    //  Taken BEFORE the config change: every circuit id at
                    //  or below this was launched under the OLD ExitNodes, so
                    //  even the ones with no exit chosen yet are suspect.
                    const idMark = await ctl.maxCircuitId();

                    //  StrictNodes is already 1 in the torrc; setting it
                    //  again here only adds another way for SETCONF to fail.
                    await ctl.setConf({ ExitNodes: spec });

                    //  THE STEP THAT MAKES A COUNTRY SWITCH STICK.
                    //
                    //  ExitNodes is enforced when a circuit is BUILT, not
                    //  when a stream is attached to one. The circuits that
                    //  were already standing still end at the previous exit,
                    //  and MaxCircuitDirtiness keeps them attachable for an
                    //  hour -- so Tor hands new streams straight back to the
                    //  country we just left. Measured on a LU -> DE switch
                    //  before this call existed: the first request came out
                    //  in Germany and every request after it came out in
                    //  Luxembourg again.
                    //
                    //  NEWNYM does not cover this. It only retires circuits
                    //  that have already carried a stream, and Tor keeps a
                    //  pool of clean pre-built ones that have not. So the
                    //  offending circuits get closed by id instead.
                    if (cand.fp) await ctl.purgeCircuitsExcept(cand.fp, { staleIdMax: idMark });

                    //  NEWNYM on top, for the client-side state a circuit
                    //  purge cannot reach. Tor rate-limits it to roughly once
                    //  per 10 s and silently ignores anything faster -- it is
                    //  now SKIPPED rather than waited out, because the purge
                    //  above does the part that matters, and five candidates
                    //  x 11 s of sleeping was a minute of the user staring at
                    //  a progress bar for nothing.
                    if (Date.now() - lastNewnymAt >= 11000) {
                        await ctl.newIdentity();
                        lastNewnymAt = Date.now();
                    }

                    if (cand.fp) {
                        //  Wait for a real BUILT circuit through this relay
                        //  instead of the old blind `await sleep(12000)`.
                        const built = await ctl.waitForExit(cand.fp, { timeoutMs: 25000 });
                        if (!built) {
                            Logger.warn(`No circuit reached ${cand.nick || cand.fp.slice(0, 8)} in 25s`);
                            return false;
                        }
                        //  A circuit that was mid-build when ExitNodes changed
                        //  finishes on the OLD exit -- it was launched under
                        //  the old restriction and Tor does not re-check. So
                        //  sweep again now that the wait is over.
                        await ctl.purgeCircuitsExcept(cand.fp, { staleIdMax: idMark });
                    } else {
                        await new Promise(r => setTimeout(r, 3000));
                    }
                    return true;
                } catch (e) {
                    Logger.warn('SETCONF re-pin failed: ' + e.message);
                    ctl = null;
                }
            }
            //  No control port: restart Tor on the new exit. Slower, but
            //  the descriptor cache is preserved (the old code deleted it,
            //  which is what made the retry hopeless).
            const r = await startTor({
                exitSpec: spec, dnsPort: activeDnsPort,
                onProgress: (pct, msg) => sendProgress(Math.min(90 + Math.round(pct / 12), 97), msg),
            });
            if (!r.ok) return false;
            try { ctl = await openControl(); } catch (e) { ctl = null; }
            return true;
        };

        //  One complete attempt at a country on the tunnel that is ALREADY up:
        //  choose relays for it, pin the best one, verify where the traffic
        //  really comes out. Used by the nearest-country search and by the
        //  "keep trying" loop, so both of them prove a country the same way the
        //  originally requested one was proved.
        //
        //  The explicit first re-pin matters. lockExitCountry() only re-pins
        //  from its SECOND candidate onwards -- it assumes the first one is
        //  whatever Tor was started with, which was true for the requested
        //  country and is true for nothing reached from here. Without this line
        //  the "nearest country" attempt would verify the exit still standing
        //  for the country that just failed, and then report the nearest
        //  country over it: a fake success, in the exact shape of the bug this
        //  whole path exists to remove.
        const attemptCountry = async target => {
            const p = await exitPlan(target);
            if (!await repinFor(target)(p[0])) {
                return { verified: false, cc: null, ip: null, fp: null,
                         reason: 'unreachable', pinnedFp: p[0].fp || null, lastSeen: null };
            }
            return await lockExitCountry(target, p,
                { repin: repinFor(target), onProgress: (pc, m) => sendProgress(pc, m) });
        };

        //  Final enforcement sweep.
        //
        //  Verification opened its own connections through Tor, and Tor
        //  pre-builds spare circuits alongside them -- some launched before the
        //  last SETCONF landed. From here the browser is the only thing using
        //  this tunnel, so this is the moment to guarantee there is exactly ONE
        //  exit country left to attach to. "DNS Addresses -- 5 servers detected"
        //  in five different countries is what having more than one looks like
        //  from the outside.
        //
        //  A function rather than a straight-line block because the country
        //  being locked is no longer decided by the time verification returns:
        //  the question below can send the connect through a different country
        //  entirely, and the sweep has to run once, on whatever exit actually
        //  won.
        const finalSweep = async fp => {
            if (!ctl || !ctl.isOpen || !fp) return;
            try {
                const closed = await ctl.purgeCircuitsExcept(fp,
                    { staleIdMax: Number.MAX_SAFE_INTEGER });
                const live   = await ctl.activeExits();
                Logger.info(`Circuit lock: ${live.length} exit relay(s) in use` +
                            (closed ? `, ${closed} stale circuit(s) closed` : ''),
                            { exits: live.map(e => (e.nick || e.fp.slice(0, 8))) });
                if (live.length > 1) {
                    Logger.warn(`${live.length} distinct exits are still reachable -- ` +
                                'traffic could come out of more than one country');
                }
            } catch (e) { Logger.warn('Final circuit sweep failed: ' + e.message); }
        };

        //  Option 3 ("wait"), on the after-verification path: keep trying that
        //  one country until it verifies, or until the user stops it.
        //
        //  "joto possible chance ache sei country te connect korar sob vabe try
        //  korte thakbe" -- so every round re-reads the live relay list, and
        //  every 6th round the country's reject memory is cleared. Those
        //  rejections are real measurements, but they are measurements of what a
        //  geolocation database said minutes ago, and those databases are
        //  exactly what changes when a relay's country becomes correct. Keeping
        //  them forever would starve the retry after one pass and make "keep
        //  trying" a lie.
        //
        //  Nothing is connected while this runs, and that is enforced, not
        //  promised: sealTunnel() holds ExitNodes at {cc} with StrictNodes on
        //  and closes every attachable circuit, so pages fail to load rather
        //  than leaving from a country the app is saying it could not reach.
        //
        //  The Stop button is a 'live' ask -- a small card, not a modal -- so
        //  the progress line and the globe stay visible while it counts rounds.
        const waitForVerifiedExit = async cc => {
            const gate = openAsk({
                variant: 'live', cc,
                title: `Still trying ${ccName(cc)}`,
                body: 'Nothing is connected while this runs. The app re-reads the live ' +
                      'relay list, re-tests relays it had ruled out, and checks every ' +
                      'candidate against the same databases websites use.',
                options: [{ id: 'stop', label: 'Stop trying and cancel' }],
            }, { defaultAnswer: null });

            let stopped = false;
            gate.answered.then(a => { if (a === 'stop') stopped = true; });

            try {
                for (let round = 1; !stopped; round++) {
                    if (round % 6 === 0) {
                        const n = exitStore.clearRejected(cc);
                        if (n) Logger.info(`Re-testing ${n} previously ruled-out ` +
                                           `${cc.toUpperCase()} relay(s)`);
                    }
                    sendProgress(98, `Still trying ${ccName(cc)} (attempt ${round})...`);
                    try { await refreshRelayIndex({ viaTor: true, force: true }); }
                    catch (e) { Logger.debug('Relay list refresh: ' + e.message); }
                    if (stopped) break;

                    //  Nothing to test this round: do not spend a probe, and do
                    //  not let the log claim an attempt that never happened.
                    if (relayIndex.isFresh && relayIndex.available(cc, exitStore) === 0) {
                        Logger.debug(`No untried ${cc.toUpperCase()} exit in the list yet`);
                        if (!await sleepUnless(20000, () => stopped)) break;
                        continue;
                    }

                    const v = await attemptCountry(cc);
                    if (v.verified) return v;
                    if (stopped) break;
                    await sealTunnel(cc);          // back to holding
                    if (!await sleepUnless(20000, () => stopped)) break;
                }
            } finally { gate.close(); }
            return null;
        };

        sendProgress(98, 'Verifying exit country...');
        let verdict = await lockExitCountry(serverCode, plan,
            { repin: repinFor(serverCode), onProgress: (p, m) => sendProgress(p, m) });

        // ── 5b. Detection point B: relays existed, none was in that country ──
        //
        //  THIS IS WHERE THE SILENT FALLBACK USED TO LIVE. Every candidate came
        //  back geolocating somewhere else, and the app connected the user to
        //  that somewhere else with a parenthesis in the status line. Which
        //  country the traffic leaves from is the whole reason someone picks a
        //  country, so that decision goes back to them -- the same three options
        //  as before Tor started, plus the one fact this path has and that one
        //  does not: the country the traffic actually came out of, which they
        //  can check on ipleak.net themselves.
        //
        //  `reason === 'no-answer'` deliberately does NOT come here. Nothing was
        //  measured in that case, so there is nothing to report as unavailable;
        //  it keeps its own honest "connected, could not be verified" branch
        //  below. Conflating the two is the original sin this file is full of
        //  warnings about.
        let askNote = null;

        while (!verdict.verified && verdict.reason === 'exhausted') {
            tried.add(serverCode);
            //  Held on the country they asked for: it is the strictest hold
            //  available (nothing in it works right now, so no circuit can be
            //  built at all) and it is the honest one -- this is a pause on
            //  their request, not on the app's substitute.
            await sealTunnel(requestedCode);

            //  The question is always about the country they ASKED for. After a
            //  substitution the country this attempt is standing on is one the
            //  APP chose, and putting that name in the title would ask them
            //  about a decision they never made.
            //
            //  `seen` -- where the traffic really came out -- is only offered
            //  when it was their own country's relays that were just measured.
            //  Reporting "every Luxembourg relay came out in the Netherlands"
            //  off the back of a German attempt would be a false statement, and
            //  false statements about geolocation are the entire bug class this
            //  path exists to close.
            const failedOwn = serverCode === requestedCode;
            const seen = (failedOwn && verdict.lastSeen &&
                          /^[A-Za-z]{2}$/.test(verdict.lastSeen.cc || ''))
                ? verdict.lastSeen.cc.toLowerCase() : null;

            //  Re-read the list before offering neighbours: it is minutes old by
            //  now, and a country that has since lost its last exit must not be
            //  offered as the nearest one available.
            try { await refreshRelayIndex({ viaTor: true, force: true }); }
            catch (e) { Logger.debug('Relay list refresh: ' + e.message); }

            //  Neighbours are measured from the country they originally asked
            //  for, never from the substitute this attempt happens to be
            //  standing on -- "the nearest country to mine" does not move
            //  because the app's first guess failed.
            const near = nearestExitCountries(requestedCode, exitCapacityStats(),
                                              { exclude: [...tried] });

            const choice = (autoGranted && near.length)
                ? 'auto'
                : await askCountryUnavailable(requestedCode,
                    { seenCc: seen, nearest: near[0] || null, note: askNote });
            askNote = null;

            if (choice === 'auto') {
                if (!near.length) {
                    return await cancelConnect('no country near ' +
                        requestedCode.toUpperCase() + ' has a usable exit');
                }
                autoGranted = true;
                watchFor    = requestedCode;
                //  Nearest first, then the next nearest, and so on. The ask was
                //  for the closest country that WORKS, not the closest that
                //  exists -- so each one is verified exactly the way the
                //  requested country was, and one that fails the check is passed
                //  over silently instead of being reported as a success.
                let landed = false;
                for (const n of near.slice(0, 4)) {
                    tried.add(n.cc);
                    sendProgress(98, `${ccName(requestedCode)} is not available -- trying ` +
                                     `${ccName(n.cc)}, ${n.km} km away...`);
                    const v = await attemptCountry(n.cc);
                    if (v.verified) {
                        serverCode = n.cc;
                        verdict    = v;
                        landed     = true;
                        break;
                    }
                    Logger.warn(`${n.cc.toUpperCase()} could not be confirmed either ` +
                                `(${v.reason || 'unverified'})`);
                    await sealTunnel(requestedCode);
                }
                if (landed) break;
                //  The search is spent. Back to the user, with what was tried
                //  attached, so "let the app choose" is never offered a second
                //  time as though it were untried.
                autoGranted = false;
                askNote = 'Already tried ' +
                    [...tried].filter(c => c !== requestedCode).map(c => ccName(c)).join(', ') +
                    ' -- none of them could be confirmed either.';
                continue;
            }

            if (choice === 'wait') {
                //  Their country, not the substitute: "oi selected country te
                //  connect na houya porjonto wait" is about the one they picked.
                const v = await waitForVerifiedExit(requestedCode);
                if (v && v.verified) {
                    serverCode = requestedCode;
                    verdict    = v;
                    watchFor   = null;          // it landed; nothing left to hunt
                    break;
                }
                return await cancelConnect('the user stopped waiting for ' +
                                           requestedCode.toUpperCase());
            }

            //  'cancel', or null -- every surface disappeared while the question
            //  was up, and there is nobody left to keep a tunnel for.
            return await cancelConnect(choice
                ? 'the user cancelled' : 'no window was left to answer the question');
        }

        const lockFp = verdict.fp || verdict.pinnedFp;
        await finalSweep(lockFp);

        // ── 6. Report honestly ────────────────────────────────────────
        //  `finalCode` is the country the traffic DEMONSTRABLY comes out of,
        //  not the one that was asked for. That distinction is the whole
        //  point: the geolocation spoof below is driven by finalCode, so if
        //  the exit really is Swiss the spoofed coordinates are Swiss too.
        //  Announcing Luxembourg over a Swiss IP -- and spoofing the
        //  location to Luxembourg on top of it -- is the exact
        //  inconsistency the ipleak report exposed.
        const seenCc = verdict.lastSeen && /^[A-Za-z]{2}$/.test(verdict.lastSeen.cc || '')
            ? verdict.lastSeen.cc.toLowerCase() : null;
        let finalCode = verdict.cc ? verdict.cc.toLowerCase() : (seenCc || serverCode);

        if (verdict.verified && serverCode !== requestedCode) {
            //  A substitute country, and it says so. The old code put this in a
            //  parenthesis after the country the user asked for; the user was
            //  never asked, and the country named was not where the traffic was.
            Logger.warn(`${requestedCode.toUpperCase()} was not available -- connected via ` +
                        `${verdict.cc} at the user's request, still looking for ` +
                        requestedCode.toUpperCase());
            sendProgress(100, `Connected via ${ccName(serverCode)} -- ` +
                              `${ccName(requestedCode)} was not available`, 'connected');
        } else if (verdict.verified) {
            sendProgress(100, `Connected via ${verdict.cc}`, 'connected');
        } else if (verdict.reason === 'no-answer') {
            //  Connected, but nothing could be checked. Say so instead of
            //  displaying a country the app has no evidence for. NOT routed
            //  into the three-option question: "no geolocation source was
            //  reachable" is a transport failure, not a country that is
            //  missing, and offering to move the user somewhere else over it
            //  would be guessing.
            Logger.warn(`Could not verify exit country for ${serverCode.toUpperCase()} -- ` +
                        'no geolocation source was reachable through Tor');
            sendProgress(100, `Connected -- ${serverCode.toUpperCase()} unverified`, 'connected');
        } else {
            //  Unreachable in practice: `exhausted` is resolved by the question
            //  above, which either lands on a verified country or returns. Kept
            //  as a truthful last resort rather than a claim.
            Logger.warn(`No ${serverCode.toUpperCase()} exit could be confirmed after ${plan.length} attempt(s)`);
            sendProgress(100, `Connected -- ${serverCode.toUpperCase()} could not be confirmed`, 'connected');
        }

        appState.connected  = true;
        //  Set here, with the verified exit, not when the button was
        //  pressed: the 30 seconds of bootstrap are not connected time.
        appState.since      = Date.now();
        appState.serverCode = finalCode;
        broadcastState();

        //  Armed after appState.connected, because the guard stops itself
        //  the moment that flag is false.
        if (lockFp) startCircuitGuard(lockFp);

        //  The promise option `auto` made: keep looking for the country they
        //  actually asked for. Armed only now, with a verified substitute
        //  standing, so it can never run on top of a connect that failed --
        //  and cleared on any connect that DID land where it was asked to,
        //  so a watcher from an earlier attempt cannot outlive its reason.
        if (watchFor && finalCode !== watchFor) startExitWatcher(watchFor);
        else stopExitWatcher();

        //  Only now, with a working exit: doing it earlier would point
        //  the window at a SOCKS port that is not yet accepting.
        setAppProxy('tor');

        //  Geolocation spoofing runs AFTER the caller's promise resolves:
        //  it makes several registry/policy writes and can restart
        //  browsers, and doing that before resolving left the UI stuck on
        //  "Switching to X..." long after the tunnel was already up.
        if (mainWindow) setImmediate(() => applyGeolocationSpoof(mainWindow, finalCode));

        return {
            status:     'connected',
            serverCode: finalCode,
            requested:  requestedCode,
            //  Non-null when the connect landed somewhere other than the
            //  country that was asked for and the app is still hunting for it.
            watching:   (watchFor && finalCode !== watchFor) ? watchFor : null,
            verified:   verdict.verified,
            exitIp:     verdict.ip || verdict.lastSeen?.ip || null,
            dnsViaTor,
        };
    }

    // ── Live relay status ─────────────────────────────────
    let cachedRelays = null, lastFetchTime = 0;

    ipcMain.handle('get-realtime-status', async () => {
        const now = Date.now();
        if (cachedRelays && now - lastFetchTime < 20000) return cachedRelays;
        try {
            //  Works while connected too: refreshRelayIndex routes through
            //  Tor's SOCKS port, unlike the old Node fetch().
            await refreshRelayIndex({ viaTor: appState.connected });
            const stats = spoofableOnly(relayIndex.countryStats());
            if (Object.keys(stats).length) {
                Logger.success(`Exit relays: ${Object.keys(stats).length} countries with usable exits`);
                cachedRelays   = stats;
                appState.servers = stats;
                broadcastState();
                lastFetchTime  = now;
                return stats;
            }
        } catch (e) {
            Logger.warn('Relay list unavailable', { err: e.message });
        }
        if (cachedRelays) return cachedRelays;
        //  Fallback list. Only countries that actually run exit relays
        //  appear here: with StrictNodes 1 a country with no exit can
        //  never build a circuit, so offering it guarantees a failed
        //  connect. The old fallback listed Bangladesh and India, which
        //  have no meaningful exit capacity at all.
        Logger.warn('Using built-in exit-country fallback list');
        const fallbackServers = spoofableOnly({
            "us":{"count":600,"bandwidth":9000000000},"de":{"count":450,"bandwidth":8000000000},
            "nl":{"count":220,"bandwidth":5000000000},"fr":{"count":180,"bandwidth":4000000000},
            "gb":{"count":90,"bandwidth":2000000000}, "ca":{"count":70,"bandwidth":1500000000},
            "ch":{"count":80,"bandwidth":1800000000}, "se":{"count":70,"bandwidth":1600000000},
            "fi":{"count":60,"bandwidth":1400000000}, "at":{"count":40,"bandwidth":900000000},
            "ro":{"count":50,"bandwidth":1000000000},"pl":{"count":35,"bandwidth":700000000},
            "cz":{"count":30,"bandwidth":600000000}, "es":{"count":25,"bandwidth":500000000},
            "it":{"count":20,"bandwidth":400000000}, "lu":{"count":15,"bandwidth":300000000},
            "sg":{"count":15,"bandwidth":300000000}, "jp":{"count":20,"bandwidth":400000000},
            "dk":{"count":15,"bandwidth":300000000}, "no":{"count":15,"bandwidth":300000000},
            "be":{"count":12,"bandwidth":250000000},
            "au":{"count":12,"bandwidth":250000000}, "ua":{"count":25,"bandwidth":500000000},
            "md":{"count":12,"bandwidth":250000000}, "bg":{"count":15,"bandwidth":300000000},
            "ee":{"count":10,"bandwidth":200000000},
            "hk":{"count":8,"bandwidth":150000000}
        });
        //  Published, not just returned: the extension popup builds its country
        //  dropdown out of appState.servers, so a list the app window is showing
        //  and the popup has never heard of is the same bug as no list at all.
        //  cachedRelays is deliberately NOT set here -- a fallback must not stop
        //  the next call from trying the real relay index again.
        appState.servers = fallbackServers; broadcastState();
        return fallbackServers;
    });

    // ════════════════════════════════════════════════════════
    //  CONNECT VPN
    // ════════════════════════════════════════════════════════
    ipcMain.handle('connect-vpn', async (event, data) => {
        const { serverCode, bypassList = '' } = data;
        Logger.info('connect-vpn', { serverCode });
        const wc = BrowserWindow.getAllWindows()[0]?.webContents;
        try {
            return await establishConnection({ serverCode, bypassList, isSwitch: false, wc });
        } catch (e) {
            Logger.error('connect-vpn threw', { err: e.message, stack: e.stack });
            killTor();
            progressToAll(wc,
                { percent: 0, message: 'Connection error. Check the log.', status: 'unavailable', serverCode });
            return { status: 'unavailable', serverCode, verified: false };
        }
    });

    ipcMain.handle('disconnect-vpn', async (event, isKillSwitchOn) => {
        Logger.info('disconnect-vpn', { killSwitch: isKillSwitchOn });
        //  Disconnect ends every promise the app was still keeping. A background
        //  hunt for a country nobody is connected to has nothing left to offer,
        //  and a question about which country to use answers itself the moment
        //  the user says "none" -- leaving either one running would put a dialog
        //  about exit nodes on screen after the tunnel was deliberately closed.
        stopExitWatcher();
        cancelAllAsks('cancel');
        //  Tearing the tunnel down runs several .bat files and can take a
        //  few seconds. The popup has to know, or its button sits there
        //  looking clickable while nothing appears to happen.
        appState.busy = true; broadcastState();
        try {
            //  killTor() instead of a raw taskkill: it closes the control
            //  socket and the spawned child handle as well as the process.
            //  The old version killed tor.exe and left torCtl believing it
            //  still had a live connection, so the next connect inherited
            //  a dead control socket.
            killTor();
            Logger.debug('Tor engine stopped');

            //  Match whatever the rest of the machine is about to get:
            //  sealed if the Kill Switch is on, open if it is not. Done
            //  before the slow policy work because Tor is already gone,
            //  so until this runs the window cannot load anything anyway.
            await setAppProxy(isKillSwitchOn ? 'blocked' : 'direct');

            //  Awaited, so the browser proxy / DNS / WebRTC / geolocation
            //  policies really are gone before the renderer is told the
            //  VPN is off.
            if (mainWindow) await clearGeolocationSpoof(mainWindow);

            if (isKillSwitchOn) {
                await killSwitchLeakLock();
            } else {
                await runBat(getScriptPath('fp_disconn.bat'), [
                    '@echo off',
                    `reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD /d 0 /f`,
                    `reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer /t REG_SZ /d "" /f`,
                ].join('\r\n'));
                await reverseLeakProtection();
            }

            appState.connected = false; appState.busy = false; appState.since = null; broadcastState();
            Logger.success('VPN disconnected');
            return { status: 'disconnected' };
        } catch (e) {
            //  The old handler wrapped everything in a bare new Promise
            //  and only resolved on the happy path, so one failing .bat
            //  left the renderer waiting on Disconnect forever. The
            //  button always comes back now.
            Logger.error('disconnect-vpn failed', { err: e.message, stack: e.stack });
            appState.connected = false; appState.busy = false; appState.since = null; broadcastState();
            return { status: 'disconnected', error: e.message };
        }
    });

    // ── Kill Switch ───────────────────────────────────────
    ipcMain.handle('toggle-killswitch', async (event, isEnabled) => {
        Logger.info('toggle-killswitch', { enabled: isEnabled });
        appState.killSwitch = isEnabled; broadcastState();
        if (isEnabled) {
            await killSwitchLeakLock();
        } else {
            await runBat(getScriptPath('fp_ks_off.bat'), [
                '@echo off',
                `reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD /d 0 /f`,
                `reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer /t REG_SZ /d "" /f`,
            ].join('\r\n'));
            await reverseLeakProtection();
        }
        return { status: 'done' };
    });

    // ── Live bypass update ────────────────────────────────
    ipcMain.handle('update-live-bypass', async (event, bypassList) => {
        Logger.info('update-live-bypass', { bypassList });
        return new Promise(resolve => {
            appState.bypassList = bypassList; broadcastState();
            let fp = '<local>';
            if (bypassList && bypassList.trim()) {
                const parts = bypassList.replace(/,/g, ';').split(';')
                    .map(s => { const c = s.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/[\*\s]/g, ''); return c ? `*${c}*` : ''; })
                    .filter(Boolean);
                if (parts.length) fp = parts.join(';') + ';<local>';
            }
            // REMOVED: Set-DnsClientServerAddress was crashing WiFi adapter
            // when split tunneling was updated while connected.
            // DNS is locked by applyLeakProtection() at connect time.
            // Only ProxyOverride needs to change for bypass updates.
            runBat(getScriptPath('fp_bypass.bat'), [
                '@echo off',
                `reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyOverride /t REG_SZ /d "${fp}" /f`,
            ].join('\r\n')).then(() => { Logger.debug('Bypass updated', { fp }); resolve({ status: 'updated' }); });
        });
    });


    // ════════════════════════════════════════════════════════
    //  SWITCH VPN -- same engine as connect, no leak-protection teardown
    //
    //  This used to be a second, independently written connect engine
    //  (mkTorrc / swQueryGeoAPI / swGetActualExitCountry / runTor) that had
    //  no ControlPort, no exit pinning and its own timeouts. It now differs
    //  from connect-vpn in exactly two ways, which is all it ever needed:
    //  it does not reverse leak protection, and it reverts to the previous
    //  country if the new one cannot be reached.
    // ════════════════════════════════════════════════════════
    ipcMain.handle('switch-vpn', async (event, data) => {
        const { serverCode, bypassList = '', oldServerCode = '' } = data;
        Logger.info('switch-vpn', { from: oldServerCode, to: serverCode });
        const wc = BrowserWindow.getAllWindows()[0]?.webContents;

        try {
            const r = await establishConnection({
                serverCode, bypassList, isSwitch: true, oldServerCode, wc,
            });
            if (r.status === 'connected') return r;

            //  Cancelled is a DECISION, not a failure. The user was asked what
            //  to do about a country with no exit node and answered "do not
            //  connect at all" -- reverting to the previous country here would
            //  reconnect the thing they just cancelled, which is the silent
            //  substitution wearing a different hat. establishConnection has
            //  already either kept the old tunnel (`kept: true`, nothing was
            //  torn down) or taken the machine back to normal.
            if (r.status === 'cancelled') return r;

            //  New country unreachable -- go back to the one that worked.
            if (!oldServerCode || oldServerCode === serverCode) return r;
            Logger.warn('Switch failed, reverting', { oldServerCode });
            progressToAll(wc, {
                percent: 5, message: `Reverting to ${oldServerCode.toUpperCase()}...`,
                status: 'connecting', serverCode: oldServerCode,
            });
            const back = await establishConnection({
                serverCode: oldServerCode, bypassList, isSwitch: true, wc,
            });
            return back.status === 'connected'
                ? { ...back, status: 'reconnected' }
                : { status: 'unavailable', serverCode, verified: false };
        } catch (e) {
            Logger.error('switch-vpn threw', { err: e.message, stack: e.stack });
            progressToAll(wc,
                { percent: 0, message: 'Switch error. Check the log.', status: 'unavailable', serverCode });
            return { status: 'unavailable', serverCode, verified: false };
        }
    });
}
// ═══════════════════════════════════════════════════════════════════
//  ADDITIVE FIX (v2) — corrects 2 remaining issues from last round
//
//  ISSUE A: Edge still shows real IP, Chrome works
//  ROOT CAUSE: Windows WinINET caches the proxy decision per-process.
//  Writing the registry key alone does NOT notify already-running
//  browsers. Chrome happened to re-read it (likely opened/navigated
//  after the write); Edge's WinINET cache never got invalidated.
//  REAL FIX: call InternetSetOption(NULL, INTERNET_OPTION_SETTINGS_CHANGED)
//  + INTERNET_OPTION_REFRESH via a tiny PowerShell P/Invoke — this is
//  the official Win32 API to force ALL WinINET-based apps (Edge,
//  Chrome, IE-mode, etc.) to immediately re-read the registry proxy,
//  without needing to restart the browser.
//  Also reinforced with: (1) netsh winhttp machine proxy, and
//  (2) Chromium Enterprise policy registry (ProxySettings JSON)
//  under HKLM for both Edge and Chrome — this is the policy channel
//  Chromium browsers check FIRST, before user-level WinINET settings,
//  so it guarantees Edge specifically obeys it.
//
//  ISSUE B: Google Maps shows no location at all
//  ROOT CAUSE: previous version blocked 'geolocation.googleapis.com'
//  in hosts — but that hostname does NOT exist / is never queried.
//  Chrome's actual W3C Geolocation network-location-provider endpoint
//  is:  https://www.googleapis.com/geolocation/v1/geolocate
//  Blocking the wrong domain meant Chrome's real request still went
//  out (now via Tor, with no responder) → no result → blank map.
//  REAL FIX: redirect www.googleapis.com (the ACTUAL endpoint host)
//  to 127.0.0.1, with a matching cert SAN, and serve the exact JSON
//  shape Chrome expects from this endpoint.
// ═══════════════════════════════════════════════════════════════════

function geoFile(name) { return path.join(app.getPath('userData'), name); }

// ── PowerShell runner ─────────────────────────────────────────────
//  Writes the script to a .ps1 FILE and runs it with -File, so nothing
//  depends on shell quoting.
//
//  Now ASYNCHRONOUS. The previous version used execSync, which blocks
//  the entire Electron main process -- including the IPC reply the
//  renderer is awaiting and the Tor stderr reader. The attached log
//  shows what that cost: the Disable-NetAdapterBinding call sat for
//  36 seconds and then failed with ETIMEDOUT, freezing the UI for the
//  whole duration and delivering no protection at the end of it.
function runPs1(content, name, timeoutMs = 20000) {
    const p = geoFile(name);
    try { fs.writeFileSync(p, content, 'utf8'); }
    catch (e) { return Promise.reject(e); }

    return new Promise((resolve, reject) => {
        const proc = spawn('powershell.exe',
            ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', p],
            { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

        let out = '', err = '', done = false;
        const settle = (fn, arg) => { if (!done) { done = true; clearTimeout(timer); fn(arg); } };
        const timer = setTimeout(() => {
            try { proc.kill(); } catch (e) {}
            settle(reject, new Error(`${name} timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        proc.stdout.on('data', d => out += d.toString());
        proc.stderr.on('data', d => err += d.toString());
        proc.on('error', e => settle(reject, e));
        proc.on('close', code => {
            if (code === 0) settle(resolve, out);
            else settle(reject, new Error(`${name} exited ${code}: ${(err || out).split('\n')[0].trim()}`));
        });
    });
}

// ═══════════════════════════════════════════════════════════════════
//  BROWSER RESTART -- only when it is actually needed
//
//  Chromium reads the ProxySettings enterprise policy when its network
//  service starts and caches it; Edge additionally keeps a background
//  "startup boost" process alive after its last window closes, so a
//  policy written afterwards is not picked up. That is the asymmetry in
//  the report -- Chrome saw the new proxy, Edge kept using the old one.
//  Closing the browsers guarantees a fresh read.
//
//  But the old code closed all three browsers on EVERY connect AND every
//  country switch, even though the proxy value -- socks5://127.0.0.1:9050
//  -- is identical for every country. Switching from Luxembourg to Japan
//  changes nothing a browser needs to re-read, so it now only restarts
//  when the policy value it depends on has genuinely changed.
// ═══════════════════════════════════════════════════════════════════
//  Close every browser that reads what this app writes, and WAIT for them
//  to be gone.
//
//  The list comes from lib/browsers.js and holds only what is installed:
//  the Chromium forks, which read their Preferences and policy at startup,
//  and the Gecko forks, which read user.js at startup -- so a Firefox that
//  is restarted here comes back with the spoofed position instead of having
//  to be closed by hand. Internet Explorer is excluded by processNames() on
//  purpose: it follows the system proxy live, so closing it would cost the
//  user their tabs for no gain.
//
//  The wait is not politeness, it is correctness: Chromium keeps its
//  Preferences file in memory and writes it out on exit. An edit made
//  while the browser is alive is discarded, and a force-kill skips the
//  flush entirely. So: ask nicely, wait for the process to disappear,
//  and only then touch the profile.
function closeBrowsersAndWait(why = 'to apply the new settings') {
    const EXES = browsers.processNames();
    const isUp = exe => {
        try {
            return execSync(`tasklist /FI "IMAGENAME eq ${exe}" /NH`,
                { windowsHide: true, encoding: 'utf8', stdio: 'pipe' })
                .toLowerCase().includes(exe.toLowerCase());
        } catch (e) { return false; }
    };

    const running = EXES.filter(isUp);
    if (!running.length) return Promise.resolve([]);

    for (const exe of running) {
        try {
            execSync(`taskkill /IM ${exe}`, { windowsHide: true, stdio: 'pipe' });
            Logger.info(`${exe} closed ${why} (reopens normally, session restored)`);
        } catch (e) { /* refused the graceful close -- handled below */ }
    }

    return new Promise(resolve => {
        let waited = 0;
        const GRACE = 10000, STEP = 500;
        const tick = () => {
            const left = EXES.filter(isUp);
            if (!left.length) { Logger.debug('All browsers closed cleanly'); return resolve(running); }
            waited += STEP;
            if (waited < GRACE) return void setTimeout(tick, STEP);
            //  Something is holding it open -- an unsaved-form prompt, or a
            //  background extension. Force it, and say so: without the clean
            //  exit its stored per-site grants can survive, and then the
            //  policy layer is the only thing covering them.
            for (const exe of left) {
                try { execSync(`taskkill /F /IM ${exe}`, { windowsHide: true, stdio: 'pipe' }); } catch (e) {}
            }
            Logger.warn(`${left.join(', ')} ignored the graceful close and was force-closed ` +
                        'after 10s -- its stored site permissions are covered by policy instead');
            setTimeout(() => resolve(running), 1500);
        };
        setTimeout(tick, 1000);
    });
}

// ═══════════════════════════════════════════════════════════════════
//  BROWSER POLICY -- proxy + the leak vectors a SOCKS proxy misses
//
//  ProxySettings alone does not close every path out of the browser:
//
//  * WebRtcIPHandlingPolicy=disable_non_proxied_udp
//      WebRTC opens UDP sockets directly, outside the SOCKS proxy, and
//      hands the resulting host candidates to any page that asks. That
//      is a real-IP disclosure a proxy cannot cover, and it is the
//      classic "VPN but the site still knows your IP" leak.
//  * DnsOverHttpsMode=off / BuiltInDnsClientEnabled=false
//      Chromium's own resolver and DoH client can issue lookups that do
//      not follow the SOCKS proxy. With them off, hostnames are handed
//      to the proxy and resolved at the Tor exit instead.
//  * DnsPrefetchingEnabled=0 / NetworkPredictionOptions=2
//      The predictive prefetcher fires OS-level lookups for hinted links
//      regardless of the proxy.
//
//  GeolocationAllowedForUrls was REMOVED. It force-allowed geolocation
//  for [*.]google.com, which is the opposite of what this app needs:
//  granting the permission is what let Chromium run its network location
//  provider, scan the local Wi-Fi BSSIDs and POST them to Google -- and
//  Google resolves a position from those BSSIDs, not from the IP the
//  request arrives on. That is why Chrome and Brave both reported the
//  real Dhaka location through a Luxembourg exit.
//
//  What stops it is the bundled extension: a MAIN-world content script
//  replaces navigator.geolocation before any page script runs, so the
//  network provider is never reached and the page is handed the connected
//  country's coordinates instead. The provider is NOT blocked -- blocking
//  it was tried, and it broke Google Maps and greyed out the user's own
//  Location setting. See lib/geo-ext.js.
// ═══════════════════════════════════════════════════════════════════
//  The policy roots come from lib/browsers.js. Writing uses the INSTALLED
//  set, so no policy hive is created for a browser that is not on the
//  machine; clearing uses the whole table, because a fork uninstalled since
//  the last run still has our values in HKLM and teardown is the only thing
//  that ever removes them.

async function forceAllBrowsersOntoProxy() {
    const proxyJson = '{"ProxyMode":"fixed_servers",' +
                      '"ProxyServer":"socks5://127.0.0.1:9050",' +
                      '"ProxyBypassList":"localhost;127.0.0.1;<local>"}';

    const roots    = browsers.policyRoots('ps');
    const keysLine = roots.length
        ? `$keys = @('${roots.map(r => r.key).join("','")}')`
        : '$keys = @()';

    const ps = [
        "$ErrorActionPreference = 'SilentlyContinue'",
        // Tell every already-running WinINET consumer to re-read the proxy.
        "try {",
        "    Add-Type -Namespace FP -Name Inet -MemberDefinition @'",
        '[DllImport("wininet.dll")]',
        "public static extern bool InternetSetOption(IntPtr hInternet, int dwOption, IntPtr lpBuffer, int dwBufferLength);",
        "'@",
        "    [FP.Inet]::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0) | Out-Null",
        "    [FP.Inet]::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0) | Out-Null",
        "} catch {}",
        `$desired = '${proxyJson}'`,
        '$changed = $false',
        keysLine,
        'foreach ($k in $keys) {',
        '    New-Item -Path $k -Force | Out-Null',
        "    $cur = (Get-ItemProperty -Path $k -Name 'ProxySettings' -ErrorAction SilentlyContinue).ProxySettings",
        '    if ($cur -ne $desired) { $changed = $true }',
        "    Set-ItemProperty -Path $k -Name 'ProxySettings'            -Value $desired -Type String -Force",
        // ── leak vectors a SOCKS proxy does not cover ──
        "    Set-ItemProperty -Path $k -Name 'WebRtcIPHandlingPolicy'   -Value 'disable_non_proxied_udp' -Type String -Force",
        "    Set-ItemProperty -Path $k -Name 'DnsOverHttpsMode'         -Value 'off' -Type String -Force",
        "    Set-ItemProperty -Path $k -Name 'BuiltInDnsClientEnabled'  -Value 0 -Type DWord -Force",
        "    Set-ItemProperty -Path $k -Name 'DnsPrefetchingEnabled'    -Value 0 -Type DWord -Force",
        "    Set-ItemProperty -Path $k -Name 'NetworkPredictionOptions' -Value 2 -Type DWord -Force",
        // Clear the old force-allow list policy if a previous build left it.
        "    Remove-Item -Path (Join-Path $k 'GeolocationAllowedForUrls') -Recurse -ErrorAction SilentlyContinue",
        '}',
        'Write-Output "PROXY_OK CHANGED=$changed"',
    ].join('\r\n');

    let changed = true;   // if we cannot tell, assume it changed
    try {
        const out = await runPs1(ps, 'fp_browserproxy.ps1', 20000);
        changed = /CHANGED=True/i.test(out);
        Logger.success('Browser policy applied to ' +
                       (roots.map(r => r.name).join('/') || 'no policy-capable browser') +
                       ` (proxy changed: ${changed})`);
    } catch (e) {
        Logger.warn('Browser policy script: ' + e.message.split('\n')[0]);
    }

    //  The restart decision is deliberately NOT made here any more. This
    //  function only knows whether the PROXY changed, and the location
    //  policy can need a restart on its own -- gating the restart on the
    //  proxy alone is what left Chrome and Brave running with their old
    //  location settings while the app reported success.
    return { proxyChanged: changed };
}

async function restoreAllBrowsersProxy() {
    const keys = browsers.policyRoots('ps', 'all').map(r => r.key);
    const ps = [
        "$ErrorActionPreference = 'SilentlyContinue'",
        `$keys = @('${keys.join("','")}')`,
        'foreach ($k in $keys) {',
        "    foreach ($n in @('ProxySettings','WebRtcIPHandlingPolicy','DnsOverHttpsMode'," +
            "'BuiltInDnsClientEnabled','DnsPrefetchingEnabled','NetworkPredictionOptions')) {",
        '        Remove-ItemProperty -Path $k -Name $n -ErrorAction SilentlyContinue',
        '    }',
        "    Remove-Item -Path (Join-Path $k 'GeolocationAllowedForUrls') -Recurse -ErrorAction SilentlyContinue",
        '}',
        "try {",
        "    Add-Type -Namespace FP -Name Inet2 -MemberDefinition @'",
        '[DllImport("wininet.dll")]',
        "public static extern bool InternetSetOption(IntPtr hInternet, int dwOption, IntPtr lpBuffer, int dwBufferLength);",
        "'@",
        "    [FP.Inet2]::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0) | Out-Null",
        "    [FP.Inet2]::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0) | Out-Null",
        "} catch {}",
        "Write-Output 'RESTORE_OK'",
    ].join('\r\n');

    try {
        await runPs1(ps, 'fp_browserproxy_off.ps1', 15000);
        Logger.info('Browser proxy + leak policies reverted');
    } catch (e) { Logger.warn('Browser policy restore: ' + e.message.split('\n')[0]); }
    //  Deliberately NOT restarting browsers here. Reverting does not need
    //  it, and killing the browser on disconnect (and on app exit) was
    //  what made it appear to close by itself. The InternetSetOption
    //  broadcast above is enough to notify running processes.
}

// ═══════════════════════════════════════════════════════════════════
//  WHAT "LOCATION SPOOFING" HONESTLY MEANS HERE
//
//  An earlier comment in this file claimed that stopping lfsvc makes
//  Chromium fall back to a Google request that travels through Tor, so
//  Google would answer with a location inside the exit country. The test
//  results disprove that: Chrome and Brave both reported the real Dhaka
//  position while exiting in Luxembourg.
//
//  The reason is that Chromium's network location provider does not ask
//  "where is this IP?". It scans the local Wi-Fi with WlanGetNetworkBssList
//  and POSTs the surrounding BSSIDs to
//      https://www.googleapis.com/geolocation/v1/geolocate
//  Google matches those BSSIDs against its own survey database and
//  returns the position of the router -- the request IP is irrelevant.
//  Routing that request through Tor changes nothing, because the evidence
//  Google acts on is inside the request body, not in its source address.
//
//  So the coordinates have to be replaced at the point the page reads
//  them. Surface by surface:
//
//   * this app's own window -- CDP Emulation.setGeolocationOverride.
//   * Chromium browsers -- the bundled MV3 extension, whose MAIN-world
//     content script replaces navigator.geolocation at document_start.
//     This is what ExpressVPN, NordVPN, Surfshark and Windscribe all
//     ship, for exactly this reason. lib/geo-ext.js gets it installed.
//   * Firefox -- geo.provider.network.url pointed at a data: URL holding
//     the coordinates. Documented, supported, and a true override.
//   * native Windows apps -- there is NO supported coordinate-injection
//     API on Windows, which .build/test-winloc-default.js measures rather
//     than assumes: Windows own documented Default Location, written into
//     the registry, does not change what a native .NET consumer reports --
//     not with the Wi-Fi survey working, and not with lfsvc cut off from the
//     network and restarted. So that surface is SHIELDED, never spoofed: a
//     service-scoped firewall rule stops lfsvc from reaching Microsoft
//     location service, so no fresh real fix can be resolved or put on the
//     wire while connected, while the user Location setting, their app
//     permissions and their Settings control are all left exactly as they
//     were. An earlier build DENIED here instead. It worked and it was still
//     wrong: it switched the users own location off underneath them.
//
//  Two approaches were tried and rejected. Neither is coming back:
//
//   * BLOCKING the permission (DefaultGeolocationSetting=2 plus a
//     GeolocationBlockedForUrls wildcard) so sites fall back to the exit
//     IP. It only works for sites that DO fall back: Google Maps and
//     anything reading coordinates directly breaks outright, pages report
//     "User denied the request for Geolocation", and because a policy
//     rule outranks the user's own choice their Location control is
//     greyed out. That is denial dressed up as spoofing.
//   * Impersonating Google's TLS certificate to answer the provider
//     ourselves. It needs a root CA whose private key sits on the user's
//     disk, which is a worse hole than the one being closed. An earlier
//     build attempted it and left five self-signed
//     CN=www.googleapis.com roots in the machine store; startupCleanup()
//     removes them.
// ═══════════════════════════════════════════════════════════════════
// ── Wrap applyGeolocationSpoof ────────────────────────────────────
//  The ORDER below is the fix for "Chrome and Brave still show the real
//  location":
//
//   1. Push the proxy policy and find out whether it ACTUALLY changed.
//      That answer decides step 3 on its own merits, instead of the old
//      code's guess.
//   2. Package the extension and write its install policy BEFORE the
//      browsers are closed. Chromium reads enterprise policy at startup,
//      so the entry has to already be in the registry when the browser
//      next starts. Doing this after the restart would mean the spoofer
//      only arrived on the connect after the one that asked for it.
//   3. Close the browsers -- gracefully, and WAIT for them to really
//      exit. A live Chromium holds its Preferences in memory and rewrites
//      it on exit, so anything written underneath a running browser is
//      silently discarded, and a force-kill skips the flush entirely.
//   4. Then the surfaces that have nothing to do with the browsers: shield
//      the Windows platform, and point Firefox at the spoofed coordinates.
//
//  The browsers are only closed when something they read has actually
//  changed. On a country SWITCH nothing here changes -- the extension is
//  already installed and the new coordinates reach it live over the
//  WebSocket -- so the user's tabs are left alone.
const _origApplyGeo = applyGeolocationSpoof;
applyGeolocationSpoof = function (win, sc) {
    _origApplyGeo(win, sc);
    const coord = GEO_COORDS[String(sc).toLowerCase()] || null;
    //  Fire-and-forget with a real catch: an unhandled rejection here
    //  would take down the main process on a policy-write failure.
    return (async () => {
        const geo = geoEngine();
        const ext = geoExt();
        const alreadyOn = geo.status().active;
        const { proxyChanged } = await forceAllBrowsersOntoProxy();

        // 2. Package, serve and force-install the spoofer.
        let extReady = null, autoDone = [];
        try {
            extReady = await ext.prepare();
            if (extReady) autoDone = ext.install() || [];
        } catch (e) {
            Logger.warn('Browser location spoofer could not be installed: ' + e.message);
        }

        // 3. Restart only when something the browser reads has changed.
        if (proxyChanged || !alreadyOn) {
            await closeBrowsersAndWait(proxyChanged
                ? 'to apply the new proxy and load the location spoofer'
                : 'to load the location spoofer');
        } else {
            Logger.info('Proxy and location spoofer already in force -- browsers left running');
        }

        // 4. Windows platform + Firefox.
        geo.applyAll(coord);

        //  Chrome and Brave refuse every automatic install route an app has
        //  on Windows, so say so plainly and once, instead of leaving the
        //  user to work it out from a map showing the wrong city.
        if (extReady) {
            //  needManualLoad() answers in browser ids, and renderer.js joins
            //  this array straight into a toast -- so it has to carry display
            //  names. `auto` names the browsers that were force-installed into
            //  successfully, so the toast can say what IS covered without
            //  hardcoding a browser that may not even be on the machine.
            const manual = ext.needManualLoad();
            if (manual.length) {
                ext.writeHowTo(manual);
                if (win && !win.isDestroyed()) {
                    win.webContents.send('geo-ext-setup', {
                        browsers: browsers.names(manual),
                        auto:     browsers.names(autoDone),
                        dir:      ext.dir,
                    });
                }
            }
        }

        reportGeoCoverage(coord);
    })().catch(e => Logger.warn('Device location spoof failed: ' + e.message));
};

// ── Wrap clearGeolocationSpoof ────────────────────────────────────
//  Returns the promise so callers that are about to quit -- disconnect-vpn
//  and window-all-closed -- can await it. Without that, Electron tears the
//  process down while the restore script is still running, and the browser
//  policies stay behind.
const _origClearGeo = clearGeolocationSpoof;
clearGeolocationSpoof = function (win) {
    _origClearGeo(win);
    //  Restore the device layers from the journal FIRST -- these are the
    //  ones that would otherwise leave the machine with its location
    //  switched off after disconnecting.
    try { geoEngine().restoreAll(); }
    catch (e) { Logger.warn('Device location restore failed: ' + e.message); }
    //  Drop the force-install entry. The extension itself is left alone:
    //  background.js has already been told the app is disconnected, so it
    //  reports active:false and pages get the real provider back -- and an
    //  extension the user loaded by hand is theirs to unload, not ours to
    //  rip out from behind their back. Only the policy, which they could
    //  NOT undo themselves, is removed.
    try { geoExt().restore(); }
    catch (e) { Logger.warn('Extension policy restore failed: ' + e.message); }
    return restoreAllBrowsersProxy()
        .catch(e => Logger.warn('Browser policy restore failed: ' + e.message));
};