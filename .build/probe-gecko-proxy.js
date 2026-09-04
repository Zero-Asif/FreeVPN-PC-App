'use strict';
// ════════════════════════════════════════════════════════════════════
//  probe-gecko-proxy.js -- the Gecko family's half of the tunnel, 2.0.5.
//
//  Until 2.0.5 this app's answer for "does Firefox go through Tor?" was
//  Gecko's own factory default: network.proxy.type = 5, "use system proxy
//  settings", which follows the WinINET registry value the app writes. That
//  default is real and it does work -- but it cannot be PROVED from here, and
//  two cases slip through it:
//
//    * a user who has ever opened Settings -> Network Settings and picked
//      "No proxy" or a manual proxy has type != 5 and ignores the system
//      proxy entirely. Nothing of theirs was tunnelled, and nothing said so.
//    * type 5 hands HTTP/HTTPS to the WinINET proxy with the hostname ALREADY
//      RESOLVED locally. SOCKS5 with socks_remote_dns resolves at the exit.
//
//  So 2.0.5 writes the prefs explicitly and reads them back. What this probe
//  holds the code to is the honest version of that claim -- the FILE says so:
//
//    1. geckoNoProxy() emits Gecko's format, and agrees with main.js's own
//       bypassToProxyOverride() about WHICH hosts skip Tor. Neither string is
//       valid in the other's store; the host shapes must still match.
//    2. The block carries every pref that closes a leak, with the values that
//       close it -- and geolocation stays SPOOFED, never blocked.
//    3. A write that did not land is NOT counted as coverage.
//    4. Restore hands the user's own network.proxy.* values back, verbatim.
//    5. A pre-2.0.5 fenced block is recognised and replaced, not stacked.
//    6. applyGecko() refuses when no session journal exists, so a
//       disconnected browser is never pointed at a dead port.
//
//  NOTHING on this machine is touched: profiles are real files in a temp dir
//  and browsers.detectGecko is faked. No Gecko browser is installed here --
//  detectGecko() returns [] for real -- so this is the only way the layer can
//  be gated, and that limit is stated rather than papered over.
//
//  Run:  node .build/probe-gecko-proxy.js
// ════════════════════════════════════════════════════════════════════

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const ROOT_DIR = path.join(__dirname, '..');
const { GeoSpoof } = require(path.join(ROOT_DIR, 'lib', 'geo-spoof.js'));
const browsers     = require(path.join(ROOT_DIR, 'lib', 'browsers.js'));

let pass = 0, fail = 0;
const ok = (cond, msg, extra) => {
    if (cond) { pass++; console.log('  ok   ' + msg); }
    else { fail++; console.log('  FAIL ' + msg + (extra ? '\n         ' + extra : '')); }
};

const lines = [];
const log = { debug: m => lines.push(m), info: m => lines.push(m),
              warn: (m, meta) => lines.push(String(m) + ' ' + JSON.stringify(meta || '')),
              error: m => lines.push(m), success: m => lines.push(m) };
const said = rx => lines.some(m => rx.test(String(m)));

const TMP  = fs.mkdtempSync(path.join(os.tmpdir(), 'fpgp-'));
const PROF = path.join(TMP, 'Profiles');
const P1   = path.join(PROF, 'aaa.default-release');
const P2   = path.join(PROF, 'bbb.second');
fs.mkdirSync(P1, { recursive: true });
fs.mkdirSync(P2, { recursive: true });
const cleanup = () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {} };
process.on('exit', cleanup);

const realDetect = browsers.detectGecko;
browsers.detectGecko = () => [{ id: 'firefox', name: 'Firefox', family: 'gecko',
                                exe: 'firefox.exe', dataDir: PROF }];

const COORD = { lat: 59.334591, lng: 18.063240, accuracy: 40, city: 'Stockholm' };
const PROXY = { host: '127.0.0.1', port: 9050, bypass: 'example.com, 10.0.0.5' };
const geo   = new GeoSpoof({ log, stateDir: TMP });

