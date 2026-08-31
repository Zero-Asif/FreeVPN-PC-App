'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/test-restart-marker.js  --  the ONE restart, end to end,
//  without rebooting anything.
//
//  WHY THIS EXISTS
//  This feature is a chain of five files that never run in the same process:
//  installer.nsh collects the evidence, lib/installer-tasks.js writes a marker,
//  main.js reads it over IPC, renderer.js draws the card, index.html holds the
//  ids it fills in. Every link is a string, and a single misspelt one produces
//  the worst possible outcome -- silence. The user is never told that their
//  install needs a restart, and there is nothing in any log to say so.
//
//  It also guards the honesty rule the whole design rests on: THE APP NEVER
//  DECIDES A RESTART IS NEEDED. With no evidence from Windows, deferredWork()
//  must return nothing and noteRestart() must leave no marker -- a card that
//  appeared on a clean install would be a false statement in a dialog box, and
//  imitating IDM by fabricating one is exactly what was ruled out.
//
//  Nothing here reboots, writes to HKLM, or launches a browser. The marker is
//  written into a temp directory.
// ════════════════════════════════════════════════════════════════════
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const T = require('../lib/installer-tasks');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fprst-'));
const MARKER = path.join(TMP, 'restart-pending.json');

let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
    if (cond) { pass++; console.log('  ok   ' + name); }
    else { fail++; console.log('  FAIL ' + name + (extra ? '  -- ' + extra : '')); }
};
const log = { debug: () => {}, info: () => {}, success: () => {},
              warn: () => {}, error: (...a) => console.log('   ERROR:', ...a) };

const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

const mainSrc = strip(read('main.js'));
const rendSrc = strip(read('renderer.js'));
const tasksSrc = strip(read('lib/installer-tasks.js'));
const html = read('index.html');
const css = read('style.css');
//  NSIS comments stripped: this file explains in prose why SetRebootFlag is
//  NOT called, and a checker that reads its own justification as the thing it
//  forbids reports the opposite of the truth.
const nsh = read('installer.nsh').replace(/^[ \t]*;.*$/gm, '');

console.log('── the app never decides a restart is needed ──');
ok(typeof T.deferredWork === 'function', 'deferredWork() is exported');
ok(T.RESTART_MARKER === 'restart-pending.json', 'the marker has one name',
   String(T.RESTART_MARKER));

//  Whatever is genuinely pending on THIS machine is the honest baseline: the
//  argv flag is absent, so any reason at all has to have come from Windows'
//  own PendingFileRenameOperations naming our paths.
const base = T.deferredWork(log);
ok(Array.isArray(base), 'deferredWork() answers with a list');
ok(base.every(s => typeof s === 'string' && s.length > 20),
   'every reason is a sentence a user can read', JSON.stringify(base));
console.log(`   this machine right now: ${base.length ? base.join(' | ') : 'nothing pending'}`);

//  A marker must not appear out of nothing, and a STALE one must not survive.
//  An upgrade over an install that really did need a restart is the case that
//  matters: with nothing pending now, noteRestart() has to take the old file
//  away rather than inherit its card.
fs.writeFileSync(MARKER, JSON.stringify({ at: Date.now(), why: ['from a previous install'] }));
const cleanWhy = T.noteRestart(log, { stateDir: TMP });
ok(cleanWhy.length === base.length, 'noteRestart() reports exactly what Windows deferred',
   JSON.stringify(cleanWhy));
if (!base.length) {
    ok(!fs.existsSync(MARKER), 'nothing pending -> a stale marker is DELETED, not inherited');
} else {
    ok(fs.existsSync(MARKER), 'something really is pending on this machine -> marker written');
}

console.log('── the flag installer.nsh passes is the only invented input ──');
const hadFlag = process.argv.includes('--fp-reboot-pending');
if (!hadFlag) process.argv.push('--fp-reboot-pending');
const withFlag = T.deferredWork(log);
ok(withFlag.length === base.length + 1,
   '--fp-reboot-pending adds exactly one reason', JSON.stringify(withFlag));
