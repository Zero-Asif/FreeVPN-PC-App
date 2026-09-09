'use strict';
//  A stray copy of the extension has to stand down when the app says so.
//
//  MEASURED, Chrome's own Secure Preferences: three FreeProxy records in one
//  profile -- the packed one the app installed (location 6, creation_flags 1) and
//  two location 4 UNPACKED rows whose `path` values are the app's own folders,
//  C:\ProgramData\freeproxy-vpn\browser-setup\extension and C:\Program Files\
//  FreeProxy VPN\resources\Extension, with stale permission grants (one holds
//  browsingData and cookies but not history). Chrome loads a persisted unpacked
//  row at every start, so all three connect to the app and all three act on every
//  STATE_SYNC. That is the reported "chrome er duita extension ekhono show
//  korche" and it is the only Chrome-specific actor left for "chrome er
//  cache/cookie/history wipe kore felche": Edge runs the same code with a 672 KB
//  cookie jar untouched, so the shared clearing code cannot be the cause.
//
//  This suite drives background.js through the handshake in a vm and asserts what
//  a standby does and does not do.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

//  FP_BG points the suite at a mutated copy, so probe-standby-red.js can prove
//  every check here fails when the fix is taken back out. Unset in the gate.
const SRC = process.env.FP_BG || path.join(__dirname, '..', 'Extension', 'background.js');
const STORE_SRC = path.join(__dirname, '..', 'Extension-Store', 'package', 'background.js');

let pass = 0, fail = 0;
function ok(cond, what, detail) {
    if (cond) { pass++; console.log('  PASS  ' + what); return true; }
    fail++;
    console.log('  FAIL  ' + what + (detail ? '\n        ' + detail : ''));
    return false;
}

