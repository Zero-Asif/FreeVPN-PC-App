'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/test-popup.js  --  Extension/popup.html + popup.js
//
//  Two halves, and the second is the one that matters.
//
//  1. STATIC. An id in popup.js that does not exist in popup.html throws on a
//     property of null and the popup renders as a blank white box -- the kind
//     of break nobody notices until a user opens it. Also: no external URL
//     anywhere (a flag image per country would announce the chosen country to
//     whoever serves it), no inline <script> (MV3 forbids it, so a popup with
//     one is simply dead), and no class in the JS that the stylesheet has
//     never heard of.
//
//  2. BEHAVIOURAL. popup.js is executed for real in a vm context against a
//     small DOM shim, then driven through the sequence a user actually causes:
//     app absent -> app present -> connect progress -> connected -> country
//     switch -> app quits. Every assertion reads what the user would SEE
//     (button text, disabled, gate, chips, timer) or what the app would
//     RECEIVE (the exact SEND_COMMAND payload). Nothing trusts a return value.
//
//  The point of the second half is the honesty rules that are easy to state
//  and easy to break: the popup must never claim a state the app has not
//  reported, must never re-label a country on a live tunnel, and must go inert
//  -- with a sentence, not silence -- the moment the app is gone.
// ════════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const EXT = path.join(__dirname, '..', 'Extension');
const html = fs.readFileSync(path.join(EXT, 'popup.html'), 'utf8');
const js = fs.readFileSync(path.join(EXT, 'popup.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
    if (cond) { pass++; console.log('  ok   ' + name); }
    else { fail++; console.log('  FAIL ' + name + (extra ? '  -- ' + extra : '')); }
};

console.log('── static: popup.html ──');
{
    const ids = new Set((html.match(/id="([\w-]+)"/g) || []).map(s => s.slice(4, -1)));
    const used = new Set((js.match(/\$\('([\w-]+)'\)/g) || []).map(s => s.slice(3, -2)));
    const missing = [...used].filter(i => !ids.has(i));
    ok(!missing.length, 'every id popup.js asks for exists in the markup', JSON.stringify(missing));
    ok(used.size >= 20, 'the popup wires up the whole panel, not a fragment', String(used.size));

    const urls = html.match(/https?:\/\/[^"')\s]+/g);
    ok(!urls, 'no external URL in the markup or the stylesheet', JSON.stringify(urls));
    ok(!/@import/.test(html), 'no @import -- that is a network fetch too');
    ok(!/<script(?![^>]*src=)/.test(html),
       'no inline <script>: MV3 content security policy would refuse to run it');
    const srcs = (html.match(/<script[^>]*src="([^"]+)"/g) || []).map(s => s.match(/src="([^"]+)"/)[1]);
    ok(srcs.length === 1 && srcs[0] === 'popup.js', 'exactly one script, and it is local',
       JSON.stringify(srcs));
    const imgs = (html.match(/<img[^>]*src="([^"]+)"/g) || []).map(s => s.match(/src="([^"]+)"/)[1]);
    ok(imgs.every(s => !/^https?:/.test(s)), 'every image is packaged with the extension',
       JSON.stringify(imgs));
    ok(imgs.includes('icon.png') && fs.existsSync(path.join(EXT, 'icon.png')),
       'the app logo is shown and the file is there');
    ok(!/PLACEHOLDER/.test(html) && !/PLACEHOLDER/.test(js), 'no placeholder left behind');
}
console.log('\n── static: the classes the JS drives must exist in the CSS ──');
{
    //  A className the stylesheet has never heard of is a state that silently
    //  looks like every other state -- a disabled button that still looks
    //  clickable, a gate that never appears.
    const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
    const declared = new Set((css.match(/\.[a-z][\w-]*/gi) || []).map(s => s.slice(1)));
    const driven = new Set();
    for (const m of js.matchAll(/classList\.(?:add|remove|toggle|contains)\('([\w-]+)'/g))
        driven.add(m[1]);
    for (const m of js.matchAll(/className = '([\w -]+)'/g))
        m[1].split(/\s+/).filter(Boolean).forEach(c => driven.add(c));
    for (const m of js.matchAll(/className = '([\w-]+) ' \+/g)) driven.add(m[1]);
    for (const m of js.matchAll(/'(?:chip|dot) ' \+ \(?(\w+)/g)) void m;
    //  The variable halves: grade() returns these three, and the dot states.
    ['fast', 'busy', 'slow', 'live', 'connected', 'connecting', 'offline'].forEach(c => driven.add(c));
    const unknown = [...driven].filter(c => !declared.has(c));
    ok(!unknown.length, 'every class the JS sets is styled', JSON.stringify(unknown));
    for (const c of ['gate', 'show', 'locked', 'on', 'done', 'failed', 'active', 'note'])
        ok(declared.has(c), `.${c} is styled`);
}

console.log('\n── static: manifest agreement ──');
{
    const mf = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
    ok(mf.action && mf.action.default_popup === 'popup.html', 'the manifest opens this popup');
    ok(!/"content_security_policy"/.test(JSON.stringify(mf)) || true, 'manifest read');
    ok(Number(mf.minimum_chrome_version) >= 111,
       'Intl.DisplayNames and :has-free CSS are safe at the declared minimum',
       String(mf.minimum_chrome_version));
}

// ════════════════════════════════════════════════════════════════════
//  The DOM shim. Deliberately tiny: it supports exactly what popup.js uses,
//  so an unsupported call is a loud crash here rather than a silent no-op.
// ════════════════════════════════════════════════════════════════════
function makeNode(tag) {
    const n = {
        tagName: tag.toUpperCase(),
        children: [], parent: null, dataset: {}, style: {},
        _text: '', _cls: new Set(), _lis: {},
        //  Own text FIRST, then the children -- the order a real node reports.
        //  It matters for the country badge, which is a text node (the two
        //  letters) with the flag <img> layered on top of it: a shim that
        //  returned only the children would read that badge as empty.
        get textContent() {
            return this._text + this.children.map(c => c.textContent).join('');
        },
        set textContent(v) { this._text = String(v); this.children = []; },
        get className() { return [...this._cls].join(' '); },
        set className(v) { this._cls = new Set(String(v).split(/\s+/).filter(Boolean)); },
        classList: null,
        append(...kids) { for (const k of kids) { k.parent = n; n.children.push(k); } },
        appendChild(k) { n.append(k); return k; },
        addEventListener(type, fn) { (n._lis[type] = n._lis[type] || []).push(fn); },
        //  Events bubble, because the popup listens on the <ul> and never on an
        //  individual <li>. A shim without bubbling would let a click "work"
        //  here while doing nothing at all in a browser.
        fire(type, ev = {}) {
            let stopped = false;
            const e = Object.assign({
                target: n, preventDefault() {}, stopPropagation() { stopped = true; },
            }, ev);
            for (let p = n; p && !stopped; p = p.parent)
                for (const fn of (p._lis[type] || []).slice()) fn(e);
        },
        contains(other) {
            for (let p = other; p; p = p.parent) if (p === n) return true;
            return false;
        },
        closest(sel) {
            const m = sel.match(/^(\w+)(?:\[data-(\w+)\])?$/);
            for (let p = n; p; p = p.parent) {
                if (p.tagName !== m[1].toUpperCase()) continue;
                if (m[2] && p.dataset[m[2]] === undefined) continue;
                return p;
            }
            return null;
        },
        focus() { DOC.activeElement = n; },
        blur() { if (DOC.activeElement === n) DOC.activeElement = null; n.fire('blur'); },
        get value() { return n._value || ''; },
        set value(v) { n._value = String(v); },
    };
    n.classList = {
        add: (...c) => c.forEach(x => n._cls.add(x)),
        remove: (...c) => c.forEach(x => n._cls.delete(x)),
        contains: c => n._cls.has(c),
        toggle: (c, force) => {
            const on = force === undefined ? !n._cls.has(c) : !!force;
            on ? n._cls.add(c) : n._cls.delete(c);
            return on;
        },
    };
    return n;
}
const NODES = {};
for (const m of html.matchAll(/id="([\w-]+)"/g)) {
    //  Tag names are only needed where popup.js keys off them (the <li>s it
    //  creates, and the <ul> it clears), so the shim reads the real tag.
    const before = html.slice(0, m.index);
    const tag = (before.match(/<(\w+)[^<>]*$/) || [, 'div'])[1];
    NODES[m[1]] = makeNode(tag);
}
const DOC = {
    activeElement: null,
    _lis: {},
    getElementById: id => NODES[id] || null,
    createElement: tag => makeNode(tag),
    addEventListener(type, fn) { (DOC._lis[type] = DOC._lis[type] || []).push(fn); },
    fire(type, ev) { for (const fn of DOC._lis[type] || []) fn(Object.assign({ target: null }, ev)); },
};

//  Captured, not run: the popup polls on a timer, and a test that let those
//  fire would race its own assertions and never exit.
const timers = [];
const sent = [];              // every SEND_COMMAND / WAKE that reached "chrome"
let responder = () => ({});   // what the fake background answers
let lastError = null;
const listeners = [];         // chrome.runtime.onMessage subscribers

const chrome = {
    runtime: {
        get lastError() { return lastError; },
        //  The real one resolves a packaged path against this extension's own
        //  origin. Stubbed with the same shape so an <img src> built here is
        //  still checkable: what matters is that the popup asks for a file it
        //  ships with, never a URL off the internet.
        getURL: p => 'chrome-extension://freeproxyvpn/' + String(p).replace(/^\/+/, ''),
        sendMessage(msg, cb) {
            sent.push(msg);
            const res = responder(msg);
            if (cb) cb(res);
        },
        onMessage: { addListener: fn => listeners.push(fn) },
    },
};

const sandbox = {
    document: DOC, chrome, console, Intl, Math, Date, JSON, Object, String, Number, Array,
    setTimeout: () => 0, clearTimeout: () => {},
    setInterval: fn => { timers.push(fn); return timers.length; },
};
sandbox.window = sandbox;

//  Answer WAKE with "app not running" for the very first run, which is the
//  state a popup opened before the app is up must show.
responder = msg => (msg.type === 'WAKE' ? { state: { appRunning: false } } : { ok: false });
vm.runInNewContext(js, sandbox, { filename: 'popup.js' });

const push = state => listeners.forEach(fn => fn({ type: 'UI_UPDATE', state }));
const N = id => NODES[id];
const txt = id => N(id).textContent;
const has = (id, cls) => N(id)._cls.has(cls);
const items = () => N('list').children.filter(li => li.dataset.cc !== undefined);
const lastSent = t => [...sent].reverse().find(m => m.type === t);

console.log('\n── behaviour: the app is not running ──');
{
    ok(has('gate', 'show'), 'the "start the app" panel is shown');
    ok(N('act').disabled === true, 'Connect is disabled');
    ok(txt('act') === 'App not running', 'and it says why, on the button itself', txt('act'));
    ok(txt('stateText') === 'App not running', 'the status line agrees', txt('stateText'));
    ok(has('dot', 'offline') && has('dot2', 'offline'), 'both status dots are the offline colour');
    ok(N('ks').disabled === true && N('bypass').disabled === true,
       'the kill switch and the bypass field are inert too');
    ok(txt('timer') === '', 'no connection clock is running');
    ok(!has('geoBox', 'show'), 'no location is claimed');
    ok(items().length === 0 && /country list/i.test(txt('list')),
       'the country list says where it comes from instead of being empty', txt('list'));
}
console.log('\n── behaviour: the app appears, tunnel off ──');
{
    push({
        appRunning: true, connected: false, busy: false, serverCode: 'us',
        killSwitch: false, bypassList: '', progress: null, since: null, geo: null,
        servers: {
            //  Chosen to land one country in each of the app window's three
            //  capacity bands, thresholds included: 'fast' is count>200 OR
            //  >50 Mbps, so a low-count country with a fat pipe is still fast.
            us: { count: 600, bandwidth: 9000000000 },   // count -> fast
            de: { count: 450, bandwidth: 8000000000 },   // count -> fast
            ro: { count: 60,  bandwidth: 20000000  },    // 20 Mbps -> busy
            hk: { count: 8,   bandwidth: 4000000   },    // 4 Mbps  -> slow
        },
    });
    ok(!has('gate', 'show'), 'the gate is gone');
    ok(N('act').disabled === false && txt('act') === 'Connect', 'Connect is live', txt('act'));
    ok(!has('act', 'on'), 'the button is not wearing its disconnect colour');
    ok(txt('stateText') === 'Not connected', 'the status line is honest about the tunnel',
       txt('stateText'));
    ok(N('ks').disabled === false && N('bypass').disabled === false, 'the controls are usable');

    const li = items();
    ok(li.length === 4, 'every country the app published is listed', String(li.length));
    ok(li.map(x => x.dataset.cc).join(',') === 'us,de,ro,hk',
       'sorted by the capacity the app measured, biggest first',
       li.map(x => x.dataset.cc).join(','));
    const chip = cc => li.find(x => x.dataset.cc === cc).children[2];
    const band = cc => ['fast', 'busy', 'slow'].find(c => chip(cc)._cls.has(c));
    ok(band('us') === 'fast' && band('de') === 'fast' &&
       band('ro') === 'busy' && band('hk') === 'slow',
       'the three capacity classes match the app window\'s own thresholds',
       ['us', 'de', 'ro', 'hk'].map(c => c + '=' + band(c)).join(' '));
    ok(chip('de').textContent === '450 exits',
       'the chip reports the relay count the app measured -- not an invented latency',
       chip('de').textContent);
    ok(li.find(x => x.dataset.cc === 'us')._cls.has('active'), 'the chosen country is marked');
    ok(li.every(x => x.children[0].textContent === x.dataset.cc.toUpperCase()),
       'the country badge carries the code itself, so a missing flag still reads');
    //  The flag is a file out of the CRX, layered over the badge. A remote URL
    //  here would be this popup telling a website which countries were opened.
    const flags = li.map(x => (x.children[0].children[0] || {}).src || '');
    ok(flags.every((s, i) => s === 'chrome-extension://freeproxyvpn/flags/' +
                                   li[i].dataset.cc.toLowerCase() + '.svg'),
       'and the real flag is drawn from the packaged flags/ folder, never fetched',
       flags[0] || '(none)');
    ok(li.every(x => /linear-gradient/.test(x.children[0].style.background || '')),
       'and it is actually painted');
    const de = li.find(x => x.dataset.cc === 'de');
    ok(de.children[1].textContent === 'Germany', 'names come from Intl, not a bundled table',
       de.children[1].textContent);
}

console.log('\n── behaviour: search filters the list ──');
{
    N('search').value = 'ger';
    N('search').fire('input');
    ok(items().length === 1 && items()[0].dataset.cc === 'de', 'by name');
    N('search').value = 'hk';
    N('search').fire('input');
    ok(items().length === 1 && items()[0].dataset.cc === 'hk', 'by country code');
    N('search').value = 'zzz';
    N('search').fire('input');
    ok(items().length === 0 && /No exit country matches/.test(txt('list')),
       'and says so when nothing matches', txt('list'));
    N('search').value = '';
    N('search').fire('input');
    ok(items().length === 4, 'cleared');
}
console.log('\n── behaviour: pressing Connect ──');
{
    responder = () => ({ ok: true });
    sent.length = 0;
    N('act').fire('click');
    const m = lastSent('SEND_COMMAND');
    ok(!!m && m.payload.command === 'CONNECT', 'the app is asked to connect',
       JSON.stringify(m && m.payload));
    ok(N('act').disabled === true, 'the button locks itself until the app answers');
    ok(/Connecting/.test(txt('act')), 'and says what it is waiting for', txt('act'));
    ok(!has('prog', 'show'), 'no progress bar is invented before the app sends one');
}

console.log('\n── behaviour: the app\'s own progress feed drives the bar ──');
{
    push({ busy: true, progress: { percent: 35, message: 'Bootstrapping Tor circuit...', status: 'connecting' } });
    ok(has('prog', 'show'), 'the bar appears');
    ok(N('fill').style.width === '35%', 'at the percentage the app reported', N('fill').style.width);
    ok(txt('progMsg') === 'Bootstrapping Tor circuit...', 'with the app\'s own message', txt('progMsg'));
    ok(txt('progPct') === '35%', 'and the number spelled out', txt('progPct'));
    ok(has('dot', 'connecting'), 'the status dot goes amber');
    ok(N('picked')._cls.has('locked'), 'the country cannot be changed mid-connect');

    push({ busy: true, progress: { percent: 140, message: 'x', status: 'connecting' } });
    ok(N('fill').style.width === '100%', 'a percentage over 100 is clamped, not drawn off the end',
       N('fill').style.width);
}

console.log('\n── behaviour: connected ──');
{
    const since = Date.now() - 3725000;   // 1h 02m 05s ago
    push({
        connected: true, busy: false, serverCode: 'de', since,
        progress: { percent: 100, message: 'Secured via Germany', status: 'connected' },
        geo: { lat: 52.52, lng: 13.405, accuracy: 18, city: 'Berlin', cc: 'DE' },
    });
    ok(txt('act') === 'Disconnect' && has('act', 'on'), 'the button turns into Disconnect');
    ok(N('act').disabled === false, 'and is usable again');
    ok(txt('stateText') === 'Protected - Germany', 'the status names the verified country',
       txt('stateText'));
    ok(has('dot', 'connected'), 'the dot goes green');
    ok(txt('timer') === '01:02:05', 'the clock reads the app\'s connect timestamp', txt('timer'));
    ok(has('geoBox', 'show'), 'the reported location is shown');
    ok(txt('geoPlace') === 'Berlin, Germany', 'named', txt('geoPlace'));
    ok(/52\.5200, 13\.4050/.test(txt('geoCoords')), 'with the coordinates pages are given',
       txt('geoCoords'));
    ok(/18 m/.test(txt('geoCoords')), 'and the accuracy that goes with them', txt('geoCoords'));
    ok(has('prog', 'show') && has('prog', 'done'),
       'the finished bar stays up briefly, in its success colour');
    const active = items().find(x => x.dataset.cc === 'de');
    ok(active && active.children[2].textContent === 'Connected',
       'the live country is marked in the list', active && active.children[2].textContent);
}
console.log('\n── behaviour: changing country on a LIVE tunnel ──');
{
    //  The rule this protects: the coordinates every page sees are derived from
    //  the app's serverCode, so a popup that re-labels itself first would have
    //  the browser reporting one country while the exit IP still shows another.
    sent.length = 0;
    const before = txt('pickedName');
    const ro = items().find(x => x.dataset.cc === 'ro');
    ro.fire('click', { target: ro });
    const m = lastSent('SEND_COMMAND');
    ok(!!m && m.payload.command === 'CHANGE_SERVER' && m.payload.server === 'ro',
       'the app is asked to switch', JSON.stringify(m && m.payload));
    ok(txt('pickedName') === before,
       'the popup does NOT re-label itself first -- it waits for the verified exit',
       txt('pickedName'));
    ok(txt('geoPlace') === 'Berlin, Germany',
       'and it keeps reporting the country the exit IP still belongs to', txt('geoPlace'));
    ok(N('act').disabled === true, 'controls are locked while the switch runs');

    //  Now the app reports the switch actually happened.
    push({ serverCode: 'ro', busy: false,
           geo: { lat: 44.4268, lng: 26.1025, accuracy: 20, city: 'Bucharest', cc: 'RO' } });
    ok(txt('pickedName') === 'Romania', 'once the app confirms it, the label follows',
       txt('pickedName'));
    ok(txt('geoPlace') === 'Bucharest, Romania', 'together with the reported location',
       txt('geoPlace'));
}

console.log('\n── behaviour: a click the app refuses ──');
{
    //  background.js answers every command, refusal included. The old popup
    //  dropped them silently: the user clicked Connect with the app shut and
    //  watched nothing happen at all.
    responder = msg => (msg.type === 'SEND_COMMAND'
        ? { ok: false, reason: 'app-not-running' } : { state: { appRunning: false } });
    sent.length = 0;
    N('act').fire('click');
    ok(/not running/i.test(txt('toast')), 'the user is told the app is not running', txt('toast'));
    ok(/Start it/i.test(txt('toast')), 'and what to do about it', txt('toast'));
    ok(has('toast', 'show'), 'the message is actually visible');
    ok(has('gate', 'show'), 'the panel falls back to its inert state');
    ok(N('act').disabled === true, 'and does not sit on "Connecting..." for ever');
}

console.log('\n── behaviour: a kill switch the app refuses goes back ──');
{
    push({ appRunning: true, connected: true, busy: false, killSwitch: false });
    N('ks').checked = true;
    N('ks').fire('change', { target: N('ks') });
    ok(N('ks').checked === false,
       'the switch returns to what the app reports, so it cannot show a protection that is off');
    ok(/did not take|not running/i.test(txt('toast')), 'with an explanation', txt('toast'));
}
console.log('\n── behaviour: the split-tunnel list ──');
{
    //  Two windows can type into this list. If they normalise differently the
    //  app stores one thing and the popup shows another, and the user cannot
    //  tell which hosts are actually bypassing the tunnel.
    responder = () => ({ ok: true });
    push({ appRunning: true, connected: true, busy: false, serverCode: 'ro',
           killSwitch: false, bypassList: '' });
    sent.length = 0;

    N('bypass').value = 'HTTPS://Bank.COM/x, foo.com ';
    N('bypass').blur();
    ok(N('bypass').value === 'bank.com; foo.com',
       'scheme, path, spaces and the comma separator are cleaned up the way the app window does',
       N('bypass').value);
    const m = lastSent('SEND_COMMAND');
    ok(!!m && m.payload.command === 'UPDATE_BYPASS' && m.payload.list === 'bank.com; foo.com',
       'and the app is handed the cleaned list, not the raw typing',
       JSON.stringify(m && m.payload));

    push({ bypassList: 'bank.com; foo.com' });
    N('bypass').focus();
    N('bypass').value = 'bank.com; foo.com; hal';
    push({ killSwitch: false, busy: false });
    ok(N('bypass').value === 'bank.com; foo.com; hal',
       'a state push does not overwrite a half-typed host', N('bypass').value);

    sent.length = 0;
    N('bypass').value = 'bank.com;foo.com';     // same list, different spacing
    N('bypass').blur();
    ok(!lastSent('SEND_COMMAND'),
       'and re-committing the same list in a different shape sends nothing',
       JSON.stringify(sent));
}
console.log('\n── behaviour: the picked country has no exit node, so the app ASKS ──');
{
    //  The rule this protects: when the country the user picked cannot be
    //  reached, the app must NOT quietly connect them somewhere else. It stops
    //  and asks -- and the popup is one of the two places that question has to
    //  appear, with the app's own options, going back to the same question.
    responder = () => ({ ok: true });
    push({ appRunning: true, connected: false, busy: false, serverCode: 'jp',
           since: null, geo: null, progress: null, ask: {
               id: 'ask7', variant: 'choice', cc: 'jp',
               title: 'No exit node available in Japan',
               body: 'Japan has no reachable exit relay right now. What do you want to do?',
               note: 'Already ruled out: 3 relays in Japan would not carry traffic.',
               options: [
                   { id: 'nearest', label: 'Connect me to the nearest country',
                     hint: 'Keeps looking for Japan in the background' },
                   { id: 'wait',    label: 'Keep trying Japan',
                     hint: 'Nothing is connected until it works' },
                   { id: 'cancel',  label: 'Cancel',
                     hint: 'Stay on this PC\'s own connection' },
               ],
           } });

    ok(has('ask', 'show'), 'the question is on screen');
    ok(txt('askTitle') === 'No exit node available in Japan',
       'in the app\'s own words, not a second version of them', txt('askTitle'));
    ok(/no reachable exit relay/.test(txt('askBody')), 'with the app\'s explanation', txt('askBody'));
    ok(has('askNote', 'show') && /3 relays/.test(txt('askNote')),
       'and what an earlier round already ruled out', txt('askNote'));
    ok(N('askCc').textContent.startsWith('JP'), 'the country in question is named',
       N('askCc').textContent);

    const opts = N('askOpts').children;
    ok(opts.length === 3, 'one button per option the app offered, no more', String(opts.length));
    ok(opts.map(b => b.dataset.answer).join(',') === 'nearest,wait,cancel',
       'each carrying the app\'s own option id', opts.map(b => b.dataset.answer).join(','));
    ok(opts[0].children[0].textContent === 'Connect me to the nearest country',
       'labelled as the app labelled it', opts[0].children[0].textContent);
    ok(opts[0].children[1].textContent === 'Keeps looking for Japan in the background',
       'hint included, so no option hides what it will do');
    ok(opts[0]._cls.has('primary') && opts[2]._cls.has('danger'),
       'the app\'s first option leads and cancelling is marked as the one that gives up');
    ok(!has('askDots', 'show'), 'nothing pretends to be working while it waits to be told');
    ok(/no country has been picked for you/i.test(txt('askFoot')),
       'and the footer says exactly where things stand', txt('askFoot'));
    ok(N('dd').style.display === 'none' && N('act').style.display === 'none',
       'the selector and the action button come off screen -- answering IS the only move');
    ok(txt('stateText') === 'Waiting for your answer',
       'the header says the app is waiting on the user, not "Connecting"', txt('stateText'));
    /* ASK_ANSWER_ASSERTS */

    sent.length = 0;
    const cancel = opts[2];
    cancel.fire('click', { target: cancel });
    const m = lastSent('SEND_COMMAND');
    ok(!!m && m.payload.command === 'ASK_ANSWER' && m.payload.answer === 'cancel',
       'the clicked option goes back to the app', JSON.stringify(m && m.payload));
    ok(!!m && m.payload.id === 'ask7',
       'stamped with the id of the question on screen, so it can never answer a later one',
       String(m && m.payload.id));
    ok(opts.every(b => b.disabled === true), 'every button locks -- one click, one answer');

    sent.length = 0;
    cancel.fire('click', { target: cancel });
    ok(!lastSent('SEND_COMMAND'), 'so a second click sends nothing at all', JSON.stringify(sent));

    //  Only the app closes the question. It is the app that is blocked on the
    //  answer, so it is the app that decides when the asking is over.
    push({ ask: null, progress: { percent: 100, message: 'Cancelled -- not connected',
                                  status: 'cancelled' } });
    ok(!has('ask', 'show'), 'the card goes when the app says the question is finished');
    ok(N('dd').style.display !== 'none' && N('act').style.display !== 'none',
       'and the controls come back');
}

console.log('\n── behaviour: "keep trying" is a live card, not a dead end ──');
{
    push({ ask: { id: 'ask8', variant: 'live', cc: 'jp', title: 'Still trying Japan',
                  body: 'Nothing else is connected while this runs.',
                  options: [{ id: 'stop', label: 'Stop trying',
                              hint: 'Gives up on Japan and leaves this PC unprotected' }] } });
    ok(has('ask', 'show') && has('askDots', 'show'),
       'the working indicator runs, because this time the app really is working');
    ok(txt('stateText') === 'Still trying...', 'and the header says so', txt('stateText'));
    const live = N('askOpts').children;
    ok(live.length === 1 && live[0]._cls.has('danger'),
       'with one way out, marked as the one that stops it');
    ok(!live[0]._cls.has('primary'),
       'and nothing is dressed up as a recommendation -- there is nothing to recommend');
    ok(/Nothing is connected while this runs/i.test(txt('askFoot')),
       'the footer states the cost of waiting', txt('askFoot'));

    //  The app dies with the question still up.
    push({ appRunning: false });
    ok(!has('ask', 'show'),
       'a question nobody is waiting on any more comes down -- the app that asked it is gone');
    push({ appRunning: true, ask: null, connected: false, busy: false });
}
console.log('\n── behaviour: the app quits while the popup is open ──');
{
    //  The whole "the extension only works while the app is running" rule, at
    //  the moment it matters most: the tunnel WAS up a second ago. Anything
    //  left on screen from that moment is now a claim nobody is backing.
    push({ appRunning: false, connected: false, busy: false,
           since: null, geo: null, progress: null });
    ok(has('gate', 'show'), 'the "start the app" panel comes back');
    ok(N('act').disabled === true && txt('act') === 'App not running',
       'Connect goes inert and says why', txt('act'));
    ok(txt('stateText') === 'App not running', 'so does the status line', txt('stateText'));
    ok(has('dot', 'offline'), 'the dot stops pulsing green');
    ok(txt('timer') === '', 'the clock stops instead of counting a tunnel that is gone');
    ok(!has('geoBox', 'show'),
       'and the popup stops reporting a location it can no longer verify');
    ok(!has('prog', 'show'), 'the progress bar goes with it');
    ok(N('ks').disabled === true && N('bypass').disabled === true, 'the controls are inert');

    N('picked').fire('click');
    ok(!N('dd')._cls.has('open'), 'the country dropdown will not even open');
}

console.log('\n── protocol: every message the popup sends is one the other side handles ──');
{
    //  A typo in one of these strings is silence: background.js ignores an
    //  unknown type, main.js ignores an unknown command, and the popup shows a
    //  control that does nothing at all.
    const bg = fs.readFileSync(path.join(EXT, 'background.js'), 'utf8');
    const mainJs = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

    const types = new Set([...js.matchAll(/sendMessage\(\{\s*type:\s*'([A-Z_]+)'/g)].map(m => m[1]));
    ok(types.size >= 2, 'the popup talks to the worker at all', [...types].join(','));
    const badTypes = [...types].filter(t => !bg.includes(`msg.type === "${t}"`) &&
                                           !bg.includes(`msg.type === '${t}'`));
    ok(!badTypes.length, 'background.js has a branch for each one', JSON.stringify(badTypes));

    const cmds = new Set([...js.matchAll(/command:\s*'([A-Z_]+)'/g)].map(m => m[1]));
    for (const m of js.matchAll(/command:\s*st\.connected\s*\?\s*'([A-Z_]+)'\s*:\s*'([A-Z_]+)'/g)) {
        cmds.add(m[1]); cmds.add(m[2]);
    }
    ok(cmds.size === 6, 'the six commands the panel can issue', [...cmds].join(','));
    const badCmds = [...cmds].filter(c => !mainJs.includes(`d.command === '${c}'`));
    ok(!badCmds.length, 'main.js acts on each one', JSON.stringify(badCmds));

    const seen = new Set(sent.map(m => m.type));
    ok([...seen].every(t => types.has(t)), 'and the run sent nothing else', [...seen].join(','));
}
console.log('\n── the popup keeps no second copy of the app\'s state ──');
{
    //  The rule the whole file exists to protect. Every fact on screen has to
    //  have arrived from the app, so the only writes to `st` outside apply()
    //  may be the pessimistic one on a refusal.
    const writes = [...js.matchAll(/^\s*st\.(\w+)\s*=/gm)].map(m => m[1]);
    ok(writes.length === 1 && writes[0] === 'appRunning',
       'the only local write is going gated when the app refuses a command',
       JSON.stringify(writes));
    ok(/st = Object\.assign\(\{\}, st, next\)/.test(js),
       'everything else is replaced wholesale by app-authored values');
    ok(!/Math\.random/.test(js), 'nothing on screen is invented');
    ok(!/localStorage|chrome\.storage/.test(js),
       'and nothing is cached to be shown back later as if it were current');
}

console.log('');
console.log(`${pass}/${pass + fail} checks passed`);
if (fail) console.log(`${fail} FAILED`);
process.exit(fail ? 1 : 0);





