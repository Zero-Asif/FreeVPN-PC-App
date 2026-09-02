// ════════════════════════════════════════════════════════════════════
//  background.js -- service worker
//
//  Two jobs:
//    1. Point this browser at the desktop app's Tor SOCKS port while the
//       VPN is connected (and let go of it when it is not).
//    2. Mirror the connected country's coordinates into
//       chrome.storage.local, where geo-bridge.js picks them up and hands
//       them to geo-spoof.js in the page's own world.
//
//  Job 2 is the part that actually changes what a website sees. Chromium's
//  network location provider POSTs the surrounding Wi-Fi BSSIDs to Google,
//  which resolves them against its own survey database -- so the position
//  it returns has nothing to do with the exit IP, and routing that request
//  through Tor does not move it. Replacing navigator.geolocation is the
//  only honest way to report the connected country instead.
// ════════════════════════════════════════════════════════════════════
const desktopAppUrl = "ws://127.0.0.1:8080";
const SOCKS_HOST = "127.0.0.1";
const SOCKS_PORT = 9050;

let socket = null;
let keepAliveInterval = null;
let reconnectTimer = null;
let reconnectDelay = 2000;          // grows on repeated failure, see scheduleReconnect()

// গ্লোবাল স্ট্যাটাস যা অ্যাপের সাথে সিঙ্ক হবে
//
//  `busy` and `progress` mirror the desktop app's own connect progress. They
//  are NOT derived from anything this worker knows: the app is the only thing
//  that can say how far a Tor bootstrap has got, so guessing here would be
//  the fake progress bar every VPN has and nobody believes.
//
//  `ask` is the same idea for a question rather than a number: when the country
//  the user picked has no reachable exit node, the app stops and asks instead of
//  substituting another country, and it is blocked on the answer until one
//  arrives. This worker only carries the question to the popup and the answer
//  back; it never answers on the user's behalf and never invents a question.
let globalState = { connected: false, server: 'us', killSwitch: false, bypassList: '',
                    appRunning: false, busy: false, progress: null, ask: null };


// ── "A new extension was installed" -- the announcement ─────────────
//  WHY THIS IS HERE AT ALL
//  This extension does not arrive from a store. The desktop app's installer
//  writes an ExtensionInstallForcelist policy, and the browser picks it up on
//  its next start -- so without this block the user's browser simply grows an
//  extension one day with nobody saying so. That is exactly the moment IDM
//  puts its "integration module was added" page on screen, and it is the
//  behaviour being copied here.
//
//  TIMING. A policy-installed extension is installed by the browser during
//  startup, so onInstalled fires while the browser is opening -- which is why
//  the user sees this "the moment they open the browser" rather than at some
//  later point of our choosing. Nothing is scheduled or delayed.
//
//  ONCE, EVER, PER PROFILE. The flag lives in chrome.storage.local, not in a
//  variable: a service worker is torn down after ~30 s idle, so anything held
//  in memory would re-announce on the next wake. It also covers the case that
//  would otherwise be intolerable -- Brave and Edge are given this extension
//  with --load-extension in some setups, and that re-runs the install every
//  single browser start, so an unguarded onInstalled would open a tab every
//  morning forever.
//
//  WHAT IT DOES NOT DO. It does not claim the VPN is on. welcome.html asks
//  background.js for the live state and says "not running" when that is the
//  truth; see welcome.js.
const WELCOME_PAGE = 'welcome.html';
const WELCOME_FLAG = 'welcomeShownAt';

function badgeNew() {
    //  The badge is the part that survives the user closing the tab straight
    //  away: something on the toolbar still says "there is something new
    //  here". welcome.js clears it via WELCOME_SEEN.
    try {
        chrome.action.setBadgeText({ text: 'NEW' });
        chrome.action.setBadgeBackgroundColor({ color: '#7c3aed' });
    } catch (e) {}
}

function clearBadge() {
    try { chrome.action.setBadgeText({ text: '' }); } catch (e) {}
}

function notifyInstalled() {
    //  Best-effort: notifications can be switched off for the whole browser,
    //  and on Windows they can be suppressed by Focus Assist. The tab and the
    //  badge are the parts that do not depend on that, so a failure here is
    //  swallowed rather than retried.
    try {
        chrome.notifications.create('fp-installed', {
            type: 'basic',
            iconUrl: chrome.runtime.getURL('icon.png'),
            title: 'FreeProxy VPN extension installed',
            message: 'This browser can now be routed through FreeProxy VPN, and ' +
                     'websites will be told the country you connect to instead of ' +
                     'your real location.',
            priority: 2,
        }, () => void chrome.runtime.lastError);
    } catch (e) {}
}

//  Opened active on purpose. A tab that appears behind the ones being restored
//  is a tab nobody reads, and the whole point is that the user is TOLD.
function announceOnce(force) {
    chrome.storage.local.get([WELCOME_FLAG], got => {
        if (!force && got && got[WELCOME_FLAG]) return;
        chrome.storage.local.set({ [WELCOME_FLAG]: new Date().toISOString() });
        badgeNew();
        notifyInstalled();
        try {
            chrome.tabs.create({ url: chrome.runtime.getURL(WELCOME_PAGE), active: true });
        } catch (e) {}
    });
}

chrome.runtime.onInstalled.addListener(details => {
    //  'install' is a first install into this profile. 'update' is a version
    //  bump -- lib/geo-ext.js bumps the 4th version component whenever the
    //  packaged files really change, so an update happens on ordinary app
    //  upgrades and must NOT re-announce; it is not news to the user.
    if (details && details.reason === 'install') announceOnce(false);
});

//  The safety net for a first install the user could not have seen: the
//  browser installed the extension, the worker was torn down before the tab
//  could be created (a slow startup, a profile that opens with twenty tabs),
//  or the policy landed while a browser window was closing. The flag makes
//  this a no-op in every normal case.
chrome.runtime.onStartup.addListener(() => announceOnce(false));

