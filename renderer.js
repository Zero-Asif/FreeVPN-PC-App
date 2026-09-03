const { ipcRenderer, shell } = require('electron');
const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });

let currentServer     = 'us';

let isAppConnected    = false;
let fastData          = null;
let isLoading         = true;
let liveNodeCounts    = {};
let rocketActionTaken = false;

// Timer
let timerInterval = null, connectedAt = null;

// Geolocation spoof — store real implementation
let _realGeolocation = null;

// ══════════════════════════════════════════════════════════════════
//  Report the country the traffic ACTUALLY exits from.
//
//  main.js verifies every exit against ipleak.net and friends before
//  claiming a country, and returns:
//      serverCode -- where the traffic demonstrably comes out
//      requested  -- what was asked for
//      verified   -- whether an external database confirmed it
//      dnsViaTor  -- whether DNS is going through Tor as well
//  The UI used to ignore all four and print the clicked country, which
//  is how it came to say "Connected via Luxembourg" while ipleak.net
//  showed a Swiss exit IP. This resolves the reply into what to show.
// ══════════════════════════════════════════════════════════════════
function ccName(code) {
    if (!code) return '';
    try { return regionNames.of(code.toUpperCase()); } catch (e) { return code.toUpperCase(); }
}

//  Only a literal dotted-quad is ever shown. Two reasons, and both matter:
//  this string arrives in a JSON body from a third-party geolocation service
//  and ends up inside showToast's innerHTML, so anything but digits and dots
//  would be markup someone else chose; and a value that is not an IPv4
//  address is not the thing being reported, so dropping it is also the honest
//  answer rather than a cosmetic one.
function ipv4Only(v) {
    return typeof v === 'string' && /^\d{1,3}(\.\d{1,3}){3}$/.test(v) &&
           v.split('.').every(n => +n <= 255) ? v : null;
}

function resolveExit(resp, fallbackCode) {
    const asked = (resp && resp.requested) || fallbackCode;
    const code  = (resp && resp.serverCode) || asked;
    return {
        asked,
        code,
        name:      ccName(code),
        askedName: ccName(asked),
        moved:     !!(code && asked && code !== asked),
        unverified: resp ? resp.verified === false : false,
        dnsLeaky:  resp ? resp.dnsViaTor === false : false,
        //  main.js already measures this -- probeExitLocation() asks four
        //  geolocation services THROUGH Tor and returns the address they agree
        //  they are talking to -- and main.js:3292 has been returning it all
        //  along with nothing on this side reading it. See announceExit().
        ip:        ipv4Only(resp && resp.exitIp),
    };
}

//  One place that decides what the user is told after a successful
//  connect or switch, so all three code paths stay consistent.
function announceExit(x, verb) {
    const Verb = verb.charAt(0).toUpperCase() + verb.slice(1);

    //  ONE toast, carrying every caveat that applies. showToast()
    //  suppresses a second warning while the first is still visible, so
    //  splitting these would silently drop the DNS notice.
    const dnsNote = x.dnsLeaky
        ? '<br><small>DNS port 53 was already in use, so only browser lookups go through Tor -- ' +
          'other applications will use the system resolver.</small>'
        : '';

    //  The exit IPv4, whenever the verification actually saw one.
    //
    //  WHY IT IS HERE. This is the one fact about the connection the user has no
    //  other reliable way to check. The obvious place to look is ipleak.net, and
    //  its IPv4 row cannot answer on a connection like this one: the row is an
    //  AJAX GET to ipv4.ipleak.net with a hard 5 s timeout tried 3 times
    //  (ipleak's own index.js line 72), and that host takes 8-22 s to send its
    //  first byte from here with NO tunnel in the path -- 7 attempts, 7 over
    //  budget, measured in .build/probe-geosource-latency.js and
    //  .build/probe-ipleak-latency.js, with DNS at 0-6 ms and TCP at 157 ms in
    //  every one of them, so the wait is ipleak's server and nothing local. The
    //  blank row is that timeout expiring, not a hidden address, and no change
    //  on this side can fill it.
    //
    //  IPv4 is shown rather than hidden because it cannot be hidden: it is the
    //  address the server has to send its answer back to, so every site already
    //  has it whatever ipleak renders. What matters is that it is the EXIT's
    //  address and not the user's, and that is exactly what this line lets them
    //  confirm. IPv6 stays hidden -- Tor is NoIPv6Traffic, ::/0 is blocked in
    //  both directions and the stack's components are disabled -- because a
    //  leaked IPv6 would be the real ISP's, or would place them in a different
    //  country than the IPv4 exit.
    const ipNote = x.ip ? ' Exit IPv4 <strong>' + x.ip + '</strong>.' : '';

    if (x.moved) {
        showToast('<strong>' + x.askedName + '</strong> had no confirmed exit right now, so you are ' +
                  verb + ' via <strong>' + x.name + '</strong> instead. That is the country your ' +
                  'IP and location will show.' + ipNote + dnsNote, 'warning', 9000);
    } else if (x.unverified) {
        //  Deliberately no longer "worth confirming at ipleak.net": that site's
        //  IPv4 row is the one measured above as unable to answer inside its own
        //  timeout. ipinfo.io answered in ~0.3 s in the same runs.
        showToast(Verb + ' via <strong>' + x.name + '</strong>, but the exit country could not be ' +
                  'double-checked -- no geolocation service answered through Tor. ' +
                  'Open <strong>ipinfo.io</strong> in your browser to see the exit address ' +
                  'yourself.' + dnsNote, 'warning', 9000);
    } else if (x.dnsLeaky) {
        showToast(Verb + ' via <strong>' + x.name + '</strong>.' + ipNote + ' DNS port 53 was already ' +
                  'in use, so only browser lookups go through Tor -- other applications will use ' +
                  'the system resolver.', 'warning', 9000);
    } else {
        //  "Your real IP", not "IP": the line above it now prints an address, and
        //  "Exit IPv4 1.2.3.4. IP hidden." reads as a contradiction of itself.
        showToast('<strong>' + Verb + '!</strong> Routed via ' + x.name + '.' + ipNote +
                  ' Your real IP, DNS &amp; GPS are hidden.', 'success', 6000);
    }
}

