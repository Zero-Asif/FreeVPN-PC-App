'use strict';
// ════════════════════════════════════════════════════════════════════
//  test-force-exit-circuit.js -- proof for the escalation, because the
//  live probe never fired it.
//
//  MEASURED, .build/probe-force-pin.js: the escalation fires against a real Tor
//  only rarely -- 2 of 15 candidates in run 3, 1 of 15 in run 4 -- and when it
//  does, it works (614, 1214 and 1222 ms to BUILT, visible to activeExits()).
//  That is the good outcome, and it is also why a live probe cannot be the proof:
//  a run where Tor happens to choose every relay itself exercises this function
//  zero times, and run 2, before the reply-framing fix, "measured" it failing
//  when the framing bug was what failed.
//
//  So the escalation is proven here instead, against a real socket speaking
//  the real control protocol: EXTENDCIRCUIT is answered with "250 EXTENDED
//  <id>", the circuit appears in circuit-status, and the caller has to poll
//  it to BUILT and check its exit. Every failure shape Tor actually produces
//  is scripted: no id in the reply, the circuit torn down, a circuit that never
//  leaves LAUNCHED, a 551 refusal, and -- section 6 -- the 552 `No descriptor`
//  that says the relay has no microdescriptor, which is the one failure where
//  trying another borrowed pair cannot possibly help.
//
//  No Tor, no network, none of the app's ports.
// ════════════════════════════════════════════════════════════════════

const net  = require('net');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

const { TorControl } = require('../lib/tor-control.js');

