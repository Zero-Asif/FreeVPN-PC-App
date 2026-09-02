'use strict';
// ════════════════════════════════════════════════════════════════════
//  test-guard-watermark.js -- what the circuit guard closes, exactly
//
//  main.js's startCircuitGuard() used to run every 15 s with
//      staleIdMax: Number.MAX_SAFE_INTEGER
//  which means "close every circuit whose exit is not known yet, no
//  matter how young". It now passes the circuit-id watermark read when
//  the guard was armed, which is immediately after finalSweep() has
//  already closed everything not on the pinned relay.
//
//  The measured cost of the old value is in .build/probe-exit-speed.js
//  (PS_GUARD=2: something was mid-build in 3.2% of the clock, and 7 of
//  10 mid-build circuits went on to reach BUILT on the pinned exit).
//  The question THIS file answers is the safety one: does the new value
//  still close everything the guard exists to close?
//
//  It drives the real TorControl.purgeCircuitsExcept() -- the shipped
//  method, not a copy -- with circuits() and cmd() stubbed, so the
//  answer is deterministic and needs no Tor, no network and no ports.
//
//  The last four blocks answer a second question about the same method:
//  what it does with NO relay to exempt. main.js pins ExitNodes={cc}
//  whenever the relay list cannot be fetched, and on that path the purge
//  used to be skipped entirely -- which left the previous country's
//  circuits attachable for the whole of MaxCircuitDirtiness after a
//  switch that had just reported success.
// ════════════════════════════════════════════════════════════════════

const { TorControl } = require('../lib/tor-control.js');

