'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/test-startup-resilience.js  --  the app opens at once, and when
//  something dies the user is told instead of being left with a ghost.
//
//  TWO REPORTS, both from the field, both about the same few lines:
//
//    "app installation ses houyar por start/open hoite onek time nicche"
//    "app installation er por app crash jeno na kore ba hang jeno na hoy"
//
//  The first was ordering. MEASURED (probe-uiblock-startup.js): the machine work
//  at startup costs 55 process starts and ~22.2 s, and createWindow() used to be
//  the LAST thing after all of it. A window that does not exist cannot paint, so
//  for those seconds the double-click had produced nothing -- not a spinner, not
//  a frame, nothing. The fix is one line moved, which is exactly the kind of fix
//  a later refactor undoes without noticing. So the ORDER is pinned here.
//
//  The second was unhandled events. Node's default for an uncaught exception in
//  the main process is exit(1) -- in a packaged app, the window vanishing with
//  nothing in the log. Electron's default for a dead renderer is the opposite:
//  the process lives on behind a blank window that answers nothing. Those are
//  the reported crash and the reported hang, and neither had a handler.
//
//  Static, on the shipped source with comments stripped, so prose cannot satisfy
//  a check. Nothing is started and nothing is written.
// ════════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const { stripComments } = require('./srcstrip.js');

const ROOT = path.join(__dirname, '..');
const MAINFILE = process.env.FP_MAIN || path.join(ROOT, 'main.js');
const main = stripComments(fs.readFileSync(MAINFILE, 'utf8'));
const rend = stripComments(fs.readFileSync(path.join(ROOT, 'renderer.js'), 'utf8'));

let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
    if (cond) { pass++; console.log('  ok   ' + name); }
    else { fail++; console.log('  FAIL ' + name + (extra ? '  -- ' + extra : '')); }
};
const at = (hay, needle) => hay.indexOf(needle);
const count = (hay, re) => (hay.match(re) || []).length;

// ════════════════════════════════════════════════════════════════════
console.log('── the window before the machine work ──');
// ════════════════════════════════════════════════════════════════════
const iSecure = at(main, 'secureStateDir(app.getPath(');
const iWindow = at(main, 'createWindow();');
const iSeq    = at(main, 'const startupReady = startupSequence();');
ok(iWindow > 0, 'createWindow() is called', 'not found');
ok(iSeq > 0, 'and startupSequence() is called from the same place', 'not found');
ok(iWindow > 0 && iSeq > iWindow,
   'createWindow() comes BEFORE startupSequence() -- the whole of the 22 s ' +
   'happens with a window already on screen',
   'window at ' + iWindow + ', sequence at ' + iSeq);
ok(iSecure > 0 && iSecure < iWindow,
   'and only secureStateDir() goes ahead of it, because getScriptPath() writes ' +
   'elevated .bat files into that directory and 1-3 icacls is ~149 ms',
   'secureStateDir at ' + iSecure);