//  One worker, one fake browser. `installType` is what getSelf() answers, which
//  is the whole difference between a copy that may remove itself and one that
//  never may.
function boot(installType) {
    const L = [];
    const STORE = {};
    const timers = [];
    const WS = [];
    const lg = s => L.push(s);

    class FakeSocket {
        constructor(url) { this.url = url; this.readyState = 0; this.sent = []; WS.push(this); lg('ws.new'); }
        send(s) { this.sent.push(s); lg('ws.send'); }
        close() { this.die(); }
        open() { this.readyState = 1; if (this.onopen) this.onopen(); }
        deliver(o) { if (this.onmessage) this.onmessage({ data: JSON.stringify(o) }); }
        die() {
            if (this.readyState === 3) return;
            this.readyState = 3;
            if (this.onclose) this.onclose();
        }
    }
    FakeSocket.CONNECTING = 0; FakeSocket.OPEN = 1; FakeSocket.CLOSING = 2; FakeSocket.CLOSED = 3;

    const listeners = {};
    const ev = name => ({ addListener: fn => { (listeners[name] = listeners[name] || []).push(fn); } });

    const soon = fn => timers.push({ fn, ms: 0, kind: 't' });
    const runtime = {
        id: 'imlmcdmjclmlkhgljdokgjepcppgjfob',
        lastError: undefined,
        getManifest: () => ({ version: '1.2.0' }),
        getURL: p => 'chrome-extension://x/' + p,
        onMessage: ev('msg'),
        onInstalled: ev('installed'),
        onStartup: ev('startup'),
        sendMessage: () => Promise.resolve(),
    };
    const storage = {
        local: {
            get: (keys, cb) => {
                const want = typeof keys === 'string' ? [keys]
                    : Array.isArray(keys) ? keys : Object.keys(keys || {});
                const out = {};
                for (const k of want) if (STORE[k] !== undefined) out[k] = STORE[k];
                soon(() => cb(out));
            },
            set: (obj, cb) => {
                Object.assign(STORE, obj);
                lg('store.set:' + Object.keys(obj).join(','));
                if (cb) soon(cb);
            },
            remove: (keys, cb) => {
                for (const k of [].concat(keys)) delete STORE[k];
                if (cb) soon(cb);
            },
        },
    };
    const proxy = {
        settings: {
            set: (o, cb) => { lg('proxy.set:' + (o.value && o.value.mode)); if (cb) soon(cb); },
            clear: (o, cb) => { lg('proxy.clear'); if (cb) soon(cb); },
            get: (o, cb) => soon(() => cb({ value: {}, levelOfControl: 'controlled_by_this_extension' })),
        },
    };
    const management = {
        getSelf: cb => soon(() => cb({ id: runtime.id, installType, enabled: true })),
        uninstallSelf: (o, cb) => {
            lg('uninstallSelf:' + JSON.stringify(o || {}));
            if (typeof o === 'function') { lg('uninstallSelf:{}'); o(); return; }
            if (cb) soon(cb);
        },
    };
    const alarms = {
        create: (n) => lg('alarm.create:' + n),
        clear: (n, cb) => { lg('alarm.clear:' + n); if (cb) soon(() => cb(true)); },
        onAlarm: ev('alarm'),
    };
    const tabs = {
        query: (q, cb) => soon(() => cb([])),
        update: (id, o) => lg('tabs.update:' + id + ':' + o.url),
        reload: id => lg('tabs.reload:' + id),
        onUpdated: ev('tabUpdated'),
    };
    const chromeStub = {
        runtime, storage, proxy, management, alarms, tabs,
        windows: { onCreated: ev('winCreated'), onRemoved: ev('winRemoved'), getAll: (o, cb) => soon(() => cb([{ id: 1 }])) },
        cookies: { getAll: (q, cb) => soon(() => cb([])), remove: (o, cb) => { if (cb) soon(cb); } },
        browsingData: { remove: (o, t, cb) => { lg('browsingData.remove'); if (cb) soon(cb); } },
        history: { search: (q, cb) => soon(() => cb([])), deleteUrl: (o, cb) => { if (cb) soon(cb); } },
        notifications: { create: (id, o, cb) => { if (cb) soon(cb); } },
        action: {
            setBadgeText: () => {}, setTitle: () => {}, setBadgeBackgroundColor: () => {},
        },
    };
    const sandbox = {
        chrome: chromeStub,
        WebSocket: FakeSocket,
        URL,
        console: { log: () => {}, debug: () => {}, info: s => L.push('info:' + s), warn: () => {}, error: () => {} },
        setTimeout: (fn, ms) => { timers.push({ fn, ms, kind: 't' }); return timers.length; },
        clearTimeout: id => { if (timers[id - 1]) timers[id - 1].dead = true; },
        setInterval: (fn, ms) => { timers.push({ fn, ms, kind: 'i' }); return timers.length; },
        clearInterval: id => { if (timers[id - 1]) timers[id - 1].dead = true; },
    };
    sandbox.self = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(SRC, 'utf8'), sandbox, { filename: 'background.js' });

    //  Every queued callback, repeatedly: a stage that queues another one has to
    //  get its turn too, and a service worker's callbacks are all of this shape.
    const drain = () => {
        for (let round = 0; round < 40; round++) {
            const due = timers.filter(t => !t.dead && !t.done && t.ms === 0);
            if (!due.length) return;
            for (const t of due) {
                if (t.kind === 't') t.done = true;
                try { t.fn(); } catch (e) { L.push('threw:' + e.message); }
            }
        }
    };
    return { L, STORE, WS, timers, drain, sandbox, listeners };
}

function hello(w) {
    const sent = w.WS[0].sent.map(s => { try { return JSON.parse(s); } catch (e) { return {}; } });
    return sent.filter(m => m.command === 'HELLO');
}

