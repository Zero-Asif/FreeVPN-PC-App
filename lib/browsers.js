'use strict';
// ════════════════════════════════════════════════════════════════════
//  lib/browsers.js  --  every browser this app has to cover on Windows
//
//  WHY THIS FILE EXISTS
//  --------------------
//  Three separate lists used to name browsers, and they agreed on
//  Edge/Chrome/Brave and on nothing else:
//
//      main.js         BROWSER_POLICY_KEYS   proxy + DNS/WebRTC hardening
//      lib/geo-ext.js  POLICY_KEYS/USER_DATA extension delivery + presence
//      main.js         closeBrowsersAndWait  which processes to close
//
//  A fourth browser was therefore a silent leak: no ProxySettings policy,
//  no DoH/WebRTC hardening, no location spoofer, and -- worst of all --
//  nothing in the coverage report to say it was uncovered. One table now
//  feeds all three, and anything absent from this table is absent on
//  purpose with the reason written down.
//
//  EVERY CLAIM IN THE TABLE IS SOURCED
//  -----------------------------------
//  `forcelist` says whether a browser accepts a force-install of an
//  extension this app hosts itself on loopback. The values mean:
//
//    'works'    measured end-to-end on this machine -- a real page received
//               the spoofed coordinates. Only Edge.
//    'refused'  measured to fail. Chrome and Brave drop the entry during
//               policy validation, before any request is made, and Google
//               documents why: on Windows an off-store extension can only
//               be force-installed when the instance is joined to an AD
//               domain, joined to Azure AD, or enrolled in Chrome Browser
//               Cloud Management. Chrome 151 tightened this further. No
//               app installer can satisfy that, and enrolling a private
//               machine into someone's management realm to win an argument
//               with a policy check is not on the table.
//    'unknown'  the fork is not installed here, so it was never measured.
//               The code ATTEMPTS it, reads the value back, and reports
//               presence from the profile -- so an unknown that turns out
//               to work is picked up, and one that does not is reported as
//               needing a manual load. Nothing is assumed either way.
//    'no-policy' the vendor implements no Chromium policy at all. Opera's
//               own staff state this outright, repeatedly, on their forum.
//               Writing SOFTWARE\Policies\Opera Software would be litter
//               in a hive nobody reads.
//
//  ROUTES CONSIDERED AND REFUSED, so they are not re-litigated later:
//
//    * Writing the extension into a profile's Secure Preferences. Those
//      are HMAC-signed with a machine-specific seed; forging the MAC is
//      indistinguishable from the malware the signature exists to stop,
//      and Chromium resets settings it detects as tampered with anyway.
//    * Appending --load-extension to the user's shortcuts. It works in
//      Brave/Vivaldi/Opera and is ignored by Chrome -- but it only applies
//      when the browser is started from a shortcut we rewrote, so a
//      taskbar pin, a file association or another app opening a link all
//      silently bypass it. A spoof that is on or off depending on how the
//      browser happened to start is exactly the kind of half-true result
//      this project refuses to ship.
//    * A local CRX path in the External Extensions registry key. Refused
//      by Chrome since version 33 and measured to be refused by all three.
//
//  Tor Browser is deliberately absent. It ships its own proxy, its own
//  fingerprint defences and its own deliberately-wrong geolocation answer;
//  pointing it at this app's Tor instance or rewriting its prefs would
//  degrade a browser that is already doing the job properly.
// ════════════════════════════════════════════════════════════════════

const fs   = require('fs');
const path = require('path');

/** Expand %VAR% the way the registry does. Unset vars collapse the path. */
function expand(p) {
    let missing = false;
    const out = String(p).replace(/%([^%]+)%/g, (_, name) => {
        const v = process.env[name];
        if (!v) { missing = true; return ''; }
        return v;
    });
    return missing ? null : out;
}

