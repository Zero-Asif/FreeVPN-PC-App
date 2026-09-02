'use strict';
// ════════════════════════════════════════════════════════════════════
//  socks-fetch.js -- dependency-free HTTP(S) client over SOCKS5
//
//  WHY THIS EXISTS
//  ---------------
//  Exit-country verification used to shell out to Windows' bundled
//  curl.exe. When curl was missing (or blocked), queryGeoAPI() simply
//  returned null, verifyAndFixExitCountry() logged
//      "curl unavailable -- skipping exit country check"
//  and returned { verified:false, actual:null } -- which the caller
//  treated as "fine, keep the requested country". That is how the app
//  reported "Connected via LU" while the real exit was in Switzerland.
//
//  Verification is the one thing that must never silently no-op, so it
//  now runs on Node's own net+tls sockets. No external binary, no npm
//  dependency, and a hard distinction between "the request failed"
//  and "the request said the wrong country".
//
//  The destination hostname is sent to Tor as a SOCKS5 DOMAINNAME
//  request (ATYP 0x03), so Tor resolves it at the exit relay. We never
//  perform a local DNS lookup -- the verification path itself cannot
//  leak DNS.
// ════════════════════════════════════════════════════════════════════

const net = require('net');
const tls = require('tls');
const { URL } = require('url');

const SOCKS5_REPLY = {
    0x00: 'succeeded',
    0x01: 'general SOCKS server failure',
    0x02: 'connection not allowed by ruleset',
    0x03: 'network unreachable',
    0x04: 'host unreachable',
    0x05: 'connection refused',
    0x06: 'TTL expired',
    0x07: 'command not supported',
    0x08: 'address type not supported',
};

// ── SOCKS5 CONNECT handshake ────────────────────────────────────────
function socks5Connect({ socksHost, socksPort, destHost, destPort, timeoutMs }) {
    return new Promise((resolve, reject) => {
        const sock = net.connect({ host: socksHost, port: socksPort });
        let stage = 0;                 // 0 = greeting, 1 = connect reply
        let buf = Buffer.alloc(0);
        let settled = false;

        const fail = msg => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try { sock.destroy(); } catch (e) {}
            reject(new Error(msg));
        };
        const timer = setTimeout(() => fail('socks5 handshake timeout'), timeoutMs);

        sock.on('error', e => fail('socks5 socket: ' + e.message));
        sock.on('close', () => fail('socks5 socket closed during handshake'));

        sock.on('connect', () => {
            // VER=5, NMETHODS=1, METHOD=0x00 (no authentication)
            sock.write(Buffer.from([0x05, 0x01, 0x00]));
        });

        sock.on('data', chunk => {
            buf = Buffer.concat([buf, chunk]);

            if (stage === 0) {
                if (buf.length < 2) return;
                if (buf[0] !== 0x05) return fail('socks5 bad version ' + buf[0]);
                if (buf[1] !== 0x00) return fail('socks5 auth method rejected');
                buf = buf.subarray(2);
                stage = 1;

                const hostBuf = Buffer.from(destHost, 'ascii');
                if (hostBuf.length > 255) return fail('socks5 hostname too long');
                sock.write(Buffer.concat([
                    Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
                    hostBuf,
                    Buffer.from([(destPort >> 8) & 0xff, destPort & 0xff]),
                ]));
                if (buf.length === 0) return;   // fall through if reply already buffered
            }

            if (stage === 1) {
                if (buf.length < 5) return;
                if (buf[0] !== 0x05) return fail('socks5 bad reply version ' + buf[0]);
                if (buf[1] !== 0x00) {
                    return fail('socks5 connect failed: ' +
                        (SOCKS5_REPLY[buf[1]] || 'rep ' + buf[1]));
                }
                const atyp = buf[3];
                let need = 4 + 2;                                  // header + port
                if      (atyp === 0x01) need += 4;                 // IPv4
                else if (atyp === 0x04) need += 16;                // IPv6
                else if (atyp === 0x03) need += 1 + buf[4];        // domain
                else return fail('socks5 bad ATYP ' + atyp);
                if (buf.length < need) return;

                const leftover = buf.subarray(need);
                settled = true;
                clearTimeout(timer);
                sock.removeAllListeners('data');
                sock.removeAllListeners('close');
                sock.removeAllListeners('error');
                // Keep an error sink attached so a later socket error can never
                // become an unhandled 'error' event and take the process down.
                sock.on('error', () => {});
                if (leftover.length) sock.unshift(leftover);
                resolve(sock);
            }
        });
    });
}

