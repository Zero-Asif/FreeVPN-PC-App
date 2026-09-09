'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/probe-uiblock-startup.js -- why the window takes so long to appear.
//
//  The three in-session freezes were counted and moved (probe-uiblock-geo,
//  -ext, -restore). The FOURTH complaint has never been measured at all:
//  "app installation ses houyar por start/open hoite onek time nicche".
//
//  probe-startup.js measures a BROWSER's startup, not this app's, so nothing
//  had ever attributed the gap between double-click and a painted window.
//
//  The gap is not Chromium: main.js already records app.whenReady() firing
//  42.5 s after launch on this machine once. What this probe measures is the
//  part the app owns -- the work runAdminApp() does around createWindow():
//
//      secureStateDir()            icacls over the state tree
//      startupCleanup()            taskkill + a ~25-command .bat + certs
//      setupWritableTor()          bundle copy or a file-for-file verify
//      setupWholeMachineLayers()   Containment/Tunnel construction
//      firstRunCheck()             netsh rule read-back x3 + schtasks x2
//      setAppProxy('direct')
//
//  All six used to run BEFORE createWindow(), which is why a double-click
//  produced nothing at all for twenty-two seconds. Section 4 reads the current
//  order out of main.js rather than assuming either one.
//
//  METHOD. Two halves, and neither one executes a command that changes this
//  machine:
//
//    1. RATES: each program is timed with a genuinely read-only invocation of
//       itself (reg query, netsh show, sc query, schtasks /query, an empty
//       powershell, the app's own cert ENUMERATION, Get-NetAdapter). Every one
//       of these is a read. Nothing is added, deleted, reset or flushed.
//
//    2. COUNTS: for the lib/ modules, child_process.execSync, execFileSync and
//       spawnSync are all replaced with a recorder before they load, so the real
//       code path is walked and every command is counted instead of run.
//       secureStateDir() is measured through the `run` seam it already exposes,
//       because it is the one step still in front of the window and a
//       miscounted zero there would read as "already free". For the two bursts
//       that live inside main.js (startupCleanup's .bat body and firstRunCheck's
//       netsh calls) the commands are read out of the source, because they are
//       built inside a closure that needs an Electron app object.
//
//  WHERE the sequence runs relative to createWindow() is read out of main.js,
//  not assumed -- a probe that hard-coded "before" would go on reporting a
//  delay after the delay had been moved.
// ════════════════════════════════════════════════════════════════════

const cp   = require('child_process');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ms   = t0 => Number(process.hrtime.bigint() - t0) / 1e6;

const time = (label, cmd, reps = 3, timeout = 40000) => {
    let ok = 0;
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < reps; i++) {
        try {
            cp.execSync(cmd, { windowsHide: true, stdio: 'pipe', timeout });
            ok++;
        } catch (e) { /* a non-zero exit is still a measured process start */ }
    }
    const per = ms(t0) / reps;
    console.log(`  ${String(Math.round(per)).padStart(5)} ms  ${label}` +
                (ok === reps ? '' : `   (${reps - ok} of ${reps} exited non-zero)`));
    return per;
};

console.log(`\n══ 1. what one process start costs, measured -- ${new Date().toISOString()} ══`);
console.log('   (every command below is a READ. Nothing is changed.)');
const R = {};
R.reg      = time('reg query   (one registry read)',
                  'reg query "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion" /v CurrentBuild');
R.netsh    = time('netsh advfirewall show allprofiles',
                  'netsh advfirewall show allprofiles');
R.netshRule = time('netsh advfirewall firewall show rule (absent name)',
                  'netsh advfirewall firewall show rule name="FreeProxy Probe Does Not Exist"');
R.sc       = time('sc query lfsvc', 'sc query lfsvc');
R.schtasks = time('schtasks /query (absent name)',
                  'schtasks /query /tn "FreeProxy Probe Does Not Exist"');
R.ps       = time('powershell -NoProfile "$null"',
                  'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$null"', 2);
