'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/test-geo-external.js  --  route 3, the forks' OWN
//  external-extensions provider, exercised for real against a
//  throwaway HKCU key.
//
//  WHY THIS EXISTS
//  Routes 1 and 2 are policy, and an unmanaged Chrome or Brave discards an
//  off-store policy entry outright -- measured, and the reason the field report
//  said "only Edge". Route 3 is the one door those two forks still open:
//  HKLM\SOFTWARE\<vendor>\[<product>\]Extensions\<id> with an update_url. It is
//  therefore the route that decides whether this feature reaches most of the
//  machine, and it is the route with the least room for error -- it writes
//  under SOFTWARE, next to keys that belong to the browser vendors themselves.
//
//  So every write, read-back, journalled revert, journal-free sweep and
//  empty-key prune is run here against HKCU\SOFTWARE\FreeProxyExtTest, by
//  pointing browsers.externalRoots() at it. Nothing touches HKLM, nothing is
//  installed, and no browser is started.
//
//  What is checked, in the order it matters:
//    1. The table itself: every fork that offers this route names one key, the
//       keys are distinct, and each one really is a ...\Extensions path.
//    2. pruneExternalRoot() removes a key ONLY when the key is empty of
//       everything except reg add's own (Default) litter.
//    3. sweepExternal() removes a subkey only when the id shape AND a loopback
//       update_url both say it is ours, and is a no-op run twice.
//    4. installExternal() writes, reads back, and journals what it wrote;
//       _restoreExternal() takes out exactly that and nothing else.
//    5. It skips the forks route 1 has already taken -- measured, two providers
//       racing at a cold start is what made Edge arrive disabled -- but ONLY on
//       a device an organization manages, because an unmanaged Edge tags an
//       off-store force-install [BLOCKED] and route 1 then delivers nothing.
// ════════════════════════════════════════════════════════════════════
const { execSync } = require('child_process');

const browsers = require('../lib/browsers');
const G = require('../lib/geo-ext');

const ROOT = 'HKCU\\SOFTWARE\\FreeProxyExtTest';
const OURS    = 'abcdefghijklmnopabcdefghijklmnop';
const FOREIGN = 'cccccccccccccccccccccccccccccccc';
const NOT_ID  = 'notanextensionid';
const OUR_URL = 'http://127.0.0.1:8081/update.xml';
const STORE   = 'https://clients2.google.com/service/update2/crx';

let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
    if (cond) { pass++; console.log('  ok   ' + name); }
    else { fail++; console.log('  FAIL ' + name + (extra ? '  -- ' + extra : '')); }
};
const warned = [];
const log = { debug: () => {}, info: () => {}, success: () => {},
              warn: m => warned.push(String(m)),
              error: (...a) => console.log('   ERROR:', ...a) };

//  reg.exe directly, deliberately: lib/geo-ext.js does its own reading through
//  regValueView(), and a test that reused it would cancel out a bug in it.
const sh = c => { try { return execSync(c, { windowsHide: true, encoding: 'utf8', stdio: 'pipe' }); }
                  catch (e) { return null; } };
const exists = k => sh(`reg query "${k}"`) !== null;
const add = (k, url) => sh(`reg add "${k}" /v update_url /t REG_SZ /d "${url}" /f`);

console.log('── 1. the table names one provider key per fork ──');
const withKey = browsers.CHROMIUM.filter(b => b.extkey);
ok(withKey.length >= 4, 'more than one fork offers this route',
   withKey.map(b => b.id).join(','));
ok(withKey.every(b => /^SOFTWARE\\/i.test(b.extkey)),
   'every key sits under SOFTWARE, never under Policies -- this route is not policy',
   withKey.map(b => b.extkey).join(' | '));
ok(withKey.every(b => /\\Extensions$/.test(b.extkey)),
   'and every one of them ends at the Extensions key itself',
   withKey.map(b => b.extkey).join(' | '));
ok(new Set(withKey.map(b => b.extkey.toLowerCase())).size === withKey.length,
   'no two forks are pointed at the same key');
