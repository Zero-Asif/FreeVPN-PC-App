'use strict';
//  Scratch: run main.js's udpPortOwners() against THIS machine's real netstat
//  and tasklist output, not a synthetic corpus. The regexes in probe-dns-fallback
//  are proved against shapes I wrote; this proves the shapes I wrote are the
//  shapes Windows actually prints. Read-only.
const fs = require('fs'), path = require('path');
const { execFile } = require('child_process');

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
function extract(src, opener) {
    const at = src.indexOf(opener);
    let d = 0;
    for (let i = at; i < src.length; i++) {
        if (src[i] === '{') d++;
        else if (src[i] === '}' && --d === 0) return src.slice(at, i + 1);
    }
}
const runQuiet = (file, args, timeout = 15000) => new Promise(resolve => {
    execFile(file, args, { windowsHide: true, encoding: 'utf8', timeout },
        (err, stdout, stderr) => resolve({
            ok: !err, code: err ? err.code : 0, out: (stdout || '') + (stderr || '') }));
});
const udpPortOwners = new Function('runQuiet',
    extract(MAIN, 'async function udpPortOwners(port) {') + '\n return udpPortOwners;')(runQuiet);

(async () => {
    for (const port of [53, 5353, 123, 65000]) {
        const t = Date.now();
        const o = await udpPortOwners(port);
        console.log(`UDP :${port}  ->  ${o.length ? o.map(x => x.label).join(', ') : '(nobody)'}` +
                    `   [${Date.now() - t} ms]`);
    }
    //  And show the raw rows for :53 so the parse can be compared by eye.
    const r = await runQuiet('netstat', ['-a', '-n', '-o', '-p', 'UDP'], 8000);
    console.log('\nraw :53 rows from netstat:');
    for (const l of String(r.out).split(/\r?\n/)) if (/:53\b/.test(l)) console.log(JSON.stringify(l));
})();
