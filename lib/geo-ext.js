'use strict';
// ════════════════════════════════════════════════════════════════════
//  lib/geo-ext.js  --  get the geolocation spoofer into the user's browsers
//
//  WHY AN EXTENSION AT ALL
//  -----------------------
//  A Chromium page's position comes from Chromium's own network location
//  provider, which scans the surrounding Wi-Fi and POSTs the BSSIDs to
//  Google. Google answers from the BSSIDs in the request BODY, so the exit
//  IP is irrelevant and tunnelling the request changes nothing. There is no
//  switch, policy or registry value anywhere in Chromium that says "report
//  these coordinates instead". The only mechanism that does is a content
//  script replacing navigator.geolocation in the page's own JS world -- which
//  is exactly what ExpressVPN, NordVPN, Surfshark and Windscribe ship, and
//  the reason all four publish a browser extension alongside their app.
//
//  The alternative -- switching the API off so sites fall back to the IP --
//  was tried in an earlier build and is not coming back. It reports "User
//  denied the request for Geolocation", breaks every site that uses
//  coordinates directly, and because a policy rule outranks the user's own
//  setting it greys out their Location control so they cannot undo it.
//
//  HOW IT GETS INSTALLED, PER BROWSER
//  ----------------------------------
//  Measured end-to-end on this machine (Chrome 151, Edge, Brave), each
//  browser running unelevated, with the verdict being "did a real page
//  receive the coordinates":
//
//                                        Chrome    Edge    Brave
//    --load-extension                    refused   works   works
//    force-install, self-hosted CRX      refused   WORKS   refused
//    external registry key + update_url  refused   works   refused
//    external registry key + local path  refused   refused refused
//    force-install from the Web Store    works     works   works
//
//  Chrome's refusal of --load-extension is branded and unconditional
//  ("--load-extension is not allowed in Google Chrome, ignoring"), and no
//  feature flag reverses it. Chrome and Brave drop a self-hosted forcelist
//  entry during policy validation, before any network request is made.
//
//  TWO POLICY ROUTES ARE WRITTEN, NOT ONE
//  Since that table was measured, the second door is tried as well:
//  ExtensionSettings, the dictionary policy Google's documentation now uses in
//  place of the forcelist, validated by a different code path and able to pin
//  the icon to the toolbar as well as install it. Both are written; neither is
//  BELIEVED. What is actually running in a browser is read out of that
//  browser's own profile by presence(), and the manual-load instructions stay
//  on screen until that says otherwise. See installSettings().
//
//  The routes are gated on management, not on branding, and that is the whole
//  reason a home PC is harder than an office one: Google requires the machine
//  to be domain-joined, Azure-AD-joined or cloud-enrolled before an off-store
//  extension may be forced at all. On a work laptop -- which is most of the
//  machines a policy like this was designed for -- both routes land in Chrome
//  and Brave too, with nothing asked of the user.
//
//  So:
//    * Edge  -- force-installed from the loopback update host. Automatic.
//    * Brave -- both policies attempted; on an unmanaged PC, one-time "Load
//      unpacked". Its --load-extension works, but only for a browser this app
//      launches itself, and this app does not launch or close browsers.
//    * Chrome -- both policies attempted; on an unmanaged PC, one-time "Load
//      unpacked". The other automatic route is Web Store publication; set
//      FP_GEO_WEBSTORE_ID once that exists and this module force-installs it
//      in all three.
//    * Any other Chromium fork -- Vivaldi, Yandex, plain Chromium -- is
//      ATTEMPTED, the value is read back, and presence is then read from the
//      profile, so a fork that accepts it is covered automatically and one
//      that does not is reported as needing the manual load. Opera and Opera
//      GX implement no policies at all, so they get the manual route by
//      definition. Which browsers exist, and what each one accepts, lives in
//      lib/browsers.js -- this file no longer keeps a list of its own.
//
//  A one-time manual load is a real limitation of those two browsers, not a
//  shortcut taken here, and presence is DETECTED rather than assumed: the
//  caller is told which browsers are actually covered.
//
//  WHY THERE IS NO PER-COUNTRY REPACKAGE
//  -------------------------------------
//  The coordinates do not travel inside the package. background.js holds a
//  WebSocket to the app and mirrors the connected country into
//  chrome.storage.local, which geo-bridge.js hands to the page. One install
//  therefore covers every country switch, and -- more importantly -- there is
//  no coordinate file on disk that can go stale and report a country the app
//  is no longer connected to. When the app is not running, background.js
//  writes active:false and the real provider is used again.
// ════════════════════════════════════════════════════════════════════

const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const crx = require('./crx');
const { ExtHost } = require('./ext-host');
const browsers = require('./browsers');
//  The on-disk half of delivery. Required one way only -- ext-deliver requires
//  browsers, never this file -- so there is no cycle.
const deliver = require('./ext-deliver');

//  Policy roots for every Chromium fork in the table that implements
//  policies, keyed by the stable browser id. Derived from lib/browsers.js so
//  that adding a fork there covers it here too -- this file used to name
//  Edge/Chrome/Brave itself, which is precisely how a fourth browser became
//  a silent hole.
//
//  Deliberately the FULL table rather than only what is installed: install()
//  intersects it with detection, and keeping the map static is what lets
//  .build/test-geo-forcelist.js redirect it at a throwaway HKCU root and
//  exercise the real code without touching a policy hive.
const POLICY_KEYS = (() => {
    const out = {};
    for (const b of browsers.CHROMIUM) if (b.policy) out[b.id] = 'HKLM\\' + b.policy;
    return out;
})();

const FORCELIST = 'ExtensionInstallForcelist';

//  The SECOND force-install route, and the reason it is worth having.
//
//  ExtensionInstallForcelist is the old list policy. ExtensionSettings is the
//  dictionary policy that replaced it, it is what Google's own documentation
//  now tells administrators to use, and it is validated by a DIFFERENT code
//  path in Chromium -- per-extension, out of a parsed JSON dictionary, rather
//  than out of a list of "id;url" strings. Chrome and Brave drop a self-hosted
//  entry from the LIST during policy validation on an unmanaged machine; this
//  is the other door, and it is a door that costs one REG_SZ to try.
//
//  It is not wishful thinking dressed up as a feature. Nothing anywhere in
//  this app claims a browser is covered because this value was written: the
//  write is read back, and whether the extension is really THERE is still
//  answered by presence() reading the browser's own profile. If Chromium
//  drops this too, the user is told to do the one manual load exactly as
//  before. If it lands -- and on a machine that is domain-joined, Azure-AD
//  joined or cloud-enrolled, which is every office laptop, it does -- Chrome
//  and Brave are covered with nothing asked of the user.
//
//  It also carries something the list policy cannot express:
//  toolbar_pin: 'force_pinned' puts the icon ON the toolbar instead of hiding
//  it in the puzzle-piece menu, which is the "Pin it" step welcome.html would
//  otherwise have to ask for by hand.
const EXT_SETTINGS = 'ExtensionSettings';

