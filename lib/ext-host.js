'use strict';
// ════════════════════════════════════════════════════════════════════
//  lib/ext-host.js  --  serve the signed extension to the browsers
//
//  ExtensionInstallForcelist takes `<id>;<update_url>`, and the update_url
//  has to be something the browser can actually fetch. Chromium's extension
//  updater goes through the network stack, which does not load file:// URLs,
//  so the manifest is served over HTTP from the loopback interface instead.
//
//  Bound to 127.0.0.1 explicitly, never 0.0.0.0: this is only ever talked to
//  by browsers on this machine, and a VPN app that opens a listener to the
//  local network while claiming to protect you would be self-defeating.
//
//  Two routes, both static:
//      GET /updates.xml         -- the Omaha update manifest
//      GET /freeproxy-geo.crx   -- the signed package
//  Anything else gets 404. There is no path handling at all, so nothing here
//  can be talked into reading a file it was not given.
// ════════════════════════════════════════════════════════════════════

const http = require('http');

const MANIFEST_PATH = '/updates.xml';
const CRX_PATH      = '/freeproxy-geo.crx';

class ExtHost {
    /** @param {{log: object, ports?: number[]}} opts */
    constructor({ log, ports }) {
        this.log     = log;
        this.ports   = ports || [8081, 8082, 8083, 8084, 8085];
        this.server  = null;
        this.port    = null;
        this.payload = null;    // { xml: string, crx: Buffer, id, version }
    }

    /** The update_url to put in the policy, or null when not listening. */
    updateUrl() {
        return this.port ? `http://127.0.0.1:${this.port}${MANIFEST_PATH}` : null;
    }

    /** Replace what is being served. Safe to call while running. */
    setPayload(payload) {
        this.payload = payload;
    }

    /**
     * Start listening, trying each candidate port in turn.
     * @returns {Promise<number|null>} the bound port, or null if none worked
     */
    start() {
        if (this.server) return Promise.resolve(this.port);

        const server = http.createServer((req, res) => {
            const route = (req.url || '').split('?')[0];
            const p = this.payload;

            //  HEAD is answered like GET minus the body: Chromium's updater
            //  probes with it in some builds and a 404 there aborts the whole
            //  update check.
            if (!p || (req.method !== 'GET' && req.method !== 'HEAD')) {
                res.writeHead(404).end();
                return;
            }
            if (route === MANIFEST_PATH) {
                const body = Buffer.from(p.xml, 'utf8');
                res.writeHead(200, {
                    'Content-Type': 'text/xml; charset=utf-8',
                    'Content-Length': body.length,
                    'Cache-Control': 'no-store',
                });
                res.end(req.method === 'HEAD' ? undefined : body);
                this.log.debug('Extension update manifest served');
                return;
            }
            if (route === CRX_PATH) {
                res.writeHead(200, {
                    'Content-Type': 'application/x-chrome-extension',
                    'Content-Length': p.crx.length,
                    'Cache-Control': 'no-store',
                });
                res.end(req.method === 'HEAD' ? undefined : p.crx);
                this.log.info(`Extension package downloaded by a browser (${(p.crx.length / 1024).toFixed(0)} KB)`);
                return;
            }
            res.writeHead(404).end();
        });

        //  A stray request must never take the VPN down with it.
        server.on('clientError', (err, sock) => { try { sock.destroy(); } catch (e) {} });

        return new Promise(resolve => {
            const tryPort = i => {
                if (i >= this.ports.length) {
                    this.log.warn('Could not open a loopback port for the browser extension -- ' +
                                  `tried ${this.ports.join(', ')}. Chromium location spoofing is unavailable.`);
                    return resolve(null);
                }
                const port = this.ports[i];
                const onErr = e => {
                    server.removeListener('error', onErr);
                    if (e && (e.code === 'EADDRINUSE' || e.code === 'EACCES')) return tryPort(i + 1);
                    this.log.warn('Extension host failed to start: ' + e.message);
                    resolve(null);
                };
                server.once('error', onErr);
                server.listen(port, '127.0.0.1', () => {
                    server.removeListener('error', onErr);
                    //  From here on an error is a runtime hiccup, not a bind
                    //  failure, and must not be thrown at the process.
                    server.on('error', e => this.log.warn('Extension host: ' + e.message));
                    this.server = server;
                    this.port = port;
                    this.log.debug(`Extension host listening on 127.0.0.1:${port}`);
                    resolve(port);
                });
            };
            tryPort(0);
        });
    }

    stop() {
        //  Deliberately NOT called on disconnect. A browser that is still
        //  running may re-check the update manifest, and a dead port makes it
        //  log a hard failure. The listener costs nothing and goes away with
        //  the process.
        if (!this.server) return;
        try { this.server.close(); } catch (e) {}
        this.server = null;
        this.port = null;
    }
}

module.exports = { ExtHost, MANIFEST_PATH, CRX_PATH };
