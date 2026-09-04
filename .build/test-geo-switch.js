'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/test-geo-switch.js  --  Extension/background.js, executed for real.
//
//  The bug: connect to Luxembourg, open Google Maps, switch to Tokyo -- Maps
//  still shows Luxembourg. Closing the tab does not help. Restarting the
//  browser does not help. .build/probe-maps-uule2.js measured why: Maps centres
//  from Google's `UULE` cookie, WE are the reason it gets written, and a cookie
//  outlives both the tab and the browser.
//
//  .build/test-geo-purge.js proves the fix in a real browser, which is the
//  stronger evidence -- and which needs the desktop app CLOSED, because the
//  extension hard-codes ws://127.0.0.1:8080. This test needs nothing running at
//  all, and it proves the parts a browser can only show circumstantially:
//
//    * ORDER. The cookie has to be gone BEFORE any tab is reloaded. A reload
//      still carrying the old UULE sends the previous country back to Google,
//      gets a map centred on it, and has the cookie re-set for its trouble --
//      the original bug, reproduced by the fix. Here that is a fact about the
//      order of the API calls, read off a log, not an inference from a picture.
//    * HOW WIDE THE CLEAR IS. Map sites, and nothing else: their cache, their
//      site storage and their own history entries, found from the open tabs and
//      from chrome.history rather than from the origin list, because the
//      measured case never asked for a position at all. NOT the whole browser:
//      a profile-wide cache+cookies+history clear takes every session cookie
//      and every history entry the user has, none of which encodes a location.
//      The checks below assert both halves -- that a map's traces go, and that
//      Google's session cookies and a non-map site's history stay.
//    * WHAT IS STILL NOT TOUCHED. Site storage and open tabs of sites that
//      never asked where they were, a map the user pinned themselves, and --
//      on a DISCONNECT -- everything: quitting the app must not sign the user
//      out of anything. Each of those is damage the user would notice, and a
//      browser test only covers the ones it happens to have open.
//    * WHAT COUNTS AS A SWITCH. Not the first connect, not the same country
//      again, not `pending`, not the second of twenty failed reconnects -- but
//      yes to quitting in one country and starting again in another.
//
//  background.js runs in a vm context against stubs and is driven ONLY through
//  its real entry points: the WebSocket the desktop app talks over, and
//  chrome.runtime.onMessage. No internal function is called directly, so this
//  cannot pass by exercising a path the browser would never take.
// ════════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const vm = require('vm');

//  FP_BG lets a mutation run point this at a deliberately broken copy. A suite
//  that cannot be made to fail proves nothing, and .build/probe-mutate.js uses
//  this to show which check catches which mistake.
const SRC = process.env.FP_BG || path.join(__dirname, '..', 'Extension', 'background.js');
const src = fs.readFileSync(SRC, 'utf8');

let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
    if (cond) { pass++; console.log('  ok   ' + name); }
    else { fail++; console.log('  FAIL ' + name + (extra ? '\n         ' + extra : '')); }
};

// ── the clock ───────────────────────────────────────────────────────
//  Two queues, and keeping them apart is what makes the test terminate.
//
//  `queue` is every asynchronous chrome.* callback. drain() runs it to
//  exhaustion, flushing microtasks in between so the promise chain inside
//  background.js can advance -- that is what "the browser has finished
//  reacting" means here.
//
//  `timers` is setTimeout / setInterval and drain() never runs it.
//  background.js reconnects on a timer, so a drain that fired those would
//  reconnect for ever. The test fires them by hand instead, which is also the
//  only way it can say "this is the third failed reconnect".
const queue = [];
const timers = [];
const soon = fn => queue.push(fn);

//  Deliberately several hops slower than everything else. chrome.cookies.remove
//  is IPC to the network service and there is no reason at all it should finish
//  before a chrome.storage read does.
//
//  This is load-bearing, not decoration. With every stub answering in one hop
//  the cookie path is simply the SHORTER one, so a purge that fired the sweep
//  and the reload off in parallel would still log the removals first and the
//  ordering check below would pass for the wrong reason -- verified by
//  .build/probe-mutate.js, which escapes that check when this delay is absent.
const SLOW = 8;
const later = fn => {
    let n = SLOW;
    const step = () => { if (--n > 0) queue.push(step); else fn(); };
    queue.push(step);
};

async function drain(limit) {
    let n = 0;
    for (;;) {
        await new Promise(r => setImmediate(r));       // flush microtasks
        if (!queue.length) return n;
        if (++n > (limit || 5000)) throw new Error('drain: the callback queue never emptied');
        queue.shift()();
    }
}

function fireTimers(kind) {
    const due = [];
    timers.forEach((t, i) => { if (t && !t.dead && (!kind || t.kind === kind)) due.push(i); });
    for (const i of due) { const t = timers[i]; timers[i] = null; t.fn(); }
    return due.length;
}

// ── the log: every stub call, in order. This is the evidence. ────────
const LOG = [];
const INFO = [];
const WARN = [];
const lg = s => { LOG.push(s); return s; };

let MARK = 0;
const mark = () => { MARK = LOG.length; };
const phase = () => LOG.slice(MARK);
const seen = re => phase().filter(s => re.test(s));
const at = re => phase().findIndex(s => re.test(s));
const lastAt = re => { const a = phase(); for (let i = a.length - 1; i >= 0; i--) if (re.test(a[i])) return i; return -1; };
const shown = () => phase().join('\n         ');

//  Both sides must EXIST. `at()` returns -1 for a line that is not there, and
//  -1 < anything, so a bare `at(a) < at(b)` goes green the moment the call it
//  was written to order disappears -- the failure mode that made six checks in
//  this file pass vacuously when the clear was rescoped.
const firstBefore = (a, b) => { const i = at(a), j = at(b); return i >= 0 && j >= 0 && i < j; };
const lastBefore  = (a, b) => { const i = lastAt(a), j = at(b); return i >= 0 && j >= 0 && i < j; };

