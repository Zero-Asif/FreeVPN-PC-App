// ════════════════════════════════════════════════════════════════════
//  welcome.js -- the live half of welcome.html
//
//  Two jobs, and neither of them invents anything:
//
//    1. Show what the desktop app is ACTUALLY doing, by asking
//       background.js. The page ships saying "checking..." and only ever
//       replaces that with an answer that arrived over the WebSocket. A
//       welcome page that claimed "you are protected" while the app was shut
//       would be the exact kind of false statement this project does not
//       ship.
//
//    2. Take the NEW badge off the toolbar icon, because the announcement
//       has now been read. background.js puts it there on install; this is
//       the only thing that clears it.
// ════════════════════════════════════════════════════════════════════
const el = {
    dot:  document.getElementById('dot'),
    main: document.getElementById('st-main'),
    sub:  document.getElementById('st-sub'),
    ver:  document.getElementById('ver'),
    ok:   document.getElementById('ok'),
};

el.ver.textContent = 'v' + chrome.runtime.getManifest().version;

//  The badge is the unread marker, so reading the page clears it. Sent as a
//  message rather than calling chrome.action here: the worker owns the badge,
//  and it also owns the "already seen" flag in storage.
chrome.runtime.sendMessage({ type: 'WELCOME_SEEN' }, () => void chrome.runtime.lastError);

el.ok.addEventListener('click', () => {
    //  tabs.getCurrent() rather than a stored id: this page can be reopened
    //  from the extensions menu, and closing "the tab we opened at install"
    //  would then close the wrong one.
    chrome.tabs.getCurrent(tab => {
        if (tab && tab.id != null) chrome.tabs.remove(tab.id);
        else window.close();
    });
});

//  Country name from the code, the same way every other surface in this
//  project does it -- Intl, never a second hardcoded list that can drift.
function countryName(cc) {
    if (!cc) return '';
    try {
        return new Intl.DisplayNames(['en'], { type: 'region' })
            .of(String(cc).toUpperCase()) || String(cc).toUpperCase();
    } catch (e) { return String(cc).toUpperCase(); }
}

function paint(st) {
    const set = (cls, main, sub) => {
        el.dot.className = 'dot' + (cls ? ' ' + cls : '');
        el.main.textContent = main;
        el.sub.textContent  = sub;
    };

    if (!st || !st.appRunning) {
        //  Inert, and said plainly. This is the "only works while the app is
        //  running" rule as the user experiences it.
        set('off',
            'The desktop app is not running',
            'The extension is installed but inert -- this browser is on your ' +
            'normal connection. Start FreeProxy VPN and this will change by itself.');
        return;
    }
    if (st.busy) {
        const pct = st.progress && typeof st.progress.percent === 'number'
            ? ' (' + st.progress.percent + '%)' : '';
        set('mid',
            'Connecting' + pct,
            (st.progress && st.progress.message) || 'The app is building the tunnel.');
        return;
    }
    if (st.connected) {
        const name = countryName(st.server || st.serverCode);
        set('on',
            'Connected' + (name ? ' -- ' + name : ''),
            'This browser is going through the app\'s Tor engine, and websites ' +
            'that ask for your location are told ' + (name || 'the connected country') + '.');
        return;
    }
    set('', 'The app is running, but not connected',
        'Click the extension icon in the toolbar, pick a country and press Connect.');
}

//  WAKE both reads the state and cancels background.js's reconnect backoff,
//  which is what makes "start the app, look at this page" update within a
//  second instead of up to thirty. Same call the popup uses.
function poll() {
    chrome.runtime.sendMessage({ type: 'WAKE' }, res => {
        if (chrome.runtime.lastError) return;     // worker restarting
        paint(res && res.state);
    });
}

//  Pushed as well as pulled: a STATE_SYNC or PROGRESS tick reaches this page
//  the instant it reaches the popup.
chrome.runtime.onMessage.addListener(msg => {
    if (msg && msg.type === 'UI_UPDATE') paint(msg.state);
});

setInterval(poll, 1500);
poll();
