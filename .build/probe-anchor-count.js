'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/probe-anchor-count.js  --  does every mutation anchor still match once?
//
//  Every mutation probe finds its site by LITERAL SOURCE TEXT and requires
//  exactly one match: probe-mutate.js prints "NOT APPLIED: the pattern appears N
//  times" and exits 1 for anything else. So an ordinary edit that repeats an
//  anchor's text -- or deletes it -- disables mutation testing for that whole
//  file, and it does so before any mutant runs.
//
//  This asserts the invariant in seconds instead of minutes: for each probe,
//  every anchor it carries appears exactly once in the file it mutates. Run it
//  after touching any file a mutant anchors in.
// ════════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const ROOT = path.join(HERE, '..');

//  Bracket matching that steps over string and template literals, because the
//  anchors themselves contain brackets and braces -- 'set({ [GEO_ORIGINS]: [] }'
//  among them. Counting inside a quote is how a slice ends mid-string.
function literalAt(src, open, closeChar) {
    const openChar = src[open];
    let depth = 0, quote = null;
    for (let i = open; i < src.length; i++) {
        const c = src[i];
        if (quote) {
            if (c === '\\') { i++; continue; }
            if (c === quote) quote = null;
            continue;
        }
        if (c === '\'' || c === '"' || c === '`') { quote = c; continue; }
        if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i < 0) break; continue; }
        if (c === openChar) depth++;
        else if (c === closeChar) { depth--; if (depth === 0) return src.slice(open, i + 1); }
    }
    return null;
}

//  A probe's anchors are JS expressions, and some are built from a template
//  literal declared above the table (probe-mutate-strand.js: READ_BLOCK,
//  BOOT_RELEASE). So the top-level string consts that precede the table are
//  evaluated first and handed to it as parameters -- nothing else in the file
//  runs, which matters because these probes spawn suites at require() time.
const STR = '(?:`(?:[^`\\\\]|\\\\[\\s\\S])*`|\'(?:[^\'\\\\\\n]|\\\\[\\s\\S])*\'|"(?:[^"\\\\\\n]|\\\\[\\s\\S])*")';

function stringConstsBefore(src, end) {
    const head = src.slice(0, end);
    const names = [], values = [];
    const re = new RegExp('^const ([A-Z][A-Z0-9_]*)\\s*=\\s*(' + STR + '(?:\\s*\\+\\s*' + STR + ')*)\\s*;', 'gm');
    let m;
    while ((m = re.exec(head))) {
        try {
            // eslint-disable-next-line no-new-func
            values.push(new Function('return ' + m[2])());
            names.push(m[1]);
        } catch (e) { /* not a plain string const; the table below will say so */ }
    }
    return { names, values };
}

//  A move cannot be written as a find/replace, so probe-mutate-proxyguard.js
//  carries its last mutant as a separate `{ name, from: [...], to: [...] }` object
//  and its runner uses that instead of the table entry of the same name. Reading
//  the table alone therefore reports rot on a `find` string the mutation run never
//  consults -- so the override is read too, and it wins.
function movesIn(src, scope) {
    const out = new Map();
    const re = /^const [A-Z][A-Z0-9_]*\s*=\s*\{/gm;
    let m;
    while ((m = re.exec(src))) {
        const lit = literalAt(src, src.indexOf('{', m.index), '}');
        if (!lit) continue;
        try {
            // eslint-disable-next-line no-new-func
            const o = new Function(...scope.names, 'return ' + lit)(...scope.values);
            if (o && typeof o.name === 'string' && Array.isArray(o.from)) out.set(o.name, o.from);
        } catch (e) { /* not a move object */ }
    }
    return out;
}

function tableOf(file) {
    const src = fs.readFileSync(path.join(HERE, file), 'utf8');
    const decl = src.indexOf('const MUTANTS = [');
    const scope = stringConstsBefore(src, src.length);
    if (decl < 0) return { kind: 'none', src, scope, moves: new Map() };
    const lit = literalAt(src, src.indexOf('[', decl), ']');
    if (!lit) return { kind: 'unparsed', src, why: 'the array literal does not close' };
    try {
        // eslint-disable-next-line no-new-func
        const table = new Function(...scope.names, 'return ' + lit)(...scope.values);
        return { kind: 'table', src, scope, table, moves: movesIn(src, scope) };
    } catch (e) { return { kind: 'unparsed', src, why: e.message }; }
}

//  Which file each probe mutates, read out of the probe rather than assumed. The
//  base matters: `path.join(ROOT, 'Extension', ...)` is relative to the repository
//  and `path.join(__dirname, '..', 'Extension', ...)` to this directory, and
//  resolving the second against the repository walks one level above it.
function targetOf(src) {
    const m = /const SRC\s+=\s*path\.join\(([^)]*)\)/.exec(src);
    if (!m) return null;
    const parts = m[1].match(/'([^']*)'|"([^"]*)"/g);
    if (!parts) return null;
    const base = /__dirname/.test(m[1]) ? HERE : ROOT;
    return path.resolve(base, ...parts.map(p => p.slice(1, -1)));
}

