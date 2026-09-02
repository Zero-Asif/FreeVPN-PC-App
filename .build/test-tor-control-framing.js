'use strict';
// ════════════════════════════════════════════════════════════════════
//  test-tor-control-framing.js -- the bug that broke every country
//  switch in a long session, pinned down so it cannot come back.
//
//  MEASURED, 2026-09-01, .build/probe-force-pin.js run 2. The probe died
//  with:
//      Error: tor control 157: GUARD_WAIT $E4B0...~fusion,$D71E...~DINOTOR,
//             $0C18...~MiddleEarth BUILD_FLAGS=NEED_CAPACITY,NEED_UPTIME
//             PURPOSE=MEASURE_TIMEOUT
//  157 is not a reply code. It is a CIRCUIT ID, on a line inside the
//  "250+circuit-status=" data block, and lib/tor-control.js read it as the
//  reply's terminating status line -- code 157, outside 2xx, so it threw.
//
//  Tor numbers circuits from 1 for the life of the process. Under a hundred
//  circuits no line in that block starts with three digits and a space, which
//  is why every earlier probe passed: their highest ids were 9, 14, 51, 64
//  and 80. Past a hundred, EVERY circuit-status read fails, and with it:
//      circuits() -> throws
//      waitForExit() -> false for every candidate, in every country
//                       ("No circuit reached <relay> in 25s", five per country)
//      purgeCircuitsExcept() -> 0, so the previous country's circuits stay
//      maxCircuitId() -> 0, so the stale-circuit watermark is meaningless
//  and the reply queue desynchronises on top, because the entry is shifted
//  off early and the rest of the real reply is handed to the NEXT command.
//
//  That is the reported failure exactly: "Sweden has 300+ exit nodes and the
//  app cannot connect to even one". It is not about Sweden.
//
//  This test speaks the real control protocol over a real socket to the real
//  TorControl -- no Tor, no network, no ports of the app's, nothing mocked
//  except the far end of the TCP connection.
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

const WANT  = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const OTHER = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const MID   = 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
const hop = (fp, nick) => `$${fp}~${nick}`;

//  Real circuit-status shapes, with the ids that matter:
//    99   two digits -- worked before the fix as well
//    157  three digits and a space: the line that killed the probe
//    250  three digits that are also a SUCCESS code, so the old framing
//         resolved the reply early and silently truncated it instead of
//         throwing. Same defect, quieter, and worse to debug.
//    1000 four digits -- never matched, so this one always worked
const CIRCUITS = [
    `99 BUILT ${hop(MID, 'g1')},${hop(MID, 'm1')},${hop(OTHER, 'elsewhere')} PURPOSE=GENERAL`,
    `157 GUARD_WAIT ${hop(MID, 'fusion')},${hop(MID, 'DINOTOR')},${hop(OTHER, 'MiddleEarth')} ` +
        `BUILD_FLAGS=NEED_CAPACITY,NEED_UPTIME PURPOSE=MEASURE_TIMEOUT`,
    `250 BUILT ${hop(MID, 'g2')},${hop(MID, 'm2')},${hop(WANT, 'pinned')} PURPOSE=CONFLUX_LINKED`,
    `301 LAUNCHED BUILD_FLAGS=NEED_CAPACITY PURPOSE=GENERAL`,
    `1000 BUILT ${hop(MID, 'g3')},${hop(MID, 'm3')},${hop(WANT, 'pinned')} PURPOSE=GENERAL`,
];

//  A data block whose payload contains a line that looks exactly like a
//  successful reply terminator. Router descriptors are free-form text and
//  nothing stops one containing it.
const NASTY_BLOCK = ['onion-key', '250 OK', '-----BEGIN RSA PUBLIC KEY-----', 'p accept 80,443'];

const LOG = path.join(__dirname, 'test-tor-control-framing.log');
try { fs.writeFileSync(LOG, ''); } catch (e) {}
const say = console.log.bind(console);
console.log = (...a) => {
    const s = a.join(' ');
    say(s);
    try { fs.appendFileSync(LOG, s + '\n'); } catch (e) {}
};

// ── the far end: a fake ControlPort that frames replies the way Tor does ──
//  One line per command in, real CRLF, real "NNN+" blocks terminated by a
//  lone ".", real "NNN-" continuations, real "NNN " terminators.
function fakeControlPort() {
    const seen = [];        // every command line the client sent, in order
    const closed = [];      // CLOSECIRCUIT ids
    const state = { circuits: CIRCUITS.slice(), exitNodes: '' };

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
                seen.push(cmd);
                sock.write(reply(cmd, state, closed));
            }
        });
    });

    return { srv, seen, closed, state,
             listen: () => new Promise(r => srv.listen(0, '127.0.0.1', r)),
             port: () => srv.address().port };
}

