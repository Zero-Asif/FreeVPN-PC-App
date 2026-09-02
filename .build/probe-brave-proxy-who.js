'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/probe-brave-proxy-who.js  --  name the extension holding the proxy
//
//  probe-brave-proxy-stuck.js found a persisted extension-controlled proxy pref
//  in Brave (mode=fixed_servers) while the app was down and every other proxy
//  layer was off. Before any of that becomes "our extension leaks the proxy",
//  the id has to be turned into a NAME, a PATH and an enabled/disabled state --
//  a third-party proxy extension would produce the identical symptom and a
//  fix aimed at ours would then change nothing.
//
//  Reads only. Prints the raw record verbatim so nothing is paraphrased.
// ════════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');

const LOCAL = process.env.LOCALAPPDATA || '';
const ROOTS = [
    ['Brave',  path.join(LOCAL, 'BraveSoftware', 'Brave-Browser', 'User Data')],
    ['Chrome', path.join(LOCAL, 'Google', 'Chrome', 'User Data')],
    ['Edge',   path.join(LOCAL, 'Microsoft', 'Edge', 'User Data')],
];

const SCOPES = ['preferences', 'regular_only_preferences',
                'incognito_persistent_preferences', 'incognito_session_only_preferences'];

//  Chromium's Extension::State: 0 = disabled, 1 = enabled, 2 = external-uninstalled.
const STATE = { 0: 'DISABLED', 1: 'enabled', 2: 'external-uninstalled' };
//  Manifest::Location, the values this app cares about.
const LOC = { 1: 'internal(store)', 2: 'external-pref', 3: 'external-registry',
              4: 'unpacked(load-unpacked)', 5: 'component', 6: 'external-pref-download',
              7: 'external-policy-download', 8: 'command-line', 9: 'external-policy',
              10: 'external-component' };

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } }

for (const [browser, root] of ROOTS) {
    let dirs;
    try {
        dirs = fs.readdirSync(root, { withFileTypes: true })
            .filter(d => d.isDirectory() && (d.name === 'Default' || /^Profile \d+$/.test(d.name)))
            .map(d => path.join(root, d.name));
    } catch (e) { continue; }

    for (const dir of dirs) {
        //  BOTH files, named separately: which one holds the record decides
        //  whether it is MAC-protected and therefore whether an outside writer
        //  could have put it there.
        for (const file of ['Preferences', 'Secure Preferences']) {
            const j = readJson(path.join(dir, file));
            const es = j && j.extensions && j.extensions.settings;
            if (!es) continue;

            for (const id of Object.keys(es)) {
                const e = es[id] || {};
                const hits = SCOPES.filter(s => e[s] && e[s].proxy !== undefined);
                if (!hits.length) continue;

                const m = e.manifest || {};
                console.log(`\n══ ${browser} / ${path.basename(dir)} / ${file} ══`);
                console.log(`  id       ${id}`);
                console.log(`  name     ${m.name || '(no manifest recorded)'}  v${m.version || '?'}`);
                console.log(`  path     ${e.path || '(none)'}`);
                console.log(`  state    ${STATE[e.state] !== undefined ? STATE[e.state] : e.state}` +
                            `   location=${LOC[e.location] || e.location}`);
                console.log(`  perms    ${JSON.stringify((e.granted_permissions || {}).api || []).slice(0, 160)}`);
                hits.forEach(s => {
                    console.log(`  ── ${s} ──`);
                    console.log('  ' + JSON.stringify(e[s].proxy, null, 2).split('\n').join('\n  '));
                });
            }
        }
    }
}
console.log('\nNothing was modified.');
