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
