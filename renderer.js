const { ipcRenderer } = require('electron');
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

// ════════════════════════════════════════════════════════════
//  UTILITY
// ════════════════════════════════════════════════════════════
function getFlagImg(code) {
    return `<img src="https://flagcdn.com/w20/${code.toLowerCase()}.png" alt="${code}"
        style="width:20px;vertical-align:middle;margin-right:8px;border-radius:2px;box-shadow:0 0 2px rgba(0,0,0,0.25);">`;
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
    };
    if (fill) fill.style.background = gradients[status] || gradients.connecting;
    if (label) {
        const labels = { connecting:`${percent}%`, slow:`${percent}% — Slow`, unavailable:'Failed', connected:'100% ✓' };
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
function showToast(message, type = 'info', durationMs = 5000) {
    const container = document.getElementById('toast-container');
    if (!container) return;
    if (type === 'warning' && container.querySelector('.toast-warning')) return;
    const icons = { info:'ℹ️', warning:'⚠️', error:'❌', success:'✅' };
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.innerHTML = `
        <span class="toast-icon">${icons[type]||'ℹ️'}</span>
        <span class="toast-msg">${message}</span>
        <button class="toast-close" onclick="this.parentElement.remove()">×</button>`;
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
//  📡 CONNECTION PROGRESS  (IPC from main.js)
// ════════════════════════════════════════════════════════════
ipcRenderer.on('connection-progress', (event, { percent, message, status }) => {
    showProgress(percent, message, status);
    if (status === 'slow')
        showToast(`⚠️ <strong>Server is slow.</strong> Connection still in progress…`, 'warning', 9000);
    if (!rocketActionTaken) {
        if (status === 'connected') { rocketActionTaken=true; window.landRocket?.(); }
        else if (status === 'unavailable') {
            rocketActionTaken=true; window.explodeRocket?.();
            showToast(`❌ <strong>Server unavailable.</strong> Please choose a faster country.`, 'error', 7000);
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

    // Log modal
    document.getElementById('openLogBtn')?.addEventListener('click', openLogModal);
    document.getElementById('closeLogBtn')?.addEventListener('click', () => document.getElementById('log-modal')?.classList.remove('open'));
    document.getElementById('log-modal')?.addEventListener('click', e => { if (e.target===e.currentTarget) e.currentTarget.classList.remove('open'); });
    document.getElementById('logFilter')?.addEventListener('change', async e => {
        await refreshLogContent(e.target.value);
        document.getElementById('log-content').scrollTop = document.getElementById('log-content').scrollHeight;
    });
    document.getElementById('openLogFileBtn')?.addEventListener('click', () => ipcRenderer.invoke('open-log-folder'));

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
            if (isAppConnected && currentServer===code) { cls='status-fast'; label='Connected ✓'; }
            else if (count>200 || mbps>50)  { cls='status-fast'; label=`${Math.floor(70+Math.random()*50)} ms`; }
            else if (count>50  || mbps>10)  { cls='status-busy'; label=`${Math.floor(160+Math.random()*70)} ms`; }
            else                             { cls='status-slow'; label=`${Math.floor(290+Math.random()*100)} ms`; }
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
                localStorage.setItem('isConnected', 'true');
                updateUI(true, currentServer);
                showProgress(100, `Switched & Secured via ${cName} 🛡️`, 'connected');
                hideProgress(2500); fetchAndRenderCountries();
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
            localStorage.setItem('isConnected','true');
            updateUI(true, currentServer);
            if (!rocketActionTaken) { rocketActionTaken=true; window.landRocket?.(); }
            showProgress(100, `Connected via ${cName} 🛡️`, 'connected');
            hideProgress(2800);
            showToast(`✅ <strong>Connected!</strong> Routed via ${cName}. IP & GPS hidden.`, 'success', 6000);
            fetchAndRenderCountries();
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
            if (st) st.innerHTML = `<img src="https://flagcdn.com/w20/${code.toLowerCase()}.png" style="width:20px;vertical-align:middle;margin-right:8px;border-radius:2px;"> ${name}`;
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
            const finalName = applyConnectedUI(resp.serverCode || newCode);
            localStorage.setItem('isConnected', 'true');
            localStorage.setItem('activeServer', currentServer);
            showToast(`✅ Switched to ${finalName}`, 'success', 4000);
            window.landRocket?.();
        } else if (resp && resp.status === 'reconnected') {
            const prev = resp.serverCode || currentServer;
            const prevName = applyConnectedUI(prev);
            localStorage.setItem('isConnected', 'true');
            localStorage.setItem('activeServer', prev);
            showToast(`⚠️ Switch failed. Reverted to ${prevName}.`, 'warning', 5000);
        } else {
            applyDisconnectedUI();
            localStorage.setItem('isConnected', 'false');
            showToast(`❌ Switch failed. Please reconnect.`, 'error', 5000);
        }
    }, true);
});