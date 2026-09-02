'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/probe-ipleak-timeout.js  --  READ-ONLY, direct (not through Tor).
//
//  A finding from .build/probe-ipleak.js worth chasing before blaming the
//  tunnel: ipleak.net answers DIRECTLY in ~13 SECONDS, while api.ipify.org
//  answers in 0.3. Anything with an AJAX timeout shorter than that fails on
//  ipleak's own latency, and adding Tor on top can only make it worse.
//
//  So: does IpLeak.fetch set a timeout, and how does its error path decide to
//  print "IPv4 test not reachable"? That is read out of the site's own source
//  rather than guessed at, because the answer changes what there is to fix --
//  a timeout we cannot shorten is not a bug in this app.
// ════════════════════════════════════════════════════════════════════
const { directGet } = require('../lib/socks-fetch');

(async () => {
    const r = await directGet('https://ipleak.net/static/js/index.js?ts=20220812',
                              { timeoutMs: 30000 });
    console.log(`index.js -> HTTP ${r.status}, ${r.body.length} bytes\n`);
    const lines = r.body.split(/\r?\n/);

    //  The whole of IpLeak.fetch, plus every line that mentions a timeout, a
    //  retry, or the task queue that drives the rows.
    const show = (from, to, why) => {
        console.log(`── ${why}  (lines ${from + 1}-${to})`);
        for (let i = from; i < to && i < lines.length; i++)
            console.log(String(i + 1).padStart(5) + ': ' + lines[i].slice(0, 200));
        console.log('');
    };

    const fetchAt = lines.findIndex(l => /fetch\s*[:=]\s*function|IpLeak\.fetch\s*=/.test(l));
    if (fetchAt >= 0) show(fetchAt, fetchAt + 30, 'IpLeak.fetch');
    else console.log('── IpLeak.fetch: not found by pattern\n');

    console.log('── every line naming a timeout, a retry or the queue ──');
    let n = 0;
    lines.forEach((l, i) => {
        if (!/timeout|timeOut|setTimeout|retry|tasks|ajaxSetup|async\s*:/i.test(l)) return;
        if (n++ > 45) return;
        console.log(String(i + 1).padStart(5) + ': ' + l.trim().slice(0, 200));
    });
    console.log(`\n(${n} matching lines${n > 45 ? ', truncated' : ''})`);
})().catch(e => { console.log('ABORT: ' + e.message); process.exit(3); });