// ════════════════════════════════════════════════════════════
//  UTILITY
// ════════════════════════════════════════════════════════════
//  The REAL flag, from vendor/flags/<cc>.svg -- a file that ships inside the
//  app, not a request. It used to be an <img> from flagcdn.com: one request per
//  country to a third party that was thereby told which country this user was
//  about to connect to, over the user's real IP, before the tunnel existed.
//  That is why it was removed. The files restore the flags without restoring
//  the request; see vendor/flags/README.txt.
//
//  The drawn two-letter badge is still painted UNDERNEATH, with the same
//  deterministic hue the extension popup uses, and the flag is layered over
//  it. So this needs no list of which flags exist and no error handler: if a
//  file is missing or unreadable the <img> draws nothing (alt="" keeps
//  Chromium from showing a broken-image icon) and the old badge shows through.
//  Windows Chrome has no flag-emoji glyphs, so the badge is also the only
//  fallback that can render at all.
function getFlagImg(code) {
    const u  = (code || '??').toUpperCase();
    //  Only ever a two-letter code goes into the src. Country codes reach this
    //  function from the live relay index, which is off the network.
    const cc = /^[a-z]{2}$/i.test(code || '') ? String(code).toLowerCase() : '';
    let h = 0;
    for (let i = 0; i < u.length; i++) h = (h * 131 + u.charCodeAt(i)) % 360;
    const img = cc
        ? `<img src="vendor/flags/${cc}.svg" alt="" draggable="false" style="position:absolute;left:0;top:0;width:100%;height:100%;object-fit:cover;">`
        : '';
    return `<span title="${u}" style="position:relative;overflow:hidden;display:inline-flex;align-items:center;justify-content:center;width:22px;height:15px;margin-right:8px;border-radius:3px;flex:none;font-size:8px;font-weight:700;letter-spacing:.3px;color:#fff;text-shadow:0 1px 2px rgba(0,0,0,.4);box-shadow:inset 0 0 0 1px rgba(255,255,255,.18),0 1px 2px rgba(0,0,0,.3);background:linear-gradient(135deg,hsl(${h} 60% 44%),hsl(${(h + 38) % 360} 64% 28%));">${u}${img}</span>`;
}

// ════════════════════════════════════════════════════════════
//  🛰️ GEOLOCATION SPOOF  (Layer 2 — renderer side, Point 5)
//
//  navigator.geolocation is patched to return the connected
//  country's capital coordinates.  This runs in the renderer
//  process and covers JS calls from within the Electron window.
//  The main process CDP override (Layer 1) covers engine-level
//  requests, so both layers work together.
//
//  The spoof is indistinguishable from a real location:
//  • coords.accuracy comes from GEO_COORDS per country
//  • timestamp is always Date.now() (looks live)
//  • coords.altitude, speed, heading = null (normal for IP-geo)
// ════════════════════════════════════════════════════════════
function spoofGeolocation(lat, lng, accuracy, city, country) {
    // Save original implementation (only once)
    if (!_realGeolocation) {
        _realGeolocation = {
            getCurrentPosition: navigator.geolocation.getCurrentPosition.bind(navigator.geolocation),
            watchPosition:      navigator.geolocation.watchPosition.bind(navigator.geolocation),
            clearWatch:         navigator.geolocation.clearWatch.bind(navigator.geolocation),
        };
    }

    // Add tiny jitter each call so coords don't look frozen
    const jitter = () => (Math.random() - 0.5) * 0.004; // ±~200m

    function buildPosition() {
        return {
            coords: {
                latitude:         lat + jitter(),
                longitude:        lng + jitter(),
                accuracy:         accuracy,
                altitude:         null,
                altitudeAccuracy: null,
                heading:          null,
                speed:            null,
            },
            timestamp: Date.now(),
        };
    }

    // Override getCurrentPosition
    navigator.geolocation.getCurrentPosition = function(success, error, options) {
        setTimeout(() => success(buildPosition()), 80 + Math.random() * 120); // realistic delay
    };

    // Override watchPosition — returns a fake watch ID, calls success repeatedly
    navigator.geolocation.watchPosition = function(success, error, options) {
        const id = Math.floor(Math.random() * 9999) + 1000;
        success(buildPosition());
        // Keep firing every 5s like a real GPS watch
        const interval = setInterval(() => success(buildPosition()), 5000);
        navigator.geolocation._fakeWatchers = navigator.geolocation._fakeWatchers || {};
        navigator.geolocation._fakeWatchers[id] = interval;
        return id;
    };

    // Override clearWatch
    navigator.geolocation.clearWatch = function(id) {
        if (navigator.geolocation._fakeWatchers?.[id]) {
            clearInterval(navigator.geolocation._fakeWatchers[id]);
            delete navigator.geolocation._fakeWatchers[id];
        }
    };

    console.log(`[FreeProxy] 🛰️ Geolocation spoofed → ${city}, ${country} (${lat.toFixed(4)}, ${lng.toFixed(4)})`);
}

function restoreGeolocation() {
    if (!_realGeolocation) return;

    // Clear any active fake watchers
    if (navigator.geolocation._fakeWatchers) {
        Object.values(navigator.geolocation._fakeWatchers).forEach(clearInterval);
        navigator.geolocation._fakeWatchers = {};
    }

    navigator.geolocation.getCurrentPosition = _realGeolocation.getCurrentPosition;
    navigator.geolocation.watchPosition      = _realGeolocation.watchPosition;
    navigator.geolocation.clearWatch         = _realGeolocation.clearWatch;
    _realGeolocation = null;

    console.log('[FreeProxy] 🛰️ Geolocation restored to real location');
}

// ════════════════════════════════════════════════════════════
//  IPC: Geo spoof commands from main.js
// ════════════════════════════════════════════════════════════
ipcRenderer.on('geo-spoof-on', (event, { lat, lng, accuracy, city, country }) => {
    spoofGeolocation(lat, lng, accuracy, city, country);
    showToast(`📍 Location spoofed → <strong>${city}, ${country}</strong>`, 'success', 5000);
});

ipcRenderer.on('geo-spoof-off', () => {
    restoreGeolocation();
    showToast('📍 Location restored to your real position.', 'info', 3500);
});

