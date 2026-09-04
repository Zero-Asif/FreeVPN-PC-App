'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/probe-settings-persistence.js
//
//  settings.json is the only thing in this app that remembers what the user
//  asked for across a restart, and it has TWO ways to be wrong -- one at each
//  end of the same file:
//
//    1. WRITING. Every field in it also lives on appState, and appState is
//       assigned from eight places: the popup's TOGGLE_KS and CHANGE_SERVER,
//       the window's report-killswitch and toggle-killswitch, update-live-bypass,
//       disconnect-vpn, and establishConnection() -- which is where the app
//       window's dropdown, a switch and the exit watcher all end up. An
//       assignment with no saveSettings() beside it is not a lost write that
//       anything reports; it is the app silently forgetting one path's changes
//       while remembering the others, which reads to the user as "the setting
//       only sticks sometimes". Three of the eight were like that.
//
//    2. READING. This file lives in the app's own state directory, which is
//       writable by any process running as this user, and serverCode read out
//       of it goes on to build the torrc's ExitNodes line, the coordinates
//       handed to web pages, and the country the extension is told about. So
//       loadSettings() is run here for real, against files written to disk,
//       including the ones a hostile local process would write.
//
//  Nothing here starts Electron. loadSettings() is extracted from main.js by
//  brace matching and given its own fs and SETTINGS_FILE, so what is under test
//  is the shipped function.
//
//  Run:  node .build/probe-settings-persistence.js
// ════════════════════════════════════════════════════════════════════
const os   = require('os');
const path = require('path');
const fs   = require('fs');

let pass = 0, fail = 0;
const ok = (c, m, x) => {
    if (c) { pass++; console.log('  ok   ' + m); }
    else { fail++; console.log('  FAIL ' + m + (x ? '\n         ' + String(x) : '')); }
};

const ROOT = path.join(__dirname, '..');
const MAIN = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
//  Comment-stripped, because this file's questions are all about code shape and
//  main.js's comments quote the very lines being counted -- `saveSettings()`
//  among them, in the sentence that explains why it is there.
const CODE = MAIN.split('\n').map(l => (/^\s*\/\//.test(l) ? '' : l)).join('\n');

const TMP = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'fp-settings-')));
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {} });

//  Brace-matched from a known opening line, so a `}` inside the body does not
//  end the extraction early.
function extract(src, opener) {
    const at = src.indexOf(opener);
    if (at < 0) throw new Error('not found: ' + opener);
    let d = 0;
    for (let i = at; i < src.length; i++) {
        if (src[i] === '{') d++;
        else if (src[i] === '}' && --d === 0) return src.slice(at, i + 1);
    }
    throw new Error('unbalanced: ' + opener);
}

// ── 1. loadSettings(), run against real files ───────────────────────
console.log('\n[1] loadSettings() -- a file any local process can write');
const SRC_LOAD  = extract(MAIN, 'function loadSettings() {');
const SRC_COORD = extract(MAIN, 'function geoCoord(cc) {');
const SRC_PRED  = (MAIN.match(/const isSpoofableCc = [^\n]*/) || [''])[0];
const SETTINGS_FILE = path.join(TMP, 'settings.json');
//  The real geoCoord and the real predicate, over a two-country table: what is
//  being tested is the gate, not the size of GEO_COORDS.
const loadSettings = new Function('fs', 'SETTINGS_FILE', 'GEO_COORDS',
    `${SRC_COORD}\n${SRC_PRED}\n${SRC_LOAD}\n return loadSettings;`)(
        fs, SETTINGS_FILE, { us: { lat: 38.9, lon: -77 }, de: { lat: 52.5, lon: 13.4 } });

