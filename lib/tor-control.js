'use strict';
// ════════════════════════════════════════════════════════════════════
//  tor-control.js -- Tor ControlPort client (cookie authentication)
//
//  WHY THIS EXISTS
//  ---------------
//  The old exit-country remediation loop did this on every mismatch:
//      taskkill tor.exe
//      delete cached-certs / cached-microdesc-consensus / cached-microdescs
//      respawn tor.exe
//      await sleep(12000)          <-- blind fixed wait
//  Wiping the consensus cache forces Tor to re-download ~9600 relay
//  descriptors, which takes far longer than 12 s. So the verification
//  that ran after the sleep hit a Tor that was still bootstrapping,
//  every geo query failed, and the failure was misreported as
//  "curl unavailable" -- the app then kept the *requested* country.
//
//  Tor already exposes exactly the right tool for this: the control
//  port. SETCONF ExitNodes=... re-pins the exit and invalidates the
//  circuits that violate the new restriction, in about a second, with
//  no process restart and no cache loss. GETINFO circuit-status lets us
//  wait for a real BUILT circuit instead of guessing with a timer.
// ════════════════════════════════════════════════════════════════════

const net = require('net');
const fs = require('fs');

class TorControl {
    constructor({ host = '127.0.0.1', port = 9051, cookiePath, logger } = {}) {
        this.host = host;
        this.port = port;
        this.cookiePath = cookiePath;
        this.log = logger || { debug() {}, warn() {} };
        this.sock = null;
        this.buf = '';
        this.queue = [];          // pending { resolve, reject, lines }
        this.authenticated = false;
    }

    // ── Connect + authenticate ──────────────────────────────────────
    async open({ timeoutMs = 8000 } = {}) {
        await new Promise((resolve, reject) => {
            const sock = net.connect({ host: this.host, port: this.port });
            const timer = setTimeout(() => {
                try { sock.destroy(); } catch (e) {}
                reject(new Error('control port connect timeout'));
            }, timeoutMs);

            sock.once('connect', () => {
                clearTimeout(timer);
                this.sock = sock;
                sock.setEncoding('utf8');
                sock.on('data', d => this._onData(d));
                sock.on('error', e => this._failAll('control socket: ' + e.message));
                sock.on('close', () => this._failAll('control socket closed'));
                resolve();
            });
            sock.once('error', e => {
                clearTimeout(timer);
                reject(new Error('control port connect: ' + e.message));
            });
        });

        // Cookie auth: send the raw cookie bytes as hex. The cookie file is
        // created by Tor at startup and readable only by our (elevated)
        // process, so no password ends up in the config or in the logs.
        let hex = '';
        try {
            hex = fs.readFileSync(this.cookiePath).toString('hex');
        } catch (e) {
            throw new Error('cannot read control auth cookie: ' + e.message);
        }
        await this.cmd(`AUTHENTICATE ${hex}`);
        this.authenticated = true;
        this.log.debug('Tor control port authenticated');
    }

    close() {
        this._failAll('control connection closed by client');
        try { this.sock && this.sock.destroy(); } catch (e) {}
        this.sock = null;
        this.authenticated = false;
    }

    get isOpen() { return !!this.sock && !this.sock.destroyed; }

    // ── Reply framing ───────────────────────────────────────────────
    //  A Tor control reply is a sequence of lines. Intermediate lines
    //  are "NNN-text" or start a data block with "NNN+text" (terminated
    //  by a lone "."). The reply ends with "NNN text" (space).
    _onData(chunk) {
        this.buf += chunk;
        for (;;) {
            const nl = this.buf.indexOf('\r\n');
            if (nl < 0) break;
            const line = this.buf.slice(0, nl);
            this.buf = this.buf.slice(nl + 2);

            const pending = this.queue[0];
            if (!pending) continue;
            pending.lines.push(line);

            if (/^\d{3} /.test(line)) {
                this.queue.shift();
                const code = parseInt(line.slice(0, 3), 10);
                if (code >= 200 && code < 300) pending.resolve(pending.lines);
                else pending.reject(new Error(`tor control ${code}: ${line.slice(4)}`));
            }
        }
    }

    _failAll(msg) {
        const q = this.queue;
        this.queue = [];
        q.forEach(p => p.reject(new Error(msg)));
    }

    cmd(command, { timeoutMs = 15000 } = {}) {
        if (!this.isOpen) return Promise.reject(new Error('control port not open'));
        return new Promise((resolve, reject) => {
            const entry = { lines: [], resolve, reject };
            const timer = setTimeout(() => {
                const i = this.queue.indexOf(entry);
                if (i >= 0) this.queue.splice(i, 1);
                reject(new Error(`tor control timeout: ${command.split(' ')[0]}`));
            }, timeoutMs);
            entry.resolve = v => { clearTimeout(timer); resolve(v); };
            entry.reject  = e => { clearTimeout(timer); reject(e); };
            this.queue.push(entry);
            this.sock.write(command + '\r\n');
        });
    }

