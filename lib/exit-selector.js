'use strict';
// ════════════════════════════════════════════════════════════════════
//  exit-selector.js -- pick, verify and remember one exit relay per
//                      country, the way a commercial VPN picks a server
//
//  THE PROBLEM THIS SOLVES
//  -----------------------
//  `ExitNodes {lu} / StrictNodes 1` asks Tor to choose any exit its own
//  bundled GeoIP file labels "LU". Two things go wrong with that:
//
//  1. Tor's GeoIP snapshot disagrees with the databases websites use.
//     Measured on this machine's own relay list: 104.244.79.61 and
//     104.244.72.115 are labelled LU by Tor/Onionoo but resolve to
//     Switzerland on ipleak.net -- which is exactly the wrong country
//     the app reported as a successful Luxembourg connection.
//
//  2. "{lu}" is a *set*, so every stream may take a different exit.
//     Web traffic ends up on one relay while DNS resolution goes out
//     through others -- that is why ipleak.net listed five DNS servers
//     in Slovakia, the USA, Germany and Finland at the same time.
//
//  THE FIX
//  -------
//  Choose ONE relay, verify its address against the same geolocation
//  databases the user tests with, then pin it by fingerprint. One exit
//  means one IP for web traffic and DNS alike, and a country that has
//  been confirmed rather than assumed.
//
//  Two extra refinements that come straight out of the measured data:
//
//  * Prefer relays with no IPv6 address. FranTech operates most of
//    Luxembourg's exit capacity; its IPv4 space geolocates to LU but its
//    entire 2605:6400:30::/48 IPv6 block geolocates to Bern, Switzerland.
//    That single fact produced the "IPv4 Luxembourg / IPv6 Switzerland"
//    split in the report.
//  * Reject by /16 prefix, not just by fingerprint. Geolocation databases
//    classify whole netblocks, so once 104.244.79.61 is shown to be
//    mislabelled, every other 104.244.x.x relay is suspect too. Rejecting
//    the prefix makes the search converge in one or two attempts instead
//    of grinding through 93 relays one at a time.
// ════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const { socksGet, directGet } = require('./socks-fetch');

//  `flags` is fetched as well as the bandwidth numbers for two reasons. Tor's
//  own Fast/Stable flags are the cheapest honest signal there is about whether a
//  relay can actually carry a web page: the directory authorities award Fast to
//  relays at or above the median measured bandwidth and Stable to those with an
//  above-median uptime. Picking an exit without them is how a tunnel ends up
//  technically connected and unusable. And BadExit is the authorities telling
//  every client not to exit through a relay at all -- see refresh(), which drops
//  those outright.

const ONIONOO_FIELDS =
    'fingerprint,nickname,country,or_addresses,observed_bandwidth,exit_probability,flags';
const ONIONOO_URL =
    'https://onionoo.torproject.org/details?type=relay&running=true&flag=Exit&fields=' + ONIONOO_FIELDS;

const REJECT_TTL_MS  = 12 * 60 * 60 * 1000;   // re-test a bad relay after 12 h
const VERIFY_TTL_MS  = 24 * 60 * 60 * 1000;   // re-confirm a good relay daily

//  How long a relay index is worth CONNECTING with, as opposed to worth making
//  claims from. See RelayIndex.isFresh vs RelayIndex.isUsable -- the two
//  numbers answer two different questions and conflating them is how an app
//  ends up either leaking or lying.
const INDEX_FRESH_MS = 15 * 60 * 1000;        // recent enough to say "no exits there"
const INDEX_USE_MS   = 24 * 60 * 60 * 1000;   // recent enough to try its relays

