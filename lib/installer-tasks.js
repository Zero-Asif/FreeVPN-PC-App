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
const { POLICY_KEYS, FORCELIST, EXT_SETTINGS, ALLOWLIST, regValues, regValue,
        regValueView, regWriteSz, sweepExternal } = require('./geo-ext');
const deliver = require('./ext-deliver');

const EXIT = { ok: 0, crashed: 1, stageFailed: 3, timedOut: 4, manual: 10,
               //  Teardown finished, and a restart is genuinely advisable: a
               //  browser was open while its provider entry was removed, so
               //  the extension only leaves that browser at its next start.
               //  installer.nsh turns this, and only this, into the uninstall
               //  reboot question.
               rebootAdvised: 11 };

//  The id an earlier installer.nsh force-installed into slot "1" of the
//  Chrome and Edge forcelists. It is not this project's extension -- nothing
//  in this repository packages, signs or serves it -- but our installer is
//  why it is on real machines, so teardown is the only thing that will ever
//  take it out again. Setup removes it too: an upgrade must not leave the
//  fake behind next to the real one.
const LEGACY_FAKE_ID = 'oecbgglkbdlifmaedkikgpmifiidjhfo';

const TASK_FLAGS = { '--fp-setup': 'setup', '--fp-teardown': 'teardown',
                     '--fp-boot': 'boot',
                     //  Not an installer job at all: the logon helper that
                     //  hands the packaged extension to a browser at the one
                     //  moment a browser asks for it. It goes through the same
                     //  entry point because it needs the same headless,
                     //  no-window, no-Tor start that the other three get.
                     '--fp-deliver': 'deliver' };

//  Every firewall rule this app creates, by the exact name it creates it
//  with. netsh deletes by name, so a rule the user added themselves cannot
//  be caught by accident -- which is the whole reason these are named rather
//  than matched on program path or port.
const FW_RULES = [
    'FreeProxy Tor Engine',          // installer.nsh, outbound allow for tor.exe
    'FreeProxy App',                 // installer.nsh, outbound allow for the app
    'FreeProxy Block IPv6 Out',      // main.js kill-switch / leak guard
    'FreeProxy Block IPv6 In',
    //  main.js dnsLockAdd() -- outbound 53 (UDP+TCP) and 853 blocked to every
    //  address except 127/8, so DNS can only reach Tor's own listener.
    //
    //  These two matter more on uninstall than anything else in this list. The
    //  rest of the rules being left behind would over-permit; these being left
    //  behind would leave a machine that cannot resolve a hostname at all once
    //  Tor is gone, with nothing in the Windows network dialogs to explain it.
    'FreeProxy Block DNS Out',
    'FreeProxy Block DoT Out',
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
 * BOTH ROUTES. lib/geo-ext.js writes two force-install policies now --
 * ExtensionInstallForcelist and the ExtensionSettings dictionary -- so this
 * sweeps both: the numbered slots here, and the dictionary in
 * sweepExtSettings() below, which this function calls. One entry point, so no
 * caller can clean up half of it.
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

    //  FIRST, and read-only: the allowlist half has to look at the machine
    //  BEFORE the loops below delete the very entries that prove which id is
    //  ours. An allowlist value is a bare id -- there is no update_url in it to
    //  recognise -- so its only proof is a loopback-served entry elsewhere, and
    //  that proof is what this sweep is about to destroy.
    const proven = ourLoopbackIds(opts);
    const allowed = opts.legacyOnly ? 0 : sweepAllowlist(log, proven);
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
    removed += sweepExtSettings(log, opts);
    return removed + allowed;
}

/**
 * The same sweep for the SECOND route -- the ExtensionSettings dictionary.
 *
 * Journal-independent on purpose, exactly like the forcelist half above: the
 * journal lives in the state directory, and a user who deletes that directory
 * by hand, or an install that was rolled back, must not be left with a policy
 * pointing at a loopback port for the rest of the machine's life.
 *
 * The recognition rule is the value's own SHAPE, and it has to be, because
 * this is one value holding many extensions:
 *
 *   a 32-letter id whose update_url is http://127.0.0.1:<port>/...
 *       served by lib/ext-host.js and by nothing else on earth.
 *
 * Every other key in that dictionary belongs to whoever put it there -- a
 * workplace `"*"` rule, a required extension, a blocked permission list -- and
 * is written back untouched. The VALUE is deleted only when taking ours out
 * leaves it empty, which is the same "only if we are what emptied it" rule the
 * forcelist subkey follows.
 */
function sweepExtSettings(log, opts = {}) {
    const loopback = /^https?:\/\/127\.0\.0\.1(:\d+)?\//i;
    const isOurs = (id, cfg) =>
        id === LEGACY_FAKE_ID ||
        (opts.alsoId ? id === opts.alsoId : false) ||
        (!opts.legacyOnly && /^[a-p]{32}$/.test(id) &&
         loopback.test(String((cfg && cfg.update_url) || '')));

    let removed = 0;
    for (const id of Object.keys(POLICY_KEYS)) {
        const key = POLICY_KEYS[id];
        const raw = regValue(key, EXT_SETTINGS);
        if (raw == null) continue;

        let cur;
        try { cur = JSON.parse(raw); } catch (e) { continue; }
        if (!cur || typeof cur !== 'object' || Array.isArray(cur)) continue;

        const hits = Object.keys(cur).filter(k => isOurs(k, cur[k]));
        if (!hits.length) continue;
        for (const k of hits) delete cur[k];

        const name = (browsers.byId(id) || {}).name || id;
        const left = Object.keys(cur).length;
        const gone = left ? regWriteSz(key, EXT_SETTINGS, JSON.stringify(cur))
                          : shq(`reg delete "${key}" /v ${EXT_SETTINGS} /f`);
        if (gone) removed += hits.length;
        else log.warn(`Could not remove our ExtensionSettings entry from ${name} -- ` +
                      'administrator rights?');
    }
    if (removed) log.info(`Removed ${removed} of our ExtensionSettings force-install entry/ies`);
    return removed;
}

