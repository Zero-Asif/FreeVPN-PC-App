'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/test-readme-lines.js
//
//  README points into the source BY LINE NUMBER, in three dozen places:
//
//      | `connect-vpn` | [`main.js:5942`](main.js#L5942) -- connect to a ... |
//
//  probe-readme-links.js already refuses a reference past the end of a file or
//  at a blank line, and that is as far as a link checker can go. It cannot know
//  that line 5942 is still the connect handler. Every edit above it moves the
//  whole table by however many lines were added, and nothing says a word: the
//  link resolves, GitHub highlights a line, and the line is now an unrelated
//  statement -- usually a comment, because comments are most of this codebase.
//  A page that points confidently at the wrong line is worse than one that gives
//  no line at all.
//
//  MEASURED, the first time this ran: all 18 references in the IPC table were
//  stale, by 1400-2900 lines each, and every one of them landed inside a comment.
//
//  So this asserts what each reference CLAIMS: the ipcMain registration for the
//  channel in that row, the declaration or the call the prose names, and the
//  count of scripts in this directory. Rows are read out of README, targets are
//  read out of the source, and the answer is the file's own line numbering --
//  nothing here is a stored expectation.
//
//  Sections 6 and 7 came later, from the same defect one layer out. A COUNT rots
//  the same way a line number does, and MEASURED again: walkthrough.svg said "7
//  firewall rules" and "111 probe scripts", CONTRIBUTING.md said 111 twice, and
//  README's alt text for that picture said 7. All were true when typed. So every
//  counted figure in every document and every picture, badges included, is
//  re-derived from the source it describes. Section 7 then checks the four things
//  that decide whether an SVG parses at all, because a comment in a picture is
//  where a dash gets typed and XML rejects the file for it.
//
//  WHY IT IS test-* AND NOT probe-*
//  It was a probe, and a probe is not in run-offline.js's SUITES, so nothing ran
//  it. MEASURED the first time it was run again: 24 stale references and three
//  stale counts had accumulated silently. It reads only files in this repository,
//  so it is deterministic and offline -- a suite. Under a test-* name test-vendor.js
//  will not let it drop out of the gate again.
//
//  Run:  node .build/test-readme-lines.js
// ════════════════════════════════════════════════════════════════════
const fs   = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (c, m, x) => {
    if (c) { pass++; console.log('  ok   ' + m); }
    else { fail++; console.log('  FAIL ' + m + (x ? '\n         ' + String(x) : '')); }
};

const ROOT   = path.join(__dirname, '..');
const README = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const src    = f => fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n');
const MAIN   = src('main.js');
const REND   = src('renderer.js');
const at     = (lines, n) => (lines[n - 1] || '').trim();

console.log('=== test-readme-lines ===\n');

// ── 1. the IPC table ────────────────────────────────────────────────
console.log('-- 1. every channel row points at that channel\'s handler --');
//  Where each channel is registered. Both shapes count: handle() for a call
//  that returns a value, on() for fire-and-forget.
const reg = new Map();
MAIN.forEach((line, i) => {
    const m = line.match(/ipcMain\.(?:handle|on)\(\s*'([^']+)'/);
    if (m && !reg.has(m[1])) reg.set(m[1], i + 1);
});
ok(reg.size > 0, `main.js registers ${reg.size} IPC channels`);