// ── Geolocation sources ─────────────────────────────────────────────
//  ipleak.net is listed first and carries double weight on purpose: it is
//  the service the user checks the result with, so its database is the one
//  that defines success. The others break ties and cover the case where
//  ipleak.net rate-limits or blocks a particular exit.
const GEO_SOURCES = [
    {
        name: 'ipleak.net',
        url: 'https://ipleak.net/json/',
        weight: 2,
        parse: b => { const j = JSON.parse(b); return { cc: j.country_code, ip: j.ip }; },
    },
    {
        name: 'geojs.io',
        url: 'https://get.geojs.io/v1/ip/country.json',
        weight: 1,
        parse: b => { const j = JSON.parse(b); return { cc: j.country, ip: j.ip }; },
    },
    {
        name: 'country.is',
        url: 'https://api.country.is/',
        weight: 1,
        parse: b => { const j = JSON.parse(b); return { cc: j.country, ip: j.ip }; },
    },
    {
        name: 'ipinfo.io',
        url: 'https://ipinfo.io/json',
        weight: 1,
        parse: b => { const j = JSON.parse(b); return { cc: j.country, ip: j.ip }; },
    },
];

function v4Prefix16(ip) {
    if (!ip) return null;
    const m = /^(\d{1,3})\.(\d{1,3})\./.exec(ip);
    return m ? `${m[1]}.${m[2]}` : null;
}

// ════════════════════════════════════════════════════════════════════
//  VALIDATING WHAT COMES BACK OFF DISK
//
//  Both files these classes persist live in C:\ProgramData\freeproxy-vpn,
//  and a fingerprint read out of either one is written into a config file
//  that an ELEVATED tor.exe loads:
//
//      main.js buildTorrc()   ->  `ExitNodes ${exitSpec}`   , exitSpec = '$' + fp
//      main.js re-pin         ->  SETCONF ExitNodes="$<fp>"  over the control port
//
//  torrc is line-oriented and Tor reads every line of it. So a cached
//  candidate whose `fp` contained a newline would not merely pin the wrong
//  relay -- it would append directives of the attacker's choosing to the
//  configuration of a process running with an administrator token. `Log`,
//  `DataDirectory`, `ClientOnionAuthDir`: none of them need an exploit,
//  just a line in a file. And a `"` would close SETCONF's quoted value.
//
//  lib/state-dir.js now stops a standard user creating those files in the
//  first place, and this is the second half of the same fix: even a file
//  this app itself wrote is re-checked on the way back in, because it is
//  read from a path on disk rather than kept in memory. Nothing legitimate
//  ever fails these tests -- every field is produced by refresh() from
//  onionoo's own JSON, one line each -- so a failure means the file was
//  corrupted or edited, and neither is a reason to trust the rest of it.
//
//  Both loaders therefore reject the WHOLE file rather than filtering it.
//  A partly-trusted cache is the harder thing to reason about, and the cost
//  of throwing it away is one HTTPS request.
// ════════════════════════════════════════════════════════════════════
const isFp    = s => typeof s === 'string' && /^[0-9A-F]{40}$/.test(s);
const isCc    = s => typeof s === 'string' && /^[a-z]{2}$/.test(s);
const isV4    = s => typeof s === 'string' && /^(\d{1,3}\.){3}\d{1,3}$/.test(s) &&
                     s.split('.').every(o => Number(o) <= 255);
//  Nicknames are Tor's own [A-Za-z0-9]{1,19}. Checked because the nickname
//  reaches the log and the window, and a control character in a log line is
//  how a log viewer gets fooled about what happened.
const isNick  = s => typeof s === 'string' && /^[A-Za-z0-9]{0,19}$/.test(s);
const isNum   = (n, max) => typeof n === 'number' && Number.isFinite(n) &&
                            n >= 0 && (max === undefined || n <= max);
const isBool  = b => typeof b === 'boolean';