// ── One-time browser setup ──────────────────────────────────
//  Two different one-time asks, and they must not be worded the same way.
//
//  MEASURED: with the app's delivery helper serving the package the browser
//  policies name, Edge installs the spoofer by itself and runs it. Chrome and
//  Brave DOWNLOAD and unpack the same package unattended, then keep it switched
//  off -- Chromium disables anything an installer offered until the user
//  accepts it once (disable_reasons 8192, EXTERNAL_EXTENSION), and the record
//  holding that bit is signed with the profile's own key, so nothing the app
//  writes can flip it. That is one switch, not a setup.
//
//  Only if delivery never happened at all is the old "Load unpacked" route the
//  answer, so that text is now the fallback rather than the headline.
//
//  Saying nothing would leave the user looking at a map with the wrong city
//  and no way to know why, so it is surfaced here and not only in the log.
//  Shown once per app run, and only while the extension is genuinely not
//  running -- main.js re-checks on every connect, so it stops appearing by
//  itself once the switch is on.
let _geoExtNoticeFor = null;
function openGeoExtFolder() {
    ipcRenderer.invoke('open-geo-ext-folder').catch(() => {});
}
ipcRenderer.on('geo-ext-setup', (event, { browsers, enable, restart, auto, dir }) => {
    const manualWho  = (browsers || []).join(' and ');
    const enableWho  = (enable || []).join(' and ');
    const restartWho = (restart || []).join(' and ');
    const key = `enable:${enableWho}|restart:${restartWho}|manual:${manualWho}`;
    if ((!manualWho && !enableWho && !restartWho) || _geoExtNoticeFor === key) return;
    _geoExtNoticeFor = key;

    const covered = (auto || []).length
        ? `This app and ${auto.join(' and ')} are already covered.`
        : 'This app itself is already covered.';
    const folder = '<a href="#" class="toast-action" data-action="open-geo-ext-folder" ' +
                   'style="color:inherit;text-decoration:underline;cursor:pointer">' +
                   'Open the setup folder</a>';

    //  The one-click case leads, because it is the one that will actually be
    //  showing: the download already succeeded and the wording must not send
    //  the user hunting for a folder they do not need.
    if (enableWho) {
        showToast(
            `📍 <strong>${enableWho}</strong>: the location spoofer is already downloaded ` +
            'there — it just needs its switch turned ON, once.<br>' +
            'Open the extensions page in that browser, find "FreeProxy VPN Extension" ' +
            `and enable it. ${covered}`,
            'info', 30000);
        console.log('[FreeProxy] location spoofer is installed but disabled in ' +
                    enableWho + ' -- one switch on the extensions page');
    }
    //  No folder link here, deliberately. This browser is already set up; it was
    //  simply open when that happened, and a browser picks the entry offering it
    //  an extension up at its next start, or on its own within about two hours.
    //  Offering "Open the setup folder" would be inviting work it does by itself.
    if (restartWho) {
        showToast(
            `📍 <strong>${restartWho}</strong>: already set up — close and reopen ` +
            `${(restart || []).length > 1 ? 'them' : 'it'} to have the location spoofer ` +
            'now.<br>' +
            'It was open while this app registered the extension. Reopening brings it ' +
            `straight away; left alone it arrives within about two hours. ${covered}`,
            'info', 30000);
        console.log('[FreeProxy] location spoofer is armed for ' + restartWho +
                    " -- it arrives at that browser's next start, or within ~2 h");
    }
    if (manualWho) {
        showToast(
            `📍 <strong>${manualWho}</strong>: one-time setup needed before location spoofing works there.<br>` +
            `${folder} and follow HOW-TO-ENABLE.txt. ${covered}`,
            'info', 30000);
        console.log('[FreeProxy] location spoofer needs a manual load in ' + manualWho + ' -- ' + dir);
    }
});

// ── The one restart ────────────────────────────────────────
//  This card is the whole reason the app stopped closing browsers. Every job
//  that genuinely needs a restart happens at INSTALL time; if Windows deferred
//  any part of it to the next boot, the user is told once, here, and then never
//  interrupted again -- which is how IDM and the commercial VPNs handle it.
//
//  Nothing on this card is decided in the renderer:
//
//   * Whether to show it at all comes from main.js's pendingRestart(), which
//     reads a marker lib/installer-tasks.js writes ONLY on evidence from
//     Windows (a pending file rename naming our own files, exit code 3010 from
//     the bundled VC++ runtime, NSIS's reboot flag). A clean install defers
//     nothing, so this card normally never appears.
//   * The reason lines are the installer's own strings, written in with
//     textContent -- they come out of a file, so they are never markup.
//
//  Asked once per launch, on load, and not again: a card that appeared while
//  the user was mid-connect would be the interruption being removed. "Later"
//  clears the marker for good -- what Windows deferred still completes at
//  whatever restart happens next, which is the user's business, not the app's.
//
//  `restartDecided` is the same latch #ask-options relies on (askShownId), and
//  for the same reason: the click arrives on the <span> INSIDE the button, and a
//  disabled ancestor does not stop a dispatched click from bubbling past it. So
//  `disabled` is what the user sees, and this flag is what actually makes the
//  answer happen once -- two presses must not ask Windows to reboot twice.
let restartDecided = false;

function closeRestartCard() {
    document.getElementById('restart-modal')?.classList.remove('open');
}

async function checkPendingRestart() {
    const modal = document.getElementById('restart-modal');
    const list  = document.getElementById('restart-why');
    const now   = document.getElementById('restart-now');
    const later = document.getElementById('restart-later');
    if (!modal || !list || !now || !later) return;

    let info;
    try { info = await ipcRenderer.invoke('get-pending-restart'); }
    catch (e) { return; }
    if (!info || !info.pending || !Array.isArray(info.why) || !info.why.length) return;

    list.textContent = '';
    info.why.forEach(line => {
        const li = document.createElement('li');
        li.textContent = String(line);
        list.appendChild(li);
    });

    restartDecided = false;
    now.addEventListener('click', () => {
        if (restartDecided) return;
        restartDecided = true;
        now.disabled = later.disabled = true;
        now.querySelector('.restart-opt-label').textContent = 'Restarting…';
        ipcRenderer.invoke('restart-windows').then(r => {
            //  Windows refused or the call failed: the card has to give the
            //  buttons back rather than sit there looking like it worked, and
            //  the latch has to come off with them or Later would be dead too.
            if (r && r.ok) return;
            restartDecided = false;
            now.disabled = later.disabled = false;
            now.querySelector('.restart-opt-label').textContent = 'Restart now';
            showToast('⚠️ Windows would not start the restart. You can restart from the ' +
                      'Start menu whenever it suits you — nothing else is waiting.',
                      'warning', 9000);
            closeRestartCard();
        }).catch(() => {
            restartDecided = false;
            now.disabled = later.disabled = false;
        });
    }, { once: false });

    later.addEventListener('click', () => {
        if (restartDecided) return;
        restartDecided = true;
        now.disabled = later.disabled = true;
        ipcRenderer.invoke('dismiss-pending-restart').catch(() => {});
        closeRestartCard();
        showToast('👍 Noted — it finishes at your next restart. This app will not ask again.',
                  'info', 6000);
    });

    modal.classList.add('open');
    now.focus();
    console.log('[FreeProxy] one restart is pending: ' + info.why.join(' | '));
}

document.addEventListener('DOMContentLoaded', () => { checkPendingRestart(); });

// ════════════════════════════════════════════════════════════
//  ⏱ CONNECTION TIMER
// ════════════════════════════════════════════════════════════
function startTimer() {
    connectedAt = Date.now();
    const row = document.getElementById('connection-timer-row');
    const el  = document.getElementById('connection-timer');
    if (row) row.classList.add('visible');
    clearInterval(timerInterval);
    timerInterval = setInterval(() => {
        if (!el) return;
        const s = Math.floor((Date.now() - connectedAt) / 1000);
        const h = String(Math.floor(s / 3600)).padStart(2, '0');
        const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
        el.textContent = `${h}:${m}:${String(s % 60).padStart(2, '0')}`;
    }, 1000);
}

function stopTimer() {
    clearInterval(timerInterval); timerInterval = null; connectedAt = null;
    const row = document.getElementById('connection-timer-row');
    const el  = document.getElementById('connection-timer');
    if (row) row.classList.remove('visible');
    if (el)  el.textContent = '00:00:00';
}

