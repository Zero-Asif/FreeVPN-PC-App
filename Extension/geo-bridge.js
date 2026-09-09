// ════════════════════════════════════════════════════════════════════
//  geo-bridge.js  --  isolated world
//
//  The only job here is to carry the connected country's coordinates from
//  background.js (which keeps them in step with the desktop app over the
//  WebSocket) across into the page's own JavaScript world, where geo-spoof.js
//  is waiting for them.
//
//  Extension APIs are not reachable from a MAIN-world content script, and
//  a MAIN-world script is the only place where patching navigator.geolocation
//  is visible to the page -- hence the split into two files.
//
//  Two sources, in this order of authority:
//    1. a GET_GEO message to the service worker -- race-free, so it answers
//       the page's first question, and it starts the worker if Chromium has
//       evicted it
//    2. chrome.storage.onChanged -- carries live changes to pages that are
//       already open
//
//  geo-spoof.js can also demand a re-ask (the ASK event) when the decision it
//  is holding is too old to act on. That is the only wake-up available once a
//  worker has been evicted with the app down, and without it a tab keeps acting
//  on a "the app is off" that stopped being true minutes ago.
//
//  One thing travels the other way: a GEO_USED notification when the page has
//  actually been handed a spoofed position. That is what lets a later country
//  switch clear the previous country out of the sites that were told it, and
//  leave every other site untouched.
// ════════════════════════════════════════════════════════════════════
(function () {
    'use strict';

    var CHANNEL = '__freeproxy_geo__';
    var USED = '__freeproxy_geo_used__';
    var ASK = '__freeproxy_geo_ask__';
    var pushed = false;

    function push(cfg) {
        pushed = true;
        try {
            document.dispatchEvent(new CustomEvent(CHANNEL, {
                detail: JSON.stringify(cfg || { active: false, pending: true }),
            }));
        } catch (e) { /* page navigated away */ }
    }

    //  Only if a live update has not already overtaken us.
    function first(cfg) { if (!pushed) push(cfg); }

    function stampOf(rec) {
        //  0 rather than "now": a record with no stamp is one this side cannot
        //  vouch for the age of, and geo-spoof.js must re-ask before acting on
        //  it rather than treat it as just-written.
        return typeof rec.stamp === 'number' ? rec.stamp : 0;
    }

    function normalise(rec) {
        //  Two shapes are authoritative and nothing else is: active with real
        //  coordinates, and inactive that explicitly says the app is off.
        //  Every other value -- pending, a bare {active:false}, an active
        //  record with no coordinates, no record at all -- travels as pending,
        //  so geo-spoof.js holds the call. A missing flag must not be able to
        //  authorise Chromium's real provider, which is what put the device's
        //  own position on screen while the VPN was connected.
        if (!rec || typeof rec !== 'object') return { active: false, pending: true };
        if (!rec.active) {
            return rec.appOff === true
                ? { active: false, appOff: true, stamp: stampOf(rec) }
                : { active: false, pending: true };
        }
        if (typeof rec.lat !== 'number' || typeof rec.lng !== 'number') {
            return { active: false, pending: true };
        }
        return {
            active: true,
            lat: rec.lat,
            lng: rec.lng,
            accuracy: typeof rec.accuracy === 'number' ? rec.accuracy : 18,
            cc: rec.cc || '',
            city: rec.city || '',
            stamp: stampOf(rec),
        };
    }

    //  Storage, used only if the worker cannot be reached at all. An ACTIVE
    //  record here is still worth having -- it can only over-spoof -- but the
    //  worker being unreachable is itself the news, because it is the one state
    //  in which geo-spoof.js is allowed to fall back to the real provider.
    function fromStorage() {
        var unreachable = { active: false, unreachable: true };
        try {
            chrome.storage.local.get('geoSpoof', function (r) {
                if (chrome.runtime.lastError) { push(unreachable); return; }
                push(normalise(r && r.geoSpoof));
                push(unreachable);
            });
        } catch (e) { push(unreachable); }
    }

    //  First delivery: ASK the service worker rather than reading storage.
    //  This script runs at document_start and can beat the worker's own
    //  startup, so a storage read here is liable to return the PREVIOUS
    //  session's record -- and a leftover {active:false} would send the page
    //  to Chromium's real provider while the VPN is connected. A sendMessage
    //  starts the worker if it is asleep and cannot be answered before its
    //  module code has run, so the reply is always current. See the GET_GEO
    //  handler in background.js.
    //
    //  One retry, because the single realistic way this fails on a healthy
    //  extension is asking during the moment the worker is being torn down and
    //  restarted -- "Receiving end does not exist" -- and falling back to
    //  storage there would reintroduce exactly the stale record this avoids.
    function ask(retriesLeft, force) {
        var deliver = force ? push : first;
        try {
            chrome.runtime.sendMessage({ type: 'GET_GEO', fresh: !!force }, function (resp) {
                if (!force && pushed) return;
                if (chrome.runtime.lastError || !resp) {
                    if (retriesLeft > 0) {
                        setTimeout(function () { ask(retriesLeft - 1, force); }, 250);
                    } else fromStorage();
                    return;
                }
                deliver(normalise(resp.geoSpoof));
            });
        } catch (e) {
            if (retriesLeft > 0) setTimeout(function () { ask(retriesLeft - 1, force); }, 250);
            else fromStorage();
        }
    }
    ask(1, false);

    //  A re-ask, requested by geo-spoof.js when the decision it holds is older
    //  than it is willing to act on. This is the only thing that can wake a
    //  service worker Chromium has evicted while the app was down: the worker's
    //  own reconnect chain is an in-memory timer that died with it, so without
    //  this a tab that was told "the app is off" keeps believing it after the
    //  app has connected again -- which is how Google Maps came to show the
    //  device's real position with the VPN up. Rate-limited so a page cannot
    //  use it to churn the worker.
    var lastAsk = 0;
    document.addEventListener(ASK, function () {
        var now = Date.now();
        if (now - lastAsk < 400) return;
        lastAsk = now;
        ask(1, true);
    }, true);

    //  Later deliveries: connect, disconnect, or a country switch while the
    //  page is open. Pages that call getCurrentPosition again get the new
    //  country without needing a reload. These always win over the first
    //  delivery, hence the `pushed` guard rather than an ordering assumption.
    try {
        chrome.storage.onChanged.addListener(function (changes, area) {
            if (area !== 'local' || !changes.geoSpoof) return;
            push(normalise(changes.geoSpoof.newValue));
        });
    } catch (e) { /* no storage access; the GET_GEO reply is the only source */ }

    //  The other direction, and the only thing that ever travels it: "the page
    //  in this frame was actually handed a spoofed position". geo-spoof.js
    //  dispatches it once per page from makePosition(); the worker keeps the
    //  origin so that a later country switch can clear the OLD country out of
    //  the sites that were told it -- and only those. The message is a
    //  notification, not a request, so nothing waits for a reply; reading
    //  lastError just stops "no receiving end" appearing in the console when
    //  the worker is being restarted at that instant.
    document.addEventListener(USED, function () {
        try {
            chrome.runtime.sendMessage({ type: 'GEO_USED' }, function () {
                void chrome.runtime.lastError;
            });
        } catch (e) { /* worker gone; the next page reports it again */ }
    }, true);
})();