R.icacls   = time('icacls (one object, read)',
                  `icacls "${process.env.SystemRoot || 'C:\\Windows'}"`);
R.taskkill = time('taskkill /IM (filter only, nothing killed)',
                  'taskkill /IM fp-probe-no-such-image.exe', 2);
R.ipconfig = time('ipconfig (print, not /flushdns)', 'ipconfig');
R.certutil = time('certutil -? (no store touched)', 'certutil -?', 2);

//  The two heavy PowerShell bodies startupCleanup() actually runs, timed by
//  their READ-ONLY halves. The app's version of the first one also calls
//  Enable-NetAdapterBinding per adapter; the second one deletes with certutil
//  after this enumeration. So both numbers here are floors.
console.log('\n══ 2. the two heavy PowerShell bodies, read-only halves ══');
R.netAdapter = time('Get-NetAdapter | Where Status -eq Up   (the enable loop\'s scan)',
    'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ' +
    '"Get-NetAdapter | Where-Object {$_.Status -eq \'Up\'} | Out-Null"', 2);
R.certScan = time('Get-ChildItem over four certificate stores   (the cert purge)',
    'powershell.exe -NoProfile -NonInteractive -Command ' +
    '"Get-ChildItem Cert:\\LocalMachine\\Root, Cert:\\LocalMachine\\My, ' +
    'Cert:\\CurrentUser\\Root, Cert:\\CurrentUser\\My -EA SilentlyContinue | ' +
    'Select-Object -ExpandProperty Thumbprint -Unique | Out-Null"', 2);

// ── 3. count, do not run ────────────────────────────────────────────
const calls = [];
const realExecSync     = cp.execSync;
const realExecFileSync = cp.execFileSync;
const realSpawnSync    = cp.spawnSync;
cp.execSync = function (cmd) { calls.push(String(cmd)); return ''; };

//  execSync is not the only synchronous spawn, and a recorder blind to the
//  others under-counts silently. lib/state-dir.js uses execFileSync, and the
//  first version of this probe therefore reported secureStateDir() as "0
//  spawns" -- a zero that reads as "already free" for the one step that is
//  still in front of createWindow().
const joined = (file, args) =>
    [String(file), ...(Array.isArray(args) ? args.map(String) : [])].join(' ');
cp.execFileSync = function (file, args) { calls.push(joined(file, args)); return ''; };
cp.spawnSync    = function (file, args) {
    calls.push(joined(file, args));
    return { status: 0, signal: null, pid: 0, stdout: '', stderr: '', output: [] };
};

const quiet = { info(){}, warn(){}, error(){}, debug(){}, success(){} };
const stateDir = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), 'fp-uiblock-startup-')));

//  Writes outside the throwaway dir are refused and counted, the same guard
//  probe-uiblock-restore.js uses.
//
//  DELETES are counted separately, with one exception: the ACL save files this
//  probe itself plants (see aclRun below) live in an fp-acl-* directory
//  lib/state-dir.js creates and removes itself. Node 22's recursive fs.rmSync
//  reaches the public fs.unlinkSync, so refusing those left fp-acl-*
//  directories behind in TEMP and then reported them as "writes outside the
//  state dir" -- an instrument creating the mess it went on to report.
const blocked = [], blockedDel = [];
const ownFiles   = new Set();
const realWrite  = fs.writeFileSync.bind(fs);
const realUnlink = fs.unlinkSync.bind(fs);
const ALLOW = path.resolve(stateDir).toLowerCase();
const key = p => {
    try { return path.resolve(String(p)).toLowerCase(); } catch (e) { return ''; }
};
const inside = p => { const k = key(p); return !!k && k.startsWith(ALLOW); };
fs.writeFileSync = (p, ...r) => inside(p) ? realWrite(p, ...r) : void blocked.push(String(p));
fs.unlinkSync    = (p, ...r) => (inside(p) || ownFiles.has(key(p)))
    ? realUnlink(p, ...r) : void blockedDel.push(String(p));

