'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/make-badges.js  --  the README's badges, self-hosted.
//
//  Run:  node .build/make-badges.js
//  Out:  docs/media/badges/*.svg   (overwritten, nothing else)
//
//  WHY NOT shields.io
//  The old README pulled four badges from img.shields.io and a hero image
//  from capsule-render.vercel.app. Every visitor to a page whose headline
//  claim is "the only address it opens is 127.0.0.1" was making requests to
//  two third parties, with a referrer saying which repository they were
//  reading. Self-hosted SVG in this repository costs nothing and contradicts
//  nothing, so that is what ships.
//
//  WHY A GENERATOR AND NOT 14 HAND-WRITTEN FILES
//  A badge's width is a function of its text, and a hand-tuned width is a
//  number that goes stale the moment the text changes. This computes it, and
//  then pins it with textLength so the glyphs fit the box on a machine that
//  has none of the preferred fonts -- GitHub renders these in the visitor's
//  browser, not on a server, so Segoe UI cannot be assumed.
//
//  EVERY VALUE HERE IS READ, NOT TYPED
//  The version, the Electron version, the Tor version, the browser count and
//  the spoofable-country count come out of package.json, the Tor binary and
//  the source. A badge is a claim; a typed badge is a claim that drifts.
// ════════════════════════════════════════════════════════════════════
const fs   = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { geoFromMainJs } = require('./geo-from-main.js');

const ROOT = path.join(__dirname, '..');
const OUT  = path.join(ROOT, 'docs', 'media', 'badges');

//  Approximate advance widths for an 11 px UI sans, then pinned with
//  textLength so an unexpected font cannot overflow the box.
const NARROW = "iljItfI'.,:;|!()[]{}/\\-";
const WIDE   = 'ABCDEFGHKNOPQRSUVXYZmw@';
const EXTRA  = 'MW';
function textWidth(s) {
    let w = 0;
    for (const ch of String(s)) {
        if (ch === ' ')             w += 3.4;
        else if (EXTRA.includes(ch))  w += 9.6;
        else if (WIDE.includes(ch))   w += 7.6;
        else if (NARROW.includes(ch)) w += 3.6;
        else                          w += 6.3;
    }
    return Math.ceil(w);
}

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
                          .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

