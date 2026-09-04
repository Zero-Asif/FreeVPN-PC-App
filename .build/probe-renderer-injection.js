'use strict';
// ════════════════════════════════════════════════════════════════════
//  probe-renderer-injection.js -- the app window's own markup, 2.0.5.
//
//  This window runs with nodeIntegration: true and contextIsolation: false,
//  which is what lets renderer.js call ipcRenderer and shell directly, and it
//  is not changing -- the whole UI is built on it. What that costs is that
//  every innerHTML in renderer.js is one step from the Node API, so the rule
//  has to be that nothing which is not app-authored reaches one.
//
//  Two places broke that rule before 2.0.5, and the interesting part is where
//  the input comes from:
//
//   1. refreshLogContent() put raw log lines into innerHTML. A log line is not
//      app-authored: Logger's metadata carries the Origin header of a refused
//      WebSocket handshake and the split-tunnel entries the sanitiser dropped,
//      and UPDATE_BYPASS is reachable by any local process that opens
//      ws://127.0.0.1:8080 with no Origin header -- which is allowed on
//      purpose, because that is how the extension's own service worker
//      presents itself. So an unprivileged local user could choose a string,
//      put it in the log, and wait for "View Logs".
//
//   2. getFlagImg() pattern-checked the code it put in the <img src=, and then
//      used the RAW argument for the badge text and the title="" attribute.
//      ccName() returned its input unchanged for anything Intl.DisplayNames
//      did not recognise, into nine innerHTML sites. Both are fed country
//      codes that come from onionoo over the network.
//
//  What the CSP already stopped, so that this probe does not claim more than
//  it should: index.html is script-src 'self' file: with no 'unsafe-inline',
//  so no injected onerror=/javascript: runs and no injected <script> executes
//  from innerHTML at all. What it does NOT stop is style-src 'unsafe-inline',
//  and a <div style="position:fixed;inset:0"> from a log line covers the
//  window a user reads their connection state in. That is the hole that was
//  worth closing, and section 4 shows it closed.
//
//  Nothing here starts Electron. The functions are extracted from renderer.js
//  by brace matching and run against a stub DOM, so what is under test is the
//  shipped source and not a copy of it.
//
//  Two things this probe learned about ITSELF, recorded because both were
//  failures in the direction that reports success:
//
//   * a line-based scan of the innerHTML sites cannot see a template that opens
//     on one line and closes four later, and a line-based allowlist excuses
//     `${message}` because `${icons[type]}` is on the same line. Section 5 is
//     statement-based and checks one substitution at a time.
//   * an on*= regex run over the whole output reports the payload's own text as
//     an attribute. ` onmouseover=` is IN the payload with no quote between the
//     space and the `=`, so escaping cannot remove that substring and should
//     not: escaping's job is to put it in TEXT. Only what ends up inside a tag
//     can be an attribute, so that is what hasHandler() looks at -- and it is
//     shown failing on a real break-out before its silence is trusted.
//
//  Section 5b is the other half of the same question: showToast() puts its
//  message into innerHTML unescaped ON PURPOSE, because half the toasts carry
//  <strong>, a <br> or an <a>. That makes "app-authored HTML" a contract, and
//  the contract is checked at all 22 call sites rather than asserted in prose.
//
//  Section 8 follows the same country code the other way. A code that cannot
//  reach a <span> can still reach the torrc, whose ExitNodes line is
//  line-oriented, and a CDP geolocation override -- and 'constructor' passed the
//  old `if (!GEO_COORDS[cc])` gate on Object.prototype alone.
//
//  Run:  node .build/probe-renderer-injection.js
// ════════════════════════════════════════════════════════════════════

const fs   = require('fs');
const path = require('path');

const ROOT_DIR = path.join(__dirname, '..');
const RENDERER = fs.readFileSync(path.join(ROOT_DIR, 'renderer.js'), 'utf8');
const MAIN     = fs.readFileSync(path.join(ROOT_DIR, 'main.js'), 'utf8');
const INDEX    = fs.readFileSync(path.join(ROOT_DIR, 'index.html'), 'utf8');
//  Both files with the `//` lines taken OUT, for every assertion that is about
//  CODE. This probe's own source comments quote `callback(true)` and
//  `setPermissionCheckHandler(() => true)` verbatim in main.js, and main.js
//  names forceAllBrowsersOntoProxy() in prose six times -- searching the raw
//  text for a shape that only appears in a sentence reports a call site that
//  does not exist. Same mistake, twice, in two probes; hence this line.
const stripComments = s =>
    s.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
const MAIN_CODE = stripComments(MAIN);
const REND_CODE = stripComments(RENDERER);

let pass = 0, fail = 0;
const ok = (cond, msg, extra) => {
    if (cond) { pass++; console.log('  ok   ' + msg); }
    else { fail++; console.log('  FAIL ' + msg + (extra ? '\n         ' + extra : '')); }
};

//  Same brace matcher as probe-browser-policy.js, and for the same reason:
//  these functions are mostly string literals with braces inside them.
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

//  Up to the closing `[c]));`, not to a blank line: renderer.js is CRLF, so a
//  `\n\n` in the pattern never matches anything in it.
const SRC_ESC   = (RENDERER.match(/const esc = s => String\(s\)[\s\S]*?\[c\]\)\);/) || [''])[0];
const SRC_FLAG  = extract(RENDERER, 'function getFlagImg(code) {');
const SRC_NAME  = extract(RENDERER, 'function ccName(code) {');
const SRC_LOG   = extract(RENDERER, 'async function refreshLogContent(level = \'ALL\') {');

