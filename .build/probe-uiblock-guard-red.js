'use strict';
//  Red-proof for .build/test-uiblock-guard.js: inject each regression the suite
//  claims to catch into a COPY of main.js and confirm the suite goes red. A
//  check that cannot fail is decoration, and this file is what says it can.
//
//  Anchors are run through nl(): main.js is CRLF, so a multi-line anchor written
//  with \n matches nothing and the case silently reports "not injected".
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
//  A temp dir, not a hardcoded G:\tmp: this file is committed, and a clone on a
//  machine with no G: drive would fail before injecting anything.
const OUT = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'fp-uiblock-red-')));
const nl = s => s.replace(/\n/g, '\r\n');
const swap = (from, to) => s => s.replace(nl(from), nl(to));

const CASES = [
    ['a new synchronous spawn on the switch path',
     swap("        const off = await runOffThread('geo-apply',",
          "        execSync('reg query HKLM /ve');\n" +
          "        const off = await runOffThread('geo-apply',")],
    ['applyAll called directly, bypassing the child',
     swap("        const off = await runOffThread('geo-gecko',",
          '        geoEngine().applyAll(coord, proxy);\n' +
          "        const off = await runOffThread('geo-gecko',")],
    ['killTor blocking on a path with a window on screen',
     swap('await killTor({ blocking: false });', 'await killTor();')],
    ['the off-thread timeout removed',
     swap('        const timer = setTimeout(\n' +
          "            () => finish({ ok: false, error: `${job} timed out after ${timeoutMs} ms` }),\n" +
          '            timeoutMs);',
          '        const timer = null;')],
    ['ELECTRON_RUN_AS_NODE dropped from the fork',
     swap("                env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },",
          '                env: { ...process.env },')],
    ['the in-process fallback deleted',
     swap("        Logger.debug('Location shield: could not run off-thread (' +\n" +
          "                     (off.error || 'no reason reported') + ') -- applying in-process');\n" +
          '        geoEngine().applyAll(coord, proxy);',
          '        return;')],
    ['the restore chain replaced by a bare call',
     swap('        : runGeoRestore();', '        : Promise.resolve(geoEngine().restoreAll());')],
];

let proved = 0;
const unproved = [];
CASES.forEach(([name, mutate], n) => {
    const red = mutate(SRC);
    if (red === SRC) { unproved.push(name + '  (the anchor did not match -- not injected)'); return; }
    const f = path.join(OUT, 'main-' + n + '.js');
    fs.writeFileSync(f, red, 'utf8');
    let code = 0, out = '';
    try {
        out = execFileSync(process.execPath, [path.join(__dirname, 'test-uiblock-guard.js')],
                           { encoding: 'utf8', stdio: 'pipe', env: { ...process.env, FP_MAIN: f } });
    } catch (e) { code = e.status; out = (e.stdout || '') + (e.stderr || ''); }
    const fails = (out.match(/^ {2}FAIL .+$/gm) || []);
    if (code !== 0 && fails.length) {
        proved++;
        console.log('  RED  ' + name);
        fails.slice(0, 2).forEach(l => console.log('         ' + l.trim().slice(0, 104)));
    } else {
        unproved.push(name + '  (exit ' + code + ', ' + fails.length + ' FAIL lines)');
    }
});
console.log('');
if (unproved.length) {
    console.log(proved + '/' + CASES.length + ' regressions caught. NOT caught:');
    unproved.forEach(u => console.log('  -- ' + u));
    console.log('\nthe mutated copies are kept for reading: ' + OUT);
    process.exit(1);
}
try { fs.rmSync(OUT, { recursive: true, force: true }); } catch (e) {}
console.log(proved + '/' + CASES.length + ' injected regressions turned the suite red.');
process.exit(0);