//  The FOURTH route, which installs nothing at all.
//
//  MEASURED, twice, and the second measurement corrected the first.
//
//  Round 1 (after a real boot pass): Chrome DID take route 3. It fetched the
//  CRX from the loopback update_url and unpacked it into its own profile --
//  Default\Extensions\<our id>\<version>_0, every file of it -- wrote a prefs
//  entry with location 6 (EXTERNAL_PREF_DOWNLOAD), recorded the granted
//  permissions, and then disabled it itself. So the extension was IN the
//  browser and switched off, which reads from the outside exactly like an
//  install that never happened, and is why the earlier conclusion was "Chrome
//  takes neither". The disable reason was read as 256 (DISABLE_GREYLIST, Safe
//  Browsing's verdict on an off-store CRX), and this comment used to say so.
//
//  Round 2 (.build/probe-deliver.js, throwaway profiles, payload served on the
//  port the live policies name, prefs read only after Chromium flushed them):
//
//      Edge    location 7 (EXTERNAL_POLICY_DOWNLOAD)  disable_reasons []
//                                                     ack_external true, SW running
//      Chrome  location 6 (EXTERNAL_PREF_DOWNLOAD)    disable_reasons [8192]
//      Brave   location 6                             disable_reasons [8192]
//
//  8192 is not the greylist. It is the EXTERNAL-INSTALL ACKNOWLEDGEMENT state:
//  ack_prompt_count and external_first_run sit beside it, and it is the browser
//  saying "an installer outside me put this here; the user has not approved it
//  in MY ui yet". The update check confirms who is asking --
//  installedby=policy for Edge, installedby=external for Chrome and Brave.
//
//  SO ROUTE 4 IS NOT THE CURE FOR CHROME AND BRAVE, and this file will not
//  pretend otherwise. An allowlist entry answers a greylist verdict; it does
//  not answer "the user has not clicked Enable". On an unmanaged consumer
//  machine the honest ceiling for those two is one click in the browser's own
//  prompt, or Web Store publication (FP_GEO_WEBSTORE_ID), after which the store
//  URL makes force-install work there too. Faking enterprise enrolment to skip
//  that click is not something this app does.
//
//  It is still written, for two reasons that stand on their own: it costs one
//  REG_SZ, and it forecloses the OTHER failure mode -- on a machine that is
//  managed (domain, Azure AD, Chrome Browser Cloud Management), where routes 1
//  and 2 do take effect, a greylist verdict is exactly what would switch our
//  extension off afterwards.
//
//  It grants nothing and installs nothing: an id in this list that no route
//  ever delivered stays absent. That is deliberate -- this is the one policy
//  here whose failure mode is "no effect" rather than "wrong effect".
const ALLOWLIST = 'ExtensionInstallAllowlist';

//  Which browsers a self-hosted force-install is even attempted in.
//
//  'works'   measured to work (Edge).
//  'unknown' not installed on the machine where this was measured, so it is
//            attempted, read back, and reported from profile presence --
//            an unknown that works is picked up, one that does not is
//            reported as needing a manual load. Nothing is assumed.
//  'refused' measured to fail (Chrome, Brave). Writing a policy value that
//            is dropped during validation is litter in someone's registry
//            and would make the coverage report claim a spoof that is not
//            happening.
const FORCE_INSTALLABLE = browsers.CHROMIUM
    .filter(b => b.policy && (b.forcelist === 'works' || b.forcelist === 'unknown'))
    .map(b => b.id);

//  The narrower set: measured to work, not merely attempted. This is the only
//  list allowed to stand behind the sentence "set up automatically and needs
//  nothing from you", and it is what needManualLoad() treats as covered.
//
//  The difference is not pedantry. With 'unknown' in that set, a fork that
//  quietly dropped our entry during policy validation was filtered out of the
//  manual-load list FOREVER -- presence() would keep saying 'absent' and
//  nobody would ever be told. Now an unknown fork is told about until its own
//  profile proves the extension arrived, at which point presence() removes it
//  from the list by itself.
const FORCE_WORKS = browsers.CHROMIUM
    .filter(b => b.policy && b.forcelist === 'works')
    .map(b => b.id);


function sh(cmd) {
    return execSync(cmd, { windowsHide: true, encoding: 'utf8', stdio: 'pipe' });
}
function shq(cmd) { try { sh(cmd); return true; } catch (e) { return false; } }

/**
 * Every named REG_SZ under `key`, as { name: value }. {} if the key is absent.
 *
 * The key's DEFAULT value is deliberately excluded. `reg add <key> /f` sets it
 * to an empty string as a side effect, so a forcelist subkey that anything has
 * ever created carries one -- and counting it made restore() conclude the
 * subkey was still in use and leave it behind for good. A Chromium list policy
 * only ever reads numbered values, so the default is never meaningful here.
 */
function regValues(key) {
    let out;
    try { out = sh(`reg query "${key}"`); } catch (e) { return {}; }
    const vals = {};
    for (const line of out.split(/\r?\n/)) {
        const m = line.match(/^\s{4}(\S+)\s+REG_SZ\s+(.*)$/);
        if (m && m[1] !== '(Default)') vals[m[1]] = m[2].trim();
    }
    return vals;
}

/**
 * ONE named REG_SZ, exactly as stored, or null.
 *
 * Separate from regValues() because a JSON dictionary policy is not a
 * numbered list entry: it can legitimately contain runs of spaces, so the
 * `\s+` in regValues()'s pattern would eat part of the value. The type name
 * is located instead, and everything after it is the value.
 */
function regValue(key, name) {
    let out;
    try { out = sh(`reg query "${key}" /v ${name}`); } catch (e) { return null; }
    for (const line of out.split(/\r?\n/)) {
        const i = line.indexOf('REG_SZ');
        if (i > 0 && line.slice(0, i).trim() === name) return line.slice(i + 6).trim();
    }
    return null;
}

/**
 * ONE named REG_SZ out of a NAMED registry view, or null.
 *
 * Same parsing as regValue(); the view matters because reg.exe reads and
 * writes whichever view its own process bitness selects, and a 32-bit browser
 * looks in WOW6432Node. Reading back the view we wrote is the only way the
 * write is actually proven for the browser that will read it.
 */
function regValueView(key, name, view) {
    let out;
    try { out = sh(`reg query "${key}" /v ${name} /reg:${view}`); } catch (e) { return null; }
    for (const line of out.split(/\r?\n/)) {
        const i = line.indexOf('REG_SZ');
        if (i > 0 && line.slice(0, i).trim() === name) return line.slice(i + 6).trim();
    }
    return null;
}

/**
 * Write one REG_SZ and PROVE it, by two routes.
 *
 * `reg add /d` is the direct route and it takes a JSON payload correctly once
 * every `"` is escaped as `\"` -- measured, byte-exact, including values that
 * contain spaces. What it cannot take is length: the whole command line is
 * capped, and an existing enterprise ExtensionSettings can be kilobytes. So
 * when the read-back does not match, the payload goes through a `.reg` file
 * instead, where the only escapes are `\\` and `\"` and there is no limit --
 * also measured byte-exact.
 *
 * Either way the value is read back and compared before this returns true. A
 * registry write reported as successful without being checked is how a whole
 * round of wrong conclusions got drawn in this project once already.
 */