/**
 * Which extension ids on THIS machine can be proved to be ours, read-only.
 *
 * The allowlist sweep below needs this and cannot work without it. Route 4 --
 * ExtensionInstallAllowlist -- stores a BARE id in a numbered slot:
 *
 *     HKLM\SOFTWARE\Policies\Google\Chrome\ExtensionInstallAllowlist\1 = <id>
 *
 * There is no update_url in it, no path, no loopback port -- nothing about the
 * value's shape says who wrote it. A workplace that allows one extension by id
 * writes a byte-identical value. So "delete any 32-letter id" would be us
 * deleting an administrator's policy, and this app does not do that.
 *
 * The proof therefore has to come from somewhere else on the machine, and it
 * does: OUR id is simultaneously named by at least one loopback-served entry,
 * in the forcelist, in the ExtensionSettings dictionary, or in the fork's own
 * External Extensions provider key. Every one of those carries
 * http://127.0.0.1:<port>/, which only lib/ext-host.js answers. An id that
 * appears in the allowlist AND in one of those is ours beyond argument; an id
 * that appears only in the allowlist is left alone, permanently.
 *
 * This is why sweepForcelists() calls it FIRST -- the proof is exactly what
 * that function is about to delete.
 *
 * @param {object} [opts]
 * @param {string} [opts.alsoId]  a configured Web Store id, ours by definition
 * @returns {Set<string>}
 */
function ourLoopbackIds(opts = {}) {
    const loop = /^https?:\/\/127\.0\.0\.1(:\d+)?\//i;
    const ids = new Set();
    if (opts.alsoId) ids.add(opts.alsoId);

    for (const id of Object.keys(POLICY_KEYS)) {
        //  Route 1 -- "<id>;<update_url>" in numbered slots.
        const fl = regValues(`${POLICY_KEYS[id]}\\${FORCELIST}`);
        for (const v of Object.values(fl)) {
            const m = String(v).match(/^([a-p]{32});(.+)$/i);
            if (m && loop.test(m[2])) ids.add(m[1].toLowerCase());
        }
        //  Route 2 -- the ExtensionSettings dictionary.
        const raw = regValue(POLICY_KEYS[id], EXT_SETTINGS);
        if (raw != null) {
            let cur = null;
            try { cur = JSON.parse(raw); } catch (e) { cur = null; }
            if (cur && typeof cur === 'object' && !Array.isArray(cur)) {
                for (const [k, cfg] of Object.entries(cur)) {
                    if (/^[a-p]{32}$/.test(k) &&
                        loop.test(String((cfg && cfg.update_url) || ''))) ids.add(k.toLowerCase());
                }
            }
        }
    }
    //  Route 3 -- the External Extensions provider, in both registry views.
    for (const row of browsers.externalRoots('all')) {
        for (const view of browsers.REG_VIEWS) {
            let out;
            try { out = sh(`reg query "${row.key}" /reg:${view}`); }
            catch (e) { continue; }
            for (const line of out.split(/\r?\n/)) {
                const m = line.match(/\\([a-p]{32})\s*$/);
                if (!m) continue;
                const url = regValueView(`${row.key}\\${m[1]}`, 'update_url', view);
                if (url && loop.test(url)) ids.add(m[1].toLowerCase());
            }
        }
    }
    return ids;
}

/**
 * The same net under ROUTE 4 -- ExtensionInstallAllowlist.
 *
 * lib/geo-ext.js's own journal is the precise mechanism (_restoreAllowlist);
 * this is what happens when the journal cannot help: state directory deleted by
 * hand, an install rolled back, an upgrade from a build that recorded slots
 * differently, or an uninstall of an app that was never once run.
 *
 * The rule is narrow on purpose. A slot goes only when its value is an id
 * `proven` names -- an id this machine simultaneously serves from its own
 * loopback -- and the subkey is pruned only when this sweep is what emptied it.
 * An allowlist that holds anyone else's id keeps it.
 *
 * @param {object} log
 * @param {Set<string>} proven  from ourLoopbackIds(), gathered BEFORE deletions
 * @returns {number} slots removed
 */