ok(withFlag.some(s => /Visual C\+\+|in use/i.test(s)),
   'and it names what Windows deferred', JSON.stringify(withFlag));

const wrote = T.noteRestart(log, { stateDir: TMP });
ok(fs.existsSync(MARKER), 'and noteRestart() writes the marker for it');
let j = null;
try { j = JSON.parse(fs.readFileSync(MARKER, 'utf8')); } catch (e) {}
ok(j && typeof j.at === 'number' && j.at > 1.7e12, 'the marker records when',
   JSON.stringify(j && j.at));
ok(j && Array.isArray(j.why) && j.why.length === wrote.length,
   'and the reasons, verbatim -- the card cannot say more than this',
   JSON.stringify(j && j.why));

//  A stateDir the app never passed must not put a file anywhere.
ok(T.noteRestart(log, {}).length === 0, 'no stateDir -> nothing written, nothing thrown');

if (!hadFlag) process.argv.splice(process.argv.indexOf('--fp-reboot-pending'), 1);
ok(T.deferredWork(log).length === base.length, 'removing the flag removes the reason');
T.noteRestart(log, { stateDir: TMP });

// ── the second honest reason: work of OURS that only a boot can do ──
//  A queued boot pass is a FILE, so this stays a statement about disk rather
//  than about an install having happened. The three things that could go wrong
//  are all silent: no reason at all (no card after a real install -- the field
//  report that started this), a reason that outlives its boot (a card that comes
//  back forever), and a job with no browser list crashing on names().
console.log('── a queued boot pass counts, and only until the machine boots ──');
const BOOTJOB = path.join(TMP, 'boot-pending.json');
ok(T.BOOT_MARKER === 'boot-pending.json', 'the job file has one name', String(T.BOOT_MARKER));
ok(T.bootJobFile({ stateDir: TMP }) === BOOTJOB, 'and installer-tasks puts it there',
   String(T.bootJobFile({ stateDir: TMP })));
ok(T.bootJobFile({}) === null, 'no stateDir -> no job file, rather than a path in the cwd');

const queue = j => fs.writeFileSync(BOOTJOB, JSON.stringify(j));
const bnames = require('../lib/browsers').names(['chrome', 'brave']);

queue({ at: Date.now(), mode: 'apply', browsers: ['chrome', 'brave'] });
const qApply = T.deferredWork(log, { stateDir: TMP });
ok(qApply.length === base.length + 1, 'a job queued this boot adds exactly one reason',
   JSON.stringify(qApply));
ok(bnames.length === 2 && bnames.every(n => qApply.join(' ').includes(n)),
   'and it names the browsers by their real names, not their ids',
   JSON.stringify(bnames) + ' vs ' + JSON.stringify(qApply));
ok(qApply.some(s => /starting up/.test(s) && !/still have/.test(s)),
   'apply says the last step runs during the restart', JSON.stringify(qApply));

