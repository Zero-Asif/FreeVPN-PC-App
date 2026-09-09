'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/test-clear-scope.js  --  what does chrome.browsingData.remove
//  ({origins}, MAP_CLEAR) ACTUALLY clear, bucket by bucket, in a real browser?
//
//  Two reports rest on the answer and neither can be settled by reading code:
//
//   1. "app chrome er cache/cookie/history ekhono wipe kore felche". Every
//      clearing call in Extension/background.js is origin-scoped -- that is a
//      fact about the source. Whether Chromium HONOURS the filter for each
//      type is a fact about Chromium, and `cache` is the suspect: the shipping
//      code already carries a retry without it for a build that refuses one.
//   2. Brave replays a US position on every "Your Location" click with
//      BYTE-IDENTICAL jitter digits (probe-brave-nav-order.py: 38.8951644,
//      -77.0364331 at 19:32:26, 19:33:08, :10, :12, 19:34:05, :09).
//      makePosition() re-jitters per call, so those digits cannot come from our
//      shim -- Maps is replaying its own cached position. MAP_CLEAR did include
//      google.com and the value still survived, so SOMETHING it does not cover
//      is holding it. chrome.browsingData has no sessionStorage bucket.
//
//  So: two origins, a marker written into every bucket a page can reach, the
//  shipping MAP_CLEAR aimed at ONE of them, then a reload (NOT a tab close --
//  sessionStorage is per-tab and the real repin is a same-tab navigation) and a
//  read-back of what survived where. Needs a browser but no app: it never binds
//  ws://127.0.0.1:8080, and it runs in a throwaway --user-data-dir.
// ════════════════════════════════════════════════════════════════════
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const { Probe, BROWSERS, sh, sleep } = require('./probe.js');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'clearscope-'));
const PORT_A = 8098, PORT_B = 8097, PORT_R = 8099;
const A = `http://127.0.0.1:${PORT_A}`;      // the "map" origin: the clear aims here
const B = `http://localhost:${PORT_B}`;      // a different host: must survive whole
const STAMP = 'fp-' + process.pid;

let pass = 0, fail = 0;
const ok = (c, m, d) => {
    if (c) { pass++; console.log('  ok   ' + m); }
    else { fail++; console.log('  FAIL ' + m + (d ? '\n         ' + d : '')); }
};

//  Hit counters per origin, so an HTTP-cache clear is measured by the SERVER
//  seeing a second request for a resource it marked cacheable -- not by asking
//  the browser whether it thinks the cache is warm.
const hits = { [PORT_A]: {}, [PORT_B]: {} };

const PAGE = `<!doctype html><meta charset="utf-8"><title>clear-scope</title>
<body><h3 id=h>clear-scope</h3><script>
//  The page itself only marks its identity; every bucket is written and read by
//  the content script, which shares this document's origin and storage and can
//  also talk to the worker. One writer means one thing to blame.
document.getElementById('h').textContent = location.origin;
</script>`;

function makeServer(port, hostBind) {
    const srv = http.createServer((req, res) => {
        const route = (req.url || '').split('?')[0];
        hits[port][route] = (hits[port][route] || 0) + 1;
        if (route === '/c.txt') {
            //  Cacheable on purpose: this is the HTTP-cache instrument.
            const b = Buffer.from('cacheable-' + STAMP);
            res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': b.length,
                                 'Cache-Control': 'public, max-age=600' });
            res.end(req.method === 'HEAD' ? undefined : b);
            return;
        }
        if (route === '/p.html') {
            const b = Buffer.from(PAGE, 'utf8');
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8',
                                 'Content-Length': b.length, 'Cache-Control': 'no-store' });
            res.end(req.method === 'HEAD' ? undefined : b);
            return;
        }
        res.writeHead(404).end();
    });
    return new Promise(r => {
        srv.on('clientError', (e, s) => { try { s.destroy(); } catch (x) {} });
        srv.once('error', () => r(null));
        //  No host argument: dual-stack, because Chrome resolves "localhost" to
        //  ::1 first on Windows and a v4-only bind would read as refused.
        if (hostBind) srv.listen(port, hostBind, () => r(srv));
        else srv.listen(port, () => r(srv));
    });
}

