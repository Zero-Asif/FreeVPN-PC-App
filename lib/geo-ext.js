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
//  So:
//    * Edge  -- force-installed from the loopback update host. Automatic.
//    * Brave -- one-time "Load unpacked" (its --load-extension also works,
//      but only for a browser this app launches itself, and this app closes
//      browsers rather than starting them).
//    * Chrome -- one-time "Load unpacked". The only automatic route is Web
//      Store publication; set FP_GEO_WEBSTORE_ID once that exists and this
//      module force-installs it in all three.
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
const path   = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const crx = require('./crx');
const { ExtHost } = require('./ext-host');
const browsers = require('./browsers');

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

        const names = fs.readdirSync(this.sourceDir).filter(n => n !== 'manifest.json');
        const h = crypto.createHash('sha256');
        for (const n of names.slice().sort()) {
            const src = path.join(this.sourceDir, n);
            if (!fs.statSync(src).isFile()) continue;
            const buf = fs.readFileSync(src);
            h.update(n).update(buf);
            const dst = path.join(this.dir, n);
            //  Rewrite only on a real difference: an unpacked extension the
            //  user has loaded is watched by the browser, and rewriting every
            //  file on every connect makes it reload for no reason.
            let same = false;
            try { same = fs.readFileSync(dst).equals(buf); } catch (e) {}
            if (!same) fs.writeFileSync(dst, buf);
        }

        const mf = JSON.parse(fs.readFileSync(path.join(this.sourceDir, 'manifest.json'), 'utf8'));
        mf.key = spkiB64;
        h.update('manifest').update(JSON.stringify(mf));
        const hash = h.digest('hex');

        //  Drop anything the source no longer has. Without this, a file
        //  deleted from Extension/ would stay behind here and keep being
        //  loaded -- and packDir() packs the directory, so it would keep
        //  being shipped too.
        const keep = new Set([...names, 'manifest.json']);
        for (const n of fs.readdirSync(this.dir)) {
            if (!keep.has(n)) { try { fs.rmSync(path.join(this.dir, n), { recursive: true, force: true }); } catch (e) {} }
        }

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

        const port = await this.host.start();
        if (!port) return null;

        this.host.setPayload({
            xml: crx.updateManifestXml({
                id: packed.id,
                version: staged.version,
                codebase: `http://127.0.0.1:${port}/freeproxy-geo.crx`,
            }),
            crx: packed.crx,
            id: packed.id,
            version: staged.version,
        });

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
        return done;
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
        if (j) this._write({ ...j, slots: [] });
    }

    // ── presence ────────────────────────────────────────────────────
    /**
     * Is the extension actually present in each browser? Detected, not
     * assumed, because most Chromium forks need a one-time manual load and
     * the whole point of this report is to say which ones are really covered.
     *
     * Keyed by browser id, over the WHOLE Chromium table:
     *
     *   'installed'    packed/force-installed, unpacked, or both
     *   'absent'       browser is installed here, extension is not
     *   'not-present'  browser is not installed on this machine
     *
     * A browser is only 'absent' or 'installed' if lib/browsers.js verified
     * its executable on disk. A leftover profile from an uninstalled browser
     * is 'not-present' -- reporting it as absent would put a browser the user
     * does not have into a "do this by hand" instruction.
     */
    presence() {
        const here = new Map(browsers.detectChromium().map(b => [b.id, b]));
        const out = {};
        for (const b of browsers.CHROMIUM) {
            const live = here.get(b.id);
            if (!live) { out[b.id] = 'not-present'; continue; }
            out[b.id] = (live.dataDir && this._presentIn(live.dataDir)) ? 'installed' : 'absent';
        }
        return out;
    }

    _presentIn(userData) {
        if (!this.id) return false;
        let profiles = [];
        try {
            profiles = fs.readdirSync(userData).filter(d => /^(Default|Profile \d+)$/.test(d));
        } catch (e) { return false; }

        for (const p of profiles) {
            //  Unpacked or packed, the id turns up as a directory here for a
            //  CRX install...
            if (fs.existsSync(path.join(userData, p, 'Extensions', this.id))) return true;
            //  ...and as a key in the profile's extension settings for a
            //  folder loaded by hand. Chromium keeps those in Secure
            //  Preferences on Windows, so both files are checked. A substring
            //  test is enough: the id is a 32-character string that appears
            //  nowhere else, and this only ever drives a status message.
            for (const f of ['Preferences', 'Secure Preferences']) {
                try {
                    if (fs.readFileSync(path.join(userData, p, f), 'utf8').includes(this.id)) return true;
                } catch (e) { /* absent or locked */ }
            }
        }
        return false;
    }

    /**
     * Browsers that are installed but have no automatic route and no
     * extension loaded yet -- i.e. the ones the user must load once by hand.
     * Returns browser ids; browsers.names() turns them into user-facing text.
     */
    needManualLoad() {
        const auto = new Set(this.webstoreId ? Object.keys(POLICY_KEYS) : FORCE_INSTALLABLE);
        const seen = this.presence();
        return Object.keys(seen).filter(id => seen[id] === 'absent' && !auto.has(id));
    }

    /**
     * Written next to the staged extension so the instructions are wherever
     * the user ends up looking, not only in a toast that has faded.
     *
     * Deliberately in baseDir, NOT in the extension folder: that folder is
     * what the browser loads and watches, and it must stay exactly as it was
     * packaged.
     *
     * @param {string[]} ids  browser ids from needManualLoad()
     */
    writeHowTo(ids) {
        const rows = (ids || []).map(id => browsers.byId(id)).filter(Boolean);
        const auto = browsers.names(
            browsers.detectChromium().map(b => b.id).filter(id => FORCE_INSTALLABLE.includes(id)));

        const lines = [
            'FreeProxy VPN -- enable location spoofing in ' +
                (rows.map(b => b.name).join(' and ') || 'your browser'),
            '='.repeat(72),
            '',
        ];
        if (auto.length) {
            lines.push(auto.join(' and ') + ' ' + (auto.length > 1 ? 'are' : 'is') +
                       ' set up automatically and need nothing from you.', '');
        }
        lines.push(
            'The browsers listed above refuse every automatic install route an',
            'app has on Windows. Chrome ignores --load-extension outright, and',
            'Chrome and Brave both drop a self-hosted force-install entry during',
            'policy validation: Google requires the machine to be joined to a',
            'domain, joined to Azure AD, or enrolled in Chrome Browser Cloud',
            'Management before an off-store extension can be forced. That is why',
            'every commercial VPN ships its browser extension through the Chrome',
            'Web Store, and why this one step is left to you.',
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
        try {
            fs.mkdirSync(this.baseDir, { recursive: true });
            fs.writeFileSync(path.join(this.baseDir, 'HOW-TO-ENABLE.txt'), lines.join('\r\n'), 'utf8');
        } catch (e) { /* the toast and the log still carry it */ }
    }
}

module.exports = { GeoExt, POLICY_KEYS, FORCELIST, FORCE_INSTALLABLE, regValues };
