'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/test-geo-freshness.js
//
//  THE REPORTED LEAK, 2026-09-04. Connected to the Netherlands; Google Maps in
//  Brave showed the device's real position in Dhaka at full precision, with
//  Google's own "From your device" label on it.
//
//  The chain: an already-open tab was correctly told "the app is off" at a
//  disconnect; Chromium then evicted the service worker (the reconnect chain is
//  an in-memory setTimeout, and the proxy guard is deliberately disarmed while
//  the proxy is off, so nothing was left that could start the worker again); the
//  app connected to NL minutes later; no storage change ever reached the page.
//  The tab was still holding "off", so its next geolocation call went to
//  Chromium's own Wi-Fi provider, which does not care where the traffic exits.
//
//  Four rules had to become true, and they are the four numbered groups below:
//    1  "off" is POSITIVE evidence (appOff:true). A bare {active:false} -- what
//       every clean disconnect used to write -- authorises nothing.
//    2  Every record carries the moment it was written.
//    3  A page can WAKE an evicted worker (the ASK event), and the worker can
//       re-dial with no page to ask it (the fp-app-poll alarm, the only thing
//       in this extension that survives eviction).
//    4  When a re-ask goes unanswered, a stale "off" does NOT reach the real
//       provider. Only this last rule closes the leak; the first three narrow
//       the window it needs.
//
//  Part 1 runs Extension/background.js in a vm against stubs, driven only
//  through its real entry points: the desktop app's socket, chrome.alarms and
//  chrome.runtime.onMessage.
//  Part 2 runs Extension/geo-spoof.js against a fake page and counts, in every
//  state that page can be in, how many times Chromium's real getCurrentPosition
//  was reached. REAL below is the exact position off the screenshot, so a
//  failure names the leak rather than reporting a boolean.
// ════════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const BG    = process.env.FP_BG    || path.join(__dirname, '..', 'Extension', 'background.js');
const SPOOF = process.env.FP_SPOOF || path.join(__dirname, '..', 'Extension', 'geo-spoof.js');
const bgSrc    = fs.readFileSync(BG, 'utf8');
const spoofSrc = fs.readFileSync(SPOOF, 'utf8');

let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
    if (cond) { pass++; console.log('  ok   ' + name); }
    else { fail++; console.log('  FAIL ' + name + (extra ? '\n         ' + extra : '')); }
};

//  Both files stamp with Date.now() and both measure age with it, so the clock
//  has to be ours or "stale" is not a state this suite can reach.
const T0 = 1767225600000;
function mkDate(clock) {
    return class D extends Date {
        constructor(...a) { if (!a.length) super(clock.t); else super(...a); }
        static now() { return clock.t; }
    };
}
// ════════════════════════════════════════════════════════════════════
//  PART 1 -- the service worker
// ════════════════════════════════════════════════════════════════════
const BC = { t: T0 };

//  Two queues. `queue` is every asynchronous chrome.* callback and drain() runs
//  it to exhaustion; `timers` is setTimeout/setInterval and drain() never touches
//  it, because background.js reconnects on a timer and a drain that fired those
//  would reconnect for ever. The test fires them by hand.
const queue = [];
const timers = [];
const soon = fn => queue.push(fn);
const later = fn => { let n = 6; const step = () => { if (--n > 0) queue.push(step); else fn(); }; queue.push(step); };

