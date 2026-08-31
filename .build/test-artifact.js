'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/test-artifact.js  --  read the SHIPPED build, not the source.
//
//  WHY THIS EXISTS
//  Every other test in this directory reads the working tree. That proves the
//  code is right; it does not prove the code is in the installer. Those are
//  different claims, and the gap between them is exactly where this project has
//  already been bitten twice:
//
//    * Extension/ is NOT in the asar. It ships as an extraResource, so the
//      packaged extension lives at resources\Extension while __dirname points
//      inside app.asar, where it does not exist at all. A build that packs one
//      file short there is a route-3 install that serves a CRX of nothing --
//      and it fails only on a user's machine, silently, with the app reporting
//      that it offered the extension.
//    * "files" in package.json is an allow-list. A new lib/ file is covered by
//      lib/**/*, but a new top-level one is not, and neither is a new
//      extraResource. Adding a file to the repo does not add it to the build.
//
//  So: open release\win-unpacked\resources\app.asar and compare the packed
//  bytes of every file in the restart / route-3 chain against the working tree,
//  by sha256. Then check the resource layout the packaged code actually reads
//  at runtime, and that the installer postdates every source file in the chain.
//
//  WHAT THIS CANNOT CHECK, said plainly rather than faked: the compiled NSIS
//  script. makensis compresses the whole script and its string table into the
//  installer's solid LZMA block, so no literal from installer.nsh is findable
//  in the .exe -- measured, all five searched for and all five absent. What is
//  checkable is that installer.nsh is wired as nsis.include, that it compiled
//  (a syntax error is a failed build, and the build succeeded), and that the
//  .exe is NEWER than the .nsh -- i.e. this artifact was built after the last
//  edit to it. .build/test-installer-sweep.js is what proves the script's
//  behaviour, by extracting and running it.
//
//  Nothing is installed, no registry key is touched, no browser is opened.
// ════════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const asar = require('@electron/asar');

const ROOT = path.join(__dirname, '..');
const REL = path.join(ROOT, 'release');
const UNPACKED = path.join(REL, 'win-unpacked');
const RES = path.join(UNPACKED, 'resources');
const ASAR = path.join(RES, 'app.asar');
const SETUP = path.join(REL, 'FreeProxy-VPN-Setup-2.0.0.exe');

let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
    if (cond) { pass++; console.log('  ok   ' + name); }
    else { fail++; console.log('  FAIL ' + name + (extra ? '  -- ' + extra : '')); }
};
const sha = b => crypto.createHash('sha256').update(b).digest('hex').slice(0, 16);
const src = f => fs.readFileSync(path.join(ROOT, f));
const mtime = f => { try { return fs.statSync(f).mtimeMs; } catch (e) { return 0; } };

if (!fs.existsSync(ASAR)) {
    console.log('ABORT: no build to read. Run `npm run dist` first.');
    console.log('       looked for ' + ASAR);
    process.exit(3);
}

console.log('── the artifact is there, and it is this build ──');
ok(fs.existsSync(SETUP), 'the one-file installer exists', SETUP);
const setupSize = fs.existsSync(SETUP) ? fs.statSync(SETUP).size : 0;
//  The floor is the bundled redistributable plus Electron; a build that lost
//  either would still be an .exe, and would still install.
ok(setupSize > 100e6, 'and it is a whole installer, not a stub',
   (setupSize / 1e6).toFixed(1) + ' MB');

console.log('── every file of the chain is packed, byte for byte ──');
//  main.js reads the marker and serves the three IPC channels; renderer.js
//  draws the card; index.html holds the ids; style.css hides it until opened;
//  lib/geo-ext.js owns route 3; lib/installer-tasks.js owns the marker, the
//  boot task and the teardown; lib/browsers.js owns the table route 3 walks.
const CHAIN = ['main.js', 'renderer.js', 'index.html', 'style.css',
               'lib/geo-ext.js', 'lib/installer-tasks.js', 'lib/browsers.js',
               //  The delivery half. Regression 2 was a stale artifact wearing
               //  a policy bug's clothes: the routes on the machine named a port
               //  the shipped code no longer served. These two are now the
               //  difference between a browser being handed the CRX and asking
               //  a dead port, so a stale copy of either is the whole failure.
               'lib/ext-deliver.js', 'lib/ext-host.js'];
let listing = [];
try { listing = asar.listPackage(ASAR); } catch (e) { console.log('   ERROR: ' + e.message); }
ok(listing.length > 20, 'the asar can be read at all', String(listing.length) + ' entries');
for (const f of CHAIN) {
    let packed = null;
    try { packed = asar.extractFile(ASAR, f.split('/').join(path.sep)); } catch (e) {}
    const want = src(f);
    ok(packed !== null, `${f} is inside app.asar`);
    ok(packed !== null && sha(packed) === sha(want),
       `  and it is the file the tests ran against`,
       packed === null ? 'missing' : sha(packed) + ' vs ' + sha(want));
}

console.log('── the extension ships where the packaged app looks for it ──');
//  main.js: sourceDir = app.isPackaged ? resourcesPath\Extension : __dirname.
//  Both halves of that have to be true of the build, not just of the source.
ok(/process\.resourcesPath, 'Extension'/.test(String(src('main.js'))),
   "main.js resolves the extension to resourcesPath when packaged");
ok(!listing.some(e => /^[\\/]Extension/.test(e)),
   'and it is NOT in the asar, which is why that branch exists',
   listing.filter(e => /Extension/i.test(e)).slice(0, 3).join(' '));

