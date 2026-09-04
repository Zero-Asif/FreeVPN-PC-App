'use strict';
// ════════════════════════════════════════════════════════════════════
//  probe-browser-policy.js -- the Chromium half of the tunnel, 2.0.5.
//
//  Until 2.0.5 forceAllBrowsersOntoProxy() could not fail. Literally: its
//  PowerShell opened with `$ErrorActionPreference = 'SilentlyContinue'` and
//  closed with a literal `Write-Output "PROXY_OK CHANGED=$changed"`, and the
//  JavaScript logged Logger.success() on the strength of having received any
//  output at all. Six Set-ItemProperty calls per browser sit between those two
//  lines, all into HKLM, and every one of them can fail -- no elevation, an AV
//  product holding the hive, another management tool owning the policy key.
//  When they did, the app reported "Browser policy applied to Edge/Chrome/
//  Brave" and WebRtcIPHandlingPolicy -- the value that stops Chromium handing
//  out the real IP over WebRTC -- was never written.
//
//  restoreAllBrowsersProxy() had the same shape, and there it is worse: a
//  false RESTORE_OK leaves the browser pointed at 127.0.0.1:9050 after the app
//  has said it let go, and once tor.exe exits that browser has no network at
//  all.
//
//  What this probe holds the two functions to:
//
//    1. The generated PowerShell PARSES -- checked by PowerShell's own parser,
//       not by eye. Both scripts are hand-assembled from ~40 string literals.
//    2. No blanket SilentlyContinue on $ErrorActionPreference, in either.
//    3. The user's split-tunnel list reaches Chromium's ProxyBypassList, in
//       exactly the form bypassToProxyOverride() produces -- so a host Windows
//       bypasses is a host the browser bypasses.
//    4. Every value written is read BACK, and the totals are printed from
//       counters a script that skipped the comparison could not have moved.
//    5. The JavaScript verdict follows the counters: success ONLY on
//       bad=0 AND ok=<every key>. A missing verdict line is an error, not a
//       success with a missing line.
//    6. Nothing that reaches the .bat/registry can carry a quote, a
//       semicolon-plus-command, or a newline -- the list is user input.
//
//  NOTHING on this machine is touched. The two functions are extracted from
//  main.js by brace matching and run against a stubbed runPs1 that captures
//  the script text instead of executing it; the only real process started is
//  powershell.exe -Command on the PARSER, with the script passed as data.
//
//  Run:  node .build/probe-browser-policy.js
// ════════════════════════════════════════════════════════════════════

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT_DIR = path.join(__dirname, '..');
const MAIN     = fs.readFileSync(path.join(ROOT_DIR, 'main.js'), 'utf8');

let pass = 0, fail = 0, notes = [];
const ok = (cond, msg, extra) => {
    if (cond) { pass++; console.log('  ok   ' + msg); }
    else { fail++; console.log('  FAIL ' + msg + (extra ? '\n         ' + extra : '')); }
};
const note = m => { notes.push(m); console.log('  note ' + m); };

// ── extract the three pieces from main.js ───────────────────────────
//  Brace matching from the signature, not a byte count: these functions are
//  mostly string literals and a fixed window silently stops covering the tail
//  the moment a line is added. Strings and comments are tracked so a `{` or a
//  `}` inside a PowerShell literal -- and there are many -- does not close the
//  function early.
function extract(src, sig) {
    const at = src.indexOf(sig);
    if (at < 0) throw new Error('not found: ' + sig);
    let i = src.indexOf('{', at + sig.length - 1), depth = 0;
    let q = null, inLine = false, inBlock = false;
    for (; i < src.length; i++) {
        const c = src[i], n = src[i + 1];
        if (inLine)  { if (c === '\n') inLine = false; continue; }
        if (inBlock) { if (c === '*' && n === '/') { inBlock = false; i++; } continue; }
        if (q) {
            if (c === '\\') { i++; continue; }
            if (c === q) q = null;
            //  `${` inside a template: the braces in there are code, but they
            //  balance, so counting nothing at all is correct.
            continue;
        }
        if (c === '/' && n === '/') { inLine = true; i++; continue; }
        if (c === '/' && n === '*') { inBlock = true; i++; continue; }
        if (c === '"' || c === "'" || c === '`') { q = c; continue; }
        if (c === '{') depth++;
        else if (c === '}' && --depth === 0) return src.slice(at, i + 1);
    }
    throw new Error('unbalanced: ' + sig);
}