//  One candidate, exactly as refresh() builds it -- no extra keys either, so a
//  field that has been added to the file by something other than save() shows
//  up here rather than being carried along unnoticed.
const CAND_KEYS = ['fp', 'nick', 'ip', 'hasV6', 'bw', 'exitProb', 'fast', 'stable'];
function badCandidate(c) {
    if (!c || typeof c !== 'object' || Array.isArray(c)) return 'not an object';
    for (const k of Object.keys(c)) if (!CAND_KEYS.includes(k)) return 'unexpected field ' + k;
    if (!isFp(c.fp))          return 'fingerprint is not 40 hex characters';
    if (!isNick(c.nick))      return 'nickname is not a Tor nickname';
    if (!isV4(c.ip))          return 'ip is not a dotted-quad IPv4 address';
    if (!isBool(c.hasV6))     return 'hasV6 is not a boolean';
    if (!isNum(c.bw))         return 'bw is not a non-negative number';
    if (!isNum(c.exitProb, 1)) return 'exitProb is not a number in 0..1';
    if (!isBool(c.fast))      return 'fast is not a boolean';
    if (!isBool(c.stable))    return 'stable is not a boolean';
    return null;
}

//  { cc: [candidate, ...] }. Returns the first reason it is not that, or null.
function badByCountry(by) {
    if (!by || typeof by !== 'object' || Array.isArray(by)) return 'byCountry is not an object';
    for (const [cc, list] of Object.entries(by)) {
        if (!isCc(cc)) return `"${String(cc).slice(0, 12)}" is not a two-letter country code`;
        if (!Array.isArray(list)) return `${cc} does not hold a list`;
        for (const c of list) {
            const why = badCandidate(c);
            if (why) return `${cc}: ${why}`;
        }
    }
    return null;
}

//  ── The other file in that directory ────────────────────────────────
//  exit-cache.json is the smaller surface but it is the more direct one: the
//  fingerprint in `verified` is pushed straight into the connect plan at
//  main.js:3906, ahead of anything from the live list, and pinned. So it gets
//  the same treatment.
const VERIFIED_KEYS = ['fp', 'nick', 'ip', 'verifiedAt'];
function badVerified(v) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return 'verified is not an object';
    for (const [cc, rec] of Object.entries(v)) {
        if (!isCc(cc)) return `"${String(cc).slice(0, 12)}" is not a two-letter country code`;
        if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return `${cc}: not a record`;
        for (const k of Object.keys(rec))
            if (!VERIFIED_KEYS.includes(k)) return `${cc}: unexpected field ${k}`;
        if (!isFp(rec.fp))   return `${cc}: fingerprint is not 40 hex characters`;
        if (!isNick(rec.nick === undefined ? '' : rec.nick))
            return `${cc}: nickname is not a Tor nickname`;
        //  ip is genuinely optional: probeExitLocation may confirm the country
        //  without returning an address, and main.js stores `probe.ip ||
        //  cand.ip || null` for that case.
        if (!(rec.ip === null || rec.ip === undefined || isV4(rec.ip)))
            return `${cc}: ip is neither null nor a dotted-quad address`;
        if (!isNum(rec.verifiedAt)) return `${cc}: verifiedAt is not a number`;
    }
    return null;
}

//  { cc: { 'fp:<40 hex>' | 'net:<a.b>': timestamp } } -- exactly what reject()
//  writes. The keys are only ever compared against each other, never written
//  anywhere, so this is a consistency check rather than an injection one; it is
//  here so that "the file is not what this app wrote" has ONE answer.
function badRejected(rj) {
    if (!rj || typeof rj !== 'object' || Array.isArray(rj)) return 'rejected is not an object';
    for (const [cc, bucket] of Object.entries(rj)) {
        if (!isCc(cc)) return `"${String(cc).slice(0, 12)}" is not a two-letter country code`;
        if (!bucket || typeof bucket !== 'object' || Array.isArray(bucket))
            return `${cc}: not a bucket`;
        for (const [k, t] of Object.entries(bucket)) {
            const okKey = /^fp:[0-9A-F]{40}$/.test(k) ||
                          (/^net:\d{1,3}\.\d{1,3}$/.test(k) &&
                           k.slice(4).split('.').every(o => Number(o) <= 255));
            if (!okKey) return `${cc}: "${String(k).slice(0, 20)}" is not a reject key`;
            if (!isNum(t)) return `${cc}: ${k} is not stamped with a number`;
        }
    }
    return null;
}

