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
function setBrowserProxy(enabled, bypassList) {
    if (!enabled) {
        chrome.proxy.settings.clear({ scope: 'regular' }, () => void chrome.runtime.lastError);
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
    chrome.proxy.settings.set({
        value: {
            mode: "fixed_servers",
            rules: {
                singleProxy: { scheme: "socks5", host: SOCKS_HOST, port: SOCKS_PORT },
                bypassList: bypass,
            },
        },
        scope: 'regular',
    }, () => {
        //  Reading lastError swallows the "controlled by policy" complaint
        //  that appears when the desktop app has already written the
        //  enterprise ProxySettings policy. Both point at the same Tor
        //  listener, so the policy winning is not a problem.
        void chrome.runtime.lastError;
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
    writeGeo(active
        ? { active: true, lat: g.lat, lng: g.lng, accuracy: g.accuracy || 18,
            cc: g.cc || state.serverCode || '', city: g.city || '' }
        : { active: false });
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
        setBrowserProxy(globalState.connected, globalState.bypassList);
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
        setBrowserProxy(false);
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
