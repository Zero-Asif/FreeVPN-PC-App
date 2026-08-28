'use strict';
// ════════════════════════════════════════════════════════════════════
//  lib/home-location.js  --  where the user actually is, or nothing.
//
//  WHY THIS EXISTS
//  ---------------
//  The globe draws a "you are here" ring and captions "Standing by in
//  <city>". That ring is the one thing on the screen that is about the user
//  rather than about the tunnel, and it cannot be derived: an app learns its
//  own public position only by asking somebody.
//
//  It used to ask exactly one host, from the renderer:
//
//      fetch('https://freeipapi.com/api/json')
//
//  freeipapi now answers that path with a 302 to free.freeipapi.com. A
//  renderer fetch follows redirects happily, but index.html's
//  Content-Security-Policy is re-applied to the redirect TARGET, and a
//  connect-src naming freeipapi.com does not cover its subdomain. So one
//  provider's routing change blinded the globe on every machine at once,
//  and the only reason it was noticeable is that this app no longer invents
//  a city when the lookup fails.
//
//  Two things follow. The lookup left the renderer altogether -- no host
//  needs to appear in the page's connect-src at all now, which is a
//  strictly smaller hole in a document that runs with nodeIntegration. And
//  it asks four independent services in turn rather than one, so the next
//  API to move its path costs nothing. All four were verified by hand
//  against a live network on 2026-08-27; each answers a different shape,
//  so each carries its own reader.
//
//  ipapi.co is deliberately NOT in the list: it answers a browser-style
//  Cloudflare interstitial ("Just a moment...") to a plain client, so it
//  would contribute a guaranteed failure and a wasted timeout.
//
//  WHAT IT REFUSES TO DO
//  ---------------------
//  Guess. A provider that answers without usable coordinates, or answers
//  0,0 -- which is how several of them spell "I could not place this
//  address" -- counts as a provider that did not answer. If none of them
//  answer this returns null, and the globe says so in amber rather than
//  drawing a ring somewhere the user is not.
// ════════════════════════════════════════════════════════════════════
const { directGet } = require('./socks-fetch');
const { URL } = require('url');

//  get.geojs.io sends latitude/longitude as JSON strings; the other three
//  send numbers. Both go through here so a reader never has to care.
const num = v => {
    const n = typeof v === 'string' ? parseFloat(v) : v;
    return Number.isFinite(n) ? n : NaN;
};
const str = v => (typeof v === 'string' && v.trim()) ? v.trim() : '';

const PROVIDERS = [
    //  freeipapi's own answering host, so the 302 that broke the original
    //  call is never taken in the first place.
    { url: 'https://free.freeipapi.com/api/json', read: d => ({
        lat: num(d.latitude), lng: num(d.longitude), city: str(d.cityName),
        country: str(d.countryName), cc: str(d.countryCode) }) },

    //  ipwho.is reports failure in the body with success:false and HTTP 200.
    { url: 'https://ipwho.is/', read: d => d.success === false ? null : ({
        lat: num(d.latitude), lng: num(d.longitude), city: str(d.city),
        country: str(d.country), cc: str(d.country_code) }) },

    { url: 'https://get.geojs.io/v1/ip/geo.json', read: d => ({
        lat: num(d.latitude), lng: num(d.longitude), city: str(d.city),
        country: str(d.country), cc: str(d.country_code) }) },

    { url: 'https://api.ipbase.com/v1/json/', read: d => ({
        lat: num(d.latitude), lng: num(d.longitude), city: str(d.city),
        country: str(d.country_name), cc: str(d.country_code) }) },
];

//  A reading is usable only if it puts the user somewhere that exists.
function validate(r) {
    if (!r) return null;
    const lat = num(r.lat), lng = num(r.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
    //  0,0 is open water in the Gulf of Guinea. No provider means it as a
    //  position -- it is the placeholder they emit for an address they cannot
    //  locate -- and a ring drawn there is still a claim about the user.
    if (Math.abs(lat) < 1e-6 && Math.abs(lng) < 1e-6) return null;
    if (!/^[A-Za-z]{2}$/.test(r.cc)) return null;
    return { lat, lng, city: r.city, country: r.country, cc: r.cc.toUpperCase() };
}

async function getJson(url, timeoutMs) {
    let target = url;
    for (let hop = 0; hop < 3; hop++) {
        const res = await directGet(target, { timeoutMs, maxBytes: 64 * 1024 });
        if (res.status >= 300 && res.status < 400 && res.headers.location) {
            //  One of these APIs has already moved its path behind a 302 once.
            //  Following it here -- https only, so a redirect can never
            //  downgrade the lookup to cleartext -- means the next one to do it
            //  does not blind the globe either.
            const next = new URL(res.headers.location, target);
            if (next.protocol !== 'https:') throw new Error('redirect left https');
            target = next.href;
            continue;
        }
        if (res.status !== 200) throw new Error('HTTP ' + res.status);
        return JSON.parse(res.body);
    }
    throw new Error('too many redirects');
}

//  Resolves to { lat, lng, city, country, cc, source } or null. Never throws:
//  every provider failure is a reason recorded in the log, not an exception
//  for the caller to have to remember to catch.
async function lookupHomeLocation(opts = {}) {
    const { timeoutMs = 6000, log = () => {} } = opts;
    const tried = [];
    for (const p of PROVIDERS) {
        const host = new URL(p.url).hostname;
        try {
            const got = validate(p.read(await getJson(p.url, timeoutMs)));
            if (got) {
                log(`home location from ${host}: ${got.city || '?'}, ${got.country || '?'} ` +
                    `(${got.lat.toFixed(4)}, ${got.lng.toFixed(4)})`);
                return { ...got, source: host };
            }
            tried.push(host + ': answered without a usable position');
        } catch (e) {
            tried.push(host + ': ' + (e && e.message || e));
        }
    }
    log('home location unavailable -- ' + tried.join('; '));
    return null;
}

//  Every host this module may contact, so the outbound-call allow-list in
//  .build/test-vendor.js is generated from the code rather than kept in step
//  with it by hand.
const HOSTS = PROVIDERS.map(p => new URL(p.url).hostname);

module.exports = { lookupHomeLocation, validate, HOSTS, PROVIDERS };