let pass = 0, fail = 0;
const ok = (cond, what, detail = '') => {
    console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${what}${detail ? ' -- ' + detail : ''}`);
    cond ? pass++ : fail++;
};

const WANT  = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';   // the pinned exit
const OTHER = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';   // some other exit
const MID   = 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';   // a middle relay

//  circuit-status lines in Tor's own format, so the parser under test is
//  the one that ships. `hops` is derived from the $fp~nick path field and
//  `internal` from BUILD_FLAGS -- writing the lines instead of the parsed
//  objects keeps this test honest about both.
const hop = (fp, nick) => `$${fp}~${nick}`;
const LINES = [
    //  Launched before the pin, exit not known yet: the whole reason the
    //  half-built branch exists. Tor does not re-check ExitNodes on a
    //  circuit it has already launched, so this one can still finish on
    //  the previous country minutes later.
    `10 LAUNCHED BUILD_FLAGS=NEED_CAPACITY PURPOSE=GENERAL`,
    //  Launched after the pin, one hop so far. StrictNodes leaves it one
    //  possible exit -- the pinned one. This is the circuit the change is
    //  about, and it is a conflux leg, which is Tor's own throughput
    //  mechanism since 0.4.8.
    `90 EXTENDED ${hop(MID, 'mid1')} BUILD_FLAGS=NEED_CAPACITY PURPOSE=CONFLUX_UNLINKED`,
    //  Built, and conforming.
    `91 BUILT ${hop(MID, 'g1')},${hop(MID, 'm1')},${hop(WANT, 'pinned')} PURPOSE=CONFLUX_LINKED`,
    //  Built, and ending somewhere else: relay churn, or a stale circuit
    //  that completed on the old country. Must always go.
    `92 BUILT ${hop(MID, 'g1')},${hop(MID, 'm1')},${hop(OTHER, 'elsewhere')} PURPOSE=GENERAL`,
    //  Directory tunnel. Carries no exit traffic; closing it just makes
    //  Tor rebuild it.
    `93 BUILT ${hop(MID, 'dir1')} BUILD_FLAGS=ONEHOP_TUNNEL PURPOSE=DIR_FETCH`,
    //  Not an application purpose at all.
    `94 BUILT ${hop(MID, 'v1')},${hop(MID, 'v2')} PURPOSE=HS_VANGUARDS`,
    //  Internal by build flag even though its purpose is one we accept.
    `95 BUILT ${hop(MID, 'i1')},${hop(OTHER, 'i2')} BUILD_FLAGS=IS_INTERNAL PURPOSE=GENERAL`,
];

function makeCtl() {
    const ctl = new TorControl({ port: 1, cookiePath: 'nul' });
    const closed = [];
    ctl.getInfo = async key => {
        if (key !== 'circuit-status') throw new Error('unexpected GETINFO ' + key);
        return LINES.join('\n');
    };
    ctl.cmd = async command => {
        const m = /^CLOSECIRCUIT (\d+)$/.exec(command);
        if (!m) throw new Error('unexpected command ' + command);
        closed.push(Number(m[1]));
        return ['250 OK'];
    };
    return { ctl, closed };
}

const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

(async () => {
    console.log('\n── what the parser sees ──');
    const { ctl: peek } = makeCtl();
    const cs = await peek.circuits();
    ok(cs.length === LINES.length, 'every circuit-status line parsed', `${cs.length}`);
    console.log('   ' + cs.map(c => `${c.id}:${c.status}/${c.purpose}` +
                `/hops=${c.hops.length}${c.internal ? '/internal' : ''}`).join('  '));

    console.log('\n── the shipped guard value: staleIdMax = MAX_SAFE_INTEGER ──');
    {
        const { ctl, closed } = makeCtl();
        const n = await ctl.purgeCircuitsExcept(WANT, { staleIdMax: Number.MAX_SAFE_INTEGER });
        closed.sort((a, b) => a - b);
        ok(same(closed, [10, 90, 92]), 'closes the stale half-built one, the conforming ' +
           'half-built one, and the off-exit one', `closed ${closed.join(', ')}`);
        ok(n === 3, 'and reports three', String(n));
    }

    console.log('\n── the new value: staleIdMax = the watermark read when armed ──');
    {
        const { ctl, closed } = makeCtl();
        const n = await ctl.purgeCircuitsExcept(WANT, { staleIdMax: 50 });
        closed.sort((a, b) => a - b);
        ok(same(closed, [10, 92]), 'still closes the stale half-built one and the off-exit ' +
           'one; spares only the circuit launched after the pin', `closed ${closed.join(', ')}`);
        ok(!closed.includes(90), 'circuit 90 (post-watermark conflux leg) survives');
        ok(!closed.includes(91), 'the conforming built circuit survives');
        ok(!closed.includes(93) && !closed.includes(94) && !closed.includes(95),
           'internal plumbing and non-app purposes are untouched');
        ok(n === 2, 'and reports two', String(n));
    }

    //  The property that matters for the country guarantee: an off-exit
    //  circuit is closed for ANY watermark, because that branch never looks
    //  at the id. If this ever failed, the guard would have stopped being a
    //  guard.
    console.log('\n── the guarantee, across every watermark ──');
    {
        let always = true, detail = '';
        for (const stale of [0, 1, 9, 10, 50, 89, 90, 91, 95, 1e6, Number.MAX_SAFE_INTEGER]) {
            const { ctl, closed } = makeCtl();
            await ctl.purgeCircuitsExcept(WANT, { staleIdMax: stale });
            if (!closed.includes(92)) { always = false; detail = 'survived at ' + stale; break; }
            if (closed.includes(91)) { always = false; detail = 'took 91 at ' + stale; break; }
        }
        ok(always, 'the circuit ending at the wrong exit is closed at every watermark, and ' +
           'the conforming one is never closed', detail);
    }

    //  And the direction of the change, stated as a test rather than as a
    //  comment: a watermark can only ever spare circuits, never keep an
    //  off-exit one alive.
    {
        const { ctl: a, closed: ca } = makeCtl();
        await a.purgeCircuitsExcept(WANT, { staleIdMax: Number.MAX_SAFE_INTEGER });
        const { ctl: b, closed: cb } = makeCtl();
        await b.purgeCircuitsExcept(WANT, { staleIdMax: 50 });
        ok(cb.every(id => ca.includes(id)),
           'everything the watermark closes, MAX_SAFE_INTEGER also closed -- the change ' +
           'only ever removes closures, and only of post-pin half-built circuits');
    }

    //  ── the pin that names a country instead of a relay ──────────────
    //  Everything above pins a fingerprint. main.js falls back to
    //  ExitNodes={cc} when onionoo is unreachable, and then there IS no relay
    //  to compare a circuit against -- a set is not a relay. The only question
    //  still answerable about a circuit is WHEN it was launched, so that is the
    //  only one asked.
    console.log('\n── ExitNodes={cc}: no relay to exempt ──');
    {
        const { ctl, closed } = makeCtl();
        const n = await ctl.purgeCircuitsExcept(null, { staleIdMax: 50 });
        closed.sort((a, b) => a - b);
        ok(same(closed, [10]),
           'only what was launched before the switch goes -- and 92, which ends at the ' +
           'WRONG relay, is SPARED here: after a {cc} pin an exit that is not the pinned ' +
           'one is exactly what was asked for', `closed ${closed.join(', ') || 'nothing'}`);
        ok(n === 1 && !closed.includes(90) && !closed.includes(91),
           'the circuits Tor built after the pin survive, so the new country is not torn ' +
           'down as fast as Tor builds it', String(n));
    }
    {
        //  The switch itself: every standing circuit predates it, including the
        //  one ending at WANT -- which means nothing on this path, because no
        //  fingerprint was ever pinned.
        const { ctl, closed } = makeCtl();
        const n = await ctl.purgeCircuitsExcept(null, { staleIdMax: Number.MAX_SAFE_INTEGER });
        closed.sort((a, b) => a - b);
        ok(same(closed, [10, 90, 91, 92]) && n === 4,
           'with every circuit predating the switch, every circuit that could carry a page ' +
           'goes -- this is the leak the `if (cand.fp)` gate used to allow',
           `closed ${closed.join(', ')}`);
        ok(!closed.includes(93) && !closed.includes(94) && !closed.includes(95),
           'and internal plumbing is still spared, so Tor is not left rebuilding its ' +
           'directory tunnels on top of everything else');

        const { ctl: c2, closed: cl2 } = makeCtl();
        const n2 = await c2.closeAppCircuits();
        cl2.sort((a, b) => a - b);
        ok(n2 === n && same(cl2, closed),
           'and at that marker it is exactly closeAppCircuits(), the guarantee sealTunnel() ' +
           'already relies on -- reached through the id marker instead of a second method',
           `${n2} vs ${n}`);
    }
    {
        const { ctl, closed } = makeCtl();
        const n = await ctl.purgeCircuitsExcept(null, { staleIdMax: 0 });
        ok(n === 0 && !closed.length,
           'no relay AND no marker closes NOTHING rather than everything, so this can never ' +
           'tear down a working tunnel on its own; main.js passes MAX_SAFE_INTEGER itself on ' +
           'the one path where it knows the marker read failed', `closed ${closed.length}`);
    }
    {
        const { ctl } = makeCtl();
        let threw = null;
        try { await ctl.purgeCircuitsExcept(undefined, { staleIdMax: 10 }); }
        catch (e) { threw = e.message; }
        ok(!threw, 'undefined is handled rather than thrown on -- the old fp.replace() made ' +
           'this a TypeError, which is why the call site was gated instead of fixed',
           threw || '');
    }

    console.log(`\n${pass}/${pass + fail} checks passed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error('probe crashed: ' + e.stack); process.exit(1); });