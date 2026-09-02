//  Read-only: why did Edge not take the policy force-install after this boot?
//  Prints Edge's running processes with their start time and the flags that
//  matter (startup boost / background mode), plus the mtimes Edge itself
//  stamps when it starts, so the browser-start moment can be compared with
//  the moment the delivery helper actually began serving 8081.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ps = (script) => {
    try {
        return execFileSync('powershell.exe',
            ['-NoProfile', '-NonInteractive', '-Command', script],
            { encoding: 'utf8', timeout: 60000, windowsHide: true });
    } catch (e) { return `<<powershell failed: ${e.message}>>`; }
};

console.log('── msedge.exe processes (start time, key flags) ──');
console.log(ps(`
Get-CimInstance Win32_Process -Filter "name='msedge.exe'" |
  ForEach-Object {
    $cl = $_.CommandLine
    $tag = @()
    if ($cl -match '--no-startup-window')  { $tag += 'no-startup-window' }
    if ($cl -match '--type=([a-z-]+)')     { $tag += $Matches[1] } else { $tag += 'BROWSER' }
    if ($cl -match '--extension-process')  { $tag += 'extension-process' }
    "{0,-8} {1:yyyy-MM-dd HH:mm:ss} {2}" -f $_.ProcessId, $_.CreationDate, ($tag -join ' ')
  } | Sort-Object
`).trim() || '(none running)');

console.log('\n── Edge profile files: when Edge last touched them (local time) ──');
const ud = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'User Data');
for (const rel of ['Local State', 'Default\\Preferences', 'Default\\Secure Preferences',
                   'Last Version', 'Default\\Network\\Cookies']) {
    const f = path.join(ud, rel);
    try {
        const st = fs.statSync(f);
        console.log(`   ${rel.padEnd(28)} ${st.mtime.toLocaleString()}  ${st.size} B`);
    } catch { console.log(`   ${rel.padEnd(28)} (absent)`); }
}

console.log('\n── does Edge keep a copy of the policy it applied? ──');
for (const rel of ['Policy', 'Default\\Extension Rules', 'Default\\Extension State']) {
    const d = path.join(ud, rel);
    try {
        const names = fs.readdirSync(d);
        console.log(`   ${rel}: ${names.slice(0, 8).join(', ')}${names.length > 8 ? ' …' : ''}`);
    } catch { console.log(`   ${rel}: (absent)`); }
}

console.log('\n── external_extensions.json drop dirs (route 2b, per-browser) ──');
for (const p of ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\extensions',
                 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\External Extensions',
                 'C:\\Program Files\\Microsoft\\Edge\\Application\\extensions']) {
    let listing = '(absent)';
    try { listing = fs.readdirSync(p).join(', ') || '(empty)'; } catch {}
    console.log(`   ${p}\n      -> ${listing}`);
}

console.log('\n── is the extension anywhere in Edge\'s profile tree? ──');
const extRoot = path.join(ud, 'Default', 'Extensions');
try {
    const ids = fs.readdirSync(extRoot);
    console.log(`   ${ids.length} id folder(s): ${ids.join(', ')}`);
} catch (e) { console.log(`   cannot read ${extRoot}: ${e.code}`); }
