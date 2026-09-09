//  Is detect() slow, or is this filesystem slow right now? It was 36/36 before
//  two `npm run dist` runs and 1700 ms after, with lib/browsers.js untouched.
//  Times the syscalls detect() is made of, so "the code got slower" and
//  "Defender is walking a 142 MB installer" stop looking the same.
'use strict';
const fs = require('fs');
const B = require('../lib/browsers.js');

const paths = [];
for (const b of B.ALL) {
    for (const p of (b.exePaths || [])) {
        const e = B.expand(p);
        if (e) paths.push(e);
    }
    for (const k of ['dataRoot', 'profileRoot']) {
        const e = b[k] ? B.expand(b[k]) : null;
        if (e) paths.push(e);
    }
}

let t = Date.now();
let hit = 0;
for (const p of paths) if (fs.existsSync(p)) hit++;
const one = Date.now() - t;

t = Date.now();
for (const p of paths) fs.existsSync(p);
const two = Date.now() - t;

console.log(`${paths.length} paths, ${hit} present`);
console.log(`first pass  ${one} ms  (${(one / paths.length).toFixed(1)} ms/stat)`);
console.log(`second pass ${two} ms  (${(two / paths.length).toFixed(1)} ms/stat)`);

//  A readdir of a real profile root, which is the other half of detect().
const roots = paths.filter(p => { try { return fs.statSync(p).isDirectory(); } catch (e) { return false; } });
t = Date.now();
let entries = 0;
for (const r of roots.slice(0, 8)) {
    try { entries += fs.readdirSync(r).length; } catch (e) {}
}
console.log(`readdir of ${Math.min(8, roots.length)} dirs: ${Date.now() - t} ms, ${entries} entries`);

B.resetCache();
t = Date.now();
B.detect();
console.log(`detect() cold: ${Date.now() - t} ms`);
