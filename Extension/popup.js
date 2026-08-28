// ════════════════════════════════════════════════════════════════════
//  popup.js -- the popup is a VIEW of the desktop app, not a second brain.
//
//  Every fact on screen -- connected or not, which country, the kill switch,
//  the bypass list, the connect progress, the coordinates pages are being
//  given, the moment the tunnel came up -- arrives from the app over the
//  WebSocket that background.js holds. The popup keeps no opinion of its own
//  about any of it, because the app is what actually holds the tunnel: a
//  second copy of that state here could only ever disagree with the real one,
//  and a popup that disagrees with the app is a popup that lies.
//
//  The one piece of local state is `awaiting`: the gap between handing a
//  command to the app and the app's answer coming back. It disables the
//  controls for that gap and claims nothing about the outcome.
// ════════════════════════════════════════════════════════════════════
'use strict';

const $ = id => document.getElementById(id);
const el = {
    hdrSub: $('hdrSub'), dot: $('dot'), dot2: $('dot2'), gate: $('gate'),
    stateText: $('stateText'), timer: $('timer'),
    geoBox: $('geoBox'), geoPlace: $('geoPlace'), geoCoords: $('geoCoords'),
    dd: $('dd'), picked: $('picked'), pickedCc: $('pickedCc'), pickedName: $('pickedName'),
    search: $('search'), list: $('list'),
    ask: $('ask'), askCc: $('askCc'), askTitle: $('askTitle'), askBody: $('askBody'),
    askNote: $('askNote'), askOpts: $('askOpts'), askDots: $('askDots'), askFoot: $('askFoot'),
    prog: $('prog'), fill: $('fill'), progMsg: $('progMsg'), progPct: $('progPct'),
    act: $('act'), ks: $('ks'), bypass: $('bypass'), toast: $('toast'),
};

let st = {
    appRunning: false, connected: false, busy: false, serverCode: 'us',
    killSwitch: false, bypassList: '', servers: {}, progress: null,
    since: null, geo: null, ask: null,
};

//  Command handed over, answer not back yet. Capped in case the app dies in
//  between, so the controls can never be disabled for good.
let awaiting = 0;
const AWAIT_MS = 8000;

//  A finished progress bar stays up briefly, the way the app window's does,
//  instead of vanishing the instant the tunnel is up.
let outcomeUntil = 0, outcomeKey = '';
let toastTimer = null;

let names = null;
try { names = new Intl.DisplayNames(['en'], { type: 'region' }); } catch (e) {}
function countryName(cc) {
    const u = (cc || '').toUpperCase();
    if (!u) return '';
    try { return (names && names.of(u)) || u; } catch (e) { return u; }
}

//  The REAL flag, out of this package's own flags/ folder -- flags/<cc>.svg,
//  packed into the CRX, so drawing it needs no network and no host permission.
//  The app window draws the identical file from vendor/flags/.
//
//  The two-letter badge is still painted UNDERNEATH: Windows Chrome has no
//  flag-emoji glyphs, and layering means no list of which flags exist and no
//  error handler is needed -- a missing file leaves an <img> that draws nothing
//  (alt="" keeps Chromium from showing a broken-image icon) and the badge shows
//  through. One deterministic hue per country, the same formula the app uses.
//
//  createElement, never innerHTML: `cc` arrives over a socket. It is also
//  checked against /^[a-z]{2}$/ before it can reach a URL.
function paintCc(node, cc) {
    const u = (cc || '??').toUpperCase();
    //  render() runs once a second. Rebuilding the <img> every time would make
    //  the flag flicker for no reason, so an unchanged code is a no-op.
    if (node.dataset.painted === u) return;
    node.dataset.painted = u;
    let h = 0;
    for (let i = 0; i < u.length; i++) h = (h * 131 + u.charCodeAt(i)) % 360;
    node.textContent = u;
    node.title = u;
    node.style.background =
        `linear-gradient(135deg, hsl(${h} 60% 44%), hsl(${(h + 38) % 360} 64% 28%))`;
    if (!/^[a-z]{2}$/i.test(cc || '')) return;
    const img = document.createElement('img');
    img.alt = '';
    img.draggable = false;
    img.src = chrome.runtime.getURL('flags/' + String(cc).toLowerCase() + '.svg');
    node.appendChild(img);
}