//  The browsingData calls a switch makes, told apart by their type list -- there
//  is no longer an unfiltered one to identify by its empty origin array, and two
//  of them carry the same four storage types. `since` is what separates those
//  two: the map clear asks for all of recorded time, the geolocation-origin
//  clear passes no window at all.
const BD_MAP      = /^browsingData\.remove:\["[^|]*\|cache\+cacheStorage\+indexedDB\+localStorage\+serviceWorkers:since=0$/;
const BD_MAP_NC   = /^browsingData\.remove:\["[^|]*\|cacheStorage\+indexedDB\+localStorage\+serviceWorkers:since=0$/;
const BD_MAP_CK   = /^browsingData\.remove:\["[^|]*\|cookies:since=0$/;
const BD_GEO      = /^browsingData\.remove:\["[^|]*\|cacheStorage\+indexedDB\+localStorage\+serviceWorkers:since=undefined$/;
const BD_ANY_WIDE = /^browsingData\.remove:\[\]\|/;

// ── chrome.storage.local ────────────────────────────────────────────
//  Asynchronous, because the real one is, and every ordering claim in this file
//  depends on that being true.
//
//  set() applies the value when the write COMPLETES, not when it is asked for,
//  and that is load-bearing rather than pedantic. The real API is IPC to a
//  LevelDB in the browser process: a get() dispatched before a set() has been
//  issued cannot see it, however soon afterwards the set happens. A stub that
//  mutated the store at call time would be instantly consistent, and would hide
//  the exact race that made the switch purge intermittent in Brave -- verified
//  by .build/probe-mutate-race.js, which escapes every check in this file when
//  this stub applies its writes eagerly.
const STORE = {};
const storage = {
    local: {
        get(keys, cb) {
            const want = keys === null || keys === undefined
                ? Object.keys(STORE) : (Array.isArray(keys) ? keys : [keys]);
            soon(() => {
                const out = {};
                for (const k of want) if (k in STORE) out[k] = STORE[k];
                cb(out);
            });
        },
        set(obj, cb) {
            //  Deep-copied at call time, so a caller holding a reference to the
            //  array it stored cannot quietly edit what "the browser" is about to
            //  be given -- then applied in queue order, which is what LevelDB's
            //  append order means and what the kept profiles are read against.
            const copy = {};
            for (const k of Object.keys(obj)) copy[k] = JSON.parse(JSON.stringify(obj[k]));
            soon(() => {
                for (const k of Object.keys(copy)) STORE[k] = copy[k];
                lg('storage.set:' + Object.keys(copy).map(k => k + '=' + JSON.stringify(STORE[k])).join(','));
                if (cb) cb();
            });
        },
        //  The proxy mark is REMOVED, not set to false: a key that is absent and a
        //  key that is present-and-false read the same way through
        //  `!!got[PROXY_MARK]`, so an eager delete here would hide a mark that was
        //  never cleaned up. Queued like everything else.
        remove(keys, cb) {
            const want = Array.isArray(keys) ? keys : [keys];
            soon(() => {
                for (const k of want) delete STORE[k];
                lg('storage.remove:' + want.join(','));
                if (cb) cb();
            });
        },
    },
    onChanged: { addListener: () => {} },
};

// ── chrome.cookies ──────────────────────────────────────────────────
//  A record is identified the way a browser identifies one: name + host + path,
//  with the leading dot of a domain cookie stripped. That is the point of the
//  stub -- chrome.cookies.remove() takes a URL, not the domain/path pair
//  getAll() hands back, so a URL rebuilt wrongly removes NOTHING. Here that
//  shows up as `cookies.removed:UULE:NOTFOUND` instead of passing quietly.
let JAR = [];
const cookies = {
    getAll({ name }, cb) {
        lg('cookies.getAll:' + name);
        later(() => cb(JAR.filter(c => c.name === name).map(c => ({ ...c }))));
    },
    remove({ url, name }, cb) {
        lg(`cookies.remove:${name}@${url}`);
        later(() => {
            let host = '', p = '/';
            try { const u = new URL(url); host = u.hostname; p = u.pathname || '/'; } catch (e) {}
            const i = JAR.findIndex(c => c.name === name &&
                String(c.domain || '').replace(/^\./, '') === host && (c.path || '/') === p);
            if (i >= 0) JAR.splice(i, 1);
            lg(`cookies.removed:${name}` + (i < 0 ? ':NOTFOUND' : ''));
            cb(i < 0 ? null : { name, url });
        });
    },
};

// ── chrome.browsingData / tabs / proxy / the rest ───────────────────
const BD = [];
let BD_ERR = null;                 // what the browser refuses the next clear with
//  A browser that accepts the call and never comes back. Not hypothetical: the
//  Brave profile kept from a red run of .build/test-geo-purge.js read back with
//  the purge entered and the origin list never emptied, which is what a lost
//  callback looks like from the outside. `remove` is fire-and-forget in that
//  state -- the work is not modelled as done either, because the browser has not
//  said it is.
let BD_HANG = false;
//  Two labels short of the hostname: browsingData's origin filter clears cookies
//  for the whole registrable domain, and this is close enough to it for the
//  domains in the fixtures (google.com, openstreetmap.org, example.org).
const site = h => String(h).replace(/^\./, '').split('.').slice(-2).join('.');
const browsingData = {
    remove(filter, types, cb) {
        BD.push({ filter, types });
        //  `since` is logged whether or not the call is origin-filtered: the map
        //  clear and the geolocation-origin clear ask for the same four storage
        //  types, and it is the only thing in the call that tells them apart.
        lg('browsingData.remove:' + JSON.stringify(filter.origins || []) + '|' +
           Object.keys(types).filter(k => types[k]).sort().join('+') +
           ':since=' + filter.since);
        if (BD_HANG) return;
        //  Modelled, not merely recorded: `cookies: true` takes the jar, and an
        //  origin filter narrows that to the registrable domains named -- so a
        //  clear aimed at maps.google.com signs the user out of Gmail. That is
        //  the one consequence of getting the scope wrong that a log cannot
        //  show, and the jar checks below are the only place it becomes visible.
        if (!BD_ERR && types.cookies) {
            if (!filter.origins) JAR = [];
            else {
                const doomed = new Set(filter.origins.map(o => {
                    try { return site(new URL(o).hostname); } catch (e) { return ''; }
                }));
                JAR = JAR.filter(c => !doomed.has(site(c.domain)));
            }
        }
        soon(() => {
            //  chrome sets lastError for the duration of the callback and clears
            //  it again afterwards. A stub that left it set would make every
            //  later call look like a failure.
            runtime.lastError = BD_ERR ? { message: BD_ERR } : undefined;
            try { cb(); } finally { runtime.lastError = undefined; }
        });
    },
};

let TABS = [];
const tabs = {
    query(q, cb) { lg('tabs.query'); soon(() => cb(TABS.map(t => ({ ...t })))); },
    reload(id, opts, cb) {
        lg(`tabs.reload:${id}` + (opts && opts.bypassCache ? ':bypassCache' : ''));
        if (cb) soon(() => cb());
    },
    update(id, props) { lg(`tabs.update:${id}:${props.url}`); },
    create(props) { lg('tabs.create:' + props.url); },
};

// ── chrome.history ──────────────────────────────────────────────────
//  browsingData cannot filter history by origin at all -- its `history: true` is
//  the whole profile -- so the map history goes through chrome.history instead,
//  and this stub is what makes that testable. search() is a free-text query over
//  the URL and the title, exactly as the real one is, which is the point: the
//  keywords FIND candidates and isMapUrl() DECIDES. HIST therefore holds entries
//  a keyword matches and a map pattern does not, and they have to survive.
let HIST = [];
const history = {
    search({ text, startTime, maxResults }, cb) {
        lg(`history.search:${text}:start=${startTime}`);
        const q = String(text || '').toLowerCase();
        soon(() => cb(HIST.filter(h => (h.url + ' ' + (h.title || '')).toLowerCase().includes(q))
                          .slice(0, maxResults || 100).map(h => ({ ...h }))));
    },
    deleteUrl({ url }, cb) {
        const before = HIST.length;
        HIST = HIST.filter(h => h.url !== url);
        //  `absent` rather than the cookie stub's NOTFOUND, because it is not a
        //  fault here: a URL taken from an open tab need never have been recorded
        //  as a visit, and deleting it anyway costs nothing.
        lg(`history.deleteUrl:${url}` + (HIST.length === before ? ':absent' : ''));
        if (cb) soon(() => cb());
    },
};
const histUrls = () => HIST.map(h => h.url);

// ── chrome.windows ──────────────────────────────────────────────────
//  The release that fixes "Brave has no internet" hangs off onRemoved, and the
//  re-assert that stops that release becoming a real-IP leak hangs off
//  onCreated. Neither existed in this harness, so both listeners were registered
//  against nothing and every claim about them was untested.
//
//  getAll is the load-bearing part: closing ONE window of several must not touch
//  the proxy, and the only thing that distinguishes the two cases is what this
//  answers with. It answers late for the same reason the cookie stub does -- it
//  is IPC, and a check that only passes when it replies instantly is not a check.
let WINS = [];
const winHooks = {};
const windows = {
    getAll(q, cb) { lg('windows.getAll'); later(() => cb(WINS.map(w => ({ ...w })))); },
    onRemoved: { addListener: fn => { winHooks.removed = fn; } },
    onCreated: { addListener: fn => { winHooks.created = fn; } },
};
const closeWindow = id => {
    WINS = WINS.filter(w => w.id !== id);
    if (!winHooks.removed) return false;
    winHooks.removed(id);
    return true;
};
const openWindow = id => {
    WINS.push({ id });
    if (!winHooks.created) return false;
    winHooks.created({ id });
    return true;
};

const proxy = {
    settings: {
        //  "off" is a WRITE of mode:'direct', not a clear -- clearing relinquishes the
        //  pref and Chromium then applies the next value in the store, which on the
        //  real profile is a fossil extension's fixed_servers socks5://127.0.0.1:9050
        //  that no worker can ever release (.build/probe-pref-precedence.js). So the
        //  two are logged as different things and clear() is left as a trap: if it is
        //  ever called again, the check below names it.
        set(o, cb) {
            const s = o && o.value && o.value.rules && o.value.rules.singleProxy;
            const mode = o && o.value && o.value.mode;
            lg(mode === 'direct' ? 'proxy.off:direct'
                                 : 'proxy.set:' + (s ? `${s.scheme}://${s.host}:${s.port}` : '?'));
            soon(() => cb && cb());
        },
        clear(o, cb) { lg('proxy.clear'); soon(() => cb && cb()); },
    },
};


// ── chrome.alarms ───────────────────────────────────────────────────
//  The watchdog is the only thing that can recover a browser whose service
//  worker was torn down while the proxy was still set: nothing else can wake an
//  evicted worker, and until it wakes, the persistent proxy pref keeps pointing
//  the browser at a Tor that is not listening. The stub records arming and
//  disarming as log lines, keeps the live set so "is one armed right now" is a
//  question the checks can ask, and hands the test a way to fire it.
const ALARMS = new Map();
let onAlarm = null;
const alarms = {
    create(name, info) {
        ALARMS.set(name, info || {});
        lg(`alarms.create:${name}:delay=${info && info.delayInMinutes}` +
           `:period=${info && info.periodInMinutes}`);
    },
    clear(name, cb) {
        ALARMS.delete(name);
        lg('alarms.clear:' + name);
        if (cb) soon(() => cb(true));
    },
    onAlarm: { addListener: fn => { onAlarm = fn; } },
};
const fireAlarm = name => { if (!onAlarm) return false; onAlarm({ name }); return true; };

const MSGS = [];
const hooks = {};
let onMessage = null;
const runtime = {
    lastError: undefined,
    getURL: p => 'chrome-extension://fp/' + String(p),
    onInstalled: { addListener: fn => { hooks.installed = fn; } },
    onStartup: { addListener: fn => { hooks.startup = fn; } },
    onMessage: { addListener: fn => { onMessage = fn; } },
    sendMessage(msg, cb) {
        MSGS.push(msg);
        if (cb) { soon(() => cb({})); return undefined; }
        return Promise.resolve();          // background.js calls .catch() on this
    },
};

const action = {
    setBadgeText: o => lg('badge:' + JSON.stringify(o && o.text)),
    setBadgeBackgroundColor: () => {},
};
const notifications = { create: (id, o, cb) => { lg('notify:' + id); if (cb) soon(() => cb()); } };

// ── the desktop app's socket ─────────────────────────────────────────
//  Nothing happens on its own: background.js attaches its handlers after the
//  constructor returns, and the test decides when the app answers, when it
//  sends a state, and when it dies. open()/deliver()/die() are the three things
//  the real app can do to this worker.
const WS = [];
class FakeSocket {
    constructor(url) {
        this.url = url; this.readyState = 0; this.sent = [];
        WS.push(this); lg('ws.new:' + url);
    }
    send(s) { this.sent.push(s); }
    close() { this.die(); }
    open() { this.readyState = 1; if (this.onopen) this.onopen(); }
    deliver(obj) { if (this.onmessage) this.onmessage({ data: JSON.stringify(obj) }); }
    die() {
        if (this.readyState === 3) return;
        this.readyState = 3;
        if (this.onclose) this.onclose();
    }
}
FakeSocket.CONNECTING = 0; FakeSocket.OPEN = 1; FakeSocket.CLOSING = 2; FakeSocket.CLOSED = 3;

const chromeStub = { runtime, storage, cookies, browsingData, tabs, history, windows, proxy,
                     action, notifications, alarms };
const sandbox = {
    chrome: chromeStub,
    WebSocket: FakeSocket,
    URL,
    console: {
        log: () => {}, debug: () => {},
        info: (...a) => INFO.push(a.join(' ')),
        warn: (...a) => WARN.push(a.join(' ')),
        error: (...a) => WARN.push(a.join(' ')),
    },
    setTimeout: (fn, ms) => timers.push({ fn, ms, kind: 't' }),
    clearTimeout: id => { if (timers[id - 1]) timers[id - 1].dead = true; },
    setInterval: (fn, ms) => timers.push({ fn, ms, kind: 'i' }),
    clearInterval: id => { if (timers[id - 1]) timers[id - 1].dead = true; },
};
sandbox.self = sandbox;
vm.createContext(sandbox);

// ── the three countries, far enough apart to be unmistakable ─────────
const LU = { lat: 49.6116, lng: 6.1319, accuracy: 18, city: 'Luxembourg City', cc: 'LU' };
const JP = { lat: 35.6895, lng: 139.6917, accuracy: 18, city: 'Tokyo', cc: 'JP' };
const NL = { lat: 52.3676, lng: 4.9041, accuracy: 18, city: 'Amsterdam', cc: 'NL' };

//  The exact shape main.js puts on the wire: stateForWire() spreads appState and
//  attaches `geo`, broadcastState() wraps it in {type:'STATE_SYNC', state}.
const stateFor = (c, code) => ({
    connected: !!c, serverCode: code, killSwitch: false, bypassList: '', servers: {},
    geo: c ? { lat: c.lat, lng: c.lng, accuracy: c.accuracy, city: c.city, cc: c.cc } : null,
});

const sock = () => WS[WS.length - 1];
const geo = () => STORE.geoSpoof;
const origins = () => STORE.geoOrigins || [];
const prevLoc = () => STORE.geoLast || null;
const answers = [];
const sync = async (c, code) => {
    sock().deliver({ type: 'STATE_SYNC', state: stateFor(c, code) });
    await drain();
};
const use = async sender => {
    onMessage({ type: 'GEO_USED' }, sender, r => answers.push(r));
    await drain();
};

(async () => {

// ════════════════════════════════════════════════════════════════════
mark();
vm.runInContext(src, sandbox, { filename: 'background.js' });
await drain();

console.log('── a service worker that has only just started ──');
ok(seen(/^proxy\.off:direct$/).length === 1,
   'it lets go of the proxy before anything else -- the Tor it pointed at may be gone');
//  This is the whole of "brave e net pacchina" in one check. clear() means "I
//  relinquish", and Chromium then applies the next extension-controlled value in the
//  store: on the real Brave profile that is a fossil id's fixed_servers
//  socks5://127.0.0.1:9050, which no worker will ever exist to release and which
//  nothing outside the browser may edit. Measured both ways in
//  .build/probe-pref-precedence.js -- clearing gave a page that went through a stub
//  on 9050, writing mode:'direct' gave a page that went direct and stayed direct
//  across a restart.
ok(!seen(/^proxy\.clear$/).length,
   'and it does so by WRITING mode:direct, never by clearing -- a clear hands the pref ' +
   'back to a record that cannot be released', shown() || '(clear never called)');

ok(JSON.stringify(geo()) === JSON.stringify({ active: false, pending: true }),
   'the location is parked as "not known yet", which is not the same as "not connected"',
   JSON.stringify(geo()));
ok(seen(/^ws\.new:ws:\/\/127\.0\.0\.1:8080$/).length === 1, 'and it dials the desktop app');
ok(!seen(/cookies\.getAll/).length,
   'nothing is cleared out of the browser: `pending` is written on every worker start, ' +
   'and treating it as a country change would empty site storage several times a day',
   shown());
ok(!prevLoc(), 'no previous location is on record yet');

// ════════════════════════════════════════════════════════════════════
mark();
sock().open();
await sync(LU, 'lu');

console.log('\n── the first connect of a session: Luxembourg ──');
ok(geo() && geo().active === true && geo().cc === 'LU' && geo().lat === LU.lat,
   'the page-facing record becomes the connected country', JSON.stringify(geo()));
ok(seen(/^proxy\.set:socks5:\/\/127\.0\.0\.1:9050$/).length === 1,
   "the browser is pointed at the app's Tor port");
ok(!seen(/cookies\.getAll/).length,
   'nothing is cleared: a first connect has no previous country to clear', shown());
ok(!seen(/browsingData|tabs\./).length,
   'no site storage is emptied and no tab is disturbed', shown());
ok(prevLoc() && prevLoc().cc === 'LU',
   'and the country is remembered, so the next change can be recognised', JSON.stringify(prevLoc()));

// ════════════════════════════════════════════════════════════════════
mark();
await sync(LU, 'lu');                                    // the app re-broadcasts state often
await sync({ ...LU, lat: LU.lat + 0.005 }, 'lu');        // and the coordinates jitter slightly
await sync(LU, 'lu');

console.log('\n── the same country, reported again ──');
ok(!seen(/cookies\.getAll|browsingData|tabs\./).length,
   'a repeated state, and a few hundred metres of drift, are not a switch -- ' +
   'main.js broadcasts on every state change and each one would otherwise reload the tab',
   shown());

// ════════════════════════════════════════════════════════════════════
mark();
await use({ origin: 'https://www.google.com', url: 'https://www.google.com/maps' });
await use({ origin: 'https://www.google.com', url: 'https://www.google.com/maps' });
await use({ origin: 'https://maps.example.org', url: 'https://maps.example.org/x' });
//  No sender.origin at all: the fallback for Chromium builds that predate it.
await use({ url: 'https://old.example.com/deep/page?q=1' });
//  Neither of these is a site, and neither may end up on the list.
await use({ origin: 'chrome-extension://fp', url: 'chrome-extension://fp/popup.html' });
await use({ url: 'about:blank' });

console.log('\n── the sites that were handed a position report themselves ──');
ok(JSON.stringify(origins()) === JSON.stringify([
       'https://www.google.com', 'https://maps.example.org', 'https://old.example.com']),
   'exactly the http(s) origins that asked, once each, in the order they asked',
   JSON.stringify(origins()));
ok(answers.length === 6 && answers.every(r => r && r.ok === true),
   'and every report is answered, so no content script is left waiting on a dead callback',
   JSON.stringify(answers));

// ════════════════════════════════════════════════════════════════════
//  THE SWITCH. Everything above is setup; this is the reported bug.
JAR = [
    { name: 'UULE',           domain: '.google.com',       path: '/',  secure: true  },
    { name: 'UULE',           domain: 'maps.example.org',  path: '/x', secure: false },
    { name: 'SID',            domain: '.google.com',       path: '/',  secure: true  },
    { name: '__Secure-1PSID', domain: '.google.com',       path: '/',  secure: true  },
    { name: 'HSID',           domain: '.google.com',       path: '/',  secure: true  },
    //  A domain that is nothing but a map, so its cookies CAN go wholesale.
    { name: 'osm_session',    domain: '.openstreetmap.org', path: '/', secure: true  },
];
TABS = [
    { id: 1, url: 'https://www.google.com/maps/@49.6116,6.1319,12z' },        // pinned to LU: ours
    { id: 2, url: 'https://www.google.com/maps/@35.6895,139.6917,12z' },      // pinned elsewhere
    { id: 3, url: 'https://www.google.com/maps/@49.61,6.13,12z?hl=en' },      // LU, plus a query
    { id: 4, url: 'https://maps.example.org/page' },
    { id: 5, url: 'https://news.example.net/' },                             // never asked
    { id: 6, url: 'chrome://settings/' },                                    // not a site
    { id: 7, url: 'https://old.example.com/deep/page?q=1' },
    { id: 8, url: 'https://www.google.com/maps/place/Foo/@49.61,6.13,17z/data=!3m1' },
    { id: 9, url: 'https://www.openstreetmap.org/#map=12/49.61/6.13' },      // a map, never asked
];
//  Two entries no keyword finds, two a keyword finds and no map pattern claims,
//  and the rest real map history. The pair in the middle is the load-bearing
//  part: `maps` matches maps.example.org and a news article about maps, and
//  neither may be deleted.
HIST = [
    { url: 'https://www.google.com/maps/@49.6116,6.1319,12z',   title: 'Google Maps' },
    { url: 'https://www.google.com/maps/place/Foo/@49.61,6.13,17z/data=!3m1', title: 'Foo' },
    { url: 'https://www.bing.com/maps?cp=49.61~6.13',            title: 'Bing Maps' },
    { url: 'https://www.openstreetmap.org/#map=12/49.61/6.13',   title: 'OpenStreetMap' },
    { url: 'https://maps.example.org/x',                         title: 'Maps Example' },
    { url: 'https://news.example.net/2026/maps-of-the-world',    title: 'Maps of the world' },
    { url: 'https://mail.google.com/mail/u/0/#inbox',            title: 'Gmail' },
    { url: 'https://old.example.com/deep/page?q=1',              title: 'Deep page' },
];
mark();
await sync(JP, 'jp');

console.log('\n── the switch: Luxembourg -> Tokyo ──');
{
    const iGeo = at(/^storage\.set:geoSpoof=.*"cc":"JP"/);
    const iJar = at(/^cookies\.getAll:UULE$/);
    ok(iGeo >= 0 && iJar >= 0 && iGeo < iJar,
       'the new country reaches waiting pages FIRST -- a page blocked on getCurrentPosition ' +
       'must not sit behind a cookie sweep and a storage clear', shown());
}
ok(seen(/^cookies\.getAll:/).length === 1 && seen(/^cookies\.getAll:UULE$/).length === 1,
   'the jar is asked for UULE by name, and for nothing else: every extra name would cost ' +
   'the user whatever else that cookie was carrying', shown());
{
    const rm = seen(/^cookies\.remove:/);
    ok(rm.length === 2 &&
       rm.includes('cookies.remove:UULE@https://google.com/') &&
       rm.includes('cookies.remove:UULE@http://maps.example.org/x'),
       'both UULE records go, each with a URL rebuilt from its own record -- a domain cookie ' +
       'and a host-only one do not take the same one', JSON.stringify(rm));
    ok(!seen(/^cookies\.removed:.*NOTFOUND/).length,
       'and each rebuilt URL really identifies its record: a wrong one removes nothing at all',
       shown());
}
ok(!JAR.some(c => c.name === 'UULE'), 'no UULE is left anywhere in the jar',
   JSON.stringify(JAR.map(c => c.name)));
//  The user's correction, and the whole point of this rewrite: "sudhu matro map
//  related website er cookie, cache, history clear korte". A profile-wide
//  cache+cookies+history clear reaches the symptom, but it also signs the user
//  out of everything and deletes a history they never asked to lose. Nothing in
//  a session cookie encodes a location, so nothing here may take one.
ok(JAR.filter(c => c.domain === '.google.com').map(c => c.name).sort().join(',') ===
   'HSID,SID,__Secure-1PSID',
   "Google's session cookies all survive: a switch must not sign the user out, and no " +
   'session cookie carries a location for it to be worth the trade',
   JSON.stringify(JAR.map(c => c.name)));
ok(!JAR.some(c => c.name === 'osm_session'),
   'but a domain that is nothing BUT a map does lose its cookies wholesale -- there is no ' +
   'account behind openstreetmap.org to sign out of', JSON.stringify(JAR.map(c => c.name)));

//  Three clears: the map cache and storage, the map-only cookies, and the site
//  storage of the origins that were handed a position. No unfiltered call at all.
ok(BD.length === 3 && BD.every(b => Array.isArray(b.filter.origins) && b.filter.origins.length),
   'every clear is origin-filtered: there is no browser-wide call left to take a bystander ' +
   "site's data with it", JSON.stringify(BD.map(b => b.filter.origins)));
{
    const maps = BD.find(b => b.types.cache) || { filter: {}, types: {} };
    const ck   = BD.find(b => b.types.cookies) || { filter: {}, types: {} };
    const per  = BD.find(b => !b.types.cache && !b.types.cookies) || { filter: {}, types: {} };
    ok(JSON.stringify(maps.filter.origins) === JSON.stringify([
           'https://www.google.com', 'https://www.openstreetmap.org', 'https://www.bing.com']),
       'the map clear names the map origins found in the open tabs and in history -- google and ' +
       'openstreetmap from the tabs, bing from a history entry with no tab open',
       JSON.stringify(maps.filter.origins));
    ok(!maps.filter.origins.includes('https://maps.example.org') &&
       !maps.filter.origins.includes('https://news.example.net'),
       'and NOT a site that merely matched the search keyword: `maps` finds maps.example.org and ' +
       'a news article about maps, and a map pattern claims neither',
       JSON.stringify(maps.filter.origins));
    ok(maps.types.cache && maps.types.cacheStorage && maps.types.indexedDB &&
       maps.types.localStorage && maps.types.serviceWorkers && !maps.types.cookies,
       'it takes their cache and their site storage -- the cache because a tile or a JSON ' +
       'response is where the old centre comes back from -- and not their cookies',
       JSON.stringify(maps.types));
    ok(maps.filter.since === 0,
       'over all of recorded time -- a window starting at the switch would leave every ' +
       'page cached before it', JSON.stringify(maps.filter));
    ok(JSON.stringify(ck.filter.origins) === JSON.stringify(['https://www.openstreetmap.org']) &&
       Object.keys(ck.types).length === 1,
       'cookies are asked for ONLY for the map-only domains, and by themselves: an origin ' +
       "filter clears cookies for the whole registrable domain, so naming google's would " +
       'take google.com with it', JSON.stringify({ o: ck.filter.origins, t: ck.types }));
    ok(JSON.stringify(per.filter.origins) === JSON.stringify([
           'https://www.google.com', 'https://maps.example.org', 'https://old.example.com']),
       'the per-origin one is for exactly the origins that were handed a position',
       JSON.stringify(per.filter.origins));
    ok(per.types.cacheStorage && per.types.indexedDB && per.types.localStorage &&
       per.types.serviceWorkers,
       'covering the four places a page can keep its own copy of a position -- including ' +
       'maps.example.org, which is on the list because it asked, not because it is a map',
       JSON.stringify(per.types));
    ok(!per.types.cookies && !per.types.cookiesAndSiteData,
       'and it is a separate call rather than a wider one, so a Service Worker is only ' +
       'ever unregistered for a site that asked where it was', JSON.stringify(per.types));
    ok(firstBefore(BD_MAP, BD_GEO),
       'map clear first, geolocation origins second', shown());
}

//  The map history: found by keyword, decided by pattern, deleted one URL at a
//  time. browsingData cannot filter history by origin at all, so this is the only
//  route to it that does not take the user's whole history with it.
{
    const del = seen(/^history\.deleteUrl:/).map(s => s.replace(/^history\.deleteUrl:/, ''));
    ok(seen(/^history\.search:/).length === 6 &&
       seen(/^history\.search:maps:start=0$/).length === 1,
       'history is searched once per keyword, from the beginning of recorded time', shown());
    ok(del.includes('https://www.google.com/maps/@49.6116,6.1319,12z') &&
       del.includes('https://www.bing.com/maps?cp=49.61~6.13') &&
       del.includes('https://www.openstreetmap.org/#map=12/49.61/6.13'),
       'every map entry found is deleted, including one for a site with no tab open',
       JSON.stringify(del));
    ok(!histUrls().some(u => /google\.com\/maps|bing\.com\/maps|openstreetmap/.test(u)),
       'and they really are gone from history, not merely asked about', JSON.stringify(histUrls()));
    ok(histUrls().includes('https://maps.example.org/x') &&
       histUrls().includes('https://news.example.net/2026/maps-of-the-world') &&
       histUrls().includes('https://mail.google.com/mail/u/0/#inbox') &&
       histUrls().includes('https://old.example.com/deep/page?q=1'),
       'and nothing else is: the two entries a keyword matched but no map pattern claimed are ' +
       "still there, and so is the user's mail and the page that asked for a position",
       JSON.stringify(histUrls()));
    ok(!del.some(u => /maps\.example\.org|news\.example\.net|mail\.google/.test(u)),
       'they were never even asked to be deleted -- isMapUrl() decides, the keyword only finds',
       JSON.stringify(del));
    ok(del.length === 6 && seen(/^history\.deleteUrl:.*:absent$/).length === 2,
       'six URLs in all -- the five open map tabs and the one bing entry with no tab -- of which ' +
       'the two tab URLs that were never visited report absent, which is not a fault',
       JSON.stringify(del));
}

//  The correctness fix this file exists for.
ok(lastBefore(/^cookies\.removed:/, /^browsingData\.remove:/),
   'UULE goes by name before anything else is cleared, so the one cookie measured to ' +
   'carry a position is gone even in a browser that refuses the wide clear', shown());
ok(lastBefore(/^cookies\.removed:/, /^history\.deleteUrl:/),
   'and before any history entry is deleted, so the sweep cannot be left half-done with the ' +
   'one measured carrier still in place', shown());
ok(lastBefore(/^cookies\.removed:/, /^tabs\.(reload|update):/),
   'and before ANY tab is reloaded: a reload still carrying the old UULE sends the previous ' +
   'country back to Google, gets a map centred on it, and has the cookie re-set for its trouble',
   shown());
ok(lastBefore(/^browsingData\.remove:/, /^tabs\.(reload|update):/),
   'all three clears finish before any reload as well -- reload first and the cache refills ' +
   'with the very pages being cleared', shown());
ok(lastBefore(/^history\.deleteUrl:/, /^tabs\.(reload|update):/),
   'and so does the history deletion: a reload of a URL still in history is where the old ' +
   'centre comes back from', shown());
ok(firstBefore(/^storage\.set:geoOrigins=\[\]$/, BD_GEO),
   'the origin list is emptied before the reloads that will re-fill it with the new country',
   shown());

{
    const t = seen(/^tabs\.(reload|update):/);
    //  MEASURED, .build/probe-maps-repin2.txt: a /@lat,lng,zoom pin decides the
    //  first-load centre outright -- it beat a planted UULE and it beat Google's
    //  own answer for the requesting IP. So the pin is REWRITTEN to the country
    //  being switched to rather than dropped. Dropping it was the reported
    //  symptom: the drop only claimed a pin within ~1.5 deg of the country being
    //  LEFT, so a pin anywhere else fell through to a plain reload of the very
    //  URL that carried it, and the map came back on the same wrong city after
    //  every switch, for ever.
    ok(seen(/^tabs\.update:1:https:\/\/www\.google\.com\/maps\/@35\.6895,139\.6917,12z$/).length === 1,
       'a Maps tab pinned to the country being left is REPINNED to the country being switched ' +
       'to -- dropping the pin only handed the map back to Google, which is free to disagree',
       JSON.stringify(t));
    ok(seen(/^tabs\.update:3:https:\/\/www\.google\.com\/maps\/@35\.6895,139\.6917,12z\?hl=en$/).length === 1,
       'and the zoom and the rest of the URL survive the repin: only the centre moves, so a ' +
       'country-level view stays a country-level view', JSON.stringify(t));
    ok(seen(/^tabs\.reload:2:bypassCache$/).length === 1,
       'a Maps tab ALREADY pinned at the destination keeps its pin and is only reloaded -- ' +
       'here that is tab 2, whose Tokyo pin is exactly where this switch is going',
       JSON.stringify(t));
    ok(seen(/^tabs\.update:8:https:\/\/www\.google\.com\/maps\/place\/Foo\/@35\.6895,139\.6917,17z\/data=!3m1$/).length === 1,
       'a deeper /maps/place/.../@.../data=... URL is repinned too, with the place segment and ' +
       'the data segment intact -- twelve URL shapes are checked in probe-maps-repin2.txt, and ' +
       'the browser was measured to accept the rebuilt URL rather than choke on it',
       JSON.stringify(t));
    ok(seen(/^tabs\.reload:4:bypassCache$/).length === 1 &&
       seen(/^tabs\.reload:7:bypassCache$/).length === 1,
       'the other sites that had been given the old country are reloaded too', JSON.stringify(t));
    ok(seen(/^tabs\.reload:9:bypassCache$/).length === 1,
       'and so is a map with no pin this code can rewrite -- OpenStreetMap keeps its centre in ' +
       'the fragment, so clearing its cache only shows up on the next load', JSON.stringify(t));
    ok(!seen(/^tabs\.(reload|update):5/).length,
       'a site that never asked where it was is left alone', JSON.stringify(t));
    ok(!seen(/^tabs\.(reload|update):6/).length, 'and so is chrome://settings', JSON.stringify(t));
    ok(t.length === 7, 'seven tabs in all, and no others', JSON.stringify(t));
}
ok(INFO.filter(s => /country changed LU -> JP/.test(s)).length === 1,
   'the reason is written to the console once, so a user reading it can tell why their tab moved',
   JSON.stringify(INFO));
ok(prevLoc() && prevLoc().cc === 'JP' && !prevLoc().off,
   'and Tokyo is what the next change will be compared against', JSON.stringify(prevLoc()));

// ════════════════════════════════════════════════════════════════════
mark();
JAR = [{ name: 'UULE', domain: '.google.com', path: '/', secure: true },
       { name: 'SID',  domain: '.google.com', path: '/', secure: true }];
await sync(NL, 'nl');

console.log('\n── a second switch, with no site having asked in between ──');
ok(seen(/^cookies\.getAll:UULE$/).length === 1,
   'the cookie is swept anyway -- it is the one thing measured to carry the country, and it ' +
   'is not scoped to any origin we happen to know about', shown());
ok(!JAR.some(c => c.name === 'UULE') && JAR.length === 1 && JAR[0].name === 'SID',
   'and it is gone, while the session cookie beside it is not', JSON.stringify(JAR.map(c => c.name)));
//  This block is the reported bug in miniature. A purge gated on the origin list
//  did NOTHING here: with no origin on the list there was nothing to clear
//  per-origin, so a switch between two countries the user had not yet opened a
//  geolocating page in left the map cache exactly as it was -- and the pages that
//  read a country out of it went on showing the first one. The map clear is
//  reached from the open tabs instead, so an empty list changes nothing about it.
ok(seen(BD_MAP).length === 1 &&
   seen(/^browsingData\.remove:\["https:\/\/www\.google\.com","https:\/\/www\.openstreetmap\.org"\]\|cache\+/).length === 1,
   'the map cache and map site storage are cleared even though no site is known to be holding ' +
   'the old country -- the open tabs are what triggers it, not the origin list', shown());
ok(seen(BD_MAP_CK).length === 1 && seen(BD_GEO).length === 0 && !seen(BD_ANY_WIDE).length,
   'the map-only cookies go with them, the per-origin clear is skipped because there is no ' +
   'origin to scope it to, and there is still no browser-wide call', shown());
ok(seen(/^history\.search:/).length === 6 &&
   seen(/^history\.deleteUrl:.*:absent$/).length === 5 &&
   seen(/^history\.deleteUrl:/).length === 5,
   'history is searched again and the open map tabs are deleted from it by URL -- all five ' +
   'report absent, because the first switch already took them and a tab need never have been ' +
   'recorded as a visit', shown());
ok(histUrls().length === 4 &&
   histUrls().includes('https://news.example.net/2026/maps-of-the-world') &&
   histUrls().includes('https://mail.google.com/mail/u/0/#inbox'),
   'and the four entries no map pattern claims are still there after a second pass -- a sweep ' +
   'that widened on repetition would empty the history over a day of switching',
   JSON.stringify(histUrls()));
//  The tabs ARE queried, and they ARE touched even though the origin list is
//  empty. Tab 2 is pinned to /@35.6895,139.6917, which was "somewhere else"
//  during the LU -> JP switch above and is now the country being LEFT. That page
//  never asked us for a position, so it can never be on the origin list -- and
//  it is the measured Google Maps case (.build/probe-maps-uule2.js: Maps centres
//  from the UULE cookie and from its own URL without calling the geolocation
//  API). An empty list is exactly when such a page is the only thing left to put
//  right, so the sweep cannot be gated on the list.
ok(seen(/^tabs\.query$/).length === 2 &&
   seen(/^tabs\.update:2:https:\/\/www\.google\.com\/maps\/@52\.3676,4\.9041,12z$/).length === 1,
   'the tab still pinned to the country being left is repinned to the new one, with no origin ' +
   'on the list at all -- a page can display a country without ever having asked for it',
   shown());
//  And the trade is asserted rather than left implicit. Tabs 1, 3 and 8 are
//  pinned to LU, which nobody is leaving on this switch -- under the old 1.5 deg
//  rule they were "the user's own view" and were left alone. They are moved now,
//  because the ask is that EVERY reload show the connected country, and a map
//  left on a third country is the thing being complained about. What is still
//  not touched is anything that is not a map.
ok(seen(/^tabs\.update:1:https:\/\/www\.google\.com\/maps\/@52\.3676,4\.9041,12z$/).length === 1 &&
   seen(/^tabs\.update:3:https:\/\/www\.google\.com\/maps\/@52\.3676,4\.9041,12z\?hl=en$/).length === 1 &&
   seen(/^tabs\.update:8:https:\/\/www\.google\.com\/maps\/place\/Foo\/@52\.3676,4\.9041,17z\/data=!3m1$/).length === 1,
   'every other Maps pin is moved with it, including ones pointing at a country nobody is ' +
   'leaving -- the deliberate cost of "every reload shows the connected country"', shown());
ok(seen(/^tabs\.reload:9:bypassCache$/).length === 1,
   'and the OpenStreetMap tab is reloaded rather than rewritten: its URL carries no pin this ' +
   'code can move, so a reload against the cleared cache is the only thing that updates it',
   shown());
ok(!seen(/^tabs\.(reload|update):(4|5|6|7)\b/).length,
   'nothing that is not a map is disturbed: not the sites that never asked, not a chrome:// ' +
   'page -- and tab 4 is the one that proves the difference, because maps.example.org matches ' +
   'the history keyword and is still not a map', shown());

// ════════════════════════════════════════════════════════════════════
mark();
JAR = [{ name: 'UULE', domain: '.google.com', path: '/', secure: true },
       { name: 'SID',  domain: '.google.com', path: '/', secure: true }];
STORE.geoOrigins = ['https://www.google.com'];
TABS = [{ id: 9, url: 'https://www.google.com/maps' }];
sock().die();
await drain();

console.log('\n── the app quits ──');
ok(seen(/^proxy\.off:direct$/).length === 1,
   'the browser stops routing through a Tor listener that may no longer be there');
ok(geo() && geo().active === false && !geo().pending,
   'and pages are told there is no verified country, rather than being left with a stale one',
   JSON.stringify(geo()));
ok(seen(/^cookies\.getAll:UULE$/).length === 1 && !JAR.some(c => c.name === 'UULE'),
   'the location cookie goes: it would otherwise keep naming a country the user has left',
   shown());
ok(JAR.length === 1 && JAR[0].name === 'SID',
   'but nothing else does -- quitting the app must not sign the user out, which is the ' +
   'whole difference between a disconnect and a switch', JSON.stringify(JAR.map(c => c.name)));
ok(!seen(/^browsingData\.remove/).length && !seen(/^tabs\./).length,
   'and site storage, history, the cache and open tabs are all left alone -- emptying a ' +
   'user\'s browser at the moment they quit the app destroys something for no visible gain',
   shown());
ok(prevLoc() && prevLoc().off === true && prevLoc().cc === 'NL',
   'the country they were in is kept, marked off, because starting up somewhere else later ' +
   'is still a country change as far as this browser is concerned', JSON.stringify(prevLoc()));

// ════════════════════════════════════════════════════════════════════
mark();
for (let i = 0; i < 3; i++) {
    JAR.push({ name: 'UULE', domain: '.google.com', path: '/', secure: true });
    fireTimers('t');
    await drain();
    sock().die();
    await drain();
}

console.log('\n── the app stays shut and the worker keeps retrying ──');
ok(seen(/^ws\.new:/).length === 3, 'it dials again, on a backoff', shown());
ok(!seen(/^cookies\.getAll/).length,
   'and does NOT sweep the jar once per failed attempt -- onclose fires every couple of seconds ' +
   'for as long as the app is shut, which would be all day', shown());
ok(JAR.filter(c => c.name === 'UULE').length === 3 && JAR.length === 4,
   'so nothing further is removed -- the three UULEs written since the app closed are all ' +
   'still there, alongside the session cookie the disconnect left alone',
   JSON.stringify(JAR.map(c => c.name)));

// ════════════════════════════════════════════════════════════════════
JAR = [{ name: 'UULE', domain: '.google.com', path: '/', secure: true }];
TABS = [{ id: 11, url: 'https://www.google.com/maps/@52.3676,4.9041,12z' }];
mark();
await use({ origin: 'https://www.google.com', url: 'https://www.google.com/maps' });
fireTimers('t');
await drain();
sock().open();
await sync(JP, 'jp');

console.log('\n── quit in Amsterdam, start the app again in Tokyo ──');
ok(INFO.filter(s => /country changed NL -> JP/.test(s)).length === 1,
   'that is a country change even though the app was shut in between', JSON.stringify(INFO.slice(-2)));
ok(seen(/^cookies\.getAll:UULE$/).length === 1 && !JAR.length, 'so the cookie is swept', shown());
ok(seen(BD_GEO).length === 1 &&
   seen(/^browsingData\.remove:\["https:\/\/www\.google\.com"\]\|cacheStorage\+/).length === 1,
   'the one site that had asked has its storage cleared', shown());
ok(seen(BD_MAP).length === 1 && !seen(BD_MAP_CK).length,
   'and its open map is cleared as a map as well -- google.com is not a map-only domain, so ' +
   'that half asks for no cookies', shown());
ok(seen(/^tabs\.update:11:https:\/\/www\.google\.com\/maps\/@35\.6895,139\.6917,12z$/).length === 1,
   'and its Amsterdam pin is moved to Tokyo', shown());

// ════════════════════════════════════════════════════════════════════
JAR = [{ name: 'UULE', domain: '.google.com', path: '/', secure: true }];
sock().die();
await drain();                      // quits in Tokyo -> cookie swept, marked off
mark();
fireTimers('t');
await drain();
sock().open();
await sync(JP, 'jp');               // and comes back in Tokyo

console.log('\n── quit and start again in the SAME country ──');
ok(!seen(/^cookies\.getAll/).length && !seen(/^browsingData/).length && !seen(/^tabs\./).length,
   'nothing is cleared: the country did not change, so there is nothing stale to clear', shown());
ok(prevLoc() && prevLoc().cc === 'JP' && !prevLoc().off,
   'and the "app is off" mark is lifted', JSON.stringify(prevLoc()));

// ════════════════════════════════════════════════════════════════════
mark();
STORE.geoOrigins = [];
const burst = ['https://a.example', 'https://b.example', 'https://c.example',
               'https://d.example', 'https://e.example'];
burst.forEach(o => onMessage({ type: 'GEO_USED' }, { origin: o, url: o + '/f' }, () => {}));
await drain();

console.log('\n── five cross-origin frames of one page report in the same tick ──');
ok(JSON.stringify(origins()) === JSON.stringify(burst),
   'all five are kept: two overlapping read-modify-writes would have thrown the earlier ' +
   'entries away, and a lost origin is a site whose storage survives the next switch',
   JSON.stringify(origins()));

// ════════════════════════════════════════════════════════════════════
mark();
STORE.geoOrigins = [];
for (let i = 0; i < 45; i++) {
    onMessage({ type: 'GEO_USED' },
              { origin: `https://s${i}.example`, url: `https://s${i}.example/x` }, () => {});
}
await drain();

console.log('\n── a long browsing session ──');
ok(origins().length === 40, 'the list is capped, so it cannot grow without bound',
   String(origins().length));
ok(origins()[0] === 'https://s5.example' && origins()[39] === 'https://s44.example',
   'and it is the oldest entries that fall off the front',
   origins().slice(0, 2).join(',') + ' .. ' + origins().slice(-1)[0]);

// ════════════════════════════════════════════════════════════════════
//  THE RECORD OF THE PREVIOUS COUNTRY GOES MISSING
//
//  Everything above decides "a switch happened" by comparing the incoming
//  country with `geoLast`. That record is the only thing standing between a
//  switch and a browser that keeps showing the old country -- and it lives in
//  chrome.storage.local because this worker is torn down after ~30 s idle, so
//  there is a real path where it is not there to compare against: a set() that
//  had not flushed when the worker was killed.
//
//  MEASURED: 2 of 12 runs of .build/test-geo-purge.js in a real Brave switched
//  country with nothing cleared at all -- no cookie sweep, no wipe, no reload,
//  and no line printed by any branch -- while the page itself was answered with
//  the new country every time. A missing `geoLast` is the one state that
//  produces exactly that, so the switch must not be decided on it alone.
STORE.geoOrigins = ['https://www.google.com'];
TABS = [{ id: 31, url: 'https://www.google.com/maps/@35.6895,139.6917,12z' },
        { id: 32, url: 'https://quiet.example/page' }];
JAR = [{ name: 'UULE', domain: '.google.com', path: '/', secure: true },
       { name: 'SID',  domain: '.google.com', path: '/', secure: true }];
delete STORE.geoLast;
INFO.length = 0;
mark();
await sync(NL, 'nl');

console.log('\n── the worker is killed before it can write down where it was ──');
ok(INFO.some(s => /no previous country on record but 1 site\(s\) were given one/.test(s)),
   'the switch is still acted on, and the console says which branch did it and why',
   JSON.stringify(INFO));
ok(seen(/^cookies\.getAll:UULE$/).length === 1 && !JAR.some(c => c.name === 'UULE'),
   'the location cookie is swept -- the measured carrier of the stale country',
   JSON.stringify(JAR.map(c => c.name)));
ok(seen(BD_MAP).length === 1 && seen(/^history\.search:/).length === 6 && !seen(BD_ANY_WIDE).length,
   'the map cache, map site storage and map history are cleared, which is what the user asked ' +
   'for on every switch', shown());
ok(seen(BD_GEO).length === 1 &&
   seen(/^browsingData\.remove:\["https:\/\/www\.google\.com"\]\|cacheStorage\+/).length === 1,
   'and the site that had been handed a position has its storage cleared', shown());
ok(seen(/^tabs\.update:31:https:\/\/www\.google\.com\/maps\/@52\.3676,4\.9041,12z$/).length === 1 &&
   !seen(/^tabs\.reload:31/).length,
   'its pinned map is repinned to the NEW country even though the previous one was lost: the ' +
   'repin is driven by the destination, read from geoRecord, and never needed the coordinates ' +
   'being left. This is the one step the old unpin-only code could not do in this branch, ' +
   'which is what the comment beside purgeLocationTraces(null, true) used to concede',
   shown());
ok(!seen(/^tabs\.(reload|update):32/).length,
   'the origin that never asked where it was is still left alone -- a lost record widens ' +
   'nothing beyond the sites already on the list', shown());
ok(prevLoc() && prevLoc().cc === 'NL',
   'and the record is written again, so the NEXT switch is decided the normal way',
   JSON.stringify(prevLoc()));

// ════════════════════════════════════════════════════════════════════
//  The other half of that rule, and the reason the trigger is the origin list
//  rather than "a UULE cookie exists": somebody who has never connected may
//  well have a UULE from ordinary use of Google, and wiping their history on
//  their first ever connect is damage they did not ask for. An origin can only
//  get onto the list while connected.
STORE.geoOrigins = [];
TABS = [{ id: 41, url: 'https://www.google.com/maps' }];
JAR = [{ name: 'UULE', domain: '.google.com', path: '/', secure: true },
       { name: 'SID',  domain: '.google.com', path: '/', secure: true }];
delete STORE.geoLast;
INFO.length = 0;
mark();
await sync(JP, 'jp');

console.log('\n── a first ever connect, with a UULE cookie from ordinary browsing ──');
ok(!seen(/^cookies\.getAll/).length && !seen(/^browsingData/).length && !seen(/^tabs\./).length,
   'nothing is cleared: no country is known to have been given to anything, so there is no ' +
   'switch here to act on', shown());
ok(JAR.length === 2,
   "and the user's own cookies are untouched -- signing them out on a first connect would be " +
   'a fix for a bug they do not have', JSON.stringify(JAR.map(c => c.name)));

// ════════════════════════════════════════════════════════════════════
//  Forks and older builds. The rule these two checks enforce is the project's:
//  never report coverage a read-back did not confirm -- say the route cannot
//  work here instead.
STORE.geoOrigins = ['https://www.google.com'];
TABS = [{ id: 21, url: 'https://www.google.com/maps' }];
JAR = [];
WARN.length = 0;
const savedCookies = chromeStub.cookies;
delete chromeStub.cookies;
mark();
await sync(NL, 'nl');

console.log('\n── a browser build without chrome.cookies ──');
ok(WARN.some(s => /chrome\.cookies is unavailable/.test(s)),
   'it says so, rather than reporting a sweep it never performed', JSON.stringify(WARN));
ok(seen(/^browsingData\.remove/).length === 2 && seen(/^tabs\.reload:21/).length === 1,
   'and it still does the part it can do', shown());
chromeStub.cookies = savedCookies;

STORE.geoOrigins = ['https://www.google.com'];
JAR = [{ name: 'UULE', domain: '.google.com', path: '/', secure: true }];
WARN.length = 0;
const savedBD = chromeStub.browsingData;
delete chromeStub.browsingData;
mark();
await sync(JP, 'jp');

console.log('\n── a browser build without chrome.browsingData ──');
ok(WARN.some(s => /the map cache and map site storage keep the previous country/.test(s)) &&
   WARN.some(s => /site storage keeps whatever/.test(s)),
   'same rule, and once for each clear it cannot do: the map one and the per-origin one ' +
   'are named separately rather than one warning standing in for both', JSON.stringify(WARN));
ok(seen(/^history\.deleteUrl:/).length >= 1,
   'and the map history still goes -- chrome.history is a different API, so losing one does ' +
   'not lose the other', shown());
ok(seen(/^cookies\.getAll:UULE$/).length === 1 && !JAR.length,
   'and the cookie -- the part that actually moves Maps -- is still removed', shown());
ok(seen(/^tabs\.reload:/).length >= 1,
   'and the switch still finishes: a missing API does not strand the purge half-done with ' +
   'the old country still on screen', shown());
chromeStub.browsingData = savedBD;

//  And a browser that HAS the API and refuses the call anyway -- an enterprise
//  policy pinning browsing data, or a profile in the middle of shutting down.
STORE.geoOrigins = ['https://www.google.com'];
TABS = [{ id: 22, url: 'https://www.google.com/maps' }];
JAR = [{ name: 'UULE', domain: '.google.com', path: '/', secure: true },
       { name: 'SID',  domain: '.google.com', path: '/', secure: true }];
WARN.length = 0;
BD_ERR = 'Clearing failed';
mark();
await sync(NL, 'nl');

console.log('\n── the browser refuses to clear ──');
ok(WARN.some(s => /could not clear the map cache and storage -- Clearing failed/.test(s)) &&
   WARN.some(s => /could not clear site storage -- Clearing failed/.test(s)),
   'it is reported in the browser\'s own words, not swallowed', JSON.stringify(WARN));
ok(seen(BD_MAP_NC).length === 1 &&
   WARN.some(s => /could not clear map site storage either/.test(s)),
   'the map clear is retried once without `cache`, because a build that refuses an ' +
   'origin-filtered cache clear can still take the four storage types -- and the second ' +
   'refusal is reported too rather than passed off as the first', shown());
ok(JAR.some(c => c.name === 'SID'),
   'and the jar really was not cleared, so this is the failure path and not a stub that ' +
   'reports one while doing the work', JSON.stringify(JAR.map(c => c.name)));
ok(seen(BD_GEO).length === 1 && seen(/^tabs\.reload:22/).length === 1,
   'the switch is not abandoned half-done either: the per-origin clear and the reload still ' +
   'run, so the pages that were told the old country still ask again', shown());
BD_ERR = null;

// ════════════════════════════════════════════════════════════════════
//  A BROWSER THAT TAKES THE CALL AND NEVER CALLS BACK
//
//  This is the measured failure, reproduced. .build/test-geo-purge.js left a
//  Brave profile behind on a red run and its extension storage read back as:
//  geoSpoof LU -> JP, geoLast LU -> JP, geoOrigins STILL ["http://127.0.0.1:8099"].
//  So the switch was recognised and the purge was entered, and it stopped before
//  emptying the origin list -- with the tab that was showing Luxembourg never
//  reloaded. A lost callback is the only thing that produces that combination,
//  and a chain of callbacks has no way to notice one.
//
//  Neither of the two stubs below ever answers. What has to survive that is the
//  part the user sees: the browser still gets cleared and the stale tab still
//  asks again.
STORE.geoOrigins = ['https://www.google.com'];
TABS = [{ id: 51, url: 'https://www.google.com/maps' }];
JAR = [{ name: 'UULE', domain: '.google.com', path: '/', secure: true }];
const realGetAll = chromeStub.cookies.getAll;
chromeStub.cookies.getAll = (q) => { lg('cookies.getAll:' + q.name + ':NEVER-ANSWERS'); };
//  NL is what the block above left on record, so this has to be a different
//  country or there is no switch to purge and the test would prove nothing.
mark();
await sync(JP, 'jp');

console.log('\n── the cookie sweep never calls back ──');
ok(seen(/^cookies\.getAll:UULE:NEVER-ANSWERS$/).length === 1 &&
   !seen(/^browsingData/).length,
   'nothing follows it on its own: the chain really is stalled at the first stage', shown());
ok(fireTimers('t') > 0, 'a deadline was armed when the stage started');
await drain();
ok(seen(BD_MAP).length === 1,
   'the deadline carries the switch past the stalled stage: the map cache and storage ' +
   'are cleared anyway', shown());
ok(seen(BD_GEO).length === 1 && seen(/^tabs\.reload:51/).length === 1,
   'and the site storage goes and the stale tab asks again -- which is the whole visible ' +
   'point of a switch purge', shown());
ok(seen(/^cookies\.remove/).length === 0,
   'the stage that stalled is not faked as having succeeded: no cookie is reported removed, ' +
   'because none was', shown());
chromeStub.cookies.getAll = realGetAll;

// ════════════════════════════════════════════════════════════════════
//  Same argument, one stage further in: the wipe is the slow one, so its
//  deadline has to be the generous one -- a reload that starts while the cache
//  is still being cleared refills it, which is the ordering bug this file opens
//  by describing. Here NOTHING chrome.browsingData is asked for ever answers, so
//  both of the remaining deadlines have to carry it, one after the other.
STORE.geoOrigins = ['https://www.google.com'];
TABS = [{ id: 52, url: 'https://www.google.com/maps' }];
JAR = [{ name: 'UULE', domain: '.google.com', path: '/', secure: true }];
BD_HANG = true;
mark();
await sync(NL, 'nl');

console.log('\n── the map clear never calls back ──');
ok(seen(/^cookies\.getAll:UULE$/).length === 1 && !JAR.length,
   'the cookie sweep finished normally', shown());
ok(seen(BD_MAP).length === 1 && !seen(/^tabs\.(reload|update):/).length,
   'the clear was asked for and has not answered, so nothing has been reloaded yet', shown());
let fired = 0;
for (let i = 0; i < 4; i++) { fired += fireTimers('t'); await drain(); }
ok(fired >= 2, 'two deadlines fire, in turn: one per unanswered stage', String(fired));
ok(seen(/^storage\.set:geoOrigins=\[\]$/).length === 1 &&
   seen(/^tabs\.reload:52/).length === 1,
   'and the switch finishes: the origin list is emptied and the stale tab asks again, ' +
   'rather than the purge sitting for ever behind one unanswered call', shown());
ok(firstBefore(BD_MAP, /^tabs\.reload:52/),
   'and the order the whole file turns on is still kept -- the clear was asked for before ' +
   'any tab was reloaded, even when the browser never said it had finished', shown());
BD_HANG = false;
for (let i = 0; i < 4; i++) { fireTimers('t'); await drain(); }   // no leftovers into the next block

// ════════════════════════════════════════════════════════════════════
//  And the deadlines must not double anything on the normal path, or every
//  switch would clear twice and reload every stale tab twice.
STORE.geoOrigins = ['https://www.google.com'];
TABS = [{ id: 53, url: 'https://www.google.com/maps' }];
JAR = [{ name: 'UULE', domain: '.google.com', path: '/', secure: true }];
mark();
await sync(JP, 'jp');
const beforeTimers = shown();
for (let i = 0; i < 4; i++) { fireTimers('t'); await drain(); }

console.log('\n── a healthy switch, with the deadlines firing afterwards ──');
ok(seen(BD_MAP).length === 1 && seen(BD_GEO).length === 1 &&
   seen(/^tabs\.reload:53/).length === 1,
   'each stage ran exactly once even though every deadline fired after it', shown());
ok(shown() === beforeTimers,
   'the deadlines added nothing at all: not one extra call after the purge completed',
   shown().slice(beforeTimers.length));

// ════════════════════════════════════════════════════════════════════
//  THE MEASURED RACE. Two states arriving back-to-back -- which is what a
//  connect immediately followed by a switch looks like on the wire, and what the
//  desktop app actually sends -- so the first record is still being written when
//  the second one is handled.
//
//  This is the red run of .build/test-geo-purge.js on Brave, reproduced offline.
//  Its profile was kept and chrome.storage.local read straight off disk; LevelDB
//  appends, so the file IS the write order, and it was geoSpoof{LU}, geoSpoof{JP},
//  THEN geoLast{LU}, geoLast{JP}. The previous country landed after the switch had
//  already been decided, so the switch read no previous country, matched no
//  branch, cleared nothing, and left the tab showing Luxembourg. Deadlines did not
//  help, because nothing was ever waiting -- the purge was never entered.
//
//  Note there is no drain() between the two deliveries. That is the entire test:
//  with one, every callback has already landed and the race cannot happen.
delete STORE.geoLast;                       // a browser with no country on record
STORE.geoOrigins = [];                      // ...and none recorded yet either, as measured
TABS = [{ id: 61, url: 'https://www.google.com/maps/@49.6116,6.1319,12z' }];
JAR = [{ name: 'UULE', domain: '.google.com', path: '/', secure: true }];
mark();
const iRace = INFO.length;
sock().deliver({ type: 'STATE_SYNC', state: stateFor(LU, 'lu') });
sock().deliver({ type: 'STATE_SYNC', state: stateFor(JP, 'jp') });
await drain();
for (let i = 0; i < 4; i++) { fireTimers('t'); await drain(); }

console.log('\n── a connect and a switch arriving in the same tick ──');
const luAt = at(/^storage\.set:geoLast=\{"cc":"LU"/);
const sweepAt = at(/^cookies\.getAll:UULE$/);
ok(luAt >= 0 && sweepAt > luAt,
   'the second record is not examined until the first one has been written down: the country ' +
   'being left was on record before the purge for it started', shown());
ok(INFO.slice(iRace).some(s => /country changed LU -> JP/.test(s)),
   'so the switch is SEEN as a switch, with the country it came from named', INFO.slice(iRace).join('\n         '));
ok(seen(BD_MAP).length === 1,
   'and the map cache, storage and history are cleared -- exactly once, not zero times as ' +
   'measured and not twice', shown());
ok(seen(/^cookies\.removed:UULE$/).length === 1 && !JAR.length,
   'the cookie that carries the old country to Google is gone', shown());
ok(seen(/^tabs\.update:61:https:\/\/www\.google\.com\/maps\/@35\.6895,139\.6917,12z$/).length === 1,
   'and the map pinned to the old country is repinned to the new one', shown());
ok(JSON.stringify(prevLoc()) === JSON.stringify({ cc: 'JP', lat: JP.lat, lng: JP.lng }),
   'and what is left on record is where the browser is NOW, so the next switch compares ' +
   'against the right country', JSON.stringify(prevLoc()));

// ════════════════════════════════════════════════════════════════════
//  The cost of putting that read-modify-write on a queue is that a lost storage
//  callback would hold the queue -- and the queue is shared with the origin
//  notes, so it would stall every later switch in the session, not just this one.
//  Hence the deadline on the release. Here storage.local.set stores but never
//  answers, and the claim is deliberately the weak, honest one: THIS switch loses
//  its purge, the next one does not.
const realSet = chromeStub.storage.local.set;
chromeStub.storage.local.set = obj => realSet(obj);      // stores; the callback is lost
STORE.geoLast = { cc: 'LU', lat: LU.lat, lng: LU.lng };
STORE.geoOrigins = ['https://www.google.com'];
TABS = [{ id: 62, url: 'https://www.google.com/maps' }];
JAR = [{ name: 'UULE', domain: '.google.com', path: '/', secure: true }];
mark();
await sync(JP, 'jp');

console.log('\n── a storage write that never calls back ──');
ok(!seen(/^browsingData\./).length && !seen(/^tabs\./).length,
   'this switch clears nothing: the purge starts from the write callback, and it never came',
   shown());
ok(prevLoc() && prevLoc().cc === 'JP',
   'the record itself did land, though -- only the answer was lost', JSON.stringify(prevLoc()));
chromeStub.storage.local.set = realSet;
ok(fireTimers('t') > 0, 'a deadline was armed on the release, not just on the purge stages');
await drain();
mark();
await sync(NL, 'nl');
ok(seen(BD_MAP).length === 1 && seen(BD_GEO).length === 1 &&
   seen(/^storage\.set:geoOrigins=\[\]$/).length === 1 &&
   seen(/^tabs\.reload:62/).length === 1,
   'and the NEXT switch purges normally: one lost callback does not wedge the queue for ' +
   'the rest of the session', shown());

// ════════════════════════════════════════════════════════════════════
//  THE REPORT: "app e jokhon kono country te connected thakchena tokhon brave
//  kono net pacchena but jekono country te connect korar sathe sathe pacche."
//
//  Measured cause (.build/probe-brave-proxy-who.js): the persistent proxy pref
//  this extension writes was still in Brave's profile with the app shut down and
//  nothing on 9050, while every other proxy layer was already off. Every clear()
//  needs a LIVE service worker, and an MV3 worker torn down with the proxy set
//  cannot be woken by a failed navigation -- so nothing recovered.
//
//  Everything below is about the ONE path out of that: an alarm. What matters is
//  not only that it recovers, but that it cannot fire while the VPN is up --
//  a watchdog that drops a live proxy is a real-IP leak every 30 s.
mark();
await sync(NL, 'nl');

console.log('\n── the proxy watchdog: armed while the browser is on Tor ──');
ok(seen(/^proxy\.set:socks5:\/\/127\.0\.0\.1:9050$/).length === 1 &&
   at(/^alarms\.create:fp-proxy-guard:/) >= 0,
   'setting the proxy arms a guard: it is the only thing that can wake an evicted worker',
   shown());
ok(ALARMS.has('fp-proxy-guard') && ALARMS.get('fp-proxy-guard').periodInMinutes === 0.5,
   'and it REPEATS every 30 s -- a one-shot would stop watching while the proxy stayed set',
   JSON.stringify(ALARMS.get('fp-proxy-guard')));
ok(at(/^alarms\.create:fp-proxy-guard:/) < at(/^proxy\.set:/),
   'armed before the write, so the gap between the two cannot leave an unwatched proxy',
   shown());

mark();
ok(fireAlarm('fp-proxy-guard'),
   'the worker registered a listener for it at module scope, where a woken worker still has one');
await drain();
ok(!seen(/^proxy\.off:direct$/).length,
   'and firing it with the app answering does NOTHING: dropping a live VPN\'s proxy every ' +
   '30 s would put the real IP on the wire', shown());

// ── the failure that was actually reported ──────────────────────────
//  The socket is gone and onclose never ran. That is what a torn-down worker
//  looks like from the outside: no close event was ever delivered to this code,
//  so nothing in it knows the app is gone. Everything from here on happens in
//  that state, which is also the only state where the alarm's NAME is the last
//  thing standing between another feature's tick and a dropped proxy.
mark();
sock().readyState = 3;                                  // CLOSED, silently
fireAlarm('some-other-alarm');
await drain();
ok(!seen(/^proxy\.off:direct$/).length,
   "another extension's alarm cannot make this one let go of the proxy -- checked with the " +
   'socket already dead, where the name is the only thing left to stop it', shown());

mark();
fireAlarm('fp-proxy-guard');
await drain();

console.log('\n── the app went away without the worker hearing it ──');
ok(seen(/^proxy\.off:direct$/).length === 1,
   'the guard notices the socket is dead and releases the proxy -- this is the ' +
   'ERR_PROXY_CONNECTION_FAILED that only "connect to any country" used to clear', shown());
ok(!ALARMS.has('fp-proxy-guard') && seen(/^alarms\.clear:fp-proxy-guard$/).length === 1,
   'and it disarms itself, so a browser already safe is not woken every 30 s forever',
   shown());
ok(seen(/^ws\.new:ws:\/\/127\.0\.0\.1:8080$/).length === 1,
   'and it dials the app again: a torn-down worker lost its reconnect timer, so without ' +
   'this the extension would never notice the app coming back either', shown());
ok(WARN.some(s => /not answering/.test(s)),
   'and it says so, naming why the proxy was released', WARN.slice(-2).join(' | '));

// ── the tick after that, with the app still down ─────────────────────
//  This is the ordinary case, not an edge one. The browser wakes an evicted
//  worker to deliver the alarm; module evaluation runs first and dials the app,
//  so by the time the handler is reached the socket is CONNECTING and has heard
//  nothing back. If that counted as "dead", every 30 s the app stayed down would
//  add another clear and another socket on top of a dial already in flight.
mark();
ok(sock().readyState === 0, 'the dial it just made is still in flight, not open and not dead');
fireAlarm('fp-proxy-guard');
await drain();
ok(!seen(/^proxy\.off:direct$/).length && !seen(/^ws\.new/).length && !phase().length,
   'a guard tick during that dial does nothing at all: no second clear, and no second ' +
   'socket piled on the one already connecting', shown());

mark();
sock().open();
await sync(NL, 'nl');
ok(seen(/^proxy\.set:socks5:\/\/127\.0\.0\.1:9050$/).length === 1 && ALARMS.has('fp-proxy-guard'),
   'the app comes back, the browser goes back on Tor, and the guard is armed again', shown());

//  The other half of the fix lives in main.js: the app now ANSWERS the 20 s
//  keepalive instead of swallowing it, because only WebSocket traffic resets
//  Chromium's worker idle timer -- a worker kept alive is one whose onclose can
//  release the proxy at 0 s instead of the watchdog doing it up to 30 s later.
//  What has to be true HERE is that the reply is inert: a new message type
//  arriving on this socket must not be mistaken for state.
mark();
const geoBeforePong = JSON.stringify(geo());
sock().deliver({ type: 'PONG' });
await drain();
ok(!phase().length && JSON.stringify(geo()) === geoBeforePong,
   "the app's keepalive reply is inert: it holds the worker alive without touching the " +
   'proxy, the location or the badge', shown() || '(nothing, as required)');

mark();
await sync(null, 'nl');
ok(seen(/^proxy\.off:direct$/).length === 1 && !ALARMS.has('fp-proxy-guard'),
   'and an ordinary disconnect still releases both, without waiting for any alarm', shown());

// ════════════════════════════════════════════════════════════════════
//  "brave e net pacchina" -- the proxy that outlives the browser
// ════════════════════════════════════════════════════════════════════
//  Measured 2026-09-02: Brave's own profile still held
//  socks5://127.0.0.1:9050 on this extension's record with the app shut down,
//  while Chrome's and Edge's were empty. The difference was the ORDER things
//  closed in -- Brave was closed first, while the app was still connected, so
//  onclose never ran and no alarm can run in a browser that is not running. The
//  pref is persistent, so the next start read it back and every page failed.
//
//  Starting the browser does repair it, but .build/probe-brave-start-clears.js
//  timed that repair at 11.1 s -- the cost of starting the worker, which nothing
//  in this file can shorten. So the proxy is let go while a worker is still
//  alive to do it: at the last window close.
console.log('\n── the last window closing releases the proxy ──');
mark();
WINS = [{ id: 1 }, { id: 2 }];
await sync(LU, 'lu');
ok(seen(/^proxy\.set:socks5:\/\/127\.0\.0\.1:9050$/).length === 1,
   'connected with two windows open: the browser is on Tor, as it should be', shown());
ok(STORE.fpProxyLeftOn === true,
   'and the profile carries a mark saying so -- the only thing a NEXT start can read, ' +
   'because module evaluation clears the pref before anything can look at it',
   JSON.stringify(STORE.fpProxyLeftOn));

mark();
ok(closeWindow(2), 'chrome.windows.onRemoved has a listener: it needs no permission, so ' +
   'nothing has to be re-approved for this');
await drain();
ok(seen(/^windows\.getAll$/).length === 1 && !seen(/^proxy\.off:direct$/).length,
   'closing one window of two changes nothing: it asked how many were left and found one', shown());
ok(STORE.fpProxyLeftOn === true, 'the mark stands too -- the browser is still on Tor');

mark();
closeWindow(1);
await drain();
ok(seen(/^proxy\.off:direct$/).length === 1,
   'closing the LAST one releases it, while a worker is still alive to be asked -- this is ' +
   'the 11.1 s of no internet, not happening', shown());
ok(!ALARMS.has('fp-proxy-guard'), 'and the guard goes with it: nothing left to watch', shown());
ok(!('fpProxyLeftOn' in STORE),
   'and so does the mark, so the next start has nothing to repair and reloads nothing', shown());

//  Nothing is browsing at that moment -- with no window there is no page -- so
//  the release cannot take a live VPN's proxy away from anything on screen. But
//  the browser can still be RUNNING: Chromium's background mode, or a lingering
//  worker. A window opening then would come back with no proxy while the app
//  still says connected, and the real IP would be on the wire with the UI
//  claiming otherwise. That is a leak, and it would be worse than the bug.
console.log('\n── and a window opening puts it straight back ──');
mark();
ok(openWindow(3), 'chrome.windows.onCreated has a listener as well');
await drain();
ok(seen(/^proxy\.set:socks5:\/\/127\.0\.0\.1:9050$/).length === 1,
   'the app still says connected, so the proxy is back before that window can load anything ' +
   '-- without this the release above would be a real-IP leak, not a fix', shown());
ok(STORE.fpProxyLeftOn === true && ALARMS.has('fp-proxy-guard'),
   'with the mark and the guard restored alongside it, exactly as an ordinary connect does',
   shown());

mark();
await sync(null, 'lu');                                  // ordinary disconnect
WINS = [];
closeWindow(3);
await drain();
mark();
openWindow(4);
await drain();
ok(!seen(/^proxy\.set/).length,
   'but with the app disconnected, opening a window does NOT put a proxy back: the ' +
   're-assert follows the app\'s state, it does not assume it', shown() || '(nothing, as required)');

// ── the mark is written once, not once per STATE_SYNC ────────────────
//  The app sends state constantly -- every progress tick, every countdown
//  second. A mark rewritten on each of those would be thousands of LevelDB
//  writes per session for a value that changed once.
mark();
await sync(LU, 'lu');
await sync(LU, 'lu');
await sync(LU, 'lu');
ok(seen(/^storage\.set:fpProxyLeftOn=true$/).length === 1,
   'three states in, one mark written: it tracks the transition, not the traffic', shown());
ok(seen(/^storage\.remove:fpProxyLeftOn$/).length === 0,
   'and nothing removed it in between, which would have left a window where a crash ' +
   'looked clean', shown());

// ── an ordinary quit does not reload anything ───────────────────────
//  The other direction of the same fix, and the one that can do damage. A
//  reload sweep throws away scroll position and half-filled forms. It is owed
//  only to pages that are ALREADY error pages -- which, on a quit, they are not:
//  they loaded fine through Tor a moment ago.
mark();
TABS = [{ id: 71, url: 'https://mail.example.com/compose' }];
sock().die();
await drain();
ok(seen(/^proxy\.off:direct$/).length === 1,
   'the app quitting releases the proxy, as it always did', shown());
ok(!seen(/^tabs\.reload/).length,
   'and reloads NOTHING: this profile did not start stranded, so the half-written mail in ' +
   'tab 71 is still there', shown());
for (let i = 0; i < 4; i++) { fireTimers('t'); await drain(); if (WS.length) sock().die(); await drain(); }
ok(!seen(/^tabs\.reload/).length,
   'and four failed reconnects later, still nothing -- onclose fires every couple of ' +
   'seconds for as long as the app stays shut, and none of them may become a reload loop',
   shown());

// ════════════════════════════════════════════════════════════════════
console.log(`\n${pass}/${pass + fail} checks passed`);
if (fail) {
    console.log('\n── the whole call log, for the failures above ──');
    LOG.forEach((s, i) => console.log(String(i).padStart(4) + ': ' + s));
}
process.exit(fail ? 1 : 0);

})().catch(e => { console.log('ABORT: ' + e.stack); process.exit(3); });