console.log('=== probe-gecko-proxy ===\n');
console.log('-- 1. the bypass list, in Gecko\'s own format --');
// ══ PART 1 ══
const np = GeoSpoof.geckoNoProxy(PROXY.bypass);
console.log('   ' + np);
ok(np.includes(','), 'entries are comma-separated, which is what Gecko parses');
ok(!np.includes(';'), 'NOT semicolons -- that is the WinINET form', np);
ok(!np.includes('*'), 'no `*` wildcard -- Gecko has none, and a literal * matches ' +
   'no hostname that will ever exist', np);
ok(!np.includes('<local>'), 'no <local> -- that is a WinINET token; Gecko would ' +
   'treat it as a hostname', np);
ok(/(^|,\s*)example\.com(,|$)/.test(np) && np.includes('.example.com'),
   'the bare host AND the dotted form, because Gecko\'s leading dot matches ' +
   'sub.example.com but NOT example.com itself', np);
ok(np.includes('10.0.0.5'), 'an IPv4 literal survives', np);
//  Loopback. Modern Gecko exempts it on its own (allow_hijacking_localhost
//  defaults false) -- Pale Moon and SeaMonkey predate that pref, and without
//  these three this app's OWN WebSocket on 127.0.0.1:8080 would be handed to
//  Tor and answered by nothing.
for (const lo of ['localhost', '127.0.0.1', '::1']) {
    ok(np.split(/,\s*/).includes(lo),
       lo + ' is listed unconditionally, for the forks with no loopback exemption', np);
}
ok(GeoSpoof.geckoNoProxy('').split(/,\s*/).length === 3,
   'an empty split-tunnel list still yields exactly the loopback trio',
   GeoSpoof.geckoNoProxy(''));
ok(GeoSpoof.geckoNoProxy('example.com;example.com,EXAMPLE.COM')
       .split(/,\s*/).filter(x => x === 'example.com').length === 1,
   'duplicates and case collapse to one entry');