ok(SRC_ESC.includes('&amp;') && SRC_ESC.includes('&lt;'),
   'esc() extracted from renderer.js');
ok(SRC_FLAG.length > 300 && SRC_NAME.length > 100 && SRC_LOG.length > 400,
   'getFlagImg, ccName and refreshLogContent extracted');

// ── the payloads ────────────────────────────────────────────────────
//  Each of these is something the source it stands for could actually carry.
const PAYLOADS = [
    //  A full-window overlay: the one thing style-src 'unsafe-inline' still
    //  allows, and the reason this matters at all.
    '<div style="position:fixed;inset:0;z-index:99999;background:#0b1220">CONNECTED</div>',
    //  Script, in the four shapes innerHTML is asked about. All four are
    //  already dead by CSP; they are here so that a future CSP change cannot
    //  quietly re-open them without this probe noticing.
    '<img src=x onerror="require(\'child_process\').exec(\'calc\')">',
    '<svg/onload=alert(1)>',
    '<script>alert(1)</script>',
    '<a href="javascript:alert(1)">x</a>',
    //  Attribute break-out, for the title="" and class="" sites.
    'x" onmouseover="alert(1)" y="',
    "x' onmouseover='alert(1)' y='",
    //  And the plain ones.
    '</div><div>', '&<>"\'', '<iframe src=x>', '<form action=x>',
];
//  Every tag renderer.js is entitled to emit into these three sinks. Anything
//  else in the output came from the payload. No entity handling is needed for
//  this one: `&lt;script&gt;` holds no `<` character at all, so an escaped tag
//  is already not a tag as far as TAG_RE is concerned.
const TAG_RE = /<\/?([a-z0-9]+)/gi;
const ALLOWED_TAGS = new Set(['div', 'span', 'strong', 'img']);
function foreignTags(html) {
    const out = new Set();
    let m;
    TAG_RE.lastIndex = 0;
    while ((m = TAG_RE.exec(String(html)))) {
        if (!ALLOWED_TAGS.has(m[1].toLowerCase())) out.add(m[1].toLowerCase());
    }
    return [...out];
}
//  An event-handler attribute anywhere in the output is a failure even under
//  the CSP: the CSP is the second line, not the first. But an attribute only
//  exists INSIDE a tag, so that is the only place worth scanning -- and this is
//  not a refinement, it is the difference between measuring the defence and
//  measuring the payload.
//
//  `x" onmouseover="alert(1)" y="` contains the literal bytes ` onmouseover=`
//  with no quote between them. No amount of escaping removes that substring
//  from the output and none should: escaping's whole job is to make the payload
//  land as TEXT, and text that reads ` onmouseover=` is a log line the user can
//  read, not an attribute. What escaping actually takes away is the payload's
//  ability to CLOSE the app's own attribute -- so what has to be inspected is
//  what ended up inside the app's tags.
//
//  A real break-out is still caught. An unescaped title="${p}" would emit
//  <span title="x" onmouseover="alert(1)" y=""> and everything up to that
//  first `>` is one tag body, handler and all.
const HANDLER_RE = /\son[a-z]+\s*=/i;
const tagBodies = html => String(html).match(/<[^>]*>/g) || [];
const hasHandler = html => tagBodies(html).some(t => HANDLER_RE.test(t));

// ── 1. esc() itself ─────────────────────────────────────────────────
console.log('\n[1] esc()');
const esc = new Function(`${SRC_ESC} return esc;`)();
ok(esc('<b>') === '&lt;b&gt;', 'escapes angle brackets');
ok(esc('a&b') === 'a&amp;b', 'escapes the ampersand -- and FIRST, so &lt; ' +
   'cannot be produced by escaping a literal &amp;lt;');
ok(esc('"') === '&quot;' && esc("'") === '&#39;',
   'escapes both quote characters, so an attribute cannot be closed');
ok(esc(undefined) === 'undefined' && esc(null) === 'null' && esc(7) === '7',
   'does not throw on a non-string -- a log line is whatever Logger wrote');
ok(esc('&lt;script&gt;') === '&amp;lt;script&amp;gt;',
   'double-escaping is visible rather than executable');

// ── 2. getFlagImg ───────────────────────────────────────────────────
console.log('\n[2] getFlagImg(code) -- country codes arrive from onionoo');
const getFlagImg = new Function(`${SRC_FLAG} return getFlagImg;`)();
ok(/vendor\/flags\/lu\.svg/.test(getFlagImg('lu')), 'a real code still works');
ok(/title="LU"/.test(getFlagImg('LU')), 'and is still shown uppercase');
ok(getFlagImg('lu').includes('>LU<') || />LU</.test(getFlagImg('lu')),
   'the drawn badge still carries the letters');
let flagBad = [];
for (const p of PAYLOADS) {
    const html = getFlagImg(p);
    const t = foreignTags(html);
    if (t.length || hasHandler(html) || html.includes(p)) flagBad.push(p.slice(0, 30));
}
ok(flagBad.length === 0,
   'every one of the ' + PAYLOADS.length + ' payloads is refused -- no foreign ' +
   'tag, no on*= attribute, and the payload does not appear in the output at all',
   flagBad.join(' | '));
ok(/title="\?\?"/.test(getFlagImg('<img src=x>')),
   'an unusable code renders as ?? -- the badge is drawn from the VALIDATED ' +
   'code now, not from the raw argument');
ok(getFlagImg('').includes('??') && !getFlagImg('').includes('.svg'),
   'and an empty code draws no <img> at all');

