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
//  Four UInt32LE of pickle preamble, then the JSON header, then the data block.
//
//  The data block begins at 8 + headerPickleSize, NOT at 16 + headerStringSize.
//  A pickle pads its payload up to a 4-byte boundary, so the two agree only when
//  the header's JSON length happens to be a multiple of 4 -- three builds in four
//  it is not, and every offset in this file is then 1 to 3 bytes early. MEASURED
//  on the 2.0.5 build: headerStringSize 33479, 33479 % 4 = 3, so one byte of
//  padding, and main.js/renderer.js/index.html/globe-controller.js all "differed
//  from source" while being byte-perfect in the artifact -- the exact false
//  positive this probe exists to rule out, pointing the wrong way. It also fed
//  the previous file's last byte into JSON.parse(package.json) -- ";{" -- which
//  threw and took the twenty-odd NAMED checks below down with it, unrun.
const fd = fs.openSync(ASAR, 'r');
const pre = Buffer.alloc(16);
fs.readSync(fd, pre, 0, 16, 0);
const hdrSize = pre.readUInt32LE(12);          // JSON header length
const DATA = 8 + pre.readUInt32LE(4);          // padded: the real data offset
const hdrBuf = Buffer.alloc(hdrSize);
fs.readSync(fd, hdrBuf, 0, hdrSize, 16);
const header = JSON.parse(hdrBuf.toString('utf8'));
const PAD = DATA - (16 + hdrSize);
if (PAD < 0 || PAD > 3)
    throw new Error(`asar preamble makes no sense: data at ${DATA}, header ends at ` +
                    `${16 + hdrSize} (${PAD} bytes of padding, expected 0-3). Every ` +
                    'byte-compare below would be meaningless, so nothing is reported.');


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

//  git decides what changed, not a list in here. The hand-written list this
//  replaced still named the PREVIOUS round's files, so lib/tunnel.js -- the fix
//  this round is about -- was never read back out of the artifact at all, and
//  34/34 said otherwise.
const NOT_PACKAGED = {
    '.build/':          'suites and probes are not shipped',
    'Extension-Store/': 'the Edge submission copy; build-zip.js packages that one',
    'installer.nsh':    'NSIS consumes it while building, so it is never in the payload',
    '.gitignore':       'repository metadata',
    'package-lock.json': 'npm metadata',
};
//  package.json IS packaged but is rewritten by the packer, so it cannot be
//  byte-compared. The field check below is its check.
const REWRITTEN = ['package.json'];

const CHANGED = require('child_process')
    .execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' })
    .split(/\r?\n/)
    .filter(l => l.length > 3 && l[0] !== 'D' && l[1] !== 'D')
    .map(l => l.slice(3).trim().replace(/^"|"$/g, ''))
    .map(f => f.includes(' -> ') ? f.split(' -> ').pop() : f)
    .filter(f => !f.endsWith('/'));
const exempt  = f => Object.keys(NOT_PACKAGED).find(p => f.startsWith(p));
const payload = CHANGED.filter(f => !exempt(f) && !REWRITTEN.includes(f));
const skipped = CHANGED.filter(f => exempt(f));

console.log('── every changed source file, read back out of the artifact ──');
ok(CHANGED.length > 0 && payload.length > 0,
   `git names ${CHANGED.length} changed files, ${payload.length} of them payload`,
   CHANGED.join(' '));
for (const rel of payload) {
    const src = fs.readFileSync(path.join(ROOT, rel));
    const got = readFromArtifact(rel);
    if (!got.buf) { ok(false, `${rel} is in the artifact`, `not found (${got.where}) ${got.missing || ''}`); continue; }
    ok(src.equals(got.buf),
       `${rel} matches source byte for byte (${got.where}, ${got.buf.length} B)`,
       `source ${src.length} B vs artifact ${got.buf.length} B in the ${got.where}`);
}

//  An exemption nothing tests is a hole of its own, so each one is asserted
//  absent rather than skipped in silence.
for (const rel of skipped) {
    const got = readFromArtifact(rel);
    ok(!got.buf, `${rel} is correctly not in the payload -- ${NOT_PACKAGED[exempt(rel)]}`,
       `found it in the ${got.where}`);
}

//  package.json is deliberately NOT byte-compared: electron-builder rewrites it,
//  dropping scripts, devDependencies and the whole build block, so the packed copy
//  is a few hundred bytes against the source's few thousand. Comparing the bytes
//  would fail for ever and teach a later reader to ignore this probe. Only the
//  three fields the runtime actually reads are checked.
{
    const src = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const got = readFromArtifact('package.json');
    //  Caught, not thrown: an unhandled SyntaxError here ends the process and the
    //  NAMED checks below never run at all -- which is how a one-byte offset slip
    //  silenced the whole second half of this probe once.
    let pkg = {}, parseErr = null;
    if (got.buf) { try { pkg = JSON.parse(got.buf.toString('utf8')); } catch (e) { parseErr = e.message; } }
    ok(!parseErr, 'the packed package.json is readable JSON',
       `${parseErr} -- first bytes ${JSON.stringify((got.buf || Buffer.alloc(0)).slice(0, 16).toString('utf8'))}` +
       `, so suspect the data offset (DATA=${DATA}, ${PAD} pad), not the build`);
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

    //  Photo 1 -- connected to NL and Maps still centred on the real position.
    ['Extension/geo-spoof.js', 'appOff === true',
     'the leak itself: "off" now has to be SAID, and only that record may hand a ' +
     'page to Chromium\'s own provider. A bare {active:false} used to mean off by ' +
     'absence, which is what put the device\'s real location on the map'],
    ['Extension/geo-spoof.js', 'FRESH_MS',
     'and an "off" older than the window is not trusted -- a stale one answers ' +
     'POSITION_UNAVAILABLE instead of delegating'],
    ['Extension/background.js', 'appOff: true',
     'the only writer of that record, and it writes it after connected is cleared'],
    ['Extension/background.js', 'stamp',
     'every record carries the moment it was written, which is what makes staleness ' +
     'a thing a page can measure'],

    //  Photo 2 -- "the Wintun adapter never appeared" beside "Your real IP, DNS &
    //  GPS are hidden".
    ['renderer.js', 'function scopeNote',
     'the toast now states its own scope, so a failed tunnel cannot be announced ' +
     'as whole-device cover'],
    ['lib/tunnel.js', "'--device'",
     'two dashes. pflag read the old -device as -d evice and created the adapter ' +
     'under that name; lib/tunnel.js waited for FreeProxyTun, which never came'],
];

console.log('\n── and the fixes are in it by name, not just by size ──');
for (const [rel, needle, why] of NAMED) {
    const got = readFromArtifact(rel);
    const text = got.buf ? got.buf.toString('utf8') : '';
    const n = text.split(needle).length - 1;
    ok(n > 0, `${rel}: ${why}`, `"${needle}" appears ${n} times in the ${got.where} copy`);
}

//  The screenshot's sentence, which had to LEAVE. Comments stripped first: the
//  fixed renderer quotes it while explaining why it is gone, and a plain grep
//  reads that explanation as the bug.
{
    const { stripComments } = require('./srcstrip.js');
    const got = readFromArtifact('renderer.js');
    const code = stripComments(got.buf ? got.buf.toString('utf8') : '');
    ok(got.buf && !/real IP, DNS &(amp;)? GPS are hidden/.test(code),
       'renderer.js: the shipped sentence from photo 2 is in no branch of the artifact',
       'still there -- the payload predates the fix');
}

fs.closeSync(fd);
console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