// ════════════════════════════════════════════════════════════════════
//  Persisted knowledge about which relay actually works per country
// ════════════════════════════════════════════════════════════════════
class ExitStore {
    constructor(filePath, logger) {
        this.file = filePath;
        this.log = logger || { debug() {}, warn() {} };
        this.data = { verified: {}, rejected: {} };
        this.load();
    }

    load() {
        try {
            if (fs.existsSync(this.file)) {
                const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
                const verified = (parsed && parsed.verified) || {};
                const rejected = (parsed && parsed.rejected) || {};
                //  Checked, not trusted. See the validators above: the `fp` in
                //  here is pinned into an elevated tor's ExitNodes without ever
                //  being looked at again, and this file sits in a directory that
                //  was writable by any local user until lib/state-dir.js ran.
                const why = badVerified(verified) || badRejected(rejected);
                if (why) {
                    this.log.warn('exit cache rejected -- it is not what this app ' +
                                  'wrote (' + why + '). Starting from nothing; the ' +
                                  'exits will simply be verified again.');
                    return;
                }
                this.data = { verified, rejected };
            }
        } catch (e) { this.log.warn('exit cache unreadable: ' + e.message); }
    }

    save() {
        try {
            fs.mkdirSync(path.dirname(this.file), { recursive: true });
            fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
        } catch (e) { this.log.warn('exit cache not saved: ' + e.message); }
    }

    getVerified(cc) {
        const rec = this.data.verified[cc];
        if (!rec) return null;
        if (Date.now() - (rec.verifiedAt || 0) > VERIFY_TTL_MS) return null;
        return rec;
    }

    setVerified(cc, rec) {
        this.data.verified[cc] = { ...rec, verifiedAt: Date.now() };
        this.save();
    }

    dropVerified(cc) {
        delete this.data.verified[cc];
        this.save();
    }

    //  Records both the fingerprint and its /16, because geolocation
    //  databases label netblocks rather than individual hosts.
    reject(cc, fp, ip) {
        const bucket = this.data.rejected[cc] || (this.data.rejected[cc] = {});
        const now = Date.now();
        if (fp) bucket['fp:' + fp.toUpperCase()] = now;
        const pfx = v4Prefix16(ip);
        if (pfx) bucket['net:' + pfx] = now;
        if (this.data.verified[cc] && this.data.verified[cc].fp === fp) {
            delete this.data.verified[cc];
        }
        this.save();
    }

    isRejected(cc, fp, ip) {
        const bucket = this.data.rejected[cc];
        if (!bucket) return false;
        const fresh = key => bucket[key] && (Date.now() - bucket[key] < REJECT_TTL_MS);
        if (fp && fresh('fp:' + fp.toUpperCase())) return true;
        const pfx = v4Prefix16(ip);
        if (pfx && fresh('net:' + pfx)) return true;
        return false;
    }

    //  Forget everything that was ruled out for one country.
    //
    //  A rejection is a real measurement, but it is a measurement of what a
    //  geolocation database said at the time -- and those databases are exactly
    //  what changes when a relay's country becomes correct. So when the user
    //  has asked the app to keep trying one specific country ("wait"), or when
    //  the background watcher is still hunting for the country they originally
    //  chose, the 12-hour memory has to be droppable: otherwise the first round
    //  of rejections would starve the retry and "keep trying" would be a lie.
    //  Only ever called on the country being retried, so nothing learned about
    //  any other country is thrown away.
    clearRejected(cc) {
        if (!this.data.rejected[cc]) return 0;
        const n = Object.keys(this.data.rejected[cc]).length;
        delete this.data.rejected[cc];
        this.save();
        return n;
    }
}