// ════════════════════════════════════════════════════════════════════
//  The table
//
//  policy      HKLM subkey under SOFTWARE\Policies, or null when the
//              vendor implements no policies. Used for ProxySettings and
//              the DNS/WebRTC leak vectors as well as the forcelist, so
//              getting it right matters even where the forcelist fails.
//  userData    Chromium "User Data" root candidates, first existing wins.
//  profiles    Gecko profile-root candidates.
//  exe         image name, for "is it running" and "close it".
//  settings    the fork's own extensions page. chrome://extensions is
//              rejected by Brave and Vivaldi, so a single generic URL in the
//              instructions would send the user somewhere that errors.
//  exePaths    install locations, for "is it installed" -- checked as well
//              as userData because a fresh install has no profile yet and
//              an uninstall can leave the profile behind.
//  startMenu   Clients\StartMenuInternet key name. Read as a HINT only:
//              Opera left that key behind on this machine after being
//              uninstalled, pointing at an opera.exe that no longer
//              exists, so a key on its own never means "installed".
// ════════════════════════════════════════════════════════════════════
const CHROMIUM = [
    {
        id: 'edge', name: 'Microsoft Edge', family: 'chromium', exe: 'msedge.exe',
        settings: 'edge://extensions',
        policy: 'SOFTWARE\\Policies\\Microsoft\\Edge', forcelist: 'works',
        userData: ['%LOCALAPPDATA%\\Microsoft\\Edge\\User Data'],
        exePaths: ['%PROGRAMFILES(X86)%\\Microsoft\\Edge\\Application\\msedge.exe',
                   '%PROGRAMFILES%\\Microsoft\\Edge\\Application\\msedge.exe'],
        startMenu: 'Microsoft Edge',
    },
    {
        id: 'chrome', name: 'Google Chrome', family: 'chromium', exe: 'chrome.exe',
        settings: 'chrome://extensions',
        policy: 'SOFTWARE\\Policies\\Google\\Chrome', forcelist: 'refused',
        userData: ['%LOCALAPPDATA%\\Google\\Chrome\\User Data'],
        exePaths: ['%PROGRAMFILES%\\Google\\Chrome\\Application\\chrome.exe',
                   '%PROGRAMFILES(X86)%\\Google\\Chrome\\Application\\chrome.exe',
                   '%LOCALAPPDATA%\\Google\\Chrome\\Application\\chrome.exe'],
        startMenu: 'Google Chrome',
    },
    {
        id: 'brave', name: 'Brave', family: 'chromium', exe: 'brave.exe',
        //  brave://extensions -- chrome://extensions is rejected by Brave, so
        //  the instructions have to name each fork's own scheme.
        settings: 'brave://extensions',
        policy: 'SOFTWARE\\Policies\\BraveSoftware\\Brave', forcelist: 'refused',
        userData: ['%LOCALAPPDATA%\\BraveSoftware\\Brave-Browser\\User Data'],
        exePaths: ['%PROGRAMFILES%\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
                   '%PROGRAMFILES(X86)%\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
                   '%LOCALAPPDATA%\\BraveSoftware\\Brave-Browser\\Application\\brave.exe'],
        startMenu: 'Brave',
    },
    {
        id: 'vivaldi', name: 'Vivaldi', family: 'chromium', exe: 'vivaldi.exe',
        settings: 'vivaldi://extensions',
        //  Vivaldi honours the Chromium policy set under its own root; that
        //  root is what Vivaldi's own forum and its ADMX template name.
        policy: 'SOFTWARE\\Policies\\Vivaldi', forcelist: 'unknown',
        userData: ['%LOCALAPPDATA%\\Vivaldi\\User Data'],
        exePaths: ['%LOCALAPPDATA%\\Vivaldi\\Application\\vivaldi.exe',
                   '%PROGRAMFILES%\\Vivaldi\\Application\\vivaldi.exe',
                   '%PROGRAMFILES(X86)%\\Vivaldi\\Application\\vivaldi.exe'],
        startMenu: 'Vivaldi',
    },
    {
        id: 'opera', name: 'Opera', family: 'chromium', exe: 'opera.exe',
        settings: 'opera://extensions',
        //  No policy root. Opera staff state plainly and repeatedly that
        //  Opera implements no policies, so there is nothing to write. What
        //  covers Opera instead is the SYSTEM proxy, which this app already
        //  sets and which Opera follows by default -- so it is proxied, but
        //  its DoH setting cannot be forced and its location needs the
        //  extension loaded by hand. reportGeoCoverage() says exactly that.
        policy: null, forcelist: 'no-policy',
        userData: ['%APPDATA%\\Opera Software\\Opera Stable'],
        exePaths: ['%LOCALAPPDATA%\\Programs\\Opera\\opera.exe',
                   '%PROGRAMFILES%\\Opera\\opera.exe',
                   '%PROGRAMFILES(X86)%\\Opera\\opera.exe'],
        startMenu: 'OperaStable',
    },
    {
        id: 'operagx', name: 'Opera GX', family: 'chromium', exe: 'opera.exe',
        settings: 'opera://extensions',
        policy: null, forcelist: 'no-policy',
        userData: ['%APPDATA%\\Opera Software\\Opera GX Stable'],
        exePaths: ['%LOCALAPPDATA%\\Programs\\Opera GX\\opera.exe',
                   '%PROGRAMFILES%\\Opera GX\\opera.exe'],
        startMenu: 'OperaGXStable',
    },
    {
        id: 'yandex', name: 'Yandex Browser', family: 'chromium', exe: 'browser.exe',
        settings: 'browser://extensions',
        //  Yandex publishes a corporate ADMX template; this is the root it
        //  uses. Not measured here -- the browser is not installed.
        policy: 'SOFTWARE\\Policies\\YandexBrowser', forcelist: 'unknown',
        userData: ['%LOCALAPPDATA%\\Yandex\\YandexBrowser\\User Data'],
        exePaths: ['%LOCALAPPDATA%\\Yandex\\YandexBrowser\\Application\\browser.exe',
                   '%PROGRAMFILES(X86)%\\Yandex\\YandexBrowser\\Application\\browser.exe'],
        startMenu: 'YandexBrowser',
    },
    {
        id: 'chromium', name: 'Chromium', family: 'chromium', exe: 'chrome.exe',
        settings: 'chrome://extensions',
        policy: 'SOFTWARE\\Policies\\Chromium', forcelist: 'unknown',
        userData: ['%LOCALAPPDATA%\\Chromium\\User Data'],
        exePaths: ['%LOCALAPPDATA%\\Chromium\\Application\\chrome.exe',
                   '%PROGRAMFILES%\\Chromium\\Application\\chrome.exe'],
        startMenu: 'Chromium',
    },
];

