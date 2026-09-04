'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/probe-relay-cache.js
//
//  Before this cache existed, every cold start had to ask
//  onionoo.torproject.org for the exit-relay list, and it had to ask IN THE
//  CLEAR -- there is no tunnel to ask through until the list has been read.
//  The destination alone is the disclosure: a plain HTTPS request to that host
//  from the user's own address says "a Tor client is starting here" to the ISP
//  and to anything doing SNI inspection between here and there. The two "keep
//  trying" loops made the same request every 20 seconds for as long as the user
//  was willing to wait.
//
//  So the index is now persisted, and a usable cached list SUPPRESSES the
//  cleartext read entirely. That buys two ways to be wrong, and this file is
//  about both:
//
//    1. A cache that comes back subtly different from what was saved. Every
//       candidate is scored from six fields; drop one and it scores as 0, the
//       shortlist reorders, and nothing anywhere reports it. So the round trip
//       is checked field by field AND by comparing the scored shortlist.
//    2. A cache that is trusted for more than it can support. "There is no exit
//       relay in Luxembourg" is a claim about the network now and the app opens
//       a dialog on it; a day-old list cannot support that, while it is a
//       perfectly good source of relays to TRY. That is the isFresh/isUsable
//       split, and it is asserted at the boundary rather than assumed.
//
//  Nothing here touches the network. The fetcher is injected -- which is why
//  RelayIndex takes one -- so the parse, the filter, the file and the scoring
//  are all exercised against a fixed response.
// ════════════════════════════════════════════════════════════════════
const os   = require('os');
const path = require('path');
const fs   = require('fs');
const ES   = require('../lib/exit-selector.js');
const { RelayIndex, ExitStore, ONIONOO_FIELDS, INDEX_FRESH_MS, INDEX_USE_MS } = ES;

let pass = 0, fail = 0;
const ok = (c, m, x) => {
    if (c) { pass++; console.log('  ok   ' + m); }
    else { fail++; console.log('  FAIL ' + m + (x ? '\n         ' + String(x) : '')); }
};

const TMP = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'fp-relaycache-')));
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {} });

const QUIET = { debug() {}, info() {}, warn() {}, success() {} };
const LOUD  = () => { const l = []; return {
    lines: l,
    debug: m => l.push('debug ' + m), info: m => l.push('info ' + m),
    warn:  m => l.push('warn ' + m),  success: m => l.push('ok ' + m),
}; };

// ── the fixed onionoo response ──────────────────────────────────────
//  Shaped like the real one, and deliberately containing every case refresh()
//  has to make a decision about: a BadExit relay, a relay with no IPv4 ORPort,
//  a relay with no country, a dual-stack relay and an IPv4-only one.
const RELAYS = [
    { fingerprint: 'aaaa'.repeat(10), nickname: 'v4only',  country: 'LU',
      or_addresses: ['185.1.2.3:9001'], observed_bandwidth: 90e6,
      exit_probability: 0.001, flags: ['Running', 'Exit', 'Fast', 'Stable'] },
    { fingerprint: 'bbbb'.repeat(10), nickname: 'dual',    country: 'lu',
      or_addresses: ['185.1.2.4:9001', '[2605:6400:30::1]:9001'],
      observed_bandwidth: 400e6, exit_probability: 0.02, flags: ['Running', 'Exit', 'Fast'] },
    { fingerprint: 'cccc'.repeat(10), nickname: 'slowlu',  country: 'LU',
      or_addresses: ['104.244.79.61:9001'], observed_bandwidth: 3e6,
      exit_probability: 0, flags: ['Running', 'Exit'] },
    { fingerprint: 'dddd'.repeat(10), nickname: 'badexit', country: 'LU',
      or_addresses: ['185.9.9.9:9001'], observed_bandwidth: 800e6,
      exit_probability: 0, flags: ['Running', 'Exit', 'Fast', 'Stable', 'BadExit'] },
    { fingerprint: 'eeee'.repeat(10), nickname: 'v6only',  country: 'LU',
      or_addresses: ['[2001:db8::9]:9001'], observed_bandwidth: 500e6,
      exit_probability: 0, flags: ['Running', 'Exit', 'Fast'] },
    { fingerprint: 'ffff'.repeat(10), nickname: 'nocc',    country: '',
      or_addresses: ['185.7.7.7:9001'], observed_bandwidth: 500e6,
      exit_probability: 0, flags: ['Running', 'Exit'] },
    { fingerprint: '1111'.repeat(10), nickname: 'de1',     country: 'DE',
      or_addresses: ['82.1.1.1:9001'], observed_bandwidth: 250e6,
      exit_probability: 0.005, flags: ['Running', 'Exit', 'Fast', 'Stable'] },
];
const fakeFetch = async () => ({ status: 200, body: JSON.stringify({ relays: RELAYS }) });