//  The app window's own capacity thresholds, so a country that reads "fast"
//  there cannot read "slow" here. The label is the exit-relay count from the
//  live relay index -- a number the app measured, not a latency nobody timed.
function grade(s) {
    const count = (s && s.count) || 0;
    const mbps = ((s && s.bandwidth) || 0) / 1e6;
    if (count > 200 || mbps > 50) return 'fast';
    if (count > 50 || mbps > 10) return 'busy';
    return 'slow';
}
function capacity(s) {
    const c = (s && s.count) || 0;
    return c === 1 ? '1 exit' : c + ' exits';
}

function elapsed(ms) {
    const t = Math.max(0, Math.floor(ms / 1000));
    const p = n => String(n).padStart(2, '0');
    return `${p(Math.floor(t / 3600))}:${p(Math.floor(t / 60) % 60)}:${p(t % 60)}`;
}
// ── the app's question ──────────────────────────────────────────────
//  The app stops and ASKS when the country the user picked has no reachable
//  exit node, instead of quietly connecting them somewhere else. Two shapes,
//  both written entirely by the app:
//
//    variant 'choice' -- the question, with one button per option
//    variant 'live'   -- "still working on the choice you already made", with
//                        a Stop option, shown while the app keeps trying
//
//  Rebuilt only when the question itself changes. render() runs once a second,
//  and re-creating the buttons under a finger that is already coming down on
//  one would swallow the click that was in progress.
let askPainted = null;

function paintAsk(ask) {
    if (askPainted === ask.id) return;
    askPainted = ask.id;
    const live = ask.variant === 'live';

    if (ask.cc) { el.askCc.style.display = ''; paintCc(el.askCc, ask.cc); }
    else        { el.askCc.style.display = 'none'; }

    el.askTitle.textContent = ask.title || '';
    el.askBody.textContent  = ask.body || '';
    el.askNote.textContent  = ask.note || '';
    el.askNote.classList.toggle('show', !!ask.note);
    /* ASK_OPTS_HERE */

    //  createElement, never innerHTML -- every string in here arrived over the
    //  socket, and a label pasted into markup is how a popup gets its own XSS.
    el.askOpts.textContent = '';
    (ask.options || []).forEach((opt, i) => {
        if (!opt || !opt.id) return;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'opt' + (i === 0 && !live ? ' primary' : '') +
                        (/^(cancel|stop)$/.test(opt.id) ? ' danger' : '');
        btn.dataset.answer = opt.id;
        const lb = document.createElement('span');
        lb.className = 'lb';
        lb.textContent = opt.label || opt.id;
        btn.appendChild(lb);
        if (opt.hint) {
            const ht = document.createElement('span');
            ht.className = 'ht';
            ht.textContent = opt.hint;
            btn.appendChild(ht);
        }
        el.askOpts.appendChild(btn);
    });

    el.askDots.classList.toggle('show', live);
    el.askFoot.textContent = live
        ? 'Nothing is connected while this runs.'
        : 'Nothing is connected, and no country has been picked for you.';
}

