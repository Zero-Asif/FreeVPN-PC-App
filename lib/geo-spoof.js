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

    //  Our block is fenced by these markers so it can be found and removed
    //  again even from a user.js the user has since edited by hand.
    static get FF_BEGIN() { return '// ── FreeProxy VPN: spoofed geolocation while connected ──'; }
    static get FF_END()   { return '// ── end FreeProxy VPN ──'; }

    static _stripFfBlock(text) {
        if (!text) return text;
        const out = [];
        let inside = false;
        for (const l of text.split(/\r?\n/)) {
            if (!inside && l.trim() === GeoSpoof.FF_BEGIN) { inside = true; continue; }
            if (inside) { if (l.trim() === GeoSpoof.FF_END) inside = false; continue; }
            out.push(l);
        }
        return out.join('\r\n').replace(/(\r?\n){3,}/g, '\r\n\r\n');
    }

    static _ffBlock(coord) {
        const body = `{"location": {"lat": ${coord.lat.toFixed(6)}, ` +
                     `"lng": ${coord.lng.toFixed(6)}}, ` +
                     `"accuracy": ${Number(coord.accuracy || 40).toFixed(1)}}`;
        return [
            GeoSpoof.FF_BEGIN,
            '// Written by the VPN app. Removed automatically on disconnect.',
            `user_pref("geo.provider.network.url", "data:application/json,${body.replace(/"/g, '\\"')}");`,
            //  The same pref's pre-Firefox-74 name. Modern Gecko ignores an
            //  unknown pref in user.js, so writing it costs nothing and covers
            //  the old forks -- SeaMonkey and Pale Moon still read this one.
            `user_pref("geo.wifi.uri", "data:application/json,${body.replace(/"/g, '\\"')}");`,
            'user_pref("geo.provider.ms-windows-location", false);',
            'user_pref("geo.provider.use_corelocation", false);',
            'user_pref("geo.provider.use_gpsd", false);',
            'user_pref("geo.provider.use_geoclue", false);',
            'user_pref("geo.enabled", true);',
            GeoSpoof.FF_END,
        ].join('\r\n');
    }

    _planFirefox(coord, prevJournal) {
        const prev = new Map((prevJournal || []).map(r => [r.userJs, r]));
        const block = GeoSpoof._ffBlock(coord);
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
            const head = rec.prior && rec.prior.trim() ? rec.prior.replace(/\s*$/, '') + '\r\n\r\n' : '';
            records.push(rec);
            touched.add(p.name);
            edits.push({ userJs, content: head + block + '\r\n' });
        }

        //  Anything skipped keeps its old journal entry, so a browser that was
        //  spoofed on a previous connect is still restored on disconnect.
        for (const r of prevJournal || []) {
            if (!records.some(x => x.userJs === r.userJs)) records.push(r);
        }
        if (skipped.size) {
            this.log.warn([...skipped].join(' and ') + ' is running -- its location prefs ' +
                          'were left alone. Restart it while connected to pick up the ' +
                          'spoofed position.');
        }
        return { records, edits, city: coord.city, browsers: [...touched] };
    }

    _applyFirefoxPlan(plan) {
        let n = 0;
        for (const e of plan.edits) {
            try { fs.writeFileSync(e.userJs, e.content, 'utf8'); n += 1; }
            catch (err) { this.log.warn('Could not write user.js', { file: e.userJs, err: err.message }); }
        }
        if (n) {
            this.log.success(`${(plan.browsers || ['Firefox']).join(' and ')} location spoofed ` +
                             `to ${plan.city} in ${n} profile(s) -- real coordinates, not a block`);
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
                          'spoofed location prefs will be cleared.');
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
                        .filter(l => !GeoSpoof.FF_PREFS.some(p => l.includes('"' + p + '"')));
                    fs.writeFileSync(prefsJs, keep.join('\n'), 'utf8');
                }
                n += 1;
            } catch (e) {
                this.log.warn('Could not restore Gecko prefs', { dir: rec.dir, err: e.message });
            }
        }
        if (n) this.log.debug(`Gecko location prefs restored in ${n} profile(s)`);
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
     */
    applyAll(coord) {
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

        // 2. Firefox
        if (coord) {
            const ff = this._planFirefox(coord, j.firefox);
            j.firefox = ff.records;
            this._write(j);
            this._applyFirefoxPlan(ff);
        }
        this._write(j);
        return j;
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
            //  Kept as the old name too: an installed build's renderer and the
            //  regression scripts both read it.
            firefoxSpoofed:      ffRecords.length,
            legacyGrantsPending: j ? (j.profiles || []).length : 0,
        };
    }
}

module.exports = { GeoSpoof, POLICY_KEYS, POLICY_VALUE, POLICY_SUBKEY,
                   SENSOR_KEY, CONSENT_KEY, FW_RULE };