//  Nothing that would break out of the quoted JS string literal it lands in.
//  A stray quote there is not a wrong value -- it makes the whole user.js a
//  syntax error and Gecko silently drops EVERY pref in it, including the
//  geolocation half.
const nasty = GeoSpoof.geckoNoProxy('a"b.com, c\\d.com, e\nf.com, <script>, ok.test');
ok(!/["'\\\n\r]/.test(nasty), 'a host with a quote, a backslash or a newline in it is ' +
   'dropped rather than escaped -- the pref file must not be corruptible', nasty);
ok(nasty.includes('ok.test'), 'and the good entry beside it still gets through', nasty);

//  The two stores cannot share a string, but they must agree about which hosts
//  are eligible at all. Pinned against main.js's own regexes by source text, so
//  a change to either side fails here instead of silently diverging.
const mainSrc = fs.readFileSync(path.join(ROOT_DIR, 'main.js'), 'utf8');
const gsSrc   = fs.readFileSync(path.join(ROOT_DIR, 'lib', 'geo-spoof.js'), 'utf8');
const grab = (src, name) => {
    const m = src.match(new RegExp('const ' + name + ' = (/.*/);'));
    return m ? m[1] : null;
};
const mHost = grab(mainSrc, 'BP_HOST'), mIp = grab(mainSrc, 'BP_IPV4');
const gHost = grab(gsSrc, 'HOST'),      gIp = grab(gsSrc, 'IPV4');
ok(!!mHost && !!gHost && mHost === gHost,
   'the host shape is character-for-character main.js\'s bypassToProxyOverride',
   'main: ' + mHost + '\n         gecko: ' + gHost);
ok(!!mIp && !!gIp && mIp === gIp, 'and so is the IPv4 shape',
   'main: ' + mIp + '\n         gecko: ' + gIp);

console.log('\n-- 2. what the block actually says --');
// ══ PART 2 ══
//  P1 arrives with a user.js the user wrote and a prefs.js holding their OWN
//  proxy choice -- "No proxy", the single most common non-default there is.
//  Deleting that on disconnect instead of handing it back would be this app
//  breaking a browser setting it never owned.
const USER_LINE = 'user_pref("browser.startup.homepage", "https://example.invalid/");';
const OWN_PROXY = 'user_pref("network.proxy.type", 0);';
const OWN_SOCKS = 'user_pref("network.proxy.socks", "proxy.corp.invalid");';
fs.writeFileSync(path.join(P1, 'user.js'), USER_LINE + '\r\n', 'utf8');
fs.writeFileSync(path.join(P1, 'prefs.js'),
    [USER_LINE, OWN_PROXY, OWN_SOCKS,
     'user_pref("media.peerconnection.enabled", true);',
     'user_pref("dom.webnotifications.enabled", false);'].join('\n'), 'utf8');

const plan = geo._planFirefox(COORD, null, PROXY);
ok(plan.edits.length === 2, 'one edit per profile', String(plan.edits.length));
ok(plan.proxied === true, 'the plan records that the proxy half is in it');
ok(geo._applyFirefoxPlan(plan) === 2, 'both written and read back');

const w = fs.readFileSync(path.join(P1, 'user.js'), 'utf8');
const has = s => w.includes(s);
ok(has(USER_LINE), "the user's own pref survives above our block");
//  The tunnel itself.
ok(has('user_pref("network.proxy.type", 1);'),
   'proxy.type 1 -- MANUAL. Not 5 ("use system proxy"), which is the ' +
   'undetectable default this layer exists to replace');
ok(has('user_pref("network.proxy.socks", "127.0.0.1");') &&
   has('user_pref("network.proxy.socks_port", 9050);'),
   'pointed at the Tor SOCKS port on loopback');
ok(has('user_pref("network.proxy.socks_version", 5);'),
   'SOCKS5, not 4 -- SOCKS4 cannot carry a hostname, and remote DNS below ' +
   'depends on it');
ok(has('user_pref("network.proxy.socks_remote_dns", true);'),
   'remote DNS: the NAME travels to the exit, so this machine never resolves it');
//  The leaks that survive a correct proxy setting.
ok(has('user_pref("network.proxy.failover_direct", false);'),
   'failover_direct OFF -- without it, tor.exe dying turns every request into a ' +
   'DIRECT connection with the real IP on it. That is the entire failure this ' +
   'layer exists to prevent');
ok(has('user_pref("network.trr.mode", 5);'),
   'DNS-over-HTTPS off, so socks_remote_dns is not made moot by a second resolver');
ok(has('user_pref("network.dns.disablePrefetch", true);') &&
   has('user_pref("network.predictor.enabled", false);'),
   'speculative DNS off -- the prefetcher and the predictor use the platform ' +
   'resolver, and are the one part of Gecko socks_remote_dns does not cover');
ok(has('user_pref("media.peerconnection.enabled", false);'),
   'WebRTC off: Tor\'s SOCKS5 has no UDP ASSOCIATE, so a call cannot work ' +
   'through it -- but it CAN still put the real IP in an SDP offer');
//  ...and the standing rule, in the same file.
ok(has('user_pref("geo.enabled", true);'),
   'geolocation is still ENABLED -- spoofed, never blocked');
ok(!/"geo\.enabled", false|Blocked|denied/.test(w),
   'and nothing in the block denies anything');
ok(w.includes('user_pref("network.proxy.no_proxies_on", "' + np + '");'),
   'the bypass list is the exact string geckoNoProxy produced');
ok(w.indexOf(GeoSpoof.FF_BEGIN) < w.indexOf(GeoSpoof.FF_END),
   'both fence markers, in order, so the block can be found and removed again');
//  A user.js is JavaScript. If it does not parse, Gecko drops every pref in it
//  -- including the geolocation half -- and reports nothing.
let parses = true, why = '';
try { new Function(w.replace(/user_pref/g, 'void'));
} catch (e) { parses = false; why = e.message; }
ok(parses, 'the written file is syntactically valid JS, so Gecko cannot silently ' +
   'discard the whole thing', why);

console.log('\n-- 3. a bad descriptor is refused, not interpolated --');
// ══ PART 3 ══
//  These land inside quoted string literals in a file Gecko parses. A stray
//  quote would not look like a wrong value -- it would make user.js invalid and
//  drop every pref in it. Refusing is the only safe answer; escaping would mean
//  guessing what the caller meant.
const throws = (proxy) => {
    try { GeoSpoof._ffBlock(COORD, proxy); return null; }
    catch (e) { return e.message; }
};
ok(!!throws({ host: '127.0.0.1"; evil', port: 9050 }),
   'a host carrying a quote is REFUSED');
ok(!!throws({ host: '', port: 9050 }), 'an empty host is refused');
ok(!!throws({ host: '127.0.0.1', port: 0 }), 'port 0 is refused');
ok(!!throws({ host: '127.0.0.1', port: 70000 }), 'a port above 65535 is refused');
ok(!!throws({ host: '127.0.0.1', port: '9050; evil' }),
   'a port that is not a number is refused rather than pasted in');
ok(!!throws({ host: '127.0.0.1', port: 9050.5 }), 'and a non-integer port too');
ok(throws({ host: '127.0.0.1', port: 9050 }) === null,
   'while the real descriptor is accepted');
//  Both halves are independent: a country with no coordinates on file must
//  still get the tunnel, and a caller with no tunnel must still get the spoof.
const proxyOnly = GeoSpoof._ffBlock(null, PROXY);
ok(proxyOnly.text.includes('network.proxy.type') &&
   !proxyOnly.text.includes('geo.provider.network.url'),
   'proxy without coordinates writes the tunnel and no geolocation prefs');
ok(!proxyOnly.expect.some(p => p.startsWith('geo.')),
   'and does not then demand a geolocation pref in the read-back');
const geoOnly = GeoSpoof._ffBlock(COORD, null);
ok(geoOnly.text.includes('geo.provider.network.url') &&
   !geoOnly.text.includes('network.proxy.type'),
   'coordinates without a proxy writes exactly what every build before 2.0.5 did');

console.log('\n-- 4. a write that did not land is NOT counted as coverage --');
// ══ PART 4 ══
//  Real failure modes, not invented ones: a disk that fills mid-write leaves a
//  truncated file, and an antivirus or Controlled Folder Access reverts the
//  file after the write returns cleanly. In both cases writeFileSync throws
//  NOTHING -- which is exactly why the count shown to the user has to come from
//  reading the file back, not from "the write did not fail".
const realWrite = fs.writeFileSync;
lines.length = 0;
fs.writeFileSync = function (file, data, enc) {
    if (String(file) === path.join(P1, 'user.js')) {
        //  Truncated at 200 bytes: the fence and the comments land, not one
        //  single user_pref.
        return realWrite.call(fs, file, String(data).slice(0, 200), enc);
    }
    if (String(file) === path.join(P2, 'user.js')) {
        //  Reverted to empty, the antivirus case. Our fence is not in the file.
        realWrite.call(fs, file, String(data), enc);
        return realWrite.call(fs, file, '', enc);
    }
    return realWrite.call(fs, file, data, enc);
};
const partial = geo._planFirefox(COORD, null, PROXY);
const nOk = geo._applyFirefoxPlan(partial);
fs.writeFileSync = realWrite;
ok(nOk === 0, 'neither profile is counted -- a truncated write and a reverted ' +
   'write are both uncovered', 'counted ' + nOk);
ok(said(/NOT covered and are not counted as covered anywhere/),
   'and the log says so in those words, because this number is the one the ' +
   'coverage report shows the user');
ok(said(/missing [^)]*network\.proxy\.type/),
   'the truncated file is reported by name, listing the prefs that are missing ' +
   'from it -- the tunnel among them');