//  ARRAYS HAVE A .find METHOD. `entry.find !== undefined` is therefore true for
//  every [name, find, replace] triple, and reading it hands back
//  Array.prototype.find instead of the anchor -- which is how the first version of
//  this file reported "no find string" for all 39 anchors and passed with 0
//  checked.
//
//  Three shapes are in use: the triple, an object with `find`, and
//  probe-mutate-strand.js's `{ name, parts: [[find, replace], ...] }`, where one
//  mutant splices several places and each part is its own anchor.
function anchorsOf(entry, moves) {
    const named = (name, find) => ({ name, find: typeof find === 'string' ? find : null });
    const spread = (name, list) => list.map((f, i) => named(
        list.length > 1 ? `${name} [${i + 1}/${list.length}]` : name, f));

    if (Array.isArray(entry)) {
        const name = String(entry[0]);
        if (moves.has(name)) return spread(name + ' (move)', moves.get(name));
        return [named(name, entry[1])];
    }
    if (entry && typeof entry === 'object') {
        const name = typeof entry.name === 'string' ? entry.name : '(unnamed)';
        if (moves.has(name)) return spread(name + ' (move)', moves.get(name));
        if (Array.isArray(entry.parts)) return spread(name, entry.parts.map(p => (Array.isArray(p) ? p[0] : null)));
        return [named(name, entry.find)];
    }
    return [named('(unreadable entry)', null)];
}

//  A probe with no MUTANTS table still has anchors: probe-mutate-race.js splices
//  one block with FROM/TO. Those names are the convention in this directory.
const LOOSE_ANCHORS = ['FROM', 'ANCHOR'];

const probes = fs.readdirSync(HERE).filter(f => /^probe-mutate.*\.js$/.test(f)).sort();
let pass = 0, fail = 0, skipped = 0;

for (const probe of probes) {
    const got = tableOf(probe);
    if (got.kind === 'unparsed') {
        console.log(`  !!   ${probe}: MUTANTS did not evaluate -- ${got.why}`);
        fail++;
        continue;
    }
    const target = targetOf(got.src);
    if (!target) { console.log(`  !!   ${probe}: no SRC target found`); fail++; continue; }
    const rel = path.relative(ROOT, target);
    if (!fs.existsSync(target)) { console.log(`  !!   ${probe}: target missing -- ${rel}`); fail++; continue; }
    const body = fs.readFileSync(target, 'utf8');

    let anchors = [];
    if (got.kind === 'table' && Array.isArray(got.table)) {
        for (const e of got.table) anchors = anchors.concat(anchorsOf(e, got.moves));
    } else {
        for (const want of LOOSE_ANCHORS) {
            const at = got.scope.names.indexOf(want);
            if (at >= 0) anchors.push({ name: `${want} (spliced block)`, find: got.scope.values[at] });
        }
        if (!anchors.length) {
            console.log(`  --   ${probe}: no MUTANTS table and no ${LOOSE_ANCHORS.join('/')} const, skipped`);
            skipped++;
            continue;
        }
    }

    console.log(`\n${probe}  ->  ${rel}`);
    for (const a of anchors) {
        if (a.find === null) { console.log(`  !!   ${a.name}: the anchor is not a string`); fail++; continue; }
        //  CRLF, the way the probes themselves do it: .gitattributes keeps five
        //  documents (globe-controller.js among them) CRLF in the working tree, so
        //  a multi-line anchor written with \n matches 0 times there.
        //  probe-mutate-flight.js:126-129 retries with \r\n, and this has to agree
        //  with it or it reports rot the mutation run does not have.
        const crlf = a.find.replace(/\n/g, '\r\n');
        const hits = body.split(a.find).length - 1 +
                     (crlf === a.find ? 0 : body.split(crlf).length - 1);
        if (hits === 1) { pass++; console.log(`  ok   ${a.name}`); }
        else {
            fail++;
            console.log(`  FAIL ${a.name}: the anchor appears ${hits} times\n` +
                        `       ${JSON.stringify(a.find.slice(0, 100))}`);
        }
    }
}

console.log(`\nanchors matching exactly once: ${pass}, broken: ${fail}` +
            (skipped ? `, probes skipped: ${skipped}` : ''));
process.exit(fail ? 1 : 0);
