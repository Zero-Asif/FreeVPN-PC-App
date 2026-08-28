//  vendor-umd-shim.js  --  loaded TWICE by index.html: once immediately before
//  vendor/three.min.js + vendor/globe.gl.min.js, once immediately after.
//
//  Both bundles are UMD, and a UMD wrapper picks CommonJS the moment it sees a
//  `module`/`exports` pair. This window runs with nodeIntegration on, so it has
//  both -- which means the bundles would quietly export into Node's module
//  system and never assign window.THREE / window.Globe, and globe-controller.js
//  would find nothing to build a globe with. Hiding the pair forces the browser-
//  global branch, and it is put back straight afterwards so `require` keeps
//  working for renderer.js.
//
//  It was two inline <script> blocks until now. That was the last thing in this
//  document needing script-src 'unsafe-inline', and 'unsafe-inline' in a window
//  with full Node access is not a small grant: renderer.js builds toast and
//  server-list HTML with innerHTML out of state that includes country names and
//  relay data, so one injected `<img onerror=...>` would have been arbitrary
//  code with require('child_process'). The whole file exists to be external.
//
//  One file rather than two: the first run stashes and blanks, the second run
//  finds the stash and restores. Deleting the stash at the end leaves the page
//  exactly as it was found, so a third load would blank again rather than
//  restore a pair that is already live.
if (!window.__vendorUmdShim) {
    window.__vendorUmdShim = {
        module:  typeof module  !== 'undefined' ? module  : undefined,
        exports: typeof exports !== 'undefined' ? exports : undefined,
    };
    if (typeof module  !== 'undefined') module  = undefined;
    if (typeof exports !== 'undefined') exports = undefined;
    //  three.js checks `typeof exports === 'object'` on an object that is NOT
    //  Node's, so it gets an empty one to write into and abandon.
    window.exports = {};
} else {
    if (window.__vendorUmdShim.module)  module  = window.__vendorUmdShim.module;
    if (window.__vendorUmdShim.exports) exports = window.__vendorUmdShim.exports;
    delete window.exports;
    delete window.__vendorUmdShim;
}