// ── the whole UI, derived from `st` in one place ─────────────────────
function render() {
    const pending = awaiting > Date.now();
    const busy = !!st.busy || pending;
    const off = !st.appRunning;
    //  A question the app is BLOCKED on outranks the progress bar in the
    //  header, because "Connecting..." would be untrue while the engine is
    //  sitting still waiting to be told which country to connect to.
    const ask = (!off && st.ask && st.ask.id) ? st.ask : null;
    const askLive = !!ask && ask.variant === 'live';

    el.gate.classList.toggle('show', off);

    let cls = '', text, sub;
    if (off) {
        cls = 'offline';
        text = 'App not running';
        sub = 'Start FreeProxy VPN on this PC';
    } else if (ask) {
        cls = 'connecting';
        text = askLive ? 'Still trying...' : 'Waiting for your answer';
        sub  = askLive ? 'Working on the choice you made'
                       : 'The app needs an answer below';
    } else if (busy) {
        cls = 'connecting';
        text = st.connected ? 'Reconfiguring...' : 'Connecting...';
        sub = 'Working with the app';
    } else if (st.connected) {
        cls = 'connected';
        text = 'Protected - ' + countryName(st.serverCode);
        sub = 'This browser goes through the app\'s Tor engine';
    } else {
        text = 'Not connected';
        sub = 'App running - tunnel off';
    }
    el.dot.className = 'dot ' + cls;
    el.dot2.className = 'dot ' + cls;
    el.stateText.textContent = text;
    el.hdrSub.textContent = sub;

    //  The clock reads the app's own connect timestamp. Timing it here would
    //  drift by however long this service worker had been asleep.
    el.timer.textContent = (st.connected && st.since) ? elapsed(Date.now() - st.since) : '';

    const g = st.geo;
    if (st.connected && g && typeof g.lat === 'number' && typeof g.lng === 'number') {
        el.geoBox.classList.add('show');
        el.geoPlace.textContent = (g.city ? g.city + ', ' : '') + countryName(g.cc || st.serverCode);
        el.geoCoords.textContent = g.lat.toFixed(4) + ', ' + g.lng.toFixed(4) +
            (g.accuracy ? '   +/- ' + Math.round(g.accuracy) + ' m' : '');
    } else {
        el.geoBox.classList.remove('show');
    }

    //  The question takes the surface over: the country selector and the action
    //  button come off screen while it is up. Leaving them there would be a
    //  second way to answer the same question -- a live Connect button beside
    //  "which country do you want instead?" is exactly the silent substitution
    //  this dialog exists to stop.
    if (ask) paintAsk(ask); else askPainted = null;
    el.ask.classList.toggle('show', !!ask);
    el.dd.style.display  = ask ? 'none' : '';
    el.act.style.display = ask ? 'none' : '';
    if (ask) el.dd.classList.remove('open');

    paintCc(el.pickedCc, st.serverCode || 'us');
    el.pickedName.textContent = countryName(st.serverCode) || 'Choose a country';
    const locked = off || busy;
    el.picked.classList.toggle('locked', locked);
    if (locked) el.dd.classList.remove('open');

    el.act.disabled = locked;
    el.act.classList.toggle('on', st.connected && !busy);
    el.act.textContent = off ? 'App not running'
        : busy ? (st.connected ? 'Working...' : 'Connecting...')
        : st.connected ? 'Disconnect' : 'Connect';

    el.ks.disabled = off;
    el.bypass.disabled = off;
    //  Never overwrite what the user is in the middle of typing or toggling --
    //  nor what they have just committed and the app has not answered yet.
    //  Re-filling from `st` during that gap would blank a host list the moment
    //  it was entered and show it again a tick later; the answer, refusal
    //  included, arrives as a state push and puts the app's own value back.
    if (document.activeElement !== el.ks && !pending) el.ks.checked = !!st.killSwitch;
    if (document.activeElement !== el.bypass && !pending) el.bypass.value = st.bypassList || '';

    const p = st.progress;
    const done = !!p && p.status && p.status !== 'connecting';
    const show = !off && !!p && (busy || (done && Date.now() < outcomeUntil));
    el.prog.classList.toggle('show', show);
    el.prog.classList.toggle('done', show && p.status === 'connected');
    el.prog.classList.toggle('failed', show && done && p.status !== 'connected');
    if (show) {
        el.fill.style.width = Math.max(0, Math.min(100, Number(p.percent) || 0)) + '%';
        el.progMsg.textContent = p.message || '';
        el.progPct.textContent = (p.percent == null ? '' : Math.round(p.percent) + '%');
    }
}
// ── the country list ────────────────────────────────────────────────
//  Built with createElement rather than innerHTML: every string in here --
//  country codes and names -- arrives over a socket, and markup assembled from
//  data that came off a wire is how an extension popup gets its own XSS.
function refreshList() {
    const q = el.search.value.trim().toLowerCase();
    const keepScroll = el.list.scrollTop;
    const codes = Object.keys(st.servers || {});
    el.list.textContent = '';

    const note = msg => {
        const li = document.createElement('li');
        li.className = 'note';
        li.textContent = msg;
        el.list.appendChild(li);
    };

    if (!codes.length) {
        //  Not an error state: the app publishes the list once its relay index
        //  has been read, which is a few seconds after it starts.
        note(st.appRunning ? 'Fetching live Tor exit countries...'
                           : 'The app sends the country list.');
        return;
    }

    codes.sort((a, b) => ((st.servers[b] || {}).bandwidth || 0) -
                         ((st.servers[a] || {}).bandwidth || 0));

    let shown = 0;
    for (const cc of codes) {
        const nm = countryName(cc);
        if (q && !nm.toLowerCase().includes(q) && !cc.toLowerCase().includes(q)) continue;

        const li = document.createElement('li');
        li.dataset.cc = cc;
        if (cc === st.serverCode) li.classList.add('active');

        const badge = document.createElement('span');
        badge.className = 'cc';
        paintCc(badge, cc);

        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = nm;

        const chip = document.createElement('span');
        const live = st.connected && cc === st.serverCode;
        chip.className = 'chip ' + (live ? 'live' : grade(st.servers[cc]));
        chip.textContent = live ? 'Connected' : capacity(st.servers[cc]);

        li.append(badge, name, chip);
        el.list.appendChild(li);
        shown += 1;
    }
    if (!shown) note('No exit country matches that.');
    el.list.scrollTop = keepScroll;
}