async function drain(limit) {
    let n = 0;
    for (;;) {
        await new Promise(r => setImmediate(r));
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

const LOG = [];
const lg = s => { LOG.push(s); return s; };
let MARK = 0;
const mark = () => { MARK = LOG.length; };
const phase = () => LOG.slice(MARK);
const seen = re => phase().filter(s => re.test(s));
const shown = () => phase().join('\n         ');

const STORE = {};
const storage = {
    local: {
        get(keys, cb) {
            const want = keys === null || keys === undefined
                ? Object.keys(STORE) : (Array.isArray(keys) ? keys : [keys]);
            soon(() => { const out = {}; for (const k of want) if (k in STORE) out[k] = STORE[k]; cb(out); });
        },
        set(obj, cb) {
            const copy = {};
            for (const k of Object.keys(obj)) copy[k] = JSON.parse(JSON.stringify(obj[k]));
            soon(() => {
                for (const k of Object.keys(copy)) STORE[k] = copy[k];
                lg('storage.set:' + Object.keys(copy).join(','));
                if (cb) cb();
            });
        },
        remove(keys, cb) {
            const want = Array.isArray(keys) ? keys : [keys];
            soon(() => { for (const k of want) delete STORE[k]; lg('storage.remove:' + want.join(',')); if (cb) cb(); });
        },
    },
    onChanged: { addListener: () => {} },
};
//  The alarm set is kept live, so "is one armed right now" is a question the
//  checks can ask, and fireAlarm() is the only way an alarm ever goes off here.
const ALARMS = new Map();
let onAlarm = null;
const alarms = {
    create(name, info) {
        ALARMS.set(name, info || {});
        lg(`alarms.create:${name}:period=${info && info.periodInMinutes}`);
    },
    clear(name, cb) { ALARMS.delete(name); lg('alarms.clear:' + name); if (cb) soon(() => cb(true)); },
    onAlarm: { addListener: fn => { onAlarm = fn; } },
};
const fireAlarm = name => { if (!onAlarm) return false; onAlarm({ name }); return true; };

let onMessage = null;
const hooks = {};
const runtime = {
    lastError: undefined,
    getURL: p => 'chrome-extension://fp/' + String(p),
    onInstalled: { addListener: fn => { hooks.installed = fn; } },
    onStartup: { addListener: fn => { hooks.startup = fn; } },
    onMessage: { addListener: fn => { onMessage = fn; } },
    sendMessage(msg, cb) { if (cb) { soon(() => cb({})); return undefined; } return Promise.resolve(); },
};

const proxy = {
    settings: {
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

//  Everything the switch purge touches. This suite is not about the purge --
//  .build/test-geo-switch.js owns that -- so these answer empty; they exist so
//  the chain completes instead of throwing halfway through a state sync.
const tabs = {
    query(o, cb) { lg('tabs.query'); later(() => cb([])); },
    reload(id, o, cb) { lg('tabs.reload:' + id); if (cb) soon(() => cb()); },
    update(id, o, cb) { lg('tabs.update:' + id); if (cb) soon(() => cb({ id })); },
    create(o, cb) { lg('tabs.create'); if (cb) soon(() => cb({ id: 1 })); },
};
const cookies = {
    getAll(o, cb) { lg('cookies.getAll'); later(() => cb([])); },
    remove(o, cb) { lg('cookies.remove'); later(() => cb(null)); },
};
const browsingData = { remove(o, types, cb) { lg('browsingData.remove'); if (cb) later(() => cb()); } };
const history = {
    search(o, cb) { lg('history.search'); later(() => cb([])); },
    deleteUrl(o, cb) { lg('history.deleteUrl'); if (cb) later(() => cb()); },
};
const winHooks = {};
const windows = {
    getAll(q, cb) { lg('windows.getAll'); later(() => cb([{ id: 1 }])); },
    onRemoved: { addListener: fn => { winHooks.removed = fn; } },
    onCreated: { addListener: fn => { winHooks.created = fn; } },
};
const action = { setBadgeText: o => lg('badge:' + JSON.stringify(o && o.text)), setBadgeBackgroundColor: () => {} };
const notifications = { create: (id, o, cb) => { lg('notify:' + id); if (cb) soon(() => cb()); } };
//  Nothing on this socket happens on its own: open(), deliver() and die() are
//  the three things the desktop app can do to a worker, and the test decides
//  when each one happens.
const WS = [];
class FakeSocket {
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; WS.push(this); lg('ws.new:' + url); }
    send(s) { this.sent.push(s); }
    close() { this.die(); }
    open() { this.readyState = 1; if (this.onopen) this.onopen(); }
    deliver(obj) { if (this.onmessage) this.onmessage({ data: JSON.stringify(obj) }); }
    die() { if (this.readyState === 3) return; this.readyState = 3; if (this.onclose) this.onclose(); }
}
FakeSocket.CONNECTING = 0; FakeSocket.OPEN = 1; FakeSocket.CLOSING = 2; FakeSocket.CLOSED = 3;

const bgSandbox = {
    chrome: { runtime, storage, cookies, browsingData, tabs, history, windows, proxy,
              action, notifications, alarms },
    WebSocket: FakeSocket,
    URL,
    Date: mkDate(BC),
    console: { log: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    setTimeout: (fn, ms) => timers.push({ fn, ms, kind: 't' }),
    clearTimeout: id => { if (timers[id - 1]) timers[id - 1].dead = true; },
    setInterval: (fn, ms) => timers.push({ fn, ms, kind: 'i' }),
    clearInterval: id => { if (timers[id - 1]) timers[id - 1].dead = true; },
};
bgSandbox.self = bgSandbox;
vm.createContext(bgSandbox);

const NL = { lat: 52.3676, lng: 4.9041, accuracy: 18, city: 'Amsterdam', cc: 'NL' };
const JP = { lat: 35.6895, lng: 139.6917, accuracy: 18, city: 'Tokyo', cc: 'JP' };
//  The device's real position, off the reported screenshot's own URL.
const REAL = { lat: 23.7209283, lng: 90.4220325 };

//  The exact shape main.js puts on the wire. `connected` is passed separately
//  from the coordinates, because "connected with geo:null" is one of the three
//  states this suite exists to tell apart.
const stateFor = (c, code, connected) => ({
    connected: connected === undefined ? !!c : !!connected,
    serverCode: code || '', killSwitch: false, bypassList: '', servers: {},
    geo: c ? { lat: c.lat, lng: c.lng, accuracy: c.accuracy, city: c.city, cc: c.cc } : null,
});

const sock = () => WS[WS.length - 1];
const geo = () => STORE.geoSpoof;
const acks = s => (s ? s.sent : []).map(x => { try { return JSON.parse(x); } catch (e) { return {}; } })
                                   .filter(f => f && f.command === 'GEO_STATE');
const lastAck = s => { const a = acks(s); return a[a.length - 1] || null; };
const sync = async (c, code, connected) => {
    sock().deliver({ type: 'STATE_SYNC', state: stateFor(c, code, connected) });
    await drain();
};
const askGeo = fresh => {
    let r = null;
    onMessage(fresh ? { type: 'GET_GEO', fresh: true } : { type: 'GET_GEO' }, {}, x => { r = x; });
    return r;
};
(async () => {

// ════════════════════════════════════════════════════════════════════
mark();
vm.runInContext(bgSrc, bgSandbox, { filename: 'background.js' });
await drain();

console.log('── a worker that has only just started ──');
ok(geo() && geo().active === false && geo().pending === true && geo().appOff === undefined,
   'the record is "not known yet" -- not "off". A worker start says nothing about the app',
   JSON.stringify(geo()));
ok(geo() && typeof geo().stamp === 'number' && geo().stamp === T0,
   'and it is stamped with the moment it was written -- rule 2 applies to every record',
   JSON.stringify(geo()));
ok(!ALARMS.has('fp-app-poll'),
   'no app-poll alarm yet: a dial is already in flight, so there is nothing to wake');
ok(!acks(sock()).length,
   'and nothing is claimed to the app over a socket that has not opened -- silence is the ' +
   'honest answer when there is no link', JSON.stringify(sock().sent));

// ════════════════════════════════════════════════════════════════════
mark();
sock().open();
await drain();

console.log('\n── the app answers, before it says anything about a country ──');
ok(seen(/^alarms\.clear:fp-app-poll$/).length === 1,
   'the app-poll is stood down the moment the link is up -- a browser talking to the app ' +
   'never pays for it', shown());
const openAck = lastAck(sock());
ok(openAck && openAck.armed === false && openAck.pending === true,
   'the browser reports what it is actually holding, unprompted: pending, not armed. ' +
   'main.js used to infer "spoofed" from the extension being installed',
   JSON.stringify(openAck));
ok(openAck && openAck.cc === '' && openAck.city === '',
   'and names no country while it is not armed, so nothing can be counted as covered',
   JSON.stringify(openAck));

// ════════════════════════════════════════════════════════════════════
mark();
BC.t = T0 + 3000;
await sync(NL, 'nl');

console.log('\n── connected to the Netherlands ──');
ok(geo() && geo().active === true && geo().cc === 'NL' && geo().lat === NL.lat,
   'the page-facing record becomes the connected country', JSON.stringify(geo()));
ok(geo() && geo().stamp === T0 + 3000,
   'stamped at the moment of the state sync, not at worker start', JSON.stringify(geo()));
const nlAck = lastAck(sock());
ok(nlAck && nlAck.armed === true && nlAck.cc === 'NL' && nlAck.city === 'Amsterdam' &&
   nlAck.pending === false,
   'and the app is TOLD it is armed for NL by the browser itself -- the only evidence that ' +
   'a spoof is actually in force in there', JSON.stringify(nlAck));
// ════════════════════════════════════════════════════════════════════
//  RULE 1. The three states, and the one that used to be written by accident.
mark();
BC.t = T0 + 6000;
await sync(null, 'nl', true);          // the app is connected but has sent no coordinates

console.log('\n── connected, with no coordinates yet ──');
ok(geo() && geo().active === false && geo().pending === true && geo().appOff !== true,
   'that is PENDING, never "off" -- the app is plainly there, so handing the page to ' +
   "Chromium's own provider would be a lie about the app", JSON.stringify(geo()));
const midAck = lastAck(sock());
ok(midAck && midAck.armed === false && midAck.pending === true && midAck.cc === '',
   'the app is told the spoof is no longer armed, and the country is dropped with it',
   JSON.stringify(midAck));

// ════════════════════════════════════════════════════════════════════
mark();
BC.t = T0 + 9000;
await sync(NL, 'nl');
const liveSock = sock();
const armedAcks = acks(liveSock).length;
BC.t = T0 + 12000;
sock().die();
await drain();

console.log('\n── the app quits ──');
ok(geo() && geo().active === false && geo().appOff === true && geo().pending !== true,
   'now it is "off", and it says so with a flag rather than by leaving one out. This is the ' +
   'only record that may authorise the real provider', JSON.stringify(geo()));
ok(geo() && geo().stamp === T0 + 12000,
   'stamped at the disconnect, which is what makes it go stale later', JSON.stringify(geo()));
ok(ALARMS.has('fp-app-poll') && ALARMS.get('fp-app-poll').periodInMinutes === 1,
   'and the app-poll alarm is armed: scheduleReconnect() is a setTimeout that dies with the ' +
   'worker, and an alarm is the only thing Chromium leaves behind', shown());
ok(acks(liveSock).length === armedAcks,
   'no further claim is put on a dead socket. The app counts only browsers that are talking ' +
   'to it right now, so a browser that goes quiet stops being counted rather than lingering ' +
   'as "covered"', JSON.stringify(acks(liveSock).slice(armedAcks)));
ok(!seen(/^ws\.new/).length,
   'the re-dial is on the backoff, not immediate -- the alarm is what covers the case where ' +
   'this worker is not alive to run it', shown());

// ════════════════════════════════════════════════════════════════════
//  RULE 3. The wake-up, which is the part that did not exist.
mark();
BC.t = T0 + 72000;
ok(fireAlarm('fp-app-poll'), 'the app-poll alarm has a listener registered at module scope');
await drain();

console.log('\n── the alarm fires after the worker was evicted ──');
ok(seen(/^ws\.new:ws:\/\/127\.0\.0\.1:8080$/).length === 1,
   'it dials the app again -- without this, a browser whose worker was evicted with the app ' +
   'down never notices the app coming back', shown());
const dialsAfterAlarm = seen(/^ws\.new/).length;
fireTimers('t');
await drain();
ok(seen(/^ws\.new/).length === dialsAfterAlarm,
   'and the backoff timer it replaced was cancelled, so the alarm and the backoff cannot ' +
   'dial in parallel', shown());
fireAlarm('fp-app-poll');
await drain();
ok(seen(/^ws\.new/).length === dialsAfterAlarm,
   'a second alarm while that dial is still in flight does nothing: a socket that is ' +
   'CONNECTING is not a dead one', shown());
// ════════════════════════════════════════════════════════════════════
//  RULE 2 + 3, from the page's side of the worker: GET_GEO.
mark();
const failedDialAt = BC.t;
sock().die();                                    // that dial found nothing either
await drain();
console.log('\n── a dial that finds nothing ──');
ok(geo() && geo().appOff === true && geo().stamp === failedDialAt,
   'is itself fresh evidence that the app is off, so the record is re-stamped -- a browser ' +
   'that keeps trying never accumulates staleness', JSON.stringify(geo()));

mark();
BC.t = T0 + 140000;
const stampBefore = geo().stamp;
const stale = askGeo(false);

console.log('\n── a page asks while the app is still down ──');
ok(stale && stale.geoSpoof && stale.geoSpoof.appOff === true &&
   stale.geoSpoof.stamp === stampBefore && stampBefore < BC.t,
   'the answer keeps the OLD stamp: with the link down the worker has no way to re-check, and ' +
   'that age is exactly what the page acts on',
   JSON.stringify(stale && stale.geoSpoof));
ok(!seen(/^ws\.new/).length,
   'and an ordinary question does not force a dial -- every page load asks one', shown());

mark();
const forced = askGeo(true);
await drain();
ok(seen(/^ws\.new:ws:\/\/127\.0\.0\.1:8080$/).length === 1,
   'but a page saying its decision is too old to act on dials NOW, rather than at the end of ' +
   'a backoff it cannot see. This is the only wake-up left once the worker has been evicted',
   shown());
ok(forced && forced.geoSpoof && forced.geoSpoof.appOff === true,
   'and it is still answered honestly in the meantime, not left hanging',
   JSON.stringify(forced && forced.geoSpoof));

mark();
sock().open();
await drain();
BC.t = T0 + 150000;
await sync(NL, 'nl');
BC.t = T0 + 210000;
const onLive = askGeo(false);
await drain();
console.log('\n── the same question on a healthy link ──');
ok(onLive && onLive.geoSpoof && onLive.geoSpoof.stamp === T0 + 210000,
   'the record is re-stamped, because a live link means it is still the app\'s word as of ' +
   'now -- otherwise a page on a healthy connection re-asks every fifteen seconds for ever',
   JSON.stringify(onLive && onLive.geoSpoof));
ok(!seen(/^ws\.new/).length, 'and nothing is dialled: there is already a link', shown());

// ════════════════════════════════════════════════════════════════════
mark();
BC.t = T0 + 220000;
sock().die();
await drain();
mark();
ok(fireAlarm('fp-proxy-guard'), 'the proxy guard is registered too');
await drain();
console.log('\n── the proxy watchdog, with the app gone ──');
ok(seen(/^proxy\.off:direct$/).length === 1,
   'it still releases the proxy, which is what stops "Brave has no internet"', shown());
ok(seen(/^ws\.new:ws:\/\/127\.0\.0\.1:8080$/).length === 1,
   'and it picks the link back up as well, so the two recoveries cannot come apart', shown());
// ════════════════════════════════════════════════════════════════════
//  PART 2 -- the page. Extension/geo-spoof.js against a fake navigator, with
//  the real getCurrentPosition wired to the device position off the screenshot.
//  Every state the page can be in is asked the same question: how many times was
//  Chromium's own provider reached?
// ════════════════════════════════════════════════════════════════════
const CHANNEL = '__freeproxy_geo__';
const USED    = '__freeproxy_geo_used__';
const ASK     = '__freeproxy_geo_ask__';
const flush = () => new Promise(r => setImmediate(r));

function mkPage(seed) {
    const clock = { t: T0 };
    const out = { ask: 0, used: 0, real: 0, realWatch: 0, realClear: [], realQuery: 0 };
    const evs = {};
    const tl = [];

    const doc = {
        addEventListener(type, fn) { (evs[type] = evs[type] || []).push(fn); },
        dispatchEvent(ev) {
            if (ev.type === ASK) out.ask++;
            if (ev.type === USED) out.used++;
            (evs[ev.type] || []).forEach(fn => fn(ev));
            return true;
        },
    };
    function CustomEvent(type, init) { this.type = type; this.detail = init && init.detail; }

    const realPos = () => ({
        coords: { latitude: REAL.lat, longitude: REAL.lng, accuracy: 20,
                  altitude: null, altitudeAccuracy: null, heading: null, speed: null },
        timestamp: clock.t,
    });
    function Geolocation() {}
    Geolocation.prototype.getCurrentPosition = function (s) { out.real++; if (s) s(realPos()); };
    Geolocation.prototype.watchPosition = function (s) { out.realWatch++; if (s) s(realPos()); return 4242; };
    Geolocation.prototype.clearWatch = function (id) { out.realClear.push(id); };

    const permsProto = {
        query(d) { out.realQuery++; return Promise.resolve({ name: d && d.name, state: 'prompt' }); },
    };
    const nav = { geolocation: Object.create(Geolocation.prototype), permissions: Object.create(permsProto) };
    const win = {};
    if (seed) win.__FP_GEO_SEED = seed;

    const sb = {
        window: win, document: doc, navigator: nav, CustomEvent, URL, Date: mkDate(clock),
        console: { log: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
        setTimeout: (fn, ms) => { tl.push({ at: clock.t + (ms || 0), fn }); return tl.length; },
        clearTimeout: id => { if (tl[id - 1]) tl[id - 1].dead = true; },
        setInterval: (fn, ms) => { tl.push({ at: clock.t + (ms || 0), every: ms || 1, fn }); return tl.length; },
        clearInterval: id => { if (tl[id - 1]) tl[id - 1].dead = true; },
    };
    vm.createContext(sb);
    vm.runInContext(spoofSrc, sb, { filename: 'geo-spoof.js' });
    //  Moves the page's clock to exactly now+ms, running the timers that fall
    //  inside that window in order and flushing microtasks between them, so the
    //  promise chain inside geo-spoof.js advances the way it would in a browser.
    async function advance(ms) {
        const end = clock.t + ms;
        for (let n = 0; n < 4000; n++) {
            await flush(); await flush();
            let pick = -1;
            for (let i = 0; i < tl.length; i++) {
                const t = tl[i];
                if (!t || t.dead || t.at > end) continue;
                if (pick < 0 || t.at < tl[pick].at) pick = i;
            }
            if (pick < 0) break;
            const t = tl[pick];
            clock.t = t.at;
            if (t.every) t.at = clock.t + t.every; else tl[pick] = null;
            t.fn();
        }
        clock.t = end;
        await flush(); await flush();
    }

    const push = cfg => doc.dispatchEvent(new CustomEvent(CHANNEL, { detail: JSON.stringify(cfg) }));
    const get = () => {
        const r = { ok: [], err: [] };
        nav.geolocation.getCurrentPosition(p => r.ok.push(p), e => r.err.push(e));
        return r;
    };
    const watch = () => {
        const r = { ok: [], err: [], id: 0 };
        r.id = nav.geolocation.watchPosition(p => r.ok.push(p), e => r.err.push(e));
        return r;
    };
    return { out, clock, advance, push, get, watch, nav, win,
             clear: id => nav.geolocation.clearWatch(id) };
}

const near = (p, c) => !!p && !!p.coords && Math.abs(p.coords.latitude - c.lat) < 0.01 &&
                       Math.abs(p.coords.longitude - c.lng) < 0.01;
const isReal = p => !!p && !!p.coords && Math.abs(p.coords.latitude - REAL.lat) < 0.01;
const activeRec = (c, t) => ({ active: true, lat: c.lat, lng: c.lng, accuracy: 18,
                               cc: c.cc, city: c.city, stamp: t });
const offRec = t => ({ active: false, appOff: true, stamp: t });
const dhaka = r => r.ok.some(isReal);
console.log('\n── a page that has not been told anything yet ──');
{
    const p = mkPage();
    const r = p.get();
    await p.advance(1000);
    ok(!r.ok.length && !r.err.length && p.out.real === 0,
       'the call is HELD. "Not known yet" is not "not connected", and a page that asked ' +
       'during a worker start must not be answered from the device');
    await p.advance(3500);
    ok(p.out.ask === 1,
       'once the ceiling is reached it asks the worker again first -- that ask is what starts ' +
       'an evicted worker');
    await p.advance(2000);
    ok(r.err.length === 1 && r.err[0].code === 2 && r.err[0].code === r.err[0].POSITION_UNAVAILABLE,
       'and with no answer the page is told POSITION_UNAVAILABLE, not PERMISSION_DENIED -- ' +
       'a denial is a lie about the user and it is what greyed out the site setting',
       JSON.stringify(r.err[0]));
    ok(p.out.real === 0 && !dhaka(r),
       'the real provider is never reached: a stall must not hand out the device position');
}

console.log('\n── RULE 1: the shapes that must authorise nothing ──');
{
    const p = mkPage();
    p.push({ active: false });
    const r = p.get();
    await p.advance(8000);
    ok(p.out.real === 0 && !dhaka(r),
       'a bare {active:false} -- exactly what every clean disconnect used to write -- ' +
       'authorises nothing. "Off" has to be said, not left out');
    ok(r.err.length === 1 && r.err[0].code === 2, 'the page is told the position is unavailable instead');
}
{
    //  The same shape as writeGeo() would deliver it. Every record the worker
    //  writes is stamped, so a bare {active:false} would arrive FRESH -- and a
    //  fresh record is vouched for, which is what lets a decision reach the real
    //  provider. Freshness is therefore no defence here; the shape guard is.
    const p = mkPage();
    p.push({ active: false, stamp: p.clock.t });
    const r = p.get();
    await p.advance(8000);
    ok(p.out.real === 0 && !dhaka(r),
       'and a bare {active:false} that is STAMPED, so nothing about its age can be held ' +
       'against it, still authorises nothing -- the shape is the whole test',
       'real ' + p.out.real);
    ok(r.err.length === 1 && r.err[0].code === 2,
       'that page is told unavailable too, rather than being handed the device');
}
{
    const p = mkPage();
    p.push({ active: true, cc: 'NL', city: 'Amsterdam' });
    const r = p.get();
    await p.advance(8000);
    ok(p.out.real === 0 && !r.ok.length,
       'an "active" record with no coordinates is not an answer either, and is not treated as one');
}

console.log('\n── connected, with a fresh record ──');
{
    const p = mkPage();
    p.push(activeRec(NL, p.clock.t));
    const r = p.get();
    ok(r.ok.length === 1 && near(r.ok[0], NL),
       'the connected country is reported in the SAME turn -- indistinguishable from a fast ' +
       'device, so no site sees a suspicious delay', JSON.stringify(r.ok[0] && r.ok[0].coords));
    ok(p.out.real === 0, 'and Chromium is not consulted at all');
    ok(p.out.used === 1, 'the page reports that it consumed a spoof, so a later switch can find it');
    const r2 = p.get();
    ok(r2.ok.length === 1 && r2.ok[0].coords.latitude !== r.ok[0].coords.latitude,
       'a second call jitters: a bit-identical position every time is itself a fingerprint');
    ok(p.out.used === 1, 'and it is reported once per page, not once per call');
    ok(r.ok[0].coords.altitude === null && typeof r.ok[0].toJSON === 'function',
       'the object matches the real API surface, including toJSON for libraries that stringify it');
}
console.log('\n── the app has CONFIRMED it is off, recently ──');
{
    const p = mkPage();
    p.push(offRec(p.clock.t));
    const r = p.get();
    await p.advance(20);
    ok(p.out.real === 1 && isReal(r.ok[0]),
       'the page goes to the real provider. Blocking here is the build the user rejected: it ' +
       'broke Google Maps and took the site setting away from them');
    ok(!r.err.length, 'and nothing is denied');
}

console.log('\n── RULE 4: the leak. A stale "off", after the worker was evicted ──');
{
    const p = mkPage();
    p.push(offRec(p.clock.t));
    await p.advance(60000);
    const r = p.get();
    await p.advance(20);
    ok(p.out.ask === 1,
       'the page asks the worker again rather than acting on a decision this old -- which is ' +
       'also the only thing that can start a worker Chromium has evicted');
    ok(p.out.real === 0 && !r.ok.length, 'and it delegates nothing while it waits');
    await p.advance(2000);
    ok(p.out.real === 0 && !dhaka(r),
       'THE REPORTED LEAK: with the re-ask unanswered, a stale "off" still does NOT reach ' +
       "Chromium's provider. This is the check that fails on the code that shipped");
    ok(r.err.length === 1 && r.err[0].code === 2,
       'the page is told the position is unavailable, which is the truth: we do not know');
}

console.log('\n── the same stall, with the woken worker answering ──');
{
    const p = mkPage();
    p.push(offRec(p.clock.t));
    await p.advance(60000);
    const r = p.get();
    await p.advance(20);
    ok(p.out.ask === 1, 'the ask goes out');
    p.push(activeRec(NL, p.clock.t));
    await p.advance(20);
    ok(r.ok.length === 1 && near(r.ok[0], NL),
       'and the page is handed the country it is actually exiting in -- the reported case, ' +
       'end to end, with the fix in place', JSON.stringify(r.ok[0] && r.ok[0].coords));
    ok(p.out.real === 0 && !r.err.length, 'with no detour through the real provider and no error');
}
{
    const p = mkPage();
    p.push(offRec(p.clock.t));
    await p.advance(60000);
    const r = p.get();
    await p.advance(20);
    p.push(offRec(p.clock.t));
    await p.advance(20);
    ok(p.out.real === 1 && isReal(r.ok[0]),
       'and when the answer confirms the app really is off, the real provider is used at once. ' +
       'The freshness rule must not become a permanent block');
}
console.log('\n── the two states that are allowed to differ from all that ──');
{
    const p = mkPage();
    p.push({ active: false, unreachable: true });
    const r = p.get();
    await p.advance(1000);
    ok(p.out.real === 0, 'an unreachable worker is not instant authorisation either');
    await p.advance(4000);
    ok(p.out.real === 1 && isReal(r.ok[0]),
       'but past the ceiling it is the ONE case that delegates: a disabled or updating ' +
       'extension is not proxying the browser either, and a permanently dead ' +
       'navigator.geolocation would be a bug of our own making');
}
{
    const p = mkPage();
    p.push(activeRec(JP, p.clock.t));
    await p.advance(60000);
    const r = p.get();
    await p.advance(20);
    ok(!r.ok.length && p.out.ask === 1, 'a stale ACTIVE record is re-asked as well');
    await p.advance(2000);
    ok(r.ok.length === 1 && near(r.ok[0], JP) && p.out.real === 0,
       'and then acted on regardless: over-spoofing is harmless, so nothing is gated on it');
}

console.log('\n── watchPosition ──');
{
    const p = mkPage();
    p.push(activeRec(NL, p.clock.t));
    const w = p.watch();
    ok(typeof w.id === 'number' && w.id > 100000,
       'an id comes back synchronously, from our own sequence -- the API cannot wait for a ' +
       'config that has not arrived', String(w.id));
    await p.advance(20);
    ok(w.ok.length === 1 && near(w.ok[0], NL), 'the first reading is the connected country');
    await p.advance(8100);
    ok(w.ok.length === 2, 'and it keeps reporting, so code that waits for a second reading is served');
    p.clear(w.id);
    await p.advance(30000);
    ok(w.ok.length === 2, 'clearWatch stops it');
    ok(p.out.realWatch === 0 && !p.out.realClear.length, 'and the real watch is never involved');
}
{
    const p = mkPage();
    p.push(offRec(p.clock.t));
    await p.advance(60000);
    const w = p.watch();
    await p.advance(3000);
    ok(p.out.realWatch === 0,
       'a watch started on a stale "off" does not switch to the real provider behind the ' +
       "page's back -- a watch reports for as long as the page lives");
    ok(w.err.length === 1 && w.err[0].code === 2, 'it reports the position as unavailable instead');
}
console.log('\n── RULE 5: an older record never replaces a newer one ──');
//  geo-bridge.js pushes its storage fallback and its forced re-ask with no
//  ordering guard, so a reply in flight can land BEHIND a live change: the
//  worker answers "JP" for a question asked before the switch, the switch to NL
//  arrives first, and the late answer used to put JP back on a page that had
//  already been told NL.
{
    const p = mkPage();
    p.push(activeRec(JP, p.clock.t));
    await p.advance(50);
    p.push(activeRec(NL, p.clock.t));
    await p.advance(50);
    //  Stamped BEFORE the NL record, delivered after it.
    p.push(activeRec(JP, p.clock.t - 5000));
    await p.advance(50);
    const r = p.get();
    await p.advance(50);
    ok(r.ok.length === 1 && near(r.ok[0], NL),
       'a record stamped earlier than the one in hand is dropped, so the previous country ' +
       'cannot come back on a page that was already told the new one',
       JSON.stringify(r.ok[0] && r.ok[0].coords));

    const before = p.out.ask;
    //  Stale, so this call genuinely WAITS: it queues on the re-ask instead of
    //  being answered in the same turn.
    await p.advance(20000);
    const held = p.get();
    await p.advance(0);
    ok(!held.ok.length && p.out.ask > before, 'a stale record makes the next call wait on a re-ask',
       'ok ' + held.ok.length + ', asks ' + (p.out.ask - before));
    p.push(activeRec(JP, p.clock.t - 40000));
    await p.advance(100);
    ok(held.ok.length === 1 && near(held.ok[0], NL),
       'and the dropped answer still releases that call rather than leaving it to time out -- ' +
       'what we hold is a fresher answer, not a missing one, and 1.5 s of silence is what a ' +
       'page reads as a slow device',
       'ok ' + held.ok.length + ' ' + JSON.stringify(held.ok[0] && held.ok[0].coords));
}
{
    const p = mkPage();
    p.push(activeRec(JP, p.clock.t));
    await p.advance(50);
    p.push(activeRec(NL, p.clock.t));
    await p.advance(50);
    let r = p.get();
    await p.advance(50);
    ok(r.ok.length === 1 && near(r.ok[0], NL),
       'a LATER record still replaces an earlier one, which is the country switch itself');

    //  Same millisecond: the worker re-stamps a live record without rewriting it,
    //  so two pushes can carry one stamp and the second must not be discarded.
    const t = p.clock.t;
    p.push(activeRec(NL, t));
    await p.advance(0);
    p.push(activeRec(JP, t));
    await p.advance(0);
    r = p.get();
    await p.advance(50);
    ok(r.ok.length === 1 && near(r.ok[0], JP),
       'an equal stamp is accepted: two records can share a millisecond, and dropping the ' +
       'second would strand the page on the first',
       JSON.stringify(r.ok[0] && r.ok[0].coords));
}
{
    const p = mkPage();
    p.push(activeRec(NL, p.clock.t));
    const w = p.watch();
    await p.advance(20);
    const asks = p.out.ask;
    //  Past FRESH_MS with no new record: the worker may have been evicted, and
    //  this watch is the only thing left that can wake it.
    await p.advance(20000);
    ok(p.out.ask > asks,
       'a watch whose record has gone stale asks the worker again -- an evicted worker is ' +
       'started by the ask, and without it a country switch never reaches a long-lived watch',
       'asks ' + asks + ' -> ' + p.out.ask);
    const got = w.ok.length;
    await p.advance(8100);
    ok(w.ok.length > got && near(w.ok[w.ok.length - 1], NL) && p.out.realWatch === 0,
       'and it keeps reporting the country it has while it asks: a stale ACTIVE record only ' +
       'over-spoofs, and stalling the page would be the worse answer',
       'readings ' + got + ' -> ' + w.ok.length);
}

console.log('\n── navigator.permissions, which many sites check before they ask ──');
{
    const p = mkPage();
    p.push(activeRec(NL, p.clock.t));
    const st = await p.nav.permissions.query({ name: 'geolocation' });
    ok(st && st.state === 'granted' && p.out.realQuery === 0,
       'while a spoof is armed the effective state IS granted, so say so -- plenty of sites ' +
       'never call getCurrentPosition otherwise', JSON.stringify(st && st.state));
    const other = await p.nav.permissions.query({ name: 'camera' });
    ok(other && other.state === 'prompt' && p.out.realQuery === 1,
       'and every other permission passes straight through untouched');
}
{
    const p = mkPage();
    p.push(offRec(p.clock.t));
    const st = await p.nav.permissions.query({ name: 'geolocation' });
    ok(st && st.state === 'prompt' && p.out.realQuery === 1,
       'with nothing armed, the browser\'s own answer comes back unchanged');
}

console.log('\n── what the page can see of the patch ──');
{
    const p = mkPage(activeRec(NL, T0));
    const r = p.get();
    ok(r.ok.length === 1 && near(r.ok[0], NL),
       'a seeded page answers its very first call in the same turn (the probe harness path)');
    ok(!('__FP_GEO_SEED' in p.win),
       'and the seed global is removed: a leftover global named after the app is a fingerprint');
    const proto = Object.getPrototypeOf(p.nav.geolocation);
    ok(!Object.prototype.hasOwnProperty.call(p.nav.geolocation, 'getCurrentPosition'),
       'the PROTOTYPE is patched, not the instance -- a page reaching for ' +
       'Geolocation.prototype.getCurrentPosition would walk past an instance override');
    ok(String(proto.getCurrentPosition).includes('[native code]'),
       'and the patched functions read as native to console inspection');
    ok(proto.getCurrentPosition.name === 'getCurrentPosition' &&
       proto.watchPosition.name === 'watchPosition' && proto.clearWatch.name === 'clearWatch',
       'each keeping its own name: one shared loop variable would report the last one for all three',
       [proto.getCurrentPosition.name, proto.watchPosition.name, proto.clearWatch.name].join(','));
}

// ════════════════════════════════════════════════════════════════════
console.log(`\n${pass}/${pass + fail} checks passed`);
if (fail) {
    console.log('\n── the worker call log, for the failures above ──');
    LOG.forEach((s, i) => console.log(String(i).padStart(4) + ': ' + s));
}
process.exit(fail ? 1 : 0);

})().catch(e => { console.log('ABORT: ' + e.stack); process.exit(3); });
