'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/test-edge-store.js  --  the Microsoft Edge Add-ons install route
//
//  WHAT IT IS FOR. This route is written now and switched on later: the
//  extension is in Edge's certification queue, and the day an id comes back
//  from Partner Center the only change to this app is that one constant stops
//  being null. That is a dangerous shape to ship untested, because the failure
//  it invites is silent in both directions.
//
//    * WHILE IT IS DORMANT, nothing may move. EDGE_STORE_ID is null today, and
//      every route this file decides has to produce the same bytes it produced
//      before the store code existed -- for every browser, managed and not. The
//      truth table below is that assertion, written out per browser rather than
//      derived, so a change of shape cannot agree with itself.
//    * WHEN IT IS SWITCHED ON, only Edge may move, and it must not move to a
//      force-install. A force-install of a STORE extension is honoured on any
//      device, managed or not -- so it is the easy thing to write, it would
//      appear to work, and it shows "Installed by your administrator" with a
//      DEAD toggle. The requirement is the opposite: the browser must not switch
//      this extension off by itself and the user must keep the power to. So
//      `installation_mode: allowed`, the store id on the allowlist, and the
//      offer through Edge's own external-extensions key -- which is exactly what
//      IDM and the commercial VPN installers write.
//    * AND THE OLD COPY MUST GO. The store re-signs the CRX, so the store copy
//      has a different id and a browser that was offered both holds both. Two
//      copies is not a duplicate icon: each has a service worker, each writes
//      chrome.proxy.settings, each spoofs, and the country a page reads is
//      whichever wrote last.
//
//  HOW. The decision surface (storeFor / idFor / forcelistEntry / settingsEntry
//  / externalEntry) is pure, so it is asked directly under all four
//  configurations. The routes that write are then run for real against
//  HKCU\SOFTWARE\FreeProxyEdgeStoreTest -- POLICY_KEYS and externalRoots() are
//  redirected there, the same trick test-geo-settings.js and
//  test-geo-forcelist.js use -- so the shipping code path is what runs,
//  unelevated, without going near a policy hive. No browser is launched, no
//  browser is closed, and nothing is written to HKLM.
// ════════════════════════════════════════════════════════════════════
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const geoExtMod = require('../lib/geo-ext');
const { GeoExt, POLICY_KEYS, FORCELIST, ALLOWLIST, EXT_SETTINGS, STORE_CRX,
        EDGE_STORE_ID, FORCE_INSTALLABLE, FORCE_WORKS, forceWorks, _setManaged,
        regValue, regValues, regValueView } = geoExtMod;
const browsers = require('../lib/browsers');

const ROOT = path.join(__dirname, '..');
const TEST_ROOT = 'HKCU\\SOFTWARE\\FreeProxyEdgeStoreTest';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fpstore-'));
for (const k of Object.keys(POLICY_KEYS)) POLICY_KEYS[k] = TEST_ROOT + '\\' + k;

const sh = c => { try { return execSync(c, { windowsHide: true, encoding: 'utf8', stdio: 'pipe' }); }
                  catch (e) { return null; } };