function sweepAllowlist(log, proven) {
    if (!proven || !proven.size) return 0;
    let removed = 0;
    for (const id of Object.keys(POLICY_KEYS)) {
        const key = `${POLICY_KEYS[id]}\\${ALLOWLIST}`;
        const before = regValues(key);
        const hits = Object.keys(before)
            .filter(k => proven.has(String(before[k]).trim().toLowerCase()));
        if (!hits.length) continue;
        for (const slot of hits) {
            if (!shq(`reg delete "${key}" /v "${slot}" /f`)) {
                log.warn('Could not remove our allowlist entry from ' +
                         `${(browsers.byId(id) || {}).name || id} -- administrator rights?`);
                continue;
            }
            removed += 1;
        }
        if (!Object.keys(regValues(key)).length) shq(`reg delete "${key}" /f`);
    }
    if (removed) {
        log.info(`Removed ${removed} of our extension-allowlist entry/ies -- the ` +
                 'permission that let the browser keep it enabled, gone with it');
    }
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
//  The boot pass -- the one moment no browser is running
// ════════════════════════════════════════════════════════════════════
//  WHAT CANNOT BE DONE WHILE WINDOWS IS UP
//  Two of the three extension routes are read by a Chromium browser ONCE, as
//  it starts:
//
//    * its external-extensions provider, HKLM\SOFTWARE\<vendor>\<browser>\
//      Extensions\<id> -- lib/geo-ext.js installExternal(). Not policy, so not
//      re-read live, and not decided by whether the machine is managed.
//    * the policy tree's initial load. Chromium DOES re-read policy live, so
//      this half is a belt-and-braces re-assert rather than the reason.
//
//  So an entry written while Chrome is open reaches that Chrome at its next
//  start and not before. There is exactly one instant when every browser on
//  the machine is guaranteed not to have started yet, and that instant is the
//  boot that follows the install. That is the real reason this app asks for one
//  restart -- not a convention borrowed from other installers.
//
//  WHY A SCHEDULED TASK AND NOT RunOnce
//  RunOnce is per-user and fires after logon, by which time a browser in the
//  user's Startup folder may already have read the old state. An ONSTART task
//  running as SYSTEM runs before any logon, which is the whole point, and it
//  has the rights HKLM needs without prompting anybody.
//
//  IT STAYS REGISTERED, AND THAT IS DELIBERATE
//  A browser the user installs next month must be covered too, and the boot
//  pass is what covers it without ever asking again. main.js re-registers it
//  when the app starts elevated and Windows says it is gone -- a cleanup tool,
//  another account's "optimiser" or a by-hand deletion in Task Scheduler all
//  end the coverage silently otherwise. That repair never raises a restart
//  card: the card belongs to install time, and re-registering is not new work
//  waiting for a boot. It is removed by --fp-teardown, and installer.nsh
//  removes it a second time in case the app could not run at all.
//
//  DETECTION UNDER SYSTEM
//  Chrome, Brave, Vivaldi and Opera all install per user, so their paths live
//  under %LOCALAPPDATA% -- and SYSTEM's %LOCALAPPDATA% is inside
//  config\systemprofile, where nothing is. A boot pass that trusted its own
//  environment would therefore report "no browsers found" on precisely the
//  machines this feature exists for. bootProfiles() reads the real profile
//  roots out of ProfileList and the pass re-detects once per profile.
const BOOT_TASK   = 'FreeProxy VPN Boot Setup';
const BOOT_MARKER = 'boot-pending.json';
const BOOT_RESULT = 'boot-result.json';

/** Real interactive user profile roots, from Windows' own list. */
function bootProfiles() {
    let out;
    try {
        out = sh('reg query "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\' +
                 'ProfileList" /s /v ProfileImagePath');
    } catch (e) { return []; }
    const dirs = [];
    for (const line of out.split(/\r?\n/)) {
        const i = line.indexOf('REG_EXPAND_SZ');
        const j = i < 0 ? line.indexOf('REG_SZ') : i;
        if (j < 0 || line.slice(0, j).trim() !== 'ProfileImagePath') continue;
        const p = line.slice(j + (i < 0 ? 6 : 13)).trim();
        //  The three service profiles are not people and have no browsers.
        if (/\\(systemprofile|LocalService|NetworkService)$/i.test(p)) continue;
        if (p && fs.existsSync(p) && !dirs.includes(p)) dirs.push(p);
    }
    return dirs;
}

/**
 * Run `fn` once per user profile with the environment that profile's browsers
 * were installed into, then put the environment back exactly as it was.
 *
 * When there are no profiles to walk -- or when this is not running as SYSTEM,
 * because the same code path is used by a normal app start -- `fn` still runs
 * once, with the environment untouched.
 */
function forEachProfile(fn) {
    const dirs = bootProfiles();
    if (!dirs.length) { fn(null); return; }
    const keep = { USERPROFILE: process.env.USERPROFILE,
                   LOCALAPPDATA: process.env.LOCALAPPDATA,
                   APPDATA: process.env.APPDATA };
    try {
        for (const p of dirs) {
            process.env.USERPROFILE  = p;
            process.env.LOCALAPPDATA = path.join(p, 'AppData', 'Local');
            process.env.APPDATA      = path.join(p, 'AppData', 'Roaming');
            browsers.resetCache();
            fn(p);
        }
    } finally {
        for (const k of Object.keys(keep)) {
            if (keep[k] == null) delete process.env[k];
            else process.env[k] = keep[k];
        }
        browsers.resetCache();
    }
}


/** The queued-work file the boot pass reads, or null without a stateDir. */
function bootJobFile(ctx) {
    return ctx && ctx.stateDir ? path.join(ctx.stateDir, BOOT_MARKER) : null;
}

/** The queued job, or null. */
function bootJob(ctx) {
    const f = bootJobFile(ctx);
    if (!f) return null;
    try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; }
}

/** Is the ONSTART task really registered? Asked of Windows, not remembered. */
function bootTaskRegistered() {
    return shq(`schtasks /query /tn "${BOOT_TASK}"`);
}

const XMLESC = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
                             .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Register the ONSTART task itself. No queued job is written, so a pass that
 * fires from this registration alone re-applies rather than reverting -- which
 * is exactly what a task kept alive for a browser installed next month is for.
 *
 * Built from XML rather than from schtasks' own flags: the flag form needs an
 * executable path quoted INSIDE an already-quoted /tr argument, which is the
 * kind of escaping that works until a user installs into a path with a space
 * in a place nobody tested. XML also carries an ExecutionTimeLimit, so a pass
 * that ever hung could not hold up a boot.
 *
 * @returns {boolean} registered AND confirmed by a query
 */