ok(said(/our block is not in the file/),
   'and the reverted file by the fence that is not in it');
ok(!said(/read back from disk/),
   'nothing claimed success for either');

console.log('\n-- 5. an upgrade from a pre-2.0.5 block --');
// ══ PART 5 ══
//  A machine upgrading from 2.0.4 has the OLD fence text in its profiles:
//  "spoofed geolocation while connected", with no proxy half. 2.0.5 changed
//  that line. Matched by equality, _stripFfBlock would not recognise it, the
//  old block would be preserved as if it were the user's own text, and the new
//  one would be appended underneath -- two blocks, and the older geolocation
//  prefs winning wherever they came second.
const OLD_FENCE = '// ── FreeProxy VPN: spoofed geolocation while connected ──';
const P3 = path.join(PROF, 'ccc.upgraded');
fs.mkdirSync(P3, { recursive: true });
fs.writeFileSync(path.join(P3, 'user.js'),
    [USER_LINE, OLD_FENCE,
     'user_pref("geo.provider.network.url", "data:application/json,{OLD}");',
     'user_pref("geo.wifi.uri", "data:application/json,{OLD}");',
     GeoSpoof.FF_END, ''].join('\r\n'), 'utf8');
const upg = geo._planFirefox(COORD, null, PROXY);
geo._applyFirefoxPlan(upg);
const w3 = fs.readFileSync(path.join(P3, 'user.js'), 'utf8');
ok((w3.match(/FreeProxy VPN:/g) || []).length === 1,
   'exactly one fenced block after the upgrade -- the 2.0.4 block was recognised ' +
   'and replaced, not stacked under the new one',
   String((w3.match(/FreeProxy VPN:/g) || []).length));
