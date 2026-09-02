'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/test-proxy-strand.js  --  a browser that STARTS with the extension
//  proxy still set. The reported failure, in the only state that produces it.
//
//  Measured 2026-09-02, app shut down and nothing on 9050: Brave's profile still
//  held socks5://127.0.0.1:9050 on this extension's own record, while Chrome's
//  and Edge's held an empty bucket. Same extension, same version, same
//  permissions -- the difference was the ORDER things closed in. Brave was closed
//  first, while the app was still connected, so socket.onclose never ran, and no
//  chrome.alarms tick can run in a browser that is not running. The pref is
//  persistent, so the next start read it straight back and every page failed with
//  ERR_PROXY_CONNECTION_FAILED. That is "brave e net pacchina".
//
//  Why this file exists at all, next to test-geo-switch.js: that suite evaluates
//  background.js ONCE, into a single vm context, with an empty profile. The state
//  under test here is decided BEFORE module evaluation -- the mark is either on
//  disk when the worker starts or it is not -- so it cannot be reached by any
//  amount of driving the already-booted worker. Every case below therefore boots
//  its own worker against its own profile.
//
//  The four things that have to be true, and each is a way this has already been
//  got wrong once:
//    1. the release happens at module scope, unconditionally
//    2. the reload is issued AFTER the release lands, not in the same tick --
//       chrome.tabs.reload and chrome.proxy.settings travel separate channels, so
//       a reload racing the clear is dispatched through the dead proxy and fails
//       identically
//    3. it survives the mark read answering LATE. A refused dial to a dead
//       loopback port is a SYN and an RST; the mark read may have to open the
//       profile's LevelDB from a cold disk. Reading a boolean that has not been
//       filled in yet is how the country-switch purge was lost once already
//    4. it does NOT fire when the pages are fine. A reload throws away scroll
//       position and half-written forms; with the app connected, 9050 was
//       answering for those eleven seconds and every page loaded
// ════════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = process.env.FP_BG || path.join(__dirname, '..', 'Extension', 'background.js');
const src = fs.readFileSync(SRC, 'utf8');

let pass = 0, fail = 0;
const ok = (cond, what, extra) => {
    if (cond) { pass++; console.log('  ok   ' + what); }
    else {
        fail++; console.log('  FAIL ' + what);
        if (extra) console.log('         ' + extra);
    }
};