// ── 3. ccName / ccLabel ─────────────────────────────────────────────
console.log('\n[3] ccName(code) -- interpolated into nine innerHTML sites');
const SRC_LABEL = (RENDERER.match(/const ccLabel = [^\n]*/) || [''])[0];
const ccMod = new Function(
    'regionNames',
    `${SRC_NAME}\n${SRC_LABEL}\n return { ccName, ccLabel };`)(
        new Intl.DisplayNames(['en'], { type: 'region' }));
const ccName  = ccMod.ccName;
const ccLabel = ccMod.ccLabel;
ok(ccName('lu') === 'Luxembourg', 'a real code still resolves to its name');
ok(ccName('LU') === 'Luxembourg', 'case does not matter');
let nameBad = PAYLOADS.filter(p => ccName(p) !== '');
ok(nameBad.length === 0,
   'and every payload returns the empty string rather than itself -- ' +
   'Intl.DisplayNames returns its INPUT for a code it does not know, which is ' +
   'why the old catch-block fallback was never the path that mattered',
   nameBad.map(s => s.slice(0, 24)).join(' | '));
ok(ccName('zzz') === '' && ccName('z') === '' && ccName(null) === '',
   'anything that is not two letters is not a country');

//  ccLabel() is what the six former copies of the regionNames.of() fallback
//  were replaced with. It exists so the label beside getFlagImg() can never be
//  the raw code, and it has to agree with getFlagImg's own fallback.
ok(!!SRC_LABEL, 'ccLabel extracted from renderer.js', SRC_LABEL);
ok(ccLabel('lu') === 'Luxembourg', 'ccLabel names a real country');
let labelBad = PAYLOADS.filter(p => ccLabel(p) !== '??');
ok(labelBad.length === 0,
   'and every payload comes back as the literal ?? -- the same thing ' +
   'getFlagImg draws for that input, so the two halves of one label agree',
   labelBad.map(s => s.slice(0, 24)).join(' | '));
ok(ccLabel(undefined) === '??' && ccLabel('') === '??' && ccLabel('zzz') === '??',
   'and so does anything else that is not two letters');
