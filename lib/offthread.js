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
     * the Windows location platform, points every Gecko profile at the
     * connected country's coordinates and (2.0.5) writes the SOCKS5 proxy
     * prefs that put those browsers on Tor explicitly.
     *
     * `proxy` is { host, port, bypass } or absent. Absent is a real case, not
     * a defensive default: a caller with no live tunnel must not have proxy
     * prefs written on its behalf, because a browser pointed at a port
     * nothing answers cannot reach the internet at all.
     */
    'geo-apply'({ stateDir, coord, proxy }) {
        const { GeoSpoof } = require('./geo-spoof.js');
        const geo = new GeoSpoof({ log: mkLog(), stateDir });
        geo.applyAll(coord || null, proxy || null);
        return { applied: true };
    },

    /**
     * GeoSpoof.applyGecko -- the Gecko browsers' prefs and nothing else, for a
     * split-tunnel list edited while the session is already up.
     *
     * Separate from geo-apply because that one re-runs the Windows platform
     * shield: 43 registry and service calls that cost seconds and that a
     * hostname added to the bypass list does not change. applyGecko() refuses
     * when there is no session journal on disk, so this cannot be the call that
     * points a disconnected browser at a port nothing is listening on.
     */
    'geo-gecko'({ stateDir, coord, proxy }) {
        const { GeoSpoof } = require('./geo-spoof.js');
        const geo = new GeoSpoof({ log: mkLog(), stateDir });
        return { applied: geo.applyGecko(coord || null, proxy || null) };
    },

    /**
     * GeoExt.install() -- the force-install routes for every Chromium fork on
     * the machine, plus the retireSideload() that has to run before them.
     *
     * MEASURED, with execSync replaced by a recorder so nothing ran
     * (.build/probe-uiblock-ext.js, 2026-09-05): 43 synchronous reg/dsregcmd
     * calls at 225 ms each -- about 10 s of unpumped message queue, on a path
     * main.js runs on EVERY connect and every country switch. It is the largest
     * single contributor to the "(Not Responding)" title, larger than applyAll,
     * and it was the only one still on the main thread.
     *
     * prepare() deliberately stays in the parent: it starts the loopback
     * listener that serves the CRX, and a listener in a child that exits when
     * the job ends would be a dead port -- which is measured to install nothing
     * at all. So the parent hands over what prepare() produced and this job
     * adopts the port WITHOUT binding it (ExtHost.adopt opens no socket).
     */
    'ext-install'({ stateDir, sourceDir, id, version, port }) {
        const { GeoExt } = require('./geo-ext.js');
        const ext = new GeoExt({ log: mkLog(), stateDir, sourceDir });
        //  Not re-derived: the id is the hash of the key prepare() just used,
        //  and re-deriving it here would be a second chance to disagree with
        //  the policy value the parent already recorded.
        ext.id      = id || null;
        ext.version = version || null;
        if (port) ext.host.adopt(port);
        const auto = ext.install() || [];
        return { auto, attempted: ext.attempted || [], external: ext.external || [] };
    },

    /**
     * The startup pair: finish a restore a crash left half done, then purge the
     * older build's geolocation BLOCK policy.
     *
     * MEASURED (.build/probe-uiblock-startup.js, 2026-09-05): clearBlockingPolicy()
     * on its own is 30 synchronous `reg` calls -- six policy keys times five --
     * about 5752 ms at this machine's 192 ms per spawn. It sat on the path between
     * the user's double-click and a window existing at all, which is the report
     * "app installation ses houyar por start/open hoite onek time nicche".
     *
     * restoreLeftovers() first, and the purge only when it found nothing to do:
     * restoreAll() runs clearBlockingPolicy() as its own step 0, so on a
     * crash-recovery start the second call was that burst a second time with
     * nothing left for it to remove.
     */
    'geo-startup'({ stateDir }) {
        const { GeoSpoof } = require('./geo-spoof.js');
        const geo = new GeoSpoof({ log: mkLog(), stateDir });
        const hadJournal = geo.restoreLeftovers();
        return { hadJournal: !!hadJournal,
                 removed: hadJournal ? 0 : geo.clearBlockingPolicy() };
    },

    /**
     * GeoSpoof.restoreAll() -- the disconnect burst.
     *
     * MEASURED (.build/probe-uiblock-restore.js, 2026-09-05): 32 synchronous
     * `reg` calls, 20 deletes and 12 queries, about 7 s at this machine's rate.
     * It had never been counted, and it is the third freeze in the report --
     * "disconnect korar somoy app not responding dekhacche".
     *
     * ONLY for a disconnect the user is watching. main.js still calls
     * restoreAll() in-process when the app is quitting, because there the
     * parent exits as soon as the promise settles and a child killed mid-run
     * would leave the Windows location platform half restored. A freeze on a
     * window that is already closing is invisible; half-restored location
     * services are not.
     */
    'geo-restore'({ stateDir }) {
        const { GeoSpoof } = require('./geo-spoof.js');
        const geo = new GeoSpoof({ log: mkLog(), stateDir });
        geo.restoreAll();
        return { restored: true };
    },
};

//  NOT HERE for the QUIT path, deliberately: main.js calls restoreAll()
//  in-process when the app is closing, because that path tears this process
//  down as soon as the parent's promise settles -- a child killed halfway
//  through leaves the Windows location platform half restored, which is worse
//  than a freeze the user never sees on a window that is already closing. The
//  'geo-restore' job above is for the disconnect the user IS watching.

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