ok(!w3.includes('{OLD}'), 'and none of the old block\'s values survived');
ok(w3.includes(USER_LINE), "the user's own line above it is still there");
ok(w3.includes('network.proxy.type'), 'the upgraded profile now has the tunnel too');
//  The other half of the upgrade: a 2.0.4 journal has no priorPrefs field.
//  restoreFirefox must treat that as "nothing to hand back" rather than throw.
const legacyRec = [{ dir: P3, userJs: path.join(P3, 'user.js'), existed: true,
                     prior: USER_LINE }];
let threw = '';
try { geo.restoreFirefox(legacyRec); } catch (e) { threw = e.message; }
ok(!threw, 'a journal written by 2.0.4 -- no priorPrefs, no proxied -- still restores',
   threw);
ok(fs.readFileSync(path.join(P3, 'user.js'), 'utf8').trim() === USER_LINE,
   'and restores that file exactly');

console.log('\n-- 6. restore hands the user their own proxy setting back --');
// ══ PART 6 ══
//  A fresh profile whose prefs.js carries a MANUAL CORPORATE PROXY. This is the
//  case that makes deleting-by-name wrong: on the user's own network that proxy
//  is the only route out, and a disconnect that reset it to Gecko's factory
//  default would leave them with a browser that cannot load anything -- broken
//  by this app, for a setting this app never owned.
const P4 = path.join(PROF, 'ddd.corp');
fs.mkdirSync(P4, { recursive: true });
const CORP = [
    'user_pref("network.proxy.type", 1);',
    'user_pref("network.proxy.http", "proxy.corp.invalid");',
    'user_pref("network.proxy.socks", "socks.corp.invalid");',
    'user_pref("network.proxy.socks_port", 1080);',
    'user_pref("network.trr.mode", 2);',
    'user_pref("media.peerconnection.enabled", true);',
];
fs.writeFileSync(path.join(P4, 'prefs.js'),
                 [USER_LINE].concat(CORP).join('\n') + '\n', 'utf8');
//  Only P4 this time, so the assertions below are about one file.
browsers.detectGecko = () => [{ id: 'firefox', name: 'Firefox', family: 'gecko',
                                exe: 'firefox.exe', dataDir: path.join(TMP, 'Only') }];
const ONLY = path.join(TMP, 'Only', 'ddd.corp');
fs.mkdirSync(ONLY, { recursive: true });
fs.writeFileSync(path.join(ONLY, 'prefs.js'),
                 [USER_LINE].concat(CORP).join('\n') + '\n', 'utf8');
const corpPlan = geo._planFirefox(COORD, null, PROXY);
const cRec = corpPlan.records.find(r => r.dir === ONLY);
ok(!!cRec && Array.isArray(cRec.priorPrefs) && cRec.priorPrefs.length === 5,
   'every pref this module is about to overwrite is journaled first, with the ' +
   "user's own value on it",
   cRec ? JSON.stringify(cRec.priorPrefs) : 'no record');
ok(cRec.priorPrefs.some(l => l.includes('"network.proxy.socks", "socks.corp.invalid"')),
   'their SOCKS host among them');
ok(!cRec.priorPrefs.some(l => l.includes('network.proxy.http')),
   'and network.proxy.http is NOT journaled, because this module never writes it ' +
   '-- restore must not touch what it did not change');
ok(geo._applyFirefoxPlan(corpPlan) === 1, 'the profile is written and verified');