const DEFAULTS = { serverCode: 'us', killSwitch: false, bypassList: '', fullTunnel: true };
const load = text => {
    if (text === null) { try { fs.unlinkSync(SETTINGS_FILE); } catch (e) {} }
    else fs.writeFileSync(SETTINGS_FILE, text, 'utf8');
    return loadSettings();
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

ok(same(load(null), DEFAULTS),
   'no file at all reads as the defaults, not as a throw', JSON.stringify(load(null)));
ok(same(load('{'), DEFAULTS), 'and so does JSON that will not parse');
ok(same(load('null'), DEFAULTS),
   'and so does a file holding literal null -- JSON.parse SUCCEEDS on that, so ' +
   'the defaults there come from reading a field off null and landing in the ' +
   'catch, not from a parse failure');
ok(same(load('"us"'), DEFAULTS),
   'and so does a bare string, which does NOT throw: every field reads as ' +
   'undefined and every fallback answers');
ok(same(load('[]'), DEFAULTS), 'and so does an array');
ok(same(load('{}'), DEFAULTS), 'and so does an empty object');

// ── 2. every field, and every way to write it wrong ─────────────────
console.log('\n[2] each field, against what a local process could put there');
const j = o => JSON.stringify(o);
ok(load(j({ serverCode: 'de' })).serverCode === 'de', 'a real code is kept');
ok(load(j({ serverCode: 'DE' })).serverCode === 'de',
   'and lower-cased, so one spelling reaches the torrc and the coordinate table');
ok(load(j({ serverCode: 'zz' })).serverCode === 'us',
   'a two-letter code with no coordinates falls back to us -- the length test is ' +
   'not the membership test');
ok(load(j({ serverCode: '__proto__' })).serverCode === 'us',
   'and so does __proto__, which needed no injection at all: it was a key on ' +
   'Object.prototype and the old gate was `if (!GEO_COORDS[cc])`');
ok(load(j({ serverCode: 'constructor' })).serverCode === 'us', 'and constructor');
ok(load(j({ serverCode: ['us'] })).serverCode === 'us',
   'and an ARRAY holding a real code, which String() flattens to "us" -- this is ' +
   'JSON, where an array is one keystroke from a string');
ok(load(j({ serverCode: 'us\nExitNodes {de}' })).serverCode === 'us',
   'and a code carrying a newline, which is what would matter: the torrc is ' +
   'line-oriented, so a second directive smuggled through this field would be ' +
   'read by tor as its own line');

ok(load(j({ killSwitch: true })).killSwitch === true, 'killSwitch true is true');
ok(load(j({ killSwitch: 'true' })).killSwitch === false &&
   load(j({ killSwitch: 1 })).killSwitch === false,
   'and only the boolean is -- `=== true`, so a truthy string or 1 reads as OFF. ' +
   'The safe direction: a Kill Switch this app is unsure about must not be ' +
   'reported as armed');

ok(load(j({ bypassList: 'a.com; b.com' })).bypassList === 'a.com; b.com',
   'bypassList survives verbatim');
ok(load(j({ bypassList: 42 })).bypassList === '' &&
   load(j({ bypassList: ['a.com'] })).bypassList === '',
   'and a non-string reads as empty rather than being coerced into a registry ' +
   'ProxyOverride value');

ok(load(j({ fullTunnel: false })).fullTunnel === false,
   'fullTunnel false is the one escape hatch, and it works');
ok(load(j({ fullTunnel: 'no' })).fullTunnel === true &&
   load(j({ fullTunnel: 0 })).fullTunnel === true &&
   load(j({})).fullTunnel === true,
   'and anything else -- malformed, absent -- reads as ON, because whole-device ' +
   'coverage is the default and a typo must not silently downgrade it');

// ── 3. every assignment is also a write ─────────────────────────────
console.log('\n[3] appState assignments, and whether each one persists');
//  The invariant, stated as the scan performs it: for each of the three fields
//  that live in settings.json, an `appState.<field> =` must be followed by a
//  saveSettings() within a few lines. A wider window than the one-liners need,
//  because two of the sites do work between the two statements.
const FIELDS = /appState\.(serverCode|killSwitch|bypassList)\s*=[^=]/;
//  The scan proves it can fail before anything is concluded from its silence.
//  An assertion that cannot fail is worse than no assertion, and a "does every
//  site persist?" check that matches nothing answers yes.
const scan = src => {
    const ls = src.split('\n'), out = [];
    ls.forEach((l, i) => {
        if (!FIELDS.test(l)) return;
        out.push({ line: i + 1, field: l.match(FIELDS)[1],
                   saved: /saveSettings\(\)/.test(ls.slice(i, i + 16).join('\n')) });
    });
    return out;
};
ok(scan('appState.killSwitch = !!x;\nbroadcastState();').some(s => !s.saved) &&
   scan('appState.killSwitch = !!x;\nsaveSettings();').every(s => s.saved),
   'the scan reports an unsaved assignment and clears a saved one');
ok(scan('if (appState.serverCode === want) return;').length === 0 &&
   scan('appState.connected = true;').length === 0,
   'and it is not fooled by a comparison or by a field that is not persisted -- ' +
   'appState.connected and appState.since are session state, not settings');
const sites = scan(CODE);
ok(sites.length === 7,
   `there are ${sites.length} assignments to a persisted field, and 7 is the ` +
   'number this probe was written against -- a new one shows up here as a count ' +
   'mismatch rather than as a setting that quietly does not stick',
   sites.map(s => s.line + ':' + s.field).join(', '));
const unsaved = sites.filter(s => !s.saved);
ok(unsaved.length === 0,
   'and every one of them calls saveSettings() within 16 lines',
   unsaved.map(s => s.line + ': appState.' + s.field).join('\n         '));
//  Named individually, so the count above cannot be satisfied by the wrong seven.
for (const [field, n] of [['killSwitch', 4], ['serverCode', 2], ['bypassList', 1]]) {
    const got = sites.filter(s => s.field === field).length;
    ok(got === n, `${field} is assigned at ${n} site(s)`, String(got));
}

// ── 4. the round trip: written keys === read keys ────────────────────
console.log('\n[4] saveSettings() writes exactly what loadSettings() reads');
const SRC_SAVE = extract(MAIN, 'function saveSettings() {');
const written = [...SRC_SAVE.matchAll(/^\s{20}(\w+):/gm)].map(m => m[1]);
const read    = [...SRC_LOAD.matchAll(/^\s{16}(\w+):/gm)].map(m => m[1]);
ok(written.length === 4 && read.length === 4,
   'four fields each way', j({ written, read }));
ok(j([...written].sort()) === j([...read].sort()),
   'and they are the same four -- a field written but never read is dead weight, ' +
   'and a field read but never written silently resets on every restart',
   j({ written, read }));
ok(j(Object.keys(DEFAULTS).sort()) === j([...read].sort()),
   'and the catch-path defaults cover all four, so a corrupt file yields a ' +
   'complete object rather than one with holes in it');
ok(/fullTunnel: wantFullTunnel,/.test(SRC_SAVE) && !/appState\.fullTunnel/.test(CODE),
   'fullTunnel is saved from wantFullTunnel and is NOT on appState anywhere -- ' +
   'appState is the wire format the renderer and the extension both receive, so ' +
   'a main-process-only preference does not belong in it');

console.log('\n[5] and the write itself');
ok(/clearTimeout\(_saveTimer\);/.test(SRC_SAVE) && /_saveTimer = setTimeout\(/.test(SRC_SAVE),
   'debounced, because CHANGE_SERVER and UPDATE_BYPASS arrive in bursts from the ' +
   'popup and this is a synchronous write on the main thread');
ok(/try \{[\s\S]*writeFileSync[\s\S]*\} catch \(e\) \{[\s\S]*Logger\.warn/.test(SRC_SAVE),
   'and a failed write warns instead of throwing -- this runs inside a timer ' +
   'callback, where an uncaught throw is the "Uncaught exception" fault path');
ok(/JSON\.stringify\(\{[\s\S]*\}, null, 2\)/.test(SRC_SAVE),
   'and the file is written indented, since the fullTunnel escape hatch is ' +
   'documented as something the user edits by hand');

console.log('');
console.log(`${pass}/${pass + fail} checks passed` + (fail ? `  (${fail} FAILED)` : ''));
process.exit(fail ? 1 : 0);