function registerBootTask(log) {
    const xml = path.join(os.tmpdir(), `fp-boot-${process.pid}.xml`);
    try {
        fs.writeFileSync(xml, '﻿' + [
            '<?xml version="1.0" encoding="UTF-16"?>',
            '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
            '  <RegistrationInfo>',
            '    <Author>FreeProxy VPN</Author>',
            '    <Description>Finishes browser setup before any browser starts. ' +
                'Removed when FreeProxy VPN is uninstalled.</Description>',
            '  </RegistrationInfo>',
            '  <Triggers><BootTrigger><Enabled>true</Enabled></BootTrigger></Triggers>',
            '  <Principals><Principal id="Author">',
            '    <UserId>S-1-5-18</UserId><RunLevel>HighestAvailable</RunLevel>',
            '  </Principal></Principals>',
            '  <Settings>',
            '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
            '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
            '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
            '    <AllowHardTerminate>true</AllowHardTerminate>',
            '    <StartWhenAvailable>true</StartWhenAvailable>',
            '    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>',
            '    <AllowStartOnDemand>true</AllowStartOnDemand>',
            '    <Enabled>true</Enabled><Hidden>false</Hidden>',
            '    <RunOnlyIfIdle>false</RunOnlyIfIdle><WakeToRun>false</WakeToRun>',
            '    <ExecutionTimeLimit>PT3M</ExecutionTimeLimit><Priority>7</Priority>',
            '  </Settings>',
            '  <Actions Context="Author"><Exec>',
            `    <Command>${XMLESC(process.execPath)}</Command>`,
            '    <Arguments>--fp-boot</Arguments>',
            '  </Exec></Actions>',
            '</Task>', '',
        ].join('\r\n'), 'utf16le');

        shq(`schtasks /create /tn "${BOOT_TASK}" /xml "${xml}" /f`);
    } catch (e) {
        log.warn('Could not schedule the boot pass: ' + e.message);
    }
    try { fs.unlinkSync(xml); } catch (e) {}

    if (!bootTaskRegistered()) {
        log.warn('The boot-time browser setup could not be scheduled -- administrator ' +
                 'rights? The app will apply what it can every time it starts instead.');
        return false;
    }
    log.info(`Boot pass scheduled as "${BOOT_TASK}" -- it runs as SYSTEM at every startup, ` +
             'before any browser can start, and is removed on uninstall');
    return true;
}

/**
 * Register the ONSTART task AND record what it has to do.
 *
 * The job file is what makes the restart card truthful: deferredWork() reads it
 * back, so "there is work waiting for a restart" is a statement about a file on
 * disk rather than about an install having happened.
 *
 * @returns {boolean} registered AND confirmed by a query
 */
function queueBootPass(log, ctx, job) {
    const f = bootJobFile(ctx);
    if (!f) return false;
    try {
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, JSON.stringify(
            { at: Date.now(), mode: 'apply', ...job }, null, 2), 'utf8');
    } catch (e) {
        log.warn('Could not record the queued boot work: ' + e.message);
    }
    return registerBootTask(log);
}

/** Remove the task and the queued work. Safe to call when neither exists. */
function unqueueBootPass(log, ctx) {
    let gone = false;
    if (bootTaskRegistered()) {
        gone = shq(`schtasks /delete /tn "${BOOT_TASK}" /f`);
        if (!gone) log.warn(`Could not remove the scheduled task "${BOOT_TASK}"`);
        else log.debug(`Scheduled task "${BOOT_TASK}" removed`);
    }
    for (const name of [BOOT_MARKER, BOOT_RESULT]) {
        try {
            const f = ctx && ctx.stateDir ? path.join(ctx.stateDir, name) : null;
            if (f && fs.existsSync(f)) fs.unlinkSync(f);
        } catch (e) {}
    }
    return gone;
}

// ════════════════════════════════════════════════════════════════════
//  The one restart -- and only when there is really work waiting for it
// ════════════════════════════════════════════════════════════════════
//  WHY THIS EXISTS
//  Every restart-requiring job was moved to install time so that connecting,
//  disconnecting and switching country never has to disturb a browser again.
//  The other half of that bargain is IDM's: ask for ONE restart at the end of
//  the install, then never interrupt the user again.
//
//  WHY IT IS EVIDENCE-BASED RATHER THAN UNCONDITIONAL
//  Because a restart that is not needed would be a false statement in a dialog
//  box. Two of the three things that could ask for one never do: Chromium reads
//  its policy subtree live (RegNotifyChangeKeyValue) and installs a
//  force-installed extension into a browser that is already open, and the
//  system proxy is broadcast with InternetSetOption. So the card is raised for
//  the two reasons that ARE real, and never for anything else.
//
//  REASON 1 -- WORK OF OURS THAT ONLY THE BOOT CAN DO.
//  A browser's external-extensions provider is read while the browser starts
//  and not again, so the offer only reaches Chrome, Brave and the other forks
//  at their next start. queueBootPass() schedules a SYSTEM pass at ONSTART to
//  make that the earliest possible moment for all of them at once; while that
//  job is queued and the machine has not booted since, there is genuinely
//  something waiting for a restart, and the card says so in those words.
//
//  REASON 2 -- A LOCKED FILE. If the app was running while an upgrade landed,
//  or the bundled Visual C++ redistributable found its own runtime in use,
//  Windows itself records the work it could not finish:
//
//    * PendingFileRenameOperations -- MoveFileEx(..., DELAY_UNTIL_REBOOT).
//      Filtered to OUR paths, so a pending rename that belongs to a Windows
//      update or another vendor's installer is not borrowed to nag the user.
//    * exit code 3010 from the redistributable, or NSIS's own reboot flag,
//      which installer.nsh passes through as --fp-reboot-pending.
//
//  Nothing here is guessed and nothing is inferred from something adjacent.
//  When the marker is written it names the reason, and main.js's
//  pendingRestart() shows it once and then clears it the moment os.uptime()
//  proves the machine has booted since.
const RESTART_MARKER = 'restart-pending.json';

function pendingFileRenames() {
    //  REG_MULTI_SZ comes back from reg.exe as one line with \0 between the
    //  strings. Only the source paths matter -- a rename is listed as
    //  source\0destination, and either half naming our tree is the signal.
    let out;
    try {
        out = sh('reg query "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager" ' +
                 '/v PendingFileRenameOperations');
    } catch (e) { return []; }
    const i = out.indexOf('REG_MULTI_SZ');
    if (i < 0) return [];
    return out.slice(i + 12).split(/\\0|\r?\n/)
        .map(s => s.trim()).filter(Boolean);
}

/**
 * The sentences the restart card is allowed to show, or an empty list.
 *
 * @param {object} log
 * @param {object} [ctx]  when it carries a stateDir, a boot pass that is queued
 *                        and has not run yet counts as pending work. Called
 *                        without one -- as the marker test does -- only
 *                        Windows' own evidence can produce a reason.
 */