//  ── the measuring extension ────────────────────────────────────────
//  Deliberately NOT Extension/: this one carries only the four calls under
//  test, so a survivor cannot be blamed on anything else the product does.
const MANIFEST = {
    manifest_version: 3,
    name: 'clear-scope probe',
    version: '1.0',
    permissions: ['browsingData', 'storage', 'tabs', 'cookies', 'history'],
    host_permissions: ['<all_urls>'],
    background: { service_worker: 'sw.js' },
    content_scripts: [{
        matches: ['http://127.0.0.1/*', 'http://localhost/*'],
        js: ['cs.js'], run_at: 'document_idle', all_frames: false,
    }],
};

const CS = `'use strict';
var MARK = 'fpmark';
function idbOpen() {
  return new Promise(function (res, rej) {
    var r = indexedDB.open('fpdb', 1);
    r.onupgradeneeded = function () { r.result.createObjectStore('kv'); };
    r.onsuccess = function () { res(r.result); };
    r.onerror = function () { rej(r.error); };
  });
}
function idbPut(v) {
  return idbOpen().then(function (db) {
    return new Promise(function (res, rej) {
      var t = db.transaction('kv', 'readwrite');
      t.objectStore('kv').put(v, MARK);
      t.oncomplete = function () { res(1); };
      t.onerror = function () { rej(t.error); };
    });
  });
}
function idbGet() {
  return idbOpen().then(function (db) {
    return new Promise(function (res) {
      var t = db.transaction('kv', 'readonly');
      var q = t.objectStore('kv').get(MARK);
      q.onsuccess = function () { res(q.result || null); };
      q.onerror = function () { res('x'); };
    });
  });
}
//__NEXT__
async function writeAll(v) {
  var out = {};
  try { localStorage.setItem(MARK, v); out.ls = 1; } catch (e) { out.ls = 'x'; }
  try { sessionStorage.setItem(MARK, v); out.ss = 1; } catch (e) { out.ss = 'x'; }
  try {
    document.cookie = MARK + '=' + v + '; path=/; max-age=3600';
    out.ck = /fpmark=/.test(document.cookie) ? 1 : 0;
  } catch (e) { out.ck = 'x'; }
  try { await idbPut(v); out.idb = 1; } catch (e) { out.idb = 'x'; }
  try {
    var c = await caches.open('fp');
    await c.put('/cs.txt', new Response(v));
    out.cs = 1;
  } catch (e) { out.cs = 'x'; }
  try { var r = await fetch('/c.txt', { cache: 'default' }); await r.text(); out.http = 1; }
  catch (e) { out.http = 'x'; }
  return out;
}
async function readAll() {
  var out = {};
  out.ls = localStorage.getItem(MARK) || null;
  out.ss = sessionStorage.getItem(MARK) || null;
  out.ck = (document.cookie.match(/fpmark=([^;]+)/) || [])[1] || null;
  try { out.idb = await idbGet(); } catch (e) { out.idb = 'x'; }
  try {
    var c = await caches.open('fp');
    var m = await c.match('/cs.txt');
    out.cs = m ? await m.text() : null;
  } catch (e) { out.cs = 'x'; }
  try { out.keys = (await caches.keys()).join('|') || null; } catch (e) { out.keys = 'x'; }
  //  Last, and its answer is read off the SERVER's hit count, not from here: a
  //  second request for a resource marked max-age=600 means the HTTP cache for
  //  this origin was dropped.
  try { var q = await fetch('/c.txt', { cache: 'default' }); await q.text(); } catch (e) {}
  return out;
}
chrome.runtime.sendMessage({ type: 'LOADED', origin: location.origin }, function (reply) {
  if (!reply) return;
  if (reply.do === 'write') {
    writeAll(reply.v).then(function (out) {
      chrome.runtime.sendMessage({ type: 'WROTE', origin: location.origin, out: out });
    });
  } else {
    readAll().then(function (out) {
      chrome.runtime.sendMessage({ type: 'READ', origin: location.origin, out: out });
    });
  }
});
`;

