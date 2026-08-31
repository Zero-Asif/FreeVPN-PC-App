'use strict';
// ════════════════════════════════════════════════════════════════════
//  lib/ext-deliver.js  --  make the extension reachable when a browser
//  actually asks for it
//
//  WHAT WAS MEASURED, and it is the whole reason this file exists.
//
//  All four routes were written correctly and no browser had the extension.
//  .build/probe-deliver.js served the real payload on the port the live
//  registry already names, launched Edge, Chrome and Brave into throwaway
//  profiles, and every one of them fetched /updates.xml and the 838 KB CRX
//  within FIVE SECONDS of starting, then unpacked it into its own profile:
//
//      Edge    location 7 (EXTERNAL_POLICY_DOWNLOAD)  disable_reasons []
//      Chrome  location 6 (EXTERNAL_PREF_DOWNLOAD)    disable_reasons [8192]
//      Brave   location 6                             disable_reasons [8192]
//
//  So the routes work. What did not work is TIMING: lib/ext-host.js answers
//  that port only while the app -- or a setup/boot task -- is running, and all
//  three of those had exited. A browser started afterwards asked a dead port
//  and installed nothing, which from the outside looks exactly like a policy
//  that was never written.
//
//  The fix is not another route. It is a payload ON DISK plus something small
//  that serves it at the one moment browsers start: logon.
//
//    * writeBundle()  puts freeproxy-geo.crx, updates.xml and delivery.json
//      next to the staged extension, from the elevated run that packed them.
//      No key is needed to serve those two files, so the helper needs no
//      elevation and never touches the signing key.
//    * Deliverer      serves exactly those two files from disk, per request,
//      on the port delivery.json records -- the same port the policies name.
//      It re-reads on change, so an app that repacks a newer version is served
//      by an already-running helper without either of them being restarted.
//    * serveUntilDelivered()  keeps serving only while some installed browser
//      still lacks the extension, and exits the moment they all have it.
//
//  It spoofs nothing, reads no browser profile it does not own, holds no
//  policy and opens no port but 127.0.0.1. The extension is still inert
//  without the app -- it talks to the app over a WebSocket and does nothing
//  until the app answers -- so "it only works while the app runs" stays true.
// ════════════════════════════════════════════════════════════════════

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const http = require('http');
const { execSync } = require('child_process');

const browsers = require('./browsers');

const DELIVER_TASK = 'FreeProxy VPN Extension Delivery';
const MANIFEST_PATH = '/updates.xml';
const CRX_PATH      = '/freeproxy-geo.crx';

//  Long enough that a browser opened after lunch is still served, short
//  enough that nothing of ours is left running overnight for no reason. The
//  task's own ExecutionTimeLimit is PT4H, so this stays under it and exits on
//  its own terms rather than being hard-terminated.
const CAP_MS  = 3.5 * 3600 * 1000;
const POLL_MS = 15000;

//  How long a busy port is treated as a queue rather than a refusal. Sized off
//  the measurement it exists for: the boot pass holds 8081 for about half a
//  minute, an elevated app start for as long as the app takes to get going, and
//  two minutes covers both with room to spare. Past it, whatever is on that
//  port is not something of ours that is about to finish -- see the comment in
//  serveUntilDelivered().
const PORT_GRACE_MS = 120000;

function sh(cmd) {
    return execSync(cmd, { windowsHide: true, encoding: 'utf8', stdio: 'pipe' });
}
function shq(cmd) { try { sh(cmd); return true; } catch (e) { return false; } }

/** Where the served files live -- beside the staged extension, never inside it. */
function bundlePaths(stateDir) {
    const dir = path.join(stateDir, 'browser-setup');
    return { dir,
             crx:  path.join(dir, 'freeproxy-geo.crx'),
             xml:  path.join(dir, 'updates.xml'),
             meta: path.join(dir, 'delivery.json') };
}