const SRC_FORCE   = extract(MAIN, 'async function forceAllBrowsersOntoProxy(bypassList) {');
const SRC_RESTORE = extract(MAIN, 'async function restoreAllBrowsersProxy() {');
const SRC_BYPASS  = extract(MAIN, 'function bypassToProxyOverride(bypassList) {');
const SRC_BP      = (MAIN.match(/const BP_HOST = [^\n]*\nconst BP_IPV4 = [^\n]*/) || [''])[0];
//  With the `//` lines taken OUT, for every check that is about CODE. Six
//  comments in main.js name forceAllBrowsersOntoProxy() in prose, parentheses
//  and all -- searching the raw text for a zero-argument call finds one of
//  those sentences and reports a call site that does not exist.
const CODE = MAIN.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');

ok(SRC_FORCE.length > 800, 'forceAllBrowsersOntoProxy extracted whole',
   SRC_FORCE.length + ' chars');
ok(SRC_RESTORE.length > 600, 'restoreAllBrowsersProxy extracted whole',
   SRC_RESTORE.length + ' chars');
ok(/return \{ proxyChanged:/.test(SRC_FORCE),
   'and the extraction reaches its return statement (brace matching survived ' +
   'the PowerShell braces in between)');
ok(SRC_BP.length > 100 && SRC_BYPASS.length > 400,
   'the one bypassToProxyOverride() and its two regexes extracted');

// ── run them against a captured runPs1 ──────────────────────────────
const KEYS = [
    { id: 'edge',   name: 'Edge',   key: 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Edge' },
    { id: 'chrome', name: 'Chrome', key: 'HKLM:\\SOFTWARE\\Policies\\Google\\Chrome' },
    { id: 'brave',  name: 'Brave',  key: 'HKLM:\\SOFTWARE\\Policies\\BraveSoftware\\Brave' },
];

function build(reply) {
    const said = [];
    const sandbox = {
        Logger: {
            debug: () => {}, info: (m, x) => said.push(['info', m, x]),
            warn:  (m, x) => said.push(['warn', m, x]),
            error: (m, x) => said.push(['error', m, x]),
            success: (m, x) => said.push(['success', m, x]),
        },
        browsers: { policyRoots: (style, scope) => KEYS },
        captured: [],
        reply,
    };
    const fn = new Function('Logger', 'browsers', 'captured', 'reply', `
        ${SRC_BP}
        ${SRC_BYPASS}
        async function runPs1(ps, name, timeout) {
            captured.push({ ps, name, timeout });
            const r = reply(name, captured.length - 1);
            if (r instanceof Error) throw r;
            return r;
        }
        ${SRC_FORCE}
        ${SRC_RESTORE}
        return { forceAllBrowsersOntoProxy, restoreAllBrowsersProxy,
                 bypassToProxyOverride };
    `)(sandbox.Logger, sandbox.browsers, sandbox.captured, reply);
    return { fn, said, captured: sandbox.captured };
}

//  A reply that answers whatever the code under test asked for, honestly:
//  every key OK, changed=True.
const allOk = () =>
    KEYS.map(k => 'KEY_OK ' + k.key).join('\r\n') + '\r\n' +
    `PROXY_DONE ok=${KEYS.length} bad=0 changed=True`;
const allRestored = () =>
    KEYS.map(k => 'KEY_OK ' + k.key).join('\r\n') + '\r\n' +
    `RESTORE_DONE ok=${KEYS.length} bad=0`;

console.log('\n[1] the generated apply script');
const USER_LIST = 'example.com; 10.0.0.5 ,*.corp.local; bad host!; ' +
                  'x" /f & calc.exe; nl\nhost';
let h = build(() => allOk());
h.fn.forceAllBrowsersOntoProxy(USER_LIST);
//  Synchronous up to the first await, and runPs1 is reached before it, so the
//  script text is in hand already.
const PS_APPLY = (h.captured[0] || {}).ps || '';
ok(PS_APPLY.length > 500, 'a script was produced', PS_APPLY.length + ' chars');
ok(/\$ErrorActionPreference = 'Stop'/.test(PS_APPLY),
   "opens with $ErrorActionPreference = 'Stop'");
ok(!/\$ErrorActionPreference\s*=\s*'SilentlyContinue'/.test(PS_APPLY),
   'and NOT with SilentlyContinue -- a failed write cannot be swallowed');
ok(!/PROXY_OK/.test(PS_APPLY),
   'the unconditional PROXY_OK line is gone');
ok(/Write-Output \("PROXY_DONE ok=\$okKeys bad=\$badKeys/.test(PS_APPLY),
   'the verdict is printed FROM the counters, not from a literal');
ok(/\$okKeys\+\+/.test(PS_APPLY) && /\$badKeys\+\+/.test(PS_APPLY),
   'and both counters are only moved inside the comparison');

// the read-back itself
const SIX = ['ProxySettings', 'WebRtcIPHandlingPolicy', 'DnsOverHttpsMode',
             'BuiltInDnsClientEnabled', 'DnsPrefetchingEnabled',
             'NetworkPredictionOptions'];
for (const n of SIX) {
    ok(PS_APPLY.includes("'" + n + "'"), 'writes ' + n);
}
ok(/Get-ItemProperty -Path \$k -Name \$n -ErrorAction Stop/.test(PS_APPLY),
   'reads every written value back out of the registry, -ErrorAction Stop so ' +
   'a missing one is caught');
ok(/if \(\[string\]\$got -ne \[string\]\$want\[\$n\]\[0\]\)/.test(PS_APPLY),
   'and compares as strings, so a DWord that came back wrong is a MISMATCH ' +
   'and not a type coincidence');
ok(/MISMATCH/.test(PS_APPLY) && /": missing"/.test(PS_APPLY),
   'both failure shapes are distinguished in the output');
ok(/foreach \(\$n in \$want\.Keys\)/g.test(PS_APPLY) &&
   (PS_APPLY.match(/foreach \(\$n in \$want\.Keys\)/g) || []).length === 2,
   'the write loop and the read-back loop walk the SAME table, so they cannot ' +
   'disagree about what was asked for');
ok(/} catch {\r?\n\s*\$failed \+= \('write: '/.test(PS_APPLY),
   'the writes are in a per-key try/catch -- one locked hive does not cost ' +
   'the other browsers theirs');
ok(KEYS.every(k => PS_APPLY.includes(k.key)),
   'all three policy hives are in the key list');

console.log('\n[2] the split-tunnel list reaches Chromium');
const bp = h.fn.bypassToProxyOverride(USER_LIST);
const mProxy = /"ProxyBypassList":"([^"]*)"/.exec(PS_APPLY);
ok(!!mProxy, 'ProxyBypassList is present in the policy JSON');
const list = mProxy ? mProxy[1] : '';
ok(list !== 'localhost;127.0.0.1;<local>',
   'it is NOT the old hardcoded string that ignored the user',  list);
ok(list.split(';').includes('example.com') &&
   list.split(';').includes('*.example.com'),
   'a host the user listed is there, with its subdomain wildcard');
ok(list.split(';').includes('10.0.0.5'), 'an IPv4 literal is there');
ok(list.split(';').includes('corp.local') &&
   list.split(';').includes('*.corp.local'),
   'a *.host entry is normalised to the host + the wildcard');
ok(list.startsWith('localhost;127.0.0.1;'),
   'loopback is prepended unconditionally -- <local> covers dotless names, ' +
   'not the 127.0.0.1 literal, and this app\'s own WebSocket lives there');
ok(list.endsWith('<local>'), 'and <local> is still last');
ok(list === 'localhost;127.0.0.1;' + bp,
   'the whole value is exactly localhost;127.0.0.1; + bypassToProxyOverride() ' +
   '-- ONE mapping, so a host Windows bypasses is a host the browser bypasses',
   list);

console.log('\n[3] nothing hostile survives into the script');
ok(!/calc\.exe/.test(PS_APPLY),
   'the & calc.exe entry never reaches the script');
ok(!/bad host/.test(PS_APPLY), 'a name with a space in it is dropped');
ok(!list.includes('"') && !list.includes("'"),
   'no quote of either kind in the value -- it is interpolated into a ' +
   "single-quoted PowerShell string AND into a .bat elsewhere");
ok(!/[\r\n]/.test(list), 'no newline in the value');
ok(!/[&|^%<>]/.test(list.replace(/<local>/g, '')),
   'no cmd.exe metacharacter apart from the literal <local>');
ok(!/nl\s*host|nlhost/.test(PS_APPLY),
   'an entry containing a newline is dropped whole, not split into two hosts');
//  An empty list must still produce a valid, minimal value.
const h0 = build(() => allOk());
h0.fn.forceAllBrowsersOntoProxy('');
const list0 = (/"ProxyBypassList":"([^"]*)"/.exec(h0.captured[0].ps) || [])[1];
ok(list0 === 'localhost;127.0.0.1;<local>',
   'with no user list at all the value is the minimal safe one', list0);

console.log('\n[4] the JavaScript verdict follows the counters');
(async () => {
    // 4a. everything read back
    let t = build(() => allOk());
    let r = await t.fn.forceAllBrowsersOntoProxy('example.com');
    ok(t.said.some(([lvl, m]) => lvl === 'success' && /read back/.test(m)),
       'all keys verified -> success, and it says "read back"');
    ok(r.verified === 3 && r.expected === 3 && r.failed.length === 0,
       'and the return value carries the counts', JSON.stringify(r));

    // 4b. one hive refused
    t = build(() => 'KEY_OK ' + KEYS[0].key + '\r\n' +
                    'KEY_BAD ' + KEYS[2].key + ' -- WebRtcIPHandlingPolicy: missing\r\n' +
                    'PROXY_DONE ok=1 bad=1 changed=True');
    r = await t.fn.forceAllBrowsersOntoProxy('example.com');
    ok(!t.said.some(([lvl]) => lvl === 'success'),
       'one bad key -> NO success line');
    ok(t.said.some(([lvl, m]) => lvl === 'error' && /did NOT take on 1 of 3/.test(m)),
       'an error that counts them');
    ok(t.said.some(([lvl, m, x]) => lvl === 'error' && x && x.failed &&
                   x.failed.some(s => /Brave/.test(s))),
       'and NAMES the browser -- "some browsers are not on the proxy" is not ' +
       'something a user can act on');
    ok(/WebRtc/.test(JSON.stringify(r.failed)),
       'the specific value that failed is in the return too');

    // 4c. ok=bad=0 but fewer keys than expected: the loop did not run
    t = build(() => 'PROXY_DONE ok=0 bad=0 changed=False');
    r = await t.fn.forceAllBrowsersOntoProxy('example.com');
    ok(!t.said.some(([lvl]) => lvl === 'success'),
       'bad=0 with ok=0 over three keys is NOT success -- the loop never ran');

    // 4d. no verdict line at all
    t = build(() => 'some unrelated output\r\n');
    r = await t.fn.forceAllBrowsersOntoProxy('example.com');
    ok(!t.said.some(([lvl]) => lvl === 'success'),
       'no verdict line -> no success');
    ok(t.said.some(([lvl, m]) => lvl === 'error' && /NOT confirmed/.test(m)),
       'it is reported as an unknown outcome, not a success with a missing line');

    // 4e. the script itself threw
    t = build(() => new Error('Access is denied'));
    r = await t.fn.forceAllBrowsersOntoProxy('example.com');
    ok(t.said.some(([lvl, m]) => lvl === 'error' && /no Chromium/.test(m) &&
                   /Access is denied/.test(m)),
       'a thrown script is an error naming the reason, not a warn');
    ok(r.verified === 0, 'and nothing is claimed as verified', String(r.verified));

    console.log('\n[5] the restore script -- the recovery path');
    t = build(n => n === 'fp_browserproxy_off.ps1' ? allRestored() : allOk());
    await t.fn.restoreAllBrowsersProxy();
    const PS_OFF = t.captured[0].ps;
    ok(/\$ErrorActionPreference = 'Stop'/.test(PS_OFF),
       "opens with 'Stop' as well");
    ok(!/\$ErrorActionPreference\s*=\s*'SilentlyContinue'/.test(PS_OFF),
       'the blanket SilentlyContinue is gone from the restore too');
    ok(!/Write-Output 'RESTORE_OK'/.test(PS_OFF),
       'and so is the unconditional RESTORE_OK');
    ok(/Write-Output \("RESTORE_DONE ok=\$okKeys bad=\$badKeys"\)/.test(PS_OFF),
       'its verdict is printed from counters');
    ok(/if \(-not \(Test-Path \$k\)\) \{ \$okKeys\+\+; continue \}/.test(PS_OFF),
       'a key that never existed counts as clean -- that is the normal case ' +
       'for every browser the user does not have, not a failure');
    ok(/\$failed \+= \(\$n \+ ": STILL SET"\)/.test(PS_OFF),
       'the read-back for a removal is ABSENCE: a value that still answers is ' +
       'the failure');
    ok(/GeolocationAllowedForUrls: STILL PRESENT/.test(PS_OFF),
       'and the legacy force-allow key is checked for absence too');
    ok(SIX.every(n => PS_OFF.includes("'" + n + "'")),
       'all six values are removed');
    ok(t.said.some(([lvl, m]) => lvl === 'info' && /read back/.test(m)),
       'a clean restore logs info, and says it read back');

    // 5b. a value that would not go away
    t = build(() => 'KEY_BAD ' + KEYS[1].key + ' -- ProxySettings: STILL SET\r\n' +
                    'RESTORE_DONE ok=2 bad=1');
    await t.fn.restoreAllBrowsersProxy();
    const m5 = t.said.find(([lvl]) => lvl === 'error');
    ok(!!m5, 'a stuck ProxySettings is an ERROR, not a warn');
    ok(m5 && /lose internet access once Tor stops/.test(m5[1]),
       'and it says what the consequence is -- this is the one failure that ' +
       'can leave a browser with no network at all');
    ok(m5 && /Restore Internet/.test(m5[1]),
       'and what to do about it');
    ok(m5 && m5[2] && /Chrome/.test(JSON.stringify(m5[2].failed)),
       'naming the hive');

    // 5c. no verdict
    t = build(() => 'nothing\r\n');
    await t.fn.restoreAllBrowsersProxy();
    ok(t.said.some(([lvl, m]) => lvl === 'error' && /could NOT be fully reverted/.test(m)),
       'a missing verdict line is not treated as a clean revert');

    // ── 6. does PowerShell itself accept the two scripts? ────────────
    console.log('\n[6] PowerShell parses both scripts');
    let parsed = 0;
    for (const [label, text] of [['apply', PS_APPLY], ['restore', PS_OFF]]) {
        const f = path.join(os.tmpdir(), `fp-bp-${label}-${process.pid}.ps1`);
        fs.writeFileSync(f, text, 'utf8');
        try {
            //  The PARSER, not the script: nothing here is executed, the file
            //  is read as data. -Command over a temp file keeps the script out
            //  of the argument vector, where its quoting would be re-parsed.
            const out = execFileSync('powershell.exe',
                ['-NoProfile', '-NonInteractive', '-Command',
                 '$e=$null; [void][System.Management.Automation.Language.Parser]' +
                 `::ParseFile('${f}', [ref]$null, [ref]$e); ` +
                 'if ($e.Count) { $e | ForEach-Object { "ERR " + $_.Message } } ' +
                 'else { "PARSE_OK" }'],
                { encoding: 'utf8', windowsHide: true, timeout: 60000 });
            ok(/PARSE_OK/.test(out), `the ${label} script parses`,
               out.trim().slice(0, 300));
            if (/PARSE_OK/.test(out)) parsed++;
        } catch (e) {
            //  Not a pass and not a silent skip: say which.
            note(`powershell.exe could not be run to parse the ${label} ` +
                 `script (${String(e.message).split('\n')[0]}), so "it parses" ` +
                 'is NOT verified here');
        }
        try { fs.unlinkSync(f); } catch (e) {}
    }

    // ── 7. the call site passes the list ────────────────────────────
    console.log('\n[7] the call site');
    ok(/forceAllBrowsersOntoProxy\(\s*\n?\s*\(opts && opts\.bypass\) \|\| ''\)/.test(CODE),
       "the one call site passes opts.bypass -- the same raw string the WinINET " +
       'writer gets');
    ok((CODE.match(/await forceAllBrowsersOntoProxy\(/g) || []).length === 1,
       'and there is exactly one call site to keep in step');
    ok(!/forceAllBrowsersOntoProxy\(\)/.test(CODE),
       'no caller left invoking it with no arguments');
    ok(/\{ host: '127\.0\.0\.1', port, bypass: \(opts && opts\.bypass\) \|\| '' \}/.test(CODE),
       'and the Gecko descriptor beside it takes the same list, from the same ' +
       'place');

    console.log(`\n${pass} ok, ${fail} FAILED` +
                (notes.length ? `, ${notes.length} not verified` : ''));
    if (notes.length) notes.forEach(n => console.log('  not verified: ' + n));
    process.exit(fail ? 1 : 0);
})();
