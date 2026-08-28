'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/policy-apply.js  --  the only part that needs administrator
//
//  Usage:  node policy-apply.js <path-to-request.json>
//
//  Driven by a JSON file rather than argv because policy values contain
//  quotes, semicolons and JSON, and quoting that through PowerShell ->
//  Start-Process -> cmd -> reg.exe reliably is not worth the risk of a
//  mangled value being reported as a browser refusal.
//
//  Kept separate from the measuring scripts on purpose. An earlier version of
//  this experiment ran the whole test elevated, which meant the BROWSERS were
//  elevated too -- not how any of this works in reality (the app elevates, the
//  user's browser does not), and enough on its own to explain a difference in
//  behaviour that had nothing to do with policy. Privilege lives here;
//  measurement happens unprivileged.
//
//  Every write is read back and reported. A write that silently failed must
//  never be reported downstream as "the browser rejected it" -- that mistake
//  cost a full round of wrong conclusions once already.
// ════════════════════════════════════════════════════════════════════
const fs = require('fs');
const { execSync } = require('child_process');

const sh = c => {
    try { return execSync(c, { windowsHide: true, encoding: 'utf8', stdio: 'pipe' }); }
    catch (e) { return 'ERR: ' + (e.stderr || e.stdout || e.message || '').toString().trim(); }
};

const TARGETS = {
    Chrome: { policy: 'HKLM\\SOFTWARE\\Policies\\Google\\Chrome',
              ext: 'HKLM\\SOFTWARE\\Google\\Chrome\\Extensions' },
    Edge:   { policy: 'HKLM\\SOFTWARE\\Policies\\Microsoft\\Edge',
              ext: 'HKLM\\SOFTWARE\\Microsoft\\Edge\\Extensions' },
    Brave:  { policy: 'HKLM\\SOFTWARE\\Policies\\BraveSoftware\\Brave',
              ext: 'HKLM\\SOFTWARE\\BraveSoftware\\Brave\\Extensions' },
};

try { execSync('net session', { windowsHide: true, stdio: 'pipe' }); }
catch (e) { console.log('NOT ELEVATED'); process.exit(2); }

const reqPath = process.argv[2];
if (!reqPath || !fs.existsSync(reqPath)) { console.log('usage: policy-apply.js <request.json>'); process.exit(2); }
const req = JSON.parse(fs.readFileSync(reqPath, 'utf8'));
const names = req.browsers && req.browsers.length ? req.browsers : Object.keys(TARGETS);
const out = [];

for (const name of names) {
    const t = TARGETS[name];
    if (!t) { out.push(name + ': unknown browser'); continue; }

    if (req.action === 'clean') {
        sh(`reg delete "${t.policy}\\ExtensionInstallForcelist" /f`);
        sh(`reg delete "${t.policy}\\ExtensionInstallAllowlist" /f`);
        sh(`reg delete "${t.policy}" /v ExtensionSettings /f`);
        sh(`reg delete "${t.policy}" /v DefaultGeolocationSetting /f`);
        for (const id of (req.ids || [])) sh(`reg delete "${t.ext}\\${id}" /f`);
        out.push(name + ': cleaned');
        continue;
    }

    sh(`reg add "${t.policy}" /f`);

    if (req.forcelist && req.forcelist.length) {
        sh(`reg delete "${t.policy}\\ExtensionInstallForcelist" /f`);
        sh(`reg add "${t.policy}\\ExtensionInstallForcelist" /f`);
        req.forcelist.forEach((entry, i) => {
            sh(`reg add "${t.policy}\\ExtensionInstallForcelist" /v "${i + 1}" /t REG_SZ /d "${entry}" /f`);
        });
        const back = sh(`reg query "${t.policy}\\ExtensionInstallForcelist"`) || '';
        const landed = req.forcelist.filter(e => back.includes(e)).length;
        out.push(`${name}: forcelist ${landed}/${req.forcelist.length} landed`);
    }

    if (req.extensionSettings) {
        const json = JSON.stringify(req.extensionSettings);
        sh(`reg add "${t.policy}" /v "ExtensionSettings" /t REG_SZ /d "${json.replace(/"/g, '\\"')}" /f`);
        const back = sh(`reg query "${t.policy}" /v "ExtensionSettings"`) || '';
        out.push(`${name}: ExtensionSettings ${back.includes('installation_mode') ? 'landed' : 'FAILED'}`);
    }

    for (const e of (req.externalRegistry || [])) {
        sh(`reg add "${t.ext}\\${e.id}" /f`);
        sh(`reg add "${t.ext}\\${e.id}" /v "update_url" /t REG_SZ /d "${e.update_url}" /f`);
        const back = sh(`reg query "${t.ext}\\${e.id}" /v "update_url"`) || '';
        out.push(`${name}: external ${e.id.slice(0, 8)} ${back.includes(e.update_url) ? 'landed' : 'FAILED'}`);
    }

    //  The offline form of the same key: a local .crx plus its version, with
    //  no update server at all. `version` is not optional -- Chromium uses it
    //  to decide whether the file on disk is newer than what is installed, and
    //  omitting it makes the entry invalid rather than merely versionless.
    for (const e of (req.externalPath || [])) {
        sh(`reg add "${t.ext}\\${e.id}" /f`);
        sh(`reg add "${t.ext}\\${e.id}" /v "path" /t REG_SZ /d "${e.path}" /f`);
        sh(`reg add "${t.ext}\\${e.id}" /v "version" /t REG_SZ /d "${e.version}" /f`);
        const back = sh(`reg query "${t.ext}\\${e.id}"`) || '';
        out.push(`${name}: externalPath ${e.id.slice(0, 8)} ` +
                 (back.includes(e.path) && back.includes(e.version) ? 'landed' : 'FAILED'));
    }

    if (req.allowlist && req.allowlist.length) {
        sh(`reg delete "${t.policy}\\ExtensionInstallAllowlist" /f`);
        sh(`reg add "${t.policy}\\ExtensionInstallAllowlist" /f`);
        req.allowlist.forEach((id, i) => {
            sh(`reg add "${t.policy}\\ExtensionInstallAllowlist" /v "${i + 1}" /t REG_SZ /d "${id}" /f`);
        });
        const back = sh(`reg query "${t.policy}\\ExtensionInstallAllowlist"`) || '';
        out.push(`${name}: allowlist ${req.allowlist.filter(i => back.includes(i)).length}/${req.allowlist.length} landed`);
    }

    if (req.defaultGeo != null) {
        sh(`reg add "${t.policy}" /v "DefaultGeolocationSetting" /t REG_DWORD /d ${req.defaultGeo} /f`);
        const back = sh(`reg query "${t.policy}" /v "DefaultGeolocationSetting"`) || '';
        out.push(`${name}: DefaultGeolocationSetting ${back.includes('0x') ? 'landed' : 'FAILED'}`);
    }
}

//  Report through a file: an elevated process gets its own console window that
//  closes on exit, so stdout is not readable by the caller.
if (req.resultPath) { try { fs.writeFileSync(req.resultPath, out.join('\n') + '\n'); } catch (e) {} }
console.log(out.join('\n'));
console.log(req.action === 'clean' ? 'CLEANED' : 'APPLIED');
