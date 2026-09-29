'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/probe-d1-replay.js -- how many rows does chrome://extensions draw
//  for the records the user's Chrome actually holds?
//
//  Chrome 142 ignores --load-extension (measured in probe-d1-unpacked-row.js:
//  zero non-component records after four runs), so an unpacked install cannot be
//  synthesised from the command line. Instead this COPIES the user's closed
//  Chrome profile into os.tmpdir() and launches Chrome against the copy.
//
//  Secure Preferences' MACs are keyed on a hard-coded seed plus the machine id
//  (rlz_lib::GetMachineId -- machine SID + drive serial), NOT the profile
//  directory, so a copy on the same machine keeps valid MACs and Chromium loads
//  the records instead of resetting them. If that assumption is wrong the run
//  shows it: the copied records would be gone from the copy's prefs afterwards.
//
//  READ ONLY with respect to the user's profile: it is only ever the source of a
//  copy. Every write lands under os.tmpdir().
// ════════════════════════════════════════════════════════════════════
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execSync } = require('child_process');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const SRC = path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'User Data');
const PORT = 9333;

const TMP = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'd1replay-')));
const UD = path.join(TMP, 'ud');

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

console.log('copying the CLOSED profile into ' + UD);
fs.mkdirSync(path.join(UD, 'Default'), { recursive: true });
for (const f of ['Local State']) fs.copyFileSync(path.join(SRC, f), path.join(UD, f));
for (const f of ['Preferences', 'Secure Preferences'])
    try { fs.copyFileSync(path.join(SRC, 'Default', f), path.join(UD, 'Default', f)); } catch (e) {}
for (const d of ['Extensions', 'Local Extension Settings', 'Extension State',
                 'Extension Rules', 'Extension Scripts'])
    try { copyTree(path.join(SRC, 'Default', d), path.join(UD, 'Default', d)); } catch (e) {}

const before = JSON.parse(fs.readFileSync(path.join(UD, 'Default', 'Secure Preferences'), 'utf8'));
console.log('records copied in: ' +
    Object.keys((before.extensions || {}).settings || {}).length);

const get = url => new Promise((res, rej) => {
    http.get(url, r => { let b = ''; r.on('data', c => b += c); r.on('end', () => res(b)); })
        .on('error', rej);
});
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
    const child = spawn(CHROME, [
        '--user-data-dir=' + UD, '--no-first-run', '--no-default-browser-check',
        '--disable-background-networking', '--remote-debugging-port=' + PORT,
        '--remote-allow-origins=*', 'chrome://extensions',
    ], { detached: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', d => stderr += d);

    let ver = null;
    for (let i = 0; i < 60; i++) {
        await sleep(500);
        try { ver = JSON.parse(await get(`http://127.0.0.1:${PORT}/json/version`)); break; }
        catch (e) {}
    }
    if (!ver) { console.log('DevTools never came up'); child.kill(); return; }
    console.log('\nBrowser: ' + ver.Browser);
    await sleep(6000);   //  let every extension finish loading

    const targets = JSON.parse(await get(`http://127.0.0.1:${PORT}/json/list`));
    console.log('\n══ targets (a live service worker == an extension that LOADED) ══');
    for (const t of targets)
        console.log(`   ${t.type.padEnd(15)} ${String(t.title).slice(0, 45).padEnd(46)} ${t.url.slice(0, 70)}`);

    //  chrome://extensions keeps its list in a Polymer property; read it directly.
    const page = targets.find(t => t.type === 'page' && /chrome:\/\/extensions/.test(t.url));
    if (page) {
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        const done = new Promise(resolve => {
            ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: {
                expression: `JSON.stringify((document.querySelector('extensions-manager')
                    ? [...document.querySelector('extensions-manager').extensions_]
                        .map(e => ({id:e.id,name:e.name,state:e.state,loc:e.location,
                                    path:e.path||'',errs:(e.manifestErrors||[]).length}))
                    : 'no extensions-manager'))`,
                returnByValue: true, awaitPromise: true } }));
            ws.onmessage = m => { resolve(JSON.parse(m.data)); ws.close(); };
            ws.onerror = e => resolve({ error: String(e.message || e) });
        });
        const r = await Promise.race([done, sleep(15000).then(() => ({ timeout: true }))]);
        console.log('\n══ chrome://extensions rows, as the page itself sees them ══');
        const v = r && r.result && r.result.result && r.result.result.value;
        if (typeof v === 'string' && v.startsWith('[')) {
            const rows = JSON.parse(v);
            console.log('   TOTAL ROWS: ' + rows.length);
            for (const e of rows) {
                const mine = FREEPROXY.includes(e.id) || /freeproxy/i.test(e.name);
                console.log(`   ${mine ? '>>>' : '   '} ${e.id}  ${String(e.state).padEnd(8)} ` +
                            `${String(e.loc).padEnd(22)} "${e.name}"  ${e.path}`);
            }
            const mine = rows.filter(e => FREEPROXY.includes(e.id) || /freeproxy/i.test(e.name));
            console.log(`\n   FREEPROXY ROWS: ${mine.length}  -> ${mine.map(m => m.id).join(', ')}`);
        } else {
            console.log('   ' + JSON.stringify(r).slice(0, 900));
        }
    } else {
        console.log('\n   no chrome://extensions page target');
    }

    try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch (e) {}
    await sleep(2500);

    console.log('\n══ what the run did to the stale records in the COPY ══');
    let after = {};
    try { after = JSON.parse(fs.readFileSync(path.join(UD, 'Default', 'Secure Preferences'), 'utf8')); }
    catch (e) { console.log('   unreadable: ' + e.code); }
    const a = ((after.extensions || {}).settings) || {};
    const b = ((before.extensions || {}).settings) || {};
    for (const id of FREEPROXY) {
        const bb = b[id], aa = a[id];
        console.log(`   ${id}`);
        console.log(`      before: ${bb ? `loc ${bb.location} keys ${Object.keys(bb).length}` : 'ABSENT'}`);
        console.log(`      after : ${aa ? `loc ${aa.location} keys ${Object.keys(aa).length}` : 'ABSENT'}`);
    }
    console.log(`   total records before ${Object.keys(b).length}  after ${Object.keys(a).length}`);
    for (const l of stderr.split(/\r?\n/))
        if (/extension|manifest|load/i.test(l) && l.trim()) console.log('   stderr: ' + l.trim());
    console.log('\ntmp: ' + TMP);
})();