// ── Proxy ───────────────────────────────────────────────────────────
//  WHY THIS ONE HAS A WATCHDOG ON IT
//
//  THE REPORT. "app e jokhon kono country te connected thakchena tokhon brave
//  kono net pacchena but jekono country te connect korar sathe sathe pacche."
//  Brave showed ERR_PROXY_CONNECTION_FAILED with the app shut down and started
//  working the instant any country connected.
//
//  MEASURED, not guessed -- .build/probe-brave-proxy-stuck.js and
//  .build/probe-brave-proxy-who.js, run with the app not running and nothing
//  listening on 9050. Every OTHER proxy layer was already off:
//
//      HKCU ..\Internet Settings    ProxyEnable = 0, ProxyServer empty
//      netsh winhttp                direct access, no proxy server
//      HKLM policy hives            no ProxySettings in Brave, Chrome or Edge
//
//  ...and Brave's own profile still held ours, verbatim:
//
//      Secure Preferences -> extensions.settings.<id>.preferences.proxy
//      {"bypass_list":"localhost,127.0.0.1,<local>",
//       "mode":"fixed_servers","server":"socks5://127.0.0.1:9050"}
//
//  So nothing "saved it again". That is the value THIS function wrote, and it
//  was never taken back.
//
//  WHY IT WAS NEVER TAKEN BACK. chrome.proxy.settings.set({scope:'regular'})
//  is a PERSISTENT extension-controlled pref. It outlives the page, the service
//  worker and the browser, and only clear(), disabling the extension or
//  uninstalling it releases it. Every clear() in this file is reached from a
//  LIVE service worker -- module evaluation, the socket's onclose, or a
//  STATE_SYNC saying connected:false. An MV3 worker is torn down after about
//  30 s idle, and once it is torn down with the proxy still set there is no
//  event left that can wake it: the browser cannot load a page, because the
//  proxy it was told to use is dead, and a failed navigation is not an event
//  this extension listens for. Nothing recovers from that on its own.
//  "Connect to any country" appeared to fix it only because it made the port
//  answer again.
//
//  THE WATCHDOG. chrome.alarms is the one thing that reliably starts an evicted
//  worker, and starting it is the whole fix: module evaluation below already
//  calls setBrowserProxy(false). The alarm is armed ONLY while the proxy is set
//  and cancelled the moment it is cleared, so a browser already in the safe
//  state is never woken; and while the app is alive every STATE_SYNC re-arms it,
//  which pushes the deadline out -- so it can only reach zero after the app has
//  stopped talking altogether.
const PROXY_GUARD = 'fp-proxy-guard';
//  30 s. Chromium's floor for a repeating alarm since Chrome 120 (Brave here is
//  Chromium 152), and half the ~30 s idle window that loses the worker in the
//  first place, so at most one check can be missed before the next one lands.
const PROXY_GUARD_MIN = 0.5;

//  chrome.alarms is absent in a browser that never granted the permission, and a
//  throw here would abort module evaluation -- which is what clears the proxy and
//  starts the socket -- so this is guarded rather than assumed. A browser without
//  it is no worse off than before this watchdog existed.
function armProxyGuard(on) {
    try {
        if (!chrome.alarms) return;
        if (on) chrome.alarms.create(PROXY_GUARD,
            { delayInMinutes: PROXY_GUARD_MIN, periodInMinutes: PROXY_GUARD_MIN });
        else chrome.alarms.clear(PROXY_GUARD, () => void chrome.runtime.lastError);
    } catch (e) {}
}

//  WHAT "OFF" HAS TO MEAN, and why clear() was the wrong answer.
//  .build/probe-socks-catches-brave.js caught Brave sending every request -- pages,
//  favicons, go-updater.brave.com -- to a stub SOCKS5 server on 127.0.0.1:9050 with
//  the app shut down, still going at 16.8 s: long past the 11.1 s at which
//  .build/probe-brave-start-clears.js timed this file releasing. Both are true at
//  once because clear() does not mean "no proxy", it means "I relinquish" -- and
//  Chromium then applies the next value in the store. Here that is a FOSSIL
//  extensions.settings record, id egclniilmgnaildaaiccpmakehnhledg, left by a
//  keyless load of this same folder and holding fixed_servers
//  socks5://127.0.0.1:9050. No worker will ever run for that id, so no code in this
//  file can release it, and it lives in MAC-protected Secure Preferences, so nothing
//  outside the browser may edit it either.
//
//  .build/probe-pref-precedence.js measured the way out -- two throwaway extensions
//  in a throwaway profile, the older holding fixed_servers, the newer either
//  clearing or writing a mode of its own:
//      clear()                -> the page went through 9050   (the live bug)
//      set({mode:'direct'})   -> the page went direct, and was STILL direct after a
//                                restart with nothing writing anything at all
//  A written value outranks the older record; an absent one loses to it.
//
//  So "off" WRITES mode:'direct'. That also closes the 11.1 s hole no ordering
//  inside this file could reach, because the value is in the profile before any
//  worker starts -- measured at 183 ms into a cold start. The cost is deliberate:
//  while the VPN is off, a proxy the user set in Windows is bypassed in this
//  browser. That is the right trade for a VPN whose own app writes that same Windows
//  layer and can be killed still holding it; deferring to it with mode:'system'
//  would inherit exactly the strand this exists to fix.
//
//  `done` is called once the browser has actually applied the change, not when
//  the request was made. Anything that depends on the new proxy being in force
//  -- reloading the tabs a dead proxy broke, above all -- has to be issued from
//  there: chrome.tabs.reload and chrome.proxy.settings travel separate channels,
//  so a reload fired in the same tick as the release can be dispatched while the
//  dead SOCKS server is still configured, fail identically, and leave the user
//  looking at the same error page the repair was supposed to remove.
function setBrowserProxy(enabled, bypassList, done) {
    const settled = () => {
        //  Reading lastError swallows the "controlled by policy" complaint
        //  that appears when the desktop app has already written the
        //  enterprise ProxySettings policy. Both point at the same Tor
        //  listener, so the policy winning is not a problem.
        void chrome.runtime.lastError;
        if (done) { try { done(); } catch (e) {} }
    };
    if (!enabled) {
        //  Disarmed FIRST: once the proxy is going away there is nothing left to
        //  watch, and leaving a periodic alarm behind would wake this worker
        //  every 30 s for the rest of the browser's life.
        armProxyGuard(false);
        //  Unmarked before the write, so a browser killed between the two is
        //  left saying "set" -- which costs one round of tab reloads at the next
        //  start, where the other order would cost the user the internet.
        markProxy(false);
        //  set, NOT clear -- see the block above. Clearing hands the pref back to a
        //  record that cannot be released; writing masks it.
        chrome.proxy.settings.set({ value: { mode: 'direct' }, scope: 'regular' }, settled);
        return;
    }

    //  Split-tunnel entries from the desktop app are honoured here too, so
    //  a site the user excluded behaves the same in the browser as it does
    //  system-wide.
    const bypass = ["localhost", "127.0.0.1", "<local>"];
    if (bypassList && bypassList.trim()) {
        bypassList.replace(/,/g, ';').split(';').forEach(raw => {
            const host = raw.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/[\*\s]/g, '');
            if (host) bypass.push('*' + host, host);
        });
    }
    //  Armed BEFORE the write, not after. The window between the two is exactly
    //  where a worker teardown would leave a proxy nobody is watching.
    armProxyGuard(true);
    //  Marked before the write, for the same reason: a mark that says "set" when
    //  it is not costs a reload, a mark that says "clear" when it is not costs
    //  the internet.
    markProxy(true);
    chrome.proxy.settings.set({
        value: {
            mode: "fixed_servers",
            rules: {
                singleProxy: { scheme: "socks5", host: SOCKS_HOST, port: SOCKS_PORT },
                bypassList: bypass,
            },
        },
        scope: 'regular',
    }, settled);
}

