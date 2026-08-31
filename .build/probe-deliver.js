'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/probe-deliver.js  --  does a browser actually FETCH what the
//  four routes point at, when the port is alive at browser start?
//
//  Regression 2's measured symptom: every route is written correctly and no
//  browser has the extension. The suspicion is delivery, not policy -- the
//  update_url names http://127.0.0.1:8081/, which lib/ext-host.js answers only
//  while the app or a setup task is running, so a browser started afterwards
//  finds a dead port.
//
//  This settles it by experiment. It serves the real staged payload on the port
//  the live registry already names, launches each installed Chromium into a
//  THROWAWAY user-data-dir (so the user's own profiles are not touched and the
//  result cannot be a leftover from an earlier session), and watches for:
//
//      * a GET of /updates.xml and /freeproxy-geo.crx on the wire
//      * the extension id appearing as a directory in that fresh profile
//
//  Each browser is killed by the pid we spawned -- never by image name, which
//  would take the user's own windows with it.
// ════════════════════════════════════════════════════════════════════
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');

const { GeoExt } = require('../lib/geo-ext');
const browsers = require('../lib/browsers');

const STATE = path.join(process.env.ProgramData || 'C:\\ProgramData', 'freeproxy-vpn');
const TMP   = fs.mkdtempSync(path.join(os.tmpdir(), 'fpdel-'));
const WAIT_MS = 150000;

//  The staged extension in ProgramData is Users:(RX) -- written by an elevated
//  setup, as a machine-wide asset should be -- so an unelevated probe cannot
//  re-stage it. It does not need to: the extension id comes from the KEY, so
//  staging into a scratch directory with the real ext-key.pem produces the same
//  id, byte-for-byte the same payload, and touches nothing the installer owns.
const SCRATCH = path.join(TMP, 'state');
fs.mkdirSync(SCRATCH, { recursive: true });
fs.copyFileSync(path.join(STATE, 'ext-key.pem'), path.join(SCRATCH, 'ext-key.pem'));

const stamp = () => new Date().toISOString().slice(11, 19);
const say = (...a) => console.log(stamp(), ...a);
const log = { debug: (...a) => say('   dbg', ...a), info: (...a) => say('   inf', ...a),
              success: (...a) => say('   ok ', ...a), warn: (...a) => say('   WARN', ...a),
              error: (...a) => say('   ERR ', ...a) };

const hits = [];

(async () => {
    const ext = new GeoExt({ log, stateDir: SCRATCH,
                             sourceDir: path.join(__dirname, '..', 'Extension') });
    const p = await ext.prepare();
    if (!p) { say('ABORT: prepare() failed -- cannot serve anything'); process.exit(3); }
    say(`serving ${p.id} v${p.version} at ${p.updateUrl}`);

    //  Count what the browsers ask for, on the wire, in this process.
    const srv = ext.host.server;
    srv.on('request', req => {
        hits.push({ t: Date.now(), url: req.url, ua: (req.headers['user-agent'] || '').slice(0, 60) });
        say(`   <-- ${req.method} ${req.url}`);
    });

    //  What the live machine points at. If it names a different port than the
    //  one we just bound, that mismatch IS the bug and nothing below can work.
    const reg = c => { try { return execSync(c, { windowsHide: true, encoding: 'utf8', stdio: 'pipe' }); }
                       catch (e) { return ''; } };
    say('── what the live registry names ──');
    for (const row of browsers.policyRoots('installed')) {
        const out = reg(`reg query "${row.key}\\ExtensionInstallForcelist"`);
        const m = out.match(/REG_SZ\s+(\S+)/);
        if (m) say(`   ${row.id} forcelist  ${m[1]}`);
    }
    for (const row of browsers.externalRoots('installed')) {
        for (const view of browsers.REG_VIEWS) {
            const out = reg(`reg query "${row.key}\\${p.id}" /v update_url /reg:${view}`);
            const m = out.match(/update_url\s+REG_SZ\s+(\S+)/);
            if (m) say(`   ${row.id} external:${view}  ${m[1]}`);
        }
    }

    const targets = browsers.detectChromium().filter(b => b.exePath);
    say(`── launching ${targets.length} browser(s) into throwaway profiles ──`);

    const runs = targets.map(b => {
        const ud = path.join(TMP, b.id);
        fs.mkdirSync(ud, { recursive: true });
        const child = spawn(b.exePath, [
            `--user-data-dir=${ud}`,
            '--no-first-run', '--no-default-browser-check',
            '--disable-search-engine-choice-screen',
            'about:blank',
        ], { detached: true, stdio: 'ignore', windowsHide: false });
        child.unref();
        say(`   ${b.name}  pid ${child.pid}  profile ${ud}`);
        return { b, ud, pid: child.pid, seen: null };
    });

    const found = r => {
        for (const prof of ['Default', 'Profile 1']) {
            if (fs.existsSync(path.join(r.ud, prof, 'Extensions', p.id))) return 'Extensions folder';
            for (const f of ['Preferences', 'Secure Preferences']) {
                try {
                    if (fs.readFileSync(path.join(r.ud, prof, f), 'utf8').includes(p.id))
                        return 'prefs entry';
                } catch (e) {}
            }
        }
        return null;
    };

    const t0 = Date.now();
    while (Date.now() - t0 < WAIT_MS) {
        await new Promise(r => setTimeout(r, 5000));
        let all = true;
        for (const r of runs) {
            if (r.seen) continue;
            const f = found(r);
            if (f) { r.seen = f; say(`   ++ ${r.b.name}: ${f} after ${((Date.now() - t0) / 1000).toFixed(0)}s`); }
            else all = false;
        }
        if (all) break;
    }

    say('── result ──');
    for (const r of runs) {
        say(`   ${r.b.name.padEnd(16)} ${r.seen ? 'INSTALLED (' + r.seen + ')' : 'nothing'}`);
    }
    say(`   requests served: ${hits.length}`);
    for (const h of hits) say(`      ${h.url}`);

    //  Phase 2, and it is the point of route 4. Unpacking the CRX into the
    //  profile is not the same as RUNNING it: Chromium greylists an off-store
    //  extension and records disable_reasons [256] unless the id is in
    //  ExtensionInstallAllowlist. Those flags live in Preferences / Secure
    //  Preferences, which Chromium flushes lazily -- killing the browser ten
    //  seconds in leaves nothing on disk to read, which is why this waits.
    if (runs.some(r => r.seen)) {
        say('── waiting 45s for the profile to be flushed, then reading the state ──');
        await new Promise(r => setTimeout(r, 45000));
        for (const r of runs) {
            for (const prof of ['Default']) {
                for (const f of ['Preferences', 'Secure Preferences']) {
                    let j;
                    try { j = JSON.parse(fs.readFileSync(path.join(r.ud, prof, f), 'utf8')); }
                    catch (e) { continue; }
                    const s = (((j.extensions || {}).settings) || {})[p.id];
                    if (!s) continue;
                    say(`   ${r.b.name}  ${f}: location=${s.location} state=${s.state} ` +
                        `disable_reasons=${JSON.stringify(s.disable_reasons)} ` +
                        `v=${(s.manifest || {}).version}`);
                }
            }
        }
    }

    for (const r of runs) {
        try { execSync(`taskkill /PID ${r.pid} /T /F`, { windowsHide: true, stdio: 'ignore' }); }
        catch (e) {}
    }
    ext.host.stop();
    say(`profiles left in ${TMP} -- delete when done reading them`);
    process.exit(0);
})().catch(e => { say('ABORT ' + e.stack); process.exit(3); });
