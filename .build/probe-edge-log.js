//  Read-only: run a throwaway Edge with Chromium's own verbose logging and read
//  back what it does with the force-install policy. A throwaway --user-data-dir
//  still sees HKLM machine policy, so this reproduces the real conditions while
//  leaving the user's profile alone; if the extension DOES land here, the policy
//  route works and the user's own profile is what differs.
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ID = process.argv[2] || 'pfobpmkghdbhmnpefcbjakfbcghddcce';
const SECS = Number(process.argv[3] || 90);
const EDGE = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
              'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe']
    .find(p => fs.existsSync(p));
if (!EDGE) { console.log('msedge.exe not found'); process.exit(0); }

const tmp = path.join(os.tmpdir(), `fp-edge-log-${process.pid}`);
fs.mkdirSync(tmp, { recursive: true });

const args = [
    `--user-data-dir=${tmp}`,
    '--no-first-run', '--no-default-browser-check', '--disable-sync',
    '--headless=new', '--disable-gpu',
    '--enable-logging', '--v=1',
    '--log-file=' + path.join(tmp, 'edge.log'),
    'about:blank',
];
console.log(`launching throwaway Edge, watching ${SECS}s for id ${ID}\n`);
const child = spawn(EDGE, args, { detached: true, stdio: 'ignore', windowsHide: true });
child.unref();

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
    await sleep(SECS * 1000);

    const extDir = path.join(tmp, 'Default', 'Extensions', ID);
    console.log('── did it land in the throwaway profile? ──');
    console.log(`   ${extDir}`);
    try { console.log(`   -> YES: ${fs.readdirSync(extDir).join(', ')}`); }
    catch (e) { console.log(`   -> no (${e.code})`); }

    for (const f of ['Default\\Preferences', 'Default\\Secure Preferences']) {
        const p = path.join(tmp, f);
        try {
            const raw = fs.readFileSync(p, 'utf8');
            console.log(`   ${f}: mentions id? ${raw.includes(ID) ? 'YES' : 'no'}`);
        } catch { console.log(`   ${f}: (absent)`); }
    }

    console.log('\n── Edge\'s own log, lines about policy / extensions / our port ──');
    let log = '';
    for (const cand of [path.join(tmp, 'edge.log'), path.join(tmp, 'chrome_debug.log')]) {
        try { log = fs.readFileSync(cand, 'utf8'); console.log(`   (from ${path.basename(cand)}, ${log.length} B)\n`); break; } catch {}
    }
    if (!log) console.log('   (no log file was written)');
    else {
        const keep = log.split(/\r?\n/).filter(l =>
            /policy|Policy|extension|Extension|forcelist|Forcelist|8081|crx|CRX|updates\.xml|ERR_|net_error|install/.test(l));
        console.log(keep.slice(0, 120).join('\n') || '   (no matching lines)');
        fs.writeFileSync(path.join(__dirname, 'probe-edge-log.txt'), log);
        console.log(`\n   (full log copied to .build/probe-edge-log.txt)`);
    }

    try { execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' }); } catch {}
    await sleep(1500);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { console.log(`\n(temp profile left at ${tmp}: ${e.code})`); }
})();
