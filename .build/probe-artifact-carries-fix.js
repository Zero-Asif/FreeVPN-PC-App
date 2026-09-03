'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/probe-artifact-carries-fix.js  --  does the built installer's payload
//  actually contain the bytes I edited?
//
//  test-artifact.js checks that the artifact is NEWER than every source file,
//  which is a timestamp, not a content check. The failure this guards against is
//  the one that already cost a round of end-to-end testing: three installed
//  copies on this machine that did not carry the fix, because the payload they
//  came from predated it. So every file changed in this working tree is read back
//  out of the artifact -- through the asar header for packed files, off disk for
//  the ones asarUnpack pulled out -- and compared byte for byte with the source.
//
//  An electron-builder asar stores files raw, but `unpacked: true` entries have
//  no offset at all: they live in app.asar.unpacked. Grepping the .asar for a
//  string in one of those returns 0 and reads as "the fix is missing" when it is
//  simply somewhere else, which is exactly the wrong conclusion to draw.
// ════════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RES = path.join(ROOT, 'release', 'win-unpacked', 'resources');
const ASAR = path.join(RES, 'app.asar');
const UNPACKED = path.join(RES, 'app.asar.unpacked');

let pass = 0, fail = 0;
const ok = (cond, what, extra) => {
    if (cond) { pass++; console.log('  ok   ' + what); }
    else { fail++; console.log('  FAIL ' + what); if (extra) console.log('         ' + extra); }
};

if (!fs.existsSync(ASAR)) {
    console.log('ABORT: no release/win-unpacked/resources/app.asar -- run `npm run dist` first.');
    process.exit(3);
}

// ── the asar header ─────────────────────────────────────────────────
//  16-byte pickle preamble, then a JSON header of hdrSize bytes, then the data
//  block. Offsets in the header are relative to the start of that data block.
const fd = fs.openSync(ASAR, 'r');
const pre = Buffer.alloc(16);
fs.readSync(fd, pre, 0, 16, 0);
const hdrSize = pre.readUInt32LE(12);
const hdrBuf = Buffer.alloc(hdrSize);
fs.readSync(fd, hdrBuf, 0, hdrSize, 16);
const DATA = 16 + hdrSize;
const header = JSON.parse(hdrBuf.toString('utf8'));

function entry(rel) {
    let node = header;
    for (const seg of rel.split('/')) {
        if (!node.files || !node.files[seg]) return null;
        node = node.files[seg];
    }
    return node;
}

//  Three places a file can be, and the reason each one exists:
//    packed    -- inside the asar, read at its offset
//    unpacked  -- asarUnpack pulled it out (an .exe cannot run from an asar, and
//                 the delivery helper is spawned as its own process)
//    resource  -- extraResources, never in the asar at all (Extension/)
function readFromArtifact(rel) {
    const e = entry(rel);
    if (e && e.offset !== undefined) {
        const b = Buffer.alloc(e.size);
        fs.readSync(fd, b, 0, e.size, DATA + Number(e.offset));
        return { where: 'asar', buf: b };
    }
    if (e && e.unpacked) {
        const p = path.join(UNPACKED, rel);
        if (!fs.existsSync(p)) return { where: 'unpacked', missing: p };
        return { where: 'unpacked', buf: fs.readFileSync(p) };
    }
    const p = path.join(RES, rel);
    if (fs.existsSync(p)) return { where: 'resource', buf: fs.readFileSync(p) };
    return { where: 'nowhere', missing: rel };
}

//  Every file this working tree has modified or added, per git status. If one of
//  these is stale in the artifact, an end-to-end test of it is testing the old
//  code and will be believed.
const CHANGED = [
    'main.js', 'renderer.js', 'index.html', 'globe-controller.js',
    'lib/exit-selector.js', 'lib/geo-ext.js', 'lib/installer-tasks.js',
    'lib/socks-fetch.js', 'lib/tor-control.js', 'lib/offthread.js',
    'lib/ext-deliver.js',
    'Extension/background.js', 'Extension/geo-bridge.js', 'Extension/geo-spoof.js',
    'Extension/manifest.json',
];
//  installer.nsh is modified too and is deliberately NOT here: NSIS consumes it
//  while building the installer, so it is never part of the payload. Listing it
//  would report "nowhere" for ever and teach a reader to skip the failures.

console.log('── every changed source file, read back out of the artifact ──');
for (const rel of CHANGED) {
    const src = fs.readFileSync(path.join(ROOT, rel));
    const got = readFromArtifact(rel);
    if (!got.buf) { ok(false, `${rel} is in the artifact`, `not found (${got.where}) ${got.missing || ''}`); continue; }
    ok(src.equals(got.buf),
       `${rel} matches source byte for byte (${got.where}, ${got.buf.length} B)`,
       `source ${src.length} B vs artifact ${got.buf.length} B in the ${got.where}`);
}