/**
 * Write the two files a browser fetches, plus what is needed to serve them.
 *
 * Called from the run that PACKED the extension -- which is elevated, because
 * ProgramData\freeproxy-vpn\browser-setup is Users:(RX) by design. The helper
 * that serves these files later needs no elevation and no key: everything
 * secret stayed in the run that wrote them.
 *
 * Written through a temporary file and renamed, because the helper may be
 * serving the old bytes at this very moment and a half-written CRX is a
 * corrupt install in every browser that fetches it.
 *
 * @param {object} o
 * @param {string} o.stateDir
 * @param {string} o.id
 * @param {string} o.version
 * @param {number} o.port      the port the policies name
 * @param {Buffer} o.crx
 * @param {string} o.xml
 * @param {object} [o.log]
 * @returns {object|null} the meta that was written, or null on failure
 */
function writeBundle({ stateDir, id, version, port, crx, xml, log }) {
    const p = bundlePaths(stateDir);
    const meta = { at: Date.now(), id, version, port,
                   url: `http://127.0.0.1:${port}${MANIFEST_PATH}`,
                   crx: CRX_PATH, manifest: MANIFEST_PATH };
    try {
        fs.mkdirSync(p.dir, { recursive: true });
        const put = (file, data) => {
            const tmp = file + '.tmp';
            fs.writeFileSync(tmp, data);
            fs.renameSync(tmp, file);
        };
        //  Only on a real change: an unpacked extension the user loaded by hand
        //  is watched by the browser, and rewriting identical bytes on every
        //  connect makes it reload for nothing.
        let same = false;
        try { same = fs.readFileSync(p.crx).equals(crx); } catch (e) {}
        if (!same) put(p.crx, crx);
        put(p.xml, Buffer.from(xml, 'utf8'));
        put(p.meta, Buffer.from(JSON.stringify(meta, null, 2), 'utf8'));
        return meta;
    } catch (e) {
        if (log) log.warn('Could not write the extension delivery bundle -- a browser ' +
                          'started while the app is closed will not be served', { err: e.message });
        return null;
    }
}

/** What the last elevated run recorded, or null. */
function readBundle(stateDir) {
    try { return JSON.parse(fs.readFileSync(bundlePaths(stateDir).meta, 'utf8')); }
    catch (e) { return null; }
}

/**
 * Is something already serving OUR manifest on that port?
 *
 * Two things need this. The app, so it does not open a second listener and
 * shift the port every policy on the machine names; and the helper, so a second
 * logon session exits instead of fighting the first one for the port.
 *
 * The test is the id inside the manifest, not merely "something answered":
 * 127.0.0.1:8081 belongs to whoever got there first, and handing a browser
 * someone else's update manifest is not a thing this app will do.
 */
function probeOurs(port, id, timeoutMs = 1500) {
    return new Promise(resolve => {
        const req = http.get({ host: '127.0.0.1', port, path: MANIFEST_PATH,
                               timeout: timeoutMs }, res => {
            if (res.statusCode !== 200) { res.resume(); return resolve(false); }
            let body = '';
            res.setEncoding('utf8');
            res.on('data', d => { body += d; if (body.length > 8192) req.destroy(); });
            res.on('end', () => resolve(body.includes(`appid='${id}'`) ||
                                        body.includes(`appid="${id}"`)));
        });
        req.on('timeout', () => { req.destroy(); resolve(false); });
        req.on('error', () => resolve(false));
    });
}

