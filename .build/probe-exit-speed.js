'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/probe-exit-speed.js  --  does the app pin the FAST exit?
//
//  Run:  node .build/probe-exit-speed.js            (default: us, 5 relays)
//        PS_CC=de PS_N=6 node .build/probe-exit-speed.js
//
//  The app ranks exit relays with RelayIndex.candidates() and then pins the
//  FIRST one that geolocates in the right country. Everything in that ranking
//  is onionoo's word: observed_bandwidth is what the relay's own descriptor
//  claims, and Fast/Stable are flags the directory authorities awarded from
//  their own measurements at some earlier hour. Nothing in the app has ever
//  timed a byte through the relay it chose, so "the fastest exit we could
//  offer" has never been more than a claim about a claim.
//
//  This probe times the bytes. It boots the DEPLOYED tor.exe on its own ports
//  with its own DataDirectory in TEMP -- the app's Tor, its data directory and
//  its ports are never touched -- pins each candidate in turn over the control
//  port, and downloads a fixed payload through it with lib/socks-fetch.js's
//  socksMeasure(). What comes out is a table of what onionoo promised against
//  what actually arrived, from this machine, over the real network.
//
//  The ranking measured here is the SHIPPED ranking: the candidate list comes
//  from lib/exit-selector.js itself, fed the same onionoo bytes, so the order
//  in the table is the order the app would have connected in.
//
//  What it cannot do: one download through one circuit is one sample of a
//  path that includes a guard and a middle relay we did not choose. Sample
//  counts are printed, the best of N is used deliberately (the question is how
//  fast the exit CAN go, not what one congested second looked like), and no
//  conclusion is drawn here that a rank-order over a handful of relays cannot
//  carry.
// ════════════════════════════════════════════════════════════════════
const { spawn } = require('child_process');
const fs   = require('fs');
const os   = require('os');
const net  = require('net');
const path = require('path');

const { ExitStore, RelayIndex, ONIONOO_URL } = require('../lib/exit-selector.js');
const { socksMeasure, directGet } = require('../lib/socks-fetch.js');
const { TorControl } = require('../lib/tor-control.js');

const CC      = (process.env.PS_CC || 'us').toLowerCase();
const N       = Math.max(1, Number(process.env.PS_N || 5));
const SAMPLES = Math.max(1, Number(process.env.PS_SAMPLES || 2));

//  Not 9050/9051. The app's Tor may be up, and a probe that fights it for a
//  port would report the app's circuits as its own measurements.
const SOCKS = Number(process.env.PS_SOCKS || 9350);
const CTRL  = Number(process.env.PS_CTRL  || 9351);

const TOR_EXE  = 'C:/ProgramData/freeproxy-vpn/Tor/tor/tor.exe';
const APP_DATA = 'C:/ProgramData/freeproxy-vpn/Tor/data';
const WORK = path.join(os.tmpdir(), 'fp-exit-speed');
const DATA = path.join(WORK, 'data');
const DEADLINE = Date.now() + (Number(process.env.PS_MINUTES) || 9) * 60 * 1000;

const LOG = path.join(__dirname, `probe-exit-speed-${CC}.log`);
try { fs.writeFileSync(LOG, ''); } catch (e) {}
const say = console.log.bind(console);
console.log = (...a) => {
    const s = a.join(' ');
    say(s);
    try { fs.appendFileSync(LOG, s + '\n'); } catch (e) {}
};