const SW = `'use strict';
var A = '__A__', B = '__B__', R = '__R__', STAMP = '__STAMP__';
//  Copied from Extension/background.js, verbatim. If this drifts the test is
//  measuring something the product does not do.
var MAP_CLEAR = {
    cache: true, cacheStorage: true, indexedDB: true,
    localStorage: true, serviceWorkers: true,
};
var MAPU = 'https://www.google.com/maps/@59.3293,18.0686,16z';
var OTHU = 'https://news.invalid.test/article-42';
var phase = 'write', wrote = {}, seen = {}, doneWrote, doneRead;
var waitWrote = new Promise(function (r) { doneWrote = r; });
var waitRead = new Promise(function (r) { doneRead = r; });
function rep(s) {
    return fetch(R + '?' + encodeURIComponent(s)).then(function () {}, function () {});
}
chrome.runtime.onMessage.addListener(function (msg, sender, send) {
    if (!msg) return;
    if (msg.type === 'LOADED') { send({ do: phase, v: STAMP }); return true; }
    if (msg.type === 'WROTE') {
        wrote[msg.origin] = msg.out;
        rep('wrote ' + msg.origin + ' ' + JSON.stringify(msg.out));
        if (wrote[A] && wrote[B]) doneWrote(1);
    }
    if (msg.type === 'READ') {
        seen[msg.origin] = msg.out;
        rep('read ' + msg.origin + ' ' + JSON.stringify(msg.out));
        if (seen[A] && seen[B]) doneRead(1);
    }
});
function bd(opts, types, tag) {
    return new Promise(function (r) {
        chrome.browsingData.remove(opts, types, function () {
            var e = chrome.runtime.lastError;
            rep(tag + '-err=' + (e ? e.message : 'none')).then(function () { r(!e); });
        });
    });
}
function hAdd(u) {
    return new Promise(function (r) { chrome.history.addUrl({ url: u }, function () { r(); }); });
}
function hHas(u) {
    return new Promise(function (r) {
        chrome.history.search({ text: '', startTime: 0, maxResults: 5000 }, function (rows) {
            r((rows || []).some(function (x) { return x.url === u; }));
        });
    });
}
//__MAIN__
var isMap = function (u) { return /^https?:\\/\\/[^/]*google\\.[^/]*\\/maps/.test(u || ''); };
async function main() {
    await rep('worker-up');
    await hAdd(MAPU);
    await hAdd(OTHU);
    await rep('seeded history map=' + (await hHas(MAPU)) + ' other=' + (await hHas(OTHU)));
    //  Same HOST as A, different port. Cookies ignore the port, so this one
    //  measures how far an origin-filtered cookie clear really reaches.
    await new Promise(function (r) {
        chrome.cookies.set({ url: 'http://127.0.0.1:__PB__/', name: 'otherPort',
                             value: STAMP, expirationDate: 2000000000 }, function () { r(); });
    });
    await waitWrote;
    await rep('-- both origins written; clearing ' + A + ' and nothing else');
    await bd({ origins: [A], since: 0 }, MAP_CLEAR, 'clear-map');
    await bd({ origins: [A], since: 0 }, { cookies: true }, 'clear-cookies');
    await rep('after-clear history map=' + (await hHas(MAPU)) + ' other=' + (await hHas(OTHU)));
    var otherPort = await new Promise(function (r) {
        chrome.cookies.get({ url: 'http://127.0.0.1:__PB__/', name: 'otherPort' },
                           function (c) { r(c ? c.value : null); });
    });
    await rep('after-clear cookie sameHostOtherPort=' + otherPort);
    //  The product's history sweep, replicated: keyword search, isMapUrl
    //  decides, deleteUrl one row at a time. Never browsingData history:true.
    var found = await new Promise(function (r) {
        chrome.history.search({ text: 'maps', startTime: 0, maxResults: 500 },
                              function (rows) { r(rows || []); });
    });
    var del = found.filter(function (x) { return isMap(x.url); });
    for (const row of del) {
        await new Promise(function (r) {
            chrome.history.deleteUrl({ url: row.url }, function () { r(); });
        });
    }
    await rep('after-sweep searched=' + found.length + ' deleted=' + del.length +
              ' map=' + (await hHas(MAPU)) + ' other=' + (await hHas(OTHU)));
    phase = 'read';
    var tabs = await new Promise(function (r) { chrome.tabs.query({}, function (t) { r(t || []); }); });
    var n = 0;
    for (const t of tabs) {
        if (/127\\.0\\.0\\.1:__PA__|localhost:__PB__/.test(t.url || '')) {
            //  A reload, NOT a close: sessionStorage is per tab and the real
            //  repin is a same-tab navigation. Closing it would clear the very
            //  bucket this test exists to interrogate.
            chrome.tabs.reload(t.id, { bypassCache: false });
            n++;
        }
    }
    await rep('reloaded ' + n + ' tab(s)');
    await waitRead;
    await rep('DONE');
}
main();
`;