function deferredWork(log, ctx) {
    const why = [];

    //  Ours: the pass that has to run before any browser starts. `at` is when
    //  it was queued; if the machine has booted since, the pass has already had
    //  its chance and nothing is waiting any more.
    const job = bootJob(ctx);
    if (job && typeof job.at === 'number' &&
        job.at > Date.now() - os.uptime() * 1000 + 60000) {
        const names = Array.isArray(job.browsers) && job.browsers.length
            ? browsers.names(job.browsers).join(', ') : 'your browsers';
        why.push(job.mode === 'revert'
            ? `${names} still have this app's extension loaded, and a browser only drops ` +
              'an extension an installer offered it when it next starts -- one restart ' +
              'clears it from all of them at once.'
            : `${names} read an extension offered by an installer only while they are ` +
              'starting up, so the last step for them runs during the next restart, ' +
              'before any browser opens.');
    }

    if (process.argv.includes('--fp-reboot-pending')) {
        why.push('Windows reported that a component this installer set up -- the Visual ' +
                 'C++ runtime, or a file that was in use -- finishes installing at the ' +
                 'next restart.');
    }

    //  Our own paths only. `freeproxy` covers C:\ProgramData\freeproxy-vpn and
    //  the installed program directory, which electron-builder names after the
    //  product; the executable's own directory covers a custom install path.
    const mine = [/freeproxy/i, new RegExp(
        path.dirname(process.execPath).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')];
    const hits = pendingFileRenames().filter(p => mine.some(re => re.test(p)));
    if (hits.length) {
        why.push(`${hits.length} file(s) belonging to FreeProxy VPN were in use during the ` +
                 'install, so Windows scheduled them to be replaced at the next restart.');
        log.debug('Files Windows deferred to the next boot', { paths: hits.slice(0, 8) });
    }

    return why;
}

/**
 * Write, or clear, the marker main.js's pendingRestart() reads.
 *
 * Clearing it when nothing is pending matters as much as writing it: an
 * upgrade over an install that DID need a restart must not inherit its card.
 */
function noteRestart(log, ctx) {
    const dir = ctx.stateDir;
    if (!dir) return [];
    const file = path.join(dir, RESTART_MARKER);
    const why = deferredWork(log, ctx);
    try {
        if (!why.length) { if (fs.existsSync(file)) fs.unlinkSync(file); return []; }
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ at: Date.now(), why }, null, 2), 'utf8');
        log.warn('One restart is needed to finish this install -- the app will offer it ' +
                 'once and then never ask again', { why });
    } catch (e) {
        log.warn('Could not record the pending restart: ' + e.message);
    }
    return why;
}

/**
 * Chromium browsers that are running RIGHT NOW, as browser ids.
 *
 * Asked of tasklist rather than of anything this app remembers, because the
 * only thing it is used for is deciding whether a revert has finished -- and a
 * browser the user opened thirty seconds ago must count.
 *
 * Only browsers that are INSTALLED are considered: chrome.exe is the image name
 * of both Chrome and a plain Chromium build, and opera.exe of both Opera and
 * Opera GX, so matching the whole table would report a browser this machine
 * does not have. Two forks that are both installed and share an image name
 * still both report, which over-names by one in a warning line and never
 * under-reports the reason a restart is offered.
 */
function runningBrowsers() {
    let out = '';
    try { out = sh('tasklist /fo csv /nh'); } catch (e) { return []; }
    const low = out.toLowerCase();
    return browsers.detectChromium()
        .filter(b => b.exe && low.includes('"' + b.exe.toLowerCase() + '"'))
        .map(b => b.id);
}

// ════════════════════════════════════════════════════════════════════
//  --fp-boot  (the ONSTART pass)
// ════════════════════════════════════════════════════════════════════
/**
 * Apply all three extension routes once per real user profile, and return what
 * each pass reported, unioned.
 *
 * The per-profile loop is what makes a per-user Chrome or Brave visible at all
 * when this runs as SYSTEM -- see forEachProfile(). Every write it drives is
 * HKLM and idempotent, so a browser that two users both have is written once
 * and read back twice.
 */
function applyRoutes(log, ext) {
    const auto = new Set(), tried = new Set(), ext3 = new Set(), seen = new Set();
    forEachProfile(() => {
        for (const b of browsers.detectChromium()) seen.add(b.id);
        try { (ext.install() || []).forEach(id => auto.add(id)); }
        catch (e) { log.warn('Force-install pass failed: ' + e.message); }
        (ext.attempted || []).forEach(id => tried.add(id));
        (ext.external || []).forEach(id => ext3.add(id));
    });
    return { auto: [...auto], tried: [...tried], external: [...ext3], found: [...seen] };
}

// ════════════════════════════════════════════════════════════════════
//  --fp-deliver   (the logon helper)
// ════════════════════════════════════════════════════════════════════
//  WHAT THIS FIXES, and it is a measured bug rather than an extra feature.
//
//  All four routes were being written correctly and no browser had the
//  extension. .build/probe-deliver.js served the real payload on the port the
//  live registry already names and launched Edge, Chrome and Brave into
//  throwaway profiles: every one of them fetched /updates.xml and the CRX
//  WITHIN FIVE SECONDS of starting, and unpacked it. So the policies were never
//  the problem -- the port was dead. lib/ext-host.js answers it only while the
//  app, the installer or the boot pass is running, and all three had exited long
//  before the user opened a browser. A browser asking a dead port installs
//  nothing, which from the outside is indistinguishable from a policy that was
//  never written.
//
//  This task is the missing half: at logon, serve the two files the bundle on
//  disk holds, on exactly the port every policy names, and exit the moment every
//  installed browser's own profile shows the extension. It writes no policy,
//  holds no signing key, opens nothing but 127.0.0.1, and needs no elevation.
async function taskDeliver(log, ctx) {
    const r = await deliver.serveUntilDelivered({ stateDir: ctx.stateDir, log });
    if (!r.ok && r.why === 'no-bundle') {
        //  Nothing to serve is not a crash: an install that could not stage the
        //  extension, or a state directory the user deleted. The next elevated
        //  app start writes the bundle again.
        log.warn('No extension package is staged for delivery -- nothing served');
        return EXIT.manual;
    }
    if (!r.ok) return EXIT.stageFailed;
    return EXIT.ok;
}

