'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/probe-forcelist.js  --  is `forcelist: 'refused'` still true for
//  Chrome and Brave now that the port is alive?
//
//  WHY THIS HAS TO BE RE-MEASURED. lib/browsers.js marks Chrome and Brave
//  forcelist:'refused' -- "measured to fail" -- and lib/geo-ext.js therefore
//  never writes ExtensionInstallForcelist for them, so the live registry has
//  that value for Edge only. But that measurement was taken BEFORE the delivery
//  fix, i.e. under the one condition where no route could possibly work: the
//  update_url named a port nothing was listening on. A policy that was honoured
//  perfectly and then failed to fetch looks identical, from the profile, to a
//  policy that was dropped during validation.
//
//  So the label may be an artifact of the bug rather than a fact about Chrome.
//  If it is an artifact, writing the forcelist for Chrome and Brave turns them
//  from "download lands, user must click Enable" into location 7, force-enabled
//  and unremovable -- which is exactly what ask #5 wants and what Edge already
//  does. That is worth an experiment rather than an assumption.
//
//  HKCU is not an option: HKCU\SOFTWARE\Policies is ACL-protected and an
//  unelevated `reg add` there returns "Access is denied" -- measured, not
//  assumed. So the policy half runs elevated from .build/forcelist-hklm.ps1,
//  writing HKLM slot 9 exactly where production would, and restoring it after.
//  This half stays unelevated because a browser must be launched as the user.
//
//  Handshake: the elevated script writes fp-fl-ready.txt when the policy is in
//  place, this probe measures and writes fp-fl-done.txt, the elevated script
//  then puts the registry back. Real profiles are never launched -- throwaway
//  --user-data-dir only.
// ════════════════════════════════════════════════════════════════════
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');

const browsers = require('../lib/browsers');
const deliver  = require('../lib/ext-deliver');

const STATE = path.join(process.env.ProgramData || 'C:\\ProgramData', 'freeproxy-vpn');
const TMP   = fs.mkdtempSync(path.join(os.tmpdir(), 'fpfl-'));
const READY = 'C:\\Windows\\Temp\\fp-fl-ready.txt';
const DONE  = 'C:\\Windows\\Temp\\fp-fl-done.txt';
const WAIT_MS  = 60000;
const FLUSH_MS = 45000;
const WANT = ['chrome', 'brave'];

const stamp = () => new Date().toISOString().slice(11, 19);
const say = (...a) => console.log(stamp(), ...a);

const REASON = { 1: 'USER_ACTION', 2: 'PERMISSIONS_INCREASE', 4: 'RELOAD',
                 8: 'UNSUPPORTED_REQUIREMENT', 16: 'SIDELOAD_WIPEOUT', 256: 'NOT_VERIFIED',
                 512: 'GREYLIST', 1024: 'CORRUPTED', 2048: 'REMOTE_INSTALL',
                 8192: 'EXTERNAL_EXTENSION', 16384: 'UPDATE_REQUIRED_BY_POLICY',
                 32768: 'CUSTODIAN_APPROVAL_REQUIRED', 65536: 'BLOCKED_BY_POLICY',
                 262144: 'NOT_ALLOWLISTED', 524288: 'UNSUPPORTED_MANIFEST_VERSION' };
const LOC = { 1: 'INTERNAL', 2: 'EXTERNAL_PREF', 3: 'EXTERNAL_REGISTRY', 4: 'UNPACKED',
              5: 'COMPONENT', 6: 'EXTERNAL_PREF_DOWNLOAD', 7: 'EXTERNAL_POLICY_DOWNLOAD',
              8: 'COMMAND_LINE', 9: 'EXTERNAL_POLICY', 10: 'EXTERNAL_COMPONENT' };
const reasons = v => {
    const flat = (Array.isArray(v) ? v : (typeof v === 'number' ? [v] : [])).reduce((a, n) => a | n, 0);
    if (!flat) return 'none';
    return Object.keys(REASON).filter(k => flat & +k).map(k => `${k}=${REASON[k]}`).join(' + ');
};

