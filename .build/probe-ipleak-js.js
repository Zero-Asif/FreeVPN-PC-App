'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/probe-ipleak-js.js  --  READ-ONLY, direct (not through Tor).
//
//  probe-ipleak-how.js found that ipleak's page names ipv4./ipv6. hosts on
//  three ports: 443, 8000 and 62222. Which port the IPv4 ROW uses decides
//  everything: 443 through Tor is ordinary, 8000 is allowed by Tor's reduced
//  exit policy, and 62222 is in neither the default nor the reduced list -- so
//  if the row depends on 62222 it fails on most exits no matter what we do, and
//  no fix on our side can make that row appear.
// ════════════════════════════════════════════════════════════════════
const { directGet } = require('../lib/socks-fetch');

(async () => {
    const r = await directGet('https://ipleak.net/static/js/index.js?ts=20220812',
                              { timeoutMs: 20000 });
    console.log(`index.js -> HTTP ${r.status}, ${r.body.length} bytes\n`);
    const src = r.body;

    //  Print each line that names a per-family host or one of the odd ports,
    //  with its line number, so the mapping row -> URL is read off the source
    //  rather than assumed.
    const lines = src.split(/\r?\n/);
    const want = /ipv4|ipv6|8000|62222|62223|ws:|wss:|torrent|dns_|geo_|ip_/i;
    let shown = 0;
    lines.forEach((ln, i) => {
        if (!want.test(ln)) return;
        if (shown++ > 70) return;
        console.log(String(i + 1).padStart(5) + ': ' + ln.trim().slice(0, 190));
    });
    console.log(`\n(${shown} matching lines${shown > 70 ? ', truncated' : ''})`);
})().catch(e => { console.log('ABORT: ' + e.message); process.exit(3); });
