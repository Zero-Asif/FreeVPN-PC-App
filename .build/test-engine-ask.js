'use strict';
// ════════════════════════════════════════════════════════════════════
//  .build/test-engine-ask.js  --  the question that used to not be asked.
//
//  The report was one sentence: "eka ekai revart hoye geche rocket kono blast
//  charai kono pop up o aslona". A switch to a country whose engine would not
//  bootstrap put the user back on the old country with nothing on screen and
//  nothing asked -- the silent substitution this app spends hundreds of lines
//  refusing, on the one path nobody had checked.
//
//  What has to be true now, and is checked here:
//
//    1. THE OPTIONS ARE REAL. askEngineFailed is lifted out of main.js and run
//       with stubs, so this reads the shipped option list rather than a
//       description of it: `wait` always, `revert` only on a switch that has
//       somewhere to go back to, `auto` only when a nearest country exists,
//       `cancel` always last, no default answer.
//
//    2. REVERTING IS AN ANSWER, NOT A REFLEX. `status: 'revert'` may have
//       exactly one producer in main.js, and it must sit inside the branch that
//       tests the user's own pick. switch-vpn must return every other failure
//       as the failure it is.
//
//    3. THE ROCKET BLASTS AND THE TUNNEL IS DOWN BEFORE THE QUESTION. killTor()
//       and the 'unavailable' progress must both come before the ask, or a page
//       could leave through a half-built route while the dialog is up.
//
//  Nothing here starts Tor, opens a window or touches the network.
// ════════════════════════════════════════════════════════════════════
const fs   = require('fs');
const path = require('path');
const { literalAt } = require('./geo-from-main.js');

const ROOT = path.join(__dirname, '..');
const src  = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
    if (cond) { pass++; console.log('  ok   ' + name); }
    else { fail++; console.log('  FAIL ' + name + (extra ? '  -- ' + extra : '')); }
};

// ── lift the real function, do not describe it ──────────────────────
//
//  askEngineFailed is a closure inside main.js: it cannot be required, and a
//  copy of it here would be a third implementation able to pass while the
//  shipped one was wrong. So its own text is sliced out and given the two
//  things it closes over -- ccName and askUser -- as stubs.
const AT = src.indexOf('async function askEngineFailed(');
if (AT < 0) { console.log('ABORT: main.js no longer declares askEngineFailed'); process.exit(3); }
//  Past the parameter list first. literalAt() takes the next `{`, and the next
//  `{` after the name is the destructured options argument -- slicing from
//  there ends the text in the middle of the signature.
const bodyStart = (() => {
    let depth = 0;
    for (let i = src.indexOf('(', AT); i < src.length; i++) {
        if (src[i] === '(') depth++;
        else if (src[i] === ')' && --depth === 0) return i + 1;
    }
    throw new Error('askEngineFailed has no closing paren');
})();
const body = literalAt(src, bodyStart);
const fnText = src.slice(AT, src.indexOf(body, bodyStart) + body.length);

let sent = null;
const make = () => new Function('ccName', 'askUser', `
    ${fnText}
    return askEngineFailed;
`)(cc => ({ lu: 'Luxembourg', de: 'Germany', nl: 'Netherlands', ge: 'Georgia' }[cc]
           || String(cc).toUpperCase()),
   (payload, opts) => { sent = { payload, opts }; return payload.options[0].id; });

const askEngineFailed = make();
const call = async (cc, o) => { sent = null; await askEngineFailed(cc, o); return sent; };