const rows = [];
function count(label, price, fn) {
    calls.length = 0;
    let note = '';
    const t0 = process.hrtime.bigint();
    try { fn(); } catch (e) { note = 'threw: ' + String(e.message || e).split('\n')[0].slice(0, 46); }
    const own = ms(t0);
    const est = calls.reduce((a, c) => a + price(c), 0);
    rows.push({ label, n: calls.length, own, est, note, cmds: calls.slice() });
    console.log(`  ${String(calls.length).padStart(3)} spawn(s)  ${String(Math.round(est)).padStart(6)} ms  ` +
                `${label}${note ? '   (' + note + ')' : ''}`);
}

//  One price list, used for both the recorded calls and the source-read ones.
const priceOf = c => {
    const s = String(c).trim().toLowerCase();
    if (/^powershell/.test(s)) {
        if (s.includes('get-netadapter')) return R.netAdapter;
        if (s.includes('cert:\\'))        return R.certScan;
        return R.ps;
    }
    if (/^certutil/.test(s))                return R.certutil;
    if (/^icacls/.test(s))                  return R.icacls;
    if (/^taskkill/.test(s))                return R.taskkill;
    if (/^sc\b/.test(s) || /^net\b/.test(s))return R.sc;
    if (/^schtasks/.test(s))                return R.schtasks;
    if (/^ipconfig/.test(s))                return R.ipconfig;
    if (/^netsh/.test(s)) {
        return s.includes('firewall show rule') ? R.netshRule : R.netsh;
    }
    if (/^reg\b/.test(s))                   return R.reg;
    if (/^for\b/.test(s))                   return R.reg * 2;   // reg query + a reg delete per line
    return R.reg;
};

console.log('\n══ 3. the startup sequence, step by step ══');
console.log('      spawns   priced   step');

// ── secureStateDir, measured through its own `run` seam ─────────────
//  Injected rather than recorded, because this is the ONE step that is still in
//  front of createWindow(): its count is the whole paint-path bill and must not
//  be an under-report. `run` is the seam the module already exposes for
//  .build/probe-state-dir.js. Nothing here touches a real ACL.
const { secureStateDir } = require(path.join(ROOT, 'lib', 'state-dir.js'));

//  The two DACLs this app actually meets, copied from lib/state-dir.js's own
//  measured header: a root that is already protected, and the inherited
//  ProgramData one that is not.
const SDDL_CLEAN   = 'D:PAI(A;OICI;0x1200a9;;;AU)(A;OICI;FA;;;BA)(A;OICI;FA;;;SY)';
const SDDL_EXPOSED = 'D:AI(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)(A;OICIIOID;GA;;;CO)' +
                     '(A;OICIID;0x1200a9;;;BU)(A;CIID;DCLCRPCR;;;BU)';

//  icacls, recorded and answered. `/save` is the only verb whose OUTPUT the
//  module reads, so it is the only one given a synthetic reply -- into the
//  fp-acl-* directory the module itself creates and itself removes, with the
//  real writer, because the guard above is about writes to the MACHINE.
const aclRun = firstSddl => {
    let nth = 0;
    return (file, args) => {
        calls.push(joined(file, args));
        const i = args.indexOf('/save');
        if (i >= 0 && args[i + 1]) {
            //  The BOM icacls writes, by code point: parseSaveFile() strips it
            //  the same way, and an invisible character in this source would be
            //  unreviewable in a diff and deleted by the first tool that
            //  normalised the file.
            realWrite(args[i + 1],
                      String.fromCharCode(0xFEFF) + 'freeproxy-vpn\r\n' +
                      (nth++ ? SDDL_CLEAN : firstSddl) + '\r\n',
                      'utf16le');
            //  Recorded so readTree's own rmSync can remove it again: this file
            //  is the probe's, not the machine's.
            ownFiles.add(key(args[i + 1]));
        }
        return '';
    };
};