/**
 * The boot pass. Nothing is running: no browser holds a profile, no policy has
 * been read yet, and every entry written here is in place before the first
 * browser of the session starts -- which is the only thing a restart actually
 * buys, and the reason the app asked for one.
 *
 * It re-applies rather than assumes. A browser installed since the last boot is
 * picked up, a value someone removed is put back, and the result is written
 * where the app can read it so the coverage report is never a guess.
 */
async function taskBoot(log, ctx) {
    const job = bootJob(ctx) || { mode: 'apply' };
    log.info(`Boot pass starting (mode: ${job.mode || 'apply'}) -- no browser has started yet`);

    if (job.mode === 'revert') {
        //  Uninstall left something that only a browser start can finish. The
        //  app is gone by now in the normal case, so this path exists for the
        //  one where teardown ran but could not complete its sweeps.
        try { sweepForcelists(log, { alsoId: process.env.FP_GEO_WEBSTORE_ID || null }); }
        catch (e) { log.warn('Boot revert sweep failed: ' + e.message); }
        try { sweepExternal(log); }
        catch (e) { log.warn('Boot external sweep failed: ' + e.message); }
        unqueueBootPass(log, ctx);
        log.success('Boot revert complete -- nothing of this app is left in any browser');
        return EXIT.ok;
    }

    const ext = ctx.geoExt();
    let prepared = null;
    try { prepared = await ext.prepare(); }
    catch (e) { log.error('Boot pass could not stage the extension', { err: e.message }); }
    if (!prepared) return EXIT.stageFailed;

    const r = applyRoutes(log, ext);
    let present = {}, states = {};
    try { present = ext.presence(); } catch (e) {}
    //  The reason, not just the word: location and disable_reasons straight out
    //  of each browser's own prefs. That is what makes "delivered but switched
    //  off" distinguishable from "never arrived" when this file is read back
    //  weeks later, instead of both showing up as "not installed".
    try { if (typeof ext.states === 'function') states = ext.states(); } catch (e) {}
    try { ext.host.stop(); } catch (e) {}

    //  The boot pass runs as SYSTEM before any browser starts, so it is the
    //  right place to write the policies and the WRONG place to wait for a
    //  browser to fetch: nobody is logged on yet. prepare() has just rewritten
    //  the bundle on disk with this boot's port; the logon helper is what serves
    //  it. Registered here as well as at install time so a task somebody deleted
    //  is repaired by the next restart rather than never.
    try {
        if (!deliver.deliverTaskRegistered()) deliver.registerDeliverTask(log);
        else log.debug(`Scheduled task "${deliver.DELIVER_TASK}" is registered`);
    } catch (e) { log.warn('Could not schedule the delivery helper: ' + e.message); }

    //  What the browsers themselves say, recorded next to what we attempted.
    //  A browser that has not started since cannot have accepted anything yet,
    //  so 'absent' here is not a failure -- it is simply too early, and the
    //  app's own report reads this again once the user has opened a browser.
    try {
        fs.writeFileSync(path.join(ctx.stateDir, BOOT_RESULT), JSON.stringify(
            { at: Date.now(), id: prepared.id, version: prepared.version,
              profiles: bootProfiles().length, ...r, presence: present, states }, null, 2), 'utf8');
    } catch (e) { log.warn('Could not record the boot result: ' + e.message); }

    //  The queued job is done. The TASK stays: a browser installed next month
    //  is covered by the next boot without anybody being asked again.
    try { const f = bootJobFile(ctx); if (f && fs.existsSync(f)) fs.unlinkSync(f); }
    catch (e) {}

    log.success('Boot pass complete -- ' +
                `browsers found: ${browsers.names(r.found).join(', ') || 'none'}; ` +
                `policy force-install: ${browsers.names(r.auto).join(', ') || 'none'}; ` +
                `external-extensions entry: ${browsers.names(r.external).join(', ') || 'none'}`);
    return EXIT.ok;
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
    let routes = { auto: [], tried: [], external: [], found: [] };
    try {
        //  Once per user profile on the machine, not once for whoever happens
        //  to be running the installer: a second account's Chrome is just as
        //  much "every browser" as the first one's.
        routes = applyRoutes(log, ext);
        auto = routes.auto;
    } catch (e) { log.error('Force-install failed', { err: e.message }); }

    let manual = [], enable = [], restart = [];
    try {
        manual = ext.needManualLoad();
        //  Usually empty at install time -- nothing has started a browser yet --
        //  but on a repair or a re-install the previous delivery is already in
        //  the profile, switched off, and calling that "needs a manual load"
        //  would send the user to load a folder that is already loaded.
        enable = typeof ext.needEnable === 'function' ? ext.needEnable() : [];
        //  And the third case, which at install time is the COMMON one: the
        //  routes were just written and every browser on the machine either is
        //  closed or was open the whole time, so nothing has arrived anywhere
        //  yet. Those browsers are set up and waiting for a start -- measured:
        //  Brave, started 12 minutes after the entry was written, had the
        //  extension 3 minutes into that start; Chrome, open since before it was
        //  written, still had nothing hours later. needManualLoad() excludes
        //  them, so this is the list that keeps them from silently vanishing
        //  out of the summary altogether.
        restart = typeof ext.awaitingStart === 'function' ? ext.awaitingStart() : [];
        ext.writeHowTo(manual, enable, restart);
    }
    catch (e) { log.warn('Writing HOW-TO-ENABLE.txt failed: ' + e.message); }

    //  The CRX server only existed to hand the package to a browser, and no
    //  browser is going to ask for it during an install. What replaces it is the
    //  bundle prepare() has just written to disk plus the logon helper below --
    //  because the entry the routes leave behind points at 127.0.0.1:<port>, and
    //  until now NOTHING answered that port once the installer exited. That, and
    //  not the policies, is why a browser opened after the install had no
    //  extension: measured with .build/probe-deliver.js, where all three
    //  browsers fetched within five seconds as soon as the port was alive.
    try { ext.host.stop(); } catch (e) {}

    //  Registered before the restart question, and started right now as well:
    //  the user is not obliged to restart, and a browser opened five minutes
    //  from now must still be served. The task itself is what covers every
    //  later logon.
    try {
        deliver.registerDeliverTask(log);
        deliver.runDeliverTaskNow(log);
    } catch (e) { log.warn('Could not schedule the delivery helper: ' + e.message); }

    const here = browsers.names(routes.found.length
        ? routes.found : browsers.detectChromium().map(b => b.id));
    log.info('Install-time browser setup -- ' +
             `Chromium found: ${here.join(', ') || 'none'}; ` +
             `extension force-installed: ${browsers.names(auto).join(', ') || 'none'}; ` +
             (enable.length
                 ? `already delivered, awaiting one switch: ${browsers.names(enable).join(', ')}; `
                 : '') +
             (restart.length
                 ? `set up, arrives at that browser's next start or within ~2 h: ` +
                   `${browsers.names(restart).join(', ')}; `
                 : '') +
             `needs one manual load: ${browsers.names(manual).join(', ') || 'none'}`);

    //  The second route is reported separately and in a different vocabulary,
    //  on purpose. ExtensionSettings is WRITTEN into every policy-capable
    //  browser present, Chrome and Brave included, but a Chromium that is not
    //  domain-joined, Azure-AD-joined or cloud-enrolled discards an off-store
    //  force-install during policy validation. So this line says "written",
    //  never "installed": only presence(), which reads the browser's own
    //  profile, is allowed to claim an extension is really running.
    const tried = browsers.names((routes.tried || []).filter(id => !auto.includes(id)));
    if (tried.length) {
        log.info(`ExtensionSettings force-install entry also written for ${tried.join(', ')} ` +
                 '-- it takes effect there on a managed machine (domain / Azure AD / Chrome ' +
                 'Browser Cloud Management); on a personal PC the third route below is what ' +
                 'actually delivers to those browsers, and Chromium then asks the user to ' +
                 'accept it once -- both cases are described in HOW-TO-ENABLE.txt');
    }

    //  The third route, and the only one that is not policy -- so it is the
    //  only one Chrome's management gate does not decide. It is also the one
    //  that cannot take effect now: a browser reads its external-extensions
    //  provider while it starts. Hence the boot pass, and hence the one
    //  restart the app is about to offer.
    //
    //  MEASURED, freshly started browsers, delivery helper alive on the port the
    //  entry names: Edge unpacks it at location 7 with no disable reason and
    //  starts its service worker; Chrome and Brave unpack the same bytes at
    //  location 6 and hold them at disable_reasons 8192 (EXTERNAL_EXTENSION)
    //  until the user accepts. So this route lands everywhere; on Chrome and
    //  Brave it lands switched off, which is the one thing left for the user.
    const ext3 = browsers.names(routes.external || []);
    if (ext3.length) {
        log.info(`External-extensions entry written for ${ext3.join(', ')} -- each of those ` +
                 'browsers reads it the next time it starts, which is what the restart is for; ' +
                 'Edge then enables it by itself, Chrome and Brave keep it switched off until ' +
                 'the user accepts it once');
    }

    //  Queue that pass BEFORE noteRestart(), because the queue is what makes
    //  the restart card truthful: with nothing waiting, deferredWork() finds
    //  no reason and no card is shown.
    if (ext3.length || routes.found.length) {
        try {
            queueBootPass(log, ctx, { mode: 'apply', browsers: routes.found,
                                      id: prepared.id, external: routes.external });
        } catch (e) { log.warn('Could not queue the boot pass: ' + e.message); }
    }


    const gecko = browsers.names(browsers.detectGecko().map(b => b.id));
    if (gecko.length) {
        //  Nothing to install for these. Gecko takes a real, documented
        //  coordinate override through a pref, which the app writes on connect
        //  and removes on disconnect -- there is no extension involved and
        //  nothing for an installer to do.
        log.info(`${gecko.join(', ')}: no extension needed -- spoofed through ` +
                 'geo.provider.network.url when you connect');
    }

    //  Last, because it is a statement about the whole install: everything
    //  above was applied to the running system, and this records the one thing
    //  -- if any -- that Windows itself put off until the next boot.
    noteRestart(log, ctx);

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

    //  Route 3, table-wide, with no journal needed: the subkey is named after
    //  an id that is generated per machine, so an install whose ProgramData was
    //  deleted by hand is the case this catches.
    try { sweepExternal(log); }
    catch (e) { log.warn('External-extensions sweep failed: ' + e.message); }

    //  The boot pass must not outlive the app: its action points at an
    //  executable the installer is about to delete.
    try { unqueueBootPass(log, ctx); }
    catch (e) { log.warn('Removing the boot task failed: ' + e.message); }

    //  Same for the logon helper, and for the payload it served. Its action
    //  points at the same executable, and a task left behind would try to serve
    //  a CRX that no longer exists at every logon forever.
    try { deliver.unregisterDeliverTask(log, ctx.stateDir); }
    catch (e) { log.warn('Removing the delivery task failed: ' + e.message); }

    //  It refused to go. schtasks needs elevation and an uninstaller can be
    //  started without it, so this is a real outcome rather than a theoretical
    //  one -- and it matters, because a task that fires again with no job file
    //  defaults to APPLY and would put back every entry just removed. Queued to
    //  clean up instead; taskBoot's revert branch removes the task itself, so
    //  this repairs it on the first boot that follows.
    try {
        if (bootTaskRegistered() && ctx.stateDir) {
            fs.mkdirSync(ctx.stateDir, { recursive: true });
            fs.writeFileSync(bootJobFile(ctx), JSON.stringify(
                { at: Date.now(), mode: 'revert' }, null, 2), 'utf8');
            log.warn(`The scheduled task "${BOOT_TASK}" could not be removed -- it is now ` +
                     'queued to clean up rather than to install, and it takes itself out ' +
                     'the first time it runs');
        }
    } catch (e) { log.warn('Could not disarm the boot task: ' + e.message); }

    //  A browser that is OPEN right now still has the extension in its profile.
    //  Its provider entry is gone, so Chromium removes an externally-installed
    //  extension whose offer has disappeared -- but it does that check while it
    //  STARTS, so the extension is only really out of that browser once it has
    //  been restarted. That is the one honest reason to offer a restart here,
    //  and installer.nsh only asks when this is what teardown found.
    const openNow = runningBrowsers();
    if (openNow.length) {
        log.warn(`${browsers.names(openNow).join(', ')} ${openNow.length > 1 ? 'are' : 'is'} ` +
                 'open, so the extension leaves ' +
                 `${openNow.length > 1 ? 'them' : 'it'} at the next start -- a restart ` +
                 'finishes the revert for every browser at once');
    }

    //  ProxySettings, the WebRTC/DNS leak policies and any stale
    //  GeolocationAllowedForUrls, across the WHOLE browser table -- a fork
    //  uninstalled since this app last ran still has our values in HKLM.
    try { await ctx.restoreBrowserPolicy(); }
    catch (e) { log.warn('Reverting browser policy failed: ' + e.message); }

    sweepNetwork(log);
    sweepHosts(log);
    sweepCerts(log);

    //  Before sweepTemp, which removes the directory this lives in -- but done
    //  explicitly anyway, because a custom stateDir would survive it and an
    //  uninstall must not leave a card behind that asks the user to restart for
    //  an app that is gone.
    try {
        if (ctx.stateDir) {
            const marker = path.join(ctx.stateDir, RESTART_MARKER);
            if (fs.existsSync(marker)) fs.unlinkSync(marker);
        }
    } catch (e) { log.warn('Removing the restart marker failed: ' + e.message); }

    sweepTemp(log);

    log.success('Uninstall revert complete -- system proxy, DNS, IPv6, firewall rules, ' +
                'browser policy, force-installed extension, the boot task and Gecko ' +
                'location prefs are all back the way they were. The installer removes ' +
                'this app\'s own directories next.');
    return openNow.length ? EXIT.rebootAdvised : EXIT.ok;
}

