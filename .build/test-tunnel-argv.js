'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/test-tunnel-argv.js  --  the argv lib/tunnel.js hands tun2socks must
//                                  be argv tun2socks actually accepts.
//
//  tun2socks parses with spf13/pflag, where ONE dash means a shorthand cluster.
//  `-device tun://FreeProxyTun` is therefore read as `-d` with the value
//  "evice", and `-proxy socks5://127.0.0.1:9050` as `-p` with the value "roxy".
//  Neither is an error: the adapter gets created under the name "evice", the
//  proxy address becomes the literal string "roxy", _findAdapter() then cannot
//  find the interface it just made, and the app reports "the Wintun adapter
//  never appeared" while every dial fails with "address roxy: missing port".
//  A whole release shipped that way because no suite here read the binary's own
//  flag list. This one does, so the accepted names come from the binary rather
//  than from a literal in a test.
// ════════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC  = path.join(ROOT, 'lib', 'tunnel.js');
const EXE  = path.join(ROOT, 'Tun', 'tun2socks.exe');

let pass = 0, fail = 0, na = 0;
const ok = (cond, name, extra) => {
    if (cond) { pass++; console.log('  ok   ' + name); }
    else { fail++; console.log('  FAIL ' + name + (extra ? '  -- ' + extra : '')); }
};
const skip = (name, why) => { na++; console.log('  n/a  ' + name + '  -- ' + why); };

console.log('── the argv in lib/tunnel.js ──');
const src = fs.readFileSync(SRC, 'utf8');
const block = /const args = \[([\s\S]*?)\];/.exec(src);
ok(!!block, 'the tun2socks argv is where this suite can read it');

const flags = block ? [...block[1].matchAll(/'(-{1,2}[a-zA-Z-]+)'/g)].map(m => m[1]) : [];
ok(flags.includes('--device'),   'it passes --device');
ok(flags.includes('--proxy'),    'it passes --proxy');
ok(flags.includes('--loglevel'), 'it passes --loglevel');

//  The regression itself: a long name behind one dash.
const oneDash = flags.filter(f => !f.startsWith('--') && f.length > 2);
ok(oneDash.length === 0,
   'no long flag is written with a single dash', oneDash.join(' '));

//  Values, not just names -- `-p roxy` was a value bug as much as a flag bug.
ok(/'--device',\s*`tun:\/\/\$\{TUN_NAME\}`/.test(block ? block[1] : ''),
   'the device value is tun://<TUN_NAME>');
ok(/'--proxy',\s*`socks5:\/\/127\.0\.0\.1:\$\{socksPort\}`/.test(block ? block[1] : ''),
   'the proxy value is socks5://127.0.0.1:<socksPort>');

console.log('── against the binary this build ships ──');
if (!fs.existsSync(EXE)) {
    skip('flag names read out of tun2socks --help', 'Tun/tun2socks.exe is not in this tree');
    skip('the binary rejects single-dash long flags', 'same');
} else {
    //  --help exits 0 and writes to stderr, so both streams are read.
    const h = spawnSync(EXE, ['--help'], { encoding: 'utf8', windowsHide: true });
    const help = String((h && h.stdout) || '') + String((h && h.stderr) || '');
    const longs = new Set(), shorts = new Set();
    for (const m of help.matchAll(/^\s*(?:-([a-zA-Z]), )?--([a-z-]+)/gm)) {
        if (m[1]) shorts.add(m[1]);
        longs.add(m[2]);
    }
    ok(longs.size > 0, 'tun2socks --help lists its flags', 'parsed ' + longs.size);
    for (const f of flags) {
        const good = f.startsWith('--') ? longs.has(f.slice(2))
                                       : (f.length === 2 && shorts.has(f[1]));
        ok(good, `${f} is a flag tun2socks accepts`);
    }

    //  Prove the cluster semantics in the shipped binary rather than assuming
    //  them: one dash must be refused where two are taken.
    const one = spawnSync(EXE, ['-version'], { encoding: 'utf8', windowsHide: true });
    const two = spawnSync(EXE, ['--version'], { encoding: 'utf8', windowsHide: true });
    ok(one.status !== 0, 'the binary rejects -version (one dash is a cluster)',
       'exit ' + one.status);
    const vout = String((two && two.stdout) || '') + String((two && two.stderr) || '');
    ok(two.status === 0 && /tun2socks-\d/.test(vout),
       'the binary accepts --version', vout.trim().split(/\r?\n/)[0]);
}

console.log(`\n${pass}/${pass + fail} checks passed` +
            (na ? `, ${na} not applicable` : ''));
process.exit(fail ? 1 : 0);
