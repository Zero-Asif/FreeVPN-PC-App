'use strict';
// ════════════════════════════════════════════════════════════════════
//  lib/geo-spoof.js
//
//  WHAT THIS MODULE IS FOR
//  -----------------------
//  Connecting to a country has to change what the machine reports as its
//  location -- not only inside this app's own window. That means three
//  separate systems, each with its own provider, and none of them takes
//  orders from the exit IP:
//
//    1. Chromium browsers (Edge, Chrome, Brave)   -- lib/geo-ext.js
//    2. The Windows location platform             -- lfsvc + sensor ACLs
//    3. Firefox                                   -- network provider pref
//
//  Only 2 and 3 live here. Chromium is handled by lib/geo-ext.js, which
//  installs the bundled extension; this module keeps the layers that are
//  pure registry and pure file work.
//
//  WHAT IS HONESTLY ACHIEVABLE, AND WHAT IS NOT
//  --------------------------------------------
//  SPOOF -- returning the connected country's actual coordinates -- is
//  achievable everywhere a page or a Gecko/Chromium provider is involved:
//      * this app's own window, over CDP Emulation.setGeolocationOverride
//      * Firefox, whose geo.provider.network.url pref is a documented,
//        supported way to point the provider at fixed coordinates
//      * Chromium pages, via the bundled extension replacing
//        navigator.geolocation in the page's own JS world (lib/geo-ext.js)
//
//  It is NOT achievable for arbitrary native Windows applications.
//  Windows exposes no supported API for injecting coordinates into the
//  system location provider; the Windows 8 "Location Platform simulator"
//  registry values that circulate online are ignored by every current
//  build. For native apps the honest outcome is denial, not a fake fix,
//  and the caller is expected to report it that way.
//
//  BLOCKING IS NOT A SUBSTITUTE FOR SPOOFING
//  -----------------------------------------
//  An earlier version of this module switched the Chromium geolocation
//  permission OFF -- DefaultGeolocationSetting=2 plus a wildcard
//  GeolocationBlockedForUrls rule, and every stored "Allow" grant flipped to
//  Block in the profile's own Preferences. Sites that fall back to the exit
//  IP then showed the right country, which made it look like a fix. It was
//  not one:
//
//    * pages reported "User denied the request for Geolocation"
//    * anything using coordinates directly -- Google Maps -- broke outright
//    * a POLICY rule outranks the user's own choice, so Location showed as
//      Block in site settings and was GREYED OUT; the user could not turn
//      their own permission back on
//
//  That code is gone. It is not disabled, not behind a flag: removed. What
//  survives of it here is teardown only -- clearBlockingPolicy() and
//  restoreProfiles() exist so a machine that still carries those values from
//  the older build gets them cleaned up and its grants handed back.
//
//  EVERY MUTATION IS RECORDED BEFORE IT IS MADE
//  --------------------------------------------
//  geo-restore.json is flushed BETWEEN layers, always ahead of the change
//  it describes, and it records the absence of a value as carefully as its
//  presence. Recording afterwards would leave exactly one unrecoverable
//  state -- machine changed, nothing written down -- and that is the state
//  a crash finds. restoreLeftovers() runs at startup and undoes whatever a
//  previous run left behind, so a hard kill while connected cannot leave
//  the user's location permanently switched off.
// ════════════════════════════════════════════════════════════════════

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const browsers = require('./browsers');

// ── Chromium policy keys ────────────────────────────────────────────
//  Every fork's own policy namespace, from lib/browsers.js. Chrome's key does
//  not reach Edge or Brave, and each fork the older build could have written
//  to has to be swept.
//
//  The FULL table on purpose, not only what is installed: this is teardown of
//  a policy an earlier version of this app wrote, and a browser that has since
//  been uninstalled can still have the key sitting in HKLM. Deleting a value
//  that is not there costs one failed reg.exe call and nothing else.
const POLICY_KEYS = (() => {
    const out = {};
    for (const b of browsers.CHROMIUM) if (b.policy) out[b.id] = 'HKLM\\' + b.policy;
    return out;
})();

//  The two values the OLDER build wrote inside those keys. Named once so the
//  startup cleanup in main.js and the teardown here cannot drift apart.
//  Nothing writes them any more; clearBlockingPolicy() only removes them.
const POLICY_VALUE   = 'DefaultGeolocationSetting';
const POLICY_SUBKEY  = 'GeolocationBlockedForUrls';

/**
 * The image name for a browser named in a journal record.
 *
 * Records written by older builds hold a display name ('Edge', 'Chrome');
 * this build writes the id ('edge'). Both resolve, so a journal from before
 * the change is still restorable -- those records are on disk on real
 * machines right now.
 */
function browserExe(label) {
    if (!label) return null;
    const s = String(label).toLowerCase();
    const b = browsers.byId(s) || browsers.ALL.find(x => x.name.toLowerCase() === s);
    return b ? b.exe : null;
}

// ── Windows location platform ───────────────────────────────────────
//  The location capability's sensor GUID. SensorPermissionState 0 denies
//  it; the ConsentStore entry is what Settings > Privacy > Location reads.
const SENSOR_KEY =
    'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Sensor\\Overrides\\' +
    '{BFA794E4-F964-4FDB-90F6-51056BFE4B44}';
const CONSENT_KEY =
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\' +
    'ConsentStore\\location';

//  The name of the one firewall rule this app owns. Named, not anonymous, so
//  restore is exact and so a user inspecting their firewall can see who put
//  it there and remove it by hand if they want to.
const FW_RULE = 'FreeProxy VPN - block Windows location resolution';

// ── small shell helpers ─────────────────────────────────────────────
function sh(cmd) {
    //  execSync goes through cmd.exe, so reg's /v /t /d /f are literal
    //  switches and need no escaping games.
    return execSync(cmd, { windowsHide: true, encoding: 'utf8', stdio: 'pipe' });
}
function shq(cmd) { try { sh(cmd); return true; } catch (e) { return false; } }

function regRead(key, value) {
    try {
        const out = sh(`reg query "${key}" /v "${value}"`);
        //  "    ValueName    REG_DWORD    0x1"
        const line = out.split(/\r?\n/).find(l => new RegExp('\\s' + value + '\\s+REG_', 'i').test(l));
        if (!line) return null;
        const m = line.trim().match(/^\S+\s+REG_\w+\s+(.*)$/);
        return m ? m[1].trim() : null;
    } catch (e) { return null; }
}