// ════════════════════════════════════════════════════════════════════
//  Gecko family -- no extension needed, and that is not a shortcut
//
//  geo.provider.network.url is a documented, supported preference: it is
//  the URL Gecko POSTs its Wi-Fi survey to, and it accepts a data: URL, so
//  pointing it at a literal JSON body makes the browser's own geolocation
//  stack return the connected country's coordinates. Nothing is patched,
//  nothing is denied, and the user's site permissions keep working.
//
//  geo.wifi.uri is the same pref's pre-Firefox-74 name. Both are written:
//  an unknown pref in user.js is inert, so covering old forks costs one
//  line and no risk.
// ════════════════════════════════════════════════════════════════════
const GECKO = [
    { id: 'firefox', name: 'Firefox', family: 'gecko', exe: 'firefox.exe',
      profiles: ['%APPDATA%\\Mozilla\\Firefox\\Profiles'],
      exePaths: ['%PROGRAMFILES%\\Mozilla Firefox\\firefox.exe',
                 '%PROGRAMFILES(X86)%\\Mozilla Firefox\\firefox.exe'],
      startMenu: 'FIREFOX.EXE' },
    { id: 'waterfox', name: 'Waterfox', family: 'gecko', exe: 'waterfox.exe',
      profiles: ['%APPDATA%\\Waterfox\\Profiles'],
      exePaths: ['%PROGRAMFILES%\\Waterfox\\waterfox.exe'],
      startMenu: 'WATERFOX.EXE' },
    { id: 'librewolf', name: 'LibreWolf', family: 'gecko', exe: 'librewolf.exe',
      profiles: ['%APPDATA%\\librewolf\\Profiles', '%APPDATA%\\LibreWolf\\Profiles'],
      exePaths: ['%PROGRAMFILES%\\LibreWolf\\librewolf.exe',
                 '%LOCALAPPDATA%\\LibreWolf\\librewolf.exe'],
      startMenu: 'librewolf.exe' },
    { id: 'palemoon', name: 'Pale Moon', family: 'gecko', exe: 'palemoon.exe',
      profiles: ['%APPDATA%\\Moonchild Productions\\Pale Moon\\Profiles'],
      exePaths: ['%PROGRAMFILES%\\Pale Moon\\palemoon.exe',
                 '%PROGRAMFILES(X86)%\\Pale Moon\\palemoon.exe'],
      startMenu: 'Pale Moon' },
    { id: 'seamonkey', name: 'SeaMonkey', family: 'gecko', exe: 'seamonkey.exe',
      profiles: ['%APPDATA%\\Mozilla\\SeaMonkey\\Profiles'],
      exePaths: ['%PROGRAMFILES%\\SeaMonkey\\seamonkey.exe'],
      startMenu: 'SeaMonkey' },
];

