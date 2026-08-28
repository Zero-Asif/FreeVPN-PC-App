'use strict';
//  Verify the enumeration command main.js now uses actually finds the
//  leftover certificates -- run unelevated, so deletion will fail, but the
//  listing must be right before the app is trusted to act on it.
const { execSync } = require('child_process');

const listPs =
    'Get-ChildItem Cert:\\LocalMachine\\Root, Cert:\\LocalMachine\\My, ' +
    'Cert:\\CurrentUser\\Root, Cert:\\CurrentUser\\My -EA SilentlyContinue | ' +
    "Where-Object { $_.FriendlyName -eq 'FreeProxy GeoSpoof' -or " +
    "($_.Subject -like '*CN=www.googleapis.com*' -and $_.Subject -eq $_.Issuer) } | " +
    'Select-Object -ExpandProperty Thumbprint -Unique';

function listCerts() {
    try {
        return execSync(`powershell -NoProfile -NonInteractive -Command "${listPs}"`,
            { windowsHide: true, timeout: 25000, stdio: 'pipe' })
            .toString().split(/\r?\n/).map(x => x.trim())
            .filter(x => /^[0-9A-Fa-f]{40}$/.test(x));
    } catch (e) { console.log('list threw: ' + e.message.split('\n')[0]); return []; }
}

const tps = listCerts();
console.log('enumeration found ' + tps.length + ' thumbprint(s):');
tps.forEach(t => console.log('  ' + t));

if (process.argv[2] === '--delete') {
    for (const tp of tps) {
        for (const st of ['Root', 'My', 'CA']) {
            for (const scope of [`-f -delstore ${st} ${tp}`, `-user -f -delstore ${st} ${tp}`]) {
                try {
                    execSync(`certutil ${scope}`, { windowsHide: true, stdio: 'ignore', timeout: 20000 });
                    console.log('  deleted via: certutil ' + scope);
                } catch (e) { /* not in this store */ }
            }
        }
    }
    const left = listCerts();
    console.log('\nafter deletion: ' + left.length + ' left');
    left.forEach(t => console.log('  STILL PRESENT ' + t));
    process.exit(left.length ? 1 : 0);
}
