'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/test-geo-gecko.js
//
//  The Gecko layer of lib/geo-spoof.js, exercised against real files in a
//  temp directory -- no browser installed, nothing outside the temp dir
//  touched.
//
//  Why this exists: this layer used to walk %APPDATA%\Mozilla\Firefox\
//  Profiles directly, and on THIS machine that directory is a September-2024
//  leftover with no firefox.exe anywhere. It wrote spoofed prefs into dead
//  profiles and the coverage report then said "Firefox: spoofed" -- a claim
//  about a browser that cannot open a page. It is now driven by
//  lib/browsers.js, which requires a verified executable, so the checks
//  below pin down BOTH halves: it must spoof a real profile completely, and
//  it must refuse to touch an orphan.
//
//  The "browser is running" path is exercised for real rather than mocked:
//  the fake browser's image name is node.exe, which is this very process, so
//  processRunning() genuinely returns true.
// ════════════════════════════════════════════════════════════════════
const fs = require('fs');
const os = require('os');
const path = require('path');

const browsers = require('../lib/browsers');
const { GeoSpoof } = require('../lib/geo-spoof');

let pass = 0, fail = 0;
const ok = (cond, msg, extra) => {
    if (cond) { pass++; console.log('  ok   ' + msg); }
    else { fail++; console.log('  FAIL ' + msg + (extra ? '\n         ' + extra : '')); }
};

const lines = [];
const log = {
    debug: m => lines.push(m), info: m => lines.push(m), warn: m => lines.push(m),
    error: m => lines.push(m), success: m => lines.push(m),
};
const said = rx => lines.some(m => rx.test(String(m)));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fpgk-'));
const ROOT = path.join(TMP, 'Profiles');
const P1 = path.join(ROOT, 'abc.default-release');
const P2 = path.join(ROOT, 'xyz.second');
fs.mkdirSync(P1, { recursive: true });
fs.mkdirSync(P2, { recursive: true });

//  P1 has a user.js the user wrote and a prefs.js the browser wrote.
const USER_LINE = 'user_pref("browser.startup.homepage", "https://example.invalid/");';
fs.writeFileSync(path.join(P1, 'user.js'), USER_LINE + '\r\n', 'utf8');
fs.writeFileSync(path.join(P1, 'prefs.js'),
    ['user_pref("browser.startup.homepage", "https://example.invalid/");',
     'user_pref("geo.provider.network.url", "https://location.services.mozilla.com/v1/geolocate");',
     'user_pref("geo.wifi.uri", "https://location.services.mozilla.com/v1/geolocate");',
     'user_pref("dom.webnotifications.enabled", false);'].join('\n'), 'utf8');

const COORD = { lat: 49.611621, lng: 6.131935, accuracy: 40, city: 'Luxembourg' };

//  A fake installed Gecko browser pointing at the temp profiles. lib/browsers
//  is required by lib/geo-spoof as a module object, so replacing the function
//  on it is what the code under test actually calls.
const fake = (exe) => [{ id: 'firefox', name: 'Firefox', family: 'gecko',
                         exe, dataDir: ROOT }];
const realDetect = browsers.detectGecko;
browsers.detectGecko = () => fake('firefox.exe');

const cleanup = () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {} };
process.on('exit', cleanup);

const geo = new GeoSpoof({ log, stateDir: TMP });

console.log('── it finds the profiles of an INSTALLED browser ──');
const profs = geo._geckoProfiles();
ok(profs.length === 2, 'both profile directories found', JSON.stringify(profs));
ok(profs.every(p => p.browser === 'firefox' && p.exe === 'firefox.exe'),
   'each profile carries the browser it belongs to, so restore knows what to check');

console.log('');
console.log('── ...and NOTHING when the browser is not installed ──');
browsers.detectGecko = () => [];
ok(geo._geckoProfiles().length === 0,
   'an orphaned profile root is not offered -- this is the dead-Firefox bug');
const orphanPlan = geo._planFirefox(COORD, null);
ok(orphanPlan.edits.length === 0, 'and no edits are planned for it');
ok(geo._applyFirefoxPlan(orphanPlan) === 0, 'and nothing is written');
ok(fs.readFileSync(path.join(P1, 'user.js'), 'utf8').trim() === USER_LINE,
   'the untouched user.js is byte-identical');
browsers.detectGecko = () => fake('firefox.exe');

console.log('');
console.log('── plan + apply ──');
const plan = geo._planFirefox(COORD, null);
ok(plan.edits.length === 2, 'one edit per profile');
ok(JSON.stringify(plan.browsers) === '["Firefox"]',
   'the plan names the browser for the log line', JSON.stringify(plan.browsers));
const rec1 = plan.records.find(r => r.dir === P1);
const rec2 = plan.records.find(r => r.dir === P2);
ok(rec1 && rec1.existed === true && rec1.prior.trim() === USER_LINE,
   'the pre-existing user.js is recorded verbatim BEFORE anything is written');
