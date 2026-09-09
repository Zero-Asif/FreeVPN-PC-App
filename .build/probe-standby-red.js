'use strict';
//  Red-proof for test-standby.js: take each half of the stand-down out and the
//  suite has to fail. A green suite that stays green with the fix removed is not
//  evidence of anything.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SRC = path.join(__dirname, '..', 'Extension', 'background.js');
const SUITE = path.join(__dirname, 'test-standby.js');
const src = fs.readFileSync(SRC, 'utf8');
//  Node's tmpdir is the 8.3 form on this machine (USERPC~1), so realpath it:
//  a path that reads back differently is how a lookup misses silently.
const TMP = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'standby-red-')));

const MUTANTS = [
    ['no greeting at all',
     '        sendHello();\n', ''],
    ['the standby masks the proxy pref instead of relinquishing it',
     "    try { chrome.proxy.settings.clear({ scope: 'regular' }, () => void chrome.runtime.lastError); }\n    catch (e) {}",
     '    setBrowserProxy(false);'],
    ['onclose is left to run after a stand-down',
     '        if (stoodDown) return;\n        globalState.appRunning = false; globalState.connected = false;',
     '        globalState.appRunning = false; globalState.connected = false;'],
    ['any copy may remove itself',
     "    if (selfInstall !== 'development') return;", '    if (false) return;'],
    ['frames are still acted on after the answer',
     '        if (stoodDown) return;\n\n        //  The app naming a different copy',
     '\n        //  The app naming a different copy'],
    ['a standby dials the app again',
     'function connectToDesktop() {\n    if (stoodDown) return;',
     'function connectToDesktop() {'],
    ['the installType is never learned, so nothing is ever removed',
     '            selfInstall = (info && info.installType) || null;',
     '            selfInstall = null;'],
];

let proved = 0, missed = 0;
function attempt(what, file, env) {
    let out = '', code = 0;
    try {
        out = execFileSync(process.execPath, [SUITE], { encoding: 'utf8', env: { ...process.env, ...env } });
    } catch (e) { out = String(e.stdout || '') + String(e.stderr || ''); code = e.status || 1; }
    const tally = (out.match(/(\d+)\/(\d+) checks passed/) || []);
    const fails = (out.match(/^  FAIL /gm) || []).length;
    if (code !== 0 && fails > 0) {
        proved++;
        console.log('  RED   ' + what + '   (' + fails + ' check(s) failed, ' + (tally[0] || 'no tally') + ')');
    } else {
        missed++;
        console.log('  GREEN ' + what + '   -- the suite did NOT catch this   ' +
                    (tally[0] || out.trim().split('\n').slice(-1)[0]));
    }
}

function run(label, source, file, envKey, mutants) {
    for (const [what, from, to] of mutants) {
        if (!source.includes(from)) {
            console.log('  ANCHOR LOST  ' + what + '\n               ' + JSON.stringify(from.slice(0, 60)));
            missed++;
            continue;
        }
        const out = path.join(TMP, label + '-' + (proved + missed) + '.js');
        fs.writeFileSync(out, source.replace(from, to));
        attempt(what, out, { [envKey]: out });
    }
}

console.log('\n== the extension\'s half ==');
run('bg', src, SRC, 'FP_BG', MUTANTS);

console.log('\n== the app\'s half ==');
const MAINFILE = path.join(__dirname, '..', 'main.js');
const mainSrc = fs.readFileSync(MAINFILE, 'utf8');
run('main', mainSrc, MAINFILE, 'FP_MAIN', [
    ['any installType may be stood down',
     "                if (d.installType !== 'development') return;", ''],
    ['an unknown id list stands everyone down',
     '                if (!ours.length || ours.includes(d.id)) return;',
     '                if (ours.includes(d.id)) return;'],
    ['our own copy is stood down too',
     '                if (!ours.length || ours.includes(d.id)) return;',
     '                if (!ours.length) return;'],
    ['a malformed id is answered',
     '                if (typeof d.id !== \'string\' || !/^[a-p]{32}$/.test(d.id)) return;', ''],
    ['a standby still counts as a covered profile',
     '                geoLive.delete(ws);', ''],
    ['the store id is not counted as ours',
     '        for (const v of [e.knownId(), e.edgeStoreId, e.webstoreId]) {',
     '        for (const v of [e.knownId()]) {'],
]);

//  The byte-identical check reads the real store package either way, so it is not
//  mutable from here; every other check is.
console.log('\n' + proved + '/' + (proved + missed) + ' mutant(s) caught');
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
if (missed) process.exitCode = 1;
