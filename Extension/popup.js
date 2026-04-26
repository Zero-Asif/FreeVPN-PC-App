document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('actionButton');
    const warningBox = document.getElementById('warningBox');
    const selectedServer = document.getElementById('selectedServer');
    const selectedText = document.getElementById('selectedText');
    const dropdownList = document.getElementById('dropdownList');
    const killSwitch = document.getElementById('killSwitchToggle');
    const bypassInput = document.getElementById('bypassInput');

    const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
    let isAppConnected = false;
    let currentServerCode = 'us';

    selectedServer.addEventListener('click', () => {
        if(!isAppConnected) dropdownList.classList.toggle('show');
    });

    document.addEventListener('click', (e) => {
        if (!selectedServer.contains(e.target) && !dropdownList.contains(e.target)) dropdownList.classList.remove('show');
    });

    function getFlagImg(code) { return `<img src="https://flagcdn.com/w20/${code.toLowerCase()}.png" class="flag-img">`; }

    function updateUI(state) {
        if (!state.appRunning) {
            btn.disabled = true; btn.style.background = "#ccc"; btn.innerText = "App Not Found";
            warningBox.style.display = "block"; return;
        } else { btn.disabled = false; warningBox.style.display = "none"; }

        isAppConnected = state.connected;
        if (state.connected) {
            btn.innerText = "Disconnect"; btn.classList.add('connected');
            selectedServer.style.background = "#f0f0f0"; selectedServer.style.cursor = "not-allowed";
        } else {
            btn.innerText = "Connect Browser Only"; btn.classList.remove('connected');
            selectedServer.style.background = "white"; selectedServer.style.cursor = "pointer";
        }

        if (document.activeElement !== killSwitch) killSwitch.checked = state.killSwitch || false;
        if (document.activeElement !== bypassInput) bypassInput.value = state.bypassList || '';

        currentServerCode = state.serverCode || 'us';
        let cName = currentServerCode.toUpperCase();
        try { cName = regionNames.of(currentServerCode.toUpperCase()); } catch(e){}
        selectedText.innerHTML = `${getFlagImg(currentServerCode)} ${cName}`;

        if (state.servers && Object.keys(state.servers).length > 0 && dropdownList.children.length === 0) {
            dropdownList.innerHTML = '';
            const sorted = Object.keys(state.servers).sort((a, b) => state.servers[b] - state.servers[a]);
            sorted.forEach(code => {
                let countryName = code.toUpperCase();
                try { countryName = regionNames.of(code.toUpperCase()); } catch(e){}
                let li = document.createElement('li');
                li.setAttribute('data-value', code);
                let speedText = state.servers[code] > 50 ? `<span style="color:#2ecc71; font-weight:bold;">Fast</span>` : `<span style="color:#e67e22;">Avg</span>`;
                li.innerHTML = `<span>${getFlagImg(code)} ${countryName}</span> ${speedText}`;
                dropdownList.appendChild(li);
            });
        }
    }

    dropdownList.addEventListener('click', (e) => {
        const li = e.target.closest('li');
        if(!li) return;
        const code = li.getAttribute('data-value');
        dropdownList.classList.remove('show');
        sendCommand({ command: "CHANGE_SERVER", server: code });
    });

    chrome.runtime.sendMessage({ type: "GET_STATUS" }, (res) => { if (res) updateUI(res.state); });
    chrome.runtime.onMessage.addListener((msg) => { if (msg.type === "UI_UPDATE") updateUI(msg.state); });

    function sendCommand(payload) { chrome.runtime.sendMessage({ type: "SEND_COMMAND", payload: payload }); }

    btn.addEventListener('click', () => { btn.innerText = "Wait..."; sendCommand({ command: isAppConnected ? "DISCONNECT" : "CONNECT" }); });
    killSwitch.addEventListener('change', (e) => sendCommand({ command: "TOGGLE_KS", enabled: e.target.checked }));
    bypassInput.addEventListener('change', (e) => sendCommand({ command: "UPDATE_BYPASS", list: e.target.value }));
});