//  Registered at module scope, which for a service worker is the only place a
//  listener can be registered and still be there when the browser wakes the
//  worker to deliver the event.
//
//  Waking the worker is 90% of the repair: module evaluation at the bottom of
//  this file calls setBrowserProxy(false) before this handler can run, so by the
//  time the alarm is delivered the browser is already off the dead proxy. This
//  handler covers the other case -- a worker that is awake, holding a socket
//  that is neither open nor coming back.
if (chrome.alarms && chrome.alarms.onAlarm) {
    chrome.alarms.onAlarm.addListener(alarm => {
        if (!alarm || alarm.name !== PROXY_GUARD) return;
        //  OPEN: the app is there and this browser is meant to be on Tor.
        //  CONNECTING: a worker that has just started and not heard back yet --
        //  module evaluation has already cleared the proxy in that case, so
        //  clearing again would only add noise. Neither is a reason to act.
        const live = socket && (socket.readyState === WebSocket.OPEN ||
                                socket.readyState === WebSocket.CONNECTING);
        if (live) return;
        console.warn('FreeProxy: the desktop app is not answering and this browser was ' +
                     'still pointed at its Tor port -- releasing the proxy so the browser ' +
                     'is not left with no internet');
        //  If this browser STARTED with the proxy still set, the pages it opened
        //  before this worker existed are error pages that will not retry
        //  themselves. This is one of the two places that knows it: the app is
        //  not answering, so nothing was listening on 9050 either.
        setBrowserProxy(false, null, () => settleStrandRepair(true));
        //  And pick the socket back up. The reconnect chain is setTimeout-based,
        //  a torn-down worker loses its timers, and without this the extension
        //  would never notice the app coming back either.
        if (!reconnectTimer) connectToDesktop();
    });
}

// ── The proxy gets stranded by the ORDER things close in ────────────
//  Measured 2026-09-02 with the app shut down, Tor down and nothing answering
//  on 9050: Brave's profile still held
//      {"mode":"fixed_servers","server":"socks5://127.0.0.1:9050"}
//  on THIS extension's own record, while Chrome's and Edge's records held an
//  empty preferences bucket. The difference was never the extension -- all
//  three had the same version with the same permissions. It was the order:
//  Brave was closed first, while the app was still connected, so onclose never
//  ran and no alarm can run in a browser that is not running. The pref is
//  persistent, so the next start read it straight back and every page failed
//  with ERR_PROXY_CONNECTION_FAILED.
//
//  Starting the browser does repair it, but far too late to matter.
//  .build/probe-brave-start-clears.js launched Brave against that exact
//  profile and watched the file: the release landed 11.1 s later. That is how
//  long the browser took to START THE WORKER, so no reordering inside this
//  file can shorten it -- everything opened in those eleven seconds fails.
//
//  So the proxy is released when the last window goes, while a worker is still
//  alive to do it. Nothing is browsing at that moment -- with no window there
//  is no page -- so this cannot take a live VPN's proxy away from anything.
//  chrome.windows.onRemoved needs no permission, so nothing has to be
//  re-approved for it.
if (chrome.windows && chrome.windows.onRemoved) {
    chrome.windows.onRemoved.addListener(() => {
        chrome.windows.getAll({}, wins => {
            void chrome.runtime.lastError;
            //  Closing one window of several is not the browser going away.
            if (wins && wins.length) return;
            setBrowserProxy(false);
        });
    });
}

//  And put it back when a window opens again with the app still connected.
//  Without this the release above would be a leak rather than a fix: a browser
//  that keeps running after its last window closes -- Chromium's background
//  mode, or a lingering worker -- would come back with no proxy while the app
//  still says connected, and the real IP would be on the wire with the UI
//  claiming otherwise. A worker that was evicted in between has already had
//  the proxy cleared by module evaluation and gets it back from STATE_SYNC.
if (chrome.windows && chrome.windows.onCreated) {
    chrome.windows.onCreated.addListener(() => {
        if (globalState && globalState.connected)
            setBrowserProxy(true, globalState.bypassList);
    });
}

// ── A profile that is ALREADY stranded ──────────────────────────────
//  The release above stops this being created from a clean close, but a
//  browser that was killed, crashed or cut off by a shutdown never runs it --
//  and the profile measured above was in exactly that state. Module evaluation
//  repairs it, 11 s later, and the pages that failed while the worker was
//  starting stay failed: a Chromium error page does not retry itself. So they
//  are reloaded, once, and only in the case that actually stranded them.
//
//  The signal is a mark in storage rather than a read of the pref itself.
//  Module evaluation clears the proxy unconditionally, so by the time any
//  chrome.proxy.settings.get() callback runs, "was set at startup" and "was
//  never set" look identical -- while storage operations on one area are
//  queued in the order they were issued, so a mark read here is the mark this
//  browser started with.
const PROXY_MARK = 'fpProxyLeftOn';
let proxyMarked = null;                 // what the mark says, as far as we know
let markSweptOnce = false;              // the one decision this worker gets

function markProxy(on) {
    if (proxyMarked === on) return;     // STATE_SYNC arrives constantly; the mark does not change
    proxyMarked = on;
    try {
        if (on) chrome.storage.local.set({ [PROXY_MARK]: true }, () => void chrome.runtime.lastError);
        else chrome.storage.local.remove(PROXY_MARK, () => void chrome.runtime.lastError);
    } catch (e) {}
}

//  A PROMISE, not a flag. The read is issued at module scope and the things that
//  consume it -- socket.onclose, the guard alarm, the first STATE_SYNC -- can all
//  happen before it answers: a refused dial to a dead loopback port is a SYN and
//  an RST, while this may have to open the profile's LevelDB from a cold disk.
//  Reading a boolean that has not been filled in yet is how the country-switch
//  purge was lost once already, so the decision is queued behind the read
//  instead of racing it.
let strandedRead = Promise.resolve(false);
try {
    strandedRead = new Promise(resolve => {
        chrome.storage.local.get(PROXY_MARK, got => {
            void chrome.runtime.lastError;
            resolve(!!(got && got[PROXY_MARK]));
        });
    });
} catch (e) { /* strandedRead stays "nothing was marked" */ }

/**
 * Settle, once and for all, whether this worker owes the profile a reload.
 *
 * `pagesFailed` is the caller's answer to one question: was the pref this
 * profile started with pointing at a Tor that was NOT listening? Only the app
 * knows that, so only the places that have just heard from it -- or failed to --
 * may call this.
 *
 * Both answers are final. A reload throws away scroll position and half-written
 * forms, so it is owed only where the pages are certain to be error pages: 9050
 * dead for the eleven seconds before this worker existed. With the app connected
 * those same pages loaded perfectly well, and the mark must then be spent
 * WITHOUT a sweep -- otherwise the reload would sit armed and fire on the user's
 * next ordinary disconnect, long after everything had loaded fine.
 *
 * One decision per worker either way: the mark cannot become true later, so a
 * second call has nothing new to decide. That is also what stops the reconnect
 * chain -- onclose every few seconds for as long as the app stays down -- from
 * turning the repair into a reload loop.
 */
