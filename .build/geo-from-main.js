'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/geo-from-main.js  --  read main.js's own tables, do not copy them.
//
//  The globe used to keep its own copy of GEO_COORDS and the two drifted: the
//  globe's was missing md, cy, cr and sc, so choosing Moldova drew the "you are
//  here" ring at 0,0 in the Gulf of Guinea while the app was correctly spoofing
//  Chisinau -- a ring in a place the app was not. The fix was to delete the
//  second copy and ask main.js for the first over IPC.
//
//  A test fixture with a third copy would be able to pass while the shipped pair
//  disagreed, which is the one thing it must not be able to do. So the probes
//  lift the real literals out of main.js instead.
//
//  The same trap had already closed on the exit-country fallback list:
//  test-engine.js carried a hand-typed copy listing ie, hu, pt, gr and br, and
//  reported "DEAD: ie,br" against live Onionoo long after main.js had stopped
//  offering any of them. The list it was really testing was its own.
// ════════════════════════════════════════════════════════════════════
const fs   = require('fs');
const path = require('path');

const readMain = root => fs.readFileSync(path.join(root, 'main.js'), 'utf8');

//  From the first `open` at or after `from`, return the whole balanced literal
//  including its closing brace. Depth counting, not a regex: both of these
//  tables are nested one level deep, and GEO_COORDS ends on a line that a
//  `\r\n};` marker only matches by luck.
function literalAt(src, from, open = '{', close = '}') {
    const a = src.indexOf(open, from);
    if (a < 0) throw new Error(`no ${open} after offset ${from}`);
    let depth = 0;
    for (let i = a; i < src.length; i++) {
        if (src[i] === open) depth++;
        else if (src[i] === close && --depth === 0) return src.slice(a, i + 1);
    }
    throw new Error(`the literal opened at ${a} is never closed`);
}

//  A pure data literal, out of this project's own source, read by this project's
//  own build tooling. Nothing off the network is evaluated here.
const evalLiteral = text => new Function('return ' + text)();

function geoFromMainJs(root = path.join(__dirname, '..')) {
    const src = readMain(root);
    const at  = src.indexOf('const GEO_COORDS = {');
    if (at < 0) throw new Error('main.js no longer declares GEO_COORDS');
    const table = evalLiteral(literalAt(src, at));
    if (!table || typeof table !== 'object' || Object.keys(table).length < 20)
        throw new Error('GEO_COORDS parsed to something that is not the table');
    return table;
}

//  The built-in exit-country list, RAW -- as written, before spoofableOnly()
//  intersects it with GEO_COORDS. A stale entry has to stay visible here: the
//  filter that would quietly drop it is the thing being cross-checked.
function fallbackFromMainJs(root = path.join(__dirname, '..')) {
    const src = readMain(root);
    const at  = src.indexOf("Logger.warn('Using built-in exit-country fallback list');");
    if (at < 0) throw new Error('main.js no longer logs a built-in fallback list');
    const table = evalLiteral(literalAt(src, src.indexOf('spoofableOnly(', at)));
    const bad = Object.entries(table || {}).filter(([, v]) =>
        !v || !Number.isFinite(v.count) || !Number.isFinite(v.bandwidth));
    if (!table || Object.keys(table).length < 10 || bad.length)
        throw new Error('the fallback list parsed to something that is not the table: ' +
                        JSON.stringify(bad.map(([k]) => k)));
    return table;
}

//  main.js's own haversine, lifted rather than retyped, for the same reason as
//  the tables above. The README's screenshots print a distance -- the ask
//  dialog says "the nearest country (India, about N km away)" -- and N has to
//  be the number the app would put there, computed by the app's formula from
//  the app's coordinates. A second implementation here could be off by a
//  rounding and the picture would be showing a sentence the app never sends.
function haversineFromMainJs(root = path.join(__dirname, '..')) {
    const src = readMain(root);
    const at  = src.indexOf('function haversineKm(a, b) {');
    if (at < 0) throw new Error('main.js no longer declares haversineKm(a, b)');
    const body = literalAt(src, at);
    const fn   = new Function('a', 'b', body.slice(1, -1));
    //  A known pair, so a formula that parsed but does not compute fails here:
    //  London to Paris is 343 km.
    const probe = Math.round(fn({ lat: 51.5074, lng: -0.1278 }, { lat: 48.8566, lng: 2.3522 }));
    if (!(probe > 330 && probe < 355))
        throw new Error(`haversineKm lifted from main.js returned ${probe} km for London-Paris`);
    return fn;
}

module.exports = { geoFromMainJs, fallbackFromMainJs, haversineFromMainJs, literalAt };