// ════════════════════════════════════════════════════════════════════
//  Live index of exit-capable relays
// ════════════════════════════════════════════════════════════════════
class RelayIndex {
    //  `cacheFile` is optional. Passed one, the index survives app restarts --
    //  and that is not a speed optimisation, it is the point:
    //
    //  fetching this list needs the internet, and before the tunnel exists the
    //  only way to fetch it is IN THE CLEAR. A plain HTTPS request to
    //  onionoo.torproject.org from the user's own address, made every time the
    //  app starts and again every retry, is the most identifying thing this
    //  program does: the destination alone announces "a Tor client is about to
    //  start here", to the ISP and to anyone doing SNI inspection on the way.
    //  A list on disk answers the same question without telling anyone.
    constructor(logger, cacheFile = null) {
        this.log = logger || { debug() {}, info() {}, warn() {} };
        this.byCountry = {};      // cc -> [candidate]
        this.fetchedAt = 0;
        this.file = cacheFile;
        this.fromDisk = false;    // true until the first live refresh replaces it
        if (this.file) this.load();
    }

    //  RECENT ENOUGH TO MAKE A NEGATIVE CLAIM.
    //  "There is no exit relay in Luxembourg" is a statement about the network
    //  right now, and the app shows a dialog on the strength of it. Only a list
    //  fetched minutes ago can support that.
    get isFresh() { return Date.now() - this.fetchedAt < INDEX_FRESH_MS; }

    //  RECENT ENOUGH TO CONNECT WITH -- a much weaker requirement, deliberately.
    //  Every relay taken from here is pinned by fingerprint and then verified
    //  against the geolocation databases before the connect counts as success,
    //  so a stale entry costs one failed circuit and is retried, not trusted.
    //  A relay that has gone away just fails to build. That makes a day-old
    //  list a perfectly good source of candidates -- and using it is what
    //  removes the cleartext fetch from a cold start.
    get isUsable() { return this.countryCount > 0 &&
                            Date.now() - this.fetchedAt < INDEX_USE_MS; }

    get countryCount() { return Object.keys(this.byCountry).length; }
    get relayCount() {
        return Object.values(this.byCountry).reduce((s, l) => s + l.length, 0);
    }

    //  ── Disk cache ──────────────────────────────────────────────────
    //  `fields` is stored and checked. ONIONOO_FIELDS is the list of columns
    //  asked for, and refresh() reads every one of them into a candidate; add a
    //  field and an older cache would silently hand back candidates missing it,
    //  which is the kind of undefined that scores as 0 and quietly reorders the
    //  shortlist. Cheaper to throw the old file away.
    load() {
        try {
            if (!fs.existsSync(this.file)) return;
            const p = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            if (!p || p.fields !== ONIONOO_FIELDS || !p.byCountry) {
                this.log.debug('Relay index cache is from a different query; ignored');
                return;
            }
            const age = Date.now() - (p.fetchedAt || 0);
            //  A number, checked before it is compared. `age` from a string
            //  fetchedAt is NaN, and every comparison against NaN is false --
            //  so both guards below would pass a cache with no usable timestamp
            //  in it at all.
            if (!isNum(p.fetchedAt)) {
                this.log.warn('Relay index cache has no usable fetch time; ignored');
                return;
            }
            //  A cache from the future means the clock moved, not that the file
            //  is good: treat it as unusable rather than valid for a decade.
            if (age < 0 || age > INDEX_USE_MS) {
                this.log.debug('Relay index cache is too old to use ' +
                               `(${Math.round(age / 3600000)} h)`);
                return;
            }
            //  Shape-checked before a single candidate is reachable. Every
            //  fingerprint in this file ends up as `$FP` on the ExitNodes line
            //  of a torrc that an elevated tor.exe reads, and torrc is
            //  line-oriented -- so a newline inside `fp` is not a bad pin, it is
            //  extra configuration. See the validators near the top of this
            //  file. save() cannot produce anything this rejects.
            const why = badByCountry(p.byCountry);
            if (why) {
                this.log.warn('Relay index cache rejected -- it is not what this ' +
                              'app wrote (' + why + '). It will be fetched again.');
                return;
            }
            this.byCountry = p.byCountry;
            this.fetchedAt = p.fetchedAt;
            this.fromDisk  = true;
            this.log.info(`Relay index restored from cache: ${this.relayCount} exits ` +
                          `across ${this.countryCount} countries, ` +
                          `${Math.round(age / 60000)} min old -- no cleartext ` +
                          'request to onionoo needed to connect');
        } catch (e) {
            this.log.warn('Relay index cache unreadable: ' + e.message);
        }
    }