function settleStrandRepair(pagesFailed) {
    if (markSweptOnce) return;
    markSweptOnce = true;
    if (!pagesFailed) return;
    strandedRead.then(marked => {
        if (!marked) return;
        console.warn('FreeProxy: this browser started with the extension proxy still set ' +
                     'from a previous session -- it has been released, and the tabs that ' +
                     'could not load because of it are being reloaded');
        //  http/https only, so a pinned new-tab page or an extension page is
        //  left alone.
        try {
            chrome.tabs.query({}, tabs => {
                void chrome.runtime.lastError;
                (tabs || []).forEach(t => {
                    if (!t || !t.id || !/^https?:/i.test(String(t.url || ''))) return;
                    chrome.tabs.reload(t.id, {}, () => void chrome.runtime.lastError);
                });
            });
        } catch (e) {}
    });
}

// ── Geolocation payload ─────────────────────────────────────────────
//  The desktop app sends the coordinates for the country it VERIFIED the
//  exit in, so what the page reports always agrees with the visible IP.
//
//  `geoRecord` is the authoritative copy and it is initialised HERE, at module
//  scope, so it holds a correct value before any listener in this worker can
//  possibly run. chrome.storage.local is a mirror of it: storage is how a live
//  change reaches pages that are already open (via chrome.storage.onChanged in
//  geo-bridge.js), but it must never be the thing a page's FIRST question is
//  answered from -- see the GET_GEO handler below.
let geoRecord = { active: false, pending: true };

function writeGeo(rec) {
    geoRecord = rec;
    try { chrome.storage.local.set({ geoSpoof: rec }); } catch (e) {}
}

function syncGeoSpoof(state) {
    const g = state && state.geo;
    const active = !!(state && state.connected) &&
                   g && typeof g.lat === 'number' && typeof g.lng === 'number';
    const rec = active
        ? { active: true, lat: g.lat, lng: g.lng, accuracy: g.accuracy || 18,
            cc: g.cc || state.serverCode || '', city: g.city || '' }
        : { active: false };
    //  writeGeo FIRST, always. Pages waiting on the new country are unblocked by
    //  that one call, and they must not be made to wait behind a cookie sweep
    //  and a storage clear. noteLocationChange() is asynchronous throughout and
    //  touches nothing geo-spoof.js reads.
    writeGeo(rec);
    noteLocationChange(rec);
}

//  Called once per service-worker start, BEFORE the WebSocket has had any
//  chance to say whether the app is connected.
//
//  Writing {active:false} here -- which is what this used to do -- opens a
//  real leak. geo-spoof.js reads that as "the app says it is not connected"
//  and hands the page straight to Chromium's own provider, which resolves the
//  surrounding Wi-Fi BSSIDs to the device's true position. The window is
//  short, but it is precisely the window that matters: the desktop app
//  restarts the browser at the moment it connects, so the first page the user
//  opens loads while this worker is still starting up. It was measured --
//  .build/test-geo-e2e.js caught the first geolocation call of a session
//  reaching the real provider in both Edge and Brave.
//
//  Leaving the previous session's coordinates in place would be the opposite
//  mistake: once the app has quit they name a country the exit IP no longer
//  backs up.
//
//  So neither. `pending` means "not known yet", and geo-spoof.js holds
//  geolocation calls instead of answering. It is cleared by the first
//  WebSocket outcome either way -- a STATE_SYNC when the app is there,
//  onerror/onclose when nothing is listening -- and on loopback both of those
//  land in milliseconds.
function markGeoPending() {
    writeGeo({ active: false, pending: true });
}

// ── Clearing the previous country out of this browser ────────────────
//  MEASURED on this machine, 2026-09-01, with .build/probe-maps-uule2.js --
//  one Brave, one throwaway profile, a fresh tab per visit:
//
//    visit 1  no UULE cookie yet, page handed Luxembourg
//             -> Google Maps centred on the EXIT IP's own city, NOT on the
//                position it was given
//             -> and Google set  UULE = [1,12,<ts>,null,[496116000,61319000],
//                null,20000]  -- 49.6116,6.1319, the position we reported
//    visit 2  that cookie still there, page handed Amsterdam, NEW tab
//             -> Google Maps centred on LUXEMBOURG, the previous country
//
//  So the stale country is not ours, and it is not a cached copy of our
//  coordinates in page storage -- localStorage and IndexedDB held no position
//  at all. Maps centres the map from the `UULE` cookie when there is one and
//  from the exit IP when there is not, and a cookie outlives the tab and the
//  browser. That is the entire reported bug: switch country, Maps still shows
//  the first one, closing the tab does not help, restarting Brave does not
//  help. It is also why deleting one named cookie fixes it and why clearing
//  page storage on its own would not have.
//
//  What a switch does here, in descending order of how well we know it:
//
//    1. Delete every UULE cookie, wherever it is. Named exactly, because it is
//       the carrier that was measured: Google's session cookies (SID, HSID,
//       __Secure-*) are left alone. Clearing google.com's cookies wholesale
//       would sign the user out of every Google service on every switch.
//    2. Clear cacheStorage / IndexedDB / localStorage / service workers for the
//       origins that were actually handed a position. Any of them may keep its
//       own copy under a key we cannot know, and those are the only sites that
//       could have one. Cookies are deliberately not in this step, for the same
//       sign-out reason.
//    3. Reload those tabs, and only those. A Maps URL that has already been
//       rewritten to /@lat,lng,zoom is pinned to those coordinates and a plain
//       reload would re-centre on the old country, so that segment is dropped
//       -- but only when the pin is the country being left behind. Somewhere
//       the user navigated to themselves is theirs, not ours to move.
//
//  A DISCONNECT runs step 1 only. The cookie would otherwise go on naming a
//  country the user is no longer in, but wiping site storage and reloading tabs
//  at the moment the app quits would be destroying data to no visible end.
const GEO_ORIGINS = 'geoOrigins';   // origins that were handed a position
const GEO_LAST    = 'geoLast';      // the location those origins were told
const MAX_ORIGINS = 40;
//  Cookie names measured to carry a position. A name goes in here when a probe
//  has shown it holding coordinates -- never on the strength of it sounding
//  location-ish, because every name in this list costs the user whatever else
//  that cookie was carrying.
const LOCATION_COOKIES = ['UULE'];

function originOf(url) {
    try {
        const u = new URL(url);
        return (u.protocol === 'http:' || u.protocol === 'https:') ? u.origin : null;
    } catch (e) { return null; }
}

function sameSpot(a, b) {
    if (!a || !b) return false;
    return String(a.cc || '').toUpperCase() === String(b.cc || '').toUpperCase() &&
           Math.abs(a.lat - b.lat) < 0.01 && Math.abs(a.lng - b.lng) < 0.01;
}

//  Everything that reads the origin list and then writes it back goes through
//  here, one at a time -- and so does the record of where this browser last was,
//  because a switch is decided by comparing against it and the comparison is a
//  read-modify-write like any other. One queue rather than two: it is the only
//  way an origin note that arrived before a switch is guaranteed to be in the
//  list that switch reads.
//
//  WHY. chrome.storage.local.get is asynchronous, so two plain
//  read-modify-writes that overlap both read the same list and the second write
//  throws the first one's entry away. That is not hypothetical: a page with
//  cross-origin iframes has one bridge per frame, and if two of them ask for a
//  position in the same tick their two GEO_USED messages arrive together. The
//  lost origin is a site whose storage then survives the next country switch.
//  Measured, for the location record: noteLocationChange().
//
//  A stalled callback would stop the queue -- but a service worker is torn down
//  after ~30 s idle, which drops the chain along with the work it was waiting
//  on, so it cannot stay stuck. Callers whose section MUST end sooner than that
//  deadline their own release; nothing here does it for them.
let originQueue = Promise.resolve();
function serialiseOrigins(fn) {
    originQueue = originQueue
        .then(() => new Promise(res => { try { fn(res); } catch (e) { res(); } }))
        .catch(() => {});
}