const EXT = fs.readdirSync(path.join(ROOT, 'Extension')).filter(n => n !== 'flags');
ok(EXT.length >= 8, 'the source extension has its files', EXT.join(','));
for (const n of EXT) {
    const shipped = path.join(RES, 'Extension', n);
    ok(fs.existsSync(shipped), `resources\\Extension\\${n} shipped`);
    ok(fs.existsSync(shipped) &&
       sha(fs.readFileSync(shipped)) === sha(src('Extension/' + n)),
       `  identical to source`,
       fs.existsSync(shipped) ? sha(fs.readFileSync(shipped)) : 'missing');
}
//  welcome.html/welcome.js are new, and a new extraResource is the case the
//  allow-list silently drops.
for (const n of ['welcome.html', 'welcome.js']) {
    ok(fs.existsSync(path.join(RES, 'Extension', n)),
       `the tab Edge opens after install is packed (${n})`);
}
//  The flags are one per country the engine can offer, so the number is not a
//  round one and hard-coding a floor would only encode today's server list.
//  Counted against the source instead: a filter that dropped some of them is
//  the failure, and one missing flag is a country the popup draws blank.
const flagsSrc = fs.readdirSync(path.join(ROOT, 'Extension', 'flags'));
const flagsDir = path.join(RES, 'Extension', 'flags');
const flagsOut = fs.existsSync(flagsDir) ? fs.readdirSync(flagsDir) : [];
ok(flagsOut.length === flagsSrc.length && flagsSrc.length > 50,
   'and every flag image the popup draws came with it, all of them',
   flagsOut.length + ' of ' + flagsSrc.length);
ok(flagsSrc.every(n => flagsOut.includes(n)), 'by name, so none was renamed on the way',
   flagsSrc.filter(n => !flagsOut.includes(n)).slice(0, 5).join(','));

const mf = JSON.parse(fs.readFileSync(path.join(RES, 'Extension', 'manifest.json'), 'utf8'));
ok(mf.manifest_version === 3, 'the packed manifest is MV3', String(mf.manifest_version));
ok(Array.isArray(mf.content_scripts) && mf.content_scripts.some(c => c.run_at === 'document_start'),
   'with the document_start content script route 3 relies on');
ok(!!(mf.background && mf.background.service_worker), 'and its service worker');

console.log('── the two executables the installer runs are in resources ──');
//  vc_redist is where the honest restart evidence comes from: installer.nsh
//  reads its exit code and only 3010/1641 raise the flag.
const vc = path.join(RES, 'vc_redist.x64.exe');
ok(fs.existsSync(vc) && fs.statSync(vc).size > 10e6,
   'vc_redist.x64.exe -- the 3010/1641 exit codes are read from this',
   fs.existsSync(vc) ? (fs.statSync(vc).size / 1e6).toFixed(1) + ' MB' : 'missing');
ok(fs.existsSync(path.join(RES, 'elevate.exe')), 'elevate.exe');
ok(fs.existsSync(path.join(RES, 'app.asar.unpacked', 'Tor', 'tor', 'tor.exe')),
   'and the engine is unpacked, because an exe cannot run from inside an asar');

console.log('── the build config still wires the installer script ──');
const b = require(path.join(ROOT, 'package.json')).build;
ok(b.nsis && b.nsis.include === 'installer.nsh',
   'installer.nsh is compiled in as nsis.include', String(b.nsis && b.nsis.include));
ok(b.nsis.perMachine === true && b.nsis.oneClick === false,
   'per-machine and not one-click -- HKLM and a real uninstall page');
ok(b.win && b.win.requestedExecutionLevel === 'requireAdministrator',
   'the app itself asks for elevation, or route 3 cannot write HKLM',
   String(b.win && b.win.requestedExecutionLevel));
ok((b.extraResources || []).some(r => r.to === 'Extension'),
   'the extension is an extraResource, not an asar entry');
ok(b.asarUnpack.includes('Tor/**/*'), 'and only Tor is unpacked');

console.log('── this artifact is newer than everything in the chain ──');
//  The one honest statement available about the compiled NSIS script: it went
//  in after the last edit to it. Nothing in a compressed installer can be
//  grepped -- see the header.
const setupAt = mtime(SETUP);
for (const f of CHAIN.concat(['installer.nsh', 'package.json'])) {
    const t = mtime(path.join(ROOT, f));
    ok(t > 0 && setupAt >= t, `built after ${f}`,
       new Date(t).toISOString() + ' vs setup ' + new Date(setupAt).toISOString());
}
for (const s of ['fp-uninstall-sweep', '--fp-reboot-pending', 'restart-pending.json']) {
    const buf = fs.readFileSync(SETUP);
    ok(!buf.includes(s),
       `"${s}" is absent from the .exe, as a compressed script must be -- ` +
       'this is recorded so nobody later reads a grep of 0 as a missing feature');
}

console.log('── and the build left nothing of the workshop in the app ──');
for (const junk of ['.build', 'release', 'Extension.crx']) {
    ok(!listing.some(e => e.split(path.sep).includes(junk)),
       `no ${junk} in the asar`);
}
ok(!listing.some(e => /\.log$/i.test(e)), 'and no log files');
//  node_modules IS packed, and has to be -- `ws` is required at runtime by the
//  control-port client. What must not be there is anything from devDependencies,
//  which is the difference between a 6 MB asar and a 300 MB one.
const mods = new Set();
for (const e of listing) {
    const p = e.split(path.sep).filter(Boolean);
    const i = p.indexOf('node_modules');
    if (i >= 0 && p[i + 1]) mods.add(p[i + 1]);
}
const deps = Object.keys(require(path.join(ROOT, 'package.json')).dependencies || {});
ok([...mods].every(m => deps.includes(m)),
   'the only modules packed are production dependencies', [...mods].join(','));
ok(deps.every(d => mods.has(d)), 'and every one of them is packed',
   deps.filter(d => !mods.has(d)).join(','));

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