    save() {
        if (!this.file) return;
        try {
            fs.mkdirSync(path.dirname(this.file), { recursive: true });
            fs.writeFileSync(this.file, JSON.stringify({
                fields: ONIONOO_FIELDS,
                fetchedAt: this.fetchedAt,
                byCountry: this.byCountry,
            }), 'utf8');
        } catch (e) {
            this.log.warn('Relay index cache not saved: ' + e.message);
        }
    }

    //  `fetcher` is injected so the same code path works before connecting
    //  (direct request) and while connected (request through Tor's SOCKS
    //  port, because Node's global fetch ignores the Windows proxy).
    async refresh(fetcher) {
        const res = await fetcher(ONIONOO_URL);
        if (!res || res.status !== 200) {
            throw new Error('onionoo HTTP ' + (res ? res.status : 'no response'));
        }
        const json = JSON.parse(res.body);
        const relays = json.relays || [];
        if (!relays.length) throw new Error('onionoo returned no relays');

        const byCountry = {};
        let badExit = 0, badCc = 0;
        for (const r of relays) {
            if (!r.country || !r.fingerprint) continue;
            const cc = String(r.country).toLowerCase();
            //  isCc, not just toLowerCase(). This is the ONE place a country
            //  code enters the app from the network, and from here it becomes a
            //  byCountry key, a row in countryStats(), an entry in the server
            //  dropdown, the argument to the renderer's getFlagImg() -- which
            //  puts it in a title="" attribute -- and part of the file name of
            //  a flag SVG. onionoo's own schema says two-letter ISO 3166-1
            //  alpha-2 and in practice that is what arrives, but "in practice"
            //  is not a check, and every consumer downstream of here treats the
            //  value as already safe. Two letters or the relay is skipped.
            if (!isCc(cc)) { badCc++; continue; }
            const addrs = r.or_addresses || [];
            const v4 = addrs.find(a => !a.startsWith('['));
            if (!v4) continue;                                  // need a v4 ORPort
            const ip = v4.split(':')[0];
            const flags = r.flags || [];

            //  BadExit means the directory authorities have told every client
            //  not to exit through this relay, and Tor obeys them:
            //  choose_good_exit_server_general() skips any node with
            //  is_bad_exit set. onionoo still reports it as a running exit,
            //  so it used to sail straight into the shortlist.
            //
            //  MEASURED, .build/probe-badexit.js, 2026-09-01: 5 relays carry
            //  the flag network-wide, and one of them -- sveahosting -- was
            //  candidate #2 for Sweden. What that costs, per candidate:
            //  SETCONF lands, GETCONF reads the pin back, the consensus says
            //  Running/Exit/Valid/Fast with a policy accepting 80 and 443,
            //  and Tor then spends the full 25 s of waitForExit printing
            //  "No exits in ExitNodes seem to be running: can't choose an
            //  exit" -- after which lockExitCountry blacklists the relay for
            //  12 h as though its COUNTRY had been measured wrong.
            //
            //  The scoring below cannot catch them either: the CAPTCHA term is
            //  a penalty on exit_probability, and a relay nobody is allowed to
            //  exit through has an exit_probability of 0, so it takes no
            //  penalty at all and sorts as if it were clean.
            if (flags.includes('BadExit')) { badExit++; continue; }

            (byCountry[cc] || (byCountry[cc] = [])).push({
                fp: r.fingerprint.toUpperCase(),
                nick: r.nickname || '',
                ip,
                hasV6: addrs.some(a => a.startsWith('[')),
                bw: r.observed_bandwidth || 0,
                exitProb: r.exit_probability || 0,
                fast: flags.includes('Fast'),
                stable: flags.includes('Stable'),
            });
        }

        this.byCountry = byCountry;
        this.fetchedAt = Date.now();
        this.fromDisk  = false;
        const kept = Object.values(byCountry).reduce((s, l) => s + l.length, 0);
        this.log.info(`Exit relay index: ${kept} usable exits across ` +
                      `${Object.keys(byCountry).length} countries` +
                      (badExit ? ` (${badExit} dropped: consensus BadExit)` : '') +
                      (badCc ? ` (${badCc} dropped: country not a two-letter code)` : ''));
        //  Written now rather than at exit: the next start is the one that
        //  benefits, and the app can be killed from the tray or by the
        //  installer at any moment.
        this.save();
        return this;
    }

