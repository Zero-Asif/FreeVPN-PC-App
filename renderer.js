const { ipcRenderer } = require('electron');

const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });

let currentServer = "us"; 
let isAppConnected = false; 
let fastData = null;
let isLoading = true; 
let liveNodeCounts = {}; 

function getFlagImg(countryCode) {
    return `<img src="https://flagcdn.com/w20/${countryCode.toLowerCase()}.png" alt="${countryCode}" style="width: 20px; vertical-align: middle; margin-right: 8px; border-radius: 2px; box-shadow: 0 0 2px rgba(0,0,0,0.3);">`;
}

document.addEventListener('DOMContentLoaded', async () => {
    const connectButton = document.getElementById('connectButton');
    const statusPulse = document.getElementById('statusPulse');
    const statusText = document.getElementById('statusText');
    const killSwitchToggle = document.getElementById('killSwitchToggle');
    const selectedServer = document.getElementById('selectedServer');
    const dropdownList = document.getElementById('dropdownList');
    const selectedText = document.getElementById('selectedText');
    const bypassInput = document.getElementById('bypassInput');

    document.addEventListener('click', (e) => {
        if (!selectedServer.contains(e.target) && !dropdownList.contains(e.target)) {
            dropdownList.classList.remove('show');
        }
    });

    try { fastData = await ipcRenderer.invoke('get-fastest-server'); } catch(e) {}

    bypassInput.addEventListener('blur', async () => {
        let val = bypassInput.value.trim();
        if (val) {
            bypassInput.value = val.replace(/,/g, ';').split(';').map(s => s.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/[\*\s]/g, '')).filter(s => s !== '').join('; ');
        } else { bypassInput.value = ""; }
        if (isAppConnected) await ipcRenderer.invoke('update-live-bypass', bypassInput.value);
    });

    async function fetchAndRenderCountries() {
        if (dropdownList.children.length === 0) {
            dropdownList.innerHTML = `<li class="loading-msg" style="justify-content: center; padding: 15px; color: #666; font-size: 13px;">Searching active servers... ⏳</li>`;
        }

        let counts;
        try { 
            counts = await Promise.race([
                ipcRenderer.invoke('get-realtime-status'),
                new Promise(resolve => setTimeout(() => resolve(null), 12000))
            ]);
        } catch(e) {}
        
        if (!counts || Object.keys(counts).length === 0) return;

        isLoading = false; 
        liveNodeCounts = counts; 
        const loadingMsg = dropdownList.querySelector('.loading-msg');
        if (loadingMsg) loadingMsg.remove();

        if (isAppConnected && currentServer) {
            if (!counts[currentServer]) counts[currentServer] = 1; 
        }

        const sortedCountries = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);

        sortedCountries.forEach((code) => {
            const nodeCount = counts[code];
            if (nodeCount === 0) return;

            let countryName = code.toUpperCase();
            try { countryName = regionNames.of(code.toUpperCase()); } catch(e){}

            let pingMs = 0;
            let statusClass = "status-slow";

            if (nodeCount > 100) {
                pingMs = Math.floor(Math.random() * (150 - 110 + 1)) + 110; statusClass = "status-fast";
            } else if (nodeCount > 40) {
                pingMs = Math.floor(Math.random() * (190 - 151 + 1)) + 151; statusClass = "status-fast";
            } else if (nodeCount > 10) {
                pingMs = Math.floor(Math.random() * (280 - 191 + 1)) + 191; statusClass = "status-busy";
            } else {
                pingMs = Math.floor(Math.random() * (450 - 281 + 1)) + 281; statusClass = "status-slow";
            }

            let statusLabel = `${pingMs} ms`;
            let badgeHtml = (fastData && code === fastData.best) ? `<span class="fastest-badge">BEST</span>` : '';
            
            if (isAppConnected && currentServer === code) {
                statusClass = "status-fast"; statusLabel = "Connected";
            }

            let existingLi = dropdownList.querySelector(`li[data-value="${code}"]`);
            if (existingLi) {
                const statusSpan = existingLi.querySelector('.server-status');
                if (statusSpan.innerText !== statusLabel) {
                    statusSpan.className = `server-status ${statusClass}`;
                    statusSpan.innerText = statusLabel;
                }
                dropdownList.appendChild(existingLi);
            } else {
                const li = document.createElement('li');
                li.setAttribute('data-value', code);
                li.innerHTML = `
                    <span style="display: flex; align-items: center;">${getFlagImg(code)} ${countryName} ${badgeHtml}</span>
                    <span class="server-status ${statusClass}">${statusLabel}</span>
                `;
                dropdownList.appendChild(li);
            }
        });

        const allLis = dropdownList.querySelectorAll('li');
        allLis.forEach(li => {
            const code = li.getAttribute('data-value');
            if (code && !counts[code] && !(isAppConnected && currentServer === code)) {
                li.remove();
            }
        });
    }

    dropdownList.addEventListener('click', async (e) => {
        const li = e.target.closest('li');
        if(!li || !li.hasAttribute('data-value')) return;
        
        currentServer = li.getAttribute('data-value');
        let cName = currentServer.toUpperCase();
        try{ cName = regionNames.of(currentServer.toUpperCase()); }catch(e){}
        
        selectedText.innerHTML = `${getFlagImg(currentServer)} ${cName}`; 
        dropdownList.classList.remove('show');

        if (isAppConnected) {
            statusText.innerText = "Switching... 🔄";
            connectButton.innerText = "Switching Servers...";
            connectButton.disabled = true; 
            connectButton.classList.remove('connected');
            statusPulse.className = 'status-pulse'; 
            
            await ipcRenderer.invoke('disconnect-vpn', killSwitchToggle.checked);
            
            const bypassValue = document.getElementById('bypassInput').value;
            const response = await ipcRenderer.invoke('connect-vpn', { serverCode: currentServer, bypassList: bypassValue });
            
            connectButton.disabled = false; 

            if (response.status === "connected") {
                localStorage.setItem('isConnected', 'true');
                updateUI(true, currentServer);
                fetchAndRenderCountries(); 
            } else {
                localStorage.setItem('isConnected', 'false');
                updateUI(false, currentServer);
                fetchAndRenderCountries();
                alert(`⚠️ This server (${cName}) is slow, busy, or unavailable right now. Please try faster servers.`);
            }
        } else {
            localStorage.setItem('activeServer', currentServer);
            updateUI(false, currentServer);
        }
    });

    fetchAndRenderCountries();
    setInterval(fetchAndRenderCountries, 30000); 

    function updateUI(connected, serverValue = null) {
        isAppConnected = connected;
        if (serverValue) {
            currentServer = serverValue;
            let cName = serverValue.toUpperCase();
            try{ cName = regionNames.of(serverValue.toUpperCase()); }catch(e){}
            selectedText.innerHTML = `${getFlagImg(serverValue)} ${cName}`;
        }
        if (connected) {
            connectButton.innerText = "Disconnect";
            connectButton.classList.add('connected');
            statusPulse.className = 'status-pulse connected';
            statusText.innerText = "Protected";
        } else {
            connectButton.innerText = "Tap to Connect";
            connectButton.classList.remove('connected');
            statusPulse.className = 'status-pulse disconnected';
            statusText.innerText = "Disconnected";
        }
    }

    const savedServer = localStorage.getItem('activeServer') || "us";
    const savedState = localStorage.getItem('isConnected') === 'true';
    const savedKillSwitch = localStorage.getItem('killSwitch') === 'true';
    
    updateUI(savedState, savedServer);
    killSwitchToggle.checked = savedKillSwitch;

    selectedServer.addEventListener('click', () => { dropdownList.classList.toggle('show'); });

    connectButton.addEventListener('click', async () => {
        if (isLoading) { alert("🔄 Please wait! Fetching active server list..."); return; }

        const bypassValue = document.getElementById('bypassInput').value;
        let cName = currentServer.toUpperCase();
        try{ cName = regionNames.of(currentServer.toUpperCase()); }catch(e){}

        if (isAppConnected) {
            connectButton.innerText = "Disconnecting...";
            connectButton.disabled = true;
            const response = await ipcRenderer.invoke('disconnect-vpn', killSwitchToggle.checked);
            connectButton.disabled = false;
            
            if (response.status === "disconnected") {
                localStorage.setItem('isConnected', 'false');
                updateUI(false, currentServer);
                fetchAndRenderCountries(); 
            }
        } else {
            connectButton.innerText = "Connecting... ⏳";
            connectButton.disabled = true; 
            
            const response = await ipcRenderer.invoke('connect-vpn', { serverCode: currentServer, bypassList: bypassValue });

            connectButton.disabled = false; 

            if (response.status === "connected") {
                localStorage.setItem('isConnected', 'true');
                updateUI(true, currentServer);
                fetchAndRenderCountries(); 
            } else {
                localStorage.setItem('isConnected', 'false');
                updateUI(false, currentServer);
                fetchAndRenderCountries();
                alert(`⚠️ This server (${cName}) is slow, busy, or unavailable right now. Please try faster servers.`);
            }
        }
    });

    killSwitchToggle.addEventListener('change', async (e) => {
        const isEnabled = e.target.checked;
        localStorage.setItem('killSwitch', isEnabled ? 'true' : 'false');
        if (!isAppConnected) await ipcRenderer.invoke('toggle-killswitch', isEnabled);
    });
});