let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
    if (cond) { pass++; console.log('  ok   ' + name); }
    else { fail++; console.log('  FAIL ' + name + (extra ? '  -- ' + extra : '')); }
};
const eq = (got, want, name) =>
    ok(got === want, name, got === want ? '' : `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

const warnings = [];
const log = { debug: () => {}, info: () => {}, success: () => {},
              warn: (...a) => { warnings.push(a.join(' ')); },
              error: (...a) => console.log('   ERROR:', ...a) };

//  Literal ids, so every expected string below is exact rather than assembled
//  out of the same expression the code under test uses. SID and WID are real
//  extension id SHAPES -- 32 letters a-p -- and nothing else about them matters:
//  no CRX is fetched here and no browser is started.
const OUR  = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SID  = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';   //  what Edge Add-ons would return
const WID  = 'cccccccccccccccccccccccccccccccc';   //  what the Chrome Web Store would
const SELF = 'http://127.0.0.1:65000/update.xml';  //  the local helper's URL

const EDGE_URL   = STORE_CRX.edge;
const CHROME_URL = STORE_CRX.chrome;
const ALLOWED     = '{"installation_mode":"allowed"}';
const FORCED_SELF = JSON.stringify({ installation_mode: 'force_installed',
                                     update_url: SELF, toolbar_pin: 'force_pinned' });
const FORCED_EDGE = JSON.stringify({ installation_mode: 'force_installed',
                                     update_url: EDGE_URL, toolbar_pin: 'force_pinned' });
const FORCED_CHR  = JSON.stringify({ installation_mode: 'force_installed',
                                     update_url: CHROME_URL, toolbar_pin: 'force_pinned' });

/** One browser's whole decision, as five comparable values. */
const probe = (ext, id) => {
    const st = ext.storeFor(id);
    const x = ext.externalEntry(id, SELF);
    return { store: st ? st.store : null,
             i: ext.idFor(id),
             f: ext.forcelistEntry(id, SELF),
             s: JSON.stringify(ext.settingsEntry(id, SELF)),
             x: x ? `${x.id} ${x.url}` : null };
};
const T = (store, i, f, s, x) => ({ store, i, f, s, x });
const rowOf = r => `${r.store} | ${r.i} | ${r.f} | ${r.s} | ${r.x}`;

/**
 * A GeoExt configured by the two environment variables the real one reads.
 *
 * `id` is assigned rather than earned: prepare() is what normally sets it, and it
 * stages the extension, mints a key and packs a CRX. None of that changes a
 * single answer below, and a literal id is what makes the expected strings exact.
 */
function extWith({ edge = null, web = null } = {}) {
    if (edge) process.env.FP_GEO_EDGE_STORE_ID = edge;
    else delete process.env.FP_GEO_EDGE_STORE_ID;
    if (web) process.env.FP_GEO_WEBSTORE_ID = web;
    else delete process.env.FP_GEO_WEBSTORE_ID;
    const e = new GeoExt({ log, stateDir: fs.mkdtempSync(path.join(TMP, 'x-')),
                           sourceDir: path.join(ROOT, 'Extension') });
    e.id = OUR;
    return e;
}

/** Every browser's whole row against a literal expectation. */
function table(label, cfg, managed, want) {
    _setManaged(managed);
    const ext = extWith(cfg);
    for (const id of Object.keys(want)) {
        const got = rowOf(probe(ext, id));
        const w = rowOf(want[id]);
        ok(got === w, `${label} / ${id}`,
           got === w ? '' : `\n         got  ${got}\n         want ${w}`);
    }
    return ext;
}

//  ══ A. the truth table ═════════════════════════════════════════════
//  store | idFor | forcelistEntry | settingsEntry | externalEntry, per browser,
//  written out rather than derived.
const FSELF = `${OUR};${SELF}`;
const XSELF = `${OUR} ${SELF}`;
const FCHR  = `${WID};${CHROME_URL}`;
const XCHR  = `${WID} ${CHROME_URL}`;
const XEDGE = `${SID} ${EDGE_URL}`;

console.log('── A1. nothing published yet, unmanaged: today, exactly ──');
//  This is what ships. Every value here is the value the formulas produced
//  before any store code existed, which is the requirement: the step that is
//  running now must not move until an id comes back.
table('dormant/unmanaged', {}, false, {
    edge:     T(null, OUR, FSELF, ALLOWED, XSELF),
    chrome:   T(null, OUR, FSELF, ALLOWED, XSELF),
    brave:    T(null, OUR, FSELF, ALLOWED, XSELF),
    vivaldi:  T(null, OUR, FSELF, ALLOWED, XSELF),
    yandex:   T(null, OUR, FSELF, ALLOWED, XSELF),
    chromium: T(null, OUR, FSELF, ALLOWED, XSELF),
});

console.log('── A2. nothing published yet, MANAGED: still today, exactly ──');
//  Edge is the one browser whose self-hosted force-install was measured to be
//  honoured, and only on a managed device -- so it is the only row that moves,
//  and it moves to the self-hosted URL, not to a store.
table('dormant/managed', {}, true, {
    edge:     T(null, OUR, FSELF, FORCED_SELF, XSELF),
    chrome:   T(null, OUR, FSELF, ALLOWED, XSELF),
    brave:    T(null, OUR, FSELF, ALLOWED, XSELF),
    vivaldi:  T(null, OUR, FSELF, ALLOWED, XSELF),
    yandex:   T(null, OUR, FSELF, ALLOWED, XSELF),
    chromium: T(null, OUR, FSELF, ALLOWED, XSELF),
});

console.log('── A3. Edge Add-ons approved, unmanaged: EDGE ALONE moves ──');
//  The switch-on. Read the edge row against the chrome row beside it: a
//  different id, no forcelist entry at all, and an external-extensions offer
//  pointing at Edge's own CRX endpoint instead of this machine's helper. Every
//  other browser's five values are character-for-character A1's.
table('edge-store/unmanaged', { edge: SID }, false, {
    edge:     T('edge', SID, null, ALLOWED, XEDGE),
    chrome:   T(null, OUR, FSELF, ALLOWED, XSELF),
    brave:    T(null, OUR, FSELF, ALLOWED, XSELF),
    vivaldi:  T(null, OUR, FSELF, ALLOWED, XSELF),
    yandex:   T(null, OUR, FSELF, ALLOWED, XSELF),
    chromium: T(null, OUR, FSELF, ALLOWED, XSELF),
});

console.log('── A4. Edge Add-ons approved, MANAGED: nothing is force-installed ──');
//  The row this whole file exists for. On a managed device a force-install of a
//  STORE extension is honoured -- so `force_installed` here would work, which is
//  exactly what makes it dangerous: it shows "Installed by your administrator"
//  with a dead toggle, and the user is required to keep that switch. Edge stays
//  on `allowed`, and with Edge on the store no browser on this list is
//  force-installed at all.
table('edge-store/managed', { edge: SID }, true, {
    edge:     T('edge', SID, null, ALLOWED, XEDGE),
    chrome:   T(null, OUR, FSELF, ALLOWED, XSELF),
    brave:    T(null, OUR, FSELF, ALLOWED, XSELF),
    vivaldi:  T(null, OUR, FSELF, ALLOWED, XSELF),
    yandex:   T(null, OUR, FSELF, ALLOWED, XSELF),
    chromium: T(null, OUR, FSELF, ALLOWED, XSELF),
});

console.log('── A5. the Chrome Web Store branch, untouched, on both device answers ──');
//  The pre-existing dormant path, asserted here only to show the Edge work did
//  not move it. Two things differ from the Edge branch and both are deliberate:
//  the Chrome Web Store is offered to EVERY fork including Edge (Edge installs
//  from it), and it is force-installed -- `consent: false` -- because a Web
//  Store CRX passes every fork's verification, so the browser will not disable
//  it and route 1 delivers it without a second step. The device answer cannot
//  reach these rows at all: forceWorks() is only consulted when there is no
//  store, so asserting the same table twice is the assertion.
const A5 = {
    edge:     T('chrome', WID, FCHR, FORCED_CHR, XCHR),
    chrome:   T('chrome', WID, FCHR, FORCED_CHR, XCHR),
    brave:    T('chrome', WID, FCHR, FORCED_CHR, XCHR),
    vivaldi:  T('chrome', WID, FCHR, FORCED_CHR, XCHR),
    yandex:   T('chrome', WID, FCHR, FORCED_CHR, XCHR),
    chromium: T('chrome', WID, FCHR, FORCED_CHR, XCHR),
};
for (const m of [false, true]) {
    table(`webstore/${m ? 'managed' : 'unmanaged'}`, { web: WID }, m, A5);
}

console.log('── A6. published in BOTH: Edge takes its own store, the rest take Chrome\'s ──');
//  Edge prefers Edge Add-ons, and it has to: the two stores hand out two
//  different re-signed CRXs, so a browser offered both would hold two copies of
//  this extension for exactly the reason retireSideload() exists.
const A6 = {
    edge:     T('edge', SID, null, ALLOWED, XEDGE),
    chrome:   T('chrome', WID, FCHR, FORCED_CHR, XCHR),
    brave:    T('chrome', WID, FCHR, FORCED_CHR, XCHR),
    vivaldi:  T('chrome', WID, FCHR, FORCED_CHR, XCHR),
    yandex:   T('chrome', WID, FCHR, FORCED_CHR, XCHR),
    chromium: T('chrome', WID, FCHR, FORCED_CHR, XCHR),
};
for (const m of [false, true]) {
    table(`both/${m ? 'managed' : 'unmanaged'}`, { edge: SID, web: WID }, m, A6);
}

console.log('── A7. a malformed id is refused at the door, and says so ──');
//  A wrong id is not an id that fails. It is a real extension id shape naming
//  nothing, and it would be written into four registry routes and then looked
//  for in a profile -- every read answering "absent", correctly, about an
//  extension that was never offered. So it is rejected on the way in.
_setManaged(false);      //  A6 left it managed; the row below is A1's, unmanaged
for (const bad of ['', 'zzzz', SID.toUpperCase(), SID + 'a', SID.slice(0, 31),
                   'qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq', 'b'.repeat(31) + '1']) {
    warnings.length = 0;
    const e = extWith({ edge: bad });
    ok(e.edgeStoreId === null,
       `${JSON.stringify(bad)} is not accepted as an Edge Add-ons id`, String(e.edgeStoreId));
    const got = rowOf(probe(e, 'edge')), want = rowOf(T(null, OUR, FSELF, ALLOWED, XSELF));
    ok(got === want, `${JSON.stringify(bad)} leaves Edge on the self-hosted route, unchanged`,
       got === want ? '' : `\n         got  ${got}\n         want ${want}`);
    ok(bad === '' || warnings.some(w => w.includes('32 letters')),
       `${JSON.stringify(bad)} is logged as refused, not swallowed`, warnings.join(' | '));
}
//  ...and the one that must be accepted, so the test above is not just
//  rejecting everything.
ok(extWith({ edge: SID }).edgeStoreId === SID, 'a well-formed id IS accepted');

//  ══ B. the routes, written for real ════════════════════════════════
//  Everything above is pure. From here the shipping writers run, against
//  HKCU\SOFTWARE\FreeProxyEdgeStoreTest instead of the policy hive, so what is
//  exercised is the code that ships and no policy is touched.
const THREE = browsers.CHROMIUM.filter(b => ['edge', 'chrome', 'brave'].includes(b.id));
const EXT_ROOTS = THREE.map(b => ({ id: b.id, name: b.name,
                                    key: `${TEST_ROOT}\\ext\\${b.id}` }));
const FOREIGN_ID = 'dddddddddddddddddddddddddddddddd';
const FOREIGN_URL = 'https://clients2.google.com/service/update2/crx';

const fKey = id => `${POLICY_KEYS[id]}\\${FORCELIST}`;
const aKey = id => `${POLICY_KEYS[id]}\\${ALLOWLIST}`;
const settingsOf = id => { const r = regValue(POLICY_KEYS[id], EXT_SETTINGS);
                           try { return r == null ? null : JSON.parse(r); }
                           catch (e) { return 'unparseable'; } };
const slotHolding = (key, val) => Object.entries(regValues(key))
                                        .filter(([, v]) => v === val).map(([k]) => k);

(async () => {
    sh(`reg delete "${TEST_ROOT}" /f`);
    delete process.env.FP_GEO_EDGE_STORE_ID;
    delete process.env.FP_GEO_WEBSTORE_ID;
    const STATE = path.join(TMP, 'state');
    fs.mkdirSync(STATE, { recursive: true });

    const ext1 = new GeoExt({ log, stateDir: STATE, sourceDir: path.join(ROOT, 'Extension') });
    const p1 = await ext1.prepare();
    if (!p1) { console.log('ABORT: prepare() failed'); process.exit(3); }
    const ID1 = p1.id, URL1 = ext1.host.updateUrl();
    ok(ext1.edgeStoreId === null, 'the shipping build has no Edge Add-ons id yet');

    //  A fixed browser list, so the shape below is the same on any machine --
    //  including one where Edge is not installed, which is the browser this whole
    //  file is about. Route 3's roots are redirected the same way POLICY_KEYS is.
    browsers.detectChromium = () => THREE.map(b => ({ ...b }));
    browsers.externalRoots = () => EXT_ROOTS.map(r => ({ ...r }));
    //  One view, on purpose. WOW64 redirects HKLM\Software, not HKCU\Software, so
    //  under this test root /reg:32 and /reg:64 are the SAME physical key and a
    //  two-view run would journal two rows for one value -- an artifact of the
    //  test hive, not of the key the app really writes.
    browsers.REG_VIEWS = ['64'];
    //  Managed, so route 1 is really exercised: an unmanaged device is measured to
    //  answer an off-store force-install with [BLOCKED], and forceWorks() knows it.
    _setManaged(true);

    console.log(`\nid ${ID1}\nhelper ${URL1}\n`);
    console.log('── B1. before approval: the self-hosted routes, as they run today ──');
    //  Somebody else's entries first, in all three routes, so every assertion
    //  below is also an assertion that they were left alone.
    sh(`reg add "${fKey('edge')}" /v 1 /t REG_SZ /d "${FOREIGN_ID};${FOREIGN_URL}" /f`);
    sh(`reg add "${aKey('edge')}" /v 1 /t REG_SZ /d "${FOREIGN_ID}" /f`);
    sh(`reg add "${TEST_ROOT}\\ext\\edge\\${FOREIGN_ID}" /v update_url ` +
       `/t REG_SZ /d "${FOREIGN_URL}" /f`);

    const d1 = ext1.install();
    eq(d1.join(','), 'edge', 'route 1 reaches Edge and nobody else -- Chrome and Brave are ' +
                             "measured 'refused' and are not even attempted");
    const mySlots = slotHolding(fKey('edge'), `${ID1};${URL1}`);
    eq(mySlots.length, 1, "Edge's forcelist has exactly one entry of ours");
    ok(mySlots[0] !== '1', 'and it took a free slot rather than overwriting slot 1', mySlots[0]);
    eq(regValues(fKey('edge'))['1'], `${FOREIGN_ID};${FOREIGN_URL}`, "slot 1 is still theirs");

    const s1 = ext1.installSettings();
    eq(s1.join(','), 'edge,chrome,brave', 'route 2 is written for all three');
    eq(JSON.stringify(settingsOf('edge')),
       JSON.stringify({ [ID1]: { installation_mode: 'force_installed',
                                 update_url: URL1, toolbar_pin: 'force_pinned' } }),
       'Edge: force_installed at the local helper, on a managed device');
    for (const id of ['chrome', 'brave']) {
        eq(JSON.stringify(settingsOf(id)), JSON.stringify({ [ID1]: { installation_mode: 'allowed' } }),
           `${id}: allowed only -- its forcelist is refused, and management does not change that`);
    }

    const a1 = ext1.installAllowlist();
    eq(a1.join(','), 'edge,chrome,brave', 'route 4 is written for all three');
    for (const b of THREE) {
        eq(slotHolding(aKey(b.id), ID1).length, 1, `${b.id}: our id is on the allowlist once`);
    }
    eq(regValues(aKey('edge'))['1'], FOREIGN_ID, "Edge's allowlist slot 1 is still theirs");

    const x1 = ext1.installExternal(d1);
    eq(x1.join(','), 'chrome,brave',
       'route 3 skips Edge -- route 1 already owns it, and offering a browser both was ' +
       'measured to hand it a DISABLED copy by winning the cold-start race');
    for (const id of ['chrome', 'brave']) {
        eq(regValueView(`${TEST_ROOT}\\ext\\${id}\\${ID1}`, 'update_url', '64'), URL1,
           `${id}: offered the packaged copy through its own external-extensions key`);
    }
    ok(regValueView(`${TEST_ROOT}\\ext\\edge\\${ID1}`, 'update_url', '64') === null,
       'and Edge was not offered the same copy twice');
    eq(regValueView(`${TEST_ROOT}\\ext\\edge\\${FOREIGN_ID}`, 'update_url', '64'), FOREIGN_URL,
       'the extension somebody else offers Edge is untouched');

    console.log('── B2. the id comes back from Partner Center ──');
    //  The real upgrade sequence: the machine above already has all four routes
    //  written for the packaged copy, then the app updates and the constant is no
    //  longer null. Same state directory, same signing key -- so this is one
    //  machine over time, not two machines.
    ext1.host.stop();
    process.env.FP_GEO_EDGE_STORE_ID = SID;
    const ext2 = new GeoExt({ log, stateDir: STATE, sourceDir: path.join(ROOT, 'Extension') });
    const p2 = await ext2.prepare();
    if (!p2) { console.log('ABORT: the second prepare() failed'); process.exit(3); }
    const ID2 = p2.id, URL2 = ext2.host.updateUrl();
    eq(ext2.edgeStoreId, SID, 'the store id is picked up');
    eq(ID2, ID1, 'the packaged copy still signs to the same id -- same key, same extension');
    eq(ext2.idFor('edge'), SID, 'Edge is now expected to hold the STORE id');
    eq(ext2.idFor('chrome'), ID1, 'Chrome still holds the one we signed');

    const d2 = ext2.install();
    eq(d2.join(','), '', 'route 1 now installs NOTHING -- Edge is asked, not forced, and ' +
                         'nobody else was ever a target');
    eq(slotHolding(fKey('edge'), `${ID1};${URL1}`).length, 0,
       "the old force-install of the packaged copy is gone from Edge's forcelist");
    eq(regValues(fKey('edge'))['1'], `${FOREIGN_ID};${FOREIGN_URL}`,
       'and the entry that was never ours is still in slot 1');

    const s2 = ext2.installSettings();
    eq(s2.join(','), 'edge,chrome,brave', 'route 2 is written for all three again');
    eq(JSON.stringify(settingsOf('edge')),
       JSON.stringify({ [SID]: { installation_mode: 'allowed' } }),
       'Edge: one entry, the STORE id, installation_mode allowed -- on a MANAGED device, ' +
       'where a force-install of a store extension would have been honoured');
    ok(!Object.keys(settingsOf('edge') || {}).includes(ID1),
       'and our former id is out of the dictionary -- two entries would configure two ' +
       'extensions, and both of them would set the proxy');
    for (const id of ['chrome', 'brave']) {
        eq(JSON.stringify(settingsOf(id)),
           JSON.stringify({ [ID1]: { installation_mode: 'allowed' } }),
           `${id}: byte-identical to before the store id existed`);
    }

    const a2 = ext2.installAllowlist();
    eq(a2.join(','), 'edge,chrome,brave', 'route 4 is written for all three again');
    eq(slotHolding(aKey('edge'), SID).length, 1, "the store id is on Edge's allowlist");
    eq(slotHolding(aKey('edge'), ID1).length, 0, 'and the id it replaced is off it');
    eq(regValues(aKey('edge'))['1'], FOREIGN_ID, "the administrator's slot 1 is still theirs");
    for (const id of ['chrome', 'brave']) {
        eq(slotHolding(aKey(id), ID1).length, 1, `${id}: still allows the id it really holds`);
    }

    const x2 = ext2.installExternal(d2);
    eq(x2.join(','), 'edge,chrome,brave',
       'route 3 now offers Edge as well -- route 1 no longer owns it, so there is no race ' +
       'to lose');
    eq(regValueView(`${TEST_ROOT}\\ext\\edge\\${SID}`, 'update_url', '64'), EDGE_URL,
       "Edge is offered the store's own CRX endpoint, through the same key IDM writes");
    eq(regValueView(`${TEST_ROOT}\\ext\\edge\\${FOREIGN_ID}`, 'update_url', '64'), FOREIGN_URL,
       'and the stranger beside it is still there');
    for (const id of ['chrome', 'brave']) {
        eq(regValueView(`${TEST_ROOT}\\ext\\${id}\\${ID1}`, 'update_url', '64'), URL1,
           `${id}: still offered the packaged copy, at the URL it was already offered at`);
    }

    const j2 = JSON.parse(fs.readFileSync(ext2.stateFile, 'utf8'));
    eq((j2.slots || []).length, 0, 'the journal has no force-install row left to undo');
    eq((j2.allow || []).length, 3, 'one allowlist row per browser, not four');
    eq((j2.external || []).length, 3, 'one external-extensions row per browser, not four');
    ok((j2.allow || []).some(s => s.browser === 'edge' && s.id === SID),
       "Edge's allowlist row records the store id, so an uninstall takes back the right one");
    ok((j2.external || []).some(e => e.browser === 'edge' && e.id === SID && e.url === EDGE_URL),
       "and so does its external-extensions row");

    console.log('── B3. an unmanaged machine, where route 3 is what carried Edge ──');
    //  The ordinary case, and the one where the old copy is hardest to take back:
    //  with no force-install to own Edge, route 3 offers it the packaged copy, so
    //  after approval Edge is holding an external-extensions offer under OUR id
    //  that has to be withdrawn before the store's is put beside it.
    ext2.host.stop();
    sh(`reg delete "${TEST_ROOT}" /f`);
    _setManaged(false);
    delete process.env.FP_GEO_EDGE_STORE_ID;
    const STATE3 = path.join(TMP, 'state3');
    fs.mkdirSync(STATE3, { recursive: true });
    const ext3 = new GeoExt({ log, stateDir: STATE3, sourceDir: path.join(ROOT, 'Extension') });
    const p3 = await ext3.prepare();
    if (!p3) { console.log('ABORT: the third prepare() failed'); process.exit(3); }
    const ID3 = p3.id, URL3 = ext3.host.updateUrl();
    sh(`reg add "${TEST_ROOT}\\ext\\edge\\${FOREIGN_ID}" /v update_url ` +
       `/t REG_SZ /d "${FOREIGN_URL}" /f`);

    const d3 = ext3.install();
    eq(d3.join(','), '', 'route 1 claims nothing here -- measured: an unmanaged Edge answers ' +
                         'an off-store force-install with [BLOCKED], and forceWorks() knows it');
    eq(slotHolding(fKey('edge'), `${ID3};${URL3}`).length, 1,
       'the slot is still written, because the read-back is what proves it, not the outcome');
    eq(ext3.installExternal(d3).join(','), 'edge,chrome,brave',
       'so route 3 is what offers Edge the packaged copy, and all three are offered');
    ext3.installAllowlist();
    eq(regValueView(`${TEST_ROOT}\\ext\\edge\\${ID3}`, 'update_url', '64'), URL3,
       'Edge holds an offer of the packaged copy under the id we signed');
    eq(slotHolding(aKey('edge'), ID3).length, 1, 'and that id is on its allowlist');

    ext3.host.stop();
    process.env.FP_GEO_EDGE_STORE_ID = SID;
    const ext4 = new GeoExt({ log, stateDir: STATE3, sourceDir: path.join(ROOT, 'Extension') });
    const p4 = await ext4.prepare();
    if (!p4) { console.log('ABORT: the fourth prepare() failed'); process.exit(3); }
    eq(ext4.edgeStoreId, SID, 'the store id arrives');

    const retired = ext4.retireSideload();
    eq(retired.join(','), 'edge', 'the packaged copy is withdrawn from Edge and from nobody else');
    ok(sh(`reg query "${TEST_ROOT}\\ext\\edge\\${ID3}"`) === null,
       'the whole external-extensions subkey is gone, not just its value -- that key IS the ' +
       'standing offer, and a browser that no longer sees it drops the extension at its ' +
       'next start, which is what an uninstall of an installer-delivered extension is');
    eq(slotHolding(fKey('edge'), `${ID3};${URL3}`).length, 0, 'its forcelist slot is gone');
    eq(slotHolding(aKey('edge'), ID3).length, 0, 'its allowlist slot is gone');
    ok(sh(`reg query "${TEST_ROOT}\\ext\\edge"`) !== null,
       'the root above it survives -- somebody else\'s subkey is still in it, and deleting ' +
       'the root would take their offer with ours');
    for (const id of ['chrome', 'brave']) {
        eq(regValueView(`${TEST_ROOT}\\ext\\${id}\\${ID3}`, 'update_url', '64'), URL3,
           `${id}: its offer of the packaged copy is untouched -- it is not moving anywhere`);
        eq(slotHolding(aKey(id), ID3).length, 1, `${id}: still on its own allowlist`);
    }
    eq(regValueView(`${TEST_ROOT}\\ext\\edge\\${FOREIGN_ID}`, 'update_url', '64'), FOREIGN_URL,
       'and the stranger under the same root is exactly as it was');
    eq(ext4.retireSideload().join(','), '',
       'running it a second time retires nothing -- the journal rows went with the values');

    const URL4 = ext4.host.updateUrl();
    const x4 = ext4.installExternal(ext4.install());
    eq(x4.join(','), 'edge,chrome,brave', 'the next pass offers Edge the store copy');
    eq(regValueView(`${TEST_ROOT}\\ext\\edge\\${SID}`, 'update_url', '64'), EDGE_URL,
       'under the store id, at Edge Add-ons\' own CRX endpoint');
    for (const id of ['chrome', 'brave']) {
        eq(regValueView(`${TEST_ROOT}\\ext\\${id}\\${ID3}`, 'update_url', '64'), URL4,
           `${id}: same id, re-pointed at this run's helper port`);
    }
    ok(sh(`reg query "${TEST_ROOT}\\ext\\edge\\${ID3}"`) === null,
       'and the withdrawn copy did not come back -- one copy in Edge, not two');

    console.log('── B4. which id each browser is read with ──');
    //  The read has to agree with the write or the app reports the extension
    //  absent while it sits there running. This is what the first-open card asks.
    eq(ext4.knownId('edge'), SID, 'Edge is read with the store id');
    eq(ext4.knownId('chrome'), ID3, 'Chrome is read with the id we signed');
    eq(ext4.knownId(), ID3, 'and with no browser named, the id we signed');
    const cold = new GeoExt({ log, stateDir: path.join(TMP, 'cold'),
                              sourceDir: path.join(ROOT, 'Extension') });
    fs.mkdirSync(path.join(TMP, 'cold'), { recursive: true });
    eq(cold.knownId('edge'), SID,
       'before the first connect Edge is still answerable -- the store id is known without ' +
       'staging anything, so the card can say what Edge holds');
    eq(cold.knownId('chrome'), null,
       'and Chrome is not: no journal, no id, and no guess');

    ext4.host.stop();
    _setManaged(null);
    delete process.env.FP_GEO_EDGE_STORE_ID;
    sh(`reg delete "${TEST_ROOT}" /f`);
    ok(sh(`reg query "${TEST_ROOT}"`) === null, 'test hive removed');

    console.log('── C. nothing is switched on in the build that ships ──');
    //  Read out of the file and off the export, because this is the one assertion
    //  that cannot be made by exercising anything: the whole of section A ran with
    //  an id injected through the environment, and an id left behind in the source
    //  would put every Edge user on the store route before the store has approved
    //  it -- Edge would be offered a CRX id that does not exist yet, and the app
    //  would then read its profile for it and report the extension absent.
    const src = fs.readFileSync(path.join(ROOT, 'lib', 'geo-ext.js'), 'utf8');
    eq(EDGE_STORE_ID, null, 'EDGE_STORE_ID is still null on the export');
    ok(/^const EDGE_STORE_ID = null;/m.test(src),
       'and literally null in the source -- one line to change after approval, and this ' +
       'assertion is what will fail to remind whoever changes it to look here');
    ok(/FP_GEO_EDGE_STORE_ID/.test(src),
       'the environment override exists, so the route can be exercised without editing code');
    eq(STORE_CRX.edge, 'https://edge.microsoft.com/extensionwebstorebase/v1/crx',
       "Edge Add-ons' documented CRX endpoint, exactly");
    eq(STORE_CRX.chrome, 'https://clients2.google.com/service/update2/crx',
       "the Chrome Web Store's documented CRX endpoint, exactly");
    eq(Object.keys(STORE_CRX).join(','), 'edge,chrome', 'and no third endpoint was invented');

    //  What makes install()'s target list provably the same list it was before the
    //  store code: with no store configured its filter reduces to FORCE_INSTALLABLE,
    //  and it reduces to it IN ORDER, because both are built from the same
    //  predicate over the same table.
    ok(FORCE_INSTALLABLE.every(id => POLICY_KEYS[id]),
       'every force-installable browser is policy-capable, so the wider filter cannot ' +
       'add one', FORCE_INSTALLABLE.join(','));
    eq(Object.keys(POLICY_KEYS).filter(id => FORCE_INSTALLABLE.includes(id)).join(','),
       FORCE_INSTALLABLE.join(','), 'and it cannot reorder them either');
    ok(/const route = Object\.keys\(POLICY_KEYS\)\.filter\(\s*\n\s*id => this\.storeFor\(id\) \|\| FORCE_INSTALLABLE\.includes\(id\)\);/
        .test(src), 'install() really is that filter and not a retyped copy of it');
    eq(FORCE_WORKS.join(','), 'edge',
       'Edge is still the only browser a self-hosted force-install was measured to reach');
    eq(forceWorks().length === 0 || forceWorks().join(',') === 'edge', true,
       'and on this real device that list is either empty or exactly Edge',
       forceWorks().join(','));

    const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
    ok(/knownId\(b\.id\)/.test(mainSrc),
       'the first-open card asks for the id PER BROWSER, so once Edge holds the store copy ' +
       'it is not told to go and switch on an extension that is already on');

    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
    console.log(`\n${pass}/${pass + fail} checks passed`);
    process.exit(fail ? 1 : 0);
})().catch(e => {
    console.log('ABORT: ' + e.stack);
    _setManaged(null);
    sh(`reg delete "${TEST_ROOT}" /f`);
    process.exit(3);
});