for (const id of ['chrome', 'brave', 'edge']) {
    const b = browsers.byId(id);
    ok(b && !!b.extkey, `${id} has one -- it is the route that reaches it at all`,
       b ? String(b.extkey) : 'no such browser');
}
ok(JSON.stringify(browsers.REG_VIEWS) === '["64","32"]',
   'both registry views are written, so a 32-bit fork is not missed',
   JSON.stringify(browsers.REG_VIEWS));
const roots = browsers.externalRoots('all');
ok(roots.length === withKey.length && roots.every(r => /^HKLM\\SOFTWARE\\/i.test(r.key)),
   'externalRoots() hands back HKLM paths, one per fork in the table',
   JSON.stringify(roots.map(r => r.key)));

// ── everything below runs against a key of our own ──────────────
//  HKCU has no WOW6432Node redirection for a path like this, so both views
//  would be the same key and every second write would be a no-op on top of the
//  first. One view here; that the table is written in two is checked above.
const REAL_ROOTS = browsers.externalRoots;
const REAL_VIEWS = browsers.REG_VIEWS;
let redirect = [];
browsers.externalRoots = () => redirect;
browsers.REG_VIEWS = ['64'];
const restoreBrowsers = () => {
    browsers.externalRoots = REAL_ROOTS;
    browsers.REG_VIEWS = REAL_VIEWS;
};
process.on('exit', restoreBrowsers);
sh(`reg delete "${ROOT}" /f`);

console.log('── 2. the Extensions key goes only when it holds nothing of anyone else ──');
const P = n => `${ROOT}\\P${n}`;
ok(G.pruneExternalRoot(P(0), '64') === false, 'a key that is not there is not "pruned"');

//  reg add on a key with no /v leaves a (Default) value behind. That artefact is
//  the trap this project has already hit once: count it as content and "empty"
//  becomes impossible forever, so the key we created would outlive us.
sh(`reg add "${P(1)}" /f`);
ok(exists(P(1)) && /\(Default\)/.test(sh(`reg query "${P(1)}"`) || ''),
   'reg add really does leave a (Default) value behind -- the premise holds');
ok(G.pruneExternalRoot(P(1), '64') === true && !exists(P(1)),
   'and a key holding only that is removed');

//  A key with no values at all, which is what a key created as the parent of
//  another key looks like.
sh(`reg add "${P(2)}\\child" /f`);
sh(`reg delete "${P(2)}\\child" /f`);
ok(exists(P(2)) && G.pruneExternalRoot(P(2), '64') === true && !exists(P(2)),
   'a key with nothing in it at all goes too');

//  ONE subkey and no values of its own: measured, reg.exe prints no header line
//  at all for that key, only the subkey's path. An earlier version counted the
//  key lines it saw and read that as "empty" -- and reg delete /f takes the whole
//  tree, so it removed an administrator's entry along with the key. This case is
//  that bug, and it is the reason the check is by prefix rather than by order.
sh(`reg add "${P(3)}\\${FOREIGN}" /v update_url /t REG_SZ /d "${STORE}" /f`);
ok(!/\n\s*HKEY_[^\r\n]*P3\s*$/m.test(sh(`reg query "${P(3)}"`) || ''),
   'reg.exe prints no header for a valueless key -- the premise of the old bug');
ok(G.pruneExternalRoot(P(3), '64') === false && exists(P(3)) &&
   exists(`${P(3)}\\${FOREIGN}`),
   'a key that still has one subkey and nothing else is left exactly as it is');

sh(`reg add "${P(5)}" /v Owner /t REG_SZ /d "someone else" /f`);
sh(`reg add "${P(5)}\\${FOREIGN}" /v update_url /t REG_SZ /d "${STORE}" /f`);
ok(G.pruneExternalRoot(P(5), '64') === false && exists(`${P(5)}\\${FOREIGN}`),
   'nor is one with both a value and a subkey of theirs');

sh(`reg add "${P(4)}" /v Owner /t REG_SZ /d "someone else" /f`);
ok(G.pruneExternalRoot(P(4), '64') === false && exists(P(4)),
   'and so is one that still has a value of somebody else');
sh(`reg delete "${ROOT}" /f`);

