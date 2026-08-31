'use strict';
//  scratch, read-only: the live state of all FOUR delivery routes for our id,
//  per browser, in both registry views. This is the "before" picture that
//  --fp-setup has to change, and the picture the sweep has to erase.
const { execSync } = require('child_process');
const browsers = require('../lib/browsers');
const { POLICY_KEYS, FORCELIST, EXT_SETTINGS, ALLOWLIST,
        regValues, regValue, regValueView } = require('../lib/geo-ext');

const sh = c => { try { return execSync(c, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
                  catch (e) { return null; } };

for (const id of Object.keys(POLICY_KEYS)) {
    const name = (browsers.byId(id) || {}).name || id;
    const fl = regValues(`${POLICY_KEYS[id]}\\${FORCELIST}`);
    const al = regValues(`${POLICY_KEYS[id]}\\${ALLOWLIST}`);
    const es = regValue(POLICY_KEYS[id], EXT_SETTINGS);
    const any = Object.keys(fl).length || Object.keys(al).length || es != null;
    if (!any) { console.log(`── ${name}: policies clean`); continue; }
    console.log(`── ${name}`);
    console.log('   forcelist : ' + JSON.stringify(fl));
    console.log('   allowlist : ' + JSON.stringify(al));
    console.log('   extsettings: ' + (es == null ? 'none' : es.slice(0, 300)));
}

console.log('\n═══ route 3, External Extensions providers');
for (const row of browsers.externalRoots('all')) {
    for (const view of browsers.REG_VIEWS) {
        const out = sh(`reg query "${row.key}" /reg:${view}`);
        if (!out) continue;
        const kids = out.split(/\r?\n/).map(l => (l.match(/\\([a-p]{32})\s*$/) || [])[1]).filter(Boolean);
        console.log(`   ${row.key} /reg:${view} -> ${kids.length ? kids.join(', ') : '(no ext subkeys)'}`);
        for (const k of kids) {
            console.log('      ' + k + '  update_url=' +
                        regValueView(`${row.key}\\${k}`, 'update_url', view));
        }
    }
}