function serviceRunning(name) {
    try { return /STATE\s*:\s*4\s+RUNNING/.test(sh(`sc query ${name}`)); }
    catch (e) { return false; }
}

function psq(script) {
    //  PowerShell, not netsh: the firewall rule below is scoped to a SERVICE,
    //  and -Service on New-NetFirewallRule is the reliable way to express that.
    try {
        execSync('powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ' +
                 JSON.stringify(script),
                 { windowsHide: true, encoding: 'utf8', stdio: 'pipe', timeout: 30000 });
        return true;
    } catch (e) { return false; }
}

function processRunning(exe) {
    if (!exe) return false;
    try { return sh(`tasklist /FI "IMAGENAME eq ${exe}" /NH`).toLowerCase().includes(exe.toLowerCase()); }
    catch (e) { return false; }
}

// ════════════════════════════════════════════════════════════════════
//  GeoSpoof
// ════════════════════════════════════════════════════════════════════
class GeoSpoof {
    /**
     * @param {object} opts
     * @param {object} opts.log       Logger with debug/info/warn/error/success
     * @param {string} opts.stateDir  writable dir for geo-restore.json
     */
    constructor({ log, stateDir }) {
        this.log = log;
        this.stateFile = path.join(stateDir, 'geo-restore.json');
    }

    // ── restore journal ─────────────────────────────────────────────
    _read() {
        try { return JSON.parse(fs.readFileSync(this.stateFile, 'utf8')); }
        catch (e) { return null; }
    }
    _write(j) {
        try { fs.writeFileSync(this.stateFile, JSON.stringify(j, null, 2), 'utf8'); }
        catch (e) { this.log.warn('Could not write the geolocation restore journal -- ' +
                                  'disconnecting may not restore every setting', { err: e.message }); }
    }
    _clear() { try { fs.unlinkSync(this.stateFile); } catch (e) {} }

    // ════════════════════════════════════════════════════════════════
    //  1. Chromium enterprise policy -- TEARDOWN ONLY
    // ════════════════════════════════════════════════════════════════
    //  Nothing in this module writes a geolocation policy any more. Chromium
    //  is spoofed by lib/geo-ext.js, which installs the bundled extension so
    //  the page's own navigator.geolocation returns the connected country.
    //
    //  This method only takes values AWAY. It is called on connect as well as
    //  on disconnect, because a machine that ran the older build still has
    //  DefaultGeolocationSetting=2 and a wildcard GeolocationBlockedForUrls
    //  rule sitting in HKLM, and until they are gone the user's Location
    //  control stays greyed out and every page keeps reporting "User denied
    //  the request for Geolocation" -- no matter what the extension does,
    //  because a policy block is evaluated before the page ever runs.
    //
    //  GeolocationAllowedForUrls goes too: a build before that one wrote it
    //  for [*.]google.com, which force-granted the permission and let
    //  Chromium's Wi-Fi scanner run.
    clearBlockingPolicy() {
        let removed = 0;
        for (const key of Object.values(POLICY_KEYS)) {
            if (regRead(key, POLICY_VALUE) !== null) removed += 1;
            shq(`reg delete "${key}" /v "${POLICY_VALUE}" /f`);
            if (shq(`reg query "${key}\\${POLICY_SUBKEY}"`)) removed += 1;
            shq(`reg delete "${key}\\${POLICY_SUBKEY}" /f`);
            shq(`reg delete "${key}\\GeolocationAllowedForUrls" /f`);
        }
        if (removed) {
            this.log.success('Removed the geolocation BLOCK policy an earlier version of this ' +
                             'app left behind -- your browser\'s Location setting is yours ' +
                             'to control again');
        } else {
            this.log.debug('No geolocation block policy present');
        }
        return removed;
    }

    // ════════════════════════════════════════════════════════════════
    //  2. Per-profile content settings -- TEARDOWN ONLY
    // ════════════════════════════════════════════════════════════════
    //  Nothing is written into a browser profile any more either.
    //
    //  The older build walked every Chromium profile's Preferences file,
    //  flipped each stored geolocation "Allow" to Block and set the profile
    //  default to Block. With the extension in place that is not only
    //  unnecessary, it is actively wrong: the page's navigator.geolocation is
    //  replaced before any page script runs, so the real permission is never
    //  consulted and a stored ALLOW cannot leak anything. All the flip
    //  achieved was taking away permissions the user had granted deliberately.
    //
    //  restoreProfiles() stays because those flips are on disk on this
    //  machine right now, recorded in geo-restore.json, and every one of them
    //  has to be handed back.
    /**
     * Put back the geolocation grants the older build took away.
     *
     * A running browser holds Preferences in memory and rewrites it on exit,
     * so a profile whose browser is up is DEFERRED rather than edited: its
     * record is returned to the caller, kept in the journal, and retried on
     * the next disconnect or the next app start. Editing underneath a live
     * browser would look like it worked and be discarded on exit.
     *
     * Only the `setting` field is touched. last_modified and last_visit are
     * left exactly as they are, on purpose: Chromium's unused-site-permission
     * sweep reads them, and a rewritten timestamp would quietly move when the
     * user's real grant expires.
     */
    restoreProfiles(records) {
        if (!records || !records.length) return [];
        let restored = 0;
        const deferred = [];
        for (const rec of records) {
            const exe = browserExe(rec.browser);
            if (exe && processRunning(exe)) { deferred.push(rec); continue; }
            let prefs;
            try { prefs = JSON.parse(fs.readFileSync(rec.file, 'utf8')); }
            catch (e) { deferred.push(rec); continue; }

            const cs = ((prefs.profile || {}).content_settings) || {};
            if (!cs.default_content_setting_values) cs.default_content_setting_values = {};

            if (rec.hadDefault) cs.default_content_setting_values.geolocation = rec.prevDefault;
            else delete cs.default_content_setting_values.geolocation;

            const ex = (cs.exceptions || {}).geolocation || {};
            for (const pattern of rec.prevAllows || []) {
                if (ex[pattern]) ex[pattern].setting = 1;   //  give the user's grant back
            }
            try { fs.writeFileSync(rec.file, JSON.stringify(prefs), 'utf8'); restored += 1; }
            catch (e) { deferred.push(rec); }
        }
        if (restored) this.log.debug(`Stored site permissions restored in ${restored} profile(s)`);
        if (deferred.length) {
            this.log.warn('Could not restore stored site permissions for ' +
                          [...new Set(deferred.map(r => r.browser))].join(', ') +
                          ' -- it is still running. This finishes automatically once it is closed.');
        }
        return deferred;
    }