    //  Shape the renderer already expects from get-realtime-status, but
    //  counting EXIT-capable relays only. Countries with no exit can never
    //  satisfy StrictNodes, so offering them in the dropdown guaranteed a
    //  failed connect -- they are simply not listed any more.
    countryStats() {
        const stats = {};
        for (const [cc, list] of Object.entries(this.byCountry)) {
            stats[cc] = {
                count: list.length,
                bandwidth: list.reduce((s, r) => s + r.bw, 0),
                ipv4Only: list.filter(r => !r.hasV6).length,
                //  How many of them Tor itself considers quick enough to be
                //  worth using. A country whose only exits lack Fast will
                //  connect and then crawl, and the picker can say so.
                fast: list.filter(r => r.fast).length,
            };
        }
        return stats;
    }

    //  How many exits this country has that have not been rejected for
    //  geolocating somewhere else. 0 with a fresh index is the honest
    //  "there is no exit node available in that country" -- which is a
    //  different statement from "the index could not be fetched", and the
    //  caller has to be able to tell them apart before it shows a dialog
    //  about it.
    available(cc, store) {
        return (this.byCountry[cc] || [])
            .filter(r => !store.isRejected(cc, r.fp, r.ip)).length;
    }

    //  Highest-bandwidth relays in the whole index, country ignored.
    //
    //  These are only ever used as the MIDDLE hop of a forced circuit (see
    //  TorControl.forceExitCircuit): when Tor refuses to choose an exit the app
    //  has pinned, the path has to be named in full, and hop 2 has to come from
    //  somewhere. Bandwidth is the right sort key for a middle -- it carries the
    //  traffic and nothing about the user's country or exit depends on it. Every
    //  relay here is already exit-capable, running and not BadExit, because that
    //  is all refresh() keeps.
    fastestRelays(n = 8) {
        return Object.values(this.byCountry).flat()
            .sort((a, b) => b.bw - a.bw)
            .slice(0, n);
    }

    //  Best-first candidate list for a country.

