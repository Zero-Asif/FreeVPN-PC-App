'use strict';
// ════════════════════════════════════════════════════════════════════
//  lib/installer-tasks.js  --  what the installer and the uninstaller run
//
//  NSIS is the wrong place to keep knowledge about this machine. It cannot
//  detect which browsers are installed, it cannot stage or sign a CRX, and
//  every registry path written into installer.nsh is a second copy of one
//  lib/browsers.js already owns -- a copy that rots silently the moment the
//  table changes. The previous installer.nsh proved the cost: it force-
//  installed a HARDCODED extension id that does not belong to this project
//  into slot "1" of two hardcoded policy keys, and the uninstaller deleted
//  exactly that one slot number -- so an app that never shipped a Web Store
//  extension pushed a stranger's into every user's Chrome, and squatted the
//  slot lib/geo-ext.js allocates dynamically.
//
//  So the installer runs the APP instead, headless:
//
//      "FreeProxy VPN.exe" --fp-setup      from customInstall
//      "FreeProxy VPN.exe" --fp-teardown   from customUnInstall
//
//  No window, no Tor, no elevation prompt -- the installer is already
//  elevated -- and the same detection, the same journals and the same
//  restore code the running app uses. NSIS keeps only what NSIS is good
//  at: running a program and removing a directory.
//
//  The forcelist entry written here is INERT until the app runs, which is
//  exactly the requirement: it points at http://127.0.0.1:<port>, which
//  nothing answers unless lib/ext-host.js is up. So the extension arrives
//  with the install and comes to life with the app.
//
//  Exit codes, because a number is the installer's only channel back:
//
//      0   done -- the extension was force-installed somewhere
//     10   done -- staged, but no installed browser accepts an automatic
//          route; HOW-TO-ENABLE.txt was written for the user
//      3   the extension could not be staged at all
//      4   the watchdog fired (an installer must never hang)
//      1   crashed
// ════════════════════════════════════════════════════════════════════
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execSync } = require('child_process');

const browsers = require('./browsers');
const { FW_RULE } = require('./geo-spoof');
const { POLICY_KEYS, FORCELIST, regValues } = require('./geo-ext');

const EXIT = { ok: 0, crashed: 1, stageFailed: 3, timedOut: 4, manual: 10 };

//  The id an earlier installer.nsh force-installed into slot "1" of the
//  Chrome and Edge forcelists. It is not this project's extension -- nothing
//  in this repository packages, signs or serves it -- but our installer is
//  why it is on real machines, so teardown is the only thing that will ever
//  take it out again. Setup removes it too: an upgrade must not leave the
//  fake behind next to the real one.
const LEGACY_FAKE_ID = 'oecbgglkbdlifmaedkikgpmifiidjhfo';

const TASK_FLAGS = { '--fp-setup': 'setup', '--fp-teardown': 'teardown' };

//  Every firewall rule this app creates, by the exact name it creates it
//  with. netsh deletes by name, so a rule the user added themselves cannot
//  be caught by accident -- which is the whole reason these are named rather
//  than matched on program path or port.
const FW_RULES = [
    'FreeProxy Tor Engine',          // installer.nsh, outbound allow for tor.exe
    'FreeProxy App',                 // installer.nsh, outbound allow for the app
    'FreeProxy Block IPv6 Out',      // main.js kill-switch / leak guard
    'FreeProxy Block IPv6 In',
    FW_RULE,                         // lib/geo-spoof.js -- the lfsvc shield
];

//  HKCU proxy values this app writes. There is no snapshot of what was there
//  before -- no build of this app ever took one -- so teardown DELETES them
//  rather than inventing a "restore". A machine with no proxy has no
//  ProxyServer value at all, and leaving an empty string behind is our
//  litter, not the user's setting.
const PROXY_KEY =
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

/** Which task, if any, this process was started for. */
function installerTask(argv) {
    for (const a of argv || []) {
        const t = TASK_FLAGS[String(a).toLowerCase()];
        if (t) return t;
    }
    return null;
}

// ── shell ───────────────────────────────────────────────────────────
function sh(cmd, timeout = 25000) {
    return execSync(cmd, { windowsHide: true, encoding: 'utf8', stdio: 'pipe', timeout });
}
function shq(cmd, timeout) { try { sh(cmd, timeout); return true; } catch (e) { return false; } }

