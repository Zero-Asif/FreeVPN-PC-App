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
//       the page's first question
//    2. chrome.storage.onChanged -- carries live changes to pages that are
//       already open
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
    var pushed = false;

    function push(cfg) {
        pushed = true;
        try {
            document.dispatchEvent(new CustomEvent(CHANNEL, {
                detail: JSON.stringify(cfg || { active: false }),
            }));
        } catch (e) { /* page navigated away */ }
    }

    //  Only if a live update has not already overtaken us.
    function first(cfg) { if (!pushed) push(cfg); }

    function normalise(rec) {
        //  `pending` has to survive the trip. It is the difference between
        //  "the app says it is not connected" -- use the real provider -- and
        //  "we do not know yet" -- wait. Collapsing both to {active:false} is
        //  what let the device's real position through on the first
        //  geolocation call after a browser start.
        if (!rec || !rec.active) return { active: false, pending: !!(rec && rec.pending) };
        if (typeof rec.lat !== 'number' || typeof rec.lng !== 'number') return { active: false };
        return {
            active: true,
            lat: rec.lat,
            lng: rec.lng,
            accuracy: typeof rec.accuracy === 'number' ? rec.accuracy : 18,
            cc: rec.cc || '',
            city: rec.city || '',
        };
    }

    //  Storage, used only if the worker cannot be reached at all.
    function fromStorage() {
        try {
            chrome.storage.local.get('geoSpoof', function (r) {
                first(normalise(r && r.geoSpoof));
            });
        } catch (e) { first({ active: false }); }
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
    function ask(retriesLeft) {
        try {
            chrome.runtime.sendMessage({ type: 'GET_GEO' }, function (resp) {
                if (pushed) return;
                if (chrome.runtime.lastError || !resp) {
                    if (retriesLeft > 0) setTimeout(function () { ask(retriesLeft - 1); }, 250);
                    else fromStorage();
                    return;
                }
                first(normalise(resp.geoSpoof));
            });
        } catch (e) {
            if (retriesLeft > 0) setTimeout(function () { ask(retriesLeft - 1); }, 250);
            else fromStorage();
        }
    }
    ask(1);

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
