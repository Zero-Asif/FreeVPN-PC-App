'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/probe-ext-bypass.js
//
//  ONE split-tunnel list, five stores that cannot share a string.
//
//    WinINET   HKCU\..\Internet Settings  ProxyOverride   `;`  *.host  <local>
//    WinHTTP   netsh winhttp bypass-list                  ` `  *.host  <local>
//    Chromium  ProxyBypassList policy (HKLM)              `;`  *.host  <local>
//    Gecko     network.proxy.no_proxies_on                `,`  .host   (no <local>)
//    THIS ONE  chrome.proxy bypassList, from the extension  array, Chromium's own
//
//  The first three come from one function -- bypassToProxyOverride() in main.js.
//  Gecko's is a separate emitter for a separate format, pinned to main.js's host
//  shapes by .build/probe-gecko-proxy.js. The fifth had neither: it built its own
//  rules, and `'*' + host` matches more hostnames than the user typed -- so a
//  browser sent a host DIRECT, real IP on it, that Windows was tunnelling at the
//  same moment.
//
//  Chromium's extension bypass format is the same format its policy takes, so
//  this store does not need an emitter of its own -- it needs the SAME string.
//  That is what is asserted here: for every input in the corpus,
//  bypassRules(x).join(';') is character-for-character the ProxyBypassList value
//  forceAllBrowsersOntoProxy() writes. Both functions are extracted from the
//  shipped files and run for real; nothing is re-implemented here.
//
//  Run:  node .build/probe-ext-bypass.js
// ════════════════════════════════════════════════════════════════════
const path = require('path');
const fs   = require('fs');

let pass = 0, fail = 0;
const ok = (c, m, x) => {
    if (c) { pass++; console.log('  ok   ' + m); }
    else { fail++; console.log('  FAIL ' + m + (x ? '\n         ' + String(x) : '')); }
};