function toast(msg) {
    el.toast.textContent = msg;
    el.toast.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('show'), 5000);
}
// ── talking to the app ──────────────────────────────────────────────
//  background.js answers every SEND_COMMAND, refusal included, so a click on
//  a shut-down app produces a sentence instead of nothing happening. That is
//  the whole "the extension only works while the app is running" rule: the
//  extension never routes anything by itself, and it says so.
function send(payload, onRefused) {
    awaiting = Date.now() + AWAIT_MS;
    render();
    chrome.runtime.sendMessage({ type: 'SEND_COMMAND', payload }, res => {
        //  lastError is the service worker having died between the two halves
        //  of this call. Treated as a refusal: hanging on "Connecting..." with
        //  nothing on the way would be the worse answer.
        const err = chrome.runtime.lastError;
        if (!err && res && res.ok) return;
        awaiting = 0;
        if (res && res.reason === 'app-not-running') {
            st.appRunning = false;
            toast('The FreeProxy VPN app is not running. Start it on this PC first, then try again.');
        } else {
            toast('The app did not take that command. Check that FreeProxy VPN is still running.');
        }
        if (onRefused) onRefused();
        render();
    });
}

//  One entry point for everything the app says, so `st` can only ever be
//  replaced by app-authored values.
function apply(next) {
    if (!next) return;
    //  The question's id is part of the fingerprint on purpose: taking the
    //  question down IS the app's answer to the option that was clicked, and
    //  often the only immediately visible one, so it has to release the
    //  pending flag like any other observable change.
    const key = s => JSON.stringify([s.connected, s.serverCode, s.killSwitch,
                                     s.bypassList, s.busy, s.appRunning,
                                     s.ask && s.ask.id]);
    const before = key(st);
    const beforeCodes = Object.keys(st.servers || {}).join(',');
    st = Object.assign({}, st, next);
    //  Any observable change IS the app's answer, so the local pending flag
    //  goes. Without this the controls would stay disabled for the full
    //  AWAIT_MS even after the app had already done the thing.
    if (key(st) !== before) awaiting = 0;

    const p = st.progress;
    if (p && p.status && p.status !== 'connecting') {
        const k = p.status + '|' + p.percent + '|' + p.message;
        if (k !== outcomeKey) { outcomeKey = k; outcomeUntil = Date.now() + 3500; }
    } else if (p) {
        outcomeKey = '';
    }

    render();
    if (Object.keys(st.servers || {}).join(',') !== beforeCodes || key(st) !== before) refreshList();
}
// ── events ──────────────────────────────────────────────────────────
el.picked.addEventListener('click', () => {
    if (el.picked.classList.contains('locked')) return;
    const open = el.dd.classList.toggle('open');
    if (open) { refreshList(); el.search.focus(); }
});

