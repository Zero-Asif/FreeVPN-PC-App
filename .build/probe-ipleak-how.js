'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/probe-ipleak-how.js  --  READ-ONLY, and it does NOT go through Tor.
//
//  Question: which hostnames does ipleak.net's "Your IP addresses" panel
//  actually ask, and by what mechanism? Without that, "no IPv4 shown" cannot be
//  told apart from "the row's own probe could not run", and the two want
//  opposite fixes.
//
//  This only reads the site's own front page and prints the detection endpoints
//  it names. No project data leaves the machine; the request carries nothing but
//  a GET for the page the user was already looking at.
// ════════════════════════════════════════════════════════════════════
const { directGet } = require('../lib/socks-fetch');

const PAT = [
    ['per-family hostnames',   /https?:\/\/[a-z0-9.-]*ipleak\.net[^"'\s)]*/gi],
    ['RTCPeerConnection use',  /RTCPeerConnection|webkitRTC|mozRTC/g],
    ['random-subdomain DNS',   /[a-z0-9]{6,}\.ipleak\.net/gi],
    ['fetch/XHR targets',      /(?:fetch|open)\s*\(\s*['"][^'"]{4,120}['"]/gi],
];

(async () => {
    const r = await directGet('https://ipleak.net/', { timeoutMs: 20000 });
    console.log(`GET https://ipleak.net/  ->  HTTP ${r.status}, ${r.body.length} bytes\n`);
    for (const [label, re] of PAT) {
        const hits = [...new Set((r.body.match(re) || []).map(s => s.trim()))];
        console.log(`── ${label}  (${hits.length})`);
        console.log(hits.length ? '   ' + hits.slice(0, 25).join('\n   ') : '   (none)');
        console.log('');
    }
    //  Script files are where the work usually is; name them so a second pass
    //  can read the right one instead of the whole site.
    const scripts = [...new Set((r.body.match(/<script[^>]+src=["']([^"']+)["']/gi) || []))];
    console.log('── script tags\n   ' + (scripts.join('\n   ') || '(none)'));
})().catch(e => { console.log('ABORT: ' + e.message); process.exit(3); });
