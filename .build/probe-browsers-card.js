// Read-only: exactly what browsers.detect() hands ASK 4's card, with the
// fields a launcher and honest copy both need.
'use strict';
const fs = require('fs');
const B = require('../lib/browsers.js');

console.log('CHROMIUM ids : ' + B.CHROMIUM.map(b => b.id).join(', '));
console.log('GECKO ids    : ' + B.GECKO.map(b => b.id).join(', '));
console.log('WININET ids  : ' + (B.WININET || []).map(b => b.id).join(', '));
console.log('');

let geo = null;
try { geo = require('../lib/geo-ext.js'); } catch (e) { console.log('geo-ext load: ' + e.message); }

const rows = B.detect();
console.log('detect() -> ' + rows.length + ' row(s)');
for (const b of rows) {
    console.log('---- ' + b.id);
    console.log('   name      : ' + b.name);
    console.log('   family    : ' + b.family);
    console.log('   exePath   : ' + b.exePath);
    console.log('   exe exists: ' + (b.exePath ? fs.existsSync(b.exePath) : 'n/a'));
    console.log('   dataDir   : ' + b.dataDir);
    console.log('   forcelist : ' + JSON.stringify(b.forcelist));
    console.log('   startMenu : ' + JSON.stringify(b.startMenu));
    const extra = Object.keys(b).filter(k => !['id', 'name', 'family', 'exePath', 'dataDir',
        'exe', 'exePaths', 'userData', 'profiles', 'startMenu', 'installed', 'forcelist'].includes(k));
    if (extra.length) console.log('   other keys: ' + extra.join(','));
}

if (geo && typeof geo.presence === 'function') {
    console.log('');
    try { console.log('presence(): ' + JSON.stringify(geo.presence(), null, 1)); }
    catch (e) { console.log('presence() threw: ' + e.message); }
}
if (geo && typeof geo.states === 'function') {
    try { console.log('states(): ' + JSON.stringify(geo.states(), null, 1)); }
    catch (e) { console.log('states() threw: ' + e.message); }
}
console.log('');
console.log('geo-ext exports: ' + (geo ? Object.keys(geo).join(', ') : '(none)'));