    // ── Typed helpers ───────────────────────────────────────────────
    async getInfo(key) {
        const lines = await this.cmd(`GETINFO ${key}`);
        const out = [];
        for (const line of lines) {
            if (/^\d{3} OK$/.test(line)) continue;
            // "250-key=value", "250+key=" (block follows), or a raw block line
            const m = /^\d{3}[-+](.*)$/.exec(line);
            let text = m ? m[1] : line;
            if (text === '.') continue;
            if (text.startsWith(key + '=')) text = text.slice(key.length + 1);
            if (text !== '') out.push(text);
        }
        return out.join('\n');
    }

    // Values are always quoted: ExitNodes contains '$' and ',' which the
    // control protocol would otherwise treat as separators.
    setConf(pairs) {
        const parts = Object.entries(pairs).map(([k, v]) => {
            if (v === null || v === undefined || v === '') return k;   // reset to default
            return `${k}="${String(v).replace(/(["\\])/g, '\\$1')}"`;
        });
        return this.cmd('SETCONF ' + parts.join(' '));
    }

    resetConf(keys) {
        return this.cmd('RESETCONF ' + keys.join(' '));
    }

    signal(sig) { return this.cmd('SIGNAL ' + sig); }

    // ── Circuit inspection ──────────────────────────────────────────
    //  Returns [{ id, status, purpose, buildFlags, internal, hops:[{fp,nick}], exit }]
    async circuits() {
        const raw = await this.getInfo('circuit-status');
        return raw.split('\n').filter(Boolean).map(line => {
            const parts = line.trim().split(' ');
            const id = parts[0];
            const status = parts[1];
            const pathField = parts[2] && parts[2].startsWith('$') ? parts[2] : '';
            const purposeMatch = /PURPOSE=(\S+)/.exec(line);
            const flagMatch = /BUILD_FLAGS=(\S+)/.exec(line);
            const buildFlags = flagMatch ? flagMatch[1].split(',') : [];
            const hops = pathField ? pathField.split(',').map(h => {
                const [fp, nick] = h.replace(/^\$/, '').split('~');
                return { fp: (fp || '').toUpperCase(), nick: nick || '' };
            }) : [];
            return {
                id, status,
                purpose: purposeMatch ? purposeMatch[1] : '',
                buildFlags,
                //  Directory tunnels, timeout probes and onion-service
                //  vanguard circuits. They never carry an exit stream, so
                //  their last hop is not an exit -- counting it as one is
                //  how a plain guard relay ends up reported as a second
                //  exit country.
                internal: buildFlags.includes('IS_INTERNAL') ||
                          buildFlags.includes('ONEHOP_TUNNEL'),
                hops,
                exit: hops.length ? hops[hops.length - 1] : null,
            };
        });
    }

    //  Circuits that application traffic can actually be attached to.
    //  CONFLUX_* belongs here: Tor 0.4.8 builds most exit circuits as
    //  conflux sets, and leaving them out meant the majority of real exit
    //  circuits were invisible to every check in this file.
    static get APP_PURPOSES() {
        return new Set(['', 'GENERAL', 'CONFLUX_UNLINKED', 'CONFLUX_LINKED']);
    }

    _isAppCircuit(c) {
        return TorControl.APP_PURPOSES.has(c.purpose) && !c.internal && c.hops.length >= 2;
    }

    //  The exit of the circuits currently available for application
    //  traffic. Multiple distinct values here is precisely the condition
    //  that produced DNS answers from five different countries.
    async activeExits() {
        const cs = await this.circuits();
        const exits = cs
            .filter(c => c.status === 'BUILT' && this._isAppCircuit(c) && c.exit)
            .map(c => c.exit);
        const seen = new Set();
        return exits.filter(e => (seen.has(e.fp) ? false : (seen.add(e.fp), true)));
    }

    //  Highest circuit id Tor has handed out so far. Ids are assigned
    //  incrementally, so this is a cheap "now" marker: any circuit with an
    //  id at or below it was LAUNCHED before this call, and therefore
    //  before whatever SETCONF comes next.
    async maxCircuitId() {
        let hi = 0;
        try {
            for (const c of await this.circuits()) {
                const n = parseInt(c.id, 10);
                if (Number.isFinite(n) && n > hi) hi = n;
            }
        } catch (e) { /* treat as no marker */ }
        return hi;
    }