console.log('── 3. the journal-free sweep: ours by shape AND by server ──');
//  Three provider roots, as if three forks were installed. The sweep runs with
//  no journal at all -- it is what cleans up after an install whose ProgramData
//  was deleted, where the id is a name nothing else knows.
const R_MIX  = `${ROOT}\\Google\\Chrome\\Extensions`;
const R_MINE = `${ROOT}\\VendorA\\Extensions`;
const R_THEM = `${ROOT}\\VendorB\\Extensions`;
redirect = [{ id: 'chrome', name: 'Google Chrome', key: R_MIX },
            { id: 'brave',  name: 'Brave',         key: R_MINE },
            { id: 'edge',   name: 'Microsoft Edge', key: R_THEM }];

add(`${R_MIX}\\${OURS}`, OUR_URL);
add(`${R_MIX}\\${FOREIGN}`, STORE);
add(`${R_MIX}\\${NOT_ID}`, OUR_URL);
add(`${R_MINE}\\${OURS}`, OUR_URL);
add(`${R_THEM}\\${FOREIGN}`, STORE);

const swept = G.sweepExternal(log);
ok(swept === 2, 'exactly the two entries served from loopback were removed',
   String(swept));
ok(!exists(`${R_MIX}\\${OURS}`) && !exists(`${R_MINE}\\${OURS}`), 'both of ours are gone');
ok(exists(`${R_MIX}\\${FOREIGN}`), "an administrator's store-served entry survives");
ok(exists(`${R_MIX}\\${NOT_ID}`),
   'a subkey that is not a 32-letter id survives even though its url IS loopback');
ok(exists(R_MIX), 'the key their entry lives in survives with it');
ok(!exists(R_MINE), 'the key that held only ours is pruned away');
ok(exists(R_THEM), 'and a key the sweep never removed anything from is untouched');
ok(exists(`${ROOT}\\VendorA`),
   'the vendor key above it stays -- it was never ours to remove');

ok(G.sweepExternal(log) === 0, 'run again it removes nothing: an uninstall may be retried');
ok(exists(`${R_MIX}\\${FOREIGN}`) && exists(`${R_MIX}\\${NOT_ID}`),
   'and the survivors survive that too');
sh(`reg delete "${ROOT}" /f`);

console.log('── 4. the write, the read-back, the journal, and the exact revert ──');
//  A GeoExt with only the four things route 3 touches. The alternative is a real
//  one, which packages and signs a CRX and starts a host -- none of which this
//  route reads.
function stub(id, webstoreId) {
    const g = Object.create(G.GeoExt.prototype);
    g.id = id;
    g.webstoreId = webstoreId || null;
    g.log = log;
    g.host = { updateUrl: () => OUR_URL };
    g.journal = {};
    g._read = () => g.journal;
    g._write = j => { g.journal = j; };
    return g;
}

redirect = [{ id: 'chrome', name: 'Google Chrome', key: R_MIX },
            { id: 'brave',  name: 'Brave',         key: R_MINE }];
add(`${R_MIX}\\${FOREIGN}`, STORE);   // a neighbour, so R_MIX is not ours alone

const g = stub(OURS);
const done = G.GeoExt.prototype.installExternal.call(g);
ok(JSON.stringify(done) === '["chrome","brave"]',
   'it reports the forks whose value was written AND read back', JSON.stringify(done));
const val = k => {
    const out = sh(`reg query "${k}" /v update_url`);
    const m = out && out.match(/update_url\s+REG_SZ\s+(.+)/);
    return m ? m[1].trim() : null;
};
ok(val(`${R_MIX}\\${OURS}`) === OUR_URL && val(`${R_MINE}\\${OURS}`) === OUR_URL,
   'the update_url really is in both keys, read back with reg.exe',
   String(val(`${R_MIX}\\${OURS}`)));
const rows = g.journal.external || [];
ok(rows.length === 2 && rows.every(r => r.id === OURS && r.url === OUR_URL && r.view === '64'),
   'and the journal records what was written, per key and per view',
   JSON.stringify(rows));
ok(rows.map(r => r.browser).join(',') === 'chrome,brave',
   'by browser id, so a rebrand cannot orphan the entry');
G.GeoExt.prototype.installExternal.call(g);
ok((g.journal.external || []).length === 2,
   'running setup twice does not double the journal', JSON.stringify(g.journal.external));