// ════════════════════════════════════════════════════════════════════
//  Forcelist sweep -- belt and braces behind lib/geo-ext.js's journal
// ════════════════════════════════════════════════════════════════════
/**
 * Remove forcelist entries that can only have come from this app, across the
 * WHOLE Chromium table rather than only the browsers installed today.
 *
 * GeoExt.restore() is the precise mechanism: it removes the slots its own
 * journal recorded, and only while they still hold its own id. This is the
 * net underneath it, for the cases where that journal cannot help -- it was
 * deleted, it was written by a build that recorded slots differently, or the
 * app was installed, force-installed into a browser, and then uninstalled
 * without ever having been run.
 *
 * Two signatures, both unmistakable:
 *
 *   <32-letter id>;http://127.0.0.1:<port>/...
 *       self-hosted on the user's own loopback. No enterprise deployment
 *       looks like that; lib/ext-host.js is the only thing that serves it.
 *   oecbgglkbdlifmaedkikgpmifiidjhfo;...
 *       the hardcoded id an earlier installer.nsh wrote.
 *
 * Anything else in those keys is the user's -- very often a workplace
 * deployment -- and is left exactly where it is. The subkey itself is
 * removed only if this sweep is what emptied it.
 *
 * @param {object}  log
 * @param {object}  [opts]
 * @param {boolean} [opts.legacyOnly]  only the hardcoded id (used by setup,
 *                                     which is about to write a fresh entry
 *                                     of its own and must not race it)
 * @param {string}  [opts.alsoId]      a Web Store id, when FP_GEO_WEBSTORE_ID
 *                                     is configured
 */
function sweepForcelists(log, opts = {}) {
    const loopback = /^[a-p]{32};https?:\/\/127\.0\.0\.1(:\d+)?\//i;
    const isOurs = v =>
        v.startsWith(LEGACY_FAKE_ID + ';') ||
        (!opts.legacyOnly && (loopback.test(v) ||
            (opts.alsoId ? v.startsWith(opts.alsoId + ';') : false)));

    let removed = 0, legacy = 0;
    for (const id of Object.keys(POLICY_KEYS)) {
        const key = `${POLICY_KEYS[id]}\\${FORCELIST}`;
        const before = regValues(key);
        const hits = Object.keys(before).filter(k => isOurs(before[k]));
        if (!hits.length) continue;
        for (const slot of hits) {
            if (!shq(`reg delete "${key}" /v "${slot}" /f`)) {
                log.warn(`Could not remove our force-install entry from ` +
                         `${(browsers.byId(id) || {}).name || id} -- administrator rights?`);
                continue;
            }
            removed += 1;
            if (before[slot].startsWith(LEGACY_FAKE_ID + ';')) legacy += 1;
        }
        //  Only if we are what emptied it. A forcelist subkey with the user's
        //  own entries still in it has to survive untouched.
        if (!Object.keys(regValues(key)).length) shq(`reg delete "${key}" /f`);
    }
    if (legacy) {
        log.warn(`Removed ${legacy} force-install entry/ies for ${LEGACY_FAKE_ID} -- ` +
                 'an extension an earlier version of this installer pushed into your ' +
                 'browser and that was never this app\'s own');
    }
    if (removed - legacy > 0) log.info(`Removed ${removed - legacy} of our force-install entry/ies`);
    return removed;
}

