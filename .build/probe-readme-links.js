//  .build/probe-readme-links.js
//
//  A README that links to its own sections, to files in this repo and to
//  line numbers in those files can rot in three different ways at once:
//  a heading gets reworded and the anchor dies, a file gets renamed, or
//  code moves and `main.js#L1896` now points at a blank line. None of the
//  three shows up when you look at the page -- GitHub renders a dead
//  anchor as ordinary text you can click and nothing happens.
//
//  So this checks all three, for every markdown document in the root and
//  in docs/. It reads nothing off the network.
//
//    node .build/probe-readme-links.js
//
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

//  GitHub's own slug rule, copied from github-slugger's behaviour rather
//  than guessed at: lowercase, drop everything that is not a word
//  character, a space or a hyphen, then replace each space with a hyphen
//  ONE AT A TIME. That last detail is the one that bites: an em dash in a
//  heading leaves two spaces behind, and GitHub turns those into TWO
//  hyphens. Collapsing them with /\s+/ produced a slug that looked right
//  and did not exist -- this probe reported a live anchor dead and, worse,
//  would have reported a dead one live.
function slug(heading) {
    return heading
        .trim()
        .toLowerCase()
        .replace(/`/g, '')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')   // link text only
        .replace(/[^\w\s-]/g, '')
        .replace(/ /g, '-');
}

const docs = [];
for (const f of fs.readdirSync(ROOT)) if (f.endsWith('.md')) docs.push(f);
const docsDir = path.join(ROOT, 'docs');
if (fs.existsSync(docsDir)) {
    (function walk(dir) {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) walk(p);
            else if (e.name.endsWith('.md')) docs.push(path.relative(ROOT, p).replace(/\\/g, '/'));
        }
    })(docsDir);
}

let failed = 0, checked = 0;
const say = (ok, msg) => { if (!ok) failed++; console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${msg}`); };

for (const doc of docs) {
    const abs = path.join(ROOT, doc);
    const text = fs.readFileSync(abs, 'utf8');
    const here = path.dirname(abs);

    //  Every ATX heading in this document, as an anchor set.
    const anchors = new Set();
    for (const m of text.matchAll(/^#{1,6}[ \t]+(.+?)[ \t]*$/gm)) anchors.add(slug(m[1]));
    //  Explicit <a name>/<a id> and heading ids, if any.
    for (const m of text.matchAll(/<a\s+(?:name|id)="([^"]+)"/g)) anchors.add(m[1]);

    console.log(`\n${doc}`);
    let quiet = 0;

    for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
        const target = m[1];
        if (/^(https?:|mailto:|data:)/i.test(target)) continue;
        checked++;

        //  in-document anchor
        if (target.startsWith('#')) {
            const a = decodeURIComponent(target.slice(1));
            if (anchors.has(a)) { quiet++; continue; }
            say(false, `dead anchor  ${target}`);
            continue;
        }

        //  path, optionally with #Lnnn or #anchor
        const hash = target.indexOf('#');
        const rel = decodeURIComponent(hash === -1 ? target : target.slice(0, hash));
        const frag = hash === -1 ? '' : decodeURIComponent(target.slice(hash + 1));
        const dest = path.resolve(here, rel);

        if (!fs.existsSync(dest)) { say(false, `missing file  ${target}`); continue; }

        if (/^L\d+(-L\d+)?$/.test(frag)) {
            const want = parseInt(frag.slice(1).split('-')[0], 10);
            const lines = fs.readFileSync(dest, 'utf8').split('\n');
            if (want > lines.length) { say(false, `${rel}#L${want} past end of file (${lines.length} lines)`); continue; }
            if (!lines[want - 1].trim()) { say(false, `${rel}#L${want} is a blank line`); continue; }
        } else if (frag && rel.endsWith('.md')) {
            const other = fs.readFileSync(dest, 'utf8');
            const set = new Set();
            for (const h of other.matchAll(/^#{1,6}[ \t]+(.+?)[ \t]*$/gm)) set.add(slug(h[1]));
            if (!set.has(frag)) { say(false, `dead anchor in ${rel}  #${frag}`); continue; }
        }
        quiet++;
    }

    //  <img src> and <a href> written as HTML, which markdown link syntax misses.
    //  The in-page ones are not a formality to wave through: the top of the
    //  README navigates entirely in HTML, so `href="#a-heading"` written by hand
    //  is exactly where a reworded heading dies unnoticed. An earlier version of
    //  this loop skipped every target beginning with '#' along with the http
    //  ones, and so checked the pictures while ignoring the navigation.
    for (const m of text.matchAll(/<(?:img|a|source)\b[^>]*?\b(?:src|href)="([^"]+)"/g)) {
        const target = m[1];
        if (/^(https?:|mailto:|data:)/i.test(target)) continue;
        checked++;
        if (target.startsWith('#')) {
            const a = decodeURIComponent(target.slice(1));
            if (anchors.has(a)) quiet++;
            else say(false, `dead anchor  ${target}`);
            continue;
        }
        const hash = target.indexOf('#');
        const rel = decodeURIComponent(hash === -1 ? target : target.slice(0, hash));
        const frag = hash === -1 ? '' : decodeURIComponent(target.slice(hash + 1));
        const dest = path.resolve(here, rel);
        if (!fs.existsSync(dest)) { say(false, `missing asset  ${target}`); continue; }
        if (frag && rel.endsWith('.md')) {
            const set = new Set();
            for (const h of fs.readFileSync(dest, 'utf8').matchAll(/^#{1,6}[ \t]+(.+?)[ \t]*$/gm)) set.add(slug(h[1]));
            if (!set.has(frag)) { say(false, `dead anchor in ${rel}  #${frag}`); continue; }
        }
        quiet++;
    }

    console.log(`  ${quiet} ok`);
}

console.log(`\n${checked} local link${checked === 1 ? '' : 's'} checked, ${failed} failed.`);
process.exit(failed ? 1 : 0);