const store = new ExitStore(path.join(TMP, 'exit-cache.json'), QUIET);
const CACHE = path.join(TMP, 'relay-index.json');
const readCache = () => JSON.parse(fs.readFileSync(CACHE, 'utf8'));

//  Wrapped in a function only because refresh() is async and this file is
//  CommonJS -- top-level await is a module-only feature.
async function main() {

console.log('── an index with nothing behind it claims nothing ──');
const empty = new RelayIndex(QUIET, CACHE);
ok(!fs.existsSync(CACHE), 'no cache file is created just by constructing one');
ok(empty.countryCount === 0 && empty.relayCount === 0, 'it is empty');
ok(empty.isFresh === false, 'and NOT fresh -- fetchedAt 0 must never read as recent');
ok(empty.isUsable === false,
   'and NOT usable, so refreshRelayIndex cannot suppress the fetch on the ' +
   'strength of an index that has no relays in it');

console.log('');
console.log('── one refresh, and the file is there ──');
const live = new RelayIndex(QUIET, CACHE);
await live.refresh(fakeFetch);
ok(fs.existsSync(CACHE),
   'refresh() writes the cache itself, rather than leaving it to an exit ' +
   'handler -- the app can be killed from the tray or by the installer');
ok(live.isFresh && live.isUsable, 'and the index reads fresh and usable');
ok(live.fromDisk === false, 'fromDisk is false: this list came off the network');
ok(live.countryCount === 2 && live.relayCount === 4,
   'LU and DE, 4 relays: BadExit, the v6-only one and the one with no country ' +
   'are all gone', `${live.countryCount} countries / ${live.relayCount} relays`);
const onDisk = readCache();
ok(JSON.stringify(Object.keys(onDisk).sort()) ===
   JSON.stringify(['byCountry', 'fetchedAt', 'fields']),
   'the file holds exactly fields/fetchedAt/byCountry and nothing else',
   Object.keys(onDisk).join(', '));
ok(onDisk.fields === ONIONOO_FIELDS,
   'it records WHICH onionoo query produced it, so adding a field invalidates ' +
   'older caches instead of silently yielding candidates missing it');
const flat = JSON.stringify(onDisk.byCountry);
ok(!/badexit|BadExit/.test(flat),
   'the BadExit relay is not in the file either -- the cache stores the ' +
   'FILTERED set, so a future load cannot resurrect a relay the directory ' +
   'authorities have told every client not to exit through');
ok(!/2001:db8|2605:6400/.test(flat),
   'and no IPv6 ORPort address is stored, because no v6-only relay survived');

console.log('');
console.log('── the round trip changes nothing, field for field ──');
//  The whole point of a cache is that what comes back is what went in. Six
//  fields feed candidates()'s score and a missing one scores as 0, so this
//  compares the SCORED shortlist as well as the raw records: a silent reorder
//  of the shortlist is the failure that would otherwise never surface.
const beforeLu = live.candidates('lu', store, { limit: 8 });
const beforeDe = live.candidates('de', store, { limit: 8 });
const loaded = new RelayIndex(QUIET, CACHE);
ok(loaded.fromDisk === true, 'a second index over the same file reports fromDisk');
ok(loaded.fetchedAt === live.fetchedAt,
   'and carries the ORIGINAL fetch time, not the load time -- age is what every ' +
   'freshness decision is made on, and resetting it here would make a day-old ' +
   'list read as brand new on every start');
ok(loaded.relayCount === live.relayCount && loaded.countryCount === live.countryCount,
   'same relay and country counts');
ok(JSON.stringify(loaded.candidates('lu', store, { limit: 8 })) ===
   JSON.stringify(beforeLu) &&
   JSON.stringify(loaded.candidates('de', store, { limit: 8 })) ===
   JSON.stringify(beforeDe),
   'and the scored shortlist is identical for both countries, score included');
ok(beforeLu[0].nick === 'v4only',
   'the IPv4-only relay still outranks the 4x-faster dual-stack one -- the +5000 ' +
   'term survived the round trip', beforeLu.map(c => c.nick).join(' > '));
ok(JSON.stringify(loaded.countryStats()) === JSON.stringify(live.countryStats()),
   'countryStats(), which is what the dropdown and appState.servers are built ' +
   'from, is byte-identical');
ok(loaded.fastestRelays(8).length === 4 &&
   loaded.fastestRelays(1)[0].nick === 'dual',
   'fastestRelays(), the middle-hop source for a forced circuit, still works off ' +
   'the cached list');

console.log('');
console.log('── usable to CONNECT with, not fresh enough to make claims from ──');
//  This is the split the whole design rests on. Between 15 minutes and 24 hours
//  old, the list is good for picking a relay to try -- every one of them is
//  pinned by fingerprint and then geolocated before the connect counts, so a
//  relay that has gone away costs one failed circuit and a retry. It is NOT good
//  enough to tell the user "there is no exit relay in Luxembourg" and open a
//  dialog about it, which is why main.js gates that on isFresh and this gates
//  suppressing the cleartext fetch on isUsable.
const agedTo = ms => {
    const c = readCache();
    c.fetchedAt = Date.now() - ms;
    fs.writeFileSync(CACHE, JSON.stringify(c), 'utf8');
    return new RelayIndex(QUIET, CACHE);
};
const mid = agedTo(INDEX_FRESH_MS + 60000);
ok(mid.isFresh === false,
   'a 16-minute-old list is NOT fresh, so no dialog can claim a country has run ' +
   'out of exits on the strength of it');
ok(mid.isUsable === true && mid.candidates('lu', store).length === 3,
   'but it IS usable, and hands back all three Luxembourg relays -- this is the ' +
   'cold start that no longer needs a cleartext request to connect');
const old = agedTo(INDEX_USE_MS + 60000);
ok(old.isUsable === false && old.relayCount === 0,
   'past 24 hours it is dropped outright, not merely marked -- an unusable list ' +
   'must not stay in memory where candidates() could still reach it');
const future = agedTo(-60 * 60 * 1000);
ok(future.isUsable === false && future.relayCount === 0,
   'a cache stamped in the FUTURE is dropped too. A clock that moved is not a ' +
   'reason to trust a file for the next decade');

console.log('');
console.log('── a cache it must refuse, and refuse quietly ──');
const withCache = (obj, raw) => {
    fs.writeFileSync(CACHE, raw !== undefined ? raw : JSON.stringify(obj), 'utf8');
    const log = LOUD();
    const idx = new RelayIndex(log, CACHE);
    return { idx, log };
};
const good = { fields: ONIONOO_FIELDS, fetchedAt: Date.now(),
               byCountry: { lu: [{ fp: 'A'.repeat(40), nick: 'x', ip: '1.2.3.4',
                                   hasV6: false, bw: 1e6, exitProb: 0,
                                   fast: true, stable: true }] } };
const diffFields = withCache({ ...good, fields: ONIONOO_FIELDS + ',contact' });
ok(diffFields.idx.isUsable === false,
   'a cache written by a build that asked onionoo for different fields is ignored');
const noBy = withCache({ fields: ONIONOO_FIELDS, fetchedAt: Date.now() });
ok(noBy.idx.isUsable === false, 'so is one with no byCountry at all');
const corrupt = withCache(null, '{ this is not json');
ok(corrupt.idx.isUsable === false && corrupt.idx.relayCount === 0,
   'and a truncated file -- a half-written cache after a power cut -- loads as ' +
   'empty rather than throwing out of the constructor');
ok(corrupt.log.lines.some(l => /warn .*cache unreadable/.test(l)),
   'it is reported, because an app that silently stops caching would look ' +
   'exactly like one that never cached', corrupt.log.lines.join(' | '));
ok(withCache(good).idx.isUsable === true,
   'and a well-formed one is accepted, so the three refusals above are not ' +
   'just this probe refusing everything');

console.log('');
console.log('── no cache file asked for, no cache file written ──');
const nofile = new RelayIndex(QUIET);
await nofile.refresh(fakeFetch);
ok(nofile.relayCount === 4 && nofile.isUsable,
   'RelayIndex still works with no path -- the file is an addition, not a ' +
   'dependency');
const unwritable = new RelayIndex(LOUD(),
    path.join(TMP, 'no-such-file.json', 'nested', 'relay.json'));
let threw = null;
try { await unwritable.refresh(fakeFetch); } catch (e) { threw = e; }
ok(threw === null && unwritable.relayCount === 4,
   'and a cache it cannot write -- a locked directory, Controlled Folder ' +
   'Access -- costs the cache and not the refresh', threw && threw.message);

console.log('');
console.log('── a bad response leaves the last good list alone ──');
//  refresh() throwing must not empty the index. Every caller wraps it in
//  try/catch and then carries on using relayIndex -- if a failed fetch cleared
//  it, an onionoo outage would turn a working cached list into no list at all.
const keeper = new RelayIndex(QUIET, path.join(TMP, 'keeper.json'));
await keeper.refresh(fakeFetch);
const kept = JSON.stringify(keeper.byCountry);
const bad = [
    ['HTTP 504',        async () => ({ status: 504, body: '' })],
    ['no response',     async () => null],
    ['not JSON',        async () => ({ status: 200, body: 'gateway timeout' })],
    ['zero relays',     async () => ({ status: 200, body: '{"relays":[]}' })],
];
for (const [name, f] of bad) {
    let e = null;
    try { await keeper.refresh(f); } catch (x) { e = x; }
    ok(e !== null, `${name} throws rather than returning an empty index`);
}
ok(JSON.stringify(keeper.byCountry) === kept,
   'and after all four, the relays from the last good fetch are still there ' +
   'byte for byte -- an onionoo outage costs freshness, not the list');

console.log('');
console.log('── and the policy in main.js that decides when to ask at all ──');
//  RelayIndex only knows how to hold a list. WHETHER a cleartext request goes
//  out is decided in refreshRelayIndex(), which lives inside app.whenReady and
//  cannot be required from here -- so it is read. Every check below is a rule
//  that, if it silently stopped holding, would put the request back on the wire
//  with nothing failing.
const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

ok(/new RelayIndex\(Logger, getScriptPath\('relay-index\.json'\)\)/.test(MAIN),
   'the index is constructed WITH a cache path -- everything above is dead code ' +
   'if this one argument is dropped');
ok(/async function refreshRelayIndex\(\{ viaTor, force = false, clearNetOk = false \} = \{\}\)/
   .test(MAIN),
   'clearNetOk defaults to FALSE, so a caller that has not thought about it gets ' +
   'the private path');
ok(/if \(!viaTor && !clearNetOk && relayIndex\.isUsable\) \{/.test(MAIN),
   'and a usable cached list suppresses the cleartext read outright, rather than ' +
   'merely making it less frequent');
ok(/let lastRelayFetch = relayIndex\.isUsable \? relayIndex\.fetchedAt : 0;/.test(MAIN),
   'the rate limiter is seeded from the cache, not from 0 -- otherwise the first ' +
   'call after every start is exempt from it and a restart loop is a fetch loop');
const stampIdx = MAIN.indexOf('lastRelayFetch = Date.now();');
const fetchIdx = MAIN.indexOf('await relayIndex.refresh(fetcher);');
ok(fetchIdx > 0 && stampIdx > fetchIdx,
   'and stamped only AFTER the fetch resolves: a failed request must not buy five ' +
   'minutes of silence while the app still has no list');

const gapM  = /const REFRESH_MIN_GAP_MS = ([\d\s*]+);/.exec(MAIN);
const gapMs = gapM ? gapM[1].split('*').reduce((a, b) => a * Number(b.trim()), 1) : NaN;
ok(gapMs > 0 && gapMs < INDEX_FRESH_MS,
   `the minimum gap (${gapMs / 60000} min) is shorter than the freshness window ` +
   `(${INDEX_FRESH_MS / 60000} min), so a refresh the limiter skipped still leaves ` +
   'the index fresh enough for the negative claims at the connect sites',
   'gap ' + gapMs + ' vs fresh ' + INDEX_FRESH_MS);

const clearCalls = MAIN.match(/refreshRelayIndex\(\{[^}]*clearNetOk[^}]*\}\)/g) || [];
ok(clearCalls.length === 2,
   'exactly two call sites opt into a cleartext read: waiting for a country to ' +
   'come back, and try-again after the engine failed. Both are the user asking ' +
   'the app to keep looking with nothing connected', clearCalls.join('  ||  '));
