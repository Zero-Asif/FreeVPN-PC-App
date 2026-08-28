'use strict';
// ════════════════════════════════════════════════════════════════════
//  Reproduce buildTorrc() EXACTLY as main.js has it, using the real
//  userData/Tor layout, and run tor.exe --verify-config on the result.
//  Extracting the function textually (rather than retyping it) means this
//  tests the shipped code, not a copy that has drifted from it.
// ════════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const SOCKS_PORT = 9050, HTTP_PORT = 9080, CTRL_PORT = 9051;
const DNS_PORT = 53, DNS_FALLBACK_PORT = 9053;

const ud = path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'freeproxy-vpn');
const torDir = path.join(ud, 'Tor', 'tor');
const getScriptPath = f => path.join(ud, f);
const Logger = { warn: m => console.log('  [logger.warn] ' + m) };

// ── pull buildTorrc + torPaths verbatim out of main.js ──────────────
const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

function extract(header) {
    const a = src.indexOf(header);
    if (a < 0) throw new Error('not found: ' + header);
    //  Both functions live inside the app.whenReady() block at exactly 4
    //  spaces of indentation, so their closing brace is the first line that
    //  is exactly "    }". Brace counting is not usable here: buildTorrc's
    //  parameter list is itself a destructuring "{ ... }".
    const close = src.indexOf('\r\n    }', a);
    if (close < 0) throw new Error('unterminated: ' + header);
    return src.slice(a, close + '\r\n    }'.length);
}

const fnSrc = extract('function torPaths()') + '\n' + extract('function buildTorrc(');
const make = new Function('fs', 'path', 'torDir', 'getScriptPath', 'Logger',
    'SOCKS_PORT', 'HTTP_PORT', 'CTRL_PORT', 'DNS_PORT',
    fnSrc + '\nreturn { torPaths, buildTorrc };');
const { torPaths, buildTorrc } = make(fs, path, torDir, getScriptPath, Logger,
    SOCKS_PORT, HTTP_PORT, CTRL_PORT, DNS_PORT);

const P = torPaths();
console.log('tor.exe   : ' + P.torExe + (fs.existsSync(P.torExe) ? '  [ok]' : '  [MISSING]'));
console.log('data dir  : ' + P.torData + (fs.existsSync(P.torData) ? '  [ok]' : '  [MISSING]'));
console.log('geoip     : ' + (fs.existsSync(P.geoip) ? 'ok' : 'MISSING'));
console.log('geoip6    : ' + (fs.existsSync(P.geoip6) ? 'ok' : 'MISSING'));
console.log('lyrebird  : ' + (fs.existsSync(P.lyre) ? 'present' : 'absent (bridge mode unavailable)'));
console.log('');

if (!fs.existsSync(P.torExe)) { console.error('Cannot verify: tor.exe not deployed yet.'); process.exit(2); }

const cases = [
    ['pinned fingerprint, DNSPort 53',
        { exitSpec: '$A53C4E9D3B2F1A0C8E7D6B5A4938271605F4E3D2', dnsPort: DNS_PORT }],
    ['country set fallback, DNSPort 53',
        { exitSpec: '{lu}', dnsPort: DNS_PORT }],
    ['pinned fingerprint, DNSPort 9053 fallback',
        { exitSpec: '$A53C4E9D3B2F1A0C8E7D6B5A4938271605F4E3D2', dnsPort: DNS_FALLBACK_PORT }],
    ['bridge mode',
        { exitSpec: '{de}', dnsPort: DNS_FALLBACK_PORT, useBridges: true }],
];

let failures = 0;
for (const [name, opts] of cases) {
    const body = buildTorrc(opts);
    const f = path.join(os.tmpdir(), 'fp_verify_' + name.replace(/[^a-z0-9]+/gi, '_') + '.torrc');
    fs.writeFileSync(f, body, 'utf8');

    const r = spawnSync(P.torExe, ['--verify-config', '-f', f],
        { cwd: torDir, windowsHide: true, encoding: 'utf8', timeout: 30000 });
    const out = (r.stdout || '') + (r.stderr || '');
    const ok = r.status === 0 && /Configuration was valid/.test(out);

    console.log((ok ? 'PASS  ' : 'FAIL  ') + name);
    if (!ok) {
        failures++;
        console.log('      exit=' + r.status);
        (out.match(/\[(?:warn|err)\][^\r\n]*/g) || ['(no diagnostics)'])
            .filter(l => !/is relative and will resolve/.test(l))
            .slice(0, 8).forEach(l => console.log('      ' + l.trim()));
    }
    try { fs.unlinkSync(f); } catch (e) {}
}

console.log('');
console.log('--- torrc as generated (pinned, DNSPort 53) ---');
console.log(buildTorrc({ exitSpec: '$A53C4E9D3B2F1A0C8E7D6B5A4938271605F4E3D2', dnsPort: DNS_PORT }));
process.exit(failures ? 1 : 0);