// ════════════════════════════════════════════════════════════════════
//  Everything else that can browse on Windows
//
//  Internet Explorer and any WebView2/UWP host use WinINET and the Windows
//  Location API. That means the system proxy this app already sets covers
//  their traffic, and their geolocation comes from lfsvc -- the surface
//  lib/geo-spoof.js SHIELDS and cannot spoof, because Windows exposes no
//  coordinate-injection API (measured: .build/test-winloc-default.js).
//  Nothing is installable here; they are listed so the coverage report can
//  name them honestly instead of leaving a gap the user has to guess at.
// ════════════════════════════════════════════════════════════════════
const WININET = [
    { id: 'ie', name: 'Internet Explorer', family: 'wininet', exe: 'iexplore.exe',
      exePaths: ['%PROGRAMFILES%\\Internet Explorer\\iexplore.exe'],
      startMenu: 'IEXPLORE.EXE' },
];

const ALL = [...CHROMIUM, ...GECKO, ...WININET];

// ── detection ───────────────────────────────────────────────────────
function firstExisting(candidates) {
    for (const c of candidates || []) {
        const p = expand(c);
        if (p && fs.existsSync(p)) return p;
    }
    return null;
}

//  Registry lookups are cached for the life of the process and BATCHED:
//  two parent keys are enumerated once each per hive instead of eight
//  point queries per browser. Enumerating per browser measured 5.1 s on
//  this machine for a 14-row table, and detect() is called by the coverage
//  report, the policy writer and the restart decision -- three times a
//  connect, so five seconds each was a delay the user could feel.
let _regCache = null;

const APPPATHS_SUB = 'Microsoft\\Windows\\CurrentVersion\\App Paths';
const STARTMENU_SUB = 'Clients\\StartMenuInternet';

//  App Paths is keyed by executable NAME, so it cannot distinguish two
//  browsers that ship the same one: App Paths\chrome.exe belongs to Google
//  Chrome, and reading it for the `chromium` row reported Chromium as
//  installed on a machine that has never had it. Only unique names are
//  looked up there; a shared name is resolved from StartMenuInternet,
//  which is keyed per vendor.
const UNIQUE_EXE = (() => {
    const n = {};
    for (const b of [...CHROMIUM, ...GECKO, ...WININET]) {
        if (b.exe) n[b.exe.toLowerCase()] = (n[b.exe.toLowerCase()] || 0) + 1;
    }
    return n;
})();