// ════════════════════════════════════════════════════════════════════
//  entry point
// ════════════════════════════════════════════════════════════════════
//  An installer that hangs is worse than one that fails: NSIS's ExecWait has
//  no timeout of its own, so one stuck reg.exe would leave the user staring at
//  a progress bar with no way out. Teardown gets longer because certificate
//  enumeration and netsh are both slow. The boot pass gets the shortest budget
//  of the three and the scheduled task caps it at three minutes as well: no
//  step of this app may ever be the reason a machine is slow to start.
//
//  --fp-deliver is the one job that is SUPPOSED to sit there for a long time:
//  it is waiting for a human to open a browser, and it exits by itself the
//  moment they all have the extension. Its own cap is deliver.CAP_MS and the
//  task's ExecutionTimeLimit is PT4H, so the watchdog here is only a backstop
//  behind both and must never be the thing that fires first.
const WATCHDOG_MS = { setup: 120000, teardown: 240000, boot: 90000,
                      deliver: deliver.CAP_MS + 300000 };

/**
 * @param {'setup'|'teardown'|'boot'|'deliver'} task
 * @param {object} ctx  { Logger, isRunAsAdmin, geoEngine, geoExt,
 *                        restoreBrowserPolicy, stateDir }
 * @returns {Promise<number>} the process exit code
 */
