'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/probe-readme-art.js  --  look at the artwork before shipping it.
//
//  Run:  node_modules/electron/dist/electron.exe .build/probe-readme-art.js
//  Out:  .build/art-preview/*.png   (previews only -- never touched by the
//        README, which embeds the .svg files themselves)
//
//  WHY
//  An SVG that is malformed, or whose text overflows its viewBox, still
//  "writes successfully". The only way to know a banner looks like a banner
//  is to render it and look, so this loads every docs/media/*.svg at its own
//  intrinsic size, screenshots it, and fails on:
//
//    * an XML parse error (GitHub would show a broken image)
//    * a <script> element (GitHub strips it; if the art needs it, the art is
//      wrong -- SMIL and CSS animate fine inside an <img>)
//    * any external reference -- http(s), //, or url(...) off this disk --
//      because these images head a page that says the app talks to 127.0.0.1
//      and nothing else
//    * a blank or near-blank render
//    * geometry that spills outside the viewBox
//
//  Previews are rasterised at the SVG's own size with animations frozen a
//  beat in, so what lands in .build/art-preview is one frame of the real
//  thing, not an approximation of it.
// ════════════════════════════════════════════════════════════════════
const { app, BrowserWindow, session } = require('electron');
const path = require('path');
const fs   = require('fs');

const ROOT = path.join(__dirname, '..');
const MEDIA = path.join(ROOT, 'docs', 'media');
const OUT   = path.join(__dirname, 'art-preview');
const LOG   = path.join(__dirname, 'probe-readme-art.log');

try { fs.writeFileSync(LOG, ''); } catch (e) {}
const say = (...a) => {
    const line = a.join(' ');
    console.log(line);
    try { fs.appendFileSync(LOG, line + '\n'); } catch (e) {}
};
let win = null, fail = 0;
const netHits = [], consoleErrors = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const run = js => win.webContents.executeJavaScript(js, true);

//  Every .svg under docs/media, badges included, deepest last so the report
//  reads top-down like the README does.
function svgFiles(dir, rel = '') {
    const out = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const r = rel ? rel + '/' + e.name : e.name;
        if (e.isDirectory()) out.push(...svgFiles(path.join(dir, e.name), r));
        else if (e.name.endsWith('.svg')) out.push(r);
    }
    return out.sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
}