//  A country switch in the middle. The originals must survive it: capturing
//  again here would journal OUR OWN values as if they were the user's.
const swPlan = geo._planFirefox({ lat: 1.35, lng: 103.8, accuracy: 40, city: 'Singapore' },
                                corpPlan.records, PROXY);
const sRec = swPlan.records.find(r => r.dir === ONLY);
ok(sRec.priorPrefs.some(l => l.includes('"socks.corp.invalid"')),
   'a country switch keeps the ORIGINAL journal -- it does not re-capture our own ' +
   'values and call them theirs');
geo._applyFirefoxPlan(swPlan);

//  Now Gecko's part, simulated exactly: at shutdown it writes prefs.js from
//  memory, so OUR user.js values are in there as user_pref lines. This is the
//  state a real disconnect finds, and the reason removing user.js alone is not
//  enough.
fs.writeFileSync(path.join(ONLY, 'prefs.js'),
    [USER_LINE,
     'user_pref("network.proxy.type", 1);',
     'user_pref("network.proxy.socks", "127.0.0.1");',
     'user_pref("network.proxy.socks_port", 9050);',
     'user_pref("network.proxy.socks_remote_dns", true);',
     'user_pref("network.trr.mode", 5);',
     'user_pref("media.peerconnection.enabled", false);',
     'user_pref("geo.provider.network.url", "data:application/json,{SPOOF}");',
     'user_pref("network.proxy.http", "proxy.corp.invalid");',
    ].join('\n') + '\n', 'utf8');
geo.restoreFirefox(swPlan.records);
const p4 = fs.readFileSync(path.join(ONLY, 'prefs.js'), 'utf8');
ok(!p4.includes('127.0.0.1') && !p4.includes('9050'),
   'the Tor SOCKS port is gone from prefs.js', p4);
ok(!p4.includes('{SPOOF}'), 'and so is the spoofed location');
ok(p4.includes('user_pref("network.proxy.socks", "socks.corp.invalid");'),
   "their own SOCKS host is BACK, verbatim -- not deleted, not defaulted");
ok(p4.includes('user_pref("network.trr.mode", 2);') &&
   !p4.includes('"network.trr.mode", 5'),
   'their DoH setting is back too, and ours is gone');
ok(p4.includes('user_pref("media.peerconnection.enabled", true);') &&
   !p4.includes('"media.peerconnection.enabled", false'),
   'WebRTC is switched back ON, because they had it on');
ok(p4.includes('user_pref("network.proxy.http", "proxy.corp.invalid");'),
   'the pref this module never wrote was never touched');
