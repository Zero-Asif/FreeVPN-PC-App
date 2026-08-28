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
const { ExitStore, RelayIndex, v4Prefix16 } =
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

    store.setVerified('lu', { fp: 'AAAA', nick: 'good', ip: '107.189.8.55' });
    check('verified survives a reload',
        new ExitStore(tmp, log).getVerified('lu')?.nick === 'good');

    store.reject('lu', 'BBBB', '104.244.79.61');
    check('rejects the exact fingerprint', store.isRejected('lu', 'BBBB', null));
    check('rejects the whole /16', store.isRejected('lu', 'CCCC', '104.244.72.115'),
        '(the second mislabelled relay from the report)');
    check('leaves other netblocks alone', !store.isRejected('lu', 'DDDD', '185.220.101.1'));
    check('rejection is per country', !store.isRejected('de', 'BBBB', '104.244.79.61'));

    store.reject('lu', 'AAAA', '107.189.8.55');
    check('rejecting the pinned relay clears its verified record',
        store.getVerified('lu') === null);
    try { fs.unlinkSync(tmp); } catch (e) {}

    // ── 2. directGet over real TLS ──────────────────────────────────
    console.log('\n[2] socks-fetch directGet (real HTTPS)');
    let r;
    try {
        r = await directGet('https://ipleak.net/json/', { timeoutMs: 20000 });
        check('ipleak.net answered 200', r.status === 200, 'status=' + r.status);
        const j = JSON.parse(r.body);
        check('body parses as JSON with a country', !!j.country_code,
            j.country_code + ' / ' + j.ip);
        console.log('    (this is the UNPROXIED location -- expected to be the real one here)');
    } catch (e) {
        check('ipleak.net reachable', false, e.message);
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
        check('Onionoo reachable', false, e.message);
        console.log('\n' + (bad ? bad + ' check(s) failed' : 'all checks passed'));
        process.exit(bad ? 1 : 0);
    }

    const stats = idx.countryStats();

    // The report's country.
    const lu = stats.lu;
    check('Luxembourg has exit capacity', !!lu && lu.count > 0,
        lu ? lu.count + ' exits, ' + lu.ipv4Only + ' of them IPv4-only' : 'none');

    // The two countries the old fallback list offered but Tor cannot serve.
    check('Bangladesh correctly absent from exit stats', !stats.bd,
        stats.bd ? 'UNEXPECTED: ' + stats.bd.count : 'confirmed');
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