//  One badge. `glow` gives the value half a second of brightening on load --
//  enough that a wall of badges reads as alive rather than as a screenshot,
//  and it is pure SMIL/CSS inside the image, so it survives GitHub's
//  sanitiser (which strips scripts, not animation).
function badge({ label, value, fill, i = 0 }) {
    const PAD = 9, H = 22, R = 4;
    const lw = textWidth(label) + PAD * 2;
    const vw = textWidth(value) + PAD * 2;
    const w  = lw + vw;
    const id = 'g' + Math.abs(hash(label + value)).toString(36);
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${H}" role="img"
     viewBox="0 0 ${w} ${H}" aria-label="${esc(label)}: ${esc(value)}">
  <title>${esc(label)}: ${esc(value)}</title>
  <defs>
    <linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fff" stop-opacity=".16"/>
      <stop offset="1" stop-color="#000" stop-opacity=".16"/>
    </linearGradient>
    <clipPath id="c${id}"><rect width="${w}" height="${H}" rx="${R}"/></clipPath>
  </defs>
  <g clip-path="url(#c${id})">
    <rect width="${lw}" height="${H}" fill="#161a27"/>
    <rect x="${lw}" width="${vw}" height="${H}" fill="${fill}"/>
    <rect width="${w}" height="${H}" fill="url(#${id})"/>
    <rect x="${lw}" width="${vw}" height="${H}" fill="#fff" opacity="0">
      <animate attributeName="opacity" values="0;.28;0" dur="2.4s"
               begin="${(i * 0.13).toFixed(2)}s" repeatCount="1" fill="freeze"/>
    </rect>
  </g>
  <g font-family="'Segoe UI',Verdana,DejaVu Sans,sans-serif" font-size="11">
    <text x="${lw / 2}" y="15" fill="#000" fill-opacity=".45" text-anchor="middle"
          textLength="${lw - PAD * 2}" lengthAdjust="spacingAndGlyphs">${esc(label)}</text>
    <text x="${lw / 2}" y="14" fill="#c7cede" text-anchor="middle"
          textLength="${lw - PAD * 2}" lengthAdjust="spacingAndGlyphs">${esc(label)}</text>
    <text x="${lw + vw / 2}" y="15" fill="#000" fill-opacity=".35" text-anchor="middle"
          textLength="${vw - PAD * 2}" lengthAdjust="spacingAndGlyphs">${esc(value)}</text>
    <text x="${lw + vw / 2}" y="14" fill="#fff" text-anchor="middle" font-weight="600"
          textLength="${vw - PAD * 2}" lengthAdjust="spacingAndGlyphs">${esc(value)}</text>
  </g>
</svg>
`;
}
function hash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; }

// ── the numbers, read out of the project ─────────────────────────────
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const dep = v => String(v || '').replace(/^[\^~]/, '');

//  tor.exe's own --version line, not a number typed from memory.
function torVersion() {
    const exe = path.join(ROOT, 'Tor', 'tor', 'tor.exe');
    const out = execFileSync(exe, ['--version'], { encoding: 'utf8', timeout: 20000 });
    const m = /Tor version ([0-9.]+)/.exec(out);
    if (!m) throw new Error('tor.exe --version did not print a version: ' + out.slice(0, 120));
    return m[1];
}
//  lib/browsers.js's own catalogue, counted by family so the badge cannot
//  claim a browser the app has no route into.
function browserCounts() {
    const src = fs.readFileSync(path.join(ROOT, 'lib', 'browsers.js'), 'utf8');
    const fam = {};
    for (const m of src.matchAll(/id:\s*'[a-z0-9]+',\s*name:\s*'[^']+',\s*family:\s*'(\w+)'/g))
        fam[m[1]] = (fam[m[1]] || 0) + 1;
    const total = Object.values(fam).reduce((a, b) => a + b, 0);
    if (total < 10) throw new Error('lib/browsers.js parsed to only ' + total + ' browsers');
    return { total, fam };
}
//  The extension's own manifest version, and its manifest_version.
function extManifest() {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'Extension', 'manifest.json'), 'utf8'));
}

const TOR      = torVersion();
const BROWSERS = browserCounts();
const COUNTRIES = Object.keys(geoFromMainJs(ROOT)).length;
const EXT      = extManifest();
const PROBES   = fs.readdirSync(path.join(ROOT, '.build'))
                   .filter(f => /^(test|probe)-.*\.js$/.test(f)).length;

const C = {
    violet: '#6d28d9', magenta: '#a21566', indigo: '#5031b2', green: '#15803d',
    amber:  '#b45309', slate:   '#334155', blue:   '#1d4ed8', teal: '#0f766e',
};

const BADGES = [
    { file: 'version',   label: 'release',    value: 'v' + pkg.version,            fill: C.violet },
    { file: 'platform',  label: 'platform',   value: 'Windows 10 / 11 x64',        fill: C.blue },
    { file: 'electron',  label: 'electron',   value: dep(pkg.devDependencies.electron), fill: C.indigo },
    { file: 'tor',       label: 'tor',        value: TOR,                          fill: C.magenta },
    { file: 'license',   label: 'license',    value: 'MIT',                        fill: C.green },
    { file: 'extension', label: 'extension',  value: `MV${EXT.manifest_version} v${EXT.version}`, fill: C.teal },
    { file: 'browsers',  label: 'browsers',   value: `${BROWSERS.total} supported`, fill: C.slate },
    { file: 'countries', label: 'exit countries', value: `${COUNTRIES} spoofable`,  fill: C.slate },
    { file: 'telemetry', label: 'telemetry',  value: 'none',                       fill: C.green },
    { file: 'accounts',  label: 'sign-up',    value: 'not required',               fill: C.green },
    { file: 'probes',    label: 'probe suite',value: `${PROBES} scripts`,          fill: C.amber },
    { file: 'admin',     label: 'runs as',    value: 'administrator',              fill: C.amber },
];

fs.mkdirSync(OUT, { recursive: true });
let n = 0;
for (const b of BADGES) {
    const svg = badge({ label: b.label, value: b.value, fill: b.fill, i: n });
    fs.writeFileSync(path.join(OUT, b.file + '.svg'), svg, 'utf8');
    console.log(`  ok   badges/${b.file}.svg`.padEnd(34) + `${b.label}: ${b.value}`);
    n++;
}
console.log(`\n  ${n} badges written to ${OUT}`);
console.log(`  read from the project: v${pkg.version}, electron ${dep(pkg.devDependencies.electron)}, ` +
            `tor ${TOR}, MV${EXT.manifest_version} v${EXT.version},`);
console.log(`  ${BROWSERS.total} browsers (` +
            Object.entries(BROWSERS.fam).map(([k, v]) => `${v} ${k}`).join(', ') +
            `), ${COUNTRIES} spoofable countries, ${PROBES} probe scripts.`);