//  Table rows: first cell is one or more backticked channel names, and the rest
//  of the row carries the references.
const rows = [];
for (const line of README.split('\n')) {
    if (!/^\|\s*`[a-z-]/.test(line)) continue;
    const cells = line.split('|').map(s => s.trim());
    const chans = [...(cells[1] || '').matchAll(/`([a-z][a-z0-9-]*)`/g)].map(m => m[1]);
    const refs  = [...line.matchAll(/main\.js#L(\d+)/g)].map(m => Number(m[1]));
    if (chans.length && refs.length) rows.push({ chans, refs, line });
}
ok(rows.length > 0, `${rows.length} rows point at main.js by line number`);

//  Checked as a set, because a row documenting two channels lists them in the
//  order that reads best, not the order the handlers happen to appear in.
const wrong = [];
for (const r of rows) {
    const named = r.chans.filter(c => reg.has(c));
    if (!named.length) continue;
    const want = new Set(named.map(c => reg.get(c)));
    for (const n of r.refs) {
        if (want.has(n)) continue;
        wrong.push(`#L${n} for \`${named.join('/')}\` -- that line reads: ` +
                   JSON.stringify(at(MAIN, n).slice(0, 72)) +
                   '\n           the registration is at ' +
                   named.map(c => `${c}:${reg.get(c)}`).join(', '));
    }
}
ok(wrong.length === 0,
   'every main.js#Lnnn in those rows lands on the ipcMain registration for a ' +
   'channel that row names', wrong.join('\n         '));

const documented = new Set(rows.flatMap(r => r.chans));
const missing = [...reg.keys()].filter(c => !documented.has(c));
ok(missing.length === 0,
   `all ${reg.size} registered channels appear in the table, so "Every ` +
   'interface, listed" is a promise the table keeps', missing.join(', '));
ok([...documented].every(c => reg.has(c)) ||
   [...documented].filter(c => !reg.has(c)).length === 0,
   'and it names no channel main.js does not register',
   [...documented].filter(c => !reg.has(c)).join(', '));

