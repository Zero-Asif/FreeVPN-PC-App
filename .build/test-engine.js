'use strict';
// ════════════════════════════════════════════════════════════════════
//  Live test of the engine modules that do NOT need admin rights:
//    * directGet + TLS + chunked parsing against a real HTTPS host
//    * the 12 MB maxBytes cap that replaced socksGet's 256 KB default
//    * RelayIndex.refresh / countryStats / candidates against real
//      Onionoo data -- including whether the countries the UI offers
//      actually have exit capacity
//    * ExitStore round-trip, /16 rejection and TTL behaviour
// ════════════════════════════════════════════════════════════════════
const path = require('path');
const fs = require('fs');
const os = require('os');

const { directGet } = require(path.join(__dirname, '..', 'lib', 'socks-fetch'));
const { ExitStore, RelayIndex, v4Prefix16, GEO_SOURCES } =
    require(path.join(__dirname, '..', 'lib', 'exit-selector'));
const { fallbackFromMainJs } = require('./geo-from-main.js');

const log = {
    debug: () => {}, info: m => console.log('    ' + m),
    warn: m => console.log('    WARN ' + m),
};

let bad = 0;
function check(label, cond, detail) {
    console.log((cond ? '  PASS  ' : '  FAIL  ') + label + (detail ? '   ' + detail : ''));
    if (!cond) bad++;
}

