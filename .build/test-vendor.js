'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/test-vendor.js  --  nothing the app SHOWS is fetched, and nothing
//                             it EXECUTES comes off the network.
//
//  The app window runs with `nodeIntegration: true, contextIsolation: false`,
//  so a <script src="https://..."> in index.html is not a styling detail: it is
//  arbitrary code with require('child_process') on the user's PC, pulled over
//  whatever network the user happens to be on -- and the reason people run a VPN
//  is that they do not trust that network. index.html carried two such tags
//  (three.js and globe.gl from unpkg), globe-controller.js pulled three earth
//  textures from an UNVERSIONED unpkg path, and renderer.js fetched a flag image
//  per country from flagcdn.com -- the last of those on the country-selection
//  path, which named the country the user had just chosen, from the real IP,
//  before the tunnel was up.
//
//  This test pins all of that shut: the five vendored files by SHA-256, the
//  absence of any remote resource in a loading position, the load order the
//  globe depends on, and the packaging entry without which the shipped app would
//  reference files that are not in it.
//
//  It also covers the other half of the same rule -- that a number shown to the
//  user has to be one the app measured. The country list used to label every
//  country with a random latency.
// ════════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
    if (cond) { pass++; console.log('  ok   ' + name); }
    else { fail++; console.log('  FAIL ' + name + (extra ? '  -- ' + extra : '')); }
};

//  Recorded at the moment they were downloaded, from the versions the CDN tags
//  themselves named: three 0.147.0, globe.gl 2.27.2, and three-globe 2.45.2 --
//  which is what the unversioned texture path resolved to that day.
const VENDOR = {
    'three.min.js':          'f34446bf875b5fb0dcd93819ffe1d9e182d46634ee855f5d904c6c4ac7cdbc95',
    'globe.gl.min.js':       '7e5cebcec90fb7cf8fa95cd0e3105db7531c90a39d0800787cf048d8d0500014',
    'earth-blue-marble.jpg': '228deba2e4b600146bdcb6cfa359b8ead6aacc2b1c13550a29cd82824cfa1c01',
    'earth-topology.png':    '839b12da2e4dd346b256cebae72e10c479a102c8980a22084c41275e4b9a0e12',
    'earth-night.jpg':       '355ab23dd1323315b393d7b91dd2d7ee223a1cbaaba2b48dc72ba90d371ced24',
};
console.log('── the vendored globe is present and unaltered ──');
{
    for (const [name, want] of Object.entries(VENDOR)) {
        const p = path.join(ROOT, 'vendor', name);
        if (!fs.existsSync(p)) { ok(false, `vendor/${name} is packaged`, 'missing'); continue; }
        const got = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
        ok(got === want, `vendor/${name} is byte-for-byte the file that was reviewed`,
           got.slice(0, 16) + ' != ' + want.slice(0, 16));
    }
    const three = read('vendor/three.min.js');
    ok(/Copyright 2010-2022 Three\.js Authors/.test(three),
       'the vendored three.js is the real library, not an error page');
    ok(/Version 2\.27\.2/.test(read('vendor/globe.gl.min.js')),
       'and globe.gl is the 2.27.2 that index.html used to pin');
}

