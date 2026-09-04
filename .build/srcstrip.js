'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/srcstrip.js  --  take the COMMENTS out of a source file without
//  taking any CODE out.
//
//  Every static check in .build/ that says "main.js must still name this"
//  first removes the comments, because a name that appears only in prose is
//  not a call site. All of them did it in the same order -- block comments
//  first, then line comments -- and that order is wrong.
//
//  MEASURED, 2026-09-04, and it had already happened: main.js carries the
//  ordinary line comment
//
//      //  package.json lists Tun/** under asarUnpack.
//
//  The `/*` inside `Tun/**` is not a comment opener, but a stripper that pairs
//  `/*` with the next `*/` before line comments are gone cannot know that -- so
//  it paired with the next `*/` in the file, which is inside a regex literal
//  890 lines later (`/\[(?:warn|err)\][^\r\n]*/g`), and 890 lines of main.js
//  were deleted before a single assertion ran.
//
//  What went with them: the three restart IPC handlers -- test-restart-marker
//  dropped to 91/96 the moment that TUN comment landed, reporting handlers that
//  are right there in the file -- and 2 of the 13 geoExt()/geoEngine() call
//  sites check-callsites.js walks. Nothing was mis-verified in the end (both
//  hidden sites were `geoExt().baseDir`, and that method is called elsewhere
//  too, so it was still resolved), but that is luck: a call site removed from
//  the text cannot fail the check, it simply is not counted -- and
//  check-callsites.js exists because "the method was deleted and main.js still
//  calls it" has shipped twice.
//
//  So: line comments first, so a `/*` written in prose is gone before pairing
//  starts. Then block comments -- and every removal is checked, because the
//  failure mode is silent by nature. A "comment" longer than any doc comment in
//  this repo (the longest is 74 lines, in lib/geo-ext.js) is code being
//  swallowed, and that throws instead of returning a plausible-looking string.
//
//  Trailing `// ...` on a line that also has code is deliberately LEFT IN,
//  which is what all three callers already assumed: `.*//.*$` would eat the
//  `//` in every https:// URL and every path in the file.
// ════════════════════════════════════════════════════════════════════

//  Twice the longest doc comment in the repo. Not tuned to the failure: the
//  one this caught spanned 890 lines, and any real stray-marker pairing lands
//  in that range rather than just over the limit.
const MAX_COMMENT_LINES = 150;

/**
 * @param {string} src   the file's text
 * @param {string} label what to name in the error if it looks wrong
 * @returns {string} the same text with comments blanked out
 * @throws if a block-comment removal is too long to be a comment
 */
function stripComments(src, label = 'source') {
    const noLine = String(src == null ? '' : src).replace(/^[ \t]*\/\/.*$/gm, '');
    const re = /\/\*[\s\S]*?\*\//g;
    let out = '', last = 0, m;
    while ((m = re.exec(noLine))) {
        const lines = m[0].split('\n').length - 1;
        if (lines > MAX_COMMENT_LINES) {
            const at = noLine.slice(0, m.index).split('\n').length;
            throw new Error(
                `stripComments(${label}): the /* at line ${at} of the comment-stripped ` +
                `file pairs ${lines} lines later. A doc comment is not that long, so ` +
                `that is code being removed -- look for a stray /* or */ inside a ` +
                `string literal or a regex.`);
        }
        out += noLine.slice(last, m.index);
        last = m.index + m[0].length;
    }
    return out + noLine.slice(last);
}

module.exports = { stripComments, MAX_COMMENT_LINES };