document.addEventListener('click', e => {
    if (!el.dd.contains(e.target)) el.dd.classList.remove('open');
});

el.search.addEventListener('input', refreshList);
el.search.addEventListener('keydown', e => {
    if (e.key === 'Escape') { el.dd.classList.remove('open'); el.picked.focus(); }
});

el.list.addEventListener('click', e => {
    const li = e.target.closest('li[data-cc]');
    if (!li) return;
    const cc = li.dataset.cc;
    el.dd.classList.remove('open');
    el.search.value = '';
    if (cc === st.serverCode) return;
    //  While a tunnel is up the app treats this as a real switch: it rebuilds
    //  the circuit and verifies the new exit before anything reports the new
    //  country. Nothing is re-labelled here in the meantime.
    send({ command: 'CHANGE_SERVER', server: cc });
});

el.act.addEventListener('click', () => {
    send({ command: st.connected ? 'DISCONNECT' : 'CONNECT' });
});

//  Answering the app's question. Delegated, because the buttons are rebuilt
//  whenever the question changes.
//
//  The answer carries the id of the question it belongs to, so an answer can
//  never land on a DIFFERENT question than the one that was on screen -- the
//  app checks it and ignores anything stale. There is deliberately no way to
//  dismiss the card: cancelling is one of the options the app offered, and
//  treating a stray click as an answer would be the app choosing again.
el.askOpts.addEventListener('click', e => {
    const btn = e.target.closest('button[data-answer]');
    if (!btn || btn.disabled) return;
    const ask = st.ask;
    if (!ask || !ask.id) return;
    //  Clicked once is decided once. The card stays up, greyed, until the app
    //  takes it down, so nobody answers the same question twice.
    const btns = Array.from(el.askOpts.children);
    btns.forEach(b => { b.disabled = true; });
    send({ command: 'ASK_ANSWER', id: ask.id, answer: btn.dataset.answer },
          () => { btns.forEach(b => { b.disabled = false; }); });
});

el.ks.addEventListener('change', e => {
    const want = e.target.checked;
    send({ command: 'TOGGLE_KS', enabled: want },
         () => { el.ks.checked = !want; });   // refused: put the switch back
});

//  The same normalisation the app window does on blur, so one list cannot be
//  stored in two different shapes depending on which window typed it.
function normalizeBypass(raw) {
    const v = (raw || '').trim();
    if (!v) return '';
    return v.replace(/,/g, ';').split(';')
        .map(s => s.trim().toLowerCase()
            .replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/[\*\s]/g, ''))
        .filter(Boolean).join('; ');
}

function commitBypass() {
    const v = normalizeBypass(el.bypass.value);
    el.bypass.value = v;
    if (v === (st.bypassList || '')) return;
    send({ command: 'UPDATE_BYPASS', list: v });
}
el.bypass.addEventListener('blur', commitBypass);
el.bypass.addEventListener('keydown', e => { if (e.key === 'Enter') el.bypass.blur(); });
// ── live sync, both directions ──────────────────────────────────────
//  Pushed: background.js forwards every STATE_SYNC and every PROGRESS tick the
//  app sends, so a change made in the app window shows up here with no delay.
chrome.runtime.onMessage.addListener(msg => {
    if (msg && msg.type === 'UI_UPDATE') apply(msg.state);
});

//  Pulled: WAKE both reads the current state and cancels the reconnect
//  backoff. background.js backs off to 30 s so a closed port is not hammered
//  all day, which is exactly wrong for someone who just started the app and
//  opened this popup -- they would sit in front of "app not running" for half
//  a minute. An open popup is a reason to retry now, so this polls while it is
//  open and stops the moment it closes.
function poll() {
    chrome.runtime.sendMessage({ type: 'WAKE' }, res => {
        if (chrome.runtime.lastError) return;      // worker restarting
        if (res && res.state) apply(res.state);
    });
}

//  The clock and the "keep the finished bar up briefly" window both move on
//  their own, so the view is re-derived once a second regardless of traffic.
setInterval(render, 1000);
setInterval(poll, 1200);

render();
refreshList();
poll();





