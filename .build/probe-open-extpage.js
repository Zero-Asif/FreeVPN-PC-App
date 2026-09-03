'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/probe-open-extpage.js  --  does `<browser>.exe <browser>://extensions`
//  on the command line actually LAND on the extensions page?
//
//  WHY IT MATTERS. Ask 4 puts one button per installed browser on a first-open
//  card, and clicking it opens that browser. If the fork's own extensions URL
//  survives the command line, the click lands the user exactly where the on/off
//  switch is; if Chromium filters it, the browser opens on the new-tab page and
//  the card has to say where to go in words instead. Either behaviour is fine --
//  what is not fine is the card CLAIMING a page it does not open. So this is
//  measured before the wording is written.
//
//  HOW. Each browser is started with a throwaway --user-data-dir (so no real
//  profile, no session, nothing of the user's is touched) and the URL as its
//  only positional argument -- byte-for-byte what main.js will pass. The answer
//  is read off the browser's own window title, which is the tab title:
//  "Extensions" if it navigated, "New tab"/"New Tab" if it was filtered.
//
//  Each browser is killed by the pid we spawned, never by image name, so a real
//  Edge/Chrome/Brave session running beside this is left alone.
// ════════════════════════════════════════════════════════════════════
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const browsers = require('../lib/browsers');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fpxpg-'));
const WAIT_MS = 25000;
const ONLY = process.argv.slice(2).filter(a => !a.startsWith('-'));

const stamp = () => new Date().toISOString().slice(11, 19);
const say = (...a) => console.log(stamp(), ...a);

/** The window title of one pid, or '' while it has none yet. */
function titleOf(pid) {
    try {
        const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
            `try { (Get-Process -Id ${pid} -ErrorAction Stop).MainWindowTitle } catch { '' }`],
            { windowsHide: true, encoding: 'utf8', timeout: 15000 });
        return String(out || '').trim();
    } catch (e) { return ''; }
}

(async () => {
    const targets = browsers.detectChromium()
        .filter(b => b.exePath && b.settings && (!ONLY.length || ONLY.includes(b.id)));
    if (!targets.length) { say('nothing to test'); process.exit(0); }

    const runs = targets.map(b => {
        const ud = path.join(TMP, b.id);
        fs.mkdirSync(ud, { recursive: true });
        //  Exactly the argv main.js will use, plus the throwaway profile and the
        //  first-run suppressors -- a first-run interstitial would put its own
        //  title on the window and answer a question nobody asked.
        const child = spawn(b.exePath, [
            `--user-data-dir=${ud}`,
            '--no-first-run', '--no-default-browser-check',
            '--disable-search-engine-choice-screen',
            b.settings,
        ], { detached: true, stdio: 'ignore', windowsHide: false });
        child.unref();
        say(`   ${b.name.padEnd(14)} pid ${child.pid}   arg: ${b.settings}`);
        return { b, pid: child.pid, title: '' };
    });

    const t0 = Date.now();
    while (Date.now() - t0 < WAIT_MS) {
        await new Promise(r => setTimeout(r, 3000));
        for (const r of runs) {
            const t = titleOf(r.pid);
            if (t && t !== r.title) { r.title = t; say(`   ${r.b.name}: window title "${t}"`); }
        }
        if (runs.every(r => r.title)) break;
    }

    say('── verdict ──');
    for (const r of runs) {
        //  Named from the title alone. "Extensions" is what every one of these
        //  forks calls that page; anything else is reported as itself rather
        //  than guessed at.
        const landed = /^extensions\b/i.test(r.title);
        say(`   ${r.b.name.padEnd(14)} ${r.title ? `"${r.title}"` : '(no window title)'}` +
            `  ->  ${landed ? 'LANDED on the extensions page'
                            : r.title ? 'filtered -- opened somewhere else' : 'unknown'}`);
    }

    for (const r of runs) {
        try { execFileSync('taskkill', ['/PID', String(r.pid), '/T', '/F'],
                           { windowsHide: true, stdio: 'ignore' }); } catch (e) {}
    }
    say(`throwaway profiles under ${TMP}`);
    process.exit(0);
})().catch(e => { say('ABORT ' + e.stack); process.exit(3); });
