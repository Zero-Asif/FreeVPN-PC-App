'use strict';
// ════════════════════════════════════════════════════════════════════
//  offthread.js -- the blocking half of a connect, in another process.
//
//  WHY THIS FILE EXISTS
//
//  Electron's main process runs the window's message pump on the same
//  thread that runs this app's JavaScript. Windows paints the ghost
//  window and the "(Not Responding)" title when that pump is not
//  serviced for about five seconds -- so every synchronous
//  execSync/spawnSync in the main process freezes the UI for its whole
//  duration, no matter how correct it is.
//
//  Measured on the developer's machine (.build/probe-uiblock-geo.js and
//  .build/probe-uiblock-ext.js, which count the commands with execSync
//  replaced by a recorder so nothing is executed):
//
//      one `reg query` through cmd.exe            57-78 ms
//      one `powershell -NoProfile "$null"`       235-301 ms
//      GeoSpoof.applyAll(coord)                >= 35 calls  ~2343 ms
//      the extension/browser steps                59 calls  ~3415 ms
//      ------------------------------------------------------------
//      one cold connect                                    ~5758 ms
//
//  That is the "(Not Responding)" the app shows and then recovers from:
//  the burst ends, the pump is serviced again, and the title goes back.
//
//  WHAT IT DOES ABOUT IT
//
//  Nothing about the work changes -- same module, same commands, same
//  arguments, same order, same journal on disk. It simply runs in a
//  child process, whose thread has no message pump to starve. The parent
//  awaits an IPC reply, so the main thread is idle for those seconds
//  instead of blocked, and the window keeps painting.
//
//  Every log line the module writes is forwarded to the parent's Logger,
//  so the app's own log reads exactly as it did before.
//
//  If this process cannot start -- and a machine with a broken
//  ELECTRON_RUN_AS_NODE, an antivirus that blocks the spawn, or a
//  packaging mistake is a real machine -- the parent runs the same call
//  in-process instead. A freeze is a bug; skipping the spoof would be a
//  lie about what is covered.
// ════════════════════════════════════════════════════════════════════

const path = require('path');

//  A log that reaches the parent's Logger instead of a console nobody
//  sees. The shape matches the Logger the modules are written against.
const send = msg => { try { process.send && process.send(msg); } catch (e) {} };
const mkLog = () => {
    const at = level => (msg, meta) => send({ log: { level, msg: String(msg), meta: meta || null } });
    return { debug: at('debug'), info: at('info'), warn: at('warn'),
             error: at('error'), success: at('success') };
};

// ── the jobs ────────────────────────────────────────────────────────
//  One entry per blocking burst the main process used to run itself.
//  Each returns something JSON-serialisable, or nothing at all when the
//  caller ignores the result -- applyAll's journal is read back off disk
//  by restoreAll(), never from its return value.
const JOBS = {
    /**
     * GeoSpoof.applyAll -- clears the old build's blocking policy, shields
     * the Windows location platform and points every Firefox profile at
     * the connected country's coordinates.
     */
    'geo-apply'({ stateDir, coord }) {
        const { GeoSpoof } = require('./geo-spoof.js');
        const geo = new GeoSpoof({ log: mkLog(), stateDir });
        geo.applyAll(coord || null);
        return { applied: true };
    },
};

//  NOT HERE, deliberately: GeoSpoof.restoreAll(). It runs on disconnect and
//  again on quit, and the quit path tears this process down as soon as the
//  parent's promise settles -- a child killed halfway through leaves the
//  Windows location platform half restored, which is worse than a freeze the
//  user never sees on a window that is already closing.

process.on('message', m => {
    if (!m || !m.job) return;
    let out = null, err = null;
    try {
        const fn = JOBS[m.job];
        if (!fn) throw new Error('unknown job ' + m.job);
        out = fn(m.payload || {});
    } catch (e) {
        err = (e && e.stack) ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e);
    }
    send({ done: true, ok: !err, result: out, error: err });
    //  Let the IPC write drain before the loop empties.
    setTimeout(() => process.exit(err ? 1 : 0), 50);
});

//  A parent that dies must not leave this holding a registry write open.
process.on('disconnect', () => process.exit(0));