//  Kept in storage rather than in a variable, for the same reason the welcome
//  flag is: this worker is torn down after ~30 s idle, and a country switch an
//  hour later still has to know which sites were told the old country. Capped,
//  so a long session cannot grow it without bound -- oldest off the front.
function noteGeoUse(origin) {
    if (!origin || !/^https?:\/\//.test(origin)) return;
    serialiseOrigins(done => {
        chrome.storage.local.get(GEO_ORIGINS, got => {
            const list = Array.isArray(got && got[GEO_ORIGINS]) ? got[GEO_ORIGINS] : [];
            if (list[list.length - 1] === origin) { done(); return; }   // the same page again
            const next = list.filter(o => o !== origin);
            next.push(origin);
            while (next.length > MAX_ORIGINS) next.shift();
            chrome.storage.local.set({ [GEO_ORIGINS]: next }, () => {
                void chrome.runtime.lastError;
                done();
            });
        });
    });
}

//  chrome.cookies.remove() wants a URL, not the domain/path pair getAll()
//  reports back, and a host-only cookie and a domain-wide one need different
//  ones -- so it is rebuilt from each record instead of assuming google.com.
function removeLocationCookies(done) {
    if (!chrome.cookies || !chrome.cookies.getAll) {
        //  Nothing is claimed that was not done: a fork without the API gets a
        //  line saying so, not a silent success.
        console.warn('FreeProxy: chrome.cookies is unavailable in this browser -- ' +
                     'the previous country cannot be cleared from cookies here');
        done(0);
        return;
    }
    let names = LOCATION_COOKIES.length, removed = 0;
    const nameDone = () => { if (--names === 0) done(removed); };
    for (const name of LOCATION_COOKIES) {
        chrome.cookies.getAll({ name }, list => {
            void chrome.runtime.lastError;
            const jar = list || [];
            let left = jar.length;
            if (!left) { nameDone(); return; }
            for (const c of jar) {
                const host = String(c.domain || '').replace(/^\./, '');
                const url = (c.secure ? 'https://' : 'http://') + host + (c.path || '/');
                chrome.cookies.remove({ url, name: c.name, storeId: c.storeId }, r => {
                    void chrome.runtime.lastError;
                    if (r) removed++;
                    if (--left === 0) nameDone();
                });
            }
        });
    }
}

//  The browser-wide wipe the user asked for, in as many words: on EVERY country
//  switch, clear history, cache and cookies. It is deliberately not scoped to
//  origins, because the reported symptom was not scoped either -- after
//  switching country the browser kept showing the FIRST country it had ever
//  connected to, repeatedly, and it kept doing that because a per-origin clear
//  only reaches sites that had already asked for a position. A page that reads
//  the country from a cached response, from its own history entry, or from a
//  cookie set before the extension ever saw it, is untouched by the narrow
//  version and shows the stale country anyway.
//
//  WHAT THIS COSTS, stated rather than designed around: `cookies: true` is
//  browser-wide, so the user is signed out of every site on every country
//  switch. That is the price of the guarantee they asked for twice, and it is
//  the only way to be sure no site is holding the previous country -- a cookie
//  jar cannot be filtered by "does this cookie encode a location", because
//  nothing in a cookie says so. The one cookie MEASURED to carry a position,
//  UULE, is still removed by name as well, in removeLocationCookies(): that
//  runs on disconnect too, where a full wipe would not be proportionate.
//
//  `since: 0` is the whole of recorded time. "Clear the cache" with a window
//  that starts at the switch would leave every page cached before it.
const SWITCH_WIPE = { cache: true, cookies: true, history: true };

function clearBrowserOnSwitch(done) {
    if (!chrome.browsingData || !chrome.browsingData.remove) {
        //  Nothing is claimed that was not done.
        console.warn('FreeProxy: chrome.browsingData is unavailable in this browser -- ' +
                     'history, cache and cookies cannot be cleared for this switch');
        done(false);
        return;
    }
    chrome.browsingData.remove({ since: 0 }, SWITCH_WIPE, () => {
        const err = chrome.runtime.lastError;
        if (err) {
            console.warn('FreeProxy: could not clear history/cache/cookies -- ' + err.message);
            done(false);
            return;
        }
        console.info('FreeProxy: cleared history, cache and cookies for the country switch');
        done(true);
    });
}

//  Site storage, per origin. This is a SEPARATE call from the wipe above and
//  not a duplicate of it: cacheStorage, indexedDB, localStorage and
//  serviceWorkers are not in SWITCH_WIPE, and these are the four that hold a
//  position a page wrote down itself. Scoped to the origins that were actually
//  handed a location, because a Service Worker registration is a site's
//  installed software rather than a trace of browsing, and taking every one on
//  the machine would break offline apps that never asked where the user is.
function clearGeoOriginStorage(origins, done) {
    if (!origins.length) { done(0); return; }
    if (!chrome.browsingData || !chrome.browsingData.remove) {
        console.warn('FreeProxy: chrome.browsingData is unavailable in this browser -- ' +
                     'site storage keeps whatever the previous country left in it');
        done(0);
        return;
    }
    chrome.browsingData.remove({ origins }, {
        cacheStorage: true, indexedDB: true, localStorage: true, serviceWorkers: true,
    }, () => {
        const err = chrome.runtime.lastError;
        if (err) console.warn('FreeProxy: could not clear site storage -- ' + err.message);
        done(err ? 0 : origins.length);
    });
}

//  /maps/@<lat>,<lng>,<zoom> is Maps' own record of where the map is pointed and
//  it wins over both the cookie and the exit IP, so a reload of that URL shows
//  the old country again. Only the pin we are responsible for is dropped:
//  within ~1.5 deg of the country being left, and only when the segment ends
//  the path -- a deeper URL like /maps/place/X/@.../data=... is left to a plain
//  reload rather than risk rebuilding something Maps then cannot parse.
function unpinMaps(url, from) {
    if (!from) return null;
    const m = /^(https?:\/\/[^/]*google\.[^/]+\/maps[^?#]*?)\/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)[^/?#]*(?=$|[?#])(.*)$/
        .exec(String(url));
    if (!m) return null;
    if (Math.abs(+m[2] - from.lat) > 1.5 || Math.abs(+m[3] - from.lng) > 1.5) return null;
    return m[1] + m[4];
}

//  Two kinds of tab have to be made to ask again, and only the first of them is
//  in `origins`:
//
//   1. a page that was HANDED a position through the geolocation API. It is on
//      the list because geo-bridge.js said so.
//   2. a page that is displaying a location it never asked us for. Google Maps
//      is the measured case (.build/probe-maps-uule2.js): it centres from the
//      UULE cookie and from its own /maps/@lat,lng URL, and in that run it did
//      NOT call the geolocation API at all -- so it is invisible to the origin
//      list, and after a switch it goes on showing the previous country for as
//      long as the tab is open. That is the reported symptom, exactly.
//
//  So the maps sweep is not gated on the list. It is still narrow: unpinMaps()
//  only matches a pin within ~1.5 deg of the country being LEFT, so a map the
//  user pointed somewhere else themselves is not touched, and a tab that is
//  neither on the list nor pinned to the old country is left alone -- which
//  test-geo-purge.js asserts with a second origin that never asks for a
//  position and must keep both its document and its localStorage.
function reloadGeoUsers(origins, from) {
    if (!chrome.tabs || !chrome.tabs.query) return;
    const want = new Set(origins);
    chrome.tabs.query({}, tabs => {
        void chrome.runtime.lastError;
        for (const t of tabs || []) {
            const o = originOf(t.url || '');
            if (!o) continue;
            const clean = unpinMaps(t.url, from);
            if (!want.has(o) && !clean) continue;
            try {
                if (clean && clean !== t.url) chrome.tabs.update(t.id, { url: clean });
                else chrome.tabs.reload(t.id, { bypassCache: true });
            } catch (e) { /* tab closed underneath us */ }
        }
    });
}

/**
 * @param from {{cc,lat,lng}|null} the location the sites were previously told
 * @param deep true on a country switch, false on a disconnect -- see the block
 *        above GEO_ORIGINS for why a disconnect stops at the cookie.
 */
//  Every stage below is entered from a browser callback, and a callback is not a
//  promise: nothing guarantees it arrives. So each stage is armed with a deadline,
//  and a stage that has not reported back by then is carried on past instead of
//  waited on for ever. The deadlines are deliberately unequal -- see below.
//
//  HONEST HISTORY, because it decided the real fix. These deadlines were added
//  first, on the theory that the intermittent Brave failure was a lost callback
//  mid-chain: the kept profile of a red .build/test-geo-purge.js run showed
//  `geoSpoof` and `geoLast` both moved LU -> JP while `geoOrigins` still held
//  ["http://127.0.0.1:8099"] at exit, which looks exactly like a chain that died
//  after the cookie sweep. They changed nothing -- and THAT is what identified the
//  real cause: a deadline covers a stage that stalled, so a fix that changes
//  nothing proves the purge was never entered. It was a read-modify-write race in
//  noteLocationChange(), fixed there, evidenced there.
//
//  They are kept because the reasoning above is still true -- a lost callback IS
//  possible, .build/test-geo-switch.js covers both stalls with a stub that accepts
//  the call and never answers, and the cost of arming a timer is nothing.
const STAGE_COOKIE_MS = 2000;    // a name lookup in the jar; fast, or lost
const STAGE_WIPE_MS   = 8000;    // cache+history over all recorded time; slow

function once(fn) {
    let ran = false;
    return (...a) => { if (ran) return; ran = true; fn(...a); };
}

function purgeLocationTraces(from, deep) {
    //  Strictly sequenced, and the order is the point: everything has to be gone
    //  BEFORE anything is reloaded. A reload that still carries the old UULE
    //  sends the previous country back to Google in the request headers, gets a
    //  map centred on it, and has the cookie re-set for its trouble -- the
    //  original bug, reproduced by the fix. The same argument applies to the
    //  cache: reload first and it refills with the pages being cleared.
    //
    //  Which is also why the wipe gets four times the grace the cookie sweep
    //  does. Clearing the cache and the whole of history is genuinely slow on a
    //  real profile, and cutting it short would start the reloads while it was
    //  still running -- that is the ordering bug again, self-inflicted. A late
    //  reload is a tab that shows the old country for a moment longer; a reload
    //  during the wipe is a tab that puts it back.
    const clearOrigins = once(() => purgeGeoOriginStorage(from));
    const afterCookies = once(() => {
        if (!deep) return;
        clearBrowserOnSwitch(clearOrigins);
        setTimeout(clearOrigins, STAGE_WIPE_MS);
    });

    removeLocationCookies(once(n => {
        if (n) console.info(`FreeProxy: removed ${n} location cookie(s) holding the ` +
                            'previous country');
        afterCookies();
    }));
    setTimeout(afterCookies, STAGE_COOKIE_MS);
}

//  The per-origin half of a switch purge: empty the record of who was told the
//  old country, clear the site storage those origins wrote it into, then make
//  them ask again.
function purgeGeoOriginStorage(from) {
    //  Serialised against noteGeoUse() for the same reason that serialises
    //  against itself: this reads the origin list and then empties it, and a
    //  GEO_USED arriving in between would either be thrown away by the empty
    //  or survive it and send the NEXT switch to clear a site that was only
    //  ever told the new country.
    serialiseOrigins(done => {
        chrome.storage.local.get(GEO_ORIGINS, got => {
            const origins = (Array.isArray(got && got[GEO_ORIGINS]) ? got[GEO_ORIGINS] : [])
                .filter(o => /^https?:\/\//.test(o));
            //  Emptied FIRST: the reload below makes those pages ask again, and
            //  they re-register themselves as holding the NEW country. Emptying
            //  it after that race would drop the entries the next switch has to
            //  clear.
            chrome.storage.local.set({ [GEO_ORIGINS]: [] }, () => {
                void chrome.runtime.lastError;
                //  Deadlined for the same reason as the stages in
                //  purgeLocationTraces(): the reload is the only step the user can
                //  SEE, so it is the last one that may be lost with a callback.
                const reload = once(n2 => {
                    //  Logged even at 0, which is a real and diagnosable state:
                    //  it means no page had registered as holding the old
                    //  country when the switch arrived, so the only tab that can
                    //  be put right is one still pinned to it by URL.
                    console.info(`FreeProxy: cleared site storage for ${n2} origin(s) ` +
                                 'that had been given the previous country');
                    reloadGeoUsers(origins, from);
                    done();
                });
                clearGeoOriginStorage(origins, reload);
                setTimeout(() => reload(0), STAGE_WIPE_MS);
            });
        });
    });
}

//  Called on every authoritative record, and it is the only thing that decides
//  a switch HAPPENED. `pending` is not a change -- it is written on every worker
//  start, and treating it as one would clear site storage several times a day
//  for nothing.
//
//  WHY THIS IS QUEUED, and it is the whole reason the switch purge was
//  intermittent
//  ------------------------------------------------------------------------
//  It is a read-modify-write: read the previous country, compare, write the new
//  one. Two records arriving close together therefore race, and the loser reads a
//  previous country that is already stale.
//
//  MEASURED -- .build/test-geo-purge.js, red run of 2026-09-02, its Brave profile
//  kept and chrome.storage.local read back off disk. LevelDB appends, so the file
//  IS the write order, and it was:
//
//      geoSpoof {pending}          <- worker start
//      geoSpoof {LU}               <- writeGeo, first connect
//      geoSpoof {JP}               <- writeGeo, the switch
//      geoLast  {LU}               <- noteLocationChange(LU) finally lands HERE
//      geoLast  {JP}
//      geoOrigins ["http://127.0.0.1:8099"]
//
//  The LU record's own write landed AFTER the JP record had already been handled.
//  So when the JP call did its read, `geoLast` was still empty: prev was null, the
//  origin list had not landed either so `held` was 0, neither branch could fire,
//  and the switch was silently not acted on -- no cookie sweep, no wipe, no
//  reload, and the tab went on showing Luxembourg. That is the reported bug, and
//  the profile is the witness.
//
//  Adding deadlines to the purge stages did not help, which is what proved it was
//  never entered rather than stalled half-way. Queueing is the fix: the LU call
//  completes its write before the JP call reads. Sharing the queue with
//  noteGeoUse() is deliberate -- it also means a GEO_USED note that arrived before
//  a switch is guaranteed to be in the list the switch reads.
function noteLocationChange(rec) {
    serialiseOrigins(res => {
        //  Released as soon as the record has been written, NOT after the purge --
        //  and that is a requirement, not a preference. purgeGeoOriginStorage()
        //  takes this same queue, so holding it across the purge would have the
        //  purge waiting on a section only the purge can end. It also takes
        //  seconds by design, and nothing else may be parked behind it.
        //
        //  Deadlined on the "fast, or lost" budget for the same reason the purge
        //  stages are: a storage callback that never arrives here would not lose
        //  one note, it would wedge the queue and leave EVERY later switch
        //  unpurged. Two seconds is ~1000x what a LevelDB get+set costs.
        const release = once(res);
        setTimeout(release, STAGE_COOKIE_MS);
        chrome.storage.local.get([GEO_LAST, GEO_ORIGINS], got => {
            const prev = (got && got[GEO_LAST]) || null;
            //  How many origins are on record as having been handed a position. It
            //  can only be non-zero if this browser was connected at some point, so
            //  it is the one thing that can stand in for a previous country when the
            //  previous country itself is missing -- see below.
            const held = Array.isArray(got && got[GEO_ORIGINS]) ? got[GEO_ORIGINS].length : 0;
            //  Write first, purge after: the record is what the NEXT switch is
            //  decided on, so it must be on disk before anything slow starts.
            const commit = (next, purge) => {
                chrome.storage.local.set(next, () => {
                    void chrome.runtime.lastError;
                    release();
                    if (purge) purge();
                });
            };
            if (rec && rec.active) {
                const now = { cc: rec.cc || '', lat: rec.lat, lng: rec.lng };
                if (prev && !sameSpot(prev, now)) {
                    console.info(`FreeProxy: country changed ${prev.cc || '?'} -> ${now.cc || '?'} -- ` +
                                 'clearing the previous location out of this browser');
                    commit({ [GEO_LAST]: now }, () => purgeLocationTraces(prev, true));
                } else if (!prev && held) {
                    //  No remembered previous country, but sites on record as having
                    //  been given one. Something dropped the record -- this worker is
                    //  torn down after ~30 s idle and everything it knows lives in
                    //  storage, so a set() that had not flushed when it was killed is
                    //  gone -- and the state those sites are holding is not.
                    //
                    //  The trigger is deliberately `held` and not "a UULE cookie
                    //  exists": origins are only ever recorded while connected, so
                    //  this cannot fire on a first connect for somebody who merely
                    //  used Google yesterday.
                    //
                    //  `from` is null because the country genuinely is not known any
                    //  more. unpinMaps() needs it and returns null without it, so a
                    //  pinned map URL is reloaded rather than rewritten -- one step
                    //  weaker, and the only step that needs the old coordinates.
                    console.info(`FreeProxy: no previous country on record but ${held} site(s) ` +
                                 'were given one -- clearing this browser anyway');
                    commit({ [GEO_LAST]: now }, () => purgeLocationTraces(null, true));
                } else {
                    commit({ [GEO_LAST]: now }, null);
                }
                return;
            }
            if (rec && rec.pending) { release(); return; }
            if (!prev) { release(); return; }
            //  A disconnect. The record is KEPT, marked `off`, rather than deleted:
            //  quitting the app in Luxembourg and starting it again in Amsterdam is a
            //  country switch as far as this browser is concerned -- the tabs and the
            //  site storage still hold Luxembourg -- and only a remembered previous
            //  location can clean that up. `off` is what stops the work repeating:
            //  onclose fires again on every failed reconnect attempt, which is every
            //  couple of seconds for as long as the app stays shut.
            if (prev.off) { release(); return; }
            commit({ [GEO_LAST]: { cc: prev.cc, lat: prev.lat, lng: prev.lng, off: true } },
                   () => purgeLocationTraces(prev, false));
        });
    });
}

// ── Desktop app link ────────────────────────────────────────────────
function keepAlive() {
    if (keepAliveInterval) clearInterval(keepAliveInterval);
    keepAliveInterval = setInterval(() => {
        if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ command: "PING" }));
    }, 20000);
}

function scheduleReconnect() {
    if (reconnectTimer) return;
    //  Backs off to 30 s instead of hammering a closed port every 3 s
    //  forever, which kept waking the service worker all day when the
    //  desktop app was not running.
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connectToDesktop();
    }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 1.6, 30000);
}

