'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/test-browser-intro.js  --  the first-open browser card
//
//  WHAT IT IS FOR. The card is the first thing a new user reads, and every
//  sentence on it is a claim about their machine. Three of those claims are the
//  kind that quietly turn into lies:
//
//    * "these are your browsers". browsers.detect() also reports the wininet
//      family, and iexplore.exe on this Windows opens EDGE -- so an "Internet
//      Explorer" row is a second Edge button under a name that opens nothing of
//      its own. It must not be listed.
//    * "turn the extension on here". True of the Chromium forks. NOT true of
//      Firefox and its forks: Gecko is spoofed by writing prefs into the
//      profile, so there is no add-on to enable and telling someone to go and
//      enable one is an instruction that cannot be followed.
//    * "it is already on / it is switched off". Only readable when this machine
//      has staged the extension and therefore knows its id. Before the first
//      connect there is no id, and a row that reported a state anyway would be
//      reporting the absence of the id as the absence of the extension.
//
//  HOW. introRows() is lifted out of main.js as text and run here with a stub
//  browsers/geoExt -- the real function, so this cannot pass against a copy that
//  has drifted. Everything else is asserted against main.js and renderer.js
//  directly, because a card is a chain of strings across two files and a
//  misspelt one fails silently.
//
//  Nothing here launches a browser, writes to the registry, or touches a real
//  profile. .build/probe-open-extpage.js is the measurement this file's
//  assertions about the command line come from: Edge, Chrome and Brave were all
//  started with their own extensions URL as the only argument and all three
//  opened "New tab" instead, so a click can open the browser and no more.
// ════════════════════════════════════════════════════════════════════
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const browsers = require('../lib/browsers');
const { GeoExt } = require('../lib/geo-ext');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fpintro-'));
let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
    if (cond) { pass++; console.log('  ok   ' + name); }
    else { fail++; console.log('  FAIL ' + name + (extra ? '  -- ' + extra : '')); }
};
const log = { debug: () => {}, info: () => {}, success: () => {},
              warn: () => {}, error: (...a) => console.log('   ERROR:', ...a) };

const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const mainRaw = read('main.js');
const rendRaw = read('renderer.js');
const mainSrc = strip(mainRaw);
const rendSrc = strip(rendRaw);

// ── the real introRows(), lifted out of main.js ─────────────────────
//  Textual extraction, for the same reason .build/verify-torrc.js uses it on
//  buildTorrc(): a retyped copy of the function would pass this file while the
//  shipping one was broken. The closing brace is the first one at the function's
//  own indent -- brace counting is no better here and considerably easier to get
//  wrong, since the body contains an arrow function with its own braces.
function lift(name, injected) {
    const head = `function ${name}() {`;
    const a = mainSrc.indexOf(head);
    if (a < 0) throw new Error(`${name}() is not in main.js under that name`);
    const b = mainSrc.indexOf('\n    }', a);
    if (b < 0) throw new Error(`${name}() has no closing brace at its own indent`);
    const src = mainSrc.slice(a, b + '\n    }'.length);
    const keys = Object.keys(injected);
    return new Function(...keys, `${src}; return ${name};`)(...keys.map(k => injected[k]));
}

const EDGE = { id: 'edge', name: 'Microsoft Edge', family: 'chromium',
               exePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
               dataDir: 'C:\\ud\\edge', settings: 'edge://extensions' };
const BRAVE = { id: 'brave', name: 'Brave', family: 'chromium',
                exePath: 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
                dataDir: 'C:\\ud\\brave', settings: 'brave://extensions' };
const FIREFOX = { id: 'firefox', name: 'Firefox', family: 'gecko',
                  exePath: 'C:\\Program Files\\Mozilla Firefox\\firefox.exe',
                  dataDir: 'C:\\prof\\ff', settings: undefined };
const IE = { id: 'ie', name: 'Internet Explorer', family: 'wininet',
             exePath: 'C:\\Program Files\\Internet Explorer\\iexplore.exe',
             dataDir: null, settings: undefined };

/** introRows() with a fixed browser list and a fixed answer per profile. */
function rowsWith(detected, id, stateByDir) {
    const stub = {
        detect: () => detected.map(b => ({ ...b })),
        extensionState: (dir, wantId) => {
            if (wantId !== id) throw new Error('introRows asked with the wrong id: ' + wantId);
            return stateByDir[dir] ||
                { present: false, enabled: false, removedByUser: false, disabled: [] };
        },
    };
    return lift('introRows', { browsers: stub, geoExt: () => ({ knownId: () => id }) })();
}