function regWriteSz(key, name, data) {
    if (shq(`reg add "${key}" /v ${name} /t REG_SZ /d "${data.replace(/"/g, '\\"')}" /f`) &&
        regValue(key, name) === data) return true;

    const file = path.join(os.tmpdir(), `fp-${name}-${process.pid}.reg`);
    try {
        const hive = key.replace(/^HKLM\\/i, 'HKEY_LOCAL_MACHINE\\')
                        .replace(/^HKCU\\/i, 'HKEY_CURRENT_USER\\');
        //  BOM + UTF-16LE is what reg.exe expects of a 5.00 file. Backslash
        //  first, or the escaping of the quotes would then be escaped again.
        fs.writeFileSync(file,
            '﻿Windows Registry Editor Version 5.00\r\n\r\n' +
            `[${hive}]\r\n"${name}"="` +
            data.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"\r\n', 'utf16le');
        shq(`reg import "${file}"`);
    } catch (e) { /* fall through to the read-back, which is the verdict */ }
    try { fs.unlinkSync(file); } catch (e) {}
    return regValue(key, name) === data;
}

// ════════════════════════════════════════════════════════════════════
//  GeoExt
// ════════════════════════════════════════════════════════════════════
class GeoExt {
    /**
     * @param {object} opts
     * @param {object} opts.log        debug/info/warn/error/success
     * @param {string} opts.stateDir   writable dir (ProgramData) for the key,
     *                                 the staged extension and the journal
     * @param {string} opts.sourceDir  the repo's Extension/ directory
     */
    constructor({ log, stateDir, sourceDir }) {
        this.log       = log;
        this.sourceDir = sourceDir;
        this.stateDir  = stateDir;
        //  One folder for the user to open, holding the instructions and the
        //  extension. The extension gets its own subdirectory so that folder
        //  stays byte-identical to what was packaged: a browser watches an
        //  unpacked extension's directory and reloads it on any change, and
        //  dropping a README beside the manifest would both churn the reload
        //  and end up inside the signed CRX.
        this.baseDir   = path.join(stateDir, 'browser-setup');
        this.dir       = path.join(this.baseDir, 'extension');
        this.keyFile   = path.join(stateDir, 'ext-key.pem');
        this.stateFile = path.join(stateDir, 'ext-restore.json');
        this.host      = new ExtHost({ log });
        this.id        = null;
        this.version   = null;
        //  Set once the extension is published; until then Chrome and Brave
        //  have no automatic route and the app says so rather than pretending.
        this.webstoreId = process.env.FP_GEO_WEBSTORE_ID || null;
        //  Browsers where route 2 (ExtensionSettings) was written and read
        //  back. Deliberately NOT the same thing as "covered": presence() is
        //  the only thing in this file allowed to say the extension is really
        //  running in a browser.
        this.attempted = [];
        //  Browsers where route 3 (the fork's own external-extensions key) was
        //  written and read back. Same rule: attempted, not covered.
        this.external = [];
    }

    // ── journal ─────────────────────────────────────────────────────
    _read() {
        try { return JSON.parse(fs.readFileSync(this.stateFile, 'utf8')); }
        catch (e) { return null; }
    }
    _write(j) {
        try { fs.writeFileSync(this.stateFile, JSON.stringify(j, null, 2), 'utf8'); }
        catch (e) { this.log.warn('Could not write the extension journal -- the ' +
                                  'force-install policy may be left behind', { err: e.message }); }
    }

    // ── staging ─────────────────────────────────────────────────────
    /**
     * Copy Extension/ into ProgramData with the public key injected.
     *
     * The `key` field is what makes the unpacked directory and the signed CRX
     * share one extension id. Without it Chromium derives an unpacked
     * extension's id from its path, so a browser that loaded the folder by
     * hand and a browser that force-installed the package would disagree
     * about what is installed, and presence detection would be wrong for one
     * of them.
     *
     * Generated files never go back into the repo's Extension/ -- that
     * directory is the source, and packaging must not mutate it.
     */
    _stage(spkiB64) {
        fs.mkdirSync(this.dir, { recursive: true });

        //  RECURSIVE, and it has to be. Extension/ has a flags/ subdirectory --
        //  73 country SVGs that popup.js loads with
        //  chrome.runtime.getURL('flags/<cc>.svg') -- and this used to copy
        //  top-level FILES only (`if (!statSync(src).isFile()) continue`). The
        //  source folder therefore looked perfect while every flag in the
        //  PACKAGED extension was a broken image, in exactly the build a user
        //  installs. crx.collect() walks subdirectories, so the package was
        //  never the problem; the staging directory it packs simply never had
        //  them.
        //
        //  Paths are collected as forward-slash relative names because that is
        //  what goes into the hash and into the zip.
        const rel = [];
        const walk = sub => {
            const abs = sub ? path.join(this.sourceDir, sub) : this.sourceDir;
            for (const n of fs.readdirSync(abs).sort()) {
                const r = sub ? sub + '/' + n : n;
                if (r === 'manifest.json') continue;   // written separately, with the key
                let st;
                try { st = fs.statSync(path.join(abs, n)); } catch (e) { continue; }
                if (st.isDirectory()) walk(r);
                else if (st.isFile()) rel.push(r);
            }
        };
        walk('');

        const h = crypto.createHash('sha256');
        for (const r of rel) {
            const buf = fs.readFileSync(path.join(this.sourceDir, r));
            h.update(r).update(buf);
            const dst = path.join(this.dir, r);
            //  Rewrite only on a real difference: an unpacked extension the
            //  user has loaded is watched by the browser, and rewriting every
            //  file on every connect makes it reload for no reason.
            let same = false;
            try { same = fs.readFileSync(dst).equals(buf); } catch (e) {}
            if (!same) {
                fs.mkdirSync(path.dirname(dst), { recursive: true });
                fs.writeFileSync(dst, buf);
            }
        }

        const mf = JSON.parse(fs.readFileSync(path.join(this.sourceDir, 'manifest.json'), 'utf8'));
        mf.key = spkiB64;
        h.update('manifest').update(JSON.stringify(mf));
        const hash = h.digest('hex');

        //  Drop anything the source no longer has. Without this, a file
        //  deleted from Extension/ would stay behind here and keep being
        //  loaded -- and packDir() packs the directory, so it would keep
        //  being shipped too. Directories are removed once emptied, so a
        //  whole folder dropped from the source does not linger.
        const keep = new Set([...rel, 'manifest.json']);
        const prune = sub => {
            const abs = sub ? path.join(this.dir, sub) : this.dir;
            for (const n of fs.readdirSync(abs)) {
                const r = sub ? sub + '/' + n : n;
                const p = path.join(abs, n);
                let st;
                try { st = fs.statSync(p); } catch (e) { continue; }
                if (st.isDirectory()) {
                    prune(r);
                    try { if (!fs.readdirSync(p).length) fs.rmdirSync(p); } catch (e) {}
                } else if (!keep.has(r)) {
                    try { fs.rmSync(p, { force: true }); } catch (e) {}
                }
            }
        };
        prune('');

        //  A monotonic fourth component, bumped only when the staged content
        //  actually changes. Chromium's updater compares versions, so a
        //  package that changed without its version moving is never picked up;
        //  bumping on every connect instead would make every connect look like
        //  an update and re-download 663 KB for nothing.
        const prev = this._read() || {};
        const base = String(mf.version).split('.').slice(0, 3).join('.');
        let build = Number.isInteger(prev.build) ? prev.build : 0;
        if (prev.hash !== hash) build += 1;
        mf.version = `${base}.${build}`;

        fs.writeFileSync(path.join(this.dir, 'manifest.json'), JSON.stringify(mf, null, 2), 'utf8');
        return { hash, build, version: mf.version };
    }

    /**
     * Make the extension ready to install: key, staged folder, signed package,
     * loopback host. Idempotent and safe to call on every connect.
     *
     * @returns {Promise<{id, version, dir, updateUrl}|null>}
     */
    async prepare() {
        let pem;
        try { pem = crx.ensureKey(this.keyFile); }
        catch (e) {
            this.log.error('Could not create the extension signing key -- browser ' +
                           'location spoofing is unavailable', { err: e.message });
            return null;
        }

        const spkiB64 = crypto.createPublicKey(pem)
            .export({ type: 'spki', format: 'der' }).toString('base64');

        let staged, packed;
        try {
            staged = this._stage(spkiB64);
            packed = crx.packDir({ dir: this.dir, privateKeyPem: pem });
        } catch (e) {
            this.log.error('Could not package the browser extension', { err: e.message });
            return null;
        }

        this.id      = packed.id;
        this.version = staged.version;

        //  WHICH PORT, and why it is not simply "the first free one".
        //
        //  Every policy already written on this machine names ONE port, and so
        //  does the bundle the logon helper serves. Landing on a different one
        //  would leave every one of those entries pointing at nothing -- which
        //  is the exact failure this whole delivery path exists to end. So the
        //  recorded port is tried first, and the 8082..8085 fallbacks stay
        //  behind it for the case where something else really has taken it.
        const prev = deliver.readBundle(this.stateDir);
        let port = null;
        if (prev && prev.port) {
            this.host.ports = [prev.port, ...this.host.ports.filter(p => p !== prev.port)];
            //  ...and if the helper is already there serving OUR manifest, the
            //  port is not "taken", it is already doing this job. Adopt it
            //  rather than shifting to 8082 and rewriting every policy: the
            //  helper reads the bundle from disk per request, so the bytes
            //  written below are what it hands out from now on.
            if (await deliver.probeOurs(prev.port, packed.id)) {
                this.host.adopt(prev.port);
                port = prev.port;
                this.log.debug(`Extension already served on 127.0.0.1:${port} by the delivery ` +
                               'helper -- using that port instead of opening a second listener');
            }
        }
        if (!port) port = await this.host.start();
        if (!port) return null;

        const xml = crx.updateManifestXml({
            id: packed.id,
            version: staged.version,
            codebase: `http://127.0.0.1:${port}/freeproxy-geo.crx`,
        });
        this.host.setPayload({ xml, crx: packed.crx, id: packed.id,
                               version: staged.version });

        //  The same two files on disk, for the helper that serves them when
        //  this process is gone. Elevated runs (installer, boot pass, the app
        //  itself) can write here; an unelevated one cannot, and writeBundle
        //  says so once rather than failing the whole prepare().
        deliver.writeBundle({ stateDir: this.stateDir, id: packed.id,
                              version: staged.version, port, crx: packed.crx,
                              xml, log: this.log });

        const j = this._read() || {};
        this._write({ ...j, hash: staged.hash, build: staged.build,
                      id: packed.id, version: staged.version });

        this.log.debug(`Extension ${packed.id} v${staged.version} ready ` +
                       `(${(packed.crx.length / 1024).toFixed(0)} KB, ${this.dir})`);
        return { id: packed.id, version: staged.version, dir: this.dir,
                 updateUrl: this.host.updateUrl() };
    }

    // ── force-install ───────────────────────────────────────────────
    /**
     * Add our entry to ExtensionInstallForcelist wherever that route works.
     *
     * The user's own forcelist entries are left exactly as they are: the
     * lowest FREE numeric slot is used, and only the slot we wrote is removed
     * on restore. Clearing the subkey wholesale -- which is what the earlier
     * blocking layer did with its own policy -- would silently uninstall
     * extensions the user's workplace requires.
     */
    install() {
        if (!this.id) return [];
        const url = this.host.updateUrl();
        if (!url) return [];

        //  Only browsers that are really on this machine. Writing a forcelist
        //  entry for a browser that is not installed would put a policy in a
        //  hive nobody reads and, worse, make the coverage report count a
        //  browser that cannot open a page.
        const here = new Set(browsers.detectChromium().map(b => b.id));
        const route = this.webstoreId ? Object.keys(POLICY_KEYS) : FORCE_INSTALLABLE;
        const targets = route.filter(id => here.has(id));

        const entry = this.webstoreId
            ? `${this.webstoreId};https://clients2.google.com/service/update2/crx`
            : `${this.id};${url}`;

        const j = this._read() || {};
        const slots = Array.isArray(j.slots) ? j.slots.slice() : [];
        const done = [];

        for (const id of targets) {
            const name = (browsers.byId(id) || {}).name || id;
            const key = `${POLICY_KEYS[id]}\\${FORCELIST}`;
            const vals = regValues(key);

            const existing = Object.keys(vals).find(k => vals[k] === entry);
            if (existing) { done.push(id); continue; }

            //  Do not disturb an entry that is already there under a different
            //  update URL -- an earlier run of this app on a different port.
            const ours = Object.keys(vals).find(k => vals[k].startsWith(this.id + ';'));
            const slot = ours || String(
                (() => { let n = 1; while (vals[String(n)] != null) n += 1; return n; })());

            //  No `reg add` for the key itself: reg.exe creates the whole path
            //  when the value is written, and `reg add <key> /f` would also
            //  set the key's default value to an empty string -- litter in a
            //  policy hive we do not own.
            if (!shq(`reg add "${key}" /v "${slot}" /t REG_SZ /d "${entry}" /f`)) {
                this.log.warn(`Could not force-install the extension in ${name} -- ` +
                              'administrator rights?');
                continue;
            }
            //  Read it back. A silent registry failure reported upstream as a
            //  successful install is how a whole round of wrong conclusions
            //  got drawn once already.
            if (regValues(key)[slot] !== entry) {
                this.log.warn(`${name}: the force-install entry did not stick`);
                continue;
            }
            //  Deduplicated on key+slot, not on the browser label: a journal
            //  written by an older build recorded the display name ('Edge')
            //  where this one records the id ('edge'), and matching on the
            //  label would add a second entry for the same registry value.
            if (!slots.some(s => s.key === key && s.slot === slot)) {
                slots.push({ browser: id, key, slot });
            }
            this._write({ ...j, slots });
            done.push(id);
        }

        if (done.length) {
            this.log.success('Location spoofer force-installed in ' +
                             browsers.names(done).join(', ') +
                             ' -- it replaces navigator.geolocation in the page itself, ' +
                             'so sites read the connected country instead of the real position');
        }

        //  The second route, over EVERY policy-capable browser that is really
        //  here -- including the two the list policy refuses. It is additive:
        //  `done` still only names browsers whose route is measured to work,
        //  so nothing downstream starts claiming Chrome is covered because a
        //  registry value was accepted. presence() decides that.
        this.attempted = this.installSettings();
        //  And the third, which is not policy at all, so it is the one route
        //  Chrome's management gate does not decide. Read at browser START,
        //  which is what the restart and the boot pass are for.
        this.external = this.installExternal();
        //  Fourth, and it installs nothing: it tells the browser our id is
        //  allowed, which is what stops it disabling what route 3 just handed
        //  it. See installAllowlist() -- MEASURED, this is the difference
        //  between an extension in Chrome's own Extensions folder and one that
        //  is in there and running.
        this.allowed = this.installAllowlist();
        return done;
    }

    /**
     * Route 2: ExtensionSettings -- one JSON dictionary per browser.
     *
     * WHAT IT WRITES
     *   { "<our id>": { installation_mode: "force_installed",
     *                   update_url: "http://127.0.0.1:<port>/update.xml",
     *                   toolbar_pin: "force_pinned" } }
     *
     * WHERE IT REFUSES TO WRITE, AND WHY THAT MATTERS MORE
     * A dictionary policy is a single value, so "add our entry" means
     * rewriting the whole thing. On a machine whose ExtensionSettings already
     * holds somebody else's configuration -- a workplace `"*"` rule, a list of
     * required extensions, blocked permissions -- that rewrite is the one
     * mistake in this file that could break software the user needs and cannot
     * fix themselves. So it is not made: if the existing value contains
     * anything that is not ours, this browser is skipped and the reason is
     * logged. Nothing is lost by that -- a machine with an enterprise
     * ExtensionSettings is a MANAGED machine, and on a managed machine route 1
     * already works, which is the whole reason Chrome gates route 1 on
     * management in the first place.
     *
     * The previous raw value is journaled either way, so restore() can put the
     * value back or take it away exactly as it found it.
     */
    installSettings() {
        if (!this.id) return [];
        const url = this.host.updateUrl();
        if (!url) return [];

        const here = new Set(browsers.detectChromium().map(b => b.id));
        const targets = Object.keys(POLICY_KEYS).filter(id => here.has(id));

        const mine = this.webstoreId || this.id;
        const entry = this.webstoreId
            ? { installation_mode: 'force_installed',
                update_url: 'https://clients2.google.com/service/update2/crx',
                toolbar_pin: 'force_pinned' }
            : { installation_mode: 'force_installed', update_url: url,
                toolbar_pin: 'force_pinned' };

        const j = this._read() || {};
        const settings = Array.isArray(j.settings) ? j.settings.slice() : [];
        const done = [];

        for (const id of targets) {
            const name = (browsers.byId(id) || {}).name || id;
            const key = POLICY_KEYS[id];
            const raw = regValue(key, EXT_SETTINGS);

            let cur = {};
            if (raw) {
                try { cur = JSON.parse(raw); } catch (e) { cur = null; }
                if (!cur || typeof cur !== 'object' || Array.isArray(cur)) {
                    this.log.warn(`${name}: ExtensionSettings is already set to something ` +
                                  'this app cannot read, so it was left alone');
                    continue;
                }
                const foreign = Object.keys(cur).filter(k => k !== mine);
                if (foreign.length) {
                    this.log.info(`${name}: ExtensionSettings already carries a policy for ` +
                                  `${foreign.length} other extension(s) -- left untouched ` +
                                  '(a machine managed like this accepts the forcelist route)');
                    continue;
                }
            }

            const next = JSON.stringify({ ...cur, [mine]: entry });
            if (next === raw) { done.push(id); continue; }

            //  Journal BEFORE the write: a crash between the two would
            //  otherwise leave a value with nothing recording what was there.
            if (!settings.some(s => s.key === key)) {
                settings.push({ browser: id, key, name: EXT_SETTINGS, prev: raw, id: mine });
                this._write({ ...j, settings });
            }

            if (!regWriteSz(key, EXT_SETTINGS, next)) {
                this.log.warn(`${name}: the ExtensionSettings force-install entry did not ` +
                              'stick -- administrator rights?');
                continue;
            }
            done.push(id);
        }

        if (done.length) {
            this.log.debug('ExtensionSettings force-install written for ' +
                           browsers.names(done).join(', ') +
                           ' (second route; whether it is honoured is read back from the ' +
                           'browser itself, never assumed)');
        }
        return done;
    }

    /**
     * Route 4: ExtensionInstallAllowlist -- the id, and nothing else.
     *
     * This is the smallest write in this file and the one with the largest
     * measured effect. Route 3 puts the extension in the browser's own
     * Extensions folder; this is what stops the browser switching it off again
     * for not coming from the Web Store (disable_reasons [256], greylist).
     *
     * It is a LIST policy, so the same rules as the forcelist apply and for the
     * same reason: the lowest free numbered slot is used, an existing slot
     * carrying our id is reused rather than duplicated, and only the slot we
     * wrote is ever removed. An allowlist is somewhere a workplace puts the
     * handful of extensions it permits -- clearing it wholesale would be
     * indistinguishable from banning every one of them.
     *
     * Written for every policy-capable browser present, not only the ones that
     * refuse route 1: it is harmless where nothing was disabled, and the browser
     * that needs it cannot be known in advance -- Edge greylists too.
     *
     * @returns {string[]} browser ids whose slot was written AND read back
     */
    installAllowlist() {
        const mine = this.webstoreId || this.id;
        if (!mine) return [];

        const here = new Set(browsers.detectChromium().map(b => b.id));
        const targets = Object.keys(POLICY_KEYS).filter(id => here.has(id));

        const j = this._read() || {};
        const allow = Array.isArray(j.allow) ? j.allow.slice() : [];
        const done = [];

        for (const id of targets) {
            const name = (browsers.byId(id) || {}).name || id;
            const key = `${POLICY_KEYS[id]}\\${ALLOWLIST}`;
            const vals = regValues(key);

            //  Already allowed -- by us on an earlier run, or by an
            //  administrator who got there first. Either way, nothing to write
            //  and nothing to journal: a slot we did not create is not ours to
            //  remove later.
            const existing = Object.keys(vals).find(k => vals[k] === mine);
            if (existing) { done.push(id); continue; }

            const slot = String(
                (() => { let n = 1; while (vals[String(n)] != null) n += 1; return n; })());

            if (!shq(`reg add "${key}" /v "${slot}" /t REG_SZ /d "${mine}" /f`)) {
                this.log.warn(`Could not add the extension to ${name}'s allowed list -- ` +
                              'administrator rights?');
                continue;
            }
            if (regValues(key)[slot] !== mine) {
                this.log.warn(`${name}: the allowlist slot did not stick`);
                continue;
            }
            if (!allow.some(s => s.key === key && s.slot === slot)) {
                allow.push({ browser: id, key, slot, id: mine });
            }
            this._write({ ...j, allow });
            done.push(id);
        }

        if (done.length) {
            this.log.info('Extension id allowed in ' + browsers.names(done).join(', ') +
                          ' -- this is what keeps a browser from disabling it for not ' +
                          'being in the Web Store; it installs nothing by itself');
        }
        return done;
    }

    /**
     * Route 3: the browser's OWN external-extension provider, per fork.
     *
     *   HKLM\SOFTWARE\<vendor>\<browser>\Extensions\<our id>
     *       update_url = http://127.0.0.1:<port>/update.xml
     *
     * WHY THIS IS A THIRD DOOR AND NOT THE REFUSED ONE
     * lib/browsers.js records "a local CRX path in the External Extensions
     * registry key" as measured-refused. That is the `path` value, which asks
     * the browser to install a file off the disk. This writes `update_url`
     * instead: the same key, a different provider branch in Chromium, and the
     * documented way an installer OFFERS an extension to a browser it does not
     * own. It is also the only route that is not policy, so it is the only one
     * whose refusal is not decided by whether the machine is managed.
     *
     * WHY THE BOOT PASS STILL EARNS ITS PLACE
     * The first measurement said this provider is read only while a browser
     * STARTS. A longer one, 2026-08-30, says something better: Chrome had been
     * up 28.4 h -- since before this key existed -- and took the extension
     * 107.6 min after it was written, having never been restarted. Brave,
     * started 12 min after the write, had it 3 min after that.
     *
     *     Brave   started after the write  ->  +3 min from its own start
     *     Chrome  running throughout       ->  +107.6 min, no restart at all
     *     Edge    running throughout       ->  +93.7 min (its policy route)
     *
     * So the entry is not start-only, and the restart is not what makes it
     * work: a start is the fast path. That is what one restart buys -- seconds
     * instead of up to two hours, for every browser at once, which is why
     * lib/installer-tasks.js runs this again before login. A user who declines
     * the restart loses no coverage, only time.
     *
     * BOTH REGISTRY VIEWS
     * reg.exe writes the view of the process that called it. A 32-bit fork
     * reads the 32-bit view. Two calls, and the question does not exist.
     *
     * Returns the browser ids whose value was written AND read back. That is
     * still not "covered": presence() is the only thing allowed to say that.
     */
    installExternal() {
        if (!this.id) return [];
        const url = this.webstoreId
            ? 'https://clients2.google.com/service/update2/crx'
            : this.host.updateUrl();
        if (!url) return [];
        const mine = this.webstoreId || this.id;

        const j = this._read() || {};
        const external = Array.isArray(j.external) ? j.external.slice() : [];
        const done = [];

        for (const row of browsers.externalRoots('installed')) {
            const key = `${row.key}\\${mine}`;
            let wrote = false;
            for (const view of browsers.REG_VIEWS) {
                if (!shq(`reg add "${key}" /v update_url /t REG_SZ /d "${url}" ` +
                         `/f /reg:${view}`)) continue;
                if (regValueView(key, 'update_url', view) !== url) continue;
                wrote = true;
                if (!external.some(e => e.key === key && e.view === view)) {
                    external.push({ browser: row.id, key, view, url, id: mine });
                }
            }
            if (!wrote) {
                this.log.warn(`Could not offer the extension to ${row.name} through its ` +
                              'own external-extensions key -- administrator rights?');
                continue;
            }
            this._write({ ...j, external });
            done.push(row.id);
        }

        if (done.length) {
            this.log.debug('External-extensions entry written for ' +
                           browsers.names(done).join(', ') +
                           ' (third route; a browser takes it at its next start, or on ' +
                           'its own within about two hours, and presence() reads the ' +
                           'answer out of its profile)');
        }
        return done;
    }

    /** Remove only the shape we wrote, and only while it still points at us. */
    _restoreExternal(j) {
        const rows = (j && Array.isArray(j.external)) ? j.external : [];
        let n = 0;
        const parents = [];
        for (const e of rows) {
            const view = e.view || '64';
            const cur = regValueView(e.key, 'update_url', view);
            if (cur == null) continue;
            //  Ours only. A store id could in principle have been put there by
            //  something else, so the recorded URL has to match as well.
            if (e.url && cur !== e.url) continue;
            if (!e.url && !/^https?:\/\/127\.0\.0\.1(:\d+)?\//i.test(cur)) continue;
            //  The whole subkey goes: it is named after our extension id, so
            //  unlike a forcelist slot or a settings dictionary there is
            //  nothing of anyone else's inside it to preserve.
            if (shq(`reg delete "${e.key}" /f /reg:${view}`)) {
                n += 1;
                const up = e.key.replace(/\\[^\\]+$/, '');
                if (!parents.some(p => p.key === up && p.view === view)) {
                    parents.push({ key: up, view });
                }
            } else {
                this.log.warn('Could not remove our external-extensions key from ' +
                              `${(browsers.byId(e.browser) || {}).name || e.browser}`);
            }
        }
        //  ...and the Extensions key itself, if writing ours is what created it.
        for (const p of parents) pruneExternalRoot(p.key, p.view);
        if (n) this.log.debug(`External-extensions key removed (${n} entr${n === 1 ? 'y' : 'ies'})`);
    }

    /** Remove only the slots we wrote, and only if they still hold our entry. */
    restore() {
        const j = this._read();
        const slots = (j && Array.isArray(j.slots)) ? j.slots : [];
        //  At startup nothing has been packaged yet, so this.id is null; the
        //  journal's own id is the right expectation then. Without this the
        //  startup sweep would delete whatever now sits in that slot, which
        //  could be an extension the user's workplace requires.
        const mine = [this.id, j && j.id, this.webstoreId].filter(Boolean);
        for (const s of slots) {
            const cur = regValues(s.key)[s.slot];
            if (cur == null) continue;
            //  Someone else owns this slot now. Leaving it alone is the only
            //  safe move.
            if (!/^[a-p]{32};/.test(cur)) continue;
            if (mine.length && !mine.some(id => cur.startsWith(id + ';'))) continue;
            shq(`reg delete "${s.key}" /v "${s.slot}" /f`);
        }
        if (slots.length) {
            //  Only if we emptied it. A forcelist subkey with the user's own
            //  entries still in it must survive.
            for (const s of slots) {
                if (!Object.keys(regValues(s.key)).length) shq(`reg delete "${s.key}" /f`);
            }
            this.log.debug('Extension force-install policy removed');
        }
        this._restoreSettings(j);
        this._restoreExternal(j);
        this._restoreAllowlist(j);
        if (j) this._write({ ...j, slots: [], settings: [], external: [], allow: [] });
    }

    /**
     * Undo route 4: the allowlist slots, by exact match on the id.
     *
     * Separate from the forcelist loop above because the value shape is
     * different -- a bare id, not `id;url` -- and a slot holding somebody
     * else's bare id must not be read as ours by a prefix test that was written
     * for the other format. Same two rules as everywhere else: only slots this
     * app journalled, and only while they still hold what it put there.
     */
    _restoreAllowlist(j) {
        const allow = (j && Array.isArray(j.allow)) ? j.allow : [];
        if (!allow.length) return;
        const mine = [this.id, j && j.id, this.webstoreId].filter(Boolean);
        let n = 0;
        for (const s of allow) {
            const cur = regValues(s.key)[s.slot];
            if (cur == null) continue;
            const want = s.id || null;
            if (want ? cur !== want : !mine.includes(cur)) continue;
            if (shq(`reg delete "${s.key}" /v "${s.slot}" /f`)) n += 1;
        }
        //  And the subkey, only if ours was the last thing in it.
        for (const s of allow) {
            if (!Object.keys(regValues(s.key)).length) shq(`reg delete "${s.key}" /f`);
        }
        if (n) this.log.debug(`Extension allowlist entry removed (${n})`);
    }

    /**
     * Undo route 2, by REMOVING OUR KEY rather than by restoring the old blob.
     *
     * Writing the journalled `prev` back verbatim looks tidier and is wrong: it
     * would silently undo anything an administrator has changed in that policy
     * since -- an extension they added last week would vanish when this app is
     * uninstalled. So the current value is parsed, our own id is deleted, and
     * what is left is written back. The value itself only goes away when
     * removing our id leaves it empty, which is the same "only if we are what
     * emptied it" rule the forcelist slots follow.
     *
     * `prev` is still recorded, and still useful: it is the only record of what
     * the value held before this app existed, if a human ever has to look.
     */
    _restoreSettings(j) {
        const rows = (j && Array.isArray(j.settings)) ? j.settings : [];
        let n = 0;
        for (const s of rows) {
            const raw = regValue(s.key, s.name || EXT_SETTINGS);
            if (raw == null) continue;
            let cur;
            try { cur = JSON.parse(raw); } catch (e) { continue; }
            if (!cur || typeof cur !== 'object') continue;

            //  Ours by id, and only ours. An older journal may not have
            //  recorded one, in which case any 32-letter id served from this
            //  machine's own loopback is unmistakably this app's.
            const ids = Object.keys(cur).filter(k =>
                (s.id ? k === s.id : false) ||
                (/^[a-p]{32}$/.test(k) &&
                 /^https?:\/\/127\.0\.0\.1(:\d+)?\//i.test(String(cur[k] && cur[k].update_url))));
            if (!ids.length) continue;
            for (const k of ids) delete cur[k];

            const left = Object.keys(cur).length;
            const gone = left
                ? regWriteSz(s.key, s.name || EXT_SETTINGS, JSON.stringify(cur))
                : shq(`reg delete "${s.key}" /v ${s.name || EXT_SETTINGS} /f`);
            if (gone) n += 1;
            else this.log.warn(`Could not remove our ExtensionSettings entry from ` +
                               `${(browsers.byId(s.browser) || {}).name || s.browser}`);
        }
        if (n) this.log.debug(`ExtensionSettings entry removed from ${n} browser(s)`);
    }

    // ── presence ────────────────────────────────────────────────────
    /**
     * Is the extension actually present AND ON in each browser? Detected, not
     * assumed, because most Chromium forks put an installer-delivered extension
     * in the profile switched OFF, and the whole point of this report is to say
     * which browsers are really covered.
     *
     * Keyed by browser id, over the WHOLE Chromium table:
     *
     *   'installed'     in the profile and enabled -- the location IS spoofed
     *   'needs-enable'  in the profile, switched off until the user accepts it
     *   'declined'      the user was asked and chose Remove
     *   'absent'        browser is installed here, extension is not
     *   'not-present'   browser is not installed on this machine
     *
     * MEASURED, which is why 'needs-enable' has to exist at all: with the
     * delivery helper serving the CRX the policies name, Edge installs it at
     * location 7 with no disable reason and starts its service worker, while
     * Chrome and Brave unpack the same bytes at location 6 and record
     * disable_reasons [8192] = EXTERNAL_EXTENSION. Reporting those two as
     * 'installed' would print "spoofed by the extension" about an extension
     * that is not running.
     *
     * A browser is only anything other than 'not-present' if lib/browsers.js
     * verified its executable on disk. A leftover profile from an uninstalled
     * browser is 'not-present' -- reporting it as absent would put a browser
     * the user does not have into a "do this by hand" instruction.
     */
    presence() {
        const here = new Map(browsers.detectChromium().map(b => [b.id, b]));
        const out = {};
        for (const b of browsers.CHROMIUM) {
            const live = here.get(b.id);
            if (!live) { out[b.id] = 'not-present'; continue; }
            const st = live.dataDir ? this._stateIn(live.dataDir) : null;
            out[b.id] = !st ? 'absent'
                      : st.enabled ? 'installed'
                      : st.removedByUser ? 'declined'
                      : st.present ? 'needs-enable'
                      : 'absent';
        }
        return out;
    }

    /**
     * The same read, with the detail: {present, enabled, removedByUser,
     * profile, location, locationName, disabled[], version, unpacked} per
     * browser id, for the browsers installed here. presence() is the summary
     * of this; the log and the boot report want the reason, not just the word.
     */
    states() {
        const out = {};
        for (const b of browsers.detectChromium()) {
            if (!b.dataDir) continue;
            out[b.id] = browsers.extensionState(b.dataDir, this.id);
        }
        return out;
    }

    //  One implementation, in lib/browsers.js, because the delivery helper needs
    //  the "are the bytes there" half of exactly this read to know when it can
    //  exit -- and two copies of "is the extension really in this profile" would
    //  be two chances to disagree about whether a browser is covered.
    //
    //  What it looks at: the browser's own extensions.settings entry in Secure
    //  Preferences (then plain Preferences, where a hand-loaded folder may
    //  live), plus Extensions\<id>\ on disk. location and disable_reasons come
    //  from that entry, so "present" and "enabled" are separate answers.
    _stateIn(userData) {
        if (!this.id) return null;
        return browsers.extensionState(userData, this.id);
    }

    //  Kept as the bytes-only question, phrased exactly as the delivery helper
    //  asks it: once the payload is unpacked in the profile there is nothing
    //  left for a local HTTP server to hand over, accepted or not.
    _presentIn(userData) {
        if (!this.id) return false;
        return browsers.profileHasExtension(userData, this.id);
    }

    /**
     * Browsers that are installed but have no automatic route and no
     * extension loaded yet -- i.e. the ones the user must load once by hand.
     * Returns browser ids; browsers.names() turns them into user-facing text.
     *
     * A browser with a route ARMED and simply not restarted yet is excluded:
     * see awaitingStart(). Asking someone to turn on Developer mode and pick a
     * folder, for an extension the machine will hand that browser by itself the
     * next time it starts, is work invented by a stale read.
     */
    needManualLoad() {
        const auto = new Set(this.webstoreId ? Object.keys(POLICY_KEYS) : FORCE_WORKS);
        const seen = this.presence();
        const armed = new Set(this.awaitingStart(seen));
        return Object.keys(seen).filter(id => seen[id] === 'absent' &&
                                              !auto.has(id) && !armed.has(id));
    }

    /**
     * Browsers with nothing in the profile yet, but a route already armed for
     * them in the registry -- so the honest sentence is "it arrives at that
     * browser's next start, or on its own within about two hours", not "load it
     * by hand".
     *
     * MEASURED, on this machine, with all four routes written at 22:59:33 and
     * the delivery helper serving the CRX the whole time:
     *
     *   Brave    started 23:11:45 (AFTER the keys)  -> extension in the profile
     *            at 23:14:47, three minutes later, location 6, switched off
     *   Edge     running since 19:10:53 (BEFORE)    -> arrived at 00:33:18,
     *            93.7 min after the keys, location 7, ENABLED, worker running
     *   Chrome   running since 19:10:53 (BEFORE)    -> nothing for an hour and a
     *            half, then arrived at 00:47:10, 107.6 min after the keys,
     *            location 6, switched off, having never been restarted (its
     *            process was 28.4 h old when this was read back)
     *
     * The first pass stopped measuring after Chrome's first hour and concluded
     * route 3 is read only while a browser STARTS. Chrome's own folder mtime
     * says otherwise: both routes reach a RUNNING browser, on the order of an
     * hour and a half. A start is simply the fast path -- three minutes.
     *
     * So this bucket is not "blocked until a restart". It is "already done,
     * arriving on its own, and a restart makes it immediate for every browser at
     * once". Never spend the user's clicks on what is already in flight.
     *
     * Read back from the registry rather than trusted from the journal: the
     * journal says what we wrote, and this has to answer what is still there.
     *
     * @param {object} [seen] a presence() map, when the caller already has one
     * @returns {string[]} browser ids
     */
    awaitingStart(seen) {
        const st = seen || this.presence();
        const j = this._read() || {};
        return Object.keys(st).filter(id => st[id] === 'absent' && this._armedFor(id, j));
    }

    /**
     * Is one of the routes we wrote still in the registry for this browser?
     *
     * Only the two that a browser picks up on its own without the user: the
     * external-extensions provider (route 3) and a forcelist slot (route 1).
     * ExtensionSettings and the allowlist permit an install, they do not cause
     * one, so a browser holding only those has nothing on the way to it.
     */
    _armedFor(id, journal) {
        const j = journal || this._read() || {};
        for (const e of (Array.isArray(j.external) ? j.external : [])) {
            if (e.browser !== id) continue;
            const cur = regValueView(e.key, 'update_url', e.view || '64');
            if (cur && (!e.url || cur === e.url)) return true;
        }
        for (const s of (Array.isArray(j.slots) ? j.slots : [])) {
            if (s.browser !== id || !this.id) continue;
            const cur = regValues(s.key)[s.slot];
            if (cur && cur.split(';')[0] === this.id) return true;
        }
        return false;
    }

    /**
     * Browsers where the work is done and one switch is left: the extension is
     * in the profile, off, waiting for the acknowledgment Chromium reserves for
     * the user. Nothing we can write flips it -- the entry that holds the
     * enabled bit is HMAC-signed with a per-profile key (super_mac), so writing
     * it ourselves is forgery, and Chromium drops a profile whose macs do not
     * verify. One click, and it is permanent.
     */
    needEnable() {
        const seen = this.presence();
        return Object.keys(seen).filter(id => seen[id] === 'needs-enable');
    }

    /**
     * Written next to the staged extension so the instructions are wherever
     * the user ends up looking, not only in a toast that has faded.
     *
     * Deliberately in baseDir, NOT in the extension folder: that folder is
     * what the browser loads and watches, and it must stay exactly as it was
     * packaged.
     *
     * @param {string[]} ids        browser ids from needManualLoad()
     * @param {string[]} [enableIds] browser ids from needEnable() -- the
     *        extension is already in these, one switch away from running
     * @param {string[]} [restartIds] browser ids from awaitingStart() -- armed,
     *        and waiting only for that browser to be started once
     */
    writeHowTo(ids, enableIds, restartIds) {
        const rows = (ids || []).map(id => browsers.byId(id)).filter(Boolean);
        const on   = (enableIds || []).map(id => browsers.byId(id)).filter(Boolean);
        const soon = (restartIds || []).map(id => browsers.byId(id)).filter(Boolean);
        const auto = browsers.names(
            browsers.detectChromium().map(b => b.id).filter(id => FORCE_WORKS.includes(id)));

        const lines = [
            'FreeProxy VPN -- enable location spoofing in ' +
                ([...on, ...soon, ...rows].map(b => b.name).join(' and ') || 'your browser'),
            '='.repeat(72),
            '',
        ];
        if (auto.length) {
            lines.push(auto.join(' and ') + ' ' + (auto.length > 1 ? 'are' : 'is') +
                       ' set up automatically and need nothing from you.', '');
        }
        //  The one-click case comes FIRST, because it is the one the user will
        //  almost always have: the download already happened, unattended, and
        //  what is left is the switch Chromium will not let an installer touch.
        if (on.length) {
            lines.push(
                'ALREADY DOWNLOADED -- one switch left',
                '-'.repeat(72),
                'The extension is installed in ' + on.map(b => b.name).join(' and ') +
                    ' already. Chromium keeps',
                'anything an installer put there switched OFF until you say yes once,',
                'and no setting, policy or registry value can say it for you -- the',
                'record that holds that bit is signed with a key that belongs to your',
                'browser profile. So it is one click, and it is permanent:',
                '');
            for (const b of on) {
                lines.push(
                    `  ${b.name}`,
                    `    1. Open  ${b.settings || 'chrome://extensions'}`,
                    '    2. Find "FreeProxy VPN Extension"',
                    '    3. Turn its switch ON (or click Enable / Turn on extension)',
                    '');
            }
            lines.push(
                'Nothing else. No Developer mode, no folder to pick, and the country',
                'you connect to is delivered live over the local link to this app.',
                '');
        }
        //  Zero clicks owed here, only patience or a restart. A browser takes
        //  the entry that offers it an extension at its next start, or by itself
        //  within about two hours -- measured 2026-08-30: Brave +3 min from its
        //  own start, Chrome +107.6 min having never been restarted, Edge
        //  +93.7 min on its policy route. Telling someone to load a folder by
        //  hand in that state is asking for work the browser does for free.
        if (soon.length) {
            const who = soon.map(b => b.name).join(' and ');
            lines.push(
                'ALREADY SET UP -- nothing to do by hand',
                '-'.repeat(72),
                'The extension is registered for ' + who + ', and has not arrived',
                'there yet. ' + (soon.length > 1 ? 'They were' : 'It was') +
                    ' open when this app registered it, and a browser',
                'picks a registration like this up at its next start, or on its own',
                'within about two hours. Measured on this machine: 3 minutes for a',
                'browser started afterwards, 93 to 108 minutes for two left running.',
                '',
                'To have it now rather than later:',
                '',
                '  1. Close ' + who + ' completely (every window).',
                '  2. Open it again -- the extension is there.',
                '  3. It arrives switched off, because Chromium keeps anything an',
                '     installer offered off until you accept it once, and no policy',
                '     or registry value can accept it for you. So turn it on:',
                '');
            for (const b of soon) {
                lines.push(`       ${b.name}:  ${b.settings || 'chrome://extensions'}` +
                           '  ->  "FreeProxy VPN Extension"  ->  switch ON');
            }
            lines.push(
                '',
                'A restart of Windows does step 1 and 2 for every browser at once,',
                'which is why this app asks for one after installing.',
                '');
        }
        if (!rows.length) {
            lines.push('To undo it, remove "FreeProxy VPN Extension" from that same page.', '');
            this._writeHowToFile(lines);
            return;
        }
        lines.push(
            'NOT DELIVERED -- load it by hand, once',
            '-'.repeat(72),
            'Both automatic routes have already been TRIED for the browsers listed',
            'below, and this section only exists because they were refused:',
            '',
            '  * ExtensionInstallForcelist -- the classic force-install policy.',
            '  * ExtensionSettings -- the dictionary policy Google now documents',
            '    in its place, validated by a different code path in Chromium.',
            '',
            'Chrome also ignores --load-extension outright, with a branded message',
            'and no flag that reverses it. Chrome and Brave drop a self-hosted',
            'entry from BOTH policies during validation unless the machine is',
            'joined to a domain, joined to Azure AD, or enrolled in Chrome Browser',
            'Cloud Management -- so on a work laptop this step is not needed and',
            'nothing below will be asked of you. On a personal PC it is, and that',
            'is why every commercial VPN ships its browser extension through the',
            'Chrome Web Store instead.',
            '',
            'Once loaded it stays loaded. The connected country is delivered live',
            'over the local link to this app, so you never have to do this again,',
            'not even when you switch country.',
            '');
        for (const b of rows) {
            lines.push(
                b.name,
                '-'.repeat(b.name.length),
                `  1. Open  ${b.settings || 'chrome://extensions'}`,
                '  2. Turn ON "Developer mode" -- top right',
                '  3. Click "Load unpacked"',
                '  4. Select this folder:',
                '',
                '         ' + this.dir,
                '',
                '  5. Done. Reload any page that was already open.',
                '');
        }
        lines.push(
            'To undo it, remove "FreeProxy VPN Extension" from that same page.',
            '');
        this._writeHowToFile(lines);
    }

    _writeHowToFile(lines) {
        try {
            fs.mkdirSync(this.baseDir, { recursive: true });
            fs.writeFileSync(path.join(this.baseDir, 'HOW-TO-ENABLE.txt'), lines.join('\r\n'), 'utf8');
        } catch (e) { /* the toast and the log still carry it */ }
    }
}

/**
 * Remove a provider root we emptied -- but only if it was OURS to empty.
 *
 * `reg add HKLM\...\Extensions\<id>` creates the Extensions key on the way to
 * the id, so on a browser that had no externally-offered extension of its own
 * that key is a change of ours as much as the value inside it, and "revert
 * everything" means it goes too.
 *
 * It goes only when the browser has nothing else there. The `(Default)` value
 * that `reg add <key> /f` leaves behind is discounted -- counting it would make
 * "empty" impossible forever, which is the trap that has already been hit once
 * in this project.
 *
 * READ THE OUTPUT BY PREFIX, NOT BY ORDER
 * reg.exe prints the queried key as a header line ONLY when that key has values
 * of its own. A key with no values and one subkey prints the subkey path alone
 * -- measured, and it is why an earlier version of this function counted key
 * lines and deleted a key that still held someone else's entry. `reg delete /f`
 * takes the whole tree, so that was an administrator's external extension going
 * with ours. Every line is now classified by what it is: the key itself, a path
 * BELOW the key, or a value.
 *
 * @returns {boolean} the key existed, was ours alone, and is gone
 */
const HIVES = { HKLM: 'HKEY_LOCAL_MACHINE', HKCU: 'HKEY_CURRENT_USER',
                HKU: 'HKEY_USERS', HKCR: 'HKEY_CLASSES_ROOT',
                HKCC: 'HKEY_CURRENT_CONFIG' };
function pruneExternalRoot(key, view) {
    //  reg query echoes the hive spelled out in full. Without the expansion
    //  nothing below could recognise its own key, so an unknown hive is a
    //  refusal rather than a guess.
    const full = key.replace(/^(HK[A-Z]{1,2})\\/i,
                             (m, h) => (HIVES[h.toUpperCase()] || h) + '\\');
    if (!/^HKEY_/i.test(full)) return false;
    const me = full.toLowerCase();

    let out;
    try { out = sh(`reg query "${key}" /reg:${view}`); } catch (e) { return false; }
    for (const raw of out.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) continue;
        const low = line.toLowerCase();
        if (low === me) continue;                       //  the key itself
        if (low.startsWith(me + '\\')) return false;    //  a subkey: not ours
        if (/^\(Default\)\s+REG_/i.test(line)) continue;
        return false;                                   //  a value of theirs
    }
    return shq(`reg delete "${key}" /f /reg:${view}`);
}

/**
 * Table-wide removal of route 3, with no journal involved.
 *
 * The extension id is derived from a key generated per machine, so an install
 * that was interrupted -- or one whose journal was deleted with ProgramData --
 * leaves a subkey nothing else knows the name of. Every fork's provider root is
 * therefore enumerated, in both views, and a subkey is removed when BOTH of
 * these hold:
 *
 *   * its name is a 32-letter Chromium extension id, and
 *   * its update_url points at this machine's own loopback.
 *
 * That pair cannot describe anyone else's extension: nobody else serves an
 * extension from 127.0.0.1 on this PC. A Web Store id is deliberately NOT
 * swept -- if FP_GEO_WEBSTORE_ID is ever set, that id is journalled and
 * _restoreExternal() takes it out by exact match, because a store id is
 * something another installer could legitimately have put there too.
 *
 * @returns {number} subkeys removed
 */
function sweepExternal(log) {
    let n = 0;
    for (const row of browsers.externalRoots('all')) {
        for (const view of browsers.REG_VIEWS) {
            let out;
            try { out = sh(`reg query "${row.key}" /reg:${view}`); }
            catch (e) { continue; }
            let hit = 0;
            for (const line of out.split(/\r?\n/)) {
                const m = line.match(/\\([a-p]{32})\s*$/);
                if (!m) continue;
                const key = `${row.key}\\${m[1]}`;
                const url = regValueView(key, 'update_url', view);
                if (!url || !/^https?:\/\/127\.0\.0\.1(:\d+)?\//i.test(url)) continue;
                if (shq(`reg delete "${key}" /f /reg:${view}`)) { n += 1; hit += 1; }
            }
            //  Only when this sweep is what emptied it.
            if (hit) pruneExternalRoot(row.key, view);
        }
    }
    if (n && log) log.debug(`Swept ${n} leftover external-extensions key(s)`);
    return n;
}

module.exports = { GeoExt, POLICY_KEYS, FORCELIST, EXT_SETTINGS, ALLOWLIST,
                   FORCE_INSTALLABLE,
                   FORCE_WORKS, regValues, regValue, regValueView, regWriteSz,
                   pruneExternalRoot, sweepExternal };