//  The revert. Only the rows in the journal, and only while they still point at
//  us: an entry someone overwrote after the install belongs to them now.
sh(`reg add "${R_MIX}\\${OURS}" /v update_url /t REG_SZ /d "${STORE}" /f`);
G.GeoExt.prototype._restoreExternal.call(g, g.journal);
ok(exists(`${R_MIX}\\${OURS}`) && val(`${R_MIX}\\${OURS}`) === STORE,
   'a journalled entry that now points somewhere else is LEFT ALONE');
ok(!exists(R_MINE), 'the one that still pointed at us is gone, and its key with it');
ok(exists(`${R_MIX}\\${FOREIGN}`), "and the neighbour's entry was never in question");

//  Put ours back and revert properly: the key stays, because it is not ours
//  alone -- pruning it would take the neighbour with it.
sh(`reg add "${R_MIX}\\${OURS}" /v update_url /t REG_SZ /d "${OUR_URL}" /f`);
G.GeoExt.prototype._restoreExternal.call(g, g.journal);
ok(!exists(`${R_MIX}\\${OURS}`), 'ours is removed by exact match');
ok(exists(R_MIX) && exists(`${R_MIX}\\${FOREIGN}`),
   'the shared key survives the prune, neighbour intact');
const before = warned.length;
G.GeoExt.prototype._restoreExternal.call(g, g.journal);
ok(warned.length === before, 'a second revert of the same journal warns about nothing',
   warned.slice(before).join(' | '));
ok(G.GeoExt.prototype._restoreExternal.call(g, null) === undefined,
   'and no journal at all is not an error');

console.log('── 5. not offered to a browser route 1 has already taken ──');
//  Measured 2026-08-31, and this is the bug it encodes: Edge had the extension
//  at location 6 (EXTERNAL_PREF_DOWNLOAD) instead of 7 -- this route won the
//  cold-start race against the policy one -- so it arrived DISABLED, with
//  disable_reasons [8192], no service worker, no onInstalled, and no welcome
//  tab. The user had to open edge://extensions and switch it on by hand. Route 1
//  lands the same extension already enabled and pinned, so a browser whose
//  forcelist is measured to work AND verified written is left to route 1 alone.
//
//  Measured 2026-09-01, and this is the other half of the same gate: the DEVICE
//  decides too. On a machine no organization manages, Edge rewrites our id to
//  [BLOCKED]<id> inside the forcelist slot -- the slot still reads back
//  byte-for-byte, so only edge://policy shows it -- and installs nothing. There
//  route 1 has won no race, and skipping this one left Edge with no extension at
//  all: absent from edge://extensions, absent from the toolbar, no welcome tab.
//  Both device states are driven below through the module's own _setManaged().
ok(G.FORCE_WORKS.includes('edge'),
   'the table still measures Edge as the one fork whose forcelist works',
   JSON.stringify(G.FORCE_WORKS));
G._setManaged(true);
ok(JSON.stringify(G.forceWorks()) === JSON.stringify(G.FORCE_WORKS),
   'on a managed device that measurement is exactly what the gate uses');
G._setManaged(false);
ok(JSON.stringify(G.forceWorks()) === '[]',
   'on an unmanaged one no fork counts as covered by route 1', JSON.stringify(G.forceWorks()));

sh(`reg delete "${ROOT}" /f`);
const R_EDGE = `${ROOT}\\Microsoft\\Edge\\Extensions`;
redirect = [{ id: 'edge',   name: 'Microsoft Edge',  key: R_EDGE },
            { id: 'chrome', name: 'Google Chrome',   key: R_MIX },
            { id: 'brave',  name: 'Brave',           key: R_MINE }];

G._setManaged(true);
const gskip = stub(OURS);
const kept  = G.GeoExt.prototype.installExternal.call(gskip, ['edge', 'chrome', 'brave']);
ok(JSON.stringify(kept) === '["chrome","brave"]',
   'managed: Edge is skipped; Chrome and Brave still get it -- they refuse the policy, ' +
   'so for them a disabled arrival is the best door there is', JSON.stringify(kept));
ok(!exists(`${R_EDGE}\\${OURS}`),
   "and nothing is written under Edge's own provider key at all");