// ════════════════════════════════════════════════════════════
//  🎯 PROGRESS BAR
// ════════════════════════════════════════════════════════════
function showProgress(percent, message, status) {
    const section = document.getElementById('progress-section');
    const fill    = document.getElementById('progress-fill');
    const text    = document.getElementById('progress-text');
    const label   = document.getElementById('progress-label');
    if (!section) return;
    section.style.display = 'block'; section.style.opacity = '1';
    if (fill)  fill.style.width = `${Math.max(4, percent)}%`;
    if (text)  text.textContent = message;
    const gradients = {
        connecting:  'linear-gradient(90deg,#5031b2,#7c3aed)',
        slow:        'linear-gradient(90deg,#d97706,#f59e0b)',
        unavailable: 'linear-gradient(90deg,#dc2626,#ef4444)',
        connected:   'linear-gradient(90deg,#16a34a,#22c55e)',
        //  Cancelled is a DECISION, not a failure -- the user chose it from the
        //  country-unavailable dialog. Slate, not red: nothing went wrong.
        cancelled:   'linear-gradient(90deg,#475569,#64748b)',
    };
    if (fill) fill.style.background = gradients[status] || gradients.connecting;
    if (label) {
        const labels = { connecting:`${percent}%`, slow:`${percent}% — Slow`,
                         unavailable:'Failed', connected:'100% ✓', cancelled:'Cancelled' };
        label.textContent = labels[status] || `${percent}%`;
    }
}

function hideProgress(delayMs = 0) {
    setTimeout(() => {
        const section = document.getElementById('progress-section');
        const fill    = document.getElementById('progress-fill');
        if (!section) return;
        section.style.transition = 'opacity 0.4s'; section.style.opacity = '0';
        setTimeout(() => { section.style.display='none'; section.style.opacity='1'; if(fill) fill.style.width='0%'; }, 420);
    }, delayMs);
}

// ════════════════════════════════════════════════════════════
//  🔔 TOAST NOTIFICATIONS
// ════════════════════════════════════════════════════════════
//  A toast body is built with innerHTML, and this window has full Node access,
//  so index.html's script-src no longer grants 'unsafe-inline' -- which means
//  the close button's old onclick="this.parentElement.remove()" and the setup
//  link's onclick="return openGeoExtFolder()" would both be refused by the
//  policy now. One delegated listener on the container replaces both: it is
//  attached lazily on the first toast, so it does not depend on where in the
//  load order this file happens to be, and once only.
let _toastWired = false;
function wireToastClicks(container) {
    if (_toastWired) return;
    _toastWired = true;
    container.addEventListener('click', e => {
        const link = e.target.closest('.toast-action');
        if (link) {
            e.preventDefault();
            if (link.dataset.action === 'open-geo-ext-folder') openGeoExtFolder();
            return;
        }
        const close = e.target.closest('.toast-close');
        if (close) close.closest('.toast')?.remove();
    });
}

function showToast(message, type = 'info', durationMs = 5000) {
    const container = document.getElementById('toast-container');
    if (!container) return;
    wireToastClicks(container);
    if (type === 'warning' && container.querySelector('.toast-warning')) return;
    const icons = { info:'ℹ️', warning:'⚠️', error:'❌', success:'✅' };
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.innerHTML = `
        <span class="toast-icon">${icons[type]||'ℹ️'}</span>
        <span class="toast-msg">${message}</span>
        <button class="toast-close" type="button">×</button>`;
    container.appendChild(toast);
    setTimeout(() => {
        if (!toast.parentElement) return;
        toast.style.opacity='0'; toast.style.transform='translateY(8px)';
        setTimeout(() => toast.remove(), 380);
    }, durationMs);
}

// ════════════════════════════════════════════════════════════
//  📋 LOG VIEWER
// ════════════════════════════════════════════════════════════
async function openLogModal() {
    const modal   = document.getElementById('log-modal');
    const content = document.getElementById('log-content');
    if (!modal || !content) return;
    modal.classList.add('open');
    content.innerHTML = '<div class="log-line INFO">Loading…</div>';
    await refreshLogContent(document.getElementById('logFilter')?.value || 'ALL');
    content.scrollTop = content.scrollHeight;
}

async function refreshLogContent(level = 'ALL') {
    const content = document.getElementById('log-content');
    const pathEl  = document.getElementById('log-path-display');
    try {
        const { lines, logFile } = await ipcRenderer.invoke('get-log-lines', { n: 400, level });
        if (pathEl) pathEl.textContent = logFile || '—';
        if (!lines.length) { content.innerHTML = '<div class="log-line INFO">No log entries yet.</div>'; return; }
        content.innerHTML = lines.map(line => {
            let cls = 'INFO';
            if (line.includes('[ERROR  ]')) cls = 'ERROR';
            else if (line.includes('[WARN   ]')) cls = 'WARN';
            else if (line.includes('[SUCCESS]')) cls = 'SUCCESS';
            else if (line.includes('[DEBUG  ]')) cls = 'DEBUG';
            const hl = line
                .replace(/(\d+%)/g, '<strong>$1</strong>')
                .replace(/(ERROR|FAIL|failed)/gi, '<span style="color:#f87171;font-weight:700">$1</span>')
                .replace(/(SUCCESS|connected|secured|spoofed)/gi, '<span style="color:#4ade80;font-weight:700">$1</span>');
            return `<div class="log-line ${cls}">${hl}</div>`;
        }).join('');
    } catch(e) {
        content.innerHTML = `<div class="log-line ERROR">Failed to load logs: ${e.message}</div>`;
    }
}

// ════════════════════════════════════════════════════════════
//  ❓ THE ASK DIALOG
//
//  main.js no longer picks a country for the user when the one they chose
//  has no reachable exit relay. It stops and asks, over IPC:
//
//      ask-user        { id, variant, cc, title, body, note?, foot?,
//                        options: [{ id, label, hint? }] }
//      ask-user-close  { id }                -- take it down, it was answered
//                                               somewhere else or it resolved
//                                               itself
//      ask-user-answer { id, answer }        -- sent back from here
//
//  Everything on screen comes from that record. This file invents no option,
//  no wording and no default: `answer` is only ever one of the ids main.js
//  offered, and main.js validates it again on arrival.
//
//  Built with createElement, not innerHTML -- index.html's CSP has no
//  'unsafe-inline' for scripts, so an inline onclick would be refused, and
//  this window runs with Node integration, which is exactly the window where
//  assembling markup out of strings is worth avoiding.
//
//  There is NO dismiss. Backdrop clicks and Escape do nothing on purpose:
//  the engine is blocked on this answer, cancelling is itself one of the
//  options, and treating "clicked outside" as an answer would be the app
//  deciding for the user again -- the exact behaviour being removed.
// ════════════════════════════════════════════════════════════
let askShownId = null;

function closeAskDialog(id) {
    //  Only the question actually on screen. A stale close for a question that
    //  was already replaced must not blank the current one.
    if (id && askShownId && id !== askShownId) return;
    askShownId = null;
    document.getElementById('ask-modal')?.classList.remove('open');
}