//  The six sites themselves: none of them may hold its own copy any more.
const rawFallback = (REND_CODE.match(/regionNames\.of\(/g) || []).length;
ok(rawFallback === 1,
   'regionNames.of( appears exactly ONCE in renderer.js code -- inside ' +
   'ccName. There were seven copies of it, six of them writing the raw code ' +
   'into innerHTML when Intl.DisplayNames did not recognise it',
   'found ' + rawFallback);
ok(!/=\s*\w+\.toUpperCase\(\);\s*\n\s*try \{ \w+\s*=\s*regionNames/.test(REND_CODE),
   'and the `let n = code.toUpperCase(); try { n = regionNames.of(...) }` ' +
   'shape is gone from the file entirely');

// ── 4. refreshLogContent ────────────────────────────────────────────
console.log('\n[4] refreshLogContent() -- the log viewer');
async function renderLog(lines) {
    const el = { innerHTML: '', textContent: '', scrollTop: 0, scrollHeight: 0 };
    const pathEl = { textContent: '' };
    const document = { getElementById: id => id === 'log-content' ? el : pathEl };
    const ipcRenderer = { invoke: async () => ({ lines, logFile: 'C:\\x\\app.log' }) };
    const fn = new Function('document', 'ipcRenderer', 'esc',
        `${SRC_LOG} return refreshLogContent;`)(document, ipcRenderer, esc);
    await fn('ALL');
    return el.innerHTML;
}

(async () => {
    const good = await renderLog([
        '2026-09-04 10:00:00 [SUCCESS] Connected, 100% bootstrapped',
        '2026-09-04 10:00:01 [ERROR  ] failed to bind',
    ]);
    ok(/<strong>100%<\/strong>/.test(good),
       'the % highlight still works');
    ok(/color:#4ade80[^>]*>SUCCESS</.test(good), 'the SUCCESS highlight still works');
    //  `>fail<`, not `>failed<`. The app's own highlight regex is
    //  /(ERROR|FAIL|failed)/gi and alternation is ORDERED, so at the word
    //  "failed" the branch FAIL matches first and the output is
    //  `>fail</span>ed`. A pre-existing cosmetic quirk of the highlighter,
    //  named here rather than quietly matched around, because a probe that
    //  asserts what the code does NOT do is the thing that fails next time
    //  somebody fixes it.
    ok(/color:#f87171[^>]*>fail</.test(good), 'and the failure highlight');
    ok(/class="log-line ERROR"/.test(good) && /class="log-line SUCCESS"/.test(good),
       'and the per-level class is still assigned off the raw line');

    let logBad = [];
    //  The two scanners prove they can fail before anything is concluded from
    //  their silence.
    ok(hasHandler('<span title="x" onmouseover="alert(1)" y="">??</span>'),
       'the tag-body scanner DOES catch a real attribute break-out');
    ok(!hasHandler('<div class="log-line WARN">dropped: ' +
                   'x&quot; onmouseover=&quot;alert(1)&quot;</div>'),
       'and does NOT count the same bytes as an attribute when they are ' +
       "escaped text between two of the app's own tags");
    ok(foreignTags('<div>&lt;script&gt;x&lt;/script&gt;</div>').length === 0 &&
       foreignTags('<div><script>x</script></div>').join() === 'script',
       'and the tag scanner tells an escaped tag from a real one');
    for (const p of PAYLOADS) {
        const html = await renderLog(['2026-09-04 10:00:00 [WARN   ] dropped: ' + p]);
        const t = foreignTags(html);
        //  The payload text SHOULD appear -- escaped. What must not appear is a
        //  tag or a handler that came from it.
        if (t.length || hasHandler(html)) logBad.push(p.slice(0, 34) + ' -> ' + t.join(','));
        if (html.includes(p)) logBad.push('VERBATIM: ' + p.slice(0, 34));
    }
    ok(logBad.length === 0,
       'every payload survives as visible TEXT and none of it as markup',
       logBad.join('\n         '));

    const shown = await renderLog(['x [WARN   ] dropped: <div style="position:fixed">hi</div>']);
    ok(shown.includes('&lt;div style=&quot;position:fixed&quot;&gt;'),
       'the overlay attempt is rendered as text the user can actually read -- ' +
       'which is the point of a log viewer');
    ok(!/<div style="position:fixed/.test(shown),
       'and not as an overlay');

    //  The order of the two operations, which is the only way to get this
    //  wrong while still using esc(): highlight-then-escape would turn the
    //  app's own <strong> into text and leave the payload alone.
    ok(/const hl = esc\(line\)/.test(SRC_LOG),
       'esc() is applied to the line BEFORE the highlight regexes, not after');
    ok(!/const hl = line\s*\n/.test(SRC_LOG),
       'and the raw line is not what gets highlighted');
    ok(/\$\{esc\(e\.message\)\}/.test(SRC_LOG),
       'the catch branch escapes its error message too');

    // ── 5. no unescaped sink left in renderer.js ─────────────────────
    console.log('\n[5] the remaining innerHTML sites in renderer.js');
    //  STATEMENTS, not lines, and one check per SUBSTITUTION rather than one
    //  per line. Both of those were wrong here before, and both were wrong in
    //  the direction that reports success:
    //
    //    * `toast.innerHTML = \`` opens a template that closes four lines
    //      later. A line-based scan sees a line with no `${` in it and passes
    //      the sink whose input is showToast's `message`.
    //    * a line-based allowlist passes the WHOLE line as soon as one safe
    //      producer appears on it, so `${icons[type]}` excused `${message}`
    //      sitting three characters away.
    const codeLines = RENDERER.split('\n').map(l => (/^\s*\/\//.test(l) ? '' : l));
    //  Accumulate until the backticks balance AND a `;` has been seen -- which
    //  is the end of the statement for all three shapes in this file: the plain
    //  line, the multi-line template, and the `+`-continued concatenation.
    const statementAt = i => {
        let text = '', ticks = 0;
        for (let j = i; j < codeLines.length && j < i + 12; j++) {
            text += (j > i ? '\n' : '') + codeLines[j];
            ticks += (codeLines[j].match(/`/g) || []).length;
            if (ticks % 2 === 0 && /;\s*$/.test(codeLines[j])) break;
        }
        return text;
    };
    //  Brace-MATCHED, so a `}` inside a substitution -- `${icons[type]||'x'}`,
    //  `${(restart||[]).length > 1 ? 'them' : 'it'}` -- does not end it early.
    function subsOf(s) {
        const out = [];
        for (let i = 0; i < s.length - 1; i++) {
            if (s[i] === '$' && s[i + 1] === '{') {
                let d = 0;
                for (let j = i + 1; j < s.length; j++) {
                    if (s[j] === '{') d++;
                    else if (s[j] === '}' && --d === 0) { out.push(s.slice(i + 2, j)); i = j; break; }
                }
            }
        }
        return out;
    }
    //  String literals removed, so `'<a>' + '</a>'` -- two static literals with
    //  nothing flowing in -- is not read as a concatenation with an operand.
    const stripLiterals = l => l
        .replace(/`(?:[^`\\]|\\.)*`/g, '``')
        .replace(/'(?:[^'\\]|\\.)*'/g, "''")
        .replace(/"(?:[^"\\]|\\.)*"/g, '""');
    const operandsOf = s =>
        (stripLiterals(s).match(/\+\s*([A-Za-z_$][\w.$]*)/g) || [])
            .map(m => m.replace(/^\+\s*/, ''));
    //  Every input this probe has followed to a producer that closes it. Each
    //  one is checked on its own below or in [5b]; being on this list is a
    //  claim about where it comes from, not a decision to ignore it.
    //
    //    getFlagImg(...)  two-letter code or ??, checked in [2]
    //    esc(...)         escaped, checked in [1]
    //    icons[type]      a four-literal table keyed by an app-authored status
    //    name / cName     ccName()/ccLabel(), checked in [3] and just below
    //    cls / label      four status-* literals and a count from the app's own
    //                     aggregation (lib/exit-selector.js: count = list.length)
    //    badge            a literal <span> or ''
    //    message          showToast's contract -- its 22 call sites are [5b]
    //    hl / lvl / line  refreshLogContent, exercised for real in [4]
    const VETTED = new Set(['getFlagImg(code)', 'getFlagImg(currentServer)',
        'getFlagImg(serverValue)', 'getFlagImg(ask.cc)', 'esc(e.message)',
        "icons[type]||'ℹ️'", 'name', 'cName', 'cls', 'label', 'badge',
        'message', 'hl', 'lvl']);
    const sinks = [];
    codeLines.forEach((l, i) => {
        if (!/\.innerHTML\s*(=|\+=)/.test(l)) return;
        const st = statementAt(i);
        sinks.push({ line: i + 1, st,
                     inputs: subsOf(st).concat(operandsOf(st)) });
    });
    ok(sinks.length === 13,
       `there are ${sinks.length} innerHTML sites, and 13 is the number this ` +
       'probe was written against -- a new one is a deliberate review, not a ' +
       'silent addition',
       sinks.map(s => s.line).join(','));
    //  Prove the extractor can fail before trusting that it did not.
    ok(subsOf('x.innerHTML = `<b>${raw}</b>`;').join() === 'raw' &&
       subsOf('x = `${a[b]||"c"}${d}`').join() === 'a[b]||"c",d',
       'the substitution extractor finds a ${} and does not stop at a } inside one');
    ok(operandsOf("x.innerHTML = '<b>' + raw + '</b>';").join() === 'raw' &&
       operandsOf("x.innerHTML = '<a>' + '</a>';").length === 0,
       'and the concatenation test fires on a raw operand but not on two ' +
       'static literals -- the false positive this check was rewritten to remove');
    ok(sinks.some(s => s.line === 564 && s.inputs.includes('message')),
       "the multi-line toast template IS one of them -- a line-based scan " +
       'passed it because its own line holds no ${',
       JSON.stringify((sinks.find(s => s.line === 564) || {}).inputs));
    const unvetted = sinks.flatMap(s =>
        s.inputs.filter(v => !VETTED.has(v)).map(v => s.line + ': ' + v));
    ok(unvetted.length === 0,
       'and every value that reaches one of the 13 has a producer this probe ' +
       'has followed',
       unvetted.join('\n         '));
    //  Two sinks interpolate a bare identifier that the line above decides.
    //  The allowlist above passes them on the strength of getFlagImg being on
    //  the same line, so the identifier itself is checked here instead of
    //  taken on trust.
    ok(/const name = ccName\(code\);\s*\n\s*if \(!name\) return;/.test(REND_CODE),
       "the dropdown row's `name` is ccName(code) and the row is SKIPPED when " +
       'it comes back empty -- which is also what makes the ' +
       'li[data-value="${code}"] selector three lines down safe');
    //  setFlag() is `getFlagImg(code) + ' ' + name` -- the one sink whose two
    //  halves come from two different arguments, so they are the pair that can
    //  disagree. Split on lines rather than matching `setFlag(` in the whole
    //  file: the DEFINITION reads `function setFlag(code, name)`, and a regex
    //  for the call shape captures `setFlag(code, name)` out of it without the
    //  word `function`, which is how this check first reported its own
    //  declaration as a third call site passing a raw `name`.
    const setFlagCalls = REND_CODE.split('\n')
        .map(l => l.trim())
        .filter(l => /\bsetFlag\(/.test(l) && !/function setFlag/.test(l));
    ok(setFlagCalls.length === 2 &&
       setFlagCalls.every(l => /setFlag\((?:serverValue|newCode), (?:n|cName)\)/.test(l)),
       'setFlag() has two call sites and both pass a ccLabel() result',
       setFlagCalls.join(' | '));
    ok(/function setFlag\(code, name\) \{\s*\n\s*if \(st\) st\.innerHTML = getFlagImg\(code\) \+ ' ' \+ name;/
        .test(REND_CODE),
       'and its body is getFlagImg(code) + name, so those two call sites are ' +
       'the whole of its input');
    ok(/const n = ccLabel\(serverValue\);\s*\n\s*setFlag\(serverValue, n\)/.test(REND_CODE) &&
       /const cName = ccLabel\(newCode\);\s*\n\s*setFlag\(newCode, cName\)/.test(REND_CODE),
       'each of them assigns from ccLabel() on the line immediately above, so ' +
       'there is nothing in between that could reassign it');
    ok((REND_CODE.match(/=\s*ccLabel\(/g) || []).length === 6,
       'and ccLabel() is called at exactly the six sites that used to carry ' +
       'their own copy',
       String((REND_CODE.match(/=\s*ccLabel\(/g) || []).length));
    //  The dropdown row's other three inputs, since the list above only claims
    //  where they come from.
    const clsSet = (REND_CODE.match(/cls='([^']*)'/g) || []);
    ok(clsSet.length === 4 && clsSet.every(s => /cls='status-(fast|busy|slow)'/.test(s)),
       'the row\'s `cls` is only ever one of the status-* literals -- it lands ' +
       'in a class="" attribute',
       clsSet.join(' '));
    ok(/label='Connected ✓'/.test(REND_CODE) &&
       (REND_CODE.match(/label=exits/g) || []).length === 3 &&
       /const exits = count === 1 \? '1 exit' : `\$\{count\} exits`/.test(REND_CODE),
       'and `label` is that one literal or `${count} exits`, where count is ' +
       "the app's own aggregate (lib/exit-selector.js: count = list.length), " +
       'not a string from onionoo');
    ok(/const badge = \(fastData && code===fastData\.best\) \? `<span class="fastest-badge" title="[^"$`]*">BEST<\/span>` : ''/
        .test(REND_CODE),
       'and `badge` is a literal <span> -- title attribute included, no ${} in ' +
       'it -- or the empty string');

    // ── 5b. showToast(message) -- the contract, and its call sites ────
    console.log('\n[5b] showToast(message) -- 23 call sites, one innerHTML');
    //  showToast puts `message` into innerHTML unescaped, on purpose: half the
    //  toasts in this app carry <strong>, a <br> or the "Open the setup folder"
    //  <a>, so escaping at the sink would turn every one of them into visible
    //  tag soup. That makes "message is app-authored HTML" a CONTRACT, and a
    //  contract nothing checks is a comment. So it is checked here, at all 23
    //  call sites, per interpolated value.
    ok(/toast\.innerHTML = `[\s\S]{0,200}\$\{message\}/.test(REND_CODE),
       'the sink is still `${message}` in a template -- unescaped, which is ' +
       'why the call sites are the check');
    //  Every value that any of the 23 puts inside that HTML, with where it is
    //  closed. Each entry is asserted below; the set exists so that a NEW
    //  interpolation in a toast fails this probe instead of shipping.
    //
    //    x.name / x.askedName  ccName() in resolveExit
    //    x.ip (inside ipNote)  ipv4Only() -- a strict dotted quad
    //    Verb / verb           'connected' or 'switched', from announceExit's
    //                          three call sites
    //    dnsNote               a literal or ''
    //    city / country        main.js: coord.city from GEO_COORDS and a code
    //                          geoCoord() has already accepted, on a channel
    //                          only the main process can send on
    //    *Who / auto           browsers.names() -- ids filtered against the
    //                          app's own table, mapped to its own labels
    //    folder / covered      a literal <a> and a literal sentence
    //    cName / prevName      ccLabel()
    //    kind / detail         the ONE toast whose text this app did not word:
    //                          an Error's own message, or Electron's exit
    //                          reason, arriving on 'app-fault'. Both are esc()d
    //                          at the call site -- asserted separately below,
    //                          because for these two the producer is the escape
    const TOAST_OK = new Set(['x.askedName', 'x.name', 'x.ip', 'ipNote', 'dnsNote',
        'verb', 'Verb', 'city', 'country', 'enableWho', 'restartWho', 'manualWho',
        'covered', 'folder', 'cName', 'prevName', 'kind', 'detail',
        "(restart || []).length > 1 ? 'them' : 'it'"]);
    const callAt = i => {
        const text = codeLines.slice(i, i + 10).join('\n');
        const at = text.indexOf('showToast(');
        let d = 0;
        for (let j = at + 9; j < text.length; j++) {
            if (text[j] === '(') d++;
            else if (text[j] === ')' && --d === 0) return text.slice(at, j + 1);
        }
        return text.slice(at);
    };
    const toasts = [];
    codeLines.forEach((l, i) => {
        if (!/\bshowToast\(/.test(l) || /function showToast/.test(l)) return;
        const c = callAt(i);
        toasts.push({ line: i + 1, inputs: subsOf(c).concat(operandsOf(c)) });
    });
    ok(toasts.length === 23,
       `there are ${toasts.length} showToast call sites, and 23 is the number ` +
       'this probe was written against', toasts.map(t => t.line).join(','));
    const badToast = toasts.flatMap(t =>
        t.inputs.filter(v => !TOAST_OK.has(v)).map(v => t.line + ': ' + v));
    ok(badToast.length === 0,
       'and every value any of them interpolates into that HTML has a producer ' +
       'this probe has followed',
       badToast.join('\n         '));
    ok(toasts.filter(t => t.inputs.length).length === 12,
       'twelve of the 23 interpolate anything at all; the other eleven are ' +
       'literal', String(toasts.filter(t => t.inputs.length).length));
    //  The 'app-fault' toast, separately: main.js has been sending on that
    //  channel since reportFault() was written -- uncaught exception, unhandled
    //  rejection, dead renderer, dead utility child, tunnel that would not
    //  start -- and until 2.0.5 nothing in this file listened, so every send
    //  landed nowhere while the comment above reportFault() said each fault was
    //  "logged AND sent to the window".
    //
    //  It is also the one toast whose text this app did not word: an Error's
    //  `message` is whatever the throwing code put in it. So both halves must
    //  be esc()d at the call site, and `detail` must not reach the template by
    //  any other route.
    const faultBlock = (REND_CODE.match(
        /ipcRenderer\.on\('app-fault'[\s\S]*?\n\}\);/) || [''])[0];
    ok(faultBlock.length > 0, "renderer.js listens on 'app-fault' at all");
    ok(/const kind\s*=\s*esc\(/.test(faultBlock) &&
       /const detail\s*=\s*esc\(/.test(faultBlock),
       'and escapes both the fault kind and its detail before either becomes ' +
       'part of the toast HTML -- the only showToast() caller that does, ' +
       'because it is the only one whose words this app did not choose');
    ok(/\bd && d\.kind\b/.test(faultBlock) && /\bd && d\.detail\b/.test(faultBlock),
       'and reads them defensively, so a malformed send is a toast rather than ' +
       'a TypeError in the handler for reporting TypeErrors');
    //  The two producers that take a value from OFF this machine.
    ok(/name:\s*ccName\(code\),/.test(REND_CODE) &&
       /askedName:\s*ccName\(asked\),/.test(REND_CODE) &&
       /ip:\s*ipv4Only\(resp && resp\.exitIp\),/.test(REND_CODE),
       'resolveExit() is the only producer of x, and it closes all three: ' +
       'ccName for the two names, ipv4Only for the address');
    const ipv4Only = new Function(
        (REND_CODE.match(/function ipv4Only\(v\) \{[\s\S]*?\n\}/) || [''])[0] +
        '\n return ipv4Only;')();
    ok(ipv4Only('185.220.101.7') === '185.220.101.7', 'ipv4Only keeps a real address');
    let ipBad = PAYLOADS.filter(p => ipv4Only(p) !== null)
        .concat(['1.2.3.256', '1.2.3', '1.2.3.4.5', ' 1.2.3.4', '1.2.3.4 ',
                 '1.2.3.4<img src=x>', '0x1.2.3.4']
                .filter(p => ipv4Only(p) !== null));
    ok(ipBad.length === 0,
       'and returns null for every payload and every malformed address -- the ' +
       'exit IPv4 is the one value in a toast that a geolocation service over ' +
       'Tor chose, and a hostile exit relay can rewrite a plain-HTTP reply',
       ipBad.join(' | '));
    ok((REND_CODE.match(/announceExit\(x, '(connected|switched)'\)/g) || []).length === 3,
       "announceExit's verb is a literal at all three of its call sites, so " +
       'the Verb in that <strong> is app-authored');
    ok(/function names\(ids\) \{[\s\S]{0,200}ALL\.filter\(b => want\.has\(b\.id\)\)\.map\(b => b\.name\)/
        .test(fs.readFileSync(path.join(ROOT_DIR, 'lib', 'browsers.js'), 'utf8')),
       'and browsers.names() maps ids through the app\'s own table, so an id ' +
       'that is not in it contributes no name at all');

    // ── 5c. the two CSS attribute selectors ──────────────────────────
    console.log('\n[5c] li[data-value="${code}"] -- a selector, not markup');
    //  querySelector parses its argument as CSS. A `"` in `code` does not
    //  inject markup there, it throws a SyntaxError -- which takes out the
    //  whole dropdown render, including the row for the country the user is
    //  connected to. Both call sites are gated; the second one matters more,
    //  because its code arrives from the browser extension over a WebSocket
    //  that accepts a connection with no Origin header.
    const selSites = REND_CODE.split('\n')
        .map((l, i) => [i + 1, l])
        .filter(([, l]) => /querySelector\(`li\[data-value="\$\{/.test(l));
    ok(selSites.length === 2, 'both selector sites are still where this probe ' +
       'expects them', selSites.map(([n]) => n).join(','));
    ok(/force-switch-ui', \(event, code\) => \{[\s\S]{0,900}?if \(!\/\^\[a-z\]\{2\}\$\/i\.test\(code\)\) return;[\s\S]{0,200}?querySelector/
        .test(REND_CODE),
       'the extension-driven one rejects anything that is not two letters ' +
       'BEFORE the selector, so a quote cannot reach the CSS parser and a ' +
       'bogus data-value cannot be planted in the list either');

    // ── 6. the CSP that backs all of it ─────────────────────────────
    console.log('\n[6] index.html CSP -- the second line, not the first');
    const csp = (INDEX.match(/Content-Security-Policy"\s+content="([\s\S]*?)"/) || [])[1] || '';
    ok(/script-src\s+'self'\s+file:/.test(csp), 'script-src is self + file:');
    ok(!/script-src[^;]*unsafe-inline/.test(csp),
       "script-src has NO 'unsafe-inline' -- this is what makes an injected " +
       'onerror= inert even if a sink is ever missed');
    ok(!/script-src[^;]*unsafe-eval/.test(csp), "and no 'unsafe-eval'");
    ok(/default-src\s+'none'/.test(csp), "default-src is 'none'");
    ok(/object-src\s+'none'/.test(csp) && /frame-src\s+'none'/.test(csp) &&
       /form-action\s+'none'/.test(csp) && /base-uri\s+'none'/.test(csp),
       'object-src, frame-src, form-action and base-uri are all none');
    ok(!/connect-src[^;]*https?:\/\//.test(csp),
       'connect-src names no remote host, so this window cannot talk off the ' +
       'machine at all');
    ok(/style-src[^;]*unsafe-inline/.test(csp),
       "style-src DOES still allow inline styles -- stated, because it is why " +
       'section 4 exists rather than being left to the CSP');

    // ── 7. the permission handlers in main.js ───────────────────────
    console.log('\n[7] session permissions');
    //  MAIN_CODE, not MAIN. This probe's own header quotes `callback(true)` and
    //  `setPermissionCheckHandler(() => true)` to say what was removed, and
    //  main.js carries the same two strings in the comment above the handlers
    //  for the same reason -- so the two "appears nowhere" assertions below
    //  would fail on the sentence that records the fix.
    const permBlock = MAIN_CODE.slice(MAIN_CODE.indexOf('const ALLOWED_PERMISSIONS'),
                                      MAIN_CODE.indexOf('mainWindow = new BrowserWindow('));
    ok(permBlock.length > 200, 'the permission block was found');
    ok(!/callback\(true\)/.test(MAIN_CODE),
       'callback(true) appears nowhere in main.js code -- the blanket grant is gone');
    ok(!/setPermissionCheckHandler\(\(\) => true\)/.test(MAIN_CODE),
       'and so is setPermissionCheckHandler(() => true)');
    ok(/ALLOWED_PERMISSIONS = new Set\(\['geolocation'\]\)/.test(permBlock),
       'geolocation is the only permission on the list -- it is the one the ' +
       'spoof needs, and nothing in this app asks for camera, microphone, ' +
       'notifications, USB, HID, serial or clipboard');
    ok(/callback\(allow\)/.test(permBlock),
       'the request handler answers with the computed value');
    ok((permBlock.match(/ALLOWED_PERMISSIONS\.has\(permission\)/g) || []).length === 2 &&
       (permBlock.match(/isOwnWindow\(wc\)/g) || []).length === 2,
       'both handlers apply the SAME two conditions -- a granted check with a ' +
       'denied request is a page told it may and then refused');
    ok(/u\.startsWith\('file:\/\/'\)/.test(permBlock) &&
       /includes\('index\.html'\)/.test(permBlock),
       "and the asking frame must be this app's own file:// document, so the " +
       'rule holds if anything else is ever loaded into this session');
    ok(/Logger\.warn\('Permission request DENIED'/.test(permBlock),
       'a denial is logged with the permission name, so a future feature that ' +
       'needs one is a visible line and not a silent failure');
    ok((MAIN_CODE.match(/new BrowserWindow\(/g) || []).length === 1,
       'and there is exactly one BrowserWindow in the app, so one session rule ' +
       'covers all of it');

    // ── 8. the country code as machine configuration ────────────────
    //  Everything above is about a string reaching an innerHTML. This section
    //  is the other end of the same string: the country code also reaches the
    //  torrc, a CDP geolocation override and the WebSocket, and the gate that
    //  keeps it out of a <span> is not the gate that keeps it out of Tor's
    //  config file.
    console.log('\n[8] the same code, as machine configuration');
    const SRC_COORD = extract(MAIN, 'function geoCoord(cc) {');
    const SRC_PRED  = (MAIN.match(/const isSpoofableCc = [^\n]*/) || [''])[0];
    ok(SRC_COORD.length > 80 && !!SRC_PRED,
       'geoCoord() and isSpoofableCc() extracted from main.js');
    const geo = new Function('GEO_COORDS',
        `${SRC_COORD}\n${SRC_PRED}\n return { geoCoord, isSpoofableCc };`)(
            { us: { lat: 38.9, lon: -77 }, lu: { lat: 49.6, lon: 6.1 } });
    ok(geo.geoCoord('us') && geo.geoCoord('US'),
       'a real country resolves, in either case');
    //  The two strings that get past `if (!GEO_COORDS[cc]) return`. Both
    //  survive .toLowerCase() unchanged, both resolve on Object.prototype and
    //  both are truthy, so the old gate passed them and then read .lat off a
    //  function or an object -- undefined, which became a NaN geolocation
    //  override and an "undefined, CONSTRUCTOR" toast.
    for (const k of ['constructor', '__proto__', 'toString', 'valueOf',
                     'hasOwnProperty', 'prototype', 'isPrototypeOf']) {
        ok(geo.geoCoord(k) === null && geo.isSpoofableCc(k) === false,
           `geoCoord(${JSON.stringify(k)}) is null, not a prototype member`);
    }
    //  And nothing that merely STRINGIFIES to a country code. `['us']` coerces
    //  to 'us' through String(), and settings.json is JSON, where an array is
    //  one keystroke away from a string -- so the function takes a string or
    //  nothing.
    for (const k of [null, undefined, '', 'zzz', 'u', 'u s', 12, {}, ['us'],
                     new String('us')]) {
        ok(geo.geoCoord(k) === null,
           'and so is ' + JSON.stringify(k === undefined ? 'undefined' : k));
    }
    ok(/if \(typeof cc !== 'string'\) return null;/.test(SRC_COORD),
       'because it asks typeof before it coerces');
    ok(geo.geoCoord('zz') === null,
       'a two-letter code that is not IN the table is null too -- the length ' +
       'test is not the membership test');
    ok(/Object\.prototype\.hasOwnProperty\.call\(GEO_COORDS, k\)/.test(SRC_COORD),
       'the lookup is hasOwnProperty via Object.prototype.call, not ' +
       'GEO_COORDS.hasOwnProperty -- calling a method THROUGH the object being ' +
       'validated is the same mistake one level up');
    //  And no raw index read left anywhere else.
    const rawIdx = MAIN_CODE.split('\n')
        .map((l, i) => [i + 1, l])
        .filter(([, l]) => /GEO_COORDS\s*\[/.test(l));
    ok(rawIdx.length === 1,
       'GEO_COORDS[ is indexed on exactly ONE line of main.js code -- inside ' +
       'geoCoord, after the hasOwnProperty check. There were eight direct ' +
       'reads, every one gated on truthiness alone',
       rawIdx.map(([n, l]) => n + ': ' + l.trim().slice(0, 60)).join('\n         '));

    console.log('\n[8b] and the three places it becomes configuration');
    //  establishConnection: `{${serverCode}}` is written verbatim into the
    //  torrc's ExitNodes line, and the torrc is line-oriented -- a newline in
    //  this string is a Tor directive of the caller's choosing.
    ok(/async function establishConnection\(\{[\s\S]{0,2600}?if \(!isSpoofableCc\(serverCode\)\)[\s\S]{0,400}?return \{ status: 'unavailable'/
        .test(MAIN_CODE),
       'establishConnection() refuses a code it cannot place BEFORE building ' +
       'the torrc -- this is where the value stops being a UI string');
    ok(/if \(!isSpoofableCc\(serverCode\)\)[\s\S]{0,300}?serverCode = String\(serverCode\)\.toLowerCase\(\);/
        .test(MAIN_CODE),
       'and lower-cases it after, so one spelling reaches the config');
    for (const ch of ['connect-vpn', 'switch-vpn']) {
        const at = MAIN_CODE.indexOf(`ipcMain.handle('${ch}'`);
        const win = at < 0 ? '' : MAIN_CODE.slice(at, at + 1400);
        ok(/if \(!isSpoofableCc\(serverCode\)\)/.test(win),
           `the ${ch} IPC handler applies the same gate at the door -- its ` +
           'catch and its progress records echo this string back to the ' +
           'renderer and to the extension popup');
    }
    ok(/typeof d\.server !== 'string' \|\| !isSpoofableCc\(d\.server\)/.test(MAIN_CODE),
       "and the WebSocket's CHANGE_SERVER asks the same question the same way, " +
       'so the three entry points cannot disagree about what a country is');
    const gates = (MAIN_CODE.match(/isSpoofableCc\(/g) || []).length;
    ok(gates >= 6, `isSpoofableCc() is used at ${gates} sites`, String(gates));
    ok(/serverCode: isSpoofableCc\(s\.serverCode\)/.test(MAIN_CODE),
       'loadSettings() validates the code it reads off disk -- settings.json ' +
       'is in this app\'s own state directory, writable by any process running ' +
       'as this user, so "__proto__" needed no injection at all');

    console.log(`\n${pass} ok, ${fail} FAILED`);
    process.exit(fail ? 1 : 0);
})();