// ── 2. the number shown and the number linked ───────────────────────
console.log('\n-- 2. the number a reader sees is the number the link goes to --');
//  Two forms are in use: the full `main.js:5942` and the bare `2512` in the row
//  that carries two links. Both are numbers a reader compares by eye.
const mismatch = [];
for (const m of README.matchAll(/\[`(?:([a-z.-]+\.js):)?(\d+)`\]\(([a-z.-]+\.js)#L(\d+)\)/g)) {
    if (m[1] && m[1] !== m[3]) mismatch.push(`${m[1]} shown, ${m[3]} linked`);
    if (m[2] !== m[4]) mismatch.push(`${m[3]}: ${m[2]} shown, ${m[4]} linked`);
}
ok(mismatch.length === 0,
   'no reference shows one line number and links to another', mismatch.join(' | '));

// ── 3. the references the prose makes by name ───────────────────────
console.log('\n-- 3. and the ones the prose names rather than tabulates --');
//  Each of these is a claim in a sentence, and the sentence says what is there.
const NAMED = [
    ['main.js',     /GEO_COORDS` at\s*\n?\[`main\.js:(\d+)`\]/,      MAIN, /^const GEO_COORDS = \{$/,
     'the GEO_COORDS declaration, which the 74-country badge is counted from'],
    //  `async` and the indent are both legitimate here -- startupCleanup() awaits
    //  a firewall read and lives inside runAdminApp() -- so the modifier is
    //  optional in both patterns. Pinning the exact signature turned this line red
    //  for a change it was never written to catch.
    ['main.js',     /`startupCleanup\(\)` at \[`main\.js:(\d+)`\]/,  MAIN,
     /^(?:async\s+)?function startupCleanup\(\)\s*\{$/,
     'the startupCleanup() declaration'],
    ['main.js',     /called from\s*\n?\[`main\.js:(\d+)`\]/,         MAIN,
     /^(?:await\s+)?startupCleanup\(\);$/,
     'the one place that calls it'],
    ['renderer.js', /\[`renderer\.js:(\d+)`\]/,                      REND, /Nothing is connected right now/,
     'the default footer this app had to stop using for one ask'],
    //  The two rows of the "what was wrong / what it does now" table that point
    //  at code. They are not channel rows, so section 1 does not see them.
    ['main.js',     /\[`main\.js:(\d+)`\]\(main\.js#L\d+\) \| the "your country is available again"/,
     MAIN, /^foot:/,
     "the foot: that ask now sends, which is what that row says was missing"],
    ['main.js',     /\[`main\.js:(\d+)`\]\(main\.js#L\d+\) \| `get-fastest-server` returned/,
     MAIN, /ipcMain\.handle\('get-fastest-server'/,
     'the get-fastest-server handler that stopped inventing a winner'],
];
for (const [file, find, lines, want, what] of NAMED) {
    const m = README.match(find);
    if (!m) { ok(false, `README still references ${what}`, String(find)); continue; }
    const n = Number(m[1]);
    ok(want.test(at(lines, n)),
       `${file}#L${n} is ${what}`,
       `that line reads: ${JSON.stringify(at(lines, n).slice(0, 80))}`);
}
//  The badge's number and the table it is counted from, in one place.
const geoAt = Number((README.match(/GEO_COORDS` at\s*\n?\[`main\.js:(\d+)`\]/) || [0, 0])[1]);
const decl = MAIN.slice(geoAt - 1).join('\n');
let depth = 0, end = 0;
for (let i = decl.indexOf('{'); i < decl.length; i++) {
    if (decl[i] === '{') depth++;
    else if (decl[i] === '}' && --depth === 0) { end = i; break; }
}
const entries = (decl.slice(0, end).match(/'[a-z]{2}'\s*:\s*\{/g) || []).length;
const claimed = Number((README.match(/(\d+) is the number of entries in `GEO_COORDS`/) || [0, 0])[1]);
ok(entries > 0 && entries === claimed,
   `and there really are ${entries} entries in it, which is the number README ` +
   'gives for the countries that can be spoofed',
   `README says ${claimed}, the table has ${entries}`);

// ── 4. a reference into a comment is the drift symptom ──────────────
console.log('\n-- 4. no reference lands in a comment --');
//  Every one of the 18 stale references this file was written for pointed at a
//  comment line. Nothing README links to is a comment, so this is both a real
//  rule and the cheapest possible detector for the next drift.
const inComment = [];
for (const m of README.matchAll(/\(((?:main|renderer|preload)\.js)#L(\d+)\)/g)) {
    const lines = m[1] === 'main.js' ? MAIN : m[1] === 'renderer.js' ? REND : src(m[1]);
    const text = at(lines, Number(m[2]));
    if (/^(\/\/|\/\*|\*)/.test(text)) inComment.push(`${m[1]}#L${m[2]}: ${JSON.stringify(text.slice(0, 60))}`);
}
ok(inComment.length === 0,
   'every reference points at code, not at prose about code -- which is what a ' +
   'stale one almost always hits', inComment.join('\n         '));

// ── 5. the count of scripts in this directory ───────────────────────
console.log('\n-- 5. and the probe count is counted --');
const real = fs.readdirSync(__dirname).filter(f => /^(test|probe)-.*\.js$/.test(f)).length;
const said = Number((README.match(/`\.build\/` holds \*\*(\d+)\*\* scripts/) || [0, 0])[1]);
ok(real === said,
   `README says ${said} scripts named test-* or probe-*, and there are ${real}`,
   `off by ${Math.abs(real - said)}`);
const badge = path.join(ROOT, 'docs', 'media', 'badges', 'probes.svg');
if (fs.existsSync(badge)) {
    const b = fs.readFileSync(badge, 'utf8');
    const bn = Number((b.match(/(\d+)\s*scripts?/) || b.match(/>(\d+)</) || [0, 0])[1]);
    ok(bn === real,
       `and the badge at the top of the page agrees (${bn})`,
       `badge says ${bn}, there are ${real} -- run make-badges.js`);
    //  The badge is an image, so its number reaches a screen reader only through
    //  the alt text -- which is hand-written and was 14 scripts behind the badge
    //  it describes.
    const alt = (README.match(/badges\/probes\.svg" alt="([^"]*)"/) || [0, ''])[1];
    ok(Number((alt.match(/(\d+)/) || [0, 0])[1]) === real,
       `and so does the alt text a screen reader reads out ("${alt}")`);
}

// ── 6. every figure in the prose and in the pictures ─────────────────
//  Same defect as section 1, one layer out. A line reference rots because the
//  file above it grew; a COUNT rots because the thing counted grew. MEASURED,
//  the first time this section ran: docs/media/walkthrough.svg said "7 firewall
//  rules" and "111 probe scripts", CONTRIBUTING.md said "111" twice, and
//  README's alt text for that same picture said 7. Every one of those numbers
//  was correct on the day it was typed -- the DNS block later became three rules
//  and .build/ grew by fourteen scripts -- and nothing anywhere said a word,
//  because a number inside an <svg> has no test around it unless someone writes
//  one, and a picture is the last place a reader looks for a lie.
//
//  So: count the thing, then find every place any document CLAIMS that count and
//  require the two to agree. A historical figure would fail this, correctly --
//  spell one in words if it is ever needed.
console.log('\n-- 6. every counted figure, counted --');

//  lib/browsers.js's own catalogue, by family -- the same read make-badges.js
//  does, so the badge and this probe cannot disagree about what 14 means.
const BROWSERS = (() => {
    const s = fs.readFileSync(path.join(ROOT, 'lib', 'browsers.js'), 'utf8');
    const fam = {};
    for (const m of s.matchAll(/id:\s*'[a-z0-9]+',\s*name:\s*'[^']+',\s*family:\s*'(\w+)'/g))
        fam[m[1]] = (fam[m[1]] || 0) + 1;
    return { total: Object.values(fam).reduce((a, b) => a + b, 0), ...fam };
})();
ok(BROWSERS.total > 0 && BROWSERS.chromium > 0 && BROWSERS.gecko > 0,
   `lib/browsers.js lists ${BROWSERS.total} browsers ` +
   `(${BROWSERS.chromium} chromium, ${BROWSERS.gecko} gecko, ${BROWSERS.wininet} wininet)`);

//  The firewall rule NAMES this app can create. Not a table -- the adds are
//  inline command strings in three shapes, plus one PowerShell rule in
//  geo-spoof.js -- so all four shapes are read, and the answer is the size of
//  the set they produce.
const MAINTEXT = MAIN.join('\n');
const fwNames = (() => {
    const names = new Set();
    const lock = {};
    const tbl = MAINTEXT.match(/const DNS_LOCK_RULES = \{([\s\S]*?)\};/);
    if (tbl) for (const m of tbl[1].matchAll(/(\w+):\s*'([^']+)'/g)) lock[m[1]] = m[2];
    for (const m of MAINTEXT.matchAll(/add rule name="([^"$]+)"/g)) names.add(m[1]);
    for (const m of MAINTEXT.matchAll(/add rule name="\$\{DNS_LOCK_RULES\.(\w+)\}"/g))
        if (lock[m[1]]) names.add(lock[m[1]]);
    for (const m of MAINTEXT.matchAll(/fwFix\('([^']+)'/g)) names.add(m[1]);
    const geo = fs.readFileSync(path.join(ROOT, 'lib', 'geo-spoof.js'), 'utf8');
    const shield = geo.match(/const FW_RULE = '([^']+)'/);
    if (shield && /New-NetFirewallRule -DisplayName '\$\{FW_RULE\}'/.test(geo))
        names.add(shield[1]);
    return names;
})();
ok(fwNames.size > 0,
   `main.js and lib/geo-spoof.js can add ${fwNames.size} named firewall rules`,
   [...fwNames].join(', '));

//  The kill switch's allow list, and the uninstall list, both taken from the
//  modules that own them rather than counted out of prose.
const containment    = require(path.join(ROOT, 'lib', 'containment.js'));
const installerTasks = require(path.join(ROOT, 'lib', 'installer-tasks.js'));
const ALLOW = containment.RULE_NAMES;
ok(ALLOW.length > 0,
   `lib/containment.js owns ${ALLOW.length} allow rules for default-deny`);

//  A rule this app can ADD and never deletes leaves a machine firewalled by
//  software that is no longer installed -- which is the one failure in this file
//  that is not cosmetic.
const orphan = [...fwNames, ...ALLOW].filter(n => !installerTasks.FW_RULES.includes(n));
ok(orphan.length === 0,
   `all ${fwNames.size + ALLOW.length} rule names are in FW_RULES, so uninstall ` +
   'deletes by name every rule this app can add', orphan.join(', '));

//  The flag set the globe and the popup draw from.
const flags = fs.readdirSync(path.join(ROOT, 'vendor', 'flags'))
                .filter(f => f.endsWith('.svg')).length;

//  Every claim shape, and the count it has to equal. The noun is part of the
//  pattern, so a coordinate or a font-size can never be read as a claim.
const CLAIMS = [
    [/(\d+)\s+(?:exit\s+)?countries/gi,      entries,           'countries in GEO_COORDS'],
    [/(\d+)\s+spoofable/gi,                  entries,           'countries in GEO_COORDS'],
    [/(\d+)\s+Chromium\s+browsers/gi,        BROWSERS.chromium, 'chromium browsers'],
    [/(\d+)\s+Gecko\s+browsers/gi,           BROWSERS.gecko,    'gecko browsers'],
    [/(\d+)\s+browsers/gi,                   BROWSERS.total,    'browsers in lib/browsers.js'],
    [/(\d+)\s+IPC\s+channels/gi,             reg.size,          'ipcMain registrations'],
    [/(\d+)\s+(?:test\/)?probe\s+scripts/gi, real,              'scripts in .build/'],
    [/(\d+)\s+scripts/gi,                    real,              'scripts in .build/'],
    [/(\d+)\s+firewall\s+rules/gi,           fwNames.size,      'rule names this app can add'],
    [/(\d+)\s+flags/gi,                      flags,             'flag SVGs in vendor/flags'],
];

//  Documents and pictures, including the generated badges: a badge whose number
//  is stale means make-badges.js was not re-run, which is exactly how the probes
//  badge fell fourteen behind.
const DOCS = [];
for (const f of fs.readdirSync(ROOT)) if (/\.md$/.test(f)) DOCS.push(f);
for (const d of ['docs', 'docs/media', 'docs/media/badges']) {
    const dir = path.join(ROOT, ...d.split('/'));
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) if (/\.(md|svg)$/.test(f)) DOCS.push(d + '/' + f);
}

let claims = 0;
const bad = [];
for (const rel of DOCS) {
    //  Read with the newlines intact and the whitespace folded: an <svg> caption
    //  and a <desc> both wrap mid-claim, and "125\nprobe scripts" is the same
    //  claim as "125 probe scripts".
    const text = fs.readFileSync(path.join(ROOT, ...rel.split('/')), 'utf8')
                   .replace(/&#(\d+);/g, ' ');
    for (const [re, want, what] of CLAIMS)
        for (const m of text.matchAll(re)) {
            claims++;
            if (Number(m[1]) === want) continue;
            bad.push(`${rel}: ${JSON.stringify(m[0].replace(/\s+/g, ' '))} -- ` +
                     `there are ${want} ${what}`);
        }
}
ok(claims > 0, `${claims} counted figures appear across ${DOCS.length} documents ` +
               'and pictures');
ok(bad.length === 0,
   'every one of them is the number the source actually gives',
   bad.join('\n         '));

//  README's Firewall row does not just give a total, it breaks it down -- and a
//  breakdown that adds up to the wrong total is the sort of thing a reader trusts
//  precisely because it is itemised. Both sides are derived: the numbers out of
//  the row, the groups out of the rule names.
const FWROW = (README.match(/\|\s*\*\*Firewall\*\*\s*\|([^|]*)\|/) || [0, ''])[1];
const num = re => Number((FWROW.match(re) || [0, NaN])[1]);
const blocks = [...fwNames].filter(n => /Block/.test(n));
const shield = [...fwNames].filter(n => /location resolution/.test(n));
const allows = [...fwNames].filter(n => !/Block|location resolution/.test(n));
ok(num(/(\d+) named rules/) === fwNames.size,
   `README's Firewall row says ${num(/(\d+) named rules/)} named rules, and there ` +
   `are ${fwNames.size}`);
ok(num(/(\d+) outbound allows/) === allows.length,
   `its ${num(/(\d+) outbound allows/)} outbound allows are the ${allows.length} ` +
   'rules that name a binary', allows.join(', '));
ok(num(/(\d+) blocks/) === blocks.length,
   `its ${num(/(\d+) blocks/)} blocks are the ${blocks.length} named "Block"`,
   blocks.join(', '));
ok(num(/(\d+) location shield/) === shield.length,
   `and its ${num(/(\d+) location shield/)} location shield is the one ` +
   'lib/geo-spoof.js adds', shield.join(', '));
ok(allows.length + blocks.length + shield.length === fwNames.size,
   'the three groups account for every rule, so the breakdown adds up to the total');
ok(num(/armed,\s*(\d+) more/) === ALLOW.length,
   `and the "${num(/armed,\s*(\d+) more/)} more" with the Kill Switch armed is ` +
   `lib/containment.js's ${ALLOW.length}-rule allow list`);

// ── 7. and the pictures are still XML ────────────────────────────────
//  Found by nearly shipping it, while writing section 6's comment into
//  walkthrough.svg: XML forbids the sequence "--" inside a comment, and an SVG a
//  page loads through <img> is parsed as XML, not as HTML. So a doubled hyphen in
//  a comment is not a typo, it is a picture that renders as nothing at all -- and
//  the file it happens in is the one full of prose explaining the picture, where
//  a dash is the most natural thing in the world to type.
//
//  The art gate (probe-readme-art.js) would catch it, but that one needs Electron
//  and a display. These four rules are the ones that decide whether the parser
//  accepts the file, they cost nothing to check, and they are checked here so
//  they are checked on every run.
console.log('\n-- 7. every picture is still well-formed XML --');
const artDir = path.join(ROOT, 'docs', 'media');
const arts = fs.readdirSync(artDir).filter(f => f.endsWith('.svg'));
const illFormed = [];
for (const f of arts) {
    const s = fs.readFileSync(path.join(artDir, f), 'utf8');
    const open = (s.match(/<!--/g) || []).length, close = (s.match(/-->/g) || []).length;
    if (open !== close) illFormed.push(`${f}: ${open} <!-- but ${close} -->`);
    for (const m of s.matchAll(/<!--([\s\S]*?)-->/g)) {
        const n = (m[1].match(/--/g) || []).length;
        if (n) illFormed.push(`${f}: a comment contains "--" ${n} time(s) -- XML ` +
                              'rejects the file, so the picture does not render');
    }
    const bare = [...s.matchAll(/&(?!#\d+;|#x[0-9a-fA-F]+;|[a-zA-Z][a-zA-Z0-9]*;)/g)].length;
    if (bare) illFormed.push(`${f}: ${bare} bare & that is not an entity`);
    if (!/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/.test(s))
        illFormed.push(`${f}: no svg namespace, so <img> will not render it`);
}
ok(arts.length > 0, `${arts.length} pictures in docs/media/`);
ok(illFormed.length === 0,
   'none has an unclosed comment, a "--" inside a comment, a bare & or a missing ' +
   'namespace', illFormed.join('\n         '));

console.log('');
console.log(`${pass}/${pass + fail} checks passed` + (fail ? `  (${fail} FAILED)` : ''));
process.exit(fail ? 1 : 0);
