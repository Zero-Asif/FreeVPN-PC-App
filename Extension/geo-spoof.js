// ════════════════════════════════════════════════════════════════════
//  geo-spoof.js  --  runs in the PAGE's own JavaScript world
//
//  WHY THIS FILE EXISTS
//  --------------------
//  Chromium's network location provider does NOT ask "where is this IP?".
//  It scans the surrounding Wi-Fi with WlanGetNetworkBssList and POSTs the
//  BSSIDs to www.googleapis.com/geolocation/v1/geolocate; Google resolves
//  the position from those BSSIDs, which is why Chrome and Brave reported a
//  Dhaka position while the traffic was exiting in Luxembourg. Routing that
//  request through Tor changes nothing, because the evidence Google acts on
//  travels inside the request body.
//
//  Blocking the API instead is not a fix either. That is what the app used
//  to do, and it produced "User denied the request for Geolocation" plus a
//  greyed-out Location control in site settings that the user could not turn
//  back on. Denial is visible, breaks Google Maps, and takes the user's own
//  setting away from them.
//
//  Replacing navigator.geolocation is the only honest way to report the
//  connected country's coordinates. It has to happen in the MAIN world: an
//  isolated-world content script has its own copy of `navigator`, and
//  patching it there is invisible to the page.
//
//  HOW THE COORDINATES GET HERE
//  ----------------------------
//  One channel, and only one:
//
//      desktop app  --WebSocket-->  background.js
//                   --chrome.storage.local-->  geo-bridge.js (isolated world)
//                   --CustomEvent-->  this file (MAIN world)  -->  the page
//
//  Deliberately not a coordinate file baked into the extension at package
//  time. A baked-in value cannot follow a country switch, so it would have to
//  be repackaged on every connect, and any copy left behind would report a
//  country the exit IP no longer backs up. Coming down the live link instead
//  means a switch or a disconnect reaches pages that are ALREADY OPEN, and
//  there is only ever one source of truth.
//
//  (.build/probe.js does inject a synchronous __FP_GEO_SEED for its own
//  measurements. That is test-harness scaffolding and is not shipped; the
//  read below is what consumes it, and it is a no-op in production.)
//
//  THREE STATES, NOT TWO
//  ---------------------
//  active   -- spoof: report the connected country.
//  inactive -- the app has confirmed it is not connected: hand the page to
//              the real provider, because refusing would be a lie.
//  pending  -- not known yet, e.g. the service worker has just started and
//              its WebSocket has not answered. HOLD the call. Treating this
//              as "inactive" is what leaked the device's real position on the
//              first geolocation call of a browser session.
//
//  There is deliberately no "give up and use the real provider" timeout. An
//  earlier version had one, and a two-second stall was all it took to hand
//  the page the device's true position -- the exact leak this file exists to
//  prevent. The only path to the real provider is an explicit inactive, which
//  is what the app sends when it is not connected.
// ════════════════════════════════════════════════════════════════════
(function () {
    'use strict';

    if (window.__fpGeoPatched) return;
    try {
        Object.defineProperty(window, '__fpGeoPatched', {
            value: true, enumerable: false, writable: false, configurable: false,
        });
    } catch (e) { /* sealed window; continue anyway */ }

    var CHANNEL = '__freeproxy_geo__';

    //  Ceiling on how long a call may be held waiting for an answer that never
    //  comes -- a service worker that cannot start, or something occupying the
    //  app's port without speaking its protocol. Normally nothing waits
    //  anywhere near this long: background.js writes a real record as soon as
    //  its WebSocket resolves, and on loopback that is milliseconds whether the
    //  app is there or not. When the ceiling is reached the page is told
    //  POSITION_UNAVAILABLE rather than being handed the real provider,
    //  because at that point we still do not know if a spoof is meant to be in
    //  force.
    var BRIDGE_WAIT_MS = 4000;

    // ── config ──────────────────────────────────────────────────────
    //  `current` is re-read on every call rather than captured once, so a
    //  country switch while a page is open takes effect on that page's next
    //  getCurrentPosition(). `haveConfig` records whether an authoritative
    //  value ever arrived -- absent one, we must not touch the real provider.
    var current = { active: false };
    var haveConfig = false;
    var resolveCfg;
    var cfgReady = new Promise(function (res) { resolveCfg = res; });

    function accept(cfg) {
        if (!cfg || typeof cfg !== 'object') return;
        //  "Not known yet" is not an answer, so it is not recorded. Leaving
        //  haveConfig false is what makes a call HOLD instead of falling
        //  through to the real provider, and ignoring the record outright also
        //  leaves the last good value in place for pages already open -- a
        //  service worker restarting mid-session must not disturb them.
        if (cfg.pending && !cfg.active) return;
        if (cfg.active && (typeof cfg.lat !== 'number' || typeof cfg.lng !== 'number')) return;
        current = cfg;
        haveConfig = true;
        resolveCfg();
    }

    //  The seed, read synchronously. Removed from the page immediately: it
    //  runs before any page script, so nothing can have observed it, and
    //  leaving a global named after the app behind would be a fingerprint.
    try {
        accept(window.__FP_GEO_SEED);
    } catch (e) { /* ignore */ }
    try { delete window.__FP_GEO_SEED; } catch (e) { /* ignore */ }

    document.addEventListener(CHANNEL, function (e) {
        try { accept(JSON.parse(e.detail)); } catch (err) { /* keep the last good value */ }
    }, true);

    if (!haveConfig) setTimeout(resolveCfg, BRIDGE_WAIT_MS);

    var geo = navigator.geolocation;
    if (!geo) return;

    //  Patch the PROTOTYPE, not the instance: a page that reaches for
    //  Geolocation.prototype.getCurrentPosition directly would otherwise
    //  walk straight past an instance-level override.
    var Proto = Object.getPrototypeOf(geo);
    var realGet   = Proto.getCurrentPosition;
    var realWatch = Proto.watchPosition;
    var realClear = Proto.clearWatch;
    if (typeof realGet !== 'function') return;

    /** True when we hold coordinates to report. */
    function armed() { return haveConfig && current && current.active; }

    /** True when the app has explicitly told us it is not connected. */
    function passthrough() { return haveConfig && (!current || !current.active); }

    // ── position objects ────────────────────────────────────────────
    //  A little jitter per call: a position that is bit-identical every
    //  time is itself a fingerprint, and real GPS never repeats exactly.
    function jitter(span) { return (Math.random() - 0.5) * span; }

    function makePosition(cfg) {
        var acc = typeof cfg.accuracy === 'number' ? cfg.accuracy : 18;
        var coords = {
            latitude:         cfg.lat + jitter(0.0008),
            longitude:        cfg.lng + jitter(0.0008),
            accuracy:         acc + Math.abs(jitter(4)),
            altitude:         null,
            altitudeAccuracy: null,
            heading:          null,
            speed:            null,
        };
        //  Match the real API surface: GeolocationCoordinates exposes its
        //  values as read-only accessors, and some libraries copy via
        //  Object.keys / JSON.stringify, so both must work.
        return {
            coords: coords,
            timestamp: Date.now(),
            toJSON: function () { return { coords: coords, timestamp: Date.now() }; },
        };
    }

    function unavailable() {
        //  POSITION_UNAVAILABLE, not PERMISSION_DENIED. We genuinely do not
        //  have a position to give, and saying so is truthful; claiming the
        //  user refused would be a lie about the user, and it is what made
        //  sites report "User denied the request for Geolocation" before.
        return {
            code: 2, PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3,
            message: 'Position unavailable',
        };
    }

    // ── getCurrentPosition ──────────────────────────────────────────
    Proto.getCurrentPosition = function (success, error, options) {
        var self = this;
        //  Already seeded? Answer in this turn rather than a microtask later,
        //  so we are indistinguishable from a fast device.
        if (armed()) {
            if (success) { try { success(makePosition(current)); } catch (e) {} }
            return;
        }
        cfgReady.then(function () {
            if (armed()) {
                if (success) { try { success(makePosition(current)); } catch (e) {} }
            } else if (passthrough()) {
                try { realGet.call(self, success, error, options); }
                catch (e) { if (error) { try { error(unavailable()); } catch (e2) {} } }
            } else if (error) {
                try { error(unavailable()); } catch (e) {}
            }
        });
    };

    // ── watchPosition / clearWatch ──────────────────────────────────
    //  watchPosition has to return an id SYNCHRONOUSLY, before the config may
    //  have arrived, so ids are handed out from our own sequence and mapped
    //  to the real one if the call ends up being delegated.
    var seq = 100000;
    var watches = new Map();

    Proto.watchPosition = function (success, error, options) {
        var self = this;
        var ourId = ++seq;
        var rec = {};
        watches.set(ourId, rec);

        var start = function () {
            if (!watches.has(ourId)) return;          // cleared before we got here

            if (passthrough()) {
                try { rec.realId = realWatch.call(self, success, error, options); }
                catch (e) { if (error) { try { error(unavailable()); } catch (e2) {} } }
                return;
            }
            if (!armed()) {
                if (error) { try { error(unavailable()); } catch (e) {} }
                return;
            }
            var emit = function () {
                if (!watches.has(ourId) || !success) return;
                //  Re-read `current`: if the user switches country mid-watch,
                //  the next update reports the new one. If they disconnect,
                //  the watch simply stops reporting rather than switching to
                //  the real position behind the page's back.
                if (!armed()) return;
                try { success(makePosition(current)); } catch (e) {}
            };
            emit();
            //  A stationary device does not need frequent updates; this is
            //  just enough to satisfy code that waits for a second reading.
            rec.timer = setInterval(emit, 8000);
        };

        if (haveConfig) start(); else cfgReady.then(start);
        return ourId;
    };

    Proto.clearWatch = function (id) {
        var rec = watches.get(id);
        if (!rec) {
            try { realClear.call(this, id); } catch (e) {}
            return;
        }
        watches.delete(id);
        if (rec.timer) clearInterval(rec.timer);
        if (rec.realId != null) { try { realClear.call(this, rec.realId); } catch (e) {} }
    };

    // ── navigator.permissions.query ─────────────────────────────────
    //  Plenty of sites check the permission first and never call
    //  getCurrentPosition if it does not read "granted". While we are
    //  answering with spoofed coordinates the effective state IS granted, so
    //  say so; when we are not spoofing, hand the real answer straight back.
    try {
        var perms = navigator.permissions;
        if (perms && typeof perms.query === 'function') {
            var realQuery = perms.query;
            Object.getPrototypeOf(perms).query = function (desc) {
                var self = this;
                if (desc && desc.name === 'geolocation') {
                    if (armed()) return Promise.resolve(grantedStatus());
                    return cfgReady.then(function () {
                        if (armed()) return grantedStatus();
                        return realQuery.call(self, desc);
                    });
                }
                return realQuery.call(self, desc);
            };
        }
    } catch (e) { /* not fatal */ }

    function grantedStatus() {
        return {
            name: 'geolocation', state: 'granted', status: 'granted',
            onchange: null,
            addEventListener: function () {},
            removeEventListener: function () {},
            dispatchEvent: function () { return false; },
        };
    }

    // ── keep the patched functions looking native ───────────────────
    //  Object.keys / console inspection of navigator.geolocation should not
    //  read like an obvious injection.
    try {
        var pairs = [
            [Proto.getCurrentPosition, 'getCurrentPosition'],
            [Proto.watchPosition,      'watchPosition'],
            [Proto.clearWatch,         'clearWatch'],
        ];
        pairs.forEach(function (pair) {
            //  forEach, not a for-loop: `var nm` would be function-scoped and
            //  all three toString() results would report the last name.
            var fn = pair[0], nm = pair[1];
            Object.defineProperty(fn, 'name', { value: nm, configurable: true });
            Object.defineProperty(fn, 'toString', {
                value: function () { return 'function ' + nm + '() { [native code] }'; },
                writable: true, configurable: true,
            });
        });
    } catch (e) { /* cosmetic only */ }
})();