// ════════════════════════════════════════════════════════════════════
//  Network state -- proxy, DNS, IPv6, firewall rules
// ════════════════════════════════════════════════════════════════════
//  One .bat in the TEMP directory, not in the app's state directory: the
//  uninstaller removes that directory, and a script cannot delete the folder
//  it is running from. Everything here is either "delete a value this app
//  wrote" or "set a Windows default back", and every line is one main.js
//  already runs at startup for a crashed session -- the difference is that
//  this runs when there will be no next startup.
function sweepNetwork(log) {
    const iface = 'HKLM\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters';
    const bat = path.join(os.tmpdir(), 'fp_uninstall_net.bat');
    const lines = [
        '@echo off',
        //  System proxy off. tor.exe is already dead by now, so leaving
        //  127.0.0.1:9050 configured would take the machine offline.
        `reg add "${PROXY_KEY}" /v ProxyEnable /t REG_DWORD /d 0 /f`,
        `reg delete "${PROXY_KEY}" /v ProxyServer /f 2>nul`,
        `reg delete "${PROXY_KEY}" /v ProxyOverride /f 2>nul`,
        //  DNS: the 127.0.0.1 redirect, per-adapter and global.
        'netsh interface portproxy delete v4tov4 listenport=53 listenaddress=127.0.0.1 2>nul',
        `for /f %%i in ('reg query "${iface}\\Interfaces"') do reg delete "%%i" /v NameServer /f 2>nul`,
        `reg delete "${iface}" /v NameServer /f 2>nul`,
        'net start dnscache 2>nul',
        //  IPv6 back on. DisabledComponents 0 is the Windows default, and the
        //  binding has to be re-enabled per adapter because disabling it is
        //  per adapter.
        'reg add "HKLM\\SYSTEM\\CurrentControlSet\\Services\\Tcpip6\\Parameters"' +
            ' /v DisabledComponents /t REG_DWORD /d 0 /f',
        'powershell -NoProfile -NonInteractive -Command "Get-NetAdapter | Where-Object ' +
            "{$_.Status -eq 'Up'} | ForEach-Object { try { Enable-NetAdapterBinding " +
            '-Name $_.Name -ComponentID ms_tcpip6 -ErrorAction SilentlyContinue } catch {} }"',
        'netsh interface teredo set state default',
        'netsh interface isatap set state default',
        'netsh interface 6to4 set state default',
        ...FW_RULES.map(r => `netsh advfirewall firewall delete rule name="${r}" 2>nul`),
        //  Trigger-start is the Windows default for the location service. An
        //  old build of this app disabled it, and a disabled lfsvc is what
        //  makes Settings > Privacy > Location unfixable by hand.
        'sc config lfsvc start= demand',
        'ipconfig /flushdns',
    ];
    try {
        fs.writeFileSync(bat, lines.join('\r\n'), 'utf8');
        sh(`cmd.exe /c "${bat}"`, 90000);
        log.success('System proxy, DNS, IPv6 and this app\'s firewall rules reverted');
    } catch (e) {
        log.warn('Network revert did not finish cleanly: ' + String(e.message).split('\n')[0]);
    }
    try { fs.unlinkSync(bat); } catch (e) {}
}