function reply(cmd, state, closed) {
    const block = (key, lines) =>
        `250+${key}=\r\n` + lines.map(l => l + '\r\n').join('') + '.\r\n250 OK\r\n';

    if (/^AUTHENTICATE /.test(cmd)) return '250 OK\r\n';
    if (cmd === 'GETINFO circuit-status') return block('circuit-status', state.circuits);
    if (/^GETINFO md\/id\//.test(cmd))    return block(cmd.slice(8), NASTY_BLOCK);
    if (/^GETINFO version$/.test(cmd))    return '250-version=0.4.8.12\r\n250 OK\r\n';
    if (/^SETCONF /.test(cmd)) {
        const m = /ExitNodes="([^"]*)"/.exec(cmd);
        if (m) state.exitNodes = m[1];
        return '250 OK\r\n';
    }
    if (cmd === 'GETCONF ExitNodes') return `250 ExitNodes="${state.exitNodes}"\r\n`;
    if (/^CLOSECIRCUIT /.test(cmd)) {
        const id = cmd.split(' ')[1];
        closed.push(id);
        state.circuits = state.circuits.filter(l => l.split(' ')[0] !== id);
        return '250 OK\r\n';
    }
    if (cmd === 'SIGNAL NEWNYM') return '250 OK\r\n';
    return '552 Unrecognized key "' + cmd + '"\r\n';
}

// ── what the OLD framing did with these exact bytes ─────────────────
//  Kept here so the fixture cannot rot into something that passes for the
//  wrong reason: if this ever stops failing, the test below is no longer
//  exercising the bug it was written for.
function oldFraming(text) {
    let buf = text, out = { code: null, lines: [], leftover: '' };
    for (;;) {
        const nl = buf.indexOf('\r\n');
        if (nl < 0) break;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        out.lines.push(line);
        if (/^\d{3}[-+]/.test(line)) continue;
        if (/^\d{3} /.test(line)) { out.code = parseInt(line.slice(0, 3), 10); break; }
    }
    out.leftover = buf;
    return out;
}