/**
 * Ask Windows where each browser is, rather than only guessing directory
 * layouts. Two registrations are read and BOTH are verified on disk:
 *
 *   App Paths\<exe>                          installs in any directory
 *   StartMenuInternet\<key>\shell\open\command   the "I am a browser" claim
 *
 * Verification is the point. This machine has a live
 * HKCU\...\StartMenuInternet\OperaStable pointing at an opera.exe that was
 * uninstalled, so an unverified read would have reported Opera as covered
 * and written policy for a browser that is not there.
 */
function regExePaths() {
    if (_regCache) return _regCache;
    const { execSync } = require('child_process');

    const clean = (s) => {
        if (!s) return null;
        //  Both registrations may be quoted, and a shell command carries
        //  switches after the path.
        const m = s.match(/^"([^"]+)"/);
        return (m ? m[1] : s.split(/\s+[-/]{1,2}\w/)[0]).trim();
    };

    //  key line -> current subkey; value line -> its default value.
    const scan = (root) => {
        let out = '';
        try {
            out = execSync(`reg query "${root}" /s /ve`,
                { encoding: 'utf8', windowsHide: true, stdio: 'pipe', maxBuffer: 8 << 20 });
        } catch (e) { return {}; }
        const map = {};
        let cur = null;
        for (const line of out.split(/\r?\n/)) {
            if (/^HKEY_/.test(line)) { cur = line.trim(); continue; }
            const m = line.match(/^\s+\(Default\)\s+REG_(?:SZ|EXPAND_SZ)\s+(.+)$/);
            if (m && cur) map[cur.toLowerCase()] = m[1].trim();
        }
        return map;
    };

    const hives = {};
    for (const root of ['HKEY_LOCAL_MACHINE', 'HKEY_CURRENT_USER']) {
        for (const soft of ['SOFTWARE', 'SOFTWARE\\WOW6432Node']) {
            Object.assign(hives, scan(`${root}\\${soft}\\${APPPATHS_SUB}`));
            Object.assign(hives, scan(`${root}\\${soft}\\${STARTMENU_SUB}`));
        }
    }

    const map = {};
    for (const b of ALL) {
        const wanted = [];
        if (b.startMenu) wanted.push(`\\${STARTMENU_SUB}\\${b.startMenu}\\shell\\open\\command`);
        if (b.exe && UNIQUE_EXE[b.exe.toLowerCase()] === 1) {
            wanted.push(`\\${APPPATHS_SUB}\\${b.exe}`);
        }
        for (const suffix of wanted) {
            const s = suffix.toLowerCase();
            const hit = Object.keys(hives).find(k => k.endsWith(s));
            const p = hit ? clean(hives[hit]) : null;
            if (p && fs.existsSync(p)) { map[b.id] = p; break; }
        }
    }
    _regCache = map;
    return map;
}

/** Drop the cache -- only needed by tests that install/remove a browser. */
function resetCache() { _regCache = null; }

/**
 * Which of the browsers above are really on this machine.
 *
 * exePath  the executable, from a hardcoded layout OR from the registry,
 *          verified to exist. Null means "not installed", full stop.
 * dataDir  the profile / User Data root, if the browser has ever run.
 *
 * A browser with a dataDir but no exePath is an UNINSTALL LEFTOVER, and it
 * is deliberately not reported as installed. That is not a technicality:
 * this machine has %APPDATA%\Mozilla\Firefox\Profiles from September 2024
 * with no firefox.exe anywhere, and the old code would have written the
 * spoofed geo prefs into those dead profiles and then logged
 * "Firefox: spoofed (Luxembourg)" -- a coverage claim for a browser that
 * cannot open a page.
 */
function detect() {
    const reg = regExePaths();
    const out = [];
    for (const b of ALL) {
        const exePath = firstExisting(b.exePaths) || reg[b.id] || null;
        const dataDir = firstExisting(b.family === 'gecko' ? b.profiles : b.userData);
        if (!exePath) continue;
        out.push({ ...b, exePath, dataDir, installed: true });
    }
    return out;
}