/**
 * WHICH browser just fetched something? Named, or honestly not named.
 *
 * "Extension package handed to a browser" was unattributable, and an
 * unattributable log line is the same problem as an unverified claim: after the
 * fact there is no way to tell whether Chrome took it, or Edge took it twice.
 *
 * Two sources, in order of cost:
 *
 *   1. User-Agent. Chromium's extension downloader sends the browser's normal
 *      UA, so `Edg/` separates Edge and `OPR/`, `YaBrowser`, `Vivaldi` separate
 *      those. It does NOT separate Chrome from Brave -- Brave ships Chrome's UA
 *      deliberately, as a fingerprinting defence -- so UA alone is not enough
 *      on the machine this was built for.
 *   2. The socket's own owner. The browser connected FROM an ephemeral port TO
 *      ours, so exactly one netstat row has that pair, and its PID is the
 *      process that asked. tasklist turns the PID into an image name, and
 *      lib/browsers.js already knows which browser owns which image.
 *
 * Runs after res.end(), so it never delays a fetch, and every failure falls
 * back to the vague wording rather than to a guess. Both lookups are cached:
 * a browser re-checks the manifest on its own schedule and there is no reason
 * to spawn netstat again for a socket already identified.
 */
const _portOwner = new Map();   //  "<remotePort>:<localPort>" -> label|null
const _imageOf   = new Map();   //  pid -> image name|null