ok(!/await\s+startupSequence\s*\(/.test(main),
   'startupSequence() is NOT awaited at its call site -- awaiting it would hold ' +
   'runAdminApp() and every ipcMain.handle in it out of this tick, so the renderer ' +
   'that createWindow() just started could call a handler that is not registered yet');
ok(/startupReady\.then\(/.test(main),
   'its completion is tracked by a flag instead');

//  The six calls that cost the 22 s must be INSIDE the deferred sequence, not
//  beside it. One of them hoisted back out is the whole regression.
//
//  Bounded by brace count, not by "the next line that looks like a closing
//  brace": firstRunCheck is DEFINED earlier in the file than it is called, so
//  searching for it from the top lands in the wrong function entirely.
function lift(name) {
    const m = new RegExp('\\n\\s*(?:async\\s+)?function\\s+' + name + '\\s*\\(').exec(main);
    if (!m) return '';
    let i = main.indexOf('{', m.index + m[0].length - 1);
    if (i < 0) return '';
    let depth = 0, q = null;
    for (; i < main.length; i++) {
        const c = main[i];
        if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
        if (c === '"' || c === "'" || c === '`') { q = c; continue; }
        if (c === '{') depth++;
        else if (c === '}' && --depth === 0) return main.slice(m.index, i + 1);
    }
    return '';
}
const seqBody = lift('startupSequence');
ok(!!seqBody, 'startupSequence() is locatable', 'could not bound the function');
//  Everything the user waits through before the first paint is this slice, and
//  it is meant to be three statements long.
const preWindow = iSecure > 0 && iWindow > iSecure ? main.slice(iSecure, iWindow) : '';
for (const call of ['startupCleanup(', 'setupWritableTor(', 'setupWholeMachineLayers(',
                    'firstRunCheck(']) {
    const inSeq = seqBody.includes(call);
    ok(inSeq && !preWindow.includes(call),
       call.replace('(', '') + ' runs inside the deferred sequence, not ahead of the window',
       inSeq ? 'ALSO called before createWindow()' : 'not found in startupSequence()');
}

// ── and the frame it paints is not a white flash ──
ok(/backgroundColor:\s*'#0b0d17'/.test(main),
   "the window carries style.css's own background, so the first frame is the app " +
   "and not Chromium's default white",
   'backgroundColor not set to #0b0d17');
ok(!/show:\s*false/.test(main) && !/'ready-to-show'/.test(main),
   'and it is not hidden until ready-to-show -- that trades the flash for exactly ' +
   'the empty desktop this fix was for');

// ── a connect that arrives during those seconds waits, bounded ──
ok(/STARTUP_WAIT_MS\s*=\s*\d+/.test(main), 'the wait for the sequence is bounded');
const cap = Number((main.match(/STARTUP_WAIT_MS\s*=\s*(\d+)/) || [])[1] || 0);
ok(cap >= 60000 && cap <= 300000,
   'by a cap between 1 and 5 minutes (' + Math.round(cap / 1000) + ' s): long enough ' +
   'for a first run on a slow disk, short enough that the button is always answered',
   cap + ' ms');
ok(/if \(late\)/.test(main) && /going ahead with/.test(main),
   'and past the cap the connect GOES AHEAD -- a real failure the user can read ' +
   'beats a spinner that never resolves');

// ════════════════════════════════════════════════════════════════════
console.log('\n── nothing dies quietly ──');
// ════════════════════════════════════════════════════════════════════
const HANDLERS = [
    ["process.on('uncaughtException'", 'an uncaught exception in the main process',
     "Node's default is exit(1): the window vanishes with nothing in the log"],
    ["process.on('unhandledRejection'", 'a rejected promise nobody awaited',
     'silent by default, and this app awaits dozens of netsh and reg calls'],
    ["app.on('render-process-gone'", 'a dead renderer',
     'the process lives on behind a blank window that answers nothing -- the "hang"'],
    ["app.on('child-process-gone'", 'a dead utility or GPU child',
     'same ghost, one layer down'],
];
for (const [needle, what, why] of HANDLERS) {
    ok(main.includes(needle), what + ' is handled', 'no ' + needle + ' -- ' + why);
}
ok(count(main, /reportFault\(/g) >= 10,
   'reportFault() is the one road out, used throughout (' +
   count(main, /reportFault\(/g) + ' call sites)');

//  reportFault has to do BOTH halves. A log line the user never opens is not
//  being told, and a toast with nothing behind it cannot be diagnosed later.
const rfFrom = at(main, 'function reportFault(');
const rfBody = main.slice(rfFrom, main.indexOf('\n}', rfFrom));
ok(/Logger\.error\(/.test(rfBody), 'it writes the fault to the log');
ok(/'app-fault'/.test(rfBody) && /webContents\?\.send|webContents\.send/.test(rfBody),
   'AND sends it to the window -- a fault the user cannot see is worse than one ' +
   'they can, and this app runs elevated');
ok(count(rfBody, /try\s*{/g) >= 2,
   'both halves are individually guarded, so a broken logger cannot stop the toast ' +
   'and a closed window cannot stop the log');

// ── the window end of that message actually exists ──
ok(/ipcRenderer\.on\('app-fault'/.test(rend),
   "renderer.js listens for 'app-fault' -- sending to a window that ignores it is " +
   'the same silence with more code');
const rfr = rend.slice(at(rend, "ipcRenderer.on('app-fault'"));
ok(/showToast\(/.test(rfr.slice(0, 600)), 'and shows it as a toast');
ok(/esc\(/.test(rfr.slice(0, 400)),
   'with the text escaped: the detail can carry a file path or an exception message, ' +
   'and the toast takes HTML');
ok(/View Logs/.test(rfr.slice(0, 700)),
   'and points at View Logs, where the stack already is');

// ── neither restart loop is unbounded ──
ok(/_reloadsAfterCrash\+\+ < 2/.test(main),
   'a renderer that crashes on load is reloaded twice and then left alone -- an ' +
   'unbounded reload is a spin the user cannot escape');
for (const h of ["app.on('render-process-gone'", "app.on('child-process-gone'"]) {
    const body = main.slice(at(main, h), at(main, h) + 420);
    ok(/clean-exit'\) return;/.test(body),
       h.match(/'(.+)'/)[1] + " ignores reason 'clean-exit' -- Electron raises it on " +
       'an ordinary quit, and a fault toast on every close is how a user learns to ' +
       'ignore fault toasts');
}

// ════════════════════════════════════════════════════════════════════
console.log('\n── and the way out is as careful as the way in ──');
// ════════════════════════════════════════════════════════════════════
//  will-quit cannot await. The two layers that outlive the process if they are
//  not torn down get their fire-and-forget form there, and nothing else.
const wqFrom = at(main, "app.on('will-quit'");
const wq = wqFrom > 0 ? main.slice(wqFrom, wqFrom + 1800) : '';
ok(!!wq, "there is a will-quit handler", 'no will-quit handler');
ok(/containment\.disableNoWait\(\)/.test(wq),
   'containment is disabled with the no-wait form -- default-deny left behind is a ' +
   'PC with no internet after the app is gone');
ok(/tunnel\.stopNoWait\(\)/.test(wq),
   'and the tunnel with its own, because a surviving 0.0.0.0/1 is the same outcome ' +
   'by the other route');
ok(count(wq, /try\s*{/g) >= 2,
   'each in its own try, so the first one throwing cannot skip the second');

console.log(`\n${pass}/${pass + fail} checks passed`);
if (fail) {
    console.log('\nBOTH OF THESE WERE REPORTED BY THE USER, NOT IMAGINED. A window created\n' +
                'after the machine work is a double-click that does nothing for twenty\n' +
                'seconds; an unhandled exception in the main process is a window that\n' +
                'vanishes with an empty log.');
    process.exit(1);
}
process.exit(0);