//  Source-level rules. These are about what GitHub will do with the file, so
//  they are checked against the bytes, before any renderer sees them.
function auditSource(rel, src) {
    const bad = [];
    //  Comments and namespace declarations are stripped before the URL check:
    //  xmlns="http://www.w3.org/2000/svg" is an identifier, not an address --
    //  nothing is ever fetched from it -- and every valid SVG carries it.
    let live = src.replace(/<!--[\s\S]*?-->/g, '')
                  .replace(/xmlns(:\w+)?\s*=\s*"[^"]*"/g, '');
    //  Human-readable content is lifted out too, and audited separately. A URL
    //  printed inside <text> is a label: the renderer draws the characters and
    //  fetches nothing, so the "no http(s)" rule -- which exists to stop this
    //  file loading something from the network -- must not fire on it. These
    //  diagrams have to be able to name the app's own loopback addresses.
    //  Only these four elements are exempted, and only their contents: a url()
    //  inside <style> really would fetch, so <style> is deliberately not here.
    let prose = '';
    for (let pass = 0; pass < 4; pass++) {
        const next = live.replace(/<(text|tspan|title|desc)(\s[^>]*)?>([\s\S]*?)<\/\1>/g,
            (m, tag, attrs, inner) => { prose += ' ' + inner; return `<${tag}></${tag}>`; });
        if (next === live) break;
        live = next;
    }
    if (/<script[\s>]/i.test(src))        bad.push('contains <script>, which GitHub strips');
    if (/\son\w+\s*=/i.test(src))         bad.push('contains an inline event handler');
    if (/https?:\/\//i.test(live))        bad.push('references an http(s) URL');
    if (/url\(\s*['"]?(https?:)?\/\//i.test(live)) bad.push('has a url() pointing off this disk');
    if (/<image[\s>]/i.test(src))         bad.push('embeds a raster <image>');
    if (!/viewBox=/.test(src))            bad.push('has no viewBox, so it cannot scale');
    if (!/role="img"/.test(src) && !/<title/.test(src))
        bad.push('has neither role="img" nor a <title>, so it is unreadable to a screen reader');
    //  A label may name a loopback address, because that is what this app talks
    //  to. A label naming somebody else's host is either a mistake or a claim
    //  this project should not be making in a picture, so it is still a failure.
    for (const u of (prose.match(/https?:\/\/[^\s<"'),]+/gi) || [])) {
        const host = (u.replace(/^https?:\/\//i, '').split(/[/:?#]/)[0] || '').toLowerCase();
        if (host !== '127.0.0.1' && host !== 'localhost')
            bad.push(`prints "${u}" as a label, and ${host} is not this machine`);
    }
    return bad;
}

//  The SVG's own intrinsic size, from its viewBox -- the window is sized to
//  it so one preview pixel is one SVG unit and nothing is scaled away.
function boxOf(src) {
    const m = /viewBox="([-\d.]+)\s+([-\d.]+)\s+([\d.]+)\s+([\d.]+)"/.exec(src);
    if (!m) return null;
    return { w: Math.ceil(+m[3]), h: Math.ceil(+m[4]) };
}

//  Two rows on purpose: GitHub serves the same file to a light-mode reader
//  and a dark-mode one, and art that vanishes on white is a bug this catches
//  in one look. The <img> is fed from a blob, which is exactly the sandbox
//  GitHub's <img> gives it -- no scripts, no external fetches.
const HARNESS = `<!doctype html><meta charset="utf-8"><style>
  html,body{margin:0;background:#3b3b3b;font:12px 'Segoe UI',sans-serif}
  #pane{display:inline-block}
  .row{display:block;line-height:0}
  .row.lt{background:#ffffff}.row.dk{background:#0d1117}
  #hold{position:absolute;left:-99999px;top:0}
</style><div id="pane"><div class="row lt"><img id="a"></div>
<div class="row dk"><img id="b"></div></div><div id="hold"></div>`;

async function measure(rel, src) {
    return await run(`(function () {
        var txt = ${JSON.stringify(src)};
        var doc = new DOMParser().parseFromString(txt, 'image/svg+xml');
        var perr = doc.querySelector('parsererror');
        if (perr) return { parseError: perr.textContent.replace(/\\s+/g, ' ').slice(0, 240) };
        var hold = document.getElementById('hold');
        hold.textContent = '';
        var node = document.importNode(doc.documentElement, true);
        hold.appendChild(node);
        var vb = node.viewBox.baseVal, bb = node.getBBox();
        var url = URL.createObjectURL(new Blob([txt], { type: 'image/svg+xml' }));
        var a = document.getElementById('a'), b = document.getElementById('b');
        //  Text only. Decorative shapes bleed past the frame on purpose here
        //  (the auroras are wider than the banner and are clipped by it), so a
        //  union bbox would fail every deliberate design. Words are the thing
        //  that must never be clipped, and words are what this measures.
        var texts = [];
        Array.prototype.forEach.call(node.querySelectorAll('text'), function (t) {
            var r; try { r = t.getBBox(); } catch (e) { return; }
            if (!r.width && !r.height) return;
            texts.push({ s: (t.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 46),
                         x: Math.round(r.x), y: Math.round(r.y),
                         w: Math.round(r.width), h: Math.round(r.height) });
        });
        //  A line of text that a later, opaque <rect> is painted over is gone
        //  from the picture and there is no way to tell from the source. This
        //  is the failure the viewBox check cannot see, because the words are
        //  inside the frame -- they are just underneath a panel. Document order
        //  is paint order in SVG, so "a rect after this text, overlapping it"
        //  is exactly the condition. fill="none" rects are excluded: an outline
        //  hides nothing, which is what the kill-switch pulse ring is.
        var buried = [], order = node.querySelectorAll('text,rect'), boxes = [];
        Array.prototype.forEach.call(order, function (el, i) {
            var r; try { r = el.getBBox(); } catch (e) { return; }
            if (r.width < 1 || r.height < 1) return;
            var tag = el.tagName.toLowerCase();
            if (tag === 'rect') {
                var f = (el.getAttribute('fill') || '').trim().toLowerCase();
                if (f === 'none') return;
                if (parseFloat(el.getAttribute('opacity') || '1') < 0.9) return;
            }
            boxes.push({ tag: tag, i: i, x: r.x, y: r.y, w: r.width, h: r.height,
                         s: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40) });
        });
        boxes.forEach(function (t) {
            if (t.tag !== 'text') return;
            boxes.forEach(function (b) {
                if (b.tag !== 'rect' || b.i < t.i) return;
                var ow = Math.min(t.x + t.w, b.x + b.w) - Math.max(t.x, b.x);
                var oh = Math.min(t.y + t.h, b.y + b.h) - Math.max(t.y, b.y);
                if (ow > 3 && oh > 3 && ow * oh > 12)
                    buried.push('"' + t.s + '" is painted over by a panel ' +
                                Math.round(ow) + 'x' + Math.round(oh) + ' px into it');
            });
        });
        //  Two lines of text in the same place is the other invisible failure:
        //  a column header that has grown into its neighbour reads as one
        //  run-together word and the viewBox check is perfectly happy. The
        //  hero paints its wordmark twice on purpose -- once for the colour,
        //  once for the moving highlight -- so identical strings are exempt,
        //  which is the only legitimate reason to stack text in this project.
        //  Loop variables are ti/tj on purpose: the names 'a' and 'b' belong to
        //  the two <img> elements this function is about to load, and a for-loop
        //  that reuses them silently reassigns them to integers -- after which
        //  a.onload never fires and the whole probe hangs on its first file
        //  with no error to show for it. That happened; hence the names.
        for (var ti = 0; ti < boxes.length; ti++) {
            if (boxes[ti].tag !== 'text') continue;
            for (var tj = ti + 1; tj < boxes.length; tj++) {
                var q = boxes[tj];
                if (q.tag !== 'text' || q.s === boxes[ti].s) continue;
                var w2 = Math.min(boxes[ti].x + boxes[ti].w, q.x + q.w) - Math.max(boxes[ti].x, q.x);
                var h2 = Math.min(boxes[ti].y + boxes[ti].h, q.y + q.h) - Math.max(boxes[ti].y, q.y);
                if (w2 > 3 && h2 > 3 && w2 * h2 > 12)
                    buried.push('"' + boxes[ti].s + '" and "' + q.s + '" overlap by ' +
                                Math.round(w2) + 'x' + Math.round(h2) + ' px');
            }
        }
        //  A gradient in objectBoundingBox units -- the default -- has no box
        //  to resolve against when the shape's own bounding box is zero in one
        //  direction, so the shape paints as if it had no paint at all. A
        //  horizontal rule and a horizontal connector are exactly that shape,
        //  and both were silently invisible in this project until this check
        //  existed: the XML is valid, the render is not blank, the preview
        //  looks plausible, and one deliberate element of the design is just
        //  gone. The fix is gradientUnits="userSpaceOnUse" with real
        //  coordinates, or a flat colour. Shapes whose geometry is animated are
        //  exempt: several here open at width 0 or rx 0 by design and grow, so
        //  t=0 is not their shape. A url() naming nothing is reported too --
        //  same outcome, nothing paints.
        var GEOM = /^(width|height|rx|ry|r|d|x1|x2|y1|y2|cx|cy|points|transform)$/;
        var paintless = [];
        Array.prototype.forEach.call(
            node.querySelectorAll('path,rect,circle,ellipse,line,polyline,polygon,text,use'),
            function (el) {
                var animated = false;
                Array.prototype.forEach.call(el.querySelectorAll('animate,animateTransform,set'),
                    function (an) { if (GEOM.test(an.getAttribute('attributeName') || '')) animated = true; });
                if (animated) return;
                ['fill', 'stroke'].forEach(function (prop) {
                    var v = null, cur = el;
                    while (cur && cur.nodeType === 1) {   // nearest declared value wins
                        var got = cur.getAttribute && cur.getAttribute(prop);
                        if (got) { v = got; break; }
                        cur = cur.parentNode;
                    }
                    var ref = /^url\\(\\s*['"]?#([^)'"]+)/.exec((v || '').trim());
                    if (!ref) return;
                    var g = null;
                    try { g = node.querySelector('#' + ref[1]); } catch (e) {}
                    if (!g) {
                        paintless.push('<' + el.tagName + '> ' + prop + 's with url(#' + ref[1] +
                                       '), which is not defined');
                        return;
                    }
                    var kind = g.tagName.toLowerCase();
                    if (kind !== 'lineargradient' && kind !== 'radialgradient') return;
                    if ((g.getAttribute('gradientUnits') || '') === 'userSpaceOnUse') return;
                    var box; try { box = el.getBBox(); } catch (e) { return; }
                    if (box.width >= 0.5 && box.height >= 0.5) return;
                    paintless.push('<' + el.tagName + '> is ' + Math.round(box.width) + 'x' +
                                   Math.round(box.height) + ', so url(#' + ref[1] +
                                   ') has no box to resolve against and paints nothing');
                });
            });
        return new Promise(function (res) {
            var left = 2, bad = false;
            function done() { if (--left) return;
                var r = document.getElementById('pane').getBoundingClientRect();
                res({ imgBroken: bad,
                      natural: [a.naturalWidth, a.naturalHeight],
                      vb: { w: vb.width, h: vb.height },
                      bb: { x: Math.round(bb.x), y: Math.round(bb.y),
                            w: Math.round(bb.width), h: Math.round(bb.height) },
                      texts: texts,
                      buried: buried.slice(0, 6),
                      paintless: paintless.slice(0, 6),
                      pane: { x: Math.round(r.left), y: Math.round(r.top),
                              w: Math.round(r.width), h: Math.round(r.height) } });
            }
            a.onload = b.onload = done;
            a.onerror = b.onerror = function () { bad = true; done(); };
            a.src = url; b.src = url;
        });
    })()`);
}

//  A frame a beat into the animation, not at t=0: several of these images
//  start from width 0 or opacity 0 and grow, and a t=0 preview would show an
//  empty box and call it a blank render.
const SETTLE = 1400;

async function shootPane(rel, pane) {
    const png = (await win.webContents.capturePage({
        x: pane.x, y: pane.y,
        width:  Math.min(pane.w, win.getContentSize()[0] - pane.x),
        height: Math.min(pane.h, win.getContentSize()[1] - pane.y),
    })).toPNG();
    const file = path.join(OUT, rel.replace(/[\\/]/g, '__').replace(/\.svg$/, '') + '.png');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, png);
    return { file, bytes: png.length };
}

async function one(rel) {
    const abs = path.join(MEDIA, rel);
    const src = fs.readFileSync(abs, 'utf8');
    const notes = auditSource(rel, src);
    const box = boxOf(src);
    if (!box) { notes.push('viewBox is not four plain numbers'); }

    if (box) {
        win.setContentSize(Math.max(200, Math.min(1600, box.w)),
                           Math.max(140, Math.min(1400, box.h * 2 + 8)));
        await sleep(120);
    }
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(HARNESS));
    const m = await measure(rel, src);

    if (m.parseError) {
        fail++;
        say(`  FAIL ${rel}  --  XML will not parse: ${m.parseError}`);
        return { rel, ok: false };
    }
    if (m.imgBroken) { fail++; say(`  FAIL ${rel}  --  the browser refused to render it as an image`); return { rel, ok: false }; }
    if (!m.natural[0] || !m.natural[1])
        notes.push(`intrinsic size came back ${m.natural.join('x')}`);
    //  Clipped words are the failure that matters: GitHub renders the file at
    //  whatever width the column gives it, so a line that runs past the
    //  viewBox loses its tail on every screen, silently. Decorative bleed is
    //  fine and is why only <text> is measured. 1 px of slack for rounding.
    const spill = [];
    for (const t of (m.texts || [])) {
        if (!box) break;
        const off = [];
        if (t.x < -1)                 off.push(`${-t.x}px left`);
        if (t.y < -1)                 off.push(`${-t.y}px above`);
        if (t.x + t.w > box.w + 1)    off.push(`${t.x + t.w - box.w}px right`);
        if (t.y + t.h > box.h + 1)    off.push(`${t.y + t.h - box.h}px below`);
        if (off.length) spill.push(`"${t.s}" runs ${off.join(' and ')} the viewBox`);
    }
    if (spill.length) notes.push(...spill);
    if (m.buried && m.buried.length) notes.push(...m.buried);
    if (m.paintless && m.paintless.length) notes.push(...m.paintless);

    await sleep(SETTLE);
    const shot = await shootPane(rel, m.pane);
    //  A PNG of two flat rectangles compresses to almost nothing. The floor
    //  scales with area so a 22 px badge and a 420 px banner are both held to
    //  "something was actually drawn here".
    const floor = Math.max(600, Math.round((m.pane.w * m.pane.h) / 900));
    if (shot.bytes < floor)
        notes.push(`preview is ${shot.bytes} B, under the ${floor} B floor for its size -- nothing drew`);

    const ok = notes.length === 0;
    if (!ok) fail++;
    say(`  ${ok ? 'ok  ' : 'FAIL'} ${rel.padEnd(26)} ${box ? box.w + 'x' + box.h : '?'}`.padEnd(48) +
        `${Math.round(shot.bytes / 1024)} KB` + (ok ? '' : '\n         ' + notes.join('\n         ')));
    return { rel, ok, box, bytes: shot.bytes };
}

app.whenReady().then(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    //  Same posture as the other README harnesses: nothing may leave.
    session.defaultSession.webRequest.onBeforeRequest((d, cb) => {
        if (/^(file|devtools|blob|data|chrome-extension):/.test(d.url)) return cb({});
        netHits.push(d.method + ' ' + d.url);
        cb({ cancel: true });
    });
    win = new BrowserWindow({
        width: 1320, height: 900, show: true, frame: false, useContentSize: true,
        backgroundColor: '#3b3b3b',
        webPreferences: { contextIsolation: false, nodeIntegration: false,
                          sandbox: false, backgroundThrottling: false },
    });
    win.webContents.on('console-message', (e) => {
        //  Event-object form: Electron 41 deprecates the positional arguments,
        //  and a deprecation notice in a report about whether the art is clean
        //  is noise that trains you to skim the report.
        const message = (e && e.message) || '';
        const level = (e && e.level) || '';
        if (/Electron Security Warning/.test(message)) return;
        if (level === 'error' || level === 'warning') consoleErrors.push(level + ': ' + message);
    });

    const files = svgFiles(MEDIA);
    say(`── ${files.length} SVG files under docs/media, rendered on white and on GitHub dark ──`);
    for (const rel of files) {
        try { await one(rel); }
        catch (e) { fail++; say(`  FAIL ${rel} threw  -- ${e && e.message || e}`); }
    }
    say('\n── the rules, checked once over the whole set ──');
    const check = (ok, good, bad) => { if (ok) say('  ok   ' + good); else { fail++; say('  FAIL ' + bad); } };
    check(netHits.length === 0, 'no request left this machine',
          `${netHits.length} request(s) tried to leave: ${netHits.slice(0, 4).join(' | ')}`);
    check(consoleErrors.length === 0, 'no console errors while rendering',
          `console errors: ${consoleErrors.slice(0, 3).join(' | ')}`);
    say(`\n  ${fail} failed.   previews: ${OUT}\n  log: ${LOG}`);
    win.destroy();
    app.exit(fail ? 1 : 0);
});