    //
    //  SCORING, and why it is in this order
    //  ------------------------------------
    //  1. No IPv6 address at all: +5000, which no other term can outweigh.
    //     It removes the entire class of "IPv4 says Luxembourg, IPv6 says
    //     Switzerland" mismatch, and being in the right country is not
    //     negotiable against being fast.
    //
    //  2. Measured bandwidth, up to 400 points (1 point per MB/s). This used
    //     to be capped at 200, which made every relay above 200 MB/s tie --
    //     so among the biggest exits the order was arbitrary and the app
    //     could pin a 200 MB/s relay over a 500 MB/s one for no reason. It
    //     is the dominant term below the IPv6 rule now, because throughput
    //     is what "web pages load very slowly" actually measures.
    //
    //  3. Tor's own Fast (+250) and Stable (+120) flags. The directory
    //     authorities award Fast at or above the median measured bandwidth
    //     and Stable above the median uptime, so a relay missing them is
    //     both slow and likely to drop the circuit mid-page. Worth less than
    //     a big bandwidth difference, decisive between similar relays.
    //
    //  4. A PENALTY, up to -180, on the exits carrying the largest share of
    //     all Tor traffic (exit_probability). This is the CAPTCHA term.
    //     Cloudflare, Google and hCaptcha score an address by how much abuse
    //     has come out of it, and the handful of exits that carry several
    //     percent of the network each are the most challenged addresses on
    //     the Tor network -- solving one CAPTCHA after another is what using
    //     them feels like. The penalty is deliberately smaller than the
    //     bandwidth term: it steers the choice towards a fast exit that is
    //     less trodden, and never towards a slow one. It cannot remove
    //     CAPTCHAs, because every exit IP is on public Tor lists either way.
    //  `exclude` is an optional Set of fingerprints the caller has already
    //  failed to build a circuit to during THIS connect. It is deliberately
    //  separate from the reject store: a rejection is a measurement of where a
    //  relay geolocates and is kept for hours, while this is a live fact about
    //  one Tor session and is thrown away with it.
    candidates(cc, store, { limit = 8, exclude = null } = {}) {
        const list = (this.byCountry[cc] || []).filter(r =>
            !store.isRejected(cc, r.fp, r.ip) && !(exclude && exclude.has(r.fp)));
        return list
            .map(r => ({
                ...r,
                score: (r.hasV6 ? 0 : 5000)
                     + Math.min(r.bw / 1e6, 400)
                     + (r.fast ? 250 : 0)
                     + (r.stable ? 120 : 0)
                     - Math.min(r.exitProb * 100, 3) * 60,
            }))
            .sort((a, b) => b.score - a.score)
            .slice(0, limit);
    }
}

// ════════════════════════════════════════════════════════════════════
//  Where does the traffic actually come out?
// ════════════════════════════════════════════════════════════════════
//  Returns { cc, ip, votes, answered } or null when NOTHING answered.
//  The distinction matters: "no source answered" is a transport failure
//  and must never be reported as a confirmed country. That conflation is
//  what let the app claim Luxembourg while exiting in Switzerland.
async function probeExitLocation(socksPort, logger, { timeoutMs = 12000 } = {}) {
    const log = logger || { debug() {}, warn() {} };

    const results = await Promise.allSettled(GEO_SOURCES.map(async src => {
        const res = await socksGet(src.url, { socksPort, timeoutMs });
        if (res.status !== 200) throw new Error(src.name + ' HTTP ' + res.status);
        const { cc, ip } = src.parse(res.body);
        if (!cc || !/^[A-Za-z]{2}$/.test(cc)) throw new Error(src.name + ' no country');
        return { name: src.name, weight: src.weight, cc: cc.toUpperCase(), ip };
    }));

    const votes = {};
    const ips = {};
    let answered = 0;
    results.forEach((r, i) => {
        if (r.status !== 'fulfilled') {
            log.debug(`geo source ${GEO_SOURCES[i].name} failed: ${r.reason.message}`);
            return;
        }
        answered++;
        votes[r.value.cc] = (votes[r.value.cc] || 0) + r.value.weight;
        if (r.value.ip) ips[r.value.ip] = (ips[r.value.ip] || 0) + 1;
        log.debug(`geo source ${r.value.name}: ${r.value.cc} (${r.value.ip || 'no ip'})`);
    });

    if (!answered) return null;

    const cc = Object.entries(votes).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
    const ip = Object.entries(ips).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    return { cc, ip, votes, answered };
}

module.exports = { ExitStore, RelayIndex, probeExitLocation, ONIONOO_URL,
                   ONIONOO_FIELDS, INDEX_FRESH_MS, INDEX_USE_MS, v4Prefix16,
                   //  For .build/probe-relay-cache.js, so the shape rules can be
                   //  tested one field at a time instead of only through a file.
                   badCandidate, badByCountry, badVerified, badRejected,
                   //  For .build/test-engine.js, which asks all four over real
                   //  TLS instead of pinning ipleak.net: that suite failed for a
                   //  day because ipleak's gateway was returning 502, which is
                   //  not a fact about this app. One copy of the list.
                   GEO_SOURCES };
