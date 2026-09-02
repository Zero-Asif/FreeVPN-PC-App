'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/probe.js  --  shared harness for "did the page actually get the
//  spoofed coordinates?"
//
//  Served over http://127.0.0.1, which browsers treat as a secure context, so
//  the Geolocation API is available without a certificate. The page reports
//  what it received back to this server, which makes the result a fact rather
//  than an inference from log lines.
//
//  With no extension loaded a headless browser auto-denies the permission
//  prompt, so a control run reports err=1 -- which is what makes a positive
//  result meaningful.
// ════════════════════════════════════════════════════════════════════
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const { execSync, spawn } = require('child_process');

const sh = c => { try { return execSync(c, { windowsHide: true, encoding: 'utf8', stdio: 'pipe' }); } catch (e) { return null; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const PAGE = `<!doctype html><meta charset=utf-8><title>probe</title><body>probe
<script>
function send(q){ try{ fetch('/r?'+q); }catch(e){ new Image().src='/r?'+q; } }
try {
  if (!navigator.geolocation) { send('no-api'); }
  else navigator.geolocation.getCurrentPosition(
    function(p){ send('ok=' + p.coords.latitude.toFixed(4) + ',' + p.coords.longitude.toFixed(4)
                      + '&acc=' + Math.round(p.coords.accuracy)); },
    function(e){ send('err=' + e.code + '&msg=' + encodeURIComponent(e.message||'')); },
    { timeout: 25000, enableHighAccuracy: true });
} catch(e) { send('throw=' + encodeURIComponent(String(e))); }
try {
  navigator.permissions.query({name:'geolocation'})
    .then(function(s){ send('perm=' + s.state); }, function(){ send('perm=throw'); });
} catch(e){}
</script>`;

//  Which browsers exist, where, and which policy namespace each one reads:
//  from lib/browsers.js, the same table the app itself detects with. A probe
//  result could otherwise disagree with what the app reports about the very
//  same machine, and then neither number means anything.
//
//  Only forks with a verified executable are listed. `exe` stays an ARRAY --
//  the callers iterate it looking for the first one that exists -- with the
//  path detection actually resolved at the front.
const browsersTable = require('../lib/browsers');
const BROWSERS = browsersTable.detectChromium().map(b => ({
    id:     b.id,
    name:   b.name,
    policy: b.policy ? 'HKLM\\' + b.policy : null,
    exe:    [...new Set([b.exePath,
                         ...(b.exePaths || []).map(browsersTable.expand)].filter(Boolean))],
}));

/** Stage Extension/ unpacked, with a generated seed, into `dir`. */
function stageExtension(root, dir, seed, version) {
    fs.mkdirSync(dir, { recursive: true });
    for (const f of fs.readdirSync(path.join(root, 'Extension'))) {
        fs.copyFileSync(path.join(root, 'Extension', f), path.join(dir, f));
    }
    fs.writeFileSync(path.join(dir, 'geo-seed.js'),
        'Object.defineProperty(window,"__FP_GEO_SEED",{value:' + JSON.stringify(seed) +
        ',configurable:true,enumerable:false,writable:true});\n', 'utf8');
    const mf = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    if (version) mf.version = version;
    mf.content_scripts[0].js = ['geo-seed.js', 'geo-spoof.js'];
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(mf, null, 2), 'utf8');
    return dir;
}

class Probe {
    constructor(port, hosts) {
        this.port = port || 8099;
        //  Both loopback families by default. Chrome resolves "localhost" to
        //  ::1 first on Windows, so a server bound only to 127.0.0.1 makes a
        //  localhost URL look refused -- which would read as "the browser
        //  rejected the policy" when it never got that far.
        this.hosts = hosts || ['127.0.0.1', '::1'];
        this.reports = [];
        this.hits = [];
        this.extra = new Map();      // route -> {body, type} for callers to add
        this.servers = [];
    }
    serve(route, body, type) { this.extra.set(route, { body: Buffer.from(body), type }); }
    start() {
        const handler = (req, res) => {
            const u = req.url || '';
            const route = u.split('?')[0];
            this.hits.push(route);
            if (route === '/r') {
                this.reports.push(decodeURIComponent(u.slice(u.indexOf('?') + 1)));
                res.writeHead(204, { 'Access-Control-Allow-Origin': '*' }).end();
                return;
            }
            if (route === '/probe.html') {
                const b = Buffer.from(PAGE, 'utf8');
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8',
                                     'Content-Length': b.length, 'Cache-Control': 'no-store' });
                res.end(req.method === 'HEAD' ? undefined : b);
                return;
            }
            const e = this.extra.get(route);
            if (e) {
                res.writeHead(200, { 'Content-Type': e.type, 'Content-Length': e.body.length,
                                     'Cache-Control': 'no-store' });
                res.end(req.method === 'HEAD' ? undefined : e.body);
                return;
            }
            res.writeHead(404).end();
        };
        return Promise.all(this.hosts.map(h => new Promise(res => {
            const s = http.createServer(handler);
            s.on('clientError', (err, sock) => { try { sock.destroy(); } catch (e) {} });
            //  A family that is not configured must not sink the whole test.
            s.once('error', () => res(null));
            s.listen(this.port, h, () => { this.servers.push(s); res(h); });
        }))).then(r => r.filter(Boolean));
    }
    url(host) { return `http://${host || '127.0.0.1'}:${this.port}/probe.html`; }
    stop() { for (const s of this.servers) { try { s.close(); } catch (e) {} } this.servers = []; }

    /**
     * Launch one browser once. Returns { pos, perm, reports, hits, log }.
     * @param {object} o {exe, tmp, label, args, headless, waitSec, until}
     */
    async run(o) {
        this.reports = [];
        this.hits = [];
        const tag = o.label.replace(/[^\w]+/g, '_') + (o.headless ? '-h' : '-w');
        const udd = path.join(o.tmp, 'udd-' + tag);
        const logFile = path.join(o.tmp, tag + '.log');
        const out = fs.openSync(logFile, 'w');
        const args = [
            `--user-data-dir=${udd}`, '--no-first-run', '--no-default-browser-check',
            '--disable-sync', '--enable-logging=stderr', '--log-level=0',
        ].concat(o.args || []);
        args.push(o.headless ? '--headless=new' : '--window-size=520,400');
        args.push(o.url || this.url());

        const child = spawn(o.exe, args, { stdio: ['ignore', out, out], windowsHide: true });
        const done = o.until || (() => this.reports.some(r => /^(ok|err|no-api|throw)/.test(r)));
        for (let i = 0; i < (o.waitSec || 30); i++) { await sleep(1000); if (done()) break; }
        try { child.kill(); } catch (e) {}
        await sleep(800);
        sh(`taskkill /F /PID ${child.pid} 2>nul`);
        try { fs.closeSync(out); } catch (e) {}

        let log = '';
        try { log = fs.readFileSync(logFile, 'utf8'); } catch (e) {}
        //  --enable-logging=stderr is not always honoured when stderr is a
        //  redirected handle: some runs put everything in the profile's own
        //  chrome_debug.log instead and the redirect file comes back empty.
        //  MEASURED on Brave: a failing run of test-geo-purge.js reported "the
        //  extension printed nothing at all" while the switch demonstrably
        //  reached the page -- i.e. the capture was missing, not the extension.
        //  Both are read now, because which one gets written is not ours to
        //  choose and a diagnostic that is absent exactly when a test fails is
        //  worse than none.
        try {
            const alt = fs.readFileSync(path.join(udd, 'chrome_debug.log'), 'utf8');
            if (alt && !log.includes(alt.slice(0, 200))) log += (log ? '\n' : '') + alt;
        } catch (e) {}
        return {
            pos: this.reports.find(r => r.startsWith('ok=')) || this.reports.find(r => r.startsWith('err=')) || null,
            perm: this.reports.find(r => r.startsWith('perm=')) || null,
            reports: this.reports.slice(),
            hits: this.hits.slice(),
            log,
        };
    }
}

module.exports = { Probe, BROWSERS, stageExtension, sh, sleep };