(async () => {
    console.log(`── tor control reply framing -- ${new Date().toISOString()} ──`);
    console.log('   a real socket, the real TorControl, no Tor and no app ports\n');

    const cookie = path.join(os.tmpdir(), 'fp-framing-cookie-' + process.pid);
    fs.writeFileSync(cookie, Buffer.from('0123456789abcdef0123456789abcdef', 'hex'));

    const far = fakeControlPort();
    await far.listen();
    const ctl = new TorControl({ host: '127.0.0.1', port: far.port(), cookiePath: cookie });

    // ── 0. the fixture really does trip the old framing ──────────────
    const raw = reply('GETINFO circuit-status', { circuits: CIRCUITS.slice() }, []);
    const old = oldFraming(raw);
    ok(old.code === 157,
       'the fixture reproduces the crash: the old framing ends the reply on a circuit id',
       `it read code ${old.code} from "${(old.lines[old.lines.length - 1] || '').slice(0, 44)}…" ` +
       `and left ${old.leftover.split('\r\n').filter(Boolean).length} line(s) of this reply ` +
       'to be handed to the next command');

    // ── 1. authenticate over the real socket ─────────────────────────
    await ctl.open({ timeoutMs: 4000 });
    ok(ctl.authenticated && far.seen.some(c => /^AUTHENTICATE [0-9a-f]{32}$/.test(c)),
       'AUTHENTICATE with the cookie as hex is accepted');

    // ── 2. circuit-status parses, all of it ──────────────────────────
    let cs = [];
    let threw = null;
    try { cs = await ctl.circuits(); } catch (e) { threw = e; }
    ok(!threw, 'GETINFO circuit-status resolves instead of rejecting',
       threw ? threw.message : '');
    ok(cs.length === CIRCUITS.length,
       `every circuit line survives the block (${cs.length}/${CIRCUITS.length})`,
       cs.length ? 'ids ' + cs.map(c => c.id).join(', ') : 'nothing parsed');

    const c157 = cs.find(c => c.id === '157');
    ok(!!c157 && c157.status === 'GUARD_WAIT' && c157.purpose === 'MEASURE_TIMEOUT' &&
       c157.hops.length === 3,
       'circuit 157 -- the line that crashed the probe -- is read as a circuit, not a reply code',
       c157 ? `${c157.status} ${c157.purpose} ${c157.hops.length} hops` : 'missing');

    const c250 = cs.find(c => c.id === '250');
    ok(!!c250 && c250.status === 'BUILT' && c250.purpose === 'CONFLUX_LINKED',
       'circuit 250 -- an id that is also a SUCCESS code -- does not end the reply early',
       c250 ? `${c250.status} ${c250.purpose}` : 'missing: the reply was truncated at it');

    ok(cs.some(c => c.id === '1000'),
       'and the lines after it are still there (1000 came after 250 in the block)');

    // ── 3. the queue stays in sync ───────────────────────────────────
    //  Both commands are in flight at once, which is what desynchronises:
    //  the block's payload used to resolve the FIRST entry early, so the rest
    //  of its own reply -- including its "250 OK" -- landed on the second.
    await ctl.setConf({ ExitNodes: '$' + WANT });
    const [statusRaw, confLines] = await Promise.all([
        ctl.getInfo('circuit-status'),
        ctl.cmd('GETCONF ExitNodes'),
    ]);
    ok(statusRaw.split('\n').length === CIRCUITS.length,
       'two commands in flight: the first still gets its whole reply',
       `${statusRaw.split('\n').length} line(s)`);
    ok(confLines.length === 1 && confLines[0] === `250 ExitNodes="$${WANT}"`,
       'and the second gets its own reply, not the first one\'s leftovers',
       JSON.stringify(confLines));

    // ── 4. the four things the app lost while this was broken ────────
    const hi = await ctl.maxCircuitId();
    ok(hi === 1000, 'maxCircuitId() sees the real watermark, so the stale-circuit ' +
       'cutoff means something again', `got ${hi}, want 1000`);

    const exits = await ctl.activeExits();
    ok(exits.length === 2 && exits.some(e => e.fp === WANT) && exits.some(e => e.fp === OTHER),
       'activeExits() sees both live exits and ignores the MEASURE_TIMEOUT circuit',
       exits.map(e => e.nick).join(', ') || 'none');

    const t0 = Date.now();
    const reached = await ctl.waitForExit(WANT, { timeoutMs: 3000, pollMs: 50 });
    ok(reached, `waitForExit() finds the pinned relay (in ${Date.now() - t0} ms)`,
       reached ? '' : 'this is the "No circuit reached <relay> in 25s" the user saw, ' +
                      'five times per country, in every country');

    const closedN = await ctl.purgeCircuitsExcept(WANT, { staleIdMax: hi });
    ok(closedN === 2 && far.closed.includes('99') && far.closed.includes('301'),
       'purgeCircuitsExcept() closes the wrong-exit circuit and the stale half-built one',
       `closed ${closedN}: ${far.closed.join(', ') || 'nothing'}`);
    ok(!far.closed.includes('250') && !far.closed.includes('1000') && !far.closed.includes('157'),
       'and leaves the conforming circuits and Tor\'s own plumbing alone');

    const after = await ctl.activeExits();
    ok(after.length === 1 && after[0].fp === WANT,
       'after the purge only the pinned country can carry traffic',
       after.map(e => e.nick).join(', ') || 'none');

    // ── 5. a payload line that IS a success terminator ───────────────
    const md = await ctl.cmd(`GETINFO md/id/$${WANT}`);
    ok(md.length === NASTY_BLOCK.length + 3 && md[2] === '250 OK' &&
       md[md.length - 1] === '250 OK' && md[md.length - 2] === '.',
       'a descriptor containing the literal line "250 OK" does not end its own block',
       `${md.length} line(s), payload[1] = ${JSON.stringify(md[2])}`);

    // ── 6. real error replies must still reject ──────────────────────
    let rejected = null;
    try { await ctl.cmd('GETINFO bogus/key'); } catch (e) { rejected = e.message; }
    ok(/^tor control 552:/.test(rejected || ''),
       'a genuine non-2xx reply still rejects -- the fix did not swallow errors',
       rejected || 'it resolved');
    const stillOk = await ctl.cmd('GETINFO version');
    ok(stillOk.some(l => /^250-version=/.test(l)),
       'and the queue survives the error, so the next command still works');

    // ── 7. a connection dropped mid-block must not poison the next one ──
    //  The app reconnects to the control port after a Tor restart. If the
    //  block flag carried over, every line of the new connection's first
    //  reply would be read as opaque payload and the command would hang
    //  until its 15 s timeout -- once per switch, silently.
    ctl.inBlock = true;
    ctl.close();
    ok(ctl.inBlock === false, 'closing mid-block clears the block flag');
    await ctl.open({ timeoutMs: 4000 });
    const reopened = await ctl.circuits();
    ok(reopened.length > 0, 'and the reconnected control port parses its first reply',
       `${reopened.length} circuit(s)`);

    ctl.close();
    far.srv.close();
    try { fs.unlinkSync(cookie); } catch (e) {}

    console.log(`\n${pass}/${pass + fail} checks passed`);
    console.log('log: ' + LOG);
    process.exit(fail ? 1 : 0);
})().catch(e => {
    console.log('test crashed: ' + (e && e.stack || e));
    process.exit(1);
});