// ════════════════════════════════════════════════════════════════════
//  Leftovers of two abandoned approaches
// ════════════════════════════════════════════════════════════════════
//  A build before the extension existed tried to stop Chromium reaching
//  Google's geolocation endpoint by pointing it at 127.0.0.1 in the hosts
//  file. The app removes those lines on every start now, but a user who
//  installs and never runs it would keep them forever.
const HOSTS = 'C:\\Windows\\System32\\drivers\\etc\\hosts';
function sweepHosts(log) {
    try {
        const txt = fs.readFileSync(HOSTS, 'utf8');
        if (!txt.includes('FreeProxy VPN -- location spoof block')) return;
        fs.writeFileSync(HOSTS, txt.replace(
            /\r?\n# FreeProxy VPN -- location spoof block[\s\S]*?# FreeProxy VPN end/g, ''), 'utf8');
        log.success('Removed this app\'s entries from the Windows hosts file');
    } catch (e) { /* not present, or not writable -- nothing to report either way */ }
}

//  The same era tried an HTTPS man-in-the-middle: a self-signed certificate
//  for www.googleapis.com, installed in the machine's Trusted Root store,
//  with its private key on disk under a hard-coded password. That approach is
//  gone, but a trusted root for a Google host is the single most dangerous
//  thing this app has ever left on a machine, so uninstall makes sure of it
//  rather than assuming a previous startup already did.
//
//  Enumeration in PowerShell, deletion with certutil: Remove-Item -DeleteKey
//  throws on a certificate with no private key, which is all of these, and
//  CurrentUser\Root is a merged VIEW of the machine store, so deleting a
//  machine certificate through it silently does nothing.
function sweepCerts(log) {
    const listPs =
        'Get-ChildItem Cert:\\LocalMachine\\Root, Cert:\\LocalMachine\\My, ' +
        'Cert:\\CurrentUser\\Root, Cert:\\CurrentUser\\My -EA SilentlyContinue | ' +
        "Where-Object { $_.FriendlyName -eq 'FreeProxy GeoSpoof' -or " +
        "($_.Subject -like '*CN=www.googleapis.com*' -and $_.Subject -eq $_.Issuer) } | " +
        'Select-Object -ExpandProperty Thumbprint -Unique';
    const list = () => {
        try {
            return sh(`powershell -NoProfile -NonInteractive -Command "${listPs}"`, 30000)
                .split(/\r?\n/).map(x => x.trim()).filter(x => /^[0-9A-Fa-f]{40}$/.test(x));
        } catch (e) { return []; }
    };
    const before = list();
    if (!before.length) return;
    for (const tp of before) {
        for (const store of ['Root', 'My', 'CA']) {
            shq(`certutil -f -delstore ${store} ${tp}`, 20000);
            shq(`certutil -user -f -delstore ${store} ${tp}`, 20000);
        }
    }
    const left = list();
    if (!left.length) {
        log.success(`Removed ${before.length} self-signed www.googleapis.com root ` +
                    'certificate(s) left by an earlier build');
    } else {
        //  Deliberately an error. A trusted root for a Google domain that the
        //  uninstaller could not remove is something the user has to be told.
        log.error(`Could NOT remove ${left.length} of ${before.length} self-signed ` +
                  'www.googleapis.com root certificate(s) -- remove them by hand in ' +
                  'certmgr.msc under Trusted Root Certification Authorities',
                  { thumbprints: left });
    }
}

//  Files this app writes OUTSIDE its own two directories. Everything inside
//  C:\ProgramData\freeproxy-vpn and %LOCALAPPDATA%\FreeProxy VPN is removed by
//  installer.nsh once this process has exited -- a running process cannot
//  delete the tree it is logging into, and Electron holds handles on several
//  files in there for as long as it is alive.
function sweepTemp(log) {
    let n = 0;
    for (const f of ['vpn_elevate.ps1', 'vc_redist.x64.exe', 'fp_uninstall_net.bat']) {
        const p = path.join(os.tmpdir(), f);
        try { if (fs.existsSync(p)) { fs.unlinkSync(p); n += 1; } } catch (e) {}
    }
    if (n) log.debug(`Removed ${n} temporary file(s) this app left in %TEMP%`);
}

// ════════════════════════════════════════════════════════════════════
//  --fp-setup
// ════════════════════════════════════════════════════════════════════
async function taskSetup(log, ctx) {
    const ext = ctx.geoExt();

    //  An upgrade over the build that BLOCKED geolocation instead of spoofing
    //  it leaves DefaultGeolocationSetting=2 and a wildcard blocked-URL rule in
    //  HKLM. Until they are gone every page reports "User denied the request
    //  for Geolocation" and the user's own Location control stays greyed out --
    //  no matter what the extension does, because a policy block is evaluated
    //  before the page ever runs. So the very first thing a new install does is
    //  take them away.
    try { ctx.geoEngine().clearBlockingPolicy(); }
    catch (e) { log.warn('Clearing an old block policy failed: ' + e.message); }

    //  ...and over the installer that pushed a stranger's extension.
    try { sweepForcelists(log, { legacyOnly: true }); }
    catch (e) { log.warn('Legacy force-install sweep failed: ' + e.message); }

    let prepared = null;
    try { prepared = await ext.prepare(); }
    catch (e) { log.error('Staging the browser extension threw', { err: e.message }); }
    if (!prepared) {
        log.error('The browser extension could not be staged at install time -- ' +
                  'the app will try again the first time it runs');
        return EXIT.stageFailed;
    }
    log.success(`Extension ${prepared.id} v${prepared.version} staged in ${prepared.dir}`);

    let auto = [];
    try { auto = ext.install() || []; }
    catch (e) { log.error('Force-install failed', { err: e.message }); }

    let manual = [];
    try { manual = ext.needManualLoad(); ext.writeHowTo(manual); }
    catch (e) { log.warn('Writing HOW-TO-ENABLE.txt failed: ' + e.message); }

    //  The CRX server only existed to hand the package to a browser, and no
    //  browser is going to ask for it during an install. The forcelist entry it
    //  produced stays behind pointing at loopback, which is exactly the
    //  requirement: the extension is delivered by the install and comes to life
    //  when the app runs. lib/geo-ext.js's install() replaces the entry if the
    //  next run lands on a different port.
    try { ext.host.stop(); } catch (e) {}

    const here = browsers.names(browsers.detectChromium().map(b => b.id));
    log.info('Install-time browser setup -- ' +
             `Chromium found: ${here.join(', ') || 'none'}; ` +
             `extension force-installed: ${browsers.names(auto).join(', ') || 'none'}; ` +
             `needs one manual load: ${browsers.names(manual).join(', ') || 'none'}`);

    const gecko = browsers.names(browsers.detectGecko().map(b => b.id));
    if (gecko.length) {
        //  Nothing to install for these. Gecko takes a real, documented
        //  coordinate override through a pref, which the app writes on connect
        //  and removes on disconnect -- there is no extension involved and
        //  nothing for an installer to do.
        log.info(`${gecko.join(', ')}: no extension needed -- spoofed through ` +
                 'geo.provider.network.url when you connect');
    }
    return auto.length ? EXIT.ok : EXIT.manual;
}

// ════════════════════════════════════════════════════════════════════
//  --fp-teardown
// ════════════════════════════════════════════════════════════════════
async function taskTeardown(log, ctx) {
    shq('taskkill /F /IM tor.exe');

    //  Journal-driven first, while the journals are still on disk: these are
    //  the only steps that can put a setting back to what the USER had rather
    //  than to a Windows default -- Chromium site permissions an old build
    //  flipped, the location consent state, lfsvc's start type, and each Gecko
    //  profile's user.js.
    try { ctx.geoExt().restore(); }
    catch (e) { log.warn('Removing the force-install policy failed: ' + e.message); }
    try { ctx.geoEngine().restoreAll(); }
    catch (e) { log.warn('Restoring location settings failed: ' + e.message); }

    //  Then the net underneath both of them.
    try { sweepForcelists(log, { alsoId: process.env.FP_GEO_WEBSTORE_ID || null }); }
    catch (e) { log.warn('Force-install sweep failed: ' + e.message); }

    //  ProxySettings, the WebRTC/DNS leak policies and any stale
    //  GeolocationAllowedForUrls, across the WHOLE browser table -- a fork
    //  uninstalled since this app last ran still has our values in HKLM.
    try { await ctx.restoreBrowserPolicy(); }
    catch (e) { log.warn('Reverting browser policy failed: ' + e.message); }

    sweepNetwork(log);
    sweepHosts(log);
    sweepCerts(log);
    sweepTemp(log);

    log.success('Uninstall revert complete -- system proxy, DNS, IPv6, firewall rules, ' +
                'browser policy, force-installed extension and Gecko location prefs are ' +
                'all back the way they were. The installer removes this app\'s own ' +
                'directories next.');
    return EXIT.ok;
}

// ════════════════════════════════════════════════════════════════════
//  entry point
// ════════════════════════════════════════════════════════════════════
//  An installer that hangs is worse than one that fails: NSIS's ExecWait has
//  no timeout of its own, so one stuck reg.exe would leave the user staring at
//  a progress bar with no way out. Teardown gets longer because certificate
//  enumeration and netsh are both slow.
const WATCHDOG_MS = { setup: 120000, teardown: 240000 };

/**
 * @param {'setup'|'teardown'} task
 * @param {object} ctx  { Logger, isRunAsAdmin, geoEngine, geoExt,
 *                        restoreBrowserPolicy }
 * @returns {Promise<number>} the process exit code
 */
function runInstallerTask(task, ctx) {
    const log = ctx.Logger;
    log.info(`Installer task: --fp-${task} (headless, no window)`);
    if (!ctx.isRunAsAdmin()) {
        log.warn(`--fp-${task} is running WITHOUT administrator rights, so every HKLM ` +
                 'and firewall step will fail. The installer runs elevated, so this ' +
                 'can only mean it was started by hand.');
    }
    return new Promise(resolve => {
        const ms = WATCHDOG_MS[task] || 120000;
        const guard = setTimeout(() => {
            log.error(`--fp-${task} exceeded ${ms / 1000}s -- giving up so the installer ` +
                      'can carry on');
            resolve(EXIT.timedOut);
        }, ms);
        const done = code => { clearTimeout(guard); resolve(code); };
        Promise.resolve()
            .then(() => (task === 'setup' ? taskSetup : taskTeardown)(log, ctx))
            .then(done, e => {
                log.error(`--fp-${task} crashed`,
                          { err: (e && e.stack ? String(e.stack) : String(e)).split('\n')[0] });
                done(EXIT.crashed);
            });
    });
}

module.exports = {
    installerTask, runInstallerTask,
    sweepForcelists, sweepNetwork, sweepHosts, sweepCerts, sweepTemp,
    EXIT, FW_RULES, LEGACY_FAKE_ID, PROXY_KEY,
};
