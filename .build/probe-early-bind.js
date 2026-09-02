'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/probe-early-bind.js  --  does the delivery port really come up before
//  anything Electron-shaped has happened, and does serveUntilDelivered() adopt
//  that same listener instead of opening a second one?
//
//  The measurement this is answering (2026-09-01, schtasks last-run + the app's
//  own log): the logon task's action started at 21:37:27 and app.whenReady() did
//  not fire until 21:38:09.5. Forty-two and a half seconds with the port every
//  browser policy names dead -- which is the whole of problem 2, because a
//  browser reads its external-extensions provider ONCE per start.
//
//  serveEarly() moves the bind to module scope, so it must hold under exactly
//  the conditions module scope has: no Logger (init runs inside whenReady), no
//  app, and no await on the caller's part. Everything below runs in a throwaway
//  state dir on a throwaway port; nothing touches the real bundle, the real
//  port, or any browser.
// ════════════════════════════════════════════════════════════════════
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');

const deliver = require('../lib/ext-deliver');

let pass = 0, fail = 0;
const ok = (cond, what) => {
    if (cond) { pass++; console.log('  ok   ' + what); }
    else { fail++; console.log('  FAIL ' + what); }
};

const freePort = () => new Promise(res => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});

const get = (port, route) => new Promise(res => {
    const req = http.get({ host: '127.0.0.1', port, path: route, timeout: 4000 }, r => {
        const chunks = [];
        r.on('data', c => chunks.push(c));
        r.on('end', () => res({ status: r.statusCode, headers: r.headers,
                                body: Buffer.concat(chunks) }));
    });
    req.on('error', e => res({ status: 0, err: e.code || e.message, body: Buffer.alloc(0) }));
    req.on('timeout', () => { req.destroy(); res({ status: 0, err: 'timeout', body: Buffer.alloc(0) }); });
});

(async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-early-'));
    const port = await freePort();
    const XML = '<?xml version="1.0" encoding="UTF-8"?><gupdate protocol="2.0"/>';
    const CRX = Buffer.from('Cr24' + 'x'.repeat(4096), 'binary');

    deliver.writeBundle({ stateDir, id: 'aaaabbbbccccddddeeeeffffgggghhhh',
                          version: '9.9.9.9', port, crx: CRX, xml: XML });
    ok(!!deliver.readBundle(stateDir), 'a throwaway bundle is on disk for the probe to serve');

    console.log('\n── 1. the bind itself, with no logger and nothing awaited ──');
    deliver._resetEarly();
    const t0 = Date.now();
    //  Exactly what main.js does at module scope: call it, do not await it, and
    //  pass no log -- Logger.init() has not run at that point in a real process.
    const early = deliver.serveEarly({ stateDir });
    ok(!!early && typeof early.promise.then === 'function',
       'serveEarly returns immediately with a handle -- module scope is never blocked');
    ok(deliver.earlyServer() === early, 'the handle is retrievable afterwards');
    ok(deliver.serveEarly({ stateDir }) === early,
       'and a second call is the same handle, not a second listener');

    const bound = await early.promise;
    const ms = Date.now() - t0;
    ok(bound === port, `it bound the port the bundle names (${bound}) and not a spare`);
    ok(ms < 1500, `and it took ${ms} ms -- against the 42500 ms of Electron start it replaces`);

    console.log('\n── 2. a browser fetching in that window is really served ──');
    const xml = await get(port, '/updates.xml');
    ok(xml.status === 200, 'GET /updates.xml answers 200 before any Electron API has been touched');
    ok(xml.body.toString('utf8') === XML, 'and the bytes are the manifest on disk, unchanged');
    ok(String(xml.headers['content-type'] || '').includes('text/xml'),
       'served as text/xml, which is what Chromium parses it as');
    const crx = await get(port, '/freeproxy-geo.crx');
    ok(crx.status === 200 && crx.body.equals(CRX), 'and the CRX comes back byte-for-byte');
    ok(String(crx.headers['content-type'] || '') === 'application/x-chrome-extension',
       'with the content type a Chromium external install requires');
    const nope = await get(port, '/anything-else');
    ok(nope.status === 404, 'nothing else is served: this is a two-file host, not a web server');

    console.log('\n── 3. the log lines it could not write are not lost ──');
    ok(early.buffered.length > 0, 'the bind buffered its own log lines instead of dropping them');
    const seen = [];
    const log = {};
    for (const lvl of ['debug', 'info', 'warn', 'error', 'success'])
        log[lvl] = (m, meta) => seen.push([lvl, String(m)]);

    //  serveUntilDelivered with a cap short enough to finish: the bundle's id is
    //  not in any profile, so `need` is non-empty and it goes into the serving
    //  wait -- which is the path a real logon takes.
    const r = await deliver.serveUntilDelivered({ stateDir, log, capMs: 1200, pollMs: 300 });

    ok(seen.some(([, m]) => /bound at module scope/.test(m)),
       'serveUntilDelivered replayed them, so the log still records when the port went up');
    ok(seen.some(([, m]) => /Serving aaaabbbb/.test(m)),
       'including the "Serving <id> on 127.0.0.1:<port>" line itself');
    ok(early.buffered.length === 0, 'and the buffer is emptied, so a second replay cannot double them');

    console.log('\n── 4. it adopted the listener rather than opening a second one ──');
    ok(!seen.some(([, m]) => /not available|EADDRINUSE/i.test(m)),
       'no "port is not available" -- adoption, not a collision with itself');
    ok(!seen.some(([, m]) => /came free after/.test(m)),
       'and it never entered the wait-for-the-port grace path');
    ok(r && r.ok === true && r.why === 'timed-out',
       `it ran the serving path to its cap and reported "${r && r.why}"`);
    ok(Array.isArray(r.missing) && r.missing.length > 0,
       'with the browsers that still lack this throwaway id named, as before');

    console.log('\n── 5. the port is released when the helper is done ──');
    const after = await get(port, '/updates.xml');
    ok(after.status === 0, `nothing answers ${port} once it exits (${after.err})`);

    console.log('\n── 6. a port already held lands on the old grace path, unchanged ──');
    deliver._resetEarly();
    const squatter = http.createServer((q, s) => s.writeHead(200).end('not ours'));
    await new Promise(res => squatter.listen(port, '127.0.0.1', res));
    const e2 = deliver.serveEarly({ stateDir });
    ok((await e2.promise) === null, 'serveEarly resolves null rather than throwing when the port is taken');
    ok(e2.d.port === null, 'and holds no listener, so the grace loop can still take over later');
    squatter.close();
    deliver._resetEarly();

    try { fs.rmSync(stateDir, { recursive: true, force: true }); } catch (e) {}
    console.log(`\n${pass}/${pass + fail} checks passed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error('probe threw: ' + e.stack); process.exit(1); });