function connectToDesktop() {
    try { socket = new WebSocket(desktopAppUrl); }
    catch (e) { scheduleReconnect(); return; }

    socket.onopen = () => {
        globalState.appRunning = true;
        reconnectDelay = 2000;
        keepAlive();
    };

    socket.onmessage = (event) => {
        let data;
        try { data = JSON.parse(event.data); } catch (e) { return; }

        //  PROGRESS is the app's live connect feed -- about twenty messages
        //  per connect. It carries no authoritative state, so it must not go
        //  anywhere near setBrowserProxy() or the geolocation record: doing
        //  that on every tick would rewrite this browser's proxy settings
        //  twenty times during a single connect.
        if (data.type === 'PROGRESS' && data.progress) {
            globalState.progress = data.progress;
            globalState.busy = data.progress.status === 'connecting';
            globalState.appRunning = true;
            chrome.runtime.sendMessage({ type: 'UI_UPDATE', state: globalState }).catch(() => {});
            return;
        }

        //  ASK is a question the app is BLOCKED on -- it has stopped connecting
        //  and is waiting for the user to choose. The app also puts it on the
        //  next STATE_SYNC, so the popup would find it within a poll either
        //  way; this branch is what makes it arrive at the same instant it
        //  appears in the app window, which is what "no delay in either
        //  direction" has to mean for a dialog somebody is waiting behind.
        //
        //  `ask.ask === null` is the app taking the question DOWN (answered in
        //  the app window, or no longer relevant), and it matters as much as
        //  putting one up: a card left on screen for a question nobody is
        //  waiting on any more is a button that does nothing.
        if (data.type === 'ASK') {
            globalState.ask = data.ask || null;
            globalState.appRunning = true;
            chrome.runtime.sendMessage({ type: 'UI_UPDATE', state: globalState }).catch(() => {});
            return;
        }

        if (data.type !== "STATE_SYNC" || !data.state) return;
        // অ্যাপ থেকে আসা রিয়েল-টাইম ডাটা সেভ করা
        globalState = { ...globalState, ...data.state, appRunning: true };
        //  main.js uses `serverCode`; the popup has always read `server`.
        if (data.state.serverCode) globalState.server = data.state.serverCode;
        //  The first authoritative state of this worker's life is also the point
        //  where the proxy reaches its FINAL value, so it is where a profile that
        //  started stranded is settled -- and any reload is issued from the proxy
        //  call's own callback, so it cannot be dispatched while the old dead
        //  proxy is still the one in force.
        //
        //  `connected` is the whole answer. Not connected is the case the user
        //  reported: the app running with no country selected, so 9050 was dead
        //  for the eleven seconds this profile spent pointed at it and every page
        //  opened in that window is an error page. Connected means 9050 WAS
        //  answering and those same pages loaded -- so the mark is spent here
        //  without a reload, rather than left armed to fire on the next ordinary
        //  disconnect and throw away the user's scroll position for nothing.
        //
        //  It is deliberately not socket.onopen either: the app answering says
        //  nothing about whether it is connected.
        const pagesFailedAtStart = !globalState.connected;
        setBrowserProxy(globalState.connected, globalState.bypassList,
                        () => settleStrandRepair(pagesFailedAtStart));
        syncGeoSpoof(globalState);
        chrome.runtime.sendMessage({ type: "UI_UPDATE", state: globalState }).catch(() => {});
    };

    socket.onerror = () => { try { socket.close(); } catch (e) {} };

    socket.onclose = () => {
        globalState.appRunning = false; globalState.connected = false;
        //  A half-finished connect that died with the app is not still in
        //  flight. Leaving busy set would leave the popup's controls disabled
        //  with nothing left to re-enable them.
        //
        //  Same for the question: nothing is waiting for the answer once the
        //  app has quit, so the card comes down. Answering a dead question
        //  would send a choice into a closed socket and look ignored.
        globalState.busy = false; globalState.progress = null; globalState.ask = null;
        //  Was this browser on Tor a moment ago, or is this one of the failed
        //  reconnect dials that arrive every few seconds while the app stays
        //  down? Either way the answer to the only question that matters here is
        //  the same -- the app is not there, so if this profile STARTED stranded
        //  its pages are error pages and are owed a reload. settleStrandRepair()
        //  does nothing at all when there was no mark, so an ordinary quit, with
        //  pages that loaded perfectly well through Tor, is left alone.
        setBrowserProxy(false, null, () => settleStrandRepair(true));
        //  The app is gone, so there is no verified country any more.
        //  Leaving stale coordinates in place would report a location the
        //  IP no longer backs up.
        syncGeoSpoof(globalState);
        if (keepAliveInterval) clearInterval(keepAliveInterval);
        chrome.runtime.sendMessage({ type: "UI_UPDATE", state: globalState }).catch(() => {});
        scheduleReconnect();
    };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "GET_STATUS") {
        sendResponse({ state: globalState });
        return true;
    }
    //  geo-bridge.js asks this instead of reading chrome.storage.local, and the
    //  difference is not cosmetic. A content script runs at document_start; at
    //  browser start it can win the race against this worker and be served the
    //  PREVIOUS session's stored record. If that record says {active:false} --
    //  which every clean disconnect leaves behind -- geo-spoof.js reads it as
    //  "the app is not connected", calls Chromium's real provider, and the page
    //  gets the device's true position while the VPN is up.
    //
    //  Asking here cannot lose that race: a sendMessage from a content script
    //  starts this worker if it is asleep, and module evaluation -- which sets
    //  geoRecord and calls markGeoPending() and connectToDesktop() -- always
    //  completes before a listener registered during it can be dispatched to.
    //  So the answer is either the live state or an honest "pending", never
    //  something left over from last time.
    if (msg.type === "GET_GEO") {
        sendResponse({ geoSpoof: geoRecord });
        return true;
    }
    //  "the page in this frame was handed a spoofed position." Sent once per page
    //  by geo-spoof.js, relayed by geo-bridge.js. The origin is recorded for one
    //  purpose: when the country changes, these are the sites that were told the
    //  old one, so they are the only sites whose storage may be cleared and the
    //  only tabs that may be reloaded. Everything else the user has open is left
    //  untouched. `sender.origin` is authoritative and set by the browser; the
    //  URL is the fallback for Chromium builds that predate it.
    if (msg.type === "GEO_USED") {
        noteGeoUse((sender && sender.origin) || originOf((sender && sender.url) || ''));
        sendResponse({ ok: true });
        return true;
    }
    //  The popup asks for this while it is open. scheduleReconnect() backs off
    //  to 30 s so a closed port is not hammered all day, but that backoff is
    //  exactly wrong the moment a user starts the app and immediately opens
    //  the popup: they would sit in front of "app not running" for up to half
    //  a minute. An open popup is a reason to retry now.
    if (msg.type === "WAKE") {
        //  Either surface that sends WAKE -- the popup or welcome.html -- is a
        //  surface the user is looking at, so the unread marker has served its
        //  purpose. Idempotent, which is why it can sit in a 1.2 s poll.
        clearBadge();
        const dead = !socket || socket.readyState === WebSocket.CLOSING ||
                     socket.readyState === WebSocket.CLOSED;
        if (dead) {
            if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
            reconnectDelay = 2000;
            connectToDesktop();
        }
        sendResponse({ state: globalState });
        return true;
    }
    //  welcome.html has been read, so the unread marker comes off. Kept in the
    //  worker rather than done from the page because chrome.action belongs to
    //  the extension, not to a tab, and the page may be closed a frame later.
    if (msg.type === "WELCOME_SEEN") {
        clearBadge();
        sendResponse({ ok: true });
        return true;
    }
    if (msg.type === "SEND_COMMAND") {
        // পপআপ থেকে আসা কমান্ড ডেস্কটপ অ্যাপে পাঠানো
        //
        //  Answered either way, and this is the whole "the extension only
        //  works while the app is running" rule in one place. The old version
        //  dropped the command silently when the socket was closed, so a user
        //  with the app shut clicked Connect and watched nothing happen. Now
        //  the popup gets ok:false and says what to do about it.
        const live = socket && socket.readyState === WebSocket.OPEN;
        if (live) {
            try { socket.send(JSON.stringify(msg.payload)); }
            catch (e) { sendResponse({ ok: false, reason: 'send-failed' }); return true; }
        }
        sendResponse({ ok: !!live, reason: live ? '' : 'app-not-running' });
        return true;
    }
});

//  A restarted service worker must not leave the browser pointed at a Tor
//  that may no longer be listening, or reporting a country it can no longer
//  confirm. The proxy is cleared outright; the location is parked as "not
//  known yet" until the WebSocket settles, which is not the same thing as
//  "not connected" -- see markGeoPending().
setBrowserProxy(false);
markGeoPending();
connectToDesktop();