count('secureStateDir()  -- already-locked tree, the every-launch case', priceOf,
      () => secureStateDir(stateDir, { log: quiet, run: aclRun(SDDL_CLEAN) }));

//  The exposed tree costs four more: reset /T, grant, setowner /T and the
//  recursive read-back. Priced separately rather than folded in, so the
//  every-launch number stays the every-launch number.
calls.length = 0;
const worstRes   = secureStateDir(stateDir, { log: quiet, run: aclRun(SDDL_EXPOSED) });
const worstCalls = calls.slice();
const worstEst   = worstCalls.reduce((a, c) => a + priceOf(c), 0);
console.log(`  ${String(worstCalls.length).padStart(3)} spawn(s)  ` +
            `${String(Math.round(worstEst)).padStart(6)} ms  ` +
            'secureStateDir()  -- exposed tree: reset + grant + setowner + read-back' +
            (worstRes.ok ? '' : '   (read-back not ok under the stub -- count is a floor)'));

const { GeoSpoof } = require(path.join(ROOT, 'lib', 'geo-spoof.js'));
const geo = new GeoSpoof({ log: quiet, stateDir });
count('  startupCleanup: geo.restoreLeftovers()', priceOf,
      () => geo.restoreLeftovers());
count('  startupCleanup: geo.clearBlockingPolicy()', priceOf,
      () => geo.clearBlockingPolicy());

const installerTasks = require(path.join(ROOT, 'lib', 'installer-tasks.js'));
count('  startupCleanup: deliverTaskRegistered()', priceOf,
      () => installerTasks.deliverTaskRegistered());

const { GeoExt } = require(path.join(ROOT, 'lib', 'geo-ext.js'));
const ext = new GeoExt({ log: quiet, stateDir,
                         sourceDir: path.join(ROOT, 'Extension'),
                         baseDir: path.join(stateDir, 'ext') });
count('  startupCleanup: geoExt().restore()  -- only when no delivery task', priceOf,
      () => ext.restore());

count('  firstRunCheck: bootTaskRegistered() + deliverTaskRegistered()', priceOf,
      () => { installerTasks.bootTaskRegistered(); installerTasks.deliverTaskRegistered(); });

// ── 4. the two bursts that live inside main.js ──────────────────────
//  Built inside runAdminApp()'s closure against an Electron `app`, so they are
//  read out of the source instead of called. The .bat is one execSync from the
//  main thread's point of view, but cmd.exe runs every line in it and the
//  thread is blocked for the sum.
const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');

