'use strict';
// ════════════════════════════════════════════════════════════════════
//  test-offthread.js -- the child process that keeps the window alive
//
//  main.js used to run GeoSpoof.applyAll(coord) on Electron's main
//  thread, which is the thread that pumps the window's message queue.
//  Measured with the commands counted and none executed
//  (.build/probe-uiblock-geo.js, .build/probe-uiblock-ext.js): >= 35
//  synchronous shell calls, ~2343 ms, on every connect AND every switch,
//  inside a ~5758 ms cold-connect burst -- past the ~5 s after which
//  Windows paints "(Not Responding)" and then clears it again.
//
//  It now runs in lib/offthread.js, in a child process. This file proves
//  the contract main.js depends on:
//
//    1. the child answers EVERY message, or exits -- the parent can
//       always settle, and never waits forever with a spinner up;
//    2. an unknown job is an error, not a silent success;
//    3. the real GeoSpoof.applyAll runs in there and its log lines come
//       back over IPC, so the app's log reads as it did before;
//    4. a crashing job still answers, so the parent's in-process
//       fallback is reachable rather than theoretical.
//
//  NOTHING IS APPLIED. The child is started with
//  `--require .build/stub-machine.js`, which replaces execSync/
//  execFileSync/spawnSync with recorders and refuses every
//  writeFileSync/unlinkSync outside a throwaway TEMP directory, before
//  lib/geo-spoof.js is loaded. No registry key, no service, no firewall
//  rule and no Firefox profile is touched.
//
//  What this file does NOT test: runOffThread() itself lives in main.js,
//  which cannot be required outside Electron (it calls app.* at load).
//  Its side is covered by `node --check main.js` plus the packaging
//  assertion at the end -- that the script it forks is really shipped,
//  and really unpacked from the asar.
// ════════════════════════════════════════════════════════════════════

const { fork } = require('child_process');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

const REPO   = path.join(__dirname, '..');
const SCRIPT = path.join(REPO, 'lib', 'offthread.js');
const STUB   = path.join(__dirname, 'stub-machine.js');