function imageOfPid(pid) {
    if (_imageOf.has(pid)) return _imageOf.get(pid);
    let image = null;
    try {
        //  CSV + /NH so the first field is the image name and nothing has to be
        //  guessed from column alignment in the operator's own language.
        const row = sh(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`).trim();
        const m = /^"([^"]+)"/.exec(row);
        if (m) image = m[1].toLowerCase();
    } catch (e) { /* the process may have exited already */ }
    _imageOf.set(pid, image);
    return image;
}

function pidOfConnection(remotePort, localPort) {
    let out = '';
    try { out = sh('netstat -ano -p TCP'); } catch (e) { return null; }
    //  TCP  127.0.0.1:54321  127.0.0.1:8081  ESTABLISHED  1234
    //  The browser's row is the one whose LOCAL side is its ephemeral port and
    //  whose FOREIGN side is ours; our own listener's row is the mirror image,
    //  which is why both ports have to match rather than just one.
    const re = new RegExp(
        `^\\s*TCP\\s+\\S+:${remotePort}\\s+\\S+:${localPort}\\s+\\S+\\s+(\\d+)\\s*$`, 'm');
    const m = re.exec(out);
    return m ? Number(m[1]) : null;
}

function whoAsked(req, localPort) {
    const ua = String((req.headers && req.headers['user-agent']) || '');
    const sock = req.socket || {};
    const remotePort = sock.remotePort;
    const key = `${remotePort}:${localPort}`;

    if (_portOwner.has(key)) return _portOwner.get(key) || uaLabel(ua) || 'a browser';
    let label = null;
    const pid = remotePort ? pidOfConnection(remotePort, localPort) : null;
    if (pid) {
        const image = imageOfPid(pid);
        const b = image && browsers.ALL.find(x => (x.exe || '').toLowerCase() === image);
        if (b) label = `${b.name} (pid ${pid})`;
        else if (image) label = `${image} (pid ${pid})`;
    }
    _portOwner.set(key, label);
    //  Keep the map from growing for the life of a 3.5-hour helper.
    if (_portOwner.size > 64) {
        for (const k of [..._portOwner.keys()].slice(0, 32)) _portOwner.delete(k);
    }
    return label || uaLabel(ua) || 'a browser';
}

//  UA tokens only where they are actually distinguishing. Brave is absent on
//  purpose: its UA is Chrome's, and printing "Google Chrome" for Brave would be
//  a wrong name rather than a missing one.
function uaLabel(ua) {
    for (const [token, name] of [['Edg/', 'Microsoft Edge'], ['OPR/', 'Opera'],
                                 ['YaBrowser', 'Yandex Browser'], ['Vivaldi', 'Vivaldi']]) {
        if (ua.includes(token)) return name;
    }
    return null;
}

/**
 * The server itself: two static files, read from disk per request.
 *
 * Reading from disk rather than from memory is deliberate. The app repacks the
 * extension whenever its source changes and rewrites the bundle; a helper that
 * had cached the bytes at logon would then serve a version the policy no longer
 * describes. mtime+size is enough of a cache to avoid re-reading 838 KB for
 * every request while still noticing a rename.
 */
class Deliverer {
    constructor({ stateDir, log }) {
        this.stateDir = stateDir;
        this.log      = log || { debug(){}, info(){}, warn(){}, error(){} };
        this.paths    = bundlePaths(stateDir);
        this.server   = null;
        this.port     = null;
        this.served   = { xml: 0, crx: 0 };
        this._cache   = new Map();
    }

    _file(file) {
        let st;
        try { st = fs.statSync(file); } catch (e) { return null; }
        const key = `${st.mtimeMs}:${st.size}`;
        const hit = this._cache.get(file);
        if (hit && hit.key === key) return hit.buf;
        let buf;
        try { buf = fs.readFileSync(file); } catch (e) { return null; }
        this._cache.set(file, { key, buf });
        return buf;
    }

    /**
     * Bind the recorded port, and only that one.
     *
     * Not a range, unlike lib/ext-host.js: every policy on this machine already
     * names one port, so a helper that landed on a different one would serve
     * an address nobody asks for. If the port is taken the answer is either
     * "ours is already there, nothing to do" or an honest warning.
     *
     * `quiet` exists for the caller that retries: serveUntilDelivered() polls
     * this while another of our own processes finishes with the port, and one
     * WARN per attempt would fill the log with a queue that resolved itself.
     * The unelevated single-shot callers keep the warning.
     *
     * @returns {Promise<number|null>}
     */
    start({ quiet = false } = {}) {
        if (this.server) return Promise.resolve(this.port);
        const meta = readBundle(this.stateDir);
        if (!meta || !meta.port) {
            this.log[quiet ? 'debug' : 'warn'](
                'No extension delivery bundle on disk -- nothing to serve. ' +
                'It is written by the installer and by every elevated app start.');
            return Promise.resolve(null);
        }
        this.meta = meta;

        const server = http.createServer((req, res) => {
            const route = (req.url || '').split('?')[0];
            if (req.method !== 'GET' && req.method !== 'HEAD') return res.writeHead(405).end();
            const which = route === MANIFEST_PATH ? 'xml' : route === CRX_PATH ? 'crx' : null;
            if (!which) return res.writeHead(404).end();
            const buf = this._file(which === 'xml' ? this.paths.xml : this.paths.crx);
            if (!buf) return res.writeHead(503).end();
            //  Identified BEFORE res.end(): the socket is still established here,
            //  and a browser that closes it immediately would otherwise leave
            //  netstat with nothing to match.
            const who = which === 'crx' ? whoAsked(req, meta.port) : null;
            res.writeHead(200, {
                'Content-Type': which === 'xml' ? 'text/xml; charset=utf-8'
                                                : 'application/x-chrome-extension',
                'Content-Length': buf.length,
                'Cache-Control': 'no-store',
            });
            res.end(req.method === 'HEAD' ? undefined : buf);
            this.served[which] += 1;
            if (which === 'crx') {
                this.log.info(`Extension package handed to ${who} ` +
                              `(${(buf.length / 1024).toFixed(0)} KB)`);
            }
        });
        server.on('clientError', (e, sock) => { try { sock.destroy(); } catch (x) {} });

        return new Promise(resolve => {
            const onErr = e => {
                server.removeListener('error', onErr);
                const how = quiet ? 'debug' : 'warn';
                this.log[how](`Port ${meta.port} is not available (${e.code || e.message}) -- ` +
                              'the browsers were told to fetch from there, so nothing can be ' +
                              'served until it is free');
                resolve(null);
            };
            server.once('error', onErr);
            server.listen(meta.port, '127.0.0.1', () => {
                server.removeListener('error', onErr);
                server.on('error', e => this.log.warn('Delivery host: ' + e.message));
                this.server = server;
                this.port   = meta.port;
                this.log.info(`Serving ${meta.id} v${meta.version} on 127.0.0.1:${meta.port} ` +
                              '-- exactly what the browser policies name');
                resolve(meta.port);
            });
        });
    }

    stop() {
        if (!this.server) return;
        try { this.server.close(); } catch (e) {}
        this.server = null;
        this.port = null;
    }
}

/**
 * Installed Chromium browsers that do NOT have the extension yet.
 *
 * This is the helper's only exit condition, and it is a read of the browsers'
 * own profiles -- never of what we wrote, and never of what we hoped. A browser
 * that is not installed is not missing anything, so it is not in this list.
 *
 * Neither is a browser whose user was shown the prompt and pressed Remove:
 * Chromium records that as state 2 (EXTERNAL_EXTENSION_UNINSTALLED) and will
 * not offer it again no matter how many times the bytes are served, so keeping
 * that browser in this list would mean serving a port for 3.5 hours every
 * single logon, forever, over a decision the user already made.
 * profileHasExtension() folds that case in for exactly this reason.
 *
 * @returns {string[]} browser ids
 */
function missing(id) {
    if (!id) return [];
    return browsers.detectChromium()
        .filter(b => b.dataDir && !browsers.profileHasExtension(b.dataDir, id))
        .map(b => b.id);
}

/**
 * Serve until every installed browser has it, then stop.
 *
 * The shape of the problem, measured: a browser fetches within about five
 * seconds of starting, and a browser can only be started by someone who is
 * logged on. So the useful window is "from logon until the browsers have been
 * opened", which is exactly what this loop waits out -- and it ends early,
 * usually within a minute of the first browser opening, rather than sitting
 * there for hours.
 *
 * It exits immediately, serving nothing, in the two cases where it has no work:
 * every browser already has the extension, or ours is already being served on
 * that port by the app or by another session's helper.
 *
 * @returns {Promise<{ok: boolean, why: string, missing: string[], served: object}>}
 */
async function serveUntilDelivered({ stateDir, log, capMs = CAP_MS, pollMs = POLL_MS }) {
    const meta = readBundle(stateDir);
    if (!meta || !meta.id) return { ok: false, why: 'no-bundle', missing: [], served: {} };

    let need = missing(meta.id);
    if (!need.length) {
        log.success('Every installed browser already has the extension -- nothing to serve');
        return { ok: true, why: 'already-delivered', missing: [], served: {} };
    }
    //  ── Getting the port, rather than surrendering it ──────────────
    //  Measured 2026-08-31 on a from-scratch install followed by the restart
    //  the app asks for: the boot task (BootTrigger, SYSTEM) and this logon
    //  task started two seconds apart. The boot pass bound 8081 for the ~28 s
    //  it spends staging the bundle and writing policy, and this helper -- which
    //  had probed the port BEFORE the boot pass got there -- hit EADDRINUSE,
    //  returned port-unavailable and exited 3. The boot pass then finished and
    //  released the port, leaving every browser on the machine pointed at
    //  127.0.0.1:8081 with nothing listening and nothing to serve it again until
    //  the next logon. Four correct routes, a dead port, zero coverage.
    //
    //  So a busy port is a queue, not an answer. This is the process that is
    //  MEANT to hold it for the session, and the two that can beat it to it --
    //  the boot pass and an elevated app start -- both let go within seconds.
    //  Wait for it, keep reading the profiles while waiting (whoever holds the
    //  port may deliver to everyone, which ends this helper's job too), and give
    //  up only on a holder that is still there after the grace window.
    const d  = new Deliverer({ stateDir, log });
    const t0 = Date.now();
    const sleep = ms => new Promise(r => setTimeout(r, ms));

    //  Announce a browser the moment its OWN profile shows the extension, no
    //  matter which process served the bytes. Shared by both loops below so the
    //  two paths can never report the same arrival differently.
    const noteArrivals = prev => {
        browsers.resetCache();          // a browser installed since logon counts too
        const now = missing(meta.id);
        for (const id of prev) {
            if (!now.includes(id)) {
                log.success(`${(browsers.byId(id) || {}).name || id}: the extension is in its ` +
                            `profile now (${Math.round((Date.now() - t0) / 1000)}s)`);
            }
        }
        return now;
    };

    let port = await d.start({ quiet: true });
    if (!port) {
        const ours    = await probeOurs(meta.port, meta.id);
        const graceMs = Math.min(PORT_GRACE_MS, capMs);
        const graceS  = Math.round(graceMs / 1000);
        log.info(ours
            ? `Our own manifest is already being served on 127.0.0.1:${meta.port} -- waiting up ` +
              `to ${graceS}s to take the port over when that server exits`
            : `Port ${meta.port} is busy and what answers there is not our manifest -- waiting up ` +
              `to ${graceS}s for it`);

        const deadline = t0 + graceMs;
        while (!port && Date.now() < deadline) {
            await sleep(pollMs);
            need = noteArrivals(need);
            if (!need.length) {
                log.success('Every installed browser has the extension now -- whoever held that ' +
                            'port served it, so this helper is done and exits');
                return { ok: true, why: 'delivered-elsewhere', missing: [], served: {} };
            }
            port = await d.start({ quiet: true });
        }

        if (!port) {
            if (ours) {
                log.info(`127.0.0.1:${meta.port} is still serving our own manifest after ` +
                         `${graceS}s -- leaving it to whoever got there first`);
                return { ok: true, why: 'already-serving', missing: need, served: {} };
            }
            log.warn(`Port ${meta.port} stayed busy and what answers it is not ours, so the ` +
                     'extension cannot be served on the address every policy names. The next ' +
                     'logon tries again.');
            return { ok: false, why: 'port-unavailable', missing: need, served: {} };
        }
        log.info(`Port ${meta.port} came free after ${Math.round((Date.now() - t0) / 1000)}s ` +
                 '-- this helper is serving it now');
    }

    log.info(`Waiting for ${browsers.names(need).join(', ')} to ask for it ` +
             `(up to ${Math.round(capMs / 60000)} minutes, then the next logon tries again)`);

    while (Date.now() - t0 < capMs) {
        await sleep(pollMs);
        need = noteArrivals(need);
        if (!need.length) break;
    }

    const served = { ...d.served };
    d.stop();
    if (!need.length) {
        log.success('Delivered to every installed browser -- this helper is done and exits');
        return { ok: true, why: 'delivered', missing: [], served };
    }
    log.info(`Still waiting on ${browsers.names(need).join(', ')} -- they have not been ` +
             'opened yet. The next logon serves again.');
    return { ok: true, why: 'timed-out', missing: need, served };
}


// ════════════════════════════════════════════════════════════════════
//  The logon task
// ════════════════════════════════════════════════════════════════════
//  WHY LOGON AND NOT BOOT. The boot task already runs as SYSTEM before any
//  browser starts, and it is what writes the policies -- but it has exited by
//  the time a browser actually fetches, and SYSTEM's own environment cannot
//  even see a per-user Chrome install. A browser can only be started by someone
//  who is logged on, so logon is the earliest moment that is also the RIGHT
//  moment.
//
//  Principal is the Users group rather than one account: whoever logs on is the
//  one whose browsers need serving, and hard-coding the installing user would
//  leave a second account with nothing. RunLevel HighestAvailable gives an
//  administrator's session an elevated helper with no UAC prompt and a standard
//  user an unelevated one -- which is all this needs, because it writes no
//  policy, holds no key and reads only its own profiles.
const XMLESC = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
                             .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The task definition, as a pure function so it can be tested unelevated. */
function deliverTaskXml(exePath) {
    return '﻿' + [
        '<?xml version="1.0" encoding="UTF-16"?>',
        '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
        '  <RegistrationInfo>',
        '    <Author>FreeProxy VPN</Author>',
        '    <Description>Hands the FreeProxy VPN browser extension to your browsers the ' +
            'first time they ask for it after you log on, then exits. Removed when ' +
            'FreeProxy VPN is uninstalled.</Description>',
        '  </RegistrationInfo>',
        '  <Triggers><LogonTrigger><Enabled>true</Enabled>',
        '    <Delay>PT10S</Delay></LogonTrigger></Triggers>',
        '  <Principals><Principal id="Author">',
        '    <GroupId>S-1-5-32-545</GroupId><RunLevel>HighestAvailable</RunLevel>',
        '  </Principal></Principals>',
        '  <Settings>',
        '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
        '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
        '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
        '    <AllowHardTerminate>true</AllowHardTerminate>',
        '    <StartWhenAvailable>false</StartWhenAvailable>',
        '    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>',
        '    <AllowStartOnDemand>true</AllowStartOnDemand>',
        '    <Enabled>true</Enabled><Hidden>true</Hidden>',
        '    <RunOnlyIfIdle>false</RunOnlyIfIdle><WakeToRun>false</WakeToRun>',
        '    <ExecutionTimeLimit>PT4H</ExecutionTimeLimit><Priority>7</Priority>',
        '  </Settings>',
        '  <Actions Context="Author"><Exec>',
        `    <Command>${XMLESC(exePath)}</Command>`,
        '    <Arguments>--fp-deliver</Arguments>',
        '  </Exec></Actions>',
        '</Task>', '',
    ].join('\r\n');
}

/** Asked of Windows, never remembered. */
function deliverTaskRegistered() {
    return shq(`schtasks /query /tn "${DELIVER_TASK}"`);
}

/**
 * Register it, and believe only the read-back.
 * @returns {boolean} registered AND confirmed by a query
 */
function registerDeliverTask(log, exePath = process.execPath) {
    const xml = path.join(os.tmpdir(), `fp-deliver-${process.pid}.xml`);
    try {
        fs.writeFileSync(xml, deliverTaskXml(exePath), 'utf16le');
        shq(`schtasks /create /tn "${DELIVER_TASK}" /xml "${xml}" /f`);
    } catch (e) {
        log.warn('Could not schedule the extension delivery helper: ' + e.message);
    }
    try { fs.unlinkSync(xml); } catch (e) {}

    if (!deliverTaskRegistered()) {
        log.warn('The extension could not be scheduled for delivery at logon -- administrator ' +
                 'rights? Browsers will still get it whenever the app itself is running.');
        return false;
    }
    log.info(`Extension delivery scheduled as "${DELIVER_TASK}" -- it runs at logon, hands ` +
             'the package to each browser that asks, and exits as soon as they all have it');
    return true;
}

/** Start it now, without waiting for a logon. Fire and forget. */
function runDeliverTaskNow(log) {
    if (!deliverTaskRegistered()) return false;
    const ran = shq(`schtasks /run /tn "${DELIVER_TASK}"`);
    if (ran && log) log.info('Delivery helper started now as well, so a browser opened before ' +
                             'the next restart is served too');
    return ran;
}

/** Safe to call when it was never registered. */
function unregisterDeliverTask(log, stateDir) {
    let gone = false;
    if (deliverTaskRegistered()) {
        gone = shq(`schtasks /delete /tn "${DELIVER_TASK}" /f`);
        if (gone) log.debug(`Scheduled task "${DELIVER_TASK}" removed`);
        else log.warn(`Could not remove the scheduled task "${DELIVER_TASK}"`);
    }
    //  The served files go with it. They live inside the directory the
    //  uninstaller deletes anyway, so this only matters when the app is torn
    //  down without being uninstalled.
    if (stateDir) {
        const p = bundlePaths(stateDir);
        for (const f of [p.crx, p.xml, p.meta]) {
            try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (e) {}
        }
    }
    return gone;
}

module.exports = { DELIVER_TASK, MANIFEST_PATH, CRX_PATH, CAP_MS, POLL_MS,
                   bundlePaths, writeBundle, readBundle, probeOurs, Deliverer,
                   missing, serveUntilDelivered, deliverTaskXml, whoAsked, uaLabel,
                   deliverTaskRegistered, registerDeliverTask, runDeliverTaskNow,
                   unregisterDeliverTask };


