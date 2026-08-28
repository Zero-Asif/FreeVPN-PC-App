'use strict';
// ════════════════════════════════════════════════════════════════════
//  Cross-check the three country lists that must agree, by pulling two
//  of them straight out of the shipped main.js so this cannot drift:
//
//    A. GEO_COORDS        -- countries the app can spoof a location for
//    B. the fallback list -- countries the UI offers when Onionoo is down
//    C. live Onionoo      -- countries that actually have exit capacity
//
//  A country in C but not A connects and then leaves the real location
//  showing -- the Dhaka leak from the report.
//  A country in B but not C can never build a circuit under StrictNodes 1.
// ════════════════════════════════════════════════════════════════════
const path = require('path');
const { directGet } = require('../lib/socks-fetch');
const { RelayIndex } = require('../lib/exit-selector');

//  Both tables are lifted out of the shipped main.js by one shared helper, so
//  this file cannot hold a stale copy of either. It used to slice them out with
//  its own end markers, and the fallback one broke the moment main.js stopped
//  writing `return spoofableOnly({...})` and named the list first: the slice ran
//  past the literal into the comment below it and the whole test died with
//  "SyntaxError: Unexpected identifier 'extension'" before a single check ran.
const { geoFromMainJs, fallbackFromMainJs } = require('./geo-from-main.js');

const geo      = geoFromMainJs(path.join(__dirname, '..'));
const fallback = fallbackFromMainJs(path.join(__dirname, '..'));

const log = { debug: () => {}, info: () => {}, warn: () => {} };

(async () => {
    const idx = new RelayIndex(log);
    await idx.refresh(u => directGet(u, { timeoutMs: 45000, maxBytes: 12 * 1024 * 1024 }));
    const live = idx.countryStats();

    const G = new Set(Object.keys(geo));
    const B = new Set(Object.keys(fallback));
    const L = new Set(Object.keys(live));

    console.log('GEO_COORDS      : ' + G.size + ' countries');
    console.log('fallback list   : ' + B.size + ' countries');
    console.log('live exit stats : ' + L.size + ' countries\n');

    let bad = 0;

    // ── C \ A : has exits, cannot be spoofed ────────────────────────
    const noCoord = [...L].filter(cc => !G.has(cc))
        .sort((a, b) => live[b].count - live[a].count);
    if (noCoord.length) {
        bad++;
        console.log('FAIL  ' + noCoord.length + ' country/ies have exits but NO coordinates');
        //  Not a leak: spoofableOnly() drops these before the picker ever sees
        //  them, which is why they cannot be connected to at all. That is the
        //  cost -- live exit capacity the app refuses to offer -- and the fix is
        //  to add the coordinates, not to loosen the filter.
        console.log('      -> hidden from the picker, so this capacity goes unused:');
        noCoord.forEach(cc => console.log('        ' + cc + '  (' + live[cc].count + ' exits)'));
    } else {
        console.log('PASS  every country with exit capacity has spoofable coordinates');
    }

    // ── B \ C : offered, cannot ever work ───────────────────────────
    const dead = [...B].filter(cc => !L.has(cc));
    if (dead.length) {
        bad++;
        console.log('\nFAIL  fallback list offers ' + dead.length + ' country/ies with ZERO exits: ' +
            dead.join(', '));
        console.log('      -> StrictNodes 1 means these can never build a circuit');
    } else {
        console.log('PASS  every country in the fallback list has live exit capacity');
    }

    // ── B \ A : offered, cannot be spoofed ──────────────────────────
    const fbNoCoord = [...B].filter(cc => !G.has(cc));
    if (fbNoCoord.length) {
        bad++;
        console.log('\nFAIL  fallback list offers countries with no coordinates: ' + fbNoCoord.join(', '));
    } else {
        console.log('PASS  every country in the fallback list has coordinates');
    }

    // ── thin countries: alive, but one relay deep ───────────────────
    const thin = [...L].filter(cc => live[cc].count <= 2)
        .sort((a, b) => live[a].count - live[b].count);
    console.log('\nNOTE  ' + thin.length + ' live countries are 1-2 exits deep (fragile, not broken):');
    console.log('      ' + thin.map(cc => cc + ':' + live[cc].count).join('  '));

    const noV4 = [...L].filter(cc => live[cc].ipv4Only === 0)
        .sort((a, b) => live[b].count - live[a].count);
    console.log('\nNOTE  ' + noV4.length + ' live countries have NO IPv4-only exit (every relay there');
    console.log('      also has an IPv6 address, so NoIPv6Traffic is doing the work alone):');
    console.log('      ' + noV4.map(cc => cc + ':' + live[cc].count).join('  '));

    console.log('\n' + (bad ? bad + ' cross-check(s) FAILED' : 'all cross-checks passed'));
    process.exit(bad ? 1 : 0);
})();