ok((gskip.journal.external || []).every(r => r.browser !== 'edge'),
   'so there is no Edge row to journal, and none to revert later',
   JSON.stringify(gskip.journal.external));

//  The regression itself, as a test. Same verified route-1 write, same three
//  browsers, only the device is not managed -- and Edge must keep this route,
//  because route 1 cannot deliver there and nothing else can.
sh(`reg delete "${ROOT}" /f`);
G._setManaged(false);
const gunm  = stub(OURS);
const kept2 = G.GeoExt.prototype.installExternal.call(gunm, ['edge', 'chrome', 'brave']);
ok(JSON.stringify(kept2) === '["edge","chrome","brave"]',
   'unmanaged: Edge keeps route 3 even though its forcelist write read back fine',
   JSON.stringify(kept2));
ok(val(`${R_EDGE}\\${OURS}`) === OUR_URL,
   "and Edge's own provider key really carries our update_url",
   String(val(`${R_EDGE}\\${OURS}`)));
ok((gunm.journal.external || []).some(r => r.browser === 'edge'),
   'journalled like any other fork, so teardown takes it out again',
   JSON.stringify(gunm.journal.external));

//  The gate is route 1's VERIFIED list, not the browser table: an Edge whose
//  forcelist write did not stick is not covered by route 1, and route 3 is then
//  the only door left. Losing it would trade a disabled extension for none.
sh(`reg delete "${ROOT}" /f`);
G._setManaged(true);
const gnone = stub(OURS);
ok(JSON.stringify(G.GeoExt.prototype.installExternal.call(gnone, [])) ===
   '["edge","chrome","brave"]',
   'route 1 having failed for Edge, route 3 is offered to it after all');
ok(exists(`${R_EDGE}\\${OURS}`), 'and that entry really is written');

//  Unknown forks keep route 3 even when their policy write stuck: reg.exe
//  accepting the value says nothing about whether the browser honoured it.
const unknown = browsers.CHROMIUM.filter(b => b.policy && b.forcelist === 'unknown')
                                 .map(b => b.id);
ok(unknown.length > 0, 'the table still has forks whose forcelist is unmeasured',
   unknown.join(','));
sh(`reg delete "${ROOT}" /f`);
redirect = unknown.map((id, i) => ({ id, name: id, key: `${ROOT}\\U${i}\\Extensions` }));
const gunk = stub(OURS);
ok(JSON.stringify(G.GeoExt.prototype.installExternal.call(gunk, unknown)) ===
   JSON.stringify(unknown),
   'every one of them is written anyway', JSON.stringify(unknown));

//  Hand the device reading back to the device. Anything after this point --
//  here or in another test loaded into the same process -- must see the real
//  machine, not whatever this section last pretended.
G._setManaged(null);
ok(typeof G.managedDevice() === 'boolean',
   'and the override is released: managedDevice() reads the real device again');

console.log('── the store branch, for the day FP_GEO_WEBSTORE_ID is set ──');
sh(`reg delete "${ROOT}" /f`);
redirect = [{ id: 'chrome', name: 'Google Chrome', key: R_MIX }];
const gs = stub(OURS, FOREIGN);
G.GeoExt.prototype.installExternal.call(gs);
ok(val(`${R_MIX}\\${FOREIGN}`) === STORE,
   'the entry is named after the STORE id and served by the Web Store',
   String(val(`${R_MIX}\\${FOREIGN}`)));
ok(!exists(`${R_MIX}\\${OURS}`), 'and the self-signed id is not written at all');
ok(G.sweepExternal(log) === 0,
   'the journal-free sweep deliberately does NOT take a store id -- another ' +
   'installer could own it');
G.GeoExt.prototype._restoreExternal.call(gs, gs.journal);
ok(!exists(`${R_MIX}\\${FOREIGN}`), 'only the journal removes it, by exact match');

const g0 = stub(null);
ok(JSON.stringify(G.GeoExt.prototype.installExternal.call(g0)) === '[]',
   'nothing is written before the extension has an id');

sh(`reg delete "${ROOT}" /f`);
ok(!exists(ROOT), 'test key removed');
restoreBrowsers();
ok(browsers.externalRoots === REAL_ROOTS && browsers.REG_VIEWS === REAL_VIEWS,
   'and the browser table is put back the way it was');

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