let pass = 0, fail = 0;
const ok = (cond, what, detail = '') => {
    console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${what}${detail ? ' -- ' + detail : ''}`);
    cond ? pass++ : fail++;
};

/**
 * Fork lib/offthread.js the way main.js's runOffThread() does -- same
 * stdio shape, same ELECTRON_RUN_AS_NODE, same one-message protocol --
 * and collect everything it says back.
 */
function drive(job, payload, { stub = true, allowDir = null, timeoutMs = 60000 } = {}) {
    return new Promise(resolve => {
        const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
        if (stub) {
            env.NODE_OPTIONS = ((env.NODE_OPTIONS || '') + ' --require ' + JSON.stringify(STUB)).trim();
            if (allowDir) env.FP_STUB_ALLOW_DIR = allowDir;
        }
        const child = fork(SCRIPT, [], {
            windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env,
        });
        const got = { logs: [], cmds: [], blocked: [], done: null, exit: null, stderr: '' };
        let settled = false;
        const finish = () => { if (settled) return; settled = true; clearTimeout(t); resolve(got); };
        const t = setTimeout(() => { try { child.kill(); } catch (e) {} finish(); }, timeoutMs);

        if (child.stderr) child.stderr.on('data', d => { got.stderr += d.toString(); });
        child.on('message', m => {
            if (!m) return;
            if (m.log)  return void got.logs.push(m.log);
            if (m.stub) {
                if (m.stub.cmd) got.cmds.push(m.stub.cmd);
                else got.blocked.push(m.stub.blockedWrite || m.stub.blockedUnlink);
                return;
            }
            if (m.done) got.done = m;
        });
        child.on('error', e => { got.stderr += 'fork error: ' + e.message; finish(); });
        child.on('exit', code => { got.exit = code; finish(); });
        child.send({ job, payload });
    });
}

(async () => {
    console.log(`\n── the child answers, always -- ${new Date().toISOString()} ──`);
    {
        const r = await drive('no-such-job', {});
        ok(!!r.done, 'an unknown job still gets a reply', r.done ? '' : 'no reply at all');
        ok(r.done && r.done.ok === false, 'and the reply says it failed');
        ok(r.done && /unknown job/.test(r.done.error || ''), 'naming the job it did not know',
           r.done ? String(r.done.error).slice(0, 60) : '');
        ok(r.exit === 1, 'and the process exits non-zero', 'exit ' + r.exit);
    }

    {
        //  A job whose payload is nonsense: the child must still answer, or
        //  main.js's fallback never runs and the location is never shielded.
        const r = await drive('geo-apply', null);
        ok(!!r.done, 'a job called with no payload still answers rather than hanging',
           r.done ? `ok=${r.done.ok}` : 'no reply');
        ok(r.exit !== null, 'and the process always exits', 'exit ' + r.exit);
    }

    console.log('\n── the real applyAll, in there, with nothing applied ──');
    {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-offthread-'));
        const r = await drive('geo-apply',
            { stateDir: dir, coord: { lat: 59.3293, lon: 18.0686, accuracy: 40 } },
            { allowDir: dir });

        ok(r.cmds.length > 0, 'the shipped GeoSpoof really ran -- it asked for shell commands',
           `${r.cmds.length} command(s)`);
        ok(r.cmds.some(c => /^reg\s/i.test(c)), 'including the registry work');
        ok(!!r.done, 'and it reported back', r.done ? `ok=${r.done.ok}` : 'no reply');
        ok(r.logs.length > 0, 'its log lines came back over IPC, so the app log is unchanged',
           `${r.logs.length} line(s): ` + (r.logs[0] ? r.logs[0].level + ' ' +
            String(r.logs[0].msg).slice(0, 40) : ''));
        ok(r.logs.every(l => ['debug', 'info', 'warn', 'error', 'success'].includes(l.level)),
           'every forwarded line names a level the parent Logger has');

        //  The journal is the whole point of applyAll: restoreAll() reads it
        //  off disk, so it has to be written by the CHILD in the state dir
        //  the parent passed -- not left in the child's cwd.
        const journal = path.join(dir, 'geo-restore.json');
        ok(fs.existsSync(journal), 'the restore journal was written in the state dir it was given');
        if (fs.existsSync(journal)) {
            let j = null;
            try { j = JSON.parse(fs.readFileSync(journal, 'utf8')); } catch (e) {}
            ok(!!j && typeof j === 'object', 'and it is readable JSON',
               j ? Object.keys(j).join(',') : 'unparseable');
        }
        ok(r.blocked.length === 0 || r.blocked.every(p => !!p),
           'nothing outside that directory was written',
           r.blocked.length ? r.blocked.length + ' refused: ' + r.blocked[0] : 'none attempted');

        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
    }

    console.log('\n── the Connect button cannot wait forever ──');
    {
        //  The reported symptom: the app takes a long time to open after
        //  install, and a connect asked for during that window has to wait for
        //  startupSequence(). Every step in there is individually timed out, but
        //  awaitStartup() is the last thing between the button and the user --
        //  so it is lifted out of main.js and driven with a startupReady that
        //  NEVER settles, which no arrangement of timeouts inside can produce.
        const mainSrc = fs.readFileSync(path.join(REPO, 'main.js'), 'utf8');
        const FROM = mainSrc.indexOf('const STARTUP_WAIT_MS =');
        const TO   = mainSrc.indexOf('\n    }', mainSrc.indexOf('async function awaitStartup', FROM));
        ok(FROM > 0 && TO > FROM, 'main.js declares STARTUP_WAIT_MS above awaitStartup');

        const capMs = Number((mainSrc.slice(FROM, FROM + 60)
                                     .match(/STARTUP_WAIT_MS = (\d+)/) || [])[1]);
        //  Generous, not tight: the measured sequence is ~22 s and the slowest
        //  bounded step in it is 120 s, so a cap under that would fire on a slow
        //  machine that was going to succeed.
        ok(capMs >= 120000, 'the cap is longer than the slowest bounded step inside it',
           capMs + ' ms');

        //  Only the constant is scaled -- the text is otherwise verbatim -- so
        //  this finishes in a fifth of a second instead of three minutes.
        const text = mainSrc.slice(FROM, TO + 6)
                            .replace(/STARTUP_WAIT_MS = \d+/, 'STARTUP_WAIT_MS = 150');
        const logs = [], progress = [];
        const Logger = { info: m => logs.push(['info', String(m)]),
                         warn: m => logs.push(['warn', String(m)]),
                         debug(){}, error(){}, success(){} };
        const build = (startupReady, _startupDone) => new Function(
            'Logger', 'progressToAll', 'startupReady', '_startupDone',
            text + '\n; return awaitStartup;')(
                Logger, (wc, p) => progress.push(p), startupReady, _startupDone);

        const t0 = Date.now();
        await build(new Promise(() => {}), false)(null, 'se');
        const waited = Date.now() - t0;
        ok(waited >= 150 && waited < 5000,
           'a startup sequence that never settles no longer holds the connect',
           'returned after ' + waited + ' ms');
        ok(logs.some(l => l[0] === 'warn' && /has not finished/.test(l[1])),
           'and it says so in the log rather than going quiet',
           (logs.find(l => l[0] === 'warn') || [, 'no warning'])[1].slice(0, 70));
        ok(progress.length === 1 && progress[0].percent === 2 &&
           progress[0].status === 'connecting' && progress[0].serverCode === 'se',
           'the UI was told it is preparing, under the country asked for',
           JSON.stringify(progress[0] || null));

        //  The other two paths: already finished is a silent no-op, and a
        //  sequence that resolves late is waited for rather than abandoned.
        logs.length = progress.length = 0;
        await build(new Promise(() => {}), true)(null, 'se');
        ok(logs.length === 0 && progress.length === 0,
           'an ordinary connect after startup logs nothing and sends no progress');

        logs.length = progress.length = 0;
        const t1 = Date.now();
        await build(new Promise(r => setTimeout(r, 60)), false)(null, 'no');
        const short = Date.now() - t1;
        ok(short >= 55 && short < 140, 'a slow-but-finishing startup is waited for, not cut off',
           short + ' ms');
        ok(!logs.some(l => l[0] === 'warn'), 'and nothing is warned about when it finishes in time');

        //  A rejection is the case that used to matter most: startupSequence()
        //  catches everything today, but `await startupReady` on a rejected
        //  promise would throw straight out of the connect handler.
        logs.length = 0;
        let threw = false;
        await build(Promise.reject(new Error('startup blew up')), false)(null, 'no')
            .catch(() => { threw = true; });
        ok(!threw, 'a startup sequence that REJECTS does not throw out of the connect path');

        //  And every way in really goes through it.
        const entries = [...mainSrc.matchAll(/await awaitStartup\(/g)].length;
        ok(entries >= 1, 'the connect path awaits it', entries + ' call site(s)');

        //  The last spawn that was still on the pump on the connect/switch path.
        //  MEASURED (.build/probe-runningbrowsers-cost.js): one synchronous
        //  `tasklist /FI` per browser was 932-1690 ms of blocked thread for a
        //  log line, on every connect AND every switch. Both halves are checked,
        //  because either one alone puts it back: sync would block, and one
        //  spawn per browser would cost N times as much even async.
        //  main.js ships CRLF, so the terminator is matched by regex rather than
        //  by indexOf('\n}\n') -- which finds nothing and hands back the whole
        //  rest of the file, making every check below pass or fail on the wrong
        //  text.
        const rb = mainSrc.slice(mainSrc.indexOf('function runningBrowsers()'));
        const end = rb.search(/\r?\n\}\r?\n/);
        ok(end > 0, 'main.js still declares runningBrowsers() as a top-level function');
        const body = rb.slice(0, end);
        ok(!/execSync|execFileSync|spawnSync/.test(body),
           'runningBrowsers() no longer spawns synchronously on the message pump',
           (body.match(/exec\w*Sync|spawnSync/) || ['clean'])[0]);
        ok((body.match(/execFile\(|exec\(|spawn\(/g) || []).length === 1,
           'and it asks Windows once for the whole process list, not once per browser',
           (body.match(/execFile\(|exec\(|spawn\(/g) || []).join(' '));
        ok(/EXES\.filter/.test(body) && /'"'/.test(body),
           'matching each name as a quoted CSV field, so one exe cannot match another');
        //  Not awaited at the call site: a log line must not add a second of
        //  wall clock to the connect it is describing.
        ok(/runningBrowsers\(\)\.then\(/.test(mainSrc) &&
           !/await runningBrowsers\(/.test(mainSrc),
           'and the connect does not wait for it -- the line lands when it lands');

        //  execSync survives in main.js in exactly two places where it is right:
        //  the admin check, which runs before any window exists, and the
        //  quit-path taskkill, where async work would not finish. A ceiling and
        //  not a pin -- three today, and removing one is progress; a FOURTH is a
        //  new freeze on a path that has a window up.
        const syncSites = [...mainSrc.matchAll(/^.*\b(?:execSync|execFileSync|spawnSync)\(.*$/gm)]
            .map(m => m[0].trim().slice(0, 46));
        ok(syncSites.length <= 3, 'main.js has no new synchronous spawns',
           syncSites.length + ': ' + syncSites.join(' | '));
    }

    console.log('\n── a .bat that never exits does not wedge the disconnect ──');
    {
        //  Eight .bat files go through runBat() -- the WinINET writer, the
        //  kill-switch lock, the disconnect, the exit -- and every caller awaits
        //  it. cmd.exe blocked forever on a `net stop dnscache` against a wedged
        //  service was a disconnect that never finishes and a quit that never
        //  quits: unbounded, and not the message pump at all. Lifted out of
        //  main.js and driven with a child that never exits, because no
        //  arrangement of real commands can be relied on to hang on demand.
        const mainSrc = fs.readFileSync(path.join(REPO, 'main.js'), 'utf8');
        const FROM = mainSrc.indexOf('    function runBat(filePath, content');
        const TO   = mainSrc.indexOf('\r\n    }', mainSrc.indexOf('proc.on(\'error\'', FROM));
        ok(FROM > 0 && TO > FROM, 'main.js declares runBat with a spawn and an error handler');
        const text = mainSrc.slice(FROM, TO + 7);

        ok(/function runBat\(filePath, content, \{ timeout = \d+ \} = \{\}\)/.test(text),
           'runBat takes a timeout, and defaults it rather than making every caller pass one',
           (text.match(/timeout = \d+/) || ['none'])[0]);

        const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'fp bat ')));
        const bat = path.join(dir, 'fp_never.bat');
        const logs = [];
        const Logger = { error: (m, meta) => logs.push(['error', String(m), meta]),
                         warn: (m, meta) => logs.push(['warn', String(m), meta]),
                         debug(){}, info(){}, success(){} };

        //  A child that emits nothing and never exits, and a taskkill that is
        //  recorded rather than run -- nothing on this machine is killed.
        const { EventEmitter } = require('events');
        const killed = [];
        let liveProc = null;
        const fakeSpawn = (exe, args) => {
            if (/taskkill/i.test(exe)) {
                killed.push(args.join(' '));
                return Object.assign(new EventEmitter(), { unref() {}, pid: 2, kill() {} });
            }
            liveProc = Object.assign(new EventEmitter(), {
                pid: 4242, stdout: new EventEmitter(), stderr: new EventEmitter(),
                killCalls: 0, kill() { this.killCalls++; },
            });
            return liveProc;
        };
        const build = () => new Function('fs', 'Logger', 'spawn',
            text + '\n; return runBat;')(fs, Logger, fakeSpawn);

        const t0 = Date.now();
        const r = await build()(bat, '@echo off\r\nrem hello', { timeout: 200 });
        const waited = Date.now() - t0;
        ok(waited >= 200 && waited < 4000, 'it gives up and answers instead of waiting forever',
           'answered after ' + waited + ' ms');
        ok(r && r.ok === false && /timed out/.test(r.error || ''),
           'and the answer says it timed out, so the caller is not told it worked',
           JSON.stringify(r));
        ok(logs.some(l => l[0] === 'error' && /did not finish within/.test(l[1])),
           'the log names the file and the cap',
           (logs.find(l => /did not finish/.test(l[1])) || [, 'nothing logged'])[1].slice(0, 60));
        //  proc.kill() reaches cmd.exe only; the netsh/reg it started is what
        //  hangs, and it survives its parent. /T is what takes the tree.
        ok(killed.length === 1 && /\/F/.test(killed[0]) && /\/T/.test(killed[0]) &&
           /\b4242\b/.test(killed[0]),
           'and the whole process TREE is killed, not just cmd.exe', killed[0] || 'no taskkill');
        ok(liveProc && liveProc.killCalls === 1, 'cmd.exe itself is killed too');

        //  The file really was written before the spawn -- a timeout path that
        //  skipped the write would pass every check above and ship nothing.
        ok(fs.existsSync(bat) && /rem hello/.test(fs.readFileSync(bat, 'utf8')),
           'the script was written before it was run');

        //  A child that exits normally must still settle exactly once, and the
        //  timer must not fire after it.
        logs.length = 0; killed.length = 0;
        const p = build()(bat, '@echo off', { timeout: 5000 });
        liveProc.stdout.emit('data', Buffer.from('FP_ALL_OK\r\n'));
        liveProc.emit('exit', 0);
        const good = await p;
        ok(good.ok === true && good.code === 0, 'an ordinary run still resolves ok', JSON.stringify(good));
        await new Promise(r2 => setTimeout(r2, 60));
        ok(killed.length === 0, 'and nothing is killed on the happy path');

        //  Two settle sources at once: exit AND the timer. resolve() ignores the
        //  second, but the taskkill would still fire and kill a pid Windows may
        //  have reused by then.
        logs.length = 0; killed.length = 0;
        const p2 = build()(bat, '@echo off', { timeout: 120 });
        liveProc.emit('exit', 0);
        await p2;
        await new Promise(r2 => setTimeout(r2, 250));
        ok(killed.length === 0,
           'a child that exits just before the cap is not killed afterwards',
           killed.join(' | ') || 'none');

        //  And runBatLines, which is the shape the strict callers use, has to
        //  forward the cap rather than silently keeping the default.
        ok(/function runBatLines\(filePath, lines, opts\)/.test(mainSrc) &&
           /runBat\(filePath, body\.join\('\\r\\n'\), opts\)/.test(mainSrc),
           'runBatLines passes the caller\'s timeout through to runBat');

        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
    }

    console.log('\n── packaging: the script main.js forks has to be there ──');
    {
        ok(fs.existsSync(SCRIPT), 'lib/offthread.js exists next to main.js', SCRIPT);
        const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
        const files  = (pkg.build && pkg.build.files) || [];
        const unpack = (pkg.build && pkg.build.asarUnpack) || [];
        ok(files.some(f => /^lib\//.test(String(f))), 'lib/ is inside the packaged app',
           files.filter(f => /^lib\//.test(String(f))).join(' '));
        ok(unpack.some(f => /^lib\//.test(String(f))),
           'and unpacked from the asar, so the forked child needs no asar support',
           unpack.join(' '));

        //  The rewrite main.js applies to __dirname when it is packaged. Asserted
        //  on the string, because there is no app.asar on a dev machine.
        const packed = 'C:\\Program Files\\FreeProxy VPN\\resources\\app.asar\\lib\\offthread.js';
        const rewritten = packed.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
        ok(rewritten.includes('app.asar.unpacked\\lib\\offthread.js'),
           'the packaged path rewrite points at the unpacked copy', rewritten.slice(-46));
    }

    //  ── an Electron binary, if one has been built ────────────────────
    //  The riskiest assumption in runOffThread() is that an ELECTRON binary
    //  will run a plain Node script when ELECTRON_RUN_AS_NODE is set --
    //  `node` proving it above proves nothing about Electron.
    //
    //  The SHIPPED exe carries requestedExecutionLevel=requireAdministrator,
    //  so a non-elevated shell cannot start it at all (EACCES, before any
    //  code runs). That is a property of this test's shell, not of the fix:
    //  the app itself always runs elevated, and an elevated process starts
    //  its own exe again with no prompt. When the shell cannot do it, the
    //  same assertion is made against node_modules/electron of the version
    //  being shipped, which has no such manifest.
    console.log('\n── an Electron binary, run as Node, over IPC ──');
    {
        const { spawn } = require('child_process');
        const elevated = (() => {
            try { require('child_process').execSync('net session',
                      { stdio: 'ignore', windowsHide: true }); return true; }
            catch (e) { return false; }
        })();

        const driveWith = (exe, script) => new Promise(resolve => {
            //  spawn with an 'ipc' slot is what fork() does internally; it is
            //  used directly here only because fork() would launch THIS node,
            //  and the point is to launch an Electron binary.
            const child = spawn(exe, [script], {
                windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
                env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
            });
            const got = { done: null, exit: null, stderr: '' };
            let settled = false;
            const fin = () => { if (!settled) { settled = true; clearTimeout(t); resolve(got); } };
            const t = setTimeout(() => { try { child.kill(); } catch (e) {} fin(); }, 45000);
            if (child.stderr) child.stderr.on('data', d => { got.stderr += d.toString(); });
            child.on('message', m => { if (m && m.done) got.done = m; });
            child.on('error', e => { got.stderr += 'spawn error: ' + e.message; fin(); });
            child.on('exit', c => { got.exit = c; fin(); });
            try { child.send({ job: 'no-such-job' }); } catch (e) { got.stderr += ' ' + e.message; fin(); }
        });

        const packedExe   = path.join(REPO, 'release', 'win-unpacked', 'FreeProxy VPN.exe');
        const packedChild = path.join(REPO, 'release', 'win-unpacked', 'resources',
                                      'app.asar.unpacked', 'lib', 'offthread.js');
        const devExe      = path.join(REPO, 'node_modules', 'electron', 'dist', 'electron.exe');

        let target = null;
        if (fs.existsSync(packedExe) && fs.existsSync(packedChild) && elevated) {
            target = { exe: packedExe, script: packedChild, what: 'the shipped exe' };
        } else if (fs.existsSync(devExe)) {
            target = { exe: devExe, script: SCRIPT, what: 'node_modules/electron ' +
                       (JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'))
                            .devDependencies || {}).electron };
            if (fs.existsSync(packedExe) && !elevated) {
                console.log('  --   the shipped exe needs an elevated shell to start ' +
                            '(requireAdministrator); using the same Electron below');
            }
        }

        if (!target) {
            console.log('  --   no Electron binary available, skipped');
        } else {
            const r = await driveWith(target.exe, target.script);
            ok(!!r.done, `${target.what} runs lib/offthread.js as Node and answers over IPC`,
               r.done ? '' : 'no reply; stderr: ' + r.stderr.slice(0, 140));
            ok(r.done && r.done.ok === false && /unknown job/.test(r.done.error || ''),
               'with the same contract as under plain node');
            ok(r.exit === 1, 'and the same exit code', 'exit ' + r.exit);
        }

        //  And that the child it forks sits beside the module it loads:
        //  offthread.js requires ./geo-spoof.js by relative path.
        if (fs.existsSync(packedChild)) {
            ok(fs.existsSync(path.join(path.dirname(packedChild), 'geo-spoof.js')),
               'in the packaged build, geo-spoof.js is unpacked in the same directory, ' +
               'so that require resolves');
        }
    }

    console.log(`\n${pass}/${pass + fail} checks passed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error('test crashed: ' + e.stack); process.exit(1); });
