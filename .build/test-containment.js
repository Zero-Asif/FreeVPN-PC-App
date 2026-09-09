'use strict';
// ════════════════════════════════════════════════════════════════════
//  test-containment.js -- the layer that can take a PC off the internet.
//
//  lib/containment.js flips the Windows firewall to blockinbound,blockoutbound
//  on all three profiles. Every other suite in .build/ covers something that
//  fails by under-protecting; this one covers the only module whose failure
//  mode is a machine with no internet and no app left to fix it. It had no
//  suite at all.
//
//  Nothing is executed and no firewall is touched: child_process.execFile is
//  replaced by a fake netsh BEFORE the module is required (it destructures
//  execFile at load time), and cp.spawn is replaced for disableNoWait(). The
//  recovery scripts are written into a throwaway temp dir -- with a space in
//  its name, because every program= argument in here is a path.
// ════════════════════════════════════════════════════════════════════

const cp   = require('child_process');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok = (cond, what, detail = '') => {
    console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${what}${detail ? ' -- ' + detail : ''}`);
    cond ? pass++ : fail++;
};

// ── the fake netsh ──────────────────────────────────────────────────
//  A world that answers the way Windows does, so enable() really walks its
//  read-back path instead of being handed a canned "ok".
const calls = [];
const world = {
    policy: 'BlockInbound,AllowOutbound',
    states: ['ON', 'ON', 'ON'],
    profiles: ['Domain', 'Private', 'Public'],
    rules: new Map(),          //  name -> the args it was added with
    gpo: false,                //  netsh says Ok. and the policy does not move
    failShow: false,
    failSet: false,
    failAdd: null,             //  a rule name whose add is refused
    showProgramOverride: null, //  what a read-back claims instead of the truth
    sawFlipWith: null,         //  did the way out exist when the door locked?
};

const showText = () => world.profiles.map((p, i) => [
    `${p} Profile Settings:`,
    '----------------------------------------------------------------------',
    `State                                 ${world.states[i]}`,
    `Firewall Policy                       ${world.policy}`,
    '',
].join('\r\n')).join('\r\n');

let RECOVERY_PATH = '';   //  set once the instance exists; see sawFlipWith

function netshFake(args) {
    const a = args.map(String);
    const j = a.join(' ');
    if (j.startsWith('advfirewall show allprofiles')) {
        return world.failShow ? { code: 1, out: 'The following command was not found.' }
                              : { code: 0, out: showText() };
    }
    if (j.startsWith('advfirewall set allprofiles firewallpolicy')) {
        const want = a[a.length - 1];
        if (/blockoutbound/i.test(want)) {
            world.sawFlipWith = {
                bat: RECOVERY_PATH ? fs.existsSync(RECOVERY_PATH) : null,
                rulesAtFlip: [...world.rules.keys()],
            };
        }
        if (world.failSet) return { code: 1, out: 'The parameter is incorrect.' };
        if (!world.gpo) {
            world.policy = /blockoutbound/i.test(want) ? 'BlockInbound,BlockOutbound'
                                                       : 'BlockInbound,AllowOutbound';
        }
        return { code: 0, out: 'Ok.' };
    }
    if (j.startsWith('advfirewall firewall delete rule')) {
        const name = (a.find(x => x.startsWith('name=')) || '').slice(5);
        const had = world.rules.delete(name);
        return had ? { code: 0, out: 'Deleted 1 rule(s).' }
                   : { code: 1, out: 'No rules match the specified criteria.' };
    }
    if (j.startsWith('advfirewall firewall add rule')) {
        const name = (a.find(x => x.startsWith('name=')) || '').slice(5);
        if (world.failAdd && world.failAdd === name) {
            return { code: 1, out: 'The parameter is incorrect.' };
        }
        world.rules.set(name, a.slice());
        return { code: 0, out: 'Ok.' };
    }
    if (j.startsWith('advfirewall firewall show rule')) {
        const name = (a.find(x => x.startsWith('name=')) || '').slice(5);
        const rule = world.rules.get(name);
        if (!rule) return { code: 1, out: 'No rules match the specified criteria.' };
        const prog = world.showProgramOverride ||
                     (rule.find(x => x.startsWith('program=')) || 'program=Any').slice(8);
        return { code: 0, out: [
            `Rule Name:                            ${name}`,
            '----------------------------------------------------------------------',
            'Enabled:                              Yes',
            'Direction:                            Out',
            'Profiles:                             Domain,Private,Public',
            `Program:                              ${prog}`,
            'Action:                               Allow',
        ].join('\r\n') };
    }
    return { code: 0, out: '' };
}

const realExecFile = cp.execFile;
cp.execFile = function (exe, args, opts, cb) {
    calls.push({ exe: String(exe), args: (args || []).map(String), opts });
    const r = /netsh/i.test(String(exe)) ? netshFake(args || []) : { code: 0, out: '' };
    setImmediate(() => {
        if (r.code) {
            const err = new Error(`Command failed: ${exe}\n${r.out}`);
            err.code = r.code;
            cb(err, '', r.out);
        } else cb(null, r.out, '');
    });
    return { pid: 0 };
};
const spawned = [];
const realSpawn = cp.spawn;
cp.spawn = function (exe, args, opts) {
    spawned.push({ exe: String(exe), args: (args || []).map(String), opts });
    let unrefd = false;
    return { unref() { unrefd = true; spawned[spawned.length - 1].unrefd = true; } };
};

const { ALLOW_RULES, RULE_NAMES, RECOVERY_LNK, Containment } =
    require(path.join(ROOT, 'lib', 'containment.js'));
const { GeoSpoof, FW_RULE } = require(path.join(ROOT, 'lib', 'geo-spoof.js'));

const logs = [];
const Logger = {
    info:    m => logs.push(['info', String(m)]),
    warn:    m => logs.push(['warn', String(m)]),
    error:   m => logs.push(['error', String(m)]),
    debug:   m => logs.push(['debug', String(m)]),
    success: m => logs.push(['success', String(m)]),
};
const said = rx => logs.some(([, m]) => rx.test(m));

//  A space in the path on purpose: "C:\Program Files\...", "C:\Users\User pc\..."
//  are the real cases, and a shell string would break on both.
const TMP  = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'fp cont ')));
const bin  = n => { const p = path.join(TMP, n); fs.writeFileSync(p, 'MZ'); return p; };
const TOR  = bin('tor.exe');
const LYRE = bin('lyrebird.exe');
const T2S  = bin('tun2socks.exe');
const APP  = bin('FreeProxy VPN.exe');

function fresh(over = {}) {
    calls.length = 0; logs.length = 0; spawned.length = 0;
    Object.assign(world, {
        policy: 'BlockInbound,AllowOutbound', states: ['ON', 'ON', 'ON'],
        profiles: ['Domain', 'Private', 'Public'], rules: new Map(), gpo: false,
        failShow: false, failSet: false, failAdd: null, showProgramOverride: null,
        sawFlipWith: null,
    }, over);
    const stateDir = fs.mkdtempSync(path.join(TMP, 'state '));
    const c = new Containment({ Logger, stateDir, torExe: TOR, appExe: APP,
                                lyrebirdExe: LYRE, tun2socksExe: T2S });
    RECOVERY_PATH = c.recoveryBat;
    return c;
}

const netshArgs = () => calls.filter(c => /netsh/i.test(c.exe)).map(c => c.args.join(' '));

(async () => {

console.log(`\n══ 1. the way out, written before the door can lock -- ${new Date().toISOString()} ══`);
{
    const c = fresh();
    const r = c.writeRecovery();
    ok(r.ok && fs.existsSync(c.recoveryBat), 'restore-internet.bat is on disk',
       path.basename(c.recoveryBat));
    ok(r.gecko && fs.existsSync(c.recoveryGeckoPs1),
       'and restore-gecko-prefs.ps1 beside it, because Windows steps do not reach Gecko');
    const bat = fs.readFileSync(c.recoveryBat, 'utf8');
    ok(/\r\n/.test(bat) && !/[^\r]\n/.test(bat),
       'the .bat is CRLF throughout -- cmd.exe mis-parses a bare-LF batch file');
    ok(!/[^\x00-\x7F]/.test(bat), 'and ASCII only, so no console codepage can mangle it');

    //  The invariant that matters most: every rule name this app can ADD must
    //  appear in this file's delete list. Derived from the sources, not typed
    //  out here -- a list in a test is a fourth place to disagree.
    const missing = RULE_NAMES.filter(n => !bat.includes(`name="${n}"`));
    ok(missing.length === 0, 'it deletes every allow rule in RULE_NAMES',
       missing.length ? 'MISSING: ' + missing.join(', ') : RULE_NAMES.length + ' names');
    const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
    const added = new Set([
        ...[...mainSrc.matchAll(/add rule name="(FreeProxy [^"]+)"/g)].map(m => m[1]),
        ...[...mainSrc.matchAll(/(?:dnsUdp|dnsTcp|dot):\s*'(FreeProxy [^']+)'/g)].map(m => m[1]),
        GeoSpoof.FW_RULE || FW_RULE,
    ]);
    const notDeleted = [...added].filter(n => !bat.includes(`name="${n}"`));
    ok(added.size >= 5 && notDeleted.length === 0,
       'and every block rule main.js or geo-spoof.js can add -- a leftover DNS block ' +
       'with no Tor listening resolves nothing at all',
       notDeleted.length ? 'MISSING: ' + notDeleted.join(', ') : added.size + ' block name(s)');

    //  Order inside the .bat is load-bearing in two places.
    const iT2S = bat.indexOf('taskkill /F /IM tun2socks.exe');
    const iTor = bat.indexOf('taskkill /F /IM tor.exe');
    const iPol = bat.indexOf('firewallpolicy blockinbound,allowoutbound');
    const iDel = bat.indexOf(`delete rule name="${RULE_NAMES[0]}"`);
    ok(iT2S > 0 && iTor > iT2S,
       'tun2socks.exe is killed before tor.exe -- while it lives it still hands every ' +
       'TCP connection to a SOCKS port nothing answers');
    ok(iPol > 0 && iDel > iPol,
       'outbound is allowed again BEFORE the allow rules are deleted, never after');
    ok(/net session >nul 2>&1/.test(bat) && /Verb RunAs/.test(bat),
       'it self-elevates, because a user with no internet should not have to know to ' +
       'right-click');
    ok(/netsh winhttp reset proxy/.test(bat) && /ProxyEnable/.test(bat),
       'it clears both proxy stores -- WinINET for HKCU and WinHTTP for services');
    ok(/\/v NameServer \/f/.test(bat) && /set dnsserver "%%B" dhcp/.test(bat),
       'DNS goes back to automatic on every connected interface');
    ok(/DisabledComponents \/t REG_DWORD \/d 0/.test(bat),
       'and IPv6 is re-enabled rather than left off');
    ok(/if exist "%~dp0restore-gecko-prefs\.ps1"/.test(bat) &&
       /SKIPPED - restore-gecko-prefs\.ps1 is not next to this file/.test(bat),
       'the Gecko step SAYS SKIPPED when its script is absent instead of printing a ' +
       'step number and moving on');
    ok(/\npause/.test(bat), 'and it pauses, so the result is readable when double-clicked');
}

console.log('\n══ 2. the Gecko half, which no Windows step reaches ══');
{
    const c = fresh();
    c.writeRecovery();
    const ps1 = fs.readFileSync(c.recoveryGeckoPs1, 'utf8');
    ok(!/[^\x00-\x7F]/.test(ps1) && ps1.charCodeAt(0) !== 0xFEFF,
       'ASCII with no BOM -- PowerShell 5.1 reads a BOM-less file as ANSI, so one ' +
       'non-ASCII byte would arrive mojibaked');
    ok(/UTF8Encoding\(\$false\)/.test(ps1),
       'and it writes UTF-8 with no BOM back, because a BOM on line 1 of a prefs file ' +
       'is a parse error that costs the user every pref in it');
    //  The measured half-repair: the block's own text contains the words
    //  "end FreeProxy VPN" inside the sentence that tells a user what to delete,
    //  so a substring match stops four lines in and leaves network.proxy.type set.
    ok(/\$ENDRX = 'end FreeProxy VPN\[\^A-Za-z0-9\]\*\$'/.test(ps1) &&
       /\$line -match \$ENDRX/.test(ps1),
       'the end marker is matched by ANCHORED REGEX, not as a substring');
    const ours = (ps1.match(/^\$OURS = @\((.*)\)$/m) || [, ''])[1]
        .split(',').map(s => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
    const missPref = GeoSpoof.FF_ALL_PREFS.filter(p => !ours.includes(p));
    ok(ours.length === GeoSpoof.FF_ALL_PREFS.length && missPref.length === 0,
       'and $OURS is exactly GeoSpoof.FF_ALL_PREFS -- a pref spelled here and not ' +
       'there stays set on a machine this app has left',
       missPref.length ? 'MISSING: ' + missPref.join(', ') : ours.length + ' pref(s)');
    ok(/\$leafCount\[\$lf\] -eq 1/.test(ps1),
       'the profile-name fallback fires only when that name is unique -- a wrong pref ' +
       'restored into the wrong profile is worse than a missing one');
    ok(/^param\(/m.test(ps1) && /\$UsersRoot/.test(ps1) && /\$Journal/.test(ps1),
       'and it takes UsersRoot/Journal parameters, so the recovery script can be TESTED ' +
       'against a fake tree instead of only on the day it is needed');
    ok(/\nexit 0$/.test(ps1.trimEnd() + '\n' ) || /exit 0/.test(ps1),
       'it exits 0 even when it finds nothing, so the .bat does not report a failure');

    //  The Gecko half must never veto arming: a machine that gets the .bat and
    //  not the .ps1 can still be rescued from "no internet at all".
    const c2 = fresh();
    const realWrite = fs.writeFileSync;
    fs.writeFileSync = function (p, ...r) {
        if (String(p).endsWith('.ps1')) throw new Error('EACCES (blocked for the test)');
        return realWrite.call(fs, p, ...r);
    };
    let r2;
    try { r2 = c2.writeRecovery(); } finally { fs.writeFileSync = realWrite; }
    ok(r2.ok === true && r2.gecko === false && r2.geckoPath === null,
       'a .ps1 that cannot be written does NOT veto the recovery script',
       JSON.stringify({ ok: r2.ok, gecko: r2.gecko }));
    ok(said(/Firefox-family half of the recovery could not be written/),
       'and it is warned about rather than passed over in silence');
}

console.log('\n══ 3. what Windows actually has, parsed rather than remembered ══');
{
    const c = fresh({ policy: 'BlockInbound,BlockOutbound' });
    const s = await c.status();
    ok(s.ok && s.profiles.length === 3, 'three profiles come back', String(s.profiles.length));
    ok(s.outboundBlocked === true && s.firewallOn === true,
       'BlockOutbound on all three reads as blocked');

    const c2 = fresh({ profiles: ['Domain', 'Private'], states: ['ON', 'ON'],
                       policy: 'BlockInbound,BlockOutbound' });
    ok((await c2.status()).outboundBlocked === false,
       'two profiles is NOT "all three blocked" -- a missing profile must not read as ' +
       'covered');

    const c3 = fresh({ states: ['ON', 'OFF', 'ON'] });
    ok((await c3.status()).firewallOn === false, 'one profile OFF reads as firewall off');

    const c4 = fresh({ failShow: true });
    const s4 = await c4.status();
    ok(s4.ok === false && !!s4.reason && s4.profiles.length === 0,
       'and a netsh that fails is reported, not guessed at', s4.reason);
}

console.log('\n══ 4. the allow list, read back by PROGRAM PATH ══');
{
    const c = fresh();
    const r = await c.installAllowRules({ allowLan: true, tunLocalIp: '10.7.0.2' });
    ok(r.ok, 'the happy path writes them', (r.rules || []).length + ' rule(s)');
    const names = [...world.rules.keys()];
    for (const k of ['tor', 'lyrebird', 'app', 'tun2socks', 'loopback', 'dhcp', 'tun', 'lan']) {
        ok(names.includes(ALLOW_RULES[k]), `  ${k} -> ${ALLOW_RULES[k]}`);
    }
    ok(world.rules.get(ALLOW_RULES.tor).includes(`program=${TOR}`),
       'the tor rule names the RUNNING exe, spaces and all -- installer.nsh names the ' +
       'unpacked copy, and the process that runs is the ProgramData one');
    ok(world.rules.get(ALLOW_RULES.tun).includes('localip=10.7.0.2'),
       'the tunnel rule allows by LOCAL address -- a rule cannot name an adapter, and ' +
       'the local address is what a routed connection has');
    ok(world.rules.get(ALLOW_RULES.lan).includes('remoteip=LocalSubnet'),
       'and LAN reachability is a named opt-in, not a side effect');
    ok(world.rules.get(ALLOW_RULES.dhcp).join(' ').endsWith(
       [`name=${ALLOW_RULES.dhcp}`, 'dir=out', 'action=allow', 'enable=yes', 'profile=any',
        'protocol=UDP', 'localport=68', 'remoteport=67'].join(' ')),
       'DHCP is allowed, or the machine loses its own address at the next lease renewal',
       world.rules.get(ALLOW_RULES.dhcp).slice(5).join(' '));
    //  Every command argv-based: not one shell string anywhere in this module.
    const bad = calls.filter(c2 => !Array.isArray(c2.args) ||
                                   c2.args.some(a => /[&|><^]/.test(a)));
    ok(bad.length === 0 && calls.every(c2 => /\.exe$/i.test(c2.exe)),
       'every call is execFile with an argv array -- nothing in a path can be read as ' +
       'a separator', bad.length ? JSON.stringify(bad[0]) : calls.length + ' call(s)');
    //  Idempotent: main.js calls this again while already armed, to add the tun rule
    //  once the adapter has an address.
    const args = netshArgs();
    for (const n of r.rules) {
        const del = args.findIndex(a => a === `advfirewall firewall delete rule name=${n}`);
        const add = args.findIndex(a => a.startsWith(`advfirewall firewall add rule name=${n} `));
        ok(del >= 0 && add > del, `  deleted before added, so a second call is safe -- ${n}`);
    }
    ok(args.filter(a => a.startsWith('advfirewall firewall show rule')).length === 2,
       'and exactly the two rules that decide whether anything works are read back');
}
{
    const c = fresh();
    const noTun = await c.installAllowRules({});
    ok(noTun.ok && ![...world.rules.keys()].includes(ALLOW_RULES.tun) &&
       ![...world.rules.keys()].includes(ALLOW_RULES.lan),
       'with no tunnel address and no allowLan, neither optional rule is invented');

    const c2 = new Containment({ Logger, stateDir: fs.mkdtempSync(path.join(TMP, 'state ')),
                                 torExe: path.join(TMP, 'gone.exe'), appExe: APP });
    calls.length = 0; logs.length = 0;
    const r2 = await c2.installAllowRules({});
    ok(r2.ok === false && /tor\.exe not found/.test(r2.reason || ''),
       'a missing tor.exe refuses', r2.reason);
    ok(netshArgs().length === 0,
       'and it refuses BEFORE touching the firewall -- no rule is left behind by a ' +
       'refusal');

    const c3 = fresh({ showProgramOverride:
        'C:\\Program Files\\FreeProxy VPN\\resources\\app.asar.unpacked\\Tor\\tor\\tor.exe' });
    const r3 = await c3.installAllowRules({});
    ok(r3.ok === false && /read-back mismatch/.test(r3.reason || '') &&
       (r3.bad || []).some(b => b.expectedProgram === TOR),
       'a rule that reads back naming the INSTALLED path instead of the running one is ' +
       'a refusal -- that exact mismatch shipped once and left tor.exe with no rule at all',
       r3.reason);

    const c4 = fresh({ failAdd: ALLOW_RULES.dhcp });
    const r4 = await c4.installAllowRules({});
    ok(r4.ok === false && r4.reason.includes(ALLOW_RULES.dhcp),
       'and one rule netsh will not take stops the whole thing', r4.reason);
}

console.log('\n══ 5. arm -- five refusals, and no path that locks a PC without a way out ══');
{
    const c = fresh();
    const r = await c.enable({ allowLan: true, tunLocalIp: '10.7.0.2' });
    ok(r.ok && c.armed === true, 'the happy path arms', JSON.stringify(r.ok));
    ok(world.policy === 'BlockInbound,BlockOutbound', 'and the policy really moved');
    ok(world.sawFlipWith && world.sawFlipWith.bat === true,
       'the recovery script existed on disk BEFORE the flip, not after');
    const atFlip = world.sawFlipWith.rulesAtFlip;
    const missingAtFlip = (r2 => r2.filter(n => !atFlip.includes(n)))(
        [ALLOW_RULES.tor, ALLOW_RULES.app, ALLOW_RULES.loopback, ALLOW_RULES.dhcp]);
    ok(missingAtFlip.length === 0,
       'and the allow rules were already in place when it flipped',
       missingAtFlip.length ? 'MISSING: ' + missingAtFlip.join(', ') : atFlip.length + ' rule(s)');
    const seq = netshArgs();
    const iShow = seq.findIndex(a => /^advfirewall show allprofiles/.test(a));
    const iAdd  = seq.findIndex(a => /^advfirewall firewall add rule/.test(a));
    const iFlip = seq.findIndex(a => /firewallpolicy blockinbound,blockoutbound/i.test(a));
    ok(iShow >= 0 && iAdd > iShow && iFlip > iAdd,
       'order: read the firewall, write the allow list, only then flip the policy',
       `show ${iShow} < add ${iAdd} < flip ${iFlip}`);
}
{
    const c = fresh({ states: ['ON', 'OFF', 'ON'] });
    const r = await c.enable({});
    ok(r.ok === false && r.reason === 'windows firewall is off' && c.armed === false,
       'the firewall being off is a REFUSAL, not a warning -- there is nothing to ' +
       'contain with', r.reason);
    ok(!netshArgs().some(a => /blockinbound,blockoutbound/i.test(a)),
       'and the policy was never flipped');
    ok(said(/Containment REFUSED/), 'and the log says so');
}
{
    const c = fresh({ gpo: true });
    const r = await c.enable({});
    ok(r.ok === false && /Group Policy/.test(r.reason || '') && c.armed === false,
       'netsh reporting Ok. while the policy does not move is caught by the read-back',
       r.reason);
    const undo = netshArgs().filter(a => /firewallpolicy blockinbound,allowoutbound/i.test(a));
    ok(undo.length === 1, 'and undone immediately rather than left half applied',
       undo.length + ' undo call(s)');
}
{
    const c = fresh({ failSet: true });
    const r = await c.enable({});
    ok(r.ok === false && /netsh refused/.test(r.reason || '') && c.armed === false,
       'a netsh that refuses the flip is reported as itself', r.reason);
}
{
    //  A state dir under a FILE: mkdirSync throws ENOTDIR, so writeRecovery fails
    //  the way an unwritable ProgramData would.
    const file = path.join(TMP, 'not-a-dir');
    fs.writeFileSync(file, 'x');
    calls.length = 0; logs.length = 0;
    const c = new Containment({ Logger, stateDir: path.join(file, 'state'),
                                torExe: TOR, appExe: APP });
    const r = await c.enable({});
    ok(r.ok === false && /no recovery script/.test(r.reason || '') && c.armed === false,
       'no way out means no arming, and it is the FIRST thing checked', r.reason);
    ok(netshArgs().length === 0, 'the firewall is not read, let alone written');
    ok(said(/Recovery script could NOT be written/), 'and the log names the cause');
}

console.log('\n══ 6. disarm -- forgiving in the opposite direction, on purpose ══');
{
    const c = fresh();
    await c.enable({ allowLan: true, tunLocalIp: '10.7.0.2' });
    calls.length = 0; logs.length = 0;
    const r = await c.disable({});
    ok(r.ok && c.armed === false, 'it disarms and the flag follows the read-back');
    ok(world.policy === 'BlockInbound,AllowOutbound', 'the policy is back to the Windows default');
    const left = RULE_NAMES.filter(n => world.rules.has(n));
    ok(left.length === 0, 'and every allow rule is gone',
       left.length ? 'LEFT: ' + left.join(', ') : RULE_NAMES.length + ' deleted');
    const args = netshArgs();
    ok(args.findIndex(a => /firewallpolicy blockinbound,allowoutbound/i.test(a)) <
       args.findIndex(a => /firewall delete rule/.test(a)),
       'reachability first, rules second -- the reverse order leaves a window where ' +
       'nothing on the PC can reach anything');
}
{
    const c = fresh();
    await c.enable({});
    calls.length = 0;
    await c.disable({ keepRules: true });
    ok(!netshArgs().some(a => /firewall delete rule/.test(a)) &&
       RULE_NAMES.filter(n => world.rules.has(n)).length > 0,
       'keepRules leaves the allow list in place -- an uninstall-while-connected needs ' +
       'the policy back without deleting rules a running tunnel still uses');
}
{
    //  A disarm that gives up halfway is how a machine stays offline.
    const c = fresh();
    await c.enable({});
    calls.length = 0; logs.length = 0;
    world.failSet = true;
    const r = await c.disable({});
    ok(r.ok === false && (r.problems || []).some(p => /^policy: /.test(p)),
       'a failed policy restore is reported', (r.problems || []).join(' | '));
    ok(netshArgs().filter(a => /firewall delete rule/.test(a)).length === RULE_NAMES.length,
       'and it still deleted every rule afterwards -- it never returns early');
    ok(r.recovery === c.recoveryBat && said(/run .*restore-internet\.bat as administrator/),
       'and it hands the user the recovery script by path', r.recovery ? 'yes' : 'no');
    ok(c.armed === true,
       'armed stays TRUE while outbound is still blocked -- the flag tracks Windows, ' +
       'not our intent');
}

console.log('\n══ 7. the quit path, where there is no time to await ══');
{
    const c = fresh();
    spawned.length = 0;
    c.disableNoWait();
    ok(spawned.length === 1 && /netsh\.exe$/i.test(spawned[0].exe),
       'one netsh, fired and forgotten');
    ok(spawned[0].args.join(' ') ===
       'advfirewall set allprofiles firewallpolicy blockinbound,allowoutbound',
       'with the argv that restores outbound', spawned[0].args.join(' '));
    ok(spawned[0].opts && spawned[0].opts.detached === true &&
       spawned[0].opts.windowsHide === true && spawned[0].opts.stdio === 'ignore',
       'detached and hidden, so it outlives the process that is going away');
    ok(spawned[0].unrefd === true, 'and unref\'d, so it does not hold the event loop open');
}

console.log('\n══ 8. one spelling, in every place that has to delete it ══');
{
    const nsh   = fs.readFileSync(path.join(ROOT, 'installer.nsh'), 'utf8');
    const tasks = fs.readFileSync(path.join(ROOT, 'lib', 'installer-tasks.js'), 'utf8');
    const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');

    const missNsh = RULE_NAMES.filter(n => !nsh.includes(`name="${n}"`));
    ok(missNsh.length === 0, 'installer.nsh deletes every containment rule by name',
       missNsh.length ? 'MISSING: ' + missNsh.join(', ') : RULE_NAMES.length + ' names');
    const iAllow = nsh.indexOf('firewallpolicy blockinbound,allowoutbound');
    const iFirst = Math.min(...RULE_NAMES.map(n => nsh.indexOf(`name="${n}"`))
                                         .filter(i => i > 0));
    ok(iAllow > 0 && iFirst > iAllow,
       'and it restores outbound before deleting them -- uninstalling while armed must ' +
       'not leave a PC denied with no app to fix it');
    ok(/RULE_NAMES: CONTAINMENT_RULES/.test(tasks) && /\.\.\.CONTAINMENT_RULES/.test(tasks),
       'lib/installer-tasks.js imports the list instead of retyping it');
    ok(nsh.includes(RECOVERY_LNK) && mainSrc.includes('RECOVERY_LNK'),
       'and the Start Menu shortcut is one constant, written by main.js and deleted by ' +
       'the uninstaller', RECOVERY_LNK);
    const vals = Object.values(ALLOW_RULES);
    ok(new Set(vals).size === vals.length && vals.every(v => v.startsWith('FreeProxy ')),
       'every rule name is unique and carries this app\'s prefix, so wf.msc reads as ' +
       'ours and nothing collides', vals.length + ' names');
}

console.log(`\n${pass}/${pass + fail} checks passed`);
cp.execFile = realExecFile;
cp.spawn = realSpawn;
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
console.log('  nothing was executed: execFile was replaced before the module loaded, and ' +
            'every path above is a throwaway temp dir.');
process.exit(fail ? 1 : 0);

})().catch(e => {
    cp.execFile = realExecFile;
    cp.spawn = realSpawn;
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e2) {}
    console.log('ABORT: ' + e.stack);
    process.exit(3);
});