    // ════════════════════════════════════════════════════════════════
    //  3. Windows location platform
    // ════════════════════════════════════════════════════════════════
    //  This is the layer that covers everything that is not a browser:
    //  Maps, Weather, Settings itself, and any Win32/WinRT application
    //  that calls the Geolocator API.
    //
    //  WHAT WAS MEASURED, on this machine, by .build/diag-winloc.js and
    //  .build/test-winloc-default.js -- because everything below is a
    //  consequence of it and not of an opinion:
    //
    //    * a native .NET consumer (System.Device.Location.GeoCoordinateWatcher,
    //      the same platform Windows Maps and Weather sit on) reported
    //      23.7208, 90.4220 +/- 105 m. That is the real position, and 105 m
    //      with no GNSS sensor present means it came from the Wi-Fi survey:
    //      lfsvc collects the surrounding BSSIDs and posts them to Microsoft's
    //      online location service, which resolves them.
    //    * writing Windows' own documented DEFAULT LOCATION -- Latitude and
    //      Longitude under HKCU\...\Windows NT\CurrentVersion\Sensors\Location,
    //      plus the SOFTWARE\Microsoft\Location\DefaultLocation path that
    //      LocationApi.dll names -- changed NOTHING. Not with the survey
    //      working, and not with lfsvc cut off from the network and restarted.
    //      There is no location-class sensor device on this machine and no
    //      default-location sensor driver, so that fallback has no provider
    //      to deliver it.
    //
    //  So: Windows exposes no supported way to hand a native app fake
    //  coordinates. The two mechanisms that WOULD work are both refused here
    //  on purpose. A virtual GPS sensor driver needs WHQL/attestation
    //  signing, and shipping one unsigned means asking the user to turn off
    //  driver signature enforcement -- the single most damaging change that
    //  can be made to a Windows machine's security. Injecting a DLL into
    //  every process that calls the location API is what a rootkit does, and
    //  it is exactly the "someone breaches this app and harms the device"
    //  outcome we are supposed to prevent. Neither ships.
    //
    //  What ships instead does not lie and does not take anything away:
    //
    //  NOT DENIED any more. An earlier build wrote SensorPermissionState=0
    //  and the app-consent store to Deny and stopped lfsvc. That worked, in
    //  the sense that native apps got nothing -- but it also switched off the
    //  user's own Location setting underneath them and greyed out the control
    //  they would use to switch it back on. Their location, their switch.
    //  restoreWindows() still knows how to undo it so that journals written by
    //  that build are cleaned up properly, but nothing writes it any more.
    //
    //  What we do instead is cut the LEAK while leaving the SETTING alone:
    //  one named, service-scoped outbound firewall rule stops lfsvc -- and
    //  only lfsvc, which runs alone in its own svchost -- from reaching
    //  Microsoft's location service. The survey cannot be resolved, so while
    //  the VPN is up the machine does not put the user's real surroundings on
    //  the wire at all. Location stays ON, permission stays Granted, every
    //  Settings control stays the user's, and no app is denied anything.
    //
    //  Being precise about the ceiling, because this is the one place where
    //  the app cannot do what the browser layer does: a native app that
    //  already holds a cached fix can still report it, and this does not turn
    //  a native app's position into the connected country. It stops the real
    //  position from being freshly obtained and sent out. Nothing anywhere in
    //  this project claims more than that -- see reportGeoCoverage() in
    //  main.js, which tells the user exactly which surfaces are spoofed and
    //  which are only shielded.
    _snapshotWindows() {
        return {
            //  Read even though nothing writes them any more: a journal from
            //  the older build is what restoreWindows() has to be able to undo,
            //  and a fresh journal records "these were untouched" honestly.
            sensor:  regRead(SENSOR_KEY, 'SensorPermissionState'),
            consent: regRead(CONSENT_KEY, 'Value'),
            lfsvcWasRunning: serviceRunning('lfsvc'),
            fwRuleWasPresent: this._fwRulePresent(),
        };
    }

    _fwRulePresent() {
        return psq(`if (-not (Get-NetFirewallRule -DisplayName '${FW_RULE}' ` +
                   `-ErrorAction SilentlyContinue)) { exit 1 }`);
    }

    /**
     * Stop the machine from resolving a fresh real position over the network,
     * without denying anything to anyone.
     */
    _shieldWindowsNow() {
        if (this._fwRulePresent()) {
            this.log.debug('Windows location network rule already in place');
            return ['already present'];
        }
        const added = psq(
            `New-NetFirewallRule -DisplayName '${FW_RULE}' -Direction Outbound ` +
            `-Action Block -Service lfsvc -Profile Any -ErrorAction Stop | Out-Null`);

        if (added) {
            this.log.success('Windows location platform shielded -- lfsvc can no longer reach ' +
                             "Microsoft's location service, so the machine cannot put the user's " +
                             'real surroundings on the wire while connected. Location stays ON ' +
                             'and nothing is denied; native apps are not given the connected ' +
                             "country, because Windows has no supported way to be handed " +
                             'coordinates (measured, see .build/test-winloc-default.js)');
            return ['lfsvc network blocked'];
        }
        this.log.warn('Could not add the Windows location firewall rule -- this needs admin. ' +
                      'A native app may resolve and report the real position while connected; ' +
                      'browser geolocation is unaffected and still spoofed');
        return [];
    }