function runInstallerTask(task, ctx) {
    const log = ctx.Logger;
    log.info(`Installer task: --fp-${task} (headless, no window)`);
    //  Not warned for --fp-deliver: that one needs no elevation by design. It
    //  serves two files from a directory that is world-readable and reads the
    //  profiles of the user who is logged on, and running it elevated would be
    //  asking for rights it has no use for.
    if (task !== 'deliver' && !ctx.isRunAsAdmin()) {
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
        const RUN = { setup: taskSetup, teardown: taskTeardown, boot: taskBoot,
                      deliver: taskDeliver };
        Promise.resolve()
            .then(() => (RUN[task] || taskSetup)(log, ctx))
            .then(done, e => {
                log.error(`--fp-${task} crashed`,
                          { err: (e && e.stack ? String(e.stack) : String(e)).split('\n')[0] });
                done(EXIT.crashed);
            });
    });
}

module.exports = {
    installerTask, runInstallerTask,
    sweepForcelists, sweepExtSettings, sweepAllowlist, ourLoopbackIds,
    sweepNetwork, sweepHosts, sweepCerts, sweepTemp,
    deferredWork, noteRestart, EXIT, FW_RULES, LEGACY_FAKE_ID, PROXY_KEY, RESTART_MARKER,
    BOOT_TASK, BOOT_MARKER, BOOT_RESULT, bootProfiles, forEachProfile, bootJob,
    bootJobFile, bootTaskRegistered, registerBootTask, queueBootPass, unqueueBootPass,
    applyRoutes, runningBrowsers,
    //  Re-exported so main.js and the tests have one place to reach the
    //  delivery half from, the same way they reach the boot task.
    DELIVER_TASK: deliver.DELIVER_TASK,
    deliverTaskRegistered: deliver.deliverTaskRegistered,
    registerDeliverTask: deliver.registerDeliverTask,
    unregisterDeliverTask: deliver.unregisterDeliverTask,
    runDeliverTaskNow: deliver.runDeliverTaskNow,
};