//  package.json is deliberately NOT byte-compared: electron-builder rewrites it,
//  dropping scripts, devDependencies and the whole build block, so the packed copy
//  is a few hundred bytes against the source's few thousand. Comparing the bytes
//  would fail for ever and teach a later reader to ignore this probe. Only the
//  three fields the runtime actually reads are checked.
{
    const src = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const got = readFromArtifact('package.json');
    const pkg = got.buf ? JSON.parse(got.buf.toString('utf8')) : {};
    ok(pkg.name === src.name && pkg.version === src.version && pkg.main === src.main,
       `package.json is rewritten by the packer, but name/version/main carry over ` +
       `(${pkg.name} ${pkg.version}, main ${pkg.main})`,
       JSON.stringify({ name: pkg.name, version: pkg.version, main: pkg.main }));
    ok(!pkg.devDependencies && !pkg.build,
       'and it is the stripped copy, so nothing in the artifact depends on the build config');
}

// ── and each fix, named, so a byte-compare passing for a stale pair of
//    identical files cannot read as coverage ───────────────────────────
const NAMED = [
    ['Extension/background.js', "chrome.proxy.settings.set({ value: { mode: 'direct' }, scope: 'regular' }, settled)",
     'the release WRITES a direct value -- clear() only relinquishes, and Chromium then applies ' +
     'the fossil id\'s fixed_servers underneath it'],
    ['Extension/background.js', 'chrome.windows.onRemoved',
     'the release at the last window close -- "brave e net pacchina" with the app shut'],
    ['Extension/background.js', 'chrome.windows.onCreated',
     'the re-assert that stops that release becoming a real-IP leak'],
    ['Extension/background.js', 'fpProxyLeftOn',
     'the mark a next start reads, since module evaluation clears the pref first'],
    ['Extension/background.js', 'settleStrandRepair',
     'the one-decision reload of the pages the dead proxy broke'],
    ['Extension/background.js', 'armProxyGuard',
     'the alarm watchdog for an evicted worker in a browser that IS running'],
    ['lib/ext-deliver.js', 'serveEarly',
     'the port bound at module scope, ~42 s before app.whenReady() would'],
    ['main.js', "installerTask(process.argv) === 'deliver'",
     'and main.js calling it before Electron starts -- this is the delayed prompt'],
    ['lib/installer-tasks.js', '--fp-deliver',
     'the flag the logon task passes, which is what selects that path'],

    //  Ask 1 -- the map must re-centre on the connected country after every
    //  reload, not only after the user clicks "Your location".
    ['Extension/background.js', 'repinMaps',
     'the /maps/@lat,lng,zoom pin rewritten on each reload, which is what decides ' +
     'Maps\' first-load centre (a conflicting UULE loses to it -- measured)'],

    //  Ask 3 -- the first connect after a fresh install must not fail.
    ['main.js', 'ClientTransportPlugin obfs4 exec ${q(P.lyre)}',
     'the plugin path UNQUOTED. The needle fails on the shipped-for-years quoted ' +
     'form, so this check is what tells a stale artifact from a fixed one'],
    ['main.js', 'cached-microdesc-consensus',
     'the cold-cache latch: the first bootstrap on a machine is recognised instead ' +
     'of being timed as if a consensus were already on disk'],
    ['main.js', 'COLD_AUTO_ROUNDS',
     'the automatic cold rounds -- a banked consensus retried without asking the ' +
     'user, which is the whole of "must not fail at first connection time"'],
    ['main.js', 'bestPct',
     'the progress bar reporting the best percent any round reached, so it stops ' +
     'falling 50% -> 0% while a retry is still running'],
    ['main.js', 'res.port === DNS_PORT',
     'the dns-bind narrowing: a stale tor holding :9050 is no longer "answered" by ' +
     'moving the DNS port'],
    ['main.js', 'userDataFallback',
     'the loud userData fallback -- the silent one shipped a build that looked fine ' +
     'and could not find its own state'],
];

console.log('\n── and the fixes are in it by name, not just by size ──');
for (const [rel, needle, why] of NAMED) {
    const got = readFromArtifact(rel);
    const text = got.buf ? got.buf.toString('utf8') : '';
    const n = text.split(needle).length - 1;
    ok(n > 0, `${rel}: ${why}`, `"${needle}" appears ${n} times in the ${got.where} copy`);
}

fs.closeSync(fd);
console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