// ── Minimal HTTP/1.1 response parser (identity + chunked) ───────────
function parseHttpResponse(raw) {
    const sep = raw.indexOf('\r\n\r\n');
    if (sep < 0) throw new Error('malformed HTTP response (no header terminator)');

    const headerText = raw.subarray(0, sep).toString('latin1');
    let body = raw.subarray(sep + 4);

    const lines = headerText.split('\r\n');
    const statusMatch = /^HTTP\/1\.[01] (\d{3})/.exec(lines[0] || '');
    if (!statusMatch) throw new Error('malformed HTTP status line');
    const status = parseInt(statusMatch[1], 10);

    const headers = {};
    for (let i = 1; i < lines.length; i++) {
        const idx = lines[i].indexOf(':');
        if (idx > 0) {
            headers[lines[i].slice(0, idx).trim().toLowerCase()] =
                lines[i].slice(idx + 1).trim();
        }
    }

    if ((headers['transfer-encoding'] || '').toLowerCase().includes('chunked')) {
        const out = [];
        let pos = 0;
        for (;;) {
            const nl = body.indexOf('\r\n', pos);
            if (nl < 0) break;
            const size = parseInt(body.subarray(pos, nl).toString('ascii').split(';')[0], 16);
            if (!Number.isFinite(size) || size === 0) break;
            const start = nl + 2;
            out.push(body.subarray(start, start + size));
            pos = start + size + 2;
        }
        body = Buffer.concat(out);
    }

    return { status, headers, body: body.toString('utf8') };
}

// ── Public: GET a URL through a SOCKS5 proxy ────────────────────────
//  Resolves with { status, headers, body }.
//  Rejects on any transport-level problem -- callers must be able to
//  tell "could not ask" apart from "asked and got an answer".
async function socksGet(url, opts = {}) {
    const {
        socksHost = '127.0.0.1',
        socksPort,
        timeoutMs = 15000,
        userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) FreeProxyVPN/2.0',
        maxBytes = 256 * 1024,
    } = opts;
    if (!socksPort) throw new Error('socksGet: socksPort is required');

    const u = new URL(url);
    const isTls = u.protocol === 'https:';
    const destPort = u.port ? Number(u.port) : (isTls ? 443 : 80);

    const rawSock = await socks5Connect({
        socksHost, socksPort, destHost: u.hostname, destPort, timeoutMs,
    });

    return new Promise((resolve, reject) => {
        let settled = false;
        const chunks = [];
        let received = 0;

        const finish = (err, val) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try { stream.destroy(); } catch (e) {}
            try { rawSock.destroy(); } catch (e) {}
            err ? reject(err) : resolve(val);
        };
        const timer = setTimeout(() => finish(new Error('HTTP request timeout')), timeoutMs);

        const done = () => {
            if (settled) return;
            if (!received) return finish(new Error('empty response'));
            try { finish(null, parseHttpResponse(Buffer.concat(chunks))); }
            catch (e) { finish(e); }
        };

        const stream = isTls
            ? tls.connect({
                  socket: rawSock,
                  servername: u.hostname,
                  ALPNProtocols: ['http/1.1'],
              })
            : rawSock;

        stream.on('error', e => finish(new Error('stream: ' + e.message)));
        stream.on('data', d => {
            chunks.push(d);
            received += d.length;
            if (received > maxBytes) done();      // enough -- stop reading
        });
        stream.on('end', done);
        stream.on('close', done);

        const request =
            `GET ${u.pathname}${u.search} HTTP/1.1\r\n` +
            `Host: ${u.host}\r\n` +
            `User-Agent: ${userAgent}\r\n` +
            `Accept: */*\r\n` +
            `Accept-Encoding: identity\r\n` +
            `Connection: close\r\n\r\n`;

        if (isTls) stream.on('secureConnect', () => stream.write(request));
        else stream.write(request);
    });
}