    restoreWindows(rec) {
        if (!rec) return;
        const undone = [];

        if (!rec.fwRuleWasPresent && this._fwRulePresent()) {
            if (psq(`Remove-NetFirewallRule -DisplayName '${FW_RULE}' -ErrorAction Stop`))
                undone.push('firewall rule removed');
        }

        //  Journals written by the build that denied. Nothing produces these
        //  values now, but a machine that ran that build has them on disk and
        //  its Location switch is off until this puts it back. Restoring a
        //  value to what it already is costs one registry write and is worth
        //  it: the alternative is deciding, from a journal, whether a change
        //  was ours, and getting that wrong leaves the user switched off.
        if (rec.sensor === null) { if (shq(`reg delete "${SENSOR_KEY}" /v "SensorPermissionState" /f`)) undone.push('sensor state cleared'); }
        else if (shq(`reg add "${SENSOR_KEY}" /v "SensorPermissionState" /t REG_DWORD /d ${rec.sensor} /f`)) undone.push(`sensor state -> ${rec.sensor}`);

        if (rec.consent === null) { if (shq(`reg delete "${CONSENT_KEY}" /v "Value" /f`)) undone.push('app consent cleared'); }
        else if (shq(`reg add "${CONSENT_KEY}" /v "Value" /t REG_SZ /d "${rec.consent}" /f`)) undone.push(`app consent -> ${rec.consent}`);

        if (rec.lfsvcWasRunning && !serviceRunning('lfsvc')) {
            if (shq('sc start lfsvc')) undone.push('lfsvc restarted');
        }
        this.log.debug('Windows location platform restored' +
                       (undone.length ? ' (' + undone.join(', ') + ')' : ' (nothing to undo)'));
    }

    // ════════════════════════════════════════════════════════════════
    //  4. The Gecko family -- Firefox and its forks
    // ════════════════════════════════════════════════════════════════
    //  Gecko is the one place outside this app's own window where a real
    //  coordinate SPOOF is available through a documented, supported
    //  setting rather than a hack: geo.provider.network.url is the URL its
    //  network provider queries, and a data: URL carrying a Google-
    //  Geolocation-shaped body makes it answer with fixed coordinates.
    //  ms-windows-location is switched off at the same time, or Firefox
    //  prefers the real Windows provider and never asks.
    //
    //  The prefs go in user.js, which Gecko re-applies on every start,
    //  and the original file -- or its absence -- is recorded so restore
    //  is exact. Values user.js has written also linger in prefs.js, so
    //  the matching lines are stripped from there too; otherwise the spoof
    //  would outlive the VPN session.
    //
    //  Which forks exist and where they keep their profiles comes from
    //  lib/browsers.js, and ONLY browsers whose executable was verified on
    //  disk are touched. That is not tidiness: this machine has an
    //  %APPDATA%\Mozilla\Firefox\Profiles directory from September 2024 with
    //  no firefox.exe anywhere, and the version of this code that walked that
    //  path directly wrote spoofed prefs into those dead profiles -- after
    //  which the coverage report told the user "Firefox: spoofed" for a
    //  browser that cannot open a page. That is exactly the kind of false
    //  claim this project is not allowed to make.
    _geckoProfiles() {
        const out = [];
        for (const b of browsers.detectGecko()) {
            if (!b.dataDir) continue;
            let entries = [];
            try { entries = fs.readdirSync(b.dataDir); } catch (e) { continue; }
            for (const d of entries) {
                const dir = path.join(b.dataDir, d);
                try { if (!fs.statSync(dir).isDirectory()) continue; } catch (e) { continue; }
                out.push({ browser: b.id, name: b.name, exe: b.exe, dir });
            }
        }
        return out;
    }

    static get FF_PREFS() {
        return ['geo.provider.network.url', 'geo.wifi.uri',
                'geo.provider.ms-windows-location',
                'geo.provider.use_corelocation', 'geo.provider.use_gpsd',
                'geo.provider.use_geoclue'];
    }

    // ── The proxy half, added in 2.0.5 ──────────────────────────────
    //  Until 2.0.5 this module wrote geolocation prefs and nothing else, and
    //  the app's answer for "does Firefox go through Tor?" was Gecko's own
    //  factory default: network.proxy.type = 5, "use system proxy settings",
    //  which follows the WinINET registry value applyWinInetProxy() writes.
    //  That default is real and it does work -- but it is not something this
    //  app can PROVE, and two cases slip through it:
    //
    //    * A user who has ever opened Settings -> Network Settings and chosen
    //      "No proxy" or a manual proxy of their own has network.proxy.type
    //      set to something other than 5, and their browser ignores the system
    //      proxy entirely. Nothing about that user's traffic was tunnelled and
    //      nothing said so.
    //    * type 5 carries HTTP/HTTPS through the WinINET proxy, and Gecko
    //      resolves the hostname LOCALLY before handing it over. That is a DNS
    //      leak that the per-adapter DNS redirect papers over rather than
    //      closes; a SOCKS5 proxy with socks_remote_dns resolves at the exit.
    //
    //  So the prefs are written explicitly, verified by reading the file back,
    //  and removed on disconnect. What that proves is that the FILE says so --
    //  Gecko reads user.js once, at startup, so a browser that was already
    //  open when the VPN connected is not covered until it restarts, and
    //  _planFirefox() skips a running browser entirely rather than editing
    //  underneath it. Both of those are stated in the log line and in README's
    //  coverage table; neither is smoothed over.
    static get FF_PROXY_PREFS() {
        return ['network.proxy.type', 'network.proxy.socks',
                'network.proxy.socks_port', 'network.proxy.socks_version',
                'network.proxy.socks_remote_dns', 'network.proxy.no_proxies_on',
                'network.proxy.failover_direct', 'network.trr.mode',
                'network.dns.disablePrefetch', 'network.predictor.enabled',
                'media.peerconnection.enabled'];
    }

    /** Every pref name this module writes, both halves. */
    static get FF_ALL_PREFS() {
        return GeoSpoof.FF_PREFS.concat(GeoSpoof.FF_PROXY_PREFS);
    }

