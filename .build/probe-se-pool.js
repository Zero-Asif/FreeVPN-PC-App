'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/probe-se-pool.js  --  how many exits does the app actually have for a
//  country, and where do the rest go?
//
//  THE REPORT. "jekhane sweden er exit node 300+ sekhane ekta nodeo naki app
//  connect korte parchena?" -- and .build/test-live.js se said "candidates found
//  5 for SE". Five is not 300. Either onionoo does not agree that Sweden has 300+
//  exits, or the app is throwing most of them away. This counts, per stage, and
//  prints the survivors so the answer is a number and not an opinion.
//
//  Reads only. Nothing is started, nothing is written, no registry, no browser.
//
//    node .build/probe-se-pool.js [cc ...]      default: se
// ════════════════════════════════════════════════════════════════════
const path = require('path');
const os = require('os');
const { directGet } = require('../lib/socks-fetch');
const { ExitStore, RelayIndex, ONIONOO_URL } = require('../lib/exit-selector');

const CCS = (process.argv.slice(2).length ? process.argv.slice(2) : ['se'])
    .map(s => s.toLowerCase());

const log = { debug: () => {}, info: m => console.log('  ' + m), warn: m => console.log('  WARN ' + m) };

(async () => {
    //  The unfiltered answer first: the SAME url the app uses, counted raw, so
    //  "the app drops them" and "onionoo never listed them" cannot be confused.
    const res = await directGet(ONIONOO_URL, { timeout: 45000 });
    if (!res || res.status !== 200) {
        console.log('ABORT: onionoo HTTP ' + (res ? res.status : 'no response'));
        process.exit(3);
    }
    const relays = JSON.parse(res.body).relays || [];
    console.log(`onionoo: ${relays.length} running exit relays, network-wide`);
    console.log(`          url = ${ONIONOO_URL}\n`);

    const store = new ExitStore(path.join(os.tmpdir(), 'fp-se-pool-' + process.pid + '.json'), log);
    const idx = new RelayIndex(log);
    await idx.refresh(directGet);

    for (const cc of CCS) {
        const raw = relays.filter(r => String(r.country || '').toLowerCase() === cc);
        const stage = {
            'onionoo says this country': raw.length,
            'has a v4 ORPort': raw.filter(r => (r.or_addresses || []).some(a => !a.startsWith('['))).length,
            'not BadExit': raw.filter(r => (r.or_addresses || []).some(a => !a.startsWith('[')) &&
                                           !(r.flags || []).includes('BadExit')).length,
            'in the app index': (idx.byCountry[cc] || []).length,
            'not rejected (fresh store)': idx.available(cc, store),
        };
        console.log(`\n══ ${cc.toUpperCase()} ══`);
        for (const [k, v] of Object.entries(stage)) console.log(`  ${String(v).padStart(5)}  ${k}`);

        //  Then what the connect path is actually handed, at the default limit and
        //  with the limit lifted -- the difference between them is the pool the
        //  "keep trying" loop is allowed to walk.
        const def = idx.candidates(cc, store);
        const all = idx.candidates(cc, store, { limit: 10000 });
        console.log(`  ${String(def.length).padStart(5)}  candidates() at its default limit`);
        console.log(`  ${String(all.length).padStart(5)}  candidates() with the limit lifted`);

        const flag = (r, f) => ((r.flags || []).includes(f) ? f[0] : '-');
        console.log('\n  the whole country, best first (nick / fp8 / ip / bw / exitProb / Fast Stable):');
        all.slice(0, 40).forEach((r, i) => {
            const src = raw.find(x => x.fingerprint.toUpperCase() === r.fp) || {};
            console.log(`   ${String(i + 1).padStart(3)}. ${(r.nick || '?').slice(0, 20).padEnd(20)} ` +
                        `${r.fp.slice(0, 8)}  ${String(r.ip).padEnd(15)} ` +
                        `${String(Math.round(r.bw / 1024)).padStart(7)} KiB/s  ` +
                        `p=${r.exitProb.toFixed(6)}  ${flag(src, 'Fast')}${flag(src, 'Stable')}`);
        });
        if (all.length > 40) console.log(`        ... and ${all.length - 40} more`);
    }

    //  For scale: the ten biggest exit countries, so "5 for SE" can be read
    //  against what a big country looks like in the same index.
    const stats = idx.countryStats();
    const top = Object.entries(stats).sort((a, b) => b[1].count - a[1].count).slice(0, 12);
    console.log('\n══ the biggest exit countries in this index ══');
    top.forEach(([cc, s]) => console.log(`  ${cc.toUpperCase().padEnd(3)} ${String(s.count).padStart(5)} exits  ` +
                                        `${String(s.fast).padStart(5)} Fast  ${String(s.ipv4Only).padStart(5)} v4-only`));
})().catch(e => { console.log('ABORT: ' + e.stack); process.exit(3); });