// ── Public: time how fast bytes actually arrive through the tunnel ──
//  socksGet() answers "what did it say"; this answers "how fast did it
//  come". Three reasons it is not a flag on socksGet:
//
//    * A throughput sample needs a payload far larger than any parse
//      budget -- socksGet stops at maxBytes (256 KiB by default) and
//      returns everything it read as one utf8 string. Here the bytes
//      are counted and dropped, so a megabyte costs a counter, not a
//      megabyte of heap plus a decode.
//    * The numbers only mean something separated. Circuit setup, the
//      exit's own round trip, and the rate the payload streams at are
//      three different things, and averaging them produces a figure
//      that is neither latency nor bandwidth. connectMs, ttfbMs and
//      kbps are reported apart, and kbps is measured over the body
//      window alone (first body byte -> last byte seen).
//    * Running out of time is a measurement here, not a failure. An
//      exit that delivers 180 KiB in 25 s has told us exactly what we
//      wanted to know, so a timeout resolves with the bytes counted so
//      far as long as the sample is big enough to mean anything.
//
//  kbps is deliberately null rather than a large wrong number when the
//  sample is too small or too short: a payload that lands inside one or
//  two TCP reads is measuring the read loop, not the circuit. Callers
//  must treat null as "not measured" -- never as slow, and never as a
//  zero to sort by.
//
//  Byte counting is of the raw stream, so a chunked response includes
//  its own chunk-length lines. At the payload sizes used here that
//  overhead is a fraction of a percent, and it is the same fraction for
//  every relay being compared, which is what matters for ranking.
async function socksMeasure(url, opts = {}) {
    const {
        socksHost = '127.0.0.1',
        socksPort,
        timeoutMs = 25000,
        userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) FreeProxyVPN/2.0',
        maxBytes = 1024 * 1024,
        minBytes = 64 * 1024,
        minStreamMs = 250,
    } = opts;
    if (!socksPort) throw new Error('socksMeasure: socksPort is required');

    const u = new URL(url);
    const isTls = u.protocol === 'https:';
    const destPort = u.port ? Number(u.port) : (isTls ? 443 : 80);

    const tDial = Date.now();
    const rawSock = await socks5Connect({
        socksHost, socksPort, destHost: u.hostname, destPort, timeoutMs,
    });
    const connectMs = Date.now() - tDial;

    return new Promise((resolve, reject) => {
        let settled = false;
        let head = Buffer.alloc(0), headerDone = false;
        let status = 0, bytes = 0;
        let tReq = 0, tFirst = 0, tLast = 0;

        const finish = (err, val) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try { stream.destroy(); } catch (e) {}
            try { rawSock.destroy(); } catch (e) {}
            err ? reject(err) : resolve(val);
        };

        //  One exit: whatever stopped the read, the answer is assembled the
        //  same way, so "ran to maxBytes" and "ran out of clock" are the same
        //  kind of result and differ only in stoppedBy.
        const done = why => {
            if (settled) return;
            if (!status) {
                return finish(new Error(
                    `no HTTP response through the tunnel (${why}, ${bytes} body bytes)`));
            }
            const streamMs = Math.max(0, tLast - tFirst);
            const enough = bytes >= minBytes && streamMs >= minStreamMs;
            finish(null, {
                status, bytes, connectMs,
                ttfbMs: tFirst ? tFirst - tReq : null,
                streamMs,
                kbps: enough ? (bytes / 1024) / (streamMs / 1000) : null,
                why: enough ? null
                            : `sample too small to rate: ${bytes} B in ${streamMs} ms`,
                stoppedBy: why,
            });
        };

        const timer = setTimeout(() => done('timeout'), timeoutMs);

        const stream = isTls
            ? tls.connect({
                  socket: rawSock,
                  servername: u.hostname,
                  ALPNProtocols: ['http/1.1'],
              })
            : rawSock;

        stream.on('error', e => {
            //  A server that closes hard after sending a full payload is not a
            //  failed measurement, so an error with a usable sample behind it
            //  resolves like any other stop.
            if (status && bytes >= minBytes) return done('reset');
            finish(new Error('stream: ' + e.message));
        });

        stream.on('data', d => {
            const now = Date.now();
            if (!headerDone) {
                head = head.length ? Buffer.concat([head, d]) : d;
                const sep = head.indexOf('\r\n\r\n');
                if (sep < 0) {
                    if (head.length > 64 * 1024) {
                        return finish(new Error('response header exceeded 64 KiB'));
                    }
                    return;
                }
                const m = /^HTTP\/1\.[01] (\d{3})/
                    .exec(head.subarray(0, 64).toString('latin1'));
                if (!m) return finish(new Error('malformed HTTP status line'));
                status = Number(m[1]);
                headerDone = true;
                //  The clock for the body starts at its first byte, not at the
                //  header's -- so a slow exit's think time lands in ttfbMs and
                //  cannot flatter or punish the rate that follows.
                bytes = head.length - (sep + 4);
                tFirst = now;
                tLast = now;
                head = Buffer.alloc(0);
                if (bytes >= maxBytes) done('maxBytes');
                return;
            }
            bytes += d.length;
            tLast = now;
            if (bytes >= maxBytes) done('maxBytes');
        });
        stream.on('end', () => done('end'));
        stream.on('close', () => done('close'));

        const request =
            `GET ${u.pathname}${u.search} HTTP/1.1\r\n` +
            `Host: ${u.host}\r\n` +
            `User-Agent: ${userAgent}\r\n` +
            `Accept: */*\r\n` +
            `Accept-Encoding: identity\r\n` +
            `Connection: close\r\n\r\n`;

        const send = () => { tReq = Date.now(); stream.write(request); };
        if (isTls) stream.on('secureConnect', send);
        else send();
    });
}

// ── Public: GET a URL directly (no proxy), for the pre-connect phase ─
function directGet(url, opts = {}) {
    const { timeoutMs = 10000, maxBytes = 8 * 1024 * 1024 } = opts;
    const https = require('https');
    const http = require('http');
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;

    return new Promise((resolve, reject) => {
        const req = mod.get(url, {
            headers: {
                'User-Agent': 'FreeProxyVPN/2.0',
                'Accept': 'application/json',
                'Accept-Encoding': 'identity',
            },
            timeout: timeoutMs,
        }, res => {
            const chunks = [];
            let received = 0;
            res.on('data', d => {
                received += d.length;
                if (received <= maxBytes) chunks.push(d);
            });
            res.on('end', () => resolve({
                status: res.statusCode,
                headers: res.headers,
                body: Buffer.concat(chunks).toString('utf8'),
            }));
        });
        req.on('timeout', () => { req.destroy(new Error('direct request timeout')); });
        req.on('error', reject);
    });
}

module.exports = { socksGet, socksMeasure, directGet };