    //  Gecko's no_proxies_on is its OWN format, and not one of the other three
    //  bypass strings this app writes is valid in it:
    //
    //    * WinINET and WinHTTP use `*.example.com`. Gecko has no wildcard --
    //      a leading dot means "subdomains of", and a `*` is just a character
    //      that no hostname will ever match.
    //    * `<local>` is a WinINET token. Gecko would treat it as a hostname.
    //    * WinHTTP separates with spaces, WinINET with semicolons, Gecko with
    //      commas.
    //
    //  The host and IPv4 shapes are the same ones bypassToProxyOverride() in
    //  main.js accepts, so all four stores agree about WHICH hosts skip Tor
    //  even though none of them can share a string with the others.
    //  .build/probe-gecko-proxy.js pins this against main.js's own copy.
    static geckoNoProxy(list) {
        const HOST = /^(?!-)[a-z0-9-]{1,63}(?:\.(?!-)[a-z0-9-]{1,63})*$/;
        const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;
        //  Loopback first and unconditionally. Modern Gecko exempts it anyway
        //  (network.proxy.allow_hijacking_localhost defaults false), but Pale
        //  Moon and SeaMonkey predate that pref and would send 127.0.0.1 to the
        //  proxy -- which puts this app's own WebSocket on 8080, and every local
        //  dev server the user runs, through Tor and out an exit node.
        const out = ['localhost', '127.0.0.1', '::1'];
        for (const raw of String(list || '').replace(/,/g, ';').split(';')) {
            const e = raw.trim()
                .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/.*$/, '')
                .replace(/:\d+$/, '').replace(/^\*\./, '').replace(/\.$/, '')
                .toLowerCase();
            if (!e || e === '<local>') continue;
            if (IPV4.test(e)) { out.push(e); continue; }
            //  The bare name AND the dotted form: Gecko's leading dot matches
            //  sub.example.com but not example.com itself, so a user who typed
            //  one host would otherwise still tunnel that exact host.
            if (e.length <= 253 && HOST.test(e)) { out.push(e, '.' + e); continue; }
        }
        return [...new Set(out)].join(', ');
    }

    //  Our block is fenced by these markers so it can be found and removed
    //  again even from a user.js the user has since edited by hand.
    static get FF_BEGIN() {
        return '// ── FreeProxy VPN: spoofed geolocation + Tor proxy while connected ──';
    }
    static get FF_END()   { return '// ── end FreeProxy VPN ──'; }

    //  Matched by PREFIX, not equality. Before 2.0.5 the marker read
    //  "spoofed geolocation while connected"; a machine upgrading from that
    //  build still has that exact line in its profiles, and an exact compare
    //  would fail to recognise it -- so the old block would be preserved as if
    //  it were the user's own text and the new one stacked underneath it.
    static _isFfBegin(line) {
        return String(line).trim().startsWith('// ── FreeProxy VPN:');
    }

    static _stripFfBlock(text) {
        if (!text) return text;
        const out = [];
        let inside = false;
        for (const l of text.split(/\r?\n/)) {
            if (!inside && GeoSpoof._isFfBegin(l)) { inside = true; continue; }
            if (inside) { if (l.trim() === GeoSpoof.FF_END) inside = false; continue; }
            out.push(l);
        }
        return out.join('\r\n').replace(/(\r?\n){3,}/g, '\r\n\r\n');
    }

    /**
     * The fenced block, both halves. `coord` may be null (a server with no
     * coordinates on file), `proxy` may be null (the geolocation-only shape
     * every build before 2.0.5 wrote) -- but not both, and applyAll() will
     * not plan a profile when both are missing.
     *
     * Returns { text, expect } where `expect` is the pref names the file must
     * contain afterwards. _applyFirefoxPlan() reads the file back and checks
     * them, so a write that silently landed somewhere else is not counted as
     * coverage.
     */
    static _ffBlock(coord, proxy) {
        const L = [
            GeoSpoof.FF_BEGIN,
            '// Written by FreeProxy VPN while it is connected, and removed again on',
            '// disconnect. If the app is gone and this is still here, delete from this',
            '// line down to the "end FreeProxy VPN" line: with the block in place and',
            '// no VPN running, this profile points at a proxy port nothing answers.',
        ];
        const expect = [];
        if (coord) {
            const body = `{"location": {"lat": ${coord.lat.toFixed(6)}, ` +
                         `"lng": ${coord.lng.toFixed(6)}}, ` +
                         `"accuracy": ${Number(coord.accuracy || 40).toFixed(1)}}`;
            L.push(
                `user_pref("geo.provider.network.url", "data:application/json,${body.replace(/"/g, '\\"')}");`,
                //  The same pref's pre-Firefox-74 name. Modern Gecko ignores an
                //  unknown pref in user.js, so writing it costs nothing and covers
                //  the old forks -- SeaMonkey and Pale Moon still read this one.
                `user_pref("geo.wifi.uri", "data:application/json,${body.replace(/"/g, '\\"')}");`,
                'user_pref("geo.provider.ms-windows-location", false);',
                'user_pref("geo.provider.use_corelocation", false);',
                'user_pref("geo.provider.use_gpsd", false);',
                'user_pref("geo.provider.use_geoclue", false);',
                'user_pref("geo.enabled", true);');
            expect.push('geo.provider.network.url', 'geo.wifi.uri',
                        'geo.provider.ms-windows-location');
        }
        if (proxy) {
            //  Hard-validated rather than interpolated on trust. These land
            //  inside a quoted JS string literal that Gecko parses at startup,
            //  and a stray quote would not "look wrong" -- it would make the
            //  whole file a syntax error and silently drop every pref in it,
            //  including the geolocation half above.
            const host = String(proxy.host || '').trim();
            const port = Number(proxy.port);
            if (!/^[a-z0-9.:_-]{1,64}$/i.test(host)) {
                throw new Error('refusing to write a Gecko proxy host that is not a ' +
                                'plain hostname or address: ' + JSON.stringify(proxy.host));
            }
            if (!Number.isInteger(port) || port < 1 || port > 65535) {
                throw new Error('refusing to write a Gecko proxy port that is not a ' +
                                'port number: ' + JSON.stringify(proxy.port));
            }
            const noProxy = GeoSpoof.geckoNoProxy(proxy.bypass);
            if (!/^[a-z0-9.:,\s_-]*$/i.test(noProxy)) {
                throw new Error('geckoNoProxy produced something that is not a bypass ' +
                                'list: ' + JSON.stringify(noProxy));
            }
            L.push('',
                '// Every TCP connection this browser makes goes to the Tor SOCKS5 port,',
                '// and socks_remote_dns means the NAME goes with it -- resolved at the',
                '// exit, never by this machine. Gecko reads user.js once, at startup,',
                '// so a browser that was already running when the VPN connected keeps',
                '// its old settings until it is restarted.',
                'user_pref("network.proxy.type", 1);',
                `user_pref("network.proxy.socks", "${host}");`,
                `user_pref("network.proxy.socks_port", ${port});`,
                'user_pref("network.proxy.socks_version", 5);',
                'user_pref("network.proxy.socks_remote_dns", true);',
                `user_pref("network.proxy.no_proxies_on", "${noProxy}");`,
                //  A manual proxy that stops answering must not become a direct
                //  connection. That is the whole failure this layer exists to
                //  prevent: tor.exe dies, and without this the next request goes
                //  out of the real interface with the real IP on it.
                'user_pref("network.proxy.failover_direct", false);',
                '',
                '// DNS-over-HTTPS off. Its queries would ride the proxy, so this is not',
                '// a plaintext leak -- but it hands every hostname this browser looks',
                '// up to one resolver, and it makes socks_remote_dns above moot. Tor',
                '// already resolves; a second resolver only adds a place to be tracked.',
                'user_pref("network.trr.mode", 5);',
                //  Speculative DNS. Necko's prefetcher and predictor resolve
                //  names through the platform resolver rather than the SOCKS
                //  proxy, so these two are the one part of Gecko that
                //  socks_remote_dns does not cover.
                'user_pref("network.dns.disablePrefetch", true);',
                'user_pref("network.predictor.enabled", false);',
                '',
                '// WebRTC off, and this is not a feature being taken away. Tor\'s SOCKS5',
                '// has no UDP ASSOCIATE, so a WebRTC call cannot work through this proxy',
                '// at all -- what it CAN still do is gather host candidates and put the',
                '// real IP address in an SDP offer. Off, it fails cleanly instead of',
                '// failing and leaking. Restored on disconnect like everything else.',
                'user_pref("media.peerconnection.enabled", false);');
            expect.push('network.proxy.type', 'network.proxy.socks',
                        'network.proxy.socks_port', 'network.proxy.socks_remote_dns',
                        'network.proxy.no_proxies_on', 'network.trr.mode',
                        'media.peerconnection.enabled');
        }
        L.push(GeoSpoof.FF_END);
        return { text: L.join('\r\n'), expect };
    }

    /**
     * The lines prefs.js already holds for prefs this module is about to
     * overwrite, so restore can put them back verbatim instead of deleting
     * them and silently resetting the user to Gecko's own defaults.
     *
     * This matters far more for the proxy half than the geolocation half.
     * Nobody sets geo.provider.network.url by hand; anyone who has ever opened
     * Settings -> Network Settings has a network.proxy.type in prefs.js, and a
     * corporate manual proxy deleted by a disconnect is a browser that stops
     * working on its own network -- a fault this app would have caused.
     *
     * Returns [] when our fenced block is ALREADY in user.js. Gecko copied our
     * values into prefs.js at its last start, so what is in there now is ours,
     * and handing it back would restore the spoof rather than the user's
     * settings. Their originals are unrecoverable in that case, which is why
     * the journal -- written before the first edit -- is the primary record and
     * this is only the second line of defence.
     */
    _capturePrefs(dir, userJs) {
        try {
            if (fs.existsSync(userJs) &&
                fs.readFileSync(userJs, 'utf8').includes('FreeProxy VPN:')) return [];
        } catch (e) { return []; }
        try {
            const prefsJs = path.join(dir, 'prefs.js');
            if (!fs.existsSync(prefsJs)) return [];
            return fs.readFileSync(prefsJs, 'utf8').split(/\r?\n/)
                .filter(l => GeoSpoof.FF_ALL_PREFS.some(p => l.includes('"' + p + '"')));
        } catch (e) { return []; }
    }

    _planFirefox(coord, prevJournal, proxy) {
        const prev = new Map((prevJournal || []).map(r => [r.userJs, r]));
        const { text: block, expect } = GeoSpoof._ffBlock(coord, proxy);
        const records = [], edits = [], skipped = new Set(), touched = new Set();

        //  Per browser, not one blanket firefox.exe check: a running Waterfox
        //  must not stop Firefox from being spoofed, and vice versa. A running
        //  browser rewrites prefs.js from memory on exit, so editing
        //  underneath it would look like it worked and then be discarded.
        const running = new Map();
        const isRunning = (exe) => {
            if (!running.has(exe)) running.set(exe, processRunning(exe));
            return running.get(exe);
        };

        for (const p of this._geckoProfiles()) {
            if (isRunning(p.exe)) { skipped.add(p.name); continue; }
            const userJs = path.join(p.dir, 'user.js');
            const before = prev.get(userJs);
            //  On a country switch user.js already holds our block, so the
            //  earlier record is the real backup; the file's current contents
            //  minus our own block is the fallback.
            const rec = before || { browser: p.browser, dir: p.dir, userJs,
                                    existed: fs.existsSync(userJs), prior: null };
            if (!rec.browser) rec.browser = p.browser;
            if (!before && rec.existed) {
                try { rec.prior = GeoSpoof._stripFfBlock(fs.readFileSync(userJs, 'utf8')); }
                catch (e) { this.log.warn('Could not read ' + p.name + ' user.js',
                                          { dir: p.dir, err: e.message }); continue; }
            }
            //  prefs.js keeps a copy of every value user.js has ever set --
            //  Gecko writes it out on shutdown -- so deleting user.js alone
            //  leaves the settings behind. Captured BEFORE anything is written,
            //  and only on the first apply: on a country switch or a bypass
            //  edit, `before` already holds the real originals.
            if (!before) rec.priorPrefs = this._capturePrefs(p.dir, userJs);
            //  What is actually in this profile right now, so status() and the
            //  coverage report can say "proxied" only where it was written.
            rec.proxied = !!proxy;
            const head = rec.prior && rec.prior.trim() ? rec.prior.replace(/\s*$/, '') + '\r\n\r\n' : '';
            records.push(rec);
            touched.add(p.name);
            edits.push({ userJs, content: head + block + '\r\n', expect });
        }

        //  Anything skipped keeps its old journal entry, so a browser that was
        //  spoofed on a previous connect is still restored on disconnect.
        for (const r of prevJournal || []) {
            if (!records.some(x => x.userJs === r.userJs)) records.push(r);
        }
        if (skipped.size) {
            this.log.warn([...skipped].join(' and ') + ' is running -- its location' +
                          (proxy ? ' and proxy prefs were' : ' prefs were') +
                          ' left alone. Restart it while connected to pick ' +
                          (proxy ? 'them' : 'it') + ' up.');
        }
        return { records, edits, city: coord ? coord.city : null,
                 proxied: !!proxy, browsers: [...touched] };
    }

    _applyFirefoxPlan(plan) {
        let n = 0;
        const unverified = [];
        for (const e of plan.edits) {
            try { fs.writeFileSync(e.userJs, e.content, 'utf8'); }
            catch (err) {
                this.log.warn('Could not write user.js', { file: e.userJs, err: err.message });
                unverified.push(e.userJs + ' (' + err.message + ')');
                continue;
            }
            //  READ IT BACK. A write that threw nothing but landed somewhere
            //  else -- a redirected folder, a full disk, Controlled Folder
            //  Access, an antivirus that reverted it -- must not be counted as
            //  coverage, because the number counted here is the number the
            //  coverage report shows the user.
            //
            //  What this proves is that the FILE says so. It does not prove
            //  Gecko has read it: user.js is read once, at startup. The log
            //  line below says that in as many words, and nothing anywhere
            //  claims a running browser was changed.
            let got = '';
            try { got = fs.readFileSync(e.userJs, 'utf8'); }
            catch (err) { unverified.push(e.userJs + ' (' + err.message + ')'); continue; }
            const missing = (e.expect || []).filter(p => !got.includes('"' + p + '"'));
            if (got.indexOf(GeoSpoof.FF_BEGIN) < 0) {
                unverified.push(e.userJs + ' (our block is not in the file)');
                continue;
            }
            if (missing.length) {
                unverified.push(e.userJs + ' (missing ' + missing.join(', ') + ')');
                continue;
            }
            n += 1;
        }
        if (unverified.length) {
            this.log.warn('Gecko prefs did not read back in ' + unverified.length +
                          ' profile(s) -- those are NOT covered and are not counted ' +
                          'as covered anywhere', { profiles: unverified.slice(0, 6) });
        }
        if (n) {
            const who  = (plan.browsers || ['Firefox']).join(' and ');
            const what = [];
            if (plan.city)    what.push(`location spoofed to ${plan.city}`);
            if (plan.proxied) what.push('all TCP pointed at the Tor SOCKS port with ' +
                                        'remote DNS, DoH and WebRTC off');
            this.log.success(`${who}: ${what.join('; ')} in ${n} profile(s), read back ` +
                             'from disk' + (plan.proxied
                                 ? ' -- Gecko applies user.js at startup, so this takes ' +
                                   'effect the next time the browser is opened'
                                 : ''));
        }
        return n;
    }

    restoreFirefox(records) {
        if (!records || !records.length) return;
        //  A record written before this became family-aware has no browser
        //  field; those can only have come from Firefox.
        const live = new Set();
        for (const rec of records) {
            const b = browsers.byId(rec.browser || 'firefox');
            if (b && processRunning(b.exe)) live.add(b.name);
        }
        if (live.size) {
            this.log.warn([...live].join(' and ') + ' is running -- close it and its ' +
                          'spoofed location and proxy prefs will be cleared. Until then ' +
                          'it keeps whatever it read at startup.');
        }
        let n = 0;
        for (const rec of records) {
            try {
                if (rec.existed && rec.prior !== null) fs.writeFileSync(rec.userJs, rec.prior, 'utf8');
                else if (fs.existsSync(rec.userJs)) fs.unlinkSync(rec.userJs);

                //  user.js values are copied into prefs.js on every start, so
                //  removing user.js alone would leave the spoof behind.
                const prefsJs = path.join(rec.dir, 'prefs.js');
                if (fs.existsSync(prefsJs)) {
                    const keep = fs.readFileSync(prefsJs, 'utf8').split(/\r?\n/)
                        .filter(l => !GeoSpoof.FF_ALL_PREFS.some(p => l.includes('"' + p + '"')));
                    //  ...and then the user's OWN values for those same prefs
                    //  back, verbatim, from the journal. Filtering alone would
                    //  hand a user who had chosen "No proxy" or a manual
                    //  corporate proxy Gecko's factory default instead of what
                    //  they set -- this app breaking a browser setting it did
                    //  not own. Appending is safe: prefs.js is a flat list of
                    //  user_pref() calls read top to bottom, and every line
                    //  ours could collide with was just filtered out.
                    //
                    //  A journal from before 2.0.5 has no priorPrefs, so this
                    //  is an empty append and the behaviour is exactly what it
                    //  was.
                    const back = (rec.priorPrefs || []).filter(l => l && l.trim());
                    fs.writeFileSync(prefsJs, keep.concat(back).join('\n'), 'utf8');
                }
                n += 1;
            } catch (e) {
                this.log.warn('Could not restore Gecko prefs', { dir: rec.dir, err: e.message });
            }
        }
        if (n) this.log.debug(`Gecko location and proxy prefs restored in ${n} profile(s)`);
    }

    // ════════════════════════════════════════════════════════════════
    //  orchestration
    // ════════════════════════════════════════════════════════════════
    /**
     * Apply every device-level layer this module still owns.
     *
     * Safe to call again on a country switch: the existing journal is
     * carried forward as the backup rather than re-derived from a machine
     * that is already spoofed.
     *
     * `proxy` is { host, port, bypass } and is what makes the Gecko family
     * ride Tor explicitly instead of inheriting it from Gecko's own "use
     * system proxy settings" default. Omitted -- or null -- and this behaves
     * exactly as every build before 2.0.5 did: geolocation only.
     */
    applyAll(coord, proxy) {
        const prev = this._read() || {};
        const j = {
            createdAt: prev.createdAt || new Date().toISOString(),
            //  Kept in the journal shape even though nothing writes them any
            //  more: a journal from the older build is still on disk on
            //  machines that ran it, and restoreAll() has to be able to read
            //  it and hand those grants back.
            policy:    prev.policy    || [],
            profiles:  prev.profiles  || [],
            windows:   prev.windows   || null,
            firefox:   prev.firefox   || [],
        };

        //  Each layer is journaled BEFORE it is applied. Recording
        //  afterwards leaves one state that cannot be undone -- machine
        //  changed, nothing written down -- and that is precisely the state
        //  a crash or a force-quit finds.

        // 0. Purge the older build's geolocation BLOCK policy. Done on
        //    connect, not only on disconnect: while it is still in HKLM every
        //    Chromium page reports "User denied the request for Geolocation"
        //    before the extension's content script gets a chance to answer,
        //    and the user's own Location control stays greyed out.
        this.clearBlockingPolicy();

        // 1. Windows platform
        if (!j.windows) { j.windows = this._snapshotWindows(); this._write(j); }
        this._shieldWindowsNow();

        // 2. The Gecko family -- coordinates, and from 2.0.5 the proxy with
        //    them. Planned when EITHER is available: a server code with no
        //    coordinates on file must still get the proxy prefs, or the one
        //    browser family that has no extension would be the only thing on
        //    the machine left outside the tunnel.
        if (coord || proxy) {
            const ff = this._planFirefox(coord, j.firefox, proxy);
            j.firefox = ff.records;
            this._write(j);
            this._applyFirefoxPlan(ff);
        }
        this._write(j);
        return j;
    }

    /**
     * The Gecko half on its own, for a split-tunnel list edited while the
     * session is already up.
     *
     * Needed because no_proxies_on is a COPY of that list: without this, a
     * user who removes a host from the split-tunnel list would have every
     * other store start tunnelling it while their Firefox carried on sending
     * it direct, and two stores that disagree about which hosts skip Tor is
     * worse than either answer on its own.
     *
     * Refuses when there is no session journal. No journal means nothing of
     * this app's is applied, and writing a proxy pref then would point a
     * disconnected browser at a dead port -- the exact fault the rest of this
     * file exists to avoid.
     */
    applyGecko(coord, proxy) {
        if (!coord && !proxy) return 0;
        const j = this._read();
        if (!j || j.pendingOnly) {
            this.log.debug('Gecko prefs not re-applied: there is no active session to ' +
                           'keep in step with');
            return 0;
        }
        const ff = this._planFirefox(coord, j.firefox, proxy);
        j.firefox = ff.records;
        this._write(j);
        return this._applyFirefoxPlan(ff);
    }

    /** Undo everything applyAll did, from the journal on disk. */
    restoreAll() {
        const j = this._read();
        //  Runs even with no journal: nothing writes those policy values any
        //  more, so removing them is always the right move.
        this.clearBlockingPolicy();
        if (!j) { this._clear(); return; }

        const deferred = this.restoreProfiles(j.profiles);
        this.restoreWindows(j.windows);
        this.restoreFirefox(j.firefox);

        if (deferred.length) {
            //  A browser that is still open owns its Preferences file, so its
            //  grants cannot be handed back yet. Keep just those records, so
            //  the next disconnect -- or the next app start -- finishes the
            //  job instead of leaving the user permanently blocked.
            this._write({ createdAt: j.createdAt, pendingOnly: true,
                          policy: [], profiles: deferred, windows: null, firefox: [] });
        } else {
            this._clear();
        }
        this.log.info('Device location spoofing cleared -- real location restored');
    }

    /**
     * Startup safety net. A hard kill while connected would otherwise
     * leave the user's location switched off with nothing left to undo it.
     */
    restoreLeftovers() {
        const j = this._read();
        if (!j) return false;
        this.log.warn(j.pendingOnly
            ? 'Finishing a location restore that a still-open browser blocked last time'
            : `Location settings were left behind by a previous session (${j.createdAt}) -- restoring them now`);
        this.restoreAll();
        return true;
    }

    /**
     * What this module covers right now, per surface. Reported as-is: a
     * surface that is only SHIELDED is never described as spoofed, and nothing
     * about Chromium is claimed here at all -- that belongs to lib/geo-ext.js,
     * which knows whether the extension is genuinely loaded.
     *
     * `windowsShielded` means lfsvc has been cut off from Microsoft's location
     * service, so no fresh real fix can be resolved or sent. It does NOT mean
     * native apps report the connected country; nothing can make them, and
     * whoever reads this field must not phrase it as if it did.
     *
     * `legacyGrantsPending` is the count of site permissions an older build
     * flipped to Block and that are still waiting to be handed back.
     *
     * `geckoProxied` is the count of Gecko profiles whose user.js this app
     * wrote SOCKS5 prefs into and read back afterwards. It is a statement
     * about files on disk, not about a browser's live state: Gecko reads
     * user.js once, at startup, so a profile counted here whose browser was
     * already open is covered from that browser's next start. Whoever
     * displays this must not word it as "Firefox is on Tor right now".
     */
    status() {
        const j = this._read();
        const on = !!j && !j.pendingOnly;
        const ffRecords = on ? (j.firefox || []) : [];
        //  Which Gecko browsers those profiles belong to, by display name, so
        //  the coverage report can say "Waterfox: spoofed" instead of calling
        //  every fork Firefox. A record from an older build has no browser
        //  field; those can only have come from Firefox.
        const geckoNames = browsers.names(
            [...new Set(ffRecords.map(r => r.browser || 'firefox'))]);
        return {
            active:              on,
            windowsShielded:     on && !!j.windows && this._fwRulePresent(),
            geckoSpoofed:        ffRecords.length,
            geckoBrowsers:       geckoNames,
            //  Counted from the records themselves, not from "we are connected,
            //  so it must be on". A profile only carries proxied:true when
            //  _planFirefox wrote the proxy half into it, so a build that only
            //  had coordinates on file -- or a profile that was skipped because
            //  its browser was running -- is not counted here.
            geckoProxied:        ffRecords.filter(r => r.proxied).length,
            //  Kept as the old name too: an installed build's renderer and the
            //  regression scripts both read it.
            firefoxSpoofed:      ffRecords.length,
            legacyGrantsPending: j ? (j.profiles || []).length : 0,
        };
    }
}

module.exports = { GeoSpoof, POLICY_KEYS, POLICY_VALUE, POLICY_SUBKEY,
                   SENSOR_KEY, CONSENT_KEY, FW_RULE };
