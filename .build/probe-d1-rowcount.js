'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/probe-d1-rowcount.js -- read chrome://extensions' OWN row list.
//
//  probe-d1-replay.js proved the copied profile loads (37 records in, 37 out,
//  service workers started), but a DISABLED extension has a row and no worker,
//  so worker presence undercounts rows. This drives CDP properly: browser
//  target -> Target.createTarget(chrome://extensions) -> Runtime.evaluate on the
//  page, and reads extensions-manager's own list.
//
//  Reuses the profile copy made by probe-d1-replay.js if it is still there,
//  otherwise makes a fresh one. Never writes to the user's profile.
// ════════════════════════════════════════════════════════════════════
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execSync } = require('child_process');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const SRC = path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'User Data');
const PORT = 9334;
const FREEPROXY = ['hboapnnjhpdnnoimmfbocllmnoakeobf', 'egclniilmgnaildaaiccpmakehnhledg',
                   'imlmcdmjclmlkhgljdokgjepcppgjfob', 'aoadoifmonclfkfmabohfhbigmioaanp',
                   'bmdkiblidpidilbeebghppkifmdhheog'];

function copyTree(src, dst) {
    fs.mkdirSync(dst, { recursive: true });
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
        const s = path.join(src, e.name), d = path.join(dst, e.name);
        try { if (e.isDirectory()) copyTree(s, d); else fs.copyFileSync(s, d); } catch (err) {}
    }
}

let UD = process.argv[2];
if (!UD || !fs.existsSync(UD)) {
    const TMP = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'd1rc-')));
    UD = path.join(TMP, 'ud');
    fs.mkdirSync(path.join(UD, 'Default'), { recursive: true });
    fs.copyFileSync(path.join(SRC, 'Local State'), path.join(UD, 'Local State'));
    for (const f of ['Preferences', 'Secure Preferences'])
        try { fs.copyFileSync(path.join(SRC, 'Default', f), path.join(UD, 'Default', f)); } catch (e) {}
    for (const d of ['Extensions', 'Local Extension Settings', 'Extension State',
                     'Extension Rules', 'Extension Scripts'])
        try { copyTree(path.join(SRC, 'Default', d), path.join(UD, 'Default', d)); } catch (e) {}
}
console.log('profile copy: ' + UD);

const get = url => new Promise((res, rej) => {
    http.get(url, r => { let b = ''; r.on('data', c => b += c); r.on('end', () => res(b)); }).on('error', rej);
});
const sleep = ms => new Promise(r => setTimeout(r, ms));

//  minimal CDP client over the browser endpoint
function cdp(wsUrl) {
    const ws = new WebSocket(wsUrl);
    let next = 1; const waiting = new Map();
    const ready = new Promise((res, rej) => { ws.onopen = res; ws.onerror = e => rej(new Error(String(e.message || e))); });
    ws.onmessage = m => {
        const j = JSON.parse(m.data);
        if (j.id && waiting.has(j.id)) { waiting.get(j.id)(j); waiting.delete(j.id); }
    };
    const send = (method, params, sessionId) => new Promise((res, rej) => {
        const id = next++;
        waiting.set(id, j => j.error ? rej(new Error(method + ': ' + JSON.stringify(j.error))) : res(j.result));
        ws.send(JSON.stringify({ id, method, params: params || {}, sessionId }));
        setTimeout(() => { if (waiting.has(id)) { waiting.delete(id); rej(new Error(method + ' timed out')); } }, 25000);
    });
    return { ready, send, close: () => ws.close() };
}

(async () => {
    const child = spawn(CHROME, [
        '--user-data-dir=' + UD, '--no-first-run', '--no-default-browser-check',
        '--disable-background-networking', '--remote-debugging-port=' + PORT,
        '--remote-allow-origins=*', 'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = ''; child.stderr.on('data', d => stderr += d);

    let ver = null;
    for (let i = 0; i < 60; i++) {
        await sleep(500);
        try { ver = JSON.parse(await get(`http://127.0.0.1:${PORT}/json/version`)); break; } catch (e) {}
    }
    if (!ver) { console.log('DevTools never came up'); child.kill(); return; }
    console.log('Browser: ' + ver.Browser);
    await sleep(7000);

    const c = cdp(ver.webSocketDebuggerUrl);
    await c.ready;
    const { targetId } = await c.send('Target.createTarget', { url: 'chrome://extensions' });
    await sleep(4000);
    const { sessionId } = await c.send('Target.attachToTarget', { targetId, flatten: true });
    await c.send('Runtime.enable', {}, sessionId);

    const expr = `(() => {
        const m = document.querySelector('extensions-manager');
        if (!m) return 'NO extensions-manager';
        const all = [...(m.extensions_ || [])];
        return JSON.stringify(all.map(e => ({
            id: e.id, name: e.name, state: e.state, loc: e.location,
            path: e.path || '', prettyPath: e.prettifiedPath || '',
            disableReasons: e.disableReasons || null,
            mustRemainInstalled: e.mustRemainInstalled,
        })));
    })()`;
    const r = await c.send('Runtime.evaluate',
        { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
    const v = r && r.result && r.result.value;

    console.log('\n══ chrome://extensions rows, read from extensions-manager itself ══');
    if (typeof v === 'string' && v.startsWith('[')) {
        const rows = JSON.parse(v);
        console.log('   TOTAL ROWS: ' + rows.length);
        for (const e of rows) {
            const mine = FREEPROXY.includes(e.id) || /freeproxy/i.test(e.name);
            console.log(`   ${mine ? '>>>' : '   '} ${e.id}  ${String(e.state).padEnd(9)} ` +
                        `${String(e.loc).padEnd(24)} "${e.name}"  ${e.prettyPath || e.path}`);
        }
        const mine = rows.filter(e => FREEPROXY.includes(e.id) || /freeproxy/i.test(e.name));
        console.log(`\n   >>> FREEPROXY ROWS: ${mine.length}`);
        for (const m of mine) console.log(`       ${m.id}  ${m.name}  ${m.loc}  ${m.prettyPath || m.path}`);
        console.log('\n   stale ids NOT drawn: ' +
            FREEPROXY.filter(id => !rows.some(r2 => r2.id === id)).join(', '));
    } else {
        console.log('   ' + JSON.stringify(r).slice(0, 1200));
    }

    try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch (e) {}
    for (const l of stderr.split(/\r?\n/))
        if (/manifest|load error|Failed to load/i.test(l) && l.trim()) console.log('   stderr: ' + l.trim());
    process.exit(0);
})().catch(e => { console.log('FAILED: ' + e.message); process.exit(1); });
