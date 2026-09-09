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
//  THREE STATES, NOT TWO -- AND EACH ONE HAS TO BE FRESH
//  ------------------------------------------------------
//  active   -- spoof: report the connected country.
//  off      -- the app has CONFIRMED it is not connected (record carries
//              appOff:true): hand the page to the real provider, because
//              refusing would be a lie.
//  pending  -- not known yet, e.g. the service worker has just started and its
//              WebSocket has not answered. HOLD the call.
//
//  Anything that is not one of those three -- a bare {active:false}, a record
//  with no coordinates, no record at all -- is PENDING, never "off". A missing
//  flag must not be able to authorise the real provider.
//
//  Freshness is the other half, and it is the leak that was reported: an
//  already-open tab received a correct "off" at a disconnect, its service
//  worker was then evicted by Chromium (nothing wakes it -- the reconnect chain
//  is an in-memory timer), the app connected again minutes later, and no
//  storage change ever reached the page. The tab was still holding "off", so
//  the next geolocation call went to Chromium's real provider and Google Maps
//  showed the device's true position while the traffic was exiting in the
//  Netherlands. Every record therefore carries the `stamp` the worker wrote it
//  at, and a decision older than FRESH_MS is re-asked through geo-bridge.js
//  before it is acted on -- which also wakes the worker that was supposed to be
//  keeping it current.
//
//  There is still no "give up and use the real provider" timeout for a PENDING
//  record, and a decision that has gone stale is treated the same way: a stall
//  must never hand out the real position. The one exception is an extension
//  whose service worker cannot be reached at all (disabled, being updated,
//  uninstalled) -- geo-bridge.js says so explicitly with unreachable:true, and
//  only then does the ceiling delegate, because in that state the browser is not
//  being proxied by us either and a permanently dead navigator.geolocation would
//  be a bug of our own making.
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

    //  The reverse direction of CHANNEL, and it carries no data -- only the
    //  fact that THIS page was handed a spoofed position at least once.
    //  geo-bridge.js relays it to the service worker, which needs the list for
    //  exactly one purpose: when the country changes, the sites that were told
    //  the OLD one are the sites now holding a stale copy of it, and they are
    //  the only ones whose stored state may be cleared. Sites that never asked
    //  are left completely alone. See purgeLocationTraces() in background.js.
    var USED = '__freeproxy_geo_used__';
    //  shim -> geo-bridge.js: "ask the worker again". Waking the worker is the
    //  point: a decision can only go stale while it is dead.
    var ASK = '__freeproxy_geo_ask__';
    var reported = false;
    function reportUse() {
        if (reported) return;         // once per page is all the worker needs
        reported = true;
        try { document.dispatchEvent(new CustomEvent(USED)); } catch (e) {}
    }

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

    //  How long a decision may be acted on before it is re-checked, and how
    //  long a re-check is waited for. FRESH_MS is generous because the worker
    //  re-stamps its answer whenever its link to the app is live, so a page
    //  polling a live connection re-asks at most once per interval, and each
    //  ask is a message to an already-running worker.
    var FRESH_MS     = 15000;
    var RECHECK_MS   = 1500;

    // ── config ──────────────────────────────────────────────────────
    //  `current` is re-read on every call rather than captured once, so a
    //  country switch while a page is open takes effect on that page's next
    //  getCurrentPosition(). `haveConfig` records whether an authoritative
    //  value ever arrived -- absent one, we must not touch the real provider.
    var current = { active: false };
    var haveConfig = false;
    //  Set only when geo-bridge.js reports that the service worker itself could
    //  not be reached. It is not an answer about the app, so it never becomes
    //  `current`; it is the one condition that lets the ceiling delegate.
    var unreachable = false;
    var resolveCfg;
    var cfgReady = new Promise(function (res) { resolveCfg = res; });
    var waiters = [];

    function settle() {
        var list = waiters;
        waiters = [];
        list.forEach(function (fn) { try { fn(); } catch (e) {} });
    }

    function stampOf(rec) {
        return rec && typeof rec.stamp === 'number' ? rec.stamp : 0;
    }

    function accept(cfg) {
        if (!cfg || typeof cfg !== 'object') return;
        if (cfg.unreachable) { unreachable = true; settle(); return; }
        //  Only the two authoritative shapes are recorded: active with real
        //  coordinates, or inactive that explicitly says the app is off.
        //  Everything else -- pending, a bare {active:false}, an active record
        //  with no coordinates -- leaves the last good value in place and keeps
        //  calls held. That is also what stops a service worker restarting
        //  mid-session from disturbing pages that are already open.
        if (cfg.active) {
            if (typeof cfg.lat !== 'number' || typeof cfg.lng !== 'number') return;
        } else if (cfg.appOff !== true) {
            return;
        }
        //  An older record must never replace a newer one. geo-bridge.js pushes
        //  its storage fallback and its forced re-ask unconditionally, so a reply
        //  in flight can land behind a live change and put the previous country
        //  back. The waiters are still released: what we hold is a fresher
        //  answer, not a missing one.
        if (haveConfig && stampOf(cfg) < stampOf(current)) { settle(); return; }
        current = cfg;
        haveConfig = true;
        resolveCfg();
        settle();
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
    function armed() { return haveConfig && current && current.active === true; }

    /** True when the app has explicitly confirmed that it is not connected. */
    function passthrough() {
        return haveConfig && current && current.active !== true && current.appOff === true;
    }

    /** True when the decision is recent enough to act on without re-asking. */
    function fresh() {
        return haveConfig && typeof current.stamp === 'number' &&
               (Date.now() - current.stamp) < FRESH_MS;
    }

    //  Ask geo-bridge.js to put the question to the service worker again, which
    //  starts it if Chromium has evicted it. Either an answer arrives -- always
    //  through accept() -- or RECHECK_MS passes with the old record still in
    //  hand. A stale ACTIVE record is then acted on, because over-spoofing is
    //  harmless; a stale OFF is not, because that is the leak, and the caller is
    //  told which it has (see decided()).
    var lastAsk = 0;
    function askAgain() {
        var now = Date.now();
        if (now - lastAsk <= 250) return;
        lastAsk = now;
        try { document.dispatchEvent(new CustomEvent(ASK)); } catch (e) {}
    }
    function recheck(fn) {
        var done = false;
        var finish = function () { if (done) return; done = true; fn(); };
        waiters.push(finish);
        askAgain();
        setTimeout(finish, RECHECK_MS);
    }

    /** Run fn() once the decision is either fresh or has just been re-asked. */
    function decided(fn) {
        cfgReady.then(function () {
            if (fresh() || unreachable) { fn(true); return; }
            //  fn is told whether the decision can be VOUCHED FOR at the moment
            //  it runs. A re-ask that goes unanswered leaves the old record in
            //  place, and a stale "the app is off" must not be allowed to
            //  authorise Chromium's own provider -- that is the leak. Acting on
            //  a stale ACTIVE record only over-spoofs, so nothing is gated on
            //  it.
            recheck(function () { fn(fresh() || unreachable); });
        });
    }

    // ── position objects ────────────────────────────────────────────
    //  A little jitter per call: a position that is bit-identical every
    //  time is itself a fingerprint, and real GPS never repeats exactly.
    function jitter(span) { return (Math.random() - 0.5) * span; }

    function makePosition(cfg) {
        //  Every spoofed position this file ever hands out is built here, which
        //  makes it the one honest place to record that this origin consumed
        //  one -- no call site can be added later that forgets to.
        reportUse();
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
        //  Already seeded, and recently enough to trust? Answer in this turn
        //  rather than a microtask later, so we are indistinguishable from a
        //  fast device.
        if (armed() && fresh()) {
            if (success) { try { success(makePosition(current)); } catch (e) {} }
            return;
        }
        decided(function (trusted) {
            if (armed()) {
                if (success) { try { success(makePosition(current)); } catch (e) {} }
            } else if (unreachable || (trusted && passthrough())) {
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

        var start = function (trusted) {
            if (!watches.has(ourId)) return;          // cleared before we got here

            if (armed()) {
                var emit = function () {
                    if (!watches.has(ourId) || !success) return;
                    //  Re-read `current`: if the user switches country mid-watch,
                    //  the next update reports the new one. If they disconnect,
                    //  the watch simply stops reporting rather than switching to
                    //  the real position behind the page's back.
                    if (!armed()) return;
                    //  A watch outlives the record it started on. Once that
                    //  record is too old to vouch for, the worker is asked again
                    //  -- an evicted one is started by the ask, which is how a
                    //  switch or a disconnect reaches a long-lived watch at all.
                    //  The update still goes out: a stale ACTIVE record only
                    //  over-spoofs, and holding it back would stall the page.
                    if (!fresh()) askAgain();
                    try { success(makePosition(current)); } catch (e) {}
                };
                emit();
                //  A stationary device does not need frequent updates; this is
                //  just enough to satisfy code that waits for a second reading.
                rec.timer = setInterval(emit, 8000);
                return;
            }
            if (unreachable || (trusted && passthrough())) {
                try { rec.realId = realWatch.call(self, success, error, options); }
                catch (e) { if (error) { try { error(unavailable()); } catch (e2) {} } }
                return;
            }
            if (error) { try { error(unavailable()); } catch (e) {} }
        };

        decided(start);
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