ok((p4.match(/network\.proxy\.socks"/g) || []).length === 1,
   'and each pref appears once -- ours filtered out before theirs was appended');
ok(!fs.existsSync(path.join(ONLY, 'user.js')),
   'the user.js this app created is deleted, not left behind pointing at a dead port');

console.log('\n-- 7. no session, no proxy pref --');
// ══ PART 7 ══
const JOURNAL = path.join(TMP, 'geo-restore.json');
const rm = () => { try { fs.unlinkSync(JOURNAL); } catch (e) {} };

//  applyGecko() is what a split-tunnel edit calls while the session is up. Its
//  refusal is not defensive tidiness: writing network.proxy.type = 1 with no
//  tunnel running points the browser at a port nothing is listening on, and the
//  user's browser stops working with no clue why.
rm();
lines.length = 0;
ok(geo.applyGecko(COORD, PROXY) === 0,
   'with NO journal on disk it writes nothing and says zero');
ok(said(/no active session to keep in step with/), 'and names the reason');
ok(!fs.existsSync(path.join(ONLY, 'user.js')), 'the profile is still untouched');

//  pendingOnly is the shape restoreAll() leaves when a browser was still open
//  and its site permissions could not be handed back yet. It means DISCONNECTED
//  with leftovers -- not connected.
fs.writeFileSync(JOURNAL, JSON.stringify(
    { createdAt: new Date().toISOString(), pendingOnly: true,
      policy: [], profiles: [{ dir: 'x' }], windows: null, firefox: [] }), 'utf8');
ok(geo.applyGecko(COORD, PROXY) === 0,
   'a pendingOnly journal is refused too -- that is a disconnected machine with ' +
   'leftovers, not a live session');
ok(!fs.existsSync(path.join(ONLY, 'user.js')), 'still untouched');

//  And with a real session journal it does the work.
fs.writeFileSync(JOURNAL, JSON.stringify(
    { createdAt: new Date().toISOString(), policy: [], profiles: [],
      windows: null, firefox: [] }), 'utf8');
ok(geo.applyGecko(COORD, PROXY) === 1, 'with a live session journal it applies');
ok(fs.readFileSync(path.join(ONLY, 'user.js'), 'utf8')
     .includes('user_pref("network.proxy.socks_port", 9050);'),
   'and the tunnel is in the file');
ok(geo.applyGecko(null, null) === 0,
   'called with neither half it is a no-op, not an empty block written over the ' +
   "user's file");

console.log('\n-- 8. applyAll and status(), end to end --');
// ══ PART 8 ══
rm();
//  The Windows platform half is stubbed out for this section, and this is not
//  the probe going easy on itself: _shieldWindowsNow() adds a real machine-wide
//  firewall rule and clearBlockingPolicy() deletes real HKLM policy values.
//  Neither has anything to do with the Gecko step, both belong to this machine
//  rather than to a temp directory, and .build/test-geo-real.js is where they
//  are exercised for real. What is left running here is the orchestration:
//  which step applyAll decides to take, and what it writes in the journal.
const savedShield = geo._shieldWindowsNow;
const savedPolicy = geo.clearBlockingPolicy;
const savedSnap   = geo._snapshotWindows;
geo._shieldWindowsNow   = () => ['stubbed for this probe'];
geo.clearBlockingPolicy = () => 0;
geo._snapshotWindows    = () => ({ stubbed: true });
//  A server code with no coordinates on file must still get the tunnel. This is
//  the reason the Gecko step is gated on `coord || proxy` and not on `coord`:
//  gated on coordinates alone, that country would leave the one browser family
//  with no extension as the only thing on the machine outside the tunnel.
const jj = geo.applyAll(null, PROXY);
const u4 = fs.readFileSync(path.join(ONLY, 'user.js'), 'utf8');
ok(u4.includes('network.proxy.type') && !u4.includes('geo.provider.network.url'),
   'a country with no coordinates on file still gets the proxy prefs');
ok(jj.firefox.length === 1 && jj.firefox[0].proxied === true,
   'and the journal records the profile as proxied');
const st = geo.status();
ok(st.active === true, 'status() says the session is active');
ok(st.geckoProxied === 1, 'geckoProxied counts it', String(st.geckoProxied));
ok(st.geckoSpoofed === 1, 'geckoSpoofed still counts the profile');
//  Counted from the record, never from "we are connected so it must be on".
jj.firefox[0].proxied = false;
fs.writeFileSync(JOURNAL, JSON.stringify(jj), 'utf8');
ok(geo.status().geckoProxied === 0,
   'a profile the proxy was NOT written into is not counted as proxied, even ' +
   'mid-session');
geo.restoreFirefox(jj.firefox);
rm();
geo._shieldWindowsNow   = savedShield;
geo.clearBlockingPolicy = savedPolicy;
geo._snapshotWindows    = savedSnap;

console.log('\n-- 9. the coverage claim this machine can and cannot support --');
//  Said out loud rather than implied by a green run. Two limits, both measured:
ok(realDetect.call(browsers).length === 0,
   'NO Gecko browser is installed on this machine, so every check above ran ' +
   'against real files in a temp directory with detectGecko faked -- the layer ' +
   'is NOT verified against a live Firefox here',
   JSON.stringify(realDetect.call(browsers)));
ok(gsSrc.includes('Gecko applies user.js at startup, so this takes ') &&
   gsSrc.includes('effect the next time the browser is opened'),
   'and the success log says the second limit in as many words: user.js is read ' +
   'ONCE, at startup, so a browser that was already open is covered from its ' +
   'next start -- not now');

browsers.detectGecko = realDetect;
cleanup();
console.log('\n' + pass + '/' + (pass + fail) + ' checks passed');
if (fail) { console.log('FAIL'); process.exitCode = 1; }
else console.log('PASS');