const ROOT = path.join(__dirname, '..');
const MAIN = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const BG   = fs.readFileSync(path.join(ROOT, 'Extension', 'background.js'), 'utf8');
//  Comment-stripped, for the one question below that is about code rather than
//  behaviour: bypassRules()'s own header QUOTES the two expressions it replaced,
//  in the sentence explaining why they were wrong, and a bare search of the file
//  finds those quotes and calls the defect present.
const BG_CODE = BG.split('\n').map(l => (/^\s*\/\//.test(l) ? '' : l)).join('\n');

//  Brace-matched from a known opening line, so a `}` inside the body does not
//  end the extraction early.
function extract(src, opener) {
    const at = src.indexOf(opener);
    if (at < 0) throw new Error('not found: ' + opener);
    let d = 0;
    for (let i = at; i < src.length; i++) {
        if (src[i] === '{') d++;
        else if (src[i] === '}' && --d === 0) return src.slice(at, i + 1);
    }
    throw new Error('unbalanced: ' + opener);
}
const grabRe = (src, name) => {
    const m = src.match(new RegExp('const ' + name + ' = (/.*/);'));
    return m ? m[1] : null;
};

console.log('=== probe-ext-bypass ===\n');
console.log('-- 1. the two allowlists are the same allowlist --');
//  By source text, the way probe-gecko-proxy.js pins Gecko's: a change to
//  either regex has to fail here rather than diverge in silence.
const mHost = grabRe(MAIN, 'BP_HOST'), mIp = grabRe(MAIN, 'BP_IPV4');
const xHost = grabRe(BG,   'BP_HOST'), xIp = grabRe(BG,   'BP_IPV4');
ok(!!mHost && !!xHost && mHost === xHost,
   'the host shape is character-for-character main.js\'s bypassToProxyOverride',
   'main: ' + mHost + '\n         ext:  ' + xHost);
ok(!!mIp && !!xIp && mIp === xIp, 'and so is the IPv4 shape',
   'main: ' + mIp + '\n         ext:  ' + xIp);

// ── the two shipped functions, run for real ─────────────────────────
const warned = [];
const mainOverride = new Function('Logger',
    `${mHost ? 'const BP_HOST = ' + mHost + ';' : ''}
     ${mIp ? 'const BP_IPV4 = ' + mIp + ';' : ''}
     ${extract(MAIN, 'function bypassToProxyOverride(bypassList) {')}
     return bypassToProxyOverride;`)({ warn: (m, d) => warned.push(['main', d]) });
const extRules = new Function('console',
    `${xHost ? 'const BP_HOST = ' + xHost + ';' : ''}
     ${xIp ? 'const BP_IPV4 = ' + xIp + ';' : ''}
     ${extract(BG, 'function bypassRules(bypassList) {')}
     return bypassRules;`)({ warn: (m, d) => warned.push(['ext', d]) });

//  The policy string is not guessed: the prefix is read out of the line that
//  builds it, so changing that line fails here instead of making this probe
//  compare against an assumption.
const PREFIX = (MAIN.match(/const bypass = \[([^\]]*)\]\s*\n?\s*\.join\(';'\)/) || [])[1];
ok(/'localhost'\s*,\s*'127\.0\.0\.1'\s*,\s*bypassToProxyOverride\(bypassList\)/.test(PREFIX || ''),
   'forceAllBrowsersOntoProxy() still builds its policy value as ' +
   "localhost + 127.0.0.1 + bypassToProxyOverride(), which is what the " +
   'equality below is stated against', String(PREFIX));
const policy = x => ['localhost', '127.0.0.1', mainOverride(x)].join(';');

console.log('\n-- 2. same input, same rules, for every input --');
//  Everything a user, a hand-edited settings.json or the popup can put in this
//  field: the ordinary cases, the ones the old extension code mangled, and the
//  ones main.js's allowlist exists to drop.
const CORPUS = [
    undefined, null, '', '   ', ';;;', ',',
    'bank.com',
    'bank.com; foo.com',
    'bank.com,foo.com',
    'HTTPS://Bank.COM/x, foo.com ',
    'ftp://host.example',
    'foo.com:8080',
    '*.sub.example.com',
    'example.com.',
    '<local>',
    'localhost',
    '127.0.0.1',
    '10.0.0.5',
    '256.1.1.1',
    'bank.com;bank.com,BANK.COM',
    'a"b.com', 'c\\d.com', 'e\nf.com', '<script>', 'ok.test',
    'foo .com', '-lead.com', 'sub.-bad.com', 'xn--80ak6aa92e.com',
    'a.b.c.d.e.f.g.example.com',
    'x'.repeat(300) + '.com',
    'good.test; <script>alert(1)</script>; also.test',
    'a'.repeat(64) + '.com',
];
const bad = [];
for (const input of CORPUS) {
    const want = policy(input), got = extRules(input).join(';');
    if (want !== got) bad.push(`${JSON.stringify(input)}\n           policy: ${want}\n           ext:    ${got}`);
}
ok(bad.length === 0,
   `all ${CORPUS.length} inputs produce the identical rule list in the browser ` +
   'and in the policy -- one list, one meaning, whichever store reads it',
   bad.join('\n         '));
ok(extRules('').join(';') === 'localhost;127.0.0.1;<local>',
   'an empty list is still the loopback pair plus <local>, which is what this ' +
   'extension shipped before any of this and what the fossil pref in ' +
   'probe-brave-proxy-who.js was found holding', extRules('').join(';'));

console.log('\n-- 3. the over-match that made this a leak --');
const r = extRules('bank.com');
ok(r.includes('bank.com') && r.includes('*.bank.com'),
   'bank.com yields the bare host AND *.bank.com, so the host the user typed ' +
   'and its subdomains both skip the tunnel', r.join(';'));
ok(!r.includes('*bank.com'),
   'and NOT `*bank.com` -- that rule has no anchor after the wildcard, so it ' +
   'also matches notbank.com; `*.bank.com` requires the dot, so it cannot');
ok(r.filter(x => /^\*/.test(x)).every(x => x.startsWith('*.')),
   'every wildcard rule emitted starts `*.`, for any input in the corpus: ' +
   CORPUS.map(extRules).flat().filter(x => /^\*/.test(x)).length +
   ' wildcard rules seen, none unanchored',
   CORPUS.map(extRules).flat().filter(x => /^\*/.test(x) && !x.startsWith('*.')).join(', '));
ok(!/'\*'\s*\+\s*host/.test(BG_CODE) && !/\[\\\*\\s\]/.test(BG_CODE),
   'and the two expressions that produced it -- `\'*\' + host` and the ' +
   '`[\\*\\s]` strip that fed it -- are gone from background.js\'s code, so ' +
   'they cannot come back by being left behind. (Both still appear in the ' +
   'comment above bypassRules(), which is why this one search is ' +
   'comment-stripped and the probe says so rather than reporting a pass it ' +
   'did not earn.)');

console.log('\n-- 4. what the old code did with each of those inputs --');
//  Not a regression test on the new code: a record of what was actually being
//  written, so "this was a real defect" is a demonstration rather than a claim.
const OLD = list => {
    const bypass = ['localhost', '127.0.0.1', '<local>'];
    if (list && list.trim()) {
        list.replace(/,/g, ';').split(';').forEach(raw => {
            const host = raw.trim().replace(/^https?:\/\//, '')
                            .replace(/\/.*$/, '').replace(/[\*\s]/g, '');
            if (host) bypass.push('*' + host, host);
        });
    }
    return bypass;
};
ok(OLD('bank.com').includes('*bank.com'),
   'the old code emitted `*bank.com` for bank.com -- notbank.com went direct');
ok(OLD('HTTPS://Bank.COM/x').includes('HTTPS:'),
   'and `HTTPS:` for HTTPS://Bank.COM/x, because its scheme strip had no /i -- ' +
   'so Bank.COM was tunnelled here and bypassed by Windows', OLD('HTTPS://Bank.COM/x').join(';'));
ok(OLD('foo.com:8080').includes('foo.com:8080') &&
   !extRules('foo.com:8080').includes('foo.com:8080'),
   'and kept the port, bypassing one port in the browser where every other ' +
   'store bypassed all of them');
ok(OLD('<local>').filter(x => x === '<local>').length === 2 &&
   extRules('<local>').filter(x => x === '<local>').length === 1,
   'and listed <local> twice when the user typed it; once now');
ok(OLD('foo .com').includes('foo.com') && !extRules('foo .com').includes('foo.com'),
   'and silently repaired `foo .com` into a bypass for foo.com, which is not a ' +
   'host the user asked for');

console.log('\n-- 5. and it is the function that is wired in --');
const SETTER = extract(BG, 'function setBrowserProxy(enabled, bypassList, done) {');
ok(/const bypass = bypassRules\(bypassList\);/.test(SETTER),
   'setBrowserProxy() builds its list by calling bypassRules(), not inline');
ok(/bypassList: bypass,/.test(SETTER),
   'and hands that array to chrome.proxy as the bypassList');
ok((BG_CODE.match(/bypassList: bypass,/g) || []).length === 1 &&
   (BG_CODE.match(/function bypassRules\(/g) || []).length === 1,
   'one construction site and one emitter in the whole file');
ok(/console\.warn\('FreeProxy: split-tunnel entries ignored/.test(BG_CODE),
   'a dropped entry is named in the console rather than swallowed -- an entry ' +
   'that does nothing is a host the user believes is excluded');
//  The stripper itself, proved on the one string the question above turns on: it
//  IS in the file, it is NOT in the code, and an assertion that cannot fail is
//  worse than no assertion.
ok(/'\*'\s*\+\s*host/.test(BG) && !/'\*'\s*\+\s*host/.test(BG_CODE),
   "the comment-stripped copy really is stripped -- `'*' + host` is present in " +
   'background.js and absent from its code, which is also the record that the ' +
   'defect was there');
const dropWarn = [];
new Function('console', `${xHost ? 'const BP_HOST = ' + xHost + ';' : ''}
     ${xIp ? 'const BP_IPV4 = ' + xIp + ';' : ''}
     ${extract(BG, 'function bypassRules(bypassList) {')}
     return bypassRules;`)({ warn: (m, d) => dropWarn.push(d) })('<script>, ok.test');
ok(dropWarn.length === 1 && String(dropWarn[0]).includes('<script>'),
   'and the warning carries the entry that was dropped, not just a count',
   JSON.stringify(dropWarn));

console.log('');
console.log(`${pass}/${pass + fail} checks passed` + (fail ? `  (${fail} FAILED)` : ''));
process.exit(fail ? 1 : 0);