// ════════════════════════════════════════════════════════════════════
(async () => {

const ext = path.join(TMP, 'ext');
fs.mkdirSync(ext, { recursive: true });
fs.writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify(MANIFEST, null, 2), 'utf8');
fs.writeFileSync(path.join(ext, 'cs.js'), CS, 'utf8');
fs.writeFileSync(path.join(ext, 'sw.js'), SW
    .replace(/__A__/g, A)
    .replace(/__B__/g, B)
    .replace(/__R__/g, 'http://127.0.0.1:' + PORT_R + '/r')
    .replace(/__STAMP__/g, STAMP)
    .replace(/__PA__/g, String(PORT_A))
    .replace(/__PB__/g, String(PORT_B)), 'utf8');

const sa = await makeServer(PORT_A, '127.0.0.1');
const sb = await makeServer(PORT_B, null);
if (!sa || !sb) { console.log('ABORT: could not bind ' + PORT_A + '/' + PORT_B); process.exit(3); }
const rep = new Probe(PORT_R, ['127.0.0.1']);
await rep.start();

const want = (process.argv[2] || '').toLowerCase();
const cand = BROWSERS.filter(b => b.exe.some(e => fs.existsSync(e)))
                     .filter(b => !want || b.id === want);
if (!cand.length) { console.log('ABORT: no Chromium browser found' + (want ? ' for "' + want + '"' : '')); process.exit(3); }
const browser = cand[0];
const exe = browser.exe.find(e => fs.existsSync(e));
console.log('browser  ' + browser.name + '  ' + exe);
console.log('origin A ' + A + '   (the clear aims here)');
console.log('origin B ' + B + '   (a different host: must survive)');
console.log('');
const t0 = Date.now();

const run = await rep.run({
    exe, tmp: TMP, label: 'clearscope-' + browser.id,
    //  MEASURED 2026-09-06, Chrome 1xx, its own log line:
    //    "--disable-extensions-except is not allowed in Google Chrome, ignoring."
    //  A branded Chrome build refuses the unpacked-load switches unless the
    //  feature behind them is turned back on, and silently loads no extension.
    //  Brave and Edge accept them as they always have.
    args: [
        `--load-extension=${ext}`,
        ...(browser.id === 'chrome'
            ? ['--disable-features=DisableLoadExtensionCommandLineSwitch']
            : [`--disable-extensions-except=${ext}`]),
        `${B}/p.html`,
    ],
    url: `${A}/p.html`,
    waitSec: 90,
    //  Bail early when nothing reports at all: that is a load failure, not a
    //  slow run, and 90 s of waiting adds no information.
    until: () => rep.reports.includes('DONE') ||
                 (Date.now() - t0 > 20000 && !rep.reports.length),
});
for (const s of run.reports) console.log('   · ' + s);
console.log('');
console.log('   server hits  A ' + JSON.stringify(hits[PORT_A]) + '   B ' + JSON.stringify(hits[PORT_B]));
console.log('');
//__ASSERT__
const R = run.reports;
const after = (pre) => { const s = R.find(x => x.startsWith(pre)); return s ? s.slice(pre.length) : null; };
const j = (pre) => { const s = after(pre); if (s === null) return null; try { return JSON.parse(s); } catch (e) { return null; } };
const wroteA = j('wrote ' + A + ' '), wroteB = j('wrote ' + B + ' ');
const readA = j('read ' + A + ' '), readB = j('read ' + B + ' ');

ok(R.includes('DONE'), 'the run completed', R.length + ' report(s): ' + R.join(' | '));
const refused = /not allowed in Google Chrome/.test(run.log || '');
if (refused) {
    console.log('\n   NOTE: this build refused the unpacked-extension switch and loaded NO ' +
                'extension -- the browser said so itself:');
    for (const l of (run.log || '').split('\n')) if (/not allowed in Google Chrome/.test(l)) console.log('     ' + l.trim());
}
if (!readA || !readB) {
    console.log('\nNOT MEASURED -- one of the two pages never reported back. ' +
                'Nothing below can be concluded, so nothing below is claimed.');
    console.log('\n' + pass + '/' + (pass + fail) + ' checks passed');
    rep.stop(); try { sa.close(); sb.close(); } catch (e) {}
    process.exit(1);
}
ok(wroteA && wroteA.ls === 1 && wroteA.ss === 1 && wroteA.idb === 1 && wroteA.cs === 1 &&
   wroteA.ck === 1 && wroteA.http === 1,
   'setup: origin A wrote a marker into every bucket a page can reach', JSON.stringify(wroteA));
ok(wroteB && wroteB.ls === 1 && wroteB.ss === 1 && wroteB.idb === 1 && wroteB.cs === 1,
   'setup: origin B wrote the same markers', JSON.stringify(wroteB));
ok(after('clear-map-err=') === 'none',
   'chrome.browsingData accepts an origin-filtered clear that includes `cache`',
   'err=' + after('clear-map-err=') + ' -- then MAP_CLEAR_STORAGE_ONLY is the path that runs');

console.log('\n   ── the cleared origin ──');
ok(readA.ls === null, 'localStorage on the cleared origin is gone', 'ls=' + readA.ls);
ok(readA.idb === null, 'indexedDB on the cleared origin is gone', 'idb=' + readA.idb);
ok(readA.cs === null, 'cacheStorage on the cleared origin is gone', 'cs=' + readA.cs + ' keys=' + readA.keys);
ok(readA.ck === null, 'the cookie on the cleared origin is gone', 'ck=' + readA.ck);
ok((hits[PORT_A]['/c.txt'] || 0) >= 2,
   'the HTTP cache for the cleared origin is gone -- the server saw a second request for a ' +
   'max-age=600 resource', 'hits=' + (hits[PORT_A]['/c.txt'] || 0));
//  The headline. This is a fact about Chromium, not about our code: the API has
//  no sessionStorage bucket, so a page that caches a position there keeps it
//  through every clear the extension can ask for -- and sessionStorage survives
//  a same-tab navigation, which is exactly what the repin is.
ok(readA.ss === STAMP,
   'MEASURED: sessionStorage SURVIVES the clear on the very origin that was cleared -- ' +
   'chrome.browsingData has no bucket for it', 'ss=' + readA.ss);

console.log('\n   ── the other origin, which was never named ──');
ok(readB.ls === STAMP, 'origin B keeps its localStorage', 'ls=' + readB.ls);
ok(readB.idb === STAMP, 'origin B keeps its indexedDB', 'idb=' + readB.idb);
ok(readB.cs === STAMP, 'origin B keeps its cacheStorage', 'cs=' + readB.cs);
ok(readB.ck === STAMP, 'origin B keeps its cookie -- a different host is out of reach', 'ck=' + readB.ck);
ok((hits[PORT_B]['/c.txt'] || 0) === 1,
   'origin B keeps its HTTP cache: the server saw exactly ONE request for the cacheable file, ' +
   'so an origin-filtered `cache: true` did NOT empty the whole browser cache',
   'hits=' + (hits[PORT_B]['/c.txt'] || 0) + ' -- if this is 2, `cache` ignores `origins` and ' +
   'MAP_CLEAR must drop it');
ok(after('after-clear cookie sameHostOtherPort=') === 'null',
   'MEASURED: a cookie on the SAME host at another port goes too -- cookies ignore the port, ' +
   'which is why cookie clearing is restricted to map-only hosts',
   'value=' + after('after-clear cookie sameHostOtherPort='));

console.log('\n   ── history ──');
ok(after('after-clear history ') === 'map=true other=true',
   'the storage/cache clear takes NO history at all', after('after-clear history '));
const sweep = after('after-sweep ') || '';
ok(/ map=false /.test(sweep), 'the keyword sweep deletes the map row', sweep);
ok(/ other=true$/.test(sweep), 'and leaves a non-map row that the same search returned', sweep);

console.log('\n' + pass + '/' + (pass + fail) + ' checks passed');
rep.stop();
try { sa.close(); sb.close(); } catch (e) {}
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
process.exit(fail ? 1 : 0);
})().catch(e => { console.log('ABORT: ' + e.stack); process.exit(3); });