console.log('\n== a stray unpacked copy, told to stand down ==');
{
    const w = boot('development');
    w.drain();
    w.WS[0].open();
    w.drain();

    const h = hello(w);
    ok(h.length >= 1, 'the copy greets the app with its own identity -- the app is the only ' +
       'side that knows which id it installed, so the id has to come from here',
       JSON.stringify(w.WS[0].sent));
    ok(h.some(m => m.id === 'imlmcdmjclmlkhgljdokgjepcppgjfob'),
       'and the id it sends is chrome.runtime.id, the id the row in chrome://extensions has',
       JSON.stringify(h));
    ok(h.some(m => m.installType === 'development'),
       "with the installType only this copy knows: 'development' is what an unpacked row " +
       'reports, and it is what keeps every other kind of copy out of this',
       JSON.stringify(h.map(m => m.installType)));
    ok(h.some(m => m.version === '1.2.0'),
       'and its version, so the app can say which build is answering', JSON.stringify(h));

    const before = w.L.length;
    w.WS[0].deliver({ type: 'STAND_DOWN', reason: 'not the installed copy' });
    w.drain();
    const after = w.L.slice(before);

    ok(after.some(s => s === 'proxy.clear'),
       'the proxy pref is RELINQUISHED, not written to direct: masking it would take the ' +
       'pref away from the copy that stays, and that copy is the one carrying the traffic',
       after.join(' | '));
    ok(!after.some(s => s === 'proxy.set:direct'),
       'so setBrowserProxy(false) is deliberately NOT the path a standby takes', after.join(' | '));
    ok(after.some(s => s.startsWith('uninstallSelf:')),
       'and an unpacked copy removes itself -- that row IS the duplicate the user is looking ' +
       'at, and uninstallSelf() is the only thing that can take it away, because the app ' +
       'cannot: Secure Preferences is signed', after.join(' | '));
    ok(after.some(s => /showConfirmDialog":false/.test(s)),
       'without a dialog: nobody asked for this copy, so nobody should have to dismiss it',
       after.join(' | '));
    ok(w.L.some(s => s.startsWith('info:FreeProxy: the app installed a different copy')),
       'and it says so in the browser console, once', w.L.filter(s => s.startsWith('info:')).join(' | '));
}

console.log('\n== and it stops being a second actor ==');
{
    const w = boot('development');
    w.drain();
    w.WS[0].open();
    w.drain();
    w.WS[0].deliver({ type: 'STAND_DOWN', reason: 'not the installed copy' });
    w.drain();

    const before = w.L.length;
    w.WS[0].deliver({
        type: 'STATE_SYNC',
        state: {
            connected: true, serverCode: 'nl', killSwitch: false, bypassList: '', servers: {},
            geo: { lat: 52.3676, lng: 4.9041, accuracy: 18, city: 'Amsterdam', cc: 'NL' },
        },
    });
    w.drain();
    const after = w.L.slice(before);

    ok(!after.some(s => s.startsWith('proxy.set:')),
       'a STATE_SYNC that arrives after the stand-down points no proxy anywhere -- the ' +
       'frame may already have been in flight when the answer was sent', after.join(' | '));
    ok(!after.some(s => s === 'browsingData.remove'),
       'and it clears nothing: a stray with a stale grant still holding browsingData and ' +
       'cookies is exactly what emptied one browser and not the others', after.join(' | '));
    ok(w.STORE.geoSpoof === undefined || w.STORE.geoSpoof.active !== true,
       'and it arms no geolocation record, so it cannot answer a page either',
       JSON.stringify(w.STORE.geoSpoof || null));

    const opened = w.L.filter(s => s === 'ws.new').length;
    w.WS[0].die();
    w.drain();
    for (const t of w.timers) if (!t.dead && !t.done) { try { t.fn(); } catch (e) {} }
    ok(w.L.filter(s => s === 'ws.new').length === opened,
       'and it never dials the app again: a standby that reconnected would be handed the ' +
       'same STATE_SYNC on the next open and be a second actor once more',
       'sockets ' + w.L.filter(s => s === 'ws.new').length);
}

console.log('\n== a store copy is never removed ==');
{
    const w = boot('normal');
    w.drain();
    w.WS[0].open();
    w.drain();
    ok(hello(w).some(m => m.installType === 'normal'),
       "a store copy reports installType 'normal', which is what the app tests against",
       JSON.stringify(hello(w).map(m => m.installType)));

    const before = w.L.length;
    w.WS[0].deliver({ type: 'STAND_DOWN', reason: 'not the installed copy' });
    w.drain();
    const after = w.L.slice(before);
    ok(!after.some(s => s.startsWith('uninstallSelf')),
       'and even told to stand down it does NOT remove itself: a store copy is the user\'s ' +
       'own install, not ours to uninstall -- standing down is the whole remedy',
       after.join(' | '));
    ok(after.some(s => s === 'proxy.clear'),
       'it does still let the proxy pref go, which is the part that makes it harmless',
       after.join(' | '));
}

console.log('\n== nothing changes for the copy the app did install ==');
{
    const w = boot('normal');
    w.drain();
    w.WS[0].open();
    w.drain();
    const before = w.L.length;
    w.WS[0].deliver({
        type: 'STATE_SYNC',
        state: {
            connected: true, serverCode: 'nl', killSwitch: false, bypassList: '', servers: {},
            geo: { lat: 52.3676, lng: 4.9041, accuracy: 18, city: 'Amsterdam', cc: 'NL' },
        },
    });
    w.drain();
    const after = w.L.slice(before);
    ok(after.some(s => s === 'proxy.set:fixed_servers'),
       'a copy that was never told to stand down still points the browser at Tor',
       after.join(' | '));
    ok(w.STORE.geoSpoof && w.STORE.geoSpoof.active === true && w.STORE.geoSpoof.cc === 'NL',
       'and still arms the geolocation record -- the greeting costs the real copy nothing',
       JSON.stringify(w.STORE.geoSpoof || null));
}

console.log('\n== the store submission package carries the same worker ==');
{
    const a = fs.readFileSync(SRC, 'utf8');
    const b = fs.existsSync(STORE_SRC) ? fs.readFileSync(STORE_SRC, 'utf8') : '';
    ok(b === a, 'Extension-Store/package/background.js is byte-identical to Extension/' +
       'background.js -- the store package is a copy nothing else checks, and the geo fix ' +
       'was once live in one and absent from the other while every suite passed',
       'lengths ' + a.length + ' vs ' + b.length);
    for (const [name, src] of [['Extension', a], ['Extension-Store', b]]) {
        ok(/command: 'HELLO'/.test(src) && /'STAND_DOWN'/.test(src) &&
           /uninstallSelf/.test(src) && /proxy\.settings\.clear/.test(src),
           name + '/background.js carries the whole handshake: HELLO, STAND_DOWN, ' +
           'uninstallSelf and the clear that relinquishes the pref');
    }
}

// ── the app's side of the same handshake ─────────────────────────────
//  The decision is main.js's, so it is main.js's own text that runs here: the
//  HELLO branch is lifted out of the file with its comments stripped and called
//  with a fake socket. A re-implementation would only prove the test agrees with
//  itself.
const { stripComments } = require('./srcstrip.js');
const MAINFILE = process.env.FP_MAIN || path.join(__dirname, '..', 'main.js');
const main = stripComments(fs.readFileSync(MAINFILE, 'utf8'));

function liftBlock(source, head) {
    const at = source.indexOf(head);
    if (at === -1) return null;
    let depth = 0;
    for (let i = source.indexOf('{', at); i < source.length; i++) {
        if (source[i] === '{') depth++;
        else if (source[i] === '}' && --depth === 0) return source.slice(at, i + 1);
    }
    return null;
}

console.log('\n== the app names the stray, and only the stray ==');
{
    const branch = liftBlock(main, "if (d.command === 'HELLO')");
    const idsFn = liftBlock(main, 'function ourExtensionIds()');
    ok(!!branch, "main.js has a HELLO branch on the extension socket", String(branch).slice(0, 40));
    ok(!!idsFn, 'and an ourExtensionIds() to decide against', String(idsFn).slice(0, 40));

    const OURS = 'dnfllmokeafjncoooahljmomepcfddde';
    const STRAY = 'imlmcdmjclmlkhgljdokgjepcppgjfob';
    //  One run of main.js's own branch text. `ids` is what ourExtensionIds() will
    //  answer; a null geoExt is the "nothing packaged yet" case, which has to
    //  refuse nobody.
    const decide = (d, ids) => {
        const log = [];
        const sent = [];
        const ws = { send: s => sent.push(JSON.parse(s)), close: () => log.push('close') };
        const geoLive = new Map([[ws, { armed: true }]]);
        const fn = new Function('d', 'ws', 'geoLive', 'Logger', 'geoExt', 'setTimeout', 'log',
            idsFn + '\n' + branch + '\nreturn "fell-through";');
        const out = fn(d, ws, geoLive,
            { warn: m => log.push('warn:' + m), info: () => {}, debug: () => {} },
            () => ({ knownId: () => ids[0] || null, edgeStoreId: ids[1] || null, webstoreId: null }),
            fn2 => { fn2(); },
            log);
        return { sent, log, geoLive, fell: out === 'fell-through' };
    };

    let r = decide({ command: 'HELLO', id: STRAY, installType: 'development' }, [OURS]);
    ok(r.sent.length === 1 && r.sent[0].type === 'STAND_DOWN',
       'an unpacked copy whose id is not the id this app installed is told to stand down -- ' +
       'that is the duplicate row, and the app is the only side that knows which id is right',
       JSON.stringify(r.sent));
    ok(r.log.includes('close'),
       'and its socket is closed, after the answer has had a moment to leave', r.log.join(' | '));
    ok(r.geoLive.size === 0,
       'and it stops counting as a covered browser profile: a standby confirms nothing, and ' +
       'counting it would be a coverage claim with nothing behind it', String(r.geoLive.size));

    r = decide({ command: 'HELLO', id: OURS, installType: 'development' }, [OURS]);
    ok(!r.sent.length, 'the copy the app installed is never stood down, even unpacked -- a ' +
       'developer running this repo unpacked with the app is not a stray', JSON.stringify(r.sent));

    r = decide({ command: 'HELLO', id: STRAY, installType: 'normal' }, [OURS]);
    ok(!r.sent.length, "a store copy ('normal') is left alone whatever its id: the store " +
       're-signs the CRX, so its id is not the one we signed and never will be',
       JSON.stringify(r.sent));

    r = decide({ command: 'HELLO', id: STRAY, installType: 'admin' }, [OURS]);
    ok(!r.sent.length, "and a policy copy ('admin') is left alone: force-installed is the " +
       'route this app itself asks for on a managed machine', JSON.stringify(r.sent));

    r = decide({ command: 'HELLO', id: STRAY, installType: 'development' }, []);
    ok(!r.sent.length, 'with NO id of our own known yet -- nothing packaged, no journal -- ' +
       'nobody is stood down: a guess here would uninstall a working extension',
       JSON.stringify(r.sent));

    r = decide({ command: 'HELLO', id: STRAY, installType: 'unknown' }, [OURS]);
    ok(!r.sent.length, "and an installType of 'unknown' is not acted on: that is a greeting " +
       'sent before getSelf() answered, and the copy re-sends it once it knows',
       JSON.stringify(r.sent));

    r = decide({ command: 'HELLO', id: 'nope', installType: 'development' }, [OURS]);
    ok(!r.sent.length && !r.fell,
       'a malformed id is dropped rather than answered -- everything below this line came ' +
       'off a socket, and an extension id is exactly 32 letters a-p', JSON.stringify(r.sent));

    r = decide({ command: 'HELLO', id: STRAY, installType: 'development' }, [OURS, STRAY]);
    ok(!r.sent.length, 'and the Edge store id counts as ours too, so the store copy of this ' +
       'very extension is never mistaken for a stray -- with our packaged id known, which is ' +
       'what makes this a test of the store id and not of the empty-list guard',
       JSON.stringify(r.sent));
}

console.log(`\n${pass}/${pass + fail} checks passed`);
if (fail) process.exitCode = 1;