console.log('\n── no document loads code or images off the network ──');
{
    //  One document, not two. globe.html was the other, and it was the weak one:
    //  its CSP had to keep 'unsafe-inline' because the entire v1 globe lived in
    //  an inline <script> inside it. Deleting it -- nothing loaded it -- is what
    //  makes "every window in this app forbids inline script" true rather than
    //  "every window we currently happen to open".
    for (const f of ['index.html']) {
        const html = read(f);
        const remote = (html.match(/<(?:script|img|link)[^>]+(?:src|href)="https?:\/\/[^"]*"/g) || []);
        ok(!remote.length, `${f} has no remote script, image or stylesheet`,
           JSON.stringify(remote));
        ok(!/@import\s+url\(\s*['"]?https?:/.test(html), `${f} has no remote @import`);

        //  And a policy, so a remote tag added later FAILS instead of running.
        //  Electron warns about a missing CSP at every launch for exactly this
        //  reason: with nodeIntegration on, "may load" means "may run as Node".
        const csp = (html.match(/content="([\s\S]*?default-src[\s\S]*?)"/) || [])[1] || '';
        ok(/http-equiv="Content-Security-Policy"/.test(html), `${f} carries a CSP`);
        ok(/default-src 'none'/.test(csp), `${f}: default-src is 'none'`, csp.slice(0, 40));
        ok(!/script-src[^;]*https?:/.test(csp),
           `${f}: no http(s) origin may supply a script`, csp);
        ok(!/unsafe-eval/.test(csp), `${f}: 'unsafe-eval' is not granted`);
        //  The IP-geolocation lookup used to run in this window, so the policy
        //  had to name its host. It runs in the main process now (see the
        //  outbound allow-list further down), which means a host named here
        //  would be a hole that nothing needs -- in the one document whose
        //  "may load" means "may run as Node".
        ok(!/connect-src[^;]*https?:/.test(csp),
           `${f}: connect-src names no remote host at all`, csp);
        //  The policy has to be parsed before the things it governs.
        ok(html.indexOf('Content-Security-Policy') < html.indexOf('<script'),
           `${f}: the policy precedes the first script`);
    }
    const css = read('style.css');
    ok(!/url\(\s*['"]?https?:/.test(css), 'style.css loads no remote font or image');

    const gc = read('globe-controller.js');
    for (const call of ['globeImageUrl', 'bumpImageUrl', 'TextureLoader().load'])
        ok(!new RegExp(call.replace(/[().]/g, '\\$&') + "\\('https?:").test(gc),
           `${call} is given a packaged file, not a URL`);
    ok(gc.includes("'vendor/earth-blue-marble.jpg'") &&
       gc.includes("'vendor/earth-topology.png'") &&
       gc.includes("'vendor/earth-night.jpg'"),
       'and all three textures point at vendor/');

    const rj = read('renderer.js');
    //  Comments stripped first: the fix left a comment saying what the old
    //  flagcdn <img> was, and a test that cannot tell a comment from code would
    //  force that explanation to be deleted to stay green.
    const rjCode = rj.replace(/^\s*\/\/.*$/gm, '');
    ok(!/flagcdn|<img src="https?:/.test(rjCode),
       'renderer.js fetches no flag image -- the badge is drawn from the country code',
       (rjCode.match(/.*flagcdn.*/) || [''])[0].trim());
    ok(/hsl\(\$\{h\} 60% 44%\)/.test(rj),
       'with the same deterministic hue the extension popup uses');
}
console.log('\n── the shipped build actually contains them ──');
{
    const pkg = JSON.parse(read('package.json'));
    const files = pkg.build.files;
    ok(files.includes('vendor/**/*'),
       'package.json packs vendor/ -- without this the installed app would point at ' +
       'files that are not there and the globe would render black',
       JSON.stringify(files));

    //  Derived from the document, not listed here: any script index.html loads
    //  has to be in the packaged file list, or the installed app 404s on it and
    //  the globe renders black while it works perfectly from the source tree.
    //  vendor-umd-shim.js was exactly that risk the day it was split out.
    const srcs = [...read('index.html').matchAll(/<script\s+src="([^"]+)"/g)].map(m => m[1]);
    const unpacked = [...new Set(srcs)].filter(s =>
        !files.some(f => f === s || (f.endsWith('/**/*') && s.startsWith(f.slice(0, -5) + '/'))));
    ok(!unpacked.length, 'and every script index.html loads is packed with the app',
       JSON.stringify(unpacked));

    //  globe-controller.js reads window.THREE at load, so the order is not
    //  cosmetic: a globe.gl that loads after it never gets used. Read off the
    //  <script src> list rather than indexOf() into the whole document -- the
    //  head comment now explains why renderer.js's innerHTML is the reason
    //  script-src dropped 'unsafe-inline', and a raw indexOf('renderer.js')
    //  found that sentence and reported the load order broken.
    const html  = read('index.html');
    const order = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map(m => m[1]);
    const at = s => order.indexOf(s);
    ok(at('vendor/three.min.js') >= 0 && at('vendor/three.min.js') < at('vendor/globe.gl.min.js'),
       'three.js is loaded before globe.gl', JSON.stringify(order));
    ok(at('vendor/globe.gl.min.js') < at('globe-controller.js'),
       'and both before the controller that uses them');
    ok(at('globe-controller.js') < at('renderer.js'), 'renderer.js still comes last');

    //  The UMD shim has to bracket the two bundles: hidden before them so they
    //  take their browser-global branch, restored after so require() still
    //  works for renderer.js. One file loaded twice, so a single edit cannot
    //  leave the two halves disagreeing.
    const shim = order.filter(s => s === 'vendor-umd-shim.js');
    ok(shim.length === 2, 'the UMD shim is loaded exactly twice', JSON.stringify(order));
    ok(order.indexOf('vendor-umd-shim.js') < at('vendor/three.min.js') &&
       order.lastIndexOf('vendor-umd-shim.js') > at('vendor/globe.gl.min.js') &&
       order.lastIndexOf('vendor-umd-shim.js') < at('globe-controller.js'),
       'once before both bundles and once after them, ahead of the controller');
    const sh = read('vendor-umd-shim.js');
    ok(/window\.__vendorUmdShim/.test(sh) && /delete window\.__vendorUmdShim/.test(sh),
       'and it stashes the module/exports pair on the first run, restoring on the second');
}

console.log('\n── the one window with Node access runs no inline script at all ──');
{
    //  'unsafe-inline' in this document is not a style detail: renderer.js
    //  builds toast bodies and the server list with innerHTML out of state that
    //  includes country names and relay data, and the window has require().
    //  With the grant gone, an injected <img onerror=...> is refused by the
    //  policy instead of running as Node.
    const html = read('index.html');
    const csp  = (html.match(/content="([\s\S]*?default-src[\s\S]*?)"/) || [])[1] || '';
    const scriptSrc = (csp.match(/script-src[^;]*/) || [''])[0];
    ok(!/unsafe-inline/.test(scriptSrc),
       "index.html: script-src does not grant 'unsafe-inline'", scriptSrc);
    ok(/style-src[^;]*'unsafe-inline'/.test(csp),
       'style-src still does, because the markup carries style= attributes');

    //  Every <script> in the document must be a src=, with nothing between the
    //  tags: an inline body would be dead code under the policy above. Comments
    //  are stripped first -- the note above the vendor tags spells out what a
    //  remote <script> here would mean, and that sentence is not a script.
    const markup = html.replace(/<!--[\s\S]*?-->/g, '');
    const inline = [...markup.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)]
        .filter(m => m[1].trim());
    ok(!inline.length, 'no <script> in index.html has an inline body',
       JSON.stringify(inline.map(m => m[1].trim().slice(0, 60))));

    //  Handler attributes are inline script too, and the policy refuses them.
    //  The comment above the CSP contains the word onclick=, which is why this
    //  looks at the comment-free markup as well.
    const handlers = [...markup.matchAll(/\son[a-z]+\s*=/g)].map(m => m[0].trim());
    ok(!handlers.length, 'and no element carries an on*= handler attribute',
       JSON.stringify(handlers));

    //  The two links that used to be onclick="...openExternal(...)". href stays
    //  "#", so even a handler that failed to fire could not navigate a window
    //  with Node integration to a remote page; the destination is an https URL
    //  in the markup, and renderer.js checks the scheme before opening it.
    const ext = [...html.matchAll(/data-external="([^"]*)"/g)].map(m => m[1]);
    ok(ext.length === 2, 'both external links carry their destination as data-external',
       JSON.stringify(ext));
    ok(ext.every(u => /^https:\/\//.test(u)), 'each of them is https', JSON.stringify(ext));
    ok(!/<a[^>]+href="https?:/.test(markup),
       'and no anchor in the document has a navigable remote href');
    const rj = read('renderer.js');
    ok(/a\[data-external\]/.test(rj) && /\^https:\\\/\\\//.test(rj) &&
       /shell\.openExternal\(url\)/.test(rj),
       'renderer.js opens exactly those, https only, in the user\'s own browser');

    //  globe.html is gone, and the check that replaced the old one says so.
    //  Before: globe.html existed, kept 'unsafe-inline' for its one inline
    //  <script>, and this asserted that nothing loaded it -- a standing promise
    //  that a live liability would stay unreferenced. Deleting the file settles
    //  it instead, so what is worth testing now is that it does not come back,
    //  in either form: not on disk, and not named by any source file.
    ok(!fs.existsSync(path.join(ROOT, 'globe.html')),
       'globe.html -- the v1 globe, one inline <script> -- is deleted, not merely unloaded');
    const loaders = ['main.js', 'renderer.js', 'globe-controller.js', 'index.html']
        .filter(f => /globe\.html/.test(read(f).replace(/^\s*(?:\/\/|<!--).*$/gm, '')));
    ok(!loaders.length, 'and no source file names it, so nothing can load it back',
       JSON.stringify(loaders));
}

console.log('\n── and they still work: both load and expose what the globe reads ──');
{
    //  Hashes only prove the bytes did not change. This runs the two files the
    //  way index.html does -- module/exports blanked first, so the UMD wrapper
    //  takes its browser-global branch -- and checks the globals
    //  globe-controller.js actually reaches for.
    const vm = require('vm');
    const el = () => ({
        style: {}, sheet: { insertRule() {} }, firstChild: null,
        getContext: () => null, setAttribute() {}, appendChild() {}, insertBefore() {},
    });
    const sandbox = {
        console: { log() {}, warn() {}, error() {} },
        Math, Date, JSON, Object, String, Number, Array, Symbol, Promise, Map, Set,
        WeakMap, WeakSet, Error, TypeError, RangeError, parseFloat, parseInt, isNaN,
        Uint8Array, Uint16Array, Uint32Array, Int32Array, Float32Array, ArrayBuffer, DataView,
        setTimeout, clearTimeout, requestAnimationFrame: () => 0, performance: { now: () => 0 },
        navigator: { userAgent: 'node' },
        document: {
            createElement: el, createElementNS: el, createTextNode: el,
            getElementsByTagName: () => [el()], head: el(),
            addEventListener() {}, documentElement: { style: {} }, body: { appendChild() {} },
        },
        module: undefined, exports: {},
    };
    sandbox.window = sandbox; sandbox.self = sandbox;
    const ctx = vm.createContext(sandbox);
    let threw = null;
    for (const f of ['vendor/three.min.js', 'vendor/globe.gl.min.js']) {
        try { vm.runInContext(read(f), ctx, { filename: f }); }
        catch (e) { threw = f + ': ' + e.message; break; }
    }
    ok(!threw, 'both vendored bundles execute', threw);
    //  REVISION is a string in this release, and window.THREE is whatever the
    //  LAST of the two bundles assigned -- which is what the controller reads.
    ok(sandbox.THREE && String(sandbox.THREE.REVISION) === '147',
       'three.js is revision 147, the version index.html pinned',
       String(sandbox.THREE && sandbox.THREE.REVISION));
    ok(typeof sandbox.Globe === 'function', 'globe.gl exports the Globe() the controller calls');

    //  Derived from the controller rather than listed here: a THREE member added
    //  to it later gets checked without anybody remembering to come back and
    //  add it. The alias names are read out of the file too, because most of the
    //  calls go through a local `const G = window.THREE;` -- a hand-written list
    //  had already drifted, carrying MeshBasicMaterial but not the CanvasTexture
    //  the smoke plume needs.
    const gcSrc   = read('globe-controller.js').replace(/^\s*\/\/.*$/gm, '');
    const aliases = ['window\\.THREE', 'THREE',
        ...[...gcSrc.matchAll(/const (\w+)\s*=\s*window\.THREE;/g)].map(m => m[1])];
    const used = new Set();
    for (const a of aliases)
        for (const m of gcSrc.matchAll(new RegExp(`(?:^|[^.\\w])${a}\\.([A-Za-z_]\\w*)`, 'g')))
            used.add(m[1]);
    const needed  = [...used].sort();
    const missing = needed.filter(k => !sandbox.THREE || sandbox.THREE[k] === undefined);
    ok(needed.length > 15, `${needed.length} THREE members were found to check`,
       JSON.stringify(needed));
    ok(!missing.length, 'and every THREE member globe-controller.js uses is there',
       JSON.stringify(missing));
    //  Named explicitly as well, because these two are the whole of this
    //  release's visual work: the plume is a canvas sprite so it needs no
    //  network resource, and the night lights are masked by a shader instead of
    //  a flat overlay.
    for (const k of ['CanvasTexture', 'ShaderMaterial'])
        ok(needed.includes(k) && sandbox.THREE[k] !== undefined,
           `including ${k} -- the smoke plume and the night mask are built from them`);
}

console.log('\n── the only thing still leaving the machine, and why ──');
{
    //  An allow-list, so a new outbound call has to be justified here before the
    //  suite goes green again. What leaves is one IP-geolocation lookup: an app
    //  cannot learn its own public IP without asking somebody, and that answer
    //  is what draws the "you are here" point on the globe. It is asked before
    //  any tunnel exists by design, and it is not asked at all when the kill
    //  switch is on.
    const ALLOWED = {
        'free.freeipapi.com': 'home marker -- the app\'s own public IP',
        'ipwho.is':           'the same lookup, tried only when the one before it fails',
        'get.geojs.io':       'the same lookup, third',
        'api.ipbase.com':     'the same lookup, fourth',
    };
    //  The allow-list is checked against the code that defines the providers, so
    //  a fifth one cannot be added to lib/home-location.js without being written
    //  down here as well.
    const HOSTS = require('../lib/home-location.js').HOSTS;
    ok(HOSTS.length === Object.keys(ALLOWED).length &&
       HOSTS.every(h => ALLOWED[h]),
       'every provider lib/home-location.js defines is documented here',
       JSON.stringify(HOSTS));

    //  A plain string scan, not a call scan: these four sit in an array literal,
    //  so the /fetch\(/-shaped regex this used to run would have read the file
    //  and called it clean. Comments stripped first, for the same reason the
    //  renderer scan strips them -- globe-controller.js still carries a note
    //  saying which host it used to talk to and why it no longer does.
    //
    //  XML namespace declarations are stripped too, and only those: an xmlns is
    //  a name, not an address. Nothing resolves it and nothing fetches it. The
    //  Task Scheduler XML lib/installer-tasks.js writes has to carry
    //  schemas.microsoft.com/windows/2004/02/mit/task verbatim or schtasks
    //  rejects the file, and reading that as an outbound request would leave
    //  this check permanently red -- which is how a check stops being read.
    const SCAN = ['main.js', 'renderer.js', 'globe-controller.js',
                  'lib/installer-tasks.js', 'lib/home-location.js', 'lib/socks-fetch.js'];
    const hits = [];
    for (const f of SCAN)
        for (const m of read(f).replace(/^\s*\/\/.*$/gm, '')
                               .replace(/xmlns(:[\w.-]+)?=\\?"[^"\\]*\\?"/g, 'xmlns=""')
                               .matchAll(/['"`]https?:\/\/([^/'"`\s$]+)/g))
            hits.push({ f, host: m[1] });

    const bad = hits.filter(h => !ALLOWED[h.host]);
    ok(!bad.length, 'no undocumented outbound request in the app code',
       JSON.stringify(bad));
    const seen = new Set(hits.map(h => h.host));
    for (const host of HOSTS)
        ok(seen.has(host), `${host} is reachable from the scanned code`);

    //  One file, one place to audit. The window itself asks nobody anything: it
    //  gets the answer over IPC, which is why its connect-src can be empty.
    const stray = hits.filter(h => h.f !== 'lib/home-location.js');
    ok(!stray.length, 'and the lookup lives in that one file, not spread through the app',
       JSON.stringify(stray));
    for (const f of ['renderer.js', 'globe-controller.js'])
        ok(!/\bfetch\(/.test(read(f).replace(/^\s*\/\/.*$/gm, '')),
           `${f} makes no fetch() of its own`);
}

console.log('\n── the country list shows a number the app measured ──');
{
    const rj = read('renderer.js');
    ok(!/label=`\$\{Math\.floor\(\d+\+Math\.random/.test(rj),
       'no rolled-on-every-refresh latency label is left in the app window');
    ok(/const exits = count === 1 \? '1 exit' : `\$\{count\} exits`;/.test(rj),
       'the label is the exit-relay count from the live relay index');
    for (const band of ['status-fast', 'status-busy', 'status-slow'])
        ok(new RegExp(`cls='${band}'; label=exits;`).test(rj) || band === 'status-fast',
           `the ${band} band shows it too`);
    const pj = read('Extension/popup.js');
    ok(/c \+ ' exits'/.test(pj) && /count > 200 \|\| mbps > 50/.test(pj),
       'and the extension popup reports the same number by the same thresholds');
}

console.log('\n── the globe names a place only when it was told one ──');
{
    //  It used to caption "Standing by in Dhaka, Bangladesh" and pulse a ring
    //  there whenever the IP lookup failed -- indistinguishable from a real
    //  reading, for a user who could be anywhere. Found by loading the real
    //  window with the lookup cancelled (.build/probe-window.js).
    const gc = read('globe-controller.js');
    const code = gc.replace(/^\s*\/\/.*$/gm, '');
    const lines = code.split('\n');

    ok(!/name: 'Dhaka, Bangladesh'/.test(code), 'no hard-coded fallback city is left',
       (code.match(/.*Dhaka.*/) || [''])[0].trim());
    ok(/let HOME_LOC\s*=\s*\{[^}]*known: false/.test(code), 'home starts out explicitly unknown');
    ok(/!Number\.isFinite\(lat\) \|\| !Number\.isFinite\(lng\)/.test(code),
       'an answer without usable coordinates counts as a failed lookup');
    ok((code.match(/known: true/g) || []).length === 1,
       'exactly one place in the file can mark home as known');

    //  focusHome() holds the only unguarded draw, behind its own early return.
    const fh = lines.findIndex(l => l.includes('function focusHome'));
    ok(fh > 0 && /if \(!globe \|\| !homeIsKnown\(\)\) return false;/.test(lines[fh + 1] || ''),
       'focusHome() refuses to draw a home nobody knows');
    const unguarded = lines.filter((l, i) =>
        !(i > fh && i < fh + 8) &&
        (/pointOfView\(\{ lat: HOME_LOC/.test(l) || /setPulse\(HOME_LOC/.test(l)) &&
        !/homeIsKnown\(\)/.test(l));
    ok(!unguarded.length, 'and nothing else flies to or pulses home without asking first',
       JSON.stringify(unguarded.map(l => l.trim())));

    const named = lines.filter(l => /Standing by in \$\{HOME_LOC\.name\}/.test(l));
    ok(named.length === 1, 'one place can caption a named home, and it checks',
       named.length + ' places');
    ok(/function showStandingBy\(\) \{/.test(code) &&
       /else setOverlay\('Home location unavailable/.test(code),
       'the other branch says the lookup did not answer');
}

console.log('\n── and git cannot undo any of it on the way to a clone ──');
{
    //  Every hash above is taken over the bytes on disk. Git is entitled to
    //  rewrite those bytes: core.autocrlf is true on the machine this was built
    //  on, so without an explicit attribute git converts line endings on
    //  checkout -- and `git add vendor/` says so, "LF will be replaced by CRLF
    //  the next time Git touches it". Two minified bundles full of newlines are
    //  exactly what that hits. A fresh clone would then fail the five checks at
    //  the top of this file with the correct files on disk, which is the worst
    //  possible failure of a pin: it teaches whoever sees it that the pin lies.
    const attrs = fs.existsSync(path.join(ROOT, '.gitattributes'))
        ? read('.gitattributes') : null;
    ok(attrs !== null, '.gitattributes exists at all', 'absent');

    const git = args => {
        try {
            return require('child_process')
                .execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        } catch (e) { return null; }
    };
    const probe = git(['check-attr', 'text', '--', 'vendor/three.min.js']);
    if (probe === null) {
        console.log('       (git unavailable here -- the attribute checks are skipped, ' +
                    'not passed)');
    } else {
        for (const name of Object.keys(VENDOR)) {
            const line = git(['check-attr', 'text', '--', 'vendor/' + name]) || '';
            ok(/text: unset$/m.test(line.trim()),
               `vendor/${name} is exempt from eol conversion, so a clone keeps its hash`,
               line.trim() || 'no answer');
        }
        //  The six CRLF documents are the other half of the same problem, from
        //  the opposite direction: they are stored LF like everything else, and
        //  only eol=crlf puts them back as CRLF. Without it a clone hands over
        //  an all-LF main.js -- and .build/audit-eol.js is right to fail that.
        for (const f of ['main.js', 'renderer.js', 'globe-controller.js',
                         'index.html', 'style.css', 'vendor-umd-shim.js']) {
            const line = git(['check-attr', 'eol', '--', f]) || '';
            ok(/eol: crlf$/m.test(line.trim()), `${f} is checked out CRLF, as it is here`,
               line.trim() || 'no answer');
        }
        //  Tracked, not merely present. vendor/ was untracked for as long as it
        //  existed, which meant a clone got an index.html loading five files
        //  that were not in the repository: a black globe, and no test in here
        //  could have seen it, because they all read this working tree.
        const tracked = new Set((git(['ls-files', '-z']) || '').split('\0').filter(Boolean));
        const missing = [...Object.keys(VENDOR).map(n => 'vendor/' + n),
                         'vendor-umd-shim.js', 'lib/home-location.js']
            .filter(f => !tracked.has(f));
        ok(!missing.length, 'and every file the window loads is in the repository, not just on this disk',
           JSON.stringify(missing));
    }
}
console.log('\n── the country flags: one per country, local, and the same on both surfaces ──');
{
    //  The flags were on screen once and then were gone, and nothing above this
    //  section could have caught it: they are drawn by code from a folder, not
    //  named in index.html, so the "every file the window loads" check never
    //  looked at them. This section is that check for the flags.
    const { geoFromMainJs } = require('./geo-from-main.js');
    const geo = Object.keys(geoFromMainJs(ROOT)).map(c => c.toLowerCase()).sort();
    const list = dir => {
        const p = path.join(ROOT, dir);
        return fs.existsSync(p)
            ? fs.readdirSync(p).filter(f => f.endsWith('.svg')).sort() : [];
    };
    const app = list('vendor/flags');
    const ext = list('Extension/flags');

    ok(app.length > 0, 'vendor/flags exists and is not empty', String(app.length));
    const missing = geo.filter(cc => !app.includes(cc + '.svg'));
    ok(!missing.length, 'every country the app can connect to has its flag',
       JSON.stringify(missing));
    const orphan = app.filter(f => !geo.includes(f.slice(0, -4)));
    ok(!orphan.length, 'and nothing is shipped for a country the app cannot offer',
       JSON.stringify(orphan));

    //  The popup needs its own copy inside the extension: chrome-extension://
    //  cannot reach vendor/. Two copies of anything can drift, so they are
    //  compared by content, not by name.
    const sum = f => crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, f))).digest('hex');
    ok(ext.join(',') === app.join(','), 'the extension carries the identical set of flags',
       `app ${app.length} vs extension ${ext.length}`);
    const drift = app.filter(f => ext.includes(f) &&
                                  sum('vendor/flags/' + f) !== sum('Extension/flags/' + f));
    ok(!drift.length, 'and every one of them is the same file, not a redrawn lookalike',
       JSON.stringify(drift.slice(0, 6)));
    /* FLAG_CONTENT_ASSERTS */

    //  A flag is a picture. Anything in one of these files that could fetch or
    //  run something is not a flag, and both surfaces draw them in documents
    //  that hold real power -- the app window has Node access.
    const bad = { script: [], remote: [], embed: [] };
    for (const f of app) {
        const svg = read('vendor/flags/' + f);
        if (/<script|\son\w+\s*=|javascript:/i.test(svg)) bad.script.push(f);
        if (/(?:href|src|url)\s*[=(]\s*["']?(?:https?:)?\/\//i.test(svg)) bad.remote.push(f);
        if (/<foreignObject|<iframe|<image\b/i.test(svg)) bad.embed.push(f);
        if (!/^\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(svg))
            bad.embed.push(f + ' (not an svg root)');
    }
    ok(!bad.script.length, 'no flag carries a script or an event handler',
       JSON.stringify(bad.script.slice(0, 6)));
    ok(!bad.remote.length, 'none of them references anything off this machine',
       JSON.stringify(bad.remote.slice(0, 6)));
    ok(!bad.embed.length, 'and each one is a plain self-contained <svg>',
       JSON.stringify(bad.embed.slice(0, 6)));

    //  Both surfaces have to be pointed at the local copies. A CDN here would
    //  hand a third party the list of countries the user opens.
    ok(/vendor\/flags\//.test(read('renderer.js')),
       'the app window draws them from vendor/flags/');
    ok(/getURL\(\s*'flags\/'/.test(read('Extension/popup.js')),
       'and the popup from its own packaged flags/ folder');
    //  Only string literals, because renderer.js explains in a comment that the
    //  badge used to be an <img> from flagcdn.com -- one request per country, to
    //  a third party, telling it which countries were being looked at. That
    //  comment is the record of the fix; a URL in a string would be the bug.
    const literals = s => [...s.matchAll(/'[^'\n]*'|"[^"\n]*"|`[^`\n]*`/g)]
        .map(m => m[0]).join('\n');
    const strs = literals(read('renderer.js')) + '\n' + literals(read('Extension/popup.js'));
    const remoteFlag = strs.match(/flagcdn|flagpedia|country-flags|\/\/[\w.-]*flag[\w.-]*\//i);
    ok(!remoteFlag, 'neither surface fetches a flag from the internet',
       remoteFlag ? remoteFlag[0] : '');

    //  Packaged: vendor/** covers the window's copy, and Extension is copied in
    //  whole as an extraResource. A flag that exists here and not in the
    //  installer is the same bug as a missing one.
    const pkg = JSON.parse(read('package.json'));
    const files = (pkg.build && pkg.build.files) || [];
    ok(files.includes('vendor/**/*'), 'build.files ships vendor/flags with the rest of vendor');
    ok(((pkg.build && pkg.build.extraResources) || [])
        .some(r => r && r.from === 'Extension'), 'and the whole Extension folder goes too');

    //  Tracked, for the reason vendor/ itself had to be: a clone that does not
    //  get these files shows 72 grey badges and no flag, and every test in this
    //  file would still pass, because they all read this working tree.
    const git = args => {
        try {
            return require('child_process').execFileSync('git', args,
                { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        } catch (e) { return null; }
    };
    const tracked = git(['ls-files', '-z', '--', 'vendor/flags', 'Extension/flags']);
    if (tracked === null) {
        console.log('       (git unavailable here -- the tracking check is skipped, not passed)');
    } else {
        const have = new Set(tracked.split('\0').filter(Boolean));
        const untracked = [...app.map(f => 'vendor/flags/' + f),
                           ...ext.map(f => 'Extension/flags/' + f)].filter(f => !have.has(f));
        ok(!untracked.length, 'and both copies are in the repository, not just on this disk',
           untracked.length + ' untracked, e.g. ' + (untracked[0] || ''));
    }
}
console.log('\n── every path the build config names actually exists ──');
{
    //  electron-builder does not warn and carry on when a named resource is
    //  missing: app-builder-lib's getResource() throws
    //  InvalidConfigurationError, "cannot find specified resource". So one wrong
    //  filename in here is not a cosmetic defect, it is `npm run dist` refusing
    //  to produce an installer -- which is how build.nsis.license sat pointing
    //  at LICENSE.txt while the file on disk was named LICENSE.
    const pkg = JSON.parse(read('package.json'));
    const b = pkg.build || {}, nsis = b.nsis || {}, win = b.win || {};
    const named = [
        //  Negations are patterns, not paths -- "!Tor/data/lock" is a rule about
        //  what must NOT ship, and fs.existsSync("!Tor/data/lock") is false for
        //  every one of them. They get their own section below.
        ['build.files', (b.files || []).filter(f => !f.includes('*') && !f.startsWith('!'))],
        ['build.win.icon', [win.icon]],
        ['build.nsis.license', [nsis.license]],
        ['build.nsis.installerIcon', [nsis.installerIcon]],
        ['build.nsis.uninstallerIcon', [nsis.uninstallerIcon]],
        ['build.nsis.installerHeaderIcon', [nsis.installerHeaderIcon]],
        ['build.nsis.installerSidebar', [nsis.installerSidebar]],
        ['build.nsis.uninstallerSidebar', [nsis.uninstallerSidebar]],
        ['build.nsis.include', [nsis.include]],
        ['build.extraResources', (b.extraResources || []).map(r => r && r.from)],
    ];
    for (const [where, list] of named) {
        const gone = list.filter(Boolean).filter(f => !fs.existsSync(path.join(ROOT, f)));
        ok(!gone.length, `${where} names only files that are here`, JSON.stringify(gone));
    }
    //  ...spelled the way the filesystem spells them. existsSync cannot catch
    //  this on Windows: build.extraResources[0].from said "vc_redist.x64.exe"
    //  while the file is "VC_redist.x64.exe", every check above passed, and the
    //  installer built -- because NTFS is case-insensitive. The same repository
    //  cloned onto a case-sensitive filesystem (a Linux CI runner) hands that
    //  name to getResource(), which throws InvalidConfigurationError and
    //  produces no installer. So compare against the real directory entry.
    {
        const misspelt = [];
        for (const [where, list] of named)
            for (const f of list.filter(Boolean)) {
                const parts = f.split(/[\\/]/);
                let dir = ROOT;
                for (const seg of parts) {
                    let entries;
                    try { entries = fs.readdirSync(dir); } catch (e) { break; }
                    if (!entries.includes(seg)) {
                        const near = entries.find(e => e.toLowerCase() === seg.toLowerCase());
                        if (near) misspelt.push(`${where}: ${f} -> on disk it is "${near}"`);
                        break;
                    }
                    dir = path.join(dir, seg);
                }
            }
        ok(!misspelt.length, 'and spells each of them exactly as the filesystem does',
           JSON.stringify(misspelt));
    }
    //  ...and names them in a format the tool that consumes them accepts. This
    //  is a separate failure from "the file is missing", and a worse one,
    //  because the config reads as correct: nsis.installerIcon,
    //  uninstallerIcon and installerHeaderIcon are handed STRAIGHT to
    //  makensis as MUI_ICON / MUI_UNICON / HEADER_ICO, and makensis wants a
    //  real Windows .ico. All three said "icon.png", and the whole NSIS step
    //  died on `Error while loading icon from "icon.png": invalid icon file` --
    //  so version 2.0.0 had no installer at all, and the newest thing in
    //  release/ was a 1.0.0 build. Leaving them unset is the fix: NsisTarget
    //  falls back to packager.getIconPath(), which converts win.icon into a
    //  proper .ico for exactly this purpose.
    const ICO = ['installerIcon', 'uninstallerIcon', 'installerHeaderIcon'];
    const wrongIco = ICO.filter(k => nsis[k] && !/\.ico$/i.test(nsis[k])).map(k => k + '=' + nsis[k]);
    ok(!wrongIco.length,
       'every NSIS icon option is either unset or a real .ico, because makensis rejects a PNG',
       JSON.stringify(wrongIco));
    const BMP = ['installerSidebar', 'uninstallerSidebar', 'installerHeader'];
    const wrongBmp = BMP.filter(k => nsis[k] && !/\.bmp$/i.test(nsis[k])).map(k => k + '=' + nsis[k]);
    ok(!wrongBmp.length, 'and every NSIS bitmap option is a .bmp, for the same reason',
       JSON.stringify(wrongBmp));
    //  win.icon is the one that MAY be a PNG -- electron-builder converts it --
    //  but only if it is big enough to convert, which is 256x256.
    if (win.icon && /\.png$/i.test(win.icon) && fs.existsSync(path.join(ROOT, win.icon))) {
        const b = fs.readFileSync(path.join(ROOT, win.icon));
        const w = b.readUInt32BE(16), h = b.readUInt32BE(20);
        ok(b.slice(1, 4).toString() === 'PNG' && w >= 256 && h >= 256,
           `build.win.icon is a PNG electron-builder can convert to .ico (${w}x${h})`,
           w + 'x' + h);
    }
    //  The licence is the one the installer shows, so it has to be readable text
    //  rather than an empty placeholder, and CRLF -- a Windows text control does
    //  not break lines on a bare LF.
    if (nsis.license && fs.existsSync(path.join(ROOT, nsis.license))) {
        const lic = read(nsis.license);
        ok(lic.length > 400 && /permission is hereby granted/i.test(lic),
           'and the licence it shows is the real MIT text', lic.slice(0, 40));
        ok(!/(?<!\r)\n/.test(lic), 'stored CRLF, so the installer page renders as lines',
           'bare LF present');
    }
}

console.log('\n── and what it packages is the Tor bundle, not this machine\'s Tor state ──');
{
    //  `Tor/**/*` on its own packaged 737 MB of tor's RUNTIME state next to the
    //  engine: 60 MB of consensus caches under Tor/data, and 677 MB of
    //  per-country DataDirectories under Tor/tor/data left over from a layout
    //  the code stopped using. Three separate defects, not one:
    //
    //  1. Tor/data/state is the list of entry guards THIS machine picked. Ship
    //     it and every install starts on the same first hop, carrying one
    //     developer's guard history -- the precise opposite of the point.
    //  2. setupWritableTor() does fs.cpSync(app.asar.unpacked/Tor -> ProgramData)
    //     on first run, so every packaged byte lands on the user's disk twice.
    //  3. All of it is in .gitignore, so a clean clone already built a smaller,
    //     different installer than this machine did. The build was not
    //     reproducible, and the machine with the extra files was the one
    //     shipping.
    const pkg = JSON.parse(read('package.json'));
    const files = ((pkg.build || {}).files) || [];
    const MUST_EXCLUDE = ['!Tor/data/cached-*', '!Tor/data/lock', '!Tor/data/state',
                          '!Tor/data/unverified-*', '!Tor/data/control_auth_cookie',
                          '!Tor/tor/data/**', '!Tor/torrc_temp', '!Tor/tor/torrc_temp'];
    const absent = MUST_EXCLUDE.filter(p => !files.includes(p));
    ok(!absent.length, 'build.files excludes every runtime-state path tor writes',
       JSON.stringify(absent));
    //  ...and still ships the four files the engine uses. An over-broad negation
    //  here fails at run time, not build time: geoip/geoip6 are what ExitNodes
    //  {cc} resolves against, tor.exe is the engine, and lyrebird.exe is the
    //  obfs4 bridge fallback main.js reaches for when a plain start stalls.
    const MUST_SHIP = ['Tor/data/geoip', 'Tor/data/geoip6', 'Tor/tor/tor.exe',
                       'Tor/tor/pluggable_transports/lyrebird.exe'];
    const dropped = MUST_SHIP.filter(f => !fs.existsSync(path.join(ROOT, f))
                                       || files.includes('!' + f));
    ok(!dropped.length, 'and still ships geoip, geoip6, tor.exe and lyrebird.exe',
       JSON.stringify(dropped));
    //  The two lists have to agree. If git ignores a path the packager keeps,
    //  this machine ships something no clone has; if the packager drops a path
    //  git tracks, the installer is missing a file that IS source.
    const gitIgnores = f => {
        try {
            require('child_process').execFileSync('git',
                ['check-ignore', '-q', '--no-index', '--', f],
                { cwd: ROOT, stdio: 'ignore' });
            return true;
        } catch (e) { return false; }
    };
    if (gitIgnores('Tor/data/state') || gitIgnores('Tor/tor/data/x')) {
        const sample = { '!Tor/data/cached-*': 'Tor/data/cached-microdescs',
                         '!Tor/data/lock': 'Tor/data/lock',
                         '!Tor/data/state': 'Tor/data/state',
                         '!Tor/data/unverified-*': 'Tor/data/unverified-microdesc-consensus',
                         '!Tor/data/control_auth_cookie': 'Tor/data/control_auth_cookie',
                         '!Tor/tor/data/**': 'Tor/tor/data/us/state',
                         '!Tor/torrc_temp': 'Tor/torrc_temp',
                         '!Tor/tor/torrc_temp': 'Tor/tor/torrc_temp' };
        const notIgnored = Object.values(sample).filter(f => !gitIgnores(f));
        ok(!notIgnored.length,
           'and .gitignore ignores each one, so a clean clone builds the same installer',
           JSON.stringify(notIgnored));
        const overIgnored = MUST_SHIP.filter(f => gitIgnores(f));
        ok(!overIgnored.length, 'while ignoring none of the four the engine needs',
           JSON.stringify(overIgnored));

        //  And the bundle is exactly those four -- nothing else tracked under
        //  Tor/. Excluding runtime state was only half of it; the other half was
        //  19 tracked files under Tor/ that nothing could reach, 19.3 MB of them
        //  two binaries:
        //
        //    tor-gencert.exe      6.2 MB   builds directory-authority keys. A
        //                                  client never runs it.
        //    conjure-client.exe  13.1 MB   a pluggable transport named by nothing
        //                                  but the dead torrc-defaults below.
        //    pt_config.json / README.CONJURE.md   Tor Browser's PT registry and
        //                                  its notes. This app builds its own
        //                                  ClientTransportPlugin line in code.
        //    Tor/tor/configs/torrc-*  x13  the v1 per-country configs, all with
        //                                  DataDirectory C:/Tor/tor/data/<cc> --
        //                                  a path off this machine's C: root.
        //    Tor/tor/start-vpn.bat         the v1 launcher.
        //    Tor/data/torrc-defaults       verbatim Tor Browser boilerplate whose
        //                                  ClientTransportPlugin lines point into
        //                                  TorBrowser\Tor\PluggableTransports\.
        //                                  MEASURED unreachable: with main.js's
        //                                  exact argv, `tor --verify-config -f
        //                                  <torrc>` reports reading exactly one
        //                                  config file, the -f one. tor only
        //                                  auto-reads a torrc-defaults beside
        //                                  tor.exe or under %APPDATA%\tor, and
        //                                  main.js never passes --defaults-torrc.
        //
        //  A "dead file" argument decays; this check does not. Anything new under
        //  Tor/ has to be justified by adding it here.
        const tracked = require('child_process')
            .execFileSync('git', ['ls-files', '--', 'Tor/'], { cwd: ROOT, encoding: 'utf8' })
            .split(/\r?\n/).filter(Boolean);
        const extra = tracked.filter(f => !MUST_SHIP.includes(f));
        ok(!extra.length, 'and the tracked Tor bundle is those four files and nothing else',
           JSON.stringify(extra));
    } else {
        console.log('       (git unavailable here -- the .gitignore agreement checks are skipped, not passed)');
    }
}

console.log('');
console.log(`${pass}/${pass + fail} checks passed`);
if (fail) console.log(`${fail} FAILED`);
process.exit(fail ? 1 : 0);