ok(rec2 && rec2.existed === false, 'a profile with no user.js is recorded as not existing');
ok(plan.records.every(r => r.browser === 'firefox'), 'records carry the browser id');

ok(geo._applyFirefoxPlan(plan) === 2, 'both profiles written');
const w1 = fs.readFileSync(path.join(P1, 'user.js'), 'utf8');
ok(w1.includes(USER_LINE), "the user's own pref survived -- it is kept above our block");
ok(w1.includes('geo.provider.network.url') && w1.includes('data:application/json,'),
   'the spoof is a data: URL on the documented network-provider pref');
ok(w1.includes('49.611621') && w1.includes('6.131935'),
   'the block carries the connected country\'s real coordinates');
ok(w1.includes('geo.wifi.uri'),
   'the pre-Firefox-74 name is written too, so old forks are covered');
ok(w1.includes('user_pref("geo.enabled", true);'),
   'geolocation stays ENABLED -- this is a spoof, never a block');
ok(!/Blocked|denied|"geo.enabled", false/.test(w1), 'nothing in the block denies anything');
ok(w1.indexOf(GeoSpoof.FF_BEGIN) < w1.indexOf(GeoSpoof.FF_END),
   'our block is fenced by both markers so it can be found again');

console.log('');
console.log('── a country switch replaces the block and keeps the ORIGINAL backup ──');
const plan2 = geo._planFirefox({ lat: 1.352, lng: 103.82, accuracy: 40, city: 'Singapore' },
                               plan.records);
ok(geo._applyFirefoxPlan(plan2) === 2, 'rewritten for the new country');
const w2 = fs.readFileSync(path.join(P1, 'user.js'), 'utf8');
ok(w2.includes('1.352000') && !w2.includes('49.611621'), 'only the new coordinates remain');
ok((w2.match(/FreeProxy VPN: spoofed/g) || []).length === 1,
   'exactly one block -- the old one was replaced, not stacked');
ok(w2.includes(USER_LINE), "the user's own pref is still there after the switch");
const r2 = plan2.records.find(r => r.dir === P1);
ok(r2.prior.trim() === USER_LINE,
   'the backup is still the ORIGINAL file, not the spoofed one');

console.log('');
console.log('── a running browser is skipped, not edited underneath ──');
//  node.exe is this process, so this is a real "the browser is running" case.
browsers.detectGecko = () => fake('node.exe');
lines.length = 0;
const busy = geo._planFirefox(COORD, plan2.records);
ok(busy.edits.length === 0, 'no edits planned while the browser is running');
ok(said(/is running/), 'the user is told why, and how to pick it up');
ok(busy.records.length === plan2.records.length,
   'the previous records are KEPT, so what was already spoofed still gets restored');
browsers.detectGecko = () => fake('firefox.exe');

console.log('');
console.log('── restore is exact ──');
geo.restoreFirefox(plan2.records);
ok(fs.readFileSync(path.join(P1, 'user.js'), 'utf8').trim() === USER_LINE,
   'a user.js that existed is restored to its exact prior contents');
ok(!fs.existsSync(path.join(P2, 'user.js')),
   'a user.js we created is deleted, not left empty');
const pj = fs.readFileSync(path.join(P1, 'prefs.js'), 'utf8');
ok(!pj.includes('geo.provider.network.url') && !pj.includes('geo.wifi.uri'),
   'prefs.js is scrubbed too -- user.js values are copied there on every start, ' +
   'so removing user.js alone would leave the spoof behind');
ok(pj.includes('dom.webnotifications.enabled') && pj.includes('browser.startup.homepage'),
   "every other pref in prefs.js is untouched");

console.log('');
console.log('── restore works from an OLD journal with no browser field ──');
fs.writeFileSync(path.join(P1, 'user.js'), USER_LINE + '\r\n', 'utf8');
const legacy = [{ dir: P1, userJs: path.join(P1, 'user.js'), existed: true, prior: USER_LINE }];
geo.restoreFirefox(legacy);
ok(fs.readFileSync(path.join(P1, 'user.js'), 'utf8').trim() === USER_LINE,
   'a record written before this became family-aware still restores');

console.log('');
console.log('── status() reports the family, and only what is real ──');
browsers.detectGecko = realDetect;
fs.writeFileSync(path.join(TMP, 'geo-restore.json'), JSON.stringify(
    { createdAt: new Date().toISOString(), policy: [], profiles: [], windows: null,
      firefox: [{ dir: P1, userJs: path.join(P1, 'user.js'), browser: 'waterfox' }] }), 'utf8');
const st = geo.status();
ok(st.geckoSpoofed === 1, 'geckoSpoofed counts profiles');
ok(JSON.stringify(st.geckoBrowsers) === '["Waterfox"]',
   'a fork is named as itself, not as Firefox', JSON.stringify(st.geckoBrowsers));
ok(st.firefoxSpoofed === 1, 'the old field name still answers, for an installed build');

cleanup();
console.log('');
console.log(`${pass}/${pass + fail} checks passed` + (fail ? `  (${fail} FAILED)` : ''));
process.exit(fail ? 1 : 0);