(async () => {
    console.log('── the options, read out of the shipped function ──');
    {
        //  A fresh connect: no country to go back to and no nearest one. Even
        //  here the user must be given a real choice, not an OK button.
        const s = await call('lu', { reason: 'timeout', percent: 5 });
        const ids = s.payload.options.map(o => o.id);
        ok(ids[0] === 'wait', 'the first option is always "keep trying"', JSON.stringify(ids));
        ok(ids[ids.length - 1] === 'cancel', 'and the last is always cancel');
        ok(!ids.includes('revert'),
           'a FRESH connect is never offered a revert -- there is nowhere to go back to',
           JSON.stringify(ids));
        ok(!ids.includes('auto'), 'and no "nearest country" when none was found');
        ok(ids.length === 2, 'so the minimum is still two real answers', JSON.stringify(ids));
        ok(s.opts && s.opts.defaultAnswer === null,
           'no default answer -- there is no safe guess to make on the user\'s behalf',
           JSON.stringify(s.opts));
        ok(s.payload.variant === 'choice' && s.payload.cc === 'lu',
           'it goes up as a choice card for the country that failed');
        ok(/Could not connect through Luxembourg/.test(s.payload.title),
           'the title names the country, not an error code', s.payload.title);
    }
    {
        //  The reported case: a SWITCH away from a working country. This is the
        //  one that used to revert on its own.
        const s = await call('lu', { reason: 'stall', percent: 10, oldCc: 'de',
                                     nearest: { cc: 'nl', km: 320 } });
        const ids = s.payload.options.map(o => o.id);
        ok(ids.length === 4 && ids.join(',') === 'wait,revert,auto,cancel',
           'a switch with somewhere to go back to and a neighbour offers all four',
           JSON.stringify(ids));
        ok(ids.length >= 3,
           'which is the three-or-more the report asked for, plus cancel');
        const rev = s.payload.options.find(o => o.id === 'revert');
        ok(/Go back to Germany/.test(rev.label), 'revert names the country by name',
           rev.label);
        ok(/not connected/.test(rev.hint),
           'and says plainly that the country they asked for is not connected', rev.hint);
        const auto = s.payload.options.find(o => o.id === 'auto');
        ok(/Netherlands/.test(auto.label) && /320 km/.test(auto.label),
           'the nearest option names the country AND the distance', auto.label);
        ok(/keeps looking for Luxembourg/.test(auto.hint),
           'and promises to keep looking for the one they actually chose', auto.hint);
        ok(s.payload.options.every(o => o.id && o.label && o.hint),
           'every option has an id, a label and a hint -- nothing is unexplained');
        ok(new Set(ids).size === ids.length, 'and no id is repeated');
    }
    {
        const s = await call('lu', { reason: 'timeout', percent: 5, oldCc: 'de' });
        const ids = s.payload.options.map(o => o.id);
        ok(ids.join(',') === 'wait,revert,cancel',
           'a switch with no neighbour available still offers three', JSON.stringify(ids));
    }

    console.log('\n── the body text tells them which failure this is ──');
    {
        const cfg = await call('lu', { reason: 'config', percent: 0 });
        ok(/fault in the app, not in your connection/.test(cfg.payload.body),
           'a rejected config is owned as the app\'s fault', cfg.payload.body);
        const late = await call('lu', { reason: 'stall', percent: 65 });
        ok(/reached the network but could not finish building a circuit/.test(late.payload.body) &&
           /65%/.test(late.payload.body),
           'a 65% stall says Tor was reached and quotes the percentage', late.payload.body);
        const early = await call('lu', { reason: 'timeout', percent: 5 });
        ok(/could not reach the Tor network at all/.test(early.payload.body) &&
           /blocks Tor/.test(early.payload.body),
           'a 5% stall points at this PC\'s connection instead', early.payload.body);
        for (const [what, s] of [['config', cfg], ['65%', late], ['5%', early]])
            ok(/[Nn]othing has been connected/.test(s.payload.body),
               `and every one of them states that nothing was connected (${what})`);
    }

    console.log('\n── detection point C: the order of operations ──');
    {
        const c = src.indexOf('Detection point C');
        ok(c > 0, 'main.js still marks the detection point');
        const seg = src.slice(c, src.indexOf('const pick = await askEngineFailed(', c));
        ok(/killTor\(\);/.test(seg),
           'Tor is killed BEFORE the question goes up, not after it is answered');
        ok(/'unavailable'\)/.test(seg),
           'and the progress line goes to "unavailable" -- the rocket blasts where it is');
        ok(/Logger\.error\('Connection failed'/.test(seg),
           'the failure is still logged with its reason and percentage');
        ok(/isSwitch && oldServerCode && oldServerCode !== serverCode/.test(seg),
           'the revert target exists only on a real switch to a DIFFERENT country');
        ok(/nearestExitCountries\(requestedCode, exitCapacityStats\(\)/.test(seg),
           'the neighbour is computed from live capacity, against what they REQUESTED');
        ok(/exclude: \[\.\.\.tried\]/.test(seg),
           'and never suggests a country this attempt has already burned');
    }

    console.log('\n── reverting is an answer, and only an answer ──');
    {
        const producers = [...src.matchAll(/status:\s*'revert'/g)];
        ok(producers.length === 1, 'exactly one place in main.js can return status revert',
           String(producers.length));
        const before = src.slice(Math.max(0, producers[0].index - 400), producers[0].index);
        ok(/if \(pick === 'revert' && backTo\)/.test(before),
           'and it sits inside the branch that tests the user\'s own pick', before.slice(-120));
        ok(/revertTo: backTo/.test(src.slice(producers[0].index, producers[0].index + 200)),
           'it hands back WHERE to revert to, so the caller invents nothing');
    }
    {
        const h = src.indexOf("ipcMain.handle('switch-vpn'");
        ok(h > 0, 'switch-vpn is still the handler');
        const seg = src.slice(h, src.indexOf('});', src.indexOf('catch (e)', h)));
        ok(/if \(r\.status !== 'revert'\) return r;/.test(seg),
           'switch-vpn reverts on NOTHING except that answer');
        ok(/if \(r\.status === 'cancelled'\) return r;/.test(seg),
           'and a cancel is passed through as the decision it is');
        ok(seg.indexOf("r.status !== 'revert'") < seg.indexOf('establishConnection({\n'
            .slice(0, 20), seg.indexOf("r.status !== 'revert'")) + 1 ||
           /!== 'revert'\) return r;[\s\S]{0,400}establishConnection\(\{/.test(seg),
           'the second establishConnection is only reachable past that guard');
    }

    console.log('\n── what each answer actually does ──');
    {
        const c = src.indexOf('Detection point C');
        const seg = src.slice(c, src.indexOf('dnsViaTor     =', c));
        ok(/if \(pick === 'wait'\)[\s\S]{0,900}?continue;/.test(seg),
           '"keep trying" loops the whole attempt again rather than resuming one');
        ok(/refreshRelayIndex\(\{ viaTor: false, force: true \}\)/.test(seg),
           'and re-reads the live relay list first, so a relay that came back is used');
        ok(/if \(pick === 'auto' && nearNow\)[\s\S]{0,600}?autoGranted = true;/.test(seg),
           '"nearest country" is recorded as GRANTED, not assumed');
        ok(/watchFor\s+= requestedCode;/.test(seg),
           'and it keeps watching for the country they originally asked for');
        ok(/tried\.add\(serverCode\)/.test(seg),
           'the substitute is marked tried, so it cannot be suggested twice');
        ok(/return await cancelConnect\(pick[\s\S]{0,200}no surface was left/.test(seg),
           'cancel -- and a vanished window -- both take the machine back to normal');
    }

    console.log('\n── the card that shows it ──');
    {
        const r = fs.readFileSync(path.join(ROOT, 'renderer.js'), 'utf8');
        ok(/ipcRenderer\.on\('ask-user',/.test(r), 'the renderer listens for ask-user');
        ok(/btn\.dataset\.answer = opt\.id;/.test(r),
           'each button carries the option id it will send back');
        ok(/send\('ask-user-answer', \{ id, answer: btn\.dataset\.answer \}\)/.test(r),
           'and the answer sent back is that id, not the label text');
        ok(/if \(!opt \|\| !opt\.id\) return;/.test(r),
           'an option with no id is skipped rather than drawn as a dead button');
        ok(/\/\^\(cancel\|stop\)\$\/\.test\(opt\.id\)/.test(r),
           'cancel is styled as the destructive choice');
    }

    console.log(`\n${pass}/${pass + fail} checks passed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.log('ABORT: ' + e.stack); process.exit(3); });
