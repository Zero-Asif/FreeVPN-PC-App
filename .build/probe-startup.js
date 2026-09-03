'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/probe-startup.js  --  what does a browser do at STARTUP, now
//  that the delivery helper is alive on the port the policies name?
//
//  Edge and Chrome were already running when --fp-setup wrote the routes, so
//  they never read them at start; Brave was not, and it took the package. That
//  leaves one honest question open: do Edge and Chrome take it at startup on
//  THIS build, or did the previous build's Edge result stop being true?
//
//  Killing the user's 21 Edge and 19 Chrome processes to find out would throw
//  away their session. A throwaway --user-data-dir does not: HKLM policy and
//  the External Extensions registry entries are machine-wide, so a fresh
//  profile reads exactly the same four routes as the real one, and the browser
//  it starts is a separate process tree that closes with nothing lost.
//
//  Nothing here serves anything. The live helper (--fp-deliver) is already on
//  127.0.0.1:8081 with the real bundle; that is the thing under test.
//
//  Read-only with respect to every real profile. Each browser is killed by the
//  pid we spawned, never by image name.
// ════════════════════════════════════════════════════════════════════
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const http = require('http');
const { spawn, execSync } = require('child_process');

const browsers = require('../lib/browsers');
const deliver  = require('../lib/ext-deliver');

const STATE = path.join(process.env.ProgramData || 'C:\\ProgramData', 'freeproxy-vpn');
const TMP   = fs.mkdtempSync(path.join(os.tmpdir(), 'fpstart-'));
const WAIT_MS   = 90000;
const FLUSH_MS  = 45000;
const ONLY = process.argv.slice(2).filter(a => !a.startsWith('-'));

const stamp = () => new Date().toISOString().slice(11, 19);
const say = (...a) => console.log(stamp(), ...a);

//  extensions/browser/disable_reason.h, current Chromium. The values below are
//  the ones an external / policy install can actually produce; the deprecated
//  gaps are left out rather than guessed at.
//  One table, in lib/browsers.js -- these copies drifted and carried two wrong
//  labels (262144 as NOT_ALLOWLISTED, 524288 as UNSUPPORTED_MANIFEST_VERSION;
//  they are 1<<18 retired and 1<<19 REINSTALL). A probe that prints a different
//  name from the app cannot be used to diagnose the app.
const REASON = browsers.DISABLE_REASON;
//  extensions/common/mojom/manifest.mojom, Location.
const LOC = browsers.EXT_LOCATION;

const reasons = v => {
    const list = Array.isArray(v) ? v : (typeof v === 'number' ? [v] : []);
    const flat = list.reduce((a, n) => a | n, 0);
    if (!flat) return list.length ? String(list) : 'none';
    return Object.keys(REASON).filter(k => flat & +k).map(k => `${k}=${REASON[k]}`).join(' + ');
};
const loc = n => `${n} (${LOC[n] || '?'})`;

/** The whole entry, so nothing is inferred from the four keys I happened to print. */
function entryOf(userData, id, profile = 'Default') {
    for (const f of ['Secure Preferences', 'Preferences']) {
        let j;
        try { j = JSON.parse(fs.readFileSync(path.join(userData, profile, f), 'utf8')); }
        catch (e) { continue; }
        const s = (((j.extensions || {}).settings) || {})[id];
        if (s) return { file: f, s };
    }
    return null;
}

function describe(label, userData, id, profile = 'Default') {
    const dir = path.join(userData, profile, 'Extensions', id);
    const onDisk = fs.existsSync(dir) ? fs.readdirSync(dir).join(',') : 'NO FOLDER';
    const e = entryOf(userData, id, profile);
    say(`   ${label}`);
    say(`      folder     : ${onDisk}`);
    if (!e) { say('      prefs      : NONE'); return null; }
    const s = e.s;
    say(`      prefs in   : ${e.file}`);
    say(`      location   : ${loc(s.location)}    state: ${JSON.stringify(s.state)}`);
    say(`      disabled by: ${reasons(s.disable_reasons)}`);
    say(`      version    : ${JSON.stringify((s.manifest || {}).version)}` +
        `   from_webstore: ${JSON.stringify(s.from_webstore)}` +
        `   ack_external: ${JSON.stringify(s.ack_external)}`);
    say(`      all keys   : ${Object.keys(s).sort().join(' ')}`);
    return s;
}

const get = (port, p) => new Promise(res => {
    const req = http.get({ host: '127.0.0.1', port, path: p, timeout: 3000 }, r => {
        let n = 0;
        r.on('data', d => { n += d.length; });
        r.on('end', () => res(`${r.statusCode} ${n}B ${r.headers['content-type'] || ''}`));
    });
    req.on('timeout', () => { req.destroy(); res('timeout'); });
    req.on('error', e => res('error ' + e.code));
});

(async () => {
    const meta = deliver.readBundle(STATE);
    if (!meta) { say('ABORT: no delivery bundle on disk'); process.exit(3); }
    say(`bundle: ${meta.id} v${meta.version} port ${meta.port}`);
    say(`   ${meta.manifest} -> ${await get(meta.port, meta.manifest)}`);
    say(`   ${meta.crx} -> ${await get(meta.port, meta.crx)}`);

    say('── the real profiles, as they are right now ──');
    for (const b of browsers.detectChromium()) {
        if (!b.dataDir) continue;
        let profs = [];
        try { profs = fs.readdirSync(b.dataDir).filter(d => /^(Default|Profile \d+)$/.test(d)); }
        catch (e) {}
        for (const p of profs) describe(`${b.name} / ${p}`, b.dataDir, meta.id, p);
        say(`      profileHasExtension() -> ${browsers.profileHasExtension(b.dataDir, meta.id)}`);
    }

    const targets = browsers.detectChromium()
        .filter(b => b.exePath && (!ONLY.length || ONLY.includes(b.id)));
    if (!targets.length) { say('nothing to launch'); process.exit(0); }

    say(`── launching ${targets.map(b => b.name).join(', ')} into throwaway profiles ──`);
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
        say(`   ${b.name}  pid ${child.pid}`);
        return { b, ud, pid: child.pid, seen: null };
    });

    const t0 = Date.now();
    while (Date.now() - t0 < WAIT_MS) {
        await new Promise(r => setTimeout(r, 5000));
        let all = true;
        for (const r of runs) {
            if (r.seen) continue;
            const dir = path.join(r.ud, 'Default', 'Extensions', meta.id);
            if (fs.existsSync(dir)) {
                r.seen = ((Date.now() - t0) / 1000).toFixed(0) + 's';
                say(`   ++ ${r.b.name}: unpacked into the fresh profile after ${r.seen}`);
            } else all = false;
        }
        if (all) break;
    }

    //  Chromium flushes Secure Preferences lazily. Reading it ten seconds in
    //  says "no entry" about a browser that has already installed it.
    say(`── waiting ${FLUSH_MS / 1000}s for the fresh profiles to be flushed ──`);
    await new Promise(r => setTimeout(r, FLUSH_MS));

    say('── what each fresh profile ended up with ──');
    for (const r of runs) describe(`${r.b.name} (throwaway)`, r.ud, meta.id);

    for (const r of runs) {
        try { execSync(`taskkill /PID ${r.pid} /T /F`, { windowsHide: true, stdio: 'ignore' }); }
        catch (e) {}
    }
    say(`throwaway profiles under ${TMP}`);
    process.exit(0);
})().catch(e => { say('ABORT ' + e.stack); process.exit(3); });
