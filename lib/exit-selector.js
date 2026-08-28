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

//  `flags` is fetched as well as the bandwidth numbers, because Tor's own
//  Fast/Stable flags are the cheapest honest signal there is about whether a
//  relay can actually carry a web page: the directory authorities award Fast to
//  relays at or above the median measured bandwidth and Stable to those with an
//  above-median uptime. Picking an exit without them is how a tunnel ends up
//  technically connected and unusable.
const ONIONOO_FIELDS =
    'fingerprint,nickname,country,or_addresses,observed_bandwidth,exit_probability,flags';
const ONIONOO_URL =
    'https://onionoo.torproject.org/details?type=relay&running=true&flag=Exit&fields=' + ONIONOO_FIELDS;

const REJECT_TTL_MS  = 12 * 60 * 60 * 1000;   // re-test a bad relay after 12 h
const VERIFY_TTL_MS  = 24 * 60 * 60 * 1000;   // re-confirm a good relay daily

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
                this.data = {
                    verified: parsed.verified || {},
                    rejected: parsed.rejected || {},
                };
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
    constructor(logger) {
        this.log = logger || { debug() {}, info() {}, warn() {} };
        this.byCountry = {};      // cc -> [candidate]
        this.fetchedAt = 0;
    }

    get isFresh() { return Date.now() - this.fetchedAt < 15 * 60 * 1000; }
    get countryCount() { return Object.keys(this.byCountry).length; }

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
        for (const r of relays) {
            if (!r.country || !r.fingerprint) continue;
            const cc = r.country.toLowerCase();
            const addrs = r.or_addresses || [];
            const v4 = addrs.find(a => !a.startsWith('['));
            if (!v4) continue;                                  // need a v4 ORPort
            const ip = v4.split(':')[0];
            const flags = r.flags || [];
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
        this.log.info(`Exit relay index: ${relays.length} exits across ${Object.keys(byCountry).length} countries`);
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
    candidates(cc, store, { limit = 8 } = {}) {
        const list = (this.byCountry[cc] || []).filter(r => !store.isRejected(cc, r.fp, r.ip));
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

module.exports = { ExitStore, RelayIndex, probeExitLocation, ONIONOO_URL, v4Prefix16 };