function openAskDialog(ask) {
    const modal = document.getElementById('ask-modal');
    if (!modal || !ask || !ask.id) return;
    const titleEl = document.getElementById('ask-title');
    const bodyEl  = document.getElementById('ask-body');
    const noteEl  = document.getElementById('ask-note');
    const flagEl  = document.getElementById('ask-flag');
    const optsEl  = document.getElementById('ask-options');
    const footEl  = document.getElementById('ask-foot-text');
    const dotsEl  = document.getElementById('ask-dots');
    if (!titleEl || !optsEl) return;

    askShownId = ask.id;
    const live = ask.variant === 'live';
    modal.classList.toggle('live', live);

    //  getFlagImg() returns markup, and it is this file's own -- the country
    //  code inside it is checked against /^[a-z]{2}$/ before it reaches a src.
    flagEl.innerHTML = ask.cc ? getFlagImg(ask.cc) : '';
    flagEl.style.display = ask.cc ? '' : 'none';

    titleEl.textContent = ask.title || '';
    bodyEl.textContent  = ask.body || '';
    noteEl.textContent  = ask.note || '';
    noteEl.classList.toggle('show', !!ask.note);

    optsEl.textContent = '';
    (ask.options || []).forEach((opt, i) => {
        if (!opt || !opt.id) return;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ask-opt' +
            (i === 0 && !live ? ' primary' : '') +
            (/^(cancel|stop)$/.test(opt.id) ? ' danger' : '');
        btn.dataset.answer = opt.id;

        const label = document.createElement('span');
        label.className = 'ask-opt-label';
        label.textContent = opt.label || opt.id;
        btn.appendChild(label);

        if (opt.hint) {
            const hint = document.createElement('span');
            hint.className = 'ask-opt-hint';
            hint.textContent = opt.hint;
            btn.appendChild(hint);
        }
        optsEl.appendChild(btn);
    });

    //  A live card IS the app still working; a choice is the app waiting.
    //  `foot` overrides the sentence for a question that is not about a connect
    //  at all -- the first-open browser card is one -- because "no country has
    //  been chosen for you" under a list of browsers is an answer to a question
    //  nobody asked. main.js sends the words; this file still invents none.
    dotsEl.classList.toggle('show', live);
    footEl.textContent = ask.foot ? ask.foot
        : live
        ? 'Nothing is connected while this runs.'
        : 'Nothing is connected right now, and no country has been chosen for you.';

    modal.classList.add('open');
    //  Keyboard first: the wait/cancel decision must be reachable without a
    //  mouse, and focus has to leave the Connect button, which is disabled.
    optsEl.querySelector('.ask-opt')?.focus();
}

//  One delegated listener for every option button of every question, attached
//  once. The buttons are disabled the instant one is pressed: the answer is
//  already on its way to main.js and a second click would race the close.
function wireAskDialog() {
    const optsEl = document.getElementById('ask-options');
    if (!optsEl) return;
    optsEl.addEventListener('click', e => {
        const btn = e.target.closest('.ask-opt');
        if (!btn || btn.disabled || !askShownId) return;
        const id = askShownId;
        optsEl.querySelectorAll('.ask-opt').forEach(b => { b.disabled = true; });
        ipcRenderer.send('ask-user-answer', { id, answer: btn.dataset.answer });
        //  main.js answers with ask-user-close, and a 'wait' answer replaces
        //  this dialog with the live card in the same breath. Closing here as
        //  well keeps the window responsive if that message is slow, and
        //  closeAskDialog() is id-checked so it cannot swallow the next one.
        closeAskDialog(id);
    });
}

ipcRenderer.on('ask-user',       (event, ask) => openAskDialog(ask));
ipcRenderer.on('ask-user-close', (event, d)   => closeAskDialog(d && d.id));

// ════════════════════════════════════════════════════════════
//  📡 CONNECTION PROGRESS  (IPC from main.js)
// ════════════════════════════════════════════════════════════
ipcRenderer.on('connection-progress', (event, { percent, message, status, kept }) => {
    showProgress(percent, message, status);
    if (status === 'slow')
        showToast(`⚠️ <strong>Server is slow.</strong> Connection still in progress…`, 'warning', 9000);
    if (!rocketActionTaken) {
        if (status === 'connected') { rocketActionTaken=true; window.landRocket?.(); }
        else if (status === 'unavailable') {
            rocketActionTaken=true; window.explodeRocket?.();
            showToast(`❌ <strong>Server unavailable.</strong> Please choose a faster country.`, 'error', 7000);
        }
        //  The user's own words for cancelling: the rocket blasts in mid-air,
        //  still flying, and no country is connected.
        //
        //  `kept` is the one exception and it comes from main.js, which is the
        //  only place that knows: a cancelled SWITCH that never touched the
        //  running tunnel leaves the old country carrying traffic. Blowing up
        //  that rocket would be a picture of a dead tunnel that is still alive.
        else if (status === 'cancelled' && !kept) {
            rocketActionTaken=true;
            window.explodeRocket?.({ overlay: 'Cancelled 💥  No country connected' });
        }
    }
});