console.log('── who is listed ──');
{
    const rows = rowsWith([EDGE, FIREFOX, IE], null, {});
    ok(rows.length === 2, 'three browsers detected, two listed', JSON.stringify(rows.map(r => r.id)));
    ok(!rows.some(r => r.id === 'ie'),
       'Internet Explorer is NOT listed -- iexplore.exe opens Edge on this Windows, so the ' +
       'row would be a second Edge button under a name that opens nothing of its own');
    ok(rows[0].id === 'edge' && rows[1].id === 'firefox', 'table order is kept');
    ok(rows.every(r => r.exePath && r.name && r.hint),
       'every row carries the exe to start, the name to show and a hint');
}

console.log('── Firefox is told the truth, not an instruction it cannot follow ──');
{
    const [ff] = rowsWith([FIREFOX], 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', {});
    ok(/nothing to enable/i.test(ff.hint), 'the Gecko row says there is nothing to enable', ff.hint);
    ok(!/extensions|switch it on|turn/i.test(ff.hint),
       'and it does not send the user to an extensions page that has no add-on on it', ff.hint);
    ok(ff.exePath === FIREFOX.exePath, 'it still opens Firefox when clicked');
}

console.log('── with no id, no row claims a state ──');
{
    //  This is the first-open case, and the one presence() cannot answer: it
    //  reports 'absent' for every browser when the id is null, which is the
    //  unknown id showing through rather than a profile that was read. A row
    //  that printed it would be inventing a measurement.
    const rows = rowsWith([EDGE, BRAVE], null, {
        //  Both profiles WOULD say "enabled" if anything asked them. Nothing may.
        'C:\\ud\\edge': { present: true, enabled: true, removedByUser: false, disabled: [] },
        'C:\\ud\\brave': { present: true, enabled: true, removedByUser: false, disabled: [] },
    });
    for (const r of rows) {
        ok(!/already on|switched off|you removed/i.test(r.hint),
           `${r.id}: says nothing about the extension's state`, r.hint);
        ok(r.hint.includes(r.id === 'edge' ? 'edge://extensions' : 'brave://extensions'),
           `${r.id}: still tells them where the switch is, in its own fork's URL`, r.hint);
    }
}

console.log('── with an id, every row says what that profile really holds ──');
{
    const ID = 'chgddbpnlfjjdlekafkddegnjklecdlk';
    const four = rowsWith([EDGE, BRAVE], ID, {
        'C:\\ud\\edge': { present: true, enabled: true, removedByUser: false, disabled: [] },
        'C:\\ud\\brave': { present: true, enabled: false, removedByUser: false,
                           disabled: ['user action'] },
    });
    ok(/already on/i.test(four[0].hint), 'enabled -> "already on here, nothing to do"', four[0].hint);
    ok(!/turn|open/i.test(four[0].hint),
       'and an enabled browser is not sent to the extensions page for no reason', four[0].hint);
    ok(/switched off/i.test(four[1].hint) && four[1].hint.includes('brave://extensions'),
       'present but off -> switched off, with Brave\'s own URL', four[1].hint);

    const [gone] = rowsWith([EDGE], ID, {
        'C:\\ud\\edge': { present: false, enabled: false, removedByUser: true, disabled: [] },
    });
    ok(/you removed it/i.test(gone.hint) && /will not offer it again/i.test(gone.hint),
       'removed by the user -> says so, and that Edge will not offer it again', gone.hint);

    const [none] = rowsWith([EDGE], ID, {});
    ok(none.hint.includes('edge://extensions') && !/already|switched off|removed/i.test(none.hint),
       'not in the profile -> the plain instruction, no state invented', none.hint);
}

console.log('── knownId(): a read of the journal, never a staging run ──');
{
    //  The point of knownId() is that it costs nothing. prepare() is what
    //  normally sets this.id, and it copies the extension into ProgramData,
    //  signs a CRX and writes policy -- unthinkable work to put a name on a
    //  card. So the id is taken back off disk, from the journal install()
    //  wrote, and when there is no journal the honest answer is null.
    const empty = path.join(TMP, 'no-journal');
    fs.mkdirSync(empty, { recursive: true });
    const cold = new GeoExt({ log, stateDir: empty, sourceDir: path.join(ROOT, 'Extension') });
    ok(cold.knownId() === null, 'no journal -> null, not a guess', String(cold.knownId()));
    ok(!fs.existsSync(path.join(empty, 'browser-setup')) &&
       !fs.existsSync(path.join(empty, 'ext-key.pem')),
       'and asking did not stage the extension or mint a key');

    const withJ = path.join(TMP, 'journal');
    fs.mkdirSync(withJ, { recursive: true });
    const ID = 'chgddbpnlfjjdlekafkddegnjklecdlk';
    fs.writeFileSync(path.join(withJ, 'ext-restore.json'),
                     JSON.stringify({ id: ID, version: '1.0.0' }), 'utf8');
    const warm = new GeoExt({ log, stateDir: withJ, sourceDir: path.join(ROOT, 'Extension') });
    ok(warm.knownId() === ID, 'a journalled id is read back verbatim', String(warm.knownId()));

    for (const bad of ['', 'zzzz', ID.toUpperCase(), ID + 'a', 'chgddbpnlfjjdlekafkddegnjklecdl']) {
        fs.writeFileSync(path.join(withJ, 'ext-restore.json'),
                         JSON.stringify({ id: bad }), 'utf8');
        const g = new GeoExt({ log, stateDir: withJ, sourceDir: path.join(ROOT, 'Extension') });
        ok(g.knownId() === null,
           `a malformed id (${JSON.stringify(bad)}) is null, not passed to a profile read`,
           String(g.knownId()));
    }
}

console.log('── this machine, for real ──');
{
    const here = browsers.detect();
    ok(here.length > 0, 'browsers.detect() finds something here', String(here.length));
    const listed = here.filter(b => b.family === 'chromium' || b.family === 'gecko');
    ok(!listed.some(b => b.family === 'wininet'), 'nothing of the wininet family is listed');
    const skipped = here.filter(b => b.family !== 'chromium' && b.family !== 'gecko');
    console.log(`     listed: ${listed.map(b => b.name).join(', ') || '(none)'}`);
    console.log(`     held back: ${skipped.map(b => `${b.name} [${b.family}]`).join(', ') || '(none)'}`);
    ok(listed.every(b => b.exePath && fs.existsSync(b.exePath)),
       'every listed browser has an exe that is really on disk -- a click cannot fail');
}

console.log('── the chain of strings, main.js -> renderer.js ──');
{
    //  Read out of the two files rather than exercised, because these links
    //  only ever meet in a running app: a card raised by main.js is drawn by
    //  renderer.js over IPC, and a key spelt two ways there fails in the one way
    //  nobody notices -- silently, with the sentence simply missing.
    ok(/mainWindow\.webContents\.once\('did-finish-load'[\s\S]{0,200}browserIntroCard\(\)/.test(mainSrc),
       'the card is raised on did-finish-load, once -- the renderer is listening by then');
    ok(/browserIntroCard\(\)\.catch\(/.test(mainSrc),
       'and it is awaited nowhere: a failure warns, it does not stop the window opening');

    ok(/function openBrowser\(row\)[\s\S]{0,300}spawn\(row\.exePath, \[\], \{ detached: true, stdio: 'ignore' \}\)/
        .test(mainSrc),
       'a click spawns the exe with an ARGS ARRAY and no arguments at all');
    ok(!/spawn\(row\.exePath[^)]*settings/.test(mainSrc),
       'the extensions URL is NOT on the command line -- measured: Edge, Chrome and Brave all ' +
       'filter their own URL off it and open the new-tab page, so the card names the page in words');
    ok(!/shell\.openExternal[\s\S]{0,80}row\./.test(mainSrc),
       'and it does not hand the click to shell.openExternal, which would open whichever ' +
       'browser is the default rather than the one whose name was clicked');

    ok(/family === 'chromium' \|\| b\.family === 'gecko'/.test(mainSrc),
       'introRows() filters to the two families that can be set up at all');
    ok(/id: 'later'/.test(mainSrc),
       'there is always a Later option -- the ask dialog has no dismiss, so a card ' +
       'without one is a card the user cannot get out of');
    ok(/defaultAnswer: 'later'/.test(mainSrc),
       'and if the window goes away with the card up, the answer defaults to Later');
    ok(/if \(pendingRestart\(\)\) \{[\s\S]{0,200}return;/.test(mainSrc),
       'it stands aside for the restart card instead of stacking two modals');
    ok(/if \(!shown\) shown = markIntroShown\(\);/.test(mainSrc),
       'the one-shot marker is written when the card is really up, not before');
    ok(/browser-intro-shown\.json/.test(mainSrc), 'the marker file is named once, in main.js');

    ok(/foot: '/.test(mainSrc), 'main.js really sends a `foot` string with the card');
    ok(/foot\?/.test(mainRaw) && /foot\?/.test(rendRaw),
       'and both sides document the key -- read out of the RAW files, since a payload key ' +
       'is documented in a comment and strip() takes those out');
    ok(/footEl\.textContent = ask\.foot \? ask\.foot/.test(rendSrc),
       'renderer.js prefers ask.foot over its own connect wording -- "no country has been ' +
       'chosen for you" under a list of browsers answers a question nobody asked');
    ok(/getElementById\('ask-foot-text'\)/.test(rendSrc) &&
       /id="ask-foot-text"/.test(read('index.html')),
       'and the element it writes into exists in index.html');
    ok(/variant: 'choice'/.test(mainSrc.slice(mainSrc.indexOf('async function browserIntroCard'))),
       'the card is a choice, not a live card: a full-screen modal, so Connect cannot be ' +
       'clicked underneath it and no connect-time ask can race it');
}

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