// ── one worker, booted against a profile that already exists ─────────
//  `marked` is the whole point: it is written into the store BEFORE module
//  evaluation, which is what "this browser was closed with the proxy set" means
//  by the time a new worker starts.
//
//  `readHops` is how many callback hops chrome.storage.local.get takes to answer.
//  1 is the fast case. A large number is a cold LevelDB open, and it must not
//  change any outcome -- only the order the log lines appear in.
function boot({ marked = false, readHops = 1, tabs = [], wins = [{ id: 1 }] } = {}) {
    const LOG = [], WARN = [], MSGS = [];
    const q = [], timers = [];
    const soon = fn => q.push(fn);
    const hops = (n, fn) => {
        let k = Math.max(1, n);
        const step = () => { if (--k > 0) q.push(step); else fn(); };
        q.push(step);
    };
    const lg = s => { LOG.push(s); return s; };

    const STORE = marked ? { fpProxyLeftOn: true } : {};
    let TABS = tabs.slice();
    let WINS = wins.slice();
    const ALARMS = new Map();
    const winHooks = {};
    let onAlarm = null;

    const storage = {
        local: {
            get(keys, cb) {
                const want = keys === null || keys === undefined
                    ? Object.keys(STORE) : (Array.isArray(keys) ? keys : [keys]);
                lg('storage.get:' + want.join(','));
                //  Snapshotted at ISSUE time, then answered late. That is what
                //  "operations on one area are queued in the order they were
                //  issued" means, and the whole mark mechanism rests on it: the
                //  clear at module evaluation removes the mark a few lines after
                //  this read is issued, and the read must still see it. A stub
                //  that read the store at CALLBACK time would model a browser
                //  that reorders its own storage queue, which Chromium does not,
                //  and would make the fix look broken for the wrong reason.
                const out = {};
                for (const k of want) if (k in STORE) out[k] = STORE[k];
                hops(readHops, () => {
                    lg('storage.got:' + want.join(',') + '=' + JSON.stringify(out));
                    cb(out);
                });
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
                soon(() => {
                    for (const k of want) delete STORE[k];
                    lg('storage.remove:' + want.join(','));
                    if (cb) cb();
                });
            },
        },
        onChanged: { addListener: () => {} },
    };

    //  The proxy stub is where check 2 lives. It records the request and the
    //  moment the browser says it is APPLIED as two separate log lines, several
    //  hops apart, so "the reload was issued while the dead proxy was still in
    //  force" is a visible ordering in the log rather than something argued about.
    //
    //  "off" is a WRITE of mode:'direct', logged as its own thing, because a clear()
    //  only relinquishes the pref -- Chromium then applies the next value in the
    //  store, and on the real profile that is a fossil id's fixed_servers
    //  socks5://127.0.0.1:9050 that no worker can release
    //  (.build/probe-pref-precedence.js). clear() is left in the stub as a trap.
    const proxy = {
        settings: {
            set(o, cb) {
                const s = o && o.value && o.value.rules && o.value.rules.singleProxy;
                const off = o && o.value && o.value.mode === 'direct';
                lg(off ? 'proxy.off:direct'
                       : 'proxy.set:' + (s ? `${s.scheme}://${s.host}:${s.port}` : '?'));
                hops(4, () => { lg(off ? 'proxy.off.applied' : 'proxy.set.applied'); if (cb) cb(); });
            },
            clear(o, cb) {
                lg('proxy.clear');
                hops(4, () => { lg('proxy.clear.applied'); if (cb) cb(); });
            },
        },
    };

    const chromeStub = {
        runtime: {
            lastError: undefined,
            getURL: p => 'chrome-extension://fp/' + String(p),
            onInstalled: { addListener: () => {} },
            onStartup: { addListener: () => {} },
            onMessage: { addListener: () => {} },
            sendMessage(msg, cb) {
                MSGS.push(msg);
                if (cb) { soon(() => cb({})); return undefined; }
                return Promise.resolve();
            },
        },
        storage,
        proxy,
        cookies: {
            getAll({ name }, cb) { lg('cookies.getAll:' + name); soon(() => cb([])); },
            remove({ name }, cb) { lg('cookies.remove:' + name); soon(() => cb(null)); },
        },
        browsingData: { remove(f, t, cb) { lg('browsingData.remove'); soon(() => cb && cb()); } },
        tabs: {
            query(qy, cb) { lg('tabs.query'); soon(() => cb(TABS.map(t => ({ ...t })))); },
            reload(id, opts, cb) { lg('tabs.reload:' + id); if (cb) soon(() => cb()); },
            update(id, props) { lg('tabs.update:' + id); },
            create(props) { lg('tabs.create'); },
        },
        windows: {
            getAll(qy, cb) { lg('windows.getAll'); soon(() => cb(WINS.map(w => ({ ...w })))); },
            onRemoved: { addListener: fn => { winHooks.removed = fn; } },
            onCreated: { addListener: fn => { winHooks.created = fn; } },
        },
        action: { setBadgeText: () => {}, setBadgeBackgroundColor: () => {} },
        notifications: { create: (id, o, cb) => { if (cb) soon(() => cb()); } },
        alarms: {
            create(name, info) { ALARMS.set(name, info || {}); lg('alarms.create:' + name); },
            clear(name, cb) { ALARMS.delete(name); lg('alarms.clear:' + name); if (cb) soon(() => cb(true)); },
            onAlarm: { addListener: fn => { onAlarm = fn; } },
        },
    };

    const WS = [];
    class FakeSocket {
        constructor(url) { this.url = url; this.readyState = 0; this.sent = []; WS.push(this); lg('ws.new'); }
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

    const sandbox = {
        chrome: chromeStub,
        WebSocket: FakeSocket,
        URL,
        console: {
            log: () => {}, debug: () => {}, info: () => {},
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

    const api = {
        LOG, WARN, STORE, ALARMS, WS,
        get: () => LOG.slice(),
        at: re => LOG.findIndex(s => re.test(s)),
        lastAt: re => { for (let i = LOG.length - 1; i >= 0; i--) if (re.test(LOG[i])) return i; return -1; },
        seen: re => LOG.filter(s => re.test(s)),
        shown: () => LOG.join('\n         '),
        sock: () => WS[WS.length - 1],
        setTabs: t => { TABS = t.slice(); },
        //  Nothing in the queue runs on its own: every check says explicitly
        //  where "the browser has finished reacting" is. Timers are never drained
        //  -- background.js reconnects on one, and a drain that fired those would
        //  reconnect for ever.
        async drain(limit) {
            let n = 0;
            for (;;) {
                await new Promise(r => setImmediate(r));       // flush microtasks
                if (!q.length) return n;
                if (++n > (limit || 5000)) throw new Error('drain: the queue never emptied');
                q.shift()();
            }
        },
        fireTimers(kind) {
            const due = [];
            timers.forEach((t, i) => { if (t && !t.dead && (!kind || t.kind === kind)) due.push(i); });
            for (const i of due) { const t = timers[i]; timers[i] = null; t.fn(); }
            return due.length;
        },
        fireAlarm: name => { if (!onAlarm) return false; onAlarm({ name }); return true; },
        closeAllWindows: () => { WINS = []; if (winHooks.removed) winHooks.removed(1); },
    };
    vm.runInContext(src, sandbox, { filename: SRC });
    return api;
}

//  One tab list for every case, so "which tabs" is never a per-case choice.
//  Two real pages and four that a reload would be wrong for: the new-tab page and
//  the extension's own popup would be thrown back to their start state, and a tab
//  with no URL yet has nothing to reload.
const PAGES = [
    { id: 1, url: 'https://mail.example.com/inbox' },
    { id: 2, url: 'http://news.example.com/' },
    { id: 3, url: 'chrome://newtab/' },
    { id: 4, url: 'chrome-extension://fp/popup.html' },
    { id: 5, url: 'about:blank' },
    { id: 6, url: '' },
];
const RELOADED = w => w.seen(/^tabs\.reload:/).map(s => s.split(':')[1]).join(',');

(async () => {

// ════════════════════════════════════════════════════════════════════
console.log('── 1. the profile that was closed with the proxy set, app not running ──');
const a = boot({ marked: true, tabs: PAGES });
ok(a.at(/^proxy\.off:direct$/) >= 0,
   'module evaluation releases the proxy, before any listener in the worker can run -- ' +
   'this is the 11.1 s the browser took to get here, and it is unconditional', a.shown());
//  Measured both ways in .build/probe-pref-precedence.js: a clear() left the page
//  going through a stub on 127.0.0.1:9050, because clearing only relinquishes the
//  pref and Chromium then applies the next extension-controlled value -- on the real
//  Brave profile a fossil id's fixed_servers, which has no worker to release it and
//  sits in MAC-protected Secure Preferences. Writing mode:'direct' instead masked it,
//  and was still in force 183 ms into a cold start with nothing writing anything.
ok(!a.seen(/^proxy\.clear$/).length,
   'and it releases by WRITING mode:direct, never by clearing: a clear would hand the pref ' +
   'back to a record nothing in this extension can reach', a.shown());
ok(a.at(/^storage\.get:fpProxyLeftOn$/) >= 0 &&
   a.at(/^storage\.get:fpProxyLeftOn$/) < a.at(/^proxy\.off:direct$/),
   'and the mark was read BEFORE that release was even requested: afterwards, "was set at ' +
   'startup" and "was never set" are indistinguishable', a.shown());

await a.drain();
ok(a.seen(/^storage\.got:fpProxyLeftOn=\{"fpProxyLeftOn":true\}$/).length === 1,
   'the read still answers true even though the release removed the mark a few lines later: ' +
   'one area, one queue, issue order', a.shown());
ok(!a.seen(/^tabs\.reload:/).length,
   'nothing is reloaded yet, though -- the app has not been heard from, so it is not yet ' +
   'known whether 9050 was dead or the pages loaded fine', a.shown());

a.sock().die();                                  // the dial is refused: no app
await a.drain();
ok(a.seen(/^tabs\.reload:/).length === 2,
   'the app is not there, so the pages ARE error pages, and they are reloaded', a.shown());
ok(RELOADED(a) === '1,2',
   'http and https only: the new-tab page, the extension popup, about:blank and the tab ' +
   'with no URL are left exactly as they were', RELOADED(a) || '(none)');
ok(a.WARN.some(s => /started with the extension proxy still set/.test(s)),
   'and it says so in the console, naming the previous session', a.WARN.join(' | '));

console.log('\n── 2. the reload waits for the release to LAND, not for it to be asked for ──');
//  chrome.tabs.reload and chrome.proxy.settings are separate channels. A reload
//  issued in the same tick as the clear can be dispatched while the dead proxy is
//  still in force, fail with the same ERR_PROXY_CONNECTION_FAILED, and leave the
//  user looking at the very error page it was supposed to remove. The stub logs
//  the request and the applied moment separately so this is an ordering, not an
//  argument.
ok(a.lastAt(/^proxy\.off\.applied$/) < a.at(/^tabs\.reload:1$/),
   'every reload is after the browser confirmed the clear, so none of them travels ' +
   'through the proxy being removed', a.shown());
ok(a.at(/^proxy\.off:direct$/) < a.lastAt(/^proxy\.off\.applied$/),
   'and the stub really does separate the two -- an instant clear would make the check ' +
   'above pass for free', a.shown());

console.log('\n── 3. once, however long the app stays away ──');
//  onclose is not a one-off. The reconnect chain re-dials every couple of
//  seconds, each refused dial delivering another onclose, for as long as the app
//  is shut. A repair armed on that event has to be spent the first time.
let rounds = 0;
for (let i = 0; i < 4; i++) {
    a.fireTimers('t');
    await a.drain();
    if (a.sock() && a.sock().readyState !== 3) { a.sock().die(); rounds++; }
    await a.drain();
}
ok(rounds >= 3, `the reconnect chain really did re-dial and die ${rounds} more times`);
ok(a.seen(/^tabs\.reload:/).length === 2,
   'and still exactly two reloads in total: the repair was spent on the first onclose, ' +
   'so this never becomes a reload loop', RELOADED(a));

console.log('\n── 4. the mark read answering LATE changes nothing ──');
//  A refused dial to a dead loopback port is a SYN and an RST -- microseconds.
//  The mark read may have to open the profile's LevelDB from a cold disk. So
//  onclose runs FIRST here, and a version that read a boolean instead of queueing
//  behind the read would find it still false and repair nothing. That is exactly
//  how the country-switch purge was lost once already.
const b = boot({ marked: true, readHops: 40, tabs: PAGES });
b.sock().die();                                  // before anything has been drained
ok(b.at(/^storage\.got:/) < 0,
   'the app was already known to be gone before the mark read had answered at all',
   b.shown());
await b.drain();
ok(b.lastAt(/^storage\.got:fpProxyLeftOn/) < b.at(/^tabs\.reload:1$/),
   'the read answered after the close, and the reload waited for it rather than racing it',
   b.shown());
ok(RELOADED(b) === '1,2',
   'so the repair still happens, and still only to the pages that could have failed',
   RELOADED(b) || '(none)');

console.log('\n── 5. the app IS running, with no country selected ──');
//  The reported case, exactly: "brave jeno kono country te connect na thakleo net
//  pai". The app answers, so onclose never fires -- but 9050 is dead all the
//  same, so every page opened in the eleven seconds before this worker existed is
//  an error page.
const c = boot({ marked: true, readHops: 6, tabs: PAGES });
await c.drain();
c.sock().open();
await c.drain();
ok(!c.seen(/^tabs\.reload:/).length,
   'the socket opening on its own repairs nothing: the app answering says nothing about ' +
   'whether it is connected', c.shown());
c.sock().deliver({ type: 'STATE_SYNC', state: { connected: false } });
await c.drain();
ok(RELOADED(c) === '1,2',
   'the first authoritative state says NOT connected, and that is what makes them error ' +
   'pages -- so they are reloaded', RELOADED(c) || '(none)');
ok(c.lastAt(/^proxy\.off\.applied$/) < c.at(/^tabs\.reload:1$/),
   'after the release lands here too', c.shown());

console.log('\n── 6. the app is running AND connected: nothing is reloaded ──');
//  Same stranded profile, but 9050 was answering for those eleven seconds, so the
//  pages loaded. A reload here would throw away scroll position and half-written
//  forms to fix nothing.
const d = boot({ marked: true, readHops: 6, tabs: PAGES });
await d.drain();
d.sock().open();
d.sock().deliver({ type: 'STATE_SYNC', state: { connected: true, server: 'lu' } });
await d.drain();
ok(d.seen(/^proxy\.set:socks5:\/\/127\.0\.0\.1:9050$/).length === 1,
   'the browser goes back on Tor, as it should', d.shown());
ok(!d.seen(/^tabs\.reload:/).length, 'and nothing is reloaded', d.shown());
//  And the decision is SPENT, not left armed. This is the trap: leaving it armed
//  would make the user's next ordinary disconnect -- minutes later, everything
//  loaded -- reload every tab they had open.
d.sock().deliver({ type: 'STATE_SYNC', state: { connected: false } });
await d.drain();
ok(!d.seen(/^tabs\.reload:/).length,
   'and an ordinary disconnect later does NOT reload them either: the mark was settled ' +
   'by the first state, not left waiting for a disconnect to fire on', d.shown());
d.sock().die();
await d.drain();
ok(!d.seen(/^tabs\.reload:/).length, 'nor does quitting the app after that', d.shown());

console.log('\n── 7. a profile that started clean is never touched ──');
const e = boot({ marked: false, tabs: PAGES });
await e.drain();
ok(e.seen(/^storage\.got:fpProxyLeftOn=\{\}$/).length === 1,
   'no mark on disk: this browser was closed properly, or never had the proxy set',
   e.shown());
e.sock().die();
await e.drain();
ok(!e.seen(/^tabs\.reload:/).length,
   'the app being absent reloads nothing at all -- there is nothing to repair', e.shown());
ok(!e.WARN.some(s => /started with the extension proxy still set/.test(s)),
   'and it does not claim in the console that there was', e.WARN.join(' | ') || '(silent)');
const f = boot({ marked: false, tabs: PAGES });
await f.drain();
f.sock().open();
f.sock().deliver({ type: 'STATE_SYNC', state: { connected: false } });
await f.drain();
ok(!f.seen(/^tabs\.reload:/).length,
   'and neither does a disconnected app: the mark is the only thing that can ask for a ' +
   'reload, and it is not there', f.shown());

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
})().catch(e => { console.log("ABORT: " + e.stack); process.exit(3); });