    //  Tear down every circuit that could carry traffic but does not end
    //  at `fp`.
    //
    //  This is the difference between asking for a country and getting it.
    //  ExitNodes and StrictNodes are enforced when a circuit is BUILT, not
    //  when a stream is attached to one, so after SETCONF the circuits that
    //  were already standing still end at the previous exit and Tor will
    //  keep handing new streams to them. SIGNAL NEWNYM does not help: it
    //  only retires circuits that have already carried a stream, and Tor
    //  keeps a pool of clean pre-built ones that it has not.
    //
    //  Measured, before this existed: switch LU -> DE, and the very first
    //  request comes out in Germany while every request after it comes out
    //  in Luxembourg again. That is the country-hopping in the bug report,
    //  and it is also how one page's DNS lookups ended up answered from
    //  five different countries at once.
    //
    //  `staleIdMax` closes half-built circuits too. A circuit sitting at
    //  EXTENDED with hops=0 has no exit to compare yet, but it was launched
    //  under the OLD ExitNodes and Tor does not re-check the restriction
    //  when it finishes -- so it completes on the old exit minutes later and
    //  quietly becomes attachable again. Passing the id marker taken before
    //  SETCONF closes exactly those, and nothing that was launched after.
    async purgeCircuitsExcept(fp, { staleIdMax = 0 } = {}) {
        const want = fp.replace(/^\$/, '').toUpperCase();
        let closed = 0;
        let cs = [];
        try { cs = await this.circuits(); } catch (e) { return 0; }
        for (const c of cs) {
            //  Internal plumbing is left alone -- closing directory tunnels
            //  just makes Tor rebuild them, and they carry no exit traffic.
            if (c.internal) continue;
            if (!TorControl.APP_PURPOSES.has(c.purpose)) continue;

            if (c.hops.length >= 2) {
                if (c.exit && c.exit.fp === want) continue;      // conforms
            } else {
                //  Exit not known yet. Only condemn it if it predates the
                //  config change; otherwise it is a fresh circuit being
                //  built under the restriction we just set.
                const id = parseInt(c.id, 10);
                if (!(staleIdMax && Number.isFinite(id) && id <= staleIdMax)) continue;
            }

            try { await this.cmd('CLOSECIRCUIT ' + c.id, { timeoutMs: 5000 }); closed++; }
            catch (e) { /* already gone */ }
        }
        if (closed && this.log) {
            this.log.debug(`Closed ${closed} circuit(s) not ending at ${want.slice(0, 8)}`);
        }
        return closed;
    }

    //  Close every circuit that could carry application traffic, leaving Tor's
    //  own internal plumbing alone.
    //
    //  Used when the app is about to stop claiming a country -- while it is
    //  asking the user what to do about a country it could not verify, or while
    //  it is waiting for one to become available. The circuits standing at that
    //  moment end at relays that were just MEASURED in the wrong country, and
    //  the browser is already pointed at this Tor. Leaving them attachable would
    //  send pages out through a country the app is in the middle of telling the
    //  user it could not reach. With ExitNodes/StrictNodes set to the country
    //  they asked for, no replacement circuit can be built for the wrong one --
    //  so pages fail to load, which is the safe direction to fail in.
    async closeAppCircuits() {
        let cs = [];
        try { cs = await this.circuits(); } catch (e) { return 0; }
        let closed = 0;
        for (const c of cs) {
            if (c.internal) continue;
            if (!TorControl.APP_PURPOSES.has(c.purpose)) continue;
            try { await this.cmd('CLOSECIRCUIT ' + c.id, { timeoutMs: 5000 }); closed++; }
            catch (e) { /* already gone */ }
        }
        if (closed && this.log) this.log.debug(`Closed ${closed} application circuit(s)`);
        return closed;
    }

    //  Wait until a BUILT circuit that can carry traffic terminates at `fp`.
    //  This replaces the old blind `await sleep(12000)`.
    async waitForExit(fp, { timeoutMs = 25000, pollMs = 700 } = {}) {
        const want = fp.replace(/^\$/, '').toUpperCase();
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            let exits = [];
            try { exits = await this.activeExits(); } catch (e) { /* retry */ }
            if (exits.some(e => e.fp === want)) return true;
            if (Date.now() >= deadline) return false;
            await new Promise(r => setTimeout(r, pollMs));
        }
    }

    //  Address of a relay according to the live consensus. Used for logging
    //  and for the IPv4-only check -- never as a source of country truth,
    //  because Tor's bundled GeoIP file is what disagreed with ipleak.net
    //  in the first place.
    async relayAddress(fp) {
        try {
            const ns = await this.getInfo(`ns/id/${fp.replace(/^\$/, '').toUpperCase()}`);
            const r = ns.split('\n').find(l => l.startsWith('r '));
            if (!r) return null;
            const f = r.split(' ');
            return { ip: f[6] || null, orPort: f[7] || null };
        } catch (e) { return null; }
    }

    //  Drop every existing circuit so the next stream is forced onto a
    //  circuit that honours the restrictions we just set. Tor rate-limits
    //  NEWNYM to roughly once per 10 s, so callers should not spam it.
    async newIdentity() {
        try { await this.signal('NEWNYM'); return true; }
        catch (e) { this.log.warn('NEWNYM failed: ' + e.message); return false; }
    }
}

module.exports = { TorControl };