ok(clearCalls.every(c => /viaTor: false/.test(c)),
   'and both are the viaTor:false path -- clearNetOk on a through-Tor call would ' +
   'read like permission for something it does not control');

const gate = /body: `Nothing is connected while this runs -- no other country[\s\S]*?`,/
    .exec(MAIN);
//  The body is written as adjacent template literals joined with `+`, so the
//  sentence has to be reassembled before it can be read -- "every 5 " and
//  "minutes" sit on either side of one of those joins.
const gateFlat = gate
    ? gate[0].replace(/`\s*\+\s*`/g, '').replace(/\s+/g, ' ')
    : '';
ok(gate && !/re-reads the live Tor relay list every 20 seconds/.test(gateFlat),
   'the waiting card no longer promises a relay-list download every 20 seconds, ' +
   'which the rate limiter had just made false', gateFlat.slice(0, 140));
ok(gateFlat.includes('at most every ' + (gapMs / 60000) + ' minutes'),
   'it states the real download cadence, and the number matches ' +
   'REFRESH_MIN_GAP_MS rather than being a hand-written guess', gateFlat);

const connIdx = MAIN.indexOf("status:     'connected',");
const tail = connIdx > 0 ? MAIN.slice(Math.max(0, connIdx - 2500), connIdx) : '';
ok(/refreshRelayIndex\(\{ viaTor: true, force: true \}\)/.test(tail),
   'a successful connect refreshes the list THROUGH the new tunnel. Without this ' +
   'the log line promising exactly that would be a claim nothing performs -- the ' +
   "renderer's 30 s poll is the renderer's, and a window closed to the tray or a " +
   'later edit would quietly retire it');

console.log('');
console.log(`${pass}/${pass + fail} checks passed` + (fail ? `  (${fail} FAILED)` : ''));
process.exit(fail ? 1 : 0);

}

main().catch(e => { console.log('\nTHREW: ' + (e && e.stack || e)); process.exit(2); });