function entryOf(userData, id) {
    for (const f of ['Secure Preferences', 'Preferences']) {
        let j;
        try { j = JSON.parse(fs.readFileSync(path.join(userData, 'Default', f), 'utf8')); }
        catch (e) { continue; }
        const s = (((j.extensions || {}).settings) || {})[id];
        if (s) return s;
    }
    return null;
}

(async () => {
    const meta = deliver.readBundle(STATE);
    if (!meta) { say('ABORT: no delivery bundle'); process.exit(3); }
    const here = browsers.detectChromium().filter(b => WANT.includes(b.id) && b.exePath);
    if (!here.length) { say('ABORT: neither Chrome nor Brave is installed'); process.exit(3); }

    say(`waiting for the elevated half to write the policy (${READY})`);
    const t1 = Date.now();
    while (!fs.existsSync(READY) && Date.now() - t1 < 120000) {
        await new Promise(r => setTimeout(r, 2000));
    }
    if (!fs.existsSync(READY)) { say('ABORT: the elevated half never signalled ready'); process.exit(3); }
    say('policy is in place; reading it back from here before launching anything');
    for (const b of here) {
        const key = `HKLM\\${b.policy}\\ExtensionInstallForcelist`;
        let out = '';
        try { out = execSync(`reg query "${key}"`, { windowsHide: true, encoding: 'utf8', stdio: 'pipe' }); }
        catch (e) { out = '(absent)'; }
        say(`   ${b.id}: ${out.trim().split(/\r?\n/).filter(Boolean).join(' ｜ ')}`);
    }

    try {
        const runs = here.map(b => {
            const ud = path.join(TMP, b.id);
            fs.mkdirSync(ud, { recursive: true });
            const child = spawn(b.exePath, [`--user-data-dir=${ud}`, '--no-first-run',
                                            '--no-default-browser-check',
                                            '--disable-search-engine-choice-screen',
                                            'about:blank'],
                                { detached: true, stdio: 'ignore', windowsHide: false });
            child.unref();
            say(`   launched ${b.name} pid ${child.pid}`);
            return { b, ud, pid: child.pid, seen: null };
        });

        const t0 = Date.now();
        while (Date.now() - t0 < WAIT_MS) {
            await new Promise(r => setTimeout(r, 5000));
            let all = true;
            for (const r of runs) {
                if (r.seen) continue;
                if (fs.existsSync(path.join(r.ud, 'Default', 'Extensions', meta.id))) {
                    r.seen = ((Date.now() - t0) / 1000).toFixed(0) + 's';
                    say(`   ++ ${r.b.name}: unpacked after ${r.seen}`);
                } else all = false;
            }
            if (all) break;
        }
        say(`── waiting ${FLUSH_MS / 1000}s for prefs to flush ──`);
        await new Promise(r => setTimeout(r, FLUSH_MS));

        say('── verdict ──');
        for (const r of runs) {
            const s = entryOf(r.ud, meta.id);
            if (!s) { say(`   ${r.b.name.padEnd(14)} no prefs entry at all`); continue; }
            const l = Number(s.location);
            const forced = l === 7 || l === 9;
            const dis = reasons(s.disable_reasons);
            say(`   ${r.b.name.padEnd(14)} location ${l} (${LOC[l] || '?'})  disabled by ${dis}`);
            say(`   ${''.padEnd(14)} -> forcelist ${forced ? 'HONOURED' : 'NOT honoured'}` +
                `, extension ${dis === 'none' ? 'ENABLED' : 'DISABLED'}`);
        }
        for (const r of runs) {
            try { execSync(`taskkill /PID ${r.pid} /T /F`, { windowsHide: true, stdio: 'ignore' }); }
            catch (e) {}
        }
    } finally {
        fs.writeFileSync(DONE, 'measured\n');
        say('signalled done -- the elevated half is putting the registry back');
        say(`throwaway profiles under ${TMP}`);
    }
    process.exit(0);
})().catch(e => {
    try { fs.writeFileSync(DONE, 'aborted\n'); } catch (x) {}
    say('ABORT ' + e.stack);
    process.exit(3);
});