/**
 * Profile directories left behind by a browser that is no longer installed.
 * Reported so restore can still clean them up: an older build may have
 * written prefs there while the browser WAS installed.
 */
function orphanProfiles() {
    const reg = regExePaths();
    const out = [];
    for (const b of ALL) {
        if (firstExisting(b.exePaths) || reg[b.id]) continue;
        const dataDir = firstExisting(b.family === 'gecko' ? b.profiles : b.userData);
        if (dataDir) out.push({ ...b, exePath: null, dataDir, installed: false });
    }
    return out;
}

/** Detected Chromium-family browsers, in table order. */
function detectChromium() { return detect().filter(b => b.family === 'chromium'); }

/** Detected Gecko-family browsers, in table order. */
function detectGecko() { return detect().filter(b => b.family === 'gecko'); }

/**
 * HKLM policy roots, for the Chromium forks that read policy at all.
 *
 * WRITING uses the default scope -- installed browsers only, so the app does
 * not create a policy hive for a browser that is not on the machine.
 *
 * CLEARING uses scope 'all'. A fork that has been uninstalled since the app
 * last ran still has our values sitting in HKLM, and the only way they ever
 * come out is if teardown sweeps the whole table. Deleting a value that is
 * not there costs one failed call and nothing else.
 *
 * @param {'reg'|'ps'} style  'reg' -> HKLM\SOFTWARE\...   (reg.exe)
 *                            'ps'  -> HKLM:\SOFTWARE\...  (PowerShell)
 * @param {'installed'|'all'} scope
 */
function policyRoots(style = 'reg', scope = 'installed') {
    const pre = style === 'ps' ? 'HKLM:\\' : 'HKLM\\';
    const rows = scope === 'all' ? CHROMIUM : detectChromium();
    return rows.filter(b => b.policy)
               .map(b => ({ id: b.id, name: b.name, key: pre + b.policy }));
}

/**
 * Image names to close before writing anything a browser reads at startup.
 * Only browsers found on this machine, so the app is not firing taskkill at
 * eight processes that were never going to be there.
 *
 * WinINET hosts are excluded on purpose: nothing this app writes is read by
 * Internet Explorer at startup -- it follows the system proxy live -- so
 * closing it would cost the user their tabs for no gain.
 */
function processNames() {
    const seen = new Set();
    for (const b of detect()) if (b.exe && b.family !== 'wininet') seen.add(b.exe);
    return [...seen];
}

/** Every Chromium "User Data" root present, as { id: dir }. */
function chromiumUserData() {
    const out = {};
    for (const b of detectChromium()) if (b.dataDir) out[b.id] = b.dataDir;
    return out;
}

/**
 * Every Gecko profile root belonging to an INSTALLED browser, as { id: dir }.
 * Orphaned roots are excluded -- see detect() and orphanProfiles().
 */
function geckoProfileRoots() {
    const out = {};
    for (const b of detectGecko()) if (b.dataDir) out[b.id] = b.dataDir;
    return out;
}

/** Look one up by id, from the full table (installed or not). */
function byId(id) { return ALL.find(b => b.id === id) || null; }

/**
 * Display names for a list of ids, in table order.
 *
 * Ids are what the code passes around -- they are stable, they key the
 * journal and they never change with a rebrand. Names are what the user
 * reads. This is the single conversion point, so a log line or a toast can
 * never end up saying "operagx".
 */
function names(ids) {
    const want = new Set(ids || []);
    return ALL.filter(b => want.has(b.id)).map(b => b.name);
}

module.exports = { ALL, CHROMIUM, GECKO, WININET, expand, firstExisting,
                   detect, detectChromium, detectGecko, orphanProfiles,
                   policyRoots, processNames, chromiumUserData,
                   geckoProfileRoots, byId, names, regExePaths, resetCache };