let pass = 0, fail = 0;
const ok = (cond, what, detail = '') => {
    console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${what}${detail ? ' -- ' + detail : ''}`);
    cond ? pass++ : fail++;
};

const fp = c => c.repeat(40);
const WANT = fp('A');
const G1 = fp('1'), G2 = fp('2'), G3 = fp('3');
const M1 = fp('4'), M2 = fp('5'), M3 = fp('6'), M4 = fp('7');
const hop = (f, nick) => `$${f}~${nick}`;

const LOG = path.join(__dirname, 'test-force-exit-circuit.log');
try { fs.writeFileSync(LOG, ''); } catch (e) {}
const say = console.log.bind(console);
console.log = (...a) => {
    const s = a.join(' ');
    say(s);
    try { fs.appendFileSync(LOG, s + '\n'); } catch (e) {}
};

// ── a scriptable ControlPort ────────────────────────────────────────
//  `st.extend` picks what Tor does with the next EXTENDCIRCUIT:
//    'build'  -- LAUNCHED, then BUILT on the next circuit-status read
//    'drop'   -- LAUNCHED, then gone (Tor tore it down)
//    'stall'  -- LAUNCHED and never anything else
//    'noid'   -- "250 OK" with no circuit id in it
//    'error'  -- a 551 refusal
//    'nodesc-exit'  -- 552 No descriptor, naming the EXIT   (hop 3)
//    'nodesc-guard' -- 552 No descriptor, naming the borrowed GUARD (hop 1)
//  `st.md` picks what GETINFO md/id/<fp> does: 'have' or 'missing'.
const st = {
    circuits: [],
    guards: [],
    extend: 'build',
    md: 'have',
    nextId: 400,
    paths: [],        // every path EXTENDCIRCUIT was asked for, in order
    closed: [],
    pending: null,    // { id, since }
    reads: 0,
};

function serve(cmd) {
    const block = (key, lines) =>
        `250+${key}=\r\n` + lines.map(l => l + '\r\n').join('') + '.\r\n250 OK\r\n';

    if (/^AUTHENTICATE /.test(cmd)) return '250 OK\r\n';

    //  A microdescriptor when Tor has one, and Tor's real answer when it does
    //  not: GETINFO has no "I looked and it is absent" code, so an md it does
    //  not hold comes back as 552 Unrecognized key. MEASURED on 0.4.9.6 --
    //  four of DE's top five candidates answered with 449-771 bytes and the
    //  fifth refused the key.
    if (/^GETINFO md\/id\//.test(cmd)) {
        const key = cmd.slice('GETINFO '.length);
        if (st.md !== 'have') return `552 Unrecognized key "${key}"\r\n`;
        return block(key, ['onion-key', '-----BEGIN RSA PUBLIC KEY-----',
                           'MIGJAoGBAKfake', '-----END RSA PUBLIC KEY-----']);
    }

    if (cmd === 'GETINFO circuit-status') {
        st.reads++;
        const p = st.pending;
        if (p && st.reads > p.since) {
            if (p.mode === 'build') {
                st.circuits = st.circuits.map(l => l.split(' ')[0] === p.id
                    ? `${p.id} BUILT ${p.path} PURPOSE=GENERAL` : l);
                st.pending = null;
            } else if (p.mode === 'drop') {
                st.circuits = st.circuits.filter(l => l.split(' ')[0] !== p.id);
                st.pending = null;
            }
        }
        return block('circuit-status', st.circuits);
    }

    if (cmd === 'GETINFO entry-guards') return block('entry-guards', st.guards);

    if (/^EXTENDCIRCUIT 0 /.test(cmd)) {
        const spec = cmd.slice('EXTENDCIRCUIT 0 '.length);
        st.paths.push(spec);
        if (st.extend === 'error') return '551 Couldn\'t start circuit\r\n';
        if (st.extend === 'noid')  return '250 OK\r\n';
        //  Tor names the first hop it cannot use, whichever hop that is. Which
        //  one it names is the whole question: the exit's is the caller's own
        //  target and no other pair can change it, a borrowed hop's is bad luck
        //  and the next pair is worth trying.
        if (st.extend === 'nodesc-exit' || st.extend === 'nodesc-guard') {
            const hops = spec.split(',');
            const named = st.extend === 'nodesc-exit' ? hops[hops.length - 1] : hops[0];
            return `552 No descriptor for "${named}"\r\n`;
        }
        const id = String(st.nextId++);
        st.circuits = st.circuits.concat(`${id} LAUNCHED PURPOSE=GENERAL`);
        st.pending = { id, since: st.reads, mode: st.extend,
                       path: spec.split(',').map((s, i) =>
                           `${s}~${['g', 'm', 'e'][i] || 'x'}`).join(',') };
        return `250 EXTENDED ${id}\r\n`;
    }

    if (/^CLOSECIRCUIT /.test(cmd)) {
        const id = cmd.split(' ')[1];
        st.closed.push(id);
        st.circuits = st.circuits.filter(l => l.split(' ')[0] !== id);
        return '250 OK\r\n';
    }
    return '552 Unrecognized key\r\n';
}

(async () => {
    console.log(`── forcing an exit Tor refuses to choose -- ${new Date().toISOString()} ──`);
    console.log('   a real socket, the real TorControl, no Tor and no app ports\n');

    const cookie = path.join(os.tmpdir(), 'fp-force-cookie-' + process.pid);
    fs.writeFileSync(cookie, Buffer.from('abcdefabcdefabcdefabcdefabcdefab', 'hex'));
    const srv = net.createServer(sock => {
        let buf = '';
        sock.setEncoding('utf8');
        sock.on('error', () => {});
        sock.on('data', d => {
            buf += d;
            for (;;) {
                const nl = buf.indexOf('\r\n');
                if (nl < 0) break;
                const cmd = buf.slice(0, nl);
                buf = buf.slice(nl + 2);
                sock.write(serve(cmd));
            }
        });
    });
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const ctl = new TorControl({ host: '127.0.0.1', port: srv.address().port, cookiePath: cookie });
    await ctl.open({ timeoutMs: 4000 });

    // ── 1. harvesting donor pairs from Tor's own circuits ────────────
    st.circuits = [
        `7 BUILT ${hop(G1, 'guardA')},${hop(M1, 'midA')},${hop(fp('B'), 'exitX')} PURPOSE=GENERAL`,
        `8 BUILT ${hop(G1, 'guardA')},${hop(M1, 'midA')},${hop(fp('C'), 'exitY')} PURPOSE=GENERAL`,
        `9 BUILT ${hop(G2, 'guardB')},${hop(M2, 'midB')},${hop(fp('D'), 'exitZ')} PURPOSE=GENERAL`,
        `10 LAUNCHED PURPOSE=GENERAL`,
        `11 BUILT ${hop(G3, 'guardC')},${hop(fp('E'), 'twohop')} PURPOSE=GENERAL`,
        `12 BUILT ${hop(WANT, 'wantIsGuard')},${hop(M3, 'midC')},${hop(fp('F'), 'exitW')} PURPOSE=GENERAL`,
    ];
    const got = await ctl.harvestPathDonors();
    ok(got === 3 && ctl.pathDonors.length === 3,
       'one pair per distinct guard/middle: the duplicate, the half-built and the ' +
       '2-hop circuit are all skipped', `${got} pair(s) from 6 circuits`);
    ok(ctl.pathDonors[0].from === 'circuit 12' && ctl.pathDonors[2].from === 'circuit 8',
       'newest circuit first, so the freshest guard is tried first',
       ctl.pathDonors.map(p => p.from).join(' > '));

    const trimmed = new TorControl({ host: '127.0.0.1', port: srv.address().port, cookiePath: cookie });
    await trimmed.open({ timeoutMs: 4000 });
    await trimmed.harvestPathDonors({ max: 2 });
    ok(trimmed.pathDonors.length === 2 && trimmed.pathDonors[0].from === 'circuit 12',
       'the cap drops the stalest pair, never the newest',
       trimmed.pathDonors.map(p => p.from).join(' > '));
    trimmed.close();

    // ── 2. the donor source that needs no circuit at all ─────────────
    st.guards = [
        `$${G1}~guardA up`,
        `$${G2}~guardB down since 2026-09-01 12:00:00`,
        `$${G3}~guardC unusable`,
        `$${M4}~guardD up`,
    ];
    const middles = [{ fp: M1, nick: 'midA' }, { fp: M2, nick: 'midB' },
                     { fp: M4, nick: 'guardD' }, { fp: M3, nick: 'midC' }];
    const gp = await ctl.entryGuardPairs(middles);
    ok(gp.length === 5,
       'only guards that are UP are used, three middles each, and a guard is never ' +
       'its own middle', `${gp.length} pair(s) from 4 guards x 3 middles`);
    ok(gp.every(p => p.g.fp === G1 || p.g.fp === M4) && gp.every(p => p.g.fp !== p.m.fp),
       'down and unusable guards are dropped rather than tried and timed out');
    ok((await ctl.entryGuardPairs([])).length === 0,
       'and with no middles to offer it returns nothing instead of guessing one');

    // ── 3. the escalation itself ─────────────────────────────────────
    st.extend = 'build';
    st.paths = [];
    const r1 = await ctl.forceExitCircuit(WANT, { middles, tries: 3, buildMs: 2000, pollMs: 40 });
    ok(r1.ok && r1.id === '400',
       `EXTENDCIRCUIT builds to the pinned relay in ${r1.ms} ms and the circuit is ` +
       'BUILT with that exit', r1.ok ? `circuit ${r1.id} via ${r1.via}` : r1.reason);
    ok(st.paths.length === 1 && st.paths[0] === `$${G2},$${M2},$${WANT}`,
       'the path names all three hops, and hop 3 is the relay Tor would not choose',
       st.paths[0] || 'nothing was sent');
    ok(!st.paths.some(p => p.startsWith(`$${WANT}`)),
       'the pinned relay is never reused as the guard of its own circuit -- ' +
       'circuit 12\'s pair is skipped because WANT is its guard');

    const live = await ctl.activeExits();
    ok(live.some(e => e.fp === WANT),
       'and the forced circuit is a real application circuit: activeExits() sees it, ' +
       'so waitForExit() and the guard watchdog agree the country is up');

    // ── 4. every way Tor refuses, and what the caller is told ────────
    st.extend = 'drop';
    st.paths = [];
    const r2 = await ctl.forceExitCircuit(WANT, { middles, tries: 2, buildMs: 2000, pollMs: 40 });
    ok(!r2.ok && r2.tried.length === 2 && r2.tried.every(t => t.err === 'Tor dropped it'),
       'a circuit torn down after EXTENDED moves straight to the next pair instead of ' +
       'waiting out the build budget', r2.reason);
    ok(st.paths.length === 2 && st.paths[0] !== st.paths[1],
       'and the second attempt uses a DIFFERENT guard/middle pair',
       st.paths.map(p => p.slice(1, 9)).join(' then '));

    st.extend = 'stall';
    st.closed = [];
    const t0 = Date.now();
    const r3 = await ctl.forceExitCircuit(WANT, { middles, tries: 1, buildMs: 300, pollMs: 40 });
    ok(!r3.ok && /still LAUNCHED after 300 ms/.test(r3.reason),
       `a circuit that never leaves LAUNCHED is given up on at the budget ` +
       `(${Date.now() - t0} ms)`, r3.reason);
    ok(st.closed.length === 1,
       'and it is CLOSECIRCUITed, so a stalled forced build cannot come up later on ' +
       'a country the user has already left', `closed ${st.closed.join(', ') || 'nothing'}`);

    st.extend = 'noid';
    const r4 = await ctl.forceExitCircuit(WANT, { middles, tries: 2, buildMs: 300, pollMs: 40 });
    ok(!r4.ok && r4.tried.every(t => t.err === 'no circuit id in the reply'),
       'a 250 with no circuit id in it is reported as such, not treated as a success',
       r4.reason);

    st.extend = 'error';
    const r5 = await ctl.forceExitCircuit(WANT, { middles, tries: 1, buildMs: 300, pollMs: 40 });
    ok(!r5.ok && /tor control 551/.test(r5.reason),
       'and a refusal from Tor comes back with Tor\'s own words', r5.reason);

    // ── 5. nothing to borrow from ────────────────────────────────────
    st.guards = [];
    const bare = new TorControl({ host: '127.0.0.1', port: srv.address().port, cookiePath: cookie });
    await bare.open({ timeoutMs: 4000 });
    const r6 = await bare.forceExitCircuit(WANT, { middles: [], tries: 3 });
    ok(!r6.ok && r6.reason === 'no guard/middle pair to borrow a path from',
       'with no donor circuit and no guard list it says so, instead of sending ' +
       'EXTENDCIRCUIT with a broken path', r6.reason);
    ok(st.paths.length === 6,
       'and it sends nothing at all in that case',
       `${st.paths.length} EXTENDCIRCUITs in the whole run: 2 dropped, 1 stalled, ` +
       '2 with no id, 1 refused -- and none from the empty pool');
    bare.close();

    // ── 6. the one question worth asking BEFORE any of the above ─────
    //  A relay in the consensus with no microdescriptor cannot be chosen by Tor
    //  and cannot be extended to. MEASURED (tor 0.4.9.6, 2026-09-04): `demise`,
    //  Germany's highest-bandwidth exit, was exactly that -- `ns/id` answered
    //  for it, `md/id` refused with 552, and the app spent a 10 s wait plus
    //  three ~10 s explicit builds discovering what one GETINFO would have said.
    st.md = 'have';
    ok(await ctl.hasDescriptor(WANT) === true,
       'hasDescriptor() is true when Tor hands over a microdescriptor');
    ok(await ctl.hasDescriptor('$' + WANT.toLowerCase()) === true,
       'and it accepts the $-prefixed lower-case form the rest of the app passes around');
    st.md = 'missing';
    ok(await ctl.hasDescriptor(WANT) === false,
       'false when Tor refuses the key -- which is how a missing md comes back, ' +
       'because GETINFO has no code for "I looked and it is not there"');
    ok(await ctl.hasDescriptor('nonsense') === null,
       'null, not false, for a fingerprint that is not one');
    const shut = new TorControl({ host: '127.0.0.1', port: srv.address().port, cookiePath: cookie });
    ok(await shut.hasDescriptor(WANT) === null,
       'and null when the question could not be asked at all -- a control port that is ' +
       'not open is not evidence about a relay, and reading it as false would drop a ' +
       'candidate that works');

    //  The 552 that names the exit: every other pair would fail identically, so
    //  the loop must stop. MEASURED in probe-force-pin run 3 -- three disjoint
    //  pairs, three identical `No descriptor for "$3E10B71C…"`, ~30 s spent.
    st.extend = 'nodesc-exit';
    st.paths = [];
    const r7 = await ctl.forceExitCircuit(WANT, { middles: [], tries: 3, buildMs: 300, pollMs: 40 });
    ok(!r7.ok && r7.noDescriptor === true,
       'a 552 naming the EXIT is reported as noDescriptor, so the caller can escalate ' +
       'to the engine restart that fetches it instead of retrying', r7.reason);
    ok(st.paths.length === 1,
       'and it stops after ONE pair instead of spending the other two on the same answer',
       `${st.paths.length} EXTENDCIRCUIT(s) sent`);
    ok(/No descriptor/.test(r7.reason) && /descriptor for this relay yet/.test(r7.reason),
       'with Tor\'s own words kept inside the app\'s', r7.reason);

    st.extend = 'nodesc-guard';
    st.paths = [];
    const r8 = await ctl.forceExitCircuit(WANT, { middles: [], tries: 3, buildMs: 300, pollMs: 40 });
    ok(!r8.ok && !r8.noDescriptor && st.paths.length === 2,
       'but a 552 naming a BORROWED hop keeps going -- that is one unlucky donor, not ' +
       'a verdict on the exit, and the pool is what it moves to',
       `${st.paths.length} pair(s) tried, noDescriptor=${!!r8.noDescriptor}`);

    ctl.close();
    srv.close();
    try { fs.unlinkSync(cookie); } catch (e) {}
    console.log(`\n${pass}/${pass + fail} checks passed`);
    console.log('log: ' + LOG);
    process.exit(fail ? 1 : 0);
})().catch(e => {
    console.log('test crashed: ' + (e && e.stack || e));
    process.exit(1);
});
