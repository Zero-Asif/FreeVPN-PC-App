//  .build/probe-md-html.js
//
//  GitHub renders the HTML in a markdown file, and it renders BROKEN HTML
//  too -- it just renders it wrong, usually by swallowing everything after
//  the mistake into a table cell. An unclosed <td> in the middle of a long
//  README is invisible in the source and obvious on the page, which is the
//  worst possible order to find out.
//
//  So this counts opening and closing tags for the block elements the docs
//  actually use, and it counts OCCURRENCES rather than lines: several of
//  these appear more than once on one line.
//
//    node .build/probe-md-html.js
//
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const TAGS = ['table', 'thead', 'tbody', 'tr', 'td', 'th',
              'details', 'summary', 'div', 'p', 'sub', 'sup',
              'h1', 'h2', 'h3', 'h4', 'b', 'i', 'code', 'kbd', 'a', 'span'];

//  Void elements: they never close, so counting a closer for them is wrong.
const VOID = new Set(['img', 'br', 'hr', 'source', 'input']);

const docs = [];
(function walk(dir, depth) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === 'release' || e.name === '.git') continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory() && depth < 3) walk(p, depth + 1);
        else if (e.isFile() && e.name.endsWith('.md')) docs.push(p);
    }
})(ROOT, 0);

let failed = 0;

for (const abs of docs) {
    const rel = path.relative(ROOT, abs).replace(/\\/g, '/');
    const text = fs.readFileSync(abs, 'utf8');

    //  Fenced code blocks hold example markup that is not part of the page.
    const body = text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');

    const bad = [];
    for (const tag of TAGS) {
        const open  = (body.match(new RegExp('<' + tag + '(?=[\\s>/])', 'gi'))  || []).length;
        const close = (body.match(new RegExp('</' + tag + '\\s*>', 'gi')) || []).length;
        if (open !== close) bad.push(`<${tag}> ${open} open / ${close} close`);
    }

    //  A closing tag for something that never opens is a different mistake
    //  with the same effect.
    for (const m of body.matchAll(/<\/([a-z][a-z0-9]*)\s*>/gi)) {
        const t = m[1].toLowerCase();
        if (VOID.has(t)) bad.push(`</${t}> -- ${t} is a void element and never closes`);
    }

    //  Unterminated tag: a '<' that opens a tag name and never finds its '>'.
    for (const m of body.matchAll(/<\/?[a-z][a-z0-9]*[^>\n]*$/gim)) {
        bad.push(`unterminated tag on one line: ${m[0].slice(0, 48)}`);
    }

    if (bad.length) { failed++; console.log(`  FAIL  ${rel}`); for (const b of bad) console.log(`          ${b}`); }
    else console.log(`  ok    ${rel}`);
}

console.log(`\n  ${docs.length} document${docs.length === 1 ? '' : 's'} checked, ${failed} failed.`);
process.exit(failed ? 1 : 0);