// ════════════════════════════════════════════════════════════
//  MAIN DOM LOGIC
// ════════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', async () => {
    const connectButton    = document.getElementById('connectButton');
    const statusPulse      = document.getElementById('statusPulse');
    const statusText       = document.getElementById('statusText');
    const killSwitchToggle = document.getElementById('killSwitchToggle');
    const selectedServer   = document.getElementById('selectedServer');
    const dropdownList     = document.getElementById('dropdownList');
    const selectedText     = document.getElementById('selectedText');
    const bypassInput      = document.getElementById('bypassInput');

    //  The country-unavailable / still-trying dialog. Wired here rather than at
    //  load time so #ask-options is guaranteed to exist; the question itself can
    //  arrive at any moment after this.
    wireAskDialog();
    //  And if one is ALREADY waiting -- this window reloaded while it was up, or
    //  started slower than the engine asked -- put it straight back on screen.
    ipcRenderer.invoke('get-pending-ask').then(a => { if (a) openAskDialog(a); }).catch(() => {});

    // Log modal
    document.getElementById('openLogBtn')?.addEventListener('click', openLogModal);    document.getElementById('closeLogBtn')?.addEventListener('click', () => document.getElementById('log-modal')?.classList.remove('open'));
    document.getElementById('log-modal')?.addEventListener('click', e => { if (e.target===e.currentTarget) e.currentTarget.classList.remove('open'); });
    document.getElementById('logFilter')?.addEventListener('change', async e => {
        await refreshLogContent(e.target.value);
        document.getElementById('log-content').scrollTop = document.getElementById('log-content').scrollHeight;
    });
    document.getElementById('openLogFileBtn')?.addEventListener('click', () => ipcRenderer.invoke('open-log-folder'));

    //  Both of these were onclick="require('electron').shell.openExternal(...)"
    //  attributes in index.html, which script-src without 'unsafe-inline' now
    //  refuses. The destination stays in the markup as data-external and href
    //  stays "#", so no click can navigate THIS window -- a page that loaded
    //  here would run with Node integration. https only, and never the URL of
    //  anything the app fetched: these two are static markup.
    document.querySelectorAll('a[data-external]').forEach(a =>
        a.addEventListener('click', e => {
            e.preventDefault();
            const url = a.dataset.external || '';
            if (/^https:\/\//.test(url)) shell.openExternal(url).catch(() => {});
        }));

    // Close dropdown outside
    document.addEventListener('click', e => {
        if (!selectedServer.contains(e.target) && !dropdownList.contains(e.target))
            dropdownList.classList.remove('show');
    });

    try { fastData = await ipcRenderer.invoke('get-fastest-server'); } catch(e) {}

    bypassInput.addEventListener('blur', async () => {
        const val = bypassInput.value.trim();
        bypassInput.value = val
            ? val.replace(/,/g,';').split(';').map(s => s.trim().toLowerCase()
                .replace(/^https?:\/\//,'').replace(/\/.*$/,'').replace(/[\*\s]/g,'')).filter(Boolean).join('; ')
            : '';
        if (isAppConnected) await ipcRenderer.invoke('update-live-bypass', bypassInput.value);
    });

    // ── Country list ──────────────────────────────────────
    async function fetchAndRenderCountries() {
        if (dropdownList.children.length === 0) {
            dropdownList.innerHTML = `<li style="justify-content:center;padding:14px;color:#aaa;font-size:0.8rem;">Fetching live Tor nodes… ⏳</li>`;
        }
        let counts;
        try {
            counts = await Promise.race([
                ipcRenderer.invoke('get-realtime-status'),
                new Promise(resolve => setTimeout(() => resolve(null), 12000))
            ]);
        } catch(e) {}
        if (!counts || !Object.keys(counts).length) return;

        isLoading=false; liveNodeCounts=counts;
        const loadingMsg = dropdownList.querySelector('li:not([data-value])');
        if (loadingMsg) loadingMsg.remove();

        if (isAppConnected && currentServer && !counts[currentServer])
            counts[currentServer] = { count:1, bandwidth:10000000 };

        const sorted = Object.keys(counts).sort((a,b) => ((counts[b]?.bandwidth)||0) - ((counts[a]?.bandwidth)||0));

        sorted.forEach(code => {
            const { count=0, bandwidth=0 } = counts[code]||{};
            if (!count) return;
            let name = code.toUpperCase();
            try { name = regionNames.of(code.toUpperCase()); } catch(e) {}
            const mbps = bandwidth / 1_000_000;
            let cls, label;
            //  The band below is real -- exit count and bandwidth, both from the
            //  live relay index. The label used to be a random millisecond figure
            //  nobody had timed, re-rolled on every refresh; it is now the count
            //  the band was decided by, the same number the extension popup shows.
            const exits = count === 1 ? '1 exit' : `${count} exits`;
            if (isAppConnected && currentServer===code) { cls='status-fast'; label='Connected ✓'; }
            else if (count>200 || mbps>50)  { cls='status-fast'; label=exits; }
            else if (count>50  || mbps>10)  { cls='status-busy'; label=exits; }
            else                             { cls='status-slow'; label=exits; }
            const badge = (fastData && code===fastData.best) ? `<span class="fastest-badge">BEST</span>` : '';
            const existing = dropdownList.querySelector(`li[data-value="${code}"]`);
            if (existing) {
                const sp = existing.querySelector('.server-status');
                if (sp) { sp.className=`server-status ${cls}`; sp.textContent=label; }
                dropdownList.appendChild(existing);
            } else {
                const li = document.createElement('li');
                li.setAttribute('data-value', code);
                if (isAppConnected && currentServer===code) li.classList.add('active-server');
                li.innerHTML = `<span style="display:flex;align-items:center;">${getFlagImg(code)}${name}${badge}</span><span class="server-status ${cls}">${label}</span>`;
                dropdownList.appendChild(li);
            }
        });
        dropdownList.querySelectorAll('li[data-value]').forEach(li => {
            const code = li.getAttribute('data-value');
            if (code && !counts[code] && !(isAppConnected && currentServer===code)) li.remove();
        });
    }

    // ── Server switch ─────────────────────────────────────
    dropdownList.addEventListener('click', async e => {
        const li = e.target.closest('li');
        if (!li || !li.hasAttribute('data-value')) return;
        currentServer = li.getAttribute('data-value');
        let cName = currentServer.toUpperCase();
        try { cName = regionNames.of(currentServer.toUpperCase()); } catch(e) {}
        selectedText.innerHTML = `${getFlagImg(currentServer)} ${cName}`;
        dropdownList.classList.remove('show');

        if (isAppConnected) {
            connectButton.textContent='Switching…'; connectButton.disabled=true;
            connectButton.classList.remove('connected');
            statusPulse.className='status-pulse connecting'; statusText.textContent='Rerouting… 🔄';
            stopTimer();
            rocketActionTaken=false;
            window.flyToCountry?.(currentServer);
            await ipcRenderer.invoke('disconnect-vpn', killSwitchToggle.checked);

            let response;
            try { response = await ipcRenderer.invoke('connect-vpn', { serverCode: currentServer, bypassList: bypassInput.value }); }
            catch(e) { response = { status:'unavailable' }; }

            connectButton.disabled=false;
            if (response.status==='connected') {
                const x = resolveExit(response, currentServer);
                localStorage.setItem('isConnected', 'true');
                localStorage.setItem('activeServer', x.code);
                updateUI(true, x.code);
                if (x.moved) window.flyToCountry?.(x.code);
                rocketActionTaken=true; window.landRocket?.(x.code);
                showProgress(100, `Switched & Secured via ${x.name} 🛡️`, 'connected');
                announceExit(x, 'switched');
                hideProgress(2500); fetchAndRenderCountries();
            } else if (response.status==='cancelled') {
                //  Reached only when this path ran the switch itself, which the
                //  capture-phase interceptor at the bottom of this file normally
                //  takes over. Either way a cancel is a decision, not a failure,
                //  and it is never reported as one. This branch tore the tunnel
                //  down before connecting, so `kept` can only be false here.
                localStorage.setItem('isConnected', 'false');
                updateUI(false, currentServer);
                showToast('Switch <strong>cancelled</strong> — no country is connected.',
                          'info', 6000);
                hideProgress(3000); fetchAndRenderCountries();
            } else {
                localStorage.setItem('isConnected', 'false');
                updateUI(false, currentServer);
                hideProgress(3000); fetchAndRenderCountries();
            }
        } else {
            localStorage.setItem('activeServer', currentServer);
            updateUI(false, currentServer);
        }
    });

    fetchAndRenderCountries();
    setInterval(fetchAndRenderCountries, 30000);

    // ── UI state ──────────────────────────────────────────
    function updateUI(connected, serverValue=null) {
        isAppConnected=connected;
        if (serverValue) {
            currentServer=serverValue;
            let cName=serverValue.toUpperCase();
            try { cName=regionNames.of(serverValue.toUpperCase()); } catch(e) {}
            selectedText.innerHTML=`${getFlagImg(serverValue)} ${cName}`;
        }
        dropdownList.querySelectorAll('li[data-value]').forEach(li =>
            li.classList.toggle('active-server', connected && li.getAttribute('data-value')===currentServer));
        if (connected) {
            connectButton.textContent='Disconnect'; connectButton.classList.add('connected');
            statusPulse.className='status-pulse connected'; statusText.textContent='Protected 🛡️';
            startTimer();
        } else {
            connectButton.textContent='Tap to Connect'; connectButton.classList.remove('connected');
            statusPulse.className='status-pulse disconnected'; statusText.textContent='Disconnected';
            stopTimer();
        }
    }

    const savedServer     = localStorage.getItem('activeServer')  || 'us';
    const savedState      = localStorage.getItem('isConnected')   === 'true';
    const savedKillSwitch = localStorage.getItem('killSwitch')    === 'true';
    updateUI(savedState, savedServer);
    killSwitchToggle.checked = savedKillSwitch;
    //  Tell main what was restored. Without this the kill switch could read ON
    //  in this window while main -- and the extension popup, and the globe's
    //  decision about whether it may make an IP lookup at all -- still had it
    //  off. State only: report-killswitch touches nothing on the machine.
    ipcRenderer.invoke('report-killswitch', savedKillSwitch).catch(() => {});
    selectedServer.addEventListener('click', () => dropdownList.classList.toggle('show'));

    // ════════════════════════════════════════════════════════
    //  🟢 CONNECT / DISCONNECT
    // ════════════════════════════════════════════════════════
    connectButton.addEventListener('click', async () => {
        if (isLoading) { showToast('🔄 Please wait — fetching live server list…','info',3000); return; }
        const bypassValue=bypassInput.value;
        let cName=currentServer.toUpperCase();
        try { cName=regionNames.of(currentServer.toUpperCase()); } catch(e) {}

        // ── DISCONNECT ────────────────────────────────────
        if (isAppConnected) {
            connectButton.textContent='Disconnecting… 🛸'; connectButton.disabled=true;
            stopTimer();
            window.backToHome?.();
            let response;
            try { response=await ipcRenderer.invoke('disconnect-vpn', killSwitchToggle.checked); }
            catch(e) { response={status:'disconnected'}; }
            connectButton.disabled=false;
            hideProgress(300);
            if (response.status==='disconnected') {
                localStorage.setItem('isConnected','false');
                updateUI(false, currentServer);
                showToast(`🔓 Disconnected from ${cName}.`, 'info', 3000);
                fetchAndRenderCountries();
            }
            return;
        }

        // ── CONNECT ───────────────────────────────────────
        connectButton.textContent='Connecting… 🚀'; connectButton.disabled=true;
        statusPulse.className='status-pulse connecting'; rocketActionTaken=false;
        window.flyToCountry?.(currentServer);

        let response;
        try { response=await ipcRenderer.invoke('connect-vpn', { serverCode:currentServer, bypassList:bypassValue }); }
        catch(e) { response={status:'unavailable'}; }

        connectButton.disabled=false;
        if (response.status==='connected') {
            //  Show where the tunnel really came out, not what was clicked.
            const x = resolveExit(response, currentServer);
            localStorage.setItem('isConnected','true');
            localStorage.setItem('activeServer', x.code);
            updateUI(true, x.code);
            if (x.moved) window.flyToCountry?.(x.code);
            //  Landed unconditionally, and told which country: this click may
            //  have run several attempts through the country-unavailable dialog,
            //  and the failed one already blasted the rocket and set the latch.
            //  Landing an already-landed rocket is a no-op; NOT landing leaves
            //  the ring on home while the app says Protected.
            rocketActionTaken=true; window.landRocket?.(x.code);
            showProgress(100, `Connected via ${x.name} 🛡️`, 'connected');
            hideProgress(2800);
            announceExit(x, 'connected');
            fetchAndRenderCountries();
        } else if (response.status==='cancelled') {
            //  The user chose "do not connect at all" in the country-unavailable
            //  dialog. Not a failure and it is not reported as one: no country
            //  is connected, main.js has already put this PC back the way it was
            //  found, and the rocket has blasted in mid-air from the 'cancelled'
            //  progress record above.
            localStorage.setItem('isConnected','false');
            updateUI(false, currentServer);
            if (!rocketActionTaken) {
                rocketActionTaken=true;
                window.explodeRocket?.({ overlay: 'Cancelled 💥  No country connected' });
            }
            showToast('Connection <strong>cancelled</strong> — no country is connected. ' +
                      'This PC is back on its own internet connection' +
                      (killSwitchToggle.checked ? ', unless the Kill Switch is still blocking it.' : '.'),
                      'info', 6000);
            hideProgress(3200); fetchAndRenderCountries();
        } else {
            localStorage.setItem('isConnected','false');
            updateUI(false, currentServer);
            if (!rocketActionTaken) { rocketActionTaken=true; window.explodeRocket?.(); }
            hideProgress(3200); fetchAndRenderCountries();
        }
    });

    // ── Kill Switch ───────────────────────────────────────
    killSwitchToggle.addEventListener('change', async e => {
        const on=e.target.checked;
        localStorage.setItem('killSwitch', on?'true':'false');
        if (!isAppConnected) await ipcRenderer.invoke('toggle-killswitch', on);
        showToast(on ? '🔒 Kill Switch <strong>ON</strong> — Internet blocked if VPN drops.'
                     : '🔓 Kill Switch <strong>OFF</strong>.', on?'warning':'info', 3500);
    });

    // ── Extension sync ────────────────────────────────────
    ipcRenderer.on('sync-ui-state', (event, state) => {
        if (currentServer!==state.serverCode) {
            currentServer=state.serverCode;
            let cName=currentServer.toUpperCase();
            try { cName=regionNames.of(currentServer.toUpperCase()); } catch(e) {}
            selectedText.innerHTML=`${getFlagImg(currentServer)} ${cName}`;
        }
        if (killSwitchToggle.checked!==state.killSwitch) {
            killSwitchToggle.checked=state.killSwitch;
            localStorage.setItem('killSwitch', state.killSwitch?'true':'false');
            if (!isAppConnected) ipcRenderer.invoke('toggle-killswitch', state.killSwitch);
        }
        if (bypassInput.value!==state.bypassList) {
            bypassInput.value=state.bypassList;
            if (isAppConnected) ipcRenderer.invoke('update-live-bypass', bypassInput.value);
        }
    });

    ipcRenderer.on('force-connect-ui',    ()=>{ if (!isAppConnected) connectButton.click(); });
    ipcRenderer.on('force-disconnect-ui', ()=>{ if (isAppConnected)  connectButton.click(); });

    //  A country change asked for by the browser extension. main.js only
    //  sends this while a tunnel is up -- a disconnected app is re-labelled
    //  there and needs no circuit work -- and it is routed through a real
    //  click so the switch runs exactly as it does for the app's own
    //  dropdown, including the revert if the new country has no usable exit.
    ipcRenderer.on('force-switch-ui', (event, code) => {
        if (!code || code === currentServer) return;
        let li = dropdownList.querySelector(`li[data-value="${code}"]`);
        if (!li) {
            //  The popup can choose a country before the first relay fetch has
            //  rendered the list. Both switch paths key off a real <li>, so add
            //  the one the next refresh would have added anyway; that refresh
            //  fills in its label or removes it again.
            li = document.createElement('li');
            li.setAttribute('data-value', code);
            li.innerHTML = '<span style="display:flex;align-items:center;"></span>' +
                           '<span class="server-status"></span>';
            dropdownList.appendChild(li);
        }
        li.click();
    });
});
// ADDITIVE: country switch capture-phase interceptor (DNS stays locked)
//
// BUG FIX: previously called `updateUI(...)`, `stopTimer()` guarded by
// `typeof updateUI === 'function'`. Those functions are declared INSIDE
// the ORIGINAL `document.addEventListener('DOMContentLoaded', async () => {...})`
// block further up this file -- they are local to THAT closure and are
// NOT visible here (this is a second, separate DOMContentLoaded listener).
// So `typeof updateUI` was always 'undefined' and the button text/class
// never got reset after a successful switch -- it stayed stuck on
// "Switching to X..." forever, even though the connection had actually
// succeeded (confirmed by the globe overlay already showing "Secured &
// Routed via X"). Fix: do the DOM updates directly ourselves here,
// mirroring exactly what updateUI(true/false, ...) does.
document.addEventListener('DOMContentLoaded', () => {
    const _dl = document.getElementById('dropdownList');
    if (!_dl) return;
    _dl.addEventListener('click', async function(e) {
        if (!isAppConnected) return;
        const li = e.target.closest('li[data-value]');
        if (!li) return;
        const newCode = li.getAttribute('data-value');
        if (!newCode || newCode === currentServer) return;
        e.stopImmediatePropagation();
        _dl.classList.remove('show');
        const btn = document.getElementById('connectButton');
        const st  = document.getElementById('selectedText');
        const sp  = document.getElementById('statusPulse');
        const stx = document.getElementById('statusText');
        const bp  = document.getElementById('bypassInput');
        const dl2 = document.getElementById('dropdownList');

        function setFlag(code, name) {
            if (st) st.innerHTML = getFlagImg(code) + ' ' + name;
        }
        // Mirrors updateUI(connected, serverValue) -- done directly since
        // the real updateUI() is out of scope for this listener.
        function applyConnectedUI(serverValue) {
            currentServer = serverValue;
            let n = serverValue.toUpperCase();
            try { n = regionNames.of(serverValue.toUpperCase()); } catch(_) {}
            setFlag(serverValue, n);
            if (dl2) dl2.querySelectorAll('li[data-value]').forEach(x =>
                x.classList.toggle('active-server', x.getAttribute('data-value') === currentServer));
            btn.textContent = 'Disconnect';
            btn.classList.add('connected');
            if (sp)  sp.className = 'status-pulse connected';
            if (stx) stx.textContent = 'Protected 🛡️';
            isAppConnected = true;
            return n;
        }
        function applyDisconnectedUI() {
            btn.textContent = 'Tap to Connect';
            btn.classList.remove('connected');
            if (sp)  sp.className = 'status-pulse disconnected';
            if (stx) stx.textContent = 'Disconnected';
            isAppConnected = false;
        }

        let cName = newCode.toUpperCase();
        try { cName = regionNames.of(newCode.toUpperCase()); } catch(_) {}
        setFlag(newCode, cName);
        btn.textContent = `Switching to ${cName}…`; btn.disabled = true;
        btn.classList.remove('connected');
        if (sp) sp.className = 'status-pulse connecting';
        if (stx) stx.textContent = 'Rerouting… 🔄';
        window.flyToCountry?.(newCode);

        let resp;
        try {
            resp = await ipcRenderer.invoke('switch-vpn', {
                serverCode: newCode, bypassList: bp ? bp.value : '',
                oldServerCode: currentServer,
            });
        } catch(err) { resp = { status: 'unavailable', serverCode: newCode }; }
        btn.disabled = false;

        if (resp && resp.status === 'connected') {
            //  resp.serverCode is the VERIFIED exit country, which can
            //  differ from newCode when no relay in the requested country
            //  passed the geolocation check.
            const x = resolveExit(resp, newCode);
            const finalName = applyConnectedUI(x.code);
            localStorage.setItem('isConnected', 'true');
            localStorage.setItem('activeServer', currentServer);
            showProgress(100, `Switched & Secured via ${finalName} 🛡️`, 'connected');
            hideProgress(2500);
            announceExit(x, 'switched');
            if (x.moved) window.flyToCountry?.(x.code);
            window.landRocket?.(x.code);
        } else if (resp && resp.status === 'cancelled') {
            //  Cancelled from the country-unavailable dialog. `kept` is decided
            //  in main.js and it is the whole difference here: a switch that was
            //  cancelled BEFORE the running tunnel was touched leaves the old
            //  country carrying traffic, and this window must go back to saying
            //  so rather than showing a disconnected app that is in fact still
            //  routed. Nothing about a cancel is reported as a failure.
            if (resp.kept) {
                const prev     = resp.serverCode || currentServer;
                const prevName = applyConnectedUI(prev);
                localStorage.setItem('isConnected', 'true');
                localStorage.setItem('activeServer', prev);
                showProgress(100, `Cancelled — still connected via ${prevName} 🛡️`, 'cancelled');
                hideProgress(2600);
                showToast(`Switch <strong>cancelled</strong>. You are still connected via ` +
                          `<strong>${prevName}</strong> — nothing was changed.`, 'info', 6000);
                //  The rocket was on its way to a country nobody is going to
                //  now, so it blasts where it is. The launch never moved the
                //  anchor, so the ring returns to the country still in use.
                window.explodeRocket?.({ overlay: 'Switch cancelled 💥  Still connected' });
            } else {
                applyDisconnectedUI();
                localStorage.setItem('isConnected', 'false');
                hideProgress(3200);
                showToast('Switch <strong>cancelled</strong> — no country is connected. ' +
                          'This PC is back on its own internet connection.', 'info', 6000);
                window.explodeRocket?.({ overlay: 'Cancelled 💥  No country connected' });
            }
        } else if (resp && resp.status === 'reconnected') {            const prev = resp.serverCode || currentServer;
            const prevName = applyConnectedUI(prev);
            localStorage.setItem('isConnected', 'true');
            localStorage.setItem('activeServer', prev);
            showProgress(100, `Reverted to ${prevName} 🛡️`, 'connected');
            hideProgress(2500);
            showToast(`⚠️ Switch failed. Reverted to ${prevName}.`, 'warning', 5000);
            // The switch failed and the tunnel is back up through the country
            // it was already on, so the rocket heading for the country that
            // could not be reached blasts where it is, and the ring returns to
            // the globe's anchor -- which a launch never moves, and which is
            // therefore still that same old country.
            window.explodeRocket?.();
        } else {
            applyDisconnectedUI();
            localStorage.setItem('isConnected', 'false');
            hideProgress(300);
            showToast(`❌ Switch failed. Please reconnect.`, 'error', 5000);
            window.explodeRocket?.();
        }
    }, true);
});