const batBody = (() => {
    const at = mainSrc.indexOf("const bat = getScriptPath('fp_startup_clean.bat')");
    if (at < 0) return [];
    const end = mainSrc.indexOf("].join('\\r\\n')", at);
    if (end < 0) return [];
    const body = mainSrc.slice(at, end);
    const out = [];
    for (const line of body.split('\n')) {
        const t = line.trim();
        if (!t.startsWith('`')) continue;
        const m = t.match(/^`([^`]*)`/);
        if (!m) continue;
        const c = m[1].trim();
        if (!c || c === '@echo off') continue;
        out.push(c);
    }
    //  ...dnsLockRemove() is spread in from lib/dns-lock.js, which is a real
    //  module and can be asked rather than guessed at.
    if (/\.\.\.dnsLockRemove\(\)/.test(body)) {
        try {
            const dl = require(path.join(ROOT, 'lib', 'dns-lock.js'));
            const extra = (dl.dnsLockRemove ? dl.dnsLockRemove() : []) || [];
            for (const c of extra) out.push(String(c).trim());
        } catch (e) { out.push('netsh advfirewall firewall delete rule (dnsLockRemove)'); }
    }
    return out;
})();

const batEst = batBody.reduce((a, c) => a + priceOf(c), 0);
console.log(`\n  ${String(batBody.length).padStart(3)} command(s) ${String(Math.round(batEst)).padStart(6)} ms  ` +
            '  startupCleanup: fp_startup_clean.bat, run with execSync');
if (!batBody.length) {
    console.log('      (the .bat body could not be read out of main.js -- the ' +
                'anchor moved. Fix the anchor rather than trusting this total.)');
}

//  firstRunCheck's fwFix() runs `show rule` for each of three rules, and on a
//  mismatch a delete and an add as well. Three shows is the floor and the
//  common case; the repair path is priced separately so both are visible.
const fwCalls = (mainSrc.match(/fwFix\('/g) || []).length;
const fwFloor = fwCalls * R.netshRule;
const fwRepair = fwCalls * (R.netshRule + R.netsh * 2);
console.log(`  ${String(fwCalls).padStart(3)} command(s) ${String(Math.round(fwFloor)).padStart(6)} ms  ` +
            `  firstRunCheck: netsh "show rule" x${fwCalls} (floor -- a rule that ` +
            `needs rebuilding costs ${Math.round(fwRepair)} ms)`);

//  setupWritableTor's verify path is file I/O, not spawns: hash every file in
//  the shipped Tor bundle against the copy in the state dir. Measured directly,
//  because it is a real blocking cost on the starts where acl.wasExposed.
let bundleMs = 0, bundleFiles = 0;
try {
    const src = path.join(ROOT, 'Tor');
    const walk = d => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) walk(p);
            else { bundleFiles++; require('crypto').createHash('sha256')
                       .update(fs.readFileSync(p)).digest('hex'); }
        }
    };
    const t0 = process.hrtime.bigint();
    if (fs.existsSync(src)) walk(src);
    bundleMs = ms(t0);
} catch (e) {}
console.log(`    ${String(bundleFiles).padStart(3)} file(s)  ${String(Math.round(bundleMs)).padStart(6)} ms  ` +
            '  setupWritableTor: hash the Tor bundle (only when the tree was exposed)');

// ── 5. the total, attributed to whichever side of the window it is on ──
const libEst = rows.reduce((a, r) => a + r.est, 0);
const libSpawns = rows.reduce((a, r) => a + r.n, 0);
const total = libEst + batEst + fwFloor;
const spawns = libSpawns + batBody.length + fwCalls;

console.log('\n══ 4. where this runs, read out of main.js ══');
//  The question is whether createWindow() is reached BEFORE the heavy work or
//  after it. Both orders are legal JS; only one of them paints a window in the
//  first second. Located by index rather than by line number, so a comment added
//  above either one does not change the answer.
//
//  The anchor is the HEAVY work, not the whole function: secureStateDir() is in
//  front of the window on purpose and by design (everything downstream executes
//  out of that directory with an administrator token), so anchoring on it would
//  report a delay that has been moved. Once the steps live inside
//  startupSequence() that call is the boundary; on the old straight-line layout
//  the first heavy step was startupCleanup() itself.
const winAnchor = mainSrc.indexOf('createWindow();');
const seq = (() => {
    for (const s of ['const startupReady = startupSequence();',
                     'startupSequence();',
                     'startupCleanup();']) {
        const i = mainSrc.indexOf(s);
        if (i > 0) return { i, what: s };
    }
    return { i: -1, what: '(no anchor found -- fix this before trusting the verdict)' };
})();
const aclAnchor = mainSrc.indexOf('secureStateDir(app.getPath(');
const windowFirst = winAnchor > 0 && seq.i > 0 && winAnchor < seq.i;
console.log(`  secureStateDir() at index ${aclAnchor}`);
console.log(`  createWindow()   at index ${winAnchor}`);
console.log(`  ${seq.what}  at index ${seq.i}`);
console.log('  => ' + (windowFirst
    ? 'the window is created BEFORE the heavy work, so it does not delay the paint'
    : 'the window is created AFTER all of it -- nothing is on screen until it ends'));

if (/const startupReady = startupSequence\(\)/.test(mainSrc)) {
    console.log('  main.js holds the sequence as a promise, so a connect that arrives');
    console.log('  during it can wait on the same object rather than run without tor.exe.');
    console.log('  awaitStartup() reached from establishConnection(): ' +
                (/await awaitStartup\(/.test(mainSrc) ? 'yes' : 'NO -- the race is open'));
}

console.log('\n══ 5. the first-launch bill ══');
console.log(`  ${spawns} process start(s) in the startup sequence`);
console.log(`  priced at the rates in section 1:            ~${Math.round(total)} ms`);
console.log(`  plus the Tor-bundle verify when it runs:     ~${Math.round(bundleMs)} ms`);
console.log("  plus Chromium's own init before whenReady:   42500 ms, measured once on " +
            'this machine');
console.log(`  ------------------------------------------------------------`);
if (windowFirst) {
    const aclRow  = rows.find(r => /secureStateDir/.test(r.label));
    const onPaint = aclRow ? aclRow.est : 0;
    console.log(`  ON THE PAINT PATH:                          ~${Math.round(onPaint)} ms` +
                `  (secureStateDir, ${aclRow ? aclRow.n : 0} spawn(s); ` +
                `~${Math.round(worstEst)} ms on an exposed tree)`);
    console.log('  Every other step above still runs -- after the window exists, so');
    console.log('  the user sees the app while the machine work finishes.');
} else {
    console.log(`  ON THE PAINT PATH:                          ~${Math.round(total + bundleMs)} ms`);
    console.log('  This is the "app open hoite onek time nicche": a window that does');
    console.log('  not exist yet cannot paint, cannot show a spinner and cannot be');
    console.log('  told the app is busy.');
}

console.log('\n══ 6. the biggest single items ══');
const items = [
    ...rows.map(r => ({ what: r.label.trim(), ms: r.est })),
    { what: 'fp_startup_clean.bat (' + batBody.length + ' commands, one execSync)', ms: batEst },
    { what: `firstRunCheck netsh show rule x${fwCalls}`, ms: fwFloor },
    { what: `Tor bundle hash (${bundleFiles} files, exposed-tree starts only)`, ms: bundleMs },
    { what: `secureStateDir on an exposed tree (${worstCalls.length} icacls)`, ms: worstEst },
];
for (const it of items.sort((a, b) => b.ms - a.ms).slice(0, 8)) {
    console.log(`  ${String(Math.round(it.ms)).padStart(6)} ms  ${it.what}`);
}

cp.execSync     = realExecSync;
cp.execFileSync = realExecFileSync;
cp.spawnSync    = realSpawnSync;
fs.writeFileSync = realWrite;
fs.unlinkSync = realUnlink;
try { fs.rmSync(stateDir, { recursive: true, force: true }); } catch (e) {}
console.log(`\n  Nothing was executed in sections 3-4: execSync, execFileSync and`);
console.log(`  spawnSync were all replaced before the modules loaded, and icacls was`);
console.log(`  answered through secureStateDir's own \`run\` seam.`);
console.log(`  ${blocked.length} write(s) outside the throwaway state dir were refused` +
            (blocked.length ? ': ' + [...new Set(blocked)].slice(0, 3).join(', ') : '.'));
console.log(`  ${blockedDel.length} delete(s) outside it were refused` +
            (blockedDel.length ? ': ' + [...new Set(blockedDel)].slice(0, 3).join(', ') : '.'));
//  The module's own fp-acl-* directories, if a refusal left one standing.
try {
    const tmp = os.tmpdir();
    let swept = 0;
    for (const n of fs.readdirSync(tmp)) {
        if (!/^fp-acl-/.test(n)) continue;
        try { fs.rmSync(path.join(tmp, n), { recursive: true, force: true }); swept++; }
        catch (e) {}
    }
    if (swept) console.log(`  swept ${swept} leftover fp-acl-* dir(s) from TEMP`);
} catch (e) {}
