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
//    * A local CRX **path** in the External Extensions registry key. Refused
//      by Chrome since version 33 and measured to be refused by all three.
//      The `update_url` value under the same key is a DIFFERENT provider
//      path in Chromium and is not covered by that refusal -- it is the one
//      documented way an installer offers an extension to a browser it does
//      not own. It is written by lib/geo-ext.js installExternal() and is
//      never reported as coverage until presence() reads it back out of the
//      browser's own profile.
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
//  extkey      HKLM subkey of the fork's own EXTERNAL EXTENSIONS provider
//              (SOFTWARE\<vendor>\<browser>\Extensions), or null where the
//              vendor path is not published. This is NOT the policy tree and
//              NOT the refused local-CRX variant: the value written under
//              <extkey>\<id> here is `update_url`, which is the documented
//              way a third-party installer offers an extension to a browser.
//              Chromium reads this provider ONCE, while the browser starts,
//              which is why the boot pass exists -- see lib/installer-tasks.js.
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
        extkey: 'SOFTWARE\\Microsoft\\Edge\\Extensions',
        userData: ['%LOCALAPPDATA%\\Microsoft\\Edge\\User Data'],
        exePaths: ['%PROGRAMFILES(X86)%\\Microsoft\\Edge\\Application\\msedge.exe',
                   '%PROGRAMFILES%\\Microsoft\\Edge\\Application\\msedge.exe'],
        startMenu: 'Microsoft Edge',
    },
    {
        id: 'chrome', name: 'Google Chrome', family: 'chromium', exe: 'chrome.exe',
        settings: 'chrome://extensions',
        policy: 'SOFTWARE\\Policies\\Google\\Chrome', forcelist: 'refused',
        extkey: 'SOFTWARE\\Google\\Chrome\\Extensions',
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
        //  Brave's product key is Brave-Browser, not Brave -- the policy root
        //  and the external-extensions root do NOT share a spelling.
        extkey: 'SOFTWARE\\BraveSoftware\\Brave-Browser\\Extensions',
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
        extkey: 'SOFTWARE\\Vivaldi\\Extensions',
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
        //  Opera's own company/product registry pair is not published, and a
        //  guessed extkey would create a key no browser ever reads -- litter
        //  that the uninstaller would then have to clean up for nothing.
        extkey: null,
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
        extkey: null,
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
        extkey: 'SOFTWARE\\Yandex\\YandexBrowser\\Extensions',
        userData: ['%LOCALAPPDATA%\\Yandex\\YandexBrowser\\User Data'],
        exePaths: ['%LOCALAPPDATA%\\Yandex\\YandexBrowser\\Application\\browser.exe',
                   '%PROGRAMFILES(X86)%\\Yandex\\YandexBrowser\\Application\\browser.exe'],
        startMenu: 'YandexBrowser',
    },
    {
        id: 'chromium', name: 'Chromium', family: 'chromium', exe: 'chrome.exe',
        settings: 'chrome://extensions',
        policy: 'SOFTWARE\\Policies\\Chromium', forcelist: 'unknown',
        extkey: 'SOFTWARE\\Chromium\\Extensions',
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
 * HKLM external-extension roots, for the Chromium forks whose vendor path is
 * published. Same scope rule as policyRoots(): write to what is installed,
 * sweep the whole table when clearing.
 *
 * `views` is the pair of registry views to touch. A 32-bit browser reads the
 * 32-bit view, a 64-bit one reads the 64-bit view, and reg.exe writes only the
 * view of the process that called it -- so a single write can land where the
 * browser never looks. Writing both is two calls and removes the question.
 *
 * @param {'installed'|'all'} scope
 */
function externalRoots(scope = 'installed') {
    const rows = scope === 'all' ? CHROMIUM : detectChromium();
    return rows.filter(b => b.extkey)
               .map(b => ({ id: b.id, name: b.name, key: 'HKLM\\' + b.extkey }));
}

/** The registry views a Chromium fork may read its providers from. */
const REG_VIEWS = ['64', '32'];

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

// ════════════════════════════════════════════════════════════════════
//  "Is it in this profile" is TWO questions, and conflating them is a lie
// ════════════════════════════════════════════════════════════════════
//  MEASURED on this machine, with the delivery helper alive on the port the
//  policies name, each browser started fresh and its profile read back:
//
//      Edge    location 7 (EXTERNAL_POLICY_DOWNLOAD)  disable_reasons absent
//              ack_external:true, service worker started   -> RUNNING
//      Chrome  location 6 (EXTERNAL_PREF_DOWNLOAD)    disable_reasons [8192]
//      Brave   location 6 (EXTERNAL_PREF_DOWNLOAD)    disable_reasons [8192]
//
//  8192 is DISABLE_EXTERNAL_EXTENSION: the bytes are unpacked in the profile
//  and the extension is switched OFF until the user accepts the prompt Chromium
//  shows for anything an installer offered. So on Chrome and Brave "the files
//  are there" and "the location is being spoofed" are different facts, hours
//  apart, and a single boolean cannot carry both.
//
//  The delivery helper wants the first (nothing left to serve -> exit). The
//  coverage report wants the second, and must never print a browser as spoofed
//  on the strength of the first. Hence one reader, two answers.
const DISABLE_REASON = {
    1: 'USER_ACTION', 2: 'PERMISSIONS_INCREASE', 4: 'RELOAD',
    8: 'UNSUPPORTED_REQUIREMENT', 16: 'SIDELOAD_WIPEOUT', 256: 'NOT_VERIFIED',
    512: 'GREYLIST', 1024: 'CORRUPTED', 2048: 'REMOTE_INSTALL',
    8192: 'EXTERNAL_EXTENSION', 16384: 'UPDATE_REQUIRED_BY_POLICY',
    32768: 'CUSTODIAN_APPROVAL_REQUIRED', 65536: 'BLOCKED_BY_POLICY',
    262144: 'NOT_ALLOWLISTED', 524288: 'UNSUPPORTED_MANIFEST_VERSION',
};
//  extensions/common/mojom/manifest.mojom, Location. Only used for reporting;
//  nothing branches on it, because a route that installed is a route that
//  installed however it got there.
const EXT_LOCATION = {
    1: 'INTERNAL', 2: 'EXTERNAL_PREF', 3: 'EXTERNAL_REGISTRY', 4: 'UNPACKED',
    5: 'COMPONENT', 6: 'EXTERNAL_PREF_DOWNLOAD', 7: 'EXTERNAL_POLICY_DOWNLOAD',
    8: 'COMMAND_LINE', 9: 'EXTERNAL_POLICY', 10: 'EXTERNAL_COMPONENT',
};
//  Extension::State. 2 is EXTERNAL_EXTENSION_UNINSTALLED -- the user was shown
//  the prompt and said Remove. Chromium records that and never offers it again,
//  which is a decision to respect, not a delivery failure to retry forever.
const STATE_DISABLED = 0, STATE_REMOVED_BY_USER = 2;

const PROFILE_DIR = /^(Default|Profile \d+)$/;

function readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

//  Chromium leaves an EMPTY record behind -- `"<id>": {}` -- when an install is
//  removed or never completes. Measured on this machine 2026-08-30: Edge held
//  the extension at location 7 with its service worker running, then lost it at
//  a later start (the port its policy names was dead by then), and what stayed
//  in Secure Preferences was `{}` with the unpacked folder gone.
//
//  A reader that counts any record as an install calls that profile present AND
//  enabled -- there is no location to contradict it, no disable bit, no state --
//  which is the exact opposite of the truth. It is what made --fp-deliver log
//  "Every installed browser already has the extension -- nothing to serve" and
//  exit while Edge had nothing at all.
//
//  So a record must carry something before it counts as one. Anything Chromium
//  writes for a real install has at least a location, a state, a manifest copy
//  or a path.
function hasSubstance(entry) {
    if (!entry || typeof entry !== 'object') return false;
    if (entry.location !== undefined && entry.location !== null &&
        Number.isFinite(Number(entry.location))) return true;
    if (typeof entry.state === 'number') return true;
    return !!(entry.manifest || entry.path);
}

/**
 * What this browser has actually done with our extension id, per profile.
 *
 * Reads the browser's own prefs -- never what we wrote, never what we hoped.
 * Secure Preferences first: an externally-offered extension is recorded there
 * (it is the HMAC-protected store), and only a hand-loaded one may live in
 * plain Preferences.
 *
 * @param {string} userData  a Chromium "User Data" root
 * @param {string} id        32-letter extension id
 * @returns {{present: boolean, enabled: boolean, removedByUser: boolean,
 *            profile: string|null, location: number|null, locationName: string,
 *            disabled: string[], version: string|null, unpacked: boolean,
 *            husk: boolean}}
 */
function extensionState(userData, id) {
    const none = { present: false, enabled: false, removedByUser: false, profile: null,
                   location: null, locationName: '', disabled: [], version: null,
                   unpacked: false, husk: false };
    if (!userData || !id) return none;
    let profiles = [];
    try { profiles = fs.readdirSync(userData).filter(d => PROFILE_DIR.test(d)); }
    catch (e) { return none; }

    let best = null;
    for (const p of profiles) {
        const folder = fs.existsSync(path.join(userData, p, 'Extensions', id));
        let entry = null, where = null, husk = false, unreadable = false;
        for (const f of ['Secure Preferences', 'Preferences']) {
            const file = path.join(userData, p, f);
            const j = readJson(file);
            if (!j) { if (fs.existsSync(file)) unreadable = true; continue; }
            const s = j.extensions && j.extensions.settings && j.extensions.settings[id];
            if (!s) continue;
            //  An empty husk in the protected store does not end the search --
            //  a hand-loaded copy would be in plain Preferences, and it is the
            //  one that answers the question.
            if (hasSubstance(s)) { entry = s; where = f; break; }
            husk = true;
        }
        //  A profile that mentions the id nowhere in either file and has no
        //  folder has nothing to say. The text search is a last resort for a
        //  prefs file that is LOCKED mid-write, so a browser that is busy does
        //  not read as "gone" -- a file we parsed cleanly has already given its
        //  answer, and for a husk that answer is no.
        let mentioned = false;
        if (!entry && !folder && unreadable) {
            for (const f of ['Preferences', 'Secure Preferences']) {
                try {
                    if (fs.readFileSync(path.join(userData, p, f), 'utf8').includes(id)) {
                        mentioned = true; break;
                    }
                } catch (e) { /* absent or locked */ }
            }
        }
        if (!entry && !folder && !mentioned && !husk) continue;

        const raw = entry ? entry.disable_reasons : undefined;
        const bits = (Array.isArray(raw) ? raw : (typeof raw === 'number' ? [raw] : []))
            .reduce((a, n) => a | (Number(n) || 0), 0);
        const state = entry && typeof entry.state === 'number' ? entry.state : null;
        const removedByUser = state === STATE_REMOVED_BY_USER;
        const loc = entry && Number.isFinite(Number(entry.location))
            ? Number(entry.location) : null;
        const row = {
            present: !removedByUser && (folder || !!entry || mentioned),
            //  Enabled needs a positive answer from the browser: an entry, no
            //  disable bit, and not the explicit disabled state. "No entry" is
            //  not enough -- that is where a locked prefs read lands.
            enabled: !!entry && !removedByUser && bits === 0 && state !== STATE_DISABLED,
            removedByUser,
            profile: p,
            location: loc,
            locationName: loc !== null ? (EXT_LOCATION[loc] || String(loc)) : (where ? '?' : ''),
            disabled: Object.keys(DISABLE_REASON)
                .filter(k => bits & Number(k)).map(k => DISABLE_REASON[k]),
            version: (entry && entry.manifest && entry.manifest.version) || null,
            unpacked: loc === 4,
            //  The browser kept a record and threw the install away. Reported so
            //  a probe can say WHY a browser with a policy naming our id has
            //  nothing, instead of leaving it as an unexplained absence.
            husk: husk && !entry,
        };
        //  Several profiles can each have their own answer. The best one wins,
        //  because "is the user's browser spoofing" is answered by the profile
        //  where it IS, not by whichever directory sorted first.
        const rank = r => (r.enabled ? 3 : r.present ? 2 : r.removedByUser ? 1 : 0);
        if (!best || rank(row) > rank(best)) best = row;
    }
    return best || none;
}

/**
 * Are the extension's files in this profile at all?
 *
 * The delivery helper's exit condition, and nothing else: once the bytes are
 * unpacked in the profile there is nothing left for a local HTTP server to
 * hand over, whether or not the user has accepted it yet.
 *
 * Lives here, in the module both lib/geo-ext.js and lib/ext-deliver.js already
 * depend on, so neither has to require the other -- ext-deliver is required BY
 * geo-ext, and a cycle between them would leave one of the two half-loaded
 * depending on who was imported first.
 *
 * NOT the same question as "is the location being spoofed there" -- see
 * extensionState() above, and presence() in lib/geo-ext.js, which is the only
 * thing allowed to answer that one.
 */
function profileHasExtension(userData, id) {
    const st = extensionState(userData, id);
    return st.present || st.removedByUser;
}

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
                   policyRoots, externalRoots, REG_VIEWS,
                   processNames, chromiumUserData, profileHasExtension,
                   extensionState, DISABLE_REASON, EXT_LOCATION,
                   geckoProfileRoots, byId, names, regExePaths, resetCache };