queue({ at: Date.now(), mode: 'revert' });
const qRevert = T.deferredWork(log, { stateDir: TMP });
ok(qRevert.some(s => /still have this app's extension loaded/.test(s)),
   'revert says the opposite -- one restart clears it', JSON.stringify(qRevert));
ok(qRevert.some(s => /your browsers/.test(s)),
   'a job with no browser list still reads as a sentence', JSON.stringify(qRevert));

//  Queued before the current boot: the pass has already had its chance.
queue({ at: Date.now() - os.uptime() * 1000 - 3600000, mode: 'apply' });
ok(T.deferredWork(log, { stateDir: TMP }).length === base.length,
   'a job older than this boot is spent, and raises nothing',
   JSON.stringify(T.deferredWork(log, { stateDir: TMP })));
queue({ mode: 'apply' });
ok(T.deferredWork(log, { stateDir: TMP }).length === base.length,
   'a job with no timestamp is not evidence either');
fs.writeFileSync(BOOTJOB, 'not json at all');
ok(T.deferredWork(log, { stateDir: TMP }).length === base.length,
   'and an unreadable one is ignored rather than thrown');

//  End to end: the queued job is what puts the card up.
queue({ at: Date.now(), mode: 'apply', browsers: ['chrome'] });
const qWhy = T.noteRestart(log, { stateDir: TMP });
ok(fs.existsSync(MARKER) && qWhy.length === base.length + 1,
   'noteRestart() writes the marker for a queued pass, with no Windows evidence at all',
   JSON.stringify(qWhy));
let qj = null;
try { qj = JSON.parse(fs.readFileSync(MARKER, 'utf8')); } catch (e) {}
ok(qj && Array.isArray(qj.why) && qj.why.join('') === qWhy.join(''),
   'and the card will read exactly those sentences');
try { fs.unlinkSync(BOOTJOB); } catch (e) {}
T.noteRestart(log, { stateDir: TMP });
ok(!fs.existsSync(MARKER) || base.length > 0,
   'take the job away and the marker goes with it');

console.log('── installer.nsh really passes it, and only on evidence ──');
ok(/ExecWait '"\$INSTDIR\\FreeProxy VPN\.exe" --fp-setup\$4'/.test(nsh),
   'the flag reaches --fp-setup through $4');
ok(/vc_redist\.x64\.exe" \/quiet \/norestart' \$3/.test(nsh),
   "the redistributable's exit code is captured");
ok(/\$\{If\} \$3 == 3010/.test(nsh) && /\$\{OrIf\} \$3 == 1641/.test(nsh),
   'only 3010 and 1641 set it');
ok(/IfRebootFlag 0 \+2/.test(nsh), "NSIS's own reboot flag is read too");
ok(!/SetRebootFlag/.test(nsh),
   'and never SET -- NSIS must not raise a second reboot dialog of its own');
ok(/StrCpy \$4 ""/.test(nsh), '$4 starts empty, so a stale register cannot fake it');

console.log('── main.js reads that marker, at that path ──');
ok(/RESTART_MARKER = path\.join\(APPDATA_PATH, 'restart-pending\.json'\)/.test(mainSrc),
   'main.js and the installer name the same file');
ok(/stateDir: APPDATA_PATH/.test(mainSrc),
   'and the installer task is told where to put it');
ok(/os\.uptime\(\)/.test(mainSrc) && /bootedAt > j\.at/.test(mainSrc),
   'it expires itself once the machine has booted since the install');
ok(/function clearPendingRestart/.test(mainSrc), 'and can be cleared');

console.log('── the three IPC channels exist on both sides ──');
for (const ch of ['get-pending-restart', 'dismiss-pending-restart', 'restart-windows']) {
    ok(mainSrc.includes(`ipcMain.handle('${ch}'`), `main.js handles ${ch}`);
    ok(rendSrc.includes(`invoke('${ch}'`), `renderer.js calls ${ch}`);
}
ok(/execFile\('shutdown', \['\/r', '\/t', '0'/.test(mainSrc),
   'Restart now asks Windows for a real restart');
ok(!/shutdown[^\n]*'\/f'/.test(mainSrc),
   'and never with /f -- unsaved work must still be able to stop it');
ok(/clearPendingRestart\(\);\s*\n\s*Logger\.warn\('User chose Restart now/.test(mainSrc),
   'the marker is cleared BEFORE the reboot is requested');

console.log('── every id the card fills in exists in index.html ──');
for (const id of ['restart-modal', 'restart-why', 'restart-now', 'restart-later']) {
    ok(html.includes(`id="${id}"`), `index.html has #${id}`);
    ok(rendSrc.includes(`'${id}'`), `renderer.js uses #${id}`);
}
for (const cls of ['restart-box', 'restart-opt', 'restart-opt-label', 'restart-why']) {
    ok(new RegExp('\\.' + cls + '[\\s,{:]').test(css), `style.css styles .${cls}`);
}
ok(/#restart-modal\.open \{ display: flex; \}/.test(css), 'and it is hidden until opened');

console.log('── the card cannot inject markup, and does not nag ──');
ok(/li\.textContent = String\(line\)/.test(rendSrc),
   'the reasons are written with textContent, never innerHTML');
ok(!/setTimeout[^\n]*closeRestartCard/.test(rendSrc),
   'it does not time out -- a decision is not a toast');
ok(/dismiss-pending-restart/.test(rendSrc) && /'Later'/.test(rendSrc) === false,
   'Later clears the marker for good rather than snoozing');
ok(/checkPendingRestart\(\)/.test(rendSrc) &&
   /DOMContentLoaded'?,? ?\(\) => \{ checkPendingRestart\(\); \}/.test(rendSrc),
   'asked once, on load, and never pushed mid-session');
//  `disabled` is what the user sees; it is NOT the guard. The click lands on the
//  <span> inside the button and a disabled ancestor does not stop a dispatched
//  click from bubbling past it -- .build/probe-window.js measured two reboot
//  requests from two presses before this latch existed.
ok(/let restartDecided = false;/.test(rendSrc) &&
   (rendSrc.match(/if \(restartDecided\) return;/g) || []).length === 2,
   'both buttons are latched, so one card produces exactly one answer',
   String((rendSrc.match(/if \(restartDecided\) return;/g) || []).length));
ok(/if \(r && r\.ok\) return;\s*\n\s*restartDecided = false;/.test(rendSrc),
   'and a refused restart takes the latch off again, or Later would be dead too');

console.log('── uninstall takes it away ──');
ok(nsh.includes('Delete "C:\\ProgramData\\freeproxy-vpn\\restart-pending.json"'),
   'installer.nsh deletes the marker explicitly');
ok(/RESTART_MARKER\)/.test(tasksSrc) && /taskTeardown/.test(tasksSrc),
   'and --fp-teardown removes it too');
ok(nsh.includes('Delete "C:\\ProgramData\\freeproxy-vpn\\boot-pending.json"'),
   'the queued job goes as well -- a job file with no app is a card with no cause');
ok(nsh.includes('Delete "C:\\ProgramData\\freeproxy-vpn\\boot-result.json"'),
   "and the pass's own result file");
ok(new RegExp('schtasks /delete /tn "' + T.BOOT_TASK + '" /f').test(nsh),
   'and the task itself, by the same name lib/installer-tasks.js registers',
   T.BOOT_TASK);
ok(/unqueueBootPass/.test(tasksSrc) && /function taskTeardown/.test(tasksSrc),
   '--fp-teardown unqueues it too, for the uninstall that still has the exe');

console.log('── the boot pass is scheduled the one way that runs before a browser ──');
ok(typeof T.registerBootTask === 'function' && typeof T.queueBootPass === 'function' &&
   typeof T.unqueueBootPass === 'function' && typeof T.bootTaskRegistered === 'function',
   'all four halves of it are exported');
ok(typeof T.bootTaskRegistered() === 'boolean',
   'bootTaskRegistered() asks Windows and answers yes or no, never throws');
ok(/<BootTrigger>/.test(tasksSrc), 'ONSTART, not logon -- a logon task is already too late');
ok(/<UserId>S-1-5-18<\/UserId>/.test(tasksSrc), 'as SYSTEM, so every profile is reachable');
ok(/<RunLevel>HighestAvailable<\/RunLevel>/.test(tasksSrc), 'and elevated, or HKLM is read-only');
ok(/<ExecutionTimeLimit>PT3M<\/ExecutionTimeLimit>/.test(tasksSrc),
   'with a time limit, so a hung pass can never hold up a boot');
ok(/'utf16le'/.test(tasksSrc) && /schtasks \/create \/tn "\$\{BOOT_TASK\}" \/xml/.test(tasksSrc),
   'registered from UTF-16 XML, which is the only encoding schtasks /xml accepts');
ok(/--fp-boot/.test(tasksSrc) && /'--fp-boot': 'boot'/.test(tasksSrc),
   'and the argument it runs with is a task this app actually dispatches');
//  The self-heal is the difference between coverage that lasts and coverage that
//  ends the first time something tidies Task Scheduler up.
ok(/app\.isPackaged && !installerTasks\.bootTaskRegistered\(\)/.test(mainSrc) &&
   /installerTasks\.registerBootTask\(Logger\)/.test(mainSrc),
   'main.js re-registers it when Windows says it is gone');
ok(!/registerBootTask[\s\S]{0,400}noteRestart/.test(mainSrc),
   'and that repair never raises a card -- re-registering is not new work waiting');

console.log('── and the pass sees every user, not just SYSTEM ──');
//  SYSTEM's own %LOCALAPPDATA% is config\systemprofile\AppData\Local. A per-user
//  Chrome or Brave lives nowhere near it, so a boot pass that trusted its own
//  environment would report "no browsers" on the machine it was written for.
const profiles = T.bootProfiles();
ok(Array.isArray(profiles) && profiles.length > 0,
   'Windows own ProfileList answers with at least one real profile',
   JSON.stringify(profiles));
ok(profiles.every(p => fs.existsSync(p)), 'every one of them is a directory that exists',
   JSON.stringify(profiles));
ok(!profiles.some(p => /\\(systemprofile|LocalService|NetworkService)$/i.test(p)),
   'and the three service profiles are not in it -- they are not people',
   JSON.stringify(profiles));

const keep = { USERPROFILE: process.env.USERPROFILE,
               LOCALAPPDATA: process.env.LOCALAPPDATA,
               APPDATA: process.env.APPDATA };
const seen = [];
T.forEachProfile(p => seen.push({ p, la: process.env.LOCALAPPDATA }));
ok(seen.length === profiles.length, 'forEachProfile() runs once per profile',
   `${seen.length} of ${profiles.length}`);
ok(seen.every(s => s.la === path.join(s.p, 'AppData', 'Local')),
   "and inside it LOCALAPPDATA is that profile's, which is the whole point",
   JSON.stringify(seen));
ok(Object.keys(keep).every(k => process.env[k] === keep[k]),
   'afterwards the environment is byte-identical -- a leak would mis-detect ' +
   'every browser for the rest of the process');
let threw = false;
try { T.forEachProfile(() => { throw new Error('a browser check blew up'); }); }
catch (e) { threw = true; }
ok(threw && Object.keys(keep).every(k => process.env[k] === keep[k]),
   'and it is restored even when the callback throws');

console.log('── and the uninstall has the mirror image of the same offer ──');
ok(T.EXIT.rebootAdvised === 11, 'teardown reports "a browser was open" as exit code 11',
   String(T.EXIT.rebootAdvised));
//  Nothing may write $0 between the call and the copy: $0 is the register every
//  sweep below reuses, and a clobbered code asks the wrong question -- or none.
const tdAt = nsh.indexOf("--fp-teardown' $0");
const cpAt = nsh.indexOf('StrCpy $5 $0');
const between = tdAt >= 0 && cpAt > tdAt ? nsh.slice(tdAt, cpAt) : null;
ok(between !== null && !/(ExecWait|nsExec|ReadRegStr|ReadEnvStr|StrCpy \$0|Pop \$0)/.test(between),
   'installer.nsh saves that code before $0 is reused by the sweeps',
   between === null ? 'the copy does not follow the call at all'
                    : between.replace(/\s+/g, ' ').slice(0, 160));
ok(/StrCpy \$5 ""/.test(nsh), 'and $5 starts empty, so a skipped teardown cannot ask');
ok(/\$\{IfNot\} \$\{Silent\}\s*\n\s*\$\{AndIf\} \$5 == 11/.test(nsh),
   'the question is asked only on code 11, and never in a silent run');
ok(/MB_YESNO\|MB_ICONQUESTION/.test(nsh) && /IDNO fp_no_reboot/.test(nsh),
   'it is a question with a No, not a notice');
ok(/IDNO fp_no_reboot\s*\n\s*Reboot/.test(nsh),
   'Yes reboots, No falls straight through to the label');
ok((nsh.match(/^\s*Reboot\s*$/gm) || []).length === 1,
   'and there is exactly one Reboot in the whole file',
   String((nsh.match(/^\s*Reboot\s*$/gm) || []).length));
ok(/rebootAdvised/.test(tasksSrc) && /runningBrowsers\(\)/.test(tasksSrc),
   'and the code is returned from an open-browser check, not guessed');

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