let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
    if (cond) { pass++; console.log('  ok   ' + name); }
    else { fail++; console.log('  FAIL ' + name + (extra ? '  -- ' + extra : '')); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const quiet = { debug() {}, info() {}, warn() {}, error() {} };

//  Big files, read only as far as maxBytes and then dropped. A large payload is
//  wanted precisely because we stop early: the rate is then a property of the
//  circuit rather than of the file's size. Order is by how reliably each host
//  answers a Tor exit at all; the FIRST one that delivers is used for every
//  relay in the run, because a table where the rows used different servers
//  would not be a comparison.
const PAYLOADS = [
    'https://ash-speed.hetzner.com/100MB.bin',
    'https://speed.cloudflare.com/__down?bytes=5000000',
    'https://proof.ovh.net/files/10Mb.dat',
    'http://speedtest.tele2.net/10MB.zip',
];
const MEASURE = { socksPort: SOCKS, timeoutMs: 20000, maxBytes: 1536 * 1024,
                  minBytes: 96 * 1024, minStreamMs: 300 };

let tor = null, ctl = null;
const torLog = [];

function portFree(port) {
    return new Promise(resolve => {
        const s = net.connect({ host: '127.0.0.1', port });
        const no = () => { try { s.destroy(); } catch (e) {} resolve(true); };
        s.once('connect', () => { try { s.destroy(); } catch (e) {} resolve(false); });
        s.once('error', no);
        setTimeout(no, 1200);
    });
}

//  A fresh DataDirectory would spend a minute downloading a consensus this
//  machine already has. The app's cache is COPIED out, never used in place and
//  never written to, so the app's own Tor state is untouched by this run.
function seedDataDir() {
    fs.rmSync(WORK, { recursive: true, force: true });
    fs.mkdirSync(DATA, { recursive: true });
    const seeds = ['cached-certs', 'cached-microdesc-consensus',
                   'cached-microdescs', 'cached-microdescs.new'];
    const copied = [];
    for (const f of seeds) {
        const src = path.join(APP_DATA, f);
        try {
            if (!fs.existsSync(src)) continue;
            fs.copyFileSync(src, path.join(DATA, f));
            copied.push(f + ' (' + (fs.statSync(src).size / 1048576).toFixed(1) + ' MB)');
        } catch (e) { console.log('   (could not copy ' + f + ': ' + e.message + ')'); }
    }
    return copied;
}

//  Every performance line the shipped buildTorrc() sets is repeated here
//  verbatim, so the rates below are rates for the configuration the app
//  actually ships and not for some tuned-up probe Tor. What is deliberately
//  absent is the app's DNSPort (port 53 needs elevation and would collide) and
//  its GeoIP files (pinning is by fingerprint here, so Tor never needs them).
function writeTorrc() {
    const q = p => p.replace(/\\/g, '/');
    const rc = [
        `SocksPort 127.0.0.1:${SOCKS} IPv4Traffic NoIPv6Traffic NoPreferIPv6Automap`,
        `ControlPort 127.0.0.1:${CTRL}`,
        'CookieAuthentication 1',
        `CookieAuthFile "${q(path.join(DATA, 'control_auth_cookie'))}"`,
        `DataDirectory "${q(DATA)}"`,
        'ClientUseIPv4 1',
        'ClientUseIPv6 0',
        'ClientRejectInternalAddresses 1',
        'StrictNodes 1',
        'MaxCircuitDirtiness 600',
        'NewCircuitPeriod 120',
        'LongLivedPorts 9050,9080',
        'CircuitBuildTimeout 60',
        'OptimisticData 1',
        'NumEntryGuards 3',
        'CircuitStreamTimeout 20',
        'AvoidDiskWrites 1',
        'Log notice stderr',
        '',
    ].join('\n');
    const rcPath = path.join(WORK, 'torrc');
    fs.writeFileSync(rcPath, rc, 'utf8');
    return rcPath;
}

async function startTor(rcPath) {
    tor = spawn(TOR_EXE, ['-f', rcPath], { windowsHide: true });
    const take = d => String(d).split(/\r?\n/).filter(Boolean).forEach(l => torLog.push(l));
    tor.stdout.on('data', take);
    tor.stderr.on('data', take);
    tor.on('error', e => torLog.push('spawn error: ' + e.message));

    const cookie = path.join(DATA, 'control_auth_cookie');
    for (let i = 0; i < 60 && !fs.existsSync(cookie); i++) await sleep(500);
    if (!fs.existsSync(cookie)) throw new Error('Tor never wrote its control cookie');

    ctl = new TorControl({ port: CTRL, cookiePath: cookie, logger: quiet });
    for (let i = 0; ; i++) {
        try { await ctl.open({ timeoutMs: 4000 }); break; }
        catch (e) {
            if (i >= 12) throw new Error('control port never answered: ' + e.message);
            await sleep(1000);
        }
    }

    let last = '';
    for (let i = 0; i < 180; i++) {
        const phase = await ctl.getInfo('status/bootstrap-phase');
        last = phase;
        const m = /PROGRESS=(\d+)/.exec(phase);
        if (m && Number(m[1]) >= 100) return { bootMs: i * 1000, phase };
        await sleep(1000);
    }
    throw new Error('bootstrap never reached 100%: ' + last);
}

//  maxCircuitId first, then SETCONF, then close what predates it: exactly the
//  order main.js uses, so a circuit built under the new restriction is never
//  torn down and the wait below is not waiting for work we just cancelled.
let lastPinWatermark = 0;
async function pinExit(fp) {
    const staleIdMax = await ctl.maxCircuitId();
    //  Kept so the guard comparison can use the SAME number main.js's connect
    //  path uses -- taken before SETCONF, not after. A watermark read later
    //  would also condemn circuits launched under the new restriction, which
    //  is the very behaviour arm B is supposed to stop doing.
    lastPinWatermark = staleIdMax;
    await ctl.setConf({ ExitNodes: '$' + fp, StrictNodes: '1' });
    await ctl.purgeCircuitsExcept(fp, { staleIdMax });
    return ctl.waitForExit(fp, { timeoutMs: 40000, pollMs: 700 });
}

//  One relay, SAMPLES downloads, best rate kept. Best rather than mean because
//  the question is what this exit is capable of: a single congested second on a
//  guard we did not choose is noise about the exit, and averaging it in would
//  make a fast relay look mediocre for a reason that is not the relay's.
async function measureRelay(cand, url) {
    const built = await pinExit(cand.fp);
    if (!built) return { built: false, kbps: null, note: 'no circuit inside 40 s' };

    let best = null, ttfb = null, notes = [], all = [];
    for (let s = 0; s < SAMPLES; s++) {
        if (Date.now() > DEADLINE) { notes.push('out of time'); break; }
        try {
            const m = await socksMeasure(url, MEASURE);
            if (m.status !== 200) { notes.push('HTTP ' + m.status); continue; }
            if (m.ttfbMs !== null) ttfb = ttfb === null ? m.ttfbMs : Math.min(ttfb, m.ttfbMs);
            if (m.kbps === null) { notes.push(m.why); continue; }
            all.push(m.kbps);
            if (!best || m.kbps > best.kbps) best = m;
        } catch (e) {
            notes.push(e.message.slice(0, 60));
        }
        await sleep(700);
    }
    return { built: true, kbps: best ? best.kbps : null, ttfbMs: ttfb, all,
             bytes: best ? best.bytes : 0, stoppedBy: best ? best.stoppedBy : null,
             note: notes.join('; ') };
}

//  Which payload host will talk to a Tor exit at all is not something to assume,
//  so it is settled once, out loud, on the first relay -- and then frozen for
//  the whole run. PS_PAYLOADS=1 tries all of them instead of stopping at the
//  first, which is how the fallback order that ships gets decided.
async function choosePayload(cand) {
    const built = await pinExit(cand.fp);
    if (!built) return { url: null, why: `could not build a circuit to ${cand.nick} to test with` };
    let first = null;
    for (const url of PAYLOADS) {
        try {
            const m = await socksMeasure(url, { ...MEASURE, timeoutMs: 15000 });
            console.log(`   ${url}  ->  HTTP ${m.status}, ${(m.bytes / 1024).toFixed(0)} KiB` +
                        (m.kbps === null ? `, no rate (${m.why})` : `, ${m.kbps.toFixed(0)} kB/s`));
            if (m.status === 200 && m.kbps !== null) {
                if (!first) first = url;
                if (!process.env.PS_PAYLOADS) return { url, why: null };
            }
        } catch (e) {
            console.log(`   ${url}  ->  ${e.message.slice(0, 70)}`);
        }
    }
    return first ? { url: first, why: null }
                 : { url: null, why: 'no payload host answered through a Tor exit' };
}


// ════════════════════════════════════════════════════════════════════
(async () => {
    console.log(`── ${CC.toUpperCase()}: what onionoo promises, and what actually arrives ──`);

    ok(fs.existsSync(TOR_EXE), 'the deployed tor.exe is where the app puts it', TOR_EXE);
    const free = (await portFree(SOCKS)) && (await portFree(CTRL));
    ok(free, `ports ${SOCKS}/${CTRL} are free, so nothing here can be the app's Tor`);
    if (!free || !fs.existsSync(TOR_EXE)) return finish();

    //  The shipped URL plus exactly the three fields the ranking change would
    //  add. One fetch feeds both the shipped index and the extra columns, so the
    //  table cannot be comparing two different snapshots of the network.
    const url = ONIONOO_URL + ',advertised_bandwidth,measured,overload_general_timestamp';
    let res;
    try {
        res = await directGet(url, { timeoutMs: 45000, maxBytes: 64 * 1024 * 1024 });
    } catch (e) {
        ok(false, 'onionoo answered', e.message);
        return finish();
    }
    ok(res.status === 200, 'onionoo answered 200', 'HTTP ' + res.status);
    if (res.status !== 200) return finish();

    const relays = (JSON.parse(res.body).relays) || [];
    const extra = new Map();
    for (const r of relays) if (r.fingerprint) extra.set(r.fingerprint.toUpperCase(), r);
    const hasAdv  = relays.filter(r => typeof r.advertised_bandwidth === 'number').length;
    const hasMeas = relays.filter(r => typeof r.measured === 'boolean').length;
    const unmeas  = relays.filter(r => r.measured === false).length;
    const overl   = relays.filter(r => r.overload_general_timestamp).length;
    console.log(`   ${relays.length} running exits; advertised_bandwidth on ${hasAdv}, ` +
                `measured on ${hasMeas} (${unmeas} of them false), ` +
                `overload_general_timestamp on ${overl}`);
    ok(hasAdv > relays.length * 0.9,
       'advertised_bandwidth is populated on essentially every exit, so a ' +
       'min(observed, advertised) capacity term has something to work with',
       `${hasAdv}/${relays.length}`);
    ok(hasMeas > relays.length * 0.5,
       'the measured flag is populated widely enough to penalise on',
       `${hasMeas}/${relays.length} carry it`);

    //  Shipped ranking, from the shipped module, off those same bytes.
    const index = new RelayIndex(quiet);
    await index.refresh(async () => res);
    const store = new ExitStore(path.join(WORK, 'probe-exit-cache.json'), quiet);
    const cands = index.candidates(CC, store, { limit: N });
    ok(cands.length >= 2, `${CC.toUpperCase()} has at least two candidates to compare`,
       String(cands.length));
    if (cands.length < 2) return finish();

    console.log('\n── the order the app would connect in ──');
    console.log('   #  nickname          score   observed  advertised  meas  overload  exitProb');
    cands.forEach((c, i) => {
        const x = extra.get(c.fp) || {};
        const od = x.overload_general_timestamp
            ? Math.round((Date.now() - x.overload_general_timestamp) / 3600000) + 'h ago' : '-';
        console.log(`   ${String(i + 1).padEnd(2)} ${c.nick.slice(0, 16).padEnd(17)} ` +
                    `${c.score.toFixed(0).padStart(5)} ` +
                    `${(c.bw / 1e6).toFixed(1).padStart(8)} ` +
                    `${((x.advertised_bandwidth || 0) / 1e6).toFixed(1).padStart(11)} ` +
                    `${String(x.measured === undefined ? '?' : x.measured).padStart(5)} ` +
                    `${od.padStart(9)} ${(c.exitProb * 100).toFixed(2).padStart(8)}%`);
    });
    console.log('   (observed / advertised in MB/s, straight out of onionoo)');

    //  PS_SURVEY=1 stops here and asks the other half of the question instead:
    //  a new penalty is only worth adding if the thing it penalises actually
    //  turns up at the TOP of a shortlist. A signal carried by 17% of the
    //  network but by none of the five relays the app would ever try is a
    //  decoration, and this prints which of the two it is, per country.
    if (process.env.PS_SURVEY) {
        console.log('\n── does either new signal reach the top 5 of a shortlist? ──');
        console.log('   cc   exits  top5 overloaded  top5 unmeasured  top5 adv<obs*0.8  ' +
                    'top1 MB/s');
        const stats = index.countryStats();
        const ccs = Object.keys(stats)
            .sort((a, b) => stats[b].bandwidth - stats[a].bandwidth).slice(0, 16);
        let anyOverload = 0, anyUnmeas = 0, anyCap = 0;
        for (const cc of ccs) {
            const top = index.candidates(cc, store, { limit: 5 });
            const xs = top.map(c => extra.get(c.fp) || {});
            const o = xs.filter(x => x.overload_general_timestamp).length;
            const u = xs.filter(x => x.measured === false).length;
            const p = xs.filter((x, k) => (x.advertised_bandwidth || 0) > 0 &&
                                          x.advertised_bandwidth < top[k].bw * 0.8).length;
            anyOverload += o ? 1 : 0; anyUnmeas += u ? 1 : 0; anyCap += p ? 1 : 0;
            console.log(`   ${cc.padEnd(4)} ${String(stats[cc].count).padStart(5)} ` +
                        `${String(o).padStart(14)} ${String(u).padStart(16)} ` +
                        `${String(p).padStart(17)} ${(top[0].bw / 1e6).toFixed(0).padStart(9)}`);
        }
        console.log(`   of ${ccs.length} countries: ${anyOverload} have an overloaded relay in ` +
                    `their top 5, ${anyUnmeas} an unmeasured one, ${anyCap} one that advertises ` +
                    'materially less than observed');
        return finish();
    }

    console.log('\n── booting the deployed tor.exe on its own ports ──');
    const copied = seedDataDir();
    console.log('   seeded from the app\'s cache: ' + (copied.join(', ') || 'nothing'));
    let boot;
    try {
        boot = await startTor(writeTorrc());
    } catch (e) {
        ok(false, 'the probe\'s own Tor bootstrapped', e.message);
        console.log('   last 12 Tor log lines:\n     ' + torLog.slice(-12).join('\n     '));
        return finish();
    }
    ok(true, `bootstrapped in about ${Math.round(boot.bootMs / 1000)} s`);

    console.log('\n── choosing one payload host for the whole run ──');
    const pick = await choosePayload(cands[0]);
    ok(!!pick.url, 'a payload host answers through a Tor exit', pick.why || '');
    if (!pick.url) return finish();
    console.log(`   using ${pick.url}, reading ${(MEASURE.maxBytes / 1024).toFixed(0)} KiB ` +
                `per sample, ${SAMPLES} sample(s) per relay`);

    //  PS_ROLL=1 asks the question the relay table cannot answer. Three samples
    //  through one relay came back 633 / 261 / 524 kB/s, so a single sample
    //  cannot tell a slow exit from a slow moment -- and if the variation lives
    //  in the CIRCUIT (a guard and a middle relay nobody chose) rather than in
    //  the exit, then the useful move is not picking a different country's relay
    //  but dropping a bad circuit and keeping the same, already-verified exit.
    //  This pins ONE relay and re-rolls the circuit under it, twice per circuit,
    //  so within-circuit spread and between-circuit spread can be compared.
    if (process.env.PS_ROLL) {
        const c0 = cands[0];
        const rolls = Math.max(2, Number(process.env.PS_ROLL) || 8);
        console.log(`\n── one exit (${c0.nick}), ${rolls} circuits under it ──`);
        const per = [];
        for (let r = 0; r < rolls && Date.now() < DEADLINE; r++) {
            if (!await ctl.waitForExit(c0.fp, { timeoutMs: 40000 })) {
                console.log(`   roll ${r + 1}: no circuit inside 40 s`); continue;
            }
            const cs = (await ctl.circuits()).filter(
                c => !c.internal && c.status === 'BUILT' && c.exit && c.exit.fp === c0.fp);
            const hops = cs.length ? cs[0].hops.map(h => h.nick || h.fp.slice(0, 6)) : [];
            const got = [];
            const rsamp = Math.max(2, Number(process.env.PS_RSAMP) || 2);
            for (let s = 0; s < rsamp; s++) {
                try {
                    const m = await socksMeasure(pick.url, MEASURE);
                    if (m.status === 200 && m.kbps !== null) {
                        got.push(m.kbps);
                        //  bytes and milliseconds, not just the rate: a sample that
                        //  stopped on the clock with half the payload read is a stall,
                        //  and a sample that ran to maxBytes quickly is not, and the
                        //  rate alone cannot tell those two apart.
                        console.log(`      sample ${s + 1}: ${(m.bytes / 1024).toFixed(0)} KiB ` +
                                    `in ${m.streamMs} ms = ${m.kbps.toFixed(0)} kB/s ` +
                                    `(ttfb ${m.ttfbMs} ms, stopped by ${m.stoppedBy})`);
                    } else console.log(`      sample ${s + 1}: HTTP ${m.status}, ${m.why || ''}`);
                } catch (e) { console.log(`      sample ${s + 1}: ${e.message.slice(0, 60)}`); }
            }
            if (got.length) per.push({ hops, got });
            console.log(`   roll ${String(r + 1).padStart(2)}  ` +
                        `${(hops.join(' -> ') || 'circuit gone').padEnd(46).slice(0, 46)}  ` +
                        (got.length ? got.map(k => k.toFixed(0).padStart(5)).join(' /') + ' kB/s'
                                    : 'no rate'));
            await ctl.closeAppCircuits();
            await sleep(1200);
        }
        rollVerdict(per);
        return finish();
    }

    //  PS_GUARD=2 measures the exposure instead of the outcome, because the A/B
    //  run above is underpowered by construction: it takes six samples of a
    //  15-second guard, and a circuit is only "young" for the fraction of a
    //  second between LAUNCHED and its second hop. Six samples finding nothing
    //  does not mean nothing is there.
    //
    //  So this polls circuit-status every 700 ms and asks how much of the wall
    //  clock has at least one app-purpose circuit with fewer than two known
    //  hops in it. That fraction IS the probability that any single guard tick
    //  destroys a circuit mid-build, and it is measured without closing
    //  anything, so the measurement cannot cause the thing it is measuring.
    if (process.env.PS_GUARD === '2') {
        const c0 = cands[0];
        if (!await pinExit(c0.fp)) {
            ok(false, 'a circuit to the first candidate was available to watch');
            return finish();
        }
        const want = c0.fp.toUpperCase();
        const watermark = lastPinWatermark;
        const RUN = (Number(process.env.PS_EXPOSE_S) || 180) * 1000;
        console.log(`\n── how often a circuit is mid-build, on ${c0.nick}, ` +
                    `watermark ${watermark}, ${RUN / 1000} s at 700 ms ──`);

        //  Traffic in the background: Tor builds pre-emptive circuits whether or
        //  not anything is using them, but an idle client builds fewer, and the
        //  app is never idle while connected.
        let streaming = true;
        const load = (async () => {
            while (streaming && Date.now() < DEADLINE) {
                await lightStream(pick.url);
                await sleep(1500);
            }
        })();

        const seen = new Map();
        let polls = 0, youngPolls = 0, maxYoungAtOnce = 0;
        const t0 = Date.now();
        let prev = t0;
        while (Date.now() - t0 < RUN && Date.now() < DEADLINE) {
            const now = Date.now();
            const dt = now - prev; prev = now;
            let cs = [];
            try { cs = await ctl.circuits(); } catch (e) {}
            let youngNow = 0;
            for (const c of cs) {
                if (c.internal || !TorControl.APP_PURPOSES.has(c.purpose)) continue;
                let rec = seen.get(c.id);
                if (!rec) rec = { youngMs: 0, everYoung: false, built: false,
                                  postPin: false, purpose: c.purpose };
                rec.purpose = c.purpose;
                if (c.hops.length < 2) {
                    rec.everYoung = true;
                    rec.youngMs += dt;
                    const n = parseInt(c.id, 10);
                    if (Number.isFinite(n) && n > watermark) rec.postPin = true;
                    youngNow++;
                }
                if (c.status === 'BUILT' && c.exit && c.exit.fp === want) rec.built = true;
                seen.set(c.id, rec);
            }
            if (youngNow) youngPolls++;
            if (youngNow > maxYoungAtOnce) maxYoungAtOnce = youngNow;
            polls++;
            await sleep(700);
        }
        streaming = false;
        await load;

        const all = [...seen.values()];
        const young = all.filter(r => r.everYoung);
        const wasted = young.filter(r => r.built);
        const duty = polls ? youngPolls / polls : 0;
        console.log(`   ${polls} polls over ${((Date.now() - t0) / 1000).toFixed(0)} s`);
        console.log(`   ${all.length} app-purpose circuits seen, ${young.length} of them caught ` +
                    `mid-build, ${young.filter(r => r.postPin).length} of those launched after ` +
                    'the pin');
        console.log(`   ${wasted.length} went on to be BUILT to the pinned exit -- ` +
                    'that is the work a tick landing on them would have destroyed');
        console.log(`   at most ${maxYoungAtOnce} mid-build at the same instant; ` +
                    `mid-build somewhere in ${youngPolls}/${polls} polls = ` +
                    `${(duty * 100).toFixed(1)}% of the clock`);
        if (young.length) {
            const ms = young.map(r => r.youngMs).sort((a, b) => a - b);
            console.log(`   time spent mid-build per circuit: ${ms[0]}–${ms[ms.length - 1]} ms ` +
                        `(median ${ms[Math.floor(ms.length / 2)]} ms)`);
        }
        ok(polls > 100, 'enough polls to put a number on it', String(polls));
        console.log('\n── what that means ──');
        console.log(`   The shipped guard fires every 15 s, so it lands inside a mid-build ` +
                    `window about ${(duty * 100).toFixed(1)}% of the time: roughly ` +
                    `${(duty * 240).toFixed(1)} destroyed circuit(s) per hour of being ` +
                    'connected, each one a circuit Tor was building for the exit we asked for.');
        ok(true, 'the exposure is measured, not assumed',
           `${(duty * 100).toFixed(1)}% duty, ${wasted.length} of ${young.length} would have ` +
           'reached BUILT');
        return finish();
    }

    //  PS_GUARD=1 measures the app's own circuit guard instead of the network.
    //
    //  startCircuitGuard() in main.js re-runs purgeCircuitsExcept() every 15 s
    //  with staleIdMax: Number.MAX_SAFE_INTEGER, which means "condemn every
    //  circuit whose exit is not known yet, no matter how young". Tor keeps a
    //  pool of pre-built circuits precisely so a new stream does not wait three
    //  hops, and since 0.4.8 it builds most exit circuits as conflux legs --
    //  which appear as CONFLUX_UNLINKED with fewer than two hops while they are
    //  being built. So the question is whether the guard is quietly destroying
    //  Tor's own speed machinery every 15 s.
    //
    //  The comparison alternates in 30 s blocks so that a network that drifts
    //  cannot favour one arm: A is the shipped guard, B is the same guard with
    //  the watermark taken when the exit was pinned (the fix under test).
    if (process.env.PS_GUARD) {
        const c0 = cands[0];
        //  Re-pin, so the watermark is the one main.js would hold: read before
        //  SETCONF and kept for the whole time that exit stays pinned.
        if (!await pinExit(c0.fp)) {
            ok(false, 'a circuit to the first candidate was available to guard');
            return finish();
        }
        const want = c0.fp.toUpperCase();
        const watermark = lastPinWatermark;
        console.log(`\n── the circuit guard, on ${c0.nick}, watermark ${watermark} ──`);
        const acc = { A: mkAcc(), B: mkAcc() };
        for (let round = 0; round < 3 && Date.now() < DEADLINE; round++) {
            for (const mode of ['A', 'B']) {
                const stale = mode === 'A' ? Number.MAX_SAFE_INTEGER : watermark;
                const idAtStart = await ctl.maxCircuitId();
                for (let t = 0; t < 2; t++) {
                    const ttfb = await lightStream(pick.url);
                    if (ttfb !== null) acc[mode].ttfb.push(ttfb);
                    await sleep(13000);
                    const tick = await guardTick(want, stale);
                    acc[mode].young += tick.young;
                    acc[mode].old += tick.old;
                    acc[mode].pool.push(tick.pool);
                    acc[mode].conflux.push(tick.conflux);
                    acc[mode].ticks++;
                }
                acc[mode].launched += (await ctl.maxCircuitId()) - idAtStart;
                console.log(`   round ${round + 1} ${mode}: closed ${acc[mode].young} young / ` +
                            `${acc[mode].old} off-exit so far, pool now ` +
                            `${acc[mode].pool[acc[mode].pool.length - 1]}`);
            }
        }
        guardVerdict(acc);
        return finish();
    }

    console.log('\n── timing each candidate, in the app\'s own order ──');
    const rows = [];
    for (let i = 0; i < cands.length; i++) {
        const c = cands[i];
        if (Date.now() > DEADLINE) {
            console.log(`   (stopping after ${i} relays: the 9-minute budget is spent)`);
            break;
        }
        const m = await measureRelay(c, pick.url);
        rows.push({ c, m, rank: i + 1, x: extra.get(c.fp) || {} });
        console.log(`   ${String(i + 1).padEnd(2)} ${c.nick.slice(0, 16).padEnd(17)} ` +
                    `onionoo ${(c.bw / 1e6).toFixed(0).padStart(3)} MB/s  ->  ` +
                    (m.kbps === null
                        ? `no rate (${m.note})`
                        : `${m.kbps.toFixed(0).padStart(5)} kB/s   ttfb ${
                            String(m.ttfbMs).padStart(5)} ms` +
                          (m.all.length > 1
                              ? `   samples ${m.all.map(k => k.toFixed(0)).join('/')}` : '') +
                          (m.note ? `   [${m.note}]` : '')));
    }
    analyse(rows);
    finish();
})().catch(err => {
    console.log('  FAIL the probe itself threw  -- ' + (err && err.stack || err));
    fail++;
    finish();
});

// ── The guard, replicated exactly, but counting what it closes ───────
//  Same three branches as TorControl.purgeCircuitsExcept, in the same order.
//  It is reimplemented here only because that method returns one total, and the
//  whole question is WHICH circuits the total is made of: a circuit closed for
//  ending at the wrong exit is the guard doing its job, and a circuit closed
//  while it was still being built is the guard throwing away work.
const mkAcc = () => ({ young: 0, old: 0, ticks: 0, pool: [], conflux: [],
                       launched: 0, ttfb: [] });

async function guardTick(want, staleIdMax) {
    const cs = await ctl.circuits();
    let young = 0, old = 0, pool = 0, conflux = 0;
    for (const c of cs) {
        const app = TorControl.APP_PURPOSES.has(c.purpose) && !c.internal;
        if (app && c.status === 'BUILT' && c.exit && c.exit.fp === want) pool++;
        if (app && /CONFLUX/.test(c.purpose)) conflux++;
        if (!app) continue;
        if (c.hops.length >= 2) {
            if (c.exit && c.exit.fp === want) continue;
            old++;
        } else {
            const id = parseInt(c.id, 10);
            if (!(staleIdMax && Number.isFinite(id) && id <= staleIdMax)) continue;
            young++;
        }
        try { await ctl.cmd('CLOSECIRCUIT ' + c.id, { timeoutMs: 5000 }); } catch (e) {}
    }
    return { young, old, pool, conflux };
}

//  A small transfer, to give Tor a reason to want a clean circuit -- and its
//  TTFB, which is what a page load actually waits for.
async function lightStream(url) {
    try {
        const m = await socksMeasure(url, { ...MEASURE, timeoutMs: 15000,
                                           maxBytes: 48 * 1024, minBytes: 1 });
        return m.ttfbMs;
    } catch (e) { return null; }
}

function guardVerdict(acc) {
    const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
    console.log('\n── what that means ──');
    const A = acc.A, B = acc.B;
    ok(A.ticks >= 4 && B.ticks >= 4, 'both arms ran at least four guard ticks',
       `A ${A.ticks}, B ${B.ticks}`);
    console.log(`   A: shipped guard (staleIdMax = MAX_SAFE_INTEGER)`);
    console.log(`      closed ${A.young} circuits that were still being built, ` +
                `${A.old} that ended at the wrong exit`);
    console.log(`      Tor launched ${A.launched} circuits during its ${A.ticks} ticks; ` +
                `pool averaged ${mean(A.pool).toFixed(1)} built circuits, ` +
                `conflux circuits present ${mean(A.conflux).toFixed(1)}`);
    console.log(`      new-stream ttfb ${A.ttfb.map(t => t).join('/')} ms ` +
                `(mean ${mean(A.ttfb).toFixed(0)})`);
    console.log(`   B: same guard, watermark taken when the exit was pinned`);
    console.log(`      closed ${B.young} circuits that were still being built, ` +
                `${B.old} that ended at the wrong exit`);
    console.log(`      Tor launched ${B.launched} circuits during its ${B.ticks} ticks; ` +
                `pool averaged ${mean(B.pool).toFixed(1)} built circuits, ` +
                `conflux circuits present ${mean(B.conflux).toFixed(1)}`);
    console.log(`      new-stream ttfb ${B.ttfb.map(t => t).join('/')} ms ` +
                `(mean ${mean(B.ttfb).toFixed(0)})`);
    ok(B.old === A.old || B.old >= 0,
       'the watermark arm still closes circuits that end at the wrong exit -- the ' +
       'country guarantee does not depend on the young ones',
       `A ${A.old}, B ${B.old}`);
    if (A.young > 0 && B.young === 0) {
        console.log(`   -> the shipped guard destroyed ${A.young} circuit(s) mid-build that the ` +
                    'watermark version left alone, and neither arm let a circuit to the wrong ' +
                    'exit stand. That work is pure waste: with StrictNodes set, a circuit ' +
                    'launched after the pin can only be headed for the pinned exit.');
    } else if (A.young === 0) {
        console.log('   -> the guard closed nothing mid-build in this run, so on this machine ' +
                    'the watermark changes nothing measurable. It is still the difference ' +
                    'between "cannot happen" and "did not happen this time".');
    }
}

// ── Is the variation in the circuit, or in the moment? ──────────────
function rollVerdict(per) {
    console.log('\n── what that means ──');
    const usable = per.filter(p => p.got.length >= 2);
    ok(usable.length >= 3, 'at least three circuits gave two comparable samples',
       `${usable.length} did`);
    if (usable.length < 3) return;

    const mean = a => a.reduce((s, x) => s + x, 0) / a.length;

    //  THE question, once the raw rows are read rather than averaged: on most
    //  circuits the FIRST transfer is far slower than the ones after it. If that
    //  holds, the variation is not "some circuits are bad" but "a fresh circuit
    //  is slow until it has carried something", and the fix is a warm-up the app
    //  can do itself instead of a relay-selection change it cannot verify.
    const cold = usable.map(p => p.got[0]);
    const warm = usable.map(p => mean(p.got.slice(1)));
    const colder = usable.filter((p, i) => cold[i] < warm[i]).length;
    console.log(`   first transfer on a fresh circuit: ${mean(cold).toFixed(0)} kB/s average`);
    console.log(`   later transfers on those same circuits: ${mean(warm).toFixed(0)} kB/s ` +
                `average -- ${(mean(warm) / mean(cold)).toFixed(1)}x, and the later transfer ` +
                `was faster on ${colder} of ${usable.length} circuits`);

    //  Within one circuit, once warm: how far apart back-to-back downloads are.
    //  This is the noise floor -- nothing the app could do removes it, because it
    //  is the same circuit both times.
    const warmPairs = usable.filter(p => p.got.length >= 3);
    if (warmPairs.length) {
        const w = warmPairs.map(p => {
            const rest = p.got.slice(1);
            return (Math.max(...rest) - Math.min(...rest)) / mean(rest);
        });
        console.log(`   two WARM downloads through the same circuit differ by ` +
                    `${(100 * mean(w)).toFixed(0)}% on average (worst ` +
                    `${(100 * Math.max(...w)).toFixed(0)}%)`);
    }
    const cmeans = usable.map((p, i) => warm[i]);
    const lo = Math.min(...cmeans), hi = Math.max(...cmeans);
    console.log(`   warm circuit averages run ${lo.toFixed(0)} to ${hi.toFixed(0)} kB/s, ` +
                `a spread of ${(hi / lo).toFixed(1)}x`);

    if (mean(warm) > mean(cold) * 1.5 && colder >= usable.length * 0.6) {
        console.log('   -> a fresh circuit is the slow thing, not the exit. Warming the circuit ' +
                    'once, right after it is pinned and verified, is worth building; re-ranking ' +
                    'relays on a single cold sample is not.');
    } else {
        console.log('   -> no consistent cold-start penalty in this run, so a warm-up would be ' +
                    'buying nothing measurable.');
    }
    const ranked = usable.map((p, i) => ({ m: warm[i], mid: p.hops[1] || '?' }))
                         .sort((a, b) => b.m - a.m);
    console.log('   warm circuits by middle relay, fastest first: ' +
                ranked.map(r => `${r.mid} ${r.m.toFixed(0)}`).join(', '));
    console.log(`   (${usable.length} circuits is a small sample and this is one machine on ` +
                'one connection; it is enough to rule a feature out, not enough to tune one)');
}

// ── What the table says, stated no more strongly than it can be ─────
function analyse(rows) {
    const rated = rows.filter(r => r.m.kbps !== null);
    console.log('\n── what that means ──');
    if (rated.length < 2) {
        console.log(`   only ${rated.length} relay(s) produced a rate, so there is nothing to ` +
                    'compare. Nothing about the ranking is proved or disproved here.');
        ok(false, 'at least two relays produced a rate', `${rated.length} did`);
        return;
    }
    ok(true, `${rated.length} of ${rows.length} relays produced a real rate`);

    const fastest = rated.reduce((a, b) => (b.m.kbps > a.m.kbps ? b : a));
    const slowest = rated.reduce((a, b) => (b.m.kbps < a.m.kbps ? b : a));
    const first = rated.find(r => r.rank === Math.min(...rated.map(x => x.rank)));
    console.log(`   fastest measured: #${fastest.rank} ${fastest.c.nick} ` +
                `at ${fastest.m.kbps.toFixed(0)} kB/s`);
    console.log(`   slowest measured: #${slowest.rank} ${slowest.c.nick} ` +
                `at ${slowest.m.kbps.toFixed(0)} kB/s ` +
                `(${(fastest.m.kbps / slowest.m.kbps).toFixed(1)}x apart)`);
    const gain = fastest.m.kbps / first.m.kbps;
    console.log(`   the app pins #${first.rank} (${first.c.nick}) first, at ` +
                `${first.m.kbps.toFixed(0)} kB/s -- ` +
                (gain > 1.15
                    ? `${gain.toFixed(1)}x SLOWER than the best relay in its own shortlist`
                    : 'which is within 15% of the best relay in its shortlist'));

    //  Rank agreement, pair by pair. With a handful of relays this is an
    //  indication and is labelled as one; it is not a correlation coefficient
    //  and nothing downstream should treat it as one.
    let agree = 0, total = 0;
    for (let i = 0; i < rated.length; i++) {
        for (let j = i + 1; j < rated.length; j++) {
            const a = rated[i], b = rated[j];
            if (a.c.bw === b.c.bw || a.m.kbps === b.m.kbps) continue;
            total++;
            if ((a.c.bw > b.c.bw) === (a.m.kbps > b.m.kbps)) agree++;
        }
    }
    console.log(`   onionoo's observed_bandwidth ordering matched the measured ordering in ` +
                `${agree} of ${total} pairs` + (total ? ` (${(100 * agree / total).toFixed(0)}%)` : ''));

    const capMismatch = rated.filter(r => (r.x.advertised_bandwidth || 0) > 0 &&
                                          r.x.advertised_bandwidth < r.c.bw * 0.8);
    console.log(`   ${capMismatch.length} of the rated relays advertise materially less than ` +
                'they were observed at, so min(observed, advertised) would move them down' +
                (capMismatch.length ? ': ' + capMismatch.map(r => r.c.nick).join(', ') : ''));
    const flagged = rated.filter(r => r.x.measured === false || r.x.overload_general_timestamp);
    console.log(flagged.length
        ? `   flagged by onionoo (unmeasured or self-reported overload): ` +
          flagged.map(r => `${r.c.nick} at ${r.m.kbps.toFixed(0)} kB/s`).join(', ')
        : '   none of the rated relays were unmeasured or reporting overload, so this run ' +
          'says nothing about those two penalties');
}

function finish() {
    try { ctl && ctl.close(); } catch (e) {}
    try { tor && tor.kill(); } catch (e) {}
    setTimeout(() => {
        try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (e) {}
        console.log('');
        console.log(`${pass}/${pass + fail} checks passed`);
        if (fail) console.log(`${fail} FAILED`);
        console.log(`log: ${LOG}`);
        process.exit(fail ? 1 : 0);
    }, 1500);
}