(async () => {
    // ── 1. ExitStore ────────────────────────────────────────────────
    console.log('\n[1] ExitStore');
    const tmp = path.join(os.tmpdir(), 'fp-exit-test-' + process.pid + '.json');
    try { fs.unlinkSync(tmp); } catch (e) {}
    const store = new ExitStore(tmp, log);

    check('v4Prefix16 parses', v4Prefix16('104.244.79.61') === '104.244',
        '-> ' + v4Prefix16('104.244.79.61'));
    check('v4Prefix16 rejects v6', v4Prefix16('2605:6400:30:f0ed::1') === null);

    //  Real 40-character hex fingerprints, not 'AAAA'. ExitStore.load() now
    //  validates what comes back off disk -- every field of it -- because the
    //  `fp` in this file is pinned into an elevated tor's ExitNodes line without
    //  being looked at again, and the file lives in a directory that was
    //  writable by any local user until lib/state-dir.js ran. A four-character
    //  fingerprint is something onionoo can never produce, so the fixture was
    //  testing a shape the app does not have.
    const FP_A = 'A1B2C3D4E5F60718293A4B5C6D7E8F9012345678';
    const FP_B = 'B1B2C3D4E5F60718293A4B5C6D7E8F9012345678';
    const FP_C = 'C1B2C3D4E5F60718293A4B5C6D7E8F9012345678';
    const FP_D = 'D1B2C3D4E5F60718293A4B5C6D7E8F9012345678';

    store.setVerified('lu', { fp: FP_A, nick: 'good', ip: '107.189.8.55' });
    check('verified survives a reload',
        new ExitStore(tmp, log).getVerified('lu')?.nick === 'good');
    //  The other half of that: a record this app could not have written is
    //  dropped rather than pinned. A newline in `fp` reaches torrc.
    const poisoned = path.join(os.tmpdir(), 'fp-exit-poison-' + process.pid + '.json');
    fs.writeFileSync(poisoned, JSON.stringify({ verified: { lu: {
        fp: FP_A + '\nLog notice file C:\\\\poc.txt', nick: 'evil',
        ip: '1.2.3.4', verifiedAt: Date.now() } }, rejected: {} }), 'utf8');
    check('a fingerprint with a newline in it is refused, not pinned',
        new ExitStore(poisoned, log).getVerified('lu') === null);
    try { fs.unlinkSync(poisoned); } catch (e) {}

    store.reject('lu', FP_B, '104.244.79.61');
    check('rejects the exact fingerprint', store.isRejected('lu', FP_B, null));
    check('rejects the whole /16', store.isRejected('lu', FP_C, '104.244.72.115'),
        '(the second mislabelled relay from the report)');
    check('leaves other netblocks alone', !store.isRejected('lu', FP_D, '185.220.101.1'));
    check('rejection is per country', !store.isRejected('de', FP_B, '104.244.79.61'));
    check('and the whole store survives a reload after a rejection',
        new ExitStore(tmp, log).isRejected('lu', FP_B, null));

    store.reject('lu', FP_A, '107.189.8.55');
    check('rejecting the pinned relay clears its verified record',
        store.getVerified('lu') === null);
    try { fs.unlinkSync(tmp); } catch (e) {}

    // ── 2. directGet over real TLS ──────────────────────────────────
    //  RESTATED, 2026-09-04. This asked ipleak.net and nothing else, and failed
    //  the whole suite the day ipleak.net was unwell: `502` from their gateway,
    //  then 200 in 22.2 s, then two 25 s timeouts -- MEASURED with curl, outside
    //  this app entirely, so directGet, TLS and the chunked reader were never
    //  what went wrong. A gate that turns red because someone else's server is
    //  down teaches you to ignore it.
    //
    //  The app's own requirement was never "ipleak.net is up": probeExitLocation
    //  asks all four GEO_SOURCES and weighs the votes, exactly so one of them
    //  being down -- or rate-limiting one exit -- cannot decide the answer. So
    //  this asks all four. At least one has to answer for the check to mean
    //  anything, and a 200 whose body its own parser cannot read still FAILS:
    //  that one is the chunked reader or the parser, i.e. ours.
    console.log('\n[2] socks-fetch directGet (real HTTPS, every geo source)');
    {
        const rows = [];
        for (const s of GEO_SOURCES) {
            const t0 = Date.now();
            let r;
            try { r = await directGet(s.url, { timeoutMs: 20000 }); }
            catch (e) { rows.push({ s, ms: Date.now() - t0, why: e.message }); continue; }
            const ms = Date.now() - t0;
            if (r.status !== 200) { rows.push({ s, ms, why: 'HTTP ' + r.status }); continue; }
            let got = null, err = null;
            try { got = s.parse(r.body); } catch (e) { err = e.message; }
            check(`${s.name} answered 200, and its own parser read the body`,
                  !!(got && got.cc),
                  got && got.cc ? `${got.cc} / ${got.ip} in ${ms} ms`
                                : `${r.body.length} bytes that did not parse: ${err}`);
            rows.push({ s, ms, ok: !!(got && got.cc), got });
        }
        for (const q of rows.filter(q => !q.ok && q.why))
            console.log(`    (${q.s.name} did not answer -- ${q.why}, after ${q.ms} ms. Not ` +
                        'counted either way: a third party being down is not this build.)');
        const live = rows.filter(q => q.ok);
        check('at least one geo source answered over real TLS',
              live.length > 0, `${live.length} of ${GEO_SOURCES.length}`);
        //  Printed, not asserted. Two IP databases disagreeing about one address
        //  is the reason probeExitLocation votes in the first place -- see the
        //  relay that Onionoo puts in Luxembourg and ipleak.net in Switzerland.
        const seen = [...new Set(live.map(q => q.got.cc))];
        console.log(`    unproxied location: ${seen.join(' / ') || 'unknown'}` +
                    (seen.length > 1 ? '  (sources disagree -- votes decide, by design)' : ''));
        console.log('    (this is the UNPROXIED location -- expected to be the real one here)');
    }

    // ── 3. RelayIndex against live Onionoo ──────────────────────────
    console.log('\n[3] RelayIndex.refresh (live Onionoo, 12 MB cap)');
    const idx = new RelayIndex(log);
    const cap = 12 * 1024 * 1024;
    try {
        await idx.refresh(url => directGet(url, { timeoutMs: 45000, maxBytes: cap }));
        check('relay index populated', idx.countryCount > 20, idx.countryCount + ' countries');
        check('index reports itself fresh', idx.isFresh === true);
    } catch (e) {
        //  Exit 3, not 1. This suite is in run-offline.js's gate for the country
        //  capacity check below -- which caught a dead fallback entry -- but a
        //  machine with no DNS cannot MEASURE that, and a red that only means
        //  "the network was down" is the kind nobody reads twice. 3 reports n/a.
        console.log('  n/a  Onionoo unreachable: ' + e.message);
        process.exit(3);
    }

    const stats = idx.countryStats();

    // The report's country.
    const lu = stats.lu;
    check('Luxembourg has exit capacity', !!lu && lu.count > 0,
        lu ? lu.count + ' exits, ' + lu.ipv4Only + ' of them IPv4-only' : 'none');

    // The two countries the old fallback list offered but Tor cannot serve.
    // Both are stated as CAPACITY, not as absence: on 2026-09-05 Onionoo began
    // reporting one Bangladeshi exit, and an absence pinned as permanent turns
    // red the day the network changes -- which says nothing about this build.
    // What the old list was wrong about is that these countries can carry
    // users, and a single-digit pool cannot.
    check('Bangladesh exit capacity is negligible', !stats.bd || stats.bd.count < 5,
        stats.bd ? stats.bd.count + ' exits -- not a pool a country entry could use'
                 : 'none at all');
    check('India exit capacity is negligible', !stats.in || stats.in.count < 5,
        stats.in ? stats.in.count + ' exits' : 'none');

    // Every country in the app's built-in fallback list must be real. The list
    // is read out of main.js, not typed here: the copy that used to live on this
    // line still offered ie, hu, pt, gr and br, so this check reported
    // "DEAD: ie,br" against a list the app had not shipped for some time.
    const FALLBACK = Object.keys(fallbackFromMainJs(path.join(__dirname, '..')));
    const dead = FALLBACK.filter(cc => !stats[cc] || stats[cc].count === 0);
    check('every country in the built-in fallback list has exits',
        dead.length === 0, dead.length ? 'DEAD: ' + dead.join(',') : 'all ' + FALLBACK.length + ' ok');

    // ── 4. Candidate scoring ────────────────────────────────────────
    console.log('\n[4] candidate selection for LU (the reported failure)');
    const store2 = new ExitStore(path.join(os.tmpdir(), 'fp-exit-test2-' + process.pid + '.json'), log);
    const cands = idx.candidates('lu', store2, { limit: 5 });
    check('candidates returned', cands.length > 0, cands.length + ' candidate(s)');
    cands.forEach((c, i) => console.log('      ' + (i + 1) + '. ' + (c.nick || c.fp.slice(0, 8)) +
        '  ' + c.ip + '  v6=' + (c.hasV6 ? 'YES' : 'no') +
        '  bw=' + Math.round(c.bw / 1e6) + ' MB/s  score=' + Math.round(c.score)));
    check('IPv4-only relays are ranked first',
        cands.length < 2 || !cands[0].hasV6 || cands.every(c => c.hasV6),
        'first candidate hasV6=' + (cands[0] && cands[0].hasV6));

    //  The exact netblock from the report: 104.244.x is labelled LU by
    //  Onionoo but geolocates to Switzerland on ipleak.net.
    const franTech = (idx.byCountry.lu || []).filter(c => v4Prefix16(c.ip) === '104.244');
    console.log('    relays in the mislabelled 104.244/16 block: ' + franTech.length);
    if (franTech.length) {
        store2.reject('lu', franTech[0].fp, franTech[0].ip);
        const after = idx.candidates('lu', store2, { limit: 20 });
        const leaked = after.filter(c => v4Prefix16(c.ip) === '104.244');
        check('one rejection removes the whole 104.244/16 block from the plan',
            leaked.length === 0, leaked.length + ' still offered');
    }
    try { fs.unlinkSync(store2.file); } catch (e) {}

    console.log('\n' + (bad ? bad + ' check(s) FAILED' : 'all checks passed'));
    process.exit(bad ? 1 : 0);
})();
